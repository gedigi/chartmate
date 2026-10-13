import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8'); // vitest runs with apps/web as cwd
const script = readFileSync(resolve(process.cwd(), 'public/theme-init.js'), 'utf8');
// Executes the (trusted, repo-owned) pre-paint script under test.
const run = () => { new Function(script)(); };

afterEach(() => {
  vi.restoreAllMocks();
  try { localStorage.clear(); } catch { /* ignore */ }
  document.documentElement.dataset.theme = 'dark';
});

describe('index.html pre-paint theme script', () => {
  it('is a classic (blocking) external script in <head>, before the app module', () => {
    expect(script).toContain("localStorage.getItem('altv.theme')");
    const tag = html.indexOf('<script src="/theme-init.js"></script>');
    expect(tag).toBeGreaterThan(-1);
    expect(tag).toBeLessThan(html.indexOf('</head>'));
    expect(tag).toBeLessThan(html.indexOf('type="module"'));
  });

  it('has no inline scripts or inline styles (strict CSP: no unsafe-inline)', () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style[\s>]/);
    expect(html).not.toMatch(/\sstyle=/);
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
