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

Temperature, top-k, top-p and a repetition penalty, with a key/value cache so
each token costs one step instead of a re-read of the prefix. Tokens stream as
they are produced.

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

## Tests

```bash
make test-model
```

175 tests: parameter counts against real modules, tokenizer round trips over
awkward input, the rotary property that attention depends only on relative
position, incremental decoding matching a full forward pass, the training loop
actually reducing loss on learnable data, the HTTP surfaces driven over a real
socket, and the whole command line run end to end from source files to
generated text at a scale that fits in a test.

The CUDA paths are tested with stubs rather than skipped. The failure that
matters most there is a wheel built without the card's architecture, and by
definition it cannot be reproduced on a machine that has the right one.

Two of them exist because they caught real bugs. The pre-tokeniser once excluded
underscores from its word class and matched them nowhere else, so every
`__init__` in the corpus silently lost its underscores; a test now asserts the
pattern reconstructs its input exactly. And chunked encoding once cut on any
newline, splitting the whitespace run that a newline plus indentation forms, so
a chunked corpus encoded differently from the same text encoded whole.
