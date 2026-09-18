/**
 * Line diff, for reviewing a change before accepting it.
 *
 * The algorithm is the standard longest-common-subsequence one, computed over
 * lines rather than characters. Lines are the right granularity for reviewing
 * code: a character diff of a renamed variable produces a cloud of fragments,
 * while a line diff says "this line became that line", which is the question
 * being asked.
 *
 * The table is O(n*m) in memory, which is fine for source files and not fine
 * for a hundred-thousand-line log. Inputs past `MAX_LINES` fall back to a
 * whole-file replacement rather than allocating a gigabyte, because a diff
 * nobody can read is not worth an out-of-memory error.
 */

export type ChangeKind = 'added' | 'removed' | 'unchanged';

export interface DiffLine {
  kind: ChangeKind;
  text: string;
  /** 1-based line number in the original, or null for an added line. */
  beforeLine: number | null;
  /** 1-based line number in the result, or null for a removed line. */
  afterLine: number | null;
}

export interface DiffStats {
  added: number;
  removed: number;
  unchanged: number;
}

/** Beyond this, the table costs more memory than the diff is worth. */
export const MAX_LINES = 3000;

/**
 * The length of the longest common subsequence of every prefix pair.
 *
 * One row at a time would be enough to get the length, but the backtrack needs
 * the whole table, and the backtrack is the part that produces a diff rather
 * than a number.
 */
function lcsTable(before: readonly string[], after: readonly string[]): Uint32Array[] {
  const table: Uint32Array[] = Array.from(
    { length: before.length + 1 },
    () => new Uint32Array(after.length + 1),
  );

  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        before[i] === after[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  return table;
}

/**
 * Compare two texts line by line.
 *
 * A removed line is emitted before the added line that replaced it, which is
 * what makes a modification read as one change rather than two unrelated ones.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  if (before === after) {
    // The common case while typing: nothing changed, so do no work.
    return before.split('\n').map((text, index) => ({
      kind: 'unchanged' as const,
      text,
      beforeLine: index + 1,
      afterLine: index + 1,
    }));
  }

  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  if (beforeLines.length > MAX_LINES || afterLines.length > MAX_LINES) {
    return [
      ...beforeLines.map((text, index) => ({
        kind: 'removed' as const,
        text,
        beforeLine: index + 1,
        afterLine: null,
      })),
      ...afterLines.map((text, index) => ({
        kind: 'added' as const,
        text,
        beforeLine: null,
        afterLine: index + 1,
      })),
    ];
  }

  const table = lcsTable(beforeLines, afterLines);
  const result: DiffLine[] = [];

  let i = 0;
  let j = 0;
  while (i < beforeLines.length && j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      result.push({ kind: 'unchanged', text: beforeLines[i]!, beforeLine: i + 1, afterLine: j + 1 });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      result.push({ kind: 'removed', text: beforeLines[i]!, beforeLine: i + 1, afterLine: null });
      i += 1;
    } else {
      result.push({ kind: 'added', text: afterLines[j]!, beforeLine: null, afterLine: j + 1 });
      j += 1;
    }
  }

  // Whatever is left in one side when the other runs out.
  while (i < beforeLines.length) {
    result.push({ kind: 'removed', text: beforeLines[i]!, beforeLine: i + 1, afterLine: null });
    i += 1;
  }
  while (j < afterLines.length) {
    result.push({ kind: 'added', text: afterLines[j]!, beforeLine: null, afterLine: j + 1 });
    j += 1;
  }

  return result;
}

export function diffStats(lines: readonly DiffLine[]): DiffStats {
  return lines.reduce(
    (totals, line) => ({ ...totals, [line.kind]: totals[line.kind] + 1 }),
    { added: 0, removed: 0, unchanged: 0 },
  );
}

/**
 * Drop long runs of unchanged lines, keeping `context` either side of a change.
 *
 * A diff of a one-line change in a thousand-line file is unreadable without
 * this. The elided runs are replaced by a marker so it is clear that something
 * was skipped rather than that the file simply ends.
 */
export interface DiffHunk {
  lines: DiffLine[];
  /** Unchanged lines hidden before this hunk, or 0. */
  skipped: number;
}

export function collapse(lines: readonly DiffLine[], context = 3): DiffHunk[] {
  const interesting = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind === 'unchanged') return;
    for (let offset = -context; offset <= context; offset += 1) {
      const neighbour = index + offset;
      if (neighbour >= 0 && neighbour < lines.length) interesting.add(neighbour);
    }
  });

  if (interesting.size === 0) return [];

  const hunks: DiffHunk[] = [];
  let current: DiffLine[] = [];
  let skipped = 0;
  let run = 0;

  lines.forEach((line, index) => {
    if (interesting.has(index)) {
      if (current.length === 0) skipped = run;
      current.push(line);
      run = 0;
    } else {
      run += 1;
      if (current.length > 0) {
        hunks.push({ lines: current, skipped });
        current = [];
      }
    }
  });

  if (current.length > 0) hunks.push({ lines: current, skipped });
  return hunks;
}

/** Render as a unified diff, for copying into a commit message or a review. */
export function toUnified(lines: readonly DiffLine[], name = 'file'): string {
  const marker = { added: '+', removed: '-', unchanged: ' ' } as const;
  const body = lines.map((line) => `${marker[line.kind]}${line.text}`).join('\n');
  return `--- a/${name}\n+++ b/${name}\n${body}`;
}
