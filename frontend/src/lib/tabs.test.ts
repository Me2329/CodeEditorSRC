import { describe, expect, test } from 'vitest';

import { EMPTY, close, closeAll, closeOthers, cycle, move, open, prune } from './tabs';

const state = (open: string[], active: string | null) => ({ open, active });

describe('opening', () => {
  test('a new file gets a tab and shows', () => {
    expect(open(EMPTY, 'a')).toEqual(state(['a'], 'a'));
  });

  test('tabs accumulate in the order they were opened', () => {
    const after = open(open(open(EMPTY, 'a'), 'b'), 'c');
    expect(after.open).toEqual(['a', 'b', 'c']);
  });

  test('an already-open file is activated in place', () => {
    // Reordering tabs under someone as they navigate makes the strip unusable.
    const before = state(['a', 'b', 'c'], 'c');
    expect(open(before, 'a')).toEqual(state(['a', 'b', 'c'], 'a'));
  });

  test('opening the file already showing changes nothing', () => {
    const before = state(['a', 'b'], 'b');
    expect(open(before, 'b')).toBe(before);
  });
});

describe('closing', () => {
  test('the tab to the right takes over', () => {
    expect(close(state(['a', 'b', 'c'], 'b'), 'b')).toEqual(state(['a', 'c'], 'c'));
  });

  test('closing the last tab falls back to the left', () => {
    // Otherwise a run of closes from the end leaves nothing showing.
    expect(close(state(['a', 'b', 'c'], 'c'), 'c')).toEqual(state(['a', 'b'], 'b'));
  });

  test('closing a tab that was not showing leaves the current one alone', () => {
    expect(close(state(['a', 'b', 'c'], 'b'), 'a')).toEqual(state(['b', 'c'], 'b'));
  });

  test('closing the only tab leaves nothing open', () => {
    expect(close(state(['a'], 'a'), 'a')).toEqual(EMPTY);
  });

  test('closing something that is not open changes nothing', () => {
    const before = state(['a'], 'a');
    expect(close(before, 'zzz')).toBe(before);
  });

  test('repeated closes keep moving in one direction', () => {
    let current = state(['a', 'b', 'c', 'd'], 'b');
    current = close(current, current.active!);
    expect(current.active).toBe('c');
    current = close(current, current.active!);
    expect(current.active).toBe('d');
  });
});

describe('closing several', () => {
  test('close others keeps one', () => {
    expect(closeOthers(state(['a', 'b', 'c'], 'a'), 'b')).toEqual(state(['b'], 'b'));
  });

  test('close others on a file that is not open changes nothing', () => {
    const before = state(['a'], 'a');
    expect(closeOthers(before, 'zzz')).toBe(before);
  });

  test('close all leaves nothing', () => {
    expect(closeAll()).toEqual(EMPTY);
  });
});

describe('reordering', () => {
  test('a tab moves to the requested position', () => {
    expect(move(state(['a', 'b', 'c'], 'a'), 'c', 0).open).toEqual(['c', 'a', 'b']);
  });

  test('the file showing does not change', () => {
    // Reordering is not navigation.
    expect(move(state(['a', 'b', 'c'], 'a'), 'c', 0).active).toBe('a');
  });

  test('a position past the end is clamped', () => {
    expect(move(state(['a', 'b'], 'a'), 'a', 99).open).toEqual(['b', 'a']);
  });

  test('moving a tab to where it already is changes nothing', () => {
    const before = state(['a', 'b'], 'a');
    expect(move(before, 'a', 0)).toBe(before);
  });
});

describe('cycling', () => {
  test('forward steps to the next tab', () => {
    expect(cycle(state(['a', 'b', 'c'], 'a'), 1).active).toBe('b');
  });

  test('forward wraps at the end', () => {
    expect(cycle(state(['a', 'b', 'c'], 'c'), 1).active).toBe('a');
  });

  test('backward wraps at the start', () => {
    expect(cycle(state(['a', 'b', 'c'], 'a'), -1).active).toBe('c');
  });

  test('cycling with nothing open is harmless', () => {
    expect(cycle(EMPTY, 1)).toEqual(EMPTY);
  });
});

describe('pruning deleted files', () => {
  test('a tab for a deleted file is dropped', () => {
    expect(prune(state(['a', 'b'], 'a'), ['a'])).toEqual(state(['a'], 'a'));
  });

  test('deleting the file that was showing activates another', () => {
    expect(prune(state(['a', 'b'], 'a'), ['b'])).toEqual(state(['b'], 'b'));
  });

  test('deleting everything leaves nothing open', () => {
    expect(prune(state(['a', 'b'], 'a'), [])).toEqual(EMPTY);
  });

  test('nothing to prune returns the same object', () => {
    // So React does not re-render for a no-op on every keystroke.
    const before = state(['a', 'b'], 'a');
    expect(prune(before, ['a', 'b', 'c'])).toBe(before);
  });
});
