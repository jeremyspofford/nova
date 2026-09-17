# Archived branches

Work that is preserved but not live. Each entry says what the branch is,
whether anyone has run it, and what is worth mining if it ever comes back.

**Why this file exists.** Both branches below were archived deliberately and
neither was mentioned anywhere in the repository, so the only way to learn
they existed was `git branch -a`. That is the same failure that lost the
quality-corpus TODO for four days and hid the S23 spec on the day it was
written: work that is not listed where people look is invisible, however
carefully it was preserved. Anything archived from here on gets a line here.

Both are pushed to origin. Neither is merged into `main` or `rebuild/v4`,
and neither should be — they are records, not plans.

---

## `archive/v3-governance-wip` (e426cc4c)

A v3 governance/observability programme, written 25–27 August 2026, found
uncommitted in the v3 working tree on 09-11 and committed there rather than
to `main`. The working copy was discarded on 2026-09-15 after verifying all
23 files byte-identical to this branch.

**NOT VALIDATED.** It has never been run; migration 134 has never been
applied to any database, so `governance_events` does not exist anywhere.

Four slices, driven by `docs/DECISIONS.md` — a 38-entry ADR register that
declares itself authoritative with a tiebreak rule over every other
document, and is the single piece most worth not losing.

- **S1 `gates.py`** — an inventory and verifier of v3's 13 mechanical
  enforcement points, wired advisory-only into boot. Despite the name it
  decides nothing.
- **S2 `governance.py` + migration 134** — an append-only event ledger whose
  INSERT runs on the caller's connection inside the caller's transaction, so
  a failed event rolls back the state change it describes. Payloads are
  typed constructors whose errors never echo the offending value.
- **S3 `execution_records.py`** — a read model over five execution
  lifecycles, deliberately orphaned, with a test that FAILS if anything
  starts consuming it.
- **S4 `context_manifest.py`** — per-call cloud-egress classification
  recorded as a trace span at the one mandatory seam, observe-only, the
  manifest passed explicitly rather than held as ambient state.

**Relationship to v4, which is mixed and worth knowing before reviving any
of it.** The ledger design was independently re-landed in v4 and survives
the 2026-09-03 no-approvals ruling. **The context manifest has no v4
equivalent at all and is the genuinely novel piece.** But the consent-burn
half — `test_consent_burn.py`, `gates.py`'s `consent-burn` entry, two of the
three governance event types — pins exactly the machinery that ruling
deleted, so it cannot come back as written.

Half-built on its own terms: three of six planned S4b adapters landed, and
enforcement (D-013/D-014) was explicitly never built.

---

## `archive/v3-identity-view` (e33a7673)

A motion prototype for a face view, archived 2026-09-15. Seventeen files,
about 2,000 lines, last commit marked `wip` and seven weeks old at the time
of archiving.

**NOT VALIDATED.** Never run by me, never merged, and it targets v3's
`frontend/`, which v4 replaced with `apps/web`.

What is in it: `frontend/src/brain/identity/` (face, head, hair, body,
stage, mode — 1,494 lines), `frontend/src/voice/visemes.ts` (332 lines of
lip-sync mapping), speech.ts amplitude wiring, and a `facecap.glb` model
with a basis transcoder.

**Why it was kept rather than deleted:** v4 has no face view of any kind, so
this is a design that outlives the codebase it was written against. The
viseme mapping in particular is fiddly, self-contained work that would be
irritating to redo and easy to port — it is a pure function from phonemes to
mouth shapes, with no dependency on v3's architecture.

The branch also carries two unrelated runner fixes (a cloud provider
refusing must fall back to local and say why). Check whether v4's routing
already covers that before assuming it is a carry.
