/** Best-effort adapter for Baidu's web share pages, not a guaranteed public API.
 * Only file server_mtime values determine freshness. A partial scan never succeeds.
 */
import type { LinkCheckResult, LinkHealthStatus } from '../shared/types.ts';

export interface BaiduShareInput { url: string; code?: string; cookie?: string; signal?: AbortSignal }
export interface BaiduShareInspection { updatedAt: string; fileCount: number; message: string }
export type BaiduLinkHealthStatus = Exclude<LinkHealthStatus, 'unchecked'>;
export type BaiduLinkHealthResult = LinkCheckResult;

/** Only these messages are deliberately safe to display outside the server. */
export class BaiduShareError extends Error {
  constructor(message: string, public readonly healthStatus: BaiduLinkHealthStatus = 'unknown') { super(message); this.name = 'BaiduShareError'; }
}

const HOSTS = new Set(['pan.baidu.com', 'yun.baidu.com']);
const PAGE_SIZE = 100;
const MAX_PAGES = 500;
const MAX_ENTRIES = 50_000;
const MAX_BODY = 4 * 1024 * 1024;
const MAX_COOKIE_BYTES = 32_768;
const MAX_COOKIE_COUNT = 128;
const MAX_ENTRY_KEY_BYTES = 16 * 1024 * 1024;
const SCAN_TIMEOUT = 180_000;
type Json = Record<string, unknown>;

function allowedUrl(value: string | URL): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new BaiduShareError('请输入完整的百度网盘 HTTPS 分享链接'); }
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.port || url.username || url.password) {
    throw new BaiduShareError('仅允许 pan.baidu.com 或 yun.baidu.com 的 HTTPS 链接', 'unsupported');
  }
  return url;
}

function parseInput(input: BaiduShareInput) {
  const original = allowedUrl(input.url.trim());
  let surl: string;
  const pathMatch = original.pathname.match(/^\/s\/1([A-Za-z0-9_-]+)\/?$/);
  if (pathMatch) surl = pathMatch[1];
  else if (original.pathname === '/share/init' || original.pathname === '/wap/init') surl = original.searchParams.get('surl') ?? '';
  else throw new BaiduShareError('请使用 /s/1… 或 /share/init?surl=… 格式的百度网盘分享链接', 'unsupported');
  if (!/^[A-Za-z0-9_-]{4,100}$/.test(surl)) throw new BaiduShareError('百度网盘分享链接不完整');
  const code = (input.code || original.searchParams.get('pwd') || '').trim();
  if (code && !/^[A-Za-z0-9]{4,6}$/.test(code)) throw new BaiduShareError('百度网盘提取码应为 4 至 6 位字母或数字', 'code_error');
  return { surl, code, pageUrl: `https://pan.baidu.com/s/1${surl}` };
}

function field(html: string, names: string[]): string | undefined {
  for (const name of names) {
    // Read scalar metadata only; never execute remote scripts or evaluate JS objects.
    const match = html.match(new RegExp(`(?:["']|\\b)${name}["']?\\s*[:=]\\s*["']?([A-Za-z0-9_+/=.-]+)`));
    if (match) return match[1];
  }
}

function parseJson(body: string): Json {
  try {
    const value: unknown = JSON.parse(body);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Json;
  } catch { /* Use a safe, useful error without disclosing remote response data. */ }
  pageError(body);
  throw new BaiduShareError('百度网盘未返回文件数据，可能需要登录或安全验证');
}

function checkError(data: Json, phase: 'verify' | 'list'): void {
  if (data.errno === 0 || data.errno === '0') return;
  const errno = Number(data.errno);
  if (data.vcode || data.vcode_str || [-62, -20].includes(errno)) throw new BaiduShareError('百度网盘要求安全验证或限制访问，请在浏览器完成验证后重试', 'verification_required');
  if ([-6, -12, 2, 8001].includes(errno)) throw new BaiduShareError('百度网盘需要有效登录状态，请在同步设置中更新百度 Cookie 后重试', 'login_required');
  // Web errno values are not a stable public contract. Only explicit expiry text
  // identifies a dead share; generic list failures must remain inconclusive.
  const message = [data.errmsg, data.err_msg, data.error_msg, data.show_msg].filter((value): value is string => typeof value === 'string').join(' ');
  if (isExpiredMessage(message)) throw new BaiduShareError('百度网盘明确提示分享已失效、被取消或过期', 'invalid');
  if (phase === 'verify' && errno === -9) throw new BaiduShareError('百度网盘提取码错误，请检查提取码', 'code_error');
  throw new BaiduShareError(`百度网盘${phase === 'verify' ? '提取码校验' : '目录读取'}失败${Number.isFinite(errno) ? `（错误码 ${errno}）` : ''}，本次未同步时间`);
}

function isExpiredMessage(message: string): boolean {
  return /(?:分享(?:链接|文件)?|链接)(?:已被|已经被|已|已经)?(?:失效|取消|过期|不存在)|(?:分享者|文件所有者)(?:已|已经)?取消(?:了)?分享|分享(?:的)?文件(?:已经被|已被|已经|已)?(?:删除|取消)|(?:文件|内容)(?:已被|已经被)(?:分享者)?删除|(?:该|此)分享(?:的)?(?:内容|文件)?(?:不存在|已失效|已过期)/.test(message);
}

function pageError(html: string): void {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
  // A healthy page may contain filenames or JavaScript translations mentioning
  // expiry. Restrict body matching to pages without usable share metadata.
  const shareid = field(html, ['shareid', 'share_id', 'shareId']);
  const uk = field(html, ['share_uk', 'shareuk', 'shareUk', 'uk']);
  if (shareid && /^\d+$/.test(shareid) && uk && /^\d+$/.test(uk) && uk !== '0') return;
  if (/验证码|安全验证|访问受限/.test(title)) throw new BaiduShareError('百度网盘要求安全验证，请在浏览器完成验证后重试', 'verification_required');
  if (/登录百度|百度.*登录|登录.*百度|^\s*登录\s*$/.test(title)) throw new BaiduShareError('百度网盘要求登录，请在同步设置中更新百度 Cookie 后重试', 'login_required');
  const visible = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  if (isExpiredMessage(title) || isExpiredMessage(visible)) throw new BaiduShareError('百度网盘分享已失效、被取消或过期', 'invalid');
  if (/请(?:先|完成|进行)?安全验证|请输入验证码|请完成验证/.test(visible)) throw new BaiduShareError('百度网盘要求安全验证，请在浏览器完成验证后重试', 'verification_required');
  if (/请(?:先|重新)?登录|登录后(?:访问|查看)/.test(visible)) throw new BaiduShareError('百度网盘要求登录，请在同步设置中更新百度 Cookie 后重试', 'login_required');
}

/** Inspect all visible files, including subdirectories, without downloading file bodies. */
async function readBaiduShare(
  input: BaiduShareInput,
  options: { fetchImpl?: typeof fetch },
  scanTimestamps: boolean,
): Promise<BaiduShareInspection | BaiduLinkHealthResult> {
  const { surl, code, pageUrl } = parseInput(input);
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  const cookies = new Map<string, string>();
  let cookieBytes = 0;
  function storeCookie(name: string, value: string) {
    const bytes = Buffer.byteLength(name) + Buffer.byteLength(value);
    const previous = cookies.get(name);
    const nextBytes = cookieBytes + bytes - (previous === undefined ? 0 : Buffer.byteLength(name) + Buffer.byteLength(previous));
    if (nextBytes > MAX_COOKIE_BYTES || (previous === undefined && cookies.size >= MAX_COOKIE_COUNT)) {
      throw new BaiduShareError('百度网盘返回的 Cookie 过多，本次未同步时间');
    }
    cookies.set(name, value); cookieBytes = nextBytes;
  }
  // The jar is local to this inspection: one share's access token cannot affect another.
  function addCookie(value: string) {
    const pair = value.split(';', 1)[0];
    const at = pair.indexOf('=');
    if (at > 0 && /^[!#$%&'*+.^_`|~\w-]+$/.test(pair.slice(0, at)) && !/[\r\n]/.test(pair)) {
      storeCookie(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
  }
  if (input.cookie) {
    if (/[\r\n]/.test(input.cookie) || input.cookie.length > 32_768) throw new BaiduShareError('百度 Cookie 格式无效');
    for (const pair of input.cookie.split(';')) addCookie(pair.trim());
  }
  const timeout = setTimeout(() => controller.abort(), scanTimestamps ? SCAN_TIMEOUT : 30_000);
  let rootAccessible = false;
  let requests = 0;
  async function request(value: string | URL, init: RequestInit = {}): Promise<string> {
    let url = allowedUrl(value);
    let requestInit = init;
    for (let redirects = 0; redirects <= 4; redirects++) {
      if (signal.aborted) throw new BaiduShareError('百度网盘检测超时或已取消，目录尚未全部读取，本次未同步时间', 'network_error');
      if (++requests > MAX_PAGES + 15) throw new BaiduShareError('百度网盘目录过大，超出本次检测上限，本次未同步时间');
      const headers = new Headers(requestInit.headers);
      headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36');
      headers.set('Referer', pageUrl);
      headers.set('Accept', 'application/json, text/html;q=0.9, */*;q=0.8');
      if (cookies.size) headers.set('Cookie', [...cookies].map(([key, val]) => `${key}=${val}`).join('; '));
      let response: Response;
      try { response = await fetchImpl(url, { ...requestInit, headers, redirect: 'manual', signal }); }
      catch { throw new BaiduShareError(signal.aborted ? '百度网盘检测超时或已取消，本次未同步时间' : '无法连接百度网盘，请检查网络后重试', 'network_error'); }
      try {
      // Never trust a client that followed a redirect itself either.
      if (response.url) allowedUrl(response.url);
      for (const cookie of response.headers.getSetCookie()) addCookie(cookie);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw new BaiduShareError('百度网盘返回了无效跳转');
        const next = new URL(location, url);
        if (next.hostname === 'passport.baidu.com') throw new BaiduShareError('百度网盘要求登录，请在同步设置中更新百度 Cookie 后重试', 'login_required');
        url = allowedUrl(next);
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && requestInit.method === 'POST')) requestInit = {};
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401) throw new BaiduShareError('百度网盘要求登录，请在同步设置中更新百度 Cookie 后重试', 'login_required');
        throw new BaiduShareError(response.status === 429 || response.status === 403 ? '百度网盘限制访问或要求安全验证，请稍后重试' : `百度网盘请求失败（HTTP ${response.status}）`, response.status === 429 || response.status === 403 ? 'verification_required' : response.status >= 500 ? 'network_error' : 'unknown');
      }
      if (Number(response.headers.get('content-length')) > MAX_BODY) {
        await response.body?.cancel();
        throw new BaiduShareError('百度网盘响应过大，本次未同步时间');
      }
      if (!response.body) throw new BaiduShareError('百度网盘返回空响应');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > MAX_BODY) { await reader.cancel(); throw new BaiduShareError('百度网盘响应过大，本次未同步时间'); }
          chunks.push(part.value);
        }
      } catch (error) {
        if (signal.aborted) throw new BaiduShareError('百度网盘检测超时或已取消，本次未同步时间', 'network_error');
        if (error instanceof BaiduShareError) throw error;
        throw new BaiduShareError('百度网盘响应读取失败，本次未同步时间', 'network_error');
      } finally { reader.releaseLock(); }
      return Buffer.concat(chunks).toString('utf8');
      } finally {
        // Includes rejected response URLs, malformed cookies and body read errors.
        await response.body?.cancel().catch(() => undefined);
      }
    }
    throw new BaiduShareError('百度网盘跳转次数过多，请检查分享链接');
  }
  try {
    let html = await request(pageUrl);
    pageError(html);
    let shareid = field(html, ['shareid', 'share_id', 'shareId']);
    let uk = field(html, ['share_uk', 'shareuk', 'shareUk', 'uk']);
    let sekey = '';
    const requiresCode = /<title[^>]*>[^<]*提取码|\/share\/init\?|id=["']accessCode/i.test(html);
    if (requiresCode && !code) throw new BaiduShareError('此百度网盘分享需要提取码，请编辑网盘链接并填写', 'code_required');
    if (code) {
      const verifyUrl = new URL('https://pan.baidu.com/share/verify');
      verifyUrl.search = new URLSearchParams({ surl, web: '1', channel: 'chunlei', app_id: '250528', clienttype: '0' }).toString();
      const baiduid = cookies.get('BAIDUID');
      if (baiduid) verifyUrl.searchParams.set('logid', Buffer.from(baiduid).toString('base64'));
      const verified = parseJson(await request(verifyUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
        body: new URLSearchParams({ pwd: code, vcode: '', vcode_str: '' }).toString(),
      }));
      checkError(verified, 'verify');
      if (typeof verified.randsk !== 'string' || !verified.randsk) throw new BaiduShareError('百度网盘未返回有效分享凭据，本次未同步时间');
      try { sekey = decodeURIComponent(verified.randsk); } catch { throw new BaiduShareError('百度网盘分享凭据格式异常'); }
      storeCookie('BDCLND', encodeURIComponent(sekey));
      html = await request(pageUrl);
      pageError(html);
      shareid = field(html, ['shareid', 'share_id', 'shareId']) || shareid;
      uk = field(html, ['share_uk', 'shareuk', 'shareUk', 'uk']) || uk;
    }
    if (!shareid || !/^\d+$/.test(shareid) || !uk || !/^\d+$/.test(uk) || uk === '0') {
      throw new BaiduShareError('无法读取百度网盘分享信息，暂不能确定链接是否有效，请在浏览器中确认');
    }
    const token = field(html, ['bdstoken']);
    const sign = field(html, ['sign']);
    const timestamp = field(html, ['timestamp']);
    let pages = 0, entries = 0, fileCount = 0, newest = 0, keyBytes = 0;
    const pending: (string | null)[] = [null];
    const directories = new Set<string>();
    const seenEntries = new Set<string>();
    while (pending.length) {
      const batch = pending.splice(0, 2);
      const batchResults = await Promise.all(batch.map(async (dir) => {
      let countInDirectory = 0;
      for (let page = 1; ; page++) {
        if (++pages > MAX_PAGES) throw new BaiduShareError('百度网盘目录超过 500 页，本次未同步时间');
        const params = new URLSearchParams({ uk, shareid, page: String(page), num: String(PAGE_SIZE), order: 'name', desc: '0', showempty: '1', web: '1', channel: 'chunlei', app_id: '250528', clienttype: '0', root: dir === null ? '1' : '0' });
        if (dir !== null) params.set('dir', dir);
        if (sekey) params.set('sekey', sekey);
        if (token) params.set('bdstoken', token);
        if (sign && timestamp) { params.set('sign', sign); params.set('timestamp', timestamp); }
        const data = parseJson(await request(`https://pan.baidu.com/share/list?${params}`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } }));
        checkError(data, 'list');
        if (!Array.isArray(data.list)) throw new BaiduShareError('百度网盘未返回完整目录，本次未同步时间');
        if (dir === null && page === 1) {
          rootAccessible = true;
          if (!scanTimestamps) return { status: 'valid' as const, message: '链接有效，已成功读取百度网盘分享目录' };
        }
        const list = data.list as Json[];
        countInDirectory += list.length;
        for (const item of list) {
          if (++entries > MAX_ENTRIES) throw new BaiduShareError('百度网盘目录超过 50000 项，本次未同步时间');
          if (!item || typeof item !== 'object') throw new BaiduShareError('百度网盘文件信息不完整，本次未同步时间');
          const key = typeof item.path === 'string' ? item.path : item.fs_id !== undefined ? String(item.fs_id) : undefined;
          if (!key || seenEntries.has(key)) throw new BaiduShareError('百度网盘目录重复或分页不完整，本次未同步时间');
          keyBytes += Buffer.byteLength(key);
          if (key.length > 8192 || keyBytes > MAX_ENTRY_KEY_BYTES) throw new BaiduShareError('百度网盘目录名称数据过大，本次未同步时间');
          seenEntries.add(key);
          if (item.isdir === 1 || item.isdir === '1') {
            if (typeof item.path !== 'string' || !item.path.startsWith('/') || directories.has(item.path)) throw new BaiduShareError('百度网盘子目录信息不完整，本次未同步时间');
            directories.add(item.path);
            pending.push(item.path);
          } else if (item.isdir === 0 || item.isdir === '0') {
            const seconds = Number(item.server_mtime);
            if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > Math.floor(Date.now() / 1000) + 86_400) {
              throw new BaiduShareError('百度网盘文件缺少有效修改时间，本次未同步时间');
            }
            newest = Math.max(newest, seconds);
            fileCount++;
          } else throw new BaiduShareError('百度网盘文件类型不完整，本次未同步时间');
        }
        const more = data.has_more ?? data.hasmore;
        const total = data.total ?? data.total_count;
        if (total !== undefined && (!Number.isSafeInteger(Number(total)) || Number(total) < countInDirectory)) throw new BaiduShareError('百度网盘目录数量不一致，本次未同步时间');
        if (more === true || more === 1 || more === '1') {
          if (!list.length) throw new BaiduShareError('百度网盘目录分页不完整，本次未同步时间');
          continue;
        }
        if (more === false || more === 0 || more === '0' || list.length < PAGE_SIZE) {
          if (total !== undefined && countInDirectory < Number(total)) throw new BaiduShareError('百度网盘目录未读取完整，本次未同步时间');
          break;
        }
      }
      }));
      if (!scanTimestamps) return batchResults[0]!;
    }
    if (!fileCount || !newest) throw new BaiduShareError('百度网盘分享中没有可读取修改时间的文件，本次未同步时间');
    return { updatedAt: new Date(newest * 1000).toISOString(), fileCount, message: `已读取 ${fileCount} 个文件（包含子目录）的最新修改时间` };
  } catch (error) {
    // A timestamp-only failure after the root was read says nothing negative
    // about link availability. Keep that proof separate from sync success.
    if (rootAccessible && error instanceof BaiduShareError) throw new BaiduShareError(error.message, 'valid');
    throw error;
  } finally { clearTimeout(timeout); controller.abort(); }
}

/** Inspect every file for a trustworthy modification time; partial scans fail. */
export async function inspectBaiduShare(input: BaiduShareInput, options: { fetchImpl?: typeof fetch } = {}): Promise<BaiduShareInspection> {
  return await readBaiduShare(input, options, true) as BaiduShareInspection;
}

/** Check share accessibility using only its first root page, including empty shares. */
export async function checkBaiduLink(input: BaiduShareInput, options: { fetchImpl?: typeof fetch } = {}): Promise<BaiduLinkHealthResult> {
  try {
    return await readBaiduShare(input, options, false) as BaiduLinkHealthResult;
  } catch (error) {
    if (error instanceof BaiduShareError) return { status: error.healthStatus, message: error.message.replace(/，本次未同步时间/g, '') };
    return { status: 'unknown', message: '暂时无法确定百度网盘链接是否有效，请稍后重试或在浏览器中确认' };
  }
}

