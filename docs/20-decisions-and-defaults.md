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
| ADR-050 | Learning levels | L0–L5; **guardrails are immutable** |
| ADR-051 | Self-modification | Sandboxed, tested, staged, approved, reversible |
| ADR-052 | Eval harness | Mandatory gate for any learning/self-improvement change |

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

**ADR-050 — Learning levels with immutable guardrails.** L0–L3 are transparent and reversible;
L4/L5 require explicit approval. The agent may **never** modify policy, permissions, safety,
audit, signing, or the self-improvement gates.

**ADR-051 — Self-modification is gated.** Isolated worktree, tests + security + safety eval,
diff/evidence approval, staged deploy, health check, automatic rollback.

**ADR-052 — Evaluation is mandatory.** No learning or self-improvement change ships without
passing the regression suite; regressions auto-revert and notify.

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
