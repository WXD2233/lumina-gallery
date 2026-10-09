export interface SecuritySettings {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  hasPassword: boolean;
  from: string;
  to: string[];
  notifyNewSourceLogin: boolean;
  notifyBruteForce: boolean;
}

export type SecuritySettingsInput = Partial<Omit<SecuritySettings, 'hasPassword'>> & {
  password?: string;
  clearPassword?: boolean;
};

export interface SecurityEventInput {
  type: 'login_success' | 'login_blocked' | 'account_changed' | 'backup_warning' | 'backup_failure' | 'backup_recovered';
  userId?: number;
  username?: string;
  source: string;
  userAgent?: string;
  detail?: string;
}

export interface SecurityEvent {
  id: string;
  type: SecurityEventInput['type'] | 'test';
  username: string;
  source: string;
  createdAt: string;
  detail: string;
  newSource: boolean;
  status: 'disabled' | 'pending' | 'sent' | 'failed' | 'skipped';
  error: string | null;
}
