import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PGliteLike } from './types.js';

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

/**
 * Ask a running engine which PostgreSQL major it *is*.
 *
 * The counterpart to {@link readClusterVersion}: that reads what is on disk,
 * this reads what the engine bundles. Comparing the two is what catches an
 * engine pointed at a directory it cannot serve.
 *
 * Booting the engine is a side effect — PGlite initializes lazily, so this is
 * the first thing that actually starts the cluster.
 *
 * @param db - An opened engine.
 * @returns The engine's major version.
 * @throws If the engine cannot answer (notably when it refuses to open the data
 * directory at all).
 */
export async function readEngineMajor(db: PGliteLike): Promise<number> {
  const { rows } = await db.query<{ v: string }>('SELECT current_setting($1) AS v', [
    'server_version',
  ]);
  const raw = rows[0]?.v ?? '';
  // `parseInt` stops at the first non-digit, which is what makes a development
  // build's `15devel` read as 15 — the same tolerance readClusterVersion relies on.
  const major = Number.parseInt(raw, 10);
  if (!Number.isInteger(major)) {
    throw new Error(`Could not parse a major version from server_version (got ${JSON.stringify(raw)})`);
  }
  return major;
}
