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
| FR-007 | web deeplinks.test | web deeplinks.test (router) | — | deep links |
| FR-008 | todo | todo | — | tray |
| FR-009 | todo | todo | — | multi-window |
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
| FR-030 | core images-tool.test | — | — | image gen (hidden until a provider has an images call) |
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
| FR-042 | mcp names/content tests | mcp stdio/http tests; hub mcp.test | J3 | MCP client |
| FR-043 | mcp connection tests | hub mcp.test; web tools-settings.test | J3 | MCP health |
| FR-044 | mcp server.test | hub mcp-server.test; web clients-settings.test | — | MCP server |
| FR-045 | core plugins-manifest.test; core plugins-catalog.test; core plugins-service.test; policy plugins-hooks.test | hub plugins.test; hub policy-loop.test; web plugins-settings.test | J4 | plugins |
| FR-046 | core skills.test; core skills-frontmatter.test | core loop-skills.test; web chat-suggest-slash.test | J4 | skills |
| FR-047 | mcp oauth.test; mcp oauth-service.test | hub oauth.test | — | connectors (OAuth PKCE) |
| FR-048 | policy engine tests | hub policy.test; web tools-settings.test | J3 | per-tool defaults |
| FR-049 | todo | todo | J10 | marketplace |
| FR-050 | core plugin-authoring.test | core plugin-authoring.test | — | build plugin/skill (drafts) |
| FR-051 | core runs-lifecycle.test; core runs-loop.test | hub runs.test; hub m5-integration.test; web work-run.test | J5 | work run |
| FR-052 | core runs-lifecycle.test (recover) | hub runs.test | J5 | continue when closed |
| FR-053 | core runs-subagents.test | hub runs.test | J5 | sub-agents |
| FR-054 | core runs-subagents.test | web work-run.test | J5 | child threads |
| FR-055 | core scheduler-recurrence.test; core scheduler-service.test | hub schedules.test; hub m5-integration.test; web work-scheduled.test | J5 | schedules |
| FR-056 | core triggers-service.test | hub channels.test | J7 | event triggers: webhook signature (event id signed when sent), dedupe, rate cap, no authority |
| FR-057 | core runs-lifecycle.test (activity) | hub runs.test; web work-run.test | J5 | activity |
| FR-058 | core runs-budgets.test (approval timeout) | core gate-m5-policy.test | J5 | approvals |
| FR-059 | core runs-lifecycle.test (RunStarter); core agents-turns.test (agent.delegate) | hub agents.test | — | delegation to a Work run; delegating to a Code session is not built |
| FR-060 | core channels-notify.test; core notifications.test; core channels-service.test (`mayNotify`) | hub channels.test | J7 | notification routing, quiet hours, `os` flag, shared copies withheld unless `channels.privateToShared` is `allow` |
| FR-061 | core code-sessions.test | hub code.test; hub m5-integration.test; web code-sessions.test | J6 | code session |
| FR-062 | core code-m6-environments.test; core sandbox-router.test; core devices-files.test (device environment) | hub code-m6.test | — | environments: container, SSH, WSL, device |
| FR-063 | core code-sessions.test (policy); core gate-m5-policy.test; core code-m6-environments.test (no Bypass on another machine) | hub policy-m5.test; web code-sessions.test | J6 | permission modes |
| FR-064 | core code-changes.test | hub m5-integration.test; web code-diff.test | J6 | file edits |
| FR-065 | core code-changes.test | web code-diff.test | J6 | diff review |
| FR-066 | core code-sessions.test (terminal) | web code-terminal.test | J6 | terminal |
| FR-067 | core code-m6-devservers.test; core browser-devserver.test (grant and opener through bubblewrap, the bridge and the real proxy) | hub code-m6.test | J6 | browser pane opens the dev server once it answers |
| FR-068 | core code-m6-verify.test | hub code-m6.test | J6 | auto-verify, feedback turns |
| FR-069 | core code-tools.test (review) | web code-review.test | J6 | code review |
| FR-070 | core code-m6-pr.test (mock Git host) | hub code-m6.test | J6 | PR flow: push guards (`http://` remote refused), secrets scan, CI polling and feedback |
| FR-071 | todo | todo | J9 | cloud envs |
| FR-072 | core code-m6-sessions.test; core agents-turns.test (sessions.*) | hub code-m6.test | — | cross-session list, message, archive, ask |
| FR-073 | core code-m6-worktrees.test; core code-m6-sessions.test (task.spawn) | hub code-m6.test | — | worktree registry, leases, `.worktreeinclude`, cap |
| FR-074 | core code-tools.test (symbols) | web code-units.test | J6 | repo index (pattern-based) |
| FR-075 | core screen-service.test; core screen-tools.test | hub screen.test | — | appshots |
| FR-076 | core spaces-viz.test; core spaces-tools.test (visualize.create) | web spaces-viz.test; web spaces-markdown.test | — | visualizations (chart, diagram, notebook) |
| FR-077 | todo | todo | J9 | mobile dispatch |
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
| FR-091 | todo | todo | — | specialist agents |
| FR-092 | core browser-session.test | core browser-chromium.test (Playwright container); hub browser.test | J8 | browser tool |
| FR-093 | core screen-desktop.test; core screen-tools.test | hub screen.test | J8 | computer use (mock desktop) |
| FR-094 | core browser-policy.test | core browser-chromium.test; hub browser.test | J8 | allow/block lists, site levels |
| FR-095 | core browser-classifier.test | core browser-policy.test; core browser-chromium.test | J8 | write-action classifier |
| FR-096 | core browser-session.test (profiles, cookies) | hub browser.test | — | browser profiles; the extension bridge is not built |
| FR-097 | core code-m6-devservers.test; core sandbox-publish.test (bridge, Docker and bubblewrap) | hub code-m6.test | J6 | dev servers |
| FR-098 | core browser-recording.test; core screen-service.test | hub browser.test; hub screen.test | J8 | action screenshots |
| FR-099 | policy engine tests | core gate.test, loop.test | J3 | policy engine |
| FR-100 | core gate.test | hub policy.test; web chat-approvals.test | J3 | approvals |
| FR-101 | secrets keychain.test; security scan.test | hub ops.test (vault, keychain select) | — | secrets |
| FR-102 | core egress-proxy.test; core egress-store.test | hub computers.test | J8 | egress control |
| FR-103 | core browser-injection.test; core browser-classifier.test | core browser-chromium.test | J8 | injection defense (browser) |
| FR-104 | core audit.test | hub ops.test; hub diagnostics-m5.test (export) | J3 | audit log |
| FR-105 | todo | todo | J10 | data controls |
| FR-106 | todo | todo | J10 | managed policy |
| FR-107 | core sandbox-bwrap.test; core sandbox-container.test; core sandbox-process.test | hub devices-novad.test (novad sandbox) | J7 | sandboxing: bubblewrap, container |
| FR-108 | todo | todo | J9 | cloud runner |
| FR-109 | todo | todo | J9 | sync |
| FR-110 | todo | todo | J9 | channel bridge |
| FR-111 | todo | todo | J9 | mobile dispatch |
| FR-112 | todo | todo | J9 | offline queue |
| FR-113 | core profile.test | hub profile.test; web profile-settings.test | — | profile |
| FR-114 | core usage.test | hub profile.test; web profile-settings.test | J4 | usage insights |
| FR-115 | core profile-accounts.test | hub profile.test; web settings.test | — | multiple accounts |
| FR-116 | todo | todo | J10 | spend caps |
| FR-117 | todo | todo | J10 | extension SDK |
| FR-118 | telemetry ring.test | hub ops.test; web diagnostics-settings.test | — | logging |
| FR-119 | hub diagnostics-m5.test | web diagnostics-m5.test | — | diagnostics |
| FR-120 | todo | todo | J11 | auto-update |
| FR-121 | todo | todo | — | crash reporting |
| FR-122 | todo | todo | — | performance budgets |
| FR-123 | todo | todo | — | security suite |
| FR-124 | hub hub.test | hub hub.test | J1 | hub service hosts canonical state |
| FR-125 | hub hub.test | hub chat.test | J1 | thin clients, hub-served UI |
| FR-126 | core nodes.test; compute *.test | hub node-routes.test (real node); web devices.test | — | compute node registration |
| FR-127 | core router.test, nodes-routing.test | core router.test (chat through router) | — | routing order |
| FR-128 | todo | todo | J9 | local fallback |
| FR-129 | todo | todo | J9 | capability-gated offline replica |
| FR-130 | todo | todo | — | hub failover (post-v1) |
| FR-131 | core scheduler-service.test | hub schedules.test | J5 | reactive + proactive |
| FR-132 | core pairing.test, pairing-binding.test (fixed v1/v2 vectors, on-path attacker, code-only budget, deny race, mid-grant revocation); compute add-device.test; novad install tests (`node scripts/cargo.mjs test`); web join-units.test | hub add-device.test (v2 over HTTP); hub m65-integration.test (real `novad`, wired Hub); hub relay-integration.test (join over the Relay); web devices-add.test, join-page.test | J8.5 | add device: QR or code, commit-then-reveal, Hub-signed confirmation, approval, one-time grant |
| FR-133 | hub agent-dist.test (manifest, domain-tagged signature, command shape, rate limit); novad install tests (pin, signature, self-hash, bytes installed, code off argv) | hub agent-dist-novad.test (Node signs, the real binary verifies); hub m65-integration.test | J8.5 | signed novad builds and `novad install` |
| FR-134 | core trust.test (identity refuses to load, CA never replaced on its own, name constraints, nonce-bound statement, pinning check), trust-x509.test | hub trust.test; hub trust-main.test (real HTTPS start, live renewal, loopback fallback); web netsurface-trust.test | J8.5 | trust paths: local CA, mesh certificates, pinning |
| FR-135 | core network-endpoints.test (candidates, signed probe, Hub CA plus default roots), network-mdns.test; shared network.test (`selectEndpoint`) | hub network.test; web netsurface-overview.test | J8.5 | endpoints, health checks, LAN → Mesh → Relay order, mDNS |
| FR-136 | core network-mesh.test, network-setup.test (fake CLIs: plans, consent, lock-out guard, rollback, `rollback_failed`, secrets never in argv) | hub network-setup.test; web netsurface-setup.test | J8.5 | network setup assistant |
| FR-137 | relay envelope.test, crypto.test, session.test, connection.test, client.test; relay-service server.test, limits.test; core relayhub.test | hub relay.test (tunnel path filter); hub relay-integration.test (real Add Device, buildHub, Relay restart); web netsurface-relay.test | J8.5 | relay: built in M6.5 except real push senders and the channel relay (M7) |
| FR-138 | core network-wake.test (helper matching, computed broadcast, attempts counted); novad power tests (`wake_helper_*`) | hub network-wake.test; web netsurface-wake.test | J8.5 | wake helper |
| FR-139 | core network-changes.test (change log, undo handlers, rollback lock) | hub network.test (diagnostics, rollback); web netsurface-overview.test, netsurface-surface.test | J8.5 | network diagnostics and one-click rollback |
| FR-140 | core pairing.test (device list, scopes, revocation of every kind) | hub add-device.test; hub node-routes.test (revoke falls through); web devices-manage.test, devices-list.test, devices-page.test | J8.5 | device management UI |
| FR-141 | novad supervisor, module and hardening tests (`node scripts/cargo.mjs test`); core devices-service.test | hub devices-novad.test (real binary); hub devices.test | J7 | novad supervisor + modules |
| FR-142 | novad capabilities and crypto tests; core devices-service.test | hub devices-novad.test (Rust signs, Node verifies); hub devices.test | J7 | capability declaration |
| FR-143 | todo | todo | — | low-level boot |
| FR-144 | core devices-wol.test; novad power tests | hub devices-area.test | J7 | power & WoL |
| FR-145 | core devices-service.test; novad agent tests | hub devices-novad.test | J7 | service management |
| FR-146 | todo | todo | J10 | BIOS/firmware management |
| FR-147 | todo | todo | — | out-of-band management |
| FR-148 | core devices-versions.test; novad update tests | hub devices-area.test; hub devices.test | J7 | novad updates, minimum versions |
| FR-149 | core attachments.test (sealing) | hub ops.test (TLS) | — | hub trusted, edges E2E |
| FR-150 | core devices-service.test | hub devices-area.test; hub devices.test | J7 | per-device overrides and policy |
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
| FR-188 | core requests-broker.test; core requests-ask-tool.test | hub requests.test; web work-chat.test | J3 | server-to-client requests |
| FR-189 | policy engine tests (tiers, provenance) | core gate.test | J3 | confirmation tiers + intent provenance |
| FR-190 | policy paths/profiles tests; core sandbox-protect.test | core tools-fs.test | J3 | permission profiles + protected paths (also mounted in sandboxes) |
| FR-191 | policy command tests | hub policy.test; web permissions-settings.test | J3 | command prefix rules + load-time examples |
| FR-192 | security tokens tests | hub listeners.test, hub.test | — | listener tokens, Origin checks, no auto-registration |
| FR-193 | core egress-policy.test; core egress-proxy.test; core gate-m6-agents.test (`egressDeny`); core browser-session.test (`egressMode`); shared settings.test (host patterns) | core computers-egress.test; core sandbox-container.test; hub computers.test (decision log paging) | J8 | proxy modes + credential injection |
| FR-194 | core agents-external.test; core browser-injection.test | core channels-service.test; hub agents.test | J8 | external-agent rule |
| FR-195 | core sandbox-container.test (micro-VM stub) | — | — | micro-VM substrate (flagged; stub) |
| FR-196 | core tools-registry/search tests | core loop.test | J3 | deferred tools + tool search |
| FR-197 | core hooks.test; core hooks-config.test; core gate-hooks.test; policy plugins-hooks.test | core loop-hooks.test; hub hooks.test; web plugins-settings.test | J4 | lifecycle hooks (tighten-only) |
| FR-198 | web apps-bridge.test; mcp apps.test | hub mcp-apps.test; web apps-frame.test; web apps-views.test; web workspace-apps.test | J4 | MCP Apps UI |
| FR-199 | mcp bundle.test | hub bundles.test | J4 | MCP bundles |
| FR-200 | core import.test; core import-formats.test | hub import.test; web import-settings.test | — | import from other assistants |
| FR-201 | mcp events.test; core triggers-service.test | hub channels.test | J7 | MCP event subscriptions |
| FR-202 | todo | todo | — | scripted tool calls (flagged) |
| FR-203 | todo | todo | — | external agent adapters (flagged) |
| FR-204 | core consolidation.test | hub consolidation.test; web memory-consolidation.test | — | memory consolidation |
| FR-205 | core history.test | hub consolidation.test | — | memory scopes + history reference |
| FR-206 | core agents-proactive.test (wakes); core scheduler-service.test (`agentId` on schedule events) | hub agents.test | J7 | agent self-scheduling |
| FR-207 | core screen-tools.test; core screen-service.test | hub screen.test | J8 | computer-use control tiers |
| FR-208 | core browser-session.test | core browser-chromium.test | — | page-registered tools |
| FR-209 | core browser-session.test (refuses) | — | — | local browser fallback (refuses until a device serves it) |
| FR-210 | core devices-files.test, devices-tools.test; novad fsops and grants tests | hub devices-novad.test; hub devices.test, devices-tools.test | J7 | novad staged writes + local MCP; agent `device.files.*` tools |
| FR-211 | core code-git.test | core code-git.test (marker hook) | J6 | hook-free app git ops |
| FR-212 | todo | todo | — | best-of-N attempts |
| FR-213 | todo | todo | J9 | session handoff |
| FR-214 | todo | todo | — | attach window |
| FR-215 | core status-thread.test | hub m5-integration.test; web work-sidebar.test | J5 | thread status model |
| FR-216 | todo | todo | — | dictation |
| FR-217 | todo | todo | — | shared threads |
| FR-218 | todo | todo | — | voice-call channel |
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
