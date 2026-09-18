/**
 * Measuring a file's whitespace rather than assuming it.
 *
 * Both failures being guarded against are invisible ones: an indent that looks
 * identical on screen and wrong in the diff, and a line ending that turns every
 * line of the next diff into a change.
 */

import { describe, expect, it } from 'vitest';

import {
  describeEndings,
  describeIndentation,
  detectIndentation,
  detectLineEndings,
  normaliseLineEndings,
  whitespaceProblems,
} from './whitespace';

describe('detectIndentation', () => {
  it('finds two-space indentation', () => {
    const text = ['function f() {', '  if (a) {', '    b();', '  }', '}'].join('\n');
    const indent = detectIndentation(text);
    expect(indent.kind).toBe('spaces');
    expect(indent.width).toBe(2);
  });

  it('finds four-space indentation', () => {
    const text = ['def f():', '    if a:', '        b()', '    return'].join('\n');
    expect(detectIndentation(text).width).toBe(4);
  });

  it('measures the step, not the absolute indentation', () => {
    // A file indented by two has plenty of lines at four, six and eight
    // columns; counting those directly would make two look rare.
    const text = ['a', '  b', '    c', '      d', '        e'].join('\n');
    expect(detectIndentation(text).width).toBe(2);
  });

  it('finds tabs', () => {
    const text = ['function f() {', '\tif (a) {', '\t\tb();', '\t}', '}'].join('\n');
    expect(detectIndentation(text).kind).toBe('tabs');
  });

  it('notices a file using both', () => {
    const text = ['a', '\tb', '  c'].join('\n');
    expect(detectIndentation(text).mixed).toBe(true);
  });

  it('falls back when there is no indentation to read', () => {
    const indent = detectIndentation('a\nb\nc', 4);
    expect(indent.kind).toBe('unknown');
    expect(indent.width).toBe(4);
    expect(indent.confidence).toBe(0);
  });

  it('falls back on an empty file', () => {
    expect(detectIndentation('').kind).toBe('unknown');
  });

  it('ignores blank lines', () => {
    const text = ['a', '', '  b', '', '    c'].join('\n');
    expect(detectIndentation(text).width).toBe(2);
  });

  it('reports how much of the file agreed', () => {
    const text = ['a', '  b', '    c'].join('\n');
    expect(detectIndentation(text).confidence).toBe(1);
  });

  it('ignores a step too large to be an indent', () => {
    const text = ['a', '              b'].join('\n');
    expect(detectIndentation(text, 4).width).toBe(4);
  });

  it('describes itself in words', () => {
    expect(describeIndentation({ kind: 'tabs', width: 4, confidence: 1, mixed: false })).toBe(
      'Tabs',
    );
    expect(describeIndentation({ kind: 'spaces', width: 2, confidence: 1, mixed: false })).toBe(
      '2 spaces',
    );
    expect(
      describeIndentation({ kind: 'spaces', width: 2, confidence: 1, mixed: true }),
    ).toContain('mixed');
    expect(
      describeIndentation({ kind: 'unknown', width: 4, confidence: 0, mixed: false }),
    ).toBe('No indentation');
  });
});

describe('detectLineEndings', () => {
  it('finds LF', () => {
    const endings = detectLineEndings('a\nb\nc');
    expect(endings.dominant).toBe('LF');
    expect(endings.lf).toBe(2);
    expect(endings.mixed).toBe(false);
  });

  it('finds CRLF, and does not double-count its LF', () => {
    const endings = detectLineEndings('a\r\nb\r\nc');
    expect(endings.dominant).toBe('CRLF');
    expect(endings.crlf).toBe(2);
    expect(endings.lf).toBe(0);
  });

  it('finds a lone CR', () => {
    const endings = detectLineEndings('a\rb\rc');
    expect(endings.dominant).toBe('CR');
    expect(endings.cr).toBe(2);
  });

  it('notices a file with more than one kind', () => {
    // Which no tool produces on purpose, and every diff notices.
    const endings = detectLineEndings('a\r\nb\nc');
    expect(endings.mixed).toBe(true);
    expect(endings.crlf).toBe(1);
    expect(endings.lf).toBe(1);
  });

  it('reports the dominant kind in a mixed file', () => {
    expect(detectLineEndings('a\r\nb\r\nc\nd').dominant).toBe('CRLF');
  });

  it('has nothing to report for a single line', () => {
    expect(detectLineEndings('just one line').dominant).toBe('none');
  });

  it('describes itself in words', () => {
    expect(describeEndings(detectLineEndings('a\nb'))).toBe('LF');
    expect(describeEndings(detectLineEndings('one line'))).toBe('No line endings');
    expect(describeEndings(detectLineEndings('a\r\nb\nc'))).toContain('Mixed');
  });
});

describe('normaliseLineEndings', () => {
  it('rewrites every ending as one kind', () => {
    expect(normaliseLineEndings('a\r\nb\rc\nd', 'LF')).toBe('a\nb\nc\nd');
    expect(normaliseLineEndings('a\nb', 'CRLF')).toBe('a\r\nb');
    expect(normaliseLineEndings('a\r\nb', 'CR')).toBe('a\rb');
  });

  it('is idempotent', () => {
    const once = normaliseLineEndings('a\r\nb\nc', 'CRLF');
    expect(normaliseLineEndings(once, 'CRLF')).toBe(once);
  });

  it('leaves a file with no line endings alone', () => {
    expect(normaliseLineEndings('one line', 'CRLF')).toBe('one line');
  });
});

describe('whitespaceProblems', () => {
  it('finds trailing whitespace, by line', () => {
    const found = whitespaceProblems('a\nb  \nc');
    expect(found).toEqual([{ line: 2, kind: 'trailing', detail: 'trailing whitespace' }]);
  });

  it('finds tabs and spaces in the same indent', () => {
    const found = whitespaceProblems('\t  a');
    expect(found.map((one) => one.kind)).toContain('mixed-indent');
  });

  it('finds an invisible space that is not a space', () => {
    // What a paste from a web page leaves behind, and the error it causes
    // names a line that looks perfectly fine.
    const found = whitespaceProblems('x = 1');
    expect(found.map((one) => one.kind)).toContain('non-breaking-space');
  });

  it('finds several kinds on one line', () => {
    const found = whitespaceProblems('\t  a  ');
    expect(new Set(found.map((one) => one.kind)).size).toBeGreaterThan(1);
    expect(found.every((one) => one.line === 1)).toBe(true);
  });

  it('finds nothing in a clean file', () => {
    expect(whitespaceProblems('def f():\n    return 1\n')).toEqual([]);
  });

  it('does not call a blank line trailing whitespace it cannot fix', () => {
    // A line that is only spaces is trailing whitespace, and is reported.
    expect(whitespaceProblems('a\n   \nb').map((one) => one.line)).toEqual([2]);
  });
});
