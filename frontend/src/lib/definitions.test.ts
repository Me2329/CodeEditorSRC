import { describe, expect, it } from 'vitest';

import { declarationsOf, definitionFrom, describeDeclarations, wordAt } from './definitions';
import type { Symbol as WorkspaceSymbol } from './types';

function symbol(name: string, file: string, line: number): WorkspaceSymbol {
  return { name, kind: 'function', file, line, detail: `def ${name}()` };
}

describe('wordAt', () => {
  it('reads the identifier the caret is inside', () => {
    expect(wordAt('total = parse(text)', 10)).toBe('parse');
  });

  it('reads the identifier the caret has just finished typing', () => {
    expect(wordAt('total = parse', 13)).toBe('parse');
  });

  it('is nothing between two identifiers', () => {
    expect(wordAt('a + b', 2)).toBe('');
  });

  it('does not treat a number as a name', () => {
    expect(wordAt('x = 42', 6)).toBe('');
  });

  it('keeps a name that merely contains digits', () => {
    expect(wordAt('parse_2(x)', 7)).toBe('parse_2');
  });

  it('survives an offset past the end', () => {
    expect(wordAt('parse', 99)).toBe('parse');
    expect(wordAt('', 0)).toBe('');
  });
});

describe('declarationsOf', () => {
  const symbols = [
    symbol('save', 'store.py', 40),
    symbol('save', 'main.py', 10),
    symbol('save', 'main.py', 4),
    symbol('load', 'main.py', 1),
  ];

  it('puts the file you are in first', () => {
    const found = declarationsOf(symbols, 'save', 'main.py');
    expect(found.map((entry) => `${entry.file}:${entry.line}`)).toEqual([
      'main.py:4',
      'main.py:10',
      'store.py:40',
    ]);
  });

  it('orders by file and line when none of them is yours', () => {
    const found = declarationsOf(symbols, 'save', 'other.py');
    expect(found[0]?.file).toBe('main.py');
    expect(found[0]?.line).toBe(4);
  });

  it('finds nothing for a name nothing declares', () => {
    expect(declarationsOf(symbols, 'missing', 'main.py')).toEqual([]);
    expect(declarationsOf(symbols, '', 'main.py')).toEqual([]);
  });
});

describe('definitionFrom', () => {
  const symbols = [symbol('save', 'main.py', 4), symbol('save', 'store.py', 40)];

  it('goes to the declaration in this file', () => {
    expect(definitionFrom(symbols, 'save', 'main.py', 20)?.line).toBe(4);
  });

  it('skips the declaration the caret is already on', () => {
    // Otherwise pressing the key on a `def` line looks like nothing happened.
    const found = definitionFrom(symbols, 'save', 'main.py', 4);
    expect(found?.file).toBe('store.py');
  });

  it('is nothing when the only declaration is the one you are on', () => {
    expect(definitionFrom([symbol('only', 'main.py', 3)], 'only', 'main.py', 3)).toBeNull();
  });

  it('is nothing for an unknown name', () => {
    expect(definitionFrom(symbols, 'nope', 'main.py', 1)).toBeNull();
  });
});

describe('describeDeclarations', () => {
  it('says where it went', () => {
    expect(describeDeclarations('save', [symbol('save', 'main.py', 4)])).toBe('save — main.py:4');
  });

  it('says how many it had to choose between', () => {
    const many = [symbol('save', 'main.py', 4), symbol('save', 'store.py', 40)];
    expect(describeDeclarations('save', many)).toContain('2 declarations');
  });

  it('says plainly when there is nothing', () => {
    expect(describeDeclarations('save', [])).toContain('No declaration');
  });
});
