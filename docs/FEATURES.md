# Feature inventory

Every feature currently implemented and verified. Nothing here is aspirational:
each entry works in the running application, and the test suite that covers it
is named where one exists.

## Execution

| # | Feature | Notes |
| --- | --- | --- |
| 1 | 41 runtimes registered, 23 executable on a stock host | one registry shared by Bash, the gateway and the client |
| 2 | Compiled languages | C, C++, Rust, Go, Fortran, Nim, NASM assembly |
| 3 | Interpreted languages | Python, Ruby, PHP, Perl, Lua, Racket, AWK |
| 4 | Managed runtimes | Java, C# on Mono, and the JVM family when installed |
| 5 | Web and scripting | Node, Bun, TypeScript, Bash, Zsh, SQL, jq |
| 6 | Toolchain fallback per runtime | Lua runs on luajit, lua5.4 or lua; C# on mcs, csc or dotnet |
| 7 | Multi-file workspaces | imports across files work, all files travel with the request |
| 8 | Standard input | programs that read input are runnable |
| 9 | Command-line arguments | shell-style quoting, no shell expansion |
| 10 | Live output streaming | stdout and stderr arrive as produced, not after exit |
| 11 | Abort a running program | under two seconds, kills the whole process tree |
| 12 | Faithful exit codes | including 124 for a deadline |
| 13 | Compile and run phases reported separately | with their own durations |
| 14 | Per-run isolation metadata | tier, privilege drop, network state, limits |
| 15 | Requested limits | time and memory, clamped by the server |
| 16 | HTML live preview | rendered client-side in a sandboxed iframe |
| 17 | Output ceiling | a runaway printer is cut off, not left to exhaust memory |

## Isolation

| # | Feature | Notes |
| --- | --- | --- |
| 18 | Three isolation tiers, selected by probing | nsjail, user namespaces, rlimit |
| 19 | Privilege drop before unsharing | closes the credential hole a userns alone leaves |
| 20 | Read-only root filesystem inside the sandbox | |
| 21 | Ephemeral RAM-backed /tmp | |
| 22 | Network airgap by default | a new, empty network namespace |
| 23 | Memory ceiling | cgroups v2 where available, rlimits otherwise |
| 24 | CPU and wall-clock deadlines | normalised exit codes |
| 25 | Process and file-size ceilings | fork bombs contained |
| 26 | seccomp-bpf policy for the nsjail tier | explicit deny list |
| 27 | Read-only toolchain staging | rustup and bun work without relaxing host permissions |
| 28 | Ephemeral workspaces destroyed on every exit path | including panic and abort |
| 29 | Path-traversal rejection in three independent layers | client, gateway, supervisor |
| 30 | Per-client rate limiting | Redis when present, in-process otherwise |
| 31 | Concurrency cap | released by a guard, so a panic cannot leak capacity |
| 32 | Honest tier reporting | health, logs and the header all say what is really enforced |

## Assistant

| # | Feature | Notes |
| --- | --- | --- |
| 33 | Local engine answering in ~0.2ms | no network, no model, works offline |
| 34 | Workspace symbol index | functions, classes, types, modules across languages |
| 35 | Completion ranking | symbols over identifiers over keywords |
| 36 | Prefix, camel-case initial and subsequence matching | "hm" finds HashMap |
| 37 | Identifier frequency weighting | names used more often rank higher |
| 38 | Go-to-definition and reference counts from the index | |
| 39 | Claude Mythos 5.1 for reasoning | streamed token by token |
| 40 | Automatic routing between the two engines | index when exact, model otherwise |
| 41 | Engine attribution on every reply | you always know what answered |
| 42 | Reasoning summaries | behind a disclosure, off by default |
| 43 | Five effort levels | mapped to output_config.effort |
| 44 | Per-turn cost reporting | in cents, from published rates |
| 45 | Refusal detection and reporting | not surfaced as an empty answer |
| 46 | Server-side fallbacks enabled | a refusal reroutes by category |
| 47 | Workspace-grounded prompting | files, symbols, caret and selection |
| 48 | Apply a code block to the editor | as an undoable edit |
| 49 | Copy a code block | |
| 50 | Honest degradation with no credential | says so rather than inventing an answer |

## Agent

| # | Feature | Notes |
| --- | --- | --- |
| 51 | Autonomous task loop | read, change, run, fix, report |
| 52 | Seven sandboxed tools | read, list, search, analyze, write, edit, run |
| 53 | `run_code` through the real sandbox | same isolation, limits and airgap as Run |
| 54 | Plan mode | write and run tools withheld by the daemon, not the interface |
| 55 | Step budget | a run that is going nowhere stops and says so |
| 56 | Cancel mid-run | still answers the pending call, so the transcript stays resumable |
| 57 | Live step timeline | tool, arguments and result for every step |
| 58 | Expandable tool detail | full arguments and output on demand |
| 59 | File changes applied as undoable edits | one Ctrl+Z takes any of them back |
| 60 | Append-only transcript | required by signed thinking blocks |
| 61 | Strict, closed tool schemas | replaces the removed forced-tool-choice guarantee |
| 62 | Parallel tool results batched into one message | keeps parallel calls working |
| 63 | Errors reported as errors | an ambiguous edit changes nothing |
| 64 | Server-side context editing | stale tool output cleared without editing history |
| 65 | Per-run cost and step accounting | in cents, from published rates |

## Editing

| # | Feature | Notes |
| --- | --- | --- |
| 66 | Monaco editor, bundled not CDN-loaded | works airgapped |
| 67 | Syntax highlighting across the runtime catalogue | |
| 68 | Analyzer diagnostics as inline markers | |
| 69 | Multi-cursor, column selection, bracket matching | Monaco |
| 70 | Find and replace in file | |
| 71 | Format document | |
| 72 | Toggle line comment | |
| 73 | Sticky scroll | |
| 74 | Linked editing of paired tags | |
| 75 | Bracket pair colourisation | |
| 76 | Format on paste | |
| 77 | Configurable ruler column | |
| 78 | Whitespace rendering toggle | |
| 79 | Word wrap toggle | Alt+Z |
| 80 | Minimap toggle | |
| 81 | Line number toggle | |
| 82 | Font size and ligature control | |
| 83 | Tab size control | |

## Navigation and control

| # | Feature | Notes |
| --- | --- | --- |
| 84 | Command palette over a single command registry | Ctrl+Shift+P |
| 85 | Quick open by file | Ctrl+P |
| 86 | Go to symbol | Ctrl+Shift+O |
| 87 | Fuzzy matching with boundary and adjacency scoring | |
| 88 | Keyboard-first palette | arrows, Enter, Escape |
| 89 | Editor tab strip with entry-point marking | |
| 90 | File explorer with create and delete | |
| 91 | Inline file-name validation | same rule as the server |
| 92 | Jump to a diagnostic or symbol from a panel | |
| 93 | Zen mode | F11, Escape to leave |
| 94 | Status bar | caret, selection, indentation, toolchain, counts, exit code |
| 95 | Toolbar actions | palette, export, import, zen, settings |

## Analysis

| # | Feature | Notes |
| --- | --- | --- |
| 96 | Scope tree for brace and indentation languages | |
| 97 | Size metrics | code, comment and blank lines, characters, tokens |
| 98 | Cyclomatic complexity estimate | |
| 99 | Maximum nesting depth | |
| 100 | Declaration count | |
| 101 | Unbalanced and mismatched delimiter diagnostics | with the opening line |
| 102 | Unterminated comment and string diagnostics | |
| 103 | Deep-nesting and long-declaration warnings | |
| 104 | Live analysis as you type, switchable off | |

## Workspace and configuration

| # | Feature | Notes |
| --- | --- | --- |
| 105 | Workspace persistence across a reload | |
| 106 | Export a workspace as JSON | |
| 107 | Import a workspace, with name validation | |
| 108 | Preferences persisted and clamped on read | |
| 109 | Five themes across editor, interface and terminal | |
| 110 | Runtime picker grouped by paradigm | shows which toolchains this host has |
| 111 | Starter template per runtime | |
| 112 | Run configuration panel | stdin and arguments with a parsed preview |
| 113 | Console clear, and scrollback preserved across theme changes | |
| 114 | Reduced-motion support | |
| 115 | Reconnection with backoff on both sockets | |

## Operations

| # | Feature | Notes |
| --- | --- | --- |
| 116 | Host capability report | `make doctor` |
| 117 | Toolchain provisioning by group | `make provision` |
| 118 | Conformance suite asserting containment | `make test-sandbox` |
| 119 | One make target per layer | build, run, test |
| 120 | Supervisor daemon for the production path | gateway detects it automatically |
| 121 | Docker image and compose stack | |
| 122 | Health endpoint reporting real capability | tier, backends, assistant, runtime counts |
| 123 | Optional Redis, optional supervisor, optional assistant | each degrades honestly |

## Not implemented

Stated plainly so the list above can be trusted:

- Real-time collaborative editing. The architecture notes describe it; no
  CRDT or presence layer exists.
- Per-tool approval prompts. The agent's safety boundary is plan mode plus the
  sandbox, not a confirmation on each write.
- A debugger. No breakpoints, stepping or variable inspection.
- Package installation inside a run. The sandbox is airgapped, so a program
  cannot fetch dependencies.
- Language servers. Completion comes from the local index, not from a
  per-language LSP.
- Git integration.
- Firecracker microVMs, Kubernetes and GPU execution tiers.
