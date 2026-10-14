// Policy checks for the GitHub Actions workflows (least privilege, pinned actions, scoped secrets).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as { load(s: string): any };
const read = (f: string) => readFileSync(new URL(`../../../.github/workflows/${f}`, import.meta.url), 'utf8');
const files = ['ci.yml', 'desktop.yml'];

type Step = { uses?: string; with?: Record<string, unknown>; env?: Record<string, string>; name?: string; run?: string; if?: string };

describe.each(files)('%s', (file) => {
  const text = read(file);
  const wf = yaml.load(text);
  const jobs = Object.entries(wf.jobs as Record<string, { steps: Step[]; env?: unknown; permissions?: unknown }>);

  it('defaults to a read-only token', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
  });

  it('pins every action to a full commit SHA with a version comment', () => {
    const uses = [...text.matchAll(/uses:\s*(\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, ref, rest] of uses) {
      expect(ref, ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      expect(rest, ref).toMatch(/#\s*v\d+\.\d+\.\d+/);
    }
  });

  it('never persists the checkout token', () => {
    for (const [, job] of jobs) {
      for (const s of job.steps.filter((x) => x.uses?.startsWith('actions/checkout@'))) expect(s.with?.['persist-credentials']).toBe(false);
    }
  });

  it('installs dependencies without running install scripts', () => {
    for (const m of text.matchAll(/pnpm install[^\n]*/g)) expect(m[0]).toContain('--ignore-scripts');
  });

  it('has no job-level env and no secrets outside a step env', () => {
    for (const [name, job] of jobs) {
      expect(job.env, name).toBeUndefined();
      for (const s of job.steps) {
        const { env: _env, ...rest } = s;
        expect(JSON.stringify(rest), `${name}: ${s.name ?? s.uses ?? s.run}`).not.toMatch(/secrets\./);
      }
    }
  });

  it('hardcodes no repository URL', () => {
    expect(text).not.toMatch(/github\.com\/[\w.-]+\/[\w.-]+/);
  });
});

describe('desktop.yml secret scoping and release', () => {
  const wf = yaml.load(read('desktop.yml'));
  const secretsOf = (job: string) => (wf.jobs[job].steps as Step[]).flatMap((s) => Object.values(s.env ?? {}).filter((v) => String(v).includes('secrets.')).map(String));

  it('the test job sees no secrets', () => {
    expect(secretsOf('test')).toEqual([]);
  });
  it('Apple secrets only on macOS, Windows signing secrets only on Windows', () => {
    const mac = secretsOf('package-mac').join(' ');
    const win = secretsOf('package-win').join(' ');
    expect(mac).toMatch(/CSC_LINK|APPLE_ID/);
    expect(mac).not.toMatch(/AZURE|WIN_CSC/);
    expect(win).toMatch(/AZURE_CLIENT_SECRET|WIN_CSC_LINK/);
    expect(win).not.toMatch(/APPLE|secrets\.CSC_LINK/);
    expect(wf.jobs['package-mac']['runs-on']).toMatch(/macos/);
    expect(wf.jobs['package-win']['runs-on']).toMatch(/windows/);
  });
  it('only the tag-only release job can write, and it holds no signing secrets', () => {
    for (const [name, job] of Object.entries(wf.jobs as Record<string, { permissions?: Record<string, string> }>)) {
      if (name === 'release') expect(job.permissions).toEqual({ contents: 'write' });
      else expect(job.permissions, name).toBeUndefined();
    }
    expect(wf.jobs.release.if).toMatch(/refs\/tags\/v/);
    expect(secretsOf('release')).toEqual([]);
    const run = (wf.jobs.release.steps as Step[]).map((s) => s.run ?? '').join('\n');
    expect(run).toMatch(/--repo "\$GITHUB_REPOSITORY"/);
    expect(run).toMatch(/--prerelease/);
    expect(run).toContain('*-*) prerelease=(--prerelease)'); // only suffixed tags (v1.2.3-beta.1) are pre-releases
    expect(run).toMatch(/unsigned/i);
  });
  it('Certum (SimplySign): login secrets only in the Windows packaging step, and only on tag builds', () => {
    const steps = wf.jobs['package-win'].steps as Step[];
    const holders = (key: string) => steps.filter((s) => s.env && key in s.env);
    for (const key of ['CHARTMATE_CERTUM_USERNAME', 'CHARTMATE_CERTUM_OTP_URI']) {
      expect(holders(key).map((s) => s.name), key).toEqual(['Bundle, package, sign (Windows)']);
      expect(holders(key)[0]!.env![key]).toBe(`\${{ startsWith(github.ref, 'refs/tags/v') && secrets.${key} || '' }}`);
    }
    for (const job of Object.keys(wf.jobs).filter((j) => j !== 'package-win')) expect(secretsOf(job).join(' '), job).not.toMatch(/CERTUM/);
    const pkg = holders('CHARTMATE_CERTUM_OTP_URI')[0]!;
    // The publisher name is not secret (a variable, so logs and notes are not masked) and is always present.
    expect(pkg.env!.CHARTMATE_WIN_PUBLISHER_NAME).toBe('${{ vars.CHARTMATE_WIN_PUBLISHER_NAME }}');
  });
  it('Certum: CI logs in first, unsets the login secrets before any build tool runs, then verifies', () => {
    const steps = wf.jobs['package-win'].steps as Step[];
    const run = steps.find((s) => s.name === 'Bundle, package, sign (Windows)')!.run!;
    const login = run.indexOf('scripts/certum/login.ps1');
    const unset = run.indexOf('unset CHARTMATE_CERTUM_USERNAME CHARTMATE_CERTUM_OTP_URI');
    const bundle = run.indexOf('node scripts/bundle.mjs');
    const build = run.indexOf('electron-builder --config');
    const verify = run.indexOf('scripts/verify-win-signatures.mjs release');
    expect(login).toBeGreaterThan(0);
    // The seed never reaches bundle.mjs, electron-builder (and its dependencies) or signtool.
    expect(unset).toBeGreaterThan(login);
    expect(bundle).toBeGreaterThan(unset);
    expect(build).toBeGreaterThan(unset);
    expect(verify).toBeGreaterThan(build);
    const beforeUnset = run.slice(0, unset).split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(beforeUnset).not.toMatch(/bundle\.mjs|electron-builder|pnpm /);
    expect(run).toContain('export CHARTMATE_WIN_CERT_SHA1');
    expect(run).toContain('--sign-log=');
    expect(run).toMatch(/set -euo pipefail/);
    // SimplySign Desktop is closed whatever happened, in a step that holds no secrets.
    const close = steps.find((s) => s.name === 'Close SimplySign Desktop')!;
    expect(close).toMatchObject({ if: 'always()' });
    expect(close.env).toBeUndefined();
  });
  it('Certum: a failed login or signing still ships the release, with an unsigned Windows build and a warning', () => {
    const job = wf.jobs['package-win'];
    const run = (job.steps as Step[]).find((s) => s.name === 'Bundle, package, sign (Windows)')!.run!;
    expect(run).toMatch(/if pwsh [^\n]*login\.ps1[^\n]*; then/);
    expect(run).toContain('sign_failed=true');
    expect(run).toContain('::warning title=Windows signing failed::');
    expect(run).toMatch(/unset CHARTMATE_WIN_CERT_SHA1 CHARTMATE_WIN_SIGN_LOG\n\s*build/);
    expect(run).toContain('echo "sign_failed=$sign_failed" >> "$GITHUB_OUTPUT"');
    expect(job.outputs.sign_failed).toBe('${{ steps.package.outputs.sign_failed }}');
    const notes = (wf.jobs.release.steps as Step[]).find((s) => /Create the GitHub Release/.test(s.name ?? ''))!;
    expect(notes.env!.WIN_SIGN_FAILED).toBe('${{ needs.package-win.outputs.sign_failed }}');
    expect(notes.run).toContain('Windows signing failed in CI');
    expect(notes.run).toContain('sign:win');
  });
  it('Certum: tag builds run in the windows-signing environment, other runs in none', () => {
    expect(wf.jobs['package-win'].environment).toBe("${{ startsWith(github.ref, 'refs/tags/v') && 'windows-signing' || '' }}");
    for (const job of Object.keys(wf.jobs).filter((j) => j !== 'package-win')) expect(wf.jobs[job].environment, job).toBeUndefined();
  });
  it('the release notes report the Windows signing method computed by build/signing.cjs', () => {
    expect(wf.jobs['package-win'].outputs.signing).toBe('${{ steps.package.outputs.signing }}');
    const step = (wf.jobs.release.steps as Step[]).find((s) => /Create the GitHub Release/.test(s.name ?? ''))!;
    expect(step.env!.WIN_SIGNING).toBe('${{ needs.package-win.outputs.signing }}');
    expect(step.run).toContain('| Windows (x64, arm64) | ${WIN_SIGNING} |');
    const pkgRun = (wf.jobs['package-win'].steps as Step[]).find((s) => s.name === 'Bundle, package, sign (Windows)')!.run!;
    expect(pkgRun).toContain(`signingFor(process.env, 'win32').method`);
  });
  it('both OS jobs smoke-test the shipped build with the expected signing state', () => {
    for (const job of ['package-mac', 'package-win']) {
      const smoke = (wf.jobs[job].steps as Step[]).find((s) => /Smoke test/.test(s.name ?? ''))!;
      expect(smoke.run, job).toMatch(/SMOKE_HARDENED_APP=/);
      expect(smoke.run, job).toMatch(/SMOKE_EXPECT_UNSIGNED=1/);
      expect(smoke.run, job).toMatch(/SMOKE_EXPECT_UNSIGNED=0/);
      expect(smoke.env?.SIGNING, job).toBe('${{ steps.package.outputs.signing }}');
    }
  });
});
