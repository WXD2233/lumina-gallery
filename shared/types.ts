export type SyncStatus = 'disabled' | 'pending' | 'success' | 'error';
export type LinkHealthStatus = 'unchecked' | 'valid' | 'invalid' | 'code_required' | 'code_error' | 'login_required' | 'verification_required' | 'network_error' | 'unknown' | 'unsupported';
export interface LinkCheckResult { status: Exclude<LinkHealthStatus, 'unchecked'>; message: string; }
export interface LinkHealth { status: LinkHealthStatus; message: string; checkedAt: string | null; nextCheckAt: string | null; }
export interface LinkCheckSummary { checked: number; valid: number; invalid: number; uncertain: number; unsupported: number; }
export interface GalleryImage { id: string; url: string; thumbnailUrl: string; name: string; width: number; height: number; size: number; }
export interface CloudLink { id: string; label: string; url: string; code: string; password: string; note: string; syncEnabled: boolean; status: SyncStatus; message: string; lastCheckedAt: string | null; nextCheckAt: string | null; remoteUpdatedAt: string | null; health?: LinkHealth; }
export interface Album { id: string; title: string; description: string; category: string; tags: string[]; createdAt: string; updatedAt: string; localUpdatedAt: string; updateSource: 'local' | 'baidu'; favorite: boolean; images: GalleryImage[]; links: CloudLink[]; isDemo?: boolean; }
export interface AlbumInput { title: string; description: string; category: string; tags: string[]; favorite?: boolean; links: Partial<CloudLink>[]; }
export interface GallerySettings { hasBaiduCookie: boolean; autoSync: boolean; intervalHours: number; }
export interface SyncLog { id: string; albumId: string; albumTitle: string; linkLabel: string; checkedAt: string; status: 'success' | 'error'; message: string; remoteUpdatedAt: string | null; changed: boolean; kind?: 'health' | 'sync'; healthStatus?: LinkHealthStatus; }
