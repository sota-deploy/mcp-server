// Token bridge: the hosted MCP exchanges the user's own
// sign-in token for the user's connector key through POST /v1/auth/mcp-key.
// It never touches a database. Run with: npm test (builds dist/ first).

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.MCP_BRIDGE_SECRET = 'bridge-secret-for-tests-0123456789abcdef';
const { getOrProvisionApiKey, provisionPlanAndKey, clearBridgeCache, BridgeError, bridgeSecretProblem } = await import('../dist/auth/token-bridge.js');

function fakeApi(handler) {
  return new Promise((resolve) => {
    const calls = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, secret: req.headers['x-sota-bridge-secret'], body: body ? JSON.parse(body) : null });
        handler(req, res, calls.length);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

const okKey = (n) => (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data: { api_key: `sota_${String(n()).padStart(40, '0')}`, created: true } }));
};

test('bridge forwards the user token to the API, returns and caches the key', async () => {
  clearBridgeCache();
  let i = 0;
  const api = await fakeApi(okKey(() => ++i));
  try {
    const a = await getOrProvisionApiKey('user-1', 'jwt-of-user-1', api.url);
    assert.match(a.apiKey, /^sota_0+1$/);
    assert.equal(a.created, true);
    assert.equal(api.calls.length, 1);
    assert.equal(api.calls[0].method, 'POST');
    assert.equal(api.calls[0].url, '/v1/auth/mcp-key');
    assert.equal(api.calls[0].auth, 'Bearer jwt-of-user-1');
    assert.equal(api.calls[0].secret, 'bridge-secret-for-tests-0123456789abcdef');
    assert.deepEqual(api.calls[0].body, { ensure_plan: false });
    const b = await getOrProvisionApiKey('user-1', 'jwt-of-user-1', api.url);
    assert.equal(b.apiKey, a.apiKey);
    assert.equal(api.calls.length, 1, 'second call within the TTL is served from the cache');
  } finally {
    await api.close();
  }
});

test('create_account path asks the API to create the plan row', async () => {
  clearBridgeCache();
  const api = await fakeApi(okKey(() => 7));
  try {
    await provisionPlanAndKey('user-2', 'session-token', api.url);
    assert.deepEqual(api.calls[0].body, { ensure_plan: true });
    assert.equal(api.calls[0].auth, 'Bearer session-token');
  } finally {
    await api.close();
  }
});

test('an API refusal is a BridgeError with the status and code, never the token', async () => {
  clearBridgeCache();
  const api = await fakeApi((req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'sign_in_required', message: 'x' } }));
  });
  try {
    await assert.rejects(getOrProvisionApiKey('user-3', 'secret-token-value', api.url), (err) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.status, 403);
      assert.match(err.message, /sign_in_required/);
      assert.doesNotMatch(err.message, /secret-token-value/);
      return true;
    });
  } finally {
    await api.close();
  }
});

test('hosted server refuses to start without MCP_BRIDGE_SECRET; stdio is unaffected', async () => {
  const { spawnSync } = await import('node:child_process');
  const env = { ...process.env, PORT: '0' };
  delete env.MCP_BRIDGE_SECRET;
  const r = spawnSync(process.execPath, [new URL('../dist/http.js', import.meta.url).pathname], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /MCP_BRIDGE_SECRET is not set/);
  assert.match(bridgeSecretProblem('short'), /at least 32/);
  assert.equal(bridgeSecretProblem('x'.repeat(32)), null);
});
