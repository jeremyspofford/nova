# Test Manifest

Every requirement in `docs/03-functional-requirements.md` must appear here with at least one
unit test and, where the requirement touches IPC/storage/providers/UI, one integration or E2E
test. A CI check (to be implemented in M0) fails if any `FR-*` is missing.

Legend: `U` unit · `I` integration · `E` E2E journey (see `docs/18` §3) · `—` not applicable.

| FR | U | I | E | Notes |
| --- | --- | --- | --- | --- |
| FR-001 | web app.test | web app.test (fake Hub) | J1 | shell layout + a11y |
| FR-002 | web app.test | web app.test | J1 | mode switching preserves state |
| FR-003 | web keys.test | web app.test | J1 | command palette |
| FR-004 | web keys.test | web settings.test | J1 | shortcut registry |
| FR-005 | web layout-model.test; ui splitter.test | web workspace-layout.test | J4 | pane layout |
| FR-006 | core workspace-terminals.test | hub workspace.test; web terminal.test | J4 | bottom panel + terminal |
| FR-007 | web deeplinks.test; web deeplinks-m7.test; desktop routes.test (deep links) | web deeplinks.test (router) | desktop shell.spec (e2e-shell) | deep links; M7 adds `nova://run/<id>`, `nova://code/<id>`, `nova://approval/<id>`; the desktop shell takes a link from a second launch |
| FR-008 | desktop shell-parts.test (shortcuts, status list, tray glyph); desktop hub-client.test (quick chat) | web shellbridge-views.test (global shortcuts in Settings → Keyboard) | desktop shell.spec (e2e-shell) | tray, quick overlay (current or new chat, New task, status list, Quit), Ctrl+Alt+N; a key another app holds is reported, never forced; voice in quick chat not built |
| FR-009 | desktop routes.test (`appPath`, navigation allowlist, window routing); web shellbridge-units.test | web shellbridge-views.test (Open in new window) | desktop shell.spec (e2e-shell) | multi-window: `novaShell.openWindow` opens app routes only; windows stay on the Hub origin, web links open in the system browser |
| FR-010 | ui themes.test | web settings.test | J1 | theming tokens |
| FR-011 | web theme-share.test | web theme-share.test | — | theme import/export |
| FR-012 | web pets-state.test | web pets-overlay.test | — | pets (off by default; still under reduced motion and "keep still") |
| FR-013 | core notifications.test | hub ops.test; web notifications.test | — | notifications |
| FR-014 | web onboarding.test | web onboarding.test | J1 | onboarding |
| FR-015 | ui primitives.test | web app.test (keyboard) | J1/J2 (axe) | accessibility |
| FR-016 | todo | todo | — | i18n/RTL |
| FR-017 | core threads.test | hub chat.test | J1 | chat CRUD |
| FR-018 | core chat.test | hub chat.test | J1 | streaming/stop |
| FR-019 | core conversation.test | hub conversation.test; web chat-followup.test | J2 | steer/queue |
| FR-020 | core conversation.test | hub conversation.test; web chat-actions.test | J2 | edit/regenerate/branch |
| FR-021 | core chat.test | hub chat.test | J1 | attachments |
| FR-022 | core tools-registry/mentions tests | hub tools.test; web chat-mentions.test | — | @mentions |
| FR-023 | core router.test; providers conformance.test | hub model-routes.test; web chat-models.test | J2 | model picker |
| FR-024 | providers conformance.test | web chat.test | J2 | reasoning levels |
| FR-025 | storage search.test; web chat-find.test | hub conversation.test | J1/J2 | find/search |
| FR-026 | core conversation.test | web chat-panels.test | — | side chat |
| FR-027 | core conversation.test | web chat-temporary.test | J2 | temporary chats |
| FR-028 | core suggestions.test | web chat-suggest-slash.test; web settings.test | — | suggested prompts |
| FR-029 | core tools-web.test | hub tools.test | — | web search citations |
| FR-030 | core images-tool.test; providers images.test | core images-openai.test; web flagged-images.test | — | image gen through the OpenAI-compatible `/images/generations` (image models recognised by name; URL-only results refused); composer Generate image button |
| FR-031 | todo | todo | — | voice |
| FR-032 | core memory.test | hub conversation.test; web memory.test | J2 | memory |
| FR-033 | core conversation.test | web chat-panels.test | — | branch tree |
| FR-034 | core projects.test | hub conversation.test; web projects.test | — | projects |
| FR-035 | core workspace-folders.test; core sources-folders.test | hub workspace.test; web project-folders.test | — | local projects |
| FR-036 | core spaces-service.test; core spaces-tools.test; web spaces-diff.test | hub spaces.test; web spaces-pages.test | — | space/pages: versions, 409 on a stale base, comments, proposals |
| FR-037 | core spaces-sites.test; core spaces-markdown.test | hub spaces-sites.test; web spaces-sites.test | — | sites: build, preview CSP, zip, publish and unpublish |
| FR-038 | core tools artifacts tests | hub tools.test; web chat-artifacts.test | — | artifacts |
| FR-039 | core workspace-files.test | hub workspace.test; web files.test | J4 | file editor |
| FR-040 | core projects.test | hub conversation.test; web projects.test | — | sources |
| FR-041 | core workspace-library.test | hub workspace.test; web library.test | — | library |
| FR-042 | mcp names/content tests; mcp device-transport.test | mcp stdio/http tests; hub mcp.test; hub mcp-m7.test (device bridge in `novad`'s answer shape, `auth`) | J3 | MCP client; M7: device-hosted servers through the device bridge (never spawned on the Hub, tools only), `auth` from the vault as the Authorization header |
| FR-043 | mcp connection tests | hub mcp.test; web tools-settings.test | J3 | MCP health |
| FR-044 | mcp server.test; mcp stdio-launcher.test (`nova mcp stdio`) | hub mcp-server.test; hub mcp-server-m7.test (resources, prompts, listings through the gate); web clients-settings.test | — | MCP server; M7: resources (chat transcripts, read-only project files) and prompts (active skills, only for clients with `skill.load`); `script.run` never served |
| FR-045 | core plugins-manifest.test; core plugins-catalog.test; core plugins-service.test; policy plugins-hooks.test | hub plugins.test; hub policy-loop.test; web plugins-settings.test | J4 | plugins |
| FR-046 | core skills.test; core skills-frontmatter.test | core loop-skills.test; web chat-suggest-slash.test | J4 | skills |
| FR-047 | mcp oauth.test; mcp oauth-service.test | hub oauth.test; hub mcp-m7.test (`auth` and `oauth` checked against the transport) | — | connectors (OAuth PKCE); M7: per-server API key in the vault and `oauth` settings |
| FR-048 | policy engine tests | hub policy.test; web tools-settings.test | J3 | per-tool defaults |
| FR-049 | todo | todo | J10 | marketplace |
| FR-050 | core plugin-authoring.test | core plugin-authoring.test | — | build plugin/skill (drafts) |
| FR-051 | core runs-lifecycle.test; core runs-loop.test | hub runs.test; hub m5-integration.test; web work-run.test | J5 | work run |
| FR-052 | core runs-lifecycle.test (recover) | hub runs.test | J5 | continue when closed |
| FR-053 | core runs-subagents.test; core runs-m7-limits.test; core gate-m7-limits.test | hub runs.test | J5 | sub-agents; M7: a sub-agent's tool list is enforced at the gate (plus `run.complete`, `tool.search`, `context.remaining`, `context.fresh`) |
| FR-054 | core runs-subagents.test | web work-run.test | J5 | child threads |
| FR-055 | core scheduler-recurrence.test; core scheduler-service.test | hub schedules.test; hub m5-integration.test; hub channels-m7.test (webhook secret); web work-scheduled.test; web channels-m7-log.test (webhook secret) | J5 | schedules; M7: the webhook signing secret is rotated and shown once (`no-store`) |
| FR-056 | core triggers-service.test | hub channels.test | J7 | event triggers: webhook signature (event id signed when sent), dedupe, rate cap, no authority |
| FR-057 | core runs-lifecycle.test (activity) | hub runs.test; web work-run.test | J5 | activity |
| FR-058 | core runs-budgets.test (approval timeout) | core gate-m5-policy.test | J5 | approvals |
| FR-059 | core runs-lifecycle.test (RunStarter); core agents-turns.test (agent.delegate) | hub agents.test | — | delegation to a Work run; delegating to a Code session is not built |
| FR-060 | core channels-notify.test; core notifications.test; core channels-service.test (`mayNotify`); core channels-push.test (OS leg); desktop shell-parts.test (OS notifications) | hub channels.test; hub channels-m7.test (test notification and its push leg); web channels-m7-log.test (test notifications) | J7 | notification routing, quiet hours, `os` flag, shared copies withheld unless `channels.privateToShared` is `allow`; M7: the OS leg pushes (Web Push, native apps through the Relay); a test per category; Telegram and email bindings as targets |
| FR-061 | core code-sessions.test | hub code.test; hub m5-integration.test; web code-sessions.test | J6 | code session |
| FR-062 | core code-m6-environments.test; core sandbox-router.test; core devices-files.test (device environment); core code-m7-ssh.test, code-m7-transport.test (stand-in ssh client `fake-ssh.mjs`) | hub code-m6.test; hub code-m7.test (SSH off by default, host key pinned); web code-m7-environments.test | — | environments: container, SSH, WSL, device; M7 SSH through the system OpenSSH client, host key pinned on first use, helper checked by SHA-256; no test against a real sshd |
| FR-063 | core code-sessions.test (policy); core gate-m5-policy.test; core code-m6-environments.test (no Bypass on another machine) | hub policy-m5.test; web code-sessions.test | J6 | permission modes |
| FR-064 | core code-changes.test | hub m5-integration.test; web code-diff.test | J6 | file edits |
| FR-065 | core code-changes.test | web code-diff.test | J6 | diff review |
| FR-066 | core code-sessions.test (terminal) | web code-terminal.test | J6 | terminal |
| FR-067 | core code-m6-devservers.test; core browser-devserver.test (grant and opener through bubblewrap, the bridge and the real proxy) | hub code-m6.test | J6 | browser pane opens the dev server once it answers |
| FR-068 | core code-m6-verify.test | hub code-m6.test | J6 | auto-verify, feedback turns |
| FR-069 | core code-tools.test (review) | web code-review.test | J6 | code review |
| FR-070 | core code-m6-pr.test (mock Git host) | hub code-m6.test | J6 | PR flow: push guards (`http://` remote refused), secrets scan, CI polling and feedback |
| FR-071 | runner-service server.test (two repositories, setup once, caches; bubblewrap); core cloudrun.test | hub cloudrun.test (a Code session's command on a real runner on loopback); web cloud-environment.test; web code-m7-environments.test | J9 | cloud environments: several repositories, setup script run once, caches, rebuild, snapshots; runs go on while the client is offline; no network unless `cloud.runner.unrestrictedNetwork` |
| FR-072 | core code-m6-sessions.test; core agents-turns.test (sessions.*) | hub code-m6.test | — | cross-session list, message, archive, ask |
| FR-073 | core code-m6-worktrees.test; core code-m6-sessions.test (task.spawn); core code-m7-merge.test | hub code-m6.test; hub code-m7.test (merges); web code-m7-session.test (Merges) | — | worktree registry, leases, `.worktreeinclude`, cap; M7 three-way merge: conflicts refused with their three sides or written as markers that block commits; binary files never merged |
| FR-074 | core code-tools.test (symbols) | web code-units.test | J6 | repo index (pattern-based) |
| FR-075 | core screen-service.test; core screen-tools.test | hub screen.test | — | appshots |
| FR-076 | core spaces-viz.test; core spaces-tools.test (visualize.create) | web spaces-viz.test; web spaces-markdown.test | — | visualizations (chart, diagram, notebook) |
| FR-077 | web relay-transport.test; web push-sw.test | web push-approvals.test; web push-newtask.test; web relay-join.test | J9 | mobile dispatch: Approvals page across conversations (the six decisions), New task sheet (Work run or Code session), the web client through the Relay tunnel |
| FR-078 | core code-m6-environments.test; core devices-files.test | hub devices-novad.test (real novad); hub code-m6.test | — | SSH/remote persistence: novad buffers process output |
| FR-079 | core agents-service.test | hub agents.test | J7 | agent creation |
| FR-080 | core computers-service.test; core agents-service.test | hub computers.test | J7 | agent computer (folder; mock cloud runner) |
| FR-081 | core devices-files.test | hub devices.test | J7 | connect computer (one active connection, version check) |
| FR-082 | core agents-proactive.test; policy user-read-only.test | core agents-loop.test (real ChatService and gate); hub agents.test; hub mcp.test (`readOnlyTools`) | J7 | proactive research (read-only; owner-declared read-only MCP tools) |
| FR-083 | core agents-turns.test | hub agents.test | J7 | background threads (delegated runs) |
| FR-084 | core agents-rules.test; core gate-m6-agents.test | core agents-loop.test; hub agents.test | J7 | custom rules, preview |
| FR-085 | core reviewer-model.test; core reviewer-breaker.test; core gate-m5-review.test | hub policy-m5.test | — | auto-review (model reviewer, fails closed) |
| FR-086 | core browser-signin.test | hub browser.test; core browser-chromium.test (Playwright container) | J8 | sign-in flow |
| FR-087 | core screen-service.test; core browser-session.test | hub screen.test | J7 | takeover |
| FR-088 | core channels-adapters.test (mock Slack and Teams); core channels-service.test | hub channels.test | J7 | channels |
| FR-089 | core agents-service.test | hub agents.test | J7 | agent memory |
| FR-090 | core agents-service.test; core agents-turns.test | hub agents.test | J7 | agent activity/pause/stop/delete |
| FR-091 | core team-agents.test | hub team.test (team agents over HTTP; their events reach the owner); web team-agents.test | — | team agents: own identity account (never signs in), credentials kept as `secret://` references, tasks run under the agent's identity in their own threads, owner answers its approvals |
| FR-092 | core browser-session.test; core browser-observe.test (hover, element screenshots, console, network); core browser-capture.test; core browser-crash.test | core browser-chromium.test (Playwright container); hub browser.test; web browser-m7.test | J8 | browser tool; M7: `browser.hover`, element screenshots, `browser.console` and `browser.network` (300 entries each, in memory, redacted), restart after a crash |
| FR-093 | core screen-desktop.test; core screen-tools.test | hub screen.test | J8 | computer use (mock desktop) |
| FR-094 | core browser-policy.test; core browser-scope.test | core browser-chromium.test; hub browser.test; web browser-m7.test (levels per project or agent) | J8 | allow/block lists, site levels; M7 levels per project or agent (narrowest wins) through `ruleTool`, while hooks and tool limits still see `browser.act` |
| FR-095 | core browser-classifier.test | core browser-policy.test; core browser-chromium.test | J8 | write-action classifier |
| FR-096 | core browser-session.test (profiles, cookies); core browser-bridge.test (grants, tab consent, `expectHost`, Shift-only keys, the Hub's own hosts, a replaced host, history search); extension bridge.test, icons.test (fake `chrome.*`); novad bridge tests (`node scripts/cargo.mjs test`: framing, the per-user socket, token, uid and origin refusals, `bridge_offline`, `bridge_busy`, `bridge enable`) | hub browser.test; hub browser-m75.test (bridge routes, `POST /agent/v1/bridge/events`); hub listeners.test; web browserdevice-bridge.test, browserdevice-settings.test | — | browser profiles; M7.5 extension bridge (ADR-096): native messaging to the local `novad`, owner-confirmed host grants, per-tab consent, no cookies or free scripts; no Windows bridge |
| FR-097 | core code-m6-devservers.test; core sandbox-publish.test (bridge, Docker and bubblewrap) | hub code-m6.test | J6 | dev servers |
| FR-098 | core browser-recording.test; core screen-service.test; core browser-observe.test (trace cursor); core browser-crash.test (crash and restart rows) | hub browser.test; hub screen.test; web browser-m7.test (trace) | J8 | action screenshots; M7 trace newest first with an opaque cursor (a forged one is refused) |
| FR-099 | policy engine tests | core gate.test, loop.test | J3 | policy engine |
| FR-100 | core gate.test; core approvals.test (`answerIn`, `scope`); core channels-hub-only.test (Hub-only cards refused from channel buttons, replies and signed links) | hub policy.test; web chat-approvals.test; web approval-device-card.test | J3; J9.5 (Hub-only cards) | approvals; M7.5: Hub-only cards (`answerIn: hub`) answered only by the signed-in user |
| FR-101 | secrets keychain.test; security scan.test | hub ops.test (vault, keychain select) | — | secrets |
| FR-102 | core egress-proxy.test; core egress-store.test | hub computers.test | J8 | egress control |
| FR-103 | core browser-injection.test; core browser-classifier.test; core browser-capture.test; core browser-review.test; security redact-timing.test | core browser-chromium.test | J8 | injection defense (browser); M7: console and network output labelled page content and scanned (headers, status text, source URLs); page values clipped before redaction |
| FR-104 | core audit.test | hub ops.test; hub diagnostics-m5.test (export); hub settings-m75.test (one entry per security setting change, the list's `detail`); web diagnostics-settings.test | J3 | audit log |
| FR-105 | todo | todo | J10 | data controls |
| FR-106 | todo | todo | J10 | managed policy |
| FR-107 | core sandbox-bwrap.test; core sandbox-container.test; core sandbox-process.test | hub devices-novad.test (novad sandbox) | J7 | sandboxing: bubblewrap, container |
| FR-108 | runner-service unit.test; runner-service server.test (bubblewrap); core cloudrun.test (bubblewrap, else or with `NOVA_TEST_RUNNER_HOST=1` the host test double) | hub cloudrun.test; web cloud-run.test; web cloud-settings.test | J9 | cloud runner (`services/runner`): Hub-driven runs on a remote environment, live output (SSE, reattach), cancel, artifacts into the thread, snapshots; Hub token on every route; off until `cloud.runner.enabled` |
| FR-109 | core sync-hlc.test; core sync-service.test | hub sync.test (device A pushes, B pulls; merge log and restore); web replica-engine.test; web sync-settings.test; web sync-units.test | J9 | Hub-canonical sync: change feed, per-field last writer wins by HLC, merge log with restore, a clock too far ahead refused; the device copy is sealed with AES-GCM |
| FR-110 | core channels-telegram.test (mock Telegram); core channels-email.test (fake IMAP and SMTP servers) | hub channels-m7.test; web channels-m7-setup.test; web channels-m7-log.test | — | Telegram (webhook secret or polling, inline-keyboard approvals), email (IMAP polling or IDLE, SMTP, DMARC sender check, approvals by signed one-use link only), Slack signed buttons, message log; Telegram files and email OAuth not built |
| FR-111 | core channels-webpush.test (RFC 8291 test vector, VAPID); core channels-push.test; relay-service push.test (APNs and FCM against local fakes) | hub push.test; web push-subscribe.test; web push-sw.test; web deeplinks-m7.test | J9 | push: Web Push from the Hub, native apps through the Relay; only ids, a redacted title and a `nova://` link; `push.detail` |
| FR-112 | core sync-idempotency.test | hub sync-idempotency.test; web offline-queue.test; web offline-reads.test | J9 | offline queue: writes become sync changes with a visible status and their own `Idempotency-Key`, sent in order with backoff and jitter once the copy catches up; the Hub replays an opted-in route's first answer for 24 h |
| FR-113 | core profile.test; core team-oidc.test (fake OIDC provider); core team-members.test (profile cards) | hub profile.test; hub team-oidc.test; hub team.test (profile card); web profile-settings.test; web team-oidc.test; web team-card.test | — | profile; M7: OIDC sign-in, link and join (code flow with PKCE and nonce, ID token checked with node:crypto, browser-binding cookie); public card only with `team.publicProfiles` and the person's opt-in |
| FR-114 | core usage.test | hub profile.test; web profile-settings.test | J4 | usage insights |
| FR-115 | core profile-accounts.test | hub profile.test; web settings.test | — | multiple accounts |
| FR-116 | runner-service server.test (CPU, wall-time and disk caps); core cloudrun.test (cap, then raised) | web cloud-run.test; web cloud-settings.test (caps) | J10 | spend caps per provider are M8; M7 built the cloud runner's caps: CPU and wall time per run, disk per environment, warning at 80 % by default, hard stop, caps can be raised |
| FR-117 | todo | todo | J10 | extension SDK |
| FR-118 | telemetry ring.test | hub ops.test; web diagnostics-settings.test | — | logging |
| FR-119 | hub diagnostics-m5.test | web diagnostics-m5.test | — | diagnostics |
| FR-120 | todo | todo | J11 | auto-update |
| FR-121 | todo | todo | — | crash reporting |
| FR-122 | todo | todo | — | performance budgets |
| FR-123 | todo | todo | — | security suite |
| FR-124 | hub hub.test | hub hub.test | J1 | hub service hosts canonical state |
| FR-125 | hub hub.test | hub chat.test | J1 | thin clients, hub-served UI |
| FR-126 | core nodes.test; core device-credentials.test; core nodes-ops.test (node policy, quiet hours, services); core devices-ops.test (management channel over mutual TLS, no downgrade, legacy certificates, renewal); core trust.test; compute *.test (hub-tls.test: pinned https, mutual TLS; m75.test: VRAM, quiet hours, `/node/v1/services`); novad TLS and mgmt_tls tests (`node scripts/cargo.mjs test`); shared m7-devices.test | hub node-routes.test (real node); hub device-trust.test; hub m7-novad-tls.test (real `novad` over mutual TLS); hub m75-novad-mtls.test (real `novad`: the management channel over mutual TLS, no plain-HTTP fallback, `endpoint_downgrade`, certificate renewal); hub devices-m75.test; hub devices-novad.test (real binary); web devices.test; web devices-tls.test; web devices-m75-ops.test | — | compute node registration; M7 mutual TLS: the Hub asks for a device certificate of its local CA without requiring one, the device and node routes check it belongs to the caller, a revoked one is refused; M7.5 (ADR-096): mutual TLS on the Hub → `novad` management channel, certificate renewal, compute node VRAM, quiet hours and services |
| FR-127 | core router.test, nodes-routing.test | core router.test (chat through router) | — | routing order |
| FR-128 | core sync-service.test (local answers); core device-credentials.test (heartbeat scopes); desktop local-runtime.test; novad local-runtime and per-user socket tests (`node scripts/cargo.mjs test`) | hub sync.test (`local-runtime` scope, answer route); hub m7-novad-tls.test (scope reaches `scopes.json`); web offline-local.test; web offline-labels.test | J9; desktop shell.spec (offline start, e2e-shell) | local fallback: the desktop shell's `novaShell.localRuntime` reaches `novad`'s local runtime; the answer is kept on the device, queued and stored labelled `offline`; an offline message gets a Hub answer only when asked |
| FR-129 | core sync-service.test (snapshot, reset, replicas) | hub sync.test (replica routes need `offline-replica`; revocation and scope removal end the copy); web replica-engine.test; web offline-reads.test | J9 | capability-gated offline replica: snapshot pages, then the change feed; revocation, a 401 or a withdrawn grant wipes the copy and its non-extractable key |
| FR-130 | todo | todo | — | hub failover (post-v1) |
| FR-131 | core scheduler-service.test | hub schedules.test | J5 | reactive + proactive |
| FR-132 | core pairing.test, pairing-binding.test (fixed v1/v2 vectors, on-path attacker, code-only budget, deny race, mid-grant revocation); compute add-device.test; novad install tests (`node scripts/cargo.mjs test`); web join-units.test | hub add-device.test (v2 over HTTP); hub m65-integration.test (real `novad`, wired Hub); hub relay-integration.test (join over the Relay); web devices-add.test, join-page.test | J8.5 | add device: QR or code, commit-then-reveal, Hub-signed confirmation, approval, one-time grant |
| FR-133 | hub agent-dist.test (manifest, domain-tagged signature, command shape, rate limit); novad install tests (pin, signature, self-hash, bytes installed, code off argv) | hub agent-dist-novad.test (Node signs, the real binary verifies); hub m65-integration.test | J8.5 | signed novad builds and `novad install` |
| FR-134 | core trust.test (identity refuses to load, CA never replaced on its own, name constraints, nonce-bound statement, pinning check), trust-x509.test; desktop pinning.test, connect.test; compute hub-tls.test; novad TLS tests | hub trust.test; hub trust-main.test (real HTTPS start, live renewal, loopback fallback); hub m7-novad-tls.test; web netsurface-trust.test | J8.5; desktop shell.spec (wrong pin refused, e2e-shell) | trust paths: local CA, mesh certificates, pinning; M7: the desktop shell, `novad` and compute nodes check the pinned statement on the connection itself |
| FR-135 | core network-endpoints.test (candidates, signed probe, Hub CA plus default roots), network-mdns.test; shared network.test (`selectEndpoint`) | hub network.test; web netsurface-overview.test | J8.5 | endpoints, health checks, LAN → Mesh → Relay order, mDNS |
| FR-136 | core network-mesh.test, network-setup.test (fake CLIs: plans, consent, lock-out guard, rollback, `rollback_failed`, secrets never in argv) | hub network-setup.test; web netsurface-setup.test | J8.5 | network setup assistant |
| FR-137 | relay envelope.test, crypto.test, session.test, connection.test, client.test; relay-service server.test, limits.test, push.test; core relayhub.test; web relay-transport.test | hub relay.test (tunnel path filter); hub relay-integration.test (real Add Device, buildHub, Relay restart); hub relay-token.test; hub push.test (native apps through the Relay); web netsurface-relay.test; web relay-join.test; web netsurface-relay-token.test | J8.5 | relay: built in M6.5; M7: real APNs and FCM senders in the Relay behind the operator's `NOVA_RELAY_APNS_*` and `NOVA_RELAY_FCM_SERVICE_ACCOUNT_FILE` (a recording mock otherwise), `/v1/relay/push/notify`, the registration token, web join and transport through the Relay; the channel relay is not built |
| FR-138 | core network-wake.test (helper matching, computed broadcast, attempts counted); novad power tests (`wake_helper_*`) | hub network-wake.test; web netsurface-wake.test | J8.5 | wake helper |
| FR-139 | core network-changes.test (change log, undo handlers, rollback lock) | hub network.test (diagnostics, rollback); web netsurface-overview.test, netsurface-surface.test | J8.5 | network diagnostics and one-click rollback |
| FR-140 | core pairing.test (device list, scopes, revocation of every kind); core devices-ops.test, devices-decommission-hub-only.test (decommission); novad uninstall tests (order, purge guard) | hub add-device.test; hub node-routes.test (revoke falls through); hub devices-m75.test (decommission routes); web devices-manage.test, devices-list.test, devices-page.test, devices-m75-ops.test | J8.5 | device management UI; M7.5 decommission and `novad uninstall` |
| FR-141 | novad supervisor, module, procs and hardening tests (`node scripts/cargo.mjs test`; M7.5: children started by a request outlive it, `spawn_kept`; protected system folders); core devices-service.test | hub devices-novad.test (real binary); hub devices.test | J7 | novad supervisor + modules |
| FR-142 | novad capabilities and crypto tests; core devices-service.test | hub devices-novad.test (Rust signs, Node verifies); hub devices.test | J7 | capability declaration |
| FR-143 | core boot-service.test, boot-pxe.test, boot-fake.test; core firmware-authz.test (the `boot.set` vector); novad boot and authz tests (`node scripts/cargo.mjs test`: one-shot, watchdog, GRUB verification) | hub boot.test; hub devices-policy-push.test (the toggle synced before a trial, one retry, the request back to waiting); hub boot-pxe.test (public routes, tokens, rate limits); hub settings-m75.test (the consent switches); hub listeners.test; web boot-tab.test, firmware-settings.test | J9.5 | low-level boot: profiles, one-shot trials with watchdogs, PXE by boot token (ADR-096) |
| FR-144 | core devices-wol.test; novad power tests | hub devices-area.test | J7 | power & WoL |
| FR-145 | core devices-service.test; core devices-ops.test (services list); novad agent tests | hub devices-novad.test; hub devices-m75.test | J7 | service management; M7.5 `GET /devices/:id/services` |
| FR-146 | core firmware-authz.test (the shared vectors), firmware-service.test; core channels-hub-only.test; novad firmware and authz tests (`node scripts/cargo.mjs test`: plan, apply, rollback, the watchdog, the matrix, every refusal); web firmware-units.test; shared firmware-matrix.test (the support matrix against novad's fixture) | hub firmware.test; hub devices-policy-push.test (the toggle pushed at once, synced before apply, one retry, `device_policy_stale` keeps the approval); hub m75-novad-mtls.test (a signed apply on the real `novad` over mutual TLS, the policy push into `policy.json`); hub settings-m75.test (consent switches, one audit entry per change); hub devices-novad.test (real binary); web firmware-tab.test, firmware-settings.test | J9.5 | BIOS/firmware management: toggle off by default, consent, diff, snapshot, Hub-only approval, rollback, the security override, the watchdog, audit (ADR-096) |
| FR-147 | core oob-protocols.test (Redfish with a pinned certificate, `ipmitool`), oob-service.test (consent, addresses, pins confirmed before credentials, approvals bound to the BMC) | hub oob.test; hub settings-m75.test (enable and disable audited once); web oob.test | J9.5 | out-of-band management on the Hub: off by default, owner-only, approved and audited; no Intel AMT (ADR-096) |
| FR-148 | core devices-versions.test; core devices-ops.test (available build); novad update tests | hub devices-area.test; hub devices.test; hub devices-m75.test | J7 | novad updates, minimum versions; M7.5 `GET /devices/:id/updates/available` |
| FR-149 | core attachments.test (sealing) | hub ops.test (TLS) | — | hub trusted, edges E2E |
| FR-150 | core devices-service.test; core devices-ops.test (overrides, push now) | hub devices-area.test; hub devices.test; hub devices-m75.test; web devices-m75-ops.test | J7 | per-device overrides and policy |
| FR-151 | todo | todo | — | ambient capture |
| FR-152 | todo | todo | — | OCR/STT pipeline |
| FR-153 | todo | todo | — | ambient timeline/search |
| FR-154 | todo | todo | — | ambient privacy controls |
| FR-155 | todo | todo | — | ambient agent/MCP access |
| FR-156 | todo | todo | — | ambient resource governor |
| FR-157 | todo | todo | — | automation engine |
| FR-158 | todo | todo | — | trigger kinds |
| FR-159 | todo | todo | — | action kinds |
| FR-160 | todo | todo | — | automation safety |
| FR-161 | todo | todo | — | smart-home integrations |
| FR-162 | todo | todo | — | entity model |
| FR-163 | todo | todo | — | agent↔automation interop |
| FR-164 | todo | todo | — | managed policy for smart home |
| FR-165 | todo | todo | — | unified catalog |
| FR-166 | todo | todo | — | MCP registry import |
| FR-167 | todo | todo | — | signed publish + permission diff |
| FR-168 | todo | todo | — | community governance |
| FR-169 | todo | todo | — | L0 memory learning |
| FR-170 | todo | todo | — | L1 skill synthesis |
| FR-171 | todo | todo | — | L2 evaluated optimization |
| FR-172 | todo | todo | — | L3 bounded self-tuning |
| FR-173 | todo | todo | — | L4 code self-modification |
| FR-174 | todo | todo | — | L5 local fine-tuning |
| FR-175 | todo | todo | — | eval harness + kill switch |
| FR-176 | todo | todo | — | smart-home bootstrap |
| FR-177 | todo | todo | — | catalog endpoints |
| FR-178 | todo | todo | — | skill authoring/generation |
| FR-179 | todo | todo | — | HomeKit bridge |
| FR-180 | todo | todo | — | Matter bridge |
| FR-181 | core runs-goals.test; core agents-turns.test (agent goals) | hub runs.test; hub agents.test; web work-run.test | J5 | goals: statuses, blocked-after-3, idle continuation |
| FR-182 | core runs-budgets.test; core loop-m5-extensions.test | hub runs.test; web work-run.test | J5 | budgets pause; per-turn backstop |
| FR-183 | core context-compaction.test | web chat-followup.test | — | three compaction triggers |
| FR-184 | core exec-sessions.test | hub exec-sessions.test; web code-terminal.test | J6 | interactive exec sessions |
| FR-185 | core context-instructions.test | core context-instructions.test | J6 | instruction-file discovery + budget |
| FR-186 | core runs-escalation.test | web work-chat.test | J5 | chat escalation to Work |
| FR-187 | core runs-lifecycle.test; core scheduler-delivery.test | hub m5-integration.test | J5 | verified outcomes |
| FR-188 | core requests-broker.test; core requests-ask-tool.test; core loop-m7-answer.test | hub requests.test; web work-chat.test | J3 | server-to-client requests; M7: the signed-in user's `ask_user` answer gives the rest of that turn their authority and reaches the model as their words |
| FR-189 | policy engine tests (tiers, provenance) | core gate.test | J3 | confirmation tiers + intent provenance |
| FR-190 | policy paths/profiles tests; core sandbox-protect.test | core tools-fs.test | J3 | permission profiles + protected paths (also mounted in sandboxes) |
| FR-191 | policy command tests | hub policy.test; web permissions-settings.test | J3 | command prefix rules + load-time examples |
| FR-192 | security tokens tests; novad mgmt_tls and bridge tests (`node scripts/cargo.mjs test`) | hub listeners.test, hub.test; hub m75-novad-mtls.test (no client certificate refused at the handshake, plain HTTP not served); hub boot-pxe.test (the boot token routes); hub browser-m75.test (`/agent/v1/bridge/events` with the device credential) | — | listener tokens, Origin checks, no auto-registration; M7.5: the management channel's client certificate, the PXE routes' per-device token, the bridge's per-user socket and token, registration only by `novad bridge enable` |
| FR-193 | core egress-policy.test; core egress-proxy.test; core gate-m6-agents.test (`egressDeny`); core browser-session.test (`egressMode`); shared settings.test (host patterns) | core computers-egress.test; core sandbox-container.test; hub computers.test (decision log paging) | J8 | proxy modes + credential injection |
| FR-194 | core agents-external.test; core browser-injection.test | core channels-service.test; hub agents.test | J8 | external-agent rule |
| FR-195 | core sandbox-container.test (micro-VM stub) | — | — | micro-VM substrate (flagged; stub) |
| FR-196 | core tools-registry/search tests | core loop.test | J3 | deferred tools + tool search |
| FR-197 | core hooks.test; core hooks-config.test; core gate-hooks.test; policy plugins-hooks.test | core loop-hooks.test; hub hooks.test; web plugins-settings.test | J4 | lifecycle hooks (tighten-only) |
| FR-198 | web apps-bridge.test; mcp apps.test | hub mcp-apps.test; web apps-frame.test; web apps-views.test; web workspace-apps.test | J4 | MCP Apps UI |
| FR-199 | mcp bundle.test | hub bundles.test | J4 | MCP bundles |
| FR-200 | core import.test; core import-formats.test | hub import.test; web import-settings.test | — | import from other assistants |
| FR-201 | mcp events.test; core triggers-service.test | hub channels.test | J7 | MCP event subscriptions |
| FR-202 | core scripts-vm.test (limits, worker isolation); core scripts-tool.test (nested calls through the gate) | hub flagged.test; web flagged-panes.test; web flagged-settings.test | — | scripted tool calls (flagged, `scripts.enabled` off): QuickJS in a worker; 5 s, 32 MiB and 20 nested calls by default; each nested call through the tool runtime and the gate |
| FR-203 | core acp-protocol.test (fake ACP agent); core acp-delegation.test; core acp-security.test; core egress-agent-policy.test | hub flagged.test; web flagged-panes.test; web flagged-settings.test | — | external agent adapters (flagged, `externalAgents.enabled` off): agent in the session sandbox, folder read-only, network only to declared hosts; its file and command requests pass the gate; `allow_always` never picked |
| FR-204 | core consolidation.test | hub consolidation.test; web memory-consolidation.test | — | memory consolidation |
| FR-205 | core history.test | hub consolidation.test | — | memory scopes + history reference |
| FR-206 | core agents-proactive.test (wakes); core scheduler-service.test (`agentId` on schedule events) | hub agents.test | J7 | agent self-scheduling |
| FR-207 | core screen-tools.test; core screen-service.test | hub screen.test | J8 | computer-use control tiers |
| FR-208 | core browser-session.test | core browser-chromium.test | — | page-registered tools |
| FR-209 | core browser-fallback.test (offer, consent, sessions, end reasons, orphans); core browser-fallback-device.test (fake `novad`; a real Chromium part that skips where none starts); core browser-session.test; novad browser, egress and ws tests (`node scripts/cargo.mjs test`: launch, dedicated users, the egress filter, the DevTools WebSocket) | hub browser-m75.test (fallback routes, trace marks); web browserdevice-offer.test, browserdevice-settings.test | — | local browser fallback on a connected computer (ADR-096) |
| FR-210 | core devices-files.test, devices-tools.test; novad fsops and grants tests | hub devices-novad.test; hub devices.test, devices-tools.test | J7 | novad staged writes + local MCP; agent `device.files.*` tools |
| FR-211 | core code-git.test | core code-git.test (marker hook) | J6 | hook-free app git ops |
| FR-212 | core code-m7-attempts.test | hub code-m7.test (attempts); web code-m7-session.test (Best of N) | — | best-of-N: 2 to 4 attempts in their own worktrees with budgets and an optional model; compare files, patch, tests and cost; applying one merges it and removes every attempt worktree |
| FR-213 | core code-m7-handoff.test; core code-m7-transport.test | hub code-m7.test (handoff over HTTP, chat to a device); web code-m7-session.test (Hand off) | J9 | session handoff: branch, HEAD, commits as a bundle, uncommitted changes as one binary-safe patch; the target must be clean and confirm HEAD and tree; a chat handoff only records and announces the move |
| FR-214 | desktop capture.test (AT-SPI through a fake `gdbus`, redaction, excluded apps); desktop hub-client.test (attach) | web shellbridge-views.test (attach shortcut) | — | attach window: Linux text through AT-SPI (password fields never read), redacted, sent only after the preview; not in the Electron journey (the container has no accessibility bus); macOS and Windows text not built |
| FR-215 | core status-thread.test | hub m5-integration.test; web work-sidebar.test | J5 | thread status model |
| FR-216 | todo | todo | — | dictation |
| FR-217 | core team-shared.test; core gate-m7-limits.test (shared threads); core team-review.test | hub team.test (shared threads over HTTP); hub team-review.test; web team-shared.test | — | shared threads: each turn runs under its writer; nobody's memory, instructions or connectors join; only content tools (web search, artifacts, documents, visualizations, images, loop tools) |
| FR-218 | todo | todo | — | voice-call channel; not built in M7 |
| FR-219 | core documents-writers.test; core documents-readers.test | core documents-tools.test; web documents-preview.test | J5 | document outputs |
| FR-220 | core runs-escalation.test (deep research) | web work-list.test | J5 | deep research run |
| FR-221 | core presets.test | hub model-routes.test; web models-settings.test | J2 | model presets |
| FR-222 | todo | todo | — | third-party app authorization |
| FR-223 | todo | todo | — | opt-in OTLP export |
| FR-224 | todo | todo | — | persistence safety evals |
| FR-225 | todo | todo | J11 | install robustness |
| FR-226 | todo | todo | — | skill from demonstration |
| FR-227 | todo | todo | — | redaction release gate |
| FR-228 | todo | todo | — | capture split |
| FR-229 | todo | todo | — | activity summary |
| FR-230 | todo | todo | — | meeting detection |
| FR-231 | todo | todo | — | speaker identity |
| FR-232 | todo | todo | — | capture provenance checks |
| FR-233 | todo | todo | — | scoped ambient grants |
