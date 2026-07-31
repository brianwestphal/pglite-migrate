import { stat } from 'node:fs/promises';

/**
 * Shared filesystem and error-shape building blocks.
 *
 * The counterpart to `src/catalog.ts`, which holds the shared *SQL* building
 * blocks for the same reason: these were previously duplicated across `backup`,
 * `swap`, `loader`, and `engines/acquire`, and keeping one copy each stops the
 * modules drifting out of lockstep. The timestamp helper in particular encodes a
 * cross-cutting naming convention (`docs/10` FR-10.3, `docs/11`), so the
 * `.bak-`/`.old-` suffixes it feeds must agree by construction, not by luck.
 */

/** True if a path exists. */
export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A filesystem-safe timestamp for a `.bak-`/`.old-`/`.new-` directory suffix.
 *
 * ISO-8601 contains `:`, which NTFS rejects, so it is replaced with `-`. The
 * sub-second fraction is kept: `docs/10` FR-10.3 suggested dropping it, but two
 * runs inside the same second would then collide, and both `backupDataDir` and
 * `swapIntoPlace` treat a name collision as a hard error rather than
 * disambiguating. Keeping milliseconds makes the collision vanishingly rare
 * instead of merely unlikely, and `.` is legal on every target filesystem.
 *
 * @param override - Use this instant instead of now (ISO-8601). Tests pass it to
 * make directory names deterministic.
 */
export function sanitizedTimestamp(override?: string): string {
  return (override ?? new Date().toISOString()).replace(/:/g, '-');
}

/**
 * Read the `code` off an unknown thrown value (`EXDEV`, `ERR_MODULE_NOT_FOUND`, …).
 *
 * Node puts its error codes on a property the type system does not model, so
 * reaching for it is a trust-boundary read: narrow, then validate, rather than
 * asserting the shape.
 */
export function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
