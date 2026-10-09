import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, scrypt } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { createApp } from './index.ts';
import { GalleryDb } from './db.ts';
import type { AdminUser, AuthStatus } from '../shared/auth.ts';

const adminCredentials = { username: 'accounts-admin', password: 'a copper lantern by the lake' };
const viewerCredentials = { username: 'gallery-reader', password: 'violet leaves across the meadow' };
const cookieFrom = (response: Response) => { const value = response.headers.get('set-cookie'); assert(value); return value.split(';')[0]; };

async function fixture(seed?: (directory: string) => Promise<void>) {
  const prefix = join(tmpdir(), 'lumina-accounts-');
  const directory = await mkdtemp(prefix);
  await seed?.(directory);
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
  const request = (path: string, cookie = '', init: RequestInit = {}) => fetch(`${base}${path}`, {
    ...init, headers: { ...(cookie ? { Cookie: cookie } : {}), ...Object.fromEntries(new Headers(init.headers)) }, redirect: 'error',
  });
  const json = (path: string, body: unknown, cookie = '', method = 'POST') => request(path, cookie, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return {
    request, json, get runtime() { return runtime; },
    async setup() { const result = await json('/api/auth/setup', adminCredentials); assert.equal(result.status, 201, await result.clone().text()); return cookieFrom(result); },
    async create(cookie: string, fields: object = {}) {
      const result = await json('/api/admin/users', { ...viewerCredentials, role: 'viewer', ...fields }, cookie);
      assert.equal(result.status, 201, await result.clone().text()); return await result.json() as AdminUser;
    },
    async login(credentials = viewerCredentials) { const result = await json('/api/auth/login', credentials); assert.equal(result.status, 200, await result.clone().text()); return cookieFrom(result); },
    async restart() { await stop(); runtime = await createApp({ dataDir: directory }); server = runtime.app.listen(0, '127.0.0.1'); await listening(); },
    async close() { await stop(); assert(resolve(directory).startsWith(resolve(prefix))); await rm(directory, { recursive: true, force: true }); },
  };
}

test('legacy single administrator, password hash, session and avatar migrate without changing stored credentials', async () => {
  const salt = randomBytes(16).toString('hex');
  const hash = await new Promise<Buffer>((resolve, reject) => scrypt(adminCredentials.password, salt, 64,
    { N: 32768, r: 8, p: 3, maxmem: 48 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const now = Date.now();
  const avatar = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#5c6570' } }).webp().toBuffer();
  const f = await fixture(async directory => {
    const db = new GalleryDb(directory);
    try {
      db.connection.exec(`CREATE TABLE auth_users (id INTEGER PRIMARY KEY CHECK(id = 1), username TEXT NOT NULL,
        salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL CHECK(user_id = 1),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
        CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
        CREATE TABLE account_profile (id INTEGER PRIMARY KEY CHECK(id = 1),avatar BLOB NOT NULL,revision TEXT NOT NULL);`);
      db.connection.prepare('INSERT INTO auth_users VALUES(1,?,?,?,?)').run(adminCredentials.username, salt, hash.toString('hex'), now);
      db.connection.prepare('INSERT INTO auth_sessions VALUES(?,1,?,?)').run(tokenHash, now, now + 600_000);
      db.connection.prepare('INSERT INTO account_profile VALUES(1,?,?)').run(avatar, 'legacy-revision');
    } finally { db.close(); }
  });
  try {
    const cookie = `lumina_session=${token}`;
    const account = f.runtime.db.connection.prepare('SELECT * FROM auth_users WHERE id = 1').get()!;
    assert.equal(account.password_hash, hash.toString('hex')); assert.equal(account.salt, salt);
    assert.equal(account.created_at, now); assert.equal(account.role, 'admin'); assert.equal(account.disabled, 0);
    assert.deepEqual(await (await f.request('/api/auth/status', cookie)).json(), {
      configured: true, authenticated: true, setupAllowed: false, userId: 1, username: adminCredentials.username, role: 'admin',
    });
    assert.equal(f.runtime.db.connection.prepare('SELECT expires_at FROM auth_sessions WHERE token_hash=?').get(tokenHash)!.expires_at, now + 600_000);
    assert.deepEqual(Buffer.from(await (await f.request('/api/profile/avatar', cookie)).arrayBuffer()), avatar);
    await f.create(cookie);
    await f.restart();
    assert.equal((await f.request('/api/admin/users', cookie)).status, 200);
    assert.deepEqual(Buffer.from(await (await f.request('/api/profile/avatar', cookie)).arrayBuffer()), avatar);
    assert.equal(f.runtime.db.connection.prepare('SELECT password_hash FROM auth_users WHERE id = 1').get()!.password_hash, hash.toString('hex'));
  } finally { await f.close(); }
});

test('administrators create unique normalized accounts; public status and account listings never expose hashes', async () => {
  const f = await fixture();
  try {
    const admin = await f.setup();
    const viewer = await f.create(admin, { username: '  Ｒｅａｄｅｒ  ' });
    assert.equal(viewer.username, 'Reader'); assert.equal(viewer.role, 'viewer'); assert.equal(viewer.disabled, false);
    assert.equal(viewer.lastLoginAt, null); assert.equal(typeof viewer.createdAt, 'string');
    const duplicate = await f.json('/api/admin/users', { ...viewerCredentials, username: 'reader', role: 'admin' }, admin);
    assert.equal(duplicate.status, 409);
    assert.equal((await f.json('/api/admin/users', { ...viewerCredentials, password: 'short', role: 'viewer' }, admin)).status, 400);
    assert.equal((await f.json('/api/admin/users', { ...viewerCredentials, role: 'root' }, admin)).status, 400);
    const session = await f.login({ ...viewerCredentials, username: 'rEaDeR' });
    const status = await (await f.request('/api/auth/status', session)).json() as AuthStatus;
    assert.equal(status.userId, viewer.id); assert.equal(status.role, 'viewer');
    assert.deepEqual(await (await f.request('/api/auth/status')).json(), { configured: true, authenticated: false, setupAllowed: false });
    const accounts = await (await f.request('/api/admin/users', admin)).json() as AdminUser[];
    assert.equal(accounts.length, 2); assert(accounts.find(row => row.id === viewer.id)!.lastLoginAt);
    assert(!JSON.stringify(accounts).includes('salt')); assert(!JSON.stringify(accounts).includes('password'));
  } finally { await f.close(); }
});

test('account administration rejects anonymous/viewer requests before parsing and cannot modify the current administrator', async () => {
  const f = await fixture();
  try {
    const admin = await f.setup(); const viewer = await f.create(admin); const cookie = await f.login();
    for (const [method, path] of [['GET', '/api/admin/users'], ['POST', '/api/admin/users'], ['PATCH', `/API/ADMIN/USERS/${viewer.id}`], ['DELETE', `/api/admin/users/${viewer.id}`]]) {
      for (const [credential, status] of [['', 401], [cookie, 403]] as const) {
        const response = await f.request(path, credential, { method, ...(method === 'GET' ? {} : { headers: { 'Content-Type': 'application/json' }, body: '{invalid' }) });
        assert.equal(response.status, status, `${method} ${path}`);
      }
    }
    for (const fields of [{ username: 'new-admin' }, { role: 'viewer' }, { disabled: true }, { password: 'a new copper lantern by the lake' }]) {
      assert.equal((await f.json('/api/admin/users/1', fields, admin, 'PATCH')).status, 403);
    }
    assert.equal((await f.request('/api/admin/users/1', admin, { method: 'DELETE' })).status, 403);
    assert.equal((await f.request(`/api/admin/users/${viewer.id}`, admin, { method: 'DELETE', headers: { Origin: 'https://other.example' } })).status, 403);
    assert.equal((await f.request('/api/admin/users', admin)).status, 200);
    assert.equal(f.runtime.db.connection.prepare('SELECT COUNT(*) AS count FROM auth_users').get()!.count, 2);
  } finally { await f.close(); }
});

test('role changes, disablement, resets and deletion revoke only target sessions; re-created usernames get fresh identities', async () => {
  const f = await fixture();
  try {
    const admin = await f.setup(); const target = await f.create(admin); let viewer = await f.login();
    const changed = await f.json(`/api/admin/users/${target.id}`, { role: 'admin' }, admin, 'PATCH');
    assert.equal(changed.status, 200);
    assert.equal((await f.request('/api/albums', viewer)).status, 401);
    viewer = await f.login(); assert.equal((await f.request('/api/admin/users', viewer)).status, 200);
    assert.equal((await f.json(`/api/admin/users/${target.id}`, { disabled: true }, admin, 'PATCH')).status, 200);
    assert.equal((await f.request('/api/albums', viewer)).status, 401);
    const disabled = await f.json('/api/auth/login', viewerCredentials); assert.equal(disabled.status, 401);
    assert.deepEqual(await disabled.json(), { error: '用户名或密码不正确' });
    assert.equal((await f.json(`/api/admin/users/${target.id}`, { disabled: false, role: 'viewer' }, admin, 'PATCH')).status, 200);
    viewer = await f.login();
    const password = 'silver mountains beyond the river';
    assert.equal((await f.json(`/api/admin/users/${target.id}`, { password, username: 'renamed-reader' }, admin, 'PATCH')).status, 200);
    assert.equal((await f.request('/api/albums', viewer)).status, 401);
    viewer = await f.login({ username: 'renamed-reader', password });
    assert.equal(f.runtime.db.connection.prepare('SELECT COUNT(*) AS count FROM security_sources WHERE user_id=?').get(target.id)!.count, 1);
    await f.json('/api/auth/password', { currentPassword: 'incorrect password', newPassword: 'another silver lantern by the lake' }, viewer);
    assert(Number(f.runtime.db.connection.prepare('SELECT COUNT(*) AS count FROM auth_throttle WHERE key LIKE ?').get(`password:user:${target.id}:%`)!.count) > 0);
    assert.equal((await f.request(`/api/admin/users/${target.id}`, admin, { method: 'DELETE' })).status, 200);
    assert.equal((await f.request('/api/albums', viewer)).status, 401);
    assert.equal(f.runtime.db.connection.prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id=?').get(target.id)!.count, 0);
    assert.equal(f.runtime.db.connection.prepare('SELECT COUNT(*) AS count FROM security_sources WHERE user_id=?').get(target.id)!.count, 0);
    assert.equal(f.runtime.db.connection.prepare('SELECT COUNT(*) AS count FROM auth_throttle WHERE key LIKE ?').get(`password:user:${target.id}:%`)!.count, 0);
    const replacement = await f.create(admin, { username: 'renamed-reader' });
    assert(replacement.id > target.id, 'deleted user identity must not be reused for sessions or notification history');
    assert.equal((await f.request('/api/albums', admin)).status, 200);
  } finally { await f.close(); }
});

test('own password changes invalidate only that account and avatars remain private to each user', async () => {
  const f = await fixture();
  try {
    const admin = await f.setup(); const target = await f.create(admin); const viewer = await f.login();
    const upload = async (cookie: string, color: string) => {
      const bytes = await sharp({ create: { width: 10, height: 8, channels: 3, background: color } }).png().toBuffer();
      const body = new FormData(); body.set('avatar', new Blob([Uint8Array.from(bytes)], { type: 'image/png' }), 'avatar.png');
      const response = await f.request('/api/profile/avatar', cookie, { method: 'POST', body });
      assert.equal(response.status, 200, await response.clone().text());
    };
    await upload(admin, '#ff3311'); await upload(viewer, '#2233ee');
    const adminAvatar = Buffer.from(await (await f.request('/api/profile/avatar', admin)).arrayBuffer());
    const viewerAvatar = Buffer.from(await (await f.request('/api/profile/avatar', viewer)).arrayBuffer());
    assert.notDeepEqual(viewerAvatar, adminAvatar);
    assert.equal((await f.request('/api/profile/avatar?userId=1', viewer)).status, 200);
    assert.deepEqual(Buffer.from(await (await f.request('/api/profile/avatar?userId=1', viewer)).arrayBuffer()), viewerAvatar);
    const changed = await f.json('/api/auth/password', { currentPassword: viewerCredentials.password, newPassword: 'a red lantern beside the river' }, viewer);
    assert.equal(changed.status, 200, await changed.clone().text());
    assert.equal((await f.request('/api/albums', viewer)).status, 401);
    assert.equal((await f.request('/api/albums', admin)).status, 200);
    const fresh = cookieFrom(changed);
    assert.deepEqual(Buffer.from(await (await f.request('/api/profile/avatar', fresh)).arrayBuffer()), viewerAvatar);
    await f.restart();
    assert.deepEqual(Buffer.from(await (await f.request('/api/profile/avatar', fresh)).arrayBuffer()), viewerAvatar);
    assert.equal((await f.request(`/api/admin/users/${target.id}`, admin, { method: 'DELETE' })).status, 200);
    assert.equal(f.runtime.db.connection.prepare('SELECT COUNT(*) AS count FROM account_profile WHERE id=?').get(target.id)!.count, 0);
    assert.deepEqual(Buffer.from(await (await f.request('/api/profile/avatar', admin)).arrayBuffer()), adminAvatar);
  } finally { await f.close(); }
});

test('a viewer cannot consume the administrator password-change throttle budget', async () => {
  const f = await fixture();
  try {
    const admin = await f.setup(); await f.create(admin); const viewer = await f.login();
    const replacement = 'a red lantern beside the river';
    for (let attempt = 0; attempt < 5; attempt++) {
      const failed = await f.json('/api/auth/password', { currentPassword: 'incorrect-current-password', newPassword: replacement }, viewer);
      assert.equal(failed.status, 400);
    }
    assert.equal((await f.json('/api/auth/password', { currentPassword: viewerCredentials.password, newPassword: replacement }, viewer)).status, 429);
    const changed = await f.json('/api/auth/password', { currentPassword: adminCredentials.password, newPassword: replacement }, admin);
    assert.equal(changed.status, 200, await changed.clone().text());
    assert.equal((await f.request('/api/admin/users', cookieFrom(changed))).status, 200);
    assert.equal((await f.request('/api/albums', viewer)).status, 200, 'failed password attempts do not remove the existing viewer session');
  } finally { await f.close(); }
});
