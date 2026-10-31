# M10f gate evidence: device roles, placement, and onboarding (supervisor only)

The ADR is `docs/plans/M10-orchestration.md` (Point 5, Point 9, Point 11, Decision 2, Hard limits,
Order), with Amendment 2026-10-31-B Part 2 folded in, and the plan is `docs/plans/M10f.md`.
Everything here ran on 2026-10-31 on this machine (WSL2, Node 26.3.1), in temp folders made with
`mkdtemp(os.tmpdir())`. Discovery ran only against stand-ins on 127.0.0.1 (`tests/support/fake-mdns.ts`:
a model runtime answering `/api/version`, and an mDNS responder answering by unicast for a
placeholder Home Assistant and a computer, at documentation addresses 192.0.2.x). No multicast was
sent, no real network was looked at, no real device was paired, and nothing was deployed to a spoke.
No Kubernetes, Helm or Flux was installed or run; the no-Kubernetes tripwire was armed for every run.

The branch is `m10f/roles-onboarding`, from main at `c0bae29d` (M10e merged), with main merged in at
`e343026f` (#259, the diagnostics bundle) and `4881a2b2` (#264, capture-sensitive; docs and the
decision service only, no overlap with this phase's code).

## Suite

`npm run check` passes (token lint, themes, typecheck, the suite under the tripwire): **1341 tests:
1329 pass, 0 fail, 12 skipped** (the existing opt-in real-service tests), at `ccbb94bf` (main merged
at `e343026f`); and again after merging main at `4881a2b2` (#264), at `e8042e95`: **1359 tests: 1346
pass, 0 fail, 13 skipped**. The log ends `no-Kubernetes tripwire: never fired`.

`scripts/ui-test.sh` (the Playwright image, Chromium and WebKit, under the tripwire), at `ccbb94bf`:
**100 tests: 100 pass, 0 fail**; the log ends `no-Kubernetes tripwire: never fired`. Screenshots in
`docs/screenshots/m10f/`; the M3 setup screenshots (`docs/screenshots/m3/setup-*`) were taken again,
since setup now starts with this device.

The new and changed tests:

| File | Tests | What it proves |
|---|---|---|
| `tests/core/mesh-purposes.test.ts` | 6 | The roles and what each kind may hold; pairing with roles (asked, shown, changed on the approval screen, told to the device); a hub candidacy asks on its own at pairing and is in the next signed roster; Settings edits at their tiers, the candidacy confirmed every time and unpinned when removed; devices paired before (migration 0019's backfill and the replication triggers carrying the column); the heartbeat answer carrying the roles and the hub's dry run of placement |
| `tests/core/services-placement.test.ts` | 7 | The resolver, one test per mode (pinned, preferred plus failover, floating) and per refusal; the failover when a stand-in stops heartbeating past the window; the validator placing by workload roles only; checked twice (the Service Manager at proposal, before any driver; the device agent's own check) |
| `tests/core/onboard.test.ts` | 7 | The device detected (WSL2 told apart); the per-OS backend words (supervisor pre-selected and the only available choice; K3s shown on Linux as not available, offered nowhere else); the mDNS codec; discovery on loopback stand-ins (found, never connected; the network query only when asked, bound to 127.0.0.1); import sources listed without opening a file, only what is picked read and screened, a blocked file held back; setup end to end in the core in the ADR's order, ending on the first view with one action; the closing rule |
| `tests/core/setup.test.ts` | 10 (changed) | The conversation now starts with the device; `answer()` is async |
| `tests/ui-onboarding.test.js` | 5 | The screen's role words are the hub's; the approval sheet's roles and candidacy box; the tiered roles review; the Services category and search; the empty states with one action |
| `tests/ui/m10f-onboarding.test.ts` | 6 | In Chromium: setup on stand-in Linux, macOS, Windows and WSL2 detections; the whole first session by clicking with the first win in Memory, timed; pairing with roles on the approval sheet, the candidacy confirmed on its own, roles changed in Settings › Devices at their tiers, Settings › Services |
| `tests/acceptance/fresh-user.test.ts` | 1 (extended) | The blank-profile fresh-user test, with onboarding, discovery on loopback, the import, the first view and the timed first win |
| `tests/acceptance/m4b-device-agent.test.ts` | 2 (extended) | The real device agent keeps the roles the hub holds for it, heard in a heartbeat answer |

## Gate items

### 1. Pairing with roles, in the browser; the approval screen shows and can change them

- `tests/ui/m10f-onboarding.test.ts` › "pairing with roles…": a computer (a stand-in speaking the
  protocol) asks to be compute and storage; the hub's approval sheet in Chromium shows both ticked;
  the person unticks storage and ticks hub candidate there; the device record gets exactly
  `['hub-candidate', 'compute']`. Screenshot `docs/screenshots/m10f/approval-roles.png`.
- `mesh-purposes.test.ts` › "pairing with roles…": `GET /mesh/requests` carries `purposes` (asked),
  `allowed` and `fixed`; `POST /mesh/requests/{id}/approve {purposes}` decides; the device's status
  poll returns what it was approved for. A phone asking for storage is refused at join; the approval
  screen can't give a phone work either.
- `/pair` says a phone or browser is a thin client (`ui/js/pair.js`, `#pair-role`); the computer's
  command takes `--roles compute,storage` (`src/device/boot.ts`, passed through by `join.sh`).

### 2. Placement on a thin client is refused at proposal and again at the device

- At proposal: `services-placement.test.ts` › "checked twice…": a Service Manager given the hub's
  devices refuses a definition pinned to a thin-client laptop or a phone before any driver is asked
  (the recording driver's `plan` is called 0 times), naming the reason; `mesh-purposes.test.ts` ›
  the hub's dry run `POST /services/placement` refuses a thin-client computer.
- At the device: `assignmentAllowed` (`src/device/trust.ts`) refuses a thin client, a device with no
  workload role, a device that never heard its roles, and one missing the role a workload asks for.
  The boot agent keeps its roles in `device.json` from the approval and each heartbeat answer:
  `m4b-device-agent.test.ts` shows the real agent picking up `compute` after the hub widened it.
  `BootAgent.mayRun` is what native workloads (M10h) will call; nothing calls it yet.

### 3. An edit in Settings › Devices is tiered

`mesh-purposes.test.ts` › "Settings › Devices…": widening without `confirm` is refused (an
`approved` OK isn't enough); narrowing without `approved` is refused, saying "nothing stops"
(nothing runs on other devices before M10h); a revoked device's roles can't change; the hub keeps
hub candidate and general server. In Chromium (`m10f-onboarding.test.ts`): the Roles sheet, then a
review at tier 3 (Change roles disabled until the box) for widening, at tier 2 for narrowing,
saying nothing stops. Screenshot `docs/screenshots/m10f/roles-narrow.png`.

### 4. A hub candidacy asks at tier 3, at pairing and later, and pins its key in the next roster (Decision 2)

`mesh-purposes.test.ts` › "a hub candidate asks…": approving a computer that asked to be a hub
candidate without `confirm_candidate` is refused; with it, the next signed roster (verified against
the hub's key) lists the device's id and key under `candidates`. Later: adding the role in Settings
needs `confirm_candidate` on top of `confirm`; removing it drops the key from the next roster. In
Chromium, the approval is refused until the candidacy's own box is ticked.
**Said plainly:** device agents still pin only the hub's and the standby's keys (see Where the ADR
didn't fit).

### 5. Resolver tests, one per mode and per refusal; a failover past the window

`services-placement.test.ts`: preferred (the compute device with the most GPU memory; Apple's unified
memory counted at three quarters); preferred plus failover (stays while healthy, stays 30 s into a
60 s window and says so, moves at 90 s, a named failover that is down means down); pinned (that
device; down means the service is down; a thin client refused); floating (best first, saying when
fewer can); refusals (no workload role, a missing role, hardware not reported, too little GPU memory,
memory or disk, no program for the platform, containers off Linux, an unknown need, revoked, a phone
whatever its record says).

### 6. Browser tests of the flow on stand-in Linux, macOS, Windows and WSL2, each with its own summary; the supervisor pre-selected

`m10f-onboarding.test.ts`, four tests (`NOVA_DETECT_OS`): each shows "This is a <OS> computer", the
hub's roles with general server ticked and fixed, then its own backend summary; the only pressable
choice is "Ordinary programs, under Nova’s supervisor", styled as the standout; on Linux, K3s shows
as "Not available yet" and can't be pressed; on macOS, Windows and WSL2 it isn't there. Screenshots
`docs/screenshots/m10f/setup-backend-{linux,macos,windows,wsl2}.png`.

### 7. Settings › Services

A new category (`ui/js/settings-ia.js`, `ui/js/services.js`) from `GET /api/v1/services/backend`:
the backend in use, what it means on this OS, and "Switching to K3s isn’t available yet, so there is
nothing to switch to." It has no button. The tier-3 switch is M10k's (the ADR's gate item "the switch
in Settings › Services asks at tier 3" can't be met before there is a second backend).
Screenshot `docs/screenshots/m10f/settings-services.png`.

### 8. Discovery, import, the first view, empty states (Amendment B Part 2)

- Discovery: `onboard.test.ts` › "discovery, on loopback stand-ins only…": this computer only sends
  no query onto the network; the network too sends one query for both service types, from a socket
  bound to 127.0.0.1; each found thing is `connected: false`; the stand-in runtime saw only
  `GET /api/version`. Under local-only, the question says first that looking on the network sends a
  query onto it.
- Import: `onboard.test.ts` › "import sources…": a note made unreadable (mode 000) is still listed,
  so finding never opens a file; only the picked sources are read; every file is screened before
  anything is offered; a blocked note is held back with the reason; each memory waits as a
  candidate with its source. In the core and in the fresh-user test, nothing imported is in memory
  until the person keeps it.
- The first view: what was found, what was brought in, this computer's roles and backend, and one
  action, the one standout (`m10f-onboarding.test.ts`: exactly one `.btn.primary`). Screenshot
  `docs/screenshots/m10f/first-view-phone.png`.
- Empty states on the first session's path (Home's conversation, Memory, Tasks, the Devices card):
  orient, the value, one action (`tests/ui-onboarding.test.js`).

### 9. The fresh-user test, with the timed first win

`tests/acceptance/fresh-user.test.ts`: the real server as its own process on a blank home, with the
egress tripwire preloaded, local-only. Every check it had still holds (the profile, the welcome note
verified with Nova's evidence and checked again from disk, an extension in and out, a restart, no
problems, no connection off the machine). New: the device steps; the backend step's choices (the
supervisor the only one selected; K3s never available); discovery against the loopback stand-ins
(three things found, each `connected: false`; the stand-in runtime saw one GET); the import of the
blank user's notes, calendar file and bookmarks; the first view with `review-imports` as its one
action; then the first win: the imported note waits in Memory and is not memory; the person keeps
it (`POST /api/memory/candidates/{id}/keep`); `GET /api/v1/memory/search?q=Larkspur` finds it. The
clock runs from the first `GET /setup`, and the test fails at 15 minutes.

- Measured (machine speed, from the first GET /setup): **1759 ms**, under the 15-minute bound.
- The human path, estimated: 11 answers, 2 clicks after setup, 773 words shown by Nova. At 200 words a minute, 10 s per answer and 5 s per click: **about 6 min 52 s**. An estimate, not a measurement of a person.

| Step | ms from start |
|---|---|
| setup opened: this computer described | 132 |
| answered device: “new” | 140 |
| answered roles: “yes” | 145 |
| answered backend: “yes” | 151 |
| answered user_name: “Hi! I'm Sam.” | 156 |
| answered timezone: “yes” | 159 |
| answered nova_name: “keep” | 163 |
| answered directness: “plainly, please” | 168 |
| answered privacy: “keep everything on this machine” | 172 |
| answered discover: “this computer and the network too” | 1697 |
| answered import: “all” | 1728 |
| answered first_task: “yes” | 1737 |
| followed “Review what Nova brought in”: the imported note waits in Memory | 1751 |
| kept the imported note | 1756 |
| Nova found it: “Note “Garden plans”: Plant Larkspur by the north fence in sp…” | 1759 |

The browser path (`tests/ui/m10f-onboarding.test.ts`, Chromium at phone width, by clicking and typing,
ending with Keep pressed in Memory): **3064 ms** in the full UI run (2852 ms on its own run), from
opening the page to Nova finding the kept note; its step times are in
`docs/screenshots/m10f/first-win-browser.txt`.

### 10. The closing rule

`onboard.test.ts` › "the closing rule…": every first action's tags are demonstrated by regression
tasks (`evals.demonstrated(TASKS)`), and every `onboard.*` claim in `tests/evals/claims.ts` is in its
file and either backed (`import`, `memory-review`, `first-run`) or carries a note naming the test or
evidence it is worded to. The register's own check (`tests/core/evals.test.ts`) finds no drift.

| Claim | Words | Backing |
|---|---|---|
| `onboard.import-waits-for-ok` | “then waits in Memory for your OK: none of it is remembered until you keep it” | `memory.import-waits-for-ok` (regression) |
| `onboard.first-action-review` | “It waits in Memory for your OK. Keep what is right; nothing is remembered until you do.” | `memory.import-waits-for-ok` |
| `onboard.first-action-import-folder` | “… in ~/workspace/import/, then tell Nova. They wait in Memory for your OK.” | `grounding.fresh-start`, `memory.import-waits-for-ok` |
| `onboard.discovery-finds-only` | “Looking only finds them: nothing is connected, and nothing is read.” | Worded to `tests/core/onboard.test.ts`; no golden task |
| `onboard.backend-runs-today` | “Everything Nova does today runs this way; nothing in Nova needs Kubernetes.” | Worded to M10e's tripwire evidence; not an agent outcome |
| `onboard.thin-client-runs-nothing` | “A screen onto Nova. It never runs anything for Nova.” | Worded to `tests/core/services-placement.test.ts`; no golden task |

## Guards removed, one at a time, to show their tests fail

Each guard was removed on its own (`scratchpad/guards.py` in the build session: replace the guard,
run the test file that should catch it, put it back), on the code at `138b33e4` (the last row at `0e46269f`):

| Guard removed | Test file | Result |
|---|---|---|
| thin client refused by the resolver | `tests/core/services-placement.test.ts` | caught: 4 failing: checked twice: a placement on a thin client is refused at proposal, and again by the device agent; pinned: that device only; down means the service is down; a thin client is refused; preferred: an inference service resolves to the compute device with the most GPU memory; refusals: no workload role, |
| the proposal check in the Service Manager | `tests/core/services-placement.test.ts` | caught: 1 failing: checked twice: a placement on a thin client is refused at proposal, and again by the device agent |
| the device agent refuses without a workload role | `tests/core/services-placement.test.ts` | caught: 1 failing: checked twice: a placement on a thin client is refused at proposal, and again by the device agent |
| failover only past the window | `tests/core/services-placement.test.ts` | caught: 1 failing: preferred plus failover: stays while its device is healthy or briefly away, then moves past the window |
| widening needs confirm (tier 3) | `tests/core/mesh-purposes.test.ts` | caught: 1 failing: Settings › Devices: widening is tier 3, narrowing tier 2 saying what stops, a candidacy confirmed every time and unpinned when removed |
| narrowing asks first (tier 2) | `tests/core/mesh-purposes.test.ts` | caught: 1 failing: Settings › Devices: widening is tier 3, narrowing tier 2 saying what stops, a candidacy confirmed every time and unpinned when removed |
| a candidacy confirmed on its own, in Settings | `tests/core/mesh-purposes.test.ts` | caught: 1 failing: Settings › Devices: widening is tier 3, narrowing tier 2 saying what stops, a candidacy confirmed every time and unpinned when removed |
| a candidacy confirmed on its own, at pairing | `tests/core/mesh-purposes.test.ts` | caught: 1 failing: a hub candidate asks at tier 3 at pairing, on its own, and its key is pinned in the next roster |
| the candidate pinned in the roster | `tests/core/mesh-purposes.test.ts` | caught: 1 failing: tests/core/mesh-purposes.test.ts |
| a phone can only be a thin client | `tests/core/mesh-purposes.test.ts` | caught: 2 failing: pairing with roles: the device asks, the approval screen shows them and the person changes them there; the roles: what each kind may hold, a thin client is a screen only, and the tier of a change |
| the heartbeat answer carries the roles | `tests/core/mesh-purposes.test.ts` | caught: 1 failing: the hub tells a computer its roles in every heartbeat answer, and a dry run of placement refuses its thin client |
| import: a blocked file is held back | `tests/core/onboard.test.ts` | caught: 1 failing: import sources: listed by place without reading a file; only what is picked is read, screened, and left waiting |
| import: every file screened before it is offered | `tests/core/onboard.test.ts` | caught: 1 failing: import sources: listed by place without reading a file; only what is picked is read, screened, and left waiting |
| discovery: the network query only when asked | `tests/core/onboard.test.ts` | caught: 1 failing: discovery, on loopback stand-ins only: found and named, never connected; the network query bound to 127.0.0.1 |
| the backend: K3s never available | `tests/core/onboard.test.ts` | caught: 1 failing: the backend, per OS: the supervisor pre-selected everywhere; K3s never offered as working; switching said to be in Settings › Services |
| the first view: one action that fits | `tests/core/onboard.test.ts` | caught: 1 failing: setup, end to end in the core: the ADR’s order, discovery and import on loopback, the populated first view with one action |
| discovery asked for: "no" looks for nothing | `tests/core/setup.test.ts` | caught: 2 failing: every question can be skipped, and the defaults hold; the whole conversation writes the profile and ends with a verified first task |
| phones and browsers refused by the resolver | `tests/core/services-placement.test.ts` | caught: 1 failing: refusals… (first missed, since every phone fixture was also a thin client; a case with a phone record holding compute was added, then caught) |

The browser's own checks (the approval sheet refusing to send without the candidacy box, the review
sheet's disabled button) sit in front of the hub's refusals; with them removed, the browser test
still passes on the hub's refusal (the same words reach the toast). They are conveniences, not the
guard.

## Where the ADR didn't fit the code

- **"Pins its key in the next roster"** is met as the signed roster naming every candidate
  (`candidates`). Device agents keep trusting only the hub's and the standby's keys: the same pinned
  keys verify runtime bundles (`verifyBundle`), so trusting a candidate's key before M10g's fencing
  covers candidates would let any candidate sign a runtime. M10g widens it with fencing.
- **"Checked when a change is proposed"**: the hub's Service Manager and dry run check it; the
  supervisor's own Service Manager (its command line, M10e) isn't given the hub's devices, since the
  supervisor doesn't read the hub's database, so there placement stays "this hub only", as in M10e.
- **The switch in Settings › Services asking at tier 3** (Point 11's gate): there is nothing to switch
  to until K3s exists (M10j/M10k). Settings › Services exists and says so; no switch is offered.
- **The backend wording**: the ADR's draft for Windows and macOS names capture on every device and
  services on other devices (M10h), and Linux's names K3s's minimums next to this computer's (M10k).
  Cut to what is true now (the closing rule).
- **A standby's candidacy**: the ADR says a candidacy is tier 3 every time. A standby's approval is
  already tier 3 and makes it a device that takes over; the ADR exempts standbys paired before. New
  standbys are treated the same: their approval is their candidacy, with no second box.
- **One installer for every platform, a PowerShell one-liner**: not built (the ADR names them in
  Point 11's "What's new", not in its gate); `join.sh` is still the computer's only front door.
- **Setup's order**: the ADR's four device steps come first; Amendment B's discovery and import come
  after the privacy question, so a local-only answer is known before anything looks at the network.

## Limits

- Discovery's real path (one multicast query from an ephemeral port, 224.0.0.251:5353) has run only
  as the same bytes by unicast to a loopback responder. It hasn't been tried on a real network, and
  the egress tripwire sees TCP only, not UDP.
- The first win is measured at machine speed. The human path is an estimate (words read at 200 a
  minute, 10 s per answer, 5 s per click), not a person timed.
- The empty-state pattern is applied on the first session's path (Home's conversation, Memory, Tasks,
  the Devices card). Settings' smaller empty lines (no rules, no changes, no checkpoints, no capture
  source) are unchanged, to keep out of the parallel copy and posture work.
- Import reads Markdown and text notes (50 files, 256 KB each), `.ics` files, and Chromium-family and
  Firefox bookmarks, on Linux, macOS and Windows paths; only the Linux paths are exercised.
- Nothing is placed on a spoke and nothing calls `BootAgent.mayRun` before M10h.
