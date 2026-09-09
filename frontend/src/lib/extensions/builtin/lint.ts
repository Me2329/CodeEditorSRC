/**
 * Client-side linters.
 *
 * These run on every keystroke against the file text, so they are limited to
 * what a regular expression and a line scan can see. That is a real limit and
 * it is the point: anything needing a parse belongs in the C++ analyzer, and
 * anything needing to execute belongs in the sandbox.
 *
 * What this tier is good at is the class of mistake that is obvious in the text
 * and expensive in review: a debugger left in, a merge conflict marker
 * committed, a tab in a Python file.
 */

import type { Extension, LinterContribution } from '../types';
import type { Diagnostic, VirtualFile } from '../../types';

/**
 * Build a diagnostic in the shape the analysis panel already renders.
 *
 * `rule` is a separate field rather than appended to the message, because the
 * panel and the Monaco marker both format it themselves and doing it here would
 * show it twice.
 */
function at(
  line: number,
  column: number,
  severity: Diagnostic['severity'],
  message: string,
  rule: string,
): Diagnostic {
  return { line, column, severity, message, rule };
}

/** Walk lines with their 1-based numbers, which is what editors display. */
function scan(file: VirtualFile, visit: (line: string, number: number) => Diagnostic[]): Diagnostic[] {
  return file.content.split('\n').flatMap((line, index) => visit(line, index + 1));
}

// ------------------------------------------------------------------ universal

/**
 * A conflict marker means an unfinished merge was saved. Always an error: the
 * file is not valid in any language.
 */
export const conflictMarkers: LinterContribution = {
  id: 'lint.conflict-markers',
  language: '*',
  lint: (file) =>
    scan(file, (line, number) =>
      /^(<{7}|={7}|>{7})( |$)/.test(line)
        ? [at(number, 1, 'error', 'Unresolved merge conflict marker', 'conflict-markers')]
        : [],
    ),
};

export const trailingWhitespace: LinterContribution = {
  id: 'lint.trailing-whitespace',
  language: '*',
  lint: (file) =>
    scan(file, (line, number) => {
      const match = /[ \t]+$/.exec(line);
      return match
        ? [at(number, match.index + 1, 'info', 'Trailing whitespace', 'trailing-whitespace')]
        : [];
    }),
};

export const todoComments: LinterContribution = {
  id: 'lint.todo',
  language: '*',
  lint: (file) =>
    scan(file, (line, number) => {
      const match = /\b(TODO|FIXME|XXX|HACK)\b/.exec(line);
      return match
        ? [at(number, match.index + 1, 'info', `${match[1]} comment`, 'todo')]
        : [];
    }),
};

export const longLines: LinterContribution = {
  id: 'lint.long-lines',
  language: '*',
  lint: (file) =>
    scan(file, (line, number) =>
      line.length > 120
        ? [at(number, 121, 'info', `Line is ${line.length} characters`, 'long-lines')]
        : [],
    ),
};

/**
 * Mixed tabs and spaces in the leading whitespace of one file.
 *
 * Reported once rather than per line: the finding is about the file, and a
 * hundred identical diagnostics would bury everything else.
 */
export const mixedIndentation: LinterContribution = {
  id: 'lint.mixed-indentation',
  language: '*',
  lint: (file) => {
    let tabs = 0;
    let spaces = 0;
    let firstMixed = 0;

    file.content.split('\n').forEach((line, index) => {
      const indent = /^[ \t]+/.exec(line)?.[0];
      if (!indent) return;
      if (indent.includes('\t')) tabs += 1;
      if (indent.includes(' ')) spaces += 1;
      if (!firstMixed && tabs && spaces) firstMixed = index + 1;
    });

    return tabs && spaces
      ? [at(firstMixed || 1, 1, 'warning', 'File mixes tabs and spaces for indentation', 'mixed-indentation')]
      : [];
  },
};

// ----------------------------------------------------------------- JavaScript

export const javascriptHygiene: LinterContribution = {
  id: 'lint.javascript',
  language: 'javascript',
  lint: (file) =>
    scan(file, (line, number) => {
      const found: Diagnostic[] = [];
      // Skip whole-line comments so a commented-out example is not flagged.
      if (/^\s*\/\//.test(line)) return found;

      const debuggerStatement = /\bdebugger\b/.exec(line);
      if (debuggerStatement) {
        found.push(at(number, debuggerStatement.index + 1, 'warning', 'debugger statement', 'no-debugger'));
      }
      const consoleCall = /\bconsole\.(log|debug)\b/.exec(line);
      if (consoleCall) {
        found.push(at(number, consoleCall.index + 1, 'info', 'console call left in', 'no-console'));
      }
      const looseEquality = /[^=!<>]==[^=]/.exec(line);
      if (looseEquality) {
        found.push(
          at(number, looseEquality.index + 2, 'warning', 'Use === rather than ==', 'eqeqeq'),
        );
      }
      const varDeclaration = /\bvar\s+[A-Za-z_$]/.exec(line);
      if (varDeclaration) {
        found.push(at(number, varDeclaration.index + 1, 'info', 'Prefer let or const to var', 'no-var'));
      }
      return found;
    }),
};

export const typescriptHygiene: LinterContribution = {
  id: 'lint.typescript',
  language: 'typescript',
  lint: (file) =>
    scan(file, (line, number) => {
      const found: Diagnostic[] = [];
      if (/^\s*\/\//.test(line)) return found;

      const anyType = /:\s*any\b/.exec(line);
      if (anyType) {
        found.push(at(number, anyType.index + 1, 'info', 'Explicit any defeats the checker', 'no-explicit-any'));
      }
      const ignore = /@ts-ignore/.exec(line);
      if (ignore) {
        found.push(
          at(number, ignore.index + 1, 'warning', 'Prefer @ts-expect-error, which fails when unused', 'no-ts-ignore'),
        );
      }
      return found;
    }),
};

// --------------------------------------------------------------------- Python

export const pythonHygiene: LinterContribution = {
  id: 'lint.python',
  language: 'python',
  lint: (file) =>
    scan(file, (line, number) => {
      const found: Diagnostic[] = [];

      // A tab in a Python file is an indentation error waiting to happen.
      if (/^\t/.test(line)) {
        found.push(at(number, 1, 'warning', 'Tab indentation in a Python file', 'tab-indent'));
      }
      const bareExcept = /^\s*except\s*:/.exec(line);
      if (bareExcept) {
        found.push(at(number, 1, 'warning', 'Bare except swallows KeyboardInterrupt', 'bare-except'));
      }
      const mutableDefault = /def\s+\w+\([^)]*=\s*(\[\]|\{\})/.exec(line);
      if (mutableDefault) {
        found.push(
          at(number, mutableDefault.index + 1, 'error', 'Mutable default argument is shared between calls', 'mutable-default'),
        );
      }
      const typeComparison = /\btype\([^)]+\)\s*==/.exec(line);
      if (typeComparison) {
        found.push(
          at(number, typeComparison.index + 1, 'info', 'Prefer isinstance to comparing type()', 'type-compare'),
        );
      }
      const printCall = /^\s*print\(/.exec(line);
      if (printCall) {
        found.push(at(number, 1, 'info', 'print left in', 'no-print'));
      }
      return found;
    }),
};

// ------------------------------------------------------------------ C and C++

export const cHygiene: LinterContribution = {
  id: 'lint.c',
  language: 'cpp',
  lint: (file) =>
    scan(file, (line, number) => {
      const found: Diagnostic[] = [];
      if (/^\s*\/\//.test(line)) return found;

      const unsafe = /\b(gets|strcpy|strcat|sprintf)\s*\(/.exec(line);
      if (unsafe) {
        found.push(
          at(number, unsafe.index + 1, 'warning', `${unsafe[1]} cannot bound its write`, 'unsafe-string'),
        );
      }
      const assignmentInCondition = /\b(if|while)\s*\([^=!<>]*[^=!<>]=[^=]/.exec(line);
      if (assignmentInCondition) {
        found.push(
          at(number, assignmentInCondition.index + 1, 'warning', 'Assignment inside a condition', 'assign-in-condition'),
        );
      }
      const mallocUnchecked = /=\s*malloc\s*\(/.exec(line);
      if (mallocUnchecked) {
        found.push(at(number, mallocUnchecked.index + 1, 'info', 'Check malloc for NULL', 'check-malloc'));
      }
      return found;
    }),
};

// ----------------------------------------------------------------- shell

export const shellHygiene: LinterContribution = {
  id: 'lint.shell',
  language: 'shell',
  lint: (file) =>
    scan(file, (line, number) => {
      const found: Diagnostic[] = [];
      if (/^\s*#/.test(line)) return found;

      // An unquoted expansion splits on whitespace, which is the single most
      // common shell bug.
      const unquoted = /(?<![">])\$\{?[A-Za-z_][A-Za-z0-9_]*\}?(?![">])/.exec(line);
      if (unquoted && !/^\s*(local|declare|export)?\s*\w+=/.test(line)) {
        found.push(
          at(number, unquoted.index + 1, 'info', 'Unquoted expansion splits on whitespace', 'quote-expansion'),
        );
      }
      const removeRecursive = /\brm\s+-[a-z]*r[a-z]*f?\s+\$/.exec(line);
      if (removeRecursive) {
        found.push(
          at(number, removeRecursive.index + 1, 'error', 'Recursive delete of an unquoted variable', 'dangerous-rm'),
        );
      }
      return found;
    }),
};

export const LINTERS: LinterContribution[] = [
  conflictMarkers,
  trailingWhitespace,
  todoComments,
  longLines,
  mixedIndentation,
  javascriptHygiene,
  typescriptHygiene,
  pythonHygiene,
  cHygiene,
  shellHygiene,
];

export const lintPack: Extension = {
  manifest: {
    id: 'codecraft.lint',
    name: 'Lint Pack',
    description:
      'Fast client-side checks: merge conflict markers, mixed indentation, mutable defaults, unsafe string functions, unquoted shell expansions and more.',
    version: '1.0.0',
    publisher: 'codecraft',
    icon: '🔎',
    categories: ['Linters'],
    activationEvents: ['onStartup'],
  },
  contributes: { linters: LINTERS },
};
