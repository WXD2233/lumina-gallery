import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import JSZip from 'jszip';
import { createApp } from './index.ts';

const credentials = { username: 'hardening-admin', password: 'moss lantern violet sunrise' };
const wrong = { ...credentials, password: 'an incorrect gallery passphrase' };
const cookieFrom = (response: Response) => {
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert(cookie, `successful authentication must set a cookie (${response.status})`);
  return cookie;
};

interface ThrottleRow {
  key: string; scope: string; attempts: number; window_until: number; failures: number;
  last_failure_at: number; blocked_until: number; expires_at: number;
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-auth-hardening-'));
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
  const request = (path: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    directory, request,
    get runtime() { return runtime; },
    rows() { return runtime.db.connection.prepare("SELECT * FROM auth_throttle WHERE scope = 'login' ORDER BY key").all() as unknown as ThrottleRow[]; },
    async setup() {
      const response = await request('/api/auth/setup', credentials);
      assert.equal(response.status, 201, await response.clone().text());
      return cookieFrom(response);
    },
    async restart() { await stop(); runtime = await createApp({ dataDir: directory }); server = runtime.app.listen(0, '127.0.0.1'); await listening(); },
    async close() { await stop(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('login cooldown persists across restart and cannot be bypassed by usernames, case variants or forwarding headers', async () => {
  const context = await fixture();
  try {
    const cookie = await context.setup();
    for (let index = 0; index < 5; index++) {
      const response = await context.request('/api/auth/login', { ...wrong, username: index % 2 ? `unknown-${index}` : credentials.username }, undefined, { 'X-Forwarded-For': `203.0.113.${index + 1}` });
      assert.equal(response.status, 401);
      const body = await response.json() as { error: string; retryAfterSeconds?: number };
      assert.equal(body.error, '用户名或密码不正确');
      if (index === 4) {
        assert(Number(response.headers.get('retry-after')) > 0);
        assert(body.retryAfterSeconds && body.retryAfterSeconds > 0, 'the threshold failure immediately tells the UI to start its countdown');
      }
    }
    const before = context.rows();
    assert.equal(before.length, 2, 'forwarded IPs and usernames must not create new source buckets');
    assert(before.some(row => row.blocked_until > Date.now()));
    for (const path of ['/api/auth/login', '/API/AUTH/LOGIN', '/api/auth/login/']) {
      const response = await context.request(path, credentials, undefined, { 'X-Forwarded-For': '198.51.100.88', 'X-Real-IP': '198.51.100.89', Forwarded: 'for=198.51.100.90' });
      assert.equal(response.status, 429, path);
      assert(Number(response.headers.get('retry-after')) > 0);
    }
    assert.deepEqual(context.rows(), before, 'rejected requests must not extend the cooldown or increase failure counts');
    await context.restart();
    assert.deepEqual(context.rows(), before, 'restarting the service must preserve security state');
    const limited = await context.request('/api/auth/login', credentials);
    assert.equal(limited.status, 429);
    assert(Number(limited.headers.get('retry-after')) > 0);
    assert.equal((await context.request('/api/albums', undefined, cookie)).status, 200, 'existing authenticated access is unaffected');
  } finally { await context.close(); }
});

test('expired cooldown permits correct login and clears failures without resetting the attempt window', async () => {
  const context = await fixture();
  try {
    await context.setup();
    for (let index = 0; index < 5; index++) assert.equal((await context.request('/api/auth/login', wrong)).status, 401);
    assert.equal((await context.request('/api/auth/login', credentials)).status, 429);
    // Advance only the persisted cooldown in this isolated fixture, retaining its attempt window.
    context.runtime.db.connection.prepare("UPDATE auth_throttle SET blocked_until = ? WHERE scope = 'login'").run(Date.now() - 1);
    const success = await context.request('/api/auth/login', credentials);
    assert.equal(success.status, 200, await success.clone().text());
    assert.equal((await context.request('/api/albums', undefined, cookieFrom(success))).status, 200);
    const rows = context.rows();
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.failures, 0);
      assert.equal(row.blocked_until, 0);
      assert.equal(row.attempts, 6, 'successful authentication does not grant unlimited request throughput');
    }
    assert.equal((await context.request('/api/auth/login', wrong)).status, 401, 'one new mistake begins a new failure sequence');
    assert(context.rows().every(row => row.failures === 1 && row.blocked_until === 0));
  } finally { await context.close(); }
});

test('parallel login pressure is bounded and does not mint sessions for failed passwords', async () => {
  const context = await fixture();
  try {
    const cookie = await context.setup();
    const responses = await Promise.all(Array.from({ length: 12 }, () => context.request('/api/auth/login', wrong)));
    assert(responses.some(response => response.status === 429), 'parallel guesses must be rejected before unlimited scrypt work starts');
    assert(responses.filter(response => response.status === 401).length <= 3, 'public authentication has at most three concurrent derivations');
    for (const response of responses) {
      assert([401, 429].includes(response.status), await response.clone().text());
      assert.equal(response.headers.get('set-cookie'), null);
      if (response.status === 429) assert(Number(response.headers.get('retry-after')) > 0);
    }
    assert.equal(context.runtime.db.connection.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get()!.count, 1);
    assert.equal((await context.request('/api/albums', undefined, cookie)).status, 200);
  } finally { await context.close(); }
});

test('login lockout leaves account management and logout available to an authenticated administrator', async () => {
  const context = await fixture();
  try {
    const cookie = await context.setup();
    for (let index = 0; index < 5; index++) assert.equal((await context.request('/api/auth/login', wrong)).status, 401);
    assert.equal((await context.request('/api/auth/login', credentials)).status, 429);
    const password = await context.request('/api/auth/password', { currentPassword: credentials.password, newPassword: 'cedar notebook moonlit harbor' }, cookie);
    assert.equal(password.status, 200, await password.clone().text());
    const rotated = cookieFrom(password);
    assert.equal((await context.request('/api/albums', undefined, cookie)).status, 401);
    assert.equal((await context.request('/api/albums', undefined, rotated)).status, 200);
    assert.equal((await context.request('/api/auth/logout', {}, rotated)).status, 200);
    assert.equal((await context.request('/api/albums', undefined, rotated)).status, 401);
  } finally { await context.close(); }
});

test('exported backups exclude persisted authentication throttle state', async () => {
  const context = await fixture();
  try {
    const cookie = await context.setup();
    assert.equal((await context.request('/api/auth/login', wrong)).status, 401);
    const rows = context.rows(); assert.equal(rows.length, 2);
    const response = await context.request('/api/backups', { format: 'zip' }, cookie);
    assert.equal(response.status, 201, await response.clone().text());
    const metadata = await response.json() as { downloadUrl: string };
    const download = await context.request(metadata.downloadUrl, undefined, cookie);
    assert.equal(download.status, 200);
    const archive = await JSZip.loadAsync(await download.arrayBuffer());
    const manifest = await archive.file('manifest.json')!.async('string');
    assert(!manifest.includes('auth_throttle'));
    for (const row of rows) assert(!manifest.includes(row.key));
    const snapshotPath = join(context.directory, 'throttle-export-check.db');
    await writeFile(snapshotPath, await archive.file('data/gallery.db')!.async('nodebuffer'));
    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
    try {
      assert.deepEqual(snapshot.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name), ['albums', 'categories', 'settings', 'sync_logs']);
    } finally { snapshot.close(); }
    assert.deepEqual(context.rows(), rows, 'exporting a backup must not reset the live security controls');
  } finally { await context.close(); }
});
