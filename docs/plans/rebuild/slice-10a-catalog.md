# Slice 10a-1 — Model catalogue: close-out and carries

Plan: ~/.claude/plans/ethereal-cooking-dusk.md (approved 2026-09-06; the
row shape, rails, sub-slices and DoD walk live there). Branch `slice/s10a`
in `.worktrees/s10a`, rooted at rebuild/v4 2af8c89b, with rebuild/v4's S9
and theme commits merged back in at 8ceb0b2b. Commits: T0 af1d5ba9 (the
Providers review's five findings), T5a 35f0cd25 (web ground), T5b f78f9188
(the Models page), T4 832d7bc5 (core measured join), T1 6fdeb080 + T2
7d38ad3f (gateway, built in parallel worktrees by two implementers), T3
d2350c9d (the assembler), the cache reconciliation ae642f86, the theme
token swap 8ceb0b2b. Deployed 2026-09-07 from the branch's HEAD (images
built with `git archive HEAD:<dir> | docker build`, since the shared v4
tree held another session's uncommitted edits).

## What shipped

- **One row shape, every source.** `services/gateway/app/catalog.py`
  assembles installed models (ollama `/api/tags` + `/api/show`: size,
  digest, params, quant, context, family, license, and the `capabilities`
  manifest — completion, tools, vision, audio, thinking, embedding), the
  curated picks not installed (the VETTED layer: label, note, `use_cases`,
  numbers only where nothing declared or measured stands), and every
  registered provider's listing (`context_length`, prices, `max_output_
  tokens`; tools ⇐ `supported_parameters`, vision/audio ⇐ `input_
  modalities`, thinking ⇐ `reasoning`; OpenRouter's Artificial Analysis
  indices as declared, labelled third-party). Every fact is `{value, basis,
  source}`; a source that fails is `ok:false` in its own words and the page
  still renders. Fit comes from the SAME `_fit_context` `/admin/suggest`
  uses; an uncurated, never-probed model's fit is `unknown` with the reason.
- **Hugging Face, live.** `hf_hub.py` builds exactly the verified query
  (`filter=gguf`, the seven `expand[]`s, cursor from the `Link` header),
  refuses before the 501st anonymous call in 300 s, states a real 429 with
  `retry_after_s`, caches 60 s / 10 min keeping the ORIGINAL fetch time,
  lists a repo's GGUF quants with sizes and sha256 (default Q4_K_M marked,
  projector bytes added when an `mmproj` sibling exists), and maps a repo
  to a row: params/context/arch declared by the GGUF header, tools and
  vision INFERRED and said so, coding inferred from the name.
- **Ollama registry, by name.** `ollama_registry.py` resolves a typed
  `name:tag` (manifest → layers → config blob → family/params/quant/size)
  before any bytes move; `tags/list` does not exist upstream, so there is
  no library browse — the page says so. T2's live scratch run caught the
  registry answering a config-blob GET with a 307 that httpx does not
  follow (fixed, pinned), and found the live manifest carries NO
  `Docker-Content-Digest` — so S10a-2's drift check must compare the
  weights layer's sha256, not a manifest digest.
- **Pull preflight sizes from the source.** `/admin/pull` sizes an
  `hf.co/…[:quant]` pull from the repo's sibling and a tag from the
  registry manifest (bounded to 10 s, never blocking the pull); the
  preflight line gains `size_source` and `resolved`; a malformed model
  string is a 400 before anything is called; a second pull of the same
  model in flight is a 409 stating when the first started. `size_gb` left
  the curated file; `use_cases` (the fixed taxonomy, validated on load)
  joined it — `test_curated.REQUIRED_FIELDS` moved deliberately.
- **Core** forwards the four catalogue routes 1:1 and DECORATES
  `GET /api/v1/models/catalog` with the one fact only it holds: a measured
  suitability entry per eval suite from the newest complete run at the
  current version, matched against the live rows (a pre-registry bare id
  matches the bundled ollama row); pass rate null, never 0, when nothing
  was gradeable.
- **Web `/models`** (System nav): tabs with counts, source chips with fetch
  times (a failed source amber, in its words), text + capability +
  suitability facets (inferred OFF by default), size/params/context/price
  facets that hide AND count rows lacking the fact, a sortable table
  (absents last both ways), Use / Pull (quant menu for hub rows) / Probe /
  Details, Hugging Face search with cursor paging and the budget line,
  Pull by name resolved live. One pull at a time; installed is what the
  re-read catalogue says, never the stream. `lib/pullStream.ts` is the ONE
  pull reducer (Settings → Models and the wizard now share it).
- Suites: gateway 376, core 1384, web 514, tsc clean.

## Verified live (2026-09-07, the real stack)

`GET /admin/catalog`: sources ollama 4 / curated 4 / openrouter 430, all
ok. `ollama:muse-glimmer:latest` (hand-pulled, uncurated): 18.2 GB,
27.85B, Q4_K_M, 131072 ctx, capabilities completion/tools/vision/thinking,
fit unknown with the reason. `ollama:qwen3.8:27b`: declared facts + the
vetted use_cases, fit tight. A cloud row: context 1,050,000, prices, tools/
vision/thinking declared, coding 76.9 (third-party). `GET /admin/catalog/
hf?q=qwen coder`: three repos with params/context/downloads, tools and
coding marked inferred, budget 499/500, a next cursor. `GET /admin/
catalog/resolve?model=qwen3:4b`: 2.50 GB, Q4_K_M, qwen3, 4.0B from the
registry. Web bundle carries the page; tailnet 200.

## Owner-owed (the DoD walk, plan §Verification)

1. `/models` → Installed → muse-glimmer with its facts labelled.
2. Available → search "qwen2.5 coder" → Pull → quant menu → preflight
   names huggingface.co → progress → success → Installed lists
   `hf.co/…:Q4_K_M` → Use → a turn badges `ollama:hf.co/…`.
3. Pull by name `qwen3:4b` → preview from the registry → Pull.
4. Cloud → capability tools, price ≤ $1/1M → Use → a turn badges it.
5. Probe an installed model → measured VRAM, fit "verified on your
   hardware".
6. Revoke the OpenRouter key → amber source chip; page still renders.
7. Suitability = coding with "include inferred" off vs on.
8. A pull whose size cannot be fetched still says why and proceeds.

## Carries

- **Adversarial review did not run.** The four-lens refute workflow on this
  branch hit the session token limit before any finder returned; the
  gateway T1/T2 implementers' own reports and the suites are the only
  review so far. Re-run `review-s10a-1-catalogue` (script saved under the
  session's workflows) before the owner's walk, or walk first and review
  after.
- **rebuild/v4 merge pending.** The S9 session holds uncommitted edits in
  `.worktrees/v4` that overlap this branch's files (App.tsx, Sidebar.tsx,
  api.ts); `slice/s10a` already contains rebuild/v4's HEAD, so the merge is
  a fast-forward the moment that tree is clean.
- **Deploy trap, again:** in zsh `nova-$svc:latest` reads `$svc:l` as a
  modifier and tags the image `nova-gatewayatest` — build with the name
  spelled out, and compose `up --no-build` will not recreate a container
  whose image TAG resolved to a new id unless `--force-recreate` is given.
- **Drift (S10a-2)** must use the weights-layer sha256 (no
  `Docker-Content-Digest` on live manifests). `hf.co` rows: the GGUF's
  `lfs.sha256`.
- **`quants_of` tag derivation** is a derived approximation of ollama's own
  tag matching (shared filename prefix snapped to a boundary); documented.
- **S10a-2 / S10a-3** as planned: drift + Update, Probe from the row (the
  route exists; the button is live), measured column surfaced with a link
  to /quality, then `model_catalog_search` / `model_pull` for her with
  progress frames.
- The Settings → Models section still renders its cards (its e2e testids
  are pinned); shrinking it to current-model + link is a small follow-up.
- Per-model tool advertising in core stays informational (S10).
