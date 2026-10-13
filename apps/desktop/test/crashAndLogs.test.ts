import { describe, expect, it } from 'vitest';
import { createCrashPolicy } from '../src/lib/crashLimiter.js';
import { scrub } from '../src/lib/logger.js';
import { safeErr, serverLoggerOptions } from '../src/lib/serverLog.js';

describe('renderer crash policy', () => {
  it('reloads 3 times per minute, then shows the error page once, then gives up (no loop)', () => {
    let now = 0;
    const p = createCrashPolicy({ maxReloads: 3, maxErrorPages: 1, windowMs: 60_000, now: () => now });
    expect([p.onCrash(), p.onCrash(), p.onCrash()]).toEqual(['reload', 'reload', 'reload']);
    now = 10_000;
    expect(p.onCrash()).toBe('error-page');
    now = 20_000; // the error page itself crashed
    expect(p.onCrash()).toBe('give-up');
    expect(p.onCrash()).toBe('give-up');
  });

  it('recovers once the crashes are out of the window', () => {
    let now = 0;
    const p = createCrashPolicy({ now: () => now });
    for (let i = 0; i < 4; i++) p.onCrash();
    now = 61_000;
    expect(p.onCrash()).toBe('reload');
  });
});

describe('log hygiene', () => {
  it('scrubs absolute paths (POSIX, macOS, Windows) from log lines', () => {
    expect(scrub('failed at /Users/alice/Library/Application Support/Chartmate/altv.db')).not.toContain('alice');
    expect(scrub('open /home/bob/x.db')).toBe('open <path>');
    expect(scrub('at C:\\Users\\carol\\AppData\\Roaming\\Chartmate\\altv.db')).not.toContain('carol');
    expect(scrub('GET /api/bars?symbol=x')).toBe('GET /api/bars?symbol=x'); // URL paths stay
  });

  it('drops stack traces from JSON log lines', () => {
    const line = JSON.stringify({ level: 40, msg: 'x', err: { type: 'Error', message: 'boom', stack: 'Error: boom\n    at /Users/a/b.js:1:1' } });
    const out = scrub(line);
    expect(out).not.toContain('stack');
    expect(out).not.toContain('/Users/a');
    expect(JSON.parse(out).err.message).toBe('boom');
  });

  it('serializes errors without stack or paths', () => {
    const e = Object.assign(new Error('ENOENT: no such file, open \'/Users/x/secret.db\''), { code: 'ENOENT', statusCode: 503 });
    const s = safeErr(e);
    expect(s).toEqual({ type: 'Error', message: 'ENOENT: no such file, open \'<path>\'', code: 'ENOENT', statusCode: 503 });
    expect(JSON.stringify(s)).not.toContain('stack');
  });

  it('Fastify logger: warn level, redaction, safe serializers, request URLs without query strings', () => {
    const lines: string[] = [];
    const o = serverLoggerOptions((l) => lines.push(l));
    expect(o.level).toBe('warn');
    expect(o.redact).toEqual(expect.arrayContaining(['req.headers.cookie', 'req.headers.authorization']));
    expect(o.serializers.err).toBe(safeErr);
    expect(o.serializers.req({ method: 'GET', url: '/api/symbols/search?q=AAPL', headers: { cookie: 'x' } })).toEqual({ method: 'GET', url: '/api/symbols/search' });
    o.stream.write('{"msg":"a"}\n');
    expect(lines).toEqual(['{"msg":"a"}\n']);
  });
});
