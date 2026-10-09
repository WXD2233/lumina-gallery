import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Aperture, ArrowRight, CircleAlert, Clock3, Eye, EyeOff, KeyRound, LoaderCircle, LockKeyhole, ShieldCheck } from 'lucide-react';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, SESSION_HOURS, type AuthStatus } from '../shared/auth';
import { validateNewPassword } from '../shared/password-policy';
import { assertSecureTransport, HTTPS_REQUIRED_MESSAGE, isSecureTransport } from './secure-transport';

export const SESSION_EXPIRED_EVENT = 'lumina:session-expired';
class AuthRequestError extends Error {
  constructor(message: string, readonly retryAfterSeconds: number) { super(message); }
}

function useRetryCooldown(scope: string) {
  const key = `lumina:auth-cooldown:${scope}`;
  const [until, setUntil] = useState(() => {
    try { const value = Number(sessionStorage.getItem(key)); return Number.isFinite(value) && value > Date.now() && value <= Date.now() + 86400000 ? value : 0; } catch { return 0; }
  });
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!until) return;
    const tick = () => {
      const current = Date.now(); setNow(current);
      if (current >= until) { setUntil(0); try { sessionStorage.removeItem(key); } catch { /* Storage can be disabled. */ } }
    };
    tick(); const timer = setInterval(tick, 1000);
    window.addEventListener('focus', tick);
    return () => { clearInterval(timer); window.removeEventListener('focus', tick); };
  }, [until, key]);
  const applyError = (error: unknown) => {
    if (error instanceof AuthRequestError && error.retryAfterSeconds > 0) {
      const current = Date.now(); const next = current + error.retryAfterSeconds * 1000;
      setNow(current); setUntil(next);
      try { sessionStorage.setItem(key, String(next)); } catch { /* Server limits still apply without browser storage. */ }
    }
  };
  return { seconds: Math.max(0, Math.ceil((until - now) / 1000)), applyError };
}

function CooldownNotice({ seconds }: { seconds: number }) {
  return seconds > 0 ? <div className="auth-cooldown"><Clock3 size={18}/><span>尝试次数较多，请在 <strong>{seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`}</strong> 后重试。</span></div> : null;
}

async function authRequest(path: string, body?: object, signal?: AbortSignal): Promise<AuthStatus> {
  assertSecureTransport();
  const response = await fetch(`/api/auth/${path}`, {
    method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path === 'password') window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    const delay = Math.max(Number(response.headers.get('Retry-After')) || 0, Number(result.retryAfterSeconds) || 0);
    throw new AuthRequestError(result.error || '暂时无法连接，请稍后重试', Number.isFinite(delay) ? Math.min(86400, Math.max(0, Math.ceil(delay))) : 0);
  }
  return result;
}

export function AuthGate({ children }: { children: (user: { username: string; userId: number; role: 'admin' | 'viewer' }, logout: () => Promise<void>) => ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState('');
  const revision = useRef(0);
  const pendingStatus = useRef<AbortController | null>(null);
  const acceptStatus = useCallback((next: AuthStatus) => {
    revision.current++; setStatus(next); setError('');
    if (next.authenticated) { try { sessionStorage.removeItem('lumina:auth-cooldown:login'); sessionStorage.removeItem('lumina:auth-cooldown:setup'); } catch { /* Optional UI state only. */ } }
  }, []);
  const refresh = useCallback(async () => {
    if (!isSecureTransport(window.location)) { setError(HTTPS_REQUIRED_MESSAGE); return; }
    pendingStatus.current?.abort();
    const controller = new AbortController(); pendingStatus.current = controller;
    const request = ++revision.current;
    try { const next = await authRequest('status', undefined, controller.signal); if (request === revision.current) { setStatus(next); setError(''); } }
    catch { if (!controller.signal.aborted && request === revision.current) setError('暂时无法连接图库，请确认图库服务正在运行。'); }
  }, []);
  useEffect(() => {
    void refresh();
    const expired = () => { acceptStatus({ configured: true, authenticated: false, setupAllowed: false }); void refresh(); };
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener(SESSION_EXPIRED_EVENT, expired);
    window.addEventListener('focus', visible);
    window.addEventListener('pageshow', visible);
    document.addEventListener('visibilitychange', visible);
    const timer = setInterval(visible, 60000);
    return () => { revision.current++; pendingStatus.current?.abort(); clearInterval(timer); window.removeEventListener(SESSION_EXPIRED_EVENT, expired); window.removeEventListener('focus', visible); window.removeEventListener('pageshow', visible); document.removeEventListener('visibilitychange', visible); };
  }, [acceptStatus, refresh]);
  const logout = async () => { acceptStatus(await authRequest('logout', {})); };
  if (status?.authenticated) return children({ username: status.username || '', userId: status.userId ?? 0, role: status.role ?? 'viewer' }, logout);
  return <div className="auth-page"><div className="auth-brand"><span className="brand-icon"><Aperture size={28}/></span><span>拾光<small>LUMINA</small></span></div>
    <main className="auth-shell"><section className="auth-intro"><div className="auth-overline">YOUR PRIVATE GALLERY</div><h1>把喜欢的瞬间，<br/>留给自己<span>。</span></h1><p>一处安放光影的私人空间。<br/>登录之后，继续你的收藏。</p><div className="auth-art" aria-hidden="true"><div className="auth-orbit"/><div className="auth-art-card"><Aperture size={74} strokeWidth={1}/><span>光影 · 灵感 · 收藏</span></div><span className="auth-art-lock"><LockKeyhole size={22}/></span></div><div className="auth-intro-foot"><ShieldCheck size={18}/>登录后访问 · 原图保存在本机</div></section>
    <section className="auth-card" aria-label="图库登录">
      {!status ? <div className="auth-connecting">{error ? <><CircleAlert size={32}/><h2>{isSecureTransport(window.location) ? '暂时无法连接' : '需要安全连接'}</h2><p role="alert">{error}</p>{isSecureTransport(window.location) ? <button className="button primary" onClick={() => { setError(''); void refresh(); }}>重新连接</button> : <a className="button primary" href={new URL(window.location.href.replace(/^http:/, 'https:')).href}>使用 HTTPS 打开</a>}</> : <><LoaderCircle className="spin" size={28}/><p role="status">正在连接你的图库…</p></>}</div> : <LoginForm key={String(status.configured)} status={status} onSuccess={acceptStatus}/>}
    </section></main><footer className="auth-footer">拾光 · 用图片，收藏生活</footer></div>;
}

export function PasswordField({ label, value, onChange, autoComplete = 'current-password', minLength, hint }: { label: string; value: string; onChange: (value: string) => void; autoComplete?: string; minLength?: number; hint?: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => { if (!value) setVisible(false); }, [value]);
  const id = label.replaceAll(' ', '-');
  return <div className="auth-field"><label htmlFor={id}>{label}</label><div className="password-input"><input id={id} name={id} type={visible ? 'text' : 'password'} autoComplete={autoComplete} value={value} onChange={e => onChange(e.target.value)} required minLength={minLength} maxLength={PASSWORD_MAX_LENGTH} aria-describedby={hint ? `${id}-hint` : undefined}/><button type="button" aria-label={`${visible ? '隐藏' : '显示'}${label}`} aria-pressed={visible} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={19}/> : <Eye size={19}/>}</button></div>{hint && <small id={`${id}-hint`}>{hint}</small>}</div>;
}

function LoginForm({ status, onSuccess }: { status: AuthStatus; onSuccess: (value: AuthStatus) => void }) {
  const setup = !status.configured;
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const cooldown = useRetryCooldown(setup ? 'setup' : 'login');
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (busy || cooldown.seconds > 0) return;
    if (setup && password !== confirm) { setError('两次输入的密码不一致，请重新确认。'); return; }
    if (setup) { try { validateNewPassword(password, username.trim()); } catch (err) { setError((err as Error).message); return; } }
    setBusy(true); setError('');
    try { onSuccess(await authRequest(setup ? 'setup' : 'login', { username: username.trim(), password })); }
    catch (err) { setError((err as Error).message); cooldown.applyError(err); }
    finally { setPassword(''); setConfirm(''); setBusy(false); }
  }
  return <><span className="auth-key"><KeyRound size={24}/></span><div className="auth-card-heading"><span>{setup ? '初次见面' : '欢迎回来'}</span><h2>{setup ? '设置图库登录' : '登录你的图库'}</h2><p>{setup ? '创建你的管理员账号。已有图集会完整保留。' : '输入账号和密码，打开你的私人收藏。'}</p></div>
    {setup && !status.setupAllowed ? <div className="auth-local-note" role="status"><LockKeyhole size={22}/><p>请在运行图库的电脑上打开本地地址，完成首次账号设置。</p></div> : <form onSubmit={e => void submit(e)}>
      <fieldset disabled={busy} className="auth-fields"><div className="auth-field"><label htmlFor="gallery-username">账号</label><input id="gallery-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={e => setUsername(e.target.value)} required minLength={2} maxLength={40} placeholder={setup ? '设置一个账号名称' : '请输入账号'}/></div>
      <PasswordField label="密码" value={password} onChange={setPassword} autoComplete={setup ? 'new-password' : 'current-password'} minLength={setup ? PASSWORD_MIN_LENGTH : undefined} hint={setup ? `至少 ${PASSWORD_MIN_LENGTH} 个字符；建议使用独有的长密码或短语` : undefined}/>
      {setup && <PasswordField label="确认密码" value={confirm} onChange={setConfirm} autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH}/>}
      {error && <div className="auth-error" role="alert"><CircleAlert size={17}/><span>{error}</span></div>}
      <CooldownNotice seconds={cooldown.seconds}/>
      <button className="button primary auth-submit" type="submit" disabled={cooldown.seconds > 0}>{busy ? <LoaderCircle size={19} className="spin"/> : null}{busy ? '请稍候…' : cooldown.seconds > 0 ? '稍后重试' : setup ? '创建账号并进入图库' : '登录图库'}{!busy && !cooldown.seconds && <ArrowRight size={18}/>}</button></fieldset>
    </form>}
    <p className="auth-session-note"><ShieldCheck size={16}/><span>已启用登录尝试保护 · 会话有效期 {SESSION_HOURS} 小时</span></p></>;
}

export function AccountForm({ username, onSaved, onBusyChange, disabled = false }: { username: string; onSaved: () => void; onBusyChange?: (busy: boolean) => void; disabled?: boolean }) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cooldown = useRetryCooldown('password');
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (busy || disabled || cooldown.seconds > 0) return;
    if (password !== confirm) { setError('两次输入的新密码不一致。'); return; }
    try { validateNewPassword(password, username); } catch (err) { setError((err as Error).message); return; }
    setBusy(true); onBusyChange?.(true); setError('');
    try { await authRequest('password', { currentPassword: current, newPassword: password }); setCurrent(''); setPassword(''); setConfirm(''); onSaved(); }
    catch (err) { setError((err as Error).message); cooldown.applyError(err); }
    finally { setCurrent(''); setPassword(''); setConfirm(''); setBusy(false); onBusyChange?.(false); }
  }
  return <form className="account-form" onSubmit={e => void submit(e)}><fieldset disabled={busy || disabled} className="auth-fields"><div className="auth-field"><label htmlFor="account-username">当前账号</label><input id="account-username" name="username" autoComplete="username" value={username} readOnly/></div>
    <PasswordField label="当前密码" value={current} onChange={setCurrent}/><PasswordField label="新密码" value={password} onChange={setPassword} autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} hint={`至少 ${PASSWORD_MIN_LENGTH} 个字符；请勿使用其他网站的密码`}/><PasswordField label="确认新密码" value={confirm} onChange={setConfirm} autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH}/>
    <p className="account-note">修改后，其他已登录的浏览器需要重新登录。</p>{error && <div className="auth-error" role="alert"><CircleAlert size={17}/><span>{error}</span></div>}<CooldownNotice seconds={cooldown.seconds}/><button className="button primary auth-submit" type="submit" disabled={cooldown.seconds > 0}>{busy && <LoaderCircle size={18} className="spin"/>}{busy ? '正在保存…' : cooldown.seconds > 0 ? '稍后重试' : '保存新密码'}</button></fieldset></form>;
}
