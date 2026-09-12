import { describe, expect, test } from 'vitest';

import {
  TRANSFORMS,
  decodeBase64,
  dropBlankLines,
  encodeBase64,
  escapeForJson,
  formatJson,
  joinLines,
  lowerCase,
  minifyJson,
  numberLines,
  reverseLines,
  sortLines,
  titleCase,
  toCamelCase,
  toSnakeCase,
  trimTrailing,
  uniqueLines,
  upperCase,
} from './transforms';

describe('lines', () => {
  test('sorting', () => {
    expect(sortLines('pear\napple\nfig')).toBe('apple\nfig\npear');
  });

  test('sorting is natural, so item10 follows item9', () => {
    expect(sortLines('item10\nitem9')).toBe('item9\nitem10');
  });

  test('reversing', () => {
    expect(reverseLines('a\nb\nc')).toBe('c\nb\na');
  });

  test('removing duplicates keeps the first of each', () => {
    expect(uniqueLines('b\na\nb\nc\na')).toBe('b\na\nc');
  });

  test('removing blank lines takes whitespace-only ones too', () => {
    expect(dropBlankLines('a\n\n  \nb')).toBe('a\nb');
  });

  test('trimming trailing whitespace', () => {
    // Invisible, and in every diff until someone removes it.
    expect(trimTrailing('a   \nb\t\nc')).toBe('a\nb\nc');
  });

  test('trimming leaves leading indentation alone', () => {
    expect(trimTrailing('    indented   ')).toBe('    indented');
  });

  test('joining collapses the whitespace at the joins', () => {
    expect(joinLines('one\n  two  \nthree')).toBe('one two three');
  });

  test('joining drops empty lines rather than leaving double spaces', () => {
    expect(joinLines('one\n\ntwo')).toBe('one two');
  });

  test('numbering lines right-aligns the numbers', () => {
    const numbered = numberLines(Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n'));

    expect(numbered.split('\n')[0]).toBe(' 1  line0');
    expect(numbered.split('\n')[9]).toBe('10  line9');
  });
});

describe('trailing newlines', () => {
  // A transform that quietly strips the last newline makes every file it
  // touches look changed.
  test('are kept where they were', () => {
    expect(sortLines('b\na\n')).toBe('a\nb\n');
    expect(uniqueLines('a\na\n')).toBe('a\n');
    expect(trimTrailing('a  \n')).toBe('a\n');
    expect(numberLines('a\n')).toBe('1  a\n');
  });

  test('are not added where there were none', () => {
    expect(sortLines('b\na')).toBe('a\nb');
    expect(joinLines('a\nb')).toBe('a b');
  });
});

describe('case', () => {
  test('upper and lower', () => {
    expect(upperCase('Hello')).toBe('HELLO');
    expect(lowerCase('Hello')).toBe('hello');
  });

  test('title case capitalises each word', () => {
    expect(titleCase('hello wide world')).toBe('Hello Wide World');
  });

  test('title case leaves existing capitals alone', () => {
    // Lower-casing the rest turns HTTPServer into Httpserver.
    expect(titleCase('HTTPServer handles it')).toBe('HTTPServer Handles It');
  });

  test('snake and kebab to camel', () => {
    expect(toCamelCase('parse_file_name')).toBe('parseFileName');
    expect(toCamelCase('parse-file-name')).toBe('parseFileName');
  });

  test('camel to snake', () => {
    expect(toSnakeCase('parseFileName')).toBe('parse_file_name');
  });

  test('camel to snake leaves a run of capitals together', () => {
    expect(toSnakeCase('parseHTTPResponse')).toBe('parse_http_response');
  });

  test('text with no case to change is unchanged', () => {
    expect(toCamelCase('already')).toBe('already');
    expect(toSnakeCase('already')).toBe('already');
  });
});

describe('converting', () => {
  test('formatting JSON', () => {
    expect(formatJson('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  test('formatting something that is not JSON leaves it alone', () => {
    // Replacing someone's file with an error message is the worse answer.
    expect(formatJson('def f(): pass')).toBe('def f(): pass');
  });

  test('minifying JSON', () => {
    expect(minifyJson('{\n  "a": 1\n}')).toBe('{"a":1}');
  });

  test('escaping as a JSON string', () => {
    expect(escapeForJson('say "hi"\n')).toBe('"say \\"hi\\"\\n"');
  });

  test('base64 round trips', () => {
    expect(decodeBase64(encodeBase64('hello world'))).toBe('hello world');
  });

  test('base64 handles characters above U+00FF', () => {
    // btoa alone throws on these.
    expect(decodeBase64(encodeBase64('héllo ✅ 日本'))).toBe('héllo ✅ 日本');
  });

  test('decoding something that is not base64 leaves it alone', () => {
    expect(decodeBase64('not base64 at all!')).toBe('not base64 at all!');
  });

  test('an empty input survives every transform', () => {
    for (const transform of TRANSFORMS) {
      expect(typeof transform.run('')).toBe('string');
    }
  });
});

describe('the list', () => {
  test('every transform has a distinct id', () => {
    expect(new Set(TRANSFORMS.map((entry) => entry.id)).size).toBe(TRANSFORMS.length);
  });

  test('every id is namespaced so it cannot collide with a command', () => {
    expect(TRANSFORMS.every((entry) => entry.id.startsWith('text.'))).toBe(true);
  });

  test('every transform has a title and a category', () => {
    expect(TRANSFORMS.every((entry) => entry.title && entry.category)).toBe(true);
  });
});
