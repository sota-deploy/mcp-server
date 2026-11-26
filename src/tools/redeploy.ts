import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SotaClient } from '@sota-io/sdk';
import {
  type DeploymentLike,
  DEFAULT_WAIT_SECONDS,
  MAX_WAIT_SECONDS,
  RETRY_AFTER_SECONDS,
  progressFrom,
  signalFrom,
  waitBudgetMs,
} from '../lib/wait.js';
import { deploymentLines } from './status.js';

export interface RedeployToolOptions {
  /** Test hook: interval of the progress notifications while waiting. */
  progressIntervalMs?: number;
}

const DESCRIPTION = `Redeploy a project: start the image of the running deployment again with the project's current environment variables, without a new build. Use it after set-env or delete of a variable (env changes only reach the app on the next deploy or redeploy). The previous container keeps serving until the new one passes the health gate (GET /health, or GET / when /health is 404, 2xx/3xx within 60 s); on a sota Enterprise account the app stays behind the sign-in and on its own server. Needs a running deployment; for new code use deploy.

The sota API answers a redeploy only when it has finished (running or failed), typically after 10-30 s. With wait (default true) this tool waits for that answer up to max_wait_seconds (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}); if it takes longer the redeploy continues and you call get-status with wait_for: "finished". wait: false returns at once.`;

export function registerRedeployTool(server: McpServer, client: SotaClient, options: RedeployToolOptions = {}) {
  server.registerTool('redeploy', {
    title: 'Restart with new settings',
    description: DESCRIPTION,
    inputSchema: {
      project_id: z.string().describe('Project ID (UUID) to redeploy. Use list-projects to find the ID'),
      wait: z.boolean().optional().describe('Wait for the result (default true, bounded by max_wait_seconds).'),
      max_wait_seconds: z
        .number()
        .int()
        .min(0)
        .max(MAX_WAIT_SECONDS)
        .optional()
        .describe(`Upper bound of the wait (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}).`),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ project_id, wait, max_wait_seconds }, extra) => {
    const startedAt = Date.now();
    // The request must not be aborted when this tool stops waiting: the API
    // runs the redeploy on that request and ends it when the caller hangs up.
    // (A local stdio server that exits mid-redeploy does hang up: the API
    // then cancels the redeploy and removes the new container; the previous
    // deployment keeps running.)
    const request = client.redeploy(project_id) as Promise<unknown>;
    const settled = request.then(
      (d) => ({ ok: true as const, deployment: d as DeploymentLike }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    // wait: false still gives the API a moment, so an immediate refusal
    // (no running deployment, another deploy in progress) is reported.
    const maxWaitMs = wait === false ? 1500 : waitBudgetMs(max_wait_seconds, startedAt);
    const progress = progressFrom(extra);
    const signal = signalFrom(extra);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const timeout = new Promise<'timeout' | 'aborted'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), maxWaitMs);
      // A client that went away: stop waiting (the redeploy itself goes on).
      onAbort = () => resolve('aborted');
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
    let round = 0;
    const ticker = setInterval(() => {
      round++;
      void progress(round, `redeploy running (${Math.round((Date.now() - startedAt) / 1000)} s)`);
    }, options.progressIntervalMs ?? 5000);
    try {
      const outcome = await Promise.race([settled, timeout]);
      if (outcome === 'aborted') {
        return { content: [{ type: 'text' as const, text: 'Cancelled by the client; the redeploy continues on the server.' }], isError: true };
      }
      if (outcome === 'timeout') {
        const text =
          wait === false
            ? `Redeploy started. Call get-status with wait_for: "finished" to see the result (retry_after_seconds: ${RETRY_AFTER_SECONDS}).`
            : `Redeploy still running after ${Math.round(maxWaitMs / 1000)} s; it continues on the server. Call get-status with wait_for: "finished" (retry_after_seconds: ${RETRY_AFTER_SECONDS}).`;
        return { content: [{ type: 'text' as const, text }] };
      }
      if (!outcome.ok) {
        const msg = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        return { content: [{ type: 'text' as const, text: `Redeploy failed: ${msg}` }], isError: true };
      }
      const d = outcome.deployment;
      const lines = deploymentLines(d, 'Redeploy finished:');
      if (d.status === 'failed') {
        lines.push('', 'The previous deployment keeps running. Fix the cause (get-logs, the reason above) and deploy or redeploy again.');
      }
      return { content: [{ type: 'text' as const, text: lines.join('\n') }], isError: d.status === 'failed' };
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      clearInterval(ticker);
    }
  });
}
