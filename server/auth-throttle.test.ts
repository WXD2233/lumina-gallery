import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { AuthThrottle, AuthThrottleError, AUTH_ATTEMPT_WINDOW_MS, AUTH_FAILURE_IDLE_MS, AUTH_MAX_SOURCE_ROWS, authSourceKey } from './auth-throttle.ts';

function fixture() {
  const db = new DatabaseSync(':memory:');
  let now = Date.parse('2026-10-09T00:00:00Z');
  const clock = () => now;
  const throttle = new AuthThrottle(db, clock);
  return { db, throttle, clock, advance(ms: number) { now += ms; }, close() { db.close(); } };
}

function retry(operation: () => unknown): number {
  try { operation(); assert.fail('expected throttling'); }
  catch (error) { assert(error instanceof AuthThrottleError); return error.retryAfterSeconds; }
}

test('maintenance clears deleted-account attempts including a request that finished after deletion', () => {
  const f = fixture();
  try {
    f.db.exec('CREATE TABLE auth_users (id INTEGER PRIMARY KEY); INSERT INTO auth_users VALUES(1),(12)');
    f.throttle.begin('password', '192.0.2.1', 1).failure();
    const pending = f.throttle.begin('password', '192.0.2.1', 12);
    f.db.exec('DELETE FROM auth_users WHERE id=12');
    pending.failure();
    f.throttle.prune();
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM auth_throttle WHERE key GLOB 'password:user:12:*'").get()!.n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM auth_throttle WHERE key GLOB 'password:user:1:*'").get()!.n, 2);
  } finally { f.close(); }
});

test('progressive source cooldown is persistent, grows after failure, and rejected requests do not extend it', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 4; i++) assert.equal(f.throttle.begin('login', '192.0.2.1').failure(), 0);
    assert.equal(f.throttle.begin('login', '192.0.2.1').failure(), 30);
    const before = f.db.prepare('SELECT * FROM auth_throttle ORDER BY key').all();
    assert.equal(retry(() => f.throttle.begin('login', '192.0.2.1')), 30);
    assert.deepEqual(f.db.prepare('SELECT * FROM auth_throttle ORDER BY key').all(), before);
    f.advance(1000);
    const restarted = new AuthThrottle(f.db, f.clock);
    assert.equal(retry(() => restarted.begin('login', '192.0.2.1')), 29);
    f.advance(29000);
    assert.equal(restarted.begin('login', '192.0.2.1').failure(), 60);
    f.advance(60000);
    assert.equal(restarted.begin('login', '192.0.2.1').failure(), 120);
  } finally { f.close(); }
});

test('rotating source addresses still hits the scope-wide failure cooldown', () => {
  const f = fixture();
  try {
    for (let i = 1; i <= 9; i++) assert.equal(f.throttle.begin('login', `192.0.2.${i}`).failure(), 0);
    assert.equal(f.throttle.begin('login', '192.0.2.10').failure(), 30);
    assert.equal(retry(() => f.throttle.begin('login', '198.51.100.1')), 30);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM auth_throttle WHERE key LIKE '%:source:%'").get()!.count, 10);
    f.advance(30000);
    assert.equal(f.throttle.begin('login', '198.51.100.2').failure(), 60);
  } finally { f.close(); }
});

test('successful authentication clears failures but preserves the source and global request quotas', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 4; i++) f.throttle.begin('login', '192.0.2.1').failure();
    const success = f.throttle.begin('login', '192.0.2.1'); success.success(); success.failure();
    const rows = f.db.prepare('SELECT * FROM auth_throttle').all();
    assert.equal(rows.length, 2);
    for (const row of rows) { assert.equal(row.failures, 0); assert.equal(row.blocked_until, 0); assert.equal(row.attempts, 5); }
    for (let i = 0; i < 5; i++) f.throttle.begin('login', '192.0.2.1').success();
    assert.equal(retry(() => f.throttle.begin('login', '192.0.2.1')), 600);
    f.advance(AUTH_ATTEMPT_WINDOW_MS);
    f.throttle.begin('login', '192.0.2.1').success();
  } finally { f.close(); }
});

test('reservations enforce source and global quotas before concurrent attempts finish', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 10; i++) f.throttle.begin('login', '192.0.2.1');
    assert.equal(retry(() => f.throttle.begin('login', '192.0.2.1')), 600);
    for (let i = 2; i <= 51; i++) f.throttle.begin('login', `192.0.2.${i}`);
    assert.equal(retry(() => f.throttle.begin('login', '198.51.100.1')), 600);
    f.advance(1234);
    assert.equal(retry(() => f.throttle.begin('login', '198.51.100.2')), 599);
  } finally { f.close(); }
});

test('setup and authenticated password changes have independent budgets from login', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 5; i++) f.throttle.begin('login', '127.0.0.1').failure();
    assert.equal(retry(() => f.throttle.begin('login', '127.0.0.1')), 30);
    f.throttle.begin('password', '127.0.0.1').success();
    f.throttle.begin('setup', '127.0.0.1').success();
    assert.equal(retry(() => f.throttle.begin('login', '127.0.0.1')), 30);
  } finally { f.close(); }
});

test('cooldown caps at 15 minutes and failures reset after 24 idle hours', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 20; i++) {
      const wait = f.throttle.begin('login', `192.0.2.${i + 1}`).failure();
      assert(wait <= 900);
      if (i >= 14) assert.equal(wait, 900);
      f.advance(Math.max(wait * 1000, 1));
    }
    f.advance(AUTH_FAILURE_IDLE_MS);
    f.throttle.prune();
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM auth_throttle').get()!.count, 0);
    assert.equal(f.throttle.begin('login', '192.0.2.1').failure(), 0);
  } finally { f.close(); }
});

test('source identity merges IPv4-mapped IPv6 and privacy addresses without retaining raw IPs', () => {
  assert.equal(authSourceKey('192.0.2.5'), authSourceKey('::ffff:192.0.2.5'));
  assert.equal(authSourceKey('192.0.2.5'), authSourceKey('0:0:0:0:0:ffff:c000:205'));
  assert.equal(authSourceKey('2001:db8:1:2::1'), authSourceKey('2001:0db8:0001:0002:abcd:ffff:1234:5678'));
  assert.notEqual(authSourceKey('2001:db8:1:2::1'), authSourceKey('2001:db8:1:3::1'));
  assert.notEqual(authSourceKey('192.0.2.5'), authSourceKey('192.0.2.6'));
  assert.match(authSourceKey('192.0.2.5'), /^[a-f0-9]{64}$/);
});

test('the storage cap refuses new sources without evicting existing blocked entries', () => {
  const f = fixture();
  try {
    const insert = f.db.prepare(`INSERT INTO auth_throttle(key,scope,attempts,window_until,failures,last_failure_at,blocked_until,expires_at)
      VALUES(?, 'login', 1, ?, 5, ?, ?, ?)`);
    for (let i = 0; i < AUTH_MAX_SOURCE_ROWS; i++) {
      insert.run(`login:source:fixture-${i}`, f.clock() + 600000, f.clock(), f.clock() + 30000, f.clock() + AUTH_FAILURE_IDLE_MS);
    }
    assert.equal(retry(() => f.throttle.begin('login', '192.0.2.1')), 60);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM auth_throttle').get()!.count, AUTH_MAX_SOURCE_ROWS);
    assert(f.db.prepare("SELECT 1 FROM auth_throttle WHERE key = 'login:source:fixture-0'").get());
    f.throttle.begin('password', '192.0.2.1').success();
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM auth_throttle WHERE scope = 'password'").get()!.count, 2);
    f.advance(AUTH_FAILURE_IDLE_MS);
    f.throttle.begin('login', '192.0.2.1').success();
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM auth_throttle').get()!.count, 2);
  } finally { f.close(); }
});
