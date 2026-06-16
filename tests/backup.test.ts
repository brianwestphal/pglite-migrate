import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { backupDataDir } from '../src/backup.js';

describe('backupDataDir', () => {
  let dir: string;
  let dataDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pglite-migrate-backup-'));
    dataDir = join(dir, 'pgdata');
    await mkdir(join(dataDir, 'base'), { recursive: true });
    await writeFile(join(dataDir, 'PG_VERSION'), '17\n');
    await writeFile(join(dataDir, 'postgresql.conf'), 'shared_buffers = 128MB\n');
    await writeFile(join(dataDir, 'base', '1.dat'), 'some bytes');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('copies the data dir to a verified, timestamped sibling and leaves the source intact', async () => {
    const backup = await backupDataDir(dataDir, { timestamp: '2026-06-16T12:00:00.000Z' });

    // Default name: sanitized timestamp, colons replaced.
    expect(backup).toBe(`${dataDir}.bak-2026-06-16T12-00-00.000Z`);
    expect((await readFile(join(backup, 'PG_VERSION'), 'utf8')).trim()).toBe('17');
    expect(await readFile(join(backup, 'base', '1.dat'), 'utf8')).toBe('some bytes');

    // No leftover .partial directory.
    await expect(stat(`${backup}.partial`)).rejects.toThrow();
    // Source is untouched.
    expect((await readFile(join(dataDir, 'PG_VERSION'), 'utf8')).trim()).toBe('17');
  });

  it('writes to an explicit backupDir when given', async () => {
    const dest = join(dir, 'mybackup');
    const backup = await backupDataDir(dataDir, { backupDir: dest });
    expect(backup).toBe(dest);
    expect(await readFile(join(dest, 'postgresql.conf'), 'utf8')).toContain('shared_buffers');
  });

  it('refuses to clobber an existing backup directory', async () => {
    const dest = join(dir, 'taken');
    await mkdir(dest);
    await expect(backupDataDir(dataDir, { backupDir: dest })).rejects.toThrow(/already exists/);
  });
});
