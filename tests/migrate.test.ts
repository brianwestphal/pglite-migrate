import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from '../src/migrate.js';
import type { ProgressEvent } from '../src/types.js';
import { SCHEMA_SQL, SEED_SQL } from './helpers.js';

describe('migrate (orchestrator)', () => {
  let source: PGlite;
  let target: PGlite;

  beforeEach(() => {
    source = new PGlite();
    target = new PGlite();
  });

  afterEach(async () => {
    await source.close();
    await target.close();
  });

  it('reports totals, sequence count, and per-table progress in topological order', async () => {
    await source.exec(SCHEMA_SQL);
    await source.exec(SEED_SQL);
    await target.exec(SCHEMA_SQL);

    const events: ProgressEvent[] = [];
    const report = await migrate({ source, target, onProgress: (e) => events.push(e) });

    expect(report.warnings).toEqual([]);
    // totalRows is the sum of the per-table results.
    expect(report.totalRows).toBe(report.tables.reduce((n, t) => n + t.rowsCopied, 0));
    expect(report.totalRows).toBe(4);
    // Both serial sequences were advanced in the source, so both are realigned.
    expect(report.sequencesSet).toBe(2);
    // onProgress fires once per table, parents before children.
    expect(events.map((e) => e.table)).toEqual(['public.authors', 'public.books']);
  });

  it('warns (naming the cyclic tables) when the schema has a foreign-key cycle', async () => {
    const cyclic = `
      CREATE TABLE a (id integer PRIMARY KEY, b_id integer);
      CREATE TABLE b (id integer PRIMARY KEY, a_id integer);
      ALTER TABLE a ADD CONSTRAINT a_b_fk FOREIGN KEY (b_id) REFERENCES b(id);
      ALTER TABLE b ADD CONSTRAINT b_a_fk FOREIGN KEY (a_id) REFERENCES a(id);
    `;
    await source.exec(cyclic);
    await target.exec(cyclic);

    const report = await migrate({ source, target });

    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('public.a');
    expect(report.warnings[0]).toContain('public.b');
  });

  it('orders public-schema FKs even when alphabetical order would violate them', async () => {
    // Adversarial: parent "zoo", child "aaa" -> alphabetical (aaa, zoo) inserts
    // the child first and would violate the FK unless topo ordering kicks in.
    const ddl = `
      CREATE TABLE zoo (id integer PRIMARY KEY);
      CREATE TABLE aaa (id integer PRIMARY KEY, zoo_id integer REFERENCES zoo(id));
    `;
    await source.exec(ddl);
    await source.exec(`INSERT INTO zoo VALUES (1),(2); INSERT INTO aaa VALUES (10,1),(11,2);`);
    await target.exec(ddl);

    const report = await migrate({ source, target });

    expect(report.warnings).toEqual([]);
    expect(report.totalRows).toBe(4);
    const { rows } = await target.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM aaa',
    );
    expect(rows[0].count).toBe('2');
  });

  it('returns an empty report for an empty source schema', async () => {
    const report = await migrate({ source, target });

    expect(report).toEqual({
      tables: [],
      sequencesSet: 0,
      totalRows: 0,
      warnings: [],
    });
  });
});
