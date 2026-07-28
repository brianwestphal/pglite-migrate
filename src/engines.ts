/**
 * Engine acquisition — the opt-in path that downloads a pinned PGlite engine
 * instead of requiring the host to install one under an npm alias.
 *
 * This is published as a separate entry point (`pglite-migrate/engines`) because
 * it is the only part of the package that reaches the network. Importing
 * `pglite-migrate` itself never pulls this in, and nothing here runs unless a
 * caller explicitly asks for it.
 *
 * @packageDocumentation
 */
export {
  type AcquiredEngine,
  acquireEngine,
  type AcquireOptions,
  acquireRelease,
  defaultCacheDir,
  EngineFetchError,
  IntegrityError,
  resolveEntry,
} from './engines/acquire.js';
export { knownMajors, PGLITE_PACKAGE, resolveEngine, UnknownMajorError } from './engines/registry.js';
export { extractTarGz, safeEntryPath, TarError } from './engines/tar.js';
export type { EngineCacheMode, EngineRelease } from './types.js';
