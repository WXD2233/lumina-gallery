import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_IMAGE_SOURCES, parseImageSources } from '../shared/image-sources.ts';

test('image source parser accepts empty input and rejects non-text values', () => {
  for (const empty of [undefined, null, '', ' \n\r\t ']) assert.deepEqual(parseImageSources(empty), []);
  for (const invalid of [1, true, {}, [], ['https://example.com/a.jpg']]) {
    assert.throws(() => parseImageSources(invalid), /文本/);
  }
});

test('image source parser keeps plain and BBCode images in order, ignores link wrappers, and deduplicates normalized addresses', () => {
  assert.deepEqual(parseImageSources(`
https://EXAMPLE.com:443/first.jpg
[IMG] https://example.com/second.jpg?size=full&token=abc [/iMg]
[url=https://example.com/post/42][img]https://example.com/third.jpg[/img][/url]
[ img ]\n https://example.com/第四张.jpg \n[/ img ]
[img]https://example.com/first.jpg[/img][img]http://example.com/fifth.jpg[/img]
https://example.com/last.webp
`), [
    'https://example.com/first.jpg',
    'https://example.com/second.jpg?size=full&token=abc',
    'https://example.com/third.jpg',
    'https://example.com/%E7%AC%AC%E5%9B%9B%E5%BC%A0.jpg',
    'http://example.com/fifth.jpg',
    'https://example.com/last.webp',
  ]);
});

test('image source parser supports line endings and image addresses without filename extensions', () => {
  assert.deepEqual(parseImageSources('https://example.com/image?id=1\r\nhttp://example.com/picture?id=2\rhttps://example.com/image?id=3'), [
    'https://example.com/image?id=1', 'http://example.com/picture?id=2', 'https://example.com/image?id=3',
  ]);
  assert.deepEqual(parseImageSources('[URL="https://example.com/page"][IMG]https://example.com/a.jpg[/IMG][/URL]'), ['https://example.com/a.jpg']);
});

test('image source parser rejects broken tags instead of returning partial images', () => {
  const malformed = [
    '[img]https://example.com/a.jpg',
    'https://example.com/a.jpg[/img]',
    '[img][/img]',
    '[img] \n [/img]',
    '[img=100x100]https://example.com/a.jpg[/img]',
    '[img][img]https://example.com/a.jpg[/img][/img]',
    '[img]https://example.com/a.jpg[/im]',
    'https://example.com/a.jpg[/img',
    '[img]https://example.com/a.jpg[/img]\n[img]bad-url[/img]',
    '[url=https://example.com/post][img]https://example.com/a.jpg[/img]',
    '[img]https://example.com/a.jpg[/img][/url]',
    '[url]https://example.com/a.jpg[/url=wrong]',
    '<img src="https://example.com/a.jpg">',
  ];
  for (const input of malformed) assert.throws(() => parseImageSources(input), Error, input);
});

test('image source parser rejects ambiguous URLs, credentials, and non-HTTP schemes', () => {
  for (const input of [
    'ftp://example.com/a.jpg', 'file:///C:/image.jpg', 'data:image/png;base64,abc', 'javascript:alert(1)',
    '//example.com/a.jpg', '/images/a.jpg', 'https:/example.com/a.jpg', 'https:///example.com/a.jpg', 'https://',
    'https://user:secret@example.com/a.jpg', 'https://user@example.com/a.jpg', 'http://:secret@example.com/a.jpg',
    'https://@example.com/a.jpg',
    'https://example.com/a.jpg https://example.com/b.jpg', 'https://example.com/a\u0000.jpg',
    'https://example.com\\a.jpg', '[img]https://example.com/a\n.jpg[/img]',
  ]) {
    assert.throws(() => parseImageSources(input), Error, input);
  }
});

test('image source parser enforces a bounded batch and text size without counting duplicate images twice', () => {
  const urls = Array.from({ length: MAX_IMAGE_SOURCES }, (_, index) => `https://example.com/${index}.jpg`);
  assert.deepEqual(parseImageSources(urls.join('\n')), urls);
  assert.deepEqual(parseImageSources([...urls, urls[0]].join('\n')), urls);
  assert.throws(() => parseImageSources([...urls, 'https://example.com/extra.jpg'].join('\n')), /最多导入 100/);
  assert.throws(() => parseImageSources(' '.repeat(256 * 1024 + 1)), /文本过长/);
});
