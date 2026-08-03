import { PGlite as PGliteNew } from 'pglite-new';
import { PGlite as PGliteOld } from 'pglite-old';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from '../../src/migrate.js';

/**
 * The app-driven column-layout case (PGLM-99), end to end across the real
 * PG17 → PG18 pair.
 *
 * A long-lived source cluster reaches its schema incrementally:
 * `ALTER TABLE ADD COLUMN` always *appends*, so the two progress columns land
 * after the timestamps. The host app's current `CREATE TABLE` declares them
 * where the developer wrote them — before the timestamps — and adds a column
 * the source never had. Same data, different physical layout and width.
 *
 * `validate: 'full'` must pass here. Before the fix it could not: the digest
 * hashed a whole-row `::text`, which renders in ordinal order and therefore
 * encoded the layout along with the content.
 */
const SOURCE_DDL = `
CREATE TABLE ai_analyses (
  id integer PRIMARY KEY,
  review_id integer,
  status text,
  created_at timestamptz,
  updated_at timestamptz,
  progress_completed integer,
  progress_total integer
);
`;

const TARGET_DDL = `
CREATE TABLE ai_analyses (
  id integer PRIMARY KEY,
  review_id integer,
  status text,
  progress_completed integer,
  progress_total integer,
  created_at timestamptz,
  updated_at timestamptz,
  error_message text
);
`;

const SEED = `
INSERT INTO ai_analyses
  (id, review_id, status, created_at, updated_at, progress_completed, progress_total) VALUES
  (1, 10, 'done',    '2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z', 3, 3),
  (2, 11, 'running', '2024-02-01T00:00:00Z', NULL,                   1, 4);
`;

describe('full validation across a column-layout change (two-version)', () => {
  let source: PGliteOld;
  let target: PGliteNew;

  beforeEach(async () => {
    source = new PGliteOld();
    await source.exec(SOURCE_DDL);
    await source.exec(SEED);

    target = new PGliteNew();
    await target.exec(TARGET_DDL);
  });

  afterEach(async () => {
    await source.close();
    await target.close();
  });

  it('passes and reports the target-only column instead of failing on it', async () => {
    const report = await migrate({ source, target, validate: 'full' });

    expect(report.warnings).toEqual([]);
    expect(report.totalRows).toBe(2);
    expect(report.validation?.ok).toBe(true);

    const t = report.validation?.tables[0];
    expect(t?.digestMatch).toBe(true);
    expect(t?.extraColumns).toEqual(['error_message']);
    expect(t?.missingColumns).toBeUndefined();
    expect(t?.comparedColumns).toEqual([
      'created_at',
      'id',
      'progress_completed',
      'progress_total',
      'review_id',
      'status',
      'updated_at',
    ]);
  });

  it('still catches content drift under the same layout change', async () => {
    await migrate({ source, target, validate: 'off' });
    // Corrupt one migrated value; counts stay equal, so only the digest can see it.
    await target.exec(`UPDATE ai_analyses SET status = 'wrong' WHERE id = 1`);

    const report = await migrate({ source, target, validate: 'full', onExisting: 'skip' });

    expect(report.validation?.ok).toBe(false);
    expect(report.validation?.tables[0].digestMatch).toBe(false);
  });
});
