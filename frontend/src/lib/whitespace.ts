/**
 * What a file's whitespace actually is, rather than what the settings say.
 *
 * A browser editor has no `.editorconfig` to read and no git to ask, so its
 * indent setting is a guess that applies to every file at once. Open someone
 * else's tab-indented file with the setting on four spaces and the first line
 * you add is wrong — invisibly, because both look the same on screen, and the
 * diff is a mess for reasons nobody can see in the editor.
 *
 * So the file is measured instead. The same goes for line endings: a file
 * fetched from a Windows tool arrives with CRLF, and an editor that silently
 * writes LF turns every line of the next diff into a change.
 */

export type IndentKind = 'tabs' | 'spaces' | 'unknown';

export interface Indentation {
  kind: IndentKind;
  /** Columns per level. Meaningless for tabs, and reported as the tab width. */
  width: number;
  /** How many indented lines agreed with the answer, out of how many were read. */
  confidence: number;
  /** Lines indented with tabs and with spaces both. */
  mixed: boolean;
}

/**
 * Guess a file's indentation from the file.
 *
 * The signal is the *difference* between consecutive indentation levels, not
 * the absolute indentation: a file indented by two often has lines at four,
 * six and eight columns, and counting those directly makes two look rare. The
 * smallest common step is the answer.
 */
export function detectIndentation(text: string, fallback = 4): Indentation {
  const lines = text.split('\n');
  let tabs = 0;
  let spaces = 0;
  const steps = new Map<number, number>();
  let previous = 0;
  let read = 0;

  for (const line of lines) {
    if (line.trim() === '') continue;
    const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
    if (indent.includes('\t')) tabs += 1;
    if (indent.includes(' ') && !indent.includes('\t')) spaces += 1;

    const columns = indent.includes('\t') ? previous : indent.length;
    if (!indent.includes('\t')) {
      const step = columns - previous;
      if (step > 0 && step <= 8) {
        steps.set(step, (steps.get(step) ?? 0) + 1);
        read += 1;
      }
      previous = columns;
    }
  }

  const mixed = tabs > 0 && spaces > 0;
  if (tabs > spaces) {
    return { kind: 'tabs', width: fallback, confidence: tabs / Math.max(1, tabs + spaces), mixed };
  }
  if (steps.size === 0) {
    return { kind: spaces > 0 ? 'spaces' : 'unknown', width: fallback, confidence: 0, mixed };
  }

  let best = fallback;
  let bestCount = 0;
  for (const [step, count] of [...steps].sort((a, b) => a[0] - b[0])) {
    // A strictly larger count wins, so a tie goes to the smaller step: a file
    // indented by two has plenty of four-column jumps, and two is the answer.
    if (count > bestCount) {
      best = step;
      bestCount = count;
    }
  }
  return { kind: 'spaces', width: best, confidence: bestCount / Math.max(1, read), mixed };
}

export function describeIndentation(indent: Indentation): string {
  const base =
    indent.kind === 'tabs'
      ? 'Tabs'
      : indent.kind === 'spaces'
        ? `${indent.width} spaces`
        : 'No indentation';
  return indent.mixed ? `${base}, mixed with the other` : base;
}

// ---------------------------------------------------------------- line endings

export type LineEnding = 'LF' | 'CRLF' | 'CR' | 'none';

export interface Endings {
  /** What the file mostly uses. */
  dominant: LineEnding;
  lf: number;
  crlf: number;
  cr: number;
  /** More than one kind in the same file, which no tool produces on purpose. */
  mixed: boolean;
}

export function detectLineEndings(text: string): Endings {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  // A lone CR is one not followed by LF; a lone LF is one not preceded by CR.
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;

  const counts: Array<[LineEnding, number]> = [
    ['LF', lf],
    ['CRLF', crlf],
    ['CR', cr],
  ];
  const present = counts.filter(([, count]) => count > 0);
  const dominant = present.length === 0
    ? 'none'
    : present.reduce((best, one) => (one[1] > best[1] ? one : best))[0];

  return { dominant, lf, crlf, cr, mixed: present.length > 1 };
}

/** Rewrite every line ending as one kind. */
export function normaliseLineEndings(text: string, to: Exclude<LineEnding, 'none'>): string {
  const body = text.replace(/\r\n|\r|\n/g, '\n');
  if (to === 'LF') return body;
  return body.replace(/\n/g, to === 'CRLF' ? '\r\n' : '\r');
}

export function describeEndings(endings: Endings): string {
  if (endings.dominant === 'none') return 'No line endings';
  if (!endings.mixed) return endings.dominant;
  const parts = [
    endings.lf > 0 ? `${endings.lf} LF` : '',
    endings.crlf > 0 ? `${endings.crlf} CRLF` : '',
    endings.cr > 0 ? `${endings.cr} CR` : '',
  ].filter(Boolean);
  return `Mixed: ${parts.join(', ')}`;
}

// ------------------------------------------------------------------- oddities

export interface WhitespaceProblem {
  /** 1-based, as displayed. */
  line: number;
  kind: 'trailing' | 'tab-in-line' | 'mixed-indent' | 'non-breaking-space';
  detail: string;
}

/**
 * Whitespace that will cost someone an afternoon.
 *
 * A non-breaking space among the indentation is the one worth having here: it
 * is invisible, it is what a paste from a web page or a document leaves behind,
 * and the error it causes names a line that looks perfectly fine.
 */
export function whitespaceProblems(text: string): WhitespaceProblem[] {
  const problems: WhitespaceProblem[] = [];
  const lines = text.split('\n');

  lines.forEach((line, index) => {
    const at = index + 1;
    if (/[ \t]+$/.test(line)) {
      problems.push({ line: at, kind: 'trailing', detail: 'trailing whitespace' });
    }
    const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
    if (indent.includes('\t') && indent.includes(' ')) {
      problems.push({ line: at, kind: 'mixed-indent', detail: 'tabs and spaces in the indent' });
    }
    if (/[  -​　]/.test(line)) {
      problems.push({
        line: at,
        kind: 'non-breaking-space',
        detail: 'an invisible space that is not a space',
      });
    }
  });

  return problems;
}
