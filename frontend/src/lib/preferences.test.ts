import { describe, expect, it } from 'vitest';

import { monacoThemeName } from './preferences';

describe('monacoThemeName', () => {
  it('turns a dotted contribution id into something Monaco accepts', () => {
    // Monaco throws "Illegal theme name!" for anything else, from inside an
    // effect, which takes the whole editor down.
    expect(monacoThemeName('codecraft.midnight')).toBe('codecraft-midnight');
  });

  it('leaves a name that is already legal alone', () => {
    expect(monacoThemeName('vs-dark')).toBe('vs-dark');
    expect(monacoThemeName('hc-black')).toBe('hc-black');
  });

  it('collapses a run of illegal characters into one hyphen', () => {
    expect(monacoThemeName('a...b')).toBe('a-b');
    expect(monacoThemeName('my theme/2')).toBe('my-theme-2');
  });

  it('keeps distinct ids distinct', () => {
    expect(monacoThemeName('one.two')).not.toBe(monacoThemeName('one.three'));
  });

  it('matches what Monaco will accept', () => {
    for (const id of ['codecraft.midnight', 'a b', 'x_y', 'Ünicode.theme']) {
      expect(monacoThemeName(id)).toMatch(/^[A-Za-z0-9-]+$/);
    }
  });
});
