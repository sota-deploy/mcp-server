import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SotaClient } from '@sota-io/sdk';

export function registerLogsTool(server: McpServer, client: SotaClient) {
  server.registerTool('get-logs', {
    description: 'Get build and runtime logs for a deployment. If no deployment_id is provided, returns logs for the latest deployment. Use this after calling deploy to monitor build progress and diagnose failures. Logs include: framework detection output, dependency installation, build steps, container startup, and health check results. If a deployment fails, check the logs for error details — common issues include missing dependencies, build errors, or the app not listening on the correct PORT (check the PORT env var — 8080 for auto-detected frameworks, or the EXPOSE value from Dockerfile).',
    inputSchema: {
      project_id: z.string().describe('Project ID (UUID) to get logs for'),
      deployment_id: z.string().optional().describe('Specific deployment ID (optional, defaults to latest). Use get-status to see recent deployment IDs'),
    },
  }, async ({ project_id, deployment_id }) => {
    try {
      let deployId = deployment_id;

      if (!deployId) {
        // Get latest deployment
        const deployments = await client.listDeployments(project_id) ?? [];
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
