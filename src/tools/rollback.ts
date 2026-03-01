import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SotaClient } from '@sota-io/sdk';

export function registerRollbackTool(server: McpServer, client: SotaClient) {
  server.registerTool('rollback', {
    description: 'Rollback a project to its previous deployment. This instantly swaps the container image without rebuilding — the previous image is reused for near-instant rollback. Uses the same blue-green strategy for zero downtime. The database is NOT rolled back (data persists across deployments). Use this when a deployment introduces bugs or breaks the app.',
    inputSchema: {
      project_id: z.string().describe('Project ID (UUID) to rollback. Use list-projects to find the ID'),
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
