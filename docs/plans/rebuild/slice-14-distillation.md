# Slice 14 — Distillation: facts, not transcript

Branch `slice/s14`, cut from `rebuild/v4` at 4822c086.
Status: SPEC, 2026-09-10.

S13 measured recall honestly and lifted it from 6 of 20 to 12 of 20. The
remaining ceiling is not retrieval, it is **what is stored**: 99% of
Jeremy's memory by volume is raw conversation transcript, with one
deliberately-saved note in twelve days. Searching a transcript returns
transcript. This slice writes the facts down.

## Decisions with Jeremy (2026-09-10)

1. **Supersede, keeping the old one dated.** A newer contradicting fact
   writes a new note and marks the old superseded rather than deleting it.
   She answers from the current one and can still say what changed and
   when.
2. **Distil everything, then keep up.** The twelve days already stored,
   then each new day. The corpus is eight documents, so the one-off pass
   is cheap and the measurement moves now rather than waiting for new
   conversation to accumulate.

## What the exploration found, and how it changes the shape

Three facts about the code as it stands, each of which breaks one of those
decisions if ignored.

- **There is no way to supersede anything.** `/save` is create-only
  (`api.py`, `store.create_topic`). A second note about the hardware
  becomes `hardware-spec-2.md` and BOTH stay indexed and both come back.
  Run a distiller for a month and there are a dozen, at least one wrong,
  all recallable. Decision 1 is not a configuration of what exists; it has
  to be built.
- **A note is dated by the moment it is written, not by the exchange.**
  `create_topic` hardcodes `created = today`, and that date is what the
  recency multiplier boosts and what the prompt prints as "today". A
  backfill of twelve days would stamp every fact as this morning's and
  rank them above the transcript they came from. Decision 2 makes this
  urgent rather than theoretical.
- **There is nowhere to put a citation.** No provenance field exists, and
  putting a path in the body is worse than nothing: the body is what gets
  tokenised, so `people`, `journals`, `2026`, `09` become search terms
  that match every other note's citation.

## The rule Jeremy added, which reshapes the slice (2026-09-10)

His words: hardware specs "can be found ad hoc and shouldn't be written. Or
if they're written, that's fine for comparing if we ever update our system
… but it should still treat the ad-hoc command as truth and be done first.
Things like that. But I can't think of every edge case so we need to build
nova to be able to think on her feet."

He is right, and it dissolves most of what superseding was for. There are
two kinds of fact and only one of them belongs in memory as an answer:

- **Live-answerable.** She has a tool that knows right now: `device_info`
  for a machine's disk and memory, `device_run` for `nvidia-smi`,
  `model_catalog_search` for what is installed, `list_agents`,
  `list_timers`, `spend_report`, `get_time`, `workspace_list_files`. "How
  much VRAM" was never a memory question.
- **Told once, stored nowhere else.** Preferences, decisions, the things
  he said that have no other source. Memory IS the source, and nothing can
  check it.

**The enumeration problem he named is avoided by deriving the set from the
live registry**, the way the capability guard already derives its verdict:
the distiller is shown the tools that exist and names the one that answers
a fact. A wrong guess costs an unnecessary note, never a wrong answer.

**And his decision on what happens then, taken 2026-09-10: the backend
runs the check itself.** A recalled note that names a live source is
checked before she answers, and she is handed BOTH — what he said, dated,
and what the machine says now. She never answers from a stale note because
a current one is always beside it.

The one place this does NOT become her judgement, stated because it is the
failure this codebase keeps catching: WHICH SOURCE WINS is code. A live
check beats a note; the note becomes "what you said on the 31st". Her feet
decide whether to check, which tool, how to say it. The ordering is one
line.

### What that costs, and how it is bounded

- **A tool call on the recall path.** It runs concurrently, under a budget
  inside core's existing recall timeout, and a check that fails or times
  out is STATED beside the note — never dropped, so a stale note can never
  quietly pass as current.
- **A stored call that runs unasked.** This is new: nothing in v4 has run
  a tool on the backend's own initiative before. So the check may only use
  a tool that CHANGES NOTHING, and `Tool` gains `reads_only` to say which.
  That moves an exact-field-set pin in `test_no_approvals.py`, deliberately
  and with the reason: this is not a permission and denies nobody anything
  — every tool stays hers to call. It answers a question the codebase has
  never had to ask, which is what the BACKEND may run when nobody asked it
  to. A tool that does not declare it cannot be an automatic check.
- The note stores the call, so it also stores its arguments (`device_info`
  needs a device name). Those are written by the distiller from her own
  tools and validated against the tool's own schema before it is stored —
  a call that would not dispatch is not written down.

## Architecture

### A distilled note is a claim with a receipt

Frontmatter gains four fields, and they are the slice:

- `subject` — what the fact is ABOUT (`hardware.vram`), chosen by the
  model from the subjects that already exist and stable across restatement.
  This is the superseding key. A missed match costs a duplicate note, never
  a wrong answer, and both carry their dates.
- `said_at` — when the exchange happened. `created` follows it, so a fact
  distilled today from a conversation two weeks ago is two weeks old to
  the ranker and to the prompt, which is what `chat._age` already refuses
  to guess at.
- `source` — the message id it came from, and **the role of that row**.
- `superseded_by` — set on the older note when a newer fact takes the same
  subject. Recall skips a superseded note; nothing is deleted, so "what
  did I have before" is still answerable.

### The model chooses words; the code chooses facts

Reuse `review.py`'s spine rather than writing a second extractor: its
window fetch, its gateway call without a turn, its tolerant JSON parse,
and above all its verification — the cited id must resolve to a row that
belongs to him. What survives is built FROM THE ROW: the quote, the
instant, the role. The model's phrasing reaches only the title.

**The one place distillation must differ, and it is the sharpest risk in
the slice.** `review.py` reads only his own messages, deliberately: once
it is a row, her promise and his are indistinguishable. But a durable fact
is usually in HER restatement ("24GB VRAM, 64GB system RAM" is her tidy
version of what he said). So distillation reads both sides — and a fact
whose only support is an assistant row is a fact supported by something
the model itself produced, which verifies nothing about the world. The
role travels with the citation, and a fact standing only on her own words
is marked as such in the note. That distinction lives in code, not in the
prompt.

### The pass

A third beat, `distil`. Four edits to add one, and the machinery — the
seed, the advisory lock, the read-back, the firing record, the timeout
bound — comes free. Two things do not come free and are decided here:

- The `proactive.enabled` switch gates every beat. Distillation is memory
  hygiene, not proactivity, and it should not be silently off on an
  install that never turned the proactive engine on. It gets its own
  condition.
- Coverage is wired to the watch beat, so a distil beat has no honesty
  line for free. It reports its own counts — read, proposed, verified,
  dropped, written — every one counted from what LANDED, never from what
  was attempted, in the shape `WatchResult` already uses.

The high-water mark is derived from the beat's own firing history, the way
the review check derives its cadence. No new table, no counter to drift.

### Measurement

The same twenty questions. Distilled notes join the fixture, the floors
move with the number in the commit, and a distilled note is short enough
that its whole text sits inside the excerpt window — which is exactly the
mechanism S13 predicted would raise the ceiling.

## Sub-slices

- **S14-1 the note shape.** The four frontmatter fields, `created`
  threaded through `/save`, superseding by subject, recall skipping a
  superseded note. GATE: two facts about one subject leave one live note
  and one dated predecessor, and recall returns only the live one.
- **S14-2 the extractor.** The shared spine lifted out of `review.py`,
  both roles read, the role carried on the citation. GATE: a fabricated
  citation is dropped; a fact standing only on an assistant row is marked.
- **S14-3 the beat and the backfill.** The third beat, its own switch, its
  counts; the one-off pass over the twelve days. GATE: the backfill dates
  each fact by its exchange, not by the pass.
- **S14-4 the measurement.** Fixture, floors, the number in the commit.

## What would make this lie

- A note outliving its fact — superseding, and the old note keeps its date.
- A fact dated by the pass rather than the exchange — `said_at`, threaded.
- A citation to her own words read as evidence — the role travels.
- A distiller reporting work it did not do — counts from rows, never from
  attempts.
- A note asserting something the transcript does not support — the same
  verification the review check already runs, against the same table.
