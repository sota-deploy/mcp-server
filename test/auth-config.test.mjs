// GDPR-3: env-driven OAuth upstream + accepted JWT issuers.
// Run with: npm test (builds dist/ first).

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  DEFAULT_AUTH_UPSTREAM,
  DEFAULT_ACCEPTED_ISSUERS,
  resolveAuthUpstream,
  resolveAcceptedIssuers,
} = await import('../dist/lib/auth-config.js');

const PROD_DEFAULT_ISSUERS = [
  'https://wnwsdtqhywfxxlnyqafk.supabase.co/auth/v1',
  'https://auth.sota.io/auth/v1',
];

test('upstream: unset or blank keeps the prod value', () => {
  assert.equal(DEFAULT_AUTH_UPSTREAM, 'https://auth.sota.io/auth/v1');
  assert.equal(resolveAuthUpstream({}), 'https://auth.sota.io/auth/v1');
  assert.equal(resolveAuthUpstream({ AUTH_SERVER: '   ' }), 'https://auth.sota.io/auth/v1');
});

test('upstream: env value is used, trailing slashes trimmed, host lower-cased', () => {
  assert.equal(
    resolveAuthUpstream({ AUTH_SERVER: 'https://zovymbyrlmwghznwctyc.supabase.co/auth/v1' }),
    'https://zovymbyrlmwghznwctyc.supabase.co/auth/v1',
  );
  assert.equal(
    resolveAuthUpstream({ AUTH_SERVER: ' https://Auth.Example.com/auth/v1/// ' }),
    'https://auth.example.com/auth/v1',
  );
  assert.equal(resolveAuthUpstream({ AUTH_SERVER: 'http://127.0.0.1:9999/auth/v1' }), 'http://127.0.0.1:9999/auth/v1');
  assert.equal(resolveAuthUpstream({ AUTH_SERVER: 'http://localhost:9999/auth/v1/' }), 'http://localhost:9999/auth/v1');
});

test('upstream: invalid values fail fast', () => {
  for (const bad of [
    'auth.sota.io/auth/v1',
    '/auth/v1',
    'http://auth.sota.io/auth/v1',
    'ftp://auth.sota.io/auth/v1',
    'https://auth.sota.io/auth/v1?x=1',
    'https://auth.sota.io/auth/v1#frag',
    'https://user:pw@auth.sota.io/auth/v1',
  ]) {
    assert.throws(() => resolveAuthUpstream({ AUTH_SERVER: bad }), /AUTH_SERVER/, bad);
  }
});

test('issuers: unset or blank keeps the two prod values (prod upstream already included)', () => {
  assert.deepEqual([...DEFAULT_ACCEPTED_ISSUERS], PROD_DEFAULT_ISSUERS);
  assert.deepEqual(resolveAcceptedIssuers({}), PROD_DEFAULT_ISSUERS);
  assert.deepEqual(resolveAcceptedIssuers({ SUPABASE_JWT_ISSUERS: ' , ' }), PROD_DEFAULT_ISSUERS);
  assert.deepEqual(
    resolveAcceptedIssuers({ AUTH_SERVER: 'https://auth.sota.io/auth/v1' }),
    PROD_DEFAULT_ISSUERS,
  );
});

test('issuers: comma-separated env list, upstream appended once', () => {
  const dev = 'https://zovymbyrlmwghznwctyc.supabase.co/auth/v1';
  assert.deepEqual(
    resolveAcceptedIssuers({ SUPABASE_JWT_ISSUERS: ` ${dev} `, AUTH_SERVER: dev }),
    [dev],
  );
  assert.deepEqual(
    resolveAcceptedIssuers({ SUPABASE_JWT_ISSUERS: 'https://a.example/auth/v1,https://b.example/auth/v1' }),
    ['https://a.example/auth/v1', 'https://b.example/auth/v1', 'https://auth.sota.io/auth/v1'],
  );
  // Only AUTH_SERVER set (dev without SUPABASE_JWT_ISSUERS): defaults + upstream.
  assert.deepEqual(resolveAcceptedIssuers({ AUTH_SERVER: `${dev}/` }), [...PROD_DEFAULT_ISSUERS, dev]);
  assert.deepEqual(
    resolveAcceptedIssuers({ SUPABASE_JWT_ISSUERS: 'http://localhost:9999/auth/v1', AUTH_SERVER: 'http://localhost:9999/auth/v1' }),
    ['http://localhost:9999/auth/v1'],
  );
});

test('issuers: invalid values fail fast (same rules as the Go API)', () => {
  for (const bad of [
    'not a url',
    'https://auth.sota.io/auth/v1/',
    'https://Auth.sota.io/auth/v1',
    'http://auth.sota.io/auth/v1',
    'https://auth.sota.io/auth/v1?x=1',
    'https://auth.sota.io/auth/v1#f',
    'https://u:p@auth.sota.io/auth/v1',
    'https://auth.sota.io/auth/v1,https://ok.example/auth/v1/',
  ]) {
    assert.throws(() => resolveAcceptedIssuers({ SUPABASE_JWT_ISSUERS: bad }), /SUPABASE_JWT_ISSUERS/, bad);
  }
});
