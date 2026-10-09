import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/api.ts';
import { isSecureTransport } from '../src/secure-transport.ts';

test('an interrupted successful JSON response rejects instead of replacing gallery state with an object', async context => {
  context.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => { throw new DOMException('Body interrupted', 'AbortError'); } }));
  await assert.rejects(api('/albums'), /响应中断/);
});

test('API forwards caller cancellation together with its bounded request deadline', async context => {
  const controller = new AbortController();
  let passed: AbortSignal | undefined;
  context.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    passed = options.signal!;
    return { ok: true, status: 200, json: async () => [] };
  });
  assert.deepEqual(await api('/albums', { signal: controller.signal }), []);
  assert(passed); assert(!passed.aborted); controller.abort(); assert(passed.aborted);
});

test('public HTTP never submits secrets, including when the caller supplies a body', async context => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { protocol: 'http:', hostname: 'gallery.test' } } });
  context.after(() => { if (original) Object.defineProperty(globalThis, 'window', original); else Reflect.deleteProperty(globalThis, 'window'); });
  let requests = 0;
  context.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('A plaintext request must not reach fetch'); });
  for (const path of ['/auth/login', '/admin/users', '/admin/security/settings', '/auto-backup/webdav']) {
    await assert.rejects(api(path, { method: 'POST', body: JSON.stringify({ password: 'TEST-ONLY-SECRET' }) }), /HTTPS/);
  }
  assert.equal(requests, 0);
});

test('browser transport allows HTTPS and exact local HTTP hosts, not similarly named hosts', () => {
  assert(isSecureTransport({ protocol: 'https:', hostname: 'gallery.test' }));
  for (const hostname of ['localhost', '127.0.0.1', '[::1]', '::1']) assert(isSecureTransport({ protocol: 'http:', hostname }));
  for (const hostname of ['gallery.test', 'localhost.attacker.test', '127.0.0.1.attacker.test', '192.168.1.4']) assert(!isSecureTransport({ protocol: 'http:', hostname }));
  assert(!isSecureTransport({ protocol: 'file:', hostname: '' }));
});

test('API uses same-origin credentials and no-store responses', async context => {
  context.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store');
    return { ok: true, status: 200, json: async () => [] };
  });
  assert.deepEqual(await api('/albums'), []);
});
