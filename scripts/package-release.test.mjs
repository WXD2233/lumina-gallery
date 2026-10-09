import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REQUIRED_FILES, assertVersion, listReleaseFiles, packageRelease, writeChecksums } from './package-release.mjs';

async function fixture(context) {
  const base = await mkdtemp(join(tmpdir(), 'lumina-package-test-'));
  context.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'source'), output = join(base, 'output');
  async function put(relative, data = 'fixture\n') {
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }
  for (const name of REQUIRED_FILES) await put(name);
  await put('package.json', JSON.stringify({ name: 'lumina-gallery', version: '1.0.0' }));
  for (const name of ['mountains.jpg', 'lake.jpg', 'forest.jpg', 'desert.jpg', 'coast.jpg', 'city.jpg', 'credits.txt']) await put(`public/demo/${name}`);
  for (const name of ['src/main.tsx', 'server/index.ts', 'shared/types.ts', '.github/workflows/release.yml']) await put(name);
  return { base, root, output, put };
}

test('packaging allowlist excludes live data, keys, environment, screenshots, dependencies, and unrelated scripts', async context => {
  const { root, put } = await fixture(context);
  const excluded = ['data/gallery.db', 'data/security-mail.key', '.env', '.env.production', '.tools/token.txt', 'screenshots/gallery.jpg', 'node_modules/secret.js', 'src/.env', 'src/private.key', 'scripts/personal.mjs', 'public/personal.jpg', 'public/demo/extra.jpg'];
  for (const path of excluded) await put(path, 'SENSITIVE-FIXTURE-MUST-NOT-BE-PACKAGED');
  const files = await listReleaseFiles(root);
  for (const path of excluded) assert(!files.includes(path), path);
  assert(files.includes('deploy/Caddyfile'));
  assert(files.includes('scripts/lumina.sh'));
});

test('archive has one versioned prefix, executable installer, exact files, and matching checksum', async context => {
  const { root, output, base } = await fixture(context);
  const result = await packageRelease({ rootDirectory: root, outputDirectory: output, version: '1.0.0' });
  const list = spawnSync('tar', ['-tzf', result.archive], { encoding: 'utf8', windowsHide: true });
  assert.equal(list.status, 0, list.stderr);
  const entries = list.stdout.trim().split(/\r?\n/);
  assert(entries.every(name => name.startsWith('lumina-gallery-1.0.0/')));
  assert(!entries.some(name => name.includes('/../') || name.startsWith('/')));
  const archivedFiles = entries.filter(name => !name.endsWith('/')).map(name => name.slice('lumina-gallery-1.0.0/'.length)).sort();
  assert.deepEqual(archivedFiles, result.files);
  const bytes = await readFile(result.archive);
  const hash = createHash('sha256').update(bytes).digest('hex');
  assert.equal(await readFile(join(output, 'SHA256SUMS'), 'utf8'), `${hash}  lumina-gallery-1.0.0-source.tar.gz\n`);
  const verbose = spawnSync('tar', ['-tvzf', result.archive], { encoding: 'utf8', windowsHide: true });
  assert.equal(verbose.status, 0, verbose.stderr);
  assert.match(verbose.stdout, /-rwxr-xr-x[^\n]*lumina-gallery-1\.0\.0\/scripts\/lumina\.sh/);
  // Staging data does not escape into the source or output directories.
  assert(!entries.some(name => name.includes(base)));
});

test('packager rejects a mismatched version and CRLF installers before generating an archive', async context => {
  const { root, output, put } = await fixture(context);
  await assert.rejects(packageRelease({ rootDirectory: root, outputDirectory: output, version: '1.0.1' }), /match package.json/);
  await put('scripts/lumina.sh', '#!/usr/bin/env bash\r\n');
  await assert.rejects(packageRelease({ rootDirectory: root, outputDirectory: output, version: '1.0.0' }), /LF line endings/);
  for (const version of ['v1.0.0', '../1.0.0', '1.0.0;echo unsafe', '', '1.0']) assert.throws(() => assertVersion(version));
});

test('checksums include only approved image assets and refuse symlinked assets', async context => {
  const { root, output } = await fixture(context);
  await packageRelease({ rootDirectory: root, outputDirectory: output, version: '1.0.0' });
  await writeFile(join(output, 'lumina-gallery-1.0.0-linux-amd64.tar.gz'), 'fake image archive');
  await writeFile(join(output, 'unrelated-secret.txt'), 'do not publish');
  const lines = await writeChecksums(output, '1.0.0');
  assert.equal(lines.length, 2);
  assert(!lines.some(line => line.includes('unrelated-secret')));
  if (process.platform !== 'win32') {
    await symlink(join(output, 'unrelated-secret.txt'), join(output, 'lumina-gallery-1.0.0-linux-arm64.tar.gz'));
    await assert.rejects(writeChecksums(output, '1.0.0'), /regular files/);
  }
});

test('source symlinks cannot include files outside the release allowlist', { skip: process.platform === 'win32' }, async context => {
  const { root, base } = await fixture(context);
  const secret = join(base, 'private.ts');
  await writeFile(secret, 'private token');
  await symlink(secret, join(root, 'src', 'linked.ts'));
  await assert.rejects(listReleaseFiles(root), /symbolic links/);
});
