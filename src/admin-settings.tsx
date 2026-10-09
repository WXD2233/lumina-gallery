import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Check, CircleAlert, Eye, EyeOff, KeyRound, LoaderCircle, Mail, Pencil, Plus, RefreshCw, Send, ShieldCheck, Trash2, UserRound, X } from 'lucide-react';
import type { SecurityEvent, SecuritySettings } from '../shared/security';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, type AdminUser } from '../shared/auth';
import { validateNewPassword } from '../shared/password-policy';
import { api } from './api';
import './admin-settings.css';

type PanelProps = { toast: (message: string) => void; onBusyChange: (busy: boolean) => void; disabled?: boolean; active?: boolean };
type UserDraft = { username: string; role: AdminUser['role']; disabled: boolean; password: string; confirmation: string; resetPassword: boolean };
const emptyUser = (): UserDraft => ({ username: '', role: 'viewer', disabled: false, password: '', confirmation: '', resetPassword: false });

function dateLabel(value: string | null) {
  if (!value) return '尚未登录';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '时间未知' : date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function ErrorNotice({ message }: { message: string }) {
  return message ? <div className="form-error admin-error" role="alert"><CircleAlert size={18}/><span>{message}</span></div> : null;
}

function SecretField({ label, value, onChange, hint, required = false, minLength }: { label: string; value: string; onChange: (value: string) => void; hint?: string; required?: boolean; minLength?: number }) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  useEffect(() => { if (!value) setVisible(false); }, [value]);
  return <div className="auth-field"><label htmlFor={id}>{label}</label><div className="password-input"><input id={id} name={id} type={visible ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} value={value} onChange={event => onChange(event.target.value)} required={required} minLength={minLength} maxLength={minLength ? PASSWORD_MAX_LENGTH : 1024} aria-describedby={hint ? `${id}-hint` : undefined}/><button type="button" aria-label={`${visible ? '隐藏' : '显示'}${label}`} aria-pressed={visible} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={19}/> : <Eye size={19}/>}</button></div>{hint && <small id={`${id}-hint`}>{hint}</small>}</div>;
}

export function AccountManagement({ currentUserId, toast, onBusyChange, disabled = false, active = true }: PanelProps & { currentUserId: number }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<AdminUser | 'new' | null>(null);
  const [draft, setDraft] = useState<UserDraft>(emptyUser);
  const [deleting, setDeleting] = useState<AdminUser | null>(null);
  const [deleteName, setDeleteName] = useState('');
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const locked = busy || disabled;

  const reload = useCallback(async () => {
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    setLoading(true); setLoadError('');
    try { const result = await api<AdminUser[]>('/admin/users', { signal: request.signal }); if (!request.signal.aborted) setUsers(result); }
    catch (err) { if (!request.signal.aborted) setLoadError((err as Error).message); }
    finally { if (!request.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => { void reload(); return () => controller.current?.abort(); }, [reload]);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  useEffect(() => { if (!active) setDraft(previous => ({ ...previous, password: '', confirmation: '' })); }, [active]);

  function openEditor(user: AdminUser | 'new') {
    if (locked || (user !== 'new' && user.id === currentUserId)) return;
    setDeleting(null); setError(''); setEditing(user);
    setDraft(user === 'new' ? emptyUser() : { username: user.username, role: user.role, disabled: user.disabled, password: '', confirmation: '', resetPassword: false });
  }
  function closeEditor() { setEditing(null); setDraft(emptyUser()); setError(''); }

  async function save(event: FormEvent) {
    event.preventDefault(); if (locked || !editing) return;
    setError('');
    const username = draft.username.trim();
    const withPassword = editing === 'new' || draft.resetPassword;
    try {
      if (username.length < 2 || username.length > 40) throw new Error('账户名需要 2–40 个字符');
      if (withPassword) {
        validateNewPassword(draft.password, username);
        if (draft.password !== draft.confirmation) throw new Error('两次输入的密码不一致');
      }
    } catch (err) { setError((err as Error).message); return; }
    setBusy(true);
    try {
      const value = await api<AdminUser>(editing === 'new' ? '/admin/users' : `/admin/users/${editing.id}`, {
        method: editing === 'new' ? 'POST' : 'PATCH',
        body: JSON.stringify({ username, role: draft.role, ...(editing === 'new' ? {} : { disabled: draft.disabled }), ...(withPassword ? { password: draft.password } : {}) }),
      });
      setUsers(previous => editing === 'new' ? [...previous, value] : previous.map(user => user.id === value.id ? value : user));
      toast(editing === 'new' ? '账户已创建' : '账户已更新'); closeEditor();
    } catch (err) { setError((err as Error).message); }
    finally { setDraft(previous => ({ ...previous, password: '', confirmation: '' })); setBusy(false); }
  }

  async function remove(event: FormEvent) {
    event.preventDefault(); if (locked || !deleting || deleting.id === currentUserId || deleteName !== deleting.username) return;
    setBusy(true); setError('');
    try {
      await api(`/admin/users/${deleting.id}`, { method: 'DELETE' });
      setUsers(previous => previous.filter(user => user.id !== deleting.id));
      setDeleting(null); setDeleteName(''); toast('账户已删除，相关登录已退出');
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  const editor = editing && <form className="admin-editor" onSubmit={event => void save(event)} autoComplete="off">
    <div className="admin-card-heading"><h4>{editing === 'new' ? '添加账户' : `修改账户 · ${editing.username}`}</h4><button type="button" className="icon-button" aria-label="取消编辑账户" disabled={locked} onClick={closeEditor}><X size={18}/></button></div>
    <fieldset className="auth-fields" disabled={locked}>
      <label className="field">账户名<input autoComplete="off" required minLength={2} maxLength={40} value={draft.username} onChange={event => setDraft({ ...draft, username: event.target.value })}/></label>
      <label className="field">账户权限<select value={draft.role} onChange={event => setDraft({ ...draft, role: event.target.value as AdminUser['role'] })}><option value="viewer">普通账户 · 查看与下载</option><option value="admin">管理员 · 管理图库和账户</option></select></label>
      <p className="admin-hint">{draft.role === 'admin' ? '管理员可修改图库、管理其他账户和邮件提醒，请仅授予可信任的人。' : '普通账户可查看图片、下载原图和打开网盘链接，不能修改图库或管理账户。'}</p>
      {editing !== 'new' && <><label className="admin-check"><input type="checkbox" checked={draft.disabled} onChange={event => setDraft({ ...draft, disabled: event.target.checked })}/><span>停用此账户<small>保存后，该账户无法登录，现有登录也会退出。</small></span></label><label className="admin-check"><input type="checkbox" checked={draft.resetPassword} onChange={event => setDraft({ ...draft, resetPassword: event.target.checked, password: '', confirmation: '' })}/><span>重设登录密码<small>仅在需要重设时填写，不会显示原密码。</small></span></label></>}
      {(editing === 'new' || draft.resetPassword) && <div className="admin-password-fields"><SecretField label={editing === 'new' ? '初始密码' : '重设密码'} value={draft.password} onChange={password => setDraft({ ...draft, password })} required minLength={PASSWORD_MIN_LENGTH} hint="至少 15 个字符，请使用独立的长密码。"/><SecretField label="再次输入账户密码" value={draft.confirmation} onChange={confirmation => setDraft({ ...draft, confirmation })} required minLength={PASSWORD_MIN_LENGTH}/>{editing !== 'new' && <p className="admin-hint">重设后，此账户需要使用新密码重新登录。</p>}</div>}
      <ErrorNotice message={error}/>
      <div className="admin-form-actions"><button type="button" className="button" onClick={closeEditor}>取消</button><button type="submit" className="button primary">{busy ? <LoaderCircle className="spin" size={17}/> : <Check size={17}/>} {busy ? '正在保存…' : editing === 'new' ? '创建账户' : '保存账户'}</button></div>
    </fieldset>
  </form>;

  return <div className="admin-settings-panel">
    <div className="settings-section-heading"><h3>账户管理</h3><p>为家人或朋友添加账户，按需设置访问权限。</p></div>
    <div className="admin-role-note"><ShieldCheck size={21}/><p>普通账户仅查看和下载；管理员可以修改图库、管理账户。所有账户访问同一份图库。</p></div>
    <div className="admin-toolbar"><span>{loading ? '正在读取账户…' : `共 ${users.length} 个账户`}</span><div><button type="button" className="icon-button" aria-label="刷新账户列表" title="刷新账户列表" disabled={locked || loading || !!editing || !!deleting} onClick={() => void reload()}><RefreshCw size={18} className={loading ? 'spin' : ''}/></button><button type="button" className="button primary" disabled={locked || loading || !!editing || !!deleting} onClick={() => openEditor('new')}><Plus size={17}/>添加账户</button></div></div>
    {loadError && <div className="admin-load-error"><ErrorNotice message={loadError}/><button type="button" className="button" disabled={locked || loading} onClick={() => void reload()}>重新读取</button></div>}
    {editing === 'new' && editor}
    <div className="admin-user-list" aria-busy={loading}>{users.map(user => <article className="admin-user-card" key={user.id}>
      <div className="admin-user-header"><span className={`admin-user-icon ${user.role}`} aria-hidden="true">{user.role === 'admin' ? <ShieldCheck size={21}/> : <UserRound size={21}/>}</span><div className="admin-user-name"><strong>{user.username}</strong><div className="admin-user-badges"><span className={`admin-badge ${user.role}`}>{user.role === 'admin' ? '管理员' : '普通账户'}</span>{user.id === currentUserId && <span className="admin-badge">当前账户</span>}{user.disabled && <span className="admin-badge disabled">已停用</span>}</div></div>{user.id !== currentUserId && <div className="admin-user-actions"><button type="button" className="icon-button" aria-label={`修改账户 ${user.username}`} title="修改账户" disabled={locked || !!editing || !!deleting} onClick={() => openEditor(user)}><Pencil size={18}/></button><button type="button" className="icon-button admin-delete" aria-label={`删除账户 ${user.username}`} title="删除账户" disabled={locked || !!editing || !!deleting} onClick={() => { setDeleting(user); setDeleteName(''); setError(''); }}><Trash2 size={18}/></button></div>}</div>
      <div className="admin-user-dates"><span>创建：{dateLabel(user.createdAt)}</span><span>上次登录：{dateLabel(user.lastLoginAt)}</span></div>
      {user.id === currentUserId && <p className="admin-hint admin-self-note">当前账户的头像和密码，请在“账户与头像”中修改。</p>}
      {editing !== 'new' && editing?.id === user.id && editor}
      {deleting?.id === user.id && <form className="admin-delete-confirm" onSubmit={event => void remove(event)}><fieldset className="auth-fields" disabled={locked}><h4>删除“{user.username}”？</h4><p>此账户和头像将被删除，已登录的设备会退出。图库中的图片会保留。</p><label className="field">输入账户名以确认<input autoComplete="off" required value={deleteName} onChange={event => setDeleteName(event.target.value)} placeholder={user.username}/></label><ErrorNotice message={error}/><div className="admin-form-actions"><button type="button" className="button" onClick={() => { setDeleting(null); setDeleteName(''); setError(''); }}>取消</button><button type="submit" className="button danger" disabled={deleteName !== user.username}>{busy ? <LoaderCircle className="spin" size={17}/> : <Trash2 size={17}/>} {busy ? '正在删除…' : '确认删除账户'}</button></div></fieldset></form>}
    </article>)}</div>
    {!loading && !loadError && users.length === 0 && <p className="admin-empty">暂无账户，请刷新后重试。</p>}
  </div>;
}

type SecurityDraft = SecuritySettings & { password: string; clearPassword: boolean; recipients: string };
function securityDraft(value: SecuritySettings): SecurityDraft { return { ...value, password: '', clearPassword: false, recipients: value.to.join('\n') }; }
function settingsChanged(draft: SecurityDraft | null, saved: SecuritySettings | null) { return !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(securityDraft(saved)); }
const eventLabels: Record<SecurityEvent['type'], string> = { login_success: '登录成功', login_blocked: '登录受限', account_changed: '账户变更', backup_warning: '备份空间不足', backup_failure: '备份停止或失败', backup_recovered: '备份已恢复', test: '测试邮件' };
const deliveryLabels: Record<SecurityEvent['status'], string> = { disabled: '提醒未启用', pending: '等待发送', sent: '已发送邮件', failed: '发送失败', skipped: '未发送邮件' };

export function SecurityNotifications({ toast, onBusyChange, disabled = false, active = true }: PanelProps) {
  const [saved, setSaved] = useState<SecuritySettings | null>(null);
  const [draft, setDraft] = useState<SecurityDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [testResult, setTestResult] = useState('');
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState('');
  const settingsController = useRef<AbortController | null>(null);
  const eventsController = useRef<AbortController | null>(null);
  const locked = !!busy || disabled;
  const dirty = settingsChanged(draft, saved);

  const loadSettings = useCallback(async () => {
    settingsController.current?.abort(); const request = new AbortController(); settingsController.current = request;
    setLoading(true); setLoadError('');
    try { const value = await api<SecuritySettings>('/admin/security/settings', { signal: request.signal }); if (!request.signal.aborted) { setSaved(value); setDraft(securityDraft(value)); } }
    catch (err) { if (!request.signal.aborted) setLoadError((err as Error).message); }
    finally { if (!request.signal.aborted) setLoading(false); }
  }, []);
  const loadEvents = useCallback(async () => {
    eventsController.current?.abort(); const request = new AbortController(); eventsController.current = request;
    setEventsLoading(true); setEventsError('');
    try { const value = await api<SecurityEvent[]>('/admin/security/events', { signal: request.signal }); if (!request.signal.aborted) setEvents(value); }
    catch (err) { if (!request.signal.aborted) setEventsError((err as Error).message); }
    finally { if (!request.signal.aborted) setEventsLoading(false); }
  }, []);
  useEffect(() => { void loadSettings(); void loadEvents(); return () => { settingsController.current?.abort(); eventsController.current?.abort(); }; }, [loadSettings, loadEvents]);
  useEffect(() => { onBusyChange(!!busy); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  useEffect(() => { if (!active) setDraft(previous => previous ? { ...previous, password: '' } : previous); }, [active]);

  async function save(event: FormEvent) {
    event.preventDefault(); if (locked || !draft) return;
    setError(''); setTestResult('');
    const to = [...new Set(draft.recipients.split(/[\n,;，；]+/).map(value => value.trim()).filter(Boolean))];
    if (draft.enabled && (!draft.host.trim() || !draft.username.trim() || !draft.from.trim() || to.length === 0 || (!draft.password && (!draft.hasPassword || draft.clearPassword)))) { setError('开启提醒前，请填写 SMTP 服务器、发信账户、授权码、发件邮箱和收件邮箱。'); return; }
    if (to.some(value => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) { setError('请检查收件邮箱格式，每行填写一个邮箱地址。'); return; }
    setBusy('save');
    try {
      const value = await api<SecuritySettings>('/admin/security/settings', { method: 'PATCH', body: JSON.stringify({ enabled: draft.enabled, host: draft.host.trim(), port: draft.port, secure: draft.secure, username: draft.username.trim(), from: draft.from.trim(), to, notifyNewSourceLogin: draft.notifyNewSourceLogin, notifyBruteForce: draft.notifyBruteForce, ...(draft.password ? { password: draft.password } : {}), ...(draft.clearPassword ? { clearPassword: true } : {}) }) });
      setSaved(value); setDraft(securityDraft(value)); toast('邮件提醒设置已保存');
    } catch (err) { setError((err as Error).message); }
    finally { setDraft(previous => previous ? { ...previous, password: '' } : previous); setBusy(null); }
  }

  async function test() {
    if (locked || dirty || !saved) return;
    setError(''); setTestResult(''); setBusy('test');
    try {
      const value = await api<{ ok: boolean; message: string }>('/admin/security/test', { method: 'POST' });
      setTestResult(value.message || '测试邮件已发送，请检查收件箱。'); toast(value.message || '测试邮件已发送');
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); void loadEvents(); }
  }

  const canTest = saved && saved.host && saved.username && saved.hasPassword && saved.from && saved.to.length > 0;
  return <div className="admin-settings-panel">
    <div className="settings-section-heading"><h3>安全与邮件提醒</h3><p>新来源登录、暴力破解防护或自动备份异常时，通过邮件提醒管理员。</p></div>
    {loading && <p className="admin-loading" role="status"><LoaderCircle size={18} className="spin"/>正在读取提醒设置…</p>}
    {loadError && <div className="admin-load-error"><ErrorNotice message={loadError}/><button type="button" className="button" disabled={locked || loading} onClick={() => void loadSettings()}>重新读取</button></div>}
    {draft && <form onSubmit={event => void save(event)} autoComplete="off"><fieldset className="auth-fields" disabled={locked}>
      <div className="admin-notify-enable"><div><h4><Mail size={20}/>邮件提醒</h4><p>{saved?.enabled ? '当前已开启邮件提醒' : '当前未开启邮件提醒'}</p></div><button type="button" className={`toggle ${draft.enabled ? 'on' : ''}`} role="switch" aria-checked={draft.enabled} aria-label="启用邮件提醒" onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}><span/></button></div>
      <div className="admin-notify-options"><label className="admin-check"><input type="checkbox" checked={draft.notifyNewSourceLogin} onChange={event => setDraft({ ...draft, notifyNewSourceLogin: event.target.checked })}/><span>仅新来源登录成功时提醒<small>按登录来源 IP 判断；同一来源的日常登录不重复提醒，同一网络中的设备可能共用来源。</small></span></label><label className="admin-check"><input type="checkbox" checked={draft.notifyBruteForce} onChange={event => setDraft({ ...draft, notifyBruteForce: event.target.checked })}/><span>暴力破解或连续失败时提醒<small>触发登录防护后发送；重复攻击会合并提醒，减少打扰。</small></span></label></div>
      <div className="admin-smtp-heading"><KeyRound size={18}/><h4>发信邮箱</h4></div>
      <label className="field">SMTP 服务器<input value={draft.host} onChange={event => setDraft({ ...draft, host: event.target.value })} autoComplete="off" placeholder="例如 smtp.example.com" maxLength={253} required={draft.enabled}/></label>
      <label className="field">加密连接<select value={draft.secure ? 'tls' : 'starttls'} onChange={event => setDraft({ ...draft, secure: event.target.value === 'tls', port: event.target.value === 'tls' ? 465 : 587 })}><option value="tls">SSL / TLS · 端口 465</option><option value="starttls">STARTTLS · 端口 587</option></select><small className="admin-hint">按邮箱服务商的 SMTP 设置选择，连接始终使用加密。</small></label>
      <label className="field">SMTP 登录账户<input value={draft.username} onChange={event => setDraft({ ...draft, username: event.target.value })} autoComplete="off" placeholder="通常为完整邮箱地址" required={draft.enabled} maxLength={254}/></label>
      <SecretField label="邮箱授权码或 SMTP 密码" value={draft.password} onChange={password => setDraft({ ...draft, password, clearPassword: false })} required={draft.enabled && (!draft.hasPassword || draft.clearPassword)} hint={draft.hasPassword ? '已保存，留空保持不变。填写新的授权码可替换。' : '填写邮箱服务商提供的 SMTP 授权码，不会在页面回显。'}/>
      {draft.hasPassword && <label className="admin-check admin-clear-secret"><input type="checkbox" checked={draft.clearPassword} onChange={event => setDraft({ ...draft, clearPassword: event.target.checked, password: '' })}/><span>清除已保存的授权码<small>清除后如需启用提醒，需要填写新的授权码。</small></span></label>}
      <label className="field">发件邮箱<input type="email" value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })} autoComplete="off" placeholder="与服务商允许的发件地址保持一致" required={draft.enabled} maxLength={254}/></label>
      <label className="field">收件邮箱<textarea rows={3} value={draft.recipients} onChange={event => setDraft({ ...draft, recipients: event.target.value })} placeholder="每行一个邮箱，可填写多个管理员邮箱" autoComplete="off" required={draft.enabled} maxLength={4000}/><small className="admin-hint">也可用逗号或分号分隔。安全提醒和测试邮件均发送到这里。</small></label>
      <ErrorNotice message={error}/>
      {testResult && <div className="admin-success" role="status"><Check size={18}/><span>{testResult}</span></div>}
      <div className="admin-form-actions admin-mail-actions"><button type="button" className="button" disabled={dirty || !canTest} onClick={() => void test()} title={dirty ? '请先保存修改后再发送测试邮件' : '向已保存的收件邮箱发送一封测试邮件'}>{busy === 'test' ? <LoaderCircle className="spin" size={17}/> : <Send size={17}/>} {busy === 'test' ? '正在发送…' : '发送测试邮件'}</button><button type="submit" className="button primary" disabled={!dirty}>{busy === 'save' ? <LoaderCircle className="spin" size={17}/> : <Check size={17}/>} {busy === 'save' ? '正在保存…' : '保存提醒设置'}</button></div>
      <p className="admin-hint admin-test-hint">{dirty ? '有尚未保存的修改，请先保存再发送测试邮件。' : canTest ? `测试邮件将发送至：${saved?.to.join('、')}。每分钟最多测试一次。` : '保存完整的发信与收件信息后，可发送测试邮件确认配置。'}</p>
    </fieldset></form>}
    <section className="admin-security-events" aria-label="最近安全记录"><div className="admin-card-heading"><div><h4>最近安全记录</h4><p>查看登录、账户操作和邮件发送结果。</p></div><button type="button" className="button" disabled={locked || eventsLoading} onClick={() => void loadEvents()}><RefreshCw size={16} className={eventsLoading ? 'spin' : ''}/>{eventsLoading ? '读取中…' : '刷新记录'}</button></div>
      <ErrorNotice message={eventsError}/>
      {events.length > 0 ? <ol className="admin-event-list" aria-busy={eventsLoading}>{events.map(event => <li key={event.id}><div className="admin-event-heading"><strong>{event.type === 'login_success' && event.newSource ? '新来源登录' : eventLabels[event.type]}</strong><span className={`admin-delivery ${event.status}`}>{deliveryLabels[event.status]}</span></div><p className="admin-event-detail">{event.detail}</p><div className="admin-event-meta"><time dateTime={event.createdAt}>{dateLabel(event.createdAt)}</time>{event.username && <span>账户：{event.username}</span>}{event.source && <span>来源：{event.source}</span>}</div>{event.error && <p className="admin-event-error"><CircleAlert size={15}/><span>{event.error}</span></p>}</li>)}</ol> : !eventsLoading && !eventsError ? <p className="admin-empty">还没有安全记录，后续事件会显示在这里。</p> : null}
      <p className="admin-hint">邮件发送需要服务保持运行且发信配置有效；发送失败的原因会显示在记录中。</p>
    </section>
  </div>;
}
