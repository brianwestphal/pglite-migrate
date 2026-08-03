import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import { tryResolveEngine } from './engines/registry.js';
import { errorCode } from './fsutil.js';
import type { EngineCacheMode, EngineRelease, PGliteLike } from './types.js';
import { readClusterVersion } from './version.js';

/** A PGlite instance opened on a data directory, with a close handle. */
export type OpenedCluster = PGliteLike & {
  close: () => Promise<void>;
  /**
   * Present only when the engine was acquired over the network rather than
   * resolved from `node_modules`. `close()` releases it (a no-op under the
   * `keep` cache mode).
   */
  acquired?: { version: string; fromCache: boolean };
};

/** Options for {@link openDataDir}. */
export interface OpenOptions {
  /**
   * When the engine module cannot be resolved, download a pinned engine
   * matching the data directory's Postgres major instead of failing.
   *
   * Off by default, and deliberately so: acquiring an engine downloads and then
   * executes ~9 MB from the npm registry, which no library should do behind its
   * caller's back.
   */
  fetchMissingEngine?: boolean;
  /** Retention for an acquired engine. Defaults to `keep`. */
  cache?: EngineCacheMode;
  /** Override the directory acquired engines are stored under. */
  cacheDir?: string;
  /** Override the npm registry base URL (used by tests). */
  registryUrl?: string;
  /**
   * Postgres major to acquire, when it cannot be read from `dataDir` — for a
   * target directory that does not exist yet, for instance.
   */
  major?: number;
  /**
   * Acquire this exact release instead of looking one up by major. For callers
   * that already know the engine version they want.
   */
  release?: EngineRelease;
  /**
   * Options forwarded verbatim to the PGlite constructor as its second
   * argument, on both the resolved and the acquired path.
   *
   * The motivating case is `{ database: 'template1' }`: PGlite 0.4.0 changed
   * the default working database from `template1` to `postgres`, so a cluster
   * written by an older PGlite has its tables in a database that a bare
   * `new PGlite(dir)` does not open — every query then fails with
   * `relation "…" does not exist` even though the data is intact. The same gap
   * applies to anything else PGlite accepts (`relaxedDurability`, `extensions`,
   * `debug`, …).
   *
   * Deliberately a distinct key rather than spreading {@link OpenOptions}
   * itself: this library's own options and PGlite's cannot then collide, and
   * which is which stays obvious at the call site. Typed loosely on purpose —
   * the core never imports `@electric-sql/pglite`, and the accepted options
   * differ between the two engine versions a cross-major run holds open at
   * once. PGlite ignores keys it does not know.
   */
  pgliteOptions?: Record<string, unknown>;
}

/** Node error codes that mean "this specifier does not resolve". */
const UNRESOLVED_CODES = new Set([
  'ERR_MODULE_NOT_FOUND',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_UNSUPPORTED_DIR_IMPORT',
]);

/**
 * True when `err` means `specifier` itself could not be resolved.
 *
 * The specifier has to appear in the message: a module that resolves fine but
 * fails on one of *its own* imports raises the same code, and silently
 * downloading a replacement for it would bury the real error.
 */
function isUnresolvedModule(err: unknown, specifier: string): boolean {
  if (!(err instanceof Error)) return false;
  const code = errorCode(err);
  if (code === undefined || !UNRESOLVED_CODES.has(code)) return false;
  return err.message.includes(specifier);
}

/**
 * Import a module specifier, routing absolute paths through a `file://` URL.
 *
 * A bare `import('/abs/path.js')` happens to work on POSIX but not on Windows,
 * and acquired engines are always absolute paths.
 */
async function importEngine(modulePath: string): Promise<unknown> {
  const specifier = isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath;
  return import(specifier);
}

/** The PGlite constructor shape this module needs: a data dir plus opaque options. */
type PGliteConstructor = new (dir: string, options?: Record<string, unknown>) => OpenedCluster;

/** Pull the `PGlite` constructor out of an imported module. */
function constructorFrom(mod: unknown, modulePath: string): PGliteConstructor {
  const PGlite = (mod as { PGlite?: PGliteConstructor }).PGlite;
  if (typeof PGlite !== 'function') {
    throw new Error(`Module ${modulePath} does not export a PGlite constructor`);
  }
  return PGlite;
}

/**
 * Construct the engine, forwarding {@link OpenOptions.pgliteOptions} when the
 * caller supplied any.
 *
 * The no-options case calls the constructor with a single argument rather than
 * passing an explicit `undefined`, so omitting `pgliteOptions` is byte-identical
 * to the previous `new PGlite(dataDir)` and cannot perturb an engine that
 * distinguishes "no options object" from "an empty one".
 */
function construct(
  mod: unknown,
  modulePath: string,
  dataDir: string,
  pgliteOptions: Record<string, unknown> | undefined,
): OpenedCluster {
  const Engine = constructorFrom(mod, modulePath);
  return pgliteOptions === undefined ? new Engine(dataDir) : new Engine(dataDir, pgliteOptions);
}

/** Build the error shown when an engine is missing and acquisition is off. */
async function missingEngineError(
  modulePath: string,
  dataDir: string,
  cause: unknown,
): Promise<Error> {
  const major = await readClusterVersion(dataDir).catch(() => null);
  const lines = [`Could not load the PGlite engine "${modulePath}".`];
  if (major !== null) {
    lines.push(`${dataDir} is a PostgreSQL ${major.toString()} data directory.`);
    const pinned = tryResolveEngine(major)?.version ?? null;
    if (pinned !== null) {
      lines.push(
        `Install a matching engine:`,
        `  npm install ${modulePath}@npm:@electric-sql/pglite@${pinned}`,
        `…or pass fetchMissingEngine (CLI: --fetch-missing-engine) to download it automatically.`,
      );
    } else {
      lines.push(`No engine is pinned for PostgreSQL ${major.toString()}; install one yourself.`);
    }
  } else {
    lines.push(`Install it, or pass fetchMissingEngine to download a pinned engine automatically.`);
  }
  return new Error(lines.join('\n'), { cause });
}

/**
 * Open a data directory with the PGlite engine resolved from `modulePath`
 * (default: the peer `@electric-sql/pglite`).
 *
 * For a true cross-major migration the source and target must be opened with
 * two *different* engine versions. Either install them under npm aliases and
 * pass the alias names here (e.g. `openDataDir(dir, 'pglite-old')`), or set
 * `fetchMissingEngine` to have the matching engine downloaded on demand — the
 * common case being a host app that bundles only the version it was built
 * against and has no copy of the old one the data was written by.
 *
 * Resolution is always tried first: an installed engine wins, and acquisition
 * only happens when the specifier does not resolve at all.
 *
 * Pass {@link OpenOptions.pgliteOptions} to reach PGlite's own constructor
 * options — most often `{ database: 'template1' }` for a cluster written before
 * PGlite 0.4.0 moved the default working database.
 *
 * @param dataDir - Path to the PGlite data directory to open.
 * @param modulePath - npm specifier, alias, or absolute path of the engine.
 * @param options - Acquisition, caching, and engine-construction behavior; see
 * {@link OpenOptions}.
 * @throws When the engine cannot be loaded, with the install command and the
 * opt-in flag spelled out.
 */
export async function openDataDir(
  dataDir: string,
  modulePath = '@electric-sql/pglite',
  options: OpenOptions = {},
): Promise<OpenedCluster> {
  let mod: unknown;
  try {
    mod = await importEngine(modulePath);
  } catch (err) {
    if (!isUnresolvedModule(err, modulePath)) throw err;
    if (options.fetchMissingEngine !== true) {
      throw await missingEngineError(modulePath, dataDir, err);
    }
    return openAcquired(dataDir, options);
  }
  return construct(mod, modulePath, dataDir, options.pgliteOptions);
}

/**
 * Acquire a pinned engine for the data directory's major and open with it.
 *
 * The acquisition module is imported dynamically so that the network code is
 * never even loaded unless a caller opts in.
 */
async function openAcquired(dataDir: string, options: OpenOptions): Promise<OpenedCluster> {
  const { acquireEngine, acquireRelease } = await import('./engines/acquire.js');
  const acquireOptions: Parameters<typeof acquireEngine>[1] = {};
  if (options.cache !== undefined) acquireOptions.cache = options.cache;
  if (options.cacheDir !== undefined) acquireOptions.cacheDir = options.cacheDir;
  if (options.registryUrl !== undefined) acquireOptions.registryUrl = options.registryUrl;

  const engine =
    options.release !== undefined
      ? await acquireRelease(options.release, acquireOptions)
      : await acquireEngine(options.major ?? (await readClusterVersion(dataDir)), acquireOptions);
  const mod = await importEngine(engine.entry);
  const cluster = construct(mod, engine.entry, dataDir, options.pgliteOptions);

  // Closing the cluster releases the engine too, so an ephemeral copy is cleaned
  // up by the same `finally` a caller already writes around `close()`.
  const close = cluster.close.bind(cluster);
  cluster.close = async () => {
    try {
      await close();
    } finally {
      await engine.cleanup();
    }
  };
  cluster.acquired = { version: engine.release.version, fromCache: engine.fromCache };
  return cluster;
}
