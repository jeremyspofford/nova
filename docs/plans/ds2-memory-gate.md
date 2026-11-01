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

## The result (2026-10-31)

The template, its rule and the bounds were fixed at `7d587168`. The eval was fixed at `6392c6b0` before the run. The run was on Ollama 0.40.13.

| Size | Digest | False saves | Save recall | ECE | Flags | Merges | Verdict |
|---|---|---:|---:|---:|---:|---:|---|
| `tev1:4b` | `7954dce2…0740` | 0/49 | 25/26 (96%) | 0.082 | 5/8 | 11/11 | **pass: trusted on this build** |
| `tev1:0.8b` | `abc31fdb…c099` | 0/49 | **0/26** | **0.111** | 2/8 | 6/11 | **fail: evidence only** |

**The caveats,** in full in `docs/evidence/memory-gate-eval.md`:
- the false-save interval reaches 7.3%;
- three contradictions were skipped rather than flagged (the rule checks lasting and in-person first), so outdated memories stay;
- one author wrote the questions and the cases.

## NOTES for Track 1

Queued in `docs/plans/track1-follow-up-queue.md` after #277. No consumer is connected by this PR.

Track 2 changed no memory code, no consumer and no shared file. These are what the template needs to be used.

### 1. `keep()` asks the gate before writing a memory (`src/runner.js`)

Today a reply's `<remember>` block is written straight away, unless the run read outside content (then it becomes a candidate). The gate sits in front of that write, for untainted runs only. Tainted runs keep today's candidate path unchanged.

```js
// Runner constructor deps: add memoryGate (server.js passes it; see item 2).
constructor(config, store, { …, ingest = null, memoryGate = null, … } = {}) {
  …
  this.memoryGate = memoryGate;
}

// keep(): for a remember op in an untainted run.
if (o.op === 'remember' && this.memoryGate) {
  const near = this.memory.store().search(o.text, { limit: 5 }).records.map((r) => r.content);
  const d = await this.memoryGate({
    person_said: this.personSaid(sessionId, tag.turn),   // the person's message for this turn
    nova_answer: said,                                    // the visible reply, context only
    candidate: o.text,
    existing_memories: near.join('\n'),
  }, { task_id: run.task_id ?? null });
  if (d && d.trust !== 'none') {
    if (d.outcome === 'skip') return { op: 'remember', ok: true, skipped: true, why: d.why };
    if (d.outcome === 'merge') return { op: 'remember', ok: true, existing: true };
    if (d.outcome === 'flag') {
      const id = this.ingest.candidate({ op: 'remember', kind: o.kind, content: o.text, source: from, taint: [], reason: 'contradicts an existing memory' });
      return { op: 'remember', ok: true, held: true, id };
    }
  }
  // 'save', or an untrusted or unanswered gate: today's behaviour.
}
return this.memory.remember({ ...o, from });
```

- **`keep()` becomes async,** and its one call site (`runner.js:383`) awaits it. `said` is the visible reply text that `extractMemory()` returns; pass it into `keep()`.
- **`personSaid(sessionId, turn)`** reads the session's `type: 'user'` record for that turn: the text the person typed.
- **The decision record** gets the session and turn as `subsystem: 'memory'`, and the memory row's `source` stays `sessionId/turn` as today.
- **`ingest.candidate()` takes an optional `reason`,** and the candidate list shows it ("Nova heard something that conflicts with what it remembers: …"). Candidates already carry provenance; add the `reason` column (item 3).

### 2. The wiring (`src/server.js`)

```js
const runner = new Runner(config, store, { …, memoryGate: (fields, o) => core.decisionService.ask('memory-gate', fields, { subsystem: 'memory', ...o }) });
```

`core.decisionService.ask` is the service Track 1 already exposes on the core (`src/core/index.ts`), with the template a built-in. It routes as `private`: the person's own conversation never goes to a cloud seat in local-first or local-only, and no opt-in sends it there.

### 3. A migration

`ALTER TABLE memory_candidate ADD COLUMN reason TEXT;`

### 4. The records

**`docs/LEDGER.md`, under `## Decisions`:**

> **2026-10-31 (DS2: memory-gate).** Plan `docs/plans/ds2-memory-gate.md`; evidence `docs/evidence/memory-gate-eval.md`; PR #⟨n⟩.
> - **The template:** `memory-gate` v1, after TypeSafe's memory cookbook.
>   - **Four Nouls:** lasting, in_person_words (Nova's answer never counts), duplicate, contradicts.
>   - **Deterministic first:** exact duplicates merge with no model call.
>   - **The rule:** not in the person's words or not lasting → skip; a conflict → flag; a duplicate → merge; otherwise save. Saving needs a confident 0.8; not tuned.
>   - **Routing:** a new `private` feature; the person's conversation goes to a cloud seat only in cloud mode.
>   - The template, rule and bounds were fixed at `7d587168`, before any case.
> - **The eval,** fixed at `6392c6b0` before the run: 75 synthetic conversations.
> - **Bounds:** false saves ≤ 5%, save recall ≥ 75%, ECE ≤ 0.10.
> - **Result, on Ollama 0.40.13:**
>   - tev1:4b `7954dce2…`: 0/49 false saves, 25/26 saves, ECE 0.082. **Pass**: trusted on that build.
>   - tev1:0.8b: saved nothing. **Fail.**
>
>   **Caveats:** the false-save interval reaches 7.3%; three contradictions were skipped rather than flagged, so outdated memories stay; one author.
> - **Pending Track 1:** `keep()` asks the gate, the wiring, the candidate `reason`.

**The plain-language entry:**

> Before Nova keeps something it thinks it should remember about you, it can now check that you actually said it (not just Nova), that it's lasting rather than about today, and whether it repeats or contradicts something it already knows. On this computer's model, in 75 practice conversations it never saved anything it shouldn't have, and it kept 25 of the 26 things worth keeping. It still sometimes misses that a new fact replaces an old one. It isn't switched on yet.

**`docs/builder-packet/CAPABILITY-INVENTORY.md`, on the Decision Service row:**

> **The memory gate:** `memory-gate` v1 (`templates/memory-gate.ts`), with four Nouls after TypeSafe's memory cookbook, deterministic exact-duplicate merges, and saving only on a confident yes. **Passed** its pre-registered eval on tev1:4b `7954dce2…` (0/49 false saves, 25/26 saves, ECE 0.082), so it is trusted on that build; tev1:0.8b failed (saved nothing). It never leaves the device in a local mode. **Gaps:** no consumer yet (`keep()` asks the gate; NOTES 1–3); three contradictions skipped rather than flagged; one author for the questions and the cases.
