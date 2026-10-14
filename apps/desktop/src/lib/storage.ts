import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Creates `dir` (and parents) and makes it owner-only (0700). chmod is a no-op for ACL-based Windows paths. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Makes existing files owner read/write only (0600); missing files are skipped. */
export function restrictFiles(paths: readonly string[]): void {
  for (const p of paths) {
    if (existsSync(p)) chmodSync(p, 0o600);
  }
}

function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    // Different volume: copy then remove.
    copyFileSync(from, to);
    rmSync(from, { force: true });
  }
}

/**
 * After a product rename the per-user data directory changes (it is named after the product). Moves `files` from
 * the first legacy directory that has `marker` into `target`, unless `target` already has its own `marker`
 * (never overwrites). Returns the directory migrated from, or null.
 */
export function migrateLegacyUserData(opts: { target: string; legacyDirs: readonly string[]; files: readonly string[]; marker: string }): string | null {
  const target = resolve(opts.target);
  if (existsSync(join(target, opts.marker))) return null;
  for (const dir of opts.legacyDirs) {
    const from = resolve(dir);
    if (from === target || !existsSync(join(from, opts.marker))) continue;
    ensurePrivateDir(target);
    for (const f of opts.files) {
      const src = join(from, f);
      if (!existsSync(src)) continue;
      const dst = join(target, f);
      moveFile(src, dst);
      chmodSync(dst, 0o600);
    }
    return from;
  }
  return null;
}
