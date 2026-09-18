import { describe, expect, test } from 'vitest';

import { nextAfter, position, previousBefore } from './problems';

describe('going forward', () => {
  test('to the next one below the caret', () => {
    expect(nextAfter([4, 12, 30], 4)).toBe(12);
  });

  test('from above the first', () => {
    expect(nextAfter([4, 12], 1)).toBe(4);
  });

  test('wrapping round at the last', () => {
    // A key that does nothing at the end feels broken.
    expect(nextAfter([4, 12], 12)).toBe(4);
  });

  test('with nothing wrong there is nowhere to go', () => {
    expect(nextAfter([], 1)).toBeNull();
  });

  test('one problem is where you always land', () => {
    expect(nextAfter([7], 7)).toBe(7);
  });
});

describe('going back', () => {
  test('to the one above the caret', () => {
    expect(previousBefore([4, 12, 30], 30)).toBe(12);
  });

  test('wrapping round at the first', () => {
    expect(previousBefore([4, 12], 4)).toBe(12);
  });

  test('from below the last', () => {
    expect(previousBefore([4, 12], 99)).toBe(12);
  });

  test('with nothing wrong there is nowhere to go', () => {
    expect(previousBefore([], 5)).toBeNull();
  });
});

describe('what counts as a place to go', () => {
  test('unsorted diagnostics are still walked in order', () => {
    expect(nextAfter([30, 4, 12], 1)).toBe(4);
  });

  test('two problems on one line are one place', () => {
    expect(nextAfter([5, 5, 9], 5)).toBe(9);
    expect(position([5, 5, 9], 5)).toBe('1 of 2');
  });

  test('a line the analyzer could not place is skipped', () => {
    // Jumping to line zero moves the caret where nothing is wrong.
    expect(nextAfter([0, 8], 1)).toBe(8);
    expect(previousBefore([0, 8], 99)).toBe(8);
  });
});

describe('saying where you are', () => {
  test('among the problems', () => {
    expect(position([4, 12, 30], 12)).toBe('2 of 3');
  });

  test('when the caret is not on one', () => {
    expect(position([4, 12], 7)).toBe('2');
  });

  test('when there are none', () => {
    expect(position([], 1)).toBe('');
  });
});
