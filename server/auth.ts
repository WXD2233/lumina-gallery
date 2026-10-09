import express, { type Request, type Response, type RequestHandler } from 'express';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { PASSWORD_MAX_LENGTH, SESSION_HOURS, type AdminUser, type AuthPrincipal, type AuthStatus, type UserRole } from '../shared/auth.ts';
import type { SecurityEventInput } from '../shared/security.ts';
import { validateNewPassword } from '../shared/password-policy.ts';
import { ApiError, type GalleryDb } from './db.ts';
import { AuthThrottle, AuthThrottleError, type AuthAttempt, type AuthOperation } from './auth-throttle.ts';
import { ensureAuthSchema, normalizedUsername } from './auth-schema.ts';
import { reportRuntimeError } from './runtime-log.ts';
import { isDirectLoopbackRequest } from './transport-security.ts';

const COOKIE_NAME = 'lumina_session';
const SESSION_MS = SESSION_HOURS * 60 * 60 * 1000;
const MAX_SESSION_COUNT = 20;
// OWASP's scrypt N=2^15,r=8,p=3 profile uses about 32 MiB per derivation.
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 48 * 1024 * 1024 };
const DUMMY_SALT = randomBytes(16).toString('hex');
const DUMMY_HASH = randomBytes(64);
let activeDerivations = 0;

interface AuthUser { id: number; username: string; username_key: string; salt: string; password_hash: string; created_at: number; role: UserRole; disabled: number; last_login_at: number | null; }
interface AuthSession { token_hash: string; user_id: number; created_at: number; expires_at: number; }
async function derive(password: string, salt: string, operation: AuthOperation): Promise<Buffer> {
  // Keep one of the four memory-heavy derivation slots available for account management.
  if (activeDerivations >= (operation === 'password' ? 4 : 3)) throw new AuthThrottleError(3, '登录请求较多，请稍后重试');
  activeDerivations++;
  try {
    return await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, SCRYPT_OPTIONS, (error, key) => error ? reject(error) : resolve(key)));
  } finally { activeDerivations--; }
}

function passwordValue(value: unknown, username: string): string {
  try { return validateNewPassword(value, username); }
  catch (error) { throw new ApiError(400, error instanceof Error ? error.message : '密码格式不正确'); }
}

function usernameValue(value: unknown): string {
  if (typeof value !== 'string' || value.length > 100) throw new ApiError(400, '用户名需要 2–40 个字符');
  const username = value.normalize('NFKC').trim();
  if (username.length < 2 || username.length > 40 || /[\u0000-\u001f\u007f-\u009f]/.test(username)) throw new ApiError(400, '用户名需要 2–40 个字符，不能包含控制字符');
  return username;
}

function tokenFrom(req: Request): string | undefined {
  const values = (req.get('Cookie') ?? '').split(';').map(item => item.trim()).filter(item => item.startsWith(`${COOKIE_NAME}=`));
  if (values.length !== 1) return undefined;
  const token = values[0].slice(COOKIE_NAME.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export const localSetupAllowed = isDirectLoopbackRequest;

/** Register the public login endpoints before protected API/body-parser middleware. */
export function registerAuthRoutes(app: express.Express, db: GalleryDb, options: {
  onSecurityEvent?: (event: SecurityEventInput) => void;
} = {}): { requireAuth: RequestHandler; requireAdmin: RequestHandler; close: () => void } {
  ensureAuthSchema(db.connection);
  const throttle = new AuthThrottle(db.connection);
  const configured = () => Boolean(db.connection.prepare('SELECT 1 FROM auth_users LIMIT 1').get());
  const user = (id: number) => db.connection.prepare('SELECT * FROM auth_users WHERE id = ?').get(id) as unknown as AuthUser | undefined;
  const byName = (name: string) => db.connection.prepare('SELECT * FROM auth_users WHERE username_key = ?').get(normalizedUsername(name)) as unknown as AuthUser | undefined;
  function security(req: Request, input: Omit<SecurityEventInput, 'source' | 'userAgent'>): void {
    // Notification delivery must never block or change an authentication result.
    try { options.onSecurityEvent?.({ ...input, source: req.ip || req.socket.remoteAddress || 'unknown',
      userAgent: (req.get('User-Agent') ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 256) }); }
    catch { /* A failed audit sink must not lock the administrator out. */ }
  }
  const pruneSessions = () => db.connection.prepare('DELETE FROM auth_sessions WHERE expires_at <= ? OR user_id NOT IN (SELECT id FROM auth_users)').run(Date.now());
  pruneSessions();
  const pruneTimer = setInterval(() => {
    try { pruneSessions(); throttle.prune(); }
    catch (error) { reportRuntimeError('auth-maintenance', error); }
  }, 15 * 60 * 1000);
  pruneTimer.unref();

  function session(req: Request): AuthSession | undefined {
    const token = tokenFrom(req);
    if (!token) return undefined;
    return db.connection.prepare('SELECT * FROM auth_sessions WHERE token_hash = ? AND expires_at > ?').get(tokenHash(token), Date.now()) as unknown as AuthSession | undefined;
  }
  function status(req: Request): AuthStatus {
    const account = sessionUser(req);
    const hasAccounts = configured();
    return { configured: hasAccounts, authenticated: Boolean(account), setupAllowed: !hasAccounts && localSetupAllowed(req),
      ...(account ? { userId: account.id, username: account.username, role: account.role } : {}) };
  }
  function sessionUser(req: Request): AuthUser | undefined {
    const active = session(req);
    const account = active && user(active.user_id);
    return account && !account.disabled ? account : undefined;
  }
  function secureCookie(req: Request): boolean {
    if (req.secure) return true;
    // TLS may terminate at a reverse proxy. An exact-host HTTPS Origin only
    // tightens the cookie; arbitrary forwarding headers are never trusted.
    try {
      const origin = new URL(req.get('Origin') ?? '');
      return origin.protocol === 'https:' && origin.host === req.get('Host');
    } catch { return false; }
  }
  function setCookie(req: Request, res: Response, token: string) {
    res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'strict', secure: secureCookie(req), path: '/', maxAge: SESSION_MS });
  }
  function clearCookie(req: Request, res: Response) {
    res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'strict', secure: secureCookie(req), path: '/' });
  }
  function deleteCurrentSession(req: Request) {
    const token = tokenFrom(req);
    if (token) db.connection.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash(token));
  }
  function newSession(req: Request, userId: number): string {
    pruneSessions();
    deleteCurrentSession(req);
    // Bound storage even when a client repeatedly signs in without retaining cookies.
    db.connection.prepare(`DELETE FROM auth_sessions WHERE token_hash IN (
      SELECT token_hash FROM auth_sessions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
    )`).run(userId, MAX_SESSION_COUNT - 1);
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    db.connection.prepare('INSERT INTO auth_sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)').run(tokenHash(token), userId, now, now + SESSION_MS);
    db.connection.prepare('UPDATE auth_users SET last_login_at = ? WHERE id = ?').run(now, userId);
    return token;
  }
  function transaction<T>(operation: () => T): T {
    db.connection.exec('SAVEPOINT auth_change');
    try { const result = operation(); db.connection.exec('RELEASE SAVEPOINT auth_change'); return result; }
    catch (error) { db.connection.exec('ROLLBACK TO SAVEPOINT auth_change; RELEASE SAVEPOINT auth_change'); throw error; }
  }
  function success(res: Response, account: AuthUser, code = 200) {
    return res.status(code).json({ configured: true, authenticated: true, userId: account.id, username: account.username, role: account.role, setupAllowed: false } satisfies AuthStatus);
  }
  const requireAuth: RequestHandler = (req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const account = sessionUser(req);
    if (!account) return res.status(401).json({ error: '请先登录图库' });
    res.locals.authUser = { id: account.id, username: account.username, role: account.role } satisfies AuthPrincipal;
    res.locals.authSessionHash = tokenHash(tokenFrom(req)!);
    next();
  };
  const requireAdmin: RequestHandler = (req, res, next) => requireAuth(req, res, () => {
    if ((res.locals.authUser as AuthPrincipal).role !== 'admin') return res.status(403).json({ error: '此操作需要管理员权限' });
    next();
  });

  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/status', (req, res) => res.json(status(req)));
  router.use((req, res, next) => {
    const match = /^\/(login|setup|password)\/?$/i.exec(req.path);
    if (req.method !== 'POST' || !match) return next();
    const operation = match[1].toLowerCase() as AuthOperation;
    if (operation === 'setup') {
      // A remote caller may not exhaust the budget reserved for local first setup.
      if (!localSetupAllowed(req)) throw new ApiError(403, '首次设置请在运行图库的电脑上，通过 localhost 直接访问');
      if (configured()) throw new ApiError(409, '管理员账号已设置，请直接登录');
    }
    const reserve = () => {
      res.locals.authAttempt = throttle.begin(operation, req.ip || req.socket.remoteAddress,
        operation === 'password' ? (res.locals.authUser as AuthPrincipal).id : undefined);
      next();
    };
    // Anonymous login traffic cannot consume the authenticated password-change budget.
    if (operation === 'password') return requireAuth(req, res, reserve);
    reserve();
  });
  router.use((req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (!req.is('application/json')) throw new ApiError(415, '登录操作需要 JSON 请求');
      const site = req.get('Sec-Fetch-Site');
      if (site && !['same-origin', 'none'].includes(site)) throw new ApiError(403, '不允许跨站登录操作');
      const origin = req.get('Origin');
      if (origin) {
        let parsed: URL;
        try { parsed = new URL(origin); } catch { throw new ApiError(403, '请求来源无效'); }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host !== req.get('Host')) throw new ApiError(403, '不允许跨站登录操作');
      }
    }
    next();
  });
  router.use(express.json({ limit: '16kb', strict: true }));
  router.use((error: unknown, _req: Request, _res: Response, next: express.NextFunction) => {
    if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') return next(new ApiError(413, '登录请求内容过大'));
    next(error);
  });
  router.post('/setup', async (req, res) => {
    if (!localSetupAllowed(req)) throw new ApiError(403, '首次设置请在运行图库的电脑上，通过 localhost 直接访问');
    if (configured()) throw new ApiError(409, '管理员账号已设置，请直接登录');
    const username = usernameValue(req.body?.username);
    const password = passwordValue(req.body?.password, username);
    const salt = randomBytes(16).toString('hex');
    const hash = await derive(password, salt, 'setup');
    const token = transaction(() => {
      if (configured()) throw new ApiError(409, '管理员账号已设置，请直接登录');
      db.connection.prepare("INSERT INTO auth_users(id,username,username_key,salt,password_hash,created_at,role) VALUES(1,?,?,?,?,?,'admin')")
        .run(username, normalizedUsername(username), salt, hash.toString('hex'), Date.now());
      return newSession(req, 1);
    });
    (res.locals.authAttempt as AuthAttempt).success();
    setCookie(req, res, token); success(res, user(1)!, 201);
  });
  router.post('/login', async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (username.length > 100 || !password || password.length > PASSWORD_MAX_LENGTH) throw new ApiError(401, '用户名或密码不正确');
    const account = byName(username);
    const hash = await derive(password, account?.salt ?? DUMMY_SALT, 'login');
    const expected = account ? Buffer.from(account.password_hash, 'hex') : DUMMY_HASH;
    const verified = expected.length === hash.length && timingSafeEqual(expected, hash);
    // Password rotation can run while scrypt is pending; do not mint an old-password session.
    const latest = account && user(account.id);
    if (!account || !latest || latest.disabled || latest.username_key !== normalizedUsername(username) || latest.password_hash !== account.password_hash || latest.salt !== account.salt || !verified) throw new ApiError(401, '用户名或密码不正确');
    const token = transaction(() => newSession(req, latest.id));
    (res.locals.authAttempt as AuthAttempt).success();
    security(req, { type: 'login_success', userId: latest.id, username: latest.username });
    setCookie(req, res, token); success(res, latest);
  });
  router.post('/logout', (req, res) => {
    deleteCurrentSession(req); clearCookie(req, res);
    // Also evict images cached by older versions, which used long-lived public caching.
    res.setHeader('Clear-Site-Data', '"cache"');
    const hasAccounts = configured();
    res.json({ configured: hasAccounts, authenticated: false, setupAllowed: !hasAccounts && localSetupAllowed(req) } satisfies AuthStatus);
  });
  router.post('/password', requireAuth, async (req, res) => {
    const account = user((res.locals.authUser as AuthPrincipal).id)!;
    const current = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    const replacement = passwordValue(req.body?.newPassword, account.username);
    if (!current || current.length > PASSWORD_MAX_LENGTH) throw new ApiError(400, '当前密码不正确');
    const hash = await derive(current, account.salt, 'password');
    const expected = Buffer.from(account.password_hash, 'hex');
    if (expected.length !== hash.length || !timingSafeEqual(expected, hash)) throw new ApiError(400, '当前密码不正确');
    const salt = randomBytes(16).toString('hex');
    const passwordHash = await derive(replacement, salt, 'password');
    const token = transaction(() => {
      const latest = sessionUser(req);
      if (!latest || latest.id !== account.id || latest.password_hash !== account.password_hash) throw new ApiError(401, '登录状态已变化，请重新登录');
      db.connection.prepare('UPDATE auth_users SET salt = ?, password_hash = ? WHERE id = ?').run(salt, passwordHash.toString('hex'), account.id);
      db.connection.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(account.id);
      return newSession(req, account.id);
    });
    (res.locals.authAttempt as AuthAttempt).success();
    setCookie(req, res, token); success(res, account);
  });
  router.use((error: unknown, req: Request, res: Response, next: express.NextFunction) => {
    const retryAfterSeconds = Math.max((res.locals.authAttempt as AuthAttempt | undefined)?.failure() ?? 0,
      error instanceof AuthThrottleError ? error.retryAfterSeconds : 0);
    if (retryAfterSeconds) {
      res.setHeader('Retry-After', retryAfterSeconds);
      security(req, { type: 'login_blocked', detail: `认证请求受到限制，请在 ${retryAfterSeconds} 秒后重试` });
    }
    if (error instanceof AuthThrottleError || error instanceof ApiError) {
      return res.status(error.status).json({ error: error.message, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) });
    }
    // Malformed JSON is still a failed attempt, and uses the same retry contract.
    if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.parse.failed') {
      return res.status(400).json({ error: '请求内容格式不正确', ...(retryAfterSeconds ? { retryAfterSeconds } : {}) });
    }
    next(error);
  });
  app.use('/api/auth', router);

  const publicUser = (account: AuthUser): AdminUser => ({
    id: account.id, username: account.username, role: account.role, disabled: Boolean(account.disabled),
    createdAt: new Date(account.created_at).toISOString(),
    lastLoginAt: account.last_login_at === null ? null : new Date(account.last_login_at).toISOString(),
  });
  const roleValue = (value: unknown): UserRole => {
    if (value !== 'admin' && value !== 'viewer') throw new ApiError(400, '请选择管理员或普通账户');
    return value;
  };
  function liveAdministrator(req: Request): AuthUser {
    const current = sessionUser(req);
    if (!current) throw new ApiError(401, '登录状态已变化，请重新登录');
    if (current.role !== 'admin') throw new ApiError(403, '此操作需要管理员权限');
    return current;
  }
  function otherAccount(req: Request, id: number): AuthUser {
    const current = liveAdministrator(req);
    if (current.id === id) throw new ApiError(403, '请在账户与头像中管理自己的账户，不能在此修改或删除当前管理员');
    const target = user(id);
    if (!target) throw new ApiError(404, '账户不存在');
    return target;
  }
  function preserveAdministrator(target: AuthUser, nextRole: UserRole, disabled: boolean): void {
    if (target.role !== 'admin' || target.disabled || (nextRole === 'admin' && !disabled)) return;
    const count = Number(db.connection.prepare("SELECT COUNT(*) AS count FROM auth_users WHERE role = 'admin' AND disabled = 0").get()!.count);
    if (count <= 1) throw new ApiError(409, '至少需要保留一个可用的管理员账户');
  }
  const userId = (req: Request): number => {
    const text = String(req.params.id);
    const id = Number(text);
    if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(id)) throw new ApiError(400, '账户编号无效');
    return id;
  };
  const bodyFields = (body: unknown, allowed: string[]): Record<string, unknown> => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, '账户信息格式不正确');
    const fields = body as Record<string, unknown>;
    if (Object.keys(fields).some(key => !allowed.includes(key))) throw new ApiError(400, '账户信息包含不支持的字段');
    return fields;
  };
  const admin = express.Router();
  // Authenticate and authorize before parsing any account-management request body.
  admin.use(requireAdmin);
  admin.use((req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.method !== 'DELETE' && !req.is('application/json')) throw new ApiError(415, '账户操作需要 JSON 请求');
      const site = req.get('Sec-Fetch-Site');
      if (site && !['same-origin', 'none'].includes(site)) throw new ApiError(403, '不允许跨站账户操作');
      const origin = req.get('Origin');
      if (origin) {
        let parsed: URL;
        try { parsed = new URL(origin); } catch { throw new ApiError(403, '请求来源无效'); }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host !== req.get('Host')) throw new ApiError(403, '不允许跨站账户操作');
      }
    }
    next();
  });
  admin.use(express.json({ limit: '16kb', strict: true }));
  admin.get('/', (_req, res) => {
    const accounts = db.connection.prepare('SELECT * FROM auth_users ORDER BY id').all() as unknown as AuthUser[];
    res.json(accounts.map(publicUser));
  });
  admin.post('/', async (req, res) => {
    const body = bodyFields(req.body, ['username', 'password', 'role']);
    const username = usernameValue(body.username);
    const password = passwordValue(body.password, username);
    const role = roleValue(body.role ?? 'viewer');
    if (byName(username)) throw new ApiError(409, '用户名已存在');
    const salt = randomBytes(16).toString('hex');
    const hash = await derive(password, salt, 'password');
    const account = transaction(() => {
      liveAdministrator(req);
      if (byName(username)) throw new ApiError(409, '用户名已存在');
      const count = Number(db.connection.prepare('SELECT COUNT(*) AS count FROM auth_users').get()!.count);
      if (count >= 1000) throw new ApiError(409, '账户数量已达到上限');
      const inserted = db.connection.prepare(`INSERT INTO auth_users(username,username_key,salt,password_hash,created_at,role)
        VALUES(?,?,?,?,?,?)`).run(username, normalizedUsername(username), salt, hash.toString('hex'), Date.now(), role);
      return user(Number(inserted.lastInsertRowid))!;
    });
    security(req, { type: 'account_changed', userId: account.id, username: account.username, detail: '管理员添加了账户' });
    res.status(201).json(publicUser(account));
  });
  admin.patch('/:id', async (req, res) => {
    const id = userId(req);
    const original = otherAccount(req, id);
    const body = bodyFields(req.body, ['username', 'password', 'role', 'disabled']);
    if (Object.keys(body).length === 0) throw new ApiError(400, '请提供需要修改的账户信息');
    const username = 'username' in body ? usernameValue(body.username) : original.username;
    const role = 'role' in body ? roleValue(body.role) : original.role;
    if ('disabled' in body && typeof body.disabled !== 'boolean') throw new ApiError(400, '账户状态无效');
    const disabled = 'disabled' in body ? body.disabled as boolean : Boolean(original.disabled);
    const conflict = byName(username);
    if (conflict && conflict.id !== id) throw new ApiError(409, '用户名已存在');
    let salt = original.salt, hash = original.password_hash;
    if ('password' in body) {
      const password = passwordValue(body.password, username);
      salt = randomBytes(16).toString('hex');
      hash = (await derive(password, salt, 'password')).toString('hex');
    }
    const account = transaction(() => {
      const target = otherAccount(req, id);
      if (['username', 'password_hash', 'salt', 'role', 'disabled'].some(key => target[key as keyof AuthUser] !== original[key as keyof AuthUser])) {
        throw new ApiError(409, '账户信息已被修改，请刷新后重试');
      }
      preserveAdministrator(target, role, disabled);
      const duplicate = byName(username);
      if (duplicate && duplicate.id !== id) throw new ApiError(409, '用户名已存在');
      db.connection.prepare('UPDATE auth_users SET username=?,username_key=?,salt=?,password_hash=?,role=?,disabled=? WHERE id=?')
        .run(username, normalizedUsername(username), salt, hash, role, Number(disabled), id);
      if (hash !== original.password_hash || role !== original.role || disabled || username !== original.username) {
        db.connection.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(id);
      }
      return user(id)!;
    });
    security(req, { type: 'account_changed', userId: account.id, username: account.username, detail: '管理员修改了账户' });
    res.json(publicUser(account));
  });
  admin.delete('/:id', (req, res) => {
    const id = userId(req);
    const account = transaction(() => {
      const target = otherAccount(req, id);
      preserveAdministrator(target, 'viewer', true);
      db.connection.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(id);
      const profileExists = db.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_profile'").get();
      if (profileExists) db.connection.prepare('DELETE FROM account_profile WHERE id = ?').run(id);
      const sourcesExist = db.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='security_sources'").get();
      if (sourcesExist) db.connection.prepare('DELETE FROM security_sources WHERE user_id = ?').run(id);
      db.connection.prepare('DELETE FROM auth_throttle WHERE key LIKE ?').run(`password:user:${id}:%`);
      db.connection.prepare('DELETE FROM auth_users WHERE id = ?').run(id);
      return target;
    });
    security(req, { type: 'account_changed', userId: account.id, username: account.username, detail: '管理员删除了账户' });
    res.json({ deleted: true });
  });
  admin.use((error: unknown, _req: Request, res: Response, next: express.NextFunction) => {
    if (error instanceof AuthThrottleError) {
      res.setHeader('Retry-After', error.retryAfterSeconds);
      return res.status(429).json({ error: error.message, retryAfterSeconds: error.retryAfterSeconds });
    }
    if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') return next(new ApiError(413, '账户请求内容过大'));
    next(error);
  });
  app.use('/api/admin/users', admin);
  return { requireAuth, requireAdmin, close: () => { clearInterval(pruneTimer); } };
}
