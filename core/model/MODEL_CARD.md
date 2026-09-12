# CodeCraft LM: what it is and what it is not

Written because the honest answer to "what are its safeguards?" is unusual, and
guessing wrong in either direction leads somewhere bad.

## There is no safety layer, and therefore no switch

CodeCraft LM is a **base model**. It was trained on exactly one objective:
predict the next token in a stream of source code. Nothing else happened to it.

In particular, none of this exists in the code:

- No instruction tuning. It was never shown an instruction and a good reply.
- No RLHF, no DPO, no preference training of any kind.
- No refusal training. It has never been taught to decline anything.
- No output classifier, keyword filter, or content moderation.
- No system prompt with rules, because a base model does not follow rules.

`grep -rniE "refus|safeguard|safety|moderat" codecraft_model/` returns nothing,
and that is the whole story. A `--safeguards off` flag would toggle a variable
that no code reads. It would be a lie in the source, and worse than useless: it
would imply that leaving it on does something.

If you want the model to behave differently, the levers that actually exist are
the corpus, the training objective, and the sampling parameters. Those are the
only things that shape its output.

## What that means in practice

A base model imitates its training distribution, so what matters is which
checkpoint you have. Four exist in this repository and they are not
interchangeable:

| Run | Parameters | Tokens it actually read | Held-out loss |
| --- | --- | --- | --- |
| `demo` | 1.3M | 12.3M, from this repository | 4.97 |
| `fim` | 6.5M | 17.2M, from 735 files | 2.58 |
| `fim2` | 6.5M | 24.6M, from 6,792 files across twenty Python projects | 3.50 |
| `huge` | 40.4M | 163,840 | 7.41 |

The billion-token corpus in `corpora/big-code.txt` is real, and no model here
has read it. `huge` was given forty steps of it to prove the pipeline runs at
that size and was then stopped, which is why its loss is near the uniform
baseline: it is an untrained model with a large corpus behind it, not a model
trained on a large corpus. The usable checkpoint is `fim2`, and what it read is
Python.

These losses are not comparable across runs, because each was scored against
its own corpus's held-out split. The README next to this file explains that and
what the checkpoints write at a fixed set of carets, which is the comparison
that means something.

It has no concept of intent. Asked for a function it produces a function; asked
for something harmful it does not recognise the request as a request at all,
because it does not process requests. It continues text.

The realistic risks are the boring ones, and they are worth naming:

| Risk | Why |
| --- | --- |
| Wrong code that looks right | It optimises for plausible, not correct. Nothing checks the output. |
| Insecure patterns | Public code contains plenty. It learned the distribution, including the bad parts. |
| Memorised fragments | Anything appearing often enough in the corpus can come back near-verbatim. |
| Licence contamination | The corpora are GPL, Apache, MIT and more. Output can resemble any of it. |

That last one is the practical problem for a product, not a theoretical one.
Check `corpora/big-code.txt` against whatever licence you intend to ship under.

## The safety that does exist is elsewhere, and it is real

The parts of CodeCraft Studio that genuinely enforce boundaries have nothing to
do with the model, and are not toggles:

- **The sandbox.** Code the editor runs is confined by user namespaces, a
  read-only root filesystem, an empty network namespace, cgroup and rlimit caps,
  and seccomp where nsjail is available. An eleven-check suite asserts escapes
  fail loudly. See `docs/SECURITY.md`.
- **Agent plan mode.** The write and run tools are withheld by the daemon, not
  hidden in the interface, so a plan-mode agent cannot change or execute
  anything even if it tries.

Those protect your machine from code, which is the threat this project actually
has. Neither is a content filter, and neither should be confused for one.

## What shapes the output, and what does not

Three things constrain what comes back from the caret route, and none of them
is a content control. They are here because someone reading this file should not
mistake one for the other:

- **Structural stopping.** A completion is cut where it closes a bracket the
  file already closes, or leaves the block the caret is in. It shortens
  suggestions; it cannot judge what they say.
- **Token healing.** The prompt is cut back to a token boundary and the first
  generated token is chosen from those beginning with the characters removed.
  It constrains one token, on spelling, not on meaning.
- **Sampling parameters.** Temperature, top-k, top-p and the repetition
  penalties shape the distribution the sampler draws from. They are the only
  knobs that change what the model is likely to say, and they are as available
  to someone wanting bad output as to anyone else.

## What is deliberately not here

A parameter whose purpose is to remove restrictions so the model will produce
harmful content will not be added. Not because of what the model can currently
do, which is very little, but because a switch like that is a commitment about
what the project is for, and it survives every future version that gets more
capable. The corpus and the objective are the honest places to make that kind of
decision, in the open, rather than behind a boolean.

Everything else about this model is unrestricted by construction, and the code
says so plainly rather than pretending otherwise.

## Provenance

| | |
| --- | --- |
| Architecture | decoder-only transformer, RMSNorm, RoPE, GQA, SwiGLU |
| Sizes | 1.3M to 1.01B parameters |
| Tokenizer | byte-level BPE trained here; 8,196 tokens for `fim2`, 32,768 for the billion-token corpus |
| Corpus prepared | 1,000,004,906 tokens of public source code |
| Corpus read by the usable checkpoint | 24,576,000 tokens, from 20,058,256 of Python |
| Training | AdamW, cosine schedule, from random initialisation |
| Pretrained weights used | none |
| Hosted models called | none |
