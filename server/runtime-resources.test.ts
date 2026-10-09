import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { RuntimeLogger } from './runtime-log.ts';
import { GalleryDb, normalizeInput } from './db.ts';
import { maintainDatabase, sweepGalleryFiles } from './maintenance.ts';
import { imageUpload, receiveMultipart, requestCapacity } from './resource-limits.ts';
import { acquireInstanceLock } from './instance-lock.ts';

async function fixture(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  return { directory, cleanup: async () => { assert(resolve(directory).startsWith(resolve(tmpdir()) + '\\') || resolve(directory).startsWith(resolve(tmpdir()) + '/')); await rm(directory, { recursive: true, force: true }); } };
}

test('100000 repeated errors stay bounded and rotating logs never retain secret messages', async () => {
  const f = await fixture('lumina-log-resource-');
  let clock = Date.now();
  const logger = new RuntimeLogger(f.directory, 1024, 3, () => clock);
  try {
    for (let index = 0; index < 100000; index++) logger.error('broken-job', new Error('password=DO-NOT-LOG'));
    let log = await readFile(join(f.directory, 'runtime.log'), 'utf8');
    assert.equal(log.trim().split('\n').length, 1);
    clock += 61000; logger.error('broken-job', new Error('secret'));
    log = await readFile(join(f.directory, 'runtime.log'), 'utf8');
    assert.match(log, /"suppressed":99999/);
    for (let index = 0; index < 500; index++) { clock += 61000; logger.error(`different-${index}`, new Error('password=DO-NOT-LOG')); }
    const names = await readdir(f.directory); assert(names.length <= 3);
    for (const name of names) { assert((await stat(join(f.directory, name))).size <= 1024); assert(!(await readFile(join(f.directory, name), 'utf8')).includes('DO-NOT-LOG')); }
    const inaccessible = join(f.directory, 'not-a-directory'); await writeFile(inaccessible, 'x');
    const failedLogger = new RuntimeLogger(inaccessible);
    assert.doesNotThrow(() => { for (let index = 0; index < 10000; index++) failedLogger.error('disk-full', new Error('full')); });
  } finally { await f.cleanup(); }
});

test('maintenance removes aged generated leftovers but keeps referenced originals and unknown files', async () => {
  const f = await fixture('lumina-file-resource-'); const db = new GalleryDb(f.directory);
  try {
    const uploads = join(f.directory, 'uploads'); const incoming = join(f.directory, '.incoming');
    await mkdir(uploads); await mkdir(incoming);
    const original = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.jpg';
    const orphan = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb.thumb.webp';
    await writeFile(join(uploads, original), 'original'); await writeFile(join(uploads, orphan), 'orphan');
    await writeFile(join(uploads, 'my-photo.jpg'), 'manual-file');
    await writeFile(join(incoming, 'a'.repeat(32)), 'temporary'); await writeFile(join(incoming, 'keep.txt'), 'manual-file');
    const now = new Date().toISOString();
    db.save({ ...normalizeInput({ title: '保留原图' }), id: 'protected', favorite: false, createdAt: now, localUpdatedAt: now, updatedAt: now, updateSource: 'local', images: [{ id: 'original', url: `/uploads/${original}`, thumbnailUrl: `/uploads/${original}`, name: '照片.jpg', width: 1, height: 1, size: 8 }] });
    await sweepGalleryFiles(db); assert.equal((await readdir(incoming)).length, 2, 'recent uploads must survive');
    await sweepGalleryFiles(db, Date.now() + 2 * 86400000);
    assert.deepEqual((await readdir(uploads)).sort(), [original, 'my-photo.jpg'].sort());
    assert.deepEqual(await readdir(incoming), ['keep.txt']);
    assert.equal(await readFile(join(uploads, original), 'utf8'), 'original');
  } finally { db.close(); await f.cleanup(); }
});

test('database maintenance reclaims freed pages and WAL while preserving live rows', async () => {
  const f = await fixture('lumina-db-resource-'); const db = new GalleryDb(f.directory);
  try {
    db.connection.exec('CREATE TABLE resource_fixture(id INTEGER PRIMARY KEY, body BLOB)');
    db.connection.exec('INSERT INTO resource_fixture VALUES(1,zeroblob(2097152))');
    db.connection.exec('INSERT INTO resource_fixture VALUES(2,zeroblob(32))');
    const before = Number(db.connection.prepare('PRAGMA page_count').get()!.page_count);
    db.connection.exec('DELETE FROM resource_fixture WHERE id=1');
    await maintainDatabase(db); await maintainDatabase(db); await maintainDatabase(db);
    const after = Number(db.connection.prepare('PRAGMA page_count').get()!.page_count);
    assert(after < before / 2); assert.equal(db.connection.prepare('SELECT length(body) AS length FROM resource_fixture WHERE id=2').get()!.length, 32);
    assert((await stat(join(f.directory, 'gallery.db-wal'))).size < 1024);
  } finally { db.close(); await f.cleanup(); }
});

test('multipart aggregate byte limit cleans already written and failed files, permits later uploads', async () => {
  const f = await fixture('lumina-upload-resource-'); const app = express();
  const upload = imageUpload(f.directory, 100);
  app.post('/upload', upload, (_req, res) => res.json({ ok: true }));
  app.use((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({ failed: true }); });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  const address = server.address(); assert(address && typeof address !== 'string');
  try {
    const body = new FormData(); body.append('images', new Blob(['a'.repeat(80)]), 'a.png'); body.append('images', new Blob(['b'.repeat(80)]), 'b.png');
    const response = await fetch(`http://127.0.0.1:${address.port}/upload`, { method: 'POST', body });
    assert.equal(response.status, 413); assert.deepEqual(await readdir(f.directory), []);
    const next = new FormData(); next.append('images', new Blob(['valid']), 'ok.png');
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/upload`, { method: 'POST', body: next })).status, 200);
  } finally { await new Promise<void>(done => server.close(() => done())); await f.cleanup(); }
});

test('request admission refuses excess work and releases capacity after response completion', async () => {
  const app = express(); const limiter = requestCapacity(1); app.use(limiter.middleware);
  let release!: () => void; const gate = new Promise<void>(done => { release = done; });
  app.get('/hold', async (_req, res) => { await gate; res.json({ ok: true }); });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  const address = server.address(); assert(address && typeof address !== 'string'); const url = `http://127.0.0.1:${address.port}/hold`;
  try {
    const first = fetch(url);
    while (limiter.active() === 0) await new Promise(done => setTimeout(done, 1));
    assert.equal((await fetch(url)).status, 503); assert.equal(limiter.active(), 1);
    release(); assert.equal((await first).status, 200); assert.equal(limiter.active(), 0);
    assert.equal((await fetch(url)).status, 200);
  } finally { release(); await new Promise<void>(done => server.close(() => done())); }
});

test('a stalled multipart body without files is cancelled and releases its task slot', async () => {
  const f = await fixture('lumina-stalled-upload-'); const app = express(); const upload = imageUpload(f.directory);
  let active = 0; let completed!: () => void; const completion = new Promise<void>(done => { completed = done; });
  app.post('/upload', async (req, res) => {
    active++;
    try { await receiveMultipart(upload, req, res, 80); if (!res.destroyed) res.json({ ok: true }); }
    catch { /* The cancelled socket deliberately has no response. */ }
    finally { active--; completed(); }
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  const address = server.address(); assert(address && typeof address !== 'string');
  const request = httpRequest(`http://127.0.0.1:${address.port}/upload`, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=stall' } });
  request.on('error', () => undefined);
  try {
    request.write('--stall\r\nContent-Disposition: form-data; name="metadata"\r\n\r\nunfinished');
    await completion;
    assert.equal(active, 0); assert.deepEqual(await readdir(f.directory), []);
    const next = new FormData(); next.append('images', new Blob(['ok']), 'ok.png');
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/upload`, { method: 'POST', body: next })).status, 200);
  } finally { request.destroy(); await new Promise<void>(done => server.close(() => done())); await f.cleanup(); }
});

test('a data directory rejects a second running instance and releases its own lock', async () => {
  const f = await fixture('lumina-instance-resource-');
  try {
    const release = acquireInstanceLock(f.directory);
    assert.throws(() => acquireInstanceLock(f.directory), /已有图库实例/);
    release(); assert.deepEqual(await readdir(f.directory), []);
    const next = acquireInstanceLock(f.directory); next();
  } finally { await f.cleanup(); }
});
