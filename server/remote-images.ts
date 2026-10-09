import { randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ApiError } from './db.ts';

export interface StagedImage { path: string; originalname: string; size: number; }
export type RemoteImageDownloader = (url: string, stagingDir: string, options: { signal: AbortSignal }) => Promise<StagedImage>;
export type ImageLookup = (hostname: string) => Promise<{ address: string; family: 4 | 6 }[]>;
export interface ResolvedImageUrl { url: URL; address: string; family: 4 | 6; }
export interface RemoteImageDependencies {
  lookup?: ImageLookup;
  request?: (target: ResolvedImageUrl, signal: AbortSignal) => Promise<IncomingMessage>;
  timeoutMs?: number;
  maxBytes?: number;
}
export const MAX_REMOTE_IMAGE_BYTES = 30 * 1024 * 1024;

function publicIpv4(address: string): boolean {
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}

/** Only globally routable destinations are accepted, including IPv4-mapped IPv6. */
export function isPublicIp(address: string): boolean {
  if (address.includes('%')) return false;
  const family = isIP(address);
  if (family === 4) return publicIpv4(address);
  if (family !== 6) return false;
  let normalized = address.toLowerCase();
  if (normalized.includes('.')) {
    const colon = normalized.lastIndexOf(':');
    const v4 = normalized.slice(colon + 1).split('.').map(Number);
    normalized = `${normalized.slice(0, colon)}:${((v4[0] << 8) + v4[1]).toString(16)}:${((v4[2] << 8) + v4[3]).toString(16)}`;
  }
  const halves = normalized.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const groups = (halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left).map(value => parseInt(value, 16));
  if (groups.slice(0, 5).every(value => value === 0) && groups[5] === 0xffff) {
    return publicIpv4(`${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`);
  }
  // Global unicast only; exclude protocol-assignment, documentation and 6to4 ranges.
  return groups[0] >= 0x2000 && groups[0] <= 0x3fff &&
    !(groups[0] === 0x2001 && (groups[1] < 0x0200 || groups[1] === 0x0db8)) &&
    groups[0] !== 0x2002 && !(groups[0] === 0x3fff && groups[1] <= 0x0fff);
}

let activeDnsLookups = 0;
const lookupPublic: ImageLookup = async hostname => {
  // OS DNS lookup cannot be cancelled. Keep abandoned lookups from building an
  // unbounded libuv queue when a resolver is slow or unreachable.
  if (activeDnsLookups >= 16) throw new Error('dns-capacity');
  activeDnsLookups++;
  try {
    return (await dnsLookup(hostname, { all: true, verbatim: true }))
      .map(value => ({ address: value.address, family: value.family as 4 | 6 }));
  } finally { activeDnsLookups--; }
};

export async function resolvePublicImageUrl(raw: string, lookup: ImageLookup = lookupPublic): Promise<ResolvedImageUrl> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ApiError(400, '图片链接格式不正确'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new ApiError(400, '图片链接只支持不含账号密码的 HTTP / HTTPS 标准端口地址');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: Awaited<ReturnType<ImageLookup>>;
  try {
    const family = isIP(hostname);
    addresses = family ? [{ address: hostname, family: family as 4 | 6 }] : await lookup(hostname);
  } catch { throw new ApiError(400, '图片链接的域名无法解析，请检查地址'); }
  if (!addresses.length || addresses.some(value => !isPublicIp(value.address) || isIP(value.address) !== value.family)) {
    throw new ApiError(400, '图片链接必须指向可公开访问的网络地址');
  }
  url.hash = '';
  return { url, ...addresses[0] };
}

function requestPinned(target: ResolvedImageUrl, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = target.url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(target.url, {
      method: 'GET', signal, agent: false, family: target.family,
      // Retain the original Host/SNI while connecting only to the address vetted above.
      lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
      headers: { Accept: 'image/avif,image/webp,image/*;q=0.9,*/*;q=0.5', 'User-Agent': 'Lumina-Gallery/1.0', 'Accept-Encoding': 'identity' },
    }, resolve);
    req.once('error', reject);
    req.end();
  });
}

function remoteFilename(url: URL): string {
  let name = url.pathname.split('/').at(-1) || '网络图片';
  try { name = decodeURIComponent(name); } catch { /* Preserve a usable URL basename. */ }
  return name.replace(/[\\/<>:"|?*\u0000-\u001f\u007f]/g, '_').slice(0, 200) || '网络图片';
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal, releaseLateValue?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => { settled = true; reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { signal.removeEventListener('abort', abort); abort(); }
    void promise.then(value => {
      signal.removeEventListener('abort', abort);
      if (settled) releaseLateValue?.(value);
      else { settled = true; resolve(value); }
    }, error => {
      signal.removeEventListener('abort', abort);
      if (!settled) { settled = true; reject(error); }
    });
  });
}

export function createRemoteImageDownloader(dependencies: RemoteImageDependencies = {}): RemoteImageDownloader {
  const request = dependencies.request ?? requestPinned;
  const maxBytes = dependencies.maxBytes ?? MAX_REMOTE_IMAGE_BYTES;
  return async (raw, stagingDir, options) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? 30_000);
    timeout.unref();
    const signal = AbortSignal.any([options.signal, controller.signal]);
    let temporaryPath: string | undefined;
    let response: IncomingMessage | undefined;
    try {
      let destination = raw;
      for (let redirects = 0; redirects <= 5; redirects++) {
        signal.throwIfAborted();
        const target = await abortable(resolvePublicImageUrl(destination, dependencies.lookup), signal);
        signal.throwIfAborted();
        response = await abortable(request(target, signal), signal, lateResponse => { lateResponse.destroy(); });
        if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
          const location = response.headers.location;
          response.destroy(); response = undefined;
          if (!location || redirects === 5) throw new ApiError(400, '图片链接跳转过多或跳转地址无效');
          try { destination = new URL(location, target.url).href; } catch { throw new ApiError(400, '图片链接跳转地址无效'); }
          continue;
        }
        if (response.statusCode !== 200) throw new ApiError(400, `图片链接无法下载（HTTP ${response.statusCode ?? '未知'}），请使用可直接打开的图片地址`);
        const type = (response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (type.startsWith('text/') || type === 'application/json' || type === 'application/xhtml+xml') throw new ApiError(400, '此链接返回的是网页，请粘贴图片直链');
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new ApiError(400, '图片服务器返回了不支持的压缩响应');
        const declaredSize = Number(response.headers['content-length'] ?? 0);
        if (declaredSize > maxBytes) throw new ApiError(400, '单张网络图片不能超过 30 MB');
        temporaryPath = join(stagingDir, `remote-${randomUUID()}`);
        let size = 0;
        const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          callback(size > maxBytes ? new ApiError(400, '单张网络图片不能超过 30 MB') : null, chunk);
        } });
        await pipeline(response, counter, createWriteStream(temporaryPath, { flags: 'wx' }), { signal });
        if (!size) throw new ApiError(400, '图片链接返回了空文件');
        return { path: temporaryPath, originalname: remoteFilename(target.url), size };
      }
      throw new ApiError(400, '图片链接跳转过多');
    } catch (error) {
      response?.destroy();
      if (temporaryPath) await unlink(temporaryPath).catch(() => undefined);
      if (signal.aborted) throw new ApiError(400, '网络图片下载超时或已取消，请减少数量后重试');
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, '图片链接无法访问，请检查地址或改用本地上传');
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  };
}

export const downloadRemoteImage = createRemoteImageDownloader();
