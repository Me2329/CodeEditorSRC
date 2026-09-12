import { describe, expect, test } from 'vitest';

import type { EditorContext } from '../types';
import type { VirtualFile } from '../../types';
import { STATUS_ITEMS, indentIndicator, lineEndings, problemCount } from './status';

const file = (content: string): VirtualFile => ({
  id: 'a',
  name: 'a.py',
  language: 'python',
  content,
});

const context = (over: Partial<EditorContext> = {}): EditorContext => ({
  files: [],
  activeFile: file(''),
  language: 'python',
  selection: '',
  line: 1,
  column: 1,
  ...over,
});

describe('what each item says', () => {
  test('nothing about a file, when there is no file', () => {
    // The bar stays quiet rather than showing zeroes. The language is the
    // exception and deliberately so: it is the workspace's runtime, which is
    // chosen and meaningful whether or not a file happens to be open.
    for (const item of STATUS_ITEMS) {
      const rendered = item.render(context({ activeFile: null }));
      if (item.id === 'status.language') {
        expect(rendered?.text).toBe('python');
      } else {
        expect(rendered).toBeNull();
      }
    }
  });

  test('line endings, and a warning when a file has both', () => {
    expect(lineEndings.render(context({ activeFile: file('a\nb\n') }))?.text).toBe('LF');
    expect(lineEndings.render(context({ activeFile: file('a\r\nb\r\n') }))?.text).toBe('CRLF');

    const mixed = lineEndings.render(context({ activeFile: file('a\r\nb\nc\n') }));
    expect(mixed?.text).toBe('Mixed EOL');
    expect(mixed?.tone).toBe('warning');
  });

  test('the file\'s real indentation, not the preference', () => {
    expect(indentIndicator.render(context({ activeFile: file('def f():\n  return 1\n') }))?.text)
      .toBe('Spaces: 2');
    expect(indentIndicator.render(context({ activeFile: file('def f():\n\treturn 1\n') }))?.text)
      .toBe('Tabs');
  });

  test('a file with no indentation says nothing about it', () => {
    expect(indentIndicator.render(context({ activeFile: file('x = 1\n') }))).toBeNull();
  });

  test('notes are counted by the shared scan', () => {
    // Counting the marker word alone also counted print("TODO").
    expect(problemCount.render(context({ activeFile: file('# TODO tidy\n') }))?.text).toBe('1 TODO');
    expect(problemCount.render(context({ activeFile: file('print("TODO")\n') }))).toBeNull();
  });
});

describe('the list', () => {
  test('every item has a distinct id', () => {
    expect(new Set(STATUS_ITEMS.map((item) => item.id)).size).toBe(STATUS_ITEMS.length);
  });

  test('every item declares where it goes', () => {
    expect(STATUS_ITEMS.every((item) => item.alignment === 'left' || item.alignment === 'right'))
      .toBe(true);
  });

  test('every item survives an empty file', () => {
    for (const item of STATUS_ITEMS) {
      expect(() => item.render(context())).not.toThrow();
    }
  });
});
