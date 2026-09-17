/**
 * Bookmarks, and what happens to them when the file moves underneath.
 *
 * Storing a bare line number is the failure worth testing against: it looks
 * like it works and points ten lines short of where you put it.
 */

import { describe, expect, it } from 'vitest';

import {
  type Bookmark,
  describe as describeBookmarks,
  forgetFile,
  inFile,
  isMarked,
  ordered,
  prune,
  reconcile,
  step,
  toggle,
} from './bookmarks';

const FILE = 'a';
const CONTENT = ['first line', 'second line', 'third line', 'fourth line'].join('\n');

function mark(line: number, text: string, fileId = FILE): Bookmark {
  return { fileId, line, text };
}

describe('toggle', () => {
  it('sets one, remembering the line text', () => {
    expect(toggle([], FILE, 2, CONTENT)).toEqual([mark(2, 'second line')]);
  });

  it('clears the one already there', () => {
    const set = toggle([], FILE, 2, CONTENT);
    expect(toggle(set, FILE, 2, CONTENT)).toEqual([]);
  });

  it('keeps them in line order', () => {
    let marks = toggle([], FILE, 3, CONTENT);
    marks = toggle(marks, FILE, 1, CONTENT);
    expect(marks.map((one) => one.line)).toEqual([1, 3]);
  });

  it('trims the remembered text', () => {
    expect(toggle([], FILE, 1, '    indented').at(0)?.text).toBe('indented');
  });

  it('remembers nothing for a line past the end', () => {
    expect(toggle([], FILE, 99, CONTENT).at(0)?.text).toBe('');
  });
});

describe('reconcile', () => {
  it('follows a line that moved down', () => {
    const marks = [mark(2, 'second line')];
    const edited = ['new', 'lines', ...CONTENT.split('\n')].join('\n');
    expect(reconcile(marks, FILE, edited)).toEqual([mark(4, 'second line')]);
  });

  it('follows a line that moved up', () => {
    const marks = [mark(3, 'third line')];
    const edited = CONTENT.split('\n').slice(1).join('\n');
    expect(reconcile(marks, FILE, edited)).toEqual([mark(2, 'third line')]);
  });

  it('drops a bookmark whose line is gone', () => {
    const marks = [mark(2, 'second line')];
    const edited = ['first line', 'third line'].join('\n');
    expect(reconcile(marks, FILE, edited)).toEqual([]);
  });

  it('chooses the nearest match when the line appears several times', () => {
    // The same line of code appears many times in a file; the one meant is the
    // one that did not move far.
    const content = ['x', 'same', 'y', 'same', 'z', 'same'].join('\n');
    expect(reconcile([mark(4, 'same')], FILE, content)).toEqual([mark(4, 'same')]);
    expect(reconcile([mark(1, 'same')], FILE, content)).toEqual([mark(2, 'same')]);
    expect(reconcile([mark(7, 'same')], FILE, content)).toEqual([mark(6, 'same')]);
  });

  it('breaks a tie towards the earlier line, deterministically', () => {
    // Line 5 sits one away from both 4 and 6. Which one wins matters less
    // than that the same one always does.
    const content = ['x', 'same', 'y', 'same', 'z', 'same'].join('\n');
    expect(reconcile([mark(5, 'same')], FILE, content)).toEqual([mark(4, 'same')]);
  });

  it('leaves other files alone', () => {
    const marks = [mark(2, 'second line'), mark(1, 'elsewhere', 'b')];
    const result = reconcile(marks, FILE, CONTENT);
    expect(result).toContainEqual(mark(1, 'elsewhere', 'b'));
  });

  it('keeps a bookmark on a blank line only where it already is', () => {
    // There is no text to search for, so it cannot be followed; matching the
    // first blank line in the file would be worse than leaving it.
    expect(reconcile([mark(2, '')], FILE, 'a\n\nb')).toEqual([mark(2, '')]);
    expect(reconcile([mark(9, '')], FILE, 'a\n\nb')).toEqual([]);
  });

  it('is stable when nothing changed', () => {
    const marks = [mark(1, 'first line'), mark(3, 'third line')];
    expect(reconcile(marks, FILE, CONTENT)).toEqual(marks);
  });
});

describe('step', () => {
  const marks = [mark(2, 'b'), mark(5, 'e'), mark(9, 'i')];

  it('goes to the next one after the caret', () => {
    expect(step(marks, FILE, 3, 'next')?.line).toBe(5);
  });

  it('goes to the previous one before the caret', () => {
    expect(step(marks, FILE, 6, 'previous')?.line).toBe(5);
  });

  it('wraps round at the end', () => {
    // A bookmark list is a ring; stopping would make the key do nothing just
    // as you reach the interesting part.
    expect(step(marks, FILE, 99, 'next')?.line).toBe(2);
  });

  it('wraps round at the start', () => {
    expect(step(marks, FILE, 1, 'previous')?.line).toBe(9);
  });

  it('skips a bookmark on the caret line itself', () => {
    expect(step(marks, FILE, 5, 'next')?.line).toBe(9);
    expect(step(marks, FILE, 5, 'previous')?.line).toBe(2);
  });

  it('crosses into another file', () => {
    const across = [mark(1, 'x', 'a'), mark(1, 'y', 'b')];
    expect(step(across, 'a', 5, 'next')?.fileId).toBe('b');
  });

  it('has nowhere to go when there are none', () => {
    expect(step([], FILE, 1, 'next')).toBeNull();
  });

  it('returns the only one from anywhere', () => {
    const one = [mark(4, 'd')];
    expect(step(one, FILE, 1, 'next')?.line).toBe(4);
    expect(step(one, FILE, 9, 'next')?.line).toBe(4);
    expect(step(one, FILE, 4, 'next')?.line).toBe(4);
  });
});

describe('inFile, isMarked, ordered', () => {
  const marks = [mark(5, 'e'), mark(1, 'a'), mark(3, 'c', 'b')];

  it('lists one file in line order', () => {
    expect(inFile(marks, FILE).map((one) => one.line)).toEqual([1, 5]);
  });

  it('says whether a line is marked', () => {
    expect(isMarked(marks, FILE, 5)).toBe(true);
    expect(isMarked(marks, FILE, 4)).toBe(false);
    expect(isMarked(marks, 'b', 3)).toBe(true);
  });

  it('orders by file and then by line', () => {
    expect(ordered(marks).map((one) => [one.fileId, one.line])).toEqual([
      ['a', 1],
      ['a', 5],
      ['b', 3],
    ]);
  });

  it('does not modify its input', () => {
    const original = [mark(5, 'e'), mark(1, 'a')];
    ordered(original);
    expect(original[0]?.line).toBe(5);
  });
});

describe('forgetFile and prune', () => {
  const marks = [mark(1, 'a', 'a'), mark(1, 'b', 'b')];

  it('forgets one file', () => {
    expect(forgetFile(marks, 'a')).toEqual([mark(1, 'b', 'b')]);
  });

  it('drops bookmarks for files that are gone', () => {
    expect(prune(marks, ['b'])).toEqual([mark(1, 'b', 'b')]);
  });

  it('keeps everything when every file is still there', () => {
    expect(prune(marks, ['a', 'b'])).toEqual(marks);
  });
});

describe('describe', () => {
  it('counts them, and the files when there is more than one', () => {
    expect(describeBookmarks([])).toBe('No bookmarks.');
    expect(describeBookmarks([mark(1, 'a')])).toBe('1 bookmark');
    expect(describeBookmarks([mark(1, 'a'), mark(2, 'b')])).toBe('2 bookmarks');
    expect(describeBookmarks([mark(1, 'a'), mark(1, 'b', 'b')])).toBe('2 bookmarks in 2 files');
  });
});
