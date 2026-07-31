import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { exists } from '../fsutil.js';
import type { EngineCacheMode, EngineRelease } from '../types.js';
import { PGLITE_PACKAGE, resolveEngine } from './registry.js';
import { extractTarGz } from './tar.js';

/** Default npm registry base URL. */
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** Entry point used when a package manifest names nothing usable. */
const FALLBACK_ENTRY = 'dist/index.js';

/** Options for {@link acquireEngine}. */
export interface AcquireOptions {
  /** Retention policy. Defaults to `keep`. */
  cache?: EngineCacheMode;
  /**
   * Override the directory engines are stored under. For `keep` this is the
   * shared cache root; for `ephemeral` it is the parent of the temporary
   * directory. Defaults to an OS-appropriate cache path / the system temp dir.
   */
  cacheDir?: string;
  /** Override the npm registry base URL (used by tests). */
  registryUrl?: string;
}

/** An engine that has been made available on disk and is ready to import. */
export interface AcquiredEngine {
  /** Absolute path to the module entry point — pass this to `openDataDir`. */
  entry: string;
  /** Absolute path to the extracted package root. */
  dir: string;
  /** The pinned release that was acquired. */
  release: EngineRelease;
  /** True when an existing cache entry was reused and nothing was downloaded. */
  fromCache: boolean;
  /** Remove the extracted engine. A no-op under `keep`. */
  cleanup: () => Promise<void>;
}

/** Raised when the engine tarball could not be downloaded. */
export class EngineFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EngineFetchError';
  }
}

/** Raised when a downloaded tarball does not match its pinned hash. */
export class IntegrityError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
    readonly version: string,
  ) {
    super(
      `Integrity check failed for ${PGLITE_PACKAGE}@${version}: ` +
        `expected ${expected}, got ${actual}. The download was discarded and nothing was written. ` +
        `This means the bytes served did not match the hash pinned in this build of pglite-migrate.`,
    );
    this.name = 'IntegrityError';
  }
}

/**
 * OS-appropriate cache root for extracted engines.
 *
 * `platform` and `env` are parameters rather than direct `process` reads so the
 * Windows and Linux branches are testable from any host — otherwise two thirds
 * of this function would only ever run in CI on another OS.
 */
export function defaultCacheDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const parts = ['pglite-migrate', 'engines'];
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(local, ...parts);
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Caches', ...parts);
  }
  const xdg = env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
  return join(xdg, ...parts);
}

/** Tarball URL for a version, following npm's scoped-package layout. */
function tarballUrl(version: string, registryUrl: string): string {
  const unscoped = PGLITE_PACKAGE.split('/').pop() ?? PGLITE_PACKAGE;
  return `${registryUrl.replace(/\/+$/, '')}/${PGLITE_PACKAGE}/-/${unscoped}-${version}.tgz`;
}

/** Download a tarball, turning transport failures into an actionable error. */
async function download(url: string, version: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new EngineFetchError(
      `Could not reach the npm registry to download ${PGLITE_PACKAGE}@${version} (${url}). ` +
        `If this machine is offline or behind a proxy, install the engine yourself instead: ` +
        `npm install pglite-old@npm:${PGLITE_PACKAGE}@${version}`,
      { cause: err },
    );
  }
  if (!response.ok) {
    throw new EngineFetchError(
      `Registry returned ${response.status.toString()} ${response.statusText} for ${url}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Verify downloaded bytes against the pinned hash before anything is written. */
function verifyIntegrity(bytes: Buffer, release: EngineRelease): void {
  const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (actual !== release.integrity) {
    throw new IntegrityError(release.integrity, actual, release.version);
  }
}

/** The subset of a package manifest we read. Untrusted — validate, never assert. */
interface PackageManifest {
  main?: unknown;
  module?: unknown;
  exports?: unknown;
}

/** Pull a plausible ESM entry path out of an untrusted manifest. */
function manifestEntryCandidates(manifest: PackageManifest): string[] {
  const candidates: string[] = [];
  const dot = (manifest.exports as Record<string, unknown> | undefined)?.['.'];
  if (typeof dot === 'string') {
    candidates.push(dot);
  } else if (dot !== null && typeof dot === 'object') {
    const imp = (dot as Record<string, unknown>).import;
    if (typeof imp === 'string') candidates.push(imp);
  }
  if (typeof manifest.module === 'string') candidates.push(manifest.module);
  if (typeof manifest.main === 'string') candidates.push(manifest.main);
  candidates.push(FALLBACK_ENTRY);
  return candidates;
}

/**
 * Resolve the module entry point inside an extracted package.
 *
 * The manifest comes out of a downloaded archive, so it is a trust boundary:
 * fields are read and validated, never assumed, and a candidate that resolves
 * outside the package directory is discarded.
 */
export async function resolveEntry(dir: string): Promise<string> {
  const root = resolve(dir);
  let manifest: PackageManifest = {};
  try {
    const raw: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (raw !== null && typeof raw === 'object') manifest = raw;
  } catch {
    // No/unreadable manifest — fall through to the conventional entry.
  }
  for (const candidate of manifestEntryCandidates(manifest)) {
    const full = resolve(root, candidate);
    if (full !== root && !full.startsWith(root + sep)) continue; // escapes the package
    if (await exists(full)) return full;
  }
  throw new EngineFetchError(
    `Extracted engine at ${root} has no usable module entry point ` +
      `(tried the package manifest and ${FALLBACK_ENTRY})`,
  );
}

/**
 * Make a pinned PGlite engine for `major` available on disk and return a path
 * that `openDataDir` can import.
 *
 * This is the only module in the package that touches the network, and nothing
 * calls it unless the caller explicitly opts in — importing `pglite-migrate`
 * never reaches the registry on its own.
 *
 * Under `keep` (the default) the engine is extracted into a shared cache and
 * reused on later runs; a concurrent run that loses the race simply adopts the
 * winner's copy, because extraction happens in a staging directory that is
 * renamed into place atomically. Under `ephemeral` the engine goes to a fresh
 * temporary directory that {@link AcquiredEngine.cleanup} removes.
 *
 * @param major - Postgres major from the data directory's `PG_VERSION`.
 * @throws {@link UnknownMajorError} when no engine is pinned for `major`.
 * @throws {@link EngineFetchError} when the registry cannot be reached.
 * @throws {@link IntegrityError} when the download fails its pinned hash.
 */
export async function acquireEngine(
  major: number,
  options: AcquireOptions = {},
): Promise<AcquiredEngine> {
  return acquireRelease(resolveEngine(major), options);
}

/**
 * Acquire one specific pinned release, bypassing major-version lookup.
 *
 * {@link acquireEngine} is the usual entry point; this is for callers that
 * already know exactly which engine version they want.
 *
 * @param release - The release to acquire; its `integrity` gates the download.
 * @throws {@link EngineFetchError} when the registry cannot be reached.
 * @throws {@link IntegrityError} when the download fails its pinned hash.
 */
export async function acquireRelease(
  release: EngineRelease,
  options: AcquireOptions = {},
): Promise<AcquiredEngine> {
  const mode: EngineCacheMode = options.cache ?? 'keep';
  const registryUrl = options.registryUrl ?? DEFAULT_REGISTRY;

  if (mode === 'ephemeral') {
    const parent = options.cacheDir ?? tmpdir();
    const dir = join(parent, `pglite-migrate-engine-${release.version}-${randomUUID()}`);
    const bytes = await download(tarballUrl(release.version, registryUrl), release.version);
    verifyIntegrity(bytes, release);
    await extractTarGz(bytes, dir, 1);
    return {
      entry: await resolveEntry(dir),
      dir,
      release,
      fromCache: false,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  }

  const root = options.cacheDir ?? defaultCacheDir();
  const dir = join(root, `pglite-${release.version}`);
  const noop = (): Promise<void> => Promise.resolve();

  if (await exists(dir)) {
    return { entry: await resolveEntry(dir), dir, release, fromCache: true, cleanup: noop };
  }

  const bytes = await download(tarballUrl(release.version, registryUrl), release.version);
  verifyIntegrity(bytes, release);

  // Extract to staging, then rename into place, so a crashed or concurrent run
  // can never leave a half-populated cache entry for someone else to import.
  await mkdir(root, { recursive: true });
  const staging = join(root, `.staging-${release.version}-${randomUUID()}`);
  try {
    await extractTarGz(bytes, staging, 1);
    try {
      await rename(staging, dir);
    } catch (err) {
      // Another process won the race and populated the entry first: adopt it.
      if (!(await exists(dir))) throw err;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  return { entry: await resolveEntry(dir), dir, release, fromCache: false, cleanup: noop };
}
