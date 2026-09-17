/**
 * Operations on lines and on the text inside a selection.
 *
 * Every function here is pure: text in, text out, no editor and no model. That
 * is not tidiness for its own sake. Line operations are where off-by-one lives
 * — the last line with no trailing newline, a selection that ends at column one
 * of the line below, a file that is entirely blank — and those cases are
 * unpleasant to reach through an editor and trivial to reach through a string.
 *
 * The convention throughout: a range is a pair of 1-based line numbers, both
 * inclusive, because that is how an editor talks about a selection and
 * converting at the boundary once beats converting at every call.
 */

/** Split into lines, remembering whether the text ended with a newline. */
export function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
  const trailingNewline = text.endsWith('\n');
  const body = trailingNewline ? text.slice(0, -1) : text;
  return { lines: body.split('\n'), trailingNewline };
}

/** Put them back the way they came, trailing newline and all. */
export function joinLines(lines: readonly string[], trailingNewline: boolean): string {
  return lines.join('\n') + (trailingNewline ? '\n' : '');
}

/**
 * Apply a transformation to one run of lines, leaving the rest alone.
 *
 * Out-of-range and inverted ranges are clamped rather than refused: a caller
 * handing over a selection that ends past the last line is describing "to the
 * end", not making a mistake.
 */
export function overLines(
  text: string,
  from: number,
  to: number,
  change: (lines: string[]) => string[],
): string {
  const { lines, trailingNewline } = splitLines(text);
  const start = Math.max(0, Math.min(from, to) - 1);
  const end = Math.min(lines.length, Math.max(from, to));
  if (start >= lines.length) return text;
  const changed = change(lines.slice(start, end));
  return joinLines([...lines.slice(0, start), ...changed, ...lines.slice(end)], trailingNewline);
}

// ------------------------------------------------------------------- ordering

/**
 * Sort lines.
 *
 * Compared with the locale's own rules, so `ä` sorts next to `a` rather than
 * after `z`, and with numeric ordering so `item10` comes after `item9`. Both
 * are what someone sorting a list in an editor means, and neither is what a
 * plain codepoint comparison does.
 */
export function sortLines(
  lines: readonly string[],
  options: { descending?: boolean; caseSensitive?: boolean } = {},
): string[] {
  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: options.caseSensitive ? 'variant' : 'base',
  });
  const sorted = [...lines].sort((left, right) => collator.compare(left, right));
  return options.descending ? sorted.reverse() : sorted;
}

export function reverseLines(lines: readonly string[]): string[] {
  return [...lines].reverse();
}

/** Remove later copies, keeping the first of each and the original order. */
export function uniqueLines(
  lines: readonly string[],
  options: { caseSensitive?: boolean; ignoreWhitespace?: boolean } = {},
): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const line of lines) {
    let key = options.ignoreWhitespace ? line.trim() : line;
    if (!options.caseSensitive) key = key.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(line);
  }
  return kept;
}

/** Keep only the lines that appear more than once, one copy each. */
export function duplicateLines(lines: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return uniqueLines(lines).filter((line) => (counts.get(line) ?? 0) > 1);
}

/** Drop blank lines, or collapse runs of them to one. */
export function removeBlankLines(
  lines: readonly string[],
  options: { collapse?: boolean } = {},
): string[] {
  const blank = (line: string) => line.trim() === '';
  if (!options.collapse) return lines.filter((line) => !blank(line));
  const kept: string[] = [];
  for (const line of lines) {
    if (blank(line) && kept.length > 0 && blank(kept[kept.length - 1]!)) continue;
    kept.push(line);
  }
  // A run at the very start collapses to nothing rather than to one blank line.
  while (kept.length > 0 && blank(kept[0]!)) kept.shift();
  return kept;
}

// -------------------------------------------------------------------- moving

/**
 * Move a run of lines up or down by one.
 *
 * At the top or the bottom nothing happens, rather than the run wrapping around
 * to the other end of the file. Wrapping is never what the key was pressed for.
 */
export function moveLines(
  text: string,
  from: number,
  to: number,
  direction: 'up' | 'down',
): { text: string; from: number; to: number } {
  const { lines, trailingNewline } = splitLines(text);
  const start = Math.max(0, Math.min(from, to) - 1);
  const end = Math.min(lines.length, Math.max(from, to));
  if (start >= end) return { text, from, to };
  if (direction === 'up' && start === 0) return { text, from, to };
  if (direction === 'down' && end >= lines.length) return { text, from, to };

  const run = lines.slice(start, end);
  const rest = [...lines.slice(0, start), ...lines.slice(end)];
  const landing = direction === 'up' ? start - 1 : start + 1;
  rest.splice(landing, 0, ...run);
  return {
    text: joinLines(rest, trailingNewline),
    from: landing + 1,
    to: landing + run.length,
  };
}

/** Copy a run of lines directly below itself. */
export function duplicateRange(text: string, from: number, to: number): string {
  return overLines(text, from, to, (lines) => [...lines, ...lines]);
}

/** Delete a run of lines outright. */
export function deleteLines(text: string, from: number, to: number): string {
  return overLines(text, from, to, () => []);
}

/**
 * Join a run of lines into one.
 *
 * Leading whitespace on the joined-on lines goes, and a single space separates
 * what is left, which is what every editor's join does and what reflowing a
 * wrapped comment needs. A line that is empty contributes nothing rather than a
 * doubled space.
 */
export function joinLineRun(lines: readonly string[]): string[] {
  if (lines.length <= 1) return [...lines];
  const [head, ...tail] = lines;
  const joined = tail.reduce<string>((carry, line) => {
    const next = line.trim();
    if (!next) return carry;
    return carry.trimEnd() ? `${carry.trimEnd()} ${next}` : next;
  }, head ?? '');
  return [joined];
}

export function joinRange(text: string, from: number, to: number): string {
  return overLines(text, from, to, joinLineRun);
}

// ------------------------------------------------------------------ whitespace

export function trimTrailingWhitespace(lines: readonly string[]): string[] {
  return lines.map((line) => line.replace(/[ \t]+$/, ''));
}

/**
 * Exactly one newline at the end of the file, and no blank lines before it.
 *
 * The convention most tools and most reviewers expect, and the one that stops a
 * diff ending in "\\ No newline at end of file".
 */
export function ensureFinalNewline(text: string): string {
  return `${text.replace(/\s*$/, '')}\n`;
}

/** Tabs to spaces, or spaces to tabs, in the indentation only. */
export function convertIndentation(
  lines: readonly string[],
  to: 'spaces' | 'tabs',
  tabSize: number,
): string[] {
  if (tabSize <= 0) throw new Error('a tab has to be at least one column wide');
  return lines.map((line) => {
    const match = /^[ \t]*/.exec(line)?.[0] ?? '';
    const body = line.slice(match.length);
    // Measured in columns rather than characters, so a tab in the middle of
    // the indentation advances to the next stop as it would on screen.
    let columns = 0;
    for (const character of match) {
      columns = character === '\t' ? columns + tabSize - (columns % tabSize) : columns + 1;
    }
    if (to === 'spaces') return ' '.repeat(columns) + body;
    return '\t'.repeat(Math.floor(columns / tabSize)) + ' '.repeat(columns % tabSize) + body;
  });
}

/** Add or remove one level of indentation. */
export function shiftIndentation(
  lines: readonly string[],
  direction: 'in' | 'out',
  indent: string,
): string[] {
  if (direction === 'in') {
    // A blank line gains nothing: indenting emptiness only leaves whitespace
    // for the next person to delete.
    return lines.map((line) => (line.trim() === '' ? line : indent + line));
  }
  return lines.map((line) => {
    if (line.startsWith(indent)) return line.slice(indent.length);
    // Falling back to whatever whitespace is actually there means outdenting
    // works on a file that does not match the configured indent.
    const match = /^[ \t]+/.exec(line)?.[0] ?? '';
    return match ? line.slice(Math.min(match.length, indent.length)) : line;
  });
}

// ------------------------------------------------------------------------ case

export type CaseStyle = 'upper' | 'lower' | 'title' | 'sentence' | 'toggle';

/** Split an identifier into its words, whatever convention wrote it. */
export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter(Boolean);
}

export function changeCase(text: string, style: CaseStyle): string {
  switch (style) {
    case 'upper':
      return text.toUpperCase();
    case 'lower':
      return text.toLowerCase();
    case 'title':
      return text.replace(/\p{L}[\p{L}\p{N}']*/gu, (word) =>
        word[0]!.toUpperCase() + word.slice(1).toLowerCase(),
      );
    case 'sentence': {
      const lowered = text.toLowerCase();
      // The first letter of each sentence, which is the first letter after a
      // full stop rather than after every full stop: `1.5` is not a sentence.
      return lowered.replace(/(^|[.!?]\s+)(\p{L})/gu, (_, prefix: string, letter: string) =>
        prefix + letter.toUpperCase(),
      );
    }
    case 'toggle':
      return [...text]
        .map((character) =>
          character === character.toLowerCase()
            ? character.toUpperCase()
            : character.toLowerCase(),
        )
        .join('');
  }
}

export type NameStyle = 'camel' | 'pascal' | 'snake' | 'kebab' | 'constant';

/** Rewrite an identifier in another convention. */
export function changeNameStyle(text: string, style: NameStyle): string {
  const parts = words(text).map((word) => word.toLowerCase());
  if (parts.length === 0) return text;
  switch (style) {
    case 'camel':
      return parts[0]! + parts.slice(1).map(capitalise).join('');
    case 'pascal':
      return parts.map(capitalise).join('');
    case 'snake':
      return parts.join('_');
    case 'kebab':
      return parts.join('-');
    case 'constant':
      return parts.join('_').toUpperCase();
  }
}

function capitalise(word: string): string {
  return word ? word[0]!.toUpperCase() + word.slice(1) : word;
}

// ------------------------------------------------------------------ statistics

export interface TextStatistics {
  lines: number;
  words: number;
  characters: number;
  /** Characters with every run of whitespace removed. */
  charactersWithoutSpaces: number;
  bytes: number;
}

/**
 * What a status bar shows about a selection.
 *
 * Bytes rather than characters as well, because they are different the moment
 * anything is not ASCII and the difference is the one that matters when a file
 * has to fit somewhere.
 */
export function statisticsOf(text: string): TextStatistics {
  const lines = text === '' ? 0 : text.split('\n').length;
  return {
    lines,
    words: (text.match(/\S+/g) ?? []).length,
    characters: [...text].length,
    charactersWithoutSpaces: [...text.replace(/\s/g, '')].length,
    bytes: new TextEncoder().encode(text).length,
  };
}
