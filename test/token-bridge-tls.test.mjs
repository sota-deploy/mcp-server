// TLS settings of the MCP's pg pool from DATABASE_URL.
// Run with: npm test (builds dist/ first).

import test from 'node:test';
import assert from 'node:assert/strict';

const { poolTls } = await import('../dist/auth/token-bridge.js');

const read = (p) => `PEM of ${p}`;
const cert = (san) => ({ subject: { CN: 'sota-selfhost-db' }, subjectaltname: san });

test('Supabase pooler URL: sslmode stripped, permissive TLS as before', () => {
  const { connectionString, ssl } = poolTls(
    'postgresql://postgres.ref:p%40s@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require', read);
  assert.equal(connectionString, 'postgresql://postgres.ref:p%40s@aws-0-eu-central-1.pooler.supabase.com:6543/postgres');
  assert.deepEqual(ssl, { rejectUnauthorized: false, require: true });
});

test('no sslmode at all: permissive TLS', () => {
  const { connectionString, ssl } = poolTls('postgresql://u:p@db:5432/postgres', read);
  assert.equal(connectionString, 'postgresql://u:p@db:5432/postgres');
  assert.equal(ssl.rejectUnauthorized, false);
});

test('verify-full: CA from sslrootcert, both params removed, host checked against IP SANs', () => {
  const { connectionString, ssl } = poolTls(
    'postgresql://postgres:x@192.0.2.10:5432/postgres?sslmode=verify-full&sslrootcert=/opt/sota/secrets/platform-db/ca.crt', read);
  assert.equal(connectionString, 'postgresql://postgres:x@192.0.2.10:5432/postgres');
  assert.equal(ssl.ca, 'PEM of /opt/sota/secrets/platform-db/ca.crt');
  assert.equal(ssl.rejectUnauthorized, true);
  assert.equal(ssl.checkServerIdentity('localhost', cert('DNS:db, DNS:localhost, IP Address:127.0.0.1, IP Address:192.0.2.10')), undefined);
  const err = ssl.checkServerIdentity('localhost', cert('DNS:db, DNS:localhost, IP Address:127.0.0.1, IP Address:192.0.2.20'));
  assert.ok(err instanceof Error, 'a certificate for another address must be refused');
});

test('verify-full without sslrootcert is a configuration error', () => {
  assert.throws(() => poolTls('postgresql://u:p@192.0.2.10:5432/postgres?sslmode=verify-full', read), /sslrootcert/);
});

test('verify-ca: chain checked, host name not', () => {
  const { ssl } = poolTls('postgresql://u:p@192.0.2.10:5432/postgres?sslmode=verify-ca&sslrootcert=/c.crt', read);
  assert.equal(ssl.rejectUnauthorized, true);
  assert.equal(ssl.checkServerIdentity('x', cert('DNS:other')), undefined);
});
