/** Every place a name appears in one file, for editing them at once. */

import { describe, expect, it } from 'vitest';

import { at, codeOnly, findAll, nextAfter, previousBefore, summarise } from './occurrences';

const TS = 'typescript';
const TEXT = [
  'function save(x) {',
  '  // save it',
  '  log("save");',
  '  return save(x);',
  '}',
].join('\n');

describe('findAll', () => {
  it('finds every whole-word occurrence and classifies each', () => {
    expect(findAll(TEXT, 'save', TS).map((one) => one.region)).toEqual([
      'code',
      'comment',
      'string',
      'code',
    ]);
  });

  it('reports offsets that index the text', () => {
    for (const one of findAll(TEXT, 'save', TS)) {
      expect(TEXT.slice(one.offset, one.offset + one.length)).toBe('save');
    }
  });

  it('ignores a name that is part of a longer one', () => {
    expect(findAll('save saved autosave save', 'save', TS)).toHaveLength(2);
  });

  it('uses the language own comment syntax', () => {
    expect(findAll('save\n# save', 'save', 'python').map((o) => o.region)).toEqual([
      'code',
      'comment',
    ]);
    expect(findAll('save\n# save', 'save', TS).map((o) => o.region)).toEqual(['code', 'code']);
  });

  it('has nothing to find for nothing', () => {
    expect(findAll(TEXT, '', TS)).toEqual([]);
  });
});

describe('codeOnly', () => {
  it('leaves out comments and strings', () => {
    // Typing into a string you forgot was selected is found much later.
    expect(codeOnly(findAll(TEXT, 'save', TS))).toHaveLength(2);
  });
});

describe('nextAfter and previousBefore', () => {
  const found = codeOnly(findAll(TEXT, 'save', TS));

  it('finds the one after an offset', () => {
    expect(nextAfter(found, 0)?.offset).toBe(found[0]?.offset);
    expect(nextAfter(found, found[0]!.offset)?.offset).toBe(found[1]?.offset);
  });

  it('wraps round rather than stopping', () => {
    expect(nextAfter(found, 9999)?.offset).toBe(found[0]?.offset);
    expect(previousBefore(found, 0)?.offset).toBe(found.at(-1)?.offset);
  });

  it('finds the one before an offset', () => {
    expect(previousBefore(found, found[1]!.offset)?.offset).toBe(found[0]?.offset);
  });

  it('has nowhere to go when there are none', () => {
    expect(nextAfter([], 0)).toBeNull();
    expect(previousBefore([], 0)).toBeNull();
  });
});

describe('at', () => {
  const found = findAll(TEXT, 'save', TS);

  it('finds the occurrence the offset is inside', () => {
    expect(at(found, found[0]!.offset + 1)?.offset).toBe(found[0]?.offset);
  });

  it('counts either edge as inside', () => {
    expect(at(found, found[0]!.offset)).not.toBeNull();
    expect(at(found, found[0]!.offset + 4)).not.toBeNull();
  });

  it('finds nothing between occurrences', () => {
    expect(at(found, 0)).toBeNull();
  });
});

describe('summarise', () => {
  it('says what would be selected, and what would not', () => {
    expect(summarise(findAll(TEXT, 'save', TS))).toBe(
      '2 occurrences, and 2 in comments or strings, left out',
    );
  });

  it('says nothing about prose when there is none', () => {
    expect(summarise(codeOnly(findAll(TEXT, 'save', TS)))).toBe('2 occurrences');
  });

  it('writes one in the singular', () => {
    expect(summarise(findAll('save', 'save', TS))).toBe('1 occurrence');
  });

  it('says so when there are none', () => {
    expect(summarise([])).toContain('No other occurrence');
  });
});
