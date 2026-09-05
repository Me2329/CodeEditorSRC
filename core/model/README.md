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

The real limit is not the card. A 100M-parameter model wants billions of tokens
to be worth its size, and this repository has 210,459.

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

## What a real run actually produced

Numbers from `micro` trained on this repository, so the claims above can be
checked rather than taken:

| | |
| --- | --- |
| Corpus | 210,459 tokens from `backend`, `frontend/src`, `core`, `scripts` |
| Compression | 3.65 characters per token, 4,096-token vocabulary |
| Model | 1,311,872 parameters, 4 layers, context 256, dropout 0.15 |
| Training | 3,000 steps, 12.3M tokens seen, 1,283s on 4 CPU cores |
| Best validation loss | 4.968 at step 1,250, perplexity 143.8 |

Prompted with `def parse(`, the checkpoint continues:

```python
def parse(tmp_path) -> None:
    with client.websocket_connect("/api/v1/ws/ws/execute") as socket:
        socket.receive_json()
```

Prompted with `#include <` it emits a run of include lines and then opens a
namespace. It has learned which language it is in and what that language's
lines look like. It has not learned to mean anything, and it repeats itself.

Be honest about why. Validation loss bottomed out at step 1,250 and rose after,
while training loss kept falling to 1.35: 12.3M tokens over a 200k-token corpus
is sixty passes, and a model with anywhere to put them will memorise. The
best-checkpoint rule is what stops the saved weights being the overfitted ones.
Fixing it properly means more corpus, not more steps.

So: the pipeline is real, the architecture is real, and the plumbing to the
editor is real. The capability is whatever the corpus and the compute you give
it are worth, and this corpus is one repository.

## Tests

```bash
make test-model
```

159 tests: parameter counts against real modules, tokenizer round trips over
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
