# Reconciliation of External Findings

Phase 0 output (`PROMPT.md` §2). Every capability listed in the five findings files is
classified against the spec as it stood before this pass (commit `73c9370`):

| Decision | Meaning |
| --- | --- |
| **Keep** | Already well specified; the finding adds nothing material. |
| **Modify** | Partly covered; useful detail merged into the existing doc and FRs. |
| **Add** | Not covered; new requirements and docs added. |
| **Replace** | The finding is the better design; the old section is superseded by an ADR. |
| **Reject** | Not appropriate for Nova; the reason is recorded. |

Conflict precedence (`PROMPT.md` §2.5): Nova's hard invariants win (hub-and-spoke, policy
engine and permissions, security model, self-improvement guardrails). Otherwise the
better-specified version is adopted and an ADR records the choice.

New requirements are `FR-181` to `FR-233` in `docs/03`. New decisions are `ADR-056` to
`ADR-082` in `docs/20`. All rows were written in vendor-neutral language; reference apps
appear only by opaque ID.

## Summary

| Source | Capabilities | Keep | Modify | Add | Replace | Reject |
| --- | --- | --- | --- | --- | --- | --- |
| APP-1 (`app1-findings.md`) | 23 | 3 | 12 | 7 | 1 | 0 |
| APP-2 (`app2-findings.md`) | 35 | 10 | 16 | 5 | 2 | 2 |
| APP-3 (`app3-findings.md`) | 26 | 1 | 13 | 7 | 4 | 1 |
| APP-4 (`app4-findings.md`) | 21 | 4 | 8 | 4 | 2 | 3 |
| Ambient capture (`screenpipe-findings.md`) | 36 | 2 | 13 | 7 | 2 | 12 |
| **Total** | **141** | **20** | **62** | **30** | **11** | **18** |

A row whose decision has two parts (for example "Modify + Add") is counted under its first
decision.

What changed, in short:

- **Kept.** The hub-and-spoke model, `novad` as the only privileged device endpoint, the
  content-blind end-to-end-encrypted Relay, one canonical SQLite database, one agent
  runtime and one policy engine for every mode, and Nova's stricter memory and telemetry
  defaults. Every reference app routes remote control through vendor relays with no
  end-to-end claim; Nova does not follow them there.
- **Modified.** Approvals gained a richer decision set. Permission modes became presets
  over an approval policy and a permission profile. The egress proxy gained read-only and
  credential-stripping modes. Memory gained background consolidation, project-only scope
  and a separate chat-history toggle. Schedules gained RRULE and a bounded catch-up. Code
  mode gained worktree include files, leases, and hook-free app-run Git operations.
  Managed policy now reads OS-native channels.
- **Added.** Goals with budgets, lifecycle hooks, MCP event subscriptions, MCP bundles,
  deferred tool search, interactive exec sessions, confirmation tiers with intent
  provenance, an external-agent rule, computer-use control tiers, window capture, dictation,
  document outputs, deep research, model presets, import from other assistants,
  persistence safety evals, and, for ambient capture, a redaction release gate, a capture
  split between device and Hub, an activity summary and scoped data grants.
- **Replaced.** The fixed 60-step cap (now budgets plus a hard backstop), the vague
  auto-review (now a specified fail-closed reviewer), Windows AppContainer sandboxing (now
  restricted tokens), environment-variable injection of network credentials (now injection
  at the egress proxy), the Nova-specific plugin UI bridge (now the open MCP Apps standard),
  the single-file skill format (now the open folder format), the single cross-channel
  thread (now per-channel threads with shared agent memory), the 15-minute schedule grace
  window, and the frame-rate, OCR-only ambient capture design.
- **Rejected.** Vendor-run relays without end-to-end encryption, separately embedded coding
  engines, telemetry on by default, a vendor AI gateway, plan sign-in that reuses another
  vendor's OAuth client, keystroke logging, raw SQL for agents, cookie export from the
  user's browsers, auto-registration into other apps' configs, unsigned silent installs,
  paywall gates, a one-agent-per-user limit, and hidden agent notes.

---

## APP-1 — chat assistant product

| # | External finding | Current coverage | Decision | Rationale | Resulting change |
| --- | --- | --- | --- | --- | --- |
| 1 | One desktop client with chat, delegated-work and coding modes; import from other assistants (ER-APP1-001) | `docs/04` §1, FR-002; INV-B15, FR-032 (memory import only) | Keep + Add | Nova already has four modes on one core. Importing instructions, skills, plugins, MCP servers and projects lowers switching cost. | FR-200 (import). |
| 2 | Chromium-based runtime with bundled engine, plugins and skills (ER-APP1-002, 003) | ADR-001, ADR-006, ADR-031, `docs/15` | Keep | The Hub-served web UI plus a thin native shell and a separately launched automation browser already covers this. A custom Chromium embedding layer adds no user-visible value. | None. |
| 3 | Delegated work: cloud coordination with local execution; no switch from local to cloud mid-turn; local-only hooks do not run under remote coordination (ER-APP1-004) | `docs/21` §3, FR-051..060, FR-081, FR-106, FR-127 | Modify | Same split as Nova (the Hub coordinates, devices execute). The mid-turn rule prevents a turn that is half local and half remote. | `docs/21` §4: execution location is fixed for a turn and may change only between turns; hooks run where the turn executes. FR-127 updated. |
| 4 | Phone or second PC remote-controls a desktop host via QR pairing and a relay; a chat can be handed off with its Git state (ER-APP1-005) | FR-077, FR-111, FR-132, `docs/13` §5, `docs/22` §3 | Modify + Add | In the hub model every client already drives every session. Handing a session to another device with its Git state is missing. | FR-213 (session handoff). `docs/13` §5 updated. |
| 5 | Saved memories, a separate chat-history reference control, temporary chats (ER-APP1-006) | FR-027, FR-032 | Modify | Nova has saved memory and temporary chats but no separate control for drawing on past chats. | FR-205 (chat-history reference toggle with 30-day purge). |
| 6 | Background memory synthesis with an editable, categorized summary page and time-aware updates (ER-APP1-007) | FR-032, FR-169, `docs/27` §2 | Add | Per-turn extraction alone accumulates stale facts. Consolidation keeps memory current and lets users steer topics. | FR-204 (consolidation and summary page). |
| 7 | Project-only memory scope, forced for shared projects (ER-APP1-008) | INV-C08, `docs/06` `memory_item.scope_kind` (no FR) | Add | Keeps project context from leaking into personal memory and the reverse. | FR-205; `docs/06` adds `project.memory_scope`. |
| 8 | Ambient activity history from accessibility events, summarized server-side, 48 h raw retention, unencrypted local Markdown output (ER-APP1-009, 010) | `docs/24`, FR-151..155 | Modify | Accessibility-first text and short raw retention are adopted. Server-side summarization is rejected (local-first, `docs/24` §2), and so is unencrypted output (`docs/24` §2.5). | `docs/24` rewritten; FR-151, FR-152, FR-154 revised. |
| 9 | Global "window snapshot" hotkey attaches a screenshot plus the window's accessibility text to a chat (ER-APP1-011) | FR-075 (P2, Code mode only) | Add | User-initiated context capture is useful in every mode and is far less sensitive than continuous capture. | FR-214 (attach window). |
| 10 | Quick-chat overlay listing threads as Running / Needs input / Ready / Blocked (ER-APP1-012) | FR-008 (P2), FR-012 | Modify + Add | A shared status vocabulary is needed everywhere threads appear, not only in an overlay. | FR-215 (thread status model); FR-008 updated to show it. |
| 11 | Full-duplex voice that starts, checks and steers tasks; one voice session at a time; dictation (ER-APP1-013) | FR-031, INV-B12 | Modify + Add | Voice as a controller is a natural extension of FR-031; dictation is a separate, simpler need. | FR-031 revised; FR-216 (dictation). |
| 12 | Plugin directory: skills, MCP servers, optional UI and lifecycle hooks (ER-APP1-014) | FR-045, FR-049, FR-165, ADR-013 | Modify | Hooks were the missing component. | FR-045 revised; FR-197 (hooks). |
| 13 | Plugin UI follows the open MCP Apps standard: `ui://` HTML resources, JSON-RPC over `postMessage`, CSP domain lists, inline / fullscreen / picture-in-picture, global / thread / file entry points (ER-APP1-015) | `docs/08` §3.1, `docs/14` §4.1–4.2, FR-045, FR-117 | Replace | An open standard is the better design: servers written once render in Nova, and the sandbox properties (isolated iframe, typed bridge, no host DOM) are the same. | FR-198; ADR-066; `docs/08` §3.1 and `docs/14` §4.2 rewritten. |
| 14 | MCP event triggers: `events/list`, `events/subscribe` with a webhook and secret, refresh, unsubscribe; signed deliveries under 256 KiB (ER-APP1-016) | FR-056, FR-158, `docs/09` §7 | Add | A standard push mechanism replaces per-connector polling. | FR-201 (MCP event subscriptions). |
| 15 | In-app browser, user-browser extension and cloud browser; per-site Always ask / Auto approve / Always allow; extension grants per host with "all sites" flagged as elevated risk; separate developer-protocol mode (ER-APP1-017) | FR-086, FR-092, FR-094, FR-096 | Modify | Three explicit per-site levels and per-host extension grants are clearer than Allow once / Always / Deny alone. | FR-094 and FR-096 revised; `docs/11` §4 updated. |
| 16 | Pages register their own tools for the agent (top frame only, every call reviewed, results untrusted) (ER-APP1-018) | None | Add (P2) | Page-declared tools are less brittle than DOM automation. All calls stay policy-gated and untrusted. | FR-208. |
| 17 | Computer use on macOS and Windows; a recorded demonstration becomes a skill (ER-APP1-019) | FR-093, FR-170, FR-178 | Modify + Add | Control tiers are added under FR-207; recording a demonstration is a new path into L1 skill proposals. | FR-207; FR-226 (record a demonstration, P2). |
| 18 | Three confirmation tiers (hand off, confirm at action time, pre-approvable); typed instructions count as intent, pasted or third-party content never does (ER-APP1-020) | FR-058, FR-099, FR-100, `docs/12` §2–4 | Modify | Sharpens built-in safety into testable classes and gives taint tracking a concrete rule. | FR-189; ADR-062; `docs/12` §2 updated. |
| 19 | Scheduled tasks, app-event triggers, long-running goals, team tasks on a service account, per-plan task caps (ER-APP1-021) | FR-055, FR-056, FR-091 | Modify + Add | Goals are added. Team tasks map to specialist agents with their own identity. Plan caps are rejected: Nova is self-hosted and has no paywalls. | FR-181 (goals); FR-091 revised. |
| 20 | Group chats for up to 20 people with personal memory excluded; shared space; hosted sites using each visitor's connected apps; deep-research worker (ER-APP1-022) | FR-029, FR-036, FR-037, FR-053 | Add + Reject | Shared threads (P2) and a deep-research run are added. Sites that act on each visitor's connected apps are rejected: multi-tenant hosting is out of scope (`docs/00` §4). | FR-217 (shared threads, P2); FR-220 (deep research). |
| 21 | One "power" preset control hides model, effort and speed; the top tier spawns subagents (ER-APP1-023) | FR-023, FR-024, `docs/07` §6, §8 | Modify | A simple preset control suits most users. Automatic subagents tied to an effort level are rejected; delegation stays explicit and visible. | FR-221 (model presets). |
| 22 | 2026 retirements: nightly briefing replaced by user-scheduled tasks, side-by-side editor replaced by inline blocks (ER-APP1-024) | FR-038, FR-082 | Keep | Context only. It supports delivering proactive output through schedules the user controls; the artifacts pane stays. | None. |
| 23 | Hosted agents API on the same harness; "sign in with" plan reuse for third-party apps (ER-APP1-025) | INV-D07 (no FR) | Add (P2) | Third-party apps can use the Hub API with scoped, revocable tokens. Reusing a vendor plan is not Nova's to offer. | FR-222 (third-party app authorization). |

## APP-2 — desktop assistant with a VM-sandboxed agent mode

| # | External finding | Current coverage | Decision | Rationale | Resulting change |
| --- | --- | --- | --- | --- | --- |
| 1 | Desktop shell loads the hosted web app; window and worker inventory (ER-APP2-001, 002) | `docs/05` §2, ADR-001, FR-125 | Keep | Same thin-shell model as Nova. | None. |
| 2 | One native addon in the app process carries input synthesis, audio capture and OS APIs (ER-APP2-003, 004) | `docs/23` §4 (screen/input in a `novad` module) | Reject (placement) | Privileged OS control belongs in signed, sandboxed `novad` modules, not in the UI process (least privilege, `docs/05` §9). | None. |
| 3 | Crash reporting, remote feature flags, admin-configurable OTLP export (ER-APP2-005) | FR-105, FR-118, ADR-019, ADR-028 | Modify | Remote flags are rejected (they phone home). Opt-in OTLP export to a collector the user names is useful for self-hosters. | FR-223 (opt-in OTLP export). |
| 4 | Windows MSIX with a packaged LocalSystem VM service (ER-APP2-006, 007) | `docs/15` §1 | Modify | MSIX becomes an optional format; it must not move the data directory (row 35). | `docs/15` §1; FR-225. |
| 5 | Updates roughly every 4 h; engine builds downloaded separately (ER-APP2-008) | FR-120, `docs/15` §4 | Keep | Nova's signed, staged, rollback-capable updates are already stronger. Only the check cadence is specified. | `docs/15` §4: update check every 6 h by default, metadata only. |
| 6 | Child processes grouped in a Windows Job object (ER-APP2-009) | `docs/05` §3, §9 | Modify | Kill-on-close job objects stop orphaned children. | `docs/05` §9 and `docs/11` §3 updated. |
| 7 | Chat and agent mode merge into one mode; the model chooses quick answer or long task (ER-APP2-010) | FR-002 | Modify | The four modes stay as surfaces, but a chat request that needs multi-step work can become a Work run inline. | FR-186; ADR-077. |
| 8 | Agent loop on the host or in the cloud; cloud sandbox with mandatory egress proxy and short-lived tokens (ER-APP2-011..013) | `docs/11` §2.1, FR-080, FR-108 | Keep | The Hub runs the loop and execution happens on nodes or sandboxes; cloud computers already restrict egress. | None. |
| 9 | Device bridge: the desktop app serves shell, directory listing, folder-access requests, staged-then-committed writes, artifacts, project memory and local MCP pass-through to cloud sessions (ER-APP2-014) | `docs/21` §8, `docs/23`, FR-081, FR-126, FR-141 | Modify | `novad` stays the device endpoint. Staged writes, folder-access requests and local MCP pass-through are adopted as `novad` operations. | FR-210; `docs/23` §4; `contracts/hub-api.md` §4. |
| 10 | Per-session Linux micro-VM on every desktop OS, direct kernel boot, SHA-versioned images (ER-APP2-015..017) | `docs/11` §2.2 ("optional VM"), FR-107 | Modify | Stronger isolation at a cost in disk and memory. Added as a flagged substrate; the OS sandbox remains the default. | FR-195; ADR-065. |
| 11 | Only connected folders are shared; config, credential locations and shell-startup files stay blocked even when a whole drive is shared (ER-APP2-018) | `docs/11` §2.2, §9 | Modify | A hard-blocked path list closes the "share the whole drive" hole. | FR-190 (protected paths); FR-195. |
| 12 | User-mode network stack; a proxy injects the auth token so it never enters the guest; per-session allowlist defaulting to package registries; IPv6 off (ER-APP2-019, 021) | `docs/11` §3, §7; `docs/12` §5, §8; FR-102 | Replace (credential injection) | Injecting network credentials at the proxy is the better design: a compromised sandbox never holds the token. | FR-193; ADR-063. |
| 13 | VM isolation claims; if the VM fails, shell reports "unavailable" while file and web tools continue (ER-APP2-020) | `docs/11` §10 | Keep | Nova already fails closed with a read-only degraded mode. | None. |
| 14 | The coding tab drives a separate, per-version, hash-verified CLI agent through an SDK (ER-APP2-022) | `docs/09` §1, `docs/10` §1 | Reject | Nova keeps one runtime and one policy engine for every mode. A second embedded engine would bypass both. | ADR-076. |
| 15 | Environments include a "remote-control machine" and saved environments; SSH installs a helper on the remote host and talks over a forwarded 0600 socket (ER-APP2-023, 024) | FR-062, FR-078, `docs/10` §2 | Modify | Any device running `novad` is an environment. Over SSH, Nova installs the `novad` helper the same way. | FR-062 revised; `docs/10` §2. |
| 16 | Worktrees with an include file for ignored files and a lease field; app-run Git operations skip repo hooks; CLI-to-desktop handoff (ER-APP2-025..027) | FR-073, `docs/10` §8–9 | Modify + Add | Include files and leases are practical. Repo hooks are untrusted code, so Git operations Nova runs for itself must not execute them. | FR-073 revised; FR-211; CLI handoff noted in `docs/10` §15 (P2). |
| 17 | Remote control over outbound polling with short-lived scoped credentials (ER-APP2-028) | `docs/22` §3, FR-137 | Keep | The Relay already uses outbound connections only, and is end-to-end encrypted. | None (ADR-071). |
| 18 | A persistent phone-to-desktop thread spawns child sessions; computer-use grants there expire after 30 min (ER-APP2-029) | FR-054, FR-077, FR-111 | Modify | Nova's always-on agents already cover the persistent thread. Time-boxed grants are adopted. | FR-207 (grant TTL); FR-059 revised. |
| 19 | Local routines checked every minute; one catch-up run covers misses from the last 7 days (ER-APP2-030) | FR-055, `docs/09` §6, §12 | Replace (catch-up) | One catch-up run over a bounded window, told which window it covers, is more predictable than a 15-minute grace. | FR-055 revised; ADR-079. |
| 20 | Computer use: per-app tiers (browsers view-only, terminals and IDEs click-only, others full), per-app grants, Esc kill switch, edge overlays; computer use last in tool precedence (ER-APP2-031, 032) | FR-093, FR-098, `docs/11` §5 | Add | Tiers per app class limit damage from a misclick or an injected instruction. | FR-207. |
| 21 | Teach mode and "record a skill" from a demonstration (ER-APP2-033) | FR-170, FR-178 | Add (P2) | Same as APP-1 row 17. | FR-226. |
| 22 | Built-in browser pane, domain policies, `$BROWSER` shim to the session pane (ER-APP2-034) | FR-067, FR-096, `docs/10` §7 | Keep | Covered. | None. |
| 23 | Browser-extension bridge through a native-messaging host and a vendor relay; agent tabs in the user's real profile (ER-APP2-035) | FR-096, `docs/11` §4.3 | Modify | The native-messaging host talks only to the local `novad`; no vendor relay. Per-tab consent and a visible indicator stay. | `docs/11` §4.3. |
| 24 | Global-hotkey capture window for region or window capture, plus dictation, started by the user (ER-APP2-036) | FR-008 (P2) | Add | Same need as APP-1 rows 9 and 11. | FR-214; FR-216. |
| 25 | Voice assets bundled; audio capture via the native addon (ER-APP2-037) | FR-031 | Keep | Covered. | None. |
| 26 | Memory shared between chat and agent mode, categorized and editable; project memory (ER-APP2-038, 039) | FR-032, FR-034, FR-089 | Keep | Covered; project scope is handled by FR-205. | None. |
| 27 | Artifacts, design, slides and docs in any chat; chart, grid and diagram libraries (ER-APP2-040) | FR-036, FR-038, FR-076 | Modify | Office-format outputs are a common need. | FR-219 (document outputs); FR-038 revised. |
| 28 | MCP stdio config; handshake advertises the MCP UI extension (ER-APP2-041, 042) | FR-042, `docs/08` §2 | Modify | Nova advertises the UI extension and names supported protocol versions. | FR-042 revised; FR-198. |
| 29 | Single-server MCP bundles with typed user config, sensitive values in the keychain; unsigned bundles load on standard deployments (ER-APP2-043, 044) | FR-045, FR-167, FR-168 | Add + Reject | Bundles are adopted. Silent unsigned installs are rejected: unsigned bundles need an explicit sideload confirmation. | FR-199. |
| 30 | Remote connectors added by URL with OAuth client-ID metadata documents or dynamic client registration; built-in servers; per-tool toggles (ER-APP2-045..047) | FR-042, FR-047, FR-048 | Modify | Standard MCP OAuth registration is adopted. | FR-047 revised. |
| 31 | Account-level skills sync to the desktop every 20 min; plugins install from Git marketplaces or a zip (ER-APP2-048, 049) | FR-045, FR-046, FR-049, `docs/13` §2.1 | Modify | The Hub is canonical, so clients never need a sync loop. Git-hosted catalogs are adopted. | FR-049 revised. |
| 32 | Managed policy from the registry, a configuration profile or an `/etc` file, with no signature; keys for MCP, local sessions, SSH hosts, folders, built-in tools, browser domains, egress, telemetry export, inference routing and retention (ER-APP2-050) | FR-106, `docs/12` §10 | Modify | OS-protected channels are trusted by their OS ACLs; remotely delivered policy still needs a signature. The key set is extended. | FR-106 revised; ADR-078. |
| 33 | Storage layout: a roaming folder with per-session JSON records (ER-APP2-051..055) | `docs/06`, `docs/15` §5 | Keep | One database plus content-addressed blobs is simpler to back up, export and audit. | None. |
| 34 | Security model: OAuth token caches in config, remembered SSH passwords and MCP env secrets in plain-text JSON; signed packages and hash-verified engine builds (ER-APP2-056..059) | FR-063, FR-101, FR-107, FR-120, FR-133 | Keep + Modify | Nova's rule (secrets only in the keychain) is stricter and stays. Imported configs that carry secrets are migrated into the keychain. | FR-200 (secret migration on import). |
| 35 | Per-user AppData virtualization shadowed externally written MCP config and broke the local VM on the owner's machine (ER-APP2-060..062) | `docs/15` §1, §5 | Add | The lesson: resolve data directories explicitly and never depend on per-user filesystem virtualization. | FR-225; `docs/15` §5. |

## APP-3 — open-source coding-agent engine

| # | External finding | Current coverage | Decision | Rationale | Resulting change |
| --- | --- | --- | --- | --- | --- |
| 1 | One engine behind every client through one API; the engine's MCP-server mode was removed (ER-APP3-001) | `docs/05` §1, FR-125, FR-044 | Keep | Nova keeps its consented MCP server for interop with other tools, now with per-client scoped tokens. | FR-192 (per-client tokens). |
| 2 | JSON-RPC-style framing over stdio, WebSocket (rejects any `Origin` header) or a 0600 Unix socket; capability handshake (ER-APP3-002) | `contracts/hub-api.md` §1, §5 | Modify | REST plus WebSocket/SSE stays (browser clients need it). The handshake capability negotiation, Origin checks and a 0600 local socket are adopted. | `contracts/hub-api.md` §1, §5, §7; ADR-072. |
| 3 | 175 requests, 87 notifications and 11 server-to-client requests (approvals, user input, client-side tools, token refresh) (ER-APP3-003) | `contracts/hub-api.md`, `contracts/events.md` | Add | Server-to-client requests let a client answer an approval or a question over the stream it already holds. | FR-188; `contracts/hub-api.md` §5. |
| 4 | Thread / turn / item model with 19 item kinds; generated TS types and JSON Schema (ER-APP3-004) | `docs/06` §2 | Modify | A `turn` grouping makes interruption, steering and resume state explicit. Generated schemas already exist in `contracts/README.md`. | `docs/06` adds `turn` and item kinds; `contracts/events.md`. |
| 5 | Remote control relayed through the vendor backend: envelopes with client, stream and sequence ids, segmenting, cumulative acks, pairing by code or QR, list and revoke paired clients (ER-APP3-005) | `docs/13` §5, `docs/22` §3, FR-137 | Modify | The framing is adopted, inside Nova's end-to-end sealed envelopes. A relay that can read content is not. | FR-137 revised; ADR-071. |
| 6 | No step cap per turn; mid-turn steering drained at the top of each iteration; Stop hooks can force a continuation (ER-APP3-006) | `docs/09` §2, FR-019 | Replace + Modify + Add | A fixed 60-step cap stops legitimate long work. Budgets plus a hard backstop keep runs bounded (an invariant) without that failure. | FR-182; FR-019 revised; FR-197 (Stop hooks); ADR-058. |
| 7 | Three compaction triggers (pre-turn, mid-turn on limit, post-turn threshold); model tools for "context remaining" and "new context"; compaction recorded as an item; WebSocket model transport with HTTP fallback (ER-APP3-007) | `docs/09` §11, `docs/07` | Modify | One 80 % trigger misses the mid-turn case. Socket transports are an adapter detail. | FR-183; `docs/07` §9. |
| 8 | "Code mode": the model writes JavaScript against one tool, and real tools run as functions inside a sandboxed V8 host (ER-APP3-008) | `docs/08` §1 | Add (P2) | Could cut tokens and round trips for local models. Every nested call must still pass the policy engine. Flagged. | FR-202. |
| 9 | Tools: exec with a yield time and a session id for still-running processes, stdin writes; a freeform patch grammar; BM25 search over deferred MCP tools (ER-APP3-009) | `docs/08` §1.1, `docs/10` §4 | Modify + Add | Interactive exec and deferred tool loading fit small context windows. The patch format is specified in Nova's own words. | FR-184; FR-196; `docs/08` §1.3 patch format. |
| 10 | macOS and Linux sandboxes: absolute sandbox binary path, deny-by-default profiles, network only to proxy ports, fail closed when no proxy; seccomp, no-new-privs; hardening of helper processes (ER-APP3-010) | `docs/11` §2.3, §3, FR-107 | Modify | Concrete hardening steps make FR-107 testable. | `docs/11` §3; FR-141 revised (process hardening). |
| 11 | Windows: restricted write-restricted tokens with random per-root capability SIDs, an OS container mode; AppContainer deliberately avoided (ER-APP3-011) | `docs/11` §2.3, `docs/05` §2, FR-107 | Replace | Better specified and proven for developer tooling, where AppContainer breaks common tools. | FR-107 revised; ADR-064. |
| 12 | Windows elevated mode: hidden sandbox users, private desktop, firewall rules that never fail open, a LocalSystem provisioning service (ER-APP3-012) | None | Add | Completes the Windows design in row 11. | `docs/11` §2.4 under FR-107. |
| 13 | Permission profiles (filesystem rules plus network block); `.git`, the agent's own folder and credential folders stay read-only inside writable roots (ER-APP3-013) | `docs/12` §7, `docs/11` §2.3 | Add | Protected paths stop an agent from rewriting history, its own config or credentials while editing a project. | FR-190. |
| 14 | Approval policies (untrusted / on-request / granular / never), eight review decisions, sandbox first with escalation on denial (ER-APP3-014) | `docs/10` §3, `docs/12` §4, FR-063, FR-100 | Modify | Escalation is adopted only as a policy `ask`; Nova never retries unsandboxed on its own. The decision set is expanded. | FR-063, FR-100 revised; ADR-059, ADR-060. |
| 15 | Command prefix rules with match and not-match examples tested at load; an all-allow match runs outside the sandbox (ER-APP3-015) | `docs/12` §3, FR-084 | Modify + Reject | Prefix rules with load-time examples are adopted in JSON (no new language). Running outside the sandbox is rejected (sandbox invariant). | FR-191. |
| 16 | Network proxy: allowlist with deny winning, read-only "limited" mode via MITM, credential-stripping hooks, SOCKS5, private-address blocking after DNS, 403 with a cause header, structured audit (ER-APP3-016) | `docs/12` §8, `docs/11` §7, FR-102 | Modify | Each item tightens egress control. | FR-193; FR-102 revised. |
| 17 | Auto-reviewer: a model subagent in a read-only sandbox without inherited allow rules; strict JSON verdict; fails closed on timeout or bad output; circuit breaker; user can override (ER-APP3-017) | `docs/12` §6, FR-085, FR-095 | Replace | A specified, fail-closed reviewer is testable; "classifier plus rules" was not. | FR-085 revised and moved to M5; ADR-061. |
| 18 | Instruction files discovered from the project root down to the cwd, override files, a 32 KiB shared budget, untrusted projects skipped, root markers a repo cannot change (ER-APP3-018) | `docs/10` §11 | Modify | Deterministic discovery and a budget keep context predictable. | FR-185. |
| 19 | Skills: a folder with `SKILL.md`, `description` required; only a catalog is injected (≤ 2 % of context, ≤ 10k tokens); an explicit mention loads the body; precedence by root (ER-APP3-019) | `docs/08` §4, FR-046 | Replace (format) | The open folder format is interoperable, and catalog-only injection suits local models. | FR-046 revised; ADR-067. |
| 20 | Plugins read the open plugin schema and two other vendors' manifest and marketplace formats; MCP client settings; OAuth tokens in the keyring (ER-APP3-020) | `docs/08`, FR-042, FR-045, FR-049 | Modify + Reject | Conversion through an explicit import is adopted. Silently loading other vendors' formats is rejected (permissions must be declared in Nova's manifest). | FR-200; FR-042 revised. |
| 21 | Twelve lifecycle hook events; command and MCP-tool handlers; every hook trusted by hash; hooks can block tools and force continuation (ER-APP3-021) | FR-117 (extension event hooks only) | Add | Hooks are added with one constraint: they can tighten a policy decision, never loosen built-in safety or managed policy. | FR-197; ADR-068. |
| 22 | Two-phase memory: per-thread extraction over idle sessions, then global consolidation into summary files; the consolidator also writes skills (ER-APP3-022) | `docs/09` §5, `docs/27` §2–3, FR-032, FR-169 | Modify + Reject | Background consolidation is adopted. Automatic skill writes are rejected: L1 skills need approval (guardrail). | FR-204; ADR-069. |
| 23 | Goals with token budgets and statuses; blocked only after the same blocker recurs 3 times; idle continuation; subagent limits (6 threads, depth 1, 4 concurrent, bounded waits) (ER-APP3-023) | `docs/09` §2, §4, FR-053 | Add + Modify | Goals give long work a visible, budgeted contract. Subagent defaults are adopted. | FR-181; `docs/09` §4. |
| 24 | Import of other agents' config, skills, instruction files, plugins, MCP servers, subagents, hooks, commands, memory and sessions, deduplicated by SHA-256 (ER-APP3-024) | FR-032 | Add | Same as APP-1 row 1. | FR-200. |
| 25 | JSONL rollouts as the source of truth plus six versioned SQLite databases (ER-APP3-025) | `docs/06` §2–5 | Reject | One canonical database is easier to back up, sync, export and audit on a small Hub. | None. |
| 26 | Cloud tasks with best-of-N attempts applied locally; worktree handoff and a cap; RRULE schedules; review pane; WSL execution (ER-APP3-026) | FR-055, FR-062, FR-071, FR-073 | Modify + Add | RRULE and worktree handoff are adopted; best-of-N is added as P2. | FR-055, FR-073 revised; FR-212. |

## APP-4 — always-on agent with its own computer

| # | External finding | Current coverage | Decision | Rationale | Resulting change |
| --- | --- | --- | --- | --- | --- |
| 1 | Persistent, named agent; one primary agent per user (ER-APP4-001) | FR-079, `docs/06` `agent` | Keep | Nova sets no per-account limit. | None. |
| 2 | Its own persistent cloud computer and browser; take over and return control; private sign-in (ER-APP4-002) | FR-080, FR-086, FR-087 | Keep | Covered. | None. |
| 3 | One connected personal computer; the desktop client must stay open; local browser as a fallback when sites block the cloud browser; a separate grant; a client version floor (ER-APP4-003) | FR-081 | Modify | `novad` runs as a service, so nothing needs to stay open. The browser fallback, the per-agent grant and a version floor are adopted. | FR-081 revised; FR-209; FR-148 revised. |
| 4 | A local executor registers outbound with the backend through a relay (ER-APP4-004, 005) | `docs/23` §2, §9; `docs/22` §3 | Keep | `novad` with mTLS and the end-to-end Relay already covers this. | None. |
| 5 | Delegation to subagents, delegated-work tasks and coding tasks (cloud, local, or continuing threads); editing the work mode's schedules (ER-APP4-006) | FR-053, FR-059, FR-083 | Modify | FR-059 covered only Work to Code. | FR-059 revised (any runtime delegates to Work or Code; agents manage schedules under policy). |
| 6 | A time budget, combined with reasoning effort, guides how long the agent works (ER-APP4-007) | `docs/09` §2, FR-024 | Replace | Same conclusion as APP-3 row 6. | FR-182; ADR-058. |
| 7 | Self-paced wake-ups; saved schedules; event triggers only for plugins that declare event support (ER-APP4-008) | FR-055, FR-056 | Add + Modify | Agents may schedule their own next wake-up, visibly and within bounds. Triggers come only from sources that declare events; joining a channel does not make the agent watch it. | FR-206; FR-056 revised. |
| 8 | Read-only proactive research when idle; findings go to private notes and come back as suggestions (ER-APP4-009) | FR-082, `docs/09` §8 | Modify | Idle-driven research with an hourly cap is cheaper than a fixed hourly run. | FR-082 revised. |
| 9 | Three-layer memory; every channel reaches the same agent and notes, but each channel keeps its own history (ER-APP4-010) | FR-088, FR-089, `docs/13` §4 | Replace | Per-channel threads stop a private DM's content from surfacing in a shared channel. Shared agent memory keeps continuity. | FR-088 revised; ADR-070. |
| 10 | Notes reportedly not viewable or editable; switching off host memory does not remove copies (ER-APP4-011) | FR-032, FR-089 | Reject | Nova is stricter: notes are viewable and editable, and turning memory off purges derived copies. | FR-089 revised (purge on off). |
| 11 | Channels include voice calls; agent-initiated calls planned; texting "coming soon" (ER-APP4-012) | FR-088, FR-110, FR-031 | Add (P2) | A voice-call channel is useful; agent-initiated calls are deferred. | FR-218. |
| 12 | Plugins also carry browser extensions and hooks; permissions per action, for example read but not send (ER-APP4-013) | FR-045, FR-048 | Modify | Per-action permissions inside a plugin are already per-tool defaults; the manifest lists the new components. | FR-045 revised. |
| 13 | Safety stack order: built-in safeguards, then plugin permissions, then auto-review, then the user's custom rules (ER-APP4-014) | `docs/12` §2, FR-084, FR-099 | Reject (order) | Nova's deterministic evaluation stays authoritative. The reviewer runs after it and can only tighten a decision (invariant). | ADR-061. |
| 14 | A separate reviewer model with an agent-specific policy; on an unsafe verdict it blocks and tells the agent to avoid similar actions; limits on engaging agents outside the vendor's ecosystem (ER-APP4-015) | FR-085, FR-103 | Modify + Add | The reviewer contract is merged into FR-085. A rule about outside agents is added. | FR-085 revised; FR-194. |
| 15 | Activity view; pause stops only the main task; delete is irreversible; per-capability admin switches; role-specific agents; teams planned (ER-APP4-016) | FR-090, FR-091, FR-106 | Modify | Nova's pause covers child work too (stricter). Admin switches per agent capability are added to managed policy. | FR-090 revised; FR-106 revised. |
| 16 | Prompt-injection evals: bulk and iterative email attacks, manual red-teaming (ER-APP4-017) | FR-123, `docs/16` §5 | Modify | The security suite gains iterative attacker evals. | FR-224. |
| 17 | Persistence evals: permission changes mid-task, scope drift over chained tasks, misleading proactive inputs (ER-APP4-018) | None | Add | Always-on agents need tests that one-shot suites do not cover. | FR-224. |
| 18 | Behaviour across time budgets, monitor evasion, misuse safeguards (ER-APP4-019) | None | Add | Same as row 17. | FR-224. |
| 19 | Pricing, regions, data use, no public API (ER-APP4-020) | FR-105, FR-116 | Reject | Not applicable: Nova is self-hosted and never trains on user data. | None. |
| 20 | Look-alike clones and fake "official download" repositories (ER-APP4-021) | FR-133, `docs/15` §3 | Modify | Signing already exists. A documented way to verify an official download is added. | FR-225; `docs/15` §3. |
| 21 | No continuous screen or audio capture (ER-APP4-022) | `docs/24`, FR-151 | Keep | Nova's opt-in ambient track stays. | None. |

## Ambient capture (`screenpipe-findings.md`, ER-SP-*)

| # | External finding | Current coverage | Decision | Rationale | Resulting change |
| --- | --- | --- | --- | --- | --- |
| 1 | Event-driven capture on UI events with a 30 s idle heartbeat; fixed-rate capture retired (ER-SP-001..004) | `docs/24` §3 ("1 frame / 2 s") | Replace | Event-driven capture records what changed for a fraction of the cost. | FR-151 revised; ADR-073; `docs/24` §3. |
| 2 | Accessibility-tree text first; OCR only when the tree is thin, empty, a terminal buffer or a canvas app (ER-SP-005..007) | `docs/24` §3 (OCR only) | Replace | Tree text is exact, cheap and carries structure; OCR fills the gaps. | FR-152 revised. |
| 3 | Per-OS frame grabbing and OCR engines; OCR on a crop of the focused window, cached by region hash (ER-SP-008, 009) | `docs/24` §3 | Modify | Specific engines and the crop-and-cache rule are adopted. | `docs/24` §3. |
| 4 | Three separate dedup decisions: whether to capture, whether to store, whether to OCR (ER-SP-010) | `docs/24` §3 ("keyframe dedupe") | Modify | Separating the three decisions avoids losing scroll changes while saving work. | `docs/24` §3. |
| 5 | One JPEG per capture, later packed into video; a text-only mode (ER-SP-011) | `docs/24` §4 | Modify | Text-only is the default for the first phase; pixels are optional and go to a configured location. | `docs/24` §4; FR-228. |
| 6 | Privacy filters: app/title patterns, URL rules on domain boundaries, allowlist mode, built-in exclusions, password fields never read, incognito detection, DRM pause, work-hours schedule, malformed rules fail closed (ER-SP-012..015) | `docs/24` §7, FR-154 | Modify | Concrete, testable exclusion rules. Gaps found in the target (row ER-SP-014) become test cases. | FR-154 revised; `docs/24` §7. |
| 7 | Release gate: reads see only rows certified by model-based redaction; regex alone cannot certify; policy changes revoke certification (ER-SP-016, 017) | `docs/24` §7 ("redaction pass") | Add | Mechanical enforcement beats a best-effort pass (`docs/12` §1: zero trust). | FR-227. |
| 8 | Audio: 30 s chunks persisted before transcription, VAD, local STT with hallucination and echo defences, cross-device dedup (ER-SP-018..022) | `docs/24` §3, FR-152 | Modify | Adopted for the audio phase of the track. | `docs/24` §3.3. |
| 9 | Speaker identity across sessions with abstention margins (ER-SP-023) | `docs/24` §3 ("speaker labels") | Add (P2) | Useful for meetings; depends on audio. | FR-231. |
| 10 | Meeting detection by which process holds the microphone (ER-SP-024) | None | Add (P2) | Second outcome in the owner's order (recall, then meetings). | FR-230. |
| 11 | One SQLite file, FTS5 with external content, a write-coalescing queue (ER-SP-025, 026) | `docs/24` §4, `docs/06` §8 | Keep | Same approach as Nova; external-content FTS is noted for the ambient tables. | `docs/06` §8. |
| 12 | Search ordered by time; no embeddings over captured text (ER-SP-027, 028) | `docs/24` §4 (vector index) | Modify | The vector index becomes optional, enabled only when an eval shows it helps recall. | FR-153 revised. |
| 13 | Activity summary computed in SQL from frame gaps, with no model (ER-SP-029) | None | Add | A cheap, exact answer to "what did I do today", and the right first tool for agents. | FR-229. |
| 14 | Local HTTP API and a read-only raw SQL route (ER-SP-030) | `docs/24` §5 | Modify + Reject | Typed tools only. Raw SQL is rejected: it exposes everything and its schema drifted from the prompt that described it (ER-SP-032). | `docs/24` §5. |
| 15 | MCP tools ranked broad to narrow (summary, then search, then elements, then frame context) (ER-SP-031, 032) | `docs/24` §5 | Modify | The ladder is adopted for Nova's ambient tools. | FR-155 revised. |
| 16 | Scheduled and evented prompts with server-enforced data scopes and per-run query limits (ER-SP-033, 034) | `docs/09` | Add | Automations that read ambient data must be scoped by the Hub, not by the prompt. | FR-233; FR-187 (verified outcomes). |
| 17 | Retention modes, compaction, disk guard (stop below 5 GiB, resume above 10 GiB) (ER-SP-035) | `docs/24` §4, §7 | Modify | Adopted with Nova's defaults (text 30 days, pixels 48 h). | FR-154, FR-156 revised. |
| 18 | Resource governor: background work on a single CPU lane, power profiles by battery level (ER-SP-036, 037) | `docs/24` §8, FR-156 | Modify | Concrete profiles make FR-156 testable. | FR-156 revised. |
| 19 | Encryption at rest with a vault, disabled in the target's app; sync of pipes and memories only (ER-SP-038) | `docs/24` §2 | Keep | Nova's requirement (encrypted at rest, keys on the Hub or device) is stronger and stays. | FR-228. |
| 20 | Browser extension as a control bridge with `eval` and cookie export (ER-SP-039) | None | Reject | Cookie export breaks Nova's secrets model; Nova's extension bridge is per-tab and never exports cookies. | None. |
| 21 | Eval harnesses: audio quality metrics, meeting-state replay with a CI gate (ER-SP-040) | `docs/16` | Add | Replay evals catch state-machine regressions. | `docs/16` §11. |
| 22 | Analytics, crash reports and remote support-log requests on by default (ER-SP-041) | ADR-019, `docs/19` §4 | Reject | Telemetry is off by default in Nova. | None. |
| 23 | A vendor cloud AI gateway; cloud transcription default on paid plans (ER-SP-042) | `docs/07`, `docs/13` | Reject | Nova calls the endpoints the user configured, directly (`docs/19` §5). | None. |
| 24 | Plans, licence tiers and paid-feature gates (ER-SP-043) | n/a | Reject | Commercial gates, not design points. | None. |
| 25 | Separate enterprise build: managed settings, write-only archive, customer-run gateway (ER-SP-044) | FR-106 | Modify | One build with managed-policy keys for ambient capture. | FR-106 revised. |
| 26 | Windows check for an enterprise instance that fails closed and stops the app when a port is held (ER-SP-045) | `docs/15` | Reject | A held port must produce a clear diagnostic and a fallback, never a silent exit. | FR-225. |
| 27 | Writes its MCP server, with a full-access key in plain text, into every AI client it detects, every 60 s (ER-SP-046) | `docs/08` §2.2 | Reject | Nova never edits other apps' configs. Exposure is explicit, per client, with a scoped revocable token. | FR-192; ADR-075. |
| 28 | Copies its skills into other agents' skill folders (ER-SP-047) | `docs/08` §4 | Reject | Same reason as row 27. | FR-192. |
| 29 | Plan sign-in that reuses another vendor's OAuth client id (ER-SP-048) | `docs/07` §4, `docs/19` §5 | Reject | Impersonating another client breaks provider terms. | None. |
| 30 | Bundled third-party coding agent runs pipes and chat (ER-SP-049) | `docs/09` | Reject | One runtime and one policy engine (ADR-076). | None. |
| 31 | Agent Client Protocol executors and user-owned cloud agents (ER-SP-050) | `docs/09`, `docs/13` §3 | Add (P2) | External agents are allowed only through an adapter that routes their permission requests to Nova's policy engine and runs them sandboxed. | FR-203. |
| 32 | Hybrid storage: bulky text in immutable Parquet files, SQLite keeps metadata and contentless FTS (ER-SP-051) | `docs/24` §4 | Reject (v1) | Adds custom readers and bypasses the release gate on direct file reads. Revisit only if measured volume demands it. | None. |
| 33 | A second local server on a fixed port with no token (ER-SP-052) | `docs/12` | Reject + Add | Loopback is not an authorization boundary. Every Nova listener requires a token. | FR-192. |
| 34 | App-owned agent browser with opt-in import of login state from the user's browsers (ER-SP-053) | `docs/11` §4 | Reject (session import) | Copying cookies out of the user's browsers bypasses per-site consent. The extension bridge covers real sessions. | None. |
| 35 | Conflicting resource claims; observed install footprint (ER-SP-054) | `docs/24` §8 | Modify | Nova sets its own budgets and measures on reference hardware. | `docs/24` §8; `docs/16` §6. |
| 36 | Async AI redaction on device or in a hosted enclave; overwrites stored source columns and black-boxes image regions in place (ER-SP-055) | `docs/24` §7 | Modify | Local redaction by default; remote redaction only by explicit opt-in, logged. Raw secrets are overwritten after redaction. | FR-227. |

### Owner design-session context (ambient capture)

The findings record preferences from two earlier owner sessions. They are context, not
decisions; this table shows how each was handled.

| Owner preference | Handling |
| --- | --- |
| Outcomes in order: recall, meetings, live context, digests | `docs/24` §11 phases the track in that order. |
| The Windows desktop is captured first | `docs/24` §8: Windows first, then macOS, then Linux. |
| Screen text lives on the Hub; recall works while the device sleeps | FR-228. |
| Pixels captured on the device, then uploaded to a configured location | FR-228. |
| The screen reader is a helper with no network access, supervised by `novad` | FR-228. |
| Model-based PII redaction on the device before text leaves it | FR-227. |
| PII categories are per-category switches with stated defaults | FR-227. |
| Instructions in captured text are "marked and audited, not gated" | **Conflict with an invariant.** Resolved by ADR-074: captured content can never directly trigger a consequential action (policy and security invariants win). Marking and auditing are adopted on top (FR-232). |
| The Hub refuses records whose redaction stamp covers fewer categories than configured | FR-227. |
| Read results always state the time they covered, including gaps | FR-155. |
| A reply-level check flags screen-activity claims made in a turn where no capture tool ran | FR-232. |
| Tool calls that copy long verbatim runs of captured text are tagged, with a notice on the reply | FR-232. |
| Images get solid boxes over redacted text; an image is dropped when a redacted span has no position | FR-227. |
| Images are encrypted to a Hub-held key before upload; the local copy is deleted only after a verified read-back | FR-228. |
| Text first, foreground window only; no keystrokes, clipboard or audio in the first phase | `docs/24` §11 phase 1. |
| Redaction at capture that cannot be disabled | FR-227: the secrets category cannot be switched off. |
| Retention: thumbnails 48 h, text 30 days | `docs/24` §4 defaults. |
| Captured text reaches models only in an untrusted wrapper and can never satisfy an "act when told" rule | FR-155, FR-189. |

## Validation

Run `node scripts/check-spec.mjs` from the repository root. It checks that every `FR-*` in
`docs/03` appears exactly once in the milestone index of `docs/17` and once in
`tests/manifest.md`, that every JSON schema parses, that internal Markdown links resolve,
and that no reference-app name appears outside `docs/external/`.
