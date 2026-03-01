import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SotaAPIClient } from '../api-client.js';

export function registerLogsTool(server: McpServer, client: SotaAPIClient) {
  server.registerTool('get-logs', {
    description: 'Get build and runtime logs for a deployment. If no deployment_id is provided, returns logs for the latest deployment.',
    inputSchema: {
      project_id: z.string().describe('Project ID to get logs for'),
      deployment_id: z.string().optional().describe('Specific deployment ID (optional, defaults to latest)'),
    },
  }, async ({ project_id, deployment_id }) => {
    try {
      let deployId = deployment_id;

      if (!deployId) {
        // Get latest deployment
        const deployments = await client.getDeployments(project_id);
        if (deployments.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No deployments found for this project.',
              },
            ],
          };
        }
        deployId = deployments[0].id;
      }

      const logs = await client.getLogs(project_id, deployId);

      return {
        content: [
          {
            type: 'text' as const,
            text: logs || 'No logs available yet.',
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to get logs: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });
}
