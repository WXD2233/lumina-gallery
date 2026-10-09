export const HTTPS_REQUIRED_MESSAGE = '此地址未使用 HTTPS，已停止连接以保护密码。请通过 HTTPS 地址访问图库。';

export function isSecureTransport(location: Pick<Location, 'protocol' | 'hostname'>): boolean {
  return location.protocol === 'https:' || (location.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname.toLowerCase()));
}

export function assertSecureTransport(): void {
  if (typeof window !== 'undefined' && !isSecureTransport(window.location)) throw new Error(HTTPS_REQUIRED_MESSAGE);
}
