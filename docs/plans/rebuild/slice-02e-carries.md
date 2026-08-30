# Slice 2e — Carries to later slices

Written at S2e close-out (2026-08-29). SHIPPED: change-model-from-UI +
re-run onboarding (T1), fit-aware/diversified/verified model catalog (T2),
e2e regression + real-GPU validation (T4). DEFERRED: SGLang (T3, owner
decision). Reviews clean; final whole-branch "with fixes" fixes applied.

## SGLang — DEFERRED (owner decision, evidence in slice-02e-model-surface.md
T3 DECISION + task-3-spike-report.md; task #8 open with flip conditions)
- Flip conditions: (a) multi-user/concurrent-turn need (S8); (b) a measured
  structured-output failure the narration guard / JSON-mode can't fix;
  (c) an easy, trust-verifiable AWQ/GPTQ quant of the pinned model.

## Model-catalog carries (later model polish)
- **Eviction modeling gap (ruling S2e-R2 limit)**: free-VRAM fit never
  models that ollama EVICTS the resident model on switch, so with the 8B
  resident (9.3 GB free ~14.7) the 27B reads wont_fit even though it would
  load fine after eviction. Over-warns in the resident-other-model case.
  Fix later: model "free-after-evicting-swappable-models" or lean on
  probe data.
- **min-card-tier vs typical-usage estimate**: today min_vram_gb doubles
  as both the tier floor (suggest.py) and the load estimate (fit.py). The
  27B was re-anchored to 17 (measured 16.2) as a one-number fix; the
  principled successor is separate fields. Do it when a second model needs
  it.
- **Probes are empty by default** → all fit verdicts are estimate-only
  until something probes. Consider an opt-in "probe this model" button
  (NOT auto-probe-on-load — that loads a model on a cheap read and risks
  VRAM contention). Once probed, verdicts badge "verified on your
  hardware".
- **measured_at on the verified badge** (UX): show when it was measured.
- **curated pool**: still small; keep diversifying + re-verifying slugs at
  each model-slice pass (gemma4:12b, llama3.1:8b added this slice).

## Robustness carries (cheap, from the T2 review)
- **malformed /api/ps JSON 500s /admin/suggest** (admin.py:82) and the
  same class on a successful probe (admin.py:245): wrap resp.json() to
  degrade to `unknown` with a stated reason (house rule: never crash where
  you can state a reason). Does NOT endanger normal use (a DOWN ollama
  already degrades cleanly; only 200-with-garbage 500s, and Settings still
  lists installed behind an honest banner) — but fix in a cleanup pass.
- **fit.py:80-83 docstring** promises a no-estimate→unknown path the code
  doesn't have (KeyError→500); pinned by test_curated REQUIRED_FIELDS, so
  latent only. Align the docstring or add the guard.
- Stale type hint (_resident_vram_mb → int|None, returns float).

## UI carries
- ChatPage pre-first-turn model badge can show the old model until the
  first meta frame after a switch (self-corrects; ChatPage untouched this
  slice).
- Re-run-setup error-after-flag-cleared reads as a generic failure
  (recoverable by reload); friendlier message later.
- The "tight" label shows needed/total while the verdict is computed vs
  free — when tightness comes from residency the shown pair doesn't
  explain it; add free_gb to the label later.

## Operator notes (this build)
- chat.model is currently qwen3:8b (not the 27B) — switchable in the new
  Settings→Models UI, or set on request.
- After rebuild, run POST /api/v1/models/probe for qwen3.8:27b (and 8b) so
  their verdicts flip to "verified on your hardware".

## Probe-timeout finding (2026-08-29, controller, at the S2e rebuild)
Probing qwen3:8b succeeded (9507 MB measured → verified). Probing
qwen3.8:27b FAILED with ReadTimeout at 30s — the probe's 30s timeout is
too short for a COLD load of a 27B (the model loads fine, just slowly from
cold). Effect: large models can't get a "verified" badge on first probe;
they show the (now-correct) estimate. Fix later: probe should warm/allow a
longer load window for large models (or a two-phase load-then-measure), so
verified fit is reachable for the flagship model. Not blocking — the 27B's
corrected estimate (17GB → comfortable) is accurate.

## S2f — model fit & switch correctness SHIPPED (2026-08-29)
Fixed the three S2e-walk bugs: (A) a model switch now updates the current
marker + chat badge with no message; (B) fit is eviction-aware (a switch
evicts the resident model, so an 8B reads comfortable even while the 27B
is resident); (C) needed_gb is the WHOLE-CARD footprint (weights+KV+
buffers+baseline = what nvidia-smi shows), not ollama size_vram/weights —
27B re-anchored 17→22 (tight, reversing the S2e size_vram error), and the
probe records a single post-load nvidia-smi `after` reading (eviction-
immune), needing the gateway GPU override (deploy/docker-compose.gpu.yml)
to measure. Remaining carries: stale S2e 8b probe row (weights frame) must
be re-probed post-deploy to read correct; ctx-aware KV footprint (needed
scales with context) is still a later model-slice item; probe force-loads
a model (GPU time) — a "probe this model" button is future UX.
