# The decision role: Jev and Kev decide what her turn needs

**In short**

1. A new model role, `decisions`, works like chat. You pick a model and fallbacks, local or
   cloud, in Settings → Routing.
2. Its models answer typed questions rather than writing text: Jev in the cloud through
   OpenRouter, and Kev on the Dell.
3. Before she answers, core asks two things. Which tool does this message need? Which recalled
   notes are still right for it? The hint goes into her turn, and stale notes are dropped.
4. If no decision model answers, the turn runs exactly as today, and the trace says so.
5. Order: gateway, then core, then Routing and Models, then a Kev engine on the Dell that
   downloads models.
6. Model routing is a switch per role: off, the role uses the cloud model you picked; on,
   Jev Router picks the best model for each request.

Status: owner-approved design, 2026-09-27/28. Branch `slice/decisions`.

## Why (measured, 2026-09-27/28)

"How do I get you on my phone" in the owner's real chat got an invented sideloading answer and
no setup card. The chat model was `dell:qwen3:8b`, and memory recall had brought back his
2026-09-15 sideloading conversation. All figures are the S47 setup case through the eval
runner's `run_case`, 3 runs each, with his real recall:

| Setup | Passed |
|---|---|
| No decision model | 0/3 |
| After the recall fix (#79: recall serves his words, never her past answer) | 2/3 |
| Jev deciding (hint `show_setup_qr` 0.82-0.85; stale notes dropped) | **3/3** |
| Kev-4B on the Dell deciding (hint 0.80) | **3/3** |

Tool routing on four messages, using TypeSafe's two-stage recipe: Jev 4/4 and Kev-4B 4/4.
Kev-0.8B was near random, so it is not a routing model here. The probes and every number are in
the lane notes, and the recipes are in `typesafe-recipes.md` (both in the SDD workspace).

## Owner decisions

- The decision role works like chat or agent model selection. He can download models, set
  one, and have fallbacks, local or cloud.
- Kev-4B and Kev-0.8B are local, and Jev is the cloud route.
- Jev goes through OpenRouter. `POST https://openrouter.ai/api/v1/systemone` with
  `model: "~typesafe/jev-latest"` and the existing OpenRouter key works (it is served as
  jev-1.13, at about $0.00001 a question).
- Build order: gateway → core → web → Kev engine.

## Design

### 1. Gateway: the role and the protocol

- `decisions` joins `routing.BUILTIN_ROLES`. Its chain is edited in Settings → Routing like
  chat's: for example `dell-kev:kev-latest`, then `openrouter:~typesafe/jev-latest`. It also
  joins the role's other pinned places (web `BuiltinRole`, `ROLE_WORDS` and their tests;
  the gateway and core error-text tests).
- New data-plane route `POST /v1/systemone`, beside `chat_completions`. It resolves the
  `decisions` chain with the existing `routing.resolve` / `record_refusal` / `note_success`, so
  walls and fallback work exactly as for chat. It forwards the request body unchanged to the
  winning link as `{base_url}/systemone`, with the link's model id and the provider's key. It
  relays the response with the `X-Nova-Route` header.
- **The endpoint decides the protocol, not the provider.** The existing `openrouter` provider
  serves both chat and decisions. A decisions-only provider, such as Kev on the Dell, is a new
  adapter value `systemone`: base URL plus optional key, with no chat.
- `local` becomes settable on a provider (today it is derived from `adapter == "ollama"`), so a
  Kev box is free and uncapped.
- Metering: OpenRouter returns `usage.input_tokens` and `usage.cost`. Record them under the
  `decisions` role; local links cost nothing.

### 2. Core: two questions per turn

A new module, `decisions.py`, runs on Nova's turns before the first model round. It makes one
concurrent batch of calls to the gateway's `/v1/systemone` with role `decisions`.

- **Tool hint.** TypeSafe's skill-suggestion recipe:
  - Stage 1: one `choice` over the turn's advertised tools, each with its full registry
    description, plus `none`; and one `noul`, "does answering require doing, showing or looking
    something up?".
  - Stage 2: one `choice` over the stage-1 top three, and one fit `noul` per candidate.
  - The options come from the live registry (derived, never listed by hand).
  - If the stage-2 fit is at least 0.30 and the action gate is at least 0.30, one line goes in
    her turn: "A decision model reads the owner's message as needing your tool X (fit 0.85). Use
    it if it fits."
  - It is a hint. She still decides, and every existing guard still judges what she writes.
- **Recall check.** TypeSafe's RAG recipe. For each recalled note, one request asks three
  separate `noul` questions: relevant, contradicts, superseded. The state holds the message, the
  note, and the current facts, where the current facts are the full description of the hinted
  tool (derived). A note is dropped when relevant is below 0.45, contradicts is 0.70 or more, or
  superseded is 0.70 or more.
- **Fail-open with a stated reason.** No runnable decision model, a timeout (a per-turn budget,
  5 s to start), or a malformed answer all leave the turn exactly as today. The `decisions` span
  records why.
- **Trace.** One `decisions` span per turn records the tool hint, its fit, the gate, per-note
  scores and verdicts (note paths, never note text), the model that served, and the latency.
- **Not on:** scheduled turns, drains and agent delegation to start. Measure first; widening is
  a later change.

### 3. Web

- Settings → Routing shows the `decisions` role with its label and chain editor.
- The Models page lists decision models: Jev from the OpenRouter catalog (modality
  `text->decisions`), and Kev from the Dell once the engine exists.
- Providers: a preset for a Kev server (`systemone` adapter, local).

### 4. Model routing: a switch per role (owner, 2026-09-28)

"People may want a determined cloud model and not routing, or they may choose to use
routing and use the best models for the task regardless of cost."

- Settings → Routing gains a switch on each chat-kind role (chat, scheduled, agents): "Let
  Jev Router pick the cloud model".
- Off (the default): the role's cloud link is the model he picked, exactly as today.
- On: the role's cloud link becomes `openrouter:typesafe/jev-router`. On OpenRouter it
  "picks the best model and reasoning effort for each request", and you pay the model it
  picks. The model it picked is recorded on the turn (OpenRouter returns it).
- The chain stays the one source of truth. The switch is an edit to the chain: switching
  off restores the cloud model that was there before, which is kept in a setting. Local
  links before the cloud link are untouched, so local first still holds.
- If Jev Router exposes a quality-first setting, the switch uses it ("regardless of cost").
  If it does not, the switch says what Jev Router balances.

### 5. Kev engine on the Dell (last)

This is a small service on the Dell that downloads, removes and serves Kev models from Hugging
Face, keeps one model loaded, and unloads it when idle so the GPU is free. The gateway treats it
like the hub's Ollama for downloads. Until it exists, the Kev server the owner started by hand
(`kev.serve --run jaredpalmer/kev-4b --port 8009`) is a plain `systemone` provider link.

## Open risks (measured, not solved)

- **Kev-4B latency on the Dell.** A two-stage route took 3 s warm and 21-47 s cold or under
  load; the Dell is also the owner's desktop and GPU. The 5 s budget turns a slow answer into
  "no hint". Measure warm latency with the GPU idle and with the 8B loaded. Stage 1's long
  prompt, with every tool's full description, is the cost.
- **Kev-4B's recall verdicts are borderline** (superseded 0.57-0.65, against Jev's 0.75). The
  thresholds above are TypeSafe's starting points. Tune them on the eval corpus, never on one
  message.
- **The hint is a request.** It raised the measured case from 2/3 to 3/3. The eval corpus must
  show it does not pull her toward a wrong tool elsewhere (TypeSafe's own A/B broke 7 turns for
  every 37 it fixed).

## Done means

- The whole eval corpus, 29 cases × 3 runs on `dell:qwen3:8b`, with decisions off and on: no
  case worse, and the S47 case 3/3.
- The owner's real chat: "How do I get you on my phone" gets the card, and the trace by turn id
  shows the `decisions` span and her own `show_setup_qr` call.
- Jev (cloud) and Kev (the Dell) each serve the role; each fallback is walked by walling the
  first link.

## Not in scope

- A decision-role pick of local versus cloud per turn: a later slice (the switch above routes among cloud models only).
- Decisions on the honesty guards: detection stays mechanical (ARCS.md's corrected analysis).
