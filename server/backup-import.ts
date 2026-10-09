import type { Express, Request, Response } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { Album, CloudLink, GalleryImage } from '../shared/types.ts';
import type { BackupImportPreview, BackupImportResult } from '../shared/backup-import.ts';
import { ApiError, GalleryDb, isBaiduLink, normalizeCategoryName, normalizeInput } from './db.ts';
import { openValidatedArchive } from './import-archive.ts';
import { parseExcelImport } from './import-excel.ts';
import { assertDiskSpace, receiveMultipart } from './resource-limits.ts';
import { reportRuntimeError } from './runtime-log.ts';

export interface ImportedFile { sourcePath: string; filename: string; }
export interface ImportedCandidate { key: string; album: Album; files: ImportedFile[]; }
export interface PreparedImport {
  format: 'zip' | 'xlsx'; exportedAt?: string; albums: ImportedCandidate[]; categories: string[]; warnings: string[];
}

const MAX_IMAGE_BYTES = 30 * 1024 ** 2;
const TTL_MS = 60 * 60 * 1000;
const MAX_STAGED_BYTES = 8 * 1024 ** 3;
const MAX_COMPLETED_RESULTS = 64;
const MARKER = '.lumina-import.json';
const DIRECTORY = /^import-[a-f0-9-]{36}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, `备份中的${label}格式不正确`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\u0000')) throw new ApiError(400, `备份中的${label}格式不正确`);
  return value;
}
function identity(value: unknown, label: string): string {
  const id = text(value, label, 100);
  if (!/^[a-zA-Z0-9._-]+$/.test(id) || id === '.' || id === '..') throw new ApiError(400, `备份中的${label}无效`);
  return id;
}
function timestamp(value: unknown, label: string): string {
  const result = text(value, label, 40);
  if (!ISO_TIME.test(result) || !Number.isFinite(Date.parse(result))) throw new ApiError(400, `备份中的${label}无效`);
  const [year, month, day, hour, minute, second] = result.slice(0, 19).split(/[-T:]/).map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year!, month! - 1, day!);
  calendar.setUTCHours(hour!, minute!, second!, 0);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day || calendar.getUTCHours() !== hour || calendar.getUTCMinutes() !== minute || calendar.getUTCSeconds() !== second) throw new ApiError(400, `备份中的${label}不是有效日期`);
  return result;
}
function optionalTimestamp(value: unknown, label: string): string | null { return value === null ? null : timestamp(value, label); }
function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new ApiError(400, `备份中的${label}格式不正确或数量超过限制`);
  return value;
}
function uploadName(value: unknown): string {
  if (typeof value !== 'string' || !/^\/uploads\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,200}\.(?:jpe?g|png|webp|gif|avif)$/.test(value)) throw new ApiError(400, '备份中的图片路径无效');
  return value.slice('/uploads/'.length);
}
function unique<T>(items: T[], key: (item: T) => string, label: string): T[] {
  const seen = new Set<string>();
  for (const item of items) { const id = key(item); if (seen.has(id)) throw new ApiError(400, `备份中存在重复的${label}`); seen.add(id); }
  return items;
}

function validateLinkHealth(value: unknown): NonNullable<CloudLink['health']> {
  const health = object(value, '链接有效性检查结果');
  const statuses = ['unchecked', 'valid', 'invalid', 'code_required', 'code_error', 'login_required', 'verification_required', 'network_error', 'unknown', 'unsupported'];
  if (typeof health.status !== 'string' || !statuses.includes(health.status)) throw new ApiError(400, '备份中的链接有效性状态无效');
  return {
    status: health.status as NonNullable<CloudLink['health']>['status'],
    message: text(health.message, '链接有效性说明', 4000),
    checkedAt: optionalTimestamp(health.checkedAt, '链接有效性上次检查时间'),
    nextCheckAt: optionalTimestamp(health.nextCheckAt, '链接有效性下次检查时间'),
  };
}

function validateAlbum(value: unknown): Album {
  const raw = object(value, '图集');
  if (typeof raw.favorite !== 'boolean' || !['local', 'baidu'].includes(String(raw.updateSource)) || (raw.isDemo !== undefined && typeof raw.isDemo !== 'boolean')) throw new ApiError(400, '备份中的图集状态无效');
  const links = unique(array(raw.links, '网盘链接', 20).map(value => {
    const link = object(value, '网盘链接');
    if (typeof link.syncEnabled !== 'boolean' || !['disabled', 'pending', 'success', 'error'].includes(String(link.status))) throw new ApiError(400, '备份中的网盘同步状态无效');
    const result: CloudLink = {
      id: identity(link.id, '链接编号'), label: text(link.label, '链接名称', 80), url: text(link.url, '网盘链接', 2048),
      code: text(link.code, '提取码', 32), password: text(link.password, '解压密码', 200), note: text(link.note, '下载说明', 2000),
      syncEnabled: link.syncEnabled, status: link.status as CloudLink['status'], message: text(link.message, '同步说明', 4000),
      lastCheckedAt: optionalTimestamp(link.lastCheckedAt, '上次检查时间'), nextCheckAt: optionalTimestamp(link.nextCheckAt, '下次检查时间'), remoteUpdatedAt: optionalTimestamp(link.remoteUpdatedAt, '网盘更新时间'),
      ...(link.health !== undefined ? { health: validateLinkHealth(link.health) } : {}),
    };
    if (result.syncEnabled && !isBaiduLink(result.url)) throw new ApiError(400, '备份中非百度网盘链接不能启用自动同步');
    return result;
  }), item => item.id, '链接编号');
  const images = unique(array(raw.images, '图片', 1000).map(value => {
    const image = object(value, '图片');
    uploadName(image.url); uploadName(image.thumbnailUrl);
    for (const field of ['width', 'height', 'size']) if (typeof image[field] !== 'number' || !Number.isSafeInteger(image[field]) || Number(image[field]) <= 0) throw new ApiError(400, '备份中的图片信息无效');
    return { id: identity(image.id, '图片编号'), url: image.url as string, thumbnailUrl: image.thumbnailUrl as string, name: text(image.name, '图片名称', 250), width: image.width as number, height: image.height as number, size: image.size as number } satisfies GalleryImage;
  }), item => item.id, '图片编号');
  const createdAt = timestamp(raw.createdAt, '创建时间');
  const normalized = normalizeInput(raw, { links } as Album, createdAt);
  return {
    ...normalized, id: identity(raw.id, '图集编号'), favorite: raw.favorite, links: links.map((link, index) => ({ ...normalized.links[index]!, id: link.id, status: link.status, message: link.message, lastCheckedAt: link.lastCheckedAt, nextCheckAt: link.nextCheckAt, remoteUpdatedAt: link.remoteUpdatedAt, ...(link.health ? { health: link.health } : {}) })), images,
    createdAt, updatedAt: timestamp(raw.updatedAt, '更新时间'), localUpdatedAt: timestamp(raw.localUpdatedAt, '本地更新时间'), updateSource: raw.updateSource as Album['updateSource'],
    ...(raw.isDemo !== undefined ? { isDemo: raw.isDemo } : {}),
  };
}

export async function parseZipImport(path: string, stageDir: string, maxStagedBytes = MAX_STAGED_BYTES, signal?: AbortSignal): Promise<PreparedImport> {
  const archive = await openValidatedArchive(path);
  try {
    let manifest: Record<string, unknown>;
    try { manifest = object(JSON.parse((await archive.read('manifest.json', 16 * 1024 ** 2)).toString('utf8').replace(/^\uFEFF/, '')), '清单'); }
    catch (error) { throw error instanceof ApiError ? error : new ApiError(400, '备份清单损坏，无法导入'); }
    if (manifest.format !== 'lumina-gallery-backup' || manifest.version !== 1) throw new ApiError(400, '不支持此 ZIP 备份格式，请选择拾光导出的完整备份');
    const exportedAt = timestamp(manifest.exportedAt, '导出时间');
    const categories = [...new Set(array(manifest.categories, '分类', 10_000).map(normalizeCategoryName))];
    const albums = unique(array(manifest.albums, '图集', 20_000).map(validateAlbum), album => album.id, '图集编号');
    let count = 0;
    let plannedBytes = 0;
    for (const album of albums) {
      if (!categories.includes(album.category)) categories.push(album.category);
      count += album.images.length;
      if (count > 25_000) throw new ApiError(400, '一次最多导入 25000 张图片，请拆分备份');
      for (const image of album.images) for (const url of [image.url, image.thumbnailUrl]) {
        const entry = archive.entries.get(`data/uploads/${uploadName(url)}`);
        if (!entry || entry.uncompressedSize <= 0 || entry.uncompressedSize > MAX_IMAGE_BYTES) throw new ApiError(400, `图集「${album.title}」的图片「${image.name}」缺失或超过 30 MB，未导入任何图集`);
      }
      // A single archive entry may be referenced thousands of times. Count every copy.
      for (const image of album.images) plannedBytes += archive.entries.get(`data/uploads/${uploadName(image.url)}`)!.uncompressedSize;
      if (plannedBytes > maxStagedBytes) throw new ApiError(413, '导入图片实际展开大小超过临时空间上限，请拆分备份');
    }
    await assertDiskSpace(stageDir, plannedBytes + MAX_IMAGE_BYTES + count * 64 * 1024);
    const prepared: ImportedCandidate[] = [];
    let stagedBytes = 0;
    for (const source of albums) {
      signal?.throwIfAborted();
      const album = structuredClone(source);
      const files: ImportedFile[] = [];
      for (const image of album.images) {
        signal?.throwIfAborted();
        const originalName = uploadName(image.url);
        const originalPath = join(stageDir, `${randomUUID()}.source`);
        await assertDiskSpace(stageDir, archive.entries.get(`data/uploads/${originalName}`)!.uncompressedSize * 2 + 2 * 1024 ** 2);
        await archive.extract(`data/uploads/${originalName}`, originalPath, MAX_IMAGE_BYTES);
        let decoder: sharp.Sharp | undefined;
        try {
          const bytes = await readFile(originalPath);
          decoder = sharp(bytes, { limitInputPixels: 100_000_000, animated: false, failOn: 'error' }).timeout({ seconds: 30 });
          const metadata = await decoder.metadata();
          const extensions: Record<string, string> = { jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif', avif: 'avif', heif: 'avif' };
          if (!metadata.format || !extensions[metadata.format] || !metadata.width || !metadata.height || (metadata.format === 'heif' && metadata.compression !== 'av1')) throw new Error('Unsupported image');
          const filename = `${randomUUID()}.${extensions[metadata.format]}`;
          const thumbnail = `${randomUUID()}-thumb.jpg`;
          const target = join(stageDir, filename);
          const thumbTarget = join(stageDir, thumbnail);
          await decoder.rotate().resize({ width: 640, height: 800, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 82 }).toFile(thumbTarget);
          stagedBytes += bytes.length + (await stat(thumbTarget)).size;
          if (stagedBytes > maxStagedBytes) throw new ApiError(413, '导入图片实际展开大小超过临时空间上限，请拆分备份');
          await copyFile(originalPath, target, constants.COPYFILE_EXCL);
          files.push({ sourcePath: target, filename }, { sourcePath: thumbTarget, filename: thumbnail });
          image.url = `/uploads/${filename}`; image.thumbnailUrl = `/uploads/${thumbnail}`;
          const rotated = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
          image.width = rotated ? metadata.height : metadata.width; image.height = rotated ? metadata.width : metadata.height; image.size = bytes.length;
        } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, `图集「${album.title}」的图片「${image.name}」无法解码，未导入任何图集`); }
        finally { decoder?.destroy(); await unlink(originalPath).catch(() => undefined); }
      }
      prepared.push({ key: album.id, album, files });
    }
    return { format: 'zip', exportedAt, albums: prepared, categories, warnings: ['保留当前软件设置和百度登录状态；备份中的设置与历史同步日志不会导入。'] };
  } finally { archive.close(); }
}

interface ImportStage { directory: string; filename: string; expiresAt: number; bytes: number; prepared: PreparedImport; result?: BackupImportResult; }

export async function registerBackupImportRoutes(app: Express, db: GalleryDb, uploadsDir: string): Promise<() => Promise<void>> {
  const importRoot = resolve(db.directory, '.imports');
  await mkdir(importRoot, { recursive: true });
  const stages = new Map<string, ImportStage>();
  let operation: Promise<void> | undefined;
  let sweeping: Promise<void> | undefined;
  let closing = false;
  let cleanupBlocked = false;

  async function removeOwned(directory: string): Promise<void> {
    const target = resolve(directory);
    if (dirname(target) !== importRoot || !DIRECTORY.test(basename(target))) return;
    try {
      const info = await lstat(target);
      if (!info.isDirectory() || info.isSymbolicLink()) return;
      const marker = JSON.parse(await readFile(join(target, MARKER), 'utf8')) as { format?: string };
      if (marker.format === 'lumina-gallery-import-temp') await rm(target, { recursive: true, force: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  async function sweep(): Promise<void> {
    cleanupBlocked = false;
    const now = Date.now();
    for (const [id, stage] of stages) if (stage.expiresAt <= now) {
      try { await removeOwned(stage.directory); stages.delete(id); }
      catch (error) { cleanupBlocked = true; reportRuntimeError('backup-import-cleanup', error); }
    }
    for (const entry of await readdir(importRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !DIRECTORY.test(entry.name)) continue;
      const directory = join(importRoot, entry.name);
      if ([...stages.values()].some(stage => stage.directory === directory)) continue;
      try {
        const marker = JSON.parse(await readFile(join(directory, MARKER), 'utf8')) as { format?: string; createdAt?: number };
        if (marker.format === 'lumina-gallery-import-temp') await removeOwned(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) { cleanupBlocked = true; reportRuntimeError('backup-import-cleanup', error); }
      }
    }
  }
  // Tokens live only in memory: previews left by a stopped process cannot be resumed.
  await sweep();
  const timer = setInterval(() => {
    if (closing || operation || sweeping) return;
    sweeping = sweep().catch(error => reportRuntimeError('backup-import-cleanup', error)).finally(() => { sweeping = undefined; });
  }, 60_000);
  timer.unref();

  function begin(): () => void {
    if (closing || operation || sweeping) throw new ApiError(409, '正在处理其他导入，请稍后再试');
    let finish!: () => void;
    operation = new Promise<void>(resolve => { finish = resolve; });
    return () => { operation = undefined; finish(); };
  }
  function stageFrom(id: string): ImportStage {
    const stage = stages.get(id);
    if (!stage || stage.expiresAt <= Date.now()) throw new ApiError(404, '导入预览已过期，请重新选择备份文件');
    return stage;
  }
  function preview(id: string, stage: ImportStage): BackupImportPreview {
    return { id, filename: stage.filename, format: stage.prepared.format, ...(stage.prepared.exportedAt ? { exportedAt: stage.prepared.exportedAt } : {}), categories: stage.prepared.categories, warnings: stage.prepared.warnings, albums: stage.prepared.albums.map(({ key, album }) => ({ key, title: album.title, category: album.category, imageCount: album.images.length, linkCount: album.links.length, updatedAt: album.updatedAt, exists: Boolean(db.album(album.id)) })) };
  }
  async function receive(req: Request, res: Response, directory: string): Promise<Express.Multer.File> {
    // Disk checks and directory creation can yield long enough for the client to leave.
    // Multer cannot observe an "aborted" event that happened before it was attached.
    if (req.aborted || res.destroyed) throw new ApiError(400, '导入连接已关闭');
    const upload = multer({ dest: directory, limits: { fileSize: 2 * 1024 ** 3, files: 1, fields: 0, parts: 1 } }).single('file');
    try { await receiveMultipart(upload, req, res); }
    catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE' ? '备份文件不能超过 2 GB' : '请选择一个 ZIP 或 Excel 备份文件');
    }
    if (!req.file || req.aborted || res.destroyed) throw new ApiError(400, '请选择完整的备份文件');
    return req.file;
  }

  app.post('/api/backup-imports', async (req, res) => {
    const finish = begin();
    const controller = new AbortController();
    const disconnected = () => controller.abort(new ApiError(400, '导入连接已关闭'));
    res.once('close', disconnected);
    const id = randomUUID(); const directory = join(importRoot, `import-${id}`);
    try {
      await sweep();
      if (cleanupBlocked || stages.size >= MAX_COMPLETED_RESULTS + 3) throw new ApiError(503, '导入临时缓存暂时无法清理，请稍后重试并检查数据目录权限');
      if ([...stages.values()].filter(stage => !stage.result).length >= 3) throw new ApiError(409, '已有 3 个待确认的导入，请先完成或取消');
      const remainingBytes = MAX_STAGED_BYTES - [...stages.values()].reduce((sum, stage) => sum + stage.bytes, 0);
      const uploadBytes = Number(req.headers['content-length']);
      const reserve = Number.isSafeInteger(uploadBytes) && uploadBytes >= 0 ? Math.min(uploadBytes, 2 * 1024 ** 3) : 2 * 1024 ** 3;
      if (reserve > remainingBytes) throw new ApiError(413, '导入临时空间已达到 8 GB，请先完成或取消已有预览');
      await assertDiskSpace(importRoot, reserve);
      await mkdir(directory);
      await writeFile(join(directory, MARKER), JSON.stringify({ format: 'lumina-gallery-import-temp', createdAt: Date.now() }));
      const file = await receive(req, res, directory);
      let filename = file.originalname;
      if ([...filename].every(character => character.charCodeAt(0) <= 255)) { const decoded = Buffer.from(filename, 'latin1').toString('utf8'); if (!decoded.includes('\uFFFD')) filename = decoded; }
      filename = basename(filename.replace(/\\/g, '/')).slice(0, 250);
      const extension = filename.toLowerCase().split('.').pop();
      if (extension !== 'zip' && extension !== 'xlsx') throw new ApiError(400, '请选择 .zip 完整备份或 .xlsx Excel 清单');
      let prepared: PreparedImport;
      if (extension === 'xlsx') {
        if (file.size > 128 * 1024 ** 2) throw new ApiError(400, 'Excel 清单不能超过 128 MB，请使用完整 ZIP 备份导入');
        const archive = await openValidatedArchive(file.path, { maxExpandedBytes: 256 * 1024 ** 2, maxEntryBytes: 128 * 1024 ** 2, maxEntries: 20_000 });
        try { await archive.verifyAll(); } finally { archive.close(); }
        prepared = await parseExcelImport(file.path, directory, remainingBytes - file.size, controller.signal);
      } else prepared = await parseZipImport(file.path, directory, remainingBytes - file.size, controller.signal);
      if (req.aborted || res.destroyed || closing) throw new ApiError(400, '导入已取消，请重新选择备份');
      await unlink(file.path);
      let bytes = 0;
      for (const candidate of prepared.albums) for (const file of candidate.files) bytes += (await stat(file.sourcePath)).size;
      const stage: ImportStage = { directory, filename, expiresAt: Date.now() + TTL_MS, bytes, prepared };
      stages.set(id, stage);
      res.status(201).json(preview(id, stage));
    } catch (error) { await removeOwned(directory).catch(cleanupError => reportRuntimeError('backup-import-cleanup', cleanupError)); throw error; }
    finally { res.off('close', disconnected); finish(); }
  });

  app.post('/api/backup-imports/:id/commit', async (req, res) => {
    const finish = begin();
    const createdFiles: string[] = [];
    try {
      const stage = stageFrom(String(req.params.id));
      if (stage.result) { res.json(stage.result); return; }
      const raw = object(req.body, '导入选择');
      if (raw.duplicateMode !== 'skip' && raw.duplicateMode !== 'copy') throw new ApiError(400, '请选择跳过已有图集或作为副本导入');
      const keys = unique(array(raw.albumKeys, '已选图集', 20_000).map(value => text(value, '图集选择', 150)), item => item, '图集选择');
      const candidates = new Map(stage.prepared.albums.map(album => [album.key, album]));
      if (keys.some(key => !candidates.has(key))) throw new ApiError(400, '导入选择无效，请重新预览');
      if (!keys.length && stage.prepared.albums.length) throw new ApiError(400, '请至少选择一个要导入的图集');
      const selected = keys.map(key => candidates.get(key)!);
      // Committing copies originals out of staging before the database transaction.
      let copyBytes = 0;
      for (const candidate of selected) {
        if (raw.duplicateMode === 'skip' && db.album(candidate.album.id)) continue;
        for (const file of candidate.files) copyBytes += (await stat(file.sourcePath)).size;
      }
      await assertDiskSpace(uploadsDir, copyBytes);
      const imported: Album[] = [];
      let skipped = 0;
      for (const candidate of selected) {
        const exists = Boolean(db.album(candidate.album.id));
        if (exists && raw.duplicateMode === 'skip') { skipped++; continue; }
        const album = structuredClone(candidate.album);
        if (exists) {
          album.id = randomUUID();
          album.images = album.images.map(image => ({ ...image, id: randomUUID() }));
          album.links = album.links.map(link => ({ ...link, id: randomUUID() }));
        }
        for (const file of candidate.files) {
          if (res.destroyed || req.aborted || closing) throw new ApiError(400, '导入请求已取消');
          if (!/^[a-zA-Z0-9._-]+$/.test(file.filename) || dirname(resolve(file.sourcePath)) !== stage.directory) throw new ApiError(400, '导入图片路径无效');
          const info = await lstat(file.sourcePath);
          if (!info.isFile() || info.isSymbolicLink()) throw new ApiError(400, '导入图片已失效，请重新预览');
          const destination = join(uploadsDir, file.filename);
          await copyFile(file.sourcePath, destination, constants.COPYFILE_EXCL);
          createdFiles.push(destination);
        }
        imported.push(album);
      }
      const emptyCategories = stage.prepared.categories.filter(category => !stage.prepared.albums.some(candidate => candidate.album.category === category));
      const categories = [...new Set([...emptyCategories, ...imported.map(album => album.category)])];
      let categoriesAdded = 0;
      if (res.destroyed || req.aborted || closing) throw new ApiError(400, '导入请求已取消');
      // The write transaction begins only after all asynchronous file work succeeds.
      db.connection.exec('SAVEPOINT gallery_backup_import');
      try {
        const insertCategory = db.connection.prepare('INSERT OR IGNORE INTO categories(name) VALUES(?)');
        const insertAlbum = db.connection.prepare('INSERT INTO albums(id,body) VALUES(?,?)');
        for (const category of categories) categoriesAdded += Number(insertCategory.run(category).changes);
        for (const album of imported) {
          // Recheck after file copies: other API requests may have added the same ID.
          if (db.album(album.id)) {
            if (raw.duplicateMode === 'copy') album.id = randomUUID();
            else throw new ApiError(409, '图集在导入期间发生变化，请重新确认导入');
          }
          insertAlbum.run(album.id, JSON.stringify(album));
        }
        db.connection.exec('RELEASE SAVEPOINT gallery_backup_import');
      } catch (error) { db.connection.exec('ROLLBACK TO SAVEPOINT gallery_backup_import; RELEASE SAVEPOINT gallery_backup_import'); throw error; }
      const result: BackupImportResult = { imported: imported.length, skipped, imageCount: imported.reduce((count, album) => count + album.images.length, 0), categoriesAdded };
      stage.result = result;
      stage.expiresAt = Date.now() + TTL_MS;
      createdFiles.length = 0;
      // Retrying needs only a tiny result, never all album/image objects again.
      stage.prepared = { ...stage.prepared, albums: [], categories: [], warnings: [] };
      try { await removeOwned(stage.directory); stage.bytes = 0; }
      catch (error) { reportRuntimeError('backup-import-cleanup', error); }
      const completed = [...stages].filter(([, item]) => item.result);
      for (const [id, old] of completed.slice(0, Math.max(0, completed.length - MAX_COMPLETED_RESULTS))) {
        try { await removeOwned(old.directory); stages.delete(id); }
        catch (error) { reportRuntimeError('backup-import-cleanup', error); }
      }
      res.json(result);
    } catch (error) { await Promise.all(createdFiles.map(path => unlink(path).catch(cleanupError => reportRuntimeError('backup-import-cleanup', cleanupError)))); throw error; }
    finally { finish(); }
  });

  app.delete('/api/backup-imports/:id', async (req, res) => {
    const finish = begin();
    try { const id = String(req.params.id); const stage = stages.get(id); if (stage) { await removeOwned(stage.directory); stages.delete(id); } res.json({ ok: true }); }
    finally { finish(); }
  });
  return async () => {
    closing = true; clearInterval(timer);
    await operation; await sweeping;
    await Promise.all([...stages.values()].map(stage => removeOwned(stage.directory).catch(error => reportRuntimeError('backup-import-cleanup', error))));
    stages.clear();
  };
}
