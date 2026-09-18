/**
 * Line and text operations, where off-by-one lives.
 *
 * The cases worth having are the awkward ones: the last line with no newline
 * after it, a range that runs past the end, a file that is entirely blank, and
 * an indent that does not match what the file actually uses.
 */

import { describe, expect, it } from 'vitest';

import {
  changeCase,
  changeNameStyle,
  convertIndentation,
  deleteLines,
  duplicateLines,
  duplicateRange,
  ensureFinalNewline,
  joinLines,
  joinRange,
  moveLines,
  overLines,
  removeBlankLines,
  reverseLines,
  shiftIndentation,
  sortLines,
  splitLines,
  statisticsOf,
  trimTrailingWhitespace,
  uniqueLines,
  words,
} from './transforms';

describe('splitLines and joinLines', () => {
  it('remember a trailing newline', () => {
    expect(splitLines('a\nb\n')).toEqual({ lines: ['a', 'b'], trailingNewline: true });
    expect(splitLines('a\nb')).toEqual({ lines: ['a', 'b'], trailingNewline: false });
  });

  it('round-trip either way', () => {
    for (const text of ['a\nb\n', 'a\nb', '', '\n', 'one']) {
      const { lines, trailingNewline } = splitLines(text);
      expect(joinLines(lines, trailingNewline)).toBe(text);
    }
  });

  it('treat an empty file as one empty line', () => {
    expect(splitLines('')).toEqual({ lines: [''], trailingNewline: false });
  });
});

describe('overLines', () => {
  it('changes only the range it was given', () => {
    const result = overLines('a\nb\nc\nd', 2, 3, (lines) => lines.map((l) => l.toUpperCase()));
    expect(result).toBe('a\nB\nC\nd');
  });

  it('clamps a range that runs past the end', () => {
    expect(overLines('a\nb', 1, 99, (lines) => lines.map((l) => `${l}!`))).toBe('a!\nb!');
  });

  it('accepts an inverted range, which is a selection made upwards', () => {
    expect(overLines('a\nb\nc', 3, 1, () => ['x'])).toBe('x');
  });

  it('leaves the text alone when the range starts past the end', () => {
    expect(overLines('a\nb', 9, 10, () => ['x'])).toBe('a\nb');
  });

  it('keeps the trailing newline', () => {
    expect(overLines('a\nb\n', 1, 1, () => ['z'])).toBe('z\nb\n');
  });
});

describe('sortLines', () => {
  it('sorts the way a person reading the list would', () => {
    // Numeric, so item10 comes after item9 rather than after item1.
    expect(sortLines(['item10', 'item9', 'item1'])).toEqual(['item1', 'item9', 'item10']);
  });

  it('puts accented letters next to their plain form', () => {
    expect(sortLines(['zebra', 'äpfel', 'apple'])).toEqual(['äpfel', 'apple', 'zebra']);
  });

  it('sorts descending when asked', () => {
    expect(sortLines(['a', 'b', 'c'], { descending: true })).toEqual(['c', 'b', 'a']);
  });

  it('can be told to mind case', () => {
    const sorted = sortLines(['b', 'A'], { caseSensitive: true });
    expect(sorted).toHaveLength(2);
  });

  it('does not modify its input', () => {
    const original = ['c', 'a'];
    sortLines(original);
    expect(original).toEqual(['c', 'a']);
  });
});

describe('uniqueLines', () => {
  it('keeps the first of each and the original order', () => {
    expect(uniqueLines(['b', 'a', 'b', 'c', 'a'])).toEqual(['b', 'a', 'c']);
  });

  it('ignores case by default', () => {
    expect(uniqueLines(['Save', 'save'])).toEqual(['Save']);
  });

  it('minds case when asked', () => {
    expect(uniqueLines(['Save', 'save'], { caseSensitive: true })).toEqual(['Save', 'save']);
  });

  it('can ignore surrounding whitespace', () => {
    expect(uniqueLines(['  a', 'a  '], { ignoreWhitespace: true })).toEqual(['  a']);
  });
});

describe('duplicateLines', () => {
  it('keeps only what appeared more than once', () => {
    expect(duplicateLines(['a', 'b', 'a', 'c', 'b', 'a'])).toEqual(['a', 'b']);
  });

  it('is empty when everything is unique', () => {
    expect(duplicateLines(['a', 'b'])).toEqual([]);
  });
});

describe('removeBlankLines', () => {
  it('removes every blank line', () => {
    expect(removeBlankLines(['a', '', '  ', 'b'])).toEqual(['a', 'b']);
  });

  it('collapses runs to one when asked', () => {
    expect(removeBlankLines(['a', '', '', 'b'], { collapse: true })).toEqual(['a', '', 'b']);
  });

  it('collapsing does not leave a blank line at the top', () => {
    expect(removeBlankLines(['', '', 'a'], { collapse: true })).toEqual(['a']);
  });

  it('treats whitespace-only lines as blank', () => {
    expect(removeBlankLines(['\t', ' '])).toEqual([]);
  });
});

describe('moveLines', () => {
  it('moves a line up and reports where it landed', () => {
    expect(moveLines('a\nb\nc', 2, 2, 'up')).toEqual({ text: 'b\na\nc', from: 1, to: 1 });
  });

  it('moves a run down together', () => {
    expect(moveLines('a\nb\nc\nd', 1, 2, 'down')).toEqual({
      text: 'c\na\nb\nd',
      from: 2,
      to: 3,
    });
  });

  it('does nothing at the top', () => {
    // Wrapping round to the bottom is never what the key was pressed for.
    expect(moveLines('a\nb', 1, 1, 'up')).toEqual({ text: 'a\nb', from: 1, to: 1 });
  });

  it('does nothing at the bottom', () => {
    expect(moveLines('a\nb', 2, 2, 'down')).toEqual({ text: 'a\nb', from: 2, to: 2 });
  });

  it('keeps the trailing newline', () => {
    expect(moveLines('a\nb\n', 2, 2, 'up').text).toBe('b\na\n');
  });
});

describe('duplicateRange and deleteLines', () => {
  it('copies a run directly below itself', () => {
    expect(duplicateRange('a\nb\nc', 1, 2)).toBe('a\nb\na\nb\nc');
  });

  it('deletes a run outright', () => {
    expect(deleteLines('a\nb\nc', 2, 2)).toBe('a\nc');
  });

  it('deleting every line leaves an empty file', () => {
    expect(deleteLines('a\nb', 1, 2)).toBe('');
  });
});

describe('joinRange', () => {
  it('joins lines with one space and drops their indentation', () => {
    expect(joinRange('a\n    b\n  c', 1, 3)).toBe('a b c');
  });

  it('leaves a single line alone', () => {
    expect(joinRange('only', 1, 1)).toBe('only');
  });

  it('does not double the space on a blank line', () => {
    expect(joinRange('a\n\nb', 1, 3)).toBe('a b');
  });

  it('joins onto an empty first line without a leading space', () => {
    expect(joinRange('\nb', 1, 2)).toBe('b');
  });
});

describe('trimTrailingWhitespace and ensureFinalNewline', () => {
  it('trims spaces and tabs at the end of a line', () => {
    expect(trimTrailingWhitespace(['a  ', 'b\t', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('leaves leading whitespace alone', () => {
    expect(trimTrailingWhitespace(['  a  '])).toEqual(['  a']);
  });

  it('ends a file with exactly one newline', () => {
    expect(ensureFinalNewline('a')).toBe('a\n');
    expect(ensureFinalNewline('a\n')).toBe('a\n');
    expect(ensureFinalNewline('a\n\n\n')).toBe('a\n');
    expect(ensureFinalNewline('a   \n  ')).toBe('a\n');
  });
});

describe('convertIndentation', () => {
  it('turns tabs into spaces', () => {
    expect(convertIndentation(['\tx'], 'spaces', 4)).toEqual(['    x']);
  });

  it('turns spaces into tabs', () => {
    expect(convertIndentation(['        x'], 'tabs', 4)).toEqual(['\t\tx']);
  });

  it('measures a tab in columns, not characters', () => {
    // Two spaces then a tab reaches column 4, not column 6.
    expect(convertIndentation(['  \tx'], 'spaces', 4)).toEqual(['    x']);
  });

  it('leaves a remainder as spaces when it does not divide', () => {
    expect(convertIndentation(['      x'], 'tabs', 4)).toEqual(['\t  x']);
  });

  it('touches only the indentation', () => {
    expect(convertIndentation(['\tif (a\tb)'], 'spaces', 4)).toEqual(['    if (a\tb)']);
  });

  it('refuses a tab width of nothing', () => {
    expect(() => convertIndentation(['x'], 'spaces', 0)).toThrow('at least one column');
  });
});

describe('shiftIndentation', () => {
  it('indents by one level', () => {
    expect(shiftIndentation(['a'], 'in', '  ')).toEqual(['  a']);
  });

  it('does not indent a blank line', () => {
    expect(shiftIndentation(['a', ''], 'in', '  ')).toEqual(['  a', '']);
  });

  it('outdents by one level', () => {
    expect(shiftIndentation(['    a'], 'out', '  ')).toEqual(['  a']);
  });

  it('outdents a file that does not match the configured indent', () => {
    // One space of indentation, asked to outdent by two: take what is there.
    expect(shiftIndentation([' a'], 'out', '  ')).toEqual(['a']);
  });

  it('leaves an unindented line alone when outdenting', () => {
    expect(shiftIndentation(['a'], 'out', '  ')).toEqual(['a']);
  });
});

describe('words', () => {
  it('splits every convention an identifier might be written in', () => {
    expect(words('saveAllFiles')).toEqual(['save', 'All', 'Files']);
    expect(words('save_all_files')).toEqual(['save', 'all', 'files']);
    expect(words('save-all-files')).toEqual(['save', 'all', 'files']);
    expect(words('SaveAllFiles')).toEqual(['Save', 'All', 'Files']);
  });

  it('keeps an acronym together', () => {
    expect(words('parseHTTPResponse')).toEqual(['parse', 'HTTP', 'Response']);
  });

  it('has nothing to say about nothing', () => {
    expect(words('')).toEqual([]);
    expect(words('___')).toEqual([]);
  });
});

describe('changeCase', () => {
  it('does the obvious two', () => {
    expect(changeCase('Hello There', 'upper')).toBe('HELLO THERE');
    expect(changeCase('Hello There', 'lower')).toBe('hello there');
  });

  it('title-cases each word', () => {
    expect(changeCase('hello THERE world', 'title')).toBe('Hello There World');
  });

  it('keeps an apostrophe inside a word', () => {
    expect(changeCase("it's fine", 'title')).toBe("It's Fine");
  });

  it('sentence-cases after a full stop, not inside a number', () => {
    expect(changeCase('one. two. three', 'sentence')).toBe('One. Two. Three');
    expect(changeCase('pi is 3.14 exactly', 'sentence')).toBe('Pi is 3.14 exactly');
  });

  it('toggles each letter', () => {
    expect(changeCase('AbC', 'toggle')).toBe('aBc');
  });

  it('leaves punctuation and digits alone when toggling', () => {
    expect(changeCase('a1!', 'toggle')).toBe('A1!');
  });
});

describe('changeNameStyle', () => {
  it('rewrites an identifier in another convention', () => {
    expect(changeNameStyle('save_all_files', 'camel')).toBe('saveAllFiles');
    expect(changeNameStyle('saveAllFiles', 'snake')).toBe('save_all_files');
    expect(changeNameStyle('save-all-files', 'pascal')).toBe('SaveAllFiles');
    expect(changeNameStyle('saveAllFiles', 'kebab')).toBe('save-all-files');
    expect(changeNameStyle('saveAllFiles', 'constant')).toBe('SAVE_ALL_FILES');
  });

  it('round-trips through the conventions', () => {
    const start = 'save_all_files';
    expect(changeNameStyle(changeNameStyle(start, 'camel'), 'snake')).toBe(start);
  });

  it('leaves something with no words in it alone', () => {
    expect(changeNameStyle('___', 'camel')).toBe('___');
  });
});

describe('statisticsOf', () => {
  it('counts what a status bar shows', () => {
    expect(statisticsOf('one two\nthree')).toEqual({
      lines: 2,
      words: 3,
      characters: 13,
      charactersWithoutSpaces: 11,
      bytes: 13,
    });
  });

  it('counts an empty selection as nothing at all', () => {
    expect(statisticsOf('')).toEqual({
      lines: 0,
      words: 0,
      characters: 0,
      charactersWithoutSpaces: 0,
      bytes: 0,
    });
  });

  it('counts characters and bytes separately once anything is not ASCII', () => {
    const stats = statisticsOf('héllo');
    expect(stats.characters).toBe(5);
    expect(stats.bytes).toBe(6);
  });

  it('counts an emoji as one character', () => {
    // Two UTF-16 code units, one thing on screen, four bytes.
    const stats = statisticsOf('🙂');
    expect(stats.characters).toBe(1);
    expect(stats.bytes).toBe(4);
  });
});

describe('reverseLines', () => {
  it('reverses without touching the input', () => {
    const original = ['a', 'b', 'c'];
    expect(reverseLines(original)).toEqual(['c', 'b', 'a']);
    expect(original).toEqual(['a', 'b', 'c']);
  });
});
