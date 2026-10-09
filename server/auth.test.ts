import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, scrypt } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createApp } from './index.ts';
import { registerAuthRoutes } from './auth.ts';
import { GalleryDb } from './db.ts';
import type { AuthStatus } from '../shared/auth.ts';

const credentials = { username: '图库管理员', password: 'gallery-private-0123' };

test('periodic authentication cleanup contains storage failures instead of crashing the process', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-auth-maintenance-'));
  const db = new GalleryDb(directory);
  context.mock.timers.enable({ apis: ['setInterval'] });
  const auth = registerAuthRoutes(express(), db);
  try {
    db.close();
    assert.doesNotThrow(() => context.mock.timers.tick(15 * 60_000));
    assert.doesNotThrow(() => context.mock.timers.tick(15 * 60_000));
  } finally {
    auth.close();
    context.mock.timers.reset();
    await rm(directory, { recursive: true, force: true });
  }
});
const cookieFrom = (response: Response) => {
  const cookie = response.headers.get('set-cookie'); assert(cookie);
  return cookie.split(';')[0];
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-auth-'));
  let runtime = await createApp({ dataDir: directory });
  let server = runtime.app.listen(0, '127.0.0.1');
  let base = '';
  async function listening() {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address(); assert(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
  }
  await listening();
  async function stop() {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await runtime.close();
  }
  return {
    get runtime() { return runtime; },
    get base() { return base; },
    request(path: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}) {
      return fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    },
    async restart() { await stop(); runtime = await createApp({ dataDir: directory }); server = runtime.app.listen(0, '127.0.0.1'); await listening(); },
    async close() { await stop(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('first setup issues opaque HttpOnly session and stores only salted password and token hashes', async () => {
  const context = await fixture();
  try {
    const status = await context.request('/api/auth/status');
    assert.deepEqual(await status.json(), { configured: false, authenticated: false, setupAllowed: true });
    assert.match(status.headers.get('cache-control') ?? '', /no-store/);
    const fixedCookie = `lumina_session=${'a'.repeat(43)}`;
    const response = await context.request('/api/auth/setup', credentials, fixedCookie);
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { configured: true, authenticated: true, setupAllowed: false, username: credentials.username, userId: 1, role: 'admin' });
    const cookie = cookieFrom(response);
    assert.notEqual(cookie, fixedCookie);
    assert.match(response.headers.get('set-cookie')!, /HttpOnly/);
    assert.match(response.headers.get('set-cookie')!, /SameSite=Strict/);
    assert.match(response.headers.get('set-cookie')!, /Max-Age=28800/);
    assert.match(response.headers.get('set-cookie')!, /Path=\//);
    const account = context.runtime.db.connection.prepare('SELECT * FROM auth_users').get()!;
    assert.equal(account.id, 1);
    assert.equal(account.username, credentials.username);
    assert.match(String(account.salt), /^[a-f0-9]{32}$/);
    assert.match(String(account.password_hash), /^[a-f0-9]{128}$/);
    assert(!JSON.stringify(account).includes(credentials.password));
    const stored = context.runtime.db.connection.prepare('SELECT * FROM auth_sessions').get()!;
    const token = cookie.slice('lumina_session='.length);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(stored.token_hash, createHash('sha256').update(token).digest('hex'));
    assert.equal(Number(stored.expires_at) - Number(stored.created_at), 8 * 60 * 60 * 1000);
    assert(!JSON.stringify(stored).includes(token));
    assert.equal((await context.request('/api/albums', undefined, cookie)).status, 200);
    assert.equal((await context.request('/api/albums', undefined, fixedCookie)).status, 401);
    assert.equal((await context.request('/api/albums', undefined, `${cookie}; ${cookie}`)).status, 401);
    assert.deepEqual(await (await context.request('/api/auth/status')).json(), { configured: true, authenticated: false, setupAllowed: false });
    assert.equal((await context.request('/api/auth/setup', credentials)).status, 409);
  } finally { await context.close(); }
});

test('login errors are generic, sessions survive restart, and logout invalidates the cookie immediately', async () => {
  const context = await fixture();
  try {
    const setupCookie = cookieFrom(await context.request('/api/auth/setup', credentials));
    const wrongPassword = await context.request('/api/auth/login', { ...credentials, password: 'incorrect-password' });
    const wrongUsername = await context.request('/api/auth/login', { ...credentials, username: 'other-user' });
    assert.equal(wrongPassword.status, 401); assert.equal(wrongUsername.status, 401);
    assert.deepEqual(await wrongPassword.json(), await wrongUsername.json());
    const login = await context.request('/api/auth/login', credentials, setupCookie);
    assert.equal(login.status, 200);
    const cookie = cookieFrom(login);
    assert.notEqual(cookie, setupCookie);
    assert.equal((await context.request('/api/albums', undefined, setupCookie)).status, 401);
    await context.restart();
    assert.equal((await context.request('/api/auth/status', undefined, cookie)).status, 200);
    assert.equal(((await (await context.request('/api/auth/status', undefined, cookie)).json()) as AuthStatus).authenticated, true);
    assert.equal((await context.request('/api/albums', undefined, cookie)).status, 200);
    const logout = await context.request('/api/auth/logout', {}, cookie);
    assert.equal(logout.status, 200);
    assert.equal(logout.headers.get('clear-site-data'), '"cache"');
    assert.match(logout.headers.get('set-cookie')!, /Expires=Thu, 01 Jan 1970/);
    assert.equal((await context.request('/api/albums', undefined, cookie)).status, 401);
    assert.equal(context.runtime.db.connection.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get()!.count, 0);
  } finally { await context.close(); }
});

test('an existing shorter password and session survive the stronger new-password policy and a restart', async () => {
  const context = await fixture();
  try {
    const cookie = cookieFrom(await context.request('/api/auth/setup', credentials));
    const legacyPassword = 'Old-door-42!';
    assert(legacyPassword.length >= 10 && legacyPassword.length < 15);
    const salt = randomBytes(16).toString('hex');
    // Reproduce an account saved by the earlier release in an isolated database.
    // The new setup endpoint intentionally cannot create this shorter password.
    const hash = await new Promise<Buffer>((resolve, reject) => scrypt(legacyPassword, salt, 64,
      { N: 32768, r: 8, p: 3, maxmem: 48 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
    context.runtime.db.connection.prepare('UPDATE auth_users SET salt = ?, password_hash = ? WHERE id = 1').run(salt, hash.toString('hex'));
    const stored = context.runtime.db.connection.prepare('SELECT * FROM auth_users').all();
    await context.restart();
    assert.deepEqual(context.runtime.db.connection.prepare('SELECT * FROM auth_users').all(), stored, 'hardening must not silently replace existing credentials');
    assert.equal((await context.request('/api/albums', undefined, cookie)).status, 200, 'existing sessions remain usable');
    const login = await context.request('/api/auth/login', { ...credentials, password: legacyPassword });
    assert.equal(login.status, 200, await login.clone().text());
    const legacySession = cookieFrom(login);
    const tooShort = await context.request('/api/auth/password', { currentPassword: legacyPassword, newPassword: 'New-door-43!' }, legacySession);
    assert.equal(tooShort.status, 400, 'only new passwords must meet the stronger policy');
    const changed = await context.request('/api/auth/password', { currentPassword: legacyPassword, newPassword: 'a copper lantern by the lake' }, legacySession);
    assert.equal(changed.status, 200, await changed.clone().text());
    assert.equal((await context.request('/api/albums', undefined, cookieFrom(changed))).status, 200);
  } finally { await context.close(); }
});

test('changing password requires current password and rotates all other sessions', async () => {
  const context = await fixture();
  try {
    const first = cookieFrom(await context.request('/api/auth/setup', credentials));
    const second = cookieFrom(await context.request('/api/auth/login', credentials));
    const oldHash = context.runtime.db.connection.prepare('SELECT password_hash,salt FROM auth_users').get()!;
    const replacement = 'new-gallery-password-456';
    const failed = await context.request('/api/auth/password', { currentPassword: 'wrong-current', newPassword: replacement }, first);
    assert.equal(failed.status, 400);
    assert.equal((await context.request('/api/albums', undefined, second)).status, 200);
    const changed = await context.request('/api/auth/password', { currentPassword: credentials.password, newPassword: replacement }, first);
    assert.equal(changed.status, 200);
    const current = cookieFrom(changed);
    assert.notEqual(current, first);
    const newHash = context.runtime.db.connection.prepare('SELECT password_hash,salt FROM auth_users').get()!;
    assert.notEqual(newHash.password_hash, oldHash.password_hash); assert.notEqual(newHash.salt, oldHash.salt);
    assert.equal((await context.request('/api/albums', undefined, first)).status, 401);
    assert.equal((await context.request('/api/albums', undefined, second)).status, 401);
    assert.equal((await context.request('/api/albums', undefined, current)).status, 200);
    assert.equal((await context.request('/api/auth/login', credentials)).status, 401);
    assert.equal((await context.request('/api/auth/login', { ...credentials, password: replacement })).status, 200);
    assert.equal((await context.request('/api/auth/password', { currentPassword: replacement, newPassword: 'another-password-789' })).status, 401);
  } finally { await context.close(); }
});

test('expired sessions do not authenticate even if their database rows remain', async () => {
  const context = await fixture();
  try {
    const cookie = cookieFrom(await context.request('/api/auth/setup', credentials));
    context.runtime.db.connection.prepare('UPDATE auth_sessions SET expires_at = ?').run(Date.now() - 1);
    assert.equal((await context.request('/api/albums', undefined, cookie)).status, 401);
    assert.equal(((await (await context.request('/api/auth/status', undefined, cookie)).json()) as AuthStatus).authenticated, false);
    await context.restart();
    assert.equal(context.runtime.db.connection.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get()!.count, 0);
  } finally { await context.close(); }
});

test('password and username validation rejects weak or malformed setup without creating an account', async () => {
  for (const [value, status] of [
    [{ ...credentials, password: '123456789' }, 400],
    [{ ...credentials, password: ' '.repeat(15) }, 400],
    [{ ...credentials, password: 'a'.repeat(129) }, 400],
    [{ ...credentials, username: 'a' }, 400],
    [{ ...credentials, username: 'name\u0000bad' }, 400],
    [{ ...credentials, padding: 'a'.repeat(17000) }, 413],
  ] as const) {
    // Each malformed request has its own fixture so validation, not the cumulative
    // brute-force cooldown, is the behavior under test.
    const context = await fixture();
    try {
      assert.equal((await context.request('/api/auth/setup', value)).status, status);
      assert.equal(context.runtime.db.connection.prepare('SELECT COUNT(*) AS count FROM auth_users').get()!.count, 0);
    } finally { await context.close(); }
  }
});

test('repeated login attempts are rate limited without blocking an existing authenticated session', async () => {
  const context = await fixture();
  try {
    const cookie = cookieFrom(await context.request('/api/auth/setup', credentials));
    for (let i = 0; i < 5; i++) {
      assert.equal((await context.request('/api/auth/login', { ...credentials, password: 'wrong-password' })).status, 401);
    }
    const limited = await context.request('/api/auth/login', credentials);
    assert.equal(limited.status, 429);
    assert(Number(limited.headers.get('retry-after')) > 0);
    assert.equal((await context.request('/api/albums', undefined, cookie)).status, 200);
  } finally { await context.close(); }
});

test('exact-host HTTPS origin supports TLS proxies and tightens cookies without trusting forwarded headers', async () => {
  const context = await fixture();
  try {
    await context.request('/api/auth/setup', credentials);
    const httpsOrigin = context.base.replace('http:', 'https:');
    const response = await context.request('/api/auth/login', credentials, undefined, { Origin: httpsOrigin, 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie')!, /; Secure(?:;|$)/);
    const logout = await context.request('/api/auth/logout', {}, cookieFrom(response), { Origin: httpsOrigin, 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie')!, /; Secure(?:;|$)/);
    const forgedForwarding = await context.request('/api/auth/login', credentials, undefined, { Origin: context.base, 'X-Forwarded-Proto': 'https' });
    assert.equal(forgedForwarding.status, 200);
    assert.doesNotMatch(forgedForwarding.headers.get('set-cookie')!, /; Secure(?:;|$)/);
  } finally { await context.close(); }
});

test('cross-host, opaque, and non-web origins cannot log in or mutate sessions', async () => {
  const context = await fixture();
  try {
    const cookie = cookieFrom(await context.request('/api/auth/setup', credentials));
    for (const origin of ['https://other.example', 'null', context.base.replace('http:', 'file:')]) {
      assert.equal((await context.request('/API/AUTH/login', credentials, undefined, { Origin: origin })).status, 403);
      assert.equal((await context.request('/api/auth/logout', {}, cookie, { Origin: origin })).status, 403);
    }
    assert.equal((await context.request('/api/albums', undefined, cookie)).status, 200);
  } finally { await context.close(); }
});
