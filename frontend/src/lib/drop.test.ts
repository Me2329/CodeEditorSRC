import { describe, expect, test } from 'vitest';

import { MAX_BYTES, MAX_FILES, decide, explain, read, uniqueName } from './drop';

const file = (name: string, size = 10) => ({ name, size });

describe('what is taken', () => {
  test('ordinary source', () => {
    const { accepted, refused } = decide([file('main.py'), file('lib/util.ts')]);

    expect(accepted).toHaveLength(2);
    expect(refused).toEqual([]);
  });

  test('a file with no extension is text until proven otherwise', () => {
    // Makefile, LICENSE, Dockerfile: all things people drop on purpose.
    expect(decide([file('Makefile')]).accepted).toHaveLength(1);
  });
});

describe('what is refused', () => {
  test('something too large for the storage a workspace lives in', () => {
    // Not a file that fails to open later: a workspace that cannot be saved.
    const { refused } = decide([file('big.txt', MAX_BYTES + 1)]);

    expect(refused[0]!.because).toBe('too big');
  });

  test('something that is certainly not text', () => {
    expect(decide([file('photo.png')]).refused[0]!.because).toBe('not text');
  });

  test('a binary file is refused before its size is considered', () => {
    // So the message says what is actually wrong with it.
    expect(decide([file('clip.mp4', 10)]).refused[0]!.because).toBe('not text');
  });

  test('a whole folder dropped by accident', () => {
    const many = Array.from({ length: MAX_FILES + 5 }, (_, index) => file(`f${index}.py`));
    const { accepted, refused } = decide(many);

    expect(accepted).toHaveLength(MAX_FILES);
    expect(refused).toHaveLength(5);
    expect(refused[0]!.because).toBe('too many');
  });

  test('the extension check ignores case', () => {
    expect(decide([file('IMAGE.PNG')]).refused).toHaveLength(1);
  });

  test('reasons come back rather than being logged', () => {
    // A file that silently does not appear is worse than one with a reason.
    const { refused } = decide([file('a.png'), file('b.zip')]);

    expect(refused.map((entry) => entry.file.name)).toEqual(['a.png', 'b.zip']);
  });
});

describe('naming', () => {
  test('a free name is used as it is', () => {
    expect(uniqueName('util.py', ['main.py'])).toBe('util.py');
  });

  test('a taken name gets a suffix before the extension', () => {
    // After the extension the language would stop being recognised.
    expect(uniqueName('util.py', ['util.py'])).toBe('util-2.py');
  });

  test('the suffix counts up', () => {
    expect(uniqueName('util.py', ['util.py', 'util-2.py'])).toBe('util-3.py');
  });

  test('a name with no extension still works', () => {
    expect(uniqueName('Makefile', ['Makefile'])).toBe('Makefile-2');
  });

  test('a dotfile is not treated as all extension', () => {
    expect(uniqueName('.gitignore', ['.gitignore'])).toBe('.gitignore-2');
  });

  test('a drop never replaces existing work', () => {
    expect(uniqueName('a.py', ['a.py'])).not.toBe('a.py');
  });
});

describe('explaining', () => {
  test('nothing refused says nothing', () => {
    expect(explain([])).toBe('');
  });

  test('reasons are counted', () => {
    const message = explain([
      { because: 'not text' as const },
      { because: 'not text' as const },
      { because: 'too big' as const },
    ]);

    expect(message).toBe('Skipped 2 not text, 1 too big.');
  });
});


describe('reading', () => {
  const readable = (name: string, content: string) => ({
    name,
    size: content.length,
    text: async () => content,
  });

  const unreadable = (name: string) => ({
    name,
    size: 0,
    // A folder dropped on the window arrives looking like this and rejects.
    text: async () => {
      throw new DOMException('is a directory', 'NotFoundError');
    },
  });

  test('contents come back with their names', async () => {
    const result = await read([readable('a.py', 'x = 1')]);

    expect(result.read).toEqual([{ name: 'a.py', content: 'x = 1' }]);
    expect(result.unreadable).toEqual([]);
  });

  test('one that will not read does not lose the others', async () => {
    // Reading them all at once let a single rejection lose the whole drop,
    // silently, which is what a dropped folder used to do.
    const result = await read([readable('a.py', 'one'), unreadable('folder'), readable('b.py', 'two')]);

    expect(result.read.map((entry) => entry.name)).toEqual(['a.py', 'b.py']);
    expect(result.unreadable.map((entry) => entry.name)).toEqual(['folder']);
  });

  test('nothing readable comes back as nothing', async () => {
    const result = await read([unreadable('folder')]);

    expect(result.read).toEqual([]);
    expect(result.unreadable).toHaveLength(1);
  });

  test('an empty drop is an empty result', async () => {
    expect(await read([])).toEqual({ read: [], unreadable: [] });
  });

  test('unreadable files are explained like any other refusal', () => {
    expect(explain([{ because: 'unreadable' as const }])).toBe('Skipped 1 unreadable.');
  });
});
