import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { introspectSchema } from '../src/introspect.js';
import { SCHEMA_SQL, SEED_SQL } from './helpers.js';

describe('introspectSchema', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(SCHEMA_SQL);
    await db.exec(SEED_SQL);
  });

  afterEach(async () => {
    await db.close();
  });

  it('lists user tables with their columns in order', async () => {
    const schema = await introspectSchema(db);

    const names = schema.tables.map((t) => t.name).sort();
    expect(names).toEqual(['authors', 'books']);

    const books = schema.tables.find((t) => t.name === 'books');
    expect(books?.columns.map((c) => c.name)).toEqual([
      'id',
      'author_id',
      'title',
      'published_at',
    ]);
    const publishedAt = books?.columns.find((c) => c.name === 'published_at');
    expect(publishedAt?.type).toContain('timestamp');
  });

  it('detects the books -> authors foreign key', async () => {
    const schema = await introspectSchema(db);

    expect(schema.foreignKeys).toContainEqual({
      child: 'public.books',
      parent: 'public.authors',
    });
  });

  it('captures advanced sequences', async () => {
    const schema = await introspectSchema(db);

    const authorsSeq = schema.sequences.find((s) => s.name === 'authors_id_seq');
    expect(authorsSeq).toBeDefined();
    expect(Number(authorsSeq?.lastValue)).toBe(2);
  });
});
