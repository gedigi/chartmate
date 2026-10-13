import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface RotatingLog {
  readonly file: string;
  write(line: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string, err?: unknown): void;
}

/** Strips things that must never reach a log file: URL query strings/credentials and obvious secrets. */
export function scrub(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1***@')
    .replace(/((?:password|passwd|secret|token|api[_-]?key|authorization|cookie|crumb)["']?\s*[:=]\s*["']?)[^"'\s,;&}]+/gi, '$1***');
}

/**
 * Tiny size-rotated log: `<dir>/<name>.log`, rotated to `.1` … `.<keep>` once it exceeds `maxBytes`. Synchronous
 * appends (low volume: warnings, errors, lifecycle), owner-only files. Never throws.
 */
export function createRotatingLog(opts: { dir: string; name?: string; maxBytes?: number; keep?: number; now?: () => Date }): RotatingLog {
  const name = opts.name ?? 'main';
  const maxBytes = opts.maxBytes ?? 1024 * 1024;
  const keep = opts.keep ?? 2;
  const now = opts.now ?? (() => new Date());
  const file = join(opts.dir, `${name}.log`);
  let ready = false;

  const rotate = () => {
    for (let i = keep; i >= 1; i--) {
      const src = i === 1 ? file : `${file}.${i - 1}`;
      if (!existsSync(src)) continue;
      if (i === keep) rmSync(`${file}.${i}`, { force: true });
      renameSync(src, `${file}.${i}`);
    }
  };

  const write = (line: string) => {
    try {
      if (!ready) {
        mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
        ready = true;
      }
      if (existsSync(file) && statSync(file).size >= maxBytes) rotate();
      appendFileSync(file, scrub(line.endsWith('\n') ? line : `${line}\n`), { mode: 0o600 });
    } catch {
      /* logging must never take the app down */
    }
  };
  const fmt = (level: string, msg: string) => `${now().toISOString()} ${level} ${msg}`;
  return {
    file,
    write,
    info: (m) => write(fmt('INFO', m)),
    warn: (m) => write(fmt('WARN', m)),
    error: (m, err) => write(fmt('ERROR', err instanceof Error ? `${m}: ${err.stack ?? err.message}` : err === undefined ? m : `${m}: ${String(err)}`)),
  };
}
