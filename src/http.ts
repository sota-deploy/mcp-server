#!/usr/bin/env node

/**
 * sota.io MCP Server — HTTP Transport (remote)
 *
 * Streamable HTTP variant of the existing stdio MCP server. Same 13 tools,
 * exposed via mcp.sota.io/mcp for one-click installation from Claude Desktop
 * and Claude.ai.
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

// Tools that may be invoked WITHOUT authentication. Currently only
// create_account — net-new users obviously don't have an API key yet.
// Discovery requests (initialize, tools/list) are also allowed
// unauthenticated so Claude can fetch capabilities before OAuth.
const UNAUTHENTICATED_TOOLS = new Set(['create_account']);
const UNAUTHENTICATED_METHODS = new Set(['initialize', 'notifications/initialized', 'tools/list']);

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

const PORT = Number(process.env.PORT ?? 8080);
const SOTA_API_URL = process.env.SOTA_API_URL ?? 'https://api.sota.io';
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN ?? 'https://mcp.sota.io';
const AUTH_SERVER = process.env.AUTH_SERVER ?? 'https://auth.sota.io/auth/v1';
const VERSION = process.env.MCP_SERVER_VERSION ?? '1.4.0-pre';

const app = express();
app.use(express.json({ limit: '4mb' }));

// ───────────────────────────────────────────────────────────────────────────
// /health — Traefik / Docker healthcheck target
// ───────────────────────────────────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: 'sota-mcp',
    version: VERSION,
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
    authorization_servers: [AUTH_SERVER],
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://sota.io/docs/integrations/claude',
    scopes_supported: ['openid', 'profile', 'email'],
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
      auditMeta.email = claims.email;
      auditMeta.iss = claims.iss;

      const bridge = await getOrProvisionApiKey(claims.sub);
      apiKey = bridge.apiKey;
      auditMeta.key_provisioned = bridge.created;
      auditMeta.key_rotated = bridge.rotated;
    } catch (err) {
      if (err instanceof JwtVerificationError) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify({
            ...auditMeta,
            event: 'auth_failed',
            error_code: err.code,
            error_message: err.message,
          }),
        );
        unauthorized(res, err.code, err.message);
        return;
      }
      // Database / network problem during bridge — surface as 503, not 401
      // eslint-disable-next-line no-console
      console.error(
        JSON.stringify({
          ...auditMeta,
          event: 'bridge_error',
          error_message: err instanceof Error ? err.message : String(err),
        }),
      );
      res.status(503).json({
        error: 'bridge_unavailable',
        message: 'Could not provision an API key for this Claude session — try again in a moment.',
      });
      return;
    }
  }

  // Build a fresh MCP server per request (stateless mode).
  const server = new McpServer({
    name: 'sota',
    version: VERSION,
    title: 'sota.io',
  });

  // create_account is registered ALWAYS — it's the wedge tool that lets
  // brand-new users sign up from inside Claude before they have an API key.
  registerCreateAccountTool(server);

  // The sota-api-backed tools are only registered when the request carries
  // valid auth. For anonymous requests (initialize / tools/list / tools/call
  // create_account), the user just sees create_account in the catalog.
  if (!allowAnonymous) {
    const client = new SotaClient({ apiKey, baseUrl: SOTA_API_URL });
    registerProjectTools(server, client);
    registerDeployTool(server, client);
    registerLogsTool(server, client);
    registerEnvTools(server, client);
    registerRollbackTool(server, client);
    registerStatusTool(server, client);
    registerDomainTools(server, client);
  }

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
    // Structured audit log per request (Claude path only — direct API key calls don't audit here)
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        ...auditMeta,
        event: 'mcp_request',
        method: req.body?.method,
        duration_ms: Date.now() - startedAt,
      }),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        ...auditMeta,
        event: 'mcp_error',
        error_message: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - startedAt,
      }),
    );
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

// ───────────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`sota-mcp listening on http://0.0.0.0:${PORT} (public: ${PUBLIC_ORIGIN})`);
});
