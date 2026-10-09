import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { Album } from '../shared/types.ts';
import { ApiError } from './db.ts';
import { createApp } from './index.ts';
import { authorizedFetch } from './test-auth.ts';
import { isPublicIp, resolvePublicImageUrl } from './remote-images.ts';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-remote-import-'));
  const pixel = await sharp({ create: { width: 36, height: 24, channels: 3, background: '#568073' } }).png().toBuffer();
  const calls: string[] = [];
  const runtime = await createApp({ dataDir: directory, downloadRemoteImage: async (url, stagingDir, { signal }) => {
    signal.throwIfAborted(); calls.push(url);
    if (url.includes('/unavailable')) throw new ApiError(400, '图片链接无法下载');
    const path = join(stagingDir, randomUUID());
    const bytes = url.includes('/webpage') ? Buffer.from('<html><body>This is not an image</body></html>') : pixel;
    await writeFile(path, bytes);
    return { path, originalname: '链接图片.png', size: bytes.length };
  } });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const fetch = await authorizedFetch(base);
  function form(remoteImages: string, localCount = 0, title = '网络图片收藏') {
    const body = new FormData();
    body.set('metadata', JSON.stringify({ title, category: '链接导入', tags: ['测试'], links: [], remoteImages }));
    for (let index = 0; index < localCount; index++) body.append('images', new Blob([new Uint8Array(pixel)], { type: 'image/png' }), `local-${index}.png`);
    return body;
  }
  return {
    directory, pixel, calls, runtime, base, form, fetch,
    async post(path: string, body: FormData) { return fetch(`${base}${path}`, { method: 'POST', body }); },
    async close() {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await runtime.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    },
  };
}

test('BBCode and plain URLs import as persistent local originals and thumbnails, including mixed local uploads', async () => {
  const context = await fixture();
  try {
    const response = await context.post('/api/albums', context.form('[IMG]https://images.example/one.png[/IMG]\nhttps://images.example/two.png\n[img]https://images.example/one.png[/img]', 1));
    assert.equal(response.status, 201, await response.clone().text());
    const album = await response.json() as Album;
    assert.equal(album.images.length, 3);
    assert.deepEqual(context.calls, ['https://images.example/one.png', 'https://images.example/two.png']);
    assert.equal(album.images[0].name, 'local-0.png');
    for (const image of album.images) {
      assert(image.url.startsWith('/uploads/'));
      assert(image.thumbnailUrl.startsWith('/uploads/'));
      assert.equal(image.width, 36); assert.equal(image.height, 24);
      const original = await context.fetch(`${context.base}${image.url}`);
      assert.equal(original.status, 200);
      assert.deepEqual(Buffer.from(await original.arrayBuffer()), context.pixel);
      const thumbnail = await context.fetch(`${context.base}${image.thumbnailUrl}`);
      assert.equal(thumbnail.status, 200);
      assert.equal(thumbnail.headers.get('content-type'), 'image/webp');
    }
    assert.deepEqual(context.runtime.db.requireAlbum(album.id).images, album.images);
    assert.deepEqual(await readdir(join(context.directory, '.incoming')), []);
  } finally { await context.close(); }
});

test('remote images append to an existing album without replacing its earlier images', async () => {
  const context = await fixture();
  try {
    const initial = await context.post('/api/albums', context.form('', 1));
    assert.equal(initial.status, 201);
    const old = await initial.json() as Album;
    old.localUpdatedAt = '2020-01-01T00:00:00.000Z'; context.runtime.db.save(old);
    const appended = await context.post(`/api/albums/${old.id}/images`, context.form('[url=https://site.example/page][img]https://images.example/new.png[/img][/url]', 0, '追加图片后的新标题'));
    assert.equal(appended.status, 200, await appended.clone().text());
    const album = await appended.json() as Album;
    assert.equal(album.images.length, 2);
    assert.deepEqual(album.images[0], old.images[0]);
    assert.notEqual(album.localUpdatedAt, old.localUpdatedAt);
    assert.equal(album.title, '追加图片后的新标题');
    assert.equal(context.calls.length, 1);
    assert.deepEqual(await readdir(join(context.directory, '.incoming')), []);
  } finally { await context.close(); }
});

test('failed downloads and non-images leave no new albums, originals or staging files', async () => {
  const context = await fixture();
  try {
    for (const failed of ['unavailable', 'webpage']) {
      const response = await context.post('/api/albums', context.form(`https://images.example/good.png\nhttps://images.example/${failed}`, 1));
      assert.equal(response.status, 400, await response.clone().text());
      assert.deepEqual(context.runtime.db.albums(), []);
      assert.deepEqual(await readdir(join(context.directory, 'uploads')), []);
      assert.deepEqual(await readdir(join(context.directory, '.incoming')), []);
    }
    const initial = await context.post('/api/albums', context.form('', 1));
    const album = await initial.json() as Album;
    const beforeFiles = (await readdir(join(context.directory, 'uploads'))).sort();
    const failedAppend = await context.post(`/api/albums/${album.id}/images`, context.form('https://images.example/good.png\nhttps://images.example/webpage', 1, '失败时不应保存此标题'));
    assert.equal(failedAppend.status, 400);
    assert.deepEqual(context.runtime.db.requireAlbum(album.id), album);
    assert.deepEqual((await readdir(join(context.directory, 'uploads'))).sort(), beforeFiles);
    assert.deepEqual(await readdir(join(context.directory, '.incoming')), []);
  } finally { await context.close(); }
});

test('validation rejects malformed inputs and aggregate limits before fetching any remote image', async () => {
  const context = await fixture();
  try {
    const tooMany = Array.from({ length: 99 }, (_, index) => `https://images.example/${index}.png`).join('\n');
    for (const body of [context.form(tooMany, 2), context.form('[img]file:///etc/passwd[/img]', 1), context.form('[img]https://images.example/broken.png', 1)]) {
      const response = await context.post('/api/albums', body);
      assert.equal(response.status, 400, await response.clone().text());
      assert.deepEqual(context.calls, []);
      assert.deepEqual(await readdir(join(context.directory, '.incoming')), []);
      assert.deepEqual(await readdir(join(context.directory, 'uploads')), []);
    }
    assert.equal((await context.post('/api/albums/nonexistent/images', context.form('https://images.example/one.png'))).status, 404);
    assert.deepEqual(context.calls, []);
    const initial = await context.post('/api/albums', context.form('', 1));
    const album = await initial.json() as Album;
    album.images = Array.from({ length: 1000 }, (_, index) => ({ ...album.images[0], id: `test-image-${index}` }));
    context.runtime.db.save(album);
    assert.equal((await context.post(`/api/albums/${album.id}/images`, context.form('https://images.example/one.png'))).status, 400);
    assert.deepEqual(context.calls, []);
    assert.equal(context.runtime.db.requireAlbum(album.id).images.length, 1000);
  } finally { await context.close(); }
});

test('remote URL resolution blocks internal addresses, credentials and unsafe protocols, and pins public DNS results', async () => {
  const privateAddresses = ['0.0.0.0', '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.2.3', '169.254.169.254', '100.64.0.1', '224.0.0.1', '::1', '::', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1'];
  for (const address of privateAddresses) assert.equal(isPublicIp(address), false, address);
  assert.equal(isPublicIp('8.8.8.8'), true);
  assert.equal(isPublicIp('2606:4700:4700::1111'), true);
  for (const url of ['file:///tmp/test.png', 'ftp://images.example/test.png', 'https://user:secret@images.example/test.png', 'http://127.0.0.1/a.png', 'http://2130706433/a.png', 'http://[::1]/a.png', 'http://[::ffff:7f00:1]/a.png', 'http://images.example:3210/a.png']) {
    await assert.rejects(resolvePublicImageUrl(url, async () => [{ address: '8.8.8.8', family: 4 }]));
  }
  await assert.rejects(resolvePublicImageUrl('https://images.example/a.png', async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]));
  const result = await resolvePublicImageUrl('https://images.example/a.png', async () => [{ address: '8.8.8.8', family: 4 }]);
  assert.equal(result.address, '8.8.8.8'); assert.equal(result.family, 4);
  assert.equal(result.url.hostname, 'images.example');
});
