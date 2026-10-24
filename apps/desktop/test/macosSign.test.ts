// .github/scripts/macos-sign.sh, run for real under /bin/bash (3.2 on macOS) with the Apple tools stubbed on PATH.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../../.github/scripts/macos-sign.sh', import.meta.url));
const IDENTITY = 'Developer ID Application: Jane Doe (TEAM123456)';

let dir: string;
let bin: string;
let tmp: string;
let log: string;

function stub(name: string, body: string) {
  const p = join(bin, name);
  writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
  chmodSync(p, 0o755);
}

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('/bin/bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, RUNNER_TEMP: tmp, HOME: dir, ...env },
  });
  return { status: r.status, out: r.stdout, err: r.stderr, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'macos-sign-'));
  bin = join(dir, 'bin');
  tmp = join(dir, 'runner-temp');
  log = join(dir, 'calls.log');
  mkdirSync(bin);
  mkdirSync(tmp);
  stub('base64', 'cat');
  stub('openssl', 'echo 0123456789abcdef');
  stub('security', `case "$1" in
  find-identity) [ -n "$STUB_NO_IDENTITY" ] || echo '  1) ABCDEF "${IDENTITY}"' ;;
  list-keychains) [ "$3" = -s ] || echo '    "/Users/runner/Library/Keychains/login.keychain-db"' ;;
esac
exit 0`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('macos-sign.sh import', () => {
  const env = { CSC_LINK: 'cDEy', CSC_KEY_PASSWORD: 'secret', IDENTITY };

  it('imports the key non-extractable, succeeds, and leaves no decoded .p12 behind', () => {
    const r = run(['import'], env);
    expect(r.err).not.toMatch(/unbound/);
    expect(r.status).toBe(0);
    expect(r.out).toContain(`imported "${IDENTITY}"`);
    expect(r.calls.find((c) => c.startsWith('security import'))).toMatch(/-f pkcs12 -P secret -x -T \/usr\/bin\/codesign$/);
    expect(readdirSync(tmp).filter((f) => f.startsWith('csc.'))).toEqual([]);
  });

  it('fails when the identity is not in the .p12, still removing the decoded key', () => {
    const r = run(['import'], { ...env, STUB_NO_IDENTITY: '1' });
    expect(r.status).toBe(1);
    expect(r.err).toContain('no valid identity');
    expect(readdirSync(tmp).filter((f) => f.startsWith('csc.'))).toEqual([]);
  });

  it('refuses to run without the secrets', () => {
    const r = run(['import'], { IDENTITY });
    expect(r.status).toBe(1);
    expect(r.err).toContain('CSC_LINK is not set');
    expect(r.calls).toEqual([]);
  });
});

describe('macos-sign.sh sign-app (only the expected Electron code is signed)', () => {
  let app: string;
  const write = (rel: string, kind: 'EXE' | 'LIB' | 'DATA') => {
    const p = join(app, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, kind);
  };

  beforeEach(() => {
    // `file` reports what the stub tree says each file is; codesign only records its calls.
    stub('file', `case "$(head -c 3 "$2")" in EXE) echo "Mach-O 64-bit executable arm64" ;; LIB) echo "Mach-O 64-bit dynamically linked shared library arm64" ;; *) echo data ;; esac`);
    stub('codesign', 'exit 0');
    app = join(dir, 'Chartmate.app');
    write('Contents/MacOS/Chartmate', 'EXE');
    write('Contents/Resources/app.asar', 'DATA');
    const fw = 'Contents/Frameworks/Electron Framework.framework';
    write(`${fw}/Versions/A/Electron Framework`, 'LIB');
    write(`${fw}/Versions/A/Libraries/libffmpeg.dylib`, 'LIB');
    write(`${fw}/Versions/A/Helpers/chrome_crashpad_handler`, 'EXE');
    write(`${fw}/Versions/A/Helpers/app_shim_loader`, 'EXE'); // since Electron 45
    symlinkSync('A', join(app, fw, 'Versions/Current'));
    write('Contents/Frameworks/Squirrel.framework/Versions/A/Squirrel', 'LIB');
    write('Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt', 'EXE');
    for (const h of ['', ' (GPU)', ' (Renderer)', ' (Plugin)']) write(`Contents/Frameworks/Chartmate Helper${h}.app/Contents/MacOS/Chartmate Helper${h}`, 'EXE');
    for (const f of ['ent.plist', 'inherit.plist']) writeFileSync(join(dir, f), '<plist/>');
  });

  const signApp = () => run(['sign-app', app, join(dir, 'ent.plist'), join(dir, 'inherit.plist')], { IDENTITY });
  const signed = (calls: string[]) => calls.filter((c) => c.startsWith('codesign --force')).map((c) => c.slice(c.lastIndexOf(`${dir}/`) + dir.length + 1));

  it('signs inside-out: nested code deepest first, the app last with its own entitlements, then verifies', () => {
    const r = signApp();
    expect(r.err).toBe('');
    expect(r.status).toBe(0);
    const order = signed(r.calls);
    expect(order.at(-1)).toBe('Chartmate.app');
    expect(order).toHaveLength(18); // 17 nested items (7 Mach-O files, 4 helper executables and their 4 apps, 2 frameworks) + the app
    expect(order.indexOf('Chartmate.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib'))
      .toBeLessThan(order.indexOf('Chartmate.app/Contents/Frameworks/Electron Framework.framework'));
    const main = r.calls.filter((c) => c.startsWith('codesign --force')).at(-1)!;
    expect(main).toContain(`--timestamp --keychain ${tmp}/chartmate-signing.keychain-db --entitlements ${dir}/ent.plist`);
    expect(r.calls.at(-1)).toMatch(/^codesign --verify --deep --strict/);
  });

  for (const [what, rel, kind] of [
    ['an executable outside the Electron layout', 'Contents/Resources/payload', 'EXE'],
    ['an extra dylib in the framework', 'Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libextra.dylib', 'LIB'],
    ['a native module', 'Contents/Resources/app.asar.unpacked/addon.node', 'LIB'],
    ['an extra executable next to the main one', 'Contents/MacOS/helper', 'EXE'],
    ['an unknown framework', 'Contents/Frameworks/Extra.framework/Versions/A/Extra', 'LIB'],
    ['an unknown helper in the Electron framework', 'Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/extra_loader', 'EXE'],
  ] as const) {
    it(`refuses ${what} before signing anything`, () => {
      write(rel, kind);
      const r = signApp();
      expect(r.status).toBe(1);
      expect(r.err).toContain('unexpected code');
      expect(signed(r.calls)).toEqual([]);
    });
  }
});

describe('macos-sign.sh store-notary (a signed release is notarized unless the owner opts out)', () => {
  it('fails without notarization credentials', () => {
    const r = run(['store-notary']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('CHARTMATE_ALLOW_UNNOTARIZED_MAC=true');
    expect(r.out).not.toContain('notarize=');
  });

  it('with ALLOW_UNNOTARIZED=true, goes on without notarizing and warns', () => {
    const r = run(['store-notary'], { ALLOW_UNNOTARIZED: 'true' });
    expect(r.status).toBe(0);
    expect(r.out.trim()).toBe('notarize=false');
    expect(r.err).toContain('::warning title=macOS not notarized::');
    for (const v of ['1', 'yes', 'TRUE']) expect(run(['store-notary'], { ALLOW_UNNOTARIZED: v }).status, v).toBe(1);
  });

  it('with the credentials, stores the notarytool profile in the temporary keychain', () => {
    stub('xcrun', 'exit 0');
    writeFileSync(join(tmp, 'chartmate-signing.keychain-db'), '');
    const r = run(['store-notary'], { APPLE_ID: 'a@b.c', APPLE_APP_SPECIFIC_PASSWORD: 'p', APPLE_TEAM_ID: 'TEAM123456' });
    expect(r.status).toBe(0);
    expect(r.out.trim()).toBe('notarize=true');
    expect(r.calls.find((c) => c.startsWith('xcrun notarytool store-credentials'))).toContain('--team-id TEAM123456');
  });

  it('half-configured credentials fail even with the opt-out', () => {
    const r = run(['store-notary'], { APPLE_ID: 'a@b.c', ALLOW_UNNOTARIZED: 'true' });
    expect(r.status).toBe(1);
    expect(r.err).toContain('APPLE_APP_SPECIFIC_PASSWORD is not set');
  });
});

describe('macos-sign.sh check-dmg / check-zip (the release files hold exactly the app sign-mac signed)', () => {
  const CDHASH = 'ab'.repeat(20);
  let content: string;
  beforeEach(() => {
    // hdiutil attach and ditto -x copy the fixture tree to the mount point / destination; codesign reports
    // STUB_CDHASH (default: the expected hash) and fails verification when STUB_VERIFY_FAIL is set.
    content = join(dir, 'content');
    mkdirSync(join(content, 'Chartmate.app', 'Contents'), { recursive: true });
    writeFileSync(join(content, '.DS_Store'), '');
    writeFileSync(join(content, '.VolumeIcon.icns'), '');
    writeFileSync(join(content, '.background.tiff'), '');
    symlinkSync('/Applications', join(content, 'Applications'));
    stub('hdiutil', `if [ "$1" = attach ]; then
  while [ $# -gt 0 ]; do [ "$1" = -mountpoint ] && mp="$2"; shift; done
  cp -R "${content}/." "$mp/"
fi
exit 0`);
    stub('ditto', `[ "$1" = -x ] && cp -R "${content}/." "$4/"; exit 0`);
    stub('codesign', `case "$1" in
  --verify) [ -z "$STUB_VERIFY_FAIL" ] ;;
  -dvvv) echo "CDHash=\${STUB_CDHASH:-${CDHASH}}" >&2 ;;
esac`);
  });
  const dmg = (env: Record<string, string> = {}) => run(['check-dmg', join(dir, 'x.dmg'), CDHASH], env);
  const zip = (env: Record<string, string> = {}) => run(['check-zip', join(dir, 'x.zip'), CDHASH], env);
  const zipOnlyApp = () => {
    for (const f of ['.DS_Store', '.VolumeIcon.icns', '.background.tiff', 'Applications']) rmSync(join(content, f));
  };

  it('accepts electron-builder\'s dmg layout holding the signed app', () => {
    const r = dmg();
    expect(r.err).toBe('');
    expect(r.status).toBe(0);
    expect(r.out).toContain(`holds the signed app (${CDHASH})`);
  });

  for (const [what, make] of [
    ['a second app', () => mkdirSync(join(content, 'Other.app'))],
    ['a script', () => writeFileSync(join(content, 'install.command'), '#!/bin/sh')],
    ['a hidden folder', () => mkdirSync(join(content, '.hidden'))],
    ['an Applications link to somewhere else', () => { rmSync(join(content, 'Applications')); symlinkSync('/tmp', join(content, 'Applications')); }],
    ['an Applications folder instead of the link', () => { rmSync(join(content, 'Applications')); mkdirSync(join(content, 'Applications')); }],
    ['a renamed app', () => renameSync(join(content, 'Chartmate.app'), join(content, 'Chartmate 2.app'))],
  ] as const) {
    it(`refuses a dmg with ${what} at the top level`, () => {
      make();
      const r = dmg();
      expect(r.status).toBe(1);
      expect(r.calls.some((c) => c.startsWith('codesign -dvvv'))).toBe(false);
    });
  }

  it('refuses a dmg whose app is not the one signed, or does not verify', () => {
    expect(dmg({ STUB_CDHASH: 'cd'.repeat(20) }).err).toContain('not the one signed');
    expect(dmg({ STUB_VERIFY_FAIL: '1' }).status).toBe(1);
  });

  it('accepts a zip holding exactly the signed app, and removes what it extracted', () => {
    zipOnlyApp();
    const r = zip();
    expect(r.err).toBe('');
    expect(r.status).toBe(0);
    expect(r.calls.find((c) => c.startsWith('ditto'))).toMatch(/^ditto -x -k \S+x\.zip \S+\/zip\.\w+$/);
    expect(readdirSync(tmp).filter((f) => f.startsWith('zip.'))).toEqual([]);
  });

  it('refuses a zip with anything besides the app, another app hash, or an app that does not verify', () => {
    expect(zip().status).toBe(1); // the dmg extras
    zipOnlyApp();
    expect(zip({ STUB_CDHASH: 'cd'.repeat(20) }).err).toContain('not the one signed');
    expect(zip({ STUB_VERIFY_FAIL: '1' }).err).toContain('does not verify');
    writeFileSync(join(content, 'extra'), '');
    expect(zip().err).toContain('must hold exactly Chartmate.app');
    expect(readdirSync(tmp).filter((f) => f.startsWith('zip.'))).toEqual([]);
  });
});
