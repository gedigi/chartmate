// .github/scripts/install-corepack.sh, run for real under bash with npm stubbed on PATH (no network).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../../.github/scripts/install-corepack.sh', import.meta.url));

let dir: string;
let bin: string;
let log: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'install-corepack-'));
  bin = join(dir, 'bin');
  log = join(dir, 'calls.log');
  mkdirSync(bin);
  // npm pack writes a tarball whose bytes are not the pinned release; npm install only records the call.
  writeFileSync(join(bin, 'npm'), `#!/bin/sh
echo "npm $*" >> "${log}"
if [ "$1" = pack ]; then
  for a in "$@"; do case "$a" in --pack-destination=*) dest="\${a#--pack-destination=}" ;; esac; done
  printf 'not corepack' > "$dest/corepack-0.0.0.tgz"
  echo corepack-0.0.0.tgz
fi
exit 0
`);
  chmodSync(join(bin, 'npm'), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run() {
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, RUNNER_TEMP: dir, HOME: dir },
  });
  return { status: r.status, out: r.stdout, err: r.stderr, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] };
}

describe('install-corepack.sh', () => {
  it('pins corepack by exact version and sha512', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).toMatch(/^version=\d+\.\d+\.\d+$/m);
    expect(script).toMatch(/^integrity=sha512-[A-Za-z0-9+/]{86}==$/m);
  });

  it('refuses a tarball that does not match the pinned sha512 and installs nothing', () => {
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toContain('corepack tarball does not match the pinned sha512');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatch(/^npm pack corepack@\d+\.\d+\.\d+ --pack-destination=\S+ --silent$/);
    expect(r.calls.some((c) => c.startsWith('npm install'))).toBe(false);
  });
});
