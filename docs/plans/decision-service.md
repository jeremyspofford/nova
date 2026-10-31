# ADR: the Decision Service (extends Amendment 2026-10-31-B Part 1)

**Sources:**
- **The owner's input**, approved 2026-10-31 and binding for this design: `docs/builder-packet/nova-jev-decision-layer-2026-10-31.md` (copied unchanged; sha256 `e734ae0e…`). It is cited below as "the input".
- **AMENDMENT-2026-10-31-B Part 1:** Tev1 as the local decision provider, and the injection eval. It arrives with PR #244, at `docs/builder-packet/AMENDMENT-2026-10-31-B.md`. Part 4 of the same amendment specifies the golden task suite and model-swap scorecard (Track 3).
- **The Part 1 build and its eval:** PR #248, plan `docs/plans/tev1.md`, evidence `docs/evidence/tev1-eval.md`.
- **The ingest gate:** `docs/plans/ingest-gate.md` (Amendment 2026-10-30-C Part 3).
- **The packet:** ARCHITECTURE-AND-DECISIONS ADR-7 (the three-layer decision stack), CONTRACTS §2 (receipts) and §3 (decision templates), NOVA-SPEC §6 (tiers), LOCAL-MODELS, OPERATING-RULES (Noul; no Jev account).
- **TypeSafe's live documentation, read 2026-10-31** through the official Agent Skill:
  - the index at `docs.typesafe.ai/llms.txt`, and the OpenAPI spec at `api.typesafe.ai/openapi.json`;
  - the models page and request rules, primitives and the Box and Noul pages, images, confidence, the Jev 1.13 jaggedness page, confidence-gated routing, and the guardrails and feeder-cam cookbooks.

  No live API call was made: there is no TypeSafe key, and the OpenRouter route spends the owner's money.

**Status:** this is the design. Nothing here is built.
- The rework of the Part 1 code into this service starts only after this ADR merges, and the coordinator starts it.
- Each phase under Order lands as its own PR with its own gate.
- Nothing here displaces M10e–M10k.

**Tier numbers** follow NOVA-SPEC §6: 0 act silently, 1 act and report with undo, 2 ask first, 3 explicit confirmation every time.

## Decision

Nova gets one **Decision Service** in core. Every System One judgment in Nova goes through it: a typed question about a state, answered with calibrated probabilities. It has four parts:

1. **A registry** of versioned question templates. Each template is a named battery of Noul, Choice, Score and Box questions, together with:
   - the state it takes, declared field by field;
   - its policy: thresholds, a truth table from answers to outcomes, and how each outcome maps onto the tiers;
   - its pinned model per seat;
   - its eval set and recorded verdicts.
2. **One provider interface with three seats:** cloud Jev, Tev1 through Ollama on the person's own machine, and the stub. The stub means deterministic-only behaviour. The privacy mode picks the seat, exactly as Amendment B Part 1 says.
3. **A decision log in the Work Ledger:** for every decision, the template and its version, the seat and the pinned model version that answered, the full probabilities, and the policy outcome.
4. **Enforcement:**
   - subsystems ask by template id and never reach a provider themselves;
   - a battery's state is built from its declared fields only;
   - a template's thresholds count only while its eval verdict holds for the exact model version in use.

**The split, after TypeSafe's own guidance:** the model makes the judgments, and code makes the decisions. A template's questions are the inputs of a truth table, and the table lives in code, in the template's policy, where it is read, tested and versioned.

**It is built from what exists, not beside it:**

| Need | Built on | New |
|---|---|---|
| Versioned templates | `Templates` in `src/core/decide.ts`: CONTRACTS §3, with propose, dry runs, activation as a ledger task, retire and reinstate (tier 3 for built-ins) | Box questions; per-question wording for Jev's API; a declared state schema; a policy; pinned models; eval binding |
| Choosing a provider | `Decisions` in `src/core/decide.ts`: privacy mode × egress, and the first able provider | Seats by mode (§2); per-seat limits; no fall-through that breaks a privacy rule |
| The local seat | PR #248: `src/core/jev/systemone.ts` (the wire client) and `tev1.ts` (caps, chunking, worst-score aggregation, size, version check) | It becomes the Tev1 seat behind the interface |
| Deterministic answers | `RulesProvider` (System 1.5 rules per template) and the ingest gate's checks | The stub seat: rules plus each template's declared default |
| Reliance on a model | PR #248: `verdict.ts` (relied on only on a recorded pass for the installed digest) | Generalised to each (template version, seat, model version) |
| Audit | The Work Ledger, receipts (`receipts.ts`, CONTRACTS §2), and the `ingest_screen` record | One decision record for all templates; a receipt when a state leaves the device |
| Evals | PR #248: the eval harness, manifest and scoring; Track 3's Part 4 harness when it lands | Per-template eval sets in the Part 4 suite; re-runs on a model bump |

## Facts the design rests on

These come from TypeSafe's live docs and from Part 1's findings, read 2026-10-31.

| Fact | Cloud Jev | Tev1 (Ollama, local) |
|---|---|---|
| Endpoint | `POST https://api.typesafe.ai/v1/systemone`, bearer key (or OpenRouter, Vercel AI Gateway) | `POST http://<the person's Ollama>/v1/systemone`, no key |
| Wire format | `{model, state, questions: {<name>: {type, instructions, criteria?}}}` → `{model, answers, usage}` | The same format (the TypeSafe Jev API) |
| Question types | Noul, Choice, Score, Box (Box needs `jev-1.14.0` and the `TypeSafe-Danger-Zone-Images: true` header) | Noul, Choice, Score. **No images, so no Box.** |
| Question count | **No limit.** Context limits only. | **1 to 64** per request |
| Context | **64k tokens per request, 32k per question.** A long-context header raises both to 262k; it is slower and less accurate, and stays off. | About **2,000 tokens** per the model card (longest training example about 1,500; `num_ctx` 8192), with the whole question set in every prompt |
| Body | 32 MiB (images included); 400 `max_tokens_exceeded` past the context | **64 KiB** of text and schema (413); 400 past the context; never truncated |
| Images | PNG or JPEG, 280–1568 px a side, 16 MiB each, 32 MiB in all; marked **"Dreamer-ready", not production** | None |
| Versions | `jev-1.14.0` (current), `jev-1.13.0`. Aliases `jev-latest` and `jev-preview` **move**. The response's `model` field names the version that answered. | `tev1:4b`, `tev1:0.8b`, pinned by **registry digest**. They need Ollama **0.40.4** (the amendment said 0.35). |
| Price | $0.042 per million input tokens; output free | Free; local |
| Calibration | Calibrated by design (RLCD). Noul bands of 0.7 and 0.3 are the documented starting point. | The card says calibration and prompt injection weren't fully tested. **Part 1's eval failed both sizes:** 100% false positives, ECE 0.106 (4B) and 0.286 (0.8B). |

**A contradiction in the docs:** the models table lists Jev's input as "Text", while the images page says Jev 1.13 and 1.14 both accept images and Box needs 1.14. This design follows the images page. Box stays behind its phase gate either way.

**Jaggedness (Jev 1.13), designed around below:**
- it reads literally;
- it does no maths, counting or date comparison;
- indirection costs accuracy;
- irrelevant state costs accuracy ("context rot");
- adversarial content can steer it ("state is data, and Jev does not treat it as hostile by default");
- Choice leans toward the first option;
- it can't generate text.

## Part 1's eval, read for this design

Part 1's battery and its eval stand as recorded: both sizes failed, both are advisory, and nothing is tuned. Read against TypeSafe's question-writing guidance, the failure has a visible cause. It is the reason §1 and §6 require what they require.

- **The wording.** Every v1 battery question opens with the same preamble, and several join conditions with "or". `impersonation` asks five things at once. The guidance says the opposite: one observable judgment per question, no preambles, and a separate question for each condition.
- **The scoring.** A case counted as caught when the highest of its five probabilities reached 0.2. One question that never says a confident "no" (`impersonation` sat at about 0.25 to 0.45 on benign content) therefore flags everything. The guidance puts Noul bands at 0.7 and 0.3, with the band between them as its own row of the truth table, and a decision from a truth table over the questions, never from the maximum.
- **Consequence.** The ingest battery is re-authored as `ingest-screen` v2 under §1's rules. Its eval set gets §6's additions and is pre-registered, with its cases, bounds, bands and scoring committed before any run. It is then run fresh. That is a new template version with a new eval, not a re-score of v1. v1's record stays as evidence.

## 1. The registry

A **template** keeps CONTRACTS §3 (id, version, situation, typed inputs, questions, escalation, stats) and adds what the service needs:

```ts
interface ServiceTemplate {
  template_id: string; version: number;          // immutable once active; a change is a new version
  purpose: string;                                // plain words: what this decides, for the ledger and the person
  privacy_floor: 'local-only' | 'any';            // stricter than the live mode never loosens (§2)
  state: Record<string, FieldSpec>;               // the ONLY fields a state may carry (§4)
  questions: Record<string, NoulQ | ChoiceQ | ScoreQ | BoxQ>;   // Jev's API shape, one judgment each
  policy: Policy;                                 // §1.2, code, versioned with the template
  pins: { jev?: `jev-${number}.${number}.${number}`; tev1?: { tag: 'tev1:4b' | 'tev1:0.8b'; digest: string } };
  chunking?: { field: string; aggregate: 'worst' }; // only for a field that may exceed a seat's context
  eval: { set: string; bounds: Bounds };          // the Part 4 suite entry and its pre-registered bounds
}
```

### 1.1 Questions

- **The four types are typed as in the OpenAPI spec:**
  - **Noul:** `instructions`, plus optional `criteria.true` and `criteria.false`, each describing a concrete situation.
  - **Choice:** `instructions` and named options. Names describe content (`refund_request`, never `A`). The 255-option ceiling of CONTRACTS §3 stays.
  - **Score:** `instructions` and levels, lowest first, each a situation on its own.
  - **Box:** `instructions` naming the target and the image field. No criteria.
- **CONTRACTS §3's "mandatory unknown/other escape on every Choice"** is met, for Jev 1.14, by a **companion Noul** in the same template: "does anything listed fit?". The docs say this works better than a "none of the above" option. A Box always gets a companion Noul too ("is there a … in `photo`?"), because a Box always returns a location.
- **Authoring rules, checked by the registry where code can check them:**
  - one judgment per question;
  - no "or" joining conditions;
  - instructions name state fields by their path in backticks;
  - no preamble;
  - no arithmetic, counting or date comparison;
  - phrased so that true means yes.

  The validator refuses:
  - a question that names a field the state doesn't declare;
  - a Choice with positional option names;
  - a Box without a companion Noul.

  Two smells only warn: a question that joins conditions with "or", and the same leading sentence on every question.
- **Wording lives in the template and nowhere else.** That covers questions, options, criteria and thresholds, so it can be audited and edited in one place.

### 1.2 Policy: thresholds, truth table, tiers

A policy is code registered with the template version. Three things go in it:
- **Bands for each question:**
  - Noul: yes at or above `hi`, no at or below `lo`, unsettled between. The defaults are 0.7 and 0.3, per the docs.
  - Choice: the top option, with its confidence band.
  - Score: the level distribution, read as a whole, not only the expected value.
  - Box: the coordinates, and confidence when the API gives it.
- **A truth table** from the bands to an **outcome**. Every combination has an outcome, including every "unsettled", and a test enumerates them all.
- **For each outcome, the action and its stakes tier:** the tier the action would have under NOVA-SPEC §6 and the person's profile.

**How the result maps onto the tiers.** System One can only *lower* autonomy. It never raises an action above its tier:

| The template's answer | Tier 0–1 action (low stakes) | Tier 2 action | Tier 3 action |
|---|---|---|---|
| **High** (all deciding questions settled; verdict trusted) | Act (silently, or act and report, per the action's tier) | Ask, with the judgment shown as the reason | Confirm every time, as always. The judgment is evidence only. |
| **Medium** (a deciding question unsettled) | Ask | Ask | Confirm |
| **Low** (contradictory, or the seat is advisory or unavailable) | Escalate to System 2 or the person, or stop, per the template's default | Escalate or stop | Stop and confirm |

- **"Trusted"** means the template's eval verdict holds for the seat and model version that answered (§6). An untrusted answer is logged but treated as **low**.
- **Each template also declares a deterministic default**, used when the answer is low or no seat answered. For the ingest screen that default is "quarantine". For the triage template it is the rules provider's answer.
- **Weights for composite judgments** (risk, routing cost) are code in the policy, never words in a question.

## 2. One provider interface, three seats

```ts
interface Seat {
  id: 'jev' | 'tev1' | 'stub';
  egress: 'remote' | 'local' | 'none';
  limits: { maxQuestions: number | null; contextTokens: number; perQuestionTokens: number | null; maxBodyBytes: number; images: boolean };
  model(): string | null;           // the pinned version it will send, e.g. 'jev-1.14.0' or 'tev1:4b@sha256:7954…'
  available(): { ok: boolean; why: string };   // plain words
  ask(model: string, state: State, questions: Questions): Promise<{ answers; model_answered: string; usage }>;
}
```

| Seat | Egress | Limits | Version pin | Available when |
|---|---|---|---|---|
| `jev` (cloud) | remote | No question limit; 64k context per request and 32k per question; 32 MiB body; images and Box with the header (Box on 1.14 only) | `jev-1.14.0`, the explicit version, never an alias | The owner has chosen an account route and stored a key in the vault (open question 2) |
| `tev1` (local) | local (the person's Ollama; an address that could be the internet is refused) | 64 questions; ~2,000 tokens with the whole question set in every prompt; 64 KiB; no images | Tag plus registry digest | Ollama ≥ 0.40.4, the size downloaded (`tev1:4b`; `tev1:0.8b` only where memory requires) |
| `stub` | none | none | `rules@<template version>` | Always |

**Routing by privacy mode, exactly as Amendment B Part 1 says:**

| Mode | Seat order | Never |
|---|---|---|
| local-only | `tev1`, then `stub` | `jev` |
| local-first | `tev1`, then `stub` | `jev`. Local-first must not send private content to a cloud service to judge it. When Tev1 is unavailable, the answer is the stub's, not the cloud's. |
| cloud | `jev`, then `tev1`, then `stub` | n/a |

Further routing rules:
- **The stricter of the template's `privacy_floor` and the live mode wins.** A caller can tighten a mode, never loosen it; that rule is unchanged from today.
- **No fall-through ever breaks a mode.** A seat that fails is logged with its reason, and the next seat in that mode's order answers.
- **The pin is per seat, and an answer from another version is not used.** If a response's `model` field differs from the pin (`jev-1.14.0` asked, `jev-1.15.0` answered), the answer is logged and treated as **low**.
- **Per-seat limits are enforced before sending.** A state that doesn't fit a seat goes through the template's chunking rule if it declares one. Every chunk is screened and each question keeps its worst score, as in PR #248. Otherwise the decision fails to the next seat. A state is never truncated.
- **Questions are bundled:** one request carries every question of a battery about one state, up to a seat's question limit. Tev1 is split at 64, so every chunk carries every question; cloud Jev has no limit to split at. That is the docs' "speculative fan-out": code reads only the answers it needs.
- **The existing `LocalModelProvider`** is a chat model answering templates as JSON. It is not one of the three seats. It stays behind the interface as a transitional local answerer only for templates that have no Tev1 eval verdict yet. It is removed from a template once that template's Tev1 or Jev verdict passes. Open question 3 asks the owner whether it should go entirely.

## 3. The decision log

**Every decision is one record in the Work Ledger:** for a decision made inside a task, its timeline; otherwise the ledger's System One log. The record holds:

| Field | Content |
|---|---|
| `id`, `at`, `task_id` (or null), `subsystem` | Where it came from |
| `template_id`, `template_version` | Which battery |
| `seat`, `model_asked`, `model_answered` | `jev` / `jev-1.14.0` / `jev-1.14.0`, or `tev1` / `tev1:4b@sha256:7954…`. Never an alias. |
| `privacy_mode`, `egress` | The mode in force, and `none`, `local` or `remote:typesafe` |
| `state_sha256`, `state_fields` | A hash of the state, and the names of the fields sent. **Never the content.** |
| `chunks`, `requests`, `usage` | How many pieces and requests, and tokens in and out |
| `answers` | Full: every Noul probability; every Choice's `probabilities` and `confidence`; every Score's level probabilities and `confidence`; every Box's edges and `confidence` |
| `bands`, `outcome`, `action`, `tier` | The policy's reading, the truth-table row, and what it led to |
| `trusted`, `verdict_ref` | Whether the eval verdict held, and which record it was |
| `why` | Plain words, for the ledger. Never shown as Nova speaking (ADR-7). |

Further rules for the log:
- **A remote state also gets a context receipt** (CONTRACTS §2): provider `jev`, the pinned model, purpose = the template id, and egress `remote:typesafe`. The egress log is then complete, and a remote call under local-only is refused and recorded as a problem, as receipts already require.
- **The log is the raw material** for per-template stats (CONTRACTS §3: uses, agreement with outcomes, calibration drift), and for new eval cases when the person corrects an outcome.
- **The ingest gate's own `ingest_screen` record stays.** It links to its decision records.

## 4. State hygiene

**Each battery gets its own filtered state.** The service never sends "the whole context".
- **A template declares its state fields:** name, type, and a size cap per field. A subsystem passes typed values for those fields. The service builds the state from those fields alone and refuses any other field, as `checkInputs` already does for inputs.
- **No field holds "the conversation" or "the memory".** A subsystem that needs some of it retrieves and filters in code first (re-ranking and passage classification are templates of their own), then passes the few items the question needs.
- **Per-seat fit is checked before sending** (§2). A field declared `chunking: worst` is split to fit and every piece is screened. Any other field over its cap fails the decision; it is never truncated.
- **Facts code already knows are stated as fields,** so the model doesn't re-derive them: a sender's verified address, "this arrived from outside", a total code computed.
- **Images are fields too,** with the API's limits checked in code: format, 280–1568 px a side, and size. They are sent only to a seat that takes images (§5).
- **The state hash and field names are logged; the state is not.**

## 5. Box: camera, smart home, capture

Box locates a target in an image as four edges, each a fraction of the image's width or height.
- **The docs mark Box and images "Dreamer-ready",** not production. They need the images header and, for Box, `jev-1.14.0`.
- **Tev1 takes no images,** so Box exists only on the cloud seat. In local-only and local-first, a Box template uses cloud Jev only when the person has switched on the Box opt-in (owner decision 4); otherwise it is unavailable and its deterministic default applies. Camera frames stay local in local-only mode even with the opt-in on (the Smart Home ADR's camera rule, owner to confirm). Ollama's Clef models read images and could be a later local image seat; that is not designed here.

**How Nova uses Box, when its phase comes:**

| Use | Template shape | Policy |
|---|---|---|
| **Camera event** (the feeder-cam cookbook) | Noul "is there a person in `frame`?"; Box "the person in `frame`"; Noul "is there a package in `frame`?"; Box "the package in `frame`"; Choice over named zones | Code turns boxes into zone overlap and event records. Nothing acts on a frame: a camera event is a trigger that proposes. |
| **Smart home** | Choice over device and action intents; Nouls on sensor state; Box only on a camera frame that backs a request ("is the garage door open in `frame`?") | Irreversible or security actions (unlock, disarm, open) keep their tier whatever the confidence. A Box never justifies acting above tier 1. |
| **Capture** (screen frames) | Nouls: "is a password field focused in `frame`?", "is a banking app in front?". A Box locates the region to redact. | A "yes" pauses capture or redacts the region. This only ever makes capture **more** private, so it can act at tier 0. |

The rules for every Box use:
- **Consent:** frames are sent only from sources whose capture consent is on (CONTEXT-AND-CAPTURE), and only with the Box opt-in switched on (owner decision 4).
- **Owner approval:** a camera or screen frame leaving the home is a new kind of egress, and needs the owner's explicit yes (open question 4) before the phase starts.
- **Logging:** the log keeps the frame's hash and the Box coordinates, never the image.

## 6. Evals

Each template has an eval set in the Part 4 golden suite (Track 3), with its bounds pre-registered with the template version. These are the rules beyond Part 1's:
- **Pre-registration, as Part 1 did:** the cases, bounds, bands, scoring and ECE method are committed before any run, and that commit's SHA goes in every record. A failing template version is advisory, and is recorded and reported, never tuned to pass.
- **Choice order:** every Choice question that a policy acts on is run with its options in at least three orders: as written, reversed, and rotated by one. The template's eval reports the share of cases whose top option is the same in every order, and the largest change in any option's probability. The bound is that the top option agrees in at least 95% of cases. A Choice below the bound is advisory.
- **Adversarial steering, scored against the deterministic layer:** content written to argue for its own classification, or to instruct the model, is scored on the **gate's final verdict**, the deterministic layer and taint together with the model, never on the model's answer alone. A steering case passes when the combined verdict isn't the one the content argued for. The model's own scores are reported beside it. Jev is a layer, never the wall, as the docs and the ingest gate say.
- **Pinned versions in every record:** each eval record names the template version, the seat, the exact model version (`jev-1.14.0`, or the Tev1 tag and digest), the run date, and the pre-registration SHA. A verdict applies only to that tuple.
- **A model bump re-runs the evals:** a change of pinned version (`jev-1.14.0` to `jev-1.15.0`, or a new Tev1 digest) makes every affected template's verdict stale.
  - Stale means untrusted: its answers read **low** (§1.2) until the template's eval is re-run on the new version and passes.
  - The bump itself is a change to Nova, through the pipeline, carried by a ledger task.
  - Part 4's model-swap scorecard shows each template's verdict per seat and version before the person switches.
- **The Part 4 link:**
  - each template's eval set is a CAPABILITY suite in Track 3's harness;
  - its decision records feed the harness's regression cases when an outcome is corrected;
  - the harness's runner is how a bump re-runs the evals.

  Until Track 3's harness lands, PR #248's harness (`tests/ingest/tev1-eval/`) is the runner, and its `tev1-verdicts.json` is the verdict store.

## 7. No ad hoc calls

Subsystems use templates from the registry and never call a provider. The enforcement:
- **Not exported:** the seats, the wire client (`systemone.ts`) and the provider classes live under the service's folder in `src/core/` and are **not exported from `src/core/index.ts`**. Code outside the core imports only `index.ts` (an existing rule), so it can't reach a seat.
- **One entry point inside the core:** `decisions.ask(templateId, fields, { task_id?, privacy_mode? })`. Asking for an id that isn't an active template returns null, as `Decisions.decide` does today. Nothing builds a question list at call time; CONTRACTS §3 already forbids per-request schemas.
- **A boundary test** in `tests/core/` checks three things:
  - no file under `src/` other than the service's own modules imports the seat or client modules;
  - no source file outside the client contains the string `/v1/systemone`;
  - `index.ts` exports none of the seat or client names.
- **Templates come only from the registry:** built in (tested, active, tier 3 to change) or proposed through the existing propose, dry-run and activate path. A subsystem that needs a new judgment adds a template; it never adds a call.

## 8. Order

The input's use-case map is phased below as the record. **These are side PRs. They don't displace M10e–M10k, and no phase starts before the one before it is merged.**

| Phase | What | Gate |
|---|---|---|
| **DS0** | This ADR | Owner review |
| **DS1: the service** | The registry additions (§1). The seat interface with `jev` (built and tested against a stand-in; **no live calls** until open question 2), `tev1` (PR #248, reworked) and `stub`. The decision log (§3; the migration lands here, applied by Track 1). State hygiene (§4). The boundary test (§7). | Stand-in tests for every seat and limit. Every truth-table row is enumerated. The boundary test fails when a seat is imported outside the service. |
| **DS2: first uses** | **The ingest guardrails:** `ingest-screen` v2 (re-authored under §1.1; a fresh pre-registered eval, §6). **The chat guardrails:** the guardrails cookbook's battery on the person's input and Nova's output, with named policies per mode. **Model routing:** a Choice over task classes, a Score for difficulty, and cost weights in code. **The memory gate:** "a lasting fact worth remembering?", "a duplicate of …?", "contradicts …?". **Retrieval scoring:** a Score per retrieved passage, with code admitting the top set. **Trigger triage:** the existing `triage` template, migrated, plus "worth interrupting the person?". | Each template's eval passes its bounds on the seat it is relied on for, or it ships advisory, said so in Health. |
| **DS3: with M10b** | **Browser verification:** `browser-step` migrated (element matches intent, page changed as expected, dark pattern, login wall). Totals stay compared in code. | M10b's gate plus the template evals |
| **Later**, when the subsystems arrive | **Smart home and camera** (Box, §5; open question 4). **Knowledge-graph alignment:** a Score for "same entity?" with companion Nouls per field. | Their own phases' gates |
| **Recorded, not phased** | Semantic code linting in the change pipeline (as evidence beside tests); skill selection; tool-dispatch pre-check; capture classification; the self-modification risk composite; Jev as Part 4's outcome grader | Proposed when their owners pick them up |

## 9. How PR #248 (Part 1) fits

**What stays, unchanged in substance:**
- **The wire client** (`systemone.ts`). It is the same API for both seats. It gains Choice, Score and Box answers (strictly read), the bearer header and the images header for the cloud seat, and a check of the `model` field the response returns.
- **Tev1's limits and chunking** (`tev1.ts`). These are the `tev1` seat:
  - 64 questions;
  - the ~2,000-token budget with the whole question set in every prompt;
  - 64 KiB;
  - overlapping pieces, every piece screened, worst score wins, split-and-retry;
  - size selection;
  - the version check at 0.40.4.
- **The verdict rule** (`verdict.ts`): relied on only on a recorded pass for the exact digest, recomputed in CI. It becomes the service's eval-binding rule for every seat (§6).
- **The eval method** (`eval.ts`) and **the harness** (`tests/ingest/tev1-eval/`). Pre-registration, the manifest, corpus-only attack cases, and bins and ECE all carry over as the method for every template's eval.
- **The v1 results** (`docs/evidence/tev1-eval.md`): kept as the record of `ingest-screen` v1 on Tev1. Both sizes failed, both are advisory.

**What moves into the service:**
- **The battery wording.** `INGEST_BATTERY` moves out of `tev1.ts` into the registry as `ingest-screen`'s questions, and v2 is re-authored there (§1.1).
- **The reliance switch.** `boundToVerdict` gives way to the service's policy layer. "Advisory" becomes "trusted: false", which reads **low** (§1.2).
- **Health and the device record.** The provider's `status()` lines become the seat's status.
- **The proposed gate patches** (#248 NOTES 1–4). Accepting Tev1's answers and the wiring become the gate calling `decisions.ask('ingest-screen', …)`. Every chunk screened, overlap and the bounded pool still apply to the gate's own chunking, and Track 1 still applies them.

**What doesn't change:**
- the deterministic layer and taint tracking, in every mode;
- the gate's verdicts: pass, quarantine, block;
- the rule that nothing passes on an advisory model's say-so.

## Hard limits during the build

- **No live API calls to TypeSafe or OpenRouter** until the owner picks an account route and a budget (open question 2). The `jev` seat is built and tested against a loopback stand-in of the documented API.
- **No secret in the repository, the logs or a decision record.** The key lives in the vault.
- **No camera or screen frame leaves the home** before open question 4 is answered.
- **No template's thresholds are trusted** without a passing, pre-registered eval on the exact model version.

## Packet conflicts

- **CONTRACTS §3's "unknown/other escape on every Choice"** is met by a companion Noul (§1.1), following the vendor's guidance for Jev 1.14. The contract text should say "an escape, as an option or a companion Noul". That is a packet edit for Track 1; see NOTES.
- **ADR-7 names Jev as the first implementation of the decision interface** and a local model or rules for local-only. This ADR keeps that, with Tev1 as the local seat. The transitional `LocalModelProvider` (§2) is the existing local implementation and is retired per template.
- **The ingest gate plan's "private content never goes to a cloud screener, in any privacy mode"** conflicts with Amendment B Part 1's "cloud mode uses the cloud Jev service". The amendment is newer and governs Part 1. This ADR keeps `ingest-screen`'s `privacy_floor` at `local-only` until the owner says otherwise (open question 1), because outside content often carries the person's private data (their mail, their files).

## Owner decisions (2026-10-31)

1. **The ingest screen in cloud mode: decided, yes.** In cloud mode, outside content goes to cloud Jev for screening whenever Jev is set up as the decision (System One) model.
   - **Local-only mode** gets a toggle to use Jev anyway, until a local model passes its template's eval.
   - The toggle is off by default.
   - While it's on, screened content leaves the machine, and the setting says so in plain words: local-only isn't strictly local for screening while it is on.
   - This replaces the ingest gate plan's "never in the cloud" for this one case, by the owner's choice.
2. **Route and models: decided, the person chooses.** Providers and models for every seat are the person's choice.
   - Nova shows its recommendation, and a plain notice when the chosen provider or model isn't one it recommends.
   - Each model's eval scorecard (Amendment B Part 4) is shown before switching.
   - No live call is made until the person has set a route up.
3. **The transitional local model: decided, retire it per template.** Today's screener is the local chat model assigned as the "sorting model". It answers Nouls as a general chat model, with no eval behind it. It is retired for a template once Tev1 or Jev passes that template's eval.

4. **Box and images: decided, opt-in to cloud Jev in every mode.** Tev1 doesn't yet work well enough (Part 1's eval), and it takes no images. So Jev is an opt-in for what the local seat can't do, even in local-only mode. That includes Box on camera and screen frames, sent to TypeSafe's cloud.
   - **Off by default.** Each feature is switched on on its own (screening; Box on images), so turning one on doesn't turn on the others.
   - **A plain notice** says what leaves the machine, images included, and that local-only isn't strictly local for that feature while it is on.
   - **Box stays labelled preview** while TypeSafe labels it so.
   - **The local seat stays the goal:** Tev1 is re-authored and re-evaluated (v2), and each feature returns to local once a local model passes that template's eval.

## NOTES for Track 1

**`docs/LEDGER.md`, under `## Decisions`:**

> **2026-10-31 (Decision Service ADR; extends Amendment B Part 1).** Owner input `nova-jev-decision-layer-2026-10-31.md` (copied unchanged).
> - **The decision:** ADR `docs/plans/decision-service.md`. Every System One judgment goes through one Decision Service:
>   - a registry of versioned templates (Noul, Choice, Score and Box questions; declared state; a policy as a truth table mapped onto tiers; pinned models; pre-registered evals);
>   - one provider interface with three seats (cloud Jev; Tev1 through Ollama; the stub, which is deterministic-only), routed by privacy mode as Part 1 says: local-only and local-first never use Jev;
>   - every decision logged to the Work Ledger with the template version, the pinned model that answered, the full probabilities and the policy outcome;
>   - no ad hoc provider calls (seats not exported from core; a boundary test).
> - **Part 1's eval** (#248: both Tev1 sizes failed, advisory) stands. `ingest-screen` is re-authored as v2 under the vendor's question rules, with a fresh pre-registered eval.
> - **Phases DS1–DS3** are side PRs and don't displace M10e–M10k.
> - **Owner decisions:** the ingest screen goes to Jev in cloud mode, with an off-by-default toggle for local-only; the person chooses providers and models, with recommendations and notices; the sorting-model screener is retired per template once a decision model passes its eval. Box on camera and screen frames may go to cloud Jev as a separate opt-in, in every mode, until a local model can do it.

**`docs/builder-packet/ROADMAP-AND-GATES.md`:** a line in the Amendment B section, or after "Ingest security gate":

> - **Decision Service (owner input 2026-10-31, extends Amendment B Part 1):** `nova-jev-decision-layer-2026-10-31.md`, designed in `docs/plans/decision-service.md`. Built as side PRs DS1 (the service: registry, seats, decision log, boundary test), DS2 (ingest and chat guardrails, model routing, memory gate, retrieval scoring, trigger triage) and DS3 (browser verification, with M10b); smart home, camera and knowledge-graph alignment later. It doesn't displace M10e–M10k. Gate per template: a pre-registered eval passing on the exact model version, or the template ships advisory.

**`docs/builder-packet/CONTRACTS.md` §3, a one-line edit:**

> "mandatory `unknown/other` escape on every Choice" → "mandatory escape on every Choice: an `unknown/other` option, or a companion Noul asking whether any option fits (preferred for Jev 1.14)", and "questions[] (typed: Choice ≤255 options / Score / Noul)" → "questions[] (typed: Choice ≤255 options / Score / Noul / Box)".

**Migrations:** one, in DS1: the decision record (§3). Track 1 applies it with DS1, not with this ADR.
