import { describe, expect, test } from 'vitest';

import {
  TEXT_ACTIONS,
  fromBase64,
  joinLines,
  numberLines,
  removeEmptyLines,
  reverseLines,
  sortLines,
  sortLinesNaturally,
  toBase64,
  toSnakeCase,
  toTitleCase,
  trimTrailingWhitespace,
  uniqueLines,
} from './text-toolkit';

describe('the trailing newline', () => {
  // Sorting a file that ends with a newline used to put an empty line at the
  // top and drop the newline: the empty string after the last one sorted first
  // and then joined like any other line.
  test('survives sorting', () => {
    expect(sortLines('b\na\n')).toBe('a\nb\n');
  });

  test('survives every line operation', () => {
    for (const transform of [reverseLines, uniqueLines, trimTrailingWhitespace, numberLines]) {
      expect(transform('b\na\n').endsWith('\n')).toBe(true);
      expect(transform('b\na\n').startsWith('\n')).toBe(false);
    }
  });

  test('is not added where there was none', () => {
    expect(sortLines('b\na')).toBe('a\nb');
    expect(reverseLines('a\nb')).toBe('b\na');
  });

  test('a file that is only a newline stays that way', () => {
    expect(sortLines('\n')).toBe('\n');
  });
});

describe('lines', () => {
  test('sorting', () => {
    expect(sortLines('pear\napple')).toBe('apple\npear');
  });

  test('sorting naturally puts item9 before item10', () => {
    expect(sortLinesNaturally('item10\nitem9')).toBe('item9\nitem10');
  });

  test('duplicates go, the first of each staying', () => {
    expect(uniqueLines('b\na\nb')).toBe('b\na');
  });

  test('empty lines go', () => {
    expect(removeEmptyLines('a\n\n  \nb')).toBe('a\nb');
  });

  test('trailing whitespace goes and indentation stays', () => {
    expect(trimTrailingWhitespace('    a   ')).toBe('    a');
  });

  test('numbering right-aligns', () => {
    const numbered = numberLines(Array.from({ length: 10 }, (_, i) => `x${i}`).join('\n'));

    expect(numbered.split('\n')[0]).toBe(' 1  x0');
    expect(numbered.split('\n')[9]).toBe('10  x9');
  });

  test('joining puts them on one line', () => {
    expect(joinLines('a\nb\nc')).toBe('a b c');
  });
});

describe('case', () => {
  test('title case capitalises each word', () => {
    expect(toTitleCase('hello wide world')).toBe('Hello Wide World');
  });

  test('title case leaves what is already capitalised alone', () => {
    // Lower-casing the rest is what most implementations do, and it turns
    // HTTPServer into Httpserver.
    expect(toTitleCase('HTTPServer handles it')).toBe('HTTPServer Handles It');
  });

  test('snake case breaks a run of capitals at the last one', () => {
    expect(toSnakeCase('parseHTTPResponse')).toBe('parse_http_response');
  });
});

describe('encoding', () => {
  test('base64 round trips', () => {
    expect(fromBase64(toBase64('hello world'))).toBe('hello world');
  });

  test('base64 handles characters above U+00FF', () => {
    expect(fromBase64(toBase64('héllo ✅ 日本'))).toBe('héllo ✅ 日本');
  });
});

describe('the action list', () => {
  test('every action has a distinct id', () => {
    expect(new Set(TEXT_ACTIONS.map((action) => action.id)).size).toBe(TEXT_ACTIONS.length);
  });

  test('every action survives an empty file', () => {
    for (const action of TEXT_ACTIONS) {
      expect(typeof action.transform('')).toBe('string');
    }
  });

  test('every action has a title and a category', () => {
    expect(TEXT_ACTIONS.every((action) => action.title && action.category)).toBe(true);
  });
});
