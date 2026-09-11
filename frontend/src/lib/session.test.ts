import { describe, expect, test } from 'vitest';

import { EMPTY_SESSION, type Session, reconcile, restore } from './session';

const session = (over: Partial<Session> = {}): Session => ({ ...EMPTY_SESSION, ...over });

describe('reading what was stored', () => {
  test('a whole session comes back', () => {
    const stored = {
      open: ['a', 'b'],
      active: 'b',
      split: 'a',
      recent: ['b', 'a'],
      collapsed: ['lib'],
    };

    expect(restore(stored)).toEqual(stored);
  });

  test('anything unrecognisable is an empty session', () => {
    // The cost of getting this wrong is a reload with no tabs; the cost of
    // throwing is an editor that will not start.
    expect(restore(null)).toEqual(EMPTY_SESSION);
    expect(restore('nonsense')).toEqual(EMPTY_SESSION);
    expect(restore(42)).toEqual(EMPTY_SESSION);
  });

  test('missing fields are empty rather than undefined', () => {
    expect(restore({ active: 'a' })).toEqual(session({ active: 'a' }));
  });

  test('entries of the wrong type are dropped', () => {
    expect(restore({ open: ['a', 7, null, 'b'] }).open).toEqual(['a', 'b']);
  });

  test('a field of the wrong type is ignored', () => {
    expect(restore({ open: 'not a list', active: 12 })).toEqual(EMPTY_SESSION);
  });

  test('stored lists are bounded', () => {
    const many = Array.from({ length: 500 }, (_, index) => `f${index}`);

    expect(restore({ open: many }).open).toHaveLength(100);
    expect(restore({ recent: many }).recent).toHaveLength(50);
  });
});

describe('reconciling with the files that exist', () => {
  test('tabs for files that are gone close', () => {
    // A workspace imported over the old one has entirely different ids.
    const after = reconcile(session({ open: ['a', 'gone'], active: 'a' }), ['a']);

    expect(after.open).toEqual(['a']);
  });

  test('an active file with no tab falls back to the first', () => {
    const after = reconcile(session({ open: ['a', 'b'], active: 'gone' }), ['a', 'b']);

    expect(after.active).toBe('a');
  });

  test('nothing left means nothing active', () => {
    expect(reconcile(session({ open: ['gone'], active: 'gone' }), ['x'])).toEqual(EMPTY_SESSION);
  });

  test('a split on a file that is gone closes', () => {
    const after = reconcile(session({ open: ['a'], active: 'a', split: 'gone' }), ['a']);

    expect(after.split).toBe('');
  });

  test('a split showing the active file closes', () => {
    // Two panes on one file is a split that does nothing but halve the width.
    const after = reconcile(session({ open: ['a'], active: 'a', split: 'a' }), ['a']);

    expect(after.split).toBe('');
  });

  test('recent files that are gone are forgotten', () => {
    const after = reconcile(session({ open: ['a'], active: 'a', recent: ['a', 'gone'] }), ['a']);

    expect(after.recent).toEqual(['a']);
  });

  test('collapsed folders are kept whatever the files are', () => {
    // Folders are derived from names, so a folder can come back with a new file.
    const after = reconcile(session({ collapsed: ['lib'] }), []);

    expect(after.collapsed).toEqual(['lib']);
  });
});
