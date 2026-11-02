// stateDir lock: advisory only. Live pid -> refuse to start. Dead pid -> assume stale
// and let the single recovery launcher take over. Teaching-grade limits (NOT guaranteed):
// concurrent stale takeover, PID reuse, network FS. We do not claim fd-level exclusivity.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class StateLock {
  private file: string;
  private held = false;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, 'LOCK');
  }

  acquire(): 'acquired' | 'refused-live-pid' | 'refused-malformed-lock' {
    if (existsSync(this.file)) {
      let holder: { pid: number; startedAt: number };
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
        if (typeof raw.pid !== 'number' || typeof raw.startedAt !== 'number') throw new Error('bad shape');
        holder = { pid: raw.pid, startedAt: raw.startedAt };
      } catch {
        // fail closed: a corrupt/truncated lock is never "obviously stale" to us.
        return 'refused-malformed-lock';
      }
      if (this.pidAlive(holder.pid)) {
        return 'refused-live-pid';
      }
      // dead pid: stale, single recovery launcher takes over
    }
    writeFileSync(this.file, JSON.stringify({ pid: process.pid, startedAt: Date.now() - process.uptime() }));
    this.held = true;
    return 'acquired';
  }

  private pidAlive(pid: number): boolean {
    if (pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  release(): void {
    if (!this.held) return;
    try {
      unlinkSync(this.file);
    } catch {
      // best effort
    }
    this.held = false;
  }
}
