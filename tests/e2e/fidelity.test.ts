import { PGlite as PGliteNew } from 'pglite-new';
import { PGlite as PGliteOld } from 'pglite-old';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from '../../src/migrate.js';
import type { PGliteLike } from '../../src/types.js';

/**
 * Data-fidelity round-trip for the types most at risk from the v1 row-by-row
 * INSERT path (values pass through JavaScript). Fidelity is judged by comparing
 * each value's Postgres *text* rendering (`::text`) on source vs target — the
 * representation the documented COPY-text path (NFR-2.15 / PGLM-1) preserves.
 *
 * Empirically, the current path already preserves `jsonb`, `numeric`, `bytea`,
 * and array types; only `json` (whose exact source text, incl. whitespace, is
 * significant) is lossy. The `json` case is therefore an expected failure here
 * until PGLM-1 lands — flip `it.fails` back to `it` when it does.
 */
const DDL = `
CREATE TABLE fid (
  id integer PRIMARY KEY,
  j json,
  jb jsonb,
  num numeric(30,10),
  data bytea,
  ints integer[],
  txts text[]
);
`;

const SEED = `
INSERT INTO fid (id, j, jb, num, data, ints, txts) VALUES
  (1,
   '{"b":1,  "a":2}'::json,
   '{"b":1,  "a":2}'::jsonb,
   1234567890.1234567890,
   '\\xDEADBEEF00'::bytea,
   ARRAY[1, NULL, 3]::integer[],
   ARRAY['x', NULL, 'a,b', 'with "quote"']::text[]);
`;

describe('data fidelity (two-version round-trip)', () => {
  let source: PGliteOld;
  let target: PGliteNew;

  beforeEach(async () => {
    source = new PGliteOld();
    target = new PGliteNew();
    await source.exec(DDL);
    await source.exec(SEED);
    await target.exec(DDL);
    await migrate({ source, target });
  });

  afterEach(async () => {
    await source.close();
    await target.close();
  });

  /** The `::text` rendering of a column on a given engine, for row id = 1. */
  async function textOf(db: PGliteLike, col: string): Promise<string | null> {
    const { rows } = await db.query<{ v: string | null }>(
      `SELECT ${col}::text AS v FROM fid WHERE id = 1`,
    );
    return rows[0].v;
  }

  it('preserves jsonb exactly', async () => {
    expect(await textOf(target, 'jb')).toBe(await textOf(source, 'jb'));
  });

  it('preserves numeric precision and scale exactly', async () => {
    expect(await textOf(target, 'num')).toBe(await textOf(source, 'num'));
    // Guard against float coercion: full 20-significant-digit value survives.
    expect(await textOf(target, 'num')).toBe('1234567890.1234567890');
  });

  it('preserves bytea bytes exactly', async () => {
    expect(await textOf(target, 'data')).toBe(await textOf(source, 'data'));
    expect(await textOf(target, 'data')).toBe('\\xdeadbeef00');
  });

  it('preserves integer arrays (elements, order, NULLs)', async () => {
    expect(await textOf(target, 'ints')).toBe(await textOf(source, 'ints'));
    expect(await textOf(target, 'ints')).toBe('{1,NULL,3}');
  });

  it('preserves text arrays (NULLs, commas, embedded quotes)', async () => {
    expect(await textOf(target, 'txts')).toBe(await textOf(source, 'txts'));
  });

  // Expected failure until the COPY-text path (PGLM-1) lands: round-tripping
  // `json` through JS re-serializes it, dropping the original whitespace
  // (`{"b":1,  "a":2}` -> `{"b":1,"a":2}`). When PGLM-1 ships, this should pass
  // — change `it.fails` to `it`.
  it.fails('preserves json source text verbatim (whitespace) — PGLM-1', async () => {
    expect(await textOf(target, 'j')).toBe(await textOf(source, 'j'));
  });
});
