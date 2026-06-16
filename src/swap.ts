import { rename, rm, stat } from 'node:fs/promises';

/** Options for {@link swapIntoPlace}. */
export interface SwapOptions {
  /** Override the timestamp used in the retained `.old-<ts>` name (ISO-8601). */
  timestamp?: string;
  /** Keep the displaced original as `<canonical>.old-<ts>` (default true). */
  keepOld?: boolean;
}

/** Result of {@link swapIntoPlace}. */
export interface SwapResult {
  /** The canonical location (now holding the new cluster). */
  canonical: string;
  /** Path of the retained previous cluster, or null if none was kept. */
  previous: string | null;
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

function isExdev(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'EXDEV';
}

/**
 * Atomically move a freshly-migrated cluster (`newDir`) into the canonical
 * location, preserving the directory currently there as `<canonical>.old-<ts>`.
 *
 * The migration should write into `newDir` (a sibling of the canonical location)
 * and only call this once it has validated; until then the canonical location is
 * never touched, so a crash mid-migration leaves it intact. The swap itself is
 * two renames — move the original aside, then move the new cluster in — and if
 * the second rename fails the original is moved back, so the canonical location
 * is never left missing.
 *
 * `newDir` must be on the same filesystem as the canonical location (stage it as
 * a sibling); a cross-filesystem move is reported rather than silently copied.
 *
 * @throws if `newDir` does not exist, on a cross-filesystem move, or if the swap
 * cannot complete (after restoring the original).
 */
export async function swapIntoPlace(
  canonicalDir: string,
  newDir: string,
  options: SwapOptions = {},
): Promise<SwapResult> {
  if (!(await exists(newDir))) {
    // Crash-before-swap: the new cluster was never completed. Canonical is intact.
    throw new Error(`New cluster directory does not exist: ${newDir}`);
  }

  const keepOld = options.keepOld ?? true;
  const timestamp = (options.timestamp ?? new Date().toISOString()).replace(/:/g, '-');
  const oldPath = `${canonicalDir}.old-${timestamp}`;
  const canonicalExisted = await exists(canonicalDir);

  if (canonicalExisted) {
    if (await exists(oldPath)) {
      throw new Error(`Retained-old directory already exists: ${oldPath}`);
    }
    await rename(canonicalDir, oldPath);
  }

  try {
    await rename(newDir, canonicalDir);
  } catch (err) {
    // Restore the original so the canonical location is never left missing.
    if (canonicalExisted) await rename(oldPath, canonicalDir).catch(() => undefined);
    if (isExdev(err)) {
      throw new Error(
        `Cannot swap: ${newDir} is on a different filesystem than ${canonicalDir}. ` +
          `Stage the new cluster as a sibling of the canonical location.`,
        { cause: err },
      );
    }
    throw err;
  }

  if (canonicalExisted && !keepOld) {
    await rm(oldPath, { recursive: true, force: true });
    return { canonical: canonicalDir, previous: null };
  }
  return { canonical: canonicalDir, previous: canonicalExisted ? oldPath : null };
}
