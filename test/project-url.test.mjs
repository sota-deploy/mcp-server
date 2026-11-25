// Tools show the project URL the API returns.
// Run with: npm test (builds dist/ first).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { projectUrl } = await import('../dist/lib/project-url.js');

test('projectUrl uses the url the API returns (Enterprise app host)', () => {
  assert.equal(
    projectUrl({ slug: 'acme-app1', url: 'https://app1.acme.sota.io' }),
    'https://app1.acme.sota.io',
  );
});

test('projectUrl falls back to the slug only for an API without url', () => {
  assert.equal(projectUrl({ slug: 'shop' }), 'https://shop.sota.io');
  assert.equal(projectUrl({ slug: 'shop', url: null }), 'https://shop.sota.io');
  assert.equal(projectUrl({ slug: 'shop', url: '' }), 'https://shop.sota.io');
});

test('project tools no longer compose <slug>.sota.io URLs', () => {
  const src = readFileSync(new URL('../src/tools/projects.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /https:\/\/\$\{[^}]*slug\}\.sota\.io/);
  assert.match(src, /projectUrl\(project\)/);
});
