import { describe, expect, it } from 'vitest';
import { mergeDocs, type Base, type Docs } from '../../src/sync/merge.js';

const NOW = 10_000;

describe('mergeDocs', () => {
  it('first sync: local and remote documents are combined; nothing is deleted', () => {
    const local: Docs = { a: { t: 1, v: 'la' }, b: { t: 5, v: 'lb' } };
    const remote: Docs = { b: { t: 3, v: 'rb' }, c: { t: 2, v: 'rc' } };
    const r = mergeDocs(local, remote, {}, NOW, 'full');
    expect(r.remote).toEqual({ a: { t: 1, v: 'la' }, b: { t: 5, v: 'lb' }, c: { t: 2, v: 'rc' } });
    expect(r.applyLocal).toEqual({ c: { t: 2, v: 'rc' } });
    expect(r.remoteChanged).toBe(true);
    expect(r.base).toEqual({ a: { t: 1 }, b: { t: 5 }, c: { t: 2 } });
  });

  it('an edit on one side only wins, whatever the clocks say', () => {
    const base: Base = { a: { t: 100 }, b: { t: 100 } };
    // a: edited remotely (with a clock behind ours); b: edited here.
    const local: Docs = { a: { t: 100, v: 'old' }, b: { t: 50, v: 'mine' } };
    const remote: Docs = { a: { t: 90, v: 'theirs' }, b: { t: 100, v: 'old' } };
    const r = mergeDocs(local, remote, base, NOW, 'full');
    expect(r.remote.a).toEqual({ t: 90, v: 'theirs' });
    expect(r.remote.b).toEqual({ t: 50, v: 'mine' });
    expect(r.applyLocal).toEqual({ a: { t: 90, v: 'theirs' } });
  });

  it('edited on both sides: the newer edit wins; a tie goes to the remote copy', () => {
    const base: Base = { a: { t: 1 }, b: { t: 1 } };
    const local: Docs = { a: { t: 20, v: 'mine' }, b: { t: 30, v: 'mine' } };
    const remote: Docs = { a: { t: 25, v: 'theirs' }, b: { t: 30, v: 'theirs' } };
    const r = mergeDocs(local, remote, base, NOW, 'full');
    expect(r.remote.a!.v).toBe('theirs');
    expect(r.remote.b!.v).toBe('theirs');
    expect(Object.keys(r.applyLocal).sort()).toEqual(['a', 'b']);
  });

  it('a document gone here since the last sync is a deletion (a tombstone in the file)', () => {
    const base: Base = { a: { t: 5 } };
    const r = mergeDocs({}, { a: { t: 5, v: 'x' } }, base, NOW, 'full');
    expect(r.remote).toEqual({ a: { t: NOW, deleted: true } });
    expect(r.remoteChanged).toBe(true);
    expect(r.applyLocal).toEqual({});
    expect(r.base).toEqual({ a: { t: NOW, deleted: true } });
  });

  it('a remote deletion removes the unchanged local copy, but not one edited after it', () => {
    const base: Base = { a: { t: 5 }, b: { t: 5 } };
    const local: Docs = { a: { t: 5, v: 'x' }, b: { t: 50, v: 'edited later' } };
    const remote: Docs = { a: { t: 20, deleted: true }, b: { t: 20, deleted: true } };
    const r = mergeDocs(local, remote, base, NOW, 'full');
    expect(r.applyLocal).toEqual({ a: { t: 20, deleted: true } });
    expect(r.remote.b).toEqual({ t: 50, v: 'edited later' });
  });

  it('nothing new on either side: nothing to write', () => {
    const base: Base = { a: { t: 5 }, d: { t: 7, deleted: true } };
    const r = mergeDocs({ a: { t: 5, v: 'x' } }, { a: { t: 5, v: 'x' }, d: { t: 7, deleted: true } }, base, NOW, 'full');
    expect(r.remoteChanged).toBe(false);
    expect(r.applyLocal).toEqual({});
    expect(r.base).toEqual(base);
  });

  it('push mode leaves remote winners for the next full sync (base unchanged for them)', () => {
    const base: Base = { a: { t: 1 }, b: { t: 1 } };
    const local: Docs = { a: { t: 1, v: 'old' }, b: { t: 40, v: 'mine' } };
    const remote: Docs = { a: { t: 30, v: 'theirs' }, b: { t: 1, v: 'old' }, c: { t: 3, v: 'new' } };
    const r = mergeDocs(local, remote, base, NOW, 'push');
    expect(r.applyLocal).toEqual({});
    expect(r.remote).toEqual({ a: { t: 30, v: 'theirs' }, b: { t: 40, v: 'mine' }, c: { t: 3, v: 'new' } });
    expect(r.base).toEqual({ a: { t: 1 }, b: { t: 40 } });
    expect(r.remoteNewer).toEqual(['a', 'c']);
  });
});
