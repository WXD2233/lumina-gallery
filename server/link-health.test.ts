import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Album, CloudLink, LinkCheckResult } from '../shared/types.ts';
import { BaiduShareError } from './baidu.ts';
import { DAY_MS, GalleryDb, normalizeInput } from './db.ts';
import { createApp } from './index.ts';
import { authorizedFetch } from './test-auth.ts';
import { SyncScheduler, type HealthInspector } from './scheduler.ts';

const NOW = '2026-10-08T08:00:00.000Z';
const OLD = '2025-05-01T03:20:00.000Z';
const LINK = 'https://pan.baidu.com/s/1healthtest';
const working: LinkCheckResult = { status: 'valid', message: '分享可访问' };

function album(db: GalleryDb, links: Partial<CloudLink>[] = [{ url: LINK, syncEnabled: false }]): Album {
  const input = normalizeInput({ title: '健康检测测试图集', category: '测试分类', tags: [], links }, undefined, NOW);
  return db.save({ ...input, id: randomUUID(), favorite: false, createdAt: OLD, updatedAt: OLD, localUpdatedAt: OLD, updateSource: 'local', images: [] });
}

function withoutHealth(value: Album): unknown {
  return { ...value, links: value.links.map(({ health: _health, ...link }) => link) };
}

test('link health cannot be forged by editing, survives label edits, and resets when URL or extraction code changes', () => {
  const input = normalizeInput({ title: '测试', links: [{ url: LINK, health: { status: 'valid', message: 'forged' } }] }, undefined, NOW);
  assert.equal(input.links[0].health?.status, 'unchecked');
  assert.equal(input.links[0].health?.checkedAt, null);
  const previous: Album = { ...input, id: 'album', favorite: false, createdAt: OLD, localUpdatedAt: OLD, updatedAt: OLD, updateSource: 'local', images: [] };
  previous.links[0].health = { status: 'invalid', message: '已失效', checkedAt: OLD, nextCheckAt: NOW };
  const renamed = normalizeInput({ links: [{ ...previous.links[0], label: '新名称', syncEnabled: true, health: working }] }, previous, NOW);
  assert.deepEqual(renamed.links[0].health, previous.links[0].health);
  for (const change of [{ code: 'abcd' }, { url: `${LINK}new` }]) {
    const edited = normalizeInput({ links: [{ ...previous.links[0], ...change }] }, previous, NOW);
    assert.deepEqual(edited.links[0].health, { status: 'unchecked', message: '尚未检测链接有效性', checkedAt: null, nextCheckAt: NOW });
  }
  const other = normalizeInput({ links: [{ ...previous.links[0], url: 'https://drive.example/file' }] }, previous, NOW);
  assert.equal(other.links[0].health?.status, 'unsupported');
  assert.equal(other.links[0].health?.nextCheckAt, null);
});

test('manual health checks work with auto sync off, count uncertain states separately, and never change album or sync times', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-health-'));
  const db = new GalleryDb(directory);
  let syncCalls = 0;
  const results: LinkCheckResult[] = [working, { status: 'invalid', message: '已明确失效' }, { status: 'code_error', message: '提取码错误' }, { status: 'network_error', message: '连接失败' }];
  let healthCalls = 0;
  const scheduler = new SyncScheduler(db, async () => { syncCalls++; throw new Error('must not sync'); }, () => new Date(NOW), async () => results[healthCalls++]);
  try {
    db.updateSettings({ autoSync: false });
    const original = album(db, [...results.map((_, i) => ({ url: `${LINK}${i}`, syncEnabled: false })), { url: 'http://127.0.0.1/private', syncEnabled: false }]);
    // Imported legacy albums may intentionally retain a displayed time differing from localUpdatedAt.
    original.updatedAt = '2023-02-01T00:00:00.000Z';
    original.updateSource = 'baidu';
    db.connection.prepare('UPDATE albums SET body = ? WHERE id = ?').run(JSON.stringify(original), original.id);
    assert.deepEqual(await scheduler.checkAllLinks(), { checked: 5, valid: 1, invalid: 1, uncertain: 2, unsupported: 1 });
    const current = db.requireAlbum(original.id);
    assert.deepEqual(withoutHealth(current), withoutHealth(original));
    assert.equal(syncCalls, 0);
    assert.equal(healthCalls, 4, 'unsupported URLs must never reach the network adapter');
    assert.equal(current.links[0].health?.checkedAt, NOW);
    assert.equal(current.links[0].health?.nextCheckAt, '2026-10-09T08:00:00.000Z');
    assert.equal(current.links[4].health?.nextCheckAt, null);
    assert(db.logs().every(log => log.kind === 'health' && log.changed === false && log.remoteUpdatedAt === null));
    assert.equal(db.logs().filter(log => log.healthStatus === 'invalid').length, 1);
  } finally { await scheduler.stop(); db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('daily checks include links with timestamp sync disabled, persist across restart, and coalesce due work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-health-daily-'));
  let db = new GalleryDb(directory);
  let clock = new Date(NOW);
  let calls = 0;
  const inspect: HealthInspector = async () => { calls++; return working; };
  let scheduler = new SyncScheduler(db, undefined, () => clock, inspect);
  try {
    const original = album(db, [{ url: LINK }, { url: 'https://other.example/share' }]);
    db.updateSettings({ autoSync: false });
    assert.deepEqual(await scheduler.runDue(), { checked: 0, errors: 0 });
    db.updateSettings({ autoSync: true });
    const results = await Promise.all([scheduler.runDue(), scheduler.runDue()]);
    assert.deepEqual(results, [{ checked: 1, errors: 0 }, { checked: 1, errors: 0 }]);
    assert.equal(calls, 1);
    await scheduler.stop(); db.close();
    db = new GalleryDb(directory);
    scheduler = new SyncScheduler(db, undefined, () => clock, inspect);
    assert.deepEqual(await scheduler.runDue(), { checked: 0, errors: 0 });
    clock = new Date(clock.getTime() + DAY_MS);
    assert.deepEqual(await scheduler.runDue(), { checked: 1, errors: 0 });
    assert.equal(calls, 2);
    assert.deepEqual(withoutHealth(db.requireAlbum(original.id)), withoutHealth(original));
  } finally { await scheduler.stop(); db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('full sync reuses health evidence and failures preserve the known remote timestamp without falsely marking links invalid', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-health-sync-'));
  const db = new GalleryDb(directory);
  let failure: Error | undefined;
  let healthCalls = 0;
  const scheduler = new SyncScheduler(db, async () => {
    if (failure) throw failure;
    return { updatedAt: OLD, fileCount: 1, message: 'ok' };
  }, () => new Date(NOW), async () => { healthCalls++; return working; });
  try {
    const original = album(db, [{ url: LINK, syncEnabled: true }]);
    assert.deepEqual(await scheduler.runDue(), { checked: 1, errors: 0 });
    assert.equal(db.requireAlbum(original.id).links[0].health?.status, 'valid');
    assert.equal(healthCalls, 0);
    failure = new BaiduShareError('目录可读，但文件时间不完整', 'valid');
    await scheduler.syncAll();
    assert.equal(db.requireAlbum(original.id).links[0].health?.status, 'valid');
    assert.equal(db.requireAlbum(original.id).links[0].status, 'error');
    failure = new Error('private upstream secret');
    await scheduler.syncAll();
    assert.equal(db.requireAlbum(original.id).links[0].health?.status, 'unknown');
    assert.equal(db.requireAlbum(original.id).updatedAt, OLD);
    assert(!JSON.stringify(db.logs()).includes('secret'));
    failure = new BaiduShareError('分享已经过期', 'invalid');
    await scheduler.syncAll();
    assert.equal(db.requireAlbum(original.id).links[0].health?.status, 'invalid');
    assert.equal(db.requireAlbum(original.id).updatedAt, OLD);
  } finally { await scheduler.stop(); db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('in-flight health results preserve concurrent metadata edits and cannot overwrite a changed link or resurrect a deleted album', async () => {
  for (const action of ['rename', 'code', 'url', 'delete'] as const) {
    const directory = await mkdtemp(join(tmpdir(), 'lumina-health-race-'));
    const db = new GalleryDb(directory);
    let release!: () => void; let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const scheduler = new SyncScheduler(db, undefined, () => new Date(NOW), async () => { started(); await gate; return { status: 'invalid', message: '分享已失效' }; });
    try {
      const original = album(db);
      const pending = scheduler.checkAllLinks();
      await ready;
      if (action === 'delete') db.remove(original.id);
      else {
        const input = normalizeInput({
          title: '编辑后的标题',
          category: '编辑后的分类',
          links: [{ ...original.links[0], ...(action === 'code' ? { code: 'abcd' } : action === 'url' ? { url: `${LINK}new` } : {}) }],
        }, original, NOW);
        db.save({ ...original, ...input, favorite: false });
      }
      release();
      const result = await pending;
      assert.equal(result.checked, action === 'rename' ? 1 : 0, 'discarded stale results must not appear in the user-facing summary');
      assert.equal(result.invalid, action === 'rename' ? 1 : 0);
      const latest = db.album(original.id);
      if (action === 'delete') assert.equal(latest, undefined);
      else {
        assert.equal(latest?.title, '编辑后的标题');
        assert.equal(latest?.category, '编辑后的分类');
        assert.equal(latest?.links[0].health?.status, action === 'rename' ? 'invalid' : 'unchecked');
      }
      assert.equal(db.logs().length, action === 'rename' ? 1 : 0);
      if (action === 'rename') assert.equal(db.logs()[0].albumTitle, '编辑后的标题');
    } finally { release(); await scheduler.stop(); db.close(); await rm(directory, { recursive: true, force: true }); }
  }
});

test('health and its audit entry are saved atomically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-health-atomic-'));
  const db = new GalleryDb(directory);
  const scheduler = new SyncScheduler(db, undefined, () => new Date(NOW), async () => working);
  try {
    const original = album(db);
    db.connection.exec("CREATE TRIGGER reject_health_log BEFORE INSERT ON sync_logs BEGIN SELECT RAISE(ABORT, 'fixture rejected log'); END;");
    await assert.rejects(scheduler.checkAllLinks(), /fixture rejected log/);
    assert.deepEqual(db.requireAlbum(original.id), original);
    assert.deepEqual(db.logs(), []);
  } finally { await scheduler.stop(); db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('link-check APIs support one link, one album, and all albums with normal host and origin protections', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-health-api-'));
  let calls = 0;
  const runtime = await createApp({ dataDir: directory, healthInspector: async () => { calls++; return { status: 'code_required', message: '需要提取码' }; } });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  const fetch = await authorizedFetch(base);
  try {
    const original = album(runtime.db, [{ url: LINK }, { url: 'https://other.example/share' }]);
    const second = album(runtime.db);
    runtime.db.updateSettings({ autoSync: false });
    const singleResponse = await fetch(`${base}/albums/${original.id}/links/${original.links[0].id}/check`, { method: 'POST' });
    assert.equal(singleResponse.status, 200);
    const single = await singleResponse.json() as Record<string, unknown>;
    assert.deepEqual({ ...single, album: undefined }, { album: undefined, checked: 1, valid: 0, invalid: 0, uncertain: 1, unsupported: 0 });
    assert.equal(calls, 1);
    const albumResponse = await fetch(`${base}/albums/${original.id}/link-checks`, { method: 'POST' });
    assert.equal(albumResponse.status, 200);
    const albumResult = await albumResponse.json() as { checked: number; unsupported: number };
    assert.equal(albumResult.checked, 2); assert.equal(albumResult.unsupported, 1);
    const allResponse = await fetch(`${base}/link-checks`, { method: 'POST' });
    assert.equal(allResponse.status, 200);
    assert.deepEqual(await allResponse.json(), { checked: 3, valid: 0, invalid: 0, uncertain: 2, unsupported: 1 });
    assert.equal(calls, 4);
    assert.equal((await fetch(`${base}/albums/${second.id}/links/not-a-link/check`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${base}/albums/not-an-album/link-checks`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${base}/link-checks`, { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.deepEqual(withoutHealth(runtime.db.requireAlbum(original.id)), withoutHealth(original));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await runtime.close(); await rm(directory, { recursive: true, force: true });
  }
});
