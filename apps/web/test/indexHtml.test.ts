import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8'); // vitest runs with apps/web as cwd
const inline = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
// eslint-disable-next-line @typescript-eslint/no-implied-eval -- executes the inline script under test
const run = () => { new Function(inline)(); };

afterEach(() => {
  vi.restoreAllMocks();
  try { localStorage.clear(); } catch { /* ignore */ }
  document.documentElement.dataset.theme = 'dark';
});

describe('index.html pre-paint theme script', () => {
  it('lives in <head>, before the app module', () => {
    expect(inline).toContain("localStorage.getItem('altv.theme')");
    expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('</head>'));
  });

  it('applies the saved light theme', () => {
    localStorage.setItem('altv.theme', 'light');
    run();
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('falls back to dark when nothing is saved', () => {
    document.documentElement.dataset.theme = 'light';
    run();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('keeps the default when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(run).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
