/**
 * Commenting out, and putting it back.
 *
 * The three decisions worth testing are the ones that make a toggle feel right:
 * the marker lands at the block's own indentation, a mixed selection comments
 * rather than uncomments, and blank lines are left out of both.
 */

import { describe, expect, it } from 'vitest';

import {
  commonIndent,
  describeToggle,
  hasBlockComment,
  hasLineComment,
  toggleBlockComment,
  toggleLineComment,
} from './comments';

describe('commonIndent', () => {
  it('is the shortest indentation among the lines with content', () => {
    expect(commonIndent(['    a', '  b', '      c'])).toBe('  ');
  });

  it('ignores blank lines, which have no indentation to speak of', () => {
    expect(commonIndent(['    a', '', '    b'])).toBe('    ');
  });

  it('is empty when anything starts at column one', () => {
    expect(commonIndent(['a', '    b'])).toBe('');
  });

  it('is empty for nothing at all', () => {
    expect(commonIndent([])).toBe('');
    expect(commonIndent(['', '  '])).toBe('');
  });
});

describe('toggleLineComment', () => {
  it('comments at the block indentation, not at column one', () => {
    // Commenting at column one loses the shape of the block it came from.
    const plan = toggleLineComment(['    if (a) {', '        b();', '    }'], 'typescript');
    expect(plan.action).toBe('comment');
    expect(plan.lines).toEqual(['    // if (a) {', '    //     b();', '    // }']);
  });

  it('uncomments what it commented, exactly', () => {
    const lines = ['    if (a) {', '        b();', '    }'];
    const commented = toggleLineComment(lines, 'typescript').lines;
    expect(toggleLineComment(commented, 'typescript').lines).toEqual(lines);
  });

  it('comments a mixed selection rather than uncommenting it', () => {
    // Pressing the key once should leave everything commented, which is the
    // state the user is heading for.
    const plan = toggleLineComment(['// done', 'todo'], 'typescript');
    expect(plan.action).toBe('comment');
    expect(plan.lines).toEqual(['// // done', '// todo']);
  });

  it('leaves blank lines uncommented', () => {
    const plan = toggleLineComment(['a', '', 'b'], 'typescript');
    expect(plan.lines).toEqual(['// a', '', '// b']);
  });

  it('does not let a blank line make a commented block look mixed', () => {
    const plan = toggleLineComment(['// a', '', '// b'], 'typescript');
    expect(plan.action).toBe('uncomment');
    expect(plan.lines).toEqual(['a', '', 'b']);
  });

  it('uses each language own marker', () => {
    expect(toggleLineComment(['x'], 'python').lines).toEqual(['# x']);
    expect(toggleLineComment(['x'], 'lua').lines).toEqual(['-- x']);
    expect(toggleLineComment(['x'], 'clojure').lines).toEqual(['; x']);
    expect(toggleLineComment(['x'], 'erlang').lines).toEqual(['% x']);
  });

  it('removes a marker written without the space after it', () => {
    expect(toggleLineComment(['//x'], 'typescript').lines).toEqual(['x']);
  });

  it('removes only one space after the marker', () => {
    expect(toggleLineComment(['//  indented'], 'typescript').lines).toEqual([' indented']);
  });

  it('has nothing to do in a language with no line comment', () => {
    const plan = toggleLineComment(['{}'], 'json');
    expect(plan.action).toBe('nothing');
    expect(plan.lines).toEqual(['{}']);
  });

  it('has nothing to do on a selection of blank lines', () => {
    expect(toggleLineComment(['', '  '], 'typescript').action).toBe('nothing');
  });

  it('does not modify the lines it was given', () => {
    const original = ['a'];
    toggleLineComment(original, 'typescript');
    expect(original).toEqual(['a']);
  });
});

describe('toggleBlockComment', () => {
  it('wraps a selection', () => {
    expect(toggleBlockComment('a + b', 'typescript')).toEqual({
      action: 'comment',
      text: '/* a + b */',
    });
  });

  it('unwraps exactly what it wrapped', () => {
    const wrapped = toggleBlockComment('a + b', 'typescript').text;
    expect(toggleBlockComment(wrapped, 'typescript')).toEqual({
      action: 'uncomment',
      text: 'a + b',
    });
  });

  it('unwraps across lines', () => {
    expect(toggleBlockComment('/* one\ntwo */', 'typescript').text).toBe('one\ntwo');
  });

  it('leaves a selection that merely contains a comment alone', () => {
    // Removing the delimiters would join code that was never adjacent.
    const plan = toggleBlockComment('a /* note */ b', 'typescript');
    expect(plan.action).toBe('comment');
  });

  it('uses each language own delimiters', () => {
    expect(toggleBlockComment('x', 'html').text).toBe('<!-- x -->');
    expect(toggleBlockComment('x', 'haskell').text).toBe('{- x -}');
    expect(toggleBlockComment('x', 'lua').text).toBe('--[[ x ]]');
  });

  it('has nothing to do in a language with no block comment', () => {
    expect(toggleBlockComment('x', 'python')).toEqual({ action: 'nothing', text: 'x' });
  });

  it('does not mistake the delimiters themselves for a wrapped selection', () => {
    // `/*` alone is not an open and a close.
    expect(toggleBlockComment('/*', 'typescript').action).toBe('comment');
  });
});

describe('hasLineComment and hasBlockComment', () => {
  it('say what a language offers, for enabling a command', () => {
    expect(hasLineComment('typescript')).toBe(true);
    expect(hasBlockComment('typescript')).toBe(true);
    expect(hasBlockComment('python')).toBe(false);
    expect(hasLineComment('json')).toBe(false);
    expect(hasBlockComment('css')).toBe(true);
    expect(hasLineComment('css')).toBe(false);
  });
});

describe('describeToggle', () => {
  it('says which way it went, and how far', () => {
    expect(describeToggle('comment', 3)).toBe('Commented 3 lines');
    expect(describeToggle('uncomment', 1)).toBe('Uncommented 1 line');
    expect(describeToggle('nothing', 5)).toContain('no comment to toggle');
  });
});
