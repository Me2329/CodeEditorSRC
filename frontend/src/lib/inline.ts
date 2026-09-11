/**
 * Inline completion: the grey text that appears ahead of the caret.
 *
 * The model work is elsewhere. What lives here is the judgement about when to
 * ask at all, and what to do with the answer, which is most of what makes an
 * inline suggestion tolerable rather than irritating.
 *
 * Three rules, and they are all about restraint:
 *
 *   1. Do not ask mid-word. A suggestion that appears while someone is still
 *      typing an identifier is always wrong and always in the way.
 *   2. Do not show what the user has already written. A model that helpfully
 *      repeats the line below the caret produces a duplicate on accept.
 *   3. Stop at the end of the block. A one-line hole should not be filled with
 *      twenty lines the user then has to delete.
 */

export interface InlineRequest {
  prefix: string;
  suffix: string;
}

/** How much context to send. Enough to be useful, small enough to be quick. */
export const PREFIX_BUDGET = 2000;
export const SUFFIX_BUDGET = 1000;

/**
 * Whether a completion is worth asking for at this caret.
 *
 * Returning false is the common case and costs nothing, which is the point: a
 * request per keystroke would be both slow and useless.
 */
export function shouldRequest(prefix: string, suffix: string): boolean {
  if (!prefix.trim() && !suffix.trim()) return false;

  const lastCharacter = prefix.slice(-1);
  // Mid-identifier. The user knows what they are typing; a suggestion here
  // competes with them rather than helping.
  if (/[A-Za-z0-9_$]/.test(lastCharacter)) return false;

  // Inside a line comment, where the model has nothing useful to add and the
  // user is deliberately writing prose.
  const currentLine = prefix.slice(prefix.lastIndexOf('\n') + 1);
  if (/^\s*(\/\/|#|--)/.test(currentLine)) return false;

  return true;
}

/** The slice of the document to send, bounded so the request stays quick. */
export function contextAround(text: string, offset: number): InlineRequest {
  return {
    prefix: text.slice(Math.max(0, offset - PREFIX_BUDGET), offset),
    suffix: text.slice(offset, offset + SUFFIX_BUDGET),
  };
}

/**
 * Trim a raw completion into something safe to insert.
 *
 * The model does not know it is being shown inline, so it will happily produce
 * a whole function when the caret is mid-expression. Everything here is about
 * cutting that down to what the user can accept without regret.
 */
export function tidy(completion: string, suffix: string, maxLines = 6): string {
  let text = completion;

  // A model asked to fill a hole sometimes reproduces the text after it.
  // Inserting that would duplicate the line below the caret.
  const suffixHead = suffix.trimStart().split('\n')[0]?.trim();
  if (suffixHead && suffixHead.length > 3) {
    const duplicated = text.indexOf(suffixHead);
    if (duplicated !== -1) text = text.slice(0, duplicated);
  }

  const lines = text.split('\n');
  if (lines.length > maxLines) text = lines.slice(0, maxLines).join('\n');

  // Trailing whitespace in a suggestion is invisible and unhelpful: it lands in
  // the file and then a linter complains about it.
  text = text.replace(/[ \t]+$/gm, '');

  // A suggestion that is only whitespace is not a suggestion.
  return text.trim() === '' ? '' : text.replace(/\n+$/, '');
}

/**
 * Whether a tidied completion is worth showing.
 *
 * A single closing bracket the editor would have auto-inserted anyway is worse
 * than nothing: it flickers, and accepting it produces a duplicate.
 */
export function worthShowing(completion: string, suffix: string): boolean {
  if (!completion) return false;
  if (completion.length < 2) return false;

  // Already there, immediately after the caret.
  if (suffix.startsWith(completion)) return false;
  if (/^[)\]}>;,]+$/.test(completion.trim())) return false;

  return true;
}

/**
 * Hold off until typing pauses.
 *
 * Returns a function that runs `action` once the caller has stopped calling it
 * for `delay`, and a way to cancel a pending run. Written here rather than
 * pulled in because the cancel half is what matters and most implementations
 * leave it out.
 */
export function debounce<T extends unknown[]>(
  action: (...args: T) => void,
  delay: number,
): { run: (...args: T) => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    run: (...args: T) => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        action(...args);
      }, delay);
    },
    cancel: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
