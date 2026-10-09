import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ApiError } from './db.ts';

export interface ArchiveLimits { maxEntries?: number; maxExpandedBytes?: number; maxEntryBytes?: number; }
export interface ValidatedArchive {
  entries: Map<string, Entry>;
  read(name: string, maxBytes: number): Promise<Buffer>;
  extract(name: string, destination: string, maxBytes: number): Promise<void>;
  verifyAll(signal?: AbortSignal): Promise<void>;
  close(): void;
}

// ZIP CRC is checked while streaming, including when only a selected entry is read.
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (0xedb88320 ^ (value >>> 1)) : value >>> 1;
  return value >>> 0;
});

function safeEntryName(name: string): boolean {
  if (!name || name.length > 1024 || /[\\:\u0000-\u001f\u007f]/.test(name) || name.startsWith('/')) return false;
  const parts = name.replace(/\/$/, '').split('/');
  return parts.every(part => Boolean(part) && part !== '.' && part !== '..' && !/[. ]$/.test(part));
}

export async function openValidatedArchive(path: string, limits: ArchiveLimits = {}): Promise<ValidatedArchive> {
  const maxEntries = limits.maxEntries ?? 50_000;
  const maxExpandedBytes = limits.maxExpandedBytes ?? 8 * 1024 ** 3;
  const maxEntryBytes = limits.maxEntryBytes ?? 2 * 1024 ** 3;
  let zip: ZipFile;
  try {
    zip = await new Promise<ZipFile>((resolve, reject) => yauzl.open(path, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error, value) => error || !value ? reject(error ?? new Error('ZIP')) : resolve(value)));
  } catch { throw new ApiError(400, '备份不是有效的 ZIP / Excel 文件'); }
  const entries = new Map<string, Entry>();
  const names = new Set<string>();
  let expanded = 0;
  let archiveError: Error | undefined;
  let closed = false;
  const onError = (error: Error) => { archiveError = error; };
  zip.on('error', onError);
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: unknown) => reject(error instanceof ApiError ? error : new ApiError(400, '压缩包结构损坏，无法导入'));
      zip.once('error', fail);
      zip.once('end', () => { zip.removeListener('error', fail); resolve(); });
      zip.on('entry', (entry: Entry) => {
        try {
          const name = entry.fileName;
          const normalized = name.replace(/\/$/, '').normalize('NFC').toLowerCase();
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (!safeEntryName(name) || names.has(normalized) || mode === 0xa000 || (mode && mode !== 0x8000 && mode !== 0x4000)) throw new ApiError(400, '压缩包包含重复、不安全的路径或特殊文件');
          if (entry.generalPurposeBitFlag & 1 || ![0, 8].includes(entry.compressionMethod)) throw new ApiError(400, '不支持加密或此压缩方式的备份');
          if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > maxEntryBytes || (name.endsWith('/') && entry.uncompressedSize !== 0)) throw new ApiError(400, '压缩包单个文件超过允许大小');
          expanded += entry.uncompressedSize;
          if (entries.size >= maxEntries || expanded > maxExpandedBytes) throw new ApiError(400, '压缩包文件数量或解压后大小超过限制');
          if (entry.uncompressedSize > 1024 * 1024 && entry.uncompressedSize > Math.max(1, entry.compressedSize) * 1000) throw new ApiError(400, '压缩包的压缩比例异常，请重新导出后导入');
          names.add(normalized);
          entries.set(name, entry);
          zip.readEntry();
        } catch (error) { fail(error); }
      });
      zip.readEntry();
    });
    for (const name of entries.keys()) {
      const parts = name.replace(/\/$/, '').split('/');
      for (let index = 1; index < parts.length; index++) {
        const parent = parts.slice(0, index).join('/');
        if (entries.has(parent)) throw new ApiError(400, '压缩包包含相互冲突的文件路径');
      }
    }
  } catch (error) { zip.close(); throw error; }

  async function source(name: string, maxBytes: number) {
    if (closed || archiveError) throw new ApiError(400, '压缩包已关闭或损坏');
    const entry = entries.get(name);
    if (!entry || name.endsWith('/')) throw new ApiError(400, `备份缺少文件：${name}`);
    if (entry.uncompressedSize > maxBytes) throw new ApiError(400, '备份中的文件超过允许大小');
    const input = await new Promise<NodeJS.ReadableStream>((resolve, reject) => zip.openReadStream(entry, (error, stream) => error || !stream ? reject(new ApiError(400, '无法读取压缩包文件')) : resolve(stream)));
    let length = 0;
    let crc = 0xffffffff;
    const check = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        length += chunk.length;
        if (length > maxBytes || length > entry.uncompressedSize) return callback(new ApiError(400, '解压文件大小超过声明范围'));
        for (const byte of chunk) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
        callback(null, chunk);
      },
      flush(callback) {
        if (length !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) return callback(new ApiError(400, '压缩包文件校验失败，请重新选择完整备份'));
        callback();
      },
    });
    return { input, check };
  }
  return {
    entries,
    async read(name, maxBytes) {
      const { input, check } = await source(name, maxBytes);
      const buffers: Buffer[] = [];
      const collect = new Transform({ transform(chunk: Buffer, _encoding, callback) { buffers.push(chunk); callback(); } });
      try { await pipeline(input, check, collect); } catch (error) { throw error instanceof ApiError ? error : new ApiError(400, '压缩包文件损坏，无法读取'); }
      return Buffer.concat(buffers);
    },
    async extract(name, destination, maxBytes) {
      const { input, check } = await source(name, maxBytes);
      const output = createWriteStream(destination, { flags: 'wx' });
      let created = false;
      output.once('open', () => { created = true; });
      try { await pipeline(input, check, output); }
      catch (error) { if (created) await unlink(destination).catch(() => undefined); throw error instanceof ApiError ? error : new ApiError(400, '压缩包文件损坏，无法解压'); }
    },
    async verifyAll(signal) {
      // ExcelJS expands archives in memory; first enforce actual decoded sizes and CRCs.
      for (const [name, entry] of entries) {
        signal?.throwIfAborted();
        if (name.endsWith('/')) continue;
        const { input, check } = await source(name, entry.uncompressedSize);
        const sink = new Transform({ transform(_chunk, _encoding, callback) { callback(); } });
        try { await pipeline(input, check, sink, { signal }); }
        catch (error) { throw error instanceof ApiError ? error : new ApiError(400, '压缩包文件损坏，无法读取'); }
      }
    },
    close() { if (!closed) { closed = true; zip.close(); } },
  };
}
