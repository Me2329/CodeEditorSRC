/**
 * The notes people leave for themselves in comments.
 *
 * TODO, FIXME and the rest are a to-do list scattered through a codebase that
 * nothing ever collects. Search finds them if you remember to search; a list
 * shows them without being asked.
 *
 * The heuristic, stated plainly because it is a heuristic: a marker counts when
 * a comment opener appears somewhere before it on the line, or when nothing
 * does. That catches `// TODO: fix`, `# FIXME`, ` * TODO` in a block comment
 * and `// see issue 12; TODO refactor`, and leaves `print("TODO")` alone,
 * because a string is not a comment.
 *
 * Requiring the opener to come *immediately* before the marker would be safer
 * and would miss every note written mid-sentence, which is most of the
 * interesting ones.
 *
 * What it cannot do is know whether the comment opener is itself inside a
 * string. `url = "https://x/#TODO"` would be counted. Knowing better means
 * parsing thirteen languages, and the cost of the mistake is a spurious row in
 * a list rather than anything that matters.
 */

import type { VirtualFile } from './types';

/** Markers in the order they are worth looking at. */
export const KINDS = ['FIXME', 'BUG', 'HACK', 'TODO', 'XXX', 'NOTE'] as const;

export type TodoKind = (typeof KINDS)[number];

export interface Todo {
  fileId: string;
  fileName: string;
  kind: TodoKind;
  /** 1-based, as the editor shows it. */
  line: number;
  /** What the note says, with the marker and its punctuation removed. */
  text: string;
}

/**
 * The comment openers of every language this editor runs.
 *
 * A list rather than a per-language table: a marker preceded by any of these is
 * a note in every language that has them, and being wrong about which language
 * uses `--` costs nothing here.
 */
const COMMENT_OPENERS = ['//', '#', '--', '/*', '*', '<!--', ';', '%', '"""', "'''"];

const MARKER = new RegExp(`\\b(${KINDS.join('|')})\\b[:\\s-]*(.*)$`);

/** Whether what comes before a marker on its line is comment, not code. */
function looksLikeComment(before: string): boolean {
  if (!before.trim()) return true;
  return COMMENT_OPENERS.some((opener) => before.includes(opener));
}

/** Every marker in one file. */
export function scanFile(file: VirtualFile): Todo[] {
  const found: Todo[] = [];

  file.content.split('\n').forEach((line, index) => {
    const match = MARKER.exec(line);
    if (!match) return;
    if (!looksLikeComment(line.slice(0, match.index))) return;

    found.push({
      fileId: file.id,
      fileName: file.name,
      kind: match[1] as TodoKind,
      line: index + 1,
      // The note itself, with trailing comment punctuation trimmed off.
      text: (match[2] ?? '').replace(/\s*(\*\/|-->|"""|''')\s*$/, '').trim(),
    });
  });

  return found;
}

/**
 * Every marker in the workspace, most urgent first.
 *
 * Ordered by kind rather than by file, because the question a list like this
 * answers is "what is worst", not "what is where". Within a kind, by file and
 * line, so the order is stable as files are edited.
 */
export function scanWorkspace(files: readonly VirtualFile[]): Todo[] {
  const found = files.flatMap(scanFile);
  return found.sort((left, right) => {
    const byKind = KINDS.indexOf(left.kind) - KINDS.indexOf(right.kind);
    if (byKind !== 0) return byKind;
    const byFile = left.fileName.localeCompare(right.fileName);
    return byFile !== 0 ? byFile : left.line - right.line;
  });
}

/** How many of each kind, for a summary that does not need the list. */
export function countByKind(todos: readonly Todo[]): Record<TodoKind, number> {
  const counts = Object.fromEntries(KINDS.map((kind) => [kind, 0])) as Record<TodoKind, number>;
  for (const todo of todos) counts[todo.kind] += 1;
  return counts;
}

/**
 * Which markers are worth a badge.
 *
 * NOTE is a note, not a task. Counting it alongside the rest turns a number
 * that should mean "things to fix" into one that means "comments".
 */
export function outstanding(todos: readonly Todo[]): number {
  return todos.filter((todo) => todo.kind !== 'NOTE').length;
}
