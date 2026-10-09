import { lstat, opendir, realpath, statfs, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { GalleryDb } from './db.ts';
import { MIN_FREE_DISK_BYTES } from './resource-limits.ts';
import { reportRuntimeError } from './runtime-log.ts';

const DAY = 24 * 60 * 60 * 1000;
const TEMP_NAME = /^(?:[a-f0-9]{32}|remote-[a-f0-9-]{36}(?:\.[a-z0-9]+)?)$/i;
const IMAGE_NAME = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?:\.thumb)?\.(?:jpg|jpeg|png|webp|gif|avif)$/i;

/** Only app-generated files older than a day; referenced originals are never eligible. */
export async function sweepGalleryFiles(db: GalleryDb, now = Date.now(), stopped = () => false): Promise<void> {
  const referenced = new Set<string>();
  for (const row of db.connection.prepare('SELECT body FROM albums').iterate()) {
    const album = JSON.parse(String(row.body));
    for (const image of album.images ?? []) {
      for (const url of [image.url, image.thumbnailUrl]) {
        if (typeof url === 'string' && url.startsWith('/uploads/')) referenced.add(url.slice('/uploads/'.length));
      }
    }
  }
  for (const subdirectory of ['.incoming', 'uploads']) {
    const root = resolve(db.directory, subdirectory);
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || dirname(await realpath(root)) !== await realpath(db.directory)) continue;
    const folder = await opendir(root);
    for await (const entry of folder) {
      if (stopped()) return;
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      if (!(subdirectory === '.incoming' ? TEMP_NAME : IMAGE_NAME).test(entry.name) || referenced.has(entry.name)) continue;
      const path = resolve(root, entry.name);
      if (dirname(path) !== root) continue;
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || Math.max(info.mtimeMs, info.ctimeMs) > now - DAY) continue;
        await unlink(path);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') reportRuntimeError('file-cleanup', error); }
    }
  }
}

export async function maintainDatabase(db: GalleryDb, isBusy = () => false): Promise<void> {
  db.connection.prepare('DELETE FROM sync_logs WHERE checked_at < ?').run(new Date(Date.now() - 90 * DAY).toISOString());
  db.connection.exec('DELETE FROM sync_logs WHERE id NOT IN (SELECT id FROM sync_logs ORDER BY checked_at DESC, rowid DESC LIMIT 1000)');
  if (isBusy()) return;
  const space = await statfs(db.directory);
  if (isBusy()) return;
  const pragma = (name: string) => Number(Object.values(db.connection.prepare(`PRAGMA ${name}`).get()!)[0]);
  const pages = pragma('page_count');
  const pageSize = pragma('page_size');
  const free = pragma('freelist_count');
  // New databases use incremental reclamation; migrate small legacy DBs once, only with headroom.
  if (pragma('auto_vacuum') === 0 && pages * pageSize <= 256 * 1024 * 1024 && space.bavail * space.bsize > pages * pageSize * 2 + MIN_FREE_DISK_BYTES) {
    db.connection.exec('PRAGMA auto_vacuum=INCREMENTAL; VACUUM;');
  } else if (free > 0 && pragma('auto_vacuum') === 2) {
    // SQLite may reclaim only one page per invocation; cap each maintenance pass.
    for (let index = 0; index < Math.min(free, 256); index++) db.connection.exec('PRAGMA incremental_vacuum(1)');
  }
  // Do not wait on external readers: a busy checkpoint is retried on the next pass.
  db.connection.exec('PRAGMA busy_timeout=0');
  try { db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA shrink_memory;'); }
  finally { db.connection.exec('PRAGMA busy_timeout=5000'); }
}

export function startMaintenance(db: GalleryDb, isBusy = () => false): () => Promise<void> {
  let stopped = false;
  let current: Promise<void> | undefined;
  const run = () => {
    if (stopped || current) return;
    current = (async () => {
      try { await sweepGalleryFiles(db, Date.now(), () => stopped); } catch (error) { reportRuntimeError('file-maintenance', error); }
      if (!stopped) try { await maintainDatabase(db, isBusy); } catch (error) { reportRuntimeError('database-maintenance', error); }
    })().finally(() => { current = undefined; });
  };
  run();
  const timer = setInterval(run, 10 * 60 * 1000); timer.unref();
  return async () => { stopped = true; clearInterval(timer); await current; };
}
