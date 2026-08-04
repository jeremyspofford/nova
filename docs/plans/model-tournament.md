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
  for the current suite_version is stalest. Rotating, so eight nights covers
  everything rather than one suite being measured forever.
- Run **every installed local model** against it at `repeat=3`. Three is not
  decoration: at `repeat=1` this suite disagreed with itself.
- Record through the existing path, so `suite_version` and `repeat_count`
  land on every row and `model_fitness` reads them.

Cost, measured: `main` is ~1.5 min and ~100k tokens per pass, `guardian` ~2.9
min. Six local models × 3 repeats is roughly 30–55 minutes overnight, and zero
tokens billed — it is all local.

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

- **Which binding does a winner target?** An agent's model, or the install-wide
  standby? A suite is named after one agent, so the honest default is that
  agent's binding — but `main` is the one anybody cares about.
- **Uninstalling is still manual, on purpose.** If disk ever does get tight
  the loop should propose a deletion, never perform one.
