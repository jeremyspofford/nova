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
- Ops (`src/ops/`) — the hash-chained audit log (its list views carry each entry's detail,
  redacted again and capped; M7.5), notifications, activity, diagnostics and the data key that
  seals blobs at rest (FR-013, FR-104 partial, FR-118, FR-149 baseline). The security subscriber
  writes the one `setting.changed` entry of every security setting change, with before, after
  and `confirmed`.
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
  `image.generate` is listed only while a provider adapter can make images (since M7 the
  OpenAI-compatible adapter's `generateImage`, for models recognised as image models).
- Plugin drafts (`src/plugins/authoring.ts`) — `pluginScaffoldTool` (`plugin.scaffold`, FR-050):
  writes a draft under `<dataDir>/plugins-drafts/` and checks it with the installer's loader;
  never installs.
- Memory consolidation (`src/consolidation.ts`) reads only the messages the user typed into a
  conversation, plus Nova's replies.

M6 (decisions in `docs/20` ADR-093):

- Agents (`src/agents/`) — `AgentService`, always-on agents (FR-079, FR-080, FR-082..FR-084,
  FR-089, FR-090, FR-181, FR-194, FR-206): each agent is a set of `agent` threads (main, proactive
  research, one per channel binding, one per delegated run) with instructions, responsibilities,
  rules, one goal and notes. Its turns run in the one chat loop through the `TurnStarter`, shaped
  by its `TurnExtension` (budgets per turn chain, notes as untrusted context). `rules.ts` turns
  agent rules into user-layer policy rules scoped to the agent's threads (`agentPolicy`, read by
  the gate's `useAgentPolicy`); `external.ts` is the `ExternalAgentGuard` (FR-194) the channels
  and browser areas call; `tools.ts` offers `schedule.wake`, `schedule.create`, `schedule.list`,
  `schedule.cancel`, `agent.note`, `agent.notes`, `agent.progress`, `agent.delegate`,
  `agent.background`, `sessions.*` and the agent `goal.*` tools. The scheduler gains
  `createForAgent`, `listForAgent` and `useAgents`: an agent's schedule fires a turn on its main
  thread, not a run.
- Channels (`src/channels/`) — `ChannelService` (FR-088, ADR-070): adapters for Slack, Teams
  (with a JWT verifier), webhook, email (refused in M6; built in M7, below) and in-app (`adapters/`);
  bindings, identities, loop prevention, dedupe and rate caps; channel turns carry no authority.
  `answers.ts` answers pre-approvable approvals from a channel; `privacy.ts` is the
  private-to-shared check; `delivery.ts` makes Slack and Teams schedule delivery targets;
  `TriggerService` (`triggers.ts`, FR-056); `McpEventService` (`mcp-events.ts`, FR-201, over
  `@nova/mcp`'s `McpEventsClient`); `NotificationRouter` (`notify.ts`, FR-060): per-category
  routing, quiet hours and deferred channel copies, a shared binding's only when
  `ChannelService.mayNotify` allows it; `channel.list` and `channel.send`.
- Computers (`src/computers/`) — `ComputerService` (FR-080): an agent's computer created on first
  use, a folder on the Hub (`computer.ts`) or the mock cloud runner (`cloud.ts`), snapshots,
  restore and stop, devices as `local_host` computers, and the browser and screen controllers
  late-bound. The egress proxy (FR-102, FR-193, ADR-063): `egress-policy.ts` (modes, host
  patterns, the effective policy of global, profile and scopes), `egress-proxy.ts` (one session per
  sandbox; DNS pinning, private-address block, redirects re-checked, 403 with
  `X-Nova-Block-Cause`, credential injection, stripping hooks, every decision audited),
  `egress-ca.ts` (the per-Hub inspection CA) and `egress-store.ts` (scopes and credentials).
- Sandboxes (`src/tools/sandbox*.ts`) — `detectSandbox` picks a container engine, then bubblewrap
  with seccomp on Linux (`sandbox-bwrap.ts`), or the flagged micro-VM stub (`sandbox-microvm.ts`),
  over one session engine (`sandbox-process.ts`). The network is the egress proxy's socket only
  (`sandbox-egress.ts`). `sandbox-publish.ts` is the dev-server bridge: a request with
  `publish: {port}` gets a forwarder on a Unix socket in the sandbox and a listener on the Hub's
  127.0.0.1 (`published.hostPort`). `sandbox-protect.ts` mounts the protected paths read-only or
  hidden in every substrate (FR-190); `sandbox-router.ts` routes a thread's commands to its Code
  session's environment (`threadSandboxRouter`).
- Browser (`src/browser/`) — `BrowserService` on `playwright-core` (FR-086, FR-092, FR-094,
  FR-095, FR-096, FR-098, FR-103, FR-208): one browser per computer behind its own egress session,
  site permissions and levels (`sites.ts`), the page-action classifier (`classifier.ts`) checked
  through the gate for every page write, injection defense (`injection.ts`), the action recorder
  with sealed before/after screenshots (`recorder.ts`), private sign-in (`signin.ts`), the
  `browser.*` tools and page tools (`tools.ts`), and `grantDevServer` / `openDevServer` for Code
  dev servers. Chromium is loaded lazily; without it every tool refuses with the reason.
- Screen (`src/screen/`) — `ScreenService` (FR-093, FR-207, FR-098, FR-087, FR-075): computer use
  with control tiers (`tiers.ts`), per-app grants, the kill key, takeover, recorded actions with
  encrypted screenshots, appshots, and the `screen.*` and `appshot.capture` tools; `MockDesktops`
  (`mock-desktop.ts`) serve cloud computers' screens; `png.ts` writes, reads and crops PNGs.
- Devices (`src/devices/`) — `DeviceService` for computers running `novad` (FR-081, FR-141,
  FR-142, FR-144, FR-145, FR-148, FR-150, FR-210): enrollment, signed capability documents,
  overrides and policy, modules, services, power and Wake-on-LAN (`wol.ts`), signed updates and
  the minimum version per capability (`versions.ts`), grants, access requests and staged writes,
  local MCP, and the agent's one connection. `protocol.ts` and `client.ts` are the Hub's side of
  `/agent/v1`; `computer.ts` serves devices as `local_host` computers and `environment.ts` as Code
  environments; `fake-device.ts` is a test double.
- Code M6 (`src/code/`) — `EnvironmentService` (`environments.ts`: container, SSH, WSL and device
  environments, FR-062, FR-078), Git hosts and pull requests (`githost.ts`, `pr.ts`: push guards,
  secret scan, CI polling and feedback, FR-070), the worktree registry with leases (`worktrees.ts`,
  FR-073), dev servers (`devservers.ts`, FR-097) with the browser's grant and opener factories
  (`preview.ts`: `browserDevServerGrant`, `browserDevServerOpener`), auto-verify (`verify.ts`,
  FR-068), cross-session operations and `task.spawn` workers (`sessions.ts`, FR-072), session
  budgets, and the tools `git.branch`, `git.commit`, `pr.create`, `pr.status`, `devserver.*`,
  `task.spawn`, `task.wait` and `sessions.*` (`tools-m6.ts`).
- Spaces (`src/spaces/`) — `SpaceService` (FR-036): versioned Markdown pages, comments anchored
  with `anchors.ts`, proposals; `SiteService` (`sites.ts`, `site-render.ts`, FR-037): static sites
  with no script, previews, deterministic zips and reversible publishes; `markdown.ts` (safe
  Markdown, no raw HTML), `data.ts` (JSON and CSV, 2 MB, 5,000 rows, 50 columns), and the tools
  `page.read`, `page.edit`, `page.comment` and `visualize.create` (FR-076). The visualization
  layout and SVG export live in `@nova/shared`.
- Elsewhere — the gate's `useAgentPolicy` (an agent's rules join the user layer of its threads'
  policy; a rule claiming the managed layer is coerced to user; a source that throws denies); the
  tool runtime lets `builtin`, `browser` and `computer` tools end the turn (`approval_timeout`,
  `deny_stop`); `NotificationService.useRouting` and the `os` flag on `notification.created`;
  `BLOB_REFERENCES` (`purge.ts`) lists every column naming a content-addressed blob;
  `writeSealedFile` / `readSealedFile` (`attachments.ts`) seal files that are not
  content-addressed; the activity trace adds `computer` items with screenshot links.

M6.5 (decisions in `docs/20` ADR-094):

- Add Device (`src/pairing/`) — `PairingService` (FR-132, FR-140): pairings with a short code
  (`code.ts`: Crockford base32, the salted code hash, the v1 and v2 confirmations, the commitment,
  the Hub's reveal statement and the device-signed reveal and status messages), the v2
  commit-then-reveal handshake, the code-only guess budget, signed status polls, grants handed out
  once (device sessions, or enrollment tokens bound to the device key through `binding.ts`), the
  owner's approve and deny, expiry (`startSweeper`), revocation for every kind of device (sessions
  deleted, the key blocked in `revoked_device_key`), the device list and scopes, and
  `requestFromRelay` / `onDecided` for the Relay. `SlidingWindowLimiter` (`limiter.ts`) rate-limits
  public routes per client address. `DeviceService` and `NodeService` take the binding in
  `createEnrollToken` and check it on register; `DeviceService.onRevoked` and `useWakeRouter` are
  new.
- Network (`src/network/`) — `EndpointRegistry` (`endpoints.ts`, FR-135): LAN candidates from the
  interfaces, Mesh and Relay sources, Direct public, scheduled and on-demand checks with
  `probeHello` (`probe.ts`: the hello probe with the signed identity check), what is advertised,
  the probe history and transport event log. `MdnsAdvertiser` (`mdns.ts`, on `multicast-dns`),
  `NetworkChangeLog` (`changes.ts`: changes with registered undo handlers, one-click rollback),
  `WakeHelperRouter` (`wake.ts`, FR-138), `deviceReachability` (`reachability.ts`) and the address
  helpers (`subnet.ts`). Mesh adapters (`mesh/`: Headscale, the Tailscale client, NetBird, plain
  WireGuard, ufw and package installs over `ProcessMeshRunner`, which runs argument lists with
  timeouts, process groups, a fixed environment and fixed search paths) and the Network Setup
  assistant (`setup/`: `NetworkSetupService`, the planner, the store, the lock-out guard and the
  seams to the other areas, FR-136).
- Trust (`src/trust/`) — `TrustService` (FR-134): the Hub local CA with name constraints, the
  Hub's TLS certificate and its renewal, device certificates and their revocation list, mesh
  certificates, CA replacement on request, the TLS material the listener serves and the signed
  identity statement. `HubIdentity` (`identity.ts`) is the Ed25519 identity key, which refuses to
  load rather than replace a recorded key; `checkHubIdentity` (`pinning.ts`) is the reference
  pinning check; `x509.ts` is the X.509 builder the egress CA now shares.
- Relay connector (`src/relayhub/`) — `RelayHub` (FR-137): registration with a Relay (the route
  token and the Hub's X25519 key in the vault), the outbound connection, pairing slots for Add
  Device and claims handed to it, the paired-client registry with revocation, persisted stream
  floors, and the tunnel that dispatches clients' requests into the Hub. The protocol itself is
  `@nova/relay` (`packages/relay`).

M7 (decisions in `docs/20` ADR-095):

- Sync (`src/sync/`) — `SyncService` (FR-109, FR-129, FR-128): the Hub-canonical change feed (one
  row per field with a cursor and a hybrid logical clock, `hlc.ts`), fed by the bus and a 5-minute
  sweep; paged snapshots; pushed field ops merged per field, last writer wins, with the merge log
  and restore; replica bookkeeping, reset and revocation. `entities.ts` reads the synced kinds
  (threads, messages, projects, memory items, spaces, pages, schedules, the owner's non-security
  settings); `writers.ts` writes pushed ops through the owning services (`serviceWriters`), a
  message as an append, and a local model's answer only for a device with `local-runtime`.
  `IdempotencyStore` (`idempotency.ts`, FR-112): keys per principal, method and path for 24 hours,
  first answers kept only for routes that opt in, never an answer that carries a credential
  (`carriesCredential`) or is `no-store` or over 256 KiB. `ChatService.answer` answers a message a
  replica wrote offline through the normal turn.
- Cloud runner (`src/cloudrun/`) — `CloudRunService` (FR-108, FR-071, FR-116): the runner's
  registration (token in the vault), cloud environments for `EnvironmentService.useCloud`
  (`provider`), leases with metering and caps followed over the runner's event stream, snapshots,
  artifacts copied into the thread, Work runs on a cloud environment, the sweep and reconcile;
  `client.ts` (`RunnerClient`, bounded reads), `sandbox.ts` (a cloud thread's `SandboxClient`,
  network off unless `cloud.runner.unrestrictedNetwork`), `transport.ts` (the
  `EnvironmentTransport` for Hub-side Git and files). `toolRules` hides the Hub's `fs.*` tools in
  cloud threads; `workPolicy` makes the cloud folder the root of bound Work threads.
- Channels M7 (`src/channels/`) — Telegram (`adapters/telegram.ts`: long polling or webhook,
  inline-keyboard approvals) and email (`adapters/email.ts`, `adapters/mail/`: IMAP over
  `imapflow`, SMTP over `nodemailer`, parsing over `mailparser`, the DMARC sender check, loop
  guards), the pollers that run polling bindings (`pollers.ts`), signed one-use approval links
  (`approval-links.ts`), Slack buttons, the message log, and Web Push (`push/`: `webpush.ts`, RFC
  8291 encryption and RFC 8292 VAPID on `node:crypto`; `PushService`, the OS leg of notification
  routing, Web Push to browsers and native pushes through the Relay connector's `pushNotify`).
- Code M7 (`src/code/`) — handoff (`handoff.ts`, FR-213: the Git state as a bundle and a
  binary-safe patch, target checks, keep or clean, chat handoff), three-way merges (`merge.ts`,
  FR-073, `git merge-file`), best-of-N attempts (`attempts.ts`, FR-212), the environment transport
  that lets remote sessions (SSH, WSL, device, cloud) get Hub-side diff, review and commit
  (`transport.ts`), SSH environments over the system OpenSSH client with pinned host keys and a
  hash-checked helper (`ssh.ts`, FR-062), and delegation from an agent (`delegation.ts`,
  `code.delegate`, `delegatedRules`, `delegatedToolLimits`).
- Team (`src/team/`) — `TeamService` (`members.ts`: the recorded owner, invitations, joining,
  removing a member, members' own preferences), `access.ts` (`OWNER_ONLY_ROUTES`,
  `memberScoped`: a folder of its own for every non-owner account), `owner.ts` (`hubOwnerId`,
  `isHubOwner`), `public-net.ts` (public addresses only for non-owners, pinned),
  `SharedThreadService` (`shared.ts`, FR-217), `TeamAgentService` (`agents.ts`, FR-091),
  `OidcService` (`oidc-service.ts`, `oidc.ts`: the code flow with PKCE and the ID-token checks on
  `node:crypto`, FR-113) and `ProfileCardService` (`card.ts`). `approvals/limits.ts` holds the
  per-thread tool limits the gate applies (`useToolLimits`): shared threads, sub-agent tool lists
  (FR-053), plugins per agent.
- Scripts (`src/scripts/`) — `script.run` (FR-202, flagged): one QuickJS engine per run in a worker
  thread (`vm.ts`, `worker.ts`) with CPU, memory, stack, call and log limits; nested tool calls
  through the tool runtime (`runner.ts`, `tool.ts`); views of runs and their nested calls.
- External agents (`src/acp/`) — `ExternalAgentService` (FR-203, flagged): a JSON-RPC Agent Client
  Protocol client (`jsonrpc.ts`, `protocol.ts`, `client.ts`), the host side that turns the agent's
  file, terminal and permission requests into gated `fs.*` and `exec.*` calls (`host.ts`), the
  sandboxed launcher (`launcher.ts`) and adapters and delegations with coalesced progress events
  (`service.ts`).
- Browser M7 (`src/browser/`) — console and network capture with redaction (`capture.ts`),
  `browser.hover`, element screenshots, `browser.console` and `browser.network`, crash restarts,
  site levels per project or agent (`sites.ts`, through the policy engine's `ruleTool`) and the
  trace newest first with a cursor.
- Devices M7 — `novadDeviceForCredential` and `computeNodeForCredential` (the credential check the
  Hub's device-trust area ties a client certificate to), the heartbeat answer's granted `scopes`,
  and the Relay connector's registration token and `pushNotify`.
- Elsewhere — `ThreadService` and `ProjectService` emit the events sync's change feed follows;
  the gate takes the thread's own substrate (`useSubstrate(accountId, threadId)`) and `ruleTool`;
  `ask_user` answers carry the user's authority for the rest of the turn (FR-188); the tool runtime
  adds a redacted `approvalDetail` to approval cards (a device commit's staged diff).

M7.5 (decisions in `docs/20` ADR-096):

- Device authorizations (`src/firmware/authz.ts`) — the Hub-signed authorization every privileged
  `novad` request carries (firmware apply and rollback, boot set, commit and revert,
  decommission): canonical JSON, `signDeviceAuthorization` / `authorizeDeviceBody` over the
  `nova-device-authz-v1` domain, `verifyDeviceAuthorization` with a `MemoryReplayStore` (used by
  the fakes); the fixed vectors in `test/fixtures/device-authz-vectors.json` are shared with
  `novad`.
- Firmware (`src/firmware/`) — `FirmwareService` (FR-146): reads through the device (cached
  60 s), plans with the device's snapshot, Hub-only approval cards bound to the diff, apply and
  rollback with a signed authorization, the Hub's sealed copy of each snapshot, the BIOS admin
  password from the vault (sent only over mutual TLS, deleted when the device is revoked),
  watchdog reports from heartbeats (`revert_failed`, `missed`) and the hardware support check;
  `protocol.ts` parses `novad`'s answers; `FakeFirmwareNovad` (`fake-novad.ts`) is a `novad`
  firmware double that checks every authorization. The support matrix is in `@nova/shared`
  (`m75/firmware.ts`).
- Boot (`src/boot/`) — `BootService` (FR-143): boot profiles, one-shot trials and "make default"
  after a Hub-only approval, revert, the Hub-side watchdog and the device's watchdog reports;
  `PxeService` (`pxe.ts`): per-device boot tokens (hashed), the iPXE menu (`ipxeScript`) and boot
  images; `protocol.ts` (the `novad` boot wire and `bootAuthorizer`); `FakeBootDevice` (`fake.ts`).
- Out-of-band (`src/oob/`) — `OobService` (FR-147): BMC endpoints with checked addresses
  (`address.ts`), credentials in the vault, certificate pins confirmed by the owner, Hub-only
  approval cards bound to the BMC, power, sensors, one-time boot and BIOS pending settings;
  `RedfishClient` (`redfish.ts`, pinned TLS, no redirects), `IpmiAdapter` (`ipmi.ts`, `ipmitool`
  with the password only in the environment) and the Redfish BIOS table (`bios.ts`).
- Browser on a device (`src/browser/`) — the local browser fallback (FR-209):
  `ChallengeCounter` and `detectBlock` (`blockpage.ts`), `LocalFallbackService` (`fallback.ts`:
  the offer as a `user_input` request with a `context`, consents, sessions, orphan cleanup),
  `DeviceBrowserDriver` and the loopback DevTools relay (`device-launcher.ts`) and
  `deviceBrowserLink` (`device-link.ts`, over the devices service's management transport). The
  extension bridge (FR-096): `ExtensionBridgeService` (`bridge.ts`: connection state, tab consent,
  host grants, the Hub's own hosts excluded, `cdp.send` limited to `BRIDGE_CDP_METHODS`),
  `BridgeTabDriver` (`bridge-tab.ts`) and the `browser.history_search` tool (`bridge-tools.ts`).
- Devices M7.5 (`src/devices/`) — the management channel over mutual TLS (`tls.ts`:
  `openMutualTls`, `mutualTlsDeviceTransport`, `checkDeviceServerCertificate`, the legacy
  clientAuth-only check), `DeviceService.call` (never plain HTTP to an https device), the endpoint
  no-downgrade rule, the heartbeat answer's `policy` and `certificate`, `onHeartbeatEvents`,
  `useFirmwarePolicy` and `useBootPolicy`, decommission with a Hub-only card, managed services,
  available builds and owner overrides with push-now.
- Trust M7.5 (`src/trust/`) — the Hub's client certificate (in the vault), device certificates
  with both purposes, renewal through the heartbeat (`deviceCertificateRenewal`,
  `deviceCertificatePresented`, `deviceCertificateState`) and the legacy certificate's grace.
- Compute nodes (`src/nodes/`) — the owner's node policy (quiet hours, routing eligibility) in the
  heartbeat answer, VRAM from the node's reports, and the node's services.
- Elsewhere — the approvals gate refuses any decision on a Hub-only card (`answerIn: 'hub'`) not
  made by the signed-in user (`hub_only`); channels never offer or accept an answer to one
  (`HUB_ONLY_TEXT`); `ApprovalView` gains `answerIn` and `scope`; `user_input` requests take an
  optional `context` (`requests/validate.ts`).

M8 (decisions in `docs/20` ADR-097):

- Extension SDK (`src/sdk/`, FR-117) — `ExtensionService` (preview, install, `nova dev`, update with
  the publisher-change check, kept signed bundles and rollback through `snapshot()`, uninstall,
  secrets, managed refusal and `reapplyPolicy`, the digest check before a worker starts, the tool
  source, the plugin permission source, the hook client and hook gate for SDK hooks, panels for MCP
  Apps), `ExtensionHost` (`host.ts`: one worker per account and extension, the `nova` API with
  every declared-permission check, fetch within the egress ceiling and its in-flight caps, files on
  real paths, secrets at `secret://extension/<account>/<id>/<name>`), the QuickJS engine
  (`engine.ts`, `worker.ts`: memory, CPU slices across promise jobs, timers, faults), `bundle.ts`
  (`.novax` read and pack, the D2 digest, `verifyBundle`, `secretFileProblems`), `keys.ts` (Ed25519
  publisher keys, `signDigest`/`verifyDigest` with the `nova-extension-v1` and `nova-catalog-v1`
  domains), `manifest.ts` (`extension.json`, observable events, `ext:` tool and hook names, the
  hook hash over the bundle), `describe.ts` (permission lines with details and the update diff) and
  `validate.ts` (`nova validate`).
- Marketplace (`src/market/`, FR-049) — `Marketplace` (catalogs, search, preview with the verdict
  and the permission diff, install one at a time with rollback, remove, ratings, pets), catalog
  sources (`sources.ts`: built-in, folder, Git at a pinned commit, https), the index format
  (`catalog-index.ts`), catalog signatures and folder digests (`signing.ts`), the installers per
  kind (`installers.ts`: plugins and extensions with provenance, skills, themes, pets) and
  permission lines (`permissions.ts`). `documents/zip.ts` is the bounded zip reader every archive
  goes through.
- Managed policy (`src/managed/`, FR-106) — `ManagedPolicy` (`policy.ts`: the local, remote and test
  sources, last good copies, fail closed, the compiled settings layer, `managed.policy.changed`),
  the file and remote checks (`source.ts`: ownership, `NOVA_MANAGED_SETTINGS_FILE` gating, the
  signed envelope), tighten-only rules per setting (`rules.ts`) and `managedRestrictions` (the typed
  getters every area reads from the `managed.restrict` setting, `managedDenied`).
- Data controls (`src/datactl/`, FR-105, FR-121) — `DataControls` (export, ticket downloads,
  delete-all, upload, check and import, retention, crash reports), the ZIP64 writer and reader
  (`zip.ts`), sealing (`seal.ts`: scrypt and chunked AES-256-GCM), the table codec (`codec.ts`),
  data-folder roots (`files.ts`), `exporter.ts`, `importer.ts` with `vet.ts` (secret references,
  paths, what comes back off), `wipe.ts`, retention (`retention.ts`) with the audit anchor
  (`anchor.ts`, `verifyAuditChain`), crash reports (`crash.ts`, `installCrashReporting`) and the
  `nova data` commands (`cli.ts`). Spend caps are `SpendCaps` and `withSpendCaps` in
  `src/profile/spend.ts` (FR-116, FR-115: caps, reservations, alerts, clear usage, provider limits).
- Third-party apps (`src/appauth/`, FR-222) — `AppAuthService` (registration, consent, codes, token
  chains with rotation and reuse detection, revocation, the call audit), redirect rules
  (`redirect.ts`), PKCE (`pkce.ts`) and the scopes and `APP_ROUTE_SCOPES` (`scopes.ts`).
- Channels M8 (`src/channels/`, FR-110) — `ChannelOAuth` (`oauth.ts`: email OAuth sign-in, refresh
  and revocation, tokens in the vault) and `files.ts` (Telegram files in and out, the text-file
  check, `channel.send` files).
- Team M8 (`src/team/`) — the route classification (`routes.ts`: `ROUTE_GROUPS`,
  `WEB_SHELL_ROUTES`, `routeClass`; the member guard in `access.ts` reads it), `MemberPurgeService`
  (`member-purge.ts`: the grace sweep, purge with redaction, the `cleaning` state).
- Spaces and sites M8 (`src/spaces/`, FR-036, FR-037) — page order in one write (`reorderPages`),
  what a deletion takes (`deletionImpact`), deleted pages and `undeletePage`, a site's source preview
  (`previewSource`), the publish plan (`plan`), and hosting targets (`hosting.ts`: the `HostingTarget` interface with `HubFolderTarget` and the remote
  kind, `SiteTargetService`, the egress check every request passes, the credential in the vault; `webdav.ts`: the WebDAV
  client with a temporary collection swapped in by one MOVE, the `.nova-site` marker, no redirects,
  30 s per request; `targetError` problems).
- Saved themes in full — the theme tokens a saved theme may set and the plain-value rule are in
  `@nova/shared` (`THEME_ID`, `SAFE_THEME_VALUE`); the marketplace clears `appearance.customTheme`
  when it removes the theme in use.
- Account export (`src/datactl/account.ts`) — one account's archive for a removed member, built on a
  private copy of the database by walking the schema; `DataControls.exportAccount`.
- Elsewhere — `PluginService.install` takes provenance; plugin hook hashes cover the plugin's files
  (`plugins/hook-hash.ts`); `acp/env.ts` (the allowlist of environment names for ACP terminals);
  `script.run` records origin `script`; image generation honours spend caps and managed providers;
  `devices/service.ts` `mcpRequest` (device MCP resources and prompts).
