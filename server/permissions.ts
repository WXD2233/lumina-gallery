import type { RequestHandler } from 'express';

/** Viewers share the gallery, but can only change their own profile/password.
 * Backup generation is a read/export operation. Imports and administrative
 * endpoints are guarded before parsing bodies or staging uploaded files. */
export function galleryPermissions(requireAdmin: RequestHandler): RequestHandler {
  return (req, res, next) => {
    if (res.locals.authUser?.role === 'admin') return next();
    const path = req.path;
    const administrative = /^\/(?:admin|backup-imports)(?:\/|$)/i.test(path);
    if (!administrative && ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const ownAvatar = /^\/profile\/avatar\/?$/i.test(path) && ['POST', 'DELETE'].includes(req.method);
    const exportGallery = /^\/backups\/?$/i.test(path) && req.method === 'POST';
    if (ownAvatar || exportGallery) return next();
    return requireAdmin(req, res, next);
  };
}
