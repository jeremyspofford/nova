# Plan: the ingest gate on the Decision Service (Track 1 follow-up)

**Sources (binding):**
- DS1's NOTES 1–5, `docs/plans/ds1.md`.
- Tev1's NOTES 3–4, `docs/plans/tev1.md`.
- The eval harness's NOTES 1, 2 and 5, `docs/plans/evals.md`.
- The owner's decisions in `docs/plans/decision-service.md`, "Owner decisions".
- The ingest gate's own plan, `docs/plans/ingest-gate.md`.

**Branch:** `gate/decision-service`, PR #⟨n⟩. **Track:** 1.

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
6. **Nothing calls TypeSafe.** Every Jev test uses the loopback stand-in, `tests/support/jev-stand-in.ts`.

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

## Safety rules, with the evidence

- **The deterministic layer and taint tracking don't change.** `git diff origin/main -- src/core/ingest/checks.ts src/core/ingest/outbound.ts src/runner.js src/context.js src/tools.js` is empty.
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
- **When no answer is trusted** (today, without a sorting model), only the first chunk or two (the pool's width) are asked before the outcome is settled.
- **The alternative** was a hard ceiling: past N chunks, no Noul screen and quarantine. It was not taken, because the notes ask for every chunk.

## Limits, said plainly

- **Part 1's set is not under `src/core/decision-service/`.** It stays where Part 1 fixed it, `tests/ingest/tev1-eval/` (the generator, controls and manifest). Only its scoring (`eval.ts`) and verdicts are in the service. `INJECTION_SET` points there.
- **An untrusted seat's evidence** (shadow answers in `decision_record`) covers only the chunks asked before the outcome settled. Screening the rest couldn't change the verdict, and it would send content to the cloud for nothing.
- **Every change to the decision-model settings is tier 2,** including turning a switch off. The note says "changing a seat or an opt-in".
- **`PUT /models/decisions` already existed** for `{use: model | rules}`. It still does, in the same route.
- **No real Jev or Tev1 run.** Nothing calls TypeSafe, and no ingest-screen eval has passed, so a fresh Nova without a sorting model holds outside content back exactly as before.

## What changed (plain language), for the coordinator to insert at merge

**2026-10-31 · #⟨n⟩ · The safety screen now asks Nova's decision service, and checks every part of a long page**
- What changed: Nova's screen for outside content (pages, mail, files, tool output) now asks the new decision service. It checks every part of a long document, not a sample, and the parts overlap, so a trick split across a boundary is still seen. Every decision is recorded, without the content.
- What you can now do: in Settings › Models › Decision model, you can choose Jev (TypeSafe's cloud model) or a Tev1 size, and see each model's test results before you switch. Two separate switches let Jev screen outside content (Screening) or images (Box, a preview) even in local modes. Both are off, and each says plainly what leaves your machine. Health shows how outside content is being screened.
- Still unfinished: no decision model has passed Nova's screening test yet, so anything Nova can't vouch for is still held back as unsure. Jev has never been called for real (no account). A very long document screened by Tev1 takes minutes.
