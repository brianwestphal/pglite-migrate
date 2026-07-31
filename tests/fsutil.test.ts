import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { errorCode, exists, sanitizedTimestamp } from '../src/fsutil.js';
import { makeTempDir, removeTempDir } from './tempdir.js';

describe('exists', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await makeTempDir('pglite-migrate-fsutil-');
    await writeFile(join(dir, 'present'), 'x');
  });

  afterAll(async () => {
    await removeTempDir(dir);
  });

  it('is true for a file and for a directory', async () => {
    expect(await exists(join(dir, 'present'))).toBe(true);
    expect(await exists(dir)).toBe(true);
  });

  it('is false for a missing path rather than throwing', async () => {
    expect(await exists(join(dir, 'absent'))).toBe(false);
    expect(await exists(join(dir, 'no', 'such', 'nesting'))).toBe(false);
  });
});

describe('sanitizedTimestamp', () => {
  it('replaces the colons NTFS rejects', () => {
    expect(sanitizedTimestamp('2026-06-16T14:30:05.123Z')).toBe('2026-06-16T14-30-05.123Z');
    expect(sanitizedTimestamp('2026-06-16T14:30:05.123Z')).not.toContain(':');
  });

  it('keeps sub-second precision so same-second runs do not collide', () => {
    // docs/10 FR-10.3 suggested dropping the fraction. It is kept deliberately:
    // both backupDataDir and swapIntoPlace treat a name collision as a hard
    // error rather than disambiguating, so the extra resolution is load-bearing.
    const a = sanitizedTimestamp('2026-06-16T14:30:05.001Z');
    const b = sanitizedTimestamp('2026-06-16T14:30:05.002Z');
    expect(a).not.toBe(b);
  });

  it('defaults to now, in a form usable as a directory suffix', () => {
    const ts = sanitizedTimestamp();
    expect(ts).not.toContain(':');
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
  });
});

describe('errorCode', () => {
  it('reads a Node error code', () => {
    expect(errorCode(Object.assign(new Error('x'), { code: 'EXDEV' }))).toBe('EXDEV');
    expect(errorCode({ code: 'ERR_MODULE_NOT_FOUND' })).toBe('ERR_MODULE_NOT_FOUND');
  });

  it('is undefined for anything without a string code', () => {
    expect(errorCode(new Error('no code'))).toBeUndefined();
    expect(errorCode({ code: 42 })).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
    expect(errorCode(undefined)).toBeUndefined();
    expect(errorCode('EXDEV')).toBeUndefined();
  });
});
