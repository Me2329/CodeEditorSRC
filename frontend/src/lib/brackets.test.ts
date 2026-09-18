/**
 * Matching brackets, and the text between them.
 *
 * The case that matters throughout is a bracket inside a string or a comment.
 * A naive matcher walks into `print("(")` and never comes back, and the user
 * sees "no matching bracket" on a line where they plainly match.
 */

import { describe, expect, it } from 'vitest';

import {
  around,
  enclosing,
  expand,
  inside,
  matchAt,
  unbalanced,
} from './brackets';

const TS = 'typescript';

describe('matchAt', () => {
  it('finds the closing bracket from the opener', () => {
    expect(matchAt('f(a)', 1, TS)).toBe(3);
  });

  it('finds the opening bracket from the closer', () => {
    // Pressing the key on a closing bracket should work as readily.
    expect(matchAt('f(a)', 3, TS)).toBe(1);
  });

  it('counts nesting', () => {
    const text = 'f(g(x), h(y))';
    expect(matchAt(text, 1, TS)).toBe(text.length - 1);
    expect(matchAt(text, 3, TS)).toBe(5);
  });

  it('ignores a bracket inside a string', () => {
    const text = 'print("(") + (x)';
    expect(matchAt(text, 13, TS)).toBe(15);
  });

  it('does not match a bracket that is itself inside a string', () => {
    expect(matchAt('print("(")', 7, TS)).toBeNull();
  });

  it('ignores a bracket inside a comment', () => {
    const text = 'f(a) // )\n';
    expect(matchAt(text, 1, TS)).toBe(3);
  });

  it('matches across lines', () => {
    const text = 'f(\n  a,\n  b,\n)';
    expect(matchAt(text, 1, TS)).toBe(text.length - 1);
  });

  it('tells the bracket kinds apart', () => {
    const text = '{[()]}';
    expect(matchAt(text, 0, TS)).toBe(5);
    expect(matchAt(text, 1, TS)).toBe(4);
    expect(matchAt(text, 2, TS)).toBe(3);
  });

  it('has nothing to say about a character that is not a bracket', () => {
    expect(matchAt('f(a)', 0, TS)).toBeNull();
  });

  it('has nothing to say about an unmatched bracket', () => {
    expect(matchAt('f(a', 1, TS)).toBeNull();
    expect(matchAt('a)', 1, TS)).toBeNull();
  });

  it('has nothing to say past the end', () => {
    expect(matchAt('f()', 99, TS)).toBeNull();
  });

  it('uses the language own comment syntax', () => {
    // `#` is a comment in Python and not in TypeScript.
    expect(matchAt('f(a) # )\n', 1, 'python')).toBe(3);
    expect(matchAt('f(a) # )\n', 1, TS)).toBe(3);
  });
});

describe('enclosing', () => {
  it('finds the pair around an offset', () => {
    expect(enclosing('f(abc)', 3, TS)).toEqual({ open: 1, close: 5, bracket: '(' });
  });

  it('finds the innermost pair', () => {
    const text = 'f(g(x))';
    expect(enclosing(text, 4, TS)).toEqual({ open: 3, close: 5, bracket: '(' });
  });

  it('counts an offset on a bracket as inside that pair', () => {
    // Which is what makes "select what encloses me" work at the edge.
    expect(enclosing('f(a)', 1, TS)?.open).toBe(1);
    expect(enclosing('f(a)', 3, TS)?.open).toBe(1);
  });

  it('ignores brackets in strings when deciding', () => {
    const text = 'f("(", x)';
    expect(enclosing(text, 7, TS)).toEqual({ open: 1, close: 8, bracket: '(' });
  });

  it('finds nothing outside every pair', () => {
    expect(enclosing('a + b', 2, TS)).toBeNull();
    expect(enclosing('f(a) + b', 6, TS)).toBeNull();
  });

  it('still answers for the balanced part of unbalanced text', () => {
    expect(enclosing('} f(a)', 4, TS)).toEqual({ open: 3, close: 5, bracket: '(' });
  });

  it('picks the later of two pairs at the same depth', () => {
    const text = '(a) (b)';
    expect(enclosing(text, 5, TS)?.open).toBe(4);
  });
});

describe('inside and around', () => {
  const pair = { open: 1, close: 5, bracket: '(' };

  it('inside excludes the brackets', () => {
    expect(inside(pair)).toEqual({ start: 2, end: 5 });
  });

  it('around includes them', () => {
    expect(around(pair)).toEqual({ start: 1, end: 6 });
  });

  it('slice with those offsets gives the expected text', () => {
    const text = 'f(abc)';
    const within = inside(pair);
    expect(text.slice(within.start, within.end)).toBe('abc');
    const whole = around(pair);
    expect(text.slice(whole.start, whole.end)).toBe('(abc)');
  });
});

describe('expand', () => {
  const text = 'f(g(abc))';

  it('grows from a caret to the inside of what encloses it', () => {
    expect(expand(text, { start: 5, end: 5 }, TS)).toEqual({ start: 4, end: 7 });
  });

  it('grows from an inside to include the brackets', () => {
    expect(expand(text, { start: 4, end: 7 }, TS)).toEqual({ start: 3, end: 8 });
  });

  it('grows from a whole pair to the inside of the pair above it', () => {
    expect(expand(text, { start: 3, end: 8 }, TS)).toEqual({ start: 2, end: 8 });
  });

  it('each press is strictly larger', () => {
    // What makes the key usable by holding it down.
    let selection = { start: 5, end: 5 };
    const widths: number[] = [];
    for (let step = 0; step < 4; step += 1) {
      const next = expand(text, selection, TS);
      if (!next) break;
      widths.push(next.end - next.start);
      selection = next;
    }
    expect(widths).toEqual([...widths].sort((a, b) => a - b));
    expect(new Set(widths).size).toBe(widths.length);
  });

  it('stops when there is nothing left to grow into', () => {
    expect(expand('abc', { start: 1, end: 1 }, TS)).toBeNull();
  });
});

describe('unbalanced', () => {
  it('finds nothing in balanced text', () => {
    expect(unbalanced('f(g([1, 2]))', TS)).toEqual([]);
  });

  it('finds an unclosed opener', () => {
    expect(unbalanced('f(a', TS)).toEqual([1]);
  });

  it('finds a stray closer', () => {
    expect(unbalanced('a)', TS)).toEqual([1]);
  });

  it('finds a mismatched pair', () => {
    expect(unbalanced('(]', TS)).toEqual([0, 1]);
  });

  it('ignores brackets in strings and comments', () => {
    expect(unbalanced('f("(") // )\n', TS)).toEqual([]);
  });

  it('reports offsets in order', () => {
    const found = unbalanced('( a ) ) (', TS);
    expect(found).toEqual([...found].sort((a, b) => a - b));
  });
});
