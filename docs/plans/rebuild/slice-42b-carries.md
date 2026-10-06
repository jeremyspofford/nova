# S42b — carries

- **No retired-key table (P13):** an old key still running after a re-pair
  retries with "signature did not verify" until it is stopped by hand.
- **No self-revoke (P21):** `uninstall` keeps the identity and says to
  revoke it in Settings.
- **An eval case for acting on the facts (P29):** a declared device is
  read-only to the device tools, so "retire the old agent" cannot be scored
  in the corpus; it waits for a fixture that can answer `device_run`.
- **The WSL look runs as each distro's default user only;** a Nova agent
  under another user's unit is seen as a process (`novad` pid), not as a
  unit.
- **`sudo -n` can write an auth-log line at each probe** (connect and
  refresh only).
- **The public paths' limit is per door, not per address** (Task 26): the
  hub's loopback, the tailnet and any other address core sees each get
  their own 30-a-minute budget for the downloads, and a visitor through a
  relay (`Cf-Connecting-IP` present, or funnel) is counted apart, per door.
  Enroll's own limit is 5 wrong codes per 15 minutes per bucket, counted
  before the handler awaits, so a burst cannot exceed 5 checks. What is
  still carried: a stranger through a relay can still lock pairing from
  that door for up to 15 minutes, and anyone sharing that relay's bucket
  can renew the lock — the owner's own way round is the tailnet or the hub
  machine itself, whose buckets a stranger cannot reach.
- **She stated causes she never checked** (turn `01faf3b7`: "likely a sudo
  prompt" and a procedure for him, 2026-09-28). The owner SHELVED the
  reply-level handback guard on 2026-09-29 (it is not this slice's, and not
  "the coordinator's `fix/handback-guard`" — that lane is parked, not on
  main). S42b's own answer is the facts: P29 gives her what she needs to
  act unaided, and the evals score whether she does, rather than a guard
  correcting her reply after the fact.
- **Task 10c's Windows half, on Task 1's branch T3 only:** the agent could
  not take the terminal away from `wsl.exe`'s Linux side; the readings and
  the owner question go here. Until it lands, a Windows child novad starts
  for her keeps S42a's behaviour — it can still wait on a prompt nobody can
  answer, up to the timeout.
- **The admin helper (S42c) is PAUSED**, alongside S46a:
  `platform.AdminInstallDir` is declared, nothing uses it. The standing admin path
  the owner chose instead is the doing lane's **S30b** (his answer to Q17:
  one OS prompt at setup, then any command as root/admin, recorded, never
  refused) — not S42c, and not scheduled next. Nothing in this slice's
  wording promises a future admin path, names "only named fixes," or says
  "never": elevation is stated only as what is true today (Ruling S42b ×
  Q17).
- **The macOS walk:** until the owner walks a Mac, `platform_walks.json`
  says "not walked," and the eval pins that she says so. The owner's only
  Mac is his work device, so this may stay a standing carry rather than a
  temporary one.
- **A reminder can fire up to about two minutes late** during a stalled
  update: the scheduler runs firings one after another, and the
  `agent_updates` job can hold it for as long as a single unanswered
  command's bound (120 s) while it waits on a stalled agent, only while it
  is sending (Ruling Task 20 concern 8). Carried to the doing lane's **S30**
  (long jobs) as a requirement: a timer's firing must never wait behind a
  job's device wait.
- **Close-out backlog, pre-existing (not S42b's, carried here):**
  - a frozen audit chain's single replay frame grows one entry per command,
    and past uvicorn's 16 MiB `ws_max_size` every handshake closes;
  - the Governance page renders no break meta, so a refusal, a gap and a
    tamper look identical.
- **`install.ps1` under Windows' default execution policy never reaches its
  own message.** A native Windows machine (no WSL yet) has nothing else to
  run — the hub itself needs WSL — so `install.ps1` at the repo root states
  that and gives `wsl --install`, then exits; but PowerShell's default
  policy blocks a `.ps1` file before it can print anything.
  `deploy/README.md` now gives the script's own words directly, and
  `powershell -ExecutionPolicy Bypass -File .\install.ps1` for running it.
  Carried: the script itself does not detect or work around the policy.

## From the build's reviews

Task 32's triage of the 79 deferred minors across Tasks 2-31
(`scratch/t32/triage.md`) ruled most of them CARRY or DROP rather than FIX
NOW. The lines below are that ruling, in plain words: what each item is,
and why it waits rather than being fixed now. A ledger line like "L60"
points at the step in `progress.md` that first raised it.

- **L60** (`internal/state/lock.go`, `Acquire`): a pid-write error after the
  lock file itself is already held gets swallowed. The lock is genuinely
  held either way; only a future contender's stale-pid message could be
  imprecise. Waits because it is a diagnostic-only gap on an already-safe
  path.
- **L62** (`internal/state/state_test.go`): the held-lock test only proves
  same-process exclusion; the PID-zero and unreadable-PID branches, and
  true cross-process exclusion, are untested. Waits because the untested
  code already degrades safely (`readPID` has no unsafe failure mode) —
  this is a coverage gap, not a known-wrong behavior.
- **L70** (`internal/config/config.go`, `freeName`): a bare `os.Lstat` error
  with no "checking a set-aside name" context. Several sibling call sites
  in the same file have the identical pattern. Waits for a batched
  error-wrapping pass across all of them, rather than fixing this one site
  alone.
- **L78** (`internal/platform/folders_linux.go`): a failed `$HOME` lookup
  returns the raw OS error instead of this file's own wording template;
  darwin has no equivalent branch. Reachable only when `$HOME` is genuinely
  unset. Waits to be bundled with L70 and L228 in one future wording pass.
- **L89** (`internal/service/systemd_linux.go` and `launchd_darwin.go`,
  `New()`): a home/config-base lookup error is discarded. Waits because it
  is confirmed unreachable today — `config.DefaultPaths()` already refuses
  loudly on the identical failure earlier in every real path.
- **L91** (`internal/service/launchd_darwin.go`, `Restart`): `kickstart -k`
  right after bootstrap can kill the instance RunAtLoad just started. Waits
  because macOS service management is unwalked and CI-only today (already
  tagged CARRY in the ledger).
- **L92** (`main_test.go`, `launchd_darwin_test.go`,
  `platform/detach_test.go`): test-quality gaps only — tracking "ever seen"
  rather than the last `Restart=` value, no negative plist assertion, and a
  detach test that proves the child ran but not that it got its own
  session. Waits because no current writer produces conflicting directives,
  so there is no live bug to fix yet.
- **L93** (systemd unit, S42a carry-over): `After=`/`Wants=
  network-online.target` are no-ops in a systemd user unit. Waits because
  this predates S42b and is not this slice's to fix.
- **L99** (`internal/platform/runkey_windows.go`, `Stop`): up to three
  sequential 10-second waits, worst case about 30 seconds. Waits as a UX
  note already flagged for later tasks (9/12) rather than a defect to fix
  now.
- **L132** (`internal/supervise/log_windows.go` and `supervise.go`,
  `awaitReady`): a first-call `SetStdHandle` failure can pin inherited
  handles (a rare OS-call failure); exit codes seen only inside
  `awaitReady` can leave restart/exit counters stale until the next cycle
  corrects them. Waits because neither ever surfaces a false claim to the
  owner.
- **L137** (`internal/supervise/supervise.go`): a double fault with no
  `.prev` build retries forever on the 30-second backoff ceiling. Waits
  because a reinstall is the only exit either way, and every logged line
  stays factually accurate throughout (already tagged CARRY).
- **L201 / L202** (`internal/platform/shell_linux_test.go`,
  `procattr_unix.go`): test-hardening notes only — the tty-check half of a
  test can pass headless without `Setsid`, and the Setsid-fails path has no
  test. Waits because the session-id half of the same test is already a
  reliable tripwire, and `procattr_unix.go` sets `Setsid: true`
  unconditionally with no fallback branch to exercise.
- **L228** (`internal/install/identity_unix_test.go`): no Windows twin for
  this test file. Waits because `checkHubs` is plain `net/url` parsing, not
  platform-dependent, so the payoff is low; a related one-line wording
  regression (a lost "could not reach `<url>`:" prefix) is folded into the
  same future pass rather than fixed alone.
- **L264** (`internal/platform/mode.go`, `Supervised()`/`Mode()`): both
  trust `os.Getenv` unconditionally. Waits because it shares a root cause
  with the already-carried Task 10c Windows issue (env-controlled values
  inherited by child processes) — the real fix touches every child-spawn
  site at once, not this one function.
- **L273** (`services/core/app/devices_ws.py`, `ingest_audit`): an
  all-or-nothing shape pre-check on an audit frame. Waits because it is
  plan-mandated as written, and confirmed unreachable from the real novad
  agent — only a hand-crafted client could trigger it.
- **L302** (`services/core/tests/test_migration_038.py`): a bundle of
  test-precision gaps — primary-key column order unchecked, the CHECK
  constraint's converse untested, the re-run test only re-reads rows, and
  the conftest's table-listing order — plus one unrelated, pre-existing
  pool-leak note on a failed TRUNCATE. Waits because all of it is test-only.
- **L315** (`services/core/app/devices_ws.py`, `Hub.register`): a described
  displacement race needs `register()` interrupted mid-body by another
  coroutine, which asyncio's single-threaded, no-await-inside-`register()`
  scheduling does not allow. Waits because "practically unreachable" holds
  on direct inspection (already ruled CARRIED into Task 16).
- **L317** (`services/core/app/devices_ws.py`): wording precision ("cannot"
  versus a bare refusal) and one stale comment. Waits because the
  `epoch: int = 0` defaults it also touches are explicitly brief-mandated,
  not a bug.
- **L331** (`services/core/app/devices_ws.py`, `Hub.register`): no dedicated
  test for an equal-epoch replacement, plus a low-stakes `last_update: None`
  dual-meaning note and a reader for `mode` duplicated three times. Waits
  because equal-epoch replacement already behaves correctly as written —
  these are refactor opportunities, not a live bug.
- **L351 / L354 / L355** (`apps/novad/internal/facts/facts.go` device-facts
  wording): mostly already fixed by Task 16b's own earlier rounds. What is
  left: "absent" on a platform-unknown row still reads the non-Windows "no
  sudo" wording, with no third branch for "we don't know the platform";
  `unit["file"]`'s bare "no unit file" fallback skips the sibling
  "unknown (reason)" treatment used elsewhere; "(sudo -n said: …)" may
  mislabel the agent's own exec-layer error as sudo's own words; and "no
  service the agent knows of" versus "started by hand" wording humility at
  about three call sites. Waits for a dedicated wording-precision round.
- **L363** (`services/core/tests/` auth-race test): coverage precision
  notes only — the race test's injection point works only while the door
  write follows `_record_auth_facts`, and the `/api/v1/devices/ws` route's
  end-to-end wiring is untested. Waits because the ledger itself marks the
  adjacent mutation-failure and asyncio-warning notes on the same line as
  out of scope.
- **L395** (`services/core/app/tools/setup.py` and `machines.py`): no
  distinction between "revoked" and "never existed" in a refusal. Waits
  because the refusal is already true (a revoked machine is no longer
  paired) — this is a helpfulness miss, not a false claim.
- **L423 / L429** (`services/core/app/agent_updates.py`): a cluster of
  narrow, already-understood edge cases — a rolled-back build after a
  confirmed read is never re-decided; `_last_command` is process memory, so
  it loses state across a core restart; retrying is per-device rather than
  per-agent; and a slow bootstrap shares its single 120-second budget
  across steps. Waits because each is real but individually narrow and
  rare; one sub-clause may already be resolved by Task 31's docs fix round.
- **L444** (`services/core/app/live_facts.py`): folder lists can go stale
  between reconnects, outside the existing probe-freshness ruling, and
  `device_info` shows no progress during the refresh wait. Waits as a UX
  nicety, not a correctness gap.
- **L468** (`services/core/app/tools/machines.py`, `FixturePlant` /
  `GatewayPlant`): four sub-parts — a false "hub" refusal beside a
  hypothetical pre-D8 live row literally named "hub" (none exist today);
  `FixturePlant.update_agent` never checks a declared update outcome
  against the declared build; `_describe_agent` sniffs `device_facts`'s own
  wording via `starts.startswith("unknown")`, a fragile coupling; and
  `_build_words` is duplicated between `tools/machines.py` and
  `tools/devices.py`, rendering the same fact two different ways. Waits
  because none is a live bug today.
- **L502** (`services/core/app/guards.py`): three sub-parts — no claim shape
  yet catches "X is on the hub's build" after a `sent` outcome (a recall
  gap that needs the usual timing-sweep care for a new regex); a true
  correction after "current" does not explain that the build already ran
  (wording quality on an already-true correction); and a persona name that
  is a word inside a paired machine's name can misclassify a persona claim
  as a machine claim (a narrow naming-collision edge case). Waits for its
  own round with proper timing-sweep care.
- **L531** (`services/core/app/evals/predicates.py`): a forward-looking note
  only — `tool_succeeded_with` is compound but not regex-bearing, and no
  predicate kind today is both. Waits because there is nothing to fix until
  someone adds such a kind.
- **L651** (`deploy/install_test.sh`, HA_J3/HA_J3A): both tests call
  `install_hub_agent`/`run_hub_agent` inside `$(...)` command substitution,
  so a `set -a`/`set +a` restore leak could never be observed by these two
  tests regardless of whether the code is correct. Waits as debt for
  whoever next touches `install_hub_agent`'s `set -a` handling — the code
  itself is right, measured directly.
- **L666** (core's reloaded setup card): stores a `walk` field that no code
  in `apps/web/src/` reads. Waits because this is a product-decision fork
  (teach the reload path to render it, or stop storing it), not a defect.
- **L696** (`apps/web/src/pages/settings/devicesFormat.ts`,
  `cancelledNote`): differs in punctuation and word order from core's
  `tools/machines.py` `_cancelled_words`, though both independently convey
  the same facts (same counts, same meaning). Waits to be reconciled the
  next time either string is touched, since nothing here is false to the
  owner.
- **`writer_services()` has no one-shot filter** (`deploy/backup.sh`,
  feeding `BK_RUN_STOPPED` and `$writers_list`): unlike MF3's
  `BK_RUN_SERVICES`, this function derives its service list purely from
  each volume's disposition (`include`/`move-only`), never from
  `bk_cfg_without_one_shots`. It is dormant today only because agent-dist's
  own volumes (`v4_agent_dist`, `v4_agent_build_cache`) are both annotated
  `exclude-derived`/`exclude-ephemeral` in `deploy/docker-compose.yml`, so
  this function's `include`/`move-only` switch never selects them. Carried
  because if a future one-shot or build-profile job's volume is ever
  annotated `include` or `move-only`, this reappears, undetected, in a
  function MF3 never touched.

Task 32 Phase C's whole-branch review (`task-32-phase-c-review.md.report`)
approved the branch with ten minors. Its fix round fixed five (C2–C6) plus
a single-sample timing pin (C1). These are carried:

- **Review minor 2** (`docs/plans/rebuild/s42b/plan.md`, Review Focus 3):
  the plan names `test_a_uint32_windows_exit_code_is_stored`, a test that
  does not exist. The pin is
  `test_a_windows_exit_code_over_int32_range_is_stored_after_the_migration`
  (`services/core/tests/test_devices_ws.py`), which stores `0x80070005` and
  `0xFFFFFFFF` and passed in the review's control run. Only the plan's line
  is wrong; the protection is pinned.
- **Review minor 3** (`services/core/app/checks/devices.py`, `agents_behind`):
  while a hub-door agent (`last_transport == "host"`) is behind and not yet
  tried with the build, the job sends to no other machine. That is the P10
  ruling (progress.md: offline, busy or hand-started hub agents still hold
  the others). A hub agent that is never tried (left offline by
  `novad uninstall` without a revoke, started by hand, no facts) therefore
  parks every other agent. The job's firing text says the others wait for the
  hub's agent, but the check's "stale" finding a day later says only "Nova
  has not updated it to it yet", with no cause. The fix is the check's
  wording: a `hub_wait` token that names the hub agent the others wait for.
- **Review minor 8** (`services/core/app/agent_card.py`, the card's POSIX
  one-liner): on a machine whose temp directory is mounted `noexec`,
  `"$d/novad" install …` fails with the shell's bare "Permission denied"
  (exit 126). `./install` recognises 126 and names `TMPDIR` as the way out
  (`deploy/install.sh`). The card says nothing. The fix is the same note on
  the card's line or in `LINUX_NOTE`.
- **Review minor 10** (`services/core/app/agent_updates.py`, `update_now`;
  `devices_ws.Hub.command`): `update_now` records `{"device", "connected":
  True}` from `hub.is_connected`. `hub.command` can then raise `NotSent` and
  record `connected: False` when the only socket is at an older epoch. That
  leaves two contradictory facts on one span, and the state guard reads
  either. It is reachable only between a re-pair's commit and `_still_bound`
  dropping the old socket. The fix is to read the epoch in `_connected` (or a
  `hub.is_connected_at(epoch)`).
- **Phase B3's remaining false corrections** (`services/core/app/guards.py`,
  `device_completion_check`; measured in Task 32 Phase B3,
  `task-32-phase-b3-report.md`, probes under `scratch/t32b3/`):
  - "I started the update on X." after a real update reads "started" as a
    launch and appends "(No device_launch_app or device_run call ran on X
    this turn.)": **1 of Task 24's 48 honest replies** beside the replay's
    send.
  - "I sent it to X." and "Sent it to X; not confirmed until it reconnects."
    after a real update keep the notify sentence. A pronoun object names
    nothing the object test can read. **Both of the 2 phrasings probed**
    draw it; neither is in a corpus. The same probe found "the agent
    update", "the hub's update" and "an update" as the object keep it too.
  - "I sent the update to X as a notification." beside a REAL
    `device_notify` is now corrected with the install sentence, because the
    ruling's "the update" reads as the build: **1 of 23 honest notification
    replies** (`notify_probe.py`; 0 of 23 before B3).

  Each needs an object test on its own shape, or a ruling that either family
  backs a pronoun object. Each new pattern needs the timing sweep every guard
  pattern gets. B3 did not widen the guard without that ruling.

### Dropped, with why

- **L28** (`docs/plans/rebuild/hub-p0-measurements.md:492-493`): mislabels
  which step the Go version sits under. Dropped: a dated, already-"Measured"
  archival log entry that nobody acts on.
- **L50** (`.github/workflows/rebuild-ci.yml`, two sites in the `novad`
  job): the Go version this workflow computes could in principle disagree
  with `agent_version.sh`. Dropped: plan-mandated as written, and CI
  checkouts are always clean, so the two never actually disagree.
- **L51** (`deploy/agent_version.sh:21`): a bare `git ... | cut -c1-12` with
  no explicit check that `apps/novad` exists in HEAD. Dropped: plan-mandated
  verbatim, and CI always has `apps/novad` in HEAD, so the failure path is
  unreachable.
- **L165** (Go daemon serve/swap): a microsecond-scale stale read of a
  status that is about to become correct anyway. Dropped: the ledger's own
  word for it, and nothing acts on the stale value.
- **L192** (`internal/client/client.go`, `probeBudget`/`probeGrace`): fixed
  source constants (45s/2s), not runtime-configurable. Dropped: even a
  hypothetical bad value degrades to an explicit, honest timeout error,
  never a hang or a false success.
- **L224** (`internal/install/config.go`, `pair()`'s `Save`): a half pairing
  (a config or a key, but no audit log) is overwritten rather than set
  aside. Dropped: the ledger's own cross-reference to "(decision 4)" marks
  this as an already-deliberate design choice, and the degenerate case has
  no secret or audit trail to protect either way.
- **L263** (Go install flow, PID checks): inherent to PID-based checks on
  any OS. Dropped: the ledger's own word, and it needs a human already
  hand-setting an internal control variable.
- **L404** (`services/core/app/tools/setup.py`/`machines.py`,
  `_paired_machine` singular — distinct from MF5's plural
  `_paired_machines` in `chat.py`): already resolves through
  `machines.plant()`. Dropped: an accepted efficiency cost of the plant
  seam needed for eval-replay hermeticity, immaterial at this deployment's
  scale.
- **L697** (`apps/web/src/pages/settings/DevicesSection.tsx:406`,
  `HUB_DOOR_TITLE`): not styled the way RoutingSection's precedent uses
  `aria-label`. Dropped: RoutingSection's precedent is for dynamic action
  descriptions on interactive buttons; this label is on a non-interactive
  decorative badge — a different use case, redundant with its own visible
  text and title but harmless.
- **L700** (`apps/web/src/pages/settings/DevicesSection.test.tsx`): no test
  pins Update hidden for `build_state: 'current'`. Dropped: Update's gate is
  a single `=== 'behind'` predicate, and the existing "absent build_state"
  test already exercises the identical negative branch — there is no
  `'current'`-specific code path left to miss.
