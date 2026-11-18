# Changelog — @sota-io/mcp

## 1.6.0 — 2026-11-18

- Deploy packs the source with an explicit file list, so the result is the same on GNU tar, bsdtar (macOS, Windows) and BusyBox tar (Alpine). On BusyBox the deploy used to fail with "unrecognized option: null".
- Local and secret env files (`.env`, `.env.local`, `.env.*.local`, `.envrc`) are never part of an upload, at any depth and in every mode. `.git`, `node_modules` and `.DS_Store` stay out as before.
- Clearer errors when packing fails (`tar_failed` with tar's own message).
- The hosted server (mcp.sota.io) accepts inline `files` only; `directory` and `git_url` are modes of the local server (`npx @sota-io/mcp`).
- The server reports its real package version, and `/health` on the hosted server reports commit and build time.
- No e-mail addresses in server logs.

## 1.5.0 — 2026-05-19

- Deploy from inline `files` or a `git_url`, next to the directory mode.
