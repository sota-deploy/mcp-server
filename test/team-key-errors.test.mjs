// A team key that was revoked (or whose membership ended) or that expired:
// the tool error is the API's plain message, readable for a non-programmer.
// Run with: npm test (builds dist/ first).

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { SotaClient } = await import('@sota-io/sdk');
const { registerAccountTool } = await import('../dist/tools/account.js');
const { registerProjectTools } = await import('../dist/tools/projects.js');
const { registerEnvTools } = await import('../dist/tools/env.js');
const { accountReader } = await import('../dist/lib/account.js');

const REVOKED = 'This sota team key ("laptop") no longer works: it was revoked, or your access to the account that shared its apps with you ended. Ask an admin of that account.';
const EXPIRED = 'This sota team key ("laptop") expired on 1 March 2027. Create a new one in the sota dashboard under Team keys.';

async function fakeApi(code, message) {
  const server = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code, message } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

async function connect(apiUrl) {
  const server = new McpServer({ name: 't', version: '0' });
  const key = 'sota_0000000000000000000000000000000000000000';
  const client = new SotaClient({ apiKey: key, baseUrl: apiUrl });
  const readAccount = accountReader(apiUrl, key);
  registerAccountTool(server, readAccount);
  registerProjectTools(server, client, { readAccount });
  registerEnvTools(server, client);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const c = new Client({ name: 'c', version: '0' });
  await c.connect(a);
  return { c, close: () => Promise.all([c.close(), server.close()]) };
}

const text = (r) => r.content.map((x) => x.text).join('\n');

for (const [code, message] of [['team_key_revoked', REVOKED], ['team_key_expired', EXPIRED]]) {
  test(`${code}: every tool shows the plain message`, async () => {
    const api = await fakeApi(code, message);
    const { c, close } = await connect(api.url);
    try {
      for (const [name, args] of [['list-projects', {}], ['get-env', { project_id: 'p1' }]]) {
        const r = await c.callTool({ name, arguments: args });
        assert.equal(r.isError, true, `${name} is an error`);
        assert.ok(text(r).includes(message), `${name}: ${text(r)}`);
        assert.ok(!/SotaAPIError|at .*\.js:\d+/.test(text(r)), `${name} shows internals: ${text(r)}`);
      }
      const r = await c.callTool({ name: 'get-account', arguments: {} });
      assert.equal(r.isError, true);
      assert.ok(text(r).startsWith(`Failed to read the account: ${message}`), text(r));
      assert.ok(!text(r).includes('GET /v1/account failed'), 'no HTTP jargon in front of the message');
    } finally {
      await close();
      await api.close();
    }
  });
}
