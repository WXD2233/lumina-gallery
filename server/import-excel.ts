import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Album, CloudLink, GalleryImage } from '../shared/types.ts';
import type { ImportedCandidate, ImportedFile, PreparedImport } from './backup-import.ts';
import { ApiError, isBaiduLink, normalizeCategoryName } from './db.ts';
import { assertDiskSpace } from './resource-limits.ts';

const HOUR = 60 * 60 * 1000;
const MAX_ROWS = 10_000;
const MAX_ALBUMS = 5_000;
const MAX_CATEGORIES = 512;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_IMAGES = 1_000;
const FORMAT_REMINDER = 'Excel 只包含表格内嵌的图片（本软件导出的 Excel 为封面缩略图），不能恢复其余原图、简介、标签、收藏和同步记录；网盘自动同步默认关闭。完整恢复请导入 ZIP 备份。';

function fail(location: string, message: string): never {
  throw new ApiError(400, `${location}：${message}`);
}

function text(cell: ExcelJS.Cell, location: string): string {
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) fail(location, '数字需要改为文本，避免精度丢失');
    // A numeric code with an explicit 0000 format still visibly contains its leading zeroes.
    return /^0{2,32}$/.test(cell.numFmt) && value >= 0 ? String(value).padStart(cell.numFmt.length, '0') : String(value);
  }
  if (typeof value === 'object' && 'richText' in value) return value.richText.map(part => part.text).join('');
  if (typeof value === 'object' && 'hyperlink' in value) return String(value.text ?? '');
  fail(location, '单元格需要是文字或整数，不能包含公式或错误值');
}

function limitedText(cell: ExcelJS.Cell, location: string, max: number): string {
  const value = text(cell, location).trim();
  if (value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(location, `内容格式不正确或超过 ${max} 个字符`);
  return value;
}

/** Excel dates in our backups are Hong Kong wall-clock values, not UTC instants. */
function parseTime(cell: ExcelJS.Cell, location: string, date1904: boolean): string | undefined {
  const value = cell.value;
  if (value === null || value === undefined || value === '') return undefined;
  let timestamp: number;
  if (value instanceof Date) timestamp = value.getTime() - 8 * HOUR;
  else if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value > 2_958_465) fail(location, 'Excel 日期无效');
    timestamp = Math.round((value - (date1904 ? 24_107 : 25_569)) * 24 * HOUR) - 8 * HOUR;
  } else {
    const source = text(cell, location).trim();
    if (!source) return undefined;
    const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(source);
    if (!match) fail(location, '时间请使用 YYYY-MM-DD HH:mm:ss 或带时区的 ISO 日期');
    const [, year, month, day, hour = '0', minute = '0', second = '0', fraction = '', zone] = match;
    const parts = [year, month, day, hour, minute, second].map(Number);
    const [y, m, d, h, min, sec] = parts;
    const naive = new Date(0);
    naive.setUTCFullYear(y, m - 1, d);
    naive.setUTCHours(h, min, sec, Number(fraction.padEnd(3, '0')));
    if (y < 1900 || y > 9999 || naive.getUTCFullYear() !== y || naive.getUTCMonth() !== m - 1 || naive.getUTCDate() !== d || naive.getUTCHours() !== h || naive.getUTCMinutes() !== min || naive.getUTCSeconds() !== sec) fail(location, '时间不是有效日期');
    let offset = 8 * HOUR;
    if (zone?.toUpperCase() === 'Z') offset = 0;
    else if (zone) {
      const zoneParts = /^([+-])(\d{2}):?(\d{2})$/.exec(zone)!;
      const hours = Number(zoneParts[2]); const minutes = Number(zoneParts[3]);
      if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) fail(location, '时间的时区无效');
      offset = (hours * 60 + minutes) * 60_000 * (zoneParts[1] === '+' ? 1 : -1);
    }
    timestamp = naive.getTime() - offset;
  }
  if (!Number.isFinite(timestamp) || timestamp < Date.UTC(1899, 11, 29) || timestamp > Date.UTC(9999, 11, 31, 23, 59, 59, 999)) fail(location, '时间超出支持范围');
  return new Date(timestamp).toISOString();
}

function urlText(cell: ExcelJS.Cell, location: string): string {
  const value = cell.value;
  const source = typeof value === 'object' && value !== null && 'hyperlink' in value ? value.hyperlink : text(cell, location);
  const url = String(source ?? '').trim();
  if (!url) return '';
  if (url.length > 2048) fail(location, '网盘链接过长');
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
  } catch { fail(location, '网盘链接必须为完整的 HTTP 或 HTTPS 地址'); }
  return url;
}

function validateCells(workbook: ExcelJS.Workbook): void {
  if (workbook.worksheets.length > MAX_CATEGORIES + 1) throw new ApiError(400, `Excel 最多支持 ${MAX_CATEGORIES} 个分类`);
  let rows = 0;
  for (const sheet of workbook.worksheets) {
    if (sheet.rowCount > MAX_ROWS + MAX_CATEGORIES + 20 || sheet.columnCount > 64) fail(sheet.name, '表格行数或列数超出导入限制');
    rows += sheet.actualRowCount;
    // Category headers and the explanation sheet's mapping rows are not data records.
    if (rows > MAX_ROWS + MAX_CATEGORIES * 2 + 20) throw new ApiError(400, `Excel 最多支持 ${MAX_ROWS} 行图集记录`);
    sheet.eachRow(row => row.eachCell(cell => {
      if (cell.type === ExcelJS.ValueType.Formula || (cell.value && typeof cell.value === 'object' && ('formula' in cell.value || 'sharedFormula' in cell.value))) fail(`${sheet.name}!${cell.address}`, '不支持公式，请先复制并粘贴为值后再导入');
      if (cell.type === ExcelJS.ValueType.Error) fail(`${sheet.name}!${cell.address}`, '含有 Excel 错误值，请修正后再导入');
    }));
  }
}

function parseNotes(workbook: ExcelJS.Workbook): { notes?: ExcelJS.Worksheet; names: Map<string, string>; exportedAt?: string } {
  const notes = workbook.worksheets.find(sheet => sheet.name === '说明' && sheet.getCell('A1').value === '项目' && sheet.getCell('B1').value === '说明');
  const names = new Map<string, string>();
  if (!notes) return { names };
  let mapping = false;
  let exportedAt: string | undefined;
  notes.eachRow((row, number) => {
    const first = text(row.getCell(1), `说明!A${number}`).trim();
    if (first === '导出时间' && !mapping) exportedAt = parseTime(row.getCell(2), `说明!B${number}`, Boolean(workbook.properties.date1904));
    if (first === '分类原名') { mapping = true; return; }
    if (!mapping || !first) return;
    const worksheetName = text(row.getCell(2), `说明!B${number}`).trim();
    // Export reminders follow the mapping. Only existing category sheet names are mappings.
    if (!workbook.getWorksheet(worksheetName) || worksheetName === notes.name) return;
    const category = normalizeCategoryName(first);
    if (names.has(worksheetName) && names.get(worksheetName) !== category) fail('说明', '同一工作表对应了多个分类名称');
    names.set(worksheetName, category);
  });
  return { notes, names, exportedAt };
}

interface Group { identity: string; title: string; time?: string; category: string; links: CloudLink[]; imageIds: Set<number>; firstRow: number; }

function embeddedBuffer(workbook: ExcelJS.Workbook, imageId: number, location: string): Buffer {
  const image = workbook.getImage(imageId);
  if (!image) fail(location, '图片引用不存在');
  let bytes: Buffer;
  if (image.buffer) bytes = Buffer.from(image.buffer);
  else if (image.base64 && /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i.test(image.base64)) bytes = Buffer.from(image.base64.slice(image.base64.indexOf(',') + 1), 'base64');
  else fail(location, '仅支持工作簿内嵌图片，不能导入外部图片引用');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) fail(location, '单张内嵌图片不能超过 25 MB');
  return bytes;
}

async function stageImage(bytes: Buffer, stageDir: string, title: string, location: string, maxBytes: number): Promise<{ image: GalleryImage; files: ImportedFile[]; bytes: number }> {
  let decoder: sharp.Sharp | undefined;
  try {
    decoder = sharp(bytes, { limitInputPixels: 100_000_000, animated: false, failOn: 'error' }).timeout({ seconds: 30 });
    const metadata = await decoder.metadata();
    const extensions: Record<string, string> = { jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif', avif: 'avif', heif: 'avif' };
    if (!metadata.format || !extensions[metadata.format] || !metadata.width || !metadata.height || (metadata.format === 'heif' && metadata.compression !== 'av1')) fail(location, '内嵌图片格式不支持');
    const thumb = await decoder.rotate().resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    if (bytes.length + thumb.length > maxBytes) throw new ApiError(413, '导入图片实际展开大小超过临时空间上限，请拆分备份');
    const id = randomUUID();
    const filename = `${id}.${extensions[metadata.format]}`;
    const thumbName = `${id}-thumb.jpg`;
    await writeFile(join(stageDir, filename), bytes, { flag: 'wx' });
    await writeFile(join(stageDir, thumbName), thumb, { flag: 'wx' });
    const rotated = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
    return {
      image: { id, url: `/uploads/${filename}`, thumbnailUrl: `/uploads/${thumbName}`, name: `${title.slice(0, 150)}-封面.${extensions[metadata.format]}`, width: rotated ? metadata.height : metadata.width, height: rotated ? metadata.width : metadata.height, size: bytes.length },
      files: [{ sourcePath: join(stageDir, filename), filename }, { sourcePath: join(stageDir, thumbName), filename: thumbName }],
      bytes: bytes.length + thumb.length,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return fail(location, '内嵌图片无法解码，请重新插入有效图片后再导入');
  } finally { decoder?.destroy(); }
}

/** The route must validate XLSX archive entry/expanded-size limits before calling ExcelJS. */
export async function parseExcelImport(path: string, stageDir: string, maxStagedBytes = 8 * 1024 ** 3, signal?: AbortSignal): Promise<PreparedImport> {
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.readFile(path); } catch { throw new ApiError(400, 'Excel 文件无法读取，请选择有效的 .xlsx 文件'); }
  validateCells(workbook);
  const { notes, names, exportedAt } = parseNotes(workbook);
  const warnings = new Set<string>([FORMAT_REMINDER]);
  const categories: string[] = [];
  const grouped: { sheet: ExcelJS.Worksheet; group: Group }[] = [];
  let recordCount = 0;
  for (const sheet of workbook.worksheets) {
    if (sheet === notes) continue;
    if (sheet.actualRowCount === 0) { warnings.add(`空白工作表「${sheet.name}」没有表头，已跳过。`); continue; }
    const headers = Array.from({ length: 7 }, (_, index) => text(sheet.getRow(1).getCell(index + 1), `${sheet.name}!${String.fromCharCode(65 + index)}1`).trim());
    if (!['序号', '1', ''].includes(headers[0]) || headers[1] !== '标题' || !['时间', '更新时间'].includes(headers[2]) || headers[3] !== '图片' || headers[4] !== '网盘链接' || headers[5] !== '提取码' || !['解压码', '解压密码'].includes(headers[6])) fail(sheet.name, '表头需为：序号、标题、时间、图片、网盘链接、提取码、解压码');
    const category = normalizeCategoryName(names.get(sheet.name) ?? sheet.name);
    if (categories.includes(category)) fail(sheet.name, `多个工作表映射到同一分类「${category}」`);
    categories.push(category);
    if (categories.length > MAX_CATEGORIES) throw new ApiError(400, `Excel 最多支持 ${MAX_CATEGORIES} 个分类`);
    const imagesByRow = new Map<number, number[]>();
    for (const image of sheet.getImages()) {
      const col = image.range.tl.nativeCol;
      const row = image.range.tl.nativeRow + 1;
      if (col !== 3 || row <= 1 || row > sheet.rowCount) { warnings.add(`工作表「${sheet.name}」存在未放在图片列的数据行内的图片，已跳过。`); continue; }
      imagesByRow.set(row, [...(imagesByRow.get(row) ?? []), Number(image.imageId)]);
    }
    const groups = new Map<string, Group>();
    sheet.eachRow((row, number) => {
      if (number === 1) return;
      const location = `${sheet.name} 第 ${number} 行`;
      const hasValue = Array.from({ length: 7 }, (_, index) => row.getCell(index + 1).value).some(value => value !== null && value !== undefined && value !== '');
      if (!hasValue && !imagesByRow.has(number)) return;
      if (++recordCount > MAX_ROWS) throw new ApiError(400, `Excel 最多支持 ${MAX_ROWS} 行图集记录`);
      const title = limitedText(row.getCell(2), `${location}标题`, 200);
      if (!title) fail(location, '图集标题不能为空');
      const sequence = limitedText(row.getCell(1), `${location}序号`, 100);
      const identity = sequence ? `sequence:${sequence}` : `row:${number}`;
      const time = parseTime(row.getCell(3), `${location}时间`, Boolean(workbook.properties.date1904));
      let group = groups.get(identity);
      if (!group) {
        group = { identity, title, time, category, links: [], imageIds: new Set(), firstRow: number };
        groups.set(identity, group);
      } else if (group.title !== title || group.time !== time) fail(location, '相同序号的标题或时间不一致，请使用不同序号或修正内容');
      const url = urlText(row.getCell(5), `${location}网盘链接`);
      const code = limitedText(row.getCell(6), `${location}提取码`, 32);
      const password = limitedText(row.getCell(7), `${location}解压码`, 200);
      if (!url && (code || password)) fail(location, '填写提取码或解压码时需要提供对应网盘链接');
      if (url) {
        if (group.links.length >= 20) fail(location, '同一图集最多支持 20 个网盘链接');
        group.links.push({ id: randomUUID(), label: isBaiduLink(url) ? '百度网盘' : '网盘链接', url, code, password, note: '', syncEnabled: false, status: 'disabled', message: '从 Excel 导入，未启用自动同步', lastCheckedAt: null, nextCheckAt: null, remoteUpdatedAt: null });
      }
      for (const imageId of imagesByRow.get(number) ?? []) group.imageIds.add(imageId);
      const pictureText = text(row.getCell(4), `${location}图片`).trim();
      if (pictureText && !['无图片', '封面缺失'].includes(pictureText)) warnings.add(`工作表「${sheet.name}」图片列中的文本或外部地址不会下载，只导入内嵌图片。`);
    });
    for (const group of groups.values()) {
      if (grouped.length >= MAX_ALBUMS) throw new ApiError(400, `Excel 最多支持 ${MAX_ALBUMS} 个图集`);
      grouped.push({ sheet, group });
    }
  }
  if (!categories.length) throw new ApiError(400, 'Excel 中没有可导入的分类表格');
  await mkdir(stageDir, { recursive: true });
  const albums: ImportedCandidate[] = [];
  let imagesCount = 0;
  let stagedBytes = 0;
  const fallbackTime = exportedAt ?? new Date().toISOString();
  for (const { sheet, group } of grouped) {
    signal?.throwIfAborted();
    const images: GalleryImage[] = [];
    const files: ImportedFile[] = [];
    const imageHashes = new Set<string>();
    for (const imageId of group.imageIds) {
      signal?.throwIfAborted();
      const location = `${sheet.name} 第 ${group.firstRow} 行图片`;
      const bytes = embeddedBuffer(workbook, imageId, location);
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (imageHashes.has(hash)) continue;
      imageHashes.add(hash);
      if (++imagesCount > MAX_IMAGES) throw new ApiError(400, `Excel 最多支持 ${MAX_IMAGES} 张内嵌图片`);
      // Repeated references in separate albums create separate files; do not count ZIP entries alone.
      const reserve = bytes.length + 2 * 1024 ** 2;
      if (stagedBytes + bytes.length > maxStagedBytes) throw new ApiError(413, '导入图片实际展开大小超过临时空间上限，请拆分备份');
      await assertDiskSpace(stageDir, reserve);
      const staged = await stageImage(bytes, stageDir, group.title, location, maxStagedBytes - stagedBytes);
      stagedBytes += staged.bytes;
      images.push(staged.image); files.push(...staged.files);
    }
    if (!images.length) warnings.add(`图集「${group.title}」没有可导入的内嵌图片，将仅导入文字和网盘资料。`);
    if (!group.time) warnings.add(`图集「${group.title}」未填写时间，使用${exportedAt ? '备份导出' : '本次导入'}时间。`);
    const id = `xlsx-${createHash('sha256').update(JSON.stringify({ category: group.category, identity: group.identity, title: group.title, time: group.time ?? null, links: group.links.map(({ url, code, password }) => ({ url, code, password })), images: [...imageHashes] })).digest('hex').slice(0, 40)}`;
    const timestamp = group.time ?? fallbackTime;
    const album: Album = { id, title: group.title, category: group.category, description: '', tags: [], favorite: false, createdAt: timestamp, updatedAt: timestamp, localUpdatedAt: timestamp, updateSource: 'local', links: group.links, images };
    albums.push({ key: id, album, files });
  }
  return { format: 'xlsx', exportedAt, albums, categories, warnings: [...warnings] };
}
