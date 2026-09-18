import { describe, expect, test } from 'vitest';

import { monacoThemeName } from '../../preferences';
import { THEMES, themePack } from './themes';

describe('the contributed themes', () => {
  test('each has a distinct id', () => {
    expect(new Set(THEMES.map((theme) => theme.id)).size).toBe(THEMES.length);
  });

  test('each id survives being turned into a name Monaco accepts', () => {
    // The ids are dotted and Monaco refuses a dotted theme name by throwing,
    // from inside an effect, which takes the editor down with it. That is a
    // real bug this list has had.
    const names = THEMES.map((theme) => monacoThemeName(theme.id));
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9-]+$/);
    expect(new Set(names).size).toBe(THEMES.length);
  });

  test('each id is namespaced to its extension', () => {
    // Monaco keys themes globally, so an id of "dark" from two extensions is
    // one theme with whichever colours were defined last.
    expect(THEMES.every((theme) => theme.id.startsWith('codecraft.'))).toBe(true);
  });

  test('each builds on a base Monaco knows', () => {
    for (const theme of THEMES) {
      expect(['vs', 'vs-dark', 'hc-black']).toContain(theme.base);
    }
  });

  test('each sets a background and a foreground', () => {
    // Without both, a theme inherits half its contrast from the base and can
    // come out unreadable on one of them.
    for (const theme of THEMES) {
      expect(theme.colors['editor.background']).toBeDefined();
      expect(theme.colors['editor.foreground']).toBeDefined();
    }
  });

  test('every colour is a hex value Monaco accepts', () => {
    for (const theme of THEMES) {
      for (const [key, value] of Object.entries(theme.colors)) {
        expect(value, `${theme.id} ${key}`).toMatch(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);
      }
    }
  });

  test('a light theme is light and a dark one is dark', () => {
    const brightness = (hex: string) =>
      parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);

    for (const theme of THEMES) {
      const background = brightness(theme.colors['editor.background']!);
      expect(theme.base === 'vs' ? background > 380 : background < 380).toBe(true);
    }
  });

  test('the pack contributes them and nothing else', () => {
    const contributes = themePack.contributes ?? {};

    expect(contributes.themes).toEqual(THEMES);
    expect(Object.keys(contributes)).toEqual(['themes']);
  });
});
