// Executed inside a fresh release candidate container. Credentials are fixtures only.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';

const base = 'http://127.0.0.1:3210';
const request = (path, options = {}) => fetch(`${base}${path}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(5_000) });
// node:http preserves the actual Host header; fetch/Undici may replace it.
function statusWithHeaders(path, headers) {
  return new Promise((resolve, reject) => {
    const client = httpRequest(`${base}${path}`, { headers, signal: AbortSignal.timeout(5_000) }, response => {
      response.on('error', reject);
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    client.once('error', reject);
    client.end();
  });
}
let healthy = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await request('/api/health');
    healthy = response.ok && (await response.json()).app === 'lumina-gallery';
    if (healthy) break;
  } catch { /* The process may still be starting; each attempt is bounded. */ }
  await new Promise(resolve => setTimeout(resolve, 500));
}
assert(healthy, 'Release image must boot its HTTP service');
const status = await (await request('/api/auth/status')).json();
assert.equal(status.configured, false);
assert.equal(status.authenticated, false);
assert.equal(status.setupAllowed, true);
assert.equal((await request('/api/albums')).status, 401);
assert.equal((await request('/api/admin/security/settings')).status, 401);
assert.equal(await statusWithHeaders('/api/health', { Host: 'gallery.example.test' }), 403, 'Public HTTP must be rejected');
assert.equal(await statusWithHeaders('/api/auth/status', { Host: 'gallery.example.test', 'X-Forwarded-Proto': 'https' }), 403, 'Untrusted forwarding cannot bypass TLS');
const password = 'TEST-ONLY-Release-Smoke-Password';
const response = await request('/api/auth/setup', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'release-smoke', password }),
});
assert.equal(response.status, 201);
const body = await response.text();
assert(!body.includes(password));
const account = JSON.parse(body);
assert.equal(account.role, 'admin');
const cookie = response.headers.getSetCookie().find(value => value.startsWith('lumina_session='));
assert(cookie && /httponly/i.test(cookie) && /samesite=strict/i.test(cookie));
assert.equal((await request('/api/albums', { headers: { Cookie: cookie.split(';')[0] } })).status, 200);
process.stdout.write('Release container boot, health, TLS guard, login boundary, and admin initialization passed.\n');
