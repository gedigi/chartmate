import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    expect(run('--test-inspectable', `--out=${dist}/../dist/y`).status).toBe(2);
  });

  it('refuses --dev (the TEST-ONLY copy must stay a hardened production bundle)', () => {
    const r = run('--test-inspectable', '--dev', `--out=${join(mkdtempSync(join(tmpdir(), 'bundle-dev-')), 'x')}`);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--dev/);
  });

  it('refuses dist/ reached through a symlink', () => {
    mkdirSync(dist, { recursive: true });
    const link = join(mkdtempSync(join(tmpdir(), 'bundle-link-')), 'd');
    symlinkSync(dist, link, 'dir');
    expect(run('--test-inspectable', `--out=${link}/x`).status).toBe(2);
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')('refuses a case variant of dist/ on case-insensitive systems', () => {
    const variant = dist.replace(/dist$/, 'DIST');
    expect(run('--test-inspectable', `--out=${variant}/x`).status).toBe(2);
  });
});

describe("the desktop build targets Electron's Node.js, not the development Node.js", () => {
  // The main process and the embedded server run on the Node.js inside Electron (Electron 44: Node 24), which is
  // older than the Node.js the workspace develops on. Electron's own @types/node range names its Node major.
  const read = (p: string) => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8'));
  const electronNode = Number(/^\^?(\d+)\./.exec(read('../node_modules/electron/package.json').dependencies['@types/node'])![1]);

  it("esbuild targets Electron's Node major", () => {
    expect(readFileSync(script, 'utf8')).toContain(`target: 'node${electronNode}',`);
  });
  it("the desktop package typechecks against Electron's Node major (@types/node)", () => {
    expect(read('../package.json').devDependencies['@types/node']).toMatch(new RegExp(`^\\^${electronNode}\\.`));
  });
});
