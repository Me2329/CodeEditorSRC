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
| 109 | Autonomous task loop | read, change, run, fix, report |
| 110 | Seven sandboxed tools | read, list, search, analyze, write, edit, run |
| 111 | `run_code` through the real sandbox | same isolation, limits and airgap as Run |
| 112 | Plan mode | write and run tools withheld by the daemon, not the interface |
| 113 | Step budget | a run that is going nowhere stops and says so |
| 114 | Cancel mid-run | still answers the pending call, so the transcript stays resumable |
| 115 | Live step timeline | tool, arguments and result for every step |
| 116 | Expandable tool detail | full arguments and output on demand |
| 117 | File changes applied as undoable edits | one Ctrl+Z takes any of them back |
| 118 | Append-only transcript | required by signed thinking blocks |
| 119 | Strict, closed tool schemas | replaces the removed forced-tool-choice guarantee |
| 120 | Parallel tool results batched into one message | keeps parallel calls working |
| 121 | Errors reported as errors | an ambiguous edit changes nothing |
| 122 | Server-side context editing | stale tool output cleared without editing history |
| 123 | Per-run cost and step accounting | in cents, from published rates |

## Editing

| # | Feature | Notes |
| --- | --- | --- |
| 51 | Monaco editor, bundled not CDN-loaded | works airgapped |
| 52 | Syntax highlighting across the runtime catalogue | |
| 53 | Analyzer diagnostics as inline markers | |
| 54 | Multi-cursor, column selection, bracket matching | Monaco |
| 55 | Find and replace in file | |
| 56 | Format document | |
| 57 | Toggle line comment | |
| 58 | Sticky scroll | |
| 59 | Linked editing of paired tags | |
| 60 | Bracket pair colourisation | |
| 61 | Format on paste | |
| 62 | Configurable ruler column | |
| 63 | Whitespace rendering toggle | |
| 64 | Word wrap toggle | Alt+Z |
| 65 | Minimap toggle | |
| 66 | Line number toggle | |
| 67 | Font size and ligature control | |
| 68 | Tab size control | |

## Navigation and control

| # | Feature | Notes |
| --- | --- | --- |
| 69 | Command palette over a single command registry | Ctrl+Shift+P |
| 70 | Quick open by file | Ctrl+P |
| 71 | Go to symbol | Ctrl+Shift+O |
| 72 | Fuzzy matching with boundary and adjacency scoring | |
| 73 | Keyboard-first palette | arrows, Enter, Escape |
| 74 | Editor tab strip with entry-point marking | |
| 75 | File explorer with create and delete | |
| 76 | Inline file-name validation | same rule as the server |
| 77 | Jump to a diagnostic or symbol from a panel | |
| 78 | Zen mode | F11, Escape to leave |
| 79 | Status bar | caret, selection, indentation, toolchain, counts, exit code |
| 80 | Toolbar actions | palette, export, import, zen, settings |

## Analysis

| # | Feature | Notes |
| --- | --- | --- |
| 81 | Scope tree for brace and indentation languages | |
| 82 | Size metrics | code, comment and blank lines, characters, tokens |
| 83 | Cyclomatic complexity estimate | |
| 84 | Maximum nesting depth | |
| 85 | Declaration count | |
| 86 | Unbalanced and mismatched delimiter diagnostics | with the opening line |
| 87 | Unterminated comment and string diagnostics | |
| 88 | Deep-nesting and long-declaration warnings | |
| 89 | Live analysis as you type, switchable off | |

## Workspace and configuration

| # | Feature | Notes |
| --- | --- | --- |
| 90 | Workspace persistence across a reload | |
| 91 | Export a workspace as JSON | |
| 92 | Import a workspace, with name validation | |
| 93 | Preferences persisted and clamped on read | |
| 94 | Five themes across editor, interface and terminal | |
| 95 | Runtime picker grouped by paradigm | shows which toolchains this host has |
| 96 | Starter template per runtime | |
| 97 | Run configuration panel | stdin and arguments with a parsed preview |
| 98 | Console clear, and scrollback preserved across theme changes | |
| 99 | Reduced-motion support | |
| 100 | Reconnection with backoff on both sockets | |

## Operations

| # | Feature | Notes |
| --- | --- | --- |
| 101 | Host capability report | `make doctor` |
| 102 | Toolchain provisioning by group | `make provision` |
| 103 | Conformance suite asserting containment | `make test-sandbox` |
| 104 | One make target per layer | build, run, test |
| 105 | Supervisor daemon for the production path | gateway detects it automatically |
| 106 | Docker image and compose stack | |
| 107 | Health endpoint reporting real capability | tier, backends, assistant, runtime counts |
| 108 | Optional Redis, optional supervisor, optional assistant | each degrades honestly |

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
