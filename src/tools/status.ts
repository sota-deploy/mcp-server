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
  stillRunningHint,
  waitBudgetMs,
  waitForDeployment,
} from '../lib/wait.js';

export interface StatusToolOptions {
  /** Test hook: pause between two status reads while waiting. */
  pollIntervalMs?: number;
  /** Test hook: bound of one status read. */
  readTimeoutMs?: number;
}

const HEALTH_HINT =
  '  Hint: the app did not answer GET /health (or GET / when /health is 404) with 2xx/3xx within 60 s. It must listen on 0.0.0.0:$PORT and answer these paths WITHOUT identity headers (sota Enterprise: do not return 401 there). The reason above names the status code the app returned, or that nothing answered. The previous version, if any, keeps running.';

/** The failure reason of a deployment (the API sends error_message; older SDK types call it error). */
export function failureOf(d: DeploymentLike | undefined): string | undefined {
  if (!d) return undefined;
  const r = (d.error_message as string | undefined) ?? (d.error as string | undefined);
  return r || undefined;
}

/** Lines describing one deployment, with the failure reason and hint. */
export function deploymentLines(d: DeploymentLike, heading = 'Current deployment:'): string[] {
  const lines = [
    heading,
    `  ID: ${d.id}`,
    `  Status: ${d.status}`,
    `  URL: ${(d.url as string | undefined) || 'not available'}`,
    `  Created: ${d.created_at as string}`,
  ];
  if (d.framework) lines.push(`  Framework: ${d.framework as string}`);
  const failure = failureOf(d);
  if (failure) lines.push(`  Error: ${failure}`);
  if (d.status === 'failed' && failure && /health check/i.test(failure)) lines.push(HEALTH_HINT);
  return lines;
}

export function registerStatusTool(server: McpServer, client: SotaClient, options: StatusToolOptions = {}) {
  server.registerTool('get-status', {
    title: 'Show deployment status',
    description: `Get the current deployment status for a project, including the live host (the project URL from list-projects: https://{slug}.sota.io, or https://{app}.{label}.sota.io on a sota Enterprise account), detected framework, the reason of a failed deployment (including the HTTP status the app answered on its health path, or that nothing answered) and recent deployment history. Deployment statuses: pending (queued), building (build in progress), built (image ready), deploying (starting container + health checks), running (live and healthy), failed (build or health check error), stopped (replaced by newer deployment).

After deploy or redeploy, call this ONCE with wait_for: "finished": it waits on the server until the deployment is running or failed (up to max_wait_seconds, default ${DEFAULT_WAIT_SECONDS}, at most ${MAX_WAIT_SECONDS}) and returns early with retry_after_seconds when it is still building; then call it again the same way. Do not poll in a tight loop.`,
    inputSchema: {
      project_id: z.string().describe('Project ID (UUID) to check status for. Use list-projects to find the ID'),
      wait_for: z
        .enum(['finished'])
        .optional()
        .describe('"finished": wait on the server until the deployment is running, failed or stopped (bounded by max_wait_seconds). Omit to return the status at once.'),
      deployment_id: z
        .string()
        .optional()
        .describe('Deployment to watch (from deploy/redeploy). Defaults to the newest deployment.'),
      max_wait_seconds: z
        .number()
        .int()
        .min(0)
        .max(MAX_WAIT_SECONDS)
        .optional()
        .describe(`Upper bound of the wait with wait_for (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}).`),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ project_id, wait_for, deployment_id, max_wait_seconds }, extra) => {
    const startedAt = Date.now();
    try {
      const waited = await waitForDeployment(client, project_id, deployment_id, {
        maxWaitMs: wait_for === 'finished' ? waitBudgetMs(max_wait_seconds, startedAt) : 0,
        intervalMs: options.pollIntervalMs,
        readTimeoutMs: options.readTimeoutMs,
        progress: progressFrom(extra),
        signal: signalFrom(extra),
      });
      const { deployments, deployment } = waited;

      if (waited.readTimedOut && deployments.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `The sota API did not answer the status read in time. Call get-status again (retry_after_seconds: ${RETRY_AFTER_SECONDS}).` }],
          isError: true,
        };
      }
      if (deployments.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No deployments found. Use the deploy tool to deploy your app.' }] };
      }
      if (!deployment) {
        return {
          content: [{ type: 'text' as const, text: `Deployment ${deployment_id} not found in this project's recent deployments.` }],
          isError: true,
        };
      }

      const lines = deploymentLines(deployment, deployment_id ? 'Deployment:' : 'Current deployment:');
      if (wait_for === 'finished') {
        if (waited.finished) {
          lines.push(`  Finished (waited ${Math.round(waited.waitedMs / 1000)} s).`);
        } else {
          lines.push('', stillRunningHint(deployment.status, waited.waitedMs), `retry_after_seconds: ${RETRY_AFTER_SECONDS}`);
        }
      }

      const others = deployments.filter((d) => d.id !== deployment.id);
      if (others.length > 0) {
        lines.push('', 'Recent deployments:');
        for (const d of others.slice(0, 4)) {
          lines.push(`  ${d.id.slice(0, 8)} - ${d.status} (${d.created_at as string})`);
        }
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Failed to get status: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  });
}
