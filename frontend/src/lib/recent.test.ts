import { describe, expect, test } from 'vitest';

import { LIMIT, order, previous, prune, touch } from './recent';

const file = (id: string) => ({ id, name: `${id}.py` });

describe('remembering', () => {
  test('a file goes to the front', () => {
    expect(touch(['a', 'b'], 'c')).toEqual(['c', 'a', 'b']);
  });

  test('a file already in the list moves rather than repeats', () => {
    expect(touch(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
  });

  test('the file already in front changes nothing', () => {
    // So holding this in state does not re-render on every keystroke.
    const before = ['a', 'b'];

    expect(touch(before, 'a')).toBe(before);
  });

  test('the list is bounded', () => {
    let recent: readonly string[] = [];
    for (let index = 0; index < LIMIT + 5; index += 1) {
      recent = touch(recent, `file${index}`);
    }

    expect(recent).toHaveLength(LIMIT);
    expect(recent[0]).toBe(`file${LIMIT + 4}`);
  });

  test('an empty id is ignored', () => {
    const before = ['a'];

    expect(touch(before, '')).toBe(before);
  });
});

describe('pruning', () => {
  test('deleted files go', () => {
    expect(prune(['a', 'b'], [file('a')])).toEqual(['a']);
  });

  test('nothing to prune returns the same list', () => {
    const before = ['a'];

    expect(prune(before, [file('a')])).toBe(before);
  });
});

describe('ordering', () => {
  const files = [file('a'), file('b'), file('c'), file('d')];

  test('recent files come first, most recent of all', () => {
    expect(order(files, ['c', 'a']).map((entry) => entry.id)).toEqual(['c', 'a', 'b', 'd']);
  });

  test('files never opened keep the order they were created in', () => {
    // A file with no recency has nothing to sort by, and created order is at
    // least stable.
    expect(order(files, []).map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('a remembered file that no longer exists is skipped', () => {
    expect(order(files, ['gone', 'b']).map((entry) => entry.id)).toEqual(['b', 'a', 'c', 'd']);
  });

  test('no file appears twice', () => {
    const ordered = order(files, ['a', 'a', 'b']);

    expect(ordered).toHaveLength(files.length);
  });
});

describe('the toggle', () => {
  test('the previous file is the second entry, not the first', () => {
    // The first is the file you are looking at, so Ctrl+P then Enter would do
    // nothing at all.
    expect(previous(['current', 'before'])).toBe('before');
  });

  test('with one file there is nowhere to go back to', () => {
    expect(previous(['only'])).toBeNull();
    expect(previous([])).toBeNull();
  });
});
