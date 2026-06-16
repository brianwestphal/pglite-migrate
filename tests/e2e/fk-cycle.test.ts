import { PGlite as PGliteNew } from 'pglite-new';
import { PGlite as PGliteOld } from 'pglite-old';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from '../../src/migrate.js';

/**
 * Foreign-key cycle handling across two engines. A mutual A/B reference cycle
 * cannot be linearized, so v1 detects it, warns, and inserts in original order.
 *
 * - The empty-cycle case pins the *current* behavior (detect + warn, no rows).
 * - The populated-cycle case is the *target* behavior (FR-2.11 / FR-5.5 /
 *   PGLM-2): migrate a referential cycle with no violation. It is an expected
 *   failure today because the plain per-row INSERT path cannot satisfy a cycle
 *   without deferred constraints — flip `it.fails` to `it` when PGLM-2 lands.
 */
const CYCLE_DDL = `
CREATE TABLE a (id integer PRIMARY KEY, b_id integer);
CREATE TABLE b (id integer PRIMARY KEY, a_id integer);
ALTER TABLE a ADD CONSTRAINT a_b_fk FOREIGN KEY (b_id) REFERENCES b(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE b ADD CONSTRAINT b_a_fk FOREIGN KEY (a_id) REFERENCES a(id) DEFERRABLE INITIALLY DEFERRED;
`;

describe('foreign-key cycle (two-version round-trip)', () => {
  let source: PGliteOld;
  let target: PGliteNew;

  beforeEach(async () => {
    source = new PGliteOld();
    target = new PGliteNew();
    await source.exec(CYCLE_DDL);
    await target.exec(CYCLE_DDL);
  });

  afterEach(async () => {
    await source.close();
    await target.close();
  });

  it('detects an empty cycle, warns naming both tables, and copies no rows', async () => {
    const report = await migrate({ source, target });

    expect(report.totalRows).toBe(0);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('public.a');
    expect(report.warnings[0]).toContain('public.b');
  });

  it.fails('migrates a populated cycle without constraint violation — PGLM-2', async () => {
    // Seed a genuine cycle: a(1)->b(1), b(1)->a(1). Needs deferred constraints
    // within a transaction even to insert on the source.
    await source.exec(`
      BEGIN;
      SET CONSTRAINTS ALL DEFERRED;
      INSERT INTO a (id, b_id) VALUES (1, 1);
      INSERT INTO b (id, a_id) VALUES (1, 1);
      COMMIT;
    `);

    await migrate({ source, target });

    const a = await target.query<{ count: string }>('SELECT count(*)::text AS count FROM a');
    const b = await target.query<{ count: string }>('SELECT count(*)::text AS count FROM b');
    expect(a.rows[0].count).toBe('1');
    expect(b.rows[0].count).toBe('1');
  });
});
