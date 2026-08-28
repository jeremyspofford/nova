# Slice 1 — Carries to later slices

Written at S1 close-out (2026-08-28). These are the review-triaged items
that deliberately ride forward; each names its owning slice. Full detail
lives in the SDD ledger for S1 while it exists, and in this file after.

## Roadmap-level findings (from the live DoD walk)

- **CORRECTED 08-28 by the owner's live walk: qwen3.8:27b DOES load on the
  24 GB RTX 3090 — at 22/24 GB, a tight fit.** T7's "never loads (5-min
  runner timeout)" was conditions-bound: the probe ran with other models
  resident, and our tiering reads INSTALLED VRAM, never FREE VRAM. Real
  S2/S4 questions: root-cause the walk failure (free-VRAM accounting vs
  probe timeout), measure effective context at 2 GB headroom, whether
  SGLang serves the 27B with more room, and eviction/contention behavior.
  The tool loop must be validated against this tight-fit reality, not just
  "does it chat."
- **BM25 recall returned hits=0 for the conversational DoD question**
  ("what did we talk about?") — the answer came from persisted postgres
  history. Recall relevance for conversational phrasings belongs to S13
  (memory learning); the weak-ranking test noted in T5's minors rides with
  it.
- Small curated tiers are a qwen3-generation behind qwen3.5 — refresh when
  pinning S2 models, and diversify beyond the single qwen family (owner
  question 08-28); suggestions should become probe-informed ("verified on
  your hardware" via /admin/probe stamps) rather than floor-table-only.
  rocm-smi/AMD detection absent (R23) — decide AMD support in S2/S4.
- **Wizard gap (08-28, owner hit it live, refined by his walk): the model
  step gives NO fit warning at all.** The roadmap tier table specified a
  tight-fit warning for the 27B on 16-23 GB cards, but at exactly 24 GB it
  is the top pick with zero caveat — and it loads at 22/24 GB. The model
  step must state measured fit from probe stamps ("loads at 22/24 GB —
  limited context headroom; a second GPU consumer will contend") before
  the pick. Free-vs-installed VRAM accounting is part of this. S2 model
  work.
- **BUG (08-28, owner hit live): an in-flight chat turn dies on SPA
  navigation.** The SSE stream is component-scoped to ChatPage; navigating
  to Settings unmounts it, the abort reads as a client disconnect
  server-side (generation cancelled, only streamed partial persisted), and
  the reply never reaches the operator. Fix in S2 (or sooner): stream
  ownership lifted above the route so turns survive navigation, plus
  message re-fetch on ChatPage remount so persisted partials with
  interrupted markers render; e2e scenario: send → navigate away → return
  → full reply present.
- **Settings gaps (08-28, owner hit both live): no way to change the model
  after onboarding, and no way to re-run onboarding.** chat.model exists
  in SETTING_DEFS with no UI control (Settings ships only Appearance +
  Account in S1); v1 had a Setup-Wizard-re-run affordance as prior art.
  Both belong to the S2 model/settings surface. Stopgap: PUT
  /api/v1/settings with the bearer token.
- **Owner directive (08-28): SGLang must appear as an engine option IN THE
  ONBOARDING WIZARD** when its slice lands — bundled profile, live-verified
  like the other engine options, and the suggested engine for the
  ≥16-24 GB tiers per the roadmap tier table (R15 expires then). Scope it
  with the 27B-on-24GB investigation, for which SGLang is the leading
  candidate.

## Preconditions pinned to specific slices

- **S8 (household)**: memory's `append_journal` read-modify-write race is
  harmless for a single sequential owner and MUST be fixed before
  multi-person/concurrent ingest. Named precondition, not backlog.
- **S16 (installer/updater + DR)**: `./install update` is an honest exit-1
  stub by ruling R22; the full pull→backup→up→health→bounded-rollback path
  lands here. Owner-password recovery path (none exists in S1 — lost owner
  password = manual DB surgery) lands here too, with v1's admin-secret
  escape hatch as prior art.
- **S2 seam-hygiene batch** (final review recommendation): memory service's
  {"detail"}/{"error"} shape drift; dead INSTANCE_SECRET env (drop or mark
  reserved); explicit `location = /health/live` in web nginx; .env chmod
  600 + openssl preflight; explicit N-1→N migration test case.
- **S2 follow-ups from the last re-review**: mirror the Accept-Encoding:
  identity fix into core's `peers.client()` (same latent bug one hop up,
  dormant until anyone adds gateway compression); pin the split proxy
  timeout shapes with constant assertions (currently untestable revert);
  add a test for a non-compliant backend that compresses despite identity
  (today: stripped header, defense-in-depth only); normalize caller header
  keys in the outbound merge.
- **CI first run**: the rebuild-ci.yml workflow has never executed (lane
  never pushed). On first push, watch it actually go green — its postgres
  service block is load-bearing for 137 DB tests. The e2e job is
  deliberately `if: false` with a stated enable-checklist.

## Everything else

~40 further reviewer minors were triaged RIDES at the final whole-branch
review (cosmetics, polish, documented edge cases) — none load-bearing. See
the S1 review history in git (`.superpowers` ledger while present) if one
resurfaces.
