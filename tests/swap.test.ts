import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { swapIntoPlace } from '../src/swap.js';

/** Create a file-backed PGlite cluster at `dir` carrying a single marker row. */
async function makeCluster(dir: string, marker: string): Promise<void> {
  const db = new PGlite(dir);
  await db.exec(`CREATE TABLE marker (v text)`);
  await db.query(`INSERT INTO marker (v) VALUES ($1)`, [marker]);
  await db.close();
}

/** Read the marker row from a cluster directory. */
async function readMarker(dir: string): Promise<string> {
  const db = new PGlite(dir);
  try {
    const { rows } = await db.query<{ v: string }>(`SELECT v FROM marker`);
    return rows[0].v;
  } finally {
    await db.close();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('swapIntoPlace', () => {
  let dir: string;
  let canonical: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pglite-migrate-swap-'));
    canonical = join(dir, 'pgdata');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('swaps the new cluster into place and retains the previous one', async () => {
    await makeCluster(canonical, 'old');
    const newDir = join(dir, 'pgdata.new');
    await makeCluster(newDir, 'new');

    const result = await swapIntoPlace(canonical, newDir, { timestamp: '2026-06-16T12:00:00.000Z' });

    // Canonical now holds the new cluster and is openable.
    expect(await readMarker(canonical)).toBe('new');
    expect(result.previous).toBe(`${canonical}.old-2026-06-16T12-00-00.000Z`);
    expect(result.previous).not.toBeNull();
    expect(await readMarker(result.previous as string)).toBe('old');
    // The staging directory was consumed.
    expect(await exists(newDir)).toBe(false);
  });

  it('keepOld:false removes the displaced previous cluster', async () => {
    await makeCluster(canonical, 'old');
    const newDir = join(dir, 'pgdata.new');
    await makeCluster(newDir, 'new');

    const result = await swapIntoPlace(canonical, newDir, { keepOld: false });

    expect(result.previous).toBeNull();
    expect(await readMarker(canonical)).toBe('new');
  });

  it('moves into a fresh canonical location when none existed', async () => {
    const newDir = join(dir, 'pgdata.new');
    await makeCluster(newDir, 'new');

    const result = await swapIntoPlace(canonical, newDir);

    expect(result.previous).toBeNull();
    expect(await readMarker(canonical)).toBe('new');
  });

  it('leaves the canonical cluster intact and openable when the new cluster is missing', async () => {
    await makeCluster(canonical, 'old');

    await expect(swapIntoPlace(canonical, join(dir, 'does-not-exist'))).rejects.toThrow(
      /does not exist/,
    );

    // The canonical location was never touched and still opens.
    expect(await readMarker(canonical)).toBe('old');
  });
});
