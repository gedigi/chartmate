/**
 * Sync merge: one document per key (the watchlist, a layout, a symbol's drawings, a basket), each stamped with the
 * time it last changed (`t`, ms). A deleted document stays in the sync file as a tombstone, so the deletion reaches the
 * other devices. `base` is what this device last agreed on with the file: it tells a local edit (`t` moved) from an
 * untouched copy, and a local deletion (in base, gone here) from a document this device never had.
 */

/** A document's state: its value, or a tombstone. */
export interface DocState { t: number; v?: unknown; deleted?: true }
export type Docs = Record<string, DocState>;
/** The last agreed stamp of each document (and whether it was a tombstone). */
export type Base = Record<string, { t: number; deleted?: true }>;

export interface MergeResult {
  /** The merged sync file. */
  remote: Docs;
  /** Whether the file must be written (a local edit or deletion won somewhere). */
  remoteChanged: boolean;
  /** Remote winners to write here (values or deletions); always empty in push mode. */
  applyLocal: Docs;
  /** The new base. */
  base: Base;
  /** Keys whose remote state is newer than this device's and was not applied (push mode). */
  remoteNewer: string[];
}

/** Same stamp and the same content (two edits can carry the same millisecond). */
const sameState = (a: DocState | undefined, b: DocState | undefined): boolean =>
  a !== undefined && b !== undefined && a.t === b.t && !!a.deleted === !!b.deleted && JSON.stringify(a.v) === JSON.stringify(b.v);
const stamp = (d: DocState): { t: number; deleted?: true } => (d.deleted ? { t: d.t, deleted: true } : { t: d.t });

/**
 * Merges this device's documents (`local`: present ones only) with the sync file (`remote`). Per document, an edit on
 * one side wins over an untouched copy on the other, whatever the clocks say; edits on both sides go to the newer one
 * (a tie to the remote copy). A document in `base` but no longer here was deleted here, at `now`.
 * 'full' applies remote winners here; 'push' (while a page may show the local data) only writes local winners to the
 * file and leaves remote winners for the next full sync: their base entry is kept, so they still count as remote edits.
 */
export function mergeDocs(local: Docs, remote: Docs, base: Base, now: number, mode: 'full' | 'push'): MergeResult {
  const out: MergeResult = { remote: {}, remoteChanged: false, applyLocal: {}, base: {}, remoteNewer: [] };
  const keys = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base)]);
  for (const key of [...keys].sort()) {
    const b = base[key];
    let mine: DocState | undefined = local[key];
    if (!mine && b) mine = b.deleted ? { t: b.t, deleted: true } : { t: now, deleted: true };
    const theirs = remote[key];
    const mineChanged = mine !== undefined && !(b && mine.t === b.t && !!mine.deleted === !!b.deleted);
    const theirsChanged = theirs !== undefined && !(b && theirs.t === b.t && !!theirs.deleted === !!b.deleted);

    let winner: DocState | undefined;
    if (!theirs) winner = mine;
    else if (!mine) winner = theirs;
    else if (mineChanged && !theirsChanged) winner = mine;
    else if (theirsChanged && !mineChanged) winner = theirs;
    else winner = mine.t > theirs.t ? mine : theirs;
    if (!winner) continue;

    out.remote[key] = winner;
    if (!sameState(winner, theirs)) out.remoteChanged = true;
    const remoteWinsHere = winner === theirs && !sameState(theirs, mine) && !(theirs.deleted && !local[key]);
    if (remoteWinsHere && mode === 'push') {
      out.remoteNewer.push(key);
      if (b) out.base[key] = b;
      continue;
    }
    if (remoteWinsHere) out.applyLocal[key] = theirs;
    out.base[key] = stamp(winner);
  }
  return out;
}
