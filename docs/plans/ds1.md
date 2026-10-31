# Plan: DS1, the Decision Service (registry, seats, decision log)

**Sources:**
- The Decision Service ADR, `docs/plans/decision-service.md`, as merged with the owner's decisions of 2026-10-31 (PR #250). It is binding, and "the ADR" below.
- The owner's input, `docs/builder-packet/nova-jev-decision-layer-2026-10-31.md`.
- Amendment 2026-10-31-B Part 1, and its build, PR #248: `docs/plans/tev1.md`, `docs/evidence/tev1-eval.md`.
- TypeSafe's Agent Skill and live docs, read 2026-10-31: the OpenAPI spec; the models page; request rules; primitives, Box and images; confidence; Jev 1.13 jaggedness. No live API call is made anywhere in DS1.

**Track:** Track 2, a side PR. It owns the Decision Service code and its tests, and this plan. It doesn't edit:
- the ingest gate, or any other consumer;
- migrations;
- `src/server.js` or the wiring in `src/core/index.ts`;
- shared UI;
- the LEDGER, the roadmap or the inventory.

What those need is written under **NOTES for Track 1**. The service and its tests are self-contained, and pass CI on their own.

## What DS1 builds

Everything is in one folder, `src/core/decision-service/`.

| File | What it is |
|---|---|
| `types.ts` | The four question types and their answers (Noul, Choice, Score, Box), as in TypeSafe's OpenAPI spec; templates, fields, policy, decision records. |
| `registry.ts` | Template validation against the ADR's §1.1 authoring rules, and the registry of versioned built-ins. A version is immutable: a change is a new version. |
| `policy.ts` | Bands per answer; the truth table, every row enumerated and checked; the mapping from outcome and quality onto the tiers (ADR §1.2). System One only lowers autonomy. |
| `state.ts` | State hygiene (ADR §4): declared fields only, caps never truncated, and images checked against TypeSafe's limits in code. |
| `wire.ts` | The Jev API client, moved from Part 1's `systemone.ts` and widened to all four answer types. It reads strictly and does no repair. It handles the bearer key and the images header, never sends the long-context header, and reports the `model` that answered. |
| `seats/tev1.ts` | Part 1's `Tev1Provider`, moved, as the **Tev1 seat**: ≤ 64 questions, ~2,000 tokens with the whole question set per prompt, 64 KiB, every piece screened with the worst score winning, split-and-retry, size, the 0.40.4 check, and local addresses only. |
| `seats/jev.ts` | The **cloud Jev seat**: no question limit; 64k tokens per request and 32k per question; 32 MiB; images and Box (Box on 1.14 only). The model is pinned to a versioned id; an alias is refused. Tested only against a loopback stand-in. **Nothing calls TypeSafe.** |
| `seats/stub.ts` | The **stub seat**: deterministic only, using the template's rules or its declared default. |
| `seats/legacy.ts` | The **transitional sorting model**: today's `LocalModelProvider`, behind the seat interface. It is used for a template only until a decision seat passes that template's eval (owner decision 3). |
| `verdicts.ts` | Eval binding per (template, version, seat, exact model). It is Part 1's `verdict.ts`, generalised, and reads the same `tev1-verdicts.json`. |
| `eval.ts` | Part 1's bounds and scoring, moved unchanged. |
| `settings.ts` | The person's choices (owner decision 2): providers and models per seat, the per-feature opt-ins for cloud Jev, recommendations, and plain notices. |
| `log.ts` | The decision record and its sinks: a JSON-lines file in Nova's home, and memory for tests. The database table is Track 1's migration. |
| `service.ts` | `DecisionService.ask(templateId, fields, opts)`: validate, build the state, route, ask, apply the policy, log. |
| `templates/ingest-screen.ts` | The ingest battery, moved out of `tev1.ts`, as template `ingest-screen` v1: Part 1's exact wording and state shape, which is what its eval verdicts are tied to. |
| `index.ts` | The public surface: the service, settings, types and built-ins. **No seat, no wire client.** |

Part 1's `src/core/jev/` folder is removed: its files move as above. `tests/core/tev1.test.ts`, the eval tests, the harness and the real runner follow the move.

## Routing (ADR §2, with the owner's decisions)

A template declares a **feature**: `screening` for text batteries, or `box` for anything with an image field or a Box question. The opt-ins are per feature, off by default, and each says in plain words what leaves the machine.

| Mode | Text templates | Box and image templates |
|---|---|---|
| cloud | `jev` when set up (decision 1), then `tev1`, then the sorting model until retired, then `stub` | `jev` only with the **box** opt-in on (decision 4), then `stub` |
| local-first | `tev1`; `jev` only with the **screening** opt-in on; then the sorting model until retired, then `stub` | `jev` only with the **box** opt-in on; then `stub` |
| local-only | `tev1`; `jev` only with the **screening** opt-in on (decision 1: "local-only isn't strictly local for screening while it is on"); then the sorting model until retired, then `stub` | **Never a cloud seat** (decision 4, refined). Only a local seat that reads images, with the box opt-in on. There is none today, so it goes straight to `stub`. |

**How a decision is reached:**
1. **Seats are tried in this order:**
   - first, any decision seat (`jev`, `tev1`) with a **passing eval verdict** for this template version on the exact model;
   - then the other allowed decision seats, in the mode's order. These answer as **shadows**: their answers go in the record as evidence, and are not used (the advisory rule from Part 1);
   - then the sorting model, unless it is retired for this template;
   - then `stub`.
2. **The first trusted answer decides.** A verdict-trusted answer and the sorting model's answer (`trust: 'legacy'`, as today, until it is retired) both count.
3. **With no trusted answer**, the template's deterministic default decides (`trust: 'none'`, quality low).
4. **A seat that fails** is recorded with its reason, and the next one is tried. **No route ever breaks the mode** above.
5. **A pin mismatch** (a different model version answered) is recorded and not used.
6. **Retiring the sorting model:** it is retired for a template version once any decision seat has a passing verdict for it.

## The person's choices (owner decision 2)

- **The settings:** for the `jev` seat, the base URL, a versioned model id and a key reference; for the `tev1` seat, the Ollama URL and a size (`auto`, `tev1:4b` or `tev1:0.8b`); and the two opt-ins.
- **Recommendations:**
  - TypeSafe's own API (`https://api.typesafe.ai`) with `jev-1.14.0`;
  - Tev1 at the size the hardware calls for.
- **A plain notice** appears whenever a choice differs from a recommendation:
  - another route;
  - another Jev version;
  - a smaller Tev1 than the hardware can hold;
  - a model with no passing eval for a template it would answer.

  There is also a notice for each opt-in that is on.
- **An alias** (`jev-latest`, `jev-preview`) is refused with the reason: it moves, and thresholds are tied to versions.
- **The scorecard:** for a seat and model, every built-in template's verdict, to show before the person switches.

## The decision log (ADR §3)

- **One record per decision:**
  - template and version, subsystem, task;
  - seat, model asked, model answered;
  - mode, egress and opt-in;
  - the state's hash and field names, never the content;
  - pieces, requests and usage;
  - the full answers, and every shadow answer;
  - bands, outcome, action, tier and autonomy;
  - trust, and the verdict it rested on;
  - why.
- **The sink is pluggable.** DS1 writes JSON lines to `<home>/logs/decisions.jsonl` through a sink the wiring passes in. Track 1's migration moves it to a table.
- **A remote state** calls a receipt hook with the context-receipt shape (CONTRACTS §2) and the opt-in that allowed it.

## No ad hoc calls (ADR §7)

`tests/core/decision-service-boundary.test.ts` fails when any of these happens:
- a file under `src/` outside `src/core/decision-service/` imports `seats/*` or `wire.ts`;
- a file under `src/` other than `wire.ts` contains `/v1/systemone`;
- `src/core/index.ts` or the service's `index.ts` exports a seat or the wire client;
- `src/core/jev/` exists again.

A negative control shows the checker catches a planted violation of each kind.

## Tests (CI, against stand-ins on loopback)

- **The registry:** validation, warnings and refusals per authoring rule, and immutable versions.
- **The policy:** every row of a truth table enumerated; the autonomy table.
- **State:** extra fields refused, caps never truncated, image format and size checks.
- **The wire:** all four answer types read strictly; the images header; the pin check.
- **Seats:** the Tev1 seat's Part 1 tests, carried over; the Jev seat against a loopback stand-in of TypeSafe's API (key, version, alias refused, context limits, Box); the stub; the sorting model.
- **Routing:** every row of the routing table, the opt-ins, shadows, retirement, fall-through on failure, and pin mismatch.
- **The log:** every field present, no content anywhere in it, and the receipt hook only for remote states.
- **Settings:** recommendations and notices.
- **The boundary test**, with its negative controls.
- **Part 1:** its eval set, manifest and verdict-recompute tests still pass after the move.

## NOTES for Track 1

DS1 changes no consumer and no shared file. These are the exact changes it needs. Items 1 and 2 **replace** #248's NOTES 1–2: the provider id, registering Tev1 first, readiness, and the Health and device-record lines all go through the service now. #248's NOTES 3–4 (every chunk screened, the 200-character overlap) are Track 1's, as before, and are unaffected.

### 1. The gate asks the service (`src/core/ingest/screen.ts`, `src/core/ingest/index.ts`)

The gate keeps its own chunking, fence, thresholds and verdicts. It stops choosing a provider. Per chunk it asks the service for template `ingest-screen`, and uses the answers only when the service says they are trusted (`trust` is `verdict` or `legacy`). Otherwise it is the gate's own no-model path, as today: the deterministic layer plus quarantine.

```diff
 // IngestOptions (screen.ts)
-  decisions?: Decisions | null;
-  // Whether a local sorting model is assigned now (Models.decidesWithModel).
-  ready?: () => boolean;
-  // The decision provider that counts as the local model; any other answer is no answer.
-  providerId?: string;
+  // The Decision Service, for template ingest-screen (DS1): one fenced chunk per call. Null: no
+  // model screen (the deterministic layer and quarantine decide).
+  ask?: ((fields: { source_kind: string; origin: string; content: string }) => Promise<{ trust: 'verdict' | 'legacy' | 'none'; seat: string; model: string | null; answers: Record<string, { type: string; noul?: number }> | null } | null>) | null;

 // Ingest
   hasModel(): boolean {
-    return !!this.#o.decisions && (this.#o.ready?.() ?? false);
+    return !!this.#o.ask;
   }

 // Ingest.#noul (screen.ts)
-  async #noul(parts: string[], source: Source): Promise<Record<string, number> | null> {
+  async #noul(parts: string[], source: Source): Promise<{ scores: Record<string, number>; model: string } | null> {
     if (!this.hasModel()) return null;
-    const decisions = this.#o.decisions!;
-    const want = this.#o.providerId ?? 'local-model';
     try {
       const answers = await …(parts.map(async (part) => {          // the pool from #248 NOTE 3
-        const d = await decisions.decide(SCREEN.template_id, { source_kind: source.kind, origin: source.origin, content: fence(part) }, { privacy_mode: 'local-only' });
-        if (!d || d.provider !== want || d.escalate) return null;
-        return d.answers as Record<string, number>;
+        const d = await this.#o.ask!({ source_kind: source.kind, origin: source.origin, content: fence(part) });
+        if (!d || d.trust === 'none' || !d.answers) return null;
+        return { model: `${d.seat}:${d.model}`, answers: Object.fromEntries(QUESTIONS.map((q) => [q, Number(d.answers![q]?.noul ?? 0.5)])) };
       }));
       if (answers.some((a) => a === null)) return null;
       const out: Record<string, number> = {};
-      for (const q of QUESTIONS) out[q] = Math.max(...answers.map((a) => Number(a![q] ?? 0.5)));
-      return out;
+      for (const q of QUESTIONS) out[q] = Math.max(...answers.map((a) => a!.answers[q]!));
+      return { scores: out, model: [...new Set(answers.map((a) => a!.model))].join('+') };

 // Ingest.screen / screenNow / #settle: as #248 NOTE 1 (#settle takes the model string that
 // answered, and ingest_screen.model records it, e.g. "tev1:tev1:4b@7954…" or "legacy:sorting-model").

 // WiredOptions (ingest/index.ts)
-  templates: Templates; decisions: Decisions; …
-  ready: () => boolean; providerId: string;
+  ask: IngestOptions['ask'];
```

**What changes in behaviour:**
- **The `privacy_mode: 'local-only'` the gate forced is dropped.** The service routes by the live mode and the person's opt-ins: owner decision 1, cloud mode screens with Jev once it is set up. The service still never sends to Jev in local-preferred or local-only unless the screening opt-in is on. Its routing tests prove that.
- **The `ingest-screen` template stays in the old store,** because the sorting model asks with it (the service's sorting-model seat reads it there through `old`). `templates.builtIn(SCREEN)` in `Ingest`'s constructor stays.
- **`Ingest.health()`:** replace the "screened by your local sorting model" line with the service's view (item 4). While no screen answer is trusted, the line must say outside content is held back as unsure.

### 2. The wiring (`src/core/index.ts`)

After `const models = …` and the `LocalModelProvider` registration (currently line 328), keep the provider instance in a const and add:

```ts
import { createDecisionService, FileLog, DEFAULT_SETTINGS, validateSettings, type DecisionSettings } from './decision-service/index.ts';
…
  const localModel = new LocalModelProvider({ infer: (r) => models!.infer(r), ready: (t) => models!.decidesWithModel(rules.has(t.template_id)), guard: triageGuard });
  decisions.register(localModel, { first: true });
  // The Decision Service (DS1): every System One question about outside content goes through it.
  const decisionSettings = (): DecisionSettings => {
    const v = validateSettings(profile.get<unknown>('models', 'decision') ?? {});
    return v.ok ? v.settings : DEFAULT_SETTINGS;
  };
  const ds = createDecisionService({
    settings: decisionSettings,
    privacy: () => profile.privacyDefault(),
    log: new FileLog(join(o.home, 'logs', 'decisions.jsonl'), { onError: (e) => log.warn('decisions', 'Nova couldn’t write a decision record.', { error: e.message }) }),
    ollamaUrl: () => models!.hubUrl(),
    hardware: () => models!.hubHardware(),
    jevKey: () => { try { return vault.get('decisions.jev') ?? null; } catch { return null; } },
    legacy: { provider: localModel, old: (id) => templates.get(id) },
    receipt: (r) => { receipts.record({ task_id: r.task_id ?? undefined, provider: 'jev', model: r.model, purpose: r.purpose, privacy_mode: r.privacy_mode, egress: r.egress, context_items: [], ...(r.opt_in ? { opt_in: r.opt_in } : {}) }); },
  });
  void ds.refresh().catch(() => {});
  const { ingest } = wireIngest({
    …,
-    ready: () => models!.decidesWithModel(false), providerId: LOCAL_MODEL_PROVIDER,
+    ask: (fields) => ds.service.ask('ingest-screen', fields, { subsystem: 'ingest' }),
```

- **The key** is a vault secret, `decisions.jev`. Settings › Models stores it with the vault's existing put. It is never sent to the UI and never logged; the service reads it at call time.
- **`ds.refresh()`** should also run when the model manager's inventory refreshes (`/models/refresh`), so a newly pulled Tev1 is seen without a restart. The seat re-checks by itself every 60 s when it is asked.
- **The browser co-pilot and triage stay on the old stack** until DS2 and DS3 migrate them as templates. Their `providerId: LOCAL_MODEL_PROVIDER` is unchanged.

### 3. Receipts accept an explicit opt-in (`src/core/receipts.ts`, plus a migration)

`Receipts.record` refuses any remote receipt under local-only. Owner decision 1 makes one exception: the screening opt-in. The service takes the receipt **before** it sends, so a refusal stops the send; that is tested with a refusing hook.

```diff
 export interface ReceiptInput {
   …
   egress: string;                // 'local' | 'remote:<name>'
+  // The person's explicit opt-in that allows this remote call in a local mode (Decision Service).
+  opt_in?: 'screening' | 'box';
   context_items: ContextItem[];
 }
…
-    if (r.privacy_mode === 'local-only' && r.egress !== 'local') {
+    if (r.privacy_mode === 'local-only' && r.egress !== 'local' && !(r.opt_in === 'screening' && r.provider === 'jev')) {
```

`opt_in` is stored with the receipt; see the migration below. **Box is never allowed under local-only**, even with its opt-in, so the exception names `screening` only.

### 4. Health, the device record and Settings › Models (shared UI)

`ds.view()` returns `{ tev1, jev, legacy, notices, recommendation, scorecards }`.

**Health › "Outside content":** one line per seat, in plain words.
- Tev1: `tev1.model` with `tev1.size_why`, or `tev1.why` when unavailable.
- Jev: `jev.why`.
- The sorting model: still used, or retired for `legacy.retired_for`.
- Whether screening decisions are relied on, or held back as unsure. Take this from `scorecards`.

**The device record** (`models.view()` for the hub): add `decision_model: { model: tev1.model, digest: tev1.digest, why: tev1.size_why }`.

**Settings › Models › Decision model** (owner decision 2):
- the route and model for Jev, with the key field (stored in the vault, item 2);
- the Tev1 size (`auto`, `tev1:4b`, `tev1:0.8b`);
- **two separate switches**, Screening and Box, both off by default, each with its `OPT_IN_WORDS` text shown beside it and again while it is on. Box is labelled "Preview";
- every `notices` entry, shown before saving;
- each seat and model's `scorecards`, shown before the person switches.

**The API** (on the existing `/models` routes):
- `GET /models/decisions`: `ds.view()`;
- `PUT /models/decisions`: `validateSettings(body)`, returning 422 with `problems` if invalid, otherwise `profile.set('models', 'decision', settings)`. Changing a seat or an opt-in is tier 2 (it changes where content goes).

### 5. The migration: the decision record

`src/core/migrations/00NN-decision-record.sql`. Not replicated; it holds no content, only hashes and probabilities.

```sql
CREATE TABLE decision_record (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, task_id TEXT, subsystem TEXT NOT NULL,
  template_id TEXT NOT NULL, version INTEGER NOT NULL,
  seat TEXT NOT NULL, model_asked TEXT, model TEXT,
  privacy_mode TEXT NOT NULL, egress TEXT NOT NULL, opt_in TEXT,
  state_sha256 TEXT NOT NULL, state_fields TEXT NOT NULL,          -- JSON array of names
  pieces INTEGER NOT NULL, requests INTEGER NOT NULL, usage TEXT NOT NULL,
  answers TEXT, bands TEXT, shadows TEXT NOT NULL, failures TEXT NOT NULL,   -- JSON
  outcome TEXT NOT NULL, action TEXT NOT NULL, tier INTEGER NOT NULL,
  autonomy TEXT NOT NULL, quality TEXT NOT NULL, trust TEXT NOT NULL,
  verdict_ref TEXT, why TEXT NOT NULL
);
CREATE INDEX decision_record_task ON decision_record (task_id);
CREATE INDEX decision_record_template ON decision_record (template_id, version, at);
ALTER TABLE receipt ADD COLUMN opt_in TEXT;
```

A `DbLog` sink (`write(r)` = one INSERT) then replaces `FileLog` in item 2. It is about 20 lines, in `decision-service/log.ts`, and DS2 can add it once the table exists. A task's timeline in the Work Ledger lists its records by `task_id`.

### 6. The records: LEDGER, plain-language entry, inventory, roadmap

**`docs/LEDGER.md`, under `## Decisions`:**

> **2026-10-31 (DS1: the Decision Service).** ADR `docs/plans/decision-service.md` with the owner's decisions; plan `docs/plans/ds1.md`; PR #⟨n⟩.
> - **Built:** `src/core/decision-service/`.
>   - A registry of versioned templates, checked against the authoring rules.
>   - Policies as fully enumerated truth tables mapped onto the tiers. System One only lowers autonomy.
>   - Three seats: cloud Jev (pinned versioned model, no aliases, a key from the vault, TypeSafe's limits, Box on 1.14), Tev1 (Part 1's code, moved), and the stub. The sorting model sits behind the same interface and is retired per template once a decision seat passes its eval.
>   - Routing by mode and the person's per-feature opt-ins: cloud mode screens with Jev once it is set up; the screening opt-in sends screening to Jev in local modes; Box is opt-in in every mode and never goes to the cloud in local-only.
>   - A decision record per decision, with no content.
>   - State built from declared fields only, never truncated, images checked in code.
>   - Settings with recommendations and notices.
>   - A boundary test: no seat or wire client is reachable outside the service.
> - **Moved:** Part 1's `src/core/jev/` to `src/core/decision-service/`.
> - **Kept:** Part 1's eval and verdicts are unchanged: both Tev1 sizes failed, so on Tev1, ingest-screen v1 is evidence only.
> - **Not built:** no live call to TypeSafe was made. The Jev seat is tested against a loopback stand-in of the documented API.
> - **Pending Track 1:** the gate's consumption, the wiring, receipts' opt-in, Health and Settings, and the decision-record migration (NOTES 1–5).

**The plain-language entry:**

> Nova now has one place where it asks a decision model a question. Each question set is versioned and checked. The answer is used only if that exact model passed a test on that exact question set. Every decision is written down without the content that was judged. Today no model has passed, so outside content Nova can't vouch for is still held back. You'll be able to choose a cloud model (TypeSafe's Jev) or a local one (Tev1). Sending anything to the cloud in local modes is a separate switch, off unless you turn it on.

**The inventory row** (decision stack, or a new row after Part 1's):

> | Decision Service (registry, seats, decision log) | Capability | **Have (v1, DS1)**: `src/core/decision-service/`. Versioned templates checked against authoring rules; policies as enumerated truth tables mapped onto the tiers; seats for cloud Jev (pinned versioned model, stand-in tested, no live calls), Tev1 (Part 1, moved) and the stub, plus the sorting model until each template's eval passes; routing by mode and per-feature opt-ins; a decision record with no content; a boundary test so no feature calls a provider ad hoc. **Gaps:** consumers not yet migrated (the gate first, NOTES 1–2); the record goes to a JSON-lines file until the migration; no template has a passing eval yet (ingest-screen v1 failed on Tev1; v2 in DS2); no local image seat. | DS1 |

**ROADMAP-AND-GATES,** on the Decision Service line: "DS1 built (PR #⟨n⟩): the service, seats, decision log and boundary test; the gate's migration onto it is Track 1's."

**Path updates:** the LEDGER and the inventory cite `src/core/jev/…`. After DS1 those files live in `src/core/decision-service/`:

| Was | Now |
|---|---|
| `systemone.ts` | `wire.ts` |
| `tev1.ts` | `seats/tev1.ts` |
| `verdict.ts` | `verdicts.ts` |
| `eval.ts` | `eval.ts` (unchanged) |
| `tev1-verdicts.json` | `tev1-verdicts.json` (unchanged) |
