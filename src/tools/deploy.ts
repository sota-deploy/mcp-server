import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SotaClient } from '@sota-io/sdk';
import {
  archiveDirectoryWithReport,
  archiveFromFiles,
  archiveFromGitUrl,
  ArchiveBuilderError,
  MAX_INLINE_FILES,
  MAX_INLINE_TOTAL_BYTES,
  MAX_CLONE_BYTES,
  type InlineFile,
} from '../lib/archive-builder.js';
import {
  type DeploymentLike,
  DEFAULT_WAIT_SECONDS,
  MAX_WAIT_SECONDS,
  RETRY_AFTER_SECONDS,
  progressFrom,
  signalFrom,
  stillRunningHint,
  waitBudgetMs,
  waitForDeployment,
} from '../lib/wait.js';
import { BUSY_RETRY_SECONDS, DEPLOY_UPLOADS } from '../lib/upload-gate.js';
import { deploymentLines } from './status.js';
import { HOSTED_FILES_ONLY_HINT } from '../lib/hosted-guard.js';
import { type AccountReader, LOOKUP_TIMEOUT_MS, settleWithin, tryReadAccount } from '../lib/account.js';
import { projectUrl } from '../lib/project-url.js';
import { enterpriseNextSteps } from './account.js';

export interface DeployToolOptions {
  /**
   * true for the hosted server (mcp.sota.io): only inline `files` are
   * advertised and accepted. A directory deploy there would pack the
   * sota-mcp container's own filesystem into the caller's project, and a
   * server-side git clone would fetch arbitrary URLs from our network.
   * false (default) for the local stdio server: files, git_url, directory.
   */
  hosted?: boolean;
  /**
   * Reads GET /v1/account; when it says Enterprise, the result tells the
   * agent what the human must do before anyone can open the app.
   */
  readAccount?: AccountReader;
  /** Bound for the account and project lookups after the upload (default 3 s). */
  lookupTimeoutMs?: number;
  /** Test hook: pause between two status reads while waiting. */
  pollIntervalMs?: number;
  /** Test hook: bound of one status read. */
  readTimeoutMs?: number;
}

const INTRO = `Deploy an application to sota.io. The platform auto-detects your framework and builds a Docker image automatically:

- Next.js: Detected via next.config.js/ts. Add output: 'standalone' to next.config for optimal builds.
- Node.js: Detected via package.json with a "start" script. Works with Express, Fastify, Koa, Hapi, etc.
- Python: Detected via requirements.txt or pyproject.toml. Works with Flask, FastAPI, Django.
- Custom Dockerfile: If a Dockerfile exists in the project root, it takes priority over auto-detection. Use this for Go, Rust, Java, or any other language. The EXPOSE directive in the Dockerfile is used to detect the app port automatically.`;

const FILES_MODE = `Pass a map of relative paths to file content. A string value is UTF-8
   text; a binary file (PNG, JPEG, ICO, font, PDF) is passed as
   { "content": "<base64>", "encoding": "base64" } (standard base64; invalid
   base64 is rejected with the file's path). Best when you've just generated
   a small app in this conversation and want to deploy it without any
   filesystem step. Up to ${MAX_INLINE_FILES} files and ${MAX_INLINE_TOTAL_BYTES / 1024 / 1024} MB in total, counted after
   base64 decoding. Include the framework manifest (package.json,
   requirements.txt, or Dockerfile) so auto-detection works.`;

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
   no other mode is given. A .sotaignore in that directory is honoured
   (an empty one uploads everything else); without one, its .gitignore is
   used, except that .env.production and .env.example are always kept.
   Without either file, every file except the exclusions below is
   uploaded, so add a .sotaignore before deploying a folder with notes or
   credentials. git_url uploads the tracked files and reads only a
   .sotaignore.`;

const HOSTED_MODES = `Supply the source code as **files** (inline source from AI):
   ${FILES_MODE}

This hosted server only accepts inline files. ${HOSTED_FILES_ONLY_HINT}`;

const OUTRO = `BEFORE the first deploy, call get-account: it says whether this is a sota Enterprise account and returns the full contract. The rules that make a deploy fail:

- Listen on 0.0.0.0 and the PORT environment variable: 8080 for auto-detected frameworks, the EXPOSE port of a Dockerfile.
- Health gate: sota calls GET /health inside the container (GET / when /health answers 404) WITHOUT identity headers; it must answer 2xx or 3xx within 60 seconds, otherwise the deploy fails and the previous version keeps running.
- One container, one web process, no persistent disk (files are lost on every deploy), no second service.
- sota Enterprise: never build a login; read the X-Sota-Access-* headers and fail closed without them, EXCEPT GET /health (200) and GET / (2xx/3xx, no data), which the health gate and the edge check call without identity. An app answering 401 on / is marked down.

The first deploy creates a PostgreSQL 17 database and injects DATABASE_URL (through PgBouncer in transaction mode: no LISTEN/NOTIFY, no session SET or session advisory locks; driver settings such as psycopg prepare_threshold=None, asyncpg statement_cache_size=0, postgres.js prepare: false, pgx default_query_exec_mode=exec, Prisma ?pgbouncer=true are in get-account) plus PGHOST, PGPORT, PGUSER, PGPASSWORD and PGDATABASE. Run migrations at start.

After the upload this tool waits on the server until the deployment is running or failed (wait, default true; at most max_wait_seconds, default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}, so the call stays inside client time limits). If the build takes longer, the result says so: call get-status with wait_for: "finished" (it waits again), do not poll in a loop. On failed, the result shows the reason (the HTTP status the app answered on its health path, or that nothing answered) and get-logs the build log. To apply changed environment variables without new code, use redeploy. Blue-green: the old container keeps serving until the new one passes the health gate. .git/, node_modules/, .DS_Store and the local/secret env files .env, .env.local, .env.*.local and .envrc (any directory, any case) are excluded from the archive; set runtime secrets with set-env instead. .env.production is kept (set-env values are not available at build time): put public build-time values such as NEXT_PUBLIC_* there, never secrets.`;

const FILES_DESCRIPTION =
  `Map of relative file paths to content: a string (UTF-8 text) or { content, encoding: "base64" } for a binary file such as an image. At most ${MAX_INLINE_FILES} files and ${MAX_INLINE_TOTAL_BYTES / 1024 / 1024} MB decoded. Use when generating an app inline (e.g. from a Claude.ai web conversation). Include a framework manifest so auto-detection works.`;

const INLINE_FILE = z.union([
  z.string(),
  z.object({
    content: z.string().describe('File content: UTF-8 text, or base64 when encoding is "base64"'),
    encoding: z.enum(['utf8', 'base64']).optional().describe('"base64" for binary files; default "utf8"'),
  }),
]);
const FILES_SCHEMA = z.record(z.string(), INLINE_FILE);

const WAIT_SCHEMA = {
  wait: z
    .boolean()
    .optional()
    .describe('Wait until the deployment is running or failed (default true, bounded by max_wait_seconds). false returns right after the upload.'),
  max_wait_seconds: z
    .number()
    .int()
    .min(0)
    .max(MAX_WAIT_SECONDS)
    .optional()
    .describe(`Upper bound of the wait, counted from the start of the call (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}).`),
};

interface WaitArgs {
  wait?: boolean;
  max_wait_seconds?: number;
  extra?: unknown;
  startedAt: number;
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export function registerDeployTool(server: McpServer, client: SotaClient, options: DeployToolOptions = {}) {
  if (options.hosted === true) {
    registerHostedDeployTool(server, client, options);
  } else {
    registerLocalDeployTool(server, client, options);
  }
}

async function uploadArchive(
  client: SotaClient,
  projectId: string,
  archive: Buffer,
  modeDescription: string,
  options: DeployToolOptions,
  waitArgs: WaitArgs,
  release: () => void,
  note?: string,
) {
  let deployment: Awaited<ReturnType<SotaClient['deploy']>>;
  try {
    deployment = await client.deploy(projectId, archive);
  } catch (error) {
    return errorResult(`Deploy failed during upload: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    // The archive is no longer needed: the next upload may start.
    release();
  }

  // The app URL and the account facts are looked up in parallel with the
  // wait (each bounded, default 3 s), so they never add to the call's time.
  const timeoutMs = options.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS;
  const projectLookup =
    typeof (client as Partial<SotaClient>).getProject === 'function'
      ? settleWithin(client.getProject(projectId), timeoutMs)
      : Promise.resolve(undefined);
  const accountLookup = tryReadAccount(options.readAccount, timeoutMs);

  const tail: string[] = [];
  if (waitArgs.wait === false) {
    tail.push(
      '',
      `The build runs in the background. Call get-status with wait_for: "finished" and deployment_id ${deployment.id}: it waits on the server until the deployment is running or failed (get-status shows the reason of a failure; get-logs shows the build log).`,
    );
  } else {
    // The budget counts from the start of the tool call (archive and upload
    // took part of it already) and keeps WAIT_HEADROOM_MS in reserve.
    try {
      const waited = await waitForDeployment(client, projectId, deployment.id, {
        maxWaitMs: waitBudgetMs(waitArgs.max_wait_seconds, waitArgs.startedAt),
        intervalMs: options.pollIntervalMs,
        readTimeoutMs: options.readTimeoutMs,
        progress: progressFrom(waitArgs.extra),
        signal: signalFrom(waitArgs.extra),
      });
      const current: DeploymentLike = waited.deployment ?? (deployment as unknown as DeploymentLike);
      tail.push('', ...deploymentLines(current, waited.finished ? 'Result:' : 'Status now:'));
      if (!waited.finished) {
        tail.push('', stillRunningHint(current.status, Date.now() - waitArgs.startedAt), `retry_after_seconds: ${RETRY_AFTER_SECONDS}`);
      } else if (current.status === 'failed') {
        tail.push('', 'get-logs shows the build and deploy log. The previous deployment, if any, keeps running.');
      }
    } catch (error) {
      // The upload worked; only the status read failed.
      tail.push(
        '',
        `The deployment started, but its status could not be read (${error instanceof Error ? error.message : String(error)}). Call get-status with wait_for: "finished" and deployment_id ${deployment.id}.`,
      );
    }
  }

  const [project, account] = await Promise.all([projectLookup, accountLookup]);
  const appUrl = project ? projectUrl(project) : undefined;
  const lines = [
    `Deployment started (${modeDescription}):`,
    `  ID: ${deployment.id}`,
    `  Status: ${deployment.status}`,
    `  App URL: ${appUrl ?? deployment.url ?? 'pending'}`,
  ];
  if (note) lines.push('', note);
  lines.push(...tail);
  if (account?.enterprise) {
    lines.push('', enterpriseNextSteps(account, appUrl));
  }
  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

/** The answer when two uploads are already being packed and sent. */
function busyResult() {
  return errorResult(
    `The MCP server is busy packing and uploading other deploys (at most ${DEPLOY_UPLOADS.limit} at a time). Nothing was uploaded; call deploy again in ${BUSY_RETRY_SECONDS} s.`,
  );
}

function archiveError(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  const code = error instanceof ArchiveBuilderError ? ` [${error.code}]` : '';
  return errorResult(`Deploy failed during archive construction${code}: ${detail}`);
}

/** Hosted (mcp.sota.io): inline files only. */
function registerHostedDeployTool(server: McpServer, client: SotaClient, options: DeployToolOptions) {
  server.registerTool('deploy', {
    description: `${INTRO}\n\n${HOSTED_MODES}\n\n${OUTRO}`,
    inputSchema: {
      project_id: z.string().describe('Project ID (UUID) to deploy to. Use list-projects to find the ID.'),
      files: FILES_SCHEMA.describe(FILES_DESCRIPTION),
      ...WAIT_SCHEMA,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args, extra) => {
    const startedAt = Date.now();
    // Defence in depth: http.ts already rejects directory/git_url before the
    // tool runs, and the schema requires files. Never fall back to a
    // directory (process.cwd() is the sota-mcp container itself).
    const { project_id, files, wait, max_wait_seconds } = args as {
      project_id: string;
      files?: Record<string, InlineFile>;
      wait?: boolean;
      max_wait_seconds?: number;
    };
    if (files === undefined || files === null || typeof files !== 'object') {
      return errorResult(`Error: the hosted server needs \`files\`. ${HOSTED_FILES_ONLY_HINT}`);
    }
    const release = DEPLOY_UPLOADS.tryAcquire();
    if (!release) return busyResult();
    let archive: Buffer;
    try {
      archive = archiveFromFiles(files);
    } catch (error) {
      release();
      return archiveError(error);
    }
    return uploadArchive(client, project_id, archive, `inline files (${Object.keys(files).length} entries)`, options, {
      wait,
      max_wait_seconds,
      extra,
      startedAt,
    }, release);
  });
}

/** Local stdio server (npx @sota-io/mcp): files, git_url or directory. */
function registerLocalDeployTool(server: McpServer, client: SotaClient, options: DeployToolOptions) {
  server.registerTool('deploy', {
    description: `${INTRO}\n\n${LOCAL_MODES}\n\n${OUTRO}`,
    inputSchema: {
      project_id: z.string().describe('Project ID (UUID) to deploy to. Use list-projects to find the ID.'),
      files: FILES_SCHEMA
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
      ...WAIT_SCHEMA,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ project_id, files, git_url, git_branch, directory, wait, max_wait_seconds }, extra) => {
    const startedAt = Date.now();
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

    const release = DEPLOY_UPLOADS.tryAcquire();
    if (!release) return busyResult();
    let archive: Buffer;
    let modeDescription: string;
    let note: string | undefined;
    try {
      if (files !== undefined) {
        archive = archiveFromFiles(files);
        modeDescription = `inline files (${Object.keys(files).length} entries)`;
      } else if (git_url !== undefined) {
        archive = archiveFromGitUrl(git_url, git_branch);
        modeDescription = `git clone (${git_url}${git_branch ? ` @ ${git_branch}` : ''})`;
      } else {
        const dir = directory || process.cwd();
        const packed = archiveDirectoryWithReport(dir);
        archive = packed.archive;
        modeDescription = `directory (${dir}), ${packed.files} files`;
        note = packed.ignoreFile
          ? `Ignore rules: ${packed.ignoreFile}.`
          : 'Ignore rules: none (no .sotaignore or .gitignore in the directory). Every file except .git, node_modules, .DS_Store and local .env files was uploaded. If the folder holds notes, credentials or data that must not leave the machine, add a .sotaignore and deploy again.';
      }
    } catch (error) {
      release();
      return archiveError(error);
    }
    return uploadArchive(client, project_id, archive, modeDescription, options, { wait, max_wait_seconds, extra, startedAt }, release, note);
  });
}
