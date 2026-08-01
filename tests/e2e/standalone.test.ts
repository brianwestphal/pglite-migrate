import { PGlite as PGliteNew } from 'pglite-new';
import { PGlite as PGliteOld } from 'pglite-old';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from '../../src/migrate.js';

/**
 * Standalone path (PGLM-25/PGLM-18): the target has NO schema. `migrate` with
 * `reconstructSchema: true` rebuilds the source's app-class schema on the target
 * and then transfers data — all across two independently-resolved engines.
 */
const SOURCE_SCHEMA = `
CREATE TYPE status AS ENUM ('active', 'inactive');
CREATE DOMAIN rating AS integer CHECK (VALUE BETWEEN 1 AND 5);
CREATE TYPE address AS (city text, country text);
CREATE TABLE authors (
  id serial PRIMARY KEY,
  name text NOT NULL,
  state status DEFAULT 'active',
  score rating,
  home address
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

const SEED = `
INSERT INTO authors (name, score, home) VALUES
  ('Ursula', 5, ROW('Portland', 'US')::address),
  ('Octavia', 4, ROW('Pasadena', 'US')::address);
INSERT INTO books (author_id, title) VALUES (1, 'A Wizard of Earthsea'), (2, 'Kindred');
`;

describe('standalone reconstruction (two-version round-trip)', () => {
  let source: PGliteOld;
  let target: PGliteNew;

  beforeEach(async () => {
    source = new PGliteOld();
    await source.exec(SOURCE_SCHEMA);
    await source.exec(SEED);
    target = new PGliteNew(); // empty — no schema created up front
  });

  afterEach(async () => {
    await source.close();
    await target.close();
  });

  it('reconstructs the schema on an empty target and transfers the data', async () => {
    const report = await migrate({ source, target, reconstructSchema: true });

    // Reconstruction happened and is reported.
    expect(report.reconstruction).toBeDefined();
    expect([...(report.reconstruction?.tables ?? [])].sort()).toEqual([
      'public.authors',
      'public.books',
    ]);
    expect(report.reconstruction?.enums).toContain('public.status');
    // Custom types beyond enums (docs/16) survive the cross-major rebuild.
    expect(report.reconstruction?.domains).toContain('public.rating');
    expect(report.reconstruction?.composites).toContain('public.address');
    expect(report.reconstruction?.indexes).toContain('books_author_idx');

    // The out-of-scope view is detected and reported, not recreated.
    expect(report.reconstruction?.unsupported).toContainEqual({
      kind: 'view',
      name: 'public.author_names',
    });

    // Data transferred and validation passed.
    expect(report.totalRows).toBe(4);
    expect(report.validation?.ok).toBe(true);
    const books = await target.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM books',
    );
    expect(books.rows[0].count).toBe('2');
  });

  it('reconstructs working constraints and a realigned sequence', async () => {
    await migrate({ source, target, reconstructSchema: true });

    // FK enforced on the reconstructed target.
    await expect(
      target.query(`INSERT INTO books (author_id, title) VALUES (999, 'x')`),
    ).rejects.toThrow();

    // Sequence realigned so a new author's id is past the migrated maximum.
    const { rows } = await target.query<{ id: number }>(
      `INSERT INTO authors (name) VALUES ('Samuel') RETURNING id`,
    );
    expect(rows[0].id).toBeGreaterThan(2);
  });

  it('rebuilds a domain that still enforces its CHECK, and a composite column (docs/16)', async () => {
    await migrate({ source, target, reconstructSchema: true });

    // The domain is not merely present — its CHECK is enforced on the target.
    await expect(
      target.query(`INSERT INTO authors (name, score) VALUES ('Bad', 9)`),
    ).rejects.toThrow();
    await target.query(`INSERT INTO authors (name, score) VALUES ('Good', 3)`);

    // The composite column round-tripped its values across the major boundary.
    const { rows } = await target.query<{ city: string; country: string }>(
      `SELECT (home).city AS city, (home).country AS country
         FROM authors WHERE name = 'Ursula'`,
    );
    expect(rows[0]).toEqual({ city: 'Portland', country: 'US' });
  });
});
