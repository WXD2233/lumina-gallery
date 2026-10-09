import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from './index.ts';
import type { SecurityMessage } from './security.ts';

test('actual auth routes send one new-source alert and one coalesced brute-force alert through configured mail', async () => {
  const prefix = join(tmpdir(), 'lumina-notification-integration-');
  const directory = await mkdtemp(prefix);
  const messages: SecurityMessage[] = [];
  const runtime = await createApp({ dataDir: directory, securityOptions: {
    transportFactory: () => ({ async sendMail(message) { messages.push(message); return {}; } }),
  } });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const credentials = { username: 'mail-integration-admin', password: 'jade lantern beneath the willow' };
  const json = (path: string, body: object, cookie = '', method = 'POST') => fetch(`${base}/api/${path}`, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  try {
    const setup = await json('auth/setup', credentials); assert.equal(setup.status, 201);
    const cookie = setup.headers.get('set-cookie')!.split(';')[0];
    const saved = await json('admin/security/settings', { enabled: true, host: 'smtp.example.com', port: 465, secure: true, username: 'sender@example.com', password: 'fixture-smtp-secret', from: 'sender@example.com', to: ['admin@example.com'], notifyNewSourceLogin: true, notifyBruteForce: true }, cookie, 'PATCH');
    assert.equal(saved.status, 200, await saved.clone().text());
    for (let attempt = 0; attempt < 2; attempt++) {
      const login = await json('auth/login', credentials); assert.equal(login.status, 200);
      await runtime.security.flush();
      assert.equal(messages.length, 1, 'known source must not send another login email');
    }
    for (let attempt = 0; attempt < 7; attempt++) {
      const failure = await json('auth/login', { username: 'not-an-account', password: 'bad-credential-for-fixture' });
      assert([401, 429].includes(failure.status));
    }
    await runtime.security.flush();
    assert.equal(messages.length, 2, 'repeated blocked requests must share one attack email');
    assert.match(messages[0].subject, /新来源登录/); assert.match(messages[1].subject, /异常登录尝试/);
    assert.deepEqual(messages[0].to, ['admin@example.com']);
    const events = await (await fetch(`${base}/api/admin/security/events`, { headers: { Cookie: cookie } })).json();
    assert.equal(events.filter((event: { status: string }) => event.status === 'sent').length, 2);
    const content = JSON.stringify({ messages, events });
    for (const secret of [credentials.password, 'fixture-smtp-secret', 'bad-credential-for-fixture', cookie]) assert(!content.includes(secret));
    assert.equal((await fetch(`${base}/api/albums`, { headers: { Cookie: cookie } })).status, 200, 'attack alerts do not log out the existing administrator');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await runtime.close();
    assert(resolve(directory).startsWith(resolve(prefix)));
    await rm(directory, { recursive: true, force: true });
  }
});
