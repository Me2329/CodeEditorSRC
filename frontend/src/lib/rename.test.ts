/**
 * Renaming: the proposal, and the edit the proposal turns into.
 *
 * The thing under test is mostly restraint. Nothing is renamed that was not
 * ticked, prose is never ticked for you, and a plan that has gone stale writes
 * nothing rather than writing in the wrong place.
 */

import { describe, expect, it } from 'vitest';

import {
  SITE_LIMIT,
  applyRename,
  countByRegion,
  defaultSelection,
  describeRename,
  isValidName,
  keyOf,
  planRename,
  whyNot,
  whyNotRenamable,
} from './rename';
import type { VirtualFile } from './types';

function file(id: string, name: string, language: string, content: string): VirtualFile {
  return { id, name, language, content };
}

const MAIN = file(
  'a',
  'main.ts',
  'typescript',
  [
    'function save(value) {',
    '  // save it to disk',
    '  console.log("save started");',
    '  return save(value);',
    '}',
  ].join('\n'),
);

const OTHER = file('b', 'other.ts', 'typescript', 'import { save } from "./main";\nsave(1);');

describe('isValidName', () => {
  it('accepts an ordinary identifier', () => {
    expect(isValidName('saveAll')).toBe(true);
    expect(isValidName('_private')).toBe(true);
    expect(isValidName('x1')).toBe(true);
  });

  it('rejects what is not a name in every language this edits', () => {
    // The intersection, not the union: `$` is a letter in JavaScript and a
    // syntax error in C, and a name has to be legal wherever it lands.
    expect(isValidName('$dollar')).toBe(false);
    expect(isValidName('1abc')).toBe(false);
    expect(isValidName('two words')).toBe(false);
    expect(isValidName('has-dash')).toBe(false);
    expect(isValidName('')).toBe(false);
  });
});

describe('whyNot', () => {
  it('says nothing when the rename is fine', () => {
    expect(whyNot('save', 'store')).toBeNull();
  });

  it('asks for a caret on a name', () => {
    expect(whyNot('', 'store')).toContain('caret on a name');
  });

  it('asks for a new name', () => {
    expect(whyNot('save', '')).toContain('Type a new name');
  });

  it('declines a rename to the same name', () => {
    expect(whyNot('save', 'save')).toContain('already the name');
  });

  it('explains what a name may contain', () => {
    expect(whyNot('save', '2fast')).toContain('not starting with a digit');
  });
});

describe('planRename', () => {
  it('finds every occurrence and says what each is part of', () => {
    const plan = planRename([MAIN], 'save', 'store');
    expect(plan.sites.map((site) => site.region)).toEqual(['code', 'comment', 'string', 'code']);
  });

  it('locates each occurrence by line and column, with its line', () => {
    const plan = planRename([MAIN], 'save', 'store');
    const [first, , , last] = plan.sites;
    expect(first?.line).toBe(1);
    expect(first?.column).toBe(10);
    expect(first?.text).toBe('function save(value) {');
    expect(last?.line).toBe(4);
    expect(last?.text).toBe('  return save(value);');
  });

  it('groups by file and skips files with no occurrence', () => {
    const empty = file('c', 'empty.ts', 'typescript', 'const x = 1;');
    const plan = planRename([MAIN, empty, OTHER], 'save', 'store');
    expect(plan.files.map((group) => group.fileName)).toEqual(['main.ts', 'other.ts']);
  });

  it('is empty when the name occurs nowhere', () => {
    const plan = planRename([MAIN], 'missing', 'other');
    expect(plan.sites).toEqual([]);
    expect(plan.files).toEqual([]);
  });

  it('stops at the limit rather than listing what nobody can read', () => {
    const many = file('d', 'many.ts', 'typescript', Array(SITE_LIMIT + 50).fill('save').join('\n'));
    const plan = planRename([many], 'save', 'store');
    expect(plan.sites).toHaveLength(SITE_LIMIT);
  });

  it('uses each file own language to tell code from prose', () => {
    // `#` is a comment in Python and not in TypeScript.
    const python = file('e', 'a.py', 'python', 'save()\n# save later');
    const typescript = file('f', 'b.ts', 'typescript', 'save()\n# save later');
    expect(planRename([python], 'save', 'store').sites.map((s) => s.region)).toEqual([
      'code',
      'comment',
    ]);
    expect(planRename([typescript], 'save', 'store').sites.map((s) => s.region)).toEqual([
      'code',
      'code',
    ]);
  });
});

describe('defaultSelection', () => {
  it('ticks the code and leaves the prose', () => {
    const plan = planRename([MAIN], 'save', 'store');
    const selected = defaultSelection(plan);
    expect(selected.size).toBe(2);
    for (const site of plan.sites) {
      expect(selected.has(keyOf(site))).toBe(site.region === 'code');
    }
  });
});

describe('countByRegion', () => {
  it('counts each kind for the sentence above the list', () => {
    const plan = planRename([MAIN, OTHER], 'save', 'store');
    expect(countByRegion(plan.sites)).toEqual({ code: 4, comment: 1, string: 1 });
  });
});

describe('applyRename', () => {
  it('renames exactly what was ticked', () => {
    const plan = planRename([MAIN], 'save', 'store');
    const [edit] = applyRename([MAIN], plan, defaultSelection(plan));
    expect(edit?.content).toBe(
      [
        'function store(value) {',
        '  // save it to disk',
        '  console.log("save started");',
        '  return store(value);',
        '}',
      ].join('\n'),
    );
    expect(edit?.changed).toBe(2);
  });

  it('renames prose too when prose was ticked', () => {
    const plan = planRename([MAIN], 'save', 'store');
    const everything = new Set(plan.sites.map(keyOf));
    const [edit] = applyRename([MAIN], plan, everything);
    expect(edit?.content).toContain('// store it to disk');
    expect(edit?.content).toContain('"store started"');
  });

  it('survives a replacement of a different length', () => {
    // Applied back to front, or the second edit lands at a moved offset.
    const plan = planRename([MAIN], 'save', 'persistEverything');
    const [edit] = applyRename([MAIN], plan, new Set(plan.sites.map(keyOf)));
    expect(edit?.content.match(/persistEverything/g)).toHaveLength(4);
    expect(edit?.content).not.toContain('save');
  });

  it('touches every file with a ticked occurrence', () => {
    const plan = planRename([MAIN, OTHER], 'save', 'store');
    const edits = applyRename([MAIN, OTHER], plan, defaultSelection(plan));
    expect(edits.map((edit) => edit.fileName)).toEqual(['main.ts', 'other.ts']);
  });

  it('returns nothing for a file whose occurrences were all unticked', () => {
    const plan = planRename([MAIN, OTHER], 'save', 'store');
    const onlyMain = new Set(
      plan.sites.filter((site) => site.fileId === 'a' && site.region === 'code').map(keyOf),
    );
    const edits = applyRename([MAIN, OTHER], plan, onlyMain);
    expect(edits.map((edit) => edit.fileName)).toEqual(['main.ts']);
  });

  it('writes nothing at all when nothing is ticked', () => {
    const plan = planRename([MAIN], 'save', 'store');
    expect(applyRename([MAIN], plan, new Set())).toEqual([]);
  });

  it('refuses a site whose text moved under the plan', () => {
    // The file changed after the panel opened. Writing at the recorded offset
    // would replace whatever is there now, which is how a preview becomes a
    // lie. Each site is checked against the text it claims to be.
    const plan = planRename([MAIN], 'save', 'store');
    const moved = { ...MAIN, content: `// a line added above\n${MAIN.content}` };
    const edits = applyRename([moved], plan, new Set(plan.sites.map(keyOf)));
    for (const edit of edits) {
      expect(edit.content).toContain('function save(value)');
    }
  });

  it('ignores a file that has since been closed', () => {
    const plan = planRename([MAIN, OTHER], 'save', 'store');
    const edits = applyRename([MAIN], plan, defaultSelection(plan));
    expect(edits.map((edit) => edit.fileName)).toEqual(['main.ts']);
  });
});

describe('describeRename', () => {
  it('names the file when there was one', () => {
    const plan = planRename([MAIN], 'save', 'store');
    const edits = applyRename([MAIN], plan, defaultSelection(plan));
    expect(describeRename(plan, edits)).toBe(
      'Renamed save to store: 2 occurrences in main.ts.',
    );
  });

  it('counts the files when there were several', () => {
    const plan = planRename([MAIN, OTHER], 'save', 'store');
    const edits = applyRename([MAIN, OTHER], plan, defaultSelection(plan));
    expect(describeRename(plan, edits)).toContain('in 2 files');
  });

  it('says so when nothing was selected', () => {
    const plan = planRename([MAIN], 'save', 'store');
    expect(describeRename(plan, [])).toContain('unchanged');
  });

  it('writes one occurrence in the singular', () => {
    const plan = planRename([OTHER], 'save', 'store');
    const one = new Set([keyOf(plan.sites[0]!)]);
    expect(describeRename(plan, applyRename([OTHER], plan, one))).toContain('1 occurrence in');
  });
});

describe('whyNot, with a language', () => {
  it('refuses to rename a keyword', () => {
    // The caret lands on `def` as easily as on the name beside it, and `def`
    // matches the identifier pattern and occurs in every Python file.
    expect(whyNot('def', 'run', 'python')).toContain('is a keyword');
    expect(whyNot('fn', 'run', 'rust')).toContain('is a keyword');
  });

  it('refuses to rename something to a keyword', () => {
    expect(whyNot('save', 'class', 'typescript')).toContain('would not compile');
  });

  it('allows a word that is only a keyword somewhere else', () => {
    expect(whyNot('def', 'run', 'javascript')).toBeNull();
  });

  it('checks nothing when no language was given', () => {
    // The plain form is still available, and still says what it can.
    expect(whyNot('def', 'run')).toBeNull();
    expect(whyNot('save', '')).toContain('Type a new name');
  });
});

describe('whyNotRenamable', () => {
  it('answers without a replacement, which the caller does not have yet', () => {
    expect(whyNotRenamable('save', 'python')).toBeNull();
    expect(whyNotRenamable('def', 'python')).toContain('is a keyword');
    expect(whyNotRenamable('', 'python')).toContain('caret on a name');
  });

  it('is what whyNot checks first, so the two cannot disagree', () => {
    for (const [name, language] of [['def', 'python'], ['', 'python'], ['fn', 'rust']] as const) {
      expect(whyNot(name, 'anything', language)).toBe(whyNotRenamable(name, language));
    }
  });
});
