import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import type { Album } from '../shared/types.ts';
import { buildExcelWorkbook, type BackupSnapshot } from './backup.ts';
import { parseExcelImport } from './import-excel.ts';

const headers = ['序号', '标题', '时间', '图片', '网盘链接', '提取码', '解压码'];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-import-excel-'));
  let counter = 0;
  return {
    directory,
    async parse(workbook: ExcelJS.Workbook) {
      const path = join(directory, `input-${counter}.xlsx`);
      const stage = join(directory, `stage-${counter++}`);
      await workbook.xlsx.writeFile(path);
      return parseExcelImport(path, stage);
    },
    async close() { await rm(directory, { recursive: true, force: true }); },
  };
}

function basicSheet(workbook: ExcelJS.Workbook, name = '旅行') {
  const sheet = workbook.addWorksheet(name);
  sheet.addRow(headers);
  return sheet;
}

test('own Excel backup round-trips category mapping, embedded covers, multiple links and Hong Kong times', async () => {
  const context = await fixture();
  try {
    const uploadDir = join(context.directory, 'uploads');
    await mkdir(uploadDir);
    const picture = await sharp({ create: { width: 90, height: 150, channels: 3, background: '#846cb0' } }).png().toBuffer();
    await writeFile(join(uploadDir, 'source.png'), picture);
    const album: Album = {
      id: 'source-id', title: '=HYPERLINK("https://example.com","literal title")', description: 'not in Excel', category: '旅行/山川', tags: ['山川'], favorite: true,
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-06T06:35:17.000Z', localUpdatedAt: '2026-10-07T00:00:00.000Z', updateSource: 'baidu',
      images: [{ id: 'source-image', url: '/uploads/source.png', thumbnailUrl: '/uploads/source.png', name: '原图.png', width: 90, height: 150, size: picture.length }],
      links: [
        { id: 'one', label: '百度网盘', url: 'https://pan.baidu.com/s/test', code: '0007', password: '001234', note: '', syncEnabled: true, status: 'success', message: '', lastCheckedAt: null, nextCheckAt: null, remoteUpdatedAt: '2026-10-06T06:35:17.000Z' },
        { id: 'two', label: '第二个网盘', url: 'https://example.com/archive', code: '0012', password: '=literal-password', note: '', syncEnabled: false, status: 'disabled', message: '', lastCheckedAt: null, nextCheckAt: null, remoteUpdatedAt: null },
      ],
    };
    const snapshot: BackupSnapshot = { format: 'lumina-gallery-backup', version: 1, exportedAt: '2026-10-08T03:05:00.000Z', timeZone: 'Asia/Hong_Kong', albums: [album], categories: ['旅行/山川', '旅行:山川', '说明', '空分类'], settings: { autoSync: true, intervalHours: 24 }, syncLogs: [] };
    const { workbook } = await buildExcelWorkbook(snapshot, uploadDir);
    const imported = await context.parse(workbook);
    assert.equal(imported.format, 'xlsx');
    assert.equal(imported.exportedAt, snapshot.exportedAt);
    assert.deepEqual(imported.categories, snapshot.categories);
    assert.equal(imported.albums.length, 1, 'same sequence rows represent one album, not two');
    const candidate = imported.albums[0];
    assert.equal(candidate.album.title, album.title, 'formula-like literal text stays literal');
    assert.equal(candidate.album.updatedAt, album.updatedAt);
    assert.equal(candidate.album.localUpdatedAt, album.updatedAt);
    assert.equal(candidate.album.updateSource, 'local');
    assert.equal(candidate.album.links.length, 2);
    assert.deepEqual(candidate.album.links.map(link => [link.url, link.code, link.password]), album.links.map(link => [link.url, link.code, link.password]));
    assert(candidate.album.links.every(link => !link.syncEnabled && link.nextCheckAt === null));
    assert.equal(candidate.album.images.length, 1, 'repeated embedded covers are deduplicated');
    assert.equal(candidate.files.length, 2, 'cover and generated thumbnail are staged');
    for (const file of candidate.files) {
      const image = await sharp(await readFile(file.sourcePath)).metadata();
      assert(image.width && image.height);
      assert(candidate.album.images.some(item => [item.url, item.thumbnailUrl].includes(`/uploads/${file.filename}`)));
    }
    assert(imported.warnings.some(warning => /缩略图/.test(warning)));
    const repeated = await context.parse(workbook);
    assert.equal(repeated.albums[0].key, candidate.key, 'identical workbook yields stable duplicate detection key');
    assert.equal(repeated.albums[0].album.id, candidate.album.id);
  } finally { await context.close(); }
});

test('screenshot template imports header 1, explicit Hong Kong text dates, actual hyperlink URL and formatted zeroes', async () => {
  const context = await fixture();
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = basicSheet(workbook, '分类一');
    sheet.getCell('A1').value = 1;
    sheet.addRow([1, '记录', '2026/10/08 01:02:03', 'https://example.com/image.jpg', { text: '点击下载', hyperlink: 'https://pan.baidu.com/s/test' }, 7, '001234']);
    sheet.getCell('F2').numFmt = '0000';
    const imported = await context.parse(workbook);
    assert.equal(imported.albums[0].album.updatedAt, '2026-10-07T17:02:03.000Z');
    assert.equal(imported.albums[0].album.links[0].url, 'https://pan.baidu.com/s/test');
    assert.equal(imported.albums[0].album.links[0].code, '0007');
    assert.equal(imported.albums[0].album.links[0].password, '001234');
    assert.equal(imported.albums[0].album.images.length, 0, 'image text URLs are not fetched');
    assert(imported.warnings.some(warning => /不会下载/.test(warning)));
  } finally { await context.close(); }
});

test('date parsing handles explicit zones and Excel serials without depending on host timezone', async () => {
  const context = await fixture();
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = basicSheet(workbook);
    sheet.addRow([1, 'ISO UTC', '2026-10-08T01:02:03.123Z', '', '', '', '']);
    sheet.addRow([2, 'ISO offset', '2026-10-08T01:02:03+08:00', '', '', '', '']);
    sheet.addRow([3, 'Excel serial', 46_303.5, '', '', '', '']);
    const imported = await context.parse(workbook);
    assert.equal(imported.albums[0].album.updatedAt, '2026-10-08T01:02:03.123Z');
    assert.equal(imported.albums[1].album.updatedAt, '2026-10-07T17:02:03.000Z');
    assert.equal(imported.albums[2].album.updatedAt, new Date((46_303.5 - 25_569) * 86400_000 - 8 * 3600_000).toISOString());
    const workbook1904 = new ExcelJS.Workbook(); workbook1904.properties.date1904 = true;
    basicSheet(workbook1904).addRow([1, '1904 serial', 1, '', '', '', '']);
    const imported1904 = await context.parse(workbook1904);
    assert.equal(imported1904.albums[0].album.updatedAt, '1904-01-01T16:00:00.000Z');
  } finally { await context.close(); }
});

test('missing sequence keeps individual rows separate and missing date gets an explicit warning', async () => {
  const context = await fixture();
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = basicSheet(workbook);
    sheet.getCell('A1').value = '';
    sheet.addRow(['', '相同标题', '', '', '', '', '']);
    sheet.addRow(['', '相同标题', '', '', '', '', '']);
    const imported = await context.parse(workbook);
    assert.equal(imported.albums.length, 2);
    assert.notEqual(imported.albums[0].key, imported.albums[1].key);
    assert(imported.warnings.some(warning => /未填写时间/.test(warning)));
    const repeated = await context.parse(workbook);
    assert.deepEqual(repeated.albums.map(item => item.key), imported.albums.map(item => item.key), 'blank dates do not make repeat imports new albums');
  } finally { await context.close(); }
});

test('invalid dates, inconsistent grouped rows, formula cells and unsafe links fail without trusting cached formula values', async () => {
  const context = await fixture();
  try {
    for (const date of ['2026-02-30 00:00:00', '2026-10-08 24:00:00', '10/08/2026', '2026-10-08T00:00:00+15:00']) {
      const workbook = new ExcelJS.Workbook();
      basicSheet(workbook).addRow([1, '错误时间', date, '', '', '', '']);
      await assert.rejects(context.parse(workbook), /时间/);
    }
    const inconsistent = new ExcelJS.Workbook();
    const sheet = basicSheet(inconsistent);
    sheet.addRow([1, '第一个标题', '2026-10-08', '', '', '', '']);
    sheet.addRow([1, '第二个标题', '2026-10-08', '', '', '', '']);
    await assert.rejects(context.parse(inconsistent), /相同序号/);
    for (const column of [2, 4, 5, 6]) {
      const workbook = new ExcelJS.Workbook();
      const formulaSheet = basicSheet(workbook);
      formulaSheet.addRow([1, '公式', '2026-10-08', '', '', '', '']);
      formulaSheet.getRow(2).getCell(column).value = { formula: 'HYPERLINK("https://example.com","cached")', result: 'https://example.com' };
      await assert.rejects(context.parse(workbook), /不支持公式/);
    }
    const unsafe = new ExcelJS.Workbook();
    basicSheet(unsafe).addRow([1, '错误链接', '2026-10-08', '', { text: 'https://example.com', hyperlink: 'file:///C:/private' }, '', '']);
    await assert.rejects(context.parse(unsafe), /HTTP/);
  } finally { await context.close(); }
});

test('corrupt embedded images fail and multiple distinct images anchored to a record stay together', async () => {
  const context = await fixture();
  try {
    const corrupt = new ExcelJS.Workbook();
    const badSheet = basicSheet(corrupt);
    badSheet.addRow([1, '图片损坏', '2026-10-08', '', '', '', '']);
    const badId = corrupt.addImage({ buffer: Buffer.from('not a png') as unknown as ExcelJS.Buffer, extension: 'png' });
    badSheet.addImage(badId, { tl: { col: 3, row: 1 }, ext: { width: 10, height: 10 } });
    await assert.rejects(context.parse(corrupt), /图片无法解码/);
    const workbook = new ExcelJS.Workbook();
    const sheet = basicSheet(workbook);
    sheet.addRow([1, '两张图片', '2026-10-08', '', '', '', '']);
    for (const background of ['red', 'blue']) {
      const bytes = await sharp({ create: { width: 12, height: 16, channels: 3, background } }).png().toBuffer();
      const id = workbook.addImage({ buffer: bytes as unknown as ExcelJS.Buffer, extension: 'png' });
      sheet.addImage(id, { tl: { col: 3, row: 1 }, ext: { width: 12, height: 16 } });
    }
    const imported = await context.parse(workbook);
    assert.equal(imported.albums[0].album.images.length, 2);
    assert.equal(imported.albums[0].files.length, 4);
  } finally { await context.close(); }
});
