# sota.io MCP Server — AI Agent Context

This file provides AI agents with context about the sota.io platform when using the MCP server.

## Platform Overview

sota.io is an EU-native DevOps PaaS. Deploy any web app and get a live URL at `{slug}.sota.io`.

## Every Project Includes

- **Managed PostgreSQL 17** — `DATABASE_URL` is auto-injected into your container. No setup needed.
- **PgBouncer connection pooling** — Pool size 20, max 100 client connections.
- **Daily database backups** — 7-day retention, automatic.
- **Automatic HTTPS** — Let's Encrypt wildcard certificate.
- **Zero-downtime deploys** — Blue-green strategy with instant rollback.
- **Container isolation** — gVisor sandboxing.
- **EU hosting** — Hetzner Cloud, Germany. GDPR-compliant.

## Supported Frameworks

| Framework | Detection | Notes |
|-----------|-----------|-------|
| Next.js | `next.config.js/ts` | Add `output: 'standalone'` for best results |
| Node.js | `package.json` with `start` script | Express, Fastify, Koa, Hapi, etc. |
| Python | `requirements.txt` or `pyproject.toml` | Flask, FastAPI, Django |
| Custom | `Dockerfile` in project root | Go, Rust, Java, Ruby, PHP, anything. Port auto-detected from EXPOSE directive. |

**Your app MUST listen on `process.env.PORT`.** For auto-detected frameworks (Next.js, Node.js, Python), PORT is 8080. For custom Dockerfiles, the port is auto-detected from the `EXPOSE` directive (e.g., `EXPOSE 3000` sets `PORT=3000`). If no EXPOSE is found, it defaults to 8080.

## Database — How It Works

1. Create a project.
2. Deploy your app → the first deploy creates the PostgreSQL 17 database and injects `DATABASE_URL` into the container.
3. Your app reads `DATABASE_URL` from the environment — that's it.

You do NOT need to:
- Set `DATABASE_URL` manually
- Provision a database
- Configure connection strings
- Set up SSL for the database (internal network, sslmode=disable is safe)

If your app needs tables, run migrations on startup — there is no shell access to containers. Chain the migration command before your server start:

- **Prisma**: Use `npx prisma db push && node server.js` as your start script. Note: use `db push` (not `migrate deploy`) because PgBouncer transaction mode blocks advisory locks. Add `?pgbouncer=true` to DATABASE_URL in your Prisma schema.
- **Drizzle**: `npx drizzle-kit push && node server.js` — applies schema changes without migration files, works with PgBouncer.
- **TypeORM**: `npx typeorm migration:run -d dist/data-source.js && node dist/server.js`
- **Sequelize**: `npx sequelize-cli db:migrate && node server.js`
- **Knex**: `npx knex migrate:latest && node server.js`
- **Django**: `python manage.py migrate --noinput && gunicorn myproject.wsgi --bind 0.0.0.0:$PORT`
- **Alembic**: `alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port $PORT`

Full migration guide: https://sota.io/docs/guides/postgresql

## Environment Variables

- `PORT` — Auto-injected. 8080 for auto-detected frameworks, or from Dockerfile EXPOSE for custom builds. Do not override.
- `DATABASE_URL` — PostgreSQL connection string (auto-injected).
- Custom vars set via `set-env` tool are encrypted at rest (AES-256-GCM).
- Changing env vars does NOT auto-redeploy. Deploy again to apply.
- `set-env` values are runtime only. Next.js `NEXT_PUBLIC_*` (build-time) values belong in a committed file such as `.env.production`.
- Secrets never go into an uploaded file. A folder deploy uses `.sotaignore` (or the `.gitignore`, which never drops `.env.production` or `.env.example`); `.env`, `.env.local`, `.env.*.local` and `.envrc` are always left out.
- Enterprise: apps on the same server can call each other without the sign-in and can forge identity headers; protect app-to-app calls with your own shared secret.

## Custom Domains

Every project can have up to 5 custom domains with automatic HTTPS via Let's Encrypt.

- **Apex domains** (example.com): Add an A record pointing to `23.88.45.28` (edge proxy).
- **Subdomains** (app.example.com): Add a CNAME record pointing to `{slug}.sota.io`.
- SSL certificates are provisioned automatically via HTTP-01 challenge after DNS verification.
- Domain statuses: `pending` (waiting for DNS) → `verified` (SSL provisioning) → `active` (live with HTTPS).

Manage via API:
- `POST /v1/projects/:id/domains` — Add domain (body: `{"domain": "yourdomain.com"}`)
- `GET /v1/projects/:id/domains` — List domains
- `GET /v1/projects/:id/domains/:domainId` — Get domain with DNS instructions
- `DELETE /v1/projects/:id/domains/:domainId` — Remove domain

## sota Enterprise accounts

Call the `get-account` tool first. On a sota Enterprise account (company label `<label>`):

- The app lives at `https://<app>.<label>.sota.io` behind the company's Microsoft 365 sign-in (sota Access). Never build a login.
- Read `X-Sota-Access-User-Id`, `X-Sota-Access-Email` (lower-case it) and `X-Sota-Access-Name`; no role in the headers.
- Fail closed (401) without `X-Sota-Access-User-Id`, EXCEPT `GET /health` (200) and `GET /` (2xx/3xx, no data): the health gate and the edge check call them without identity.
- Sign out: `/.sota/access/logout`. No public paths yet (no webhooks from outside).
- After a deploy nobody can open the app until the owner approves people and ticks the app under Users & access in the dashboard. MCP cannot do that: tell the human.

Full checklist: the `enterprise-app-checklist` prompt or https://sota.io/docs/enterprise/build-with-ai

## Deployment Workflow for AI Agents

```
0. get-account                    → Enterprise or not, limits, contract
1. create-project "My App"        → get project_id
2. (write your app code)          → must listen on PORT
3. deploy project_id ./my-app     → uploads & builds
4. get-logs project_id            → monitor build
5. get-status project_id          → verify "running" status
6. App is live!                   → https://{slug}.sota.io
```

## Common Patterns

### Node.js + PostgreSQL (Express)
```javascript
import express from 'express';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.listen(process.env.PORT || 8080);
```

### Python + PostgreSQL (FastAPI)
```python
import os, databases
database = databases.Database(os.environ["DATABASE_URL"])
# App must listen on PORT (default 8080)
```

### Next.js
```javascript
// next.config.js — add standalone output
module.exports = { output: 'standalone' }
// DATABASE_URL available in server components/API routes via process.env
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Container crashes on startup | App must listen on PORT env var (8080 for auto-detected, or from Dockerfile EXPOSE). Check with `get-logs`. |
| Database connection refused | DATABASE_URL is auto-injected. Don't hardcode connection strings. |
| Build fails | Check `get-logs` for missing dependencies or build errors. |
| App not accessible | Use `get-status` — must show "running". Check health check (60s timeout). |
| Env vars not applied | Changing env vars requires redeployment. Call `deploy` again. |
| Next.js NEXT_PUBLIC_* empty | `set-env` values are not visible at build time; put them in a committed `.env.production`. |
| Migrations not running | Start script must chain migration before server. Example: `"start": "npx prisma db push && node server.js"` |
| `prepared statement already exists` | PgBouncer conflict — add `?pgbouncer=true` to DATABASE_URL in Prisma schema. |

## Links

- Docs: https://sota.io/docs
- API Reference: https://sota.io/docs/api/overview
- PostgreSQL Guide: https://sota.io/docs/guides/postgresql
- GitHub: https://github.com/sota-deploy
- AI context file: https://sota.io/llms.txt
