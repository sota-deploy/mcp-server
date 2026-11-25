/**
 * GET /v1/account (quick task 261125-mcg): plan limits, usage and the
 * non-sensitive Enterprise facts of the signed-in account. Readable with an
 * API key and with the hosted connector's key. Called directly (not through
 * @sota-io/sdk) so this release does not depend on an unpublished SDK; 105-01
 * moves it into SotaClient.getAccount().
 */

export interface AccountPlan {
  name: string;
  max_projects: number;
  max_databases: number;
  max_custom_domains: number;
  max_builds_per_day: number;
  max_memory_mb: number;
  max_cpu_millicores: number;
  max_deploy_bytes: number;
}

export interface AccountUsage {
  projects: number;
  max_projects: number;
  databases: number;
  max_databases: number;
  domains: number;
  max_custom_domains: number;
}

export interface EnterpriseSummary {
  customer_label: string;
  landing_url: string;
  app_host_pattern: string;
  app_limit: number;
  /** null when the API could not read the app list. */
  apps_used: number | null;
  server_status: string;
  /** not_set_up | saved_untested | verified | unknown */
  sign_in_state: string;
  users_and_access_url: string;
  sign_in_setup_url: string;
}

export interface Account {
  user_id: string;
  plan: AccountPlan;
  usage: AccountUsage | null;
  enterprise: EnterpriseSummary | null;
}

/** Reads the account; null when the API has no /v1/account (older API). */
export type AccountReader = () => Promise<Account | null>;

export class AccountReadError extends Error {}

/** Upper bound for the account and project lookups that decorate a tool result. */
export const LOOKUP_TIMEOUT_MS = 3000;

export function accountReader(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = LOOKUP_TIMEOUT_MS,
): AccountReader {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/account`;
  return async () => {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404 || res.status === 405) return null;
    if (!res.ok) {
      let detail = '';
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        detail = body?.error?.message ?? '';
      } catch {
        // no JSON body
      }
      throw new AccountReadError(`GET /v1/account failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
    }
    const body = (await res.json()) as { data?: Account };
    return body.data ?? null;
  };
}

/**
 * Resolves to the promise's value, or to undefined after timeoutMs or when
 * it rejects. Never throws and never keeps the process alive.
 */
export async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise.catch(() => undefined), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Best-effort read for tool results: never throws and gives up after
 * timeoutMs (the deployment has already started; the result must not wait
 * for or fail on this lookup).
 */
export async function tryReadAccount(read?: AccountReader, timeoutMs: number = LOOKUP_TIMEOUT_MS): Promise<Account | null> {
  if (!read) return null;
  return (await settleWithin(read(), timeoutMs)) ?? null;
}
