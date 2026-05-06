---
title: "Platform secrets — provider keys + bridge tokens move out of writable .env"
date: 2026-05-05
---

The `platform_secrets` store introduced for the Capability Platform now backs **all** sensitive runtime config — provider API keys, chat-bridge tokens, OAuth client secrets — not just user-granted GitHub PATs.

- **LLM gateway** boots with provider keys read from `platform_secrets` (DB-backed, encrypted at rest) instead of `.env`. The dashboard's Provider Status panel writes/rotates keys via the admin API; nothing edits `.env` at runtime.
- **chat-bridge** boots with Telegram and Slack tokens read from `platform_secrets`. The bridge service no longer needs raw tokens in any process environment after the secrets land in the DB.
- **Recovery service** rejects writes to secret-bearing keys via its `/env` editor — operators are nudged toward the proper Settings UI flow rather than `.env` poking.
- **Worker services** (intel-worker, knowledge-worker) use a shared `PlatformSecretsResolver` to fetch their dependencies (HuggingFace tokens, RSS feed creds, etc.) at startup with the same encryption + audit guarantees.
- **Recovery's Docker SDK gated behind socket-proxy** (SEC-006b). Recovery no longer has direct access to `/var/run/docker.sock`; it talks to a tightly-scoped socket-proxy that allows only the operations recovery actually needs (compose up/down, container inspect for health). Reduces blast radius if recovery's API is ever compromised.

Migration is automatic on first restart: the orchestrator's startup handler reads any secret-bearing keys still in `.env`, writes them into `platform_secrets`, and logs a one-time notice. Subsequent restarts read from `platform_secrets` only. To rotate, use the dashboard or the admin API — direct `.env` edits to provider keys won't take effect until a `platform_secrets` upsert runs.
