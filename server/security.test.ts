import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { GalleryDb, ApiError } from './db.ts';
import { registerSecurityRoutes, SecurityService, SECURITY_MAX_ATTACK_SOURCES, type SecurityMessage, type SecurityServiceOptions } from './security.ts';

const mailConfig = {
  enabled: true, host: 'smtp.example.com', port: 465, secure: true, username: 'gallery@example.com',
  password: 'smtp-authorization-secret-test-only', from: 'gallery@example.com', to: ['owner@example.com'],
};

async function fixture(options: SecurityServiceOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-security-test-'));
  const db = new GalleryDb(directory);
  const messages: SecurityMessage[] = [];
  let now = Date.UTC(2026, 9, 9);
  const service = new SecurityService(db, {
    clock: () => now,
    transportFactory: () => ({ sendMail: async message => { messages.push(message); } }),
    ...options,
  });
  return { directory, db, service, messages, advance: (ms: number) => { now += ms; },
    async close() { await service.close(); db.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('SMTP settings are disabled by default, validated, encrypted, and never return credentials', async () => {
  const f = await fixture();
  try {
    assert.equal(f.service.getSettings().enabled, false);
    assert.throws(() => f.service.updateSettings({ enabled: true }), /请先填写/);
    assert.throws(() => f.service.updateSettings({ host: 'https://smtp.example.com' }), /SMTP 主机名/);
    assert.throws(() => f.service.updateSettings({ host: '127.0.0.1' }), /SMTP 主机名/);
    assert.throws(() => f.service.updateSettings({ secure: false, port: 25 }), /587/);
    assert.throws(() => f.service.updateSettings({ from: 'x@example.com\r\nBcc:x@example.org' }), /格式不正确/);
    assert.throws(() => f.service.updateSettings({ to: ['bad-email'] }), /邮箱格式/);
    const settings = f.service.updateSettings(mailConfig);
    assert.equal(settings.hasPassword, true);
    assert.ok(!JSON.stringify(settings).includes(mailConfig.password));
    const stored = JSON.stringify(f.db.connection.prepare('SELECT * FROM security_config').get());
    assert.ok(!stored.includes(mailConfig.password));
    assert.equal((await readFile(join(f.directory, 'security-mail.key'))).length, 32);
    assert.equal(f.service.updateSettings({ password: '', from: 'alerts@example.com' }).hasPassword, true);
    assert.throws(() => f.service.updateSettings({ clearPassword: true }), /请先填写/);
    assert.equal(f.service.updateSettings({ enabled: false, clearPassword: true }).hasPassword, false);
  } finally { await f.close(); }
});

test('WebDAV credentials are encrypted, omitted from settings, and only HTTPS destinations are accepted', async () => {
  const f = await fixture();
  try {
    const secret = 'webdav-app-password-secret';
    assert.deepEqual(f.service.getWebDavSettings(), { enabled: false, url: '', username: '', hasPassword: false });
    assert.throws(() => f.service.updateWebDavSettings({ enabled: true }), /HTTPS 地址/);
    assert.throws(() => f.service.updateWebDavSettings({ url: 'http://dav.example.com/files' }), /HTTPS/);
    assert.throws(() => f.service.updateWebDavSettings({ url: 'https://user:pass@dav.example.com/files' }), /HTTPS/);
    assert.throws(() => f.service.updateWebDavSettings({ url: 'https://dav.example.com/files?token=secret' }), /HTTPS/);
    const settings = f.service.updateWebDavSettings({ enabled: true, url: 'https://dav.example.com/dav/backups', username: 'gallery-user', password: secret });
    assert.deepEqual(settings, { enabled: true, url: 'https://dav.example.com/dav/backups/', username: 'gallery-user', hasPassword: true });
    assert(!JSON.stringify(settings).includes(secret));
    const row = JSON.stringify(f.db.connection.prepare('SELECT * FROM backup_webdav_config').get());
    assert(!row.includes(secret));
    const target = f.service.getBackupWebDavTarget(); assert.equal(target?.password, secret);
    assert.equal(f.service.updateWebDavSettings({ password: '' }).hasPassword, true);
    assert.equal(f.service.updateWebDavSettings({ enabled: false, clearPassword: true }).hasPassword, false);
  } finally { await f.close(); }
});

test('persisted SMTP and WebDAV settings cannot add credential fields to API models', async () => {
  const f = await fixture();
  try {
    const mail = f.service.updateSettings({ ...mailConfig, enabled: false });
    const webdav = f.service.updateWebDavSettings({ enabled: false, url: 'https://dav.example.com/backups/', username: 'test-gallery-user', password: 'webdav-whitelist-test-secret' });
    for (const table of ['security_config', 'backup_webdav_config']) {
      const row = f.db.connection.prepare(`SELECT data FROM ${table} WHERE id=1`).get()!;
      f.db.connection.prepare(`UPDATE ${table} SET data=? WHERE id=1`).run(JSON.stringify({
        ...JSON.parse(String(row.data)),
        password: 'legacy-plaintext-test-secret',
        authorization: 'Bearer injected-credential-test-secret',
        credentials: { password: 'nested-test-secret' },
        hasPassword: false,
      }));
    }
    assert.deepEqual(f.service.getSettings(), mail);
    assert.deepEqual(f.service.getWebDavSettings(), webdav);
    // Saving an unrelated field also removes legacy credential fields from JSON.
    f.service.updateSettings({ notifyBruteForce: false });
    f.service.updateWebDavSettings({ enabled: false });
    for (const table of ['security_config', 'backup_webdav_config']) {
      const saved = String(f.db.connection.prepare(`SELECT data FROM ${table} WHERE id=1`).get()!.data);
      assert(!saved.includes('test-secret'));
      assert(!saved.includes('password'));
      assert(!saved.includes('credentials'));
      assert(!saved.includes('authorization'));
    }
  } finally { await f.close(); }
});

test('malformed persisted settings do not expose raw database values or break public models', async () => {
  const f = await fixture();
  try {
    const defaultMail = f.service.getSettings();
    const defaultWebdav = f.service.getWebDavSettings();
    for (const raw of ['{"password":"truncated-test-secret"', 'null', '"raw-test-secret"', '["array-test-secret"]']) {
      f.db.connection.prepare('INSERT INTO security_config(id,data,password) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(raw, '');
      f.db.connection.prepare('INSERT INTO backup_webdav_config(id,data,password) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(raw, '');
      assert.deepEqual(f.service.getSettings(), defaultMail);
      assert.deepEqual(f.service.getWebDavSettings(), defaultWebdav);
    }
  } finally { await f.close(); }
});

test('only a new source for an account sends login email; mapped IPv4 and IPv6 /64 are normalized', async () => {
  const f = await fixture();
  try {
    f.service.updateSettings(mailConfig);
    f.service.record({ type: 'login_success', userId: 1, username: '管理员', source: '203.0.113.5' });
    f.service.record({ type: 'login_success', userId: 1, username: '管理员', source: '::ffff:203.0.113.5' });
    f.service.record({ type: 'login_success', userId: 2, username: '读者', source: '203.0.113.5' });
    f.service.record({ type: 'login_success', userId: 1, username: '管理员', source: '2001:db8:1:2::1' });
    f.service.record({ type: 'login_success', userId: 1, username: '管理员', source: '2001:db8:1:2::abc' });
    await f.service.flush();
    assert.equal(f.messages.length, 3);
    assert.equal(f.service.recentEvents().filter(event => event.newSource).length, 3);
    assert.equal(f.service.recentEvents().filter(event => event.status === 'skipped').length, 2);
    assert.ok(f.messages.every(message => message.subject.includes('新来源')));
  } finally { await f.close(); }
});

test('backup notices use admin recipients independently of login toggles, dedupe across restart, and record disabled mail', async () => {
  const f = await fixture();
  let restarted: SecurityService | undefined;
  try {
    const notice = { kind: 'low_space' as const, noticeId: 'space-episode-1', createdAt: new Date().toISOString(), message: '空间不足，将等待 24 小时，至少保留 1 份完整备份。' };
    f.service.notifyBackup(notice);
    assert.equal(f.service.recentEvents()[0].status, 'disabled');
    f.service.updateSettings({ ...mailConfig, notifyNewSourceLogin: false, notifyBruteForce: false });
    f.service.notifyBackup({ ...notice, noticeId: 'space-episode-2' });
    f.service.notifyBackup({ ...notice, noticeId: 'space-episode-2' });
    await f.service.flush();
    assert.equal(f.messages.length, 1);
    assert.match(f.messages[0].subject, /备份空间不足/);
    assert.deepEqual(f.messages[0].to, mailConfig.to);
    assert.match(f.messages[0].text, /24 小时/);
    await f.service.close();
    restarted = new SecurityService(f.db, { transportFactory: () => ({ sendMail: async message => { f.messages.push(message); } }) });
    restarted.notifyBackup({ ...notice, noticeId: 'space-episode-2' });
    restarted.notifyBackup({ ...notice, kind: 'stopped', noticeId: 'stopped-episode-2', message: '仅剩 1 份备份，停止删除。' });
    restarted.notifyBackup({ ...notice, kind: 'recovered', noticeId: 'recovered-episode-2', message: '备份已恢复' });
    await restarted.flush();
    assert.equal(f.messages.length, 3);
    assert.match(f.messages[1].subject, /停止或失败/);
    assert.match(f.messages[2].subject, /已恢复/);
    assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM security_backup_notices').get()!.n, 3);
  } finally { await restarted?.close(); await f.close(); }
});

test('source history and SMTP password survive service restart without resending known-source alert', async () => {
  const f = await fixture();
  let restarted: SecurityService | undefined;
  try {
    f.service.updateSettings(mailConfig);
    f.service.record({ type: 'login_success', userId: 1, source: '203.0.113.5' });
    await f.service.flush();
    await f.service.close();
    const captured: SecurityMessage[] = [];
    restarted = new SecurityService(f.db, { transportFactory: settings => {
      assert.equal(settings.password, mailConfig.password);
      return { sendMail: async message => { captured.push(message); } };
    } });
    restarted.record({ type: 'login_success', userId: 1, source: '203.0.113.5' });
    restarted.record({ type: 'login_success', userId: 1, source: '198.51.100.7' });
    await restarted.flush();
    assert.equal(captured.length, 1);
    assert.ok(captured[0].text.includes('198.51.100.7'));
  } finally { await restarted?.close(); await f.close(); }
});

test('disabled alerts and individual preference changes never deliver mail', async () => {
  const f = await fixture();
  try {
    f.service.record({ type: 'login_success', userId: 1, source: '203.0.113.5' });
    assert.equal(f.service.recentEvents()[0].status, 'disabled');
    f.service.updateSettings({ ...mailConfig, notifyNewSourceLogin: false, notifyBruteForce: false });
    f.service.record({ type: 'login_success', userId: 1, source: '203.0.113.6' });
    f.service.record({ type: 'login_blocked', source: '203.0.113.6' });
    f.service.record({ type: 'account_changed', source: '127.0.0.1', detail: '管理员添加了账户' });
    await f.service.flush();
    assert.equal(f.messages.length, 0);
    assert.equal(f.service.recentEvents().filter(event => event.status === 'skipped').length, 3);
  } finally { await f.close(); }
});

test('brute-force alerts coalesce across requests and rate limit changing sources', async () => {
  const f = await fixture();
  try {
    f.service.updateSettings(mailConfig);
    for (let i = 0; i < 100; i++) f.service.record({ type: 'login_blocked', source: '203.0.113.5' });
    for (let i = 6; i < 40; i++) f.service.record({ type: 'login_blocked', source: `203.0.113.${i}` });
    await f.service.flush();
    assert.equal(f.messages.length, 1);
    assert.equal(f.service.recentEvents().filter(event => event.source === '203.0.113.5').length, 1);
    f.advance(15 * 60_000 + 1);
    f.service.record({ type: 'login_blocked', source: '203.0.113.5' });
    await f.service.flush();
    assert.equal(f.messages.length, 2);
  } finally { await f.close(); }
});

test('overall email budget prevents alert floods across many new login sources', async () => {
  const f = await fixture();
  try {
    f.service.updateSettings(mailConfig);
    for (let i = 1; i <= 60; i++) f.service.record({ type: 'login_success', userId: 1, source: `203.0.113.${i}` });
    await f.service.flush();
    assert.equal(f.messages.length, 20);
    assert.equal(f.service.recentEvents().filter(event => event.error?.includes('上限')).length, 40);
  } finally { await f.close(); }
});

test('rotating attack sources cannot grow cooldown storage beyond its fixed capacity', async () => {
  const f = await fixture();
  try {
    const until = Date.UTC(2026, 9, 9) + 15 * 60_000;
    f.db.connection.exec('BEGIN');
    for (let i = 0; i < SECURITY_MAX_ATTACK_SOURCES; i++) f.db.connection.prepare('INSERT INTO security_limits(key,window_until,count) VALUES(?,?,1)').run(`attack:preexisting-${i}`, until);
    f.db.connection.exec('COMMIT');
    f.service.updateSettings(mailConfig);
    for (let i = 0; i < 20; i++) f.service.record({ type: 'login_blocked', source: `198.51.100.${i}` });
    assert.equal(f.db.connection.prepare("SELECT COUNT(*) AS n FROM security_limits WHERE key LIKE 'attack:%'").get()!.n, SECURITY_MAX_ATTACK_SOURCES);
    assert.equal(f.service.recentEvents().length, 0);
    await f.service.flush();
    // Filling the attack budget must not deny an administrator's manual test.
    await f.service.sendTest();
    assert.equal(f.messages.length, 1);
    f.advance(15 * 60_000 + 1);
    f.service.record({ type: 'login_blocked', source: '198.51.100.1' });
    await f.service.flush();
    assert.equal(f.messages.length, 2);
    assert.equal(f.db.connection.prepare("SELECT COUNT(*) AS n FROM security_limits WHERE key LIKE 'attack:%'").get()!.n, 1);
  } finally { await f.close(); }
});

test('an interrupted manual test becomes failed after restart and is not replayed', async () => {
  const f = await fixture();
  let restarted: SecurityService | undefined;
  try {
    f.service.updateSettings(mailConfig);
    await f.service.close();
    f.db.connection.prepare("INSERT INTO security_events(id,type,username,source,created_at,detail,new_source,status) VALUES('interrupted-test','test','','',?,'test',0,'pending')").run(Date.now());
    let sends = 0;
    restarted = new SecurityService(f.db, { transportFactory: () => ({ sendMail: async () => { sends++; } }) });
    await restarted.flush();
    const event = restarted.recentEvents().find(event => event.id === 'interrupted-test')!;
    assert.equal(event.status, 'failed');
    assert.match(event.error!, /重启中断/);
    assert.equal(sends, 0);
  } finally { await restarted?.close(); await f.close(); }
});

test('transient SMTP failure retries once and exposes only a sanitized error', async () => {
  let calls = 0;
  const f = await fixture({ transportFactory: () => ({ sendMail: async () => {
    calls++;
    throw Object.assign(new Error(`secret=${mailConfig.password}; recipient=private@example.com`), { code: 'ESOCKET' });
  } }) });
  try {
    f.service.updateSettings(mailConfig);
    assert.doesNotThrow(() => f.service.record({ type: 'login_success', userId: 1, source: '203.0.113.5' }));
    await f.service.flush();
    assert.equal(calls, 1);
    assert.equal(f.service.recentEvents()[0].status, 'pending');
    f.advance(60_000);
    await f.service.flush();
    assert.equal(calls, 2);
    assert.equal(f.service.recentEvents()[0].status, 'failed');
    f.advance(60_000);
    await f.service.flush();
    assert.equal(calls, 2);
    assert.ok(!JSON.stringify(f.service.recentEvents()).includes(mailConfig.password));
    assert.ok(!JSON.stringify(f.service.recentEvents()).includes('private@example.com'));
  } finally { await f.close(); }
});

test('permanent authentication failure does not retry and does not affect event producer', async () => {
  let calls = 0;
  const f = await fixture({ transportFactory: () => ({ sendMail: async () => { calls++; throw Object.assign(new Error('bad secret'), { code: 'EAUTH' }); } }) });
  try {
    f.service.updateSettings(mailConfig);
    assert.doesNotThrow(() => f.service.record({ type: 'login_blocked', source: '203.0.113.5' }));
    await f.service.flush();
    f.advance(60_000); await f.service.flush();
    assert.equal(calls, 1);
    assert.equal(f.service.recentEvents()[0].status, 'failed');
    assert.match(f.service.recentEvents()[0].error!, /邮箱认证失败/);
  } finally { await f.close(); }
});

test('disabling mail cancels pending retries', async () => {
  let calls = 0;
  const f = await fixture({ transportFactory: () => ({ sendMail: async () => { calls++; throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); } }) });
  try {
    f.service.updateSettings(mailConfig);
    f.service.record({ type: 'login_success', userId: 1, source: '203.0.113.5' });
    await f.service.flush();
    f.service.updateSettings({ enabled: false });
    f.advance(60_000); await f.service.flush();
    assert.equal(calls, 1);
    assert.equal(f.service.recentEvents()[0].status, 'disabled');
  } finally { await f.close(); }
});

test('manual test uses saved recipients and a persistent one-minute rate limit', async () => {
  const f = await fixture();
  let restarted: SecurityService | undefined;
  try {
    f.service.updateSettings({ ...mailConfig, enabled: false });
    await f.service.flush();
    assert.equal((await f.service.sendTest()).ok, true);
    assert.deepEqual(f.messages[0].to, mailConfig.to);
    assert.ok(f.messages[0].subject.includes('测试'));
    await assert.rejects(f.service.sendTest(), /每分钟/);
    await f.service.close();
    restarted = new SecurityService(f.db, { clock: () => Date.UTC(2026, 9, 9), transportFactory: () => ({ sendMail: async () => { throw new Error('must not send'); } }) });
    await assert.rejects(restarted.sendTest(), /每分钟/);
  } finally { await restarted?.close(); await f.close(); }
});

test('security history is bounded and old source history expires', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 1050; i++) f.service.record({ type: 'account_changed', source: '127.0.0.1' });
    f.service.recentEvents();
    assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM security_events').get()!.n, 1000);
    for (let i = 0; i < 280; i++) f.service.record({ type: 'login_success', userId: 1, source: `2001:db8:${i.toString(16)}::1` });
    assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM security_sources WHERE user_id=1').get()!.n, 256);
    f.advance(181 * 24 * 60 * 60_000);
    assert.deepEqual(f.service.recentEvents(), []);
    assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM security_sources').get()!.n, 0);
  } finally { await f.close(); }
});

test('idle queue maintenance expires records and removes deleted-account source history', async () => {
  const f = await fixture();
  try {
    f.service.record({ type: 'login_success', userId: 1, source: '203.0.113.1' });
    f.service.record({ type: 'login_success', userId: 2, source: '203.0.113.2' });
    // Simulate upgrading a database containing source records left by deleted accounts.
    f.db.connection.exec('CREATE TABLE auth_users (id INTEGER PRIMARY KEY); INSERT INTO auth_users VALUES(1)');
    f.advance(60_000);
    await f.service.flush();
    assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM security_sources').get()!.n, 1);
    assert.equal(f.db.connection.prepare('SELECT user_id FROM security_sources').get()!.user_id, 1);
    f.advance(181 * 24 * 60 * 60_000);
    await f.service.flush();
    assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM security_sources').get()!.n, 0);
    assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM security_events').get()!.n, 0);
  } finally { await f.close(); }
});

test('mail tests keep history bounded without opening the event history or receiving logins', async () => {
  const f = await fixture();
  try {
    f.service.updateSettings({ ...mailConfig, enabled: false });
    const insert = f.db.connection.prepare("INSERT INTO security_events(id,type,username,source,created_at,detail,status) VALUES(?,'test','','',?,'test','sent')");
    for (let i = 0; i < 1000; i++) insert.run(`old-test-${i}`, Date.UTC(2026, 9, 9));
    await f.service.flush();
    await f.service.sendTest();
    assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM security_events').get()!.n, 1000);
    f.advance(60_000);
    await f.service.sendTest();
    assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM security_events').get()!.n, 1000);
  } finally { await f.close(); }
});

test('concurrent flushes share one delivery and closing cancels a stuck automatic transport', async () => {
  let sends = 0, closes = 0;
  const f = await fixture({ transportFactory: () => ({
    sendMail: () => { sends++; return new Promise(() => {}); }, close: () => { closes++; },
  }) });
  try {
    f.service.updateSettings(mailConfig);
    f.service.record({ type: 'login_success', userId: 1, source: '203.0.113.1' });
    const work = f.service.flush();
    assert.equal(f.service.flush(), work);
    assert.equal(sends, 1);
    await f.service.close();
    await work;
    assert.ok(closes > 0);
    assert.equal(sends, 1);
    await f.service.flush();
    assert.equal(sends, 1);
  } finally { await f.close(); }
});

test('closing cancels and awaits a stuck manual test before storage is closed', async () => {
  let closes = 0;
  const f = await fixture({ transportFactory: () => ({
    sendMail: () => new Promise(() => {}), close: () => { closes++; },
  }) });
  try {
    f.service.updateSettings(mailConfig);
    await f.service.flush();
    const outcome = assert.rejects(f.service.sendTest(), error => error instanceof ApiError && error.status === 503);
    await f.service.close();
    await outcome;
    assert.ok(closes > 0);
  } finally { await f.close(); }
});

test('security routes enforce administrator middleware and never accept test recipient overrides', async () => {
  const f = await fixture();
  const app = express();
  app.use(express.json());
  registerSecurityRoutes(app, f.service, (req, res, next) => {
    if (req.get('x-test-role') !== 'admin') { res.status(req.get('x-test-role') ? 403 : 401).json({ error: 'forbidden' }); return; }
    next();
  });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof ApiError ? error.status : 500).json({ error: error instanceof Error ? error.message : 'error' });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const [method, path] of [['GET', 'settings'], ['PATCH', 'settings'], ['GET', 'events'], ['POST', 'test']]) {
      assert.equal((await fetch(`${base}/api/admin/security/${path}`, { method })).status, 401);
      assert.equal((await fetch(`${base}/api/admin/security/${path}`, { method, headers: { 'x-test-role': 'viewer' } })).status, 403);
    }
    const save = await fetch(`${base}/api/admin/security/settings`, { method: 'PATCH', headers: { 'x-test-role': 'admin', 'content-type': 'application/json' }, body: JSON.stringify(mailConfig) });
    assert.equal(save.status, 200);
    assert.ok(!(await save.text()).includes(mailConfig.password));
    await f.service.flush();
    const response = await fetch(`${base}/api/admin/security/test`, { method: 'POST', headers: { 'x-test-role': 'admin', 'content-type': 'application/json' }, body: JSON.stringify({ to: ['attacker@example.com'], password: 'override' }) });
    assert.equal(response.status, 200);
    assert.deepEqual(f.messages[0].to, mailConfig.to);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
});
