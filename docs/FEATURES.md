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

## Local language model

Built from scratch in `core/model`: architecture, tokenizer, training loop,
sampler and weights are all ours. No pretrained weights are downloaded and
nothing here calls a hosted model.

| # | Feature | Notes |
| --- | --- | --- |
| 124 | Decoder-only transformer written from scratch | no model library, only tensor operations |
| 125 | RMSNorm with pre-norm blocks | computed in float32 regardless of autocast |
| 126 | Rotary position embeddings | tested for the relative-position property |
| 127 | Grouped query attention | shrinks the cache that dominates generation memory |
| 128 | SwiGLU feed-forward | gate, up and down projections |
| 129 | Tied input and output embeddings | counted once by the optimiser and the parameter report |
| 130 | Depth-scaled residual initialisation | the stream's variance does not grow with layers |
| 131 | Key/value cache | one step per token instead of re-reading the prefix |
| 132 | Six named sizes, 1.3M to 1.01B | counts derived from the architecture, asserted against real modules |
| 133 | Byte-level BPE trained on our own corpus | no unknown token, indentation and emoji survive |
| 134 | Pre-tokeniser proven to cover every character | a test asserts it reconstructs its input |
| 135 | Corpus builder with file markers | the model learns where one file ends |
| 136 | Memory-mapped token dataset | a corpus larger than RAM still trains |
| 137 | Chunked encoding that matches whole-corpus encoding | boundaries never split a whitespace run |
| 138 | AdamW with decay only on matrices | norm gains and biases excluded |
| 139 | Cosine schedule with linear warmup | reaches the floor exactly on the final step |
| 140 | Gradient accumulation and clipping | effective batch without the memory |
| 141 | Periodic validation, best-only checkpointing | a worse later evaluation cannot overwrite |
| 142 | Self-describing checkpoints | reload without being told the shape |
| 143 | Reproducible runs from a seed | asserted by a test |
| 144 | Training summary with the loss curve | `training.json` |
| 145 | Temperature, top-k, top-p, repetition penalty | top-p always keeps at least one token |
| 146 | Streaming generation through an incremental UTF-8 decoder | a character split across tokens arrives whole |
| 147 | Messages-compatible HTTP endpoint | the assistant client works against it unchanged |
| 148 | Native `/generate` endpoint | prompt in, tokens with ids out |
| 149 | Serialised generation behind a lock | PyTorch releases the GIL; two requests would contend |
| 150 | One make target per stage | sizes, prepare, train, sample, serve |
| 151 | End-to-end verification against the assistant daemon | `make model-verify`, fails on an unreachable or empty reply |
| 152 | Automatic device selection | CUDA, then Apple Metal, then CPU; `--device` overrides |
| 153 | Architecture mismatch detected before the run | a wheel missing the card's `sm_` fails every kernel with no install-time warning |
| 154 | bfloat16 autocast on capable cards | no loss scaling needed; float32 master weights |
| 155 | float16 with a gradient scaler on older cards | gradients unscaled before clipping |
| 156 | TF32 and cuDNN benchmarking on a GPU | free speed for the remaining float32 matmuls |
| 157 | Pinned, asynchronous batch transfers | the copy overlaps the previous step |
| 158 | Optional `torch.compile` | opt-in, so a failed compile cannot cost a run |
| 159 | Checkpoints always written on the CPU | a GPU-trained model loads on a machine without one |
| 160 | Compiled-model checkpoints stay portable | the `_orig_mod.` prefix is stripped on both sides |
| 161 | Peak VRAM reported per run | in the training summary |
| 162 | Size table says what fits on the detected card | with headroom for activations |
| 163 | Incremental BPE training | pair-to-words index and a lazy heap; ~40x faster, flat in vocabulary size |
| 164 | Streaming corpus builder | one file at a time to disk, so a corpus can exceed memory |
| 165 | Capped tokenizer sample with a stride | a representative sample, spanning the tree |
| 166 | Vendored directories includable on request | `--allow-dir site-packages node_modules` |
| 167 | Wall-clock training budget | `--max-hours`, checkpointing the step in progress first |
| 168 | Resume with optimiser state | `--resume`; without the moments the loss jumps |
| 169 | Best and latest checkpoints kept separately | serve the best, resume from the latest |
| 170 | Corpus statistics recorded | files, characters, characters per token, bytes on disk |
| 171 | Repositories cloned, read and deleted one at a time | peak disk is the token stream plus one repository |
| 172 | Shallow clones with `.git` removed before reading | history is bandwidth spent on near-duplicate text |
| 173 | An unreachable repository is skipped, not fatal | and deleted even when encoding raises |
| 174 | Curated 47-repository list, largest first | a token budget still leaves a broad corpus |
| 175 | Token budget for a corpus | `--max-tokens` |
| 176 | Split by truncation rather than copy | 2.1GB peak instead of 4GB at a billion tokens |
| 177 | Disk cost calculator | `codecraft_model corpus`, for any target size |
| 178 | Model card stating what the model is and is not | base model, no alignment layer, real risks named |

## Extensions

The editor now has an extension host. Everything below is contributed through
it, by bundled extensions using the same public contract a third-party one
would, and every one can be switched off from the Extensions panel.

| # | Feature | Notes |
| --- | --- | --- |
| 179 | Extension host with a typed manifest | contributions, activation events, versioned |
| 180 | Lazy activation | `onStartup`, `onLanguage:x`, `onCommand:x`, `onFile:glob` |
| 181 | An event already fired still activates a late registration | no missed wake-ups |
| 182 | Contributions indexed by owning extension | disabling removes exactly its own work |
| 183 | Complete deactivation | `deactivate` plus every tracked subscription disposed |
| 184 | One failing disposable does not strand the rest | disposal continues past a throw |
| 185 | A throwing extension is contained | marked broken, contributions withdrawn, editor unaffected |
| 186 | A throwing linter is skipped, not fatal | partial diagnostics beat an empty panel |
| 187 | A throwing command is reported, not propagated | surfaced through the host's notifier |
| 188 | Per-extension namespaced storage | survives a private window with no value |
| 189 | Disabled set persisted | choices survive a reload |
| 190 | Extension API is a request surface, not editor internals | the host can refuse, log or undo any call |
| 191 | Extensions panel | contributions summarised from the manifest, so it cannot drift |
| 192 | 30 text actions | casing, line operations, encoding, number conversion |
| 193 | 49 snippets | Python, Rust, C++, TypeScript, Go, shell |
| 194 | 11 linters over 8 rule families | conflict markers, mutable defaults, unsafe string functions, unquoted expansions |
| 195 | 10 language configurations | comments, brackets, indent and dedent patterns |
| 196 | JSON formatter that survives malformed input | reformats what it can rather than throwing |
| 197 | Whitespace formatter for every language | indentation, trailing space, final newline |
| 198 | 8 status bar contributions | caret, selection, language, size, line endings, indent, TODO count |
| 199 | Extension diagnostics merged into Monaco markers | alongside the analyzer's, in one list |
| 200 | Extension commands merged into the command palette | one list rather than two that drift |
| 201 | Format command bound to the language's formatter | hidden when no formatter is registered |

## Fill in the middle

| # | Feature | Notes |
| --- | --- | --- |
| 202 | Fill-in-the-middle tokens | appended past the merges, so existing corpora stay readable |
| 203 | FIM training transform | `prepare --fim 0.5`, rearranging a fraction of documents |
| 204 | Both shapes kept in the mix | a model trained only on FIM gets worse at ordinary continuation |
| 205 | `encode_infill` with a context budget | trims from the outside in, keeping the text nearest the caret |
| 206 | `infill` engine API | low temperature and a small budget, unlike chat |
| 207 | Generation stops at a structural marker | otherwise it runs on past the hole |
| 208 | `POST /infill` on the model server | |
| 209 | `codecraft_model infill` command | marks the model's contribution in colour |
| 210 | Gateway route to the local model | `POST /api/v1/assistant/infill` |
| 211 | Model reached over HTTP, not imported | a deployment that only runs code carries no PyTorch |
| 212 | Standard-library HTTP client | one POST does not justify a dependency |
| 213 | Loopback calls bypass any ambient proxy | source code must not leave the machine |
| 214 | Model absence is a described state, not an error | 503, and the editor shows nothing |
| 215 | `GET /api/v1/assistant/model` | whether the model is running, and what it is |
| 216 | Monaco inline completion provider | grey text ahead of the caret, Tab accepts |
| 217 | Suppressed mid-identifier and in comments | where a suggestion competes rather than helps |
| 218 | Duplicate suffix text trimmed | a model repeating the line below would duplicate on accept |
| 219 | Suggestions capped at six lines | a one-line hole is not filled with twenty |
| 220 | Bracket-only suggestions suppressed | the editor already inserted those |
| 221 | Requests cancelled when the user types | a stale request outlives its relevance |
| 222 | Inline completion is a preference | off means no requests at all |

## Quantization and review

| # | Feature | Notes |
| --- | --- | --- |
| 223 | Int8 weights for serving | `serve --quantize` |
| 224 | Symmetric per-output-channel scales | one outlier row would otherwise squash every other row |
| 225 | Rounding rather than truncation | truncating biases every weight toward zero |
| 226 | Embedding, norms and output head left in float | tied weights and a softmax amplify small errors |
| 227 | Zero rows handled without dividing by zero | |
| 228 | Quantization report with measured error | the claim can be checked rather than believed |
| 229 | Measured compression stated honestly | 2.23x overall, 4x on the matrices it touches |
| 230 | Line diff by longest common subsequence | lines, not characters: a rename is one change |
| 231 | Large files fall back rather than allocating | a diff nobody can read is not worth an out-of-memory error |
| 232 | Unchanged runs collapsed with context | a one-line change in a thousand lines stays readable |
| 233 | Both line numberings preserved | before and after, side by side |
| 234 | Unified diff export | copy into a commit message or a review |
| 235 | Changes panel for agent edits | seeing the diff beats trusting the promise |
| 236 | Baseline recorded once per run | a second edit still diffs against what the user last saw |

## Measurement and search

| # | Feature | Notes |
| --- | --- | --- |
| 237 | `evaluate` command | held-out perplexity and throughput in one place |
| 238 | Bits per character reported | the only figure comparable across tokenizers |
| 239 | Prefill and decode measured separately | compute-bound and memory-bound respectively |
| 240 | Time to first token | the prefill number as lag someone feels |
| 241 | Warmup discarded | otherwise the measurement is startup, not speed |
| 242 | Fixed evaluation seed | a difference between checkpoints is a real difference |
| 243 | Evaluation leaves a training model in training mode | dropout stays on |
| 244 | Quantized evaluation | measured: int8 costs nothing in quality here |
| 245 | Workspace-wide search | plain text, whole word, case, regular expressions |
| 246 | An invalid pattern returns nothing rather than throwing | it is the normal state while typing one |
| 247 | Empty-matching patterns refused | no useful meaning, and it would hang |
| 248 | Match cap | a runaway pattern cannot lock the tab |
| 249 | Per-line cursor reset | a match at the start of a line is not skipped |
| 250 | Replace across the workspace | capture groups in regex mode, literal dollars otherwise |
| 251 | Only changed files returned | including the case-normalising replacement that really does change one |

## Search panel and model status

| # | Feature | Notes |
| --- | --- | --- |
| 252 | Search panel with results grouped by file | click a result to jump there |
| 253 | Match highlighting in the result line | offsets, not a second search |
| 254 | Collapsible file groups | |
| 255 | Ctrl+Shift+F | and a command palette entry |
| 256 | Replace is two steps | the file count is shown before anything changes |
| 257 | Replacement on the open file goes through Monaco | one Ctrl+Z takes the whole thing back |
| 258 | Model status in the status bar | says what is behind inline completion |
| 259 | Probed rather than polled | a missing model is the common case and rarely changes |

## Sampling

| # | Feature | Notes |
| --- | --- | --- |
| 260 | min-p sampling | keeps tokens within a fraction of the most likely one |
| 261 | Adapts to confidence in both directions | narrow after `def `, wide mid-comment |
| 262 | The best token can never be filtered out | it is its own reference |
| 263 | Off by default | silent sampling changes make runs incomparable |
| 264 | Available from `sample`, `/generate` and the engine | |

## Keybindings

| # | Feature | Notes |
| --- | --- | --- |
| 265 | Shortcuts as a table, not a chain of conditionals | listable, displayable, overridable |
| 266 | Ctrl and Cmd folded into one modifier | a single binding covers both keyboards |
| 267 | Written shortcuts parse from what people type | `Ctrl+Shift+P`, `cmd+p`, `Mod+,` |
| 268 | Parsing and describing agree | asserted, or a written binding could never fire |
| 269 | Modifier-only shortcuts refused | they can never fire, so installing one is a dead key |
| 270 | Conflicts detected rather than resolved silently | a shortcut that does nothing is invisible |
| 271 | Scoped bindings | a format shortcut does not fire in a search box |
| 272 | User overrides by command id | survives a change to the default |
| 273 | An unparseable override falls back | losing a shortcut silently is worse than ignoring a typo |
| 274 | Every shipped binding is checked against a real command | a dead shortcut fails the build |
| 275 | Platform notation for display | `Ctrl+Shift+P` or `⌘⇧P` |

## Checkpoint format

| # | Feature | Notes |
| --- | --- | --- |
| 276 | A checkpoint format with nothing to execute | JSON header, raw bytes, no pickle |
| 277 | Header readable with the standard library | verified, not asserted |
| 278 | 64-byte tensor alignment | memory-map and slice without copying |
| 279 | Bit-identical round trip | not close: the same |
| 280 | bfloat16 carried despite numpy lacking it | through an unsigned view |
| 281 | Header read without touching the weights | asking what a file is should not cost gigabytes |
| 282 | Unknown dtypes refused | rather than silently widening the format |
| 283 | Implausible header lengths refused | a corrupt length is not handed to read() |
| 284 | Truncated files reported by tensor name | |
| 285 | Int8 export | `export --quantize` |

## Editor tabs

The previous strip listed every file in the workspace, which made it a second
file explorer rather than a record of what you are working on. Open and exists
are now different things.

| # | Feature | Notes |
| --- | --- | --- |
| 286 | Open files tracked apart from existing files | closing a tab does not delete anything |
| 287 | Closing activates the tab to the right | falling back left when it was last |
| 288 | A run of closes keeps moving one way | rather than bouncing between neighbours |
| 289 | Closing an inactive tab leaves the current one showing | |
| 290 | An already-open file activates in place | reordering under someone mid-navigation is unusable |
| 291 | Middle-click closes | the gesture nobody thinks about until it is missing |
| 292 | Drag to reorder | and reordering is not navigation |
| 293 | Ctrl+W, Ctrl+Tab, Ctrl+Shift+Tab | with palette entries |
| 294 | Close others | |
| 295 | Deleting a file prunes its tab | and activates another if it was showing |
| 296 | Pruning returns the same object when there is nothing to do | no re-render per keystroke |
| 297 | The entry file is marked in its tab | |

## Instruction fine-tuning

| # | Feature | Notes |
| --- | --- | --- |
| 298 | Supervised fine-tuning | `finetune --examples instructions.jsonl` |
| 299 | Loss on the answer only | training on the question teaches it to ask questions |
| 300 | Labels shifted by one | matching what the model expects everywhere else |
| 301 | The stop token is scored | the model can only learn to stop if stopping is scored |
| 302 | One prompt builder for training and inference | they cannot drift apart |
| 303 | Padding masked out of the loss | the model must not be trained to produce it |
| 304 | Batches padded to their longest example | not to the maximum |
| 305 | Over-long examples dropped, not truncated | a half-cut answer teaches it to stop mid-sentence |
| 306 | Bad JSON lines skipped with a message | one bad line does not lose the set |
| 307 | `project_all` on the forward pass | full logits without the model scoring them itself |
| 308 | A much lower learning rate by default | fine-tuning adjusts a model that already works |

## Local history

There is no git in a browser, and the ways to lose an afternoon are ordinary
ones: an assistant rewrite that replaced more than it should have, a replace
across every file, a paste over what turned out to be the whole buffer. Undo
covers the first few seconds of that and nothing after a reload.

| # | Feature | Notes |
| --- | --- | --- |
| 309 | Snapshots of every file as it was | a panel of its own, with the diff against the buffer now |
| 310 | A snapshot when the typing stops | 2.5 seconds of quiet, not one per keystroke |
| 311 | Edits close together collapse into one entry | 45 seconds, so a burst of typing is one place to go back to |
| 312 | A run, an assistant edit and a replace-all are landmarks | they keep their own entry and never collapse |
| 313 | Content identical to the last snapshot is not recorded | entries that diff to nothing are not entries |
| 314 | Restoring snapshots the current content first | so restoring the wrong revision is itself undoable |
| 315 | A restore goes through the editor | one Ctrl+Z takes it back |
| 316 | Bounded per file and in total, oldest first | an unbounded history fills the storage quota and takes the workspace with it |
| 317 | A failed write halves the budget and retries once | history is expendable; editing is not |
| 318 | Deleting a file keeps its history | deleting the wrong file is the accident this exists for |
| 319 | Malformed stored entries are dropped, not fatal | a shape change costs history, not the session |
| 320 | Relative ages, and why each snapshot was taken | "before running", "before an assistant edit" |

This is not version control. There are no branches, no commits, no remote, and
history lives in the browser alongside the workspace.

## Prompt caching at the caret

| # | Feature | Notes |
| --- | --- | --- |
| 321 | A prefix cache over the last prefill | a keystroke costs the new tokens, not the whole context |
| 322 | Reuse declined below 16 shared tokens | rebuilding a short prefix beats slicing a cache |
| 323 | Trimmed caches are views, not copies | copying key/value tensors would undo the saving |
| 324 | A response cache for requests already seen | under a millisecond, and a suggestion that does not flicker |
| 325 | Sampling settings are part of the cache key | the same prompt at two temperatures is two questions |
| 326 | `use_cache=False` to ask again | for a caller that wants a different suggestion |
| 327 | Hit rates reported by `describe` | whether the cache works is not something to infer from timings |
| 328 | Bottom-right aligned attention mask over a cache | `is_causal` hides the whole cached prefix from new tokens |
| 329 | A trimmed prompt refuses a cached prefix | its keys belong to different positions |
| 330 | Reuse verified on logits, not sampled tokens | an untrained model emits the same token either way |

## Snippets

| # | Feature | Notes |
| --- | --- | --- |
| 331 | A snippet library for twelve languages | Python, C, C++, JavaScript, TypeScript, Rust, Go, Java, shell, HTML, CSS, SQL, Markdown |
| 332 | Offered in the completion list as you type | prefix matching, not fuzzy: a list that reorders under you is unreadable |
| 333 | Tab stops, defaults and mirrors | `${1:name}` twice fills both from one typing |
| 334 | A palette mode for browsing them | typing a prefix finds what you know; this is for what you do not |
| 335 | Bodies re-indented to your tab size | and to the caret's own indentation, so one inserted inside a function is not flush left |
| 336 | Every body validated by a test | an unclosed placeholder would insert `${1:` into someone's source |
| 337 | One prefix per snippet per language | two snippets fighting over `for` is a bug, not a preference |
| 338 | Consecutive tab stops enforced | a gap makes Tab land somewhere the author did not intend |
| 339 | A toggle in settings | |
| 340 | They work with no model running | which is the point of having them alongside inline completion |

## Repeat control

| # | Feature | Notes |
| --- | --- | --- |
| 341 | An n-gram already generated cannot be generated again | what stops `\n#\n#\n#` |
| 342 | The prompt is exempt | a completion that cannot reuse a phrase from the file is worse than a loop |
| 343 | Four tokens by default for infill | two forbids a second run of indentation, which is worse than the loop |
| 344 | Exposed over HTTP on both routes | `no_repeat_ngram`, off by default for chat |

## Back and forward

| # | Feature | Notes |
| --- | --- | --- |
| 345 | A navigation stack across files | Alt+Left and Alt+Right, with palette entries |
| 346 | Only jumps are recorded | another file, or ten lines away in this one |
| 347 | A small move updates the current place | so going back lands where you were, not ten lines above |
| 348 | Browser semantics | going somewhere new from the middle discards what was ahead |
| 349 | Bounded at fifty places | the far end is older than anything anyone is looking for |
| 350 | Navigating does not record itself | or the place you came from is buried by the one you went to |
| 351 | Deleting a file drops its places | and the current position follows what it was pointing at |

## Low-rank adapters

| # | Feature | Notes |
| --- | --- | --- |
| 352 | `finetune --lora 8` trains an adapter instead of the model | 1.1% of the parameters on the demo checkpoint |
| 353 | The adapter file is a few tens of kilobytes | 63KB against a 15.8MB checkpoint |
| 354 | The base checkpoint is untouched | so several adapters can share one model |
| 355 | An untrained adapter is exactly the base model | B starts at zero, so training begins with no discontinuity |
| 356 | Freezing happens inside apply, not in the caller | an adapter over an unfrozen model is full fine-tuning with extra steps |
| 357 | `--merge` folds it into the weights | producing an ordinary checkpoint |
| 358 | Merging is numerically exact | tested against the unmerged model |
| 359 | Merging unfreezes what applying froze | or the merged model reports the adapter's parameter count |
| 360 | `serve --adapter` and `sample --adapter` | merged on load, so serving costs nothing |
| 361 | Adapter shape mismatches are refused | rather than loading and giving wrong answers |
| 362 | Alpha over rank | so raising the rank does not also raise the correction |

## Downloading the workspace

| # | Feature | Notes |
| --- | --- | --- |
| 363 | Export as a real zip | what every operating system already opens |
| 364 | Written by hand, no library | stored entries are three record types and a checksum |
| 365 | CRC-32 checked against an independent implementation | a checksum that agrees only with itself is one no unzip accepts |
| 366 | UTF-8 names and content | flagged, so readers do not guess a codepage |
| 367 | Entry names cannot climb out of the extract directory | `../../etc/passwd` becomes `etc/passwd` |
| 368 | Verified by unzipping with Python's zipfile | not only against the writer's own reader |
| 369 | An empty workspace still makes a valid archive | 22 bytes of end-of-directory record |

## A file tree that is a tree

The explorer called itself a file tree and rendered one flat row per file. That
worked for the six files a demo has and stopped working the moment anyone
organised anything.

| # | Feature | Notes |
| --- | --- | --- |
| 370 | Files nest by their names | `lib/util.py` appears inside `lib` |
| 371 | Folders are derived, not stored | one appears when a file is named into it, and goes with the last such file |
| 372 | Folders collapse and remember | nested contents hide with their parent |
| 373 | Folders before files, then alphabetical | a list that interleaves them is harder to scan |
| 374 | Numbers sort as numbers | `part2.py` before `part10.py`, which bytes do not do |
| 375 | Case does not decide the order | `alpha.py` before `Beta.py` |
| 376 | Rows are flattened before rendering | so keyboard navigation works on a list rather than a shape |
| 377 | Revealing a file opens the way to it | and leaves unrelated folders closed |

There is no "new folder" button, because there is nothing for it to create. The
way to make a folder is to name a file into one.

## Renaming, and averaging

| # | Feature | Notes |
| --- | --- | --- |
| 378 | Rename a file from the explorer | double-click the name, or the pencil |
| 379 | A rename is also a move | the folders are part of the name, so there is no separate move to write |
| 380 | The language follows the new extension | `.txt` to `.py` highlights as Python without reopening |
| 381 | A file keeps its own name while being renamed | or changing only the case collides with itself |
| 382 | The entry file is not renamable or deletable | the runtime looks it up by name, so both leave nothing to run |
| 383 | `average` combines checkpoints from one run | no training, no data, no hyperparameters |
| 384 | Unequal weights | for leaning on the best checkpoint and smoothing it with its neighbours |
| 385 | Different architectures are refused | the point between two basins is worse than both |
| 386 | `evaluate --checkpoint` measures any file | a soup, a fine-tune, an adapter-merged model |

## Markdown preview

| # | Feature | Notes |
| --- | --- | --- |
| 387 | `.md` files render beside the editor | in place of the terminal, whatever runtime is selected |
| 388 | The renderer is written here, not installed | a markdown library is hundreds of kilobytes to render headings |
| 389 | Headings, lists, quotes, rules, tables | and fenced code with its language |
| 390 | Bold, italic, strikethrough, code spans, links, images | |
| 391 | Everything is escaped, including HTML in the source | the sandbox is a second line of defence, not the first |
| 392 | `javascript:` and `data:` links are refused | the text stays, the link does not |
| 393 | Links open away from the frame | a preview that navigates itself has stopped being one |
| 394 | Code spans are held out of inline markup | `**not bold**` in backticks stays as written |
| 395 | An underscore inside a word is not italic | or every snake_case name turns half a line italic |
| 396 | Pipes without a divider row are a paragraph | so a shell pipeline is not a one-cell table |
| 397 | What it does not do is written down | nested lists, reference links, footnotes, HTML passthrough |

## Generating past the context

| # | Feature | Notes |
| --- | --- | --- |
| 398 | `recycle_context` continues past a full window | the recent tokens are re-read from position zero |
| 399 | Off by default | stopping is the honest answer for a completion that ran out of room |
| 400 | The cost is stated, not hidden | one prefill per recycle, and the beginning of the text is gone |
| 401 | The last decode step is no longer computed | its logits were never read |
| 402 | A checkpoint older than the FIM markers refuses infill | with a sentence, instead of an IndexError from inside the embedding |

## Stopping on text, and comparing files

| # | Feature | Notes |
| --- | --- | --- |
| 403 | Stop sequences on both routes | for a model with no stop token of its own |
| 404 | Matched across the joins between tokens | a sequence can arrive as one token, two, or the tail of one |
| 405 | Text that might be a stop is held back | a streaming caller cannot take back what it has shown |
| 406 | Held-back text is released if nothing matched | |
| 407 | `stop` and `stop_sequences` both accepted | one is what a Messages client sends, the other what most APIs call it |
| 408 | Eight sequences, 64 characters each | every one is searched for after every token |
| 409 | Compare the open file with another | for the copy that drifted, rather than the version that changed |
| 410 | The diff view closes without judging | a comparison is not a proposal to accept or discard |

## Confidence, candidates and notes

| # | Feature | Notes |
| --- | --- | --- |
| 411 | Every token's log-probability is available | under the model's own distribution, before sampling |
| 412 | Nothing is computed when nobody asks | the log-softmax is over the whole vocabulary |
| 413 | `candidates` samples several completions and picks one | the likeliest token at each step is not the likeliest sequence |
| 414 | Scored by mean log-probability, not total | or the shortest candidate always wins |
| 415 | Capped at eight | each candidate is a whole generation |
| 416 | `confidence` in every infill response | what a client would threshold on before showing a suggestion |
| 417 | TODO, FIXME, BUG, HACK, XXX and NOTE collected | a to-do list nothing else ever gathers |
| 418 | A marker counts when a comment opener precedes it | `print("TODO")` is not a task |
| 419 | Markers mid-comment are found | requiring the opener immediately before would miss most real notes |
| 420 | Ordered by how bad, then by file and line | the question is what is worst, not what is where |
| 421 | NOTE is not counted as outstanding work | or the badge means "comments" rather than "things to fix" |
| 422 | Clicking one opens its file at its line | across files, not only the open one |

## Superseding, and recent files

| # | Feature | Notes |
| --- | --- | --- |
| 423 | A newer completion cancels this editor's older one | an obsolete request is not wasted, it is in front of the one that matters |
| 424 | Only from the same source | two editors, or a completion and a chat, are separate conversations |
| 425 | Cancelled between tokens | there is nothing to kill, only a loop holding tensors |
| 426 | A cancelled completion is empty and uncached | half an answer is not the answer to the prompt |
| 427 | The response says it was superseded | so the editor shows nothing rather than "no suggestion" |
| 428 | The count appears in the model card | beside the cache numbers, answering the same kind of question |
| 429 | Each tab identifies itself | two tabs are two carets |
| 430 | The file palette offers recent files first | the file you want next is nearly always one of the last few |
| 431 | Files never opened keep their created order | a file with no recency has nothing to sort by |
| 432 | Recency is separate from the tab strip | tabs are what is open; this includes what has since been closed |

## Running the whole chain

| # | Feature | Notes |
| --- | --- | --- |
| 433 | `serve --threads` | serving usually shares a box with an editor or a training run |
| 434 | The Messages surface reports why generation ended | stop_sequence, max_tokens or end_turn, rather than end_turn always |
| 435 | The matched stop sequence is named | so a client can tell "it finished" from "you cut it off" |
| 436 | What a call did is returned, not stored on the engine | the engine is shared between request threads |
| 437 | A cached answer says it was cached | |

## Split editing, and serving a moving target

| # | Feature | Notes |
| --- | --- | --- |
| 438 | A second editor beside the first | both editable, both writing to the same workspace |
| 439 | It opens on the file you had before | which is almost always the one you want beside this one |
| 440 | Its header picks another file | and closes the split |
| 441 | One set of options for both panes | so the split has no settings of its own to drift |
| 442 | What the split does not do is written down | jump, restore and insert a snippet act on the left pane |
| 443 | `serve --reload` picks up a new checkpoint | for watching a run improve without restarting |
| 444 | A change is acted on only once the file settles | torch.save writes in place, so a growing file is half a checkpoint |
| 445 | The new engine is built before it is swapped in | a request in flight finishes against the weights it started with |
| 446 | A checkpoint that will not load leaves the old one running | stale weights beat a server that stops |

## Reading the model, dropping files, walking problems

| # | Feature | Notes |
| --- | --- | --- |
| 447 | `chat` talks to a checkpoint at the terminal | for the failures no number shows |
| 448 | Earlier turns are replayed as token ids | decoding the turn markers to text drops them |
| 449 | `/reset` forgets the conversation | |
| 450 | `tokens` shows how text is split | with spaces as middle dots and newlines escaped |
| 451 | It warns when decoding does not rebuild the input | a tokenizer that cannot is one that silently changes code |
| 452 | Files dropped on the window are opened | the gesture people try before looking for the dialog |
| 453 | Binary extensions are refused before being read | |
| 454 | Anything over 2MB is refused | a workspace lives in browser storage |
| 455 | A folder dropped by accident stops at fifty | |
| 456 | What was skipped and why is reported | a file that silently does not appear is worse |
| 457 | A dropped name that exists becomes `name-2.ext` | a drop is not a decision to overwrite |
| 458 | F8 and Shift+F8 walk the diagnostics | fixing means not taking your hands off the keyboard |
| 459 | They wrap round | a key that does nothing at the end feels broken |
| 460 | Two problems on one line are one place to go | |

## Keeping your place, and fitting a bigger model

| # | Feature | Notes |
| --- | --- | --- |
| 461 | Open tabs, the active file and the split survive a reload | the work already survived; the place you were in it did not |
| 462 | Recently used files survive too | so the palette is useful on the first Ctrl+P after a reload |
| 463 | A stored session that makes no sense is dropped | the cost of getting it wrong is no tabs; throwing is an editor that will not start |
| 464 | Ids are reconciled against the workspace | an imported workspace has entirely different ones |
| 465 | A split showing the active file closes | two panes on one file only halve the width |
| 466 | Saved on every change, not on unload | a tab closed by a crash is what this is for |
| 467 | `train --checkpointing` recomputes activations | activation memory stops scaling with depth |
| 468 | Gradients are identical either way | tested on gradients, not loss: a lost graph shows the same loss |
| 469 | Never recomputes with a key/value cache | a block that appends to one would append twice |
| 470 | Off unless asked for | a run that fits should not pay a third more time |

## Text transforms

Each of these is a minute of careful editing or a keystroke, and the minute is
the kind that introduces a typo three lines from where you were looking. They
apply to the selection, or to the whole file when there is none.

| # | Feature | Notes |
| --- | --- | --- |
| 471 | Sort lines | naturally, so item9 comes before item10 |
| 472 | Reverse lines | |
| 473 | Remove duplicate lines | keeping the first of each |
| 474 | Remove blank lines | whitespace-only ones included |
| 475 | Trim trailing whitespace | invisible, and in every diff until someone removes it |
| 476 | Join lines | collapsing the whitespace at the joins |
| 477 | Number lines | right-aligned, so the text still lines up |
| 478 | Upper, lower and title case | title case leaves existing capitals alone |
| 479 | To camelCase and to snake_case | `parseHTTPResponse` becomes `parse_http_response` |
| 480 | Format and minify JSON | text that is not JSON is left alone, not replaced with an error |
| 481 | Escape as a JSON string | |
| 482 | Base64 in both directions | through UTF-8, so it survives anything above U+00FF |
| 483 | A trailing newline is kept where it was | a transform that strips it makes every file look changed |
| 484 | `/tokenize` on the model server | the number a client sizing a prompt was guessing at |
| 485 | Pieces only when asked for | a count is small; a piece per token on a long file is not |

## Asking for a better completion

| # | Feature | Notes |
| --- | --- | --- |
| 486 | "Complete here, best of four" | asked for, rather than offered on every pause |
| 487 | Inserted through the editor | so one Ctrl+Z takes it back |
| 488 | `candidates` carried through the gateway | sent only when asked for, so an older model server never sees it |
| 489 | `confidence` carried through the gateway | reported, not acted on |
| 490 | A model that reports no confidence is not an error | an older server, or one answering from its cache |
| 491 | No confidence threshold | measured, it does not separate a good completion from a bad one |

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
- Git integration. Local history is snapshots in the browser, not version control.
- Firecracker microVMs, Kubernetes and GPU execution tiers.
- Installing extensions from a registry. The host loads bundled extensions and
  the contract is public, but there is no marketplace, no download, and no
  sandbox around extension code: an extension runs with the page's privileges.
  Treat the contract as the extension point, not as a security boundary.
- A locally trained model that is useful for real coding help. The pipeline is
  real and the largest configuration is genuinely a billion parameters, but a
  checkpoint trained on one repository for twenty minutes writes text that looks
  like code and means very little. Capability follows corpus and compute.
