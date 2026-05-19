# @sota-io/mcp — Implementation Notes

## v1.3.0 → v1.4.0 transition (planned, Phase 57)

**Transport decision (locked 2026-05-13, Phase 55)**: v1.4 ships a **Streamable HTTP** remote transport at `mcp.sota.io/mcp`. Server-Sent Events (SSE) transport is explicitly NOT used due to the known token-refresh bug `anthropics/claude-ai-mcp#228` which silently kills the connector after token TTL.

**Stdio transport stays available** in v1.3.x for legacy CLI use (Claude Code direct stdio attach, local debugging). v1.4 publishes both transports under the same package version — stdio for `npx @sota-io/mcp`, Streamable HTTP for the remote endpoint Anthropic clients dial.

## Tool annotations (added Phase 55, 2026-05-13)

Per MCP spec 2025-06-18, every registered tool now carries `annotations`:
- `readOnlyHint` — `true` for list/get tools, `false` for any mutation
- `destructiveHint` — `true` for delete/replace operations (deploy, rollback, delete-project, remove-domain, set-env), `false` otherwise
- `idempotentHint` — `true` if calling twice with same args has no additional effect
- `openWorldHint` — `false` everywhere; all tools operate on the sota.io domain, not arbitrary external systems

This was the #1 cause of Anthropic Connectors Directory rejections per research; resolved upfront before submission (Phase 60).

## OAuth + create_account (Phase 57)

The remote endpoint will accept Anthropic-issued bearer tokens, translate them to internal `sota_xxx` API keys tagged `source=claude`, enforce plan limits per call, and expose a new `create_account(email)` tool for net-new user signup-from-Claude — the unique competitor wedge.

Implementation plan: see `.planning/phases/57-remote-mcp-create-account/`.
