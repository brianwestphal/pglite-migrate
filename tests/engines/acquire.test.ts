import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireEngine,
  acquireRelease,
  defaultCacheDir,
  EngineFetchError,
  IntegrityError,
  resolveEntry,
} from '../../src/engines/acquire.js';
import { extractTarGz } from '../../src/engines/tar.js';
import type { EngineRelease } from '../../src/types.js';
import { makePackageTgz, makeTgz } from './fixtures.js';

/** sha512 integrity string for a buffer, in npm's `dist.integrity` format. */
function integrityOf(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

/** A fake npm registry that serves fixed bytes and counts requests. */
class FakeRegistry {
  private server!: Server;
  requests = 0;
  body: Buffer;
  status = 200;

  constructor(body: Buffer) {
    this.body = body;
  }

  async start(): Promise<string> {
    this.server = createServer((_req, res) => {
      this.requests++;
      if (this.status !== 200) {
        res.writeHead(this.status);
        res.end('nope');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(this.body);
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port.toString()}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => { r(); }));
  }
}

/** Find an address that refuses connections, for the offline path. */
async function closedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((r) => server.close(() => { r(); }));
  return `http://127.0.0.1:${port.toString()}`;
}

const TGZ = makePackageTgz();
const RELEASE: EngineRelease = {
  postgresMajor: 42,
  version: '9.9.9',
  integrity: integrityOf(TGZ),
};

describe('acquireRelease', () => {
  let cacheDir: string;
  let registry: FakeRegistry;
  let url: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'pglite-migrate-cache-'));
    registry = new FakeRegistry(TGZ);
    url = await registry.start();
  });

  afterEach(async () => {
    await registry.stop();
    await rm(cacheDir, { recursive: true, force: true });
  });

  const opts = (extra: Record<string, unknown> = {}) => ({ cacheDir, registryUrl: url, ...extra });

  describe('keep (the default)', () => {
    it('downloads, verifies, extracts, and resolves an entry point', async () => {
      const engine = await acquireRelease(RELEASE, opts());
      expect(engine.fromCache).toBe(false);
      expect(engine.release.version).toBe('9.9.9');
      expect(engine.entry).toBe(join(cacheDir, 'pglite-9.9.9', 'dist', 'index.js'));
      expect((await stat(engine.entry)).isFile()).toBe(true);
      expect(registry.requests).toBe(1);
    });

    it('is the mode used when cache is unspecified', async () => {
      const engine = await acquireRelease(RELEASE, { cacheDir, registryUrl: url });
      expect(engine.dir).toBe(join(cacheDir, 'pglite-9.9.9'));
      // Nothing removed on cleanup: the whole point of keep.
      await engine.cleanup();
      expect((await stat(engine.dir)).isDirectory()).toBe(true);
    });

    it('reuses the cache on a second acquire without re-downloading', async () => {
      await acquireRelease(RELEASE, opts());
      expect(registry.requests).toBe(1);

      const second = await acquireRelease(RELEASE, opts());
      expect(second.fromCache).toBe(true);
      expect(registry.requests).toBe(1); // no second download
      expect(second.dir).toBe(join(cacheDir, 'pglite-9.9.9'));
    });

    it('leaves no staging directory behind after success', async () => {
      await acquireRelease(RELEASE, opts());
      const entries = await readdir(cacheDir);
      expect(entries).toEqual(['pglite-9.9.9']);
    });

    it('adopts a concurrent winner rather than failing the race', async () => {
      const [a, b, c] = await Promise.all([
        acquireRelease(RELEASE, opts()),
        acquireRelease(RELEASE, opts()),
        acquireRelease(RELEASE, opts()),
      ]);
      for (const engine of [a, b, c]) {
        expect(engine.dir).toBe(join(cacheDir, 'pglite-9.9.9'));
        expect((await stat(engine.entry)).isFile()).toBe(true);
      }
      // Exactly one cache entry, and no staging leftovers from the losers.
      expect(await readdir(cacheDir)).toEqual(['pglite-9.9.9']);
    });
  });

  describe('ephemeral', () => {
    it('extracts outside the shared cache and removes it on cleanup', async () => {
      const engine = await acquireRelease(RELEASE, opts({ cache: 'ephemeral' }));
      expect(engine.fromCache).toBe(false);
      expect((await stat(engine.dir)).isDirectory()).toBe(true);
      expect(engine.dir).not.toBe(join(cacheDir, 'pglite-9.9.9'));

      await engine.cleanup();
      await expect(stat(engine.dir)).rejects.toThrow();
    });

    it('never populates the shared cache entry', async () => {
      const engine = await acquireRelease(RELEASE, opts({ cache: 'ephemeral' }));
      await expect(stat(join(cacheDir, 'pglite-9.9.9'))).rejects.toThrow();
      await engine.cleanup();
    });

    it('downloads even when a cache entry already exists', async () => {
      await acquireRelease(RELEASE, opts()); // populate cache
      expect(registry.requests).toBe(1);

      const engine = await acquireRelease(RELEASE, opts({ cache: 'ephemeral' }));
      expect(engine.fromCache).toBe(false);
      expect(registry.requests).toBe(2); // ephemeral does not read the cache
      await engine.cleanup();
    });

    it('gives each run its own directory', async () => {
      const a = await acquireRelease(RELEASE, opts({ cache: 'ephemeral' }));
      const b = await acquireRelease(RELEASE, opts({ cache: 'ephemeral' }));
      expect(a.dir).not.toBe(b.dir);
      await a.cleanup();
      // Removing one must not disturb the other.
      expect((await stat(b.entry)).isFile()).toBe(true);
      await b.cleanup();
    });

    it('cleanup is safe to call twice', async () => {
      const engine = await acquireRelease(RELEASE, opts({ cache: 'ephemeral' }));
      await engine.cleanup();
      await expect(engine.cleanup()).resolves.toBeUndefined();
    });
  });

  describe('failure paths', () => {
    it('rejects a tarball that fails its pinned hash, writing nothing', async () => {
      const wrong: EngineRelease = { ...RELEASE, integrity: integrityOf(Buffer.from('other')) };
      await expect(acquireRelease(wrong, opts())).rejects.toThrow(IntegrityError);
      // Nothing extracted — not even a staging directory.
      expect(await readdir(cacheDir)).toEqual([]);
    });

    it('surfaces a non-200 registry response', async () => {
      registry.status = 404;
      await expect(acquireRelease(RELEASE, opts())).rejects.toThrow(EngineFetchError);
      await expect(acquireRelease(RELEASE, opts())).rejects.toThrow(/404/);
    });

    it('gives an actionable error when the registry is unreachable', async () => {
      const dead = await closedPortUrl();
      const error = await acquireRelease(RELEASE, opts({ registryUrl: dead })).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(EngineFetchError);
      const message = (error as Error).message;
      // Must name the offline case and the manual fallback, not just fail.
      expect(message).toMatch(/offline or behind a proxy/);
      expect(message).toMatch(/npm install pglite-old@npm:@electric-sql\/pglite@9\.9\.9/);
    });

    it('cleans up staging when extraction fails on a hostile archive', async () => {
      const hostile = makeTgz([{ name: 'package/../../pwned', body: 'x' }]);
      registry.body = hostile;
      const release: EngineRelease = { ...RELEASE, integrity: integrityOf(hostile) };
      await expect(acquireRelease(release, opts())).rejects.toThrow(/traversal/);
      expect(await readdir(cacheDir)).toEqual([]); // no staging leftovers
    });
  });

  describe('state transitions across modes', () => {
    it('walks cold -> cached -> ephemeral -> cached without cross-contamination', async () => {
      // Cold: downloads and populates the cache.
      const cold = await acquireRelease(RELEASE, opts());
      expect([cold.fromCache, registry.requests]).toEqual([false, 1]);

      // Warm: served from cache, no network.
      const warm = await acquireRelease(RELEASE, opts());
      expect([warm.fromCache, registry.requests]).toEqual([true, 1]);

      // Ephemeral: downloads its own copy, ignores the cache.
      const ephemeral = await acquireRelease(RELEASE, opts({ cache: 'ephemeral' }));
      expect([ephemeral.fromCache, registry.requests]).toEqual([false, 2]);

      // Ephemeral cleanup must not damage the shared cache entry.
      await ephemeral.cleanup();
      const afterCleanup = await acquireRelease(RELEASE, opts());
      expect([afterCleanup.fromCache, registry.requests]).toEqual([true, 2]);
      expect((await stat(afterCleanup.entry)).isFile()).toBe(true);
    });

    it('recovers when a previous run left a stale staging directory', async () => {
      await mkdir(join(cacheDir, '.staging-9.9.9-leftover', 'dist'), { recursive: true });
      await writeFile(join(cacheDir, '.staging-9.9.9-leftover', 'dist', 'index.js'), 'stale');

      const engine = await acquireRelease(RELEASE, opts());
      expect(engine.fromCache).toBe(false);
      expect((await stat(engine.entry)).isFile()).toBe(true);
    });

    it('re-downloads after the cache entry is deleted out from under it', async () => {
      const first = await acquireRelease(RELEASE, opts());
      await rm(first.dir, { recursive: true, force: true });

      const second = await acquireRelease(RELEASE, opts());
      expect(second.fromCache).toBe(false);
      expect(registry.requests).toBe(2);
      expect((await stat(second.entry)).isFile()).toBe(true);
    });
  });
});

describe('acquireEngine', () => {
  it('resolves the major through the pinned registry', async () => {
    // The fake registry serves bytes that cannot match the real pinned hash, so
    // an IntegrityError here proves the pinned hash for PG17 was the one used.
    const registry = new FakeRegistry(makePackageTgz());
    const url = await registry.start();
    const cacheDir = await mkdtemp(join(tmpdir(), 'pglite-migrate-cache-'));
    try {
      const error = await acquireEngine(17, { cacheDir, registryUrl: url }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(IntegrityError);
      expect((error as IntegrityError).version).toBe('0.4.6');
    } finally {
      await registry.stop();
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('propagates UnknownMajorError for a major with no pinned engine', async () => {
    await expect(acquireEngine(99)).rejects.toThrow(/No pinned PGlite engine/);
  });
});

describe('resolveEntry', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pglite-migrate-entry-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('prefers the exports "." import condition', async () => {
    await extractTarGz(
      makePackageTgz([{ name: 'package/other.js', body: 'x' }], {
        exports: { '.': { import: './other.js' } },
        module: 'dist/index.js',
      }),
      dir,
      1,
    );
    expect(await resolveEntry(dir)).toBe(join(dir, 'other.js'));
  });

  it('accepts a string exports "." shorthand', async () => {
    await extractTarGz(
      makePackageTgz([{ name: 'package/short.js', body: 'x' }], { exports: { '.': './short.js' } }),
      dir,
      1,
    );
    expect(await resolveEntry(dir)).toBe(join(dir, 'short.js'));
  });

  it('falls back to module, then main', async () => {
    await extractTarGz(makePackageTgz([], { main: 'dist/index.js' }), dir, 1);
    expect(await resolveEntry(dir)).toBe(join(dir, 'dist', 'index.js'));
  });

  it('falls back to the conventional path when the manifest is unusable', async () => {
    await extractTarGz(makeTgz([{ name: 'package/dist/index.js', body: 'x' }]), dir, 1);
    expect(await resolveEntry(dir)).toBe(join(dir, 'dist', 'index.js'));
  });

  it('ignores a manifest entry that points outside the package', async () => {
    await extractTarGz(makePackageTgz([], { module: '../../../etc/passwd' }), dir, 1);
    // Falls through to the real entry rather than escaping.
    expect(await resolveEntry(dir)).toBe(join(dir, 'dist', 'index.js'));
  });

  it('ignores non-string manifest fields', async () => {
    await extractTarGz(makePackageTgz([], { module: 42, main: null, exports: 'nope' }), dir, 1);
    expect(await resolveEntry(dir)).toBe(join(dir, 'dist', 'index.js'));
  });

  it('throws when nothing usable exists', async () => {
    await extractTarGz(makeTgz([{ name: 'package/readme.md', body: 'x' }]), dir, 1);
    await expect(resolveEntry(dir)).rejects.toThrow(/no usable module entry point/);
  });
});

describe('defaultCacheDir', () => {
  it('returns a path in the engine namespace for the running platform', () => {
    const dir = defaultCacheDir();
    expect(dir).toMatch(/pglite-migrate/);
    expect(dir.endsWith(join('pglite-migrate', 'engines'))).toBe(true);
  });

  it('uses LOCALAPPDATA on Windows', () => {
    const dir = defaultCacheDir('win32', { LOCALAPPDATA: join('C:', 'Users', 'x', 'AppData') });
    expect(dir).toBe(join('C:', 'Users', 'x', 'AppData', 'pglite-migrate', 'engines'));
  });

  it('falls back to the conventional AppData path when LOCALAPPDATA is unset', () => {
    const dir = defaultCacheDir('win32', {});
    expect(dir).toContain(join('AppData', 'Local', 'pglite-migrate', 'engines'));
  });

  it('uses ~/Library/Caches on macOS', () => {
    const dir = defaultCacheDir('darwin', {});
    expect(dir).toContain(join('Library', 'Caches', 'pglite-migrate', 'engines'));
  });

  it('honors XDG_CACHE_HOME on Linux', () => {
    const dir = defaultCacheDir('linux', { XDG_CACHE_HOME: '/xdg' });
    expect(dir).toBe(join('/xdg', 'pglite-migrate', 'engines'));
  });

  it('falls back to ~/.cache on Linux without XDG_CACHE_HOME', () => {
    const dir = defaultCacheDir('linux', {});
    expect(dir).toContain(join('.cache', 'pglite-migrate', 'engines'));
  });
});

describe('opt-in isolation of the network surface', () => {
  it('importing the main entry makes no network call and does not export acquireEngine', async () => {
    let fetchCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      fetchCalls++;
      return realFetch(...args);
    });
    try {
      const entry: Record<string, unknown> = await import('../../src/index.js');
      expect(fetchCalls).toBe(0);
      // Acquisition is reachable only via `pglite-migrate/engines`, so that a
      // consumer who never opts in has no route to the network code.
      expect('acquireEngine' in entry).toBe(false);
      expect('acquireRelease' in entry).toBe(false);
      // The pinned registry is pure data and IS safe to expose here.
      expect('resolveEngine' in entry).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
