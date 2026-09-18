import { describe, expect, test, vi } from 'vitest';

import {
  PREFIX_BUDGET,
  SUFFIX_BUDGET,
  WINDOW_STRIDE,
  contextAround,
  debounce,
  shouldRequest,
  tidy,
  worthShowing,
} from './inline';

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


describe('holding the window still', () => {
  const long = 'x'.repeat(9000);

  test('the start does not move while a few characters are typed', () => {
    // A window that slides by one character per keystroke changes where the
    // text is cut, which changes its first tokens, which turns the model
    // server's cached prefill into a miss.
    const starts = [0, 1, 2, 3, 4, 5].map((typed) => {
      const at = 5000 + typed;
      return at - contextAround(long, at).prefix.length;
    });

    expect(new Set(starts).size).toBe(1);
  });

  test('it does move eventually, by a stride at a time', () => {
    const near = 5000 - contextAround(long, 5000).prefix.length;
    const far = 5000 + WINDOW_STRIDE - contextAround(long, 5000 + WINDOW_STRIDE).prefix.length;

    expect(far - near).toBe(WINDOW_STRIDE);
  });

  test('the prefix never exceeds the budget', () => {
    // Rounded up rather than down: down would buy context by sending more than
    // the budget allows.
    for (let typed = 0; typed < WINDOW_STRIDE * 2; typed += 7) {
      expect(contextAround(long, 4000 + typed).prefix.length).toBeLessThanOrEqual(PREFIX_BUDGET);
    }
  });

  test('near the start of a file the window begins at the start', () => {
    const { prefix } = contextAround('short file', 5);

    expect(prefix).toBe('short');
  });

  test('the suffix is unaffected', () => {
    // Only the prefix has a start that can slide; the suffix begins at the
    // caret, which is where it has to begin.
    expect(contextAround(long, 5000).suffix.length).toBe(SUFFIX_BUDGET);
  });
});


describe('a completion that abandons the line', () => {
  // Seen repeatedly from a small model: well-formed text from somewhere else
  // in its training data, which does not finish the line being typed.
  test('is not shown when the line cannot end there', () => {
    expect(worthShowing('\n\nfrom pydantic import BaseModel', '\n', 'self.text = ')).toBe(false);
    expect(worthShowing('\n* [a](https://x)', '\n', 'print(')).toBe(false);
    expect(worthShowing('\n    total = 0', '\n', 'values = [')).toBe(false);
  });

  test('is shown when the line can end there', () => {
    // A caret after a colon is exactly where a completion should start a line.
    expect(worthShowing('\n    return 1', '\n', 'def f():')).toBe(true);
    expect(worthShowing('\n    pass', '\n', 'class A:')).toBe(true);
  });

  test('is shown at the start of a line', () => {
    expect(worthShowing('\n    x = 1', '\n', '    ')).toBe(true);
  });

  test('a completion that continues the line is unaffected', () => {
    expect(worthShowing('a + b', '\n', 'return ')).toBe(true);
    expect(worthShowing('value', '\n', 'self.text = ')).toBe(true);
  });

  test('with no prefix given, nothing is rejected for this reason', () => {
    // The check is opt-in: a caller that does not pass the prefix gets the
    // behaviour it had before.
    expect(worthShowing('\n\nimport os', '\n')).toBe(true);
  });
});
