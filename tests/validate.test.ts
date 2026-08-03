import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { introspectSchema } from '../src/introspect.js';
import type { ValidationReport } from '../src/types.js';
import { validateMigration, ValidationError } from '../src/validate.js';
import { SCHEMA_SQL, SEED_SQL } from './helpers.js';

describe('validateMigration', () => {
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

  it('passes when row counts and sequences match', async () => {
    await source.exec(SCHEMA_SQL);
    await source.exec(SEED_SQL);
    await target.exec(SCHEMA_SQL);
    await target.exec(SEED_SQL);

    const schema = await introspectSchema(source);
    const report = await validateMigration(source, target, schema, 'counts');

    expect(report.ok).toBe(true);
    expect(report.tables.every((t) => t.ok)).toBe(true);
    expect(report.sequences.every((s) => s.ok)).toBe(true);
  });

  it('fails and flags the table when target row counts differ', async () => {
    await source.exec(SCHEMA_SQL);
    await source.exec(SEED_SQL);
    await target.exec(SCHEMA_SQL); // empty target

    const schema = await introspectSchema(source);
    const report = await validateMigration(source, target, schema, 'counts');

    expect(report.ok).toBe(false);
    const books = report.tables.find((t) => t.table === 'public.books');
    expect(books).toMatchObject({ sourceRows: 2, targetRows: 0, ok: false });
  });

  it('full level detects content drift even when counts match', async () => {
    const ddl = `CREATE TABLE t (id integer PRIMARY KEY, v text)`;
    await source.exec(ddl);
    await source.exec(`INSERT INTO t VALUES (1, 'a')`);
    await target.exec(ddl);
    await target.exec(`INSERT INTO t VALUES (1, 'b')`); // same count, different content

    const schema = await introspectSchema(source);

    const counts = await validateMigration(source, target, schema, 'counts');
    expect(counts.ok).toBe(true); // counts alone cannot see the drift

    const full = await validateMigration(source, target, schema, 'full');
    expect(full.ok).toBe(false);
    expect(full.tables[0].digestMatch).toBe(false);
  });

  // PGLM-99: the digest must hash content, not physical layout. In the
  // app-driven path the source grew by ALTER TABLE ADD COLUMN (which appends)
  // while the target was built from the app's current CREATE TABLE, so the two
  // column orders routinely differ on a table whose data is perfect.
  describe('full level, column layout (PGLM-99)', () => {
    it('passes when the target declares the same columns in a different order', async () => {
      await source.exec(`CREATE TABLE t (
        id integer PRIMARY KEY, note text, created_at timestamptz, progress integer)`);
      await target.exec(`CREATE TABLE t (
        id integer PRIMARY KEY, note text, progress integer, created_at timestamptz)`);
      const values = `(1, 'a', '2024-01-01T00:00:00Z', 7), (2, 'b', '2024-02-02T00:00:00Z', 9)`;
      await source.exec(`INSERT INTO t (id, note, created_at, progress) VALUES ${values}`);
      await target.exec(`INSERT INTO t (id, note, created_at, progress) VALUES ${values}`);

      const schema = await introspectSchema(source);
      const report = await validateMigration(source, target, schema, 'full');

      expect(report.ok).toBe(true);
      expect(report.tables[0]).toMatchObject({ digestMatch: true, ok: true });
      // Name-sorted, so both sides project identically regardless of layout.
      expect(report.tables[0].comparedColumns).toEqual(['created_at', 'id', 'note', 'progress']);
      expect(report.tables[0].missingColumns).toBeUndefined();
      expect(report.tables[0].extraColumns).toBeUndefined();
    });

    it('reports target-only columns without failing', async () => {
      await source.exec(`CREATE TABLE t (id integer PRIMARY KEY, v text)`);
      await target.exec(`CREATE TABLE t (id integer PRIMARY KEY, v text, added_later text)`);
      await source.exec(`INSERT INTO t (id, v) VALUES (1, 'a')`);
      await target.exec(`INSERT INTO t (id, v) VALUES (1, 'a')`); // added_later stays NULL

      const schema = await introspectSchema(source);
      const report = await validateMigration(source, target, schema, 'full');

      expect(report.ok).toBe(true);
      expect(report.tables[0].extraColumns).toEqual(['added_later']);
      expect(report.tables[0].comparedColumns).toEqual(['id', 'v']);
      expect(report.tables[0].digestMatch).toBe(true);
    });

    it('fails and names a source column the target lacks', async () => {
      await source.exec(`CREATE TABLE t (id integer PRIMARY KEY, v text, dropped_on_target text)`);
      await target.exec(`CREATE TABLE t (id integer PRIMARY KEY, v text)`);
      await source.exec(`INSERT INTO t VALUES (1, 'a', 'data that has nowhere to go')`);
      await target.exec(`INSERT INTO t VALUES (1, 'a')`);

      const schema = await introspectSchema(source);
      const report = await validateMigration(source, target, schema, 'full');

      expect(report.ok).toBe(false);
      expect(report.tables[0].missingColumns).toEqual(['dropped_on_target']);
      // No digest is taken — the comparison would be vacuously green on the
      // columns that did survive, which is exactly the wrong signal.
      expect(report.tables[0].digestMatch).toBeUndefined();
      expect(report.tables[0].ok).toBe(false);
    });

    it('still fails on real content drift when the layout differs', async () => {
      // The over-correction this guards against: a digest so permissive that
      // reordering-tolerance turns into blindness.
      await source.exec(`CREATE TABLE t (id integer PRIMARY KEY, note text, n integer)`);
      await target.exec(`CREATE TABLE t (id integer PRIMARY KEY, n integer, note text)`);
      await source.exec(`INSERT INTO t (id, note, n) VALUES (1, 'a', 1)`);
      await target.exec(`INSERT INTO t (id, note, n) VALUES (1, 'b', 1)`);

      const schema = await introspectSchema(source);
      const report = await validateMigration(source, target, schema, 'full');

      expect(report.ok).toBe(false);
      expect(report.tables[0].digestMatch).toBe(false);
    });

    it('does not confuse two columns whose values were swapped', async () => {
      // Same multiset of values, different columns: a digest that hashed the
      // sorted values rather than the row projection would pass this.
      await source.exec(`CREATE TABLE t (id integer PRIMARY KEY, a text, b text)`);
      await target.exec(`CREATE TABLE t (id integer PRIMARY KEY, b text, a text)`);
      await source.exec(`INSERT INTO t (id, a, b) VALUES (1, 'x', 'y')`);
      await target.exec(`INSERT INTO t (id, a, b) VALUES (1, 'y', 'x')`);

      const schema = await introspectSchema(source);
      const report = await validateMigration(source, target, schema, 'full');

      expect(report.ok).toBe(false);
      expect(report.tables[0].digestMatch).toBe(false);
    });

    it('falls back to the count check for a table with no columns', async () => {
      await source.exec(`CREATE TABLE t ()`);
      await target.exec(`CREATE TABLE t ()`);
      await source.exec(`INSERT INTO t DEFAULT VALUES`);
      await target.exec(`INSERT INTO t DEFAULT VALUES`);

      const schema = await introspectSchema(source);
      const report = await validateMigration(source, target, schema, 'full');

      expect(report.ok).toBe(true);
      expect(report.tables[0].comparedColumns).toEqual([]);
      expect(report.tables[0].digestMatch).toBeUndefined();
    });

    it('leaves the counts level free of column reporting', async () => {
      await source.exec(`CREATE TABLE t (id integer PRIMARY KEY, v text, gone text)`);
      await target.exec(`CREATE TABLE t (id integer PRIMARY KEY, v text)`);
      await source.exec(`INSERT INTO t VALUES (1, 'a', 'z')`);
      await target.exec(`INSERT INTO t VALUES (1, 'a')`);

      const schema = await introspectSchema(source);
      const report = await validateMigration(source, target, schema, 'counts');

      // `counts` is the cheap default: row parity only, no target introspection.
      expect(report.ok).toBe(true);
      expect(report.tables[0].comparedColumns).toBeUndefined();
      expect(report.tables[0].missingColumns).toBeUndefined();
    });
  });

  it('flags a sequence that is behind on the target', async () => {
    await source.exec(`CREATE TABLE t (id serial PRIMARY KEY)`);
    await source.exec(`INSERT INTO t DEFAULT VALUES; INSERT INTO t DEFAULT VALUES;`); // seq -> 2
    await target.exec(`CREATE TABLE t (id serial PRIMARY KEY)`);
    await target.exec(`INSERT INTO t (id) VALUES (1), (2)`); // rows copied, but seq not advanced

    const schema = await introspectSchema(source);
    const report = await validateMigration(source, target, schema, 'counts');

    // Row counts match, but the target sequence is behind the source.
    expect(report.tables.every((t) => t.ok)).toBe(true);
    const seq = report.sequences.find((s) => s.sequence.includes('t_id_seq'));
    expect(seq?.ok).toBe(false);
    expect(report.ok).toBe(false);
  });
});

describe('ValidationError', () => {
  it('falls back to a level-derived message when none is supplied', () => {
    const report: ValidationReport = { level: 'counts', ok: false, tables: [], sequences: [] };

    // migrate always passes an explicit message; the default exists for callers
    // constructing the error themselves from a report they already hold.
    expect(new ValidationError(report).message).toBe('Post-migration validation failed (counts).');
    expect(new ValidationError(report, 'custom').message).toBe('custom');
    expect(new ValidationError(report).report).toBe(report);
    expect(new ValidationError(report).name).toBe('ValidationError');
  });
});
