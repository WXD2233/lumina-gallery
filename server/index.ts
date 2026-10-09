import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Album, GalleryImage } from '../shared/types.ts';
import { ApiError, GalleryDb, normalizeInput } from './db.ts';
import { SyncScheduler, type HealthInspector, type Inspector } from './scheduler.ts';
import { registerBackupRoutes } from './backup.ts';
import { registerBackupImportRoutes } from './backup-import.ts';
import { MAX_IMAGE_SOURCES, parseImageSources } from '../shared/image-sources.ts';
import { downloadRemoteImage, type RemoteImageDownloader, type StagedImage } from './remote-images.ts';
import { registerAuthRoutes } from './auth.ts';
import { registerProfileRoutes } from './profile.ts';
import { galleryPermissions } from './permissions.ts';
import { SecurityService, registerSecurityRoutes, type SecurityServiceOptions } from './security.ts';
import { assertPrivateDataDirectory, getPrivateDevFs } from './dev-files.ts';
import { configureRuntimeLogging, reportRuntimeError } from './runtime-log.ts';
import { assertDiskSpace, imageUpload, MAX_IMAGE_BATCH_BYTES, receiveMultipart, requestCapacity } from './resource-limits.ts';
import { startMaintenance } from './maintenance.ts';
import { acquireInstanceLock } from './instance-lock.ts';
import { AutoBackupService, type AutoBackupOptions } from './auto-backup.ts';
import { registerAutoBackupRoutes } from './auto-backup-routes.ts';
import { testWebDavConnection, uploadAutomaticBackupToWebDav } from './webdav.ts';
import { requireSecureTransport } from './transport-security.ts';

sharp.cache({ memory: 32, files: 0, items: 64 });
sharp.concurrency(2);

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export interface AppOptions { dataDir?: string; inspector?: Inspector; healthInspector?: HealthInspector; allowedHosts?: string[]; trustedProxies?: string[]; requireHttps?: boolean; downloadRemoteImage?: RemoteImageDownloader; securityOptions?: SecurityServiceOptions; autoBackupOptions?: AutoBackupOptions; }

function displayFilename(name: string): string {
  // Multipart headers commonly carry UTF-8 bytes that Busboy exposes as Latin-1.
  if ([...name].every(character => character.charCodeAt(0) <= 255)) {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    if (!decoded.includes('\uFFFD')) name = decoded;
  }
  return name.replace(/^.*[\\/]/, '').slice(0, 250);
}

export async function createApp(options: AppOptions = {}) {
  const dataDir = resolve(options.dataDir ?? process.env.DATA_DIR ?? join(projectRoot, 'data'));
  await assertPrivateDataDirectory(dataDir, projectRoot);
  const uploadsDir = join(dataDir, 'uploads');
  const stagingDir = join(dataDir, '.incoming');
  await Promise.all([mkdir(uploadsDir, { recursive: true }), mkdir(stagingDir, { recursive: true })]);
  const db = new GalleryDb(dataDir);
  const scheduler = new SyncScheduler(db, options.inspector, undefined, options.healthInspector);
  const app = express();
  app.disable('x-powered-by');
  const capacity = requestCapacity();
  const allowedHosts = new Set((options.allowedHosts ?? ['localhost', '127.0.0.1', '[::1]', ...(process.env.ALLOWED_HOSTS ?? '').split(',')]
    ).map(value => value.trim().toLowerCase()).filter(Boolean));
  const trustedProxies = (options.trustedProxies ?? (process.env.TRUSTED_PROXIES ?? '').split(','))
    .map(value => value.trim()).filter(Boolean);
  // Never trust forwarded client addresses by default. Operators may name exact
  // reverse-proxy addresses or CIDRs once the application is behind that proxy.
  if (trustedProxies.length) app.set('trust proxy', trustedProxies);
  app.use(capacity.middleware);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    const hostname = req.hostname.toLowerCase();
    if (!allowedHosts.has(hostname)) return res.status(403).json({ error: '此主机名未获允许，请使用 localhost 或配置 ALLOWED_HOSTS' });
    if (/^\/api(?:\/|$)/i.test(req.path)) {
      res.setHeader('Cache-Control', 'no-store');
      const origin = req.get('Origin');
      if (origin) {
        try {
          const originUrl = new URL(origin);
          if (originUrl.host !== req.get('Host') || !['http:', 'https:'].includes(originUrl.protocol)) return res.status(403).json({ error: '不允许跨站访问本地图集' });
        } catch { return res.status(403).json({ error: '请求来源无效' }); }
      }
      if (req.get('Sec-Fetch-Site') === 'cross-site') return res.status(403).json({ error: '不允许跨站访问本地图集' });
    }
    next();
  });
  if (options.requireHttps ?? process.argv.includes('--production')) app.use(requireSecureTransport);
  app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'lumina-gallery' }));
  const security = new SecurityService(db, options.securityOptions);
  const auth = registerAuthRoutes(app, db, { onSecurityEvent: event => security.record(event) });
  // Mount guards at Express path boundaries so case variants cannot bypass them.
  app.use('/api', auth.requireAuth);
  app.use('/uploads', auth.requireAuth);
  app.use('/api', galleryPermissions(auth.requireAdmin));
  // A large backup selection contains IDs only and can exceed ordinary form limits.
  app.use('/api/backup-imports', express.json({ limit: '4mb' }));
  app.use(express.json({ limit: '256kb' }));
  registerProfileRoutes(app, db);
  registerSecurityRoutes(app, security, auth.requireAdmin);
  const autoBackup = new AutoBackupService(db, uploadsDir, { ...options.autoBackupOptions,
    notify: options.autoBackupOptions?.notify ?? (notice => security.notifyBackup(notice)),
    webdavEnabled: options.autoBackupOptions?.webdavEnabled ?? (() => security.getWebDavSettings().enabled),
    uploadWebdav: options.autoBackupOptions?.uploadWebdav ?? (async (entry, signal) => {
      const target = security.getBackupWebDavTarget();
      if (!target) return;
      await uploadAutomaticBackupToWebDav(target, entry, 7, {}, signal);
    }),
    testWebdav: options.autoBackupOptions?.testWebdav ?? (async () => {
      const target = security.getBackupWebDavTarget();
      if (!target) throw new Error('WebDAV is not enabled');
      await testWebDavConnection(target);
    }),
  });
  await autoBackup.initialize();
  const closeAutoBackupRoutes = registerAutoBackupRoutes(app, autoBackup, security, auth.requireAdmin);
  app.use('/uploads', express.static(uploadsDir, { dotfiles: 'deny', index: false, cacheControl: false, etag: false, lastModified: false }));
  const upload = imageUpload(stagingDir);
  const imports = new Set<Promise<void>>();
  const syncRequests = new Set<Promise<void>>();
  let closing = false;
  function syncRequest(handler: (req: express.Request) => Promise<unknown>): express.RequestHandler {
    return (req, res, next) => {
      // Keep the permit until work settles, even when the HTTP client disconnects.
      if (closing || syncRequests.size >= 8) { res.setHeader('Retry-After', '3'); next(new ApiError(429, '正在等待网盘检测的请求较多，请稍后重试')); return; }
      const operation = handler(req).then(result => { if (!res.destroyed) res.json(result); });
      syncRequests.add(operation);
      void operation.catch(next).finally(() => syncRequests.delete(operation));
    };
  }
  function imageImport(handler: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler {
    return (req, res, next) => {
      if (closing || imports.size >= 2) { res.setHeader('Retry-After', '3'); next(new ApiError(429, '图片导入任务较多，请稍后重试')); return; }
      const operation = (async () => {
        await assertDiskSpace(dataDir, (imports.size + 1) * MAX_IMAGE_BATCH_BYTES * 2);
        await receiveMultipart(upload, req, res);
        if (req.aborted || res.destroyed) { await cleanup(filesFrom(req).map(file => file.path)); throw new ApiError(400, '图片导入已取消'); }
        await handler(req, res);
      })();
      imports.add(operation);
      void operation.catch(next).finally(() => imports.delete(operation));
    };
  }
  async function cleanup(paths: string[]) { await Promise.all(paths.map(path => unlink(path).catch(() => undefined))); }
  async function processImages(files: StagedImage[], signal: AbortSignal): Promise<{ images: GalleryImage[]; paths: string[] }> {
    const images: GalleryImage[] = []; const paths: string[] = [];
    try {
      for (const file of files) {
        signal.throwIfAborted();
        await assertDiskSpace(dataDir, file.size * 2);
        const decoder = sharp(file.path, { limitInputPixels: 100_000_000, failOn: 'error', animated: false }).timeout({ seconds: 30 });
        try {
        const metadata = await decoder.metadata();
        const formats: Record<string, string> = { jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif', avif: 'avif', heif: 'avif' };
        if (!metadata.format || !formats[metadata.format] || (metadata.format === 'heif' && metadata.compression !== 'av1') || !metadata.width || !metadata.height) throw new ApiError(400, '仅支持 JPG、PNG、WebP、GIF 和 AVIF 图片');
        const id = randomUUID();
        const imageName = `${id}.${formats[metadata.format]}`;
        const thumbName = `${id}.thumb.webp`;
        const originalPath = join(uploadsDir, imageName); const thumbPath = join(uploadsDir, thumbName);
        paths.push(originalPath, thumbPath);
        await decoder.rotate().resize({ width: 760, height: 1000, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toFile(thumbPath);
        await rename(file.path, originalPath);
        const rotated = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
        images.push({ id, url: `/uploads/${imageName}`, thumbnailUrl: `/uploads/${thumbName}`, name: displayFilename(file.originalname), width: rotated ? metadata.height : metadata.width, height: rotated ? metadata.width : metadata.height, size: file.size });
        } finally { decoder.destroy(); }
      }
      signal.throwIfAborted();
      return { images, paths };
    } catch (error) {
      await cleanup(paths);
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, '图片无法读取或文件已损坏，请使用有效的 JPG、PNG、WebP、GIF 或 AVIF 图片');
    } finally { await cleanup(files.map(file => file.path)); }
  }
  const filesFrom = (req: express.Request) => Array.isArray(req.files) ? req.files : [];
  function metadataFrom(req: express.Request): unknown {
    try { return JSON.parse(req.body.metadata ?? '{}'); } catch { throw new ApiError(400, '图集信息格式不正确'); }
  }
  function sourcesFrom(req: express.Request, raw: unknown): string[] {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError(400, '图集信息格式不正确');
    let sources: string[];
    try { sources = parseImageSources((raw as { remoteImages?: unknown }).remoteImages); }
    catch (error) { throw new ApiError(400, error instanceof Error ? error.message : '网络图片链接格式不正确'); }
    if (filesFrom(req).length + sources.length > MAX_IMAGE_SOURCES) throw new ApiError(400, '本地图片和网络图片合计每次最多导入 100 张');
    return sources;
  }
  async function prepareImport(req: express.Request, res: express.Response, sources: string[]) {
    const files: StagedImage[] = [...filesFrom(req)];
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', disconnected);
    let downloadedSize = files.reduce((sum, file) => sum + file.size, 0);
    try {
      for (const [index, url] of sources.entries()) {
        signal.throwIfAborted();
        let file: StagedImage;
        try { file = await (options.downloadRemoteImage ?? downloadRemoteImage)(url, stagingDir, { signal }); }
        catch (error) {
          throw new ApiError(400, `第 ${index + 1} 张网络图片导入失败：${error instanceof ApiError ? error.message : '无法下载图片，请检查链接'}`);
        }
        files.push(file);
        downloadedSize += file.size;
        if (downloadedSize > MAX_IMAGE_BATCH_BYTES) throw new ApiError(400, '每批图片合计不能超过 300 MB，请分批导入');
      }
      signal.throwIfAborted();
      return await processImages(files, signal);
    } catch (error) {
      if (signal.aborted) throw new ApiError(400, '网络图片导入超时或已取消，请减少数量后重试');
      throw error;
    } finally {
      res.off('close', disconnected);
      await cleanup(files.map(file => file.path));
    }
  }
  const imagePaths = (images: GalleryImage[]) => images.flatMap(image => [join(uploadsDir, basename(image.url)), join(uploadsDir, basename(image.thumbnailUrl))]);
  app.get('/api/categories', (_req, res) => res.json(db.categories()));
  app.post('/api/categories', (req, res) => res.status(201).json(db.createCategory(req.body?.name)));
  app.patch('/api/categories/:name', (req, res) => res.json(db.renameCategory(String(req.params.name), req.body?.name)));
  app.delete('/api/categories/:name', (req, res) => res.json(db.deleteCategory(String(req.params.name))));
  app.get('/api/albums', (_req, res) => res.json(db.albums()));
  app.get('/api/albums/:id', (req, res) => res.json(db.requireAlbum(String(req.params.id))));
  app.post('/api/albums', imageImport(async (req, res) => {
    let prepared: Awaited<ReturnType<typeof processImages>> | undefined;
    try {
      const raw = metadataFrom(req);
      const sources = sourcesFrom(req, raw);
      const now = new Date().toISOString();
      const input = normalizeInput(raw, undefined, now);
      prepared = await prepareImport(req, res, sources);
      const album: Album = { id: randomUUID(), ...input, favorite: input.favorite ?? false, createdAt: now, updatedAt: now, localUpdatedAt: now, updateSource: 'local', images: prepared.images };
      db.save(album);
      res.status(201).json(album);
    } catch (error) { await cleanup([...(prepared?.paths ?? []), ...filesFrom(req).map(file => file.path)]); throw error; }
  }));
  app.patch('/api/albums/:id', (req, res) => {
    const old = db.requireAlbum(String(req.params.id));
    const now = new Date().toISOString();
    const input = normalizeInput(req.body, old, now);
    const content = (value: Pick<Album, 'title' | 'description' | 'category' | 'tags' | 'links'>) => JSON.stringify({
      title: value.title, description: value.description, category: value.category, tags: value.tags,
      links: value.links.map(({ id, label, url, code, password, note, syncEnabled }) => ({ id, label, url, code, password, note, syncEnabled })),
    });
    const contentChanged = content(old) !== content(input);
    const album = db.save({ ...old, ...input, favorite: input.favorite ?? false, localUpdatedAt: contentChanged ? now : old.localUpdatedAt });
    res.json(album);
  });
  app.post('/api/albums/:id/images', imageImport(async (req, res) => {
    let prepared: Awaited<ReturnType<typeof processImages>> | undefined;
    try {
      const id = String(req.params.id);
      const current = db.requireAlbum(id);
      const raw = metadataFrom(req);
      const sources = sourcesFrom(req, raw);
      normalizeInput(raw, current);
      if (current.images.length + filesFrom(req).length + sources.length > 1000) throw new ApiError(400, '每个图集最多保存 1000 张图片');
      if (!filesFrom(req).length && !sources.length) throw new ApiError(400, '请选择本地图片或粘贴网络图片链接');
      prepared = await prepareImport(req, res, sources);
      const latest = db.requireAlbum(id);
      if (latest.images.length + prepared.images.length > 1000) throw new ApiError(400, '每个图集最多保存 1000 张图片');
      const now = new Date().toISOString();
      const input = normalizeInput(raw, latest, now);
      res.json(db.save({ ...latest, ...input, favorite: input.favorite ?? latest.favorite, images: [...latest.images, ...prepared.images], localUpdatedAt: now }));
    } catch (error) { await cleanup([...(prepared?.paths ?? []), ...filesFrom(req).map(file => file.path)]); throw error; }
  }));
  app.delete('/api/albums/:id', async (req, res) => {
    const album = db.requireAlbum(String(req.params.id));
    db.remove(album.id); await cleanup(imagePaths(album.images)); res.json({ ok: true });
  });
  app.delete('/api/albums/:id/images/:imageId', async (req, res) => {
    const album = db.requireAlbum(String(req.params.id));
    const image = album.images.find(item => item.id === req.params.imageId);
    if (!image) throw new ApiError(404, '图片不存在');
    album.images = album.images.filter(item => item.id !== image.id); album.localUpdatedAt = new Date().toISOString();
    db.save(album); await cleanup(imagePaths([image])); res.json(album);
  });
  app.post('/api/albums/:id/sync', syncRequest(req => scheduler.syncAlbum(String(req.params.id))));
  app.post('/api/sync', syncRequest(() => scheduler.syncAll()));
  app.post('/api/link-checks', syncRequest(() => scheduler.checkAllLinks()));
  app.post('/api/albums/:id/link-checks', syncRequest(req => scheduler.checkAlbumLinks(String(req.params.id))));
  app.post('/api/albums/:id/links/:linkId/check', syncRequest(req => scheduler.checkLink(String(req.params.id), String(req.params.linkId))));
  app.get('/api/settings', (_req, res) => res.json(db.settings()));
  app.patch('/api/settings', (req, res) => res.json(db.updateSettings(req.body)));
  app.get('/api/logs', (_req, res) => res.json(db.logs()));
  const closeBackups = await registerBackupRoutes(app, db, uploadsDir);
  const closeBackupImports = await registerBackupImportRoutes(app, db, uploadsDir);
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent || res.destroyed) { res.destroy(); return; }
    if (error instanceof ApiError) return res.status(error.status).json({ error: error.message });
    if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? '单张图片不能超过 30 MB' : '上传失败：每次最多 100 张图片，请检查上传字段和文件大小' });
    if (error instanceof SyntaxError) return res.status(400).json({ error: '请求内容格式不正确' });
    reportRuntimeError('request-failed', error);
    res.status(500).json({ error: '操作失败，请重试' });
  });
  const closeMaintenance = startMaintenance(db, () => capacity.active() > 0 || imports.size > 0);
  let closed: Promise<void> | undefined;
  return { app, db, scheduler, security, autoBackup, close: () => closed ??= (async () => {
    closing = true;
    closeAutoBackupRoutes();
    await autoBackup.close();
    await closeMaintenance();
    await scheduler.stop(); auth.close();
    await Promise.allSettled([...syncRequests]);
    await Promise.allSettled([...imports]);
    await closeBackups(); await closeBackupImports(); await security.close(); db.close();
  })() };
}

async function main() {
  const dataDirectory = resolve(process.env.DATA_DIR ?? join(projectRoot, 'data'));
  await assertPrivateDataDirectory(dataDirectory, projectRoot);
  const releaseLock = acquireInstanceLock(dataDirectory);
  process.once('exit', releaseLock);
  configureRuntimeLogging(dataDirectory);
  // Both the development entry point and production service protect public traffic.
  const runtime = await createApp({ requireHttps: true });
  const production = process.argv.includes('--production');
  let vite: Awaited<ReturnType<(typeof import('vite'))['createServer']>> | undefined;
  if (production) {
    const dist = join(projectRoot, 'dist');
    if (!existsSync(join(dist, 'index.html'))) throw new Error('请先运行 pnpm build 生成页面');
    runtime.app.use(express.static(dist, { index: false }));
    runtime.app.get('/{*path}', (_req, res) => res.sendFile(join(dist, 'index.html')));
  } else {
    const { createServer } = await import('vite');
    vite = await createServer({
      root: projectRoot, publicDir: false,
      server: { middlewareMode: true, fs: await getPrivateDevFs(runtime.db.directory) }, appType: 'spa',
    });
    runtime.app.use(vite.middlewares);
  }
  const port = Number(process.env.PORT ?? 3210); const host = process.env.HOST ?? '127.0.0.1';
  const server = runtime.app.listen(port, host, () => {
    console.log(`拾光图集已启动：http://${host}:${port}`);
    runtime.scheduler.start();
    runtime.autoBackup.start();
  });
  server.requestTimeout = 300_000;
  server.headersTimeout = 15_000;
  server.setTimeout(300_000);
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1000;
  server.maxConnections = 256;
  let closing = false;
  async function shutdown() {
    if (closing) return; closing = true;
    const drained = new Promise<void>(done => server.close(() => done()));
    const force = setTimeout(() => server.closeAllConnections(), 15_000); force.unref();
    try { await drained; await vite?.close(); await runtime.close(); }
    finally { clearTimeout(force); }
  }
  process.on('SIGINT', () => { void shutdown().catch(error => { reportRuntimeError('shutdown-failed', error); process.exitCode = 1; }); });
  process.on('SIGTERM', () => { void shutdown().catch(error => { reportRuntimeError('shutdown-failed', error); process.exitCode = 1; }); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : '启动失败'); process.exitCode = 1; });
}
