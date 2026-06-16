import type { PGliteLike } from './types.js';

/** A PGlite instance opened on a data directory, with a close handle. */
export type OpenedCluster = PGliteLike & { close: () => Promise<void> };

/**
 * Open a data directory with the PGlite engine resolved from `modulePath`
 * (default: the peer `@electric-sql/pglite`).
 *
 * For a true cross-major migration the source and target must be opened with
 * two *different* engine versions — install them under npm aliases and pass the
 * alias names here (e.g. `openDataDir(dir, 'pglite-old')`). A new-major engine
 * cannot read an old-major data directory, which is precisely the gap this
 * library exists to bridge.
 *
 * @remarks
 * Reconstructing the target schema from an arbitrary source (the standalone,
 * no-host-app case) is not yet implemented — see the requirements docs. Until
 * then the CLI requires the target's schema to already exist.
 */
export async function openDataDir(
  dataDir: string,
  modulePath = '@electric-sql/pglite',
): Promise<OpenedCluster> {
  const mod: unknown = await import(modulePath);
  const PGlite = (mod as { PGlite?: new (dir: string) => OpenedCluster }).PGlite;
  if (typeof PGlite !== 'function') {
    throw new Error(`Module ${modulePath} does not export a PGlite constructor`);
  }
  return new PGlite(dataDir);
}
