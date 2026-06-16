import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDataDir } from '../src/loader.js';

describe('openDataDir', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pglite-migrate-loader-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('opens a data dir with the default engine and returns a queryable, closable cluster', async () => {
    const cluster = await openDataDir(join(dir, 'default'));
    try {
      const { rows } = await cluster.query<{ one: number }>('SELECT 1 AS one');
      expect(rows[0].one).toBe(1);
    } finally {
      await cluster.close();
    }
  });

  it('resolves an engine selected by npm-alias module path', async () => {
    const cluster = await openDataDir(join(dir, 'aliased'), 'pglite-old');
    try {
      const { rows } = await cluster.query<{ two: number }>('SELECT 2 AS two');
      expect(rows[0].two).toBe(2);
    } finally {
      await cluster.close();
    }
  });

  it('throws a clear error when the module lacks a PGlite constructor', async () => {
    await expect(openDataDir(join(dir, 'none'), 'node:path')).rejects.toThrow(
      /does not export a PGlite constructor/,
    );
  });
});
