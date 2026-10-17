# 14 — Settings, Theming & Extensibility

## 1. Settings model

Settings are stored in the `setting` table (scoped global/project/workspace) and resolved with
precedence: **built-in default → user global → user project → managed policy**. Environment
variables may override only in developer mode.

**Security-relevant keys are not project-settable.** A project-scoped value, whether set in the
app or read from a project's `.nova/` folder, cannot change these keys: sandbox and permission
profile (FR-190), egress allowlist and proxy mode (FR-102, FR-193), whether cloud models may
be used (`routing.allowCloud`), approval policy, permission mode defaults and "Always allow"
rules (FR-063, FR-100), instruction root markers and the instruction budget (FR-185), the
hook trust list (FR-197), plugin catalog sources (`plugins.catalogs`, FR-049) and whether
Nova's own MCP server is on (`mcpServer.enabled`, FR-044). They resolve only from the
built-in default, user global settings and managed policy. A project value for one of them is
ignored, and Diagnostics shows a warning naming the key and the project.

### 1.1 Settings map

| Section | Keys |
| --- | --- |
| **General** | language, enter-to-send (`enter`\|`mod+enter`), prevent-sleep, follow-up behavior (`general.followUp`: `steer`\|`queue`, default `queue`, FR-019), temporary-chat retention (`chat.temporaryTtlHours`, default 24, FR-027), suggested follow-ups ("Suggest follow-ups", `chat.suggestions`, default on, FR-028), restore-session, check-updates |
| **Profile & usage** | display name, username, avatar (PNG, JPEG or WebP up to 2 MB, metadata stripped; FR-113), usage insights (§6, FR-114) |
| **Accounts** | provider accounts, active account per provider kind ("Active <kind> account" when a kind has more than one, FR-115), default model, spend caps; display name moved to Profile & usage in M4 |
| **Models** | presets from Faster to Smarter (`models.presets`; empty = generated built-ins, FR-221), local model server detection, routing order (`routing.order`, FR-127), allow cloud models (`routing.allowCloud`, security-relevant) |
| **Devices** | compute nodes: add (one-use enrollment token), status, models, load, revoke (FR-126) |
| **Appearance** | theme, accent, background, foreground, uiFont, codeFont, fontSize, density, sidebarWidth, reducedMotion, highContrast; theme export and import with saved themes (`appearance.customThemes`, at most 50, §2.2, FR-011) |
| **Pets** | enabled, petId, position, size, reactions, mute |
| **Keyboard** | bindings map, reset, search |
| **Notifications** | per-category (completion, approval, error, scheduled), OS permission, quiet hours |
| **Chat** | default reasoning, citations, suggested prompts |
| **Work** | default autonomy, max sub-agents, run budgets (time, tokens, cost; FR-182), approval timeout, chat escalation (`propose` (default) \| `auto` \| `off`, FR-186) |
| **Code** | default permission mode, default environment, auto-verify, review-before-commit, dev-server auto-start, worktree cleanup, worktree include file (copy files listed in `.worktreeinclude`, on by default), worktree limit per repo (default 15) (FR-073) |
| **Agents** | proactive research toggle/frequency, default rules, connected computer, channels, self-scheduling limits (minimum interval 5 min, horizon 30 days, max 24 self-set wakes per day, FR-206) |
| **Memory** | use saved memories (`memory.enabled`), the item list (correct, pin, dismiss, delete, add, import; FR-032), retention, extraction on/off, embedding provider, review frequency, reference past chats (on/off; off purges derived data within 30 days, FR-205), default project memory scope (`shared` \| `project_only`), background consolidation (on/off, idle delay, summary budget 2,500 tokens, FR-204) |
| **Tools & MCP** | server list and per-server settings (`startupTimeoutMs`, `toolTimeoutMs`, `enabledTools`/`disabledTools`, `required`, `defaultApproval`, `deferred`, `oauth`; `contracts/schemas/mcp-config.json`, `docs/08` §2.1), OAuth sign-in, reconnect and sign-out for remote servers (FR-047), **Install a bundle** (FR-199), per-tool and per-action defaults, approval rules ("Always allow" list, revocable, FR-100), deferred-tool budget (default 40 tools or 8,000 schema tokens, FR-196), a link to Plugins & skills for hooks |
| **Plugins & skills** | installed plugins (status, Verified/Unverified, permissions, on/off, update, uninstall; FR-045), catalog search and catalog sources (`plugins.catalogs`: a folder on the Hub, an https URL or a Git URL; security-relevant), install from a folder or Git with the sideload confirmation (FR-049), skills (source, shadowed by, on/off, view, create and delete user and project skills; FR-046), **Hooks**: the hook trust list (id, source, event, matcher, command, hash, status, "Changed since you trusted it", last run; trust, untrust, on/off for user hooks; FR-197) |
| **Apps & clients** | Nova's MCP server on or off (`mcpServer.enabled`, default off, security-relevant), its clients (tools, projects, chat access, read-only or run-allowed, expiry of 7, 30, 90 (default) or 365 days or never; per-client tokens shown once; revoke; FR-044, FR-192) |
| **Import** | the import wizard and the import records (FR-200, `docs/04` §2.11) |
| **Workspace** (no page) | `workspace.layout`: the pane layout per mode, written by the workspace and restored on start (FR-005, `docs/04` §4.3) |
| **Network** | egress allowlist, proxy mode (`allowlist` \| `limited`, FR-193), SOCKS5 for non-HTTP clients, private-IP access, dev-server ports |
| **Data** | retention overrides, export, delete, storage usage, backup folder, import ledger (FR-200) |
| **Sync** | enable, devices, passphrase, history/merge log, E2EE status |
| **Advanced** | feature flags with their stage (ADR-082: `experimental` off and hidden outside developer mode, `beta` off and listed, `stable` on, `deprecated` still honoured with a warning, `removed` rejected at load), log level, developer mode, diagnostics, telemetry export over OTLP (endpoint, signals, include content; off by default, FR-223), reset |

*As shipped in M5* (ADR-092): the Work keys live in Settings → General → **Work runs**, and the
Code keys in a new Settings → **Code** section (`/settings/code`). Security-relevant keys resolve
only from defaults, user global settings and managed policy; a managed value shows as locked.

| Key | Default | Where | Notes |
| --- | --- | --- | --- |
| `runs.defaultBudgets` | `{timeSeconds: 3600, tokens: 2000000, costUsd: null}` | General → Work runs: "Time budget (minutes)", "Token budget", "Cost limit (US dollars)" | Budgets of a new run; a blank cost means the provider spend cap (FR-182) |
| `runs.autonomy` | `standard` | General → Work runs: "Autonomy of new runs" | `ask_first`, `standard` or `autonomous` |
| `chat.escalation` | `propose` | General → Work runs: "Turn multi-step chat requests into runs" | `propose`, `auto` or `off` (FR-186) |
| `runs.subagents` | `{maxChildren: 6, maxConcurrent: 4}` | no page | Security-relevant; children per run (finished ones count) and running at once (FR-053) |
| `code.permissionMode` | `manual` | Code: "Permission mode for new sessions" | `manual`, `accept_edits`, `auto` or `bypass`; Plan is per session only |
| `code.folderModes` | `{}` | no page | The mode last used in each folder (at most 200); Plan is never remembered |
| `code.allowBypass` | `false` | Code: "Allow Bypass mode" | Security-relevant; Bypass also needs a container or micro-VM substrate |
| `review.model` | none | Code: "Reviewer model" | Security-relevant; the auto-reviewer's model. Auto mode needs it, and under `review` without it every consequential action is denied (FR-085) |
| `context.compactThreshold` | `0.8` | no page | Share of the model limit that triggers compaction, 0.3 to 0.95, per project (FR-183) |
| `instructions.files` | `{rootMarkers: ['.git'], fallbackNames: [], budgetBytes: 32768}` | no page | Security-relevant; instruction-file root markers, fallback names and budget (FR-185) |
| `exec.sessions` | `{yieldMs: 10000, outputTokens: 10000}` | no page | Interactive exec yield time and output cap (FR-184) |

`policy.approvalTimeoutMinutes` (24 h) also bounds how long a `ask_user` question waits. The
default environment, auto-verify, review-before-commit, dev-server auto-start, worktree cleanup,
the worktree include file, the worktree limit (fixed at 15) and the Work rows "max sub-agents" and
"approval timeout" have no control in M5. `code.permissionMode` is not security-relevant as
shipped, so a project value can set it, although §1 lists permission mode defaults among the keys
a project cannot change.

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
- *As shipped in M4* (ADR-091): Settings → Appearance exports the current look as a theme file or
  a `nova://theme?data=` link, and imports a file or pasted text. An import is checked against
  the schema; low contrast gives a warning but does not block saving. Saved themes go to
  `appearance.customThemes`. **Use** sets the saved theme's base theme plus its background,
  text, accent and fonts where they differ from the base, and derives the other colors, so a
  custom palette is not yet applied token for token; a setting that applies a saved theme
  fully (`appearance.customTheme`) comes later.
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
- Offline: a local catalog directory can be added in Settings → Advanced. In M4 catalogs live in
  Settings → Plugins & skills → Catalog (`plugins.catalogs`), and the built-in sample catalog
  works offline.
- No telemetry about installs leaves the device unless the user opts in.

## 6. Profile & usage (FR-113/114)

- Profile: display name, username, avatar, optional public profile card (sharing is opt-in).
- Usage insights (local-only): tokens by provider/model/day, estimated cost, active-day streak,
  longest task, per-project breakdown, cache savings.
- Spend caps per provider with warnings at 80% and a hard stop at 100% (configurable).
- All insights are computed from `usage_event`; a "clear usage data" action exists.

*As shipped in M4* (ADR-091): Settings → Profile & usage shows the name, a unique username and
the avatar, then usage for the last 7, 30, 90 or 365 days: input, output and cached tokens,
estimated cost and turns; day bars for tokens and cost (each with a table view); active days;
the streak (consecutive UTC days with use, broken only after a whole day without use); the
longest task, linking to its chat; and tables by model and by project. Days are UTC days. The
public profile card, spend caps, entitlements and limits, and "clear usage data" come later.

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
