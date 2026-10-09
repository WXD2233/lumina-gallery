import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { get } from 'node:http';
import type { Album } from '../shared/types.ts';
import { DAY_MS, GalleryDb, normalizeInput } from './db.ts';
import { SyncScheduler } from './scheduler.ts';
import { createApp } from './index.ts';
import { authorizedFetch } from './test-auth.ts';

function testAlbum(db: GalleryDb, remoteUpdatedAt: string | null = null): Album {
  const now = '2026-10-07T10:00:00.000Z';
  const input = normalizeInput({ title: '测试图集', tags: ['风景'], links: [{ url: 'https://pan.baidu.com/s/1testshare', syncEnabled: true }] }, undefined, now);
  input.links[0].remoteUpdatedAt = remoteUpdatedAt;
  return db.save({ ...input, id: randomUUID(), favorite: false, createdAt: now, localUpdatedAt: now, updatedAt: now, updateSource: 'local', images: [] });
}

test('daily sync uses remote file time, preserves it on failure, persists due time across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-sync-'));
  let db = new GalleryDb(directory);
  let clock = new Date('2026-10-07T10:00:00.000Z');
  let calls = 0;
  let shouldFail = false;
  const inspector = async () => { calls++; if (shouldFail) throw new Error('unexpected secret must not leak'); return { updatedAt: '2025-01-02T03:04:05Z', fileCount: 3, message: 'ok' }; };
  let scheduler = new SyncScheduler(db, inspector, () => clock);
  try {
    const album = testAlbum(db);
    assert.deepEqual(await scheduler.runDue(), { checked: 1, errors: 0 });
    const first = db.requireAlbum(album.id);
    assert.equal(first.updatedAt, '2025-01-02T03:04:05.000Z', 'first observed remote time may precede import');
    assert.equal(first.updateSource, 'baidu');
    assert.equal(first.links[0].nextCheckAt, '2026-10-08T10:00:00.000Z');
    assert.deepEqual(await scheduler.runDue(), { checked: 0, errors: 0 });
    await scheduler.stop(); db.close();
    db = new GalleryDb(directory);
    scheduler = new SyncScheduler(db, inspector, () => clock);
    assert.deepEqual(await scheduler.runDue(), { checked: 0, errors: 0 }, 'restart must not reset schedule');
    clock = new Date(clock.getTime() + DAY_MS); shouldFail = true;
    assert.deepEqual(await scheduler.runDue(), { checked: 1, errors: 1 });
    const failed = db.requireAlbum(album.id);
    assert.equal(failed.updatedAt, first.updatedAt);
    assert.equal(failed.links[0].remoteUpdatedAt, first.links[0].remoteUpdatedAt);
    assert.equal(failed.links[0].status, 'error');
    assert.equal(failed.links[0].lastCheckedAt, '2026-10-08T10:00:00.000Z');
    assert(!JSON.stringify(db.logs()).includes('secret'));
    shouldFail = false;
    const manual = await scheduler.syncAlbum(album.id);
    assert.equal(manual.checked, 1);
    assert.equal(db.logs()[0].changed, false);
    assert.equal(calls, 3);
  } finally { await scheduler.stop(); db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('parallel due checks are serialized and the newest enabled remote link determines album time', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-lock-'));
  const db = new GalleryDb(directory);
  let release!: () => void;
  let started!: () => void;
  let calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const scheduler = new SyncScheduler(db, async () => { calls++; started(); await gate; return { updatedAt: '2026-01-01T00:00:00Z', fileCount: 1, message: 'ok' }; });
  try {
    const album = testAlbum(db);
    const jobs = [scheduler.runDue(), scheduler.runDue()];
    await ready; release(); await Promise.all(jobs);
    assert.equal(calls, 1);
    const selected = db.requireAlbum(album.id);
    selected.links.push({ ...selected.links[0], id: randomUUID(), url: 'https://pan.baidu.com/s/1secondshare', remoteUpdatedAt: '2026-09-01T00:00:00.000Z' });
    db.save(selected);
    assert.equal(db.requireAlbum(album.id).updatedAt, '2026-09-01T00:00:00.000Z', 'newest enabled remote link wins');
    selected.links.forEach(link => { link.syncEnabled = false; });
    db.save(selected);
    assert.equal(db.requireAlbum(album.id).updatedAt, selected.localUpdatedAt);
    assert.equal(db.requireAlbum(album.id).updateSource, 'local');
  } finally { release(); await scheduler.stop(); db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('an in-flight inspection cannot resurrect a removed album', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-race-'));
  const db = new GalleryDb(directory);
  let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const scheduler = new SyncScheduler(db, async () => { started(); await gate; return { updatedAt: '2026-01-01T00:00:00Z', fileCount: 1, message: 'ok' }; });
  try {
    const album = testAlbum(db); const task = scheduler.runDue(); await ready; db.remove(album.id); release(); await task;
    assert.equal(db.album(album.id), undefined); assert.equal(db.logs().length, 0);
  } finally { release(); await scheduler.stop(); db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('API imports real images, persists edits, rejects hostile requests and cleans failed batches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-api-'));
  const runtime = await createApp({ dataDir: directory, inspector: async () => ({ updatedAt: '2026-09-02T09:30:00Z', fileCount: 1, message: 'ok' }) });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const fetch = await authorizedFetch(base);
  const pixel = await sharp({ create: { width: 24, height: 40, channels: 3, background: '#405045' } }).png().toBuffer();
  const meta = { title: '山间来信', description: '测试简介', category: '自然', tags: ['山'], links: [{ label: '百度网盘', url: 'https://pan.baidu.com/s/1validshare', code: 'abcd', syncEnabled: true, status: 'success', lastCheckedAt: '2030-01-01T00:00:00.000Z', remoteUpdatedAt: '2030-01-01T00:00:00.000Z' }] };
  const multipart = (invalid = false) => {
    const body = new FormData(); body.set('metadata', JSON.stringify(meta)); body.append('images', new Blob([new Uint8Array(pixel)], { type: 'image/png' }), '山间图片.png');
    if (invalid) body.append('images', new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'], { type: 'image/svg+xml' }), 'unsafe.svg');
    return body;
  };
  try {
    const hostile = await fetch(`${base}/api/settings`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{"autoSync":false}' });
    assert.equal(hostile.status, 403);
    const hostileHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(`${base}/api/health`, { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(hostileHostStatus, 403);
    const broken = await fetch(`${base}/api/albums`, { method: 'POST', body: multipart(true) });
    assert.equal(broken.status, 400);
    assert.deepEqual(await readdir(join(directory, 'uploads')), []);
    assert.deepEqual(await readdir(join(directory, '.incoming')), []);
    const created = await fetch(`${base}/api/albums`, { method: 'POST', body: multipart() });
    assert.equal(created.status, 201);
    let album = await created.json() as Album;
    assert.equal(album.images.length, 1); assert.equal(album.images[0].width, 24); assert.equal(album.images[0].height, 40); assert.equal(album.images[0].name, '山间图片.png');
    // Pin the local time in the past so equality cannot pass by millisecond coincidence.
    album.localUpdatedAt = '2020-01-01T00:00:00.000Z'; runtime.db.save(album);
    const favoriteOnly = await fetch(`${base}/api/albums/${album.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ favorite: true }) });
    album = await favoriteOnly.json() as Album;
    assert.equal(album.favorite, true); assert.equal(album.localUpdatedAt, '2020-01-01T00:00:00.000Z'); assert.equal(album.updatedAt, album.localUpdatedAt);
    const noOp = await fetch(`${base}/api/albums/${album.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...meta, favorite: true, links: album.links }) });
    album = await noOp.json() as Album;
    assert.equal(album.localUpdatedAt, '2020-01-01T00:00:00.000Z', 'saving unchanged content preserves update time');
    assert.equal(album.links[0].status, 'pending'); assert.equal(album.links[0].lastCheckedAt, null); assert.equal(album.links[0].remoteUpdatedAt, null);
    const contentEdit = await fetch(`${base}/api/albums/${album.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: '更新了图集简介' }) });
    album = await contentEdit.json() as Album;
    assert.notEqual(album.localUpdatedAt, '2020-01-01T00:00:00.000Z', 'content changes advance local update time');
    const original = await fetch(`${base}${album.images[0].url}`); assert.equal(original.status, 200); assert.equal(original.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${base}${album.images[0].thumbnailUrl}`)).status, 200);
    const settings = await fetch(`${base}/api/settings`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baiduCookie: 'BDUSS=private-value', autoSync: false }) });
    const settingsText = await settings.text(); assert(settingsText.includes('"hasBaiduCookie":true')); assert(!settingsText.includes('private-value'));
    const synced = await fetch(`${base}/api/albums/${album.id}/sync`, { method: 'POST' });
    const result = await synced.json() as { album: Album; checked: number };
    assert.equal(result.checked, 1); assert.equal(result.album.updatedAt, '2026-09-02T09:30:00.000Z');
    const edited = await fetch(`${base}/api/albums/${album.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '新的标题', favorite: true }) });
    album = await edited.json() as Album; assert.equal(album.title, '新的标题'); assert.equal(album.favorite, true); assert.equal(album.updatedAt, result.album.updatedAt);
    assert.equal((await fetch(`${base}/api/albums/${album.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ links: [{ url: 'javascript:alert(1)' }] }) })).status, 400);
    const deleted = await fetch(`${base}/api/albums/${album.id}`, { method: 'DELETE' }); assert.equal(deleted.status, 200);
    assert.deepEqual(await readdir(join(directory, 'uploads')), []);
    assert.equal((await fetch(`${base}/api/albums/${album.id}`)).status, 404);
    assert.equal((await fetch(`${base}/api/logs`)).status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await runtime.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent imports cannot exceed album limit and rejected prepared files are removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-limit-'));
  const runtime = await createApp({ dataDir: directory });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const fetch = await authorizedFetch(base);
  const pixel = await sharp({ create: { width: 1800, height: 2400, channels: 3, background: '#334455' } }).png().toBuffer();
  try {
    const album = testAlbum(runtime.db);
    album.images = Array.from({ length: 999 }, (_, index) => ({ id: `existing-${index}`, url: `/uploads/existing-${index}.png`, thumbnailUrl: `/uploads/existing-${index}.webp`, name: 'existing.png', width: 1, height: 1, size: 1 }));
    runtime.db.save(album);
    const importOne = async () => {
      const body = new FormData(); body.append('images', new Blob([new Uint8Array(pixel)], { type: 'image/png' }), 'new.png');
      const response = await fetch(`${base}/api/albums/${album.id}/images`, { method: 'POST', body });
      await response.text(); return response.status;
    };
    const statuses = await Promise.all([importOne(), importOne()]);
    assert.deepEqual(statuses.sort(), [200, 400]);
    assert.equal(runtime.db.requireAlbum(album.id).images.length, 1000);
    assert.equal((await readdir(join(directory, 'uploads'))).length, 2, 'only the accepted original and thumbnail remain');
    assert.deepEqual(await readdir(join(directory, '.incoming')), []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await runtime.close(); await rm(directory, { recursive: true, force: true });
  }
});
