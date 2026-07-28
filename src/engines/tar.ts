import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { gunzip as gunzipCb } from 'node:zlib';

const gunzip = promisify(gunzipCb);

/** Size of a tar header/data block. */
const BLOCK = 512;

/** Byte offsets within a POSIX ustar header block. */
const OFF = {
  name: 0,
  size: 124,
  checksum: 148,
  typeflag: 156,
  magic: 257,
  prefix: 345,
} as const;

/**
 * Tar entry types we accept. Everything else — symlinks, hardlinks, character
 * and block devices, FIFOs — is refused rather than skipped: an npm tarball has
 * no legitimate use for them, and they are the part of the format an attacker
 * would reach for. (Verified: the PGlite tarballs are 342 regular files and
 * nothing else.)
 */
const TYPE = {
  file: '0',
  fileAlt: '\0',
  contiguous: '7',
  directory: '5',
  paxNext: 'x',
  paxGlobal: 'g',
  gnuLongName: 'L',
} as const;

/** Raised when an archive is malformed or contains a refused entry. */
export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarError';
  }
}

/** Read a NUL/space-terminated octal field. */
function readOctal(header: Buffer, offset: number, length: number): number {
  // The high bit marks GNU base-256 encoding, used only for values too large for
  // the octal field (>8 GiB). We never expect one; refuse rather than misparse.
  if ((header[offset] & 0x80) !== 0) {
    throw new TarError('Unsupported base-256 numeric field in tar header');
  }
  const raw = header
    .subarray(offset, offset + length)
    .toString('latin1')
    .replace(/\0/g, ' ')
    .trim();
  if (raw === '') return 0;
  if (!/^[0-7]+$/.test(raw)) throw new TarError(`Malformed octal field: ${JSON.stringify(raw)}`);
  return Number.parseInt(raw, 8);
}

/** Read a NUL-terminated string field. */
function readString(header: Buffer, offset: number, length: number): string {
  const raw = header.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

/** True when a block is entirely zero (the end-of-archive marker). */
function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

/**
 * Verify the header checksum: the sum of every header byte with the checksum
 * field itself read as spaces. Catches desynchronization, so a corrupt archive
 * fails here instead of being interpreted as attacker-chosen headers.
 */
function verifyChecksum(header: Buffer): void {
  const expected = readOctal(header, OFF.checksum, 8);
  let signed = 0;
  let unsigned = 0;
  for (let i = 0; i < BLOCK; i++) {
    const inChecksumField = i >= OFF.checksum && i < OFF.checksum + 8;
    const byte = inChecksumField ? 0x20 : header[i];
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  // Historic writers disagreed on signedness; accept either reading.
  if (unsigned !== expected && signed !== expected) {
    throw new TarError(
      `Tar header checksum mismatch (expected ${expected.toString()}, got ${unsigned.toString()})`,
    );
  }
}

/**
 * Turn an archive entry name into a path relative to the extraction root, or
 * return null when the entry should be skipped (nothing left after stripping).
 *
 * @throws {@link TarError} when the name attempts to escape the root.
 */
export function safeEntryPath(name: string, stripComponents: number): string | null {
  if (name.includes('\0')) throw new TarError(`Tar entry name contains a NUL byte`);
  // A backslash is a legal POSIX filename character but a separator on Windows.
  // No npm tarball uses one, so refusing keeps extraction identical everywhere.
  if (name.includes('\\')) throw new TarError(`Tar entry name contains a backslash: ${name}`);
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new TarError(`Absolute path in tar entry: ${name}`);
  }
  const parts = name.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.includes('..')) throw new TarError(`Path traversal in tar entry: ${name}`);
  const stripped = parts.slice(stripComponents);
  return stripped.length === 0 ? null : stripped.join('/');
}

/** Parse a pax extended-header record block for a `path=` override. */
function paxPath(data: Buffer): string | undefined {
  const text = data.toString('utf8');
  // Records are "<len> <key>=<value>\n".
  const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text);
  return match?.[1];
}

/**
 * Extract a gzipped tar archive into `dest`.
 *
 * Written by hand rather than shelling out to `tar` or taking an npm dependency:
 * this package has zero runtime dependencies and that is worth keeping, and
 * hand-rolling makes the security rules explicit and testable instead of relying
 * on whichever `tar` implementation happens to be on PATH.
 *
 * File modes from the archive are deliberately **not** applied — the extracted
 * tree only needs to be readable, and honoring attacker-supplied modes (setuid,
 * unreadable) buys nothing.
 *
 * @param gzipped - The raw `.tgz` bytes.
 * @param dest - Directory to extract into; created if absent.
 * @param stripComponents - Leading path components to drop (1 for npm's
 * `package/` prefix).
 * @throws {@link TarError} on a malformed archive, a refused entry type, or any
 * path that would escape `dest`.
 */
export async function extractTarGz(
  gzipped: Buffer,
  dest: string,
  stripComponents = 0,
): Promise<number> {
  const buf = await gunzip(gzipped);
  const root = resolve(dest);
  await mkdir(root, { recursive: true });

  let offset = 0;
  let filesWritten = 0;
  let nextNameOverride: string | undefined;

  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) break; // end of archive
    verifyChecksum(header);

    const size = readOctal(header, OFF.size, 12);
    const typeflag = String.fromCharCode(header[OFF.typeflag]);
    const prefix = readString(header, OFF.prefix, 155);
    const base = readString(header, OFF.name, 100);
    const rawName = nextNameOverride ?? (prefix === '' ? base : `${prefix}/${base}`);
    nextNameOverride = undefined;

    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) throw new TarError('Tar entry extends past end of archive');
    const data = buf.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    switch (typeflag) {
      case TYPE.paxNext: {
        nextNameOverride = paxPath(data);
        continue;
      }
      case TYPE.gnuLongName: {
        nextNameOverride = data.toString('utf8').replace(/\0+$/, '');
        continue;
      }
      case TYPE.paxGlobal:
        continue; // global metadata, nothing to write
      case TYPE.file:
      case TYPE.fileAlt:
      case TYPE.contiguous: {
        const rel = safeEntryPath(rawName, stripComponents);
        if (rel === null) continue;
        const full = resolve(root, rel);
        // Belt and braces: even with the name checks above, never write outside.
        if (full !== root && !full.startsWith(root + sep)) {
          throw new TarError(`Tar entry escapes extraction root: ${rawName}`);
        }
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, data);
        filesWritten++;
        continue;
      }
      case TYPE.directory: {
        const rel = safeEntryPath(rawName, stripComponents);
        if (rel === null) continue;
        const full = resolve(root, rel);
        if (full !== root && !full.startsWith(root + sep)) {
          throw new TarError(`Tar entry escapes extraction root: ${rawName}`);
        }
        await mkdir(full, { recursive: true });
        continue;
      }
      default:
        throw new TarError(
          `Refusing tar entry of type '${typeflag}' (${rawName}) — ` +
            `only regular files and directories are extracted`,
        );
    }
  }

  if (filesWritten === 0) throw new TarError(`Archive contained no files under ${join(dest)}`);
  return filesWritten;
}
