/**
 * Search and replace across every file in the workspace.
 *
 * Plain text by default, regular expressions when asked. The interesting part
 * is not the matching, it is everything around it: a search that throws on a
 * half-typed regular expression is unusable, because a half-typed regular
 * expression is what exists for most of the time the user is typing one.
 */

import type { VirtualFile } from './types';

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export const DEFAULT_OPTIONS: SearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};

export interface Match {
  fileId: string;
  fileName: string;
  /** 1-based, as displayed. */
  line: number;
  column: number;
  /** The whole line, for context in the results list. */
  text: string;
  /** Offsets within `text`, for highlighting. */
  start: number;
  end: number;
}

export interface FileMatches {
  fileId: string;
  fileName: string;
  matches: Match[];
}

/** A search stops here. A regular expression matching everything is a hazard. */
export const MATCH_LIMIT = 2000;

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a query, or return null when it cannot be compiled.
 *
 * Null rather than throwing: an invalid pattern is the normal state while
 * someone types one, and the interface wants to show "no results" rather than
 * an error boundary.
 */
export function compile(query: string, options: SearchOptions): RegExp | null {
  if (!query) return null;

  let source = options.regex ? query : escapeRegex(query);
  if (options.wholeWord) source = `\\b(?:${source})\\b`;

  const flags = options.caseSensitive ? 'gm' : 'gim';
  try {
    const pattern = new RegExp(source, flags);
    // A pattern that matches the empty string would loop forever below, and
    // there is no useful interpretation of it as a search.
    if (pattern.test('')) {
      pattern.lastIndex = 0;
      return null;
    }
    pattern.lastIndex = 0;
    return pattern;
  } catch {
    return null;
  }
}

/** Every match in one file, with the line and column an editor would show. */
function searchFile(file: VirtualFile, pattern: RegExp, limit = MATCH_LIMIT): Match[] {
  const matches: Match[] = [];
  const lines = file.content.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index]!;
    // Each line gets a fresh cursor: a sticky lastIndex across lines would
    // skip matches near the start of the next one.
    pattern.lastIndex = 0;

    let found: RegExpExecArray | null;
    while ((found = pattern.exec(text)) !== null) {
      matches.push({
        fileId: file.id,
        fileName: file.name,
        line: index + 1,
        column: found.index + 1,
        text,
        start: found.index,
        end: found.index + found[0].length,
      });

      if (matches.length >= limit) return matches;
      // A zero-length match cannot happen here because `compile` refuses those,
      // but advancing defensively costs nothing and prevents a hang if that
      // ever changes.
      if (found[0].length === 0) pattern.lastIndex += 1;
    }
  }

  return matches;
}

export function searchWorkspace(
  files: readonly VirtualFile[],
  query: string,
  options: SearchOptions = DEFAULT_OPTIONS,
  limit = MATCH_LIMIT,
): FileMatches[] {
  const pattern = compile(query, options);
  if (!pattern) return [];

  const results: FileMatches[] = [];
  let total = 0;

  for (const file of files) {
    const matches = searchFile(file, pattern, limit - total);
    if (matches.length === 0) continue;

    results.push({ fileId: file.id, fileName: file.name, matches });
    total += matches.length;
    if (total >= limit) break;
  }

  return results;
}

export function countMatches(results: readonly FileMatches[]): number {
  return results.reduce((total, file) => total + file.matches.length, 0);
}

/**
 * Apply a replacement to one file's content.
 *
 * `$1` and friends work in regular expression mode, because that is what makes
 * replace worth having. In plain mode the replacement is taken literally, so a
 * user replacing with `$1` gets `$1`.
 */
export function replaceInFile(
  content: string,
  query: string,
  replacement: string,
  options: SearchOptions = DEFAULT_OPTIONS,
): string {
  const pattern = compile(query, options);
  if (!pattern) return content;

  const literal = options.regex ? replacement : replacement.replace(/\$/g, '$$$$');
  return content.replace(pattern, literal);
}

/** Every file that would change, with its new content. */
export function replaceInWorkspace(
  files: readonly VirtualFile[],
  query: string,
  replacement: string,
  options: SearchOptions = DEFAULT_OPTIONS,
): { fileId: string; name: string; content: string }[] {
  const changed: { fileId: string; name: string; content: string }[] = [];

  for (const file of files) {
    const updated = replaceInFile(file.content, query, replacement, options);
    if (updated !== file.content) {
      changed.push({ fileId: file.id, name: file.name, content: updated });
    }
  }

  return changed;
}
