/** Closing the wrong tab, and getting it back. */

import { describe, expect, it } from 'vitest';

import { LIMIT, type ClosedFile, describe as describeStack, forget, remember, reopen, restore } from './closed';
import type { VirtualFile } from './types';

function file(id: string, name = `${id}.py`, content = id): VirtualFile {
  return { id, name, language: 'python', content };
}

describe('remember', () => {
  it('puts the newest closing on top', () => {
    let stack = remember([], file('a'), 0, 1);
    stack = remember(stack, file('b'), 1, 2);
    expect(stack.map((entry) => entry.file.id)).toEqual(['b', 'a']);
  });

  it('keeps the whole file, not a reference to it', () => {
    // There is no file on disk to open again.
    const stack = remember([], file('a', 'a.py', 'important'), 0);
    expect(stack[0]?.file.content).toBe('important');
  });

  it('remembers where it was in the strip', () => {
    expect(remember([], file('a'), 3)[0]?.index).toBe(3);
  });

  it('does not list the same file twice', () => {
    // Reopened and closed again: the newer closing describes it.
    let stack = remember([], file('a', 'a.py', 'old'), 0, 1);
    stack = remember(stack, file('a', 'a.py', 'new'), 2, 2);
    expect(stack).toHaveLength(1);
    expect(stack[0]?.file.content).toBe('new');
    expect(stack[0]?.index).toBe(2);
  });

  it('forgets the oldest past the limit', () => {
    let stack: ClosedFile[] = [];
    for (let index = 0; index < LIMIT + 5; index += 1) {
      stack = remember(stack, file(`f${index}`), 0, index);
    }
    expect(stack).toHaveLength(LIMIT);
    expect(stack.at(-1)?.file.id).toBe('f5');
  });
});

describe('reopen', () => {
  it('takes the most recent and leaves the rest', () => {
    const stack = remember(remember([], file('a'), 0, 1), file('b'), 1, 2);
    const result = reopen(stack);
    expect(result?.entry.file.id).toBe('b');
    expect(result?.rest.map((entry) => entry.file.id)).toEqual(['a']);
  });

  it('walks back through the closings in order', () => {
    let stack = remember([], file('a'), 0, 1);
    stack = remember(stack, file('b'), 1, 2);
    stack = remember(stack, file('c'), 2, 3);
    const order: string[] = [];
    for (let step = 0; step < 4; step += 1) {
      const result = reopen(stack);
      if (!result) break;
      order.push(result.entry.file.id);
      stack = result.rest;
    }
    expect(order).toEqual(['c', 'b', 'a']);
  });

  it('has nothing to reopen when nothing was closed', () => {
    expect(reopen([])).toBeNull();
  });
});

describe('restore', () => {
  it('puts the file back where it was', () => {
    const open = [file('a'), file('c')];
    const entry = { file: file('b'), index: 1, at: 1 };
    expect(restore(open, entry).map((one) => one.id)).toEqual(['a', 'b', 'c']);
  });

  it('puts it at the end when the strip has since shrunk', () => {
    const entry = { file: file('b'), index: 9, at: 1 };
    expect(restore([file('a')], entry).map((one) => one.id)).toEqual(['a', 'b']);
  });

  it('puts it first when it was first', () => {
    const entry = { file: file('b'), index: 0, at: 1 };
    expect(restore([file('a')], entry).map((one) => one.id)).toEqual(['b', 'a']);
  });

  it('does nothing when a file with that id is already open', () => {
    const open = [file('a')];
    const entry = { file: file('a'), index: 0, at: 1 };
    expect(restore(open, entry)).toEqual(open);
  });

  it('does not modify the list it was given', () => {
    const open = [file('a')];
    restore(open, { file: file('b'), index: 0, at: 1 });
    expect(open).toHaveLength(1);
  });
});

describe('forget and describe', () => {
  it('forgets one file', () => {
    const stack = remember(remember([], file('a'), 0, 1), file('b'), 1, 2);
    expect(forget(stack, 'b').map((entry) => entry.file.id)).toEqual(['a']);
  });

  it('names what would come back', () => {
    expect(describeStack([])).toBe('No closed files to reopen.');
    expect(describeStack(remember([], file('a', 'notes.md'), 0))).toBe('Reopen notes.md');
  });
});
