# 20 — Decisions & Defaults (ADR Log)

This file resolves open questions so the build agent never has to stop. Each entry is an ADR
(Architecture Decision Record) with the chosen default and rationale. If a decision must
change, append a superseding entry here and add a file under `docs/adr/`; never edit history
silently.

## ADR index

| ID | Decision | Default chosen |
| --- | --- | --- |
| ADR-001 | Desktop framework | **Electron + React + TypeScript** |
| ADR-002 | Local database | **SQLite (WAL) + Drizzle** |
| ADR-003 | State management | **Zustand + TanStack Query** |
| ADR-004 | Styling | **Tailwind + CSS variables (token-driven)** |
| ADR-005 | Monorepo tooling | **npm workspaces + Turborepo** |
| ADR-006 | Browser automation | **Playwright primary, CDP fallback** |
| ADR-007 | Sandbox on Linux | **bubblewrap**, containers optional |
| ADR-008 | Secrets | **OS keychain**, encrypted vault fallback |
| ADR-009 | Crypto primitives | **libsodium** (XChaCha20-Poly1305, Argon2id, Ed25519) |
| ADR-010 | Sync model | **E2EE, per-field LWW, content-blind server** |
| ADR-011 | Provider set (v1) | **Anthropic, OpenAI, OpenAI-compatible, Google, OpenRouter, Local** |
| ADR-012 | Reasoning levels | **off/minimal/low/medium/high/xhigh/max**, mapped per provider |
| ADR-013 | Plugin format | **manifest.json + skills + MCP servers + sandboxed UI** |
| ADR-014 | Tool namespacing | **`<noun>.<verb>`, `mcp:<server>.<tool>`, `plugin:<id>.<tool>`** |
| ADR-015 | Policy precedence | built-in safety > managed > custom rules > tool defaults > mode |
| ADR-016 | Agent limits | max 60 steps, 60 min, configurable |
| ADR-017 | Concurrency | 4 agent workers, 2 browsers (configurable) |
| ADR-018 | Channels (v1) | **in-app, Slack, Teams, Telegram, email, webhook** |
| ADR-019 | Telemetry | **off by default**, content-free when on |
| ADR-020 | Updates | **signed manifest, staged rollout, auto-rollback** |
| ADR-021 | Accessibility target | **WCAG 2.2 AA** on core flows |
| ADR-022 | License | **AGPL-3.0-or-later for the app** (see note) |
| ADR-023 | Cloud server code | **separate package, permissive (Apache-2.0)** |
| ADR-024 | Package manager | **npm** (lockfile committed) |
| ADR-025 | Node/Electron versions | **Node 22 LTS in CI**, Electron latest stable at M0 |
| ADR-026 | Testing stack | **Vitest, Testing Library, Playwright, MSW** |
| ADR-027 | i18n | **i18next**, English default, RTL-ready |
| ADR-028 | Feature flags | DB + env, visible in Diagnostics |
| ADR-029 | Retention defaults | 90d tool results, 30d screenshots, 14d logs |
| ADR-030 | Default model | first connected provider's flagship; overridable |
| ADR-031 | Hub runtime | **Standalone Node service**, not an Electron main process |
| ADR-032 | Device agent | **`novad` supervisor in Rust**; modules Rust or Node |
| ADR-033 | Topology | **Hub-and-spoke**; Hub canonical; clients thin |
| ADR-034 | Routing order | same device/LAN → model+capability → least-loaded → cost/energy → cloud |
| ADR-035 | Hub down | **Local fallback first**; automatic failover deferred |
| ADR-036 | Offline replica | Capability-gated per device, encrypted at rest |
| ADR-037 | Transports | Pluggable: LAN / Lattice / Relay; **Headscale recommended**, NetBird for self-hosted mobile |
| ADR-038 | Relay | E2E, content-blind, self-hostable |
| ADR-039 | Trust paths | Local CA / Lattice certs / native pinning, user-selectable |
| ADR-040 | Add Device | QR/short code + **required Hub approval**; auto-approve off by default |
| ADR-041 | novad layout | Supervisor + signed, sandboxed modules |
| ADR-042 | BIOS/firmware | **Off by default**; allowlist + dry-run + snapshot + approval + rollback |
| ADR-043 | Out-of-band mgmt | IPMI/Redfish/AMT **off by default**, admin-only |
| ADR-044 | Encryption | Hub trusted; **E2E for everything leaving the Hub**; optional sealed mode |
| ADR-045 | Minimum Hub hardware | Intel N100/N150-class, 8–16 GB |
| ADR-046 | Ambient capture | Off by default; local-first; exclusions + redaction + pause |
| ADR-047 | Automations | Run on the Hub; physical actions require approval |
| ADR-048 | Smart home | Integrate (Home Assistant primary); do not ship radios |
| ADR-049 | Community catalog | Signed, permission-enforced, self-hostable |
| ADR-050 | Learning levels | L0–L5; guardrails on by default, toggleable in Advanced |
| ADR-051 | Self-modification | Sandboxed, tested, staged, approved, reversible |
| ADR-052 | Eval harness | Mandatory gate for any learning/self-improvement change |
| ADR-053 | Catalog hosting | Public domain + tailnet + self-hosted/offline |
| ADR-054 | Smart home | Managed Home Assistant or direct MQTT/Matter; bridges later |
| ADR-055 | Skill authoring | Markdown skills; Nova may generate/refine its own with approval |
| ADR-056 | Brand-name scope | Reference-app names banned from the spec; integration targets, protocols and dependencies allowed; `docs/external/` is the evidence zone |
| ADR-057 | Plain terminology | **Mesh** (was Lattice), **audit log** (was Flight recorder), **Hub local CA** (was Core CA) |
| ADR-058 | Run bounds | **Budgets** (time, tokens, cost) + **goals** + a 200-step per-turn backstop; supersedes ADR-016 |
| ADR-059 | Permission model | Modes are presets over an approval policy × a permission profile; protected paths; allow rules never remove the sandbox |
| ADR-060 | Approval decisions | Allow once / for session / always (tool, prefix rule, host) / deny and continue / deny and stop / hand off; timeout recorded |
| ADR-061 | Auto-review | Model reviewer with a strict verdict, fail-closed, circuit breaker; runs after deterministic policy and only tightens |
| ADR-062 | Confirmation tiers | handoff_required / confirm_at_action / pre_approvable; only user-typed text is authorization |
| ADR-063 | Network credentials | **Injected by the egress proxy**, never placed in the sandbox |
| ADR-064 | Windows sandbox | **Restricted tokens + per-root capability SIDs**, not AppContainer |
| ADR-065 | Micro-VM substrate | Optional and flagged; the OS sandbox stays the default |
| ADR-066 | Extension UI | The open **MCP Apps** standard replaces the Nova-specific panel bridge |
| ADR-067 | Skill format | Folder with `SKILL.md`; catalog-only injection within a budget |
| ADR-068 | Lifecycle hooks | Trusted by hash; tighten-only; may answer non-safety asks |
| ADR-069 | Memory | `memory_item` stays canonical; background consolidation; never writes skills |
| ADR-070 | Channel threads | **Per-channel threads**, shared agent memory |
| ADR-071 | Relay | Stays content-blind and E2E; adopts stream/sequence framing, segmenting and acks |
| ADR-072 | Hub API | Stays REST + WS/SSE; adds server-to-client requests and handshake capabilities |
| ADR-073 | Ambient capture | Event-driven, accessibility-first, text-first, release gate, device/Hub split; vector index optional |
| ADR-074 | Captured instructions | Never trigger consequential actions; also marked and audited |
| ADR-075 | Integration hygiene | Nova never writes into other apps' configs; every listener needs a token |
| ADR-076 | One runtime | No embedded third-party coding engines; external agents only via policy-routed adapters (P2) |
| ADR-077 | Modes | Four modes kept; chat can escalate into an inline Work run |
| ADR-078 | Managed policy channels | OS-protected locations trusted by ACL; remote policy must be signed |
| ADR-079 | Missed schedules | One catch-up run over a 7-day lookback; RRULE supported; supersedes the 15-min grace |
| ADR-080 | Rejected capabilities | Recorded list of capabilities Nova will not adopt |
| ADR-081 | M0 target | Hub + web UI first; the native shell is a later client |
| ADR-082 | Feature-flag lifecycle | Flags carry a stage: experimental, beta, stable, deprecated, removed |
| ADR-083 | Phase 1 defaults | Open choices settled while finishing the spec (voice, channels, budgets, hooks, memory, relay, ambient, install) |
| ADR-084 | SQLite driver | **Node's built-in `node:sqlite`** through Drizzle's proxy driver |
| ADR-085 | Running TypeScript | **Node type stripping** for server code; Vite bundles only the web UI |
| ADR-086 | CI Node version | **Node 24 LTS** (supersedes the Node 22 part of ADR-025) |
| ADR-087 | Styling | **Token CSS + component classes**, no utility framework (supersedes ADR-004) |
| ADR-088 | M1 implementation choices | Search index, reasoning levels, cut-off replies, offline mock provider, browser-tab shortcuts |
| ADR-089 | M2 implementation choices | Model router seam, message versions, follow-ups, memory extraction, sources, compute-node transport |
| ADR-090 | M3 implementation choices | Tool loop and gate seams, container sandbox until M6, MCP SDK, audit chain, at-rest baseline, consolidation |

## Details & rationale

### ADR-001 — Electron
Mature cross-platform shell, best parity with the behaviors targeted (browser pane, dev-server
preview, extension bridge), and a TypeScript-first ecosystem for MCP/agents. Native helpers
cover sandboxing and keychain. Revisit only if performance budgets fail after optimization.

### ADR-002 — SQLite + Drizzle
Embedded, transactional, WAL for concurrent reads, easy export/backup, good FTS and vector
extensions. Drizzle gives typed queries and migrations.

### ADR-006 — Playwright primary
Reliable, cross-browser, great auto-waiting, and a strong tracing story. CDP fallback for
features Playwright lacks (e.g., fine-grained network interception).

### ADR-010 — Sync
Per-field last-writer-wins with a hybrid logical clock is simple and predictable; the merge
log prevents silent loss. Sharding by entity keeps messages append-friendly.

### ADR-012 — Reasoning levels
A single seven-level scale normalizes wildly different provider semantics; each adapter maps
to its native control. UI hides the control for non-reasoning models.

### ADR-022 — App license
Chosen **AGPL-3.0-or-later** to keep the desktop app open while allowing a separate,
permissively licensed server package (ADR-023) for cloud components. If the owner prefers a
more permissive license, switch to Apache-2.0; this is a one-line change and does not affect
architecture. The build agent should create `LICENSE` with AGPL-3.0-or-later unless the owner
edits this ADR.

### ADR-025 — Node/Electron
CI uses Node 22 LTS for stability even though the dev box has Node 26; pin the Electron
version at M0 and upgrade quarterly with a full test pass.

### Hub & device model (added)

**ADR-031 — Hub as a Node service.** The Hub is a long-running Fastify/Node process served by
systemd/launchd/Windows service, not an Electron main process. Electron is demoted to a client
shell. This keeps the always-on component headless and easy to run on a mini PC.

**ADR-032 — `novad` in Rust.** The privileged supervisor is a small, memory-safe, statically
built binary. Modules may be Rust (compute/management) or Node (tools/MCP-facing) and are
spawned as sandboxed workers.

**ADR-033 — Hub-and-spoke.** One canonical Hub; clients are the face; compute nodes are hands.
Simpler to secure and audit than a peer mesh, and matches the always-on requirement.

**ADR-034 — Routing order.** Predictable, privacy-first: keep work local when possible, then
match capability, then balance load, then optimize cost/energy, then (only if allowed) cloud.

**ADR-035 — Hub down.** Local fallback first because it is simpler and always available on a
capable device; automatic failover needs consensus and is deferred (FR-130).

**ADR-037 — Transports.** One abstraction; LAN always works; Lattice (Headscale recommended,
managed Tailscale for convenience, NetBird for self-hosted mobile) when configured; Relay
always available. This avoids a hard dependency on any third party.

**ADR-039 — Trust paths.** The Hub can use a Core-generated CA (fully private), Lattice
certificates (remote + mobile), or native-shell pinning (desktop). Chosen in onboarding.

**ADR-041 — novad hybrid.** Least privilege + isolation + independent updates, without the
packaging sprawl of fully separate products.

**ADR-042/043 — Firmware and out-of-band off by default.** These can brick hardware or
weaken security; they require an explicit toggle, per-change approval, snapshots, and audit.

**ADR-044 — Hub trusted, edges E2E.** The Hub must read content to index, search, and run
proactive agents. Everything that leaves the Hub is end-to-end encrypted. Optional sealed
mode keeps keys in the secure enclave and pauses proactive work while locked.

### Capability tracks (added)

**ADR-046 — Ambient capture off by default.** Screen/audio capture is sensitive; it requires
an explicit opt-in, shows a persistent indicator, ships with a sensitive-app exclusion list,
and keeps OCR/STT local by default.

**ADR-047 — Automations on the Hub, physical actions gated.** The always-on Hub is the right
place for triggers and schedules. Anything that affects the physical world requires approval
or an explicit scoped standing rule.

**ADR-048 — Integrate smart home, don't rebuild it.** Home Assistant is the primary integration
(covers Zigbee/Z-Wave/Thread/Matter); MQTT and vendor connectors extend it. This avoids
shipping radios and a second device database.

**ADR-049 — Community catalog is signed and permission-enforced.** Same model as plugins:
declared permissions are enforced at runtime, signatures are verified, updates show a
permission diff, and the catalog can be self-hosted or offline.

**ADR-050 — Learning levels with guardrails on by default.** L0–L3 are transparent and
reversible; L4/L5 require explicit approval. By default the agent may not modify policy,
permissions, safety, audit, signing, or the self-improvement gates. An administrator can
toggle this protection off in Advanced settings (audited); toggling is always a human action.

**ADR-051 — Self-modification is gated.** Isolated worktree, tests + security + safety eval,
diff/evidence approval, staged deploy, health check, automatic rollback.

**ADR-052 — Evaluation is mandatory.** No learning or self-improvement change ships without
passing the regression suite; regressions auto-revert and notify.

**ADR-053 — Catalog hosting.** The catalog is served from a public custom domain, a
tailnet/Lattice URL, and/or self-hosted/offline, selected by the user. Signed entries make any
endpoint equivalent.

**ADR-054 — Smart home bootstrap and bridges.** Home Assistant is preferred but optional:
Nova can manage an HA instance or use MQTT/Matter/vendor connectors directly. Ecosystem
exposure is HomeKit (local) first, then a Matter bridge; direct Google/Alexa cloud skills are
deferred.

**ADR-055 — Skill authoring.** Skills are markdown files. Users author them directly, and Nova
may generate or refine its own skills from repeated workflows or explicit requests; generated
skills carry provenance, are versioned, and require approval before use.

### Phase 0 reconciliation (added 2026-10-17)

These decisions come from `docs/external/RECONCILIATION.md`. Superseding decisions also have
a file under `docs/adr/`.

**ADR-056 — Brand-name scope.** The invariant "no third-party product or brand names" applies
to reference applications: products studied for this spec are named only by opaque IDs, and
their names never appear outside `docs/external/`. Integration targets (chat services,
smart-home platforms, mesh control planes, Git hosts), protocols and dependencies may be named,
because they are API targets like the model providers. `docs/external/` holds evidence inputs
and is exempt; `scripts/check-spec.mjs` enforces the rule with a name list kept in the private
ledger.

**ADR-057 — Plain terminology.** "Lattice" becomes **Mesh**, "Flight recorder" becomes **audit
log**, and "Core local CA" becomes **Hub local CA**, to honour the plain-naming rule
(`docs/28`). ADR-037 and ADR-039 keep their original wording as history; their decisions are
unchanged.

**ADR-058 — Budgets and goals replace the fixed step cap** (supersedes ADR-016; see
`docs/adr/0058-budgets-and-goals.md`). A fixed 60-step cap stops legitimate long work and gives
the user no way to say how long a task may run. Runs now carry time, token and cost budgets
(defaults: 60 min, 2M tokens, the provider spend cap) and an optional goal with system-owned
budget states. A hard backstop of 200 model steps per turn keeps every turn bounded, so the
"bounded" guarantee in `docs/09` §2 still holds.

**ADR-059 — Permission model.** The five Code permission modes stay as the user-facing
control, but each is defined as a preset over two axes: an approval policy (when to ask) and a
permission profile (what the sandbox allows, FR-190). Protected paths stay read-only inside
writable roots. Escalation after a sandbox denial happens only through a policy `ask`; Nova
never retries a command outside the sandbox on its own, and no allow rule removes the sandbox
(security invariant).

**ADR-060 — Approval decisions.** The four-option card becomes: Allow once, Allow for this
session, Always allow (scoped to the tool, a command prefix rule or a network host), Deny and
continue, Deny and stop, Hand off. A timeout is recorded as its own outcome. "Always" splits by
scope so a user can grant exactly what they mean.

**ADR-061 — Auto-review contract and position.** FR-085 is now a model reviewer in a read-only
sandbox with no inherited allow rules, returning a strict JSON verdict; it fails closed on
timeout, bad output or error, trips a circuit breaker after repeated denials, and records user
overrides. It runs **after** the deterministic policy engine and can only tighten a decision.
The reference ordering in which user custom rules come after the reviewer is rejected: the
deterministic engine is a hard invariant and must stay authoritative and testable. FR-085 moves
to M5 because the Auto permission mode depends on it.

**ADR-062 — Confirmation tiers and intent provenance.** Built-in safety sorts actions into
`handoff_required`, `confirm_at_action` and `pre_approvable` (FR-189). Only instructions typed
by the authenticated user count as authorization; pasted, fetched, channel or captured text
never does. Messages to third parties are `confirm_at_action` unless a user-created standing
rule names the recipient or channel, so channel agents remain usable.

**ADR-063 — Credentials injected at the egress proxy** (amends `docs/12` §5; see
`docs/adr/0063-proxy-credential-injection.md`). Network credentials for allowed hosts are added
by the egress proxy and never enter the sandbox, so a compromised sandbox cannot read them.
Environment-variable injection remains only for tools that cannot use a proxy, and is audited.

**ADR-064 — Windows sandbox** (supersedes the Windows part of ADR-007 and `docs/11` §2.3; see
`docs/adr/0064-windows-sandbox.md`). Windows sandboxing uses restricted, write-restricted tokens
with random per-root capability SIDs, hidden offline/online sandbox users, a private desktop,
firewall rules that never fail open, and an optional OS container mode. AppContainer is not
used: it breaks common developer tools, and the token design is proven in practice.

**ADR-065 — Micro-VM substrate is optional.** A per-session micro-VM gives stronger isolation
at a cost in disk (images of several GB) and memory (about 4 GB per VM). It is offered behind a
flag per environment; the OS sandbox stays the default, especially on the minimum Hub hardware.

**ADR-066 — MCP Apps for extension UI** (supersedes the UI part of ADR-013; see
`docs/adr/0066-mcp-apps-ui.md`). Plugin and MCP-server UI uses the open MCP Apps extension
instead of a Nova-specific bridge. Servers written once render in Nova; the sandbox properties
(isolated iframe, typed `postMessage` bridge, no host DOM) are unchanged; every tool call from a
UI still passes the policy engine.

**ADR-067 — Skill folder format** (amends ADR-055; see `docs/adr/0067-skill-folder-format.md`).
A skill is a folder with `SKILL.md` and optional files, compatible with the open agent-skills
layout. Only a catalog of names and descriptions is injected (≤ 2 % of context, max 10k
tokens); the body loads on use. This keeps context small for local models.

**ADR-068 — Lifecycle hooks.** Hooks are trusted by content hash, run sandboxed, and can only
tighten a decision. A hook may answer an `ask` that came from a user rule or a tool default; it
never overrides built-in safety, managed policy or a deny.

**ADR-069 — Memory consolidation.** `memory_item` rows remain the canonical, reviewable store.
A background job consolidates and ages them and produces a capped summary. Consolidation never
writes skills: skill creation stays an L1 proposal that needs approval (guardrail).

**ADR-070 — Per-channel threads** (supersedes the single-thread rule in FR-088; see
`docs/adr/0070-per-channel-threads.md`). Each channel binding keeps its own thread; the agent's
identity and memory are shared. This stops content from a private DM surfacing in a shared
channel. The owner's private channels can opt into one shared thread.

**ADR-071 — Relay framing.** The Relay stays content-blind and end-to-end encrypted. Every
reference implementation relays through a vendor backend with no end-to-end claim; that model
is rejected. Their framing is adopted inside sealed envelopes: client, stream and sequence ids,
segmenting, cumulative acks, keepalive, pairing by QR or code, and list/revoke of paired
clients.

**ADR-072 — Hub API shape.** REST plus WebSocket/SSE stays, because browser clients need it.
The API adds server-to-client requests over the stream (FR-188), a capability handshake in
`/api/v1/hello`, per-client notification opt-out, and Origin checks on WebSocket upgrades.

**ADR-073 — Ambient capture redesign** (supersedes `docs/24` §3–4 of the draft; see
`docs/adr/0073-ambient-capture.md`). Capture is event-driven, reads the accessibility tree
first and falls back to OCR, and is text-first: pixels are optional. A capture helper with no
network access feeds `novad`, which sends text to the Hub; recall runs on the Hub. A release
gate hides everything until model-based redaction certifies it. The vector index is optional
and enabled only when an eval shows a recall gain.

**ADR-074 — Captured instructions.** An owner design session for an earlier codebase chose to
mark and audit instructions found in captured text rather than gate them. That conflicts with
the policy and security invariants (`docs/24` §2.7 and §8.4, `docs/12` §6), which win under the conflict
precedence. Captured content can never directly trigger a consequential action. Marking and
auditing are adopted in addition (FR-232).

**ADR-075 — Integration hygiene.** Nova never writes itself, its keys or its skills into another
application's configuration, and every local listener requires a token (loopback is not an
authorization boundary). Exposing Nova's MCP server is an explicit per-client action with a
scoped, revocable token.

**ADR-076 — One runtime.** Nova does not embed a separately versioned third-party coding engine
or agent runtime; doing so would bypass the policy engine and the audit log. External agents
are allowed only as P2 adapters that route every permission request through Nova's policy
engine and run inside Nova's sandbox (FR-203).

**ADR-077 — Modes and escalation.** The four modes stay as surfaces. A chat request that needs
multi-step work can become an inline Work run (FR-186), proposed by default, so users get the
benefit of a unified mode without losing the distinct surfaces.

**ADR-078 — Managed policy channels** (amends `docs/12` §10). A policy file in an OS-protected
location (root-owned file, machine policy registry, device-management profile) is trusted
because only an administrator can write it. A policy delivered over the network must be signed.
Unsigned files in user-writable locations are still ignored with a warning.

**ADR-079 — Missed schedules** (supersedes the 15-minute grace window in `docs/09` §12; see
`docs/adr/0079-missed-schedules.md`). Missed fires collapse into one catch-up run, told which
window it covers, with a 7-day default lookback and a per-schedule `once` or `skip` policy.
RRULE is accepted alongside cron and intervals.

**ADR-080 — Rejected capabilities.** Nova will not adopt: relays that can read content;
telemetry, crash reports or support-log requests on by default; remote feature flags; a vendor
AI gateway in front of providers; sign-in that reuses another vendor's OAuth client; keystroke
or typed-text logging; raw SQL access for agents; exporting cookies or login state from the
user's browsers; auto-registration into other apps; silent unsigned installs; paywall gates; a
one-agent-per-user limit; agent notes the user cannot view; embedding a third-party coding
engine; storage that bypasses the redaction gate (immutable side archives); a startup check
that exits silently when a port is taken.

**ADR-081 — M0 builds the Hub and web UI first.** `docs/17` M0 previously named an Electron app,
which contradicted ADR-031. M0 now delivers `apps/hub` and `apps/web`; the native desktop shell
arrives with the client work in M7 and is packaged in M10.

**ADR-082 — Feature-flag lifecycle** (amends ADR-028). Each flag carries a stage:
`experimental` (off, hidden), `beta` (off, visible in Advanced), `stable` (on), `deprecated`,
`removed`. Diagnostics shows each flag's stage; removed flags are rejected at load.

### Phase 1 and M0 decisions (added 2026-10-17)

**ADR-083 — Defaults settled while finishing the spec.** Writing the topic documents required
choices the FRs left open. Each is recorded here so the build does not re-decide it:

- *Voice and authorization.* Speech from the signed-in user's own voice session counts as the
  user's instruction for intent provenance (FR-189), like typed text. Approvals are never granted
  by voice: answering an approval card always needs an explicit tap, click or key.
- *Owner messages in channels.* A message from the owner's verified identity in a private,
  one-to-one channel binding counts as user instruction. Messages in shared channels never do.
  `handoff_required` and `confirm_at_action` requests are answered only on an authenticated Nova
  client.
- *Budgets.* Time spent waiting for an approval or for user input does not count against a run's
  time budget. Child runs count against their parent. Plain chat turns get only the 200-step
  backstop. A goal waits 5 s before continuing on its own.
- *Stop-hook continuation* starts a new turn with trigger `hook`; it is not an extra step inside
  the stopping turn.
- *Hooks.* Project hooks never answer approval asks; plugin hooks may only if their manifest
  declares `hooks.answersAsks`. A hook that errors or times out leaves the decision unchanged
  unless it sets `failClosed: true`. Default timeout 30 s, maximum 10 min.
- *Memory.* A thread must be idle 30 min before consolidation reads it. Consolidation never
  rewrites an item the user pinned or edited. Items record whether they came from a private
  thread; replying with private-thread content in a shared channel defaults to `ask`.
- *Instruction files.* `.nova/instructions.md` takes precedence over `AGENTS.md` in the same
  directory. A project is trusted once the user confirms it on first open or managed policy lists
  it.
- *Git and protected `.git`.* `.git` stays read-only to ordinary tools. Git writes go only
  through the `git.*` tools, which run one at a time and may write inside `.git` except
  `.git/hooks` and `.git/config`.
- *Managed policy merge.* When several managed sources apply, the most restrictive value wins. A
  malformed policy in a trusted location fails closed: agent tools are denied until it is fixed.
- *Extension bridge.* Registering the browser's native-messaging manifest is the one write into
  another application's configuration that Nova performs, and only when the user turns the
  bridge on (an exception to ADR-075).
- *Per-site levels.* "Always allow" runs only the page-action classifier; "Auto approve" runs the
  classifier and the auto-reviewer; "Always ask" asks every time.
- *Command rules* live in their own store (`command_rule`, `contracts/schemas/command-rule.json`),
  not inside policy rules.
- *Relay framing.* Client, stream and sequence ids are outer envelope metadata bound to the
  ciphertext as associated data; the Relay sees them, the route id and the length, never content.
  Defaults: 64 KiB segments, 16 MiB maximum message, 60 s reassembly timeout, 256-segment window,
  5 s retransmit, 25 s keepalive, close after 3 missed pongs.
- *Session handoff.* Commits not yet on a remote travel as a Git bundle; the target confirms HEAD
  and the diff hash before the session continues there.
- *Ambient capture.* Coverage is recorded as status records with Hub-derived gap reasons. After a
  policy change, records whose stamp already covers the new categories are re-stamped without
  re-running the model. No keyboard hooks: typing is inferred from accessibility text changes and
  OS idle time. URL query strings and fragments are stripped by default. Built-in exclusions,
  including private browsing, cannot be removed. Capture cannot be enabled unless the Hub
  encrypts ambient data at rest. Raw audio is deleted once transcribed and redacted, unless the
  user opts in to keep it for 48 h. Redaction may opt in to run on the Hub for weak devices, with
  raw text held in a quarantine area until certified. `ambient.screenshot` and
  `ambient.summarize` are dropped: the image moves into `ambient.frame_context`, and summaries
  are written by the calling agent.
- *Contract details settled in the consistency pass.* Private-address access needs both the
  profile's `allowLocalBinding` flag and a dev-server grant. An always-on agent acting on its own
  needs an ambient grant to read captures. Memory items default to `origin_audience = 'private'`,
  and an item merged from several sources is private if any source is. Remote MCP OAuth uses
  client metadata documents or dynamic registration only; a user-supplied client id needs a schema
  amendment first. `uv` bundles use the device's own `uv` tool. Shell startup files are protected
  paths. Tool descriptors carry `effects` so the confirmation tiers never rely on server hints.
- *Other numbers.* MCP client tokens expire after 90 days. The exec yield time is capped at
  120 s. Git catalogs publish `nova-catalog.json`. Abandoned staged writes are discarded after
  24 h. Resolved server requests are kept 30 days. Budget meters update at most once a second.
  Three model presets ship (Faster, Balanced, Smarter). Auto-reviewer CI gates: fail if recall in
  any threat category drops more than 2 points, or the benign denial rate exceeds 5 %.
- *Install.* Data directory order: `--data-dir`, then `NOVA_DATA_DIR`, then the platform default
  (Hub services use `/var/lib/nova`). A taken port falls back to the next 10 ports unless
  `--strict-port` is set.
- *Bootstrap download.* `GET /api/v1/agent/dist/:file` requires the pairing code as a query
  parameter, so FR-192 holds without a session (the binary is also signature-checked).
- *Shortcuts.* Overlay Ctrl+Alt+N, attach window Ctrl+Alt+A, dictation Ctrl+Shift+Space; the
  computer-use kill key can be remapped but never unbound. OS notifications offer quick actions
  only for `pre_approvable` approvals.

**ADR-084 — SQLite through Node's built-in `node:sqlite`.** The Hub uses Node's bundled SQLite
(3.53, with FTS5) instead of a native module, accessed through Drizzle's proxy driver.
*Why:* no native compilation per platform or Node version, and one less supply-chain dependency.
*Risk:* the module is still marked "active development" (R-007); all access goes through
`packages/storage`, so the driver can be swapped without touching callers. ADR-002 (SQLite with
Drizzle) is unchanged.

**ADR-085 — Run TypeScript directly with Node's type stripping.** Server packages (`apps/hub`,
`packages/*`) are executed as `.ts` by Node (≥ 24) with erasable-only syntax enforced by
`erasableSyntaxOnly`; `tsc` only type-checks. Only the web UI is bundled (Vite). *Why:* no
build step or source maps for the server, faster tests, and identical code in dev and production.

**ADR-086 — Node 24 LTS in CI** (supersedes the Node 22 part of ADR-025). `node:sqlite` and
type stripping both need Node ≥ 24. The dev host runs Node 26; CI and the E2E container run
Node 24 LTS. Electron is pinned when the desktop shell is built (M7/M10).

**ADR-087 — Styling with tokens and plain CSS** (supersedes ADR-004). Components are styled
with CSS that reads only the design tokens (`packages/ui/src/tokens.css`) plus small component
classes; no utility-CSS framework. *Why:* the token layer already gives theming, the UI stays
small (the M0 shell is 73 KB gzipped), and a test can enforce "no hard-coded colors" by scanning
component sources. Revisit if UI velocity suffers.

**ADR-088 — M1 implementation choices.**
- *Search index.* Full-text search indexes a `message_search` copy of non-empty text parts with
  an integer key, kept in step by triggers, because FTS rowids pointing straight at
  `message_part` could be renumbered by `VACUUM`. Snippets mark matches with `<mark>`; clients
  render everything else as plain text.
- *Reasoning levels* are stored per thread and turn in M1 and are sent to providers from M2,
  when the per-provider mapping (`docs/07` §6) lands.
- *Cut-off replies.* A reply stopped by the output-token limit is an `incomplete` message on a
  `completed` turn; a provider error stores an `error` part, fails the turn and sets the
  thread's state to `error` until the next send.
- *Offline first.* When an account has never had a provider, the Hub creates a "Mock (offline)"
  provider so a fresh install works with no network; it is never recreated after the user
  deletes it. Crash recovery marks streaming messages `incomplete` and open turns `interrupted`
  with stop reason `error`.
- *Shortcuts in a browser tab.* Keys the browser keeps for itself (Ctrl+N, Ctrl+1–4) are shown and
  matched as Alt variants in a tab; the installed PWA and native shells use the documented keys.
  Remaps are stored once, platform-neutral, using `mod`.
- *Streams.* A client follows the open thread's stream; other threads refresh their status when
  the list is reloaded. `chat.delta` is coalesced to at most 60 events per second.

**ADR-089 — M2 implementation choices.**
- *Model router* (details in `docs/07` §6, §8.1, §9). The conversation engine resolves every
  model reference through one `ModelRouter` (`packages/core/src/routing`). References are
  `<accountId>/<modelId>`, `node:<nodeId>/<modelId>` or `preset:<id>`. A route is an ordered
  list of targets; the router emits a marker before each attempt so the turn records which
  target answered (the turn keeps the requested reference, the reply the model that answered
  and the turn the reasoning level used). Fallback,
  retries (exponential backoff with jitter, at most 2, `Retry-After` honored up to 10 s) and
  the per-account or per-node circuit breaker (open after 3 consecutive failures, half-open
  probe after 30 s) act only before the first content event; once output has started an error
  ends the turn. So a turn's execution location never changes after it starts producing output
  (FR-127), and a fallback before output updates the turn's recorded location.
- *Follow-ups (FR-019).* The behavior is the `general.followUp` setting (default `queue`) with a
  per-message override; the M1 `thread.input_mode` column is unused. A steer joins the running
  turn as a user message and is applied when the current model step ends, as one more step of
  the same turn. A queued message is persisted and starts as the next turn, also after a
  restart or a cancel. How a follow-up entered its turn is `message.delivery` (`steer`,
  `queued`), separate from `provenance`, which is where the text came from (FR-189). A failed
  step still lets a pending steer run; a steer that arrives after the turn closed is queued
  instead; a queued input that cannot start is cancelled with `chat.followup.cancelled`.
- *Versions and branches (FR-020, FR-033).* Messages form a tree (`message.parent_id`) with the
  thread's active leaf; edit and regenerate add sibling versions and never change earlier
  turns. Branch from here creates a new thread that inherits the parent's path by reference,
  without copying rows, and copies the parent's project, model, temporary flag and memory
  opt-out; it keeps showing what it inherited after the parent is deleted. Side chats are child
  threads that read the parent's current path (and project instructions, sources and memory
  scope from the nearest non-side ancestor), are deleted with their parent and are never listed
  among chats. Switching versions, editing, regenerating and deleting wait while a turn runs.
- *Context order.* One system message: the system prompt, then memory, then project
  instructions, then source excerpts, which are labelled as reference material, not
  instructions.
- *Temporary chats (FR-027)* neither write nor read memory, are excluded from search, are purged
  (rows and blobs) when deleted or `chat.temporaryTtlHours` (24) after the last activity in
  their family (branches and side chats included). Usage rows are kept without thread or turn
  ids, so spend totals stay right; a blob is deleted only when nothing else uses it. In the web
  UI, leaving a temporary chat deletes it.
- *Memory extraction (FR-032)* runs after each completed turn unless memory is off or the chat is
  temporary, a side chat or opted out. A deterministic extractor for explicit statements
  ("remember that…", "my name is…", "I prefer…") always runs, so memory works offline and with
  the Mock provider, and its facts are saved at once; a model-based extractor runs for real
  providers and adds at most 5 facts when its reply arrives. Secrets are redacted before
  anything is sent or stored. In context: pinned items, then items matching the message, then
  the most recent, up to about 2,500 tokens. A chat outside projects reads global memory; a
  shared project reads global and its own items; a project-only project reads only its own.
  Consolidation (FR-204) is M3.
- *Sources (FR-040).* M2 indexes text types only into ~1,500-character chunks searched with
  FTS5; up to five excerpts (6,000 characters) are added to a project chat's context and stored
  as citations of the reply. Other file types end in `error` until extraction lands.
- *Search ranking (FR-025)* uses FTS5 bm25 with recency as the tie-breaker.
- *Presets (FR-221).* With no saved presets, Faster, Balanced and Smarter are generated from the
  configured models; a preset whose targets are all unavailable is shown disabled and never
  replaced by another preset. With `routing.allowCloud` off, cloud targets are dropped and a
  turn with no target left fails closed.
- *Compute nodes (FR-126).* Until certificates arrive with the Mesh (M6.5), a compute node is
  the `@nova/compute` service speaking `/node/v1` over LAN HTTP with bearer tokens: it enrolls
  with a one-use token created in Settings → Devices (creating it is the human approval), pins an
  Ed25519 key whose signature every capability document must carry, and accepts jobs only with
  the job token the Hub holds in its secret vault. `novad`'s compute module supervises this
  service from M6. The Hub assigns node ids; an enrollment token is used up once a valid one is
  presented; a heartbeat's model list can only hide signed models, never add them; unreachable
  and revoked nodes offer no models. A node listens on 7420 by default, runs one job at a time
  with a queue of four (then `rate_limited`), refuses requests that carry an `Origin` header,
  reaches only its Hub and its backend, and wipes its credentials and exits when the Hub
  answers 401. Revocation mid-turn ends the stream with a `network` error and cancels the job.
- *Sessions only.* Only session tokens authenticate as a user; device, app and MCP-client
  tokens are checked by the routes that accept them (FR-192).
- *New chats* start on the Balanced preset when no default model is set.

**ADR-090 — M3 implementation choices.**
- *Policy engine.* Rules are ordered by scope specificity, then priority, then id. Only Nova's
  own tools (built-in, browser, computer) can be read-only; an MCP or plugin tool with no default
  asks. MCP, plugin, page and device tools get effect classes inferred from their name, title and
  description (purchase, messaging, deletion, install, credentials, accounts), which only ever
  add classes; the known cost is that an honest tool such as `list_orders` is treated as a
  purchase and can never be pre-approved. Without a typed instruction a consequential action
  asks unless a standing rule or grant covers it. `review` with no reviewer configured asks every
  time, and a hook or reviewer that errors counts as a deny. `tighten()` is the extension point
  for hooks (M4) and the reviewer (M5); it can only make a decision stricter.
- *Approvals and grants.* An ask that came from a rule offers no session or "Always allow"
  option (rules are checked before grants, so the grant could never apply). Session grants are
  scoped to the thread: exec tools by a suggested command prefix (else the exact arguments),
  network tools by tool and host, others by tool. "Always allow" writes a policy rule or command
  rule plus a grant pointing at it; revoking the grant deletes the rule. A timeout and a cancel
  both deny and stop the turn, recorded as `timeout` and `cancelled`. While an approval is open
  the thread is `waiting_approval`; startup cancels approvals a crash left open.
- *"Always allow" scopes* are offered narrowest first, and the card preselects the first: a
  command prefix rule, then a network host, then the whole tool. A one-click "Always allow" on a
  command therefore never allows every command.
- *Tool loop.* One assistant message per model step; a call's card, result and artifact are
  parts of that message. Only the current turn's tool calls are sent back to the model, which
  keeps small-model contexts small. Results reach the model inside an
  `<untrusted_data source id>` envelope whose id the content cannot predict, and each result adds
  its origin (file, page, MCP, tool) to the turn's taint; so do attachments, file mentions and
  project excerpts. A gate that throws counts as a deny; tools the policy denies outright are not
  offered at all. Deny and stop ends the turn `cancelled`, a timeout `approval_timeout`, the
  backstop `backstop`. `tool.search` is offered only when something is deferred, and tools it
  loads stay loaded for that chat (until a restart).
- *Sandbox until M6.* Exec tools run in a container (docker or podman CLI; `NOVA_SANDBOX`,
  `NOVA_SANDBOX_IMAGE`, default `debian:stable-slim`) with `--network none` unless the profile
  allows network and `NOVA_SANDBOX_NETWORK=open` is set (there is no egress proxy until M6); the
  host root is never mounted. Without a container runtime exec tools fail closed with
  `sandbox_unavailable`. `web.fetch` refuses private and loopback addresses and hands a redirect
  to another host back to the model so the new host passes the gate.
- *A new chat's first approval.* A thread's first stream connection receives live events only,
  so the client refetches the thread and its pending approvals once the stream is open; an
  approval requested before the connection is never missed.
- *Paths and profiles (FR-190).* The gate resolves symlinks and `..` before the engine sees a
  path, and the engine refuses anything that is not absolute and clean. Credential locations are
  denied anywhere; `.git`, `.nova`, `.agents` and shell start-up files are read-only inside
  writable roots; the Hub data directory is denied except its `workspace` folder; deleting a root
  or a folder above a protected location is denied. An unknown profile falls back to
  `read-only`.
- *MCP client.* Built on the official TypeScript SDK (`@modelcontextprotocol/client`, Apache-2.0)
  rather than a hand-written protocol. Nova offers protocol 2025-11-25 or later and refuses older
  servers with a clear message. MCP annotations are hints that can only make a tool stricter
  (`destructiveHint`, `openWorldHint`); `readOnlyHint` never loosens a default, and effect
  classes are never taken from a server. Tool names are `mcp:<server>.<tool>`, sanitized, with
  numeric suffixes on collisions. Restarts back off from 1 s to 30 s, at most 5 in 10 minutes,
  then the server stays in `error` until restarted by hand. An env value that is itself a
  `secret://` reference is refused, so a session cannot start a process holding another vault
  secret. For `sse`/`http` servers env entries are sent as headers (`X_Api_Key` → `X-Api-Key`).
  MCP servers are not yet sandboxed or routed through the egress proxy (FR-107, FR-193, M6).
- *Audit log.* SHA-256 hash chain over the canonical JSON of each row (the form compute nodes
  sign), with a sequence number and triggers that refuse UPDATE and DELETE. Verification reports
  the first broken entry; truncation at the end needs an external anchor and is not detected
  yet. Security events (sign-in and sign-out, provider credentials by reference, security
  settings, node enrolment) are audited from the event bus; tool calls and policy decisions are
  appended by their areas. Inputs are stored only as hashes.
- *At rest (FR-149 baseline).* Attachment, source and artifact blobs are sealed with a per-Hub
  data key (ChaCha20-Poly1305, random 96-bit nonces; the header and blob name are bound as
  associated data) kept in the secret store; blobs written before M3 are read as they are and
  sealed when written again. The SQLite file is not encrypted: `node:sqlite` has no encrypting
  storage layer, so full-database encryption waits for an encryption-capable build (revisit in
  M9); until then Diagnostics warns when the data directory is not on an encrypted volume.
  Backups are not encrypted yet. The Hub can serve HTTPS from `NOVA_TLS_CERT` / `NOVA_TLS_KEY`
  (TLS 1.2 minimum); end-to-end encryption for the Relay and sync arrives with them (M6.5, M7).
- *Secrets (FR-101).* `NOVA_SECRETS=keychain|vault` (default `vault`). The keychain backends use
  `secret-tool` on Linux and `security` on macOS, pass values only on stdin, and keep an index
  item because neither CLI lists items; switching to the keychain moves vault secrets after
  reading each back. Windows falls back to the vault. CI runs Nova's own secret scanner
  (`scripts/secret-scan.mjs`), built from the redactor's patterns, instead of an external tool;
  test fixtures mark fake values with `secret-scan: fake`.
- *Notifications (FR-013).* A turned-off category is not stored. A repeat with the same dedupe
  key updates the unread notification instead of adding one. At most 1,000 per account; links
  are same-origin app paths only. The web client shows an OS notification only while the page is
  hidden and only for notifications that arrive after it loaded.
- *Event streams.* Without a cursor, both the global and the per-thread stream send live events
  only; WebSocket upgrades without a session are refused in the handshake (401).
- *Memory consolidation (FR-204, FR-205).* Two recorded phases per scope (extract, consolidate)
  every 15 minutes and on demand; with only the Mock provider an offline heuristic runs, so
  memory works without a model. A thread is read again only after new messages and a new idle
  window. Pinned and user-edited items are never rewritten; a newer fact about a one-value
  subject (name, home, work) retires the older item; dated plans become past events. Correcting,
  dismissing or deleting an item clears its scope's summary so a forgotten fact never lingers.
  Past-chat retrieval is computed per turn and stores nothing, so turning it off leaves nothing
  to purge.

## Defaults for common ambiguities

| Situation | Default |
| --- | --- |
| User hasn't chosen a model | First enabled provider's recommended model |
| Provider lacks a requested capability | Disable the control with a tooltip; never silently degrade |
| Tool needs network but policy is silent | `ask` |
| Tool is read-only and local | `allow` |
| Tool is destructive/external | `ask` |
| Approval decision times out | Record `timeout` (FR-100) and keep the run paused at a checkpoint until the user decides or cancels |
| Context over budget | Summarize older turns; keep pinned memory + system + tools |
| Ambiguous user intent with a risky action | Ask one concise clarifying question |
| Two rules conflict | Higher `priority`, then more specific scope wins |
| Sync conflict | LWW per field; log; offer restore |
| Channel message from an unknown user | Ignore + log |
| Plugin requests undeclared permission | Deny + disable + notify |
| Sandbox unavailable | Fail closed; offer read-only mode |
| Local model server absent | Show setup guidance; keep the provider disabled |
| Cost cap reached | Pause and prompt; never continue silently |
| Screenshot requested at high frequency | Coalesce to 1 per 2 s |
| User edits a file the agent is editing | Detect mtime/hash change; ask before overwrite |
| Update signature invalid | Refuse to install; surface an error; keep current version |
| Telemetry flag unset | Off |
| Feature flag unset | Off unless in the milestone's delivered set |
| Locale unsupported | Fall back to English (no machine translation at runtime) |

## How to add a decision

```
docs/adr/NNNN-short-title.md
---
status: accepted | superseded-by-NNNN
context: ...
decision: ...
consequences: ...
---
```

Append a row to the ADR index above and reference the ADR id in the relevant docs/commits.
