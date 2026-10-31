# Plan: the ingest gate on the Decision Service (Track 1 follow-up)

**Sources (binding):**
- DS1's NOTES 1–5, `docs/plans/ds1.md`.
- Tev1's NOTES 3–4, `docs/plans/tev1.md`.
- The eval harness's NOTES 1, 2 and 5, `docs/plans/evals.md`.
- The owner's decisions in `docs/plans/decision-service.md`, "Owner decisions".
- The ingest gate's own plan, `docs/plans/ingest-gate.md`.

**Branch:** `gate/decision-service`, PR #258. **Track:** 1.

## The owner's decisions, as built

1. **Cloud mode screens with Jev once Jev is set up as the decision model.** The gate no longer forces its screen local-only. The service routes it by the live privacy mode.
2. **Local-only gets a screening toggle for Jev.**
   - It is off by default.
   - Beside the switch, and again while it is on, it says: "Local-only isn't strictly local for screening while it is on."
   - A receipt under local-only is accepted for a remote call only when it names this opt-in, for Jev.
3. **Box is a separate switch,** labelled Preview.
   - It never goes to a cloud provider in local-only, whatever the switch says.
   - The service refuses it, and so does `Receipts.record`.
4. **The person chooses** the Jev route and model and Tev1's size.
   - Nova shows its recommendation.
   - Every notice is shown before anything is saved: another route, another Jev version, another Tev1 size, a model with no passing eval, and each opt-in that is on.
   - A change is tier 2: `PUT /models/decisions` without `confirm: true` answers 409 with the notices.
5. **The sorting-model screener is retired per template** once a decision model passes that template's eval. This is the service's rule. Health and Settings say which templates it is retired for. Today that is none.
6. **Capture-derived text** (screen text, transcripts, anything Capture took in), by the owner's decision in `decision-service.md` §2.1 (PR #260): never a cloud seat in local-first or local-only; in cloud mode only with that source's own opt-in, off by default. No such switch exists yet, so today it never goes to a cloud seat in any mode. The rule is one place (`cloudAllowed`), with the per-source check ready for the switch.
7. **Nothing calls TypeSafe.** Every Jev test uses the loopback stand-in, `tests/support/jev-stand-in.ts`.

## The notes, as applied, each with its test

| Note | What changed | Tests |
|---|---|---|
| DS1 1: the gate asks the service | `Ingest` takes `ask` (the service, for `ingest-screen`) and `screening` (how it stands, for Health) in place of `decisions`, `ready` and `providerId`.<br>Per chunk, an answer is used only when its `trust` is `verdict` or `legacy` and all five probabilities are numbers in [0, 1]. Anything else is no screen: the deterministic layer plus quarantine, as before.<br>`ingest_screen.model` names who answered, for example `legacy:sorting-model` or `tev1:tev1:4b@…`. | `tests/ingest/gate-service.test.ts`; `tests/ingest/screen.test.ts` (updated, see below) |
| DS1 2: the wiring | `createDecisionService(...)` in `src/core/index.ts`:<br>• the sorting model (`LocalModelProvider`) is the transitional seat;<br>• the Jev key is read from the vault as `decisions.jev` at call time;<br>• the receipt is taken before anything goes to the cloud;<br>• records go to `decision_record` through `DbLog`;<br>• `ds.refresh()` runs at start and after `/models/refresh`. | `tests/ingest/fallback-matrix.test.ts`, `tests/core/decision-settings-api.test.ts` |
| DS1 3: receipts' `opt_in` | `ReceiptInput.opt_in` (`screening` or `box`) is stored with the receipt. Local-only accepts a remote receipt only with `opt_in: 'screening'` and `provider: 'jev'`, never Box. | `tests/core/decision-record.test.ts` |
| DS1 4: Health, the device record, Settings | • Health › Outside content: the screen's state, then one plain line each for Tev1, Jev and the sorting model, and whether answers are relied on or held back as unsure.<br>• The hub's device record: `decision_model`.<br>• `GET /models/decisions` returns `ds.view()` plus the settings (the key only as `key_set`), the opt-in words and the mode.<br>• `PUT /models/decisions`: 422 with `problems`; tier 2 with the notices; the key to the vault only; `{use}` still chooses between the sorting model and the rules.<br>• Settings › Models › Decision model: route, model and key; Tev1 size; the two switches; notices; scorecards. | `tests/core/decision-settings-api.test.ts`, `tests/ui/gate-decision-model.test.ts` |
| DS1 5: the migration | `0019_decision_record.sql` adds:<br>• the `decision_record` table (not replicated);<br>• `receipt.opt_in`, with the receipt's sync triggers recreated so a standby gets the column. | `tests/core/decision-record.test.ts` |
| Tev1 3: every chunk screened | `MAX_CHUNKS` and sampling are gone. A pool of `SCREEN_CONCURRENCY` (2) asks for every chunk. Once a chunk has no trusted answer, nothing more is sent: the outcome is already "held back". | `gate-service.test.ts` (pool, every chunk, early stop); `screen.test.ts` long content |
| Tev1 4: 200-character overlap | `OVERLAP = 200`. A boundary never splits a surrogate pair. | `gate-service.test.ts`; the flipped assertion in `tests/ingest/tev1-eval.test.ts` |
| Evals 1: the scorecard route | `GET /evals/scorecards` and `/evals/scorecards/status`. Targets come from the provider registry and the hub's installed models. | `decision-settings-api.test.ts` |
| Evals 2: scorecards before a switch | Settings › Models shows a scorecard line under each assigned or recommended role and each installed model, or a plain "No scorecard … You can still switch to it". Settings › Providers' chat recommendation carries the target's status words. Tokens only. | `tests/ui/gate-decision-model.test.ts` |
| Evals 5: `INJECTION_SET` | It points at Part 1's set, `tests/ingest/tev1-eval/cases.ts`, loaded as a set module and mapped from Part 1's shape. An attack keeps its corpus item's `expect`; a transform must at least be held back. | `tests/core/evals.test.ts` (the pinned path, updated); `tests/acceptance/evals-regression.test.ts` (99 of 99) |
| Inventory | A row for the ingest gate itself. The Tev1, DS1 and eval-harness rows' gaps are brought up to date. | — |

## Gate tests changed, and why

Each change is required by a note.
- `tests/ingest/screen.test.ts`:
  - `setup()` wires `ask` (DS1 1).
  - The pass test expects `legacy:sorting-model` in place of `local-model`. The record now names the seat and model (DS1 1).
  - "a provider that isn't the local model" became "an answer the service doesn't trust". The gate no longer checks a provider id; the service says what is trusted (DS1 1).
  - "a remote decision provider is never asked" became "asked only as the person allows, and never decides untrusted". The forced local-only is dropped (DS1 1, owner decision 1). A remote provider still can't be the sorting model.
  - The long-content test (line 177) expected a 16-chunk sample and `partial: true`. It now expects every chunk, overlapping (Tev1 3–4).
- `tests/ingest/core.test.ts:41` and `tests/ingest/egress.test.ts:35` expect `legacy:sorting-model` (DS1 1). The egress test's header now says that no Jev route is set there.
- `tests/ingest/tev1-eval.test.ts`: the assertion marked "NOTES for Track 1, item 4" is flipped (Tev1 4).
- `tests/ingest/tev1-eval/harness.ts` asks the Tev1 seat through `ask`, still unbound (DS1 1).
- `tests/core/evals.test.ts`: the pinned default path (evals 5).
- `tests/core/tev1.test.ts:52` (DS1's seat test) expects `tev1:4b@aaaa4b`: since review item 4 the seat answers as the build it re-read after answering.

## Safety rules, with the evidence

- **The deterministic layer and taint tracking don't change.**
  - `git diff origin/main -- src/core/ingest/checks.ts src/core/ingest/outbound.ts src/context.js src/tools.js` is empty.
  - `src/runner.js` changes only in what a screen is told (review item 1): each `ingest.screen(...)` call now carries the run's own privacy mode and task (`screenScope`), and `screenReport` takes the helper task's mode. No line of taint tracking (`run.taint`, `taints()`, `outsideRead()`, the guards) changed.
- **The fallback never loosens:**
  - `tests/ingest/fallback-matrix.test.ts` runs the gate's corpus (31 injections, 15 benign) through the real core.
  - `tests/ingest/canary-matrix.test.js` runs the canary attack (visible and hidden pages) through a whole Nova.
  - Both cover local-only, local-preferred and cloud-allowed, each with the seats:
    - **unavailable:** Tev1's Ollama doesn't answer, and Jev's route fails, with the screening opt-in on;
    - **untrusted:** both answer, seeing nothing wrong, with no passing eval and the opt-in on;
    - **a trusted stand-in:** passing verdicts in memory, the opt-in off.
  - With no trusted seat:
    - every verdict is at least as strict as the baseline (no seat: checks plus quarantine);
    - nothing passes, and no model's answer is used;
    - no canary leaves, every guarded step asks, and memory waits.
  - With a trusted seat that sees nothing, the checks still catch every injection. With one that sees an injection everywhere, everything blocks.
  - In a local mode with the opt-in off, Jev receives nothing.
- **The fresh-user test** (`tests/acceptance/fresh-user.test.ts`) passes.
- **The eval suite:** the regression suite is 23 of 23 with stand-ins, and the injection suite 99 of 99.

## Cost: screening every chunk

These figures are measured against the stand-ins with `node tests/support/screen-cost.ts 2000000`: one 2,000,000-character document, the most `check()` passes on in full.
- **Chunks:** 715.
- **Tev1:**
  - about 3 requests per chunk, because its ~2,000-token budget holds the whole question set: 2,143 requests and about 2.0 million input tokens;
  - on real hardware, at Part 1's measured latency, that is minutes, not seconds.
- **Jev:** 1 request per chunk, 715 requests and about 1.0 million input tokens. These would be billed to the person's TypeSafe account. No price is assumed here.
- **These are the trusted path's figures.** A seat is asked for every chunk only when its answers decide.
- **Untrusted seats** (no passing eval: today, every decision model) are a bounded sample (review item 5):
  - asked for the first `SHADOW_CHUNKS` = 2 chunks of a piece of content, never more;
  - at most `SHADOW_PER_DAY` = 200 asks per seat per UTC day, across all content;
  - nothing is asked of any seat once the outcome is settled (a chunk with no trusted answer).

  The reviewer's probe p7 (a 2,002,000-character page, Jev untrusted, a sorting model assigned) asked Jev 715 times before. It now asks 2.
- **A time limit:** a screen stops after `SCREEN_TIME_LIMIT_MS` = 180 s, without waiting for a request in flight. Content that can't be screened within it is held back as unsure, never passed on part of it. At Tev1's real speed, the longest documents (about 2,100 requests) will hit this limit and be held back.
- **The cost caps** (`src/core/caps/`, #256) are not used here. They meter an agent run's tool steps and model tokens per task and per day, and stop the run at a ceiling. Charging the gate's screening to them would let screening use up the person's budget for their own work and stop it. The gate has its own bounds (above). Jev's trusted traffic is billed to the person's TypeSafe account and shown in receipts; a dollar ceiling for it needs TypeSafe's prices, which Nova doesn't have.

## After the review (adversarial review of #258 at cf024dbf)

Each finding got a test first. The fix was then made, and the test was run again with only that fix undone (`revert-check.py` in the review's scratchpad: each fix undone in place, the test run, the file restored). Every test below fails with its fix undone and passes with it.

| Item | Reproduced | Fix | Test (fails without the fix) |
|---|---|---|---|
| 1. A run's or task's own local-only mode was ignored | Yes (p2: Jev got the private file; the receipt said cloud-allowed) | The screen is held to the strictest of the person's setting, the mode the caller names (the runner's run, a helper's task) and the mode of the ledger task it runs inside (`TASK_CONTEXT`, set around every worker run). The task id goes to the record and the receipt. | `tests/ingest/run-mode.test.js` (a run, a helper's files, its report, with controls); `gate-review.test.ts` "1." |
| 2. Stale plan: a switch turned off mid-screen still sent | Yes (p1 cases A and B) | The mode and the opt-ins are read again right before a cloud seat is asked and before every request it makes (`beforeSend`). `Receipts.record` holds a decision model's receipt to the live mode and opt-in, not the caller's label. | `gate-review.test.ts` "2. A", "2. B", "the receipt is held to the live setting" |
| 3. Records could hold content | Yes (p3: a 422 echoing the state) | The wire keeps a status and a fixed reason, never the other side's words. A model name is kept only when it looks like one. The service records an error's words only from Nova's own error classes. The sorting model's own `why` is dropped. The gate logs an error's class, not its message. | `gate-review.test.ts` "3." (both) |
| 4. A swapped Tev1 build could decide for ~60 s | Yes (p4) | Tev1 reads the digest again after every answer and answers as `tag@digest`. The pin compares the whole `tag@digest` the service asked for. | `gate-review.test.ts` "4." |
| 5. Unbounded shadow traffic; no time limit | Yes (p7: 715 Jev calls) | 2 chunks per piece of content and 200 asks per seat per day for untrusted seats; a 180 s limit per screen; the cost claims corrected (above). | `gate-review.test.ts` "5." (both) |
| 6. Capture-derived text reached Jev | Yes (code path, `index.ts:507`) | The owner's rule for capture-derived text, in `DecisionService.cloudAllowed`: never a cloud seat in local-first or local-only; in cloud mode only with a per-source opt-in (`captureOptIn`, always off: no switch exists yet). The gate marks it (`from: 'capture'`, or kinds ocr and transcript). Settings says so beside the Screening switch, whose own words are unchanged. | `gate-review.test.ts` "6."; `tests/ui/gate-decision-model.test.ts` |
| Receipt content | Yes | The gate's receipt names the task and carries the judged state's hash as an `outside` context item. | `gate-review.test.ts` "the gate's receipt names its task" |
| Replication skew | Yes (`mesh/sync.ts` refused unknown columns) | Behaviour as stated under Limits: the trigger carries `opt_in` only when it is set, and a newer node leaves out new columns of an otherwise complete row (a malformed name, or a row missing the table's columns, is still refused). | `gate-review.test.ts` "sync: …" (a standby on migration 0018) |
| API input dropped silently | Yes | `PUT /models/decisions` answers 422 for `{use}` with other fields, an unknown field, and an `opt_in` that isn't `{screening, box}`. | `decision-settings-api.test.ts` |
| Wording not tied to the verdict | Yes | `wordingOf(template)` hashes the wording. A verdict record carries the wording it ran on (Part 1's file: `PART1_WORDING`), and a reworded template with the same version is untrusted. CI checks that `ingest-screen` v1 still hashes to `PART1_WORDING`. | `gate-review.test.ts` "a verdict is tied to the wording" |
| Temp folders | — | The gate tests remove the homes they make (`startNova`'s close, the matrices, the API test, `screen.test.ts`, the UI test, the cost tool). Folders the tests didn't make were left alone. | — |

The reviewer's probes p1–p4 and p7, run on the fixed tree: Jev gets nothing after the switch (A, B and C); nothing for the local-only task (0 requests, no remote receipt); no content in `why`, `failures` or the logs; the swapped build's answer is untrusted (quarantine); 2 Jev asks per page instead of 715.

## Limits, said plainly

- **Part 1's set is not under `src/core/decision-service/`.** It stays where Part 1 fixed it, `tests/ingest/tev1-eval/` (the generator, controls and manifest). Only its scoring (`eval.ts`) and verdicts are in the service. `INJECTION_SET` points there.
- **An untrusted seat's evidence** (shadow answers in `decision_record`) covers at most the first 2 chunks of each piece of content, and at most 200 asks per seat per day.
- **Capture-derived text is screened on arrival today.** Capture's triage pass (`capture/capture.ts` `propose`, wired in `src/core/index.ts`) screens each captured event before triage reads it. Under the owner's decision (§2.1) it is screened by local seats and Nova's own checks only. The decision's two jobs are follow-ups, not built here:
  - sensitive-content detection at indexing;
  - injection screening at recall, with use-time-only screening.
- **The browser's own reads** are held to the mode of the browser task they run in through the ledger's task context. A read outside any task follows the person's setting.
- **A standby a release behind** (no `receipt.opt_in`) still takes every receipt that has no opt-in, because the trigger carries the column only when it is set. A receipt that names an opt-in is refused by such a standby (its sync stops with a problem) until the standby updates. From this release on, a standby leaves out a column it doesn't have yet when the row is otherwise complete.
- **Every change to the decision-model settings is tier 2,** including turning a switch off. The note says "changing a seat or an opt-in".
- **`PUT /models/decisions` already existed** for `{use: model | rules}`. It still does, in the same route.
- **No real Jev or Tev1 run.** Nothing calls TypeSafe, and no ingest-screen eval has passed, so a fresh Nova without a sorting model holds outside content back exactly as before.

## What changed (plain language), for the coordinator to insert at merge

**2026-10-31 · #258 · The safety screen now asks Nova's decision service, and checks every part of a long page**
- What changed: Nova's screen for outside content (pages, mail, files, tool output) now asks the new decision service. It checks every part of a long document, not a sample, and the parts overlap, so a trick split across a boundary is still seen. Every decision is recorded, without the content.
- What you can now do: in Settings › Models › Decision model, you can choose Jev (TypeSafe's cloud model) or a Tev1 size, and see each model's test results before you switch. Two separate switches let Jev screen outside content (Screening) or images (Box, a preview) even in local modes. Both are off, and each says plainly what leaves your machine. Health shows how outside content is being screened.
- Still unfinished: text from Capture (screen text, meeting transcripts) is screened only on your devices; a switch to let Jev screen it in cloud mode is for later. No decision model has passed Nova's screening test yet, so anything Nova can't vouch for is still held back as unsure. Jev has never been called for real (no account). A very long document screened by Tev1 takes minutes.
