import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Album, AlbumInput, CloudLink, GallerySettings, LinkHealth, SyncLog } from '../shared/types.ts';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const UNCATEGORIZED = '未分类';
const INITIAL_CATEGORIES = ['自然风光', '城市漫游', '人像摄影', '灵感收藏', UNCATEGORIZED];
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function isBaiduLink(url: string): boolean {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && ['pan.baidu.com', 'yun.baidu.com'].includes(parsed.hostname) && !parsed.username && !parsed.password && (!parsed.port || parsed.port === '443'); }
  catch { return false; }
}

function stringField(value: unknown, label: string, max: number, fallback = ''): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new ApiError(400, `${label}格式不正确`);
  if (value.length > max) throw new ApiError(400, `${label}不能超过 ${max} 个字符`);
  return value.trim();
}

export function normalizeCategoryName(value: unknown): string {
  if (typeof value !== 'string') throw new ApiError(400, '分类名称格式不正确');
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new ApiError(400, '分类名称不能包含控制字符');
  const name = value.trim();
  if (!name) throw new ApiError(400, '请填写分类名称');
  if (name.length > 80) throw new ApiError(400, '分类名称不能超过 80 个字符');
  return name;
}

export function normalizeInput(value: unknown, previous?: Album, now = new Date().toISOString()): AlbumInput & { links: CloudLink[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, '请提供有效的图集信息');
  const input = value as Record<string, unknown>;
  const title = stringField(input.title, '标题', 200, previous?.title);
  if (!title) throw new ApiError(400, '请填写图集标题');
  let tags = previous?.tags ?? [];
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.length > 30) throw new ApiError(400, '标签最多 30 个');
    tags = [...new Set(input.tags.map(tag => stringField(tag, '标签', 50)).filter(Boolean))];
  }
  if (input.favorite !== undefined && typeof input.favorite !== 'boolean') throw new ApiError(400, '收藏状态格式不正确');
  let links = previous?.links ?? [];
  if (input.links !== undefined) {
    if (!Array.isArray(input.links) || input.links.length > 20) throw new ApiError(400, '网盘链接最多 20 个');
    const usedIds = new Set<string>();
    links = input.links.map((raw: unknown) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError(400, '网盘链接格式不正确');
      const item = raw as Record<string, unknown>;
      const url = stringField(item.url, '网盘地址', 2048);
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new ApiError(400, '网盘地址需要是完整的 http 或 https 链接'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new ApiError(400, '网盘地址只支持 http 或 https 链接');
      if (item.syncEnabled !== undefined && typeof item.syncEnabled !== 'boolean') throw new ApiError(400, '自动同步状态格式不正确');
      const old = typeof item.id === 'string' ? previous?.links.find(link => link.id === item.id) : undefined;
      const id = old && !usedIds.has(old.id) ? old.id : randomUUID();
      usedIds.add(id);
      const code = stringField(item.code, '提取码', 32);
      const syncEnabled = Boolean(item.syncEnabled) && isBaiduLink(url);
      const unchanged = old?.url === url && old?.code === code;
      const preserve = unchanged ? old : undefined;
      return {
        id, label: stringField(item.label, '链接名称', 80) || (isBaiduLink(url) ? '百度网盘' : '网盘链接'), url, code,
        password: stringField(item.password, '解压密码', 200), note: stringField(item.note, '下载说明', 2000), syncEnabled,
        status: syncEnabled ? (preserve?.syncEnabled ? preserve.status : 'pending') : 'disabled',
        message: syncEnabled ? (preserve?.syncEnabled ? preserve.message : '等待首次检测') : '未启用自动同步',
        lastCheckedAt: preserve?.lastCheckedAt ?? null,
        nextCheckAt: syncEnabled ? (preserve?.syncEnabled ? preserve.nextCheckAt ?? now : now) : null,
        remoteUpdatedAt: preserve?.remoteUpdatedAt ?? null,
        health: preserve?.health ?? {
          status: isBaiduLink(url) ? 'unchecked' : 'unsupported',
          message: isBaiduLink(url) ? '尚未检测链接有效性' : '暂仅支持检测百度网盘链接，请打开链接手动确认',
          checkedAt: null, nextCheckAt: isBaiduLink(url) ? now : null,
        },
      } satisfies CloudLink;
    });
  }
  return {
    title, description: stringField(input.description, '简介', 10000, previous?.description),
    category: normalizeCategoryName(input.category === undefined ? previous?.category ?? UNCATEGORIZED : input.category),
    favorite: (input.favorite as boolean | undefined) ?? previous?.favorite ?? false, tags, links,
  };
}

export function refreshAlbumTime(album: Album): Album {
  const times = album.links.filter(link => link.syncEnabled && isBaiduLink(link.url) && link.remoteUpdatedAt).map(link => link.remoteUpdatedAt!).sort();
  album.updateSource = times.length ? 'baidu' : 'local';
  album.updatedAt = times.at(-1) ?? album.localUpdatedAt;
  return album;
}

export class GalleryDb {
  readonly connection: DatabaseSync;
  constructor(public directory: string) {
    mkdirSync(directory, { recursive: true });
    const newDatabase = !existsSync(join(directory, 'gallery.db'));
    this.connection = new DatabaseSync(join(directory, 'gallery.db'));
    if (newDatabase) this.connection.exec('PRAGMA auto_vacuum=INCREMENTAL');
    this.connection.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      PRAGMA cache_size=-8192; PRAGMA journal_size_limit=16777216; PRAGMA wal_autocheckpoint=1000;
      CREATE TABLE IF NOT EXISTS albums (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS categories (name TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_logs (id TEXT PRIMARY KEY, checked_at TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sync_logs_checked_at ON sync_logs(checked_at DESC);`);
    // Seed once, so removed default categories stay removed after a restart.
    if (this.value('categoriesInitialized') !== 'true') {
      this.transaction(() => {
        const insert = this.connection.prepare('INSERT OR IGNORE INTO categories(name) VALUES(?)');
        for (const name of INITIAL_CATEGORIES) insert.run(name);
        for (const album of this.albums()) insert.run(album.category || UNCATEGORIZED);
        this.setValue('categoriesInitialized', 'true');
      });
    }
  }
  private transaction<T>(operation: () => T): T {
    // A savepoint also works when the scheduler already owns a transaction.
    this.connection.exec('SAVEPOINT gallery_change');
    try {
      const result = operation();
      this.connection.exec('RELEASE SAVEPOINT gallery_change');
      return result;
    } catch (error) {
      this.connection.exec('ROLLBACK TO SAVEPOINT gallery_change; RELEASE SAVEPOINT gallery_change');
      throw error;
    }
  }
  categories(): string[] { return this.connection.prepare('SELECT name FROM categories ORDER BY rowid').all().map(row => row.name as string); }
  private categoryState(): { categories: string[]; albums: Album[] } { return { categories: this.categories(), albums: this.albums() }; }
  createCategory(value: unknown): { categories: string[]; albums: Album[] } {
    const name = normalizeCategoryName(value);
    this.transaction(() => {
      if (this.categories().includes(name)) throw new ApiError(409, '此分类已存在');
      this.connection.prepare('INSERT INTO categories(name) VALUES(?)').run(name);
    });
    return this.categoryState();
  }
  renameCategory(value: unknown, replacement: unknown): { categories: string[]; albums: Album[] } {
    const oldName = normalizeCategoryName(value);
    const newName = normalizeCategoryName(replacement);
    this.transaction(() => {
      if (oldName === UNCATEGORIZED) throw new ApiError(400, '未分类为保留分类，不能重命名');
      const categories = this.categories();
      if (!categories.includes(oldName)) throw new ApiError(404, '分类不存在，请刷新后重试');
      if (oldName === newName) return;
      if (categories.includes(newName)) throw new ApiError(409, '此分类已存在');
      this.connection.prepare('UPDATE categories SET name = ? WHERE name = ?').run(newName, oldName);
      this.moveCategoryAlbums(oldName, newName);
    });
    return this.categoryState();
  }
  deleteCategory(value: unknown): { categories: string[]; albums: Album[] } {
    const name = normalizeCategoryName(value);
    this.transaction(() => {
      if (name === UNCATEGORIZED) throw new ApiError(400, '未分类为保留分类，不能删除');
      if (!this.categories().includes(name)) throw new ApiError(404, '分类不存在，请刷新后重试');
      this.connection.prepare('DELETE FROM categories WHERE name = ?').run(name);
      this.moveCategoryAlbums(name, UNCATEGORIZED);
    });
    return this.categoryState();
  }
  private moveCategoryAlbums(oldName: string, newName: string): void {
    const update = this.connection.prepare('UPDATE albums SET body = ? WHERE id = ?');
    for (const album of this.albums()) {
      if (album.category !== oldName) continue;
      album.category = newName;
      // A taxonomy change must not advance timestamps or recalculate cloud state.
      update.run(JSON.stringify(album), album.id);
    }
  }
  albums(): Album[] {
    return this.connection.prepare('SELECT body FROM albums').all().map(row => JSON.parse(row.body as string) as Album).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  album(id: string): Album | undefined {
    const row = this.connection.prepare('SELECT body FROM albums WHERE id = ?').get(id);
    return row ? JSON.parse(row.body as string) as Album : undefined;
  }
  requireAlbum(id: string): Album { const result = this.album(id); if (!result) throw new ApiError(404, '图集不存在'); return result; }
  save(album: Album): Album {
    album.category = normalizeCategoryName(album.category);
    refreshAlbumTime(album);
    this.transaction(() => {
      this.connection.prepare('INSERT OR IGNORE INTO categories(name) VALUES(?)').run(album.category);
      this.connection.prepare('INSERT INTO albums(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(album.id, JSON.stringify(album));
    });
    return album;
  }
  updateLinkHealth(albumId: string, linkId: string, url: string, code: string, health: LinkHealth): Album | undefined {
    const album = this.album(albumId);
    const link = album?.links.find(item => item.id === linkId);
    if (!album || !link || link.url !== url || link.code !== code) return undefined;
    link.health = health;
    // Health checks never advance or recalculate any album or sync timestamps.
    this.connection.prepare('UPDATE albums SET body = ? WHERE id = ?').run(JSON.stringify(album), album.id);
    return album;
  }
  remove(id: string): void { this.connection.prepare('DELETE FROM albums WHERE id = ?').run(id); }
  value(key: string): string | undefined { return this.connection.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value as string | undefined; }
  setValue(key: string, value: string): void { this.connection.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  settings(): GallerySettings { return { hasBaiduCookie: Boolean(this.value('baiduCookie')), autoSync: this.value('autoSync') !== 'false', intervalHours: 24 }; }
  updateSettings(input: unknown): GallerySettings {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, '设置格式不正确');
    const data = input as Record<string, unknown>;
    if (data.autoSync !== undefined && typeof data.autoSync !== 'boolean') throw new ApiError(400, '自动同步设置格式不正确');
    if (data.baiduCookie !== undefined && (typeof data.baiduCookie !== 'string' || data.baiduCookie.length > 20000 || /[\r\n]/.test(data.baiduCookie))) throw new ApiError(400, 'Cookie 格式不正确');
    this.connection.exec('BEGIN');
    try {
      if (typeof data.autoSync === 'boolean') this.setValue('autoSync', String(data.autoSync));
      if (typeof data.baiduCookie === 'string') this.setValue('baiduCookie', data.baiduCookie.trim());
      this.connection.exec('COMMIT');
    } catch (error) { this.connection.exec('ROLLBACK'); throw error; }
    return this.settings();
  }
  log(log: SyncLog): void {
    this.connection.prepare('INSERT INTO sync_logs(id,checked_at,body) VALUES(?,?,?)').run(log.id, log.checkedAt, JSON.stringify(log));
    this.connection.prepare('DELETE FROM sync_logs WHERE id NOT IN (SELECT id FROM sync_logs ORDER BY checked_at DESC, rowid DESC LIMIT 1000)').run();
  }
  logs(): SyncLog[] { return this.connection.prepare('SELECT body FROM sync_logs ORDER BY checked_at DESC, rowid DESC LIMIT 100').all().map(row => JSON.parse(row.body as string) as SyncLog); }
  close(): void { this.connection.close(); }
}
