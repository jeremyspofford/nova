# Nova — Decision Register

This ledger is the single authoritative record of product and architecture
decisions. **Tiebreak rule: this file wins.** Where any other document —
including `docs/plans/*` and its `LOCKED` lines — disagrees with an entry
here, that document is design history, not policy (see D-004).

Format: ADR-style index entries, not full specifications. Source references
name the approved chat artifacts by title and date; durable full-spec files,
if wanted, are a separate documentation-only slice (per the Slice 1
approval's scope rule).

Statuses: `approved` (owner-approved, standing) · `superseded` (points at
its replacement) · `implemented` / `partial` / `unimplemented` note the
code's state, which never by itself changes a decision.

---

## Product direction

- **D-001 — Audience: instrument now, product later.** Anyone may use Nova
  and build products with it; nobody may resell, repackage, or pass it off
  as their own. Aria Labs branding is a fossil; protective license intent
  stays (legal wording deferred). — approved; source: owner decision
  answers, 2026-08-25; unimplemented (LICENSE still names Aria Labs).
- **D-002 — Assistant first.** The self-improvement loop is the method; it
  is judged by assistant capabilities it lands for the operator. — approved;
  source: owner answers D2/F3, 2026-08-25.
- **D-003 — Autonomy is earned, per action class.** "The intended long-term
  direction is progressively greater autonomy. Nova earns each increase
  through scoped permissions, reliable traces, evaluation thresholds,
  isolated testing, rollback capability, and demonstrated performance. The
  system defaults to human approval until a specific action class is
  explicitly promoted to an autonomous capability." — approved; source:
  owner amendment to Product Spec v0.1, 2026-08-25. Supersedes both the
  "operator merge is the gate indefinitely" LOCKs (docs/plans/
  self-improvement.md and four siblings) and the unqualified full-autonomy
  framing of docs/plans/autonomous-improvement.md.
- **D-004 — Single decision register.** This file is the only authoritative
  decision record; `docs/plans/*` (including LOCKED lines) is demoted to
  design history. — approved; source: owner answer D4, 2026-08-25;
  implemented by this file's existence (plan-doc banners not yet added).
- **D-005 — Roles: operator, adult, kid, guest, demo (initial).** "The
  authorization model is a durable product boundary; the exact role
  taxonomy and policy matrix are versioned and may evolve without weakening
  default-deny isolation." Demo is a restricted, expiring session
  principal, not a person. — approved; source: Product Spec v0.1 revision 1
  + Target Architecture approval, 2026-08-25; partial (kid/guest/demo
  precursors exist; adult tier and versioned matrix do not).
- **D-006 — Vocabulary: one word, one meaning.** Rename sweep approved
  (job/firing/recall/window/budget/release; approvals family =
  consent/goal/card). — approved; source: owner answer D6, 2026-08-25;
  unimplemented (P5).
- **D-007 — Merge-gate floors: experience first.** App loads, chat turn
  completes, UI navigable, latency within a measured budget; model-quality
  suite floors phase 2, after baselines are measured. — approved; source:
  owner answers, 2026-08-25.
- **D-008 — The frontend is inside the loop's jurisdiction**, which makes
  real frontend test floors and reviewable-size files prerequisites the
  loop must satisfy before unattended UI changes. — approved; source: owner
  answers D8/F8, 2026-08-25.
- **D-009 — Non-goals.** Multi-tenant SaaS; developer-platform-as-product;
  ambient always-on listening on current surfaces; Aria Labs branding;
  resale/repackaging by others; any autonomy not explicitly promoted. —
  approved; source: Product Spec v0.1 §9, 2026-08-25.

## Identity, authorization, privacy

- **D-010 — Hybrid principal model.** Person principals (role, privacy
  boundary, memory ownership, lifecycle) are distinct from device/session
  credentials (registered, scoped, trusted, expired, revoked). Voice is a
  deterministic identity signal and potential factor, never sufficient
  authority alone. High-risk actions require step-up confirmation through
  an authenticated operator device/session. — approved; source: owner
  clarification 1 on Target Architecture, 2026-08-25; unimplemented (P2).
- **D-011 — Voice assurance ceiling.** Voice-resolved identity on a shared
  device is signal-level only: personalization and role-scoped
  non-sensitive reads; never step-up, sensitive-memory disclosure,
  privileged tools, policy changes, spend approval, or deployment
  approval. — approved; source: owner amendment 4, 2026-08-25.
- **D-012 — Policy decisions belong to the kernel.** "The policy kernel is
  the only module that may make an authorization or privilege-granting
  decision. Other modules may enforce local type, state, integrity,
  ownership, and safety invariants, but may not convert a denied,
  unresolved, or insufficient-assurance request into an allowed action." —
  approved; source: owner amendment 1, 2026-08-25; unimplemented (TA-2
  evaluator is P1).
- **D-013 — Classification fails closed.** Missing, malformed, stale, or
  conflicting classification makes an item ineligible for cloud egress.
  The context manifest carries item IDs, provenance, class, rule version,
  override identity/reason, and resulting eligibility. Overrides are
  privileged, audited, and never silently promote to cloud. The egress
  gate independently validates the manifest. "Local unrestricted" refers
  to cloud egress only — local access still passes principal/role/
  ownership/policy checks. — approved; source: owner amendment 2,
  2026-08-25; unimplemented (P0 S4 / P3).
- **D-014 — Interim cloud rule.** Until classification-aware construction
  and egress enforcement exist: local models are the default for any task
  that could include private memory, household context, traces,
  credentials, or policy/persona content; cloud only for operator-
  initiated, bounded, reviewed engineering tasks; automatic local→cloud
  fallback is prohibited — degraded local-only service is the correct
  failure mode. — approved; source: owner clarification 3 + C3
  confirmation, 2026-08-25; unimplemented as code (operational rule now).
- **D-015 — Host-trust assumption.** Host/root compromise may expose local
  data and secrets unless mitigated. A future security baseline is
  required: non-root services, least-privilege docker access, encrypted
  secrets/backups, UI/secret separation, recovery-key policy, defined
  behavior on host/tailnet/clock compromise. — approved; source: owner
  amendment 3, 2026-08-25; unimplemented (P6).

## Architecture

- **D-016 — TA-2: one canonical authorization evaluator** over (principal,
  roles, credential assurance, resource classification, action, required
  confirmation); existing gates become inputs/callers. — approved
  2026-08-25; unimplemented (P1).
- **D-017 — TA-6: single tool-enforcement path**, including dispatch and
  lazy MCP loading. — approved 2026-08-25; unimplemented (P1 S6).
- **D-018 — TA-7: machine-readable gates manifest** (owner, protected
  property, pinning test, lifecycle status). Initially an evidence-backed
  inventory and verification aid — not the canonical mechanism, not a
  completeness or effectiveness claim. — approved with amendments
  2026-08-25; implemented (Slice 1: `backend/app/gates.py`,
  `backend/tests/test_gates_manifest.py`).
- **D-019 — TA-9: shared execution-record interface + derived unified
  ledger view; no physical table merge initially.** — approved 2026-08-25;
  partial (Slice 3: internal test/admin-only application adapter
  `backend/app/execution_records.py` over turns / action runs / automation
  firings / coding sessions / eval runs, with owner-approved status
  normalization and strict no-inference provenance; the future `job` unit
  is documented as a mapping only; no migration, no runtime/UI/API/tool/
  prompt consumer — pinned by surface scan).
- **D-020 — TA-10: append-only governance event ledger** (authz denials/
  step-ups, promotions, releases, rollbacks, stops). — approved
  2026-08-25; unimplemented (P0 S2).
- **D-021 — TA-11: privileged sidecars remain separate privilege
  holders**; the rollback watcher lives outside the backend process. —
  approved 2026-08-25; implemented in current sidecar split; watcher
  unimplemented (P4).
- **D-022 — C8: smallest-practical one-host staged promotion.** Immutable
  revision → reproducible artifact → isolated verification → staged
  deployment (snapshot-import stage stack, never shared prod DB) →
  health/observation window → promotion → automatic rollback to known-good
  artifact. Direct-to-live is a manual/emergency operator path only. —
  approved 2026-08-25 (incl. E-2); unimplemented (P4).
- **D-023 — C8.7: no automatic rollback across a migration boundary** —
  escalate to the operator instead. — approved 2026-08-25.
- **D-024 — E-1: classification is rule-derived** (category/origin/owner)
  with explicit, privileged, audited per-item overrides. — approved
  2026-08-25.
- **D-025 — E-3: person principals evolve additively from
  `user_profiles`.** — approved 2026-08-25.
- **D-026 — E-5: step-up = consent cards restricted to high-assurance
  operator sessions**; authenticated push confirmation is later work. —
  approved 2026-08-25.

## Process

- **D-027 — Phased implementation with owner gates.** Small, independently
  testable, reversible vertical slices; additive slices distinguished from
  behavior-changing ones; every behavior-changing slice sits behind an
  explicit owner approval; adapters land before cutovers; nothing is
  deleted in the slice that replaces it. — approved; source:
  implementation-plan directive, 2026-08-25.
- **D-028 — Slice 1 scope** (this change): `docs/DECISIONS.md` (ADR index
  only), `backend/app/gates.py`, `backend/tests/test_gates_manifest.py`,
  and an advisory-only, non-fatal `gates.report()` hook in
  `backend/app/main.py`. No entry-count ratchet; manifest statuses and
  paper-trail rules per the amendments. S2+ not authorized. — approved
  with amendments, 2026-08-25.
- **D-029 — Preserved consent-contract risks (deliberate).** Two as-built
  behaviors of `consents.validate_and_use` are kept unchanged and pinned by
  `tests/test_consent_burn.py`: (a) a malformed/unparseable consent ID
  falls back to kind+subject matching; (b) omitting `agent_name` bypasses
  agent binding. Future principal/credential and step-up-consent
  architecture must either make requestor/principal binding mandatory or
  define a narrowly scoped, explicitly audited system exception, and must
  decide whether ID fallback is permitted per assurance/action class. Not
  work for the current slices. — approved; source: Slice 1.1 acceptance,
  2026-08-26.
- **D-030 — Governance ledger is atomic, narrow, and never an authority.**
  `governance_events` (migration 134) onboards exactly three event types —
  `consent.decided`, `consent.burned`, `capability.changed` — with ATOMIC
  writes: the state mutation and its event commit in one transaction, and
  a failed event write fails the mutation (a consent click errors and
  stays retryable; a burn rolls back fail-closed with the approval
  preserved). Capability guarantee, precisely: for each successfully
  completed `capability_events._write()` transaction, the legacy row and
  its governance mirror commit together or neither commits — the
  fire-and-forget posture around it is unchanged, not strengthened.
  Payloads are typed per-event constructors (identifiers/enums only;
  reject, never truncate; errors name type+key, never values);
  `actor_assurance` is `'unknown'` pending D-010. Append-only is an
  application-level contract (no DB triggers/roles yet); the watermark is
  migration 134's `schema_migrations.applied_at` (DDL-only migration, no
  synthetic rows; no backfill). `reconcile()` is a test/admin-only
  diagnostic — never scheduled, booted, exposed as a tool, or readable by
  non-operator principals — and the ledger is read by no decision path.
  Goal/spend/recommendation/deploy events deferred to later slices. —
  approved with clarifications; source: Slice 2 approval, 2026-08-26;
  implemented (this slice).
- **D-031 — Test-only governance cleanup (narrow exception).** Test suites
  that invoke real governance-producing paths must remove ONLY their own
  explicitly identified probe governance rows, in `finally` blocks, and
  assert zero suite-owned source and governance rows remain. This is the
  narrow, documented, test-only exception to the production append-only
  contract: it lives in `backend/tests/_gov_cleanup.py`, addresses rows
  solely by exact subject ids or reserved test namespaces (`test.burn`,
  `test.gov`, `scratch-t13-`, `scratch-t14-`), is always bounded by the
  suite run's start watermark so historical rows are unreachable, and is
  unreferenced by production code (pinned by `test_governance_ledger.py`).
  Historical residue deletion requires its own explicit operator approval
  per batch. — approved; source: Slice 2.1 approval, 2026-08-26;
  implemented.
- **D-032 — Future capability-pair integrity requirement (not built).**
  For capability events after the migration-134 watermark, integrity
  checking must eventually verify both directions: (1) no governance
  `capability.changed` mirror lacks a corresponding live legacy
  `capability_events` row; and (2) no eligible legacy `capability_events`
  row lacks its required governance mirror — subject to the known
  fire-and-forget background-writer caveat and any explicitly documented
  exclusions. Recorded as a requirement only; no checker is implemented,
  scheduled, or exposed. — approved; source: Slice 2.1/3 direction,
  2026-08-27; unimplemented.
- **D-033 — S4a: classification observation phase (observe-only).** The
  runner builds a per-turn, ordinal-only, bounded classification manifest
  from metadata it already assembles and hands it explicitly to
  `llm/router.stream_chat`, which records — after model resolution, before
  transport — either that manifest or an honest MISSING_MANIFEST
  observation, as a span on the existing trace (no turn → bounded log +
  counter only). Observation is bounded and best-effort per the owner's
  verbatim overhead wording; v1 rules are deliberately blunt
  (runner context → local_only target). **Deferred by decision:**
  non-runner adapters (compaction, summariser, vision, auto-description,
  coder) remain MISSING_MANIFEST until data-shape-specific S4b plans; all
  override support (no authoritative format exists — recorded
  `override: unavailable`). **D-013/D-014 remain unimplemented and
  unenforced** — this phase measures, it does not decide. — approved with
  corrections; source: S4a approval, 2026-08-27; implemented (observation
  only).
- **D-034 — Explicit manifest handoff; two S4b prerequisites.** (a) The
  manifest travels as an explicit `stream_chat(manifest=…)` parameter, NOT
  an ambient contextvar collector — intentional: ambient state allowed a
  finished turn's manifest to contaminate a later unrelated call; the
  parameter makes that class unrepresentable. Do not revert. (b) Recorded
  follow-ups, not yet implemented: **test-routing discipline** — any test
  that can reach `stream_chat` must pin provider resolution and transport
  before invoking the path (one accidental local-only Ollama call proved
  routing tests reach real providers by default); **purpose granularity** —
  future manifests keep separate `turn_source` and `operation_purpose`
  fields (never compound strings), with parent/correlation references only
  when authoritative. — approved; source: S4a acceptance, 2026-08-27.
- **D-035 — S4b-1: compaction adapter + manifest v2 field split.** Manifest
  v2 adds separate `turn_source` (derived only from the live trace at
  observe time) and `operation_purpose` fields; legacy `purpose` retained
  deprecated; recorded v1 spans are never reinterpreted (decoder handles
  both). Compaction audience classification uses the only authoritative
  signal that exists — `conversations.guest_id` → `guest_demo`; messages
  carry no speaker attribution, so there is no operator or
  household-member conversation-level signal and **every non-guest
  compaction manifest is `unknown` + `AUDIENCE_UNAVAILABLE`** (operator is
  never inferred from absence; all classes target local_only in v1).
  Verified per-call: compaction call 1 runs inside its trace turn (span);
  the regrounding call runs outside any turn (bounded no-turn observation;
  no trace created). S4b order approved: compaction → vision →
  auto-description → summariser → review → coder (vision promoted for
  attachment privacy sensitivity). — approved with amendment; source:
  S4b-1 approval, 2026-08-27; implemented (observation only; D-013/D-014
  still unenforced).
- **D-036 — Conversation-audience gap is a principal-slice dependency.**
  Non-guest conversations have no authoritative audience/ownership signal
  today; resolving that belongs to the future person-principal /
  conversation-ownership slice (D-010/P2), not to classification adapters.
  Until it exists: non-guest conversation-derived content stays `unknown`,
  classification-incomplete, target local_only — and operator identity is
  never inferred from a non-guest session, device, IP, voice, or the
  absence of a guest ID. — approved; source: S4b-1 acceptance, 2026-08-27;
  standing constraint.
- **D-037 — S4b-2: vision manifest adapter.** Every vision payload is
  target local_only in v1 by deliberate policy: data class
  `vision_unclassified`, class source `policy_default` (which never counts
  as classification-incomplete — that stays reserved for genuine gaps),
  reason `VISION_V1_LOCAL_ONLY`. Manifest carries coarse enums only —
  `modality=image`, `size_bucket` (tiny/small/medium/large/oversize),
  `media_family` (raster_image/vector_or_unknown/unknown) — as additive
  optional v2 fields under the recorded versioning rule (bump only on
  semantic change to an existing field; additive optional metadata stays
  v2). No filename, URL, attachment id, digest, EXIF, exact mime/bytes/
  dimensions, or image-derived content is ever recorded. Verified: the
  single production caller is `router_chat._image_text` (pre-turn, so all
  live vision observations take the bounded no-turn path), and
  `vision._refuse_cloud` already refuses cloud vision before any bytes
  leave unless `attachments.allow_cloud_vision` is on — so vision
  divergence is structurally zero unless that setting is enabled. —
  approved with amendments; source: S4b-2 approval, 2026-08-27;
  implemented (observation only).
- **D-038 — S4b-3: automation auto-description adapter.** The single seam
  is `automations._auto_description` (one `stream_chat` call; no call at
  all when `automations.model` is unset). Its input is install
  configuration text, classed `operator_private`/`derived_rule` — a rule
  about the content's home, not an identity inference (D-036 concerns
  conversation audience, which this is not); target local_only. Callers:
  the `manage_automations` tool path runs inside a chat turn (span); the
  operator API create path runs outside any turn (bounded no-turn
  observation). Verified: unset model → fallback trim with zero transport
  and zero observations; transport failure → fallback preserved, the
  attempted call still observed (before-transport). — implemented per the
  approved S4b order, 2026-08-27; observation only.
