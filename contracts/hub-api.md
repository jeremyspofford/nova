# Hub API (Client ↔ Hub, Hub ↔ Node, Hub ↔ novad)

The Hub is the only canonical service. Everything speaks to it. This file summarizes the
boundaries; the generated OpenAPI document (from the shared Zod schemas) is authoritative.
The shape stays REST plus WebSocket/SSE (ADR-072), with server-to-client requests over the
stream (§5) and a capability handshake (§7).

## 1. Client ↔ Hub

Transport: HTTPS (REST) plus WebSocket/SSE for streams. Authentication: device certificate
+ scoped bearer token issued at Add Device. All requests are authorized by the policy engine.
Every listener requires a token or certificate; loopback is never treated as authorization
(FR-192, ADR-075). The only exceptions authenticate another way and say so below: Add Device
(pairing code), the MCP event webhook (signature), the `novad` download route (static,
signed artifacts only), the MCP OAuth callback (single-use state), Nova's OAuth client
metadata document (public, no account data) and `/mcp` (a client token of its own).

### Handshake

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/hello` | Capability handshake: client declares capabilities; Hub returns versions and features (§7) |

### Auth & devices

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/devices/add/start` | Create an Add Device request; returns QR payload + short code + TTL (direct or via Relay). M2: `{role: "compute"}` returns a one-use enrollment token `{token: "nve_…", expiresAt}` (15 min) that a compute node presents to `/node/v1/register`; creating it is the human approval for that node (ADR-089). Other roles arrive in M6 |
| `POST` | `/api/v1/devices/add/complete` | Device submits public key + code (authenticated by the code); Hub returns a pending approval |
| `POST` | `/api/v1/devices/add/approve` | Hub-side human approves; issues device cert + scoped token |
| `GET` | `/api/v1/agent/dist/:file` | Signed per-arch `novad` binaries and checksums for the bootstrap command (`docs/22` §4.3); serves nothing else |
| `GET` | `/api/v1/devices` | List devices with role, scopes, health, reachability, `novad` version. `?role=compute` lists compute nodes as `NodeView` (M2 lists only compute nodes) |
| `PATCH` | `/api/v1/devices/:id` | Edit scopes/capabilities/overrides |
| `POST` | `/api/v1/devices/:id/wake` | Request WoL via a Wake Helper |
| `POST` | `/api/v1/devices/:id/revoke` | Revoke certificate, stop modules and stop relay routing |
| `GET` | `/api/v1/relay/clients` | Paired clients reachable through the Relay: device, relay client id, last seen (FR-137, ADR-071) |
| `POST` | `/api/v1/relay/clients/:id/revoke` | Revoke a paired client: drops its key and tells the Relay to stop routing it |

### Chat, projects, files

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/api/v1/projects` | List/create projects (`memoryScope: shared\|project_only`, fixed at creation, FR-205) |
| `GET/PATCH/DELETE` | `/api/v1/projects/:id` | Project / rename, instructions (FR-034) / soft delete; its chats stay, detached |
| `GET/POST` | `/api/v1/projects/:id/sources` | List / add a source (file as base64 or pasted text); indexing runs in the background, `pending → indexing → ready\|error`, with `source.status.changed` events (FR-040). M2 indexes text types only |
| `POST` | `/api/v1/sources/:id/reindex` | Index again |
| `DELETE` | `/api/v1/sources/:id` | Remove; its chunks leave retrieval at once |
| `GET/POST` | `/api/v1/projects/:id/folders` | Local project folders as `ProjectFolderView` / bind one `{path, access: read\|write}` (201) (FR-035). The path is resolved to its real path (`~` is the Hub user's home). `policy_denied` `{reason: protected_folder}` for the filesystem root, the home folder or a folder containing it, the Hub data folder (inside, equal or containing) and credential locations; `validation` for a relative or missing path, a file, or a 21st folder (`{reason: too_many_folders}`); `conflict` for the same folder twice. Indexing runs in the background (`project.folder.indexed`): each text file becomes a source whose bytes stay in the folder. Symlinks are not followed; version-control, dependency and build folders, top-level `.gitignore` patterns, protected paths, binaries and files over 20 MB are skipped; at most 5,000 files. A bound folder is also a tool root for the project's chats, with `access` capped by the permission profile (FR-190) |
| `POST` | `/api/v1/projects/:id/folders/:fid/reindex` | Index the folder again; returns it |
| `DELETE` | `/api/v1/projects/:id/folders/:fid` | Unbind; its sources leave retrieval at once and the files on disk are untouched |
| `GET/POST` | `/api/v1/threads` | List (`mode`, `archived`, `q`, `projectId`, `cursor`, `limit`; pinned first, then most recent; side chats excluded) / create conversations (`temporary`, `memoryOptOut`, `projectId`). Shapes: `packages/shared/src/api.ts` |
| `GET/PATCH/DELETE` | `/api/v1/threads/:id` | Thread with its active path, version info, citations and follow-up queue / rename, pin, archive, model, reasoning level, memory opt-out, project / soft delete; a temporary thread is purged (FR-027) |
| `POST` | `/api/v1/threads/:id/messages` | Send a message: 202 `{disposition, turnId, userMessageId, assistantMessageId, queuePosition?}`; output arrives as events (§5). Body up to 30 MB with attachments, else 413. While a turn runs, `inputMode` (or the `general.followUp` setting) decides (FR-019): `steered` joins the running turn and is applied at the start of its next model step; `queued` is persisted and runs as the next turn, surviving a restart; its id becomes the `userMessageId` of the message it creates |
| `GET` | `/api/v1/threads/:id/queue` | Queued follow-ups, oldest first |
| `DELETE` | `/api/v1/threads/:id/queue/:queuedId` | Cancel a queued follow-up |
| `POST` | `/api/v1/threads/:id/messages/:mid/edit` | Edit a user message as a new sibling version and run it; prior turns are kept (FR-020) |
| `POST` | `/api/v1/threads/:id/messages/:mid/regenerate` | Add a sibling reply to the same user message (FR-020) |
| `POST` | `/api/v1/threads/:id/active` | Switch the active path to the one through `{messageId}` (the thread's own messages only); returns the thread detail; `conflict` while a turn runs |
| `DELETE` | `/api/v1/threads/:id/messages/:mid` | Soft-delete a message (a user message takes its reply with it); excluded from view, context and search |
| `POST` | `/api/v1/threads/:id/branch` | Branch from `{fromMessageId}` into a new thread that inherits the path by reference (FR-020, FR-033) |
| `GET` | `/api/v1/threads/:id/tree` | The lineage tree: root, branches and side chats (FR-033) |
| `POST` | `/api/v1/threads/:id/side` | Side chat `{text, model?}`: a child thread that reads the parent's context and adds no turns to it (FR-026) |
| `GET` | `/api/v1/threads/:id/turns` | Turns with their items (`docs/06` §2), paged |
| `GET` | `/api/v1/threads/:id/stream` | SSE stream of this thread's events and server requests (§5). Opens with a `: connected` comment. With `Last-Event-ID` or `?after=` it first replays persisted events after that id (ids compare as UUIDv7, so an ephemeral id works); without a cursor it sends live events only, so clients load the thread first and refetch on `chat.message.completed` |
| `POST` | `/api/v1/threads/:id/cancel` | Cancel generation; the turn ends `interrupted` |
| `GET` | `/api/v1/threads/:id/suggestions` | Up to three follow-up prompts `{items: string[]}` after the last completed turn (FR-028), generated once per turn by the turn's model (a heuristic with the mock provider or when the model fails); empty when `chat.suggestions` is off, for a temporary chat, and while a turn runs or waits |
| `POST` | `/api/v1/threads/:id/handoff` | Move a chat to another device or environment (FR-213) |
| `GET/POST` | `/api/v1/files` | List/upload files (projects, artifacts, window-capture attachments, FR-214) |
| `GET` | `/api/v1/search?q=` | Search message text (`projectId?`), ranked by relevance (FTS5 bm25, recency breaks ties); snippets mark matches with `<mark>…</mark>` and are otherwise plain text; temporary, side and deleted threads and deleted messages excluded (FR-025). Vector ranking joins when local embeddings land |
| `GET` | `/api/v1/attachments/:id` | Attachment bytes with their type; `Content-Disposition: attachment` except images |

### Workspace: files, terminals, library

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/files/roots?threadId=&projectId=` | Folders the file browser may open (FR-039): exactly the roots the thread's tools get, the project's folders included; `{items: [{path, label, access: read\|write}]}` |
| `GET` | `/api/v1/files/list?root=&path=` | A folder's entries as `FileEntryView` (at most 5,000). A path outside the roots or a protected path is `policy_denied` `{reason: path_denied}`; symlinks are listed only when they point inside the roots; the Hub data folder is hidden |
| `GET` | `/api/v1/files/content?root=&path=` | `FileContentView`: `text` for text files up to 5 MB (else `null`; fetch `/files/raw`), `sha256` to pass back on save, `readOnly` |
| `PUT` | `/api/v1/files/content` | Save `{root, path, text, baseSha256}` (text ≤ 5 MB; `baseSha256: null` creates a file); returns `FileContentView`. The save passes the policy gate as `fs.write` with origin `ui` and the user's own instruction, so it is allowed without a card unless a rule or a confirm-every-time step asks; then the answer is 202 `{approvalId}` and the save runs once it is approved. A file that changed, appeared or was deleted since it was read is `conflict` `{reason: changed\|exists\|deleted, sha256}` (the current hash; files over 256 MB are versioned by size and modification time). A denied or timed-out approval is `policy_denied` `{reason: denied\|timeout, approvalId?}`. The file mode is kept; audited as `fs` / `fs.write` |
| `GET` | `/api/v1/files/raw?root=&path=` | The file's bytes, inert: `Content-Security-Policy: default-src 'none'; img-src data:; sandbox`, `nosniff`, `Content-Disposition: inline` |
| `GET/POST` | `/api/v1/terminals` | This account's terminals as `TerminalView` / open one `{root?, threadId?, cols, rows}` (201) in the sandbox, with the thread's roots and permission profile (FR-006); `root` defaults to the first root. Without a sandbox: 409 `sandbox_unavailable`. At most 4 running per account (`conflict` `{reason: too_many_terminals}`). Terminals live in Hub memory only: one that no client has watched for 15 minutes is closed, and the last 256K characters of output are replayed to a viewer that reconnects. Commands typed in a terminal are confined by the sandbox and the profile, not checked one by one. Audited as `terminal.open` and `terminal.close` |
| `DELETE` | `/api/v1/terminals/:id` | Close it (`terminal.exited` with `code: null`) |
| `GET` (WebSocket) | `/api/v1/terminals/:id/ws` | The terminal's stream (frames in §5). The session is checked before the upgrade (401 `token_required`); an unknown terminal closes the socket with 4404, an invalid id with 4400 |
| `GET` | `/api/v1/library?kind=&q=&cursor=&limit=` | One paged list (FR-041), newest first, as `Page<LibraryItemView>`: `kind` is `artifact\|attachment\|source\|image\|file` (`file` = artifacts of kind `file`, `image` = image attachments) and `q` searches titles. Project-folder files, temporary chats and deleted chats are left out |

### Providers, models, account

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/api/v1/providers` | List / add provider accounts; each carries `active` (FR-115). `apiKey` is write-only: stored in the secret vault, never returned; the database holds only a `secret://` reference (FR-101) |
| `PATCH` | `/api/v1/providers/:id` | `{active: true}` (nothing else): make it the active account of its provider kind (FR-115); returns the account; `provider.account.activated`. Without a choice the oldest live account of a kind is active. Models the active account shares with another account of its kind are listed for it alone, so new chats and the built-in presets use it |
| `DELETE` | `/api/v1/providers/:id` | Remove an account and its secret; removing the active account makes the next one of its kind active |
| `POST` | `/api/v1/providers/:id/test` | Connect and list models; returns `{ok, detail?, models?}` and never fails the request for a bad key |
| `GET` | `/api/v1/models` | Presets first (`ref: "preset:<id>"`, `disabledReason` when no target is usable), then models of all active accounts (`ref: "<accountId>/<modelId>"`), then compute-node models (`ref: "node:<nodeId>/<modelId>"`); each with `kind`, `source`, `label`, `reasoning` (FR-023, FR-221) |
| `GET/PUT` | `/api/v1/presets` | The Faster ↔ Smarter presets `{items, builtIn}`; `PUT {items: []}` restores the built-in set generated from the configured models (FR-221, `docs/07` §8.1) |
| `GET` | `/api/v1/providers/detect` | Probe local model servers (Ollama, llama.cpp, `NOVA_DETECT_URLS`); never sends credentials (`docs/07` §12) |
| `GET/PATCH` | `/api/v1/account` | Profile (FR-113): `AccountView` `{accountId, displayName, username, hasAvatar, createdAt}` / update `{displayName?, username?, avatar?}` (body ≤ 4 MB). A blank display name clears it. `username` matches `^[a-z0-9][a-z0-9_-]{1,31}$` and is unique among live accounts (`conflict` `{field: username, reason: taken}`). `avatar` is `{mime: image/png\|image/jpeg\|image/webp, data}` (base64, ≤ 2 MB), checked by its bytes, stripped of metadata and stored as a sealed blob, or `null` to remove it; a bad image is `validation` `{field: avatar, reason}`. `account.updated` |
| `GET` | `/api/v1/account/avatar` | The avatar image (`Content-Security-Policy: default-src 'none'; sandbox`), or 404 |
| `GET` | `/api/v1/usage?from=&to=` | Usage insights (FR-114), computed on the Hub from `usage_event` and `turn`: `UsageSummary` with totals, by model, by project, by UTC day (days with usage only), active days, streak and the longest completed turn; the default range is the last 30 days |

### Tasks, goals, agents, approvals, requests

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/api/v1/runs` | List/create work runs (with optional budgets and goal) |
| `POST` | `/api/v1/runs/:id/{pause,resume,redirect,cancel}` | Control a run |
| `POST` | `/api/v1/runs/:id/budget` | Extend a budget after a pause `{timeSeconds?,tokens?,costUsd?}` (FR-182) |
| `GET/PUT/DELETE` | `/api/v1/runs/:id/goal` | Read, set or clear the run's goal ([`goal.json`](schemas/goal.json)) |
| `GET/PUT/DELETE` | `/api/v1/agents/:id/goal` | Read, set or clear the agent's goal |
| `GET` | `/api/v1/goals?status=` | List goals across runs and agents (FR-181) |
| `GET/PATCH` | `/api/v1/goals/:id` | Read; edit objective or budgets (applies at the next turn) |
| `POST` | `/api/v1/goals/:id/{pause,resume,complete}` | User status changes; `usage_limited`/`budget_limited` are never settable here |
| `GET/POST` | `/api/v1/schedules` | Recurring tasks, agent schedules and self-set wakes ([`schedule.json`](schemas/schedule.json)) |
| `PATCH/DELETE` | `/api/v1/schedules/:id` | Edit a schedule (`enabled: false` pauses it) or cancel it; proxied by the shell's `schedule.upsert` / `schedule.cancel` |
| `GET/POST` | `/api/v1/agents` | Always-on agents |
| `GET/POST` | `/api/v1/approvals` | List (`status=pending\|all`, `threadId`; a handed-off approval stays pending until marked done) / decide approvals; a decision is an [`ApprovalDecision`](schemas/approval-decision.json) without `decidedBy`/`decidedAt`, which the Hub sets. The first valid answer wins; a later one is `conflict`. A decision the tier does not offer is `validation`; `allow_always` while managed policy disables persistent grants is `policy_denied` (FR-100, FR-189) |
| `GET` | `/api/v1/approvals/:id` | One approval as shown on the card |
| `POST` | `/api/v1/approvals/:id/handoff-done` | The user finished a handed-off step `{note?}`; the waiting turn resumes |
| `GET` | `/api/v1/requests?status=pending` | Pending server-to-client requests for this client ([`server-request.json`](schemas/server-request.json)) |
| `POST` | `/api/v1/requests/:id/respond` | Answer a request; first valid answer wins (§5) |
| `GET` | `/api/v1/activity?ref=` | Activity trace for a thread/run/agent, oldest first: turns, tool calls, approvals, policy decisions; `not_found` for another account's thread |
| `GET` | `/api/v1/audit?kind=&threadId=&cursor=&limit=` | Audit entries, newest first, paged by sequence (FR-104) |
| `GET` | `/api/v1/audit/verify` | Walk the hash chain; reports the first entry whose sequence, previous hash or hash does not match |
| `GET` | `/api/v1/audit/export` | Audit log export (`application/x-ndjson`, redacted) |
| `GET` | `/api/v1/notifications?unread=` | Notifications, newest first, with the unread count (FR-013) |
| `POST` | `/api/v1/notifications/read` | Mark `{ids}` or `{all: true}` read (one of them is required) |
| `DELETE` | `/api/v1/notifications/:id` | Delete a notification |

### Permissions, rules & hooks

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/api/v1/policy/rules` | Tool/resource rules ([`policy-rule.json`](schemas/policy-rule.json)) |
| `PATCH/DELETE` | `/api/v1/policy/rules/:id` | Edit/delete a rule |
| `POST` | `/api/v1/policy/evaluate` | Preview the decision for a hypothetical action (FR-084 preview); no side effects |
| `GET/POST` | `/api/v1/permission-profiles` | Permission profiles ([`permission-profile.json`](schemas/permission-profile.json), FR-190): built-ins `read-only`, `workspace`, `full` and user ones |
| `GET/DELETE` | `/api/v1/permission-profiles/:id` | Built-in and managed profiles are read-only (editing in place arrives later; create a new one) |
| `GET/POST` | `/api/v1/command-rules` | Command prefix rules ([`command-rule.json`](schemas/command-rule.json), FR-191); a rule whose examples fail is rejected with `validation` |
| `PATCH/DELETE` | `/api/v1/command-rules/:id` | Edit/delete a rule (examples re-checked) |
| `POST` | `/api/v1/command-rules/test` | Match `{command, threadId?, projectId?}` against the rules in that scope; returns the decision and the matching rule. A failing rule example on create or edit is `validation` with `details: {field: matchExamples\|notMatchExamples, example}` |
| `GET` | `/api/v1/permission-grants` | Remembered session and always grants |
| `DELETE` | `/api/v1/permission-grants/:id` | Revoke a grant |
| `GET/PUT` | `/api/v1/tool-defaults` | Per-tool defaults `{tool, default: allow\|ask\|deny\|null}` (FR-048); `null` clears one |
| `GET` | `/api/v1/tools?threadId=` | Built-in and MCP tools with the user's default and the effective decision preview (FR-048) |
| `GET/POST` | `/api/v1/hooks` | Hooks from every source with trust state as `HookView` ([`hook-config.json`](schemas/hook-config.json), FR-197): managed policy, `<dataDir>/hooks.json`, each project folder's `.nova/hooks.json` and plugins. Files are re-read and re-hashed on every list, so a changed hook or script shows `needs_trust` with `changedSinceTrust`. Ids are `hook:<origin>.<hookId>` (`hook:project:<projectId>.<hookId>` for project hooks). M4 ships `GET` only (hooks are added by editing a hooks file or installing a plugin) and `HookView.matcher` as one string with the globs joined by `, `; `POST` and a matcher list are a follow-up |
| `PATCH/DELETE` | `/api/v1/hooks/:id` | Enable/disable `{enabled}` or delete a user hook (deleting also removes it from `hooks.json`); a hook from any other source is `policy_denied` (plugin hooks follow their plugin) |
| `POST` | `/api/v1/hooks/:id/trust` | Trust `{contentHash}`: must equal the current hash, else `conflict` with `details.contentHash` (the current one); managed hooks are trusted by policy; `hook.trust.changed` |
| `POST` | `/api/v1/hooks/:id/untrust` | Revoke trust; the hook stops at once; managed hooks are `policy_denied` |

### Memory & import

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/api/v1/memory/items?scopeKind=&scopeRef=&category=&q=&status=` | Memory items, pinned first (FR-032, FR-204) / add one by hand |
| `PATCH/DELETE` | `/api/v1/memory/items/:id` | Correct, pin, dismiss or delete an item |
| `POST` | `/api/v1/memory/import` | Import facts from a provided export (JSON array or one per line); duplicates skipped (FR-032) |
| `GET` | `/api/v1/memory/summary?scopeKind=&scopeRef=` | The current injected summary (≤ 2,500 tokens) and its source run (`scope` is accepted for `scopeKind`). Correcting, dismissing or deleting an item clears its scope's summary until the next run |
| `POST` | `/api/v1/memory/consolidate` | Start a consolidation run now `{scope}` |
| `GET` | `/api/v1/memory/consolidations` | Consolidation run history |
| `PATCH` | `/api/v1/memory/topics` | "Remember more / less about this topic" `{topic, preference: more\|less\|default}` |
| `POST` | `/api/v1/import/preview` | Scan sources `{deviceId, paths[], kinds[]}` through `novad`; returns items, targets, conflicts, masked secrets, duplicates (FR-200). M4 ships a Hub-local scan `{paths[] (≤ 20), kinds[]}` with no `deviceId`; scanning a device through `novad` is a follow-up. `kinds` are `instructions\|skills\|commands\|plugins\|mcp_servers\|projects\|memories\|chats`; symlinks are not followed and sizes are capped. Returns `ImportPreview` `{previewId, items}`: each item with its target, SHA-256, status `new\|duplicate\|conflict\|unsupported` and its secrets masked with the `secret://` reference each becomes. Nothing is written; a preview expires after 30 min |
| `POST` | `/api/v1/import/apply` | Import selected preview items `{previewId, items[]}`; plugins and MCP servers stay disabled. Returns `ImportResult` `{importId, imported, duplicates, disabled, secretsMigrated}`. Skills become user skills with an import origin; every secret goes to the vault; one `import_record` per item; source files are never modified; a failed item does not block a retry, and a name conflict is imported under the next free name. An expired preview is `not_found` `{reason: preview_expired}`; `import.completed` |
| `GET` | `/api/v1/import/records` | Import ledger as `ImportRecordView` (source, kind, SHA-256, target, time), newest first |

The "reference past chats" toggle (FR-205) is the setting `memory.referencePastChats`.

### Code, tools, extensions

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/api/v1/code/sessions` | Code sessions |
| `GET` | `/api/v1/code/sessions/:id/changes` | Diffs |
| `POST` | `/api/v1/code/sessions/:id/{review,commit,pr}` | Review/commit/PR |
| `POST` | `/api/v1/code/sessions/:id/handoff` | Move a session with its Git state to another device or environment `{to}` (FR-213) |
| `GET` | `/api/v1/handoffs/:id` | Handoff status |
| `GET` | `/api/v1/code/worktrees?deviceId=&repo=` | Worktree registry with leases (FR-073) |
| `POST` | `/api/v1/code/worktrees` | Create a worktree and lease it to a session (max 15 per repo, else `conflict`) |
| `POST` | `/api/v1/code/worktrees/:id/{renew,release}` | Renew or release the lease |
| `DELETE` | `/api/v1/code/worktrees/:id` | Remove the worktree (Git hooks disabled, FR-211) |
| `GET/POST` | `/api/v1/mcp/servers` | MCP servers ([`mcp-config.json`](schemas/mcp-config.json)); env values go to the vault and only their names come back; for `sse`/`http` servers each env entry is sent as a header with `_` turned into `-`; names are unique per account (FR-042). `McpServerView` also carries `auth` (FR-047), `bundle` `{name, version, signature}` (FR-199), `connectedAt` and `restarts` (automatic restarts in the last 10 minutes, FR-043); a server that refuses an unauthenticated connection shows "needs authorization". M4 ships the request without the `oauth` and `auth` fields of `mcp-config.json` (OAuth is started per server below and asks for the scopes the resource advertises); the full shape is a follow-up |
| `GET/PATCH/DELETE` | `/api/v1/mcp/servers/:id` | One server / change it (a sent `env` is the complete set: an empty value keeps the saved secret, a value replaces it, an omitted name is deleted; `secret://` values are refused) / remove it with its secrets and working directory. A plugin's server (`McpServerView.pluginId`) changes only through its plugin: PATCH and DELETE answer `conflict` `{reason: plugin_owned, pluginId}` |
| `POST` | `/api/v1/mcp/servers/:id/restart` | Reconnect now and reset the restart backoff (`conflict` while disabled) (FR-043) |
| `GET` | `/api/v1/mcp/servers/:id/logs` | Last 500 redacted log lines (stderr, protocol, status) |
| `GET` | `/api/v1/mcp/servers/:id/tools` | Every tool the server offers, including disabled ones |
| `POST` | `/api/v1/mcp/bundles/preview` | Upload a bundle; returns manifest, signature state and proposed permissions (FR-199). Body `{name, data}`: the archive as base64, at most 50 MB decoded. It is read with path-traversal checks and caps of 10,000 entries, 500 MB unpacked and 200 MB per file (the manifest ≤ 1 MB); a bad manifest is `validation` naming the field. Returns `BundlePreview` (manifest fields, `signature`, proposed `permissions {network[], fs}`, typed `userConfig` fields, tools, warnings). Previews expire after 30 min. No publisher is trusted yet, so every bundle is `unverified` |
| `POST` | `/api/v1/mcp/bundles/install` | Install `{previewId, permissions, userConfig, confirmSideload?}`; unsigned without `confirmSideload: true` is refused (`validation` `{field: confirmSideload, reason: sideload_confirmation_required}`). Returns 201 `McpServerView`; an expired preview is `not_found`. Files go to `<dataDir>/mcp/bundles/<name>/<version>`; sensitive settings, and env values and arguments that use one, go to the vault (`secret://mcp/<id>/…`, resolved at launch); the tools default to `ask`. A newer version updates the server in place and keeps the previous version's folder; a name taken by a server that is not this bundle is `conflict`. Audited as `bundle.install` / `bundle.update`; `mcp.bundle.installed`. M4 ships `permissions.fs` as one choice `none\|read\|project`, applied as `read` or `write` to each folder or file entered in `userConfig` (the install record keeps the per-path list); the per-path request shape is a follow-up. Bundle servers still run outside the sandbox, as in M3 |
| `POST` | `/api/v1/mcp/servers/:id/oauth/start` | Begin OAuth 2.1 with PKCE (S256) for an `sse`/`http` server (FR-047); returns `{authorizeUrl}` for the user to open (`validation` for stdio). Nova registers with its client metadata document when the authorization server accepts one and the Hub URL is HTTPS, else by dynamic registration. The state is random, single-use, expires after 10 min and remembers the account. Audited as `oauth.start` |
| `GET` | `/api/v1/mcp/oauth/callback?state=&code=&error=&iss=` | **OAuth redirect target.** No session (a cross-site redirect carries none): the single-use state ties it to the account. A malformed query is `validation`; otherwise it always answers 302 to `/settings/tools?oauth=ok` or `/settings/tools?oauth=error`. Tokens live only in the vault and refresh within 60 s of expiry or after a 401. Audited as `oauth.connect` or `oauth.failed` |
| `DELETE` | `/api/v1/mcp/servers/:id/oauth` | Sign out: revoke the tokens at the server's revocation endpoint and forget them; returns the server (`auth.status: needs_auth`); audited as `oauth.revoke`. M4 ships `McpAuthView` `{kind, status, expiresAt, scopes}` without `lastError`; the full shape is a follow-up |
| `GET` | `/.well-known/nova-client.json` | Nova's OAuth client metadata document: `client_id` is this URL, `redirect_uris` the callback above, `grant_types` `authorization_code` and `refresh_token`, `token_endpoint_auth_method: none`. Public: it holds no account data |
| `GET/POST` | `/api/v1/mcp/subscriptions` | MCP event subscriptions bound to triggers (FR-201) |
| `DELETE` | `/api/v1/mcp/subscriptions/:id` | Unsubscribe; the webhook URL then answers 410 |
| `POST` | `/api/v1/mcp/events/:subscriptionId` | **Webhook receiver.** No bearer token: a valid signature is required (HMAC-SHA256 over id, timestamp and raw body; timestamp within 5 min); bodies over 256 KiB → 413; duplicates by delivery id → 2xx without effect; bad signature → 401 |
| `GET/POST` | `/api/v1/plugins` | Installed plugins as `PluginView` (status `ok\|needs_trust\|disabled\|error`, verified, confirmed permissions, component counts) (FR-045) / install `{previewId, confirmSideload, enable?, trustHooks?: [{id, contentHash}]}` (201). No plugin is verified until signing lands (FR-049), so `confirmSideload: true` is required (`validation` `{field: confirmSideload, reason: sideload_confirmation_required}`). An expired preview is 410 `request_expired`; a folder that changed or went away after the preview is `conflict`. Installs run one at a time; an update swaps the version folder atomically and rolls back on failure. The plugin's MCP servers become servers with source `plugin`, named by manifest key (`-2`, `-3` on a clash); literal env and header values go to the vault, references must be `secret://plugin/<pluginId>/…`, `deviceId` is refused and `auth` is ignored with a warning. Node servers get `NODE_PATH` set to Nova's own `node_modules`. `plugin.installed` / `plugin.updated` |
| `POST` | `/api/v1/plugins/preview` | What installing would do `{source}`: `{kind: path, path}` (a folder on the Hub), `{kind: catalog, catalogId, pluginId, version?}` or `{kind: git, url, ref?}`. Returns `PluginPreview` (manifest, permissions, hooks with their hashes, MCP servers, skills, warnings, `replaces` on update); held in memory for 30 min with a digest of the whole folder. Nothing is installed |
| `PATCH/DELETE` | `/api/v1/plugins/:id` | Enable or disable `{enabled}` (its servers, skills and hooks follow; `plugin.updated`) / uninstall: its servers and their secrets, roles, skill state and files go (`plugin.removed`) |
| `GET` | `/api/v1/plugins/catalogs` | Catalog sources as `CatalogView` (`local\|url\|git`): the built-in sample catalog `nova-sample` plus the `plugins.catalogs` setting |
| `GET` | `/api/v1/plugins/catalog?q=` | Search every catalog: `CatalogEntryView` with the installed version. Folder catalogs read `catalog.json` or `nova-catalog.json`; URL catalogs need https, an index ≤ 1 MB and same-host zip archives ≤ 50 MB (optional SHA-256 check); Git catalogs take https, ssh or git URLs, cloned shallow with Git hooks off, and answer `capability_missing` when Git is not installed |
| `GET/POST` | `/api/v1/skills?projectId=` | Skills from every source as `SkillView` with `shadowedBy` (managed > project > user > plugin > built-in; a disabled skill drops out) (FR-046) / create `{name, description, whenToUse?, allowedTools?, body, projectId?}` (201): a user skill, or a project skill with `projectId`; a name in use is `conflict`. Skills are `SKILL.md` folders on disk; ids are `skill:<source or pluginId>:<name>` (`skill:project:<projectId>:<name>`) |
| `GET/PATCH/DELETE` | `/api/v1/skills/:id` | `SkillDetail` with body and files / `{enabled}` (a managed skill is `policy_denied`) / delete a user, imported or project skill (others are `conflict`: disable them instead); `skill.changed` |
| `GET` | `/api/v1/slash-commands?projectId=` | `/name` completions as `SlashCommandView`: enabled skills and plugin commands (FR-046) |
| `POST` | `/api/v1/tools/:name/invoke` | Invoke a tool from the UI `{args, threadId?, initiator?}`; it passes the policy gate like a model call (origin `ui`). `initiator: "user"` is only for a click the user made in a Nova client: it counts as the user's own instruction, so a direct action is allowed without a card unless a confirm-every-time step, a handoff, a rule, a deny or the network allowlist applies (policy changes and secret reads always keep their card). The default `"app"` (an MCP App's call) carries no user authority. Returns `{ok, text, error?}`; if it must wait for an approval for more than 60 s the answer is 202 `{approvalId, callId}` |
| `GET` | `/api/v1/artifacts?threadId=` | A thread's artifacts (FR-038) |
| `GET` | `/api/v1/artifacts/:id` | One artifact's metadata |
| `GET` | `/api/v1/artifacts/:id/content` | Its bytes under a restrictive CSP: HTML only with `sandbox allow-scripts` (never same-origin), PDFs without a sandbox directive so the browser viewer works; `?version=N` serves an earlier version; `?v=` (a client cache-buster) is ignored |
| `GET` | `/api/v1/mentions?q=&threadId=` | `@`-mention candidates: files and folders under the thread's roots, MCP servers and tools (FR-022) |
| `GET` | `/api/v1/ui/entry-points?kind=global\|thread\|file` | MCP Apps entry points as `UiEntryPointView` (FR-198): enabled plugins' `ui.entryPoints`, served by one of the plugin's own servers, and `ui://` resources that other servers' tools (`_meta.ui.resourceUri`) or resource lists declare (these open in a thread). Ids are stable 22-character hashes of owner, kind and resource. M4 does not fill `domains` yet |
| `GET` | `/api/v1/ui/resource?entry=` | The entry's `ui://` resource, read through the MCP manager and served as `text/html` (≤ 5 MB) with `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:` plus the allowed domains and `frame-ancestors 'self'; base-uri 'none'; form-action 'none'`, `X-Frame-Options: SAMEORIGIN`, `Cross-Origin-Resource-Policy: same-origin` and an ETag (304 on `If-None-Match`). Allowed domains are the resource's `_meta.ui.csp` and the plugin's `permissions.ui`, intersected with its network permissions (a plugin's `permissions.network`, a bundle's install record or the server's `policy.network`; none otherwise): plain hosts only, `*.x` covers subdomains but not the apex, https by default. Resource domains extend script, style, img, font and media; frame domains `frame-src`; connect domains `connect-src`. A missing, failing or non-HTML resource is 404: a small HTML page when the request accepts `text/html`, else `not_found` |
| `PUT` | `/api/v1/ui/context` | An open app's model-visible context `{threadId, entryId, instanceId, text}` (`text` ≤ 16,000 characters; `null` clears it); returns `{ok: true}`. Kept in Hub memory only (8 apps per thread, 500 threads) and added to the thread's next turn as untrusted content; parts an app marks private (`_meta["nova/private"]`) never leave the browser |
| `GET/POST` | `/api/v1/app-authorizations` | Per-client tokens: MCP clients of Nova's MCP server (FR-192) and third-party apps (FR-222). Create returns the token once. List: `AppAuthorizationView` (revoked ones stay in the database for the audit trail and are not listed). Create `{kind: mcp_client, clientName, scopes: {tools: [..]\|"*", projects: [..]\|"*", threads: none\|read\|read_write, mode: read_only\|run_allowed}, expiresInDays?}` (1–365, default 90; `null` never expires) returns 201 `{authorization, token, endpoint}`: the token starts `nvm_` and is stored only as its SHA-256 hash. An unknown project is `validation` `{field: scopes.projects}`. The first client turns `mcpServer.enabled` on. Audited as `app_authorization.create`; `app.authorization.changed`. M4 ships `kind: mcp_client` only and `AppAuthorizationView` without `status`; the full shape is a follow-up |
| `DELETE` | `/api/v1/app-authorizations/:id` | Revoke; open sessions close at once (calls in progress are cancelled but still answered); audited as `app_authorization.revoke` |
| `POST` | `/api/v1/app-authorizations/requests` | A third-party app requests scopes; returns a user code and verification URL (FR-222). Not in M4 |
| `POST` | `/api/v1/app-authorizations/requests/:id/{approve,deny}` | The user decides in a Nova client. Not in M4 |
| `POST` | `/api/v1/app-authorizations/token` | The app exchanges an approved request for its token. Not in M4 |
| `POST/GET/DELETE` | `/mcp` | **Nova's MCP server** for external MCP clients (streamable HTTP: `POST` carries JSON-RPC messages, `GET` opens the server stream, `DELETE` ends the session). Off until the user adds a client; `Authorization: Bearer` with that client's token from `/api/v1/app-authorizations`, which scopes its tools, projects, thread scope, read-only or run-allowed, and expiry. Missing, wrong, expired or revoked token → 401 `token_required`; non-allowlisted `Origin`/`Host` → 403 `origin_rejected`. Every call is audited with the client id and passes the policy engine; the `nova mcp stdio` launcher proxies to this endpoint with a token from an environment variable or file (FR-044, FR-192, ADR-075, `docs/08` §2.2). M4: while `mcpServer.enabled` is off every method answers 404 `not_found`, and turning it off closes open sessions; a 401 carries `WWW-Authenticate: Bearer realm="nova"`. Tools offered: `projects.list` (when the client has projects), `threads.list` and `threads.read` (when `threads` is not `none`; temporary chats never, and a client limited to some projects sees only their chats), plus the Hub tools its `tools` scope allows, with invalid name characters replaced (`mcp:x.y` → `mcp_x.y`). `read_only` clients get only tools whose action is a read; `tool.search` is never offered; `threads: read_write` grants read only. Calls pass the gate with origin `mcp_client`, never as the user's instruction (FR-189), and are audited as `client.call`. Resources, prompts and the `nova mcp stdio` launcher are not in M4 |

### Ambient (`docs/24`)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/ambient/summary?from=&to=` | Activity summary (FR-229) |
| `GET` | `/api/v1/ambient/search?q=&from=&to=` | Full-text search, time-ordered (FR-153) |
| `GET` | `/api/v1/ambient/elements?q=&from=&to=` | Element matches with bounds |
| `GET` | `/api/v1/ambient/records/:id/context` | One record with its neighbours and, when pixels exist, a short-lived image handle |
| `GET` | `/api/v1/ambient/timeline?from=&to=` | Records and status changes in order |
| `GET` | `/api/v1/ambient/coverage?from=&to=` | Captured, paused, excluded and gap intervals (FR-155) |
| `GET/POST` | `/api/v1/ambient/grants` | Scoped grants for schedules, automations, agents and apps (FR-233) |
| `DELETE` | `/api/v1/ambient/grants/:id` | Revoke a grant |
| `POST` | `/api/v1/ambient/forget` | Delete the last N minutes `{minutes, sources?}` (FR-154) |

Ambient reads return certified rows only (FR-227) and always state the window covered and its
gaps. Calls on behalf of a schedule, automation, agent or app are checked against its grant.

### Settings, network, diagnostics

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/PATCH` | `/api/v1/settings` | Read/update settings |
| `GET` | `/api/v1/flags` | Feature flags with stage ([`feature-flag.json`](schemas/feature-flag.json), ADR-082) |
| `PATCH` | `/api/v1/flags/:key` | Toggle a `beta` or `experimental` flag; `removed` flags and managed locks are refused |
| `GET/PATCH` | `/api/v1/network` | Transports, trust, egress, wake helpers |
| `POST` | `/api/v1/network/setup` | Run the Network Setup assistant step |
| `POST` | `/api/v1/network/test` | Reachability test (LAN/Mesh/Relay) |
| `POST` | `/api/v1/network/rollback` | Revert the last network change |
| `GET` | `/api/v1/diagnostics` | Health snapshot (providers, nodes, MCP servers, sandbox, secrets backend, encryption at rest, warnings, other probes) |
| `GET` | `/api/v1/diagnostics/logs?level=&module=&since=&limit=` | Recent log entries from the in-memory ring (5,000), newest first; `level` means that level and above; redacted (FR-118) |
| `GET` | `/api/v1/diagnostics/logs/export` | The same as `application/x-ndjson` |

## 2. Hub ↔ Compute Node

Internal, authenticated (mTLS over Mesh or LAN). The Hub authorizes every job; nodes never
initiate to clients.

Until certificates arrive with the Mesh (M6.5), a node authenticates with bearer tokens over
LAN HTTP (ADR-089): it registers with a one-use enrollment token, an Ed25519 public key and a
capability document ([`device-capability.json`](schemas/device-capability.json)) signed with
that key; the Hub pins the key, returns a node credential (`nvn_…`, stored hashed) for
heartbeats and model sync, and keeps the node's job token (generated by the node) in the
secret vault to call the node's job API. Every re-sent capability document must verify against
the pinned key. Heartbeats every 10 s; three missed beats mark the node `unreachable`.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/node/v1/register` | (node → Hub) Announce capabilities + certificate; M2: `{enrollToken, name, endpoint, publicKey, capability, signature, jobToken, protocolVersions}` → `{nodeId, credential, heartbeatIntervalMs, protocolVersion}` |
| `POST` | `/node/v1/heartbeat` | (node → Hub) Health, load, queue depth, temperature; `401` once revoked |
| `POST` | `/node/v1/models/sync` | (node → Hub) Advertise available models in a re-signed capability document |
| `POST` | `/node/v1/jobs` | (Hub → node) Submit a job (chat/tool/embedding/media); M2: `{kind: "chat", request}` → `{jobId}` |
| `GET` | `/node/v1/jobs/:id/stream` | (Hub → node) Stream job output as SSE of normalized stream events (`docs/07` §2) |
| `POST` | `/node/v1/jobs/:id/cancel` | (Hub → node) Cancel a job |
| `GET` | `/node/v1/health` | (Hub → node) Health and load |
| `POST` | `/node/v1/services/:name/{start,stop,restart}` | Manage a service |

## 3. Hub ↔ `novad` (management channel)

mTLS using the device certificate. Every privileged action is policy-gated and audited. Calls
go Hub → `novad` unless marked (novad → Hub).

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/agent/v1/register` | (novad → Hub) Register device + capability document + `novad` version |
| `POST` | `/agent/v1/capabilities` | (novad → Hub) Update capabilities (hardware/OS/services/models) |
| `POST` | `/agent/v1/heartbeat` | (novad → Hub) Liveness + metrics |
| `POST` | `/agent/v1/modules/:name/{start,stop}` | Start/stop a module |
| `POST` | `/agent/v1/power` | Sleep, restart, shutdown, wake |
| `POST` | `/agent/v1/boot/profile` | Set/inspect the next boot profile |
| `POST` | `/agent/v1/firmware/read` | Read current BIOS/firmware settings (allowlisted) |
| `POST` | `/agent/v1/firmware/plan` | Dry-run: proposed vs current diff |
| `POST` | `/agent/v1/firmware/apply` | Apply an approved change (snapshot + rollback) |
| `POST` | `/agent/v1/firmware/rollback` | Restore a snapshot |
| `POST` | `/agent/v1/oob/:action` | Out-of-band action (IPMI/Redfish/AMT), off by default |
| `POST` | `/agent/v1/update` | Apply a signed module/binary update |
| `POST` | `/agent/v1/fs/list` | List a directory inside the device's granted scopes (FR-210) |
| `POST` | `/agent/v1/fs/read` | Read a file inside granted scopes (size-capped) |
| `POST` | `/agent/v1/fs/request-access` | Ask for a new folder; approved on the device or the Hub, then added to `device.scopes` |
| `POST` | `/agent/v1/fs/stage` | Stage a write `{path, baseSha256?, content}`; returns a staged-write id and diff |
| `POST` | `/agent/v1/fs/commit` | Commit a staged write after policy allows; fails with `conflict` if the file changed since staging |
| `POST` | `/agent/v1/mcp/list` | List the device's local stdio MCP servers and tools exposed to Hub sessions |
| `POST` | `/agent/v1/mcp/call` | Call a device-local MCP tool under the device's grants |
| `POST` | `/agent/v1/ambient/records` | (novad → Hub) Signed batch of capture and status records ([`ambient-record.json`](schemas/ambient-record.json)); the Hub acks each record id or refuses it with `redaction_policy_stale`, `redaction_categories_insufficient`, `redaction_model_missing`, `redaction_model_rejected` or `forgotten_window` (FR-227, FR-228) |
| `GET` | `/agent/v1/ambient/policy` | (novad → Hub) Current redaction policy version and categories, capture rules, accepted models and profile settings |
| `POST` | `/agent/v1/ambient/forget` | Delete a window from the device spool, queue and pixel targets; also novad → Hub to forward a forget made while offline (FR-154) |

`/agent/v1/firmware/*` returns `403` unless the global "Allow BIOS/firmware changes" toggle
is enabled **and** the specific change has an approval record. `/agent/v1/oob/*` returns
`403` unless the out-of-band module is enabled (off by default). `/agent/v1/fs/*` never
reaches protected paths (FR-190), whatever the grant.

## 4. Native shell ↔ local `novad`

Desktop shells talk to the local `novad` over a Unix domain socket (macOS/Linux) or named pipe
(Windows). The socket is mode **0600** in the user's runtime directory; the named pipe's ACL
allows only the signed-in user. Every request carries the local token, which `novad` writes to
a user-only file and rotates when it restarts; a connection without a valid token is closed
(FR-192). Loopback TCP is not offered.

| Method | Purpose |
| --- | --- |
| `local.capabilities` | Read this device's capabilities |
| `local.exec` | Run a local command in the sandbox (agent tools) |
| `local.fs.list` | List a directory inside granted scopes (FR-210) |
| `local.fs.read` | Read a file inside granted scopes |
| `local.fs.requestAccess` | Ask the user to grant a folder; returns the grant or a denial |
| `local.fs.stage` | Stage a write and return its diff |
| `local.fs.commit` | Commit a staged write after the diff is shown and policy allows |
| `local.mcp.list` | List local stdio MCP servers and their tools |
| `local.mcp.call` | Call a local MCP tool under the device's grants |
| `local.window.capture` | Capture the frontmost (or picked) window: screenshot + accessibility text, redacted, excluded apps and password fields never captured (FR-214) |
| `local.screen` | Computer-use operations |
| `local.browser` | Local browser automation |

The shell never receives raw secrets; it requests scoped operations that `novad` enforces.

## 5. Streaming & backpressure

- Streams use SSE or WebSocket; events follow `contracts/events.md`.
- High-frequency deltas are coalesced (≤ 60/s); screenshots ≤ 1 per 2 s.
- Slow clients drop ephemeral deltas but never persisted events.
- Reconnect resumes from the last event id; the Hub replays missed persisted events and
  re-sends every request that is still `pending`. Without a cursor (`Last-Event-ID` or
  `?after=`) a stream sends live events only, on `/api/v1/events/stream` as on a thread's stream.
- **Notification opt-out**: a client lists event names it does not want in `/api/v1/hello`
  (`suppressEvents`); the Hub omits them from that client's streams. `request.*` events
  cannot be suppressed.

### WebSocket upgrade checks

- The upgrade needs the client's token or certificate (browsers: the Hub session cookie,
  `SameSite=Strict`); otherwise `401 token_required`.
- `Host` must be one of the Hub's configured hostnames. When `Origin` is present it must be
  on the allowlist (the Hub's own web origins plus any the owner adds); otherwise
  `403 origin_rejected`. Native clients that send no `Origin` are accepted on token alone.

### Terminal frames (FR-006)

`/api/v1/terminals/:id/ws` carries JSON text frames:

```json
{ "type": "input",  "data": "ls -la\r" }
{ "type": "resize", "cols": 120, "rows": 32 }
{ "type": "output", "data": "…" }
{ "type": "exit",   "code": 0 }
{ "type": "error",  "error": { "code": "validation", "message": "unknown terminal frame" } }
```

- The client sends `input` (at most 256 KiB) and `resize` (`cols` 10–500, `rows` 5–200); it
  sends a `resize` when the socket opens and whenever its size changes, and closes the socket
  after `exit`.
- The Hub sends `output`, `exit` (`code` is null when the terminal was closed or killed) and
  `error` for a frame it cannot read. On attach it first replays the scrollback, then `exit` if
  the terminal has already ended. Several viewers may attach to one terminal.

### Server-to-client requests (FR-188)

The Hub asks connected clients questions over the stream they already hold: approvals,
user input, MCP elicitations, client-side tools and credential refreshes
([`server-request.json`](schemas/server-request.json)).

WebSocket frames:

```json
{ "type": "event",   "event": { "...": "EventEnvelope" } }
{ "type": "request", "request": { "id": "req_…", "kind": "approval", "payload": { }, "expiresAt": "…" } }
{ "type": "respond", "requestId": "req_…", "result": { "approvalId": "…", "decision": "allow_once" } }
{ "type": "respond.ack", "requestId": "req_…", "status": "resolved | conflict | expired" }
```

Over SSE, requests arrive as `request.created` events and are answered with
`POST /api/v1/requests/:id/respond {result}`.

Rules:

1. A request goes only to clients that declared its kind in `/api/v1/hello`; a `client_tool`
   request goes only to its `targetDeviceId`.
2. Each request has exactly one resolution. The first valid answer wins and every other
   client receives `request.resolved`; a later answer gets `409 conflict` with the winning
   resolution, and an answer after `expiresAt` gets `410 request_expired`.
3. Answers are validated: approval results must be an `ApprovalDecision` allowed for the
   tier (FR-189); `handoff_required` and `confirm_at_action` requests can be answered only
   from an authenticated Nova client, never from a channel.
4. When no capable client is connected, or the request is unanswered, the Hub sends a
   notification (FR-060). At `expiresAt` the request becomes `expired` (`request.expired`);
   an approval records the decision `timeout` and the run pauses (default 24 h).

## 6. Error shape

```json
{ "error": { "code": "policy_denied", "message": "Action requires approval.",
             "retryable": false, "details": { "approvalId": "…" } },
  "requestId": "req_…" }
```

| Code | HTTP | Meaning |
| --- | --- | --- |
| `auth_missing` | 401 | No credentials |
| `auth_expired` | 401 | Token or certificate expired |
| `token_required` | 401 | A listener or stream upgrade without a valid token or certificate (FR-192) |
| `origin_rejected` | 403 | WebSocket or MCP request with a non-allowlisted `Origin` or `Host` |
| `policy_denied` | 403 | The policy engine denied the action |
| `approval_required` | 409 | An approval is pending; `details.approvalId` |
| `hook_untrusted` | 409 | The hook's content hash changed or was never trusted |
| `rate_limited` | 429 | Retry after `details.retryAfter` |
| `over_budget` | 402 | Account or provider spend cap reached (FR-116) |
| `budget_exhausted` | 409 | A run or goal budget, or the 200-step backstop, was reached; `details.bound` (FR-182) |
| `goal_blocked` | 409 | The goal is `blocked`; `details.blocker` (FR-181) |
| `request_expired` | 410 | The server request expired before this answer |
| `capability_missing` | 400 | Feature, request kind or experimental field not negotiated (§7) |
| `sandbox_unavailable` | 409 | No sandbox could be created (for example for a terminal); fails closed, read-only mode offered |
| `node_unavailable` | 503 | No node can take the job |
| `firmware_disabled` | 403 | Firmware changes are off |
| `oob_disabled` | 403 | Out-of-band module is off |
| `validation` | 400 | Payload failed its schema or rule examples |
| `conflict` | 409 | State changed (request already resolved, stale hash, lease held, worktree cap) |
| `not_found` | 404 | No such resource |
| `server_error` | 500 | Unexpected failure |

## 7. Versioning

- Path prefix `/api/v1`, `/node/v1`, `/agent/v1`.
- Breaking changes bump the major version; one compatibility shim is supported for one release.
- **Capability handshake** (ADR-072). A client calls `POST /api/v1/hello` after
  authenticating, before opening streams:

```json
{ "client": { "name": "nova-web", "version": "0.5.0", "platform": "web" },
  "protocolVersions": [1],
  "capabilities": {
    "experimental": false,
    "serverRequests": ["approval", "user_input", "elicitation", "credential_refresh"],
    "clientTools": [],
    "suppressEvents": ["chat.search.indexed"],
    "mcpApps": true,
    "streams": ["ws", "sse"]
  } }
```

  The Hub answers with what was agreed:

```json
{ "hub": { "id": "…", "version": "0.5.0" },
  "protocolVersion": 1,
  "apiVersions": { "api": ["v1"], "node": ["v1"], "agent": ["v1"] },
  "features": { "goals": "stable", "sandbox.microVm": "beta" },
  "serverRequests": ["approval", "user_input", "elicitation", "credential_refresh"],
  "limits": { "eventsPerSecond": 60, "maxUploadBytes": 104857600 },
  "clientSessionId": "…" }
```

- The Hub picks the highest common protocol version; with none in common it answers
  `capability_missing` naming both sides' versions.
- `features` lists feature flags with their stage (ADR-082). Experimental methods and fields
  are rejected with `capability_missing` unless the client set `experimental: true`;
  experimental flags appear only for such clients.
- Nodes and `novad` negotiate the same way in the body of `/node/v1/register` and
  `/agent/v1/register`; the Hub refuses a `novad` below the minimum version for a requested
  capability (FR-081).
