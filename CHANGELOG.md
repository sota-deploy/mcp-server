# Changelog — @sota-io/mcp

## 1.8.0 — 2026-11-26

- New source tools for projects whose source sota keeps (needs sota-api with source storage; storage is off unless it is switched on for the project, then a tool answers `source_storage_off`): `get-project-guide`, `list-source`, `read-source`, `search-source`, `get-changes` (read only), `edit-source`, `write-source`, `discard-changes` (a server-side working copy on top of the running deployment) and `deploy-changes` (builds the working copy through the normal build queue and health gate; the previous version keeps serving and `rollback` works as before). Secret-looking files (`.env*`, private keys and the like) are listed but never returned. File content comes back wrapped as data, not instructions.

- **Behaviour change: `get-env` masks values.** It lists names with masked values (the first 4 characters of values with 20 or more characters, plus the length); the variables sota manages for the database (`DATABASE_URL`, `PG*`) are marked `managed` and show only their length. One value comes back in clear only with `key` and `reveal: true` (a managed database value also needs `include_managed: true`), and the tool tells the agent not to reveal secrets into the conversation unless the user asks. Before, every value (API keys, the database password) came back in clear and ended up in the chat transcript. The API and the dashboard are unchanged. Masking keeps secrets out of the conversation; it is not access control: whoever holds the connection or API key can read every value.
- New tool `redeploy`: starts the running image again with the current environment variables, without a build (`POST /v1/projects/{id}/redeploy`), blue-green behind the health gate; an Enterprise app stays on its own server behind the sign-in. `set-env` now says that a redeploy applies the change.
- **Waiting instead of polling.** `deploy` and `redeploy` wait on the server for the result (`wait`, default true; `max_wait_seconds`, default 40, at most 50, so a call stays inside the 60-second default request timeout of MCP clients). `get-status` takes `wait_for: "finished"` (plus `deployment_id`, `max_wait_seconds`) and waits the same way; an early return says "not finished" with `retry_after_seconds`. Progress notifications are sent while waiting when the client asks for them. One test run needed 27 `get-status` calls for one deploy. **`deploy` now waits by default**: a client whose tool-call timeout is under 40 s should pass `wait: false` (returns right after the upload, as before) or a smaller `max_wait_seconds`; the wait stops 5 s before `max_wait_seconds` and every status read is bounded, so a call ends within the requested time.
- Binary files in inline deploys: a `files` entry can be `{ "content": "<base64>", "encoding": "base64" }` (images, fonts, PDFs), also through the hosted connector. Limits count decoded bytes (200 files, 10 MB); invalid base64 is refused with the file's path. The hosted server accepts request bodies up to 16 MB only for POST /mcp with a credential that checks out before the body is read (a sota_ key of the right shape or a JWT that verifies), and reads at most two such bodies at a time; everything else, including anonymous discovery calls, is limited to 64 KB and gets 413 above it. At most two deploys are packed and uploaded at the same time per server; the next one gets a "busy, retry in 15 s" result. Two entries naming the same file (`a`, `./a`) are refused.
- Failed health checks name what the app answered (needs sota-api with the matching change): for example `last probe: GET /health answered HTTP 500`, `connection refused`, `no answer within 5 s`, or `the container exited with code 1`. No response bodies.
- Contract (`get-account`, the checklist prompt, server instructions, docs): users are keyed on `X-Sota-Access-User-Id`, the e-mail is for display; a recommended roles pattern (a roles table keyed by user id, first admin seeded from `ADMIN_EMAILS`); PgBouncer driver settings tested against the platform's PgBouncer (psycopg 3, asyncpg, SQLAlchemy, node-postgres, postgres.js, pgx, Prisma); access changes reach the sign-in within about 15 seconds.

## 1.7.1 — 2026-11-25

- **`npx -y @sota-io/mcp` starts the server.** npx runs the executable named after the unscoped package name (`mcp`), and no published version (1.0.0 to 1.7.0) had one, so the documented command stopped with "could not determine executable to run". The package now has a bin entry `mcp` that runs the stdio server (same file as `sota-mcp`); `sota-mcp` and `sota-mcp-http` stay. With 1.0.0 to 1.7.0 use the long form `npx -y -p @sota-io/mcp@<version> sota-mcp`.
- A global install (`npm install -g @sota-io/mcp`) now also puts a command called `mcp` on the PATH. It can shadow another tool named `mcp`; `sota-mcp` remains the unambiguous name.
- A test fails when no bin entry matches the unscoped package name, or when a bin target is missing its shebang.
- Hosted server: the default list of accepted JWT issuers (used only when `SUPABASE_JWT_ISSUERS` is unset) is now `https://auth.sota.io/auth/v1` alone; the issuer of the former hosted auth project is no longer accepted by default.
- Housekeeping in the published sources: internal planning references, a private network address and a former test project id removed from comments and tests.

## 1.7.0 — 2026-11-25

- New tool `get-account` (read-only): plan limits, whether the account is a sota Enterprise account (company label, app address `https://<app>.<label>.sota.io`, app count, sign-in connection status, link to Users & access) and the build contract every app must follow. Needs sota-api with `GET /v1/account`; against an older API it returns the contract without account facts.
- Server instructions on connect, and the prompt `enterprise-app-checklist`, state the same contract: one container, `PORT`, the health gate without identity headers, the database through PgBouncer in transaction mode, uploads, and for Enterprise the identity headers, fail-closed rule and who can open the app.
- `create-project` and `deploy` results name the app URL at once and, on an Enterprise account, what the owner must do before anyone can open the app.
- `get-status` shows the reason of a failed deployment (it read a field the API never sent) and a hint for health-check failures.
- **Possibly breaking: upload selection.** Directory deploys honour a `.sotaignore` in the root, or, without one, the `.gitignore` (CLI pattern rules). In the `.gitignore` fallback `.env.production` and `.env.example` are always kept, because create-next-app's `.gitignore` lists `.env*` and public build-time values such as `NEXT_PUBLIC_*` live there; a `.sotaignore` that names them drops them. An empty `.sotaignore` turns the `.gitignore` fallback off. Before, the local server uploaded files the CLI would have skipped, such as untracked notes listed in `.gitignore`. `git_url` deploys read only a `.sotaignore`: tracked files that match the `.gitignore` (committed build output) still deploy. The deploy result says which file was used and how many files were packed.
- Always left out now, as in the CLI: `.sota.json`, `__pycache__`, `.venv` and `*.log` (next to `.git`, `node_modules`, `.DS_Store` and the local `.env` files). The CLI's `vendor/` and `.env.*` are not copied: vendored dependencies are needed for builds, committed `.env.production` carries public build-time values.
- The account and project lookups that add the app URL and the Enterprise next steps to `deploy` and `create-project` results give up after 3 seconds; the result never waits for or fails on them.
- Tool texts corrected: the database is created on the first deploy, not at project creation; `set-env` values are not available at build time; `get-logs` has no runtime logs.

## 1.6.0 — 2026-11-18

- Deploy packs the source with an explicit file list, so the result is the same on GNU tar, bsdtar (macOS, Windows) and BusyBox tar (Alpine). On BusyBox the deploy used to fail with "unrecognized option: null".
- Local and secret env files (`.env`, `.env.local`, `.env.*.local`, `.envrc`) are never part of an upload, at any depth and in every mode. `.git`, `node_modules` and `.DS_Store` stay out as before.
- Clearer errors when packing fails (`tar_failed` with tar's own message).
- The hosted server (mcp.sota.io) accepts inline `files` only; `directory` and `git_url` are modes of the local server (`npx @sota-io/mcp`).
- The server reports its real package version, and `/health` on the hosted server reports commit and build time.
- No e-mail addresses in server logs.

## 1.5.0 — 2026-05-19

- Deploy from inline `files` or a `git_url`, next to the directory mode.
