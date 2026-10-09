import type { Express } from 'express';
import ExcelJS from 'exceljs';
import archiver from 'archiver';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Transform } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { Album, SyncLog } from '../shared/types.ts';
import { ApiError, GalleryDb } from './db.ts';
import { assertDiskSpace } from './resource-limits.ts';
import { reportRuntimeError } from './runtime-log.ts';
import { openValidatedArchive } from './import-archive.ts';

const EXPORT_TTL_MS = 60 * 60 * 1000;
const MAX_PREPARED_EXPORTS = 3;
const MAX_EXPORT_BYTES = 8 * 1024 ** 3;
const MAX_ACTIVE_DOWNLOADS = 4;
const MARKER_NAME = '.lumina-export.json';
const EXPORT_DIRECTORY = /^backup-[a-f0-9-]{36}$/;
const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const COLUMNS = ['序号', '标题', '时间', '图片', '网盘链接', '提取码', '解压码'];

// Manual exports and scheduled backups share one admission slot per data directory.
// The set holds no snapshots and entries disappear in the owner's finally block.
const activeWriters = new Set<string>();
function acquireBackupWriter(directory: string): () => void {
  const key = process.platform === 'win32' ? resolve(directory).toLowerCase() : resolve(directory);
  if (activeWriters.has(key)) throw new ApiError(409, '正在准备其他备份，请完成后再试');
  activeWriters.add(key);
  let released = false;
  return () => { if (!released) { released = true; activeWriters.delete(key); } };
}

export interface BackupSnapshot {
  format: 'lumina-gallery-backup';
  version: 1;
  exportedAt: string;
  timeZone: 'Asia/Hong_Kong';
  albums: Album[];
  categories: string[];
  settings: { autoSync: boolean; intervalHours: 24 };
  syncLogs: SyncLog[];
}

/** All reads finish within one SQLite snapshot, before any asynchronous image work. */
export function captureBackupSnapshot(db: GalleryDb): BackupSnapshot {
  db.connection.exec('SAVEPOINT gallery_backup_snapshot');
  try {
    const snapshot: BackupSnapshot = {
      format: 'lumina-gallery-backup', version: 1,
      exportedAt: new Date().toISOString(), timeZone: 'Asia/Hong_Kong',
      albums: db.albums(), categories: db.categories(),
      settings: { autoSync: db.settings().autoSync, intervalHours: 24 },
      syncLogs: db.connection.prepare('SELECT body FROM sync_logs ORDER BY checked_at DESC, rowid DESC').all()
        .map(row => JSON.parse(row.body as string) as SyncLog),
    };
    db.connection.exec('RELEASE SAVEPOINT gallery_backup_snapshot');
    return snapshot;
  } catch (error) {
    db.connection.exec('ROLLBACK TO SAVEPOINT gallery_backup_snapshot; RELEASE SAVEPOINT gallery_backup_snapshot');
    throw error;
  }
}

function uploadFilename(url: string): string {
  // Do not resolve arbitrary database paths, URLs, percent escapes or subdirectories.
  if (typeof url !== 'string' || !/^\/uploads\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,200}\.(?:jpe?g|png|webp|gif|avif)$/.test(url)) {
    throw new ApiError(409, '备份中存在无效的图片路径，请检查图集图片后重试');
  }
  return url.slice('/uploads/'.length);
}

async function existingUpload(uploadsDir: string, url: string): Promise<{ name: string; path: string }> {
  const name = uploadFilename(url);
  const root = await realpath(uploadsDir);
  const path = join(root, name);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || dirname(await realpath(path)) !== root) {
    throw new ApiError(409, '备份中存在无效的图片文件，请检查图集图片后重试');
  }
  return { name, path };
}

function worksheetName(category: string, used: Set<string>): string {
  // Excel also rejects leading/trailing apostrophes and the reserved History name.
  let base = category.replace(/[\\/*?:\[\]\u0000-\u001f\u007f-\u009f]/g, '_').replace(/^'+|'+$/g, '').trim() || '未命名分类';
  if (base.toLowerCase() === 'history') base = `${base}_`;
  const truncate = (value: string, length: number) => value.slice(0, length).replace(/[\ud800-\udbff]$/, '').replace(/^'+|'+$/g, '') || '分类';
  let name = truncate(base, 31);
  let suffix = 2;
  while (used.has(name.toLowerCase())) {
    const ending = ` (${suffix++})`;
    name = `${truncate(base, 31 - ending.length)}${ending}`;
  }
  used.add(name.toLowerCase());
  return name;
}

function safeHyperlink(value: string): boolean {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}

function styleHeader(sheet: ExcelJS.Worksheet) {
  const header = sheet.getRow(1);
  header.height = 30;
  header.font = { name: '微软雅黑', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
  header.alignment = { vertical: 'middle', horizontal: 'center' };
  header.eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5750A3' } }; });
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
}

export async function buildExcelWorkbook(snapshot: BackupSnapshot, uploadsDir: string, signal?: AbortSignal): Promise<{ workbook: ExcelJS.Workbook; warnings: string[] }> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '拾光图集';
  workbook.created = new Date(snapshot.exportedAt);
  workbook.modified = new Date(snapshot.exportedAt);
  const warnings: string[] = [];
  const used = new Set(['说明']);
  const categories = [...new Set([...snapshot.categories, ...snapshot.albums.map(album => album.category)])];
  const categorySheets: [string, string][] = [];
  for (const category of categories) {
    signal?.throwIfAborted();
    const name = worksheetName(category, used);
    categorySheets.push([category, name]);
    const sheet = workbook.addWorksheet(name);
    sheet.columns = COLUMNS.map((header, index) => ({ header, width: [8, 42, 24, 25, 55, 16, 25][index] }));
    sheet.getColumn(6).numFmt = '@';
    sheet.getColumn(7).numFmt = '@';
    styleHeader(sheet);
    let albumNumber = 0;
    for (const album of snapshot.albums.filter(item => item.category === category)) {
      signal?.throwIfAborted();
      albumNumber++;
      let cover: { id: number; width: number; height: number } | undefined;
      const image = album.images[0];
      if (image) {
        // Covers are small embedded JPEGs; original files remain untouched in the ZIP.
        for (const url of [...new Set([image.thumbnailUrl, image.url])]) {
          try {
            const file = await existingUpload(uploadsDir, url);
            // Reading one cover at a time avoids libvips retaining a Windows file handle.
            const decoder = sharp(await readFile(file.path), { limitInputPixels: 100_000_000, animated: false, failOn: 'error' }).timeout({ seconds: 30 });
            try {
              const result = await decoder.rotate().resize({ width: 160, height: 106, fit: 'inside', withoutEnlargement: true })
                .flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
              cover = { id: workbook.addImage({ buffer: result.data as unknown as ExcelJS.Buffer, extension: 'jpeg' }), width: result.info.width, height: result.info.height };
            } finally { decoder.destroy(); }
            break;
          } catch { /* Try the original if the generated thumbnail is unavailable. */ }
        }
        if (!cover) warnings.push(`图集「${album.title}」的封面缺失或无法读取，Excel 已标记并保留图集资料，请检查图片文件。`);
      }
      const instant = Date.parse(album.updatedAt);
      const validTime = Number.isFinite(instant);
      if (!validTime) warnings.push(`图集「${album.title}」的更新时间无效，Excel 保留了原始文本。`);
      for (const link of album.links.length ? album.links : [undefined]) {
        if (sheet.rowCount >= 1_048_576) throw new ApiError(400, `分类「${category}」的记录超过 Excel 工作表上限，请拆分分类后导出`);
        const row = sheet.addRow([
          albumNumber, album.title,
          validTime ? new Date(instant + 8 * 60 * 60 * 1000) : album.updatedAt,
          cover ? '' : image ? '封面缺失' : '无图片',
          link?.url ?? '', link?.code ?? '', link?.password ?? '',
        ]);
        row.height = 88;
        row.font = { name: '微软雅黑', size: 12, color: { argb: 'FF333344' } };
        row.alignment = { vertical: 'middle', wrapText: true };
        row.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };
        row.getCell(3).numFmt = 'yyyy-mm-dd hh:mm:ss';
        row.getCell(6).numFmt = '@';
        row.getCell(7).numFmt = '@';
        row.eachCell({ includeEmpty: true }, cell => {
          cell.border = { bottom: { style: 'hair', color: { argb: 'FFE4E1ED' } } };
          if (albumNumber % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F3FA' } };
        });
        if (link && safeHyperlink(link.url)) {
          row.getCell(5).value = { text: link.url, hyperlink: link.url };
          row.getCell(5).font = { name: '微软雅黑', size: 12, color: { argb: 'FF365BBC' }, underline: true };
        }
        if (cover) sheet.addImage(cover.id, { tl: { col: 3.12, row: row.number - 1 + 0.04 }, ext: { width: cover.width, height: cover.height }, editAs: 'oneCell' });
      }
    }
    sheet.autoFilter = { from: 'A1', to: `G${Math.max(1, sheet.rowCount)}` };
    sheet.pageSetup.printTitlesRow = '1:1';
  }
  const notes = workbook.addWorksheet('说明');
  notes.columns = [{ header: '项目', width: 34 }, { header: '说明', width: 110 }];
  styleHeader(notes);
  notes.addRows([
    ['导出时间', new Date(Date.parse(snapshot.exportedAt) + 8 * 60 * 60 * 1000)],
    ['时间时区', 'Asia/Hong_Kong（UTC+8）；时间列为图集当前显示的更新时间。'],
    ['表格结构', '每个分类一个工作表；每个图集 / 网盘链接一行，多链接会重复序号、标题、时间与封面。'],
    ['图片', '图片列内嵌图集第一张图片的缩略图。其余原图请使用完整 ZIP 备份保存。'],
    ['完整恢复', 'Excel 用于查看清单；恢复图集、全部原图和设置，请使用完整 ZIP 备份，并阅读其中的恢复说明。'],
    ['登录信息', '所有备份均不包含百度登录 Cookie；恢复后如需登录，请在同步设置中重新填写。'],
    ['分类原名', '对应的 Excel 工作表名称（特殊字符替换，过长或重名时缩短并加序号）'],
    ...categorySheets,
    ...warnings.map(warning => ['导出提醒', warning]),
  ]);
  notes.getCell('B2').numFmt = 'yyyy-mm-dd hh:mm:ss';
  notes.eachRow((row, index) => {
    if (index === 1) return;
    row.height = 34;
    row.font = { name: '微软雅黑', size: 12 };
    row.alignment = { vertical: 'middle', wrapText: true };
  });
  return { workbook, warnings };
}

function writeSnapshotDatabase(snapshot: BackupSnapshot, path: string): void {
  const target = new DatabaseSync(path);
  try {
    target.exec(`PRAGMA journal_mode=DELETE;
      CREATE TABLE albums (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE categories (name TEXT NOT NULL UNIQUE);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sync_logs (id TEXT PRIMARY KEY, checked_at TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX sync_logs_checked_at ON sync_logs(checked_at DESC);
      BEGIN;`);
    const albumInsert = target.prepare('INSERT INTO albums(id,body) VALUES(?,?)');
    for (const album of snapshot.albums) albumInsert.run(album.id, JSON.stringify(album));
    const categoryInsert = target.prepare('INSERT INTO categories(name) VALUES(?)');
    for (const category of snapshot.categories) categoryInsert.run(category);
    const settingsInsert = target.prepare('INSERT INTO settings(key,value) VALUES(?,?)');
    settingsInsert.run('categoriesInitialized', 'true');
    settingsInsert.run('autoSync', String(snapshot.settings.autoSync));
    const logInsert = target.prepare('INSERT INTO sync_logs(id,checked_at,body) VALUES(?,?,?)');
    for (const log of [...snapshot.syncLogs].reverse()) logInsert.run(log.id, log.checkedAt, JSON.stringify(log));
    target.exec('COMMIT');
  } finally { target.close(); }
}

async function collectOriginalFiles(snapshot: BackupSnapshot, uploadsDir: string, signal?: AbortSignal): Promise<{ name: string; path: string }[]> {
  const files = new Map<string, { name: string; path: string }>();
  for (const album of snapshot.albums) {
    for (const image of album.images) {
      for (const url of [image.url, image.thumbnailUrl]) {
        signal?.throwIfAborted();
        try {
          const file = await existingUpload(uploadsDir, url);
          files.set(file.name, file);
        } catch {
          throw new ApiError(409, `图集「${album.title}」的图片「${image.name}」缺失、路径无效或无法读取，完整备份未生成。请检查图片后重试。`);
        }
      }
    }
  }
  return [...files.values()];
}

export async function createBackupZip(destination: string, files: { name: string; path: string }[], signal?: AbortSignal, maxBytes = MAX_EXPORT_BYTES): Promise<void> {
  signal?.throwIfAborted();
  if (maxBytes <= 0) throw new ApiError(413, '备份临时空间已达到上限，请下载完成后重试');
  await new Promise<void>((resolvePromise, reject) => {
    const output = createWriteStream(destination, { flags: 'wx' });
    const archive = archiver('zip', { zlib: { level: 5 } });
    let bytes = 0;
    const limiter = new Transform({ transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      done(bytes > maxBytes ? new ApiError(413, '备份临时空间已达到上限，请拆分图库或下载完成后重试') : null, bytes > maxBytes ? undefined : chunk);
    } });
    let failure: Error | undefined;
    const abort = () => fail(new ApiError(400, '备份请求已取消'));
    const fail = (error: Error) => {
      if (failure) return;
      failure = error;
      signal?.removeEventListener('abort', abort);
      archive.abort();
      limiter.destroy();
      output.destroy();
    };
    output.on('error', fail);
    limiter.on('error', fail);
    archive.on('error', fail);
    // Archiver reports a disappeared source as a warning; an incomplete backup is a failure.
    archive.on('warning', fail);
    signal?.addEventListener('abort', abort, { once: true });
    // Wait for the file descriptor to close before callers remove a partial ZIP.
    output.on('close', () => { signal?.removeEventListener('abort', abort); failure ? reject(failure) : resolvePromise(); });
    archive.pipe(limiter).pipe(output);
    // Preserve the upload directory even when the library contains no images.
    archive.append(Buffer.alloc(0), { name: 'data/uploads/' });
    for (const file of files) archive.file(file.path, { name: file.name });
    void archive.finalize().catch(fail);
    if (signal?.aborted) abort();
  });
}

const RESTORE_INSTRUCTIONS = `拾光图集完整备份恢复说明\r\n\r\n1. 完全关闭拾光图集服务（运行窗口按 Ctrl+C；Docker 部署先停止容器）。\r\n2. 将本 ZIP 解压到一个新文件夹。图集清单.xlsx 可直接用 Excel 查看，各分类独立成表。\r\n3. 找到软件当前的数据目录（默认是软件目录下的 data；自定义 DATA_DIR 或 Docker 请使用对应的数据目录）。\r\n4. 先将现有数据目录整体改名保留，例如 data-before-restore。不要直接把备份覆盖合并到旧目录，避免旧 SQLite 的 -wal、-shm 文件影响恢复。\r\n5. 将 ZIP 内整个 data 文件夹复制为软件的数据目录，确认其中有 gallery.db 和 uploads 文件夹。自定义数据目录时，将备份 data 内的内容放入该目录。\r\n6. 重新启动软件并检查图集和图片。自动同步设置已保留，服务启动后可能检查到期的网盘链接。\r\n7. 备份不包含百度登录 Cookie；需要登录的链接请在同步设置中重新填写。\r\n\r\n备份内容：图集资料、分类、收藏、标签、所有网盘链接和密码、原始时间与同步状态、自动同步设置、同步日志以及全部已引用原图和缩略图。\r\nmanifest.json 是相同数据快照的可读副本，原始时间保留 ISO 格式；Excel 时间使用香港时间（UTC+8）。\r\nExcel 中只嵌入封面缩略图，完整原图保存在 data/uploads 中。备份不会下载网盘中的资源文件。\r\n`;

interface PreparedBackup {
  directory: string; path: string; filename: string; size: number;
  mime: string; expiresAt: number; activeDownloads: number; warnings: string[];
}

export interface AutomaticBackupPlan {
  /** Peak additional space: intermediate files plus a worst-case ZIP. */
  estimatedBytes: number;
  write(directory: string, signal?: AbortSignal): Promise<{ path: string; filename: string; size: number }>;
  /** Discard a plan when an insufficient-space decision postpones writing. */
  release(): void;
}

interface BackupSource { name: string; path: string; size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number; }

export function estimateAutomaticBackupSpace(snapshot: BackupSnapshot, fileSizes: number[]): { workspaceBytes: number; zipBytes: number; estimatedBytes: number } {
  if (fileSizes.some(size => !Number.isSafeInteger(size) || size < 0)) throw new ApiError(409, '备份图片大小无效');
  const manifestBytes = Buffer.byteLength(JSON.stringify(snapshot, null, 2));
  // Allow XML escaping, repeated link rows, JPEG covers and SQLite page/index overhead.
  // These are conservative disk bounds, not an assumption that photos will compress.
  let excelBytes = 1024 ** 2 + snapshot.categories.length * 32 * 1024;
  for (const album of snapshot.albums) {
    const rows = Math.max(1, album.links.length);
    const textBytes = Buffer.byteLength(album.title + album.updatedAt) * rows +
      album.links.reduce((sum, link) => sum + Buffer.byteLength(link.url + link.code + link.password), 0);
    excelBytes += rows * 32 * 1024 + textBytes * 8 + 96 * 1024;
  }
  const databaseBytes = manifestBytes * 2 + (snapshot.albums.length + snapshot.categories.length + snapshot.syncLogs.length + 16) * 16 * 1024;
  const workspaceBytes = excelBytes + databaseBytes + manifestBytes + 32 * 1024;
  const inputBytes = workspaceBytes + fileSizes.reduce((sum, size) => sum + size, 0);
  // zlib's compressBound terms plus generous ZIP headers/UTF-8 filename space.
  const zipBytes = inputBytes + Math.ceil(inputBytes / 4096) + Math.ceil(inputBytes / 16384) +
    Math.ceil(inputBytes / 33554432) + (fileSizes.length + 5) * 2048 + 65536;
  if (!Number.isSafeInteger(zipBytes) || zipBytes > MAX_EXPORT_BYTES) throw new ApiError(413, '备份预计超过 8 GB，请拆分图库后备份；尚未删除任何旧备份');
  return { workspaceBytes, zipBytes, estimatedBytes: workspaceBytes + zipBytes };
}

/** Read-only admission planning holds the writer slot until write/release. */
export async function prepareAutomaticBackup(db: GalleryDb, uploadsDir: string, signal?: AbortSignal): Promise<AutomaticBackupPlan> {
  signal?.throwIfAborted();
  const releaseWriter = acquireBackupWriter(db.directory);
  try {
    let snapshot: BackupSnapshot | undefined = captureBackupSnapshot(db);
    let originals: BackupSource[] = [];
    for (const file of await collectOriginalFiles(snapshot, uploadsDir, signal)) {
      signal?.throwIfAborted();
      const info = await lstat(file.path);
      if (!info.isFile() || info.isSymbolicLink() || !Number.isSafeInteger(info.size) || info.size < 0) throw new ApiError(409, '备份图片文件已发生变化，请重试');
      // The current importer accepts at most 2 GiB per entry and 50,000 entries.
      if (info.size > 2 * 1024 ** 3) throw new ApiError(413, '备份包含超过 2 GB 的单个文件，无法生成可恢复的备份');
      originals.push({ ...file, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino, dev: info.dev });
    }
    if (originals.length + 5 > 50_000) throw new ApiError(413, '备份文件数量超过 50000，请拆分图库后备份');
    const { workspaceBytes, zipBytes, estimatedBytes } = estimateAutomaticBackupSpace(snapshot, originals.map(file => file.size));
    let used = false;
    let writing = false;
    return {
      estimatedBytes,
      release() { snapshot = undefined; originals = []; if (!writing) releaseWriter(); },
      async write(directory, signal) {
        if (used || !snapshot) throw new ApiError(409, '备份计划已使用或释放，请重新检查空间后备份');
        writing = true;
        used = true;
        const current = snapshot, sources = originals;
        snapshot = undefined; originals = [];
        const created = new Set<string>();
        let validated = false;
        const stage = resolve(directory);
        const excelPath = join(stage, '图集清单.xlsx');
        const databasePath = join(stage, 'gallery.db');
        const manifestPath = join(stage, 'manifest.json');
        const instructionsPath = join(stage, '恢复说明.txt');
        const partialPath = join(stage, '完整备份.zip.partial');
        const finalPath = join(stage, '完整备份.zip');
        async function checkSources() {
          for (const file of sources) {
            signal?.throwIfAborted();
            const checked = await existingUpload(uploadsDir, `/uploads/${file.name}`);
            const info = await lstat(checked.path);
            if (checked.path !== file.path || info.size !== file.size || info.mtimeMs !== file.mtimeMs ||
              info.ctimeMs !== file.ctimeMs || info.ino !== file.ino || info.dev !== file.dev) {
              throw new ApiError(409, '备份期间图片发生变化，已取消本次备份并保留旧备份');
            }
          }
        }
        try {
          signal?.throwIfAborted();
          const stageInfo = await lstat(stage);
          if (!stageInfo.isDirectory() || stageInfo.isSymbolicLink() || await realpath(stage) !== stage) throw new ApiError(409, '备份暂存目录不安全');
          for (const path of [excelPath, databasePath, manifestPath, instructionsPath, partialPath, finalPath]) {
            try { await lstat(path); throw new ApiError(409, '备份暂存目录已包含同名文件'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          }
          await checkSources();
          const { workbook } = await buildExcelWorkbook(current, uploadsDir, signal);
          signal?.throwIfAborted();
          created.add(excelPath);
          await workbook.xlsx.writeFile(excelPath);
          signal?.throwIfAborted();
          created.add(databasePath);
          writeSnapshotDatabase(current, databasePath);
          created.add(manifestPath);
          await writeFile(manifestPath, JSON.stringify(current, null, 2), { encoding: 'utf8', flag: 'wx' });
          created.add(instructionsPath);
          await writeFile(instructionsPath, '\uFEFF' + RESTORE_INSTRUCTIONS, { encoding: 'utf8', flag: 'wx' });
          const archiveFiles = [
            { name: '图集清单.xlsx', path: excelPath }, { name: 'manifest.json', path: manifestPath },
            { name: '恢复说明.txt', path: instructionsPath }, { name: 'data/gallery.db', path: databasePath },
            ...sources.map(file => ({ name: `data/uploads/${file.name}`, path: file.path })),
          ];
          const intermediates = [excelPath, databasePath, manifestPath, instructionsPath];
          const actualWorkspaceBytes = (await Promise.all(intermediates.map(path => stat(path)))).reduce((sum, info) => sum + info.size, 0);
          if (actualWorkspaceBytes > workspaceBytes) throw new ApiError(413, '备份中间文件超出空间预算，已取消本次备份');
          await checkSources();
          created.add(partialPath);
          await createBackupZip(partialPath, archiveFiles, signal, Math.min(zipBytes, MAX_EXPORT_BYTES));
          signal?.throwIfAborted();
          const archive = await openValidatedArchive(partialPath);
          try {
            if (archive.entries.size !== archiveFiles.length + 1 || !archive.entries.has('data/uploads/')) throw new ApiError(409, '备份压缩包目录校验失败');
            for (const file of archiveFiles) {
              if (archive.entries.get(file.name)?.uncompressedSize !== (await stat(file.path)).size) throw new ApiError(409, '备份文件长度校验失败');
            }
            await archive.verifyAll(signal);
          } finally { archive.close(); }
          await checkSources();
          signal?.throwIfAborted();
          for (const path of intermediates) { await rm(path); created.delete(path); }
          const size = (await stat(partialPath)).size;
          if (size > MAX_EXPORT_BYTES) throw new ApiError(413, '备份超过 8 GB，已取消本次备份');
          await rename(partialPath, finalPath);
          created.delete(partialPath); created.add(finalPath);
          signal?.throwIfAborted();
          validated = true;
          return { path: finalPath, filename: '完整备份.zip', size };
        } catch (error) {
          if (error instanceof ApiError || signal?.aborted) throw error;
          const diskError = error as NodeJS.ErrnoException & { errcode?: number };
          if (['ENOSPC', 'EDQUOT'].includes(diskError.code ?? '') || (diskError.code === 'ERR_SQLITE_ERROR' && ((diskError.errcode ?? 0) & 0xff) === 13)) {
            throw new ApiError(507, '生成备份时磁盘空间不足，已取消本次备份并保留现有备份');
          }
          throw new ApiError(409, '完整备份生成失败：图片发生变化、文件无法读取或压缩包校验失败，请重试');
        } finally {
          if (!validated) {
            for (const path of created) await rm(path, { force: true }).catch(error => reportRuntimeError('automatic-backup-writer-cleanup', error));
          }
          writing = false;
          releaseWriter();
        }
      },
    };
  } catch (error) { releaseWriter(); throw error; }
}

export async function registerBackupRoutes(app: Express, db: GalleryDb, uploadsDir: string): Promise<() => Promise<void>> {
  const exportRoot = resolve(db.directory, '.exports');
  await mkdir(exportRoot, { recursive: true });
  const prepared = new Map<string, PreparedBackup>();
  let busy: Promise<void> | undefined;
  let closing = false;
  let sweeping: Promise<void> | undefined;
  let cleanupBlocked = false;
  let activeController: AbortController | undefined;

  async function removePrepared(id: string, file: PreparedBackup): Promise<void> {
    await removeOwnedDirectory(file.directory);
    prepared.delete(id);
  }

  function retainedBytes(): number { return [...prepared.values()].reduce((sum, file) => sum + file.size, 0); }
  async function reserveCache(bytes: number): Promise<void> {
    if (bytes > MAX_EXPORT_BYTES) throw new ApiError(413, '备份超过 8 GB，请拆分图库后导出');
    for (const [id, file] of prepared) {
      if (prepared.size < MAX_PREPARED_EXPORTS && retainedBytes() + bytes <= MAX_EXPORT_BYTES) break;
      if (!file.activeDownloads) await removePrepared(id, file);
    }
    if (prepared.size >= MAX_PREPARED_EXPORTS || retainedBytes() + bytes > MAX_EXPORT_BYTES) throw new ApiError(409, '备份正在下载，临时空间已达到上限，请下载完成后再试');
  }

  async function removeOwnedDirectory(directory: string): Promise<void> {
    const resolved = resolve(directory);
    if (dirname(resolved) !== exportRoot || !EXPORT_DIRECTORY.test(basename(resolved))) return;
    try {
      const info = await lstat(resolved);
      if (!info.isDirectory() || info.isSymbolicLink()) return;
      const marker = JSON.parse(await readFile(join(resolved, MARKER_NAME), 'utf8')) as { format?: string };
      if (marker.format !== 'lumina-gallery-export-temp') return;
      await rm(resolved, { recursive: true, force: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  async function sweep(): Promise<void> {
    cleanupBlocked = false;
    const now = Date.now();
    for (const [id, file] of prepared) {
      if (file.expiresAt <= now && !file.activeDownloads) {
        try { await removePrepared(id, file); }
        catch (error) { cleanupBlocked = true; reportRuntimeError('backup-export-cleanup', error); }
      }
    }
    // Only our marked, UUID-named directories are eligible for crash recovery cleanup.
    for (const entry of await readdir(exportRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !EXPORT_DIRECTORY.test(entry.name)) continue;
      const directory = join(exportRoot, entry.name);
      if ([...prepared.values()].some(item => item.directory === directory)) continue;
      try {
        const marker = JSON.parse(await readFile(join(directory, MARKER_NAME), 'utf8')) as { format?: string; createdAt?: number };
        if (marker.format === 'lumina-gallery-export-temp') await removeOwnedDirectory(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) { cleanupBlocked = true; reportRuntimeError('backup-export-cleanup', error); }
      }
    }
  }
  // Download tokens do not survive restarts, so no old cache remains usable.
  await sweep();
  const timer = setInterval(() => {
    if (sweeping || closing || busy) return;
    sweeping = sweep().catch(error => reportRuntimeError('backup-export-cleanup', error)).finally(() => { sweeping = undefined; });
  }, 60_000);
  timer.unref();

  app.post('/api/backups', async (req, res) => {
    const format: unknown = req.body?.format;
    if (format !== 'xlsx' && format !== 'zip') throw new ApiError(400, '请选择 Excel 清单或完整 ZIP 备份');
    if (closing || busy || sweeping) throw new ApiError(409, '正在准备其他备份，请完成后再试');
    const releaseWriter = acquireBackupWriter(db.directory);
    let finish!: () => void;
    busy = new Promise<void>(done => { finish = done; });
    const controller = new AbortController();
    activeController = controller;
    const disconnected = () => controller.abort(new ApiError(400, '备份请求已取消'));
    res.once('close', disconnected);
    const id = randomUUID();
    const directory = join(exportRoot, `backup-${id}`);
    try {
      await sweep();
      if (cleanupBlocked) throw new ApiError(503, '旧备份临时文件暂时无法清理，请检查数据目录权限后重试');
      const snapshot = captureBackupSnapshot(db);
      const originals = format === 'zip' ? await collectOriginalFiles(snapshot, uploadsDir) : [];
      let estimate = Buffer.byteLength(JSON.stringify(snapshot)) * 6 + snapshot.albums.length * 96 * 1024 + 1024 ** 2;
      for (const file of originals) estimate += (await stat(file.path)).size;
      if (estimate > MAX_EXPORT_BYTES) throw new ApiError(413, '备份预计超过 8 GB，请拆分图库后导出');
      // Old unused downloads may be discarded early; active transfers are never removed.
      await reserveCache(estimate);
      await assertDiskSpace(exportRoot, estimate);
      await mkdir(directory);
      await writeFile(join(directory, MARKER_NAME), JSON.stringify({ format: 'lumina-gallery-export-temp', createdAt: Date.now() }));
      const { workbook, warnings } = await buildExcelWorkbook(snapshot, uploadsDir, controller.signal);
      controller.signal.throwIfAborted();
      const excelPath = join(directory, '图集清单.xlsx');
      await workbook.xlsx.writeFile(excelPath);
      let path = excelPath;
      if (format === 'zip') {
        const databasePath = join(directory, 'gallery.db');
        writeSnapshotDatabase(snapshot, databasePath);
        const manifestPath = join(directory, 'manifest.json');
        const instructionsPath = join(directory, '恢复说明.txt');
        await writeFile(manifestPath, JSON.stringify(snapshot, null, 2), 'utf8');
        await writeFile(instructionsPath, '\uFEFF' + RESTORE_INSTRUCTIONS, 'utf8');
        const workspaceBytes = (await Promise.all([excelPath, databasePath, manifestPath, instructionsPath].map(file => stat(file))))
          .reduce((sum, file) => sum + file.size, 0);
        // ZIP output shares its budget with existing downloads and the intermediate snapshot files.
        await reserveCache(workspaceBytes);
        const zipBudget = MAX_EXPORT_BYTES - retainedBytes() - workspaceBytes;
        path = join(directory, '完整备份.zip');
        try {
          await createBackupZip(path, [
            { name: '图集清单.xlsx', path: excelPath }, { name: 'manifest.json', path: manifestPath },
            { name: '恢复说明.txt', path: instructionsPath }, { name: 'data/gallery.db', path: databasePath },
            ...originals.map(file => ({ name: `data/uploads/${file.name}`, path: file.path })),
          ], controller.signal, zipBudget);
        } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(409, '备份生成时图片发生变化或文件无法读取，完整备份未生成。请稍后重试。'); }
        // Keep only the downloadable ZIP, not a second copy of all snapshot metadata.
        await Promise.all([excelPath, databasePath, manifestPath, instructionsPath].map(file => rm(file, { force: true })));
      }
      const timestamp = new Date(Date.parse(snapshot.exportedAt) + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
      const filename = `拾光图集-${format === 'zip' ? '完整备份' : '图集清单'}-${timestamp}.${format}`;
      const size = (await stat(path)).size;
      // Estimates are only admission checks; the actual retained total is enforced again.
      await reserveCache(size);
      if (closing || req.aborted || res.destroyed) throw new ApiError(400, '备份请求已取消');
      prepared.set(id, { directory, path, filename, size, warnings, mime: format === 'zip' ? 'application/zip' : EXCEL_MIME, expiresAt: Date.now() + EXPORT_TTL_MS, activeDownloads: 0 });
      res.status(201).json({ downloadUrl: `/api/backups/${id}/download`, filename, size, warnings });
    } catch (error) {
      await removeOwnedDirectory(directory).catch(cleanupError => reportRuntimeError('backup-export-cleanup', cleanupError));
      throw error;
    } finally { res.off('close', disconnected); busy = undefined; activeController = undefined; releaseWriter(); finish(); }
  });

  app.get('/api/backups/:id/download', (req, res, next) => {
    const item = prepared.get(String(req.params.id));
    if (closing || !item || item.expiresAt <= Date.now()) throw new ApiError(404, '备份文件已过期，请重新导出');
    if ([...prepared.values()].reduce((count, file) => count + file.activeDownloads, 0) >= MAX_ACTIVE_DOWNLOADS) throw new ApiError(429, '同时下载的备份过多，请稍后再试');
    item.activeDownloads++;
    let released = false;
    const deadline = setTimeout(() => res.destroy(), 30 * 60_000);
    deadline.unref();
    res.setTimeout(2 * 60_000, () => res.destroy());
    const release = () => {
      if (released) return;
      released = true; clearTimeout(deadline); item.activeDownloads--;
      if (closing && !item.activeDownloads) void removeOwnedDirectory(item.directory).catch(error => reportRuntimeError('backup-export-cleanup', error));
    };
    res.once('close', release);
    res.setHeader('Content-Type', item.mime);
    res.setHeader('Content-Disposition', `attachment; filename="lumina-backup.${item.filename.endsWith('.zip') ? 'zip' : 'xlsx'}"; filename*=UTF-8''${encodeURIComponent(item.filename)}`);
    res.sendFile(item.path, { dotfiles: 'allow' }, error => {
      release();
      if (error) next(error);
    });
  });

  return async () => {
    closing = true;
    activeController?.abort(new ApiError(400, '服务正在关闭，已取消备份'));
    clearInterval(timer);
    await busy;
    await sweeping;
    await Promise.all([...prepared.values()].filter(item => !item.activeDownloads).map(item => removeOwnedDirectory(item.directory).catch(error => reportRuntimeError('backup-export-cleanup', error))));
    prepared.clear();
  };
}
