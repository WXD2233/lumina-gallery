import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';

export type AuthOperation = 'login' | 'setup' | 'password';
export const AUTH_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
export const AUTH_FAILURE_IDLE_MS = 24 * 60 * 60 * 1000;
export const AUTH_MAX_SOURCE_ROWS = 1000;
const BASE_COOLDOWN_MS = 30 * 1000;
const MAX_COOLDOWN_MS = 15 * 60 * 1000;

interface ThrottleRow {
  key: string; scope: AuthOperation; attempts: number; window_until: number;
  failures: number; last_failure_at: number; blocked_until: number; expires_at: number;
}

export class AuthThrottleError extends Error {
  readonly status = 429;
  constructor(public readonly retryAfterSeconds: number, message = '尝试过于频繁，请等待后重试') { super(message); }
}

/** Only pass the socket peer here, never forwarding headers supplied by clients. */
export function authSourceKey(address: string | undefined): string {
  let canonical = (address ?? 'unknown').toLowerCase().split('%')[0];
  if (isIP(canonical) === 6) {
    // URL canonicalization expands dotted IPv4 suffixes into IPv6 words first.
    const compressed = new URL(`http://[${canonical}]/`).hostname.slice(1, -1);
    const [left, right = ''] = compressed.split('::');
    const head = left ? left.split(':') : [];
    const tail = right ? right.split(':') : [];
    const words = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail].map(word => parseInt(word, 16));
    if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
      canonical = `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
    } else {
      // A rotating privacy address within one IPv6 network must share the budget.
      canonical = `${words.slice(0, 4).map(word => word.toString(16)).join(':')}::/64`;
    }
  }
  return createHash('sha256').update(`lumina-auth-source-v1:${canonical}`).digest('hex');
}

export interface AuthAttempt {
  success(): void;
  failure(): number;
}

/** SQLite reservations happen synchronously before password hashing or body parsing. */
export class AuthThrottle {
  constructor(private readonly db: DatabaseSync, private readonly clock: () => number = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS auth_throttle (
      key TEXT PRIMARY KEY, scope TEXT NOT NULL,
      attempts INTEGER NOT NULL, window_until INTEGER NOT NULL,
      failures INTEGER NOT NULL, last_failure_at INTEGER NOT NULL,
      blocked_until INTEGER NOT NULL, expires_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS auth_throttle_expiry ON auth_throttle(expires_at);`);
    this.prune();
  }

  prune(removeDeletedAccounts = true): void {
    this.db.prepare('DELETE FROM auth_throttle WHERE expires_at <= ?').run(this.clock());
    // Account deletion may race a password derivation finishing on another request.
    // Remove old per-account reservations as well as expired attempts.
    if (removeDeletedAccounts && this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_users'").get()) {
      this.db.exec(`DELETE FROM auth_throttle WHERE scope='password' AND key GLOB 'password:user:*'
        AND CAST(substr(key,15,instr(substr(key,15),':')-1) AS INTEGER) NOT IN (SELECT id FROM auth_users)`);
    }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('SAVEPOINT auth_throttle_change');
    try { const result = operation(); this.db.exec('RELEASE SAVEPOINT auth_throttle_change'); return result; }
    catch (error) { this.db.exec('ROLLBACK TO SAVEPOINT auth_throttle_change; RELEASE SAVEPOINT auth_throttle_change'); throw error; }
  }

  private row(key: string, scope: AuthOperation, now: number): ThrottleRow {
    const stored = this.db.prepare('SELECT * FROM auth_throttle WHERE key = ?').get(key) as unknown as ThrottleRow | undefined;
    const result = stored ?? { key, scope, attempts: 0, window_until: now + AUTH_ATTEMPT_WINDOW_MS, failures: 0, last_failure_at: 0, blocked_until: 0, expires_at: 0 };
    if (result.window_until <= now) { result.attempts = 0; result.window_until = now + AUTH_ATTEMPT_WINDOW_MS; }
    if (result.last_failure_at + AUTH_FAILURE_IDLE_MS <= now) { result.failures = 0; result.last_failure_at = 0; result.blocked_until = 0; }
    return result;
  }

  private save(row: ThrottleRow): void {
    row.expires_at = Math.max(row.window_until, row.blocked_until, row.last_failure_at ? row.last_failure_at + AUTH_FAILURE_IDLE_MS : 0);
    this.db.prepare(`INSERT INTO auth_throttle(key,scope,attempts,window_until,failures,last_failure_at,blocked_until,expires_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
      attempts=excluded.attempts,window_until=excluded.window_until,failures=excluded.failures,
      last_failure_at=excluded.last_failure_at,blocked_until=excluded.blocked_until,expires_at=excluded.expires_at`)
      .run(row.key, row.scope, row.attempts, row.window_until, row.failures, row.last_failure_at, row.blocked_until, row.expires_at);
  }

  private remaining(source: ThrottleRow, global: ThrottleRow, now: number): number {
    const until = Math.max(source.blocked_until, global.blocked_until,
      source.attempts >= 10 ? source.window_until : 0, global.attempts >= 60 ? global.window_until : 0);
    return Math.max(0, Math.ceil((until - now) / 1000));
  }

  begin(scope: AuthOperation, address: string | undefined, authenticatedUserId?: number): AuthAttempt {
    const namespace = scope === 'password' && Number.isSafeInteger(authenticatedUserId) && authenticatedUserId! > 0
      ? `${scope}:user:${authenticatedUserId}` : scope;
    const sourceKey = `${namespace}:source:${authSourceKey(address)}`;
    const globalKey = `${namespace}:global`;
    this.transaction(() => {
      const now = this.clock();
      this.prune(false);
      const source = this.row(sourceKey, scope, now);
      const global = this.row(globalKey, scope, now);
      const remaining = this.remaining(source, global, now);
      if (remaining > 0) throw new AuthThrottleError(remaining);
      if (!this.db.prepare('SELECT 1 FROM auth_throttle WHERE key = ?').get(sourceKey)) {
        const count = this.db.prepare('SELECT COUNT(*) AS count FROM auth_throttle WHERE scope = ? AND key LIKE ?').get(scope, `${namespace}:source:%`)!.count as number;
        // Never evict a blocked source just to make room for a new attacker address.
        if (count >= AUTH_MAX_SOURCE_ROWS) throw new AuthThrottleError(60);
      }
      source.attempts++; global.attempts++;
      this.save(source); this.save(global);
    });
    let finished = false;
    return {
      success: () => {
        if (finished) return;
        finished = true;
        this.transaction(() => {
          const now = this.clock();
          for (const key of [sourceKey, globalKey]) {
            const row = this.row(key, scope, now);
            row.failures = 0; row.last_failure_at = 0; row.blocked_until = 0;
            this.save(row);
          }
        });
      },
      failure: () => {
        if (finished) return 0;
        finished = true;
        return this.transaction(() => {
          const now = this.clock();
          const source = this.row(sourceKey, scope, now);
          const global = this.row(globalKey, scope, now);
          for (const [row, threshold] of [[source, 5], [global, 10]] as const) {
            row.failures = Math.min(row.failures + 1, 1000);
            row.last_failure_at = now;
            if (row.failures >= threshold) {
              const cooldown = Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** Math.min(row.failures - threshold, 5));
              row.blocked_until = Math.max(row.blocked_until, now + cooldown);
            }
            this.save(row);
          }
          return this.remaining(source, global, now);
        });
      },
    };
  }
}
