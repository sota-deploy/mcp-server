import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SotaClient } from '@sota-io/sdk';
import {
  archiveFromDirectory,
  archiveFromFiles,
  archiveFromGitUrl,
  ArchiveBuilderError,
  MAX_INLINE_FILES,
  MAX_INLINE_TOTAL_BYTES,
  MAX_CLONE_BYTES,
} from '../lib/archive-builder.js';
import { HOSTED_FILES_ONLY_HINT } from '../lib/hosted-guard.js';

export interface DeployToolOptions {
  /**
   * true for the hosted server (mcp.sota.io): only inline `files` are
   * advertised and accepted. A directory deploy there would pack the
   * sota-mcp container's own filesystem into the caller's project, and a
   * server-side git clone would fetch arbitrary URLs from our network.
   * false (default) for the local stdio server: files, git_url, directory.
   */
  hosted?: boolean;
}

const INTRO = `Deploy an application to sota.io. The platform auto-detects your framework and builds a Docker image automatically:

- Next.js: Detected via next.config.js/ts. Add output: 'standalone' to next.config for optimal builds.
- Node.js: Detected via package.json with a "start" script. Works with Express, Fastify, Koa, Hapi, etc.
- Python: Detected via requirements.txt or pyproject.toml. Works with Flask, FastAPI, Django.
- Custom Dockerfile: If a Dockerfile exists in the project root, it takes priority over auto-detection. Use this for Go, Rust, Java, or any other language. The EXPOSE directive in the Dockerfile is used to detect the app port automatically.`;

const FILES_MODE = `Pass a map of relative paths to UTF-8 text content. Best when you've just
   generated a small app in this conversation and want to deploy it without
   any filesystem step. Up to ${MAX_INLINE_FILES} files, ${MAX_INLINE_TOTAL_BYTES / 1024 / 1024} MB total. Include
   the framework manifest (package.json, requirements.txt, or Dockerfile)
   so auto-detection works.`;

const LOCAL_MODES = `THREE WAYS to supply the source code — pick EXACTLY ONE:

1. **files** (inline source from AI):
   ${FILES_MODE}

2. **git_url** (clone a public repo):
   Pass an https://, git://, ssh://, or git@host:path URL. It is shallow-cloned
   (--depth=1 --single-branch) with the local git and deployed. Optional
   git_branch picks a non-default branch. Only public repos are supported in
   v1. Max ${MAX_CLONE_BYTES / 1024 / 1024} MB after clone.

3. **directory** (local filesystem):
   Pass an absolute path. Defaults to the current working directory when
   no other mode is given.`;

const HOSTED_MODES = `Supply the source code as **files** (inline source from AI):
   ${FILES_MODE}

This hosted server only accepts inline files. ${HOSTED_FILES_ONLY_HINT}`;

const OUTRO = `IMPORTANT: Your app MUST listen on the PORT environment variable. For auto-detected frameworks (Next.js, Node.js, Python) PORT is 8080. For custom Dockerfiles, the port is auto-detected from the EXPOSE directive (e.g. EXPOSE 3000 sets PORT=3000). If no EXPOSE is found, it defaults to 8080.

Every project includes a managed PostgreSQL 17 database. Six environment variables are auto-injected into your container — no manual database configuration needed: DATABASE_URL (full connection string), PGHOST, PGPORT, PGUSER, PGPASSWORD, and PGDATABASE. Libraries that follow libpq conventions (node-postgres, pgx, psycopg2, Django) pick up the PG* variables automatically with no configuration. If your app needs database migrations, run them on startup.

Deployments use blue-green strategy for zero downtime. The old container keeps running until the new one passes health checks (60s timeout). Use get-logs to monitor build progress. .git/, node_modules/, .DS_Store and the local/secret env files .env, .env.local, .env.*.local and .envrc (any directory, any case) are excluded from the archive; set runtime secrets with set-env instead. Committed variants such as .env.production are kept (set-env values are not available at build time).`;

const FILES_DESCRIPTION =
  'Map of relative file paths to UTF-8 text content. Use when generating an app inline (e.g. from a Claude.ai web conversation). Include a framework manifest so auto-detection works.';

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export function registerDeployTool(server: McpServer, client: SotaClient, options: DeployToolOptions = {}) {
  if (options.hosted === true) {
    registerHostedDeployTool(server, client);
  } else {
    registerLocalDeployTool(server, client);
  }
}

async function uploadArchive(client: SotaClient, projectId: string, archive: Buffer, modeDescription: string) {
  try {
    const deployment = await client.deploy(projectId, archive);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Deployment started (${modeDescription}):\n  ID: ${deployment.id}\n  Status: ${deployment.status}\n  URL: ${deployment.url || 'pending'}\n\nUse get-logs to check build progress.`,
        },
      ],
    };
  } catch (error) {
    return errorResult(`Deploy failed during upload: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function archiveError(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  const code = error instanceof ArchiveBuilderError ? ` [${error.code}]` : '';
  return errorResult(`Deploy failed during archive construction${code}: ${detail}`);
}

/** Hosted (mcp.sota.io): inline files only. */
function registerHostedDeployTool(server: McpServer, client: SotaClient) {
  server.registerTool('deploy', {
    description: `${INTRO}\n\n${HOSTED_MODES}\n\n${OUTRO}`,
    inputSchema: {
      project_id: z.string().describe('Project ID (UUID) to deploy to. Use list-projects to find the ID.'),
      files: z.record(z.string(), z.string()).describe(FILES_DESCRIPTION),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args) => {
    // Defence in depth: http.ts already rejects directory/git_url before the
    // tool runs, and the schema requires files. Never fall back to a
    // directory (process.cwd() is the sota-mcp container itself).
    const { project_id, files } = args as { project_id: string; files?: Record<string, string> };
    if (files === undefined || files === null || typeof files !== 'object') {
      return errorResult(`Error: the hosted server needs \`files\`. ${HOSTED_FILES_ONLY_HINT}`);
    }
    let archive: Buffer;
    try {
      archive = archiveFromFiles(files);
    } catch (error) {
      return archiveError(error);
    }
    return uploadArchive(client, project_id, archive, `inline files (${Object.keys(files).length} entries)`);
  });
}

/** Local stdio server (npx @sota-io/mcp): files, git_url or directory. */
function registerLocalDeployTool(server: McpServer, client: SotaClient) {
  server.registerTool('deploy', {
    description: `${INTRO}\n\n${LOCAL_MODES}\n\n${OUTRO}`,
    inputSchema: {
      project_id: z.string().describe('Project ID (UUID) to deploy to. Use list-projects to find the ID.'),
      files: z
        .record(z.string(), z.string())
        .optional()
        .describe(`${FILES_DESCRIPTION} Mutually exclusive with git_url and directory.`),
      git_url: z
        .string()
        .optional()
        .describe(
          'Public git repository URL to clone (https://, git://, ssh://, or git@host:path). Mutually exclusive with files and directory.',
        ),
      git_branch: z
        .string()
        .optional()
        .describe('Optional branch name when using git_url. Defaults to the repository default branch.'),
      directory: z
        .string()
        .optional()
        .describe(
          'Absolute path to a local directory. Defaults to the current working directory when no other mode is given. Mutually exclusive with files and git_url.',
        ),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ project_id, files, git_url, git_branch, directory }) => {
    // Mutual-exclusivity check: at most one mode set. When zero are set we
    // fall back to directory mode with cwd (legacy CLI behaviour).
    const modesSet = [files !== undefined, git_url !== undefined, directory !== undefined].filter(Boolean).length;
    if (modesSet > 1) {
      return errorResult(
        'Error: deploy accepts exactly one of `files`, `git_url`, or `directory`. Pick the mode that matches your environment (files for inline AI-generated code, git_url for a public repo, directory for a local path).',
      );
    }
    if (git_branch && !git_url) {
      return errorResult('Error: `git_branch` only makes sense together with `git_url`.');
    }

    let archive: Buffer;
    let modeDescription: string;
    try {
      if (files !== undefined) {
        archive = archiveFromFiles(files);
        modeDescription = `inline files (${Object.keys(files).length} entries)`;
      } else if (git_url !== undefined) {
        archive = archiveFromGitUrl(git_url, git_branch);
        modeDescription = `git clone (${git_url}${git_branch ? ` @ ${git_branch}` : ''})`;
      } else {
        const dir = directory || process.cwd();
        archive = archiveFromDirectory(dir);
        modeDescription = `directory (${dir})`;
      }
    } catch (error) {
      return archiveError(error);
    }
    return uploadArchive(client, project_id, archive, modeDescription);
  });
}
