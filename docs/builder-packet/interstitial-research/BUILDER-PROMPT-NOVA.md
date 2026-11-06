# Nova builder prompt — Interstitial Research skill

Paste the block below into the **current** Nova builder session, in the
same chat. It is session-bounded: it adds one queued item, it does not
restart, parallelise, or re-scope work already running.

Files to hand the builder with the paste (same packet):
`SKILL.md` (Nova edition) and `VERIFICATION-AND-IMPROVEMENT.md` — both
in this folder. Everything the builder needs is in the block + those
two files; do not make it go looking for the earlier generic drafts.

---

NEW QUEUED ITEM — Interstitial Research skill for Nova. Add it to the
queue in order; do not interrupt, restart, or parallel-write against
work already running, and do not re-scope anything else. Queue
position: after T2 Part 3 (the passkey enforcement) merges. It is a
small, self-contained item and may use gaps between larger items,
but it does not displace milestones of the config-onboarding or
UI-rebuild tracks, and it lands before Ponytail Steps 2–8 (product
capability before cleanup). Single-writer
rules, PR #207, and the at-risk uncommitted M8 worktree exclusions
stand exactly as before. My review is not a gate: merge in queue order
as gates/CI pass and keep going until this item is done, blocked, or I
say stop. If you hit a genuine owner-design decision, pick the
reversible option, log it in the PR, and keep going; only stop if you
are truly blocked, and then state the exact blocking action.

WHAT TO BUILD — three parts, in this order:

**Part 1 — Inspect first, report in your first update (no code yet in
that update):**
- The real skill loader in current main: what format it actually
  accepts, where skills live, how triggering works, whether the Agent
  Skills standard format (SKILL.md with name + description
  frontmatter) loads as-is. The attached SKILL.md is written in that
  standard — if the loader differs, adapt the skill to the loader;
  never build a parallel skill system.
- The real research/search path: task classification, the web stack
  (connector/API → fetch → Nova's own browser), and where a planner
  hook would sit without touching non-research paths.
- The Decision Service: the template registry's actual registration
  API, seats, and Work Ledger logging — this skill must consume
  templates from the registry, never call a Jev/Tev1/provider API
  directly.
- The Skills page / drafts inbox / propose-from-chat flow and the
  feature-flag mechanism, so install, proposal, and removal use
  existing Nova flows.
Report what you found, name any place where the attached files assume
something main does not have, and how you adapted. Then continue into
Part 2 without waiting for me.

**Part 2 — Implement:**
1. The skill: attached `SKILL.md`, adapted only where Part 1 proved
   the loader requires it (keep a diff note of every adaptation).
   Load-on-demand only — no part of its method goes into always-loaded
   core/system context.
2. Three Decision Service templates, registered and versioned, model
   pinned per template: `interstitial.field-map`,
   `interstitial.verify-transfer`, `interstitial.outbound-check` —
   schemas, thresholds, and privacy-mode seat routing exactly as in
   SKILL.md §4. Local-only mode: local seat for every call, no cloud
   fallback, no warning-and-continue.
3. The planner hook: research-class tasks only; generates the field
   map, builds the query matrix, applies the outbound check before
   any external query, runs the ingest gate on every source before
   use (provenance/taint preserved into synthesis), runs
   verify-transfer before synthesis, writes the per-run record
   (SKILL.md §7) into the task record / Work Ledger.
4. The improvement plumbing (SKILL.md §8): run-count / cost-cap /
   correction counters that file a proposal to the skills drafts
   inbox + approval card when a trigger fires. Proposals only —
   nothing in this item may edit the active skill or a template
   without owner approval on that card.
5. A feature flag covering the hook + templates so flag-off is
   byte-for-byte the old research behaviour, and uninstall through
   Nova's normal flow removes the skill, its dead-end data, and its
   template caches. The flag SHIPS OFF. Flipping its default is not
   part of this item's build — it is an outcome of Part 3 (§D).
6. No new UI surface. The expected maximum is the skill appearing in
   the existing Skills page listing; anything beyond that is scope
   creep — stop and log it instead.

**Part 3 — Test and verify (all of it, in
VERIFICATION-AND-IMPROVEMENT.md):**
- §A loader test through the real chat path in the preview, with the
  three pieces of evidence (loaded-skills/activity record, Work
  Ledger field-map entry, layered output) + the negative control.
  This is the first skill to be proven this way — if the loader
  rejects the standard format, that is a finding to report plainly,
  not to work around silently.
- §B trigger set: 9/9 required (4 must-trigger incl. the
  auto-escalation fixture, 5 must-not-trigger).
- §C golden evals G1–G4 with the stated scoring; ≥8/10 per case, no
  zero on verification. Package the eval outputs as a review packet
  for a fresh review session to spot-score G1 and G3 (see
  VERIFICATION §C) — report both scorings where they differ.
- §D result verification + the flag-off/flag-on A/B table on G1–G3.
  If ON does not beat OFF within the SKILL.md §3 cost caps, ship the
  skill DISABLED and report that honestly as the outcome.
- §E privacy/ingest: P1 personal-derived generalisation, P2 injected
  source (reader/actor — the fixture's instruction must never be
  acted on), P3 local-only with every call on the local seat. Any
  cloud call in P3 fails the item.
- §F removal/regression.
- Full CI on the PR. If the item touches any UI surface (Skills page
  listing is the expected maximum), that surface gets the screenshot
  treatment: show it in the preview at desktop + phone postures in
  the PR; do not describe it instead of showing it.

REPORTING — at completion, report in these separate buckets, plainly,
with evidence links, and never collapse them into "done":
(1) loaded & triggered (§A/§B results), (2) method works (§C scores),
(3) results verified (§D incl. the A/B table and cost vs caps),
(4) Nova-safe (§E/§F results), (5) shipped vs designed — what merged,
what is in-branch, what is still only in these documents,
(6) not yet proven — anything run on a stub seat, any skipped test
and why, any cap not yet measurable.
Also include a plain-language one-paragraph summary at the top,
written for a non-builder reader: what Nova can now do that it could
not do before, and whether the A/B says it is worth its cost.

---
