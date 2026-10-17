# External findings: APP-2 (desktop assistant with a VM-sandboxed agent mode)

Input for the Phase 0 reconciliation (`PROMPT.md` §2). These are **findings, not decisions**.
APP-2 is an opaque ID; its identity lives only in the private evidence ledger
(`docs/19` §1.3). Any requirement derived from this file must be rewritten in vendor-neutral
language (`docs/01` §5, the brand-name invariant). Product-named files, folders and binaries
are written with placeholders such as `<App>`, `<app-dir>`, `<cli>` and `<agent-home>`.

## Provenance

| | |
| --- | --- |
| Target | APP-2: a desktop assistant for Windows, macOS and Linux (beta) with chat, a VM-sandboxed agent mode and a coding tab |
| Version | 2.42304.0, x64 MSIX, released 2026-10-15. It bundles the CLI coding agent 2.1.299 and the agent SDK 0.3.299. Shell runtime: Electron 44.7.2 (Chromium 152, Node 24.21.0). |
| Method | Vendor docs and changelogs, plus lawful static inspection of the package installed on the owner's Windows 11 machine (build 26200), done from WSL2. Inspected: the app archive listing, the package manifest, the MSIX manifest, strings in two native binaries, local config and state files, and logs. No conversation content was read. Credential-bearing files were listed but not opened. Nothing was decompiled and no traffic was intercepted. Third-party analyses are used where noted. |
| Evidence refs | Opaque refs. `APP2/doc/…` = vendor docs. `APP2/bin/…` = app bundle, archive, strings or package-manifest inspection. `APP2/obs/…` = things seen on the owner's machine (logs, config keys, folder layout). `third-party/…` = third-party analysis or press. `third-party/mcp-*` refs are the open protocol's own published docs and are typed `doc`. The real URL or path for each ref is in the private ref map `docs/external/private/app2-refs.md` (gitignored). |
| Date | Research 2026-10-16. Converted to this file 2026-10-17. Strings in the VM service and native addon and the archive listing were spot-checked again during conversion. |

### Clean-room only

APP-2 is proprietary. Under `docs/19` §1, no code, assets, dialog text or doc text may be
taken from it. Everything below describes behaviour and mechanisms in our own words. Config
key names appear only as evidence that can be checked. They are not names to reuse.

### Privacy

Usernames, home-folder paths, device, account, org, session and environment IDs, emails,
keys and tokens have been removed. Paths use `%APPDATA%`, `%LOCALAPPDATA%` or `~`. The MSIX
package family suffix (`pzs8sxrjxfjjc`) is kept.

### Confidence

- **high**: the vendor documents it, it was seen directly on the owner's machine (file, log
  line, manifest, binary strings), or both.
- **medium**: there is one indirect signal, or a third-party claim that matches local
  evidence, or vendor docs that local evidence partly contradicts.
- **low**: an inference, a third-party claim with no local support, or a point where the
  docs and the observations disagree. Every inference says so in `limits`.

## Capability summary

| # | Capability | Evidence records | rea coverage |
| --- | --- | --- | --- |
| 1 | Chromium-framework shell that loads the hosted web app; window and worker inventory | ER-APP2-001..002 | `docs/05` §2 (Electron shell, ADR-001), FR-125; covered |
| 2 | Native helper addon (input, audio, OS APIs) and bundled helpers/content | ER-APP2-003..004 | `docs/23` §4 puts screen/input in a `novad` module; partially, **diverges** on placement |
| 3 | Telemetry and feature flags | ER-APP2-005 | FR-105, FR-118, ADR-019, ADR-028; partially |
| 4 | Windows MSIX with a packaged LocalSystem VM service; per-OS distribution | ER-APP2-006..007 | `docs/15` §1 lists NSIS/MSI/portable only; **not covered** |
| 5 | Update behaviour | ER-APP2-008 | `docs/15` §4, FR-120; partially |
| 6 | Process topology | ER-APP2-009 | `docs/05` §3, §9; partially |
| 7 | Unified chat + agent mode | ER-APP2-010 | FR-002 (separate modes); **diverges** |
| 8 | Agent mode: local vs cloud, where the loop runs, cloud sandbox | ER-APP2-011..013 | `docs/11` §2.1, FR-080, FR-108; partially |
| 9 | Device bridge (desktop app as a tool endpoint for cloud sessions) | ER-APP2-014 | `docs/21` §8, `docs/23`, FR-081, FR-126, FR-141; **diverges** |
| 10 | Local VM sandbox: hypervisor per OS, direct kernel boot, disk images, VM service | ER-APP2-015..017 | `docs/11` §2.2 ("optional VM"), FR-107; **diverges** |
| 11 | VM file shares and blocked credential paths | ER-APP2-018 | `docs/11` §2.2, §9; partially |
| 12 | VM networking: user-mode stack, auth-injecting MITM proxy, domain allowlist | ER-APP2-019, 021 | `docs/11` §3, §7; `docs/12` §5, §8; FR-102; partially, **diverges** on auth injection |
| 13 | VM isolation claims and failure behaviour | ER-APP2-020 | `docs/11` §10; covered |
| 14 | Coding tab drives a per-version, hash-verified CLI coding agent | ER-APP2-022 | `docs/09` §1, `docs/10` §1; **diverges** |
| 15 | Code environments (local, WSL, SSH, cloud, remote machine) | ER-APP2-023..024 | FR-062, FR-078, `docs/10` §2; partially |
| 16 | Worktrees, Git hooks, CLI handoff | ER-APP2-025..027 | FR-073, `docs/10` §8–9; partially |
| 17 | Remote control by outbound polling | ER-APP2-028 | `docs/22` §3, FR-137; **diverges** |
| 18 | Phone-to-desktop persistent thread that spawns child sessions | ER-APP2-029 | FR-054, FR-077, FR-111; partially |
| 19 | Scheduled tasks and local routines with 7-day catch-up | ER-APP2-030 | FR-055, `docs/09` §6, §12; **diverges** |
| 20 | Computer use: app tiers, overlays, flags | ER-APP2-031..032 | FR-093, FR-098, `docs/11` §5; partially, tiers **not covered** |
| 21 | Teach and record-a-skill | ER-APP2-033 | FR-170, FR-178; **not covered** (no demonstration capture) |
| 22 | Built-in browser pane | ER-APP2-034 | FR-067, FR-096, `docs/10` §7; covered |
| 23 | Browser-extension bridge (native messaging + relay) | ER-APP2-035 | FR-096, `docs/11` §4.3; partially, **diverges** |
| 24 | Hotkey capture window and dictation | ER-APP2-036 | FR-008 (P2); partially |
| 25 | Voice | ER-APP2-037 | FR-031; partially |
| 26 | Memory and projects | ER-APP2-038..039 | FR-032, FR-034, FR-089, `docs/09` §5; covered |
| 27 | Artifacts, design, slides, docs | ER-APP2-040 | FR-036, FR-038, FR-076; partially |
| 28 | MCP stdio config, handshake, MCP UI extension | ER-APP2-041..042 | FR-042, `docs/08` §2; partially, UI extension **not covered** |
| 29 | MCP extension bundles and their governance | ER-APP2-043..044 | `docs/08` §3, FR-045, FR-167, FR-168; **not covered**, unsigned installs **diverge** |
| 30 | Remote connectors, built-in MCP servers, per-tool toggles | ER-APP2-045..047 | FR-042, FR-047, FR-048, `docs/08` §1.1; covered / partially |
| 31 | Skills and plugins: account sync every 20 min, Git marketplaces | ER-APP2-048..049 | FR-045, FR-046, FR-049, `docs/13` §2.1; partially |
| 32 | Enterprise policy keys | ER-APP2-050 | FR-106, `docs/12` §10; **diverges** |
| 33 | Data and storage layout | ER-APP2-051..055 | `docs/15` §5, `docs/06`; partially |
| 34 | Security model: permission modes, credentials, app isolation, supply chain | ER-APP2-056..059 | FR-063, FR-101, FR-107, FR-120, FR-133; partially, app isolation **diverges** |
| 35 | Owner machine: the MSIX AppData split breaks MCP config and the local VM | ER-APP2-060..062 | `docs/15` §1, §5; **not covered** |

---

## A. Shell, runtime and packaging (`docs/05`, `docs/15`)

```yaml
id: ER-APP2-001
area: shell / runtime
claim: >
  - The app is built on Electron 44.7.2 (Chromium 152, main-process Node 24.21.0), packaged
    with Electron Forge 8 (alpha) and Vite. The UI is React.
  - The main window loads the vendor's hosted web app inside an `app://` shell. The desktop
    adds native capabilities around that web app; it does not reimplement the UI.
  - Main-process code ships as a V8 bytecode cache, not plain JavaScript.
  - A full copy of the hosted web app, including voice worklets and i18n, is bundled in the
    app's resources folder.
  - Package makers: dmg, pkg, Squirrel, MSIX, deb, zip and an RPM maker. Publishers: a
    cloud-storage bucket and a static host. Electron fuses are used.
evidence:
  - type: binary
    ref: APP2/bin/app-version-file
  - type: binary
    ref: APP2/bin/package-manifest
  - type: binary
    ref: APP2/bin/install-dir-listing
  - type: observed
    ref: APP2/obs/main-log
  - type: doc
    ref: APP2/doc/desktop-changelog (runtime moved to Electron 44 / Chromium 152 on 2026-09-08)
confidence: high
limits: >
  Renderer code was not read. Why the web-app copy is bundled is unknown. The guess that it
  serves third-party-inference or offline deployments is an inference (low).
```

```yaml
id: ER-APP2-002
area: shell / windows and workers
claim: >
  The app archive has 548 entries. It contains the following.
  - Windows: main, a hotkey capture window, about, an unidentified auxiliary window,
    find-in-page, and a local-execution consent dialog.
  - Preloads: design window, agent-mode artifact, computer-use teach, computer-use
    watch-and-record, a recording-target chooser, and page preview.
  - Workers: MCP runtime (a direct host and a Node host), PTY host, file index, transcript
    search, heavy work, shell PATH resolution, a Microsoft account broker, and a stall
    sampler.
evidence:
  - type: binary
    ref: APP2/bin/asar-listing
confidence: high
limits: Names only. What each window or worker does was not traced.
```

```yaml
id: ER-APP2-003
area: shell / native addon
claim: >
  One native addon, written in Rust with napi 2.16, carries the OS-level capabilities.
  - Input synthesis: enigo 0.6.1, used for computer use.
  - Audio capture: cpal 0.15.3 using WASAPI.
  - Image codecs: image, png, jpeg. Compression: zstd. Async runtime: tokio.
  - Windows APIs (windows 0.58): keyboard and mouse, window messaging, registry, the
    Windows Hello user-consent verifier, and the package manager.
  It loads into the app process. It is not a separate privileged helper.
evidence:
  - type: binary
    ref: APP2/bin/native-addon-strings
confidence: high
limits: >
  Crate list only. What uses Windows Hello (for example, gating sensitive actions) is not
  known.
```

```yaml
id: ER-APP2-004
area: shell / bundled helpers and content
claim: >
  The app ships these helpers next to the main binary.
  - A GitHub MCP server binary, used by the built-in GitHub connector.
  - A Microsoft 365 MCP server (stdio, JavaScript) plus the Windows account-broker runtime.
  - The VM service (Go, 14 MB) and a browser native-messaging host executable.
  - Three SSH helper executables: askpass, broker and proxy.
  - A `$BROWSER` shim, a shell/JS polyglot that sends URLs to the coding session's
    browser pane over a Unix socket.
  - A 38 MB tools disk image that is attached to the VM.
  Bundled content:
  - Artifact libraries: chart.js 4.5.0, gridjs 5.0.2, mermaid 11.17.2.
  - Built-in skills: docx, pdf, pdf-reading, pptx, xlsx, frontend-design.
evidence:
  - type: binary
    ref: APP2/bin/install-dir-listing
  - type: binary
    ref: APP2/bin/bundled-skills-manifest
  - type: doc
    ref: APP2/doc/desktop-changelog
confidence: high
limits: Helper protocols were not traced, apart from the shim's socket target.
```

```yaml
id: ER-APP2-005
area: shell / telemetry and flags
claim: >
  - Crash and error reporting: Sentry (a `sentry/` folder in the user-data folder).
  - Remote feature flags: GrowthBook, with per-account local caches.
  - An internal event-logging channel.
  - Admin-configurable OpenTelemetry (OTLP) export for enterprises.
evidence:
  - type: binary
    ref: APP2/bin/package-manifest
  - type: observed
    ref: APP2/obs/chromium-userdata
  - type: observed
    ref: APP2/obs/feature-flag-cache
  - type: doc
    ref: APP2/doc/desktop-changelog
confidence: high
limits: Whether telemetry is on by default, and what it contains, was not determined.
```

```yaml
id: ER-APP2-006
area: packaging / Windows MSIX
claim: >
  - On Windows, the app ships as an MSIX signed with a developer (sideload) signature, not a
    Store signature. The package family suffix is `pzs8sxrjxfjjc`.
  - Declared capabilities: runFullTrust, localSystemServices, packagedServices,
    unvirtualizedResources, internetClient.
  - Entry points: a startup task (`--startup`), a custom URL-scheme handler, an app
    execution alias, firewall rules for the main exe and the VM service, and separate app
    entries for SSH askpass and SSH proxy.
  - A packaged service runs the VM service as LocalSystem, starts automatically, and is
    trigger-started by a named pipe. On the owner's machine it was Running, Automatic and
    LocalSystem.
  - Virtualization exclusions:
    - Registry: native-messaging host keys for nine Chromium-family browsers (Chrome,
      Brave, Edge, Chromium, Arc, Vivaldi, Opera, Island, Prisma), two Chrome
      external-extension IDs, and the Office trusted-catalogs key.
    - Filesystem: three `%LOCALAPPDATA%` folders (a third-party-deployment data folder, a
      data folder and the logs folder).
evidence:
  - type: binary
    ref: APP2/bin/appx-manifest
  - type: observed
    ref: APP2/obs/appx-package-query
  - type: observed
    ref: APP2/obs/service-status
confidence: high
limits: x64 package only. The arm64 package was not inspected.
```

```yaml
id: ER-APP2-007
area: packaging / per-OS distribution
claim: >
  Windows:
  - Separate x64 and arm64 MSIX packages. Individuals install through a small bootstrapper.
  - The local agent-mode VM needs an admin (all-users) install, or install fails with error
    0x80073D28. It also needs the Virtual Machine Platform feature and the host compute and
    host network services.
  macOS: universal build, macOS 13 or later. Computer use needs macOS 14 or later.
  Linux (beta since 2026-06-30):
  - A .deb from the vendor's apt repo, for Ubuntu 22.04+ and Debian 12+, x64 and arm64.
  - Managed settings live at `/etc/<app>/managed-settings.json`.
  - Computer use, dictation and voice are not yet available.
  - The capture hotkey works on X11. On Wayland it needs the XDG GlobalShortcuts portal.
evidence:
  - type: doc
    ref: APP2/doc/deploy-windows
  - type: doc
    ref: APP2/doc/download
  - type: doc
    ref: APP2/doc/desktop-linux
  - type: doc
    ref: APP2/doc/desktop-changelog
confidence: high
limits: Only the Windows x64 build was installed. macOS and Linux facts are from docs only.
```

```yaml
id: ER-APP2-008
area: packaging / updates
claim: >
  - The Windows deployment doc says the app updates roughly every 4 hours.
  - The update URL in the logs is the vendor's API host. Config stores the last version the
    updater saw.
  - A log line from the coding-tab component says its auto-update is disabled because this
    is an MSIX install.
  - Separately, the app downloads CLI-agent versions itself (ER-APP2-022). Engine versions
    therefore move independently of app releases.
evidence:
  - type: doc
    ref: APP2/doc/deploy-windows
  - type: observed
    ref: APP2/obs/main-log
  - type: observed
    ref: APP2/obs/config-json
confidence: medium
limits: >
  Channels, staged rollout, rollback and the consent UX were not observed. What exactly the
  "disabled for MSIX" line turns off, and how MSIX app updates are delivered, is inference
  (low).
```

```yaml
id: ER-APP2-009
area: shell / process topology (Windows)
claim: >
  The main process groups its children in a Windows Job object. Children:
  - The MCP runtime launches stdio servers through `cmd.exe /c …` and runs extension bundles
    on the app's built-in Node runtime.
  - A PTY host, plus one CLI-agent process per coding session, driven through the agent SDK.
  - WSL sessions use a "remote spawn" path into a named distro. SSH sessions go through
    helpers to a remote helper on the host.
  - The native-messaging host talks to the browser extension and to a vendor WebSocket
    relay.
  - A device-bridge WebSocket to a vendor relay (ER-APP2-014).
  - A remote-control / sessions bridge to the vendor API (ER-APP2-028).
  - A named pipe to the LocalSystem VM service. That service drives the Windows Host Compute
    Service, which runs the VM from a kernel, initrd and three disks. Inside the VM, Plan9
    shares over HVSocket and a user-mode network stack serve the agent under
    `/sessions/<name>/mnt/…`.
evidence:
  - type: observed
    ref: APP2/obs/main-log
  - type: observed
    ref: APP2/obs/vm-node-log
  - type: observed
    ref: APP2/obs/ssh-logs
  - type: observed
    ref: APP2/obs/chrome-native-host-log
  - type: binary
    ref: APP2/bin/vm-service-strings
confidence: medium
limits: Assembled from log lines and strings. Parent/child links were not captured with a process tool.
```

## B. Modes and agent-mode architecture (`docs/09`, `docs/11`, `docs/21`)

```yaml
id: ER-APP2-010
area: modes / unified chat + agent
claim: >
  - Since 2026-09-16, chat and agent mode have been merging into one "unified" mode. The
    model decides whether a request needs a quick answer or a longer agentic task. There
    is no up-front mode switch.
  - Deployments that use third-party inference get a config key that picks the desktop home
    view. The vendor says this becomes mandatory for those deployments on 2026-11-10.
  - The coding tab stays a separate surface.
evidence:
  - type: doc
    ref: APP2/doc/release-notes
  - type: doc
    ref: APP2/doc/unified-mode-3p
  - type: doc
    ref: APP2/doc/unified-mode-support
  - type: doc
    ref: APP2/doc/desktop-changelog
confidence: high
limits: How the routing decision is made was not observed.
```

```yaml
id: ER-APP2-011
area: agent mode / local: what runs where
claim: >
  - The vendor's current architecture doc says that in local agent mode only shell and code
    execution run in the VM. The agent loop, connected-folder access, web fetch and local
    plugin MCP servers run on the host.
  - Owner-machine logs from March 2026 show the opposite for that time. The CLI-agent binary
    was started inside the VM with stream-JSON input and output, permission prompts over
    stdio, and an explicit allowed-tools list. That list included the browser-extension,
    computer-use and phone-thread tools.
  - Session records carry a host-loop flag, which is false on older sessions.
evidence:
  - type: doc
    ref: APP2/doc/agent-mode-architecture
  - type: observed
    ref: APP2/obs/vm-node-log
  - type: observed
    ref: APP2/obs/agent-session-records
confidence: medium
limits: >
  The current default was not verified. Reading the flag as a migration from an in-VM loop
  to a host loop is inference (low).
```

```yaml
id: ER-APP2-012
area: agent mode / cloud
claim: >
  - Since 2026-07-07 (beta), agent-mode sessions run by default in a per-session sandbox on
    the vendor's servers.
  - Local files, the browser and computer use are reached through the desktop app while it
    is open (ER-APP2-014).
  - Scheduled tasks run with no device online.
  - The support doc says local sessions created before 2026-10-06 stay tied to the app.
evidence:
  - type: doc
    ref: APP2/doc/release-notes
  - type: doc
    ref: APP2/doc/agent-mode-get-started
  - type: doc
    ref: APP2/doc/agent-mode-architecture
confidence: high
limits: >
  A third-party blog says agent mode has been cloud-only since 2026-10-06. That claim is not
  confirmed (low).
```

```yaml
id: ER-APP2-013
area: agent mode / cloud sandbox security
claim: >
  - The cloud sandbox is ephemeral. All egress goes through a mandatory proxy, and private
    and cloud-metadata IP ranges are blocked.
  - Session tokens expire within hours.
  - Connector calls from cloud sessions are made server-side, so connector tokens never
    enter the sandbox.
evidence:
  - type: doc
    ref: APP2/doc/agent-mode-architecture
  - type: doc
    ref: APP2/doc/coding-tab
confidence: high
limits: Vendor statement only. Not testable from the desktop.
```

```yaml
id: ER-APP2-014
area: agent mode / device bridge
claim: >
  - While it is open, the desktop app holds an outbound WebSocket to a vendor-hosted relay.
    The connection is addressed by account, org and device. The device name is
    user-settable.
  - Over that link it serves these tools to cloud sessions:
    - get_device_info, device_list_dir, device_request_folder_access, device_bash
    - device_stage_files, device_commit_files
    - list_artifacts, create_artifact, update_artifact
    - project_memory_read, project_memory_write
  - Local stdio MCP servers are offered to the cloud session through a local-MCP bridge. On
    the owner's machine it logged "no stdio servers connected" (see ER-APP2-060).
  - The live data folder holds a device-registry JSON.
evidence:
  - type: observed
    ref: APP2/obs/main-log
  - type: observed
    ref: APP2/obs/virtualized-folder-layout
  - type: doc
    ref: APP2/doc/agent-mode-architecture
confidence: high
limits: >
  The message schema, the auth scheme, and whether payloads are end-to-end encrypted were
  not inspected. Reading the stage/commit tool names as a two-phase write is inference
  (low).
```

## C. Local VM sandbox (`docs/11` §2–3, §7; FR-102, FR-107)

```yaml
id: ER-APP2-015
area: vm / hypervisor per OS
claim: >
  The local agent-mode sandbox is a Linux micro-VM on every desktop OS.
  - Windows: the Host Compute Service (computecore/vmcompute), driven by the LocalSystem VM
    service.
  - macOS: Apple Virtualization.framework, through a Swift helper module.
  - Linux: QEMU + KVM + OVMF, with virtiofsd for file shares and vhost-vsock for host-guest
    sockets.
evidence:
  - type: doc
    ref: APP2/doc/agent-mode-architecture
  - type: doc
    ref: APP2/doc/desktop-linux
  - type: binary
    ref: APP2/bin/vm-service-strings
  - type: binary
    ref: APP2/bin/package-manifest
confidence: high
limits: Only the Windows path was observed running.
```

```yaml
id: ER-APP2-016
area: vm / boot and disk images (Windows)
claim: >
  Boot:
  - The VM boots a Linux kernel directly, with no bootloader (the Host Compute Service's
    direct kernel boot mode). Kernel 6.8.0-138-generic (an Ubuntu 22.04 HWE build), with a
    zstd-compressed initrd.
  - The VM gets 4 GB RAM. Logged boot steps are download and SDK prepare, load the native VM
    API, create the VM config, create the network, add Plan9 shares, then boot. Boot takes
    177–281 ms.
  Disks in the VM bundle folder:
  - rootfs.vhdx, 8.2 GB, created by QEMU 8.2.2.
  - A legacy raw rootfs.img with a GUID partition table, 11 GB.
  - sessiondata.vhdx, 675 MB, created by Windows.
  - A 38 MB tools disk, copied from the app package on every start.
  Versioning:
  - The bundle is versioned by SHA in marker files, with a `warm/<sha>` staging folder.
  - The bundle folder was about 19 GB on the owner's machine.
  - A Linux build of the CLI agent is stored separately for the VM, with an SDK-version
    marker (2.1.299).
evidence:
  - type: observed
    ref: APP2/obs/vm-bundle-files
  - type: observed
    ref: APP2/obs/vm-node-log
  - type: observed
    ref: APP2/obs/cli-agent-binaries
  - type: binary
    ref: APP2/bin/vm-service-strings
confidence: high
limits: >
  The vCPU count on Windows was not observed. The rootfs contents were not inspected.
  Reading the warm folder as pre-staging for the next version is inference (low).
```

```yaml
id: ER-APP2-017
area: vm / VM service internals (Windows)
claim: >
  - The VM service is a Go 1.25.14 binary that runs as LocalSystem. Clients reach it over a
    named pipe.
  - Internal package names: vm, pipe, edrgate, edrpolicy, logsink.
  - Function names cover: reading the pipe peer's token, validating the bundle path as the
    calling user, running operations while impersonating the user, granting the VM access to
    files, adding Plan9 shares and mounting them in the guest, detecting and fetching a PAC
    script, and querying host memory.
  - It contains certificate-chain verification strings and a setting that names an EDR
    integration vendor.
  - Linked libraries: Microsoft go-winio (HVSocket listener), gVisor tcpip,
    gvisor-tap-vsock, a DNS library and a DHCP library.
evidence:
  - type: binary
    ref: APP2/bin/vm-service-strings
  - type: observed
    ref: APP2/obs/service-status
confidence: high
limits: >
  Strings only. That the service authenticates its pipe client, impersonates that user for
  path checks and verifies bundle signatures is inference (low). The role of the EDR gate is
  unknown.
```

```yaml
id: ER-APP2-018
area: vm / file shares and blocked paths
claim: >
  - Only folders the user connects are mounted into the VM: Plan9 over HVSocket on Windows,
    virtiofs elsewhere. They appear at `/sessions/<name>/mnt/<dir>`.
  - One logged spawn had 7 mounts, including outputs, the agent's config home, an
    auto-memory folder, skills and remote plugins.
  - Since 2026-09-04, even when a whole drive is attached, the app's own config, credential
    locations and shell-startup files stay blocked.
evidence:
  - type: doc
    ref: APP2/doc/desktop-changelog
  - type: doc
    ref: APP2/doc/agent-mode-architecture
  - type: observed
    ref: APP2/obs/vm-node-log
  - type: observed
    ref: APP2/obs/agent-session-records
confidence: high
limits: The exact blocked-path list was not seen. Only the categories are documented.
```

```yaml
id: ER-APP2-019
area: vm / network stack, proxy and egress defaults
claim: >
  - Guest traffic goes through a user-mode network stack on the host (gvisor-tap-vsock, with
    DHCP, DNS, a TCP proxy and PAC detection).
  - A MITM proxy adds the user's OAuth token to requests for the vendor's API. A log line
    says the token was "approved with" the proxy. The token is therefore not placed in the
    guest.
  - Each session has its own egress allowlist. The default list covers npm/yarn, PyPI,
    github.com, Ubuntu archives, crates.io, a browser-automation CDN, and the vendor's own
    domains.
  - Admins can add hosts. Guest IPv6 is off by default.
evidence:
  - type: observed
    ref: APP2/obs/vm-node-log
  - type: observed
    ref: APP2/obs/agent-session-records
  - type: binary
    ref: APP2/bin/vm-service-strings
  - type: doc
    ref: APP2/doc/desktop-changelog
confidence: high
limits: >
  Whether non-allowlisted hosts are blocked, prompted or logged was not tested. TLS details
  on Windows were not inspected (see ER-APP2-021).
```

```yaml
id: ER-APP2-020
area: vm / isolation claims and failure behaviour
claim: >
  - The vendor says the VM enforces its own egress filtering, syscall restrictions and
    per-session user isolation.
  - If the VM fails, shell tools report "workspace unavailable", while file and web tools
    keep working.
  - Endpoint security (EDR) on the host cannot see inside the VM.
evidence:
  - type: doc
    ref: APP2/doc/agent-mode-architecture
confidence: high
limits: >
  This is the vendor's claim. A third-party teardown found little in-guest syscall hardening
  in March 2026 (ER-APP2-021), so the syscall part is disputed.
```

```yaml
id: ER-APP2-021
area: vm / third-party view (macOS, March 2026)
claim: >
  A third-party security teardown of the macOS build reports the following.
  - An ephemeral CA re-signs TLS only for the vendor's API host. Other hosts are
    CONNECT-tunneled without interception.
  - A root daemon runs inside the guest.
  - Each session gets a random Linux user.
  - The VM has 4 vCPU and 4 GB RAM and runs Ubuntu 22.04.5.
  - There is little in-guest syscall hardening.
evidence:
  - type: press
    ref: third-party/security-teardown-2026-03
confidence: medium
limits: >
  The selective MITM matches the Windows log line, and the 4 GB matches the Windows
  observation (medium). The daemon, per-session users, vCPU count and hardening are
  third-party only (low). It may be out of date.
```

## D. Coding tab (`docs/10`; FR-061..078)

```yaml
id: ER-APP2-022
area: code / CLI-agent engine
claim: >
  - The coding tab does not run the agent loop in the app. It downloads a per-version build
    of the vendor's CLI coding agent and drives it through the agent SDK.
  - Downloads are zstd-compressed, per platform, from the vendor's CDN. Each build is
    checked with sha256, and marker files record the payload and its verification.
  - Builds are stored as `<cli-dir>\<ver>\<hash>\<cli>.exe`, about 260 MB each.
  - A Linux build of the same engine is fetched for the VM.
  - The SDK talks to the engine with stream-JSON input and output, and handles permission
    prompts over stdio.
evidence:
  - type: observed
    ref: APP2/obs/main-log
  - type: observed
    ref: APP2/obs/cli-agent-binaries
  - type: observed
    ref: APP2/obs/roaming-folder-layout
  - type: binary
    ref: APP2/bin/package-manifest
  - type: doc
    ref: APP2/doc/coding-tab
confidence: high
limits: Whether old engine versions are pruned was not observed.
```

```yaml
id: ER-APP2-023
area: code / environments and panes
claim: >
  - Environments: Local, Cloud, SSH, WSL, a remote-control machine (ER-APP2-028), or a
    saved environment.
  - Surfaces: diff view, terminal, files pane, preview pane (configured by a launch JSON in
    the repo's hidden app folder), PR monitoring through the `gh` CLI, and child sessions
    started from a session.
  - A preference auto-archives a session when its PR closes.
  - Session presets are stored locally.
evidence:
  - type: doc
    ref: APP2/doc/coding-tab
  - type: doc
    ref: APP2/doc/desktop-changelog
  - type: observed
    ref: APP2/obs/mcp-config-virtualized
  - type: observed
    ref: APP2/obs/virtualized-folder-layout
confidence: high
limits: The panes were not exercised. The list comes from the docs and the config keys.
```

```yaml
id: ER-APP2-024
area: code / SSH and WSL remoting
claim: >
  SSH:
  - The desktop installs a helper and the CLI agent on the remote host under
    `~/<agent-home>/remote/{srv, <cli>, run, plugins}`.
  - It talks to them over a mode-600 Unix socket reached through the SSH connection.
  - It uses the system OpenSSH or a built-in SSH library.
  - SSH configs, remote-server state and remembered SSH passwords are kept in local JSON
    files.
  WSL:
  - WSL uses the same "remote spawn" path, aimed at a named distro.
evidence:
  - type: doc
    ref: APP2/doc/coding-tab
  - type: doc
    ref: APP2/doc/desktop-wsl
  - type: observed
    ref: APP2/obs/ssh-logs
  - type: observed
    ref: APP2/obs/virtualized-folder-layout
confidence: high
limits: >
  The remembered-passwords file was not opened. Whether it is encrypted at rest is unknown.
```

```yaml
id: ER-APP2-025
area: code / worktrees
claim: >
  - Each worktree is created at `<repo>/.<app-dir>/worktrees/<name>`, on a branch named
    `<app-prefix>/<name>`.
  - A `.worktreeinclude` file lists git-ignored files (for example env files) to copy into
    new worktrees.
  - A worktree is kept until its session is archived.
  - A registry JSON records name, path, base repo, branch, source branch, created-at,
    leased-by, and schema version 2.
evidence:
  - type: doc
    ref: APP2/doc/coding-tab
  - type: observed
    ref: APP2/obs/worktree-registry
confidence: high
limits: The lease semantics (which session holds a worktree, and for how long) were not traced.
```

```yaml
id: ER-APP2-026
area: code / git hooks
claim: >
  Since 2026-10-15, Git operations that the app itself runs skip the repository's hooks.
evidence:
  - type: doc
    ref: APP2/doc/desktop-changelog
confidence: high
limits: >
  Which operations count as "run by the app", as opposed to commands the agent runs, is not
  specified.
```

```yaml
id: ER-APP2-027
area: code / CLI handoff
claim: >
  - A slash command and a CLI flag (CLI agent 2.1.285 or later) hand a terminal session to
    the desktop app.
  - A resume command in the desktop picks up CLI sessions.
  - The standalone CLI ignores the desktop's MCP config file.
evidence:
  - type: doc
    ref: APP2/doc/coding-tab
  - type: doc
    ref: APP2/doc/cli-agent-changelog
confidence: high
limits: Not exercised.
```

## E. Remote control, phone thread and schedules (`docs/09`, `docs/13`, `docs/22`)

```yaml
id: ER-APP2-028
area: remote / remote control
claim: >
  - Remote control lets another device (a phone or browser) drive a desktop or CLI session.
  - It uses outbound HTTPS only. The machine registers with the vendor API as an
    "environment" and polls for work, using short-lived scoped credentials. No inbound port
    is opened.
  - A local state file records enabled, user-consented, environment ID, and the local and
    remote session IDs.
evidence:
  - type: doc
    ref: APP2/doc/remote-control
  - type: observed
    ref: APP2/obs/bridge-state
  - type: observed
    ref: APP2/obs/remote-control-log
confidence: high
limits: Polling interval, credential lifetime and payload encryption were not observed.
```

```yaml
id: ER-APP2-029
area: remote / phone-to-desktop persistent thread
claim: >
  - A research preview since 2026-03-17: one long-lived agent thread that the user talks to
    from a phone and that acts on the desktop.
  - A parent agent spawns child sessions. Child records carry a child session type and a
    parent session ID.
  - Its built-in MCP server offers start_task, send_message, list_projects and
    list_code_workspaces.
  - Computer-use grants made in this thread last 30 minutes (config value 1,800,000 ms).
evidence:
  - type: doc
    ref: APP2/doc/release-notes
  - type: doc
    ref: APP2/doc/blog-phone-thread-computer-use
  - type: observed
    ref: APP2/obs/agent-session-records
  - type: observed
    ref: APP2/obs/feature-flag-cache
  - type: press
    ref: third-party/security-teardown-2026-03
confidence: high
limits: >
  How the parent agent decides to spawn children, and how results flow back, was not traced.
```

```yaml
id: ER-APP2-030
area: schedules / scheduled tasks and local routines
claim: >
  Agent mode:
  - Scheduled tasks since 2026-02-25. In cloud mode they run with no device online.
  Local coding routines:
  - They need the app open and the machine awake. The schedule is checked every minute.
  - After downtime, one catch-up run covers all misses from the last 7 days.
  - Each routine's prompt is stored as a skill file at
    `~/<agent-home>/scheduled-tasks/<name>/SKILL.md`.
  Both:
  - A per-account/org JSON holds the task list and recorded skips.
  - Separate preferences turn scheduled tasks on for agent mode and for the coding tab.
evidence:
  - type: doc
    ref: APP2/doc/release-notes
  - type: doc
    ref: APP2/doc/desktop-scheduled-tasks
  - type: observed
    ref: APP2/obs/scheduled-tasks-file
  - type: observed
    ref: APP2/obs/mcp-config-virtualized
confidence: high
limits: Catch-up was not observed firing. The meaning of "recorded skips" was not traced.
```

## F. Computer use and browsers (`docs/11` §4–5; FR-092..098)

```yaml
id: ER-APP2-031
area: computer use / model and safety
claim: >
  - A research preview since 2026-03-23 on macOS and Windows.
  - Documented tool precedence: connectors, then shell, then the browser extension, then the
    device simulator, then computer use last.
  - Per-app control tiers: browsers are view-only, terminals and IDEs are click-only, and
    everything else gets full control.
  - Grants are per app. Esc is a kill switch.
  - Input goes through the native addon (ER-APP2-003).
  - On-screen overlays: an edge glow, an Esc hint, a side panel and a live preview.
evidence:
  - type: doc
    ref: APP2/doc/blog-phone-thread-computer-use
  - type: doc
    ref: APP2/doc/coding-tab
  - type: doc
    ref: APP2/doc/desktop-changelog
  - type: binary
    ref: APP2/bin/asar-listing
  - type: press
    ref: third-party/press-windows-expansion
confidence: high
limits: >
  A third-party report dates the Windows expansion to 2026-04-03. The vendor blog says macOS
  and Windows without a separate date. Tier enforcement was not tested.
```

```yaml
id: ER-APP2-032
area: computer use / feature flags
claim: >
  The computer-use flag object seen locally has these keys: hideBeforeAction,
  screenshotFilter, coordinateMode = pixels, watch-record enabled on Windows,
  adaptiveResolution, clipboardGuard, maskFailClosed.
evidence:
  - type: observed
    ref: APP2/obs/feature-flag-cache
confidence: medium
limits: >
  Key names only. Their likely meanings are inference (low): hide the app window before
  acting, filter screenshots, scale resolution adaptively, guard the clipboard, and fail
  closed when masking sensitive regions fails.
```

```yaml
id: ER-APP2-033
area: computer use / teach and record-a-skill
claim: >
  - A "teach" mode and a watch-and-record mode ship as separate preload windows, with a
    chooser for what to record.
  - The user-facing feature is "Record a skill": the user demonstrates a workflow and the
    app turns the recording into a reusable skill.
  - A flag enables watch-record on Windows.
evidence:
  - type: binary
    ref: APP2/bin/asar-listing
  - type: observed
    ref: APP2/obs/feature-flag-cache
  - type: doc
    ref: APP2/doc/desktop-changelog
confidence: medium
limits: >
  The recording format, and how a recording becomes a skill, were not traced.
```

```yaml
id: ER-APP2-034
area: browser / built-in browser pane
claim: >
  - A Chromium pane inside the app is the default browser for agent mode. Admins can set
    domain allow and block policies for it.
  - Local preferences select the preferred browser (here, built-in), turn browser tools on,
    and set an allow-all-browser-actions option.
  - In coding sessions, the `$BROWSER` shim sends URLs that tools open to the session's
    browser pane.
evidence:
  - type: doc
    ref: APP2/doc/agent-mode-get-started
  - type: doc
    ref: APP2/doc/desktop-changelog
  - type: observed
    ref: APP2/obs/mcp-config-virtualized
  - type: binary
    ref: APP2/bin/install-dir-listing
confidence: high
limits: Profile isolation of the pane was not checked.
```

```yaml
id: ER-APP2-035
area: browser / extension bridge
claim: >
  - The desktop copies its native-messaging host executable to disk, writes the host
    manifest, and registers it under HKCU for Chrome and Edge. The MSIX manifest also
    reserves keys for nine Chromium-family browsers (ER-APP2-006).
  - The host then connects to a vendor WebSocket relay, keyed by a pairing ID. The log shows
    "Paired". The paired device ID and name are stored in preferences.
  - Agent tabs run in the user's real browser profile, with its logged-in sessions.
  - Coding sessions record the allowed domains and a tab-group ID.
evidence:
  - type: observed
    ref: APP2/obs/chrome-native-host-log
  - type: observed
    ref: APP2/obs/main-log
  - type: observed
    ref: APP2/obs/code-session-records
  - type: doc
    ref: APP2/doc/browser-extension-get-started
  - type: doc
    ref: APP2/doc/browser-extension-admin
  - type: doc
    ref: APP2/doc/browser-3p-desktop
  - type: press
    ref: third-party/security-teardown-2026-03
confidence: high
limits: >
  Whether consent is per tab, and what indicator is shown, were not observed. The relay
  payload format was not inspected.
```

## G. Other surfaces

```yaml
id: ER-APP2-036
area: surfaces / hotkey capture window and dictation
claim: >
  - A floating window opens from a global hotkey.
  - On macOS: double-tap Option, region or window screen capture into the prompt, and Caps
    Lock dictation (macOS 14+).
  - The docs say macOS only. But the Windows build ships the window, and config stores its
    position per monitor. A third-party report cites Ctrl+Alt+Space on Windows.
  - Capture is started by the user. No passive or continuous screen capture is documented.
evidence:
  - type: doc
    ref: APP2/doc/quick-capture-window
  - type: binary
    ref: APP2/bin/asar-listing
  - type: observed
    ref: APP2/obs/config-json
  - type: press
    ref: third-party/issue-capture-window-windows
confidence: medium
limits: Docs and local evidence disagree on Windows availability. Not exercised.
```

```yaml
id: ER-APP2-037
area: surfaces / voice
claim: >
  - Voice assets (audio worklets) ship inside the bundled web-app copy.
  - The native addon can capture audio through WASAPI.
  - Voice is documented as unavailable on Linux.
evidence:
  - type: binary
    ref: APP2/bin/install-dir-listing
  - type: binary
    ref: APP2/bin/native-addon-strings
  - type: doc
    ref: APP2/doc/desktop-linux
confidence: medium
limits: >
  Nothing official confirms voice mode or dictation on Windows. Their presence is inferred
  from the assets (low).
```

```yaml
id: ER-APP2-038
area: surfaces / memory
claim: >
  - Memory became available on the free plan on 2026-03-02. Entries have been categorized
    since 2026-07-10. Since 2026-08-25 memory is shared between chat and agent mode and the
    user can edit it.
  - Locally:
    - Agent mode mounts an auto-memory folder into the VM.
    - An agent memory folder exists per account/org.
    - The device bridge has project-memory read and write tools.
    - Session records carry a memory-enabled flag.
evidence:
  - type: doc
    ref: APP2/doc/release-notes
  - type: observed
    ref: APP2/obs/vm-node-log
  - type: observed
    ref: APP2/obs/agent-session-records
  - type: observed
    ref: APP2/obs/main-log
confidence: high
limits: >
  The category set and the storage format of the memory files were not inspected.
```

```yaml
id: ER-APP2-039
area: surfaces / projects
claim: >
  Each project holds files, links, instructions and memory. Agent-mode sessions can read and
  write project memory through the device bridge (ER-APP2-014).
evidence:
  - type: doc
    ref: APP2/doc/agent-mode-get-started
  - type: doc
    ref: APP2/doc/desktop-changelog
confidence: high
limits: none beyond documentation.
```

```yaml
id: ER-APP2-040
area: surfaces / artifacts, design, slides, docs
claim: >
  - The artifacts tab is on all plans.
  - Design, slides and docs have been available in any chat since 2026-09-16.
  - Chart.js, Grid.js and Mermaid ship in the bundle.
  - Separate preloads exist for a design window and for agent-mode artifacts.
  - The device bridge exposes list, create and update artifact tools.
evidence:
  - type: doc
    ref: APP2/doc/release-notes
  - type: doc
    ref: APP2/doc/desktop-changelog
  - type: binary
    ref: APP2/bin/asar-listing
  - type: binary
    ref: APP2/bin/install-dir-listing
confidence: high
limits: Artifact storage and versioning were not inspected.
```

## H. MCP (`docs/08` §2; FR-042..049)

```yaml
id: ER-APP2-041
area: mcp / stdio config file
claim: >
  - Local stdio servers are declared in a JSON config file in the app's roaming data folder.
    The vendor names `%APPDATA%\<App>\` on Windows and `~/Library/Application Support/<App>/`
    on macOS.
  - Shape: a map of server name to command, args and env. Env values are stored as plain
    text.
  - The same file holds a large preferences block (browser, scheduled tasks, web search,
    keep-awake, computer use, device name, PR auto-archive, and more) and a user-files path
    for agent mode.
  - Servers are launched through `cmd.exe`. Each server logs to its own file.
  - A changelog entry documents a Chromium-flags key in the same file.
evidence:
  - type: doc
    ref: third-party/mcp-local-servers-doc
  - type: observed
    ref: APP2/obs/mcp-config-virtualized
  - type: observed
    ref: APP2/obs/mcp-config-real
  - type: observed
    ref: APP2/obs/mcp-server-logs
  - type: doc
    ref: APP2/doc/desktop-changelog
confidence: high
limits: >
  On the owner's machine, an external installer wrote a local API key into env as plain text
  (value not recorded). Which file the app reads is affected by MSIX virtualization
  (ER-APP2-060).
```

```yaml
id: ER-APP2-042
area: mcp / handshake and UI extension
claim: >
  - The client speaks MCP protocol version 2025-11-25.
  - In `initialize` it advertises the MCP UI extension (`io.modelcontextprotocol/ui`,
    MIME type `text/html;profile=mcp-app`). Its clientInfo names the hosted web app.
  - After that: initialized, then tools/list, resources/list and prompts/list, then
    tools/call.
  - The client renders `ui://` resources in a sandboxed iframe.
  - MCP Apps became the protocol's first official extension on 2026-01-26.
evidence:
  - type: observed
    ref: APP2/obs/mcp-log
  - type: doc
    ref: third-party/mcp-apps-overview
  - type: press
    ref: third-party/press-mcp-apps
confidence: high
limits: >
  The handshake comes from older logs (the current MCP log is empty, see ER-APP2-060). Iframe
  sandbox attributes were not inspected.
```

```yaml
id: ER-APP2-043
area: mcp / extension bundle format
claim: >
  - A single MCP server can be installed as a zip bundle (`.mcpb`, the MCP bundle format)
    that contains a `manifest.json`. It was renamed from an earlier vendor-specific name on
    2025-09-11. Spec version 0.3; 0.4 adds `uv`.
  - Required fields: manifest_version, name, version, description, author, server.
  - `server.type` is one of node, python, binary or uv. `mcp_config` holds command, args,
    env and per-platform overrides.
  - `user_config` fields are typed string, number, boolean, directory or file. Values marked
    `sensitive` are stored in the OS keychain.
  - Template variables: the bundle directory, user_config values, HOME, and the path
    separator.
  - Optional fields include compatibility, generated-tools and privacy-policy links.
  - The host app ships its own Node runtime, so node bundles need no system Node.
evidence:
  - type: doc
    ref: APP2/doc/extension-bundles-blog
  - type: doc
    ref: third-party/mcpb-manifest-spec
  - type: doc
    ref: APP2/doc/extension-bundle-building
  - type: binary
    ref: APP2/bin/package-manifest
confidence: high
limits: Format facts come from the spec. Only one installed bundle was inspected (ER-APP2-044).
```

```yaml
id: ER-APP2-044
area: mcp / installed bundles and governance
claim: >
  Installed on the owner's machine:
  - A first-party filesystem bundle (v0.2.2, manifest_version 0.2, node server, 11 tools,
    with a multi-directory "allowed directories" setting).
  - The install record stores a hash, installed-at, signature status "unsigned" and source
    "registry".
  - Per-bundle settings store enabled and the user config.
  Governance:
  - An org blocklist is fetched from the vendor API, with a can-install check and a
    per-org allowlist flag.
  - Policy keys renamed on 2026-10-13 cover: bundles enabled, signature required, and
    directory enabled.
  - Unsigned bundles load on standard deployments.
evidence:
  - type: observed
    ref: APP2/obs/extension-install-records
  - type: observed
    ref: APP2/obs/config-json
  - type: observed
    ref: APP2/obs/main-log
  - type: doc
    ref: APP2/doc/desktop-changelog
confidence: high
limits: >
  A changelog note says bundles have been off by default since 2026-07-07. That probably
  applies only to managed or third-party deployments (inference, low).
```

```yaml
id: ER-APP2-045
area: mcp / remote connectors
claim: >
  - Remote MCP servers are added by URL.
  - OAuth options: client-ID metadata documents (CIMD), dynamic client registration (DCR),
    or the user's own client. Request headers are optional.
  - Transport: Streamable HTTP, or SSE for older servers.
  - In cloud sessions, connector calls run server-side. In local and SSH coding sessions,
    the desktop passes connectors to the CLI agent directly.
  - Session records store each remote server's uuid, name, url and tool list.
evidence:
  - type: doc
    ref: APP2/doc/custom-connectors
  - type: doc
    ref: APP2/doc/agent-mode-architecture
  - type: doc
    ref: APP2/doc/coding-tab
  - type: observed
    ref: APP2/obs/agent-session-records
confidence: high
limits: Where tokens are stored for connectors passed to local sessions was not traced.
```

```yaml
id: ER-APP2-046
area: mcp / built-in servers
claim: >
  The agent-mode allowed-tools list exposes these built-in MCP servers:
  - the browser-extension bridge, an MCP registry, computer use, plugins
  - scheduled tasks, the agent-mode host itself, session info
  - the phone-thread server (start_task, send_message, list_projects, list_code_workspaces)
  The built-in GitHub and Microsoft 365 connectors are separate bundled stdio servers
  (ER-APP2-004). An admin key can disable built-in tools.
evidence:
  - type: observed
    ref: APP2/obs/vm-node-log
  - type: doc
    ref: APP2/doc/desktop-changelog
confidence: high
limits: Tool lists for each server, apart from the phone-thread server, were not captured.
```

```yaml
id: ER-APP2-047
area: mcp / per-tool toggles and "always allow"
claim: >
  - A local JSON stores the user's per-tool on/off toggles.
  - Coding sessions record their enabled MCP tools.
  - A policy key controls whether "Always allow" decisions persist.
evidence:
  - type: observed
    ref: APP2/obs/virtualized-folder-layout
  - type: observed
    ref: APP2/obs/code-session-records
  - type: doc
    ref: APP2/doc/desktop-changelog
confidence: high
limits: The scope of a persisted "always allow" (per tool, server or session) was not traced.
```

## I. Plugins and skills (`docs/08` §3–4; FR-045, FR-046, FR-049)

```yaml
id: ER-APP2-048
area: extensibility / skills
claim: >
  - Skills are folders that contain a SKILL.md.
  - Account-level skills sync to the desktop every 20 minutes (log: periodic sync, interval
    1,200,000 ms).
  - Built-in skills ship in the app archive (ER-APP2-004).
  - Agent mode ignores the CLI agent's per-user home folder, so locally authored CLI skills
    do not apply there.
evidence:
  - type: observed
    ref: APP2/obs/main-log
  - type: binary
    ref: APP2/bin/bundled-skills-manifest
  - type: doc
    ref: APP2/doc/plugins-overview
confidence: high
limits: How sync conflicts or deletions are handled was not observed.
```

```yaml
id: ER-APP2-049
area: extensibility / plugins
claim: >
  - A plugin bundles skills, commands, agents, hooks and MCP servers. It is described by
    `.<app>-plugin/plugin.json`.
  - Install sources: the in-app directory, a Git marketplace, or an uploaded zip. Installs
    are saved to the account.
  - Directory submissions opened on 2026-09-25.
  - On the owner's machine, the vendor's first-party Git marketplace is cloned into the
    agent-mode plugins folder. A settings file lists extra known marketplaces.
  - Loading differs by surface:
    - Chat gets skills, commands and connectors.
    - Agent mode gets every component.
    - The coding tab gets the plugin as a synced plugin.
  - A bundled connector marked "runs in each session" is started as a local process.
  - Admin keys: allowed marketplaces, and allowed or denied plugin MCP servers.
evidence:
  - type: doc
    ref: APP2/doc/plugins-overview
  - type: doc
    ref: APP2/doc/desktop-changelog
  - type: observed
    ref: APP2/obs/agent-plugins-folder
confidence: high
limits: Plugin signing or verification was not observed.
```

## J. Enterprise policy (`docs/12` §10; FR-106)

```yaml
id: ER-APP2-050
area: policy / managed settings
claim: >
  - Sources: the Windows registry, a macOS configuration profile, or
    `/etc/<app>/managed-settings.json` on Linux.
  - Documented keys cover:
    - managed MCP servers; turning off local developer MCP; turning off local desktop
      sessions
    - an SSH host allowlist and allowed workspace folders
    - disabled built-in tools, built-in browser domain policies, and agent-mode egress hosts
    - OTLP telemetry export and retention settings
    - routing inference through third-party cloud model platforms or gateways
    - bundle governance (ER-APP2-044) and plugin governance (ER-APP2-049)
  - No signature on the policy itself is documented.
evidence:
  - type: doc
    ref: APP2/doc/desktop-changelog
  - type: doc
    ref: APP2/doc/coding-tab
  - type: doc
    ref: APP2/doc/desktop-linux
  - type: binary
    ref: APP2/bin/package-manifest
confidence: high
limits: No policy was applied on the owner's machine. Precedence against user settings was not tested.
```

## K. Data and storage layout (`docs/06`, `docs/15` §5)

```yaml
id: ER-APP2-051
area: storage / real roaming folder (Windows)
claim: >
  `%APPDATA%\<App>\` (the real, unvirtualized path) holds:
  - Chromium profile folders.
  - The VM bundles (about 19 GB).
  - Per-version CLI-agent builds (about 260 MB each) and the Linux build for the VM.
  - Installed MCP bundles, agent-mode sessions and coding sessions.
  - Logs, which stop in August on this machine.
  - config.json, bundle install and settings JSONs, the worktree registry and the
    remote-control state file.
  - An unidentified token file, which was not opened.
evidence:
  - type: observed
    ref: APP2/obs/roaming-folder-layout
confidence: high
limits: The split between this folder and the virtualized one is covered in ER-APP2-060..062.
```

```yaml
id: ER-APP2-052
area: storage / virtualized live folder, logs and other folders
claim: >
  `%LOCALAPPDATA%\Packages\<Pkg>_pzs8sxrjxfjjc\LocalCache\Roaming\<App>\` (the live,
  MSIX-virtualized copy) holds:
  - The MCP config file and config.json.
  - A device registry, local IDs, coding-session presets and per-tool toggles.
  - Remote-control state, a phone-thread footprint census, and plan usage history.
  - SSH configs, SSH remote-server state and remembered SSH passwords (not opened).
  - A git shadow folder, SSH remote assets and terminal shell-integration scripts.
  The current logs are in `%LOCALAPPDATA%\<App>\Logs`: main, web app, VM node,
  native-messaging host, remote control, SSH and MCP.
  Two `%LOCALAPPDATA%` data folders are excluded from virtualization (ER-APP2-006). They
  exist and are empty on this machine.
evidence:
  - type: observed
    ref: APP2/obs/virtualized-folder-layout
  - type: observed
    ref: APP2/obs/localappdata-folders
confidence: high
limits: >
  That the empty excluded folders are the target of a planned move out of the package is
  inference (low), supported by the manifest exclusions and a user-data-move routine.
```

```yaml
id: ER-APP2-053
area: storage / agent-mode sessions
claim: >
  Per account/org:
  - A settings file with extra known marketplaces, and the cloned plugin marketplace.
  - The scheduled-tasks JSON.
  - One JSON per session, plus a folder per session.
  - A folder for the phone-thread parent agent, an agent memory folder and a debug folder.
  - Caches for feature flags, policy limits and client data.
  Session JSON keys:
  - session ID, process name, CLI session ID, cwd (`/sessions/<name>`), user-selected
    folders, model, VM process name
  - host-loop flag, slash commands, remote MCP server config, browser permission mode,
    egress allowed domains, memory enabled
  - session type, parent session ID, a full system prompt (about 43 KB), account name and
    email address (values not recorded)
  Session folder:
  - The agent's own config home (projects, sessions, plans, shell snapshots, skills,
    session env).
  - An `audit.jsonl` with a sibling key file, plus outputs and uploads.
evidence:
  - type: observed
    ref: APP2/obs/agent-session-records
  - type: observed
    ref: APP2/obs/agent-session-folder
confidence: high
limits: >
  The audit file format was not read. That the key file signs or MACs the audit log is
  inference (low).
```

```yaml
id: ER-APP2-054
area: storage / coding sessions
claim: >
  Each coding session has a JSON record with these keys:
  - cwd, origin cwd, worktree path and name, branch, source branch, model, effort,
    permission mode
  - enabled MCP tools, remote MCP server config, SSH host, remote transcript path
  - browser allowed domains, browser tab-group ID, completed turns, and cloud tasks spawned
    from the session
  Alongside the records: an archived-sessions index and per-session deletion tombstones.
evidence:
  - type: observed
    ref: APP2/obs/code-session-records
confidence: high
limits: Transcripts were not read.
```

```yaml
id: ER-APP2-055
area: storage / config.json and Chromium profile
claim: >
  - config.json keys: locale, theme mode, per-org bundle allowlist entries, hotkey-window
    position (per monitor), OAuth token caches (two versions), the last version the updater
    saw, and a flag recording whether a full-VM sandbox is required.
  - The Chromium profile has the usual caches (GPU, code, WebGPU), Crashpad, network
    partitions and blob storage.
  - Its Local State holds a DPAPI-wrapped OS-crypt key.
evidence:
  - type: observed
    ref: APP2/obs/config-json
  - type: observed
    ref: APP2/obs/chromium-userdata
confidence: high
limits: >
  Token values were not read. That the token caches are encrypted with the OS-crypt key
  (Electron safeStorage over DPAPI) is inference (low).
```

## L. Security model (`docs/12`; FR-063, FR-099..107)

```yaml
id: ER-APP2-056
area: security / permission modes
claim: >
  - Coding-tab modes: default, accept edits, plan, auto, bypass permissions.
  - Agent-mode modes: Manual, Auto, Skip.
  - A preference gates bypass per account.
  - Computer use has per-app grants and an Esc kill switch. In the phone thread, grants
    expire after 30 minutes.
  - A policy key controls whether "Always allow" persists.
evidence:
  - type: doc
    ref: APP2/doc/coding-tab
  - type: doc
    ref: APP2/doc/agent-mode-get-started
  - type: doc
    ref: APP2/doc/desktop-changelog
  - type: observed
    ref: APP2/obs/mcp-config-virtualized
  - type: observed
    ref: APP2/obs/code-session-records
confidence: high
limits: The agent-mode modes were not exercised.
```

```yaml
id: ER-APP2-057
area: security / credential storage
claim: >
  - Windows: the Chromium OS-crypt key is wrapped with DPAPI.
  - MCP bundle values marked sensitive go to the OS keychain. On Linux that is GNOME
    Keyring or KWallet.
  - OAuth token caches are kept in config.json (ER-APP2-055).
  - Remembered SSH passwords are kept in a JSON file (ER-APP2-052).
  - Stdio MCP env values sit in plain text in the config file (ER-APP2-041).
evidence:
  - type: observed
    ref: APP2/obs/chromium-userdata
  - type: observed
    ref: APP2/obs/config-json
  - type: doc
    ref: APP2/doc/extension-bundles-blog
  - type: doc
    ref: APP2/doc/desktop-linux
confidence: high
limits: Whether the SSH password and token files are encrypted was not checked.
```

```yaml
id: ER-APP2-058
area: security / app process isolation
claim: >
  - The app is a full-trust MSIX that runs as the user. It is not an AppContainer. Its
    child processes sit in a Windows Job object.
  - Agent shell isolation comes from the VM (section C). The VM is brokered by a LocalSystem
    service rather than by the user-level app.
  - Coding-tab Local sessions run the CLI agent on the host, not in the VM.
evidence:
  - type: binary
    ref: APP2/bin/appx-manifest
  - type: observed
    ref: APP2/obs/main-log
  - type: doc
    ref: APP2/doc/coding-tab
confidence: high
limits: Any OS-level sandbox that the CLI agent applies to itself on the host was not inspected.
```

```yaml
id: ER-APP2-059
area: security / supply chain
claim: >
  - The MSIX is signed. The certificate was renewed in October 2026.
  - CLI-agent builds are sha256-verified before use.
  - The VM bundle is versioned by SHA, with checksums.
  - A signed model catalog is fetched from the vendor's download host.
  - Since 2026-10-15, Git operations run by the app skip repository hooks (ER-APP2-026).
  - MCP bundles may be unsigned on standard deployments (ER-APP2-044).
evidence:
  - type: doc
    ref: APP2/doc/desktop-changelog
  - type: observed
    ref: APP2/obs/appx-package-query
  - type: observed
    ref: APP2/obs/cli-agent-binaries
  - type: observed
    ref: APP2/obs/vm-bundle-files
confidence: high
limits: Signature verification of the VM bundle by the service is inferred from strings (ER-APP2-017).
```

## M. Owner-machine observations relevant to `docs/15`

```yaml
id: ER-APP2-060
area: packaging / MSIX AppData split: MCP config (observed)
claim: >
  The owner's machine has two copies of the MCP config file.
  - Live copy, under the package's virtualized LocalCache\Roaming: it has an empty server
    map.
  - Real `%APPDATA%\<App>\` copy: it has two stdio servers that an external installer wrote
    there, a screenpipe MCP server and an Obsidian vault MCP server.
  The external entries do not load. Signs of this:
  - The per-server MCP logs in the real folder stop in July.
  - The current MCP log is 0 bytes.
  - The local-MCP bridge reports "no stdio servers connected".
  - The main log reports that MSIX filesystem virtualization is active.
evidence:
  - type: observed
    ref: APP2/obs/mcp-config-virtualized
  - type: observed
    ref: APP2/obs/mcp-config-real
  - type: observed
    ref: APP2/obs/mcp-server-logs
  - type: observed
    ref: APP2/obs/mcp-log
  - type: observed
    ref: APP2/obs/main-log
confidence: high
limits: >
  No write test was done (for example, adding an entry to the live copy and restarting).
  The cause is in ER-APP2-062.
```

```yaml
id: ER-APP2-061
area: packaging / MSIX AppData split: local VM (observed)
claim: >
  - From mid-September to October, local agent-mode VM starts fail with "failed to set VHDX
    path: VHDX file not found".
  - The path in the error is the rootfs disk under the package's virtualized
    LocalCache\Roaming folder.
  - The VM bundle physically sits in the real `%APPDATA%\<App>\` folder.
  - Cloud agent mode and the coding tab keep working on the same machine.
evidence:
  - type: observed
    ref: APP2/obs/vm-node-log
  - type: observed
    ref: APP2/obs/vm-bundle-files
  - type: observed
    ref: APP2/obs/roaming-folder-layout
confidence: high
limits: No repair was attempted. The cause is in ER-APP2-062.
```

```yaml
id: ER-APP2-062
area: packaging / MSIX AppData split: cause (inference)
claim: >
  Both failures likely come from MSIX per-user AppData redirection.
  - The packaged app, and the LocalSystem service when it resolves user paths, see the
    package-private copy of the roaming folder.
  - Files written to the real path, by external installers or by earlier unpackaged
    versions, are shadowed.
  - The vendor appears to be addressing this. The MSIX manifest excludes three
    `%LOCALAPPDATA%` folders from virtualization, and the app contains a user-data-move
    routine. A preference records the user's answer to moving user data out of the package.
evidence:
  - type: observed
    ref: APP2/obs/main-log
  - type: binary
    ref: APP2/bin/appx-manifest
  - type: observed
    ref: APP2/obs/mcp-config-virtualized
  - type: observed
    ref: APP2/obs/localappdata-folders
confidence: low
limits: >
  Inference. The path resolution was not traced with a file-system monitor. Which component
  resolves the VHDX path, the app or the service, is not confirmed.
```

---

## Divergences from the current spec (inputs for RECONCILIATION.md, not decisions)

| rea doc today | Finding | Evidence |
| --- | --- | --- |
| `docs/23` §1–4, `docs/21` §8, FR-141: the device agent is an elevated `novad` supervisor with signed, sandboxed modules and mTLS to the Hub | The device endpoint is the desktop app itself, connected outbound to a vendor relay. It serves a tool-level API to cloud sessions: shell, directory listing, staged-then-committed file writes, folder-access requests, artifacts, project memory, and pass-through of local MCP servers | ER-APP2-012, 014 |
| `docs/22` §3, FR-137: a content-blind, end-to-end-encrypted Relay | The device bridge, the browser-extension bridge and remote control all go through vendor-hosted relays or APIs. No end-to-end claim was found. Remote control polls with short-lived scoped credentials | ER-APP2-014, 028, 035 |
| FR-107, `docs/11` §2.2–2.3, `docs/05` §2: an OS sandbox (bwrap/seatbelt/AppContainer), podman by default, "optional VM" | On every desktop OS the agent shell runs in a per-session Linux micro-VM: a hypervisor per OS, direct kernel boot, SHA-versioned disk images, about 200 ms boot, 4 GB RAM | ER-APP2-015, 016, 020 |
| `docs/11` §3, §7; `docs/12` §5: a proxy with CONNECT + DNS pinning; secrets injected through env or an ephemeral header | The user-mode network stack runs in a host service. A MITM proxy injects the auth token for the vendor API, so the token never enters the guest. Each session has a domain allowlist whose default is a list of package registries. IPv6 is off | ER-APP2-019, 021 |
| `docs/11` §2.2, §9: mount only approved folders; the vault is never mounted | Even when a whole drive is shared, app config, credential locations and shell-startup files stay blocked. The vendor claims per-session Linux users | ER-APP2-018, 020, 021 |
| FR-107 (Windows AppContainer) | The app process itself is a full-trust MSIX in a Job object, not an AppContainer. A LocalSystem service brokers the VM and impersonates the user. Coding-tab Local sessions run on the host | ER-APP2-017, 058 |
| `docs/15` §1, §5: NSIS/MSI/portable; data in `%APPDATA%\Nova\` | MSIX with a packaged LocalSystem service. Per-user AppData virtualization shadowed externally written MCP entries and broke the local VM on the owner's machine. The vendor added unvirtualized folders and a user-data move | ER-APP2-006, 060, 061, 062 |
| `docs/15` §4, FR-120: channels, consent, staged rollout, rollback | Updates roughly every 4 hours. Coding-engine builds are downloaded and hash-verified separately from app releases | ER-APP2-008, 022 |
| FR-002, `docs/02` INV-A01: separate Chat / Work / Code / Agents modes | Chat and agent mode are merging into one unified mode, where the model chooses between a quick answer and a long task | ER-APP2-010 |
| `docs/09` §1, `docs/10` §1: Code uses Nova's own runtime | The coding tab drives a separate, per-version, sha256-verified CLI agent through an agent SDK. A Linux build of the same engine ran inside the VM for agent mode | ER-APP2-011, 022 |
| FR-062, `docs/10` §2: Local / Cloud / SSH / WSL / container | Adds a "remote-control machine" environment and saved environments. SSH installs a helper plus the engine on the remote host and talks over a forwarded mode-600 socket | ER-APP2-023, 024 |
| `docs/10` §9, FR-073: `<repo>/.nova/worktrees/<id>`, cleaned up on archive | Same shape. Adds an include file that copies ignored files into new worktrees, and a lease field in the worktree registry | ER-APP2-025 |
| `docs/10` §8 Git guards | Git operations run by the app skip repository hooks (since 2026-10-15) | ER-APP2-026 |
| `docs/09` §12: a missed fire runs once on wake within a 15-minute grace window | Local routines get one catch-up run covering misses from the last 7 days. The schedule is checked every minute and needs the app open and the machine awake. The prompt is stored as a skill file. Cloud tasks run with no device online | ER-APP2-030 |
| FR-054, FR-077, FR-111 | A persistent phone-to-desktop parent thread spawns child sessions. Its computer-use grants expire after 30 minutes | ER-APP2-029 |
| FR-093, `docs/11` §5 | Per-app control tiers: browsers view-only, terminals and IDEs click-only, others full. Computer use comes last in the tool-precedence order. Teach and record-a-skill turn demonstrations into skills | ER-APP2-031, 033 |
| `docs/11` §4.3, FR-096: per-tab consent and a visible indicator | The extension bridge uses native messaging plus a vendor relay. Agent tabs share the user's real profile. The native host is registered for nine Chromium-family browsers | ER-APP2-035 |
| `docs/08` §2 | The MCP client advertises the MCP UI extension (`ui://` resources in sandboxed iframes) and speaks protocol 2025-11-25 | ER-APP2-042 |
| `docs/08` §3, FR-045, FR-167 (signed installs only) | Single-server MCP bundles have typed user config (sensitive values go to the keychain) and use the host's bundled runtime. Unsigned bundles load on standard deployments | ER-APP2-043, 044 |
| `docs/08` §2.3: secrets are keychain refs | Stdio config env values are stored in plain text, including an API key on the owner's machine | ER-APP2-041 |
| FR-106, `docs/12` §10: a signed policy file; unsigned files are ignored | Policy comes from OS-native channels (registry, configuration profile, an `/etc` file) with no documented signature. Keys cover MCP, local sessions, SSH hosts, workspace folders, built-in tools, browser domains, egress, OTLP, third-party inference routing and retention | ER-APP2-050 |
| FR-046, FR-049, `docs/13` §2.1 | Account-level skills and plugins sync to the desktop every 20 minutes. Plugins install from Git marketplaces or a zip upload. Plugin components include agents and hooks | ER-APP2-048, 049 |
| FR-008 (P2): tray and global hotkey | A global-hotkey capture window offers region or window capture and dictation, started by the user only | ER-APP2-036 |
