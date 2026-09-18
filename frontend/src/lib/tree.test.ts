import { describe, expect, test } from 'vitest';

import {
  type TreeFolder,
  ancestors,
  buildTree,
  flatten,
  folderPaths,
  navigate,
  reveal,
  toggle,
} from './tree';
import type { VirtualFile } from './types';

const file = (name: string): VirtualFile => ({
  id: name,
  name,
  language: 'python',
  content: '',
});

const shape = (names: string[]) =>
  flatten(buildTree(names.map(file))).map((row) => `${'  '.repeat(row.depth)}${row.node.name}`);

describe('building', () => {
  test('files with no slash sit at the top', () => {
    expect(shape(['main.py', 'util.py'])).toEqual(['main.py', 'util.py']);
  });

  test('a slash makes a folder', () => {
    expect(shape(['lib/util.py'])).toEqual(['lib', '  util.py']);
  });

  test('two files in one folder share it', () => {
    const tree = buildTree([file('lib/a.py'), file('lib/b.py')]);

    expect(tree).toHaveLength(1);
    expect((tree[0] as TreeFolder).children).toHaveLength(2);
  });

  test('folders nest as deeply as the path does', () => {
    expect(shape(['a/b/c/deep.py'])).toEqual(['a', '  b', '    c', '      deep.py']);
  });

  test('a folder keeps its full path, not just its name', () => {
    const tree = buildTree([file('a/b/c.py')]);
    const outer = tree[0] as TreeFolder;
    const inner = outer.children[0] as TreeFolder;

    expect(outer.path).toBe('a');
    expect(inner.path).toBe('a/b');
  });

  test('a file keeps the name it actually has', () => {
    const rows = flatten(buildTree([file('lib/util.py')]));

    expect(rows[1]!.node.name).toBe('util.py');
    expect(rows[1]!.node.path).toBe('lib/util.py');
  });

  test('the file itself is carried through', () => {
    const rows = flatten(buildTree([file('lib/util.py')]));
    const node = rows[1]!.node;

    expect(node.kind === 'file' && node.file.id).toBe('lib/util.py');
  });

  test('an empty workspace is an empty tree', () => {
    expect(buildTree([])).toEqual([]);
  });

  test('a name that is only slashes is skipped rather than crashing', () => {
    expect(buildTree([file('///')])).toEqual([]);
  });
});

describe('ordering', () => {
  test('folders come before files', () => {
    // A list that interleaves them is harder to scan than one that does not.
    expect(shape(['zebra.py', 'lib/a.py'])).toEqual(['lib', '  a.py', 'zebra.py']);
  });

  test('names sort alphabetically regardless of case', () => {
    expect(shape(['Beta.py', 'alpha.py'])).toEqual(['alpha.py', 'Beta.py']);
  });

  test('numbers sort as numbers', () => {
    // part10 after part2, which is what a reader expects and bytes do not do.
    expect(shape(['part10.py', 'part2.py'])).toEqual(['part2.py', 'part10.py']);
  });

  test('nested folders are sorted too', () => {
    expect(shape(['a/z.py', 'a/b/inner.py'])).toEqual(['a', '  b', '    inner.py', '  z.py']);
  });

  test('insertion order does not matter', () => {
    expect(shape(['lib/b.py', 'lib/a.py', 'main.py'])).toEqual(shape([
      'main.py',
      'lib/a.py',
      'lib/b.py',
    ]));
  });
});

describe('collapsing', () => {
  test('a collapsed folder hides what is in it', () => {
    const tree = buildTree([file('lib/a.py'), file('main.py')]);
    const rows = flatten(tree, new Set(['lib']));

    expect(rows.map((row) => row.node.name)).toEqual(['lib', 'main.py']);
  });

  test('collapsing hides nested folders too', () => {
    const tree = buildTree([file('a/b/c.py')]);

    expect(flatten(tree, new Set(['a']))).toHaveLength(1);
  });

  test('toggling closes an open folder and opens a closed one', () => {
    expect(toggle(new Set(), 'lib').has('lib')).toBe(true);
    expect(toggle(new Set(['lib']), 'lib').has('lib')).toBe(false);
  });

  test('toggling does not change the set it was given', () => {
    const before = new Set(['lib']);
    toggle(before, 'other');

    expect([...before]).toEqual(['lib']);
  });

  test('every folder can be listed', () => {
    const tree = buildTree([file('a/b/c.py'), file('d/e.py')]);

    expect(folderPaths(tree).sort()).toEqual(['a', 'a/b', 'd']);
  });
});

describe('revealing', () => {
  test('the folders on the way to a file', () => {
    expect(ancestors('a/b/c.py')).toEqual(['a', 'a/b']);
  });

  test('a file at the top has none', () => {
    expect(ancestors('main.py')).toEqual([]);
  });

  test('opening the way to a file leaves other folders alone', () => {
    // Showing a search hit inside a collapsed folder should open that folder
    // and nothing else.
    const collapsed = new Set(['a', 'a/b', 'unrelated']);

    expect([...reveal(collapsed, 'a/b/c.py')]).toEqual(['unrelated']);
  });
});


describe('keyboard navigation', () => {
  // lib/          (folder, row 0)
  //   deep/       (folder, row 1)
  //     c.py      (row 2)
  //   b.py        (row 3)
  // a.py          (row 4)
  const files = [file('lib/deep/c.py'), file('lib/b.py'), file('a.py')];
  const rows = flatten(buildTree(files));
  const open = new Set<string>();

  test('down and up move one visible row', () => {
    expect(navigate(rows, 0, 'ArrowDown', open).index).toBe(1);
    expect(navigate(rows, 2, 'ArrowUp', open).index).toBe(1);
  });

  test('they stop at the ends rather than wrapping', () => {
    // A tree that wraps loses your place; a list that stops does not.
    expect(navigate(rows, 0, 'ArrowUp', open).index).toBe(0);
    expect(navigate(rows, rows.length - 1, 'ArrowDown', open).index).toBe(rows.length - 1);
  });

  test('Home and End go to the ends', () => {
    expect(navigate(rows, 3, 'Home', open).index).toBe(0);
    expect(navigate(rows, 0, 'End', open).index).toBe(rows.length - 1);
  });

  test('right opens a closed folder', () => {
    const closed = new Set(['lib']);
    const move = navigate(flatten(buildTree(files), closed), 0, 'ArrowRight', closed);

    expect(move.collapsed.has('lib')).toBe(false);
    expect(move.index).toBe(0);
  });

  test('right steps into a folder that is already open', () => {
    expect(navigate(rows, 0, 'ArrowRight', open).index).toBe(1);
  });

  test('right on a file does nothing', () => {
    expect(navigate(rows, 4, 'ArrowRight', open).index).toBe(4);
  });

  test('left closes an open folder', () => {
    expect(navigate(rows, 0, 'ArrowLeft', open).collapsed.has('lib')).toBe(true);
  });

  test('left on a file steps out to its folder', () => {
    // Row 2 is c.py at depth 2; its parent is deep at row 1.
    expect(navigate(rows, 2, 'ArrowLeft', open).index).toBe(1);
  });

  test('left at the top level stays put', () => {
    expect(navigate(rows, 4, 'ArrowLeft', open).index).toBe(4);
  });

  test('Enter and Space mean use this row', () => {
    expect(navigate(rows, 2, 'Enter', open).activate).toBe(true);
    expect(navigate(rows, 0, ' ', open).activate).toBe(true);
  });

  test('any other key changes nothing', () => {
    const move = navigate(rows, 2, 'q', open);

    expect(move.index).toBe(2);
    expect(move.activate).toBe(false);
  });

  test('an empty tree has nowhere to go', () => {
    expect(navigate([], 0, 'ArrowDown', open).index).toBe(0);
  });
});
