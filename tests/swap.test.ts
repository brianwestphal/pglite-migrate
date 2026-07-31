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

  it('refuses when a retained-old directory already exists, leaving both sides intact', async () => {
    // Interleaved / repeated-swap: a prior swap (or a re-run with the same
    // timestamp) already left `<canonical>.old-<ts>` behind. The swap must
    // refuse rather than clobber it, and must not move the canonical aside.
    await makeCluster(canonical, 'old');
    const newDir = join(dir, 'pgdata.new');
    await makeCluster(newDir, 'new');
    const ts = '2026-06-16T12:00:00.000Z';
    const staleOld = `${canonical}.old-2026-06-16T12-00-00.000Z`;
    await makeCluster(staleOld, 'stale-old'); // a leftover retained-old cluster

    await expect(swapIntoPlace(canonical, newDir, { timestamp: ts })).rejects.toThrow(
      /Retained-old directory already exists/,
    );

    // The move-aside never fired: canonical still opens with its own data...
    expect(await readMarker(canonical)).toBe('old');
    // ...the pre-existing retained-old cluster was not touched...
    expect(await readMarker(staleOld)).toBe('stale-old');
    // ...and the staging dir is left untouched for a retry.
    expect(await readMarker(newDir)).toBe('new');
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

/**
 * Every case above starts from a fresh fixture. These drive `swapIntoPlace`
 * more than once against the same canonical location — the state only a prior
 * swap can produce (PGLM-90).
 */
describe('swapIntoPlace (sequential swaps)', () => {
  let dir: string;
  let canonical: string;
  let realRename: typeof fsp.rename;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof fsp>('node:fs/promises');
    realRename = actual.rename;
  });

  beforeEach(async () => {
    vi.mocked(fsp.rename).mockImplementation(realRename);
    dir = await mkdtemp(join(tmpdir(), 'pglite-migrate-swapseq-'));
    canonical = join(dir, 'pgdata');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Stage a fresh cluster at `<canonical>.new-<tag>` carrying `marker`. */
  async function stage(tag: string, marker: string): Promise<string> {
    const path = `${canonical}.new-${tag}`;
    await makeCluster(path, marker);
    return path;
  }

  it('swaps twice, retaining both displaced clusters independently', async () => {
    await makeCluster(canonical, 'v1');

    const first = await swapIntoPlace(canonical, await stage('a', 'v2'), {
      timestamp: '2026-06-16T12:00:00.000Z',
    });
    const second = await swapIntoPlace(canonical, await stage('b', 'v3'), {
      timestamp: '2026-06-17T12:00:00.000Z',
    });

    // Canonical holds the newest cluster.
    expect(await readMarker(canonical)).toBe('v3');
    // Both retained originals survive, each holding what it displaced. The
    // second swap must not clobber the first's rollback artifact.
    expect(first.previous).not.toBeNull();
    expect(second.previous).not.toBeNull();
    expect(await readMarker(first.previous as string)).toBe('v1');
    expect(await readMarker(second.previous as string)).toBe('v2');
  });

  it('refuses a second swap that lands on the same retained-old name', async () => {
    await makeCluster(canonical, 'v1');
    const sameSecond = '2026-06-16T12:00:00.000Z';

    await swapIntoPlace(canonical, await stage('a', 'v2'), { timestamp: sameSecond });
    const staged = await stage('b', 'v3');

    // Two swaps deriving the same `.old-<ts>` is the collision the guard exists
    // for; this reaches it the way a real run would, rather than by
    // pre-creating the directory.
    await expect(
      swapIntoPlace(canonical, staged, { timestamp: sameSecond }),
    ).rejects.toThrow(/Retained-old directory already exists/);

    // The first swap's result is intact and the second's staging is untouched.
    expect(await readMarker(canonical)).toBe('v2');
    expect(await readMarker(staged)).toBe('v3');
  });

  it('completes a retry after a failed swap restored the canonical cluster', async () => {
    await makeCluster(canonical, 'v1');
    const staged = await stage('a', 'v2');

    vi.mocked(fsp.rename).mockImplementation(async (src, dest) => {
      if (src === staged) throw Object.assign(new Error('transient'), { code: 'EIO' });
      return realRename(src, dest);
    });
    await expect(
      swapIntoPlace(canonical, staged, { timestamp: '2026-06-16T12:00:00.000Z' }),
    ).rejects.toThrow(/transient/);
    expect(await readMarker(canonical)).toBe('v1'); // restored

    // The retry runs against a canonical that was moved aside and back again.
    vi.mocked(fsp.rename).mockImplementation(realRename);
    const result = await swapIntoPlace(canonical, staged, {
      timestamp: '2026-06-17T12:00:00.000Z',
    });

    expect(await readMarker(canonical)).toBe('v2');
    expect(await readMarker(result.previous as string)).toBe('v1');
  });

  it('swaps again cleanly after keepOld:false left no retained sibling', async () => {
    await makeCluster(canonical, 'v1');

    const first = await swapIntoPlace(canonical, await stage('a', 'v2'), {
      keepOld: false,
      timestamp: '2026-06-16T12:00:00.000Z',
    });
    expect(first.previous).toBeNull();
    expect(await exists(`${canonical}.old-2026-06-16T12-00-00.000Z`)).toBe(false);

    // Second swap sees a canonical with no `.old` sibling — distinct from both
    // the fresh case and the retained case.
    const second = await swapIntoPlace(canonical, await stage('b', 'v3'), {
      timestamp: '2026-06-17T12:00:00.000Z',
    });

    expect(await readMarker(canonical)).toBe('v3');
    expect(await readMarker(second.previous as string)).toBe('v2');
  });
});
