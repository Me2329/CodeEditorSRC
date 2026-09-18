import { describe, expect, it } from 'vitest';

import { ExtensionHost } from '../host';
import { keywordHelp, looksLikeCode } from './keywords';
import type { EditorHost } from '../types';

const noop: EditorHost = {
  replaceActiveFile: () => {},
  insertAtCursor: () => {},
  openFile: () => {},
  createFile: () => {},
  runCommand: () => {},
  notify: () => {},
  setStatus: () => {},
};

async function host() {
  const created = new ExtensionHost(noop);
  created.register(keywordHelp);
  // The extension declares onStartup, so this is what the editor itself does.
  await created.fire('onStartup');
  return created;
}

describe('looksLikeCode', () => {
  it('accepts a word in ordinary code', () => {
    expect(looksLikeCode('yield', '    yield value')).toBe(true);
  });

  it('refuses a word after a comment marker', () => {
    expect(looksLikeCode('yield', '# we yield here')).toBe(false);
    expect(looksLikeCode('yield', '// we yield here')).toBe(false);
  });

  it('refuses a word inside a string', () => {
    expect(looksLikeCode('yield', 'print("yield")')).toBe(false);
  });

  it('accepts a word after a closed string', () => {
    expect(looksLikeCode('yield', 'print("a"); yield x')).toBe(true);
  });

  it('accepts a word it cannot find on the line', () => {
    // The pointer was over it, so it is there; a line that has been edited
    // since is not a reason to say nothing.
    expect(looksLikeCode('yield', 'something else entirely')).toBe(true);
  });
});

describe('the keyword help extension', () => {
  it('explains a python keyword', async () => {
    const found = (await host()).hover('yield', '    yield value', 'python');
    expect(found).toHaveLength(1);
    expect(found[0]?.title).toBe('yield');
    expect(found[0]?.body).toContain('generator');
  });

  it('says nothing about a name that is not a keyword', async () => {
    expect((await host()).hover('parse', 'parse(text)', 'python')).toEqual([]);
  });

  it('answers for the language asked about, not another', async () => {
    // `const` is a JavaScript keyword and not a Python one.
    const created = await host();
    expect(created.hover('const', 'const x = 1', 'python')).toEqual([]);
    expect(created.hover('const', 'const x = 1', 'javascript')).toHaveLength(1);
  });

  it('gives typescript the same answers as javascript', async () => {
    const created = await host();
    expect(created.hover('await', 'await f()', 'typescript')).toEqual(
      created.hover('await', 'await f()', 'javascript'),
    );
  });

  it('says nothing about a keyword written in a comment', async () => {
    expect((await host()).hover('yield', '# about yield', 'python')).toEqual([]);
  });

  it('says nothing at all once the extension is turned off', async () => {
    const created = await host();
    created.setEnabled(keywordHelp.manifest.id, false);
    expect(created.hover('yield', 'yield value', 'python')).toEqual([]);
  });
});
