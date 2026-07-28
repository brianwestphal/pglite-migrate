import { gzipSync } from 'node:zlib';

/** One entry to place in a synthetic tar archive. */
export interface TarEntry {
  name: string;
  /** File contents. Ignored for non-file types. */
  body?: string;
  /** POSIX tar type flag: '0' file, '5' dir, '2' symlink, '1' hardlink, '3' device… */
  typeflag?: string;
  /** File mode; the extractor must ignore it, which is the point of setting it. */
  mode?: number;
  /** Link target, for link entries. */
  linkname?: string;
  /** Corrupt the header checksum, to prove the extractor notices. */
  breakChecksum?: boolean;
}

const BLOCK = 512;

/** Right-aligned, zero-padded, NUL-terminated octal field. */
function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

/** Build a single 512-byte ustar header block. */
function header(entry: TarEntry): Buffer {
  const size = entry.typeflag === '5' ? 0 : Buffer.byteLength(entry.body ?? '');
  const h = Buffer.alloc(BLOCK);
  h.write(entry.name, 0, 100, 'utf8');
  h.write(octal(entry.mode ?? 0o644, 8), 100, 8, 'latin1');
  h.write(octal(0, 8), 108, 8, 'latin1'); // uid
  h.write(octal(0, 8), 116, 8, 'latin1'); // gid
  h.write(octal(size, 12), 124, 12, 'latin1');
  h.write(octal(0, 12), 136, 12, 'latin1'); // mtime
  h.write('        ', 148, 8, 'latin1'); // checksum placeholder: spaces
  h.write(entry.typeflag ?? '0', 156, 1, 'latin1');
  if (entry.linkname !== undefined) h.write(entry.linkname, 157, 100, 'utf8');
  h.write('ustar\0', 257, 6, 'latin1');
  h.write('00', 263, 2, 'latin1');

  let sum = 0;
  for (const byte of h) sum += byte;
  if (entry.breakChecksum === true) sum += 1;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
  return h;
}

/** Pad a buffer up to a whole number of 512-byte blocks. */
function padded(body: Buffer): Buffer {
  const remainder = body.length % BLOCK;
  return remainder === 0 ? body : Buffer.concat([body, Buffer.alloc(BLOCK - remainder)]);
}

/** Build an uncompressed tar archive from entries. */
export function makeTar(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    blocks.push(header(entry));
    if (entry.typeflag !== '5' && entry.body !== undefined) {
      blocks.push(padded(Buffer.from(entry.body, 'utf8')));
    }
  }
  blocks.push(Buffer.alloc(BLOCK * 2)); // end-of-archive marker
  return Buffer.concat(blocks);
}

/** Build a gzipped tar archive from entries. */
export function makeTgz(entries: TarEntry[]): Buffer {
  return gzipSync(makeTar(entries));
}

/**
 * A minimal but realistic npm-style package archive: everything under a
 * `package/` prefix, with a manifest and an ESM entry point.
 */
export function makePackageTgz(
  extra: TarEntry[] = [],
  manifest: Record<string, unknown> = { name: 'fake-pglite', version: '9.9.9', module: 'dist/index.js' },
): Buffer {
  return makeTgz([
    { name: 'package/package.json', body: JSON.stringify(manifest) },
    { name: 'package/dist/index.js', body: 'export const PGlite = function () {};\n' },
    ...extra,
  ]);
}
