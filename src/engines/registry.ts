import type { EngineRelease } from '../types.js';

/** The npm package every PGlite engine is published under. */
export const PGLITE_PACKAGE = '@electric-sql/pglite';

/**
 * Pinned engine releases, one per Postgres major.
 *
 * Each entry was verified empirically, not read off a changelog: the tarball was
 * downloaded, its sha512 compared against the registry's published
 * `dist.integrity`, extracted, booted, and asked for its own `server_version`.
 * The `postgresMajor` here is the value the engine actually stamps into a fresh
 * data directory's `PG_VERSION`.
 *
 * Only one release is pinned per major. Any patch in a line opens a data
 * directory written by any other patch in that line, so the newest patch — the
 * one carrying the most fixes — is the right known-good choice. Where two lines
 * bundle the same major (0.3.x and 0.4.x are both PG17), the newer line wins.
 *
 * @remarks
 * PGlite 0.1.x bundles a Postgres *development* snapshot and stamps the
 * non-numeric `15devel` into `PG_VERSION`. It is pinned anyway, because it is
 * the only line that can read a data directory it wrote — excluding it would
 * strand exactly the users who most need a migration.
 */
const RELEASES: readonly EngineRelease[] = [
  {
    postgresMajor: 15,
    version: '0.1.5',
    integrity:
      'sha512-eymv4ONNvoPZQTvOQIi5dbpR+J5HzEv0qQH9o/y3gvNheJV/P/NFcrbsfJZYTsDKoq7DKrTiFNexsRkJKy8x9Q==',
  },
  {
    postgresMajor: 16,
    version: '0.2.17',
    integrity:
      'sha512-qEpKRT2oUaWDH6tjRxLHjdzMqRUGYDnGZlKrnL4dJ77JVMcP2Hpo3NYnOSPKdZdeec57B6QPprCUFg0picx5Pw==',
  },
  {
    postgresMajor: 17,
    version: '0.4.6',
    integrity:
      'sha512-qmlmfN8UyKCee35qkV0r/MBp+Znl8FjBz7OpoglNvww3GJpw0/DLP0o1ZymvLNmcD5DTLOQdzKPtF8Hd3mdl1w==',
  },
  {
    postgresMajor: 18,
    version: '0.5.4',
    integrity:
      'sha512-yYZUyyXrHU7tPlCjwZQJ6hIG9DscdCCn7Uk0mYKwC1FeHX286AbcmFveMiRBEak8e9iPupjsoVImN3yJZVed2g==',
  },
];

/** Raised when a data directory's major has no pinned engine. */
export class UnknownMajorError extends Error {
  /** The major that could not be resolved. */
  readonly major: number;
  /** The majors this build does know how to acquire. */
  readonly knownMajors: number[];

  constructor(major: number, knownMajors: number[]) {
    super(
      `No pinned PGlite engine for PostgreSQL ${major.toString()} ` +
        `(this build knows ${knownMajors.join(', ')}). ` +
        `Install a matching engine yourself and pass it as the source engine, ` +
        `e.g. npm install pglite-old@npm:${PGLITE_PACKAGE}@<version>`,
    );
    this.name = 'UnknownMajorError';
    this.major = major;
    this.knownMajors = knownMajors;
  }
}

/** The Postgres majors this build can acquire an engine for, ascending. */
export function knownMajors(): number[] {
  return RELEASES.map((r) => r.postgresMajor);
}

/**
 * Resolve the pinned engine release for a Postgres major.
 *
 * @param major - Major version, as read from a data directory's `PG_VERSION`
 * (see `readClusterVersion`).
 * @returns The pinned release for that major.
 * @throws {@link UnknownMajorError} when no release is pinned for `major`.
 */
export function resolveEngine(major: number): EngineRelease {
  const release = tryResolveEngine(major);
  if (release === undefined) throw new UnknownMajorError(major, knownMajors());
  return release;
}

/**
 * Look up the pinned release for a major, or `undefined` when none is pinned.
 *
 * The non-throwing sibling of {@link resolveEngine}, for the callers that only
 * want to *name* a remedy in an error message. Not finding a pin is not itself a
 * failure there — it just means the message cannot suggest an install command —
 * and encoding that policy once keeps the two diagnostics consistent.
 */
export function tryResolveEngine(major: number): EngineRelease | undefined {
  return RELEASES.find((r) => r.postgresMajor === major);
}
