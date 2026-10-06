# S42a — the agent on every OS

## Status

Merged 2026-09-28 as PR #80 (`dcde74c4`), deployed the same day, and walked
the same day: four of the plan's walk steps passed on the Windows agent, and
the "retire the WSL agent" step was skipped because the owner chose to keep
the old WSL agent running (see The walk, below). Final whole-branch review
(opus): "Ready to merge? With fixes." No Critical. The three Important
findings were fixed in one final wave and re-reviewed clean: "Ready to
merge? Yes, once the carries section is written." CI is green on every
`novad` and `novad-native` leg across three runs, and the gate suites
(below) are green apart from main's own known regex-timing edge on this
hardware.

## What shipped

Twenty build tasks, each implemented, reviewed, and where the review found an
Important issue, fixed and re-reviewed clean. Commits below are the CURRENT
SHAs on this branch (Tasks 1-15 were replayed onto a new base by the
2026-09-27 rebase onto main; Tasks 16-20 and everything after were built on
top of that rebase and never moved again).

- **Task 1** — `internal/platform`: the one OS seam for Linux, macOS and
  Windows (the machine-UID source per OS, disk/paths, OS-version parsing).
  `6ff67b62`.
- **Task 2** — the dispatch table (`caps.Dispatch`, `caps.Names()`),
  `system.info`, and `system.notify` per OS (Windows toast via PowerShell 5.1
  `-EncodedCommand`; macOS `osascript`; Linux unchanged). `facts.refresh` is
  registered here as the dispatch table's first capability (P8). `47a66713`.
- **Task 3** — `apps` per OS (list/launch installed applications: Linux XDG
  desktop files, macOS `.app` bundles via `open -a`, Windows `Get-StartApps` /
  `explorer.exe shell:AppsFolder`) — the build compiles for all six targets
  (3 OS x amd64/arm64). `e172bbae`.
- **Task 4** — `shell.exec`'s process-group lifecycle: the whole group dies on
  cancel or timeout on every OS, and a dropped connection is never reported
  "ran". 3 review-driven fix rounds: round 1 made the outcome follow what
  actually happened to the process rather than ctx state at return; round 2
  made Windows `Cancel` answer for the ROOT process only, never the group or
  `taskkill`'s own exit code; round 3 pinned the root's own process handle
  (`os.Process.WithHandle`) instead of reopening it by PID. `c3da4ff9`,
  `2a8402b2`, `8f69f2fb`, `b0dc6019`.
- **Task 5** — custody per OS: a protected DACL on Windows (SYSTEM plus the
  owning user only), and `Wipe` for a revoked device. 1 fix round: `Wipe` now
  `Lstat`s before deciding a file is missing, and never overwrites an earlier
  `.revoked-<unix>` set-aside. `e8f39f2e`, `acbad5a2`.
- **Task 6** — `internal/facts` (the machine-UID hash, WSL detection from the
  kernel release string), enroll sends its real `runtime.GOOS`, and `novad
  enroll` refuses inside WSL (`novad run` does not). `aa0034a7`.
- **Task 7** — facts on the wire: in the auth frame, a facts frame right
  after `ready`, and the `facts.refresh` command. 1 fix round: auth-facts
  gathering got its own 5 s budget so a hung platform call can never block or
  fail the handshake, and a refresh-ordering test race was closed. `4f04f0ad`,
  `703b651d`.
- **Task 8** — liveness: the reconnect backoff resets to 1 s after any
  authenticated session, a ping proves the path is actually alive (not just
  that the kernel accepted the write), and a slept machine reconnects at
  once. 1 fix round: every heartbeat and facts write is now bounded by the
  10 s ping timeout, plus a 1 s wall-clock watchdog beside P12's own slower
  check. `6c075aea`, `cb35600a`.
- **Task 9** — a revoked device is final: the agent wipes its identity and
  stops (`exit 78`, `RestartPreventExitStatus=78` — never a restart loop). 1
  fix round: the wipe now fires only on a refusal core SIGNS with its own
  key over a canonical proof, verified on the device against its PINNED core
  key — closing a path where anyone able to terminate the websocket could
  otherwise permanently un-enroll a device with one frame. `9f7e8ae5`,
  `a9ceb18b`.
  - **CI follow-up** (queued behind Task 20, landed on this branch before CI
    run 2): the two Windows-only ENOTDIR fault-injection tests this task
    added assumed a Unix-only error shape; split by OS with Windows twins
    that use an invalid-name path instead. `aff62866`.
- **Task 10** — core migration `036_agent_facts`: a `platform` CHECK
  constraint and the facts columns a device's agent reports. `01aa8e9b`.
- **Task 11** — `device_facts.py`: validates what an agent says, derives its
  roles, one agent view. `26cc3c8c`.
- **Task 12** — the socket records an agent's facts, enroll holds the
  platform, and a revoke is said as a signed proof. 1 fix round: malformed
  facts (a NUL byte, a lone UTF-16 surrogate) can no longer crash the socket
  or loop the device, and a bad reconnect now clears stale identity to NULL
  instead of leaving it mis-dated. `f8665fd7`, `b5bfcbf0`.
- **Task 13** — a path check in the device's own OS: drives and shares on
  Windows, one spelling. `c29450a4`.
- **Task 14** — the `devices_duplicate_agents` non-urgent check for two Nova
  agents reporting one machine. `a62e8a3b`.
- **Task 15** — `machine_status` groups Nova's agents by machine, and the
  state guard reads what it recorded. 1 fix round: a failed agents-read is
  never reported as "no agents" again, and a new structural scan
  (`_READ_HERE_RECORDED_UP` / `_AGENTS_CALL_CONSUMERS`) pins every
  `.agents(...)` call site to a named, checked consumer. `59c4d5c8`,
  `50b3e60f`.
- **Task 16** — one capability phrase: disowning a Windows or Mac machine is
  now a false denial, since her own agent runs there. A pre-review amendment
  (same implementer, before the reviewer saw it): the timing sweep didn't
  actually reach the new pattern, so it was fixed to walk every pattern it
  claims to cover (162 -> 221 patterns swept, 0 ids lost). `b8ad418c`,
  `e1d4c731`.
- **Task 17** — evals can declare a `devices` fixture; the case
  `points-wsl-at-the-windows-agent`. Eval suite 17 / corpus 30 after the
  rebase's renumbering (S47 had already taken 16/29). `cf706d8e`.
- **Task 18** — the Devices tile in web shows the OS the agent reported, and
  a WSL agent's note. `1eb23dbd`.
- **Task 19** — CI: six targets built twice and compared byte-identical,
  native tests on five runners — `ubuntu-24.04-arm`, `macos-15` and
  `macos-15-intel` (all three with `-race`, per P17), `windows-2025` and
  `windows-11-arm` (plain `go test`; no race detector on Windows). Local
  two-pass reproducibility was independently proven for linux/amd64 and
  windows/amd64 before this ever ran in CI. `ee918bdf`. Pushing, enabling
  `rebuild-ci`, and watching the first run was the controller's own Step 4.
- **Task 20** — the docs say what is true now: README, deploy notes, roadmap,
  this close-out's skeleton, the carries doc. 2 fix rounds: round 1 corrected
  three stale claims (S47 called unbuilt though already merged; the installer
  job called unfinished though it had passed; two of five macOS app
  directories missing from the list); round 2 was one word, matching the CI
  API's own final state ("failure" -> "cancelled"). `2844c367`, `c0024e3a`,
  `6a737a7b`, `11a9fc83`.
- **Final fix wave** (after the whole-branch review, before this close-out):
  I1 (a capability-correction phrase was over-correcting honest sentences),
  I2 (the state guard could credit a device-connectivity fact that had been
  clipped from what she was actually shown), I3 (a Windows root process still
  dying after `taskkill /F` could be reported as "ran, exit 1"), plus nine
  folded one-liners and a scrub of the plan doc for the public repo.
  `586f26a8`, `8a849fd2`, `ec55bd69`, `41900ecf`, `11673952`. Re-reviewed
  clean — see Review rounds, below.

## Decisions made where the spec was silent

These are for the owner to review; each is visible in the code that implements it.

| # | Where the spec is silent | This plan decides |
|---|---|---|
| P1 | Which facts-frame sections S42a fills | `net.ifaces` (`name`, `mac`, `ipv4_cidr[]`, `up`) plus `unreadable[]`. Later slices add their sections (power, ollama, compute, hold, overlay) to core's allow-list beside their validators. |
| P2 | Two frames feed one jsonb column: merge or replace? | Auth facts **replace** `devices.facts` (a new connection is a fresh truth). A `facts` frame **merges** its sections (`jsonb \|\|`). `facts_at` is the time of the last write. Unknown keys are dropped, so stored facts are only what core validated. |
| P3 | Is `machine_uid` raw or hashed? | `sha256("nova/machine-uid/v1:" + lowercase raw id)`, as hex. The raw id never leaves the machine (machine-id(5)). Sources: Linux `/etc/machine-id` (fallback `/var/lib/dbus/machine-id`), macOS `IOPlatformUUID` from `/usr/sbin/ioreg`, Windows `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`. |
| P4 | How WSL is detected, and what is refused | Detection: the kernel release (`/proc/sys/kernel/osrelease` contains `microsoft`), never environment variables, since the systemd unit inside WSL gets none (r1-wake-critique:114). `distro` comes from `WSL_DISTRO_NAME`, or `""`. **`novad enroll` refuses inside WSL**; `novad run` does not. An in-WSL agent reports `os.wsl`, and core derives every role as `cannot: this machine's Windows agent owns it`. |
| P5 | What "revoked" wipes, and how the agent stops | Core sends `auth_error{reason:"revoked"}` **only** for a revoked row; an unknown id gets a different reason. On that exact reason the agent: deletes `config.json` and `key`; renames `audit.jsonl` to `audit.jsonl.revoked-<unix>` (kept, but never replayed under a new id); exits **78**. `novad.service` gains `RestartPreventExitStatus=78`. `novad run` with no enrollment also exits 78. The live-revoke 4403 close is unchanged: the agent reconnects about 1 s later, meets `revoked` at the handshake, and wipes. |
| P6 | Config and state locations per OS | **Linux:** unchanged (XDG), so enrolled daemons keep working. **macOS:** `~/Library/Application Support/novad` for both. **Windows:** config in `%AppData%\novad` (`os.UserConfigDir`, per the spec); state and audit in `%LocalAppData%\novad` (never roams). Both Windows directories get the D-M11 DACL. |
| P7 | The DACL, exactly | SDDL `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;<user SID>)`: protected, SYSTEM plus the owning user, inherited by files. A Windows-runner test reads it back and fails on any other ACE. |
| P8 | The dispatch table's shape | `caps.Handler func(ctx, caps.Request) caps.Outcome`, where `caps.Request` is `{Args, Deps}`. `caps.Dispatch` stays the entry point (S44's isolation test names it). `caps.Names()` derives the list for S30's `daemon.info`. `facts.refresh` is the first capability added. |
| P9 | shell.exec process groups | **Unix:** `Setpgid` plus a `Cancel` that kills the whole group. **Windows:** `CREATE_NEW_PROCESS_GROUP` plus `Cancel` = `taskkill /T /F /PID`. `WaitDelay` is 5 s everywhere. A context cancelled by a dropped connection (not a deadline) is `ok:false` "cancelled"; it used to be reported `ok:true`, exit -1. Windows adds `WSL_UTF8=1` so `wsl.exe` prints UTF-8. |
| P10 | Toast and app mechanisms | **Windows toast:** WinRT via Windows PowerShell 5.1, a constant `-EncodedCommand` script, the message on stdin as UTF-8, and PowerShell's registered AppUserModelID. **macOS notify:** `osascript` with the message as argv (`on run argv`). **Windows apps:** `Get-StartApps` for the list; launch with `explorer.exe shell:AppsFolder\<AppID>`, falling back to a program on PATH. **macOS apps:** scan `*.app`, launch with `open -a`. |
| P11 | "What's on my desktop" on Windows | `system.info` reports `home=` and `desktop=` (the Desktop known folder, which OneDrive may redirect), so the path is read, never guessed. |
| P12 | Liveness details | The backoff resets after any authenticated session. A ping follows each heartbeat, with a 10 s timeout. A wall-clock gap between heartbeat ticks of more than 2 × the interval ends the session: the machine slept. |
| P13 | Grouping "by machine" in S42a | `machine_status` groups agents by `machine_uid`; an agent with none is its own machine. Engines and agents are linked only in S44. `machine_status` records `{"device", "connected"}` for each agent. The state guard accepts any **ok** span that recorded such a fact, not only `device_*` spans. |
| P14 | Duplicate detection | One check, `devices_duplicate_agents`: non-urgent, key `duplicate_agent:<uid[:12]>`, keyed on `machine_uid` only. A WSL agent plus a Windows agent have different ids by construction, so that pair is caught by the WSL role rule. A pre-S42a WSL agent sends no facts at all, so the owner revokes it by hand in the walk. |
| P15 | Eval device fixture | Cases gain a `devices` declaration (`eval_*` names, facts validated by `device_facts.validate_auth`). `machines.FixturePlant.agents()` overlays it. Nothing is written to `devices`. Device *tools* are not intercepted. |
| P16 | Walk topology | The hub is the mini PC. The Windows agent enrolls over `https://nova.<TAILNET>.ts.net`. The distro is `Ubuntu-26.04`. There is no mini-PC-agent step (no such agent exists). |
| P17 | CI | Turn `rebuild-ci` on (the owner's ruling of 2026-09-21 in `s41/rulings.md`: "both halves or neither"). Watch the first run and record red jobs outside S42a as carries. `-race` runs where the race detector exists (Linux and macOS); Windows runners run plain `go test`. |

## Rulings made during the build

Condensed from the SDD ledger's "Ruling:" lines
(`.superpowers/sdd/plan/progress.md`). Major ones first, each with what was
decided, why, and the cost if it's wrong; procedural and test-shape ones are
grouped at the end.

- **Task 4 — an outcome must follow what happened to the process, never ctx
  state at return.** Round 1: take the timed-out/cancelled branch only when
  `Cancel` actually killed the process, or Run's own error is the ctx error.
  Round 2: `Cancel`'s return must be honest about the ROOT process on both
  OSes (unix ESRCH -> `Process.Kill()`; Windows -> a liveness check around a
  bounded, absolute-path `taskkill`). Round 3: pin the root's own handle with
  `os.Process.WithHandle` (also closes a PID-reuse gap). Cost if wrong: a
  killed process misreported as having run, or the reverse — exactly the
  dishonesty class this task exists to remove.
- **Task 5 — `Wipe` must never let a revoked device's audit log replay under
  a new id.** `Lstat` before deciding a file is missing (any non-`ErrNotExist`
  error is returned, not swallowed as "missing"), and choose a set-aside name
  that doesn't already exist rather than overwriting an earlier one. Cost if
  wrong: none beyond a few lines — the unfixed shape was a silent replay of a
  revoked device's history.
- **Task 7 — auth-facts gathering must never block or fail the handshake.**
  Its own 5 s budget, derived from and shorter than the 30 s handshake
  timeout; a killed gather yields empty values plus `unreadable` entries and
  the auth frame still goes out. Cost if wrong: a slow platform call (macOS
  `ioreg`, say) fails every handshake for that device.
- **Task 8 — every heartbeat and facts write is bounded by the 10 s ping
  timeout; a per-session 1 s wall-clock watchdog reconnects within about 2 s
  of resume.** Unbounded, a write stuck on a dead path (the kernel keeps
  accepting bytes into its send buffer) could hold a connection for up to
  110 s (a stuck `facts.refresh`) or the OS's TCP retry ceiling. Cost if
  wrong: one write over 10 s on a live-but-slow link ends a healthy session,
  which then reconnects.
- **Task 9 — a revoked device wipes ONLY on a proof core signs with its own
  key, verified on the device against its PINNED core key.** Before this
  ruling the one destructive path fired on a bare, unsigned
  `auth_error{reason:"revoked"}` string compare — anyone able to terminate the
  websocket (a plain-ws connection to a non-loopback host was accepted; a TLS
  compromise) could permanently un-enroll a device with one frame. Core's
  signing half was carried into, and landed in, Task 12. Cost if wrong: a
  revoked device whose core predates the signing keeps retrying instead of
  wiping — the safe direction.
- **Task 12 — malformed facts can never crash the socket or loop the device,
  and a bad reconnect clears stale identity to NULL.** A NUL byte or a lone
  UTF-16 surrogate in a reported text field previously broke the auth path
  outright or looped the device at roughly 1 s reconnects. This also REVISES
  the pre-flight ruling C-i (which had kept rejected/absent auth facts in
  place, dated by the old `facts_at`): on a verified auth whose facts are
  absent or rejected, both `facts` and `facts_at` now clear to NULL, so
  identity reads "unknown" rather than a misdated stale value. Cost if wrong:
  an agent whose auth facts core rejects shows as unknown until they
  validate — honest, if less informative.
- **Task 15 — an agents-read failure is never reported as "no agents", and
  every reader of `.agents(...)` must be a named, checked consumer.** Before
  the fix, a name-filtered `machine_status` whose backing read failed said
  "Nova's agents: none" — an outage read as absence. The fix names the error
  in the refusal, and adds a structural scan (`_READ_HERE_RECORDED_UP` /
  `_AGENTS_CALL_CONSUMERS`) so a future caller of `.agents()` that shows
  connectivity without recording a fact for the state guard turns the pin red
  by construction. Cost if wrong: one more test category to maintain.
- **Task 16 — the timing sweep must actually reach every pattern it claims to
  cover.** Caught before review (a pre-review amendment by the same
  implementer): `_every_pattern()` skipped tuples of `(Pattern, str)` pairs,
  so roughly a dozen capability patterns — including the one this task added
  — were never measured. Fixed to walk tuples/lists/dict values too; coverage
  went from 162 to 221 patterns with 0 ids lost. "Silence reads as coverage";
  the plan's claim had to be true mechanically, not just written down.
- **Final fix wave — I1/I2/I3** (see Review rounds, below, for what each
  fixed). Cost if wrong: a slightly larger final wave. No earlier ruling was
  reversed by the whole-branch review.

Procedural and test-shape rulings, grouped (cost is "none" or test-only
unless noted above):

- **Cross-task, pre-flight** (F1-F8, C-d/C-e/C-i, D-3/D-4/D-5): one version
  stamp everywhere — 12 hex characters of the commit SHA, with the Go patch
  pinned at 1.27.1 so a local build reproduces CI's sha256; every core pytest
  command carries `TEST_DATABASE_URL` with an absolute `cd` and reports its
  skip count; an `exec.ErrWaitDelay` branch so a backgrounded child doesn't
  turn a successful run into "could not run"; the liveness cadence and
  clock-jump tests were made stall-proof for slow CI runners; the Windows
  DACL read-back compares SIDs, never SDDL trustee strings (which alias
  well-known SIDs); no "walked" or "shipped" claim before the walk actually
  runs; `ruff format` drift on a file that wasn't format-clean at HEAD is
  accepted and noted in the commit body; new fixtures use RFC 5737
  documentation addresses, never a real LAN address; a near-tautological
  placeholder test is kept as a tripwire against a future regression; identical
  per-OS code is deduplicated once (`extras_unix.go`, a shared `where`
  helper) but not chased further than that.
- **Task 6**: commit trailers name the model that did the work; Tasks 1-4's
  earlier commits keep their original trailers rather than rewriting history.
- **Task 9, fix round 1**: `config.Wipe` additionally returns where the audit
  log was set aside, rather than duplicating that naming in `main.go`.
- **Task 10**: no fix in-task for "enroll returns 400 before the pairing code
  is spent" — explicitly carried to Task 12 (which implemented it) rather
  than scope-creeping Task 10.
- **Task 13**: two acceptances, not fixes — a zero-removed-lines diff where
  git's LCS aligned braces differently than the plan predicted (the real
  invariant, byte-identical vectors, was verified programmatically), and
  locating the revoked test vector by a fixed index since vectors are
  append-only by the generator's contract.
- **Task 18**: `.toBeTruthy()` accepted in place of the brief's
  `.toBeInTheDocument()` — jest-dom isn't installed in `apps/web`, and the
  assertion still fails on a missing element either way.
- **Task 20, fix round 2**: the controller verified a one-word doc correction
  directly against the CI API instead of dispatching a second scoped
  re-review for a 4-line, one-file change.

## Review rounds

- Task 1: clean.
- Task 2: clean (one reviewer session hit an API error mid-review; a fresh
  session re-reviewed and approved).
- Task 3: clean.
- Task 4: 3 fix rounds — see Rulings, above.
- Task 5: 1 fix round — see Rulings, above.
- Task 6: clean.
- Task 7: 1 fix round — see Rulings, above.
- Task 8: 1 fix round (one reviewer session hit a usage-limit error
  mid-review and was resumed) — see Rulings, above.
- Task 9: 1 fix round — see Rulings, above; the wipe-failure message could
  also claim files were gone that weren't, fixed in the same round.
- Task 10: clean (one scope note carried forward to Task 12; not a defect).
- Task 11: clean.
- Task 12: 1 fix round — see Rulings, above.
- Task 13: clean.
- Task 14: clean.
- Task 15: 1 fix round — see Rulings, above.
- Task 16: a pre-review amendment, not a reviewer-driven fix round — see
  Rulings, above; the review itself was then clean.
- Task 17: clean (one message-only correction on the ledger; no code change).
- Task 18: clean.
- Task 19: clean.
- Task 20: 2 fix rounds — see What shipped, above.
- **Final whole-branch review** (opus, over the full branch diff `b8bdb0ed..
  11a9fc83`): ran `go test -race` on all 8 `novad` packages, `go vet` on all
  six targets, the 18 S42a core test files (1,244 passed, 0 skipped), and the
  timing sweep three times (460/464 — the 4 failures are main's own known
  patterns). Verdict: "Ready to merge? With fixes." No Critical. Important:
  **I1** — the S42a capability-correction phrase was "correcting" honest
  sentences like "I can't use Windows machines to run models yet" (the verbs
  `use`/`work with` took any purpose, and Windows/Mac engines don't arrive
  until S44). **I2** — the state guard could fail open: `live_facts` copied
  every fact onto an unasked `machine_status` span while the model only saw a
  600-character clip, so a device's connectivity fact could back a claim even
  when its line had been clipped out of what she was shown. **I3** — a
  Windows root process still dying after `taskkill /F` could make `Cancel`
  return an error that `Wait` then read as a normal exit, reporting a killed
  command as "ran, exit 1". Fixed in one dispatch (`586f26a8` I1, `8a849fd2`
  I2, `ec55bd69` I3) plus nine folded one-liners and a plan-doc scrub for the
  public repo (`41900ecf`, `11673952`). The reviewer's own full core run at
  `11673952`: 5,498 passed / 3 known timing / 0 skipped.
  **Re-review verdict:** all three addressed, no new Critical or Important —
  "Ready to merge? Yes, once the carries section is written."

## Gates

Run by the controller at HEAD `11673952`, 2026-09-28 09:09-09:17 EDT, on this
N150 against scratch databases (`.superpowers/sdd/plan/task21-gates.log`):

| Suite | Result |
|---|---|
| core | 5,497 passed, 4 failed, 0 skipped |
| gateway | 645 passed |
| memory | 210 passed |
| web | 1,250 passed (85 files) + tsc clean |
| novad | `go test -race ./...` all 8 packages ok; `go vet` clean for linux, darwin, windows |

The 4 core failures are main's known regex-timing patterns in
`tests/test_guard_regex_timing.py` — `_IN_USE_AFTER_GAP`, `_IN_USE_DENIED` and
`_READING_LINE` fail every run on this hardware (over the 50 ms budget);
`_IN_USE_CONJUNCT` fails intermittently under load. None is S42a's, and the
budget was never raised (Task 0's ruling). CI additionally vets all six
`novad` targets and builds each twice, comparing identical sha256s (see CI,
below).

Baseline for comparison (Task 0, before any S42a code): core 5,013 passed / 3
known timing failed; after the 2026-09-27 rebase onto main (S47 landed):
5,355 / 3. gateway 645 passed throughout. memory 209 -> 210. web 1,157 ->
1,250.

## CI

`rebuild-ci` was re-enabled 2026-09-27 per the owner's 2026-09-21 ruling
("both halves or neither"). Three runs, stated exactly as recorded:

- **Run 1** — `36337523787` (`ee918bdf`). `novad` (vet every GOOS, `-race`,
  six targets built twice with identical sha256s) and `novad-native` on
  `ubuntu-24.04-arm`, `macos-15`, `macos-15-intel` — GREEN. `novad-native` on
  `windows-2025` and `windows-11-arm` — RED, on exactly two Unix-only
  fault-injection tests from Task 9's fix round (their ENOTDIR premise
  doesn't hold on Windows). Fixed and split by OS in `aff62866`, already on
  this branch before run 2.
- **Run 2** — `36340064908` (`aff62866`). `novad` and all five
  `novad-native` legs GREEN, including both Windows legs.
- **Run 3** — `36424142677` (`11673952`). `novad` and all five
  `novad-native` legs GREEN (I3's Windows test passing natively).

Outside `novad`, red in all three runs, in files S42a never touched:

- `services (core)` — `ruff check .` fails on 3 pre-existing errors in main's
  tests (`test_chat_attachments.py` F401, `test_recall_sources.py` F401,
  `test_tools_skills.py` E501), so pytest never runs there in CI — core's
  evidence is the local full suite (Gates, above) instead.
- `services (gateway)` and `services (memory)` — cancelled, not a failure of
  their own steps.
- `web` — `ProvidersSection.test.tsx` ("adding from the OpenRouter preset…"):
  expected `''` to be `'https://openrouter.ai/api/v1'`. Passes locally
  (1,250/1,250 — Gates, above).
- `backup-macos` — `backup_test.sh` "coverage block" (28 passed, 1 failed).
- `installer` and `backup` — green in every run. `e2e` — skipped by design.

Main has had no CI run since 2026-09-07, so "also red on main" is inferred
from the files touched (none are S42a's), not observed directly.

## The walk

2026-09-28, in chat, in her words (chat model `dell:qwen3:8b`); every turn
read by turn id. Topology per P16: the hub is the mini PC; the Windows agent
enrolls over `https://nova.<TAILNET>.ts.net`; the distro is `Ubuntu-26.04`.

| # | Question | Turn id | Tool calls | Result |
|---|---|---|---|---|
| 1 | "Which of my machines have your agent?" | `212b9f8b-707a-42b7-8be7-3391199b3dd6` | `machine_status` | ok. Facts recorded: `{hub answering}`, `{DELL-XPS-8950 connected}`, `{DELL-XPS-8950 (WSL) connected}`. Reply named both agents on the Dell (the Windows 11 Pro one; the WSL one "predates recent updates and sends no diagnostic facts") and said the hub hosts no agent. Honest. |
| 2 | "What's on my Windows desktop?" | `7999cd84-4b2d-48de-904c-cb6a8d086ef7` | `device_list_apps`, then `device_list_files` on `C:\Users\Public\Desktop` (DELL-XPS-8950) | ok; listed the real shortcuts there. **Finding:** she guessed the PUBLIC desktop rather than reading `device_info`'s own `desktop=` line (P11: read, never guessed) — it looked right because Windows shows both desktops together. |
| 3 | "Open Notepad on my PC." | `82bf7d40-c230-4147-8e12-1eb80fc34db5` | `device_run ["notepad"]` on DELL-XPS-8950 | ok (Windows 11's `notepad` alias hands off and returns); the owner confirmed Notepad opened. (`device_launch_app` was the expected tool; `device_run` works.) |
| 4 | "Send my PC a notification that says hello from Nova — café." | `a2026704-57f1-4c38-a4b0-115bcd1afc96` | `device_notify` | ok; the owner confirmed the toast showed the text intact (review focus 3). |
| 5 | "Run uname -a inside WSL on my PC." | `e2cf16ab-5686-4ecb-a9e0-39ed557cd409` | `device_run ["wsl.exe","uname","-a"]` on the WINDOWS agent | ok: "Linux DELL-XPS-8950 6.18.33.1-microsoft-standard-WSL2 … x86_64 GNU/Linux". |

The plan's walk step 5 (revoke the WSL agent and have her stop its service)
was **skipped**: the owner chose to keep the old WSL agent (see the Dell
steps, below). After the walk he asked whether to retire it —
recommendation: retire it, since the Windows agent already reaches WSL
through `wsl.exe`, proven in turn 5 above.

The owner's verdict: "the walk worked flawlessly. All 4 worked."

### The Dell (owner steps)

- The Windows agent enrolled 14:07 UTC as **DELL-XPS-8950** (platform
  windows; facts: Windows 11 Pro 25H2 (build 26200); agent `bbbbbbbbbbbb`),
  running in a PowerShell window (`novad run`; the Run key is S42b).
- D13: a local build of `novad.exe` (go1.27.1, windows/amd64) has sha256
  `<BUILD-SHA256>`, identical to CI's `novad-windows-amd64.exe` artifact from
  main's run `36428974635`. The owner verified the same hash on the Dell with
  `Get-FileHash` after a Taildrop transfer.
- The old WSL agent had not connected since 2026-09-22 19:09 UTC (the day
  the hub moved to the mini PC); core saw no attempt from it. The owner
  revoked it (14:11) and re-paired the OLD WSL build as a new
  "DELL-XPS-8950 (WSL)" (14:12; linux; no facts), choosing to keep it for
  now.

## The eval

`agent_quality` **v17 (30 cases)**, model `dell:qwen3:8b` (the model her own
turns used), three runs through `POST /api/v1/evals/run` (Task 21 Step 7):

| Run id | Score |
|---|---|
| `6bd2e07e-285e-4658-9aa6-e2d3c576bb8e` | 23/30 |
| `4e9651bb-4cf4-4fa5-98ba-476db7986678` | 25/30 |
| `ac6ac3b3-22c7-47cf-9f50-fe456b94a3de` | 23/28 gradeable (2 ungradeable) |

**`points-wsl-at-the-windows-agent` (the S42a case) failed 0/3 — read, not
re-rolled.** In all three runs she never called `machine_status`
(`tool_called: 0`); she reached for `device_list` instead, which by P15
lists the owner's REAL devices — `eval_gaming_pc` is overlaid only onto
`machine_status`'s agent listing — so she never saw the WSL role reason
("cannot: this machine's Windows agent owns it"). Replies: "you'd need to
pair both" (turn `37de2814-d3f1-4c13-82d3-76ea7b3c9f8f`), "pairing the WSL
device is correct" (turn `794af2ac-f57c-450a-9b66-ea414e22ccea`),
"eval_gaming_pc isn't recognized" (turn `0f6f3e00-da04-47d1-bdc4-dd4b292c79b8`).
The mechanical backstop still stands: a new novad's `enroll` refuses inside
WSL regardless of what she advises. **-> S42b:** deliver the WSL fact
through `device_list`'s own line and the device tools too, since the 8B
model reaches for `device_list` first.

## After merge

- **The 393 px check** (Task 21 Step 8), on the deployed stack: no
  horizontal overflow in either view (`scrollWidth` 393 == `clientWidth`
  393). First shot: the Windows tile's subtitle **truncated** to "Windows
  11 Pro 25H2 (build 26200) · DELL-X…" (hostname and agent rev hidden).
  Fixed by PR #82 (`d9cfadde`: the subtitle now wraps, `truncate` ->
  `min-w-0 break-words`), redeployed; re-shot: "Windows 11 Pro 25H2 (build
  26200) · DELL-XPS-8950 · agent bbbbbbbbbbbb" in full, over two lines.
- **PR #81** (`7d703286`, owner-requested): revoked devices are hidden by
  default in Settings, behind a "Show revoked (N)" button — display only,
  API/DB/audit unchanged. Web suite: 1,260 passed.
- **Owner requirements carried to S42b:** no `novad` in Downloads, no
  manual start at boot; pairing and re-pairing must be one easy step;
  updating agents must be something Nova manages; the hub should appear in
  Devices.

## For the owner

- **P6 (locked):** the device key lives in roaming `%AppData%`; on a domain
  roaming profile it travels to the profile server and other logons (the
  audit log stays local). Irrelevant on home machines.
- **"2 machine(s)"** for a PC plus its WSL distro: a wording choice (P13's
  grouping is kept as written).
- **Plan changes made as rulings during the build** (all in the SDD ledger;
  see Rulings, above, for the why and the cost of each): the revoked refusal
  is signed by core and verified against the pinned key before any wipe; a
  1 s wall-clock watchdog reconnects within about 2 s of resume; heartbeat
  and facts writes are bounded by the ping timeout; `shell.exec`'s outcome
  follows the process, not ctx state; absent or rejected auth facts clear
  stored facts rather than leaving them stale; the timing sweep now reaches
  every guard pattern; the Go patch is pinned (1.27.1) and the version stamp
  is 12 hex characters everywhere so a local build reproduces CI's hash.
