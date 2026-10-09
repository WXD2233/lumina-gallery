export const MAX_IMAGE_SOURCES = 100;
const MAX_INPUT_CHARACTERS = 256 * 1024;

/** Parse pasted image addresses without treating BBCode or HTML as executable content. */
export function parseImageSources(input: unknown): string[] {
  if (input === undefined || input === null || input === '') return [];
  if (typeof input !== 'string') throw new Error('图片链接需要是文本，请粘贴图片网址或 [img]图片网址[/img]。');
  if (input.length > MAX_INPUT_CHARACTERS) throw new Error('图片链接文本过长，请分批导入。');
  if (!input.trim()) return [];

  const sources: string[] = [];
  const seen = new Set<string>();
  const appendUrl = (candidate: string) => {
    const value = candidate.trim();
    if (!value) throw new Error('[img] 标签内没有图片链接。');
    if (/\[\s*\/?\s*img\b/i.test(value)) throw new Error('图片标签格式不正确，请使用 [img]图片网址[/img]。');
    const authority = /^https?:\/\/([^/?#]+)/i.exec(value)?.[1];
    if (!authority) throw new Error('图片链接必须是完整的 http:// 或 https:// 地址。');
    if (/[\s\u0000-\u001f\u007f]/u.test(value) || value.includes('\\')) {
      throw new Error('图片链接中不能包含空格、换行或反斜杠；多个普通链接请每行填写一个。');
    }
    let url: URL;
    try { url = new URL(value); }
    catch { throw new Error('图片链接格式不正确，请检查网址是否完整。'); }
    if (!url.hostname || !['http:', 'https:'].includes(url.protocol)) throw new Error('图片链接必须是完整的 http:// 或 https:// 地址。');
    if (url.username || url.password || authority.includes('@')) throw new Error('图片链接不能包含用户名或密码，请使用可直接访问的图片网址。');
    if (seen.has(url.href)) return;
    if (sources.length >= MAX_IMAGE_SOURCES) throw new Error(`一次最多导入 ${MAX_IMAGE_SOURCES} 个图片链接，请分批导入。`);
    seen.add(url.href);
    sources.push(url.href);
  };
  const appendPlainLines = (text: string) => {
    for (const line of text.split(/\r\n|\r|\n/)) if (line.trim()) appendUrl(line);
  };

  // A token walk keeps mixed plain URLs and BBCode in their original order,
  // and rejects incomplete or nested image tags instead of losing them silently.
  const tags = /\[\s*(\/?)\s*(img|url)\s*(?:=([^\]\r\n]*))?\]/gi;
  let cursor = 0;
  let imageStart: number | undefined;
  let wrapperDepth = 0;
  for (const match of input.matchAll(tags)) {
    const closing = match[1] === '/';
    const name = match[2].toLowerCase();
    const attribute = match[3];
    if (imageStart !== undefined) {
      if (name !== 'img' || !closing || attribute !== undefined) {
        throw new Error('图片标签不能嵌套，请使用 [img]图片网址[/img]。');
      }
      appendUrl(input.slice(imageStart, match.index));
      imageStart = undefined;
    } else {
      appendPlainLines(input.slice(cursor, match.index));
      if (name === 'img') {
        if (attribute !== undefined) throw new Error('图片标签格式不正确，请使用 [img]图片网址[/img]。');
        if (closing) throw new Error('图片标签缺少开头的 [img]。');
        imageStart = match.index + match[0].length;
      } else {
        if (closing) {
          if (attribute !== undefined || wrapperDepth === 0) throw new Error('外层链接标签格式不正确，请检查 [url] 和 [/url] 是否配对。');
          wrapperDepth--;
        } else {
          wrapperDepth++;
        }
      }
    }
    cursor = match.index + match[0].length;
  }
  if (imageStart !== undefined) throw new Error('图片标签缺少结尾的 [/img]。');
  appendPlainLines(input.slice(cursor));
  if (wrapperDepth !== 0) throw new Error('外层链接标签缺少结尾的 [/url]。');
  return sources;
}
