import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AutoBackupNotice } from '../shared/auto-backup.ts';
import type { AutomaticBackupPlan } from './backup.ts';
import { ApiError, GalleryDb } from './db.ts';
import { AutoBackupService, nextAutomaticBackupAt, type AutoBackupOptions } from './auto-backup.ts';
import { MIN_FREE_DISK_BYTES } from './resource-limits.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ESTIMATE = 64;
const REQUIRED = MIN_FREE_DISK_BYTES + ESTIMATE;

async function fixture(jobTimeoutMs?: number, extraOptions: Partial<AutoBackupOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-auto-backup-'));
  const db = new GalleryDb(directory);
  const uploads = join(directory, 'uploads'); await mkdir(uploads);
  let now = Date.parse('2026-10-09T00:00:00.000Z');
  let free = async () => REQUIRED + 1024;
  let estimate = ESTIMATE;
  let writes = 0;
  let releases = 0;
  let prepared = 0;
  let build: AutomaticBackupPlan['write'] = async stage => {
    const path = join(stage, '完整备份.zip');
    await writeFile(path, Buffer.alloc(64, 65));
    return { path, filename: '完整备份.zip', size: 64 };
  };
  const notices: AutoBackupNotice[] = [];
  const options = {
    jobTimeoutMs,
    clock: () => now,
    diskFree: async () => free(),
    notify: (notice: AutoBackupNotice) => { notices.push(notice); },
    prepare: async (): Promise<AutomaticBackupPlan> => {
      prepared++;
      return { estimatedBytes: estimate, write: async (stage, signal) => { writes++; return build(stage, signal); }, release: () => { releases++; } };
    },
    ...extraOptions,
  };
  let service = new AutoBackupService(db, uploads, options); await service.initialize();
  return {
    directory, db, uploads, notices,
    get service() { return service; }, get now() { return now; }, get writes() { return writes; }, get releases() { return releases; }, get prepared() { return prepared; },
    advance(time: number) { now += time; }, setFree(value: number | (() => Promise<number>)) { free = typeof value === 'number' ? async () => value : value; },
    setEstimate(value: number) { estimate = value; }, setBuild(value: AutomaticBackupPlan['write']) { build = value; },
    async run() { now += 1000; service.runNow(); await service.flush(); return service.status(); },
    async seed(count: number) { for (let i = 0; i < count; i++) await this.run(); return (await service.status()).backups; },
    async restart() { await service.close(); service = new AutoBackupService(db, uploads, options); await service.initialize(); },
    async close() { await service.close(); db.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('weekly schedule uses Hong Kong time, persists, and does not create an immediate first backup', async () => {
  assert.equal(nextAutomaticBackupAt({ weekday: 0, time: '03:00' }, Date.parse('2026-10-09T00:00:00Z')), '2026-10-10T19:00:00.000Z');
  assert.equal(nextAutomaticBackupAt({ weekday: 0, time: '03:00' }, Date.parse('2026-10-10T19:00:00Z')), '2026-10-17T19:00:00.000Z');
  const f = await fixture();
  try {
    const initial = await f.service.status();
    assert.equal(initial.settings.enabled, true); assert.equal(initial.settings.retainCount, 7); assert.equal(initial.freeBytes, REQUIRED + 1024);
    await f.service.tick(); assert.equal(f.writes, 0);
    const changed = await f.service.updateSettings({ weekday: 2, time: '14:32' });
    await f.restart(); assert.equal((await f.service.status()).nextRunAt, changed.nextRunAt);
    f.advance(Date.parse(changed.nextRunAt!) - f.now);
    await f.service.tick(); assert.equal(f.writes, 1); assert.equal((await f.service.status()).phase, 'success');
    assert.equal(f.releases, 1);
  } finally { await f.close(); }
});

test('complete backup is atomically published; only the newest seven completed copies remain', async () => {
  const f = await fixture();
  try {
    const first = (await f.seed(1))[0];
    await f.seed(7);
    const status = await f.service.status();
    assert.equal(status.backups.length, 7); assert(!status.backups.some(item => item.id === first.id));
    assert((await readdir(f.service.directory)).every(name => name.startsWith('backup-')));
    const download = await f.service.download(status.backups[0].id);
    assert.equal((await readFile(download.path)).length, 64); download.release(); download.release();
    assert.equal(f.writes, 8); assert.equal(f.releases, 8);
  } finally { await f.close(); }
});

test('low space warns once, waits a persistent 24 hours and can recover early without deleting old backups', async () => {
  const f = await fixture();
  try {
    const old = await f.seed(2); f.setFree(10);
    const waiting = await f.run();
    assert.equal(waiting.phase, 'waiting_space'); assert.equal(waiting.requiredBytes, REQUIRED); assert.equal(waiting.backups.length, 2);
    assert.equal(Date.parse(waiting.cleanupAfter!) - Date.parse(waiting.warningAt!), DAY);
    assert.equal(f.notices.filter(n => n.kind === 'low_space').length, 1);
    f.advance(HOUR); await f.service.tick();
    await f.restart(); const restored = await f.service.status();
    assert.equal(restored.cleanupAfter, waiting.cleanupAfter); assert.equal(restored.warningAt, waiting.warningAt);
    f.advance(HOUR); await f.service.tick(); assert.equal(f.notices.filter(n => n.kind === 'low_space').length, 1);
    f.setFree(REQUIRED); f.advance(HOUR); await f.service.tick();
    const success = await f.service.status(); assert.equal(success.phase, 'success'); assert.equal(success.backups.length, 3);
    assert(old.every(entry => success.backups.some(next => next.id === entry.id)));
    assert.equal(f.notices.filter(n => n.kind === 'recovered').length, 1);
  } finally { await f.close(); }
});

test('after 24 hours deletes the oldest one at a time and remeasures actual released capacity', async () => {
  const f = await fixture();
  try {
    const before = await f.seed(3);
    const counts: number[] = [];
    f.setFree(async () => {
      const count = (await readdir(f.service.directory)).filter(name => name.startsWith('backup-')).length;
      counts.push(count); return REQUIRED - 200 + (3 - count) * 110;
    });
    const waiting = await f.run(); assert.equal(waiting.phase, 'waiting_space'); assert.equal(waiting.backups.length, 3);
    f.advance(DAY - 1); await f.service.tick(); assert.equal((await f.service.status()).backups.length, 3);
    f.advance(HOUR + 1); await f.service.tick();
    const after = await f.service.status();
    assert.equal(after.phase, 'success'); assert.equal(after.backups.length, 2);
    assert(after.backups.some(item => item.id === before[0].id));
    assert(!after.backups.some(item => item.id === before[1].id || item.id === before[2].id));
    assert(counts.includes(3) && counts.includes(2) && counts.includes(1));
  } finally { await f.close(); }
});

test('never deletes the last completed backup; stops and alerts the administrator without a tight retry loop', async () => {
  const f = await fixture();
  try {
    const before = await f.seed(3); f.setFree(0);
    await f.run(); f.advance(DAY); await f.service.tick();
    const blocked = await f.service.status(); assert.equal(blocked.phase, 'blocked'); assert.equal(blocked.retryAt, null);
    assert.equal(blocked.backups.length, 1); assert.equal(blocked.backups[0].id, before[0].id);
    assert.equal(f.notices.filter(n => n.kind === 'stopped').length, 1);
    const attempts = f.prepared;
    await f.service.tick(); f.advance(HOUR); await f.service.tick();
    assert.equal(f.prepared, attempts); assert.equal(f.writes, 3);
  } finally { await f.close(); }
});

test('zero existing backups and insufficient capacity also stop safely after the waiting period', async () => {
  const f = await fixture();
  try {
    f.setFree(0); await f.run(); f.advance(DAY); await f.service.tick();
    const status = await f.service.status(); assert.equal(status.phase, 'blocked'); assert.equal(status.backups.length, 0); assert.equal(f.writes, 0);
  } finally { await f.close(); }
});

test('unchanged settings preserve the warning deadline; effective changes reset it; disabling pauses the schedule', async () => {
  const f = await fixture();
  try {
    f.setFree(0); const waiting = await f.run();
    await f.service.updateSettings({ weekday: 0, time: '03:00', enabled: true });
    assert.equal((await f.service.status()).cleanupAfter, waiting.cleanupAfter);
    f.advance(HOUR); await f.service.updateSettings({ time: '04:00' });
    assert.equal((await f.service.status()).cleanupAfter, null);
    const again = await f.run(); assert(Date.parse(again.cleanupAfter!) > Date.parse(waiting.cleanupAfter!));
    const paused = await f.service.updateSettings({ enabled: false }); assert.equal(paused.nextRunAt, null); assert.equal(paused.retryAt, null);
    const prepared = f.prepared; f.advance(30 * DAY); await f.service.tick(); assert.equal(f.prepared, prepared);
    await assert.rejects(f.service.updateSettings({ weekday: 9 }), /星期/);
    await assert.rejects(f.service.updateSettings({ time: '24:00' }), /HH:mm/);
  } finally { await f.close(); }
});

test('impossible format/size errors cannot delete existing complete backups even after an expired warning', async () => {
  const f = await fixture();
  try {
    const before = await f.seed(3); f.setFree(0); await f.run();
    f.setEstimate(8 * 1024 ** 3 + 1); f.advance(DAY); await f.service.tick();
    const failed = await f.service.status(); assert.equal(failed.phase, 'failed'); assert.equal(failed.retryAt, null);
    assert.deepEqual(failed.backups.map(entry => entry.id), before.map(entry => entry.id)); assert.equal(f.writes, 3);
  } finally { await f.close(); }
});

test('failed partial builds are removed and repeated failures notify once with hourly retries', async () => {
  const f = await fixture();
  try {
    const before = await f.seed(1);
    f.setBuild(async stage => { await writeFile(join(stage, '完整备份.zip.partial'), 'partial'); throw new Error('fake failure'); });
    const failed = await f.run(); assert.equal(failed.phase, 'failed'); assert.equal(failed.backups[0].id, before[0].id);
    assert.equal(Date.parse(failed.retryAt!) - f.now, HOUR);
    for (let i = 0; i < 3; i++) { f.advance(HOUR); await f.service.tick(); }
    assert.equal(f.notices.filter(n => n.kind === 'failed').length, 1);
    assert((await readdir(f.service.directory)).every(name => name.startsWith('backup-')));
    assert.equal((await f.service.status()).backups.length, 1);
  } finally { await f.close(); }
});

test('space exhausted while writing enters the 24 hour grace instead of deleting a backup immediately', async () => {
  const f = await fixture();
  try {
    const before = await f.seed(2);
    f.setBuild(async stage => { await writeFile(join(stage, '完整备份.zip.partial'), 'partial'); throw new ApiError(507, 'full'); });
    const failed = await f.run(); assert.equal(failed.phase, 'waiting_space'); assert.equal(failed.backups.length, 2);
    assert.deepEqual(failed.backups.map(entry => entry.id), before.map(entry => entry.id));
    assert.equal(Date.parse(failed.cleanupAfter!) - f.now, DAY); assert.equal(f.notices.at(-1)?.kind, 'low_space');
  } finally { await f.close(); }
});

test('download pins prevent deletion; repeated manual jobs cannot grow beyond one extra completed backup', async () => {
  const f = await fixture();
  try {
    const before = await f.seed(7);
    const download = await f.service.download(before.at(-1)!.id);
    await f.run(); assert.equal((await f.service.status()).backups.length, 8);
    await f.run(); await f.run(); assert.equal(f.writes, 8); assert.equal((await f.service.status()).backups.length, 8);
    assert.equal((await readFile(download.path)).length, 64);
    download.release(); f.advance(HOUR); await f.service.tick();
    const retained = await f.service.status(); assert.equal(retained.backups.length, 7);
    assert(!retained.backups.some(item => item.id === before.at(-1)!.id));
  } finally { await f.close(); }
});

test('download cannot acquire a pin while asynchronous deletion is still in progress', async () => {
  const f = await fixture();
  try {
    const before = await f.seed(2);
    type StoredEntry = typeof before[number] & { path: string; directory: string };
    // Pause the filesystem operation at its await boundary, without relying on timing or large files.
    const internal = f.service as unknown as {
      readEntry(name: string): Promise<StoredEntry | null>;
      removeComplete(entry: StoredEntry): Promise<boolean>;
      removeKnownDirectory(directory: string, allowed: Set<string>, marker: string): Promise<boolean>;
    };
    const originalRemove = internal.removeKnownDirectory.bind(f.service);
    let entered!: () => void; const deleting = new Promise<void>(resolve => { entered = resolve; });
    let resume!: () => void; const released = new Promise<void>(resolve => { resume = resolve; });
    internal.removeKnownDirectory = async (...args) => { entered(); await released; return originalRemove(...args); };
    const oldest = await internal.readEntry(`backup-${before.at(-1)!.id}`); assert(oldest);
    const removed = internal.removeComplete(oldest);
    try {
      await deleting;
      assert.equal((await readFile(oldest.path)).length, 64);
      await assert.rejects(f.service.download(oldest.id), /正在清理/);
    } finally { resume(); await removed; }
    assert.equal(await removed, true);
    assert.equal((await f.service.status()).backups.length, 1);
  } finally { await f.close(); }
});

test('unknown files, unowned directories and symlink directories are not deleted for space', async () => {
  const f = await fixture();
  try {
    const before = await f.seed(2);
    const oldest = before.at(-1)!;
    const unknownFile = join(f.service.directory, `backup-${oldest.id}`, 'keep-my-file.txt'); await writeFile(unknownFile, 'keep');
    const unknown = join(f.service.directory, `backup-${randomUUID()}`); await mkdir(unknown); await writeFile(join(unknown, 'notes.txt'), 'unknown');
    const outside = join(f.directory, 'elsewhere'); await mkdir(outside); await writeFile(join(outside, 'keep.txt'), 'outside');
    await symlink(outside, join(f.service.directory, `backup-${randomUUID()}`), 'junction');
    f.setFree(0); await f.run(); f.advance(DAY); await f.service.tick();
    assert.equal((await f.service.status()).phase, 'blocked'); assert.equal((await f.service.status()).backups.length, 2);
    assert.equal(await readFile(unknownFile, 'utf8'), 'keep'); assert.equal(await readFile(join(unknown, 'notes.txt'), 'utf8'), 'unknown');
    assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'outside');
    await assert.rejects(f.service.download('../../elsewhere'), /不存在/);
  } finally { await f.close(); }
});

test('startup cleans owned interrupted work only; unknown stage contents halt further accumulation', async () => {
  const f = await fixture();
  try {
    const stage = async (name: string) => {
      const id = randomUUID(); const path = join(f.service.directory, `.pending-${id}`); await mkdir(path);
      await writeFile(join(path, '.lumina-auto-backup-stage.json'), JSON.stringify({ owner: 'lumina-automatic-backup', version: 1, id }));
      await writeFile(join(path, name), 'partial'); return path;
    };
    const safe = await stage('完整备份.zip.partial'); const unknown = await stage('my-private-file.txt');
    await f.restart();
    await assert.rejects(readFile(join(safe, '完整备份.zip.partial')), { code: 'ENOENT' });
    assert.equal(await readFile(join(unknown, 'my-private-file.txt'), 'utf8'), 'partial');
    await f.run(); await f.run(); assert.equal(f.writes, 0); assert.equal((await f.service.status()).phase, 'failed');
    assert.equal((await readdir(f.service.directory)).length, 1);
  } finally { await f.close(); }
});

test('overlapping jobs share one operation and shutdown cancels and cleans partial output', async () => {
  const f = await fixture();
  try {
    await f.seed(1);
    let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
    f.setBuild(async (stage, signal) => {
      await writeFile(join(stage, '完整备份.zip.partial'), 'partial'); ready();
      await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
      throw new Error('unreachable');
    });
    f.service.runNow(); await started;
    assert.throws(() => f.service.runNow(), /正在进行/);
    await assert.rejects(f.service.updateSettings({ time: '06:00' }), /正在进行/);
    const overlapping = f.service.tick(); await f.service.close(); await overlapping;
    assert.equal(f.writes, 2); assert((await readdir(join(f.directory, 'auto-backups'))).every(name => name.startsWith('backup-')));
    await f.restart(); assert.equal((await f.service.status()).backups.length, 1);
    assert.equal(f.notices.length, 0);
  } finally { await f.close(); }
});

test('a generation deadline aborts stalled writes, releases resources and alerts once before hourly retry', async () => {
  const f = await fixture(1000);
  try {
    const before = await f.seed(1);
    let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
    f.setBuild(async (stage, signal) => {
      await writeFile(join(stage, '完整备份.zip.partial'), 'partial'); ready();
      signal!.throwIfAborted();
      await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
      throw new Error('unreachable');
    });
    f.service.runNow();
    // The service's deadline is deliberately unref'ed; keep only this test alive until it fires.
    const keepAlive = setInterval(() => undefined, 1000);
    try { await started; await f.service.flush(); } finally { clearInterval(keepAlive); }
    const failed = await f.service.status();
    assert.equal(failed.phase, 'failed'); assert.equal(failed.running, false); assert.match(failed.message, /运行时限/); assert.doesNotMatch(failed.message, /服务停止/);
    assert.equal(Date.parse(failed.retryAt!) - f.now, HOUR);
    assert.equal(failed.backups.length, 1); assert.equal(failed.backups[0].id, before[0].id);
    assert.equal(f.notices.filter(n => n.kind === 'failed').length, 1); assert.equal(f.releases, 2);
    assert((await readdir(f.service.directory)).every(name => name.startsWith('backup-')));
    f.setBuild(async stage => {
      const path = join(stage, '完整备份.zip'); await writeFile(path, Buffer.alloc(64));
      return { path, filename: '完整备份.zip', size: 64 };
    });
    const recovered = await f.run(); assert.equal(recovered.phase, 'success'); assert.equal(recovered.backups.length, 2); assert.equal(f.releases, 3);
    assert.equal(f.notices.filter(n => n.kind === 'recovered').length, 1);
  } finally { await f.close(); }
});

test('WebDAV upload failure preserves the local archive and retries that same archive after restart', async () => {
  let fail = true; let attempts = 0;
  const f = await fixture(undefined, {
    webdavEnabled: () => true,
    uploadWebdav: async (_entry, signal) => { attempts++; signal.throwIfAborted(); if (fail) throw new Error('private credential detail'); },
  });
  try {
    const failed = await f.run();
    assert.equal(failed.phase, 'failed'); assert.equal(failed.backups.length, 1); assert.match(failed.message, /WebDAV 上传失败/);
    assert.doesNotMatch(failed.message, /private credential/);
    const localId = failed.backups[0]!.id;
    await f.restart(); f.advance(HOUR); fail = false;
    await f.service.tick(); await f.service.flush();
    const recovered = await f.service.status();
    assert.equal(recovered.phase, 'success'); assert.equal(recovered.backups.length, 1); assert.equal(recovered.backups[0]!.id, localId);
    assert.equal(f.writes, 1); assert.equal(attempts, 2); assert.equal(recovered.retryAt, null);
  } finally { await f.close(); }
});

test('invalid writer output is never committed and does not damage previous complete copies', async () => {
  const f = await fixture();
  try {
    const before = await f.seed(1);
    const outside = join(f.directory, 'outside.zip'); await writeFile(outside, 'keep');
    f.setBuild(async () => ({ path: outside, filename: '完整备份.zip', size: 4 }));
    const failed = await f.run(); assert.equal(failed.phase, 'failed'); assert.equal(failed.backups[0].id, before[0].id);
    assert.equal(await readFile(outside, 'utf8'), 'keep');
    assert((await readdir(f.service.directory)).every(name => name.startsWith('backup-')));
  } finally { await f.close(); }
});
