import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDataDir } from '../src/loader.js';
import type { EngineRelease } from '../src/types.js';
import { makeFakeEngineTgz } from './engines/fixtures.js';

/** An address that refuses connections — proves no download was attempted. */
async function closedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((r) => {
    server.close(() => {
      r();
    });
  });
  return `http://127.0.0.1:${port.toString()}`;
}

describe('openDataDir', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pglite-migrate-loader-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('opens a data dir with the default engine and returns a queryable, closable cluster', async () => {
    const cluster = await openDataDir(join(dir, 'default'));
    try {
      const { rows } = await cluster.query<{ one: number }>('SELECT 1 AS one');
      expect(rows[0].one).toBe(1);
    } finally {
      await cluster.close();
    }
  });

  it('resolves an engine selected by npm-alias module path', async () => {
    const cluster = await openDataDir(join(dir, 'aliased'), 'pglite-old');
    try {
      const { rows } = await cluster.query<{ two: number }>('SELECT 2 AS two');
      expect(rows[0].two).toBe(2);
    } finally {
      await cluster.close();
    }
  });

  it('throws a clear error when the module lacks a PGlite constructor', async () => {
    await expect(openDataDir(join(dir, 'none'), 'node:path')).rejects.toThrow(
      /does not export a PGlite constructor/,
    );
  });

  it('accepts an absolute path to an engine entry point', async () => {
    // Acquired engines are always absolute paths; a bare import() of one works
    // on POSIX but not Windows, so the loader routes them through file://.
    const entry = resolve('node_modules/pglite-old/dist/index.js');
    const cluster = await openDataDir(join(dir, 'abs'), entry);
    try {
      const { rows } = await cluster.query<{ three: number }>('SELECT 3 AS three');
      expect(rows[0].three).toBe(3);
    } finally {
      await cluster.close();
    }
  });

  describe('resolve-first', () => {
    it('uses an installed engine without touching the registry', async () => {
      // registryUrl points at a closed port: any download attempt would fail.
      const cluster = await openDataDir(join(dir, 'installed'), 'pglite-old', {
        fetchMissingEngine: true,
        registryUrl: await closedPortUrl(),
      });
      try {
        const { rows } = await cluster.query<{ four: number }>('SELECT 4 AS four');
        expect(rows[0].four).toBe(4);
        expect(cluster.acquired).toBeUndefined(); // resolved, not acquired
      } finally {
        await cluster.close();
      }
    });

    it('does not attempt acquisition when a resolved engine fails on its own import', async () => {
      // A module that exists but throws must surface its own error, not be
      // silently replaced by a downloaded engine.
      const broken = join(dir, 'broken.mjs');
      await writeFile(broken, 'throw new Error("engine blew up on load");\n');
      await expect(
        openDataDir(join(dir, 'data'), broken, {
          fetchMissingEngine: true,
          registryUrl: await closedPortUrl(),
        }),
      ).rejects.toThrow(/engine blew up on load/);
    });
  });

  describe('missing engine, acquisition off', () => {
    it('names the major, the install command, and the opt-in flag', async () => {
      const dataDir = join(dir, 'pg17');
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, 'PG_VERSION'), '17\n');

      const error = await openDataDir(dataDir, 'pglite-nope').catch((e: unknown) => e);
      const message = (error as Error).message;
      expect(message).toContain('pglite-nope');
      expect(message).toContain('PostgreSQL 17');
      expect(message).toContain('npm install pglite-nope@npm:@electric-sql/pglite@0.4.6');
      expect(message).toContain('--fetch-missing-engine');
      // The underlying resolution failure is preserved, not swallowed.
      expect((error as Error).cause).toBeDefined();
    });

    it('says so plainly when no engine is pinned for the major', async () => {
      const dataDir = join(dir, 'pg99');
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, 'PG_VERSION'), '99\n');

      await expect(openDataDir(dataDir, 'pglite-nope')).rejects.toThrow(
        /No engine is pinned for PostgreSQL 99/,
      );
    });

    it('still gives actionable advice when the major cannot be read', async () => {
      const error = await openDataDir(join(dir, 'nonexistent'), 'pglite-nope').catch(
        (e: unknown) => e,
      );
      const message = (error as Error).message;
      expect(message).toContain('Could not load the PGlite engine "pglite-nope"');
      expect(message).toContain('fetchMissingEngine');
    });
  });

  describe('missing engine, acquisition on', () => {
    it('resolves the major from PG_VERSION and acquires the pinned engine for it', async () => {
      const dataDir = join(dir, 'pg17-fetch');
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, 'PG_VERSION'), '17\n');

      // A closed port makes the download fail, but reaching EngineFetchError at
      // all proves the chain: resolve miss -> opt-in -> read major -> acquire.
      const error = await openDataDir(dataDir, 'pglite-nope', {
        fetchMissingEngine: true,
        registryUrl: await closedPortUrl(),
        cacheDir: join(dir, 'cache'),
      }).catch((e: unknown) => e);
      expect((error as Error).name).toBe('EngineFetchError');
      expect((error as Error).message).toContain('@electric-sql/pglite@0.4.6');
    });

    it('honors an explicit major when the data directory has no PG_VERSION', async () => {
      const error = await openDataDir(join(dir, 'brand-new'), 'pglite-nope', {
        fetchMissingEngine: true,
        major: 16,
        registryUrl: await closedPortUrl(),
        cacheDir: join(dir, 'cache'),
      }).catch((e: unknown) => e);
      expect((error as Error).message).toContain('@electric-sql/pglite@0.2.17');
    });

    it('propagates an unknown major rather than downloading something wrong', async () => {
      const dataDir = join(dir, 'pg99-fetch');
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, 'PG_VERSION'), '99\n');

      await expect(
        openDataDir(dataDir, 'pglite-nope', {
          fetchMissingEngine: true,
          cacheDir: join(dir, 'cache'),
        }),
      ).rejects.toThrow(/No pinned PGlite engine for PostgreSQL 99/);
    });
  });

  describe('acquired engine lifecycle', () => {
    const TGZ = makeFakeEngineTgz();
    const RELEASE: EngineRelease = {
      postgresMajor: 42,
      version: '9.9.9',
      integrity: `sha512-${createHash('sha512').update(TGZ).digest('base64')}`,
    };

    let server: Server;
    let url: string;

    beforeEach(async () => {
      server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(TGZ);
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port.toString()}`;
    });

    afterEach(async () => {
      await new Promise<void>((r) => {
        server.close(() => {
          r();
        });
      });
    });

    it('opens the data dir with the acquired engine and reports what it acquired', async () => {
      const cluster = await openDataDir(join(dir, 'data'), 'pglite-nope', {
        fetchMissingEngine: true,
        release: RELEASE,
        registryUrl: url,
        cacheDir: join(dir, 'cache'),
      });
      try {
        expect(cluster.acquired).toEqual({ version: '9.9.9', fromCache: false });
        const { rows } = await cluster.query<{ dataDir: string }>('SELECT 1');
        expect(rows[0].dataDir).toBe(join(dir, 'data'));
      } finally {
        await cluster.close();
      }
    });

    it('reports a cache hit on the second open', async () => {
      const opts = {
        fetchMissingEngine: true,
        release: RELEASE,
        registryUrl: url,
        cacheDir: join(dir, 'cache'),
      };
      const first = await openDataDir(join(dir, 'a'), 'pglite-nope', opts);
      await first.close();
      const second = await openDataDir(join(dir, 'b'), 'pglite-nope', opts);
      try {
        expect(second.acquired).toEqual({ version: '9.9.9', fromCache: true });
      } finally {
        await second.close();
      }
    });

    it('keeps a cached engine on close', async () => {
      const cacheDir = join(dir, 'cache');
      const cluster = await openDataDir(join(dir, 'data'), 'pglite-nope', {
        fetchMissingEngine: true,
        release: RELEASE,
        registryUrl: url,
        cacheDir,
      });
      await cluster.close();
      expect((await stat(join(cacheDir, 'pglite-9.9.9'))).isDirectory()).toBe(true);
    });

    it('removes an ephemeral engine on close, and still closes the cluster', async () => {
      const cacheDir = join(dir, 'cache');
      const cluster = await openDataDir(join(dir, 'data'), 'pglite-nope', {
        fetchMissingEngine: true,
        release: RELEASE,
        registryUrl: url,
        cache: 'ephemeral',
        cacheDir,
      });
      const engineDirs = await readdir(cacheDir);
      expect(engineDirs).toHaveLength(1);

      await cluster.close();
      expect((cluster as unknown as { closed: boolean }).closed).toBe(true);
      await expect(readdir(cacheDir)).resolves.toEqual([]);
    });
  });
});
