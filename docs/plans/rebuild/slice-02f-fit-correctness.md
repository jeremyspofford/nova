# Slice 2f — Model fit & switch correctness

Parent: the Master Roadmap; trigger: owner S2e walk (2026-08-29) found
three real defects, two of them correctness bugs in the fit logic (one of
which reveals the S2e min_vram_gb "fix" was anchored to the wrong number).
Slice type: bugfix (corrects S2e). Size: M.

## Ground truth captured live (27B resident during the walk)
- /api/ps: qwen3.8:27b size_vram = 17.4 GB (this is WEIGHTS only).
- nvidia-smi: 22369 / 24576 MiB actually in use (weights + KV@32K +
  buffers ≈ 22 GB — the REAL footprint).
- /admin/suggest with the 27B resident: free_gb=7.8, so EVERY model ≥8 GB
  (incl. the 8B at 9.3 verified) reads `wont_fit`. Wrong.

## The three fixes

### A — the switch must visibly take effect (web)
Selecting an installed model in Settings→Models must immediately (a) mark
that model as current in the list, and (b) update the model shown in chat.
Today the PUT succeeds but the UI doesn't reflect it and the chat's pre-
first-turn badge stays stale (the known ChatPage carry). Fix: on a
successful switch, refetch/optimistically update the current-model state
that BOTH the Settings list and the chat badge read from, so the change is
visible without sending a message. (The server already uses the new model
per-turn — this is purely feedback.)

### B — eviction-aware fit (gateway) — the "8B won't fit" bug
A local model switch EVICTS the currently-resident model (ollama unloads
on load of another). So the fit question "can I switch to model X" must be
judged against VRAM available AFTER evicting swappable resident models —
effectively (total − fixed non-model overhead), NOT instantaneous free.
Implement: free-for-a-switch = total − (VRAM held by things that will NOT
be evicted). In this single-engine ollama world, the resident chat model
IS evicted on switch, so it should be added back to "available". Result:
the 8B reads `comfortable` even while the 27B is resident; a model that
exceeds the whole card still reads `wont_fit`. Keep an honest note if
some VRAM is genuinely non-reclaimable. Do NOT silently use total and
ignore real overhead — model the eviction explicitly.

### C — "needed" is TOTAL footprint, not weights (gateway) — the 17-vs-22 bug
The fit "needed_gb" must be the TOTAL VRAM footprint (weights + KV cache
at the configured context + compute buffers), which is what actually has
to fit — NOT ollama's size_vram (weights only). Consequences:
- Re-anchor qwen3.8:27b's estimate from 17 to its REAL footprint (~22 GB
  at 32K ctx) → verdict `tight` (honest; reverses the S2e over-correction
  which used size_vram=16.6). Set the other curated estimates to
  total-footprint figures too where known, else keep conservative.
- The PROBE must measure TOTAL VRAM (nvidia-smi used-delta around the
  load, or the ollama process RSS-in-VRAM), NOT /api/ps size_vram, so a
  "verified" number reflects real footprint. (This also addresses the
  S2e probe-timeout carry incidentally — give the probe a load window
  long enough for a cold large model, or warm-then-measure.)
- Footprint depends on context length (KV scales with ctx). For this
  slice, use the footprint at the configured/default context and STATE
  that assumption; a full ctx-aware KV model is a later carry.

## DoD (operator-visible, real stack)
1. In Settings→Models, click a different installed model → it's marked
   current immediately AND the chat shows that model, no message needed.
2. With the 27B resident, the 8B (and other card-fitting models) read
   `comfortable`/`tight` (eviction-aware), NOT `wont_fit`; only genuinely-
   too-big models read `wont_fit`.
3. The 27B's shown VRAM matches what nvidia-smi/the owner sees (~22 GB,
   `tight`), not 17 GB — the number nova states equals the number the GPU
   uses (within the stated context assumption).
4. A probe of the 27B records its REAL ~22 GB total footprint and badges
   `verified` (and no longer times out on a cold load).

## Rails
No fake numbers — the stated VRAM must equal real usage (this whole slice
exists because it didn't); eviction modeled explicitly, not hidden behind
"use total"; probe measures total footprint; comments self-contained;
real-stack testing; commits on rebuild/v4, never pushed.

## Process
One implementer (all three parts — they're one surface), review, fix
rounds, rebuild, owner walk. Carries → fold into slice-02e-carries.md.
