# S40 carries: what engines and measurement identity leave for later

Every item here was found and **deliberately not fixed in S40**, with a reason.
The review trail lives in the SDD ledger (per-task reviews, the whole-branch
review with adversarial verification, the fix wave and its re-review), and the
rulings are summarised in [`slice-40-engines.md`](slice-40-engines.md).

## Needs a second engine (S44 and later)

- **`engines.client` sends no bearer to a non-builtin engine.** `Ollama.headers()` returns `{}`, and tags, ps, show, pull and delete send no auth. Meanwhile 009's `providers_engine_link_has_token` requires a token on those rows. S44 must make every ollama-adapter call send its `static-bearer`.
- **A bare pull is confirmed on any machine.** `tools/models._installed_row` would confirm a bare pull against the same model already on another machine. It should confirm only on the default engine.
- **Bare-span backing across machines.** "I pulled dell:qwen3:8b" is backed by `model_pull(model="qwen3:8b")`, whose bare target is the builtin. It should be read as the default engine, derived and never the literal `hub`.
- **The catalogue bypasses the wake guard.** `catalog.engine_section` and `installed_names` call `list_models` on every engine directly, so a catalogue page could wake a sleeping machine. They must go through `engines.observe` or skip `wake_on_lan` engines (S46).
- **The shadow check does not re-run on make-default.** A provider created while a cloud provider is the default can shadow an engine's bare tags once that engine becomes the default again. Qualified ids shrink the risk.
- **Web: bare ids assume the one ollama row.** `ProvidersSection.tsx` and `catalogFormat.ts` treat a bare id as the single ollama-adapter row, where the gateway's rule is "bare = default provider". Harmless while `hub` is the only engine.
- **Web: `ContextGauge.windowFor`** could match a `library:` row by bare name once a model is installed on one engine and only in the library on another.
- **Catalogue kind vs engine name.** The catalogue kind `'hub'` (Hugging Face) shares its word with the engine `hub`.
- **ReadTimeout before headers counts as unreachable** only for proxied dials (C12). Arrives with the tailnet transport in S43a.
- **The tile shows no VRAM or fit.** The `/admin/engines/{name}` detail is not used by the web yet.
- **The EngineView `facts` block does not cross to core.** `machine_json`/`machine_status` drop it, so an omitted `compute` loses its reason on the way.

## Found by the live walk (2026-09-19)

- **The turn that switches off its own engine cannot deliver its confirmation.**
  - In turn `1dcaaedd`, `machine_configure` read back `serving=false`. The closing round was then routed, the chain passed over `hub`, and with no other link the turn ended as the stated failure "I didn't get a response … hub is switched off", with the switch listed under "what ran".
  - That is honest, but the owner sees an error for an action that succeeded.
  - Proposed fix: **a turn finishes on the engine it started on**. The serving switch governs new turns, not the remaining rounds of the one in flight (a turn-scoped pin, e.g. core names the round-1 provider on rounds 2+).
  - This matters more from S44 on, when switching engines is routine.
- **HEADLINE: she states a machine's live state without checking it this turn.** After core was redeployed with the text fix, turn `b02a5694` asked the same question again.
  - She did **not** call `machine_status`; the only span was a backend auto-run of `model_catalog_search`.
  - She still answered "hub … Serving: On … Last Reported: 2026-09-19T05:15:39", which is the **first** walk turn's timestamp. She replayed her earlier answer from history as current state.
  - No guard fired: `state_claim` does not know machine names (deferred to S44 in the plan).
  - **Moved forward to S40b, before S41:** `state_claim_check` gains live machine names as subjects, with evidence only from this turn's `machine_status` fact (`checked_now: true`) or a machine tool span. S19's history stamp (a past turn's facts are dated when replayed) is the matching second half.
- **She named the wrong model as current.** In turns `b851aa91` and `b02a5694` she said "qwen3.8:27b ✅ Current model in use" while `served_by` was `hub:qwen3:8b`.
  - Replacing the id-rule example that named `qwen3.8:27b` did **not** cure it. The second turn repeated the claim with the example gone, so the source is her own earlier reply in history plus recalled notes.
  - The mechanical backstop is `where_served_claim` (planned in S44; a candidate for S40b as well), backed by this turn's `llm_call` `served_by`.
- **She inflated an embedder timeout into an outage.** She said "the memory service is currently unreachable (ConnectError)". The recall span said only that the semantic half timed out (the embedder took more than 1.59 s just after core restarted), and memory was healthy. `stack_claim` does not cover the memory service. Pre-existing, but seen here.
- **"No model was needed for this calculation"** (turn `60834ccf`, served by `hub:qwen3:8b`) is a false claim about her own process, and no guard covers it. It is an 8B quirk; recorded.

- **`reads-the-skill-before-doing-the-work` went from 3/3 (v13) to 1 of 2 graded (v14) on `hub:qwen3:8b`.** Inconclusive at this sample size (one v14 run was ungradeable). S40 grew her toolset by two and her prompt by a sentence, so re-measure at N≥6 before deciding it is noise.

## Honesty guards

- **Natural fabrications are not caught.** "I switched hub off." and "I turned hub off." pass silently. Every alternative needs a serving noun, so that "I switched the lights off" stays quiet. The derived fix passes the live machine names into `narration_check`, the way `capability_claim_check` takes `available_tools`, and compares the claimed direction (off/on) with the span.
- **`_claims_in`'s `by <word>` exemption** also exempts an instrumental "by <gerund>". This is pre-existing, and it now affects `configured_machine`.
- **`state_claim` is not backed by `machine_status`.** Machine subjects arrive with S44.
- **The checks eval case** can score an honest answer red under a cloud model when hub is really down ("the local model is unavailable") until the serving-state guard learns engines.

## Routing and the serving switch

- **No-role requests ignore the serving switch.** Only the role walk reads `serving`; an eval naming its model or `model_read` is still served on a switched-off engine. The UI copy says exactly this (fix wave B5).
- **A chain whose only link is switched off fails.** With no next link and no serving standby, that is a stated failure. On the live stack the chat chain is `["hub:qwen3:8b"]` alone, so switching `hub` off makes chat unanswerable until it is switched back on in Settings. That is owner decision 3's "no next link" case, stated rather than routed around.
- **A standby 503 omits the standby's own words** when the standby engine is not a chain link and its dial fails at connect.
- **The Routing section's verdicts go stale** after a switch on the same tab. They re-read on mount only.
- **The switch's read-back is a full-card GET.** It can take 10 s or more on a busy engine (observe, then nvidia-smi, then `/api/ps`).

## Measurement

- **Cloud rounds get no speed history.** `_RATES_SQL` excludes spans without `served_on`, and cloud rounds carry none.
- **Stall keys vs bare keys.** Stall keys stay the requested id (`hub:…`) while `inference_degraded` keys are the bare model.
- **The notice key moves** from `peer_down:ollama` to `peer_down:hub`, and an open `inference_degraded` notice re-fingerprints once, because `served_on`/`runtime` joined its facts.
- **The spend report shows `ollama` and `hub` as separate providers for September.** History keeps `ollama` by design.
- **The isolated GPU e2e compose** now reads "no nvidia-smi" as "CPU engine" (`absent=True`), which changes what that harness measures.

## Deploy and ops

- **The documented rollback in the task text was wrong, and was replaced after a drill.** `pg_restore --clean --if-exists` cannot drop `providers` while `engines` references it. The correct rollback (drilled on copies of live data): stop gateway and core; drop and recreate the database; restore the pre-S40 dump; re-tag `nova-*:pre-s40`; bring the stack up. See `deploy/README.md` → Machines.
- **Migration numbers:** core 035 and gateway 009 are taken. doing-things S30 must renumber.
- **The mini PC holds a stopped platform-line stack under the compose project name `nova`** (`hub-p0-measurements.md`). S41/S45's installer must refuse a foreign `nova` project.

## Found in passing, not S40's

- **Memory's `test_distilled_notes`** (two tests) compares `date.today()` (local) with a note stamped in UTC, so between UTC midnight and local midnight they fail. Both pass under `TZ=UTC`.
- **`queued.next_waiting_conversation`** filters `claimed_at` but not `cancelled_at` (from item 0).
- **`test_chat_attachments.py`** has an unused import, and one attachments test logs "chat turn … failed unexpectedly" while it passes.
