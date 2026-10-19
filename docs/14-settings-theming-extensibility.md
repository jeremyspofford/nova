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
| **Devices** | compute nodes: add (one-use enrollment token), status, models, load, revoke (FR-126); **Firmware and boot** (M7.5: the firmware, low-level boot and network boot switches, below) |
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
| **Sync** | enable, devices, passphrase, history/merge log, E2EE status (as built in M7: this device's copy, changes waiting to send, devices with a copy, History with Restore; no passphrase, `docs/13` §2) |
| **Account** (M7) | linked OIDC identities (link and unlink), the public profile card and its preview (`docs/13` §7) |
| **Members** (M7) | people and roles; for the owner, invitations (one-use link shown once, chosen expiry, withdraw), removing a member, OIDC providers (`docs/13` §7) |
| **Cloud runner** (M7) | the runner's URL, a write-only token, test, on/off, forget, caps, unrestricted network; cloud environments, their runs and snapshots (`docs/13` §3) |
| **Experimental** (M7) | `script.run` and its limits, external agent adapters (FR-202, FR-203) |
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
