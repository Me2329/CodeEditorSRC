/**
 * Telling code from prose, which is what makes a rename safe to offer.
 *
 * The bias under test throughout: when the scanner cannot tell, it must say
 * code. A mislabelled comment is a line the reader declines; a mislabelled
 * piece of code is an occurrence the rename silently leaves behind.
 */

import { describe, expect, it } from 'vitest';

import {
  isKeyword,
  occurrencesOf,
  regionOf,
  rulesFor,
  scan,
  type SyntaxRules,
} from './syntax';

const C = rulesFor('cpp');
const JS = rulesFor('javascript');
const PY = rulesFor('python');

function regions(text: string, rules: SyntaxRules): Region[] {
  return [...text].map((_, offset) => regionOf(scan(text, rules), offset));
}

type Region = 'code' | 'comment' | 'string';

describe('scan', () => {
  it('finds a line comment and stops at the newline', () => {
    const text = 'int x; // note\nint y;';
    expect(scan(text, C)).toEqual([{ start: 7, end: 14, region: 'comment' }]);
  });

  it('finds a block comment across lines', () => {
    const text = 'a\n/* one\n   two */\nb';
    expect(scan(text, C)).toEqual([{ start: 2, end: 18, region: 'comment' }]);
  });

  it('runs an unterminated block comment to the end, as a compiler would', () => {
    const text = 'a /* never closed';
    expect(scan(text, C)).toEqual([{ start: 2, end: 17, region: 'comment' }]);
  });

  it('counts nested block comments where the language nests them', () => {
    const text = 'a /* one /* two */ still */ b';
    const [span] = scan(text, rulesFor('rust'));
    expect(span?.end).toBe(27);
    // The C family stops at the first close, which is what C actually does.
    const [cSpan] = scan(text, C);
    expect(cSpan?.end).toBe(18);
  });

  it('finds a string and respects the escape', () => {
    const text = 'x = "a \\" b" + y';
    expect(scan(text, C)).toEqual([{ start: 4, end: 12, region: 'string' }]);
  });

  it('does not let a single-line string swallow the file', () => {
    // An apostrophe in prose, or a Rust lifetime: far likelier than a literal
    // running to the end of the file.
    const text = "let a = 'x;\nlet b = 2;";
    expect(scan(text, C)).toEqual([]);
  });

  it('lets a multiline literal cross newlines', () => {
    const text = 'x = `one\ntwo`;';
    expect(scan(text, JS)).toEqual([{ start: 4, end: 13, region: 'string' }]);
  });

  it('reads a triple-quoted docstring as one string, not three', () => {
    const text = 'def f():\n    """say "hi" here"""\n    pass';
    expect(scan(text, PY)).toEqual([{ start: 13, end: 32, region: 'string' }]);
  });

  it('does not treat a comment marker inside a string as a comment', () => {
    const text = 'const url = "https://example.com"; // real';
    expect(scan(text, JS)).toEqual([
      { start: 12, end: 33, region: 'string' },
      { start: 35, end: 42, region: 'comment' },
    ]);
  });

  it('does not treat a quote inside a comment as a string', () => {
    const text = "// don't do this\nint x = 1;";
    expect(scan(text, C)).toEqual([{ start: 0, end: 16, region: 'comment' }]);
  });

  it('prefers the longer delimiter where two could match', () => {
    // `--[[` is a block comment in Lua and `--` is a line comment.
    const text = 'x --[[ block ]] y -- line';
    expect(scan(text, rulesFor('lua'))).toEqual([
      { start: 2, end: 15, region: 'comment' },
      { start: 18, end: 25, region: 'comment' },
    ]);
  });

  it('has nothing to say about a language with neither', () => {
    expect(scan('{"a": "b"}', rulesFor('json'))).toEqual([]);
  });
});

describe('regionOf', () => {
  it('reports code outside every span', () => {
    expect(regions('ab// c', C)).toEqual(['code', 'code', 'comment', 'comment', 'comment', 'comment']);
  });

  it('reports code when there are no spans at all', () => {
    expect(regionOf([], 0)).toBe('code');
    expect(regionOf([], 9999)).toBe('code');
  });

  it('treats the end of a span as outside it', () => {
    const spans = scan('a // b\nc', C);
    expect(regionOf(spans, 5)).toBe('comment');
    expect(regionOf(spans, 6)).toBe('code');
  });
});

describe('occurrencesOf', () => {
  it('finds whole words and says what each one is part of', () => {
    const text = [
      'function save(x) {',
      '  // save it somewhere',
      '  log("save failed");',
      '  return save(x);',
      '}',
    ].join('\n');

    expect(occurrencesOf(text, 'save', JS).map((one) => one.region)).toEqual([
      'code',
      'comment',
      'string',
      'code',
    ]);
  });

  it('ignores a name that is part of a longer one', () => {
    const text = 'save saved autosave save_all _save save';
    expect(occurrencesOf(text, 'save', JS)).toHaveLength(2);
  });

  it('treats punctuation on either side as a boundary', () => {
    expect(occurrencesOf('obj.save();', 'save', JS)).toHaveLength(1);
  });

  it('has no occurrences of nothing', () => {
    expect(occurrencesOf('anything', '', JS)).toEqual([]);
  });

  it('reports offsets that index the text', () => {
    const text = 'a save b save';
    const found = occurrencesOf(text, 'save', JS);
    expect(found.map((one) => one.offset)).toEqual([2, 9]);
    for (const one of found) {
      expect(text.slice(one.offset, one.offset + 4)).toBe('save');
    }
  });
});

describe('rulesFor', () => {
  it('falls back to the C family rather than to nothing', () => {
    // A wrong guess costs a mislabelled occurrence; no guess costs the whole
    // distinction, and every occurrence would read as code.
    const unknown = rulesFor('some-language-nobody-added');
    expect(unknown.lineComment).toContain('//');
  });

  it('knows the hash-comment languages', () => {
    expect(rulesFor('python').lineComment).toEqual(['#']);
    expect(rulesFor('shell').lineComment).toEqual(['#']);
    expect(rulesFor('yaml').lineComment).toEqual(['#']);
  });

  it('knows that markdown has no strings to speak of', () => {
    expect(rulesFor('markdown').strings).toEqual([]);
  });
});

describe('isKeyword', () => {
  it('knows what each language has spoken for', () => {
    expect(isKeyword('def', 'python')).toBe(true);
    expect(isKeyword('fn', 'rust')).toBe(true);
    expect(isKeyword('func', 'go')).toBe(true);
    expect(isKeyword('interface', 'typescript')).toBe(true);
    expect(isKeyword('fi', 'shell')).toBe(true);
  });

  it('does not reserve a word in a language that does not', () => {
    // `def` is Python's, not JavaScript's; `fn` is Rust's, not Python's.
    expect(isKeyword('def', 'javascript')).toBe(false);
    expect(isKeyword('fn', 'python')).toBe(false);
    expect(isKeyword('interface', 'javascript')).toBe(false);
  });

  it('does not reserve an ordinary name anywhere', () => {
    for (const language of ['python', 'typescript', 'rust', 'go', 'c', 'cpp']) {
      expect(isKeyword('saveAll', language)).toBe(false);
      expect(isKeyword('value', language)).toBe(false);
    }
  });

  it('gives an unknown language the control-flow core', () => {
    // Refusing `return` where it is not reserved costs a message. Allowing it
    // where it is costs the file, so the doubt resolves the other way here
    // than it does in `scan`.
    expect(isKeyword('return', 'some-language-nobody-added')).toBe(true);
    expect(isKeyword('if', 'some-language-nobody-added')).toBe(true);
    expect(isKeyword('saveAll', 'some-language-nobody-added')).toBe(false);
  });

  it('reserves nothing in a language that is only data', () => {
    expect(isKeyword('if', 'json')).toBe(false);
    expect(isKeyword('return', 'markdown')).toBe(false);
  });
});
