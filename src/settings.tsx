import { useEffect, useRef, useState } from 'react';
import { Archive, ArrowRight, Camera, Check, CircleAlert, Clock3, Cloud, Download, HardDrive, Info, LoaderCircle, LockKeyhole, LogOut, RefreshCw, RotateCcw, Upload, UploadCloud, UserRound, UsersRound, Mail } from 'lucide-react';
import type { GallerySettings } from '../shared/types';
import type { Profile } from '../shared/profile';
import { AccountForm } from './auth';
import { api } from './api';
import { AccountManagement, SecurityNotifications } from './admin-settings';
import { AutoBackupSettingsPanel } from './auto-backup-settings';

export type SettingsSection = 'account' | 'sync' | 'backup' | 'help' | 'users' | 'security';
const sections = [
  { id: 'account', label: '账户与头像', icon: UserRound },
  { id: 'sync', label: '网盘同步', icon: RefreshCw },
  { id: 'backup', label: '备份与恢复', icon: Archive },
  { id: 'users', label: '账户管理', icon: UsersRound },
  { id: 'security', label: '安全提醒', icon: Mail },
  { id: 'help', label: '使用说明', icon: Info },
] as const;

export function Avatar({ username, url }: { username: string; url?: string | null }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  useEffect(() => {
    const retry = () => setFailedUrl(null);
    window.addEventListener('online', retry); window.addEventListener('focus', retry);
    return () => { window.removeEventListener('online', retry); window.removeEventListener('focus', retry); };
  }, []);
  return url && failedUrl !== url ? <img src={url} alt={`${username}的头像`} onError={() => setFailedUrl(url)}/> : <span aria-hidden="true">{Array.from(username)[0] || '我'}</span>;
}

type SettingsPanelProps = {
  initialSection: SettingsSection;
  username: string;
  userId: number;
  isAdmin: boolean;
  settings: GallerySettings | null;
  settingsError: string;
  onRetrySettings: () => void;
  profile: Profile | null;
  profileError: string;
  onRetryProfile: () => void;
  onProfileChange: (profile: Profile) => void;
  onSave: (settings: GallerySettings) => void;
  onExport: () => void;
  onImport: () => void;
  onLogout: () => void;
  loggingOut: boolean;
  onBusyChange: (busy: boolean) => void;
  toast: (message: string) => void;
};

export function SettingsPanel(props: SettingsPanelProps) {
  const { username, userId, isAdmin, settings, profile, profileError, onRetryProfile, onProfileChange, onSave, onExport, onImport, onLogout, loggingOut, onBusyChange, toast } = props;
  const initialSection = !isAdmin && ['sync', 'users', 'security'].includes(props.initialSection) ? 'account' : props.initialSection;
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [visited, setVisited] = useState(() => new Set<SettingsSection>([initialSection]));
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [usersBusy, setUsersBusy] = useState(false);
  const [securityBusy, setSecurityBusy] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const busy = avatarBusy || passwordBusy || syncBusy || usersBusy || securityBusy || backupBusy || loggingOut;
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => { if (section !== 'account') setPasswordOpen(false); }, [section]);

  return <div className="settings-hub">
    <nav className="settings-nav" aria-label="设置分类">{sections.filter(item => isAdmin || !['sync', 'users', 'security'].includes(item.id)).map(({ id, label, icon: Icon }) => <button key={id} type="button" className={section === id ? 'selected' : ''} aria-pressed={section === id} disabled={busy} onClick={() => { setSection(id); setVisited(old => new Set([...old, id])); }}><Icon size={19}/><span>{id === 'backup' && !isAdmin ? '备份下载' : label}</span></button>)}</nav>
    <div className="settings-content">
      <section className="settings-section" hidden={section !== 'account'} aria-label="账户与头像">
        <div className="settings-section-heading"><h3>账户与头像</h3><p>为你的私人图库，换上喜欢的头像。</p></div>
        <AvatarEditor username={username} profile={profile} error={profileError} onRetry={onRetryProfile} disabled={busy && !avatarBusy} onBusyChange={setAvatarBusy} onChange={value => { onProfileChange(value); toast(value.avatarUrl ? '头像已更新' : '已恢复默认头像'); }}/>
        <details className="settings-password" open={passwordOpen} onToggle={event => setPasswordOpen(event.currentTarget.open)}><summary onClick={event => { if (passwordBusy) event.preventDefault(); }}><LockKeyhole size={19}/><span>修改登录密码<small>验证当前密码后，设置新的登录密码</small></span><ArrowRight size={17}/></summary>{section === 'account' && passwordOpen && <AccountForm username={username} onBusyChange={setPasswordBusy} disabled={busy && !passwordBusy} onSaved={() => toast('密码已更新，其他会话已退出')}/>}</details>
      </section>
      {isAdmin && <section className="settings-section" hidden={section !== 'sync'} aria-label="网盘同步设置">
        <div className="settings-section-heading"><h3>网盘同步</h3><p>管理每日检查和百度网盘登录凭据。</p></div>
        {settings ? <SyncSettings settings={settings} active={section === 'sync'} disabled={busy && !syncBusy} onBusyChange={setSyncBusy} onSave={value => { onSave(value); toast('同步设置已保存'); }}/> : props.settingsError ? <div className="form-error" role="alert"><CircleAlert size={17}/><span>同步设置暂时无法读取，请重试。</span><button type="button" className="button" disabled={busy} onClick={props.onRetrySettings}>重试</button></div> : <p className="avatar-loading" role="status"><LoaderCircle className="spin" size={17}/>正在读取同步设置…</p>}
      </section>}
      <section className="settings-section" hidden={section !== 'backup'} aria-label="备份与恢复">
        <div className="settings-section-heading"><h3>{isAdmin ? '备份与恢复' : '备份下载'}</h3><p>{isAdmin ? '保存一份收藏，也能把以前的备份导入图库。' : '下载图集清单或包含原图的备份。导入和修改图库由管理员完成。'}</p></div>
        <div className="settings-action-list">
          <button type="button" disabled={busy} onClick={onExport}><span className="settings-action-icon"><Download size={23}/></span><span><strong>导出备份</strong><small>按分类导出 Excel，或下载包含全部原图的 ZIP 备份。</small></span><ArrowRight size={18}/></button>
          {isAdmin && <button type="button" disabled={busy} onClick={onImport}><span className="settings-action-icon"><Upload size={23}/></span><span><strong>导入备份</strong><small>选择 ZIP 或 Excel，预览后导入所需图集。</small></span><ArrowRight size={18}/></button>}
        </div>
        <p className="settings-backup-note"><HardDrive size={17}/><span>图库备份包含图集内容；账户资料、邮件设置和百度网盘 Cookie 不会导出。</span></p>
        {isAdmin && visited.has('backup') && <AutoBackupSettingsPanel toast={toast} active={section === 'backup'} onBusyChange={setBackupBusy} disabled={busy && !backupBusy} onOpenSecurity={() => { if (!busy) { setSection('security'); setVisited(old => new Set([...old, 'security'])); } }}/>}
      </section>
      {isAdmin && visited.has('users') && <section className="settings-section" hidden={section !== 'users'} aria-label="账户管理"><AccountManagement currentUserId={userId} active={section === 'users'} toast={toast} onBusyChange={setUsersBusy} disabled={busy && !usersBusy}/></section>}
      {isAdmin && visited.has('security') && <section className="settings-section" hidden={section !== 'security'} aria-label="安全提醒"><SecurityNotifications active={section === 'security'} toast={toast} onBusyChange={setSecurityBusy} disabled={busy && !securityBusy}/></section>}
      <section className="settings-section" hidden={section !== 'help'} aria-label="使用说明">
        <div className="settings-section-heading"><h3>使用说明</h3><p>{isAdmin ? '从第一张图片开始，慢慢整理你的收藏。' : '普通账户可浏览与下载图库；导入、编辑和同步设置由管理员管理。'}</p></div>
        <div className="help-content"><div><UploadCloud/><section><h3>导入与整理图片</h3><p>新建图集时可多选或拖入图片，也支持粘贴图片网址或 [img]…[/img] 格式。设置标题、分类和标签，详情页还能继续添加图片，点击图片进入大图浏览。</p></section></div><div><Cloud/><section><h3>关联与检测网盘链接</h3><p>为图集添加百度网盘链接和提取码，开启每日自动检查后，每 24 小时检测链接有效性。可选同步网盘文件时间；同步页支持手动检测和筛选失效链接。</p></section></div><div><Clock3/><section><h3>查看更新时间</h3><p>图集显示成功获取的最新网盘文件修改时间；检查失败会保留之前的时间，并记录原因。部分分享需要登录 Cookie 或验证码，可能暂时无法读取。</p></section></div><div><HardDrive/><section><h3>保存与恢复收藏</h3><p>在“图库设置 → 备份与恢复”中导出或导入 Excel、ZIP。完整 ZIP 包含全部原图。图片和数据库保存在运行服务的设备上；关闭服务后，自动检查也会停止。</p></section></div></div>
      </section>
    </div>
    <footer className="settings-footer"><span><UserRound size={16}/><span title={username}>{username}</span><small>{isAdmin ? '管理员' : '只读账户'}</small></span><button type="button" className="button" disabled={busy} onClick={onLogout}>{loggingOut ? <LoaderCircle size={17} className="spin"/> : <LogOut size={17}/>} {loggingOut ? '正在退出…' : '退出登录'}</button></footer>
  </div>;
}

function AvatarEditor({ username, profile, error: loadError, onRetry, disabled, onBusyChange, onChange }: { username: string; profile: Profile | null; error: string; onRetry: () => void; disabled: boolean; onBusyChange: (busy: boolean) => void; onChange: (value: Profile) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function update(file?: File) {
    if (busy || disabled) return;
    setError('');
    if (file && file.size > 5 * 1024 * 1024) { setError('头像不能超过 5 MB，请选择较小的图片。'); return; }
    if (file && !/\.(jpe?g|png|webp|gif|avif)$/i.test(file.name)) { setError('请选择 JPG、PNG、WebP、GIF 或 AVIF 图片。'); return; }
    setBusy(true); onBusyChange(true);
    try {
      const body = new FormData(); if (file) body.append('avatar', file);
      onChange(await api<Profile>('/profile/avatar', { method: file ? 'POST' : 'DELETE', ...(file ? { body } : {}) }));
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); onBusyChange(false); }
  }
  return <div className="profile-card">
    <div className="profile-avatar-row"><div className="profile-avatar"><Avatar username={username} url={profile?.avatarUrl}/>{busy && <span className="avatar-progress"><LoaderCircle className="spin" size={27}/></span>}</div><div className="profile-info"><strong title={username}>{username}</strong><span>我的图库账户</span><div className="avatar-actions"><button type="button" className="button primary" disabled={busy || disabled || !profile} onClick={() => input.current?.click()}><Camera size={17}/>{busy ? '正在保存…' : profile?.avatarUrl ? '更换头像' : '上传头像'}</button><button type="button" className="button" disabled={busy || disabled || !profile?.avatarUrl} onClick={() => void update()}><RotateCcw size={16}/>恢复默认</button></div></div></div>
    <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" hidden aria-label="选择头像图片" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void update(file); }}/>
    <p className="avatar-hint">支持 JPG、PNG、WebP、GIF、AVIF，最大 5 MB。图片居中裁成正方形，动图使用首帧。</p>
    {!profile && !loadError && <p className="avatar-loading" role="status"><LoaderCircle className="spin" size={16}/>正在读取头像…</p>}
    {loadError && <div className="form-error" role="alert"><CircleAlert size={17}/><span>{loadError}</span><button type="button" onClick={onRetry}>重试</button></div>}
    {error && <div className="form-error" role="alert"><CircleAlert size={17}/>{error}</div>}
  </div>;
}

function SyncSettings({ settings, active, disabled, onBusyChange, onSave }: { settings: GallerySettings; active: boolean; disabled: boolean; onBusyChange: (busy: boolean) => void; onSave: (settings: GallerySettings) => void }) {
  const [autoSync, setAutoSync] = useState(settings.autoSync);
  const [cookie, setCookie] = useState('');
  const [clear, setClear] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!active) setCookie(''); }, [active]);
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (saving || disabled) return;
    setSaving(true); onBusyChange(true); setError('');
    try {
      const result = await api<GallerySettings>('/settings', { method: 'PATCH', body: JSON.stringify({ autoSync, ...(cookie || clear ? { baiduCookie: clear ? '' : cookie } : {}) }) });
      setCookie(''); setClear(false); onSave(result);
    } catch (err) { setError((err as Error).message); }
    finally { setCookie(''); setSaving(false); onBusyChange(false); }
  }
  return <form onSubmit={event => void save(event)}><fieldset className="auth-fields" disabled={saving || disabled}>
    <div className="setting-row"><div><h3>每日自动检测与同步</h3><p>每 24 小时检测百度链接有效性，并同步已开启的图集时间。</p></div><button type="button" className={`toggle ${autoSync ? 'on' : ''}`} role="switch" aria-checked={autoSync} aria-label="每日自动检测与同步" onClick={() => setAutoSync(!autoSync)}><span/></button></div>
    <div className="setting-note"><Clock3 size={17}/><p>关闭程序时暂停检查，下次启动补查到期任务。仅检测链接有效性不会修改图集时间；暂停后仍可手动检测。</p></div>
    <label className="field cookie-field">百度网盘 Cookie <span className="field-hint">可选 · {settings.hasBaiduCookie ? '已保存' : '未配置'}</span><textarea autoComplete="off" spellCheck={false} rows={3} value={cookie} onChange={event => { setCookie(event.target.value); setClear(false); }} placeholder={settings.hasBaiduCookie ? '已保存，留空则保持不变。粘贴新的 Cookie 可替换。' : '如分享链接需要登录，可填写你自己的百度网盘 Cookie。'}/><small>保存在运行服务的设备上，不会在页面回显。Cookie 属于登录凭据，请勿分享。验证码需要在百度网盘页面处理。</small></label>
    {settings.hasBaiduCookie && <label className="checkbox-label"><input type="checkbox" checked={clear} onChange={event => { setClear(event.target.checked); if (event.target.checked) setCookie(''); }}/><span>清除已保存的 Cookie</span></label>}
    {error && <div className="form-error" role="alert">{error}</div>}
    <div className="settings-save"><button className="button primary" disabled={saving}>{saving ? <LoaderCircle className="spin" size={17}/> : <Check size={17}/>} {saving ? '正在保存…' : '保存同步设置'}</button></div>
  </fieldset></form>;
}
