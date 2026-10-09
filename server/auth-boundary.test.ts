import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { request as httpRequest } from 'node:http';
import JSZip from 'jszip';
import sharp from 'sharp';
import type { Album } from '../shared/types.ts';
import type { BackupImportPreview } from '../shared/backup-import.ts';
import { normalizeInput } from './db.ts';
import { createApp } from './index.ts';

const credentials = { username: 'boundary-admin', password: 'Boundary-Password-2026!' };
const secretTitle = 'PRIVATE-GALLERY-CONTENT-BOUNDARY';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-auth-boundary-'));
  const runtime = await createApp({ dataDir: directory, allowedHosts: ['127.0.0.1', 'localhost', '[::1]', 'gallery.test'] });
  const bytes = await sharp({ create: { width: 12, height: 18, channels: 3, background: '#67538a' } }).png().toBuffer();
  const thumbnail = await sharp(bytes).webp().toBuffer();
  await writeFile(join(directory, 'uploads', 'private-original.png'), bytes);
  await writeFile(join(directory, 'uploads', 'private-thumb.webp'), thumbnail);
  const now = '2026-10-08T01:00:00.000Z';
  const album: Album = {
    ...normalizeInput({ title: secretTitle, category: '测试分类', links: [] }, undefined, now),
    id: 'private-album', favorite: false, createdAt: now, updatedAt: now, localUpdatedAt: now, updateSource: 'local',
    images: [{ id: 'private-image', name: 'private.png', url: '/uploads/private-original.png', thumbnailUrl: '/uploads/private-thumb.webp', width: 12, height: 18, size: bytes.length }],
  };
  runtime.db.save(album);
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const request = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);
  const json = (path: string, body: unknown, cookie?: string, headers?: Record<string, string>) => request(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: JSON.stringify(body),
  });
  const setup = async () => {
    const response = await json('/api/auth/setup', credentials);
    assert.equal(response.status, 201, await response.clone().text());
    const cookie = response.headers.get('set-cookie')?.split(';')[0]; assert(cookie);
    return cookie;
  };
  return { directory, runtime, base, bytes, album, request, json, setup, async close() {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  } };
}

test('private routes and images are closed before the first account exists', async () => {
  const context = await fixture();
  try {
    for (const path of ['/api/albums', '/API/ALBUMS', '/api/settings', '/api/logs', '/api/categories', '/uploads/private-original.png', '/UPLOADS/private-thumb.webp']) {
      const response = await context.request(path);
      assert.equal(response.status, 401, path);
      assert(!(await response.text()).includes(secretTitle), path);
    }
    const status = await context.request('/api/auth/status');
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { configured: false, authenticated: false, setupAllowed: true });
    assert.equal((await context.request('/api/health')).status, 200);
    assert.equal(context.runtime.db.albums().length, 1, 'adding access control preserves the existing gallery');
  } finally { await context.close(); }
});

test('authentication protects case variants, upload bytes, conditional requests and every mutation before body parsing', async () => {
  const context = await fixture();
  try {
    const cookie = await context.setup();
    const original = await context.request('/uploads/private-original.png', { headers: { Cookie: cookie } });
    assert.equal(original.status, 200);
    assert.match(original.headers.get('cache-control') ?? '', /private/);
    assert.match(original.headers.get('cache-control') ?? '', /no-store/);
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), context.bytes);
    const etag = original.headers.get('etag') ?? '"existing-image"';
    const privatePaths = [
      '/api/albums', '/API/ALBUMS', '/api/Albums/private-album', '/api/categories', '/api/settings', '/api/logs',
      '/api/backups/known-id/download', '/API/BACKUPS/known-id/download', '/api/unknown',
      '/uploads/private-original.png', '/UPLOADS/private-original.png', '/uploads/%70rivate-original.png',
      '/uploads/private-thumb.webp', '/UpLoAdS/private-thumb.webp',
    ];
    for (const path of privatePaths) {
      for (const method of ['GET', 'HEAD']) {
        const response = await context.request(path, { method, headers: { Range: 'bytes=0-7', 'If-None-Match': etag } });
        assert.equal(response.status, 401, `${method} ${path}`);
        assert.match(response.headers.get('cache-control') ?? '', /no-store/);
        const body = await response.text(); assert(!body.includes(secretTitle));
      }
    }
    for (const [method, path] of [
      ['POST', '/api/albums'], ['PATCH', '/API/albums/private-album'], ['DELETE', '/api/albums/private-album'],
      ['POST', '/api/albums/private-album/images'], ['DELETE', '/api/albums/private-album/images/private-image'],
      ['POST', '/api/categories'], ['PATCH', '/api/categories/test'], ['DELETE', '/api/categories/test'],
      ['PATCH', '/api/settings'], ['POST', '/api/sync'], ['POST', '/api/link-checks'],
      ['POST', '/api/albums/private-album/sync'], ['POST', '/api/albums/private-album/link-checks'],
      ['POST', '/api/albums/private-album/links/test/check'], ['POST', '/api/backups'], ['POST', '/api/backup-imports'],
      ['POST', '/api/backup-imports/test/commit'], ['DELETE', '/api/backup-imports/test'],
    ]) {
      const response = await context.request(path!, { method, headers: { 'Content-Type': 'application/json' }, body: '{malformed' });
      assert.equal(response.status, 401, `${method} ${path}`);
    }
    const oversized = await context.request('/api/backup-imports/test/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ' '.repeat(300_000) });
    assert.equal(oversized.status, 401, 'untrusted bodies are rejected before parsers');
    assert.deepEqual(await readdir(join(context.directory, '.incoming')), []);
    assert.deepEqual(await readdir(join(context.directory, '.imports')), []);
    assert.equal(context.runtime.db.albums().length, 1);
    assert.equal((await context.json('/api/auth/logout', {}, cookie)).status, 200);
    assert.equal((await context.request('/uploads/private-original.png', { headers: { Cookie: cookie, 'If-None-Match': etag } })).status, 401);
  } finally { await context.close(); }
});

test('first account setup rejects cross-site, custom-host and forwarded requests and is atomic', async () => {
  const context = await fixture();
  try {
    const headersToReject: Record<string, string>[] = [
      { Origin: 'https://attacker.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { Host: 'gallery.test' },
      { Forwarded: 'for=203.0.113.4;host=localhost' }, { 'X-Forwarded-For': '127.0.0.1' },
      { 'X-Forwarded-Host': 'localhost' }, { 'X-Forwarded-Proto': 'http' }, { 'X-Forwarded-Port': '80' },
      { 'X-Real-IP': '127.0.0.1' },
    ];
    for (const headers of headersToReject) {
      // Undici fetch rewrites Host, so the custom-host test uses an actual HTTP header.
      const status = headers.Host ? await new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest(`${context.base}/API/AUTH/SETUP`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, response => { response.resume(); resolve(response.statusCode); });
        request.on('error', reject); request.end(JSON.stringify(credentials));
      }) : (await context.json('/API/AUTH/SETUP', credentials, undefined, headers)).status;
      assert.equal(status, 403, JSON.stringify(headers));
    }
    assert.equal(context.runtime.db.connection.prepare("SELECT COUNT(*) AS count FROM auth_throttle WHERE scope = 'setup'").get()!.count, 0,
      'ineligible remote or forwarded setup requests must not consume the real local administrator setup budget');
    assert.equal((await (await context.request('/api/auth/status')).json()).configured, false);
    const attempts = await Promise.all([context.json('/api/auth/setup', credentials), context.json('/api/auth/setup', { ...credentials, username: 'other-admin' })]);
    assert.deepEqual(attempts.map(response => response.status).sort(), [201, 409]);
    assert.equal(context.runtime.db.connection.prepare('SELECT count(*) AS count FROM auth_users').get()?.count, 1);
    const publicStatus = await (await context.request('/api/auth/status')).json();
    assert.equal(publicStatus.configured, true); assert.equal(publicStatus.authenticated, false);
    assert(!Object.hasOwn(publicStatus, 'username'), 'public status does not disclose the account name');
  } finally { await context.close(); }
});

test('authenticated case-insensitive API routes still reject cross-site changes', async () => {
  const context = await fixture();
  try {
    const cookie = await context.setup();
    const hostileHeaders: Record<string, string>[] = [{ Origin: 'https://attacker.example' }, { 'Sec-Fetch-Site': 'cross-site' }];
    for (const headers of hostileHeaders) {
      const response = await context.request('/API/SETTINGS', { method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ autoSync: false }) });
      assert.equal(response.status, 403);
      assert.equal((await context.json('/API/AUTH/LOGOUT', {}, cookie, headers)).status, 403);
    }
    const status = await context.request('/api/auth/status', { headers: { Cookie: cookie } });
    assert.equal((await status.json()).authenticated, true, 'a hostile logout never revokes the valid session');
    assert.equal(context.runtime.db.settings().autoSync, true);
  } finally { await context.close(); }
});

test('backup downloads require login and exported backups contain no login credentials or sessions', async () => {
  const context = await fixture();
  try {
    const cookie = await context.setup();
    const exported = await context.json('/api/backups', { format: 'zip' }, cookie);
    assert.equal(exported.status, 201, await exported.clone().text());
    const metadata = await exported.json() as { downloadUrl: string };
    for (const method of ['GET', 'HEAD']) assert.equal((await context.request(metadata.downloadUrl, { method })).status, 401);
    const downloaded = await context.request(metadata.downloadUrl, { headers: { Cookie: cookie } });
    assert.equal(downloaded.status, 200);
    const archive = await JSZip.loadAsync(await downloaded.arrayBuffer());
    const manifestText = await archive.file('manifest.json')!.async('string');
    const manifest = JSON.parse(manifestText);
    assert.deepEqual(Object.keys(manifest.settings).sort(), ['autoSync', 'intervalHours']);
    assert(!manifestText.includes(credentials.username)); assert(!manifestText.includes(credentials.password));
    const user = context.runtime.db.connection.prepare('SELECT * FROM auth_users').get()!;
    const sessions = context.runtime.db.connection.prepare('SELECT * FROM auth_sessions').all();
    const sensitive = [credentials.username, credentials.password, cookie.split('=')[1]!, String(user.password_hash), String(user.salt), ...sessions.map(row => String(row.token_hash))];
    for (const entry of Object.values(archive.files).filter(entry => !entry.dir)) {
      const bytes = await entry.async('nodebuffer');
      for (const value of sensitive) assert(!bytes.includes(Buffer.from(value)), `${entry.name} leaked login data`);
    }
    const snapshotPath = join(context.directory, 'export-inspection.db');
    await writeFile(snapshotPath, await archive.file('data/gallery.db')!.async('nodebuffer'));
    const snapshotDb = new DatabaseSync(snapshotPath, { readOnly: true });
    try {
      const tables = snapshotDb.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
      assert.deepEqual(tables, ['albums', 'categories', 'settings', 'sync_logs']);
      assert.deepEqual(snapshotDb.prepare('SELECT key FROM settings ORDER BY key').all().map(row => row.key), ['autoSync', 'categoriesInitialized']);
    } finally { snapshotDb.close(); }
  } finally { await context.close(); }
});

test('backup import cannot replace an administrator or revive a supplied session', async () => {
  const context = await fixture();
  try {
    const cookie = await context.setup();
    const beforeUsers = context.runtime.db.connection.prepare('SELECT * FROM auth_users').all();
    const beforeSessions = context.runtime.db.connection.prepare('SELECT * FROM auth_sessions').all();
    const exported = await context.json('/api/backups', { format: 'zip' }, cookie);
    assert.equal(exported.status, 201);
    const metadata = await exported.json() as { downloadUrl: string };
    const archive = await JSZip.loadAsync(await (await context.request(metadata.downloadUrl, { headers: { Cookie: cookie } })).arrayBuffer());
    const manifest = JSON.parse(await archive.file('manifest.json')!.async('string'));
    manifest.auth_users = [{ id: 1, username: 'injected-admin', password_hash: 'attacker' }];
    manifest.auth_sessions = [{ token_hash: 'attacker-session' }];
    manifest.settings.authConfigured = false;
    archive.file('manifest.json', JSON.stringify(manifest));
    archive.file('data/gallery.db', 'Attacker-controlled database must never be opened for merge imports.');
    const body = new FormData();
    body.set('file', new Blob([await archive.generateAsync({ type: 'arraybuffer' })], { type: 'application/zip' }), 'auth-injection.zip');
    const previewResponse = await context.request('/api/backup-imports', { method: 'POST', headers: { Cookie: cookie }, body });
    assert.equal(previewResponse.status, 201, await previewResponse.clone().text());
    const preview = await previewResponse.json() as BackupImportPreview;
    const committed = await context.json(`/api/backup-imports/${preview.id}/commit`, { albumKeys: preview.albums.map(album => album.key), duplicateMode: 'copy' }, cookie);
    assert.equal(committed.status, 200, await committed.clone().text());
    assert.equal((await committed.json()).imported, 1);
    assert.deepEqual(context.runtime.db.connection.prepare('SELECT * FROM auth_users').all(), beforeUsers);
    assert.deepEqual(context.runtime.db.connection.prepare('SELECT * FROM auth_sessions').all(), beforeSessions);
    assert.equal((await (await context.request('/api/auth/status', { headers: { Cookie: cookie } })).json()).authenticated, true);
    assert.equal(context.runtime.db.value('authConfigured'), undefined);
  } finally { await context.close(); }
});
