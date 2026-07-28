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

/**
 * Standalone / reconstruct mode, at the `migrate` level (PGLM-57).
 *
 * The two-engine version of this lives in `tests/e2e/standalone.test.ts`; this
 * is the unit half of the project's double-coverage rule, and specifically pins
 * the warnings loop that turns each detected out-of-scope object into a
 * `MigrationReport.warnings` entry.
 */
describe('migrate (standalone / reconstructSchema)', () => {
  /** App-class objects plus two out-of-scope ones (a view and a matview). */
  const SOURCE_SCHEMA = `
    CREATE TYPE status AS ENUM ('active', 'inactive');
    CREATE TABLE authors (
      id serial PRIMARY KEY,
      name text NOT NULL,
      state status DEFAULT 'active'
    );
    CREATE TABLE books (
      id serial PRIMARY KEY,
      author_id integer NOT NULL REFERENCES authors(id),
      title text NOT NULL
    );
    CREATE INDEX books_author_idx ON books (author_id);
    CREATE VIEW author_names AS SELECT name FROM authors;
    CREATE MATERIALIZED VIEW book_titles AS SELECT title FROM books;
  `;
  const SEED = `
    INSERT INTO authors (name) VALUES ('Ursula'), ('Octavia');
    INSERT INTO books (author_id, title) VALUES (1, 'A Wizard of Earthsea'), (2, 'Kindred');
  `;

  let source: PGlite;
  let target: PGlite;

  beforeEach(async () => {
    source = new PGlite();
    await source.exec(SOURCE_SCHEMA);
    await source.exec(SEED);
    target = new PGlite(); // deliberately empty — no schema created up front
  });

  afterEach(async () => {
    await source.close();
    await target.close();
  });

  it('rebuilds the schema on an empty target and transfers the rows', async () => {
    const report = await migrate({ source, target, reconstructSchema: true });

    expect([...(report.reconstruction?.tables ?? [])].sort()).toEqual([
      'public.authors',
      'public.books',
    ]);
    expect(report.reconstruction?.enums).toContain('public.status');
    expect(report.totalRows).toBe(4);
    expect(report.validation?.ok).toBe(true);

    // The target really holds the data, on a schema it did not have before.
    const { rows } = await target.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM books',
    );
    expect(rows[0].count).toBe('2');
  });

  it('emits one warning per out-of-scope object it did not reconstruct', async () => {
    const report = await migrate({ source, target, reconstructSchema: true });

    // Both are reported on the reconstruction report…
    expect(report.reconstruction?.unsupported).toContainEqual({
      kind: 'view',
      name: 'public.author_names',
    });
    expect(report.reconstruction?.unsupported).toContainEqual({
      kind: 'materialized view',
      name: 'public.book_titles',
    });

    // …and each becomes a warning. Two objects, so the loop must run twice —
    // a single push would satisfy a one-object fixture and hide a bug.
    expect(report.warnings).toContain('Unsupported view not reconstructed: public.author_names.');
    expect(report.warnings).toContain(
      'Unsupported materialized view not reconstructed: public.book_titles.',
    );
    const unsupportedWarnings = report.warnings.filter((w) => w.startsWith('Unsupported '));
    expect(unsupportedWarnings).toHaveLength(report.reconstruction?.unsupported.length ?? 0);

    // Nothing was silently dropped: the objects are still absent on the target.
    const { rows } = await target.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_class WHERE relname = 'author_names'`,
    );
    expect(rows[0].count).toBe('0');
  });

  it('produces no unsupported warnings when the source is entirely app-class', async () => {
    const clean = new PGlite();
    const cleanTarget = new PGlite();
    try {
      await clean.exec('CREATE TABLE t (id serial PRIMARY KEY, s text)');
      await clean.exec("INSERT INTO t (s) VALUES ('a')");

      const report = await migrate({ source: clean, target: cleanTarget, reconstructSchema: true });
      expect(report.reconstruction?.unsupported).toEqual([]);
      expect(report.warnings).toEqual([]);
      expect(report.totalRows).toBe(1);
    } finally {
      await clean.close();
      await cleanTarget.close();
    }
  });

  it("throws before transferring anything when onUnsupported is 'error'", async () => {
    await expect(
      migrate({ source, target, reconstructSchema: true, onUnsupported: 'error' }),
    ).rejects.toThrow();

    // It must refuse *before* touching the target — no tables, no rows.
    const { rows } = await target.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname = 'public'`,
    );
    expect(rows[0].count).toBe('0');
  });

  it('leaves the target untouched when reconstructSchema is not set', async () => {
    // Without the flag the target schema is the caller's responsibility, so a
    // bare target fails rather than being silently rebuilt.
    await expect(migrate({ source, target })).rejects.toThrow();
    const { rows } = await target.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname = 'public'`,
    );
    expect(rows[0].count).toBe('0');
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
