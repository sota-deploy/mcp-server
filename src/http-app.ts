/**
 * sota.io MCP Server — HTTP Transport (remote)
 *
 * Streamable HTTP variant of the existing stdio MCP server, exposed via
 * mcp.sota.io/mcp for one-click installation from Claude Desktop and
 * Claude.ai. The entry point is http.ts; this module builds the Express app
 * so tests can run it on an ephemeral port.
 *
 * Hosted differences from stdio: `deploy` accepts inline `files`
 * only (no `directory`, no `git_url`), enforced by the tool schema, by
 * hostedDeployRejection() before any tool runs and by the tool itself. Logs
 * carry user ids, never emails.
 *
 * Auth: a sota_xxx API key as `Authorization: Bearer <key>` is forwarded to
 * sota-api; an OAuth 2.1 access token (JWT) is verified and mapped to a
 * per-user key tagged `source=claude` (auth/token-bridge.ts). RFC 9728
 * protected-resource metadata is served for OAuth discovery. /mcp refuses
 * every anonymous request with 401 (sign-in at connect time); /mcp/signup
 * keeps anonymous discovery + create_account (see below).
 */

import crypto from 'node:crypto';
import express from 'express';
import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SotaClient } from '@sota-io/sdk';
import { registerProjectTools } from './tools/projects.js';
import { registerDeployTool } from './tools/deploy.js';
import { registerLogsTool } from './tools/logs.js';
import { registerEnvTools } from './tools/env.js';
import { registerRollbackTool } from './tools/rollback.js';
import { registerRedeployTool } from './tools/redeploy.js';
import { registerStatusTool } from './tools/status.js';
import { registerDomainTools } from './tools/domains.js';
import { verifyJwt, JwtVerificationError } from './auth/verify-jwt.js';
import { getOrProvisionApiKey } from './auth/token-bridge.js';
import { registerCreateAccountTool } from './tools/create-account.js';
import { mountOAuthProxy } from './oauth-proxy.js';
import { hostedDeployRejection } from './lib/hosted-guard.js';
import { errorMessage, logEvent } from './lib/log.js';
import { BUILD_TIME, GIT_SHA, PACKAGE_VERSION } from './lib/version.js';
import { registerAccountTool, registerChecklistPrompt } from './tools/account.js';
import { registerSourceTools } from './tools/source.js';
import { sourceApi } from './lib/source-api.js';
import { accountReader } from './lib/account.js';
import { SERVER_INSTRUCTIONS } from './lib/guide.js';
import { BUSY_RETRY_SECONDS, LARGE_BODIES } from './lib/upload-gate.js';

// Two endpoints (from 1.9.0):
//
//   /mcp         The connector URL for everyone with an account. Every
//                request without a credential, `initialize` included, gets
//                401 + WWW-Authenticate (resource_metadata, scope), so a
//                client that runs OAuth only when the connection itself is
//                refused (a connector added with "sign in when needed", seen
//                in Claude Desktop on Windows) always shows the sign-in.
//   /mcp/signup  "Lazy authentication" for sign-up from inside a chat:
//                discovery (initialize, tools/list, prompts) and
//                `create_account` work without a credential; every other
//                tool call gets 401, as /mcp did up to 1.8.0.
//
// MCP_ANONYMOUS_DISCOVERY=true restores the old mixed behaviour on /mcp
// (rollback switch, no rebuild needed).

// Tools that may be invoked WITHOUT authentication on /mcp/signup.
const UNAUTHENTICATED_TOOLS = new Set(['create_account']);
// Methods reachable without a credential on /mcp/signup. prompts/list and
// prompts/get serve only the static Enterprise checklist (no API call, no
// account data).
const UNAUTHENTICATED_METHODS = new Set([
  'initialize',
  'notifications/initialized',
  'tools/list',
  'prompts/list',
  'prompts/get',
]);

export type EndpointMode = 'auth_required' | 'signup' | 'discover';

// /mcp/discover (anonymous, read-only listing for registries and directories):
// these methods only, no credential accepted, small body, rate-limited per IP.
const DISCOVERY_METHODS = new Set(['initialize', 'notifications/initialized', 'ping', 'tools/list', 'prompts/list']);

/** Fixed-window request limiter: per key, plus a global cap (best effort; in memory, per process). */
export class WindowLimiter {
  private counts = new Map<string, number>();
  private total = 0;
  private windowStart = Date.now();
  constructor(
    private readonly perKey: number,
    private readonly global: number,
    private readonly windowMs = 60_000,
  ) {}
  take(key: string): boolean {
    const now = Date.now();
    if (now - this.windowStart >= this.windowMs) {
      this.counts.clear();
      this.total = 0;
      this.windowStart = now;
    }
    const n = this.counts.get(key) ?? 0;
    if (n >= this.perKey || this.total >= this.global) return false;
    this.counts.set(key, n + 1);
    this.total += 1;
    return true;
  }
  retryAfterSeconds(): number {
    return Math.max(1, Math.ceil((this.windowStart + this.windowMs - Date.now()) / 1000));
  }
}
const DISCOVERY_LIMITER = new WindowLimiter(
  Number(process.env.MCP_DISCOVERY_RATE_PER_IP ?? 60),
  Number(process.env.MCP_DISCOVERY_RATE_GLOBAL ?? 1200),
);

/**
 * Client address for the rate limit: the left-most X-Forwarded-For entry
 * (the edge and worker Traefik append theirs), else the socket. A client can
 * set that header itself, so the per-IP limit is best effort; the global cap
 * bounds the total either way.
 */
function clientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : xff ?? '').split(',')[0].trim();
  return first || req.socket.remoteAddress || 'unknown';
}

/** Whether /mcp keeps the anonymous discovery of 1.8.0 (rollback switch). */
export function anonymousDiscoveryOnMain(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.MCP_ANONYMOUS_DISCOVERY ?? '').trim().toLowerCase() === 'true';
}

export function isUnauthenticatedAllowed(body: unknown, mode: EndpointMode): boolean {
  if (mode === 'auth_required') return false;
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  const method = typeof b.method === 'string' ? b.method : '';
  if (UNAUTHENTICATED_METHODS.has(method)) return true;
  if (method === 'tools/call') {
    const params = (b.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === 'string' ? params.name : '';
    return UNAUTHENTICATED_TOOLS.has(name);
  }
  return false;
}

const SOTA_API_URL = process.env.SOTA_API_URL ?? 'https://api.sota.io';
export const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN ?? 'https://mcp.sota.io';
// Always the version of the running package (package.json), never an env
// override: /health must say which code is deployed.
const VERSION = PACKAGE_VERSION;

export const app = express();

// Body limits. Every call an anonymous client may make (initialize,
// tools/list, prompts, create_account) and every call but an inline deploy
// is a few KB; 64 KB leaves room. Only POST /mcp with a credential that
// looks valid BEFORE the body is read (a sota_ key of the right shape, or a
// JWT that verifies) gets the large limit, which an inline deploy needs (up
// to 10 MB decoded; base64 adds a third). At most LARGE_BODIES.limit large
// bodies are read and parsed at the same time; the next one gets a "busy"
// answer. A body above the limit is refused with 413 from its
// Content-Length, before it is read.
export const SMALL_BODY_LIMIT = '64kb';
export const LARGE_BODY_LIMIT = '16mb';
const smallJson = express.json({ limit: SMALL_BODY_LIMIT });
const largeJson = express.json({ limit: LARGE_BODY_LIMIT });
/** Bodies above this size need a slot of LARGE_BODIES. */
const LARGE_BODY_SLOT_BYTES = 1024 * 1024;
const API_KEY_SHAPE = /^sota_[0-9a-f]{40}$/;

async function mayPostLargeBody(req: Request): Promise<boolean> {
  // Both MCP endpoints: a user who signed in on /mcp/signup deploys there too.
  if (req.method !== 'POST' || (req.path !== '/mcp' && req.path !== '/mcp/signup')) return false;
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice('Bearer '.length).trim();
  if (API_KEY_SHAPE.test(token)) return true;
  if (token.startsWith('sota_') || token === '') return false;
  try {
    await verifyJwt(token);
    return true;
  } catch {
    return false;
  }
}

app.use(async (req: Request, res: Response, next) => {
  if (!(await mayPostLargeBody(req))) {
    smallJson(req, res, next);
    return;
  }
  const length = Number(req.headers['content-length'] ?? NaN);
  if (Number.isFinite(length) && length <= LARGE_BODY_SLOT_BYTES) {
    largeJson(req, res, next);
    return;
  }
  const release = LARGE_BODIES.tryAcquire();
  if (!release) {
    res
      .status(503)
      .header('Retry-After', String(BUSY_RETRY_SECONDS))
      .json({
        jsonrpc: '2.0',
        error: { code: -32000, message: `The sota.io MCP server is busy with other large uploads; retry in ${BUSY_RETRY_SECONDS} s.` },
        id: null,
      });
    return;
  }
  res.on('close', release);
  largeJson(req, res, (err?: unknown) => {
    release();
    next(err);
  });
});
// Required for the /auth/v1/oauth/token proxy passthrough — Supabase's
// token endpoint expects application/x-www-form-urlencoded bodies.
app.use(express.urlencoded({ extended: true, limit: '64kb' }));

// Transparent reverse proxy in front of
// Supabase OAuth Server that strips the `openid` scope before forwarding.
// Activated regardless of metadata-advertised scopes — see oauth-proxy.ts.
mountOAuthProxy(app, PUBLIC_ORIGIN);

// ───────────────────────────────────────────────────────────────────────────
// /health — Traefik / Docker healthcheck target
// ───────────────────────────────────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: 'sota-mcp',
    version: VERSION,
    // Which commit this image was built from ("unknown" without the
    // GIT_SHA/BUILD_TIME build args). `version` stays the package version.
    commit: GIT_SHA,
    built_at: BUILD_TIME,
    transport: 'streamable-http',
    ts: new Date().toISOString(),
  });
});

// ───────────────────────────────────────────────────────────────────────────
// RFC 9728 Protected Resource Metadata
// ───────────────────────────────────────────────────────────────────────────
// MCP clients fetch this BEFORE attempting auth. It points them at the
// Authorization Server (Supabase) and declares the audience binding.
// Spec: https://datatracker.ietf.org/doc/html/rfc9728
// MCP requirement: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
//
// RFC 9728 §3.1: for a resource with a path the document lives at the
// well-known prefix + that path, and its `resource` must equal the URL the
// client connects to, path included (RFC 9728 §3.3; Claude checks this
// exactly). The 401 of each endpoint points at its own document. The root
// document keeps `resource` = the origin as up to 1.8.0, for clients that
// cached it; clients that compare by prefix accept it for every path below.
export const MCP_PATH = '/mcp';
export const SIGNUP_PATH = '/mcp/signup';
export const DISCOVER_PATH = '/mcp/discover';
export const OAUTH_SCOPES = ['profile', 'email'];

export function resourceMetadataUrl(path: string): string {
  return `${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource${path}`;
}

function protectedResourceMetadata(resource: string) {
  return {
    resource,
    // Point clients at OUR proxy instead of auth.sota.io directly. The
    // proxy strips `openid` from /authorize requests so Supabase never
    // sees it — works around the Supabase OAuth Server 500 bug regardless
    // of whether the client respects scopes_supported. The token is still
    // signed by Supabase (we don't mint our own) so existing JWT
    // validation against the Supabase issuer keeps working.
    authorization_servers: [`${PUBLIC_ORIGIN}/auth/v1`],
    bearer_methods_supported: ['header'],
    resource_name: 'sota.io',
    resource_documentation: 'https://sota.io/docs/mcp/setup',
    // 'openid' deliberately omitted: Supabase OAuth Server (May 2026)
    // returns a 500 "Error generating ID token" on /oauth/token when the
    // openid scope is requested. Without openid we get a working access
    // token (HS256-signed JWT, iss=supabase, aud=authenticated) and the
    // MCP flow completes end-to-end. Re-add openid once Supabase fixes
    // their OIDC implementation; for now, identity claims (email, sub)
    // ride along on the access token without an explicit ID token.
    scopes_supported: OAUTH_SCOPES,
    resource_signing_alg_values_supported: ['RS256', 'ES256'],
  };
}

app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
  res.json(protectedResourceMetadata(PUBLIC_ORIGIN));
});
for (const path of [MCP_PATH, SIGNUP_PATH]) {
  app.get(`/.well-known/oauth-protected-resource${path}`, (_req: Request, res: Response) => {
    res.json(protectedResourceMetadata(`${PUBLIC_ORIGIN}${path}`));
  });
}

// ───────────────────────────────────────────────────────────────────────────
// /mcp — Streamable HTTP transport endpoint
// ───────────────────────────────────────────────────────────────────────────
// Stateless mode: every request gets a fresh McpServer + transport instance.
// Adequate for low-traffic; revisit if we see > 100 RPS sustained.
function unauthorized(res: Response, path: string, reason: string, detail?: string, id: unknown = null) {
  // RFC 6750 §3.1: a request without any credential gets no `error` code; a
  // bad credential gets `invalid_token`, our own reason (token_expired,
  // invalid_issuer, …) goes into error_description.
  const error = reason === 'missing_token' ? '' : `, error="invalid_token", error_description="${reason}"`;
  res
    .status(401)
    .header(
      'WWW-Authenticate',
      `Bearer realm="${PUBLIC_ORIGIN}"${error}, resource_metadata="${resourceMetadataUrl(path)}", scope="${OAUTH_SCOPES.join(' ')}"`,
    )
    .json({
      // `error` / `reason` / `detail` as up to 1.8.0, for scripts that read them.
      error: 'unauthorized',
      reason,
      detail: detail ?? 'Sign in: connect this server with OAuth, or pass Authorization: Bearer sota_<key>.',
      id: id ?? null,
    });
}

function requestId(body: unknown): unknown {
  return body && typeof body === 'object' && 'id' in (body as Record<string, unknown>)
    ? (body as Record<string, unknown>).id
    : null;
}

/**
 * Guard of /mcp/discover: anonymous, read-only listing for registries,
 * directories and docs tooling. Returns true when the request was answered
 * (refused) here. Nothing is ever executed on this path: only the methods in
 * DISCOVERY_METHODS reach the MCP server, so no tool handler, no prompt and
 * no API call can run, whatever the body says.
 */
function refuseOnDiscovery(req: Request, res: Response): boolean {
  const body = req.body as Record<string, unknown> | unknown[] | undefined;
  const id = requestId(body);
  const refuse = (status: number, code: number, message: string) => {
    res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id });
    return true;
  };
  if (req.headers.authorization !== undefined) {
    // Nobody should configure the discovery URL and believe they are signed in.
    return refuse(400, -32600, `${PUBLIC_ORIGIN}${DISCOVER_PATH} is anonymous and read-only and takes no credentials. To use sota.io, connect to ${PUBLIC_ORIGIN}${MCP_PATH} (sign-in with OAuth, or Authorization: Bearer sota_<key>).`);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return refuse(400, -32600, 'Send one JSON-RPC request per POST.');
  }
  const ip = clientIp(req);
  if (!DISCOVERY_LIMITER.take(ip)) {
    res.header('Retry-After', String(DISCOVERY_LIMITER.retryAfterSeconds()));
    return refuse(429, -32000, 'Too many discovery requests; retry in a minute.');
  }
  const method = typeof body.method === 'string' ? body.method : '';
  if (!DISCOVERY_METHODS.has(method)) {
    return refuse(403, -32601, `${PUBLIC_ORIGIN}${DISCOVER_PATH} only lists the tools (initialize, tools/list, prompts/list); "${method || 'this request'}" is not available here. To call tools, connect to ${PUBLIC_ORIGIN}${MCP_PATH} and sign in.`);
  }
  return false;
}

async function handleMcpRequest(req: Request, res: Response, path: string, mode: EndpointMode) {
  if (mode === 'discover') {
    if (refuseOnDiscovery(req, res)) return;
  }

  // ── The hosted deploy tool never takes directory / git_url ──
  // Checked before auth and before the SDK parses the call, so no tool code
  // runs for such a request whatever the token or the SDK's argument
  // handling. JSON-RPC "invalid params" in an HTTP 400.
  const rejection = hostedDeployRejection(req.body);
  if (rejection) {
    logEvent('warn', { event: 'hosted_deploy_mode_rejected', request_id: crypto.randomUUID() });
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32602, message: rejection.message },
      id: rejection.id,
    });
    return;
  }

  // ── Auth: OAuth JWT validation + token-to-key bridge ──
  // Accept Bearer <jwt> (Claude/MCP path) OR Bearer <sota_xxx> (testing/CLI path).
  // sota_-prefixed tokens skip JWT validation and pass through directly.
  const authHeader = req.headers.authorization ?? '';
  const rawToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : '';

  const startedAt = Date.now();
  const auditMeta: Record<string, unknown> = {
    request_id: crypto.randomUUID(),
    started_at: new Date(startedAt).toISOString(),
  };

  // Anonymous path for discovery + create_account. The MCP server is still
  // constructed, but with a "phantom" apiKey that never reaches sota-api
  // (only the create_account tool is registered and it doesn't use SotaClient).
  let apiKey = '';
  // On /mcp/discover the guard above already refused every credential and
  // every method but initialize / tools/list / prompts/list.
  const allowAnonymous = mode === 'discover' || (!rawToken && isUnauthenticatedAllowed(req.body, mode));
  auditMeta.endpoint = path;

  if (!rawToken && !allowAnonymous) {
    logEvent('info', { ...auditMeta, event: 'auth_required', method: req.body?.method });
    unauthorized(res, path, 'missing_token', undefined, requestId(req.body));
    return;
  }

  if (allowAnonymous) {
    auditMeta.auth_path = 'anonymous';
    apiKey = 'anonymous';
  } else if (rawToken.startsWith('sota_')) {
    // Direct API-key path — legacy testing + CLI use, no OAuth involved.
    apiKey = rawToken;
    auditMeta.auth_path = 'direct_api_key';
    auditMeta.key_prefix = rawToken.slice(0, 13);
  } else {
    // JWT path — Claude OAuth
    try {
      const claims = await verifyJwt(rawToken);
      auditMeta.auth_path = 'jwt';
      auditMeta.user_id = claims.sub;
      auditMeta.iss = claims.iss;

      const bridge = await getOrProvisionApiKey(claims.sub);
      apiKey = bridge.apiKey;
      auditMeta.key_provisioned = bridge.created;
      auditMeta.key_rotated = bridge.rotated;
    } catch (err) {
      if (err instanceof JwtVerificationError) {
        logEvent('info', {
          ...auditMeta,
          event: 'auth_failed',
          error_code: err.code,
          error_message: errorMessage(err),
        });
        unauthorized(res, path, err.code, err.message, requestId(req.body));
        return;
      }
      // Database / network problem during bridge — surface as 503, not 401
      logEvent('error', {
        ...auditMeta,
        event: 'bridge_error',
        error_message: errorMessage(err),
      });
      res.status(503).json({
        error: 'bridge_unavailable',
        message: 'Could not provision an API key for this Claude session — try again in a moment.',
      });
      return;
    }
  }

  // Build a fresh MCP server per request (stateless mode).
  const server = new McpServer(
    {
      name: 'sota',
      version: VERSION,
      title: 'sota.io',
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // ALL tools are always registered so they show up in tools/list, regardless
  // of whether the current request is authenticated (anonymous requests reach
  // this point only on /mcp/signup, or on /mcp with MCP_ANONYMOUS_DISCOVERY).
  // Why: when a client like
  // Claude.ai discovers an MCP connector, it asks tools/list once. If we hide
  // the 13 authenticated tools from that listing, the LLM only sees
  // create_account and never tries to call deploy/list-projects/etc — which
  // means the per-tool 401 → OAuth-redirect dance never triggers. The user
  // is then stuck with one tool and no way to elevate.
  //
  // With all tools registered, the LLM sees the full catalog. When the user
  // asks for any non-create_account tool, the tools/call middleware (above)
  // returns 401 with WWW-Authenticate — that's the signal Claude.ai needs to
  // open the OAuth popup. After OAuth completes, the retry has a valid token
  // and the tool runs against api.sota.io with the user's real key.
  //
  // The phantom apiKey "anonymous" passed to SotaClient never actually hits
  // api.sota.io because the middleware rejects unauthenticated tools/call
  // for non-create_account before reaching the handler.
  registerCreateAccountTool(server);
  const client = new SotaClient({ apiKey: apiKey || 'anonymous', baseUrl: SOTA_API_URL });
  const readAccount = accountReader(SOTA_API_URL, apiKey || 'anonymous');
  registerAccountTool(server, readAccount);
  registerChecklistPrompt(server);
  registerProjectTools(server, client, { readAccount });
  registerDeployTool(server, client, { hosted: true, readAccount });
  registerLogsTool(server, client);
  registerEnvTools(server, client);
  registerRollbackTool(server, client);
  registerRedeployTool(server, client);
  registerStatusTool(server, client);
  registerSourceTools(server, sourceApi(SOTA_API_URL, apiKey || 'anonymous'));
  registerDomainTools(server, client);

  // Stateless transport — no session header required.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req as unknown as Parameters<typeof transport.handleRequest>[0], res as unknown as Parameters<typeof transport.handleRequest>[1], req.body);
    // Structured audit log per request: user id (JWT sub), never the email.
    logEvent('info', {
      ...auditMeta,
      event: 'mcp_request',
      method: req.body?.method,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    logEvent('error', {
      ...auditMeta,
      event: 'mcp_error',
      error_message: errorMessage(err),
      duration_ms: Date.now() - startedAt,
    });
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        id: null,
      });
    }
  }
}

function mainMode(): EndpointMode {
  return anonymousDiscoveryOnMain() ? 'signup' : 'auth_required';
}

app.post(MCP_PATH, (req: Request, res: Response) => handleMcpRequest(req, res, MCP_PATH, mainMode()));
app.post(SIGNUP_PATH, (req: Request, res: Response) => handleMcpRequest(req, res, SIGNUP_PATH, 'signup'));
app.post(DISCOVER_PATH, (req: Request, res: Response) => handleMcpRequest(req, res, DISCOVER_PATH, 'discover'));
app.get(DISCOVER_PATH, (_req: Request, res: Response) => {
  res.status(405).header('Allow', 'POST').json({ error: 'method_not_allowed', allowed: 'POST' });
});

function getMcp(path: string, mode: () => EndpointMode) {
  return async (req: Request, res: Response) => {
    // Stateless server: no GET stream, so 405. On the auth-required endpoint
    // an anonymous GET gets the same 401 as an anonymous POST, so a client
    // that probes with GET first also learns where to sign in. A credential
    // is checked before the 405 (JWT: verified; sota_ key: its shape, the API
    // checks the key itself on the first real call), so a GET probe with a
    // stale token also learns that it must sign in again.
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
    if (!token) {
      if (mode() === 'auth_required') {
        unauthorized(res, path, 'missing_token');
        return;
      }
    } else if (token.startsWith('sota_')) {
      if (!API_KEY_SHAPE.test(token)) {
        unauthorized(res, path, 'invalid_api_key', 'The API key is not a sota_ key of the right shape.');
        return;
      }
    } else {
      try {
        await verifyJwt(token);
      } catch (err) {
        const code = err instanceof JwtVerificationError ? err.code : 'invalid_token';
        unauthorized(res, path, code, errorMessage(err));
        return;
      }
    }
    res.status(405).header('Allow', 'POST').json({ error: 'method_not_allowed', allowed: 'POST' });
  };
}
app.get(MCP_PATH, getMcp(MCP_PATH, mainMode));
app.get(SIGNUP_PATH, getMcp(SIGNUP_PATH, () => 'signup'));

// ───────────────────────────────────────────────────────────────────────────
// Root index for humans hitting mcp.sota.io directly
// ───────────────────────────────────────────────────────────────────────────
app.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'sota-mcp',
    version: VERSION,
    description: 'MCP server for sota.io — EU-native PaaS. Use the Streamable HTTP transport at /mcp.',
    docs: 'https://sota.io/docs/mcp/setup',
    endpoints: {
      health: `${PUBLIC_ORIGIN}/health`,
      // The connector URL: sign-in when the connector is added.
      mcp: `${PUBLIC_ORIGIN}${MCP_PATH}`,
      // Sign-up from inside a chat (create_account without a credential).
      signup: `${PUBLIC_ORIGIN}${SIGNUP_PATH}`,
      // Anonymous, read-only tool listing for registries and directories.
      discover: `${PUBLIC_ORIGIN}${DISCOVER_PATH}`,
      protected_resource_metadata: resourceMetadataUrl(MCP_PATH),
    },
  });
});

// Body parser errors as JSON-RPC answers: 413 for a body above the limit
// (refused from its Content-Length before it is read), 400 for broken JSON.
app.use((err: unknown, _req: Request, res: Response, next: express.NextFunction) => {
  const e = err as { type?: string } | undefined;
  if (!e || res.headersSent) {
    next(err);
    return;
  }
  if (e.type === 'entity.too.large') {
    res.status(413).json({
      jsonrpc: '2.0',
      error: {
        code: -32600,
        message: `Request body too large. Without a valid credential the limit is ${SMALL_BODY_LIMIT}; an authenticated deploy may send up to ${LARGE_BODY_LIMIT} (10 MB of files after base64 decoding).`,
      },
      id: null,
    });
    return;
  }
  if (e.type === 'entity.parse.failed') {
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: the request body is not valid JSON.' }, id: null });
    return;
  }
  next(err);
});
