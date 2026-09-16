/**
 * Which parts of a file are code, and which are prose.
 *
 * The workspace index matches names and nothing more, which is fine for going
 * to a declaration and not fine for changing one. A rename that replaced every
 * occurrence of `save` would rewrite the word inside comments, inside strings,
 * inside the license header — and the ones it should have changed would be
 * mixed in with the ones it should not, indistinguishable in a list.
 *
 * So before offering a rename, the occurrences are sorted into code, comment
 * and string. That needs no parser and no language server: it needs to know
 * where each language's comments and strings begin and end, which is a small
 * table, and a single pass that tracks which of them it is inside.
 *
 * One rule decides every judgement call here. **When in doubt, say code.**
 * Calling a comment code offers a rename the reader can see and decline.
 * Calling code a comment hides a real occurrence, and the rename silently
 * leaves a use of the old name behind. The first is noise; the second is a
 * broken workspace. Everything below leans the first way, and the places where
 * that costs accuracy are named rather than hidden.
 */

/** What a stretch of a file is. */
export type Region = 'code' | 'comment' | 'string';

export interface StringRule {
  open: string;
  close: string;
  /** The character that quotes the next one, where the language has one. */
  escape?: string;
  /** Whether the literal may cross a newline. Most may not. */
  multiline?: boolean;
}

export interface SyntaxRules {
  /** Runs to the end of the line. */
  lineComment: string[];
  /** Open and close, in that order. */
  blockComment: Array<[string, string]>;
  /** Block comments that count their own openings, as Rust's do. */
  nestedBlockComment?: boolean;
  strings: StringRule[];
}

const C_STRINGS: StringRule[] = [
  { open: '"', close: '"', escape: '\\' },
  { open: "'", close: "'", escape: '\\' },
];

const C_FAMILY: SyntaxRules = {
  lineComment: ['//'],
  blockComment: [['/*', '*/']],
  strings: C_STRINGS,
};

const HASH_FAMILY: SyntaxRules = {
  lineComment: ['#'],
  blockComment: [],
  strings: C_STRINGS,
};

const PYTHON: SyntaxRules = {
  lineComment: ['#'],
  blockComment: [],
  // Longest first: `"""` must be tried before `"`, or a docstring is read as
  // an empty string followed by code.
  strings: [
    { open: '"""', close: '"""', escape: '\\', multiline: true },
    { open: "'''", close: "'''", escape: '\\', multiline: true },
    ...C_STRINGS,
  ],
};

const JS_FAMILY: SyntaxRules = {
  lineComment: ['//'],
  blockComment: [['/*', '*/']],
  // A template literal is a string as far as this is concerned. The `${}`
  // holes inside one really are code, and are not detected: an occurrence in a
  // hole is reported as a string and the reader decides. Leaning the other way
  // would mean guessing at brace matching inside a literal.
  strings: [{ open: '`', close: '`', escape: '\\', multiline: true }, ...C_STRINGS],
};

/**
 * By Monaco's language id, which is what the rest of the editor speaks.
 *
 * Anything absent falls back to the C family, because `//` and slash-star and
 * quotes cover more of these languages than any other single guess, and a
 * wrong guess here costs a mislabelled occurrence rather than a wrong edit.
 */
export const RULES: Record<string, SyntaxRules> = {
  c: C_FAMILY,
  cpp: C_FAMILY,
  csharp: C_FAMILY,
  java: C_FAMILY,
  kotlin: C_FAMILY,
  scala: C_FAMILY,
  swift: C_FAMILY,
  dart: C_FAMILY,
  go: C_FAMILY,
  groovy: C_FAMILY,
  d: C_FAMILY,
  zig: { lineComment: ['//'], blockComment: [], strings: C_STRINGS },
  rust: { ...C_FAMILY, nestedBlockComment: true },
  javascript: JS_FAMILY,
  typescript: JS_FAMILY,
  php: { lineComment: ['//', '#'], blockComment: [['/*', '*/']], strings: C_STRINGS },
  python: PYTHON,
  ruby: { lineComment: ['#'], blockComment: [['=begin', '=end']], strings: C_STRINGS },
  perl: { lineComment: ['#'], blockComment: [], strings: C_STRINGS },
  shell: HASH_FAMILY,
  powershell: { lineComment: ['#'], blockComment: [['<#', '#>']], strings: C_STRINGS },
  yaml: HASH_FAMILY,
  ini: HASH_FAMILY,
  r: HASH_FAMILY,
  julia: { lineComment: ['#'], blockComment: [['#=', '=#']], strings: C_STRINGS },
  lua: { lineComment: ['--'], blockComment: [['--[[', ']]']], strings: C_STRINGS },
  sql: { lineComment: ['--'], blockComment: [['/*', '*/']], strings: [{ open: "'", close: "'" }] },
  haskell: { lineComment: ['--'], blockComment: [['{-', '-}']], strings: C_STRINGS },
  elixir: { lineComment: ['#'], blockComment: [], strings: C_STRINGS },
  erlang: { lineComment: ['%'], blockComment: [], strings: C_STRINGS },
  clojure: { lineComment: [';'], blockComment: [], strings: [{ open: '"', close: '"', escape: '\\' }] },
  scheme: { lineComment: [';'], blockComment: [['#|', '|#']], strings: C_STRINGS },
  fsharp: { lineComment: ['//'], blockComment: [['(*', '*)']], strings: C_STRINGS },
  css: { lineComment: [], blockComment: [['/*', '*/']], strings: C_STRINGS },
  html: { lineComment: [], blockComment: [['<!--', '-->']], strings: C_STRINGS },
  markdown: { lineComment: [], blockComment: [['<!--', '-->']], strings: [] },
  // No comments, and a key is a string but is also the only name there is.
  json: { lineComment: [], blockComment: [], strings: [] },
  plaintext: { lineComment: [], blockComment: [], strings: [] },
};

export function rulesFor(language: string): SyntaxRules {
  return RULES[language] ?? C_FAMILY;
}

/** A stretch of the file that is not code. */
export interface Span {
  start: number;
  /** Exclusive. */
  end: number;
  region: Exclude<Region, 'code'>;
}

/**
 * Every comment and string in a file, in order and non-overlapping.
 *
 * Only the non-code spans are returned. Most of a file is code, so listing the
 * exceptions is both smaller than listing every character and easier to read
 * in a test.
 *
 * What this does not do, said plainly: a regular expression literal in
 * JavaScript is not recognised, so `/save/` is reported as code. That is the
 * safe direction — an occurrence inside one is offered rather than hidden — and
 * telling it from a division needs the parse this file exists to avoid.
 */
export function scan(text: string, rules: SyntaxRules): Span[] {
  const spans: Span[] = [];
  // Longest delimiters first, so `"""` wins over `"` and `--[[` over `--`.
  const lineComments = [...rules.lineComment].sort((a, b) => b.length - a.length);
  const blockComments = [...rules.blockComment].sort((a, b) => b[0].length - a[0].length);
  const strings = [...rules.strings].sort((a, b) => b.open.length - a.open.length);

  let index = 0;
  while (index < text.length) {
    // The longest delimiter that matches here wins, across all three kinds
    // rather than within each. Lua opens a line comment with `--` and a block
    // comment with `--[[`, so checking line comments first would read every
    // block comment as a line one and stop at the first newline.
    const longest = Math.max(
      ...lineComments.map((token) => (text.startsWith(token, index) ? token.length : 0)),
      ...blockComments.map((pair) => (text.startsWith(pair[0], index) ? pair[0].length : 0)),
      ...strings.map((rule) => (text.startsWith(rule.open, index) ? rule.open.length : 0)),
      0,
    );

    const lineComment = lineComments.find(
      (token) => token.length === longest && text.startsWith(token, index),
    );
    if (lineComment !== undefined) {
      const newline = text.indexOf('\n', index);
      const end = newline === -1 ? text.length : newline;
      spans.push({ start: index, end, region: 'comment' });
      index = end;
      continue;
    }

    const block = blockComments.find(
      (pair) => pair[0].length === longest && text.startsWith(pair[0], index),
    );
    if (block) {
      const [open, close] = block;
      let cursor = index + open.length;
      let depth = 1;
      while (cursor < text.length && depth > 0) {
        if (rules.nestedBlockComment && text.startsWith(open, cursor)) {
          depth += 1;
          cursor += open.length;
        } else if (text.startsWith(close, cursor)) {
          depth -= 1;
          cursor += close.length;
        } else {
          cursor += 1;
        }
      }
      // An unterminated block comment runs to the end of the file, which is
      // what a compiler would say about it too.
      spans.push({ start: index, end: cursor, region: 'comment' });
      index = cursor;
      continue;
    }

    const literal = strings.find(
      (rule) => rule.open.length === longest && text.startsWith(rule.open, index),
    );
    if (literal) {
      let cursor = index + literal.open.length;
      let terminated = false;
      while (cursor < text.length) {
        if (literal.escape && text.startsWith(literal.escape, cursor)) {
          cursor += literal.escape.length + 1;
          continue;
        }
        if (text.startsWith(literal.close, cursor)) {
          cursor += literal.close.length;
          terminated = true;
          break;
        }
        if (text[cursor] === '\n' && !literal.multiline) break;
        cursor += 1;
      }
      if (terminated) {
        spans.push({ start: index, end: cursor, region: 'string' });
        index = cursor;
        continue;
      }
      // An unterminated single-line literal is far more likely to be an
      // apostrophe in a comment, or a lifetime in Rust, than a string that
      // swallows the rest of the file. Treat the opener as ordinary code.
      index += literal.open.length;
      continue;
    }

    index += 1;
  }

  return spans;
}

/**
 * What the character at `offset` is part of.
 *
 * Binary search, because a rename asks this once per occurrence and a file can
 * hold thousands of both.
 */
export function regionOf(spans: readonly Span[], offset: number): Region {
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const span = spans[middle];
    if (!span) break;
    if (offset < span.start) high = middle - 1;
    else if (offset >= span.end) low = middle + 1;
    else return span.region;
  }
  return 'code';
}

/**
 * Where a name occurs in a file, and what each occurrence is part of.
 *
 * Whole-word only: renaming `save` must not touch `saved` or `autosave`, and
 * an occurrence that is part of a longer name is not an occurrence at all.
 */
export interface Occurrence {
  offset: number;
  region: Region;
}

const WORD_CHARACTER = /[A-Za-z0-9_$]/;

export function occurrencesOf(text: string, name: string, rules: SyntaxRules): Occurrence[] {
  if (!name) return [];
  const spans = scan(text, rules);
  const found: Occurrence[] = [];

  let index = text.indexOf(name);
  while (index !== -1) {
    const before = index > 0 ? (text[index - 1] ?? '') : '';
    const after = text[index + name.length] ?? '';
    if (!WORD_CHARACTER.test(before) && !WORD_CHARACTER.test(after)) {
      found.push({ offset: index, region: regionOf(spans, index) });
    }
    index = text.indexOf(name, index + 1);
  }

  return found;
}

// ------------------------------------------------------------------ keywords

/**
 * Words a language has already spoken for.
 *
 * Renaming one is never what anyone meant. `def` is a name by the index's
 * reckoning — it matches the identifier pattern, it occurs in every Python file
 * — and renaming it turns every function in the workspace into a syntax error.
 * Renaming something *to* a keyword does the same thing from the other side.
 *
 * The bias here is the opposite of the one in `scan`, and for the same reason
 * underneath. Refusing a rename is visible: the panel says why, and the person
 * decides what to do. Allowing one silently breaks the file. So where a word
 * might be reserved, it is treated as reserved.
 */
const CONTROL_FLOW = [
  'if', 'else', 'for', 'while', 'do', 'break', 'continue', 'return', 'switch',
  'case', 'default', 'goto', 'try', 'catch', 'finally', 'throw',
];

const C_KEYWORDS = [
  ...CONTROL_FLOW, 'auto', 'char', 'const', 'double', 'enum', 'extern', 'float',
  'inline', 'int', 'long', 'register', 'restrict', 'short', 'signed', 'sizeof',
  'static', 'struct', 'typedef', 'union', 'unsigned', 'void', 'volatile',
];

const CPP_KEYWORDS = [
  ...C_KEYWORDS, 'bool', 'class', 'delete', 'explicit', 'friend', 'namespace',
  'new', 'operator', 'private', 'protected', 'public', 'template', 'this',
  'throw', 'typename', 'using', 'virtual', 'nullptr', 'true', 'false',
  'constexpr', 'noexcept', 'override', 'final', 'static_cast', 'dynamic_cast',
];

const JS_KEYWORDS = [
  ...CONTROL_FLOW, 'var', 'let', 'const', 'function', 'class', 'extends',
  'new', 'delete', 'typeof', 'instanceof', 'in', 'of', 'this', 'super',
  'import', 'export', 'from', 'as', 'async', 'await', 'yield', 'void',
  'null', 'undefined', 'true', 'false', 'static', 'get', 'set',
];

const TS_KEYWORDS = [
  ...JS_KEYWORDS, 'interface', 'type', 'enum', 'implements', 'namespace',
  'declare', 'abstract', 'public', 'private', 'protected', 'readonly',
  'keyof', 'infer', 'satisfies', 'any', 'unknown', 'never',
];

const PYTHON_KEYWORDS = [
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
  'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if',
  'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield', 'True', 'False', 'None', 'match',
  'case',
];

const RUST_KEYWORDS = [
  ...CONTROL_FLOW, 'as', 'async', 'await', 'const', 'crate', 'dyn', 'enum',
  'extern', 'fn', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut',
  'pub', 'ref', 'self', 'Self', 'static', 'struct', 'super', 'trait', 'type',
  'unsafe', 'use', 'where', 'true', 'false',
];

const GO_KEYWORDS = [
  ...CONTROL_FLOW, 'chan', 'const', 'defer', 'else', 'fallthrough', 'func',
  'go', 'import', 'interface', 'map', 'package', 'range', 'select', 'struct',
  'type', 'var', 'nil', 'true', 'false',
];

const JAVA_KEYWORDS = [
  ...C_KEYWORDS, 'abstract', 'assert', 'boolean', 'byte', 'class', 'extends',
  'final', 'implements', 'import', 'instanceof', 'interface', 'native', 'new',
  'package', 'private', 'protected', 'public', 'strictfp', 'super',
  'synchronized', 'this', 'throws', 'transient', 'null', 'true', 'false',
];

const SHELL_KEYWORDS = [
  'if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until', 'do', 'done',
  'case', 'esac', 'function', 'select', 'in', 'return', 'break', 'continue',
  'local', 'export', 'readonly', 'declare', 'unset', 'shift',
];

const SQL_KEYWORDS = [
  'select', 'from', 'where', 'insert', 'update', 'delete', 'into', 'values',
  'join', 'inner', 'outer', 'left', 'right', 'on', 'group', 'order', 'by',
  'having', 'union', 'create', 'table', 'drop', 'alter', 'index', 'view',
  'as', 'and', 'or', 'not', 'null', 'distinct', 'limit', 'offset',
];

const KEYWORDS: Record<string, readonly string[]> = {
  c: C_KEYWORDS,
  cpp: CPP_KEYWORDS,
  csharp: [...CPP_KEYWORDS, 'var', 'foreach', 'in', 'ref', 'out', 'is', 'lock'],
  java: JAVA_KEYWORDS,
  kotlin: [...CONTROL_FLOW, 'fun', 'val', 'var', 'class', 'object', 'when', 'is', 'in',
    'interface', 'package', 'import', 'null', 'true', 'false', 'this', 'super'],
  scala: [...CONTROL_FLOW, 'def', 'val', 'var', 'class', 'object', 'trait', 'match',
    'implicit', 'import', 'package', 'sealed', 'null', 'true', 'false', 'this'],
  swift: [...CONTROL_FLOW, 'func', 'let', 'var', 'class', 'struct', 'enum', 'protocol',
    'extension', 'guard', 'import', 'in', 'self', 'nil', 'true', 'false'],
  dart: [...JS_KEYWORDS, 'final', 'abstract', 'is', 'library', 'part', 'mixin'],
  go: GO_KEYWORDS,
  rust: RUST_KEYWORDS,
  zig: [...CONTROL_FLOW, 'fn', 'const', 'var', 'pub', 'struct', 'enum', 'union',
    'comptime', 'defer', 'errdefer', 'try', 'null', 'true', 'false'],
  javascript: JS_KEYWORDS,
  typescript: TS_KEYWORDS,
  python: PYTHON_KEYWORDS,
  ruby: [...CONTROL_FLOW, 'def', 'end', 'module', 'class', 'unless', 'until',
    'elsif', 'then', 'yield', 'self', 'nil', 'true', 'false', 'require'],
  php: [...C_KEYWORDS, 'function', 'echo', 'class', 'public', 'private', 'protected',
    'new', 'use', 'namespace', 'null', 'true', 'false', 'foreach', 'as'],
  perl: [...CONTROL_FLOW, 'sub', 'my', 'our', 'local', 'use', 'package', 'unless',
    'until', 'elsif', 'last', 'next', 'redo'],
  shell: SHELL_KEYWORDS,
  powershell: ['if', 'else', 'elseif', 'switch', 'foreach', 'for', 'while', 'do',
    'function', 'return', 'break', 'continue', 'try', 'catch', 'finally', 'param'],
  lua: ['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
    'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then',
    'true', 'until', 'while'],
  sql: SQL_KEYWORDS,
  haskell: ['case', 'class', 'data', 'deriving', 'do', 'else', 'if', 'import', 'in',
    'infix', 'instance', 'let', 'module', 'newtype', 'of', 'then', 'type', 'where'],
  r: ['if', 'else', 'repeat', 'while', 'function', 'for', 'in', 'next', 'break',
    'TRUE', 'FALSE', 'NULL', 'NA', 'Inf', 'NaN'],
  julia: [...CONTROL_FLOW, 'function', 'end', 'module', 'using', 'import', 'struct',
    'mutable', 'begin', 'let', 'local', 'global', 'true', 'false', 'nothing'],
  elixir: ['def', 'defp', 'defmodule', 'do', 'end', 'fn', 'case', 'cond', 'if',
    'unless', 'import', 'alias', 'require', 'use', 'true', 'false', 'nil'],
  erlang: ['after', 'begin', 'case', 'catch', 'cond', 'end', 'fun', 'if', 'let',
    'of', 'receive', 'try', 'when'],
  clojure: ['def', 'defn', 'fn', 'let', 'if', 'do', 'quote', 'var', 'loop', 'recur',
    'ns', 'nil', 'true', 'false'],
  scheme: ['define', 'lambda', 'let', 'if', 'cond', 'else', 'begin', 'quote', 'set!'],
  fsharp: ['let', 'mutable', 'type', 'member', 'match', 'with', 'function', 'fun',
    'module', 'open', 'rec', 'and', 'or', 'not', 'if', 'then', 'else', 'true', 'false'],
  groovy: JAVA_KEYWORDS,
  d: CPP_KEYWORDS,
  css: [],
  html: [],
  json: [],
  markdown: [],
  yaml: [],
  ini: [],
  plaintext: [],
};

/**
 * Whether a word is reserved in a language.
 *
 * Unknown languages get the control-flow core rather than nothing: `if` and
 * `return` are reserved in essentially everything this edits, and refusing
 * those two in a language that does not reserve them costs a message, while
 * allowing them where they are reserved costs the file.
 */
export function isKeyword(word: string, language: string): boolean {
  const reserved = KEYWORDS[language] ?? CONTROL_FLOW;
  return reserved.includes(word);
}
