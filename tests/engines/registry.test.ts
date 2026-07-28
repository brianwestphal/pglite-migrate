import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  knownMajors,
  PGLITE_PACKAGE,
  resolveEngine,
  UnknownMajorError,
} from '../../src/engines/registry.js';
import { readClusterVersion } from '../../src/version.js';

describe('resolveEngine', () => {
  it('resolves each major this build claims to know', () => {
    for (const major of knownMajors()) {
      const release = resolveEngine(major);
      expect(release.postgresMajor).toBe(major);
      expect(release.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(release.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/);
    }
  });

  it('pins the empirically verified engine for each major', () => {
    // Each of these was downloaded, integrity-checked, booted, and asked for its
    // own server_version — not taken from a changelog.
    expect(resolveEngine(15).version).toBe('0.1.5');
    expect(resolveEngine(16).version).toBe('0.2.17');
    expect(resolveEngine(17).version).toBe('0.4.6');
    expect(resolveEngine(18).version).toBe('0.5.4');
  });

  it('throws UnknownMajorError naming the majors it does know', () => {
    expect(() => resolveEngine(99)).toThrow(UnknownMajorError);
    try {
      resolveEngine(99);
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as UnknownMajorError;
      expect(e.major).toBe(99);
      expect(e.knownMajors).toEqual(knownMajors());
      // The message must be actionable, not just a rejection.
      expect(e.message).toContain('PostgreSQL 99');
      expect(e.message).toContain(PGLITE_PACKAGE);
      for (const major of knownMajors()) expect(e.message).toContain(major.toString());
    }
  });
});

describe('registry table integrity', () => {
  it('pins exactly one release per major, ascending', () => {
    const majors = knownMajors();
    expect(new Set(majors).size).toBe(majors.length);
    expect([...majors].sort((a, b) => a - b)).toEqual(majors);
  });

  it('pins a distinct package version per major', () => {
    const versions = knownMajors().map((m) => resolveEngine(m).version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('pins a distinct integrity hash per major', () => {
    const hashes = knownMajors().map((m) => resolveEngine(m).integrity);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

describe('registry keys match what readClusterVersion returns', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pglite-migrate-reg-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves an engine from a real PG_VERSION value', async () => {
    await writeFile(join(dir, 'PG_VERSION'), '17\n');
    const major = await readClusterVersion(dir);
    expect(resolveEngine(major).version).toBe('0.4.6');
  });

  it("resolves PGlite 0.1.x's non-numeric `15devel` stamp", async () => {
    // 0.1.x bundles a Postgres development snapshot and writes `15devel`, not
    // `15`. readClusterVersion's parseInt stops at the first non-digit, so the
    // registry key still lines up — pin that behavior, it is load-bearing.
    await writeFile(join(dir, 'PG_VERSION'), '15devel\n');
    const major = await readClusterVersion(dir);
    expect(major).toBe(15);
    expect(resolveEngine(major).version).toBe('0.1.5');
  });
});
