import * as fsp from 'node:fs/promises';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { backupDataDir } from '../src/backup.js';

// ESM module namespaces are non-configurable, so vi.spyOn can't intercept
// node:fs/promises. Mock the module instead, making `cp` a vi.fn that passes
// through to the real implementation unless a test overrides it.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsp>();
  return { ...actual, cp: vi.fn(actual.cp) };
});

describe('backupDataDir', () => {
  let dir: string;
  let dataDir: string;
  let realCp: typeof fsp.cp;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof fsp>('node:fs/promises');
    realCp = actual.cp;
  });

  beforeEach(async () => {
    vi.mocked(fsp.cp).mockImplementation(realCp); // reset to passthrough
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

  it('keep prunes the oldest timestamped backups beyond n, retaining the current run', async () => {
    const ts = (day: string) => `2026-06-${day}T12:00:00.000Z`;
    await backupDataDir(dataDir, { timestamp: ts('14') });
    await backupDataDir(dataDir, { timestamp: ts('15') });
    await backupDataDir(dataDir, { timestamp: ts('16') });
    const current = await backupDataDir(dataDir, { timestamp: ts('17'), keep: 2 });

    const remaining = (await readdir(dir)).filter((e) => e.startsWith('pgdata.bak-')).sort();
    // The two oldest (14, 15) are pruned; the newest two (16 + current 17) remain.
    expect(remaining).toEqual([
      'pgdata.bak-2026-06-16T12-00-00.000Z',
      'pgdata.bak-2026-06-17T12-00-00.000Z',
    ]);
    expect(basename(current)).toBe('pgdata.bak-2026-06-17T12-00-00.000Z');
  });

  it('never deletes the current run backup even when keep would exclude it', async () => {
    const ts = (day: string) => `2026-06-${day}T12:00:00.000Z`;
    await backupDataDir(dataDir, { timestamp: ts('16') });
    await backupDataDir(dataDir, { timestamp: ts('17') });
    // The current backup uses an OLDER timestamp and keep=1: it sorts as excess
    // but the prune must force-retain it, so two dirs survive (current + newest).
    await backupDataDir(dataDir, { timestamp: ts('15'), keep: 1 });

    const remaining = (await readdir(dir)).filter((e) => e.startsWith('pgdata.bak-')).sort();
    expect(remaining).toEqual([
      'pgdata.bak-2026-06-15T12-00-00.000Z',
      'pgdata.bak-2026-06-17T12-00-00.000Z',
    ]);
  });

  it('fails verification when the backup PG_VERSION does not match the source', async () => {
    // Corrupt PG_VERSION in the staged copy after it lands, so the copy is
    // otherwise complete but its version no longer matches the source.
    vi.mocked(fsp.cp).mockImplementation(async (src, dest, opts) => {
      await realCp(src, dest, opts);
      await writeFile(join(String(dest), 'PG_VERSION'), '999\n');
    });

    await expect(
      backupDataDir(dataDir, { timestamp: '2026-06-16T12:00:00.000Z' }),
    ).rejects.toThrow(/PG_VERSION mismatch/);
  });

  it('fails verification when the backup file/byte counts do not match the source', async () => {
    // Drop a non-PG_VERSION file from the staged copy: PG_VERSION still matches,
    // but the recursive file/byte counts diverge from the source.
    vi.mocked(fsp.cp).mockImplementation(async (src, dest, opts) => {
      await realCp(src, dest, opts);
      await rm(join(String(dest), 'postgresql.conf'), { force: true });
    });

    await expect(
      backupDataDir(dataDir, { timestamp: '2026-06-16T12:00:00.000Z' }),
    ).rejects.toThrow(/verification failed/);
  });
});
