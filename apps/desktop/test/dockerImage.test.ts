// The self-hosting image's freshness rules: the Dockerfile's base image, the script that resolves it once per
// workflow run (and records its digest), and the vulnerability gate. Scripts run for real under bash with docker
// and trivy stubbed on PATH (no network, no daemon).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const path = (f: string) => fileURLToPath(new URL(`../../../${f}`, import.meta.url));
const root = (f: string) => readFileSync(path(f), 'utf8');
const RESOLVE = path('.github/scripts/resolve-base-image.sh');
const SCAN = path('.github/scripts/scan-image.sh');
const INSTALL_TRIVY = path('.github/scripts/install-trivy.sh');
const DIGEST = `sha256:${'ab'.repeat(32)}`;

/** FROM lines of a Dockerfile: [flags..., image, 'AS', stage]. */
const froms = (text: string) => text.split('\n').filter((l) => /^FROM\s/.test(l)).map((l) => l.trim().split(/\s+/).slice(1));

describe('Dockerfile', () => {
  const text = root('Dockerfile');
  const stages = froms(text);
  const image = (words: string[]) => words.find((w) => !w.startsWith('--'))!;

  it('builds both stages on the newest Node LTS line of .nvmrc, Debian trixie slim, by tag (no digest pin)', () => {
    const major = root('.nvmrc').trim().split('.')[0];
    expect(stages.map((w) => w.at(-1))).toEqual(['build', 'runtime']);
    for (const s of stages) expect(image(s)).toBe(`node:${major}-trixie-slim`);
    expect(text).not.toMatch(/^FROM\s.*@sha256:/m);
  });

  it('gets pnpm through install-pnpm.sh (everything hash-checked) and asserts the version package.json pins', () => {
    const install = text.indexOf('RUN bash .github/scripts/install-pnpm.sh');
    expect(install).toBeGreaterThan(0);
    expect(text).toMatch(/^COPY \.github\/scripts\/install-pnpm\.sh \.github\/scripts\/$/m);
    // The script reads package.json and pnpm-lock.yaml from the repository root: both are there before it runs.
    const manifests = text.search(/^COPY package\.json pnpm-lock\.yaml \.\/$/m);
    expect(manifests).toBeGreaterThan(0);
    expect(manifests).toBeLessThan(install);
    expect(text).toContain(`require('./package.json').packageManager.split('@')[1].split('+')[0]`);
    expect(text).toMatch(/\[ "\$got" = "\$want" \]/);
    expect(install).toBeLessThan(text.indexOf('RUN pnpm install'));
  });

  it('applies the OS security updates in the runtime stage and leaves no package lists behind', () => {
    const runtime = text.slice(text.search(/^FROM\s.*\sAS runtime$/m));
    expect(runtime).toMatch(/apt-get update/);
    expect(runtime).toMatch(/apt-get -y (?:--no-install-recommends )?upgrade/);
    expect(runtime).toContain('rm -rf /var/lib/apt/lists/*');
    expect(runtime).toContain('DEBIAN_FRONTEND=noninteractive');
  });

  it('keeps the runtime stage minimal and non-root: no npm, npx, corepack or yarn, numeric user 1000:1000', () => {
    const runtime = text.slice(text.search(/^FROM\s.*\sAS runtime$/m));
    for (const bin of ['npm', 'npx', 'corepack', 'yarn']) expect(runtime).toContain(`/usr/local/bin/${bin}`);
    expect(runtime).toContain('rm -rf /usr/local/lib/node_modules');
    expect(runtime).toMatch(/^USER 1000:1000$/m);
  });
});

describe('scripts', () => {
  let dir: string;
  let bin: string;
  let log: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'docker-image-'));
    bin = join(dir, 'bin');
    log = join(dir, 'calls.log');
    mkdirSync(bin);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const run = (script: string, args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      cwd: dir,
      env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin`, HOME: dir, ...env },
    });
    return { status: r.status, out: r.stdout, err: r.stderr, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] };
  };
  const outputs = (file: string) => Object.fromEntries(readFileSync(file, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

  describe('resolve-base-image.sh', () => {
    const dockerfile = (body: string) => {
      writeFileSync(join(dir, 'Dockerfile'), body);
      return join(dir, 'Dockerfile');
    };
    const manifest = (digest: string) => `cat <<'EOF'\n{\n  "schemaVersion": 2,\n  "digest": "${digest}",\n  "manifests": [{ "digest": "sha256:${'cd'.repeat(32)}" }]\n}\nEOF`;

    it('resolves the tag once, writes the pinned build context and the digest to the outputs and the summary', () => {
      stub('docker', manifest(DIGEST));
      const file = dockerfile('FROM --platform=$BUILDPLATFORM node:26-trixie-slim AS build\nRUN true\nFROM node:26-trixie-slim AS runtime\n');
      const out = join(dir, 'out');
      const summary = join(dir, 'summary');
      const r = run(RESOLVE, [file], { GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary });
      expect(r.status, r.err).toBe(0);
      expect(r.calls).toEqual([`docker buildx imagetools inspect node:26-trixie-slim --format {{json .Manifest}}`]);
      expect(outputs(out)).toEqual({
        image: 'node:26-trixie-slim',
        digest: DIGEST,
        context: `node:26-trixie-slim=docker-image://node:26-trixie-slim@${DIGEST}`,
      });
      expect(r.out).toContain(`node:26-trixie-slim@${DIGEST}`);
      expect(readFileSync(summary, 'utf8')).toContain(`\`node:26-trixie-slim@${DIGEST}\``);
    });

    it('defaults to ./Dockerfile and prints without GitHub outputs', () => {
      stub('docker', manifest(DIGEST));
      dockerfile('FROM node:26-trixie-slim AS runtime\n');
      const r = run(RESOLVE, []);
      expect(r.status, r.err).toBe(0);
      expect(r.out).toContain(`node:26-trixie-slim@${DIGEST}`);
    });

    it('leaves an already digest-pinned base as it is (an older release\'s Dockerfile): no context, no lookup', () => {
      stub('docker', 'exit 1');
      const file = dockerfile(`FROM node:22-bookworm-slim@${DIGEST} AS build\nFROM node:22-bookworm-slim@${DIGEST} AS runtime\n`);
      const out = join(dir, 'out');
      const r = run(RESOLVE, [file], { GITHUB_OUTPUT: out });
      expect(r.status, r.err).toBe(0);
      expect(r.calls).toEqual([]);
      expect(outputs(out)).toEqual({ image: 'node:22-bookworm-slim', digest: DIGEST, context: '' });
    });

    it('refuses stages on different base images', () => {
      stub('docker', manifest(DIGEST));
      const r = run(RESOLVE, [dockerfile('FROM node:26-trixie-slim AS build\nFROM node:26-bookworm-slim AS runtime\n')]);
      expect(r.status).toBe(1);
      expect(r.out + r.err).toContain('one base image');
    });

    it('fails when the registry answer has no digest', () => {
      stub('docker', manifest('sha256:nope'));
      const r = run(RESOLVE, [dockerfile('FROM node:26-trixie-slim AS runtime\n')]);
      expect(r.status).toBe(1);
      expect(r.out + r.err).toContain('could not resolve');
    });
  });

  describe('scan-image.sh', () => {
    it('fails on HIGH or CRITICAL vulnerabilities that have a fix, in OS packages and node_modules, with the reviewed ignore file', () => {
      stub('trivy', 'exit 0');
      const r = run(SCAN, ['chartmate:smoke']);
      expect(r.status, r.err).toBe(0);
      const call = r.calls.find((c) => c.startsWith('trivy image'))!;
      for (const flag of ['--scanners vuln', '--pkg-types os,library', '--severity HIGH,CRITICAL', '--ignore-unfixed', '--exit-code 1', `--ignorefile ${path('.trivyignore')}`]) {
        expect(call).toContain(flag);
      }
      expect(call.endsWith(' chartmate:smoke')).toBe(true);
    });

    it('passes the scanner\'s failure on', () => {
      stub('trivy', '[ "$1" = image ] && exit 1; exit 0');
      const summary = join(dir, 'summary');
      const r = run(SCAN, ['chartmate:smoke'], { GITHUB_STEP_SUMMARY: summary });
      expect(r.status).toBe(1);
      expect(readFileSync(summary, 'utf8')).toMatch(/chartmate:smoke.*fixable HIGH\/CRITICAL/);
    });

    it('needs an image', () => {
      stub('trivy', 'exit 0');
      expect(run(SCAN, []).status).not.toBe(0);
    });
  });

  describe('install-trivy.sh', () => {
    it('pins Trivy by exact version and the sha256 of each platform\'s release archive', () => {
      const script = root('.github/scripts/install-trivy.sh');
      expect(script).toMatch(/^version=\d+\.\d+\.\d+$/m);
      for (const p of ['Linux-64bit', 'Linux-ARM64', 'macOS-ARM64']) expect(script).toMatch(new RegExp(`${p}\\) sha256=[0-9a-f]{64} ;;`));
    });

    it('refuses an archive that does not match the pinned sha256 and installs nothing', () => {
      stub('curl', 'for a in "$@"; do case "$prev" in -o) out="$a" ;; esac; prev="$a"; done; printf "not trivy" > "$out"');
      const dest = join(dir, 'trivy-bin');
      const r = run(INSTALL_TRIVY, [dest], { RUNNER_TEMP: dir });
      expect(r.status).toBe(1);
      expect(r.out + r.err).toContain('does not match the pinned sha256');
      expect(existsSync(join(dest, 'trivy'))).toBe(false);
      expect(r.calls[0]).toMatch(/^curl .*https:\/\/github\.com\/aquasecurity\/trivy\/releases\/download\/v\d+\.\d+\.\d+\/trivy_\d+\.\d+\.\d+_\S+\.tar\.gz$/);
    });
  });
});

describe('.trivyignore', () => {
  it('ignores only reviewed findings, each with a reason above it and an expiry date', () => {
    const lines = root('.trivyignore').split('\n');
    lines.forEach((line, i) => {
      if (!line.trim() || line.startsWith('#')) return;
      expect(line, line).toMatch(/^(?:CVE-\d{4}-\d+|GHSA(?:-[0-9a-z]{4}){3}) exp:\d{4}-\d{2}-\d{2}$/);
      expect(lines[i - 1], `${line}: the line above says why`).toMatch(/^# \S/);
    });
  });
});
