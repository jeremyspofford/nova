# Deep Think + Inference Endpoint Pool — Design

**Date:** 2026-06-11
**Status:** Approved for implementation (autonomous session; review surface = PR)
**Author:** Claude (directed by Jeremy)

## Why

Jeremy's brief, distilled:

> Get Nova to use local LLMs that perform like frontier models, even if it takes
> longer to accomplish tasks.

This is test-time compute scaling: trade wall-clock time, tokens, and electricity for
answer quality. The external survey (Gemini, 2026-06-11) lists the standard menu —
Mixture-of-Agents, reflection loops, Tree-of-Thoughts + MCTS, verified execution,
iterative RAG, agent frameworks. This design records what Nova adopts, what it
rejects and why, and pairs the chosen techniques with the **inference endpoint pool**
(multiple `LOCAL_INFERENCE_URL`s — mini-PC + GPU box + future burst), because deep
think is the workload that makes multiple endpoints worth having: proposers run in
parallel across machines.

## Technique triage

| Technique | Verdict | Why |
|---|---|---|
| Verified execution (sandbox, error loop, lint/test gates) | **Already core — harden it** | Nova's ReAct loop is this. Ground-truth feedback (code runs or doesn't) is the only critique signal small models can't fool. Cheapest big win: acceptance gates on code output. |
| Mixture-of-Agents (proposers → aggregator) | **Adopt — the centerpiece** | Best published gap-closing for open-weights on open-ended tasks. Maps directly onto the endpoint pool (parallel proposers, different models picked by agent-score from the manifest). |
| Reflection / self-critique | **Adopt only grounded** | Pure introspection makes small models confidently rewrite wrong answers. Critique steps must cite external evidence: tool results, memory hits, proposal disagreements. |
| Tree-of-Thoughts + MCTS | **Defer** | Highest complexity and token cost; shines on checkable-state puzzles, weak ROI for a general assistant. Revisit if eval data demands it. |
| Iterative RAG | **Defer to web increment** | Right idea, wrong dependency order — needs `web.search` that works (continuity increment 3). |
| LangGraph / AutoGen / CrewAI | **Reject** | Nova *is* the orchestration layer (loop, tools, approvals, subagents, scheduler). A second framework means two competing brains. These patterns become Nova capabilities, not imports. |

## Part A — Inference endpoint pool

Generalizes the single `LOCAL_INFERENCE_URL` into N endpoints. The single-endpoint
install is the degenerate case — **zero behavior change until a second endpoint is
added**.

### Model

`endpoints.json` in the gateway runtime dir (volume-mounted, like the hardware
profile), managed via `GET/PUT /endpoints` and proxied for the dashboard:

```jsonc
[
  {
    "id": "default",                  // migrated from LOCAL_INFERENCE_URL at boot
    "name": "mini-pc",
    "engine": "ollama-host",          // ollama | ollama-host | vllm | llamacpp | sglang | lmstudio
    "url": "http://host.docker.internal:11434",
    "lifecycle": "always-on",         // always-on | wake-on-lan | on-demand (reserved)
    "wol_mac_secret": null,           // per-endpoint override of the wol_mac secret
    "enabled": true
  },
  {
    "id": "dell-gpu", "name": "dell-gpu", "engine": "ollama",
    "url": "http://dell.local:11434", "lifecycle": "wake-on-lan",
    "wol_mac_secret": "wol_mac", "enabled": true
  }
]
```

### Per-endpoint plumbing (all exists today for one endpoint)

- Discovery, capabilities, pull/delete, hardware profile (`hardware-{id}.json`),
  observed signals, and WoL become endpoint-scoped: existing routes gain an optional
  `endpoint` param defaulting to `default` — current API contracts unchanged.
- Routing: `completion_candidates` expands across enabled endpoints. Explicit model
  requests resolve to whichever endpoint serves that model (first reachable wins);
  `auto` prefers the highest agent-score model (manifest) among fitting, reachable
  endpoints. `wake-on-lan` endpoints that are unreachable trigger the #24 auto-wake.
- `local-only` routing semantics: all configured endpoints count as local — they are
  machines the user controls. (Burst/`on-demand` will need its own routing class
  when it lands; the enum is reserved, the implementation is explicitly out of scope.)
- Dashboard: Models page gains an endpoint switcher (hardware card, installed table,
  and pulls operate on the selected endpoint).

## Part B — Deep think

A per-request execution mode, never the default: `POST /complete` and `/stream`
accept `effort: "standard" | "deep"`; the chat composer gets a Deep Think toggle
(same pattern as the web-search toggle); tasks/schedules can request it.

### Two layers, one spine

1. **Deep completion (llm-gateway)** — for any single completion turn:
   - **Propose**: 3 (max 5) parallel completions. Diversity from different models
     when the pool offers them (picked by manifest agent/reasoning scores), else
     temperature/system-prompt jitter on one model. Parallelism across endpoints is
     why Part A exists.
   - **Aggregate**: the strongest available model gets the prompt + all proposals,
     instructed to synthesize, prefer claims proposals agree on, flag and resolve
     disagreements, and never introduce claims absent from every proposal without
     marking them unverified.
   - Response metadata: `{effort: "deep", proposers: [...], aggregator, elapsed_s,
     total_tokens}` — the cost is always visible.
2. **Deep task mode (agent-core)** — for tool-using tasks the ReAct loop stays the
   spine (verified execution is the strongest technique and it's already here). Deep
   mode upgrades the two highest-leverage turns: the initial plan turn and the final
   answer turn go through deep completion; intermediate tool turns stay single-shot
   (fast, ground-truth-checked anyway). Code acceptance gates (run lint/tests before
   accepting code output) extend the existing sandbox loop.

### Guards (same discipline as proactivity)

- Hard caps: wall-clock (default 300s), total tokens, proposer count. On cap: return
  the best available answer with a `capped: true` flag — never error on overrun.
- `app_config` keys: `deep_think.enabled` (kill switch), `deep_think.daily_budget`
  (deep runs per 24h, default 20). The proactivity pulse may not request deep mode
  (its own budget is the cheap one).
- Surfaced everywhere: chat shows a "thought for 3m12s · 4 models" line; task events
  record proposer/aggregator usage.

### Evaluation — the honest part

Quality claims need evidence, not vibes:

- CI-grade tests assert **mechanics**: N proposers called, aggregator received all
  proposals, caps enforced, metadata correct, single-endpoint fallback works.
- Quality itself: `make audit-deep-think` (non-gating, like `audit-tool-use`) runs a
  fixed 20-prompt set both ways and writes a side-by-side report for human judgment.
  If deep mode doesn't visibly beat single-shot on the dev box's models, it doesn't
  graduate from experiment to default-on toggle.

## Increment plan (one PR each)

1. **Pool core** — endpoints.json + per-endpoint discovery/capabilities/routing;
   single-endpoint degenerate case proven unchanged (full test-v2 pass).
2. **Pool UX** — endpoint switcher on the Models page; per-endpoint hardware, pull,
   WoL wiring.
3. **Deep completion** — MoA in the gateway + chat toggle + caps/budget + mechanics
   tests + the audit harness.
4. **Deep task mode** — plan/final turns through deep completion; code acceptance
   gates in the sandbox loop.
5. **(reserved)** Burst lifecycle (runpod/vast.ai as `on-demand` endpoints) — only
   after the pool has proven itself; routing/privacy semantics get their own design.

## Out of scope

Tree-of-Thoughts/MCTS, external agent frameworks, fine-tuning, multi-user, burst
provisioning (lifecycle enum reserved only), iterative RAG (web increment owns it).
