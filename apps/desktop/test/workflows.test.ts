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
const files = ['ci.yml', 'desktop.yml', 'docker.yml', 'docker-refresh.yml', 'release.yml'];

type Step = { uses?: string; with?: Record<string, unknown>; env?: Record<string, string>; name?: string; run?: string; if?: string; id?: string; shell?: string };
type Job = { steps: Step[]; env?: unknown; permissions?: unknown; environment?: string; needs?: string[]; if?: string; outputs?: Record<string, string>; 'runs-on': string };

const SIGN = "startsWith(github.ref, 'refs/tags/v') && vars.CHARTMATE_MAC_SIGN_IDENTITY != ''";
const COREPACK_RUN = [
  'set -euo pipefail',
  'bash .github/scripts/install-pnpm.sh',
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
      const first = job.steps.findIndex((s) => /(^|\n)\s*pnpm /.test(s.run ?? ''));
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

describe('ci.yml macOS signing dry run (the release allowlist, on every relevant pull request)', () => {
  const job = yaml.load(read('ci.yml')).jobs['mac-signing-dry-run'] as Job;

  it('packages the arm64 app unsigned, signs a copy ad hoc through macos-sign.sh and verifies it, with no secrets', () => {
    expect(job['runs-on']).toMatch(/^macos-/);
    expect(job.permissions).toBeUndefined();
    expect(job.environment).toBeUndefined();
    expect(JSON.stringify(job)).not.toMatch(/secrets\./);
    const pack = job.steps.find((s) => s.name === 'Package the arm64 app as a signed release would be (unsigned)')!;
    // Like package-mac for a signed release: updater bundled, app-update.yml written, electron-builder signs nothing.
    expect(pack.run).toContain('CSC_NAME="$DRY_RUN_IDENTITY" node scripts/bundle.mjs --platform=darwin');
    expect(pack.run).toContain('pnpm exec electron-builder --config electron-builder.config.cjs --mac zip --arm64 --publish never');
    expect(pack.run).toContain('test -f release/mac-arm64/Chartmate.app/Contents/Resources/app-update.yml');
    expect(pack.env?.CHARTMATE_PUBLISH).toBe('github');
    expect(pack.env?.CSC_NAME).toBeUndefined();
    const sign = job.steps.find((s) => s.name === 'Sign a copy ad hoc through the release allowlist, then verify it')!;
    expect(sign.env).toEqual({ IDENTITY: '-' });
    expect(sign.run).toContain('.github/scripts/macos-sign.sh sign-app "$RUNNER_TEMP/Chartmate.app"');
    expect(sign.run).toContain('codesign --verify --deep --strict');
    expect(job.steps.indexOf(pack)).toBeLessThan(job.steps.indexOf(sign));
  });

  it('runs when the desktop app, the dependencies or the signing script change, and still reports a status otherwise', () => {
    const changes = job.steps.find((s) => s.id === 'changes')!;
    expect(job.steps.indexOf(changes)).toBe(1);
    expect(job.if).toBeUndefined(); // the job always runs (a required check never waits forever); its steps skip
    for (const p of ['apps/desktop/', 'pnpm-lock', 'package', 'macos-sign', 'ci']) expect(changes.run).toContain(p);
    expect(changes.run).toContain('echo "run=true" >> "$GITHUB_OUTPUT"   # no usable base');
    for (const s of job.steps.slice(2)) expect(s.if, s.name ?? s.uses ?? s.run).toBe("steps.changes.outputs.run == 'true'");
  });
});

describe('ci.yml Postgres job', () => {
  const wf = yaml.load(read('ci.yml'));
  const job = wf.jobs.postgres as { services: { postgres: { image: string } }; steps: Step[] };

  it('runs the server DB suites against the Postgres compose.yaml runs: the newest major on trixie, pulled fresh', () => {
    const image = job.services.postgres.image;
    expect(image).toMatch(/^postgres:\d+-trixie$/);
    const compose = yaml.load(readFileSync(new URL('../../../compose.yaml', import.meta.url), 'utf8'));
    expect(image).toBe(compose.services.postgres.image);
    expect(compose.services.postgres.pull_policy).toBe('${CHARTMATE_POSTGRES_PULL_POLICY:-always}');
    // Postgres 18+ layout: one mount at /var/lib/postgresql (data in <major>/docker), so an older major's volume is
    // refused at start rather than opened.
    expect(compose.services.postgres.volumes).toEqual(['postgres-data:/var/lib/postgresql']);
    expect(compose.services.postgres.healthcheck.test).toEqual(['CMD-SHELL', 'pg_isready -h 127.0.0.1 -U chartmate -d chartmate']);
    expect(compose.services.chartmate.pull_policy).toBe('${CHARTMATE_PULL_POLICY:-always}');
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
  it('supply-chain policy exceptions do not outlive their remove-after date by 30 days', () => {
    const text = root('pnpm-workspace.yaml');
    const dates = [...text.matchAll(/remove after (\d{4}-\d{2}-\d{2})/gi)].map((m) => m[1]!);
    for (const d of dates) {
      const overdue = (Date.now() - Date.parse(`${d}T00:00:00Z`)) / 86_400_000;
      expect(overdue, `pnpm-workspace.yaml: an exception marked "remove after ${d}" is ${Math.floor(overdue)} days overdue`).toBeLessThan(30);
    }
    // Exceptions to minimumReleaseAge are temporary, so they say when they go.
    const excl = /^minimumReleaseAgeExclude:\n((?:[ \t]+.*\n)*)/m.exec(text);
    if (excl && /^\s+- /m.test(excl[1]!)) expect(dates.length, 'minimumReleaseAgeExclude needs a "remove after YYYY-MM-DD" comment').toBeGreaterThan(0);
  });
  it('nothing loosens corepack or the pnpm download checks (keys, registry, custom URLs)', () => {
    for (const f of [...files.map((x) => `.github/workflows/${x}`), 'Dockerfile', '.github/scripts/install-pnpm.sh']) {
      expect(root(f), f).not.toMatch(/COREPACK_(INTEGRITY_KEYS|NPM_REGISTRY|ENABLE_UNSAFE_CUSTOM_URLS)/);
    }
  });
  it('pins Node.js to an exact version for every workflow (.nvmrc)', () => {
    expect(root('.nvmrc').trim()).toMatch(/^\d+\.\d+\.\d+$/);
    for (const f of files) {
      for (const m of read(f).matchAll(/node-version(-file)?:\s*(\S+)/g)) expect(m[0], f).toBe('node-version-file: .nvmrc');
    }
  });
  it('caches dependencies only in ci.yml (pull requests and main), never on a release path', () => {
    for (const f of ['desktop.yml', 'docker.yml', 'docker-refresh.yml']) {
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
  it('never proposes a major Node or Postgres upgrade: those are deliberate changes, not routine bumps', () => {
    type Ignore = { 'dependency-name': string; 'update-types'?: string[] };
    const ignored = (eco: string) =>
      ((cfg.updates.find((u) => u['package-ecosystem'] === eco) as { ignore?: Ignore[] }).ignore ?? [])
        .filter((i) => i['update-types']?.includes('version-update:semver-major'))
        .map((i) => i['dependency-name']);
    expect(ignored('npm')).toContain('@types/node');
    expect(ignored('docker')).toContain('node');
    expect(ignored('docker-compose')).toContain('postgres');
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
      // No notarization credentials fail the tag unless the owner opted out on purpose (macos-sign.sh store-notary).
      const notary = s.find((x) => x.name === 'Notarization credentials (keychain profile)')!;
      expect(notary.env?.ALLOW_UNNOTARIZED, name).toBe('${{ vars.CHARTMATE_ALLOW_UNNOTARIZED_MAC }}');
      expect(notary.run, name).toBe('.github/scripts/macos-sign.sh store-notary >> "$GITHUB_OUTPUT"');
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

  it('every job that builds the TEST-ONLY inspectable copy builds the web UI first (the bundle embeds apps/web/dist)', () => {
    const using = Object.keys(wf.jobs).filter((name) => steps(name).some((s) => s.run?.includes('smoke/prepare-inspectable.mjs')));
    expect(using.sort()).toEqual(['dist-mac', 'package-win']);
    for (const name of using) {
      const st = steps(name);
      const web = st.findIndex((s) => s.run?.split('\n').some((l) => l.trim() === 'pnpm --filter @chartmate/web build'));
      expect(web, name).toBeGreaterThanOrEqual(0);
      expect(web, name).toBeLessThan(st.findIndex((s) => s.run?.includes('smoke/prepare-inspectable.mjs')));
    }
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
    expect(job('release').if).toContain("(!(startsWith(github.ref, 'refs/tags/v') && vars.CHARTMATE_MAC_SIGN_IDENTITY != '') || (needs.notarize-mac-dmg.result == 'success' && needs.check-mac-zips.result == 'success'))");
    expect(job('release').needs).toContain('check-mac-zips');
    expect(secretsOf('release')).toEqual([]);
    const run = runs(steps('release'));
    expect(run).toMatch(/--repo "\$GITHUB_REPOSITORY"/);
    expect(run).toMatch(/--prerelease/);
    expect(run).toContain('*-*) prerelease=(--prerelease)'); // only suffixed tags (v1.2.3-beta.1) are pre-releases
    expect(run).toMatch(/unsigned/i);
  });

  it('check-mac-zips: before release, each zip holds exactly the app sign-mac signed, with no secrets and no dependency code', () => {
    const j = job('check-mac-zips');
    expect(j.if).toBe(job('sign-mac').if);
    expect(j.needs).toEqual(['sign-mac', 'dist-mac']);
    expect(j.environment).toBeUndefined();
    expect(secretsOf('check-mac-zips')).toEqual([]);
    const s = steps('check-mac-zips');
    for (const step of s) {
      if (step.uses) expect(step.uses).toMatch(/^actions\/(checkout|download-artifact)@/);
      expect(step.run ?? '').not.toMatch(/\b(pnpm|npm|npx|node|yarn|corepack|electron-builder)\b/);
    }
    expect(String(s[0]!.with?.['sparse-checkout']).trim()).toBe('/.github/scripts/macos-sign.sh');
    const check = s.find((x) => x.name === 'The zips hold the signed apps')!;
    expect(check.env).toEqual({ CDHASH_X64: '${{ needs.sign-mac.outputs.cdhash_x64 }}', CDHASH_ARM64: '${{ needs.sign-mac.outputs.cdhash_arm64 }}' });
    expect(check.run).toContain('.github/scripts/macos-sign.sh check-zip "$zip" "$expected"');
    expect(check.run).toContain('[ "$n" = 2 ]');
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
    // The session ends as soon as electron-builder returns (every signature is made inside that run), before the
    // verification and any fallback rebuild.
    const builder = run.indexOf('pnpm exec electron-builder --config');
    const end = run.indexOf('end_certum_session', builder);
    expect(end).toBeGreaterThan(builder);
    expect(end).toBeLessThan(run.indexOf('if [ "$eb" != 0 ]; then'));
    expect(end).toBeLessThan(run.indexOf('scripts/verify-win-signatures.mjs release'));
    expect(run).toContain('pwsh -NoProfile -NonInteractive -File scripts/certum/logout.ps1 || { echo "::error title=Certum::could not end the SimplySign session"; exit 1; }');
    // logout.ps1 stops SimplySign, waits, and fails while it is still running.
    const logout = root('apps/desktop/scripts/certum/logout.ps1');
    expect(logout).toContain('Get-Process SimplySignDesktop -ErrorAction SilentlyContinue | Stop-Process -Force');
    expect(logout).toContain('Wait-Process -Name SimplySignDesktop -Timeout 15');
    expect(logout).toMatch(/if \(Get-Process SimplySignDesktop -ErrorAction SilentlyContinue\) \{[\s\S]*?exit 1\s*\}/);
    expect(steps('package-win').find((x) => x.name === 'Certum SimplySign login')!.run).toContain('rm -f "$RUNNER_TEMP/certum-thumbprint"');
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
  it('publishes on a tag, pushed or dispatched on (release.yml), never on a pull request or a branch', () => {
    expect(wf.jobs.publish.if).toBe("github.event_name != 'pull_request' && github.ref_type == 'tag'");
  });
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

// The build args docker.yml passes to every image build: the About dialog links the repository and the exact tag or
// commit (apps/web/build/sourceRef.cjs).
const SOURCE_BUILD_ARGS = [
  'GITHUB_REPOSITORY=${{ github.repository }}',
  'GITHUB_REF_TYPE=${{ github.ref_type }}',
  'GITHUB_REF_NAME=${{ github.ref_name }}',
  'GITHUB_SHA=${{ github.sha }}',
];
const buildArgs = (s: Step) => String(s.with?.['build-args']).trim().split('\n').map((l) => l.trim());

describe('Docker image builds pass the repository and the source ref (the About dialog links to its source code)', () => {
  it('every docker/build-push-action step in docker.yml passes the repository, ref type, ref name and commit', () => {
    const wf = yaml.load(read('docker.yml'));
    const builds = Object.values(wf.jobs as Record<string, Job>).flatMap((j) => j.steps)
      .filter((s) => s.uses?.startsWith('docker/build-push-action@'));
    expect(builds.length).toBeGreaterThanOrEqual(3);
    for (const s of builds) expect(buildArgs(s), s.name).toEqual(SOURCE_BUILD_ARGS);
  });

  it('ci.yml\'s docker build passes it too, and the smoke tests check it', () => {
    const ci = yaml.load(read('ci.yml'));
    const runs = Object.values(ci.jobs as Record<string, Job>).flatMap((j) => j.steps).map((s) => s.run ?? '');
    const builds = runs.filter((r) => /\bdocker build\b/.test(r));
    expect(builds.length).toBeGreaterThan(0);
    for (const r of builds) {
      for (const v of ['GITHUB_REPOSITORY', 'GITHUB_REF_TYPE', 'GITHUB_REF_NAME', 'GITHUB_SHA']) expect(r).toContain(`--build-arg ${v}="$${v}"`);
    }
    const dockerfile = root('Dockerfile');
    expect(dockerfile).toMatch(/^ARG GITHUB_REPOSITORY=""$/m);
    expect(dockerfile).toMatch(/^ARG GITHUB_REF_TYPE="" GITHUB_REF_NAME="" GITHUB_SHA=""$/m);
    expect(dockerfile.search(/^ARG GITHUB_REF_TYPE=/m)).toBeLessThan(dockerfile.indexOf('RUN pnpm build'));
    const smoke = (yaml.load(read('docker.yml')).jobs.image.steps as Step[]).map((s) => s.run ?? '').filter((r) => r.includes('docker-smoke.sh'));
    expect(smoke.length).toBe(2);
    for (const r of smoke) expect(r).toContain('--expect-repository "$GITHUB_REPOSITORY"');
  });
});

describe('Docker image freshness: every build pulls, on a base digest resolved once per run, and is scanned', () => {
  const IMAGE_WORKFLOWS = ['docker.yml', 'docker-refresh.yml'];
  type JobX = Job & { outputs?: Record<string, string>; concurrency?: unknown };
  const jobsOf = (f: string) => Object.entries(yaml.load(read(f)).jobs as Record<string, JobX>);
  const jobOf = (f: string, name: string) => jobsOf(f).find(([n]) => n === name)![1];
  const isBuild = (s: Step) => !!s.uses?.startsWith('docker/build-push-action@');
  const BASE_REFS = ['${{ steps.base.outputs.context }}', '${{ needs.image.outputs.base-context }}', '${{ needs.plan.outputs.base-context }}'];

  it('every docker/build-push-action step pulls, pins the resolved base and passes the repository', () => {
    for (const f of IMAGE_WORKFLOWS) {
      const builds = jobsOf(f).flatMap(([, j]) => j.steps).filter(isBuild);
      expect(builds.length, f).toBeGreaterThanOrEqual(3);
      for (const s of builds) {
        expect(s.with?.pull, `${f}: ${s.name}`).toBe(true);
        expect(BASE_REFS, `${f}: ${s.name}`).toContain(s.with?.['build-contexts']);
        expect(buildArgs(s)[0], `${f}: ${s.name}`).toBe('GITHUB_REPOSITORY=${{ github.repository }}');
      }
    }
  });

  it('the base is resolved (and checked against docker-library) once, before any build, and handed on', () => {
    for (const [f, job] of [['docker.yml', 'image'], ['docker-refresh.yml', 'plan']] as const) {
      const j = jobOf(f, job);
      const base = j.steps.find((s) => s.id === 'base')!;
      expect(base.run, f).toMatch(/\.github\/scripts\/resolve-base-image\.sh( release\/Dockerfile)?$/m);
      expect(base.env?.GH_TOKEN, f).toBe('${{ github.token }}');
      expect(j.outputs?.['base-context'], f).toBe('${{ steps.base.outputs.context }}');
      expect(j.outputs?.['base-image'], f).toBe('${{ steps.base.outputs.image }}');
      expect(j.outputs?.['base-digest'], f).toBe('${{ steps.base.outputs.digest }}');
    }
    const image = jobOf('docker.yml', 'image');
    expect(image.steps.findIndex((s) => s.id === 'base')).toBeLessThan(image.steps.findIndex(isBuild));
  });

  it('ci.yml builds with --pull on the resolved base, then scans the image', () => {
    const steps = (yaml.load(read('ci.yml')).jobs.docker as Job).steps;
    const base = steps.findIndex((s) => s.run === '.github/scripts/resolve-base-image.sh');
    const build = steps.findIndex((s) => /\bdocker build\b/.test(s.run ?? ''));
    expect(base).toBeGreaterThanOrEqual(0);
    expect(steps[base]!.env?.GH_TOKEN).toBe('${{ github.token }}');
    expect(base).toBeLessThan(build);
    expect(steps[build]!.run).toContain('docker build --pull --build-context "$BASE_CONTEXT" ');
    expect(steps[build]!.env?.BASE_CONTEXT).toBe('${{ steps.base.outputs.context }}');
    const install = steps.findIndex((s) => s.run === '.github/scripts/install-trivy.sh');
    const scan = steps.findIndex((s) => s.run === '.github/scripts/scan-image.sh chartmate:ci');
    expect(build).toBeLessThan(install);
    expect(install).toBeLessThan(scan);
  });

  it('every image a job builds and loads is smoke-tested and scanned in that job, with Trivy installed first', () => {
    for (const f of IMAGE_WORKFLOWS) {
      for (const [name, job] of jobsOf(f)) {
        const install = job.steps.findIndex((s) => s.run === '.github/scripts/install-trivy.sh');
        job.steps.forEach((s, i) => {
          if (!isBuild(s) || !s.with?.load) return;
          const tag = String(s.with!.tags);
          const scan = job.steps.findIndex((x) => x.run === `.github/scripts/scan-image.sh ${tag}`);
          const smoke = job.steps.findIndex((x) => new RegExp(`docker-smoke\\.sh ${tag}( |$)`, 'm').test(x.run ?? ''));
          expect(scan, `${f} ${name}: ${tag}`).toBeGreaterThan(i);
          expect(smoke, `${f} ${name}: ${tag}`).toBeGreaterThan(i);
          expect(install, `${f} ${name}`).toBeGreaterThanOrEqual(0);
          expect(install, `${f} ${name}`).toBeLessThan(scan);
        });
      }
    }
  });

  it('publish pushes by digest only, scans and smoke-tests that digest on both platforms, then tags exactly it', () => {
    for (const f of IMAGE_WORKFLOWS) {
      const publish = jobOf(f, 'publish');
      const s = publish.steps;
      const builds = s.filter(isBuild);
      expect(builds, f).toHaveLength(1); // one build: the pushed digest is the one checked
      const push = s.indexOf(builds[0]!);
      expect(builds[0]!.with).toMatchObject({
        platforms: 'linux/amd64,linux/arm64',
        outputs: 'type=image,name=${{ env.IMAGE }},push-by-digest=true,name-canonical=true,push=true',
        provenance: 'mode=max',
        sbom: true,
      });
      expect(builds[0]!.with?.tags, f).toBeUndefined();
      expect(builds[0]!.with?.push, f).toBeUndefined();
      const digest = s.findIndex((x) => x.name === 'Pushed digest');
      expect(s[digest]!.run).toContain('echo "REF=$IMAGE@$DIGEST" >> "$GITHUB_ENV"');
      const scans = s.map((x, i) => [x.run ?? '', i] as const).filter(([r]) => r.startsWith('.github/scripts/scan-image.sh '));
      expect(scans.map(([r]) => r), f).toEqual([
        '.github/scripts/scan-image.sh "$REF" --platform linux/amd64 --remote',
        '.github/scripts/scan-image.sh "$REF" --platform linux/arm64 --remote',
      ]);
      // Each platform's image of the pushed digest, by its own manifest digest.
      const smoke = s.map((x, i) => [x.run ?? '', i] as const).filter(([r]) => r.includes('docker-smoke.sh "$img"'));
      const smokeText = smoke.map(([r]) => r).join('\n');
      expect(smokeText, f).toMatch(/img="\$\(\.github\/scripts\/platform-digest\.sh "\$REF" (linux\/amd64|"\$p")\)"/);
      for (const p of ['linux/amd64', 'linux/arm64']) expect(smokeText, f).toContain(p);
      const tag = s.findIndex((x) => x.name === 'Tag the checked digest');
      expect(s[tag]!.run, f).toContain('.github/scripts/tag-image.sh "$REF" "${tags[@]}"');
      expect(s[tag]!.env?.TAGS, f).toBe('${{ steps.meta.outputs.tags }}');
      for (const [, i] of [...scans, ...smoke]) {
        expect(i, f).toBeGreaterThan(digest);
        expect(i, f).toBeLessThan(tag);
      }
      expect(push, f).toBeLessThan(digest);
      const attest = s.findIndex((x) => x.uses?.startsWith('actions/attest@'));
      expect(attest, f).toBeGreaterThan(tag);
      // The base image (name and the checked digest) is recorded on the published image.
      const meta = s.find((x) => x.id === 'meta')!;
      for (const k of ['labels', 'annotations']) {
        expect(String(meta.with?.[k]), `${f} ${k}`).toMatch(/^org\.opencontainers\.image\.base\.name=docker\.io\/library\/\$\{\{ needs\.(image|plan)\.outputs\.base-image \}\}$/m);
        expect(String(meta.with?.[k]), `${f} ${k}`).toMatch(/^org\.opencontainers\.image\.base\.digest=\$\{\{ needs\.(image|plan)\.outputs\.base-digest \}\}$/m);
      }
      // No shared concurrency group: it could cancel a pending release publish (the refresh checks for one instead).
      expect(publish.concurrency, f).toBeUndefined();
      expect(publish.environment, f).toBe('ghcr');
      expect([publish.needs ?? []].flat(), f).toContain('image');
    }
    expect(jobOf('docker.yml', 'publish').permissions).toEqual({ contents: 'read', packages: 'write', 'id-token': 'write', attestations: 'write' });
    expect(jobOf('docker-refresh.yml', 'publish').permissions).toEqual({ contents: 'read', packages: 'write', 'id-token': 'write', attestations: 'write', actions: 'read' });
  });
});

describe('docker-refresh.yml (weekly rebuild of the latest release)', () => {
  const wf = yaml.load(read('docker-refresh.yml'));
  type JobX = Job & { outputs: Record<string, string> };
  const plan = wf.jobs.plan as JobX;
  const audit = wf.jobs.audit as Job;
  const image = wf.jobs.image as Job;
  const publish = wf.jobs.publish as Job;
  const notify = wf.jobs.notify as Job;

  it('runs weekly on Mondays and on manual dispatch only (never on a push, a pull request or a tag)', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(wf.on.schedule).toHaveLength(1);
    expect(wf.on.schedule[0].cron).toMatch(/^\d+ \d+ \* \* 1$/);
  });

  it('only the upstream repository\'s default branch runs it (checked against the API, not just the event)', () => {
    expect(plan.if).toBe('github.event.repository.fork != true');
    const guard = plan.steps[1]!;
    expect(guard.id).toBe('guard');
    expect(guard.run).toContain('gh api "repos/$GITHUB_REPOSITORY"');
    expect(guard.run).toContain('if [ "$fork" != false ]; then');
    expect(guard.run).toContain('if [ "$GITHUB_REF" != "refs/heads/$default" ]; then');
    expect(guard.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    for (const j of [plan, audit, image]) expect(j.permissions).toBeUndefined();
    for (const j of [audit, image, publish]) expect(j.if).toBe("needs.plan.outputs.refresh == 'true'");
  });

  it('refreshes only the latest full release with a published GitHub Release, on the default branch, matching its version', () => {
    const release = plan.steps.find((s) => s.id === 'release')!;
    expect(release.run).toContain(`git tag --list 'v*' | node scripts/release-tags.mjs --latest`);
    expect(release.run).toContain('git merge-base --is-ancestor "refs/tags/$tag" HEAD');
    expect(release.run).toContain(`gh api "repos/$GITHUB_REPOSITORY/releases/tags/$tag" --jq '"\\(.draft) \\(.prerelease)"'`);
    // A real 404 (no release, or a draft) stands down; any other API error fails the step, so notify opens an issue.
    for (const run of [release.run!, publish.steps.find((s) => s.id === 'still')!.run!]) {
      expect(run).toMatch(/elif grep -q 'HTTP 404' "\$RUNNER_TEMP\/release\.err"; then\n\s*state=missing\n\s*else\n[\s\S]*?::error title=GitHub API::[\s\S]*?exit 1\n\s*fi/);
      expect(run).not.toMatch(/\|\| echo missing/);
    }
    expect(release.run).toContain('if [ "$state" = "false false" ]; then');
    expect(plan.outputs.refresh).toBe("${{ steps.base.outputs.context != '' && steps.release.outputs.published == 'true' }}");
    expect(plan.steps.find((s) => s.name === 'Check the version')!.run).toContain(`require('./release/apps/desktop/package.json').version`);
  });

  it('an unpublished release stands down before anything else runs (no failure, so no issue)', () => {
    const i = plan.steps.findIndex((s) => s.id === 'release');
    for (const s of plan.steps.slice(i + 1).filter((x) => x.name !== 'Dockerfile frontend pin')) {
      expect(s.if, s.name ?? s.uses).toBe("steps.release.outputs.published == 'true'");
    }
    expect(plan.steps.slice(i + 1).map((s) => s.name ?? s.uses?.split('@')[0])).toEqual([
      'actions/checkout', 'Check the version', 'Base image', 'Dockerfile frontend pin',
    ]);
  });

  it('warns, without failing, when docker/dockerfile:1 has moved past the Dockerfile\'s pinned frontend', () => {
    const pin = plan.steps.find((s) => s.name === 'Dockerfile frontend pin')! as Step & { 'continue-on-error'?: boolean };
    expect(pin['continue-on-error']).toBe(true);
    expect(pin.if).toBeUndefined();
    expect(pin.run).toContain(`sed -n '1s/^# syntax=docker\\/dockerfile:1@\\(sha256:[0-9a-f]\\{64\\}\\)$/\\1/p' Dockerfile`);
    expect(pin.run).toContain(`docker buildx imagetools inspect docker/dockerfile:1 --format '{{json .Manifest}}'`);
    expect(pin.run).toContain('::warning title=Dockerfile frontend::');
    expect(pin.run).toContain('>> "$GITHUB_STEP_SUMMARY"');
    expect(pin.run).not.toMatch(/exit 1/);
    // The sed expression really extracts the pin from the Dockerfile's first line.
    const first = root('Dockerfile').split('\n')[0]!;
    expect(/^# syntax=docker\/dockerfile:1@(sha256:[0-9a-f]{64})$/.exec(first)?.[1]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(root('CONTRIBUTING.md')).toContain('`# syntax=` frontend digest');
  });

  it('stands down for a release whose Dockerfile pins its base by digest (an older release: nothing to refresh)', () => {
    const base = plan.steps.find((s) => s.id === 'base')!;
    expect(base.run).toContain('.github/scripts/resolve-base-image.sh release/Dockerfile');
    expect(base.run).toContain("if ! grep -qE '^context=.+' \"$GITHUB_OUTPUT\"; then");
    expect(base.run).toContain('Nothing refreshed');
  });

  it('audits the release\'s own dependencies first', () => {
    expect(audit.needs).toBe('plan');
    expect(audit.steps[0]!.with?.ref).toBe('refs/tags/${{ needs.plan.outputs.tag }}');
    expect(audit.steps[0]!.with?.path).toBeUndefined();
    expect(runs(audit.steps)).toMatch(/^pnpm audit$/m);
    expect(image.needs).toEqual(['plan', 'audit']);
  });

  it('builds the tag (its commit and ref in the build args) and smoke-tests it with the tag\'s own script', () => {
    for (const [name, j] of [['image', image], ['publish', publish]] as const) {
      const checkout = j.steps.filter((s) => s.uses?.startsWith('actions/checkout@') && s.with?.ref);
      expect(checkout.map((s) => [s.with!.ref, s.with!.path]), name).toEqual([['refs/tags/${{ needs.plan.outputs.tag }}', 'release']]);
      for (const s of j.steps.filter((x) => x.uses?.startsWith('docker/build-push-action@'))) {
        expect(s.with?.context, name).toBe('release');
        expect(buildArgs(s), `${name}: ${s.name}`).toEqual([
          'GITHUB_REPOSITORY=${{ github.repository }}', 'GITHUB_REF_TYPE=tag',
          'GITHUB_REF_NAME=${{ needs.plan.outputs.tag }}', 'GITHUB_SHA=${{ needs.plan.outputs.sha }}',
        ]);
      }
      // An older docker-smoke.sh does not know --expect-repository: it is passed only when the script has it.
      for (const s of j.steps.filter((x) => x.run?.includes('docker-smoke.sh'))) {
        expect(s.run, `${name}: ${s.name}`).toContain(`if grep -q -- '--expect-repository' release/scripts/docker-smoke.sh; then args=(--expect-repository "$GITHUB_REPOSITORY"); fi`);
        expect(s.run, `${name}: ${s.name}`).toMatch(/^\s*release\/scripts\/docker-smoke\.sh .*\$\{args\[@\]\+"\$\{args\[@\]\}"\}$/m);
        expect(s.run, `${name}: ${s.name}`).not.toMatch(/^\s*release\/scripts\/docker-smoke\.sh[^\n]*--expect-repository/m);
      }
    }
  });

  it('tags only while it is still the latest published release and no release publish is queued or running', () => {
    const rank = publish.steps.find((s) => s.id === 'rank')!;
    expect(rank.run).toContain(`git tag --list 'v*' | node scripts/release-tags.mjs "$TAG" | tee -a "$GITHUB_OUTPUT"`);
    const still = publish.steps.find((s) => s.id === 'still')!;
    expect(still.run).toContain(`gh api --paginate "repos/$GITHUB_REPOSITORY/tags?per_page=100" --jq '.[].name' | node scripts/release-tags.mjs --latest`);
    // Release runs on a tag, pushed or dispatched by release.yml (a branch dispatch only builds).
    expect(still.run).toContain('gh run list --repo "$GITHUB_REPOSITORY" --workflow docker.yml --limit 50 --json status,headBranch');
    expect(still.run).toContain('select(.status != "completed" and (.headBranch | test("^v[0-9]")))');
    expect(still.run).toContain('gh api "repos/$GITHUB_REPOSITORY/releases/tags/$TAG"');
    const i = publish.steps.indexOf(still);
    const tag = publish.steps.findIndex((s) => s.name === 'Tag the checked digest');
    expect(i).toBe(tag - 1);
    expect(publish.steps.findIndex((s) => s.run?.startsWith('.github/scripts/scan-image.sh'))).toBeLessThan(i);
    for (const s of publish.steps.slice(tag)) expect(s.if, s.name ?? s.uses).toMatch(/^steps\.still\.outputs\.tag == 'true'/);
    const meta = publish.steps.find((s) => s.id === 'meta')!;
    const tags = String(meta.with!.tags).trim().split('\n').map((l) => l.trim());
    expect(tags).toEqual([
      'type=semver,pattern={{version}},value=${{ needs.plan.outputs.tag }}',
      "type=semver,pattern={{major}}.{{minor}},value=${{ needs.plan.outputs.tag }},enable=${{ steps.rank.outputs.minor == 'true' }}",
      "type=semver,pattern={{major}},value=${{ needs.plan.outputs.tag }},enable=${{ steps.rank.outputs.major == 'true' }}",
      "type=raw,value=latest,enable=${{ steps.rank.outputs.latest == 'true' }}",
    ]);
    expect(String(meta.with!.labels)).toContain('org.opencontainers.image.revision=${{ needs.plan.outputs.sha }}');
  });

  it('a failure opens or updates a tracking issue, from a job that can only write issues', () => {
    expect(notify.needs).toEqual(['plan', 'audit', 'image', 'publish']);
    expect(notify.if).toBe('failure() && github.event.repository.fork != true');
    expect(notify.permissions).toEqual({ issues: 'write' });
    expect(notify.steps.some((s) => s.uses)).toBe(false); // no checkout, no action: only gh
    const run = notify.steps[0]!.run!;
    expect(run).toContain('gh issue comment "$number"');
    expect(run).toContain('gh issue create --repo "$GITHUB_REPOSITORY" --title "$title"');
  });
});

describe('release.yml (tags a version bump once CI passes on main, then starts the release workflows)', () => {
  const wf = yaml.load(read('release.yml'));
  const job = wf.jobs.tag as Job;
  const step = (name: string) => job.steps.find((s) => s.name === name)!;

  it('runs after CI on main, or by hand, never on forks, one at a time', () => {
    expect(wf.on).toEqual({ workflow_run: { workflows: ['CI'], types: ['completed'], branches: ['main'] }, workflow_dispatch: null });
    expect(job.if).toBe('github.event.repository.fork != true');
    expect(wf.concurrency).toEqual({ group: 'release', 'cancel-in-progress': false });
  });

  it('is the only job, with exactly the write scopes the tag and the dispatch need, and runs no dependency code', () => {
    expect(Object.keys(wf.jobs)).toEqual(['tag']);
    expect(job.permissions).toEqual({ contents: 'write', actions: 'write' });
    expect(job.environment).toBeUndefined();
    expect(JSON.stringify(job)).not.toMatch(/secrets\.|pnpm|npm |npx|node /);
    expect(job.steps.filter((s) => s.uses).map((s) => s.uses!.split('@')[0])).toEqual(['actions/checkout']);
  });

  it('releases only a successful CI run of a push to main (or a dispatch from main), at that exact commit', () => {
    const commit = step('Which commit');
    expect(commit.run).toContain('[ "$RUN_EVENT" = push ] && [ "$RUN_BRANCH" = main ] && [ "$RUN_CONCLUSION" = success ]');
    expect(commit.run).toContain('echo "sha=$RUN_SHA" >> "$GITHUB_OUTPUT"');
    expect(commit.run).toContain('if [ "$GITHUB_REF" != refs/heads/main ]; then');
    expect(commit.env?.RUN_SHA).toBe('${{ github.event.workflow_run.head_sha }}');
    const checkout = job.steps.find((s) => s.uses?.startsWith('actions/checkout@'))!;
    expect(checkout.with?.ref).toBe('${{ steps.commit.outputs.sha }}');
    expect(checkout.with?.['fetch-depth']).toBe(0);
  });

  it('checks main, the version, the three package versions, an existing tag and the changelog before tagging', () => {
    const plan = step('Plan');
    expect(plan.run).toContain('if ! git merge-base --is-ancestor "$SHA" refs/remotes/origin/main; then');
    expect(plan.run).toContain('version="$(jq -r .version apps/desktop/package.json)"');
    expect(plan.run).toContain('for p in apps/web/package.json apps/server/package.json; do');
    expect(plan.run).toContain('gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$tag"');
    expect(plan.run).toContain("grep -q 'HTTP 404'");
    expect(plan.run).toContain('CHANGELOG.md has no section for $version');
    expect(plan.run).toContain('echo "tag=$tag" >> "$GITHUB_OUTPUT"');
  });

  it('creates the tag at the checked commit, then dispatches desktop.yml and docker.yml on it', () => {
    const go = step('Tag and start the release workflows');
    expect(go.if).toBe("steps.plan.outputs.tag != ''");
    const lines = String(go.run).split('\n').map((l) => l.trim()).filter(Boolean);
    expect(lines).toEqual([
      'set -euo pipefail',
      'if ! gh api "repos/$GITHUB_REPOSITORY/git/refs" -f ref="refs/tags/$TAG" -f sha="$SHA" --silent; then',
      'echo "::error title=Could not create $TAG::a v* tag ruleset restricts creations: turn that rule off, keep updates and deletions blocked (docs/desktop.md), then re-run this run"',
      'exit 1',
      'fi',
      'gh workflow run desktop.yml --repo "$GITHUB_REPOSITORY" --ref "$TAG"',
      'gh workflow run docker.yml --repo "$GITHUB_REPOSITORY" --ref "$TAG"',
      'echo "Tagged $TAG at $SHA and started desktop.yml and docker.yml on it." >> "$GITHUB_STEP_SUMMARY"',
    ]);
    expect(go.env).toEqual({ GH_TOKEN: '${{ github.token }}', SHA: '${{ steps.commit.outputs.sha }}', TAG: '${{ steps.plan.outputs.tag }}' });
  });

  it('desktop.yml and docker.yml accept the dispatch and treat a tag ref as a release', () => {
    for (const f of ['desktop.yml', 'docker.yml']) expect(Object.keys(yaml.load(read(f)).on), f).toContain('workflow_dispatch');
  });
});
