import { PGlite as PGliteNew } from 'pglite-new';
import { PGlite as PGliteOld } from 'pglite-old';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from '../../src/migrate.js';

/**
 * Foreign-key cycle handling across two engines (PGLM-23). A mutual A/B
 * reference cycle cannot be linearized, so the cyclic subset is transferred
 * inside one target transaction with deferred constraints.
 *
 * A populated cycle can only exist in the source if its FKs are DEFERRABLE, so
 * the source always uses DEFERRABLE constraints. The target (the host app's
 * schema) may have authored its FKs either way — both variants are covered.
 */
const SOURCE_DDL = `
CREATE TABLE a (id integer PRIMARY KEY, b_id integer);
CREATE TABLE b (id integer PRIMARY KEY, a_id integer);
ALTER TABLE a ADD CONSTRAINT a_b_fk FOREIGN KEY (b_id) REFERENCES b(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE b ADD CONSTRAINT b_a_fk FOREIGN KEY (a_id) REFERENCES a(id) DEFERRABLE INITIALLY DEFERRED;
`;

const TARGET_DDL_NOT_DEFERRABLE = `
CREATE TABLE a (id integer PRIMARY KEY, b_id integer);
CREATE TABLE b (id integer PRIMARY KEY, a_id integer);
ALTER TABLE a ADD CONSTRAINT a_b_fk FOREIGN KEY (b_id) REFERENCES b(id);
ALTER TABLE b ADD CONSTRAINT b_a_fk FOREIGN KEY (a_id) REFERENCES a(id);
`;

/** Seed a genuine cycle: a(1) refs b(1), b(1) refs a(1). Needs a deferred transaction. */
const SEED = `
BEGIN;
SET CONSTRAINTS ALL DEFERRED;
INSERT INTO a (id, b_id) VALUES (1, 1);
INSERT INTO b (id, a_id) VALUES (1, 1);
COMMIT;
`;

describe('foreign-key cycle (two-version round-trip)', () => {
  let source: PGliteOld;
  let target: PGliteNew;

  beforeEach(() => {
    source = new PGliteOld();
    target = new PGliteNew();
  });

  afterEach(async () => {
    await source.close();
    await target.close();
  });

  it('handles an empty cycle with deferred constraints and no warning', async () => {
    await source.exec(SOURCE_DDL);
    await target.exec(SOURCE_DDL);

    const report = await migrate({ source, target });

    expect(report.totalRows).toBe(0);
    expect(report.warnings).toEqual([]);
    expect([...report.deferredTables].sort()).toEqual(['public.a', 'public.b']);
  });

  it('migrates a populated cycle (deferrable target) with no constraint violation', async () => {
    await source.exec(SOURCE_DDL);
    await source.exec(SEED);
    await target.exec(SOURCE_DDL);

    const report = await migrate({ source, target });

    expect(report.warnings).toEqual([]);
    expect([...report.deferredTables].sort()).toEqual(['public.a', 'public.b']);
    const a = await target.query<{ count: string }>('SELECT count(*)::text AS count FROM a');
    const b = await target.query<{ count: string }>('SELECT count(*)::text AS count FROM b');
    expect(a.rows[0].count).toBe('1');
    expect(b.rows[0].count).toBe('1');
  });

  it('migrates a populated cycle into a NOT DEFERRABLE target, restoring the constraint', async () => {
    await source.exec(SOURCE_DDL);
    await source.exec(SEED);
    await target.exec(TARGET_DDL_NOT_DEFERRABLE);

    const report = await migrate({ source, target });

    expect(report.warnings).toEqual([]);
    expect([...report.deferredTables].sort()).toEqual(['public.a', 'public.b']);

    const a = await target.query<{ count: string }>('SELECT count(*)::text AS count FROM a');
    expect(a.rows[0].count).toBe('1');

    // The FK is still enforced afterward (the deferrability flip was reverted).
    await expect(
      target.query(`INSERT INTO a (id, b_id) VALUES (99, 12345)`),
    ).rejects.toThrow();
  });
});
