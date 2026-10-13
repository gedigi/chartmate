import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/bundle.mjs', import.meta.url));
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

describe('bundle.mjs --test-inspectable', () => {
  it('refuses to run without --out', () => {
    const r = run('--test-inspectable');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/requires --out/);
  });
  it('refuses an --out inside dist/', () => {
    expect(run('--test-inspectable', `--out=${dist}`).status).toBe(2);
    expect(run('--test-inspectable', `--out=${dist}/x`).status).toBe(2);
  });
});
