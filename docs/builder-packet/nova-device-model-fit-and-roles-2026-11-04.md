# Device model-fit, recommendations, and pairing roles (2026-11-04)

Owner direction (Jeremy): Nova should recommend local LLMs from a
device's actual hardware — during onboarding, in Settings, and when
a new device is set up — with a dynamic fit visualisation per
device (reference: his RTX 3090 VRAM-budgeter example: stacked bar
of weights + KV cache + overhead against the memory budget, quant
and context controls, combinations of several models summed).

## Pairing roles — already decided (2026-10-31, M10 ADR), confirmed
At pairing the owner declares what a device is FOR, as multi-select
capabilities: thin client, compute (inference/model serving),
storage, capture source, general server — plus hub CANDIDATE as a
separate flag (hub is elected; a device cannot self-appoint).
Shown/confirmed on the hub approval screen, stored on the device
record, editable later in Settings › Devices, and they bound what
Nova may deploy there. Inventory may SUGGEST roles (GPU → compute,
large disk → storage) but the owner confirms. New tie-in: declaring
compute (or Nova finding a GPU) is what surfaces the model-fit flow
below during setup.

## Hardware inventory (device agent reports, hub stores)
Per device: GPU model(s) + VRAM each; unified-memory flag (Apple
Silicon: total RAM, usable inference share); system RAM; CPU; free
disk; inference backends present (Ollama etc.); WoL-capable +
sleep state. Refreshed at pairing, on change, and periodically.
While a device sleeps, its last-seen inventory stays visible,
stamped with its age — planning must work against sleeping nodes.

## Fit engine — deterministic code, never an LLM's guess
For a model + quant + context length: weights bytes + KV-cache
estimate (from model metadata — layers/KV heads/head dim via the
backend's model info; family table when metadata is missing) +
runtime overhead + a safety reserve. Verdicts: Fits comfortably /
Tight / Won't fit, always labelled with the assumed quant and
context. Combinations: sum the selected models' footprints,
overhead counted once; multi-GPU sums only when the backend
actually splits a model across GPUs, otherwise the binding
constraint is per-GPU. SELF-CORRECTION: after a real load, compare
predicted vs the backend's reported usage (e.g. Ollama /api/ps)
and record the device's real overhead for future estimates.
Fallback when inventory or metadata is unavailable: a static tier
table by memory band (6/8/12/16/24/32/48+ GB, discrete and unified)
with curated picks — clearly labelled as estimates.

## Recommendations — by task, not just by size
Per task class (general chat, coding, screening/decision —
Tev1-class, embeddings, vision, transcription): a recommended pick
for THIS device plus a smaller/faster alternative, each with its
fit verdict. Where Nova's eval scorecard has run a model, its
score informs the pick. Privacy mode first: local-only users get
local recommendations before any cloud option is mentioned.

## The per-device Models screen (the bar chart, productised)
Settings › Devices › [device] › Models, and the same component
inside device setup: a stacked bar of the device's memory budget —
loaded models, candidate models being planned, KV cache, overhead,
free headroom — with quant selector and context slider recomputing
live, add/remove candidates to plan a combination, over-budget
warnings, and one-tap "Install & assign" through the models
subsystem (no ollama commands shown to the user). A Settings ›
Models overview shows every device and where each task routes.

## Wake-on-LAN inference nodes
A compute device may be "wake on demand" (Jeremy's Dell is the
reference case: the always-on mini-PC hub wakes it when a task
needs heavy local inference). While asleep it shows as
Asleep — wakeable, with its catalog intact. On routing to it, an
always-on agent on its LAN (hub or boot agent) sends the WoL
packet, Nova waits for health, loads the model, runs. Per-device
sleep policy: never sleep, or sleep after N idle minutes.

## Build order (design-first, as always)
1. ADR: inventory schema + fit-engine contract + golden test
   cases (24 GB 3090, 8 GB card, 16/32 GB unified-memory Mac).
2. Inventory reporting + fit engine, test-first.
3. Per-device Models screen: styleguide composition for owner
   approval, then build; onboarding/device-setup hook.
4. WoL wake-on-demand routing (with the services track).
Slots after the Config Onboarding track — device setup lives
there. The spec/ADR (step 1) can be written immediately.
