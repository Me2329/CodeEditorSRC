import { describe, expect, it } from 'vitest';

import { parseArgs } from './RunConfigPanel';

describe('parseArgs', () => {
  it('splits on whitespace', () => {
    expect(parseArgs('--verbose -n 42')).toEqual(['--verbose', '-n', '42']);
  });

  it('keeps a double-quoted value as one argument', () => {
    expect(parseArgs('--name "two words"')).toEqual(['--name', 'two words']);
  });

  it('keeps a single-quoted value as one argument', () => {
    expect(parseArgs("--path 'my file.txt'")).toEqual(['--path', 'my file.txt']);
  });

  it('honours backslash escapes outside single quotes', () => {
    expect(parseArgs('a\\ b c')).toEqual(['a b', 'c']);
    expect(parseArgs("'a\\ b'")).toEqual(['a\\ b']);
  });

  it('never expands shell syntax', () => {
    // These must reach the program as literal text, not be evaluated.
    expect(parseArgs('$(whoami) `id` $HOME *.txt a;b')).toEqual([
      '$(whoami)',
      '`id`',
      '$HOME',
      '*.txt',
      'a;b',
    ]);
  });

  it('preserves an explicitly empty argument', () => {
    expect(parseArgs('a "" b')).toEqual(['a', '', 'b']);
  });

  it('returns nothing for empty or whitespace-only input', () => {
    expect(parseArgs('')).toEqual([]);
    expect(parseArgs('   \t  ')).toEqual([]);
  });

  it('tolerates an unclosed quote instead of dropping the text', () => {
    expect(parseArgs('--name "unterminated')).toEqual(['--name', 'unterminated']);
  });

  it('handles adjacent quoted and unquoted parts', () => {
    expect(parseArgs('--opt="a b"')).toEqual(['--opt=a b']);
  });

  it('treats newlines as separators', () => {
    expect(parseArgs('one\ntwo')).toEqual(['one', 'two']);
  });
});
