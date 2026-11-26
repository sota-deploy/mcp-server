// Sign-in at connect time (1.9.0).
// Run with: npm test (builds dist/ first).
//
// /mcp refuses every anonymous request, `initialize` included, with 401 +
// WWW-Authenticate pointing at protected-resource metadata whose `resource`
// is exactly the connector URL. /mcp/signup keeps the anonymous discovery +
// create_account of 1.8.0. A real MCP SDK client that only starts OAuth when
// the connection is refused must therefore start it on /mcp.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

async function listen(handler) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, base: `http://127.0.0.1:${srv.address().port}` };
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

// Fake authorization server (stands in for GoTrue behind the proxy).
const asCalls = [];
const fakeAs = await listen(async (req, res) => {
  const body = await readBody(req);
  asCalls.push({ method: req.method, url: req.url, body });
  res.setHeader('content-type', 'application/json');
  if (req.url === '/auth/v1/.well-known/oauth-authorization-server') {
    res.end(JSON.stringify({
      issuer: 'https://auth.example.invalid/auth/v1',
      authorization_endpoint: 'https://auth.example.invalid/auth/v1/oauth/authorize',
      token_endpoint: 'https://auth.example.invalid/auth/v1/oauth/token',
      registration_endpoint: 'https://auth.example.invalid/auth/v1/oauth/clients/register',
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['openid', 'profile', 'email'],
    }));
    return;
  }
  if (req.url === '/auth/v1/oauth/token' && req.method === 'POST') {
    const form = new URLSearchParams(body);
    if (form.get('refresh_token') === 'bad') {
      res.statusCode = 400;
      res.end(JSON.stringify({ code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' }));
      return;
    }
    if (form.get('refresh_token') === 'rfc') {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'already RFC' }));
      return;
    }
    res.end(JSON.stringify({ access_token: 'a', token_type: 'bearer', refresh_token: 'r2', expires_in: 3600 }));
    return;
  }
  if (req.url === '/auth/v1/oauth/clients/register' && req.method === 'POST') {
    res.statusCode = 201;
    res.end(JSON.stringify({ ...JSON.parse(body || '{}'), client_id: 'test-client-id' }));
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});

// Fake sota-api: records the key it was called with.
const apiCalls = [];
const fakeApi = await listen((req, res) => {
  apiCalls.push({ url: req.url, auth: req.headers.authorization });
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith('/v1/projects')) {
    res.end(JSON.stringify({ data: [{ id: 'p1', name: 'Demo', slug: 'demo', url: 'https://demo.sota.io' }] }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: { code: 'not_found', message: 'nope' } }));
});

const PORT = await freePort();
const ORIGIN = `http://127.0.0.1:${PORT}`;
process.env.PUBLIC_ORIGIN = ORIGIN;
process.env.AUTH_SERVER = `${fakeAs.base}/auth/v1`;
process.env.SOTA_API_URL = fakeApi.base;
process.env.SUPABASE_JWT_SECRET = 'test-secret-for-connect-auth-tests-only-0123456789';
delete process.env.DATABASE_URL;
delete process.env.MCP_ANONYMOUS_DISCOVERY;
process.env.MCP_DISCOVERY_RATE_PER_IP = '5';

const { app } = await import('../dist/http-app.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { UnauthorizedError } = await import('@modelcontextprotocol/sdk/client/auth.js');

const server = app.listen(PORT, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
test.after(() => {
  server.close();
  fakeAs.srv.close();
  fakeApi.srv.close();
});

const KEY = 'sota_' + 'a'.repeat(40);
const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
};

function post(path, body, headers = {}) {
  return fetch(`${ORIGIN}${path}`, {
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

function challenge(res) {
  const h = res.headers.get('www-authenticate') ?? '';
  const params = Object.fromEntries([...h.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  return { raw: h, ...params };
}

// ── /mcp: 401 at connect time ─────────────────────────────────────────────

test('/mcp: anonymous initialize gets 401 + WWW-Authenticate with the /mcp metadata URL', async () => {
  const res = await post('/mcp', INIT);
  assert.equal(res.status, 401);
  const c = challenge(res);
  assert.match(c.raw, /^Bearer /);
  assert.equal(c.resource_metadata, `${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(c.scope, 'profile email');
  assert.equal(c.error, undefined, 'no error code without any credential (RFC 6750 §3.1)');
  const body = await res.json();
  assert.equal(body.id, 1);
  assert.equal(body.reason, 'missing_token');
});

test('/mcp: anonymous tools/list, prompts/list and create_account get 401 too', async () => {
  for (const body of [
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'prompts/list' },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_account', arguments: { email: 'a@example.com' } } },
  ]) {
    const res = await post('/mcp', body);
    assert.equal(res.status, 401, body.method);
  }
});

test('/mcp: anonymous GET gets 401, GET with a credential 405', async () => {
  const anon = await fetch(`${ORIGIN}/mcp`);
  assert.equal(anon.status, 401);
  assert.match(anon.headers.get('www-authenticate'), /resource_metadata=/);
  const withKey = await fetch(`${ORIGIN}/mcp`, { headers: { authorization: `Bearer ${KEY}` } });
  assert.equal(withKey.status, 405);
});

test('/mcp: an invalid JWT gets 401 with error="invalid_token" (RFC 6750), our reason in error_description', async () => {
  const res = await post('/mcp', INIT, { authorization: 'Bearer not.a.jwt' });
  assert.equal(res.status, 401);
  const c = challenge(res);
  assert.equal(c.error, 'invalid_token');
  assert.ok(c.error_description, 'internal reason kept');
  assert.equal(c.resource_metadata, `${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
});

test('GET with a bad credential gets 401, not 405 (token checked first)', async () => {
  for (const path of ['/mcp', '/mcp/signup']) {
    const jwt = await fetch(`${ORIGIN}${path}`, { headers: { authorization: 'Bearer not.a.jwt' } });
    assert.equal(jwt.status, 401, path);
    assert.match(jwt.headers.get('www-authenticate'), /error="invalid_token"/);
    const key = await fetch(`${ORIGIN}${path}`, { headers: { authorization: 'Bearer sota_short' } });
    assert.equal(key.status, 401, path);
  }
});

test('/mcp/signup: a signed-in caller may send a large body (inline deploy), an anonymous one may not', async () => {
  const big = { jsonrpc: '2.0', id: 9, method: 'tools/list', params: { _meta: { pad: 'x'.repeat(2 * 1024 * 1024) } } };
  const withKey = await post('/mcp/signup', big, { authorization: `Bearer ${KEY}` });
  assert.equal(withKey.status, 200);
  const anon = await post('/mcp/signup', big);
  assert.equal(anon.status, 413);
});

test('/mcp: a sota_ API key still works (initialize, tools/list, a tool call with that key)', async () => {
  const init = await post('/mcp', INIT, { authorization: `Bearer ${KEY}` });
  assert.equal(init.status, 200);
  const list = await rpcResult(await post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { authorization: `Bearer ${KEY}` }));
  assert.ok(list.result.tools.some((t) => t.name === 'deploy'));
  apiCalls.length = 0;
  const call = await rpcResult(
    await post('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list-projects', arguments: {} } }, { authorization: `Bearer ${KEY}` }),
  );
  assert.ok(!call.result.isError, JSON.stringify(call));
  assert.ok(apiCalls.some((c) => c.url.startsWith('/v1/projects') && c.auth === `Bearer ${KEY}`));
});

// ── metadata documents ────────────────────────────────────────────────────

test('protected-resource metadata: resource equals the URL the client connects to', async () => {
  const cases = [
    ['/.well-known/oauth-protected-resource/mcp', `${ORIGIN}/mcp`],
    ['/.well-known/oauth-protected-resource/mcp/signup', `${ORIGIN}/mcp/signup`],
    // Root document unchanged from 1.8.0.
    ['/.well-known/oauth-protected-resource', ORIGIN],
  ];
  for (const [path, resource] of cases) {
    const res = await fetch(`${ORIGIN}${path}`);
    assert.equal(res.status, 200, path);
    const doc = await res.json();
    assert.equal(doc.resource, resource, path);
    assert.deepEqual(doc.authorization_servers, [`${ORIGIN}/auth/v1`]);
    assert.deepEqual(doc.scopes_supported, ['profile', 'email']);
    assert.deepEqual(doc.bearer_methods_supported, ['header']);
  }
});

test('authorization-server metadata: every discovery URL derived from the issuer answers the rewritten document', async () => {
  for (const path of [
    '/.well-known/oauth-authorization-server/auth/v1',
    '/.well-known/openid-configuration/auth/v1',
    '/auth/v1/.well-known/openid-configuration',
    '/auth/v1/.well-known/oauth-authorization-server',
  ]) {
    const res = await fetch(`${ORIGIN}${path}`);
    assert.equal(res.status, 200, path);
    const doc = await res.json();
    assert.equal(doc.authorization_endpoint, `${ORIGIN}/auth/v1/oauth/authorize`, path);
    assert.equal(doc.token_endpoint, `${ORIGIN}/auth/v1/oauth/token`, path);
    assert.equal(doc.registration_endpoint, `${ORIGIN}/auth/v1/oauth/clients/register`, path);
    assert.ok(!doc.scopes_supported.includes('openid'), path);
  }
});

// ── /mcp/signup: anonymous sign-up from a chat ────────────────────────────

test('/mcp/signup: anonymous discovery works, protected tools get 401 with the signup metadata URL', async () => {
  const init = await post('/mcp/signup', INIT);
  assert.equal(init.status, 200);
  const list = await rpcResult(await post('/mcp/signup', { jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  assert.ok(list.result.tools.some((t) => t.name === 'create_account'));
  const call = await post('/mcp/signup', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list-projects', arguments: {} } });
  assert.equal(call.status, 401);
  assert.equal(challenge(call).resource_metadata, `${ORIGIN}/.well-known/oauth-protected-resource/mcp/signup`);
  assert.equal((await fetch(`${ORIGIN}/mcp/signup`)).status, 405);
});

test('MCP_ANONYMOUS_DISCOVERY=true restores the 1.8.0 behaviour on /mcp (rollback switch)', async () => {
  process.env.MCP_ANONYMOUS_DISCOVERY = 'true';
  try {
    assert.equal((await post('/mcp', INIT)).status, 200);
    const call = await post('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list-projects', arguments: {} } });
    assert.equal(call.status, 401);
  } finally {
    delete process.env.MCP_ANONYMOUS_DISCOVERY;
  }
  assert.equal((await post('/mcp', INIT)).status, 401);
});

// ── a client that authenticates only on a connect-time 401 ────────────────

function connectOnlyAuthProvider() {
  const rec = { redirects: [], client: undefined, tokens: undefined, verifier: undefined };
  return {
    rec,
    get redirectUrl() {
      return 'https://claude.ai/api/mcp/auth_callback';
    },
    get clientMetadata() {
      return {
        client_name: 'connect-only test client',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };
    },
    clientInformation: () => rec.client,
    saveClientInformation: (c) => {
      rec.client = c;
    },
    tokens: () => rec.tokens,
    saveTokens: (t) => {
      rec.tokens = t;
    },
    redirectToAuthorization: (url) => {
      rec.redirects.push(url);
    },
    saveCodeVerifier: (v) => {
      rec.verifier = v;
    },
    codeVerifier: () => rec.verifier,
  };
}

test('simulated client: connecting to /mcp starts OAuth (DCR + authorize URL with resource=/mcp)', async () => {
  const provider = connectOnlyAuthProvider();
  const client = new Client({ name: 'connect-only', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { authProvider: provider });
  await assert.rejects(client.connect(transport), (err) => err instanceof UnauthorizedError);
  assert.equal(provider.rec.redirects.length, 1, 'the client opened the sign-in');
  const authorize = provider.rec.redirects[0];
  assert.equal(`${authorize.origin}${authorize.pathname}`, `${ORIGIN}/auth/v1/oauth/authorize`);
  assert.equal(authorize.searchParams.get('resource'), `${ORIGIN}/mcp`);
  assert.equal(authorize.searchParams.get('client_id'), 'test-client-id');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(asCalls.some((c) => c.url === '/auth/v1/oauth/clients/register'), 'dynamic client registration went through the proxy');
  await client.close().catch(() => {});

  // After the sign-in the client holds a credential and the same URL works.
  provider.rec.tokens = { access_token: KEY, token_type: 'Bearer' };
  const again = new Client({ name: 'connect-only', version: '0' });
  await again.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { authProvider: provider }));
  const { tools } = await again.listTools();
  assert.ok(tools.some((t) => t.name === 'list-projects'));
  await again.close();
});

test('simulated client: the same client on /mcp/signup connects without sign-in (lazy authentication)', async () => {
  const provider = connectOnlyAuthProvider();
  const client = new Client({ name: 'connect-only', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp/signup`), { authProvider: provider }));
  assert.equal(provider.rec.redirects.length, 0);
  const { tools } = await client.listTools();
  assert.ok(tools.some((t) => t.name === 'create_account'));
  await client.close();
});

// ── /mcp/discover: anonymous, read-only listing ───────────────────────────

let ipSeq = 0;
const freshIp = () => `198.51.100.${++ipSeq}`;

test('/mcp/discover: initialize, tools/list and prompts/list work anonymously; the list equals the signed-in list on /mcp', async () => {
  const ip = freshIp();
  const init = await post('/mcp/discover', INIT, { 'x-forwarded-for': ip });
  assert.equal(init.status, 200);
  const anon = await rpcResult(await post('/mcp/discover', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'x-forwarded-for': ip }));
  const authed = await rpcResult(await post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { authorization: `Bearer ${KEY}` }));
  assert.deepEqual(anon.result.tools, authed.result.tools);
  assert.ok(anon.result.tools.every((t) => t.title && t.annotations && t.inputSchema && t.description));
  const prompts = await rpcResult(await post('/mcp/discover', { jsonrpc: '2.0', id: 3, method: 'prompts/list' }, { 'x-forwarded-for': ip }));
  assert.ok(prompts.result.prompts.length >= 1);
});

test('/mcp/discover: every tool call (and prompts/get) is refused with a JSON-RPC error naming /mcp; nothing reaches the API', async () => {
  apiCalls.length = 0;
  for (const [i, body] of [
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list-projects', arguments: {} } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'create_account', arguments: { email: 'a@example.com' } } },
    { jsonrpc: '2.0', id: 6, method: 'prompts/get', params: { name: 'enterprise-app-checklist' } },
  ].entries()) {
    const res = await post('/mcp/discover', body, { 'x-forwarded-for': freshIp() });
    assert.equal(res.status, 403, String(i));
    const j = await res.json();
    assert.equal(j.id, body.id);
    assert.equal(j.error.code, -32601);
    assert.ok(j.error.message.includes(`${ORIGIN}/mcp `) || j.error.message.includes(`${ORIGIN}/mcp and`), j.error.message);
    assert.equal(res.headers.get('www-authenticate'), null, 'discovery never starts OAuth');
  }
  assert.equal(apiCalls.length, 0);
});

test('/mcp/discover: a request with any credential is refused', async () => {
  for (const auth of [`Bearer ${KEY}`, 'Bearer not.a.jwt', 'Basic eDp5']) {
    const res = await post('/mcp/discover', { jsonrpc: '2.0', id: 7, method: 'tools/list' }, { authorization: auth, 'x-forwarded-for': freshIp() });
    assert.equal(res.status, 400, auth);
    assert.match((await res.json()).error.message, /takes no credentials/);
  }
});

test('/mcp/discover: a body above 64 KB gets 413, a batch is refused', async () => {
  const big = { jsonrpc: '2.0', id: 8, method: 'tools/list', params: { _meta: { pad: 'x'.repeat(100 * 1024) } } };
  assert.equal((await post('/mcp/discover', big, { 'x-forwarded-for': freshIp() })).status, 413);
  assert.equal((await post('/mcp/discover', [INIT], { 'x-forwarded-for': freshIp() })).status, 400);
});

test('/mcp/discover: rate-limited per client address (429 + Retry-After)', async () => {
  const ip = freshIp();
  for (let i = 0; i < 5; i++) assert.equal((await post('/mcp/discover', INIT, { 'x-forwarded-for': ip })).status, 200);
  const limited = await post('/mcp/discover', INIT, { 'x-forwarded-for': ip });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal((await post('/mcp/discover', INIT, { 'x-forwarded-for': freshIp() })).status, 200, 'another address is not affected');
});

// ── token endpoint: RFC 6749 errors ───────────────────────────────────────

test('token proxy: a GoTrue refresh error gets error="invalid_grant"; success and RFC bodies pass unchanged', async () => {
  const tok = (rt) =>
    fetch(`${ORIGIN}/auth/v1/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: 'c' }),
    });
  const bad = await tok('bad');
  assert.equal(bad.status, 400);
  const bj = await bad.json();
  assert.equal(bj.error, 'invalid_grant');
  assert.equal(bj.error_code, 'refresh_token_not_found');
  assert.match(bj.error_description, /Refresh Token Not Found/);
  const rfc = await (await tok('rfc')).json();
  assert.deepEqual(rfc, { error: 'invalid_grant', error_description: 'already RFC' });
  const ok = await tok('good');
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).refresh_token, 'r2');
});
