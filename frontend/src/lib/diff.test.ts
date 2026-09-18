import { describe, expect, test } from 'vitest';

import { MAX_LINES, collapse, diffLines, diffStats, toUnified } from './diff';

const kinds = (before: string, after: string) => diffLines(before, after).map((line) => line.kind);
const texts = (before: string, after: string, kind: string) =>
  diffLines(before, after)
    .filter((line) => line.kind === kind)
    .map((line) => line.text);

describe('comparing two texts', () => {
  test('identical text is entirely unchanged', () => {
    expect(kinds('a\nb\nc', 'a\nb\nc')).toEqual(['unchanged', 'unchanged', 'unchanged']);
  });

  test('an inserted line is the only addition', () => {
    expect(texts('a\nc', 'a\nb\nc', 'added')).toEqual(['b']);
    expect(texts('a\nc', 'a\nb\nc', 'removed')).toEqual([]);
  });

  test('a deleted line is the only removal', () => {
    expect(texts('a\nb\nc', 'a\nc', 'removed')).toEqual(['b']);
    expect(texts('a\nb\nc', 'a\nc', 'added')).toEqual([]);
  });

  test('a modified line reads as a removal then an addition', () => {
    // One change, not two unrelated ones.
    expect(kinds('a\nOLD\nc', 'a\nNEW\nc')).toEqual([
      'unchanged',
      'removed',
      'added',
      'unchanged',
    ]);
  });

  test('the shared lines are found rather than the whole file replaced', () => {
    const lines = diffLines('keep\nold\nkeep2', 'keep\nnew\nkeep2');
    expect(lines.filter((line) => line.kind === 'unchanged')).toHaveLength(2);
  });

  test('an empty original is all additions', () => {
    expect(kinds('', 'a\nb')).toEqual(['removed', 'added', 'added']);
  });

  test('emptying a file removes everything', () => {
    expect(texts('a\nb', '', 'removed')).toEqual(['a', 'b']);
  });
});

describe('line numbers', () => {
  test('an unchanged line carries both sides', () => {
    const [first] = diffLines('a\nb', 'a\nb');
    expect(first).toMatchObject({ beforeLine: 1, afterLine: 1 });
  });

  test('an added line has no line in the original', () => {
    const added = diffLines('a', 'a\nb').find((line) => line.kind === 'added');
    expect(added).toMatchObject({ beforeLine: null, afterLine: 2 });
  });

  test('a removed line has no line in the result', () => {
    const removed = diffLines('a\nb', 'a').find((line) => line.kind === 'removed');
    expect(removed).toMatchObject({ beforeLine: 2, afterLine: null });
  });

  test('numbering stays correct after an insertion', () => {
    const lines = diffLines('a\nc', 'a\nb\nc');
    const last = lines[lines.length - 1]!;
    expect(last).toMatchObject({ text: 'c', beforeLine: 2, afterLine: 3 });
  });
});

describe('counting', () => {
  test('the three kinds are tallied', () => {
    expect(diffStats(diffLines('a\nb\nc', 'a\nX\nc'))).toEqual({
      added: 1,
      removed: 1,
      unchanged: 2,
    });
  });
});

describe('very large files', () => {
  test('a file past the limit falls back rather than allocating the table', () => {
    const before = Array.from({ length: MAX_LINES + 10 }, (_, i) => `line ${i}`).join('\n');
    const after = `${before}\nextra`;

    const lines = diffLines(before, after);

    // Everything removed then everything added: coarse, but it returns.
    expect(lines.some((line) => line.kind === 'unchanged')).toBe(false);
    expect(lines.length).toBe(before.split('\n').length + after.split('\n').length);
  });

  test('identical large files still short-circuit to unchanged', () => {
    const text = Array.from({ length: MAX_LINES + 10 }, (_, i) => `line ${i}`).join('\n');
    expect(diffLines(text, text).every((line) => line.kind === 'unchanged')).toBe(true);
  });
});

describe('collapsing to hunks', () => {
  test('an unchanged file produces no hunks', () => {
    expect(collapse(diffLines('a\nb', 'a\nb'))).toEqual([]);
  });

  test('context is kept either side of a change', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 20', 'CHANGED');

    const hunks = collapse(diffLines(before, after), 2);

    expect(hunks).toHaveLength(1);
    // Two context lines each side, plus the removal and the addition.
    expect(hunks[0]!.lines.length).toBeLessThanOrEqual(8);
  });

  test('the number of hidden lines is reported', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 30', 'CHANGED');

    const [hunk] = collapse(diffLines(before, after), 2);

    expect(hunk!.skipped).toBeGreaterThan(0);
  });

  test('two distant changes become two hunks', () => {
    const before = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 5', 'A').replace('line 50', 'B');

    expect(collapse(diffLines(before, after), 2)).toHaveLength(2);
  });
});

describe('unified output', () => {
  test('markers match the convention', () => {
    const unified = toUnified(diffLines('a\nold', 'a\nnew'), 'main.py');

    expect(unified).toContain('--- a/main.py');
    expect(unified).toContain('+++ b/main.py');
    expect(unified).toContain('-old');
    expect(unified).toContain('+new');
    expect(unified).toContain(' a');
  });
});
