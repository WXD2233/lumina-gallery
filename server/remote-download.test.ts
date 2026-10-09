import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createRemoteImageDownloader, type RemoteImageDependencies } from './remote-images.ts';

const publicLookup = async () => [{ address: '8.8.8.8', family: 4 as const }];
function response(status: number, headers: Record<string, string>, chunks: Buffer[] = []): IncomingMessage {
  return Object.assign(Readable.from(chunks), { statusCode: status, headers }) as IncomingMessage;
}
async function fixture(dependencies: RemoteImageDependencies, fn: (download: ReturnType<typeof createRemoteImageDownloader>, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-remote-transport-'));
  try { await fn(createRemoteImageDownloader({ lookup: publicLookup, ...dependencies }), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
const options = () => ({ signal: new AbortController().signal });

test('remote downloader revalidates redirect destinations before opening another request', async () => {
  let requests = 0;
  await fixture({ request: async target => {
    requests++;
    assert.equal(target.address, '8.8.8.8');
    return response(302, { location: 'http://[::ffff:127.0.0.1]/private.png' });
  } }, async (download, directory) => {
    await assert.rejects(download('https://images.example/photo.png', directory, options()), /公开访问/);
    assert.equal(requests, 1);
    assert.deepEqual(await readdir(directory), []);
  });
});

test('remote downloader stops redirect loops and denies unsupported ports on redirect', async () => {
  let requests = 0;
  await fixture({ request: async () => { requests++; return response(302, { location: '/loop' }); } }, async (download, directory) => {
    await assert.rejects(download('https://images.example/photo.png', directory, options()), /跳转过多/);
    assert.equal(requests, 6);
  });
  await fixture({ request: async () => response(302, { location: 'http://images.example:8080/secret' }) }, async (download, directory) => {
    await assert.rejects(download('https://images.example/photo.png', directory, options()), /标准端口/);
  });
});

test('remote downloader rejects declared or streamed oversized content and removes partial files', async () => {
  const cases: Record<string, string>[] = [{ 'content-length': '6' }, {}];
  for (const headers of cases) {
    await fixture({ maxBytes: 4, request: async () => response(200, headers, [Buffer.from('abc'), Buffer.from('def')]) }, async (download, directory) => {
      await assert.rejects(download('https://images.example/photo.png', directory, options()), /30 MB/);
      assert.deepEqual(await readdir(directory), []);
    });
  }
});

test('remote downloader rejects web pages and empty files', async () => {
  await fixture({ request: async () => response(200, { 'content-type': 'text/html' }, [Buffer.from('<html>')]) }, async (download, directory) => {
    await assert.rejects(download('https://images.example/page', directory, options()), /图片直链/);
    assert.deepEqual(await readdir(directory), []);
  });
  await fixture({ request: async () => response(200, {}) }, async (download, directory) => {
    await assert.rejects(download('https://images.example/empty', directory, options()), /空文件/);
    assert.deepEqual(await readdir(directory), []);
  });
});

test('remote downloader enforces timeout during DNS resolution', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await fixture({ timeoutMs: 10, lookup: async () => await new Promise(() => {}) }, async (download, directory) => {
      await assert.rejects(download('https://images.example/photo.png', directory, options()), /超时/);
      assert.deepEqual(await readdir(directory), []);
    });
  } finally { clearTimeout(keepAlive); }
});

test('remote downloader stages bytes with a decoded safe filename and vetted request address', async () => {
  await fixture({ request: async (target, signal) => {
    assert.equal(target.url.hostname, 'images.example');
    assert.equal(target.address, '8.8.8.8');
    assert.equal(target.family, 4);
    assert.equal(signal.aborted, false);
    return response(200, { 'content-type': 'application/octet-stream' }, [Buffer.from('image bytes')]);
  } }, async (download, directory) => {
    const image = await download('https://images.example/%E9%A3%8E%E6%99%AF%2Fphoto.jpg?token=test', directory, options());
    assert.equal(image.originalname, '风景_photo.jpg');
    assert.equal(image.size, 11);
    assert.equal((await readFile(image.path)).toString(), 'image bytes');
    assert.equal((await readdir(directory)).length, 1);
  });
});
