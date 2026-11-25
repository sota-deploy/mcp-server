// `npx -y @sota-io/mcp` picks the bin entry named after the unscoped package
// name ("mcp"). Without it npx fails with "could not determine executable to
// run" (every release up to 1.7.0). Run with: npm test (builds dist/ first).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const unscoped = pkg.name.replace(/^@[^/]+\//, '');

test('a bin entry matches the unscoped package name (npx -y <package>)', () => {
  assert.equal(typeof pkg.bin, 'object');
  assert.ok(
    Object.hasOwn(pkg.bin, unscoped),
    `package.json bin has no "${unscoped}" entry; \`npx -y ${pkg.name}\` cannot pick an executable`,
  );
});

test('the npx entry runs the stdio server, the named bins stay', () => {
  assert.equal(pkg.bin[unscoped], pkg.bin['sota-mcp']);
  assert.equal(pkg.bin['sota-mcp'], 'dist/index.js');
  assert.equal(pkg.bin['sota-mcp-http'], 'dist/http.js');
});

test('every bin target is built, starts with a node shebang and ships in files', () => {
  for (const [name, target] of Object.entries(pkg.bin)) {
    const file = join(root, target);
    assert.ok(statSync(file).isFile(), `${name}: ${target} missing (run npm run build)`);
    assert.match(readFileSync(file, 'utf8'), /^#!\/usr\/bin\/env node\n/, `${name}: ${target} has no shebang`);
    assert.ok(pkg.files.some((f) => target === f || target.startsWith(`${f}/`)), `${name}: ${target} not in files`);
  }
});
