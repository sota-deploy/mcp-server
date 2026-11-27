// The account/contract guidance an agent gets over MCP.
// Run with: npm test (builds dist/ first).

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const guide = await import('../dist/lib/guide.js');
const { renderAccount, registerAccountTool, registerChecklistPrompt } = await import('../dist/tools/account.js');
const { registerProjectTools } = await import('../dist/tools/projects.js');
const { registerDeployTool } = await import('../dist/tools/deploy.js');
const { registerLogsTool } = await import('../dist/tools/logs.js');
const { registerEnvTools } = await import('../dist/tools/env.js');
const { registerRollbackTool } = await import('../dist/tools/rollback.js');
const { registerRedeployTool } = await import('../dist/tools/redeploy.js');
const { registerStatusTool } = await import('../dist/tools/status.js');
const { registerDomainTools } = await import('../dist/tools/domains.js');
const { accountReader } = await import('../dist/lib/account.js');
const { isIgnored } = await import('../dist/lib/ignore.js');
const { archiveDirectoryWithReport, archiveFromGitUrl } = await import('../dist/lib/archive-builder.js');
const { spawn } = await import('node:child_process');

const ENTERPRISE = {
  user_id: 'u1',
  plan: { name: 'enterprise', max_projects: 10, max_databases: 10, max_custom_domains: 0, max_builds_per_day: 100, max_memory_mb: 512, max_cpu_millicores: 1000, max_deploy_bytes: 500 * 1024 * 1024 },
  usage: { projects: 0, max_projects: 10, databases: 0, max_databases: 10, domains: 0, max_custom_domains: 0 },
  enterprise: {
    customer_label: 'acme',
    landing_url: 'https://acme.sota.io',
    app_host_pattern: '<app>.acme.sota.io',
    app_limit: 10,
    apps_used: 0,
    server_status: 'active',
    sign_in_state: 'saved_untested',
    users_and_access_url: 'https://sota.io/dashboard/enterprise/users',
    sign_in_setup_url: 'https://sota.io/dashboard/enterprise/sign-in',
  },
};
const ORDINARY = { ...ENTERPRISE, plan: { ...ENTERPRISE.plan, name: 'pro' }, enterprise: null };

function fakeSota() {
  return {
    async createProject({ name }) {
      return { id: 'p1', name, slug: `acme-${name}`, url: `https://${name}.acme.sota.io` };
    },
    async getProject() {
      return { id: 'p1', name: 'app', slug: 'acme-app', url: 'https://app.acme.sota.io' };
    },
    async deploy() {
      return { id: 'dep-1', status: 'pending' };
    },
    async listDeployments() {
      return [{ id: 'dep-1', status: 'failed', created_at: 'now', error_message: 'health check failed: container did not become healthy within 1m0s' }];
    },
  };
}

async function connect(register, instructions) {
  const server = new McpServer({ name: 't', version: '0' }, instructions ? { instructions } : undefined);
  register(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'c', version: '0' });
  await client.connect(a);
  return { client, close: () => Promise.all([client.close(), server.close()]) };
}

function text(result) {
  return result.content.map((c) => c.text).join('\n');
}

test('get-account: Enterprise facts, contract and next steps', () => {
  const out = renderAccount(ENTERPRISE);
  for (const s of ['Company label: acme', 'https://<app>.acme.sota.io', '"acme-app"', 'Memory per app: 512 MB',
    'https://sota.io/dashboard/enterprise/users', 'not tested yet']) {
    assert.ok(out.includes(s), `missing ${s}`);
  }
  for (const line of [...guide.BUILD_CONTRACT, ...guide.ENTERPRISE_CONTRACT, ...guide.ENTERPRISE_ACCESS_STEPS]) {
    assert.ok(out.includes(line), `missing contract line: ${line.slice(0, 60)}`);
  }
});

test('get-account: a team member sees the account they act for and their role', () => {
  const out = renderAccount({
    ...ENTERPRISE,
    user_id: 'dev1',
    role: 'developer',
    can_create_projects: false,
    acting_for: { account_user_id: 'u1', account_label: 'acme', role: 'developer', project_scope: 'selected' },
    memberships: [{ account_user_id: 'u1', account_label: 'acme', role: 'developer', project_scope: 'selected' }],
    team_key_expires_at: '2027-02-24T10:00:00Z',
  });
  assert.ok(out.includes('This team key expires on 2027-02-24'), 'missing team key expiry');
  for (const s of ['You work in another account', 'You are developer of the "acme" account', 'the apps shared with you',
    'cannot create or delete apps', 'Company label: acme']) {
    assert.ok(out.includes(s), `missing ${s}`);
  }
  assert.ok(!renderAccount(ENTERPRISE).includes('another account'), 'an owner sees no member section');
});

test('list-projects marks projects shared with the person', async () => {
  const sota = {
    async listProjects() {
      return { projects: [
        { id: 'p1', name: 'shop', slug: 'acme-shop', url: 'https://shop.acme.sota.io', role: 'developer', account_label: 'acme' },
        { id: 'p2', name: 'mine', slug: 'mine', url: 'https://mine.sota.io', role: 'owner' },
      ] };
    },
  };
  const { client, close } = await connect((s) => registerProjectTools(s, sota, {}));
  try {
    const out = text(await client.callTool({ name: 'list-projects', arguments: {} }));
    assert.match(out, /shop \(acme-shop\).*shared by acme, you are developer/);
    assert.doesNotMatch(out, /mine \(mine\).*shared/);
  } finally {
    await close();
  }
});

test('get-account: ordinary account gets no Enterprise contract', () => {
  const out = renderAccount(ORDINARY);
  assert.ok(out.includes('Not an Enterprise account'));
  assert.ok(!out.includes(guide.ENTERPRISE_CONTRACT[1]));
  assert.ok(out.includes(guide.BUILD_CONTRACT[3]));
});

test('get-account tool, prompt and instructions over MCP', async () => {
  const { client, close } = await connect((s) => {
    registerAccountTool(s, async () => ENTERPRISE);
    registerChecklistPrompt(s);
  }, guide.SERVER_INSTRUCTIONS);
  try {
    assert.match(client.getInstructions(), /call get-account once/);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['get-account']);
    assert.match(tools[0].description, /^Call this FIRST/);
    const r = await client.callTool({ name: 'get-account', arguments: {} });
    assert.ok(text(r).includes('Company label: acme'));
    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((p) => p.name), ['enterprise-app-checklist']);
    const p = await client.getPrompt({ name: 'enterprise-app-checklist', arguments: {} });
    assert.ok(p.messages[0].content.text.includes(guide.ENTERPRISE_CONTRACT[4]));
  } finally {
    await close();
  }
});

test('get-account: a failing read is an error result that still carries the contract', async () => {
  const { client, close } = await connect((s) => registerAccountTool(s, async () => { throw new Error('HTTP 503'); }));
  try {
    const r = await client.callTool({ name: 'get-account', arguments: {} });
    assert.equal(r.isError, true);
    assert.ok(text(r).includes('HTTP 503'));
    assert.ok(text(r).includes(guide.BUILD_CONTRACT[0]));
  } finally {
    await close();
  }
});

test('create-project and deploy name the app URL and the owner steps on Enterprise', async () => {
  const sota = fakeSota();
  const readAccount = async () => ENTERPRISE;
  const { client, close } = await connect((s) => {
    registerProjectTools(s, sota, { readAccount });
    registerDeployTool(s, sota, { hosted: true, readAccount });
  });
  try {
    const c = text(await client.callTool({ name: 'create-project', arguments: { name: 'app' } }));
    assert.ok(c.includes('URL: https://app.acme.sota.io'));
    assert.ok(c.includes('Users & access: https://sota.io/dashboard/enterprise/users'));
    assert.ok(c.includes(guide.ENTERPRISE_ACCESS_STEPS[0]));
    assert.ok(c.includes('Sign-in connection: saved but not tested'));
    const d = text(await client.callTool({ name: 'deploy', arguments: { project_id: 'p1', files: { 'server.js': 'x' } } }));
    assert.ok(d.includes('App URL: https://app.acme.sota.io'), d);
    assert.ok(d.includes('Result:') && d.includes('Status: failed'), d);
    assert.ok(d.includes(guide.ENTERPRISE_ACCESS_STEPS[2]));
  } finally {
    await close();
  }
});

test('ordinary account: no Enterprise steps; account read errors never break a deploy', async () => {
  const sota = fakeSota();
  for (const readAccount of [async () => ORDINARY, async () => { throw new Error('down'); }]) {
    const { client, close } = await connect((s) => registerDeployTool(s, sota, { hosted: true, readAccount }));
    try {
      const d = await client.callTool({ name: 'deploy', arguments: { project_id: 'p1', files: { 'a.js': 'x' } } });
      assert.notEqual(d.isError, true);
      assert.ok(!text(d).includes('Users & access'));
    } finally {
      await close();
    }
  }
});

test('get-status shows the failure reason from error_message with a health hint', async () => {
  const { client, close } = await connect((s) => registerStatusTool(s, fakeSota()));
  try {
    const t = text(await client.callTool({ name: 'get-status', arguments: { project_id: 'p1' } }));
    assert.ok(t.includes('Error: health check failed'));
    assert.ok(t.includes('WITHOUT identity headers'));
  } finally {
    await close();
  }
});

test('accountReader: 404 means an older API (null), errors carry the API message', async () => {
  const mk = (status, body) => async () => new Response(JSON.stringify(body), { status });
  assert.equal(await accountReader('http://x', 'k', mk(404, {}))(), null);
  assert.deepEqual(await accountReader('http://x/', 'k', mk(200, { data: ENTERPRISE }))(), ENTERPRISE);
  await assert.rejects(accountReader('http://x', 'k', mk(403, { error: { message: 'nope' } }))(), /HTTP 403.*nope/);
  let seen;
  await accountReader('http://x/', 'sota_k', async (url, init) => { seen = { url, init }; return new Response('{"data":null}'); })();
  assert.equal(seen.url, 'http://x/v1/account');
  assert.equal(seen.init.headers.Authorization, 'Bearer sota_k');
});

test('ignore rules follow the CLI', () => {
  const p = ['ZUGANGSDATEN.md', 'dist/', '*.log', '/secret.txt', 'tmp'];
  assert.ok(isIgnored('ZUGANGSDATEN.md', false, p));
  assert.ok(isIgnored('docs/ZUGANGSDATEN.md', false, p));
  assert.ok(isIgnored('dist', true, p));
  assert.ok(isIgnored('dist/a.js', false, p));
  assert.ok(isIgnored('x/y.log', false, p));
  assert.ok(isIgnored('secret.txt', false, p));
  assert.ok(!isIgnored('sub/secret.txt', false, p));
  assert.ok(isIgnored('a/tmp/b', false, p));
  assert.ok(!isIgnored('server.js', false, p));
  assert.ok(!isIgnored('distx/a.js', false, p));
});

test('directory deploy honours .sotaignore before .gitignore and reports it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sota-ign-'));
  try {
    writeFileSync(join(dir, 'server.js'), 'x');
    writeFileSync(join(dir, 'NOTES.md'), 'secret');
    writeFileSync(join(dir, 'build.txt'), 'b');
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'dump.sql'), 'd');
    const list = (buf) => {
      const f = join(dir, '..', `${dir.split('/').pop()}.tgz`);
      writeFileSync(f, buf);
      const out = execFileSync('tar', ['-tzf', f]).toString();
      rmSync(f);
      return out;
    };

    let r = archiveDirectoryWithReport(dir);
    assert.equal(r.ignoreFile, null);
    assert.ok(list(r.archive).includes('NOTES.md'));

    writeFileSync(join(dir, '.gitignore'), 'NOTES.md\n');
    r = archiveDirectoryWithReport(dir);
    assert.equal(r.ignoreFile, '.gitignore');
    assert.ok(!list(r.archive).includes('NOTES.md'));

    writeFileSync(join(dir, '.sotaignore'), '# only data\ndata/\n');
    r = archiveDirectoryWithReport(dir);
    assert.equal(r.ignoreFile, '.sotaignore');
    const names = list(r.archive);
    assert.ok(names.includes('NOTES.md'), 'the .gitignore is not read when a .sotaignore exists (CLI rule)');
    assert.ok(!names.includes('dump.sql'));
    assert.equal(r.files, 5); // server.js, NOTES.md, build.txt, .gitignore, .sotaignore

    // An empty .sotaignore turns the .gitignore fallback off.
    writeFileSync(join(dir, '.sotaignore'), '');
    r = archiveDirectoryWithReport(dir);
    assert.equal(r.ignoreFile, '.sotaignore');
    assert.ok(list(r.archive).includes('NOTES.md') && list(r.archive).includes('dump.sql'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('.gitignore fallback keeps .env.production and .env.example; a .sotaignore can drop them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sota-env-'));
  const list = (buf) => {
    const f = `${dir}.tgz`;
    writeFileSync(f, buf);
    const out = execFileSync('tar', ['-tzf', f]).toString().split('\n').map((l) => l.replace(/^\.\//, ''));
    rmSync(f);
    return out;
  };
  try {
    for (const f of ['server.js', '.env', '.env.local', '.env.production', '.env.example', '.env.staging', 'debug.log']) {
      writeFileSync(join(dir, f), 'x');
    }
    mkdirSync(join(dir, '__pycache__'));
    writeFileSync(join(dir, '__pycache__', 'a.pyc'), 'x');
    writeFileSync(join(dir, '.gitignore'), '.env*\n'); // create-next-app
    let names = list(archiveDirectoryWithReport(dir).archive);
    for (const keep of ['server.js', '.env.production', '.env.example', '.gitignore']) assert.ok(names.includes(keep), `missing ${keep}`);
    for (const drop of ['.env', '.env.local', '.env.staging', 'debug.log', '__pycache__']) assert.ok(!names.includes(drop), `shipped ${drop}`);

    writeFileSync(join(dir, '.sotaignore'), '.env.production\n');
    names = list(archiveDirectoryWithReport(dir).archive);
    assert.ok(!names.includes('.env.production'));
    assert.ok(names.includes('.env.example') && names.includes('.env.staging'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const HAS_GIT_DAEMON = (() => { try { execFileSync('git', ['daemon', '--help'], { stdio: 'pipe' }); return true; } catch (e) { return e.status === 0 || /usage/i.test(String(e.stdout) + String(e.stderr)); } })();
test('git_url deploy reads only .sotaignore, never .gitignore (tracked build output stays)', { skip: !HAS_GIT_DAEMON && 'no git daemon' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'sota-git-test-'));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  const work = join(root, 'work');
  mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  mkdirSync(join(work, 'dist'));
  writeFileSync(join(work, 'dist', 'app.js'), 'built');
  writeFileSync(join(work, 'server.js'), 'x');
  writeFileSync(join(work, 'secret.md'), 's');
  writeFileSync(join(work, '.gitignore'), 'dist/\nsecret.md\n');
  writeFileSync(join(work, '.sotaignore'), 'secret.md\n');
  git(work, 'add', '-f', '.');
  git(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'x');
  git(root, 'clone', '-q', '--bare', work, 'repo.git');
  git(join(root, 'repo.git'), 'update-server-info');
  // git daemon (git://, supports the shallow clone archiveFromGitUrl does).
  const port = 20000 + Math.floor(Math.random() * 20000);
  git(join(root, 'repo.git'), 'config', 'daemon.uploadpack', 'true');
  const server = spawn('git', ['daemon', '--export-all', `--base-path=${root}`, '--listen=127.0.0.1', `--port=${port}`, '--reuseaddr', root], { stdio: 'ignore' });
  const url = `git://127.0.0.1:${port}/repo.git`;
  for (let i = 0; i < 50; i++) {
    try { execFileSync('git', ['ls-remote', url], { stdio: 'pipe', timeout: 2000 }); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  try {
    const buf = archiveFromGitUrl(url);
    const f = join(root, 'a.tgz');
    writeFileSync(f, buf);
    const names = execFileSync('tar', ['-tzf', f]).toString();
    assert.ok(names.includes('dist/app.js'), 'tracked file matching .gitignore must deploy');
    assert.ok(!names.includes('secret.md'), '.sotaignore applies');
    assert.ok(names.includes('server.js'));
  } finally {
    server.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an invalid glob is skipped, not fatal', () => {
  assert.equal(isIgnored('a.txt', false, ['[z-a]', '[abc']), false);
  assert.equal(isIgnored('a.txt', false, ['[z-a]', '*.txt']), true);
});

test('slow or hanging lookups never hold the deploy and create results', async () => {
  const never = () => new Promise(() => {});
  const sota = { ...fakeSota(), getProject: never, createProject: async ({ name }) => ({ id: 'p1', name, slug: name, url: 'https://x' }) };
  const { client, close } = await connect((s) => {
    registerProjectTools(s, sota, { readAccount: never, lookupTimeoutMs: 50 });
    registerDeployTool(s, sota, { hosted: true, readAccount: never, lookupTimeoutMs: 50 });
  });
  try {
    const t0 = Date.now();
    const d = await client.callTool({ name: 'deploy', arguments: { project_id: 'p1', files: { 'a.js': 'x' } } });
    const c = await client.callTool({ name: 'create-project', arguments: { name: 'app' } });
    assert.ok(Date.now() - t0 < 2000);
    assert.notEqual(d.isError, true);
    assert.ok(text(d).includes('ID: dep-1') && text(d).includes('App URL: pending'));
    assert.ok(!text(d).includes('Users & access') && !text(c).includes('Users & access'));
  } finally {
    await close();
  }
});

test('accountReader aborts after its timeout', async () => {
  let signal;
  const hang = (_url, init) => { signal = init.signal; return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason))); };
  const keepAlive = setTimeout(() => {}, 5000); // AbortSignal.timeout's timer does not hold the loop
  try {
    await assert.rejects(accountReader('http://x', 'k', hang, 30)());
    assert.equal(signal.aborted, true);
  } finally {
    clearTimeout(keepAlive);
  }
});

// The docs page states the contract word for word (skipped in the public
// mirror, which has no web/ directory).
const DOCS_PAGE = new URL('../../web/src/app/docs/enterprise/build-with-ai/page.mdx', import.meta.url);
test('docs page and tool text state the same contract', { skip: !existsSync(DOCS_PAGE) && 'no web/ checkout' }, () => {
  const page = readFileSync(DOCS_PAGE, 'utf8');
  for (const line of [...guide.BUILD_CONTRACT, ...guide.ENTERPRISE_CONTRACT, ...guide.ENTERPRISE_ACCESS_STEPS]) {
    assert.ok(page.includes(line), `docs page lacks: ${line.slice(0, 80)}`);
  }
});

// Every registered tool has a section on the MCP tools page.
const TOOLS_PAGE = new URL('../../web/src/app/docs/mcp/tools/page.mdx', import.meta.url);
test('MCP tools page lists every stdio tool', { skip: !existsSync(TOOLS_PAGE) && 'no web/ checkout' }, async () => {
  const page = readFileSync(TOOLS_PAGE, 'utf8');
  const sota = fakeSota();
  const { client, close } = await connect((s) => {
    registerAccountTool(s, async () => null);
    registerProjectTools(s, sota);
    registerDeployTool(s, sota);
    registerLogsTool(s, sota);
    registerEnvTools(s, sota);
    registerRollbackTool(s, sota);
    registerRedeployTool(s, sota);
    registerStatusTool(s, sota);
    registerDomainTools(s, sota);
  });
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === 'redeploy'));
    const count = page.match(/exposes (\d+) tools/);
    assert.equal(Number(count?.[1]), tools.length, 'tool count in the intro');
    for (const t of tools) {
      assert.ok(page.includes(`## ${t.name}\n`), `tools page has no "## ${t.name}" section`);
    }
  } finally {
    await close();
  }
});
