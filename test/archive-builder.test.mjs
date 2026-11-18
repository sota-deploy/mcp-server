// Unit tests for the archive builder used by the MCP deploy tool.
// Run with: node --test test/archive-builder.test.mjs
//
// Loads compiled JS from dist/, so `npm run build` must succeed first.
// This keeps the test runner zero-dep (no jest / vitest).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const builder = await import('../dist/lib/archive-builder.js');

const {
  archiveFromFiles,
  archiveFromDirectory,
  ArchiveBuilderError,
  MAX_INLINE_FILES,
  MAX_INLINE_TOTAL_BYTES,
} = builder;

test('archiveFromFiles produces a non-empty gzip buffer', () => {
  const buf = archiveFromFiles({
    'package.json': '{"name":"hello","scripts":{"start":"node server.js"}}',
    'server.js': "require('http').createServer((_,r)=>r.end('hi')).listen(8080)",
  });
  assert.ok(Buffer.isBuffer(buf), 'returns a Buffer');
  assert.ok(buf.byteLength > 0, 'buffer has bytes');
  // Gzip magic
  assert.equal(buf[0], 0x1f);
  assert.equal(buf[1], 0x8b);
});

test('archiveFromFiles round-trips through tar -tzf', () => {
  const buf = archiveFromFiles({
    'index.js': 'console.log("hi")',
    'nested/file.txt': 'inside-nested',
  });
  const tmp = mkdtempSync(join(tmpdir(), 'sota-roundtrip-'));
  try {
    const arch = join(tmp, 'out.tar.gz');
    writeFileSync(arch, buf);
    const listing = execSync(`tar -tzf ${arch}`).toString();
    assert.match(listing, /(^|\n)\.\/index\.js(\n|$)/);
    assert.match(listing, /nested\/file\.txt/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('archiveFromFiles rejects empty input', () => {
  assert.throws(
    () => archiveFromFiles({}),
    (err) => err instanceof ArchiveBuilderError && err.code === 'empty_files',
  );
});

test('archiveFromFiles rejects too many files', () => {
  const obj = {};
  for (let i = 0; i <= MAX_INLINE_FILES; i++) obj[`f${i}.txt`] = '.';
  assert.throws(
    () => archiveFromFiles(obj),
    (err) => err instanceof ArchiveBuilderError && err.code === 'too_many_files',
  );
});

test('archiveFromFiles rejects oversized payload', () => {
  // One big file just above the cap.
  const big = '.'.repeat(MAX_INLINE_TOTAL_BYTES + 1);
  assert.throws(
    () => archiveFromFiles({ 'big.txt': big }),
    (err) => err instanceof ArchiveBuilderError && err.code === 'inline_too_large',
  );
});

test('archiveFromFiles rejects path traversal', () => {
  assert.throws(
    () => archiveFromFiles({ '../escape.txt': 'nope' }),
    (err) => err instanceof ArchiveBuilderError && err.code === 'bad_path',
  );
});

test('archiveFromFiles rejects NUL byte', () => {
  assert.throws(
    () => archiveFromFiles({ 'nul\0bad': 'nope' }),
    (err) => err instanceof ArchiveBuilderError && err.code === 'bad_path',
  );
});

test('archiveFromFiles strips leading "./" silently', () => {
  const buf = archiveFromFiles({ './ok.js': 'console.log(1)' });
  assert.ok(buf.byteLength > 0);
});

test('archiveFromDirectory packs a real directory', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sota-srcdir-'));
  try {
    writeFileSync(join(tmp, 'package.json'), '{"name":"x"}');
    const buf = archiveFromDirectory(tmp);
    assert.ok(Buffer.isBuffer(buf));
    assert.ok(buf.byteLength > 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('archiveFromDirectory fails on missing path', () => {
  assert.throws(
    () => archiveFromDirectory('/this/should/not/exist/sota-xyz'),
    (err) => err instanceof ArchiveBuilderError && err.code === 'not_found',
  );
});

// ── MCP-1: local/secret .env files never land in an archive ───────────────

const { isExcludedName, collectEntries } = builder;

function tarListing(buf) {
  const tmp = mkdtempSync(join(tmpdir(), 'sota-list-'));
  try {
    const arch = join(tmp, 'out.tar.gz');
    writeFileSync(arch, buf);
    return execSync(`tar -tzf ${arch}`).toString().split('\n').filter(Boolean);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Local/secret env files: never archived (any depth, any case).
const EXCLUDED_ENV = [
  '.env',
  '.env.local',
  '.env.production.local',
  '.env.development.local',
  '.ENV',
  '.Env.Local',
  '.ENV.TEST.LOCAL',
  '.envrc',
  'apps/web/.env.local',
  'deep/a/b/c/.env.test.local',
  'deep/a/.env',
];
// Committed variants: kept, builds need them (e.g. NEXT_PUBLIC_* at build time).
const KEPT_ENV = [
  '.env.production',
  '.env.development',
  '.env.test',
  '.env.example',
  '.Env.Production',
  '.env.local.example',
  'apps/web/.env.production',
];
const isEnvExcludedPath = (p) => /(^|\/)\.env(?:(?:\.[^/]+)?\.local|rc)?$/i.test(p);

test('isExcludedName: local/secret .env variants out, committed variants in', () => {
  for (const name of ['.env', '.env.local', '.env.production.local', '.ENV', '.Env.Local', '.envrc', '.ENVRC']) {
    assert.equal(isExcludedName(name), true, name);
  }
  for (const name of ['.env.production', '.env.development', '.env.test', '.env.example', '.env.local.example', '.envrc.example', 'env', 'env.js', 'my.env', 'src']) {
    assert.equal(isExcludedName(name), false, name);
  }
});

test('archiveFromDirectory drops local .env files at any depth and keeps committed ones', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sota-envdir-'));
  try {
    const write = (rel, content = 'x') => {
      const abs = join(tmp, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    };
    for (const rel of EXCLUDED_ENV) write(rel, 'SECRET=leak');
    for (const rel of KEPT_ENV) write(rel, 'NEXT_PUBLIC_X=1');
    write('package.json', '{"name":"x"}');
    write('apps/web/index.js', 'console.log(1)');
    write('src/env.ts', 'export {}');
    write('node_modules/dep/index.js', '');
    write('.git/config', '');
    write('sub/.DS_Store', '');

    const listing = tarListing(archiveFromDirectory(tmp));
    for (const entry of listing) {
      const base = entry.replace(/\/$/, '').split('/').pop();
      assert.ok(!isEnvExcludedPath(entry), `archive contains ${entry}`);
      assert.ok(!/(^|\/)(node_modules|\.git)(\/|$)/.test(entry), `archive contains ${entry}`);
      assert.notEqual(base, '.DS_Store', `archive contains ${entry}`);
    }
    for (const want of ['./package.json', './apps/web/index.js', './src/env.ts', ...KEPT_ENV.map((p) => `./${p}`)]) {
      assert.ok(listing.includes(want), `archive misses ${want}: ${listing.join(', ')}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('archiveFromFiles applies the same .env rule to inline files', () => {
  const files = { 'index.js': 'console.log(1)' };
  for (const rel of EXCLUDED_ENV) files[rel] = 'SECRET=leak';
  for (const rel of KEPT_ENV) files[rel] = 'NEXT_PUBLIC_X=1';
  const listing = tarListing(archiveFromFiles(files));
  assert.ok(listing.includes('./index.js'));
  assert.ok(!listing.some(isEnvExcludedPath), listing.join(', '));
  for (const rel of KEPT_ENV) assert.ok(listing.includes(`./${rel}`), `archive misses ${rel}`);
});

test('collectEntries does not follow symlinked directories', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sota-symlink-'));
  const outside = mkdtempSync(join(tmpdir(), 'sota-outside-'));
  try {
    writeFileSync(join(outside, 'secret.txt'), 'x');
    writeFileSync(join(tmp, 'a.txt'), 'x');
    symlinkSync(outside, join(tmp, 'link'));
    const { entries } = collectEntries(tmp);
    assert.deepEqual(entries, ['./a.txt', './link']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('archiveFromDirectory rejects a file path', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sota-file-'));
  try {
    writeFileSync(join(tmp, 'f'), 'x');
    assert.throws(
      () => archiveFromDirectory(join(tmp, 'f')),
      (err) => err instanceof ArchiveBuilderError && err.code === 'not_a_directory',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// BusyBox tar (the Alpine image of mcp.sota.io) has no --null. A stand-in
// tar that refuses the option like BusyBox does must still give an archive.
test('tar without --null (BusyBox): falls back to a newline list', () => {
  const real = execSync('command -v tar', { shell: '/bin/sh' }).toString().trim();
  const bin = mkdtempSync(join(tmpdir(), 'sota-faketar-'));
  const oldPath = process.env.PATH;
  try {
    writeFileSync(
      join(bin, 'tar'),
      `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "--null" ]; then echo "tar: unrecognized option: null" >&2; exit 1; fi; done\nexec ${real} "$@"\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${oldPath}`;
    const buf = archiveFromFiles({ 'index.js': 'x', 'nested/a b.txt': 'y', '.env': 'SECRET=1' });
    process.env.PATH = oldPath;
    const out = mkdtempSync(join(tmpdir(), 'sota-faketar-out-'));
    try {
      const arch = join(out, 'a.tar.gz');
      writeFileSync(arch, buf);
      const names = execSync(`tar -tzf ${arch}`).toString().split('\n').filter(Boolean)
        .map((n) => n.replace(/\/$/, '')).sort();
      assert.deepEqual(names, ['./index.js', './nested', './nested/a b.txt']);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  }
});

test('isUnknownNullOption recognises the BusyBox message only', () => {
  assert.equal(builder.isUnknownNullOption({ stderr: Buffer.from('tar: unrecognized option: null\n') }), true);
  assert.equal(builder.isUnknownNullOption({ stderr: Buffer.from("tar: unrecognized option '--null'\n") }), true);
  assert.equal(builder.isUnknownNullOption({ stderr: Buffer.from('tar: ./x: Cannot open: Permission denied\n') }), false);
});
