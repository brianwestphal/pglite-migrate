import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from '../src/migrate.js';
import type { ProgressEvent } from '../src/types.js';
import { ValidationError } from '../src/validate.js';
import { SCHEMA_SQL, SEED_SQL } from './helpers.js';

describe('migrate (orchestrator)', () => {
  let source: PGlite;
  let target: PGlite;

  beforeEach(() => {
    source = new PGlite();
    target = new PGlite();
  });

  afterEach(async () => {
    await source.close();
    await target.close();
  });

  it('reports totals, sequence count, and per-table progress in topological order', async () => {
    await source.exec(SCHEMA_SQL);
    await source.exec(SEED_SQL);
    await target.exec(SCHEMA_SQL);

    const events: ProgressEvent[] = [];
    const report = await migrate({ source, target, onProgress: (e) => events.push(e) });

    expect(report.warnings).toEqual([]);
    // totalRows is the sum of the per-table results.
    expect(report.totalRows).toBe(report.tables.reduce((n, t) => n + t.rowsCopied, 0));
    expect(report.totalRows).toBe(4);
    // Both serial sequences were advanced in the source, so both are realigned.
    expect(report.sequencesSet).toBe(2);
    // onProgress fires once per table, parents before children.
    expect(events.map((e) => e.table)).toEqual(['public.authors', 'public.books']);
    // Validation runs by default (counts) and passes.
    expect(report.validation?.level).toBe('counts');
    expect(report.validation?.ok).toBe(true);
  });

  it('handles a foreign-key cycle with deferred constraints (no warning)', async () => {
    const cyclic = `
      CREATE TABLE a (id integer PRIMARY KEY, b_id integer);
      CREATE TABLE b (id integer PRIMARY KEY, a_id integer);
      ALTER TABLE a ADD CONSTRAINT a_b_fk FOREIGN KEY (b_id) REFERENCES b(id);
      ALTER TABLE b ADD CONSTRAINT b_a_fk FOREIGN KEY (a_id) REFERENCES a(id);
    `;
    await source.exec(cyclic);
    await target.exec(cyclic);

    const report = await migrate({ source, target });

    // The cycle is transferred with deferred constraints, not warned about.
    expect(report.warnings).toEqual([]);
    expect([...report.deferredTables].sort()).toEqual(['public.a', 'public.b']);
  });

  it('orders public-schema FKs even when alphabetical order would violate them', async () => {
    // Adversarial: parent "zoo", child "aaa" -> alphabetical (aaa, zoo) inserts
    // the child first and would violate the FK unless topo ordering kicks in.
    const ddl = `
      CREATE TABLE zoo (id integer PRIMARY KEY);
      CREATE TABLE aaa (id integer PRIMARY KEY, zoo_id integer REFERENCES zoo(id));
    `;
    await source.exec(ddl);
    await source.exec(`INSERT INTO zoo VALUES (1),(2); INSERT INTO aaa VALUES (10,1),(11,2);`);
    await target.exec(ddl);

    const report = await migrate({ source, target });

    expect(report.warnings).toEqual([]);
    expect(report.totalRows).toBe(4);
    const { rows } = await target.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM aaa',
    );
    expect(rows[0].count).toBe('2');
  });

  it('reports a validation failure by default without throwing (onValidationFailure: report)', async () => {
    // A single table whose target keeps a *different* row count than the source:
    // skip leaves the target's one row, so the count check fails.
    await source.exec(`CREATE TABLE t (id integer PRIMARY KEY); INSERT INTO t VALUES (1), (2), (3);`);
    await target.exec(`CREATE TABLE t (id integer PRIMARY KEY); INSERT INTO t VALUES (1);`);

    const report = await migrate({ source, target, onExisting: 'skip' });

    expect(report.validation?.ok).toBe(false);
    expect(report.warnings.some((w) => /validation failed/i.test(w))).toBe(true);
  });

  it('onValidationFailure: throw raises a ValidationError carrying the report', async () => {
    await source.exec(`CREATE TABLE t (id integer PRIMARY KEY); INSERT INTO t VALUES (1), (2), (3);`);
    await target.exec(`CREATE TABLE t (id integer PRIMARY KEY); INSERT INTO t VALUES (1);`);

    const err = await migrate({
      source,
      target,
      onExisting: 'skip',
      onValidationFailure: 'throw',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ValidationError);
    const ve = err as ValidationError;
    expect(ve.report.ok).toBe(false);
    expect(ve.report.tables.some((t) => t.table === 'public.t' && !t.ok)).toBe(true);
    expect(ve.message).toMatch(/validation failed/i);
  });

  it('onValidationFailure: throw does not throw when validation passes', async () => {
    await source.exec(SCHEMA_SQL);
    await source.exec(SEED_SQL);
    await target.exec(SCHEMA_SQL);

    const report = await migrate({ source, target, onValidationFailure: 'throw' });
    expect(report.validation?.ok).toBe(true);
  });

  it('returns an empty report for an empty source schema', async () => {
    const report = await migrate({ source, target });

    expect(report).toEqual({
      tables: [],
      sequencesSet: 0,
      totalRows: 0,
      warnings: [],
      deferredTables: [],
      skippedTables: [],
    });
  });
});

describe('migrate (re-run safety / onExisting)', () => {
  let source: PGlite;
  let target: PGlite;

  beforeEach(async () => {
    source = new PGlite();
    target = new PGlite();
    await source.exec(SCHEMA_SQL);
    await source.exec(SEED_SQL);
    await target.exec(SCHEMA_SQL);
    await migrate({ source, target }); // first run populates the target
  });

  afterEach(async () => {
    await source.close();
    await target.close();
  });

  it('refuses by default when the target is already populated', async () => {
    await expect(migrate({ source, target })).rejects.toThrow(/already contains rows/);
  });

  it('truncate empties the target first so a re-run does not duplicate', async () => {
    const report = await migrate({ source, target, onExisting: 'truncate' });

    expect(report.warnings).toEqual([]);
    expect(report.validation?.ok).toBe(true);
    const authors = await target.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM authors',
    );
    expect(authors.rows[0].count).toBe('2'); // not 4
  });

  it('skip leaves already-populated tables untouched and records them', async () => {
    const report = await migrate({ source, target, onExisting: 'skip' });

    expect([...report.skippedTables].sort()).toEqual(['public.authors', 'public.books']);
    expect(report.totalRows).toBe(0);
    const authors = await target.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM authors',
    );
    expect(authors.rows[0].count).toBe('2'); // unchanged
  });
});

describe('migrate (dry run)', () => {
  let source: PGlite;
  let target: PGlite;

  beforeEach(async () => {
    source = new PGlite();
    target = new PGlite();
    await source.exec(SCHEMA_SQL);
    await source.exec(SEED_SQL);
    await target.exec(SCHEMA_SQL);
  });

  afterEach(async () => {
    await source.close();
    await target.close();
  });

  it('reports the plan without writing to the target', async () => {
    const report = await migrate({ source, target, dryRun: true });

    expect(report.totalRows).toBe(4);
    expect(report.tables.map((t) => t.table).sort()).toEqual(['public.authors', 'public.books']);
    expect(report.sequencesSet).toBe(2);
    expect(report.validation).toBeUndefined();

    // The target is untouched.
    const a = await target.query<{ count: string }>('SELECT count(*)::text AS count FROM authors');
    expect(a.rows[0].count).toBe('0');
  });

  it('plan matches the subsequent real run', async () => {
    const shape = (r: { tables: { table: string; rowsCopied: number }[]; totalRows: number }) => ({
      totalRows: r.totalRows,
      tables: r.tables
        .map((t) => ({ table: t.table, rowsCopied: t.rowsCopied }))
        .sort((x, y) => x.table.localeCompare(y.table)),
    });

    const plan = await migrate({ source, target, dryRun: true });
    const real = await migrate({ source, target });

    expect(shape(plan)).toEqual(shape(real));
  });
});
