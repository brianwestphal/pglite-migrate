import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reconstructSchema } from '../src/reconstruct.js';

const SCHEMA = `
CREATE TYPE status AS ENUM ('active', 'inactive');
CREATE TABLE authors (
  id serial PRIMARY KEY,
  name text NOT NULL,
  state status DEFAULT 'active'
);
CREATE TABLE books (
  id serial PRIMARY KEY,
  author_id integer NOT NULL REFERENCES authors(id),
  title text,
  CONSTRAINT title_not_blank CHECK (char_length(title) > 0)
);
CREATE INDEX books_author_idx ON books (author_id);
CREATE VIEW author_names AS SELECT name FROM authors;
`;

describe('reconstructSchema', () => {
  let source: PGlite;
  let target: PGlite;

  beforeEach(async () => {
    source = new PGlite();
    target = new PGlite();
    await source.exec(SCHEMA);
  });

  afterEach(async () => {
    await source.close();
    await target.close();
  });

  it('recreates app-class objects in dependency order', async () => {
    const report = await reconstructSchema(source, target);

    expect(report.enums).toContain('public.status');
    expect([...report.tables].sort()).toEqual(['public.authors', 'public.books']);
    expect(report.indexes).toContain('books_author_idx');
    // PK + FK + CHECK constraints recreated.
    expect(report.constraints.some((c) => c.includes('title_not_blank'))).toBe(true);

    // Columns are present in physical order on the target.
    const cols = await target.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'authors' ORDER BY ordinal_position`,
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual(['id', 'name', 'state']);
  });

  it('reports out-of-scope objects instead of recreating them', async () => {
    const report = await reconstructSchema(source, target);

    expect(report.unsupported).toContainEqual({ kind: 'view', name: 'public.author_names' });
    // The view is not created on the target.
    const { rows } = await target.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class WHERE relname = 'author_names'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('onUnsupported: error throws before touching the target', async () => {
    // The source has a view (out-of-scope), so error mode must refuse.
    await expect(reconstructSchema(source, target, { onUnsupported: 'error' })).rejects.toThrow(
      /out-of-scope/,
    );
    // It failed before emitting any DDL — the target has no app-class objects.
    const { rows } = await target.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('authors', 'books', 'status')`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('onUnsupported: error reconstructs normally when nothing is out of scope', async () => {
    await source.exec(`DROP VIEW author_names`);
    const report = await reconstructSchema(source, target, { onUnsupported: 'error' });
    expect(report.unsupported).toEqual([]);
    expect([...report.tables].sort()).toEqual(['public.authors', 'public.books']);
  });

  it('reports the new out-of-scope classes: comments, grants, collations, rules, functions', async () => {
    await source.exec(`
      COMMENT ON TABLE authors IS 'people who write';
      GRANT SELECT ON books TO PUBLIC;
      CREATE COLLATION mycoll (locale = 'C');
      CREATE RULE no_delete AS ON DELETE TO books DO INSTEAD NOTHING;
      CREATE FUNCTION noop() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;
    `);
    const report = await reconstructSchema(source, target);
    const kinds = report.unsupported.map((u) => `${u.kind} ${u.name}`);

    expect(kinds).toContain('comment public.authors');
    expect(kinds).toContain('grant public.books');
    expect(kinds).toContain('collation public.mycoll');
    expect(kinds).toContain('rule public.books.no_delete');
    expect(kinds).toContain('function public.noop');
  });

  it("does not report a view's implicit _RETURN rule or row type as separate objects", async () => {
    const report = await reconstructSchema(source, target);
    // The view is reported once, as a view — not also as a rule or composite type.
    const forView = report.unsupported.filter((u) => u.name.includes('author_names'));
    expect(forView).toEqual([{ kind: 'view', name: 'public.author_names' }]);
  });

  it('reports nothing for a plain app-class source (no false positives)', async () => {
    const clean = new PGlite();
    const cleanTarget = new PGlite();
    try {
      await clean.exec(`CREATE TABLE t (id serial PRIMARY KEY, v text)`);
      const report = await reconstructSchema(clean, cleanTarget);
      // Notably: plpgsql ships with every database and must not be reported,
      // nor must a table's implicit composite row type.
      expect(report.unsupported).toEqual([]);
    } finally {
      await clean.close();
      await cleanTarget.close();
    }
  });

  it('recreates working constraints, defaults, and the serial sequence', async () => {
    await reconstructSchema(source, target);

    // FK is enforced.
    await expect(
      target.query(`INSERT INTO books (author_id, title) VALUES (999, 'x')`),
    ).rejects.toThrow();
    // CHECK is enforced.
    await target.query(`INSERT INTO authors (name) VALUES ('Ursula')`);
    await expect(
      target.query(`INSERT INTO books (author_id, title) VALUES (1, '')`),
    ).rejects.toThrow();
    // Enum default applied; serial default works.
    const { rows } = await target.query<{ id: number; state: string }>(
      `SELECT id, state::text AS state FROM authors`,
    );
    expect(rows[0].state).toBe('active');
    expect(rows[0].id).toBeGreaterThan(0);
  });
});

/**
 * The gaps found by the PGLM-74 audit. Each of these reproduced a real failure
 * before the fix, so they are regression tests in the strict sense.
 */
describe('reconstructSchema (audit regressions)', () => {
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

  it('creates non-public schemas before the objects that live in them (PGLM-76)', async () => {
    await source.exec(`
      CREATE SCHEMA app;
      CREATE TABLE app.widgets (id int PRIMARY KEY);
      CREATE TABLE public.gadgets (id int PRIMARY KEY);
    `);

    const report = await reconstructSchema(source, target);

    expect(report.schemas).toEqual(['app']);
    expect([...report.tables].sort()).toEqual(['app.widgets', 'public.gadgets']);
    const { rows } = await target.query<{ q: string }>(
      `SELECT n.nspname || '.' || c.relname AS q
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname IN ('app', 'public') ORDER BY 1`,
    );
    expect(rows.map((r) => r.q)).toEqual(['app.widgets', 'public.gadgets']);
  });

  it('preserves sequence start/increment/min/max/cycle (PGLM-77)', async () => {
    await source.exec(`CREATE SEQUENCE s1 START 100 INCREMENT 5 MINVALUE 10 MAXVALUE 900 CYCLE`);

    await reconstructSchema(source, target);

    const read = async (db: PGlite) =>
      (
        await db.query<Record<string, string | boolean>>(
          `SELECT increment_by::text AS inc, min_value::text AS mn, max_value::text AS mx,
                  start_value::text AS st, cycle
             FROM pg_sequences WHERE sequencename = 's1'`,
        )
      ).rows[0];

    // Compare against the source rather than hard-coded values: the point is
    // parity, and this stays correct if a future major changes a default.
    expect(await read(target)).toEqual(await read(source));
    expect(await read(target)).toMatchObject({ inc: '5', mn: '10', mx: '900', st: '100' });
  });

  it('re-establishes OWNED BY for a serial column, leaving identity alone (PGLM-78)', async () => {
    await source.exec(`
      CREATE TABLE u (id serial PRIMARY KEY, name text);
      CREATE TABLE i (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, v text);
    `);

    await reconstructSchema(source, target);

    const owned = await target.query<{ owned: string | null }>(
      `SELECT pg_get_serial_sequence('u', 'id') AS owned`,
    );
    expect(owned.rows[0].owned).toBe('public.u_id_seq');

    // The identity column's sequence is created implicitly by the column, so it
    // is excluded from the standalone-sequence pass and must still work.
    const inserted = await target.query<{ id: number }>(
      `INSERT INTO i (v) VALUES ('a') RETURNING id`,
    );
    expect(inserted.rows[0].id).toBeGreaterThan(0);
  });

  it('reconstructs a stored generated column as GENERATED … STORED, not a DEFAULT', async () => {
    // columnDef branches three ways on identity/generated/default. The stored
    // generated arm emits a different clause from a plain default, and it feeds
    // CREATE TABLE directly — a wrong branch produces a writable column that
    // silently stops recomputing.
    await source.exec(`
      CREATE TABLE m (
        base integer NOT NULL,
        doubled integer GENERATED ALWAYS AS (base * 2) STORED,
        labeled text DEFAULT 'x'
      );
    `);

    await reconstructSchema(source, target);

    const { rows } = await target.query<{ name: string; gen: string; def: string | null }>(
      `SELECT a.attname AS name, a.attgenerated AS gen,
              pg_get_expr(d.adbin, d.adrelid) AS def
         FROM pg_attribute a
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = 'm'::regclass AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
    );
    const col = (n: string) => rows.find((r) => r.name === n);
    expect(col('doubled')?.gen).toBe('s');
    expect(col('labeled')?.gen).toBe('');
    expect(col('labeled')?.def).toContain("'x'");

    // And it actually recomputes on the target.
    await target.query(`INSERT INTO m (base) VALUES (21)`);
    const { rows: v } = await target.query<{ doubled: number }>(`SELECT doubled FROM m`);
    expect(v[0].doubled).toBe(42);
  });

  it('detects domains and composite types as out-of-scope (PGLM-79)', async () => {
    await source.exec(`
      CREATE DOMAIN posint AS integer CHECK (VALUE > 0);
      CREATE TYPE pair AS (a int, b int);
      CREATE TABLE plain (id int PRIMARY KEY);
    `);

    const report = await reconstructSchema(source, target);

    expect(report.unsupported).toContainEqual({ kind: 'domain', name: 'public.posint' });
    expect(report.unsupported).toContainEqual({ kind: 'composite type', name: 'public.pair' });
    // The app-class part of the schema is still rebuilt (warn is the default).
    expect(report.tables).toEqual(['public.plain']);
  });

  it('KNOWN LIMITATION: warn mode still fails when a column uses a domain (PGLM-79 part 2)', async () => {
    // Detection now fires (above), so `onUnsupported: 'error'` refuses cleanly.
    // But `warn` proceeds by contract, and `format_type` renders the column as
    // `posint`, which was never created. Reconstructing domains is the open
    // scope decision in docs/9 OQ-9.5, tracked as its own ticket. Pinned here so
    // the gap is executable rather than folklore — flip this to a passing
    // reconstruction when part 2 lands.
    await source.exec(`
      CREATE DOMAIN posint AS integer CHECK (VALUE > 0);
      CREATE TABLE d (x posint);
    `);

    await expect(reconstructSchema(source, target)).rejects.toThrow(/type "posint" does not exist/);
  });

  it('leaves the target completely untouched when a domain forces an error-mode refusal (PGLM-79)', async () => {
    await source.exec(`
      CREATE TYPE mood AS ENUM ('ok');
      CREATE SEQUENCE sq;
      CREATE DOMAIN posint AS integer CHECK (VALUE > 0);
      CREATE TABLE d (x posint);
    `);

    await expect(reconstructSchema(source, target, { onUnsupported: 'error' })).rejects.toThrow(
      /domain public\.posint/,
    );

    // This is the property the bug violated: detection never fired, so error
    // mode ran anyway and died partway with the enum and sequence already created.
    const objects = await target.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'`,
    );
    expect(objects.rows[0].n).toBe(0);
    const types = await target.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public'`,
    );
    expect(types.rows[0].n).toBe(0);
  });
});
