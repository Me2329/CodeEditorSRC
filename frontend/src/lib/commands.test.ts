import { describe, expect, it } from 'vitest';

import { fuzzyMatch, rank } from './commands';
import { DEFAULT_PREFERENCES, normalisePreferences, themeById } from './preferences';

describe('fuzzyMatch', () => {
  it('matches a subsequence and reports where it landed', () => {
    const result = fuzzyMatch('mc', 'main.cpp');
    expect(result).not.toBeNull();
    expect(result?.positions).toEqual([0, 5]);
  });

  it('rejects a query that is not a subsequence', () => {
    expect(fuzzyMatch('xyz', 'main.cpp')).toBeNull();
  });

  it('is case insensitive', () => {
    expect(fuzzyMatch('MAIN', 'main.rs')).not.toBeNull();
  });

  it('scores consecutive characters above scattered ones', () => {
    const consecutive = fuzzyMatch('main', 'main.rs')!.score;
    const scattered = fuzzyMatch('main', 'm_a_i_n_utilities')!.score;
    expect(consecutive).toBeGreaterThan(scattered);
  });

  it('rewards a match at a word boundary', () => {
    const boundary = fuzzyMatch('u', 'src/utils.ts')!.score;
    const middle = fuzzyMatch('u', 'aaaaaaaaaaunrelated.ts')!.score;
    expect(boundary).toBeGreaterThan(middle);
  });

  it('treats an empty query as a match on everything', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, positions: [] });
  });
});

describe('rank', () => {
  const files = ['main.cpp', 'main.rs', 'config/settings.toml', 'src/matrix_helper.ts'];

  it('orders the closest match first', () => {
    const ordered = rank(files, 'maincpp', (file) => file).map((match) => match.item);
    expect(ordered[0]).toBe('main.cpp');
  });

  it('drops entries that do not match at all', () => {
    expect(rank(files, 'zzzz', (file) => file)).toHaveLength(0);
  });

  it('prefers a shorter target when both match', () => {
    const ordered = rank(['main.rs', 'main_helper_extended.rs'], 'main', (f) => f);
    expect(ordered[0]?.item).toBe('main.rs');
  });
});

describe('preferences', () => {
  it('falls back to defaults for a missing or malformed payload', () => {
    expect(normalisePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(normalisePreferences('not an object')).toEqual(DEFAULT_PREFERENCES);
  });

  it('clamps values that would make the editor unusable', () => {
    const preferences = normalisePreferences({ fontSize: 900, tabSize: 0, memoryMb: -5 });
    expect(preferences.fontSize).toBe(28);
    expect(preferences.tabSize).toBe(1);
    expect(preferences.memoryMb).toBe(16);
  });

  it('rejects an unknown theme rather than rendering nothing', () => {
    expect(normalisePreferences({ theme: 'nonsense' }).theme).toBe(DEFAULT_PREFERENCES.theme);
  });

  it('keeps valid values untouched', () => {
    const preferences = normalisePreferences({ fontSize: 16, wordWrap: true, theme: 'matrix' });
    expect(preferences.fontSize).toBe(16);
    expect(preferences.wordWrap).toBe(true);
    expect(preferences.theme).toBe('matrix');
  });

  it('every theme defines the full token set', () => {
    const expected = Object.keys(themeById('obsidian').tokens);
    for (const id of ['cyber-neon', 'matrix', 'paper', 'high-contrast'] as const) {
      expect(Object.keys(themeById(id).tokens).sort()).toEqual(expected.sort());
    }
  });
});
