# Slice 5 — Agent daemon v1, Linux (novad)

Parent: the Master Roadmap (approved 2026-08-27), §S5 + §novad summary.
Inputs: slice-03-carries.md (egress/action-class carries; daemon classes were
named S5's), slice-04-carries.md, rd6 owner directives (2026-08-30: web reads
auto; zero-approvals trajectory with a gate kept for irreversible actions).
Slice type: ADDITIVE. Size: L. Owner gate: the DoD walk is Jeremy's — pairing
his own laptop — plus sign-off on the shipped dispositions (reads auto;
`device_run`/`device_write_file`/`device_launch_app` consent-with-graduation).

Goal: Nova can act on a paired computer. A pure-Go daemon (novad) enrolls with
a pairing code, holds an outbound WSS to core, and executes only commands that
arrive as ed25519 one-use signed envelopes — verified ON the device, so a
compromised or confused core-adjacent component cannot puppet a machine, and
the LLM never talks to the daemon at all (only core does, through the same
kernel funnel as every other tool). First code that runs outside the compose
stack; the shape S6 ports to macOS/Windows.

Frontier facts (verified 2026-08-31, never recited): Go stable = 1.27.0
(2026-08-19); WS client = github.com/coder/websocket v1.8.15 (2026-06-15 —
gorilla is dormant since 2024, x/net/websocket self-deprecates); Go
crypto/ed25519 is stdlib; python verify via the `cryptography` package;
lingering (`loginctl enable-linger`) is still how a user unit survives logout.

## Definition of done (operator-visible, walked live)

1. Settings→Devices: generate a pairing code, run the printed enroll command
   on a machine, `novad run` — the device tile appears green with platform +
   last-seen, unaided.
2. Default grant is `system.info` ONLY (roadmap): asking Nova to read a file
   on the fresh device is refused with a stated reason naming Settings→
   Devices; granting fs.read there flips it live, no restart.
3. In chat: "how much disk is free on <device>?" → a real number; Activity
   shows the device_info tool span (machine, args, ok).
4. "open Firefox on <device>" → approval card. DENY → the trace AND the
   device's own audit log agree nothing crossed the wire. Approve + retry →
   Firefox opens; the span meta records the exit. Repeat to graduation →
   auto-runs; revoke in Settings→Autonomy → the card returns (S3 machinery,
   same table, zero new authorizers).
5. Kill the device's network → tile goes stale within ~60s; restore → green
   unaided.
6. Revoke the device → its socket drops immediately, reconnect is refused,
   and the governance ledger shows the whole arc (enrolled → grants_changed →
   revoked).

## Architecture

### Trust: two pinned keys, exchanged once at pairing
- Enrollment (the only unauthenticated writes, rate-limited): owner mints a
  short-lived single-use pairing code (hash stored); the daemon generates its
  ed25519 keypair LOCALLY (private key never leaves the machine, 0600),
  `POST /api/v1/devices/enroll {code, pubkey, name, platform, hostname}` →
  core binds pubkey to a device record and returns {device_id, core_pubkey}.
  Each side pins the other's key from that moment (TOFU via the code).
- Core's signing keypair: generated once, single row in core's DB (the DB is
  already the trust root — password hashes, sessions).
- WS auth is challenge-response with the DEVICE key: connect → server sends a
  nonce → device returns sign(nonce) → verified against the pinned pubkey.
  Deliberate: Starlette `http` middleware never sees WebSocket connects, so
  the session/bearer layers are not even in the path — the challenge is the
  auth, mechanically, not by exemption.

### Authority: envelopes, verified at the edge
- Every command crosses as `{envelope, sig}` where envelope =
  {v, envelope_id, device_id, capability, args, issued_at, expires_at},
  canonical-JSON-signed by core's key. The daemon verifies: signature,
  device_id == self, expiry (±120s skew, ~60s validity), envelope_id unseen
  (one-use; the seen-set only needs to span the validity window). Fail any →
  refuse + audit, never execute.
- Local static deny-roots file (~/.config/novad/deny_roots; ships with
  ~/.ssh, ~/.gnupg, novad's own config/state dirs): fs.* paths under a deny
  root are refused ON DEVICE regardless of what core signed —
  mechanical-over-prompts at the edge, and the daemon's key stays out of
  reach even from a fully-trusted core.
- Layered ahead of the envelope, in core: per-device capability grants
  (default `["system.info"]`, operator-edited, read live per call) and
  per-device fs root scopes; then the action-class kernel (D-012, untouched —
  device tools are ordinary tools riding dispatch→authorize).

### Transport
- Outbound WSS from the daemon; heartbeat frame every ~20s updates
  `devices.last_seen` (tile state DERIVED from it, never a stored flag).
  Frames device→core: auth, heartbeat, result, audit. Core→device: challenge,
  command. Results resolve a pending future by envelope_id; a timeout or a
  dropped socket is a STATED tool failure — "accepted by transport" is never
  "received", and only the device's own result frame resolves a command.
- The web origin (:3000 nginx) gains one Upgrade-aware location for
  `/api/v1/devices/ws`, so a device needs the same single origin the phone
  uses; core :8000 direct also works. TLS in front (tailscale) is deployment,
  not code.

### Audit: hash-chained, replayed, verified
- The daemon appends every verified command (and every refusal) to a local
  hash-chained JSONL (hash = sha256(prev_hash + canonical entry)); replays
  entries upstream on connect (server names its last seq) and after each
  command. Core verifies chain continuity into `device_audit`; a break is a
  loud `device.audit_break` governance event naming the seq — never silently
  reindexed.

### Capabilities v1 → core tools (9 new; registry pin moves 8→17)
(Amended 2026-09-02 after the owner's first walk — a precheck layer now runs
BEFORE the kernel, fs grants require a root, and the owner sets dispositions
from Settings→Autonomy; see slice-05-carries.md §Post-close fix wave.)
- auto: `device_list` (core DB read, no envelope), `device_info`
  (system.info), `device_list_files` (fs.list), `device_read_file` (fs.read,
  256 KiB cap, stated refusal beyond), `device_list_apps` (apps.list),
  `device_notify` (system.notify).
- consent, graduating via S3 earned autonomy: `device_run` (shell.exec,
  ARGV-form only — argv: list[str], no shell string concatenation exists in
  the path), `device_write_file` (fs.write), `device_launch_app`
  (apps.launch). Consistent with rd6: reads never gate; the gate that
  remains is exactly the irreversible set, and it erodes by graduation.
- schema.py grows `items.type` validation so `argv` is checked element-wise
  before the kernel ever sees the call.

## Tasks

- **T1 — Device registry, enrollment, envelopes (core, M).** Migration 011:
  `devices` (id, name UNIQUE, platform, hostname, pubkey, owner_person FK,
  capabilities jsonb default '["system.info"]', fs_roots jsonb default '[]',
  enrolled_at, last_seen, revoked_at), `pairing_codes` (code_hash, created_by,
  expires_at ~10min, used_at), `core_signing_key` (single-row CHECK),
  `device_audit` (device_id, seq, prev_hash, hash, ts, envelope_id,
  capability, summary, ok, exit_code; UNIQUE(device_id, seq)). `devices.py`
  (key custody, enroll/rename/grants/revoke), `envelopes.py` (canonical
  bytes + sign; `cryptography` dep), `devices_api.py` (pairing-code POST
  owner-authed; enroll PUBLIC_PATHS + in-memory rate limit like login; list/
  rename/grants/revoke authed). Governance kinds `device.enrolled/
  grants_changed/revoked/audit_break`. Committed fixture
  `envelope_vectors.json` (fixed seed key → signatures) that BOTH the pytest
  and the Go suite assert — cross-language interop pinned mechanically.
  Pinned tests: expired/reused code refused; default grant is system.info
  only; canonical signing matches vectors; revoke refuses enroll and connect.
- **T2 — WS hub + daemon tools (core, L).** `devices_ws.py`: the WS route
  (challenge auth as above), hub registry (device_id → live conn + pending
  futures), heartbeat → last_seen, revocation kills the socket, audit-replay
  ingestion with chain verification. `tools/devices.py`: the 9 tools; every
  envelope-backed executor resolves the device by name, refuses revoked/
  disconnected with the stated reason, checks the live grant (refusal names
  Settings→Devices), prefix-checks fs paths against fs_roots, then
  hub.command(timeout ≤120s). schema.py `items.type`. Migration 012 seeds the
  9 action classes (dispositions per Architecture; risk_tier 'device').
  Deliberate pin updates: test_tools_registry 8→17, test_action_classes
  seeds — moved with the commit saying why. Pinned tests: a deny leaves ZERO
  frames on the wire (fake conn asserts); unknown capability refused;
  disconnected device is a stated ToolFailure; chain break → governance
  event; authorize-before-executor order holds for device tools.
- **T3 — novad (Go, L).** `apps/novad/`: go.mod (go 1.27; sole dep
  coder/websocket), `main.go` (enroll | run | status | version),
  internal/config (key + config custody, 0600), internal/wire (envelope
  verify + seen-set + frame types; asserts envelope_vectors.json),
  internal/caps (shell: exec.CommandContext argv with cwd/timeout/64 KiB
  output cap; fs: read/write/list + deny-roots; apps: .desktop scan +
  launch; system: statfs//proc//etc/os-release — all stdlib), internal/audit
  (chained JSONL + replay). `novad.service` user unit + README (daemon-
  reload, enable --now, enable-linger; graphical-session env note for
  apps.launch). mise.toml pins go; CI gains a novad job (vet, test,
  CGO_ENABLED=0 build). Pinned tests: vectors verify; a tampered/expired/
  replayed envelope refused + audited; deny-roots refuse survives a signed
  envelope; chain recomputes.
- **T4 — Settings→Devices (web, M).** `DevicesSection` on SettingsPage
  (after Autonomy; DI api prop per house pattern): tiles (green Badge /
  stale pulse from last_seen — the Activity statusBadge idiom), pairing
  modal (code + expiry + copyable enroll one-liner), grants editor
  (capability checkboxes + fs-roots list), rename, revoke-with-confirm.
  api.ts types + calls. nginx.conf WS location. vitest per house convention
  (fakes via the api prop, empty/error/loading states, no fake numbers —
  a never-seen device shows "never", not a green dot).
- **T5 — DoD tripwire + e2e + walk (M).** `test_devices_e2e.py` mirroring
  test_policy_e2e.py: a FAKE python device (in-process, real protocol —
  enroll → challenge → verified envelope → result) walks enroll → default-
  grant refusal → grant → auto read → consent card → deny (zero frames +
  device audit agrees) → approve → runs (exit in span meta) → graduate →
  revoke (socket killed, reconnect refused) → ledger shows every kind —
  all assertions off tables/ledger/frames, never reply prose. Playwright
  `16-devices.spec.ts` authored (house: authored-not-run until the owner
  password exists). Then the LIVE half: build novad, pair THIS host via the
  real UI, walk DoD 1–6 in real chat; Jeremy's laptop is his gate.

## Rails in force

- D-012 ONE AUTHORIZER: device tools ride dispatch→authorize; zero new ALLOW
  sites (the AST pin stays green or the slice is wrong).
- MECHANICAL OVER PROMPTS, AT THE EDGE: signature + expiry + one-use +
  deny-roots are code on the DEVICE; grants/roots are rows in core read per
  call. No sentence anywhere asks the model to behave.
- DERIVED, NEVER HARDCODED: tile state from last_seen; grants live per call;
  advertised tools from the registry; pins moved deliberately, never routed
  around (test-gate rail).
- NEVER REPORT SUCCESS UNCHECKED: only the device's result frame resolves a
  command; timeout/disconnect are stated failures; enrollment burns the code
  atomically; audit chain breaks are loud (no-fake-success).
- OPERATOR-VISIBLE OUTCOMES: every command is a turn span AND a device-audit
  row; deny provably leaves no wire traffic (the S3 "Activity proves nothing
  ran" bar, extended to a second machine).

## Out of scope (named)

macOS/Windows daemons, installers, signed self-update (S6). Bulk artifacts
over authenticated HTTPS (roadmap transport rule stands; no v1 capability
moves >256 KiB — the lane lands with the first capability that needs it).
Voice assurance / role ceilings on device surfaces (S8 — same carry as the
consent/autonomy routes). Per-device × per-class graduation (autonomy
graduates the CLASS globally; fine at one device, revisit when a second
enrolls — carry). Step-up/push confirmation (owner-deferred, S3 carries).
Device dashboards beyond the Settings tiles.

## Process

SDD per task; each task reviewed + fix rounds; the DoD walked live (real
novad, real chat, the trace and the device audit read back); commits on
rebuild/v4 never pushed; carries → docs/plans/rebuild/slice-05-carries.md.
