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
  'Database: the first deploy creates a PostgreSQL 17 database and injects `DATABASE_URL` plus `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` and `PGDATABASE`. Run migrations at start, make them safe to run twice and keep them backwards compatible: during a deploy the previous version keeps serving on the same database until the new one passes the health gate.',
  'PgBouncer: `DATABASE_URL` goes through PgBouncer in transaction mode, so each transaction may run on another server connection. These do not work through it: `LISTEN`/`NOTIFY` (notifications never arrive), session `SET` (it is lost and leaks to other clients: use `SET LOCAL` inside a transaction) and session advisory locks (use `pg_advisory_xact_lock` inside a transaction). Driver settings that stay correct with it: psycopg 3 `prepare_threshold=None`; asyncpg `statement_cache_size=0`; SQLAlchemy with psycopg `connect_args={"prepare_threshold": None}`, with asyncpg `connect_args={"statement_cache_size": 0}`; node-postgres as it is, without named queries (`{ name: ... }`); postgres.js `prepare: false`; Go pgx `default_query_exec_mode=exec` in the connection string, never `describe_exec`; Prisma `?pgbouncer=true`.',
  'Settings and secrets: `set-env`, then `redeploy` (the running image again with the new values, no build) or a deploy of new code; a running app does not see a change before that. They are only available at runtime, never at build time. Public build-time values such as `NEXT_PUBLIC_*` belong in `.env.production`; secrets never go into an uploaded file. `get-env` shows values masked; do not reveal a secret into the conversation unless the user asks for it.',
  'Uploads from a folder (local MCP server): `.git`, `node_modules`, `.DS_Store`, `.sota.json`, `__pycache__`, `.venv`, `*.log` and the local env files `.env`, `.env.local`, `.env.*.local` and `.envrc` are always left out. A `.sotaignore` in the root is used when it exists (an empty one uploads everything else); otherwise the `.gitignore` is used, but `.env.production` and `.env.example` are uploaded even when it lists them. Add a `.sotaignore` before deploying a folder that holds notes, credentials or data that must not leave the machine. A `git_url` deploy uploads the tracked files and reads only a `.sotaignore`. Inline files (the only mode of the hosted connector): at most 200 files and 10 MB after decoding; text as a string, binary files such as images as `{ "content": "<base64>", "encoding": "base64" }`.',
  'Waiting and logs: `deploy` and `redeploy` wait on the server for the result (40 seconds by default, at most 50); when the result says the deployment is still running, call `get-status` with `wait_for: "finished"`, which waits again, instead of polling. A failed deploy names the HTTP status the app answered on its health path, or that nothing answered. `get-logs` shows the build and deploy log. Logs of the running app are not available yet.',
];

/** Extra rules for an app on a sota Enterprise account. */
export const ENTERPRISE_CONTRACT: readonly string[] = [
  'Address: a project named `app` gets the slug `<label>-app` and the one URL `https://app.<label>.sota.io`. There is no `<slug>.sota.io` address.',
  'Sign-in: sota Access signs people in with the company\'s Microsoft 365 on every path before a request reaches the app. Do not build a login, sign-up, password reset or session handling.',
  'Identity: every signed-in request carries `X-Sota-Access-User-Id`, a stable UUID: key everything per user on it (stored rows, owners, roles, audit entries). `X-Sota-Access-Email` and `X-Sota-Access-Name` are for display: the e-mail can be the tenant sign-in name such as `name@company.onmicrosoft.com` instead of the mailbox, and it can change. Never use the e-mail as a key.',
  'Roles: the headers carry no role. Store roles in a table in the app\'s own database keyed by the user id, for example `user_roles (user_id uuid primary key, role text not null)`, and check them by user id only. The e-mail is not a trust anchor: it can change, it can be the tenant sign-in name, and an address can later belong to someone else. Bootstrap the first admin once: while the table holds no admin, the first person whose lower-cased `X-Sota-Access-Email` is listed in an environment variable such as `ADMIN_EMAILS` becomes admin, stored under their user id; then clear the variable (`set-env` with an empty value, then `redeploy`). Further admins are appointed inside the app by an existing admin. Never trust a role sent by the browser (header, cookie, query parameter or form field), and never hard-code e-mail addresses or user ids in the code.',
  'Fail closed: every route that shows or changes data answers 401 when `X-Sota-Access-User-Id` is missing. Only `GET /health` and `GET /` answer without it, and they show no data.',
  'Health without identity: the health gate and the edge\'s check of `GET /` (every 30 seconds, redirects not followed) send no identity headers. `GET /health` must answer 200 and `GET /` 2xx or 3xx without them, for example a short "not signed in" page or a redirect. An app that answers 401 on `/` is marked down and nobody can open it.',
  'Sign out: link to `/.sota/access/logout`. Paths under `/.sota/` belong to sota Access.',
  'No public paths yet: webhooks, API clients and scripts without a browser cannot reach the app, and `POST`, `PUT`, `PATCH` or `DELETE` requests from other websites are refused.',
  'Calls between apps: the platform does not support them. The names of other apps do not resolve inside an app. A direct call to another app by its address is unsupported, skips the sign-in and can carry any identity header, so never treat such a call as a signed-in user. Apps that need the same code get it built into each app; apps that need each other\'s data belong in one app.',
  'Local development: the headers are missing on your machine. Use a fixed test user behind a development-only switch that is off in the deployed app.',
  'Team: the owner invites colleagues (dashboard → Team) as developer or admin. They accept the invitation in the dashboard and then work with their own sign-in, in the dashboard and in this connector (for the local MCP server or the CLI they create a team key in the dashboard; their other API keys do not act on shared apps); get-account then names the account and their role, and list-projects shows the apps shared with them. Developers and admins deploy, roll back, redeploy, read logs and source, set env vars and use the database; they cannot delete apps, delete databases or change domains. Admins also create new apps in the account up to its app limit (create-project; the app belongs to the account, only the owner deletes it) and manage Users & access and developers in the dashboard; developers cannot create apps. A new app is visible at once to admins, to developers with all apps and to app users with "All apps"; everyone else gets it ticked.',
];

/** What the owner does after a deploy, before anyone can open the app. */
export const ENTERPRISE_ACCESS_STEPS: readonly string[] = [
  'A new app opens right away only for people approved with "All apps, including new ones" in Users & access; nobody else can open it yet, the owner included.',
  'The person opens the app URL once and signs in with Microsoft 365. This creates an access request.',
  'The account owner signs in to the sota dashboard, opens Users & access, approves the person and ticks this app.',
  'The person reloads the app. People approved earlier also need this app ticked.',
  'While sota is reachable, changes in Users & access reach the sign-in within about 15 seconds (the sign-in gateway refreshes its access list every 15 seconds), in both directions: a restored grant opens the app on the next reload, a removed grant or a block ends access also in an open session. If the gateway cannot refresh, it keeps its last list until it can.',
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
  'Enterprise accounts: the company sign-in sits in front of every path, so never build a login; key users on X-Sota-Access-User-Id (the e-mail is for display), keep roles in the app database keyed by that id, fail closed without the headers except on GET /health and GET /, which must answer without identity. After a deploy only approved people with "All apps" can open the app; everyone else needs the owner or an admin to approve them and tick the app under Users & access in the dashboard; MCP cannot do that, so tell the human.',
  'deploy and redeploy wait for the result (bounded); if a result says the deployment is still running, call get-status with wait_for "finished" instead of polling. After set-env, call redeploy to apply it. get-env masks values: reveal one only when the user asks.',
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
