// Policy checks for the GitHub Actions workflows (least privilege, pinned actions, scoped secrets).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as { load(s: string): any };
const read = (f: string) => readFileSync(new URL(`../../../.github/workflows/${f}`, import.meta.url), 'utf8');
const files = ['ci.yml', 'desktop.yml'];

type Step = { uses?: string; with?: Record<string, unknown>; env?: Record<string, string>; name?: string; run?: string };

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
    expect(run).toMatch(/unsigned/i);
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
