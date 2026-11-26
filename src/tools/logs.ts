import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SotaClient } from '@sota-io/sdk';

export function registerLogsTool(server: McpServer, client: SotaClient) {
  server.registerTool('get-logs', {
    title: 'Show build logs',
    description: 'Get the build and deploy log of a deployment (logs of the running app are not available yet). If no deployment_id is provided, returns the log of the latest deployment. Use this after calling deploy to follow the build and diagnose build failures: framework detection, dependency installation and build steps. The reason of a failed health check is shown by get-status. If a deployment fails, check the logs for error details — common issues include missing dependencies, build errors, or the app not listening on the correct PORT (check the PORT env var — 8080 for auto-detected frameworks, or the EXPOSE value from Dockerfile).',
    inputSchema: {
      project_id: z.string().describe('Project ID (UUID) to get logs for'),
      deployment_id: z.string().optional().describe('Specific deployment ID (optional, defaults to latest). Use get-status to see recent deployment IDs'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
