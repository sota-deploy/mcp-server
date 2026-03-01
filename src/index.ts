#!/usr/bin/env node

/**
 * sota.io MCP Server
 *
 * Exposes all sota.io platform operations as MCP tools for AI agents
 * (Claude Code, Open CLAW, etc.)
 *
 * Environment variables:
 *   SOTA_API_KEY  - API key for authentication (sota_... prefix)
 *   SOTA_API_URL  - API base URL (default: https://api.sota.io)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SotaAPIClient } from './api-client.js';
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

  const client = new SotaAPIClient(apiURL, apiKey);

  const server = new McpServer({
    name: 'sota',
    version: '1.0.0',
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
