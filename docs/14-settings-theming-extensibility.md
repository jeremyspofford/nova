# 14 — Settings, Theming & Extensibility

## 1. Settings model

Settings are stored in the `setting` table (scoped global/project/workspace) and resolved with
precedence: **built-in default → user global → user project → managed policy**. Environment
variables may override only in developer mode.

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
| **Work** | default autonomy, max sub-agents, run budget, approval timeout |
| **Code** | default permission mode, default environment, auto-verify, review-before-commit, dev-server auto-start, worktree cleanup |
| **Agents** | proactive research toggle/frequency, default rules, connected computer, channels |
| **Memory** | retention, extraction on/off, embedding provider, review frequency |
| **Tools & MCP** | server list, per-tool defaults, timeouts, plugin permissions |
| **Network** | egress allowlist, proxy, private-IP access, dev-server ports |
| **Data** | retention overrides, export, delete, storage usage, backup folder |
| **Sync** | enable, devices, passphrase, history/merge log, E2EE status |
| **Advanced** | feature flags, log level, developer mode, diagnostics, reset |

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
| Panels | `nova.panels.register({id,title,mount})` (sandboxed webview) |
| Tools | `nova.tools.register({name,schema,handler})` |
| Themes | `nova.themes.register(theme)` |
| Keybindings | `nova.keybindings.register(binding)` |
| Events | `nova.events.on('thread.message'\|'run.end'\|'tool.call'\|…)` |
| Context menus | `nova.menus.register({where,items})` |
| Status bar | `nova.status.addItem({id,text,onClick})` |

### 4.2 Sandbox & permissions

- Extensions declare permissions in their manifest (network hosts, fs scopes, secrets,
  commands, panels). Undeclared access is denied at runtime.
- UI extensions render in an isolated iframe/webview with a typed `postMessage` bridge; no
  direct DOM access to the host.
- Tool/command handlers run in a worker with the same policy engine; they are auditable.
- API is versioned (`nova.api = 1`); breaking changes require a new major version and a
  compatibility shim for one release cycle.

### 4.3 SDK packaging

- `@nova/sdk` npm package (types + client), a template repo, and a local `nova dev`
  command for hot-reload.
- `nova validate <path>` checks manifest, schema, permissions, and signature.
- `nova pack` produces a signed `.novax` bundle.

## 5. Marketplace (FR-049)

- Tabs: Plugins, Skills, Themes, Pets, MCP servers.
- Card: name, author, version, permissions ("This plugin can access: network → api.github.com,
  files → your project"), screenshots, changelog, install/update/remove.
- Security: catalog signature verified; plugin signature verified; permission **diff** shown
  on update; failed installs roll back.
- Offline: a local catalog directory can be added in Settings → Advanced.
- No telemetry about installs leaves the device unless the user opts in.

## 6. Profile & usage (FR-113/114)

- Profile: display name, username, avatar, optional public profile card (sharing is opt-in).
- Usage insights (local-only): tokens by provider/model/day, estimated cost, active-day streak,
  longest task, per-project breakdown, cache savings.
- Spend caps per provider with warnings at 80% and a hard stop at 100% (configurable).
- All insights are computed from `usage_event`; a "clear usage data" action exists.
