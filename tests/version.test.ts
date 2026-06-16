import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readClusterVersion } from '../src/version.js';

describe('readClusterVersion', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pglite-migrate-ver-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the major version from PG_VERSION', async () => {
    await writeFile(join(dir, 'PG_VERSION'), '17\n');
    await expect(readClusterVersion(dir)).resolves.toBe(17);
  });

  it('tolerates surrounding whitespace', async () => {
    await writeFile(join(dir, 'PG_VERSION'), '  18  ');
    await expect(readClusterVersion(dir)).resolves.toBe(18);
  });

  it('throws on an unparseable file', async () => {
    await writeFile(join(dir, 'PG_VERSION'), 'not-a-number');
    await expect(readClusterVersion(dir)).rejects.toThrow(/major version/);
  });

  it('rejects when PG_VERSION is missing', async () => {
    await expect(readClusterVersion(dir)).rejects.toThrow();
  });
});
