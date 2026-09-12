# CodeCraft LM

A language model built here, from scratch, in Python and PyTorch. The
architecture, the tokenizer, the training loop, the sampler and the weights are
all ours. Nothing in this directory calls a hosted model, and no pretrained
weights are downloaded: a checkpoint exists only because this code trained it on
a corpus you point it at.

The one thing borrowed is a wire format. `serve` exposes a Messages-shaped HTTP
endpoint so the existing Rust assistant client can talk to it unchanged. That is
a JSON schema, not a model.

## What it is

A decoder-only transformer, roughly the shape everything current uses:

| Component | Choice | Why |
| --- | --- | --- |
| Normalisation | RMSNorm, pre-norm | no mean subtraction; the residual stream stays unnormalised end to end |
| Positions | rotary embeddings (RoPE) | attention depends on relative distance, not absolute index |
| Attention | grouped query, causal | fewer key/value heads shrinks the cache that dominates generation memory |
| Feed-forward | SwiGLU | a learned gate per channel beats a plain two-matrix block at equal size |
| Embeddings | tied input and output | saves `vocab × d_model` parameters and helps at small scale |
| Tokenizer | byte-level BPE, trained here | every byte encodes, so there is no unknown token and no lost indentation |

Attention runs through `scaled_dot_product_attention`, which picks the fastest
kernel available. Everything else is written out.

## Sizes

```
$ make model-sizes

size      parameters  d_model  layers  heads   kv   d_ff  context  train RAM
micro           1.3M      128       4      4    2    384      256        0.0G
tiny            6.5M      256       6      8    4    704      512        0.1G
small          32.0M      512       8      8    4   1408     1024        0.5G
base          100.7M      768      12     12    4   2048     2048        1.6G
large         673.3M     1536      24     16    8   4096     4096       10.8G
xl              1.01B     2048      20     16    8   5632     4096       16.2G
```

Those counts are computed from the architecture and checked in the tests against
what PyTorch actually allocates, so the table is not an estimate. `xl` is a real
one-billion-parameter configuration: it instantiates anywhere with the memory,
but training it usefully is a cluster job and a corpus in the hundreds of
billions of tokens, not a laptop and this repository.

Sizes up to `small` train usefully on a CPU. `make model-sizes` adds a "fits"
column when it detects a GPU, comparing each size against that card's memory.

## GPU

Everything picks the best available device on its own. `--device` overrides it:
`auto`, `cuda`, `cuda:1`, `cpu` or `mps`.

```bash
make model-train MODEL_SIZE=base        # uses the GPU if there is one
python -m codecraft_model train --run runs/demo --size base --device cuda
python -m codecraft_model train --run runs/demo --size base --device cpu   # to compare
```

**Precision.** On a card that supports it, training and generation run under
bfloat16 autocast. bfloat16 keeps float32's exponent range and only sheds
mantissa bits, so gradients cannot underflow and no loss scaling is needed;
float32 accumulation still happens inside the matmul. Older cards fall back to
float16, which does need a gradient scaler, and the loop uses one. `--precision`
forces `bf16`, `fp16` or `fp32`.

Weights, gradients and the optimiser's two moments stay in float32. Mixed
precision narrows the matmuls, not the master copy, which is what stops small
updates rounding away to nothing over thousands of steps. So it buys speed, not
memory.

**Also on by default on a GPU.** TF32 for the remaining float32 matmuls, cuDNN
benchmarking, and batches staged in pinned memory and copied asynchronously so
the transfer overlaps the previous step instead of stalling behind it.
`--compile` adds `torch.compile`, which fuses the graph for a further gain and
costs one slow first step. It is opt-in because a failed compile should not cost
you a training run.

### The trap on a 50-series card

An RTX 5080 is Blackwell, compute capability `sm_120`. A PyTorch wheel built for
an older CUDA installs perfectly cleanly on it and then fails on every single
kernel launch:

```
CUDA error: no kernel image is available for execution on the device
```

Nothing warns you at install time. So the model checks the card's compute
capability against the architectures the installed wheel was actually built for,
and prints the wheel to install when they do not match, before doing any work.

You need CUDA 12.8 or newer:

```bash
pip install torch --index-url https://download.pytorch.org/whl/cu128
```

Confirm with `python -c "import torch; print(torch.cuda.get_arch_list())"`. The
list has to contain `sm_120`.

### What fits in 16 GB

Training holds four float32 copies of every parameter: the weights, their
gradients, and Adam's two moments. That is 16 bytes per parameter before a
single activation.

| size | parameters | fixed cost | on a 16 GB card |
| --- | --- | --- | --- |
| small | 32.0M | 0.5 GB | comfortable, large batches |
| base | 100.7M | 1.6 GB | comfortable, the sensible target |
| large | 673.3M | 10.8 GB | tight; needs a small batch and accumulation |
| xl | 1.01B | 16.2 GB | does not fit for training |

`xl` loads and generates on a 5080 without trouble, in bfloat16 it is about
2 GB of weights. Training it is the problem, and the answer is not a bigger
batch trick: it genuinely needs more memory than the card has. `large` is the
ceiling for full fine-tuning on one 16 GB card, and only with a small batch and
gradient accumulation making the effective batch back up.

The real limit is the corpus, not the card. A 100M-parameter model wants
billions of tokens to be worth its size.

## Building a large corpus

`prepare` streams: it reads one file at a time and writes tokens straight to
disk, so the corpus can be far larger than memory. Two flags matter at scale.

`--allow-dir` includes directories that are deliberately skipped when scanning a
project. Inside your own repository `site-packages` and `node_modules` are noise;
when the goal is a large corpus of real library code they are most of the point.

`--sample-mb` caps how much text the tokenizer is trained on. A vocabulary
learned from a representative sample is essentially the one learned from the
whole corpus, because the merges that matter are the frequent ones and those
appear early. `--sample-stride` takes every nth file so the sample spans the
tree rather than whichever directory sorts first.

```bash
python -m codecraft_model prepare --run runs/big \
  --vocab 16384 --sample-mb 24 --sample-stride 3 \
  --allow-dir site-packages node_modules \
  --roots /usr/lib/python3.11 /usr/include ~/.cargo/registry ../..
```

That produced 19.1M tokens from 6,545 files and 67 MB of source, in 89 seconds
end to end. For comparison, scanning only this repository gives 210k tokens.

Point it at more and it keeps going. Cloned repositories, a language's standard
library, a package cache: anything on disk with a source extension.

### Billions of tokens, on a disk that could not hold them

The arithmetic that makes this possible: a token is two bytes. The source it
came from is not.

```
$ python -m codecraft_model corpus

        tokens   source text  repositories  tokens on disk   peak, streaming
----------------------------------------------------------------------------
         10.0M         0.0GB         0.1GB           0.0GB             0.0GB
        100.0M         0.3GB         1.1GB           0.2GB             0.3GB
         1.00B         3.5GB        10.5GB           2.0GB             2.5GB
        10.00B        35.0GB       105.0GB          20.0GB            25.2GB
```

A billion tokens is 2GB of tokens, 3.5GB of source text, and about 10.5GB of
repositories once tests, assets and generated files are counted. Keeping every
repository would need 12.5GB free; streaming needs 2.5GB, because `prepare`
clones one repository, encodes it, deletes it, and moves to the next.

```bash
python -m codecraft_model prepare --run runs/huge \
  --vocab 32768 --sample-mb 40 \
  --repos-file corpora/big-code.txt \
  --max-tokens 1000000000
```

`corpora/big-code.txt` is a list of 47 repositories, largest first so that a
token budget cutting the run short still leaves a broad corpus rather than
whatever sorted first. `--repos` takes them on the command line instead.

Clones are shallow. History is bandwidth spent on text the model never sees, and
a repository's past revisions are near-duplicates of its present, which is
training data that teaches nothing. The `.git` directory is deleted immediately
after checkout, before the files are read, because pack files are a large share
of a shallow clone and hold nothing readable.

A repository that cannot be fetched is skipped rather than fatal: a corpus built
from fifty should not be lost to one that has been renamed. Each clone is
deleted even if encoding raises, so a failure does not leave the disk full and
block everything after it.

The split at the end renames rather than copies. Validation is written as the
tail, then the combined file is truncated in place and becomes the training
file. At a billion tokens that is the difference between a 2.1GB peak and a 4GB
one.

### A billion tokens, measured

Not extrapolated. This ran on four CPU cores with 20GB free:

| | |
| --- | --- |
| Tokens | 1,000,004,906 |
| Files | 292,563 |
| Source text read | 2,912,573,894 characters, 2.9GB |
| Compression | 2.913 characters/token, 32,768-token vocabulary |
| **On disk** | **2.00GB** (`train.bin` 1.9GB, `val.bin` 0.1GB, tokenizer 426KB) |
| Wall clock | 2,123s end to end, about 35 minutes |
| Repositories needed | 34 of 47, the budget stopped it early |
| Repositories that failed | 1, skipped without stopping the run |
| Peak extra disk | about 3GB |

Cloning ran at roughly 43MB/s and was never the bottleneck. Encoding was, at
1.4MB/s in pure Python, which is the 35 minutes. It is paid once.

The corpus is `corpora/big-code.txt`: LLVM, the Linux kernel, Swift, MySQL,
OpenSSL, FFmpeg, QEMU, Rust, CPython, NumPy, Go, Kubernetes, TypeScript, Node,
React and the rest, plus this machine's Python standard library, C headers and
cargo registry.

Decoding a window from the middle of the training file gives back real code,
which is the check that matters:

```c
	struct iwl_mld_session_protect *session_protect =
		&mld_vif->session_protect;
	struct iwl_session_prot_cmd cmd = {
		.action = cpu_to_le32(FW_CTXT_ACTION_REMOVE),
	};

	lockdep_assert_wiphy(mld->wiphy);
```

Training against it was verified end to end: 40 steps of `small` over the 1.9GB
memory-mapped file, loss falling from 10.49 to 6.64. Doing it properly is a GPU
job, not four cores.

### The tokenizer had to be rewritten for this

The first BPE trainer recounted every adjacent pair across the whole corpus on
every merge. That is O(corpus) per merge, so the work grows with corpus size
times vocabulary size, and it becomes unusable somewhere around a few megabytes:

| corpus | merges | before | after |
| --- | --- | --- | --- |
| 3.3 MB | 500 | 22.9s | 3.0s |
| 3.3 MB | 1,000 | 43.8s | 3.2s |
| 3.3 MB | 4,000 | ~176s (extrapolated) | 4.2s |

Counts are now maintained incrementally. A pair-to-words index means a merge
only revisits the words containing that pair, each contributing the difference
between its pairs before and after, and a lazy heap finds the most frequent pair
without a scan. Entries go stale as counts change and are recognised on pop by
disagreeing with the live count, which is cheaper than keeping the heap exact.

The result is roughly flat in vocabulary size rather than linear in it. Training
16,384 merges on 24 MB now takes 52 seconds.

## Long runs

A real run is measured in hours, so it has to survive being interrupted.

```bash
python -m codecraft_model train --run runs/big --size base \
  --steps 60000 --batch 24 --block 1024 --lr 3e-4 --warmup 2000 \
  --compile --max-hours 8
python -m codecraft_model train --run runs/big --size base --steps 60000 --resume
```

`--max-hours` stops on a wall-clock budget, but only after finishing the step in
progress and evaluating and checkpointing it, so nothing since the last
evaluation is lost. `--resume` continues from `latest.pt`, restoring the
optimiser's moments as well as the weights: without them the first steps after a
resume are effectively unwarmed and the loss visibly jumps.

Two checkpoints are kept. `model.pt` is the best validation score seen, which is
what you serve. `latest.pt` is wherever the run actually is, which is what you
resume from. They are different files because the best model is usually not the
most recent one.

### A recipe for a 16 GB card

`base` is the size worth your time: 100M parameters, 2048 context, 1.6 GB of
fixed cost leaving plenty of room for a real batch.

```bash
make model-prepare MODEL_RUN=runs/big     # point --roots at everything you have
make model-train MODEL_SIZE=base MODEL_STEPS=60000 MODEL_RUN=runs/big
```

Ballpark on a 5080, at roughly 60k tokens per second in bfloat16 with
`--compile`: 24 x 1024 is about 25k tokens per step, so 60k steps is about 1.5B
tokens in seven to eight hours. That is around 15 tokens per parameter, close to
the ratio a model that size actually wants. Getting there needs a corpus of a
billion tokens or more, which means cloning a lot of repositories, not scanning
one.

If you have less corpus than that, train a smaller model rather than doing more
passes over the same text. More epochs on a small corpus buys memorisation, not
capability, and the validation curve says so plainly.

## Pipeline

```bash
make model-prepare                     # corpus, tokenizer, token stream
make model-train MODEL_SIZE=micro      # a checkpoint
make model-sample PROMPT="def parse("  # generate
make model-serve                       # HTTP on :8940
```

Or directly:

```bash
python -m codecraft_model sizes
python -m codecraft_model prepare --run runs/demo --roots ../../backend ../../core --vocab 4096
python -m codecraft_model train   --run runs/demo --size micro --steps 4000 --lr 8e-4
python -m codecraft_model sample  --run runs/demo --prompt "def parse("
python -m codecraft_model serve   --run runs/demo --port 8940
```

A run directory holds everything about one model: `tokenizer.json`,
`train.bin` and `val.bin`, `meta.json`, `model.pt` and `training.json`. It is
gitignored, because it is reproducible from the two commands above.

### prepare

Walks the roots, keeps files with a source extension inside a size window that
decode as UTF-8, and skips `node_modules`, `target`, `__pycache__` and the
rest. Files are joined with a `<|file|>` marker so the model learns where one
ends. Then a byte-level BPE vocabulary is trained on that text and the whole
corpus is encoded to a flat array of `uint16`.

### train

AdamW with decoupled weight decay applied only to matrices, never to norm gains,
a cosine schedule with linear warmup, gradient accumulation, and gradient
clipping. Validation runs periodically and only an improved checkpoint is
written. `training.json` records the loss curve, the throughput and the token
count.

Batches come from a memory-mapped token file, so the corpus never has to fit in
RAM and a batch is a slice rather than a parse.

### sample

Temperature, top-k, top-p, min-p and a repetition penalty, with a key/value
cache so each token costs one step instead of a re-read of the prefix. Tokens
stream as they are produced.

min-p is the one worth knowing about. top-p keeps the smallest set of tokens
whose probabilities sum past a threshold, which adapts to confidence but badly
at the extremes: when the model is very sure, top-p still admits a long tail of
near-zero candidates in order to reach its sum, and eventually one gets picked.
min-p instead keeps everything within a fraction of the most likely token, so
after `def ` it leaves almost nothing to choose from and mid-comment it widens
on its own. It is off by default, because changing sampling silently would make
two runs of the same checkpoint incomparable.

### serve

```
POST /v1/messages   Messages-shaped, streaming or not
POST /generate      native: a prompt in, tokens out
GET  /health        the model card
GET  /v1/models     what this server is serving
```

Text is emitted through an incremental UTF-8 decoder, so a character split
across two tokens arrives whole rather than as two replacement characters.
Generation is serialised behind a lock: PyTorch releases the GIL, so two
concurrent requests would genuinely contend for a machine sized for one.

## Using it as the assistant's model

The Rust assistant client reads `ANTHROPIC_BASE_URL`, so the local model drops
in with no code change on either side:

```bash
make model-serve &                          # :8940
export ANTHROPIC_BASE_URL=http://127.0.0.1:8940
export ANTHROPIC_API_KEY=local              # the local server does not check it
make assistant-daemon
```

The daemon sends fields this server does not implement (`thinking`,
`output_config`, `context_management`); they are ignored rather than rejected.
What comes back is the same event sequence the client already parses.

`make model-verify` does the whole thing and checks it: it starts the model
server, starts the daemon pointed at it, asks for a completion over the daemon's
Unix socket, and fails if the daemon reports the model unreachable or the reply
comes back empty.

```
daemon reports model 'codecraft-local', reachable: True
65 tokens in 318ms, from local weights
```

## Two real runs, and what changed between them

Both trained by this code on this machine, four CPU cores, no GPU. The only
difference that matters is the corpus.

| | small corpus | large corpus |
| --- | --- | --- |
| Corpus | 210,459 tokens, this repository | 19,106,483 tokens, 6,545 files, 67MB |
| Sources | `backend`, `core`, `frontend/src`, `scripts` | the above plus the Python standard library, the C headers, the cargo registry |
| Vocabulary | 4,096 | 16,384 |
| Compression | 3.65 characters/token | 3.516 characters/token |
| Model | 1.3M parameters, context 256 | 8.6M parameters, context 512 |
| Training | 3,000 steps, 12.3M tokens, 1,283s | 1,500 steps, 12.3M tokens, 2,811s |
| Passes over the corpus | 60 | 0.68 |
| Best validation loss | 4.968 | 4.217 |
| **Bits per character** | **1.964** | **1.730** |

Bits per character is the comparison that means anything here. Loss per token is
not comparable across two different vocabularies, because a 16,384-token
vocabulary is a harder prediction than a 4,096-token one; dividing by
characters per token removes that and gives a number you can put side by side.

The shape of the two curves is the real result:

| step | small corpus | large corpus |
| --- | --- | --- |
| 250 / 200 | 6.312 | 5.716 |
| 1,250 / 1,100 | **4.968** (best) | 4.351 |
| 1,500 | 5.062 | 4.351 |
| 3,000 / 1,500 | 5.144 | **4.217** (best) |

The small-corpus run bottomed out a third of the way in and got worse from there
while its training loss kept falling to 1.35. Sixty passes over 200k tokens is
memorisation, and the validation curve says so.

The large-corpus run never turned. Validation improved at every single
evaluation and was still improving when the step budget ended, with training
loss around 3.2 against validation 4.2. It never saw the same token twice: at
0.68 passes there is nothing to memorise. It stopped because it ran out of
steps, not because it ran out of things to learn.

What it writes, prompted with `def parse(`:

```rust
def parse(self, name) -> fmt::Result {
        let value = self.value.end() {
            let result = input.parse().unwrap();
            if len > self.value.len() {
                let mut buf = input.parse()?;
```

It drifts into Rust because the cargo registry is the largest part of the corpus,
and the Rust it writes is structurally right: `fmt::Result`, `let mut`, the `?`
operator, `formatter.field`. Prompted with `#include <stdio.h>` it produces a run
of glibc-style include lines. It has learned each language's shape and the
statistics of real library code. It is still an 8.6M-parameter model that saw
12M tokens, which is under two tokens per parameter, so it does not hold a
thought across more than a few lines.

The honest reading: the corpus fixed overfitting, which was the actual problem.
Capability now needs the thing this machine does not have, which is compute, and
more corpus still. Both curves came from four CPU cores.

## What it is not

CodeCraft LM is a base model: trained on next-token prediction and nothing else.
No instruction tuning, no RLHF, no refusal training, no content filter, no
system prompt. There is no safety layer to switch on or off, and a flag claiming
otherwise would toggle a variable no code reads.

The risks that are real are the ordinary ones: confidently wrong code, insecure
patterns learned from public source, memorised fragments, and licence
contamination from a corpus spanning GPL, Apache and MIT. That last one is the
practical problem for anything you intend to ship.

The boundaries that genuinely hold in this project are the sandbox and agent
plan mode, and they protect your machine from code rather than filtering text.
[MODEL_CARD.md](MODEL_CARD.md) sets all of this out properly.

## Teaching it to answer rather than continue

```bash
python -m codecraft_model finetune --run runs/big --examples examples/instructions.jsonl
```

A base model does not know it is in a conversation. Fine-tuning is more
next-token prediction on examples shaped like question then answer, with the
loss computed on the answer only.

The mask is the whole mechanism, and the alignment is the part that bites.
Labels are shifted by one, because the logits at position i predict the token at
position i+1. Align them position for position and the model learns to predict
the token it has already been shown, which it picks up instantly and which
teaches it nothing.

That bug was in the first version here, and the model said so plainly: after
fine-tuning, its first output was its own stop token, every single time. Worth
knowing what the symptom looks like, because the loss curve gives no hint. It
fell from 2.4 to 0.86 while learning nothing.

### What twelve examples actually bought

Fine-tuned on `examples/instructions.jsonl`, twelve examples, 150 steps.

A prompt it was trained on:

```
write a function that adds two numbers

def add(a: int, b: int) -> int:
    return a + b
```

Correct, and it stopped on its own after twenty tokens rather than running to
the budget. Before fine-tuning, the same prompt produced Rust documentation
comments.

A prompt it was not trained on:

```
multiply two numbers together

def
      // This is a string to the same as a string.
      void _M(const char* const char* ...
```

So: it reproduces what it was shown, it learned the format, and it learned to
stop. It did not learn the task. That is exactly what twelve examples on an
8.6M-parameter model should do, and pretending otherwise would be the easiest
kind of self-deception here. Instruction tuning wants thousands of examples,
and the format is what this code provides.

## Fine-tuning without a second copy of the model

Full fine-tuning updates every weight. The optimiser then holds two more copies
of the model, the result is another checkpoint the same size as the first, and a
machine with room to serve a model may have no room to train one.

A low-rank adapter replaces the update with a product of two thin matrices. A
weight of shape (out, in) is corrected by B @ A, with A of shape (rank, in) and
B of shape (out, rank), so the trainable count is proportional to the rank
rather than to the layer.

```bash
codecraft_model finetune --run runs/demo --examples examples/instructions.jsonl --lora 8
codecraft_model serve --run runs/demo --adapter runs/demo/adapter.pt
```

Measured on the demo checkpoint at rank 8, adapting the query and value
projections of every block:

| | full | adapter |
| --- | --- | --- |
| Trainable parameters | 1.3M | 14.3K (1.1%) |
| File written | 15.8MB | 63KB |
| Base checkpoint | replaced | untouched |

Two properties make this practical rather than merely small. B starts at zero,
so an adapter that has learned nothing is *exactly* the base model and training
begins with no discontinuity. And the correction is linear, so a trained adapter
folds into the base weights and is served by code that knows nothing about
adapters: `--adapter` merges on load, and the merged model gives the same
numbers to within floating-point noise. Both are tests rather than claims.

Freezing happens inside `apply_lora` rather than being left to the caller. An
adapter over an unfrozen model is full fine-tuning with extra steps, and the
symptom is a run that looks fine and a checkpoint that is wrong. Merging
unfreezes again, for the mirror-image reason: a merged model that is still
frozen reports the parameter count of whatever the adapter touched, and a later
full fine-tune would silently train four projections and nothing else.

## A checkpoint that loads without unpickling

```bash
python -m codecraft_model export --run runs/big
python -m codecraft_model export --run runs/big --quantize
```

`torch.save` uses pickle, and unpickling runs code. That is fine for a file you
produced and wrong for one you downloaded, which is what a model checkpoint
usually is. `weights_only=True` narrows the problem without changing the
format's shape: it is still a pickle, and the guarantee is a denylist someone
else maintains.

This format has nothing in it to execute. Eight bytes of magic, an eight-byte
length, a JSON header, then raw tensor bytes aligned to 64 so a reader can
memory-map and slice without copying. Loading is a read and a reshape.

The header is readable with the standard library alone:

```python
magic = file.read(8)
(length,) = struct.unpack("<Q", file.read(8))
header = json.loads(file.read(length))
```

Verified against the billion-token checkpoint: every weight is bit-identical
and the logits match exactly. 51.3MB against 103.5MB for the pickle, because
that one also carries optimiser state.

## A second run, on six times the data

The first fill-in-the-middle run saw three million tokens six times over. The
second saw twenty million, from 6,792 files across twenty real Python projects,
with the same 6.5M-parameter model so the corpus was the only thing that
changed. 6000 steps, 24.6M tokens seen, 76 minutes on four CPU cores, and still
improving when the schedule ended: 3.719 at step 3400, 3.504 at 6000.

The validation losses of the two runs are not comparable, for the reason in the
next section: different corpora mean different held-out projects. What can be
compared is what each writes at the same caret.

```
    return ⟨here⟩          3M corpus:  , re.match(b)
                          20M corpus:  \n\nfrom pydantic import BaseModel, Field,

    print(⟨here⟩)          3M corpus:  a list of the list of the same as a list of
                          20M corpus:  \n* [`@example.com`](https://github.

    self.text = ⟨here⟩     3M corpus:  , _text, _texts, _text = _text.text,
                          20M corpus:  <|file|>test_tutorial001_py310.py
```

Neither is usable, and the second is not obviously better than the first. More
data made it repeat itself less and wander further: it now produces well-formed
lines from somewhere else in its training data rather than degenerate ones from
nowhere. Six and a half million parameters is the binding constraint, and the
next thing to change is the model rather than the corpus.

### What resuming it costs, and what it buys

The obvious next thing was more steps, so the run was resumed from 6000 with the
budget raised to 14000. The first thing that happened was that validation got
worse:

| step | validation loss |
| --- | --- |
| 6000, where the first schedule ended | 3.504 |
| 6200 | 3.618 |
| 6600 | 3.598 |
| 7200 | 3.563 |

Resuming restarts the learning-rate warmup, and a fresh schedule spends its
first several hundred steps undoing some of what a decayed one settled into.
The loss recovers from there, but a thousand steps of the new budget went on
getting back to where the old one already was. A resume is not free, and a run
that will be resumed is better off being given the longer schedule to begin
with.

The gap between the two losses is the more interesting number. Training batches
sit between 1.8 and 2.4 while held-out text sits near 3.5: a model a nat and a
half better on what it has seen than on what it has not is learning the corpus
as much as the language. Which is what the size argument above predicts, and
what makes more steps the least promising of the things left to try.

The third of those answers was a real find rather than a bad sample. The corpus
writes `<|file|>name` ahead of every document as ordinary text, not as a special
token, so the model learned it as the string that follows the end of a file and
emits one when it thinks the file is over. A completion that reaches it has left
the file it was completing, so it is now where a completion stops. That caret
answers with nothing at all now, which is the correct answer and what the editor
already knows how to show.

## What the validation number is

The corpus is split by truncation: the last 5% of the token stream is the
validation set. When the corpus is built repository by repository, that means
validation is the *last repositories cloned*, in their entirety.

This is the strict version of the test. There is no near-duplicate leakage
between training and validation, which a random split of windows cannot promise
for code, where the same file often appears twice in a corpus with two lines
changed.

It also means the gap between training loss and validation loss is mostly the
difference between one project and another, not memorisation. The second
fill-in-the-middle run reads 2.77 on training and 4.11 on validation at step
1600, and the obvious reading of that pair is "it is overfitting", which would
lead to adding dropout that is not needed.

The way to tell the two apart is to score the same checkpoint on windows drawn
from the training half and from the validation half with the same settings.
At step 1800:

| windows from | loss | perplexity |
| --- | --- | --- |
| the training projects | 2.7264 | 15.3 |
| the held-out projects | 4.1731 | 64.9 |

With one caveat stated rather than buried: at that point the run had drawn about
a third as many windows as the training split contains, so some of the
training-side windows had been seen before and some had not. That confounds the
size of the gap and not its direction. A model trained on Flask and Click does
not predict the internals of a cryptography library, which is true of larger
models too.

Two consequences worth knowing:

  - Validation numbers are comparable within a run and not between runs on
    different corpora. The first run's 2.577 and the second's 4.107 are
    measurements of different things.
  - A corpus assembled one project at a time should be assembled in an order
    where the last few projects are ones worth being measured on.

`prepare` now says this rather than leaving it to be worked out from the split
point.

## The fill-in-the-middle run, finished

4200 steps on 3.0M tokens of Python, 6.5M parameters, on four CPU cores:

| | validation loss | perplexity |
| --- | --- | --- |
| step 1019, where the first hour ended | 2.859 | 17.4 |
| step 1600 | 2.769 | 15.9 |
| step 4000, the best | 2.577 | 13.2 |

Still falling when the schedule ended, which says the corpus has more in it than
this model has taken.

What it writes at a caret, greedily, with the markers it was trained on:

```
    return ⟨here⟩            ->  , re.match(b)
    print(⟨here⟩)            ->  a list of the list of the same as a list of
    self.text = ⟨here⟩       ->  , _text, _texts, _text = _text.text,
```

The first is the shape of an answer. The rest are not, and repeating a phrase
is what a model this size does when it has nothing better. Six and a half
million parameters trained for three hours on three million tokens is a model
that has learned what Python looks like and not what it means, and no amount of
sampling arranges that into a useful suggestion.

Everything around it — the caches, the superseding, the stop sequences, the
best-of selection — is measured and works. The model is the part that needs a
bigger corpus and a longer run, which the pipeline is built to give it.

## Fitting a model that does not fit

Training keeps every block's activations from the forward pass so the backward
pass can use them. At a long context those dwarf the weights, the gradients and
the optimiser state together, and they scale with depth: a model twice as deep
holds twice as many.

```bash
codecraft_model train --run runs/x --checkpointing
```

`--checkpointing` keeps only each block's input and recomputes the rest when the
gradient arrives. Measured on a 12-layer, 512-wide model at a context of 1024
with a batch of 4, in two separate processes so the peak is each run's own:

| | peak memory | seconds per step |
| --- | --- | --- |
| Off | 4625 MB | 120.2 |
| On | 2285 MB | 127.5 |

Half the memory. The 6% on time is this machine's answer rather than the
general one: the usual figure is nearer a third, and this run was on a
contended CPU where the extra forward pass overlapped with waiting for memory.
On a GPU, expect to pay more time than this table suggests and to get the same
memory back.

Tested on gradients rather than on loss. The loss is computed in the forward
pass either way, so a bug that lost the graph would show an identical loss and
wrong gradients. It never recomputes while a key/value cache is in play, even in
training mode: recomputation runs the block twice, and a block that appends to a
cache would append twice.

## Reading a model rather than measuring it

```bash
codecraft_model chat --run runs/fim
codecraft_model tokens --run runs/fim --text "def parse(text):"
```

Everything else here measures a checkpoint. `chat` is for reading one, which
catches the failures no number shows: a model that learned the format and none
of the task, or one that answers and then keeps going.

Writing it found a bug in it. The first version built each turn by rendering the
instruction prompt and decoding it back to text, which is the obvious thing to
do and silently wrong: the turn markers are special tokens and `decode` drops
them, so the model was asked the question with no format around it at all. The
prompt is built as token ids now, and `stream` takes them directly.

`tokens` shows how text is split, with spaces as middle dots and newlines
escaped, because whitespace is where a split is most often surprising:

```
73 characters, 20 tokens, 3.650 characters per token

   327  def
  1842  ·parse
    46  (
   512  text
   307  ):
   268  \n···
```

Nearly every surprise about what a model does with a prompt turns out to be a
surprise about how the prompt was split.

## Serving a model that is still training

Training writes a new checkpoint whenever the validation loss improves. A server
started before that keeps the old weights until somebody restarts it, so the
obvious way to watch a run get better is to keep restarting the thing you are
testing with.

```bash
codecraft_model serve --run runs/fim --reload 5
```

Watching the file is easy; doing it safely is the part worth writing down. A
checkpoint being written is a checkpoint that is half there, and `torch.save`
writes in place rather than atomically, so the only signal available from
outside is that the file has stopped changing. A change is therefore acted on
only after the file has looked identical for a whole poll interval, which costs
one interval of latency and removes the entire class of problem.

The new engine is built completely before it is swapped in, so a request in
flight finishes against the weights it started with. A checkpoint that fails to
load leaves the old engine running: a server answering with slightly stale
weights is better than one that stops.

## Running the whole chain

Every piece above was tested on its own. Running them together found two things
no unit test would have.

```bash
codecraft_model serve --run runs/fim --port 8941 --threads 2
CODECRAFT_MODEL_URL=http://127.0.0.1:8941 uvicorn app.main:create_app --factory --app-dir backend
```

Measured through the gateway, on the FIM checkpoint, completing at a caret:

| request | tokens | time |
| --- | --- | --- |
| First | 12 | 171ms |
| The same one again | 0 | under 1ms |
| One character later | 12 | 91ms |

The second is the response cache and the third is the prefix cache, both through
three layers of code that had only ever been exercised separately.

Superseding, measured the same way: a request for 400 tokens was cancelled after
144 when a second request from the same editor arrived a second later. The first
returned empty with `superseded: true`; the second answered in 55ms instead of
waiting out the three seconds the first had left to run.

### What it found

`serve` had no way to limit its CPU threads, so it took every core on a machine
that was also training. It has `--threads` now.

And the Messages surface reported `end_turn` whatever happened, including when a
stop sequence ended the generation, so a client could not tell "it finished"
from "you cut it off". It now reports `stop_sequence` with the one that matched,
`max_tokens` when the budget ran out, and `end_turn` otherwise.

Fixing that turned up something worse. "What the last call did" was kept on the
engine, which is shared between request threads, so two concurrent requests
could read each other's answer. The information a caller needs now goes into a
dictionary it passes in.

## What confidence turned out to be worth

Every completion comes back with a mean log-probability, and the obvious thing
to do with it is refuse to show a suggestion that scores too low. Measured on
this checkpoint, that would be a threshold that does nothing:

| prompt | confidence | what it wrote |
| --- | --- | --- |
| `return ` in a two-argument function | -1.759 | ` 0x08 -> int:` |
| `return json.` after opening a file | -2.301 | a comment about added code |
| `print(` inside a loop | -1.641 | a hex escape |
| `self.text = ` in a constructor | -1.797 | `, _text, _texts, _text = _` |
| `xqzzy qqq ` | **-0.995** | a hex escape |

The highest score of the five went to the prompt that is not code at all. The
number is real and it is reported, because a client may have a use for it and
because it is what best-of-n selects on, where it is comparing several
completions of *one* prompt rather than comparing prompts. Filtering on it
across prompts would be a knob that looks like it is working.

## Tried, measured, and not kept

Two ideas that looked right and did not survive contact with a measurement. They
are here because the reasoning behind each is still sound and a larger model may
well revisit them, and because a record of what was rejected is worth as much as
the list of what was kept.

**A confidence threshold on inline suggestions.** Every completion comes back
with a mean log-probability, so the obvious move is to refuse to show one that
scores too low. Measured across five prompts, the highest score of all went to
`xqzzy qqq `, which is not code, and the four real prompts scored below it. The
number is real and it is reported, but it separates completions of one prompt
from each other, not one prompt from another. The table is above.

**A file-name marker in the caret prompt.** The corpus marks every document with
`<|file|>name` before it is rearranged for fill-in-the-middle, so most training
examples begin with a file name, and the prompt an editor sends has none. Adding
it back should give the model the language for free. On the checkpoint here it
changed the answers without improving them: one case got worse, one got slightly
more code-like, one was a wash. Three cases is not evidence, and shipping a knob
on that basis is how a codebase fills up with options nobody can evaluate.

## Abandoning work nobody wants

An editor sends a completion request per pause in typing. If the user keeps
typing, the answer to the previous one is already wrong by the time it arrives.
The client abandons it; the server did not, and went on holding the model's lock
for a suggestion nothing would show.

That is worse than waste. Generation is serialised, so an obsolete request is not
merely wasted, it is *in front of* the one that matters: a three-keystroke burst
could leave the useful request waiting behind two dead ones.

A newer request now cancels the older one from the same source. Not every older
one: two editors, or a completion and a chat, are separate conversations and
neither supersedes the other, which is what the `X-Request-Source` header is
for. A cancelled generation stops between tokens rather than being killed,
because there is nothing to kill: it is a loop holding tensors.

A cancelled completion returns empty and is not cached, since half an answer is
not the answer to the prompt that was asked, and caching it would hand that half
to the next request asking the same question. The response says `superseded` so
the editor shows nothing rather than reading the empty completion as "the model
had no suggestion".

## Picking between several completions

Greedy decoding takes the likeliest token at every step, which is not the same
as the likeliest sequence. For a suggestion that will be accepted or rejected
whole, the sequence is what matters.

```bash
curl -s localhost:8940/infill -d '{"prefix": "def add(a, b):\n    return ", "suffix": "\n", "candidates": 4}'
```

Four samples are drawn at a temperature that lets them differ, and the one the
model believed most is returned. Believed most means the highest mean
log-probability under the model's own distribution, taken before temperature,
top-k and the penalties: a probability measured after the distribution has been
cut down says how likely a token was among the ones still allowed, which is a
property of the sampler rather than of the model.

Mean rather than total, or the shortest candidate wins every time by having
fewer chances to be wrong.

It costs four generations and one reading of the prompt. The prompt is identical
for every candidate, so only the sampling is repeated, and the two caches are
separate switches for exactly this reason: no remembered answer, or every
candidate would be the same one, but the prefill kept, because reading it again
buys nothing.

On this checkpoint at a 502-token prompt, that first reading is 1198ms and each
reuse of it is 7.3ms. End-to-end numbers are not quoted because the machine
these were taken on was training at the same time, and repeated runs of the same
configuration varied between 1.8 and 17.7 seconds: the isolated measurement is
the one that means anything.

Still worth it only for a completion someone is waiting on and reading, so it is
off unless asked for and capped at eight.

The response carries `confidence` either way, which is the same number and is
what a client would threshold on to decide whether to show a suggestion at all.

## Stopping on text

A stop token works when the model was trained to emit one. Everything else needs
stopping on what the text says: an editor wants a completion to end at the next
blank line, a chat client wants generation to stop before the model writes the
user's next turn.

```bash
curl -s localhost:8940/generate -d '{"prompt": "def f():", "stop": ["\n\n"]}'
```

The difficulty is that tokens are not characters. A stop sequence of two
newlines can arrive as one token, as two, or as the tail of one and the head of
the next, so a check that looks at each delta on its own misses it about as
often as it catches it. The text is accumulated and matched across the joins.

That creates the second problem: a streaming caller must never be shown text
that turns out to be the beginning of a stop sequence, because there is no way
to take it back. So the last few characters are held back until they are known
not to be, and released when the generation ends without matching. The cost is
that a long stop sequence delays the stream by its own length, which is why the
server caps them at 64 characters and eight of them.

Both `stop` and `stop_sequences` are accepted, because the second is what a
Messages client sends and the first is what most other APIs call it.

## Asking the same questions every time

Perplexity says how surprised a model is by held-out code. It does not say
whether what it writes at a caret is worth showing to anyone, and the two come
apart: the run on six times the corpus scored worse and wrote better-formed
nonsense. The only way to know is to look, and looking is worth doing the same
way twice.

```bash
make model-probe                              # the checkpoint, six carets
make model-probe COMPARE=runs/fim             # two checkpoints, side by side
python -m codecraft_model probe --run runs/fim2 --cases mine.json --json out.json
```

Six built-in carets, chosen so a model with nothing to say has nowhere to hide:
finish this call, finish this assignment, add to this accumulator, write this
function's body, continue this import block, finish this condition. Temperature
zero and a fixed seed, so the same checkpoint answers the same way twice and a
difference between two rows is a difference between the models.

```
call argument  '        print('
  fim2  ,\n            "Field required",\n            "FastAPI",\n         …
  fim   , value, value, _, _, value, ss, value, m, value, None  [bracket]

assignment  '        self.text = '
  fim2  (nothing)
  fim   , _text, _text = _text.text  [dedent]

fim2  6 cases, 1 empty, 2 cut for structure, mean confidence -1.084
fim   6 cases, 0 empty, 3 cut for structure, mean confidence -1.433
```

Line breaks are printed rather than taken, because a completion that walks out
of the function is the failure being looked for and showing it over four lines
hides exactly that. Passing the same run twice is a supported thing to do: the
two rows are numbered apart, and identical answers are the check that the probe
is deterministic.

## Healing the caret

A caret does not land on token boundaries. `def parse(te` ends inside whatever
token those two characters would have been part of: in the corpus they are the
front of `text` or `test`, never a token of their own. The model is asked to
continue from a token it has never seen in that position, and what it does with
that is the failure the editor had been throwing away — it answers a half-
written line by starting a new one.

So the prompt is cut back to the boundary before its last token, and the first
generated token is chosen from those that begin with the characters removed.
The model predicts from a boundary it has seen, is free to reach the longer
token the text was heading towards, and the characters it puts back are
stripped before the completion is returned: they are already in the file.

Measured on a frozen copy of the 20M checkpoint, six carets, temperature zero:

```
call argument   print(⟨here⟩)
  without: (nothing — it began with a line break, and the block rule cut it)
  with:    item, item=item

function body   def load(path):\n    ⟨here⟩
  without: \n\n# The `get` file is not supported for the `get` command.
  with:    return_value,\n            )\n        return str(path)

condition       if value ⟨here⟩:
  without: (nothing)
  with:    from pydantic_core import SchemaValidator, core_schema
```

| | empty answers | cut for structure |
| --- | --- | --- |
| without healing | 4 of 6 | 4 |
| with healing | 0 of 6 | 4 |

Four of six carets produced nothing at all without it, because the first token
the model wanted was a line break. Most of what healing produces instead is
still wrong — this is a 6.5M-parameter model — but it is wrong on the line the
caret is on, which is the difference between a suggestion that can be judged
and no suggestion at all. It is on by default, and `--no-heal` on the probe
turns it off.

The measurement itself has a trap worth recording: the first pair of numbers
came out different from the second because the training run rewrote
`model.pt` between them. A probe is only a comparison if the checkpoint holds
still, so measure against a copy.

## Stopping on structure

Stopping on text needs to know what the model will say. The two ways a small
model ruins a completion at a caret need to know what the code looks like, and
contain no particular string at all:

```
    print(⟨here⟩)        value)               a bracket the suffix already closes
    total = ⟨here⟩       0
                         return total
                                              everything past here belongs to
                         def other():         some other part of the file
                             pass
```

So there is a second watcher over the same stream, cutting the completion where
it stops belonging to the caret. It ends a completion that closes a bracket it
did not open, and one that starts a line less indented than the line the caret
is on. Both are decided character by character as tokens arrive, so generation
stops at the token that broke the structure rather than after the whole budget.

Neither rule fires where it has nothing to say. The bracket rule is off unless
the suffix already closes something, which is the normal case at a caret in an
editor that closes brackets as you type and the only case where the model's
closing bracket is a duplicate rather than the one the code needs. The dedent
rule is off at column zero, where there is no block to fall out of. Brackets
inside strings and comments are text, which is why `/infill` takes a
`line_comment`: the editor knows the language and the model server does not.

Measured on the 20M checkpoint, at four carets, with everything else equal:

```
    result += ⟨here⟩   without:  = [\n    "So, Scrapy: Init, dt.A",\n    "Scrapy", …
                          with:  = [

    return ⟨here⟩      without: .\n\nimport pytest\n\nfrom pydantic import BaseModel…
                          with: .

    print(⟨here⟩)      without: .\n\n# The `name` argument is a list of the `name`…
                          with: .
```

Three of the four were cut, one from 48 tokens to one. This does not make the
model good — none of those completions is worth accepting, and the editor throws
away what is left as too short to show. What it does is make a bad suggestion
short instead of long, and it removes the failure where accepting one leaves a
duplicate bracket behind.

## Running out of context

A generation stops when the window fills. That is the default and it is the
honest answer for a completion: the alternative is to drop the oldest tokens,
and every cached key is bound to the position it was computed at, so dropping
them silently would leave the cache describing text that is no longer there.

`recycle_context` makes the trade explicitly. Set it to a fraction and the most
recent tokens are kept and read again from position zero, so generation
continues. It costs one prefill per recycle and the beginning of the text is
gone, which is why it is off unless asked for.

The same pass removed a wasted step: the loop used to run the model once more
after the last token, computing logits nobody read. On an eight-token completion
that was a ninth of the decoding.

### A checkpoint older than its tokenizer

Adding the fill-in-the-middle markers to the tokenizer gave every run prepared
before that change a tokenizer that knows four tokens its checkpoint has no
embeddings for. Ordinary generation never emits them. Infill puts them straight
into the prompt, and the model indexed off the end of its own table:

```
IndexError: index out of range in self
```

The engine now compares the two at load and says what happened, which run is
affected and what to do about it. Chat still works on those checkpoints; only
infill is refused, and it is refused with a sentence.

## Averaging checkpoints

Training walks a noisy path. Late in a run the weights at two nearby steps sit
on different sides of the same minimum, and the point between them is often a
little better than either: averaging cancels the part of each that is a step's
worth of randomness and keeps the part that was learned.

```bash
codecraft_model average --checkpoints runs/x/model.pt runs/x/latest.pt --out runs/x/soup.pt
codecraft_model evaluate --run runs/x --checkpoint runs/x/soup.pt
```

It costs no training, no data and no hyperparameters, one model comes out rather
than several, and inference costs exactly what it did.

### Measured twice, and it did not help either time

The only two distinct checkpoints on disk here are 20 and 40 steps into the
billion-token run, so that is what was measured:

| | held-out loss | perplexity |
| --- | --- | --- |
| step 20 | 7.4786 | 1769.8 |
| step 40 | 7.3511 | 1557.9 |
| the average of both | 7.3798 | 1603.3 |

The average sits between them rather than below the better one, and that is the
expected answer at step 40 rather than a bug. Forty steps in, the weights are
still travelling in one direction at speed; the difference between the two
checkpoints is mostly progress, not noise, and averaging a point with a worse
point earlier on the same road gives a point in between.

Averaging pays off when the checkpoints are jittering around a minimum, not when
they are still descending.

So it was measured again at the other end, on the fill-in-the-middle run at
steps 4000 and 4200 with the learning rate down to 3e-5:

| | held-out loss | perplexity |
| --- | --- | --- |
| step 4000 | 2.6863 | 14.68 |
| step 4200 | 2.6802 | 14.59 |
| the average of both | 2.6802 | 14.59 |

Indistinguishable from the later checkpoint to four decimal places. The weights
really do differ — the largest disagreement in one attention projection is
0.0018 — and the average really is their midpoint, but 200 steps at that
learning rate move the model too little for the average to be anywhere else.

Two measurements, two reasons, one answer: the checkpoints are either too far
apart to average or too close to be worth it. The command prints "evaluate it
before using it" for exactly this reason, and both tables are here rather than a
claim that it helps.

### What that measurement found instead

The checkpoint the training loop had kept as best, at step 4000, scored *worse*
on a proper evaluation than the final one it had beaten: 2.6863 against 2.6802.

The loop drew fresh random validation windows for every evaluation, so "keep the
best" was comparing two checkpoints against two different samples of the
validation set. At 20 batches the difference between samples is larger than the
difference between checkpoints a hundred steps apart, which makes the choice
close to arbitrary.

The windows are now seeded from the run's configuration, so every evaluation in
a run scores the same text and successive numbers can be compared. The cost is
that the number describes one sample rather than an unbiased estimate of the
whole validation set, which is the right trade for a number whose entire job is
to be compared with the same number from a hundred steps ago.

## Measuring a checkpoint

```bash
python -m codecraft_model evaluate --run runs/big
python -m codecraft_model evaluate --run runs/big --quantize   # the int8 model
```

Held-out perplexity, bits per token, bits per character, and throughput split
into prefill and decode. Bits per character is the one to compare across runs:
loss per token is not comparable between a 4,096-token vocabulary and a
32,768-token one, because the second predicts from a harder menu.

Prefill and decode are separate because they behave differently. Prefill reads
the whole prompt in one compute-bound pass; decode produces one token at a time
and is bound by reading the weights. Time to first token is the prefill number
restated as the lag someone actually feels.

### What int8 costs, measured

The billion-token checkpoint, scored on held-out data before and after
quantizing:

| | float32 | int8 |
| --- | --- | --- |
| Held-out loss | 4.2336 | 4.2332 |
| Perplexity | 68.97 | 68.94 |
| Bits per character | 1.737 | 1.737 |
| Weights | 34.6MB | 21.3MB |

Quality is unchanged. The difference is smaller than the noise between two
seeds, which is the answer you want from a quantization scheme.

Decode is slower quantized, because dequantization happens per forward pass:
this trades compute for memory rather than being faster. It exists so a model
that would not otherwise fit can be served at all.

## Resuming a run

`--max-hours` stops a run on the clock and writes a checkpoint; `--resume`
continues it. The architecture for a resumed run comes from the checkpoint, not
from `--size`.

That is not a nicety. The flag naming the size was given on the *first* run, and
leaving it off the second is the natural thing to do, so the resume rebuilt the
default preset and tried to load 6.5M parameters into it. The failure was forty
lines of `size mismatch for blocks.3.feed_forward.up_proj.weight`, which says
what happened only if you already know what happened.

A `--size` passed to a resume is now ignored with a sentence saying so, rather
than being silently obeyed or silently dropped. `--dropout` and `--context` are
training knobs rather than parameter shapes, so they still apply: raising
dropout on a resume is the usual reason to want one.

## Making it stop looping

A small model decoded greedily walks into a phrase and stays there. The FIM
checkpoint, asked to complete `result[key] = `, writes `\n#\n#\n#\n#` and spends
its whole budget on it.

A repetition penalty does not fix this. It scales the score of every token seen
before, and each token in `\n#` stays plausible on its own. What fixes it is
forbidding the *continuation*: a token that would repeat an n-gram this
generation has already produced is removed from the distribution.

Measured on the same four prompts, with greedy decoding:

| | what it writes |
| --- | --- |
| Off | `\n#\n#\n#\n#\n#\n#` |
| n=2 | `\n#\n\ndef _coffset(value):\n    """Return a string for a list of` |
| n=3 | `\n#\n# The value is a string, and the value is not a string.` |
| n=4 | `\n#\n#\n\ndef _coffset(value):\n    """Return a string for a` |

The loop is gone at every setting. Four is the default for infill: two forbids a
second run of indentation, and code legitimately repeats short sequences.

Only what this call generated counts. Applying the ban across the prompt as well
is the usual implementation and it is wrong here, because repeating an idiom
from the file being completed is most of what an inline suggestion is for.

This does not make the checkpoint good. It still answers a caret inside a
dictionary assignment by starting a new function, which is what an hour of
training on a 6.5M-parameter model buys. The loop was a decoding problem and is
fixed; the rest is a model problem and is not.

## The cache that would never have fired

The prefix cache above is measured on a file that fits in the model's context.
On a file that does not, it fired exactly never, and the reason is worth writing
down because the feature looked like it worked.

A prompt too long for the context is trimmed from the outside in, keeping the
text nearest the caret. Keeping *exactly* the last N tokens means the window
moves one token every time a character is typed. Every key press therefore
shifts the whole prompt by one, and a prefill cached a moment earlier lines up
with nothing:

| typed since the cached prompt | tokens shared, sliding window | with the window held still |
| --- | --- | --- |
| one character | 493 | 476 |
| two | **1** | 476 |
| three | **1** | 476 |

One token. The `<|fim_prefix|>` marker, and nothing else.

The fix is to round the window's start up to a multiple of 32 tokens, so it
stays put for 32 keystrokes at a time and then jumps. Rounded up rather than
down, because down would buy context by exceeding the budget. The cost is up to
32 tokens of context out of 500, about 3%, in exchange for a cache that fires on
the files it was built for.

### And the same thing one layer up

That fix is not enough on its own, because the editor has a window of its own.
It sends the 2000 characters before the caret, and *that* window slides by one
character per keystroke, which changes where the text is cut and therefore how
its first tokens come out. Simulating the real client against the real server:

| | prefills reused, six carets one character apart |
| --- | --- |
| Editor window sliding | 2 of 6 |
| Editor window held still | 5 of 6 |

So the editor rounds its start up to a multiple of 64 characters for the same
reason and with the same trade. Both layers have to hold still; either one
sliding is enough to lose the cache.

## Serving the same question twice

An editor at a caret asks almost the same question on every keystroke. The
previous request plus one token is the next request, and prefilling it from
scratch re-reads a context that has not changed.

Two caches sit in front of `infill`. A prefix cache keeps the key/value tensors
from the last prefill, so a request that extends an earlier one pays only for
the tokens that are new. A response cache keeps whole answers, so a request
identical to a recent one returns without touching the model, which also keeps
a suggestion stable instead of resampling it each time the editor re-asks.

Measured on the FIM checkpoint, typing 22 characters into a 240-token file on
CPU, 12 tokens of completion each:

| | total | per request |
| --- | --- | --- |
| No caching | 1.94s | 88ms |
| Prefix cache | 1.64s | 74ms |
| A request already seen | | under 1ms |

All 22 completions were byte-identical with the cache and without it, which is
the property that matters: reuse is an optimisation, and an optimisation that
changes the answer is a bug.

The 1.18x is honest and smaller than it sounds like it should be. Prefill is
one forward pass over 240 positions; decode is twelve passes over one position
each, and at this model size each of those pays roughly the same fixed cost. The
cache removes most of the prefill, which is about a fifth of the work. It grows
with the size of the file and shrinks as the completion gets longer. The
response cache is the one that turns a request into nothing at all.

### The bug this found

Reusing a prefill means running several new tokens on top of a cache, which the
decode path never does: it runs one. `scaled_dot_product_attention` with
`is_causal=True` aligns its mask to the top left, so with four new queries over
a cache of eight, query 0 could see key 0 and nothing else. Every cached token
was masked out.

The fix is an explicit mask aligned to the bottom right, and the test that
catches it compares logits rather than sampled tokens. A test on sampled tokens
passes with the mask wrong, because an untrained model emits the same token
whatever it is shown.

## Tests

```bash
make test-model
```

463 tests: parameter counts against real modules, tokenizer round trips over
awkward input, the rotary property that attention depends only on relative
position, incremental decoding matching a full forward pass, a reused prefill
giving the same logits as a whole one, the training loop actually reducing loss
on learnable data, the HTTP surfaces driven over a real socket, and the whole
command line run end to end from source files to generated text at a scale that
fits in a test.

The CUDA paths are tested with stubs rather than skipped. The failure that
matters most there is a wheel built without the card's architecture, and by
definition it cannot be reproduced on a machine that has the right one.

Two of them exist because they caught real bugs. The pre-tokeniser once excluded
underscores from its word class and matched them nowhere else, so every
`__init__` in the corpus silently lost its underscores; a test now asserts the
pattern reconstructs its input exactly. And chunked encoding once cut on any
newline, splitting the whitespace run that a newline plus indentation forms, so
a chunked corpus encoded differently from the same text encoded whole.
