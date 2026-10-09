import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import JSZip from 'jszip';
import sharp from 'sharp';
import { createApp } from './index.ts';
import { authorizedFetch } from './test-auth.ts';
import type { Album } from '../shared/types.ts';
import type { BackupImportPreview, BackupImportResult } from '../shared/backup-import.ts';
import { parseZipImport } from './backup-import.ts';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-import-test-'));
  const runtime = await createApp({ dataDir: directory });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const fetch = await authorizedFetch(base);
  const request = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return {
    runtime, directory, base, request, fetch, server,
    async album(title = '归来时的风景', category = '拍摄/旅行') {
      const bytes = await sharp({ create: { width: 48, height: 32, channels: 3, background: '#887e98' } }).png().toBuffer();
      const body = new FormData();
      body.set('metadata', JSON.stringify({ title, category, description: '保留这段简介', tags: ['旅行'], favorite: true, links: [{ label: '百度网盘', url: 'https://pan.baidu.com/s/1backup', code: '0012', password: '00007', syncEnabled: true }] }));
      body.append('images', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), '原始图片.png');
      body.append('images', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), '第二张.png');
      const response = await fetch(`${base}/api/albums`, { method: 'POST', body });
      assert.equal(response.status, 201, await response.clone().text());
      const album = await response.json() as Album;
      album.createdAt = '2026-10-01T02:00:00.000Z';
      album.localUpdatedAt = '2026-10-02T02:00:00.000Z';
      Object.assign(album.links[0], { status: 'success', remoteUpdatedAt: '2026-10-03T04:05:06.000Z', lastCheckedAt: '2026-10-04T04:05:06.000Z', nextCheckAt: '2026-10-05T04:05:06.000Z', message: '已同步' });
      runtime.db.save(album);
      return runtime.db.requireAlbum(album.id);
    },
    async backup(format: 'zip' | 'xlsx') {
      const response = await request('/api/backups', { format });
      assert.equal(response.status, 201, await response.clone().text());
      const metadata = await response.json() as { downloadUrl: string };
      const download = await fetch(base + metadata.downloadUrl); assert.equal(download.status, 200);
      return Buffer.from(await download.arrayBuffer());
    },
    async upload(bytes: Buffer, name = '图库备份.zip') {
      const body = new FormData(); body.append('file', new Blob([new Uint8Array(bytes)]), name);
      return fetch(`${base}/api/backup-imports`, { method: 'POST', body });
    },
    async preview(bytes: Buffer, name?: string) {
      const response = await this.upload(bytes, name);
      assert.equal(response.status, 201, await response.clone().text());
      return response.json() as Promise<BackupImportPreview>;
    },
    async commit(preview: BackupImportPreview, keys = preview.albums.map(album => album.key), duplicateMode = 'skip') {
      const response = await request(`/api/backup-imports/${preview.id}/commit`, { albumKeys: keys, duplicateMode });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json() as Promise<BackupImportResult>;
    },
    async close() {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await runtime.close();
      assert(resolve(directory).startsWith(resolve(tmpdir()) + sep));
      assert(basename(directory).startsWith('lumina-import-test-'));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('ZIP preview is read-only; selected import preserves originals, times, links and current settings', async () => {
  const source = await fixture(), target = await fixture();
  try {
    const first = await source.album();
    const excluded = await source.album('不选中的图集', '另一个分类');
    source.runtime.db.createCategory('空分类');
    source.runtime.db.updateSettings({ autoSync: true, baiduCookie: 'BDUSS=source-private' });
    const existing = await target.album('现有内容', '我的分类');
    target.runtime.db.updateSettings({ autoSync: false, baiduCookie: 'BDUSS=keep-target-cookie' });
    const before = target.runtime.db.albums(), filesBefore = await readdir(join(target.directory, 'uploads'));
    const preview = await target.preview(await source.backup('zip'));
    assert.equal(preview.filename, '图库备份.zip');
    assert.equal(preview.albums.length, 2);
    assert.deepEqual(target.runtime.db.albums(), before);
    assert.deepEqual(await readdir(join(target.directory, 'uploads')), filesBefore);
    const result = await target.commit(preview, [first.id]);
    assert.equal(result.imported, 1); assert.equal(result.imageCount, 2);
    assert.deepEqual(target.runtime.db.requireAlbum(existing.id), existing);
    assert(!target.runtime.db.album(excluded.id));
    const restored = target.runtime.db.requireAlbum(first.id);
    for (const key of ['title', 'description', 'category', 'tags', 'favorite', 'createdAt', 'updatedAt', 'localUpdatedAt', 'updateSource', 'links'] as const) assert.deepEqual(restored[key], first[key], key);
    for (let index = 0; index < first.images.length; index++) {
      assert.notEqual(restored.images[index].url, first.images[index].url);
      const actual = await readFile(join(target.directory, 'uploads', basename(restored.images[index].url)));
      const original = await readFile(join(source.directory, 'uploads', basename(first.images[index].url)));
      assert.deepEqual(actual, original);
      assert.equal(restored.images[index].name, first.images[index].name);
      assert((await sharp(await readFile(join(target.directory, 'uploads', basename(restored.images[index].thumbnailUrl)))).metadata()).width);
    }
    assert(target.runtime.db.categories().includes('空分类'));
    assert(!target.runtime.db.categories().includes('另一个分类'));
    assert.equal(target.runtime.db.settings().autoSync, false);
    assert.equal(target.runtime.db.value('baiduCookie'), 'BDUSS=keep-target-cookie');
    assert.deepEqual(await target.commit(preview, [first.id]), result, 'retry returns the original result');
    assert.equal(target.runtime.db.albums().length, 2);
  } finally { await source.close(); await target.close(); }
});

test('duplicate import skips existing IDs or creates an independent copy without overwriting', async () => {
  const context = await fixture();
  try {
    const original = await context.album(); const bytes = await context.backup('zip');
    const beforeFiles = await readdir(join(context.directory, 'uploads'));
    const preview = await context.preview(bytes);
    assert(preview.albums[0].exists);
    assert.equal((await context.commit(preview)).skipped, 1);
    assert.deepEqual(context.runtime.db.requireAlbum(original.id), original);
    assert.deepEqual(await readdir(join(context.directory, 'uploads')), beforeFiles);
    const copyPreview = await context.preview(bytes);
    const result = await context.commit(copyPreview, [original.id], 'copy');
    assert.equal(result.imported, 1);
    const copy = context.runtime.db.albums().find(album => album.id !== original.id)!;
    assert(copy); assert.notEqual(copy.images[0].url, original.images[0].url);
    assert.notEqual(copy.images[0].id, original.images[0].id);
    assert.notEqual(copy.links[0].id, original.links[0].id);
    assert.equal(copy.updatedAt, original.updatedAt);
    assert.deepEqual(await context.commit(copyPreview, [original.id], 'copy'), result);
    assert.equal(context.runtime.db.albums().length, 2);
  } finally { await context.close(); }
});

test('ZIP export and import preserve distinct link validity outcomes and their independent check times', async () => {
  const source = await fixture(), target = await fixture();
  try {
    const original = await source.album();
    const statuses = ['unchecked', 'valid', 'invalid', 'code_required', 'code_error', 'login_required', 'verification_required', 'network_error', 'unknown', 'unsupported'] as const;
    const template = original.links[0];
    original.links = statuses.map((status, index) => ({
      ...template, id: `health-link-${index}`, label: `检查状态 ${status}`,
      health: { status, message: `有效性说明 ${status}`, checkedAt: status === 'unchecked' ? null : '2026-10-07T03:04:05.000Z', nextCheckAt: status === 'unsupported' ? null : '2026-10-08T03:04:05.000Z' },
    }));
    source.runtime.db.save(original);
    const bytes = await source.backup('zip');
    const zip = await JSZip.loadAsync(bytes);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as { albums: Album[] };
    assert.deepEqual(manifest.albums[0].links, original.links);
    const preview = await target.preview(bytes);
    assert.equal((await target.commit(preview)).imported, 1);
    const restored = target.runtime.db.requireAlbum(original.id);
    assert.deepEqual(restored.links, original.links);
    assert.equal(restored.updatedAt, original.updatedAt, 'validity results do not replace the content update time');
    assert.equal(restored.links[1].lastCheckedAt, template.lastCheckedAt, 'time-sync and validity schedules stay distinct');
  } finally { await source.close(); await target.close(); }
});

test('ZIP backups made before link validity checks still import as unchecked', async () => {
  const source = await fixture(), target = await fixture();
  try {
    const original = await source.album();
    const zip = await JSZip.loadAsync(await source.backup('zip'));
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as { albums: Album[] };
    for (const album of manifest.albums) for (const link of album.links) delete link.health;
    zip.file('manifest.json', JSON.stringify(manifest));
    const preview = await target.preview(await zip.generateAsync({ type: 'nodebuffer' }));
    assert.equal((await target.commit(preview)).imported, 1);
    const restored = target.runtime.db.requireAlbum(original.id);
    assert.equal(restored.links[0].health?.status ?? 'unchecked', 'unchecked');
    assert.equal(restored.links[0].remoteUpdatedAt, original.links[0].remoteUpdatedAt);
    assert.equal(restored.updatedAt, original.updatedAt);
  } finally { await source.close(); await target.close(); }
});

test('malformed ZIP validity states and check dates fail without changing the gallery', async () => {
  const context = await fixture();
  try {
    await context.album();
    const bytes = await context.backup('zip');
    const before = context.runtime.db.albums(), files = await readdir(join(context.directory, 'uploads'));
    const valid = { status: 'valid', message: '分享可访问', checkedAt: '2026-10-07T03:04:05.000Z', nextCheckAt: '2026-10-08T03:04:05.000Z' };
    const malformed = [null, { ...valid, status: 'expired' }, { ...valid, message: { text: 'unexpected' } }, { ...valid, checkedAt: '2026-02-30T03:04:05.000Z' }, { ...valid, nextCheckAt: 'tomorrow' }, { ...valid, checkedAt: 1 }];
    for (const health of malformed) {
      const zip = await JSZip.loadAsync(bytes);
      const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
      manifest.albums[0].links[0].health = health;
      zip.file('manifest.json', JSON.stringify(manifest));
      const response = await context.upload(await zip.generateAsync({ type: 'nodebuffer' }));
      assert.equal(response.status, 400, await response.clone().text());
      assert.match((await response.json() as { error: string }).error, /链接有效性/);
      assert.deepEqual(context.runtime.db.albums(), before);
      assert.deepEqual(await readdir(join(context.directory, 'uploads')), files);
    }
    assert.deepEqual(await readdir(join(context.directory, '.imports')), []);
  } finally { await context.close(); }
});

test('Excel export imports categories, one embedded cover and literal codes without enabling sync', async () => {
  const source = await fixture(), target = await fixture();
  try {
    const original = await source.album(); const bytes = await source.backup('xlsx');
    const preview = await target.preview(bytes, '表格备份.xlsx');
    assert.equal(preview.format, 'xlsx'); assert.equal(preview.albums.length, 1);
    assert.equal(preview.albums[0].imageCount, 1);
    assert(preview.warnings.length > 0);
    assert.equal((await target.commit(preview)).imported, 1);
    const album = target.runtime.db.albums()[0];
    assert.equal(album.title, original.title); assert.equal(album.category, original.category);
    assert.equal(album.updatedAt, original.updatedAt);
    assert.equal(album.links[0].url, original.links[0].url);
    assert.equal(album.links[0].code, '0012'); assert.equal(album.links[0].password, '00007');
    assert.equal(album.links[0].syncEnabled, false); assert.equal(album.images.length, 1);
    const repeated = await target.preview(bytes, '表格备份.xlsx');
    assert.equal(repeated.albums[0].exists, true);
    assert.equal((await target.commit(repeated)).skipped, 1);
  } finally { await source.close(); await target.close(); }
});

test('cancelled previews cannot import, and empty backups restore category structure', async () => {
  const source = await fixture(), target = await fixture();
  try {
    source.runtime.db.createCategory('空的自定义分类');
    const bytes = await source.backup('zip');
    const preview = await target.preview(bytes);
    assert.equal(preview.albums.length, 0);
    const cancelled = await target.fetch(`${target.base}/api/backup-imports/${preview.id}`, { method: 'DELETE' }); assert.equal(cancelled.status, 200);
    const stale = await target.request(`/api/backup-imports/${preview.id}/commit`, { albumKeys: [], duplicateMode: 'skip' }); assert.equal(stale.status, 404);
    assert(!target.runtime.db.categories().includes('空的自定义分类'));
    const newPreview = await target.preview(bytes);
    assert.equal((await target.commit(newPreview)).imported, 0);
    assert(target.runtime.db.categories().includes('空的自定义分类'));
  } finally { await source.close(); await target.close(); }
});

test('damaged, traversing or incomplete backups leave the gallery and original files untouched', async () => {
  const context = await fixture();
  try {
    const album = await context.album(); const bytes = await context.backup('zip');
    const before = context.runtime.db.albums(), files = await readdir(join(context.directory, 'uploads'));
    const missing = await JSZip.loadAsync(bytes); missing.remove(`data/uploads/${basename(album.images[0].url)}`);
    const traversal = new JSZip(); traversal.file('../outside.txt', 'must not extract');
    const invalidImage = await JSZip.loadAsync(bytes); invalidImage.file(`data/uploads/${basename(album.images[0].url)}`, 'not an image');
    for (const bad of [Buffer.from('invalid ZIP'), await missing.generateAsync({ type: 'nodebuffer' }), await traversal.generateAsync({ type: 'nodebuffer' }), await invalidImage.generateAsync({ type: 'nodebuffer' })]) {
      const response = await context.upload(bad); assert.equal(response.status, 400, await response.clone().text());
      assert.deepEqual(context.runtime.db.albums(), before);
      assert.deepEqual(await readdir(join(context.directory, 'uploads')), files);
    }
    assert.deepEqual(await readdir(join(context.directory, '.imports')), []);
  } finally { await context.close(); }
});

test('failed database writes roll back imported categories, albums and copied images', async () => {
  const source = await fixture(), target = await fixture();
  try {
    await source.album(); const preview = await target.preview(await source.backup('zip'));
    const categoriesBefore = target.runtime.db.categories();
    target.runtime.db.connection.exec("CREATE TRIGGER reject_import BEFORE INSERT ON albums BEGIN SELECT RAISE(ABORT, 'test rollback'); END");
    const response = await target.request(`/api/backup-imports/${preview.id}/commit`, { albumKeys: preview.albums.map(album => album.key), duplicateMode: 'skip' });
    assert.equal(response.status, 500);
    assert.equal(target.runtime.db.albums().length, 0);
    assert.deepEqual(target.runtime.db.categories(), categoriesBefore);
    assert.deepEqual(await readdir(join(target.directory, 'uploads')), []);
    target.runtime.db.connection.exec('DROP TRIGGER reject_import');
    assert.equal((await target.commit(preview)).imported, 1, 'preview remains retryable after rollback');
  } finally { await source.close(); await target.close(); }
});

test('completed imports release staged files and retain only a bounded retry-result history', async () => {
  const context = await fixture();
  try {
    const bytes = await context.backup('zip');
    let first: BackupImportPreview | undefined, latest: BackupImportPreview | undefined;
    for (let index = 0; index < 66; index++) {
      latest = await context.preview(bytes);
      first ??= latest;
      await context.commit(latest);
      assert.deepEqual(await readdir(join(context.directory, '.imports')), []);
    }
    assert.equal((await context.request(`/api/backup-imports/${first!.id}/commit`, { albumKeys: [], duplicateMode: 'skip' })).status, 404);
    assert.equal((await context.commit(latest!)).imported, 0, 'recent retry stays idempotent');
  } finally { await context.close(); }
});

test('repeated ZIP image references count every staged copy toward the size limit', async () => {
  const context = await fixture();
  try {
    const album = await context.album();
    const archive = await JSZip.loadAsync(await context.backup('zip'));
    const manifest = JSON.parse(await archive.file('manifest.json')!.async('string')) as { albums: Album[] };
    manifest.albums[0].images[1].url = album.images[0].url;
    archive.file('manifest.json', JSON.stringify(manifest));
    const path = join(context.directory, 'repeated.zip'), stage = join(context.directory, 'repeated-stage');
    await mkdir(stage); await writeFile(path, await archive.generateAsync({ type: 'nodebuffer' }));
    await assert.rejects(parseZipImport(path, stage, Math.floor(album.images[0].size * 1.5)), /实际展开大小/);
    assert.deepEqual(await readdir(stage), [], 'quota is checked before any extraction');
  } finally { await context.close(); }
});

test('restart immediately cleans owned abandoned import previews without touching unrelated files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-import-recovery-'));
  const root = join(directory, '.imports');
  const abandoned = join(root, 'import-00000000-0000-4000-8000-000000000000');
  const unrelated = join(root, 'import-11111111-1111-4111-8111-111111111111');
  await mkdir(abandoned, { recursive: true }); await mkdir(unrelated);
  await writeFile(join(abandoned, '.lumina-import.json'), JSON.stringify({ format: 'lumina-gallery-import-temp', createdAt: Date.now() }));
  await writeFile(join(abandoned, 'staged.png'), 'interrupted import');
  await writeFile(join(unrelated, 'keep.txt'), 'keep');
  const runtime = await createApp({ dataDir: directory });
  try { assert.deepEqual(await readdir(root), [basename(unrelated)]); }
  finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test('disconnects before multipart setup and during empty multipart parsing release the import operation', { timeout: 15_000 }, async () => {
  const context = await fixture();
  try {
    const bytes = await context.backup('zip');
    const login = await globalThis.fetch(`${context.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'test-admin', password: 'test-password-123' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().find(value => value.startsWith('lumina_session='))!.split(';')[0];
    await login.arrayBuffer();
    for (const beforeParser of [true, false]) {
      let received!: IncomingMessage;
      const incoming = new Promise<void>(resolve => context.server.once('request', req => { received = req; if (beforeParser) req.destroy(); resolve(); }));
      const request = httpRequest(`${context.base}/api/backup-imports`, { method: 'POST', headers: {
        Cookie: cookie, 'Content-Type': 'multipart/form-data; boundary=interrupted-backup', 'Content-Length': '500',
      } });
      request.on('error', () => undefined);
      request.flushHeaders();
      await incoming;
      if (!beforeParser) {
        // Wait for multer's pipe to attach, but never provide a file part.
        for (let attempt = 0; received.listenerCount('data') === 0 && attempt < 100; attempt++) await delay(10);
        assert(received.listenerCount('data') > 0, 'multipart parser has started');
        request.write('--interrupted-backup\r\n');
      }
      request.destroy();
      let response: Response | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        response = await context.upload(bytes);
        if (response.status !== 409) break;
        await response.arrayBuffer(); await delay(10);
      }
      assert.equal(response?.status, 201, 'the next import is accepted after cancellation');
      const preview = await response!.json() as BackupImportPreview;
      await context.fetch(`${context.base}/api/backup-imports/${preview.id}`, { method: 'DELETE' });
      assert.deepEqual(await readdir(join(context.directory, '.imports')), []);
    }
  } finally { await context.close(); }
});
