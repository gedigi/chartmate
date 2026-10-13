import { scrubPaths } from './logger.js';

/** Error → { type, message, code, statusCode } with absolute paths removed and no stack. */
export function safeErr(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { type: typeof err, message: scrubPaths(String(err)) };
  const e = err as Error & { code?: unknown; statusCode?: unknown };
  return {
    type: e.name,
    message: scrubPaths(e.message),
    ...(e.code !== undefined ? { code: e.code } : {}),
    ...(e.statusCode !== undefined ? { statusCode: e.statusCode } : {}),
  };
}

/** Request → method + path only (no query string, no headers, no remote address). */
function safeReq(req: { method?: string; url?: string; headers?: unknown }): Record<string, unknown> {
  return { method: req.method, url: (req.url ?? '').split('?')[0] };
}

/**
 * Fastify/pino options for the embedded server: warnings and errors only, written to the desktop log through
 * `write` (which scrubs secrets and paths again), with serializers that never emit stacks, headers or queries.
 */
export function serverLoggerOptions(write: (line: string) => void) {
  return {
    level: 'warn',
    stream: { write },
    redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    serializers: { err: safeErr, error: safeErr, req: safeReq, res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }) },
  };
}
