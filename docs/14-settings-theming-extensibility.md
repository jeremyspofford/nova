# 14 — Settings, Theming & Extensibility

## 1. Settings model

Settings are stored in the `setting` table (scoped global/project/workspace) and resolved with
precedence: **built-in default → user global → user project → managed policy**. Environment
variables may override only in developer mode.

**Security-relevant keys are not project-settable.** A project-scoped value, whether set in the
app or read from a project's `.nova/` folder, cannot change these keys: sandbox and permission
profile (FR-190), egress allowlist and proxy mode (FR-102, FR-193), approval policy, permission
mode defaults and "Always allow" rules (FR-063, FR-100), instruction root markers and the
instruction budget (FR-185), and the hook trust list (FR-197). They resolve only from the
built-in default, user global settings and managed policy. A project value for one of them is
ignored, and Diagnostics shows a warning naming the key and the project.

### 1.1 Settings map

| Section | Keys |
| --- | --- |
| **General** | language, enter-to-send (`enter`\|`mod+enter`), prevent-sleep, follow-up behavior (`steer`\|`queue`), restore-session, check-updates |
| **Accounts** | provider accounts, active account, default model, virtual models, spend caps |
| **Appearance** | theme, accent, background, foreground, uiFont, codeFont, fontSize, density, sidebarWidth, reducedMotion, highContrast |
| **Pets** | enabled, petId, position, size, reactions, mute |
| **Keyboard** | bindings map, reset, search |
| **Notifications** | per-category (completion, approval, error, scheduled), OS permission, quiet hours |
| **Chat** | default reasoning, citations, memory on/off, temporary-chat TTL, suggested prompts |
| **Work** | default autonomy, max sub-agents, run budgets (time, tokens, cost; FR-182), approval timeout, chat escalation (`propose` (default) \| `auto` \| `off`, FR-186) |
| **Code** | default permission mode, default environment, auto-verify, review-before-commit, dev-server auto-start, worktree cleanup, worktree include file (copy files listed in `.worktreeinclude`, on by default), worktree limit per repo (default 15) (FR-073) |
| **Agents** | proactive research toggle/frequency, default rules, connected computer, channels, self-scheduling limits (minimum interval 5 min, horizon 30 days, max 24 self-set wakes per day, FR-206) |
| **Memory** | retention, extraction on/off, embedding provider, review frequency, reference past chats (on/off; off purges derived data within 30 days, FR-205), default project memory scope (`shared` \| `project_only`), background consolidation (on/off, idle delay, summary budget 2,500 tokens, FR-204) |
| **Tools & MCP** | server list and per-server settings (`startupTimeoutMs`, `toolTimeoutMs`, `enabledTools`/`disabledTools`, `required`, `defaultApproval`, `deferred`, `oauth`; `contracts/schemas/mcp-config.json`, `docs/08` §2.1), per-tool and per-action defaults, plugin permissions, approval rules ("Always allow" list, revocable, FR-100), hook trust list (source, event, hash, status; trust/revoke, FR-197), deferred-tool budget (default 40 tools or 8,000 schema tokens, FR-196), skill roots and shadowed skills, Nova-as-MCP-server clients (per-client scoped tokens, FR-192), import from other assistants (FR-200) |
| **Network** | egress allowlist, proxy mode (`allowlist` \| `limited`, FR-193), SOCKS5 for non-HTTP clients, private-IP access, dev-server ports |
| **Data** | retention overrides, export, delete, storage usage, backup folder, import ledger (FR-200) |
| **Sync** | enable, devices, passphrase, history/merge log, E2EE status |
| **Advanced** | feature flags with their stage (ADR-082: `experimental` off and hidden outside developer mode, `beta` off and listed, `stable` on, `deprecated` still honoured with a warning, `removed` rejected at load), log level, developer mode, diagnostics, telemetry export over OTLP (endpoint, signals, include content; off by default, FR-223), reset |

### 1.2 Settings UI

- Grouped left nav; search across all settings; each control has a label, description, and
  (when relevant) the managed-policy override indicator.
- Changes apply immediately; a "Revert" affordance for the current session.
- Export/import settings as JSON (secrets excluded).
- A "Reset section" action; "Reset all" requires typed confirmation.

## 2. Theming (FR-010/011)

### 2.1 Tokens

```css
:root {
  /* color */
  --u-bg: #0e0f12;            --u-surface: #16181d;      --u-surface-2: #1d2026;
  --u-border: #2a2e37;        --u-text: #e8eaf0;          --u-text-muted: #9aa1b0;
  --u-accent: #6c8cff;        --u-accent-contrast: #0b0d12;
  --u-success: #3fb950;       --u-warn: #d29922;          --u-danger: #f85149;  --u-info: #58a6ff;
  /* geometry */
  --u-radius-sm: 6px; --u-radius-md: 10px; --u-radius-lg: 16px; --u-radius-xl: 24px;
  --u-space-1: 4px; --u-space-2: 8px; --u-space-3: 12px; --u-space-4: 16px; --u-space-6: 24px;
  /* type */
  --u-font-ui: system-ui, sans-serif; --u-font-code: "JetBrains Mono", monospace;
  --u-text-xs: 12px; --u-text-sm: 13px; --u-text-md: 14px; --u-text-lg: 16px; --u-text-xl: 20px;
  /* motion */
  --u-dur-fast: 120ms; --u-dur: 180ms; --u-dur-slow: 240ms; --u-ease: cubic-bezier(.2,.8,.2,1);
  /* z */
  --u-z-base: 0; --u-z-sticky: 10; --u-z-overlay: 100; --u-z-modal: 1000; --u-z-toast: 2000;
}
```

### 2.2 Theme file

```json
{
  "schemaVersion": 1,
  "id": "com.example.midnight",
  "name": "Midnight",
  "variant": "dark",
  "tokens": { "--u-bg": "#08090c", "--u-accent": "#8ab4ff" },
  "fonts": { "--u-font-code": "\"Fira Code\", monospace" }
}
```

- Built-ins: `system`, `light`, `dark`, `high-contrast-light`, `high-contrast-dark`.
- Import/export/copy; share via `nova://theme?data=<base64>`.
- Themes are validated against the token schema; unknown tokens are ignored, missing tokens
  fall back to the active base theme.
- **No hard-coded colors** in components; a lint rule enforces token usage.

### 2.3 Pets (FR-012)

- A pet is a declarative sprite/manifest (JSON + WebP/APNG frames) with states: idle, thinking,
  working, success, error, waiting.
- Pets are optional, non-blocking, respect reduced-motion, and can be muted/positioned.
- The app ships one original default pet; the marketplace can provide more (community).

## 3. Keybindings (FR-004)

- A registry of commands (id, title, category, default binding per platform, when-clause).
- Settings → Keyboard: search by command or by pressing keys; per-command rebinding with
  conflict detection; reset one/all; import/export.
- `when`-clauses scope bindings (e.g., `terminalFocus`, `diffOpen`, `mode == code`).
- Default map in `docs/04` §5.

## 4. Extension SDK (FR-117)

### 4.1 Extension points

| Point | API |
| --- | --- |
| Commands | `nova.commands.register({id,title,run})` |
| Panels | `nova.panels.register({id,title,resource,entryPoint,extensions?})`: an MCP Apps `ui://` resource shown at entry point `global` \| `thread` \| `file`; `extensions` (for example `[".lcov"]`) is required for `file` and not allowed otherwise (ADR-066, `docs/08` §3.1, `contracts/schemas/plugin-manifest.json`) |
| Tools | `nova.tools.register({name,title,description,inputSchema,outputSchema?,annotations?,handler})`: the descriptor fields of `contracts/schemas/tool-descriptor.json` |
| Hooks | `nova.hooks.register({id,event,matcher?,handler})`: lifecycle hooks with the events, effects and limits of `docs/08` §4.1 (FR-197) |
| Themes | `nova.themes.register(theme)` |
| Keybindings | `nova.keybindings.register(binding)` |
| Events | `nova.events.on('thread.message'\|'run.end'\|'tool.call'\|…)`: observe only; cannot block, answer or change anything (use hooks for that) |
| Context menus | `nova.menus.register({where,items})` |
| Status bar | `nova.status.addItem({id,text,onClick})` |

### 4.2 Sandbox & permissions

- Extensions declare permissions in their manifest (network hosts, fs scopes, secrets,
  commands, panels, tools with their action class, hooks). Undeclared access is denied at
  runtime.
- UI extensions use the **MCP Apps bridge** (ADR-066): a `ui://` HTML resource in a sandboxed
  iframe on its own opaque origin, JSON-RPC over `postMessage`, a CSP built from declared
  domains and intersected with the extension's network permissions, and no direct DOM access
  to the host. The SDK publishes panel resources as MCP resources of the extension, so
  panels and MCP-server UIs share one implementation (`docs/08` §3.1). Every tool call from a
  panel passes the policy engine; private widget state is never sent to the model.
- Hooks registered through the SDK are trusted per hook by content hash, like every hook
  (`docs/08` §4.1); for an SDK hook the hash covers its definition and the extension bundle
  that implements it, so an update that changes the bundle needs re-trust before its hooks run. SDK hooks are subject to the
  same tighten-only limits as any hook (ADR-068).
- Tool/command handlers run in a worker with the same policy engine; they are auditable.
- API is versioned (`nova.api = 1`); breaking changes require a new major version and a
  compatibility shim for one release cycle.

### 4.3 SDK packaging

- `@nova/sdk` npm package (types + client), a template repo, and a local `nova dev`
  command for hot-reload.
- `nova validate <path>` checks manifest, schema, permissions, and signature, plus skill
  front-matter (`docs/08` §4), hook definitions, and that UI CSP domains fall within the
  declared network permissions.
- `nova pack` produces a signed `.novax` bundle.

## 5. Marketplace (FR-049)

- Tabs: Plugins, Skills, Themes, Pets, MCP servers (registry entries and MCP bundles, FR-199).
- Card: name, author, version, permissions ("This plugin can access: network → api.github.com,
  files → your project"), screenshots, changelog, install/update/remove.
- Card details also list hooks (with their events), sub-agent roles, browser extensions and UI
  entry points a plugin brings.
- Sources: the remote catalog, **Git-hosted catalogs** (a Git URL and optional ref; entries
  pinned to a commit SHA) and local catalog directories (`docs/08` §7).
- Security: catalog signature verified for every source; plugin and bundle signatures
  verified; permission **diff** shown on update; failed installs roll back. Unsigned items or
  unknown signers install only through an explicit sideload confirmation and stay labelled
  **Unverified**.
- Offline: a local catalog directory can be added in Settings → Advanced.
- No telemetry about installs leaves the device unless the user opts in.

## 6. Profile & usage (FR-113/114)

- Profile: display name, username, avatar, optional public profile card (sharing is opt-in).
- Usage insights (local-only): tokens by provider/model/day, estimated cost, active-day streak,
  longest task, per-project breakdown, cache savings.
- Spend caps per provider with warnings at 80% and a hard stop at 100% (configurable).
- All insights are computed from `usage_event`; a "clear usage data" action exists.

## 7. New settings sections (added)

| Section | Keys |
| --- | --- |
| **Devices** | registered devices/nodes, roles, scopes, wake, revoke, per-device overrides |
| **Network** | transports (LAN/Mesh/Relay), trust mode, certs, egress, wake helpers, diagnostics |
| **Ambient** | enable screen/mic/system-audio, quality, OCR/STT backends, cloud option, exclusions, retention, pause hotkey |
| **Automations** | list, enable/disable, dry-run, logs, versions, default approval rules |
| **Smart Home** | integrations (HA/MQTT/vendor), areas/rooms, scenes, allowed entity classes |
| **Learning** | memory review, skill proposals, optimization proposals, tuning bounds, self-modification guardrail (on by default), kill switch |
| **Catalog** | catalog URLs (public + tailnet + local + Git-hosted), trusted publishers, allowed types, sideloading (explicit confirmation; items labelled Unverified) |
