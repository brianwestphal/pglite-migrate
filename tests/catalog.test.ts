import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

import { countRows, regclassLiteral, systemSchemaFilter, tableKey } from '../src/catalog.js';
import type { PGliteLike } from '../src/types.js';

describe('tableKey', () => {
  it('joins schema and name with a dot (the FK-edge key format)', () => {
    expect(tableKey({ schema: 'public', name: 'authors' })).toBe('public.authors');
    expect(tableKey({ schema: 'inventory', name: 'items' })).toBe('inventory.items');
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
});
