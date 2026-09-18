/**
 * Snippets, across the languages the editor actually runs.
 *
 * `$0` is where the caret lands and `$1`, `$2` are tab stops, matching the
 * convention every editor uses, so a snippet written elsewhere pastes in.
 */

import type { Extension, SnippetContribution } from '../types';

const snippet = (
  language: string,
  prefix: string,
  description: string,
  body: string,
): SnippetContribution => ({ language, prefix, description, body });

export const PYTHON_SNIPPETS: SnippetContribution[] = [
  snippet('python', 'main', 'Script entry point', 'def main() -> None:\n    $0\n\n\nif __name__ == "__main__":\n    main()\n'),
  snippet('python', 'def', 'Function with a type hint', 'def ${1:name}(${2:argument}) -> ${3:None}:\n    $0\n'),
  snippet('python', 'class', 'Class with an initialiser', 'class ${1:Name}:\n    def __init__(self, ${2:value}) -> None:\n        self.${2:value} = ${2:value}\n        $0\n'),
  snippet('python', 'dataclass', 'Frozen dataclass', 'from dataclasses import dataclass\n\n\n@dataclass(frozen=True)\nclass ${1:Name}:\n    ${2:field}: ${3:str}\n    $0\n'),
  snippet('python', 'try', 'Try with a named exception', 'try:\n    $1\nexcept ${2:Exception} as error:\n    $0\n'),
  snippet('python', 'with', 'Context manager', 'with open(${1:path}, encoding="utf-8") as ${2:handle}:\n    $0\n'),
  snippet('python', 'test', 'Pytest test', 'def test_${1:behaviour}() -> None:\n    $0\n'),
  snippet('python', 'fixture', 'Pytest fixture', '@pytest.fixture\ndef ${1:name}():\n    $0\n'),
  snippet('python', 'async', 'Async function', 'async def ${1:name}(${2:argument}) -> ${3:None}:\n    $0\n'),
  snippet('python', 'comp', 'List comprehension', '[${1:item} for ${1:item} in ${2:iterable} if ${3:condition}]$0'),
  snippet('python', 'argparse', 'Argument parser', 'import argparse\n\nparser = argparse.ArgumentParser(description="${1:what it does}")\nparser.add_argument("${2:name}")\nargs = parser.parse_args()\n$0\n'),
];

export const RUST_SNIPPETS: SnippetContribution[] = [
  snippet('rust', 'main', 'Entry point', 'fn main() {\n    $0\n}\n'),
  snippet('rust', 'fn', 'Function', 'fn ${1:name}(${2:argument}: ${3:Type}) -> ${4:()} {\n    $0\n}\n'),
  snippet('rust', 'struct', 'Struct with a derive', '#[derive(Debug, Clone)]\nstruct ${1:Name} {\n    ${2:field}: ${3:String},\n}\n$0'),
  snippet('rust', 'enum', 'Enum', '#[derive(Debug, Clone, PartialEq)]\nenum ${1:Name} {\n    ${2:Variant},\n}\n$0'),
  snippet('rust', 'impl', 'Implementation block', 'impl ${1:Name} {\n    fn ${2:new}() -> Self {\n        $0\n    }\n}\n'),
  snippet('rust', 'test', 'Unit test module', '#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn ${1:behaviour}() {\n        $0\n    }\n}\n'),
  snippet('rust', 'match', 'Match expression', 'match ${1:value} {\n    ${2:pattern} => $0,\n    _ => {}\n}\n'),
  snippet('rust', 'result', 'Function returning Result', 'fn ${1:name}() -> Result<${2:()}, ${3:String}> {\n    $0\n    Ok(())\n}\n'),
  snippet('rust', 'iter', 'Iterator chain', '${1:items}.iter().filter(|${2:item}| $3).map(|${2:item}| $4).collect::<Vec<_>>()$0'),
];

export const CPP_SNIPPETS: SnippetContribution[] = [
  snippet('cpp', 'main', 'Entry point', '#include <iostream>\n\nint main() {\n    $0\n    return 0;\n}\n'),
  snippet('cpp', 'class', 'Class with a constructor', 'class ${1:Name} {\npublic:\n    explicit ${1:Name}(${2:int value}) : ${3:value_}(${4:value}) {}\n\nprivate:\n    ${5:int} ${3:value_};\n};\n$0'),
  snippet('cpp', 'for', 'Range-based for loop', 'for (const auto& ${1:item} : ${2:container}) {\n    $0\n}\n'),
  snippet('cpp', 'vector', 'Vector declaration', 'std::vector<${1:int}> ${2:name};\n$0'),
  snippet('cpp', 'unique', 'Unique pointer', 'auto ${1:name} = std::make_unique<${2:Type}>($3);\n$0'),
  snippet('cpp', 'guard', 'Header include guard', '#pragma once\n\n$0'),
  snippet('cpp', 'try', 'Try and catch', 'try {\n    $1\n} catch (const std::exception& error) {\n    $0\n}\n'),
];

export const TYPESCRIPT_SNIPPETS: SnippetContribution[] = [
  snippet('typescript', 'fn', 'Arrow function', 'const ${1:name} = (${2:argument}: ${3:string}): ${4:void} => {\n  $0\n};\n'),
  snippet('typescript', 'interface', 'Interface', 'interface ${1:Name} {\n  ${2:field}: ${3:string};\n}\n$0'),
  snippet('typescript', 'type', 'Union type', "type ${1:Name} = ${2:'a'} | ${3:'b'};\n$0"),
  snippet('typescript', 'async', 'Async function', 'async function ${1:name}(${2:argument}: ${3:string}): Promise<${4:void}> {\n  $0\n}\n'),
  snippet('typescript', 'try', 'Try and catch', 'try {\n  $1\n} catch (error) {\n  $0\n}\n'),
  snippet('typescript', 'test', 'Vitest test', "test('${1:behaviour}', () => {\n  $0\n});\n"),
  snippet('typescript', 'component', 'React component', 'export function ${1:Name}({ ${2:prop} }: { ${2:prop}: string }) {\n  return (\n    <div>$0</div>\n  );\n}\n'),
  snippet('typescript', 'usestate', 'React state hook', 'const [${1:value}, set${2:Value}] = useState<${3:string}>(${4:initial});\n$0'),
  snippet('typescript', 'useeffect', 'React effect hook', 'useEffect(() => {\n  $0\n}, [${1:dependency}]);\n'),
];

export const GO_SNIPPETS: SnippetContribution[] = [
  snippet('go', 'main', 'Entry point', 'package main\n\nimport "fmt"\n\nfunc main() {\n\t$0\n}\n'),
  snippet('go', 'func', 'Function returning an error', 'func ${1:name}(${2:argument} ${3:string}) (${4:string}, error) {\n\t$0\n\treturn ${5:result}, nil\n}\n'),
  snippet('go', 'iferr', 'Error check', 'if err != nil {\n\treturn ${1:nil}, fmt.Errorf("${2:context}: %w", err)\n}\n$0'),
  snippet('go', 'struct', 'Struct', 'type ${1:Name} struct {\n\t${2:Field} ${3:string}\n}\n$0'),
  snippet('go', 'test', 'Table-driven test', 'func Test${1:Name}(t *testing.T) {\n\t$0\n}\n'),
];

export const SHELL_SNIPPETS: SnippetContribution[] = [
  snippet('shell', 'strict', 'Strict mode header', '#!/usr/bin/env bash\nset -euo pipefail\n\n$0'),
  snippet('shell', 'fn', 'Function with locals', '${1:name}() {\n    local ${2:argument}="$1"\n    $0\n}\n'),
  snippet('shell', 'for', 'Loop over arguments', 'for ${1:item} in "$@"; do\n    $0\ndone\n'),
  snippet('shell', 'if', 'Test a file exists', 'if [[ -f "${1:path}" ]]; then\n    $0\nfi\n'),
  snippet('shell', 'case', 'Case statement', 'case "${1:value}" in\n    ${2:pattern})\n        $0\n        ;;\n    *)\n        ;;\nesac\n'),
  snippet('shell', 'trap', 'Cleanup on exit', 'cleanup() {\n    $0\n}\ntrap cleanup EXIT\n'),
];

export const UNIVERSAL_SNIPPETS: SnippetContribution[] = [
  snippet('*', 'todo', 'TODO comment', 'TODO: $0'),
  snippet('*', 'date', 'Current date', new Date().toISOString().slice(0, 10)),
];

export const ALL_SNIPPETS: SnippetContribution[] = [
  ...PYTHON_SNIPPETS,
  ...RUST_SNIPPETS,
  ...CPP_SNIPPETS,
  ...TYPESCRIPT_SNIPPETS,
  ...GO_SNIPPETS,
  ...SHELL_SNIPPETS,
  ...UNIVERSAL_SNIPPETS,
];

export const snippetPack: Extension = {
  manifest: {
    id: 'codecraft.snippets',
    name: 'Snippet Pack',
    description:
      'Snippets for Python, Rust, C++, TypeScript, Go and shell, including the ones worth having: strict-mode shell headers, Go error checks, Rust test modules.',
    version: '1.0.0',
    publisher: 'codecraft',
    icon: '✂️',
    categories: ['Snippets'],
    activationEvents: ['onStartup'],
  },
  contributes: { snippets: ALL_SNIPPETS },
};
