import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import JSZip from 'jszip';
import sharp from 'sharp';
import { createApp } from './index.ts';
import type { Profile } from '../shared/profile.ts';

async function fixture() {
  const prefix = join(tmpdir(), 'lumina-profile-');
  const directory = await mkdtemp(prefix);
  let runtime = await createApp({ dataDir: directory });
  let server = runtime.app.listen(0, '127.0.0.1');
  let base = '';
  let cookie = '';
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
  const request = (path: string, init: RequestInit = {}, authenticated = true) => fetch(`${base}${path}`, {
    ...init,
    headers: { ...(authenticated && cookie ? { Cookie: cookie } : {}), ...Object.fromEntries(new Headers(init.headers)) },
    redirect: 'error',
  });
  return {
    directory, request,
    get runtime() { return runtime; },
    async authenticate() {
      const setup = await request('/api/auth/setup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'profile-test-admin', password: 'a copper lantern by the lake' }),
      }, false);
      assert.equal(setup.status, 201, await setup.clone().text());
      cookie = setup.headers.get('set-cookie')?.split(';')[0] ?? '';
      assert(cookie);
    },
    upload(bytes: Uint8Array, name = 'avatar.png', type = 'image/png', extraHeaders: Record<string, string> = {}) {
      const body = new FormData();
      body.set('avatar', new Blob([Uint8Array.from(bytes)], { type }), name);
      return request('/api/profile/avatar', { method: 'POST', body, headers: extraHeaders });
    },
    async restart() {
      await stop();
      runtime = await createApp({ dataDir: directory });
      server = runtime.app.listen(0, '127.0.0.1');
      await listening();
    },
    async close() {
      await stop();
      assert(resolve(directory).startsWith(resolve(prefix)), 'only remove this isolated test directory');
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const picture = (background = '#6652b8', width = 120, height = 80) => sharp({
  create: { width, height, channels: 3, background },
}).png().toBuffer();

test('profile and avatar require a session, and avatar writes reject cross-site requests', async () => {
  const context = await fixture();
  try {
    await context.authenticate();
    for (const [path, method] of [
      ['/api/profile', 'GET'], ['/api/profile/avatar', 'GET'],
      ['/api/profile/avatar', 'POST'], ['/api/profile/avatar', 'DELETE'],
    ]) {
      const response = await context.request(path, { method }, false);
      assert.equal(response.status, 401, `${method} ${path} must authenticate before parsing upload data`);
      assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    }
    assert.deepEqual(await (await context.request('/api/profile')).json(), { avatarUrl: null });
    assert.equal((await context.request('/api/profile/avatar')).status, 404);
    const bytes = await picture();
    assert.equal((await context.upload(bytes, 'avatar.png', 'image/png', { Origin: 'https://other.example' })).status, 403);
    assert.equal((await context.request('/api/profile/avatar', {
      method: 'DELETE', headers: { 'Sec-Fetch-Site': 'cross-site' },
    })).status, 403);
    assert.deepEqual(await (await context.request('/api/profile')).json(), { avatarUrl: null });
  } finally { await context.close(); }
});

test('avatar upload creates a private square WebP, removes metadata, and persists with the account across restart', async () => {
  const context = await fixture();
  try {
    await context.authenticate();
    const credentials = context.runtime.db.connection.prepare('SELECT * FROM auth_users').all();
    const original = await sharp(await picture('#ee6b53', 240, 120)).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const uploaded = await context.upload(original, 'holiday.jpg', 'image/jpeg');
    assert.equal(uploaded.status, 200, await uploaded.clone().text());
    const profile = await uploaded.json() as Profile;
    assert(profile.avatarUrl);
    assert.match(profile.avatarUrl, /^\/api\/profile\/avatar\?v=[a-z0-9-]+$/i);
    const image = await context.request(profile.avatarUrl);
    assert.equal(image.status, 200);
    assert.match(image.headers.get('content-type') ?? '', /^image\/webp/);
    assert.match(image.headers.get('cache-control') ?? '', /no-store/);
    assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
    const bytes = Buffer.from(await image.arrayBuffer());
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.width, 384); assert.equal(metadata.height, 384);
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.exif, undefined); assert.equal(metadata.orientation, undefined);
    assert.notDeepEqual(bytes, original, 'serve only normalized raster bytes, never the uploaded file');
    assert.equal((await context.request(profile.avatarUrl, {}, false)).status, 401);
    await context.restart();
    assert.deepEqual(await (await context.request('/api/profile')).json(), profile);
    assert.deepEqual(Buffer.from(await (await context.request(profile.avatarUrl)).arrayBuffer()), bytes);
    assert.deepEqual(context.runtime.db.connection.prepare('SELECT * FROM auth_users').all(), credentials, 'avatar changes never change login credentials');
  } finally { await context.close(); }
});

test('replacement uses a fresh image URL and restoring the default persists after restart', async () => {
  const context = await fixture();
  try {
    await context.authenticate();
    const first = await (await context.upload(await picture('#a12346'))).json() as Profile;
    const firstBytes = Buffer.from(await (await context.request(first.avatarUrl!)).arrayBuffer());
    const replacement = await context.upload(await picture('#269187'));
    assert.equal(replacement.status, 200);
    const second = await replacement.json() as Profile;
    assert(second.avatarUrl); assert.notEqual(second.avatarUrl, first.avatarUrl);
    assert.notDeepEqual(Buffer.from(await (await context.request(second.avatarUrl)).arrayBuffer()), firstBytes);
    assert.deepEqual(await (await context.request('/api/profile')).json(), second);
    const reset = await context.request('/api/profile/avatar', { method: 'DELETE' });
    assert.equal(reset.status, 200);
    assert.deepEqual(await reset.json(), { avatarUrl: null });
    assert.equal((await context.request(second.avatarUrl)).status, 404, 'the previous image cannot be fetched after reset');
    await context.restart();
    assert.deepEqual(await (await context.request('/api/profile')).json(), { avatarUrl: null });
    assert.equal((await context.request('/api/profile/avatar')).status, 404);
  } finally { await context.close(); }
});

test('invalid, missing, oversized, or excessive-pixel uploads preserve the previous avatar', async () => {
  const context = await fixture();
  try {
    await context.authenticate();
    const profile = await (await context.upload(await picture())).json() as Profile;
    assert(profile.avatarUrl);
    const prior = Buffer.from(await (await context.request(profile.avatarUrl)).arrayBuffer());
    const excessivelyLarge = await picture('#334455', 5001, 5000);
    const invalid: Array<{ name: string; bytes: Uint8Array; type?: string }> = [
      { name: 'renamed.png', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><script>alert(1)</script></svg>') },
      { name: 'broken.png', bytes: Buffer.from('not an image') },
      { name: 'too-large.jpg', bytes: Buffer.alloc(5 * 1024 * 1024 + 1), type: 'image/jpeg' },
      { name: 'too-many-pixels.png', bytes: excessivelyLarge },
    ];
    for (const input of invalid) {
      const response = await context.upload(input.bytes, input.name, input.type);
      assert([400, 413].includes(response.status), `${input.name}: ${response.status} ${await response.clone().text()}`);
      assert.deepEqual(await (await context.request('/api/profile')).json(), profile, `${input.name} must not clear an existing avatar`);
      assert.deepEqual(Buffer.from(await (await context.request(profile.avatarUrl)).arrayBuffer()), prior);
    }
    const missing = await context.request('/api/profile/avatar', { method: 'POST', body: new FormData() });
    assert.equal(missing.status, 400);
    assert.deepEqual(await (await context.request('/api/profile')).json(), profile);
    const wrongField = new FormData();
    wrongField.set('images', new Blob([new Uint8Array(await picture())], { type: 'image/png' }), 'wrong.png');
    const wrong = await context.request('/api/profile/avatar', { method: 'POST', body: wrongField });
    assert.equal(wrong.status, 400);
    assert.deepEqual(await (await context.request('/api/profile')).json(), profile);
  } finally { await context.close(); }
});

test('gallery backups exclude account avatars and leave the live profile intact', async () => {
  const context = await fixture();
  let snapshot: DatabaseSync | undefined;
  try {
    await context.authenticate();
    const profile = await (await context.upload(await picture('#235698'))).json() as Profile;
    const generated = await context.request('/api/backups', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format: 'zip' }),
    });
    assert.equal(generated.status, 201, await generated.clone().text());
    const exportInfo = await generated.json() as { downloadUrl: string };
    const download = await context.request(exportInfo.downloadUrl);
    assert.equal(download.status, 200);
    const archive = await JSZip.loadAsync(await download.arrayBuffer());
    const dbEntry = archive.file('data/gallery.db'); assert(dbEntry);
    const path = join(context.directory, 'export-check.db');
    await writeFile(path, await dbEntry.async('nodebuffer'));
    snapshot = new DatabaseSync(path, { readOnly: true });
    const tables = snapshot.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name);
    assert(!tables.includes('account_profile'));
    assert(!tables.includes('auth_users'));
    const manifest = archive.file('manifest.json'); assert(manifest);
    assert(!(await manifest.async('string')).includes(profile.avatarUrl!));
    assert.deepEqual(await (await context.request('/api/profile')).json(), profile);
    assert.equal((await context.request(profile.avatarUrl!)).status, 200);
  } finally { snapshot?.close(); await context.close(); }
});
