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
the policy and security invariants (`docs/24` §5, `docs/12` §6), which win under the conflict
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

## Defaults for common ambiguities

| Situation | Default |
| --- | --- |
| User hasn't chosen a model | First enabled provider's recommended model |
| Provider lacks a requested capability | Disable the control with a tooltip; never silently degrade |
| Tool needs network but policy is silent | `ask` |
| Tool is read-only and local | `allow` |
| Tool is destructive/external | `ask` |
| Approval decision times out | Pause the run (24 h), then cancel with a checkpoint |
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
