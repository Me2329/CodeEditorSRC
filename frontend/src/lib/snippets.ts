/**
 * Using the snippets extensions contribute.
 *
 * The snippets themselves live in extensions: the builtin pack contributes
 * forty-nine across thirteen languages, and anything else loaded can add more.
 * This module is the part the editor needs in order to *use* them — matching
 * what has been typed, re-indenting a body to the file it is going into, and
 * checking that a body is well formed.
 *
 * Kept apart from the host because these are pure functions over text, which
 * is what lets them be tested exhaustively, and because several of them have
 * edge cases that matter more than they look.
 */

import type { SnippetContribution } from './extensions/types';

/**
 * Snippets whose prefix starts with what has been typed.
 *
 * Prefix matching rather than the fuzzy matching the command palette uses. A
 * completion list is read while typing continues, and a fuzzy match that pulls
 * `dataclass` up when you typed `ds` makes the list move under you.
 */
export function matching(
  snippets: readonly SnippetContribution[],
  typed: string,
): SnippetContribution[] {
  const needle = typed.toLowerCase();
  if (!needle) return [...snippets];
  return snippets.filter((snippet) => snippet.prefix.toLowerCase().startsWith(needle));
}

/** The word being typed at an offset, which is what a completion replaces. */
export function wordBefore(text: string, offset: number): string {
  let start = offset;
  while (start > 0 && /[A-Za-z0-9_$]/.test(text[start - 1] ?? '')) start -= 1;
  return text.slice(start, offset);
}

export interface Placeholder {
  /** Tab-stop number. Zero is the final caret position. */
  ordinal: number;
  /** Default text, or empty for a bare `$1`. */
  value: string;
}

const PLACEHOLDER = /\$\{(\d+):([^}]*)\}|\$(\d+)/g;

/** The tab stops in a body, in the order they appear. */
export function placeholders(body: string): Placeholder[] {
  const found: Placeholder[] = [];
  for (const match of body.matchAll(PLACEHOLDER)) {
    if (match[1] !== undefined) {
      found.push({ ordinal: Number(match[1]), value: match[2] ?? '' });
    } else if (match[3] !== undefined) {
      found.push({ ordinal: Number(match[3]), value: '' });
    }
  }
  return found;
}

/**
 * What is wrong with a snippet, or null.
 *
 * Run by a test over every contributed snippet rather than at runtime: a
 * malformed body inserts a literal `${1:` into someone's source, and the moment
 * to find that out is not while they are typing.
 */
export function validate(snippet: SnippetContribution): string | null {
  if (!snippet.prefix.trim()) return 'a snippet with no prefix cannot be typed';
  if (!snippet.language.trim()) return 'a snippet with no language is unreachable';

  // Every `${` in the body must be the start of a complete `${n:default}`. One
  // that is not means the rest of the body was meant to be a placeholder and
  // will be inserted literally instead.
  const opened = (snippet.body.match(/\$\{/g) ?? []).length;
  const complete = (snippet.body.match(/\$\{\d+:[^}]*\}/g) ?? []).length;
  if (opened !== complete) return 'a placeholder is not closed';

  const stops = placeholders(snippet.body);
  if (stops.filter((stop) => stop.ordinal === 0).length > 1) {
    return 'more than one final caret position';
  }

  const numbered = [...new Set(stops.filter((stop) => stop.ordinal > 0).map((s) => s.ordinal))];
  numbered.sort((left, right) => left - right);
  // Gaps are allowed to be surprising, so they are not: Tab would skip a number
  // and land somewhere the author did not intend.
  for (let index = 0; index < numbered.length; index += 1) {
    if (numbered[index] !== index + 1) return 'tab stops are not consecutive from 1';
  }

  return null;
}

/**
 * Re-indent a body to the file's own indentation.
 *
 * Bodies are written with whichever indentation their author used; what comes
 * out follows the user's settings. Continuation lines also take the caret's own
 * indentation, or a snippet inserted inside a function comes back flush against
 * the left margin.
 */
export function reindent(body: string, tabSize: number, leading = ''): string {
  const unit = tabSize > 0 ? ' '.repeat(tabSize) : '\t';
  return body
    .split('\n')
    .map((line, index) => {
      // Tabs and four-space runs both count as one level, because the pack uses
      // spaces and a snippet pasted in from elsewhere often uses tabs.
      const match = /^(?:\t| {4})*/.exec(line)?.[0] ?? '';
      const depth = match.includes('\t') ? match.length : match.length / 4;
      const rest = line.slice(match.length);
      // The first line starts where the caret already is.
      const prefix = index === 0 ? '' : leading;
      return prefix + unit.repeat(depth) + rest;
    })
    .join('\n');
}
