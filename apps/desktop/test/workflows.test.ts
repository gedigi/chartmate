// Policy checks for the GitHub Actions workflows (least privilege, pinned actions, scoped secrets).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as { load(s: string): any };
const read = (f: string) => readFileSync(new URL(`../../../.github/workflows/${f}`, import.meta.url), 'utf8');
const files = ['ci.yml', 'desktop.yml', 'docker.yml'];

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

describe('pnpm pin', () => {
  it('pins pnpm by version and sha512 (corepack verifies it in the Docker build; pnpm/action-setup reads the version)', () => {
    const root = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { packageManager: string };
    expect(root.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/);
    for (const f of files) expect(read(f)).not.toMatch(/pnpm\/action-setup@[^\n]*\n\s+with:\s*\n\s+version:/);
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
  it('the release notes start with the tag\'s CHANGELOG.md section, above the signing table', () => {
    const steps = wf.jobs.release.steps as Step[];
    const checkout = steps.findIndex((s) => s.uses?.startsWith('actions/checkout@'));
    const download = steps.findIndex((s) => s.uses?.startsWith('actions/download-artifact@'));
    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(download).toBeGreaterThan(checkout); // a checkout after the download would clean the artifacts away
    const sparse = String(steps[checkout]!.with?.['sparse-checkout'] ?? '');
    expect(sparse).toContain('CHANGELOG.md');
    expect(sparse).toContain('apps/desktop/scripts/changelog-section.mjs');
    // The extraction runs in its own step, which holds no token.
    const extractIdx = steps.findIndex((s) => s.name === 'Changelog section for the tag');
    const createIdx = steps.findIndex((s) => /Create the GitHub Release/.test(s.name ?? ''));
    expect(extractIdx).toBeGreaterThan(download);
    expect(createIdx).toBeGreaterThan(extractIdx);
    const extract = steps[extractIdx]!;
    expect(extract.run).toContain('node apps/desktop/scripts/changelog-section.mjs CHANGELOG.md "$TAG" > changes.md');
    expect(Object.keys(extract.env ?? {})).toEqual(['TAG']);
    expect(JSON.stringify(extract)).not.toMatch(/GH_TOKEN|github\.token|secrets\./);
    const run = steps[createIdx]!.run!;
    expect(run).not.toContain('changelog-section.mjs');
    const table = run.indexOf('| Platform | Code signing |');
    const body = run.indexOf('cat changes.md');
    expect(body).toBeGreaterThan(run.indexOf('echo "## Chartmate ${TAG#v}"'));
    expect(table).toBeGreaterThan(body);
  });

  it('the release attaches the self-hosting compose.yaml and env.example from the tagged commit', () => {
    const steps = wf.jobs.release.steps as Step[];
    const checkout = steps.find((s) => s.uses?.startsWith('actions/checkout@'))!;
    const sparse = String(checkout.with?.['sparse-checkout'] ?? '');
    expect(sparse).toContain('compose.yaml');
    expect(sparse).toContain('.env.example');
    // GitHub renames assets with a leading dot, so the template ships as env.example.
    const stage = steps.find((s) => s.name === 'Self-hosting files')!;
    expect(stage.run).toContain('cp compose.yaml dist/compose.yaml');
    expect(stage.run).toContain('cp .env.example dist/env.example');
    expect(JSON.stringify(stage)).not.toMatch(/GH_TOKEN|github\.token|secrets\./);
    const create = steps.find((s) => /Create the GitHub Release/.test(s.name ?? ''))!;
    expect(create.run).toMatch(/dist\/compose\.yaml dist\/env\.example/);
  });

  it('a tag build fails early unless the tag equals the desktop app version', () => {
    const steps = wf.jobs.test.steps as Step[];
    const check = steps.find((s) => s.name === 'Tag matches the desktop version')!;
    expect(check.if).toBe("startsWith(github.ref, 'refs/tags/v')");
    expect(check.run).toContain(`node -p "require('./apps/desktop/package.json').version"`);
    expect(check.run).toContain('[ "${GITHUB_REF_NAME#v}" != "$version" ]');
    expect(check.run).toContain('::error');
    expect(check.run).toContain('exit 1');
    // Before anything slow runs.
    expect(steps.indexOf(check)).toBeLessThan(steps.findIndex((s) => s.run?.startsWith('pnpm install')));
  });

  it('macOS: notarizes and staples each dmg only when notarizing, in the packaging step that holds the Apple secrets', () => {
    const steps = wf.jobs['package-mac'].steps as Step[];
    const holders = (key: string) => steps.filter((s) => s.env && key in s.env).map((s) => s.name);
    for (const key of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'CSC_LINK', 'CSC_KEY_PASSWORD']) {
      expect(holders(key), key).toEqual(['Bundle, package, sign, notarize (macOS)']);
    }
    const run = steps.find((s) => s.name === 'Bundle, package, sign, notarize (macOS)')!.run!;
    expect(run).toMatch(/set -euo pipefail/);
    const build = run.indexOf('electron-builder --config');
    const gate = run.indexOf(`signingFor(process.env, 'darwin').notarize`);
    const submit = run.indexOf('xcrun notarytool submit');
    const staple = run.indexOf('xcrun stapler staple');
    const assess = run.indexOf('spctl -a -t open --context context:primary-signature');
    expect(build).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(build);
    expect(submit).toBeGreaterThan(gate);
    expect(staple).toBeGreaterThan(submit);
    expect(assess).toBeGreaterThan(staple);
    const submitLine = run.slice(submit, run.indexOf('\n', submit));
    expect(submitLine).toContain('--wait');
    expect(submitLine).toContain('--timeout 30m');
    expect(submitLine).toContain('--output-format json');
    // Only an Accepted submission passes; anything else prints the notary log and fails.
    expect(run).toContain('if [ "$status" != Accepted ]; then');
    const failBlock = run.slice(run.indexOf('if [ "$status" != Accepted ]; then'));
    expect(failBlock.indexOf('xcrun notarytool log "$id"')).toBeGreaterThan(0);
    expect(failBlock.indexOf('exit 1')).toBeGreaterThan(failBlock.indexOf('xcrun notarytool log "$id"'));
    expect(staple).toBeGreaterThan(run.indexOf('if [ "$status" != Accepted ]; then'));
    // Credentials come from the step env (masked), never inline.
    expect(submitLine).toMatch(/--apple-id "\$APPLE_ID" --team-id "\$APPLE_TEAM_ID" --password "\$APPLE_APP_SPECIFIC_PASSWORD"/);
    expect(run).toMatch(/for dmg in release\/\*\.dmg; do/);
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
  it('Certum: only a failed login or sign hook falls back (Windows rebuilt without Certum); a failed verification fails', () => {
    const job = wf.jobs['package-win'];
    const run = (job.steps as Step[]).find((s) => s.name === 'Bundle, package, sign (Windows)')!.run!;
    expect(run).toMatch(/if pwsh [^\n]*login\.ps1[^\n]*; then/);
    // The sign hook's own failure messages mark a hook failure (3); verification failure is 2 and exits the job.
    expect(run).toMatch(/grep -qE 'Certum signing failed\|refusing further attempts' [^\n]* && return 3/);
    expect(run).toContain('verify-win-signatures.mjs release');
    expect(run).toMatch(/\|\| return 2/);
    expect(run).toMatch(/if \[ "\$rc" = 2 \]; then[\s\S]*?::error title=Windows signature verification failed::[\s\S]*?exit 1/);
    expect(run).toMatch(/if \[ "\$rc" = 3 \]; then sign_failed=true; elif \[ "\$rc" != 0 \]; then exit 1; fi/);
    expect(run).toContain('::warning title=Windows signing step failed::');
    expect(run).toMatch(/unset CHARTMATE_WIN_CERT_SHA1 CHARTMATE_WIN_SIGN_LOG\n\s*build/);
    expect(run).toContain('echo "sign_failed=$sign_failed" >> "$GITHUB_OUTPUT"');
    expect(job.outputs.sign_failed).toBe('${{ steps.package.outputs.sign_failed }}');
    const notes = (wf.jobs.release.steps as Step[]).find((s) => /Create the GitHub Release/.test(s.name ?? ''))!;
    expect(notes.env!.WIN_SIGN_FAILED).toBe('${{ needs.package-win.outputs.sign_failed }}');
    expect(notes.run).toContain('Windows signing step failed in CI');
    expect(notes.run).toContain('sign:win');
    // "Unsigned" is claimed only from the method actually used (a fallback may still be signed another way).
    const failedBlock = /if \[ "\$WIN_SIGN_FAILED" = true \]; then[\s\S]*?fi/.exec(notes.run!)![0];
    expect(failedBlock).not.toMatch(/unsigned/i);
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

describe('docker.yml publish', () => {
  const wf = yaml.load(read('docker.yml'));
  it('publishes only when the tag equals the desktop app version (one version for app, image and tag)', () => {
    const steps = wf.jobs.publish.steps as Step[];
    const check = steps.find((s) => s.name === 'Check the tag')!;
    expect(check.run).toContain(`node -p "require('./apps/desktop/package.json').version"`);
    expect(check.run).toContain('[ "${GITHUB_REF_NAME#v}" != "$version" ]');
    expect(check.run).toContain('::error');
    const push = steps.findIndex((s) => s.uses?.startsWith('docker/build-push-action@'));
    expect(steps.indexOf(check)).toBeLessThan(push);
    expect(steps.indexOf(check)).toBeGreaterThan(steps.findIndex((s) => s.uses?.startsWith('actions/checkout@')));
  });
});
