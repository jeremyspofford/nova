# Ledger

Decisions, dependencies and deviations, newest first within each section.

## Dependencies

Runtime: **none**. The server, runner, markdown renderer and tests use Node 22
built-ins only.

| Dependency | Kind | Why |
| --- | --- | --- |
| `jsqr` 1.4.0 | dev | Test-only: decodes the QR codes Nova draws (`tests/qr.test.js`, the M4 UI tests), so the encoder is checked by an independent decoder. Never loaded by Nova itself. |
| `playwright-core` 1.56.1 | dev | Drives Chromium for `npm run shots` (golden screens, keyboard path, budgets); no bundled browser download. |
| `claude` CLI | external | The default `agent_cmd`. Swappable by config; nothing in Nova depends on it. |

## Decisions

**2026-10-30 (M4 review): the device agent's sandbox, and failover.** Fixes
from the M4 review, branch `m4-fix/agent-failover`; each has a test that
failed before the fix.

- **The runtime's sandbox had holes (ADR-3).** Tried by hand on Node 26.3.1
  under the runtime's flags: `node:sqlite` ignores the permission model (it
  opened, ATTACHed and VACUUMed INTO any path); with `--allow-net`, unix
  sockets anywhere (an SSH agent, a container daemon) and loopback services
  were reachable; `process.report` (signal and uncaught-exception reports)
  wrote into any folder (Node checks only the working folder);
  `v8.setFlagsFromString('--trace-turbo-path=…')` and
  `--redirect-code-traces-to` wrote files anywhere; trace-event files landed
  in the folder it was started from. Already refused by `--permission`: WASI,
  the inspector, `process.binding`, child processes, `execve`, workers,
  addons, links and renames out of `state/`, `loadEnvFile`, `chdir` out;
  `localStorage` has no file. Now: no `--allow-net` (the boot agent makes the
  runtime's two hub calls, heartbeat and inbox, over IPC with its own session,
  refusing any other path and anything over 900 kB; the runtime no longer
  holds a session token either), `--no-experimental-sqlite`,
  `--no-experimental-webstorage`, diagnostics and trace files pinned to
  `state/`, `--disable-sigusr1`, started in `state/`, and a preload that
  replaces `process.report`, `process.kill` and `v8.setFlagsFromString`
  (non-configurable, so they can't be had back). `tests/core/device-sandbox.test.ts`
  runs every route above under the exact flags.
- **The offline queue is JSON files** (`state/queue/{pending,done,tmp}/`,
  one file per item, named by its key), not SQLite: written whole to `tmp/`,
  then hard-linked into `pending/` (which also refuses a key already there);
  answered by writing `done/` and then removing it from `pending/`. Order is a
  sequence stamped at add time. Node's permission model refuses `fsync`, so
  only the boot agent's `queue` command (outside the sandbox) flushes what it
  adds; an answer the runtime records and a power cut loses is sent again, and
  the hub answers it as a duplicate (exactly once still holds). The newest
  1,000 answers are kept. No migration from `queue.db`: M4 hasn't shipped.

**2026-10-29 (M4c): hub, standby and sync; promotion and fencing.** Plan §3.
`src/core/mesh/{sync,replica,promote}.ts`, migrations `0006_sync.sql` and
`0007_device_inbox.sql`.

- **The sync log** is filled by SQLite triggers on every replicated table, with
  the whole row as JSON, and keeps **one entry per row** (the newest): a
  standby that is behind can't miss a change, one that starts from nothing
  reads the state once, and an old entry can't keep a forgotten memory's words.
  The migration backfills what was there before. `hlc` is wall-clock ms, a
  counter from the log's sequence, and the node (SQL can't run the HLC class;
  order is `seq`). A hub records (`sync_state.logging = 1`); a standby copies
  the hub's entries with the hub's `seq` instead, so after promotion it serves
  a new standby the same way.
- **Replicated, beyond the plan's list:** `memory_event` (memory's history),
  `decision_template` and its history, `trigger_rule_event`, and
  `device_inbox` (M4b's table, now migration 0007 with `device_heartbeat`,
  which stays local) so a computer's queued items are taken in exactly once on
  whichever node is hub. Never: `device_session`, `pairing`, `join_request`,
  `mesh_state`, `sync_state`, `sync_log`, `schema_migrations`, identity files.
- **Home files** are journalled by a scan every 3 s and soon after a change
  (`fs.watch`), as `file_put` (text, or base64 for binary; up to 8 MB, a
  bigger file is a problem) and `file_delete`. **Deviation:** the plan says
  "everything outside UNTRACKED" but names `MEMORY.md` and `skills/`, which
  are in UNTRACKED (that list is about git history). What stays local:
  `nova.db*`, `logs/`, `backups/`, `exports/`, `kept/`, `workers/`,
  `connectors/` (connector secrets; reconnect after a failover), `mesh/`, and
  the home's git folder. The standby applies files with a hash check and
  refuses paths outside the home or into those folders.
- **Forgetting holds (order 4).** After a forget, once MEMORY.md and the day
  notes are rewritten, the hub rescans, so their old entries are replaced;
  anything in memory's entries or those files still carrying the words is
  removed, and the write-ahead log is folded in. The delete itself is an entry;
  the standby applies it through `Memory.forgottenElsewhere`, which does what
  a forget does there (WAL, backups, Era 2's files, its own log). Backups lose
  the log's entries too. Tests scan the standby's whole home (database, WAL,
  a backup taken while it held the memory, files) for the words, in-process
  and with two real processes.
- **Standby.** Reads its place from `mesh/role.json` (M4b's shape; a hand
  shape is tolerated; unknown fields kept on rewrite) and takes its registry id
  as its identity id. Runs no scheduler, heartbeat, workers or chat; Era 2's
  MEMORY.md import is off (`readOnly`). Every non-GET except `POST
  /mesh/promote` is 409 `This is the standby; “Hub” at <url> is the hub.` (Era
  2's routes too; a computer's agent moves on from a 409). Its own problems
  take ids below zero, so the hub's copies never overwrite them. It pulls
  `GET /mesh/sync?after=&wait=` (long poll, `access: 'sync'`, only the current
  standby), sealed to its X25519 key with AAD `nova-sync-v1|<standby>|<after>`,
  applies each batch in one transaction with foreign keys off (entries arrive
  newest-per-row, so a child can come before its parent), and acks.
- **Lag** is entries not acknowledged, and seconds since the last ack (or the
  approval) while there are some; over 60 s is "behind", one problem per
  episode. Measured from acks, not entry times: the triggers' clock is
  SQLite's, which tests can't move.
- **Promotion** checks that its own key is the one in the registry (the one
  devices pinned), then: epoch + 1, role hub, the old hub's record becomes a
  `spoke` (still trusted: it is the person's computer), signs the roster,
  rewrites role.json, starts the journal, fencing, the heartbeat and Era 2's
  scheduler, recovers the ledger, and records "Standby promoted to hub" on a
  `mesh` worker in its own lane, verified by a `nova-mesh` confirmation
  checker that reads the mesh state and the roster's signature itself. A hub
  that stepped down can't be promoted (it stopped copying). M4b's device
  routes are in the same route table, so the promoted node serves computers.
- **Fencing** at startup (before any work starts) and every 30 s: peers are
  trusted devices with an `address` and role.json's hub. `/mesh/hello` now
  carries the signed roster; a peer counts only if its roster is signed by the
  key this hub has for it, at a higher epoch, naming it hub. A forged higher
  epoch is a problem, not a demotion (tested). Stepping down ends every device
  session and open stream. **Gap:** a node that stepped down doesn't copy the
  new hub (its data diverged after the last sync); enroll it again.
- **Automatic failover:** `mesh.auto_failover_after_s` (a new profile section
  `mesh` with that one key, validated; the blank-profile tests now include
  `mesh: {}`), off by default, counted in wall time. A standby cut off from a
  healthy hub would promote itself too: that is the risk of turning it on, and
  fencing settles it when they see each other again.
- **PWA:** the banner on every page of a standby, with "Make this the hub"
  (tier-3 sheet) on its own screen; Health's Devices check shows the standby
  and its lag (hub) or the hub and the last copy (standby); the registry shows
  roles, and a standby shows it without add or revoke.

**2026-10-29 (M4b): the computer device agent, the one-line command, the
offline queue.** Plan §2. `src/device/`, `src/core/mesh/{spokes,agent}.ts`.

- **TypeScript on Node, not a port of Era 1's `novad`.** Evidence: no Rust
  toolchain here (`cargo`, `rustc` not found); Node 26's permission model
  enforces ADR-3's rule that the runtime can't touch the boot agent, and a test
  proves it (writing `boot/`, replacing or reading `boot/keys.json`, writing
  `runtime/`, spawning a process and starting a worker all fail with
  `ERR_ACCESS_DENIED`, using the exact flags the boot agent starts the runtime
  with); `novad`'s supervisor (`6e2cf142` `services/novad/src/supervisor.rs`:
  backoff, disable after repeated crashes) and signed updates (`update.rs`:
  verify, stage, swap) are the reference.
- **Two agents.** `boot.ts` holds `boot/keys.json` (0600, folder 0700), joins,
  pins the roster, signs sessions, runs the runtime under a watchdog and
  installs runtime updates. `runtime.ts` (with `queue.ts`) heartbeats and
  flushes the queue; it is started as
  `node --permission --allow-fs-read=runtime/ --allow-fs-read=state/
  --allow-fs-write=state/ --allow-net`, with an empty environment, and gets
  its session token (and the hub's CA, when there is one) over IPC.
  `--allow-net` is needed because Node 26's permission model also gates the
  network.
- **The agent ships alone.** `src/device` imports only `src/core/mesh/wire.ts`
  from the core (a narrow, tested exception to "only `index.ts`"), so
  `/device-agent.tar` is `src/device/**`, `wire.ts` and a package.json. The tar
  is a hand-written ustar (no dependency), checked with the system `tar`.
- **Who a device trusts.** Additions to `wire.ts`: `helloProofMessage` and the
  runtime manifest. A node answers `GET /mesh/hello/proof?challenge=` with its
  key; the agent signs a session request only for a node whose key it pinned,
  that says it is hub, at an epoch ≥ the one it knows (so a stranger at the
  hub's address never gets a usable signature), then takes its roster only if
  a pinned key signed it, its epoch is ≥ known and it names that node as hub.
  Lower epochs are never accepted. Tested with stand-in nodes and rosters the
  test signs (promotion itself is M4c).
- **Runtime updates.** `GET /mesh/runtime` is `{manifest: {version, sha256,
  files}, signature, signer, files}`, signed over `nova-runtime-v1.<manifest>`
  by the node's identity key; version is `<nova version>+<12 hex of sha256>`.
  The boot agent checks the signer is pinned, the signature, every file's hash
  and that the files are exactly the manifest's, then swaps `runtime/` by
  rename. A refusal is printed, kept in `boot/state.json`, and reported
  (`POST /mesh/devices/me/report` → a problem, once per ten minutes). The
  installed runtime is re-hashed before every start. With no hub reachable on
  first run, it installs the runtime from its own folder (`local+…`) and swaps
  in the hub's signed one when it can.
- **Watchdog.** Restarts after 1 s, 2 s, 4 s… (cap 30 s); three crashes within
  60 s is safe mode: the runtime stays down, kept across restarts of the boot
  agent; the boot agent heartbeats `safe_mode: true` (a problem on the hub, and
  the registry row says so); a new signed runtime or `recover` ends it.
- **Inbox** (`POST /mesh/inbox`, up to 100 items, in order). Each item is taken
  in with its (device, key) row in the same transaction, so a key is answered
  once and a repeat gets the same answer marked `duplicate`. `task_request` →
  a ledger task (origin `{kind: 'device'}`, idempotency key
  `device:<id>:<key>`) or a refusal kept with its reason and the request, plus
  a problem. `memory_note` → memory with `recorded_by: device:<id>`
  (`memory.ts` accepts that form now), unreviewed; the inbox keeps only the
  memory's id, never its words, so forgetting stays complete. `config_change`
  → identity, user, tuning and policy only (privacy, appearance and setup stay
  with the person's own screens); its `base_version` must equal the setting's
  current version (`GET /mesh/config/{section}/{key}`), else it is rejected,
  reported to the device and recorded as a problem: the hub's value stands.
  `event` → kept and sent on the stream as `device_event`. The device drops an
  item's body once the hub has answered it.
- **Additions to the plan's routes:** `GET /mesh/hello/proof`,
  `POST /mesh/devices/me/report`, `GET /mesh/config/{section}/{key}`,
  `GET /mesh/inbox/refusals` (person). Device views carry `agent: {version,
  runtime_version, safe_mode, at}` for computers.
- **Deviation: no numbered migration.** `device_inbox` and `device_heartbeat`
  are created by `mesh/spokes.ts` with `CREATE TABLE IF NOT EXISTS`.
  Migrations must be numbered without gaps, and 0006 belongs to M4c's sync,
  written in parallel; numbering this 0007 would fail to load until 0006
  exists. Both tables are new, so there is nothing to back up or convert. Once
  M4b and M4c are both merged, this can become migration 0007 if wanted.
- **TLS:** the system's trust, or `NOVA_CA_FILE` (copied into `boot/ca.pem` at
  join; curl in `join.sh` uses `--cacert`). The one-line command's first curl
  needs the CA too, through curl's own `CURL_CA_BUNDLE`. Tested over HTTPS with
  a certificate made by `openssl`.
- **Revocation:** the hub's refusal to start a session (after the node proved
  a pinned key) stops the agent, records it in `boot/state.json`, and `run`
  exits with status 3 from then on, saying why.

**2026-10-29 (M4a): device enrollment, the registry, sessions, and who may do
what.** Plan §0–§1. `src/core/mesh/`, migration `0005_mesh.sql`, Settings ›
Devices, `/pair`.

- **Who is asking** (`mesh/access.ts`), on every request, both listeners:
  - console: the console listener, a loopback peer, a loopback `Host`, and no
    `forwarded`, `x-forwarded-*`, `tailscale-*` or `x-real-ip` header;
  - device: a session of a trusted device (cookie `nova_session` or
    `Authorization: Bearer`), scoped by kind. Routes carry `access`:
    `public`, `person` (default: console, browser, phone), `approver`
    (console, or a browser/phone with `can_approve`), `device` (computer),
    `sync` (standby), `mesh` (any trusted device). Outside `/api/v1`
    everything is `person` except a short public list (`PUBLIC_PATHS`: the
    pairing page and what it loads, `/design-system.css`, the icons, and the
    reserved `/join.sh` and `/device-agent.tar`);
  - public: everything else. API: 401 (before route matching, so nothing is
    learnt about what exists). A page navigation: 303 to `/pair`. Another
    device's kind outside its scope: 403.
  - The `Host` check (421) and the X-Nova + Origin guard run as before, on
    both listeners; the mesh's public host is a trusted origin.
- **Tightening, said plainly:** with `NOVA_HOST` set beyond loopback, other
  machines used to get everything; now they get 401 until paired, and pairing
  needs a mesh address. Webhooks (`POST /hooks/{name}`) are `public`: they
  authenticate with their own token, as before. No existing test changed.
- **Transport** (`src/config.js` `meshConfig`): `NOVA_MESH_URL=https://…` needs
  `NOVA_TLS_CERT`/`NOVA_TLS_KEY`; `http://…` needs
  `NOVA_MESH_TRANSPORT=proxy|network`; otherwise Nova refuses to start and says
  why. A wildcard bind needs `NOVA_MESH_PUBLIC_URL`; `proxy` and TLS need an
  https public URL. Behind a stated proxy the rate limiter keys on the last
  `x-forwarded-for` entry, and only then. Joining and sessions are served only
  on the mesh listener.
- **Keys and formats** (`mesh/wire.ts`, node:crypto only so the device agent
  can carry it):
  - Era 1's code primitives and the HLC ported nearly verbatim; Era 1's fixed
    vectors still pass.
  - Fingerprint: the first 20 bytes of SHA-256 of the raw Ed25519 key, in
    Crockford base32 (the code alphabet), eight groups of four. A vector is
    checked against Python.
  - Every signed string has its own label: `nova-add-device-reveal-v1.<id>.<t>`,
    `nova-add-device-status-v1.<id>.<t>`, `nova-session-v1.<device>.<t>`,
    `nova-x25519-v1.<x25519 key>` (the join's `x25519_sig`: "over the X25519
    key", with a label), `nova-roster-v1.<canonical JSON>`. Times are Unix
    seconds within ±60 s.
  - `seal`/`open`: static-static X25519, HKDF-SHA256 with a fresh 16-byte salt
    per box and info `nova-seal-v1|<from>|<to>`, AES-256-GCM, optional AAD.
    Layout: version 1, salt, iv, ciphertext, tag.
- **Identity:** `home/mesh/identity.json` (0600, directory 0700, written
  atomically) holds this node's id and both key pairs. A looser file is
  tightened at start and recorded as a problem. The private halves never leave
  the module; serializing the identity shows public parts only. A test scans
  the database, its WAL and the log for the private keys, the code and the
  session token.
- **The hub is in its own registry** (role `hub`, kind `computer`), so the
  roster, `mesh_state.hub_id` and promotion (M4c) have a record to point at;
  for the console, "this device" is the hub. It can't be revoked.
- **Enrollment** (`mesh/enroll.ts`):
  - Codes: 20 an hour; single use; wrong, spent and expired codes all answer
    400 "That code didn't work."
  - The code is needed again for the digits, so between join and reveal the
    hub holds it in memory only (Era 1's approach); a restart forgets it and
    the request expires. **Deviation:** the join answer also carries
    `pairing_id`, which the digits are computed over.
  - Reveal within 2 minutes of the join, then approval within 10 minutes. A
    request that expired after showing its digits is a problem; one that never
    got that far is just tidied away.
  - A commitment that doesn't match denies the request and records a problem.
    A replayed reveal is 409; polls must be signed with a time newer than the
    last accepted one.
  - A revoked key is refused (403) without spending the code; a key already
    paired or already asking is 409. One standby at a time.
  - Rate limits per client address: 30 public calls a minute, 90 polls a
    minute, 10 wrong codes in 5 minutes. A refusal is one problem per address
    per 10 minutes.
- **Sessions:** `nvs_` tokens, 12 hours, stored as a labelled SHA-256. A signed
  session request starts one session only. `{cookie: true}` sets an HttpOnly,
  SameSite=Strict cookie (Secure when the public URL is https) and never puts
  the token in the body. `last_seen` is written at most every 30 s.
- **Revocation:** sets `trust='revoked'`, deletes sessions, emits `device`,
  and on the next turn destroys every response the device has open (core
  stream, Era 2 streams, anything in flight). A test shows streams close in
  well under a second, and fails without the closing.
- **Additions to the plan's route list:** `GET /mesh/status` (whether devices
  can reach Nova, where, and who is asking; the PWA needs it). `PATCH` joins
  the route methods. `join_request` events go only to approvers.
- **PWA:**
  - Settings › Devices lists the registry. Add a device is the standout,
    unless a device is waiting, when Review is. Revoke and "let it approve"
    are tier-3 sheets in the approval-sheet pattern. The join prompt opens by
    itself on the hub's screen and on approver devices, with the digits first.
  - The "Device id" row (the appearance id in localStorage) is now
    "Appearance id", since "device" means the registry now.
  - `ui/js/qr.js`: byte mode, level M, versions 1–10, the lowest-penalty mask,
    one `currentColor` path with a quiet zone. `.qr` uses `light-dark()` on
    `text/primary` and `bg/base`, so it is dark on light in every scheme with
    their 4.5:1 contrast. jsqr decodes every version and every mask, and, in
    Chromium, the pixels the page drew in light and dark mode without
    inversion.
  - `/pair` makes a fresh non-extractable Ed25519 + X25519 pair per pairing
    (IndexedDB); drops the fragment from the address bar; refuses a hub whose
    fingerprint isn't the QR's; shows the digits it computed itself and stops
    if the hub's differ; pins the hub's key and checks the roster's signature;
    signs in with the cookie. No secure context or no Ed25519: it says so and
    offers no way on.
  - A paired browser renews its session with its key two hours before it ends,
    and after a 401 (API or stream); if the hub refuses, it goes to `/pair`,
    which forgets the revoked key.
  - The service worker never caches `/api/v1/mesh/*`; shell cache v3.
- **Left for later:** `/join.sh` and `/device-agent.tar` are reserved public
  paths with no handler yet (M4b), so the command door answers 404 until then.
  The standby's lag in Health is `null` until sync (M4c).

**2026-10-29 (packet amendment): perception principles added to DESIGN-SYSTEM §1
as binding.** Owner's amendment; not a milestone, and M3/M4 scope is unchanged.
The current design already largely complies, so there is no UI rework for it alone:

- **Real progress:** the orb and every status come from real signals (ledger
  activity, approvals waiting, open problems, reachability) through one mapping
  (`ui/js/status.js`). A scan of `ui/js` found no simulated work or artificial
  delays: every timer is a reconnect check, a debounce or a toast's lifetime.
  The scripted stand-in model's `FAKE_DELAY` is a test tool, never shipped
  behaviour.
- **One standout:** each card and sheet has one primary button; approvals use
  the approval sheet, and tier-3 steps (including irreversible Era 2 commands)
  add the confirm box.
- **No engagement mechanics:** no streaks, badges for use, praise or guilt
  copy anywhere.
- **Endings:** ledger tasks end Verified with evidence, or Failed/Cancelled with
  a reason; setup ends on the welcome task's VerifiedResultCard.
- **Where it doesn't fully comply yet** (fix when the surface is next touched):
  the Appearance picker lists every installed design system as equal options,
  with the current one marked but no recommendation; Era 2's settings screens
  weren't audited view by view for a single primary action.

**2026-10-29 (M3c): the M3 gate runs in a real browser.**

- **Where:** `tests/ui/*.test.ts` drive Chromium (playwright-core) against the
  real server process. Locally, with no usable browser, the suite skips with a
  loud notice; in CI (`CI` set) a missing browser is a failure, so the gate
  never passes by not running. CI installs the Chromium build matching
  playwright-core in its own job and keeps the screenshots as an artifact.
- **This dev host can't start Chromium** (missing system libraries; installing
  them needs root). `scripts/ui-test.sh` runs the suite in the Playwright image
  with the host's Node mounted. Server, browser and tests share the container
  because Docker Desktop's host network doesn't reach WSL.
- **Screenshots** are written only when `NOVA_UI_SHOTS` names a folder, so a
  plain test run never rewrites tracked files; `scripts/ui-test.sh` writes
  `docs/screenshots/m3/`. Each waits for finite animations to finish first.
- **"No face"** is checked structurally: every orb on the page has exactly its
  four layers and no image, SVG or canvas inside.
- **Independent review, fixed before merge:**
  - Offline honesty: health checks are network-only in the service worker, and
    a cached answer never counts as Nova being reachable (a second outage used
    to flip the orb back to idle every two seconds). Browser-tested with two
    real outages; the test fails on the old code.
  - Tier 3 for Era 2 tool steps: removing a schedule, and commands that look
    irreversible (rm, dd, force push, hard reset, clean -f, branch -D, find
    -delete, DROP TABLE, recursive chmod/chown), need the confirm box every
    time. The command check only adds friction; anything it misses still asks
    first (tier 2). Settings' "without asking" permissions are the person's own
    policy and are unchanged.
  - Turning off the design system in use falls back to the one before, drops
    device overrides on it, and sends the `design-system` event, as removal
    does.
  - Applying "on all devices" from a device with its own choice now says that
    this device keeps its choice.
- **Found by the gate and fixed:** setup ignored the curly apostrophe phone
  keyboards type ("I’m Alex" became the name), and setup's transcript replayed
  its entrance animation on every answer.

**2026-10-29 (M3b): the PWA: layouts, navigation, components; Era 2's
aliases removed.**

- **Breakpoints** live only in `ui/styles/layout.css`. It turns widths into
  words on `:root` (`--viewport`: narrow < 600 px, medium 600–1023 px, wide
  ≥ 1024 px; `--aside-room`: yes ≥ 1280 px; `--segments` from the
  `viewport-segments` media features), and `ui/js/layout.js` combines them
  with the posture into `<body data-layout data-posture data-aside
  data-room>`. No script holds a pixel width.
  - phone: narrow, or `folded`. tablet: medium, or any half-open posture.
    desktop: wide and flat. The right column (desktop) shows at ≥ 1280 px
    unless the person closes it (kept per browser); on a tablet the same three
    quiet cards are the context pane.
- **Postures**, in Nova's words: `continuous`, `folded` (the cover screen),
  `half-open-horizontal` (segments side by side, book), `half-open-vertical`
  (segments stacked, laptop: conversation on top, the active card below).
  The Device Posture API's own `folded` means half-open, so Nova maps it to
  half-open by orientation. `?posture=` emulates one for tests and is read
  once per page load.
- **Navigation**: nine destinations, Home, Chat, Tasks, Memory, Automations,
  Skills, Activity, Health, Settings, reachable in every layout
  (`ui/js/nav.js`, tested). Phone tabs: Home · Chat · Tasks · Memory · More
  (Automations, Skills, Activity, Health, Settings). Rail: the orb is Home,
  then Chat, Tasks, Memory, Automations, More (Skills, Activity, Health), and
  Settings at the foot. `/` is Home now; the main conversation moved to
  `/chat`; `/schedules` still works and shows Automations. Conversations are
  a drawer from Chat's top bar in every layout.
- **Status**: one function maps ledger states (queued → Waiting; active,
  verifying → Working; waiting for an OK or flagged for attention → Needs you;
  other waiting → Waiting; done → Verified; failed → Failed; cancelled →
  Quiet). Era 2's activity states use the same words and never claim
  Verified. Automation rules and health checks are not work, so they show a
  plain pill (Paused, Fine), not the vocabulary.
- **The orb** is CSS light (gradients from `orb/*` tokens), no face. Its state
  comes from real signals, most urgent first: offline, listening, alert (open
  problems), attention (an OK waiting), speaking (a reply streaming), working,
  idle.
- **Buttons on the accent.** With the aliases gone there is no computed
  `--accent-text`; primary buttons, Send and the person's bubble are lit with
  the accent mixed 24% into `bg/raised`, labelled in `text/primary`. A test
  checks that pair reaches 4.5:1 in every built-in package and mode.
- **Device id**: `nova.device` in localStorage (a random UUID) is the only
  appearance state in the browser; the design system and mode come from the
  API. `scripts/shots.js` gives each browser context its own device id and
  applies its design system through the API.
- **Service worker**: the shell is precached, but every request is
  network-first, so a running Nova always serves fresh code. Offline GETs come
  from the cache with `x-nova-offline`, and the page says so. Memory and
  receipts are never cached (forgetting must hold everywhere); changes and
  event streams are never answered offline. The manifest's colours are Orb
  Teal's literal values, since a manifest can't read CSS variables.
- **Honest surfaces**: Devices shows this browser only; the Brief card says
  no brief exists yet; there is no Smart Home card. Voice is disabled in
  local-only with the reason under the composer, and elsewhere only where
  the browser has speech recognition.
- **Removed**: `ERA2_ALIASES`, `ERA2_NAMES`, `--accent-text`, the schema's
  `era2_aliases`, and the lint's `LEGACY` list. Every file in `ui/` uses
  schema tokens only, raw spacing is an error everywhere, and `@container`
  width queries count as breakpoints.
- **shots.js** now completes setup through the API first, and its memory
  margin-link check clicks the oat-milk note by text: since M2 a day note is
  also a linked memory, so "the first link" was no longer the one meant.

**2026-10-29 (M3a): design systems are token packages; Era 2's names are
temporary aliases.**

- **Tokens.** The schema is DESIGN-SYSTEM §2 in full, plus:
  - `type/weight-regular`, `type/weight-strong`, `type/line-tight`,
    `type/line-body`;
  - `motion/duration-fast`, `motion/duration-slow`, `motion/ease`.

  It lives only in `src/core/design.ts` (`TOKENS`), and `ui/` reads it from
  `GET /api/v1/design-systems/schema`. A name maps to a CSS variable by
  replacing `/` with `-` (`bg/base` → `--bg-base`). Values are literal and
  checked per family:
  - colours are hex or `rgb[a]()`, so contrast can be measured;
  - `type/h*` are sizes, and line heights are plain numbers;
  - `motion/breathe`, `motion/pulse` and `motion/transition` are durations,
    paired with `motion/ease`.

  Anything else is refused, so a value can't carry CSS beyond its token.
- **Package format.** A full CONTRACTS §4 manifest of kind `design-system`.
  It asks for no permissions, uses no secrets and keeps nothing on removal;
  the extension host enforces this at install.
  - `tokens{}`: the full set.
  - `modes{light?, dark?}`: partial overrides.
  - `reduced_motion{}`: may only shorten motion; loops must be `0s` and
    everything else at most 200ms. The core emits safe defaults anyway.
  - `components{}`: bindings that may name schema tokens only.
  - `content_rules{}`: DESIGN-SYSTEM §6 as numbers and switches, which may
    only tighten.
  - `extras[]`: any component outside §7 must be declared here.
  - `preview[]`, plus an optional `description`.

  A package that fails validation can be installed and inspected, but it is
  never applied or previewed. Built-ins come from `design-systems/` on every
  start, skip the `nova_compat` check (they ship with this Nova), can't be
  removed, and are updated in place.
- **Selection.** The profile section `appearance` holds `design_system`,
  `previous`, `mode` (auto by default) and `device_overrides`, plus
  `device_previous`, so a device's rollback doesn't lose an older override.
  With no record, Orb Teal shows, and a blank profile stays blank for setup.
  The mode is set through `PUT /api/v1/profile/appearance/mode`; the other
  keys only change through apply and rollback.
- **Era 2 themes converted.** Nova, Paper, Aurora and Obsidian are packages
  now, and `ui/themes/` is gone. Their values map onto the new tokens:
  - `--bg` → `bg/base`, `--surface` → `bg/raised`, `--raised` →
    `surface/card` and `bg/overlay`, `--wash` → `surface/card-hover`.
  - Status and orb colours come from each theme's accent and status colours.
  - `type/*` sizes come from the shorthands, and `weight-strong` and the
    line heights from the title and body styles.

  Fidelity losses: the `--t-*` shorthands become one strong weight for every
  heading (Paper's 400-weight serif display is now 600), `--r-bubble` follows
  `--r-card`, `--code-bg` follows `bg/base`, and `--shift` follows `space/1`.

  Faint text on cards, a pair Era 2 never checked, missed 3:1 by a hair in
  two themes:

  | Theme | Token | Era 2 | Shipped | Why |
  | --- | --- | --- | --- | --- |
  | Nova | `text/faint` | `#62626B` | `#65656e` | 2.87:1 on `surface/card`; needs 3 |
  | Obsidian | `text/faint` | `#62666D` | `#63676e` | 2.98:1 on `surface/card`; needs 3 |
- **Temporary aliases.** So today's `ui/` keeps working until the PWA
  replaces it, the generated CSS also emits Era 2's names (`--bg`, `--text-2`,
  `--t-body`, `--s3`, `--r-card`, `--m-fast`, …) as `var()` aliases of the
  new tokens. `--accent-text` is chosen per package for contrast.
  `lint:tokens` allows these names only in the Era 2 files listed in
  `LEGACY`. New UI code may use schema tokens only, and there raw spacing and
  breakpoints outside `ui/styles/layout.css` are errors too. The aliases, the
  `LEGACY` list and `ERA2_ALIASES` are removed together with the Era 2 UI.

**2026-10-29 (M2): a held message says why it waits.** Messages carry a
`hold`:
- `quiet`: delivered when quiet hours end, but only if its rule still exists,
  isn't paused and isn't turned off; otherwise `withdrawn`, never delivered.
- `needs_ok`: triage wasn't sure. Only the person releases it
  (`POST /api/v1/messages/{id}/approve`).
Privacy is re-checked before every model step, not once per turn, and a
caller's mode can only tighten the live setting. All of this is from the M2
review.

**2026-10-29 (M2): scheduled runs and helpers are ledger tasks; the M1 debt
is paid.** Each scheduled run is a heartbeat trigger record (source
`schedule:<id>`, claimed once per due time) whose task belongs to the
`chat-run` worker (`src/chat-run.js`); each helper is a `chat-run` task whose
origin names the conversation that asked. The worker runs them through the
Era 2 runner and reports a `confirmation` from `nova-sessions`, which Nova
checks itself by reading the report in the target conversation. The ledger
now runs tasks in lanes: scheduled runs one at a time, helpers three at once,
every other worker sharing one lane of one, as before. A run waiting for the
person's OK reports `blocked` and waits, giving up its place (in Era 2 such a
helper kept one of the three); when the run ends it is requeued to hand over
its report. A run interrupted by a restart is not run again (its steps may
have changed things): its conversation hears it didn't finish. A run uses the
stricter of its task's privacy mode and the current setting; if that refuses
the model, the task waits on local capacity. Schedule files stay the
schedules' registry, so the trigger engine takes a rule-less firing with its
own action; `runs.jsonl` stays as the per-schedule history the Schedules view
and catch-up read, each entry naming its task.

**2026-10-29 (M2): MEMORY.md is a view of the core's memory.** The curated
memory lives only in SQLite (ADR-4). `MEMORY.md` is re-rendered after every
change, with the same headings and `<!-- id= from= at= -->` comments, so the
model and the person see what they saw before. Existing entries were
imported once, keeping their ids, sources and times. A hand edit (detected by
hash before each read) is taken in as the person's: changed words become a
correction, a new bullet is remembered as confirmed, and a removed bullet is
forgotten. Trade-offs:
- Corrections, edits and undo create a new id.
- Invented headings, prose paragraphs and bullet order don't survive a
  re-render.
- Deleting the whole file re-creates it rather than forgetting everything.
- Day notes stay files until M3.

**2026-10-29 (M2): triggers are one engine with a visible registry.** Every
automation is a rule (`event`, `heartbeat`, `proactive`) listed at
`/api/v1/triggers/rules`; every firing is a trigger record (CONTRACTS §6)
with its triage decision and reason, and what it led to. The firing pipeline
runs in this order: dedup (default key is the payload hash, 600 s window),
cooldown, triage, act. Proactive messages are held during quiet hours.
Heartbeats run once per due time (`claim_key UNIQUE`); missed runs older
than 6 h become one "missed" record. Webhooks (`POST /api/v1/hooks/{name}`)
are the one route exempt from the `X-Nova` guard. They authenticate with a
per-rule token instead, shown once and stored as a hash, and `api.ts` refuses
any other route that claims the exemption. When triage escalates, the task
it creates waits for the person's OK.

**2026-10-29 (M2): System 1 is a provider interface with a local rules
provider; Jev stays a stub.** The owner chose not to create a Jev account
yet. `JevProvider` declares what it would answer and refuses to run. Local-only
uses only providers whose egress is `none` or `local`. Templates are authored
on cache miss only (propose, then dry runs, then activation). Activation is a
ledger task whose `test_result` evidence the verifier re-checks by re-running
the dry runs. The built-in `triage@1` template ships active.

**2026-10-29 (M2): Noul, as the owner defined it.** Noul is Jev's yes/no
type: one calibrated probability in [0, 1]. Its certainty is
`|p - 0.5| * 2`, and a provider's separate confidence is ignored for it. A
mixed template is only as certain as its weakest part. An out-of-range
answer becomes 0.5 and escalates.

**2026-10-29 (M2): memory is SQLite records (CONTRACTS §7); forgetting is
complete.** A correction supersedes the old record and keeps the history; a
forget deletes the whole chain with `secure_delete` and leaves an audit row
with no content. The owner's standing order makes deletion hold in backups
too. Each pre-upgrade backup is cleaned in place (rows deleted, file rebuilt),
so it stays restorable and can't resurrect what was forgotten. The retention
rule: backups are kept until the person removes them, but a backup Nova
can't clean is destroyed and reported. Exports the person wrote are theirs
and are not touched.

**2026-10-29 (M2): a context receipt for every model call.** The chat runner
records each one before calling the model: the system prompt, standing
files, recalled notes, skills and conversation, by reference and sha256,
plus purpose, privacy mode and egress. `GET /api/v1/receipts?egress=remote`
is the egress log. A receipt that would record a remote call under
local-only is refused and becomes a problem.

**2026-10-29 (M1): chat honors the privacy mode; the model command declares
its egress.** Found after the M1 gate passed: setup promised "nothing leaves
this machine", but chat still defaulted to a cloud model. Now `agent_egress`
(`none` | `local` | `remote`, from `NOVA_AGENT_EGRESS` or `agent_egress` in
`nova.config.json`) says where the model command sends conversations, and
undeclared counts as `remote`. With a local-only profile a remote model is
never started: the person gets a plain error saying nothing was sent, and
how to change it. Setup says up front when the configured chat model is a
cloud one. In local-only, tools that reach the internet (web, Gmail) are
not offered; `exec` still asks every time. Consequence: a new user who
keeps local-only has no chat until a local model is configured (M6 makes
that easy). That's the honest trade, per the non-negotiable that local-only
never falls back to cloud.

**2026-10-29 (M1): the core is TypeScript run directly by Node, inside the
same server.** `src/core/` is the modular-monolith core (ADR-1). Node 26
strips types natively, so there is still no build step; `tsc` only
typechecks (`npm run typecheck`). The existing server mounts the core at
`/api/v1` behind its existing loopback, Host and `X-Nova` guards: one
process, one Nova, not a second app beside the first. Only `core/index.ts`
may be imported from outside the core (a test enforces it). The JavaScript
modules move to TypeScript as they are touched. `engines` is now Node >=26,
the version actually tested.

**2026-10-29 (M1): SQLite through `node:sqlite`, no ORM.** Structured state
(profile, ledger, extensions, problems) is in `~/Nova/nova.db` (ADR-4).
Migrations are forward-only and checksummed, with a backup before every
upgrade; rollback is restoring that backup. Ported from Era 1's storage
package without drizzle. The database, logs, backups and extension data
stay out of the home's git history.

**2026-10-29 (M1): the task envelope gains one optional field, `inputs`.**
CONTRACTS §1 lists the brief's fields; a deterministic worker (no model)
can't act on a plain-language goal alone, so `inputs` carries its
structured parameters. Optional and additive, so envelope version stays 1.
Recorded here as the contract note the packet asks for.

**2026-10-29 (M1): a task can't be created without an evidence
requirement, and unknown evidence fails.** "Done without evidence is not
done" (NOVA-SPEC §3) is enforced at creation, and the verifier fails any
evidence kind it has no checker for, rather than passing it. Read-back is
the first checker: Nova re-reads the target itself.

**2026-10-29 (M1): setup is a scripted interview.** It has to work before
any model is configured and with no network (the M1 gate is local-only), so
it doesn't use one. Each answer is written to the profile as it is given;
unclear answers are asked again, never guessed. A model-assisted version
can replace the parsing later without changing the records it writes.

**2026-10-29 (M1): the persona moved out of `system/system_prompt.md`.**
"Who you are" is now rendered by `src/core/identity.ts` from the fixed
charter plus the profile (name, tuning), and the chat runner gets it from
the core. The old Truth / Respect / Restraint values are kept, as the
charter and the speech rules.

**2026-10-29 (M1): known debt, owned.** Era 2's helpers and schedules still
run outside the ledger, so for now there are two records of background
work. Schedules move onto the ledger in M2 (its gate requires it), and
helpers with them. The ledger runs one task at a time. A timezone set in
setup reaches the chat and scheduler side on the next restart.

**2026-10-29 (M0): the builder packet governs; the current tree is the base.**
From here on `docs/builder-packet/` is the authoritative design, and where it
and this ledger disagree, the packet wins. The build continues from this tree
(Era 2) rather than restoring Era 1: it is the owner's deliberate clean slate
(`7ea842b5`), it is small and fully tested, and restoring Era 1's ~465k lines
wholesale would break the packet's per-component reuse rule. Era 1 components
whose design already matches the contracts (device pairing, the secrets
vault, browser takeover, the migration runner) are ported in the milestone
that needs them, with their tests and without their framework dependencies.
Evidence: `docs/inventory/M0-DELTA.md`.

**2026-10-29 (M0): CI runs on every PR; the toolchain is pinned.** Nothing
ran the suite on GitHub before. `.github/workflows/ci.yml` runs the token
lint, a parse check of every JS source (not a typecheck: there are no types
until the TypeScript core lands), the theme contract, the tests and
`npm audit`. Node 26.3.1 is pinned in `mise.toml` and CI installs it from
there, so local and CI match.

**2026-10-21 (Phase 2): memory is kept with blocks, not tools.** The model
ends its reply with `<remember>`, `<note>` and `<forget>` blocks; the runner
strips them from the stream and applies them before `done`. A tool call per
memory would cost a model round trip (~1.5 s each). Entries stay markdown
bullets with a trailing `<!-- id=… from=… at=… -->` comment, so they remain
readable and editable by hand, and the Memory view, corrections and forgetting
all point at the id.

**2026-10-21 (Phase 2): session logs record memory by id only.** The words
live in the memory files; conversations look them up. Forgetting therefore
removes a memory from every conversation view too.

**2026-10-21 (Phase 2): forgetting a memory forgets matching day notes.**
Same exchange and one shared word stem, or most of its word stems anywhere.
Otherwise search would bring it back.

**2026-10-21 (Phase 2): memory stays out of the home's git history.** The
home folder's `.gitignore` excludes `MEMORY.md` and `memory/*.md`, so
forgetting leaves no copy in old commits, and no history is ever rewritten.
Conversations and standing files keep their audit trail. Agreed with Jeremy
in the thread.

**2026-10-21 (Phase 3): skills are playbooks, loaded by their words.** A
skill is `SKILL.md` with front matter (`name`, `about` for the person, `when`
for the model, `words`, `needs`, `try`) and a markdown procedure. Nova ships
two in `skills/`; installing copies the folder into the home. When a message
contains one of a skill's `words`, the runner loads its playbook (and the docs
of the connectors it needs) before the first model call, which saves a round
trip. Every installed skill is also listed, so the model can load one with
`use_skill` when the words miss. Real model: "Anything I need to deal with
from overnight?" matched nothing and the model loaded Email summary itself.

**2026-10-21 (Phase 3): Nova reads Claude's skill format, and people can add
their own.** Jeremy asked for plugins like Claude's and ChatGPT's. Skills are
the part that fits Nova now: a `SKILL.md` with only `name` and `description`
loads (the description is both the summary and the trigger), and its other
files are copied and listed to the model. Adding takes a folder or a .zip
(read with a small zip reader in `src/zip.js`, no dependency), capped at 200
files and 5 MB, refusing name clashes and paths outside the folder. An added
skill is trusted instructions, not code: scripts only run through `exec`,
which always asks. MCP connectors are a later phase.

**2026-10-21 (Phase 3): skills and sign-ins stay out of the home's history.**
`skills/` and `connectors/` join the memory files in the home's
`.gitignore`, so removing a skill leaves nothing in old commits and no token
is ever committed. Conversations still record which skill they followed (by
name), and show "since removed" afterwards.

**2026-10-21 (Phase 3): Gmail connects with an app password, over IMAP;
your own OAuth client is the Advanced way.** Jeremy found the OAuth-client
setup (Google Cloud project, consent screen, Desktop client, JSON) too much
for anyone to do. The one-click "Connect" other assistants offer needs a
Google-verified app; Gmail scopes are "restricted", so that means Google's
review (weeks) and a yearly third-party security assessment, and until then a
warning screen and a 100-user cap. Not now. An app password takes about two
minutes and no Google Cloud at all. Costs: it needs 2-Step Verification, it
opens the whole mailbox (no read-only), and work or school accounts often
can't make one, which is what Advanced is for. The OAuth path (PKCE, loopback
redirect, so localhost only) stays as it was, now with `gmail.modify`.
Connecting one way disconnects the other. This reverses the earlier call to
reject IMAP; what kept it safe is below.

**2026-10-21 (Phase 3): Gmail drafts and organizes; it never sends or
deletes.** Jeremy asked for actions. Drafts, archive, labels and read state
are all reversible from Gmail; sending and deleting aren't, so Nova has no
code for either (no SMTP, no delete call). Every draft and change waits for
the person on an approval card that shows the exact draft or the exact
messages, worked out before asking; a draft or change that can't be worked
out (a gone message, a label that doesn't exist) fails before the card.
Reading uses `BODY.PEEK`, so it never marks mail read.

**2026-10-21 (Phase 3): after mail is read, going online asks first.** Email
is outside content, and a malicious message can ask the model to put mailbox
details into a URL. In a conversation where Gmail has been read, `web_fetch`
and `web_search` wait for the person's approval. Real model: told to "do what
the security email says", it read the email, declined, and explained why.

**2026-10-21 (Phase 3): web search is DuckDuckGo's HTML page.** No API key
and no dependency; Nova parses titles, links and snippets, and drops ads. It
breaks if DuckDuckGo changes its markup; `NOVA_SEARCH_URL` points it
elsewhere, and the walkthrough uses a stand-in.

**2026-10-21 (Phase 3): shopping researches and never buys.** Payments are
out of scope and a purchase can't be undone. Real model: big retailers often
refuse automated page reads (503s, rate limits), and the playbook's rule of
quoting only prices it saw made it stop short of a recommendation. The
playbook now asks deciding details first, caps page reads at about six, and
falls back to agreeing sources labelled "reported".

**2026-10-21 (Phase 5): permissions, all "ask" by default, in Settings.**
Jeremy first chose full autonomy for unattended work, then revised: every
permission defaults to ask, with a Settings page of switches whose list is
dynamic. Each tool that needs an OK declares `permission: {id, label,
note}`; tools without one get a permission named after the tool, so plugin,
MCP or Nova-made tools appear without code changes. Going online after
reading mail is the one permission not tied to a tool. On = take the step
without asking everywhere (`approval {allow, auto: true}`, stamped "Without
asking"). Off = ask; with no one watching, the run or helper waits for the
answer, and a waiting scheduled run steps aside so the queue keeps moving.
Stored in `~/permissions.md`; `write_file` can't edit it. This replaces
Phase 4's "unattended runs decline approvals".

**2026-10-21 (Phase 5): Nova comments on a helper's report.** Jeremy's call.
After a helper's report is delivered (ok, not stopped), the runner starts a
turn with no message from the person (`user {text: '', followup: <handoff
id>}`), prompted with a `<followup>` note asking for its take and the next
step. Nothing is shown for the person's side of that turn.

**2026-10-21 (Phase 5): helpers start fresh.** A helper is its own session
(`kind: "helper"`, hidden from the list) with a scoped context: the base
prompt, AGENTS/SOUL/IDENTITY/USER, skills, its brief and up to five files the
parent passes. No MEMORY.md, day notes, recall or schedules, and memory blocks
it writes are ignored. The parent writes a self-contained brief, which keeps
the helper's context small and its work checkable from the log.

**2026-10-21 (Phase 5): helpers can't nest or schedule.** A step that needs
an OK waits for the person, per Settings (above); `delegate` and
`schedule_*` aren't offered. Up to three run at once and the rest queue. Stop and Try again are
in Activity and on the report; on start, a helper cut off by a shutdown
reports that it didn't finish.

**2026-10-21 (Phase 5): Activity is derived, not stored.** `/api/activity`
reads the session logs and `runs.jsonl` for a week in the person's time zone,
caching each parsed log by size and modified time. Steps keep only a few
arguments (path, url, command, query, name, id, title); tool output stays in
the logs. An `activity` server event (throttled) keeps the "N waiting" count
in the sidebar current.

**2026-10-21 (Phase 5): a fetch that fails is a failed step.** `web_fetch`
now throws on an HTTP error status instead of returning the error page, so
Activity and the transcript don't show a 429 as "Read".

**2026-10-21 (Phase 4): the main conversation is the front page.** "/"
opens one long conversation (`sessions/main.jsonl`) that scheduled reports are
delivered into, and a reply to a report continues there. New conversations
moved to `/new` (+, ⌘⇧O). A report's first sentence is set as a headline, so
the digest reads as a front page rather than a notification.

**2026-10-21 (Phase 4): a schedule is a markdown file with cron.** Front
matter (`name`, `cron`, `deliver`, `once`, `paused`) and the instructions as
the body, in `~/Nova/schedules/`. Five-field cron evaluated on the wall clock
of the configured time zone; a time skipped by daylight saving runs just
after, a repeated one runs once. No scheduler library: the evaluator is under
200 lines and tested on DST edges.

**2026-10-21 (Phase 4): schedules run only while Nova runs.** The scheduler
ticks every 30 s and runs one job at a time. On start, a run missed in the
last six hours runs late, once; older ones are recorded as missed in
`runs.jsonl`. Running while Nova is closed needs an always-on host (the hub
idea), which is out of scope.

**2026-10-21 (Phase 4): unattended runs decline approvals.** A run is its own
session (`kind: "run"`, hidden from the list). Anything that would ask for
approval is declined and recorded as not asked; the model is told to suggest
it in the report. Waiting for a person would stall the queue.

**2026-10-21 (Phase 4): schedules are set through an approval.** The model
uses `schedule_set` and `schedule_remove`, which always show a card with the
exact instructions; `write_file` refuses `schedules/`, so there's no way
around the card. The system prompt forbids promising a follow-up without one.

**2026-10-21: personal data lives outside the code.** The repo is public
(AGPL). Each person's Nova data is one folder of plain files (`NOVA_HOME`,
default `~/Nova`), seeded from `templates/home/`, and a local git repository
with a commit after every reply. Backup is wherever that folder lives. No
database, no sync service. This also fits a later hub-and-spoke deployment:
the data lives with the runner, and inference spokes only see prompts.
Jeremy asked for a recommendation; this is it, and it is a default path only.

**2026-10-21: a text tool protocol, not a framework.** The model ends a message
with one `<tool_call name="…">{json}</tool_call>` block; Nova runs the tool and
calls the model again with the transcript. This keeps `agent_cmd` swappable
and keeps every approval in Nova's hands. Claude Code is run with its own
tools, hooks, MCP servers and settings disabled.

**2026-10-21: four tools.** `read_file` and `write_file` are confined to the
home folder and cannot touch `sessions/`. `exec` always asks first and starts
in `~/workspace`. `web_fetch` reads http(s) pages as text. There is no
"always allow" in Phase 1.

**2026-10-21: the session log is append-only.** Regenerating a reply starts a
new attempt for the same turn; the view shows the newest attempt and the log
keeps all of them. If the server dies mid-reply, the conversation shows the
reply as interrupted, with Regenerate.

**2026-10-21: the agent's environment is cleaned.** When Nova runs inside a
Claude Code session, that session's memory reached `claude -p` through
environment variables, and Nova repeated things it had no business knowing.
Nova now strips `CLAUDE*MEMORY*`, `CLAUDE*ADDITIONAL_DIRECTORIES*` and
`CLAUDE*CLAUDE_MD*` before spawning the agent. Verified: a canary in
`~/.claude/CLAUDE.md` does not reach the model either.

**2026-10-21: the reply ends when the model stops, not when the process
exits.** `claude -p` spends about 2 s on housekeeping after the last token.
Nova finishes at `message_stop` and ends the process, which takes ~2 s off
every step of a tool loop.

**2026-10-21: the scroll budget is judged on Nova's own work per frame.**
The build container has no GPU, so Chromium composites in software and frame
intervals flip between 17 and 33 ms on identical code. The walkthrough traces
the scroll and requires the page's main-thread work to stay under 8 ms a
frame (half the budget); raw intervals are still reported. Older turns use
`content-visibility: auto`, so long threads only lay out what is on screen.

**2026-10-21: no conversation rename or delete in Phase 1.** Restraint: titles
come from the first message, and the files are on disk.

**2026-10-21: localhost only.** The server binds 127.0.0.1 and refuses other
Host headers (DNS rebinding) and cross-site POSTs (a custom header CORS never
grants). Phone access would need `NOVA_HOST` and has no authentication yet;
the server warns when started that way. Not in Phase 1 scope.

**2026-10-22: Nova is the default theme, as one token file (Path A).**
Jeremy kept the existing build rather than restarting. `ui/themes/nova.css`
comes from `design-system-nova.md`, and `nova` is first in `THEMES`, the
fallback in `theme.js`, and the first paint in `index.html` and
`styleguide.html`. Paper, Aurora and Obsidian are unchanged and stay
optional. A browser that already chose a theme keeps it. The Stellar Map is a
later phase.

## Theme token gaps

Era 2's record. Since M3a these themes are packages in `design-systems/`,
and the values below carry over (see the M3a decision above).

None of the three specs defines every token THEMING.md requires. Gaps are
filled from each theme's own palette (mostly `mockups.html`) and marked
`/* derived */` in the token file. Values changed to pass the contract's own
contrast check:

| Theme | Token | Spec | Shipped | Why |
| --- | --- | --- | --- | --- |
| Paper | `--text-2` | `#7A736A` | `#726C63` | 4.38:1 on `--bg`; needs 4.5 |
| Paper | `--text-3` | `#A79D8F` | `#91887B` | 2.5:1 on `--bg`; needs 3 |
| Paper dark | `--accent` | `#C4502B` | `#D9714C` | too dark on evening paper |
| Aurora dark | `--accent-text` | (none) | `#000000` | white on `#7D7AFF` is 3.4:1 |
| Nova | `--accent-text` | `#FFFFFF` | `#0A0A0C` | white on `#6E8CF5` is 3.12:1 |

Contract additions this build needed, proposed for THEMING.md (every theme
defines them, `scripts/check-themes.js` requires them):

- `--font-mono`, `--t-mono`: code, commands, keyboard hints.
- `--t-wordmark`: the sidebar wordmark.
- `--column`: the reading column (680 / 720 / 760 px).
- `--material-blur`: Aurora's frosted surface; 0 elsewhere.
- `--shift`: how far views move when they change; 0 under reduced motion.

Obsidian's spec names differ from the contract (`--panel` is `--surface`,
`--accent-dim` is `--accent-wash`, `--shadow-pop` is `--shadow-2`). Obsidian
is dark in both modes, as its spec defers a light variant.

Nova (default since 2026-10-22, Path A) is dark in both modes too: its spec
defines only the dark workspace. Its starlight tokens and `--folder` are not
shipped yet; they arrive with the surfaces that use them (Stellar Map, Files
explorer). Its spec gives the sidebar `--surface`, but the shared components
paint the sidebar `--bg` and the page `--surface`, so in Nova the sidebar is
the darker of the two. Swapping that is a component change, left for Jeremy.

## Known limits

- Screenshots are rendered on Linux, where New York, Iowan and SF are absent;
  the serif and sans fall back to Liberation/DejaVu. On a Mac, Safari renders
  New York (`ui-serif`) and Chrome renders Iowan Old Style.
- Performance numbers come from the build container, not Jeremy's Mac.
- Margin notes appear when a message matches a dated note. Nothing writes
  dated notes automatically until Phase 2's memory discipline.
