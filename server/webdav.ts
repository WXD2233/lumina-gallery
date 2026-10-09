import { lookup as dnsLookup } from 'node:dns/promises';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { basename, dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AutoBackupEntry } from '../shared/auto-backup.ts';
import { isPublicIp, resolvePublicImageUrl, type ImageLookup, type ResolvedImageUrl } from './remote-images.ts';

const MAX_DAV_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const PROPFIND_BODY = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';
const REMOTE_FILE = /^lumina-gallery-auto-\d{8}T\d{6}Z-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.zip$/;

export interface WebDavTarget { url: string; username: string; password: string }
export interface WebDavResponse { status: number; body: Buffer }
export interface WebDavRequest {
  target: ResolvedImageUrl;
  method: string;
  headers: Record<string, string>;
  body?: Readable;
  signal: AbortSignal;
}
export interface WebDavDependencies {
  lookup?: ImageLookup;
  request?: (input: WebDavRequest) => Promise<WebDavResponse>;
}

function davError(): Error { return new Error('WebDAV 请求失败，请检查 HTTPS 地址、账号权限和远程目录'); }

function safeUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw davError(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port && url.port !== '443') throw davError();
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url;
}

async function lookupPinned(url: URL, lookup?: ImageLookup): Promise<ResolvedImageUrl> {
  const checked = await resolvePublicImageUrl(url.href, lookup);
  if (checked.url.protocol !== 'https:') throw davError();
  return checked;
}

function basicAuth(target: WebDavTarget): string {
  return `Basic ${Buffer.from(`${target.username}:${target.password}`, 'utf8').toString('base64')}`;
}

async function nativeRequest(input: WebDavRequest): Promise<WebDavResponse> {
  const { target, method, headers, body, signal } = input;
  signal.throwIfAborted();
  const responsePromise = new Promise<WebDavResponse>((resolveResponse, reject) => {
    const req = httpsRequest(target.url, {
      method, agent: false, family: target.family,
      lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
      headers: { ...headers, Host: target.url.host, 'User-Agent': 'Lumina-Gallery/1.0' },
      signal,
    }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_DAV_RESPONSE_BYTES) { response.destroy(davError()); return; }
        chunks.push(Buffer.from(chunk));
      });
      response.once('error', reject);
      response.once('end', () => resolveResponse({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(davError()));
    req.once('error', reject);
    if (body) void pipeline(body, req, { signal }).catch(reject);
    else req.end();
  });
  return responsePromise;
}

function decodeXml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#39|#x[0-9a-f]+|#\d+);/gi, token => {
    const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" };
    const key = token.toLowerCase();
    if (named[key]) return named[key]!;
    const hex = /^&#x([0-9a-f]+);$/i.exec(token); const dec = /^&#(\d+);$/.exec(token);
    const point = hex ? Number.parseInt(hex[1]!, 16) : dec ? Number.parseInt(dec[1]!, 10) : NaN;
    return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : token;
  });
}

function remoteNames(xml: string, collection: URL): string[] {
  if (xml.length > MAX_DAV_RESPONSE_BYTES || !/<(?:[\w.-]+:)?multistatus\b/i.test(xml) || !/<\/(?:[\w.-]+:)?multistatus\s*>/i.test(xml)) throw davError();
  const names = new Set<string>();
  let sawCollection = false;
  const responsePattern = /<(?:[\w.-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?response\s*>/gi;
  let response: RegExpExecArray | null;
  const collectionPath = collection.pathname.replace(/\/+$/, '');
  const childPrefix = `${collectionPath}/`;
  while ((response = responsePattern.exec(xml))) {
    const hrefMatch = /<(?:[\w.-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?href\s*>/i.exec(response[1]!);
    if (!hrefMatch) continue;
    let href: URL;
    try { href = new URL(decodeXml(hrefMatch[1]!.trim()), collection); } catch { continue; }
    if (href.origin !== collection.origin) continue;
    if (href.pathname.replace(/\/+$/, '') === collectionPath) { sawCollection = true; continue; }
    if (!href.pathname.startsWith(childPrefix)) continue;
    const encodedName = href.pathname.slice(childPrefix.length).replace(/\/$/, '');
    if (!encodedName) continue;
    if (encodedName.includes('/')) continue;
    let name: string;
    try { name = decodeURIComponent(encodedName); } catch { continue; }
    if (REMOTE_FILE.test(name)) names.add(name);
  }
  if (!sawCollection) throw davError();
  return [...names].sort().reverse();
}

function makeName(entry: AutoBackupEntry): string {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(entry.id) || !Number.isFinite(Date.parse(entry.createdAt))) throw davError();
  const timestamp = new Date(entry.createdAt).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `lumina-gallery-auto-${timestamp}-${entry.id}.zip`;
}

export async function uploadAutomaticBackupToWebDav(
  credentials: WebDavTarget,
  entry: AutoBackupEntry & { path: string },
  retainCount = 7,
  dependencies: WebDavDependencies = {},
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  if (!Number.isInteger(retainCount) || retainCount < 1 || retainCount > 20) throw davError();
  const collection = safeUrl(credentials.url);
  const pinned = await lookupPinned(collection, dependencies.lookup);
  signal.throwIfAborted();
  const request = dependencies.request ?? nativeRequest;
  const authorization = basicAuth(credentials);
  const filename = makeName(entry);
  const destination = new URL(encodeURIComponent(filename), collection);
  const filePath = resolve(entry.path);
  const parent = dirname(filePath);
  if (basename(filePath) !== entry.filename || basename(parent) !== `backup-${entry.id}` || !Number.isSafeInteger(entry.size) || entry.size <= 0) throw davError();
  const directoryInfo = await lstat(parent);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw davError();
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.size) throw davError();
  signal.throwIfAborted();
  const put = await request({ target: { ...pinned, url: destination }, method: 'PUT', headers: { Authorization: authorization, 'Content-Type': 'application/zip', 'Content-Length': String(entry.size) }, body: createReadStream(filePath), signal });
  if (![200, 201, 204].includes(put.status)) throw davError();

  const listing = await request({ target: pinned, method: 'PROPFIND', headers: { Authorization: authorization, Depth: '1', 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': String(Buffer.byteLength(PROPFIND_BODY)) },
    body: Readable.from([PROPFIND_BODY]), signal });
  if (![200, 207].includes(listing.status)) throw davError();
  const names = remoteNames(listing.body.toString('utf8'), collection);
  for (const stale of names.slice(retainCount)) {
    signal.throwIfAborted();
    const deleteUrl = new URL(encodeURIComponent(stale), collection);
    const deleted = await request({ target: { ...pinned, url: deleteUrl }, method: 'DELETE', headers: { Authorization: authorization }, signal });
    if (![200, 202, 204, 404].includes(deleted.status)) throw davError();
  }
}

export async function testWebDavConnection(credentials: WebDavTarget, dependencies: WebDavDependencies = {}, signal: AbortSignal = new AbortController().signal): Promise<void> {
  const collection = safeUrl(credentials.url);
  const pinned = await lookupPinned(collection, dependencies.lookup);
  const response = await (dependencies.request ?? nativeRequest)({ target: pinned, method: 'PROPFIND', headers: {
    Authorization: basicAuth(credentials), Depth: '0', 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': String(Buffer.byteLength(PROPFIND_BODY)),
  }, body: Readable.from([PROPFIND_BODY]), signal });
  if (![200, 207].includes(response.status)) throw davError();
  remoteNames(response.body.toString('utf8'), collection);
}

/** Exposed for deterministic tests and to keep WebDAV DNS pinning aligned with image imports. */
export function isSafeWebDavAddress(address: string): boolean { return isPublicIp(address); }
