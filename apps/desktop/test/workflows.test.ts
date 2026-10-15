// Policy checks for the GitHub Actions workflows (least privilege, pinned actions, scoped secrets).
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as { load(s: string): any };
const root = (f: string) => readFileSync(new URL(`../../../${f}`, import.meta.url), 'utf8');
const read = (f: string) => root(`.github/workflows/${f}`);
const files = ['ci.yml', 'desktop.yml', 'docker.yml'];

type Step = { uses?: string; with?: Record<string, unknown>; env?: Record<string, string>; name?: string; run?: string; if?: string; id?: string; shell?: string };
type Job = { steps: Step[]; env?: unknown; permissions?: unknown; environment?: string; needs?: string[]; if?: string; outputs?: Record<string, string>; 'runs-on': string };

const SIGN = "startsWith(github.ref, 'refs/tags/v') && vars.CHARTMATE_MAC_SIGN_IDENTITY != ''";
const COREPACK_RUN = [
  'set -euo pipefail',
  'corepack enable pnpm',
  `want="$(node -p "require('./package.json').packageManager.split('@')[1].split('+')[0]")"`,
  'got="$(pnpm --version)"',
  'if [ "$got" != "$want" ]; then',
  '  echo "::error title=pnpm version::pnpm $got, but package.json pins $want"',
  '  exit 1',
  'fi',
  '',
].join('\n');
const runs = (steps: Step[]) => steps.map((s) => s.run ?? '').join('\n');
const secretKeys = (s: Step) => Object.entries(s.env ?? {}).filter(([, v]) => String(v).includes('secrets.')).map(([k]) => k);

describe.each(files)('%s', (file) => {
  const text = read(file);
  const wf = yaml.load(text);
  const jobs = Object.entries(wf.jobs as Record<string, Job>);

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

  it('gets pnpm from corepack (sha512-checked against packageManager) before any job runs pnpm', () => {
    expect(text).not.toContain('pnpm/action-setup');
    for (const [name, job] of jobs) {
      const first = job.steps.findIndex((s) => /(^|\n)\s*pnpm /.test(s.run ?? '') && !/corepack enable pnpm/.test(s.run ?? ''));
      if (first < 0) continue;
      const corepack = job.steps.findIndex((s) => s.name === 'pnpm (corepack)');
      expect(corepack, name).toBeGreaterThanOrEqual(0);
      // The pnpm that runs is exactly the one package.json pins (corepack checks its sha512).
      expect(job.steps[corepack]!.run, name).toBe(COREPACK_RUN);
      expect(job.steps[corepack]!.shell, name).toBe('bash');
      expect(corepack, name).toBeLessThan(first);
      expect(job.steps.findIndex((s) => s.uses?.startsWith('actions/setup-node@')), name).toBeLessThan(corepack);
    }
  });
});

describe('ci.yml Postgres job', () => {
  const wf = yaml.load(read('ci.yml'));
  const job = wf.jobs.postgres as { services: { postgres: { image: string } }; steps: Step[] };

  it('runs the server DB suites against a digest-pinned Postgres, the same image compose.yaml pins', () => {
    const image = job.services.postgres.image;
    expect(image).toMatch(/^postgres:[\w.-]+@sha256:[0-9a-f]{64}$/);
    const compose = yaml.load(readFileSync(new URL('../../../compose.yaml', import.meta.url), 'utf8'));
    expect(image).toBe(compose.services.postgres.image);
    const step = job.steps.find((s) => s.name === 'Server DB suites on Postgres')!;
    expect(step.env?.CHARTMATE_TEST_DB).toBe('postgres');
    expect(step.env?.TEST_PG_URL).toMatch(/^postgres:\/\/.+@localhost:5432\//);
    for (const dir of ['test/db', 'test/market', 'test/baskets', 'test/routes', 'test/http']) expect(step.run).toContain(dir);
  });
});

describe('toolchain pins', () => {
  it('pins pnpm by version and sha512 (corepack verifies it in CI and in the Docker build)', () => {
    const pkg = JSON.parse(root('package.json')) as { packageManager: string };
    expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/);
  });
  it('pins Node.js to an exact version for every workflow (.nvmrc)', () => {
    expect(root('.nvmrc').trim()).toMatch(/^\d+\.\d+\.\d+$/);
    for (const f of files) {
      for (const m of read(f).matchAll(/node-version(-file)?:\s*(\S+)/g)) expect(m[0], f).toBe('node-version-file: .nvmrc');
    }
  });
  it('caches dependencies only in ci.yml (pull requests and main), never on a release path', () => {
    for (const f of ['desktop.yml', 'docker.yml']) {
      expect(read(f), f).not.toMatch(/^\s+cache:|actions\/cache@/m);
    }
    expect(read('ci.yml')).toMatch(/actions\/cache@[0-9a-f]{40}/);
    expect(yaml.load(read('ci.yml')).on).toEqual({ pull_request: null, push: { branches: ['main'] } });
  });
  it('the license gate runs in CI and before every release', () => {
    for (const [f, job] of [['ci.yml', 'check'], ['desktop.yml', 'test'], ['docker.yml', 'test']] as const) {
      expect(runs(yaml.load(read(f)).jobs[job].steps), f).toContain('pnpm licenses:check');
    }
    expect(JSON.parse(root('package.json')).scripts['licenses:check']).toBe(
      'node scripts/third-party-notices.mjs --profile=server --check && node scripts/third-party-notices.mjs --profile=desktop --check',
    );
  });
});

describe('dependabot.yml', () => {
  const cfg = yaml.load(root('.github/dependabot.yml')) as { updates: { 'package-ecosystem': string; cooldown?: { 'default-days': number } }[] };
  it('waits before proposing a fresh release: npm a week, actions and images three days', () => {
    const days = Object.fromEntries(cfg.updates.map((u) => [u['package-ecosystem'], u.cooldown?.['default-days']]));
    expect(days).toEqual({ npm: 7, 'github-actions': 3, docker: 3, 'docker-compose': 3 });
  });
});

describe('desktop.yml secret scoping and release', () => {
  const wf = yaml.load(read('desktop.yml'));
  const job = (name: string) => wf.jobs[name] as Job;
  const steps = (name: string) => job(name).steps;
  const secretsOf = (name: string) => steps(name).flatMap((s) => Object.values(s.env ?? {}).filter((v) => String(v).includes('secrets.')).map(String));
  const holders = (name: string, key: string) => steps(name).filter((s) => s.env && key in s.env).map((s) => s.name);
  const APPLE = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
  const MAC_SIGNING_JOBS = ['sign-mac', 'notarize-mac-dmg'];

  it('the jobs that run dependency code see no Apple secret, and only the signing jobs use an environment', () => {
    for (const name of Object.keys(wf.jobs)) {
      if (MAC_SIGNING_JOBS.includes(name)) {
        expect(job(name).environment, name).toBe('macos-signing');
      } else {
        expect(secretsOf(name).join(' '), name).not.toMatch(/secrets\.(CSC_|APPLE_)/);
        if (name !== 'package-win') expect(job(name).environment, name).toBeUndefined();
      }
    }
    expect(secretsOf('test')).toEqual([]);
    expect(secretsOf('package-mac')).toEqual([]);
    expect(secretsOf('dist-mac')).toEqual([]);
    expect(secretsOf('release')).toEqual([]);
    expect(secretsOf('package-win').join(' ')).toMatch(/AZURE_CLIENT_SECRET|WIN_CSC_LINK/);
    for (const name of Object.keys(wf.jobs)) expect(job(name)['runs-on'], name).toMatch(name.includes('win') ? /windows/ : name.includes('mac') ? /macos/ : /ubuntu/);
  });

  it('macOS signing jobs run no dependency code: no Node.js setup, no package manager, only the signing script and plists', () => {
    for (const name of MAC_SIGNING_JOBS) {
      const s = steps(name);
      for (const step of s) {
        if (step.uses) expect(step.uses, name).toMatch(/^actions\/(checkout|download-artifact|upload-artifact)@/);
        expect(step.run ?? '', `${name}: ${step.name}`).not.toMatch(/\b(pnpm|npm|npx|node|yarn|corepack|electron-builder)\b/);
      }
      const checkout = s.find((x) => x.uses?.startsWith('actions/checkout@'))!;
      expect(checkout.with?.['sparse-checkout-cone-mode']).toBe(false);
      const patterns = String(checkout.with?.['sparse-checkout']).trim().split('\n').map((l) => l.trim());
      for (const p of patterns) expect(p, name).toMatch(/^\/(\.github\/scripts\/macos-sign\.sh|apps\/desktop\/build\/entitlements\.mac(\.inherit)?\.plist)$/);
      // Each secret sits only in the step that needs it, and the keychain is always deleted.
      for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD']) expect(holders(name, key), key).toEqual(['Import the Developer ID certificate (temporary keychain, key not extractable)']);
      for (const key of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) expect(holders(name, key), key).toEqual(['Notarization credentials (keychain profile)']);
      for (const step of s) for (const k of secretKeys(step)) expect(APPLE, `${name}: ${k}`).toContain(k);
      const cleanup = s.at(-1)!;
      expect(cleanup).toMatchObject({ name: 'Delete the keychain', if: 'always()', run: '.github/scripts/macos-sign.sh cleanup' });
    }
  });

  it('macOS signing runs only on tags with the identity variable set; the unsigned build skips it', () => {
    // Decided from the ref and the repository variable only, never from an output of a job that ran dependency code.
    expect(job('package-mac').outputs).toBeUndefined();
    expect(read('desktop.yml')).not.toContain('needs.package-mac.outputs');
    expect(job('sign-mac').if).toBe(SIGN);
    expect(job('notarize-mac-dmg').if).toBe(SIGN);
    const pkg = steps('package-mac').find((s) => s.name === 'Bundle and package the apps (unsigned)')!;
    expect(pkg.env!.SIGN).toBe(`\${{ ${SIGN} }}`);
    expect(job('notarize-mac-dmg').needs).toEqual(['package-mac', 'sign-mac', 'dist-mac']);
    // dist-mac never runs after a failed or cancelled signing run.
    expect(job('dist-mac').if).toContain("needs.sign-mac.result == 'success' || (needs.sign-mac.result == 'skipped' && !(startsWith(github.ref, 'refs/tags/v') && vars.CHARTMATE_MAC_SIGN_IDENTITY != ''))");
  });

  it('a tag build without the macOS identity fails before any dependency code, unless unsigned macOS is allowed', () => {
    const s = steps('test');
    const plan = s.find((x) => x.name === 'macOS signing plan')!;
    expect(plan.if).toBe("startsWith(github.ref, 'refs/tags/v')");
    expect(plan.env).toEqual({
      IDENTITY: '${{ vars.CHARTMATE_MAC_SIGN_IDENTITY }}',
      ALLOW_UNSIGNED: '${{ vars.CHARTMATE_ALLOW_UNSIGNED_MAC }}',
    });
    expect(s.indexOf(plan)).toBeLessThan(s.findIndex((x) => x.name === 'pnpm (corepack)'));
    const run = (env: Record<string, string>) => spawnSync('/bin/bash', ['-e', '-c', plan.run!], { env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8' });
    expect(run({ IDENTITY: '', ALLOW_UNSIGNED: '' }).status).toBe(1);
    expect(run({ IDENTITY: '', ALLOW_UNSIGNED: '' }).stdout).toContain('::error title=macOS would ship unsigned::');
    expect(run({ IDENTITY: '', ALLOW_UNSIGNED: 'true' }).status).toBe(0);
    expect(run({ IDENTITY: 'Developer ID Application: X (T)', ALLOW_UNSIGNED: '' }).status).toBe(0);
  });

  it('package-mac bundles (updater in only for a signed build) and packages without any signing identity', () => {
    const pkg = steps('package-mac').find((s) => s.name === 'Bundle and package the apps (unsigned)')!;
    expect(secretKeys(pkg)).toEqual([]);
    expect(pkg.run).toContain('CSC_NAME="$IDENTITY" node scripts/bundle.mjs --platform=darwin');
    const builder = pkg.run!.split('\n').find((l) => l.trim().startsWith('pnpm exec electron-builder'))!;
    expect(builder).not.toMatch(/CSC_|identity/i);
    expect(builder).toContain('--publish never');
    expect(pkg.run).toContain('tar -C release -cf "$RUNNER_TEMP/mac-apps.tar" mac/Chartmate.app mac-arm64/Chartmate.app');
  });

  it('sign-mac signs inside-out, then notarizes and staples, with the Apple tools only', () => {
    const run = runs(steps('sign-mac'));
    expect(run).toContain('.github/scripts/macos-sign.sh sign-app "$app" apps/desktop/build/entitlements.mac.plist apps/desktop/build/entitlements.mac.inherit.plist');
    expect(run.indexOf('macos-sign.sh notarize "$app"')).toBeGreaterThan(run.indexOf('macos-sign.sh sign-app'));
    const script = root('.github/scripts/macos-sign.sh');
    expect(script).toMatch(/security import "\$P12" -k "\$KEYCHAIN" -f pkcs12 -P "\$CSC_KEY_PASSWORD" -x -T \/usr\/bin\/codesign/);
    expect(script).toContain('security set-key-partition-list -S apple-tool:,apple: -s');
    expect(script).toContain('--options runtime');
    expect(script).toContain('--timestamp');
    expect(script).toContain('codesign --verify --deep --strict --verbose=2 "$app"');
    expect(script).toMatch(/xcrun notarytool submit "\$upload" --keychain-profile "\$PROFILE" --keychain "\$KEYCHAIN" --wait --timeout 30m/);
    expect(script).toContain('if [ "$status" != Accepted ]; then');
    expect(script).toContain('xcrun stapler staple "$target"');
    expect(script).toContain('spctl -a -t open --context context:primary-signature -v "$target"');
    expect(script).toContain('spctl -a -t exec -vv "$target"');
    // The decoded .p12 never outlives the import, and nothing in the script uses Node.js or npm.
    expect(script).toContain('trap on_exit EXIT'); // removes the decoded .p12 (tests: macosSign.test.ts)
    const code = script.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(code).not.toMatch(/\b(node|npm|npx|pnpm)\b/);
  });

  it('dist-mac builds dmg, zip, blockmaps and one latest-mac.yml from the signed apps, signing nothing', () => {
    const dist = steps('dist-mac');
    const download = dist.find((s) => s.uses?.startsWith('actions/download-artifact@'))!;
    expect(download.with!.name).toBe("${{ (startsWith(github.ref, 'refs/tags/v') && vars.CHARTMATE_MAC_SIGN_IDENTITY != '') && 'mac-apps-signed' || 'mac-apps' }}");
    const pkg = dist.find((s) => /prepackaged/.test(s.name ?? ''))!;
    expect(pkg.run).toMatch(/electron-builder --config electron-builder\.config\.cjs --mac dmg zip "--\$arch" \\\n\s+--prepackaged "\$RUNNER_TEMP\/apps\/\$dir\/Chartmate\.app" --publish never/);
    expect(pkg.run).toContain('rm -rf release');
    expect(pkg.run).toContain('node scripts/merge-update-info.mjs "$RUNNER_TEMP/latest-mac-x64.yml" "$RUNNER_TEMP/latest-mac-arm64.yml" > release/latest-mac.yml');
  });

  it('notarize-mac-dmg signs a dmg only after proving it holds the app sign-mac signed (cdhash)', () => {
    expect(job('sign-mac').outputs).toMatchObject({
      cdhash_x64: '${{ steps.cdhash.outputs.x64 }}',
      cdhash_arm64: '${{ steps.cdhash.outputs.arm64 }}',
    });
    const rec = steps('sign-mac').find((s) => s.id === 'cdhash')!;
    expect(rec.run).toContain('echo "x64=$(.github/scripts/macos-sign.sh cdhash "$RUNNER_TEMP/apps/mac/Chartmate.app")"');
    expect(rec.run).toContain('echo "arm64=$(.github/scripts/macos-sign.sh cdhash "$RUNNER_TEMP/apps/mac-arm64/Chartmate.app")"');
    const ns = steps('notarize-mac-dmg');
    const check = ns.find((s) => s.name === 'The dmgs hold the signed apps')!;
    expect(check.env).toEqual({ CDHASH_X64: '${{ needs.sign-mac.outputs.cdhash_x64 }}', CDHASH_ARM64: '${{ needs.sign-mac.outputs.cdhash_arm64 }}' });
    expect(check.run).toContain('.github/scripts/macos-sign.sh check-dmg "$dmg" "$expected"');
    // Checked before the key is even imported.
    expect(ns.indexOf(check)).toBeLessThan(ns.findIndex((s) => /^Import the Developer ID/.test(s.name ?? '')));
  });

  it('notarize-mac-dmg signs, notarizes and staples each dmg before it is released', () => {
    const run = runs(steps('notarize-mac-dmg'));
    expect(run).toMatch(/for dmg in "\$RUNNER_TEMP"\/dmg\/\*\.dmg; do\n\s+\.github\/scripts\/macos-sign\.sh sign-dmg "\$dmg"\n\s+if \[ "\$NOTARIZE" = true \]; then \.github\/scripts\/macos-sign\.sh notarize "\$dmg"; fi/);
    const uploads = (name: string) => steps(name).filter((s) => s.uses?.startsWith('actions/upload-artifact@')).map((s) => String(s.with!.name));
    expect(uploads('notarize-mac-dmg')).toEqual(['desktop-macos-dmg']);
    // A signed build's dmgs reach the release only through notarize-mac-dmg.
    expect(uploads('dist-mac')).toEqual(['desktop-macos', "${{ (startsWith(github.ref, 'refs/tags/v') && vars.CHARTMATE_MAC_SIGN_IDENTITY != '') && 'mac-dmg-unsigned' || 'desktop-macos-dmg' }}"]);
    expect(uploads('package-mac')).toEqual(['mac-apps']);
    expect(uploads('sign-mac')).toEqual(['mac-apps-signed']);
    // The release downloads exactly the three release artifacts by name (no pattern), then checks the file set.
    const rs = steps('release');
    const downloads = rs.filter((s) => s.uses?.startsWith('actions/download-artifact@'));
    expect(downloads.map((d) => d.with)).toEqual(['desktop-macos', 'desktop-macos-dmg', 'desktop-windows'].map((name) => ({ name, path: 'dist' })));
    const check = rs.find((s) => s.name === 'Release assets')!;
    expect(check.run).toContain('node scripts/check-release-assets.mjs dist "${TAG#v}"');
    expect(JSON.stringify(check)).not.toMatch(/GH_TOKEN|github\.token|secrets\./);
    expect(rs.indexOf(check)).toBeGreaterThan(rs.indexOf(downloads.at(-1)!));
    expect(rs.indexOf(check)).toBeLessThan(rs.findIndex((s) => s.name === 'Self-hosting files'));
    expect(String(rs[0]!.with?.['sparse-checkout'])).toContain('/scripts/check-release-assets.mjs');
  });

  it('only the tag-only release job can write, and it holds no signing secrets', () => {
    for (const [name, j] of Object.entries(wf.jobs as Record<string, { permissions?: Record<string, string> }>)) {
      if (name === 'release') expect(j.permissions).toEqual({ contents: 'write' });
      else expect(j.permissions, name).toBeUndefined();
    }
    expect(job('release').if).toMatch(/startsWith\(github\.ref, 'refs\/tags\/v'\)/);
    expect(job('release').if).toContain("(!(startsWith(github.ref, 'refs/tags/v') && vars.CHARTMATE_MAC_SIGN_IDENTITY != '') || needs.notarize-mac-dmg.result == 'success')");
    expect(secretsOf('release')).toEqual([]);
    const run = runs(steps('release'));
    expect(run).toMatch(/--repo "\$GITHUB_REPOSITORY"/);
    expect(run).toMatch(/--prerelease/);
    expect(run).toContain('*-*) prerelease=(--prerelease)'); // only suffixed tags (v1.2.3-beta.1) are pre-releases
    expect(run).toMatch(/unsigned/i);
  });

  it('the release is Latest only when no higher full release exists, ranked without the token', () => {
    const s = steps('release');
    const checkout = s.find((x) => x.uses?.startsWith('actions/checkout@'))!;
    expect(checkout.with?.['fetch-tags']).toBe(true);
    expect(String(checkout.with?.['sparse-checkout'])).toContain('/scripts/release-tags.mjs');
    const rank = s.find((x) => x.id === 'rank')!;
    expect(rank.run).toContain(`git tag --list 'v*' | node scripts/release-tags.mjs "$TAG" | tee -a "$GITHUB_OUTPUT"`);
    expect(JSON.stringify(rank)).not.toMatch(/GH_TOKEN|github\.token|secrets\./);
    const create = s.find((x) => /Create the GitHub Release/.test(x.name ?? ''))!;
    expect(s.indexOf(create)).toBeGreaterThan(s.indexOf(rank));
    expect(create.env!.LATEST).toBe('${{ steps.rank.outputs.latest }}');
    expect(create.run).toContain('--latest="$latest"');
    expect(create.run).toContain('latest="$LATEST"');
  });

  it('a release whose Windows signing failed is a draft (published after sign:win); otherwise it is published', () => {
    const create = steps('release').find((x) => /Create the GitHub Release/.test(x.name ?? ''))!;
    // A draft is never marked Latest; the owner sets it when publishing (docs/desktop.md).
    expect(create.run).toContain('if [ "$WIN_SIGN_FAILED" = true ]; then draft=(--draft); latest=false; fi');
    expect(create.run).toContain('"${draft[@]}"');
    expect(create.run!.match(/--draft/g)).toHaveLength(1); // electron-updater only sees published releases
  });

  it('the release notes start with the tag\'s CHANGELOG.md section, above the signing table', () => {
    const s = steps('release');
    const checkout = s.findIndex((x) => x.uses?.startsWith('actions/checkout@'));
    const download = s.findIndex((x) => x.uses?.startsWith('actions/download-artifact@'));
    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(download).toBeGreaterThan(checkout); // a checkout after the download would clean the artifacts away
    const sparse = String(s[checkout]!.with?.['sparse-checkout'] ?? '');
    expect(sparse).toContain('CHANGELOG.md');
    expect(sparse).toContain('apps/desktop/scripts/changelog-section.mjs');
    // The extraction runs in its own step, which holds no token.
    const extractIdx = s.findIndex((x) => x.name === 'Changelog section for the tag');
    const createIdx = s.findIndex((x) => /Create the GitHub Release/.test(x.name ?? ''));
    expect(extractIdx).toBeGreaterThan(download);
    expect(createIdx).toBeGreaterThan(extractIdx);
    const extract = s[extractIdx]!;
    expect(extract.run).toContain('node apps/desktop/scripts/changelog-section.mjs CHANGELOG.md "$TAG" > changes.md');
    expect(Object.keys(extract.env ?? {})).toEqual(['TAG']);
    expect(JSON.stringify(extract)).not.toMatch(/GH_TOKEN|github\.token|secrets\./);
    const run = s[createIdx]!.run!;
    expect(run).not.toContain('changelog-section.mjs');
    const table = run.indexOf('| Platform | Code signing |');
    const body = run.indexOf('cat changes.md');
    expect(body).toBeGreaterThan(run.indexOf('echo "## Chartmate ${TAG#v}"'));
    expect(table).toBeGreaterThan(body);
  });

  it('the release attaches the self-hosting compose.yaml and env.example from the tagged commit', () => {
    const s = steps('release');
    const checkout = s.find((x) => x.uses?.startsWith('actions/checkout@'))!;
    const sparse = String(checkout.with?.['sparse-checkout'] ?? '');
    // Anchored to the repository root (non-cone patterns match at any depth otherwise).
    const patterns = sparse.split('\n').map((l) => l.trim());
    expect(patterns).toContain('/compose.yaml');
    expect(patterns).toContain('/.env.example');
    // GitHub renames assets with a leading dot, so the template ships as env.example.
    const stage = s.find((x) => x.name === 'Self-hosting files')!;
    expect(stage.run).toContain('cp compose.yaml dist/compose.yaml');
    expect(stage.run).toContain('cp .env.example dist/env.example');
    expect(JSON.stringify(stage)).not.toMatch(/GH_TOKEN|github\.token|secrets\./);
    const create = s.find((x) => /Create the GitHub Release/.test(x.name ?? ''))!;
    expect(create.run).toMatch(/dist\/compose\.yaml dist\/env\.example/);
  });

  it('a tag build fails early unless the tag is on main and equals the desktop app version', () => {
    const s = steps('test');
    expect(s[0]!.with?.['fetch-depth']).toBe(0);
    const onMain = s.find((x) => x.name === 'Tag is on main')!;
    expect(onMain.if).toBe("startsWith(github.ref, 'refs/tags/v')");
    expect(onMain.run).toContain('if ! git merge-base --is-ancestor "$GITHUB_SHA" refs/remotes/origin/main; then');
    expect(onMain.run).toContain('exit 1');
    const check = s.find((x) => x.name === 'Tag matches the desktop version')!;
    expect(check.if).toBe("startsWith(github.ref, 'refs/tags/v')");
    expect(check.run).toContain(`node -p "require('./apps/desktop/package.json').version"`);
    expect(check.run).toContain('[ "${GITHUB_REF_NAME#v}" != "$version" ]');
    expect(check.run).toContain('::error');
    expect(check.run).toContain('exit 1');
    // Before anything slow runs; every other job waits for this one.
    const install = s.findIndex((x) => x.run?.startsWith('pnpm install'));
    expect(s.indexOf(onMain)).toBeLessThan(install);
    expect(s.indexOf(check)).toBeLessThan(install);
    for (const name of ['package-mac', 'package-win']) expect(wf.jobs[name].needs, name).toBe('test');
  });

  it('Certum (SimplySign): login secrets only in the login step, only on tag builds, before any dependency code', () => {
    const s = steps('package-win');
    for (const key of ['CHARTMATE_CERTUM_USERNAME', 'CHARTMATE_CERTUM_OTP_URI']) {
      expect(holders('package-win', key), key).toEqual(['Certum SimplySign login']);
      expect(s.find((x) => x.name === 'Certum SimplySign login')!.env![key]).toBe(`\${{ startsWith(github.ref, 'refs/tags/v') && secrets.${key} || '' }}`);
    }
    for (const name of Object.keys(wf.jobs).filter((j) => j !== 'package-win')) expect(secretsOf(name).join(' '), name).not.toMatch(/CERTUM/);
    const login = s.findIndex((x) => x.name === 'Certum SimplySign login');
    // Only pinned setup actions run before it: no package manager, no install, no build.
    for (const step of s.slice(0, login)) expect(step.uses ?? '', step.name).toMatch(/^actions\/(checkout|setup-node)@/);
    expect(login).toBeLessThan(s.findIndex((x) => x.name === 'pnpm (corepack)'));
    const loginRun = s[login]!.run!;
    expect(loginRun).not.toMatch(/\b(pnpm|npm|npx|electron-builder|bundle\.mjs)\b/);
    expect(loginRun).toMatch(/if pwsh [^\n]*apps\/desktop\/scripts\/certum\/login\.ps1[^\n]*; then/);
    expect(loginRun).toContain('echo "thumbprint=$(cat "$RUNNER_TEMP/certum-thumbprint")" >> "$GITHUB_OUTPUT"');
    expect(loginRun).toContain('echo "login_failed=true" >> "$GITHUB_OUTPUT"');
    expect(s[login]!.if).toBe("startsWith(github.ref, 'refs/tags/v')");
    // The publisher name is not secret (a variable, so logs and notes are not masked) and is always present.
    const pkg = s.find((x) => x.name === 'Bundle, package, sign (Windows)')!;
    expect(pkg.env!.CHARTMATE_WIN_PUBLISHER_NAME).toBe('${{ vars.CHARTMATE_WIN_PUBLISHER_NAME }}');
    expect(pkg.env!.CHARTMATE_WIN_CERT_SHA1).toBe('${{ steps.certum.outputs.thumbprint }}');
    expect(pkg.env!.CERTUM_LOGIN_FAILED).toBe('${{ steps.certum.outputs.login_failed }}');
  });

  it('Certum: the build signs with the logged-in thumbprint, then verifies; SimplySign is closed right after', () => {
    const s = steps('package-win');
    const run = s.find((x) => x.name === 'Bundle, package, sign (Windows)')!.run!;
    expect(run).toMatch(/set -euo pipefail/);
    expect(run).toContain('export CHARTMATE_WIN_SIGN_LOG=');
    expect(run).toContain('--sign-log=');
    expect(run.indexOf('scripts/verify-win-signatures.mjs release')).toBeGreaterThan(run.indexOf('electron-builder --config'));
    // SimplySign Desktop is closed whatever happened, before the smoke tests, in a step that holds no secrets.
    const close = s.findIndex((x) => x.name === 'Close SimplySign Desktop');
    expect(s[close]).toMatchObject({ if: 'always()' });
    expect(s[close]!.env).toBeUndefined();
    expect(close).toBe(s.findIndex((x) => x.name === 'Bundle, package, sign (Windows)') + 1);
  });

  it('Certum: only a failed login or sign hook falls back (Windows rebuilt without Certum); a failed verification fails', () => {
    const j = job('package-win');
    const run = j.steps.find((s) => s.name === 'Bundle, package, sign (Windows)')!.run!;
    expect(run).toContain('sign_failed="${CERTUM_LOGIN_FAILED:-false}"');
    // The sign hook's own failure messages mark a hook failure (3); verification failure is 2 and exits the job.
    expect(run).toMatch(/grep -qE 'Certum signing failed\|refusing further attempts' [^\n]* && return 3/);
    expect(run).toContain('verify-win-signatures.mjs release');
    expect(run).toMatch(/\|\| return 2/);
    expect(run).toMatch(/if \[ "\$rc" = 2 \]; then[\s\S]*?::error title=Windows signature verification failed::[\s\S]*?exit 1/);
    expect(run).toMatch(/if \[ "\$rc" = 3 \]; then sign_failed=true; elif \[ "\$rc" != 0 \]; then exit 1; fi/);
    expect(run).toContain('::warning title=Windows signing step failed::');
    expect(run).toMatch(/unset CHARTMATE_WIN_CERT_SHA1 CHARTMATE_WIN_SIGN_LOG\n\s*build/);
    expect(run).toContain('echo "sign_failed=$sign_failed" >> "$GITHUB_OUTPUT"');
    expect(j.outputs!.sign_failed).toBe('${{ steps.package.outputs.sign_failed }}');
    const notes = steps('release').find((s) => /Create the GitHub Release/.test(s.name ?? ''))!;
    expect(notes.env!.WIN_SIGN_FAILED).toBe('${{ needs.package-win.outputs.sign_failed }}');
    expect(notes.run).toContain('Windows signing step failed in CI');
    expect(notes.run).toContain('sign:win');
    // "Unsigned" is claimed only from the method actually used (a fallback may still be signed another way).
    const failedBlock = /if \[ "\$WIN_SIGN_FAILED" = true \]; then\n[\s\S]*?fi/.exec(notes.run!)![0];
    expect(failedBlock).not.toMatch(/unsigned/i);
  });

  it('a signing setting that signing.cjs rejects stops the job instead of building unsigned', () => {
    // A command substitution inside `[ ... ]` hides node's exit status from set -e; each one is assigned first.
    for (const name of Object.keys(wf.jobs)) {
      for (const step of steps(name)) expect(step.run ?? '', `${name}: ${step.name}`).not.toMatch(/\[ "\$\(node /);
    }
    const login = steps('package-win').find((x) => x.name === 'Certum SimplySign login')!;
    // Run the login step's script with a node that throws like signing.cjs on a half-configured Certum setup.
    const dir = mkdtempSync(join(tmpdir(), 'certum-step-'));
    try {
      for (const [tool, body] of [['node', 'echo "Error: Certum signing: set both" >&2; exit 1'], ['pwsh', 'exit 0']]) {
        writeFileSync(join(dir, tool!), `#!/bin/sh\n${body}\n`);
        chmodSync(join(dir, tool!), 0o755);
      }
      const out = join(dir, 'output');
      writeFileSync(out, '');
      const r = spawnSync('/bin/bash', ['-e', '-c', login.run!], { env: { PATH: `${dir}:/usr/bin:/bin`, GITHUB_OUTPUT: out, RUNNER_TEMP: dir }, encoding: 'utf8' });
      expect(r.status).not.toBe(0);
      expect(readFileSync(out, 'utf8')).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Certum: tag builds run in the windows-signing environment, other runs in none', () => {
    expect(job('package-win').environment).toBe("${{ startsWith(github.ref, 'refs/tags/v') && 'windows-signing' || '' }}");
  });

  it('the release notes report the signing method of each platform', () => {
    expect(job('package-win').outputs!.signing).toBe('${{ steps.package.outputs.signing }}');
    expect(job('sign-mac').outputs!.method).toBe('${{ steps.method.outputs.method }}');
    const step = steps('release').find((s) => /Create the GitHub Release/.test(s.name ?? ''))!;
    expect(step.env!.WIN_SIGNING).toBe('${{ needs.package-win.outputs.signing }}');
    expect(step.env!.MAC_SIGNING).toBe("${{ needs.sign-mac.outputs.method || 'unsigned' }}");
    expect(step.run).toContain('| Windows (x64, arm64) | ${WIN_SIGNING} |');
    expect(step.run).toContain('| macOS (arm64, x64) | ${MAC_SIGNING} |');
    const pkgRun = steps('package-win').find((s) => s.name === 'Bundle, package, sign (Windows)')!.run!;
    expect(pkgRun).toContain(`signingFor(process.env, 'win32').method`);
  });

  it('both platforms smoke-test the shipped (signed) build with the expected signing state', () => {
    for (const [name, signing] of [['dist-mac', "${{ needs.sign-mac.outputs.method || 'unsigned' }}"], ['package-win', '${{ steps.package.outputs.signing }}']]) {
      const smoke = steps(name!).find((s) => /Smoke test/.test(s.name ?? ''))!;
      expect(smoke.run, name).toMatch(/SMOKE_HARDENED_APP=/);
      expect(smoke.run, name).toMatch(/SMOKE_EXPECT_UNSIGNED=1/);
      expect(smoke.run, name).toMatch(/SMOKE_EXPECT_UNSIGNED=0/);
      expect(smoke.env?.SIGNING, name).toBe(signing);
    }
  });

  it('auto-update: the packaging steps write app-update.yml for this repository, and the release carries what electron-updater fetches', () => {
    for (const [name, step] of [['package-mac', 'Bundle and package the apps (unsigned)'], ['dist-mac', 'Package dmg and zip from the apps (prepackaged, signs nothing)'], ['package-win', 'Bundle, package, sign (Windows)']]) {
      const s = steps(name!).find((x) => x.name === step)!;
      expect(s.env?.CHARTMATE_PUBLISH, name).toBe('github'); // owner/repo from GITHUB_REPOSITORY (build/builder-config.cjs)
      expect(s.run, name).toMatch(/--publish never/);
    }
    const uploaded = (name: string, artifact: string) => String(steps(name).find((s) => s.uses?.startsWith('actions/upload-artifact@') && s.with!.name === artifact)!.with!.path);
    // macOS: Squirrel.Mac installs from the zip; latest-mac.yml lists it; the blockmaps enable differential downloads.
    expect(uploaded('dist-mac', 'desktop-macos')).toMatch(/release\/\*\.zip/);
    expect(uploaded('dist-mac', 'desktop-macos')).toMatch(/release\/\*\.blockmap/);
    expect(uploaded('dist-mac', 'desktop-macos')).toMatch(/release\/latest-mac\.yml/);
    expect(uploaded('package-win', 'desktop-windows')).toMatch(/release\/latest\.yml/);
    const create = runs(steps('release'));
    expect(create).toMatch(/gh release create[\s\S]*dist\/\*\.zip dist\/\*\.exe dist\/\*\.blockmap dist\/latest\*\.yml/);
  });

  it('Windows packaging gets the publisher DN pin (a repository variable) for the update signature check', () => {
    const s = steps('package-win').find((x) => x.name === 'Bundle, package, sign (Windows)')!;
    expect(s.env?.CHARTMATE_WIN_PUBLISHER_DN).toBe('${{ vars.CHARTMATE_WIN_PUBLISHER_DN }}');
  });
});

describe('docker.yml publish', () => {
  const wf = yaml.load(read('docker.yml'));
  const steps = wf.jobs.publish.steps as Step[];
  it('publishes only a tag on main that equals the desktop app version (one version for app, image and tag)', () => {
    const check = steps.find((s) => s.name === 'Check the tag')!;
    expect(check.run).toContain(`node -p "require('./apps/desktop/package.json').version"`);
    expect(check.run).toContain('[ "${GITHUB_REF_NAME#v}" != "$version" ]');
    expect(check.run).toContain('::error');
    expect(check.run).toContain('if ! git merge-base --is-ancestor "$GITHUB_SHA" refs/remotes/origin/main; then');
    expect(steps[0]!.with?.['fetch-depth']).toBe(0);
    const push = steps.findIndex((s) => s.uses?.startsWith('docker/build-push-action@'));
    expect(steps.indexOf(check)).toBeLessThan(push);
    expect(steps.indexOf(check)).toBeGreaterThan(steps.findIndex((s) => s.uses?.startsWith('actions/checkout@')));
  });
  it('moves :latest, :X.Y and :X only when no higher full release exists in that range', () => {
    const rank = steps.find((s) => s.id === 'rank')!;
    expect(rank.run).toContain(`git tag --list 'v*' | node scripts/release-tags.mjs "$GITHUB_REF_NAME" | tee -a "$GITHUB_OUTPUT"`);
    const meta = steps.find((s) => s.id === 'meta')!;
    expect(steps.indexOf(rank)).toBeLessThan(steps.indexOf(meta));
    const tags = String(meta.with!.tags).trim().split('\n').map((l) => l.trim());
    expect(tags).toEqual([
      'type=semver,pattern={{version}}',
      "type=semver,pattern={{major}}.{{minor}},enable=${{ steps.rank.outputs.minor == 'true' }}",
      "type=semver,pattern={{major}},enable=${{ steps.rank.outputs.major == 'true' }}",
      "type=raw,value=latest,enable=${{ steps.rank.outputs.latest == 'true' }}",
    ]);
    expect(meta.with!.flavor).toBe('latest=false');
  });
});
