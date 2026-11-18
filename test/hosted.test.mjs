// MCP-1: hosted (mcp.sota.io) vs local (stdio) behaviour.
// Run with: npm test (builds dist/ first).
//
// Covers: the deploy schema difference, the runtime guard against
// directory/git_url in hosted mode, email-free logs and the /health version.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Env for dist/http-app.js must be set before it is imported: a JWT secret
// so the JWT path is reachable, and no DATABASE_URL so the token bridge fails
// deterministically (bridge_error, logged with the audit fields).
const JWT_SECRET = 'test-secret-for-mcp-1-hosted-tests-only-0123456789';
process.env.SUPABASE_JWT_SECRET = JWT_SECRET;
delete process.env.DATABASE_URL;
process.env.SOTA_API_URL = 'http://127.0.0.1:9'; // never reached

const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { SignJWT } = await import('jose');
const { registerDeployTool } = await import('../dist/tools/deploy.js');
const { hostedDeployRejection } = await import('../dist/lib/hosted-guard.js');
const { formatLogLine, redactEmails, errorMessage } = await import('../dist/lib/log.js');
// No build args in this process: /health must then say "unknown" (DEVX-4).
delete process.env.GIT_SHA;
delete process.env.BUILD_TIME;
const { PACKAGE_VERSION } = await import('../dist/lib/version.js');
const { app } = await import('../dist/http-app.js');

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** SotaClient stand-in that records deploy() calls. */
function fakeClient() {
  const calls = [];
  return {
    calls,
    async deploy(projectId, archive) {
      calls.push({ projectId, archive });
      return { id: 'dep-1', status: 'building', url: 'https://x.sota.io' };
    },
  };
}

async function connectedClient({ hosted }) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const sota = fakeClient();
  registerDeployTool(server, sota, { hosted });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, sota, close: () => Promise.all([client.close(), server.close()]) };
}

async function deploySchema(hosted) {
  const { client, close } = await connectedClient({ hosted });
  try {
    const { tools } = await client.listTools();
    return tools.find((t) => t.name === 'deploy');
  } finally {
    await close();
  }
}

// ── schema: hosted vs stdio ───────────────────────────────────────────────

test('stdio deploy schema keeps directory, git_url and git_branch', async () => {
  const deploy = await deploySchema(false);
  const props = Object.keys(deploy.inputSchema.properties).sort();
  assert.deepEqual(props, ['directory', 'files', 'git_branch', 'git_url', 'project_id']);
});

test('hosted deploy schema offers only project_id + required files', async () => {
  const deploy = await deploySchema(true);
  const props = Object.keys(deploy.inputSchema.properties).sort();
  assert.deepEqual(props, ['files', 'project_id']);
  assert.deepEqual([...deploy.inputSchema.required].sort(), ['files', 'project_id']);
  assert.doesNotMatch(deploy.description, /\*\*directory\*\*|\*\*git_url\*\*/);
});

// ── tool-level guard (second layer) ───────────────────────────────────────

test('hosted deploy tool never falls back to a directory', async () => {
  const { client, sota, close } = await connectedClient({ hosted: true });
  try {
    for (const args of [
      { project_id: 'p' },
      { project_id: 'p', directory: '/' },
      { project_id: 'p', git_url: 'https://github.com/octocat/Hello-World.git' },
    ]) {
      const res = await client.callTool({ name: 'deploy', arguments: args });
      assert.equal(res.isError, true, `expected an error for ${JSON.stringify(args)}`);
    }
    assert.equal(sota.calls.length, 0, 'nothing may be uploaded');
  } finally {
    await close();
  }
});

test('hosted deploy tool still deploys inline files', async () => {
  const { client, sota, close } = await connectedClient({ hosted: true });
  try {
    const res = await client.callTool({
      name: 'deploy',
      arguments: { project_id: 'p', files: { 'index.js': 'console.log(1)' } },
    });
    assert.notEqual(res.isError, true, JSON.stringify(res));
    assert.equal(sota.calls.length, 1);
    assert.equal(sota.calls[0].projectId, 'p');
    assert.equal(sota.calls[0].archive[0], 0x1f); // gzip
  } finally {
    await close();
  }
});

// ── request-level guard (first layer) ─────────────────────────────────────

test('hostedDeployRejection flags directory / git_url / git_branch, single and batch', () => {
  const call = (args, id = 7) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'deploy', arguments: args } });
  for (const key of ['directory', 'git_url', 'git_branch']) {
    const r = hostedDeployRejection(call({ project_id: 'p', [key]: '' }));
    assert.ok(r, `${key} must be rejected even when empty`);
    assert.equal(r.id, 7);
    assert.match(r.message, new RegExp(key));
  }
  assert.ok(hostedDeployRejection([{ jsonrpc: '2.0', method: 'tools/list', id: 1 }, call({ directory: '/' }, 2)]));
  assert.equal(hostedDeployRejection(call({ project_id: 'p', files: { a: 'b' } })), null);
  assert.equal(hostedDeployRejection({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get-logs', arguments: { directory: '/' } } }), null);
  assert.equal(hostedDeployRejection(null), null);
});

// ── HTTP app: /health, tools/list, rejection, logs ────────────────────────

async function withServer(fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

async function captureLogs(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.join(' '));
  try {
    await fn();
  } finally {
    Object.assign(console, orig);
  }
  return lines;
}

function rpc(base, body, headers = {}) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

async function rpcResult(res) {
  const text = await res.text();
  const data = text.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(data ? data.slice('data: '.length) : text);
}

test('/health and / report the package.json version', async () => {
  assert.equal(PACKAGE_VERSION, pkg.version);
  await withServer(async (base) => {
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.version, pkg.version);
    const root = await (await fetch(`${base}/`)).json();
    assert.equal(root.version, pkg.version);
  });
});

test('/health reports the commit and build time, "unknown" without the build args', async () => {
  const { readBuildValue, GIT_SHA, BUILD_TIME, UNKNOWN_BUILD } = await import('../dist/lib/version.js');
  // The reader: set, unset, blank.
  assert.equal(readBuildValue('GIT_SHA', { GIT_SHA: 'e896781a5594ef93d252cec65a684028b8c43c0a' }), 'e896781a5594ef93d252cec65a684028b8c43c0a');
  assert.equal(readBuildValue('BUILD_TIME', { BUILD_TIME: ' 2026-10-07T19:00:00Z ' }), '2026-10-07T19:00:00Z');
  assert.equal(readBuildValue('GIT_SHA', {}), UNKNOWN_BUILD);
  assert.equal(readBuildValue('BUILD_TIME', { BUILD_TIME: '  ' }), UNKNOWN_BUILD);

  await withServer(async (base) => {
    const health = await (await fetch(`${base}/health`)).json();
    // Whatever this process was started with (nothing, in CI and locally).
    assert.equal(health.commit, GIT_SHA);
    assert.equal(health.built_at, BUILD_TIME);
    assert.equal(health.commit, UNKNOWN_BUILD);
    assert.equal(health.built_at, UNKNOWN_BUILD);
    // The fields that existed before keep their names and meaning.
    assert.equal(health.ok, true);
    assert.equal(health.service, 'sota-mcp');
    assert.equal(health.version, pkg.version);
    assert.equal(health.transport, 'streamable-http');
  });
});

test('hosted tools/list over HTTP advertises no directory / git_url', async () => {
  await withServer(async (base) => {
    const res = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(res.status, 200);
    const { result } = await rpcResult(res);
    const deploy = result.tools.find((t) => t.name === 'deploy');
    assert.deepEqual(Object.keys(deploy.inputSchema.properties).sort(), ['files', 'project_id']);
  });
});

test('hosted HTTP rejects a directory deploy before auth and before any tool runs', async () => {
  await withServer(async (base) => {
    for (const headers of [{}, { authorization: 'Bearer sota_0000000000000000000000000000000000000000' }]) {
      const res = await rpc(
        base,
        { jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'deploy', arguments: { project_id: 'p', directory: '/' } } },
        headers,
      );
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.id, 42);
      assert.equal(body.error.code, -32602);
      assert.match(body.error.message, /directory/);
    }
  });
});

test('request logs carry the user id, never the email', async () => {
  const email = 'jane.doe+mcp@example.com';
  const sub = '11111111-2222-3333-4444-555555555555';
  const jwt = await new SignJWT({ email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('https://auth.sota.io/auth/v1')
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(JWT_SECRET));

  const lines = await captureLogs(() =>
    withServer(async (base) => {
      const res = await rpc(
        base,
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list-projects', arguments: {} } },
        { authorization: `Bearer ${jwt}` },
      );
      // No DATABASE_URL in tests: the token bridge fails with a 503.
      assert.equal(res.status, 503);
    }),
  );
  const joined = lines.join('\n');
  assert.match(joined, /"event":"bridge_error"/);
  assert.ok(joined.includes(sub), 'the user id is logged');
  assert.ok(!joined.includes(email), `logs must not contain the email:\n${joined}`);
  assert.doesNotMatch(joined, /"email"/);
});

test('log lines redact emails, also inside error messages', () => {
  const line = formatLogLine({ event: 'x', error_message: 'duplicate key for Jane.Doe@Example.co.uk (user a@b.io)' });
  assert.doesNotMatch(line, /@/);
  assert.match(line, /\[email redacted\]/);
  assert.equal(redactEmails('no pii here'), 'no pii here');
  assert.equal(errorMessage(new Error('mail x@y.de failed')), 'mail [email redacted] failed');
});
