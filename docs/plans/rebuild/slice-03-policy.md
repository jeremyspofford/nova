# Slice 3 — Policy Kernel + Earned Autonomy + Honesty Guards

> **SUPERSEDED 2026-09-03 (owner ruling — see
> [no-approvals.md](no-approvals.md)):** the kernel's decisions, consents,
> dispositions and earned autonomy are REMOVED — nothing Nova does waits on
> the owner. What survives from S3: the honesty guard (§The honesty guard,
> T4 — kept verbatim below) and the governance ledger as a RECORD (never
> read by a decision path — already its stated rule; its writers are now
> `device.enrolled` / `device.revoked` / `device.audit_break` only, and
> `test_governance.py` pins that dispatching a tool writes no row). Every
> other section below is the historical spec of what was built and then
> removed; read it as history, never as a design to rebuild. The reverse
> pin is `services/core/tests/test_no_approvals.py`.
>
> **Decision amendments (2026-09-03).** The register (`docs/DECISIONS.md`)
> is untracked in the main repo and absent from this tree, so the amendments
> are recorded here — the doc where D-012 was "made real" — until the owner
> says where the register lives for v4:
>
> - **D-012** (policy decisions belong to the kernel) — Amended 2026-09-03:
>   v4 makes NO authorization decisions — every registered tool runs. The
>   surviving half is the prohibition: no module may refuse on the owner's
>   behalf; a check may state a call CANNOT run (unpaired, offline,
>   malformed) but never that it MAY not.
> - **D-003** (autonomy is earned, per action class) — REVOKED for v4
>   (owner, 2026-09-03): no approval default, no per-class promotion; Nova
>   holds every capability from the first turn; the measure is her judgment
>   under the eval harness, not the owner's clicks.
> - **D-010** (hybrid principal model) — Strike the step-up sentence
>   ("High-risk actions require step-up confirmation through an
>   authenticated operator device/session"); keep the person-vs-credential
>   split (that is authentication).
> - **D-011** (voice assurance ceiling) — Strike "spend approval" /
>   "deployment approval"; survives only as an identity-assurance ceiling if
>   S8 lands.

Parent: the Master Roadmap (approved 2026-08-27); inputs:
docs/plans/rebuild/slice-02-carries.md (esp. the MANDATED guard family)
and slice-01-carries.md. Slice type: BEHAVIOR-CHANGING (owner walks before
it is his daily driver). Size: L.

Goal: nothing Nova does that could spend, mutate outward, or reach the
network happens without a mechanical authorization decision; risky actions
raise an approval card the operator decides; a class earns autonomy by
demonstrated reliability and can be revoked; and a reply that CLAIMS an
action no span records is mechanically caught — the exact defect S2's
walks exposed.

This is D-012 made real: ONE policy kernel is the only code that converts a
request into an allowed action; everything else may only add refusals.

## Definition of done (operator-visible, walked in the running app)

1. Ask Nova to fetch a URL (outward-facing, consent-tier): an approval
   card appears inline in chat AND on an Approvals page. Deny it → Activity
   proves nothing ran (no fetch span, the turn states the refusal).
2. Approve a re-run → it executes, the span appears, the reply is honest.
3. Repeat the fetch class until the graduation threshold → Settings→
   Autonomy shows the class now auto-runs; the next fetch runs with no
   card. Revoke it there → the card returns on the next fetch.
4. Every decision (raise, approve, deny, burn, promote, demote, revoke)
   appears in a governance audit visible to the operator.
5. Induce a narration: get a reply that claims a file/fetch it did not
   perform (the 1.7B model does this readily) → the turn is mechanically
   corrected (the claim is contradicted in the reply text, not just
   hoped-against by the prompt).

## Architecture

### The policy kernel (services/core/app/policy.py — new, the ONLY authorizer)
- `authorize(ctx) -> Decision` where ctx = {principal (person+role+
  assurance), action_class, resource, args, active_consent?}. Decision ∈
  {ALLOW, REQUIRE_CONSENT(card_spec), DENY(reason)}. Pure function over
  the action-class table + live consent state; it READS, it does not
  execute. No other module returns ALLOW — grep-pinned.
- Action-class table: migration-seeded rows {tool_or_shape, risk_tier,
  disposition}. Disposition ∈ {auto, notify, consent, deny}. S3 seeds:
  reads (workspace_read/list, memory_search, get_time) = auto; memory_save
  = auto (contained, low risk); workspace_write_file = consent (mutation);
  fetch_url = consent (outward-facing) — the demo class. dispatch_to_agent
  / anything unlisted defaults to DENY (fail-closed — an unknown action is
  never auto).
- The funnel: services/core/app/tools/__init__.py `dispatch()` (S2's
  single point) calls `policy.authorize` BEFORE the executor. ALLOW →
  execute. REQUIRE_CONSENT → raise/find a consent card, and if a valid
  burned-this-turn consent covers this exact action, execute; else return
  a stated "awaiting your approval" tool result (NOT an error — the model
  should tell the operator, not retry). DENY → stated refusal result.
- Pinning test: no executor is reachable without passing authorize; a
  second test asserts every registered tool has an action-class row (a new
  tool with no row is DENY by default AND turns a pinned snapshot red —
  tripwire, deliberate update).

### Consents (services/core/app/consents.py — new)
- A consent row: {id, action_class, args_hash, requestor (agent+person),
  status (pending|approved|denied), created_at, decided_at, decided_by,
  used_at, ttl}. Raised only by the funnel; decided only via an
  authenticated operator API; used exactly once.
- `validate_and_use(action_class, args_hash, agent, person)` — the
  MECHANICAL check-and-burn: one SQL UPDATE ... WHERE status='approved'
  AND used_at IS NULL AND (ttl window) AND args_hash=$ AND requestor bound,
  FOR UPDATE SKIP LOCKED, RETURNING. Never LLM-judged. Args binding is
  MANDATORY (v3's D-029 fallback loopholes are NOT carried). Burn commits
  atomically with a governance event (see below) — a failed event write
  fails the burn.
- Approve-always-has-an-executor: approving a card does not itself run the
  action; the model re-attempts the action in a subsequent turn and the
  now-approved consent is burned at the funnel. (No orphaned approvals —
  the funnel is the only executor and it always re-checks.)

### Governance ledger (services/core/app/governance.py + migration)
- Append-only `governance_events`: {id, kind (consent.raised|decided|
  burned|policy.denied|autonomy.promoted|demoted|revoked), action_class,
  actor, subject_ref, meta, created_at}. Written IN THE SAME TRANSACTION as
  the state mutation it records (consent burn + its event commit together
  or neither). Read by no decision path — it is the audit, not an authority.

### Earned autonomy (services/core/app/autonomy.py)
- Per action-class outcome tracking: a class at disposition=consent with N
  (setting: autonomy.graduation_runs, default 5) consecutive
  approved-AND-succeeded executions is PROMOTED to auto (recorded as a
  governance event). A promoted class demotes on the first failure or on
  operator revoke. Promotion/revoke are operator-visible and operator-
  reversible in Settings→Autonomy; the kernel reads the current
  disposition, nothing else decides.
- This is the earned part of D-003: autonomy per action class, earned by
  demonstrated reliability, always revocable.

### The honesty guard (services/core/app/guards.py — the S2 MANDATE)
- Post-turn, mechanical, reads the turn's spans vs the reply text:
  `narration_check(reply_text, spans)` flags a reply that claims an action
  (wrote/saved/fetched/created a file/updated) when no successful span of
  the matching kind exists this turn. On a flag: the reply is corrected —
  a stated line appended ("Correction: I did not actually perform that —
  no record of it exists.") — never silently shipped. This is the
  capability-claim-verifier shape: derived from spans (facts), never from
  the prompt.
- Acceptance corpus: the three concrete fabrications quoted in
  tests/e2e/README.md (the "groceries updated" zero-span claim, the
  invented invoice) are the guard's test cases — each must flip from
  shipped-as-is to corrected.
- Calibration: the check must not fire on honest replies (a reply that
  correctly says "I could not do that" or that DID produce the span).
  False-positive is the expensive failure; the matcher is precision-first
  (explicit past-tense action claims + the tool that would back them),
  and a turn with zero action-claims is never touched.

## Tasks

- **T1 — Policy kernel + action-class table + funnel integration + consents
  + governance ledger** (L). The mechanical core; the DoD's deny/approve/
  execute path. Fail-closed defaults; args-bound single-use burn; atomic
  governance writes; the grep-pinned "only the kernel allows" test.
- **T2 — Approval cards: backend API + inline chat card + Approvals page**
  (M). Raise via the funnel, decide via authenticated operator API only;
  the {"consent"} SSE frame (rides T1's forward-compat parser allowance)
  for the inline card; PendingApprovals page (v0.5.0 prior art). Denied/
  approved reflected in Activity.
- **T3 — Earned autonomy + Settings→Autonomy + governance audit view** (M).
  Graduation/demotion/revoke; the Autonomy settings section (per-class
  disposition, run history, revoke button); a read-only governance audit
  surface (the Activity page or a tab shows decisions).
- **T4 — The honesty guard** (M). narration_check wired post-turn in the
  chat path; the S2 fabrication corpus as tests; precision-first
  calibration with honest-reply negative tests.
- **T5 — E2E + DoD walk** (M). The full DoD as isolated-stack scenarios
  (deny→nothing-ran, approve→ran, graduate→auto, revoke→card-returns,
  narration→corrected), mechanically verified; owner stack untouched
  (ruling S2-R9 isolation reused). The narration scenario uses the tiny
  model deliberately (it fabricates reliably).

## Rails in force
D-012 (only the kernel allows); consent burned atomically exactly once,
args-bound, never LLM-judged; approved-consent-always-has-an-executor
(the funnel); governance events atomic with their mutation; unknown action
= DENY (fail-closed); the honesty guard derived from spans never the
prompt; pinned-expectation snapshots updated deliberately; 127.0.0.1;
refuse-all tokens; running stack untouched during tests; comments
self-contained.

## Out of scope (named)
The full v3 guard family beyond narration (capability/model/service claims
land as they're justified — narration is the one S2 proved); voice/
speaker assurance (S8 — the kernel's `assurance` field exists but S3 only
ever sees operator assurance); the daemon action classes (S5); step-up/
push confirmation (later); classification-aware egress (deferred per
owner). fetch_url port policy (carry) may be folded into the action-class
resource check if cheap, else ledgered.

## Process
SDD per task; final whole-branch review; commits on rebuild/v4 never
pushed; the DoD walked live before the slice is called done; owner gate at
the walk (behavior-changing). Carries → docs/plans/rebuild/slice-03-carries.md.
