# 28 — Glossary

Canonical terms used throughout the spec. Nova uses **plain names**; there is no metaphor
layer. Product brand: **Nova**. Domain: **arialabs.ai**.

## Roles & infrastructure

| Term | Meaning |
| --- | --- |
| **Hub** | The always-on canonical service: database, agent runtime, scheduler, policy, UI hosting, routing. |
| **Client** | A device that presents the Hub-served UI (browser/PWA, native desktop shell, mobile). Thin by default. |
| **Compute Node** | A device that serves inference, embeddings, media, browser, or code execution to the Hub. |
| **Relay** | A content-blind, end-to-end-encrypted forwarding service for off-LAN clients and push. |
| **Wake Helper** | An always-on device on the same LAN that can send WoL magic packets. |
| **`novad`** | The Nova device agent: a Rust supervisor plus signed, sandboxed modules. |
| **Mesh** | The device-to-device mesh transport (Headscale/Tailscale/NetBird/WireGuard). Formerly "Lattice" (ADR-057). |
| **Transport** | A way roles reach each other: LAN, Mesh, Relay, or direct public. |
| **Trust path** | How HTTPS is trusted: Hub local CA, Mesh certificates, or native-shell pinning. |
| **Sealed mode** | Optional mode where keys stay in the secure enclave and plaintext is never written to disk; proactive work pauses while locked. |

## Domain objects

| Term | Meaning |
| --- | --- |
| **Thread** | A conversation. |
| **Turn** | One unit of work in a thread: a user message (or a schedule, goal, hook or event trigger) and everything the agent does in response, up to its end, interruption or failure. A turn's execution location is fixed (FR-127). |
| **Thread status** | The one status every thread, run, code session and agent shows: Running, Needs input, Ready or Blocked, derived from runtime state (FR-215). |
| **Project** | A container of threads, instructions, sources, and optional local folders. |
| **File** | A file or artifact inside a project. |
| **Agent** | A configured actor with instructions, tools, permissions, and a runtime. An **always-on agent** persists across sessions. |
| **Run** | A delegated multi-step Work task, bounded by budgets and optionally holding a goal. |
| **Goal** | An objective (at most 4,000 characters) a run or agent works toward, with optional budgets and a status: active, paused, blocked, usage_limited, budget_limited, complete (FR-181). |
| **Budget** | A bound on a run or goal: time, tokens or cost (defaults 60 min, 2M tokens, the provider spend cap), plus a 200-step backstop per turn. Reaching one pauses with an offer to extend (FR-182). |
| **Code Session** | A coding task bound to an environment + folder/repo. |
| **Environment** | Where a code session runs: local, cloud, SSH, WSL, container, or a registered device running `novad`. |
| **Ambient Memory** | Opt-in capture of screen text (accessibility tree first, OCR as fallback) and, later, audio, kept as a searchable timeline behind a redaction release gate. |
| **Coverage** | In ambient reads, the time range a result covered and any gaps in capture; every result states it (FR-155). Not to be confused with test coverage floors (`AGENTS.md` §6). |
| **Automation** | A versioned trigger → condition → action rule. |
| **Entity** | A smart-home device/state (light, sensor, lock, …). |
| **Area / Scene** | A room grouping / a named set of entity actions. |
| **Catalog** | The signed registry of community extensions: an index (`catalog.json`) of plugins, skills, themes, pets and MCP servers, signed by its publisher (`<index>.sig`), served from a folder, a Git repository pinned to a commit, or an https location (FR-049). |
| **Extension** | A plugin with an SDK part (`.nova-plugin/extension.json`): code that registers commands, panels, tools (`ext:<id>/<name>`), hooks, themes, keybindings, menus and status items and observes events, run in a worker of its own with only the permissions it declared (FR-117). |
| **`.novax`** | An extension bundle: a zip of the extension folder plus `META-INF/nova-signature.json`, the publisher's Ed25519 signature over a digest of every file (ADR-097 D2). Verified only when the publisher is trusted. |
| **Trusted publisher** | A publisher key the owner (or managed policy) trusts (`plugins.trustedPublishers`); what it signs installs as Verified. Anything else installs only through the sideload confirmation and stays **Unverified**. |
| **Plugin** | A bundle of skills, MCP servers, lifecycle hooks, sub-agent roles, commands and optional UI (FR-045). |
| **Skill** | A reusable instruction bundle: a folder with `SKILL.md` and optional files; only its name and description sit in context until it is used (ADR-067). |
| **Hook** | A lifecycle hook: a sandboxed command or MCP tool that runs on a runtime event (for example before a tool call or at stop), trusted by content hash, and able only to tighten a decision (FR-197, ADR-068). |
| **Connector** | An authenticated integration to an external service. |
| **MCP** | Model Context Protocol; how tools/resources are exposed. |
| **MCP Apps** | The open MCP extension for interactive UI: `ui://` HTML resources rendered in sandboxed iframes with a `postMessage` bridge, shown inline, fullscreen or picture-in-picture (FR-198, ADR-066). |
| **MCP bundle** | A zip with a manifest that installs a single MCP server with typed user configuration and declared permissions (FR-199). |
| **Tool** | A callable capability (built-in, MCP, plugin, or computer). |

## Governance

| Term | Meaning |
| --- | --- |
| **Policy Rule** | A declarative statement controlling when an action is allowed/asked/handed off/denied. |
| **Approval** | A user decision required before a gated action: Allow once, Allow for this session, Always allow (scoped), Deny and continue, Deny and stop, or Hand off (FR-100). |
| **Approval policy** | When Nova asks before acting: one of the two axes a permission mode is built from (ADR-059). |
| **Permission profile** | What an execution may touch: filesystem entries (read/write/deny) plus a network block (`off`, `allowlist`, `limited`). Built-ins: `read-only`, `workspace`, `full` (FR-190). |
| **Permission mode** | A user-facing preset (Manual, Accept edits, Plan, Auto, Bypass) over an approval policy and a permission profile (FR-063). |
| **Protected path** | A path that stays read-only or denied inside writable roots: `.git`, `.nova`, `.agents`, the Nova data directory and credential locations (FR-190). |
| **Confirmation tier** | Built-in safety's class for an action: `handoff_required` (the user must do it), `confirm_at_action` (asked every time, never pre-approved) or `pre_approvable` (FR-189). |
| **Command prefix rule** | A rule that matches a command's token prefix and yields allow/ask/deny, with match and not-match examples checked when rules load (FR-191). |
| **Permission Grant** | A remembered approval scoped to an action/resource. |
| **Auto-review / auto-reviewer** | The model reviewer that checks consequential actions after deterministic policy, returns a strict verdict, fails closed and can only tighten a decision (FR-085, ADR-061). |
| **Release gate** | The rule that captured ambient content is invisible to every reader until model-based redaction certifies it under the current policy (FR-227). |
| **Capability Declaration** | The document `novad` reports describing hardware/OS/services/models/limits. |
| **Audit Log** | The append-only, hash-chained record of every consequential action (`audit_event`). Formerly "Flight recorder" (ADR-057). |
| **Learning Level** | L0 memory · L1 skills · L2 workflow optimization · L3 self-tuning · L4 code self-modification · L5 local fine-tuning. |
| **Managed policy** | Settings and restrictions an administrator sets for a Hub through an OS-protected file or a signed remote policy; it only tightens, locks what it sets ("Managed by your organization") and fails closed when it cannot be read (FR-106, ADR-097 D4). |
| **Sealed export** | A data export (`.novaexport`) protected with a passphrase (scrypt, then AES-256-GCM); only a sealed export carries the vault's secrets (FR-105, ADR-097 D5). |
| **App token** | An `nva_` access token a third-party app gets through OAuth sign-in and the owner's consent: read-only scopes, one hour, refreshed with a rotating refresh token, revocable per app (FR-222, ADR-097 D6). |
| **Guardrail** | The on-by-default protection that prevents the agent from modifying policy/safety/permissions/audit/signing/self-improvement gates. |

## Models & runtime

| Term | Meaning |
| --- | --- |
| **Provider** | An API source (Anthropic, OpenAI, Google, OpenRouter, local, OpenAI-compatible). |
| **Model** | A provider-native model id. |
| **Virtual Model** | A named preset that routes to a provider/model/params (single, fallback, cheapest, best). |
| **Model preset** | A virtual model on the simple Faster ↔ Smarter scale (default Faster, Balanced, Smarter), editable in an advanced panel; never spawns sub-agents (FR-221). |
| **Reasoning Level** | `off`…`max`, mapped per provider. |
| **Mode** | Top-level surface: **Chat**, **Work**, **Code**, **Agents**. |
| **Routing Order** | Same device/LAN → capability → least-loaded → cost/energy → cloud. |

## Naming rules

1. Use these plain terms in UI, code, and docs.
2. Internal IDs are stable and independent of display text (`project`, `file`, `agent`, …).
3. The only product brand is **Nova**. Reference applications studied for this spec are named
   only by opaque IDs and never outside `docs/external/`; integration targets, protocols and
   dependencies may be named (ADR-056). `scripts/check-spec.mjs` enforces this.
4. If a themed name is ever introduced, it is a **display-layer** alias only (see `docs/04`
   §7), never a code identifier.
