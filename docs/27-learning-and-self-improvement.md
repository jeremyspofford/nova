# 27 — Learning & Self-Improvement

Nova should **learn from use** and **improve itself** over time. This is powerful and
dangerous, so the design is explicit about what may change automatically and what never may.

## 1. Levels of learning

| Level | What changes | Autonomy |
| --- | --- | --- |
| **L0 — Memory** | Facts, preferences, entities, retrieval weights | Automatic, user-reviewable |
| **L1 — Skills** | New/refined skill instructions from repeated workflows | Proposed, user approves |
| **L2 — Workflows** | Automation/prompt/tool-selection optimizations | Proposed with eval evidence, user approves |
| **L3 — Config** | Nova settings, routing, retrieval/index tuning | Automatic within safe bounds; rollback available |
| **L4 — Code** | Nova's own source/plugins/config code | Sandboxed, tested, versioned, **explicit approval** |
| **L5 — Models** | Local fine-tunes/LoRA adapters | Optional, gated, evaluated, reversible |

Guardrail: **L4 and L5 may never modify safety, policy, permissions, or the self-improvement
gates themselves.** Those are immutable from the agent's perspective.

## 2. L0 — Memory & preference learning

- Extract durable facts/preferences from conversations and corrections (`docs/09` §5).
- Learn retrieval weights from which results the user uses (ranking, not content).
- Per-item review, edit, pin, revoke; temporary/incognito excludes learning.
- Never infer sensitive attributes; never train on user data.

## 3. L1 — Skill synthesis

- Detect repeated successful workflows; propose a skill (instructions + allowed tools).
- The user reviews the generated skill, tests it, and installs it.
- Skills carry provenance and can be versioned/rolled back.

## 4. L2 — Workflow & prompt optimization

- Generate candidate prompts/workflows and evaluate them against a **held-out task set**.
- Compare on correctness, cost, latency, and safety; only improvements above a threshold are
  proposed.
- Every proposal includes the before/after and the evaluation evidence.
- Approved changes are versioned with one-click rollback.

## 5. L3 — Safe self-tuning

- Within declared bounds, Nova may tune retrieval parameters, cache settings, routing weights,
  and scheduling — with drift detection and automatic rollback if quality regresses.
- All tuning changes are logged with a rationale and are reversible.

## 6. L4 — Self-modification (code)

```
propose change → sandbox worktree → implement → run tests + evals
   → security review (policy/secret/egress checks) → produce a diff + evidence
   → user approval → staged deploy → health check → keep or auto-rollback
```

Rules:

1. **Never** modify: the policy engine, permission model, safety classifiers, audit log,
   update signing, or self-improvement gates.
2. All changes are made in an **isolated worktree/sandbox**, never the live tree.
3. Changes must pass **unit + integration + security** tests and a **safety eval**.
4. Deployment is **staged** (canary → full) with a **health check** and automatic rollback.
5. The user sees a **diff and evidence** and must approve before deploy.
6. Every change is recorded with provenance (who/what proposed it) and is revertible.
7. Self-modification respects **quiet hours**, spend caps, and the device/network policy.

## 7. L5 — Local model fine-tuning (optional)

- Only on user-owned hardware or explicitly authorized compute; dataset is derived from
  user-approved data.
- Training runs are resource-bounded and scheduled off-peak.
- Every adapter is evaluated on the task set and a safety suite; results are shown to the user.
- Adapters are versioned and can be disabled or deleted at any time; the base model is never
  altered.
- No user data leaves the network without explicit consent.

## 8. Evaluation & regression gates

- A maintained **eval suite**: task success, tool correctness, policy compliance, injection
  resistance, cost, and latency.
- Any learning/self-improvement change must not regress the suite beyond a tolerance.
- Regressions auto-revert and notify; results are stored for trend tracking.

## 9. Safety, ethics & control

- **Immutable guardrails**: the agent cannot weaken its own safety policy; attempts are denied,
  logged as high-severity, and surfaced to the user.
- **Human in the loop** for L1–L5 changes that affect behavior; L0/L3 are transparent and
  reversible.
- **Kill switch**: stop all self-improvement activity instantly; freeze at the current version.
- **Transparency**: a "What Nova learned" view lists memory, skills, tuning, and code changes
  with provenance and rollback.
- **No covert autonomy**: self-improvement never runs without visible, auditable activity.
- The Hub's **Flight recorder** captures every proposal, approval, deploy, and rollback.

## 10. Requirements (see `docs/03` §R)

- L0 memory learning with review; L1 skill proposals; L2 evaluated optimizations.
- L3 bounded self-tuning with drift detection.
- L4 gated, tested, staged, reversible code self-modification with immutable guardrails.
- L5 optional, gated, evaluated local fine-tuning.
- Evaluation harness with regression gates and auto-revert.
- Full audit, transparency view, and kill switch.
