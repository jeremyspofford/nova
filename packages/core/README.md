# @nova/core

Domain services for the Hub, independent of HTTP (`docs/05`, `docs/09` §2).

- `ProviderRegistry` — provider accounts (FR-014, FR-101): the API key goes to a `SecretStore`
  and the database keeps only its `secret://` reference; builds adapters (mock or
  OpenAI-compatible), tests connections, lists models across accounts with a short cache, and
  resolves `<providerAccountId>/<modelId>` refs. `ensureDefaultProvider` adds the offline mock
  account the first time an account has none.
- `ThreadService` — create, list (pinned first, then most recent; keyset cursor), rename, pin,
  archive, soft-delete and FTS5 search over message text, never returning temporary or deleted
  threads (FR-017, FR-027). User input is always treated as plain text by the search.
- `ChatService` — one chat turn per send (FR-018): records the turn and both messages, streams
  in the background, publishes `chat.delta` (ephemeral, ≤ 60/s) and persisted
  `turn.*` / `chat.message.*` events through an injected `EventSink`, saves partial text at most
  every 250 ms, and on cancel, provider error or crash (`recoverOnStartup`) keeps the partial
  text marked `incomplete` or `error`. Attachments (FR-021) are validated, stored by SHA-256
  under `<dataDir>/blobs/attachments/`, and given to the model as text, images (vision models)
  or a short note.
