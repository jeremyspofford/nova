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
- Tools (`src/tools/`) — the tool runtime (FR-099, FR-196, docs/08 §1): the registry of built-ins
  and MCP tools with deferral and `tool.search`; file tools with the Nova patch format; exec tools
  in a container sandbox (or failing closed); `web.search`, `web.fetch`; artifacts; mentions.
  Every call is validated, passes the policy gate, is persisted, audited by input hash and given
  back to the model as untrusted data.
- Approvals (`src/approvals/`) — the policy store and the gate (FR-048, FR-100, FR-189, FR-190):
  rules, command rules, grants, tool defaults, permission profiles and roots, approvals with
  every decision, timeouts and cancellation, previews.
- Ops (`src/ops/`) — the hash-chained audit log, notifications, activity, diagnostics and the
  data key that seals blobs at rest (FR-013, FR-104 partial, FR-118, FR-149 baseline).
- `ConsolidationService`, history (`src/consolidation.ts`, `src/history.ts`) — memory
  consolidation with summaries, topics and aging, and past-chat reference (FR-204, FR-205).

M4 (decisions in `docs/20` ADR-091):

- Extension seams (`src/extensions/`) — the interfaces between areas: `SkillCatalogProvider`,
  `PluginPermissionSource` and the hook dispatcher (`HookInput`, `HookOutcome`, `noHooks`).
- Plugins (`src/plugins/`) — `PluginService`, the plugin installer (FR-045): preview without side effects (held 30
  minutes with a digest of the folder), install only with the sideload confirmation, atomic
  update with rollback, enable, disable, uninstall, into `<dataDir>/plugins/<id>/<version>/`. It
  converts commands to skills, registers sub-agent roles and MCP servers (secret values moved to
  the vault, `NODE_PATH` for Node servers) and hands hooks to the hooks area. `forTool` gives the
  gate a plugin's confirmed permissions. `PluginCatalogs` (`catalog.ts`): folders, https URLs and shallow
  Git clones. `SkillIndex` (`skills.ts`, FR-046): skills found on disk under their roots
  (managed, project, user, plugin, built-in) with precedence and shadowing, the context catalog,
  `/name` and `@name`, the `skill.load` tool and slash commands; a small front-matter parser with
  no dependency.
- Hooks (`src/hooks/`) — `HookService` and `HookStore` (FR-197): discovery from managed policy,
  `<dataDir>/hooks.json`, project folders and plugins, re-read and re-hashed on every dispatch;
  trust records by content hash with `changedSinceTrust`; `command` handlers in the sandbox and
  `mcp_tool` handlers through the gate; parallel runs where a block or deny wins; fail closed for
  `tool.pre` and `permission.request`; context spill over 2,500 tokens; events and audit.
- The loop (`chat.ts`, `tools/runtime.ts`, `approvals/gate.ts`) — hooks at every event: a
  `prompt.submit` block fails the turn, `tool.pre` runs before the gate, a `stop` continuation is a
  new turn with trigger `hook` (actor `system`, provenance `hook`, no user authority). The gate
  takes hook answers only for `answerable` asks and applies plugin permissions; a direct action
  by the signed-in user in a Nova client is allowed without a card (`user_action`). Skills join
  the context; app model context is added as untrusted content. `SuggestionService` writes up to
  three follow-up prompts per turn (FR-028), with a heuristic for the Mock provider.
- Workspace (`src/workspace/`) — `FileService` (FR-039): browse, read and save inside the
  thread's roots, with base-hash conflicts and the save passing the gate as `fs.write` from the
  UI; `TerminalManager` (FR-006): shells in the sandbox container through a small pty relay with
  live resize, at most 4 per account, scrollback for reconnects; `LibraryService` (FR-041);
  `ProjectFolderService` (FR-035): bind folders and index their files into the project's
  sources; `listProjectFolderRoots`, shared by the gate, the tools and the file browser.
- Profile (`src/profile/`) — `ProfileService`: the account profile and avatar with metadata
  stripped (FR-113); `UsageService`: usage insights by UTC day, model and project, with the
  streak and the longest task (FR-114); `ImportService` (`import/`, FR-200): a read-only scan of
  folders on the Hub, secrets moved to the vault and replaced by references, and apply with one
  `import_record` per item. The active account per provider kind (FR-115, `provider_active`) is
  kept by `ProviderRegistry`: it is listed first for its kind and alone serves the models it
  shares with other accounts of that kind.

