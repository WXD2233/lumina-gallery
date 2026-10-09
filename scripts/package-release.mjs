import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

export const REQUIRED_FILES = [
  'README.md', 'Dockerfile', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'tsconfig.json', 'vite.config.ts', 'index.html',
  'deploy/compose.yaml', 'deploy/Caddyfile', 'scripts/lumina.sh',
  'scripts/setup-admin.mjs', 'scripts/package-release.mjs', 'scripts/smoke-container.mjs',
];
const OPTIONAL_FILES = [
  '.gitignore', '.gitattributes', '.dockerignore', 'LICENSE', 'SECURITY.md', 'INSTALL.md', 'THIRD_PARTY_NOTICES.md',
  'compose.yaml', 'start.cmd', 'start.ps1', 'scripts/package-release.test.mjs',
  'scripts/seed-demo.mjs', 'scripts/lumina.test.sh',
];
const SOURCE_DIRECTORIES = { src: /\.(?:ts|tsx|css)$/, server: /\.ts$/, shared: /\.ts$/, '.github/workflows': /\.ya?ml$/ };
const DEMO_FILES = ['mountains.jpg', 'lake.jpg', 'forest.jpg', 'desert.jpg', 'coast.jpg', 'city.jpg', 'credits.txt'];
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

export function assertVersion(version) {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) throw new Error('Release version must be a plain semantic version, without a v prefix.');
  return version;
}

/** Explicit source allowlist. No workspace-wide copy, data, credentials, or build caches. */
export async function listReleaseFiles(rootDirectory) {
  const files = [];
  async function add(relative, required = true) {
    let info;
    try { info = await lstat(join(rootDirectory, relative)); }
    catch (error) { if (!required && error.code === 'ENOENT') return; throw error; }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Release inputs must be regular files: ${relative}`);
    files.push(relative);
  }
  for (const relative of REQUIRED_FILES) await add(relative);
  for (const relative of OPTIONAL_FILES) await add(relative, false);
  async function walk(relative, extensionPattern) {
    for (const entry of await readdir(join(rootDirectory, relative), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const nested = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Release inputs cannot be symbolic links: ${nested}`);
      if (entry.isDirectory()) await walk(nested, extensionPattern);
      else if (entry.isFile() && extensionPattern.test(entry.name)) await add(nested);
    }
  }
  for (const [relative, extensionPattern] of Object.entries(SOURCE_DIRECTORIES)) await walk(relative, extensionPattern);
  for (const name of DEMO_FILES) await add(`public/demo/${name}`);
  for (const requiredDirectory of ['src', 'server', 'shared']) {
    if (!files.some(relative => relative.startsWith(`${requiredDirectory}/`))) throw new Error(`No release source files in ${requiredDirectory}`);
  }
  return files.sort();
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function tarHeader(path, size, mode) {
  const header = Buffer.alloc(512);
  let name = path, prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const boundaries = [...path.matchAll(/\//g)].map(match => match.index).reverse();
    const boundary = boundaries.find(index => Buffer.byteLength(path.slice(0, index)) <= 155 && Buffer.byteLength(path.slice(index + 1)) <= 100);
    if (boundary === undefined) throw new Error(`Release archive path is too long: ${path}`);
    prefix = path.slice(0, boundary); name = path.slice(boundary + 1);
  }
  header.write(name, 0, 100, 'utf8');
  const octal = (value, offset, length) => {
    const text = value.toString(8);
    if (text.length > length - 1) throw new Error('Release file exceeds USTAR format bounds.');
    header.write(`${text.padStart(length - 1, '0')}\0`, offset, length, 'ascii');
  };
  octal(mode, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
  octal(size, 124, 12); octal(0, 136, 12);
  header.fill(0x20, 148, 156); // Checksum treats its own field as spaces.
  header[156] = 0x30;
  header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
  header.write('root', 265, 32, 'ascii'); header.write('root', 297, 32, 'ascii');
  header.write(prefix, 345, 155, 'utf8');
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

async function writeSourceArchive(archive, stage, prefix, files) {
  async function* records() {
    for (const relative of files) {
      const path = join(stage, prefix, relative);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Staged inputs must remain regular files: ${relative}`);
      yield tarHeader(`${prefix}/${relative}`, info.size, relative.endsWith('.sh') ? 0o755 : 0o644);
      let count = 0;
      for await (const chunk of createReadStream(path)) { count += chunk.length; yield chunk; }
      if (count !== info.size) throw new Error(`Release file changed during packaging: ${relative}`);
      const padding = (512 - info.size % 512) % 512;
      if (padding) yield Buffer.alloc(padding);
    }
    yield Buffer.alloc(1024);
  }
  // Explicit USTAR permissions and zero timestamps work consistently on Windows and Linux.
  await pipeline(Readable.from(records()), createGzip({ level: 9 }), createWriteStream(archive, { mode: 0o644 }));
}

export async function writeChecksums(outputDirectory, version) {
  assertVersion(version);
  const names = [
    `lumina-gallery-${version}-source.tar.gz`,
    `lumina-gallery-${version}-linux-amd64.tar.gz`,
    `lumina-gallery-${version}-linux-arm64.tar.gz`,
  ];
  const lines = [];
  for (const name of names) {
    let info;
    try { info = await lstat(join(outputDirectory, name)); }
    catch (error) { if (error.code === 'ENOENT' && !name.endsWith('-source.tar.gz')) continue; throw error; }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Release assets must be regular files: ${name}`);
    lines.push(`${await sha256(join(outputDirectory, name))}  ${name}`);
  }
  await writeFile(join(outputDirectory, 'SHA256SUMS'), `${lines.join('\n')}\n`, { mode: 0o644 });
  return lines;
}

export async function packageRelease({ rootDirectory, outputDirectory, version }) {
  assertVersion(version);
  rootDirectory = resolve(rootDirectory);
  outputDirectory = resolve(outputDirectory);
  const manifest = JSON.parse(await readFile(join(rootDirectory, 'package.json'), 'utf8'));
  if (manifest.name !== 'lumina-gallery' || manifest.version !== version) throw new Error('The requested release must match package.json name and version.');
  const files = await listReleaseFiles(rootDirectory);
  const prefix = `lumina-gallery-${version}`;
  const stage = await mkdtemp(join(tmpdir(), 'lumina-release-'));
  const archive = join(outputDirectory, `${prefix}-source.tar.gz`);
  try {
    for (const relative of files) {
      const input = join(rootDirectory, relative);
      const destination = join(stage, prefix, relative);
      // LF is required for a directly executable installer on Linux.
      if (relative.endsWith('.sh') && (await readFile(input, 'utf8')).includes('\r')) throw new Error(`Shell scripts must use LF line endings: ${relative}`);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(input, destination);
      await chmod(destination, relative.endsWith('.sh') ? 0o755 : 0o644);
    }
    await mkdir(outputDirectory, { recursive: true });
    try {
      await writeSourceArchive(archive, stage, prefix, files);
    } catch (error) {
      await rm(archive, { force: true });
      throw error;
    }
    await writeChecksums(outputDirectory, version);
    return { archive, files, prefix };
  } finally {
    // Only remove the exact freshly allocated staging directory.
    await rm(stage, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const checksumsOnly = args[0] === '--checksums-only';
  if (checksumsOnly) args.shift();
  if (args.length > 2) throw new Error('Usage: node scripts/package-release.mjs [--checksums-only] [VERSION] [OUTPUT_DIRECTORY]');
  const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = JSON.parse(await readFile(join(rootDirectory, 'package.json'), 'utf8'));
  const version = args[0] || manifest.version;
  const outputDirectory = resolve(args[1] || join(rootDirectory, 'releases'));
  if (checksumsOnly) {
    await writeChecksums(outputDirectory, version);
    process.stdout.write(`Verified asset SHA256SUMS written to ${outputDirectory}\n`);
  } else {
    const result = await packageRelease({ rootDirectory, outputDirectory, version });
    process.stdout.write(`Packaged ${result.files.length} allowlisted files: ${result.archive}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
