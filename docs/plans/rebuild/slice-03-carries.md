# Slice 3 — Carries to later slices

Written across S3 close-out (2026-08-30). Review-triaged items that ride
forward, each named to its owning slice. Discharges the S3 process rule
("Carries → slice-03-carries.md") and ruling S2-R8's survive-workspace-
deletion requirement.

## Operator-role gating — S8

The consent decide/list API, the autonomy revoke API, and the governance
audit read are all **authenticated** but have **no operator-ROLE gate** —
any authenticated person can decide any consent, revoke any earned class,
and read the audit. This is consistent with the whole core service today:
there is no role system yet (every authenticated principal is one tier).
It is NOT a hole opened by S3 — it is the absence of a feature S8 builds
(roles owner/adult/kid/guest + the assurance ceiling). When S8 lands the
role system, gate these three surfaces to operator/owner. Surfaced three
times (T2 review Important #1, T3 review Important, whole-branch review
finding #2). See [[goal-scoped-autonomy]] for the verb-scope shape that
pairs with roles.

**The mismatch S8 must resolve (whole-branch review finding #2):** the
FRONTEND nav already gates Approvals / Governance / Settings at
`minRole:'admin'` (Sidebar.tsx, via lib/roles.ts `hasMinRole`), while the
BACKEND routes enforce only `require_person` (authenticated, any tier). So
the UI *implies* an admin-only protection the API does not enforce — the
moment a non-owner account exists, a non-admin could decide/revoke/read via
the direct API, bypassing the cosmetic nav gate. Zero exposure in the owner
walk (single account; registration closes after the first owner). S8 must
add the REAL backend role check on these routes (the nav gate is not a
control), not just trust the nav.

## Approval-card UX robustness (web) — a later web polish slice

- **`resumeApprovedCard` has no server status re-check** before it sends
  the continuation turn — it trusts the caller. All three call sites
  (ApprovalCard, ConsentCardRow, ApprovalsPage) gate it correctly today,
  so it is NOT reachable through the UI, and the mechanical line already
  refuses regardless: the funnel re-raises a card for anything that is not
  a live approved consent, so the worst case of a stale/forged trigger is a
  wasted turn, never an unauthorized run. Add a server-side
  `card.status == 'approved'` pre-check as defense-in-depth when the
  approvals UI is next touched.
- **"Go ahead" state is not durable across a reload.** An approved-but-
  unresumed card does not survive a browser refresh from the Approvals
  page, because `GET /api/v1/consents` is pending-only — an approved card
  drops off that list. Self-disclosed; the action still executes on the
  next real re-attempt. Make approved-unburned cards fetchable (a status
  filter on the consents list) when durability is wanted.
- **The inline chat card is populated only by the live `{consent}` SSE
  frame** — `ChatPage` on mount calls `getMessages`/`loadConversation` but
  never fetches pending consents (`pending_for_conversation` exists on the
  backend, unused by the client). So a card appears inline during the turn
  that raised it, but a page reload / re-open of the conversation drops the
  inline render — the card is still on the Approvals page and the consent
  still persists and gates. Display-only, not a security gap: the kernel
  still refuses without a burned consent. DoD item 1 as walked live holds
  (the card shows inline in the turn). Hydrate pending consents into the
  transcript on mount (a `getPendingConsents(conversation_id)` reconcile
  next to `getMessages`) when the chat UI is next touched. Pairs with the
  "go ahead not durable across reload" gap above.
- **Cross-page continuation targets the active conversation**, not the
  card's own `conversation_id`. Correct today only because the app is
  single-conversation-per-person; the moment a second conversation can
  exist, target `card.conversation_id` explicitly.
- **Settings→Autonomy "recent decisions" is hard-capped at 5** per class
  with no pagination in that view. The full history is reachable via the
  Governance page's `?action_class=` filter — but that is not yet a
  deep-link from the Autonomy row. Add the deep-link (and/or paginate the
  inline list) in a later web slice.

## Consent / kernel robustness — carried from T1

- **`raise_consent` find-or-create is not race-safe** (sequential
  find-then-insert; two simultaneous identical raises could both insert).
  Harmless today (a duplicate pending card, deduped in the UI), but add a
  partial unique index on (action_class, args_hash, requestor, pending) to
  make it mechanical.
- **`governance_events` append-only is convention, not DB-enforced.** No
  code path updates/deletes them, but nothing at the DB level refuses it.
  Consider a trigger or a revoked UPDATE/DELETE grant if the audit's
  integrity ever needs to be provable, not just observed.
- **Consent TTL is a 24h constant** (`consents.CONSENT_TTL_SECONDS`), not
  a setting. Promote to the settings registry if operators want it tunable.
- **The pure-AST D-012 tripwire skips with no DB.** `test_policy.py`'s
  single-authorizer AST walk sits under module-level `requires_db`, so it
  SKIPS locally with no `TEST_DATABASE_URL` (CI has postgres, so it is
  covered there). Cheap follow-up: move the pure-AST test to a DB-free
  module so the D-012 pin holds even on a local no-DB run.

## Docs

- The E2E README's honesty-line staleness (line ~202, "Nothing in the
  running system currently refuses a reply that claims a file operation")
  is FALSE since S2d and is corrected in S3-T4. Noted here only so the
  correction is not later mistaken for a regression.

## Deferred by owner (not S3's to reopen)

- **SGLang engine** (task #8) — deferred with flip conditions; see
  slice-02e-carries.md, not re-litigated here.
- **Step-up / push confirmation**, **classification-aware egress**, and
  the **daemon action classes** (S5) — named out-of-scope in the slice
  plan; the kernel's `assurance` field exists but S3 only ever sees
  operator assurance (voice assurance is S8).
- **fetch_url port policy** (from slice-02-carries security list) — the
  action-class table now exists as the place to express it, but S3 did not
  add a per-resource port check; fold into the action-class resource check
  when the daemon/browser slices make egress policy load-bearing.
