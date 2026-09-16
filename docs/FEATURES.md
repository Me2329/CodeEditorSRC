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
| 132 | Seven named sizes, 1.3M to 4.32B | counts derived from the architecture, asserted against real modules |
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
| 195 | 10 language configurations | comments and brackets, registered with Monaco so Ctrl+/ works |
| 196 | JSON formatter that survives malformed input | reformats what it can rather than throwing |
| 197 | Whitespace formatter for every language | indentation, trailing space, final newline |
| 198 | 7 status bar contributions | caret, selection, language, size, line endings, indent, note count |
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

The builtin Text Toolkit's sibling, the snippet pack, contributes forty-nine
across thirteen languages through the extension host. The editor uses that,
rather than a library of its own.

| # | Feature | Notes |
| --- | --- | --- |
| 331 | Snippets come from extensions | so one loaded later appears without the editor changing |
| 332 | Offered in the completion list as you type | prefix matching, not fuzzy: a list that reorders under you is unreadable |
| 333 | Tab stops, defaults and mirrors | `${1:name}` twice fills both from one typing |
| 334 | A palette mode for browsing them | typing a prefix finds what you know; this is for what you do not |
| 335 | Bodies re-indented to your tab size | and to the caret's own indentation, so one inserted inside a function is not flush left |
| 336 | Tabs and four-space indentation both understood | the pack uses spaces; a snippet pasted from elsewhere may not |
| 337 | Every shipped body validated by a test | an unclosed placeholder would insert `${1:` into someone's source |
| 338 | One prefix per snippet per language | two snippets fighting over `for` is a bug, not a preference |
| 339 | Consecutive tab stops enforced | a gap makes Tab land somewhere the author did not intend |
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

## Text transforms, fixed

The Text Toolkit extension has shipped thirty of these since it was written. An
audit for duplicate code found two real bugs in it.

| # | Feature | Notes |
| --- | --- | --- |
| 471 | Sorting keeps the trailing newline | it used to put an empty line at the top and drop the newline |
| 472 | Every line operation goes through one wrapper | they all had the same bug available to them |
| 473 | Title case leaves what is capitalised alone | it used to turn `HTTPServer` into `Httpserver` |
| 474 | A file that is only a newline stays that way | |
| 475 | Every action tested against an empty file | |
| 476 | `/tokenize` on the model server | the number a client sizing a prompt was guessing at |
| 477 | Pieces only when asked for | a count is small; a piece per token on a long file is not |

## Counting tokens

| # | Feature | Notes |
| --- | --- | --- |
| 478 | "Count the tokens in this file" | by the model's own tokenizer, not an estimate |
| 479 | Reported as a share of the context | which is the number that decides whether a prompt fits |
| 480 | On demand, not as you type | a round trip whose answer only changes when the file does |
| 481 | `/api/v1/assistant/tokenize` on the gateway | bounded at a megabyte |

## Recovering a deleted file, and comparable validation

| # | Feature | Notes |
| --- | --- | --- |
| 482 | Snapshots remember the file's name | without it a deleted file's history is an id referring to nothing |
| 483 | A rename leaves older snapshots with the older name | which is what they were |
| 484 | Deleted files are listed in the history panel | with the last snapshot of each |
| 485 | Recovering one makes a new file | the old id is gone, and so is anything that referred to it |
| 486 | A recovered name that is taken becomes `name-2.ext` | |
| 487 | Validation scores the same windows every time | so "keep the best" compares checkpoints, not samples |
| 488 | A different seed scores different windows | fixed within a run, not for all time |

## Everything exported is used

An audit for exports nothing calls turned up five, and each one was a decision
rather than a deletion.

| # | Feature | Notes |
| --- | --- | --- |
| 489 | Ctrl+E switches to the last file | the second entry in the recency list, so the key is a toggle |
| 490 | Jumping to a problem says which of how many | "Problem 2 of 5" |
| 491 | Selecting a file opens the folders on the way to it | a search hit in a closed folder was simply not on screen |
| 492 | "Discard all local history" | the per-file button covered one file at a time |
| 493 | Context budgets and single-file search are no longer exported | they were implementation detail |

## One scan, two presentations

| # | Feature | Notes |
| --- | --- | --- |
| 494 | The TODO linter and the notes panel share one scan | two rules for one thing drift |
| 495 | `print("TODO")` is no longer a diagnostic | the linter had no idea what a comment was |
| 496 | The diagnostic carries the note's text | not just which marker it was |
| 497 | The badge counts each note once | notes in the open file are already among its diagnostics |

## The status bar an extension can change

The host had a status-bar contribution point, an extension contributed seven
items to it, and nothing rendered them. The bar wrote the same facts itself, so
the extension was listed as installed, enabled, and doing nothing.

| # | Feature | Notes |
| --- | --- | --- |
| 498 | Contributed status items are rendered | left and right, in the priority they ask for |
| 499 | In the tone they ask for | warning, danger, accent or plain |
| 500 | The bar no longer writes them itself | an extension that can be turned off now visibly does something |
| 501 | Line endings, with a warning for a file that has both | it usually means two tools disagreed |
| 502 | The file's real indentation, not the preference | the most common leading-space width |
| 503 | The note count uses the shared scan | all three places now agree on how many a file has |
| 504 | Contributed language configurations reach Monaco | Ctrl+/ did nothing in a language Monaco has never heard of |
| 505 | Contributed themes colour the editor | three of them, from an extension that can be turned off |
| 506 | They are defined with Monaco when they arrive | so enabling a theme extension needs no reload |
| 507 | The interface keeps its own theme | a theme contribution can only reach the editor, and pretending otherwise leaves half the window unchanged |
| 508 | A theme that is no longer contributed falls back | rather than leaving Monaco a name it cannot resolve |
| 509 | A dotted contribution id becomes a name Monaco accepts | it refuses anything else by throwing, and the throw took the whole editor down |
| 510 | A render that throws shows a message instead of a blank page | which is what the dotted theme name produced for an hour |
| 511 | It says what threw, and where React said it came from | |
| 512 | Reload first, clear stored state second | most render failures do not survive a remount, and clearing discards work |
| 513 | Clearing covers every key the editor stores, including each extension's | a hatch that clears three of four keys is not a hatch |
| 514 | A test reads the modules and fails if a new key appears | rather than trusting a list written twice |
| 515 | The choice survives the extension being disabled | forgetting it is worse than holding a name that currently resolves to nothing |

## Saying what the numbers mean

| # | Feature | Notes |
| --- | --- | --- |
| 516 | `prepare` says what the validation set is | the tail of the corpus: whole files, not a sample of the training ones |
| 517 | Reloading is testable without a clock | a test that sleeps for it fails on a loaded machine, which is when the suite runs |

## Walking the tree from the keyboard

`flatten` was written so that "keyboard navigation and virtualisation, if
either arrives, work on a list rather than a shape". Navigation arrived.

| # | Feature | Notes |
| --- | --- | --- |
| 518 | Up and down move one visible row | and stop at the ends rather than wrapping |
| 519 | Right opens a closed folder, then steps into it | |
| 520 | Left closes an open folder, then steps out to the parent | the nearest row above at one less depth |
| 521 | Enter and Space use the row | opening a file or toggling a folder |
| 522 | Home and End | |
| 523 | One row focusable at a time | so Tab moves past the tree rather than through every file |
| 524 | Rows carry their tree role and depth | |
| 525 | The cursor is clamped when files are deleted | a cursor past the end focuses nothing and answers no key |

## A dropped folder no longer loses the drop

| # | Feature | Notes |
| --- | --- | --- |
| 526 | Files that will not read are skipped, not fatal | a folder arrives looking like a file and rejects when read |
| 527 | Reported with everything else that was left out | |
| 528 | A drop where nothing reads says so | rather than adding nothing and saying nothing |

## A cache that fires on the files it was built for

| # | Feature | Notes |
| --- | --- | --- |
| 529 | The trimming window holds still for 32 keystrokes | a window that slides by one token per character shares nothing with the last prompt |
| 530 | The editor's own window holds still for 64 characters | both layers have to; either one sliding loses the cache |
| 531 | Rounded up, never down | down would buy context by exceeding the budget |
| 532 | A prompt that fits is not trimmed at all | the stride costs nothing when there is nothing to trim |
| 533 | The sliding case is kept as a negative control | so the test measures the fix rather than agreeing with it |

## The save whose failure matters

| # | Feature | Notes |
| --- | --- | --- |
| 534 | Saving the workspace reports whether it happened | the files are the one thing here that cannot be rebuilt by clicking |
| 535 | A full quota costs local history, not the work | a megabyte and a half of old versions is what stops the files fitting |
| 536 | And says so | silently ceasing to save is how someone loses an afternoon to a reload |
| 537 | A browser that refuses storage entirely says to export | |

## A completion stops where the file did

| # | Feature | Notes |
| --- | --- | --- |
| 538 | Completions stop at the corpus file marker | it is ordinary text in the training data, so the model emits one |
| 539 | A caller's own stops replace the default | passing stops is a decision about where to end |

## Not showing a suggestion that changes the subject

| # | Feature | Notes |
| --- | --- | --- |
| 540 | A completion that starts a new line is refused when the line cannot end | `self.text = ` answered with an import block |
| 541 | And allowed when it can | a caret after `def f():` is where a completion should start a line |
| 542 | The operator set is the one that holds in every language here | an assignment, an open bracket, a comma, an arithmetic operator |
| 543 | The check is opt-in | a caller that passes no prefix gets the behaviour it had |

## Stopping a completion on the shape of the code

| # | Feature | Notes |
| --- | --- | --- |
| 544 | A completion stops before closing a bracket the suffix closes | otherwise accepting it leaves `foo(a, b))` behind |
| 545 | And may close brackets it opened itself | depth is counted relative to the caret |
| 546 | The bracket rule is off when the suffix closes nothing | there the model's closing bracket is the one the code needs |
| 547 | A completion stops when it leaves the caret's block | a line less indented than the caret's line is a different subject |
| 548 | Blank lines before that line go too | a suggestion should not end in trailing newlines |
| 549 | The dedent rule is off at column zero | nothing to fall out of |
| 550 | Brackets inside strings do not count | the caret's own line says which string it is inside |
| 551 | Brackets after a line comment do not count | the editor sends the marker, since only it knows the language |
| 552 | A quote left open at a line end is treated as a mistake | believing it would switch every rule off for the rest |
| 553 | Both rules decide as tokens arrive | generation stops at the token that broke the structure |
| 554 | Trailing whitespace is held back until the line speaks | the line it starts may turn out to be the one that ends the completion |
| 555 | Either rule can be turned off per request | `scope` on `/infill` |
| 556 | The response says why a completion ended | `trimmed` is `dedent`, `bracket`, or nothing |
| 557 | The trimmed and untrimmed answers are cached separately | they are different questions |

## An outline of the file you are in

| # | Feature | Notes |
| --- | --- | --- |
| 558 | The index records what each declaration sits inside | a stack of indentation, kept per file |
| 559 | A method is nested under its class | in braced languages as much as indented ones |
| 560 | Nesting goes as deep as the code does | a function inside a method inside a class |
| 561 | Outline panel under the file tree | the tree says which file, the outline says where in it |
| 562 | The outline is built once and shared with the breadcrumb bar | the index is workspace-wide, so filtering it twice per caret move is twice too many |
| 563 | Declarations in the order they appear | not the order they were indexed |
| 564 | The index records where each declaration ends | the line before the next one indented no further |
| 565 | A closing brace is the last line of what it closes | rather than the line before it |
| 566 | Whatever is still open when the file ends, ends with it | |
| 567 | The declaration the caret is in is marked, and only while the caret is in it | below the last function of a file the answer is nothing |
| 568 | An index that reports no end lines falls back to "runs to the next one" | as does a declaration whose body never arrived |
| 569 | Click a declaration to go to it | |
| 570 | A filter appears once there is enough to filter | five declarations |
| 571 | Filtering keeps the parents of what matched | a method without its class has lost half its name |
| 572 | Marking follows the caret, not the filter | typing in the filter does not move the caret |
| 573 | The outline says why it is empty | an empty list means "nothing declared here", which is a different thing |
| 574 | A refused request is not an absent daemon | telling someone to start one they are already running helps nobody |
| 575 | A repeated container name resolves to the nearest one above | two classes in a file can both have a `save` |
| 576 | A symbol whose container is not in the file sits at the top | |
| 577 | An older daemon that reports no containers still produces a flat outline | the field is optional |

## Asking a checkpoint the same questions every time

| # | Feature | Notes |
| --- | --- | --- |
| 578 | `probe` command | six carets, answered the same way every time |
| 579 | Two checkpoints side by side at every caret | `--compare` |
| 580 | Temperature zero and a fixed seed by default | a difference between rows is a difference between models |
| 581 | Every case starts from the same sampler state | not from wherever the last one left it |
| 582 | Cases can come from a file | `{name, prefix, suffix, line_comment}` |
| 583 | A case with no prefix is refused, by number | so the file can be fixed |
| 584 | Line breaks are printed, not taken | a completion leaving the block is the failure being looked for |
| 585 | Answers count empties and structural cuts | the two numbers that say whether a model is usable at a caret |
| 586 | The same run given twice is numbered apart | identical answers are the determinism check |
| 587 | Answers written as JSON | `--json`, for a comparison worth keeping |
| 588 | `make model-probe`, with `COMPARE=` | |

## Knowing where the caret is

| # | Feature | Notes |
| --- | --- | --- |
| 589 | Breadcrumb bar above the editor | folders, file, then the declarations the caret is inside |
| 590 | The chain is built from the outline | an entry knows its depth, not what it is under |
| 591 | Click a declaration to go to its line | the fastest way out of a long method |
| 592 | A sibling that happens to be shallower is not a parent | a top-level function after a method is not inside its class |
| 593 | Nothing is shown when there is nothing to say | no folders and no enclosing declaration is just the tab strip again |
| 594 | Folders come from the file name | which is where folders live in this workspace |

## Healing the caret

| # | Feature | Notes |
| --- | --- | --- |
| 595 | The prompt is cut back to the boundary before its last token | a caret does not land on token boundaries |
| 596 | The first token is chosen from those beginning with what was removed | so the characters come back |
| 597 | Only the first | after it the model is on a boundary again |
| 598 | What was put back is stripped from the answer | those characters are already in the file |
| 599 | A one-token prompt is left alone | removing it would leave nothing to predict from |
| 600 | A character split across two tokens is left alone | its bytes are not text on their own |
| 601 | Specials are never candidates | a marker about the document cannot be what was typed |
| 602 | Healed and unhealed are separate cache entries | they send different prompts |
| 603 | On by default, `heal: false` to turn it off | `--no-heal` on the probe |
| 604 | Measured: four of six carets answered with nothing without it | the first token the model wanted was a line break |

## Scoring the part the editor asks for

| # | Feature | Notes |
| --- | --- | --- |
| 605 | Held-out loss over the middles alone | the rest of the stream is what the model was given, not asked for |
| 606 | Windows placed at the markers, not sampled | random windows scored 0.2% of what they read |
| 607 | Each window ends a fixed distance after its marker | the first tokens of the answer are all an editor sees |
| 608 | A marker without a whole window of context behind it is skipped | |
| 609 | A second marker inside a window counts too | it is still a middle, with context |
| 610 | Reported as None when the corpus has no middles | which is what a corpus prepared without them looks like |
| 611 | The same checkpoint measures the same way twice | fixed seed, sorted windows |
| 612 | `--infill-windows`, and `--no-infill` to skip the pass | |
| 613 | `--threads` on both measuring commands | a number taken while the machine is training is a number about the machine |
| 614 | Carried in the JSON report | |

## Going to where a name was declared

| # | Feature | Notes |
| --- | --- | --- |
| 615 | Go to definition, F12 or the palette | from the workspace index, not a language server |
| 616 | The name the caret is on, by the editor's own idea of a word | it knows the language's rules, and answers without copying the file |
| 617 | A number is a word but not a name | nothing to go to |
| 618 | The declaration in the file you are in wins | name matching cannot tell two `save` methods apart, and does not pretend to |
| 619 | The declaration the caret is already on is skipped | jumping to the line you are on looks like the key did nothing |
| 620 | Cross-file jumps open the file first | and let the editor swap models before moving the caret |
| 621 | It says how many declarations there were | so a wrong jump is explainable rather than mysterious |
| 622 | A name nothing declares says so | rather than doing nothing |
| 623 | Hovering a name shows its declaration | kind, the line it was declared on, and where |
| 624 | And says how many others share the name | |

## Choosing between several completions

| # | Feature | Notes |
| --- | --- | --- |
| 625 | A candidate is judged finished before it is judged likely | confidence alone does not separate good from bad here |
| 626 | Finished means every bracket and quote it opened is closed | |
| 627 | And that it does not end on a character demanding a right-hand side | `= [` and `sum([1, 2])` come out of the same caret |
| 628 | Trailing whitespace does not decide it | |
| 629 | A bracket inside a string does not count | |
| 630 | Confidence still separates candidates that are equally finished | |
| 631 | Measured: finished-first chose a finished answer at 5 of 6 carets, confidence alone at 2 | from the same four candidates each time |
| 632 | The report says whether what was chosen was finished | the caller cannot see it from the text without redoing the work |
| 633 | `--candidates` on the probe | which switches it from greedy to sampling |

## Every use of a name

| # | Feature | Notes |
| --- | --- | --- |
| 634 | Find every use of the name under the caret, Shift+F12 | a whole-word workspace search, and said to be one |
| 635 | Whole word by default | or `save` would match `saved` and `autosave` |
| 636 | The search panel takes a request from elsewhere | rather than only what is typed into it |
| 637 | Asking twice for the same name is two requests | the request is an object, not a string |
| 638 | A pending replacement is cleared by an incoming request | someone else asked this question; the old answer is not part of it |

## What a request to the assistant may contain

| # | Feature | Notes |
| --- | --- | --- |
| 639 | A workspace sent for symbols or completions is bounded by file count | but higher than one that would be run: nothing here is executed |
| 640 | And by total source bytes, not only file count | |
| 641 | An empty workspace is still a fair question | unlike an execution request, which would have nothing to run |
| 642 | A few hundred files, as dropping a folder in produces, is answered rather than refused | the limit is the size of an index, not of a sandbox |
| 643 | A caret's prefix and suffix are bounded | tokenizing a request must not become the expensive part of answering it |
| 644 | Far above what the editor sends | two thousand characters of prefix, one of suffix |
| 645 | A completion prefix is bounded as the word it is | not as a document |

## Indentation the next editor will disagree with

| # | Feature | Notes |
| --- | --- | --- |
| 646 | A line indented with both tabs and spaces is reported | certain from the source, unlike most style questions |
| 647 | And a line whose indentation disagrees with the rest of the file | |
| 648 | An error in an indentation-scoped language | it is what the interpreter itself refuses |
| 649 | A warning elsewhere | there it is a file that looks different in the next editor that opens it |
| 650 | Indentation inside a string or block comment is skipped | a docstring holding a tab-indented example is not a mistake |
| 651 | Reported once, at the first line that disagrees | one decision, not one per line |

## What a keyword means

| # | Feature | Notes |
| --- | --- | --- |
| 652 | A hover contribution point | given the word and the line it sits on |
| 653 | Every extension registered for the language is asked | two of them may each know something different about `yield` |
| 654 | A hover that throws is skipped | as a linter that throws is |
| 655 | A builtin that explains keywords in Python, JavaScript, TypeScript and Rust | the words whose meaning is not guessable from their spelling |
| 656 | One sentence each | a hover is read in the two seconds before the pointer moves |
| 657 | A keyword in a comment or a string is left alone | there it is prose |
| 658 | Extension hovers and the index's own appear together | a keyword is never also a declaration, so they rarely collide |
| 659 | Turning the extension off removes the hovers | as with every other contribution |

## Not asking a model that is not there

| # | Feature | Notes |
| --- | --- | --- |
| 660 | Inline completion does not ask when no model is running | every pause in typing was spending a round trip to find that out again |
| 661 | A probe that finds no change does not re-render the editor | it repeats every minute, and fires once per keystroke while no model runs |
| 662 | One failed request is enough to stop asking | a 503 is remembered |
| 663 | And the probe retries once a minute while the answer is no | nothing else would ever notice a model being started |
| 664 | No polling at all once the answer is yes | it is a fact that rarely changes in that direction |
| 665 | An answer to an explicit request proves the model is there | whatever the last probe found |

## A size between three and five billion

| # | Feature | Notes |
| --- | --- | --- |
| 666 | An `xxl` preset at 4.32B parameters | 3584 wide, 32 layers, head dimension 128 |
| 667 | Grouped query attention, seven query heads per key/value head | the cache at a 4096 context would otherwise dominate |
| 668 | The count asserted to land between three and five billion | which is what the size was added for |
| 669 | And asserted to need more memory than a desktop has | the table says so and someone will not read the table |
| 670 | What it costs, worked out rather than waved at | 69GB of training state, 52GB per checkpoint, 173GB of tokens |
| 671 | A run that will not fit says so before allocating anything | the allocator does not fail; the kernel kills the process |
| 672 | Measured against the card on a GPU and against physical RAM on a CPU | different questions with different answers |
| 673 | It says what would help, not only that it will not fit | checkpointing, accumulation, and bf16 where it applies |
| 674 | A warning rather than a refusal | the estimate cannot see swap, unified memory, or an offloaded optimiser |

## Sizes for a card rather than a cluster

| # | Feature | Notes |
| --- | --- | --- |
| 675 | An `xxl` preset at 2.29B | runs on one 16GB card in bfloat16, with room for the cache |
| 676 | A `max` preset at 4.32B | the same shape, twice the size |
| 677 | The size table reports what running a model costs as well as training one | the two answers are eight times apart and the same table is read for both |
| 678 | Both asserted to land in the band they were added for | two to three billion, and three to five |
| 679 | A `no` in the fits column is not a flag problem | a size needing several times a card's memory needs more than one card |

## An optimiser whose state does not scale with the model

| # | Feature | Notes |
| --- | --- | --- |
| 680 | Adafactor, written here | a second moment stored as one number per row and one per column |
| 681 | Rebuilt as an outer product at the moment it is needed | the full matrix is never stored |
| 682 | 7,680 numbers instead of 11.5 million, per matrix in the billion-parameter size | |
| 683 | A billion parameters trains in 8.1GB instead of 16.2GB | which is one 16GB card instead of none |
| 684 | Vectors keep an ordinary second moment | a vector has no second dimension to factor along |
| 685 | Update clipping in place of the momentum it does not keep | momentum cannot be factored, and keeping it would undo the saving |
| 686 | Momentum can be turned back on, and then costs a full copy | stated in a test |
| 687 | Moments are float32 whatever the parameter is | a running average in bfloat16 stops moving |
| 688 | Weight decay stays decoupled | as in AdamW, applied to the weights rather than the gradient |
| 689 | The memory estimate knows which optimiser it is estimating | and is checked against what the optimiser really allocates |
| 690 | `sizes --optimizer adafactor` shows the same table under it | |
| 691 | The memory warning names the lighter optimiser and what it would need | rather than only saying no |
| 692 | A checkpoint records which optimiser wrote it | |
| 693 | Resuming with the other one starts its state fresh, and says so | loading one into the other fails somewhere unhelpful |
| 694 | Measured: a billion parameters peaked at 9.4GB against 8.1GB predicted | two real steps, not arithmetic |
| 695 | Checkpoints are written through a rename | a half-written file never replaces a good one |
| 696 | A failed checkpoint write does not end the run | a full disk at the last save would otherwise lose the whole thing |
| 697 | The partial file is removed on failure | gigabytes, on the disk that just proved it had no room |
| 698 | The count of failed writes is in the summary | a run nobody watched is the one where this matters |
| 699 | A size that does not fit names the largest one that does | "no" is a worse answer than "no, and here is the one that would" |
| 700 | And says which optimiser makes it fit | a size that fits only with adafactor still fits |
| 701 | A machine too small for any size is told that plainly | it is a machine for running a model, not training one |
| 702 | The fits column works on a CPU as well as a card | the question is the same and only the number differs |

## Never holding a second copy of the model

| # | Feature | Notes |
| --- | --- | --- |
| 703 | Each parameter is updated the moment its gradient is final | inside the backward pass, through a hook |
| 704 | And its gradient is freed there | peak memory is the weights plus the largest single gradient |
| 705 | 2.29B goes from 18.3GB to 9.5GB | which is a 16GB card instead of none |
| 706 | Measured: a real 2.29B step peaked at 10.8GB | against 9.5GB predicted |
| 707 | Proven identical, not merely similar | with global clipping out of the way, a fused run and an ordinary one give bit-identical weights |
| 708 | Safe because nothing reads a parameter after its own gradient is done | the gradient flowing past a layer is made from its old weights |
| 709 | Global gradient clipping is what it gives up | a norm over every gradient needs every gradient |
| 710 | Adafactor's per-parameter update clipping stands in for it | |
| 711 | Gradient accumulation goes too, and is refused rather than ignored | there is no gradient left to accumulate into |
| 712 | Refused with AdamW, whose extra copies are most of what does not fit | |
| 713 | Refused with a gradient scaler | unscaling needs every gradient at once |
| 714 | `--fused-step` on both training and the size table | |
| 715 | The memory warning offers it as the last thing that would fit | |

## A corpus build that survives being interrupted

| # | Feature | Notes |
| --- | --- | --- |
| 716 | `prepare --resume` continues an interrupted build | a corpus for a 2.29B model is forty-six billion tokens and a day of cloning |
| 717 | Every source consumed is recorded beside the tokens | with the token count that followed it |
| 718 | A partial record from a crash is truncated | a write cut off mid-document is not a whole number of tokens |
| 719 | Sources already read are skipped, and the rest appended | |
| 720 | The tokenizer is fingerprinted, and a mismatch is refused | ids from another vocabulary mean something else beside these |
| 721 | A resumed build keeps the tokenizer already trained | a second sample would give different merges for the same text |
| 722 | The manifest is written after every file | a fraction of a millisecond against a build measured in hours |
| 723 | A finished build leaves nothing to resume | |
| 724 | Without `--resume` a build starts over, as before | |
| 725 | Proven by comparing an interrupted-then-resumed build byte for byte with an uninterrupted one | |

## Reading a run that takes weeks

| # | Feature | Notes |
| --- | --- | --- |
| 726 | `report` command | how far in, still falling, when it finishes, and whether it is memorising |
| 727 | What remains is estimated from the rate this invocation achieved | not from a figure written when it started |
| 728 | Nothing is left to guess when there is no rate to guess from | it says unknown |
| 729 | The trend is taken over a window | two consecutive validation losses are noise |
| 730 | The train/val gap is reported as a number and as a verdict | the number means nothing to someone who has not seen a few runs |
| 731 | The loss curve as one line of blocks | a long run is watched over ssh on a machine with nothing installed |
| 732 | The curve keeps its shape however long the run | an even spread, not the tail |
| 733 | A flat curve does not divide by zero | |
| 734 | Failed checkpoint writes are surfaced here too | |
| 735 | Throughput counts the steps that ran, not the ones that were planned | a run resumed for its last ten of thirty looked three times faster than it was |

## Serving weights at half the size

| # | Feature | Notes |
| --- | --- | --- |
| 736 | `serve --half` holds the weights in bfloat16 | one copy of them is serving's entire budget |
| 737 | 2.29B goes from 9.1GB to 4.6GB, 4.32B from 17.3GB to 8.6GB | which is a 16GB card instead of none |
| 738 | Autocast is switched off once the weights are already narrow | asking for it on top would only add casts |
| 739 | An alternative to `--quantize`, and asking for both is refused | |
| 740 | The engine remembers how it was asked for | |
| 741 | A reload asks for the same thing | a server running narrow weights used to come back at full size hours later |

## The first command to run after installing

| # | Feature | Notes |
| --- | --- | --- |
| 742 | `doctor` answers what this machine can train and what it can run | the numbers are the machine's, not the repository's |
| 743 | The largest size that trains here, with how to make it fit | |
| 744 | And the largest that runs here, which is several sizes further | serving holds one copy of the weights rather than four |
| 745 | The plainest configuration that works is the one recommended | no reason to give up momentum when the ordinary optimiser fits |
| 746 | Disk for two checkpoints and a corpus proportionate to the size | |
| 747 | A disk that cannot hold both says so, and names the choice | a smaller model, or a corpus smaller than the model deserves |
| 748 | The wheel's architecture is checked against the card | a mismatch fails on every kernel launch, hours later |
| 749 | A machine too small for the smallest size is told so | rather than given a number to misread |

## Not materialising what grouped query attention exists to avoid

| # | Feature | Notes |
| --- | --- | --- |
| 750 | Shared key/value heads go to the kernel rather than being copied up | the copy was the tensor GQA exists not to store |
| 751 | 33.6MB a layer, 1.07GB a forward pass at `xxl`'s training shape | 2.15GB at the full context |
| 752 | Bit-identical, tested through the whole model with `torch.equal` | not a tolerance |
| 753 | All three mask cases compared | a full sequence, one token on a cache, a run of tokens on one |
| 754 | 1.36x-1.39x on the isolated attention call, timed on a processor | end to end it is within noise there, and no card was measured |
| 755 | `plan` reports which attention kernel the card actually selects | landing on the unfused one is slow enough to look like a big model |
| 756 | And whether folding the shared heads in costs that kernel | in which case it says to copy them up instead |
| 757 | A backend query that raises is not a yes | asking about cuDNN on a stale driver initialises CUDA and fails there |
| 758 | Off a card the question is not asked | one implementation, so there is no choice to report |

## The constraint memory arithmetic hides

| # | Feature | Notes |
| --- | --- | --- |
| 759 | `plan` times real training steps at the real size | fitting is the easier half; time is what ends runs |
| 760 | Throughput, sustained FLOP/s and peak memory, on this card | not a spec sheet's number |
| 761 | The first steps are untimed | the first allocates every buffer and picks the kernels |
| 762 | Every step synchronises before the clock is read | otherwise it times how fast steps were submitted |
| 763 | What a corpus proportionate to the size costs in days | |
| 764 | `--hours` prices a corpus against the time someone has | |
| 765 | And names the largest size that trains properly in it | `N = sqrt(Ft / 120)` |
| 766 | A verdict on tokens per parameter, in words | proportionate, thin, undertrained, or barely trained at all |
| 767 | Training a size properly costs `120N^2` | four times the compute buys twice the model |
| 768 | An out-of-memory measurement says which flag to change | rather than a CUDA traceback |
| 769 | The fused-step setup is shared with the training loop | so what is measured is what will run |
| 770 | A combination of flags that cannot mean anything prints its fix | not a traceback through code the reader did not write |
| 771 | `doctor` ends by pointing at the command it cannot answer | |

## Renaming a name everywhere it is used

| # | Feature | Notes |
| --- | --- | --- |
| 772 | Rename the name under the caret, F2 or the palette | the third of the family go-to-definition and find-references belong to |
| 773 | It proposes rather than acts | the other two move the caret; this one edits files that are not on screen |
| 774 | Every occurrence listed, with its file, its line and the line's text | |
| 775 | And what each one is part of: code, a comment, or a string | |
| 776 | Code is ticked; prose is listed and left unticked | a name in a comment is usually a mention rather than a use |
| 777 | Per-file tick boxes, tri-state when a file is partly chosen | |
| 778 | The panel says on screen that these are occurrences of the spelling | there is no language server, and the interface says so rather than the source |
| 779 | Whole-word only | renaming `save` must not touch `saved` or `autosave` |
| 780 | A keyword is refused as a name to rename | `def` matches the identifier pattern and occurs in every Python file |
| 781 | And as a name to rename to | `save` to `class` would not compile either |
| 782 | Keywords are per language | `def` is Python's, not JavaScript's |
| 783 | An unknown language gets the control-flow core | refusing costs a message; allowing costs the file |
| 784 | Names must be legal in every language the editor edits | `$` is a letter in JavaScript and a syntax error in C |
| 785 | Edits applied back to front within a file | so a longer replacement does not move the sites not yet written |
| 786 | A site whose text moved since the panel opened is skipped | a preview that writes somewhere else is a preview that lied |
| 787 | Every touched file is snapshotted to local history first | undo in the editor only reaches the file on screen |
| 788 | The on-screen file goes through Monaco, and the caret is put back | one Ctrl+Z takes the whole rename back |
| 789 | Stops at 1000 occurrences | too many to review is too many to rename |
| 790 | The count is shown on open, not a scolding for not having typed yet | |

## Telling code from prose

| # | Feature | Notes |
| --- | --- | --- |
| 791 | A comment and string scanner over 30-odd languages | no parser and no language server: a table and one pass |
| 792 | When it cannot tell, it says code | a mislabelled comment is declined; mislabelled code is silently left behind |
| 793 | The longest delimiter wins, across all three kinds | Lua opens a line comment with `--` and a block comment with `--[[` |
| 794 | Nested block comments where the language nests them | Rust does; C does not |
| 795 | Escapes inside string literals | |
| 796 | Multiline literals where the language has them | Python's triple quotes, JavaScript's backticks |
| 797 | An unterminated single-line literal is treated as code | an apostrophe in prose, or a Rust lifetime, not a string to the end of the file |
| 798 | An unterminated block comment runs to the end | which is what a compiler says about it too |
| 799 | A regular expression literal is not recognised, and is reported as code | telling it from a division needs the parse this avoids |
| 800 | Unknown languages fall back to the C family | a wrong guess costs a label, no guess costs the distinction |

## The render loop, found and fixed

| # | Feature | Notes |
| --- | --- | --- |
| 801 | "Maximum update depth exceeded" reproduced, traced and fixed | it had survived an earlier hunt because it fires about one run in six |
| 802 | The editor's `value` prop is controlled, so the library writes it back | and that write fires the change handler |
| 803 | The handler produced a new array on every echo, so nothing ever settled | new `files`, new `activeFile`, new `content` identity, every turn |
| 804 | It now returns the previous state unchanged when the text already matches | React bails out, and the echo has nowhere to go |
| 805 | The split editor's handler too | the same pattern, written inline |
| 806 | The sequence that triggered it reproduced, and traced to that one line | a repeat run against the fix is still in progress, not yet a clean bill |

## Not implemented

Stated plainly so the list above can be trusted:

- Real-time collaborative editing. The architecture notes describe it; no
  CRDT or presence layer exists.
- Per-tool approval prompts. The agent's safety boundary is plan mode plus the
  sandbox, not a confirmation on each write.
- A debugger. No breakpoints, stepping or variable inspection.
- Package installation inside a run. The sandbox is airgapped, so a program
  cannot fetch dependencies.
- Language servers. Completion, go-to-definition and hover come from the local
  index, which matches names and nothing more: it cannot tell two methods called
  `save` apart, and there are no types, no inference and no cross-file
  resolution beyond the name.
- Git integration. Local history is snapshots in the browser, not version control.
- Firecracker microVMs, Kubernetes and GPU execution tiers.
- Installing extensions from a registry. The host loads bundled extensions and
  the contract is public, but there is no marketplace, no download, and no
  sandbox around extension code: an extension runs with the page's privileges.
  Treat the contract as the extension point, not as a security boundary.
- A locally trained model that is useful for real coding help. The pipeline is
  real and the largest configuration is genuinely 4.32 billion parameters, but the
  checkpoint that exists is 6.5M parameters trained on twenty million tokens of
  real Python, and what it writes at a caret is well-formed and nearly always
  wrong. That has been measured rather than assumed: `core/model/README.md`
  records what it writes at six fixed carets, what six times the corpus changed,
  and why the conclusion is that the binding constraint is the model's size.
