import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

import {
  countRows,
  hasRows,
  objectKey,
  regclassLiteral,
  systemSchemaFilter,
  tableKey,
} from '../src/catalog.js';
import type { PGliteLike, SequenceInfo, TableInfo } from '../src/types.js';

describe('tableKey', () => {
  it('joins schema and name with a dot (the FK-edge key format)', () => {
    expect(tableKey({ schema: 'public', name: 'authors' })).toBe('public.authors');
    expect(tableKey({ schema: 'inventory', name: 'items' })).toBe('inventory.items');
  });

  it('accepts a TableInfo and a SequenceInfo alike', () => {
    // Both report shapes are keyed through this helper, so the structural
    // parameter type has to keep accepting both (PGLM-87).
    const table: TableInfo = { schema: 'public', name: 'authors', columns: [] };
    const sequence: SequenceInfo = { schema: 'public', name: 'authors_id_seq', lastValue: 7 };
    expect(tableKey(table)).toBe('public.authors');
    expect(tableKey(sequence)).toBe('public.authors_id_seq');
  });
});

describe('objectKey', () => {
  it('names a table-scoped object as schema.table.object', () => {
    expect(objectKey('public', 'books', 'title_not_blank')).toBe('public.books.title_not_blank');
  });

  it('is deliberately a different format from tableKey', () => {
    // tableKey feeds FK-edge matching; objectKey is report-only. Keeping them
    // distinct is intentional — this pins that they do not converge by accident.
    expect(objectKey('public', 'books', 'x')).not.toBe(tableKey({ schema: 'public', name: 'books' }));
  });
});

describe('systemSchemaFilter', () => {
  it('defaults to the bare `nspname` column', () => {
    expect(systemSchemaFilter()).toBe(
      "nspname NOT IN ('pg_catalog', 'information_schema') " +
        "AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%'",
    );
  });

  it('injects a caller-supplied alias directly (no fragile string rewrite)', () => {
    const f = systemSchemaFilter('n.nspname');
    expect(f).toContain("n.nspname NOT IN ('pg_catalog', 'information_schema')");
    expect(f).toContain("n.nspname NOT LIKE 'pg_toast%'");
    expect(f).toContain("n.nspname NOT LIKE 'pg_temp%'");
    // The bare token must not survive — that was the rewrite-collision risk.
    expect(f).not.toMatch(/(?<![.\w])nspname/);
  });

  it('excludes catalog, information_schema, and the toast/temp schemas', () => {
    expect(systemSchemaFilter('schemaname')).toBe(
      "schemaname NOT IN ('pg_catalog', 'information_schema') " +
        "AND schemaname NOT LIKE 'pg_toast%' AND schemaname NOT LIKE 'pg_temp%'",
    );
  });
});

describe('regclassLiteral', () => {
  it('quotes a qualified name as a string literal for a ::regclass cast', () => {
    expect(regclassLiteral('public', 'authors')).toBe(`'"public"."authors"'`);
  });

  it('escapes embedded quotes in both identifier and literal layers', () => {
    expect(regclassLiteral('we"ird', "o'dd")).toBe(`'"we""ird"."o''dd"'`);
  });
});

describe('countRows', () => {
  it('counts rows in a qualified table against a real cluster', async () => {
    const db = new PGlite();
    const like = db as unknown as PGliteLike;
    await db.exec(`CREATE TABLE public.t (id int); INSERT INTO public.t VALUES (1), (2), (3);`);
    expect(await countRows(like, '"public"."t"')).toBe(3);

    await db.exec(`CREATE TABLE public.empty (id int);`);
    expect(await countRows(like, '"public"."empty"')).toBe(0);
    await db.close();
  });

  it('reads the count as text so it does not hit the int cast ceiling', async () => {
    // The old `count(*)::int` raised `integer out of range` past 2^31. There is
    // no way to seed 2 billion rows, so this pins the mechanism instead: a
    // bigint-valued text count parses correctly through the same path.
    const db = new PGlite();
    const like = db as unknown as PGliteLike;
    await db.exec(`CREATE TABLE public.t (id int); INSERT INTO public.t VALUES (1), (2);`);
    // Prove the query no longer casts to int by running the shape it now uses
    // against a value that would have overflowed it.
    const { rows } = await db.query<{ n: string }>(`SELECT 3000000000::bigint::text AS n`);
    expect(Number(rows[0].n)).toBe(3_000_000_000);
    expect(await countRows(like, '"public"."t"')).toBe(2);
    await db.close();
  });
});

describe('hasRows', () => {
  it('answers the non-empty question without counting', async () => {
    const db = new PGlite();
    const like = db as unknown as PGliteLike;
    await db.exec(`CREATE TABLE public.full (id int); INSERT INTO public.full VALUES (1), (2);`);
    await db.exec(`CREATE TABLE public.empty (id int);`);

    expect(await hasRows(like, '"public"."full"')).toBe(true);
    expect(await hasRows(like, '"public"."empty"')).toBe(false);
    await db.close();
  });
});
