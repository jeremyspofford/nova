# @nova/core

Domain services for the Hub, independent of HTTP (`docs/05`, `docs/09` §2).

- `ProviderRegistry` — provider accounts (FR-014, FR-101): the API key goes to a `SecretStore`
  and the database keeps only its `secret://` reference; builds adapters (mock, OpenAI,
  Anthropic, OpenRouter, Ollama, llama.cpp, generic OpenAI-compatible), tests connections and
  lists models across accounts with a short cache. `ensureDefaultProvider` adds the offline mock
  account the first time an account has none.
- `Router` (`src/routing/`) — the one place a model reference becomes targets (FR-023, FR-127,
  FR-221; `docs/07` §8-§9): account models, compute-node models (`ModelSource`) and presets
  (built-in Faster / Balanced / Smarter until the user saves their own), ordered by
  `routing.order`, filtered by `routing.allowCloud` and vision needs, with retries, fallback
  before the first output only, and a circuit breaker per account or node. `DirectRouter` is
  the minimal single-target router used in tests. `detectLocalServers` probes for local model
  servers.
- `NodeService`, `NodeModelSource`, `NodeProvider` (`src/nodes/`) — compute nodes (FR-126):
  one-use enrollment tokens, signed capability documents verified against a pinned Ed25519 key,
  hashed node credentials, heartbeats and the unreachable sweep, revocation, and node models as
  router targets that stream through the node's job API.
- `ThreadService` — create, list, rename, pin, archive, soft-delete, branch, side chats, the
  message tree (versions and the active path), the lineage tree and ranked FTS5 search, never
  returning temporary, side or deleted threads in lists or search (FR-017, FR-020, FR-025,
  FR-026, FR-027, FR-033).
- `ChatService` — turns (FR-018, FR-019): records the turn and messages, streams in the
  background through the router, publishes `chat.delta` (ephemeral, ≤ 60/s) and persisted
  `turn.*` / `chat.message.*` / `chat.followup.*` events, saves partial text at most every
  250 ms, and keeps partial text on cancel, provider error or crash (`recoverOnStartup`).
  Follow-ups steer the running turn (one more model step) or queue as the next turn, surviving a
  restart. Edit and regenerate add sibling versions. Temporary chats are purged on delete and
  by `sweepTemporary` after their TTL. Context is one system message: prompt, memory, project
  instructions, source excerpts. Attachments (FR-021) are stored by SHA-256 under
  `<dataDir>/blobs/attachments/`.
- `ProjectService`, `SourceService` — projects with instructions and a fixed memory scope
  (FR-034, FR-205), and sources indexed in the background into FTS5 chunks, retrieved for
  project chats and stored as citations (FR-040).
- `MemoryService` — reviewable memory items (FR-032): explicit statements saved at once,
  model-extracted facts for real providers, redaction, dedupe by normalized content, scopes
  (global, project), the "What you know about the user" context section, and import.
