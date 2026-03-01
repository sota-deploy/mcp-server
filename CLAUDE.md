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

1. Create a project → PostgreSQL 17 database is auto-provisioned.
2. Deploy your app → `DATABASE_URL` is injected into the container.
3. Your app reads `DATABASE_URL` from the environment — that's it.

You do NOT need to:
- Set `DATABASE_URL` manually
- Provision a database
- Configure connection strings
- Set up SSL for the database (internal network, sslmode=disable is safe)

If your app needs tables, run migrations on startup:
- **Prisma**: `npx prisma migrate deploy` in your start script
- **Drizzle**: `npx drizzle-kit push` or migrate on startup
- **SQLAlchemy/Alembic**: `alembic upgrade head` in entrypoint
- **Django**: `python manage.py migrate` before `gunicorn`

## Environment Variables

- `PORT` — Auto-injected. 8080 for auto-detected frameworks, or from Dockerfile EXPOSE for custom builds. Do not override.
- `DATABASE_URL` — PostgreSQL connection string (auto-injected).
- Custom vars set via `set-env` tool are encrypted at rest (AES-256-GCM).
- Changing env vars does NOT auto-redeploy. Deploy again to apply.
- Next.js `NEXT_PUBLIC_*` vars: set BEFORE deploying (build-time embedding).

## Deployment Workflow for AI Agents

```
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
| Next.js NEXT_PUBLIC_* empty | Set these BEFORE deploying (they're embedded at build time). |

## Links

- Docs: https://sota.io/docs
- API Reference: https://sota.io/docs/api/overview
- PostgreSQL Guide: https://sota.io/docs/guides/postgresql
- GitHub: https://github.com/sota-deploy
- AI context file: https://sota.io/llms.txt
