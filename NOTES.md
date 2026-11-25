# @sota-io/mcp — Implementation Notes

## Transports

**Streamable HTTP** (since 1.4.0) is the remote transport at `mcp.sota.io/mcp`. Server-Sent Events (SSE) transport is explicitly NOT used due to the known token-refresh bug `anthropics/claude-ai-mcp#228` which silently kills the connector after token TTL.

**Stdio** stays available for local use (Claude Code direct stdio attach, local debugging): `npx -y @sota-io/mcp` (1.7.1 and later; 1.0.0-1.7.0 need `npx -y -p @sota-io/mcp sota-mcp`). Both transports ship in the same package version.

## Tool annotations

Per MCP spec 2025-06-18, every registered tool carries `annotations`:
- `readOnlyHint` — `true` for list/get tools, `false` for any mutation
- `destructiveHint` — `true` for delete/replace operations (deploy, rollback, delete-project, remove-domain, set-env), `false` otherwise
- `idempotentHint` — `true` if calling twice with same args has no additional effect
- `openWorldHint` — `false` everywhere; all tools operate on the sota.io domain, not arbitrary external systems

Missing annotations are a common cause of Anthropic Connectors Directory rejections.

## OAuth + create_account

The remote endpoint accepts OAuth bearer tokens, maps them to internal `sota_xxx` API keys tagged `source=claude` (plan limits are enforced by sota-api), and exposes a `create_account(email)` tool for signing up from inside Claude.
