---
title: "API key changes apply live — no more restarts"
date: 2026-07-10
---

- **Provider keys hot-reload** — saving or removing an API key in Settings → AI & Models → Provider Status now applies to the running gateway within about a second. The "restart required" banner is gone, replaced by live-apply confirmation; provider availability dots flip on their own
- **Revocation is live too** — removing a key drops the provider out of the failover chains immediately (unless a `.env` fallback value exists)
- **Fixed: dashboard-added keys missing from failover** — previously a key that existed only in the encrypted secrets store (never in `.env`) worked for explicit model requests but silently never joined the automatic fallback chains, even after a restart
- **Faster recovery from a bad key** — rotating a rejected key clears its 10-minute credential cooldown on the spot, so the fixed key is retried immediately
- **NVIDIA NIM key manageable from the UI** — added to the Provider Status key editor alongside the other providers
