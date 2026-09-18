/**
 * The "go to" box, and the things people actually paste into it.
 *
 * Each accepted form is here because it comes from somewhere real: a compiler,
 * a stack frame, a diff hunk, or a rough idea of how far through a file
 * something is.
 */

import { describe, expect, it } from 'vitest';

import { describeTarget, parseTarget, resolveFile, resolveLine } from './goto';

describe('parseTarget', () => {
  it('reads a bare line number', () => {
    expect(parseTarget('42')).toEqual({ line: 42 });
  });

  it('reads line and column', () => {
    expect(parseTarget('42:8')).toEqual({ line: 42, column: 8 });
  });

  it('reads a compiler position', () => {
    expect(parseTarget('main.py:42:8')).toEqual({ file: 'main.py', line: 42, column: 8 });
  });

  it('reads a compiler position without a column', () => {
    expect(parseTarget('main.py:42')).toEqual({ file: 'main.py', line: 42 });
  });

  it('keeps a path in front of the file name', () => {
    expect(parseTarget('src/lib/main.py:42')).toEqual({ file: 'src/lib/main.py', line: 42 });
  });

  it('reads a stack frame', () => {
    expect(parseTarget('at line 42')).toEqual({ line: 42 });
    expect(parseTarget('line 42')).toEqual({ line: 42 });
    expect(parseTarget('L42')).toEqual({ line: 42 });
  });

  it('reads a diff hunk header', () => {
    expect(parseTarget('@@ -42')).toEqual({ line: 42 });
  });

  it('reads a relative jump', () => {
    expect(parseTarget('+10')).toEqual({ line: 10, relative: 'forward' });
    expect(parseTarget('-5')).toEqual({ line: 5, relative: 'backward' });
  });

  it('reads a proportion', () => {
    expect(parseTarget('50%')).toEqual({ line: 50, proportional: true });
  });

  it('tolerates the spaces people paste with', () => {
    expect(parseTarget('  main.py : 42 : 8  ')).toEqual({
      file: 'main.py',
      line: 42,
      column: 8,
    });
  });

  it('reads a leading colon as no file', () => {
    expect(parseTarget(':42:8')).toEqual({ line: 42, column: 8 });
  });

  it('has nothing to read in nothing', () => {
    expect(parseTarget('')).toBeNull();
    expect(parseTarget('   ')).toBeNull();
  });

  it('has nothing to read in text with no number', () => {
    expect(parseTarget('somewhere in the middle')).toBeNull();
  });
});

describe('resolveLine', () => {
  it('takes an absolute line as it is', () => {
    expect(resolveLine({ line: 42 }, 100, 1)).toBe(42);
  });

  it('clamps past the end rather than refusing', () => {
    // A stale line number from an old traceback should still reach the file.
    expect(resolveLine({ line: 900 }, 400, 1)).toBe(400);
  });

  it('clamps below the start', () => {
    expect(resolveLine({ line: 0 }, 400, 1)).toBe(1);
    expect(resolveLine({ line: 10, relative: 'backward' }, 400, 3)).toBe(1);
  });

  it('counts a relative jump from the caret', () => {
    expect(resolveLine({ line: 10, relative: 'forward' }, 100, 20)).toBe(30);
    expect(resolveLine({ line: 5, relative: 'backward' }, 100, 20)).toBe(15);
  });

  it('counts a proportion through the file', () => {
    expect(resolveLine({ line: 50, proportional: true }, 400, 1)).toBe(200);
    expect(resolveLine({ line: 100, proportional: true }, 400, 1)).toBe(400);
    expect(resolveLine({ line: 0, proportional: true }, 400, 1)).toBe(1);
  });

  it('does not let a proportion over 100 run past the end', () => {
    expect(resolveLine({ line: 250, proportional: true }, 400, 1)).toBe(400);
  });

  it('survives an empty file', () => {
    expect(resolveLine({ line: 5 }, 0, 1)).toBe(1);
  });
});

describe('resolveFile', () => {
  const files = [
    { name: 'main.py' },
    { name: 'src/util.py' },
    { name: 'tests/test_main.py' },
  ];

  it('matches an exact name', () => {
    expect(resolveFile(files, 'main.py')?.name).toBe('main.py');
  });

  it('matches by the tail of a longer path', () => {
    // The compiler knows a longer path than the workspace does.
    expect(resolveFile(files, '/home/me/project/src/util.py')?.name).toBe('src/util.py');
  });

  it('finds a file inside a folder by its bare name', () => {
    expect(resolveFile(files, 'util.py')?.name).toBe('src/util.py');
  });

  it('ignores case', () => {
    expect(resolveFile(files, 'MAIN.PY')?.name).toBe('main.py');
  });

  it('falls back to a containing match', () => {
    expect(resolveFile(files, 'test_main')?.name).toBe('tests/test_main.py');
  });

  it('prefers the exact name over a longer one that contains it', () => {
    expect(resolveFile(files, 'main.py')?.name).toBe('main.py');
  });

  it('finds nothing for a file that is not open', () => {
    expect(resolveFile(files, 'nowhere.rs')).toBeNull();
  });

  it('finds nothing for nothing', () => {
    expect(resolveFile(files, undefined)).toBeNull();
    expect(resolveFile(files, '  ')).toBeNull();
  });
});

describe('describeTarget', () => {
  it('says what it understood before acting on it', () => {
    expect(describeTarget({ line: 42 }, 42)).toBe('line 42');
    expect(describeTarget({ line: 42, column: 8 }, 42)).toBe('line 42, column 8');
    expect(describeTarget({ file: 'a.py', line: 42 }, 42)).toBe('a.py — line 42');
  });

  it('says where a relative jump landed', () => {
    expect(describeTarget({ line: 10, relative: 'forward' }, 30)).toBe(
      '10 lines down — line 30',
    );
    expect(describeTarget({ line: 5, relative: 'backward' }, 15)).toBe('5 lines up — line 15');
  });

  it('says where a proportion landed', () => {
    expect(describeTarget({ line: 50, proportional: true }, 200)).toBe(
      '50% through — line 200',
    );
  });

  it('offers the forms when there is nothing to describe', () => {
    expect(describeTarget(null, null)).toContain('file.py:42');
  });
});
