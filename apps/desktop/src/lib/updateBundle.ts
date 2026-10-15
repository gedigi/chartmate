import { execFile } from 'node:child_process';
import { chmod, lstat, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNewerVersion, parseSemver } from './semver.js';

/**
 * Pre-install check of a downloaded macOS update: before electron-updater hands the zip to Squirrel.Mac, extract it
 * with the same tool family Squirrel.Mac uses (`/usr/bin/ditto`) into a private temp directory, require exactly one
 * top-level `*.app`, read its CFBundleShortVersionString with `/usr/bin/plutil` (XML and binary plists alike), and
 * require it to be the version the release advertised AND newer than the running app. Squirrel.Mac itself would
 * install an older (validly signed) app, so this is what keeps a downgrade from being installed on macOS.
 * Everything unexpected fails closed (throws); the temp directory is always removed (read-only directories included),
 * and a cleanup failure is only logged.
 */

export const DITTO = '/usr/bin/ditto';
export const PLUTIL = '/usr/bin/plutil';
/** Release zips are ~115 MB; anything far outside that is not ours. */
export const MAX_ZIP_BYTES = 1024 * 1024 * 1024;
export const EXTRACT_TIMEOUT_MS = 120_000;
const PLUTIL_TIMEOUT_MS = 10_000;

export type BundleExec = (
  cmd: string,
  args: string[],
  opts: { timeout: number; shell: false; windowsHide: boolean; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

export async function checkDownloadedBundle(
  zipFile: string,
  o: {
    advertised: unknown; current: string; tmpRoot?: string; exec?: BundleExec;
    /** Notified when the temp directory cannot be removed (the check result is unaffected). */
    log?: (msg: string) => void;
    /** Test seam for the temp directory removal (default removeTree). */
    remove?: (dir: string) => Promise<void>;
  },
): Promise<void> {
  const exec = o.exec ?? defaultExec;
  const st = await stat(zipFile);
  if (!st.isFile() || st.size === 0 || st.size > MAX_ZIP_BYTES) throw new Error('downloaded update has an unexpected size');

  // mkdtemp creates the directory owner-only (0700); chmod again in case of an unusual umask.
  const dir = await mkdtemp(join(o.tmpRoot ?? tmpdir(), 'chartmate-update-check-'));
  try {
    await chmod(dir, 0o700);
    try {
      await exec(DITTO, ['-x', '-k', zipFile, dir], { timeout: EXTRACT_TIMEOUT_MS, shell: false, windowsHide: true, maxBuffer: 1 << 20 });
    } catch {
      throw new Error('downloaded update could not be extracted');
    }
    const entries = await readdir(dir);
    const app = entries.length === 1 && entries[0]!.endsWith('.app') ? entries[0]! : null;
    if (!app || !(await lstat(join(dir, app))).isDirectory()) throw new Error('downloaded update must contain exactly one app');

    let raw: string;
    try {
      raw = (await exec(PLUTIL, ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(dir, app, 'Contents', 'Info.plist')], {
        timeout: PLUTIL_TIMEOUT_MS, shell: false, windowsHide: true, maxBuffer: 64 * 1024,
      })).stdout;
    } catch {
      throw new Error('downloaded update has no readable version');
    }
    const version = raw.trim();
    if (!parseSemver(version)) throw new Error('downloaded update has no valid version');
    if (version !== o.advertised) throw new Error(`downloaded update version ${version} does not match the release`);
    if (!isNewerVersion(version, o.current)) throw new Error(`downloaded update version ${version} is not newer than ${o.current}`);
  } finally {
    // Cleanup never replaces the result: a failed removal is logged, the check's outcome stands.
    try {
      await (o.remove ?? removeTree)(dir);
    } catch (err) {
      o.log?.(`could not remove the update check directory: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
    }
  }
}

/**
 * rm -rf that also handles read-only directories (an app bundle may contain 0555 ones, which make `rm` fail with
 * EACCES on their entries): every directory in the tree is made owner-writable first. Symlinks are never followed.
 */
export async function removeTree(dir: string): Promise<void> {
  await makeWritable(dir).catch(() => {});
  await rm(dir, { recursive: true, force: true });
}

async function makeWritable(dir: string): Promise<void> {
  const st = await lstat(dir);
  if (!st.isDirectory()) return;
  await chmod(dir, (st.mode & 0o7777) | 0o700);
  for (const name of await readdir(dir)) await makeWritable(join(dir, name));
}

/** execFile (no shell), absolute command paths only. */
const defaultExec: BundleExec = (cmd, args, opts) => new Promise((resolve, reject) => {
  execFile(cmd, args, opts, (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout: String(stdout), stderr: String(stderr) })));
});
