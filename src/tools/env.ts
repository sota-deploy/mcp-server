import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SotaAPIClient } from '../api-client.js';

export function registerEnvTools(server: McpServer, client: SotaAPIClient) {
  server.registerTool('set-env', {
    description: 'Set an environment variable for a project',
    inputSchema: {
      project_id: z.string().describe('Project ID'),
      key: z.string().describe('Environment variable name (e.g., DATABASE_URL)'),
      value: z.string().describe('Environment variable value'),
    },
  }, async ({ project_id, key, value }) => {
    try {
      await client.setEnvVar(project_id, key, value);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Environment variable ${key} set successfully.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to set env var: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  server.registerTool('get-env', {
    description: 'List environment variables for a project',
    inputSchema: {
      project_id: z.string().describe('Project ID'),
    },
  }, async ({ project_id }) => {
    try {
      const envVars = await client.listEnvVars(project_id);
      if (envVars.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No environment variables set.',
            },
          ],
        };
      }

      const lines = envVars.map((ev) => `${ev.key}=${ev.value || '****'}`);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Environment variables:\n${lines.join('\n')}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to list env vars: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });
}
