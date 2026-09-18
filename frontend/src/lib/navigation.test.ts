import { describe, expect, test } from 'vitest';

import {
  EMPTY,
  LIMIT,
  MIN_JUMP_LINES,
  type NavigationState,
  back,
  canGoBack,
  canGoForward,
  current,
  forget,
  forward,
  isJump,
  placesIn,
  visit,
} from './navigation';

const place = (fileId: string, line: number, column = 1) => ({ fileId, line, column });

/** Visit several places in order. */
function trail(...places: { fileId: string; line: number; column: number }[]): NavigationState {
  return places.reduce(visit, EMPTY);
}

describe('what counts as a jump', () => {
  test('the first place always does', () => {
    expect(isJump(null, place('a', 1))).toBe(true);
  });

  test('another file always does', () => {
    expect(isJump(place('a', 100), place('b', 100))).toBe(true);
  });

  test('a few lines in the same file does not', () => {
    // Otherwise the history is a record of every arrow key ever pressed.
    expect(isJump(place('a', 10), place('a', 12))).toBe(false);
  });

  test('far enough in the same file does', () => {
    expect(isJump(place('a', 10), place('a', 10 + MIN_JUMP_LINES))).toBe(true);
  });

  test('distance counts in both directions', () => {
    expect(isJump(place('a', 60), place('a', 60 - MIN_JUMP_LINES))).toBe(true);
  });
});

describe('visiting', () => {
  test('the first place becomes the history', () => {
    const state = visit(EMPTY, place('a', 1));

    expect(current(state)).toEqual(place('a', 1));
    expect(canGoBack(state)).toBe(false);
  });

  test('jumps accumulate', () => {
    const state = trail(place('a', 1), place('b', 5), place('c', 9));

    expect(state.entries).toHaveLength(3);
    expect(current(state)).toEqual(place('c', 9));
  });

  test('the same place twice is recorded once', () => {
    const once = visit(EMPTY, place('a', 4));

    expect(visit(once, place('a', 4))).toBe(once);
  });

  test('a small move updates where we are rather than adding an entry', () => {
    // So going back lands where you actually were, not ten lines above it.
    const state = trail(place('a', 1), place('b', 40), place('b', 43));

    expect(state.entries).toHaveLength(2);
    expect(current(state)).toEqual(place('b', 43));
  });

  test('visiting after going back discards what was ahead', () => {
    const state = visit(back(trail(place('a', 1), place('b', 2), place('c', 3))), place('d', 4));

    expect(state.entries.map((entry) => entry.fileId)).toEqual(['a', 'b', 'd']);
    expect(canGoForward(state)).toBe(false);
  });

  test('the history is bounded', () => {
    let state = EMPTY;
    for (let line = 0; line < LIMIT + 10; line += 1) {
      state = visit(state, place(`file${line}`, 1));
    }

    expect(state.entries).toHaveLength(LIMIT);
    expect(state.index).toBe(LIMIT - 1);
    expect(state.entries[0]).toEqual(place('file10', 1));
  });
});

describe('going back and forward', () => {
  test('back moves one place', () => {
    const state = back(trail(place('a', 1), place('b', 2)));

    expect(current(state)).toEqual(place('a', 1));
    expect(canGoForward(state)).toBe(true);
  });

  test('forward returns', () => {
    const state = forward(back(trail(place('a', 1), place('b', 2))));

    expect(current(state)).toEqual(place('b', 2));
  });

  test('back at the beginning stays put', () => {
    const state = trail(place('a', 1));

    expect(back(state)).toBe(state);
  });

  test('forward at the end stays put', () => {
    const state = trail(place('a', 1), place('b', 2));

    expect(forward(state)).toBe(state);
  });

  test('an empty history goes nowhere', () => {
    expect(canGoBack(EMPTY)).toBe(false);
    expect(canGoForward(EMPTY)).toBe(false);
    expect(current(EMPTY)).toBeNull();
  });
});

describe('deleted files', () => {
  test('their places go', () => {
    const state = forget(trail(place('a', 1), place('b', 2), place('a', 3)), 'a');

    expect(state.entries).toEqual([place('b', 2)]);
  });

  test('the current position follows what it was pointing at', () => {
    const state = forget(back(trail(place('a', 1), place('b', 2), place('c', 3))), 'a');

    expect(current(state)).toEqual(place('b', 2));
  });

  test('losing everything leaves nowhere to go', () => {
    const state = forget(trail(place('a', 1), place('a', 20)), 'a');

    expect(state.entries).toEqual([]);
    expect(current(state)).toBeNull();
    expect(canGoBack(state)).toBe(false);
  });

  test('a file with no places changes nothing', () => {
    const state = trail(place('a', 1));

    expect(forget(state, 'b')).toBe(state);
  });
});

describe('listing', () => {
  test('places in one file', () => {
    const state = trail(place('a', 1), place('b', 2), place('a', 30));

    expect(placesIn(state, 'a')).toEqual([place('a', 1), place('a', 30)]);
  });
});
