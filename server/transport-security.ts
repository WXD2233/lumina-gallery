import type { Request, RequestHandler } from 'express';

/** Only a direct connection on this machine may use the local HTTP exception. */
export function isDirectLoopbackRequest(req: Request): boolean {
  const peer = req.socket.remoteAddress;
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const host = req.get('Host') ?? '';
  const directHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
  const forwarded = Object.keys(req.headers).some(name => name === 'forwarded' || name.startsWith('x-forwarded-') || name === 'x-real-ip');
  return loopback && directHost && !forwarded;
}

export const requireSecureTransport: RequestHandler = (req, res, next) => {
  // req.secure accepts forwarding information only from explicitly trusted proxies.
  // An HTTPS Origin header alone is never evidence of encrypted transport.
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    return next();
  }
  if (isDirectLoopbackRequest(req)) return next();
  res.setHeader('Cache-Control', 'no-store');
  res.status(403).json({ error: '公网访问必须使用 HTTPS。请配置 HTTPS 反向代理和 TRUSTED_PROXIES 后访问。' });
};
