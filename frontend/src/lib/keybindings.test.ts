import { describe, expect, test } from 'vitest';

import {
  DEFAULT_BINDINGS,
  type KeyEventLike,
  conflicts,
  describe as describeKeys,
  format,
  merge,
  parse,
  resolve,
} from './keybindings';

const press = (key: string, modifiers: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...modifiers,
});

describe('describing an event', () => {
  test('modifiers come in a fixed order', () => {
    expect(describeKeys(press('p', { ctrlKey: true, shiftKey: true, altKey: true }))).toBe(
      'mod+alt+shift+p',
    );
  });

  test('ctrl and cmd are the same binding', () => {
    // One binding covers a Windows keyboard and a Mac one.
    expect(describeKeys(press('p', { ctrlKey: true }))).toBe(
      describeKeys(press('p', { metaKey: true })),
    );
  });

  test('single letters are lower-cased', () => {
    expect(describeKeys(press('P', { ctrlKey: true }))).toBe('mod+p');
  });

  test('named keys keep their casing', () => {
    expect(describeKeys(press('Enter', { ctrlKey: true }))).toBe('mod+Enter');
    expect(describeKeys(press('F11'))).toBe('F11');
  });

  test('a bare key needs no modifier', () => {
    expect(describeKeys(press('Escape'))).toBe('Escape');
  });
});

describe('parsing a written shortcut', () => {
  test('the notation people actually type is accepted', () => {
    expect(parse('Ctrl+Shift+P')).toBe('mod+shift+p');
    expect(parse('cmd+p')).toBe('mod+p');
    expect(parse('Mod+,')).toBe('mod+,');
  });

  test('spacing is tolerated', () => {
    expect(parse(' Ctrl + P ')).toBe('mod+p');
  });

  test('parsing and describing agree', () => {
    // Otherwise a written binding could never match a real key press.
    expect(parse('Ctrl+Shift+O')).toBe(describeKeys(press('O', { ctrlKey: true, shiftKey: true })));
  });

  test('function keys survive a round trip', () => {
    expect(parse('f11')).toBe('F11');
    expect(parse('F11')).toBe(describeKeys(press('F11')));
  });

  test('modifiers alone are refused', () => {
    // It could never fire, so installing it would be a silent dead shortcut.
    expect(parse('Ctrl')).toBeNull();
    expect(parse('Ctrl+Shift')).toBeNull();
  });

  test('an empty string is refused', () => {
    expect(parse('')).toBeNull();
    expect(parse('  ')).toBeNull();
  });
});

describe('formatting for display', () => {
  test('the platform notation is used', () => {
    expect(format('mod+shift+p')).toBe('Ctrl+Shift+P');
    expect(format('mod+shift+p', true)).toBe('⌘⇧P');
  });

  test('named keys are shown as written', () => {
    expect(format('mod+Enter')).toBe('Ctrl+Enter');
  });
});

describe('resolving a press', () => {
  test('a bound key returns its command', () => {
    expect(resolve(press('p', { ctrlKey: true }), DEFAULT_BINDINGS)).toBe('view.files');
  });

  test('an unbound key returns nothing', () => {
    expect(resolve(press('q', { ctrlKey: true }), DEFAULT_BINDINGS)).toBeNull();
  });

  test('shift distinguishes two bindings on the same letter', () => {
    expect(resolve(press('p', { ctrlKey: true, shiftKey: true }), DEFAULT_BINDINGS)).toBe(
      'palette.commands',
    );
  });

  test('an editor-only binding does not fire elsewhere', () => {
    // A format shortcut should not fire while typing in a search box.
    expect(resolve(press('i', { ctrlKey: true, shiftKey: true }), DEFAULT_BINDINGS, 'always'))
      .toBeNull();
    expect(resolve(press('i', { ctrlKey: true, shiftKey: true }), DEFAULT_BINDINGS, 'editor'))
      .toBe('edit.format');
  });
});

describe('the defaults', () => {
  test('no two of them collide', () => {
    expect(conflicts(DEFAULT_BINDINGS)).toEqual([]);
  });

  test('every one of them parses back to itself', () => {
    for (const binding of DEFAULT_BINDINGS) {
      expect(parse(binding.keys)).toBe(binding.keys);
    }
  });
});

describe('detecting conflicts', () => {
  test('two commands on the same keys are reported', () => {
    const found = conflicts([
      { command: 'a', keys: 'mod+k' },
      { command: 'b', keys: 'mod+k' },
    ]);

    expect(found).toHaveLength(1);
    expect(found[0]!.commands).toEqual(['a', 'b']);
  });

  test('different keys do not conflict', () => {
    expect(conflicts([
      { command: 'a', keys: 'mod+k' },
      { command: 'b', keys: 'mod+j' },
    ])).toEqual([]);
  });
});

describe('user overrides', () => {
  test('an override replaces the default', () => {
    const merged = merge(DEFAULT_BINDINGS, { 'view.files': 'Ctrl+E' });
    expect(merged.find((binding) => binding.command === 'view.files')!.keys).toBe('mod+e');
  });

  test('commands without an override keep their default', () => {
    const merged = merge(DEFAULT_BINDINGS, { 'view.files': 'Ctrl+E' });
    expect(merged.find((binding) => binding.command === 'run.execute')!.keys).toBe('mod+Enter');
  });

  test('an unparseable override leaves the default alone', () => {
    // Silently losing a shortcut is worse than ignoring a typo.
    const merged = merge(DEFAULT_BINDINGS, { 'view.files': 'Ctrl+' });
    expect(merged.find((binding) => binding.command === 'view.files')!.keys).toBe('mod+p');
  });

  test('an override for an unknown command is added', () => {
    const merged = merge(DEFAULT_BINDINGS, { 'custom.thing': 'Ctrl+Alt+T' });
    expect(merged.find((binding) => binding.command === 'custom.thing')!.keys).toBe('mod+alt+t');
  });

  test('no overrides leaves the list unchanged', () => {
    expect(merge(DEFAULT_BINDINGS, {})).toEqual([...DEFAULT_BINDINGS]);
  });
});

describe('every default binding points at a real command', () => {
  test('no shipped shortcut is dead', async () => {
    // A binding whose command does not exist is a shortcut that silently does
    // nothing, which is invisible in review and annoying to find later. The
    // command list lives in the component, so this reads the source rather than
    // importing React just to enumerate ids.
    const { readFileSync } = await import('node:fs');
    const { resolve: resolvePath } = await import('node:path');
    // import.meta.url is an http URL under the test environment's transform,
    // so the path is resolved from the working directory instead.
    const source = readFileSync(
      resolvePath(process.cwd(), 'src/components/CodeCraftIDE.tsx'),
      'utf-8',
    );

    const registered = new Set(
      [...source.matchAll(/^\s*id: '([\w.]+)',$/gm)].map((match) => match[1]!),
    );

    const dead = DEFAULT_BINDINGS.filter((binding) => !registered.has(binding.command));
    expect(dead.map((binding) => binding.command)).toEqual([]);
  });
});
