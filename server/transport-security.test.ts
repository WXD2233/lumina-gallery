import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './index.ts';

const credentials = { username: 'transport-admin', password: 'Transport-Security-Password-2026!' };
const transportError = /公网访问必须使用 HTTPS/;

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

async function fixture(trustedProxies: string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-transport-security-'));
  const runtime = await createApp({
    dataDir: directory, requireHttps: true, trustedProxies,
    allowedHosts: ['127.0.0.1', 'localhost', '[::1]', 'gallery.test'],
  });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address(); assert(address && typeof address !== 'string');
  const localHost = `127.0.0.1:${address.port}`;
  const request = (path: string, options: { method?: string; body?: string; headers?: Record<string, string> } = {}) => new Promise<HttpResult>((resolve, reject) => {
    // Node's HTTP client preserves the supplied Host, unlike Undici's fetch.
    const outgoing = httpRequest({
      hostname: '127.0.0.1', port: address.port, path, method: options.method ?? 'GET',
      headers: { Host: 'gallery.test', ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
    }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
      incoming.on('error', reject);
      incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    outgoing.setTimeout(10_000, () => outgoing.destroy(new Error('transport regression request timed out')));
    outgoing.on('error', reject);
    outgoing.end(options.body);
  });
  const setup = async () => {
    const response = await request('/api/auth/setup', { method: 'POST', body: JSON.stringify(credentials), headers: { Host: localHost } });
    assert.equal(response.status, 201, response.body);
    const cookie = response.headers['set-cookie']?.[0]?.split(';')[0]; assert(cookie);
    return cookie;
  };
  return { runtime, request, setup, localHost, async close() {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  } };
}

function assertInsecureRejected(response: HttpResult) {
  assert.equal(response.status, 403, response.body);
  assert.match(response.body, transportError);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['strict-transport-security'], undefined);
}

test('public HTTP is rejected before login, session authentication and body parsing', async () => {
  const context = await fixture();
  try {
    const cookie = await context.setup();
    const beforeThrottle = context.runtime.db.connection.prepare('SELECT * FROM auth_throttle ORDER BY key').all();
    const beforeSessions = context.runtime.db.connection.prepare('SELECT * FROM auth_sessions ORDER BY token_hash').all();
    for (const path of ['/', '/api/health', '/api/auth/status', '/api/albums', '/uploads/private.png']) {
      assertInsecureRejected(await context.request(path, { headers: { Cookie: cookie } }));
    }
    for (const path of ['/api/auth/login', '/API/AUTH/LOGIN', '/api/auth/password', '/api/albums', '/api/backup-imports']) {
      assertInsecureRejected(await context.request(path, { method: 'POST', body: '{malformed', headers: { Cookie: cookie } }));
    }
    assertInsecureRejected(await context.request('/api/auth/login', { method: 'POST', body: JSON.stringify(credentials) }));
    assert.deepEqual(context.runtime.db.connection.prepare('SELECT * FROM auth_throttle ORDER BY key').all(), beforeThrottle,
      'insecure requests must not consume login attempt budgets');
    assert.deepEqual(context.runtime.db.connection.prepare('SELECT * FROM auth_sessions ORDER BY token_hash').all(), beforeSessions,
      'insecure login and password requests must not create or revoke sessions');
  } finally { await context.close(); }
});

test('HTTPS Origin and forwarded headers from untrusted peers cannot bypass transport enforcement', async () => {
  const context = await fixture();
  try {
    const forgedHeaders: Record<string, string>[] = [
      { Origin: 'https://gallery.test' },
      { 'X-Forwarded-Proto': 'https' },
      { Forwarded: 'for=127.0.0.1;proto=https;host=localhost' },
      { 'X-Forwarded-Host': 'localhost' },
      { 'X-Real-IP': '127.0.0.1' },
      { 'X-Forwarded-For': '127.0.0.1', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'localhost', Origin: 'https://gallery.test' },
    ];
    for (const headers of forgedHeaders) {
      assertInsecureRejected(await context.request('/api/auth/login', { method: 'POST', body: '{malformed', headers }));
    }
    assert.equal(context.runtime.db.connection.prepare('SELECT count(*) AS count FROM auth_throttle').get()?.count, 0);
    assert.equal(context.runtime.db.connection.prepare('SELECT count(*) AS count FROM auth_users').get()?.count, 0);
  } finally { await context.close(); }
});

test('direct localhost HTTP remains available for health and first account setup only without forwarding', async () => {
  const context = await fixture();
  try {
    for (const host of [context.localHost, 'localhost', '[::1]']) {
      const health = await context.request('/api/health', { headers: { Host: host } });
      assert.equal(health.status, 200, health.body);
      assert.deepEqual(JSON.parse(health.body), { ok: true, app: 'lumina-gallery' });
      assert.equal(health.headers['strict-transport-security'], undefined);
    }
    const status = await context.request('/api/auth/status', { headers: { Host: context.localHost } });
    assert.deepEqual(JSON.parse(status.body), { configured: false, authenticated: false, setupAllowed: true });
    const forwardedHeaders: Record<string, string>[] = [
      { Forwarded: 'proto=https' }, { 'X-Forwarded-Proto': 'https' }, { 'X-Forwarded-Port': '443' },
      { 'X-Forwarded-For': '127.0.0.1' }, { 'X-Forwarded-Host': 'localhost' }, { 'X-Real-IP': '127.0.0.1' },
    ];
    for (const headers of forwardedHeaders) {
      assertInsecureRejected(await context.request('/api/auth/setup', { method: 'POST', body: JSON.stringify(credentials), headers: { Host: context.localHost, ...headers } }));
    }
    const cookie = await context.setup();
    const authenticated = await context.request('/api/auth/status', { headers: { Host: context.localHost, Cookie: cookie } });
    assert.equal(authenticated.status, 200, authenticated.body);
    assert.equal(JSON.parse(authenticated.body).authenticated, true);
  } finally { await context.close(); }
});

test('only an explicitly trusted TLS proxy permits public login and sets Secure cookies and HSTS', async () => {
  const context = await fixture(['127.0.0.1']);
  try {
    await context.setup();
    const insecureProxyHeaders: Record<string, string>[] = [{}, { 'X-Forwarded-Proto': 'http' }, { 'X-Forwarded-Host': 'localhost' }, { Forwarded: 'proto=https;host=localhost' }];
    for (const headers of insecureProxyHeaders) {
      assertInsecureRejected(await context.request('/api/auth/status', { headers }));
    }
    const headers = { 'X-Forwarded-Proto': 'https', Origin: 'https://gallery.test' };
    const status = await context.request('/api/auth/status', { headers });
    assert.equal(status.status, 200, status.body);
    assert.equal(JSON.parse(status.body).setupAllowed, false, 'proxied HTTPS must never enable initial account setup');
    assert.equal(status.headers['strict-transport-security'], 'max-age=31536000');
    const login = await context.request('/api/auth/login', { method: 'POST', headers, body: JSON.stringify(credentials) });
    assert.equal(login.status, 200, login.body);
    assert.equal(JSON.parse(login.body).authenticated, true);
    assert(!login.body.includes(credentials.password));
    assert.equal(login.headers['strict-transport-security'], 'max-age=31536000');
    assert.match(login.headers['set-cookie']?.[0] ?? '', /; Secure(?:;|$)/);
    assert.match(login.headers['set-cookie']?.[0] ?? '', /; HttpOnly(?:;|$)/);
    const cookie = login.headers['set-cookie']?.[0]?.split(';')[0]; assert(cookie);
    assertInsecureRejected(await context.request('/api/auth/status', { headers: { Cookie: cookie } }));
    const secureSession = await context.request('/api/auth/status', { headers: { ...headers, Cookie: cookie } });
    assert.equal(secureSession.status, 200, secureSession.body);
    assert.equal(JSON.parse(secureSession.body).authenticated, true);
  } finally { await context.close(); }
});

test('trusting another address does not let the actual HTTP peer assert HTTPS', async () => {
  const context = await fixture(['192.0.2.10']);
  try {
    assertInsecureRejected(await context.request('/api/auth/status', { headers: { 'X-Forwarded-Proto': 'https', Origin: 'https://gallery.test' } }));
  } finally { await context.close(); }
});
