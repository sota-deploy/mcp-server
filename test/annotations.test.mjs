// Every tool carries a human title and all four MCP tool annotations.
// Run with: npm test (builds dist/ first).
//
// Claude uses readOnlyHint / destructiveHint to decide when to ask before a
// call, and the Connectors Directory requires a title plus readOnlyHint or
// destructiveHint on every tool. This test fails for a tool without them, on
// the hosted server (all tools incl. create_account) and on stdio.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.SUPABASE_JWT_SECRET = 'test-secret-for-annotation-tests-only-0123456789';
process.env.SOTA_API_URL = 'http://127.0.0.1:9'; // never reached
delete process.env.DATABASE_URL;

const { app } = await import('../dist/http-app.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

const KEY = 'sota_' + '0'.repeat(40);
const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];
// Tools that change or delete what already exists: a client must ask first.
const MUST_BE_DESTRUCTIVE = new Set([
  'delete-project',
  'deploy',
  'deploy-changes',
  'discard-changes',
  'redeploy',
  'remove-domain',
  'rollback',
  'set-env',
]);

function checkTools(tools, where) {
  assert.ok(tools.length > 10, `${where}: expected the full tool list`);
  for (const t of tools) {
    const id = `${where}: ${t.name}`;
    assert.ok(t.name.length <= 64, `${id}: name longer than 64 characters`);
    assert.equal(typeof t.title, 'string', `${id}: no title`);
    assert.ok(t.title.trim().length > 0 && t.title.length <= 60, `${id}: title empty or too long`);
    assert.ok(t.annotations, `${id}: no annotations`);
    for (const h of HINTS) assert.equal(typeof t.annotations[h], 'boolean', `${id}: ${h} missing`);
    if (t.annotations.readOnlyHint) {
      assert.equal(t.annotations.destructiveHint, false, `${id}: read-only but destructive`);
      assert.equal(t.annotations.idempotentHint, true, `${id}: read-only but not idempotent`);
    }
    if (MUST_BE_DESTRUCTIVE.has(t.name)) assert.equal(t.annotations.destructiveHint, true, `${id}: must be destructive`);
    if (/^(get|list|read|search)-/.test(t.name)) assert.equal(t.annotations.readOnlyHint, true, `${id}: a read tool must be read-only`);
  }
}

test('hosted server: every tool has a title and the four annotations', async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    const data = text.split('\n').find((l) => l.startsWith('data: '));
    const { result } = JSON.parse(data ? data.slice(6) : text);
    assert.ok(result.tools.some((t) => t.name === 'create_account'));
    checkTools(result.tools, 'hosted');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('stdio server: every tool has a title and the four annotations', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { ...process.env, SOTA_API_KEY: KEY, SOTA_API_URL: 'http://127.0.0.1:9' },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'annotations-test', version: '0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    checkTools(tools, 'stdio');
  } finally {
    await client.close();
  }
});
