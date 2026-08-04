# The model tournament

Asked 2026-08-04. Jeremy: *"maybe nova should run nightly tests of new local
llms nightly and compare against a recommended cloud llm weekly? That way we
can always test local llm capabilities."*

Decisions taken at the time, and they shape everything below:

- **Propose, the operator promotes.** Nothing is swapped or deleted
  automatically.
- **Candidates may come from anywhere** she can reach — Ollama library,
  HuggingFace, elsewhere.

---

## Why nothing auto-promotes

Not caution — measurement. All three of these are from this repo, today:

| | |
|---|---|
| `ornith:9b`, same suite, consecutive runs | **2/7 then 3/7** |
| the task that flipped | a coin at **1/3** |
| `ornith:9b` vs `qwen3:8b`, 3 repeats each | **2/7 vs 2/7 — a tie** |

An auto-promoting loop fed by those numbers promotes whichever model ran on a
lucky night. And there is no pressure forcing the decision: six models on disk
total 34 GB against **832 GB free**, so nothing needs deleting to make room.

Deleting is one command and 5–8 GB to undo. The loop keeps the loser.

## Why this could not have been built yesterday

Five of eight suites had granted tools with no way to answer them, so a run
that reached for one produced an unserved call. Fixing that in `main` alone
turned `glm-5.2` from FAILED into 3/3 — **the entire model difference was the
suite's.** A tournament run on those suites would have ranked artifacts.

`test_eval_servability.py` is now the guard, and it is a hard prerequisite:
**a tournament is only as trustworthy as the suites underneath it.**

---

## Shape

The split follows the house rule. What must be deterministic is a scheduled
job; only the part that genuinely needs judgment is an agent, and that part
only ever proposes.

### Nightly — mechanical, no model judgment

A `maybe_run_tournament()` in the scheduler tick, leader-gated and
self-limiting like every other job there.

- Pick the suite with the **oldest coverage** — the one whose newest result
  for the current suite_version is stalest. Rotating, so the rotation actually
  rotates rather than one suite being measured forever.
- Run the suite's **field** against it at `repeat=3`. Three is not decoration:
  at `repeat=1` this suite disagreed with itself.

**The field is every installed local model, for every suite.**

This was narrowed once and the narrowing was reverted, which is worth keeping
on the record because the argument for it sounded right. It ran a cloud-bound
agent's suite against the install standby alone, reasoning that ranking six
models against guardian measures a configuration nobody deploys. It was wrong
twice:

- **It made the standby unimprovable.** Eleven of twelve agents are cloud, so
  eleven of twelve suites entered exactly one model — the incumbent. A
  challenger cannot out-score a model it is never run against, so the standby
  would have been defended by never being tested: a declared choice wearing
  measurement's clothes, which is the thing this feature exists to replace.
- **It asked the deployment question about the wrong subject.** Not "does
  anyone deploy THIS model on THIS agent" but "does anyone deploy A LOCAL
  model here" — and that is yes everywhere, because the standby stands in for
  all eleven cloud agents the moment a provider fails, which happened on an
  HTTP 402 the day this was written.

And the decision it feeds is **one decision, not eight**. There is a single
`main` binding and a single install-wide standby; nothing can bind a different
local model per agent for the degraded path. Jeremy, 2026-08-04: *"we can find
the best local model that, if we have to choose one local llm, would be the
best across all."* That needs the same field everywhere — see **The
standings** below.

Cost is why the narrowing was tempting and why it was not needed: **one suite
runs per night**, so a night costs `|field|` runs either way. `main` is ~1.5
min per pass and `guardian` ~2.9, so six models × 3 repeats is roughly 30–55
minutes. The full 8-suite rotation is 48 runs spread over 48 nights of
ordinary sleep, not 48 runs in one, and zero tokens billed — it is all local.

### The night has to evict, or it starves itself

Found on the first complete night, 2026-08-04, and only visible because the
field had just widened: **one model a night never contends with itself.**

Ollama keeps a model resident for minutes after its last call, and six models
run back to back at about that interval — so every model after the first
loaded into a card still holding its predecessor. Measured mid-night: **19.7
GB of a 24 GB card held by three models at once, two already finished.**
`local_context` sizes the window to what is left, which came out at 8,192
against models whose real limits are 32k–262k. `main`'s 4,211-token prompt
needs 4,192 usable (the window less the 4,000-token completion reserve), so it
was **refused by nineteen tokens** — before the model saw anything.

Four of six models were never asked a single question that night.

So the tournament evicts each model (`keep_alive: 0`) before the next loads.
Best effort: a model that will not evict is a slower night, not a failed one.
Measured after: **17.9 GB free instead of 5.0**, and the first model went from
0 of 7 asked to a complete sitting.

**This is not only an eval concern.** `main` — the agent every chat turn uses
— runs `ollama:qwen3:8b` against that same VRAM-sized window, and a real turn
near 4,200 tokens is *refused*, not truncated. Raising that floor is an
operator decision: pin a larger window, keep fewer models resident, or move
`main` to cloud.

Everything records through the existing path, so `suite_version` and
`repeat_count` land on every row and `model_fitness` reads them.

### The standings

Per-suite scores are the evidence; `model_tournament.standings()` is the only
place that adds them up, because adding up is where a ranking starts lying.
Four rules, each stopping a specific over-reading:

- **The basis is the suites that can tell two models apart, and a model is
  ranked only if it was measured across all of it.** Nothing else is
  apples-to-apples — averaging a model measured on one suite against one
  measured on two ranks the least-tested model first about as often as not.
  Pairings outside it are `missing`, never folded in. Requiring *every*
  installed model instead reads stricter and is more fragile: pulling a
  seventh model emptied the basis and discarded a clean six-way comparison,
  and proposing pulls is phase 4 of this same plan.
- **Only at the suite's current version**, the same coverage rule the rotation
  uses.
- **Only a run the model actually SAT** — `tasks_gradeable = tasks_total`
  (migration 088). `tasks_total` is the suite's size, so a task refused before
  it reaches the model still sat in the denominator, and the score read as a
  verdict on the model when it was a fact about the machine. The first
  complete night ranked six models on denominators of 0, 2, 6 and 7 questions
  and put the two that answered *nothing* last at 0%. A run with no gradeable
  task is now an `error`, never `failed 0/7` — those read identically and mean
  opposite things. Rows predating the column are NULL and excluded rather than
  assumed complete.
- **Only runs of `repeat >= 3`.** A manual single draw must not be able to
  crown anything.
- **A leader needs a margin, and a tie is reported as a tie.** `ornith:9b` and
  `qwen3:8b` are tied 2/7 over three repeats each; breaking that by sort order
  would be an artifact.

`comparable: false` with the pairings still owed is the normal state early in
a rotation, and it is what the panel renders — never a default winner.

### Weekly — the cloud yardstick

The same suite, once, against the curated cloud model. This is the only part
that costs money, which is why it is weekly and why the suite is the one that
was just measured locally rather than a fresh one.

### The card

When a challenger beats the agent's current model **by a margin** — at least
one task, across the same repeat count, on the same suite_version — raise a
recommendation carrying:

- both scores and the repeat count
- **the per-task diff**, not just the totals

The diff is the part that matters. Two of guardian's six failures are the
model doing something dangerous (deleting rules under an injected
instruction), not merely failing to call a tool. A model that gains a task by
*refusing better* is a different thing from one that gains it on a flaky
check, and a bare `3/7 → 4/7` cannot tell them apart.

### Candidate discovery — the only agent-shaped part

A `scout` proposes models worth pulling, with a reason, as a card. It never
pulls.

**The wrinkle to design around:** the runtime is Ollama. `ollama pull
hf.co/<repo>` works for GGUF repos; non-GGUF HuggingFace weights cannot run
here at all. So "anywhere" means *any GGUF she can reach*, and a rejected
candidate must be recorded WITH the reason — silently skipping half of
HuggingFace would look like she never found anything.

There is also no principled "what is new" feed. Candidates come from the
curated catalogue and from whatever she can search, and every one arrives with
why it is worth 8 GB before anything is downloaded.

---

## Phases

1. **Nightly local ranking.** The scheduler job, the rotation, the recording.
   Nothing proposes yet — it just builds the evidence `model_fitness` already
   knows how to read.
2. **The promotion card**, with the per-task diff, and one-click promote.
3. **Weekly cloud comparison** on the same suite.
4. **The scout**, proposing pulls with reasons.

Phase 1 is worth having on its own: it is the difference between fitness
findings that say *"never graded"* and findings that say a number.

---

## Open

- ~~**Which binding does a winner target?**~~ **Decided 2026-08-04 — the
  suite's own agent.** Jeremy: *"I would say the suite."* It resolves cleanly
  once you notice there are two bindings and therefore two cards, differing
  only in the scope of the evidence behind them:

  | evidence | targets |
  |---|---|
  | a winner on **one** suite | that suite's agent binding |
  | a winner across **the basis** (see the standings) | the install-wide standby |

  `main` is not special-cased. It gets a card because it is a suite's agent,
  the same as everyone else — and it is the one anybody cares about only
  because it is the one agent currently bound to a local model, which is a
  fact about today's config rather than about the design.
- **Uninstalling is still manual, on purpose.** If disk ever does get tight
  the loop should propose a deletion, never perform one.
