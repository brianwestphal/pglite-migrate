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
