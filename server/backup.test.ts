import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import sharp from 'sharp';
import type { Album, SyncLog } from '../shared/types.ts';
import { GalleryDb } from './db.ts';
import { createApp } from './index.ts';
import { authorizedFetch } from './test-auth.ts';
import { captureBackupSnapshot, createBackupZip, estimateAutomaticBackupSpace, prepareAutomaticBackup } from './backup.ts';

const privateCookie = 'BDUSS=backup-must-never-contain-this-cookie';
const remoteTime = '2026-10-06T06:35:17.000Z';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-backup-'));
  const runtime = await createApp({ dataDir: directory });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const fetch = await authorizedFetch(base);
  const request = (path: string, body: unknown) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return {
    directory, runtime, base, request, fetch,
    async importAlbum() {
      const originals = await Promise.all(['#3e594b', '#947460'].map(background => sharp({
        create: { width: 40, height: 64, channels: 3, background },
      }).png().toBuffer()));
      const body = new FormData();
      body.set('metadata', JSON.stringify({
        title: '=HYPERLINK("https://example.com","原样保留标题")', category: '旅行',
        description: '备份应保留简介、标签和收藏', tags: ['山间', '备份'], favorite: true,
        links: [
          { label: '百度网盘', url: 'https://pan.baidu.com/s/1first', code: '0007', password: '001234', syncEnabled: true },
          { label: '第二个地址', url: 'https://example.com/archive', code: '0012', password: '=password', syncEnabled: false },
        ],
      }));
      originals.forEach((bytes, index) => body.append('images', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), `原图${index + 1}.png`));
      const response = await fetch(`${base}/api/albums`, { method: 'POST', body });
      assert.equal(response.status, 201);
      const album = await response.json() as Album;
      album.localUpdatedAt = '2026-10-07T00:00:00.000Z';
      album.links[0].remoteUpdatedAt = remoteTime;
      album.links[0].lastCheckedAt = '2026-10-07T01:00:00.000Z';
      album.links[0].nextCheckAt = '2026-10-08T01:00:00.000Z';
      album.links[0].status = 'success';
      runtime.db.save(album);
      runtime.db.updateSettings({ baiduCookie: privateCookie, autoSync: false });
      return { album: runtime.db.requireAlbum(album.id), originals };
    },
    async exportBackup(format: 'xlsx' | 'zip') {
      const response = await request('/api/backups', { format });
      assert.equal(response.status, 201, await response.clone().text());
      const metadata = await response.json() as { downloadUrl: string; filename: string; size: number; warnings: string[] };
      assert(metadata.downloadUrl.startsWith('/api/backups/'));
      assert(metadata.filename.endsWith(`.${format}`));
      const download = await fetch(`${base}${metadata.downloadUrl}`);
      assert.equal(download.status, 200);
      assert.match(download.headers.get('content-disposition') ?? '', /attachment/);
      const bytes = Buffer.from(await download.arrayBuffer());
      assert.equal(bytes.length, metadata.size);
      assert(bytes.length > 0);
      return { metadata, bytes };
    },
    async close() {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function readWorkbook(bytes: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
  return workbook;
}

test('Excel backup contains embedded cover, Hong Kong content time and separate links with literal text codes', async () => {
  const context = await fixture();
  try {
    const { album } = await context.importAlbum();
    const before = context.runtime.db.albums();
    const { metadata, bytes } = await context.exportBackup('xlsx');
    assert.deepEqual(metadata.warnings, []);
    const workbook = await readWorkbook(bytes);
    const sheet = workbook.getWorksheet('旅行'); assert(sheet);
    assert.deepEqual(Array.from({ length: 7 }, (_, index) => sheet.getRow(1).getCell(index + 1).value), ['序号', '标题', '时间', '图片', '网盘链接', '提取码', '解压码']);
    assert.equal(sheet.getCell('A2').value, 1);
    assert.equal(sheet.getCell('B2').value, album.title, 'formula-like title must remain text');
    assert.equal(sheet.getCell('B2').type, ExcelJS.ValueType.String);
    const date = sheet.getCell('C2').value;
    assert(date instanceof Date, 'Excel time must be a sortable date, not a text string');
    assert.equal(date.toISOString(), '2026-10-06T14:35:17.000Z', 'Excel shows Hong Kong time and the remote content timestamp');
    assert.match(sheet.getCell('C2').numFmt, /yyyy.*mm.*dd/i);
    assert.equal(sheet.getCell('E2').hyperlink, album.links[0].url);
    assert.equal(sheet.getCell('E3').hyperlink, album.links[1].url);
    assert.equal(sheet.getCell('F2').value, '0007');
    assert.equal(sheet.getCell('F3').value, '0012');
    assert.equal(sheet.getCell('G2').value, '001234');
    assert.equal(sheet.getCell('G3').value, '=password');
    assert.equal(sheet.getCell('G3').type, ExcelJS.ValueType.String);
    assert(sheet.getImages().length > 0, 'the album cover is visible in the workbook');
    assert.equal(sheet.getImages()[0].range.tl.nativeCol, 3, 'the cover is anchored in the 图片 column');
    const image = workbook.getImage(Number(sheet.getImages()[0].imageId));
    assert(image.buffer, 'cover bytes are embedded, independent of the local server');
    const embedded = await sharp(Buffer.from(image.buffer)).metadata();
    assert(embedded.width && embedded.height);
    const archive = await JSZip.loadAsync(bytes);
    for (const entry of Object.values(archive.files).filter(entry => /\.xml$/.test(entry.name))) {
      const xml = await entry.async('string');
      assert(!xml.includes(privateCookie));
      assert(!/<f(?:\s|>)/.test(xml), 'untrusted titles and passwords do not become Excel formulas');
    }
    assert.deepEqual(context.runtime.db.albums(), before, 'export does not change gallery timestamps or schedules');
    assert.equal(context.runtime.db.value('baiduCookie'), privateCookie);
  } finally { await context.close(); }
});

test('Excel exports empty categories and gives invalid, long and case-colliding names unique valid sheet names', async () => {
  const context = await fixture();
  try {
    const custom = ['拍摄/旅行', '拍摄:旅行', 'Photo', 'photo', `${'长'.repeat(40)}甲`, `${'长'.repeat(40)}乙`, "'引号分类'", `${'a'.repeat(30)}'b`, `${'a'.repeat(30)}🦊边界`, '说明'];
    for (const name of custom) context.runtime.db.createCategory(name);
    const categories = context.runtime.db.categories();
    const { bytes } = await context.exportBackup('xlsx');
    const workbook = await readWorkbook(bytes);
    assert.equal(workbook.worksheets.length, categories.length + 1, 'every empty category and an explanation sheet is exported');
    const names = workbook.worksheets.map(sheet => sheet.name);
    assert.equal(new Set(names.map(name => name.toLowerCase())).size, names.length);
    for (const sheet of workbook.worksheets) {
      assert(sheet.name.length > 0 && sheet.name.length <= 31);
      assert(!/[\\/*?:\[\]]/.test(sheet.name));
      assert(!sheet.name.startsWith("'") && !sheet.name.endsWith("'"));
      assert.equal(Buffer.from(sheet.name, 'utf8').toString('utf8'), sheet.name, 'truncation does not split an emoji surrogate pair');
    }
    const categorySheets = workbook.worksheets.filter(sheet => sheet.getCell('A1').value === '序号');
    assert.equal(categorySheets.length, categories.length);
    assert(categorySheets.every(sheet => sheet.actualRowCount === 1), 'empty categories remain usable header-only tabs');
    const explanation = workbook.worksheets.find(sheet => !categorySheets.includes(sheet)); assert(explanation);
    const text = JSON.stringify(explanation.getSheetValues());
    for (const category of categories) assert(text.includes(category), `explanation keeps the full category name: ${category}`);
  } finally { await context.close(); }
});

test('complete ZIP restores a standalone database and every original image without exposing login Cookie', async () => {
  const context = await fixture();
  const restoredDirectory = await mkdtemp(join(tmpdir(), 'lumina-backup-restore-'));
  let restored: GalleryDb | undefined;
  try {
    const { album, originals } = await context.importAlbum();
    context.runtime.db.createCategory('空分类也保留');
    const history: SyncLog[] = Array.from({ length: 121 }, (_, index) => ({
      id: `backup-log-${index}`, albumId: album.id, albumTitle: album.title, linkLabel: '百度网盘',
      checkedAt: new Date(Date.parse(album.links[0].lastCheckedAt!) + index * 1000).toISOString(),
      status: 'success', message: '已完成检查', remoteUpdatedAt: remoteTime, changed: false,
    }));
    history.forEach(log => context.runtime.db.log(log));
    const originalAlbums = context.runtime.db.albums();
    const originalCategories = context.runtime.db.categories();
    const originalLogs = context.runtime.db.logs();
    const { metadata, bytes } = await context.exportBackup('zip');
    assert.deepEqual(metadata.warnings, []);
    const archive = await JSZip.loadAsync(bytes);
    const dbEntry = archive.file('data/gallery.db'); assert(dbEntry);
    const workbookEntry = archive.file('图集清单.xlsx'); assert(workbookEntry);
    const manifestEntry = archive.file('manifest.json'); assert(manifestEntry);
    const instructionsEntry = archive.file('恢复说明.txt'); assert(instructionsEntry);
    assert(!Object.keys(archive.files).some(name => /gallery\.db-(wal|shm)$/.test(name)), 'database is a self-contained snapshot');
    const manifest = JSON.parse(await manifestEntry.async('string'));
    assert.equal(manifest.format, 'lumina-gallery-backup');
    assert.equal(manifest.version, 1);
    assert.equal(manifest.timeZone, 'Asia/Hong_Kong');
    assert.deepEqual(manifest.albums, originalAlbums);
    assert.deepEqual(manifest.categories, originalCategories);
    assert.deepEqual(manifest.settings, { autoSync: false, intervalHours: 24 });
    assert.deepEqual(manifest.syncLogs, [...history].reverse(), 'backup retains history beyond the 100-row UI limit');
    const instructions = await instructionsEntry.async('string');
    assert.match(instructions, /停止|关闭/);
    assert.match(instructions, /Cookie/i);
    for (const entry of Object.values(archive.files).filter(entry => !entry.dir)) {
      const content = await entry.async('nodebuffer');
      assert(!content.includes(Buffer.from(privateCookie)), `private Cookie leaked in ${entry.name}`);
    }
    const dbBytes = await dbEntry.async('nodebuffer');
    await writeFile(join(restoredDirectory, 'gallery.db'), dbBytes);
    restored = new GalleryDb(restoredDirectory);
    assert.equal(restored.value('baiduCookie'), undefined);
    assert.equal(restored.settings().autoSync, false);
    assert.deepEqual(restored.albums(), originalAlbums);
    assert.deepEqual(restored.categories(), originalCategories);
    assert.deepEqual(restored.logs(), originalLogs);
    assert.equal(restored.connection.prepare('SELECT COUNT(*) AS count FROM sync_logs').get()?.count, history.length);
    for (const [index, image] of restored.requireAlbum(album.id).images.entries()) {
      const original = archive.file(`data${image.url}`); assert(original);
      assert.deepEqual(await original.async('nodebuffer'), originals[index], 'original image bytes are not recompressed');
      const thumbnail = archive.file(`data${image.thumbnailUrl}`); assert(thumbnail);
      assert.deepEqual(await thumbnail.async('nodebuffer'), await readFile(join(context.directory, 'uploads', basename(image.thumbnailUrl))));
    }
    const workbook = await readWorkbook(await workbookEntry.async('nodebuffer'));
    assert.equal(workbook.getWorksheet('旅行')?.getCell('B2').value, album.title);
    assert.deepEqual(context.runtime.db.albums(), originalAlbums);
    assert.deepEqual(context.runtime.db.logs(), originalLogs);
    assert.equal(context.runtime.db.value('baiduCookie'), privateCookie, 'redacting the backup must not remove the live login');
  } finally { restored?.close(); await context.close(); await rm(restoredDirectory, { recursive: true, force: true }); }
});

test('complete backup fails instead of returning a partial archive when an original image is missing', async () => {
  const context = await fixture();
  try {
    const { album } = await context.importAlbum();
    await unlink(join(context.directory, 'uploads', basename(album.images[1].url)));
    const response = await context.request('/api/backups', { format: 'zip' });
    assert.equal(response.status, 409);
    const error = await response.json() as { error: string; downloadUrl?: string };
    assert(error.error.length > 0);
    assert.equal(error.downloadUrl, undefined);
    assert.deepEqual(context.runtime.db.requireAlbum(album.id), album);
    const { bytes } = await context.exportBackup('xlsx');
    assert((await readWorkbook(bytes)).getWorksheet('旅行')?.getImages().length, 'cover-and-metadata Excel can still be exported');
  } finally { await context.close(); }
});

test('empty libraries produce restorable ZIPs and missing covers are clearly marked in Excel', async () => {
  const context = await fixture();
  try {
    const empty = await context.exportBackup('zip');
    const archive = await JSZip.loadAsync(empty.bytes);
    assert(archive.files['data/uploads/']?.dir, 'an empty backup includes the uploads directory required by restore instructions');
    assert(archive.file('data/gallery.db'));
    const manifestFile = archive.file('manifest.json'); assert(manifestFile);
    assert.deepEqual(JSON.parse(await manifestFile.async('string')).albums, []);
    const { album } = await context.importAlbum();
    const cover = album.images[0];
    await Promise.all([cover.url, cover.thumbnailUrl].map(url => unlink(join(context.directory, 'uploads', basename(url)))));
    const { metadata, bytes } = await context.exportBackup('xlsx');
    assert(metadata.warnings.some(warning => warning.includes(album.title)), 'the download reports the missing cover');
    const sheet = (await readWorkbook(bytes)).getWorksheet('旅行'); assert(sheet);
    assert.equal(sheet.getCell('D2').value, '封面缺失');
    assert.equal(sheet.getCell('B2').value, album.title);
    assert.equal(sheet.getCell('E2').hyperlink, album.links[0].url);
    assert.equal(sheet.getCell('F2').value, '0007');
  } finally { await context.close(); }
});

test('backup rejects unknown formats and missing downloads through the normal API boundary', async () => {
  const context = await fixture();
  try {
    for (const body of [{ format: 'csv' }, { format: '../gallery.db' }, {}, null]) {
      const response = await context.request('/api/backups', body);
      assert.equal(response.status, 400);
      assert((await response.json() as { error: string }).error);
    }
    assert.equal((await context.fetch(`${context.base}/api/backups/not-an-export/download`)).status, 404);
    const crossSite = await context.fetch(`${context.base}/api/backups`, { method: 'POST', headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ format: 'zip' }) });
    assert.equal(crossSite.status, 403);
  } finally { await context.close(); }
});

test('repeated exports retain only three downloadable files and evict the oldest unused cache', async () => {
  const context = await fixture();
  try {
    const downloads: string[] = [];
    for (let index = 0; index < 5; index++) {
      const response = await context.request('/api/backups', { format: 'xlsx' });
      assert.equal(response.status, 201);
      downloads.push((await response.json() as { downloadUrl: string }).downloadUrl);
      assert((await readdir(join(context.directory, '.exports'))).length <= 3);
    }
    assert.equal((await context.fetch(context.base + downloads[0])).status, 404);
    assert.equal((await context.fetch(context.base + downloads[1])).status, 404);
    for (const path of downloads.slice(-3)) {
      const response = await context.fetch(context.base + path);
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    }
  } finally { await context.close(); }
});

test('restart removes abandoned owned export caches immediately and preserves unrelated directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-backup-recovery-'));
  const root = join(directory, '.exports');
  const abandoned = join(root, 'backup-00000000-0000-4000-8000-000000000000');
  const unrelated = join(root, 'backup-11111111-1111-4111-8111-111111111111');
  await mkdir(abandoned, { recursive: true }); await mkdir(unrelated);
  await writeFile(join(abandoned, '.lumina-export.json'), JSON.stringify({ format: 'lumina-gallery-export-temp', createdAt: Date.now() }));
  await writeFile(join(abandoned, 'partial.zip'), 'interrupted export');
  await writeFile(join(unrelated, 'keep.txt'), 'not an application cache');
  const runtime = await createApp({ dataDir: directory });
  try { assert.deepEqual(await readdir(root), [basename(unrelated)]); }
  finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test('ZIP streaming stops before writing beyond its remaining temporary-space budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-backup-quota-'));
  try {
    const source = join(directory, 'source.bin'), output = join(directory, 'limited.zip');
    await writeFile(source, randomBytes(256 * 1024));
    await assert.rejects(createBackupZip(output, [{ name: 'source.bin', path: source }], undefined, 1024), /临时空间已达到上限/);
    assert((await stat(output)).size <= 1024, 'the chunk crossing the cap is not written');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('automatic ZIP contains the same restorable gallery snapshot and no account or SMTP secrets', async () => {
  const context = await fixture();
  const stage = join(context.directory, 'automatic-stage');
  try {
    const { album, originals } = await context.importAlbum();
    await mkdir(stage);
    const plan = await prepareAutomaticBackup(context.runtime.db, join(context.directory, 'uploads'));
    const result = await plan.write(stage);
    assert.equal(result.path, join(stage, '完整备份.zip'));
    assert(result.size > 0 && result.size < plan.estimatedBytes);
    assert.deepEqual(await readdir(stage), ['完整备份.zip'], 'intermediate copies have been removed');
    const archive = await JSZip.loadAsync(await readFile(result.path), { checkCRC32: true });
    const manifest = JSON.parse(await archive.file('manifest.json')!.async('string'));
    assert.deepEqual(manifest.albums, context.runtime.db.albums());
    assert.equal(manifest.settings.baiduCookie, undefined);
    assert.deepEqual(await archive.file(`data${album.images[0].url}`)!.async('nodebuffer'), originals[0]);
    const snapshotDb = join(context.directory, 'restored.db');
    await writeFile(snapshotDb, await archive.file('data/gallery.db')!.async('nodebuffer'));
    const { DatabaseSync } = await import('node:sqlite');
    const restored = new DatabaseSync(snapshotDb, { readOnly: true });
    try {
      const tables = restored.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
      assert.deepEqual(tables, ['albums', 'categories', 'settings', 'sync_logs']);
      assert.equal(restored.prepare('SELECT value FROM settings WHERE key=?').get('baiduCookie'), undefined);
    } finally { restored.close(); }
    await assert.rejects(plan.write(stage), /已使用或释放/);
  } finally { await context.close(); }
});

test('automatic planning reserves workspace and worst-case compression and rejects oversize before writing', async () => {
  const context = await fixture();
  try {
    const snapshot = captureBackupSnapshot(context.runtime.db);
    const originalBytes = 1024 ** 3;
    const estimate = estimateAutomaticBackupSpace(snapshot, [originalBytes]);
    assert(estimate.zipBytes > originalBytes + estimate.workspaceBytes);
    assert.equal(estimate.estimatedBytes, estimate.zipBytes + estimate.workspaceBytes);
    assert.throws(() => estimateAutomaticBackupSpace(snapshot, [8 * 1024 ** 3]), /超过 8 GB/);
    const plan = await prepareAutomaticBackup(context.runtime.db, join(context.directory, 'uploads'));
    plan.release();
    await assert.rejects(plan.write(join(context.directory, 'not-created')), /已使用或释放/);
    assert(!(await readdir(context.directory)).includes('not-created'));
  } finally { await context.close(); }
});

test('automatic backup fails safely when a source disappears after planning', async () => {
  const context = await fixture();
  const stage = join(context.directory, 'automatic-stage');
  try {
    const { album } = await context.importAlbum();
    await mkdir(stage);
    await writeFile(join(stage, 'keep.txt'), 'not owned by the writer');
    const plan = await prepareAutomaticBackup(context.runtime.db, join(context.directory, 'uploads'));
    await unlink(join(context.directory, 'uploads', basename(album.images[1].url)));
    await assert.rejects(plan.write(stage), /生成失败|发生变化/);
    assert.deepEqual(await readdir(stage), ['keep.txt']);
    assert.deepEqual(context.runtime.db.requireAlbum(album.id), album);
    await context.exportBackup('xlsx'); // The failure released the shared writer slot.
  } finally { await context.close(); }
});

test('automatic and manual writers share a non-queued slot and cancellation releases it', async () => {
  const context = await fixture();
  const stage = join(context.directory, 'automatic-stage');
  try {
    const { album } = await context.importAlbum();
    for (let index = 0; index < 100; index++) context.runtime.db.save({ ...album, id: `copy-${index}` });
    await mkdir(stage);
    const plan = await prepareAutomaticBackup(context.runtime.db, join(context.directory, 'uploads'));
    await assert.rejects(prepareAutomaticBackup(context.runtime.db, join(context.directory, 'uploads')), /正在准备其他备份/);
    const controller = new AbortController();
    const writing = plan.write(stage, controller.signal);
    const failed = assert.rejects(writing);
    const manual = await context.request('/api/backups', { format: 'xlsx' });
    assert.equal(manual.status, 409);
    controller.abort();
    await failed;
    assert.deepEqual(await readdir(stage), []);
    context.runtime.db.connection.prepare("DELETE FROM albums WHERE id LIKE 'copy-%'").run();
    await context.exportBackup('xlsx');
  } finally { await context.close(); }
});

test('planning reserves the shared writer slot and releasing an old plan cannot unlock a newer owner', async () => {
  const context = await fixture();
  try {
    const first = await prepareAutomaticBackup(context.runtime.db, join(context.directory, 'uploads'));
    assert.equal((await context.request('/api/backups', { format: 'xlsx' })).status, 409);
    first.release();
    const next = await prepareAutomaticBackup(context.runtime.db, join(context.directory, 'uploads'));
    first.release();
    assert.equal((await context.request('/api/backups', { format: 'xlsx' })).status, 409);
    next.release();
    await context.exportBackup('xlsx');
  } finally { await context.close(); }
});
