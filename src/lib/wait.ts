/**
 * Bounded server-side waiting for a deployment, so an agent does not poll
 * get-status dozens of times (one test run needed 27 get-status calls
 * for one deploy).
 *
 * Why bounded: an MCP tool call that blocks for minutes runs into client
 * request timeouts. The MCP TypeScript SDK's client default is 60 s per
 * request (DEFAULT_REQUEST_TIMEOUT_MSEC), and many clients use it unchanged.
 * So one call waits at most MAX_WAIT_SECONDS (50 s, default 40 s) and then
 * returns "still building" with a retry hint; the next get-status call with
 * wait_for: "finished" waits again. Progress notifications are sent while
 * waiting when the client asked for them (a progressToken), so clients that
 * reset their timeout on progress keep the call open.
 *
 * Typical durations (measured): a Dockerfile app with a warm
 * layer cache is running ~15 s after the upload, a cold Dockerfile build
 * 35-50 s, a framework build (railpack) longer; the health gate itself
 * takes 6-11 s for a real app and gives up after 60 s.
 */

import type { SotaClient } from '@sota-io/sdk';

export const DEFAULT_WAIT_SECONDS = 40;
export const MAX_WAIT_SECONDS = 50;
/** Pause between two status reads while waiting. */
export const POLL_INTERVAL_MS = 3000;
/** What the agent should wait before the next call when a wait ends early. */
export const RETRY_AFTER_SECONDS = 5;

/** Deployment statuses after which nothing changes any more. */
export const FINISHED_STATUSES = new Set(['running', 'failed', 'stopped']);

export interface DeploymentLike {
  id: string;
  status: string;
  [k: string]: unknown;
}

/** Sends one MCP progress notification (no-op when the client did not ask). */
export type ProgressFn = (progress: number, message: string) => Promise<void>;

/**
 * Builds a ProgressFn from a tool handler's `extra` (MCP SDK
 * RequestHandlerExtra): only when the request carried a progressToken.
 */
export function progressFrom(extra: unknown): ProgressFn {
  const e = (extra ?? {}) as {
    _meta?: { progressToken?: string | number };
    sendNotification?: (n: { method: string; params: Record<string, unknown> }) => Promise<void>;
  };
  const token = e._meta?.progressToken;
  if (token === undefined || typeof e.sendNotification !== 'function') {
    return async () => {};
  }
  const send = e.sendNotification;
  return async (progress, message) => {
    try {
      await send({ method: 'notifications/progress', params: { progressToken: token, progress, message } });
    } catch {
      // A client that went away must not fail the tool.
    }
  };
}

/** The tool call's abort signal from a handler's `extra` (MCP SDK), if any. */
export function signalFrom(extra: unknown): AbortSignal | undefined {
  const s = (extra as { signal?: unknown } | undefined)?.signal;
  return s instanceof AbortSignal ? s : undefined;
}

export interface WaitOptions {
  /** Upper bound of this wait in milliseconds, from now. */
  maxWaitMs: number;
  intervalMs?: number;
  /** Bound of one status read (default READ_TIMEOUT_MS, never past the deadline). */
  readTimeoutMs?: number;
  progress?: ProgressFn;
  /** The tool call's abort signal: a client that went away ends the wait. */
  signal?: AbortSignal;
  /** Test hook. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Test hook. */
  now?: () => number;
}

export interface WaitResult {
  deployments: DeploymentLike[];
  /** The watched deployment (by id, else the newest); undefined if none. */
  deployment?: DeploymentLike;
  finished: boolean;
  waitedMs: number;
  /** The last status read did not answer in time (a previous one may have). */
  readTimedOut?: boolean;
  aborted?: boolean;
}

/** Bound of one status read while waiting. */
export const READ_TIMEOUT_MS = 5000;
/**
 * Headroom kept below the requested wait for the work after it (result
 * text, the account lookup that runs in parallel) and the transport, so a
 * call with max_wait_seconds 50 ends before 55 s even with a slow API.
 */
export const WAIT_HEADROOM_MS = 5000;

const realSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

const TIMED_OUT = Symbol('timed out');

/** p, or TIMED_OUT after ms (p keeps running; its rejection is swallowed). */
async function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms));
  });
  p.catch(() => {});
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads the project's deployments until the watched one is finished,
 * maxWaitMs has passed or the signal aborts. deploymentId undefined watches
 * the newest one. Every read is bounded (readTimeoutMs, and never past the
 * deadline); the first read gets at least readTimeoutMs even when maxWaitMs
 * is 0, so a plain status call still answers. A read that fails throws.
 */
export async function waitForDeployment(
  client: Pick<SotaClient, 'listDeployments'>,
  projectId: string,
  deploymentId: string | undefined,
  opts: WaitOptions,
): Promise<WaitResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const interval = opts.intervalMs ?? POLL_INTERVAL_MS;
  const readTimeout = opts.readTimeoutMs ?? READ_TIMEOUT_MS;
  const start = now();
  const deadline = start + Math.max(0, opts.maxWaitMs);
  let round = 0;
  let last: WaitResult | undefined;
  for (;;) {
    const bound = round === 0 ? Math.max(readTimeout, deadline - now()) : deadline - now();
    const got = await within(client.listDeployments(projectId) as Promise<unknown>, Math.min(readTimeout, bound));
    const waitedMs = now() - start;
    if (got === TIMED_OUT) {
      if (last) return { ...last, waitedMs, readTimedOut: true };
      return { deployments: [], deployment: undefined, finished: false, waitedMs, readTimedOut: true };
    }
    const deployments = ((got as unknown[]) ?? []) as DeploymentLike[];
    const deployment = deploymentId ? deployments.find((d) => d.id === deploymentId) : deployments[0];
    const finished = deployment !== undefined && FINISHED_STATUSES.has(deployment.status);
    last = { deployments, deployment, finished, waitedMs };
    if (opts.signal?.aborted) return { ...last, aborted: true };
    if (finished || deployment === undefined || now() + interval >= deadline) {
      return last;
    }
    round++;
    await opts.progress?.(round, `deployment ${deployment.id.slice(0, 8)}: ${deployment.status} (${Math.round(waitedMs / 1000)} s)`);
    await sleep(interval, opts.signal);
    if (opts.signal?.aborted) return { ...last, waitedMs: now() - start, aborted: true };
  }
}

/** Seconds argument → bounded milliseconds. */
export function boundedWaitMs(seconds: number | undefined): number {
  const s = seconds === undefined ? DEFAULT_WAIT_SECONDS : seconds;
  return Math.max(0, Math.min(MAX_WAIT_SECONDS, s)) * 1000;
}

/** The time left for waiting: the requested bound minus the headroom, minus what the call already used. */
export function waitBudgetMs(seconds: number | undefined, startedAt: number, now = Date.now()): number {
  return Math.max(0, boundedWaitMs(seconds) - WAIT_HEADROOM_MS - (now - startedAt));
}

/** The line an early return carries. */
export function stillRunningHint(status: string, waitedMs: number): string {
  return `Not finished after ${Math.round(waitedMs / 1000)} s (status: ${status}). Call get-status with wait_for: "finished" to wait again (retry_after_seconds: ${RETRY_AFTER_SECONDS}).`;
}
