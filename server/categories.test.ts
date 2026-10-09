import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { Album } from '../shared/types.ts';
import { GalleryDb, normalizeInput } from './db.ts';
import { createApp } from './index.ts';
import { authorizedFetch } from './test-auth.ts';
import { SyncScheduler } from './scheduler.ts';

function sampleAlbum(category: string): Album {
  const time = '2020-04-05T06:07:08.000Z';
  return {
    id: randomUUID(), ...normalizeInput({ title: '分类测试', category, tags: ['保留'], links: [{ url: 'https://pan.baidu.com/s/1test', code: 'abcd', syncEnabled: true }] }, undefined, time),
    favorite: true, createdAt: time, updatedAt: time, localUpdatedAt: time, updateSource: 'local', images: [],
  };
}

test('legacy database migration preserves custom categories and persists empty categories and removed defaults', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-category-migration-'));
  const legacy = new DatabaseSync(join(directory, 'gallery.db'));
  const album = sampleAlbum('我的旅行');
  legacy.exec('CREATE TABLE albums (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
  legacy.prepare('INSERT INTO albums(id, body) VALUES(?, ?)').run(album.id, JSON.stringify(album));
  legacy.close();
  let db = new GalleryDb(directory);
  try {
    assert.deepEqual(db.categories(), ['自然风光', '城市漫游', '人像摄影', '灵感收藏', '未分类', '我的旅行']);
    assert.deepEqual(db.requireAlbum(album.id), album, 'migration does not rewrite an album');
    db.createCategory('  待整理  ');
    db.deleteCategory('城市漫游');
    db.deleteCategory('我的旅行');
    const expected = db.categories();
    db.close(); db = new GalleryDb(directory);
    assert.deepEqual(db.categories(), expected);
    assert(db.categories().includes('待整理'), 'an empty category survives restart');
    assert(!db.categories().includes('城市漫游'), 'deleted default categories stay deleted');
    assert.deepEqual(db.requireAlbum(album.id), { ...album, category: '未分类' });
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('global rename and delete preserve all album data, and a failed bulk change rolls back atomically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-category-atomic-'));
  const db = new GalleryDb(directory);
  try {
    const first = db.save(sampleAlbum('私人分类'));
    const second = db.save({ ...sampleAlbum('私人分类'), favorite: false });
    const unrelated = db.save(sampleAlbum('其他分类'));
    db.connection.exec(`CREATE TRIGGER reject_second_category_update BEFORE UPDATE ON albums
      WHEN OLD.id = '${second.id}' BEGIN SELECT RAISE(ABORT, 'test rollback'); END;`);
    assert.throws(() => db.renameCategory('私人分类', '新的名称'), /test rollback/);
    assert(db.categories().includes('私人分类'));
    assert(!db.categories().includes('新的名称'));
    assert.deepEqual(db.requireAlbum(first.id), first);
    assert.deepEqual(db.requireAlbum(second.id), second);
    assert.throws(() => db.deleteCategory('私人分类'), /test rollback/);
    assert(db.categories().includes('私人分类'));
    assert.deepEqual(db.requireAlbum(first.id), first);
    db.connection.exec('DROP TRIGGER reject_second_category_update');
    const result = db.renameCategory('私人分类', '新的名称');
    assert(!result.categories.includes('私人分类'));
    for (const original of [first, second]) assert.deepEqual(db.requireAlbum(original.id), { ...original, category: '新的名称' });
    db.deleteCategory('新的名称');
    for (const original of [first, second]) assert.deepEqual(db.requireAlbum(original.id), { ...original, category: '未分类' });
    assert.deepEqual(db.requireAlbum(unrelated.id), unrelated);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('category API validates names and safely renames/deletes a category containing uploaded pictures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-category-api-'));
  const runtime = await createApp({ dataDir: directory });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const fetch = await authorizedFetch(base);
  const request = (path: string, method: string, body?: unknown) => fetch(`${base}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    const initial = await (await request('/categories', 'GET')).json() as string[];
    assert(initial.includes('未分类'));
    for (const name of ['', '   ', '无效\n名称', '\t名称', '名\u0000称', '名'.repeat(81), null, 123]) {
      assert.equal((await request('/categories', 'POST', { name })).status, 400);
    }
    assert.equal((await request('/categories', 'POST', {})).status, 400);
    assert.equal((await request('/categories', 'POST', { name: '  自定义 / 摄影  ' })).status, 201);
    assert.equal((await request('/categories', 'POST', { name: '自定义 / 摄影' })).status, 409);
    assert.equal((await request(`/categories/${encodeURIComponent('未分类')}`, 'PATCH', { name: '覆盖' })).status, 400);
    assert.equal((await request(`/categories/${encodeURIComponent('未分类')}`, 'DELETE')).status, 400);
    assert.equal((await request(`/categories/${encodeURIComponent('自定义 / 摄影')}`, 'PATCH', { name: '自然风光' })).status, 409);
    assert.equal((await request(`/categories/${encodeURIComponent('自定义 / 摄影')}`, 'PATCH', { name: '坏\r名称' })).status, 400);
    assert.equal((await request('/categories/missing', 'DELETE')).status, 404);
    const pixel = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#445566' } }).png().toBuffer();
    const body = new FormData();
    body.set('metadata', JSON.stringify({ title: '保留原图和时间', category: '直接输入的新分类', links: [{ label: '百度网盘', url: 'https://pan.baidu.com/s/1test', code: 'abcd', syncEnabled: true }] }));
    body.append('images', new Blob([new Uint8Array(pixel)], { type: 'image/png' }), 'test.png');
    const created = await fetch(`${base}/api/albums`, { method: 'POST', body });
    assert.equal(created.status, 201);
    let album = await created.json() as Album;
    assert(runtime.db.categories().includes('直接输入的新分类'), 'free text on import creates a category');
    const edited = await request(`/albums/${album.id}`, 'PATCH', { category: '自定义 / 摄影' });
    assert.equal(edited.status, 200);
    album = await edited.json() as Album;
    album.localUpdatedAt = '2020-01-01T00:00:00.000Z';
    album.links[0].remoteUpdatedAt = '2024-02-03T04:05:06.000Z';
    runtime.db.save(album);
    const original = runtime.db.requireAlbum(album.id);
    const originalFiles = await readdir(join(directory, 'uploads'));
    const renamed = await request(`/categories/${encodeURIComponent('自定义 / 摄影')}`, 'PATCH', { name: '更新后的分类' });
    assert.equal(renamed.status, 200);
    const result = await renamed.json() as { categories: string[]; albums: Album[] };
    assert(result.categories.includes('更新后的分类'));
    assert.deepEqual(result.albums.find(item => item.id === album.id), { ...original, category: '更新后的分类' });
    const deleted = await request(`/categories/${encodeURIComponent('更新后的分类')}`, 'DELETE');
    assert.equal(deleted.status, 200);
    assert.deepEqual(runtime.db.requireAlbum(album.id), { ...original, category: '未分类' });
    assert.deepEqual(await readdir(join(directory, 'uploads')), originalFiles, 'deleting a category keeps original and thumbnail files');
    for (const path of [original.images[0].url, original.images[0].thumbnailUrl]) assert.equal((await fetch(`${base}${path}`)).status, 200);
    const recategorized = await request(`/albums/${album.id}`, 'PATCH', { category: '编辑时新建' });
    assert.equal(recategorized.status, 200);
    assert(runtime.db.categories().includes('编辑时新建'));
    assert.equal((await request(`/albums/${album.id}`, 'PATCH', { category: '坏\n名称' })).status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await runtime.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('an in-flight cloud check keeps category edits and does not resurrect a deleted category', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-category-sync-'));
  const db = new GalleryDb(directory);
  let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const scheduler = new SyncScheduler(db, async () => { started(); await gate; return { updatedAt: '2024-01-01T00:00:00.000Z', fileCount: 1, message: 'ok' }; });
  try {
    const album = db.save(sampleAlbum('待删除分类'));
    const pending = scheduler.syncAlbum(album.id);
    await ready;
    db.renameCategory('待删除分类', '重命名后的分类');
    db.deleteCategory('重命名后的分类');
    release();
    const result = await pending;
    assert.equal(result.album.category, '未分类');
    assert.equal(result.album.updatedAt, '2024-01-01T00:00:00.000Z');
    assert(!db.categories().includes('待删除分类'));
    assert(!db.categories().includes('重命名后的分类'));
  } finally { release(); await scheduler.stop(); db.close(); await rm(directory, { recursive: true, force: true }); }
});
