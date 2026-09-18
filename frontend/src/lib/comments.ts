/**
 * Commenting a selection out, and uncommenting it again.
 *
 * The delimiters come from the same table the rename panel uses to tell code
 * from prose, so a language added there is commented correctly here without a
 * second list to keep in step.
 *
 * Three decisions make the difference between a toggle that feels right and one
 * that has to be undone:
 *
 * The marker goes at the selection's own indentation, not at column one. Code
 * commented at column one loses the shape of the block it came from, and
 * putting it back means re-indenting by hand.
 *
 * A mixed selection comments rather than uncomments. If some lines are already
 * commented and some are not, pressing the key once should leave every line
 * commented — that is the state the user is heading for. Uncommenting the
 * commented ones and commenting the rest just swaps the problem around.
 *
 * Blank lines are skipped when commenting and ignored when deciding. A file
 * full of `//` on empty lines is noise, and an empty line among commented ones
 * should not make the block count as mixed.
 */

import { rulesFor } from './syntax';

/** What a toggle would do, before it does it. */
export type CommentAction = 'comment' | 'uncomment' | 'nothing';

export interface LineCommentPlan {
  action: CommentAction;
  marker: string;
  lines: string[];
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

/** The indentation shared by every line that has any content. */
export function commonIndent(lines: readonly string[]): string {
  let shortest: string | null = null;
  for (const line of lines) {
    if (isBlank(line)) continue;
    const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
    if (shortest === null || indent.length < shortest.length) shortest = indent;
  }
  return shortest ?? '';
}

/**
 * Toggle a line comment across a run of lines.
 *
 * Returns the new lines and which way it went, so a caller can say so.
 */
export function toggleLineComment(
  lines: readonly string[],
  language: string,
): LineCommentPlan {
  const rules = rulesFor(language);
  const marker = rules.lineComment[0];
  if (!marker) return { action: 'nothing', marker: '', lines: [...lines] };

  const content = lines.filter((line) => !isBlank(line));
  if (content.length === 0) return { action: 'nothing', marker, lines: [...lines] };

  const commented = content.every((line) => line.trimStart().startsWith(marker));
  const indent = commonIndent(lines);

  if (commented) {
    return {
      action: 'uncomment',
      marker,
      lines: lines.map((line) => {
        if (isBlank(line)) return line;
        const at = line.indexOf(marker);
        const after = at + marker.length;
        // One space after the marker is what this put there, so take it back.
        const skip = line[after] === ' ' ? after + 1 : after;
        return line.slice(0, at) + line.slice(skip);
      }),
    };
  }

  return {
    action: 'comment',
    marker,
    lines: lines.map((line) =>
      isBlank(line) ? line : indent + marker + ' ' + line.slice(indent.length),
    ),
  };
}

export interface BlockCommentPlan {
  action: CommentAction;
  text: string;
}

/**
 * Wrap a selection in a block comment, or unwrap one.
 *
 * Only exactly wrapped text unwraps. A selection that merely contains a comment
 * somewhere is left alone, because removing the delimiters would join code that
 * was never adjacent, and there is no way to tell from here whether that is
 * what was wanted.
 */
export function toggleBlockComment(text: string, language: string): BlockCommentPlan {
  const rules = rulesFor(language);
  const pair = rules.blockComment[0];
  if (!pair) return { action: 'nothing', text };

  const [open, close] = pair;
  const trimmed = text.trim();
  if (trimmed.startsWith(open) && trimmed.endsWith(close) && trimmed.length >= open.length + close.length) {
    const inner = trimmed.slice(open.length, trimmed.length - close.length);
    return { action: 'uncomment', text: inner.replace(/^\s/, '').replace(/\s$/, '') };
  }
  return { action: 'comment', text: `${open} ${text} ${close}` };
}

/** Whether this language has a block comment at all, for enabling a command. */
export function hasBlockComment(language: string): boolean {
  return rulesFor(language).blockComment.length > 0;
}

/** Whether this language has a line comment at all. */
export function hasLineComment(language: string): boolean {
  return rulesFor(language).lineComment.length > 0;
}

/** What to say once a toggle has run. */
export function describeToggle(action: CommentAction, count: number): string {
  if (action === 'nothing') return 'This language has no comment to toggle.';
  const lines = count === 1 ? '1 line' : `${count} lines`;
  return action === 'comment' ? `Commented ${lines}` : `Uncommented ${lines}`;
}
