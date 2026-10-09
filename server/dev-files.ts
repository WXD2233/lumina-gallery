import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { normalizePath } from 'vite';

async function canonicalTarget(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalTarget(parent), basename(path));
  }
}

/** Never let production/static public assets contain database or original images. */
export async function assertPrivateDataDirectory(dataDirectory: string, projectDirectory: string): Promise<void> {
  const actual = await canonicalTarget(resolve(dataDirectory));
  const folded = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
  const inside = (parent: string, target: string) => {
    const path = relative(folded(parent), folded(target));
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
  };
  for (const folder of ['public', 'dist']) {
    const exposed = resolve(projectDirectory, folder);
    if (inside(exposed, resolve(dataDirectory)) || inside(await canonicalTarget(exposed), actual)) {
      throw new Error(`DATA_DIR 不能放在 ${folder} 静态资源目录内，请使用项目 data 目录或独立的私有目录`);
    }
  }
}

/** Vite serves source files as well as assets; gallery data must never be source. */
export async function getPrivateDevFs(dataDirectory: string): Promise<{ strict: true; deny: string[] }> {
  const absolute = resolve(dataDirectory);
  const canonical = await realpath(absolute);
  const literalPattern = (path: string) => normalizePath(path).replace(/[?*\[\]{}()!+@]/g, '\\$&');
  const privateDirectories = [...new Set([absolute, canonical])].flatMap(path => {
    const literal = literalPattern(path).replace(/\/$/, '');
    return [literal, `${literal}/**`];
  });
  return {
    strict: true,
    deny: [
      '.env', '.env.*', '*.{crt,pem}', '**/.git/**',
      '**/server/**', '**/scripts/**', '**/*.test.*',
      '**/*.db', '**/*.db-*', '**/data/**', '**/uploads/**', '**/.tools/**',
      ...privateDirectories,
    ],
  };
}
