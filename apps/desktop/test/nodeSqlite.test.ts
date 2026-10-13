import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { migrate } from '../../server/src/db/migrations.js';
import { createRepos } from '../../server/src/db/repos.js';
import { adaptNodeSqlite, createNodeSqliteDb } from '../src/lib/nodeSqlite.js';

describe('adaptNodeSqlite', () => {
  it('flags readers (incl. RETURNING) and binds positional parameter arrays', () => {
    const db = adaptNodeSqlite(new DatabaseSync(':memory:'));
    db.prepare('create table t (id integer primary key, ts bigint, v real, s text)').run([]);
    const ins = db.prepare('insert into t (ts, v, s) values (?, ?, ?)');
    expect(ins.reader).toBe(false);
    expect(ins.run([Date.UTC(2030, 0, 1), 1.5, null])).toEqual({ changes: 1, lastInsertRowid: 1 });
    const ret = db.prepare('insert into t (ts, v, s) values (?, ?, ?) returning id');
    expect(ret.reader).toBe(true);
    expect(ret.all([1, 2, 'x'])).toEqual([{ id: 2 }]);
    const sel = db.prepare('select ts, v, s from t where id = ?');
    expect(sel.reader).toBe(true);
    expect(sel.all([1])).toEqual([{ ts: Date.UTC(2030, 0, 1), v: 1.5, s: null }]);
    expect([...sel.iterate([2])]).toEqual([{ ts: 1, v: 2, s: 'x' }]);
    db.close();
  });

  it('caches prepared statements per SQL text (bounded)', () => {
    const raw = new DatabaseSync(':memory:');
    const db = adaptNodeSqlite(raw, 2);
    const a = db.prepare('select 1');
    expect(db.prepare('select 1')).toBe(a);
    db.prepare('select 2');
    db.prepare('select 3'); // evicts 'select 1' (least recently used)
    expect(db.prepare('select 1')).not.toBe(a);
    db.close();
  });
});

describe('createNodeSqliteDb', () => {
  it('opens a file DB in WAL mode with foreign keys on, migrates, and supports repos + transactions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chartmate-nsq-'));
    const h = createNodeSqliteDb(join(dir, 'chartmate.db'));
    await migrate(h.db);
    const mode = await sql<{ journal_mode: string }>`pragma journal_mode`.execute(h.db);
    expect(mode.rows[0]!.journal_mode).toBe('wal');
    const fk = await sql<{ foreign_keys: number }>`pragma foreign_keys`.execute(h.db);
    expect(fk.rows[0]!.foreign_keys).toBe(1);

    const repos = createRepos(h.db, 'sqlite');
    await repos.bars.upsert('stock:A', '1D', [{ ts: Date.UTC(2030, 0, 1), open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }]);
    expect(await repos.bars.range('stock:A', '1D', 0, Date.UTC(2031, 0, 1))).toHaveLength(1);

    await expect(h.db.transaction().execute(async (trx) => {
      await trx.insertInto('layouts').values({ key: 'k', json: '{}', updated_at: 1 }).execute();
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await h.db.selectFrom('layouts').selectAll().execute()).toEqual([]);
    await h.close();
  });

  it('rejects an empty path', () => {
    expect(() => createNodeSqliteDb(' ')).toThrow(/empty/);
  });
});
