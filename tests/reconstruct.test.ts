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

  it('reconstructs domains with base type, default, NOT NULL and every CHECK (FR-16.1)', async () => {
    await source.exec(`
      CREATE DOMAIN posint AS integer NOT NULL DEFAULT 1
        CHECK (VALUE > 0) CHECK (VALUE < 1000);
      CREATE TABLE uses_it (x posint);
    `);

    const report = await reconstructSchema(source, target);

    expect(report.domains).toEqual(['public.posint']);
    // FR-16.3: a reconstructed type must NOT also be reported as unsupported.
    expect(report.unsupported).toEqual([]);

    // The CHECKs are ENFORCED, not merely present — a domain rebuilt without
    // its constraints is the quiet failure mode this guards.
    await expect(target.query(`INSERT INTO uses_it (x) VALUES (0)`)).rejects.toThrow();
    await expect(target.query(`INSERT INTO uses_it (x) VALUES (5000)`)).rejects.toThrow();
    await target.query(`INSERT INTO uses_it (x) VALUES (42)`);
    // DEFAULT and NOT NULL survived.
    await target.query(`INSERT INTO uses_it DEFAULT VALUES`);
    const { rows } = await target.query<{ x: number }>(`SELECT x FROM uses_it ORDER BY x`);
    expect(rows.map((r) => r.x)).toEqual([1, 42]);
  });

  it('reconstructs standalone composite types with attributes in order (FR-16.2)', async () => {
    await source.exec(`
      CREATE TYPE pair AS (a integer, b text);
      CREATE TABLE holds (p pair);
    `);

    const report = await reconstructSchema(source, target);

    expect(report.composites).toEqual(['public.pair']);
    expect(report.unsupported).toEqual([]);

    await target.query(`INSERT INTO holds (p) VALUES (ROW(1, 'x')::pair)`);
    const { rows } = await target.query<{ a: number; b: string }>(
      `SELECT (p).a AS a, (p).b AS b FROM holds`,
    );
    expect(rows[0]).toEqual({ a: 1, b: 'x' });
  });

  it('emits a domain COLLATE clause (FR-16.6)', async () => {
    await source.exec(`CREATE DOMAIN email AS text COLLATE "C" CHECK (VALUE LIKE '%@%')`);

    await reconstructSchema(source, target);

    const { rows } = await target.query<{ coll: string }>(
      `SELECT co.collname AS coll
         FROM pg_type t JOIN pg_collation co ON co.oid = t.typcollation
        WHERE t.typname = 'email'`,
    );
    expect(rows[0]?.coll).toBe('C');
  });

  it('orders custom types so cross-kind dependencies resolve (NFR-16.7)', async () => {
    // A domain over an enum, and a composite with a domain-typed attribute.
    // Three separate name-ordered passes could not satisfy both; the single
    // OID-ordered pass can, because OID order is a real dependency order.
    await source.exec(`
      CREATE TYPE mood AS ENUM ('ok', 'bad');
      CREATE DOMAIN good_mood AS mood CHECK (VALUE = 'ok');
      CREATE TYPE tagged AS (m good_mood, note text);
      CREATE TABLE t (x tagged);
    `);

    const report = await reconstructSchema(source, target);

    expect(report.enums).toEqual(['public.mood']);
    expect(report.domains).toEqual(['public.good_mood']);
    expect(report.composites).toEqual(['public.tagged']);
    await target.query(`INSERT INTO t (x) VALUES (ROW('ok', 'n')::tagged)`);
    await expect(
      target.query(`INSERT INTO t (x) VALUES (ROW('bad', 'n')::tagged)`),
    ).rejects.toThrow();
  });

  it("excludes information_schema's built-in domains and implicit row types (NFR-16.8)", async () => {
    await source.exec(`CREATE TABLE plain (id int PRIMARY KEY)`);

    const report = await reconstructSchema(source, target);

    // `plain` has an implicit composite row type in pg_type; it must not be
    // emitted as a standalone composite, and information_schema's own domains
    // (cardinal_number, yes_or_no, ...) must not leak in either.
    expect(report.composites).toEqual([]);
    expect(report.domains).toEqual([]);
    expect(report.unsupported).toEqual([]);
  });

  it('reconstructs a function-free range type (FR-17.1)', async () => {
    await source.exec(`
      CREATE TYPE intrange AS RANGE (subtype = integer);
      CREATE TABLE spans (r intrange);
    `);

    const report = await reconstructSchema(source, target);

    expect(report.ranges).toEqual(['public.intrange']);
    expect(report.unsupported).toEqual([]);

    // Usable on the target, not merely present.
    await target.query(`INSERT INTO spans (r) VALUES ('[1,5)'::intrange)`);
    const { rows } = await target.query<{ has: boolean }>(
      `SELECT r @> 3 AS has FROM spans`,
    );
    expect(rows[0].has).toBe(true);
  });

  it('orders a range over a domain subtype correctly (NFR-17.8)', async () => {
    await source.exec(`
      CREATE DOMAIN posint AS integer CHECK (VALUE > 0);
      CREATE TYPE posrange AS RANGE (subtype = posint);
    `);

    const report = await reconstructSchema(source, target);

    expect(report.domains).toEqual(['public.posint']);
    expect(report.ranges).toEqual(['public.posrange']);
    expect(report.unsupported).toEqual([]);
  });

  it('carries a non-default collation on the range subtype (FR-17.3)', async () => {
    await source.exec(`CREATE TYPE crange AS RANGE (subtype = text, collation = "C")`);

    await reconstructSchema(source, target);

    const { rows } = await target.query<{ coll: string | null }>(
      `SELECT c.collname AS coll
         FROM pg_range r JOIN pg_type t ON t.oid = r.rngtypid
         LEFT JOIN pg_collation c ON c.oid = r.rngcollation
        WHERE t.typname = 'crange'`,
    );
    expect(rows[0]?.coll).toBe('C');
  });

  it('does not emit or report the auto-created multirange type (FR-17.6)', async () => {
    await source.exec(`CREATE TYPE intrange AS RANGE (subtype = integer)`);

    const report = await reconstructSchema(source, target);

    // It is created implicitly by the range, so it belongs in neither list...
    expect(report.ranges).toEqual(['public.intrange']);
    expect(report.unsupported).toEqual([]);
    // ...and it must still exist and work on the target.
    const { rows } = await target.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_type t
         JOIN pg_namespace ns ON ns.oid = t.typnamespace
        WHERE ns.nspname = 'public' AND t.typtype = 'm'`,
    );
    expect(rows[0].n).toBe(1);
    await target.query(`SELECT '{[1,5)}'::intmultirange`);
  });

  it('reports a range that depends on a canonical function (FR-17.2/FR-17.7)', async () => {
    // This state cannot be reached through normal DDL *in PGlite*: a canonical
    // function must accept the range's shell type, which SQL functions refuse
    // ("cannot accept shell type") and PL/pgSQL cannot return, and C functions
    // are unavailable in WASM. So the branch is defensive — and the only honest
    // way to exercise it is to write the catalog row the detector keys on.
    await source.exec(`CREATE TYPE ir AS RANGE (subtype = integer)`);
    await source.exec(`SET allow_system_table_mods = on`);
    await source.exec(
      `UPDATE pg_range SET rngcanonical = 'int4in'::regproc WHERE rngtypid = 'ir'::regtype`,
    );

    const report = await reconstructSchema(source, target);

    expect(report.ranges).toEqual([]);
    expect(report.unsupported).toContainEqual({
      kind: 'range type (depends on a canonical/subdiff function)',
      name: 'public.ir',
    });
  });
});
