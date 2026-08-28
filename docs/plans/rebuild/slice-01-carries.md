# Slice 1 — Carries to later slices

Written at S1 close-out (2026-08-28). These are the review-triaged items
that deliberately ride forward; each names its owning slice. Full detail
lives in the SDD ledger for S1 while it exists, and in this file after.

## Roadmap-level findings (from the live DoD walk)

- **qwen3.8:27b installs but never loads on the 24 GB RTX 3090 via ollama**
  (runner timeout at 5 min). The 27B-on-24GB pin — the roadmap's central
  bet — needs deliberate investigation in S2 (tool-loop stress) / S4
  (evals): quantization choice, context size, engine (SGLang). The wizard
  tier-cascade currently offers four working smaller models.
- **BM25 recall returned hits=0 for the conversational DoD question**
  ("what did we talk about?") — the answer came from persisted postgres
  history. Recall relevance for conversational phrasings belongs to S13
  (memory learning); the weak-ranking test noted in T5's minors rides with
  it.
- Small curated tiers are a qwen3-generation behind qwen3.5 — refresh when
  pinning S2 models. rocm-smi/AMD detection absent (R23) — decide AMD
  support in S2/S4.
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
