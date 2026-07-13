---
title: "Local inference becomes a pool — run several backends at once"
date: 2026-07-12
---

- **Named backend pool** — local inference is no longer one active backend. The gateway now routes over a pool of named entries (bundled containers plus user-named remotes like `remote-vllm-a`, `remote-vllm-b`), each with its own URL, optional auth header, and discovered model catalog. Manage it on the Models page's new *Backend pool* card
- **Model-aware routing** — a request goes to the backend that actually serves the requested model (`:latest` aliasing included); anything unresolvable falls back to the first enabled entry with model substitution, so local-first keeps always answering
- **Two of the same engine, no confusion** — entries are user-named, so two vLLM boxes are distinguishable, independently health-checked, and independently enable/disable-able
- **Zero-step upgrade** — the pool seeds itself from the previous single-backend settings on first boot; bundled container start/stop and the Settings backend selector now write pool entries under the hood
- **First slice of the models/inference unified plan** — role → (provider, model) fallback chains drawn from this pool come next
