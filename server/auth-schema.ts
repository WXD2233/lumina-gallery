import type { DatabaseSync } from 'node:sqlite';

/** Keep existing credentials, sessions and user id 1 when upgrading the single-account schema. */
export function ensureAuthSchema(db: DatabaseSync): void {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auth_users'").get();
  const columns = exists ? db.prepare('PRAGMA table_info(auth_users)').all().map(row => row.name) : [];
  if (columns.includes('username_key')) return;
  db.exec('SAVEPOINT auth_schema_upgrade');
  try {
    db.exec(`
      CREATE TABLE auth_users_multi (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE,
        salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin', 'viewer')),
        disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0, 1)),
        last_login_at INTEGER
      );
      CREATE TABLE auth_sessions_multi (
        token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
    `);
    if (exists) {
      const insert = db.prepare(`INSERT INTO auth_users_multi(id,username,username_key,salt,password_hash,created_at,role,disabled)
        VALUES(?,?,?,?,?,?,'admin',0)`);
      for (const row of db.prepare('SELECT * FROM auth_users').all()) {
        insert.run(row.id, row.username, normalizedUsername(String(row.username)), row.salt, row.password_hash, row.created_at);
      }
      db.exec(`INSERT INTO auth_sessions_multi SELECT token_hash,user_id,created_at,expires_at FROM auth_sessions;
        DROP TABLE auth_sessions; DROP TABLE auth_users;`);
    }
    db.exec(`ALTER TABLE auth_users_multi RENAME TO auth_users;
      ALTER TABLE auth_sessions_multi RENAME TO auth_sessions;
      CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
      CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
      RELEASE SAVEPOINT auth_schema_upgrade;`);
  } catch (error) {
    db.exec('ROLLBACK TO SAVEPOINT auth_schema_upgrade; RELEASE SAVEPOINT auth_schema_upgrade');
    throw error;
  }
}

export const normalizedUsername = (value: string): string => value.normalize('NFKC').trim().toLowerCase();
