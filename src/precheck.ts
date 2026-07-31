import { tryResolveEngine } from './engines/registry.js';
import type { PGliteLike } from './types.js';
import { readEngineMajor } from './version.js';

/** Options for {@link assertEngineMatchesDataDir}. */
export interface EngineCheckOptions {
  /** The data directory the engine was opened on (named in the message). */
  dataDir: string;
  /**
   * The major read from `PG_VERSION` **before** the engine opened the directory,
   * or `null` when there was none.
   *
   * It must be the pre-open value. An engine initializes a fresh directory at
   * its own major, so a `PG_VERSION` read afterwards always agrees with the
   * engine and would make this check vacuous.
   */
  expectedMajor: number | null;
  /** Which side of the migration this is — `source` or `target`. */
  side?: string;
  /** The engine specifier the caller named, for the message. */
  engine?: string;
}

/** Raised when an engine does not match the data directory it was opened on. */
export class EngineMismatchError extends Error {
  /** The directory whose major did not match. */
  readonly dataDir: string;
  /** The major stamped in the directory's `PG_VERSION`. */
  readonly expectedMajor: number;
  /** The engine's own major, or null when the engine refused to open at all. */
  readonly engineMajor: number | null;

  constructor(message: string, details: EngineMismatchDetails) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'EngineMismatchError';
    this.dataDir = details.dataDir;
    this.expectedMajor = details.expectedMajor;
    this.engineMajor = details.engineMajor;
  }
}

interface EngineMismatchDetails {
  dataDir: string;
  expectedMajor: number;
  engineMajor: number | null;
  cause?: unknown;
}

/** Name the engine version that *would* serve this major, when we know one. */
function remedy(expectedMajor: number, engine: string | undefined): string {
  const alias = engine ?? 'pglite-old';
  const pinned = tryResolveEngine(expectedMajor)?.version ?? null;
  if (pinned === null) {
    return `Open it with an engine that bundles PostgreSQL ${expectedMajor.toString()}.`;
  }
  return (
    `Open it with an engine that bundles PostgreSQL ${expectedMajor.toString()}, e.g.\n` +
    `  npm install ${alias}@npm:@electric-sql/pglite@${pinned}\n` +
    `…or pass --fetch-missing-engine (library: fetchMissingEngine) to acquire it automatically.`
  );
}

/**
 * Verify that an opened engine actually serves the data directory it was given.
 *
 * A PGlite engine pointed at a directory written by a different major does not
 * fail when it is constructed — it fails on the *first query*, with an opaque
 * `PGlite failed to initialize properly` that names neither major, neither the
 * directory, nor the engine. This turns the most likely misconfiguration into a
 * diagnostic that says what is wrong and what to install.
 *
 * When `expectedMajor` is null the check is skipped and **no query is issued**,
 * so a directory that does not exist yet is never booted into existence as a
 * side effect of checking it.
 *
 * @param db - The opened engine.
 * @param options - See {@link EngineCheckOptions}.
 * @returns The engine's major, or null when the check was skipped.
 * @throws {@link EngineMismatchError} when the majors disagree, or when the
 * engine cannot open the directory at all.
 */
export async function assertEngineMatchesDataDir(
  db: PGliteLike,
  options: EngineCheckOptions,
): Promise<number | null> {
  const { dataDir, expectedMajor, side, engine } = options;
  if (expectedMajor === null) return null;

  const what = [side, 'data directory'].filter(Boolean).join(' ');
  const named = engine === undefined ? '' : ` ("${engine}")`;

  let engineMajor: number;
  try {
    engineMajor = await readEngineMajor(db);
  } catch (err) {
    throw new EngineMismatchError(
      `The ${what} ${dataDir} is PostgreSQL ${expectedMajor.toString()}, ` +
        `but the engine opened for it${named} could not read it.\n` +
        `This usually means the engine bundles a different PostgreSQL major.\n` +
        remedy(expectedMajor, engine),
      { dataDir, expectedMajor, engineMajor: null, cause: err },
    );
  }

  if (engineMajor !== expectedMajor) {
    throw new EngineMismatchError(
      `The ${what} ${dataDir} is PostgreSQL ${expectedMajor.toString()}, ` +
        `but the engine opened for it${named} is PostgreSQL ${engineMajor.toString()}.\n` +
        remedy(expectedMajor, engine),
      { dataDir, expectedMajor, engineMajor },
    );
  }
  return engineMajor;
}
