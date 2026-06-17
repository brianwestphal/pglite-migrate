import * as fsp from 'node:fs/promises';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { swapIntoPlace } from '../src/swap.js';

// ESM module namespaces are non-configurable, so vi.spyOn can't intercept
// node:fs/promises. Mock the module instead, making `rename` a vi.fn that
// passes through to the real implementation unless a test overrides it.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsp>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

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
  let realRename: typeof fsp.rename;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof fsp>('node:fs/promises');
    realRename = actual.rename;
  });

  beforeEach(async () => {
    vi.mocked(fsp.rename).mockImplementation(realRename); // reset to passthrough
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

  it('restores the canonical cluster and reports a cross-filesystem (EXDEV) move clearly', async () => {
    await makeCluster(canonical, 'old');
    const newDir = join(dir, 'pgdata.new');
    await makeCluster(newDir, 'new');

    // Fail only the forward move (newDir -> canonical) with an EXDEV code; the
    // move-aside and the restore (both have a different source) run for real.
    vi.mocked(fsp.rename).mockImplementation(async (src, dest) => {
      if (src === newDir) throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
      return realRename(src, dest);
    });

    const ts = '2026-06-16T12:00:00.000Z';
    await expect(swapIntoPlace(canonical, newDir, { timestamp: ts })).rejects.toThrow(
      /different filesystem/,
    );

    // The original was moved back, so canonical still opens with its old data...
    expect(await readMarker(canonical)).toBe('old');
    // ...the retained-old path was undone, and the staging dir is left for retry.
    expect(await exists(`${canonical}.old-2026-06-16T12-00-00.000Z`)).toBe(false);
    expect(await exists(newDir)).toBe(true);
  });

  it('restores the canonical cluster and rethrows a non-EXDEV swap failure', async () => {
    await makeCluster(canonical, 'old');
    const newDir = join(dir, 'pgdata.new');
    await makeCluster(newDir, 'new');

    vi.mocked(fsp.rename).mockImplementation(async (src, dest) => {
      if (src === newDir) throw Object.assign(new Error('disk on fire'), { code: 'EIO' });
      return realRename(src, dest);
    });

    await expect(
      swapIntoPlace(canonical, newDir, { timestamp: '2026-06-16T12:00:00.000Z' }),
    ).rejects.toThrow(/disk on fire/);

    // A generic failure is rethrown verbatim, and canonical is still restored.
    expect(await readMarker(canonical)).toBe('old');
  });
});
