import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Fixed-size files and synchronous writes avoid building an unbounded logging queue. */
export class RuntimeLogger {
  private readonly recent = new Map<string, { at: number; suppressed: number }>();
  private windowStart = 0;
  private written = 0;
  private unavailableUntil = 0;
  constructor(private readonly directory: string, private readonly maxBytes = 2 * 1024 * 1024,
    private readonly copies = 3, private readonly clock = Date.now) {}

  error(scope: string, error: unknown): void {
    const now = this.clock();
    if (now < this.unavailableUntil) return;
    let key = scope.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'runtime';
    if (!this.recent.has(key) && this.recent.size >= 63) key = 'other';
    const previous = this.recent.get(key);
    if (previous && now - previous.at < 60_000) { previous.suppressed++; return; }
    if (now - this.windowStart >= 60_000) { this.windowStart = now; this.written = 0; }
    if (this.written >= 60) return;
    this.recent.set(key, { at: now, suppressed: 0 });
    this.written++;
    // Never log request bodies, URLs, password-bearing messages or arbitrary stack traces.
    const name = error instanceof Error ? error.name.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) : 'unknown';
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z_0-9]{1,32}$/.test(error.code) ? error.code : undefined;
    const line = JSON.stringify({ time: new Date(now).toISOString(), event: key, name, ...(code ? { code } : {}), ...(previous?.suppressed ? { suppressed: previous.suppressed } : {}) }) + '\n';
    try {
      mkdirSync(this.directory, { recursive: true });
      const path = join(this.directory, 'runtime.log');
      if (existsSync(path) && statSync(path).size + Buffer.byteLength(line) > this.maxBytes) {
        const last = `${path}.${this.copies - 1}`;
        if (existsSync(last)) unlinkSync(last);
        for (let index = this.copies - 2; index >= 1; index--) {
          if (existsSync(`${path}.${index}`)) renameSync(`${path}.${index}`, `${path}.${index + 1}`);
        }
        if (this.copies > 1) renameSync(path, `${path}.1`); else unlinkSync(path);
      }
      appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Disk-full/permission errors must not recursively log or create a retry queue.
      this.unavailableUntil = now + 60_000;
    }
  }
}

let runtimeLogger: RuntimeLogger | undefined;
export function configureRuntimeLogging(dataDirectory: string): void { runtimeLogger = new RuntimeLogger(join(dataDirectory, '.logs')); }
export function reportRuntimeError(scope: string, error: unknown): void { runtimeLogger?.error(scope, error); }
