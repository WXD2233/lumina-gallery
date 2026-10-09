import type { RequestHandler, Request, Response } from 'express';
import multer from 'multer';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { statfs, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ApiError } from './db.ts';

export const MIN_FREE_DISK_BYTES = 512 * 1024 * 1024;
export const MAX_IMAGE_BATCH_BYTES = 300 * 1024 * 1024;

export async function assertDiskSpace(directory: string, requiredBytes = 0): Promise<void> {
  const space = await statfs(directory);
  if (space.bavail * space.bsize < MIN_FREE_DISK_BYTES + Math.max(0, requiredBytes)) {
    throw new ApiError(507, '磁盘可用空间不足，请释放空间后重试（至少保留 512 MB 运行空间）');
  }
}

export function receiveMultipart(upload: RequestHandler, req: Request, res: Response, timeoutMs = 300_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (req.aborted || res.destroyed || (req.destroyed && !req.complete)) { reject(new ApiError(400, '上传已取消')); return; }
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      req.off('aborted', cancelled); res.off('close', closed);
      if (error) reject(error); else resolve();
    };
    const cancelled = () => { req.destroy(); finish(new ApiError(400, '上传已取消')); };
    const closed = () => { if (!res.writableEnded) cancelled(); };
    const timer = setTimeout(() => { req.destroy(); finish(new ApiError(408, '上传超时，请分批上传后重试')); }, timeoutMs); timer.unref();
    req.once('aborted', cancelled); res.once('close', closed);
    try { upload(req, res, finish); } catch (error) { finish(error); }
  });
}

/** Count chunked multipart bodies too, instead of relying on Content-Length. */
export function imageUpload(directory: string, maxBatchBytes = MAX_IMAGE_BATCH_BYTES): RequestHandler {
  const requests = new WeakMap<Express.Request, { bytes: number; controller: AbortController }>();
  const storage: multer.StorageEngine = {
    _handleFile(req, file, callback) {
      const filename = randomBytes(16).toString('hex');
      const path = join(directory, filename);
      let state = requests.get(req);
      if (!state) {
        state = { bytes: 0, controller: new AbortController() };
        requests.set(req, state);
        const aborted = () => state!.controller.abort();
        req.once('aborted', aborted);
        req.once('close', () => req.off('aborted', aborted));
      }
      const { controller } = state;
      if (req.aborted) controller.abort();
      let size = 0;
      const counter = new Transform({ transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        state!.bytes += chunk.length;
        done(state!.bytes > maxBatchBytes ? new ApiError(413, '每批图片合计不能超过 300 MB，请分批导入') : null, chunk);
      } });
      void pipeline(file.stream, counter, createWriteStream(path, { flags: 'wx' }), { signal: controller.signal })
        .then(() => callback(null, { destination: directory, filename, path, size }))
        .catch(async error => { await unlink(path).catch(() => undefined); callback(error); });
    },
    _removeFile(_req, file, callback) { void unlink(file.path).then(() => callback(null)).catch(error => callback(error.code === 'ENOENT' ? null : error)); },
  };
  return multer({ storage, limits: { fileSize: 30 * 1024 * 1024, files: 100, fields: 1, fieldSize: 256 * 1024, parts: 101 } }).array('images', 100);
}

export function requestCapacity(limit = 256): { middleware: RequestHandler; active: () => number } {
  let count = 0;
  const middleware: RequestHandler = (_req, res, next) => {
    if (count >= limit) { res.setHeader('Retry-After', '3'); res.status(503).json({ error: '服务请求较多，请稍后重试' }); return; }
    count++;
    let released = false;
    const release = () => { if (!released) { released = true; count--; res.off('finish', release); res.off('close', release); } };
    res.once('finish', release); res.once('close', release);
    next();
  };
  return { middleware, active: () => count };
}
