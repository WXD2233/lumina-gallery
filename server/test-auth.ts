import assert from 'node:assert/strict';

/** Authenticate each isolated API fixture through the same setup flow as the UI. */
export async function authorizedFetch(base: string): Promise<typeof globalThis.fetch> {
  const origin = new URL(base).origin;
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'fixture credentials are only for the local test server');
  const setup = await globalThis.fetch(`${origin}/api/auth/setup`, {
    method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'test-admin', password: 'test-password-123' }),
  });
  assert(setup.ok, `test account setup failed: ${setup.status} ${await setup.text()}`);
  const cookie = setup.headers.getSetCookie().find(value => value.startsWith('lumina_session='))?.split(';')[0];
  assert(cookie, 'test account setup must issue a session cookie');
  return (input, init) => {
    const destination = new URL(input instanceof Request ? input.url : input.toString());
    assert.equal(destination.origin, origin, 'fixture cookies must not be sent to another server');
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    headers.set('Cookie', cookie);
    return globalThis.fetch(input, { ...init, headers, redirect: 'error' });
  };
}
