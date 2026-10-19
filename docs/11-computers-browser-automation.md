# 11 — Computers & Browser Automation

Agents need a place to act. Nova provides a **Computer** abstraction with three
implementations behind one interface: cloud sandbox, local container/VM, and the user's own
machine (scoped). Browser and screen control are exposed as tools over this substrate.

## 1. The `Computer` interface

```ts
export interface Computer {
  readonly id: string;
  readonly kind: 'cloud' | 'local_container' | 'local_host'; // local_container: also micro-VM

  // Filesystem (all paths are resolved against allowed roots, protected paths and policy)
  fs: {
    read(path: string, opts?: { maxBytes?: number }): Promise<Uint8Array>;
    write(path: string, data: Uint8Array, opts?: { createDirs?: boolean }): Promise<void>;
    list(path: string): Promise<Dirent[]>;
    stat(path: string): Promise<Stat>;
    delete(path: string): Promise<void>;
    move(from: string, to: string): Promise<void>;
  };

  // Process execution (runs under the session's permission profile, FR-190)
  exec(spec: {
    cmd: string; args?: string[]; cwd?: string;
    env?: Record<string, string>; timeoutMs?: number; stdin?: string;
    network?: 'off' | 'limited' | 'allowlist'; // can only narrow the profile's network block;
                                     // 'none' = mode off, 'limited' per docs/12 §8 (FR-193)
  }): Promise<ExecResult & { stream: AsyncIterable<ExecChunk> }>;

  // Browser control (served by browserv)
  browser: BrowserController;

  // Screen control (computer use)
  screen: ScreenController;

  // Persistence
  snapshot(label?: string): Promise<SnapshotRef>;
  restore(ref: SnapshotRef): Promise<void>;
  status(): Promise<ComputerStatus>;   // includes the substrate and any degraded mode
  stop(): Promise<void>;
}
```

All calls pass through the **policy engine** and are audited. The interface is identical for
cloud and local, so tools and tests are substrate-agnostic.

## 2. Implementations

### 2.1 Cloud sandbox

- Managed VM/container per Agent or per cloud Code session.
- Persistent workdir + installed software + browser profile, snapshotted automatically before
  risky operations.
- Works while the user's devices are off (FR-080).
- Network egress restricted to the session's policy through the egress proxy; credentials are
  injected by the proxy and never baked into the image (ADR-063).
- Self-hosting (P2): the same interface served over gRPC by a user-run runner.

### 2.2 Local container/VM

- Rootless **podman** container by default for the container environment.
- Mounts only approved project folders (read-write where the permission profile allows,
  read-only otherwise); protected and credential paths (FR-190) are never mounted.
- Own network namespace; the only reachable destination is the egress proxy (§7).

**Micro-VM substrate (flagged; FR-195, ADR-065).** Off by default, selectable per
environment, and not offered on minimum Hub hardware. The OS sandbox stays the default.

| Aspect | Design |
| --- | --- |
| Hypervisor | Linux: KVM with a minimal VMM. macOS: the system virtualization framework. Windows: the Windows hypervisor platform. |
| Boot | Direct kernel boot (no bootloader or firmware stage) with a small initramfs. Target about 200 ms from start to guest agent ready on reference hardware, tracked in `docs/16` §6. |
| Images | Kernel, initramfs and root filesystem pinned by SHA-256 in a signed manifest shipped with Nova updates; verified before every boot; a mismatch refuses the boot. A new version is staged beside the current one and switched atomically; the previous one is kept for rollback. |
| Disk | Read-only base image plus a per-session writable overlay, discarded at session end unless snapshotted. |
| Shared folders | Only folders connected to the session (virtiofs; 9P over the hypervisor socket on Windows), read-write or read-only per the permission profile. Protected and credential paths are never shared, even when a parent folder or a whole drive is connected. |
| Guest | A small Nova guest agent on a vsock channel runs each command as an unprivileged per-session user, inside the Linux sandbox (§2.5) as a second layer. |
| Network | No host network interface. A user-mode network stack on the host forwards guest traffic only to the Hub-controlled egress proxy (§7), which injects credentials (ADR-063). IPv6 is off. |
| Resources | Defaults: 2 vCPU, 4 GB memory, 8 GB overlay; each VM counts against concurrent sandboxes (§8). |
| Unavailable | Missing hypervisor, failed image check or failed boot: shell tools report unavailable, and file and web tools continue in the read-only degraded mode (§10). Nova never falls back to the host; the user may pick another environment. |

### 2.3 Local host (scoped)

- Used by Code mode "Local" and by an Agent's optional "connected computer" (FR-081).
- Enforced by an OS sandbox under the permission profile (FR-107, FR-190): Linux
  **bubblewrap** with seccomp (§2.5), macOS **seatbelt** (§2.5), Windows **restricted
  write-restricted tokens with per-root capability SIDs** (ADR-064, §2.4). AppContainer is not
  used: it breaks common developer tools.
- Default profile `workspace`: project root read-write, temp read-write, system toolchains
  read-only, everything else denied; protected paths stay read-only or denied
  (`docs/12` §7.2).
- Default network: off. `allowlist` or `limited` goes through the egress proxy (§7).
- The user's personal computer is only connected by explicit consent, one at a time per agent,
  and can be disconnected at any moment.

*As shipped in M6 (ADR-093).* `ComputerService` serves the computers by id
(`/api/v1/computers`). An agent's computer is made on first use, as `computers.agentComputer`
says: `local_container` (the default) is a folder on the Hub,
`<dataDir>/computers/<id>/{home,browser}`, and each command runs in a fresh sandbox over `home`
(its only writable root and `HOME`); the browser profile is never mounted into the sandbox.
Software persists only when installed under home (`pip --user`, npm prefixes, `~/.local/bin`).
`cloud` is a mock runner on the Hub (substrate `cloud_stub`) that keeps its files in a folder and
uses the local sandbox; it does not keep working while the Hub is off. A connected device is a
`local_host` computer served by the devices area: files through staged writes, commands
sandboxed on the device (`docs/23`). Snapshots copy the whole folder (home and browser profile)
to `blobs/snapshots/<computer>/<snapshot>/` and restore swaps it by rename; one snapshot,
restore or stop of a computer runs at a time. The browser and the screen of a computer come from
their areas. Startup marks every computer `stopped` and removes the folders of computers that no
longer exist. Deleting an agent removes its computer, browser session, screen records, desktop and
files. `<dataDir>/computers` is the one part of the data folder besides the workspace that the
gate and the tools' path policy let through; a thread still reaches only its roots.

The agent reaches a connected device's files through its `device.files.*` tools (source
`computer`; `docs/23` §4.1). Listing, reading, staging and discarding are read-only for the gate,
because a staged write changes nothing until it is committed. `device.files.commit` is a `write`
action with the `file_write` effect, so under the default approval policy the owner approves each
commit. The agent can only commit or discard its own staged writes on the connected device.

*As shipped in M7 (ADR-095).* Agent computers still use the mock cloud runner. The cloud runner
(`services/runner`, FR-108) serves Code sessions and Work runs whose environment is `cloud`
(`docs/10`); moving agent computers to it needs the whole `Computer` interface over HTTP (browser
profile, files, snapshots), which is not built.

### 2.4 Windows sandbox detail (FR-107, ADR-064)

Windows support stays behind a flag until the security suite passes on it.

- **Token.** Each sandboxed process gets a restricted token derived from the user's token,
  with maximum privileges removed and the limited-user and write-restricted flags set. A write
  succeeds only if the ordinary access check passes and a second check against the token's
  restricting SIDs also passes. The restricting SIDs are, in order: the capability SIDs of the
  allowed roots, the logon SID, Everyone. Only the traverse (change-notify) privilege is kept.
  The token's default DACL grants access only to the launch's logon SID, so separate launches
  cannot open each other's processes or IPC objects.
- **Capability SIDs.** Random SIDs are generated once and saved in the Nova data directory (a
  protected path): one for the project root, one for read-only access, one per extra working
  directory and one per extra writable root. Folder ACLs grant write only to those SIDs. A
  root's SID is placed in the token only while that root is allowed for the run, so ACL entries
  left by an earlier grant cannot widen a later sandbox. Revoking a root removes its entries.
- **Exclusions.** Sensitive user-profile folders and every protected path never receive
  capability entries, and get explicit deny entries for the sandbox users.
- **Elevated setup (once).** A setup step, run once through the OS elevation prompt, installs
  a provisioning service and creates two hidden local users in a dedicated sandbox-users group:
  an *offline* user (no network beyond the proxy ports on loopback) and an *online* user
  (egress through the proxy). Their random passwords are stored with DPAPI. The service runs as
  the system account, accepts requests only from the Nova supervisor over an ACL'd named pipe,
  never acts on a marker a user can write, and removes the users, ACL entries and firewall
  rules on uninstall.
- **Launch.** A runner helper logs on as the sandbox user and starts the process with the
  restricted token on a private desktop with a random name, so it cannot read or send input to
  windows on the user's desktop.
- **Firewall.** For the offline user a broad outbound block is installed first and then
  narrowed to loopback on the proxy ports. A mode change adds the new rule before removing the
  old one, so no transition leaves a sandbox user with open network (never fails open).
- **Without setup.** A restricted token alone does not confine network, so Nova never runs
  agent commands with the token alone. Until the elevated setup completes, or container mode
  is available, shell tools are unavailable and the read-only degraded mode applies (§10).
- **OS container mode (optional).** When the OS provides a native process-container runtime,
  Nova can use it instead: no ACL edits, no users, no elevation. The child starts suspended
  inside a kill-on-close job object; filesystem rules come from the same permission profile,
  including protected paths; network is loopback-only to the proxy. Once selected it is strict:
  a failure never falls back to another backend.
- **Job objects.** Every process tree runs in a job object with kill-on-close and the limits in
  §8 (process count, memory, CPU rate). Cancelling the run, closing the broker's handle or a
  broker crash kills the whole tree.
- **WSL.** A WSL environment runs inside the distribution under the Linux sandbox (§2.5). WSL1
  is rejected (§2.5).

### 2.5 macOS and Linux sandbox detail (FR-107, FR-141)

**macOS (seatbelt).**

- The sandbox launcher is always invoked by its absolute system path
  (`/usr/bin/sandbox-exec`), never through `PATH`.
- Profiles are deny-by-default. Readable and writable subpaths are generated from the
  permission profile at launch; protected paths are emitted as denials that take precedence
  over writable roots; ancestors of protected paths cannot be unlinked or renamed.
- Mach/XPC service lookups are denied except a fixed list that is part of the hashed profile.
- Network is allowed only to the egress proxy's loopback ports. If the profile expects a proxy
  and none is running, all network is denied (fail closed).

**Linux (bubblewrap).**

- Nova uses a system bubblewrap found outside the project and every writable root; otherwise
  its bundled copy after checking its SHA-256. The resolved absolute path is part of the
  profile hash.
- Every sandbox gets new user, PID, IPC, mount and network namespaces. With network `off` the
  network namespace has only loopback; with `allowlist` or `limited` its only route is a socket
  bridged to the egress proxy. A missing proxy means no route (fail closed).
- Inside, before the command runs, the helper sets no-new-privs and installs a seccomp filter:
  io_uring is denied; with network `off` only `AF_UNIX` sockets can be created; kernel-module
  loading, `kexec` and `bpf` are denied.
- WSL1 is rejected because it cannot create user namespaces; WSL2 takes the normal path.

**Helper process hardening (FR-141).** Sandbox helpers, the egress proxy and `novad` modules
harden themselves at start:

- Linux: not dumpable, core dumps off, `LD_*` variables removed.
- macOS: debugger attachment denied, `DYLD_*` variables removed.
- Windows: crash dumps off, DLL search restricted to the install directory, only explicitly
  passed handles inherited by children.

*As shipped in M6 (ADR-093).* `detectSandbox` (`NOVA_SANDBOX`: `auto`, `docker`, `podman`,
`bwrap`, `microvm`, `off`) picks a container engine first, then bubblewrap on Linux; a forced
substrate that is missing fails closed. **Containers** always run `--network none`, as a non-root
user with every capability dropped, no new privileges, 512 pids and `computers.limits` memory and
CPUs; with network allowed the proxy socket's folder is mounted at `/run/nova/egress` and a Perl
forwarder on 127.0.0.1:3128 is the only route, for Docker and Podman, rootful or rootless; an image
without Perl refuses the command (exit 125). **Bubblewrap** creates every namespace, uses
`--disable-userns` where supported, clears the environment, mounts system folders read-only and
installs a seccomp filter generated in JavaScript (x86-64 and AArch64): io_uring, module loading,
`kexec`, `bpf`, perf events and `userfaultfd` are denied, and without a proxy session only
`AF_UNIX` sockets can be created; memory and CPU time are limited with `RLIMIT_DATA` and
`RLIMIT_CPU` (the CPU-count limit is not applied); a Node forwarder bridges the proxy socket. Both
substrates mount the protected paths (`docs/12` §7.2). Sandboxes trust the system roots plus the
Hub's inspection CA through `SSL_CERT_FILE` and the usual CA-bundle variables. The micro-VM
substrate is a stub: the Hub passes no runner, so it is unavailable. macOS seatbelt and the Windows
token sandbox are not built; on those hosts only a container engine serves. 8 sessions per turn
and 4 MiB of output (head and tail) per session.

## 3. Sandbox broker (`services/sandboxd`)

```
Tool call → Policy allow → sandboxd:
   1. Resolve + canonicalize paths; reject symlink escapes and `..`; apply protected paths
   2. Build the substrate profile (bwrap + seccomp / seatbelt / restricted token /
      OS container / micro-VM) from the permission profile and effective policy
   3. Start the process with resource limits (CPU, memory, wall clock, fds);
      on Windows inside a kill-on-close job object
   4. Route network to the egress proxy (HTTP CONNECT + SOCKS5, DNS pinning,
      allowlist / limited modes, credential injection for allowed hosts)
   5. Pass a minimal environment: no host secrets; proxy and CA-bundle variables only
   6. Stream stdout/stderr; enforce output caps
   7. Record the audit event with the profile hash
```

Guarantees: no host environment leakage, no credentials inside the sandbox (ADR-063), no
out-of-scope or protected-path writes, no unapproved egress, resource limits enforced, a
deterministic, logged profile, and no retry outside the sandbox after a sandbox denial
(ADR-059).

*As shipped in M6 (ADR-093).* There is no separate `sandboxd` service: the substrates run in the
Hub process (`packages/core/src/tools/sandbox*.ts`), the egress proxy too
(`packages/core/src/computers/egress-proxy.ts`), and `threadSandboxRouter` sends each command to
its thread's sandbox (a Code session's environment, an agent's computer, else the Hub sandbox).

## 4. Browser controller (`services/browserv`)

| Capability | Detail |
| --- | --- |
| Launch | Chromium (bundled) with a clean agent profile by default; the user's own browser only through the extension bridge (§4.3) |
| Drivers | Playwright (preferred) with a CDP fallback |
| Navigation | Domain allowlist/denylist checked before navigate; new sites prompt Allow once / Always allow / Deny; per-site permission level (§4.4) |
| Developer-protocol mode | Full DevTools-protocol access for a site is a separate per-site mode: off by default, needs explicit approval, can be disabled by policy (FR-094) |
| Reading | Accessibility tree + DOM summary + visible text (token-budgeted) |
| Acting | Click, type, select, scroll, hover, press keys, upload/download |
| Observation | Screenshots (viewport/full page/element), console logs, network summary |
| Waiting | Selector, network idle, text, timeout |
| Sessions | Per-computer profile; cookies persisted only if enabled; login state is never imported from the user's browsers (ADR-080) |
| Safety | Write actions checked by the page-action classifier (FR-095) and, per the site level, the auto-reviewer (`docs/12` §6.1); confirmation tiers apply (FR-189); sensitive actions require the user |

Nova does not copy cookies, passwords or login state out of the user's browsers into an agent
profile (ADR-080). The user's real sessions are reached only through the extension bridge with
per-host grants (§4.3).

### 4.1 Sign-in flow (FR-086)

When a site needs credentials:

1. The agent requests a sign-in; the app shows a **private form** (outside the model context).
2. The user enters credentials; they are sent to the remote browser, never to the model.
3. Optional **Save to Passwords** stores them in the keychain (per-site, confirmed on reuse).
4. An **active session** is distinct from a **saved login**: a valid session needs no re-auth;
   reusing a saved login to start a new session requires confirmation.
5. CAPTCHAs and MFA are always completed by the user; the agent waits (`handoff_required`).

### 4.2 Takeover (FR-087)

The user can open the agent's computer/browser, take over mouse/keyboard ("Take over"), and
return control ("Return control"). Takeover is logged, and the agent pauses while the user
has control. The agent can request a browser handoff when it hits a wall.

### 4.3 Extension bridge (FR-096, P1)

For tasks that need the user's real logged-in sessions, an optional browser extension
connects the user's own browser to the agent. It is separate from the clean agent profile.

- **Transport.** The extension talks to a native-messaging host that Nova registers only when
  the user enables the bridge (`docs/12` §15). The host connects only to the local `novad`
  over its authenticated socket or pipe, and `novad` uses its existing Hub connection. No
  third-party relay is involved.
- **Per-host grants.** Each host (for example `github.com`) is granted separately by the user.
  "All sites" is a separate grant labelled elevated risk, with its own confirmation, and can be
  disabled by policy.
- **Per-tab consent.** The agent acts only in tabs the user shared or that it opened in its own
  tab group; a visible indicator marks every controlled tab.
- **History** access is asked for every time; there is no standing grant.
- The bridge never exports cookies, passwords or tokens; the agent acts through the page.
- Every action passes the policy engine with the site's permission level (§4.4) and the
  confirmation tiers. Managed policy can disable the bridge (`browser.extensionBridge`).

*As built in M7.5 (ADR-096; `apps/extension`, `packages/core/src/browser/bridge*.ts`,
`device-link.ts`, `apps/hub/src/browser.ts`; novad's host and relay in `docs/23` §4).* The bridge
is built for Chromium-family browsers on Linux and macOS devices. Agents reach it in two ways only:
the "my own browser" choice of the local browser fallback (§4.6) and the `browser.history_search`
tool. No other agent tool acts in the user's browser.

- **The extension.** `apps/extension` is Nova's own Manifest V3 extension ("Nova Bridge", Chromium
  116 or later): our own code, and an icon drawn by `scripts/icons.mjs`. `npm run build` writes
  `apps/extension/dist`, which the user loads unpacked. Permissions: `nativeMessaging`, `tabs`,
  `tabGroups`, `debugger` and `storage`; `history` is optional, and so is host access
  (`<all_urls>` as an optional host permission, requested one site at a time). There is no
  `cookies` permission. The popup shows whether Nova is connected and shares the current tab;
  sharing first asks the browser for that one site, in the user's click. Tabs the agent opens are
  blank tabs in a tab group named "Nova". Every shared or agent tab carries a "NOVA" badge, and a
  tab the agent controls also shows the browser's own debugging banner (`chrome.debugger`).
  Cancelling that banner, closing the tab or "Stop sharing" ends the tab's consent at once. The
  extension keeps its consents in the browser's session storage, so they end when the browser
  closes.
- **Transport.** The extension talks to novad's native-messaging host `ai.nova.bridge` (a 4-byte
  length plus JSON, at most 1 MiB a message). Only `novad bridge enable`, run by the user,
  registers it, for the one extension id in novad's `bridge.extensionId` (`docs/12` §15). The host
  relays to novad over a per-user socket with a per-user token. The Hub calls
  `POST /agent/v1/bridge/call` with the management token (mutual TLS where the device has a
  certificate, `docs/23` §9), and novad posts the bridge's events to `POST /agent/v1/bridge/events`
  with its device credential, like a heartbeat, at most 100 per post (`contracts/hub-api.md`). The
  Hub checks each event on its own and answers `{accepted, refused}`; refused ones are audited
  (`browser.bridge.events.refused`). Without a connected host novad answers 409 `bridge_offline`.
  One host is connected at a time: a newer one from the same OS user replaces it, and a host of
  another OS user is refused (`bridge_busy`) until the first one leaves.
- **Status.** Connected or not, the extension's version, the browser, the OS user and the shared
  tabs come only from those events and live in Hub memory (`GET /api/v1/devices/:id/bridge`).
  After a Hub restart a device counts as disconnected until novad reports again. After every
  reconnect the extension reports its shared tabs, the tabs the agent opened and the sites the
  browser allows again. A `connected` while connected counts as a disconnect: the tab consents go,
  fallback sessions in the user's browser stop, and it is audited `browser.bridge.replaced` with
  the OS users before and after.
- **Per-host grants.** Owner-only rows (`browser_bridge_grant`, 0043) under
  `/api/v1/devices/:id/bridge/grants`. A grant names one exact host, never a pattern or an address,
  and covers that host and its `www.` twin; a subdomain needs its own grant. When the browser
  reports its permission for a host (`host.granted`), the Hub records a `pending` grant; only the
  owner's confirmation makes it `active`, and only active grants count. "All sites" (host `*`) is
  a separate grant: creating or confirming it needs `acknowledgeElevatedRisk: true` besides
  `confirm: true`, and with `browser.extensionBridgeAllSites` off it is refused and an existing one
  counts for nothing. When the browser withdraws its permission (`host.revoked`) the grant records
  it and the extension unshares the tabs on that site. Revoking a grant in Nova does not remove the
  browser's permission, but the Hub then refuses that host. Grants are audited with before and
  after (`browser.bridge.grant.created`, `.grant.all_sites`, `.grant.revoked`); a revoked device
  loses its grants.
- **The Hub's own hosts are never granted**, "all sites" included: loopback names, its OS and mDNS
  names, the configured listen host and extra origins, the Direct public and Relay hosts, the host
  of `channels.publicUrl`, every interface address, and their subdomains. A grant for one is refused with 403 `policy_denied`
  `{reason: hub_host}`, and when the list cannot be read every host counts as the Hub's (fail
  closed).
- **Per-tab consent.** The agent acts only in a tab the user shared (`tab.shared`) or one it opened
  in the Nova group, and only in the browser of the OS user connected now. Each tab records that
  user, a tab of another user is refused, and the fallback's tab driver pins the user at launch
  (`user_changed`). `tab.unshared` and `tab.closed` end the consent.
- **What a call may do.** The Hub checks every call before it goes out, and the extension checks
  it again. Methods: `tabs.list`, `tabs.open` (a blank tab only; the Hub then navigates it through
  its own checks), `tab.attach`, `tab.detach`, `cdp.send` and `history.search`. `cdp.send` carries
  only six DevTools methods (`Runtime.evaluate`, `Input.dispatchMouseEvent`,
  `Input.dispatchKeyEvent`, `Input.insertText`, `Page.navigate`, `Page.captureScreenshot`), on a
  consented, attached tab whose host has an active grant (for `Page.navigate`, the target's host).
  Every `cdp.send` names the host it was checked for (`expectHost`; null only for about:blank,
  which is checked against the session's site). The extension refuses with `host_changed` when the
  tab is on another host now, a pending navigation included, and also needs the browser's own
  permission for the host.
- **Page scripts and keys.** `Runtime.evaluate` never carries an expression. It names one of the
  extension's 13 page scripts (`apps/extension/src/scripts.ts`; the page reader is the Hub's own),
  which the extension builds and wraps so it returns nothing on another host. Key and mouse events
  may hold only Shift: Control, Alt, Meta and editor `commands` are refused, so the user's
  clipboard is never pasted, copied or cut. After each action the driver waits up to 10 s for a
  navigation to commit and follows the tab only onto an allowed, granted site; anywhere else it
  refuses everything but a navigation back.
- **Never in the user's own browser:** cookies, passwords or storage (nothing is read, carried or
  saved), developer-protocol scripts, page tools, downloads, uploads and takeover input. Page
  actions still pass the browser controller's site lists, levels, classifier and gate (§4.4,
  FR-095). A refused call is audited `browser.bridge.refused` with its reason; attaching,
  detaching and the tabs the agent opens are audited too.
- **History.** `browser.history_search` (`query` up to 200 characters, `maxResults` 1 to 50,
  default 20) is listed only in an agent's threads whose connected computer was given its browser,
  while `browser.extensionBridge` is on and the bridge is connected. For every search the
  extension opens its own prompt; only the user's "Allow this search" asks the browser for the
  `history` permission, which the extension removes right after. The prompt waits 110 s, the Hub
  120 s. Results are titles, hosts and last visits only, never full addresses, labelled untrusted.
  The gate sees the tool as a read: the consent is the user's click in their browser. Each search
  is audited `browser.bridge.history.search` with the device as its resource and the query's
  length only.
- **Settings and UI.** `browser.extensionBridge` (default on, `security: true`, lockable by managed
  policy) off refuses every call and every new grant and hides the history tool;
  `browser.extensionBridgeAllSites` (default on) governs the "all sites" grant. Both are in
  Settings → Browser. A device's page has a "Browser bridge" section: the status and shared tabs,
  confirming, refusing, adding and revoking grants ("all sites" needs its own tick box), the
  device's history searches, and the setup steps.

Not built: a bridge on Windows (no named pipe, no registry manifest); a pinned extension id (the
manifest has no `key`, so the owner sets novad's `bridge.extensionId` from the unpacked id); a
store listing of the extension.

### 4.4 Per-site permission levels (FR-094)

| Level | Write actions on the site |
| --- | --- |
| **Always ask** (default for a newly allowed site) | Every write action asks the user. |
| **Auto approve with review** | Run when the page-action classifier (FR-095) and the auto-reviewer (`docs/12` §6.1) both pass; a flag or a reviewer `ask` goes to the user. |
| **Always allow** | Run when the page-action classifier passes; flagged actions ask. |

At every level the site must pass the domain lists, the confirmation tiers apply (FR-189), and
results are untrusted. Levels are per site and per scope, listed and revocable in Settings.

*As shipped in M7 (ADR-095; `packages/core/src/browser/sites.ts`).* An allowed site can have its
own level for one project or one agent besides its level for the whole account. The narrower scope
wins: the agent's level, then the project's, then the account's. A call's project and agent are
read from the database (the nearest along its parent threads, so a sub-agent's thread counts as its
parent's), never from tool arguments; when they cannot be read the action is denied.

- **Storage.** Each scoped level is a `browser_site` row with the composite key
  `<pattern>|<kind>:<ref>` (no new table), with its own site-scoped policy rule on the tool name
  `browser.act:<kind>:<ref>`. The project or agent must exist in the account.
- **Enforcement.** Before a write under a scoped level, a policy preview runs under `browser.act`.
  Only when nothing but the site's own account-level rule (or a built-in floor) would decide is the
  write matched under the scoped name; a managed rule, a deny or any other rule on `browser.act`
  keeps the normal check, so a narrower level never sets aside more than the account level. A
  preview that fails denies the action (fail closed).
- **What sees the scoped name.** It travels in the policy context's `ruleTool`, which only the
  policy engine's rule matching reads (`packages/policy/src/engine.ts`). Hooks, tool limits, the
  approval card, audit and events still see `browser.act`. On an Auto approve with review site the
  escalation after a reviewer `ask` drops `ruleTool`, so a scoped Always allow cannot answer it.
- **Removal.** A blocked site has no levels: blocking or removing a site, also through the domain
  lists, removes its scoped levels. Deleting a project or an agent removes its levels and their
  policy rules (the browser area hears `project.deleted` and `agent.deleted`), audited as
  `browser.site.level.removed` with actor `system` and `{scopeKind, scopeRef, count, reason:
  project_deleted|agent_deleted}`.
- **API and UI.** `GET /api/v1/browser/site-levels` (filters `scopeKind`, `scopeRef`, `pattern`),
  `PUT` and `DELETE /api/v1/browser/sites/:pattern/levels/:scopeKind/:scopeRef`, audited as
  `browser.site.level.set` and `browser.site.level.removed`. Settings → Browser edits them per
  site; a project's page and an agent's computer tab edit that scope's level for each allowed site.

### 4.5 Page-registered tools (FR-208, P2)

- A page loaded in an agent browser may register tools (name, description, input schema)
  through an in-page model-context API (for example the WebMCP proposal). Only the top-level
  frame may register; registrations from iframes are ignored.
- Registered tools are namespaced by the origin's host (`page:<host>.<name>`, the pattern in
  `contracts/schemas/tool-descriptor.json`), appear in the trace, and are dropped when the
  browser leaves that origin.
- Every call passes the policy engine and is reviewed like an external write (FR-095).
  Annotations the page declares are hints and never lower a tier. Results are untrusted.

### 4.6 Local browser fallback (FR-209)

- When a site blocks an agent's own browser (block pages, repeated bot challenges), an agent
  with a connected computer (FR-081) may continue on that computer's browser after the user
  consents for that site.
- The user chooses a clean profile on that computer, or their own profile through the extension
  bridge (§4.3).
- The session is marked "local fallback" in the trace and audited; the per-site consent is a
  revocable grant. Egress from the clean profile goes through that device's egress proxy.

*As built in M7.5 (ADR-096; `packages/core/src/browser/fallback.ts`, `blockpage.ts`,
`device-launcher.ts`, `device-link.ts`, `service.ts`, `apps/hub/src/browser.ts`; novad's `browser`
module and egress filter in `docs/23` §4).* The agent's browser on the Hub hands a site over to its
connected computer's browser.

- **When it is offered.** After `browser.navigate` or `browser.read` on the agent's own browser. A
  block page offers at once: HTTP 401, 403, 405, 406, 429, 451 or 503 with words of a refusal, or
  any 429. A bot challenge (a CAPTCHA widget, challenge words, a CAPTCHA title) offers only when it
  is seen a second time on the same site within 10 minutes, so the first one stays the user's to
  solve (§4.1); reading the page a navigation already counted does not count again. Never for a
  local or private site (`localhost`, `.local`, `.internal`, a single-label name, a private
  address), nor for a name novad's egress filter would refuse. What is detected comes from the
  page, so at worst a page makes Nova ask; the user decides.
- **Who can use it.** `browser.localFallback` is on (default on, `security: true`); the browser
  belongs to an agent's computer; the agent has an active connection to a device (FR-081) that
  was given `browser` among its capabilities; the device's capability document offers the
  `browser` module; and the device is active with a management endpoint. Otherwise the agent's
  result says why, and the refusal is audited `browser.fallback.refused` (`disabled`,
  `no_connected_computer`, `no_browser_module`, `device_unreachable` and others).
- **The offer.** A question to the user (a `user_input` server request tied to the call, FR-188),
  never something a model answers. It needs a thread and waits 10 minutes; there is one offer at a
  time per computer and site. Choices: "Continue on <device> (clean profile)", "Continue in my own
  browser on <device> (extension)" only while the bridge can serve the site (switched on,
  connected, an active grant, §4.3), and "Not now". The text says that the clean profile starts
  empty and reaches only the site and its subdomains, that in the user's own browser the agent acts
  only in a tab it opens or one they shared, that the session stops when the agent leaves the site,
  and that the choice is remembered until revoked. The payload also carries a `context`
  (`{kind: 'browser.fallback', site, deviceId, deviceName, cause, choices}`, each choice
  `{id: clean|extension|decline, label, profile}`) so a client can show the offer as its own card;
  the answer is still `{choice: <label>}`. The offer is audited `browser.fallback.offered`; no
  answer, a cancel or "Not now" leaves the agent's browser where it was.
- **Consent.** Accepting records a revocable consent per agent, device and site with the chosen
  profile (`browser_fallback_consent`, 0043; one live consent per scope, device and site; audited
  `browser.fallback.consent.granted` with before and after). The next block on that site continues
  without asking (`browser.fallback.consent.used`), except that an extension consent asks again
  while the bridge cannot serve the site. `GET` and `DELETE /api/v1/browser/fallback/consents`
  list and revoke consents (Settings → Browser, "Continue on your computer"); revoking stops a
  session running on it. Revoking a device revokes its consents, which ends its sessions. The table
  also takes a thread scope, which nothing uses yet.
- **The clean profile.** novad launches a headless Chromium (the Hub never asks for a visible one)
  with a fresh temporary profile that is deleted when the session closes; a root novad runs it as a
  dedicated unprivileged user (`docs/23` §4), and at most 2 sessions run on a device. The Hub
  drives it with Playwright's `connectOverCDP` through a relay on its own loopback
  (`ws://127.0.0.1:<port>/<random path>`, one connection). The relay opens the device's management
  connection (TCP, or mutual TLS with the Hub's client certificate where the device has a
  certificate; an https device never gets plain HTTP), sends the WebSocket upgrade to
  `/agent/v1/browser/cdp/<sessionId>` with the management token and only the WebSocket headers,
  and then pipes bytes. So the management token and the TLS client certificate never reach
  Playwright. novad answers the WebSocket itself and talks to Chromium over a pipe, so the browser
  opens no DevTools port. The Hub refuses a launch answer that names another session or path. The
  browser context gets the same request guard, page-tools binding and capture as the Hub's own
  browser; downloads are off (the download tool refuses), and no cookies are saved.
- **Egress.** Each clean-profile session has its own egress filter in novad, its browser's only
  route; the Hub's proxy is not used (§7). The allow list the Hub sends is exactly the site and
  `*.site` (never a wildcard over a top-level domain, never an address), so other allowed sites
  are not reachable from the device. The filter takes ports 80 and 443 only, resolves names itself
  and refuses private, loopback, link-local and other non-public addresses (the device's LAN is not
  the site), does no TLS inspection, and reports how many requests it allowed and refused when the
  session closes; the counts are kept on the session.
- **The session.** The agent's browser on the Hub closes and the device's browser takes its place
  for that site (element refs from before are stale), then opens the page again. The session ends
  when the agent leaves the site: a navigation elsewhere, or a click, key or redirect that takes
  the page off the site; the agent's own browser then opens the other site. Sessions are
  `browser_fallback_session` rows with the profile, the cause, the consent, the OS user for the
  extension profile, the end reason and the egress counts (`GET /api/v1/browser/fallback/sessions`,
  `computerId`, `limit` 1 to 200, default 50; event `browser.fallback.changed`).
- **End reasons.** `closed`; `left_site`; `consent_revoked`; `device_gone` (the agent's connection
  to the device ended or, for the extension profile, the extension disconnected); `error`
  (the device's browser could not start: the tool answers `browser_unavailable` and the agent
  browser stays closed until the site is opened again); `disabled` (`browser.localFallback` turned
  off: at once, or at the latest at the next action); `restarted` (at start the Hub ends the rows a
  previous run left open).
- **Trace and audit.** The start and the end are `browser.fallback` trace rows (`local_fallback`,
  `local_fallback_end` with the reason). Every action in between is linked to the session
  (`browser_fallback_action`), and each item of `GET /api/v1/browser/actions` carries
  `localFallback: {sessionId, deviceId, profile}` or null. The browser panel says the agent is
  working in the device's browser while a session runs, and the trace rows carry a badge. Actions
  pass the same site lists, levels, classifier and gate as on the Hub. Audit:
  `browser.fallback.offered`, `.consent.granted`, `.consent.used`, `.consent.revoked`, `.started`,
  `.ended`, `.refused`, `.failed` and `.orphan_closed`.
- **Leftovers.** When the devices area binds at start, and every 15 minutes, the Hub lists each
  active managed device's browser sessions (`/agent/v1/browser/list`) and closes those it does not
  run (`browser.fallback.orphan_closed`). novad closes a session with no DevTools client after 10
  minutes, and every session after 4 hours.

Not built: asking for the fallback by hand (the service's `localFallback` has no route or tool, so
the `requested` cause never occurs); a visible browser on the device; browser users made by novad
on macOS (the owner creates two unprivileged users and sets `browser.runAs`; novad makes them only
on Linux, as root).

Known limits: novad's tests use a fake Chromium (the Hub side ran against a real one in the
Playwright container), and WebRTC traffic policy and LAN discovery were not checked against a real
Chromium. On a kernel without unprivileged user namespaces Chromium's sandbox does not start
(`browser_start_failed`). DevTools sessions an earlier Hub connection opened inside Chromium stay
attached after a reconnect.

*As shipped in M6 (ADR-093).* The browser controller runs in the Hub on `playwright-core` (loaded
lazily), with headless Chromium from `browser.executablePath` or Playwright's install; there is no
`browserv` service and no bundled browser. One browser per computer (a thread without an agent
computer uses `thread-<threadId>`), at most `browser.maxConcurrent` open. Each launch starts from a
fresh temporary profile; cookies are kept (sealed `state.json`) only with `browser.persistCookies`.
Each browser has its own egress proxy session in the Hub's `network.egressMode`, whose allowlist is
the allowed sites (each also as `*.site`), `network.egressAllow` and the allowed-once host; a newly
allowed site relaunches it with its cookies; resources from other hosts are blocked and
`browser.read` says which; service workers are blocked. Without the proxy the browser stays closed.
A Code session's dev server (`docs/10` §7) is the one loopback address a browser may load: its grant
covers exactly the bridge's host and port (`browser.devserver.granted`, `.revoked`;
`browser.allowLocalSites` stays off), and the browser pane opens it as the user's action (tool
`devserver.open` in the action trace). Tools: `browser.navigate`, `read`, `click`, `type`, `select`,
`press`, `scroll`, `wait`, `back`, `screenshot`, `download`, `upload`, `sign_in`, the
developer-protocol `browser.evaluate` (listed only while a site has the mode on and
`browser.devProtocol` allows it) and page tools `page:<host>.<name>`. The runtime's gate sees the
browser tools as read-only; the service checks each action itself with `browser.site` (the new-site
prompt: Allow once for the visit, Allow for this chat, Always allow, which adds the site at Always
ask, Deny) and `browser.act` (every page write with the classifier's effect classes and the page as
its source, so purchases, sign-ups and deletions are confirmed when they happen; CAPTCHAs, security
changes and verification codes hand off). Site levels (§4.4) are one user rule per site on
`browser.act`; on `auto_review` sites an action the gate allowed without a card goes to the
auto-reviewer, which can only tighten (`browser.act.review`); levels are per account, not per scope,
in M6 (M7 adds levels per project and agent, §4.4). The agent never types a password (it uses
`browser.sign_in`; the private form waits 15 minutes in Hub memory and fills the page; **Save**
stores the login in the vault, and reuse needs the user to pick it). Data sent to a page signed by an external agent is denied unless the user
named it (FR-194). Every action is recorded with sealed before and after screenshots (§9). Page
tools: only the top frame, the current origin, at most 20, annotations ignored. Not built in M6:
console and network capture, hover, element screenshots and the restart after a crash (all built in
M7, below), the extension bridge (§4.3) and the local browser fallback (§4.6; M7.5 built both, see
the notes in those sections).

With `browser.allowLocalSites` on, the agent browser may open a site on the local network (a
test site, a router page) when the owner allowed that site by its exact name: the browser's proxy
session lists those names in `localHosts`, and the proxy lets them resolve to private or loopback
addresses. A wildcard site never does, and every other private address stays blocked.

*As shipped in M7 (ADR-095; `packages/core/src/browser`, `apps/hub/src/browser.ts`).* The browser
gains four tools, console and network capture, levels per project or agent (§4.4) and a restart
after a crash (§10).

- **`browser.hover`** moves the pointer over an element by ref (menus and tooltips that open on
  hover). It goes through the page-action classifier like every page action and counts as passive,
  so it never asks; hovering a CAPTCHA widget still hands off to the user. It is recorded with
  before and after screenshots.
- **`browser.screenshot`** takes an optional element `ref` from the last `browser.read`. The image
  is sealed like the trace screenshots and kept as an image artifact.
- **`browser.console`** returns the page's console messages and uncaught errors: the newest
  `limit` (1 to 200, default 50), oldest of them first. `levels` keeps some of `error`, `warning`,
  `info`, `log` and `debug`; `after` skips entries up to that `#n`.
- **`browser.network`** returns the page's requests: method, address, outcome (status, failure, or
  blocked by the browser's guards), type, size and time. `contains` filters by address,
  `failedOnly` keeps failures and statuses of 400 and up, `details` adds headers and captured bodies
  (up to 4,000 characters each), `limit` is 1 to 100 (default 30), and `after` works as for the
  console.
- Both capture tools read the running browser and never start one; their output is at most 20,000
  characters.

**Capture.** Each browser session keeps up to 300 console entries and 300 requests, in memory only.
The oldest are dropped first (the output says how many), nothing is stored, and the buffers go when
the browser closes. Everything is redacted when it is recorded, before the agent or the user can
read it:

- Every page-supplied value is clipped to twice its cap before it is redacted, then clipped to the
  cap: a console message 2,000 characters, a URL 2,000, a header value 300, status text 100,
  failure text 200, at most 40 headers per request. The trace recorder does the same, and the
  redactor's own patterns are bounded (`packages/security/src/redact.ts`), so a hostile page
  cannot stall the Hub's event loop.
- One normalised test, `isSecretName`, decides header names, query keys, JSON keys, and
  `key=value`, `key: value` and `"key":"value"` pairs in text bodies and console messages. The
  name is decoded, lower-cased and stripped of separators, then searched for parts such as
  `token`, `secret`, `passw`, `session`, `csrf`, `cookie` and `authoriz`; short words such as
  `otp`, `pin`, `code`, `key` and `sid` count only as whole words. So Cookie, Authorization and
  Set-Cookie values never show, nor do token-like headers such as `X-CSRFToken`.
- URL-valued headers (Location, Referer, Content-Location, Origin, Refresh, Link) are redacted as
  URLs, and a relative Location stays relative. Every URL loses its credentials and fragment, and
  secret-looking query values are masked one parameter at a time.
- JSON is masked by key, also behind an anti-hijacking prefix (`)]}'`, `while(1);` and the like),
  inside a JSONP callback, and when served as another text type. A CSRF value in a `<meta>` tag or
  a hidden `<input>` is masked.
- Request bodies are never captured. A response body is kept only for text types up to 16 KiB: a
  larger declared Content-Length is not read; without a Content-Length the body is read only after
  the request finished and only when its received size is under the cap; `text/event-stream` is
  never read. At most 6 bodies are read at a time.
- The session's redactor also masks the password filled through the private sign-in form (§4.1)
  in its raw, URL-encoded, form-encoded, JSON-escaped, HTML-escaped and base64 forms, short values
  included. Text the user types into a focused password or one-time-code field during a takeover
  (§4.2) is registered as a secret the same way once it reaches 4 characters. The redactor
  inherits the Hub's own literals, and the output is masked for literals once more on the way out.
- What the agent reads is labelled page content and scanned for instructions (FR-103): console
  text and source URLs, request URLs, status text and failure text, and with `details` the headers
  and bodies. A finding is noted in the result and audited once (`browser.injection_suspected`,
  `detail.source` `console` or `network`).

For the user, `GET /api/v1/browser/sessions/:computerId/console` and `.../network` (`limit` 1 to
300, default 100) return the same redacted capture as `{items, dropped}`, or 404 when no browser is
open. The browser panel shows them as text in Console and Network tabs, with level, address and
failed-only filters.

**Trace (FR-098).** `GET /api/v1/browser/actions` lists newest first, `limit` rows at a time
(default 100, at most 500), with an opaque `nextCursor`; a cursor the Hub did not make is refused
with 400. The trace in the browser panel pages with "Show older" and shows the crash and restart
rows of §10.

**Other people on the Hub (FR-217).** `browser.allowLocalSites` is ignored for anyone but the Hub
owner. A member's allowed sites reach the network only where `network.egressAllow` already covers
them, so their site allow rows can only narrow the Hub's list. A member holds at most half of
`browser.maxConcurrent` (at least one) and makes room only by closing their own least recently used
idle browser; the owner may also close another account's idle browser. A browser without a computer
from the computers area keeps its profile and files under
`browser/{profiles,files}/<account>/<computer>`, so fallback ids (`thread-<threadId>`) of different
people never share a folder.

Known limits: opaque tokens in URL paths (password-reset and sign-in links) are not masked. The
computers-area controller (`BrowserController` in `packages/core/src/computers/types.ts`) has no
hover, so hover exists only as an agent tool. The capture caps are constants, not settings.

## 5. Screen / computer use (FR-093, FR-207)

- `screen.observe` returns a screenshot + accessibility tree (UI Automation on Windows, the
  accessibility API on macOS, AT-SPI on Linux), preferred over pixels.
- `screen.click` / `screen.type` / `screen.key` act on a controlled desktop (container VM or
  the local host with consent); coordinates are validated against the last observation.
- Enabling local computer use requires an explicit toggle, the OS permissions (accessibility,
  screen recording) and, on first use, a confirmation.
- Every action is recorded in the Activity trace with before/after screenshots (FR-098).

### 5.1 Control tiers

| App class | Tier | Allowed | Use instead |
| --- | --- | --- | --- |
| Browsers | view | observe only | the browser tool (§4) |
| Terminals, code editors, IDEs | click | observe, left click, scroll | shell and file tools |
| Other apps | full | observe, click, type, keys, drag | — |
| System settings, password managers, keychain and credential UIs, security software, banking and payment apps | none | nothing; handed off by built-in safety | the user |

- The `novad` screen module classifies apps by verified identity (bundle id or executable path
  plus signature) against a shipped list. Users and managed policy can lower a tier; nothing
  raises a browser, terminal or editor above its class tier.
- The frontmost app's tier is checked before every input event. A forbidden event is refused
  with a structured error that names the tool to use instead.

### 5.2 Grants, kill key and indicators

- **Grants are per app.** The agent requests a list of apps and the user approves each. A grant
  lasts 30 minutes by default (`docs/12` §4.2), is renewable from the indicator, and can be
  revoked at any time.
- **Kill key.** A global key (Esc by default, configurable) stops control instantly: queued
  input is dropped and the run pauses until the user resumes it.
- **Indicator.** While control is active, an indicator and an edge highlight on the controlled
  display are always shown, with the kill-key hint and a stop control.
- **Hide own window.** Nova hides its own windows before acting and before each observation, so
  the agent never acts on Nova's UI and screenshots do not include it.
- **Clipboard guard.** The user's clipboard is saved before the agent uses it and restored
  afterwards. Reading the clipboard is a separate permission, and its content is untrusted.
- **Masking.** Password fields, excluded apps and sites (`docs/24` §9.1–9.2) and notification content
  are masked in observations before they leave `novad`. If masking fails, the observation is
  refused and no action is taken on it (fail closed).

### 5.3 Precedence and safety

- **Tool precedence**: connectors (MCP/plugin APIs), then shell, then the browser tool, then
  computer use. The runtime offers tools in this order, and the view tier enforces it for
  browsers.
- **Confirmation tiers** (FR-189) apply to every action: confirming a purchase in any app is
  `confirm_at_action`; the final step of a credential change is handed off.
- Screen content is untrusted input (FR-103) and never counts as user intent.

*As shipped in M6 (ADR-093).* Computer use runs on the Hub, which enforces tiers and grants
(`/api/v1/computers/:id/screen`, `takeover`, the live WebSocket). Only `cloud` computers have a
controlled desktop, a mock desktop on the Hub; real desktops wait for `novad`'s `screen` module, so
hiding Nova's window, the clipboard guard and masking (§5.2) are not built (a failed mask is
refused, tested against the mock). Computer use is off until enabled per computer. The tier is the
lowest of the controller's, a name check and `screen.tierOverrides` (overrides only lower); each
receiver window and the focused window are checked before every input; click tier allows left
click and scroll; a refusal is a tool error (`screen_tier`, `screen_handoff`) naming what to use
instead. Grants are per app, made only by the user (`screen.request_access` asks and grants only
on the user's answer), `screen.grantMinutes` long, and needed only for apps that receive input.
Actions need an observation at most 120 s old and points inside the screen and inside a window
when geometry is known; `screen.observe` is limited to one per 2 s. The kill key (in the web app,
`screen.killKey`) aborts the input in flight, kills and drops the controller handle, refuses queued
input and stores a stop that survives a restart until the user resumes; it pauses the agent using
the computer and its browser. A takeover aborts the agent's input in flight, pauses the agent (its
running turn is cancelled) and its browser, and needs the agent to observe again after control
returns; takeovers a restart left open are closed. Every agent action, refusals included, is
recorded (`screen_action`) with encrypted before and after screenshots when it reached the
capture step; typed text is stored as its length only. Tools: `screen.observe`, `click`, `type`,
`key`, `scroll`, `drag`, `request_access` and `appshot.capture`, source `computer`, listed last.
Purchases and other confirm-at-action steps on screen actions are not classified yet: the policy
engine treats them as plain writes.

## 6. Appshots (FR-075)

`appshot.capture` records a window/screen region plus metadata (app name, window title,
timestamp) as an artifact for debugging. Captures are local, redact known-sensitive regions
when possible, and are subject to retention policy.

*As shipped in M6 (ADR-093).* An appshot crops a window out of the screen (or keeps the screen,
or screenshots the agent browser's page) and saves it as an `image` artifact plus a
`screen_appshot` row with the app, window title, URL and size. Appshots are artifacts and are not
pruned with action screenshots; nothing redacts regions yet.

## 7. Network policy

`docs/12` §8 is the normative rule set (FR-102, FR-193). This section covers how each
substrate connects to it.

- **Deny by default** for agent execution. Modes: `off`; `allowlist` (deny entries win; a bare
  `*` is rejected); `limited` (only `GET`/`HEAD`/`OPTIONS`; HTTPS that cannot be inspected is
  blocked).
- **Routing.** OS sandbox: the proxy's loopback ports (seatbelt, Windows firewall) or a socket
  bridged into the network namespace (Linux). Container: its own network namespace with only the
  proxy reachable. Micro-VM: the host's user-mode network stack forwards only to the proxy.
  Cloud: the same proxy inside the cloud runner. If a proxy is expected but missing, network is
  denied.
- Grants are per-scope: `run`, `session`, `agent`, `plugin`, `mcp-server`. A user-visible list
  shows allowed destinations; a new destination triggers an approval (if the approval policy
  asks) or a denial.
- The proxy resolves DNS itself and pins the address; hostnames that resolve to private,
  loopback, link-local or the other non-public address classes in `docs/12` §8 are blocked
  unless the profile allows local binding and a dev-server grant covers them.
- Credentials for allowed hosts are injected by the proxy (ADR-063); credential-stripping hooks
  can remove credentials from matched requests. SOCKS5 serves non-HTTP clients.
- A blocked request gets 403 with a cause header; every decision writes a structured audit
  event (method, host, status, cause; bodies not stored by default). Tracking headers are
  stripped.

*As shipped in M6 (ADR-093).* The proxy runs in the Hub, one session per command with its policy
fixed when it opens (`docs/12` §8). Routing: containers and bubblewrap reach it only through the
session's Unix socket (owner-only); host-side clients use a loopback port that needs the
session's token. Scopes `run`, `session` and `agent` are applied (an agent's commands use the
agent's scope); `plugin` and `mcp_server` policies are stored but nothing runs under them yet. The
agent browser's session follows `network.egressMode` (`off`: no network, `limited`: reads only)
but no scope policy. Container environments' sandboxes (`docs/10` §2) use the proxy too. A dev
server's port leaves its sandbox only through the dev-server bridge to the Hub's loopback, which
only the granted browser's proxy session may reach. SOCKS5 is not built. `network.egressAllow`
and `network.egressDeny` take the proxy's own host patterns (at most 500 each); a stored list
that fails them resolves to the default (none). `web.fetch` and MCP servers still run outside the
proxy, in the Hub process and unsandboxed.

*As built in M7.5 (ADR-096).* The browser of a local fallback session (§4.6) runs on the
connected computer and does not use the Hub's proxy, so `network.egressMode` does not apply to it
(its `limited` read-only mode included). A clean profile's only route is novad's per-session egress
filter: exactly the site and its subdomains, ports 80 and 443, public addresses only, names
resolved by novad, no TLS inspection; the browser's own request guard still applies the site lists.
The user's own browser (§4.3) keeps the user's network: the bridge limits where the agent acts
(granted hosts, consented tabs), not what the page loads.

## 8. Resource governance

| Resource | Default cap |
| --- | --- |
| CPU per sandbox | 2 cores |
| Memory per sandbox | 2 GB |
| Memory per micro-VM | 4 GB |
| Wall clock per exec | 5 min (configurable) |
| Concurrent sandboxes (including micro-VMs) | 4 |
| Concurrent browsers | 2 |
| Disk per cloud computer | 10 GB |
| Screenshot rate | 1 per 2 s |

Exceeding a cap returns a structured error and is logged; runs can request an increased cap
with user approval.

*As shipped in M6 (ADR-093).* `computers.limits` sets CPU and memory for every command (read when
the Hub starts) and a wall clock of 300 s for commands through the `Computer` seam only; exec
tools, terminals and dev servers live as long as their turn. `browser.maxConcurrent` (2) caps
browsers. The cap of 4 concurrent sandboxes and the cloud disk cap are not enforced.

## 9. Data hygiene

- Browser profiles, downloads, screenshots, and snapshots are stored locally under
  `blobs/`; screenshots default to 30-day retention.
- Credentials go only to the keychain/vault; the vault and the credential locations in
  `docs/12` §7.2 are never mounted or shared into any substrate.
- Snapshot contents are encrypted at rest when sync is enabled.
- Deleting an Agent/computer purges its snapshots and profiles after a confirmation.

*As shipped in M6 (ADR-093).* Browser screenshots are written to
`blobs/screenshots/<yyyymmdd>/<id>-<before|after>.png`, sealed with the data key when one is
loaded, and swept every 6 hours after `browser.screenshotRetentionDays`; computer-use screenshots
are content-addressed attachment blobs pruned daily after `screen.screenshotRetentionDays`. The
browser cookie state is sealed too. Snapshots are not encrypted beyond the data directory and are
not expired.

## 10. Failure & safety

| Scenario | Behavior |
| --- | --- |
| Sandbox unavailable | Fail closed; offer read-only degraded mode; never run unsandboxed by default |
| Micro-VM unavailable (no hypervisor, image check failed, boot failed) | Shell tools report unavailable; file and web tools continue in read-only degraded mode; no fallback to the host |
| Windows elevated setup not done | Shell tools unavailable; read-only degraded mode; Settings offers the setup |
| WSL1 environment | Rejected as unsupported; WSL2 suggested |
| Egress proxy expected but missing | All network denied for the sandbox; clear error; audited |
| Browser crash | Restart with the same profile; replay the last action if idempotent |
| Site blocks automation | Detect, report, and request a handoff/takeover or the local browser fallback (§4.6) |
| Network policy misconfig | Deny + clear error naming the blocked host; one-click allow (audited) |
| Sensitive-region masking fails | Observation and any action based on it refused; audited |
| Computer-use grant expired, or input to an app above its tier | Action refused with a structured error; the agent requests a grant or uses the named tool |
| Kill key pressed | Input stops immediately; the run pauses until the user resumes it |
| Injection attempt via page content | Treated as untrusted; not executed as instructions (FR-103) |

*As shipped in M7 (ADR-095; `packages/core/src/browser/session.ts`, `service.ts`).* The agent
browser restarts after a crash:

- **Detection.** A crash is decided only from the driver's own signals: the page's crash event, or
  the browser process disconnecting. An error message, which a page can write, never counts. The
  crash is recorded at once: a `browser.crash` trace row, audit `browser.session.crashed`, and
  `browser.session.changed` with state `error`; the browser panel shows a crash notice.
- **Restart.** The browser restarts on the next action, or right away when the crash interrupted
  one; concurrent calls share one restart. A crashed page is replaced by a new page inside the same
  browser, which keeps its cookies. A browser that died is launched again with the cookies of the
  last checkpoint (taken after each action except scroll and hover); localStorage does not carry
  over. Popups are always closed, so the one agent tab is all there is to restore.
- **Replay.** The page it was on is opened again only when a GET (or HEAD) loaded it and the site is
  still allowed; a page reached by posting a form stays closed. Only a navigation is replayed
  (`browser.navigate`, `devserver.open`). An action on an element is not repeated, since it may
  already have taken effect and its refs are stale; the agent is told to read the page again. A
  read or a page screenshot is taken once more.
- **Page tools.** The crashed page's tools (FR-208), refs and last read are dropped.
- **Trace.** Each restart is a `browser.restart` row with an after screenshot (audit
  `browser.session.restarted`); the session view counts restarts.
- **Limit.** A crash after 3 restarts in 10 minutes closes the browser with the reason (audit
  `browser.session.restart_failed`, tool error `browser_unavailable`); so does a restart that
  fails. The count belongs to the session, so it starts again at zero when a new session starts.
