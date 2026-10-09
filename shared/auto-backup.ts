export interface AutoBackupSettings {
  enabled: boolean;
  /** 0 = Sunday, 1 = Monday, ... 6 = Saturday. */
  weekday: number;
  time: string;
  timeZone: 'Asia/Hong_Kong';
  retainCount: 7;
  lowSpaceGraceHours: 24;
}

export type AutoBackupSettingsInput = Partial<Pick<AutoBackupSettings, 'enabled' | 'weekday' | 'time'>>;
export interface WebDavSettings { enabled: boolean; url: string; username: string; hasPassword: boolean }
export type WebDavSettingsInput = Pick<WebDavSettings, 'enabled' | 'url' | 'username'> & { password?: string; clearPassword?: boolean };
export interface AutoBackupEntry {
  id: string;
  filename: string;
  createdAt: string;
  size: number;
  downloadUrl: string;
}

export type AutoBackupPhase = 'idle' | 'running' | 'waiting_space' | 'blocked' | 'failed' | 'success';
export interface AutoBackupStatus {
  settings: AutoBackupSettings;
  running: boolean;
  nextRunAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  phase: AutoBackupPhase;
  message: string;
  warningAt: string | null;
  cleanupAfter: string | null;
  retryAt: string | null;
  freeBytes: number | null;
  requiredBytes: number | null;
  reserveBytes: number;
  backups: AutoBackupEntry[];
  webdav?: WebDavSettings;
  /** API adds readiness of the administrator's saved email configuration. */
  emailReady?: boolean;
}

export interface AutoBackupNotice {
  kind: 'low_space' | 'stopped' | 'failed' | 'recovered';
  noticeId: string;
  createdAt: string;
  message: string;
}
