import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SotaClient } from '@sota-io/sdk';

export function registerStatusTool(server: McpServer, client: SotaClient) {
  server.registerTool('get-status', {
    description: 'Get the current deployment status for a project, including the live host (the project URL from list-projects: https://{slug}.sota.io, or https://{app}.{label}.sota.io on a sota Enterprise account), detected framework, the reason of a failed deployment, and recent deployment history. Deployment statuses: pending (queued), building (build in progress), built (image ready), deploying (starting container + health checks), running (live and healthy), failed (build or health check error), stopped (replaced by newer deployment). Use this to verify a deployment succeeded after calling deploy.',
    inputSchema: {
      project_id: z.string().describe('Project ID (UUID) to check status for. Use list-projects to find the ID'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
      // The API sends error_message; older SDK types call it error.
      const failure = (latest as { error_message?: string }).error_message ?? latest.error;
      if (failure) {
        lines.push(`  Error: ${failure}`);
      }
      if (latest.status === 'failed' && failure && /health check/i.test(failure)) {
        lines.push(
          '  Hint: the app did not answer GET /health (or GET / when /health is 404) with 2xx/3xx within 60 s. It must listen on 0.0.0.0:$PORT and answer these paths WITHOUT identity headers (sota Enterprise: do not return 401 there). The previous version, if any, keeps running.',
        );
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
