import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import * as notices from '../../../scripts/third-party-notices.mjs';

type Pkg = { name: string; version: string; license: string; dir: string; pkg: Record<string, unknown> };
const { licenseAllowed, declaredLicense, collect, problems, render, licenseTexts } = notices as {
  licenseAllowed: (e: unknown) => boolean;
  declaredLicense: (p: Record<string, unknown>) => string;
  collect: (profile: string) => Pkg[];
  problems: (p: Pkg[]) => string[];
  render: (profile: string, p: Pkg[]) => string;
  licenseTexts: (p: Pkg) => { title: string; text: string }[];
};

describe('license allowlist (AGPL-3.0-compatible)', () => {
  it('accepts permissive and weak-copyleft licenses', () => {
    for (const l of ['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'MPL-2.0', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense', 'Python-2.0']) {
      expect(licenseAllowed(l), l).toBe(true);
    }
  });
  it('refuses unknown, proprietary, missing or malformed licenses', () => {
    for (const l of ['GPL-2.0-only', 'SSPL-1.0', 'BUSL-1.1', 'UNLICENSED', 'SEE LICENSE IN LICENSE.txt', '', undefined, '(MIT', 'MIT OR', 'MIT AND (GPL-2.0-only)']) {
      expect(licenseAllowed(l), String(l)).toBe(false);
    }
  });
  it('reads SPDX expressions: one allowed OR alternative is enough, every AND term must be allowed', () => {
    expect(licenseAllowed('(MIT OR GPL-3.0-only)')).toBe(true);
    expect(licenseAllowed('MIT AND Apache-2.0')).toBe(true);
    expect(licenseAllowed('(MIT AND BSD-3-Clause) OR SSPL-1.0')).toBe(true);
    expect(licenseAllowed('MIT AND SSPL-1.0')).toBe(false);
    expect(licenseAllowed('Apache-2.0 WITH LLVM-exception')).toBe(true);
  });
  it('reads the legacy licenses array as alternatives', () => {
    expect(declaredLicense({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe('(MIT OR Apache-2.0)');
    expect(declaredLicense({ license: { type: 'ISC' } })).toBe('ISC');
    expect(declaredLicense({})).toBe('');
  });
});

describe('dependency walk', () => {
  const server = collect('server');
  const desktop = collect('desktop');
  const names = (l: Pkg[]) => new Set(l.map((p) => p.name));

  it('the image lists the server runtime and what the web UI bundles, never Chartmate itself', () => {
    const n = names(server);
    for (const dep of ['fastify', 'better-sqlite3', 'pg', 'zod', 'react', 'react-dom', 'klinecharts']) expect(n.has(dep), dep).toBe(true);
    for (const own of ['@chartmate/shared', '@chartmate/server', '@chartmate/web']) expect(n.has(own), own).toBe(false);
    for (const tool of ['vite', 'vitest', 'typescript', 'esbuild', 'electron']) expect(n.has(tool), tool).toBe(false);
  });

  it('the desktop app lists Electron and its main-process packages, not the native or Postgres drivers', () => {
    const n = names(desktop);
    for (const dep of ['electron', 'electron-updater', 'undici', 'kysely', 'fastify', 'klinecharts']) expect(n.has(dep), dep).toBe(true);
    for (const absent of ['better-sqlite3', 'pg', 'electron-builder', '@electron/get']) expect(n.has(absent), absent).toBe(false);
  });

  it('every shipped dependency has an allowed license and a text to reproduce (the build gate)', () => {
    expect(problems(server)).toEqual([]);
    expect(problems(desktop)).toEqual([]);
  });

  it('renders full license texts, NOTICE files included, deterministically', () => {
    const text = render('server', server);
    expect(text).toContain('GNU Affero General Public License, version 3 only');
    expect(text).toMatch(/klinecharts 10\.\d+\.\d+\nLicense: Apache-2\.0/);
    expect(text).toContain('--- NOTICE ---');
    expect(text).toContain('Permission is hereby granted');
    expect(text).not.toContain(process.cwd());
    expect(render('server', collect('server'))).toBe(text);
  });
});

describe('packages without a license file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notices-'));
  writeFileSync(join(dir, 'package.json'), '{}');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('get what the package declares and the standard MIT or ISC text labeled as such, with no invented copyright', () => {
    const pkg = { name: 'x', author: 'Jane Doe <jane@example.com>', repository: { url: 'git+https://example.com/x.git' } };
    const [t] = licenseTexts({ name: 'x', version: '1.0.0', license: 'MIT', dir, pkg });
    expect(t!.title).toBe('MIT (declared in package.json; no license file was distributed with the package)');
    expect(t!.text).toContain('Declared author: Jane Doe <jane@example.com>\n');
    expect(t!.text).toContain('Declared repository: git+https://example.com/x.git\n');
    expect(t!.text).toContain('Standard text of the MIT License:\n\nPermission is hereby granted');
    expect(t!.text).not.toMatch(/Copyright \(c\)/);
    const [isc] = licenseTexts({ name: 'y', version: '1.0.0', license: 'ISC', dir, pkg: { name: 'y' } });
    expect(isc!.text).toContain('Declared author: none\nDeclared repository: none\n');
    expect(isc!.text).toContain('Standard text of the ISC License:\n\nPermission to use, copy, modify');
    expect(problems([{ name: 'x', version: '1.0.0', license: 'ISC', dir, pkg: { name: 'x' } }])).toEqual([]);
  });

  it('fail the gate for any other license', () => {
    expect(problems([{ name: 'x', version: '1.0.0', license: 'Apache-2.0', dir, pkg: { name: 'x' } }])).toEqual([
      'x@1.0.0: ships no LICENSE/NOTICE file to reproduce',
    ]);
  });
});

describe('the desktop roots cover what the main-process bundle contains', () => {
  // The same esbuild settings as scripts/bundle.mjs (signed build: main.cjs and updater.cjs), in memory.
  it('every npm package esbuild bundles is in the desktop notices', { timeout: 60_000 }, async () => {
    const { build } = await import('esbuild');
    const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
    const inputs = new Set<string>();
    for (const entry of ['../src/main.ts', '../src/updater.ts']) {
      const r = await build({
        entryPoints: [here(entry)], bundle: true, platform: 'node', target: 'node24', format: 'cjs', write: false,
        metafile: true, logLevel: 'silent', external: ['electron', './updater.cjs'],
        alias: { '@chartmate/shared': here('../../../packages/shared/src/index.ts') },
        define: {
          __WEB_ROOT_REL__: '"web"', __BUILD_SIGNED__: 'true', __RELEASES_URL__: '""', __WIN_PUBLISHER_DN__: '""',
          __TEST_INSPECTABLE__: 'false', __DEV_BUNDLE__: 'false', 'process.env.NODE_ENV': '"production"',
        },
      });
      for (const p of Object.keys(r.metafile.inputs)) inputs.add(p);
    }
    const bundled = new Set(
      [...inputs].map((p) => /.*node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(p)?.[1]).filter((n): n is string => !!n),
    );
    expect(bundled.size).toBeGreaterThan(10);
    const listed = new Set(collect('desktop').map((p) => p.name));
    expect([...bundled].filter((n) => !listed.has(n)).sort()).toEqual([]);
  });
});
