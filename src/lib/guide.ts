/**
 * The build and identity contract an agent must follow on sota.io, in one
 * place. The server instructions, the tool
 * descriptions, the get-account tool, the enterprise-app-checklist prompt and
 * the docs page web/src/app/docs/enterprise/build-with-ai/page.mdx all state
 * it with these exact lines; test/guide.test.mjs fails when the docs page and
 * this file drift apart.
 *
 * Every line is Markdown and keeps anything in angle brackets inside
 * backticks, so the same text renders in MDX.
 */

/** Rules for every sota app (Enterprise or not). */
export const BUILD_CONTRACT: readonly string[] = [
  'One project runs one container with one web process. There is no second service, no worker container and no persistent disk: files written inside the container are lost on every deploy, so keep state in the database.',
  'Build: a `Dockerfile` in the project root wins. Without one, sota accepts Node.js (a `package.json`; Next.js when there is a `next.config.*`) and Python (`requirements.txt` or `pyproject.toml`) and builds them with railpack. Any other language needs a `Dockerfile`.',
  'Listen on `0.0.0.0` and the port in the `PORT` environment variable: 8080 for detected frameworks, the `EXPOSE` port of a Dockerfile.',
  'Health gate: after the build, sota calls `GET /health` inside the container, and `GET /` when `/health` answers 404, without any identity headers. It must answer 2xx or 3xx within 60 seconds, or the deploy fails and the previous version keeps running.',
  'Database: the first deploy creates a PostgreSQL 17 database and injects `DATABASE_URL` plus `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` and `PGDATABASE`. `DATABASE_URL` goes through PgBouncer in transaction mode: no `LISTEN`/`NOTIFY`, no session state (`SET`, session advisory locks, temporary tables) and no named prepared statements (Prisma: add `?pgbouncer=true`). Run migrations at start, make them safe to run twice and keep them backwards compatible: during a deploy the previous version keeps serving on the same database until the new one passes the health gate.',
  'Settings and secrets: `set-env`, then deploy again. They are only available at runtime, never at build time. Public build-time values such as `NEXT_PUBLIC_*` belong in `.env.production`; secrets never go into an uploaded file.',
  'Uploads from a folder (local MCP server): `.git`, `node_modules`, `.DS_Store`, `.sota.json`, `__pycache__`, `.venv`, `*.log` and the local env files `.env`, `.env.local`, `.env.*.local` and `.envrc` are always left out. A `.sotaignore` in the root is used when it exists (an empty one uploads everything else); otherwise the `.gitignore` is used, but `.env.production` and `.env.example` are uploaded even when it lists them. Add a `.sotaignore` before deploying a folder that holds notes, credentials or data that must not leave the machine. A `git_url` deploy uploads the tracked files and reads only a `.sotaignore`. The hosted connector takes inline files only: at most 200 files and 10 MB.',
  'Logs: `get-logs` shows the build and deploy log; when a deploy fails, `get-status` shows the reason. Logs of the running app are not available yet.',
];

/** Extra rules for an app on a sota Enterprise account. */
export const ENTERPRISE_CONTRACT: readonly string[] = [
  'Address: a project named `app` gets the slug `<label>-app` and the one URL `https://app.<label>.sota.io`. There is no `<slug>.sota.io` address.',
  'Sign-in: sota Access signs people in with the company\'s Microsoft 365 on every path before a request reaches the app. Do not build a login, sign-up, password reset or session handling.',
  'Identity: every signed-in request carries `X-Sota-Access-User-Id` (a stable UUID: use it as the user key), `X-Sota-Access-Email` (lower-case it before comparing; it can be the tenant sign-in name such as `name@company.onmicrosoft.com` instead of the mailbox) and `X-Sota-Access-Name` (display only). The headers carry no role: keep roles in the app\'s own database.',
  'Fail closed: every route that shows or changes data answers 401 when `X-Sota-Access-User-Id` is missing. Only `GET /health` and `GET /` answer without it, and they show no data.',
  'Health without identity: the health gate and the edge\'s check of `GET /` (every 30 seconds, redirects not followed) send no identity headers. `GET /health` must answer 200 and `GET /` 2xx or 3xx without them, for example a short "not signed in" page or a redirect. An app that answers 401 on `/` is marked down and nobody can open it.',
  'Sign out: link to `/.sota/access/logout`. Paths under `/.sota/` belong to sota Access.',
  'No public paths yet: webhooks, API clients and scripts without a browser cannot reach the app, and `POST`, `PUT`, `PATCH` or `DELETE` requests from other websites are refused.',
  'Apps of the same account run on the same server. A direct call from one app to another skips the sign-in, and the caller can set any identity header: never treat such a call as a signed-in user, and authenticate app-to-app calls with your own shared secret.',
  'Local development: the headers are missing on your machine. Use a fixed test user behind a development-only switch that is off in the deployed app.',
];

/** What the owner does after a deploy, before anyone can open the app. */
export const ENTERPRISE_ACCESS_STEPS: readonly string[] = [
  'Nobody can open a new app yet, the owner included.',
  'The person opens the app URL once and signs in with Microsoft 365. This creates an access request.',
  'The account owner signs in to the sota dashboard, opens Users & access, approves the person and ticks this app.',
  'The person reloads the app. People approved earlier also need this app ticked.',
  'API keys and MCP cannot approve people or change grants: tell the human what to do instead.',
];

export const DOCS = {
  buildWithAi: 'https://sota.io/docs/enterprise/build-with-ai',
  identity: 'https://sota.io/docs/enterprise/app-identity',
  limits: 'https://sota.io/docs/enterprise/limits',
  mcpTools: 'https://sota.io/docs/mcp/tools',
} as const;

/**
 * Server instructions (MCP `initialize`). Short on purpose: clients put them
 * into the agent's context; the details come from get-account.
 */
export const SERVER_INSTRUCTIONS = [
  'sota.io deploys web apps (EU, Germany). Before you write or deploy code for the user, call get-account once: it says whether the account is a sota Enterprise account and returns the build contract the app must follow.',
  'Every app: one container, one web process, listen on the PORT env var, answer GET /health (or GET /) with 2xx/3xx within 60 s, no persistent disk, DATABASE_URL via PgBouncer in transaction mode.',
  'Enterprise accounts: the company sign-in sits in front of every path, so never build a login; read the X-Sota-Access-* headers, fail closed without them except on GET /health and GET /, which must answer without identity. After a deploy nobody can open the app until the owner approves people and ticks the app under Users & access in the dashboard; MCP cannot do that, so tell the human.',
  'deploy starts a build and returns at once: poll get-status until the deployment is running or failed.',
].join('\n\n');

export function bullets(lines: readonly string[]): string {
  return lines.map((l) => `- ${l}`).join('\n');
}

export function numbered(lines: readonly string[]): string {
  return lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
}

/** The Enterprise checklist (prompt + get-account), account-independent. */
export function enterpriseChecklist(): string {
  return [
    '# Enterprise app checklist (sota.io)',
    '',
    '## Every sota app',
    bullets(BUILD_CONTRACT),
    '',
    '## On a sota Enterprise account',
    bullets(ENTERPRISE_CONTRACT),
    '',
    '## After the deploy: who can open the app',
    numbered(ENTERPRISE_ACCESS_STEPS),
    '',
    `Docs: ${DOCS.buildWithAi}`,
  ].join('\n');
}
