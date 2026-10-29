# LOCAL MODELS

Local inference is a defining capability, not an advanced setting. Setup includes it; it is not a plugin the user must discover.

## Model manager (core service)
- **Hardware detection** per device: CPU, RAM, GPU/VRAM, disk; a mesh-wide capability map (which device can serve what).
- **Recommendation**: given the map and the user's privacy defaults, recommend a small set (fast small model for triage-adjacent text work, a main local reasoner, embedding model, transcription model) with plain-language trade-offs.
- **Download and lifecycle**: managed downloads with integrity checks, versioning, disk budgets, and removal. Models are data with versions — updates flow through the same governed pipeline discipline.
- **Serving**: runtimes are adapters (Ollama first; others pluggable). The manager exposes one internal inference API; callers name a *role* (triage-text, reasoner, embedder, transcriber), never a binary.
- **GPU spoke**: a paired desktop with a GPU can be woken (Wake-on-LAN) to serve larger models, then allowed to sleep. Scheduling considers wake latency honestly — small jobs stay on the hub.

## Decision Model Provider — local story
The Decision Model Provider interface (ADR-7) has two implementations at ship time: the hosted Jev adapter, and a local implementation (small local classifier model and/or rules). In local-only mode only the local implementation runs. Both return the same typed shapes, so the rest of the system cannot tell them apart — except in receipts, where the provider is always named.

## Fallback semantics (worked examples)
- Local reasoner down, task is local-preferred → cloud model serves; receipt discloses; health system works the local fault in parallel.
- Cloud unreachable, task cloud-allowed → local reasoner serves at possibly lower depth; Nova says so if the difference matters.
- Local-only task, local reasoner down → task queues with an honest status ("waiting on local capacity"), user notified per proactivity policy. **Never** silently served by cloud.

## Budgets
Cloud spend is a policy: per-task and per-period budgets in the profile, tracked in the ledger with usage from every report (CONTRACTS §1). Local inference is the default answer to "how do we keep this affordable at scale."
