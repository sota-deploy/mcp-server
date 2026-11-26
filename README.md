# @sota-io/mcp

MCP server for [sota.io](https://sota.io) — deploy web apps via AI agents.

[![npm version](https://img.shields.io/npm/v/@sota-io/mcp)](https://www.npmjs.com/package/@sota-io/mcp)
[![npm downloads](https://img.shields.io/npm/dm/@sota-io/mcp)](https://www.npmjs.com/package/@sota-io/mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green)](https://nodejs.org)

## Two transports

Since v1.4.0 this package ships **two transports**:

- **`sota-mcp`** (stdio, default) — for Claude Code, Cursor, Windsurf, and any
  MCP client that spawns a local process. Pass your `SOTA_API_KEY` via env var.
- **`sota-mcp-http`** (Streamable HTTP) — for self-hosting the remote endpoint
  that powers `mcp.sota.io` (used by Claude Desktop and Claude.ai web). Reads
  `SUPABASE_JWT_SECRET`, `DATABASE_URL`, etc. — most users do not need this;
  it's the same code that runs on `mcp.sota.io` if you want to host your own.

Most users want the stdio transport.

## One-click install for Claude Desktop / Claude.ai web

If you use Claude Desktop or Claude.ai (Pro / Max / Team / Enterprise plan),
the easiest install is **not** this npm package — it's the hosted remote
endpoint at `mcp.sota.io`. Click here:

[**Add to Claude →**](https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=sota.io&connectorUrl=https%3A%2F%2Fmcp.sota.io%2Fmcp)

OAuth handles auth. New users can sign up entirely inside Claude via the
`create_account` tool — no browser tab switch.

See [https://sota.io/docs/integrations/claude](https://sota.io/docs/integrations/claude).

## Quick Start (stdio — Claude Code, Cursor, Windsurf, …)

1. Get an API key from [sota.io/dashboard/settings](https://sota.io/dashboard/settings)
2. [Configure your IDE](#configuration)
3. Ask your AI: *"Deploy my app to sota.io"*

## Installation

**No install needed** — run directly with npx:

```bash
npx -y @sota-io/mcp
```

This short form needs version 1.7.1 or later. Versions 1.0.0 to 1.7.0 have no
executable named after the package, so npx stops with "could not determine
executable to run"; pin one of them with the long form:

```bash
npx -y -p @sota-io/mcp@1.7.0 sota-mcp
```

Or install globally:

```bash
npm install -g @sota-io/mcp
sota-mcp
```

A global install puts three commands on your PATH: `sota-mcp` (stdio),
`sota-mcp-http` (Streamable HTTP) and, since 1.7.1, `mcp` (the same stdio
server, the name `npx -y @sota-io/mcp` runs).

## Configuration

### Claude Code

**CLI method:**

```bash
claude mcp add sota -- npx -y @sota-io/mcp
```

Then set your API key in the shell environment:

```bash
export SOTA_API_KEY=sota_your_api_key_here
```

**Manual JSON** (`.claude/settings.json`):

```json
{
  "mcpServers": {
    "sota": {
      "command": "npx",
      "args": ["-y", "@sota-io/mcp"],
      "env": {
        "SOTA_API_KEY": "sota_your_api_key_here"
      }
    }
  }
}
```

### Claude Desktop

Edit `claude_desktop_config.json`:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "sota": {
      "command": "npx",
      "args": ["-y", "@sota-io/mcp"],
      "env": {
        "SOTA_API_KEY": "sota_your_api_key_here"
      }
    }
  }
}
```

### Cursor

Create `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "sota": {
      "command": "npx",
      "args": ["-y", "@sota-io/mcp"],
      "env": {
        "SOTA_API_KEY": "sota_your_api_key_here"
      }
    }
  }
}
```

### Windsurf

Edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "sota": {
      "command": "npx",
      "args": ["-y", "@sota-io/mcp"],
      "env": {
        "SOTA_API_KEY": "sota_your_api_key_here"
      }
    }
  }
}
```

## Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `get-account` | Plan limits, Enterprise facts and the build contract (call first) | *(none)* |
| `deploy` | Deploy an app and wait for the result (bounded) | `project_id`, one of `files` / `git_url` / `directory`, `wait?`, `max_wait_seconds?` |
| `redeploy` | Restart the running image with the current env vars | `project_id`, `wait?`, `max_wait_seconds?` |
| `get-logs` | Get the build and deploy log | `project_id`, `deployment_id?` |
| `set-env` | Set environment variable | `project_id`, `key`, `value` |
| `get-env` | List environment variables (masked) | `project_id`, `key?`, `reveal?`, `include_managed?` |
| `rollback` | Rollback to previous deployment | `project_id` |
| `get-status` | Get deployment status, optionally wait | `project_id`, `wait_for?`, `deployment_id?`, `max_wait_seconds?` |
| `list-projects` | List all projects | *(none)* |
| `create-project` | Create a new project | `name` |
| `delete-project` | Delete a project permanently | `project_id` |
| `add-domain` | Add custom domain to project | `project_id`, `domain` |
| `list-domains` | List custom domains | `project_id` |
| `get-domain` | Get domain details and DNS status | `project_id`, `domain_id` |
| `remove-domain` | Remove custom domain | `project_id`, `domain_id` |

### `deploy`

Deploy an application to sota.io. Builds a tar.gz archive from one source and uploads it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | Yes | Project ID to deploy to |
| `files` | object | No | Map of relative path to content: a string (UTF-8) or `{ "content": "<base64>", "encoding": "base64" }` for binary files; at most 200 files and 10 MB decoded |
| `git_url` | string | No | Public git repository to shallow-clone with the local `git` (`git_branch` optional) |
| `directory` | string | No | Directory to deploy (defaults to current working directory) |
| `wait` | boolean | No | Wait until running or failed (default `true`) |
| `max_wait_seconds` | number | No | Upper bound of the wait (default 40, max 50) |

After the upload the tool waits on the server for the result, at most 40 seconds by default (50 at most, inside the usual 60-second MCP client request limit; progress notifications are sent when the client asks for them). A longer build returns "not finished" with `retry_after_seconds`; call `get-status` with `wait_for: "finished"` once. A failed health check names the HTTP status the app answered, or that nothing answered.

`.git/`, `node_modules/`, `.DS_Store` and the local/secret env files `.env`, `.env.local`, `.env.*.local` and `.envrc` (any depth, any case) are never archived; set runtime secrets with `set-env`. Committed variants such as `.env.production`, `.env.development`, `.env.test` and `.env.example` are kept, because builds do not see `set-env` values (e.g. `NEXT_PUBLIC_*`).

The hosted server (`https://mcp.sota.io/mcp`) accepts `files` only: it has no access to your filesystem, and it rejects `directory` and `git_url`. Use this local server or `sota deploy` for those.

```
"Deploy my app in the current directory to sota.io"
```

### `get-logs`

Get the build and deploy log of a deployment (no runtime logs). If no deployment_id is provided, returns logs for the latest deployment.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | Yes | Project ID to get logs for |
| `deployment_id` | string | No | Specific deployment ID (defaults to latest) |

```
"Show me the build logs for my sota.io project"
```

### `redeploy`

Start the image of the running deployment again with the current environment variables, no build (applies `set-env`). The previous container serves until the new one is healthy. The API answers when the redeploy has finished; the tool waits up to `max_wait_seconds` and otherwise points to `get-status` with `wait_for: "finished"` while the redeploy continues.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | Yes | Project ID |
| `wait` | boolean | No | Wait for the result (default `true`) |
| `max_wait_seconds` | number | No | Upper bound of the wait (default 40, max 50) |

```
"Restart my app with the new environment variables"
```

### `set-env`

Set an environment variable for a project. Apply it with `redeploy`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | Yes | Project ID |
| `key` | string | Yes | Environment variable name (e.g., DATABASE_URL) |
| `value` | string | Yes | Environment variable value |

```
"Set DATABASE_URL on my project to postgres://localhost/mydb"
```

### `get-env`

List environment variables for a project with masked values (first 4 characters of values with 20 or more characters, and the length; managed database values show only their length). A single value in clear only with `key` and `reveal: true`; a managed database value also needs `include_managed: true`. Masking keeps secrets out of the conversation; it is not access control: whoever holds the connection or API key can read every value. **Changed in 1.8.0**: before, all values came back in clear.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | Yes | Project ID |
| `key` | string | No | Only this variable |
| `reveal` | boolean | No | With `key`: the value in clear |
| `include_managed` | boolean | No | With `reveal`: also for a managed database value |

```
"Show all environment variables for my project"
```

### `rollback`

Rollback a project to its previous deployment. This swaps the container image without rebuilding.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | Yes | Project ID to rollback |

```
"Roll back my app to the previous version"
```

### `get-status`

Get the current deployment status for a project, including URL, the reason of a failure and recent deployment history. `wait_for: "finished"` waits on the server (bounded) until the deployment is running, failed or stopped.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | Yes | Project ID to check status for |
| `wait_for` | `"finished"` | No | Wait until the deployment has finished |
| `deployment_id` | string | No | Deployment to watch (defaults to the newest) |
| `max_wait_seconds` | number | No | Upper bound of the wait (default 40, max 50) |

```
"What's the status of my sota.io deployment?"
```

### `list-projects`

List all projects on your sota.io account.

*No parameters required.*

```
"List my sota.io projects"
```

### `create-project`

Create a new project on sota.io. The project slug is auto-generated from the name (lowercase, hyphens, max 63 chars) and used as the subdomain (`{slug}.sota.io`). For example, "My API" becomes `my-api.sota.io`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Name for the new project |

```
"Create a new sota.io project called my-api"
```

### `delete-project`

Delete a project and all its deployments from sota.io. This action is permanent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | Yes | Project ID to delete |

```
"Delete my sota.io project abc123"
```

### `add-domain`

Add a custom domain to a project. Returns DNS instructions for pointing the domain.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | Yes | Project ID |
| `domain` | string | Yes | Domain name (e.g., "example.com" or "app.example.com") |

```
"Add example.com as a custom domain to my project"
```

### `list-domains`

List all custom domains for a project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | Yes | Project ID |

```
"Show all custom domains for my project"
```

### `get-domain`

Get domain details including DNS verification status and SSL state.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | Yes | Project ID |
| `domain_id` | string | Yes | Domain ID |

```
"Check the DNS status of my custom domain"
```

### `remove-domain`

Remove a custom domain from a project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | Yes | Project ID |
| `domain_id` | string | Yes | Domain ID to remove |

```
"Remove the custom domain from my project"
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SOTA_API_KEY` | Yes | — | API key with `sota_` prefix. Create at [sota.io/dashboard/settings](https://sota.io/dashboard/settings) |
| `SOTA_API_URL` | No | `https://api.sota.io` | API base URL |

## Troubleshooting

### "npx: command not found"

**Problem:** Your IDE doesn't inherit the shell PATH where nvm/fnm is loaded.

**Fix:** Use the absolute path to npx. Find it with:

```bash
which npx
# Example output: /Users/you/.nvm/versions/node/v22.0.0/bin/npx
```

Then update your MCP config to use the absolute path:

```json
{
  "mcpServers": {
    "sota": {
      "command": "/Users/you/.nvm/versions/node/v22.0.0/bin/npx",
      "args": ["-y", "@sota-io/mcp"],
      "env": {
        "SOTA_API_KEY": "sota_your_api_key_here"
      }
    }
  }
}
```

### "SOTA_API_KEY environment variable is required"

**Problem:** The API key is not set in your MCP configuration.

**Fix:** Add the `env` block to your MCP server config. Shell environment variables do **not** automatically pass to MCP servers — the `env` block in the config is required:

```json
{
  "env": {
    "SOTA_API_KEY": "sota_your_api_key_here"
  }
}
```

### Connection refused or timeout errors

**Problem:** Network issue or wrong API URL.

**Fix:** Check your internet connection. If you're using a custom API URL, verify `SOTA_API_URL` is set correctly. The default is `https://api.sota.io`.

## License

MIT

## Links

- [Website](https://sota.io)
- [Documentation](https://sota.io/docs/mcp)
- [Dashboard](https://sota.io/dashboard)
- [Issues](https://github.com/sota-deploy/mcp-server/issues)
