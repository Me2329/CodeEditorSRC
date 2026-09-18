import { describe, expect, it } from 'vitest';

import { declarationsOf, definitionFrom, describeDeclarations, isName } from './definitions';
import type { Symbol as WorkspaceSymbol } from './types';

function symbol(name: string, file: string, line: number): WorkspaceSymbol {
  return { name, kind: 'function', file, line, detail: `def ${name}()` };
}

describe('isName', () => {
  it('accepts an identifier', () => {
    expect(isName('parse')).toBe(true);
    expect(isName('_private')).toBe(true);
    expect(isName('parse_2')).toBe(true);
  });

  it('refuses a number', () => {
    expect(isName('42')).toBe(false);
    expect(isName('3.14')).toBe(false);
  });

  it('refuses nothing at all', () => {
    expect(isName('')).toBe(false);
  });

  it('refuses something that is not one word', () => {
    expect(isName('a b')).toBe(false);
    expect(isName('a.b')).toBe(false);
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
