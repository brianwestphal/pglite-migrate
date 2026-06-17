import { cp, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Options for {@link backupDataDir}. */
export interface BackupOptions {
  /** Override the backup directory path. Default: `<dataDir>.bak-<timestamp>`. */
  backupDir?: string;
  /** Override the timestamp used in the default backup name (ISO-8601). */
  timestamp?: string;
  /**
   * Retention bound: after a successful backup, prune the oldest timestamped
   * `<dataDir>.bak-*` siblings so at most `keep` remain. The current run's backup
   * is always retained. Omit (default) to keep all backups.
   */
  keep?: number;
}

/** Recursively count files and total bytes under a directory. */
async function dirStats(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await dirStats(full);
      files += sub.files;
      bytes += sub.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += (await stat(full)).size;
    }
  }
  return { files, bytes };
}

/** True if a path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy a PGlite/PostgreSQL data directory to a timestamped sibling so a failed
 * or unsatisfactory migration can be rolled back. The source is only read,
 * never mutated.
 *
 * The copy is written to a `.partial` directory first, then renamed into place,
 * so an interrupted backup never looks complete. After the rename the backup is
 * verified: its `PG_VERSION` must match the source (when the source has one) and
 * its recursive file and byte counts must match.
 *
 * When `options.keep` is set, the oldest timestamped `<dataDir>.bak-*` siblings
 * are pruned afterward so at most `keep` remain (the current run's backup is
 * always retained).
 *
 * @returns the path of the verified backup directory.
 * @throws if the backup directory already exists or verification fails.
 */
export async function backupDataDir(dataDir: string, options: BackupOptions = {}): Promise<string> {
  const timestamp = (options.timestamp ?? new Date().toISOString()).replace(/:/g, '-');
  const backupDir = options.backupDir ?? `${dataDir}.bak-${timestamp}`;
  const partial = `${backupDir}.partial`;

  if (await exists(backupDir)) {
    throw new Error(`Backup directory already exists: ${backupDir}`);
  }
  await rm(partial, { recursive: true, force: true }); // clear any stale partial
  await cp(dataDir, partial, { recursive: true });
  await rename(partial, backupDir);

  // Verify the backup is complete.
  const sourceVersion = await readFile(join(dataDir, 'PG_VERSION'), 'utf8').catch(() => null);
  if (sourceVersion !== null) {
    const backupVersion = await readFile(join(backupDir, 'PG_VERSION'), 'utf8').catch(() => null);
    if (backupVersion === null || backupVersion.trim() !== sourceVersion.trim()) {
      throw new Error(`Backup verification failed: PG_VERSION mismatch for ${backupDir}`);
    }
  }
  const src = await dirStats(dataDir);
  const bak = await dirStats(backupDir);
  if (src.files !== bak.files || src.bytes !== bak.bytes) {
    throw new Error(
      `Backup verification failed: ${backupDir} has ${bak.files.toString()} files/${bak.bytes.toString()} bytes, ` +
        `source has ${src.files.toString()}/${src.bytes.toString()}`,
    );
  }

  if (options.keep !== undefined) await pruneBackups(dataDir, backupDir, options.keep);
  return backupDir;
}

/**
 * Prune the oldest timestamped `<dataDir>.bak-*` siblings so at most `keep`
 * remain. The current run's backup is never removed, even if `keep` would
 * otherwise exclude it. Names are sorted lexicographically, which matches
 * chronological order for the sanitized ISO-8601 timestamps used in the names.
 */
async function pruneBackups(dataDir: string, currentBackup: string, keep: number): Promise<void> {
  const parent = dirname(dataDir);
  const prefix = `${basename(dataDir)}.bak-`;
  const entries = await readdir(parent);
  const backups = entries
    .filter((e) => e.startsWith(prefix) && !e.endsWith('.partial'))
    .sort(); // oldest first
  const current = basename(currentBackup);
  // Everything older than the newest `keep` is excess.
  const excess = backups.slice(0, Math.max(0, backups.length - Math.max(0, keep)));
  for (const name of excess) {
    if (name === current) continue; // never delete the current run's backup
    await rm(join(parent, name), { recursive: true, force: true });
  }
}
