import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { introspectSchema } from '../src/introspect.js';

/**
 * Edge cases beyond the basic authors/books fixture: multiple schemas, dropped
 * columns, composite and self-referential foreign keys, never-advanced
 * sequences, empty tables, and type qualifiers rendered by `format_type`.
 */
describe('introspectSchema (edge cases)', () => {
  let db: PGlite;

  beforeEach(() => {
    db = new PGlite();
  });

  afterEach(async () => {
    await db.close();
  });

  it('introspects user tables in non-public schemas and excludes system schemas', async () => {
    await db.exec(`
      CREATE SCHEMA app;
      CREATE TABLE app.things (id integer PRIMARY KEY);
      CREATE TABLE public.stuff (id integer PRIMARY KEY);
    `);

    const schema = await introspectSchema(db);
    const keys = schema.tables.map((t) => `${t.schema}.${t.name}`).sort();

    expect(keys).toEqual(['app.things', 'public.stuff']);
    // Nothing from pg_catalog / information_schema leaks in.
    expect(schema.tables.every((t) => t.schema === 'app' || t.schema === 'public')).toBe(true);
  });

  it('excludes dropped columns and keeps remaining columns in physical order', async () => {
    await db.exec(`
      CREATE TABLE t (a integer, b integer, c integer);
      ALTER TABLE t DROP COLUMN b;
    `);

    const schema = await introspectSchema(db);
    const t = schema.tables.find((x) => x.name === 't');

    expect(t?.columns.map((c) => c.name)).toEqual(['a', 'c']);
  });

  it('detects a composite (multi-column) foreign key once', async () => {
    await db.exec(`
      CREATE TABLE parent (a integer, b integer, PRIMARY KEY (a, b));
      CREATE TABLE child (
        a integer, b integer,
        FOREIGN KEY (a, b) REFERENCES parent (a, b)
      );
    `);

    const schema = await introspectSchema(db);

    const edges = schema.foreignKeys.filter(
      (fk) => fk.child === 'public.child' && fk.parent === 'public.parent',
    );
    expect(edges).toHaveLength(1);
  });

  it('excludes self-referential foreign keys', async () => {
    await db.exec(`
      CREATE TABLE tree (id integer PRIMARY KEY, parent_id integer REFERENCES tree(id));
    `);

    const schema = await introspectSchema(db);

    expect(schema.foreignKeys).toEqual([]);
  });

  it('qualifies foreign-key names so they match the table keys (public included)', async () => {
    // Regression: regclass::text drops the schema for public, which would make
    // the FK edge fail to match the qualified table key in topologicalSort.
    await db.exec(`
      CREATE TABLE authors (id integer PRIMARY KEY);
      CREATE TABLE books (id integer PRIMARY KEY, author_id integer REFERENCES authors(id));
    `);

    const schema = await introspectSchema(db);

    expect(schema.foreignKeys).toContainEqual({
      child: 'public.books',
      parent: 'public.authors',
    });
  });

  it('captures a never-advanced sequence with a null lastValue', async () => {
    await db.exec(`CREATE SEQUENCE fresh_seq`);

    const schema = await introspectSchema(db);
    const seq = schema.sequences.find((s) => s.name === 'fresh_seq');

    expect(seq).toBeDefined();
    expect(seq?.lastValue).toBeNull();
  });

  it('introspects an empty table cleanly', async () => {
    await db.exec(`CREATE TABLE blank (id integer, label text)`);

    const schema = await introspectSchema(db);
    const t = schema.tables.find((x) => x.name === 'blank');

    expect(t?.columns.map((c) => c.name)).toEqual(['id', 'label']);
  });

  it('flags generated (stored) and identity columns', async () => {
    await db.exec(`
      CREATE TABLE g (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        base integer,
        doubled integer GENERATED ALWAYS AS (base * 2) STORED,
        plain text
      );
    `);

    const schema = await introspectSchema(db);
    const cols = schema.tables.find((t) => t.name === 'g')?.columns ?? [];
    const col = (n: string) => cols.find((c) => c.name === n);

    expect(col('id')?.identity).toBe('always');
    expect(col('id')?.generated).toBe(false);
    expect(col('doubled')?.generated).toBe(true);
    expect(col('doubled')?.identity).toBeNull();
    expect(col('plain')?.generated).toBe(false);
    expect(col('plain')?.identity).toBeNull();
  });

  it('captures type qualifiers verbatim via format_type', async () => {
    await db.exec(`
      CREATE TABLE typed (
        price numeric(10,2),
        code varchar(50),
        at timestamptz
      );
    `);

    const schema = await introspectSchema(db);
    const cols = schema.tables.find((x) => x.name === 'typed')?.columns ?? [];
    const typeOf = (name: string): string | undefined => cols.find((c) => c.name === name)?.type;

    expect(typeOf('price')).toBe('numeric(10,2)');
    expect(typeOf('code')).toBe('character varying(50)');
    expect(typeOf('at')).toBe('timestamp with time zone');
  });
});
