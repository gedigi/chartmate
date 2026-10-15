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
    // No pnpm (or corepack) command runs before it: otherwise the wrapper would download pnpm's native binary,
    // checked only against npm's signature.
    const runs = [...text.matchAll(/^RUN [^\n]*(?:\\\n[^\n]*)*/gm)];
    expect(runs.find((r) => /\b(pnpm|corepack)\b/.test(r[0]))!.index).toBe(install);
    expect(text).not.toMatch(/corepack enable/);
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
    const GATE = ['--config /dev/null', '--scanners vuln', '--pkg-types os,library', '--severity HIGH,CRITICAL', '--ignore-unfixed', '--exit-code 1', `--ignorefile ${path('.trivyignore')}`];
    const gate = (calls: string[]) => calls.find((c) => c.startsWith('trivy image') && c.includes('--exit-code 1'))!;

    it('fails on HIGH or CRITICAL vulnerabilities that have a fix, in OS packages and node_modules, with the reviewed ignore file', () => {
      stub('trivy', 'exit 0');
      const r = run(SCAN, ['chartmate:smoke']);
      expect(r.status, r.err).toBe(0);
      const call = gate(r.calls);
      for (const flag of [...GATE, '--image-src docker']) expect(call).toContain(flag);
      expect(call).not.toContain('--platform');
      expect(call.endsWith(' chartmate:smoke')).toBe(true);
    });

    it('scans a pushed digest in the registry for one platform (the publish jobs)', () => {
      stub('trivy', 'exit 0');
      const ref = `ghcr.io/o/r@${DIGEST}`;
      const r = run(SCAN, [ref, '--platform', 'linux/arm64', '--remote']);
      expect(r.status, r.err).toBe(0);
      const call = gate(r.calls);
      for (const flag of [...GATE, '--image-src remote', '--platform linux/arm64']) expect(call).toContain(flag);
      expect(call.endsWith(` ${ref}`)).toBe(true);
      expect(run(SCAN, [ref, '--bogus']).status).toBe(2);
    });

    it('passes the scanner\'s failure on', () => {
      stub('trivy', '[ "$1" = image ] && exit 1; exit 0');
      const summary = join(dir, 'summary');
      const r = run(SCAN, ['chartmate:smoke'], { GITHUB_STEP_SUMMARY: summary });
      expect(r.status).toBe(1);
      expect(readFileSync(summary, 'utf8')).toMatch(/chartmate:smoke.*fixable HIGH\/CRITICAL/);
    });

    it('lists the unfixed HIGH/CRITICAL findings in the job summary without failing', () => {
      // The informational run writes a JSON report (--output); the gate passes.
      stub('trivy', `case "$*" in *"--format json"*)
  for a in "$@"; do [ "$prev" = --output ] && out="$a"; prev="$a"; done
  printf '%s' '{"Results":[{"Vulnerabilities":[{"VulnerabilityID":"CVE-2026-1","Severity":"HIGH","PkgName":"libfoo","InstalledVersion":"1.0"},{"VulnerabilityID":"CVE-2026-2","Severity":"CRITICAL","PkgName":"libbar","InstalledVersion":"2.0","FixedVersion":"2.1"}]}]}' > "$out" ;;
esac
exit 0`);
      const summary = join(dir, 'summary');
      const r = run(SCAN, ['chartmate:smoke'], { GITHUB_STEP_SUMMARY: summary });
      expect(r.status, r.err).toBe(0);
      const text = readFileSync(summary, 'utf8');
      expect(text).toContain('no fixable HIGH/CRITICAL');
      expect(text).toContain('1 unfixed HIGH/CRITICAL findings');
      expect(text).toContain('| HIGH | CVE-2026-1 | libfoo 1.0 |');
      expect(text).not.toContain('CVE-2026-2');
      const info = r.calls.find((c) => c.includes('--format json'))!;
      expect(info).toContain('--exit-code 0');
      expect(info).not.toContain('--ignore-unfixed');
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

/**
 * Problems with a .trivyignore (empty = fine). The header is everything up to the first blank line. Each entry is
 * one ID with `exp:YYYY-MM-DD`, a real date from `today` to 90 days after it, directly below its own reason comment
 * (not a header line).
 */
function trivyignoreProblems(text: string, today: Date): string[] {
  const lines = text.split('\n');
  const headerEnd = lines.findIndex((l) => l.trim() === '');
  const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const problems: string[] = [];
  lines.forEach((line, i) => {
    if (!line.trim() || line.startsWith('#')) return;
    const m = /^(?:CVE-\d{4}-\d+|GHSA(?:-[0-9a-z]{4}){3}) exp:(\d{4})-(\d{2})-(\d{2})$/.exec(line);
    if (!m) return void problems.push(`${line}: not "<CVE or GHSA id> exp:YYYY-MM-DD"`);
    const exp = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (exp.getUTCFullYear() !== Number(m[1]) || exp.getUTCMonth() !== Number(m[2]) - 1 || exp.getUTCDate() !== Number(m[3])) {
      problems.push(`${line}: not a real date`);
    } else if (exp.getTime() < day(today)) {
      problems.push(`${line}: expired (review it again, then remove it or renew it)`);
    } else if (exp.getTime() > day(today) + 90 * 86_400_000) {
      problems.push(`${line}: expires more than 90 days out`);
    }
    if (headerEnd < 0 || i - 1 <= headerEnd || !/^# \S/.test(lines[i - 1] ?? '')) problems.push(`${line}: no reason comment directly above it`);
  });
  return problems;
}

describe('.trivyignore', () => {
  const HEADER = '# header\n#   CVE-2026-0 exp:2026-01-01\n\n';
  const today = new Date(Date.UTC(2026, 9, 15));

  it('the reviewed exceptions in the repository pass the rules', () => {
    expect(trivyignoreProblems(root('.trivyignore'), new Date())).toEqual([]);
  });

  it('accepts an entry with its reason, expiring within 90 days', () => {
    expect(trivyignoreProblems(`${HEADER}# libfoo: never reached. Reviewed by G, 2026-10-15.\nCVE-2026-12345 exp:2027-01-13\n`, today)).toEqual([]);
  });

  it('refuses a past, too distant or impossible expiry date', () => {
    const entry = (exp: string) => trivyignoreProblems(`${HEADER}# reason\nCVE-2026-1 exp:${exp}\n`, today);
    expect(entry('2026-10-14')[0]).toMatch(/expired/);
    expect(entry('2027-01-14')[0]).toMatch(/more than 90 days/);
    expect(entry('2026-02-30')[0]).toMatch(/not a real date/);
    expect(entry('2026-10-15')).toEqual([]);
  });

  it('refuses an entry without its own reason comment, or with only the header above it', () => {
    expect(trivyignoreProblems(`${HEADER}CVE-2026-1 exp:2026-11-01\n`, today)[0]).toMatch(/no reason comment/);
    expect(trivyignoreProblems(`# header\nCVE-2026-1 exp:2026-11-01\n`, today)[0]).toMatch(/no reason comment/);
    expect(trivyignoreProblems(`${HEADER}# reason\n\nCVE-2026-1 exp:2026-11-01\n`, today)[0]).toMatch(/no reason comment/);
    expect(trivyignoreProblems(`${HEADER}# reason\nCVE-2026-1\n`, today)[0]).toMatch(/not "/);
  });
});
