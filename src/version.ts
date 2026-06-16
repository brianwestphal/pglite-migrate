import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Read the PostgreSQL major version stamped into a data directory.
 *
 * Every PGDATA directory (PGlite's included) contains a `PG_VERSION` file whose
 * sole content is the cluster's major version (e.g. `17`). Reading it tells us
 * whether a migration is even needed — and, eventually, which old engine to
 * load — without booting the cluster.
 *
 * @param dataDir - Path to a PGlite/PostgreSQL data directory.
 * @returns The major version as an integer.
 * @throws If `PG_VERSION` is missing or unparseable.
 */
export async function readClusterVersion(dataDir: string): Promise<number> {
  const file = join(dataDir, 'PG_VERSION');
  const raw = await readFile(file, 'utf8');
  const major = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(major)) {
    throw new Error(`Could not parse a major version from ${file} (got ${JSON.stringify(raw)})`);
  }
  return major;
}
