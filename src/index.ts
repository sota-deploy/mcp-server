#!/usr/bin/env node

/**
 * sota.io MCP Server
 *
 * EU-native DevOps PaaS — deploy web apps with a single API call.
 * Exposes all sota.io platform operations as MCP tools for AI agents
 * (Claude Code, Cursor, Windsurf, etc.)
 *
 * Platform features included with every project:
 *   - Managed PostgreSQL 17 database (DATABASE_URL auto-injected)
 *   - PgBouncer connection pooling (20 pool size, 100 max clients)
 *   - Automatic daily database backups (7-day retention)
 *   - Zero-downtime blue-green deployments with instant rollback
 *   - Automatic HTTPS via Let's Encrypt wildcard certificate
 *   - gVisor container isolation for security
 *   - Auto-detection for Next.js, Node.js, Python, or custom Dockerfile
 *   - EU-hosted (Hetzner Cloud, Germany) — GDPR-compliant
 *
 * Environment variables:
 *   SOTA_API_KEY  - API key for authentication (sota_... prefix)
 *   SOTA_API_URL  - API base URL (default: https://api.sota.io)
 *
 * Docs: https://sota.io/docs
 * GitHub: https://github.com/sota-deploy
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SotaClient } from '@sota-io/sdk';
import { registerProjectTools } from './tools/projects.js';
import { registerDeployTool } from './tools/deploy.js';
import { registerLogsTool } from './tools/logs.js';
import { registerEnvTools } from './tools/env.js';
import { registerRollbackTool } from './tools/rollback.js';
import { registerStatusTool } from './tools/status.js';

async function main() {
  const apiKey = process.env.SOTA_API_KEY;
  if (!apiKey) {
    console.error('Error: SOTA_API_KEY environment variable is required');
    console.error('Create one at: https://api.sota.io/v1/api-keys (or via sota CLI)');
    process.exit(1);
  }

  const apiURL = process.env.SOTA_API_URL || 'https://api.sota.io';

  const client = new SotaClient({ apiKey, baseUrl: apiURL });

  const server = new McpServer({
    name: 'sota',
    version: '1.1.0',
  });

  // Register all tools
  registerProjectTools(server, client);
  registerDeployTool(server, client);
  registerLogsTool(server, client);
  registerEnvTools(server, client);
  registerRollbackTool(server, client);
  registerStatusTool(server, client);

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
