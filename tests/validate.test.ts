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
