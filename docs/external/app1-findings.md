# External findings: APP-1 (chat assistant product, 2026 state)

Input for the Phase 0 reconciliation (`PROMPT.md` §2). These are **findings, not decisions**.
APP-1 is an opaque ID (`docs/19` §1.3). Its identity, and the real source behind every evidence
ref, live in the private ledger (`docs/external/private/`, not committed). Requirements derived
from this file must be rewritten in vendor-neutral language (`docs/01` §5, the brand-name
invariant).

Scope: APP-1 as a product (desktop, web and mobile clients) as of 2026-10-16. Two neighbours
have their own files:

- APP-1's desktop client hosts **APP-3's engine** for delegated work and coding. The engine's
  agent loop, sandbox, approvals, plugin manifest format, hooks and local two-phase memory
  pipeline are covered there; records below say "see app3-findings".
- APP-1's **always-on agents** are APP-4; see app4-findings.

## Provenance

| | |
| --- | --- |
| Target | APP-1: the chat assistant product. Web and mobile clients, plus a unified desktop client with chat, delegated-work and coding modes. |
| Version | Windows desktop package 26.1007.2314.0 (x64), observed. Vendor docs as of 2026-10-16. |
| Method | Desk research of vendor product docs, developer docs and press. Read-only inspection of the desktop package installed on the owner's Windows machine: directory listings, the package manifest, and bundled non-user files. No credential stores, cookies, config files, session or conversation files were opened. **Nothing was run or instrumented.** The vendor's main site and help center returned HTTP 403 to direct fetches, so claims from them come from search-engine excerpts. macOS-only features were not observed. |
| Evidence refs | Opaque: `APP1/doc/…` vendor docs, `APP1/bin/…` package inspection, `APP1/obs/…` other observations on the owner's machine, `press/…` press, `third-party/…` other third-party sources. Real URLs and paths: `docs/external/private/app1-refs.md`. |
| Date | 2026-10-16 (research); converted to this format 2026-10-17 |

### Confidence

- **high**: a vendor doc page read in full, or directly observed in the installed package (file
  present, manifest content).
- **medium**: a vendor page seen only through search-engine excerpts, or reputable press that
  agrees with vendor material.
- **low**: an inference, a single third-party or user report, or press without vendor
  corroboration.

A record's confidence covers its claim. When a record mentions a weaker side claim, `limits`
names it and gives its level.

Reading notes:

- Several features launched, were renamed or were retired during 2026. Records give dates where
  known; check them before treating a capability as current.
- `binary` and `observed` evidence is file contents and listings, not runtime behaviour.
- Evidence type `press` covers both `press/…` and `third-party/…` refs.

## Capability summary

| # | Capability | Evidence records | Nova coverage |
| --- | --- | --- | --- |
| 1 | One desktop client with chat, delegated-work and coding modes; classic app kept; import from other assistants | ER-APP1-001 | `docs/04` §1, FR-002 (Nova has a fourth Agents mode; APP-1 ships always-on agents as APP-4); covered. Import: INV-B15, FR-032 (memory only); partially |
| 2 | Chromium-based runtime inherited from a retired browser; bundled engine, plugins, skills | ER-APP1-002, 003 | ADR-001, ADR-006, `docs/15`; partially (Nova pairs Electron with a separately launched automation browser) |
| 3 | Delegated-work mode; cloud coordination with local execution; cloud hook limits; admin controls | ER-APP1-004 | `docs/04` §1, `docs/21` §3, FR-051..060, FR-081, FR-106, FR-124, FR-125; covered in shape; mid-turn switching rule **not covered** |
| 4 | Phone (or second PC) remote control of a desktop host via QR pairing and a relay | ER-APP1-005 | FR-077, FR-111, FR-132, `docs/13` §5, `docs/22` §3; partially |
| 5 | Saved memories, chat-history reference, temporary chats; separate local store | ER-APP1-006 | FR-027, FR-032, FR-169, `docs/09` §5; partially (no separate chat-history reference control). Local store: see app3-findings |
| 6 | Background memory synthesis with an editable summary page | ER-APP1-007 | FR-032, FR-169, `docs/27` §2; **not covered** |
| 7 | Project-only memory scope | ER-APP1-008 | INV-C08, `docs/06` `memory_item.scope_kind`; partially (no FR) |
| 8 | Ambient activity history (macOS): accessibility events, server-side summarization, 48 h raw retention, local Markdown memories | ER-APP1-009, 010 | `docs/24`, FR-151..155; **diverges** |
| 9 | "Window snapshot" hotkey: screenshot plus accessibility text | ER-APP1-011 | FR-075 (P2, Code mode), `docs/11` §6; **diverges** |
| 10 | Quick-chat overlay with per-thread status | ER-APP1-012 | FR-008 (P2), FR-012, `docs/14` §2.3; partially |
| 11 | Full-duplex voice that also steers tasks; dictation | ER-APP1-013 | FR-031, INV-B12; partially |
| 12 | Plugin directory (skills + MCP + optional UI + hooks) | ER-APP1-014 | FR-045, FR-049, FR-165, `docs/08` §3, ADR-013; covered (hooks: see app3-findings) |
| 13 | Plugin UI in a sandboxed iframe over the open MCP Apps bridge; UI extension points | ER-APP1-015 | `docs/08` §3.1, `docs/14` §4.1–4.2, FR-045, FR-117; **diverges** (Nova uses its own bridge) |
| 14 | MCP event triggers via signed webhooks | ER-APP1-016 | FR-056, FR-158, `docs/09` §7; **not covered** |
| 15 | In-app browser, user-browser extension, cloud browser, per-site permissions | ER-APP1-017 | FR-086, FR-092, FR-094, FR-096, `docs/11` §4; covered; permission levels **diverge** |
| 16 | Page-registered site tools | ER-APP1-018 | **not covered** |
| 17 | Computer use on macOS and Windows; record a demonstration to make a skill | ER-APP1-019 | FR-093, FR-170, FR-178, `docs/11` §5, `docs/27` §3; partially |
| 18 | Three-tier confirmation policy for computer use | ER-APP1-020 | FR-058, FR-099, FR-100, `docs/12` §2–4; **diverges** |
| 19 | Scheduled tasks, app-event triggers, goals, team tasks | ER-APP1-021 | FR-055, FR-056, `docs/09` §6–7; covered; goals and service-account tasks **not covered** |
| 20 | Group chats; shared space (pages, files); hosted sites; deep research worker | ER-APP1-022 | FR-029, FR-036, FR-037, FR-041, FR-053; space and sites covered; group chats and visitor-connected apps **not covered** |
| 21 | Models and the "power" control | ER-APP1-023 | FR-023, FR-024, `docs/07` §6, §8; **diverges** |
| 22 | 2026 retirements: remote-browser agent mode, nightly briefing, native checkout, custom bots, side-by-side editor, standalone browser, meeting recording | ER-APP1-024 | context only; touches FR-038, FR-082, FR-087 |
| 23 | Hosted agents API on the same harness; plan sign-in for third-party apps | ER-APP1-025 | INV-D07 (no FR); **not covered** |

---

## A. Desktop client, runtime and packaging

```yaml
id: ER-APP1-001
area: client / modes, platforms, package identity, import
claim: >
  - One desktop app holds three modes: chat, delegated work (multi-step knowledge work) and
    coding. The coding agent's standalone desktop app was merged into it on 2026-07-09. Every
    plan gets it, including the free plan.
  - Platforms: macOS and Windows; a Linux preview (.deb and .rpm) since 2026-08. Web and mobile
    clients offer chat and cloud delegated work.
  - Chat and delegated work share one conversation view. Delegated work run in the cloud syncs
    across devices; delegated work run locally stays on that computer.
  - The previous ("classic") desktop app keeps working with no migration required. Some newer
    agent features exist only in the new app.
  - Windows package (observed): exactly one package from the vendor is installed, version
    26.1007.2314.0. Its package identity is the coding agent's former store package, but its
    display name and entry executable are the unified assistant's. No classic-app package is
    installed. The manifest also declares a command-runner app entry, a custom URL protocol, an
    alias for a browser native-messaging host, and the full-trust, packaged-services and
    local-system-services capabilities.
  - Since 2026-08 the app imports instructions, skills, plugins and projects from APP-2 (its
    coding and delegated-work surfaces) and from a third-party AI code editor. The owner's
    engine folder (under ~) holds an import-history file and a transcript-imports folder for
    APP-2's delegated-work product.
evidence:
  - type: doc
    ref: APP1/doc/whats-new
  - type: doc
    ref: APP1/doc/help-new-desktop-app
  - type: doc
    ref: APP1/doc/help-work-and-coding
  - type: observed
    ref: APP1/obs/installed-packages
  - type: binary
    ref: APP1/bin/desktop-package-manifest
  - type: observed
    ref: APP1/obs/engine-home-listing
  - type: press
    ref: press/cnbc-desktop-super-app
  - type: press
    ref: press/9to5mac-unified-launch
confidence: high
limits: >
  The classic-app statements come from help-center excerpts (medium). Two inferences (low): that
  the coding app's store package was converted in place, and, from folder names, that APP-2
  transcripts are imported too. macOS packaging was not inspected.
```

```yaml
id: ER-APP1-002
area: client / runtime and bundled components
claim: >
  Observed in the Windows package:
  - Chromium 155.0.8059.40 components (browser DLL, elevation service, notification helper). The
    main executable's version info names the coding product and carries the Chromium version.
  - An Electron app bundle (`app.asar`, about 567 MB) and a `default_app` folder. A runtime
    manifest names an internal runtime, not stock Electron, and records the bundle as built
    from the coding app's Electron output.
  - APP-3's engine binary (Rust, about 319 MB), a Windows sandbox service, the command runner, a
    "code mode" host, ripgrep, a LaTeX engine, node-pty and better-sqlite3. Engine behaviour:
    see app3-findings.
  - Nine signed bundled plugins:
    - in-app browser and user-browser bridge;
    - code review, which ships an MCP UI app;
    - thread tools (create, message, fork and hand off threads, update automations), each set
      to prompt for approval;
    - computer use, plus a unified "app-managed browser automation" runtime;
    - deep research;
    - LaTeX;
    - visualizations.
  - Curated skills for onboarding and for creating a custom animated companion.
  - Native modules for remote-control device keys, HID devices (including the vendor's
    documented hardware keypad with per-agent status keys and approve/decline/push-to-talk
    keys), Windows account integration and a Windows updater.
evidence:
  - type: binary
    ref: APP1/bin/desktop-package-listing
  - type: binary
    ref: APP1/bin/runtime-manifest
  - type: binary
    ref: APP1/bin/engine-binaries
  - type: binary
    ref: APP1/bin/bundled-plugins
  - type: binary
    ref: APP1/bin/bundled-mcp-configs
  - type: binary
    ref: APP1/bin/bundled-skills
  - type: binary
    ref: APP1/bin/native-modules
  - type: doc
    ref: APP1/doc/hardware-control-surface
confidence: high
limits: >
  Names, sizes and small manifests only. The asar was not unpacked and nothing was run. Two
  low-confidence notes: the "code mode" host is guessed to run programmatic tool calling; and
  the owner's engine folder has a Screenpipe-named backup of the engine config plus a lock
  file, which suggests Screenpipe edited that config to register its MCP server (inference;
  the config was not opened).
```

```yaml
id: ER-APP1-003
area: client / runtime lineage from the retired standalone browser
claim: >
  The desktop app's internal runtime (ER-APP1-002) is probably the Chromium embedding layer of
  APP-1's retired standalone macOS browser (2025-10-21 to 2026-08-09). That layer worked as
  follows:
  - Chromium's browser process ran out of process as a hidden host. A native client talked to it
    over Mojo IPC and composited its output with CALayerHost.
  - Agent input went straight to the renderer, and popups were composited into the agent's
    screenshot.
  - Synthesized browser shortcuts were blocked.
  - Agent sessions used ephemeral in-memory storage partitions.
evidence:
  - type: binary
    ref: APP1/bin/runtime-manifest
  - type: doc
    ref: APP1/doc/browser-architecture-post
  - type: doc
    ref: APP1/doc/help-browser-retirement
  - type: press
    ref: press/bytebytego-browser-architecture
confidence: low
limits: >
  The lineage is an inference: the runtime manifest uses the same name as the browser's
  documented layer, and the vendor says the browser moved into the desktop app. The browser
  architecture itself is medium (a vendor post seen through search excerpts, agreed by
  press). The browser's client was native Swift while the Windows app ships an Electron bundle;
  how they relate is undocumented.
```

## B. Delegated work, cloud coordination and remote control

```yaml
id: ER-APP1-004
area: delegated work / mode, cloud coordination with local execution, admin
claim: >
  - The delegated-work mode (2026-07-09) does multi-step knowledge work. On desktop it uses
    local files, plugins, local apps and a browser; on web and mobile, a cloud container and a
    cloud browser. Outputs include documents, slide decks, spreadsheets and hosted sites. It
    runs on APP-3's engine harness, as do coding mode, APP-4's agents and the hosted agents API.
  - Cloud delegated work, and APP-4's agents, can use the user's computer. "Coordination"
    (deciding the steps) runs in the vendor's cloud; "execution" (shell and other tools) runs on
    the computer. The computer must be online with the app signed in, at desktop version 26.929
    or later (the observed 26.1007 qualifies).
  - A task cannot switch from local to cloud execution mid-turn. On the next turn it can continue
    in a cloud container, without the local files.
  - Under cloud coordination only remote-MCP hooks apply. Command, prompt, agent, local and
    session-end hooks do not.
  - Admin controls: agent security policies (a global baseline plus local overrides),
    cloud-browser and network toggles, a managed requirements file (for example, turning off
    full DevTools-protocol access in the in-app browser), and compliance and analytics APIs.
evidence:
  - type: doc
    ref: APP1/doc/work-mode-start
  - type: doc
    ref: APP1/doc/cloud-local-access
  - type: doc
    ref: APP1/doc/agents-api-guide
  - type: doc
    ref: APP1/doc/browser
  - type: doc
    ref: APP1/doc/whats-new
  - type: observed
    ref: APP1/obs/installed-packages
confidence: high
limits: >
  The protocol between desktop and the cloud coordinator, cloud-container isolation and policy
  schemas are undocumented. Hook semantics: see app3-findings.
```

```yaml
id: ER-APP1-005
area: multi-device / phone remote control of a desktop host
claim: >
  - Since 2026-05 a phone, or another PC, can pair with a desktop host by QR code and drive it
    remotely.
  - The vendor describes "a secure relay layer" that keeps trusted machines reachable.
  - A chat can be handed off between devices together with its Git state.
  - SSH hosts run a remote copy of the engine's app server.
  - The Windows package ships a native module for remote-control device keys.
evidence:
  - type: doc
    ref: APP1/doc/remote-connections
  - type: binary
    ref: APP1/bin/native-modules
  - type: binary
    ref: APP1/bin/relay-origins
confidence: high
limits: >
  The relay's design, its encryption and whether it is end-to-end are undocumented. Two
  inferences (low): per-device keys, read from the module name; and, from a resource file
  listing one MASQUE proxy origin on a vendor domain, that relay traffic is tunnelled through a
  vendor-run MASQUE proxy. No traffic was captured.
```

## C. Memory

```yaml
id: ER-APP1-006
area: memory / saved memories, chat-history reference, local store
claim: >
  - Saved memories (2024): discrete facts, created by the user or the model, stored apart from
    chats. Deleting a chat does not delete a memory derived from it.
  - Chat-history reference (2025): relevant details from past chats feed into answers. Turning
    it off schedules that remembered information for deletion within 30 days.
  - Controls: a memory toggle; temporary chats that neither use nor create memory; admin
    defaults (off for enterprise and education workspaces).
  - The vendor says the assistant "looks for relevant context when it is likely to improve a
    response". The mechanism is undocumented.
  - Separate store: the coding engine's desktop and CLI clients keep a local memory store (off by
    default); delegated work does not use it. Pipeline: see app3-findings. The owner's engine
    folder holds a memories SQLite file.
evidence:
  - type: doc
    ref: APP1/doc/help-memory-faq
  - type: doc
    ref: APP1/doc/memory-controls-post
  - type: doc
    ref: APP1/doc/memories-local
  - type: observed
    ref: APP1/obs/engine-home-listing
confidence: medium
limits: >
  Cloud-memory content comes from help-center excerpts only. The local-store bullet is high. An
  inference (low): memory reaches the model as a profile summary plus on-demand retrieval over
  chat history. How cloud and local memory interact on desktop is undocumented.
```

```yaml
id: ER-APP1-007
area: memory / background synthesis and summary page
claim: >
  - From 2026-06-04 (US paid plans first), a background process synthesizes and updates
    memories from chat history. It replaces the saved-memory list as "the foundation".
  - Memories change over time. The vendor's example turns a plan ("going to <city> in July")
    into a past event ("went to <city> in July 2026") once the date passes.
  - A memory summary page groups memories by category. Users can correct and dismiss items and
    steer which topics are remembered.
  - The vendor cites internal recall gains and a lower serving cost.
evidence:
  - type: doc
    ref: APP1/doc/memory-synthesis-post
  - type: press
    ref: press/digitalapplied-memory-synthesis
confidence: medium
limits: >
  Vendor post seen through search excerpts. The job's schedule, triggers and model are
  undocumented.
```

```yaml
id: ER-APP1-008
area: memory / project memory scope
claim: >
  - Each project chooses "default" memory (shared with the account) or "project-only" memory
    when it is created.
  - Shared projects are forced to project-only.
evidence:
  - type: press
    ref: press/uniteai-project-memory
confidence: low
limits: A single secondary source; the vendor page was not retrieved.
```

## D. Ambient activity history (macOS)

```yaml
id: ER-APP1-009
area: ambient / capture, processing, retention, use
claim: >
  - macOS only and opt-in. Launched under its current name in 2026-08.
  - Logs interaction events (clicks, typing, shortcuts, app switches) plus the text macOS
    exposes through its accessibility system, for allowed apps and sites.
  - It "does not include screenshots" and does not record audio. Private browsing is excluded.
    Apps and sites can be allow-listed or deny-listed.
  - Raw events stay in the app's shared container for up to 48 hours.
  - An ephemeral engine session summarizes them periodically. The event files are processed on
    vendor servers, which do not retain them.
  - Output: local, unencrypted Markdown memory files in a subfolder of the engine's per-user
    folder (under ~).
  - Use: a day/time timeline. Chats use the history to identify a source, then read that source
    directly. The memories "may be included as context".
  - The vendor warns that turning it on "increases the risk of prompt injection".
evidence:
  - type: doc
    ref: APP1/doc/activity-history
  - type: doc
    ref: APP1/doc/whats-new
confidence: high
limits: >
  Not observed (the inspected machine runs Windows). The event schema, summarization cadence and
  model, and any OCR fallback are undocumented. The no-retention guarantee is the vendor's
  statement.
```

```yaml
id: ER-APP1-010
area: ambient / predecessor preview
claim: >
  - A research preview (2026-04-20, top paid plan only) built the same kind of memories from
    screen captures. Raw captures were reportedly deleted after about 6 hours.
  - The 2026-08 launch renamed the feature, switched to accessibility events and dropped
    screenshots.
evidence:
  - type: doc
    ref: APP1/doc/social-activity-history-preview
  - type: press
    ref: press/neowin-activity-history-preview
  - type: press
    ref: press/tnw-activity-history-preview
confidence: medium
limits: The 6-hour figure comes from press. The reason for dropping screenshots is not stated.
```

## E. Screen context, quick chat and voice

```yaml
id: ER-APP1-011
area: screen context / "window snapshot" hotkey
claim: >
  - Pressing both Command keys (macOS) or both Alt keys (Windows) attaches the frontmost window
    to a chat: a screenshot (needs screen-recording permission) plus the window's accessibility
    text, including text scrolled off screen.
  - The destination is automatic, the current chat or a new chat. Google Workspace web apps give
    a screenshot only.
  - macOS since 2026-05, Windows since 2026-09. Voice on macOS reuses it for screen context.
  - It replaces the classic macOS app's accessibility-based reading of supported coding and text
    apps (which admins could turn off).
evidence:
  - type: doc
    ref: APP1/doc/window-snapshot
  - type: doc
    ref: APP1/doc/voice
  - type: doc
    ref: APP1/doc/help-classic-app-context
confidence: high
limits: >
  Not exercised. Size limits, redaction and retention are undocumented. The classic-app bullet
  comes from help-center excerpts (medium).
```

```yaml
id: ER-APP1-012
area: companion / quick-chat overlay with per-thread status
claim: >
  - A floating overlay with an animated companion (Option+Space on macOS, Win+Alt+P on Windows;
    since 2026-09) offers quick chat by text or voice.
  - A tray lists threads, each with a status: Running, Needs input, Ready or Blocked. An activity
    view gives detail.
  - On macOS, the computer-use picture-in-picture window attaches to the companion.
  - Users can create custom companions; a bundled skill builds one.
evidence:
  - type: doc
    ref: APP1/doc/quick-chat-overlay
  - type: doc
    ref: APP1/doc/computer-use
  - type: binary
    ref: APP1/bin/bundled-skills
confidence: high
limits: The companion format and its states were not collected.
```

```yaml
id: ER-APP1-013
area: voice / full-duplex voice and dictation
claim: >
  - A full-duplex voice model replaced the previous voice mode: launched 2026-07-08, on desktop
    2026-07-20 to 24. Turn-taking is natural, and the model can keep talking while it delegates
    harder work to a larger model or to tasks.
  - From voice, users start, check and steer tasks in chat, delegated work and coding.
  - On macOS, voice can see the screen via a window snapshot. One voice session at a time.
  - Dictation (2026-05) turns speech into prompt text, with cleanup and a custom dictionary.
evidence:
  - type: doc
    ref: APP1/doc/voice
  - type: doc
    ref: APP1/doc/whats-new
  - type: doc
    ref: APP1/doc/api-changelog
  - type: press
    ref: press/techcrunch-voice-models
confidence: high
limits: >
  Latency, interruption handling and which tasks voice may start without confirmation are
  undocumented.
```

## F. Plugins and extension model

```yaml
id: ER-APP1-014
area: plugins / directory and anatomy
claim: >
  - In 2026-07, "apps" (2025, built on MCP) were renamed plugins, with one directory shared by
    chat and coding.
  - A plugin bundles skills, one or more MCP servers, optional UI resources and lifecycle hooks.
    Four shapes: skills only, MCP only, skills plus MCP, MCP plus UI.
  - Hooks run only in the local engine runtime: "installing a plugin on the web doesn't deploy
    those scripts".
  - Remote MCP servers go through directory review; local and desktop-only plugins take a
    separate path. The docs cover auth patterns and monetization.
  - Manifest, marketplace file and hook semantics: see app3-findings.
evidence:
  - type: doc
    ref: APP1/doc/plugins-concept
  - type: doc
    ref: APP1/doc/plugins-index
  - type: doc
    ref: APP1/doc/plugin-conversion-guide
confidence: high
limits: >
  The vendor also documents converting APP-2-format plugins. That guide is cited by the source
  research but is not in its list of pages read in full (medium). Review criteria were not
  collected.
```

```yaml
id: ER-APP1-015
area: plugins / UI in a sandboxed iframe (open standard) and UI extension points
claim: >
  - Plugin UI follows the open MCP Apps standard. A component is an HTML resource
    (`text/html;profile=mcp-app`) at a `ui://` URI. It renders in an iframe beside the
    conversation and talks to the host by JSON-RPC over `postMessage`. Nested frames are blocked
    by default.
  - Tool `_meta` names the resource (`ui.resourceUri`; vendor-prefixed keys are kept as aliases).
    Resource `_meta` sets a domain, a border preference, and CSP lists for connect, resource and
    frame domains.
  - Bridge methods: `ui/initialize`, tool-input and tool-result notifications (with
    `structuredContent`), `tools/call`, `ui/message`, `ui/update-model-context`.
  - A 2025 vendor-specific global object survives as compatibility aliases. Host-only extras:
    - widget state split into model-visible content, private content and image ids;
    - modals;
    - a checkout request;
    - file upload, file selection and download URLs.
    Components should feature-detect.
  - Display modes: inline (card or carousel), fullscreen, picture-in-picture.
  - Since 2026-09-29, tool `_meta` can declare entrypoints:
    - global: a fullscreen sidebar app;
    - thread: a side panel next to a conversation;
    - file: a viewer or editor for listed extensions.
    The same spec adds extended forms, deep links, extended model context, message targeting,
    and settings and onboarding skills. It "extends the MCP and MCP Apps specifications" and
    ships TypeScript and Python SDKs.
evidence:
  - type: doc
    ref: APP1/doc/plugin-ui
  - type: doc
    ref: APP1/doc/plugin-extensions
  - type: doc
    ref: APP1/doc/whats-new-devday
confidence: high
limits: Docs only; no plugin was installed or run.
```

```yaml
id: ER-APP1-016
area: plugins / MCP event triggers
claim: >
  - Requires MCP protocol version 2026-07-28 ("MCP 2.0"); available since 2026-09-29.
  - A server advertises `events/list`. The host calls `events/subscribe` with a webhook URL and a
    secret, refreshes before `refreshBefore`, and calls `events/unsubscribe` to stop.
  - Deliveries are signed per the Standard Webhooks spec and must be under 256 KiB. They are
    processed asynchronously in the chat that subscribed, which follows the user's
    instructions.
  - Webhooks are the only delivery method.
evidence:
  - type: doc
    ref: APP1/doc/mcp-events
  - type: doc
    ref: APP1/doc/whats-new-devday
confidence: high
limits: Docs only. Host-side dedupe and retry behaviour are undocumented.
```

## G. Browsing

```yaml
id: ER-APP1-017
area: browsing / in-app browser, user-browser extension, cloud browser
claim: >
  - In-app browser (since 2026-04): its own profile and history, split view, page annotations
    and agent permissions per site. An optional "developer mode" (since 2026-06) gives the agent
    full DevTools-protocol access with explicit per-site approval, and admins can turn it off.
    The agent cannot automate file uploads.
  - User-browser extension (since 2026-05): the agent controls the user's own signed-in Chrome,
    Edge, Brave, Opera or Vivaldi through a native-messaging host shipped with the app. It adds
    side chat, open-tab mentions and video transcripts. Permission is per host. "Allow for all
    sites" is labelled elevated risk. History access is asked for every time.
  - Cloud browser (delegated work on web and mobile): its own cookies and sessions. Per-site
    permission is Always ask, Auto approve or Always allow. Logins go through a secure sign-in
    form.
  - These three replace the retired standalone browser for agentic browsing (ER-APP1-024).
evidence:
  - type: doc
    ref: APP1/doc/browser
  - type: doc
    ref: APP1/doc/browser-extension
  - type: doc
    ref: APP1/doc/whats-new
  - type: binary
    ref: APP1/bin/desktop-package-manifest
confidence: high
limits: >
  Not exercised. Cloud-browser isolation, session persistence and egress policy are
  undocumented.
```

```yaml
id: ER-APP1-018
area: browsing / page-registered site tools
claim: >
  - Since 2026-08, a page in the in-app browser can register tools for the agent with
    `document.modelContext.registerTool({name, description, inputSchema, annotations, execute})`,
    following the WebMCP proposal.
  - Only the top-level frame may register tools.
  - Every call is safety-reviewed, and results are treated as untrusted.
evidence:
  - type: doc
    ref: APP1/doc/site-tools
  - type: doc
    ref: APP1/doc/whats-new
confidence: high
limits: The review criteria are undocumented.
```

## H. Computer use

```yaml
id: ER-APP1-019
area: computer use / platforms and record-and-replay
claim: >
  Computer use is available to delegated work and coding (macOS since 2026-04, Windows since
  2026-05).
  - macOS: Accessibility and Screen Recording permissions; can work in the background; a "locked
    use" option relies on an OS authorization plug-in.
  - Windows: SendInput and UI Automation for input, Windows.Graphics.Capture for screenshots. The
    bundled skill says capture works on covered windows; the docs say Windows use is
    foreground only.
  - Each app can be given "Always allow".
  - Windows runtime (observed): a bundled Node 24 build, driven from a REPL-style MCP server.
  - Record and replay (since 2026-06): the user demonstrates a workflow and it becomes a reusable
    skill. macOS only, needs computer use, and is not available in the EEA, the UK or
    Switzerland.
evidence:
  - type: doc
    ref: APP1/doc/computer-use
  - type: doc
    ref: APP1/doc/whats-new
  - type: binary
    ref: APP1/bin/computer-use-skill
  - type: binary
    ref: APP1/bin/computer-use-runtime
confidence: high
limits: >
  Not exercised. That "locked use" means working while the screen is locked is an inference
  (low). The Windows background vs foreground statements were not reconciled. The recording
  format is undocumented.
```

```yaml
id: ER-APP1-020
area: computer use / confirmation tiers
claim: >
  The bundled computer-use policy (Windows package) sorts actions into three tiers:
  - Hand-off required (the user must act): for example the last step of a password change, or
    getting past an HTTPS warning page or a paywall.
  - Always confirm at action time: deletions; creating permissions or accounts; API or OAuth
    keys; CAPTCHAs; installing software or extensions; messages and posts to third parties.
  - Pre-approvable: everything else.
  Instructions the user typed count as valid intent. Pasted or third-party content "never"
  counts as permission by itself.
evidence:
  - type: binary
    ref: APP1/bin/computer-use-confirmations
confidence: high
limits: >
  Policy text shipped with the app, not seen in operation. The macOS policy may differ.
  Engine-level approvals: see app3-findings. The retired agent mode's watch mode and takeover
  are in ER-APP1-024.
```

## I. Scheduling, collaboration and outputs

```yaml
id: ER-APP1-021
area: automation / scheduled tasks, app-event triggers, goals
claim: >
  - Scheduled tasks have their own page and a per-plan cap (reported as 3, 5, 10 and 15).
  - Since 2026-08 a task can also start on an app event: Gmail, Slack or GitHub.
  - Team tasks run on a service account, not a person's account.
  - A "goal" mode pursues long-running objectives. The owner's engine folder holds a goals
    SQLite file.
  - MCP event triggers (ER-APP1-016) also push work into chats.
evidence:
  - type: doc
    ref: APP1/doc/help-scheduled-tasks
  - type: doc
    ref: APP1/doc/whats-new
  - type: observed
    ref: APP1/obs/engine-home-listing
confidence: medium
limits: >
  Caps and team tasks come from a help-center excerpt. App-event triggers and goal mode are
  vendor changelog entries read in full. Trigger filters and dedupe are undocumented.
```

```yaml
id: ER-APP1-022
area: collaboration and outputs / group chats, space, sites, deep research
claim: >
  - Group chats (since 2025-11): up to 20 people share one chat with the assistant. Personal
    memory is not shared into them.
  - Space (since 2026-09/10): pages co-edited with the agent, slides, spreadsheets, sites and
    files, with sharing. Where enabled it replaces the older file library.
  - Hosted sites (since 2026-06): the assistant builds, deploys and hosts websites and web apps.
    Workspace-private sites can use each visitor's own connected apps.
  - Deep research on desktop is a bundled plugin that "delegates the investigation to a
    dedicated research worker" and outputs a DOCX report.
evidence:
  - type: press
    ref: press/techcrunch-group-chats
  - type: doc
    ref: APP1/doc/space
  - type: doc
    ref: APP1/doc/whats-new
  - type: doc
    ref: APP1/doc/whats-new-devday
  - type: binary
    ref: APP1/bin/deep-research-plugin
confidence: medium
limits: >
  Group chats rest on press. Space, sites and deep research are high. A third-party
  encyclopedia says deep research can use MCP and plugin sources and a live-interruptible
  viewer (third-party/wikipedia-deep-research; low). Not collected: group-chat roles, versioning
  in the space, site hosting limits.
```

## J. Models and the "power" control

```yaml
id: ER-APP1-023
area: models / "power" control
claim: >
  - The model picker is a "power" control with six presets, from Faster to Smarter.
  - An advanced panel sets model, reasoning effort and speed:
    - effort runs from Light to Max, and the top tier uses subagents;
    - speed has Fast, plus a faster tier on the top plan.
  - In 2026-07 the default preset was a mid-tier model at medium effort.
  - The current docs describe no automatic router behind the presets.
  - Model generations shipped and were retired throughout 2026, each leaving on an announced
    date.
evidence:
  - type: doc
    ref: APP1/doc/models
  - type: doc
    ref: APP1/doc/model-selection
  - type: doc
    ref: APP1/doc/whats-new
  - type: doc
    ref: APP1/doc/router-launch-post
confidence: high
limits: >
  APP-1's 2025 flagship release had a real-time router choosing a fast or reasoning model by
  conversation type, complexity, tool needs and explicit intent, also used for acutely
  sensitive conversations (search excerpt, medium). Whether a router still runs behind the 2026
  presets is unknown.
```

## K. 2026 retirements

```yaml
id: ER-APP1-024
area: retired / features removed or replaced in 2026
claim: >
  - Remote-browser agent mode, retired 2026-07/08. It descended from a 2025-01 remote-browser
    agent and ran a remote virtual computer (visual browser, text browser, terminal,
    connectors). The help center points to the delegated-work mode. Its safety design:
    - confirmations before consequential actions;
    - "watch mode" on sensitive sites (email, banking), which paused when the user went
      inactive;
    - takeover for logins, with no screenshots taken.
  - Nightly briefing, sunset around 2026-06-17: asynchronous research over chats, memory and
    optional mail/calendar, delivered as morning cards. Users were pointed to scheduled tasks.
  - Native checkout, scaled back in 2026-03 for merchant-side checkout. The merchant checkout
    protocol (checkout-session endpoints, delegated one-time payment token) and the plugin
    bridge's checkout request remain.
  - Custom bots (instructions, knowledge, OpenAPI actions): creation ended 2026-09-25; they retire
    2026-12-11. Migration is to plugins, and OpenAPI actions do not carry over.
  - Side-by-side document/code editor, removed from newer models on 2026-05-28 in favour of
    inline blocks.
  - Standalone macOS AI browser, shut down 2026-08-09. Its server-side browser memories (page
    summaries deleted within 7 days) have no documented migration. Press reported a
    memory-planting CSRF, which the vendor could not reproduce.
  - Meeting recording (microphone plus system audio) from the classic macOS app is reportedly
    missing in the new app; the classic app is still supported.
evidence:
  - type: doc
    ref: APP1/doc/help-agent-mode
  - type: doc
    ref: APP1/doc/agent-mode-launch-post
  - type: doc
    ref: APP1/doc/agent-watch-mode
  - type: doc
    ref: APP1/doc/social-briefing-sunset
  - type: press
    ref: press/cnbc-agentic-shopping
  - type: doc
    ref: APP1/doc/commerce-concepts
  - type: doc
    ref: APP1/doc/help-custom-bot-retirement
  - type: doc
    ref: APP1/doc/help-model-release-notes
  - type: doc
    ref: APP1/doc/help-browser-retirement
  - type: doc
    ref: APP1/doc/help-browser-privacy
  - type: press
    ref: press/theregister-browser-memory-injection
  - type: press
    ref: third-party/issue-tracker-record-mode-regression
confidence: medium
limits: >
  Most vendor statements are help-center or social excerpts. The watch-mode page and the
  commerce docs were read in full. The checkout status rests on press. Meeting recording rests
  on one user report (low).
```

## L. Third-party building blocks

```yaml
id: ER-APP1-025
area: platform / hosted agents API and plan sign-in
claim: >
  - A hosted agents API (beta 2026-09-10) runs APP-3's engine harness and "manages the
    underlying agent infrastructure": durable sessions, compaction, multi-agent, programmatic
    tool calling and MCP. The sandbox can be vendor-hosted, self-hosted, or none. Computer use in
    a vendor-hosted browser came on 2026-09-29.
  - Related: the visual agent builder is deprecated (shutdown 2026-11-30); the older assistants
    API shut down on 2026-08-26.
  - Plan sign-in (announced 2026-09-29, limited trial): users sign in to a third-party app with
    their APP-1 account and use their own plan there.
evidence:
  - type: doc
    ref: APP1/doc/agents-api-guide
  - type: doc
    ref: APP1/doc/api-changelog
  - type: doc
    ref: APP1/doc/whats-new-devday
confidence: high
limits: >
  Pricing, limits, and the plan sign-in auth flow, scopes and billing split are not described in
  the sources read.
```

---

## Divergences from the current spec (inputs for RECONCILIATION.md, not decisions)

| Nova doc today | Finding | Evidence |
| --- | --- | --- |
| `docs/24` §3: screen frames, then OCR, are the text source | APP-1's ambient history captures no screenshots: interaction events plus accessibility text only. Its preview used screenshots and dropped them at launch | ER-APP1-009, 010 |
| `docs/24` §2, §7: local-first; cloud processing only if enabled per source | Summarization always runs on vendor servers (files not retained); the derived memories are stored locally | ER-APP1-009 |
| `docs/24` §2, §4: encrypted at rest; 30-day default retention | Raw events are kept 48 h; the derived Markdown memories are unencrypted and kept until deleted | ER-APP1-009 |
| `docs/24` §5: `ambient.*` query tools | The history is used to find a source, then the agent reads that source itself; distilled memories may enter context; the vendor warns of added injection risk | ER-APP1-009 |
| `docs/03` FR-075 (P2, Code mode): capture a window as a debugging artifact | A global double-modifier hotkey in any mode attaches a screenshot plus accessibility text, including off-screen text; voice reuses it | ER-APP1-011, 013 |
| `docs/09` §5, FR-032: per-turn extraction into a reviewable fact list | A background process rewrites memories over time (time-aware updates), shown on a category summary page with topic steering. Chat-history reference is a separate toggle with a 30-day deletion window | ER-APP1-006, 007 |
| `docs/03` FR-034, INV-C08: project instructions; memory scope only in the data model | "Project-only" memory chosen per project at creation, forced for shared projects | ER-APP1-008 |
| `docs/08` §3.1, `docs/14` §4: plugin panels over a Nova-specific typed bridge | Plugin UI is the open MCP Apps standard: inline `ui://` HTML bound to tool results, CSP domain lists, model-visible vs private widget state, inline/fullscreen/PiP modes, and global/thread/file entrypoints | ER-APP1-015 |
| `docs/09` §7, FR-056: webhook, Slack, email, file-change and polling connector triggers | MCP servers push events through subscribe, refresh and unsubscribe, with signed webhooks under 256 KiB | ER-APP1-016 |
| `docs/11` §4: the browser controller reads the DOM and accessibility tree | Pages can register their own tools for the agent (top frame only, every call reviewed, results untrusted) | ER-APP1-018 |
| `docs/11` §4.3, FR-094: Allow once / Always / Deny per site; per-tab extension consent | Cloud browser: Always ask / Auto approve / Always allow per site. Extension: grants per host, "all sites" flagged elevated risk, history access asked every time. Full DevTools-protocol access is a separate per-site mode | ER-APP1-017 |
| `docs/11` §5, `docs/12` §2–4: dangerous targets denied and handed off; one approval card | Three tiers (hand off, confirm at action time, pre-approvable). Typed instructions count as intent; pasted content never does. Per-app always-allow; a macOS locked-screen option | ER-APP1-019, 020 |
| `docs/03` FR-031: realtime voice with push-to-talk, hands-free and barge-in | Voice is also a controller: it starts, checks and steers tasks across modes while delegating to a larger model; one session at a time | ER-APP1-013 |
| `docs/14` §2.3, FR-008 (P2), FR-012: tray quick chat; one companion with global states | A floating overlay lists every thread as Running / Needs input / Ready / Blocked; the computer-use PiP attaches to it | ER-APP1-012 |
| `docs/13` §5, FR-077, FR-111: the phone starts tasks and answers approvals; full editing on desktop | A phone or second PC fully remote-controls a desktop host and can hand off a chat with its Git state | ER-APP1-005 |
| `docs/21` §3: the Hub coordinates, devices execute | Same split, with the coordinator in the vendor cloud. Rules: no switch from local to cloud mid-turn; the cloud can continue without local files; local-only hooks do not run under cloud coordination | ER-APP1-004 |
| `docs/07` §6, §8, FR-023, FR-024: model picker, reasoning selector, virtual models | One "power" preset hides model, effort and speed; the top effort tier spawns subagents; no router is documented | ER-APP1-023 |
| `docs/27` §3, FR-170, FR-178: skills proposed from repeated workflows | Skills can also be generated from a recorded demonstration | ER-APP1-019 |
| `docs/09` §6, FR-055: per-user schedules | Plan caps on tasks; team tasks on a service account; a long-running "goal" mode | ER-APP1-021 |
| not covered | Group chats for up to 20 people, with personal memory kept out | ER-APP1-022 |
| `docs/03` FR-037: publish sites to a chosen target | Vendor-hosted sites; workspace-private sites use each visitor's own connected apps | ER-APP1-022 |
| `docs/02` INV-D07 (no FR) | Plan sign-in for third-party apps (limited trial), plus a hosted agents API on the same harness | ER-APP1-025 |
| `docs/02` INV-B15, FR-032: import memory from an export | Import of instructions, skills, plugins and projects (and, it appears, transcripts) from other assistants | ER-APP1-001 |
| `docs/09` §8 (proactive research), FR-038 (artifacts pane) | In 2026 APP-1 retired its nightly briefing in favour of user-scheduled tasks, and its side-by-side editor in favour of inline blocks | ER-APP1-024 |
