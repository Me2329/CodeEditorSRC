import { describe, expect, test } from 'vitest';

import { countByKind, outstanding, scanFile, scanWorkspace } from './todos';
import type { VirtualFile } from './types';

const file = (name: string, content: string): VirtualFile => ({
  id: name,
  name,
  language: 'python',
  content,
});

describe('finding markers', () => {
  test('a hash comment', () => {
    const [found] = scanFile(file('a.py', '# TODO: tidy this up'));

    expect(found).toMatchObject({ kind: 'TODO', line: 1, text: 'tidy this up' });
  });

  test('a slash comment', () => {
    expect(scanFile(file('a.ts', '// FIXME broken'))[0]).toMatchObject({
      kind: 'FIXME',
      text: 'broken',
    });
  });

  test('a continuation line in a block comment', () => {
    expect(scanFile(file('a.c', '/*\n * TODO finish\n */'))[0]).toMatchObject({
      kind: 'TODO',
      line: 2,
      text: 'finish',
    });
  });

  test('a marker on a line of its own', () => {
    expect(scanFile(file('a.md', 'TODO write this'))).toHaveLength(1);
  });

  test('the line number is the one the editor shows', () => {
    expect(scanFile(file('a.py', 'one\ntwo\n# TODO here'))[0]!.line).toBe(3);
  });

  test('every marker kind is recognised', () => {
    const source = ['# TODO a', '# FIXME b', '# HACK c', '# XXX d', '# NOTE e', '# BUG f'].join('\n');

    expect(scanFile(file('a.py', source)).map((todo) => todo.kind).sort()).toEqual(
      ['BUG', 'FIXME', 'HACK', 'NOTE', 'TODO', 'XXX'],
    );
  });

  test('trailing comment punctuation is not part of the note', () => {
    expect(scanFile(file('a.c', '/* TODO finish this */'))[0]!.text).toBe('finish this');
    expect(scanFile(file('a.html', '<!-- TODO add alt text -->'))[0]!.text).toBe('add alt text');
  });

  test('a marker with no text is still a marker', () => {
    expect(scanFile(file('a.py', '# TODO'))[0]).toMatchObject({ kind: 'TODO', text: '' });
  });
});

describe('what is not a marker', () => {
  test('a string is not a comment', () => {
    // The heuristic that keeps the list from being mostly noise.
    expect(scanFile(file('a.py', 'print("TODO")'))).toEqual([]);
  });

  test('code before the marker disqualifies it', () => {
    expect(scanFile(file('a.py', 'value = TODO_CONSTANT'))).toEqual([]);
  });

  test('a word containing a marker is not one', () => {
    expect(scanFile(file('a.py', '# TODOS everywhere'))).toEqual([]);
  });

  test('a marker later in a comment is still found', () => {
    // Requiring the opener immediately before it would miss every note written
    // mid-sentence, which is most of the interesting ones.
    expect(scanFile(file('a.ts', '// see issue 12; TODO refactor'))[0]).toMatchObject({
      kind: 'TODO',
      text: 'refactor',
    });
  });

  test('a trailing comment after code counts', () => {
    expect(scanFile(file('a.py', 'value = 1  # TODO make this configurable'))[0]).toMatchObject({
      text: 'make this configurable',
    });
  });

  test('a file with nothing in it has nothing', () => {
    expect(scanFile(file('a.py', ''))).toEqual([]);
  });
});

describe('the workspace list', () => {
  const files = [
    file('b.py', '# TODO second\n# FIXME first'),
    file('a.py', '# NOTE last\n# TODO also second'),
  ];

  test('the most urgent kind comes first', () => {
    // The question is "what is worst", not "what is where".
    expect(scanWorkspace(files).map((todo) => todo.kind)).toEqual([
      'FIXME',
      'TODO',
      'TODO',
      'NOTE',
    ]);
  });

  test('within a kind, by file and line', () => {
    const todos = scanWorkspace(files).filter((todo) => todo.kind === 'TODO');

    expect(todos.map((todo) => todo.fileName)).toEqual(['a.py', 'b.py']);
  });

  test('each carries the file it came from', () => {
    expect(scanWorkspace(files)[0]).toMatchObject({ fileName: 'b.py', line: 2 });
  });

  test('an empty workspace has nothing', () => {
    expect(scanWorkspace([])).toEqual([]);
  });
});

describe('counting', () => {
  const todos = scanWorkspace([file('a.py', '# TODO a\n# TODO b\n# NOTE c\n# BUG d')]);

  test('by kind', () => {
    expect(countByKind(todos)).toMatchObject({ TODO: 2, NOTE: 1, BUG: 1, FIXME: 0 });
  });

  test('notes are not outstanding work', () => {
    // Otherwise a number that should mean "things to fix" means "comments".
    expect(outstanding(todos)).toBe(3);
  });
});
