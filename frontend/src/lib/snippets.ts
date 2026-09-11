/**
 * Snippets: the shapes you type twenty times a day.
 *
 * A snippet is a body with numbered holes in it. Typing `fn` and pressing Tab
 * writes the whole function and puts the caret on the name, then on the
 * arguments, then in the body. Monaco expands the placeholder syntax, so this
 * module is the library and the matching, not the expansion.
 *
 * The rules that keep a snippet library from becoming a liability:
 *
 *   - A prefix belongs to one snippet per language. Two snippets fighting over
 *     `for` is not a preference, it is a bug, and there is a test for it.
 *   - Every body is checked for well-formed placeholders. A malformed one
 *     inserts literal `${1:` into someone's source, and the moment to find that
 *     out is not while they are typing.
 *   - Bodies are written with tabs and re-indented to whatever the user has set
 *     for the file, so a snippet does not smuggle its author's habits in.
 */

export interface Snippet {
  /** What you type to get it. */
  prefix: string;
  /** Shown in the completion list. */
  label: string;
  description: string;
  /**
   * The text inserted, in Monaco's snippet syntax: `${1:name}` is a placeholder
   * with a default, `$1` one without, `$0` is where the caret ends up.
   */
  body: string;
  /** Monaco language ids this applies to. */
  languages: readonly string[];
}

const PYTHON: Snippet[] = [
  {
    prefix: 'def',
    label: 'def',
    description: 'Function with a docstring',
    body: 'def ${1:name}(${2:args}):\n\t"""${3:What it does.}"""\n\t$0',
    languages: ['python'],
  },
  {
    prefix: 'class',
    label: 'class',
    description: 'Class with an initialiser',
    body: 'class ${1:Name}:\n\t"""${2:What it is.}"""\n\n\tdef __init__(self${3:, value}):\n\t\t$0',
    languages: ['python'],
  },
  {
    prefix: 'main',
    label: 'main',
    description: 'Entry point guard',
    body: 'def main() -> None:\n\t$0\n\n\nif __name__ == "__main__":\n\tmain()',
    languages: ['python'],
  },
  {
    prefix: 'try',
    label: 'try',
    description: 'Try with a named exception',
    body: 'try:\n\t$1\nexcept ${2:ValueError} as error:\n\t$0',
    languages: ['python'],
  },
  {
    prefix: 'with',
    label: 'with',
    description: 'Context manager',
    body: 'with ${1:open(path)} as ${2:handle}:\n\t$0',
    languages: ['python'],
  },
  {
    prefix: 'forin',
    label: 'for ... in',
    description: 'Loop over a sequence',
    body: 'for ${1:item} in ${2:items}:\n\t$0',
    languages: ['python'],
  },
  {
    prefix: 'comp',
    label: 'comprehension',
    description: 'List comprehension with a filter',
    body: '[${1:item} for ${1:item} in ${2:items} if ${3:condition}]$0',
    languages: ['python'],
  },
  {
    prefix: 'dataclass',
    label: 'dataclass',
    description: 'Frozen dataclass',
    body: '@dataclass(frozen=True)\nclass ${1:Name}:\n\t${2:field}: ${3:str}\n\t$0',
    languages: ['python'],
  },
  {
    prefix: 'test',
    label: 'test',
    description: 'pytest case',
    body: 'def test_${1:what_it_does}() -> None:\n\t$0\n\tassert ${2:result} == ${3:expected}',
    languages: ['python'],
  },
];

const C_FAMILY: Snippet[] = [
  {
    prefix: 'main',
    label: 'main',
    description: 'Entry point',
    body: 'int main(int argc, char **argv) {\n\t$0\n\treturn 0;\n}',
    languages: ['c', 'cpp'],
  },
  {
    prefix: 'forloop',
    label: 'for',
    description: 'Counted loop',
    body: 'for (int ${1:index} = 0; ${1:index} < ${2:count}; ${1:index}++) {\n\t$0\n}',
    languages: ['c', 'cpp'],
  },
  {
    prefix: 'struct',
    label: 'struct',
    description: 'Struct with a typedef',
    body: 'typedef struct {\n\t${1:int value};\n} ${2:Name};\n$0',
    languages: ['c'],
  },
  {
    prefix: 'class',
    label: 'class',
    description: 'Class with a constructor',
    body: 'class ${1:Name} {\npublic:\n\t${1:Name}(${2:int value});\n\nprivate:\n\t$0\n};',
    languages: ['cpp'],
  },
  {
    prefix: 'vec',
    label: 'vector',
    description: 'Vector declaration',
    body: 'std::vector<${1:int}> ${2:values};\n$0',
    languages: ['cpp'],
  },
  {
    prefix: 'inc',
    label: 'include',
    description: 'Include a header',
    body: '#include <${1:stdio.h}>\n$0',
    languages: ['c', 'cpp'],
  },
];

const WEB: Snippet[] = [
  {
    prefix: 'fn',
    label: 'function',
    description: 'Named function',
    body: 'function ${1:name}(${2:args}) {\n\t$0\n}',
    languages: ['javascript', 'typescript'],
  },
  {
    prefix: 'arrow',
    label: 'arrow function',
    description: 'Arrow function in a const',
    body: 'const ${1:name} = (${2:args}) => {\n\t$0\n};',
    languages: ['javascript', 'typescript'],
  },
  {
    prefix: 'afn',
    label: 'async function',
    description: 'Async function with await',
    body: 'async function ${1:name}(${2:args}) {\n\tconst ${3:result} = await ${4:call}();\n\t$0\n}',
    languages: ['javascript', 'typescript'],
  },
  {
    prefix: 'forof',
    label: 'for ... of',
    description: 'Loop over an iterable',
    body: 'for (const ${1:item} of ${2:items}) {\n\t$0\n}',
    languages: ['javascript', 'typescript'],
  },
  {
    prefix: 'trycatch',
    label: 'try ... catch',
    description: 'Try with a caught error',
    body: 'try {\n\t$1\n} catch (${2:error}) {\n\t$0\n}',
    languages: ['javascript', 'typescript'],
  },
  {
    prefix: 'iface',
    label: 'interface',
    description: 'Interface declaration',
    body: 'interface ${1:Name} {\n\t${2:field}: ${3:string};\n}\n$0',
    languages: ['typescript'],
  },
  {
    prefix: 'html5',
    label: 'html',
    description: 'Document skeleton',
    body: '<!doctype html>\n<html lang="en">\n<head>\n\t<meta charset="utf-8">\n\t<title>${1:Page}</title>\n</head>\n<body>\n\t$0\n</body>\n</html>',
    languages: ['html'],
  },
  {
    prefix: 'flex',
    label: 'flex row',
    description: 'Flex container',
    body: 'display: flex;\nalign-items: ${1:center};\ngap: ${2:0.5rem};\n$0',
    languages: ['css'],
  },
];

const SYSTEMS: Snippet[] = [
  {
    prefix: 'fn',
    label: 'fn',
    description: 'Function',
    body: 'fn ${1:name}(${2:args}) -> ${3:()} {\n\t$0\n}',
    languages: ['rust'],
  },
  {
    prefix: 'main',
    label: 'main',
    description: 'Entry point',
    body: 'fn main() {\n\t$0\n}',
    languages: ['rust'],
  },
  {
    prefix: 'match',
    label: 'match',
    description: 'Match on a Result',
    body: 'match ${1:value} {\n\tOk(${2:value}) => $0,\n\tErr(error) => eprintln!("{error}"),\n}',
    languages: ['rust'],
  },
  {
    prefix: 'func',
    label: 'func',
    description: 'Function returning an error',
    body: 'func ${1:Name}(${2:args}) (${3:string}, error) {\n\t$0\n\treturn ${4:result}, nil\n}',
    languages: ['go'],
  },
  {
    prefix: 'iferr',
    label: 'if err',
    description: 'Error check',
    body: 'if err != nil {\n\treturn ${1:nil}, err\n}\n$0',
    languages: ['go'],
  },
  {
    prefix: 'main',
    label: 'main',
    description: 'Entry point',
    body: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("$1")\n\t$0\n}',
    languages: ['go'],
  },
  {
    prefix: 'main',
    label: 'main',
    description: 'Class with an entry point',
    body: 'public class ${1:Main} {\n\tpublic static void main(String[] args) {\n\t\t$0\n\t}\n}',
    languages: ['java'],
  },
  {
    prefix: 'shebang',
    label: 'shebang',
    description: 'Strict-mode script header',
    body: '#!/usr/bin/env bash\nset -euo pipefail\n\n$0',
    languages: ['shell'],
  },
  {
    prefix: 'case',
    label: 'case',
    description: 'Case statement',
    body: 'case "${1:value}" in\n\t${2:pattern})\n\t\t$0\n\t\t;;\nesac',
    languages: ['shell'],
  },
];

const DATA: Snippet[] = [
  {
    prefix: 'select',
    label: 'select',
    description: 'Filtered select',
    body: 'SELECT ${1:*}\nFROM ${2:table}\nWHERE ${3:condition};\n$0',
    languages: ['sql'],
  },
  {
    prefix: 'join',
    label: 'join',
    description: 'Inner join',
    body: 'SELECT ${1:a.*}\nFROM ${2:a}\nJOIN ${3:b} ON ${4:a.id = b.a_id};\n$0',
    languages: ['sql'],
  },
  {
    prefix: 'table',
    label: 'table',
    description: 'Markdown table',
    body: '| ${1:Column} | ${2:Column} |\n| --- | --- |\n| $3 | $4 |\n$0',
    languages: ['markdown'],
  },
  {
    prefix: 'code',
    label: 'code block',
    description: 'Fenced block',
    body: '```${1:python}\n$0\n```',
    languages: ['markdown'],
  },
];

export const SNIPPETS: readonly Snippet[] = [
  ...PYTHON,
  ...C_FAMILY,
  ...WEB,
  ...SYSTEMS,
  ...DATA,
];

/** Every snippet offered for a language, in the order they were written. */
export function snippetsFor(language: string): Snippet[] {
  return SNIPPETS.filter((snippet) => snippet.languages.includes(language));
}

/**
 * Snippets whose prefix starts with what has been typed.
 *
 * Prefix matching rather than the fuzzy matching the command palette uses. A
 * completion list is read while typing continues, and a fuzzy match that pulls
 * `dataclass` up when you typed `ds` makes the list move under you.
 */
export function matching(language: string, typed: string): Snippet[] {
  const needle = typed.toLowerCase();
  if (!needle) return snippetsFor(language);
  return snippetsFor(language).filter((snippet) =>
    snippet.prefix.toLowerCase().startsWith(needle),
  );
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
 * What is wrong with a body, or null.
 *
 * Checked by a test over the whole library rather than at runtime: a malformed
 * body inserts a literal `${1:` into someone's source, and the moment to find
 * that out is not while they are typing.
 */
export function validate(snippet: Snippet): string | null {
  if (!snippet.prefix.trim()) return 'a snippet with no prefix cannot be typed';
  if (!snippet.languages.length) return 'a snippet with no language is unreachable';

  // Every `${` in the body must be the start of a complete `${n:default}`.
  // One that is not means the rest of the body was meant to be a placeholder
  // and will be inserted literally instead.
  const opened = (snippet.body.match(/\$\{/g) ?? []).length;
  const complete = (snippet.body.match(/\$\{\d+:[^}]*\}/g) ?? []).length;
  if (opened !== complete) return 'a placeholder is not closed';

  const stops = placeholders(snippet.body);
  const finals = stops.filter((stop) => stop.ordinal === 0);
  if (finals.length > 1) return 'more than one final caret position';

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
 * Re-indent a body written with tabs to the file's own indentation.
 *
 * Bodies are written with tabs so the library has one convention; what comes
 * out follows the user's settings. The continuation lines also take the
 * caret's own indentation, or a snippet inserted inside a function comes back
 * flush against the left margin.
 */
export function reindent(body: string, tabSize: number, leading = ''): string {
  const unit = tabSize > 0 ? ' '.repeat(tabSize) : '\t';
  return body
    .split('\n')
    .map((line, index) => {
      const depth = line.length - line.replace(/^\t+/, '').length;
      const rest = line.slice(depth);
      // The first line starts where the caret already is.
      const prefix = index === 0 ? '' : leading;
      return prefix + unit.repeat(depth) + rest;
    })
    .join('\n');
}
