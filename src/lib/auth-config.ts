/**
 * auth-config.ts — env-driven auth settings of the hosted MCP server (GDPR-3).
 *
 * Two values used to be hard-coded for prod (GDPR-3 ADR §11):
 *   - the OAuth proxy upstream (oauth-proxy.ts)
 *   - the accepted JWT issuers (auth/verify-jwt.ts)
 *
 * Env:
 *   AUTH_SERVER           upstream GoTrue base incl. /auth/v1. Already set by
 *                         compose (platform.yml: ${SUPABASE_URL}/auth/v1).
 *                         Unset/blank → https://auth.sota.io/auth/v1 (prod).
 *   SUPABASE_JWT_ISSUERS  comma-separated accepted iss values, exact match.
 *                         Same name and rules as the Go API (config.go
 *                         JWTIssuers). Unset/blank → today's two prod issuers.
 *
 * The upstream is always accepted as an issuer as well: GoTrue writes its own
 * public URL into iss, so a dev or self-hosted setup only has to set
 * AUTH_SERVER. Signature checking (SUPABASE_JWT_SECRET) stays the real gate.
 *
 * Invalid values throw, so the server fails at startup instead of answering
 * 401 to every request later.
 */

export const DEFAULT_AUTH_UPSTREAM = 'https://auth.sota.io/auth/v1';

export const DEFAULT_ACCEPTED_ISSUERS: readonly string[] = [
  'https://wnwsdtqhywfxxlnyqafk.supabase.co/auth/v1',
  'https://auth.sota.io/auth/v1',
];

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * Resolve the OAuth proxy upstream from AUTH_SERVER. Trailing slashes are
 * trimmed; https is required (http only for localhost / 127.0.0.1).
 */
export function resolveAuthUpstream(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.AUTH_SERVER ?? '').trim();
  if (raw === '') return DEFAULT_AUTH_UPSTREAM;

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`AUTH_SERVER: ${JSON.stringify(raw)} is not an absolute URL`);
  }
  if (u.username || u.password || u.search || u.hash) {
    throw new Error(
      `AUTH_SERVER: ${JSON.stringify(raw)} must not carry credentials, a query or a fragment`,
    );
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocalHost(u.hostname))) {
    throw new Error(
      `AUTH_SERVER: ${JSON.stringify(raw)} must use https (http only for localhost/127.0.0.1)`,
    );
  }
  // origin lower-cases the host; pathname keeps /auth/v1.
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}

/**
 * Parse SUPABASE_JWT_ISSUERS with the same rules as the Go API: absolute URL,
 * no query/fragment/credentials, lower-case host, no trailing slash, https
 * (http only for localhost). Blank → DEFAULT_ACCEPTED_ISSUERS. The upstream
 * is appended when it is not in the list yet.
 */
export function resolveAcceptedIssuers(
  env: NodeJS.ProcessEnv = process.env,
  upstream: string = resolveAuthUpstream(env),
): string[] {
  const parsed: string[] = [];
  for (const part of (env.SUPABASE_JWT_ISSUERS ?? '').split(',')) {
    const iss = part.trim();
    if (iss === '') continue;
    let u: URL;
    try {
      u = new URL(iss);
    } catch {
      throw new Error(`SUPABASE_JWT_ISSUERS: ${JSON.stringify(iss)} is not an absolute URL`);
    }
    if (u.username || u.password || u.search || u.hash || iss.includes('?') || iss.includes('#')) {
      throw new Error(`SUPABASE_JWT_ISSUERS: ${JSON.stringify(iss)} is not an absolute URL`);
    }
    // URL lower-cases the host itself, so compare against the raw authority.
    const rawAuthority = iss.slice(iss.indexOf('//') + 2).split('/')[0];
    if (rawAuthority !== rawAuthority.toLowerCase()) {
      throw new Error(`SUPABASE_JWT_ISSUERS: ${JSON.stringify(iss)} must have a lower-case host`);
    }
    if (iss.endsWith('/')) {
      throw new Error(`SUPABASE_JWT_ISSUERS: ${JSON.stringify(iss)} must not end with a slash`);
    }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocalHost(u.hostname))) {
      throw new Error(`SUPABASE_JWT_ISSUERS: ${JSON.stringify(iss)} must use https`);
    }
    parsed.push(iss);
  }

  const list = parsed.length > 0 ? parsed : [...DEFAULT_ACCEPTED_ISSUERS];
  if (!list.includes(upstream)) list.push(upstream);
  return list;
}
