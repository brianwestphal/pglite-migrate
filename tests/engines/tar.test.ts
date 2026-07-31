import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extractTarGz, safeEntryPath, TarError } from '../../src/engines/tar.js';
import { makeTempDir, removeTempDir } from '../tempdir.js';
import { makeTar, makeTgz } from './fixtures.js';

describe('safeEntryPath', () => {
  it('strips leading components', () => {
    expect(safeEntryPath('package/dist/index.js', 1)).toBe('dist/index.js');
    expect(safeEntryPath('package/dist/index.js', 0)).toBe('package/dist/index.js');
  });

  it('drops entries with nothing left after stripping', () => {
    expect(safeEntryPath('package/', 1)).toBeNull();
    expect(safeEntryPath('package', 1)).toBeNull();
  });

  it('normalizes away redundant segments', () => {
    expect(safeEntryPath('package/./dist//index.js', 1)).toBe('dist/index.js');
  });

  it('refuses parent-directory traversal', () => {
    expect(() => safeEntryPath('package/../../etc/passwd', 1)).toThrow(TarError);
    expect(() => safeEntryPath('../evil', 0)).toThrow(/traversal/);
  });

  it('refuses absolute paths', () => {
    expect(() => safeEntryPath('/etc/passwd', 0)).toThrow(/Absolute path/);
    expect(() => safeEntryPath('C:/Windows/system32', 0)).toThrow(/Absolute path/);
  });

  it('refuses backslashes and NUL bytes', () => {
    expect(() => safeEntryPath('package\\..\\evil', 1)).toThrow(/backslash/);
    expect(() => safeEntryPath('package/a\0b', 1)).toThrow(/NUL/);
  });
});

describe('extractTarGz', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir('pglite-migrate-tar-');
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  it('extracts regular files, creating parent directories', async () => {
    const tgz = makeTgz([
      { name: 'package/package.json', body: '{"name":"x"}' },
      { name: 'package/dist/deep/nested.js', body: 'export default 1;' },
    ]);
    const count = await extractTarGz(tgz, dir, 1);
    expect(count).toBe(2);
    await expect(readFile(join(dir, 'package.json'), 'utf8')).resolves.toBe('{"name":"x"}');
    await expect(readFile(join(dir, 'dist/deep/nested.js'), 'utf8')).resolves.toBe(
      'export default 1;',
    );
  });

  it('handles explicit directory entries', async () => {
    const tgz = makeTgz([
      { name: 'package/dist/', typeflag: '5' },
      { name: 'package/dist/a.js', body: 'a' },
    ]);
    await extractTarGz(tgz, dir, 1);
    expect((await stat(join(dir, 'dist'))).isDirectory()).toBe(true);
  });

  it('preserves exact file bytes across block padding', async () => {
    // 1000 bytes spans two 512-byte blocks with padding in the tail.
    const body = 'x'.repeat(1000);
    await extractTarGz(makeTgz([{ name: 'package/big.txt', body }]), dir, 1);
    const written = await readFile(join(dir, 'big.txt'), 'utf8');
    expect(written).toHaveLength(1000);
    expect(written).toBe(body);
  });

  it('ignores archive file modes rather than applying them', async () => {
    // A setuid bit in the archive must not reach the filesystem.
    await extractTarGz(makeTgz([{ name: 'package/x.js', body: 'x', mode: 0o4777 }]), dir, 1);
    const mode = (await stat(join(dir, 'x.js'))).mode;
    expect(mode & 0o4000).toBe(0); // no setuid
    expect(mode & 0o111).toBe(0); // not executable
  });

  describe('hostile archives', () => {
    it('refuses a path-traversal entry and writes nothing', async () => {
      const tgz = makeTgz([
        { name: 'package/ok.js', body: 'ok' },
        { name: 'package/../../../../tmp/pwned', body: 'pwned' },
      ]);
      await expect(extractTarGz(tgz, dir, 1)).rejects.toThrow(/traversal/);
      await expect(stat(join(dir, '..', 'pwned'))).rejects.toThrow();
    });

    it('refuses an absolute-path entry', async () => {
      const tgz = makeTgz([{ name: '/etc/pwned', body: 'pwned' }]);
      await expect(extractTarGz(tgz, dir, 0)).rejects.toThrow(/Absolute path/);
    });

    it.each([
      ['symlink', '2'],
      ['hardlink', '1'],
      ['character device', '3'],
      ['block device', '4'],
      ['FIFO', '6'],
    ])('refuses a %s entry', async (_label, typeflag) => {
      const tgz = makeTgz([
        { name: 'package/evil', typeflag, linkname: '/etc/passwd' },
        { name: 'package/dist/index.js', body: 'x' },
      ]);
      await expect(extractTarGz(tgz, dir, 1)).rejects.toThrow(/Refusing tar entry of type/);
    });

    it('refuses a corrupted header checksum', async () => {
      const tgz = makeTgz([{ name: 'package/x.js', body: 'x', breakChecksum: true }]);
      await expect(extractTarGz(tgz, dir, 1)).rejects.toThrow(/checksum mismatch/);
    });

    it('refuses an entry whose size runs past the end of the archive', async () => {
      const tar = makeTar([{ name: 'package/x.js', body: 'hello' }]);
      // Rewrite the size field to claim far more data than the archive holds.
      tar.write('00000100000\0', 124, 12, 'latin1');
      let sum = 0;
      tar.write('        ', 148, 8, 'latin1');
      for (let i = 0; i < 512; i++) sum += tar[i];
      tar.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
      await expect(extractTarGz(gzipSync(tar), dir, 1)).rejects.toThrow(/past end of archive/);
    });

    it('refuses an archive with no files at all', async () => {
      await expect(extractTarGz(makeTgz([]), dir, 1)).rejects.toThrow(/no files/);
    });

    it('refuses a GNU base-256 numeric field rather than misparsing it', async () => {
      const tar = makeTar([{ name: 'package/x.js', body: 'x' }]);
      // Set the high bit on the size field: GNU's base-256 encoding for values
      // too large for octal. We never expect one, so it must be refused.
      tar[124] = 0x80;
      let sum = 0;
      tar.write('        ', 148, 8, 'latin1');
      for (let i = 0; i < 512; i++) sum += tar[i];
      tar.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
      await expect(extractTarGz(gzipSync(tar), dir, 1)).rejects.toThrow(/base-256/);
    });
  });

  describe('long-name encodings', () => {
    it('honors a pax path override', async () => {
      const longPath = `package/dist/${'d'.repeat(120)}.js`;
      const record = `${(longPath.length + 12).toString()} path=${longPath}\n`;
      const tgz = makeTgz([
        { name: 'package/pax', typeflag: 'x', body: record },
        { name: 'package/ignored', body: 'contents' },
      ]);
      await extractTarGz(tgz, dir, 1);
      await expect(readFile(join(dir, 'dist', `${'d'.repeat(120)}.js`), 'utf8')).resolves.toBe(
        'contents',
      );
    });

    it('honors a GNU long-name entry', async () => {
      const longPath = `package/dist/${'g'.repeat(120)}.js`;
      const tgz = makeTgz([
        { name: 'package/@LongLink', typeflag: 'L', body: longPath },
        { name: 'package/ignored', body: 'contents' },
      ]);
      await extractTarGz(tgz, dir, 1);
      await expect(readFile(join(dir, 'dist', `${'g'.repeat(120)}.js`), 'utf8')).resolves.toBe(
        'contents',
      );
    });

    it('applies traversal checks to the overridden name, not just the header', async () => {
      // The header name is innocuous; the pax override is the attack.
      const evil = '../../../../tmp/pwned';
      const record = `${(evil.length + 12).toString()} path=${evil}\n`;
      const tgz = makeTgz([
        { name: 'package/pax', typeflag: 'x', body: record },
        { name: 'package/innocent.js', body: 'pwned' },
      ]);
      await expect(extractTarGz(tgz, dir, 0)).rejects.toThrow(/traversal/);
    });

    it('ignores pax global headers', async () => {
      const tgz = makeTgz([
        { name: 'package/global', typeflag: 'g', body: '20 comment=nothing\n' },
        { name: 'package/dist/index.js', body: 'x' },
      ]);
      await expect(extractTarGz(tgz, dir, 1)).resolves.toBe(1);
    });
  });
});
