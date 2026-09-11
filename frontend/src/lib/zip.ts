/**
 * Writing a zip file, by hand, in the browser.
 *
 * The workspace already exports as JSON, which is fine for bringing it back
 * into this editor and useless for anything else. A zip is what every operating
 * system already knows how to open, what a colleague can read without being
 * told what CodeCraft Studio is, and what a build system can consume.
 *
 * No library. A zip of stored (uncompressed) entries is three record types and
 * a CRC, and pulling in a compression library to avoid writing ninety lines
 * would cost more bytes in the bundle than compression would ever save on a
 * workspace of source files. Source is small; the download is over localhost or
 * a LAN more often than not.
 *
 * The format, briefly: each file is written as a local header followed by its
 * bytes, then a central directory repeating the headers with the offset of
 * each, then an end-of-central-directory record saying where that starts. The
 * central directory is what readers actually use, which is why a zip can be
 * appended to and why the offsets have to be right.
 */

export interface ZipEntry {
  /** Path inside the archive. Forward slashes, no leading slash. */
  name: string;
  content: string;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_DIRECTORY = 0x06054b50;

/** Bit 11: names and comments are UTF-8 rather than the ancient default. */
const UTF8_FLAG = 0x0800;

/** Regular file, rw-r--r--, in the high half of the external attributes. */
const FILE_MODE = 0o100644 << 16;

let crcTable: Uint32Array | null = null;

function table(): Uint32Array {
  if (crcTable) return crcTable;
  const built = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      // The reversed polynomial, which is the convention zip uses.
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    built[index] = value >>> 0;
  }
  crcTable = built;
  return built;
}

/** CRC-32 as zip computes it. */
export function crc32(bytes: Uint8Array): number {
  const lookup = table();
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = lookup[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A date in the MS-DOS packing zip has used since 1989.
 *
 * Two seconds of resolution and no year before 1980, neither of which matters
 * for a file created moments ago. Out-of-range dates are clamped rather than
 * throwing: a wrong timestamp on an archive is a curiosity, a failed export is
 * a lost workspace.
 */
export function dosDateTime(when: Date): { time: number; date: number } {
  const year = Math.max(1980, Math.min(when.getFullYear(), 2107));
  const time =
    (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  return { time, date };
}

/** A growable little-endian byte writer, which is all the format needs. */
class Writer {
  private bytes: number[] = [];

  get length(): number {
    return this.bytes.length;
  }

  u16(value: number): void {
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff);
  }

  u32(value: number): void {
    this.bytes.push(
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    );
  }

  raw(data: Uint8Array): void {
    for (let index = 0; index < data.length; index += 1) this.bytes.push(data[index]!);
  }

  done(): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.bytes);
  }
}

/**
 * Make a path safe to put in an archive.
 *
 * A zip entry whose name climbs out of the directory it is extracted into is
 * the oldest trick there is. This archive is written from names the user typed,
 * so it is not an attack so much as an accident waiting to happen, and the fix
 * is the same either way.
 */
export function safeName(name: string): string {
  return (
    name
      .replace(/\\/g, '/')
      .split('/')
      .filter((part) => part && part !== '.' && part !== '..')
      .join('/') || 'file'
  );
}

/** Build a zip archive of stored entries. */
export function zipFiles(
  entries: readonly ZipEntry[],
  when: Date = new Date(),
): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(when);

  const body = new Writer();
  const directory = new Writer();
  let count = 0;

  for (const entry of entries) {
    const name = encoder.encode(safeName(entry.name));
    const content = encoder.encode(entry.content);
    const checksum = crc32(content);
    const offset = body.length;

    body.u32(LOCAL_HEADER);
    body.u16(20); // The version needed to extract: 2.0, which is stored or deflated.
    body.u16(UTF8_FLAG);
    body.u16(0); // Stored.
    body.u16(time);
    body.u16(date);
    body.u32(checksum);
    body.u32(content.length); // Compressed size, which for stored is the size.
    body.u32(content.length);
    body.u16(name.length);
    body.u16(0); // No extra field.
    body.raw(name);
    body.raw(content);

    directory.u32(CENTRAL_HEADER);
    directory.u16(20); // Version made by.
    directory.u16(20); // Version needed.
    directory.u16(UTF8_FLAG);
    directory.u16(0);
    directory.u16(time);
    directory.u16(date);
    directory.u32(checksum);
    directory.u32(content.length);
    directory.u32(content.length);
    directory.u16(name.length);
    directory.u16(0); // Extra.
    directory.u16(0); // Comment.
    directory.u16(0); // Disk number.
    directory.u16(0); // Internal attributes.
    directory.u32(FILE_MODE);
    directory.u32(offset);
    directory.raw(name);

    count += 1;
  }

  const out = new Writer();
  out.raw(body.done());
  const directoryOffset = out.length;
  out.raw(directory.done());

  out.u32(END_OF_DIRECTORY);
  out.u16(0); // This disk.
  out.u16(0); // The disk the directory starts on.
  out.u16(count);
  out.u16(count);
  out.u32(directory.length);
  out.u32(directoryOffset);
  out.u16(0); // No archive comment.

  return out.done();
}

/**
 * Read the names back out of an archive.
 *
 * Here so the format can be checked against itself rather than against a
 * comment, and because a writer with no reader is a writer nobody has read.
 */
export function namesIn(archive: Uint8Array): string[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const decoder = new TextDecoder();
  const names: string[] = [];

  let offset = 0;
  while (offset + 30 <= archive.length && view.getUint32(offset, true) === LOCAL_HEADER) {
    const compressed = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    names.push(decoder.decode(archive.subarray(offset + 30, offset + 30 + nameLength)));
    offset += 30 + nameLength + extraLength + compressed;
  }

  return names;
}
