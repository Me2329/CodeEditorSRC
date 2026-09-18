/**
 * The shape of the file you are in.
 *
 * The symbol index is workspace-wide and flat: every declaration in every file,
 * in the order they were read. An outline is the opposite of that. It is one
 * file, in line order, with methods under the class they belong to, and it
 * tracks where the caret is so the thing you are editing is the thing lit up.
 *
 * The nesting comes from the index, which records the declaration each one sits
 * inside. Turning that into depth is the only real work here: a container is a
 * name, and the same name can be declared twice in a file, so the parent is the
 * nearest earlier symbol with that name rather than any symbol with it.
 */

import type { Symbol as WorkspaceSymbol } from './types';

export interface OutlineEntry {
  name: string;
  kind: string;
  line: number;
  /** The last line that still belongs to it, from the index. Equal to `line`
   *  when the index did not say, which is what an older daemon reports. */
  endLine: number;
  detail: string;
  /** How far in to draw it. Zero for a top-level declaration. */
  depth: number;
}

/** Everything declared in one file, in line order and nested. */
export function outlineFor(symbols: WorkspaceSymbol[], fileName: string): OutlineEntry[] {
  if (!fileName) return [];

  const mine = symbols
    .filter((symbol) => symbol.file === fileName)
    .slice()
    .sort((left, right) => left.line - right.line);

  const entries: OutlineEntry[] = [];
  for (const symbol of mine) {
    const container = symbol.container ?? '';
    // The nearest earlier declaration of that name. Searching backwards
    // matters: two classes in a file can both have a `save`, and the one that
    // owns this method is the one above it.
    let depth = 0;
    for (let index = entries.length - 1; container && index >= 0; index -= 1) {
      const earlier = entries[index];
      if (earlier && earlier.name === container) {
        depth = earlier.depth + 1;
        break;
      }
    }
    entries.push({
      name: symbol.name,
      kind: symbol.kind,
      line: symbol.line,
      endLine: symbol.end_line ?? symbol.line,
      detail: symbol.detail,
      depth,
    });
  }
  return entries;
}

/**
 * Which entry the caret is inside, as an index, or -1.
 *
 * The last declaration that starts at or above the caret and has not ended
 * before it. The end matters: below the last function of a file the answer is
 * nothing, and saying "the last function" there is how a breadcrumb bar comes
 * to claim you are somewhere you are not.
 *
 * An index that reports no end lines says every declaration ends where it
 * starts, which would make every caret below a declaration line answer
 * nothing. So a declaration whose end is its own line is treated as running to
 * the next one, which is the old behaviour and the right fallback.
 */
export function enclosing(entries: OutlineEntry[], line: number): number {
  let found = -1;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.line > line) break;
    const ends = entry.endLine > entry.line ? entry.endLine : Infinity;
    if (ends >= line) found = index;
  }
  return found;
}

/**
 * The chain of declarations the caret is inside, outermost first.
 *
 * `Editor`, then `save`, for a caret in a method. This is what a breadcrumb
 * bar shows, and it is the one question the flat list cannot answer by itself:
 * an entry knows how deep it is but not which entries it is under.
 */
export function ancestry(entries: OutlineEntry[], line: number): OutlineEntry[] {
  let index = enclosing(entries, line);
  if (index < 0) return [];

  const chain: OutlineEntry[] = [];
  let depth = entries[index]?.depth ?? 0;
  for (; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.depth === depth) {
      chain.unshift(entry);
      depth -= 1;
    }
    if (depth < 0) break;
  }
  return chain;
}

/**
 * Entries matching what was typed, keeping the parents of what matched.
 *
 * A method shown without its class has lost the thing that made its name mean
 * something, so a filter that matches `save` keeps `Editor` above it even
 * though `Editor` does not match.
 */
export function filterOutline(entries: OutlineEntry[], query: string): OutlineEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;

  const keep = new Set<number>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || !entry.name.toLowerCase().includes(needle)) continue;
    keep.add(index);
    // Walk back up the chain of enclosing declarations, each one being the
    // nearest earlier entry that is one level shallower.
    let depth = entry.depth;
    for (let above = index - 1; above >= 0 && depth > 0; above -= 1) {
      if (entries[above]?.depth === depth - 1) {
        keep.add(above);
        depth -= 1;
      }
    }
  }
  return entries.filter((_, index) => keep.has(index));
}
