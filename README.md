# @sota-io/mcp

MCP server for [sota.io](https://sota.io) — deploy web apps via AI agents.

[![npm](https://img.shields.io/npm/v/@sota-io/mcp)](https://www.npmjs.com/package/@sota-io/mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green)](https://nodejs.org)

## Quick Start

1. Get an API key from [sota.io/dashboard/settings](https://sota.io/dashboard/settings)
2. [Configure your IDE](#configuration)
3. Ask your AI: *"Deploy my app to sota.io"*

## Installation

**No install needed** — run directly with npx:

```bash
npx -y @sota-io/mcp
```

Or install globally:

```bash
npm install -g @sota-io/mcp
sota-mcp
```

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
| `deploy` | Deploy an app | `project_id`, `directory?` |
| `get-logs` | Get build/runtime logs | `project_id`, `deployment_id?` |
| `set-env` | Set environment variable | `project_id`, `key`, `value` |
| `get-env` | List environment variables | `project_id` |
| `rollback` | Rollback to previous deployment | `project_id` |
| `get-status` | Get deployment status | `project_id` |
| `list-projects` | List all projects | *(none)* |
| `create-project` | Create a new project | `name` |
| `delete-project` | Delete a project permanently | `project_id` |

### `deploy`

Deploy an application to sota.io. Creates a tar.gz archive of the specified directory and uploads it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | Yes | Project ID to deploy to |
| `directory` | string | No | Directory to deploy (defaults to current working directory) |

```
"Deploy my app in the current directory to sota.io"
```

### `get-logs`

Get build and runtime logs for a deployment. If no deployment_id is provided, returns logs for the latest deployment.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | Yes | Project ID to get logs for |
| `deployment_id` | string | No | Specific deployment ID (defaults to latest) |

```
"Show me the build logs for my sota.io project"
```

### `set-env`

Set an environment variable for a project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | Yes | Project ID |
| `key` | string | Yes | Environment variable name (e.g., DATABASE_URL) |
| `value` | string | Yes | Environment variable value |

```
"Set DATABASE_URL on my project to postgres://localhost/mydb"
```

### `get-env`

List environment variables for a project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | Yes | Project ID |

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

Get the current deployment status for a project, including URL and recent deployment history.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | Yes | Project ID to check status for |

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
