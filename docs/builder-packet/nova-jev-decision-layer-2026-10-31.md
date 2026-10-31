Status: OWNER INPUT, approved by Jeremy 2026-10-31. Extends Amendment 2026-10-31-B Part 1: specifies the Decision Service + question-template registry the Part 1 provider plugs into. Asks for an ADR first, then phased build (see accompanying prompt).

# Jev as Nova's System One decision layer — docs review + use-case map (2026-10-31)

Sources: TypeSafe's official docs (docs.typesafe.ai), read 2026-10-31:
introduction/quickstart, primitives, confidence, models, Jev 1.13
jaggedness, use-case map, and the cookbooks (LLM guardrails, simple
memory, RAG passage classification, re-ranking, semantic find, entity
alignment, skill suggestion, function calling, citation check,
self-consistency). Console (console.typesafe.ai) is behind sign-in;
nothing here required an account.

## What Jev actually is (docs facts)

- One endpoint, `POST https://api.typesafe.ai/v1/systemone`. A request
  = `state` (string or structured JSON) + named typed `questions`.
  Every question is judged independently, in parallel, against the
  same state; adding questions barely changes latency. There is NO
  limit on question count — the limits are context: 64k tokens
  per-request, 32k per-question (a long-context header raises both to
  262k, slower and less accurate; off by default).
- FOUR primitives (the fourth is new since our earlier design work):
  - `noul` — P(yes) in [0,1]. No separate confidence; the probability
    IS the uncertainty (0.5 = maximum uncertainty).
  - `choice` — pick from your options (up to 255), returns the pick,
    per-option probabilities, and `confidence`.
  - `score` — position on your written rubric levels (fractional),
    with probabilities and `confidence`.
  - `box` — locate something in an IMAGE: returns the four edges as
    fractions of width/height. Images can be in the state and in
    criteria (docs: images.md; feeder-cam + OCR cookbooks use it).
- `confidence` is computed FROM the probability distribution's shape
  (documented formulas; for a Noul, use |2p−1| to get the same scale).
  It is not "probability of being right."
- Price: $0.042 per million INPUT tokens; output free. Vendor latency
  figures: 70–500 ms end-to-end. Models: jev-1.14.0 (current),
  jev-1.13.0. PIN VERSIONED IDs: aliases (jev-latest) move, and the
  docs explicitly warn answers change under you if thresholds were
  tuned against a version. Not fine-tuned per customer — you shape
  behaviour via state + instructions/criteria. English is primary;
  other languages weaker. Not trained on customer requests (ZDR is an
  enterprise feature).
- Access routes: direct API key (console sign-up; self-serve since
  Sept 2026), OpenRouter (same body, their key), Vercel AI Gateway.
  SDKs: Python and JavaScript/TypeScript (@typesafe-ai/sdk) — Nova's
  stack. There is also an official Agent Skill for Claude Code
  (`npx skills add typesafe-ai/skills`) that teaches a coding agent
  the API and its patterns.
- Local seat: Tev1 via Ollama speaks the same API (Amendment B
  Part 1), so one client serves cloud Jev and local Tev1.

## How TypeSafe says to build with it (the patterns that matter)

- One snap judgment per question. If a judgment has factors, ask one
  question per factor and combine in CODE with your own weights
  (Composite scoring). Weights in code = policy you can tune without
  prompt surgery.
- Speculative fan-out: ask every question you MIGHT need in one
  request; code ignores the irrelevant answers. Batching 13 questions
  was ~10x faster / ~12x cheaper than 13 calls, answers unchanged.
- Confidence-gated routing: the answer says WHAT; confidence says
  WHETHER TO ACT. Three bands — high: act automatically; medium:
  proceed with caution / confirm; low: escalate to a human or another
  system. Thresholds scale with the stakes of the action.
- Guardrails cookbook shape (validates our ingest design): a battery
  of hazard Nouls + one severity Score on BOTH inputs and outputs,
  routed by named policies (strict/permissive threshold sets) in code.
- Memory cookbook shape: after each interaction, a gate Noul asks
  "does this state a lasting fact worth remembering?" (save at
  P ≥ threshold); saved items are injected into later states.
- Select instead of generate: code finds candidate values; Jev picks;
  code copies the pick. (Function-calling and extraction cookbooks.)

## Jaggedness — TypeSafe's own limits (design around these)

From the official Jev 1.13 jaggedness page:
- LITERAL reading: it answers the question you wrote, not the one you
  meant. Instructions must state exact conditions; boundary cases go
  in the criteria.
- NO math, counting, or date/time comparison — keep arithmetic,
  tallies, ordering, and date logic in code; Jev judges semantics.
- Indirection hurts: multi-hop / property-of-a-property questions
  lose accuracy. Point questions at named state fields.
- Context rot: accuracy falls as state fills with irrelevant detail.
  Retrieve/filter in code first; send only what the question needs.
- ADVERSARIAL CONTENT CAN STEER IT: "state is data, and Jev does not
  treat it as hostile by default." A Jev battery is a layer in the
  ingest defense, never the wall — exactly the stance Amendment C
  Part 3 already takes (deterministic checks + taint tracking carry
  the load; probabilities advise).
- Choice option ORDER can bias toward the first option — validate
  critical Choice questions with reordered options in the eval set.
- It cannot generate text. Extraction = candidates from code/regex,
  Jev picks.

## The Nova architecture this implies

A **Decision Service** in Nova core, used by every subsystem:
- A registry of question TEMPLATES (named, versioned batteries —
  the "cached, validated, versioned decision templates" from the
  2026-10-29 Jev decision), each with its policy: thresholds →
  actions, mapped onto Nova's approval tiers (high confidence + low
  stakes = tier 0/1 behaviour; medium = ask; low = escalate/stop).
- One provider interface, three seats: cloud Jev (cloud mode),
  Tev1 (local modes; private state never leaves), and the existing
  stub (no provider configured → deterministic-only behaviour).
  Model version pinned per template; a version bump re-runs that
  template's eval set before thresholds are trusted (Part 4 harness).
- Every decision is LOGGED (template id + version, provider/model,
  probabilities, policy outcome) to the Work Ledger: the audit trail
  for "why did Nova do that," and the raw material for per-template
  eval sets and threshold tuning.
- State hygiene rules from the jaggedness page are enforced in the
  service: states are assembled per battery (filtered, minimal),
  never "the whole context, dumped."

## Use-case map for Nova (owner's list, mapped)

| Area | Pattern | Shape | Notes |
|---|---|---|---|
| Ingest guardrails | Guardrails cookbook | Hazard Noul battery + severity Score, in AND out | Already designed (Amendment C Part 3); cookbook validates thresholds/policies shape |
| Browser work (M10b) | Verification + confidence routing | Choice: which element matches the intent; Nouls: dark pattern? page changed as expected? login wall? | Totals/prices compared IN CODE (no math); Jev judges semantic match only. Box can locate elements in screenshots as a fallback signal |
| Model routing | Intent routing | Choice over providers/models by task class + Score for expected difficulty; low confidence → default/stronger model | Probabilities double as the routing audit trail; cost policy weights live in code |
| Self-learning / memory | Memory cookbook | Gate Noul "lasting fact worth remembering?"; Nouls for duplicate-of / contradicts existing memory; Score for memory importance | Feeds memory consolidation; all saves keep provenance (the cookbook's rule: facts appearing only in the ANSWER don't count) |
| Smart home | Intent routing + Box | Choice over device/action intents with confidence gates (unlock/heat = high threshold), Noul anomaly checks on sensor state, Box + Nouls on camera frames (person? package? which region) | Feeder-cam cookbook is the working template for camera events; irreversible actions stay tier-gated regardless of confidence |
| Graphs / knowledge graphs | Entity alignment cookbook | Score "same entity?" + companion Nouls per field (name matches? date matches? type matches?) | Companion Nouls explain WHICH fields disagree — dedupe/merge decisions with reasons, thresholds in code |
| Risk assessment | Composite scoring | Atomic Scores (impact, reversibility, blast radius, evidence quality) combined by code weights → tier | This is how a change/action earns its approval tier with an auditable breakdown instead of a vibe |
| Search & retrieval | RAG classification + re-ranking + semantic find | Score each retrieved passage (relevant? sufficient?); code admits top set to the answering model; Choice over candidate IDs for line-level find | Their legal re-rank test: top-1 5%→18%, top-10 38%→62%. Directly serves Nova's memory recall quality |
| LLM guardrails (chat) | Guardrails cookbook | Same battery on user input and Nova's output, named policies per privacy mode | Distinct from ingest: this guards the CONVERSATION; policies differ per mode (local-only screens locally via Tev1) |
| Semantic code linting | Verification battery | Per-diff Nouls: breaks a public contract? touches auth/permissions? writes outside the workspace? missing test for changed behaviour? + Score review priority | Literal-reading caveat: questions must be exact; runs in the change pipeline as evidence beside tests, never instead of them |
| Skill selection | Skill suggestion cookbook | Two requests: rank candidate skills for the turn, re-check top candidates | Built for a 194-skill catalog; Nova's skill registry is the same shape |
| Tool/function dispatch | Function calling cookbook | Choice of tool + closed-set argument fill in one call, confidence-aware | A pre-check before the REAL tool runs: wrong-tool probability visible before anything executes |
| Trigger triage | Classification + scoring | Choice of trigger class; Score urgency; Noul "worth interrupting the user?" | The interruption Noul is the notification-budget mechanism the launch research asked for |
| Capture pipeline | Box + classification | Box locates UI elements/regions in frames; Nouls classify events (meeting started? screen locked? sensitive app frontmost → pause capture) | Sensitive-app detection is a privacy feature: capture pauses itself |
| Self-modification safety | Composite scoring + verification | Change-risk composite feeding the pipeline's tier decision; Nouls on the diff (data-loss path? permission widening?) | Code owns the final tier; Jev supplies the scored evidence in the ledger |
| Evals (Part 4) | Self-consistency cookbooks | Jev as a cheap outcome grader for golden tasks (Noul: did the outcome satisfy the criterion?) + uncertain cases routed to human review | Human spot-check stays; Jev grading is for scale, with its own agreement rate tracked |

## What this changes / confirms in existing plans

- Amendment B Part 1 stands (Tev1 local seat + injection eval). The
  eval should ALSO include: reordered-options consistency for Choice
  questions, and adversarial-steering cases scored against the
  DETERMINISTIC layer's verdict, not Jev's alone.
- The Decision Service + template registry should be specified as an
  ADR-level input alongside Part 1 — every row above depends on the
  same plumbing; building batteries ad hoc per subsystem would fork
  thresholds and logging ten ways.
- Account: a TypeSafe account is still the owner's call, BUT Jev is
  also served via OpenRouter, and the owner already has paid
  OpenRouter usage — cloud-mode experimentation may need no new
  account or vendor relationship at all. Pin jev-1.14.0 either way.
- Builder leverage: the official TypeSafe Agent Skill can be
  installed in the builder's Claude Code so integrations are written
  against the live docs — worth doing when Part 1 is picked up.
