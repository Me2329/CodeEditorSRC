import { describe, expect, it } from 'vitest';

import { enclosing, filterOutline, outlineFor } from './outline';
import type { Symbol as WorkspaceSymbol } from './types';

function symbol(
  name: string,
  line: number,
  container = '',
  file = 'main.py',
  kind = 'function',
): WorkspaceSymbol {
  return { name, kind, file, line, detail: `def ${name}()`, container };
}

describe('outlineFor', () => {
  it('keeps only the file asked for', () => {
    const entries = outlineFor([symbol('here', 1), symbol('elsewhere', 1, '', 'other.py')], 'main.py');
    expect(entries.map((entry) => entry.name)).toEqual(['here']);
  });

  it('puts declarations in line order whatever order they were indexed in', () => {
    const entries = outlineFor([symbol('second', 10), symbol('first', 2)], 'main.py');
    expect(entries.map((entry) => entry.name)).toEqual(['first', 'second']);
  });

  it('nests a method under its class', () => {
    const entries = outlineFor(
      [symbol('Engine', 1, '', 'main.py', 'class'), symbol('start', 2, 'Engine')],
      'main.py',
    );
    expect(entries.map((entry) => entry.depth)).toEqual([0, 1]);
  });

  it('nests as deep as the containers go', () => {
    const entries = outlineFor(
      [
        symbol('Engine', 1, '', 'main.py', 'class'),
        symbol('start', 2, 'Engine'),
        symbol('inner', 3, 'start'),
      ],
      'main.py',
    );
    expect(entries.map((entry) => entry.depth)).toEqual([0, 1, 2]);
  });

  it('takes the nearest earlier declaration of a repeated container name', () => {
    // Two classes, both with a `save`. The second `save` belongs to the second.
    const entries = outlineFor(
      [
        symbol('Store', 1, '', 'main.py', 'class'),
        symbol('save', 2, 'Store'),
        symbol('Cache', 8, '', 'main.py', 'class'),
        symbol('save', 9, 'Cache'),
      ],
      'main.py',
    );
    expect(entries.map((entry) => entry.depth)).toEqual([0, 1, 0, 1]);
  });

  it('leaves a symbol at the top when its container is not in the file', () => {
    const entries = outlineFor([symbol('orphan', 4, 'Missing')], 'main.py');
    expect(entries[0]?.depth).toBe(0);
  });

  it('survives a daemon that does not report containers', () => {
    const older = { name: 'f', kind: 'function', file: 'main.py', line: 1, detail: '' };
    expect(outlineFor([older as WorkspaceSymbol], 'main.py')[0]?.depth).toBe(0);
  });

  it('is empty when no file is open', () => {
    expect(outlineFor([symbol('f', 1)], '')).toEqual([]);
  });
});

describe('enclosing', () => {
  const entries = outlineFor(
    [symbol('first', 3), symbol('second', 10), symbol('third', 20)],
    'main.py',
  );

  it('is the last declaration at or above the caret', () => {
    expect(enclosing(entries, 12)).toBe(1);
    expect(enclosing(entries, 10)).toBe(1);
  });

  it('is nothing above the first declaration', () => {
    expect(enclosing(entries, 1)).toBe(-1);
  });

  it('is the last declaration below the last one', () => {
    expect(enclosing(entries, 400)).toBe(2);
  });

  it('has nothing to say about an empty outline', () => {
    expect(enclosing([], 5)).toBe(-1);
  });
});

describe('filterOutline', () => {
  const entries = outlineFor(
    [
      symbol('Editor', 1, '', 'main.py', 'class'),
      symbol('save', 2, 'Editor'),
      symbol('load', 3, 'Editor'),
      symbol('helper', 9),
    ],
    'main.py',
  );

  it('returns everything for an empty query', () => {
    expect(filterOutline(entries, '  ')).toHaveLength(4);
  });

  it('keeps the class a matching method belongs to', () => {
    expect(filterOutline(entries, 'save').map((entry) => entry.name)).toEqual(['Editor', 'save']);
  });

  it('matches without regard to case, anywhere in the name', () => {
    expect(filterOutline(entries, 'ELP').map((entry) => entry.name)).toEqual(['helper']);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterOutline(entries, 'zzz')).toEqual([]);
  });

  it('keeps every level above a deep match', () => {
    const deep = outlineFor(
      [
        symbol('Outer', 1, '', 'main.py', 'class'),
        symbol('middle', 2, 'Outer'),
        symbol('target', 3, 'middle'),
      ],
      'main.py',
    );
    expect(filterOutline(deep, 'target').map((entry) => entry.name)).toEqual([
      'Outer',
      'middle',
      'target',
    ]);
  });
});
