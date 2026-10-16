# 11 — Computers & Browser Automation

Agents need a place to act. Unison provides a **Computer** abstraction with three
implementations behind one interface: cloud sandbox, local container/VM, and the user's own
machine (scoped). Browser and screen control are exposed as tools over this substrate.

## 1. The `Computer` interface

```ts
export interface Computer {
  readonly id: string;
  readonly kind: 'cloud' | 'local_container' | 'local_host';

  // Filesystem (all paths are resolved against allowed roots and policy)
  fs: {
    read(path: string, opts?: { maxBytes?: number }): Promise<Uint8Array>;
    write(path: string, data: Uint8Array, opts?: { createDirs?: boolean }): Promise<void>;
    list(path: string): Promise<Dirent[]>;
    stat(path: string): Promise<Stat>;
    delete(path: string): Promise<void>;
    move(from: string, to: string): Promise<void>;
  };

  // Process execution
  exec(spec: {
    cmd: string; args?: string[]; cwd?: string;
    env?: Record<string, string>; timeoutMs?: number; stdin?: string;
    network?: 'none' | 'allowlist';
  }): Promise<ExecResult & { stream: AsyncIterable<ExecChunk> }>;

  // Browser control (served by browserv)
  browser: BrowserController;

  // Screen control (computer use)
  screen: ScreenController;

  // Persistence
  snapshot(label?: string): Promise<SnapshotRef>;
  restore(ref: SnapshotRef): Promise<void>;
  status(): Promise<ComputerStatus>;
  stop(): Promise<void>;
}
```

All calls pass through the **policy engine** and are audited. The interface is identical for
cloud and local, so tools and tests are substrate-agnostic.

## 2. Implementations

### 2.1 Cloud sandbox

- Managed VM/container per Dot or per cloud Code session.
- Persistent workdir + installed software + browser profile, snapshotted automatically before
  risky operations.
- Works while the user's devices are off (FR-080).
- Network egress restricted to the session's policy; credentials never baked into the image.
- Self-hosting (P2): the same interface served over gRPC by a user-run runner.

### 2.2 Local container/VM

- Rootless **podman** container by default; optional VM for stronger isolation.
- Mounts only approved project folders (RW where allowed, RO otherwise).
- Network namespace off by default; allowlist via a proxy.

### 2.3 Local host (scoped)

- Used by Code mode "Local" and by a Dot's optional "connected computer" (FR-081).
- Enforced by an OS sandbox: Linux **bubblewrap** (or containers), macOS **seatbelt**,
  Windows **AppContainer/Job Objects**.
- Default FS scope: project root RW, temp RW, everything else read-only/denied.
- Default network: deny, with an allowlist and a local proxy for approved hosts.
- The user's personal computer is only connected by explicit consent, one at a time, and can
  be disconnected at any moment.

## 3. Sandbox broker (`services/sandboxd`)

```
Tool call → Policy allow → sandboxd:
   1. Resolve + canonicalize paths; reject symlink escapes and `..`
   2. Build a profile (bwrap / seatbelt / AppContainer) from the effective policy
   3. Start the process with resource limits (CPU, memory, wall clock, fds)
   4. Attach a network proxy enforcing the allowlist (HTTP CONNECT + DNS pinning)
   5. Stream stdout/stderr; enforce output caps
   6. Record the audit event with the profile hash
```

Guarantees: no host environment leakage, no out-of-scope writes, no unapproved egress,
resource limits enforced, and a deterministic, logged profile.

## 4. Browser controller (`services/browserv`)

| Capability | Detail |
| --- | --- |
| Launch | Chromium (bundled) or user's Chrome; clean profile by default |
| Drivers | Playwright (preferred) with a CDP fallback |
| Navigation | allowlist/denylist checked before navigate; per-site approval |
| Reading | accessibility tree + DOM summary + visible text (token-budgeted) |
| Acting | click, type, select, scroll, hover, press keys, upload/download |
| Observation | screenshots (viewport/full page/element), console logs, network summary |
| Waiting | selector, network idle, text, timeout |
| Sessions | per-computer profile; cookies persisted only if enabled |
| Safety | write actions reviewed by a classifier; sensitive actions require the user |

### 4.1 Sign-in flow (FR-086)

When a site needs credentials:

1. The agent requests a sign-in; the app shows a **private form** (outside the model context).
2. The user enters credentials; they are sent to the remote browser, never to the model.
3. Optional **Save to Passwords** stores them in the keychain (per-site, confirmed on reuse).
4. An **active session** is distinct from a **saved login**: a valid session needs no re-auth;
   reusing a saved login to start a new session requires confirmation.
5. CAPTCHAs and MFA are always completed by the user; the agent waits.

### 4.2 Takeover (FR-087)

The user can open the agent's computer/browser, take over mouse/keyboard ("Take over"), and
return control ("Return control"). Takeover is logged, and the agent pauses while the user
has control. The agent can request a browser handoff when it hits a wall.

### 4.3 Extension bridge (FR-096, P1)

For tasks that need the user's real logged-in sessions, an optional browser extension bridges
the user's browser to the agent with explicit, per-tab consent and a visible indicator. This
is separate from the clean agent profile and can be disabled by policy.

## 5. Screen / computer use (FR-093)

- `screen.observe` returns a screenshot + accessibility tree (preferred over pixels).
- `screen.click` / `screen.type` / `screen.key` act on a controlled desktop (container VM or
  the local host with consent); coordinates are validated against the last observation.
- Enabling local computer use requires an explicit toggle and (on first use) a confirmation.
- Dangerous targets (system settings, password managers, banking sites) are denied by
  built-in safety and always handed off.
- A visible recording indicator is shown whenever the agent controls the screen; a stop
  control is always present.

## 6. Appshots (FR-075)

`appshot.capture` records a window/screen region plus metadata (app name, window title,
timestamp) as an artifact for debugging. Captures are local, redact known-sensitive regions
when possible, and are subject to retention policy.

## 7. Network policy

- **Deny by default** for agent execution.
- Grants are per-scope: `run`, `session`, `dot`, `plugin`, `mcp-server`.
- A user-visible list of allowed destinations; requests to new destinations trigger an
  approval (if the mode allows) or a denial.
- A local HTTP(S) proxy enforces the list, performs DNS pinning, strips tracking headers, and
  logs requests (method + host + status; bodies not stored by default).
- Private/localhost addresses are allowed only for dev-server verification.

## 8. Resource governance

| Resource | Default cap |
| --- | --- |
| CPU per sandbox | 2 cores |
| Memory per sandbox | 2 GB |
| Wall clock per exec | 5 min (configurable) |
| Concurrent sandboxes | 4 |
| Concurrent browsers | 2 |
| Disk per cloud computer | 10 GB |
| Screenshot rate | 1 per 2 s |

Exceeding a cap returns a structured error and is logged; runs can request an increased cap
with user approval.

## 9. Data hygiene

- Browser profiles, downloads, screenshots, and snapshots are stored locally under
  `blobs/`; screenshots default to 30-day retention.
- Credentials go only to the keychain/vault; the vault is never mounted into a sandbox.
- Snapshot contents are encrypted at rest when sync is enabled.
- Deleting a Dot/computer purges its snapshots and profiles after a confirmation.

## 10. Failure & safety

| Scenario | Behavior |
| --- | --- |
| Sandbox unavailable | Fail closed; offer read-only degraded mode; never run unsandboxed by default |
| Browser crash | Restart with the same profile; replay the last action if idempotent |
| Site blocks automation | Detect, report, and request a handoff/takeover |
| Network policy misconfig | Deny + clear error naming the blocked host; one-click allow (audited) |
| Injection attempt via page content | Treated as untrusted; not executed as instructions (FR-103) |
