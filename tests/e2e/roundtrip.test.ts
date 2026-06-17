import { PGlite as PGliteNew } from 'pglite-new';
import { PGlite as PGliteOld } from 'pglite-old';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from '../../src/migrate.js';
import { SCHEMA_SQL, SEED_SQL } from '../helpers.js';

/**
 * Full pipeline: an old-engine source with data migrated into a new-engine
 * target whose schema was created up front (the app-driven contract).
 *
 * `pglite-old` and `pglite-new` are npm aliases resolving to two different
 * PostgreSQL majors (0.4.x = PG17, 0.5.x = PG18), so this in-memory round-trip
 * is already a genuine cross-major migration. The on-disk variant — including
 * the assertion that a PG18 engine refuses a PG17 data dir — lives in
 * `cross-major.test.ts`.
 */
describe('migrate (two-version round-trip)', () => {
  let source: PGliteOld;
  let target: PGliteNew;

  beforeEach(async () => {
    source = new PGliteOld();
    await source.exec(SCHEMA_SQL);
    await source.exec(SEED_SQL);

    // The "host app" creates its schema on the new engine; we transfer data.
    target = new PGliteNew();
    await target.exec(SCHEMA_SQL);
  });

  afterEach(async () => {
    await source.close();
    await target.close();
  });

  it('copies all rows in foreign-key-safe order', async () => {
    const report = await migrate({ source, target });

    expect(report.warnings).toEqual([]);
    expect(report.totalRows).toBe(4);

    const authors = await target.query<{ count: string }>('SELECT count(*)::text AS count FROM authors');
    const books = await target.query<{ count: string }>('SELECT count(*)::text AS count FROM books');
    expect(authors.rows[0].count).toBe('2');
    expect(books.rows[0].count).toBe('2');
  });

  it('preserves timestamptz values', async () => {
    await migrate({ source, target });

    const { rows } = await target.query<{ title: string; year: string }>(
      `SELECT title, extract(year from published_at)::text AS year FROM books ORDER BY id`,
    );
    expect(rows.map((r) => r.year)).toEqual(['1968', '1979']);
  });

  it('realigns sequences so nextval continues past migrated rows', async () => {
    await migrate({ source, target });

    // The next inserted author must not collide with migrated id 1 or 2.
    const { rows } = await target.query<{ id: number }>(
      `INSERT INTO authors (name) VALUES ('Samuel') RETURNING id`,
    );
    expect(rows[0].id).toBeGreaterThan(2);
  });
});
