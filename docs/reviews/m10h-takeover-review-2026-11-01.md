# M10h takeover review status — 2026-11-01

**Gate status: INCOMPLETE. Do not merge PR #276 on this document.**

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

## Still required

- A completed independent adversarial review of the final code, including live checks
  of deletion retry behavior; that candidate was not validated by the interrupted
  reviewer and is not claimed fixed here.
- Green CI on the exact final PR head, including the required `gate` check.
- Only then: merge with `--match-head-commit`, update the preview from main using its
  own script and the handoff's mesh variables, and verify all three HTTP endpoints.

PR #277 remains behind #276 in track order. Vault PR #275 still requires its separate
live review and the owner's second-model inputs. Neither owner exception is waived.
