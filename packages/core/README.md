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

M5 (decisions in `docs/20` ADR-092):

- Runtime seams (`src/runtime/types.ts`) — the interfaces that keep one runtime (ADR-076):
  `TurnStarter` (implemented by `ChatService.turnStarter`: start a labelled turn with its trigger,
  run, goal and authority, or cancel one), `TurnExtension` (a mode's context blocks, bounds checked
  before every model step, usage after each step and `onEnd`; added with `extensions` or
  `ChatService.useExtension`), `RunStarter`, `ThreadPolicySource`, `Reviewer` and the request
  broker. `ToolListScope {threadId, mode}` (`src/tools/types.ts`) lets a tool source list tools per
  thread. `ChatService.awaitingUser(threadId, waiting)` leaves a wait for the user out of a turn's
  active time.
- Runs (`src/runs/`) — `RunService`, the supervisor of Work runs (FR-051..FR-054, FR-181,
  FR-182, FR-186, FR-187, FR-220): runs, plans (`run_step`), goals with the 3-turn blocked rule
  and idle continuation, sub-agents (depth 1, a queue behind the concurrency limit), budgets
  checked through its `TurnExtension`, pauses and resume, `recover()` after a restart, chat
  escalation (`work.start`), the deep research template, verified outcomes, the run tools
  (`tools.ts`), prompts (`prompts.ts`), views and the activity merge (`activity.ts`). Its `policy`
  maps autonomy to an approval policy for the gate.
- Scheduler (`src/scheduler/`) — `ScheduleService` (FR-055, FR-187, ADR-079): cron, RRULE and
  interval rules evaluated in a time zone through `Intl` (`zone.ts`, `cron.ts`, `rrule.ts`,
  `recurrence.ts`), the fire loop with catch-up, skips and no overlap, history in
  `schedule_fire`, delivery in-app, as an OS notification or to a signed webhook with a
  private-address guard (`delivery.ts`), and the `schedule.report` tool (`report.ts`). It starts
  runs through a `RunStarter`.
- Code (`src/code/`) — `CodeService` (FR-061..FR-066, FR-069, FR-073, FR-074, FR-211): sessions
  and the local environment, permission modes as a `ThreadPolicySource` (`policy.ts`), hook-free
  Git (`git.ts`), change capture in a per-session shadow repository (`shadow.ts`, `changes.ts`),
  diff parsing and hunk patches (`diff.ts`), comments, reviews (`review.ts`), commits on `nova/`
  branches with staging of accepted content only (`commit.ts`), worktrees (`worktrees.ts`), the
  pattern-based symbol index (`symbols.ts`), session terminals and the Code tools (`tools.ts`).
- Requests (`src/requests/`) — `RequestService` (FR-188): server-to-client requests with per-kind
  validation (`validate.ts`), first answer wins, delivery by kind and device, re-send on reconnect,
  notification fallback and restart recovery; pending approvals listed as requests;
  `userAskTool` (`ask_user`); and `ThreadStatusService` (`status.ts`, FR-215), which derives
  needs input, blocked, running or ready for threads, runs and sessions and emits
  `thread.status.changed`.
- Auto-review (`src/approvals/reviewer.ts`, `reviewer-breaker.ts`) — `ModelReviewer` (FR-085,
  ADR-061): one model call with no tools, a JSON-schema verdict, 90 s per attempt, 3 attempts,
  fail closed; prompt version `auto-review-1`. `ReviewBreaker` trips at 3 denials in a row or 10
  in the last 50. The gate (`gate.ts`) gains `useThreadPolicy`, `useReviewer` and
  `resetReviewBreaker`.
- Context (`src/context/`, re-exported from `chat.ts`) — compaction (FR-183: pre-turn, mid-turn,
  post-turn and `context.fresh`, stored as a `summary` message with a `compaction` part, with an
  extractive summary offline), instruction-file discovery (FR-185, `instructions.ts`), the
  context-tool tracker and `context.remaining` / `context.fresh` (`tools.ts`).
- Exec sessions (`src/tools/exec-sessions.ts`) — `ExecSessions` (FR-184): wraps the sandbox for
  `exec.run`, `exec.poll` and `exec.write`, at most 8 sessions per thread, kills a thread's
  sessions on cancel or when its run ends, and backs `GET`/`DELETE /exec/sessions`.
- Documents (`src/documents/`, `src/tools/documents.ts`) — writers and readers for DOCX, PPTX,
  XLSX and PDF built on the zip library and plain XML (FR-219), with zip, deflate and XML limits;
  `documentTools` (`document.create`, `document.read`) and `artifactDocumentPreview` for the
  Hub-side preview. Nothing in it imports the network.
- Images (`src/tools/images.ts`) — `imageToolSource` and `providerImageGenerator` (FR-030):
  `image.generate` is listed only while a provider adapter can make images; none can yet.
- Plugin drafts (`src/plugins/authoring.ts`) — `pluginScaffoldTool` (`plugin.scaffold`, FR-050):
  writes a draft under `<dataDir>/plugins-drafts/` and checks it with the installer's loader;
  never installs.
- Memory consolidation (`src/consolidation.ts`) reads only the messages the user typed into a
  conversation, plus Nova's replies.
