import { describe, expect, test, vi } from 'vitest';

import { contextAround, debounce, shouldRequest, tidy, worthShowing } from './inline';

describe('deciding whether to ask', () => {
  test('a caret after an opening bracket is a good moment', () => {
    expect(shouldRequest('def parse(', ')')).toBe(true);
  });

  test('a caret on a fresh indented line is a good moment', () => {
    expect(shouldRequest('def parse():\n    ', '')).toBe(true);
  });

  test('mid-identifier is not', () => {
    // The user knows what they are typing; a suggestion competes with them.
    expect(shouldRequest('const resu', '')).toBe(false);
  });

  test('inside a line comment is not', () => {
    expect(shouldRequest('x = 1\n// this explains ', '')).toBe(false);
    expect(shouldRequest('x = 1\n# this explains ', '')).toBe(false);
  });

  test('an empty document is not', () => {
    expect(shouldRequest('', '')).toBe(false);
    expect(shouldRequest('   \n  ', '  ')).toBe(false);
  });

  test('a caret with only text after it is still worth asking about', () => {
    expect(shouldRequest('', 'def existing():\n    pass\n')).toBe(true);
  });
});

describe('the context sent', () => {
  test('both halves are taken from the offset', () => {
    const { prefix, suffix } = contextAround('abcdef', 3);
    expect(prefix).toBe('abc');
    expect(suffix).toBe('def');
  });

  test('the prefix is bounded so the request stays quick', () => {
    const text = 'x'.repeat(10_000);
    expect(contextAround(text, 9_000).prefix.length).toBeLessThanOrEqual(2000);
  });

  test('the suffix is bounded too', () => {
    const text = 'x'.repeat(10_000);
    expect(contextAround(text, 1_000).suffix.length).toBeLessThanOrEqual(1000);
  });

  test('an offset at the start produces an empty prefix rather than wrapping', () => {
    expect(contextAround('abcdef', 0).prefix).toBe('');
  });
});

describe('tidying what comes back', () => {
  test('text the user already has below the caret is cut', () => {
    // Inserting this would duplicate the line below.
    const completion = '    result = []\n    return result';
    expect(tidy(completion, '\n    return result\n')).toBe('    result = []');
  });

  test('a long completion is cut to a few lines', () => {
    const completion = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
    expect(tidy(completion, '').split('\n')).toHaveLength(6);
  });

  test('trailing whitespace is removed from every line', () => {
    expect(tidy('a   \nb\t\n', '')).toBe('a\nb');
  });

  test('a whitespace-only completion becomes nothing', () => {
    expect(tidy('   \n  \n', '')).toBe('');
  });

  test('a short suffix is not used for de-duplication', () => {
    // Cutting on a two-character match would truncate almost everything.
    expect(tidy('return x', '\n)\n')).toBe('return x');
  });
});

describe('deciding whether to show', () => {
  test('a real suggestion is shown', () => {
    expect(worthShowing('return result', '\n')).toBe(true);
  });

  test('nothing is not', () => {
    expect(worthShowing('', 'x')).toBe(false);
  });

  test('a single character is not', () => {
    expect(worthShowing(')', '')).toBe(false);
  });

  test('a bracket the editor already inserted is not', () => {
    // It flickers, and accepting it produces a duplicate.
    expect(worthShowing('))', '')).toBe(false);
    expect(worthShowing(');', '')).toBe(false);
  });

  test('text already present after the caret is not', () => {
    expect(worthShowing('return result', 'return result\n')).toBe(false);
  });
});

describe('holding off until typing pauses', () => {
  test('only the last call runs', () => {
    vi.useFakeTimers();
    const action = vi.fn();
    const { run } = debounce(action, 100);

    run(1);
    run(2);
    run(3);
    vi.advanceTimersByTime(150);

    expect(action).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledWith(3);
    vi.useRealTimers();
  });

  test('cancelling stops a pending run', () => {
    vi.useFakeTimers();
    const action = vi.fn();
    const { run, cancel } = debounce(action, 100);

    run();
    cancel();
    vi.advanceTimersByTime(500);

    expect(action).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  test('cancelling with nothing pending is harmless', () => {
    const { cancel } = debounce(() => {}, 100);
    expect(() => cancel()).not.toThrow();
  });
});
