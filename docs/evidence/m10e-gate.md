# M10e gate evidence: the Service Manager and the supervisor driver

The ADR is `docs/plans/M10-orchestration.md` (Point 1, "With the K3s driver off", "The service
definition", Point 4, Hard limits, Order), and the plan is `docs/plans/M10e.md`. Everything here ran
on 2026-10-31 on this machine (WSL2, Node 26.3.1), in temp folders made with `mkdtemp(os.tmpdir())`.
The services are the stand-in `scripts/stand-ins/fake-service.js`, bound to 127.0.0.1 on free ports;
the console under the in-process supervisor is the stand-in server of `tests/supervisor/fake.ts`. No
Kubernetes, Helm or Flux was installed or run. This machine has a real `kubectl` at
`/usr/local/bin/kubectl`; the tripwire shadows it for the whole suite, and it was never called.

## Suite

`npm run check` passes: the token lint, themes, typecheck, and **1114 tests: 1105 pass, 0 fail, 9 skipped** (31 of them new). The 9 skips are the
existing opt-in real-service tests. Before M10e, main's suite was 1083 tests (1072 pass, 9 skipped,
2 failing in `tests/core/computer-egress-bounds.test.ts` under the full run's load on this machine;
that file passes alone, 8 of 8, and is untouched here).

`scripts/ui-test.sh` (Chromium in the Playwright container, under the tripwire): **87 tests: 87 pass, 0 fail**. CI on PR #247: both jobs green, and both logs show the tripwire armed and never fired (`checks`: 1114 tests, 1105 pass, 9 skipped; `UI gate`: 87 of 87).

The run's log, start and end (`npm test` and the UI gate both say it):

```
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
…
no-Kubernetes tripwire: never fired
```

The new tests:

| File | Tests | What it proves |
|---|---|---|
| `tests/core/services-definition.test.ts` | 8 | The format; one test per refusal the ADR names; every other malformed field; the console's definition; the promotion tier |
| `tests/core/services-manager.test.ts` | 6 | The manager's own rules against a recording driver: validation first, the first driver that can run it, each version registered once, typed promotion at its tier, only a ready version offered, rollback asked |
| `tests/support/service-driver-contract.ts` | (shared) | What every driver must do; run by the supervisor driver now and by the K3s driver in M10j |
| `tests/supervisor/services-contract.test.ts` | 2 | The contract suite on the supervisor driver |
| `tests/supervisor/services.test.ts` | 10 | The gate's lifecycle, each failure path, crash rules, alongside modes, a supervisor restart, the plan snapshot and refusals, the console from its definition |
| `tests/supervisor/services-cli.test.ts` | 2 | The command line on a real supervisor process; a supervisor killed outright |
| `tests/acceptance/no-kubernetes.test.ts` | 3 | The tripwire is armed for the run, it fires, and Nova running a service leaves no `~/.kube` |

The existing supervisor tests are unchanged (`git diff origin/main -- tests/supervisor/{checkpoints,guards,releases,rollback-mark,record-problem}.test.ts tests/supervisor/{fake,support}.ts tests/chaos/hub.test.ts` is empty) and green, and so is `tests/acceptance/fresh-user.test.ts`.

## Gate items

### 1. The console runs from its definition, through the supervisor driver, with today's tests unchanged and green

- `tests/supervisor/services.test.ts` › "the console runs from its definition: its command and its
  health check are the definition's": a console definition naming another script (`src/console.js`)
  and another health path (`/console-health`), which the stand-in console alone answers. The console
  starts from that script, its health checks pass, and it is never restarted. The driver's status
  lists `nova-console` live at `base`, healthy.
- The console's deploy path is the supervisor's own, unchanged: `Supervisor.deploy` and
  `Supervisor.rollback`, which the driver's `switch` and `rollback` call for `nova-console`. Today's
  restart, safe-mode, canary, migration and checkpoint tests (`tests/supervisor/*.test.ts`,
  `tests/chaos/hub.test.ts`) are unchanged and pass.
- The console's plan (snapshot): prepare, tests, sandbox, smoke, approval (tier 3), switch, canary,
  promote.

### 2. A second, plain-program service is deployed, promoted, soaked and rolled back

`tests/supervisor/services.test.ts`:
- "deployed alongside with no traffic, promoted on the typed word, soaked, and the old slot removed
  after the soak": 1.0.0 is installed (SHA-256 checked) and passes its contract test and three health
  checks; nothing answers on the stable port until it is promoted. 2.0.0 runs alongside on its own
  port while the stable port still answers 1.0.0. After promotion the stable port answers 2.0.0, 1.0.0
  is kept and stopped, its whole process group too: the child it started was asked to stop
  (SIGTERM) and then made to (SIGKILL). A client that kept its connection open reaches 2.0.0. After
  `soak_s` (2 s) the 1.0.0 slot is removed and the record says “Its soak ended with 2.0.0 healthy, so
  its slot was removed.” The service's `HOME` is its own folder.
- "a version that fails its contract tests is never offered": `Stopped at tests: http:/contract:
  /contract answered 404`; the version is `failed`, stopped, and promotion is refused (“isn’t ready to
  promote”); the problem `service-stopped` says “never offered. 1.0.0 keeps running”.
- "a version whose health fails in its canary is rolled back by itself": `Rolled back: /health
  answered 500`; the stable port answers 1.0.0, the same process throughout; `service-rolled-back` is
  told.
- "a version that fails during its soak goes back in one step, with nothing installed or
  downloaded": 1.0.0's source file is deleted after the promotion; 2.0.0 turns sick in its soak; after
  two failed health checks 1.0.0 runs again from its kept slot, byte for byte as installed.
- "a crash is restarted with a growing wait; three within the window and the service is held": the
  console is untouched by it.
- "a rollback the person asks for wants the word, and goes back to the kept version".
- "copy runs the new version on a copy of the state, then on the real one after the switch; none
  starts only at the switch".
- "the services run again after the supervisor restarts, on the same stable port".
- `tests/supervisor/services-cli.test.ts`: the same through `node src/supervisor/main.ts` (plan,
  deploy, promote refused without the typed `stand-in@1.0.0`, `services`, rollback refused without
  the word), and the service stops with the supervisor. A supervisor killed with SIGKILL leaves its
  service and that service's child running; the next supervisor ends that process group (its working
  folder is the version's slot) before starting its own instance.

### 3. The driver interface is exercised by the driver's tests

`tests/support/service-driver-contract.ts`, run by `tests/supervisor/services-contract.test.ts`:
available; a plan in the stages' order with its tier; apply gives no traffic; only a ready version
switches (a version failing its contract tests is refused by `switch` itself); rollback is one step
and then there is nothing kept. **Only one driver exists in M10e**, so "both drivers' tests" is half
met: the K3s driver (M10j) must run this same suite.

### 4. The definition: a validator test per refusal, and the supervisor's plan as a snapshot

`tests/core/services-definition.test.ts`: "refused: a floating service that has state"; "refused: an
image-only service pinned to a macOS or a Windows device"; "refused: a placement no device's roles
allow"; "refused: a secret written as a value instead of a secret:// name" (the value is never
repeated back). `tests/supervisor/services.test.ts` › "the supervisor driver's plan, as a snapshot,
and what it refuses in plain words": the full plan, step by step, and the driver's refusals (image
only, secrets, pinned elsewhere, replicas, memory, a web address, a program whose SHA-256 isn't the
pinned one: “Nothing was installed”). The values-file snapshot and the chart lint are M10j's: no Helm
code exists.

### 5. No Kubernetes anywhere, and the tripwire shown to work

- `npm test` (`scripts/test.sh`), `npm run test:ui` (CI's UI gate) and `scripts/ui-test.sh` run
  through `scripts/tripwire.sh`.
- `tests/acceptance/no-kubernetes.test.ts` › "the tripwire is armed for this run": `command -v` finds
  each of `kubectl`, `helm`, `flux` and `k3s` in the tripwire's folder (on this machine, ahead of the
  real `/usr/local/bin/kubectl`), and `KUBECONFIG` is unset. › "the tripwire fires": each tool called
  in a run whose command succeeds makes the run fail with `tripwire: FIRED` and the call
  (`helm rollback nova-service 1` included); a clean run passes with its own result. › "Nova running a
  service … leaves no ~/.kube": no `.kube` anywhere in its homes, and nothing called.
- By hand: a throwaway test that calls `kubectl version --client` and passes, run through
  `scripts/test.sh`: the test passed, the run exited 1 with “FIRED. Called during the run: kubectl
  version --client”.

### 6. Services bind 127.0.0.1 on free ports and are stopped in teardown, process groups included

Every supervisor test ends with `stop()` (`tests/supervisor/services-support.ts`), which records every
pid the supervisor started (console and services) while it ran and fails unless all are gone after
`close()`. Stable ports are picked below the ephemeral range (see "Mistakes" below).

### 7. The fresh-user test

`tests/acceptance/fresh-user.test.ts` passes unchanged in the suite.

## Seen failing

Each guard was removed in turn and its test run against it (`--test-name-pattern`), then put back:

| Guard removed | Test | Failed? |
|---|---|---|
| The driver's `switch` takes only a ready version | contract › apply never moves traffic… | yes |
| The manager offers only a ready version | manager › only a version that passed… | yes |
| Promotion wants `<service>@<version>` typed | manager › promotion asks every time… | yes |
| The canary points back by itself | services › health fails in its canary | yes |
| Failed health in the soak goes back | services › fails during its soak | yes (timed out waiting for the rollback) |
| The group's SIGKILL after the stop | services › deployed alongside… | yes (the child outlived it) |
| The stop's SIGTERM to the whole group | services › deployed alongside… | yes (the child was never asked) |
| The program's SHA-256 check | services › plan, as a snapshot… | yes |
| The console's health path from its definition | services › console runs from its definition | yes |
| The console's command from its definition | services › console runs from its definition | yes |
| A restart keeps the crash count | services › crash is restarted… | yes (never held) |
| A killed supervisor's leftovers ended | cli › killed outright | yes |
| `copy` on a copy of the state | services › copy runs… | yes |
| Validator: floating with state | definition › floating service that has state | yes |
| Validator: image-only on macOS or Windows | definition › image-only service pinned | yes |
| Validator: no device's roles allow it | definition › placement no device's roles allow | yes |
| Validator: a secret as a value | definition › secret written as a value | yes |
| `npm test` under the tripwire | no-kubernetes › armed | yes |
| The forwarder closes both sides together | services › deployed alongside… | **no**: see below |

**Not proven by its test:** the forwarder destroying the client side when the upstream side closes
(and the reverse). With it removed, the kept-alive client still reached the new version, because the
stream's own end already reaches the client. It is kept as a defence against an upstream that resets
rather than ends; no test shows that case.

## Mistakes found and fixed during the build

- The first restart after a crash reset the crash count (the restart shared the rollback's code), so
  a crash loop was never held. Caught by the crash test; the count now resets only on promotion and
  rollback.
- The first full run failed once: another test's `listen(0)` took a stand-in's stable port between
  choosing it and the promotion that binds it. Test stable ports now come from below the ephemeral
  range, and the driver tries a start that ends at once again on new ports (twice at most).
- An early helper reused kept-alive connections and saw a closed one after a switch; the helper now
  opens a new connection per request, and a separate assertion checks the kept-alive case.

## Limits, plainly

- **The `service` change kind and `services.git` are not built.** The ADR's Order lists the change
  kind in M10e, but its artifact is "the definition plus the rendered values", its stages commit to
  `services.git`, and every gate item for it is GitOps (M10j/M10k). Services are deployed through the
  supervisor's command line with typed confirmations, as console releases are.
- **M10d (PR #241) is not merged.** The ADR has M10e wait for it; this was built on main as instructed.
  It shares `src/core/index.ts`, `src/core/README.md`, `docs/LEDGER.md` and the inventory with #241:
  expect small merge conflicts there.
- **Not run by the supervisor driver yet, and refused in plain words:** image-only services (no Docker
  runs, per the image-pull limit), services with secrets (no vault hand-off), `https:` artifacts (no
  downloads), other devices (M10f, M10h), more than one replica.
- **Declared, not enforced:** `egress` and `os_permissions` for a plain program, which runs as the
  person, like the console. `resources.memory_mb` is checked against this machine's total memory only.
- **Tier 2 asks by typing**, the same mechanism as tier 3; only the words differ.
- **No `soak_s`** means the previous version is kept until the next promotion, and failed health
  goes back to it for that whole time.
- **Leftovers of a killed supervisor** are found through `/proc` (the process's working folder is the
  slot): Linux only. Elsewhere they are left and said so.
- **No UI or API:** Settings › Services and the map are M10i/M10k. The console doesn't show services
  yet; the state file and `services` do.
- **The preview** (`scripts/preview.sh`) runs `src/server.js` directly, not under the supervisor, so
  nothing in it changes; it wasn't touched or restarted.
