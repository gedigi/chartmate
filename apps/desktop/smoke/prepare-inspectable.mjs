// ============================================================================================================
//  TEST-ONLY. NEVER SHIPPED. Builds an "inspectable" copy of a packaged app for the functional smoke test.
// ============================================================================================================
// The shipped app exits when started with debugging switches (src/boot.ts), so no harness can attach to it. This
// script makes a separate copy whose ONLY code difference is that this switch guard is compiled out
// (scripts/bundle.mjs --test-inspectable); the server, web UI, protocol handler, CSP, hardening and all other
// fuses are identical. The copy is renamed "<Product> TEST-ONLY.app" and carries a TEST-ONLY marker file.
//   - macOS: app.asar is rebuilt, its header hash is updated in Info.plist (asar integrity validation stays ON),
//     and the copy is ad-hoc re-signed.
//   - Windows: the integrity hash lives in an executable resource, so the copy instead turns the
//     EnableEmbeddedAsarIntegrityValidation fuse OFF (test copy only).
// Release builds never run this script; electron-builder packages dist/ from scripts/bundle.mjs without the flag.
//
// Usage: node smoke/prepare-inspectable.mjs <path/to/Chartmate.app | path/to/win-unpacked> <outDir>
// Prints the path of the prepared copy (.app or .exe).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import asar from '@electron/asar';
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses';

const [srcArg, outArg] = process.argv.slice(2);
if (!srcArg || !outArg || !existsSync(srcArg)) {
  console.error('usage: prepare-inspectable.mjs <Chartmate.app | win-unpacked dir> <outDir>');
  process.exit(2);
}
const src = resolve(srcArg);
const outDir = resolve(outArg);
const isMacApp = src.endsWith('.app');
const MARKER = 'TEST-ONLY-NOT-FOR-DISTRIBUTION.txt';
const markerText = 'Test-only inspectable copy built by apps/desktop/smoke/prepare-inspectable.mjs. Do not distribute.\n';

// 1. Copy.
const name = isMacApp ? `${basename(src, '.app')} TEST-ONLY.app` : `${basename(src)}-TEST-ONLY`;
const dst = join(outDir, name);
rmSync(dst, { recursive: true, force: true });
cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
const resources = isMacApp ? join(dst, 'Contents', 'Resources') : join(dst, 'resources');
const asarPath = join(resources, 'app.asar');

// 2. Test-only bundle (switch guard compiled out), same sources otherwise.
const work = mkdtempSync(join(tmpdir(), 'inspectable-'));
const testDist = join(work, 'dist');
execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/bundle.mjs', import.meta.url)), '--test-inspectable', `--out=${testDist}`,
  `--platform=${isMacApp ? 'darwin' : 'win32'}`], { stdio: 'inherit' });

// 3. Rebuild app.asar with the test bundle.
const unpacked = join(work, 'app');
asar.extractAll(asarPath, unpacked);
rmSync(join(unpacked, 'dist'), { recursive: true, force: true });
cpSync(testDist, join(unpacked, 'dist'), { recursive: true });
writeFileSync(join(unpacked, MARKER), markerText);
rmSync(asarPath);
await asar.createPackageWithOptions(unpacked, asarPath, {});
writeFileSync(join(resources, MARKER), markerText);

if (isMacApp) {
  // 4a. Asar integrity stays on: update the header hash electron-builder put in Info.plist, then re-sign ad hoc.
  const plist = join(dst, 'Contents', 'Info.plist');
  const hash = createHash('sha256').update(asar.getRawHeader(asarPath).headerString).digest('hex');
  execFileSync('plutil', ['-replace', 'ElectronAsarIntegrity', '-json', JSON.stringify({ 'Resources/app.asar': { algorithm: 'SHA256', hash } }), plist]);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', dst], { stdio: 'inherit' });
  console.log(dst);
} else {
  // 4b. Windows test copy: asar integrity validation off (the hash is a PE resource).
  const exe = readdirSync(dst).find((f) => f.endsWith('.exe') && !/^(elevate|Uninstall)/i.test(f));
  if (!exe) throw new Error(`no executable in ${dst}`);
  await flipFuses(join(dst, exe), { version: FuseVersion.V1, [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false });
  console.log(join(dst, exe));
}
rmSync(work, { recursive: true, force: true });
