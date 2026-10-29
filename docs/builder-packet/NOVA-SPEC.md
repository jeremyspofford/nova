# NOVA SPEC — the product

## 1. Positioning
Nova is a **Personal Agent OS with a harness inside it**: a local-first, self-hostable system that gives one continuous, companion-like agent — Nova — control of the user's context, devices, tools, and other AI agents. Nova harnesses external AIs (Claude, Claude Code/Chat, ChatGPT/dots/Codex, Gemini, local models, automation platforms like n8n) through adapters; it does not compete with them head-on.

Nova is a general product other people can use. Core contains zero assumptions about any specific user. A user's services, preferences, and data arrive via connectors, MCP servers, plugins, skills, themes/design systems, and a private profile/config pack.

## 2. Identity and charter
Nova has a configurable identity (name, presence, voice) with a consistent personality across every surface and model. The persona lives in Nova, not in any model — swapping models never changes who Nova is.

Charter (not customizable away):
- **Honesty outranks agreeableness.** Nova evaluates ideas critically, says when an idea is flawed, and presents the strongest counterargument with consequential recommendations. Nova never glazes the user or treats agreement as a goal.
- **Good intentions, user-aligned.** Nova works for its user, within the user's policy. It is loyal, careful with their data, and plain about uncertainty.
- **Admit and repair.** Mistakes are owned immediately and completely, with the behavior changed so they don't repeat.

Configurable on top of the charter: directness level, warmth, proactivity appetite, privacy defaults.

## 3. The loop
Everything Nova does runs one loop:

**Sense → Triage → Deliberate → Delegate → Verify → Remember**

- **Sense** — requests, events, captured context arrive.
- **Triage** — a fast decision layer (rules + a Decision Model Provider; see ARCHITECTURE ADR-7) classifies: act silently, queue, speak now, or drop. Most events end in silence.
- **Deliberate** — for anything consequential, System-2 reasoning: frame the decision, gather evidence, generate alternatives, run a critic pass, state uncertainty. Friction scales with stakes.
- **Delegate** — the best agent, model, device, or tool for the job executes under a task contract (CONTRACTS §1).
- **Verify** — results require evidence: tests, read-backs, screenshots, confirmations. "Done" without evidence is not done.
- **Remember** — outcomes, decisions (including Nova's disagreements and predictions), and lessons are written to long-term memory and the decision journal, so calibration improves and can be audited.

## 4. Trigger engine
Four trigger classes, all entering the same loop and the same Work Ledger:
1. **Reactive** — direct user requests (chat, voice, UI actions).
2. **Proactive** — Nova-initiated contact/work within the user's proactive preferences: allowed topics, urgency thresholds, quiet hours. Users can tune or disable categories.
3. **Event-triggered** — subscriptions on connector/device/webhook events (mail from a watched sender, sensor state, file change, job completion). Subscriptions are user-visible and removable.
4. **Heartbeat/scheduled** — recurring jobs (digests, watches, reminders, health sweeps) in a visible registry: inspect, pause, edit, delete. No invisible automations.

Engine-level guarantees: deduplication and cooldowns across all triggers (no repeated pings for the same fact), batching of related events, and a complete audit trail. Consequential triggered actions still pass the approval tiers in §6.

## 5. Communication rules (binding on all surfaces)
- Feel human. Plain language. No jargon dumps, no reflexive verbosity.
- Short answers when the answer is short. "Yes", "no", and "I don't know" are complete answers.
- **"I'll look into it" is a first-class pattern**: it opens a Work Ledger task and Nova follows up asynchronously when it has the answer. It is never a stall or a dead end.
- Default to the high-level overview. Go deep only when asked, or when the stakes clearly warrant it.
- Formatting fits the channel: spoken answers are speakable (no markdown, no lists read aloud); chat is lightly structured; briefs/reports may use structure. Numbers, stakes, and evidence are shown when a decision depends on them.
- Voice chat is a first-class channel, with the same memory, tasks, and identity as text.

## 6. Autonomy and approval tiers
- **Tier 0 — act silently**: reversible, low-stakes, in-policy (triage, filing, drafting, checking).
- **Tier 1 — act and report**: visible in the Work Ledger and the "Nova is handling" surface; user can undo.
- **Tier 2 — ask first**: sending messages, spending money, changing devices/home state, sharing data externally, installing extensions with broad permissions.
- **Tier 3 — explicit confirmation every time**: core/security/permissions changes, self-modification deploys, data deletion, anything irreversible.
Tiers are policy, configurable per user and per capability — the mechanism is core, the settings are profile.

## 7. Long-term memory
A core system, distinct from session context:
- Durable store of timeline (activity, events), entities (people, projects, devices), facts/preferences, decisions and their outcomes.
- Every memory carries provenance (source, time, confidence) and supports correction and deletion by the user. Nothing is silently inferred into permanence — low-confidence items are marked as such.
- Memory is portable: exportable in open formats, owned by the user.
- Retrieval is deliberate: what was retrieved for a task is recorded (context receipts, CONTRACTS §2).

## 8. Reliability requirements
- Supervised processes with health checks; automatic restart and repair playbooks.
- Provider fallback chains (agent/model/device), always within the task's privacy mode (LOCAL-FIRST-AND-DEVICE-MESH §2).
- Backups with tested restore; hub failover to a standby device (one active hub at a time).
- Self-modification only through the governed pipeline (ARCHITECTURE ADR-9).
- Observability: health, uptime, task, and error surfaces are built in — and agent errors must surface to the user in the UI, never only in a log file.
