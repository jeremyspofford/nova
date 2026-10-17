# External findings: APP-3 (open-source coding-agent engine)

Input for the Phase 0 reconciliation (`PROMPT.md` §2). These are **findings, not decisions**.
APP-3 is tracked by its opaque ID (`docs/19` §1.3). Other reference apps appear only as APP-1,
APP-2 and APP-4. Any requirement derived from this file must be rewritten in vendor-neutral
language (`docs/01` §5, the brand-name invariant).

## Provenance

| | |
| --- | --- |
| Target | APP-3: an open-source coding-agent engine (a Rust workspace of about 150 crates) with a CLI, a terminal UI, an "app-server" API and a cloud-task client. APP-1's desktop client bundles it as its coding mode. |
| Version | Public repository at commit `3b8f43a` (2026-10-17 02:27 UTC). Observed on the owner's machine: desktop package 26.1007.2314.0 (Windows, Store-signed), engine CLI version 0.162.0-alpha.17.2. |
| Method | Static reading of the public source tree, which was **never built or run**. The vendor's public docs were fetched on 2026-10-16. Read-only inspection of the owner's machine: package manifest, file trees, config **key names only**, and SQLite schemas and row counts, read from copies opened read-only. The credentials file was never opened. Every file:line ref below was re-checked against the clone on 2026-10-17. |
| Evidence refs | `APP3/src/<path>:<lines>`: path relative to the Rust workspace root. Path segments that contain the product, vendor or an internal codename are replaced by a generic token (`engine-`, `vendor_`, `auto-reviewer`). `APP3/repo/<path>`: a file outside the Rust workspace. `APP3/doc/<slug>`: vendor docs. `APP3/bin/<what>`: package or binary inspection. `APP3/obs/<what>`: seen on the owner's machine. The real targets are in the private ref map. |
| Date | 2026-10-16 (research), 2026-10-17 (refs verified) |

### License: Apache-2.0, but clean-room anyway

- The repository is **Apache-2.0** (root `LICENSE`, plus a `NOTICE` file). Reusing it with
  attribution would be legally permissible.
- It vendors bubblewrap C sources under the LGPL. Under `docs/19` §3 those may only be
  linked dynamically, with review.
- **However, `AGENTS.md` §2 ("No proprietary copying") and `docs/19` §1.1 forbid copying
  source, whatever its license.** That covers code, grammars, prompt templates, policy files and
  strings. Everything below describes mechanisms in our own words.
- APP-1's desktop client, which embeds the engine, is closed source. Only its package metadata
  and local file formats were observed.

### Confidence

- **high**: read in the source at the pinned commit with a file:line ref, or documented by the
  vendor and consistent with the source.
- **medium**: from vendor docs only, or observed on the owner's machine without a matching
  source read.
- **low**: an inference. `limits` says so.

## Capability summary

| # | Capability | Evidence records | Nova coverage |
| --- | --- | --- | --- |
| 1 | One engine behind every client; one API ("app-server"); built-in MCP-server mode removed | ER-APP3-001 | `docs/05` §1 "one core, many faces"; FR-125; FR-044 exposes an MCP server, so APP-3 **diverges** |
| 2 | App-server framing, transports, handshake | ER-APP3-002 | `contracts/hub-api.md` §1, §5 (REST + WS/SSE); **diverges** |
| 3 | 175 requests, 87 notifications, 11 server→client requests | ER-APP3-003 | `contracts/hub-api.md` §1, `contracts/events.md`; server→client requests **not covered** |
| 4 | Thread/turn/item data model; generated TS and JSON Schema | ER-APP3-004 | `docs/06` §2 (thread, message, message_part); `contracts/README.md`; partially |
| 5 | Remote-control relay through the vendor backend; local daemon | ER-APP3-005 | `docs/13` §5, `docs/22` §3; FR-077, FR-111, FR-137; **diverges** (not E2E) |
| 6 | Turn loop: no step cap, mid-turn steering, Stop-hook continuation | ER-APP3-006 | `docs/09` §2; FR-019; **diverges** (Nova caps steps) |
| 7 | Compaction (three triggers), context blocks, WebSocket model transport with HTTP fallback | ER-APP3-007 | `docs/09` §11, `docs/07`; partially |
| 8 | "Code mode": one JavaScript tool that calls the real tools inside V8 | ER-APP3-008 | `docs/08` §1; **not covered** |
| 9 | Tool list; freeform patch grammar; deferred tool search | ER-APP3-009 | `docs/08` §1.1, `docs/10` §4; partially |
| 10 | macOS and Linux sandboxes; process hardening | ER-APP3-010 | `docs/11` §2.3, §3; FR-107; covered |
| 11 | Windows: restricted tokens, capability SIDs, OS container mode; **no AppContainer** | ER-APP3-011 | `docs/11` §2.3, `docs/05` §2 say AppContainer; **diverges** |
| 12 | Windows: hidden sandbox users, private desktop, firewall, SYSTEM service | ER-APP3-012 | **not covered** |
| 13 | Permission profiles (FS + network) and protected paths | ER-APP3-013 | `docs/12` §7, `docs/11` §2.3; partially |
| 14 | Approval policies, eight review decisions, sandbox-first escalation | ER-APP3-014 | `docs/10` §3, `docs/12` §4; FR-063, FR-100; **diverges** |
| 15 | Starlark prefix rules with inline tests | ER-APP3-015 | `docs/12` §3 custom rules; FR-084; **diverges** |
| 16 | Network proxy: allowlist, read-only "limited" mode, MITM hooks | ER-APP3-016 | `docs/12` §8, `docs/11` §7; FR-102; partially |
| 17 | AI auto-reviewer: model subagent, strict JSON, fails closed, circuit breaker | ER-APP3-017 | `docs/12` §6; FR-085, FR-095; partially (Nova is far less specific) |
| 18 | Project instruction-file discovery and its 32 KiB budget | ER-APP3-018 | `docs/10` §11; partially |
| 19 | Skills: format, roots, progressive disclosure, catalog budget | ER-APP3-019 | `docs/08` §4; FR-046; partially |
| 20 | Plugins that read other vendors' manifests; marketplaces; MCP client | ER-APP3-020 | `docs/08` §2.1, §3, §7; FR-042, FR-045, FR-049; **diverges** |
| 21 | Lifecycle hooks: 12 events, APP-2-compatible JSON, trust hashes | ER-APP3-021 | FR-117 has extension "event hooks" only; **not covered** |
| 22 | Memories: two-phase offline extraction and consolidation | ER-APP3-022 | `docs/09` §5, `docs/27` §2–3; FR-032, FR-169; **diverges** |
| 23 | Goals (budgets, statuses, blocked-after-3, idle continuation); subagents | ER-APP3-023 | `docs/09` §2, §4; FR-053; goals **not covered** |
| 24 | Import of other agents' setups and sessions | ER-APP3-024 | FR-032 (memory import only); **not covered** |
| 25 | Storage: JSONL rollouts plus six SQLite DBs; config schema | ER-APP3-025 | `docs/06` §2–5, `docs/14` §1; **diverges** |
| 26 | Cloud tasks (best-of-N, apply locally); desktop worktrees, RRULE automations, review pane, WSL | ER-APP3-026 | `docs/10` §5, §9, §12, `docs/09` §6, `docs/13` §3; FR-055, FR-062, FR-071, FR-073; partially |

---

## A. Engine and app-server protocol

```yaml
id: ER-APP3-001
area: architecture / engine and clients
claim: >
  - One Rust workspace holds the agent loop, tools, sandboxes, storage and extensions. Every
    client reaches it through a single API, the "app-server":
    - The terminal UI and the non-interactive exec mode embed an in-process app-server.
    - The IDE extension talks to it over stdio.
    - APP-1's desktop client bundles the engine binary, plus:
      - a Linux build of the engine for use under WSL,
      - a code-mode host,
      - a Windows command runner,
      - a sandbox setup helper,
      - a sandbox service.
      Its UI talks to the engine through a TypeScript client generated from the app-server
      schema.
  - The old "run the engine as an MCP server" mode has been removed: there is no subcommand and
    no crate for it. The vendor docs point users to the app-server instead.
  - Exec mode has a strict stdout contract. By default stdout carries only the final message.
    With a JSON flag it carries JSONL events: thread started; turn started, completed or
    failed; item started, updated or completed. Everything else goes to stderr.
  - SDKs: the TypeScript SDK spawns the CLI and exchanges JSONL over stdio. The Python SDK
    drives the app-server.
  - Features are gated by a staged flag table of 178 specs: 52 stable, 73 under development,
    3 experimental, 4 deprecated, 45 removed.
evidence:
  - type: source
    ref: APP3/src/exec/src/lib.rs:1-4, 17-24
  - type: source
    ref: APP3/src/exec/src/exec_events.rs:11-34
  - type: source
    ref: APP3/src/cli/src/main.rs:148-243
  - type: source
    ref: APP3/src/features/src/lib.rs:1023-2117
  - type: source
    ref: APP3/repo/sdk/typescript/README.md:3
  - type: doc
    ref: APP3/doc/app-server
  - type: doc
    ref: APP3/doc/mcp-server
  - type: doc
    ref: APP3/doc/sdk
  - type: binary
    ref: APP3/bin/desktop-asar-package
  - type: observed
    ref: APP3/obs/desktop-bundled-binaries
confidence: high
limits: >
  The desktop client is closed source. That its UI is a typed app-server client is inferred
  from its build script and workspace package names (low). Flag counts come from a grep of the
  flag table. The Python SDK claim is from docs only.
```

```yaml
id: ER-APP3-002
area: app-server / framing, transports, handshake
claim: >
  - Messages are shaped like JSON-RPC 2.0 but omit the version field. A request carries an id,
    a method, optional params and optional W3C trace context.
  - Transports, chosen by a listen URL:
    - `stdio://` is the default and carries JSONL.
    - `ws://IP:PORT` serves readiness and health endpoints and rejects any request that carries
      an `Origin` header, which blocks browser pages. A listener that is not on loopback must
      use auth: a capability token, or a signed bearer token checked as an HS256 JWT.
    - `unix://` is a control socket in $ENGINE_HOME, mode 0600, that carries the same WebSocket
      protocol.
    - `off` disables the listener.
    - The server can also run in-process, or behind the remote relay (ER-APP3-005).
  - Handshake:
    1. The client sends `initialize` with its name, title and version, plus capabilities: an
       opt-in to experimental methods, a list of notification methods to suppress, attestation
       support, and others.
    2. The server returns its user agent, its home directory, and the platform family and OS.
    3. The client sends an `initialized` notification.
    Experimental methods and fields are rejected unless the client opted in.
  - Errors use the standard JSON-RPC codes, plus -32001 for "overloaded".
evidence:
  - type: source
    ref: APP3/src/app-server-protocol/src/rpc.rs:1-2
  - type: source
    ref: APP3/src/app-server-transport/src/transport/mod.rs:84-169
  - type: source
    ref: APP3/src/app-server-transport/src/transport/websocket.rs:61-64, 89-97, 152
  - type: source
    ref: APP3/src/app-server-transport/src/transport/unix_socket.rs:31
  - type: source
    ref: APP3/src/websocket-auth/src/lib.rs:33-37, 333
  - type: source
    ref: APP3/src/app-server-protocol/src/protocol/v1.rs:29-83
  - type: source
    ref: APP3/src/app-server/src/error_code.rs:7
  - type: doc
    ref: APP3/doc/app-server
confidence: high
limits: Static reading only; no client was connected.
```

```yaml
id: ER-APP3-003
area: app-server / method surface
claim: >
  The protocol has three message families.

  - **175 client-to-server requests**, 67 of them experimental. Groups:
    - thread: start, resume, fork, archive, delete, list, read, search; list turns and items;
      name and metadata; compact; run a shell command; revert; inject items; goal
      set/get/clear; follow-up queue; attachments; background terminals; timeline; realtime
      voice.
    - turn: start, steer, interrupt, settings.
    - review start.
    - projects and sidebar sections.
    - account: login, rate limits, usage.
    - plugins, marketplaces and apps.
    - skills and hooks listing.
    - MCP: OAuth login, reload, status, resource read, tool call.
    - config: read and write.
    - external-agent import (ER-APP3-024).
    - filesystem: read, write, mkdir, stat, readdir, remove, copy, watch.
    - process exec, with stdin, terminate and resize.
    - fuzzy file search.
    - models, feature flags and permission profiles.
    - remote-control pairing and client revocation.
    - environments.
    - Windows sandbox setup and readiness.
    - memory status and reset.
    - a request to approve an action that the AI auto-reviewer denied.
  - **87 server-to-client notifications**:
    - thread lifecycle, token usage, goal updated or cleared;
    - turn started and completed, plus turn diff and plan updates;
    - hook started and completed;
    - item started and completed, with streaming deltas for agent text, reasoning, command
      output, patch updates and MCP progress;
    - auto-review started and completed;
    - a server request resolved;
    - rate limits, MCP startup, remote-control status, import progress, filesystem change,
      skills change, model rerouted.
  - **11 server-to-client requests**, where the server asks the client and waits for the
    answer:
    - command-execution approval, with decisions accept, accept for session, accept and add an
      exec-policy rule, apply a network-policy rule, decline, cancel;
    - file-change approval;
    - permissions approval;
    - tool user-input question;
    - MCP elicitation;
    - a dynamic tool that runs on the client;
    - account token refresh;
    - attestation;
    - current time;
    - two legacy approval requests.
evidence:
  - type: source
    ref: APP3/src/app-server-protocol/src/protocol/common.rs:499-1523 (requests), 1793-1864 (server requests), 1948-2076 (notifications)
  - type: source
    ref: APP3/src/app-server-protocol/src/protocol/v2/item.rs:66-87
confidence: high
limits: >
  Counts come from the macro tables in the protocol crate: 86 named notifications plus one
  unnamed. Behaviour behind each method was not traced.
```

```yaml
id: ER-APP3-004
area: app-server / data model and schemas
claim: >
  - A **thread** has:
    - ids: thread id, session id, the id it was forked from, parent thread id;
    - display fields: preview, name;
    - an ephemeral flag, a project and a sidebar section, a history mode;
    - the provider, model and reasoning effort;
    - cwd, source, originator, git info;
    - the agent's nickname and role;
    - a status: notLoaded, idle, systemError, or active with "waiting on approval" and
      "waiting on user input" flags;
    - its turns.
  - A **turn** ends as completed, interrupted or failed, or is inProgress.
  - **User input** kinds: text, image, local image, audio, local audio, skill, mention.
  - A **thread item** is one of 19 kinds: user message, hook prompt, agent message, function
    call output, plan, reasoning, command execution, file change, MCP tool call, dynamic tool
    call, collaborative-agent tool call, sub-agent activity, web search, image view, sleep,
    image generation, entered review mode, exited review mode, context compaction.
  - **Schemas:** CLI subcommands generate TypeScript types and JSON Schema from precomputed
    exports, optionally including experimental fields. Fixtures for both are checked into the
    protocol crate.
evidence:
  - type: source
    ref: APP3/src/app-server-protocol/src/protocol/v2/thread_data.rs:200-296
  - type: source
    ref: APP3/src/app-server-protocol/src/protocol/v2/thread.rs:1683-1690
  - type: source
    ref: APP3/src/app-server-protocol/src/protocol/v2/turn.rs:33-37, 455-470
  - type: source
    ref: APP3/src/app-server-protocol/src/protocol/v2/item.rs:233-434
  - type: source
    ref: APP3/src/cli/src/main.rs:637-640, 713-728
  - type: source
    ref: APP3/src/app-server-protocol/schema/
confidence: high
limits: none beyond static reading.
```

```yaml
id: ER-APP3-005
area: app-server / remote control and daemon
claim: >
  - **Remote control.** The app-server enrolls with the vendor's backend and holds an
    **outbound** WebSocket to it.
    - JSON-RPC messages travel inside envelopes that carry a client id, a stream id and a
      sequence id.
    - Large messages are split into numbered segments. Acks are cumulative per stream, and
      there is a ping/pong.
    - Pairing uses a code, or a manual code, and QR.
    - The app-server API lists paired clients and can revoke them.
    - Enrollments are stored in the state DB.
  - **Daemon.** CLI subcommands start, restart, update, stop and bootstrap a background
    app-server, and enable or disable remote control on it. The daemon holds a pidfile and
    serves on the Unix control socket.
    - The terminal UI attaches to the daemon if it can, and otherwise starts an embedded
      server.
    - It skips the daemon when $ENGINE_HOME sits on a Windows drive mounted into WSL, because
      that filesystem lacks the needed permission semantics.
    - On Windows the socket path must fit the 108-byte AF_UNIX limit.
evidence:
  - type: source
    ref: APP3/src/app-server-transport/src/transport/remote_control/protocol.rs:65-175
  - type: source
    ref: APP3/src/app-server-daemon/README.md:1-40
  - type: source
    ref: APP3/src/tui/src/daemon_startup.rs:20-33
  - type: source
    ref: APP3/src/tui/src/lib.rs:539-545
  - type: source
    ref: APP3/src/app-server-protocol/src/protocol/common.rs:499-1523 (remoteControl/* group)
  - type: doc
    ref: APP3/doc/remote-connections
confidence: high
limits: >
  The relay runs through the vendor's backend. Whether payloads are end-to-end encrypted is
  not documented and was not determined from the client code (low). The daemon README marks
  its own lifecycle contract as experimental.
```

## B. Agent loop and tools

```yaml
id: ER-APP3-006
area: agent loop / turn contract, steering, Stop-hook continuation
claim: >
  - **Turn contract.** A turn is a loop of sampling requests. Each response either requests
    function calls, which are run and fed back, or is an assistant message, which ends the
    turn. There is **no fixed step cap**: the loop continues while the model needs a follow-up
    or the user has queued input.
  - **Mid-turn steering.** At the top of each iteration the loop drains input the user sent
    while the model was working. The protocol has a turn "steer" request. The desktop client
    has a setting for follow-ups, steer or queue (the owner's is set to steer), and queued
    items persist in their own SQLite DB.
  - **Stop-hook continuation.** When the model would stop, Stop hooks run. A hook can block
    the stop and supply continuation text. The loop records it as a hook-prompt item and runs
    another iteration. Memory-consolidation sessions instead fail if a Stop hook blocks or
    stops them.
evidence:
  - type: source
    ref: APP3/src/core/src/session/turn.rs:152-170 (contract), 452-460 (drain pending input), 604 (follow-up rule), 716-756 (Stop hooks)
  - type: source
    ref: APP3/src/app-server-protocol/src/protocol/common.rs:1055-1059 (turn/start; turn/steer in the same group)
  - type: observed
    ref: APP3/obs/config-keys-windows
confidence: high
limits: Steering is applied between sampling requests, not inside a running tool call.
```

```yaml
id: ER-APP3-007
area: agent loop / compaction, context assembly, model transport
claim: >
  - **Compaction** has three triggers:
    1. Before sampling (pre-turn).
    2. Mid-turn, when the token limit is reached or a new context window is requested and the
       model still needs a follow-up.
    3. After the turn, above a configurable percentage threshold, but only when no input is
       queued.
    Config sets the token limit and its scope, the compact prompt and the threshold. A
    token-budget flag exposes model tools to start a fresh context and to report the context
    left. Each compaction is recorded as a thread item.
  - **Context assembly.** The prompt is assembled with skills and plugins. Injected blocks can
    each be switched off in config: environment context, permission instructions, apps
    instructions, collaboration mode. MCP servers named in @-mentions are required for that
    turn.
  - **Model transport.** Each turn gets a client session that:
    - opens a WebSocket to the provider's responses endpoint lazily and caches it;
    - reuses the previous response id and sends incremental requests;
    - carries a sticky turn-state header for routing;
    - warms the socket with a non-generating request;
    - falls back to HTTP streaming when the socket fails.
    Two base URLs exist: one for subscription sign-in and one for API keys. Local runtimes and
    a hyperscaler-hosted provider are also supported.
evidence:
  - type: source
    ref: APP3/src/core/src/session/turn.rs:186-192, 659-680, 776-790, 1099, 1372, 1507, 1666, 1892
  - type: source
    ref: APP3/src/core/src/client.rs:1-26, 175
  - type: source
    ref: APP3/src/model-provider-info/src/lib.rs:80
  - type: source
    ref: APP3/src/engine-api/src/provider.rs:55
  - type: source
    ref: APP3/src/core/config.schema.json (keys model_auto_compact_token_limit, model_post_turn_compact_threshold_percent, compact_prompt, include_*)
confidence: high
limits: Compaction thresholds are config values; their defaults were not measured.
```

```yaml
id: ER-APP3-008
area: tools / code mode
claim: >
  - In "code mode" the model sees **one** freeform tool, "exec" ("Run JavaScript code."), and
    a companion "wait" tool. It writes JavaScript, and the real tools (shell, patch, MCP, and
    so on) are called as functions from inside that script.
  - The script runs in a separate host process on an embedded V8 engine, built with V8's
    sandbox feature enabled.
  - The tool's input is constrained by a small Lark grammar: an optional pragma line, then
    source.
  - Tool modes are Direct, CodeMode and CodeModeOnly. In CodeModeOnly the direct tools are
    hidden from the model and reachable only through the script.
  - On the owner's machine, every model in the local catalog is set to CodeModeOnly. The
    source still marks the code-mode-only flag as under development.
evidence:
  - type: source
    ref: APP3/src/code-mode-protocol/src/lib.rs:54-55
  - type: source
    ref: APP3/src/core/src/tools/code_mode/execute_spec.rs:5-27, 38-40
  - type: source
    ref: APP3/src/protocol/src/vendor_models.rs:350-354
  - type: source
    ref: APP3/src/core/src/tools/spec_plan.rs:848, 950
  - type: source
    ref: APP3/src/code-mode-runtime/Cargo.toml:26
  - type: source
    ref: APP3/src/features/src/lib.rs:1227-1228
  - type: observed
    ref: APP3/obs/model-catalog-cache
confidence: high
limits: The JavaScript API surface exposed to scripts was not catalogued.
```

```yaml
id: ER-APP3-009
area: tools / list, patch grammar, deferred tool search
claim: >
  - Tools:
    - Shell: `exec_command` takes cmd, workdir, tty, yield time, output-token cap, shell,
      login and environment id, and returns output or a session id for a still-running
      process. `write_stdin` writes to, or polls, that session. Defaults: 10 s yield, 10,000
      output tokens.
    - `apply_patch`.
    - Plan update, image view, a question to the user, a request for more permissions.
    - MCP resource list, template list and read.
    - Subagent tools (ER-APP3-023), and tools that suggest and request a plugin install.
    - Fresh context and context remaining.
    - sleep, current time, wait for environment.
    - Image generation and hosted web search.
    - Dynamic tools that run on the client.
  - **Patch format.** A freeform tool constrained by a Lark grammar:
    - begin and end markers;
    - add, delete and update file hunks;
    - an optional move-to;
    - context lines starting `@@`;
    - an end-of-file marker;
    - an optional environment id.
    The parser is lenient about whitespace around markers.
  - **Tool search.** MCP tools are namespaced and loaded lazily: a search tool runs BM25 over
    the metadata of deferred tools and exposes the matches for the next model call.
evidence:
  - type: source
    ref: APP3/src/core/src/tools/spec_plan.rs:1234, 1268-1284, 1291-1312, 1398-1411, 1571
  - type: source
    ref: APP3/src/core/src/tools/handlers/shell_spec.rs:14-147
  - type: source
    ref: APP3/src/apply-patch/src/parser.rs:1-45
  - type: source
    ref: APP3/src/core/src/tools/handlers/apply_patch_spec.rs:5-24
  - type: source
    ref: APP3/src/core/src/tools/handlers/tool_search_spec.rs:16-94
confidence: high
limits: Which tools are on by default depends on feature flags and model metadata.
```

## C. Sandboxes

```yaml
id: ER-APP3-010
area: sandbox / macOS, Linux, process hardening
claim: >
  - **macOS.**
    - Only `/usr/bin/sandbox-exec` is ever used, so a copy planted earlier on PATH cannot be
      picked up.
    - Policies start from deny-by-default, and readable and writable subpaths are generated at
      runtime.
    - Directories above protected paths cannot be unlinked.
    - XPC service lookups are denied.
    - Network is allowed only to the local proxy ports. If a proxy is expected but not
      configured, network is denied (fails closed).
  - **Linux.**
    - bubblewrap is the default. A bubblewrap on PATH outside the cwd is preferred. Otherwise
      a bundled copy is used after its SHA-256 is checked.
    - New user, PID and IPC namespaces, and a network namespace when network is off.
    - Inside, the process sets no-new-privs and installs seccomp: io_uring is denied, and in
      restricted mode only AF_UNIX sockets may be created.
    - Landlock remains only behind a legacy switch.
    - WSL1 is rejected because it cannot create user namespaces; WSL2 takes the normal path.
    - The helper is reached through an argv[0] alias of the engine binary.
  - **Process hardening** is used only by three helper binaries (a local API proxy, a voice
    host and the Linux sandbox helper), not by the main engine:
    - Linux: not dumpable, no core dumps, `LD_*` stripped.
    - macOS: debugger attach denied, `DYLD_*` stripped.
    - Windows: an empty stub marked TODO.
evidence:
  - type: source
    ref: APP3/src/sandboxing/src/seatbelt.rs:58-62, 358-365, 522, 674, 1065
  - type: source
    ref: APP3/src/sandboxing/src/seatbelt_base_policy.sbpl:8
  - type: source
    ref: APP3/src/linux-sandbox/README.md:8-30
  - type: source
    ref: APP3/src/linux-sandbox/src/bwrap.rs:284-291, 360-366
  - type: source
    ref: APP3/src/linux-sandbox/src/seccomp.rs:131-133, 197-200, 223-267
  - type: source
    ref: APP3/src/linux-sandbox/src/bundled_bwrap.rs:73, 148-152
  - type: source
    ref: APP3/src/arg0/src/lib.rs:61-76
  - type: source
    ref: APP3/src/process-hardening/src/lib.rs:12-24, 46-60, 85, 119-122
  - type: source
    ref: APP3/src/linux-sandbox/Cargo.toml:23
confidence: high
limits: none beyond static reading.
```

```yaml
id: ER-APP3-011
area: sandbox / Windows modes, restricted token, capability SIDs, OS container
claim: >
  - Windows has three modes: **elevated**, **unelevated** and **container**.
  - **Shared mechanism (token).**
    - A restricted token is made from the user's token with "disable max privilege",
      "limited user" and "write-restricted" flags.
    - Its restricting SIDs are, in order: capability SIDs, any extra SIDs, the logon SID,
      Everyone.
    - The token's default DACL is set to the logon SID, so launches that share a capability
      cannot touch each other's processes or IPC. Only the change-notify privilege is kept.
  - **Shared mechanism (capability SIDs).**
    - The SIDs are random, generated once and saved in a file in $ENGINE_HOME. There is one
      for the workspace, one read-only, one per workspace cwd and one per extra writable root.
    - Folder ACLs grant write only to those SIDs.
    - A root's SID goes into the token only while that root is allowed, so stale ACLs left by
      an earlier root cannot widen a later sandbox.
  - **AppContainer is not used.** The container mode explicitly excludes the OS's older
    AppContainer backends.
  - **Container mode.** It hands the command to the OS's native container runner, which needs
    a working "process security environment". It:
    - edits no ACLs, creates no users, needs no setup and never elevates;
    - starts the child suspended inside a kill-on-close job;
    - takes filesystem rules from the same permission profile, including the protected
      paths;
    - allows only loopback network, which reaches the proxy;
    - is strict when selected. A default-off flag prefers it when available. A failed command
      never falls back to another backend.
  - The vendor docs present this as the first Windows-native agent sandbox.
evidence:
  - type: source
    ref: APP3/src/config/src/types.rs:187-191
  - type: source
    ref: APP3/src/windows-sandbox-rs/src/token.rs:468-524
  - type: source
    ref: APP3/src/windows-sandbox-rs/src/cap.rs:15-46
  - type: source
    ref: APP3/src/mxc-sandbox/README.md:1-36
  - type: source
    ref: APP3/src/features/src/lib.rs:1401-1408
  - type: doc
    ref: APP3/doc/windows-sandbox
confidence: high
limits: How container mode and the SYSTEM service share duties when both are enabled was not determined.
```

```yaml
id: ER-APP3-012
area: sandbox / Windows elevated mode and service
claim: >
  - **Hidden users.** Elevated mode provisions two hidden local users, one offline and one
    online, in a dedicated sandbox-users group. Their passwords are stored with DPAPI.
    Provisioning runs once, through UAC, with a setup helper (setup schema version 5).
  - **Firewall.** For the offline user, a broad loopback TCP block is installed first and then
    narrowed to the proxy ports, so a change in mode never fails open.
  - **Launch.** Commands start through a command-runner helper, using a logon-with-credentials
    process API. Each runs on a private desktop with a random name.
  - **Exclusions.** Sensitive folders in the user profile (for example `.ssh`) are excluded
    from sandbox access.
  - **Sandbox service.** A Windows service with its own named-pipe provisioning protocol. The
    desktop package declares it as auto-start under LocalSystem. Package lifecycle code
    refuses to let a user-writable marker authorize deletions as SYSTEM. Uninstall removes the
    sandbox principals. The service is still behind an under-development flag in source.
  - **Observed.** The desktop package opens inbound firewall ports for the engine binary in
    the proxy ranges (ER-APP3-016) and for the login callback.
evidence:
  - type: source
    ref: APP3/src/windows-sandbox-rs/src/setup.rs:52-54
  - type: source
    ref: APP3/src/windows-sandbox-rs/src/winutil.rs:29
  - type: source
    ref: APP3/src/windows-sandbox-rs/src/dpapi.rs:9-39
  - type: source
    ref: APP3/src/windows-sandbox-rs/src/elevated/runner_client.rs:46, 415
  - type: source
    ref: APP3/src/windows-sandbox-rs/src/desktop.rs:67, 315-318
  - type: source
    ref: APP3/src/windows-sandbox-rs/src/setup_provisioning/firewall.rs:47, 90-160
  - type: source
    ref: APP3/src/windows-sandbox-rs/src/provisioning_protocol.rs:14
  - type: source
    ref: APP3/src/windows-sandbox-service/src/package_lifecycle/cleanup.rs:62
  - type: binary
    ref: APP3/bin/desktop-appx-manifest
confidence: high
limits: The service's runtime behaviour was not observed; nothing was executed.
```

## D. Permissions and approvals

```yaml
id: ER-APP3-013
area: permissions / profiles and protected paths
claim: >
  - A legacy sandbox policy has four modes: full access; read-only (network on or off);
    external sandbox; and workspace-write, with writable roots, a network flag and options to
    exclude the temp directories.
  - **Permission profiles** are the newer model:
    - Kinds: managed (filesystem rules plus network policy), disabled, or external (network
      only).
    - Built-in ids: read-only, workspace and full access.
    - Filesystem entries grant read, write or deny on paths or on special tokens: root,
      minimal, project roots (with a subpath), tmpdir, /tmp.
    - Config defines named profiles that can extend each other. Each has filesystem rules and
      a network block: enabled, proxy and SOCKS URLs, mode, domains, Unix sockets, local
      binding, MITM.
  - UI presets: Read Only; Default (approval on request plus workspace-write); Full Access
    (never ask, sandbox disabled).
  - **Protected paths.** Top-level `.git`, `.agents`, the engine's own dot-directory and `.aws`
    stay read-only even inside writable roots.
evidence:
  - type: source
    ref: APP3/src/protocol/src/protocol.rs:1183-1231
  - type: source
    ref: APP3/src/protocol/src/models.rs:413-436
  - type: source
    ref: APP3/src/protocol/src/permissions.rs:40-51, 120-151, 819-830
  - type: source
    ref: APP3/src/config/src/permissions_toml.rs:113-347
  - type: source
    ref: APP3/src/utils/approval-presets/src/lib.rs:28-61
confidence: high
limits: none beyond static reading.
```

```yaml
id: ER-APP3-014
area: approvals / policies, decisions, escalation
claim: >
  - **Approval policies:**
    - untrusted: everything needs approval unless an exec-policy rule allows it.
    - on-request: the model decides when to ask. This is the default; "on-failure" is an
      alias.
    - granular: five switches, for sandbox escalation, exec-policy prompts, skill scripts,
      permission requests and MCP elicitations. A switch set to false **auto-rejects** that
      kind of prompt instead of showing it.
    - never: failures go straight back to the model.
  - **Eight review decisions:**
    - approved;
    - approved and add an exec-policy rule;
    - approved for the session (cached);
    - approved and amend the MCP tool policy across sessions;
    - persist a network allow or deny rule for the host;
    - denied, with a rejection text, after which the agent continues;
    - timed out, for an automatic review;
    - abort, which stops until the user's next message.
  - **Order.** Permission-request hooks decide first. Then the AI auto-reviewer decides, if it
    is enabled. Otherwise the user decides.
  - **Escalation.** Commands run sandboxed first. A run that the sandbox denies is retried
    without the sandbox **only** under "untrusted", or under "granular" with sandbox
    escalation enabled. Under on-request and never, a sandbox denial goes back to the model.
  - **Observed.** On the owner's machine, 7 of 8 threads used on-request. One used granular,
    allowing only permission requests and MCP elicitations.
evidence:
  - type: source
    ref: APP3/src/protocol/src/protocol.rs:1097-1137, 4267-4302
  - type: source
    ref: APP3/src/core/src/tools/approvals.rs:483-485
  - type: source
    ref: APP3/src/core/src/tools/sandboxing.rs:344-351
  - type: source
    ref: APP3/src/core/src/tools/orchestrator.rs:439-441
  - type: observed
    ref: APP3/obs/thread-metadata
confidence: high
limits: none beyond static reading.
```

```yaml
id: ER-APP3-015
area: approvals / exec-policy prefix rules
claim: >
  - **Rule language.** Command policy is written in Starlark.
    - A prefix rule has a token pattern, in which an element may be a list of alternatives,
      and a decision: allow (the default), prompt or forbidden.
    - It can carry a justification, shown in prompts or rejections. For forbidden rules this
      should name an alternative.
    - It carries match and not-match examples, which are checked when the rules load, like
      unit tests.
    - A host-executable declaration limits which absolute paths may match a bare command
      name.
  - **Loading.** Rules load from a rules directory in each config layer. A user's "approve
    and remember" appends to a default rules file.
  - **Effect.** When every parsed part of a command matches allow, the command skips approval
    **and runs outside the sandbox**.
  - **Heuristics.** There is no list of "known safe" commands. The built-in heuristic catches
    forced `rm`, seen through sudo, env and trap wrappers, and on Windows, forced deletes and
    a few GUI or URL launches.
evidence:
  - type: source
    ref: APP3/src/execpolicy/README.md:1-60
  - type: source
    ref: APP3/src/core/src/exec_policy.rs:56, 442-450
  - type: source
    ref: APP3/src/shell-command/src/command_safety/is_dangerous_command.rs:28-33, 132-160
  - type: source
    ref: APP3/src/shell-command/src/command_safety/windows_dangerous_commands.rs:7-225
confidence: high
limits: none beyond static reading.
```

```yaml
id: ER-APP3-016
area: network / filtering proxy
claim: >
  - **Listeners.** A local HTTP proxy, by default on loopback port 3128, and a SOCKS5 proxy on
    8081. On Windows they prefer ports 3128-3159 and 8081-8112. Sandboxes allow traffic only
    to these ports.
  - **Policy:**
    - Requests are blocked until at least one domain is allowed. The global `*` wildcard is
      rejected. Deny entries always win.
    - Private, loopback and link-local destinations are blocked unless local binding is
      allowed. Even then, a hostname that resolves to a private address stays blocked.
    - A blocked request gets a 403 with an error header naming the cause: allowlist,
      denylist, method or policy.
  - **"Limited" mode** allows only GET, HEAD and OPTIONS. HTTPS is intercepted (MITM) to
    enforce this; HTTPS that cannot be intercepted is blocked.
  - **MITM hooks** match host, method and path prefix, and apply named actions. The example
    strips the authorization header from writes to a code host. The CA private key stays in
    memory; child processes get CA-bundle variables that point at public files.
  - **Decider.** A policy hook can turn an allowlist miss into an allow, for example for a
    command the user already approved, but it can never override a deny.
  - **Audit.** Every decision emits a structured audit event.
evidence:
  - type: source
    ref: APP3/src/network-proxy/README.md:1-90, 135-148, 180-215, 246-257
confidence: high
limits: From the crate's README, which matches the config types; enforcement code was not traced.
```

```yaml
id: ER-APP3-017
area: approvals / AI auto-reviewer
claim: >
  - **Enabling it.** Turning on the "auto review" approvals reviewer sends approval requests
    to a model subagent, not the user.
  - **Locked down.** The reviewer runs in a read-only sandbox with approval policy "never" and
    non-essential features off. It does **not** inherit exec-policy rules, though it may reuse
    the parent's network allowlist for read-only checks.
  - **Sessions.** Reviews append to one cached reviewer conversation, to keep the prompt cache
    warm. When that conversation is busy, a review runs in an ephemeral fork.
  - **Strict JSON output:**
    - outcome: allow or deny (required);
    - risk level: low, medium, high or critical;
    - user authorization: unknown, low, medium or high;
    - rationale.
  - **Fails closed:**
    - 90 s timeout, up to 3 attempts.
    - A missing or unparseable assessment, a timeout, or an error ends as **Denied**.
    - A valid denial is not retried.
  - **Circuit breaker.** The turn is interrupted after 3 consecutive denials, or 10 denials
    among the last 50 reviews. For the cyber-model policy the limit is 1.
  - **Override.** The client can ask to approve an action the reviewer denied.
  - **Observed.** The local model catalog contains a hidden model dedicated to auto-review.
evidence:
  - type: source
    ref: APP3/src/core/src/auto-reviewer/review.rs:168-181
  - type: source
    ref: APP3/src/ext/auto-reviewer/src/lib.rs:40-41
  - type: source
    ref: APP3/src/ext/auto-reviewer/src/assessment.rs:11-98
  - type: source
    ref: APP3/src/ext/auto-reviewer/src/outcome.rs:9-30
  - type: source
    ref: APP3/src/ext/auto-reviewer/src/circuit_breaker.rs:3-7, 54-85
  - type: source
    ref: APP3/src/core/src/auto-reviewer/tests.rs:3254-3400
  - type: observed
    ref: APP3/obs/model-catalog-cache
confidence: high
limits: The reviewer's policy prompt was not analysed, and should not be copied.
```

## E. Instructions, skills, plugins, hooks

```yaml
id: ER-APP3-018
area: context / project instruction-file discovery
claim: >
  - **Global.** In $ENGINE_HOME an override instruction file is read first, then the default
    file. The first non-empty one wins.
  - **Project:**
    - The project root is found by walking up from the cwd to the nearest root marker
      (default `.git`). An empty marker list disables the walk.
    - Every directory from the root down to the cwd is checked. In each, the first hit wins,
      in this order: an override file, the default instruction file (`AGENTS.md`), then
      configured fallback names. Fallback names are validated as plain filenames, because
      resolving a Windows network path can leak credentials.
  - **Safeguards.**
    - Project-level config cannot change the root markers.
    - Untrusted projects are skipped.
  - **Budget.** All files share one byte budget, 32 KiB by default. A file that overflows it
    is truncated with a warning.
  - **Injection.** Each file is wrapped in a heading that names its directory plus an
    instructions block. Subagents inherit them.
evidence:
  - type: source
    ref: APP3/src/engine-home/src/instructions/mod.rs:12-13
  - type: source
    ref: APP3/src/core/src/agents_md.rs:1-18, 64-92, 142-178, 195-214, 272-296
  - type: source
    ref: APP3/src/config/src/config_toml.rs:75
  - type: source
    ref: APP3/src/core/src/context/user_instructions.rs:29-38
confidence: high
limits: none beyond static reading.
```

```yaml
id: ER-APP3-019
area: skills / format, roots, progressive disclosure
claim: >
  - **Format.** A skill is a `SKILL.md` with YAML frontmatter.
    - `description` is required.
    - `name` is optional, defaults to the directory name and is capped at 64 characters.
    - A short description is optional.
    - The parser tolerates unquoted colons in descriptions, as third-party skills often have
      them.
    - An optional vendor-specific YAML file in the skill adds UI metadata, tool dependencies
      and an "allow implicit invocation" policy.
  - **Discovery roots and precedence:**
    - `.agents/skills` from the repo root down to the cwd (Repo);
    - a user skills folder, with a deprecated one in $ENGINE_HOME (User);
    - embedded system skills (System);
    - an admin folder (Admin);
    - plugin roots, namespaced `plugin:skill`.
    Repo beats User beats System beats Admin.
  - **Progressive disclosure.** Only a catalog (name, description, path) is injected, in a
    skills-instructions block. Its budget is 2% of the context window, at most 10,000 tokens,
    or 8,000 characters when no window is known. Mentioning a skill explicitly injects the
    full `SKILL.md`.
  - **Docs.** The vendor docs say the format follows an open agent-skills standard.
evidence:
  - type: source
    ref: APP3/src/skills/src/parser.rs:4-71
  - type: source
    ref: APP3/src/ext/skills/src/render.rs:19-22, 134
  - type: source
    ref: APP3/src/ext/skills/src/host_roots.rs:48-186
  - type: doc
    ref: APP3/doc/build-skills
confidence: high
limits: Mention syntax and the full-body injection path were taken from the teardown, not re-read.
```

```yaml
id: ER-APP3-020
area: extensions / plugins, marketplaces, MCP client
claim: >
  - **Plugin manifests.** The engine looks for a manifest in this order:
    1. A root `plugin.json` declaring the open "Agent Plugins v1" schema.
    2. The engine's own manifest directory.
    3. **APP-2's vendor's plugin manifest directory.**
    4. **A third-party IDE's plugin manifest directory.**
  - **Plugin contents.** A plugin can carry skills, MCP servers, app connectors, hooks and UI
    metadata. Legacy `commands/` are converted into skills.
  - **Marketplaces** are read from the engine's `.agents/plugins/` file or from **the other two
    vendors' marketplace files**.
    - Plugin sources: local, url, git-subdir, npm.
    - Per-plugin policies: not available, available, installed by default.
  - **Install.** Plugins install into a versioned cache under $ENGINE_HOME. Each is enabled per
    `name@marketplace` and can set per-MCP-server tool policy. Docs: one plugin directory is
    shared with APP-1.
  - **Observed.** The owner's config subscribes to APP-2's vendor's official plugin marketplace
    by git URL.
  - **MCP client:**
    - Transports: stdio and streamable HTTP.
    - Per-server settings: command, args, env, url, bearer-token env var, headers, startup and
      tool timeouts, enabled, required, enabled and disabled tools, default tool approval
      mode, OAuth.
    - OAuth tokens go to the OS keyring, with a file fallback.
  - **Observed: a third-party installer edited the config.** Screenpipe's installer added
    itself to the engine's config as an MCP server, keeping a backup and a lock file, and
    added 23 skills.
evidence:
  - type: source
    ref: APP3/src/utils/plugins/src/plugin_namespace.rs:3-9, 43-79
  - type: source
    ref: APP3/src/exec-server-protocol/src/protocol.rs:52-56
  - type: source
    ref: APP3/src/core-plugins/src/loader.rs:70-75
  - type: source
    ref: APP3/src/core-plugins/src/manifest.rs:78, 182-186
  - type: source
    ref: APP3/src/core-plugins/src/marketplace.rs:20-25, 168-173, 1050-1062
  - type: source
    ref: APP3/src/config/src/mcp_types.rs:365-642
  - type: source
    ref: APP3/src/rmcp-client/src/oauth.rs:15-17, 100
  - type: doc
    ref: APP3/doc/plugins
  - type: observed
    ref: APP3/obs/config-keys-windows
  - type: observed
    ref: APP3/obs/home-tree
confidence: high
limits: The plugin directory shared with APP-1 is from docs only.
```

```yaml
id: ER-APP3-021
area: extensions / lifecycle hooks
claim: >
  - **Events (12):** PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact,
    SessionStart, SessionEnd, UserPromptSubmit, SubagentStart, SubagentStop, Stop, Interrupt.
    Matchers apply to 9 of them.
  - **Format.** The same JSON shape that APP-2's coding agent uses: event, then matcher
    groups, then handlers. It is read from a hooks file or from config, and plugins can
    carry their own.
  - **Handler types:**
    - `command`: has an optional Windows variant, a timeout, an async flag and a status
      message. Extra context it returns is spilled to disk above 2,500 tokens.
    - `mcp_tool`: calls a tool on an MCP server.
    - `prompt` and `agent`: parsed, but skipped as unsupported.
  - **Trust.** Each hook must be trusted by hash. Config stores a trusted hash, plus a separate
    content hash for plugin hooks. Plugin hooks get an environment variable named after
    APP-2's plugin-root variable, for compatibility.
  - **Effects.** Hooks decide permission requests before the auto-reviewer (ER-APP3-014), and
    Stop hooks can force a continuation (ER-APP3-006).
evidence:
  - type: source
    ref: APP3/src/hooks/src/lib.rs:24-56
  - type: source
    ref: APP3/src/config/src/hook_config.rs:25-36, 163-204
  - type: source
    ref: APP3/src/hooks/src/engine/discovery.rs:633, 676-686
  - type: doc
    ref: APP3/doc/hooks
confidence: high
limits: The plugin-root environment variable comes from docs only.
```

## F. Memory, goals, subagents, import

```yaml
id: ER-APP3-022
area: memory / two-phase extraction and consolidation
claim: >
  The pipeline runs in the background in two phases.

  - **Phase 1, per thread.**
    - It claims a bounded batch of eligible rollouts. A rollout is eligible if it comes from
      an allowed interactive source, falls inside the age window, has been idle long enough
      and is not claimed by another worker.
    - It filters each rollout to memory-relevant items and asks a model, in parallel with a
      cap, for three structured fields: a detailed raw memory, a compact summary and a slug.
    - Secrets are redacted, and results are stored in the memories DB.
  - **Phase 2, global.**
    - It takes a single global lock and selects the top N phase-1 outputs.
    - It syncs them into a memories folder that is a git repository. A git-style diff since
      the last good baseline gives the consolidator its "what changed" view.
    - It spawns a consolidation subagent, which writes `MEMORY.md`, `memory_summary.md` and
      `skills/`.
    - It resets the baseline on success.
  - **Read path.** `memory_summary.md`, at most 2,500 tokens, goes into developer
    instructions. Optional tools add an ad-hoc note, list, read and search.
  - **Extension folders.** Under the memories folder, other producers can write their own
    files. APP-1's on-device activity-history feature writes there; see APP-1's file.
  - **Default.** The docs say memories are off by default.
evidence:
  - type: source
    ref: APP3/src/memories/README.md:38-152
  - type: source
    ref: APP3/src/ext/memories/src/lib.rs:16-23
  - type: doc
    ref: APP3/doc/memories
  - type: observed
    ref: APP3/obs/sqlite-schemas-counts
confidence: high
limits: >
  On the owner's machine the memory tables were empty (0 jobs, 0 phase-1 outputs), so the
  pipeline was not seen working. N and the age window were not determined.
```

```yaml
id: ER-APP3-023
area: long-running work / goals and subagents
claim: >
  - **Goal tools:** get, create (an objective and an optional token budget), update status.
    - The objective is capped at 4,000 characters.
    - A config key caps the token budget.
  - **Goal statuses:** active, paused, blocked, usage-limited, budget-limited, complete.
    - The model may set **blocked** only after the same blocker has recurred for 3
      consecutive goal turns, counting automatic continuations. A resumed goal starts a fresh
      count.
    - It may set **paused** only on the user's explicit request.
    - Budget-limited and usage-limited are set by the system, never by the model.
  - **Idle continuation.** When a thread goes idle with an active goal, the runtime starts a
    new turn itself, using a continuation template and a "goal" turn trigger.
  - **Storage and API.** Goals live in their own SQLite DB, and the protocol has goal
    set/get/clear plus update notifications.
  - **Subagent tools:**
    - v1: spawn, send input, wait, resume, close.
    - v2: spawn, send message, follow-up task, wait, list, interrupt.
  - **Subagent defaults:**
    - at most 6 threads and depth 1;
    - v2: 4 concurrent per session;
    - wait: 30 s by default, 10 s minimum, 1 h maximum.
  - **Roles and links.** Built-in roles plus TOML role files. Children report back through a
    notification block. Parent-child links are stored as spawn edges.
evidence:
  - type: source
    ref: APP3/src/ext/goal/src/spec.rs:9-89
  - type: source
    ref: APP3/src/ext/goal/src/runtime.rs:436-505
  - type: source
    ref: APP3/src/ext/goal/templates/goals/continuation.md
  - type: source
    ref: APP3/src/protocol/src/protocol.rs:4216
  - type: source
    ref: APP3/src/state/migrations/0033_thread_goal_stopped_statuses.sql:1-20
  - type: source
    ref: APP3/src/config/src/config_toml.rs:753
  - type: source
    ref: APP3/src/core/src/config/mod.rs:256-266
  - type: source
    ref: APP3/src/core/src/tools/handlers/multi_agents_spec.rs:92-370
  - type: source
    ref: APP3/src/state/migrations/0021_thread_spawn_edges.sql:1
  - type: doc
    ref: APP3/doc/long-running-work
confidence: high
limits: The blocked-after-3 rule is an instruction in the tool description, not a runtime check (inferred, medium).
```

```yaml
id: ER-APP3-024
area: import / other agents' setups and sessions
claim: >
  - **Open-source importer.** It reads the setup of APP-2's coding agent (its home
    dot-directory, project instruction file and settings) and of a third-party IDE.
  - **Item types (10):** config, skills, instruction files, plugins, MCP servers, subagents,
    hooks, commands, memory, sessions.
  - **Mappings:**
    - the other agent's instruction file becomes the engine's, with terms rewritten;
    - subagent Markdown files become TOML roles;
    - commands become skills.
  - **Dedupe and history.** Imported sessions are deduplicated by SHA-256 in a ledger file in
    $ENGINE_HOME, and import history goes to a state-DB table.
  - **Desktop-only importer.** APP-1's desktop client also imports from **APP-2's VM-sandboxed
    agent mode**, using a closed-source package. The open tree has no reference to it.
  - **Docs:**
    - desktop sources: APP-2's coding agent, APP-2's agent mode and the third-party IDE;
    - CLI sources: the first and last only, up to 50 chats;
    - mapped: chats from the last 30 days, projects and project memories;
    - auto-sync can be turned on under Settings.
  - **Observed:**
    - 34 plugins (214 skills) and 5 sessions were imported.
    - Each plugin got a shim manifest next to its original, plus a generated marketplace file.
    - The imported sessions hold message items only.
evidence:
  - type: source
    ref: APP3/src/external-agent-migration/src/model.rs:53-64
  - type: source
    ref: APP3/src/external-agent-migration/src/sessions/ledger.rs:16
  - type: source
    ref: APP3/src/external-agent-migration/src/source/src-a.rs
  - type: source
    ref: APP3/src/external-agent-migration/src/source/src-b.rs
  - type: doc
    ref: APP3/doc/import
  - type: binary
    ref: APP3/bin/desktop-asar-package
  - type: observed
    ref: APP3/obs/import-ledgers
  - type: observed
    ref: APP3/obs/plugin-cache-tree
confidence: high
limits: The desktop importer's mapping rules come from docs only (medium). Auto-sync cadence is undocumented.
```

## G. Storage, config, cloud and desktop

```yaml
id: ER-APP3-025
area: storage / rollouts, SQLite, config
claim: >
  - **Rollouts.** Every turn appends records to a JSONL rollout file per thread, in date
    folders under $ENGINE_HOME. Record types:
    - session meta, response item, inter-agent communication;
    - compaction, turn context, token usage;
    - world state, security risk score, retained context;
    - event message, realtime item.
  - **SQLite.** Six DBs. Their filenames carry a schema version, and an environment variable
    can move them:
    - state: threads, projects, sections, imports, remote-control enrollments, dynamic tools,
      spawn edges; 61 migrations;
    - thread history: a paginated projection of rollouts into turns and items;
    - logs;
    - goals;
    - memories;
    - queue.
  - **Desktop DB.** APP-1's desktop client keeps its own SQLite DB with automations,
    automation runs, an inbox, and a thread catalog whose host kinds include local, SSH, WSL,
    remote control and APP-1 chats.
  - **Observed counts:**
    - state DB: 8 threads, 59 migrations applied;
    - thread history: 362 turns, 9,673 items;
    - rollouts: 9,677 response items, 10,414 event messages.
  - **Config.** The config schema has 103 top-level keys and 198 definitions:
    - models and providers;
    - sandbox, approval policy, approvals reviewer, permission profiles;
    - MCP servers, plugins, marketplaces, skills, hooks;
    - memories, goals, agents;
    - an opaque `desktop` table owned by the desktop client;
    - profiles.
    Config is layered (user, project, system/admin). Project layers are restricted
    (ER-APP3-018).
evidence:
  - type: source
    ref: APP3/src/history/src/lib.rs:212-230
  - type: source
    ref: APP3/src/rollout/src/rollout_file_name.rs:67
  - type: source
    ref: APP3/src/state/src/sqlite.rs:41-46
  - type: source
    ref: APP3/src/state/src/lib.rs:141
  - type: source
    ref: APP3/src/state/migrations/
  - type: source
    ref: APP3/src/core/config.schema.json
  - type: observed
    ref: APP3/obs/sqlite-schemas-counts
  - type: observed
    ref: APP3/obs/desktop-db-schema
  - type: observed
    ref: APP3/obs/rollout-record-types
confidence: high
limits: Desktop DB tables are from the schema only; all automation and inbox tables were empty.
```

```yaml
id: ER-APP3-026
area: cloud and desktop coding mode / best-of-N, worktrees, automations, review, WSL
claim: >
  - **Cloud tasks (CLI client):**
    - Operations: list, summary, diff, messages, text; list sibling attempts (best-of-N);
      apply preflight; apply, which runs a local `git apply`.
    - Creating a task takes an environment, a prompt, a git ref, a QA flag and N.
    - Docs: reusable cloud environments are built from a filesystem, an install script and a
      start skill. Each task gets an isolated workspace that keeps running while the user's
      computer sleeps. A secrets proxy works only with port-443 allowlists.
    - The legacy cloud keeps agent internet off by default. API-key users get no cloud.
  - **Worktrees (desktop coding mode, docs):**
    - Local and Worktree modes, with handoff between them.
    - A `.worktreeinclude` file copies chosen untracked files into new worktrees.
    - The app keeps 15 worktrees.
  - **Automations:**
    - Scheduled tasks use RRULE and run locally or in a background worktree. Event triggers
      exist on the web only.
    - The observed desktop DB defaults to a daily hourly-interval RRULE of kind "cron".
  - **Review, terminal and remote:**
    - A review pane with per-hunk stage and revert, and a PR sidebar.
    - Review mode is also a protocol request and a pair of thread items.
    - An integrated terminal.
    - SSH projects, host-to-host handoff and a phone remote.
  - **WSL.** On the owner's Windows machine the desktop client runs the engine **inside WSL**:
    - the config sets "run in WSL" and a WSL terminal shell;
    - the Linux engine build is copied to a hash-named folder in $ENGINE_HOME;
    - WSL thread records point at rollouts on the Windows drive.
evidence:
  - type: source
    ref: APP3/src/cloud-tasks-client/src/api.rs:136-176
  - type: doc
    ref: APP3/doc/cloud-environments
  - type: doc
    ref: APP3/doc/cloud-internet-access
  - type: doc
    ref: APP3/doc/git-worktrees
  - type: doc
    ref: APP3/doc/automations
  - type: doc
    ref: APP3/doc/code-review
  - type: doc
    ref: APP3/doc/remote-connections
  - type: observed
    ref: APP3/obs/desktop-db-schema
  - type: observed
    ref: APP3/obs/config-keys-windows
  - type: observed
    ref: APP3/obs/home-tree
confidence: medium
limits: >
  The cloud client is source-read (high). Desktop features are from docs plus the local schema
  (medium). The WSL split is inferred from config keys and stored paths (low).
```

---

## Divergences from the current spec (inputs for RECONCILIATION.md, not decisions)

| Nova doc today | Finding | Evidence |
| --- | --- | --- |
| `docs/10` §3, `docs/12` §2: one ladder of five permission modes (Manual … Bypass), FR-063 | Two independent axes: an approval policy (untrusted / on-request / granular / never) × a permission profile (filesystem rules + network). Plus "run sandboxed first, escalate only on denial", and granular switches that auto-reject | ER-APP3-013, 014 |
| `docs/12` §4, FR-100: Allow once / Always (scoped) / Deny / Hand off | Eight decisions. "Always" is split into session cache, exec-policy rule, MCP-policy amendment and network rule. Denied lets the agent continue; Abort stops it. A timeout is its own decision | ER-APP3-014 |
| `docs/12` §2–3: the policy engine evaluates every tool call; custom rules are JSON matchers | The OS sandbox is the main boundary and approvals arise on escalation. Command rules are Starlark prefix rules with load-time example tests, and an all-allow match runs **outside** the sandbox | ER-APP3-014, 015 |
| `docs/12` §6, FR-085: auto-review is "classifier + rules" | A full model subagent in a read-only sandbox without inherited rules. Strict JSON verdict; fails closed on timeout or bad output; 3 attempts; a circuit breaker interrupts the turn after repeated denials; the user can override a denial | ER-APP3-017 |
| `docs/11` §2.3, `docs/05` §2, FR-107: Windows uses AppContainer / Job Objects | AppContainer is avoided on purpose. Instead: restricted write-restricted tokens with random per-root capability SIDs, hidden offline/online users, a private desktop, firewall rules that never fail open, a LocalSystem provisioning service, and an optional OS container runner | ER-APP3-011, 012 |
| `docs/12` §8, `docs/11` §7: an egress proxy with allowlist, DNS pinning and header stripping | Adds a read-only "limited" mode (GET/HEAD/OPTIONS enforced through MITM), MITM hooks that strip credentials on matched requests, SOCKS5, an exec-approval-to-network decider that can never override deny, and blocking of hostnames that resolve to private addresses | ER-APP3-016 |
| `docs/09` §2: executor bounded by `max_steps = 60` and 60 min wall clock | No step cap per turn. Long work is bounded by **goals** with token budgets, system-set budget/usage-limited states, a "blocked only after 3 recurrences" rule, and idle continuation that starts turns automatically | ER-APP3-006, 023 |
| `docs/09` §6, FR-055: scheduler with cron/interval + timezone | Desktop automations use RRULE and can run in a background worktree; event triggers are web-only. Goal continuation is a separate, idle-driven mechanism | ER-APP3-023, 026 |
| `docs/09` §11: one compaction trigger at 80% of the limit | Three triggers (pre-sampling, mid-turn on limit, post-turn threshold), model-callable "new context" and "context remaining" tools, and compaction recorded as a thread item | ER-APP3-007 |
| `docs/09` §5, `docs/27` §2: extraction after each turn, embedding dedupe, `memory_item` rows | An offline two-phase pipeline over idle rollouts into git-baselined Markdown files written by a consolidation subagent. The injected summary is capped at 2,500 tokens, and other producers can write extension folders | ER-APP3-022 |
| `docs/27` §3, FR-170: L1 skills are proposed and the user approves | Memory consolidation writes a `skills/` folder automatically | ER-APP3-022 |
| `contracts/hub-api.md` §1: REST + WS/SSE; `contracts/events.md` | A bidirectional JSON-RPC-style protocol in which the server sends requests to the client (approvals, user input, client-side tools, token refresh). Generated TS and JSON Schema; experimental-capability opt-in; per-client notification opt-out; Origin rejection on WebSocket | ER-APP3-002, 003, 004 |
| `docs/06` §2: thread / message / message_part | A thread / turn / item model with 19 typed item kinds, including hook prompts, review-mode markers, sub-agent activity and compaction | ER-APP3-004 |
| `docs/13` §5, `docs/22` §3, FR-111, FR-137: phone dispatch through a content-blind E2E relay | Remote control relays JSON-RPC through the vendor's backend, with pairing codes or QR, segmenting and acks, and client list/revoke. E2E encryption is not documented. A local daemon serves on a 0600 Unix socket | ER-APP3-005 |
| `docs/08` §1.1: JSON-Schema tools called directly | Code mode: the model writes JavaScript against one tool, and nested tools run inside a sandboxed V8 host. Patches are a freeform grammar tool. MCP tools are deferred behind BM25 tool search | ER-APP3-008, 009 |
| FR-044, `docs/08` §2.2: Nova exposes its own MCP server | APP-3 removed its MCP-server mode in favour of the app-server API | ER-APP3-001 |
| `docs/08` §3.1: Nova's own plugin manifest only | Reads the open Agent Plugins v1 schema, its own manifest, **and two other vendors' manifest and marketplace formats**. Commands are migrated to skills | ER-APP3-020 |
| `docs/08` §4: skills with `when_to_use` and `allowed_tools` | `description` required, `name` optional. A catalog-only injection capped at 2% of the context (≤10k tokens); explicit mention loads the body; Repo > User > System > Admin precedence | ER-APP3-019 |
| Only FR-117 extension "event hooks" | 12 lifecycle hook events that can block tool use, decide permission requests and force continuation. APP-2-compatible JSON; every hook trusted by hash | ER-APP3-021 |
| `docs/10` §11: reads AGENTS.md, a project instruction file and `.nova/instructions.md` | Hierarchical root-to-cwd discovery with override files, validated fallback names, a 32 KiB shared budget, untrusted projects skipped, and root markers that a repo cannot change | ER-APP3-018 |
| FR-032: memory import only | Imports config, skills, instruction files, plugins, MCP servers, subagents, hooks, commands, memory and sessions from APP-2 and a third-party IDE, with SHA-256 dedupe and auto-sync | ER-APP3-024 |
| `docs/11` §2.3: project root RW, everything else RO/denied | `.git`, `.agents`, the agent's own dot-directory and `.aws` stay read-only **inside** writable roots | ER-APP3-013 |
| `docs/06` §3: one `nova.db` | JSONL rollouts are the source of truth, with six versioned SQLite DBs, including a paginated history projection | ER-APP3-025 |
| `docs/09` §4: sub-agent concurrency 4 | 6 threads, depth 1; v2 allows 4 concurrent per session, with bounded waits | ER-APP3-023 |
| `docs/10` §9, §12, FR-071, FR-073: worktrees under `<repo>/.nova/worktrees`; cloud sessions | Worktrees in the engine's home, 15 kept, `.worktreeinclude`, Local↔Worktree handoff. Cloud tasks support best-of-N attempts and apply locally with `git apply` | ER-APP3-026 |
