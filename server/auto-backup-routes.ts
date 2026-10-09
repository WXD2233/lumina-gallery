import type { Express, RequestHandler } from 'express';
import { AutoBackupService } from './auto-backup.ts';
import { ApiError } from './db.ts';
import type { SecurityService } from './security.ts';

export function registerAutoBackupRoutes(app: Express, service: AutoBackupService, security: SecurityService, requireAdmin: RequestHandler): () => void {
  const downloads = new Set<() => void>();
  let closing = false;
  const status = async () => {
    const value = await service.status();
    const mail = security.getSettings();
    return { ...value, webdav: security.getWebDavSettings(), emailReady: Boolean(mail.enabled && mail.host && mail.username && mail.hasPassword && mail.from && mail.to.length) };
  };
  app.get('/api/admin/auto-backups', requireAdmin, async (_req, res) => res.json(await status()));
  app.patch('/api/admin/auto-backups/settings', requireAdmin, async (req, res) => {
    await service.updateSettings(req.body); res.json(await status());
  });
  app.patch('/api/admin/auto-backups/webdav', requireAdmin, async (req, res) => {
    service.assertWebdavChangeAllowed();
    const settings = security.updateWebDavSettings(req.body);
    if (!settings.enabled) service.disableWebdavPending();
    res.json(await status());
  });
  app.post('/api/admin/auto-backups/webdav/test', requireAdmin, async (_req, res) => {
    await service.testWebdav(); res.json({ ok: true, message: 'WebDAV 连接成功' });
  });
  app.post('/api/admin/auto-backups/run', requireAdmin, async (_req, res) => {
    service.runNow(); res.status(202).json(await status());
  });
  app.get('/api/admin/auto-backups/:id/download', requireAdmin, async (req, res, next) => {
    if (closing) throw new ApiError(503, '备份服务正在关闭');
    if (downloads.size >= 4) throw new ApiError(429, '同时下载的备份过多，请稍后再试');
    const abort = () => { res.destroy(); };
    downloads.add(abort);
    let lease: Awaited<ReturnType<AutoBackupService['download']>> | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let released = false;
    const release = () => {
      if (released) return; released = true;
      if (deadline) clearTimeout(deadline);
      downloads.delete(abort); lease?.release();
      res.off('finish', release); res.off('close', release);
    };
    res.once('finish', release); res.once('close', release);
    try {
      lease = await service.download(String(req.params.id));
      if (released || res.destroyed || closing) { lease.release(); release(); return; }
      deadline = setTimeout(abort, 30 * 60_000); deadline.unref();
      res.setTimeout(2 * 60_000, abort);
      res.attachment(lease.filename); res.type('application/zip');
      res.sendFile(lease.path, { dotfiles: 'allow' }, error => { release(); if (error && !res.destroyed) next(error); });
    } catch (error) { release(); next(error); }
  });
  return () => { closing = true; for (const abort of downloads) abort(); downloads.clear(); };
}
