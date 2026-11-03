# Ordinary npm test stall diagnosis

Date: 2026-11-02. Checkout: `/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build`, branch `codex/navigation-reachability`.

Scope: read-only examination of retained logs and narrowly relevant source. No tests, services, network requests, signals, fixture changes, or source fixes were performed. This report is the only file written by this diagnosis.

## Finding

The retained ordinary-run log now exposes an early fresh-user assertion failure, followed by a credible fixture handle leak. This explains the stalled test child without attributing it to the navigation changes. The exact process answering the unexpected discovery probe cannot be established from retained evidence.

## Evidence

- `npm-test-attempt-process.txt` records runner PID 1967752 and its fresh-user child PID 1967774 still alive at 367 seconds, with no fresh-user result printed at that point. The writer terminated only those owned processes; ordinary attempt exit 143 was recorded.
- `npm-test.log:280` and `:1891` now show the fresh-user test failing after **12,392.805195 ms**, at `tests/acceptance/fresh-user.test.ts:95`. The expected discoveries were model runtime, Home Assistant, and computer; the actual result additionally included `['screenpipe', false]`.
- The same log reports the fresh-user file lasting **394,058.803584 ms**, then `Promise resolution is still pending but the event loop has already resolved`. This terminal condition followed the targeted termination; it does not identify the original assertion cause. The delayed appearance of the early assertion and subsequent file output is consistent with test-runner output being held behind the unclosed child.
- `fresh-user.test.ts:41-42` opens a listening fake HTTP runtime and UDP mDNS responder. Its first `finally` at `:181-183` stops only Nova. The HTTP/UDP fixture closes are in the second, restart-specific `finally` at `:194-198`. Throwing at line 95 exits the first try/finally and bypasses the restart and both fixture closes. Their implementations (`tests/support/fake-mdns.ts:33-34`, `:47-48`) keep listening handles open until explicitly closed. This is a direct cleanup gap in the early-failure path.
- `scripts/test.sh:10` runs plain `node --test` under the tripwire, with no timeout or forced exit. Nothing there bounds a child left alive by fixture handles. The temporary-directory trap does not close those sockets.

## Why Screenpipe appeared

- Fresh-user supplies all three discovery ports explicitly (`fresh-user.test.ts:44`). Its Screenpipe probe is **not** the default `127.0.0.1:3030`, and the spawned server receives a blank synthetic environment plus those overrides (`tests/acceptance/support.ts:54-59`). There is no evidence that the owner's real Screenpipe was contacted.
- The supposed absent service port comes from `tests/support/fake-mdns.ts:52-57`: bind an ephemeral TCP port, close it, return its number. It is unreserved between selection and the later discovery request. A concurrent listener can claim it.
- Discovery treats any successful HTTP 200 response from that port's `/health` as Screenpipe (`src/core/onboard/discover.ts:91-99`), without checking its body. Thus another synthetic HTTP service exposing `/health` is sufficient to cause the exact observed result.
- The concurrently run UI capture fixture is a plausible participant, but not proven responsible: `tests/ui/m6a-capture.test.ts:23` calls `startFakeScreenpipe()` with default `port = 0` (`scripts/fake-screenpipe.js:22`) and keeps it alive through the test's finally. Its `/health` returns 200. `affected-ui.log` records that capture test passing in 12,181 ms. It does not record its allocated port or request times, so no exact socket match is possible. Other parallel test listeners, including a subsequently started Nova server, also remain plausible.
- The already-running guarded full-glob attempt records fresh-user passing in **7,093.915456 ms** (`npm-test-bounded.log:43`), without a discovery/fixture source change. This supports an intermittent fixture collision; it does not prove the identity of the other listener or validate ordinary process shutdown because that invocation uses forced exit.
- `git diff --` for the fresh-user test, fake mDNS helpers, discovery implementation, and ordinary test launcher is empty. These paths are outside the navigation working-tree edits.

## Classification and next decisive control

Treat this stall as an acceptance-fixture early-failure cleanup limitation, with a credible ephemeral-port reuse trigger. Do not call it a navigation production regression, an ordinary npm test pass, or a resolved harness issue. The full ordinary attempt also contains independent assertion failures; its totals are not green (1608 pass, 4 fail, 1 cancelled, 14 skipped).

No additional rerun is needed to explain the retained stall. If fixture repair is separately authorized, the smallest decisive control is a single-file, ordinary (no forced exit) scratch reproduction that deliberately throws before the restart and registers both fixture closes immediately after allocation. It must report the intended assertion promptly and exit by itself. To resolve the separate discovery flake, hold a synthetic loopback server returning 404 on the absent service ports for the entire test, rather than releasing a supposedly free port; capture each selected port and `/health` response if the unexpected result recurs. This controls the named port-reuse doubt without touching owner services or broadly rerunning the suite.
