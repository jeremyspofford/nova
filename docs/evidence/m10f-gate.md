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
`e343026f` (#259, the diagnostics bundle), `4881a2b2` (#264, capture-sensitive) and `572ef193` (#258,
the gate on the Decision Service, which took migration 0019: M10f's is now **0020**).

**Reviewed:** the independent review of #268 at `fa2f73cc` found 11 items (1 blocking, 5 should-fix,
5 minor). Each is in "The review of #268" below, with its test, its fix, and the test run with the fix
reverted. The gate items are corrected where the review showed a claim wasn't true (item 2).

## Suite

**After the review**, at `098cc4e2` (main merged at `572ef193`, #258):
- `npm run check`: **1442 tests: 1427 pass, 2 fail, 13 skipped** on this machine, the two being
  `tests/core/provider-guard.test.ts` › "a coding agent that changes more than Nova takes…" (the
  stand-in agent ended without a result) and `tests/skills-api.test.js` › "the email summary…" (timed
  out). Neither touches M10f's code; both pass alone (17 of 17 in those two files), and failed the
  same way in two other full runs here while other builders' suites loaded the machine (load average
  near 6). CI is the record: see the PR.
- `scripts/ui-test.sh` (Chromium and WebKit): **101 tests: 101 pass, 0 fail**. The browser path's
  first win: **2915 ms**.
- Both logs end `no-Kubernetes tripwire: never fired`.

**Before the review** (kept for the record):

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
| `tests/core/onboard-consent.test.ts` | 4 | Review 1: consent in setup fails closed: the reviewer's phrasings and more; under local-only the network waits for the warning |
| `tests/core/roles-bound-work.test.ts` | 3 | Review 2: model roles, downloads and inference need compute; capture needs capture source; narrowing says what stops and stops it |
| `tests/core/sync-skew.test.ts` | 5 | Review 3: one mechanism for a standby a release behind (a 0019 standby against a 0020 hub; an 0018 one; a hub that didn't adapt; the registry complete) |
| `tests/core/mesh-purposes.test.ts` | 7 | The roles and what each kind may hold; pairing with roles (asked, shown, changed on the approval screen, told to the device); a hub candidacy asks on its own at pairing and is in the next signed roster; Settings edits at their tiers, the candidacy confirmed every time and unpinned when removed; devices paired before (migration 0020's backfill (with computers that already serve a model role or capture keeping that role) and the replication triggers carrying the column); the heartbeat answer carrying the roles and the hub's dry run of placement |
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

### 2. Placement on a thin client is refused, and again at the device

**Corrected after the review (finding 6).** The first draft claimed a hub-side Service Manager check
at proposal. It doesn't exist in the running system: the only Service Manager that proposes services
is the supervisor's (`service deploy`, M10e), built without devices. What checks it today, exactly:
- **The hub's dry run** `POST /services/placement` (tier 0, advisory: it deploys and gates nothing)
  refuses a thin-client computer (`mesh-purposes.test.ts`), and since review 4 reads `hub` as the hub.
- **The supervisor driver** (M10e, unchanged) refuses any placement pinned to a device other than the
  hub, so no workload reaches a thin client, or any spoke. Roles don't yet bound what it runs on the
  hub itself.
- **The Service Manager's `placement` option** is built and tested (`services-placement.test.ts` ›
  "checked twice…": refused before any driver is asked), and is wired to the real path with M10h.
- **Work that already reaches a computer** is bounded by its roles since review 2 (model roles,
  downloads, inference, capture).
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

**After the review** (main merged at `572ef193`; under local-only the network now waits for the warning
to be acknowledged, so the path has one more answer):

- Measured (machine speed, from the first GET /setup): **2706 ms**, under the 15-minute bound.
- The human path, estimated: 12 answers, 2 clicks after setup, 786 words shown by Nova. At 200 words a minute, 10 s per answer and 5 s per click: **about 6 min 6 s**. An estimate, not a measurement of a person.

| Step | ms from start |
|---|---|
| setup opened: this computer described | 6 |
| answered device: “new” | 19 |
| answered roles: “yes” | 28 |
| answered backend: “yes” | 33 |
| answered user_name: “Hi! I'm Sam.” | 39 |
| answered timezone: “yes” | 46 |
| answered nova_name: “keep” | 51 |
| answered directness: “plainly, please” | 57 |
| answered privacy: “keep everything on this machine” | 63 |
| answered discover: “this computer and the network too” | 68 |
| answered discover: “yes, look on the network” | 1586 |
| answered import: “all” | 2672 |
| answered first_task: “yes” | 2686 |
| followed “Review what Nova brought in”: the imported note waits in Memory | 2698 |
| kept the imported note | 2703 |
| Nova found it: “Note “Garden plans”: Plant Larkspur by the north fence in sp…” | 2706 |

**Before the review:**

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

## The review of #268

Each finding was reproduced with the reviewer's probe (`m10f-probes/p1`–`p5`) or a test written from
it first, which failed; then fixed; then each fix's guard was removed on its own and its test run
again (`scratchpad/guards2.py`: remove, run the file, put back), on the code at `a96c7640`, where
every one failed. **Order:** for each item the test was written and seen failing before the fix.

| # | Finding | Reproduced? | Fix | Test | With the fix reverted |
|---|---|---|---|---|---|
| 1 | Typed answers turn a no into a yes (BLOCKING) | Yes (p2: "Just this computer, not the network" looked on the network; "I don't want the calendar" read the calendar) | `onboard/consent.ts`: consent fails closed. Negation before a thing leaves it out; only leaves the rest out; "sure, but not X" is all but X; a refusal of one thing asks again; a mention with a bare no asks again. A network yes under local-only waits for the warning to be acknowledged (its own choices: yes, this computer only, no) | `onboard-consent.test.ts` (the reviewer's 7 phrasings, 40 more, in the parser and in setup) | Each of 5 guards fails 1–3 tests (negation, bare no, refusal-not-yes, the acknowledgement, asking again) |
| 2 | Roles don't bound model and capture work on a computer | Yes (p1: a thin-client computer took the reasoner role and a download) | Model roles, downloads (asked and when run) and inference to a paired computer need compute; capture from it (offered, taken in, turned on) needs capture source; the hub is exempt (it runs Nova and its own models). Narrowing names what stops ("its thinking and writing model", a capture source's name) and stops it (inference refused, sources turned off); the sheet asks with `dry_run`. Computers already doing that work get the role in 0020. No other path puts work on a spoke today (browser, coding, infra, the computer and Relay run on the hub; the inbox's tasks run on the hub) | `roles-bound-work.test.ts` (3), the 0020 backfill in `mesh-purposes.test.ts`; existing capture and model tests now enroll computers with the role | 9 guards, each fails its test |
| 3 | A standby one release behind refuses the batch | Yes (p4: a 0018 standby refused the whole batch for `device.purposes`) | One mechanism, `ADDED_COLUMNS` in `mesh/sync.ts` (receipt.opt_in at 19, device.purposes at 20): the standby says its schema when it pulls, the hub leaves out what it lacks (unstated: taken as 19); a standby that gets one anyway leaves it out and records a problem once (#258's receiving side, kept). 0020 remakes the receipt triggers to carry opt_in always, so #258's case uses it too. The always-true `logged.length >= 0` is replaced | `sync-skew.test.ts` (5), `mesh-purposes.test.ts` (the logged row carries every column), `mesh-sync.test.ts` (a real standby gets the roles), #258's `gate-review.test.ts` case rewritten to the mechanism | 4 guards, each fails |
| 4 | After a failover the new hub can't take hub services | Yes (p5: the promoted standby held only hub candidate) | Promotion gives the new hub's record the hub's fixed roles (hub candidate, general server): one rule, the record says what is true, Settings shows it. Chosen over a resolver special case for "the active hub" | `mesh-sync.test.ts` › promotion (roles, and the dry run pinned to `hub` resolving to the new hub) | Fails |
| 5 | mDNS matching is quadratic | Yes (p3: 16 × 3600 PTRs, 14.9 s) | Answers indexed by name; 256 answers read per reply, 64 instances per discovery (64 replies were already the cap); names over 255 bytes, a TXT string past its record and a cut-off question refused; TXT with no prototype | `onboard.test.ts` › "hostile mDNS replies" (the probe's packing: now about 7 ms) | 5 guards, each fails |
| 6 | The evidence claims a hub-side proposal check that doesn't exist | Yes | Gate item 2, the plan §2 and the LEDGER now say exactly what checks it today (above) and what waits for M10h | — (records) | — |
| 7 | The human estimate's minutes rounded up | Yes ("about 6 min 52 s" for 352 s) | `Math.floor` | `fresh-user.test.ts` | — (arithmetic) |
| 8 | Placement wording, a removed device, floating | Yes (p5) | Leaving a device says why (gone, no longer allowed, or silent past the window); a removed device counts as moved; floating copies keep their device through the window | `services-placement.test.ts` › "review finding 8" | 3 guards, each fails |
| 9 | Copy promises unbuilt things | Yes | No reinstall promise; switching named only on Linux; no "would run" or "would add"; the device step no longer says Settings › Services changes anything | `onboard.test.ts` › "review finding 9" | Fails |
| 10 | Import checks per file only, labels, a swapped file, Bookmarks size | Yes | Each record through Nova's own checks, as `importPack`; labels matched exactly, case and all; every file read with `O_NOFOLLOW | O_NONBLOCK` and `fstat` (a link or a pipe refused, no hang); caps: Bookmarks 8 MB, `.ics` 1 MB, places 64 MB | `onboard.test.ts` › "review finding 10", `onboard-consent.test.ts` (labels) | 3 guards, each fails |
| 11 | `PATCH /mesh/devices` mixes changes, keeps a rename | Yes | One change per call; a mixed call is refused whole | `mesh-purposes.test.ts` › "review finding 11" | Fails |

The guard runs:

| Guard removed (finding: guard) | Test file | Result |
|---|---|---|
| 1 negation leaves a thing out | `tests/core/onboard-consent.test.ts` | caught: 3 failing: in setup: the reviewer’s phrasings look and read only what was said yes to; what to bring in: negations leave a source out, “only” leaves the rest out, and a bare refusal reads nothing; whe |
| 1 a bare no with a mention is unclear | `tests/core/onboard-consent.test.ts` | caught: 2 failing: in setup: the reviewer’s phrasings look and read only what was said yes to; where to look: “not the network”, “only this computer” and the like never look on the network; unclear asks again |
| 1 a refusal of one thing is not a yes to the rest | `tests/core/onboard-consent.test.ts` | caught: 2 failing: in setup: the reviewer’s phrasings look and read only what was said yes to; what to bring in: negations leave a source out, “only” leaves the rest out, and a bare refusal reads nothing |
| 1 local-only: the warning acknowledged first | `tests/core/onboard-consent.test.ts` | caught: 1 failing: under local-only, looking on the network waits for the warning to be acknowledged; anything else looks on this computer only or asks |
| 1 setup asks again when unclear | `tests/core/onboard-consent.test.ts` | caught: 1 failing: in setup: the reviewer’s phrasings look and read only what was said yes to |
| 2 a model role needs compute | `tests/core/roles-bound-work.test.ts` | caught: 1 failing: a thin client, or a computer without compute, gets no model role and no download |
| 2 a download needs compute | `tests/core/roles-bound-work.test.ts` | caught: 2 failing: a thin client, or a computer without compute, gets no model role and no download; with compute it may; taking compute away says its reasoner model stops there, and no model work goes to it  |
| 2 inference needs compute | `tests/core/roles-bound-work.test.ts` | caught: 1 failing: with compute it may; taking compute away says its reasoner model stops there, and no model work goes to it after |
| 2 capture taken in only from a capture source | `tests/core/roles-bound-work.test.ts` | caught: 1 failing: capture from a computer needs capture source: offered, taken in and turned on only then; taking it away turns its sources off |
| 2 capture offered only by a capture source | `tests/core/roles-bound-work.test.ts` | caught: 1 failing: capture from a computer needs capture source: offered, taken in and turned on only then; taking it away turns its sources off |
| 2 capture turned on only on a capture source | `tests/core/roles-bound-work.test.ts` | caught: 1 failing: capture from a computer needs capture source: offered, taken in and turned on only then; taking it away turns its sources off |
| 2 narrowing turns capture off | `tests/core/roles-bound-work.test.ts` | caught: 1 failing: capture from a computer needs capture source: offered, taken in and turned on only then; taking it away turns its sources off |
| 2 narrowing says what stops | `tests/core/roles-bound-work.test.ts` | caught: 1 failing: capture from a computer needs capture source: offered, taken in and turned on only then; taking it away turns its sources off |
| 2 the migration keeps what computers already do | `tests/core/mesh-purposes.test.ts` | caught: 1 failing: devices paired before roles: phones and browsers are thin clients, the standby a hub candidate, computers what they already do, the hub its own |
| 3 the hub leaves out what the standby lacks | `tests/core/sync-skew.test.ts` | caught: 2 failing: a 0019 standby against a 0020 hub: the hub leaves out device.purposes for it, and the whole batch lands; a standby that doesn’t say its schema is taken to be on 19 |
| 3 the standby says its schema | `tests/core/mesh-sync.test.ts` | caught: 2 failing: a standby catches up from nothing, keeps up, refuses changes, and gets forgetting right, backups included; promotion: a new epoch, a roster signed by the standby’s own key, a verified ledge |
| 3 a standby leaves out a column it lacks, and says so | `tests/core/sync-skew.test.ts` | caught: 1 failing: a hub that didn’t adapt: the standby leaves the column out, says once it is behind, and the rest of the batch lands |
| 3 the receipt triggers carry opt_in always | `tests/core/sync-skew.test.ts` | caught: 5 failing: a 0019 standby against a 0020 hub: the hub leaves out device.purposes for it, and the whole batch lands; a hub that didn’t adapt: the standby leaves the column out, says once it is behind,  |
| 4 a promoted standby holds the hub roles | `tests/core/mesh-sync.test.ts` | caught: 1 failing: promotion: a new epoch, a roster signed by the standby’s own key, a verified ledger record; the old hub fences itself; revoked stays revoked |
| 5 instances capped and indexed | `tests/core/onboard.test.ts` | caught: 1 failing: hostile mDNS replies: bounded work |
| 5 answers per reply capped | `tests/core/onboard.test.ts` | caught: 1 failing: hostile mDNS replies: bounded work |
| 5 TXT within its record | `tests/core/onboard.test.ts` | caught: 1 failing: hostile mDNS replies: bounded work |
| 5 TXT with no prototype | `tests/core/onboard.test.ts` | caught: 1 failing: hostile mDNS replies: bounded work |
| 5 names within 255 bytes | `tests/core/onboard.test.ts` | caught: 1 failing: hostile mDNS replies: bounded work |
| 8 why it leaves a device that lost its role | `tests/core/services-placement.test.ts` | caught: 1 failing: review finding 8: a device that lost its role is said so, not “hasn’t answered”; a removed device counts as moved; floating waits out one late heartbeat |
| 8 a removed device counts as moved | `tests/core/services-placement.test.ts` | caught: 1 failing: review finding 8: a device that lost its role is said so, not “hasn’t answered”; a removed device counts as moved; floating waits out one late heartbeat |
| 8 floating waits out a late heartbeat | `tests/core/services-placement.test.ts` | caught: 1 failing: review finding 8: a device that lost its role is said so, not “hasn’t answered”; a removed device counts as moved; floating waits out one late heartbeat |
| 9 no reinstall promise | `tests/core/onboard.test.ts` | caught: 1 failing: review finding 9: the backend and device words claim nothing unbuilt: no reinstall promise, no “would run”, switching only where K3s could come |
| 10 each record checked | `tests/core/onboard.test.ts` | caught: 1 failing: review finding 10: each record checked as importPack does, a file swapped for a link or a pipe refused at import, Chromium bookmarks capped |
| 10 no reading through a link | `tests/core/onboard.test.ts` | caught: 1 failing: review finding 10: each record checked as importPack does, a file swapped for a link or a pipe refused at import, Chromium bookmarks capped |
| 10 Chromium bookmarks capped | `tests/core/onboard.test.ts` | caught: 1 failing: review finding 10: each record checked as importPack does, a file swapped for a link or a pipe refused at import, Chromium bookmarks capped |
| 11 one change per call | `tests/core/mesh-purposes.test.ts` | caught: 1 failing: review finding 11: one change per call: a rename with a roles change |

## Guards removed, one at a time, to show their tests fail (before the review)

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

- **"Checked when a change is proposed"** is not met on the real proposal path yet (review finding 6):
  the supervisor's Service Manager isn't given devices; M10e's "this hub only" rule holds there, and
  the hub's dry run is advisory. Wiring waits for M10h, when something first deploys to a spoke.
- **The hub's own roles** don't bound its own models or the services the supervisor runs on it: the
  hub runs Nova. Roles bound paired computers.

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

- **The real migration path** from a deployed 0019 hub has been tested in process (the backfill test),
  not on a real home.
- **Two releases behind:** a standby on code from before #258 that is sent `receipt.opt_in` (now always
  in the log) still refuses it, as it did for a set opt_in before. The hub leaves it out only for a
  standby that says it is on 18; one that says nothing is taken to be on 19.

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
