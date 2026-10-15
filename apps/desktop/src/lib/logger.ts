import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface RotatingLog {
  readonly file: string;
  write(line: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string, err?: unknown): void;
}

const POSIX_PATH = /\/(?:Users|home|private|var|tmp|Applications|Volumes|opt|root|Library|System|usr)\/[^'"\n\r\t,;)]*/g;
const WINDOWS_PATH = /\b[A-Za-z]:\\{1,2}[^'"\n\r\t,;)]*/g;
const JSON_STACK = /,?"stack":"(?:[^"\\]|\\.)*"/g;

/** Replaces absolute file-system paths (user names, install locations) with `<path>`. */
export function scrubPaths(text: string): string {
  return text.replace(POSIX_PATH, '<path>').replace(WINDOWS_PATH, '<path>');
}

/**
 * Strips things that must never reach a log file: stack traces in JSON lines, absolute paths, URL credentials and
 * obvious secrets.
 */
export function scrub(text: string): string {
  return scrubPaths(text.replace(JSON_STACK, ''))
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1***@')
    .replace(/((?:password|passwd|secret|token|api[_-]?key|authorization|cookie|crumb)["']?\s*[:=]\s*["']?)[^"'\s,;&}]+/gi, '$1***');
}

/**
 * Wraps `write` so that at most `max` lines get through per `windowMs` (default 20 a minute). Lines over the limit
 * are counted, and the first line of a later window is preceded by one summary. For lines the renderer or the
 * network can trigger at will (blocked requests and navigations): each is a synchronous file append.
 */
export function createRateLimiter(
  write: (line: string) => void,
  opts: { max?: number; windowMs?: number; now?: () => number; what?: string } = {},
): (line: string) => void {
  const max = opts.max ?? 20;
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const what = opts.what ?? 'log';
  let windowStart = -Infinity;
  let count = 0;
  let suppressed = 0;
  return (line) => {
    const t = now();
    if (t - windowStart >= windowMs) {
      if (suppressed > 0) write(`${suppressed} more ${what} lines suppressed in the last minute`);
      windowStart = t;
      count = 0;
      suppressed = 0;
    }
    if (count < max) {
      count++;
      write(line);
    } else {
      suppressed++;
    }
  };
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
  /** Current size of `file`, read once and then tracked in memory (no stat per line). */
  let size: number | null = null;

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
      if (size === null) {
        mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
        size = existsSync(file) ? statSync(file).size : 0;
      }
      if (size >= maxBytes) {
        rotate();
        size = 0;
      }
      const text = scrub(line.endsWith('\n') ? line : `${line}\n`);
      appendFileSync(file, text, { mode: 0o600 });
      size += Buffer.byteLength(text);
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
