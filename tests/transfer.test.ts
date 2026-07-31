import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applySequences, transferCycle, transferTable } from '../src/transfer.js';
import type { PGliteLike, QueryOptions, SequenceInfo, TableInfo } from '../src/types.js';

/** Build the structural cluster handle the transfer functions expect. */
function freshDb(): PGlite {
  return new PGlite();
}

/** Wrap a cluster so any COPY statement fails, forcing the INSERT fallback. */
function copyDisabled(db: PGlite): PGliteLike {
  return {
    query: <R = Record<string, unknown>>(q: string, params?: unknown[], options?: QueryOptions) => {
      if (/^\s*COPY/i.test(q)) return Promise.reject(new Error('COPY disabled for test'));
      return db.query<R>(q, params, options);
    },
    exec: (q: string) => db.exec(q),
  };
}

describe('transferTable', () => {
  let source: PGlite;
  let target: PGlite;

  beforeEach(() => {
    source = freshDb();
    target = freshDb();
  });

  afterEach(async () => {
    await source.close();
    await target.close();
  });

  it('copies all rows and reports the count and qualified table key', async () => {
    const ddl = `CREATE TABLE widgets (id integer PRIMARY KEY, name text)`;
    await source.exec(ddl);
    await target.exec(ddl);
    await source.exec(`INSERT INTO widgets VALUES (1, 'a'), (2, 'b'), (3, 'c')`);

    const table: TableInfo = {
      schema: 'public',
      name: 'widgets',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'name', type: 'text' },
      ],
    };

    const result = await transferTable(source, target, table);

    // Default path is COPY.
    expect(result).toMatchObject({ table: 'public.widgets', rowsCopied: 3, method: 'copy' });
    const { rows } = await target.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM widgets',
    );
    expect(rows[0].count).toBe('3');
  });

  it('copies zero rows from an empty table but still fires onProgress once', async () => {
    const ddl = `CREATE TABLE empties (id integer)`;
    await source.exec(ddl);
    await target.exec(ddl);

    const table: TableInfo = {
      schema: 'public',
      name: 'empties',
      columns: [{ name: 'id', type: 'integer' }],
    };

    const events: { table: string; rowsCopied: number }[] = [];
    const result = await transferTable(source, target, table, (e) => events.push(e));

    expect(result.rowsCopied).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ table: 'public.empties', rowsCopied: 0 });
  });

  it('preserves NULLs and legitimate falsy values (0, empty string, false)', async () => {
    const ddl = `CREATE TABLE vals (
      id integer PRIMARY KEY,
      n integer,
      s text,
      b boolean
    )`;
    await source.exec(ddl);
    await target.exec(ddl);
    // Row 1 carries falsy-but-present values; row 2 carries NULLs.
    await source.exec(`INSERT INTO vals VALUES (1, 0, '', false), (2, NULL, NULL, NULL)`);

    const table: TableInfo = {
      schema: 'public',
      name: 'vals',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'n', type: 'integer' },
        { name: 's', type: 'text' },
        { name: 'b', type: 'boolean' },
      ],
    };

    await transferTable(source, target, table);

    const { rows } = await target.query<{
      id: number;
      n: number | null;
      s: string | null;
      b: boolean | null;
    }>('SELECT id, n, s, b FROM vals ORDER BY id');
    // The falsy values must survive (regression guard: `?? null`, not `|| null`).
    expect(rows[0]).toEqual({ id: 1, n: 0, s: '', b: false });
    expect(rows[1]).toEqual({ id: 2, n: null, s: null, b: null });
  });

  it('transfers columns whose names require quoting (reserved word, mixed case)', async () => {
    const ddl = `CREATE TABLE quoted ("order" integer, "MixedCase" text)`;
    await source.exec(ddl);
    await target.exec(ddl);
    await source.exec(`INSERT INTO quoted ("order", "MixedCase") VALUES (7, 'seven')`);

    const table: TableInfo = {
      schema: 'public',
      name: 'quoted',
      columns: [
        { name: 'order', type: 'integer' },
        { name: 'MixedCase', type: 'text' },
      ],
    };

    const result = await transferTable(source, target, table);

    expect(result.rowsCopied).toBe(1);
    const { rows } = await target.query<{ order: number; MixedCase: string }>(
      'SELECT "order", "MixedCase" FROM quoted',
    );
    expect(rows[0]).toEqual({ order: 7, MixedCase: 'seven' });
  });

  it('excludes generated (stored) columns; the target recomputes them', async () => {
    const ddl = `CREATE TABLE gcol (
      id integer PRIMARY KEY,
      base integer,
      doubled integer GENERATED ALWAYS AS (base * 2) STORED
    )`;
    await source.exec(ddl);
    await target.exec(ddl);
    await source.exec(`INSERT INTO gcol (id, base) VALUES (1, 5), (2, 10)`);

    const table: TableInfo = {
      schema: 'public',
      name: 'gcol',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'base', type: 'integer' },
        { name: 'doubled', type: 'integer', generated: true },
      ],
    };

    const result = await transferTable(source, target, table);

    expect(result.rowsCopied).toBe(2);
    const { rows } = await target.query<{ id: number; base: number; doubled: number }>(
      'SELECT id, base, doubled FROM gcol ORDER BY id',
    );
    expect(rows).toEqual([
      { id: 1, base: 5, doubled: 10 },
      { id: 2, base: 10, doubled: 20 },
    ]);
  });

  it('falls back to INSERT (preserving falsy/NULL) when COPY is unavailable', async () => {
    const ddl = `CREATE TABLE vals2 (id integer PRIMARY KEY, n integer, s text, b boolean)`;
    await source.exec(ddl);
    await target.exec(ddl);
    await source.exec(`INSERT INTO vals2 VALUES (1, 0, '', false), (2, NULL, NULL, NULL)`);

    const table: TableInfo = {
      schema: 'public',
      name: 'vals2',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'n', type: 'integer' },
        { name: 's', type: 'text' },
        { name: 'b', type: 'boolean' },
      ],
    };

    const result = await transferTable(copyDisabled(source), target, table);

    expect(result.method).toBe('insert');
    expect(result.fallbackReason).toContain('COPY disabled');
    expect(result.rowsCopied).toBe(2);
    const { rows } = await target.query<{
      id: number;
      n: number | null;
      s: string | null;
      b: boolean | null;
    }>('SELECT id, n, s, b FROM vals2 ORDER BY id');
    expect(rows[0]).toEqual({ id: 1, n: 0, s: '', b: false });
    expect(rows[1]).toEqual({ id: 2, n: null, s: null, b: null });
  });
});

describe('applySequences', () => {
  let target: PGlite;

  beforeEach(() => {
    target = freshDb();
  });

  afterEach(async () => {
    await target.close();
  });

  it('sets each sequence so nextval continues past the captured value', async () => {
    await target.exec(`CREATE SEQUENCE s_one; CREATE SEQUENCE s_two`);

    const sequences: SequenceInfo[] = [
      { schema: 'public', name: 's_one', lastValue: 42 },
      { schema: 'public', name: 's_two', lastValue: 100 },
    ];

    const applied = await applySequences(target, sequences);

    expect(applied).toBe(2);
    const one = await target.query<{ v: string }>(`SELECT nextval('s_one')::text AS v`);
    const two = await target.query<{ v: string }>(`SELECT nextval('s_two')::text AS v`);
    expect(one.rows[0].v).toBe('43');
    expect(two.rows[0].v).toBe('101');
  });

  it('skips sequences with a null lastValue and leaves them fresh', async () => {
    await target.exec(`CREATE SEQUENCE never_advanced`);

    const applied = await applySequences(target, [
      { schema: 'public', name: 'never_advanced', lastValue: null },
    ]);

    expect(applied).toBe(0);
    // An untouched sequence's first nextval is its start value (1).
    const { rows } = await target.query<{ v: string }>(
      `SELECT nextval('never_advanced')::text AS v`,
    );
    expect(rows[0].v).toBe('1');
  });

  it('accepts string and bigint lastValue forms', async () => {
    await target.exec(`CREATE SEQUENCE s_str; CREATE SEQUENCE s_big`);

    const applied = await applySequences(target, [
      { schema: 'public', name: 's_str', lastValue: '500' },
      { schema: 'public', name: 's_big', lastValue: 9000n },
    ]);

    expect(applied).toBe(2);
    const str = await target.query<{ v: string }>(`SELECT nextval('s_str')::text AS v`);
    const big = await target.query<{ v: string }>(`SELECT nextval('s_big')::text AS v`);
    expect(str.rows[0].v).toBe('501');
    expect(big.rows[0].v).toBe('9001');
  });
});

describe('transferCycle (failure-then-rollback)', () => {
  let source: PGlite;
  let target: PGlite;

  // A mutually-referential (cyclic) pair with default NOT DEFERRABLE FKs, so
  // transferCycle must transiently flip them to DEFERRABLE and restore them.
  const CYCLIC_DDL = `
    CREATE TABLE a (id integer PRIMARY KEY, b_id integer);
    CREATE TABLE b (id integer PRIMARY KEY, a_id integer);
    ALTER TABLE a ADD CONSTRAINT a_b_fk FOREIGN KEY (b_id) REFERENCES b(id);
    ALTER TABLE b ADD CONSTRAINT b_a_fk FOREIGN KEY (a_id) REFERENCES a(id);
  `;

  const tableA: TableInfo = {
    schema: 'public',
    name: 'a',
    columns: [
      { name: 'id', type: 'integer' },
      { name: 'b_id', type: 'integer' },
    ],
  };
  const tableB: TableInfo = {
    schema: 'public',
    name: 'b',
    columns: [
      { name: 'id', type: 'integer' },
      { name: 'a_id', type: 'integer' },
    ],
  };

  beforeEach(async () => {
    source = freshDb();
    target = freshDb();
    await source.exec(CYCLIC_DDL);
    await target.exec(CYCLIC_DDL);
    // A genuine data cycle: a.b_id -> b, b.a_id -> a.
    await source.exec(`
      INSERT INTO a (id, b_id) VALUES (1, NULL);
      INSERT INTO b (id, a_id) VALUES (1, 1);
      UPDATE a SET b_id = 1 WHERE id = 1;
    `);
  });

  afterEach(async () => {
    await source.close();
    await target.close();
  });

  /** Read the deferrability flag of both FK constraints from the target. */
  async function fkDeferrable(): Promise<boolean[]> {
    const { rows } = await target.query<{ condeferrable: boolean }>(
      `SELECT condeferrable FROM pg_constraint
        WHERE contype = 'f' AND conrelid IN ('a'::regclass, 'b'::regclass)
        ORDER BY conname`,
    );
    return rows.map((r) => r.condeferrable);
  }

  it('rolls back, rethrows, and restores flipped constraints when the commit fails', async () => {
    const execLog: string[] = [];
    // Wrap the target so COMMIT fails mid-cycle; everything else passes through
    // to the real cluster (so the constraint flip/restore actually happens).
    const failingTarget: PGliteLike = {
      query: <R = Record<string, unknown>>(q: string, params?: unknown[], options?: QueryOptions) =>
        target.query<R>(q, params, options),
      exec: (q: string) => {
        execLog.push(q.trim());
        if (/^\s*COMMIT/i.test(q)) return Promise.reject(new Error('COMMIT failed for test'));
        return target.exec(q);
      },
    };

    await expect(transferCycle(source, failingTarget, [tableA, tableB])).rejects.toThrow(
      'COMMIT failed for test',
    );

    // ROLLBACK was issued after the failed COMMIT.
    expect(execLog).toContain('ROLLBACK');
    // No half-inserted cyclic rows survived the rollback.
    const { rows: aRows } = await target.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM a`,
    );
    expect(aRows[0].count).toBe('0');
    // The constraints flipped to DEFERRABLE were restored to NOT DEFERRABLE.
    expect(await fkDeferrable()).toEqual([false, false]);
  });

  it('a clean re-run after the failure still succeeds (failure-then-retry)', async () => {
    const failingTarget: PGliteLike = {
      query: <R = Record<string, unknown>>(q: string, params?: unknown[], options?: QueryOptions) =>
        target.query<R>(q, params, options),
      exec: (q: string) =>
        /^\s*COMMIT/i.test(q) ? Promise.reject(new Error('boom')) : target.exec(q),
    };
    await expect(transferCycle(source, failingTarget, [tableA, tableB])).rejects.toThrow('boom');

    // Retry against a healthy target handle: the cycle transfers cleanly and the
    // constraints end up NOT DEFERRABLE again.
    const results = await transferCycle(source, target, [tableA, tableB]);

    expect(results.map((r) => r.rowsCopied)).toEqual([1, 1]);
    const { rows } = await target.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM a`,
    );
    expect(rows[0].count).toBe('1');
    expect(await fkDeferrable()).toEqual([false, false]);
  });
});

/**
 * What happens when COPY fails *and* the INSERT fallback cannot rescue it.
 *
 * The FR-7.11 per-table fallback is genuinely per-table and works inside a
 * cyclic transfer too — verified below. The failure mode worth guarding is
 * narrower: a COPY that errors *server-side* inside `transferCycle`'s explicit
 * transaction aborts it, so the fallback then fails with a bare "current
 * transaction is aborted" naming neither the real cause nor the table (PGLM-84).
 */
describe('transferTable (COPY and fallback both failing)', () => {
  let source: PGlite;
  let target: PGlite;

  const DDL = `CREATE TABLE t (id integer PRIMARY KEY, v text)`;
  const table: TableInfo = {
    schema: 'public',
    name: 't',
    columns: [
      { name: 'id', type: 'integer' },
      { name: 'v', type: 'text' },
    ],
  };

  beforeEach(async () => {
    source = freshDb();
    target = freshDb();
    await source.exec(DDL);
    await target.exec(DDL);
    await source.exec(`INSERT INTO t VALUES (1, 'a'), (2, 'b')`);
  });

  afterEach(async () => {
    await source.close();
    await target.close();
  });

  it('names both the COPY failure and the fallback failure', async () => {
    // COPY is rejected, and the INSERT fallback hits a real constraint error.
    await target.exec(`INSERT INTO t VALUES (1, 'pre-existing')`);
    const failing: PGliteLike = {
      query: <R = Record<string, unknown>>(q: string, params?: unknown[], options?: QueryOptions) =>
        /^\s*COPY .* FROM/i.test(q)
          ? Promise.reject(new Error('COPY unsupported here'))
          : target.query<R>(q, params, options),
      exec: (q: string) => target.exec(q),
    };

    const error = await transferTable(source, failing, table).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    // Both causes, and the table, are named — previously only the fallback's
    // error escaped, which is the less informative of the two.
    expect(message).toContain('public.t');
    expect(message).toContain('COPY unsupported here');
    expect(message).toMatch(/duplicate key|already exists|unique/i);
    // The fallback's own error is retained as the cause for programmatic use.
    expect((error as Error).cause).toBeInstanceOf(Error);
  });

  it('still falls back per-table inside a cyclic transfer when COPY is unavailable', async () => {
    // The FR-7.11 guarantee holds inside transferCycle: a client-side "COPY not
    // supported" does not touch the transaction, so the INSERT fallback runs and
    // the cycle commits.
    const cyclicDdl = `
      CREATE TABLE ca (id integer PRIMARY KEY, b_id integer);
      CREATE TABLE cb (id integer PRIMARY KEY, a_id integer);
      ALTER TABLE ca ADD CONSTRAINT ca_fk FOREIGN KEY (b_id) REFERENCES cb(id);
      ALTER TABLE cb ADD CONSTRAINT cb_fk FOREIGN KEY (a_id) REFERENCES ca(id);
    `;
    await source.exec(cyclicDdl);
    await target.exec(cyclicDdl);
    await source.exec(
      `INSERT INTO ca VALUES (1, NULL); INSERT INTO cb VALUES (1, 1); UPDATE ca SET b_id = 1;`,
    );
    const cols = (name: string, ref: string): TableInfo => ({
      schema: 'public',
      name,
      columns: [
        { name: 'id', type: 'integer' },
        { name: ref, type: 'integer' },
      ],
    });
    const noCopy: PGliteLike = {
      query: <R = Record<string, unknown>>(q: string, params?: unknown[], options?: QueryOptions) =>
        /^\s*COPY .* FROM/i.test(q)
          ? Promise.reject(new Error('COPY unsupported here'))
          : target.query<R>(q, params, options),
      exec: (q: string) => target.exec(q),
    };

    const results = await transferCycle(source, noCopy, [cols('ca', 'b_id'), cols('cb', 'a_id')]);

    expect(results.map((r) => r.method)).toEqual(['insert', 'insert']);
    const { rows } = await target.query<{ n: string }>(`SELECT count(*)::text AS n FROM ca`);
    expect(rows[0].n).toBe('1');
  });
});
