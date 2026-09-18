/**
 * Command registry and fuzzy matching.
 *
 * Every action the editor can perform is registered here, which means the
 * command palette, the keyboard shortcuts and the menus all read from one list
 * instead of drifting apart.
 */

export interface Command {
  id: string;
  title: string;
  /** Grouping shown in the palette. */
  category: string;
  /** Human-readable shortcut, e.g. "Ctrl+P". Display only. */
  shortcut?: string;
  /** Hidden from the palette when this returns false. */
  when?: () => boolean;
  run: () => void;
}

export interface Match<T> {
  item: T;
  score: number;
  /** Indices in the searched text that matched, for highlighting. */
  positions: number[];
}

/**
 * Score `query` against `text` using subsequence matching.
 *
 * Consecutive matches and matches at word boundaries score higher, which is
 * what makes "cpp" rank "main.cpp" above "clang_plus_plus_helper". Returns null
 * when the query is not a subsequence at all.
 */
export function fuzzyMatch(query: string, text: string): { score: number; positions: number[] } | null {
  if (!query) return { score: 0, positions: [] };

  const lowerQuery = query.toLowerCase();
  const lowerText = text.toLowerCase();

  const positions: number[] = [];
  let score = 0;
  let textIndex = 0;
  let previousMatch = -2;

  for (const character of lowerQuery) {
    const found = lowerText.indexOf(character, textIndex);
    if (found === -1) return null;

    // Adjacent characters are a much stronger signal than scattered ones.
    if (found === previousMatch + 1) {
      score += 10;
    } else {
      score += 1;
    }

    // A match right after a separator, or on a capital, is likely intentional.
    const previousCharacter = found > 0 ? text[found - 1] : undefined;
    if (
      found === 0 ||
      previousCharacter === '/' ||
      previousCharacter === '_' ||
      previousCharacter === '-' ||
      previousCharacter === '.' ||
      previousCharacter === ' '
    ) {
      score += 8;
    } else if (text[found] === text[found]?.toUpperCase() && text[found] !== text[found]?.toLowerCase()) {
      score += 4;
    }

    positions.push(found);
    previousMatch = found;
    textIndex = found + 1;
  }

  // Shorter targets are more likely to be what was meant.
  score -= Math.min(text.length, 80) / 10;
  // A match that starts at the beginning beats one buried in the middle.
  score -= Math.min(positions[0] ?? 0, 40) / 4;

  return { score, positions };
}

/** Rank items by how well `query` matches the text `keyOf` returns. */
export function rank<T>(items: readonly T[], query: string, keyOf: (item: T) => string): Match<T>[] {
  const matches: Match<T>[] = [];
  for (const item of items) {
    const result = fuzzyMatch(query, keyOf(item));
    if (result) {
      matches.push({ item, score: result.score, positions: result.positions });
    }
  }
  matches.sort((a, b) => b.score - a.score);
  return matches;
}

/** Format a shortcut for the current platform. */
export function formatShortcut(shortcut: string): string {
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
  return isMac
    ? shortcut.replace(/Ctrl/g, '⌘').replace(/Alt/g, '⌥').replace(/Shift/g, '⇧')
    : shortcut;
}
