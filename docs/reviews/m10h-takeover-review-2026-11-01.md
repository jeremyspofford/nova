# M10h takeover review — 2026-11-01

## Final review continuation

Two independent reviewers examined source `acbda56b` against main `31846fac`, with the binding ADR and capture design, without receiving PR claims. They completed synthetic live probes and returned eight reproducible findings. Reports: `m10h-independent-workloads-2026-11-01.md` and `m10h-independent-capture-2026-11-01.md` in this directory. The interrupted attempt below remains historical; it is not counted as a completed review.

The workload fix is `1505ab96` (integrated as `d5106c07`). Failing regressions first demonstrated descendant leaks, redirect escape, silently discarded contracts, a live/staging version collision, and safe-mode reset. Fixes end remaining owned process groups on leader exit, refuse redirected health and unsupported device contracts, stage outside the version namespace, and preserve the watchdog crash budget. Explicit stop/start recovery remains available. Independent re-review reran all five original scenarios and passed 53 focused tests with no skips or additional actionable finding; see `m10h-workloads-rereview-2026-11-01.md`.

The capture regressions were committed RED at `db32fcfe` (integrated as `a842c4b7`), before fixes at `13d3752a` (integrated as `c70a678f`). They demonstrate stale raw policy, missing replicated recovery metadata, and permanently abandoned off-consent deletion. Fixes recheck current home placement and consent at offer/upload, refresh device permission before raw read/send, replicate raw metadata, and durably retry privacy deletion across restart, including when capture is off. Root review also required explicit sync denial and refreshing policy before derived batch sends. Cloud raw remains unavailable in every privacy mode until a separate per-device opt-in exists.

Combined coordinator verification: typecheck passed. In disposable Playwright Docker, workload regressions, existing device/rollout/hub suites and the three-device pilot passed **27/27**. Capture regressions, existing carrier/sync, replication/skew, backups/checkpoints and the pilot passed **57/57** before the final derived-send refinement. At combined implementation `54be3d7c`, the final carrier privacy regressions, existing carrier checks and the pilot passed **16/16**, with the tripwire armed and untouched. Typecheck, token lint, theme validation and diff check passed. An implementer's full host suite recorded 1,553 passed, 13 skipped and one existing skills timeout; the unchanged skills file passed 9/9 alone. Another full host run was stopped incomplete at a device-agent subprocess. These are limits of local validation, not green full-suite claims. No real device, capture data, cloud service or owner home was touched.

Independent final capture re-review pinned combined `54be3d7c`: all original capture probes and the six extra raw fail-closed scenarios pass. Its 101-event probes hold the second batch on policy denial or an unavailable refresh, report the hold and resume the remaining event exactly once after permission returns. The focused capture/replication/backup suite passed **39/39**, no skips, with no remaining actionable finding in the reviewed diff. Workload source exactly matches its independently reviewed `1505ab96`; capture source exactly matches `4aef4b2d`. Report: `m10h-capture-rereview-2026-11-01.md`.

Exact final-head CI remains a merge prerequisite. After the required `gate` is green, merge with `--match-head-commit` and restart/verify the preview. The final PR body records that head and CI run; historical host failures below are not renamed green.

## Historical interrupted attempt

The independent reviewer examined code at `4d060ccd`, with `origin/main` at
`001f373f` (the handoff-only merge). It received the source and binding requirements,
not the PR's claims. It identified candidate failures, then an automated safety filter
interrupted its turn. A request to return its already-gathered defensive findings was
also interrupted. There is no completed independent report and no independent live
probe result to count as a passed review. No further attempt was made to bypass that
filter. The following fixes and validations are the coordinator's work, not independent
approval of the branch.

## Reproduced and fixed

1. **A signed installation was sufficient to switch live before hub promotion.**
   The new real-boot-agent test in `tests/core/workloads-rollout.test.ts` failed with
   `true !== false` on “signed and installed does not mean promoted.” The boot agent
   now records the assignments obtained through its own authenticated heartbeat,
   outside the runtime's permissions, before answering the runtime. Workloads check
   that grant when a queued verb executes and again before spawning. Installing a
   signed artifact does not grant promotion. The assigned previous live version remains
   available for rollback without a download. The test now passes.
2. **Queued execution did not recheck a withdrawn grant.**
   A controlled download in `tests/core/workloads-device.test.ts` queues a switch,
   withdraws authorization while installation finishes, then releases the download.
   Before the fix the switch succeeded; afterwards it is refused and its port stays
   closed. The five-verb interface is unchanged.
3. **Forgetting a fetched original left its recovery copies behind.**
   The raw-fetch test in `tests/core/capture-sync.test.ts` demonstrated the original
   still existed in a nightly backup after its event was forgotten. The backup cleaner
   now obtains original IDs before removing event-related rows, removes their files
   and metadata, and rewrites the sealed manifest. The test covers the ordinary backup,
   its decrypted encrypted copy, and a checkpoint. A separate failing assertion showed
   `capture/` was not recognized as Nova-owned data; it is now included in the home
   recovery/reset entry list. No owner home was read or changed.

## CI and local verification

- Original head `4d060ccd`: CI run `41306044910` first failed the handoff's named
  `m10d-review.test.ts:353` snapshot test. Its one requested rerun passed that test but
  failed `tests/chaos/hub.test.ts:67`: the test constructed a URL while the restarted
  server's ephemeral port was still `null`. The UI job passed. The overall gate failed.
- The chaos test now polls an actual port and the expected problem record, allowing
  transient startup connection failures within the existing timeout. All four tests
  in `tests/chaos/hub.test.ts` passed locally after that change. This does not weaken
  the required restart, problem or health assertions.
- M10h's original six files: 25/25 passed before changes. After the fixes, the four
  files covering device verbs, rollout, capture sync and the three-device pilot passed
  21/21. The backup, checkpoint and forgetting suites also passed in a 28-test run
  before the final queued-grant test was added. Typecheck, token lint, theme validation
  and `git diff --check` passed.
- The first full local check completed: 1545 tests, 1530 passed, 2 failed, 13 skipped.
  The failures were `provider-guard.test.ts:170` (stand-in CLI result missing) and
  `skills-api.test.js:81` (timeout), both named as local timing problems in the handoff.
  Provider guard passed 8/8 when run alone; the skills test passed in the later focused
  run. These isolated passes do not make the original full run green.
- A later low-concurrency full run stalled with the `fresh-user.test.ts` process still
  open. Only that run's verified process tree was terminated. A bounded full run uses
  `npm test -- --test-concurrency=4 --test-force-exit --test-timeout=120000`; it completed
  with 1547 tests: 1531 passed, 3 failed, 13 skipped. The failures were the same provider
  and skills tests plus `tests/ingest/round2.test.js:87` (15-second timeout), also in the
  handoff's local timing list. Every M10h test passed. The full local suite is therefore
  **red**, not waived. CI's required workflow is unchanged.

## Requirements at the historical checkpoint

- A completed independent adversarial review of the final code, including live checks
  of deletion retry behavior; that candidate was not validated by the interrupted
  reviewer and is not claimed fixed here.
- Green CI on the exact final PR head, including the required `gate` check.
- Only then: merge with `--match-head-commit`, update the preview from main using its
  own script and the handoff's mesh variables, and verify all three HTTP endpoints.

PR #277 remains behind #276 in track order. Vault PR #275 still requires its separate
live review and the owner's second-model inputs. Neither owner exception is waived.
