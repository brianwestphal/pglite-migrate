import * as fsp from 'node:fs/promises';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir, removeTempDir } from './tempdir.js';

// Same technique as backup/swap: mock the module, pass through by default.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsp>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

describe('removeTempDir', () => {
  afterEach(async () => {
    const actual = await vi.importActual<typeof fsp>('node:fs/promises');
    vi.mocked(fsp.rm).mockImplementation(actual.rm);
  });

  it('removes a populated tree', async () => {
    const dir = await makeTempDir('pglite-migrate-tdtest-');
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(join(dir, 'nested', 'f.txt'), 'x');

    await removeTempDir(dir);

    await expect(readdir(dir)).rejects.toThrow();
  });

  it('asks fs.rm to retry the error class a still-writing cluster produces', async () => {
    // ENOTEMPTY is what `rm` throws when a directory repopulates mid-walk —
    // which is what a timed-out test's PGlite instance does while afterEach
    // runs. Node retries exactly this class when asked, so assert we ask.
    const dir = await makeTempDir('pglite-migrate-tdtest-');

    await removeTempDir(dir);

    const [path, opts] = vi.mocked(fsp.rm).mock.calls.at(-1) ?? [];
    expect(path).toBe(dir);
    expect(opts?.recursive).toBe(true);
    expect(opts?.force).toBe(true);
    expect(opts?.maxRetries).toBeGreaterThan(0);
  });

  it('never throws, so cleanup cannot fail a test or bury the real error', async () => {
    // The regression this guards: a timed-out test used to surface twice — once
    // as the genuine timeout, then again as an ENOTEMPTY from teardown, and the
    // second buried the first.
    vi.mocked(fsp.rm).mockRejectedValue(
      Object.assign(new Error('ENOTEMPTY: directory not empty'), { code: 'ENOTEMPTY' }),
    );

    await expect(removeTempDir('/some/path/that/will/fail')).resolves.toBeUndefined();
  });
});
