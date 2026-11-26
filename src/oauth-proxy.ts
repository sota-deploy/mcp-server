/**
 * oauth-proxy.ts — transparent reverse proxy
 * in front of Supabase OAuth Server that strips `openid` from the scope
 * parameter on /authorize requests, working around the Supabase OIDC bug
 * (HTTP 500 "Error generating ID token" — error_id 019e41f7-…).
 *
 * Why this exists: removing `openid` from our /.well-known/oauth-protected-
 * resource metadata's `scopes_supported` only works if the client
 * (Claude.ai) actually respects the advertised list. RFC 9728 says it
 * SHOULD, but if the client hardcodes openid it'll still trigger the bug.
 * This proxy is a hard safety net — no matter what scope the client sends,
 * Supabase never sees `openid` in the request.
 *
 * What the proxy does:
 *   GET  /auth/v1/.well-known/oauth-authorization-server  → rewritten metadata
 *   POST /auth/v1/oauth/clients/register                  → transparent forward
 *   GET  /auth/v1/oauth/authorize?scope=…                 → strip openid → forward
 *   POST /auth/v1/oauth/token                             → transparent forward
 *   GET  /auth/v1/oauth/userinfo                          → transparent forward
 *   GET  /auth/v1/.well-known/jwks.json                   → transparent forward
 *   any other GET/POST under /auth/v1/                    → transparent forward
 *
 * Redirects are followed by curl/SDK clients themselves; our proxy passes
 * the Location header through unchanged (Supabase emits redirects to
 * sota.io/oauth/authorize which is our consent UI and stays valid).
 *
 * Activation: registered on the same Express app as /mcp via mountOAuthProxy().
 */

import type { Request, Response, Express } from 'express';
import { resolveAuthUpstream } from './lib/auth-config.js';

// AUTH_SERVER (compose: ${SUPABASE_URL}/auth/v1); default = prod
// https://auth.sota.io/auth/v1. Invalid values throw here = fail at startup.
const UPSTREAM = resolveAuthUpstream();

/**
 * Strip `openid` from a space-separated scope string. Returns the cleaned
 * value, or undefined when nothing remains (caller should omit the param).
 */
function stripOpenidScope(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  const cleaned = raw
    .split(/\s+/)
    .filter((s) => s.length > 0 && s.toLowerCase() !== 'openid')
    .join(' ');
  return cleaned.length === 0 ? undefined : cleaned;
}

/**
 * Build a rewritten OIDC discovery document that points all endpoints at
 * mcp.sota.io's proxy rather than auth.sota.io directly. This is the entry
 * point that makes the proxy actually do anything — Claude.ai reads this
 * once and uses these URLs for the rest of the flow.
 */
function rewriteMetadata(
  upstreamMetadata: Record<string, unknown>,
  publicOrigin: string,
): Record<string, unknown> {
  const base = `${publicOrigin}/auth/v1`;
  return {
    ...upstreamMetadata,
    // Known, deliberate deviation from RFC 8414 §3.3: this document is served
    // for the authorization server `${publicOrigin}/auth/v1`, but `issuer`
    // stays the upstream's (https://auth.sota.io/auth/v1). The `iss` of every
    // token, and any RFC 9207 `iss` on the authorization response, carry the
    // upstream value; rewriting it here would make those checks fail. Clients
    // in use (Claude, the MCP SDK) do not compare it with the discovery URL.
    issuer: upstreamMetadata.issuer,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    userinfo_endpoint: `${base}/oauth/userinfo`,
    jwks_uri: `${base}/.well-known/jwks.json`,
    registration_endpoint: `${base}/oauth/clients/register`,
    // Crucially: drop openid from advertised scopes so well-behaved clients
    // skip it. The /authorize strip-pass is the belt-and-braces backup.
    scopes_supported: Array.isArray(upstreamMetadata.scopes_supported)
      ? (upstreamMetadata.scopes_supported as unknown[]).filter(
          (s) => typeof s === 'string' && s.toLowerCase() !== 'openid',
        )
      : ['profile', 'email'],
  };
}

/**
 * Forward an HTTP request to Supabase OAuth Server transparently. Preserves
 * method, headers (except Host), query string, and body. Returns the
 * upstream response untouched.
 *
 * Express has already body-parsed POST JSON for us when content-type was
 * application/json (set up at top of http.ts). For x-www-form-urlencoded
 * we need to re-serialise from req.body. Other content types pass through
 * as best we can — DCR and token endpoints use JSON / form-encoded only.
 */
async function forward(req: Request, targetPath: string, targetQuery?: string): Promise<Response | null> {
  const url = `${UPSTREAM}${targetPath}${targetQuery ?? ''}`;
  const isForm =
    typeof req.headers['content-type'] === 'string' &&
    req.headers['content-type'].includes('application/x-www-form-urlencoded');

  // Reconstruct body — express.json() leaves it as a parsed object, so we
  // re-serialise based on the original content-type.
  let body: string | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (isForm) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(req.body ?? {})) {
        if (typeof v === 'string') params.append(k, v);
        else if (Array.isArray(v)) v.forEach((x) => params.append(k, String(x)));
      }
      body = params.toString();
    } else if (req.body && typeof req.body === 'object') {
      body = JSON.stringify(req.body);
    } else if (typeof req.body === 'string') {
      body = req.body;
    }
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v !== 'string') continue;
    // Strip hop-by-hop and host headers; the host gets recomputed by fetch.
    if (
      ['host', 'connection', 'content-length', 'accept-encoding'].includes(
        k.toLowerCase(),
      )
    ) {
      continue;
    }
    headers[k] = v;
  }

  const upstreamRes = await fetch(url, {
    method: req.method,
    headers,
    body,
    redirect: 'manual',
  });
  return upstreamRes as unknown as Response;
}

async function streamUpstreamResponse(
  upstream: unknown,
  res: Response,
): Promise<void> {
  const r = upstream as unknown as {
    status: number;
    headers: Headers;
    arrayBuffer: () => Promise<ArrayBuffer>;
  };
  // Mirror headers EXCEPT hop-by-hop ones.
  r.headers.forEach((value: string, key: string) => {
    if (
      ['content-encoding', 'transfer-encoding', 'connection'].includes(
        key.toLowerCase(),
      )
    ) {
      return;
    }
    res.setHeader(key, value);
  });
  res.status(r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  res.end(buf);
}

/**
 * Every URL a client may derive from the issuer `${origin}/auth/v1` to find
 * the authorization server metadata: RFC 8414 path insertion (what the MCP
 * spec and the MCP SDK try first), OIDC path insertion, OIDC appended, and
 * the appended OAuth form served since 1.4. All of them answer the same
 * rewritten document; before 1.9.0 only the last one did, so an SDK-based
 * client fell through to the OIDC appended URL and got the upstream document
 * with the upstream endpoints (no openid strip).
 */
export const AUTH_METADATA_PATHS = [
  '/.well-known/oauth-authorization-server/auth/v1',
  '/.well-known/openid-configuration/auth/v1',
  '/auth/v1/.well-known/openid-configuration',
  '/auth/v1/.well-known/oauth-authorization-server',
];

/**
 * GoTrue's token endpoint answers a failed grant with its own error shape
 * (`{"code":400,"error_code":"refresh_token_not_found","msg":…}`, checked
 * against GoTrue v2.198 on dev 2026-11-26) instead of RFC 6749 §5.2
 * (`{"error":"invalid_grant",…}`). Claude treats only `invalid_grant` on a
 * refresh as "sign in again". Adds `error` / `error_description` to such a
 * body and keeps GoTrue's own fields; a body that already has `error` is
 * returned unchanged.
 */
export function oauthTokenErrorBody(body: unknown, status: number): Record<string, unknown> | null {
  if (status < 400 || status >= 500) return null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.error === 'string') return null;
  const code = String(b.error_code ?? '').toLowerCase();
  const error = code.includes('client')
    ? 'invalid_client'
    : code.includes('scope')
      ? 'invalid_scope'
      : status === 400 && /(grant|refresh|code|token|expired|not_found|verifier|redirect)/.test(code)
        ? 'invalid_grant'
        : 'invalid_request';
  return { error, error_description: String(b.msg ?? b.message ?? code ?? 'request failed'), ...b };
}

export function mountOAuthProxy(app: Express, publicOrigin: string): void {
  // 1) Rewritten metadata document.
  app.get(AUTH_METADATA_PATHS, async (_req, res) => {
    try {
      const upstream = await fetch(
        `${UPSTREAM}/.well-known/oauth-authorization-server`,
      );
      const json = (await upstream.json()) as Record<string, unknown>;
      const rewritten = rewriteMetadata(json, publicOrigin);
      res.json(rewritten);
    } catch (err) {
      res.status(502).json({
        error: 'metadata_fetch_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // 2) /authorize — strip openid from the scope before forwarding.
  app.get('/auth/v1/oauth/authorize', async (req, res) => {
    try {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(req.query)) {
        if (typeof v === 'string') params.set(k, v);
        else if (Array.isArray(v) && typeof v[0] === 'string')
          params.set(k, v[0] as string);
      }
      const cleanedScope = stripOpenidScope(params.get('scope') ?? undefined);
      if (cleanedScope === undefined) {
        params.delete('scope');
      } else {
        params.set('scope', cleanedScope);
      }
      const upstream = await forward(req, '/oauth/authorize', '?' + params.toString());
      if (!upstream) {
        res.status(502).end();
        return;
      }
      await streamUpstreamResponse(upstream, res);
    } catch (err) {
      res.status(502).json({
        error: 'proxy_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // 3) /oauth/token — forward; failed grants get RFC 6749 error fields.
  app.post('/auth/v1/oauth/token', async (req, res) => {
    try {
      const search = new URL(`http://x${req.originalUrl}`).search;
      const upstream = (await forward(req, '/oauth/token', search || undefined)) as unknown as {
        status: number;
        headers: Headers;
        text: () => Promise<string>;
      } | null;
      if (!upstream) {
        res.status(502).end();
        return;
      }
      const text = await upstream.text();
      let mapped: Record<string, unknown> | null = null;
      try {
        mapped = oauthTokenErrorBody(JSON.parse(text), upstream.status);
      } catch {
        mapped = null;
      }
      upstream.headers.forEach((value: string, key: string) => {
        if (['content-encoding', 'transfer-encoding', 'connection', 'content-length'].includes(key.toLowerCase())) return;
        res.setHeader(key, value);
      });
      res.status(upstream.status);
      if (mapped) res.json(mapped);
      else res.end(text);
    } catch (err) {
      res.status(502).json({
        error: 'proxy_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // 4) All other /auth/v1/* paths — transparent forward.
  app.all('/auth/v1/*', async (req, res) => {
    try {
      // Some clients (and SDKs) send scope to other endpoints too; strip it
      // defensively wherever it appears in a query string.
      const url = new URL(`http://x${req.originalUrl}`);
      if (url.searchParams.has('scope')) {
        const cleaned = stripOpenidScope(url.searchParams.get('scope') ?? undefined);
        if (cleaned === undefined) url.searchParams.delete('scope');
        else url.searchParams.set('scope', cleaned);
      }
      const path = url.pathname.replace(/^\/auth\/v1/, '');
      const query = url.search;
      const upstream = await forward(req, path, query || undefined);
      if (!upstream) {
        res.status(502).end();
        return;
      }
      await streamUpstreamResponse(upstream, res);
    } catch (err) {
      res.status(502).json({
        error: 'proxy_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
