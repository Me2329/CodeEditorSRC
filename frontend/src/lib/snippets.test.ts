import { describe, expect, test } from 'vitest';

import { ALL_SNIPPETS } from './extensions/builtin/snippets';
import type { SnippetContribution } from './extensions/types';
import { matching, placeholders, reindent, validate, wordBefore } from './snippets';

const snippet = (over: Partial<SnippetContribution> = {}): SnippetContribution => ({
  language: 'python',
  prefix: 'p',
  description: 'd',
  body: 'body $0',
  ...over,
});

describe('the shipped snippets', () => {
  test('every body is well formed', () => {
    // A malformed body inserts a literal '${1:' into someone's source, and the
    // moment to find that out is not while they are typing.
    const broken = ALL_SNIPPETS.map((entry) => [
      `${entry.language}:${entry.prefix}`,
      validate(entry),
    ]).filter(([, problem]) => problem !== null);

    expect(broken).toEqual([]);
  });

  test('a prefix belongs to one snippet per language', () => {
    // Two snippets fighting over 'for' is a bug, not a preference.
    const seen = new Map<string, number>();
    for (const entry of ALL_SNIPPETS) {
      const key = `${entry.language}:${entry.prefix}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }

    expect([...seen].filter(([, count]) => count > 1)).toEqual([]);
  });

  test('every one says what it is for', () => {
    expect(ALL_SNIPPETS.every((entry) => entry.description.trim().length > 0)).toBe(true);
  });

  test('the languages covered are ones the editor runs', () => {
    const covered = new Set(ALL_SNIPPETS.map((entry) => entry.language));

    for (const language of ['python', 'typescript', 'rust', 'go', 'cpp']) {
      expect(covered.has(language)).toBe(true);
    }
  });
});

describe('validation', () => {
  test('an unclosed placeholder is caught', () => {
    expect(validate(snippet({ body: 'def ${1:name(' }))).toMatch('not closed');
  });

  test('two final positions are caught', () => {
    // Monaco would pick one and the author would never know which.
    expect(validate(snippet({ body: '$0 and $0' }))).toMatch('final caret');
  });

  test('a gap in the tab stops is caught', () => {
    // Tab would skip a number and land somewhere the author did not intend.
    expect(validate(snippet({ body: '${1:a} ${3:c}' }))).toMatch('consecutive');
  });

  test('a snippet nobody can type is caught', () => {
    expect(validate(snippet({ prefix: '  ' }))).toMatch('no prefix');
  });

  test('a snippet with no language is caught', () => {
    expect(validate(snippet({ language: '' }))).toMatch('unreachable');
  });

  test('a repeated ordinal is allowed', () => {
    // Mirrored placeholders: typing the loop variable once fills both uses.
    expect(validate(snippet({ body: 'for ${1:x} in ${2:xs}: ${1:x}$0' }))).toBeNull();
  });
});

describe('placeholders', () => {
  test('defaults are read out', () => {
    expect(placeholders('def ${1:name}(${2:args}):')).toEqual([
      { ordinal: 1, value: 'name' },
      { ordinal: 2, value: 'args' },
    ]);
  });

  test('bare stops have no default', () => {
    expect(placeholders('try:\n\t$1\n$0')).toEqual([
      { ordinal: 1, value: '' },
      { ordinal: 0, value: '' },
    ]);
  });

  test('a body with no stops has none', () => {
    expect(placeholders('print("hello")')).toEqual([]);
  });
});

describe('matching', () => {
  const some = [snippet({ prefix: 'def' }), snippet({ prefix: 'dataclass' }), snippet({ prefix: 'try' })];

  test('what has been typed narrows the list', () => {
    expect(matching(some, 'd').map((entry) => entry.prefix)).toEqual(['def', 'dataclass']);
  });

  test('nothing typed offers everything given', () => {
    expect(matching(some, '')).toHaveLength(3);
  });

  test('matching ignores case', () => {
    expect(matching(some, 'DEF').map((entry) => entry.prefix)).toEqual(['def']);
  });

  test('a prefix that matches nothing is empty', () => {
    expect(matching(some, 'zzzz')).toEqual([]);
  });
});

describe('the word being typed', () => {
  test('is what a completion replaces', () => {
    expect(wordBefore('x = fo', 6)).toBe('fo');
  });

  test('stops at punctuation', () => {
    expect(wordBefore('items.appen', 11)).toBe('appen');
  });

  test('is empty after a space', () => {
    expect(wordBefore('def ', 4)).toBe('');
  });

  test('underscores and digits are part of it', () => {
    expect(wordBefore('my_var2', 7)).toBe('my_var2');
  });
});

describe('re-indentation', () => {
  test('four spaces become the width the user set', () => {
    // The shipped pack is written with spaces.
    expect(reindent('def f():\n    return 1', 2)).toBe('def f():\n  return 1');
  });

  test('tabs work too, for a snippet pasted in from elsewhere', () => {
    expect(reindent('def f():\n\treturn 1', 4)).toBe('def f():\n    return 1');
  });

  test('nesting is multiplied, not flattened', () => {
    expect(reindent('a\n        b', 2)).toBe('a\n    b');
  });

  test('a tab size of zero keeps tabs', () => {
    expect(reindent('a\n\tb', 0)).toBe('a\n\tb');
  });

  test('continuation lines take the caret indentation', () => {
    // Otherwise a snippet inserted inside a function comes back flush left.
    expect(reindent('if x:\n    pass', 4, '    ')).toBe('if x:\n        pass');
  });

  test('the first line is left where the caret already is', () => {
    expect(reindent('if x:\n    pass', 4, '    ').startsWith('if')).toBe(true);
  });

  test('a body with no indentation is unchanged', () => {
    expect(reindent('print(1)', 4)).toBe('print(1)');
  });
});
