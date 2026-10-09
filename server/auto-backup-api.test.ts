import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import { createApp, type AppOptions } from './index.ts';
import type { AutoBackupStatus } from '../shared/auto-backup.ts';

async function fixture(options: Omit<AppOptions, 'dataDir'> = {}) {
  const prefix = join(tmpdir(), 'lumina-autobackup-api-');
  const directory = await mkdtemp(prefix);
  const runtime = await createApp({ ...options, dataDir: directory });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = '';
  const request = (path: string, method = 'GET', body?: unknown) => fetch(`${base}/api${path}`, {
    method, headers: { Cookie: cookie, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: 'error',
  });
  assert.equal((await request('/admin/auto-backups')).status, 401);
  const setup = await request('/auth/setup', 'POST', { username: 'backup-admin', password: 'violet leaves across the meadow' });
  assert.equal(setup.status, 201); cookie = setup.headers.get('set-cookie')!.split(';')[0];
  return { runtime, directory, request, base, cookie, async close() {
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    await runtime.close();
    assert(resolve(directory).startsWith(resolve(prefix)));
    await rm(directory, { recursive: true, force: true });
  } };
}

test('admin automatic backup API persists schedule and produces authenticated import-compatible archives', async () => {
  const f = await fixture();
  try {
    let status = await (await f.request('/admin/auto-backups')).json() as AutoBackupStatus;
    assert.deepEqual(status.settings, { enabled: true, weekday: 0, time: '03:00', timeZone: 'Asia/Hong_Kong', retainCount: 7, lowSpaceGraceHours: 24 });
    assert.equal(status.backups.length, 0); assert.equal(status.emailReady, false);
    assert.equal((await f.request('/admin/auto-backups/settings', 'PATCH', { time: '25:00' })).status, 400);
    const changed = await f.request('/admin/auto-backups/settings', 'PATCH', { weekday: 2, time: '19:30' });
    assert.equal(changed.status, 200); status = await changed.json() as AutoBackupStatus;
    assert.equal(status.settings.weekday, 2); assert.equal(status.settings.time, '19:30');
    assert.equal((await f.request('/admin/auto-backups/run', 'POST', {})).status, 202);
    await f.runtime.autoBackup.flush();
    status = await (await f.request('/admin/auto-backups')).json() as AutoBackupStatus;
    assert.equal(status.phase, 'success', status.message); assert.equal(status.backups.length, 1);
    const path = status.backups[0].downloadUrl;
    assert.equal((await fetch(`${f.base}${path}`)).status, 401);
    const download = await fetch(`${f.base}${path}`, { headers: { Cookie: f.cookie } });
    assert.equal(download.status, 200); assert.match(download.headers.get('content-type')!, /zip/);
    const bytes = await download.arrayBuffer();
    assert.equal(bytes.byteLength, status.backups[0].size);
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    const manifest = await zip.file('manifest.json')!.async('string');
    assert(!manifest.includes('backup-admin')); assert(!manifest.includes('automaticBackup'));
    const form = new FormData(); form.append('file', new Blob([bytes], { type: 'application/zip' }), 'backup.zip');
    const preview = await fetch(`${f.base}/api/backup-imports`, { method: 'POST', headers: { Cookie: f.cookie }, body: form });
    assert.equal(preview.status, 201, await preview.clone().text());
    assert.equal((await f.request('/admin/auto-backups/unknown/download')).status, 404);
  } finally { await f.close(); }
});

test('low storage appears in admin status and security records without external SMTP', async () => {
  const f = await fixture({ autoBackupOptions: { diskFree: async () => 0 }, securityOptions: { transportFactory: () => ({ sendMail: async () => { assert.fail('disabled mail must not send'); } }) } });
  try {
    assert.equal((await f.request('/admin/auto-backups/run', 'POST', {})).status, 202);
    await f.runtime.autoBackup.flush();
    const status = await (await f.request('/admin/auto-backups')).json() as AutoBackupStatus;
    assert.equal(status.phase, 'waiting_space');
    assert.equal(Date.parse(status.cleanupAfter!) - Date.parse(status.warningAt!), 24 * 60 * 60 * 1000);
    assert.equal(status.emailReady, false);
    assert(status.requiredBytes! > status.freeBytes!);
    const event = f.runtime.security.recentEvents().find(event => event.type === 'backup_warning');
    assert(event); assert.equal(event.status, 'disabled'); assert.match(event.detail, /24 小时/);
    await f.runtime.autoBackup.runNow(); await f.runtime.autoBackup.flush();
    assert.equal(f.runtime.security.recentEvents().filter(event => event.type === 'backup_warning').length, 1);
  } finally { await f.close(); }
});

test('WebDAV settings are admin-only, never expose the password, and support an explicit connection test', async () => {
  let tests = 0;
  const f = await fixture({ autoBackupOptions: { testWebdav: async () => { tests++; } } });
  try {
    assert.equal((await fetch(`${f.base}/api/admin/auto-backups/webdav`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) })).status, 401);
    const saved = await f.request('/admin/auto-backups/webdav', 'PATCH', {
      enabled: true, url: 'https://dav.example.com/dav/gallery', username: 'gallery-user', password: 'private-webdav-password',
    });
    assert.equal(saved.status, 200);
    const status = await saved.json() as AutoBackupStatus;
    assert.deepEqual(status.webdav, { enabled: true, url: 'https://dav.example.com/dav/gallery/', username: 'gallery-user', hasPassword: true });
    assert(!JSON.stringify(status).includes('private-webdav-password'));
    const tested = await f.request('/admin/auto-backups/webdav/test', 'POST', {});
    assert.equal(tested.status, 200); assert.equal(tests, 1);
    assert.equal((await f.request('/admin/auto-backups/webdav/test', 'POST', {})).status, 200);
  } finally { await f.close(); }
});
