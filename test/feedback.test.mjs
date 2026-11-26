// Base64 inline
// files, waiting for a deployment, redeploy, masked env values.
// Run with: npm test (builds dist/ first).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { archiveFromFiles, decodeInlineFile, ArchiveBuilderError, MAX_INLINE_TOTAL_BYTES } = await import('../dist/lib/archive-builder.js');
const { waitForDeployment, boundedWaitMs, MAX_WAIT_SECONDS, DEFAULT_WAIT_SECONDS } = await import('../dist/lib/wait.js');
const { registerDeployTool } = await import('../dist/tools/deploy.js');
const { registerStatusTool } = await import('../dist/tools/status.js');
const { registerRedeployTool } = await import('../dist/tools/redeploy.js');
const { registerEnvTools, maskValue } = await import('../dist/tools/env.js');

// 1x1 transparent PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function connect(register) {
  const server = new McpServer({ name: 't', version: '0' });
  register(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'c', version: '0' });
  await client.connect(a);
  return { client, close: () => Promise.all([client.close(), server.close()]) };
}

const text = (r) => r.content.map((c) => c.text).join('\n');

/** Fake API: listDeployments walks through the given statuses, one per read. */
function fakeApi({ statuses = ['running'], error } = {}) {
  let reads = 0;
  const calls = { deploy: 0, list: 0, redeploy: 0, setEnv: [] };
  return {
    calls,
    async deploy() {
      calls.deploy++;
      return { id: 'dep-new', status: 'pending' };
    },
    async listDeployments() {
      calls.list++;
      const status = statuses[Math.min(reads++, statuses.length - 1)];
      return [
        { id: 'dep-new', status, created_at: 't2', error_message: status === 'failed' ? error : undefined },
        { id: 'dep-old', status: 'running', created_at: 't1' },
      ];
    },
  };
}

// ── base64 inline files ────────────────────────────────────────────────────

test('base64 files decode to their bytes; plain strings stay UTF-8 text', () => {
  const png = decodeInlineFile('public/logo.png', { content: PNG_B64, encoding: 'base64' });
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(decodeInlineFile('a.txt', 'héllo').toString('utf8'), 'héllo');
  assert.equal(decodeInlineFile('a.txt', { content: 'x', encoding: 'utf8' }).toString(), 'x');
  // Unpadded and line-wrapped base64 is accepted.
  const wrapped = PNG_B64.replace(/=+$/, '').replace(/(.{20})/g, '$1\n');
  assert.deepEqual(decodeInlineFile('w.png', { content: wrapped, encoding: 'base64' }), png);
});

test('a base64 PNG ships byte for byte in the archive', () => {
  const archive = archiveFromFiles({
    'index.js': 'console.log(1)',
    'public/logo.png': { content: PNG_B64, encoding: 'base64' },
  });
  const dir = mkdtempSync(join(tmpdir(), 'b64-'));
  try {
    writeFileSync(join(dir, 'a.tgz'), archive);
    execFileSync('tar', ['-xzf', join(dir, 'a.tgz'), '-C', dir]);
    assert.deepEqual(readFileSync(join(dir, 'public/logo.png')), Buffer.from(PNG_B64, 'base64'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid base64 is rejected with the path', () => {
  for (const bad of ['not base64!', 'abc=d', 'a', 'iVBORw0KGgo-_x', PNG_B64.slice(0, 13)]) {
    assert.throws(
      () => archiveFromFiles({ 'img/x.png': { content: bad, encoding: 'base64' } }),
      (err) => err instanceof ArchiveBuilderError && err.code === 'invalid_base64' && err.message.includes('img/x.png'),
      bad,
    );
  }
  assert.throws(() => archiveFromFiles({ 'x.bin': { content: 'AA==', encoding: 'hex' } }), (e) => e.code === 'bad_encoding');
  assert.throws(() => archiveFromFiles({ 'x.bin': { encoding: 'base64' } }), (e) => e.code === 'bad_file');
});

test('the size limit counts decoded bytes', () => {
  // Base64 of exactly the limit is ~13.3 MB of text but 10 MB decoded: accepted.
  const atLimit = Buffer.alloc(MAX_INLINE_TOTAL_BYTES, 1).toString('base64');
  assert.ok(archiveFromFiles({ 'big.bin': { content: atLimit, encoding: 'base64' } }).length > 0);
  const over = Buffer.alloc(MAX_INLINE_TOTAL_BYTES + 1, 1).toString('base64');
  assert.throws(() => archiveFromFiles({ 'big.bin': { content: over, encoding: 'base64' } }), (e) => e.code === 'inline_too_large');
});

test('deploy schema takes { content, encoding } in both transports and the description names the limits', async () => {
  for (const hosted of [true, false]) {
    const api = fakeApi();
    const { client, close } = await connect((s) => registerDeployTool(s, api, { hosted, pollIntervalMs: 1 }));
    try {
      const { tools } = await client.listTools();
      const deploy = tools.find((t) => t.name === 'deploy');
      assert.match(deploy.description, /base64/);
      assert.match(deploy.description, /200 files and 10 MB/);
      const r = await client.callTool({
        name: 'deploy',
        arguments: { project_id: 'p', files: { 'index.js': 'x', 'logo.png': { content: PNG_B64, encoding: 'base64' } } },
      });
      assert.notEqual(r.isError, true, text(r));
      assert.equal(api.calls.deploy, 1);
      const bad = await client.callTool({
        name: 'deploy',
        arguments: { project_id: 'p', files: { 'logo.png': { content: '%%%', encoding: 'base64' } } },
      });
      assert.equal(bad.isError, true);
      assert.match(text(bad), /invalid_base64.*logo\.png/);
      assert.equal(api.calls.deploy, 1, 'nothing uploaded for invalid base64');
    } finally {
      await close();
    }
  }
});

// ── waiting ────────────────────────────────────────────────────────────────

test('wait bounds: default 40 s, at most 50 s (inside the 60 s client default)', () => {
  assert.equal(DEFAULT_WAIT_SECONDS, 40);
  assert.equal(MAX_WAIT_SECONDS, 50);
  assert.equal(boundedWaitMs(undefined), 40000);
  assert.equal(boundedWaitMs(500), 50000);
  assert.equal(boundedWaitMs(-3), 0);
});

test('waitForDeployment stops at a finished status or at the bound', async () => {
  let t = 0;
  const clock = { now: () => t, sleep: async (ms) => { t += ms; } };
  const done = await waitForDeployment(fakeApi({ statuses: ['building', 'deploying', 'running'] }), 'p', 'dep-new', { maxWaitMs: 40000, intervalMs: 3000, ...clock });
  assert.equal(done.finished, true);
  assert.equal(done.deployment.status, 'running');
  assert.equal(done.waitedMs, 6000);

  t = 0;
  const early = await waitForDeployment(fakeApi({ statuses: ['building'] }), 'p', 'dep-new', { maxWaitMs: 10000, intervalMs: 3000, ...clock });
  assert.equal(early.finished, false);
  assert.ok(early.waitedMs <= 10000);
});

test('deploy waits for the result: one call instead of a polling loop', async () => {
  const api = fakeApi({ statuses: ['building', 'building', 'failed'], error: 'health check failed: container did not become healthy within 1m0s; last probe: GET /health answered HTTP 500' });
  const { client, close } = await connect((s) => registerDeployTool(s, api, { hosted: true, pollIntervalMs: 1 }));
  try {
    const r = text(await client.callTool({ name: 'deploy', arguments: { project_id: 'p', files: { 'a.js': 'x' } } }));
    assert.match(r, /Result:/);
    assert.match(r, /Status: failed/);
    assert.match(r, /answered HTTP 500/);
    assert.equal(api.calls.list, 3);
  } finally {
    await close();
  }
});

test('deploy with wait: false returns after the upload and points at get-status wait_for', async () => {
  const api = fakeApi();
  const { client, close } = await connect((s) => registerDeployTool(s, api, { hosted: true }));
  try {
    const r = text(await client.callTool({ name: 'deploy', arguments: { project_id: 'p', files: { 'a.js': 'x' }, wait: false } }));
    assert.match(r, /wait_for: "finished"/);
    assert.equal(api.calls.list, 0);
  } finally {
    await close();
  }
});

test('get-status wait_for finished waits; an early return carries retry_after_seconds', async () => {
  const api = fakeApi({ statuses: ['building', 'running'] });
  const { client, close } = await connect((s) => registerStatusTool(s, api, { pollIntervalMs: 1 }));
  try {
    const r = text(await client.callTool({ name: 'get-status', arguments: { project_id: 'p', wait_for: 'finished', deployment_id: 'dep-new' } }));
    assert.match(r, /Status: running/);
    assert.match(r, /Finished/);
    assert.doesNotMatch(r, /retry_after_seconds/);

    const slow = fakeApi({ statuses: ['building'] });
    const c2 = await connect((s) => registerStatusTool(s, slow, { pollIntervalMs: 1 }));
    try {
      const r2 = text(await c2.client.callTool({ name: 'get-status', arguments: { project_id: 'p', wait_for: 'finished', max_wait_seconds: 0 } }));
      assert.match(r2, /Status: building/);
      assert.match(r2, /retry_after_seconds: 5/);
      assert.match(r2, /get-status with wait_for: "finished"/);
    } finally {
      await c2.close();
    }

    // Without wait_for: one read, no wait.
    const once = fakeApi({ statuses: ['building'] });
    const c3 = await connect((s) => registerStatusTool(s, once));
    try {
      await c3.client.callTool({ name: 'get-status', arguments: { project_id: 'p' } });
      assert.equal(once.calls.list, 1);
    } finally {
      await c3.close();
    }
  } finally {
    await close();
  }
});

test('get-status sends progress notifications while waiting when the client asks', async () => {
  const api = fakeApi({ statuses: ['building', 'building', 'running'] });
  const { client, close } = await connect((s) => registerStatusTool(s, api, { pollIntervalMs: 1 }));
  try {
    const seen = [];
    await client.callTool(
      { name: 'get-status', arguments: { project_id: 'p', wait_for: 'finished' } },
      undefined,
      { onprogress: (p) => seen.push(p) },
    );
    assert.equal(seen.length, 2);
    assert.match(seen[0].message, /building/);
  } finally {
    await close();
  }
});

// ── redeploy ───────────────────────────────────────────────────────────────

test('redeploy returns the API result; failure shows the reason', async () => {
  for (const [dep, failed] of [
    [{ id: 'r1', status: 'running', created_at: 't' }, false],
    [{ id: 'r1', status: 'failed', created_at: 't', error_message: 'health check failed: container did not become healthy within 1m0s; last probe: GET / answered HTTP 401' }, true],
  ]) {
    const api = { async redeploy(id) { assert.equal(id, 'p'); return dep; } };
    const { client, close } = await connect((s) => registerRedeployTool(s, api));
    try {
      const r = await client.callTool({ name: 'redeploy', arguments: { project_id: 'p' } });
      assert.equal(r.isError === true, failed);
      assert.match(text(r), new RegExp(`Status: ${dep.status}`));
      if (failed) assert.match(text(r), /answered HTTP 401/);
    } finally {
      await close();
    }
  }
});

test('redeploy that outlasts the wait keeps running (request not aborted) and points at get-status', async () => {
  let finished = false;
  const api = {
    redeploy: () => new Promise((resolve) => setTimeout(() => { finished = true; resolve({ id: 'r1', status: 'running' }); }, 1500)),
  };
  const { client, close } = await connect((s) => registerRedeployTool(s, api));
  try {
    // max_wait_seconds 6 minus the 5 s headroom: about 1 s of waiting.
    const t0 = Date.now();
    const r = text(await client.callTool({ name: 'redeploy', arguments: { project_id: 'p', max_wait_seconds: 6 } }));
    assert.ok(Date.now() - t0 < 1400, 'stopped at max_wait_seconds minus the headroom');
    assert.match(r, /still running after 1 s/);
    assert.match(r, /wait_for: "finished"/);
    assert.equal(finished, false);
    await new Promise((res) => setTimeout(res, 700));
    assert.equal(finished, true, 'the API call ran to its end');
  } finally {
    await close();
  }
});

test('redeploy refusals (no running deployment, deploy in progress) are errors, also with wait: false', async () => {
  const api = { async redeploy() { throw new Error('conflict: no running deployment to redeploy'); } };
  const { client, close } = await connect((s) => registerRedeployTool(s, api));
  try {
    const r = await client.callTool({ name: 'redeploy', arguments: { project_id: 'p', wait: false } });
    assert.equal(r.isError, true);
    assert.match(text(r), /no running deployment/);
  } finally {
    await close();
  }
});

// ── env ────────────────────────────────────────────────────────────────────

test('maskValue: prefix only for values of 12+ characters, always the length', () => {
  assert.equal(maskValue('fixture-key-abcdefghijkl'), 'fixt… (24 chars)');
  assert.equal(maskValue('short-pw'), '… (8 chars)');
  assert.equal(maskValue(''), '(empty)');
  assert.equal(maskValue(undefined), '(empty)');
});

// Built at run time so no credential-shaped literal sits in the source.
const FIXTURE_PW = ['dbpw', 'fixture', '13'].join('');

function envApi() {
  const calls = { set: [] };
  return {
    calls,
    async listEnvVars() {
      return [
        { key: 'API_KEY', value: 'fixture-key-abcdefghijkl' },
        { key: 'DATABASE_URL', value: ['postgresql://app_x', FIXTURE_PW].join(':') + '@pgbouncer:5432/db?sslmode=disable' },
        { key: 'PGPASSWORD', value: FIXTURE_PW },
      ];
    },
    async setEnvVar(id, kv) { calls.set.push([id, kv]); },
  };
}

test('get-env masks by default and marks managed variables; reveal needs one key', async () => {
  const { client, close } = await connect((s) => registerEnvTools(s, envApi()));
  try {
    const all = text(await client.callTool({ name: 'get-env', arguments: { project_id: 'p' } }));
    assert.ok(!all.includes(FIXTURE_PW), all);
    assert.ok(!all.includes('abcdefghijkl'), all);
    assert.match(all, /API_KEY=fixt… \(24 chars\)\n/);
    assert.match(all, /DATABASE_URL=… \(\d+ chars\) \(managed\)/);
    assert.match(all, /PGPASSWORD=… \(13 chars\) \(managed\)/);
    assert.ok(!all.includes('dbpw'), 'no prefix of the database password');

    const one = text(await client.callTool({ name: 'get-env', arguments: { project_id: 'p', key: 'API_KEY' } }));
    assert.equal(one, 'API_KEY=fixt… (24 chars)');
    const shown = text(await client.callTool({ name: 'get-env', arguments: { project_id: 'p', key: 'API_KEY', reveal: true } }));
    assert.equal(shown, 'API_KEY=fixture-key-abcdefghijkl');

    const noKey = await client.callTool({ name: 'get-env', arguments: { project_id: 'p', reveal: true } });
    assert.equal(noKey.isError, true);
    assert.ok(!text(noKey).includes('fixture-key'));
    const missing = await client.callTool({ name: 'get-env', arguments: { project_id: 'p', key: 'NOPE', reveal: true } });
    assert.equal(missing.isError, true);

    const { tools } = await client.listTools();
    assert.match(tools.find((t) => t.name === 'get-env').description, /do not reveal them into the conversation unless the user asks/);
  } finally {
    await close();
  }
});

test('set-env result names redeploy', async () => {
  const api = envApi();
  const { client, close } = await connect((s) => registerEnvTools(s, api));
  try {
    const r = text(await client.callTool({ name: 'set-env', arguments: { project_id: 'p', key: 'A', value: 'b' } }));
    assert.match(r, /call redeploy/);
    assert.ok(!r.includes('"b"') && !r.includes('=b'), 'the value is not echoed');
  } finally {
    await close();
  }
});

// ── review fixes ──────────────────────────────────────────────────────────

test('managed values need include_managed to be revealed; short values show no prefix', async () => {
  const { client, close } = await connect((s) => registerEnvTools(s, envApi()));
  try {
    const refused = await client.callTool({ name: 'get-env', arguments: { project_id: 'p', key: 'PGPASSWORD', reveal: true } });
    assert.equal(refused.isError, true);
    assert.ok(!text(refused).includes(FIXTURE_PW));
    assert.match(text(refused), /include_managed: true/);
    const shown = text(await client.callTool({ name: 'get-env', arguments: { project_id: 'p', key: 'PGPASSWORD', reveal: true, include_managed: true } }));
    assert.equal(shown, `PGPASSWORD=${FIXTURE_PW} (managed)`);
    const { tools } = await client.listTools();
    assert.match(tools.find((t) => t.name === 'get-env').description, /not access control/);
  } finally {
    await close();
  }
  assert.equal(maskValue('nineteen-characters'), '… (19 chars)');
  assert.equal(maskValue('twenty--characters!!'), 'twen… (20 chars)');
});

test('get-env uses the API managed flag when the API sends it, names only as a fallback', async () => {
  const flagged = {
    async listEnvVars() {
      return [
        { key: 'DATABASE_URL', value: 'user-set-without-a-managed-db-0123456789' }, // no flag: the user's own
        { key: 'PGPASSWORD', value: FIXTURE_PW, managed: true },
      ];
    },
  };
  const { client, close } = await connect((s) => registerEnvTools(s, flagged));
  try {
    const all = text(await client.callTool({ name: 'get-env', arguments: { project_id: 'p' } }));
    assert.match(all, /DATABASE_URL=user… \(40 chars\)\n/);
    assert.match(all, /PGPASSWORD=… \(13 chars\) \(managed\)/);
    const own = text(await client.callTool({ name: 'get-env', arguments: { project_id: 'p', key: 'DATABASE_URL', reveal: true } }));
    assert.equal(own, 'DATABASE_URL=user-set-without-a-managed-db-0123456789');
  } finally {
    await close();
  }
  const { managedKeys } = await import('../dist/tools/env.js');
  // Older API without the flag: the known names count as managed.
  assert.deepEqual([...managedKeys([{ key: 'PGHOST' }, { key: 'A' }])], ['PGHOST']);
});

test('two entries naming the same file are refused', () => {
  for (const files of [{ a: 'x', './a': 'y' }, { 'src/a.js': 'x', '/src/a.js': 'y' }]) {
    assert.throws(() => archiveFromFiles(files), (e) => e.code === 'bad_path' && /same file/.test(e.message));
  }
});

test('base64 is validated without copies: length check catches characters Node would skip', () => {
  // A non-breaking space is not base64 whitespace; Node silently skips it.
  assert.throws(() => decodeInlineFile('x.png', { content: PNG_B64.slice(0, 8) + ' ' + PNG_B64.slice(8), encoding: 'base64' }), (e) => e.code === 'invalid_base64');
  assert.throws(() => decodeInlineFile('x.png', { content: 'AAAA===', encoding: 'base64' }), (e) => e.code === 'invalid_base64');
});

test('a third concurrent deploy is told to retry and uploads nothing', async () => {
  const { DEPLOY_UPLOADS } = await import('../dist/lib/upload-gate.js');
  const held = [DEPLOY_UPLOADS.tryAcquire(), DEPLOY_UPLOADS.tryAcquire()];
  const api = fakeApi();
  const { client, close } = await connect((s) => registerDeployTool(s, api, { hosted: true }));
  try {
    const r = await client.callTool({ name: 'deploy', arguments: { project_id: 'p', files: { 'a.js': 'x' } } });
    assert.equal(r.isError, true);
    assert.match(text(r), /busy.*call deploy again in 15 s/);
    assert.equal(api.calls.deploy, 0);
  } finally {
    held.forEach((rel) => rel?.());
    await close();
  }
  assert.equal(DEPLOY_UPLOADS.inUse, 0);
  // The slot is free again after a deploy (also a failed archive build).
  const api2 = fakeApi();
  const c2 = await connect((s) => registerDeployTool(s, api2, { hosted: true, pollIntervalMs: 1 }));
  try {
    await c2.client.callTool({ name: 'deploy', arguments: { project_id: 'p', files: { 'a.png': { content: '%', encoding: 'base64' } } } });
    await c2.client.callTool({ name: 'deploy', arguments: { project_id: 'p', files: { 'a.js': 'x' } } });
    assert.equal(DEPLOY_UPLOADS.inUse, 0);
  } finally {
    await c2.close();
  }
});

test('a slow API never stretches deploy past max_wait_seconds (headroom, bounded reads, parallel lookups)', async () => {
  // Every status read takes 4 s, the account and project lookups 1 s each.
  const slow = {
    calls: { list: 0 },
    async deploy() { return { id: 'dep-new', status: 'pending' }; },
    listDeployments() { this.calls.list++; return new Promise((r) => setTimeout(() => r([{ id: 'dep-new', status: 'building', created_at: 't' }]), 4000)); },
    getProject() { return new Promise((r) => setTimeout(() => r({ url: 'https://x.example' }), 1000)); },
  };
  const readAccount = () => new Promise((r) => setTimeout(() => r(null), 1000));
  const { client, close } = await connect((s) => registerDeployTool(s, slow, { hosted: true, readAccount, lookupTimeoutMs: 1500, readTimeoutMs: 500, pollIntervalMs: 100 }));
  try {
    const t0 = Date.now();
    const r = text(await client.callTool({ name: 'deploy', arguments: { project_id: 'p', files: { 'a.js': 'x' }, max_wait_seconds: 7 } }));
    const took = Date.now() - t0;
    // Budget 7 - 5 = 2 s; reads bounded at 0.5 s; lookups ran in parallel.
    assert.ok(took < 3000, `took ${took} ms`);
    assert.match(r, /retry_after_seconds/);
  } finally {
    await close();
  }
});

test('get-status stops waiting when the client cancels the call', async () => {
  const api = fakeApi({ statuses: ['building'] });
  const { client, close } = await connect((s) => registerStatusTool(s, api, { pollIntervalMs: 50 }));
  try {
    const ac = new AbortController();
    const p = client.callTool({ name: 'get-status', arguments: { project_id: 'p', wait_for: 'finished' } }, undefined, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 200));
    ac.abort();
    await assert.rejects(p);
    await new Promise((r) => setTimeout(r, 100));
    const after = api.calls.list;
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(api.calls.list, after, 'no reads after the cancel');
  } finally {
    await close();
  }
});

test('redeploy stops waiting when the client cancels the call (the redeploy goes on)', async () => {
  let done = false;
  const api = { redeploy: () => new Promise((r) => setTimeout(() => { done = true; r({ id: 'r', status: 'running' }); }, 1500)) };
  const { client, close } = await connect((s) => registerRedeployTool(s, api, { progressIntervalMs: 50 }));
  try {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = client.callTool({ name: 'redeploy', arguments: { project_id: 'p' } }, undefined, { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(p);
    assert.ok(Date.now() - t0 < 1000);
    await new Promise((r) => setTimeout(r, 1600));
    assert.equal(done, true);
  } finally {
    await close();
  }
});
