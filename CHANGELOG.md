# Changelog — @sota-io/mcp

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
