/**
 * sota.io MCP Server — HTTP Transport (remote)
 *
 * Streamable HTTP variant of the existing stdio MCP server, exposed via
 * mcp.sota.io/mcp for one-click installation from Claude Desktop and
 * Claude.ai. The entry point is http.ts; this module builds the Express app
 * so tests can run it on an ephemeral port.
 *
 * Hosted differences from stdio (MCP-1): `deploy` accepts inline `files`
 * only (no `directory`, no `git_url`), enforced by the tool schema, by
 * hostedDeployRejection() before any tool runs and by the tool itself. Logs
 * carry user ids, never emails.
 *
 * Phase 57-01 (this file): scaffold + transport + RFC 9728 metadata.
 *   Auth is currently a pass-through Bearer API key — clients send their
 *   existing sota_xxx key as `Authorization: Bearer <key>` and it gets
 *   forwarded to sota-api. No OAuth validation yet.
 *
 * Phase 57-02 (next): OAuth 2.1 + JWT validation against Supabase JWKS,
 *   token-to-API-key bridge with `source=claude` audit tagging.
 *
 * Phase 57-03 (next): `create_account` tool for net-new user signup from
 *   inside Claude + plan-based capability gating.
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
import { accountReader } from './lib/account.js';
import { SERVER_INSTRUCTIONS } from './lib/guide.js';

// Tools that may be invoked WITHOUT authentication. Currently only
// create_account — net-new users obviously don't have an API key yet.
// Discovery requests (initialize, tools/list) are also allowed
// unauthenticated so Claude can fetch capabilities before OAuth.
const UNAUTHENTICATED_TOOLS = new Set(['create_account']);
// MCP handshake + tools/list are reachable without auth so Claude.ai's
// connector UI can render the tool catalogue (it shows "Konnektor hat keine
// Tools verfügbar" otherwise — a dead-end state for the user). The
// per-tool-call 401 + WWW-Authenticate is the actual OAuth trigger.
// prompts/list and prompts/get serve only the static Enterprise checklist
// (no API call, no account data), so they need no token either (261125-mcg).
const UNAUTHENTICATED_METHODS = new Set([
  'initialize',
  'notifications/initialized',
  'tools/list',
  'prompts/list',
  'prompts/get',
]);

function isUnauthenticatedAllowed(body: unknown): boolean {
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
app.use(express.json({ limit: '4mb' }));
// Required for the /auth/v1/oauth/token proxy passthrough — Supabase's
// token endpoint expects application/x-www-form-urlencoded bodies.
app.use(express.urlencoded({ extended: true, limit: '64kb' }));

// Phase-65/Pattern-A precursor: transparent reverse proxy in front of
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
    // DEVX-4: which commit this image was built from ("unknown" without the
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
app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
  res.json({
    resource: PUBLIC_ORIGIN,
    // Point clients at OUR proxy instead of auth.sota.io directly. The
    // proxy strips `openid` from /authorize requests so Supabase never
    // sees it — works around the Supabase OAuth Server 500 bug regardless
    // of whether the client respects scopes_supported. The token is still
    // signed by Supabase (we don't mint our own) so existing JWT
    // validation against the Supabase issuer keeps working.
    authorization_servers: [`${PUBLIC_ORIGIN}/auth/v1`],
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://sota.io/docs/integrations/claude',
    // 'openid' deliberately omitted: Supabase OAuth Server (May 2026)
    // returns a 500 "Error generating ID token" on /oauth/token when the
    // openid scope is requested. Without openid we get a working access
    // token (HS256-signed JWT, iss=supabase, aud=authenticated) and the
    // MCP flow completes end-to-end. Re-add openid once Supabase fixes
    // their OIDC implementation; for now, identity claims (email, sub)
    // ride along on the access token without an explicit ID token.
    scopes_supported: ['profile', 'email'],
    resource_signing_alg_values_supported: ['RS256', 'ES256'],
  });
});

// ───────────────────────────────────────────────────────────────────────────
// /mcp — Streamable HTTP transport endpoint
// ───────────────────────────────────────────────────────────────────────────
// Stateless mode: every request gets a fresh McpServer + transport instance.
// Adequate for low-traffic; revisit if we see > 100 RPS sustained.
function unauthorized(res: Response, reason: string, detail?: string) {
  res
    .status(401)
    .header(
      'WWW-Authenticate',
      `Bearer realm="${PUBLIC_ORIGIN}", error="${reason}", resource_metadata="${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource"`,
    )
    .json({ error: 'unauthorized', reason, detail });
}

async function handleMcpRequest(req: Request, res: Response) {
  // ── MCP-1: the hosted deploy tool never takes directory / git_url ──
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

  // ── 57-02 Auth: OAuth JWT validation + token-to-key bridge ──
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
  const allowAnonymous = !rawToken && isUnauthenticatedAllowed(req.body);

  if (!rawToken && !allowAnonymous) {
    unauthorized(res, 'missing_token', 'Pass Authorization: Bearer <jwt>');
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
        unauthorized(res, err.code, err.message);
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
  // of whether the current request is authenticated. Why: when a client like
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
  registerStatusTool(server, client);
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

app.post('/mcp', handleMcpRequest);
app.get('/mcp', (_req: Request, res: Response) => {
  // GET on /mcp without an active session = 405 Method Not Allowed.
  // (Stateful mode would use GET for the SSE response stream; we're stateless.)
  res.status(405).json({ error: 'method_not_allowed', allowed: 'POST' });
});

// ───────────────────────────────────────────────────────────────────────────
// Root index for humans hitting mcp.sota.io directly
// ───────────────────────────────────────────────────────────────────────────
app.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'sota-mcp',
    version: VERSION,
    description: 'MCP server for sota.io — EU-native PaaS. Use the Streamable HTTP transport at /mcp.',
    docs: 'https://sota.io/docs/integrations/claude',
    endpoints: {
      health: `${PUBLIC_ORIGIN}/health`,
      mcp: `${PUBLIC_ORIGIN}/mcp`,
      protected_resource_metadata: `${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource`,
    },
  });
});
