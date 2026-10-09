import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';
import type { AutoBackupEntry } from '../shared/auto-backup.ts';
import { isSafeWebDavAddress, testWebDavConnection, uploadAutomaticBackupToWebDav, type WebDavRequest, type WebDavResponse } from './webdav.ts';

const credentials = { url: 'https://dav.example.com/dav/backups', username: 'gallery', password: 'test-password' };
const id = 'a1234567-b123-c123-d123-e12345678901';

test('WebDAV accepts only public addresses and tests a pinned HTTPS collection', async () => {
  assert.equal(isSafeWebDavAddress('127.0.0.1'), false);
  assert.equal(isSafeWebDavAddress('8.8.8.8'), true);
  let requested: WebDavRequest | undefined;
  await testWebDavConnection(credentials, {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: async input => { requested = input; return { status: 207, body: Buffer.from('<d:multistatus><d:response><d:href>/dav/backups/</d:href></d:response></d:multistatus>') }; },
  });
  assert.equal(requested?.method, 'PROPFIND');
  assert.equal(requested?.target.address, '8.8.8.8');
  assert.equal(requested?.target.url.protocol, 'https:');
  assert.match(requested?.headers.Authorization ?? '', /^Basic /);
  assert.equal(requested?.headers.Depth, '0');
  let called = false;
  await assert.rejects(testWebDavConnection({ ...credentials, url: 'https://127.0.0.1/dav' }, {
    request: async () => { called = true; return { status: 207, body: Buffer.alloc(0) }; },
  }));
  assert.equal(called, false);
});

test('WebDAV streams each backup and trims only its own remote ZIP files to the retention limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-webdav-'));
  try {
    const backupDirectory = join(directory, `backup-${id}`); await mkdir(backupDirectory);
    const path = join(backupDirectory, '完整备份.zip'); await writeFile(path, Buffer.from('archive-content'));
    const entry: AutoBackupEntry & { path: string } = { id, filename: '完整备份.zip', path, createdAt: '2026-10-09T00:00:00.000Z', size: 15, downloadUrl: '' };
    const dateName = (day: number, backupId: string) => `lumina-gallery-auto-2026100${day}T000000Z-${backupId}.zip`;
    const existingIds = [
      '00000001-0000-0000-0000-000000000001', '00000002-0000-0000-0000-000000000002',
      '00000003-0000-0000-0000-000000000003', '00000004-0000-0000-0000-000000000004',
      '00000005-0000-0000-0000-000000000005', '00000006-0000-0000-0000-000000000006',
      '00000007-0000-0000-0000-000000000007', '00000008-0000-0000-0000-000000000008',
    ];
    const names = existingIds.map((backupId, index) => dateName(index + 1, backupId));
    let received = Buffer.alloc(0); const deleted: string[] = []; const methods: string[] = [];
    const request = async (input: WebDavRequest): Promise<WebDavResponse> => {
      methods.push(input.method);
      if (input.method === 'PUT') {
        for await (const chunk of input.body ?? Readable.from([])) received = Buffer.concat([received, Buffer.from(chunk)]);
        names.push(decodeURIComponent(input.target.url.pathname.split('/').at(-1)!));
        return { status: 201, body: Buffer.alloc(0) };
      }
      if (input.method === 'PROPFIND') {
        const hrefs = `<d:response><d:href>/dav/backups/</d:href></d:response>` + [...names, 'private-notes.zip', 'profile.jpg'].map(name => `<d:response><d:href>/dav/backups/${name}</d:href></d:response>`).join('');
        return { status: 207, body: Buffer.from(`<d:multistatus>${hrefs}</d:multistatus>`) };
      }
      if (input.method === 'DELETE') { deleted.push(decodeURIComponent(input.target.url.pathname.split('/').at(-1)!)); return { status: 204, body: Buffer.alloc(0) }; }
      return { status: 405, body: Buffer.alloc(0) };
    };
    await uploadAutomaticBackupToWebDav(credentials, entry, 7, { lookup: async () => [{ address: '8.8.8.8', family: 4 }], request });
    assert.equal(received.toString(), 'archive-content');
    assert.deepEqual(methods, ['PUT', 'PROPFIND', 'DELETE', 'DELETE']);
    assert.deepEqual(deleted, [dateName(2, existingIds[1]!), dateName(1, existingIds[0]!)]);
    assert(deleted.every(name => /^lumina-gallery-auto-/.test(name)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('WebDAV rejects unsafe URL and file metadata before sending credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-webdav-'));
  try {
    const path = join(directory, 'wrong.zip'); await writeFile(path, 'data');
    let called = false;
    const entry: AutoBackupEntry & { path: string } = { id, filename: '完整备份.zip', path, createdAt: '2026-10-09T00:00:00.000Z', size: 4, downloadUrl: '' };
    await assert.rejects(uploadAutomaticBackupToWebDav({ ...credentials, url: 'http://dav.example.com/backups' }, entry, 7, {
      request: async () => { called = true; return { status: 200, body: Buffer.alloc(0) }; },
    }));
    assert.equal(called, false);
    await assert.rejects(uploadAutomaticBackupToWebDav(credentials, entry, 7, { lookup: async () => [{ address: '8.8.8.8', family: 4 }], request: async () => {
      called = true; return { status: 200, body: Buffer.alloc(0) };
    } }));
    assert.equal(called, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
