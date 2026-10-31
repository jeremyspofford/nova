# M10e gate evidence: the Service Manager and the supervisor driver

The ADR is `docs/plans/M10-orchestration.md` (Point 1, "With the K3s driver off", "The service
definition", Point 4, Hard limits, Order), and the plan is `docs/plans/M10e.md`. Everything here ran
on 2026-10-31 on this machine (WSL2, Node 26.3.1), in temp folders made with `mkdtemp(os.tmpdir())`.
The services are the stand-in `scripts/stand-ins/fake-service.js`, bound to 127.0.0.1 on free ports;
the console under the in-process supervisor is the stand-in server of `tests/supervisor/fake.ts`. No
Kubernetes, Helm or Flux was installed or run. This machine has a real `kubectl` at
`/usr/local/bin/kubectl`; the tripwire shadows it for the whole suite, and it was never called.

The branch was rebased onto main at `61bcb042` (M10d merged) before the review's fixes, then onto `a79ab31c` (#248 and #250 merged) after them, onto `844a1271` (#249, the eval harness), and onto `736e80ce` (#254 and #255) last.

**Deferred, said plainly: the `service` change kind is not built.** The ADR's Order lists it in
M10e, but its artifact is "the definition plus the rendered values" and its gate is GitOps
(`services.git`, M10j/M10k); this phase's brief excluded Helm. In M10e a service is deployed through
the supervisor with typed confirmations, as console releases are.

## Suite

`npm run check` passes: the token lint, themes, typecheck, and **1285 tests: 1274 pass, 0 fail, 11 skipped** (61 of them M10e's; at `736e80ce`). One earlier full run, before the second rebase, failed two M10c tests (`coding.test.ts`, `coding-review.test.ts`) on a port race under the load (a preview's free port taken first: EADDRINUSE); both files pass alone, 27 of 27, and the next full run was green. The 9 skips are the
existing opt-in real-service tests.

`scripts/ui-test.sh` (Chromium in the Playwright container, under the tripwire): at `736e80ce`, **90 tests: 89 pass, 1 fail**: `tests/ui/ux-review-1.test.ts` (new on main) couldn't load `axe-core`, a dev dependency main added that this checkout hadn't installed. After `npm ci`, that file passes, 5 of 5. CI's UI gate at the head: **94 of 94**.

The run's log, start and end (`npm test` and the UI gate both say it):

```
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
…
no-Kubernetes tripwire: never fired
```

The new tests:

| File | Tests | What it proves |
|---|---|---|
| `tests/core/services-definition.test.ts` | 10 | The format; one test per refusal the ADR names; the command rule; ports below 1024; every other malformed field; the console's definition; the promotion tier |
| `tests/core/services-manager.test.ts` | 8 | The manager's own rules against a recording driver: validation first, the first driver that can run it, each version registered once and only once it passed, typed promotion at its tier, only a ready version offered, a new command asks before it runs, rollback asked |
| `tests/support/service-driver-contract.ts` | (shared) | What every driver must do; run by the supervisor driver now and by the K3s driver in M10j |
| `tests/supervisor/services-contract.test.ts` | 2 | The contract suite on the supervisor driver |
| `tests/supervisor/services.test.ts` | 10 | The gate's lifecycle, each failure path, crash rules, alongside modes, a supervisor restart, the plan snapshot and refusals, the console from its definition |
| `tests/supervisor/services-review.test.ts` | 23 | One test per finding of the review of PR #247 (below) |
| `tests/supervisor/services-cli.test.ts` | 5 | The command line on a real supervisor process; supervisors killed outright (three cases); SIGHUP |
| `tests/acceptance/no-kubernetes.test.ts` | 3 | The tripwire is armed for the run, it fires, and Nova running a service leaves no `~/.kube` |

The existing supervisor tests are unchanged (`git diff origin/main -- tests/supervisor/{checkpoints,guards,releases,rollback-mark,record-problem}.test.ts tests/supervisor/{fake,support}.ts tests/chaos/hub.test.ts` is empty) and green, and so is `tests/acceptance/fresh-user.test.ts`.

## Gate items

### 1. The console runs from its definition, through the supervisor driver, with today's tests unchanged and green

- `services.test.ts` › "the console runs from its definition: its command and its health check are
  the definition's": a console definition naming another script (`src/console.js`) and another
  health path (`/console-health`), which the stand-in console alone answers. The console starts from
  that script, its health checks pass, and it is never restarted.
- The console's deploy path is the supervisor's own, unchanged: `Supervisor.deploy` and
  `Supervisor.rollback`, which the driver's `switch` and `rollback` call for `nova-console`. Today's
  restart, safe-mode, canary, migration and checkpoint tests (`tests/supervisor/*.test.ts`,
  `tests/chaos/hub.test.ts`) are unchanged and pass.

### 2. A second, plain-program service is deployed, promoted, soaked and rolled back

`services.test.ts`: the lifecycle (alongside with no traffic: with 1.0.0 live, deploying 2.0.0
leaves the stable port on 1.0.0; promoted on the typed word; the old version stopped with its whole
process group, asked with SIGTERM and then made with SIGKILL; a kept-alive client reaches the new
version; the old slot removed after the soak, and the record says so); a contract failure never
offered; the canary's automatic rollback; the soak's one-step rollback from the kept slot with the
source file deleted; crash restarts and holding; an asked rollback; `copy` and `none`; a supervisor
restart. `services-cli.test.ts`: the same through `node src/supervisor/main.ts`, deploy refused
until its command is approved, and the service stops with the supervisor.

### 3. The driver interface is exercised by the driver's tests

`tests/support/service-driver-contract.ts`, run by `services-contract.test.ts`. **Only one driver
exists in M10e**, so "both drivers' tests" is half met: the K3s driver (M10j) must run this suite.

### 4. The definition: a validator test per refusal, and the supervisor's plan as a snapshot

`services-definition.test.ts`: one test per ADR refusal (floating with state; image-only on macOS or
Windows; no device's roles allow it; a secret as a value). `services.test.ts` › "the supervisor
driver's plan, as a snapshot": every step, with the exact argv (Nova's own Node, the program in its
slot, its own arguments). The values-file snapshot and the chart lint are M10j's: no Helm code exists.

### 5. No Kubernetes anywhere, and the tripwire shown to work

`npm test`, `npm run test:ui` (CI's UI gate) and `scripts/ui-test.sh` run through
`scripts/tripwire.sh`; `no-kubernetes.test.ts` shows it armed, firing, and Nova leaving no
`~/.kube`. The tripwire sees PATH lookups only (see Limits); `services-review.test.ts` › "no code in
Nova or its scripts names a Kubernetes tool to run" covers the rest, by reading the code.

### 6. Services bind 127.0.0.1 on free ports and are stopped in teardown, process groups included

Every supervisor test ends with `stop()` (`services-support.ts`), which records every pid the
supervisor started while it ran and fails unless all are gone after `close()`. Tests that make
orphans on purpose (a killed supervisor) end them in `finally`, whatever the outcome.

### 7. The fresh-user test

`tests/acceptance/fresh-user.test.ts` passes unchanged in the suite.

## The review of PR #247

Each finding was checked with the reviewer's probe (`m10e-probes/p1`–`p13`) against the code before
the fixes. For each, a test was written, the fix made, and then the fix was reverted on its own and
the test run against that (`--test-name-pattern`), then put back. **Order, plainly:** the fixes and
their tests were written together, not test-first; the revert runs below are what shows each test
catches its finding.

| Finding | Reproduced? | Fix | Test | With the fix reverted |
|---|---|---|---|---|
| B1 the command needn't run the pinned program | Yes (p1: a `../` path ran the stand-in from outside the slot; `node -e` wrote its marker) | The command rule (plan § "What runs"): the artifact itself, or Nova's own Node with the artifact as its script; no options or inline code before it; checked by the validator, the driver's plan, and at every start (regular file in the slot, the pinned SHA-256) | definition › "the command runs the pinned program and nothing else"; review › "B1: the driver itself refuses…" | fails (the `../` command accepted; the driver's refusal missing) |
| B1 checked again at every start | — | `#verify` before each start | review › "B1: a program changed or replaced by a link in its slot is never started again" | fails (timed out waiting for held: the link ran) |
| B1 the plan shows the argv | Yes (p1: the plan never named the command) | `plan.command`, and "It runs exactly: …" | services › "the supervisor driver's plan, as a snapshot" | fails |
| B1 a changed command asks | — | Deploying a command no approved version ran asks, typed, tier 2 (3 with secrets or OS permissions), showing the argv | manager › "deploying a command no approved version has run asks first…"; cli › deploy refused until confirmed | fails |
| B2 the restore's result ignored | Yes (p10: "1.0.0 is running again", nothing served, no problem) | Every failure path checks it; if the old version doesn't start, the service is held, a problem raised, and the words say so | review › "B2: when the old version doesn't start again either…" | fails (the message claimed it ran) |
| B2 old forwarder closed before the new version is checked | Yes (p2: old port refused, new port reset) | New ports open beside the old; the live version's are untouched until the new one passes; failure closes only new ones | review › "B2: … moves its stable port and fails its canary while the old one still runs" (and four more B2 tests: start failure, held, port moved, `none`, `copy` canary) | fails (the old port stopped answering) |
| S1 the soak's end races a rollback | Yes (p3: the kept slot removed mid-rollback; held) | A rollback clears the soak first, and the soak's end waits its turn in the service's queue | review › "S1: …" | fails with both guards removed; **each guard alone is enough**, so each removed alone, the test still passes |
| S2 a crash collides with a deploy | Yes (p4a: held "already running"; p4b: the crash ignored) | One queue per service: every change, restart and soak end waits its turn; a crash is counted the moment it happens | review › "S2: a crash, then a deploy during the restart wait…"; "S2: a crash during a deploy is never dropped…" | both fail (timed out waiting for 1.0.0) |
| S3 no way back from held | Yes (p4c) | `service recover <name>` (tier 1: the same approved version) | review › "S3: …" | fails |
| S4 soak_s past 24.8 days | Yes (p9: TimeoutOverflowWarning, the slot removed in 200 ms) | Chained timers (`MAX_TIMER_MS`); the validator's 30 days stand | review › "S4: …" (a chain of 400 ms timers ends a 2 s soak on time; a 28-day soak keeps its slot) | fails |
| S5 leftovers missed | Yes (p5a: leader dead, child alive; p5b: leader moved to `/`) | Each instance recorded at spawn with its pid, start time and group members (Linux `/proc`), and the boot id; the next supervisor ends what still matches | cli › "S5: the leftover's leader died since…"; "S5: the leftover moved its working folder…" | (a) fails with the members removed; (b) **passes with the leader check removed**, because the leader is itself among the recorded members: the leader check is a second path, not proven separately |
| S6 a late SIGKILL can hit a reused group | Yes (p13: `kill(-pid)` with `/proc/<pid>` gone) | A group is signalled only while its leader is unreaped, or while `/proc` shows a member of it; an exit watcher clears a dead alongside version | review › "S6: a stopped program's group number is never signalled…"; "S6: a version that dies alongside is cleared…" | both fail |
| S7 the program read blocks the supervisor | Yes (p6: the event loop stopped) | lstat (a regular file only), a 256 MB cap, an asynchronous read | review › "S7: …" | fails (hangs on the pipe; killed after 180 s) |
| S8 ports below 1024 and Nova's own | Yes (p1: 22, 80, 4317–4322 all passed) | The validator refuses < 1024; the driver refuses the console's configured port, the one it answers on, and the device door's, from Nova's configuration | definition › "ports below 1024…"; review › "S8: no service may take Nova's own ports, even while the console is restarting"; "S8: the console's configured port is refused even when the console answers elsewhere" | all fail |
| S9 health restarts never count | Not probed; reproduced by the test | Each health restart is counted in the crash window | review › "S9: …" | fails (never held) |
| minor: tripwire is PATH-only | Yes (p11) | A test reads `src/` and `scripts/` for a Kubernetes tool named as a command; the limit is stated | review › "no code … names a Kubernetes tool…" | fails (a planted `'kubectl'` is found) |
| minor: half-close | Yes (p7: "(nothing)") | `allowHalfOpen` on both sides; each end passed on | review › "the stable port answers a client that half-closes, and passes a reset on at once" | fails |
| minor: a reset | (the close-both guard was unproven) | A reset on either side ends both at once; a clean end is passed on | same test (`/reset` answered at once) | fails (the client waits for its timeout) |
| minor: renamed port | Yes (p2b: EADDRINUSE) | Stable ports keyed by number | review › "B2 (minor): a version that renames its port…" | fails |
| minor: setsid escapes | Yes (p12) | Not fixed: stated as a limit | — | — |
| minor: SIGHUP | — | Handled as SIGTERM | cli › "the supervisor stops on SIGHUP…" | fails (killed by the signal) |
| minor: processes recorded late | — | Recorded at spawn | covered by the S5 tests | not proven separately |
| minor: a failed install burns the name | — | Registered only after `apply` passes; a failed version's slot is removed | manager › "a version is registered only once it has passed…" | fails |
| minor: wrong comment (forwarder) | — | Rewritten | — | — |
| minor: forwarder points at a dead port | — | Targets cleared at the exit; connections refused at once until the restart | — | not proven by a test |
| minor: a program named `definition.json` | — | The program lives in `bin/`; the validator refuses the name | definition › "the rest of the shape…" | — |
| minor: health interval and overlap | — | The interval follows the live version; one check at a time | — | not proven by a test |
| minor: shadow on the real state twice | — | Shadow is one writer at the switch | review › "minor: shadow is one writer at the switch" | fails (exit 5: another copy) |
| minor: trivially true assertions | — | "No traffic" is checked where there is traffic to move | services, contract suite | — |
| p8 (a command not found) | No: refused in about 350 ms | — | — | — |

A probe run after the fixes: p1 refused at validation and plan; p2 old port answers, new port closed,
rename promotes; p3 rollback succeeds, 1.0.0 live; p4 not held, restarted; p6 refused in 352 ms; p7
200 through the stable port; p9 the slot kept; p10 held, truthful, two problems raised; p13 no group
kill. p5's own script reads the old record format and stopped; the S5 tests cover it.

**CI, and an M10d test race this branch's load exposed.** At `e1bdad88`, CI's test job failed twice
in a row, each time in `tests/core/network.test.ts` (M10d), on a different test: a phone request
sent while the simulated firewall allowed the mesh reached the hub after the change was armed, and
counted as contact (`kept` instead of `revert_failed` or `reverted`). Main's CI hadn't shown it; this
branch adds 61 tests that start many processes. Reproduced here by pinning main's file to one CPU
that two busy loops also hold: 2 runs of 3 failed. The fix is in the test only: the simulated
firewall is a gate in front of the mesh listener that checks each packet as it arrives (checked when
the phone sent it, a slowed request arrived after the change). Under the same pinning, 4 runs of 4
pass. The network module is unchanged.

One process left from a run with a fix reverted (a `--chdir` stand-in) was found afterwards and
ended; its cause wasn't pinned down. Runs of the real code leave none (checked after each).

## Seen failing (the first round)

| Guard removed | Test | Failed? |
|---|---|---|
| The driver's `switch` takes only a ready version | contract › apply never moves traffic… | yes |
| The manager offers only a ready version | manager › only a version that passed… | yes |
| Promotion wants `<service>@<version>` typed | manager › promotion asks every time… | yes |
| The canary points back by itself | services › health fails in its canary | yes |
| Failed health in the soak goes back | services › fails during its soak | yes |
| The group's SIGKILL after the stop | services › deployed alongside… | yes |
| The stop's SIGTERM to the whole group | services › deployed alongside… | yes |
| The program's SHA-256 check | services › plan, as a snapshot… | yes |
| The console's health path / command from its definition | services › console runs from its definition | yes |
| A restart keeps the crash count | services › crash is restarted… | yes |
| A killed supervisor's leftovers ended | cli › killed outright | yes |
| `copy` on a copy of the state | services › copy runs… | yes |
| The four validator refusals | definition › each | yes |
| `npm test` under the tripwire | no-kubernetes › armed | yes |

## Limits, plainly

- **The `service` change kind and `services.git` are not built** (deferred; see the top).
- **What runs:** a single file per program (no archives); Node is the only interpreter allowed before
  a program (Nova's own). A program may itself start anything it likes, as the person.
- **A process that leaves its group** (`setsid`, `detached: true`) is outside everything here: it
  outlives the service and the supervisor (the reviewer's p12).
- **The tripwire sees PATH lookups only:** a call by absolute path (`/usr/local/bin/kubectl`), or with
  PATH rebuilt from a fallback (`coding/git.ts`, `providers/checks.ts` use `/usr/local/bin:/usr/bin:/bin`
  when PATH is empty) isn't seen. A test reads the code for any Kubernetes tool named as a command.
- **Leftovers of a killed supervisor** are known through `/proc`: Linux only. Elsewhere they are left,
  and said so. A member that joined the group after the last record (health checks refresh it) and
  outlived its leader is ended only through the group.
- **Not run by the supervisor driver yet, and refused in plain words:** image-only services, services
  with secrets, `https:` artifacts, other devices, more than one replica.
- **Declared, not enforced:** `egress` and `os_permissions` for a plain program, which runs as the
  person, like the console. `resources.memory_mb` is checked against total memory only.
- **Tier 2 asks by typing**, as tier 3 does; only the words differ. `recover` is tier 1.
- **No `soak_s`** means the previous version is kept until the next promotion, and failed health goes
  back to it for that whole time.
- **`full`** runs the old and the new version on the real state until the old one stops (by design:
  both serve). `shadow`, `copy` and `none` are one writer at the switch.
- **No UI or API:** Settings › Services and the map are M10i/M10k.
- **The preview** (`scripts/preview.sh`) runs `src/server.js` directly, not under the supervisor, so
  nothing in it changes; it wasn't touched or restarted.
