export interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
  setupAllowed: boolean;
  username?: string;
  userId?: number;
  role?: UserRole;
}

export type UserRole = 'admin' | 'viewer';
export interface AuthPrincipal { id: number; username: string; role: UserRole; }
export interface AdminUser {
  id: number;
  username: string;
  role: UserRole;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 128;
export const SESSION_HOURS = 8;
