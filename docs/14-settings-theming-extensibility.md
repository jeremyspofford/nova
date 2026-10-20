# 14 — Settings, Theming & Extensibility

## 1. Settings model

Settings are stored in the `setting` table (scoped global/project/workspace) and resolved with
precedence: **built-in default → user global → user project → managed policy**, managed policy
winning and locking the key (§1.3 as built in M8). Environment variables configure the process and
never override a setting.

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
| **General** | language (in Appearance → Language since M8, §2.4), enter-to-send (`enter`\|`mod+enter`), prevent-sleep, follow-up behavior (`general.followUp`: `steer`\|`queue`, default `queue`, FR-019), temporary-chat retention (`chat.temporaryTtlHours`, default 24, FR-027), suggested follow-ups ("Suggest follow-ups", `chat.suggestions`, default on, FR-028), restore-session, check-updates |
| **Profile & usage** | display name, username, avatar (PNG, JPEG or WebP up to 2 MB, metadata stripped; FR-113), usage insights (§6, FR-114); spend caps and "Clear usage data" (M8, §6, FR-116) |
| **Accounts** | provider accounts, active account per provider kind ("Active <kind> account" when a kind has more than one, FR-115), default model, each provider's plan, last reported limit, this month's spend and its cap (M8; caps are edited on Profile & usage); display name moved to Profile & usage in M4 |
| **Models** | presets from Faster to Smarter (`models.presets`; empty = generated built-ins, FR-221), local model server detection, routing order (`routing.order`, FR-127), allow cloud models (`routing.allowCloud`, security-relevant) |
| **Devices** | compute nodes: add (one-use enrollment token), status, models, load, revoke (FR-126); **Firmware and boot** (M7.5: the firmware, low-level boot and network boot switches, below) |
| **Appearance** | theme, accent, background, foreground, uiFont, codeFont, fontSize, density, sidebarWidth, reducedMotion, highContrast; theme export and import with saved themes (`appearance.customThemes`, at most 50) and the saved theme in use (`appearance.customTheme`, §2.2, FR-011); the interface language (`appearance.locale`, §2.4, FR-016) |
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
| **Extensions** (M8) | the "Run extensions" switch (`sdk.enabled`), installed extensions (status, publisher, Verified/Unverified, permissions, hooks and their trust, secrets, app screens, on/off, uninstall with or without data), install from a `.novax` or a path on the Hub (§4, FR-117) |
| **Apps & clients** | Nova's MCP server on or off (`mcpServer.enabled`, default off, security-relevant), its clients (tools, projects, chat access, read-only or run-allowed, expiry of 7, 30, 90 (default) or 365 days or never; per-client tokens shown once; revoke; FR-044, FR-192) |
| **Authorized apps** (M8) | "Let apps ask for access" (`apps.enabled`), the sign-in metadata address, apps you allowed (scopes, return addresses, devices, last used, revoke), registered apps nobody authorizes (remove) (FR-222) |
| **Managed policy** (M8) | how a setting is decided, the policy sources and their status, restrictions, settings the policy sets, keys not applied; "Check for changes" (owner) (FR-106, `docs/12` §10) |
| **Import** | the import wizard and the import records (FR-200, `docs/04` §2.11) |
| **Workspace** (no page) | `workspace.layout`: the pane layout per mode, written by the workspace and restored on start (FR-005, `docs/04` §4.3) |
| **Network** | egress allowlist, proxy mode (`allowlist` \| `limited`, FR-193), SOCKS5 for non-HTTP clients, private-IP access, dev-server ports |
| **Data** | retention overrides, export, delete, storage usage, backup folder, import ledger (FR-200). *As built in M8*: what the Hub holds, export (optional passphrase), import into an empty Hub, retention per item and "Sweep now", crash reports, delete all data (FR-105, FR-121, `docs/12` §9); storage usage and a backup folder are not built |
| **Sync** | enable, devices, passphrase, history/merge log, E2EE status (as built in M7: this device's copy, changes waiting to send, devices with a copy, History with Restore; no passphrase, `docs/13` §2) |
| **Account** (M7) | linked OIDC identities (link and unlink), the public profile card and its preview (`docs/13` §7) |
| **Members** (M7) | people and roles; for the owner, invitations (one-use link shown once, chosen expiry, withdraw), removing a member, OIDC providers (`docs/13` §7) |
| **Cloud runner** (M7) | the runner's URL, a write-only token, test, on/off, forget, caps, unrestricted network; cloud environments, their runs and snapshots (`docs/13` §3) |
| **Experimental** (M7) | `script.run` and its limits, external agent adapters (FR-202, FR-203) |
| **Telemetry export** (M8) | OTLP export: on/off (off by default), collector address, write-only headers, signals, include content, test, status (FR-223, `docs/16` §1.1) |
| **Advanced** | feature flags with their stage (ADR-082: `experimental` off and hidden outside developer mode, `beta` off and listed, `stable` on, `deprecated` still honoured with a warning, `removed` rejected at load), log level, developer mode, diagnostics, reset; telemetry export over OTLP moved to its own section in M8 |

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

*Added in M6* (ADR-093). The keys are in `packages/shared/src/settings.ts` (the `// ---- M6`
blocks); the pages that show them arrive with the M6 web UI. "Security" marks a security-relevant
key (defaults, user global settings and managed policy only).

| Key | Default | Security | Notes |
| --- | --- | --- | --- |
| `agents.defaultBudgets` | `{timeSeconds: 1800, tokens: 500000, costUsd: null}` | no | Budgets of a new agent's turn chains (a turn plus its hook continuations); time 60 s to 7 days, tokens 1,000 to 100M, `null` cost = the provider spend cap (FR-182) |
| `agents.autonomy` | `standard` | no | Autonomy of a new agent: `ask_first`, `standard` or `autonomous` |
| `agents.proactive` | `{enabledByDefault: true, intervalMinutes: 60}` | no | Proactive research on for new agents, at most once per interval (15 min to 7 days) while idle (FR-082) |
| `agents.wakes` | `{minMinutes: 5, horizonDays: 30, perDay: 24}` | yes | `schedule.wake`: the soonest (5 to 1,440 min), the furthest ahead (1 to 30 days) and how many per agent per day (0 to 24) (FR-206) |
| `channels.privateToShared` | `ask` | yes | A shared-channel reply that uses private content: `ask` the owner, `allow` or `deny` (FR-088, §4 of `docs/13`); notification copies go to a shared binding only under `allow` |
| `channels.publicUrl` | `null` | yes | The address Slack, Teams and MCP event servers reach the Hub at; unset uses the Hub address. The Hub answers to its host |
| `triggers.ratePerHour` | `30` | yes | Most runs or wakes one event trigger may start per hour (1 to 10,000); further events are skipped (FR-056) |
| `network.egressMode` | `allowlist` | yes | `off`, `allowlist` or `limited` (allowed hosts, read-only methods) for every sandbox's egress proxy and the agent browser's (FR-193) |
| `network.egressDeny` | `[]` | yes | Hosts no sandbox, agent browser or tool network call may reach (at most 500); deny always wins over allow (FR-193). `network.egressAllow` (M3) is the global allow list; both take the proxy's host patterns, and a stored list that fails them resolves to `[]` |
| `computers.agentComputer` | `local_container` | yes | Where a new agent's computer runs: a sandbox on this Hub, or `cloud` (a mock runner on the Hub in M6) (FR-080) |
| `computers.limits` | `{cpus: 2, memoryMb: 2048, wallClockSeconds: 300}` | yes | Limits of every command on a computer (CPU 0.25 to 64, memory 256 MB to 256 GB, wall clock 10 s to 1 day; `docs/11` §8) |
| `computers.microVm` | `{enabled: false, runner: null}` | yes | Micro-VM sandboxes (FR-195): off; they need a KVM runner on the Hub. M6 ships a stub |
| `browser.persistCookies` | `false` | yes | Keep the agent browser's cookies (its sign-ins) between sessions (FR-096) |
| `browser.allowLocalSites` | `false` | yes | Let the agent browser open local and private-network addresses of sites allowed by exact name (never through a wildcard; `docs/12` §8); a Code session's granted dev server opens without it |
| `browser.devProtocol` | `true` | yes | Allow developer-protocol mode to be turned on per site; off means no site can use it (FR-094) |
| `browser.maxConcurrent` | `2` | no | Agent browsers open at once (1 to 8; `docs/11` §8) |
| `browser.screenshotRetentionDays` | `30` | no | How long browser before/after screenshots are kept (swept every 6 hours) |
| `browser.executablePath` | `null` | yes | An absolute path to a Chromium executable; `null` uses the one installed for Playwright (FR-092) |
| `screen.grantMinutes` | `30` | yes | How long a computer-use app grant lasts (1 to 1,440), renewable (FR-207) |
| `screen.killKey` | `Escape` | no | The kill key; a key or a combination like `ctrl+alt+k`; it can be remapped, never unbound (FR-207) |
| `screen.tierOverrides` | `{}` | yes | Per app name: `none`, `view`, `click` or `full`; an override can only lower an app's tier (FR-207) |
| `screen.screenshotRetentionDays` | `30` | no | How long computer-use screenshots are kept (pruned daily) |
| `devices.minNovadVersions` | `{}` | yes | Raise the minimum `novad` version for a capability (`files`, `staged_writes`, `exec`, `mcp`, `power`, `services`, `updates`, `computer_use`, `browser`, `capture`); the built-in minimums are 0.6.0, 0.7.0 for computer use and browser, 0.8.0 for capture (FR-148) |
| `devices.wakesPerHour` | `6` | no | Wake-on-LAN requests per device per hour (1 to 60, FR-144) |
| `code.autoVerify` | `{enabled: true, commands: [], timeoutSeconds: 600, feedbackTurns: 1}` | yes | Auto-verify after a turn edits files (FR-068); it names commands Nova runs on its own, so a project cannot set it: commands (empty detects the build script and test suite, at most 10), timeout 30 s to 1 h, failed checks sent back 0 to 3 times in a row |
| `code.worktreeCleanup` | `remove_clean` | no | When a session is archived: remove a clean worktree, or `keep` it; dirty ones are always kept (FR-073) |
| `code.ciPollSeconds` | `60` | no | How often open pull requests are polled for CI (15 s to 1 h, FR-070) |
| `code.ciFeedback` | `true` | no | Send failed CI checks of a session's pull request back to its agent (FR-070) |
| `code.budgets` | `{timeSeconds: null, tokens: null, costUsd: null}` | no | Default bounds of a new Code session; none by default (`docs/09` §2) |
| `spaces.agentEdits` | `propose` | no | How agent edits land in a new space: proposals the user accepts, or `direct` versions (FR-036) |
| `sites.publishRoot` | `null` | yes | An absolute folder on the Hub that site folders are published into; `null` uses `<data>/sites` (FR-037) |
| `appearance.pet` | `off` | no | The optional companion: `off`, `sprout` or `spark` (FR-012) |
| `appearance.petPosition` | `bottom-right` | no | `bottom-right` or `bottom-left` |
| `appearance.petMuted` | `false` | no | "Keep still": no reactions and no animation |

The **Pets** row above is realized as the three `appearance.pet*` keys; the pets are Nova's own
drawings, not sprite manifests, and reduced motion gives a static pose. Quiet hours and the
per-category notification routing are not settings: they are stored in the `quiet_hours` and
`notification_rule` tables (`docs/06`) and edited through `/api/v1/quiet-hours` and
`/api/v1/notification-rules`, because Hub areas cannot write settings. SOCKS5, per-scope site
levels and a dev-server port grant have no setting yet.

*Added in M6.5* (ADR-094). The keys are in `packages/shared/src/settings.ts` (the `// ---- M6.5`
blocks). Settings → Devices shows the two `devices.add.*` keys under "Adding devices"; Network
(`/network`) edits the others through `PATCH /api/v1/network`, `PATCH /api/v1/trust` and
`PATCH /api/v1/relay`, which write these keys (so each change is audited and, for `network.*` and
`trust.*`, can be rolled back), and the host-changes switch sits at the top of Network → Setup.
A change through `PATCH /api/v1/settings` applies at once too.

| Key | Default | Security | Notes |
| --- | --- | --- | --- |
| `devices.add.enabled` | `true` | yes | Allow adding devices with a code or QR; off, new pairings and joins are refused (`add_device_disabled`) (FR-132) |
| `devices.add.sessionDays` | `30` | yes | How long a browser's or app's device session lasts (1 to 365 days) before it must be added again (FR-132) |
| `network.transports` | `{lan: true, mesh: true, relay: true, directPublic: false}` | yes | Which transports the Hub advertises, tried LAN → Mesh → Relay → Direct public; turning one off only stops advertising it, and at least one stays on (FR-135) |
| `network.lan.mdns` | `true` | yes | Announce `_nova._tcp` on the LAN (TXT: only `v=1` and the Hub fingerprint) while the Hub listens beyond loopback |
| `network.lan.mdnsName` | `null` | yes | The mDNS name, a DNS label (`<name>.local`); `null` uses the host name's first label |
| `network.lan.includeLoopback` | `false` | yes | Also list loopback addresses as LAN endpoints (useful only on the Hub itself) |
| `network.lan.includeLinkLocal` | `false` | yes | Also list IPv4 link-local addresses (169.254.x.x) as LAN endpoints |
| `network.directPublic.url` | `null` | yes | The Hub's public address (a plain http(s) URL, no credentials, query or fragment); required while Direct public is on, advertised last and only while it passes its test |
| `network.healthCheckSeconds` | `60` | no | How often each endpoint is tested (10 to 3,600 s) |
| `network.wakeHelpers` | `[]` | yes | Wake Helper device ids to use, in order (at most 50); empty uses any active helper on the target's subnet (FR-138) |
| `network.setup.allowSystemChanges` | `false` | yes | Let Network Setup run mesh, firewall and package commands on the Hub; off, it detects and plans only (rollback still works) (FR-136) |
| `trust.mode` | `none` | yes | `none` (plain HTTP unless `NOVA_TLS_CERT`), `local-ca` or `mesh`; turning HTTPS on or off applies at the next start. Onboarding does not set it yet (FR-134) |
| `trust.meshCerts` | `true` | yes | With the local CA, also serve the mesh certificate to clients that name the mesh host |
| `trust.pinNativeShells` | `true` | yes | Native shells must match the identity key they pinned at Add Device before they trust the Hub's certificate; the signed identity statement says `pinning: off` otherwise |
| `relay.enabled` | `false` | yes | Connect out to a Relay; nothing is contacted while it is off (FR-137) |
| `relay.url` | `''` | yes | The Relay: `wss://` or `https://` (`ws://` or `http://` only to this machine), no credentials, query or fragment; empty for none |
| `relay.selfHosted` | `true` | yes | The Relay is your own; off with no URL uses the hosted `wss://relay.arialabs.ai` |

*Added in M7* (ADR-095). The keys are in `packages/shared/src/settings.ts` (the `// ---- M7`
blocks). Where each one is shown: Settings → Sync (the `sync.*` keys), Settings → Cloud runner
(the `cloud.runner.*` keys, written through `PUT/PATCH /api/v1/cloud/runner`; the network switch
asks first and shows the setting's own description), Settings → Code (`code.ssh.enabled`, which
asks first, `code.handoffSource`, `code.attempts`), Settings → Channels and the notification
routing (`channels.email.pollSeconds`, `channels.approvalLinkMinutes`), Settings → Notifications
under "For every device" (`push.enabled`, `push.detail`), Settings → Members and Account
(`team.invitationHours`; `team.publicProfiles` asks before turning on), Settings → Experimental
(`scripts.*`, `externalAgents.enabled`, each asking before turning on), Devices → Device
certificates (`devices.tls.allowWithoutCertificate`, shown inverted as "Require a device
certificate", naming the devices that would be refused first) and Network → Relay (the
registration token, written through `PUT /api/v1/relay/registration-token`). Members cannot read
or write any Hub setting; they keep their own `appearance.*`, `keyboard.*` and `onboarding.*`
keys through `/api/v1/team/me/settings` (`docs/13` §7). Security settings never sync to a device
(`docs/13` §2.1).

| Key | Default | Security | Notes |
| --- | --- | --- | --- |
| `sync.enabled` | `true` | yes | Devices granted an offline replica may sync it; off refuses every replica sync call, the merge log and restore (FR-109, FR-129) |
| `sync.maxSkewSeconds` | `300` | yes | How far ahead of the Hub a pushed change may be clocked (10 to 3,600 s); later ones are refused (`clock_skew`) so a fast clock cannot win forever |
| `sync.mergeLogDays` | `90` | no | How long overwritten values stay in the merge log for restore (1 to 3,650 days) |
| `sync.offlineAfterMinutes` | `10` | no | A replica that has not pulled or pushed for this long shows as offline (1 to 1,440) |
| `cloud.runner.enabled` | `false` | yes | Run cloud environments' commands and files on the configured runner (FR-108, FR-071) |
| `cloud.runner.url` | `''` | yes | The runner: `https://`, or `http://` only to this machine, no credentials, query or fragment; empty for none |
| `cloud.runner.token` | `''` | yes | Only the vault reference `secret://cloud/runner/token` (`PUT /api/v1/cloud/runner` stores the token); never the token |
| `cloud.runner.caps` | `{cpuSeconds: 3600, wallSeconds: 14400, diskMb: 10240, warnAt: 0.8}` | yes | Caps per cloud run (CPU and wall time, 60 s to 7 days) and per environment (disk, 16 MiB to 1 TiB), with a warning at `warnAt` (0.5 to 0.99) and a hard stop at the cap (FR-116) |
| `cloud.runner.unrestrictedNetwork` | `false` | yes | Let cloud environments reach the network directly from the runner, without the Hub's egress proxy (no allowlist, no private-address block, no egress audit); off, cloud commands get no network and environments can be made only with network off |
| `code.handoffSource` | `keep` | no | After a session handoff is confirmed: `keep` or `clean` the uncommitted changes in the source (FR-213) |
| `code.attempts` | `{count: 2, budgets: {timeSeconds: 1800, tokens: null, costUsd: null}}` | no | Best-of-N: attempts per task (2 to 4) and each attempt's budget (FR-212) |
| `code.ssh.enabled` | `false` | yes | Reach SSH environments with this machine's ssh client and install Nova's helper under `~/.nova/remote` on the host (FR-062) |
| `channels.email.pollSeconds` | `60` | no | How often email bindings in polling mode check their mailbox, and how soon a dropped IDLE connection is opened again (15 to 3,600 s; FR-110) |
| `channels.approvalLinkMinutes` | `60` | yes | How long the signed one-use link in an approval email works (5 to 1,440), never past the approval itself |
| `push.enabled` | `true` | yes | Send OS notifications as push to subscribed browsers and, through the Relay, native apps (FR-111) |
| `push.detail` | `redacted` | yes | What a push says: `none` ("Nova"), `redacted` (a title per category) or `titles` (the notification title, encrypted to the browser); native pushes always get the redacted title |
| `push.webPushHosts` | `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com` | yes | The push services a browser subscription may point at (https only, 1 to 50 host patterns) |
| `push.vapidSubject` | `null` | no | The contact push services see in the VAPID token (`mailto:` or `https:`); unset uses the public Hub address |
| `scripts.enabled` | `false` | yes | Offer `script.run` (FR-202) |
| `scripts.limits` | `{cpuMs: 5000, memoryMb: 32, maxCalls: 20, logChars: 20000}` | yes | One script's CPU time (100 ms to 30 s), engine memory (8 to 128 MiB), nested tool calls (1 to 100) and console output (1,000 to 100,000 characters) |
| `externalAgents.enabled` | `false` | yes | Let Code sessions delegate to external coding agents over ACP (FR-203); turning it off stops running delegations |
| `devices.tls.allowWithoutCertificate` | `true` | yes | Over HTTPS, still accept `novad` devices and compute nodes that present no device certificate (a diagnostics problem); off, they are refused. On for one release (FR-126) |
| `relay.registrationTokenRef` | `''` | yes | The vault entry holding a private Relay's registration token; only `secret://relay/registration/…` is accepted (FR-137) |
| `team.invitationHours` | `72` | yes | How long a new invitation link is valid (1 to 720 hours); each works once |
| `team.publicProfiles` | `false` | yes | People of this Hub may publish a read-only public profile card (FR-113) |
| `agents.usageRetryMinutes` | `15` | no | How long an agent's goal stopped by a provider usage limit waits before trying again (1 to 1,440); each failed retry doubles the wait, up to 4 hours (FR-181) |

*Added in M7.5* (ADR-096). The keys are in `packages/shared/src/settings.ts` (the `// ---- M7.5`
blocks); every one is security-relevant and owner-only. Where each one is shown: Settings →
Devices → **Firmware and boot** (the two `devices.firmware.*` switches, the "Firmware watchdog"
`devices.firmware.watchdogSeconds`, `devices.boot.*` and `devices.pxe.enabled`; the firmware
switches are written through `PUT /api/v1/devices/firmware/policy`, the others through `PATCH
/api/v1/settings`), Devices →
Out-of-band (`/devices/oob`, the `devices.oob.enabled` switch, written through `POST
/api/v1/oob/enable` and `POST /api/v1/oob/disable`) and Settings → Browser (**Continue on your
computer**: `browser.localFallback` and the sites agreed to; **Your own browser (extension
bridge)**: the two `browser.extensionBridge*` keys). Managed policy can lock each one.

| Key | Default | Security | Notes |
| --- | --- | --- | --- |
| `devices.firmware.allowChanges` | `false` | yes | "Allow BIOS/firmware changes" (FR-146): off, planning, approval and applying are refused (`firmware_disabled`) and devices refuse changes too (the heartbeat answer's `policy.firmwareChanges`); reading a device's settings still works. Also governs out-of-band BIOS plans (FR-147). Turning it on needs `confirm: true` |
| `devices.firmware.allowSecurityDegrading` | `false` | yes | The separate override for firmware changes that weaken security (Secure Boot or the TPM turned off); without it such a change, rollbacks included, is refused (`policy_denied` `{reason: security_degrading}`) even when approved. Checked at approval and again at apply. Turning it on needs `confirm: true` |
| `devices.firmware.watchdogSeconds` | `600` | yes | "Firmware watchdog" (FR-146): after a firmware change applied with a restart, how long the device has to come back before its watchdog restores the previous settings (120 to 3,600 s). The Hub sends it as `watchdogSeconds` with every apply that restarts, kept inside that range whatever is stored; an apply without a restart sends none. Separate from the boot watchdog, because a restart into new firmware settings goes through the BIOS start-up |
| `devices.boot.allowLowLevel` | `false` | yes | Low-level boot changes (FR-143): trying a boot profile once and making it the default, each after the owner's approval. Off, both are refused (`policy_denied` `{reason: low_level_boot_off}`) by the Hub and by devices (`policy.lowLevelBoot`); clearing a pending one-shot always works. Turning it on needs `confirm: true` |
| `devices.boot.watchdogSeconds` | `600` | yes | How long a device has to come back on a profile it tries (120 to 3,600 s) before it returns to its default entry; the default for a try, which may give its own within the same range. The Hub marks a trial still pending 120 s after its deadline failed |
| `devices.pxe.enabled` | `false` | yes | Serve iPXE menus and boot images from `<dataDir>/boot-images` to devices holding a boot token; off, both public `/boot/` routes answer 404. It does not need `devices.boot.allowLowLevel`. Nova runs no DHCP or TFTP. Turning it on needs `confirm: true` |
| `devices.oob.enabled` | `false` | yes | Out-of-band management (FR-147): the Hub reaches the BMCs you register (Redfish, IPMI; Intel AMT is not built) for power, sensors, BIOS pending settings and one-time boot. Turned on only through `POST /api/v1/oob/enable` `{confirm: true}`. Off, actions, pin confirmation and adding or editing a BMC are refused (`oob_disabled`; deleting one still works) and waiting cards are withdrawn |
| `browser.localFallback` | `true` | yes | When a site blocks an agent's own browser, offer to continue on its connected computer's browser (FR-209); each site needs a consent per agent, computer and site, revocable in Settings → Browser. Turning it off stops running fallback sessions (end reason `disabled`) |
| `browser.extensionBridge` | `true` | yes | Let agents act in your own browser through the Nova extension, on hosts you granted and tabs you shared (FR-096); off, the bridge refuses every call |
| `browser.extensionBridgeAllSites` | `true` | yes | Allow the elevated "all sites" grant (it still needs its own confirmation per computer); off, only hosts granted one by one count |

**Consent switches.** Four switches turn on only with an explicit confirmation:
`devices.firmware.allowChanges`, `devices.firmware.allowSecurityDegrading`,
`devices.boot.allowLowLevel` and `devices.pxe.enabled`. `PATCH /api/v1/settings` refuses to set
one of them to `true` without `confirm: true` in the body (403 `policy_denied`
`{reason: consent_required}`); the Settings page sends it after a dialog that says what the switch
allows. The firmware pair can also be set through `PUT /api/v1/devices/firmware/policy`, with the
same rule. `devices.oob.enabled` is never turned on through `PATCH /api/v1/settings` (403
`policy_denied` `{reason: consent_required}`, audited `device.oob.refuse`): only `POST
/api/v1/oob/enable` with `{confirm: true}` turns it on. Turning any of them off never asks, by any
route. A managed value wins over all of these routes.

**Audit of security settings.** Every write of a `security: true` key through the Hub's settings
writer emits `settings.changed` with `before`, `after` and `confirmed` (true when the change came
with the owner's explicit confirmation). The settings route, the firmware policy route and
`POST /api/v1/oob/enable|disable` all write through it (out-of-band enable counts its consent as
the confirmation). The security audit records each change once, as kind `settings`, action
`setting.changed`, resource the key, with the same values (`docs/06` §2); no route writes an audit
entry of its own for the change.

*Added in M8* (ADR-097). The keys are in `packages/shared/src/settings.ts` (the `// ---- M8`
blocks); every one but the `appearance.*` keys is security-relevant, so a project cannot set it and
managed policy can only tighten it (§1.3). Where each one is shown: Settings → Extensions (`sdk.enabled`, "Run extensions"),
Marketplace → Catalogs (`plugins.trustedPublishers` under "Trusted publishers", `market.*` under
"Install rules", `plugins.catalogs` with its two new fields), Settings → Authorized apps
(`apps.enabled`, "Let apps ask for access"; `apps.openRegistration` has no control yet), Settings
→ Telemetry export (the `telemetry.otlp.*` keys, written through `PUT /api/v1/telemetry/otlp`),
Settings → Data (the `retention.*` keys under "How long data is kept" and the `privacy.crash*`
keys under "Crash reports"), Settings → Members ("Keep a removed member's data for",
`team.removedMemberPurgeDays`), Sites → Publishing targets (`sites.remoteTargets`, "Allow publishing to hosting targets") and Settings →
Appearance (`appearance.locale` under "Language", `appearance.customTheme` under Themes).
`managed.restrict` has no page: Settings → Managed policy shows what it holds.

| Key | Default | Security | Notes |
| --- | --- | --- | --- |
| `sdk.enabled` | `true` | yes | Run installed SDK extensions, each in a worker of its own with only the permissions it declared (FR-117). Off stops every extension's worker and turns its hook rows off; its commands, panels, tools and hooks go away until it is turned back on |
| `plugins.trustedPublishers` | `[]` | yes | Publishers whose signed extensions, plugins and catalogs count as Verified: `{name (1–100), key}` with the raw Ed25519 public key in base64url (43 characters), at most 50 (FR-049, FR-117). "Verified" is computed live, so removing a key unverifies what it signed. When managed policy forbids unverified installs, this list is exactly what the policy pins (§1.3) |
| `market.allowSideload` | `true` | yes | Allow installing Unverified marketplace items after the explicit sideload confirmation; off, only Verified items install (`sideload_disabled`). Turned off and locked when managed policy forbids unverified installs (FR-049) |
| `market.allowedKinds` | all five | yes | The kinds that may be installed: `plugin`, `skill`, `theme`, `pet`, `mcp` (`kind_not_allowed`) |
| `plugins.catalogs` (M8 fields) | — | yes | Each catalog may now pin `publisherKey` (the key its index must be signed with; a catalog that pins a key and has no signature is refused) and, for a Git catalog, `commit` (a full 40-character SHA its index is read at) (`docs/08` §7) |
| `managed.restrict` | `{layers: [], failClosed: null}` | yes | Set only by managed policy, never by a user (the settings route refuses every `managed.*` key): one `restrict` block per source in force and, when a trusted source could not be read, why every agent tool is denied (FR-106, `docs/12` §10). Always present in the managed layer, so always locked |
| `apps.enabled` | `true` | yes | Let third-party apps ask for access to the Hub (FR-222). Off, registration, consent and token requests are refused (`apps_disabled`) and every app token stops working at once |
| `apps.openRegistration` | `true` | yes | Let apps register themselves without a session (10 an hour per address, at most 100 waiting, each lapsing after 1 hour). Off, only the owner can register an app, with their session (`registration_closed`); approving each app is needed either way |
| `telemetry.otlp.enabled` | `false` | yes | Export traces, metrics and logs over OTLP/HTTP with JSON to the collector below (FR-223, `docs/16` §1). Redaction always applies |
| `telemetry.otlp.endpoint` | `''` | yes | The collector's base URL: https, or http only to this machine; `/v1/traces`, `/v1/metrics` and `/v1/logs` are appended |
| `telemetry.otlp.headers` | `{}` | yes | Header names → vault references `secret://telemetry/otlp/header/<name>`; `PUT /api/v1/telemetry/otlp` stores the values, which are never returned |
| `telemetry.otlp.signals` | `{traces: true, metrics: true, logs: true}` | yes | Which signals are sent |
| `telemetry.otlp.includeContent` | `false` | yes | Also export content attributes (prompts, completions, tool arguments and results, error and log messages); off, they are removed before export. The page asks before turning it on |
| `privacy.crashReports` | `false` | yes | Send crash reports to the endpoint below (FR-121, `docs/16` §1.2). A crash always writes a local report you can preview, send or delete; nothing leaves the machine while this is off |
| `privacy.crashReportEndpoint` | `''` | yes | Where crash reports go: https, or http only to this machine; no credentials, query or fragment. Empty: nowhere |
| `retention.threadsDays` | `null` | yes | Delete chats untouched for this many days (pinned chats kept); a deleted chat can be recovered for 30 days, then it is purged. 1 to 36,500; null keeps every chat (FR-105) |
| `retention.runsDays` | `null` | yes | Purge Work runs that ended this many days ago, with their thread, plan and steps (runs in pinned threads kept) |
| `retention.auditDays` | `null` | yes | Prune audit entries older than this many days, never fewer than 365; the chain stays verifiable from the audit anchor (`docs/12` §9.4) |
| `retention.artifactsDays` | `null` | yes | Delete artifacts not changed for this many days, with their versions and files (artifacts in pinned chats kept) |
| `retention.tracesDays` | `null` | yes | Prune activity history older than this: the stored event log, agent browser traces, network checks and notification deliveries |
| `team.removedMemberPurgeDays` | `30` | yes | Days a removed member's data is kept before it is purged, so the owner can export it first (0 to 3,650; 0 keeps it until the owner purges it) (`docs/13` §7) |
| `appearance.pet` (M8 values) | `off` | no | Also `market:<id>`: a pet installed from the marketplace (its reverse-DNS id) (§2.3) |
| `appearance.customTheme` | `null` | no | The saved theme in use: the id of a theme in `appearance.customThemes`, applied token for token over its base; choosing a base theme, accent or color by hand clears it, and an id no longer saved falls back to the base theme (§2.2, FR-011) |
| `appearance.locale` | `system` | no | The interface language (FR-016): `system` (the first of the device's languages Nova has, else English), `en`, `ar` (partly translated; English where a translation is missing), and for testing `en-XA` and `ar-XB`. Each person's own (members set theirs through `/api/v1/team/me/settings`); the desktop app follows it while signed in (§2.4) |
| `sites.remoteTargets` | `true` | yes | Let the owner publish sites to remote hosting targets (WebDAV) besides the Hub folder and a zip (FR-037); uploads pass the egress policy. Off, adding, checking, planning and publishing to targets are refused (`remote_targets_off`); taking a site down from one still works. Managed policy can only turn it off |

### 1.2 Settings UI

- Grouped left nav; search across all settings; each control has a label, description, and
  (when relevant) the managed-policy override indicator.
- Changes apply immediately; a "Revert" affordance for the current session.
- Export/import settings as JSON (secrets excluded).
- A "Reset section" action; "Reset all" requires typed confirmation.

### 1.3 Precedence with managed policy (M8)

*As built in M8 (ADR-097 D4; `packages/shared/src/settings.ts` `resolveSetting`,
`packages/core/src/managed`).* A key resolves from the first layer that holds a valid value:
**managed policy** (locked) → **user project** (only keys that are not security-relevant) →
**user global** → **built-in default**. Environment variables configure the process (ports, the
data folder, the test-only policy file) and never override a setting. The managed layer is built
from the policy sources in force (the remote policy, the OS-protected file and, in tests only, a
layered test file; `docs/12` §10):

- **Tighten only.** For a security-relevant key the managed value is the tighter of the policy's
  and the user's own: allow-lists intersect, deny-lists merge, a disabling switch wins, a cap takes
  the smaller value (`retention.*` days: null is the loosest), and a few keys are pinned to the
  policy's value (`review.model`, `privacy.crashReportEndpoint` (`''` forbids sending anywhere),
  `team.removedMemberPurgeDays` (neither direction is safer for every organization, so the
  administrator fixes the number), and `plugins.trustedPublishers` when unverified installs are
  forbidden). `apps.openRegistration` and `sites.remoteTargets` can only be turned off. A policy
  value looser than the default is ignored and reported as `loosens`; a security key Nova knows no
  tightening direction for (addresses, paths, tokens: `relay.url`, the OTLP endpoint and headers,
  `sites.publishRoot`, …) is ignored and reported as `unordered`. **Every security setting is
  decided**: `packages/core/test/managed-rules.test.ts` fails when a security setting has neither a
  rule in `SECURITY_RULES` nor a place on its list of keys with no safe direction, so a new one
  cannot slip through unlocked. Keys that are not security-relevant take the policy's value; when
  two sources set one, the remote policy wins.
- **The egress allow list is a ceiling** (not a locked value). A policy's egress allow list
  (`restrict.egress.allow`, or `network.egressAllow` under `settings`, which joins its source's
  restriction) bounds the hosts agents may reach: while the owner's own `network.egressAllow` is
  unset or empty, the policy's hosts apply; otherwise only the owner's hosts that every policy list
  covers (wildcards count, so `api.example.com` is within `*.example.com`). The owner's list stays
  editable, but the settings route refuses hosts outside the ceiling. The result applies at the
  gate (a network call outside it is refused as `managed`, not asked about), in the browser's site
  decisions and in the egress proxy, where scope grants, profile hosts and external agents' own
  hosts are kept within it too. `GET /api/v1/egress` returns the hosts in force, and
  `GET /api/v1/managed` an `egress` section `{ceilings, own, effective, note}` whose note says when
  none of the owner's hosts is allowed or which are outside the policy. Deny lists still add up.
- **Implied settings.** Each `restrict` part also locks the settings it implies: `code.allowBypass`
  off when Bypass is denied, the `tools.approvalPolicy` ceiling, `network.egressMode` and
  `network.egressDeny` and `cloud.runner.unrestrictedNetwork` off for any egress restriction, `telemetry.otlp.enabled` off,
  `routing.allowCloud` off, `code.ssh.enabled` off, `apps.enabled` and `mcpServer.enabled` off,
  `market.allowSideload` off and `plugins.trustedPublishers` pinned when unverified installs are
  forbidden, and the folder rules over `tools.roots`.
- **Locked everywhere.** Every key the policy touches is locked: the settings route refuses a
  write (`policy_denied` `{reason: managed}`) and every view shows "Managed by your organization"
  with the source. `managed.*` keys are never user-writable, and policy-restricted values of
  `code.permissionMode`, `code.folderModes`, `runs.autonomy`, `agents.autonomy` and
  `tools.approvalPolicy` are refused too.

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
  `appearance.customThemes`. In M4 **Use** set the saved theme's base theme plus its
  background, text, accent and fonts and derived the other colors; M8 replaced that with the
  token-for-token setting below.
- *As of M8* (ADR-097) themes also come from the Marketplace and from extensions. A theme item
  installed from a catalog is checked against the theme schema, each token and font value must
  be a plain CSS value (letters, digits, spaces and `#%.,'"()+-`, at most 200 characters), and it
  is added to `appearance.customThemes` (still at most 50). Themes a running extension registers
  (`nova.themes.register`) pass the same checks and are offered in Appearance → Themes under
  "From your extensions" (**Save to your themes**, **Save and use**); nothing an extension offers
  is applied until the user picks it, and no extension writes a setting.
- *As of M8, a saved theme in full* (FR-011). `appearance.customTheme` holds the id of a theme in
  `appearance.customThemes`, or `null` (the default). While it names a saved theme, that theme
  replaces `appearance.theme`: every token it sets is applied over its base (the built-in it
  `extends`, else its variant's; a `system` theme follows the device's light or dark), and
  tokens it does not set come from that base. A theme may set the color roles (`docs/04` §4.1,
  as hex colors, which Nova needs to check contrast), the radii (`--u-radius-sm` to
  `--u-radius-xl`) and the two fonts; every value must also pass the marketplace's and the SDK's
  plain-value rule (`SAFE_THEME_VALUE` in `@nova/shared`). Other tokens (spacing, type sizes,
  motion, layering) are ignored, so a theme cannot undo the text size, reduced motion or the
  layout. The accent, background and text overrides, and the user's own fonts, still go on top.
  - **Use** (Appearance → Themes → Your themes, and **Save and use**) sets the base theme to the
    theme's base, clears the accent, background and text overrides and the fonts the theme sets,
    then sets `appearance.customTheme`; keys managed policy holds are left alone ("Using <theme>,
    except settings your organization manages."). When the theme's body text is below 4.5:1
    against its background, Use first asks "Use <theme>?" with the ratio; **Use anyway** goes on
    and nothing is blocked (an import's preview already shows its contrast, so **Save and use**
    there does not ask again).
  - Appearance says which saved theme is in use, with **Stop using <theme>**, and marks it
    "In use" in Your themes. Choosing a base theme, an accent, a background or a text color by
    hand (including the Toggle theme command) stops using it.
  - Removing the theme in use clears the setting and sets its base theme. An id no longer saved
    (a theme removed in the Marketplace, or on another device) is ignored: the base theme is
    used and Appearance says so.
  - It is a plain setting: managed policy can lock it (Use is then disabled and shows "Managed
    by your organization"), a project or a member can set their own, and export and import carry
    it with the other settings. The shell applies the look (`useApplyAppearance`); first paint
    still uses the cached base theme until settings load.
- Themes are validated against the token schema; unknown tokens are ignored, missing tokens
  fall back to the active base theme.
- **No hard-coded colors** in components; a lint rule enforces token usage.

### 2.3 Pets (FR-012)

- A pet is a declarative sprite/manifest (JSON + WebP/APNG frames) with states: idle, thinking,
  working, success, error, waiting.
- Pets are optional, non-blocking, respect reduced-motion, and can be muted/positioned.
- The app ships one original default pet; the marketplace can provide more (community).
- *As of M8* (ADR-097) a pet item is a folder with `pet.json` (at most 64 KB) and its frames
  (PNG, APNG or WebP, at most 1 MB each and 8 MB in all), installed to
  `<dataDir>/market/pets/<id>` and listed by `GET /api/v1/market/pets`; the companion fetches only
  the frames `pet.json` lists (`GET /api/v1/market/pets/:id/files/*`). Choosing it sets
  `appearance.pet` to `market:<id>`; reduced motion and "Keep still" hold it on one frame, and
  removing the pet in use turns the companion off.

### 2.4 Language (FR-016, M8)

*As built in M8 (ADR-097 D9; `packages/i18n`, `apps/web/src/i18n`).* Settings → Appearance →
**Language** (`appearance.locale`): **System** (the first of the device's languages Nova has, else
English), or a language by its own name: **English**, or **العربية (partly translated)**, which
shows English where a translation is missing. Under **For testing**: `en-XA` (accented, about a
third longer, bracketed, so text that was never extracted stands out) and `ar-XB` (right to left,
every string mirrored). The change applies at once: the shell remounts in the new language and
`<html lang dir>` follows. Arabic and `ar-XB` lay the app out right to left (`docs/04` §4.5).
Dates, numbers, sizes, durations, relative times and lists are formatted in the active locale. Text
the Hub writes (error, notification and status messages, permission lines, diagnostics) stays
English in M8. The setting is each person's own (members keep theirs). The desktop app uses the
same setting while signed in to the Hub (re-read on sign-in and on `settings.changed`); signed out,
on `system`, without a Hub or when the Hub refuses (403), it uses the operating system's languages,
the first one Nova supports. The look, including a saved theme, is cached in the browser and applied
before settings load, so the first paint matches.

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

### 4.4 As shipped in M8

*ADR-097 D1-D3; `packages/core/src/sdk`, `apps/hub/src/sdk.ts`, `packages/sdk`, `packages/cli`;
routes in `contracts/hub-api.md`, "Extensions"; the author's guide is `docs/26` §9.*

- **What an extension is.** A plugin folder (`docs/08` §3.1) plus `.nova-plugin/extension.json`
  ([`extension-manifest.json`](../contracts/schemas/extension-manifest.json)): `api: 1`, the entry
  ES module and `permissions` (`network`, `fs`, `secrets`, `commands`, `panels` with their HTML file
  and CSP domains, `tools` with their action class and default, `actionDefaults`, `hooks`,
  `events`). Its id is the plugin id; its tools are `ext:<id>/<name>`. It ships as a signed `.novax`
  (§5 of this page and `docs/26` §3).
- **The API as built** (`nova` in the entry module; `@nova/sdk` has the types):
  `nova.commands.register({id, title, run})`, `nova.panels.register({id, …})` (the panel must be
  declared; its resource and entry point come from the manifest), `nova.tools.register({name,
  title, description, inputSchema, outputSchema?, annotations?, handler})`,
  `nova.hooks.register({id, handler})`, `nova.themes.register(theme)`,
  `nova.keybindings.register({command, key, when?})` (the command must be declared),
  `nova.menus.register({where: thread|message|file|composer|sidebar, items})`,
  `nova.status.addItem({id, text, onClick?})` (returns `update(text)`), `nova.events.on(name, fn)`,
  `nova.net.fetch(url, init)`, `nova.fs.read|write|list|remove(path)`, `nova.secrets.get(name)`
  and `nova.log(...)`. Each registration returns `{ready, dispose}`; `ready` rejects when the Hub
  refuses it. There is no storage API: an extension keeps files in `${extensionData}`. Limits: 10
  themes, 50 keybindings, 20 menus of 20 items, 5 status items, 50 event listeners, 32 calls
  waiting, 8 fetches in flight and 16 MiB being received at once (more is refused at once with
  `too_many_requests` or `fetch_budget`, never queued), 5 MiB per response or file, 64 KiB of tool
  schemas.
- **Where it runs.** QuickJS in a worker thread per account and extension (64 MiB, 2 s of CPU per
  call into the engine, at most 3 restarts in 10 minutes); no Node, files, network or host objects;
  everything goes to the Hub over a message port and through the policy engine (`docs/12` §7.5).
  Starting checks that the installed files still match the recorded digest; otherwise the
  extension does not start, shows `error` and is audited `extension.tampered` until reinstalled.
  A bundle holding `.git`, `.env` files or a PEM private key is refused.
- **Permissions are enforced.** Undeclared access is denied, audited as `extension.access.denied`,
  the extension is turned off and the owner notified. `nova.net.fetch` reaches only declared hosts,
  public addresses, within the egress ceiling (the owner's `network.egressMode` and deny list and
  managed policy's egress; refusals there are audited `extension.egress.denied` but do not turn the
  extension off). A filesystem scope inside or containing the Hub's data folder is refused at
  install. Secrets live in the vault at `secret://extension/<account>/<id>/<name>`; the owner sets
  them in Settings → Extensions, and every read is audited.
- **Tools and hooks.** Extension tools have source `plugin`, so plugin scopes, agent plugin
  connections and approval defaults apply; a tool declared with an action other than `read` is never
  read-only. SDK hooks are stored as hooks with an `mcp_tool` handler on `ext:<id>/hooks/<hookId>`
  and trusted by a hash over their definition and the bundle digest (`docs/08` §4.1); they never
  answer asks and fail closed while the extension is not running.
- **Command results** show in a toast: a string as is, an object's `message` or `text` field, a
  flat object as `key: value` on one line, anything longer behind **Show the result** (`docs/26`
  §9.3). A stopped extension's card says why (managed policy with its source, an unreadable policy,
  or the SDK switch off).
- **Themes and keybindings** are offers (`GET /api/v1/extensions/contributions`): Appearance and
  Keyboard show them, and nothing is applied until the user picks one (§2.2, `docs/04` §2.14).
- **Signatures.** A `.novax` signed by a key in `plugins.trustedPublishers` is Verified; anything
  else needs the sideload confirmation and stays Unverified; a bundle whose signature does not match
  its files is refused. An update by another publisher must be accepted and clears the extension's
  secrets and data. Each install keeps its signed bytes, so a failed update rolls back to a
  re-verified copy.
- **Switches.** `sdk.enabled` (default on) runs or stops every extension; each extension has its
  own on/off; managed policy can deny extensions by id, forbid unverified ones or turn the SDK off
  (a refused extension stays installed, shows `stopped` with the reason, and starts again when the
  policy allows it).
- **Not built**: an npm package (`@nova/sdk` is a workspace package), a separate template
  repository (`nova init` copies the SDK's sample from a checkout), extension-to-extension calls,
  and paid extensions.

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

*As shipped in M8* (ADR-097; `packages/core/src/market`, `apps/hub/src/market.ts`,
`apps/hub/src/mcp-market.ts`, `apps/web/src/market`; routes in `contracts/hub-api.md`,
"Marketplace"). The Marketplace is a sidebar page (`docs/04` §2.14) and the owner's alone.

- **Sources.** The built-in sample catalog (`nova-sample`, `examples/catalog`, read from disk with
  its key pinned in code, so it works offline) and the owner's `plugins.catalogs`: a folder on the
  Hub, a Git repository (read at the pinned `commit`, fetched with hooks off and checked to be that
  commit; without a pin, a shallow clone of the ref) or an https location (the index and its
  artifacts on the same host, at most 3 redirects on that host). Entries may also point to a
  folder of another Git repository at a commit. The index format is
  [`catalog-index.json`](../contracts/schemas/catalog-index.json); caps: index 1 MiB, signature
  16 KiB, artifact 50 MiB, screenshot 2 MiB.
- **Catalog signatures.** Every index may carry `<index>.sig`
  ([`catalog-signature.json`](../contracts/schemas/catalog-signature.json)): Ed25519 over
  `"nova-catalog-v1\n"` + the SHA-256 of the index bytes. A catalog that pins a key verifies only
  with it, and a missing signature is then a downgrade; otherwise a key in
  `plugins.trustedPublishers` verifies it. An **invalid** signature (damaged, not matching, the
  wrong key, or missing under a pin) refuses the whole catalog: nothing is listed or installed,
  not even as a sideload (`catalog_signature_invalid`, audited `market.refuse`). An unsigned or
  untrusted catalog lists its items as Unverified.
- **Verified or Unverified.** An item is Verified when its catalog is verified, its artifact
  matches the listed checksum (`sha256` for a file, `digest` for a folder) and, for a `.novax`,
  its bundle is signed by a key in `plugins.trustedPublishers` (the same rule as Settings →
  Extensions, so both give one verdict). An extension shipped as a folder or zip is never
  Verified (it runs code). A registry entry and an `.mcpb` are verified by the catalog and the
  checksum. Anything else is Unverified, with its reasons (`catalog_unsigned`,
  `catalog_untrusted`, `no_checksum`, `checksum_mismatch`, `bundle_unsigned`,
  `bundle_untrusted`), and installs only through the sideload confirmation while
  `market.allowSideload` is on and managed policy allows unverified installs. A tampered bundle
  (`bundle_invalid`) is refused outright.
- **Kinds.** Plugins (folders, zips and `.novax` bundles; extensions install through the
  extension installer, §4), skills (as `skill:import:<id>`), themes (into
  `appearance.customThemes`, §2.2), pets (§2.3) and MCP servers (a registry entry becomes a remote
  server; an `.mcpb` installs through the bundle installer with the marketplace's verdict). The
  kinds `market.allowedKinds` leaves out are refused (`kind_not_allowed`).
- **Install, update, remove.** Preview first (held 30 minutes); install needs the preview id, the
  sideload confirmation for an Unverified item and, on an update that adds or changes a
  permission, the permission diff's hash echoed back (`acceptPermissions`); a diff that only
  removes permissions needs no acceptance. A newer version is an update, and so is the same
  version from the same catalog with a different checksum (a moved Git ref, a republished item).
  Installs run one at a time; a failed install or update puts back what it replaced (for an
  extension, its kept signed bundle, re-verified), audited `market.install.failed` with
  `rolledBack`. An MCP update keeps the server's settings unless new ones are given. An extension
  update signed by another publisher, or an unsigned one replacing a signed one, shows
  `publisherChange` and needs `acceptPublisherChange: true` (else `publisher_change_confirmation_required`
  before anything changes); accepting clears the extension's secrets and data. Removing the theme in
  use clears `appearance.customTheme` first.
- **Ratings** (1 to 5 stars and optional notes) stay on the Hub; nothing is sent anywhere
  (`shared: false`).
- **Names.** A publisher is named only for a trusted or pinned key (else its fingerprint, with a
  warning that the catalog's name for it is not checked), and an item with no author of its own shows
  none.
- **Not built**: a hosted remote catalog service (only the client), paid extensions, install
  counts, shared ratings; the sample catalog has no pet or MCP item.

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
public profile card came in M7 (`docs/13` §7).

*As shipped in M8* (ADR-097; `packages/core/src/profile/spend.ts`; routes in
`contracts/hub-api.md`, "Usage"; screens in `docs/04` §2.16):

- **Spend caps** (FR-116) are per account and provider kind (members set their own): an amount in US
  dollars per UTC day or month, a warning share (5 to 99 %, default 80 %) and a hard stop (default
  on; off, the cap only warns). Spend is the period's `usage_event` cost. Each model call holds a
  reservation of its likely cost (the provider's recent average, at least 1 % of the cap) until its
  stream ends, so concurrent calls overshoot a hard stop by at most one call. A capped target is
  dropped from the route and a fallback on another provider still runs; when nothing is left the
  reply stops with `over_budget` (`{reason: spend_cap, provider}`, "Raise the cap in Settings →
  Profile & usage"). Each alert (`spend.cap.warning`, `spend.cap.reached`) fires once per period,
  with a notification linking to the cap. Image generation honours caps and records its usage.
  Compute nodes have no cap.
- **Clear usage data** deletes usage events (except those of runs and goals still active) and
  carries each cap's spend for the period over, so it never resets a cap.
- **Entitlements and limits** (FR-115): Settings → Accounts shows, per provider account, what the
  provider reported (plan, limit, used, reset time), the last limit error it reported, this month's
  spend and its cap. Nova shows what providers report and never invents limits.
- **Not built**: per-project caps, an account-wide cap across providers, and caps on compute nodes.

## 7. New settings sections (added)

| Section | Keys |
| --- | --- |
| **Devices** | registered devices/nodes, roles, scopes, wake, revoke, per-device overrides |
| **Network** | transports (LAN/Mesh/Relay), trust mode, certs, egress, wake helpers, diagnostics |
| **Ambient** | enable screen/mic/system-audio, quality, OCR/STT backends, cloud option, exclusions, retention, pause hotkey |
| **Automations** | list, enable/disable, dry-run, logs, versions, default approval rules |
| **Smart Home** | integrations (HA/MQTT/vendor), areas/rooms, scenes, allowed entity classes |
| **Learning** | memory review, skill proposals, optimization proposals, tuning bounds, self-modification guardrail (on by default), kill switch |
| **Catalog** | catalog URLs (public + tailnet + local + Git-hosted), trusted publishers, allowed types, sideloading (explicit confirmation; items labelled Unverified). *As shipped in M8*: the Marketplace's **Catalogs** tab (`docs/04` §2.14): catalogs with a pinned publisher key and commit (`plugins.catalogs`), trusted publishers (`plugins.trustedPublishers`), and the install rules (`market.allowSideload`, `market.allowedKinds`) |
