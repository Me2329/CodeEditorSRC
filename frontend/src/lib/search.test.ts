import { describe, expect, test } from 'vitest';

import {
  DEFAULT_OPTIONS,
  MATCH_LIMIT,
  compile,
  countMatches,
  escapeRegex,
  replaceInFile,
  replaceInWorkspace,
  searchWorkspace,
} from './search';
import type { VirtualFile } from './types';

const file = (id: string, name: string, content: string): VirtualFile => ({
  id,
  name,
  language: 'python',
  content,
});

const WORKSPACE: VirtualFile[] = [
  file('1', 'main.py', 'def parse(text):\n    return text\n\nparse("x")\n'),
  file('2', 'util.py', 'def helper():\n    pass\n'),
  file('3', 'notes.md', 'Parse the input.\n'),
];

const options = (overrides: Partial<typeof DEFAULT_OPTIONS> = {}) => ({
  ...DEFAULT_OPTIONS,
  ...overrides,
});

describe('compiling a query', () => {
  test('plain text is escaped so punctuation is literal', () => {
    const pattern = compile('a.b', options())!;
    expect(pattern.test('a.b')).toBe(true);
    pattern.lastIndex = 0;
    expect(pattern.test('axb')).toBe(false);
  });

  test('regex mode leaves the pattern alone', () => {
    expect(compile('a.b', options({ regex: true }))!.test('axb')).toBe(true);
  });

  test('an invalid pattern returns null rather than throwing', () => {
    // This is the normal state while someone is typing one.
    expect(compile('a(', options({ regex: true }))).toBeNull();
  });

  test('a pattern matching the empty string is refused', () => {
    // It has no useful meaning as a search and would loop forever.
    expect(compile('x*', options({ regex: true }))).toBeNull();
  });

  test('an empty query matches nothing', () => {
    expect(compile('', options())).toBeNull();
  });

  test('whole word requires a boundary', () => {
    const pattern = compile('parse', options({ wholeWord: true }))!;
    expect(pattern.test('parse(')).toBe(true);
    pattern.lastIndex = 0;
    expect(pattern.test('reparsed')).toBe(false);
  });

  test('escaping covers every metacharacter', () => {
    const escaped = escapeRegex('.*+?^${}()|[]\\');
    expect(() => new RegExp(escaped)).not.toThrow();
    expect(new RegExp(escaped).test('.*+?^${}()|[]\\')).toBe(true);
  });
});

describe('searching the workspace', () => {
  test('matches are found across files', () => {
    const results = searchWorkspace(WORKSPACE, 'parse');
    expect(results.map((entry) => entry.fileName)).toEqual(['main.py', 'notes.md']);
  });

  test('case sensitivity is respected', () => {
    const results = searchWorkspace(WORKSPACE, 'Parse', options({ caseSensitive: true }));
    expect(results.map((entry) => entry.fileName)).toEqual(['notes.md']);
  });

  test('line and column are one-based, as an editor shows them', () => {
    const [first] = searchWorkspace(WORKSPACE, 'return');
    expect(first!.matches[0]).toMatchObject({ line: 2, column: 5 });
  });

  test('the whole line comes back for context', () => {
    const [first] = searchWorkspace(WORKSPACE, 'return');
    expect(first!.matches[0]!.text).toBe('    return text');
  });

  test('highlight offsets point at the match', () => {
    const [first] = searchWorkspace(WORKSPACE, 'text');
    const match = first!.matches[0]!;
    expect(match.text.slice(match.start, match.end)).toBe('text');
  });

  test('several matches on one line are all found', () => {
    const results = searchWorkspace([file('1', 'a.py', 'x x x')], 'x');
    expect(results[0]!.matches).toHaveLength(3);
  });

  test('a match at the start of a line is not skipped', () => {
    // A sticky cursor carried across lines would lose this one.
    const results = searchWorkspace([file('1', 'a.py', 'aa\naa')], 'aa');
    expect(results[0]!.matches.map((match) => match.line)).toEqual([1, 2]);
  });

  test('nothing found is an empty list rather than an error', () => {
    expect(searchWorkspace(WORKSPACE, 'nonexistent')).toEqual([]);
  });

  test('the total is counted across files', () => {
    expect(countMatches(searchWorkspace(WORKSPACE, 'parse'))).toBe(3);
  });

  test('a runaway pattern is capped', () => {
    const huge = file('1', 'big.py', 'a\n'.repeat(MATCH_LIMIT * 2));
    expect(countMatches(searchWorkspace([huge], 'a'))).toBeLessThanOrEqual(MATCH_LIMIT);
  });
});

describe('replacing', () => {
  test('plain text is replaced', () => {
    expect(replaceInFile('a b a', 'a', 'X')).toBe('X b X');
  });

  test('a dollar sign in a plain replacement is literal', () => {
    // Otherwise a user replacing with "$1" gets a capture group they never asked for.
    expect(replaceInFile('cost', 'cost', '$1')).toBe('$1');
  });

  test('capture groups work in regex mode', () => {
    expect(
      replaceInFile('parse_text', '(\\w+)_(\\w+)', '$2_$1', options({ regex: true })),
    ).toBe('text_parse');
  });

  test('an invalid pattern leaves the content untouched', () => {
    expect(replaceInFile('abc', 'a(', 'X', options({ regex: true }))).toBe('abc');
  });

  test('only the files that change are returned', () => {
    const changed = replaceInWorkspace(WORKSPACE, 'parse', 'read');

    expect(changed.map((entry) => entry.name)).toEqual(['main.py', 'notes.md']);
    expect(changed[0]!.content).toContain('def read(text)');
  });

  test('an identical case-sensitive replacement changes nothing', () => {
    expect(replaceInWorkspace(WORKSPACE, 'parse', 'parse', options({ caseSensitive: true })))
      .toEqual([]);
  });

  test('a case-insensitive replacement normalises case, which is a real change', () => {
    // Searching "parse" matches "Parse", so replacing with "parse" rewrites it.
    // Surprising at first glance and correct: the file really does differ.
    const changed = replaceInWorkspace(WORKSPACE, 'parse', 'parse');

    expect(changed.map((entry) => entry.name)).toEqual(['notes.md']);
    expect(changed[0]!.content).toContain('parse the input');
  });

  test('case sensitivity applies to replacement too', () => {
    const changed = replaceInWorkspace(WORKSPACE, 'Parse', 'Read', options({ caseSensitive: true }));
    expect(changed.map((entry) => entry.name)).toEqual(['notes.md']);
  });
});
