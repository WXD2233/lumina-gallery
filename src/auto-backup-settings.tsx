import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Archive, ArrowRight, Check, CircleAlert, Clock3, Download, HardDrive, LoaderCircle, Mail, RefreshCw, Server, UploadCloud } from 'lucide-react';
import type { AutoBackupPhase, AutoBackupSettingsInput, AutoBackupStatus, WebDavSettingsInput } from '../shared/auto-backup';
import { api } from './api';
import './auto-backup-settings.css';

type Props = {
  toast: (message: string) => void;
  onBusyChange: (busy: boolean) => void;
  disabled?: boolean;
  active?: boolean;
  onOpenSecurity?: () => void;
};
type Draft = Required<AutoBackupSettingsInput>;
type WebDavDraft = Omit<WebDavSettingsInput, 'password' | 'clearPassword'> & { password: string };
const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const phaseLabels: Record<AutoBackupPhase, string> = { idle: '等待计划', running: '正在备份', waiting_space: '等待释放空间', blocked: '备份已停止', failed: '备份失败', success: '备份已完成' };
const toDraft = (value: AutoBackupStatus): Draft => ({ enabled: value.settings.enabled, weekday: value.settings.weekday, time: value.settings.time });
const toWebDavDraft = (value: AutoBackupStatus): WebDavDraft => ({ enabled: value.webdav?.enabled ?? false, url: value.webdav?.url ?? '', username: value.webdav?.username ?? '', password: '' });

function dateLabel(value: string | null, fallback = '暂无') {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '时间未知' : date.toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function byteLabel(value: number | null) {
  if (value === null || !Number.isFinite(value) || value < 0) return '暂时无法读取';
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let size = value / 1024, index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
  return `${size.toFixed(size < 10 ? 2 : 1)} ${units[index]}`;
}

export function AutoBackupSettingsPanel({ toast, onBusyChange, disabled = false, active = true, onOpenSecurity }: Props) {
  const [status, setStatus] = useState<AutoBackupStatus | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'save' | 'run' | 'webdav-save' | 'webdav-test' | null>(null);
  const [webdavDraft, setWebdavDraft] = useState<WebDavDraft | null>(null);
  const statusRef = useRef<AutoBackupStatus | null>(null);
  const readController = useRef<AbortController | null>(null);
  const writeController = useRef<AbortController | null>(null);
  const mutation = useRef(false);
  const locked = !!busy || disabled;
  const running = !!status?.running;
  const dirty = !!status && !!draft && JSON.stringify(draft) !== JSON.stringify(toDraft(status));
  const webdavDirty = !!status && !!webdavDraft && (webdavDraft.enabled !== (status.webdav?.enabled ?? false) || webdavDraft.url !== (status.webdav?.url ?? '') || webdavDraft.username !== (status.webdav?.username ?? '') || !!webdavDraft.password);

  const applyStatus = useCallback((value: AutoBackupStatus) => {
    statusRef.current = value; setStatus(value); setDraft(previous => previous ?? toDraft(value)); setWebdavDraft(previous => previous ?? toWebDavDraft(value)); setLoadError('');
  }, []);

  const refresh = useCallback(async (showLoading = false) => {
    if (readController.current || mutation.current) return;
    const controller = new AbortController(); readController.current = controller;
    if (showLoading) setLoading(true);
    try {
      const value = await api<AutoBackupStatus>('/admin/auto-backups', { signal: controller.signal });
      if (!controller.signal.aborted) applyStatus(value);
    } catch (err) { if (!controller.signal.aborted) setLoadError((err as Error).message); }
    finally {
      if (readController.current === controller) readController.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [applyStatus]);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let polling = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (stopped || polling) return;
      polling = true; clearTimeout(timer);
      try { if (!document.hidden) await refresh(); }
      finally { polling = false; if (!stopped) timer = setTimeout(() => void poll(), statusRef.current?.running ? 5000 : 30000); }
    };
    const resume = () => { if (!document.hidden) { clearTimeout(timer); void poll(); } };
    void poll(); document.addEventListener('visibilitychange', resume);
    return () => { stopped = true; clearTimeout(timer); readController.current?.abort(); readController.current = null; document.removeEventListener('visibilitychange', resume); };
  }, [active, refresh, running]);
  useEffect(() => { onBusyChange(!!busy); }, [busy, onBusyChange]);
  useEffect(() => () => { readController.current?.abort(); writeController.current?.abort(); onBusyChange(false); }, [onBusyChange]);
  useEffect(() => { if (!active) setWebdavDraft(previous => previous ? { ...previous, password: '' } : previous); }, [active]);

  async function submit(kind: 'save' | 'run', event?: FormEvent) {
    event?.preventDefault();
    if (mutation.current || disabled || !status || !draft || (kind === 'run' && (status.running || dirty))) return;
    if (kind === 'save' && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time) || !Number.isInteger(draft.weekday) || draft.weekday < 0 || draft.weekday > 6)) { setError('请选择每周备份的日期和有效时间。'); return; }
    mutation.current = true; setBusy(kind); setError('');
    readController.current?.abort(); readController.current = null; setLoading(false);
    const controller = new AbortController(); writeController.current = controller;
    try {
      const value = await api<AutoBackupStatus>(kind === 'save' ? '/admin/auto-backups/settings' : '/admin/auto-backups/run', {
        method: kind === 'save' ? 'PATCH' : 'POST', body: JSON.stringify(kind === 'save' ? draft : {}), signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        applyStatus(value);
        if (kind === 'save') setDraft(toDraft(value));
        toast(kind === 'save' ? '自动备份设置已保存' : '已提交备份任务，可在这里查看进度');
        window.dispatchEvent(new Event('auto-backup-updated'));
      }
    } catch (err) { if (!controller.signal.aborted) setError((err as Error).message); }
    finally { mutation.current = false; if (!controller.signal.aborted) setBusy(null); if (writeController.current === controller) writeController.current = null; }
  }

  async function saveWebdav(event: FormEvent) {
    event.preventDefault();
    if (mutation.current || disabled || !webdavDraft || status?.running) return;
    if (webdavDraft.enabled && (!/^https:\/\//i.test(webdavDraft.url) || !webdavDraft.username || (!status?.webdav?.hasPassword && !webdavDraft.password))) { setError('启用 WebDAV 前，请填写 HTTPS 地址、用户名和密码。'); return; }
    mutation.current = true; setBusy('webdav-save'); setError('');
    readController.current?.abort(); readController.current = null; setLoading(false);
    const controller = new AbortController(); writeController.current = controller;
    try {
      const value = await api<AutoBackupStatus>('/admin/auto-backups/webdav', { method: 'PATCH', body: JSON.stringify({
        enabled: webdavDraft.enabled, url: webdavDraft.url, username: webdavDraft.username,
        ...(webdavDraft.password ? { password: webdavDraft.password } : {}),
      }), signal: controller.signal });
      if (!controller.signal.aborted) {
        applyStatus(value); setWebdavDraft(toWebDavDraft(value));
        toast('WebDAV 备份设置已保存'); window.dispatchEvent(new Event('auto-backup-updated'));
      }
    } catch (err) { if (!controller.signal.aborted) setError((err as Error).message); }
    finally { setWebdavDraft(previous => previous ? { ...previous, password: '' } : previous); mutation.current = false; if (!controller.signal.aborted) setBusy(null); if (writeController.current === controller) writeController.current = null; }
  }

  async function testWebdav() {
    if (mutation.current || disabled || !status || !webdavDraft || webdavDirty || !status.webdav?.enabled) { setError('请先保存已启用的 WebDAV 设置，再测试连接。'); return; }
    mutation.current = true; setBusy('webdav-test'); setError('');
    const controller = new AbortController(); writeController.current = controller;
    try {
      await api<{ ok: boolean; message: string }>('/admin/auto-backups/webdav/test', { method: 'POST', body: '{}', signal: controller.signal });
      if (!controller.signal.aborted) toast('WebDAV 连接成功');
    } catch (err) { if (!controller.signal.aborted) setError((err as Error).message); }
    finally { mutation.current = false; if (!controller.signal.aborted) setBusy(null); if (writeController.current === controller) writeController.current = null; }
  }

  return <div className="auto-backup-panel">
    <div className="auto-backup-heading"><div><h4><Archive size={20}/>每周自动备份</h4><p>按计划保存完整 ZIP，包含图集资料和原图。</p></div><button type="button" className="icon-button" aria-label="刷新自动备份状态" title="刷新自动备份状态" disabled={locked || loading} onClick={() => void refresh(true)}><RefreshCw size={18} className={loading ? 'spin' : ''}/></button></div>
    {!status && loading && <p className="auto-backup-loading" role="status"><LoaderCircle size={18} className="spin"/>正在读取备份计划…</p>}
    {loadError && <div className="form-error auto-backup-error" role="alert"><CircleAlert size={18}/><span>{status ? '状态暂时未刷新，以下显示上次读取的结果。' : '无法读取自动备份设置。'}{loadError}</span><button type="button" disabled={locked || loading} onClick={() => void refresh(true)}>重试</button></div>}
    {status && draft && <>
      <form onSubmit={event => void submit('save', event)}><fieldset className="auth-fields" disabled={locked || status.running}>
        <div className="auto-backup-enable"><div><strong>启用每周备份</strong><p>服务运行时自动执行，默认每周日凌晨 03:00。</p></div><button type="button" className={`toggle ${draft.enabled ? 'on' : ''}`} role="switch" aria-checked={draft.enabled} aria-label="启用每周自动备份" onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}><span/></button></div>
        <div className="auto-backup-schedule"><label className="field">备份日期<select value={draft.weekday} onChange={event => setDraft({ ...draft, weekday: Number(event.target.value) })}>{weekdays.map((label, value) => <option value={value} key={value}>{label}</option>)}</select></label><label className="field">备份时间<input type="time" required step="60" value={draft.time} onChange={event => setDraft({ ...draft, time: event.target.value })}/></label></div>
        <p className="auto-backup-hint"><Clock3 size={16}/>时间采用香港时间（UTC+8），与浏览器所在时区无关。</p>
        <div className="auto-backup-save"><span>{dirty ? '计划有未保存的修改' : `保留最近 ${status.settings.retainCount} 份完整备份`}</span><button type="submit" className="button primary" disabled={!dirty || locked || status.running}>{busy === 'save' ? <LoaderCircle className="spin" size={17}/> : <Check size={17}/>} {busy === 'save' ? '正在保存…' : '保存备份计划'}</button></div>
      </fieldset></form>
      <form className="auto-backup-webdav" onSubmit={event => void saveWebdav(event)}>
        <div className="auto-backup-webdav-heading"><div><h4><Server size={19}/>WebDAV 远程备份</h4><p>每次完整备份生成后上传到远程目录，远端仅保留最近 7 份。</p></div><button type="button" className={`toggle ${webdavDraft?.enabled ? 'on' : ''}`} role="switch" aria-checked={!!webdavDraft?.enabled} aria-label="启用 WebDAV 备份" disabled={locked || status.running || !webdavDraft} onClick={() => webdavDraft && setWebdavDraft({ ...webdavDraft, enabled: !webdavDraft.enabled })}><span/></button></div>
        <fieldset className="auth-fields" disabled={locked || status.running || !webdavDraft?.enabled}>
          <label className="field">WebDAV 文件夹地址<input type="url" autoComplete="url" placeholder="https://dav.example.com/remote.php/dav/files/账号/备份" value={webdavDraft?.url ?? ''} onChange={event => webdavDraft && setWebdavDraft({ ...webdavDraft, url: event.target.value })}/></label>
          <label className="field">WebDAV 用户名<input type="text" autoComplete="username" maxLength={254} value={webdavDraft?.username ?? ''} onChange={event => webdavDraft && setWebdavDraft({ ...webdavDraft, username: event.target.value })}/></label>
          <label className="field">WebDAV 密码<input type="password" autoComplete="new-password" maxLength={2048} placeholder={status.webdav?.hasPassword ? '已保存；留空则继续使用当前密码' : '请输入 WebDAV 密码'} value={webdavDraft?.password ?? ''} onChange={event => webdavDraft && setWebdavDraft({ ...webdavDraft, password: event.target.value })}/></label>
        </fieldset>
        <p className="auto-backup-hint">仅支持 HTTPS 和公网可访问的 WebDAV 地址；密码使用服务器密钥加密保存，不会返回浏览器。远程目录需预先创建，并允许列目录、上传和删除；远端清理只会删除本软件命名的 ZIP 文件。</p>
        <div className="auto-backup-webdav-actions"><span>{status.webdav?.enabled ? `已启用 · ${status.webdav.url}` : '未启用'}</span><div><button type="submit" className="button" disabled={locked || status.running || !webdavDirty}>{busy === 'webdav-save' ? <LoaderCircle className="spin" size={17}/> : <Check size={17}/>}保存 WebDAV</button><button type="button" className="button" disabled={locked || status.running || webdavDirty || !status.webdav?.enabled} onClick={() => void testWebdav()}>{busy === 'webdav-test' ? <LoaderCircle className="spin" size={17}/> : <UploadCloud size={17}/>}测试连接</button></div></div>
      </form>
      <div className="auto-backup-policy"><HardDrive size={20}/><p>备份前检查可用空间。空间不足时先提醒管理员，等待 {status.settings.lowSpaceGraceHours} 小时；仍不足则从最旧的备份开始逐份清理，始终至少保留 1 份已有备份。若仍无法备份，会停止并再次提醒。</p></div>
      {status.emailReady !== true && <div className="auto-backup-warning" role="status"><Mail size={20}/><div><strong>邮件提醒尚未就绪</strong><p>请在“安全提醒”中配置 SMTP、授权码和收件邮箱，并启用邮件提醒。未配置时，空间不足仍会显示在页面上，但无法发送邮件。</p>{onOpenSecurity && <button type="button" disabled={locked} onClick={onOpenSecurity}>去配置安全提醒<ArrowRight size={15}/></button>}</div></div>}
      <div className={`auto-backup-status ${status.phase}`} role="status" aria-live="polite"><div className="auto-backup-status-heading">{status.running ? <LoaderCircle size={19} className="spin"/> : ['waiting_space', 'blocked', 'failed'].includes(status.phase) ? <CircleAlert size={19}/> : <Archive size={19}/>}<strong>{status.running ? '正在备份' : !status.settings.enabled && status.phase === 'idle' ? '自动备份已暂停' : phaseLabels[status.phase]}</strong></div><p>{status.message || (status.settings.enabled ? '到达计划时间后自动创建备份。' : '你仍可以手动创建完整备份。')}</p>{status.cleanupAfter && status.phase === 'waiting_space' && <p className="auto-backup-deadline">请在 {dateLabel(status.cleanupAfter)} 前处理；到期后按上述规则清理旧备份。</p>}</div>
      <dl className="auto-backup-stats"><div><dt>下次计划</dt><dd>{dateLabel(status.nextRunAt, status.settings.enabled ? '等待安排' : '已暂停')}</dd></div><div><dt>上次成功</dt><dd>{dateLabel(status.lastSuccessAt, '尚无成功备份')}</dd></div><div><dt>磁盘可用空间（上次检查）</dt><dd>{byteLabel(status.freeBytes)}</dd></div><div><dt>本次所需空间（估算）</dt><dd>{byteLabel(status.requiredBytes)}</dd></div>{status.retryAt && <div><dt>下次重试</dt><dd>{dateLabel(status.retryAt)}</dd></div>}</dl>
      <p className="auto-backup-hint">所需空间已包含 {byteLabel(status.reserveBytes)} 安全余量，以服务器实际检查为准。上次尝试：{dateLabel(status.lastAttemptAt)}。</p>
      {error && <div className="form-error auto-backup-error" role="alert"><CircleAlert size={18}/><span>{error}</span></div>}
      <div className="auto-backup-run"><p>{dirty ? '先保存计划，再开始备份。' : status.running ? '备份在后台进行，可离开此页面。' : '手动备份同样遵守空间检查和保留规则。'}</p><button type="button" className="button" disabled={locked || status.running || dirty} onClick={() => void submit('run')}>{busy === 'run' || status.running ? <LoaderCircle className="spin" size={17}/> : <Archive size={17}/>} {busy === 'run' ? '正在提交…' : status.running ? '备份中…' : '立即备份'}</button></div>
      <div className="auto-backup-list-heading"><h4>已有自动备份</h4><span>{status.backups.length} / {status.settings.retainCount} 份</span></div>
      <ul className="auto-backup-list">{status.backups.map(backup => <li key={backup.id}><span className="auto-backup-file-icon"><Archive size={20}/></span><div><strong>{backup.filename}</strong><span>{dateLabel(backup.createdAt)} · {byteLabel(backup.size)}</span></div><a className="button" href={backup.downloadUrl} download aria-label={`下载备份 ${backup.filename}`}><Download size={17}/><span>下载</span></a></li>)}</ul>
      {!status.backups.length && <p className="auto-backup-empty">还没有自动备份。首次备份成功后，可在这里下载。</p>}
      <p className="auto-backup-hint">备份保存在运行服务的设备上{status.webdav?.enabled ? '，并上传到已配置的 WebDAV 远程目录' : ''}；可下载到其他设备另存。服务关闭期间不会执行备份。</p>
    </>}
  </div>;
}
