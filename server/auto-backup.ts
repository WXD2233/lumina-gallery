import { randomUUID } from 'node:crypto';
import { lstat, mkdir, opendir, readFile, realpath, rename, rmdir, statfs, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { AutoBackupEntry, AutoBackupNotice, AutoBackupSettings, AutoBackupSettingsInput, AutoBackupStatus } from '../shared/auto-backup.ts';
import { prepareAutomaticBackup } from './backup.ts';
import { ApiError, type GalleryDb } from './db.ts';
import { MIN_FREE_DISK_BYTES } from './resource-limits.ts';
import { reportRuntimeError } from './runtime-log.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_BACKUP_BYTES = 8 * 1024 ** 3;
const JOB_TIMEOUT_MS = 30 * 60 * 1000;
const STATE_KEY = 'automaticBackup.v1';
const OWNER = 'lumina-automatic-backup';
const COMPLETE_MARKER = '.lumina-auto-backup.json';
const STAGE_MARKER = '.lumina-auto-backup-stage.json';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const STAGE_FILES = new Set(['图集清单.xlsx', 'gallery.db', 'gallery.db-journal', 'manifest.json', '恢复说明.txt', '完整备份.zip.partial', '完整备份.zip', COMPLETE_MARKER, STAGE_MARKER]);
const defaults: AutoBackupSettings = { enabled: true, weekday: 0, time: '03:00', timeZone: 'Asia/Hong_Kong', retainCount: 7, lowSpaceGraceHours: 24 };

interface PersistedState extends Omit<AutoBackupStatus, 'running' | 'backups' | 'reserveBytes' | 'emailReady'> {
  version: 1 | 2;
  incidentId: string | null;
  notified: AutoBackupNotice['kind'][];
  remotePendingId: string | null;
}
interface Marker { owner: typeof OWNER; version: 1; id: string; createdAt: string; filename: string; size: number }
interface StoredBackup extends AutoBackupEntry { directory: string; path: string }
export interface AutoBackupOptions {
  clock?: () => number;
  diskFree?: (directory: string) => Promise<number>;
  prepare?: typeof prepareAutomaticBackup;
  notify?: (notice: AutoBackupNotice) => void | Promise<void>;
  webdavEnabled?: () => boolean;
  uploadWebdav?: (entry: AutoBackupEntry & { path: string }, signal: AbortSignal) => Promise<void>;
  testWebdav?: () => Promise<void>;
  /** Runtime injection for tests; not a user-configurable setting. */
  jobTimeoutMs?: number;
}

/** Fixed UTC+8 deliberately avoids the execution host's timezone and daylight saving. */
export function nextAutomaticBackupAt(settings: Pick<AutoBackupSettings, 'weekday' | 'time'>, after: number): string {
  const local = new Date(after + 8 * HOUR);
  const [hour, minute] = settings.time.split(':').map(Number);
  let candidate = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute) - 8 * HOUR;
  candidate += ((settings.weekday - local.getUTCDay() + 7) % 7) * DAY;
  if (candidate <= after) candidate += 7 * DAY;
  return new Date(candidate).toISOString();
}

function dateOrNull(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
function validFilename(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 160 && value.endsWith('.zip') && !/[\\/\x00-\x1f\x7f:]/.test(value) && basename(value) === value;
}
function validateSettings(value: unknown, previous = defaults): AutoBackupSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, '自动备份设置格式不正确');
  const input = value as AutoBackupSettingsInput;
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new ApiError(400, '自动备份开关格式不正确');
  if (input.weekday !== undefined && (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6)) throw new ApiError(400, '请选择有效的备份星期');
  if (input.time !== undefined && (typeof input.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time))) throw new ApiError(400, '备份时间应为 HH:mm');
  return { ...previous, enabled: input.enabled ?? previous.enabled, weekday: input.weekday ?? previous.weekday, time: input.time ?? previous.time };
}

export class AutoBackupService {
  readonly directory: string;
  private state: PersistedState;
  private clock: () => number;
  private diskFree: (directory: string) => Promise<number>;
  private prepare: typeof prepareAutomaticBackup;
  private jobTimeoutMs: number;
  private root = '';
  private initialized = false;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private current?: Promise<void>;
  private controller?: AbortController;
  private pins = new Map<string, number>();
  private deleting = new Set<string>();
  private pendingNotices = new Set<Promise<void>>();
  private retentionPending = false;
  private retentionRetryAt = 0;
  private freeCheckedAt = -Infinity;
  private spaceRefresh?: Promise<void>;
  private statusListing?: Promise<StoredBackup[]>;

  constructor(private db: GalleryDb, private uploadsDir: string, private options: AutoBackupOptions = {}) {
    this.directory = resolve(db.directory, 'auto-backups');
    this.clock = options.clock ?? Date.now;
    this.diskFree = options.diskFree ?? (async directory => { const disk = await statfs(directory); return disk.bavail * disk.bsize; });
    this.prepare = options.prepare ?? prepareAutomaticBackup;
    this.jobTimeoutMs = options.jobTimeoutMs ?? JOB_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.jobTimeoutMs) || this.jobTimeoutMs <= 0 || this.jobTimeoutMs > JOB_TIMEOUT_MS) throw new Error('自动备份任务时限配置无效');
    this.state = { version: 2, settings: { ...defaults }, nextRunAt: nextAutomaticBackupAt(defaults, this.clock()), lastAttemptAt: null, lastSuccessAt: null,
      phase: 'idle', message: '每周自动备份已启用，等待下次计划时间。', warningAt: null, cleanupAfter: null, retryAt: null,
      freeBytes: null, requiredBytes: null, incidentId: null, notified: [], remotePendingId: null };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.directory, { recursive: true });
    const info = await lstat(this.directory);
    const dataRoot = await realpath(this.db.directory);
    this.root = await realpath(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || dirname(this.root) !== dataRoot) throw new ApiError(500, '自动备份目录无效，请检查存储路径');
    const saved = this.db.value(STATE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as PersistedState;
        if (parsed.version !== 1 && parsed.version !== 2) throw new Error('Unknown state version');
        const settings = validateSettings(parsed.settings);
        const phase = ['idle', 'running', 'waiting_space', 'blocked', 'failed', 'success'].includes(parsed.phase) ? parsed.phase : 'idle';
        this.state = { ...this.state, settings, phase, message: typeof parsed.message === 'string' ? parsed.message.slice(0, 1000) : this.state.message,
          nextRunAt: settings.enabled ? dateOrNull(parsed.nextRunAt) ?? nextAutomaticBackupAt(settings, this.clock()) : null,
          lastAttemptAt: dateOrNull(parsed.lastAttemptAt), lastSuccessAt: dateOrNull(parsed.lastSuccessAt), warningAt: dateOrNull(parsed.warningAt),
          cleanupAfter: dateOrNull(parsed.cleanupAfter), retryAt: settings.enabled ? dateOrNull(parsed.retryAt) : null,
          freeBytes: Number.isFinite(parsed.freeBytes) && Number(parsed.freeBytes) >= 0 ? parsed.freeBytes : null,
          requiredBytes: Number.isFinite(parsed.requiredBytes) && Number(parsed.requiredBytes) >= 0 ? parsed.requiredBytes : null,
          incidentId: typeof parsed.incidentId === 'string' && UUID.test(parsed.incidentId) ? parsed.incidentId : null,
          notified: Array.isArray(parsed.notified) ? parsed.notified.filter(kind => ['low_space', 'stopped', 'failed', 'recovered'].includes(kind)).slice(0, 4) : [],
          remotePendingId: parsed.version === 2 && typeof parsed.remotePendingId === 'string' && UUID.test(parsed.remotePendingId) ? parsed.remotePendingId : null };
      } catch { reportRuntimeError('auto-backup-state', new Error('自动备份状态无效，已使用默认计划')); }
    }
    await this.cleanInterruptedStages();
    const backups = await this.entries();
    this.retentionPending = backups.length > defaults.retainCount;
    if (backups.length && (!this.state.lastSuccessAt || backups[0].createdAt > this.state.lastSuccessAt)) this.state.lastSuccessAt = backups[0].createdAt;
    if (this.state.phase === 'running') {
      this.state.phase = 'failed'; this.state.message = '上次自动备份被中断，原有完整备份已保留，将在一小时后重试。';
      this.state.retryAt = this.state.settings.enabled || this.state.remotePendingId ? this.iso(this.clock() + HOUR) : null;
      this.notice('failed', this.state.message);
    }
    this.initialized = true;
    this.save();
  }

  start(): void {
    this.assertReady();
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.tick(); }, 60_000); this.timer.unref();
    void this.tick();
  }

  async status(): Promise<AutoBackupStatus> {
    this.assertReady();
    if (this.clock() - this.freeCheckedAt >= 60_000) {
      this.spaceRefresh ??= this.readFree().then(() => undefined).catch(error => {
        this.state.freeBytes = null; this.freeCheckedAt = this.clock(); reportRuntimeError('automatic-backup-disk-space', error);
      }).finally(() => { this.spaceRefresh = undefined; });
      await this.spaceRefresh;
    }
    this.statusListing ??= this.entries().finally(() => { this.statusListing = undefined; });
    const backups = await this.statusListing;
    const { version: _version, incidentId: _incidentId, notified: _notified, remotePendingId: _remotePendingId, ...visible } = this.state;
    return { ...visible, settings: { ...this.state.settings }, running: Boolean(this.current), reserveBytes: MIN_FREE_DISK_BYTES,
      backups: backups.map(({ path: _path, directory: _directory, ...entry }) => entry) };
  }

  async updateSettings(input: AutoBackupSettingsInput): Promise<AutoBackupStatus> {
    this.assertReady();
    if (this.current) throw new ApiError(409, '备份正在进行，请完成后再修改计划');
    const settings = validateSettings(input, this.state.settings);
    if (JSON.stringify(settings) !== JSON.stringify(this.state.settings)) {
      this.state.settings = settings;
      this.state.nextRunAt = settings.enabled ? nextAutomaticBackupAt(settings, this.clock()) : null;
      this.state.phase = 'idle'; this.state.message = settings.enabled ? '备份计划已保存，将按新时间执行。' : '自动备份已暂停，已有完整备份继续保留。';
      this.state.warningAt = null; this.state.cleanupAfter = null; this.state.retryAt = null;
      this.state.incidentId = null; this.state.notified = [];
      this.save();
    }
    return this.status();
  }

  /** Starts a bounded background job; callers do not wait for ZIP construction. */
  runNow(): void {
    this.assertReady();
    if (this.current) throw new ApiError(409, '已有自动备份任务正在进行');
    if (this.state.remotePendingId && this.options.webdavEnabled?.()) throw new ApiError(409, '已有本地备份等待 WebDAV 重试，请稍后再创建新备份');
    this.launch(true);
  }

  async testWebdav(): Promise<void> {
    this.assertReady();
    if (this.current) throw new ApiError(409, '备份或 WebDAV 上传正在进行，请稍后再测试连接');
    if (!this.options.testWebdav) throw new ApiError(503, 'WebDAV 测试暂不可用');
    try { await this.options.testWebdav(); }
    catch { throw new ApiError(400, 'WebDAV 连接失败，请检查 HTTPS 地址、账号密码、远程目录权限和服务器网络'); }
  }

  disableWebdavPending(): void {
    this.assertReady();
    if (!this.state.remotePendingId) return;
    this.state.remotePendingId = null; this.state.retryAt = null; this.state.phase = 'success';
    this.state.message = 'WebDAV 远程备份已停用；最近的完整备份仍保存在本机。';
    this.state.incidentId = null; this.state.notified = []; this.save();
  }

  assertWebdavChangeAllowed(): void {
    this.assertReady();
    if (this.current) throw new ApiError(409, '备份或 WebDAV 上传正在进行，请完成后再修改连接设置');
  }

  /** Public for deterministic scheduler tests; repeated ticks share one running job. */
  async tick(): Promise<void> {
    if (!this.initialized || this.stopped) return;
    if (this.current) return this.current;
    const now = this.clock();
    if (this.retentionPending && now >= this.retentionRetryAt) {
      this.controller = new AbortController();
      this.current = this.enforceRetention(this.controller.signal).catch(error => {
        this.retentionRetryAt = this.clock() + HOUR; reportRuntimeError('automatic-backup-retention', error);
      }).finally(() => { this.current = undefined; this.controller = undefined; });
      await this.current;
      return;
    }
    if (this.state.remotePendingId && this.options.webdavEnabled?.() && (!this.state.retryAt || Date.parse(this.state.retryAt) <= now)) {
      this.launchWebdavRetry();
      return this.current;
    }
    if (!this.state.settings.enabled) return;
    if (!(this.state.retryAt && Date.parse(this.state.retryAt) <= now) && !(this.state.nextRunAt && Date.parse(this.state.nextRunAt) <= now)) return;
    this.launch(false);
    return this.current;
  }

  async flush(): Promise<void> { await this.current; }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.controller?.abort();
    await this.current;
    await this.spaceRefresh;
    await this.statusListing;
    await Promise.allSettled(this.pendingNotices);
    this.pins.clear();
  }

  async download(id: string): Promise<{ path: string; filename: string; size: number; release: () => void }> {
    this.assertReady();
    if (!UUID.test(id) || this.deleting.has(id)) throw new ApiError(404, '此备份不存在或正在清理');
    this.pins.set(id, (this.pins.get(id) ?? 0) + 1);
    let released = false;
    const release = () => { if (!released) { released = true; const count = (this.pins.get(id) ?? 1) - 1; if (count > 0) this.pins.set(id, count); else this.pins.delete(id); } };
    try {
      const entry = await this.readEntry(`backup-${id}`);
      if (!entry) throw new ApiError(404, '此备份不存在或已损坏');
      return { path: entry.path, filename: entry.filename, size: entry.size, release };
    } catch (error) { release(); throw error; }
  }

  private launch(forced: boolean): void {
    const controller = new AbortController();
    this.controller = controller;
    const deadline = setTimeout(() => controller.abort(new ApiError(504, '自动备份超过单次运行时限，已取消本次任务；原有完整备份继续保留，将在一小时后重试。')), this.jobTimeoutMs);
    deadline.unref();
    this.current = Promise.resolve().then(() => this.execute(forced, controller.signal))
      .catch(error => { reportRuntimeError('automatic-backup', error); })
      .finally(() => { clearTimeout(deadline); this.current = undefined; this.controller = undefined; });
  }

  private launchWebdavRetry(): void {
    const controller = new AbortController();
    this.controller = controller;
    const deadline = setTimeout(() => controller.abort(new ApiError(504, 'WebDAV 上传超过单次运行时限')), this.jobTimeoutMs);
    deadline.unref();
    this.current = Promise.resolve().then(() => this.retryWebdav(controller.signal))
      .catch(() => { reportRuntimeError('automatic-backup-webdav', new Error('WebDAV retry failed')); })
      .finally(() => { clearTimeout(deadline); this.current = undefined; this.controller = undefined; });
  }

  private async execute(forced: boolean, signal: AbortSignal): Promise<void> {
    let stage: string | undefined;
    let plan: Awaited<ReturnType<typeof prepareAutomaticBackup>> | undefined;
    const now = this.clock();
    if (this.state.phase === 'blocked' || (this.state.nextRunAt && Date.parse(this.state.nextRunAt) <= now && this.state.phase !== 'waiting_space')) {
      this.state.warningAt = null; this.state.cleanupAfter = null; this.state.incidentId = null; this.state.notified = [];
    }
    if (!forced || !this.state.nextRunAt || Date.parse(this.state.nextRunAt) <= now) this.state.nextRunAt = this.state.settings.enabled ? nextAutomaticBackupAt(this.state.settings, now) : null;
    this.state.lastAttemptAt = this.iso(now); this.state.phase = 'running'; this.state.message = '正在检查备份空间并准备完整备份。'; this.state.retryAt = null;
    this.save();
    try {
      signal.throwIfAborted();
      // Preparation validates source files and the format limit before any old backup is considered for deletion.
      plan = await this.prepare(this.db, this.uploadsDir, signal);
      if (!Number.isSafeInteger(plan.estimatedBytes) || plan.estimatedBytes < 0 || plan.estimatedBytes > MAX_BACKUP_BYTES) throw new ApiError(413, '预计备份超过单次 8 GB 上限，请调整图库或备份方式；已有备份未因此删除。');
      if ((await this.entries()).length > this.state.settings.retainCount) throw new ApiError(409, '旧备份尚未安全清理，暂不生成更多备份。请等待下载结束或检查备份目录。');
      if (!await this.cleanInterruptedStages()) throw new ApiError(503, '上次备份临时目录无法安全清理，已暂停生成更多备份。请管理员检查目录中的未知文件或权限。');
      this.state.requiredBytes = plan.estimatedBytes + MIN_FREE_DISK_BYTES;
      let free = await this.readFree();
      signal.throwIfAborted();
      if (free < this.state.requiredBytes) {
        if (!this.state.warningAt || !this.state.cleanupAfter) {
          this.state.warningAt = this.iso(this.clock()); this.state.cleanupAfter = this.iso(this.clock() + DAY);
          this.state.incidentId = randomUUID(); this.state.notified = [];
        }
        const warning = '自动备份空间不足，请管理员释放空间或调整备份计划。等待 24 小时后仍不足时，将从最旧备份开始清理，并始终保留至少一份完整备份。';
        this.state.phase = 'waiting_space'; this.state.message = warning;
        this.state.retryAt = this.iso(this.clock() + HOUR); this.save(); this.notice('low_space', warning);
        if (this.clock() < Date.parse(this.state.cleanupAfter)) return;
        this.state.phase = 'running'; this.state.message = '等待期已结束，正在按时间清理旧备份以释放空间。'; this.save();
        while (free < this.state.requiredBytes) {
          signal.throwIfAborted();
          const backups = await this.entries();
          const oldest = backups.at(-1);
          if (backups.length <= 1 || !oldest || this.pins.has(oldest.id) || !await this.removeComplete(oldest)) {
            this.state.phase = 'blocked'; this.state.retryAt = null;
            this.state.message = backups.length === 0 ? '空间仍不足，已停止本次备份：没有可清理的历史完整备份。请管理员释放空间后重新备份。' : backups.length === 1 ? '空间仍不足，已停止本次备份：不能删除仅剩的完整备份。请管理员释放空间后重新备份。' : '空间仍不足，已停止本次备份：最旧备份正在下载或无法安全删除。请管理员检查后重新备份。';
            this.save(); this.notice('stopped', this.state.message); return;
          }
          // Never assume a deleted file actually released its bytes on this filesystem.
          free = await this.readFree();
        }
      }
      signal.throwIfAborted();
      this.state.phase = 'running'; this.state.message = '正在生成并校验完整备份。'; this.save();
      const id = randomUUID();
      stage = join(this.root, `.pending-${id}`);
      await mkdir(stage);
      await writeFile(join(stage, STAGE_MARKER), JSON.stringify({ owner: OWNER, version: 1, id }), { flag: 'wx' });
      const result = await plan.write(stage, signal);
      signal.throwIfAborted();
      if (!validFilename(result.filename) || resolve(result.path) !== join(stage, result.filename)) throw new Error('备份生成器返回了无效文件路径');
      const resultInfo = await lstat(result.path);
      if (!resultInfo.isFile() || resultInfo.isSymbolicLink() || resultInfo.size <= 0 || resultInfo.size !== result.size || resultInfo.size > MAX_BACKUP_BYTES || dirname(await realpath(result.path)) !== await realpath(stage)) throw new Error('生成的完整备份文件校验失败');
      const marker: Marker = { owner: OWNER, version: 1, id, createdAt: this.iso(this.clock()), filename: result.filename, size: result.size };
      await writeFile(join(stage, COMPLETE_MARKER), JSON.stringify(marker), { flag: 'wx' });
      await rename(stage, join(this.root, `backup-${id}`));
      stage = undefined;
      await unlink(join(this.root, `backup-${id}`, STAGE_MARKER)).catch(() => undefined);
      this.state.lastSuccessAt = marker.createdAt;
      let webdavFailed = false;
      const committed = await this.readEntry(`backup-${id}`);
      if (this.options.webdavEnabled?.() && this.options.uploadWebdav) {
        this.state.remotePendingId = id; this.state.message = '本地完整备份已保存，正在上传到 WebDAV。'; this.save();
        try {
          if (!committed) throw new Error('local backup validation failed');
          await this.options.uploadWebdav(committed, signal); this.state.remotePendingId = null;
        } catch {
          webdavFailed = true; this.state.remotePendingId = id;
          this.state.message = '本地完整备份已保存，但 WebDAV 上传失败；系统将在一小时后重试。请检查 WebDAV 地址和账户权限。';
        }
      }
      this.state.phase = webdavFailed ? 'failed' : 'success';
      if (!webdavFailed) this.state.message = '完整备份已生成并校验，保留最近 7 份。';
      this.state.warningAt = null; this.state.cleanupAfter = null;
      this.state.retryAt = webdavFailed ? this.iso(this.clock() + HOUR) : null;
      this.save();
      if (webdavFailed) { this.notice('failed', this.state.message); reportRuntimeError('automatic-backup-webdav', new Error('WebDAV upload failed')); }
      else if (this.state.incidentId) this.notice('recovered', '自动备份已恢复，新的完整备份已成功生成。');
      if (!webdavFailed) { this.state.incidentId = null; this.state.notified = []; this.save(); }
      this.retentionPending = true;
      await this.enforceRetention(signal).catch(error => {
        this.retentionRetryAt = this.clock() + HOUR;
        if (!webdavFailed) this.state.message = '完整备份已成功生成；旧备份暂时无法清理，一小时后重试。'; this.save();
        reportRuntimeError('automatic-backup-retention', error);
      });
    } catch (error) {
      const timedOut = signal.aborted && signal.reason instanceof ApiError && signal.reason.status === 504;
      const aborted = signal.aborted && !timedOut;
      const full = error instanceof ApiError && error.status === 507 || ['ENOSPC', 'EDQUOT'].includes((error as NodeJS.ErrnoException).code ?? '');
      if (!aborted && full) {
        if (!this.state.warningAt || !this.state.cleanupAfter) {
          this.state.warningAt = this.iso(this.clock()); this.state.cleanupAfter = this.iso(this.clock() + DAY);
          this.state.incidentId = randomUUID(); this.state.notified = [];
        }
        this.state.phase = 'waiting_space';
        this.state.message = '生成备份时磁盘空间不足，已清理未完成文件。请管理员释放空间；等待 24 小时后仍不足才会按最旧顺序清理，并至少保留一份完整备份。';
        this.state.retryAt = this.state.settings.enabled ? this.iso(this.clock() + HOUR) : null;
        this.save(); this.notice('low_space', this.state.message);
      } else {
        this.state.phase = 'failed';
        this.state.message = aborted ? '备份已随服务停止而中断，原有完整备份继续保留。' : timedOut ? String(signal.reason.message) : error instanceof ApiError ? error.message : '自动备份失败，原有完整备份继续保留。请管理员检查存储空间与文件状态。';
        this.state.retryAt = this.state.settings.enabled && !(error instanceof ApiError && error.status === 413) ? this.iso(this.clock() + HOUR) : null;
        this.save();
        if (!aborted) { this.notice('failed', this.state.message); reportRuntimeError('automatic-backup-build', error); }
      }
    } finally {
      plan?.release?.();
      if (stage) await this.removeStage(stage).catch(error => reportRuntimeError('automatic-backup-stage', error));
    }
  }

  private async retryWebdav(signal: AbortSignal): Promise<void> {
    const id = this.state.remotePendingId;
    if (!id || !this.options.uploadWebdav) return;
    const entry = await this.readEntry(`backup-${id}`);
    if (!entry) {
      this.state.remotePendingId = null; this.state.retryAt = null; this.state.phase = 'failed';
      this.state.message = '等待上传的本地备份已不存在，WebDAV 同步已停止；请重新创建一份完整备份。'; this.save();
      this.notice('failed', this.state.message); return;
    }
    this.state.phase = 'running'; this.state.message = '正在重试上传本地完整备份到 WebDAV。'; this.state.lastAttemptAt = this.iso(this.clock()); this.state.retryAt = null; this.save();
    try {
      await this.options.uploadWebdav(entry, signal);
      this.state.remotePendingId = null; this.state.phase = 'success'; this.state.retryAt = null;
      this.state.message = 'WebDAV 上传已完成，远程备份已更新。'; this.save();
      if (this.state.incidentId) this.notice('recovered', 'WebDAV 备份上传已恢复。');
      this.state.incidentId = null; this.state.notified = []; this.save();
    } catch {
      this.state.phase = 'failed'; this.state.retryAt = this.iso(this.clock() + HOUR);
      this.state.message = 'WebDAV 上传仍未成功；本地完整备份已保留，系统将在一小时后重试。请检查 WebDAV 地址和账户权限。'; this.save();
      this.notice('failed', this.state.message); reportRuntimeError('automatic-backup-webdav', new Error('WebDAV retry failed'));
    }
  }

  private async enforceRetention(signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const entries = await this.entries();
      if (entries.length <= this.state.settings.retainCount) { this.retentionPending = false; return; }
      const oldest = entries.at(-1)!;
      if (this.pins.has(oldest.id) || !await this.removeComplete(oldest)) {
        this.retentionRetryAt = this.clock() + HOUR;
        this.state.message = '新备份已完成；旧备份正在下载或无法安全清理，一小时后重试。'; this.save(); return;
      }
    }
  }

  private async readFree(): Promise<number> {
    const free = await this.diskFree(this.root);
    if (!Number.isFinite(free) || free < 0) throw new Error('无法取得有效的磁盘剩余空间');
    this.state.freeBytes = free; this.freeCheckedAt = this.clock(); this.save(); return free;
  }

  private async rootSafe(): Promise<boolean> {
    const info = await lstat(this.directory);
    return info.isDirectory() && !info.isSymbolicLink() && await realpath(this.directory) === this.root;
  }

  private async entries(): Promise<StoredBackup[]> {
    if (!await this.rootSafe()) throw new ApiError(500, '自动备份目录已变更，请检查存储路径');
    const result: StoredBackup[] = [];
    const directory = await opendir(this.root);
    for await (const item of directory) {
      if (!item.isDirectory() || item.isSymbolicLink() || !item.name.startsWith('backup-')) continue;
      const entry = await this.readEntry(item.name);
      if (entry) result.push(entry);
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  private async readEntry(name: string): Promise<StoredBackup | null> {
    const id = name.slice('backup-'.length);
    if (name !== `backup-${id}` || !UUID.test(id)) return null;
    const directory = join(this.root, name);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || dirname(await realpath(directory)) !== this.root) return null;
      const markerPath = join(directory, COMPLETE_MARKER);
      const markerInfo = await lstat(markerPath);
      if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 4096) return null;
      const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Marker;
      if (marker.owner !== OWNER || marker.version !== 1 || marker.id !== id || !dateOrNull(marker.createdAt) || !validFilename(marker.filename) || !Number.isSafeInteger(marker.size) || marker.size <= 0 || marker.size > MAX_BACKUP_BYTES) return null;
      const path = join(directory, marker.filename);
      const file = await lstat(path);
      if (!file.isFile() || file.isSymbolicLink() || file.size !== marker.size || dirname(await realpath(path)) !== await realpath(directory)) return null;
      return { id, directory, path, filename: marker.filename, createdAt: marker.createdAt, size: marker.size, downloadUrl: `/api/admin/auto-backups/${id}/download` };
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') && !(error instanceof SyntaxError)) reportRuntimeError('automatic-backup-entry', error);
      return null;
    }
  }

  private async removeComplete(entry: StoredBackup): Promise<boolean> {
    if (this.pins.has(entry.id) || this.deleting.has(entry.id)) return false;
    this.deleting.add(entry.id);
    try {
      const current = await this.readEntry(`backup-${entry.id}`);
      if (!current || current.size !== entry.size || current.filename !== entry.filename || !await this.rootSafe()) return false;
      return await this.removeKnownDirectory(current.directory, new Set([current.filename, COMPLETE_MARKER, STAGE_MARKER]), COMPLETE_MARKER);
    } finally { this.deleting.delete(entry.id); }
  }

  private async cleanInterruptedStages(): Promise<boolean> {
    let clean = true;
    const directory = await opendir(this.root);
    for await (const item of directory) {
      if (item.isDirectory() && !item.isSymbolicLink() && item.name.startsWith('.pending-') && UUID.test(item.name.slice('.pending-'.length))) {
        if (!await this.removeStage(join(this.root, item.name))) clean = false;
      }
    }
    return clean;
  }

  private async removeStage(directory: string): Promise<boolean> {
    if (dirname(directory) !== this.root || !basename(directory).startsWith('.pending-')) return false;
    const id = basename(directory).slice('.pending-'.length);
    if (!UUID.test(id)) return false;
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || dirname(await realpath(directory)) !== this.root) return false;
      const markerInfo = await lstat(join(directory, STAGE_MARKER));
      if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 1024) return false;
      const marker = JSON.parse(await readFile(join(directory, STAGE_MARKER), 'utf8'));
      if (marker.owner !== OWNER || marker.version !== 1 || marker.id !== id || !await this.rootSafe()) return false;
      return this.removeKnownDirectory(directory, STAGE_FILES, STAGE_MARKER);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
  }

  /** Never recurse: an unexpected file, directory or symlink makes the whole folder ineligible. */
  private async removeKnownDirectory(directory: string, allowed: Set<string>, marker: string): Promise<boolean> {
    const files: string[] = [];
    const folder = await opendir(directory);
    for await (const entry of folder) {
      if (!entry.isFile() || entry.isSymbolicLink() || !allowed.has(entry.name)) return false;
      files.push(entry.name);
    }
    if (!files.includes(marker)) return false;
    for (const name of files.sort((a, b) => Number(a === marker) - Number(b === marker))) {
      const path = join(directory, name);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || dirname(await realpath(path)) !== await realpath(directory)) return false;
      await unlink(path);
    }
    await rmdir(directory);
    return true;
  }

  private notice(kind: AutoBackupNotice['kind'], message: string): void {
    if (this.state.notified.includes(kind)) return;
    this.state.incidentId ??= randomUUID();
    this.state.notified.push(kind); this.save();
    const notice: AutoBackupNotice = { kind, message, noticeId: `${this.state.incidentId}:${kind}`, createdAt: this.iso(this.clock()) };
    try {
      const pending = Promise.resolve(this.options.notify?.(notice)).catch(error => reportRuntimeError('automatic-backup-notification', error))
        .finally(() => { this.pendingNotices.delete(pending); });
      this.pendingNotices.add(pending);
    }
    catch (error) { reportRuntimeError('automatic-backup-notification', error); }
  }

  private save(): void { this.db.setValue(STATE_KEY, JSON.stringify(this.state)); }
  private iso(time: number): string { return new Date(time).toISOString(); }
  private assertReady(): void { if (!this.initialized || this.stopped) throw new ApiError(503, '自动备份服务尚未就绪或已停止'); }
}
