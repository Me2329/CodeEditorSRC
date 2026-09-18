/**
 * "Go to" as one box that takes whatever you paste into it.
 *
 * A go-to-line prompt that only accepts a bare number is a prompt you end up
 * editing before you can use it. The things people actually have in hand are a
 * compiler's `main.py:42:8`, a stack frame's `at main.py line 42`, a diff's
 * `@@ -42`, and a rough idea like "about two thirds in". Each of those is one
 * small rule, and together they turn the box into somewhere you can paste.
 *
 * Parsing is deliberately permissive and reporting is not: anything understood
 * is described back in plain words, so a misread is visible before it moves the
 * caret rather than after.
 */

export interface Target {
  /** A file name or fragment of one, when the input named a file. */
  file?: string;
  /** 1-based. Absolute unless `relative` says otherwise. */
  line: number;
  column?: number;
  /** The line number is an offset from where the caret is now. */
  relative?: 'forward' | 'backward';
  /** The line number is a percentage through the file. */
  proportional?: boolean;
}

const PATTERNS: Array<{ test: RegExp; build: (match: RegExpExecArray) => Target }> = [
  // `+10` / `-5`: relative to the caret.
  {
    test: /^([+-])\s*(\d+)$/,
    build: (m) => ({
      line: Number(m[2]),
      relative: m[1] === '+' ? 'forward' : 'backward',
    }),
  },
  // `50%`: proportionally through the file.
  {
    test: /^(\d{1,3})\s*%$/,
    build: (m) => ({ line: Number(m[1]), proportional: true }),
  },
  // `:42:8` or `42:8`, no file. Tried before the file form, or `42:8` reads
  // as a file called `42` and `:42:8` as one called `:42`.
  {
    test: /^:?\s*(\d+)\s*:\s*(\d+)$/,
    build: (m) => ({ line: Number(m[1]), column: Number(m[2]) }),
  },
  // `file.py:42:8` or `file.py:42`, with an optional leading path. The file
  // part has to contain something that is not a digit, so a bare position is
  // never mistaken for a name.
  {
    test: /^([^:]*[^\s:\d][^:]*?)\s*:\s*(\d+)(?:\s*:\s*(\d+))?$/,
    build: (m) => ({
      file: m[1]!.trim(),
      line: Number(m[2]),
      ...(m[3] ? { column: Number(m[3]) } : {}),
    }),
  },
  // `line 42`, `at line 42`, `@@ -42`, `L42`, `#42`, or just `42`.
  {
    test: /(?:^|\b)(?:line|l|#|@@\s*[-+]?)?\s*(\d+)\s*$/i,
    build: (m) => ({ line: Number(m[1]) }),
  },
];

/** Read a target, or null when there is nothing to read. */
export function parseTarget(input: string): Target | null {
  const text = input.trim();
  if (!text) return null;

  for (const { test, build } of PATTERNS) {
    const match = test.exec(text);
    if (match) {
      const target = build(match);
      if (!Number.isFinite(target.line)) continue;
      return target;
    }
  }
  return null;
}

/**
 * Turn a target into a line number in a file of this many lines.
 *
 * Clamped rather than refused. Asking for line 900 of a 400-line file means
 * the end, and pasting a stale line number from an old traceback should still
 * take you to the file rather than to an error message.
 */
export function resolveLine(target: Target, totalLines: number, caretLine: number): number {
  const total = Math.max(1, totalLines);
  let line: number;

  if (target.relative === 'forward') line = caretLine + target.line;
  else if (target.relative === 'backward') line = caretLine - target.line;
  else if (target.proportional) line = Math.round((Math.min(target.line, 100) / 100) * total);
  else line = target.line;

  return Math.min(total, Math.max(1, line));
}

/**
 * The file a target names, matched loosely against what is open.
 *
 * An exact name wins, then one that ends with what was typed — so `src/main.py`
 * is found by `main.py` — then any that contains it. Loose matching is right
 * here because the text usually comes from a compiler that knows a longer path
 * than the workspace does.
 */
export function resolveFile<T extends { name: string }>(
  files: readonly T[],
  wanted: string | undefined,
): T | null {
  if (!wanted) return null;
  const needle = wanted.trim().toLowerCase();
  if (!needle) return null;

  const exact = files.find((file) => file.name.toLowerCase() === needle);
  if (exact) return exact;

  const suffix = files.find(
    (file) => file.name.toLowerCase().endsWith(`/${needle}`) || needle.endsWith(`/${file.name.toLowerCase()}`),
  );
  if (suffix) return suffix;

  const tail = needle.slice(needle.lastIndexOf('/') + 1);
  const byTail = files.find((file) => {
    const name = file.name.toLowerCase();
    return name === tail || name.endsWith(`/${tail}`);
  });
  if (byTail) return byTail;

  return files.find((file) => file.name.toLowerCase().includes(tail)) ?? null;
}

/** What the box should say it understood, before it acts on it. */
export function describeTarget(target: Target | null, resolved: number | null): string {
  if (!target) return 'A line number, `42:8`, `file.py:42`, `+10` or `50%`.';
  const place = resolved === null ? `line ${target.line}` : `line ${resolved}`;
  const column = target.column ? `, column ${target.column}` : '';
  if (target.file) return `${target.file} — ${place}${column}`;
  if (target.relative) {
    const way = target.relative === 'forward' ? 'down' : 'up';
    return `${target.line} lines ${way} — ${place}${column}`;
  }
  if (target.proportional) return `${target.line}% through — ${place}`;
  return `${place}${column}`;
}
