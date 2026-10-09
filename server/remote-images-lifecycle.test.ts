import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { createRemoteImageDownloader } from './remote-images.ts';

const lookup = async () => [{ address: '8.8.8.8', family: 4 as const }];
function response(chunks: Buffer[]): IncomingMessage {
  return Object.assign(Readable.from(chunks), { statusCode: 200, headers: { 'content-type': 'image/png' } }) as unknown as IncomingMessage;
}

test('a response arriving after cancellation is destroyed rather than leaked', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-remote-late-'));
  let started!: () => void, release!: (value: IncomingMessage) => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const request = async () => { started(); return new Promise<IncomingMessage>(resolve => { release = resolve; }); };
  const abort = new AbortController();
  try {
    const downloading = createRemoteImageDownloader({ lookup, request })('https://images.example/photo.png', directory, { signal: abort.signal });
    await ready; abort.abort();
    await assert.rejects(downloading, /取消/);
    const late = response([Buffer.from('late image')]);
    release(late);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(late.destroyed, true);
    assert.deepEqual(await readdir(directory), []);
  } finally { abort.abort(); await rm(directory, { recursive: true, force: true }); }
});

test('oversize streaming responses are destroyed and partial files removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumina-remote-limit-'));
  const stream = response([Buffer.alloc(16), Buffer.alloc(16)]);
  try {
    await assert.rejects(createRemoteImageDownloader({ lookup, request: async () => stream, maxBytes: 20 })('https://images.example/photo.png', directory, { signal: new AbortController().signal }), /30 MB/);
    assert.equal(stream.destroyed, true);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an already cancelled image import starts neither DNS nor HTTP work', async () => {
  const abort = new AbortController(); abort.abort();
  let calls = 0;
  await assert.rejects(createRemoteImageDownloader({ lookup: async () => { calls++; return lookup(); } })('https://images.example/photo.png', tmpdir(), { signal: abort.signal }), /取消/);
  assert.equal(calls, 0);
});
