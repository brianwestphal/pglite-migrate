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
      onExisting: 'error',
      truncatedTables: [],
      // Validation is skipped entirely when the source has no tables, so the
      // field is present-but-undefined rather than a report of nothing.
      validation: undefined,
      reconstruction: undefined,
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

  it('echoes the active strategy and the tables truncate emptied (FR-14.5/FR-14.10)', async () => {
    const report = await migrate({ source, target, onExisting: 'truncate' });

    expect(report.onExisting).toBe('truncate');
    // The only record that a destructive re-run discarded data.
    expect([...report.truncatedTables].sort()).toEqual(['public.authors', 'public.books']);
  });

  it('reports the default strategy when the caller passes none', async () => {
    // The target is populated by beforeEach, so `error` refuses — assert the
    // default on a clean pair instead.
    const s2 = new PGlite();
    const t2 = new PGlite();
    try {
      await s2.exec(SCHEMA_SQL);
      await t2.exec(SCHEMA_SQL);
      const report = await migrate({ source: s2, target: t2 });
      expect(report.onExisting).toBe('error');
      expect(report.truncatedTables).toEqual([]);
    } finally {
      await s2.close();
      await t2.close();
    }
  });
});

/**
 * `skip` exists for the interrupted-run case, which by definition leaves the
 * target *partially* populated. The suite above always starts from a fully
 * populated target, so the mixed skip-some/fill-others path never ran (PGLM-89).
 */
describe('migrate (re-run safety / partially-populated target)', () => {
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

  /** Copy just the parent table across, simulating a run that stopped halfway. */
  async function populateAuthorsOnly(): Promise<void> {
    await target.exec(`INSERT INTO authors (id, name) VALUES (1, 'Ursula'), (2, 'Octavia')`);
  }

  it('fills the empty tables and leaves the populated one alone', async () => {
    await populateAuthorsOnly();

    const report = await migrate({ source, target, onExisting: 'skip' });

    expect(report.skippedTables).toEqual(['public.authors']);
    // The mixed path: books is transferred while authors is skipped. The
    // all-or-nothing fixture could never distinguish this from totalRows === 0.
    expect(report.totalRows).toBeGreaterThan(0);
    expect(report.tables.map((t) => t.table)).toEqual(['public.books']);

    const counts = await target.query<{ a: string; b: string }>(
      `SELECT (SELECT count(*)::text FROM authors) AS a, (SELECT count(*)::text FROM books) AS b`,
    );
    expect(counts.rows[0]).toEqual({ a: '2', b: '2' }); // authors unchanged, books filled
  });

  it('keeps the foreign key satisfied when a skipped parent feeds a filled child', async () => {
    await populateAuthorsOnly();

    await migrate({ source, target, onExisting: 'skip' });

    // Every transferred book must resolve to an author row that was already
    // there — the case where skipping a parent could silently orphan children.
    const orphans = await target.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM books b
        WHERE NOT EXISTS (SELECT 1 FROM authors a WHERE a.id = b.author_id)`,
    );
    expect(orphans.rows[0].n).toBe('0');
  });

  it('does not duplicate rows in the table it skipped', async () => {
    await populateAuthorsOnly();

    await migrate({ source, target, onExisting: 'skip' });

    const dupes = await target.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM (SELECT id FROM authors GROUP BY id HAVING count(*) > 1) d`,
    );
    expect(dupes.rows[0].n).toBe('0');
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
