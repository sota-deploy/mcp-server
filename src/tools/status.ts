import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SotaClient } from '@sota-io/sdk';

export function registerStatusTool(server: McpServer, client: SotaClient) {
  server.registerTool('get-status', {
    description: 'Get the current deployment status for a project, including URL and recent deployment history',
    inputSchema: {
      project_id: z.string().describe('Project ID to check status for'),
    },
  }, async ({ project_id }) => {
    try {
      const deployments = await client.listDeployments(project_id) ?? [];

      if (deployments.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No deployments found. Use the deploy tool to deploy your app.',
            },
          ],
        };
      }

      const latest = deployments[0];
      const lines = [
        `Current deployment:`,
        `  ID: ${latest.id}`,
        `  Status: ${latest.status}`,
        `  URL: ${latest.url || 'not available'}`,
        `  Created: ${latest.created_at}`,
      ];

      if (latest.framework) {
        lines.push(`  Framework: ${latest.framework}`);
      }
      if (latest.error) {
        lines.push(`  Error: ${latest.error}`);
      }

      if (deployments.length > 1) {
        lines.push('', 'Recent deployments:');
        for (const d of deployments.slice(1, 5)) {
          lines.push(`  ${d.id.slice(0, 8)} - ${d.status} (${d.created_at})`);
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: lines.join('\n'),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to get status: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });
}
