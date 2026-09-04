# Slice 3 — Carries to later slices

Written across S3 close-out (2026-08-30). Review-triaged items that ride
forward, each named to its owning slice. Discharges the S3 process rule
("Carries → slice-03-carries.md") and ruling S2-R8's survive-workspace-
deletion requirement.

**Amended 2026-09-03 (owner ruling — see [no-approvals.md](no-approvals.md)):**
the approval-card UX and consent-kernel carries below are CLOSED BY REMOVAL
— the cards, the consents, the kernel and earned autonomy are gone. Kept:
the ledger append-only convention and the S8 governance-read role gate.

## Operator-role gating — S8

The governance audit read (`GET /api/v1/governance`) is **authenticated**
but has **no operator-ROLE gate** — any authenticated person can read the
audit. This is consistent with the whole core service today: there is no
role system yet (every authenticated principal is one tier). It is NOT a
hole opened by S3 — it is the absence of a feature S8 builds (roles
owner/adult/kid/guest + the assurance ceiling). When S8 lands the role
system, gate the governance read to operator/owner. Surfaced three times
(T2 review Important #1, T3 review Important, whole-branch review finding
#2). The two sibling surfaces this carry used to name — the consent
decide/list API and the autonomy revoke API — were removed 2026-09-03 with
the approval system; nothing gates them because they do not exist.

**The mismatch S8 must resolve (whole-branch review finding #2):** the
FRONTEND nav gates Governance / Settings at `minRole:'admin'` (Sidebar.tsx,
via lib/roles.ts `hasMinRole`), while the BACKEND route enforces only
`require_person` (authenticated, any tier). So the UI *implies* an
admin-only protection the API does not enforce — the moment a non-owner
account exists, a non-admin could read the audit via the direct API,
bypassing the cosmetic nav gate. Zero exposure in the owner walk (single
account; registration closes after the first owner). S8 must add the REAL
backend role check on this route (the nav gate is not a control), not just
trust the nav. This is a role gate on READING a record — identity, not
approval; it must never grow into a gate on what Nova does.

## Approval-card UX robustness (web) — CLOSED BY REMOVAL 2026-09-03

Five carries lived here (`resumeApprovedCard` status re-check, "Go ahead"
durability across reload, inline-card hydration on mount, cross-page
continuation targeting, the Settings→Autonomy "recent decisions" cap).
Every one was about approval cards, and the cards, the Approvals page,
Settings→Autonomy and the `{consent}` frame are gone by owner ruling — see
[no-approvals.md](no-approvals.md). Nothing carries forward.

## Ledger robustness — carried from T1

- **`governance_events` append-only is convention, not DB-enforced.** No
  code path updates/deletes them, but nothing at the DB level refuses it.
  Consider a trigger or a revoked UPDATE/DELETE privilege on the DB role if
  the audit's integrity ever needs to be provable, not just observed. (The
  ledger is a RECORD; this carry is about its integrity as a record, never
  about reading it to decide anything.)
- Closed by removal 2026-09-03: the `raise_consent` race, the consent TTL
  constant and the D-012 single-authorizer AST tripwire (`test_policy.py`)
  went with the kernel. The reverse pin is `test_no_approvals.py`.

## Docs

- The E2E README's honesty-line staleness (line ~202, "Nothing in the
  running system currently refuses a reply that claims a file operation")
  is FALSE since S2d and is corrected in S3-T4. Noted here only so the
  correction is not later mistaken for a regression.

## Deferred by owner (not S3's to reopen)

- **SGLang engine** (task #8) — deferred with flip conditions; see
  slice-02e-carries.md, not re-litigated here.
- **Classification-aware egress** and the **daemon capabilities** (S5) —
  named out-of-scope in the slice plan; voice assurance is S8 (identity,
  not approval).
- Struck 2026-09-03 (no approvals): **step-up / push confirmation** and
  "fold **fetch_url port policy** into the action-class resource check".
  There is no action-class table to fold anything into and nothing to
  confirm. If a port policy for fetch_url is still wanted it is a tool-side
  CANNOT-run refusal in the SSRF guard's shape — never a class, never a
  card.
