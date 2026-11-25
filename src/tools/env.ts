import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SotaClient } from '@sota-io/sdk';

export function registerEnvTools(server: McpServer, client: SotaClient) {
  server.registerTool('set-env', {
    description: 'Set an environment variable for a project. Variables are encrypted at rest (AES-256-GCM) and injected at container runtime. NOTE: DATABASE_URL, PGHOST, PGPORT, PGUSER, PGPASSWORD, and PGDATABASE are all auto-injected for the managed PostgreSQL database — you do NOT need to set any of them manually. The PORT variable is auto-managed: 8080 for auto-detected frameworks (Next.js, Node.js, Python), or auto-detected from the Dockerfile EXPOSE directive for custom Dockerfile builds. IMPORTANT: Changing env vars does NOT auto-redeploy: call deploy again to apply them. Values set here are only available at runtime, never at build time: build-time values such as Next.js NEXT_PUBLIC_* belong in a committed file such as .env.production. On a sota Enterprise account do not set login or session secrets for your own sign-in: sota Access does the sign-in.',
    inputSchema: {
      project_id: z.string().describe('Project ID (UUID)'),
      key: z.string().describe('Environment variable name (e.g., REDIS_URL, API_SECRET). Do NOT set DATABASE_URL — it is auto-managed'),
      value: z.string().describe('Environment variable value. Will be encrypted at rest'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ project_id, key, value }) => {
    try {
      await client.setEnvVar(project_id, { key, value });
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
    description: 'List environment variables for a project. Values are masked for security. Auto-injected variables (DATABASE_URL, PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, PORT) may not appear in this list but are always available in the container at runtime.',
    inputSchema: {
      project_id: z.string().describe('Project ID (UUID)'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
