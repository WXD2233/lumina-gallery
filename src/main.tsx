import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Aperture, Archive, ArrowDownUp, ArrowLeft, ArrowRight, ArrowUpRight, Bell, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, Clock3, Cloud, CloudDownload, Copy, Download, Ellipsis, Expand, FileSpreadsheet, Folder, FolderHeart, Grid2X2, HardDrive, Heart, Image as ImageIcon, Images, Info, LayoutGrid, Link2, List, LoaderCircle, Maximize2, Mountain, Pencil, Plus, RefreshCw, Search, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Trash2, Upload, UploadCloud, X, ZoomIn, ZoomOut, CircleAlert } from 'lucide-react';
import type { Album, AlbumInput, CloudLink, GalleryImage, GallerySettings, LinkCheckSummary, LinkHealthStatus, SyncLog } from '../shared/types';
import { MAX_IMAGE_SOURCES, parseImageSources } from '../shared/image-sources';
import type { BackupImportPreview, BackupImportResult } from '../shared/backup-import';
import { AuthGate } from './auth';
import { api } from './api';
import { CategoryDropdown } from './category-dropdown';
import { Avatar, SettingsPanel, type SettingsSection } from './settings';
import type { Profile } from '../shared/profile';
import type { AutoBackupStatus } from '../shared/auto-backup';
import './styles.css';

type CategoryResult = { categories: string[]; albums: Album[] };
const healthLabels: Record<LinkHealthStatus, string> = { unchecked: '未检测', valid: '链接有效', invalid: '链接失效', code_required: '缺少提取码', code_error: '提取码错误', login_required: '需要登录', verification_required: '需要验证', network_error: '网络异常', unknown: '暂无法确认', unsupported: '不支持检测' };
function isBaiduUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && ['pan.baidu.com', 'yun.baidu.com'].includes(url.hostname) && !url.username && !url.password && (!url.port || url.port === '443'); } catch { return false; }
}
const healthStatus = (link: CloudLink): LinkHealthStatus => link.health?.status ?? (isBaiduUrl(link.url) ? 'unchecked' : 'unsupported');
function LinkHealthBadge({ link }: { link: CloudLink }) {
  const status = healthStatus(link);
  return <span className={`link-health-badge health-${status}`}><span/>{healthLabels[status]}</span>;
}
const date = (value?: string | null, time = false) => value ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', ...(time ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}) }).format(new Date(value)).replaceAll('/', '.') : '尚未检查';
const size = (n: number) => n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
function App({ username, userId, role, onLogout }: { username: string; userId: number; role: 'admin' | 'viewer'; onLogout: () => Promise<void> }) {
  const canManage = role === 'admin';
  const [albums, setAlbums] = useState<Album[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [route, setRoute] = useState(decodeURIComponent(location.hash.slice(1)) || 'all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('updated');
  const [layout, setLayout] = useState('grid');
  const [editor, setEditor] = useState<Album | 'new' | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('account');
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileError, setProfileError] = useState('');
  const profileRevision = useRef(0);
  const profileRequest = useRef<AbortController | null>(null);
  const galleryRequest = useRef<AbortController | null>(null);
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupImportOpen, setBackupImportOpen] = useState(false);
  const [settings, setSettings] = useState<GallerySettings | null>(null);
  const [notice, setNotice] = useState('');
  const [autoBackup, setAutoBackup] = useState<AutoBackupStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [checkingLinks, setCheckingLinks] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ images: GalleryImage[]; index: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Album | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const toast = useCallback((text: string) => setNotice(text), []);
  const openSettings = (section: SettingsSection = 'account') => { setSettingsSection(section); setSettingsOpen(true); setSidebarOpen(false); };
  const loadProfile = useCallback(async () => {
    profileRequest.current?.abort();
    const controller = new AbortController(); profileRequest.current = controller;
    const revision = ++profileRevision.current;
    setProfileError('');
    try { const value = await api<Profile>('/profile', { signal: controller.signal }); if (revision === profileRevision.current) setProfile(value); }
    catch (error) { if (!controller.signal.aborted && revision === profileRevision.current) setProfileError((error as Error).message); }
  }, []);
  useEffect(() => { void loadProfile(); window.addEventListener('focus', loadProfile); return () => { ++profileRevision.current; profileRequest.current?.abort(); window.removeEventListener('focus', loadProfile); }; }, [loadProfile]);
  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try { await onLogout(); } catch (e) { toast((e as Error).message); } finally { setLoggingOut(false); }
  }
  const reload = useCallback(async () => {
    galleryRequest.current?.abort();
    const controller = new AbortController(); galleryRequest.current = controller;
    try {
      const options = { signal: controller.signal };
      const [items, config, names] = await Promise.all([api<Album[]>('/albums', options), api<GallerySettings>('/settings', options), api<string[]>('/categories', options)]);
      if (!controller.signal.aborted) { setAlbums(items); setSettings(config); setCategories(names); setLoadError(''); }
    } catch (e) { if (!controller.signal.aborted) setLoadError((e as Error).message); }
    finally { if (!controller.signal.aborted) setLoading(false); controller.abort(); }
  }, []);
  useEffect(() => { void reload(); const t = setInterval(() => { if (document.visibilityState === 'visible') void reload(); }, 60000); return () => { clearInterval(t); galleryRequest.current?.abort(); }; }, [reload]);
  useEffect(() => {
    if (!canManage) { setAutoBackup(null); return; }
    let active = true; let pending = false; let controller: AbortController | undefined;
    const refresh = async () => {
      if (!active || pending || document.visibilityState !== 'visible') return;
      pending = true; controller = new AbortController();
      try { const value = await api<AutoBackupStatus>('/admin/auto-backups', { signal: controller.signal }); if (active) setAutoBackup(value); }
      catch { /* Keep the last warning visible if a status request fails. */ }
      finally { pending = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 60_000);
    window.addEventListener('focus', refresh); window.addEventListener('auto-backup-updated', refresh);
    return () => { active = false; controller?.abort(); clearInterval(timer); window.removeEventListener('focus', refresh); window.removeEventListener('auto-backup-updated', refresh); };
  }, [canManage]);
  useEffect(() => { const listen = () => { setRoute(decodeURIComponent(location.hash.slice(1)) || 'all'); setSidebarOpen(false); window.scrollTo({ top: 0 }); }; window.addEventListener('hashchange', listen); return () => window.removeEventListener('hashchange', listen); }, []);
  useEffect(() => { if (notice) { const t = setTimeout(() => setNotice(''), 4500); return () => clearTimeout(t); } }, [notice]);
  const navigate = (value: string, keepSearch = false) => { location.hash = encodeURIComponent(value); if (!keepSearch) setSearch(''); };
  const current = route.startsWith('album/') ? albums.find(a => a.id === route.slice(6)) : null;
  const category = route.startsWith('category/') ? route.slice(9) : '';
  const pageTitle = current ? current.title : route === 'favorites' ? (canManage ? '我的收藏' : '收藏图集') : route === 'recent' ? '最近更新' : route === 'sync' ? '网盘同步' : category || '全部图集';
  const filtered = useMemo(() => albums.filter(a => (route !== 'favorites' || a.favorite) && (!category || a.category === category) && (!search || `${a.title} ${a.description} ${a.tags.join(' ')}`.toLowerCase().includes(search.toLowerCase()))).sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title, 'zh-CN') : sort === 'created' ? +new Date(b.createdAt) - +new Date(a.createdAt) : +new Date(b.updatedAt) - +new Date(a.updatedAt)), [albums, route, category, search, sort]);
  const synced = albums.filter(a => a.links.length > 0);
  const imageCount = albums.reduce((n, a) => n + a.images.length, 0);
  const totalSize = albums.reduce((n, a) => n + a.images.reduce((m, i) => m + i.size, 0), 0);
  async function favorite(album: Album) { try { await api(`/albums/${album.id}`, { method: 'PATCH', body: JSON.stringify({ favorite: !album.favorite }) }); await reload(); } catch (e) { toast((e as Error).message); } }
  async function sync(album?: Album) {
    if (syncing || checkingLinks) return;
    setSyncing(true);
    try { const result = await api<{ checked: number; errors: number }>(album ? `/albums/${album.id}/sync` : '/sync', { method: 'POST', body: '{}' }); await reload(); toast(result.checked ? `检查完成：${result.checked} 个链接${result.errors ? `，${result.errors} 个需处理，请查看同步记录` : '，已同步可用的网盘时间'}` : '暂无开启自动同步的百度网盘链接'); }
    catch (e) { toast((e as Error).message); } finally { setSyncing(false); }
  }
  async function checkLinks(album?: Album, link?: CloudLink) {
    if (checkingLinks || syncing) return;
    setCheckingLinks(link?.id ?? album?.id ?? 'all');
    try {
      const path = album ? link ? `/albums/${album.id}/links/${link.id}/check` : `/albums/${album.id}/link-checks` : '/link-checks';
      const result = await api<LinkCheckSummary>(path, { method: 'POST', body: '{}' });
      await reload();
      toast(`检测完成：${result.valid} 个有效，${result.invalid} 个失效${result.uncertain ? `，${result.uncertain} 个待确认` : ''}${result.unsupported ? `，${result.unsupported} 个暂不支持` : ''}`);
    } catch (e) { toast((e as Error).message); }
    finally { setCheckingLinks(null); }
  }
  async function remove() {
    if (!confirmDelete) return; setDeleting(true);
    try { await api(`/albums/${confirmDelete.id}`, { method: 'DELETE' }); setConfirmDelete(null); navigate('all'); await reload(); toast('图集已删除'); } catch(e) { toast((e as Error).message); } finally { setDeleting(false); }
  }
  return <div className="app-shell">
    {sidebarOpen && <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? 'is-open' : ''}`}>
      <a className="brand" href="#all"><span className="brand-icon"><Aperture size={28} strokeWidth={1.65}/></span><span>拾光<span className="brand-en">LUMINA</span></span><span className="brand-dot"/></a>
      <div className="workspace-label">我的私人空间 <span>LOCAL</span></div>
      <nav className="main-nav" aria-label="主导航">
        {[['all', LayoutGrid, '全部图集', albums.length], ['favorites', Heart, canManage ? '我的收藏' : '收藏图集', albums.filter(a => a.favorite).length], ['recent', Clock3, '最近更新', null], ['sync', RefreshCw, '网盘同步', synced.length]].map(([key, Icon, label, count]) => { const I = Icon as typeof LayoutGrid; return <button key={key as string} className={`nav-item ${route === key ? 'active' : ''}`} onClick={() => navigate(key as string)}><I size={19}/><span>{label as string}</span>{count !== null && <small>{count as number}</small>}</button>; })}
      </nav>
      <div className="nav-section-title">图集分类 {canManage && <button className="manage-categories" aria-label="管理分类" onClick={() => { setCategoriesOpen(true); setSidebarOpen(false); }}><Pencil size={12}/>管理</button>}</div>
      <nav className="category-nav" aria-label="图集分类">{categories.map((name, i) => <button className={`nav-item ${category === name ? 'active' : ''}`} onClick={() => navigate(`category/${name}`)} key={name}><i className={`category-dot dot-${i % 5}`}/><span>{name}</span><small>{albums.filter(a => a.category === name).length}</small></button>)}</nav>
      <div className="sidebar-bottom"><div className="local-card"><div className="local-card-title"><ShieldCheck size={18}/><span>只属于你的图库</span></div><p>原图保存在本机，安心收藏<br/>每一个值得留住的瞬间。</p><div className="local-storage"><span>{imageCount} 张图片</span><span>{size(totalSize)}</span></div><div className="storage-line"><span/></div></div><button className="nav-item" onClick={() => openSettings()}><Settings2 size={18}/><span>图库设置</span></button><span className="sidebar-version">拾光 v1.0 <span>用图片，收藏生活</span></span></div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <div className="breadcrumb"><button className="mobile-menu icon-button" aria-label="打开导航" onClick={() => setSidebarOpen(true)}><List size={20}/></button><a className="breadcrumb-root" href="#all" title="返回主页" onClick={e => { if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; e.preventDefault(); navigate('all'); setSidebarOpen(false); window.scrollTo({ top: 0 }); }}>我的图库</a><ChevronRight size={14}/><span>{pageTitle}</span></div>
        <div className="topbar-right">
          <div className="search-controls" role="search" aria-label="按分类搜索图集">
            <label className="search-category-filter"><Folder size={16}/><select aria-label="搜索分类" title={category || '全部分类'} value={category} onChange={e => navigate(e.target.value ? `category/${e.target.value}` : 'all', true)}><option value="">全部分类</option>{categories.map(name => <option key={name} value={name}>{name}</option>)}</select><ChevronDown size={14}/></label>
            <label className="search-box"><Search size={17}/><input value={search} onChange={e => { if (route.startsWith('album/') || route === 'sync') navigate('all'); setSearch(e.target.value); }} placeholder={category ? '在此分类中搜索…' : '搜索图集、标签…'} aria-label="搜索图集"/>{search ? <button aria-label="清空搜索" onClick={() => setSearch('')}><X size={14}/></button> : <span className="search-hint">搜索</span>}</label>
          </div>
          <button className="icon-button top-settings" aria-label="设置" onClick={() => openSettings()}><Settings2 size={19}/></button><span className="topbar-divider"/><button className="avatar" aria-label="账户设置" title={`账户设置 · ${username}`} onClick={() => openSettings('account')}><Avatar username={username} url={profile?.avatarUrl}/></button>
        </div>
      </header>
      <main>
        {canManage && autoBackup && ['waiting_space', 'blocked', 'failed'].includes(autoBackup.phase) && <div className="backup-global-warning" role="status"><CircleAlert size={22}/><div><strong>自动备份需要处理</strong><p>{autoBackup.message}</p></div><button className="button" onClick={() => openSettings('backup')}>查看备份设置</button></div>}
        {loading ? <div className="loading-state"><LoaderCircle className="spin"/><span>正在打开你的图库…</span></div> : loadError ? <div className="empty-state"><CircleAlert size={36}/><h2>暂时无法连接图库</h2><p>{loadError}</p><button className="button primary" onClick={() => void reload()}>重新连接</button></div> : route === 'sync' ? <SyncCenter canManage={canManage} albums={albums} syncing={syncing} settings={settings} onSync={() => void sync()} checkingLinks={checkingLinks} onCheck={(album, link) => void checkLinks(album, link)} navigate={navigate} onSettings={() => openSettings('sync')}/> : current ? <AlbumDetail canManage={canManage} album={current} onBack={() => navigate('all')} onEdit={() => setEditor(current)} onDelete={() => setConfirmDelete(current)} onFavorite={() => void favorite(current)} onSync={() => void sync(current)} syncing={syncing} checkingLinks={checkingLinks} onCheckLink={link => void checkLinks(current, link)} onView={index => setLightbox({ images: current.images, index })} toast={toast} reload={reload}/> : route.startsWith('album/') ? <div className="empty-state"><Folder size={40}/><h2>没有找到这个图集</h2><button className="button" onClick={() => navigate('all')}>返回图库</button></div> : <>
          <section className="page-heading"><div><div className="eyebrow">A LITTLE SPACE FOR YOUR INSPIRATION</div><h1>{route === 'all' ? <>我的光影收藏<span className="heading-dot">.</span></> : pageTitle}</h1><p>{route === 'favorites' ? '喜欢的瞬间，值得再看一遍。' : route === 'recent' ? '每一次更新，都有新的发现。' : category ? '为热爱的画面，留一个专属角落。' : '把喜欢的瞬间收好，让灵感随时发生。'}</p></div>{canManage ? <button className="button primary import-button" onClick={() => setEditor('new')}><Plus size={19}/>导入图片<span className="button-shortcut">＋</span></button> : <span className="viewer-badge"><ShieldCheck size={17}/>只读账户 · 可浏览下载</span>}</section>
          <section className="sync-banner"><span className="banner-icon"><Cloud size={26}/><span className="small-check"><Check size={10}/></span></span><div><h3>你的收藏，时刻保持新鲜 <span className={`tiny-badge ${settings?.autoSync ? '' : 'muted'}`}>{settings?.autoSync ? '自动检查已开启' : '自动检查已暂停'}</span></h3><p>每 24 小时检测百度链接有效性，开启时间同步后还可更新图集时间。</p></div><button onClick={() => navigate('sync')}>{canManage ? '管理同步' : '查看同步'} <ArrowRight size={15}/></button><Cloud className="banner-decoration" size={130}/></section>
          <section className="gallery-toolbar"><div className="gallery-tabs">{route === 'all' || category ? <CategoryDropdown label={search ? '搜索结果' : pageTitle} count={filtered.length} total={albums.length} selected={category} categories={categories.map(name => ({ name, count: albums.filter(album => album.category === name).length }))} onSelect={name => navigate(name ? `category/${name}` : 'all', true)}/> : <button className="selected">{search ? '搜索结果' : pageTitle}<span>{filtered.length}</span></button>}{route === 'all' && <button onClick={() => navigate('favorites')}>{canManage ? '我的收藏' : '收藏图集'}<span>{albums.filter(a => a.favorite).length}</span></button>}</div><div className="gallery-controls"><label className="sort-select"><ArrowDownUp size={15}/><select value={sort} onChange={e => setSort(e.target.value)} aria-label="排序方式"><option value="updated">最近更新</option><option value="created">最近添加</option><option value="title">标题排序</option></select><ChevronDown size={13}/></label><span className="control-divider"/><div className="view-switch"><button aria-label="网格视图" className={layout === 'grid' ? 'active' : ''} onClick={() => setLayout('grid')}><Grid2X2 size={17}/></button><button aria-label="列表视图" className={layout === 'list' ? 'active' : ''} onClick={() => setLayout('list')}><List size={18}/></button></div></div></section>
          {filtered.length ? <div className={`gallery-grid ${layout === 'list' ? 'list-layout' : ''}`}>{filtered.map(album => <AlbumCard canManage={canManage} key={album.id} album={album} open={() => navigate(`album/${album.id}`)} favorite={() => void favorite(album)}/>)}</div> : <div className="empty-state"><span className="empty-icon">{search ? <Search size={34}/> : route === 'favorites' ? <Heart size={34}/> : <Images size={34}/>}</span><h2>{search ? '还没有找到这个瞬间' : route === 'favorites' ? '收藏你喜欢的图集' : '从第一张图片开始'}</h2><p>{search ? '试试其他标题或标签。' : !canManage ? '管理员添加图集后，即可在这里浏览和下载。' : route === 'favorites' ? '点击图集上的爱心，就能在这里找到它。' : '导入图片，创建你的第一个私人图集。'}</p>{canManage && !search && route !== 'favorites' && <button className="button primary" onClick={() => setEditor('new')}><Plus size={17}/>创建图集</button>}</div>}
          <footer className="gallery-footer"><span>共 {filtered.length} 个图集 <i/> {filtered.reduce((n, a) => n + a.images.length, 0)} 张图片</span><span><HardDrive size={13}/>本地存储 <i/><span className="footer-dot"/>私密收藏</span></footer>
        </>}
      </main>
    </div>
    {canManage && editor && <AlbumEditor album={editor === 'new' ? undefined : editor} categories={categories} onClose={() => setEditor(null)} onSave={async a => { setEditor(null); await reload(); navigate(`album/${a.id}`); toast(editor === 'new' ? '图片已导入，图集已创建' : '图集已保存'); }} toast={toast}/>}
    {canManage && categoriesOpen && <CategoryManager categories={categories} albums={albums} onClose={() => setCategoriesOpen(false)} onChange={(result, oldName, newName) => { setCategories(result.categories); setAlbums(result.albums); if (oldName && category === oldName) navigate(`category/${newName || '未分类'}`); }} toast={toast}/>}
    {settingsOpen && <Modal title="图库设置" subtitle={canManage ? '管理账户、网盘同步与图库备份' : '管理个人账户、头像与备份下载'} wide onClose={() => !settingsBusy && setSettingsOpen(false)}><SettingsPanel initialSection={settingsSection} username={username} userId={userId} isAdmin={canManage} settings={settings} settingsError={loadError} onRetrySettings={() => void reload()} profile={profile} profileError={profileError} onRetryProfile={() => void loadProfile()} onProfileChange={value => { ++profileRevision.current; setProfile(value); setProfileError(''); }} onSave={setSettings} onExport={() => { setSettingsOpen(false); setBackupOpen(true); }} onImport={() => { setSettingsOpen(false); setBackupImportOpen(true); }} onLogout={() => void logout()} loggingOut={loggingOut} onBusyChange={setSettingsBusy} toast={toast}/></Modal>}
    {backupOpen && <BackupModal albumCount={albums.length} imageCount={imageCount} categoryCount={categories.length} onClose={() => { setBackupOpen(false); openSettings('backup'); }}/>}
    {canManage && backupImportOpen && <BackupImportModal onClose={() => { setBackupImportOpen(false); openSettings('backup'); }} onImported={async result => { setBackupImportOpen(false); openSettings('backup'); await reload(); navigate('all'); toast(`已导入 ${result.imported} 个图集、${result.imageCount} 张图片${result.skipped ? `，跳过 ${result.skipped} 个已有图集` : ''}${result.categoriesAdded ? `，新增 ${result.categoriesAdded} 个分类` : ''}`); }}/>}
    {canManage && confirmDelete && <Modal title="删除这个图集？" onClose={() => !deleting && setConfirmDelete(null)}><p className="delete-message">“{confirmDelete.title}”和图库中的 {confirmDelete.images.length} 张图片将被删除。电脑上原来的图片和网盘文件不受影响。</p><div className="modal-actions"><button className="button" disabled={deleting} onClick={() => setConfirmDelete(null)}>取消</button><button className="button danger" disabled={deleting} onClick={() => void remove()}>{deleting ? <LoaderCircle size={16} className="spin"/> : <Trash2 size={16}/>}删除图集</button></div></Modal>}
    {lightbox && <Lightbox {...lightbox} onClose={() => setLightbox(null)}/>}
    {notice && <div className="toast" role="status"><Info size={18}/>{notice}<button aria-label="关闭提示" onClick={() => setNotice('')}><X size={15}/></button></div>}
  </div>;
}

function AlbumCard({ album, open, favorite, canManage }: { canManage: boolean; album: Album; open: () => void; favorite: () => void }) {
  const linked = album.links.some(l => l.syncEnabled);
  const failed = album.links.some(l => l.syncEnabled && l.status === 'error');
  return <article className="album-card"><div className="card-cover"><button className="cover-open" onClick={open} aria-label={`打开图集 ${album.title}`}>{album.images[0] ? <img src={album.images[0].thumbnailUrl || album.images[0].url} alt={album.title} loading="lazy"/> : <div className="cover-placeholder"><ImageIcon size={42}/></div>}</button><span className="cover-category">{album.category}</span>{canManage && <button className={`favorite-button ${album.favorite ? 'is-favorite' : ''}`} aria-label={album.favorite ? `取消收藏 ${album.title}` : `收藏 ${album.title}`} onClick={favorite}><Heart size={17} fill={album.favorite ? 'currentColor' : 'none'}/></button>}<span className="cover-count"><Images size={12}/>{album.images.length} 张</span><span className="cover-view"><Expand size={15}/></span></div><div className="card-body"><button className="card-title" onClick={open}>{album.title}</button><p>{album.description || (album.tags.length ? album.tags.map(t => `#${t}`).join('  ') : '每个瞬间，都值得珍藏')}</p><div className="card-meta"><span><Clock3 size={12}/>{date(album.updatedAt)}</span>{album.links.some(link => healthStatus(link) === 'invalid') ? <span className="card-link-invalid"><CircleAlert size={13}/>链接失效</span> : linked ? <span className={failed ? 'sync-warning' : album.updateSource === 'baidu' ? 'cloud-meta' : 'pending-meta'}><Cloud size={13}/>{failed ? '需检查' : album.updateSource === 'baidu' ? '网盘同步' : '待同步'}</span> : <span><Folder size={12}/>本地图集</span>}</div></div></article>;
}

function AlbumDetail({ canManage, album, onBack, onEdit, onDelete, onFavorite, onSync, syncing, checkingLinks, onCheckLink, onView, toast, reload }: { canManage: boolean; album: Album; onBack: () => void; onEdit: () => void; onDelete: () => void; onFavorite: () => void; onSync: () => void; syncing: boolean; checkingLinks: string | null; onCheckLink: (link: CloudLink) => void; onView: (index: number) => void; toast: (message: string) => void; reload: () => Promise<void> }) {
  const [view, setView] = useState('reading');
  const [uploading, setUploading] = useState(false);
  const [imageToDelete, setImageToDelete] = useState<GalleryImage | null>(null);
  const [deletingImage, setDeletingImage] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  async function addImages(files: FileList | null) { if (!files?.length) return; setUploading(true); const data = new FormData(); Array.from(files).forEach(f => data.append('images', f)); try { await api(`/albums/${album.id}/images`, { method: 'POST', body: data }); await reload(); toast('图片已添加到图集'); } catch (e) { toast((e as Error).message); } finally { setUploading(false); if(input.current) input.current.value = ''; } }
  async function removeImage() { if (!imageToDelete) return; setDeletingImage(true); try { await api(`/albums/${album.id}/images/${imageToDelete.id}`, { method: 'DELETE' }); await reload(); setImageToDelete(null); toast('图片已从图集中移除'); } catch (e) { toast((e as Error).message); } finally { setDeletingImage(false); } }
  return <div className="detail-page"><button className="back-button" onClick={onBack}><ArrowLeft size={17}/>返回图库</button><section className="detail-heading"><div><span className="detail-category">{album.category}</span><h1>{album.title}</h1><div className="detail-meta"><span><Clock3 size={15}/>更新于 {date(album.updatedAt, true)}</span><span><Images size={15}/>{album.images.length} 张图片</span><span className={album.updateSource === 'baidu' ? 'cloud-meta' : ''}>{album.updateSource === 'baidu' ? <Cloud size={15}/> : <HardDrive size={15}/>}时间来自{album.updateSource === 'baidu' ? '百度网盘' : '本地图集'}</span></div></div>{canManage && <div className="detail-actions"><button className={`button ${album.favorite ? 'favorited' : ''}`} onClick={onFavorite}><Heart size={16} fill={album.favorite ? 'currentColor' : 'none'}/>{album.favorite ? '已收藏' : '收藏'}</button><button className="button" onClick={onEdit}><Pencil size={16}/>编辑图集</button><button className="icon-button" aria-label="删除图集" onClick={onDelete}><Trash2 size={17}/></button></div>}</section>{album.description && <p className="detail-description">{album.description}</p>}{album.tags.length > 0 && <div className="tags">{album.tags.map(t => <span key={t}>#{t}</span>)}</div>}
    <div className="detail-toolbar"><div className="segmented"><button className={view === 'reading' ? 'active' : ''} onClick={() => setView('reading')}><List size={15}/>连续浏览</button><button className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')}><Grid2X2 size={15}/>图片网格</button></div><div className="detail-toolbar-right"><a href="#download-links" onClick={e => { e.preventDefault(); document.getElementById('download-links')?.scrollIntoView({ behavior: 'smooth' }); }}><Link2 size={15}/>网盘链接</a>{canManage && <button className="button small" disabled={uploading} onClick={() => input.current?.click()}>{uploading ? <LoaderCircle className="spin" size={15}/> : <Plus size={15}/>}添加图片</button>}<input type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" multiple hidden ref={input} onChange={e => void addImages(e.target.files)}/></div></div>
    <div className={`detail-images ${view === 'grid' ? 'image-grid' : ''}`}>{album.images.map((im, index) => <figure key={im.id}><button className="detail-image-button" onClick={() => onView(index)}><img src={view === 'grid' ? im.thumbnailUrl : im.url} alt={im.name} loading="lazy"/><span className="enlarge-hint"><Maximize2 size={15}/>查看大图</span></button><figcaption><span>{String(index + 1).padStart(2, '0')} <i/> {im.name}</span>{canManage && <button className="icon-button" aria-label={`删除图片 ${im.name}`} onClick={() => setImageToDelete(im)}><Trash2 size={13}/></button>}<span>{im.width} × {im.height}</span></figcaption></figure>)}</div>
    <section className="download-panel" id="download-links"><div className="download-heading"><span className="download-icon"><CloudDownload size={24}/></span><div><h2>网盘资源</h2><p>收藏画面，也保存一份完整的美好。</p></div>{canManage && <button className="button small" onClick={onEdit}><Pencil size={14}/>{album.links.length ? '编辑链接' : '添加链接'}</button>}</div>{album.links.length ? album.links.map(link => <div className="cloud-link" key={link.id}><div className="cloud-link-main"><span className="baidu-icon"><Cloud size={24}/></span><div className="cloud-link-info"><h3>{link.label || '网盘链接'}{link.syncEnabled && <span className={`status-badge ${link.status}`}><span/>{link.status === 'success' ? '同步正常' : link.status === 'error' ? '需要处理' : '等待检查'}</span>}</h3><p>{link.url}</p></div><a href={link.url} target="_blank" rel="noopener noreferrer" className="button primary small">打开网盘<ArrowUpRight size={15}/></a></div><div className="link-details">{link.code && <span>提取码 <strong>{link.code}</strong><button aria-label="复制提取码" onClick={() => void navigator.clipboard.writeText(link.code).then(() => toast('提取码已复制')).catch(() => toast(`请手动复制提取码：${link.code}`))}><Copy size={13}/></button></span>}{link.password && <span>解压密码 <strong>{link.password}</strong><button aria-label="复制解压密码" onClick={() => void navigator.clipboard.writeText(link.password).then(() => toast('解压密码已复制')).catch(() => toast(`请手动复制解压密码：${link.password}`))}><Copy size={13}/></button></span>}{link.note && <p>{link.note}</p>}</div><div className="link-health-detail"><div className="link-health-result"><LinkHealthBadge link={link}/><p>{link.health?.message || (isBaiduUrl(link.url) ? '尚未检测，开启每日自动检查后会定期检测链接有效性。' : '暂不支持此网盘的自动有效性检测，可打开链接确认。')}</p><small>有效性检测：{date(link.health?.checkedAt, true)}{link.health?.nextCheckAt ? ` · 下次：${date(link.health.nextCheckAt, true)}` : ''}</small></div>{canManage && isBaiduUrl(link.url) && <button className="button small" disabled={syncing || Boolean(checkingLinks)} onClick={() => onCheckLink(link)}><ShieldCheck size={15} className={checkingLinks === link.id ? 'spin' : ''}/>{checkingLinks === link.id ? '检测中…' : '检测链接'}</button>}</div>{link.syncEnabled && <div className={`link-sync ${link.status === 'error' ? 'has-error' : ''}`}><RefreshCw size={13}/><div><span>{link.message || '每天检查网盘文件的实际修改时间，首次检查后同步。'}</span><small>最近检查：{date(link.lastCheckedAt, true)} {link.remoteUpdatedAt ? ` · 网盘更新：${date(link.remoteUpdatedAt, true)}` : ''}{link.nextCheckAt ? ` · 下次检查：${date(link.nextCheckAt, true)}` : ''}</small></div></div>}</div>) : <div className="no-links"><Link2 size={24}/><p>{canManage ? '还没有关联网盘链接，编辑图集即可添加。' : '还没有关联网盘链接，等待管理员添加。'}</p></div>}{album.links.some(l => l.syncEnabled) && <div className="download-footer"><span><Clock3 size={14}/>每 24 小时检查一次 · 成功获取后同步更新时间</span>{canManage && <button disabled={syncing || Boolean(checkingLinks)} onClick={onSync}><RefreshCw size={14} className={syncing ? 'spin' : ''}/>{syncing ? '同步中…' : '同步更新时间'}</button>}</div>}</section>
    {canManage && imageToDelete && <Modal title="移除这张图片？" onClose={() => !deletingImage && setImageToDelete(null)}><p className="delete-message">图片将从本地图集中移除，电脑上的原文件不受影响。</p><div className="modal-actions"><button className="button" disabled={deletingImage} onClick={() => setImageToDelete(null)}>取消</button><button className="button danger" disabled={deletingImage} onClick={() => void removeImage()}>{deletingImage ? '正在移除…' : '移除图片'}</button></div></Modal>}
  </div>;
}

function Modal({ title, subtitle, children, onClose, wide = false }: { title: string; subtitle?: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; const oldOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; const handle = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); if(e.key === 'Tab') { const elements = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary') || []).filter(element => element.getClientRects().length > 0 && !element.closest('[hidden],[inert]')); if(elements?.length) { const first = elements[0], last = elements[elements.length - 1]; if(e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus(); } else if(!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } } } }; window.addEventListener('keydown', handle); ref.current?.focus(); return () => { document.body.style.overflow = oldOverflow; window.removeEventListener('keydown', handle); previous?.focus(); }; }, []);
  return <div className="modal-overlay" onMouseDown={e => { if(e.target === e.currentTarget) onClose(); }}><div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}><header className="modal-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="关闭弹窗" onClick={onClose}><X size={20}/></button></header>{children}</div></div>;
}

type BackupResult = { downloadUrl: string; filename: string; size: number; warnings: string[] };
function BackupModal({ albumCount, imageCount, categoryCount, onClose }: { albumCount: number; imageCount: number; categoryCount: number; onClose: () => void }) {
  const [format, setFormat] = useState<'xlsx' | 'zip'>('xlsx');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<BackupResult | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (result) resultRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [result]);
  const downloadSize = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : size(bytes);
  async function createBackup() {
    if (busy) return;
    setBusy(true); setError(''); setResult(null);
    try {
      const file = await api<BackupResult>('/backups', { method: 'POST', body: JSON.stringify({ format }) });
      setResult(file);
      const link = document.createElement('a');
      link.href = file.downloadUrl; link.download = file.filename;
      document.body.appendChild(link); link.click(); link.remove();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <Modal title="导出备份" subtitle="把收藏整理成表格，也为原图留一份备份。" wide onClose={() => !busy && onClose()}>
    <div className="backup-body">
      <div className="backup-summary"><span><Folder size={17}/><strong>{categoryCount}</strong> 个分类</span><span><Images size={17}/><strong>{albumCount}</strong> 个图集</span><span><ImageIcon size={17}/><strong>{imageCount}</strong> 张图片</span></div>
      <fieldset className="backup-options" disabled={busy}>
        <legend className="backup-label">选择导出格式</legend>
        {([{ value: 'xlsx', Icon: FileSpreadsheet, title: 'Excel 表格', extension: '.xlsx', description: '每个分类一个工作表，嵌入封面缩略图，保留时间、网盘链接和密码。' }, { value: 'zip', Icon: Archive, title: '完整备份', extension: '.zip', description: '包含 Excel 表格、全部原图、图库数据和恢复说明，方便迁移到另一台电脑。' }] as const).map(option => <label className={`backup-option ${format === option.value ? 'selected' : ''}`} key={option.value}>
          <input type="radio" name="backup-format" value={option.value} checked={format === option.value} onChange={() => { setFormat(option.value); setResult(null); setError(''); }} aria-label={option.title}/>
          <option.Icon className="backup-format-icon" size={25}/><span><strong>{option.title}<small>{option.extension}</small></strong><span>{option.description}</span></span>
        </label>)}
      </fieldset>
      <div className="backup-preview"><div className="backup-preview-heading"><FileSpreadsheet size={16}/><span>表格列顺序</span><small>按分类分表</small></div><div className="backup-columns" aria-label="Excel 列顺序">{['序号', '标题', '时间', '图片', '网盘链接', '提取码', '解压码'].map(title => <span key={title}>{title}</span>)}</div><p>时间与图集页面的更新时间一致。图片列显示封面；多个网盘链接会逐行列出。</p></div>
      <p className="backup-note"><Info size={16}/>{format === 'xlsx' ? '需要保留全部原图并恢复图库时，请选择“完整备份”。' : '下载后请妥善保存压缩包。通过侧栏“导入备份”可恢复图集；网盘中的文件不会下载到备份中。'}</p>
      {error && <div className="form-error" role="alert"><CircleAlert size={16}/>{error}</div>}
      {busy && <div className="backup-progress" role="status"><LoaderCircle className="spin" size={20}/><span>正在整理{format === 'zip' ? '表格和原图' : '表格和封面'}，请保持窗口打开…</span></div>}
      {result && <div className="backup-result" role="status" ref={resultRef}><div><CheckCheck size={21}/><strong>备份已生成</strong><span>{downloadSize(result.size)}</span></div><p>如果下载没有开始，可点击下方文件重新下载。</p><a href={result.downloadUrl} download={result.filename}><Download size={16}/>{result.filename}</a>{result.warnings.length > 0 && <ul className="backup-warnings">{result.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}</div>}
    </div>
    <div className="modal-actions backup-actions"><span>导出全部分类和图集</span><button className="button" disabled={busy} onClick={onClose}>关闭</button><button className="button primary" disabled={busy} onClick={() => void createBackup()}>{busy ? <LoaderCircle size={17} className="spin"/> : <Download size={17}/>} {busy ? '正在生成…' : result ? '重新生成' : '生成并下载'}</button></div>
  </Modal>;
}

function BackupImportModal({ onClose, onImported }: { onClose: () => void; onImported: (result: BackupImportResult) => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null);
  const stagedId = useRef<string | null>(null);
  const [preview, setPreview] = useState<BackupImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [duplicateMode, setDuplicateMode] = useState<'skip' | 'copy'>('skip');
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null);
  const [error, setError] = useState('');
  useEffect(() => () => { if (stagedId.current) void api(`/backup-imports/${stagedId.current}`, { method: 'DELETE' }).catch(() => undefined); }, []);
  const eligible = preview?.albums.filter(album => duplicateMode === 'copy' || !album.exists) ?? [];
  const chosen = eligible.filter(album => selected.has(album.key));
  const existingCount = preview?.albums.filter(album => album.exists).length ?? 0;
  const categoryOnly = preview?.albums.length === 0 && preview.categories.length > 0;
  async function inspect(file?: File) {
    if (!file || busy) return;
    setError('');
    if (!/\.(zip|xlsx)$/i.test(file.name)) { setError('请选择完整 ZIP 备份或 Excel 工作簿（.xlsx）'); return; }
    const isExcel = /\.xlsx$/i.test(file.name);
    if (file.size > (isExcel ? 128 * 1024 ** 2 : 2 * 1024 ** 3)) { setError(isExcel ? 'Excel 文件不能超过 128 MB' : 'ZIP 备份不能超过 2 GB'); return; }
    setBusy('preview'); setPreview(null); setSelected(new Set()); setDuplicateMode('skip');
    try {
      if (stagedId.current) { await api(`/backup-imports/${stagedId.current}`, { method: 'DELETE' }); stagedId.current = null; }
      const body = new FormData(); body.set('file', file);
      const result = await api<BackupImportPreview>('/backup-imports', { method: 'POST', body });
      stagedId.current = result.id; setPreview(result); setSelected(new Set(result.albums.filter(album => !album.exists).map(album => album.key)));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }
  async function commit() {
    if (!preview || busy || (!chosen.length && !categoryOnly)) return;
    setBusy('commit'); setError('');
    try {
      const result = await api<BackupImportResult>(`/backup-imports/${preview.id}/commit`, { method: 'POST', body: JSON.stringify({ albumKeys: chosen.map(album => album.key), duplicateMode }) });
      stagedId.current = null; await onImported(result);
    } catch (e) { setError((e as Error).message); setBusy(null); }
  }
  return <Modal title="导入备份" subtitle="找回收藏，从一份备份开始。" wide onClose={() => !busy && onClose()}>
    <div className="backup-import-body">
      {!preview && <div className="backup-import-formats"><div><Archive size={21}/><span><strong>完整 ZIP 备份</strong><small>恢复原图、分类及图集资料</small></span></div><div><FileSpreadsheet size={21}/><span><strong>Excel 表格</strong><small>导入表格资料与内嵌封面</small></span></div></div>}
      <input ref={input} type="file" hidden accept=".zip,.xlsx" aria-label="备份文件" onChange={e => { void inspect(e.target.files?.[0]); e.target.value = ''; }}/>
      <button className={`backup-import-picker ${preview ? 'has-file' : ''}`} disabled={Boolean(busy)} onClick={() => input.current?.click()}>
        {busy === 'preview' ? <LoaderCircle className="spin" size={28}/> : <UploadCloud size={28}/>}
        <span><strong>{busy === 'preview' ? '正在读取备份…' : preview ? preview.filename : '选择备份文件'}</strong><small>{preview ? `已识别为${preview.format === 'zip' ? '完整 ZIP 备份' : ' Excel 表格'} · 点击更换文件` : '支持 .zip / .xlsx，选择后先预览内容'}</small></span>
      </button>
      {busy === 'preview' && <p className="backup-import-hint" role="status">正在检查文件并整理图集，较大的备份需要一些时间，请保持窗口打开。</p>}
      {preview && <>
        <div className="backup-import-heading"><h3>备份内容</h3><span>{preview.albums.length} 个图集 · {preview.categories.length} 个分类</span></div>
        {preview.exportedAt && <p className="backup-import-hint">备份时间：{date(preview.exportedAt, true)}</p>}
        {preview.warnings.length > 0 && <details className="backup-import-warnings" open={preview.format === 'xlsx'}><summary><CircleAlert size={16}/>导入说明{preview.warnings.length > 1 ? `（${preview.warnings.length} 项）` : ''}</summary><ul>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
        {existingCount > 0 && <label className="backup-import-duplicates"><span>发现 {existingCount} 个已有图集</span><select aria-label="已有图集处理方式" value={duplicateMode} disabled={Boolean(busy)} onChange={e => { const mode = e.target.value as 'skip' | 'copy'; setDuplicateMode(mode); setSelected(new Set(preview.albums.filter(album => mode === 'copy' || !album.exists).map(album => album.key))); }}><option value="skip">跳过已有图集</option><option value="copy">作为新副本导入</option></select></label>}
        {preview.albums.length > 0 ? <div className="backup-import-albums">
          <label className="backup-import-select-all"><input type="checkbox" aria-label="全选可导入图集" checked={eligible.length > 0 && chosen.length === eligible.length} disabled={Boolean(busy) || !eligible.length} onChange={e => setSelected(new Set(e.target.checked ? eligible.map(album => album.key) : []))}/><span>选择要导入的图集</span><small>已选 {chosen.length} / {eligible.length}</small></label>
          <div className="backup-import-list">{preview.albums.map(album => {
            const skipped = album.exists && duplicateMode === 'skip';
            return <label className={`backup-import-album ${skipped ? 'is-skipped' : ''}`} key={album.key}><input type="checkbox" aria-label={`导入图集 ${album.title}`} checked={!skipped && selected.has(album.key)} disabled={Boolean(busy) || skipped} onChange={e => setSelected(previous => { const next = new Set(previous); if (e.target.checked) next.add(album.key); else next.delete(album.key); return next; })}/><span><strong>{album.title}</strong><small>{album.category} · {album.imageCount} 张图片 · {album.linkCount} 个链接</small><small>更新于 {date(album.updatedAt, true)}</small></span>{album.exists && <em>{skipped ? '已存在' : '新副本'}</em>}</label>;
          })}</div>
        </div> : <div className="backup-import-empty"><Folder size={22}/><p>{categoryOnly ? `此备份包含 ${preview.categories.length} 个空分类，可以导入分类结构。` : '此备份没有可导入的图集或分类。'}</p></div>}
        {existingCount > 0 && !eligible.length && <p className="backup-import-hint">这些图集已在图库中。如需再次导入，请选择“作为新副本导入”。</p>}
      </>}
      <p className="backup-note"><ShieldCheck size={17}/>导入会添加所选内容，现有图集、设置和网盘登录信息会保留。</p>
      {error && <div className="form-error" role="alert"><CircleAlert size={16}/>{error}</div>}
      {busy === 'commit' && <div className="backup-progress" role="status"><LoaderCircle className="spin" size={19}/>正在导入所选图集和图片，请稍候…</div>}
    </div>
    <div className="modal-actions backup-actions"><span>{preview ? `已选 ${chosen.length} 个图集 · ${chosen.reduce((sum, album) => sum + album.imageCount, 0)} 张图片` : '选择文件后确认导入'}</span><button className="button" disabled={Boolean(busy)} onClick={onClose}>取消</button><button className="button primary" disabled={Boolean(busy) || !preview || (!chosen.length && !categoryOnly)} onClick={() => void commit()}>{busy === 'commit' ? <LoaderCircle className="spin" size={17}/> : <Upload size={17}/>} {busy === 'commit' ? '正在导入…' : categoryOnly ? '导入分类' : `导入所选${chosen.length ? `（${chosen.length}）` : ''}`}</button></div>
  </Modal>;
}

function CategoryManager({ categories, albums, onClose, onChange, toast }: {
  categories: string[];
  albums: Album[];
  onClose: () => void;
  onChange: (result: CategoryResult, oldName?: string, newName?: string) => void;
  toast: (message: string) => void;
}) {
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function change(action: 'create' | 'rename' | 'remove', name?: string) {
    if (busy) return;
    const value = (action === 'create' ? newName : draft).trim();
    if (action !== 'remove' && !value) { setError('请输入分类名称'); return; }
    setBusy(true); setError('');
    try {
      const result = await api<CategoryResult>(name ? `/categories/${encodeURIComponent(name)}` : '/categories', {
        method: action === 'create' ? 'POST' : action === 'rename' ? 'PATCH' : 'DELETE',
        ...(action !== 'remove' ? { body: JSON.stringify({ name: value }) } : {}),
      });
      onChange(result, action === 'create' ? undefined : name, action === 'rename' ? value : undefined);
      setNewName(''); setEditing(null); setRemoving(null);
      toast(action === 'create' ? '分类已添加' : action === 'rename' ? '分类已重命名，相关图集已同步' : '分类已删除，相关图集已归入“未分类”');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <Modal title="管理分类" subtitle="按自己的方式，为每一份收藏命名。" onClose={() => !busy && onClose()}>
    <div className="category-manager-body">
      <form className="category-create-form" onSubmit={e => { e.preventDefault(); void change('create'); }}>
        <label className="field">新增分类<input aria-label="新分类名称" value={newName} onChange={e => setNewName(e.target.value)} placeholder="例如：旅行记录、壁纸收藏…" maxLength={80} disabled={busy} required/></label>
        <button className="button primary" disabled={busy || !newName.trim()}><Plus size={16}/>添加</button>
      </form>
      {error && <div className="form-error" role="alert"><CircleAlert size={15}/>{error}</div>}
      <div className="category-manager-list" aria-label="已有分类">
        {categories.map((name, i) => {
          const count = albums.filter(a => a.category === name).length;
          return <div className="category-manager-item" key={name}>
            {editing === name ? <form className="category-rename-form" onSubmit={e => { e.preventDefault(); void change('rename', name); }}>
              <input aria-label={`重命名分类 ${name}`} value={draft} onChange={e => setDraft(e.target.value)} maxLength={80} autoFocus disabled={busy} required/>
              <button className="icon-button" aria-label={`保存分类名称 ${name}`} title="保存" disabled={busy || !draft.trim()}><Check size={17}/></button>
              <button type="button" className="icon-button" aria-label="取消重命名" disabled={busy} onClick={() => { setEditing(null); setError(''); }}><X size={17}/></button>
            </form> : <div className="category-manager-row">
              <i className={`category-dot dot-${i % 5}`}/><span className="category-manager-name" title={name}>{name}</span><small>{count} 个图集</small>
              {name === '未分类' ? <span className="category-default-label">默认</span> : <div className="category-manager-actions">
                <button className="icon-button" aria-label={`重命名分类 ${name}`} title="重命名" disabled={busy} onClick={() => { setEditing(name); setDraft(name); setRemoving(null); setError(''); }}><Pencil size={15}/></button>
                <button className="icon-button" aria-label={`删除分类 ${name}`} title="删除分类" disabled={busy} onClick={() => { setRemoving(name); setEditing(null); setError(''); }}><Trash2 size={15}/></button>
              </div>}
            </div>}
            {removing === name && <div className="category-delete-prompt">
              <p>删除“{name}”？{count ? `${count} 个图集会移到“未分类”，图片和网盘链接会保留。` : '这个分类目前没有图集。'}</p>
              <div><button className="button small" disabled={busy} onClick={() => setRemoving(null)}>取消</button><button className="button danger small" disabled={busy} onClick={() => void change('remove', name)}>{busy ? '正在删除…' : '确认删除分类'}</button></div>
            </div>}
          </div>;
        })}
      </div>
      <p className="category-manager-tip"><Info size={14}/>重命名会同步到相关图集。“未分类”用于收纳未指定分类的图集，始终保留。</p>
    </div>
    <div className="modal-actions"><button className="button primary" disabled={busy} onClick={onClose}>完成</button></div>
  </Modal>;
}

function AlbumEditor({ album, categories, onClose, onSave, toast }: { album?: Album; categories: string[]; onClose: () => void; onSave: (a: Album) => Promise<void>; toast: (s: string) => void }) {
  const [title, setTitle] = useState(album?.title || ''); const [description, setDescription] = useState(album?.description || ''); const [category, setCategory] = useState(album?.category || '未分类'); const [tags, setTags] = useState(album?.tags.join('，') || '');
  const [links, setLinks] = useState<Partial<CloudLink>[]>(album?.links || []);
  const [files, setFiles] = useState<File[]>([]); const [previews, setPreviews] = useState<string[]>([]); const [saving, setSaving] = useState(false); const [dragging, setDragging] = useState(false); const [error, setError] = useState(''); const input = useRef<HTMLInputElement>(null);
  const [imageSource, setImageSource] = useState<'local' | 'remote'>('local');
  const [remoteImages, setRemoteImages] = useState('');
  const [remoteTouched, setRemoteTouched] = useState(false);
  const remote = useMemo(() => { try { return { urls: parseImageSources(remoteImages), error: '' }; } catch (e) { return { urls: [] as string[], error: (e as Error).message }; } }, [remoteImages]);
  useEffect(() => { const urls = files.map(f => URL.createObjectURL(f)); setPreviews(urls); return () => urls.forEach(u => URL.revokeObjectURL(u)); }, [files]);
  function addFiles(newFiles: File[]) { if (saving) return; const allowed = newFiles.filter(f => /\.(jpe?g|png|webp|gif|avif)$/i.test(f.name)); if(allowed.length !== newFiles.length) toast('支持 JPG、PNG、WebP、GIF、AVIF 图片'); if(allowed.some(f => f.size > 30 * 1024 * 1024)) { toast('单张图片不能超过 30 MB'); return; } if (files.length + allowed.length + remote.urls.length > MAX_IMAGE_SOURCES) { toast(`本地图片和网络图片每次合计最多导入 ${MAX_IMAGE_SOURCES} 张`); return; } setFiles(old => [...old, ...allowed]); if(!title && allowed[0]) setTitle(allowed[0].name.replace(/\.[^.]+$/, '')); }
  function patchLink(index: number, patch: Partial<CloudLink>) { setLinks(old => old.map((l, i) => i === index ? { ...l, ...patch } : l)); }
  async function save(e: React.FormEvent) {
    e.preventDefault(); setError(''); if(!title.trim()) { setError('请填写图集标题'); return; } if (remote.error) { setError(remote.error); setImageSource('remote'); setRemoteTouched(true); return; } if(!album && !files.length && !remote.urls.length) { setError('请选择本地图片，或粘贴网络图片地址'); return; }
    if (files.length + remote.urls.length > MAX_IMAGE_SOURCES) { setError(`本地图片和网络图片每次合计最多导入 ${MAX_IMAGE_SOURCES} 张`); return; }
    if ((album?.images.length || 0) + files.length + remote.urls.length > 1000) { setError('每个图集最多保存 1000 张图片'); return; }
    if(links.some(l => !l.url?.trim())) { setError('请填写网盘链接，或移除空的链接'); return; }
    setSaving(true);
    const metadata: AlbumInput = { title: title.trim(), description, category: category.trim() || '未分类', tags: [...new Set(tags.split(/[,，\s]+/).filter(Boolean))], links: links.map(l => ({ ...l, url: l.url?.trim() })) };
    try { let saved: Album; if(album && !files.length && !remote.urls.length) { saved = await api<Album>(`/albums/${album.id}`, { method: 'PATCH', body: JSON.stringify(metadata) }); } else { const fd = new FormData(); fd.append('metadata', JSON.stringify({ ...metadata, remoteImages })); files.forEach(f => fd.append('images', f)); saved = await api<Album>(album ? `/albums/${album.id}/images` : '/albums', { method: 'POST', body: fd }); } await onSave(saved); }
    catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  }
  return <Modal title={album ? '编辑图集' : '收藏新的光影'} subtitle={album ? '整理图片信息，让收藏井然有序。' : '导入喜欢的图片，创建一份属于你的收藏。'} onClose={() => !saving && onClose()} wide><form onSubmit={e => void save(e)}><div className="editor-body">
      <div className="image-import-tabs" role="group" aria-label="图片导入方式"><button type="button" aria-pressed={imageSource === 'local'} className={imageSource === 'local' ? 'active' : ''} disabled={saving} onClick={() => setImageSource('local')}><UploadCloud size={17}/>本地图片{files.length > 0 && <small>{files.length}</small>}</button><button type="button" aria-pressed={imageSource === 'remote'} className={imageSource === 'remote' ? 'active' : ''} disabled={saving} onClick={() => setImageSource('remote')}><Link2 size={17}/>网络图片{remote.urls.length > 0 && <small>{remote.urls.length}</small>}</button></div>
      {imageSource === 'local' ? <div className={`dropzone ${dragging ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); addFiles(Array.from(e.dataTransfer.files)); }}><UploadCloud size={30}/><h3>将图片拖到这里，或<button type="button" disabled={saving} onClick={() => input.current?.click()}>选择图片</button></h3><p>支持 JPG / PNG / WebP / GIF / AVIF · 单张不超过 30 MB</p><input type="file" multiple disabled={saving} accept="image/jpeg,image/png,image/webp,image/gif,image/avif" hidden ref={input} onChange={e => { addFiles(Array.from(e.target.files || [])); e.target.value = ''; }}/></div> : <div className="remote-image-input"><label className="field">图片链接<textarea aria-label="网络图片链接" aria-describedby="remote-image-hint" rows={5} value={remoteImages} onChange={e => setRemoteImages(e.target.value)} onBlur={() => setRemoteTouched(true)} disabled={saving} maxLength={256 * 1024} spellCheck={false} placeholder={'[img]https://example.com/photo.jpg[/img]\n[img]https://example.com/photo2.png[/img]\n或直接粘贴图片网址，每行一个'}/></label><p id="remote-image-hint"><Info size={15}/><span>支持 [img]…[/img] 和普通 HTTP / HTTPS 图片链接。保存时下载到本机，单张不超过 30 MB。</span></p>{remote.error && remoteTouched ? <div className="remote-image-error" role="alert"><CircleAlert size={15}/>{remote.error}</div> : remote.urls.length > 0 && <div className="remote-image-ready"><CheckCheck size={16}/><span>已识别 {remote.urls.length} 个图片地址，重复地址已合并</span><button type="button" disabled={saving} onClick={() => { setRemoteImages(''); setRemoteTouched(false); }}>清空链接</button></div>}</div>}
      {files.length > 0 && <div className="upload-previews">{files.map((f, i) => <div key={`${f.name}-${i}`}><img src={previews[i]} alt={f.name}/><button type="button" disabled={saving} aria-label={`移除待导入图片 ${f.name}`} onClick={() => setFiles(old => old.filter((_, j) => j !== i))}><X size={12}/></button>{i === 0 && !album && <span>封面</span>}</div>)}<span>{files.length} 张本地图片待导入</span></div>}
      {remote.urls.length > 0 && <p className="import-count"><CloudDownload size={15}/>另有 {remote.urls.length} 张网络图片将在保存时导入{files.length > 0 ? `，共 ${files.length + remote.urls.length} 张` : ''}</p>}
      <label className="field">图集标题 <span className="required">*</span><input value={title} onChange={e => setTitle(e.target.value)} placeholder="给这组照片起一个名字" maxLength={200} required/></label><div className="field-row"><label className="field">分类<input list="album-category-options" aria-label="分类" aria-describedby="category-input-hint" value={category} onChange={e => setCategory(e.target.value)} onFocus={e => e.currentTarget.select()} placeholder="选择或输入新分类" maxLength={80}/><datalist id="album-category-options">{categories.map(name => <option key={name} value={name}/>)}</datalist><small className="category-input-hint" id="category-input-hint">可直接输入新分类，保存后自动加入列表。</small></label><label className="field">标签 <span className="field-hint">用逗号分隔</span><input value={tags} onChange={e => setTags(e.target.value)} placeholder="旅行，风景，灵感" maxLength={500}/></label></div><label className="field">图集描述 <span className="field-hint">选填</span><textarea rows={2} value={description} onChange={e => setDescription(e.target.value)} placeholder="记录拍摄故事，或写下收藏的理由…" maxLength={2000}/></label>
      <div className="form-section-heading"><h3><Link2 size={16}/>网盘链接</h3><button type="button" onClick={() => setLinks(old => [...old, { label: '百度网盘', url: '', code: '', password: '', note: '', syncEnabled: true }])}><Plus size={15}/>添加链接</button></div>{!links.length && <button type="button" className="add-link-empty" onClick={() => setLinks([{ label: '百度网盘', url: '', code: '', password: '', note: '', syncEnabled: true }])}><Cloud size={21}/><div>关联一个网盘链接<small>百度网盘支持每日有效性检测，可选同步图集时间</small></div><Plus size={18}/></button>}{links.map((link, i) => <div className="link-editor" key={link.id || i}><div className="link-editor-heading"><span><Cloud size={16}/>资源链接 {i + 1}</span><button type="button" className="icon-button" aria-label={`移除链接 ${i + 1}`} onClick={() => setLinks(old => old.filter((_, j) => i !== j))}><X size={16}/></button></div><div className="field-row link-label-row"><label className="field">名称<input value={link.label || ''} onChange={e => patchLink(i, { label: e.target.value })} placeholder="百度网盘" maxLength={100}/></label><label className="field">分享链接<input type="url" value={link.url || ''} onChange={e => { const url = e.target.value; let code = link.code || ''; try { code = new URL(url).searchParams.get('pwd') || code; } catch {} patchLink(i, { url, code, syncEnabled: /https:\/\/(pan|yun)\.baidu\.com\//i.test(url) }); }} placeholder="https://pan.baidu.com/s/…" required/></label></div><div className="field-row"><label className="field">提取码<input value={link.code || ''} onChange={e => patchLink(i, { code: e.target.value })} placeholder="如 abcd" maxLength={20}/></label><label className="field">解压密码<input value={link.password || ''} onChange={e => patchLink(i, { password: e.target.value })} placeholder="选填" maxLength={100}/></label></div><label className="field">备注<input value={link.note || ''} onChange={e => patchLink(i, { note: e.target.value })} placeholder="下载或解压说明（选填）" maxLength={500}/></label><label className="checkbox-label"><input type="checkbox" checked={!!link.syncEnabled} onChange={e => patchLink(i, { syncEnabled: e.target.checked })}/><span>同步百度网盘文件的更新时间</span><span className="tiny-badge">24h</span></label></div>)}
      {error && <div className="form-error" role="alert"><CircleAlert size={16}/>{error}</div>}</div><div className="modal-actions"><span className="privacy-note"><ShieldCheck size={14}/>图片存储在本机</span><button type="button" className="button" disabled={saving} onClick={onClose}>取消</button><button className="button primary" disabled={saving}>{saving ? <LoaderCircle size={16} className="spin"/> : <Check size={16}/>} {saving ? remote.urls.length ? '正在下载并保存…' : '正在保存…' : album ? '保存修改' : '创建图集'}</button></div></form></Modal>;
}

function SyncCenter({ canManage, albums, syncing, checkingLinks, settings, onSync, onCheck, navigate, onSettings }: { canManage: boolean; albums: Album[]; syncing: boolean; checkingLinks: string | null; settings: GallerySettings | null; onSync: () => void; onCheck: (album?: Album, link?: CloudLink) => void; navigate: (s: string) => void; onSettings: () => void }) {
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | 'invalid' | 'attention'>('all');
  useEffect(() => { api<SyncLog[]>('/logs').then(value => { setLogs(value); setError(''); }).catch(e => setError(e.message)); }, [syncing, checkingLinks, albums]);
  const links = albums.flatMap(album => album.links.map(link => ({ ...link, album })));
  const valid = links.filter(link => healthStatus(link) === 'valid').length;
  const invalid = links.filter(link => healthStatus(link) === 'invalid').length;
  const needsAttention = (link: CloudLink) => !['valid', 'invalid', 'unsupported'].includes(healthStatus(link));
  const attention = links.filter(needsAttention).length;
  const visibleLinks = links.filter(link => filter === 'all' || (filter === 'invalid' ? healthStatus(link) === 'invalid' : needsAttention(link)));
  const busy = syncing || Boolean(checkingLinks);
  return <div className="sync-page">
    <section className="page-heading"><div><div className="eyebrow">ALWAYS UP TO DATE</div><h1>网盘同步<span className="heading-dot">.</span></h1><p>检查链接是否有效，也让图集更新时间有据可查。</p></div>{canManage && <div className="link-check-actions"><button className="button" disabled={busy || !links.some(link => link.syncEnabled)} onClick={onSync}><RefreshCw size={17} className={syncing ? 'spin' : ''}/>{syncing ? '同步中…' : '同步更新时间'}</button><button className="button primary" disabled={busy || !links.length} onClick={() => onCheck()}>{checkingLinks === 'all' ? <LoaderCircle size={17} className="spin"/> : <ShieldCheck size={17}/>} {checkingLinks === 'all' ? '正在检测…' : '检测全部链接'}</button></div>}</section>
    <div className="sync-stat-grid link-health-stats"><div><span className="stat-icon purple"><Link2 size={21}/></span><p>已关联链接<strong>{links.length}<small>个</small></strong></p></div><div><span className="stat-icon green"><CheckCheck size={21}/></span><p>链接有效<strong>{valid}<small>个</small></strong></p></div><div><span className="stat-icon rose"><CircleAlert size={21}/></span><p>已失效<strong>{invalid}<small>个</small></strong></p></div><div><span className="stat-icon amber"><Info size={21}/></span><p>待确认<strong>{attention}<small>个</small></strong></p></div></div>
    <div className="schedule-notice"><RefreshCw size={18}/><p>每日自动检查{settings?.autoSync ? '已开启' : '已暂停'}。{settings?.autoSync ? '每 24 小时检测百度链接有效性，关闭时间同步的链接也会检测。' : '手动检测仍可使用。'}</p>{canManage && <button onClick={onSettings}>检查设置<ArrowUpRight size={14}/></button>}</div>
    <section className="sync-links-section"><div className="section-title"><h2>网盘链接</h2><span>{links.length} 个资源</span></div>
      <div className="link-health-filters" aria-label="筛选链接状态">{([{ key: 'all', label: '全部链接', count: links.length }, { key: 'invalid', label: '已失效', count: invalid }, { key: 'attention', label: '待确认', count: attention }] as const).map(item => <button key={item.key} aria-pressed={filter === item.key} className={filter === item.key ? 'active' : ''} onClick={() => setFilter(item.key)}>{item.label}<span>{item.count}</span></button>)}</div>
      {visibleLinks.length ? visibleLinks.map(link => <div className={`sync-link-row health-row ${healthStatus(link) === 'invalid' ? 'health-row-invalid' : ''}`} key={`${link.album.id}/${link.id}`}>
        {link.album.images[0] ? <img src={link.album.images[0].thumbnailUrl} alt=""/> : <span className="health-row-placeholder"><Cloud size={25}/></span>}
        <div className="health-row-info"><button className="sync-album-title" onClick={() => navigate(`album/${link.album.id}`)}>{link.album.title}<ArrowUpRight size={13}/></button><div className="health-row-label"><span>{link.label || '网盘链接'}</span><LinkHealthBadge link={link}/></div><p>{link.health?.message || (isBaiduUrl(link.url) ? '尚未检测链接有效性。' : '暂不支持此网盘的自动检测，请打开链接确认。')}</p><small>有效性检测：{date(link.health?.checkedAt, true)}{link.health?.nextCheckAt ? ` · 下次：${date(link.health.nextCheckAt, true)}` : ''}</small>{link.syncEnabled && <small>时间同步：{link.status === 'success' ? '已同步' : link.status === 'error' ? '需处理' : '等待同步'}{link.remoteUpdatedAt ? ` · 网盘更新于 ${date(link.remoteUpdatedAt, true)}` : ''}</small>}</div>
        <div className="health-row-actions">{canManage && isBaiduUrl(link.url) && <button className="button small" aria-label={`检测链接 ${link.album.title} ${link.label}`} disabled={busy} onClick={() => onCheck(link.album, link)}>{checkingLinks === link.id ? <LoaderCircle className="spin" size={15}/> : <ShieldCheck size={15}/>} {checkingLinks === link.id ? '检测中…' : '检测链接'}</button>}<a className="health-open-link" href={link.url} target="_blank" rel="noopener noreferrer">打开链接<ArrowUpRight size={14}/></a></div>
      </div>) : <div className="empty-state compact">{links.length ? <CheckCheck size={32}/> : <Cloud size={32}/>}<h3>{links.length ? filter === 'invalid' ? '没有检测到失效的链接' : '没有待确认的链接' : '还没有关联网盘链接'}</h3><p>{links.length ? (canManage ? '可切换到“全部链接”查看或重新检测。' : '可切换到“全部链接”查看。') : (canManage ? '在图集编辑窗口添加网盘链接，即可在这里管理。' : '管理员添加网盘链接后，即可在这里查看。')}</p>{!links.length && <button className="button" onClick={() => navigate('all')}>前往图库</button>}</div>}
    </section>
    <section className="sync-logs"><div className="section-title"><h2>检查记录</h2><span>最近 100 条</span></div>{error && <div className="form-error">{error}</div>}{logs.length ? <div className="log-table"><div className="log-table-head"><span>检查时间</span><span>图集 / 结果</span><span>网盘更新时间</span></div>{logs.map(log => <div className="log-row" key={log.id}><span>{date(log.checkedAt, true)}</span><div><strong>{log.albumTitle}</strong><p className={log.healthStatus === 'invalid' ? 'text-invalid' : log.status === 'error' ? 'text-amber' : ''}>{log.status === 'error' ? <CircleAlert size={13}/> : <Check size={13}/>} {log.kind === 'health' ? '链接检测 · ' : '时间同步 · '}{log.message}</p></div><span>{log.kind === 'health' ? '未修改时间' : log.remoteUpdatedAt ? date(log.remoteUpdatedAt, true) : '未获取'}{log.changed && <small className="updated-badge">有更新</small>}</span></div>)}</div> : <div className="no-logs"><Clock3 size={20}/><span>完成首次检查后，记录会显示在这里。</span></div>}</section>
    <p className="sync-explanation"><Info size={16}/>目前支持百度网盘。只有明确失效、取消或过期的分享才标记为“失效”；需要登录、提取码、验证码或网络异常会单独提示。仅检测链接不会修改图集时间。</p>
  </div>;
}

function Lightbox({ images, index: initial, onClose }: { images: GalleryImage[]; index: number; onClose: () => void }) {
  const [index, setIndex] = useState(initial); const [zoom, setZoom] = useState(false); const ref = useRef<HTMLDivElement>(null);
  const go = useCallback((offset: number) => { setIndex(old => (old + offset + images.length) % images.length); setZoom(false); }, [images.length]);
  useEffect(() => { const oldOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; const handle = (e: KeyboardEvent) => { if(e.key === 'Escape') onClose(); if(e.key === 'ArrowLeft') go(-1); if(e.key === 'ArrowRight') go(1); }; window.addEventListener('keydown', handle); ref.current?.focus(); return () => { document.body.style.overflow = oldOverflow; window.removeEventListener('keydown', handle); }; }, [go, onClose]);
  const current = images[index];
  return <div className="lightbox" ref={ref} role="dialog" aria-modal="true" aria-label="大图浏览" tabIndex={-1}><div className="lightbox-header"><div><Images size={20}/><span>{current.name}</span><small>{index + 1} / {images.length}</small></div><div><button aria-label={zoom ? '缩小图片' : '放大图片'} onClick={() => setZoom(!zoom)}>{zoom ? <ZoomOut/> : <ZoomIn/>}</button><a href={current.url} download={current.name} aria-label="下载原图"><CloudDownload/></a><button aria-label="关闭大图" onClick={onClose}><X size={26}/></button></div></div><button className="lightbox-prev" aria-label="上一张" onClick={() => go(-1)}><ChevronLeft size={28}/></button><div className={`lightbox-image ${zoom ? 'zoomed' : ''}`} onClick={() => setZoom(!zoom)}><img src={current.url} alt={current.name}/></div><button className="lightbox-next" aria-label="下一张" onClick={() => go(1)}><ChevronRight size={28}/></button><div className="lightbox-footer"><span>{current.width} × {current.height} <i/> {size(current.size)}</span><span>← → 切换图片 <i/> ESC 退出</span></div></div>;
}
createRoot(document.getElementById('root')!).render(<AuthGate>{(user, logout) => <App key={`${user.userId}:${user.role}`} {...user} onLogout={logout}/>}</AuthGate>);
