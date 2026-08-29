# Slice 2e — Model & inference control surface

Parent: the Master Roadmap; trigger: owner chose this after S2 QA
(2026-08-29) over the policy kernel — it clears real daily friction he hit.
Consumes carries from S1/S2: no change-model UI, no fit warning, no re-run
onboarding, single-family curated pool, SGLang-in-onboarding directive
(task #8), free-vs-installed VRAM, the nvidia_smi measurement anomaly.
Slice type: mostly additive (T1/T2); T3 SGLang adds an engine. Size: L.

Reality check that reshapes this slice: S2's measurement PROVED the 27B
loads and runs well on the 24 GB 3090 via ollama (16.6 GB, 32K ctx, faster
than the 8B). So SGLang is a PERFORMANCE/throughput option, NOT a rescue —
its urgency dropped; it is sequenced last and starts with a spike.

## DoD (operator-visible, real stack — no isolation, testing policy 08-29)
1. Change the chat model from the UI (Settings → Models), no curl. The
   next chat turn uses it (the reply's model badge shows it).
2. The model picker (wizard + settings) shows a real FIT signal per model
   against detected hardware ("loads at ~22/24 GB — tight", "won't fit",
   "comfortable") from probe data + free-vs-installed VRAM, not just a
   static floor.
3. Re-run onboarding from Settings.
4. The curated list spans more than one family, every slug re-verified
   against the live library, with a measured/verified badge where probed.
5. (T3) SGLang is selectable as an engine in onboarding + settings IF the
   spike shows it's worth bundling; otherwise a documented decision to
   defer, with the spike's evidence.

## Tasks

### T1 — Change-model-from-UI + re-run onboarding (M, additive)
- Settings → Models section: current chat model; the installed models
  (gateway /v1/models) + the curated set; switch chat.model (PUT
  /api/v1/settings) live; pull a curated model not yet installed
  (streamed progress via the existing /api/v1/models/pull proxy); show
  the active backend (kind + url/provider, key masked). A "Re-run setup"
  action that clears onboarding.completed (or routes to /onboarding) so
  the wizard can reconfigure engine/model. No new backend concepts —
  wire the existing gateway admin + core settings. Reply model-badge
  already exists (S2); confirm it reflects a mid-session switch.
- Tests: settings model list renders installed+curated with current
  marked; switch persists + the next turn's meta model changes; pull
  streams; re-run clears the flag; auth.

### T2 — Fit-aware, diversified, verified model catalog (M, additive)
- Gateway: extend /admin/suggest + the curated file so each model carries
  a FIT verdict computed against detected hardware using FREE VRAM (not
  just installed-sum): comfortable / tight / won't-fit, with the numbers
  ("~22/24 GB"). Where a probe row exists (measured VRAM/tok-s), prefer
  it and badge "verified on your hardware"; else the tier estimate,
  badged "estimated". Resolve/annotate the nvidia_smi measurement anomaly
  (free-vs-installed) from the S2 carry as part of this.
- Diversify the curated file beyond qwen (add 1-2 other current families
  at the main tiers), and RE-VERIFY every slug against the live ollama
  library (HTTP check, dated verified_url), dropping/replacing any that
  404 — never recite a slug as certain.
- Wizard Model step + T1's settings list both render the fit verdict and
  badge; a "tight"/"won't-fit" pick shows the warning the S1 wizard
  lacked BEFORE the download.
- Tests: suggest fit verdicts table-driven over VRAM/free cases; probe-
  vs-estimate precedence; slug-verification presence; the picker renders
  warnings.

### T3 — SGLang engine (L, spike-then-build)
- SPIKE FIRST (report, don't build blind): verify current SGLang
  packaging (the model-gateway/router vs the server; PyPI/container
  status as of build), and whether SGLang serves the pinned 27B on this
  24 GB card MEASURABLY better than ollama (tok/s, ctx, structured
  output) — the S2 measurement is the ollama baseline. Output: a
  recommendation to bundle now or defer, with numbers.
- IF bundle: a `sglang` compose profile (its own container), a gateway
  sglang backend adapter behind the existing backend contract, the
  engine offered in onboarding + settings, and the hardware-tier
  suggestion updated (SGLang suggested for >=16-24 GB per the roadmap
  table; ruling R15 from S1 expires here). This discharges task #8.
- IF defer: a committed decision doc with the spike evidence; task #8
  stays open with the reason.

### T4 — e2e + DoD walk (M)
- Real-stack scenarios: change model in Settings -> next turn uses it;
  fit verdicts render for installed models; re-run onboarding reachable;
  (if T3 built) SGLang selectable + a turn served by it. Then the live
  DoD walk; owner walks it.

## Rails
No fake numbers (fit/VRAM shown only when real; estimated clearly badged);
slugs never recited as certain (live-verified); no success unchecked;
backend key never unmasked/logged; 127.0.0.1; refuse-all tokens; real-
stack testing, rebuild freely (no isolation); comments self-contained.

## Out of scope
The policy kernel (S3, next); voice; per-person model prefs (S8);
fine-tuning/LoRA (S19).

## Process
SDD per task; T3 spike gates its own build; final whole-branch review;
rebuild the real stack after review; owner walks; carries ->
slice-02e-carries.md. Commits on rebuild/v4, never pushed.
