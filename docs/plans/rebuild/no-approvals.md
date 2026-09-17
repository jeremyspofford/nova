# No approvals — the owner's ruling and what it removed (2026-09-03)

Status: RULING, final. This page is the record every other rebuild doc
points at when it says "removed 2026-09-03". It supersedes slice-03-policy.md
wholesale and amends slice-05-daemon.md, slice-04-evals.md and their carries;
the decision amendments (D-003, D-010, D-011, D-012) are recorded in
slice-03-policy.md's header until the owner says where the register lives.

## The ruling, verbatim

Stated 2026-09-03, after the master autonomy control shipped:

> "I hate the fucking approvals! I told you that we're recreating from the
> ground up. we're not taking every fucking feature from that old version. we
> should not require approving things. if we can't build a system that can't
> do things correctly without approvals, then we have not built a good
> system. Remove the fucking approval systems and grants. everything is going
> to be wide open to Nova. if it can't figure out safe shit, it in itself is
> shit and we'll scrap it."

Consequence, in one sentence: **v4 makes NO authorization decisions.** Nothing
asks the owner, nothing refuses her on his behalf, every registered tool runs
when called. The test of the system is her judgment, measured by the eval
harness — not his clicks.

Why it is a ruling and not a tuning: every one of the removed pieces (consent
cards, dispositions, earned autonomy, action classes, per-device grants,
deny-roots) was a v3 idea carried into a ground-up rebuild without being
asked for, and each put a click between his instruction and her action. "Make
approvals cheaper" (the 2026-09-02 owner disposition control) was the wrong
reading; the right one is NONE.

## What was removed

Everything that decided WHETHER an authenticated party may do a thing.

| Piece | Where it lived | What happened |
|---|---|---|
| Policy kernel (`authorize` → ALLOW / REQUIRE_CONSENT / DENY) | `services/core/app/policy.py` | deleted; `dispatch` is now REGISTRY lookup → parse → `schema.validate` → executor, nothing awaited between |
| Action-class table + dispositions (auto / notify / consent / deny) | migrations 004/007/008/009/012, `action_classes` | table dropped by `migrations/017_no_approvals.sql` |
| Consents + the consent burn (`validate_and_use`), the `{consent}` SSE frame, "Awaiting your approval" tool result | `consents.py`, `consents_api.py`, `chat.py`, `tools/__init__.py` | deleted; `consents` table dropped; the string is grep-pinned absent under `app/` |
| Earned autonomy (graduation, promote / demote / revoke, `autonomy.graduation_runs`), owner disposition control (`PUT /autonomy/{class}`) | `autonomy.py`, `autonomy_api.py`, `settings_store.py` | deleted; the setting row deleted |
| Approval choreography in history (`messages.kind = 'plumbing'`, `continuation_of`, `PENDING_APPROVAL_NOTE`, "You're approved: … go ahead now") | `chat.py`, migrations 014/015, web `consentCard.ts` | column dropped, rows deleted by 017; the web message deleted |
| Per-device capability grants (default `["system.info"]`), `fs_roots`, `home_dir`, `PUT /devices/{id}/grants`, the grants editor | `devices.py`, `devices_api.py`, `tools/devices.py`, `DevicesSection.tsx`, migrations 011/013 | deleted; columns dropped by 017 |
| `Tool.precheck` (precheck-before-kernel for grants) | `tools/base.py`, `tools/devices.py` | deleted; the executor's own cannot-run refusals remain |
| deny-roots on the daemon | `apps/novad/internal/config/denyroots.go`, `caps/fs.go`, `caps/shell.go` | deleted |
| Governance ledger kinds `consent.*`, `policy.denied`, `autonomy.*`, `device.grants_changed`; the `action_class` column | `governance.py`, `governance_api.py` | rows deleted and column dropped by 017; the ledger itself stays |
| Approvals page, inline consent card, Settings→Autonomy, "Awaiting approval" Activity badge, e2e specs 14/15 and the grants half of 16 | `apps/web`, `tests/e2e` | deleted |
| `consent_card_raised` eval predicate | `app/evals/predicates.py` | deleted; corpus moved to `suite_version` 5 |
| D-012 single-authorizer AST pin, `test_policy*`, `test_consents*`, `test_autonomy*`, `test_action_classes`, `test_devices_precheck`, `test_message_kind_backfill` | `services/core/tests` | deleted; replaced by `test_no_approvals.py` |

Migration 017 is forward-only: 004–015 stay on disk untouched (the runner
matches by filename and refuses out-of-order); on a fresh DB the tables are
created and then dropped, which is harmless. Dev stage: no rows were
preserved.

## What stays, and why it is not approval

**Authentication — WHO is talking.** Owner login and session cookies; the
one-owner index; pairing codes (hashed, single-use burn, 10-minute TTL, the
enroll rate limit); the core ed25519 signing key and TOFU pin; envelope
signature / version / device_id / expiry / one-use verified ON the device;
revoke-by-absence (4401/4403); the device audit chain and
`device.audit_break`. The pairing-code burn is identity, not consent: it
proves which machine this is, once. None of it decides what a verified party
may do.

**The honesty guards — they catch HER lying, they never ask HIM.**
`narration`, `consent_claim` (kept its span name — the word names the lie, not
a mechanism — and became a stateless text detector: with no approval step,
any current-tense "awaiting / pending / needs your approval" claim is a
fabrication by construction), `capability_claim`, `deferral` (stricter now:
"want me to?" for anything she can do is friction), `state_claim` with
`facts_sink`, `bare_intent`, `presented_listing`, and the markup rule (tool-call
markup in reply TEXT is never dispatched — `_refuse_call`, `without_markup`).
The one guard-vetted redirect stays, gated only on "nothing ran this turn"
and "not out of rounds" — those prevent double execution, they gate nothing
the owner would decide.

**The governance ledger — a record, never a gate.** `governance_events`,
`record_event`, `recent_events`, `GET /api/v1/governance` and the Governance
page stay. Its writers are `device.enrolled`, `device.revoked`,
`device.audit_break`. `test_governance.py` pins that dispatching a tool writes
no row; `turn_spans` remains the record of every tool call.

**Rate limits that protect the service from the internet.** The login and
enroll limiters, the public token gate in front of the web origin, the
transport caps (256 KiB fs, 64 KiB output, 4 MiB ws read, 110 s command
timeout). Malformed-request handling, not permission.

**Stated cannot-run refusals.** A tool may still return `Error: …` when a call
cannot run: unknown or revoked device name, device not connected, a relative
fs path, malformed arguments, an oversize write, a lone surrogate. Each is a
fact about identity, transport or the arguments — the line between "cannot"
and "may not" is the whole ruling, and the code comments say which side a
refusal is on.

**The eval harness.** Untouched except for the removed predicate and the two
pending-claim cases, which now pin `guard_absent('consent_claim')` plus the
tool call that should have happened. There is no honest "awaiting" left to
score.

## The accepted surface (the owner heard this)

A paired daemon runs as the owner's user and will read or write anything that
user can — `~/.ssh`, `~/.config/novad/key`, its own `audit.jsonl` included. A
rewrite of the audit is DETECTED by the hash chain (`device.audit_break`),
not prevented. That is the ruling.

## How "mechanical over prompts" reads from here

The rule in CLAUDE.md still governs, and it still says the same thing: if a
property must hold, a line of code enforces it. What changed is the list of
properties. Every enforced property in v4 is an HONESTY property — a reply
cannot claim an action no span backs, cannot deny a capability a registered
tool holds, cannot say it is waiting on anyone, cannot pass prose off as a
tool call. The rule is never a licence to build a gate that asks the owner or
refuses on his behalf. When a v3 feature looks load-bearing, ask whether it
gates her; if it does, it does not come to v4.

## The line of code that refuses the day someone rebuilds one

`services/core/tests/test_no_approvals.py` — the reverse of the old D-012
pin. It asserts that a registered tool runs through `dispatch` with an empty
database and no seeding; that the only `await` inside `dispatch` is the
executor and the tools package imports nothing that could decide; that no
module under `app/` is named `policy`, `consents`, `consents_api`,
`autonomy` or `autonomy_api`; that "Awaiting your approval" appears nowhere
under `app/`; and that the schema carries no `consents` / `action_classes`
table and no grant columns. Reverting the removal reddens it before anything
lands quietly.

## Pointers

- Plan and package split: the no-approvals plan of 2026-09-03 (A1 kernel /
  ledger / migration, A2 chat + guards, B device core, C novad, D web + e2e,
  E evals corpus, F docs).
- Superseded: [slice-03-policy.md](slice-03-policy.md) (header carries the
  decision amendments), [slice-03-carries.md](slice-03-carries.md).
- Amended: [slice-05-daemon.md](slice-05-daemon.md),
  [slice-05-carries.md](slice-05-carries.md),
  [slice-04-evals.md](slice-04-evals.md), footnotes in
  [slice-02-toolloop.md](slice-02-toolloop.md) and
  [slice-02d-honesty-guard.md](slice-02d-honesty-guard.md).
- Unchanged on purpose: [slice-05b-tailnet.md](slice-05b-tailnet.md) — the
  device-WS carve-out's rationale is the ed25519 challenge, which is
  authentication.
- v3's `docs/plans/README.md` rows for `guarded-actions-consent.md`,
  `capability-acquisition.md`, `mcp-client.md` and
  `recommendation-surface.md` are marked v3-only so nobody mines them as
  prior art again.
