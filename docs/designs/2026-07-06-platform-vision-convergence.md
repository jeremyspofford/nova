# Nova Platform Vision — Convergence Doc

> **Date:** 2026-07-06
> **Status:** Draft for alignment
> **Companion:** `docs/superpowers/specs/2026-07-06-home-assistant-native-integration-future.md`
> **Not a build spec.** Resolves load-bearing design forks so a build spec can follow.

## North Star (locked)

The wedge is **local + private + yours**. Every design decision is auditable against
that line. Hybrid local+cloud is acceptable *only* when the user controls the switch and
sees what's leaving. "An AI that does anything for everyone" is the trap version of this
vision — keep the vision, lose the trap, lead with concrete jobs only a local/private/owned
AI does well.

**Reframe that this doc adopts:** Nova is **not** "an OS." It is a **system-level agent
with escalating privilege tiers** on top of a base distro. The "OS" framing papers over the
conversations that actually determine safety (blast radius, approval, verification); the
agent-with-tiers framing forces them. An appliance image (à la Home Assistant OS) is a
*packaging* decision deferred to after the product proves itself — never a from-scratch
distro, never "the AI mediates every syscall."

## What this doc resolves

Five load-bearing forks. Four locked, one explicitly open for further discussion. Resolving
these now (while reasoning is fresh) prevents a build spec from hand-waving the parts that
actually determine success.

---

## LOCKED decisions

### 1. System-agent privilege tiers — LOCKED

Three tiers. The Guardrail stage of the quartet pipeline is the enforcement point; the
existing `request_human_checkpoint` / approval flow is the mechanism. The `recovery`
service owns verifiable, AI-callable backup/restore.

| Tier | Scope | Blast radius | Approval policy |
|---|---|---|---|
| **T1 — Userspace companion** | Open apps, read files the user points at, browse, answer questions about the screen | Low — recoverable | Default-allow; checkpoint only on flagged patterns |
| **T2 — Managed operator** | Package management, diagnostics, file organization, backup/restore | Medium — recoverable but annoying | Propose → human approves → execute → **verify** |
| **T3 — Administrator** | Reconfigure system, manage services, network changes | High — breaks the machine | Heavy confirmation, full audit, opt-in per action class |

Two non-negotiables carried forward from brainstorming:

- **Troubleshooting is the hardest, most failure-prone item.** The Guardrail must be
  genuinely good (not rubber-stampy) for anything irreversible. A "propose → approve →
  execute → verify" loop is mandatory for T2/T3.
- **Backups can never afford a hallucination.** "I backed up your data" being wrong is
  catastrophic. Backups must be *verifiable* (checksum, test-restore); the AI reports a
  deterministic verification result, never its own belief. Lives in `recovery`.

### 2. Notebooks — LOCKED (both ship, as subsections)

Built **natively** on memory + voice-service + the pipeline. **No Open Notebook
integration** — AGPL risk is unacceptable for a product, and the genuinely hard part
(audio-overview script synthesis) is craft that integration wouldn't buy anyway. Two
subsections, shipped in order:

- **(a) Pipeline feature** — a "notebook" = scoped corpus (a tagged memory subset +
  uploaded sources), an artifact-synthesis pipeline stage (summary, study guide, briefing),
  and an audio-overview flow (LLM-generated script → voice-service TTS, multi-voice).
  Ships first.
- **(b) Dashboard surface** — full citations, inline Q&A, source list, study-guide view.
  Builds on (a); the corpus and artifacts are the same, the UI is the new work.

### 3. Browser v1 — LOCKED (act mode, Comet-like)

Nova **drives** Chromium via CDP; the user watches in real time and can intervene; Nova can
also surface pages for the user to read. **Not** a from-scratch engine (that is a multi-year
trap — Microsoft gave up; every viable browser is Chromium/Gecko/WebKit-based). Reuses the
`browser-worker` muscle (Playwright patterns, CDP) but is a **headed, shared-surface**
deployment distinct from the existing headless worker.

Reference UX: Comet-style agentic browsing. Concrete jobs: "find coupons for this cart and
submit the best one," "navigate my AWS console and figure out which service failed."

**Because this is act-mode (not read-only), it carries higher blast radius.** A web-action
safety model is required and is part of the build spec, not deferred:

- Default: read/screenshot/navigate only.
- Approval required for irreversible web actions: submitting payments, creating/deleting
  accounts, deleting data, anything with financial or auth consequences.
- Surfacing a page "for the user to read" is always allow-listed (it's the safe path).

### 4. Appliance OS timing — LOCKED

Near term: Nova stays **a stack on a base distro** (Debian/Ubuntu). Appliance image is
**deferred** until the product (T1–T2 agent + smart home + notebooks + browser) proves
itself. When it ships, it's packaging (curated base, boots into Nova), never a from-scratch
distro, and the AI is always a tiered agent on top — never "the OS" in the sense of
mediating every syscall.

### 5. Cross-cutting — Nova is both a tool consumer and a tool provider

- **Consumer (existing):** Nova calls MCP servers as tools.
- **Provider (new surface to spec):** Nova exposes itself as a tool/agent — MCP server +
  A2A/ACP. This makes Nova controllable by other agents, workflow engines, and external
  tools. The dashboard's `AgentEndpoints` tab already gestures here; the build spec makes
  it first-class.
- **Workflow engines (n8n, Node-RED) are MCP citizens, never core dependencies.** Both
  listed on the Integrations page. Bidirectional: they call Nova (via the new exposure
  surface), Nova calls them (webhook/MCP). Commit to the protocol, not the product — users
  bring whichever engine they prefer.
  - License note: n8n is fair-code (Sustainable Use License) — fine for self-host,
    constrains managed-resale. Node-RED is Apache-2.0 (clean). Neither entangled as a core
    dependency.
- **Integrations page** gains: Home Assistant (MCP path), n8n, Node-RED, alongside existing
  GitHub / Brave / Filesystem / Docker entries.

---

## OPEN for further discussion

### 2'. Smart-home v1 demo — OPEN

Fork as originally posed:

- **(a) voice → HA MCP → single device calls** — fast, config-only, ships in the
  Integrations Hub pass.
- **(b) voice → HA routine layer → multi-device orchestration** — slower, native build.

User lean: (a) first, (b) later — but unsure; wants to discuss before locking.

**The reframe that may dissolve the fork (this is the thing to discuss next):**

The "goodnight routine" magic — the actual differentiator — may **not** require a native
HA routine layer at all. A routine is just *a Nova agent plan that makes multiple MCP calls
in sequence* ("lights off" → "doors lock" → "cameras arm"), driven by voice, with the
multi-device action gated by the Guardrail. On this view:

- (a) is the MCP plumbing — necessary, ships first.
- (b) collapses into **"routine templates + voice UX + Guardrail policy for multi-device
  actions"** — a Nova-side concern, not an HA-side native integration.

If that reframe holds, the only thing that genuinely needs a **native** HA integration
later (the future-spec companion to this doc) is the long tail of HA features that don't map
cleanly to MCP (complex scene editing, HA automations as first-class Nova objects, event
subscription for reactive behavior). Those are real but not v1.

**Discussion question for next pass:** does the reframe hold, or is there a concrete
v1 routine that genuinely can't be expressed as "Nova agent plan over MCP calls" and
requires native HA coupling? If yes, (b) is a real build; if no, (b) is productization of
(a), not a separate track.

---

## Sequencing (informational — not a committed timeline)

Presented to align mental model, not to promise dates. Sequenced for fastest proof of value
with blast radius increasing as trust is earned:

1. **Smart home via HA** (MCP path; routine-as-agent-plan reframe pending)
2. **System agent T1** (userspace companion — low blast radius, high perceived magic)
3. **Notebooks (a)** pipeline feature → **(b)** dashboard surface
4. **System agent T2** (managed operator — Guardrail quality becomes critical here)
5. **Headed Chromium shell** (act mode, web-action safety model)
6. **n8n / Node-RED** as MCP citizens (slots in any time after the agent platform is solid)
7. **Nova-as-tool-provider** exposure surface (can parallelize with 5/6)
8. **Appliance image** (only after the above proves the product)

---

## Future features registry

Future-triggered specs live in `docs/superpowers/specs/*-future.md` with a "Trigger for
doing this work" section (existing examples: `2026-04-16-async-tool-execution-future.md`,
`2026-04-16-speculative-decoding-future.md`). Gated work — not built until its trigger fires.

Current entries:

- `docs/superpowers/specs/2026-07-06-home-assistant-native-integration-future.md` —
  first-class native HA integration (routine layer, scene editing, event subscription) that
  goes beyond the MCP path.

Add to this registry as future forks are identified. Do **not** accumulate build specs here —
this list is for *deferred* work with explicit triggers, so it doesn't silently become a
backlog that haunts the current timeline.

---

## What this doc does NOT do

- Not a build spec — no schemas, endpoints, migration numbers, or task breakdowns.
- Not a commitment to the sequencing above as dates.
- Not a feature catalog — new features are explicitly out of scope here. Add ideas to the
  future-features registry, don't expand this doc.

## Next move

Resolve fork 2' (smart-home v1) in one more discussion pass → then write the build spec for
the first sequenced item (smart home via HA, MCP path) → queue for when the current
timeline of work completes.
