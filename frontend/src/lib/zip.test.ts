import { describe, expect, test } from 'vitest';

import { crc32, dosDateTime, namesIn, safeName, zipFiles } from './zip';

const bytes = (text: string) => new TextEncoder().encode(text);
const AT = new Date(2024, 4, 17, 13, 42, 30);

describe('the checksum', () => {
  // Against values from an independent implementation, because a CRC that
  // agrees only with itself is a CRC that no unzip will accept.
  test('matches the reference for an empty input', () => {
    expect(crc32(bytes(''))).toBe(0);
  });

  test('matches the reference for a short input', () => {
    expect(crc32(bytes('hello'))).toBe(0x3610a686);
  });

  test('matches the reference for the usual sentence', () => {
    expect(crc32(bytes('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });

  test('matches the reference for source with newlines', () => {
    expect(crc32(bytes('def main():\n    pass\n'))).toBe(0xd098835f);
  });

  test('is unsigned', () => {
    // A signed result here would be written as a negative and read as garbage.
    expect(crc32(bytes('ÿÿÿÿ'))).toBeGreaterThanOrEqual(0);
  });
});

describe('the timestamp', () => {
  test('packs a date the way DOS did', () => {
    const { time, date } = dosDateTime(AT);

    expect(date).toBe(((2024 - 1980) << 9) | (5 << 5) | 17);
    expect(time).toBe((13 << 11) | (42 << 5) | 15);
  });

  test('a date before the format existed is clamped, not refused', () => {
    // A wrong timestamp is a curiosity; a failed export is a lost workspace.
    const { date } = dosDateTime(new Date(1971, 0, 1));

    expect(date >> 9).toBe(0);
  });
});

describe('names', () => {
  test('a plain name is left alone', () => {
    expect(safeName('src/main.py')).toBe('src/main.py');
  });

  test('a name that climbs out of the directory cannot', () => {
    expect(safeName('../../etc/passwd')).toBe('etc/passwd');
  });

  test('backslashes become separators', () => {
    expect(safeName('src\\lib\\util.ts')).toBe('src/lib/util.ts');
  });

  test('a leading slash is dropped', () => {
    expect(safeName('/absolute.txt')).toBe('absolute.txt');
  });

  test('a name that is nothing but dots still gets one', () => {
    expect(safeName('../..')).toBe('file');
  });
});

describe('the archive', () => {
  test('starts with a local file header', () => {
    const archive = zipFiles([{ name: 'a.txt', content: 'hello' }], AT);
    const view = new DataView(archive.buffer);

    expect(view.getUint32(0, true)).toBe(0x04034b50);
  });

  test('ends with the end-of-directory record', () => {
    const archive = zipFiles([{ name: 'a.txt', content: 'hello' }], AT);
    const view = new DataView(archive.buffer);

    expect(view.getUint32(archive.length - 22, true)).toBe(0x06054b50);
  });

  test('every entry is listed', () => {
    const archive = zipFiles(
      [
        { name: 'main.py', content: 'print(1)\n' },
        { name: 'lib/util.py', content: 'def f():\n    pass\n' },
        { name: 'README.md', content: '# Notes\n' },
      ],
      AT,
    );

    expect(namesIn(archive)).toEqual(['main.py', 'lib/util.py', 'README.md']);
  });

  test('the entry count is recorded twice and agrees', () => {
    const archive = zipFiles([{ name: 'a', content: '1' }, { name: 'b', content: '2' }], AT);
    const view = new DataView(archive.buffer);
    const end = archive.length - 22;

    expect(view.getUint16(end + 8, true)).toBe(2);
    expect(view.getUint16(end + 10, true)).toBe(2);
  });

  test('the directory offset points at the directory', () => {
    // Readers use the central directory, so a wrong offset is an archive that
    // looks fine and opens empty.
    const archive = zipFiles([{ name: 'a.txt', content: 'hello' }], AT);
    const view = new DataView(archive.buffer);
    const offset = view.getUint32(archive.length - 22 + 16, true);

    expect(view.getUint32(offset, true)).toBe(0x02014b50);
  });

  test('the stored size is the real size', () => {
    const content = 'x'.repeat(1000);
    const archive = zipFiles([{ name: 'big.txt', content }], AT);
    const view = new DataView(archive.buffer);

    expect(view.getUint32(18, true)).toBe(1000);
    expect(view.getUint32(22, true)).toBe(1000);
  });

  test('content is stored verbatim and can be read back', () => {
    const archive = zipFiles([{ name: 'a.txt', content: 'hello' }], AT);
    const nameLength = new DataView(archive.buffer).getUint16(26, true);
    const start = 30 + nameLength;

    expect(new TextDecoder().decode(archive.subarray(start, start + 5))).toBe('hello');
  });

  test('non-ASCII names and content survive', () => {
    // The UTF-8 flag is set, so a reader knows not to guess an ancient codepage.
    const archive = zipFiles([{ name: 'café/ünïcode.txt', content: 'héllo ✅' }], AT);

    expect(namesIn(archive)).toEqual(['café/ünïcode.txt']);
    expect(new DataView(archive.buffer).getUint16(6, true) & 0x0800).toBe(0x0800);
  });

  test('an empty file is a valid entry', () => {
    const archive = zipFiles([{ name: 'empty.txt', content: '' }], AT);

    expect(namesIn(archive)).toEqual(['empty.txt']);
  });

  test('an archive with nothing in it is still a valid archive', () => {
    const archive = zipFiles([], AT);

    expect(archive.length).toBe(22);
    expect(new DataView(archive.buffer).getUint32(0, true)).toBe(0x06054b50);
  });

  test('the checksum in the header is the checksum of the content', () => {
    const archive = zipFiles([{ name: 'a.txt', content: 'hello' }], AT);

    expect(new DataView(archive.buffer).getUint32(14, true)).toBe(0x3610a686);
  });
});
