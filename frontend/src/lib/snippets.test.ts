import { describe, expect, test } from 'vitest';

import {
  SNIPPETS,
  type Snippet,
  matching,
  placeholders,
  reindent,
  snippetsFor,
  validate,
  wordBefore,
} from './snippets';

const snippet = (over: Partial<Snippet> = {}): Snippet => ({
  prefix: 'p',
  label: 'p',
  description: 'd',
  body: 'body $0',
  languages: ['python'],
  ...over,
});

describe('the library itself', () => {
  test('every body is well formed', () => {
    // A malformed body inserts a literal '${1:' into someone's source, and the
    // moment to find that out is not while they are typing.
    const broken = SNIPPETS.map((entry) => [entry.prefix, validate(entry)] as const).filter(
      ([, problem]) => problem !== null,
    );

    expect(broken).toEqual([]);
  });

  test('a prefix belongs to one snippet per language', () => {
    // Two snippets fighting over 'for' is a bug, not a preference.
    const seen = new Map<string, string[]>();
    for (const entry of SNIPPETS) {
      for (const language of entry.languages) {
        const key = `${language}:${entry.prefix}`;
        seen.set(key, [...(seen.get(key) ?? []), entry.label]);
      }
    }

    expect([...seen].filter(([, labels]) => labels.length > 1)).toEqual([]);
  });

  test('the same prefix may mean different things in different languages', () => {
    // 'main' is a class in Java and a guard in Python; that is not a conflict.
    expect(matching('python', 'main')).toHaveLength(1);
    expect(matching('go', 'main')).toHaveLength(1);
  });

  test('every snippet says what it is for', () => {
    expect(SNIPPETS.every((entry) => entry.description.trim().length > 0)).toBe(true);
  });

  test('the languages covered are the ones the editor runs', () => {
    const covered = new Set(SNIPPETS.flatMap((entry) => entry.languages));

    for (const language of ['python', 'c', 'cpp', 'rust', 'go', 'java', 'typescript']) {
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

  test('a snippet in no language is caught', () => {
    expect(validate(snippet({ languages: [] }))).toMatch('unreachable');
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

  test('an empty default is still a stop', () => {
    expect(placeholders('${1:}')).toEqual([{ ordinal: 1, value: '' }]);
  });

  test('a body with no stops has none', () => {
    expect(placeholders('print("hello")')).toEqual([]);
  });
});

describe('matching', () => {
  test('what has been typed narrows the list', () => {
    const all = snippetsFor('python').length;

    expect(matching('python', 'd').length).toBeLessThan(all);
    expect(matching('python', 'd').every((entry) => entry.prefix.startsWith('d'))).toBe(true);
  });

  test('nothing typed offers everything for the language', () => {
    expect(matching('python', '')).toEqual(snippetsFor('python'));
  });

  test('matching ignores case', () => {
    expect(matching('python', 'DEF').map((entry) => entry.prefix)).toContain('def');
  });

  test('a language with no snippets gets none rather than everything', () => {
    expect(snippetsFor('brainfuck')).toEqual([]);
  });

  test('a prefix that matches nothing is empty', () => {
    expect(matching('python', 'zzzz')).toEqual([]);
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

  test('is empty at the start of a file', () => {
    expect(wordBefore('', 0)).toBe('');
  });

  test('underscores and digits are part of it', () => {
    expect(wordBefore('my_var2', 7)).toBe('my_var2');
  });
});

describe('re-indentation', () => {
  test('tabs become the width the user set', () => {
    expect(reindent('def f():\n\treturn 1', 4)).toBe('def f():\n    return 1');
  });

  test('nesting is multiplied, not flattened', () => {
    expect(reindent('a\n\t\tb', 2)).toBe('a\n    b');
  });

  test('a tab size of zero keeps tabs', () => {
    expect(reindent('a\n\tb', 0)).toBe('a\n\tb');
  });

  test('continuation lines take the caret indentation', () => {
    // Otherwise a snippet inserted inside a function comes back flush left.
    expect(reindent('if x:\n\tpass', 4, '    ')).toBe('if x:\n        pass');
  });

  test('the first line is left where the caret already is', () => {
    expect(reindent('if x:\n\tpass', 4, '    ').startsWith('if')).toBe(true);
  });

  test('a body with no indentation is unchanged', () => {
    expect(reindent('print(1)', 4)).toBe('print(1)');
  });
});
