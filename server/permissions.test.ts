import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { createApp } from './index.ts';
import { normalizeInput } from './db.ts';

async function fixture() {
  const prefix = join(tmpdir(), 'lumina-permissions-');
  const directory = await mkdtemp(prefix);
  const runtime = await createApp({ dataDir: directory });
  const picture = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#818abf' } }).png().toBuffer();
  await writeFile(join(directory, 'uploads', 'permission-test.png'), picture);
  const now = new Date().toISOString();
  runtime.db.save({ ...normalizeInput({ title: 'Shared library', category: 'Shared' }), id: 'shared', favorite: false, createdAt: now, updatedAt: now, localUpdatedAt: now, updateSource: 'local', images: [{ id: 'original', name: 'example.png', url: '/uploads/permission-test.png', thumbnailUrl: '/uploads/permission-test.png', size: picture.length, width: 20, height: 30 }] });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const request = (path: string, cookie: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { Cookie: cookie, ...Object.fromEntries(new Headers(init.headers)) }, redirect: 'error' });
  const json = (path: string, cookie: string, body: object, method = 'POST') => request(path, cookie, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const setup = await json('/api/auth/setup', '', { username: 'permissions-admin', password: 'violet leaves across the meadow' });
  assert.equal(setup.status, 201, await setup.clone().text());
  const admin = setup.headers.get('set-cookie')!.split(';')[0];
  const created = await json('/api/admin/users', admin, { username: 'permissions-viewer', password: 'silver river across the valley', role: 'viewer' });
  assert.equal(created.status, 201, await created.clone().text());
  const viewerInfo = await created.json() as { id: number };
  const login = await json('/api/auth/login', '', { username: 'permissions-viewer', password: 'silver river across the valley' });
  assert.equal(login.status, 200, await login.clone().text());
  const viewer = login.headers.get('set-cookie')!.split(';')[0];
  return { runtime, directory, admin, viewer, viewerInfo, picture, request, json, async close() {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await runtime.close();
    assert(resolve(directory).startsWith(resolve(prefix)));
    await rm(directory, { recursive: true, force: true });
  } };
}

test('viewers can browse and download but cannot mutate gallery or read admin/import data, including case variants', async () => {
  const f = await fixture();
  try {
    for (const path of ['/api/albums', '/API/ALBUMS/shared', '/api/categories', '/api/settings', '/api/logs', '/api/profile']) {
      assert.equal((await f.request(path, f.viewer)).status, 200, path);
    }
    const image = await f.request('/UPLOADS/permission-test.png', f.viewer);
    assert.equal(image.status, 200); assert.deepEqual(Buffer.from(await image.arrayBuffer()), f.picture);
    const initial = JSON.stringify(f.runtime.db.albums());
    for (const [method, path] of [
      ['POST', '/api/albums'], ['POST', '/API/ALBUMS/shared/images'], ['PATCH', '/api/albums/shared'],
      ['DELETE', '/api/albums/shared'], ['DELETE', '/api/albums/shared/images/original'],
      ['POST', '/api/categories'], ['PATCH', '/api/categories/Shared'], ['DELETE', '/api/categories/Shared'],
      ['PATCH', '/api/settings'], ['POST', '/api/sync'], ['POST', '/api/albums/shared/sync'],
      ['POST', '/api/link-checks'], ['POST', '/api/albums/shared/link-checks'], ['POST', '/api/albums/shared/links/example/check'],
      ['POST', '/api/backup-imports'], ['GET', '/API/BACKUP-IMPORTS/example'], ['DELETE', '/api/backup-imports/example'],
      ['POST', '/api/backup-imports/example/import'], ['GET', '/API/ADMIN/USERS'], ['POST', '/api/admin/users'],
      ['GET', '/api/admin/security/settings'], ['GET', '/api/admin/security/events'], ['PATCH', '/api/admin/security/settings'], ['POST', '/api/admin/security/test'],
      ['GET', '/API/ADMIN/AUTO-BACKUPS'], ['PATCH', '/api/admin/auto-backups/settings'], ['PATCH', '/api/admin/auto-backups/webdav'], ['POST', '/api/admin/auto-backups/webdav/test'], ['POST', '/api/admin/auto-backups/run'], ['GET', '/api/admin/auto-backups/example/download'],
    ]) {
      const init: RequestInit = { method };
      if (!['GET', 'HEAD'].includes(method)) { init.headers = { 'Content-Type': 'application/json' }; init.body = '{malformed'; }
      const result = await f.request(path, f.viewer, init);
      assert.equal(result.status, 403, `${method} ${path}: ${await result.text()}`);
    }
    const upload = new FormData(); upload.append('images', new Blob([Uint8Array.from(f.picture)], { type: 'image/png' }), 'file.png');
    assert.equal((await f.request('/api/albums', f.viewer, { method: 'POST', body: upload })).status, 403);
    assert.deepEqual(await readdir(join(f.directory, '.incoming')), []);
    assert.equal(JSON.stringify(f.runtime.db.albums()), initial);
    assert.equal((await f.json('/api/albums/shared', f.admin, { title: 'Admin edited' }, 'PATCH')).status, 200);
    assert.equal(f.runtime.db.requireAlbum('shared').title, 'Admin edited');
  } finally { await f.close(); }
});

test('viewer backup downloads exclude all account and security settings and preserve the gallery', async () => {
  const f = await fixture();
  try {
    const response = await f.json('/api/backups', f.viewer, { format: 'zip' });
    assert.equal(response.status, 201, await response.clone().text());
    const result = await response.json() as { downloadUrl: string };
    assert.equal((await f.request(result.downloadUrl, '')).status, 401);
    const download = await f.request(result.downloadUrl, f.viewer);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-type') ?? '', /zip/);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(await download.arrayBuffer());
    const manifestPath = Object.keys(zip.files).find(name => /manifest\.json$/.test(name));
    assert(manifestPath);
    const manifest = await zip.file(manifestPath)!.async('string');
    assert(!manifest.includes('permissions-admin')); assert(!manifest.includes('security_config')); assert(!manifest.includes('password_hash'));
    assert.equal(f.runtime.db.albums().length, 1);
  } finally { await f.close(); }
});
