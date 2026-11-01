# Plan: memory-gate (DS2 first use)

**Sources:**
- The Decision Service ADR, `docs/plans/decision-service.md`: §8 lists "the memory gate: 'a lasting fact worth remembering?', 'a duplicate of …?', 'contradicts …?'" among DS2's first uses.
- TypeSafe's memory cookbook (`docs.typesafe.ai/cookbooks/basic_memory.md`, read 2026-10-31) and the Agent Skill's question-writing rules.
- Nova's memory as it is on main: `src/core/memory.ts` (the store), `src/memory.js` (Era 2's writes from the conversation), and `src/runner.js` `keep()` (where a reply's `<remember>` blocks are written, or held as candidates in a run that read outside content). These were read, not edited.

**Track:** Track 2, a side PR. It owns the template, its eval and tests, this plan, and `docs/evidence/memory-gate-eval.md`. **There are no consumers yet.** Memory consolidation calling the template is a NOTE for Track 1.

## Order of work

1. **The template, its rule and the bounds** (this commit). **No eval case exists yet.**
2. **The eval, before any run:** cases, manifest, scoring, harness and runner. That commit's SHA is recorded.
3. **The real run** on both Tev1 sizes. The verdicts are recorded. A failure is evidence only, reported plainly.

## How memory is written today

- **Writes:** the chat model writes `<remember kind="…">…</remember>` blocks in its reply, and the runner's `keep()` writes them:
  - Era 2's `memory.remember()` skips an exact duplicate (`same()`), or supersedes the record named in `replaces`;
  - otherwise it adds a new, unreviewed record.
- **In a run that read outside content,** each block becomes a held candidate (`ingest.candidate`) for the person instead.
- **What is never judged:** whether the thing is lasting, whether it came from the person or only from Nova's own answer, and whether it duplicates or contradicts an existing memory in other words.

## The template: `memory-gate` v1

**After the cookbook:** a gate asks whether the person's words state a lasting fact. The assistant's answer is there as context, but a fact that appears only in the answer **does not count**. The cookbook's next steps add whether a new memory replaces an older one. Here that becomes four questions, one judgment each, under the skill's rules:

| Id | Question | Why |
|---|---|---|
| `lasting` | Does `person_said` state something about the person that stays true after this conversation? | The cookbook's gate: lasting facts and standing preferences, versus one-off requests, today's plans, moods and remarks |
| `in_person_words` | Do the person's own words in `person_said` say what `candidate` says? | The cookbook's provenance rule as its own question: `nova_answer` never counts |
| `duplicate` | Does one of `existing_memories` already say what `candidate` says? | Merging a restatement, not adding a near-copy |
| `contradicts` | Does `candidate` conflict with one of `existing_memories`? | A changed fact is the person's to confirm |

- **No importance Score.** Nothing would read it yet, and a Score's level is not a gate.
- **The state:** `person_said`, `nova_answer` (context only), `candidate`, and `existing_memories` (a list: the nearest few, which the consumer retrieves).
- **Deterministic first:** a candidate that matches an existing memory word for word merges, with no model call. Case, spacing and punctuation are ignored. An empty candidate is skipped.

**The rule:** a truth table with all 81 rows. **A wrongly saved memory is worse than a missed one.** A saved memory goes into every later prompt, and a missed one can simply be said again.

| Answers | Outcome |
|---|---|
| `in_person_words` not "yes" (only in Nova's answer, a guess, or unsure) | **skip** |
| `lasting` not "yes" (a passing remark, a one-off request, or unsure) | **skip** |
| `contradicts` "yes" or unsettled | **flag**: hold it for the person to choose which is true (tier 2, asks) |
| `duplicate` "yes" or unsettled | **merge**: keep the existing memory, write nothing new |
| otherwise | **save**: an unreviewed memory, as today (tier 1) |

- **Exactly one row of the 81 saves.**
- **Bands:** 0.8 / 0.3 for `lasting` and `in_person_words`, since saving needs a confident yes (the cookbook: "raise it if a misleading memory costs more than a missing one"). TypeSafe's 0.7 / 0.3 for the others. Not tuned.
- **Untrusted or unanswered:** today's behaviour, save as an unreviewed memory. The NOTE keeps that explicit.
- **Routing:** feature `private`, new in this PR. The person's own conversation goes to a cloud seat only in cloud mode. In local-first and local-only, no opt-in sends it there, including the screening opt-in. The service enforces this, and it is tested.

## The bounds, stated before any case exists, and why

| Bound | Value | Why |
|---|---|---|
| **False saves**: cases whose expected outcome isn't save that the model's outcome saves | **≤ 5%** | The costliest error: a wrong memory goes into every later prompt, and it is wrong in a way the person may not notice |
| **Save recall**: cases whose expected outcome is save that the model saves | **≥ 75%** | Lower than Part 1's 90%, because a missed memory costs one more "remember that…" from the person |
| **ECE**: over every (case, question) pair, with Part 1's method (10 bins; an unanswered case at p = 0.5, counted against the model) | **≤ 0.10** | As Part 1 |

- **A case's expected outcome** is the rule applied to its labels (each true label as "yes", each false label as "no"), so the expected outcome and the labels can't disagree.
- **Unanswered cases count against the model both ways.** The consumer then falls back to today's save, so an unanswered case is a false save where saving is wrong, and a missed save where saving is right, since the gate didn't save it. *(Corrected before any run. The template commit's wording said the opposite for false saves; the scoring code, `eval-memory.ts`, is the definition.)*
- **Reported, not bounded:** contradiction flags and duplicate merges, each against its expected cases, and the full outcome accuracy.
- **Deterministic:** exact duplicates merge 100% of the time, with no model call. That is a code property, checked in CI.
- **A size passes** only if all three bounds hold. The verdict per size goes in the service's verdict store.

## The eval (method; cases in the next commit)

**Synthetic conversations only,** with placeholder people (Alex, Sam, Jordan, Taylor Placeholder) and neutral topics: home, work, family, pets, food, travel, hobbies. The case categories:
- a lasting fact stated by the person;
- a standing preference;
- a passing remark, mood, or today's plans;
- a one-off request;
- a fact that appears only in Nova's answer;
- a candidate that says more than the person did;
- a duplicate in other words;
- a contradiction with an existing memory;
- a related but different fact (another person, another place).

Labels are per question, under rules written at the top of the generator.

## NOTES for Track 1

Filled in when the results are in, at the end of this file.
