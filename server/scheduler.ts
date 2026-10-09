import { randomUUID } from 'node:crypto';
import type { Album, CloudLink, LinkCheckResult, LinkCheckSummary, LinkHealth, SyncLog } from '../shared/types.ts';
import { ApiError, DAY_MS, GalleryDb, isBaiduLink } from './db.ts';
import { inspectBaiduShare, checkBaiduLink, BaiduShareError } from './baidu.ts';
import { reportRuntimeError } from './runtime-log.ts';

export interface InspectionResult { updatedAt: string; fileCount: number; message: string; }
interface InspectionInput { url: string; code?: string; cookie?: string; signal?: AbortSignal }
interface InspectionAlbum { id: string; links: Pick<CloudLink, 'id' | 'url' | 'code'>[] }
export type Inspector = (input: InspectionInput) => Promise<InspectionResult>;
export type HealthInspector = (input: InspectionInput) => Promise<LinkCheckResult>;
export const MAX_QUEUED_SYNC_JOBS = 32;

function failureHealth(error: unknown): LinkCheckResult {
  return error instanceof BaiduShareError
    ? { status: error.healthStatus, message: error.message }
    : { status: 'unknown', message: '本次无法确认链接有效性，请稍后重试或打开链接查看' };
}

function checkedHealth(result: LinkCheckResult, checkedAt: string, autoCheck = true): LinkHealth {
  return { ...result, checkedAt, nextCheckAt: autoCheck ? new Date(Date.parse(checkedAt) + DAY_MS).toISOString() : null };
}

export class SyncScheduler {
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, Promise<unknown>>();
  private shutdown = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  constructor(private db: GalleryDb, private inspector: Inspector = inspectBaiduShare, private clock = () => new Date(), private healthInspector: HealthInspector = checkBaiduLink) {}
  start(): void {
    if (this.timer || (this.stopped && this.pending.size)) return;
    this.stopped = false;
    if (this.shutdown.signal.aborted) this.shutdown = new AbortController();
    void this.runDue().catch(error => reportRuntimeError('scheduler-start', error));
    this.timer = setInterval(() => {
      // Do not add another promise handler each minute to a long-running scan.
      if (!this.pending.has('due') && this.pending.size < MAX_QUEUED_SYNC_JOBS) {
        void this.runDue().catch(error => reportRuntimeError('scheduler-tick', error));
      }
    }, 60_000);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.shutdown.abort();
    await this.queue;
  }
  private serialized<T>(key: string, job: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new ApiError(503, '同步服务正在停止，请稍后重试'));
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    if (this.pending.size >= MAX_QUEUED_SYNC_JOBS) return Promise.reject(new ApiError(429, '同步任务较多，请等待当前检测完成后重试'));
    const run = async () => {
      if (this.stopped) throw new ApiError(503, '同步服务正在停止，请稍后重试');
      return job();
    };
    const next = this.queue.then(run, run);
    this.pending.set(key, next);
    const release = () => { this.pending.delete(key); };
    void next.then(release, release);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private async inspect<T>(inspector: (input: InspectionInput) => Promise<T>, input: InspectionInput, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const signal = AbortSignal.any([this.shutdown.signal, controller.signal]);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref();
    let onAbort: (() => void) | undefined;
    try {
      signal.throwIfAborted();
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new BaiduShareError('百度网盘检测超时或已取消，本次未同步时间', 'network_error'));
        signal.addEventListener('abort', onAbort, { once: true });
      });
      return await Promise.race([inspector({ ...input, signal }), cancelled]);
    } finally {
      clearTimeout(timeout);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }
  private targets(albums: Album[]): InspectionAlbum[] {
    // A slow scan needs only link identity, not every original image's metadata.
    return albums.map(album => ({ id: album.id, links: album.links.map(({ id, url, code }) => ({ id, url, code })) }));
  }
  runDue(): Promise<{ checked: number; errors: number }> {
    return this.serialized('due', async () => {
      if (this.stopped || !this.db.settings().autoSync) return { checked: 0, errors: 0 };
      const albums = this.targets(this.db.albums());
      const synced = await this.check(albums, true);
      const health = await this.checkHealth(albums, true);
      return { checked: synced.checked + health.checked, errors: synced.errors + health.invalid + health.uncertain };
    });
  }
  syncAll(): Promise<{ checked: number; errors: number }> { return this.serialized('sync-all', () => this.check(this.targets(this.db.albums()), false)); }
  syncAlbum(id: string): Promise<{ album: Album; checked: number; errors: number }> {
    return this.serialized(JSON.stringify(['sync', id]), async () => {
      const result = await this.check(this.targets([this.db.requireAlbum(id)]), false);
      return { album: this.db.requireAlbum(id), ...result };
    });
  }
  checkAllLinks(): Promise<LinkCheckSummary> { return this.serialized('health-all', () => this.checkHealth(this.targets(this.db.albums()), false)); }
  checkAlbumLinks(id: string): Promise<LinkCheckSummary & { album: Album }> {
    return this.serialized(JSON.stringify(['health', id]), async () => {
      const result = await this.checkHealth(this.targets([this.db.requireAlbum(id)]), false);
      return { album: this.db.requireAlbum(id), ...result };
    });
  }
  checkLink(albumId: string, linkId: string): Promise<LinkCheckSummary & { album: Album }> {
    return this.serialized(JSON.stringify(['link', albumId, linkId]), async () => {
      const album = this.db.requireAlbum(albumId);
      if (!album.links.some(link => link.id === linkId)) throw new ApiError(404, '网盘链接不存在');
      const result = await this.checkHealth(this.targets([{ ...album, links: album.links.filter(link => link.id === linkId) }]), false);
      return { album: this.db.requireAlbum(albumId), ...result };
    });
  }
  private async checkHealth(albums: InspectionAlbum[], dueOnly: boolean): Promise<LinkCheckSummary> {
    const summary: LinkCheckSummary = { checked: 0, valid: 0, invalid: 0, uncertain: 0, unsupported: 0 };
    for (const initial of albums) {
      for (const initialLink of initial.links) {
        if (this.stopped || (dueOnly && !this.db.settings().autoSync)) return summary;
        const current = this.db.album(initial.id);
        const link = current?.links.find(item => item.id === initialLink.id);
        if (!current || !link || link.url !== initialLink.url || link.code !== initialLink.code) continue;
        const supported = isBaiduLink(link.url);
        if (dueOnly && !supported) continue;
        const checkedAt = this.clock().toISOString();
        if (dueOnly && link.health?.nextCheckAt && link.health.nextCheckAt > checkedAt) continue;
        let result: LinkCheckResult = { status: 'unsupported', message: '暂仅支持检测百度网盘链接，请打开链接手动确认' };
        if (supported) {
          try { result = await this.inspect(this.healthInspector, { url: link.url, code: link.code, cookie: this.db.value('baiduCookie') }, 30_000); }
          catch (error) { result = failureHealth(error); }
        }
        if (this.stopped) return summary;
        this.db.connection.exec('BEGIN');
        try {
          const latest = this.db.updateLinkHealth(current.id, link.id, link.url, link.code, checkedHealth(result, checkedAt, supported));
          const latestLink = latest?.links.find(item => item.id === link.id);
          if (latest && latestLink) {
            summary.checked++;
            if (result.status === 'valid') summary.valid++;
            else if (result.status === 'invalid') summary.invalid++;
            else if (result.status === 'unsupported') summary.unsupported++;
            else summary.uncertain++;
            this.db.log({
              id: randomUUID(), albumId: latest.id, albumTitle: latest.title, linkLabel: latestLink.label,
              checkedAt, status: result.status === 'valid' ? 'success' : 'error', kind: 'health', healthStatus: result.status,
              message: result.message, remoteUpdatedAt: latestLink.remoteUpdatedAt, changed: false,
            });
          }
          this.db.connection.exec('COMMIT');
        } catch (error) { this.db.connection.exec('ROLLBACK'); throw error; }
      }
    }
    return summary;
  }
  private async check(albums: InspectionAlbum[], dueOnly: boolean): Promise<{ checked: number; errors: number }> {
    let checked = 0; let errors = 0;
    for (const initial of albums) {
      for (const initialLink of initial.links) {
        if (this.stopped) return { checked, errors };
        const current = this.db.album(initial.id);
        const link = current?.links.find(item => item.id === initialLink.id);
        if (!current || !link || link.url !== initialLink.url || link.code !== initialLink.code || !link.syncEnabled || !isBaiduLink(link.url)) continue;
        const checkedAt = this.clock().toISOString();
        if (dueOnly && link.nextCheckAt && link.nextCheckAt > checkedAt) continue;
        if (dueOnly && !this.db.settings().autoSync) return { checked, errors };
        let result: InspectionResult | undefined;
        let failure = false;
        let health: LinkCheckResult = { status: 'valid', message: '百度网盘分享可访问' };
        let failureMessage = '无法读取百度网盘更新时间，请检查链接、提取码或登录 Cookie';
        try {
          result = await this.inspect(this.inspector, { url: link.url, code: link.code, cookie: this.db.value('baiduCookie') }, 180_000);
          const time = new Date(result.updatedAt);
          if (!Number.isFinite(time.getTime())) throw new Error('invalid-time');
          result.updatedAt = time.toISOString();
        } catch (error) { failure = true; health = failureHealth(error); if (error instanceof BaiduShareError) failureMessage = error.message; }
        if (this.stopped) return { checked, errors };
        checked++;
        if (failure) errors++;
        // A user may edit/remove this link while a network request is running.
        // Never overwrite their changes or resurrect a deleted album.
        const latest = this.db.album(initial.id);
        const latestLink = latest?.links.find(item => item.id === link.id);
        if (!latest || !latestLink || latestLink.url !== link.url || latestLink.code !== link.code || !latestLink.syncEnabled) continue;
        const changed = !failure && latestLink.remoteUpdatedAt !== result!.updatedAt;
        latestLink.lastCheckedAt = checkedAt;
        latestLink.nextCheckAt = new Date(Date.parse(checkedAt) + DAY_MS).toISOString();
        latestLink.status = failure ? 'error' : 'success';
        latestLink.health = checkedHealth(health, checkedAt);
        // Do not store upstream error bodies or authentication information in logs.
        latestLink.message = failure ? `${failureMessage}；已有更新时间已保留。` : (changed ? '已同步网盘文件更新时间' : '检测完成，网盘文件时间没有变化');
        if (!failure) latestLink.remoteUpdatedAt = result!.updatedAt;
        const log: SyncLog = {
          id: randomUUID(), albumId: latest.id, albumTitle: latest.title, linkLabel: latestLink.label,
          checkedAt, status: failure ? 'error' : 'success', kind: 'sync', healthStatus: health.status, message: latestLink.message,
          remoteUpdatedAt: latestLink.remoteUpdatedAt, changed,
        };
        this.db.connection.exec('BEGIN');
        try { this.db.save(latest); this.db.log(log); this.db.connection.exec('COMMIT'); }
        catch (error) { this.db.connection.exec('ROLLBACK'); throw error; }
      }
    }
    return { checked, errors };
  }
}
