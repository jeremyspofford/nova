# Slice 10a — Model catalogue: close-out and carries (10a-1, 10a-3, 10a-2)

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
- Suites: gateway 386, core 1384, web 522, tsc clean (after the review wave).

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

## S10a-3 — her tools (2026-09-07, commits 6e0a718a, 76483af4, 55b2a9bb)

`services/core/app/tools/models.py`: `model_catalog_search` (the same
gateway routes the page reads, core's measured layer joined; scope /
capabilities / size / context / price / sort; every fact read out WITH its
basis in words; a failed source named; a 429 or an unreachable gateway a
stated failure) and `model_pull` (cloud ids refused before the gateway;
preflight that does not fit → failure with the numbers; ollama's error
line relayed; progress through the new `ToolContext.progress` channel →
activity frames with `detail`, shown in the bubble as "using model_pull…
pulling X — 42% (1.0 GB of 2.3 GB)"; SUCCESS only when the re-read
catalogue lists the model; `set_as_chat_model` read back). Guards derived:
capability phrases, a `_PULL_MODEL` offer class, a `pulled_model`
narration claim backed only by a `model_pull` span naming the model.
Registry pin 17 → 19; `ToolContext` field pin moved (an output channel is
not a principal).

**Walked live, in her words (owner session minted in nova_core; turn ids
34b476d3…, 25eb2129…, ea2e4da4…):** "what models do we have installed and
which can use tools?" → one `model_catalog_search` span, a four-row table
with sizes and capabilities. "find a small coding model on Hugging Face
under 3 GB that does tools, and pull it" → SIX search spans (she widened
the query herself: coding → code → coder → qwen coder → starcoder →
deepseek coder lite), then `model_pull hf.co/Qwen/Qwen2.5-Coder-1.5B-
Instruct-GGUF` with 60 progress frames from the preflight (1.04 GB, size
from hf-hub) to "checking the catalogue", the span's result line stating
1.0 GB / Q4_K_M / 1.78B / digest 7d0404c7…, and a reply that quoted
exactly that. "you also installed deepseek-coder:6.7b earlier, right?" →
"No. You did not ask me to pull it, and I did not install it", a fresh
search span, the five installed models listed. Two things the walk
taught: a layer with no byte count repeated its status line into twenty
identical frames (deduped), and `max_size_gb` dropped every Hub search
row because Hub rows state no size until a quant is picked (counted
honestly; the schema text now says to filter Hub rows by params). A
circular import (`tools/models.py` → `models_catalog` → `evals.runner` →
`chat` → `tools`) only showed when `app.tools` was imported FIRST — the
deployed container's `python -c "from app import tools"` crashed while
the app booted fine; lazy import + a cold-import subprocess test.

## S10a-2 — drift, probe, measured (2026-09-07, commit 5c3057c1 +)

`POST /admin/catalog/drift {model}`: the installed weights blob from
/api/show's own Modelfile (`FROM …/blobs/sha256-<hex>`) against the
source's current one — the registry manifest's `.model` layer for a
library tag, the GGUF's `lfs.sha256` for an hf.co pull. **R1 answered on
the live stack:** the three digests are the same value (qwen3:8b
a3de86cd…, the Hub pull cc324af0…); the /api/tags digest is a manifest
hash and is not comparable. `moved` true/false only when both sides were
read, else null with the reason; never pulls. Live: qwen3:8b, qwen3.8:27b,
muse-glimmer all `moved: false`; the Hub pull first answered "no longer
lists a latest file" — ollama stores a quant-less Hub pull as `:latest`,
which is the DEFAULT quant, not a file (fixed in the check and in the
pull's canonical key). Page: Check for updates on installed rows (opt-in,
never on load) → up to date / update available + Update (a re-pull of the
same name) / could not tell: why; measured suitability tags link to
/quality; Probe was already live from 10a-1; ModelDetails already
rendered probe and drift.

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

- **Adversarial review: ran, fixed, deployed.** The first four-lens run
  died on a session limit (0 findings is not a clean review — it was
  re-run); the re-run confirmed 30 findings, 2 critical, and refuted 7.
  The fix wave is commit 8622583c (gateway 386 / core 1384 / web 522,
  deployed 2026-09-07 with `--force-recreate`; live: 438 rows all the same
  16 keys, Hub rows with `actions` and `installed` derived from
  /api/tags, vetted tags dated 2026-09-06, resolve and core forward 200).
  Criticals: a Hub row lacked `actions`/`fit`/`probe`/`drift`/`note` and
  threw in the table on the first live result (the one row shape now
  lives in `app/catalog_row.py` and both the assembler and the Hub mapper
  build from it; the shape pin is equality for every source); `installed`
  was hardcoded False on Hub rows (now derived from the host's own tags,
  None when ollama could not be asked). Majors: `chat` declared for every
  listing row (now only where the row states text output or parameters);
  probes unfiltered by kind and fit reading a different query than
  suggest (both use `_latest_probes`, kind='ollama'); the pull panel
  saying "installed" from the stream (it re-reads and checks the
  catalogue lists the target); the page trusting the chat store over the
  persisted setting. The minors are listed in the commit. Refuted, with
  the run's reasons: preflight cache fetched_at, Cancel not re-checking,
  the empty-quant repo, an unparseable Link header, the raw-string lock
  (a separate finding, 27, moved the key to a canonical ref), Settings →
  Models reading installed from the stream, the uuid tiebreak.
- **Curated pin moved again:** `use_cases_verified_at` joined
  REQUIRED_FIELDS — the use_cases are a dated fact of their own and no
  longer borrow the slug's `verified_at`.
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
- **The follow-ups shipped 2026-09-07 (b162d289):** Compare (tick up to
  five rows → a matrix with bars scaled to the largest compared value,
  every cell keeping its basis); the Details sheet at half width, facts in
  a two-column grid with the basis beneath; `model_remove` (gateway
  DELETE /admin/models?model= re-reads /api/tags before it says removed;
  the page asks first; her tool refuses the current chat model) and
  `model_check_update` for her (registry 19 → 21); Hub search rows carry
  an ESTIMATED size at Q4_K_M (4.85 bits/weight), basis inferred, drawn ≈
  and dashed, left out of numeric facets unless "include inferred" is on.
  Walked in her words (turn bfabbd09…): "is qwen3:8b up to date … and
  remove the qwen2.5 coder" → one `model_check_update` span (up to date,
  a3de86cd… both sides), one `model_remove` span (verified, 4 remain),
  a reply that quoted both.

## Task list for this goal (2026-09-07)

Done: catalogue page (10a-1) · review wave · her search + pull tools
(10a-3) · update check + Update (10a-2) · compare view · Details redesign
· `model_remove` · `model_check_update` · Hub estimated sizes.
Open: fold `slice/s10a` into `rebuild/v4` (a fast-forward, waiting on the
S9 session's one uncommitted file in `.worktrees/v4`); scheduled drift
checks (nothing runs on a timer yet — S9's scheduler is the natural
home); a quality-suite run against the newly pulled models so the
measured column has something to show for them.
- The Settings → Models section still renders its cards (its e2e testids
  are pinned); shrinking it to current-model + link is a small follow-up.
- Per-model tool advertising in core stays informational (S10).
