import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import type { Express, RequestHandler } from 'express';
import nodemailer from 'nodemailer';
import type { SecurityEvent, SecurityEventInput, SecuritySettings } from '../shared/security.ts';
import type { AutoBackupNotice, WebDavSettings, WebDavSettingsInput } from '../shared/auto-backup.ts';
import { authSourceKey } from './auth-throttle.ts';
import { ApiError, GalleryDb } from './db.ts';
import { reportRuntimeError } from './runtime-log.ts';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
export const SECURITY_MAX_ATTACK_SOURCES = 4096;
const DEFAULT_SETTINGS: SecuritySettings = {
  enabled: false, host: '', port: 465, secure: true, username: '', hasPassword: false,
  from: '', to: [], notifyNewSourceLogin: true, notifyBruteForce: true,
};
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const EMAIL = /^[A-Za-z0-9.!#$%&'*+\/=\?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/;

export interface SecurityMessage { from: string; to: string[]; subject: string; text: string }
export interface SecurityTransport { sendMail(message: SecurityMessage): Promise<unknown>; close?(): void }
export interface SecurityServiceOptions {
  clock?: () => number;
  transportFactory?: (settings: SecuritySettings & { password: string }) => SecurityTransport;
}
interface ConfigRow { data: string; password: string }
interface WebDavRow { data: string; password: string }
interface EventRow {
  id: string; type: SecurityEvent['type']; username: string; source: string; created_at: number;
  detail: string; new_source: number; status: SecurityEvent['status']; error: string | null;
  attempts: number; next_attempt_at: number; user_agent: string;
}

function text(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, maximum).trim() : '';
}

function storedSettings(raw: string | undefined, scope: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    reportRuntimeError(scope, new Error('Stored settings are invalid'));
    return {};
  }
}

function smtpTransport(settings: SecuritySettings & { password: string }): SecurityTransport {
  const transport = nodemailer.createTransport({
    host: settings.host, port: settings.port, secure: settings.secure,
    requireTLS: true, ignoreTLS: false, opportunisticTLS: false,
    auth: { user: settings.username, pass: settings.password },
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: settings.host },
    connectionTimeout: 8_000, greetingTimeout: 8_000, socketTimeout: 12_000, dnsTimeout: 8_000,
    disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false,
  });
  return {
    async sendMail(message) {
      const result = await transport.sendMail(message);
      if (result.rejected?.length || !result.accepted?.length) {
        throw Object.assign(new Error('Recipient not accepted'), { code: 'ERECIPIENT' });
      }
      return result;
    },
    close() { transport.close(); },
  };
}

function deliveryError(error: unknown): string {
  // SMTP responses can contain credentials, recipients, or attacker-controlled text.
  const code = (error && typeof error === 'object' && 'code' in error) ? String(error.code) : '';
  if (code === 'EAUTH') return '邮箱认证失败，请检查 SMTP 用户名和授权码';
  if (code === 'ETIMEDOUT' || code === 'EDNS' || code === 'ECONNECTION' || code === 'ESOCKET') return '邮件服务器暂时无法连接，请检查地址、网络和 TLS 设置';
  if (code === 'ERECIPIENT' || code === 'EENVELOPE') return '邮件服务器未接受发件人或收件人，请检查邮箱地址';
  if (code === 'ETLS' || code.startsWith('ERR_TLS') || code.includes('CERT')) return '邮件服务器的 TLS 验证失败，请检查服务器地址和证书';
  return '邮件发送失败，请检查 SMTP 配置和邮件服务状态';
}

function retryable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String(error.code) : '';
  const response = 'responseCode' in error ? Number(error.responseCode) : 0;
  return ['ETIMEDOUT', 'EDNS', 'ECONNECTION', 'ESOCKET'].includes(code) || (response >= 400 && response < 500);
}

export class SecurityService {
  private readonly clock: () => number;
  private readonly transportFactory: NonNullable<SecurityServiceOptions['transportFactory']>;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly transports = new Set<SecurityTransport>();
  private readonly cancelDeliveries = new Set<() => void>();
  private closed = false;
  private running: Promise<void> | null = null;
  private testing: Promise<void> | null = null;
  private nextMaintenanceAt = 0;

  constructor(private readonly db: GalleryDb, options: SecurityServiceOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.transportFactory = options.transportFactory ?? smtpTransport;
    db.connection.exec(`
      CREATE TABLE IF NOT EXISTS security_config (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL, password TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS backup_webdav_config (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL, password TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS security_sources (
        user_id INTEGER NOT NULL, source_key TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
        PRIMARY KEY(user_id, source_key)
      );
      CREATE TABLE IF NOT EXISTS security_events (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, username TEXT NOT NULL, source TEXT NOT NULL,
        created_at INTEGER NOT NULL, detail TEXT NOT NULL, new_source INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0, user_agent TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS security_events_created ON security_events(created_at);
      CREATE TABLE IF NOT EXISTS security_limits (key TEXT PRIMARY KEY, window_until INTEGER NOT NULL, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS security_backup_notices (kind TEXT PRIMARY KEY, notice_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS security_sources_last_seen ON security_sources(last_seen);
    `);
    // A test is requested synchronously by an administrator and must never be
    // replayed unexpectedly after a process restart.
    db.connection.prepare("UPDATE security_events SET status='failed',error='服务重启中断了测试邮件，请检查收件箱后手动重试' WHERE status='pending' AND type='test'").run();
    this.prune();
    this.timer = setInterval(() => { void this.flush(); }, 10_000);
    this.timer.unref();
    setImmediate(() => { void this.flush(); });
  }

  private config(): ConfigRow | undefined {
    return this.db.connection.prepare('SELECT data,password FROM security_config WHERE id=1').get() as unknown as ConfigRow | undefined;
  }

  getSettings(): SecuritySettings {
    const row = this.config();
    const data = storedSettings(row?.data, 'mail-settings');
    // This object crosses the API boundary. Never spread persisted data into it:
    // old or corrupted rows may contain credential fields beyond this whitelist.
    return {
      enabled: typeof data.enabled === 'boolean' ? data.enabled : DEFAULT_SETTINGS.enabled,
      host: typeof data.host === 'string' ? data.host : DEFAULT_SETTINGS.host,
      port: typeof data.port === 'number' && Number.isInteger(data.port) ? data.port : DEFAULT_SETTINGS.port,
      secure: typeof data.secure === 'boolean' ? data.secure : DEFAULT_SETTINGS.secure,
      username: typeof data.username === 'string' ? data.username : DEFAULT_SETTINGS.username,
      hasPassword: Boolean(row?.password),
      from: typeof data.from === 'string' ? data.from : DEFAULT_SETTINGS.from,
      to: Array.isArray(data.to) ? data.to.filter((value): value is string => typeof value === 'string') : [],
      notifyNewSourceLogin: typeof data.notifyNewSourceLogin === 'boolean' ? data.notifyNewSourceLogin : DEFAULT_SETTINGS.notifyNewSourceLogin,
      notifyBruteForce: typeof data.notifyBruteForce === 'boolean' ? data.notifyBruteForce : DEFAULT_SETTINGS.notifyBruteForce,
    };
  }

  getWebDavSettings(): WebDavSettings {
    const row = this.db.connection.prepare('SELECT data,password FROM backup_webdav_config WHERE id=1').get() as unknown as WebDavRow | undefined;
    const data = storedSettings(row?.data, 'webdav-settings');
    return {
      enabled: typeof data.enabled === 'boolean' ? data.enabled : false,
      url: typeof data.url === 'string' ? data.url : '',
      username: typeof data.username === 'string' ? data.username : '',
      hasPassword: Boolean(row?.password),
    };
  }

  updateWebDavSettings(input: unknown): WebDavSettings {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'WebDAV 设置格式不正确');
    const patch = input as Record<string, unknown>;
    const current = this.getWebDavSettings();
    for (const field of ['enabled', 'clearPassword'] as const) {
      if (patch[field] !== undefined && typeof patch[field] !== 'boolean') throw new ApiError(400, 'WebDAV 开关格式不正确');
    }
    const settings: WebDavSettings = {
      enabled: (patch.enabled as boolean | undefined) ?? current.enabled,
      url: patch.url === undefined ? current.url : typeof patch.url === 'string' ? patch.url.trim() : '',
      username: patch.username === undefined ? current.username : typeof patch.username === 'string' ? patch.username.trim() : '',
      hasPassword: current.hasPassword,
    };
    if (patch.url !== undefined && (typeof patch.url !== 'string' || patch.url.length > 2048 || CONTROL.test(patch.url))) throw new ApiError(400, 'WebDAV 地址格式不正确');
    if (patch.username !== undefined && (typeof patch.username !== 'string' || patch.username.length > 254 || CONTROL.test(patch.username) || patch.username.includes(':'))) throw new ApiError(400, 'WebDAV 用户名格式不正确');
    if (settings.url) {
      let url: URL;
      try { url = new URL(settings.url); } catch { throw new ApiError(400, '请填写完整的 WebDAV HTTPS 地址'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443')) {
        throw new ApiError(400, 'WebDAV 地址必须使用 HTTPS，且不能在地址中包含账号、密码、查询参数或自定义端口');
      }
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
      settings.url = url.href;
    }
    if (patch.password !== undefined && (typeof patch.password !== 'string' || patch.password.length > 2048 || /[\r\n\u0000]/.test(patch.password))) throw new ApiError(400, 'WebDAV 密码格式不正确');
    if (patch.clearPassword && patch.password) throw new ApiError(400, '清除 WebDAV 密码时不能同时填写新密码');
    const old = this.db.connection.prepare('SELECT password FROM backup_webdav_config WHERE id=1').get() as { password: string } | undefined;
    let encrypted = patch.clearPassword ? '' : old?.password ?? '';
    if (patch.password) encrypted = this.encrypt(patch.password);
    settings.hasPassword = Boolean(encrypted);
    if (settings.enabled && (!settings.url || !settings.username || !settings.hasPassword)) throw new ApiError(400, '启用 WebDAV 备份前，请填写 HTTPS 地址、用户名和密码');
    const { hasPassword: _hasPassword, ...stored } = settings;
    this.db.connection.prepare('INSERT INTO backup_webdav_config(id,data,password) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,password=excluded.password').run(JSON.stringify(stored), encrypted);
    return this.getWebDavSettings();
  }

  getBackupWebDavTarget(): { url: string; username: string; password: string } | null {
    const settings = this.getWebDavSettings();
    if (!settings.enabled) return null;
    const row = this.db.connection.prepare('SELECT password FROM backup_webdav_config WHERE id=1').get() as { password: string } | undefined;
    if (!row?.password) throw new ApiError(400, '请在备份设置中填写 WebDAV 密码');
    try {
      const value = Buffer.from(row.password, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', this.key(), value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return { url: settings.url, username: settings.username, password: Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8') };
    } catch { throw new ApiError(400, '无法读取 WebDAV 密码，请重新填写并保存'); }
  }

  private key(): Buffer {
    const path = join(this.db.directory, 'security-mail.key');
    try {
      const key = readFileSync(path);
      if (key.length !== 32) throw new Error('Invalid mail credential key');
      return key;
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
      const key = randomBytes(32);
      try { writeFileSync(path, key, { flag: 'wx', mode: 0o600 }); return key; }
      catch (writeError) {
        if (writeError && typeof writeError === 'object' && 'code' in writeError && writeError.code === 'EEXIST') return this.key();
        throw writeError;
      }
    }
  }

  private encrypt(password: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }

  private credentials(): SecuritySettings & { password: string } {
    const settings = this.getSettings();
    this.requireComplete(settings);
    try {
      const value = Buffer.from(this.config()!.password, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', this.key(), value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return { ...settings, password: Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8') };
    } catch { throw new ApiError(400, '无法读取 SMTP 授权码，请重新填写并保存'); }
  }

  private requireComplete(settings: SecuritySettings): void {
    if (!settings.host || !settings.username || !settings.hasPassword || !settings.from || !settings.to.length) {
      throw new ApiError(400, '请先填写并保存 SMTP 地址、用户名、授权码、发件人和提醒收件人');
    }
  }

  updateSettings(input: unknown): SecuritySettings {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, '邮件设置格式不正确');
    const patch = input as Record<string, unknown>;
    const settings = this.getSettings();
    for (const field of ['enabled', 'secure', 'notifyNewSourceLogin', 'notifyBruteForce', 'clearPassword'] as const) {
      if (patch[field] !== undefined && typeof patch[field] !== 'boolean') throw new ApiError(400, '邮件开关设置格式不正确');
      if (field !== 'clearPassword' && patch[field] !== undefined) settings[field] = patch[field] as boolean;
    }
    for (const field of ['host', 'username', 'from'] as const) {
      if (patch[field] === undefined) continue;
      if (typeof patch[field] !== 'string' || patch[field].length > 254 || CONTROL.test(patch[field])) throw new ApiError(400, 'SMTP 地址或账户格式不正确');
      settings[field] = patch[field].trim();
    }
    if (settings.host && (!/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(settings.host)
      || settings.host.split('.').some(part => !part || part.length > 63 || part.startsWith('-') || part.endsWith('-')) || isIP(settings.host))) {
      throw new ApiError(400, '请填写邮件服务商提供的 SMTP 主机名，例如 smtp.example.com');
    }
    if (patch.port !== undefined) {
      if (typeof patch.port !== 'number' || !Number.isInteger(patch.port)) throw new ApiError(400, 'SMTP 端口格式不正确');
      settings.port = patch.port;
    }
    if ((settings.secure && settings.port !== 465) || (!settings.secure && settings.port !== 587)) {
      throw new ApiError(400, 'SSL/TLS 使用 465 端口，STARTTLS 使用 587 端口');
    }
    if (settings.from && !EMAIL.test(settings.from)) throw new ApiError(400, '发件人需要填写一个有效邮箱地址');
    if (patch.to !== undefined) {
      if (!Array.isArray(patch.to) || patch.to.length > 10) throw new ApiError(400, '提醒收件人最多 10 个');
      settings.to = [...new Set(patch.to.map(value => {
        if (typeof value !== 'string' || value.length > 254 || CONTROL.test(value) || !EMAIL.test(value.trim())) throw new ApiError(400, '提醒收件人邮箱格式不正确');
        return value.trim();
      }))];
    }
    if (patch.password !== undefined && (typeof patch.password !== 'string' || patch.password.length > 2048 || /[\r\n\u0000]/.test(patch.password))) {
      throw new ApiError(400, 'SMTP 授权码格式不正确');
    }
    if (patch.clearPassword && patch.password) throw new ApiError(400, '清除授权码时不能同时填写新授权码');
    let encrypted = patch.clearPassword ? '' : this.config()?.password ?? '';
    settings.hasPassword = Boolean(patch.password || encrypted);
    if (settings.enabled) this.requireComplete(settings);
    if (patch.password) encrypted = this.encrypt(patch.password as string);
    const { hasPassword: _hasPassword, ...stored } = settings;
    this.db.connection.prepare('INSERT INTO security_config(id,data,password) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,password=excluded.password').run(JSON.stringify(stored), encrypted);
    if (!settings.enabled) this.db.connection.prepare("UPDATE security_events SET status='disabled',error=NULL WHERE status='pending' AND type<>'test'").run();
    if (!settings.notifyNewSourceLogin) this.db.connection.prepare("UPDATE security_events SET status='disabled',error=NULL WHERE status='pending' AND type='login_success'").run();
    if (!settings.notifyBruteForce) this.db.connection.prepare("UPDATE security_events SET status='disabled',error=NULL WHERE status='pending' AND type='login_blocked'").run();
    return this.getSettings();
  }

  private prune(): void {
    const now = this.clock();
    this.db.connection.prepare('DELETE FROM security_limits WHERE window_until <= ?').run(now);
    this.db.connection.prepare('DELETE FROM security_sources WHERE last_seen < ?').run(now - 180 * DAY);
    if (this.db.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_users'").get()) {
      this.db.connection.exec('DELETE FROM security_sources WHERE user_id NOT IN (SELECT id FROM auth_users)');
    }
    this.db.connection.prepare("DELETE FROM security_events WHERE created_at < ? AND status <> 'pending'").run(now - 90 * DAY);
    this.trimHistory();
    this.nextMaintenanceAt = now + MINUTE;
  }

  private trimHistory(): void {
    this.db.connection.exec("DELETE FROM security_events WHERE id IN (SELECT id FROM security_events WHERE status<>'pending' ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET 1000)");
  }

  private reserve(key: string, count: number, window: number): boolean {
    const now = this.clock();
    const row = this.db.connection.prepare('SELECT count,window_until FROM security_limits WHERE key=?').get(key) as { count: number; window_until: number } | undefined;
    if (row && row.window_until > now && row.count >= count) return false;
    if (!row && key.startsWith('attack:') && Number(this.db.connection.prepare("SELECT COUNT(*) AS count FROM security_limits WHERE key LIKE 'attack:%'").get()!.count) >= SECURITY_MAX_ATTACK_SOURCES) return false;
    this.db.connection.prepare(`INSERT INTO security_limits(key,window_until,count) VALUES(?,?,1)
      ON CONFLICT(key) DO UPDATE SET window_until=excluded.window_until,count=?`).run(key, row && row.window_until > now ? row.window_until : now + window, row && row.window_until > now ? row.count + 1 : 1);
    return true;
  }

  private addEvent(input: SecurityEventInput | { type: 'test'; source: string }, status: SecurityEvent['status'], detail: string, newSource = false, error: string | null = null): string {
    const id = randomUUID();
    this.db.connection.prepare(`INSERT INTO security_events(id,type,username,source,created_at,detail,new_source,status,error,user_agent) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      id, input.type, text('username' in input ? input.username : '', 80), text(input.source, 128), this.clock(),
      text(detail, 500), Number(newSource), status, error, text('userAgent' in input ? input.userAgent : '', 256),
    );
    // Keep the cap after every insertion, including repeated manual mail tests.
    this.trimHistory();
    return id;
  }

  /** Never allows SMTP or audit-storage failure to change a login result. */
  record(input: SecurityEventInput): void {
    if (this.closed) return;
    try {
      if (this.clock() >= this.nextMaintenanceAt) this.prune();
      const settings = this.getSettings();
      const key = authSourceKey(input.source);
      let newSource = false;
      if (input.type === 'login_success' && Number.isSafeInteger(input.userId) && input.userId! > 0) {
        newSource = !this.db.connection.prepare('SELECT 1 FROM security_sources WHERE user_id=? AND source_key=?').get(input.userId!, key);
        this.db.connection.prepare(`INSERT INTO security_sources(user_id,source_key,first_seen,last_seen) VALUES(?,?,?,?)
          ON CONFLICT(user_id,source_key) DO UPDATE SET last_seen=excluded.last_seen`).run(input.userId!, key, this.clock(), this.clock());
        this.db.connection.prepare('DELETE FROM security_sources WHERE user_id=? AND source_key IN (SELECT source_key FROM security_sources WHERE user_id=? ORDER BY last_seen DESC,rowid DESC LIMIT -1 OFFSET 256)').run(input.userId!, input.userId!);
      }
      // Coalesce attack traffic before writing the event log, including when mail is disabled.
      if (input.type === 'login_blocked' && !this.reserve(`attack:${key}`, 1, 15 * MINUTE)) return;
      const eligible = input.type === 'login_success' ? newSource && settings.notifyNewSourceLogin : input.type === 'login_blocked' ? settings.notifyBruteForce : input.type.startsWith('backup_');
      const detail = input.type === 'login_success' ? (newSource ? '账户从新来源登录成功' : '账户从已知来源登录成功')
        : input.type === 'login_blocked' ? '登录尝试过于频繁，已触发防暴力破解限制' : text(input.detail, 500) || '管理员修改了账户';
      let status: SecurityEvent['status'] = !eligible ? 'skipped' : !settings.enabled ? 'disabled' : 'pending';
      let error: string | null = null;
      if (status === 'pending' && input.type === 'login_blocked' && !this.reserve('attack-global', 1, MINUTE)) {
        status = 'skipped'; error = '短时间内的多来源攻击提醒已合并';
      }
      if (status === 'pending' && !this.reserve('mail-global', 20, 15 * MINUTE)) {
        status = 'skipped'; error = '已达到每 15 分钟 20 封提醒上限';
      }
      if (status === 'pending' && Number(this.db.connection.prepare("SELECT COUNT(*) AS count FROM security_events WHERE status='pending'").get()!.count) >= 50) {
        status = 'failed'; error = '提醒队列已满，请检查邮件服务状态';
      }
      this.addEvent(input, status, detail, newSource, error);
      if (status === 'pending') setImmediate(() => { void this.flush(); });
    } catch (error) { reportRuntimeError('security-record', error); }
  }

  recentEvents(): SecurityEvent[] {
    this.prune();
    const rows = this.db.connection.prepare('SELECT * FROM security_events ORDER BY created_at DESC,rowid DESC LIMIT 100').all() as unknown as EventRow[];
    return rows.map(row => ({ id: row.id, type: row.type, username: row.username, source: row.source,
      createdAt: new Date(row.created_at).toISOString(), detail: row.detail, newSource: Boolean(row.new_source), status: row.status, error: row.error }));
  }

  /** Four persisted slots coalesce backup notices across restarts without growing history keys. */
  notifyBackup(notice: AutoBackupNotice): void {
    if (this.closed) return;
    const types = { low_space: 'backup_warning', stopped: 'backup_failure', failed: 'backup_failure', recovered: 'backup_recovered' } as const;
    if (!Object.hasOwn(types, notice.kind)) return;
    try {
      const previous = this.db.connection.prepare('SELECT notice_id FROM security_backup_notices WHERE kind=?').get(notice.kind);
      if (previous?.notice_id === notice.noticeId) return;
      this.record({ type: types[notice.kind], source: '', detail: notice.message });
      this.db.connection.prepare('INSERT INTO security_backup_notices(kind,notice_id) VALUES(?,?) ON CONFLICT(kind) DO UPDATE SET notice_id=excluded.notice_id').run(notice.kind, notice.noticeId.slice(0, 200));
    } catch (error) { reportRuntimeError('backup-notification', error); }
  }

  private async deliver(row: EventRow, isTest = false): Promise<void> {
    let transport: SecurityTransport | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    try {
      const settings = this.credentials();
      if (!isTest && (!settings.enabled || (row.type === 'login_success' && !settings.notifyNewSourceLogin) || (row.type === 'login_blocked' && !settings.notifyBruteForce))) {
        this.db.connection.prepare("UPDATE security_events SET status='disabled',error=NULL WHERE id=?").run(row.id);
        return;
      }
      this.db.connection.prepare('UPDATE security_events SET attempts=attempts+1 WHERE id=?').run(row.id);
      transport = this.transportFactory(settings);
      this.transports.add(transport);
      const backupSubjects: Record<string, string> = { backup_warning: '自动备份空间不足', backup_failure: '自动备份已停止或失败', backup_recovered: '自动备份已恢复' };
      const subject = `拾光图库 · ${backupSubjects[row.type] ?? (row.type === 'test' ? '邮件提醒测试' : row.type === 'login_blocked' ? '异常登录尝试提醒' : '新来源登录提醒')}`;
      const content = [row.detail, `时间：${new Date(row.created_at).toISOString()}（UTC）`, row.username ? `账户：${row.username}` : '', row.source ? `来源 IP：${row.source}` : '', row.user_agent ? `客户端：${row.user_agent}` : '', '',
        row.type.startsWith('backup_') ? '请在图库设置 → 备份与恢复中查看可用空间、备份状态和处理期限。' : row.type === 'login_blocked' ? '系统已限制后续登录尝试。可在图库设置中查看安全记录。' : row.type === 'login_success' ? '如果不是你本人或已授权用户登录，请在图库设置中修改密码或停用对应账户。' : '这是你在图库设置中主动发送的测试邮件。',
        '此邮件由你的拾光图库发送。'].filter(Boolean).join('\n');
      await Promise.race([
        transport.sendMail({ from: settings.from, to: settings.to, subject, text: content }),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => { try { transport?.close?.(); } catch {} reject(Object.assign(new Error('SMTP timeout'), { code: 'ETIMEDOUT' })); }, 35_000); timeout.unref(); }),
        new Promise<never>((_, reject) => {
          cancel = () => reject(new ApiError(503, '邮件提醒服务正在关闭'));
          this.cancelDeliveries.add(cancel);
        }),
      ]);
      if (!this.closed) {
        this.db.connection.prepare("UPDATE security_events SET status='sent',error=NULL WHERE id=?").run(row.id);
        this.trimHistory();
      }
    } catch (error) {
      if (!this.closed) {
        const retry = !isTest && row.attempts < 1 && retryable(error) && this.getSettings().enabled;
        this.db.connection.prepare('UPDATE security_events SET status=?,error=?,next_attempt_at=? WHERE id=?').run(retry ? 'pending' : 'failed', deliveryError(error), this.clock() + MINUTE, row.id);
        this.trimHistory();
      }
      if (isTest) throw new ApiError(this.closed ? 503 : 502, this.closed ? '邮件提醒服务正在关闭' : deliveryError(error));
    } finally {
      if (timeout) clearTimeout(timeout);
      if (cancel) this.cancelDeliveries.delete(cancel);
      if (transport) { this.transports.delete(transport); try { transport.close?.(); } catch {} }
    }
  }

  /** Also used by isolated tests to await the current queue without real SMTP. */
  flush(): Promise<void> {
    if (this.running) return this.running;
    if (this.closed || this.testing) return Promise.resolve();
    this.running = (async () => {
      try {
        // Retention must also run when no new login or UI request arrives.
        if (this.clock() >= this.nextMaintenanceAt) this.prune();
        while (!this.closed) {
          const row = this.db.connection.prepare("SELECT * FROM security_events WHERE status='pending' AND type<>'test' AND next_attempt_at <= ? ORDER BY created_at,rowid LIMIT 1").get(this.clock()) as unknown as EventRow | undefined;
          if (!row) break;
          await this.deliver(row);
        }
      } catch (error) { reportRuntimeError('security-worker', error); }
    })().finally(() => { this.running = null; });
    return this.running;
  }

  async sendTest(): Promise<{ ok: true; message: string }> {
    if (this.closed) throw new ApiError(503, '邮件提醒服务正在关闭');
    this.credentials();
    if (this.testing || this.running) throw new ApiError(429, '正在发送邮件，请稍后再试');
    if (!this.reserve('mail-test', 1, MINUTE)) throw new ApiError(429, '测试邮件每分钟最多发送一次，请稍后再试');
    this.testing = (async () => {
      const id = this.addEvent({ type: 'test', source: '' }, 'pending', '管理员主动发送邮件提醒测试');
      const row = this.db.connection.prepare('SELECT * FROM security_events WHERE id=?').get(id) as unknown as EventRow;
      await this.deliver(row, true);
    })();
    try {
      await this.testing;
      return { ok: true, message: '测试邮件已交给邮件服务器，请检查收件箱或垃圾邮件' };
    } finally { this.testing = null; setImmediate(() => { void this.flush(); }); }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const cancel of this.cancelDeliveries) cancel();
    for (const transport of this.transports) { try { transport.close?.(); } catch {} }
    await Promise.allSettled([this.running, this.testing]);
  }
}

export function registerSecurityRoutes(app: Express, service: SecurityService, requireAdmin: RequestHandler): void {
  app.get('/api/admin/security/settings', requireAdmin, (_req, res) => res.json(service.getSettings()));
  app.patch('/api/admin/security/settings', requireAdmin, (req, res) => res.json(service.updateSettings(req.body)));
  app.get('/api/admin/security/events', requireAdmin, (_req, res) => res.json(service.recentEvents()));
  app.post('/api/admin/security/test', requireAdmin, async (_req, res) => res.json(await service.sendTest()));
}
