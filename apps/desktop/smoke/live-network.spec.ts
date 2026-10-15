// Live-provider check (opt-in: SMOKE_LIVE=1, needs internet). Exercises Yahoo (search, daily + intraday bars,
// quotes) and the crypto provider through the real app and asserts nothing was blocked by the outbound allowlist.
// In development runs it also records every host the main process fetched (how the Yahoo host list was
// determined); packaged runs (SMOKE_APP = the TEST-ONLY inspectable copy) are driven over CDP, so only the results and the log are checked.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, chromium, expect, test, type Page } from '@playwright/test';
import { executableOf, requireDevBundle, spawnWithCdp } from './helpers.js';

test.skip(process.env.SMOKE_LIVE !== '1', 'set SMOKE_LIVE=1 to run against the live providers');

async function exercise(page: Page): Promise<Record<string, string>> {
  await page.waitForLoadState('load');
  const day = 86_400_000;
  return page.evaluate(async ({ now, day }) => {
    const get = async (p: string) => String((await fetch(p)).status);
    return {
      search: await get('/api/symbols/search?q=AAPL'),
      stockBars: await get(`/api/bars?symbol=stock%3AAAPL&tf=1D&session=rth&from=${now - 200 * day}&to=${now}`),
      stockIntraday: await get(`/api/bars?symbol=stock%3AMSFT&tf=1h&session=eth&from=${now - 5 * day}&to=${now}`),
      cryptoBars: await get(`/api/bars?symbol=crypto%3ABTC&tf=1D&session=rth&from=${now - 200 * day}&to=${now}`),
      quotes: await get('/api/quotes?symbols=stock%3AAAPL,crypto%3ABTC'),
    };
  }, { now: Date.now(), day });
}

test('live providers only touch allowlisted hosts', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'chartmate-live-'));
  const env = { ...process.env, CHARTMATE_USER_DATA_DIR: userData, CHARTMATE_PROVIDERS: 'live' } as Record<string, string>;
  for (const k of ['ELECTRON_RUN_AS_NODE', 'NODE_USE_ENV_PROXY', 'NODE_USE_SYSTEM_CA', 'NODE_EXTRA_CA_CERTS', 'SSLKEYLOGFILE', 'UNDICI_USE_MILO', 'UNDICI_NO_WASM_SIMD']) delete env[k];
  let results: Record<string, string>;
  if (process.env.SMOKE_APP) {
    const { child, wsUrl } = await spawnWithCdp(executableOf(process.env.SMOKE_APP), env);
    const browser = await chromium.connectOverCDP(wsUrl);
    try {
      const ctx = browser.contexts()[0]!;
      const page = ctx.pages().find((p) => p.url().startsWith('app://')) ?? await ctx.waitForEvent('page');
      results = await exercise(page);
      console.log(`[live] packaged results=${JSON.stringify(results)}`);
    } finally {
      await browser.close().catch(() => {});
      child.kill('SIGTERM');
    }
  } else {
    const appDir = fileURLToPath(new URL('..', import.meta.url));
    requireDevBundle(appDir);
    const app = await electron.launch({ args: [appDir], env });
    try {
      // Record hosts behind the allowlist guard (yahoo-finance2 resolves globalThis.fetch on every call).
      await app.evaluate(() => {
        const g = globalThis as unknown as { fetch: typeof fetch; __hosts: string[] };
        const inner = g.fetch;
        g.__hosts = [];
        g.fetch = ((input: string | URL | Request, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          g.__hosts.push(new URL(url).hostname);
          return inner(input, init);
        }) as typeof fetch;
      });
      results = await exercise(await app.firstWindow());
      const hosts = await app.evaluate(() => [...new Set((globalThis as unknown as { __hosts: string[] }).__hosts)].sort());
      console.log(`[live] results=${JSON.stringify(results)} yahoo-side hosts=${JSON.stringify(hosts)}`);
    } finally {
      await app.close();
    }
  }
  for (const [k, s] of Object.entries(results)) expect(s, k).toBe('200');
  expect(readFileSync(join(userData, 'logs', 'main.log'), 'utf8')).not.toMatch(/blocked outbound request/);
});
