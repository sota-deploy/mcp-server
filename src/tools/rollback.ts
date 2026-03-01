import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SotaClient } from '@sota-io/sdk';

export function registerRollbackTool(server: McpServer, client: SotaClient) {
  server.registerTool('rollback', {
    description: 'Rollback a project to its previous deployment. This swaps the container image without rebuilding.',
    inputSchema: {
      project_id: z.string().describe('Project ID to rollback'),
    },
  }, async ({ project_id }) => {
    try {
      const deployment = await client.rollback(project_id);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Rollback successful:\n  Deployment ID: ${deployment.id}\n  Status: ${deployment.status}\n  URL: ${deployment.url || 'pending'}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Rollback failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });
}
