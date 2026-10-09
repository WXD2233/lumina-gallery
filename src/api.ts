import { SESSION_EXPIRED_EVENT } from './auth';
import { assertSecureTransport } from './secure-transport';

export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  assertSecureTransport();
  const timeout = AbortSignal.timeout(!options?.method || options.method === 'GET' ? 30_000 : 300_000);
  const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(`/api${url}`, { ...options, signal, credentials: 'same-origin', cache: 'no-store', headers: { ...(options?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...options?.headers } });
  const value = await response.json().catch(() => {
    if (response.ok) throw new Error('服务器响应中断或格式无效，请重试');
    return {};
  });
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    throw new Error(value.error || value.message || '操作失败，请稍后再试');
  }
  return value;
}
