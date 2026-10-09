import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const processIdentity = randomUUID();

/** A second service must not sweep another process's active import/export directories. */
export function acquireInstanceLock(directory: string): () => void {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, '.runtime-lock');
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw new Error('数据目录的运行锁无效，请确认没有其他实例后检查 .runtime-lock');
    let previous: { pid?: number; processIdentity?: string };
    try { previous = JSON.parse(readFileSync(path, 'utf8')); }
    catch { throw new Error('数据目录正在启动或运行锁损坏，请稍后重试'); }
    if (!Number.isSafeInteger(previous.pid) || previous.pid! <= 0) throw new Error('数据目录运行锁无效');
    // A restarted container often assigns the same PID to its new Node process.
    if (previous.pid !== process.pid || previous.processIdentity === processIdentity) {
      try { process.kill(previous.pid!, 0); throw new Error('此数据目录已有图库实例运行，请使用现有服务'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    unlinkSync(path);
  }
  const token = randomUUID();
  const descriptor = openSync(path, 'wx', 0o600);
  try { writeFileSync(descriptor, JSON.stringify({ pid: process.pid, processIdentity, token })); }
  finally { closeSync(descriptor); }
  return () => {
    try { if (JSON.parse(readFileSync(path, 'utf8')).token === token) unlinkSync(path); } catch { /* A stale lock is verified on the next start. */ }
  };
}
