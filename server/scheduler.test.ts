import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError, GalleryDb, normalizeInput } from './db.ts';
import { MAX_QUEUED_SYNC_JOBS, SyncScheduler, type Inspector } from './scheduler.ts';

async function fixture(inspector: Inspector) {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-scheduler-lifecycle-'));
  const db = new GalleryDb(directory);
  const now = new Date().toISOString();
  const input = normalizeInput({ title: '任务测试', links: [{ url: 'https://pan.baidu.com/s/1testshare', syncEnabled: true }] });
  const album = db.save({ ...input, favorite: false, id: randomUUID(), createdAt: now, localUpdatedAt: now, updatedAt: now, updateSource: 'local', images: [] });
  const scheduler = new SyncScheduler(db, inspector);
  return { db, scheduler, album, async close() { await scheduler.stop(); db.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('repeated manual and scheduled checks coalesce without growing the task queue', async () => {
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const context = await fixture(async () => { calls++; await gate; return { updatedAt: '2026-01-01T00:00:00Z', fileCount: 1, message: 'ok' }; });
  try {
    const manual = context.scheduler.syncAlbum(context.album.id);
    for (let index = 0; index < 1000; index++) assert.equal(context.scheduler.syncAlbum(context.album.id), manual);
    const due = context.scheduler.runDue();
    for (let index = 0; index < 1000; index++) assert.equal(context.scheduler.runDue(), due);
    release();
    await Promise.all([manual, due]);
    assert.equal(calls, 1);
    assert.equal(context.db.logs().length, 1);
  } finally { release(); await context.close(); }
});

test('different pending jobs have a fixed bound and failed jobs release capacity', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const context = await fixture(async () => { await gate; return { updatedAt: '2026-01-01T00:00:00Z', fileCount: 1, message: 'ok' }; });
  try {
    const running = context.scheduler.syncAlbum(context.album.id);
    const queued = Array.from({ length: MAX_QUEUED_SYNC_JOBS - 1 }, (_, index) => context.scheduler.syncAlbum(`absent-${index}`));
    const settled = Promise.allSettled(queued);
    await assert.rejects(context.scheduler.checkAllLinks(), error => error instanceof ApiError && error.status === 429);
    assert.equal(context.scheduler.syncAlbum(context.album.id), running, 'duplicates still join their admitted task');
    release(); await running;
    const results = await settled;
    assert(results.every(result => result.status === 'rejected' && result.reason instanceof ApiError && result.reason.status === 404));
    assert.equal((await context.scheduler.runDue()).checked, 0, 'capacity returns after failures');
  } finally { release(); await context.close(); }
});

test('stop cancels active requests, skips queued work, and preserves saved sync state', async () => {
  let started!: () => void, signal: AbortSignal | undefined, calls = 0;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const context = await fixture(async input => {
    calls++; signal = input.signal; started();
    return new Promise((_resolve, reject) => input.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  });
  try {
    const before = context.db.requireAlbum(context.album.id);
    const running = context.scheduler.runDue();
    await ready;
    const queued = context.scheduler.syncAlbum(context.album.id);
    const rejected = assert.rejects(queued, error => error instanceof ApiError && error.status === 503);
    await context.scheduler.stop();
    await rejected;
    assert.equal(signal?.aborted, true);
    assert.deepEqual(await running, { checked: 0, errors: 0 });
    assert.equal(calls, 1);
    assert.deepEqual(context.db.requireAlbum(context.album.id), before);
    assert.equal(context.db.logs().length, 0);
    await assert.rejects(context.scheduler.runDue(), error => error instanceof ApiError && error.status === 503);
  } finally { await context.close(); }
});
