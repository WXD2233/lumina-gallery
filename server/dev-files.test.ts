import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, normalizePath } from 'vite';
import { assertPrivateDataDirectory, getPrivateDevFs } from './dev-files.ts';

test('development Vite cannot serve private data through root paths, @fs, raw/url or Windows case variants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lumina-dev-private-'));
  const data = join(root, 'private[gallery]');
  const standard = join(root, 'data');
  await Promise.all([mkdir(data), mkdir(standard), mkdir(join(root, 'server')), mkdir(join(root, 'scripts'))]);
  const marker = 'PRIVATE_GALLERY_DATA_MUST_NOT_BE_SERVED';
  await Promise.all([
    writeFile(join(root, 'index.html'), '<html><body>Public login shell</body></html>'),
    writeFile(join(data, 'credentials.txt'), marker),
    writeFile(join(standard, 'gallery.db'), marker),
    writeFile(join(root, 'server', 'test-auth.ts'), marker),
    writeFile(join(root, 'scripts', 'setup-admin.mjs'), marker),
    writeFile(join(root, 'example.test.ts'), marker),
  ]);
  const vite = await createServer({
    root, configFile: false, publicDir: false, logLevel: 'silent', cacheDir: join(root, '.vite'),
    server: { middlewareMode: true, hmr: false, fs: await getPrivateDevFs(data) },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'spa',
  });
  const app = express(); app.use(vite.middlewares);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.match(await (await fetch(base)).text(), /Public login shell/);
    const paths = [
      '/data/gallery.db',
      '/server/test-auth.ts', '/scripts/setup-admin.mjs', '/example.test.ts',
      `/@fs/${normalizePath(join(root, 'server', 'test-auth.ts'))}`,
      '/private%5Bgallery%5D/credentials.txt',
      `/@fs/${normalizePath(join(data, 'credentials.txt'))}`,
      ...(process.platform === 'win32' ? [`/@fs/${normalizePath(join(data, 'credentials.txt')).toUpperCase()}`] : []),
    ];
    for (const path of paths) for (const suffix of ['', '?raw', '?url']) {
      const response = await fetch(`${base}${path}${suffix}`);
      const body = await response.text();
      assert(!body.includes(marker), `Private bytes exposed by ${path}${suffix}`);
      // Unrecognized Windows @fs spellings may resolve to the public SPA shell.
      assert([403, 404].includes(response.status) || (response.status === 200 && body.includes('Public login shell')), `Expected denied ${path}${suffix}, got ${response.status}`);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await vite.close(); await rm(root, { recursive: true, force: true });
  }
});

test('data directory cannot reside in static assets, including not-yet-created and symlinked directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lumina-data-location-'));
  try {
    await mkdir(join(root, 'public')); await mkdir(join(root, 'dist'));
    await assert.doesNotReject(assertPrivateDataDirectory(join(root, 'data'), root));
    for (const folder of ['public', 'dist']) {
      await assert.rejects(assertPrivateDataDirectory(join(root, folder), root), /DATA_DIR/);
      await assert.rejects(assertPrivateDataDirectory(join(root, folder, 'not-created', 'gallery'), root), /DATA_DIR/);
    }
    if (process.platform === 'win32') await assert.rejects(assertPrivateDataDirectory(join(root, 'PUBLIC', 'gallery'), root), /DATA_DIR/);
    await symlink(join(root, 'public'), join(root, 'private-alias'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(assertPrivateDataDirectory(join(root, 'private-alias', 'not-created'), root), /DATA_DIR/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
