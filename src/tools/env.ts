import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SotaClient } from '@sota-io/sdk';

/** Variables sota sets itself for the managed database. */
export const MANAGED_ENV_KEYS: ReadonlySet<string> = new Set([
  'DATABASE_URL',
  'DATABASE_DIRECT_URL',
  'PGHOST',
  'PGPORT',
  'PGUSER',
  'PGPASSWORD',
  'PGDATABASE',
]);

/** Shortest value whose first characters are shown in a masked listing. */
export const MASK_PREFIX_MIN_LENGTH = 20;
export const MASK_PREFIX_CHARS = 4;

/**
 * A masked value: the first 4 characters (only for values of at least 20
 * characters, so a short secret is not half revealed, and never for the
 * managed database values, which hold the database password) and the length.
 */
export function maskValue(value: string | undefined | null, showPrefix = true): string {
  const v = value ?? '';
  if (v.length === 0) return '(empty)';
  const chars = [...v];
  const prefix = showPrefix && chars.length >= MASK_PREFIX_MIN_LENGTH ? chars.slice(0, MASK_PREFIX_CHARS).join('') : '';
  return `${prefix}… (${chars.length} chars)`;
}

/**
 * Which listed variables are managed by sota. current sota-api versions
 * marks them itself (`managed: true`, only while the database exists; the
 * field is left out when false). When no entry carries the flag (an older
 * API, or no managed variable at all) the known names count as managed,
 * which errs on the side of masking.
 */
export function managedKeys(envVars: ReadonlyArray<{ key: string; managed?: boolean }>): Set<string> {
  const flagged = envVars.filter((e) => e.managed === true).map((e) => e.key);
  if (flagged.length > 0) return new Set(flagged);
  return new Set(envVars.filter((e) => MANAGED_ENV_KEYS.has(e.key)).map((e) => e.key));
}

export function registerEnvTools(server: McpServer, client: SotaClient) {
  server.registerTool('set-env', {
    description: 'Set an environment variable for a project. Variables are encrypted at rest (AES-256-GCM) and injected at container runtime. NOTE: DATABASE_URL, PGHOST, PGPORT, PGUSER, PGPASSWORD, and PGDATABASE are all auto-injected for the managed PostgreSQL database — you do NOT need to set any of them manually. The PORT variable is auto-managed: 8080 for auto-detected frameworks (Next.js, Node.js, Python), or auto-detected from the Dockerfile EXPOSE directive for custom Dockerfile builds. IMPORTANT: Changing env vars does NOT restart the app: call redeploy (same image, new env, no build) or deploy (new code) to apply them. Values set here are only available at runtime, never at build time: build-time values such as Next.js NEXT_PUBLIC_* belong in a committed file such as .env.production. On a sota Enterprise account do not set login or session secrets for your own sign-in: sota Access does the sign-in.',
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
            text: `Environment variable ${key} set. The running app does not see it yet: call redeploy (project_id ${project_id}) to restart it with the new value, or deploy when you also changed code.`,
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
    description: 'List the environment variables of a project: names with masked values (the first 4 characters of values with at least 20 characters, and the length); variables sota manages for the database (DATABASE_URL, PG*) are marked "managed" and show only their length. PORT is set by sota at runtime and not listed. To see one value in clear, pass its key with reveal: true; a managed database value (it holds the database password) also needs include_managed: true. Values are often secrets (API keys, the database password): do not reveal them into the conversation unless the user asks for that value; to check that a variable is set, the masked listing is enough. The masking keeps secrets out of the conversation; it is not access control: whoever holds this connection or API key can read every value.',
    inputSchema: {
      project_id: z.string().describe('Project ID (UUID)'),
      key: z.string().optional().describe('Only this variable.'),
      reveal: z
        .boolean()
        .optional()
        .describe('With key: return that one value in clear. Only when the user asked for the value.'),
      include_managed: z
        .boolean()
        .optional()
        .describe('With reveal: also reveal a managed database value (DATABASE_URL, PG*). Only when the user explicitly asked for that value.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ project_id, key, reveal, include_managed }) => {
    if (reveal === true && !key) {
      return {
        content: [{ type: 'text' as const, text: 'reveal: true needs a single key: pass the name of the one variable to show in clear.' }],
        isError: true,
      };
    }
    try {
      const envVars = await client.listEnvVars(project_id);
      if (key) {
        const ev = envVars.find((e) => e.key === key);
        if (!ev) {
          return {
            content: [{ type: 'text' as const, text: `No environment variable ${key} on this project.` }],
            isError: true,
          };
        }
        const isManaged = managedKeys(envVars).has(ev.key);
        const managed = isManaged ? ' (managed)' : '';
        if (reveal === true && managed && include_managed !== true) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `${ev.key} is managed by sota and holds database credentials: it is not revealed without include_managed: true. Reveal it only when the user explicitly asked for this value; the app gets it injected at runtime anyway. ${ev.key}=${maskValue(ev.value, false)} (managed)`,
              },
            ],
            isError: true,
          };
        }
        const value = reveal === true ? (ev.value ?? '') : maskValue(ev.value, !isManaged);
        return { content: [{ type: 'text' as const, text: `${ev.key}=${value}${managed}` }] };
      }
      if (envVars.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No environment variables set.' }] };
      }
      const managedSet = managedKeys(envVars);
      const lines = envVars.map((ev) => {
        const managed = managedSet.has(ev.key);
        return `${ev.key}=${maskValue(ev.value, !managed)}${managed ? ' (managed)' : ''}`;
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: `Environment variables (values masked; get-env with key and reveal: true shows one value, only when the user asks):\n${lines.join('\n')}`,
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
