import type { Express, Request, Response } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { MAX_AVATAR_BYTES, type Profile } from '../shared/profile.ts';
import type { AuthPrincipal } from '../shared/auth.ts';
import { ApiError, type GalleryDb } from './db.ts';

const AVATAR_PIXELS = 25_000_000;
const AVATAR_SIZE = 384;

// Register only after the API authentication guard. Profile data is deliberately
// separate from gallery backup tables, so restoring a gallery retains its account.
export function registerProfileRoutes(app: Express, db: GalleryDb): void {
  const existing = db.connection.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'account_profile'").get();
  if (existing && /CHECK\s*\(\s*id\s*=\s*1\s*\)/i.test(String(existing.sql))) {
    db.connection.exec('SAVEPOINT profile_multiuser');
    try {
      db.connection.exec(`CREATE TABLE account_profile_multi (id INTEGER PRIMARY KEY, avatar BLOB NOT NULL, revision TEXT NOT NULL);
        INSERT INTO account_profile_multi SELECT id,avatar,revision FROM account_profile;
        DROP TABLE account_profile;
        ALTER TABLE account_profile_multi RENAME TO account_profile;
        RELEASE SAVEPOINT profile_multiuser;`);
    } catch (error) {
      db.connection.exec('ROLLBACK TO SAVEPOINT profile_multiuser; RELEASE SAVEPOINT profile_multiuser');
      throw error;
    }
  }
  db.connection.exec(`CREATE TABLE IF NOT EXISTS account_profile (
    id INTEGER PRIMARY KEY,
    avatar BLOB NOT NULL,
    revision TEXT NOT NULL
  )`);
  const findProfile = db.connection.prepare('SELECT revision FROM account_profile WHERE id = ?');
  const findAvatar = db.connection.prepare('SELECT avatar FROM account_profile WHERE id = ?');
  const saveAvatar = db.connection.prepare(`INSERT INTO account_profile(id, avatar, revision) VALUES(?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET avatar = excluded.avatar, revision = excluded.revision`);
  const clearAvatar = db.connection.prepare('DELETE FROM account_profile WHERE id = ?');
  const accountId = (res: Response): number => (res.locals.authUser as AuthPrincipal).id;
  const profile = (id: number): Profile => {
    const record = findProfile.get(id);
    return { avatarUrl: record ? `/api/profile/avatar?v=${encodeURIComponent(String(record.revision))}` : null };
  };

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_AVATAR_BYTES, files: 1, fields: 0, parts: 2 },
  }).single('avatar');
  const parseUpload = (req: Request, res: Response) => new Promise<void>((resolve, reject) => {
    const abort = () => reject(new ApiError(400, '头像上传已中断，请重试'));
    req.once('aborted', abort);
    upload(req, res, error => {
      req.off('aborted', abort);
      if (error instanceof multer.MulterError) {
        reject(new ApiError(400, error.code === 'LIMIT_FILE_SIZE'
          ? '头像图片不能超过 5 MB'
          : '请只选择一张头像图片'));
      } else if (error) {
        reject(new ApiError(400, '头像上传失败，请重新选择图片'));
      } else resolve();
    });
  });

  // Bound both in-memory multipart uploads and image decodes. Rejected requests
  // do not enter the multipart parser or allocate a large input buffer.
  let activeUploads = 0;
  app.get('/api/profile', (_req, res) => res.json(profile(accountId(res))));
  app.get('/api/profile/avatar', (_req, res) => {
    const record = findAvatar.get(accountId(res));
    if (!record) throw new ApiError(404, '尚未设置头像');
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Content-Disposition', 'inline; filename="avatar.webp"');
    res.send(Buffer.from(record.avatar as Uint8Array));
  });
  app.post('/api/profile/avatar', async (req, res) => {
    if (activeUploads >= 2) {
      res.setHeader('Retry-After', '2');
      throw new ApiError(429, '正在处理头像，请稍后再试');
    }
    activeUploads += 1;
    try {
      await parseUpload(req, res);
      if (!req.file) throw new ApiError(400, '请选择一张头像图片');
      let image: Buffer;
      let decoder: ReturnType<typeof sharp> | undefined;
      try {
        decoder = sharp(req.file.buffer, {
          limitInputPixels: AVATAR_PIXELS, failOn: 'error', animated: false,
        });
        const metadata = await decoder.metadata();
        if (!metadata.format || !['jpeg', 'png', 'webp', 'gif', 'avif', 'heif'].includes(metadata.format)
          || (metadata.format === 'heif' && metadata.compression !== 'av1')
          || !metadata.width || !metadata.height) {
          throw new ApiError(400, '头像仅支持 JPG、PNG、WebP、GIF 和 AVIF 图片');
        }
        image = await decoder.rotate().resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'centre' })
          .webp({ quality: 85 }).timeout({ seconds: 15 }).toBuffer();
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(400, '头像无法读取或尺寸过大，请选择不超过 2500 万像素的有效图片');
      } finally { decoder?.destroy(); }
      if (req.aborted || res.destroyed) return;
      if (!db.connection.prepare(`SELECT 1 FROM auth_sessions AS s JOIN auth_users AS u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.user_id = ? AND s.expires_at > ? AND u.disabled = 0`)
        .get(String(res.locals.authSessionHash), accountId(res), Date.now())) throw new ApiError(401, '登录状态已变化，请重新登录');
      // A single atomic statement replaces only a fully decoded, normalized avatar.
      saveAvatar.run(accountId(res), image, randomUUID());
      res.json(profile(accountId(res)));
    } finally {
      delete req.file;
      activeUploads -= 1;
    }
  });
  app.delete('/api/profile/avatar', (_req, res) => {
    clearAvatar.run(accountId(res));
    res.json(profile(accountId(res)));
  });
}
