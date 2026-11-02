# M10j task 5 ordinary UI failure investigation

Status: **NEEDS_CONTEXT — exact CI failure cause remains unproved; no repair or source commit.**

Owned checkout: `/home/jeremy/.codex/worktrees/nova-m10i-topology/nova-build`; branch `codex/m10j-k3s`; unchanged source HEAD/base `8916fed0d726345ca7a9accb79012d75d87aa799`.

## Actual gate remains RED

Read the task brief, failing test and fixture, shared device support, relevant theme/router/navigation support, systematic-debugging skill, TDD skill and its writing-good-tests reference. Did not reread the full plan or previous reviews.

The full actual CI log `.superpowers/sdd/M10j/ci-final-ui-125555336561.log` reports 157 UI tests, 156 pass, 1 fail. The sole failure is the WebKit six-theme/two-layout topology test, with nine exact `Failed to load resource: WebKit encountered an internal error` console messages in `d.errors` at the assertion after the phone theme loop. The log supplies neither failing resource URLs nor console locations. The local observations below do not supersede that failure.

## Named hypothesis and bounded probes

Hypothesis: the loop's `map()` hard navigation disposes the app's concurrent design-system event reads, causing the nine WebKit internal-error messages. Theme apply dispatches a real event that starts `/design-system.css`, `/api/v1/design-systems`, `/api/v1/design-systems/active?device=...`, and `/api/v1/profile` reads. All four belong to the existing document. The test subsequently performs another `page.goto('/topology')`.

Every diagnostic records actual `requestfailed` URL, resource type and `failure().errorText`, console error text and `location()`, and all main-frame navigation request URLs. Shared `device().errors` is unchanged and never cleared or filtered. No tracked files were edited. Disposable probe files and logs are all under the owned ignored `task-5-ui-*` namespace.

### Probe 1: Playwright-held actual fixture responses

Files: `task-5-ui-diagnostic-v1.test.ts`, `task-5-ui-diagnostic-v1.log`; the initial log is also preserved as `task-5-ui-diagnostic.log`.

The probe uses the actual WebKit app and fixture. Each of the four theme requests is fetched from the real fixture, then held before fulfillment. Once all four are captured, hard navigation replaces the document before release.

Hard-navigation arm: PASS for its observational contract; two actual main-document requests, four canceled fetches at exactly the four paths above, two canceled event sources (`/api/v1/events`, `/api/events`); all report `Load request cancelled`. **Zero console errors, zero device errors.** This is evidence of cancellation, not the CI console failure.

SPA control: FAIL because the first probe selected the desktop rail's Settings control on a phone. It timed out after 30 seconds at `#rail [data-dest="settings"]`; this was a diagnostic locator error, not a product failure. Cleanup released held requests and closed the browser/fixture. Complete summary: 2 tests, 1 pass, 1 fail, 0 canceled/skipped/todo; exit 1; tripwire never fired. The failed probe is retained, not overwritten or represented as a product RED.

### Probe 2: Real-server partial-response disposal, corrected visible phone control

Files: `task-5-ui-diagnostic.test.ts`, `task-5-ui-diagnostic-v2.log`.

To remove request interception as a variable, the fixture server temporarily prepends a request observer. For only the four owned theme paths, it sends the first half of each actual response body and holds its remaining bytes. After capturing all four, it removes its observer. Both arms use a real theme apply and the same held traffic. The hard arm calls `page.goto('/topology')`; the SPA arm clicks the actual phone `More → Settings → Services → Machines and services` links. All held responses are released; no live fetch or event source is disabled.

Hard-navigation arm: two main-document requests; exactly four canceled fetches at the held theme paths plus two canceled event sources, all `Load request cancelled`; **zero console errors/device errors**.

SPA paired control: one lifetime main-document request; **zero failed requests, console errors or device errors**. Both arms finish with actual topology machines visible and the orb-teal metadata plus installed style content present.

Summary: 2 tests, 2 pass, 0 fail/canceled/skipped/todo, 3483.780833 ms, exit 0, tripwire never fired. This proves the difference in document lifetime and cancellation under the controlled transition. It does **not** reproduce the generic internal-error console message and therefore does not prove the actual gate's cause.

### Probe 3: One instrumented original WebKit six-theme test, ordinary scheduling

Files: `task-5-ui-ordinary-diagnostic.test.ts`, `task-5-ui-ordinary-diagnostic.log`.

A disposable copy of the original complete six-theme test retains its real assertions, helpers and fixture; only the Chromium case and unrelated tests are omitted, with added event diagnostics. It runs once, without any held response, retry, new wait or changed navigation. This examines whether the ordinary failing sequence produces a different resource failure class.

Phone: 6 main-document requests, 30 failed requests consisting of 20 fetch cancellations (the four theme read paths on each of five replacements) and 10 eventsource cancellations; all `Load request cancelled`. Zero console/device errors.

Desktop: the same counts: 6 documents, 20 fetch cancellations, 10 eventsource cancellations; zero console/device errors.

All six themes, both layouts, overflow checks, layers, keyboard focus, exact server snapshot export, policy sheet checks, and long-name refresh assertions pass. The approved screenshot code remains present but no screenshot environment flag is set. Summary: 1 test, 1 pass, 0 fail/canceled/skipped/todo, duration 8717.419418 ms, exit 0; test duration 8258.795099 ms; tripwire never fired. This was a single diagnostic run, not a retry or accepted replacement for the CI RED.

## Conclusion and next evidence

Repeated hard navigation is concretely disposing real theme fetches. **Cancellation alone did not cause the exact console symptom in any completed diagnostic**, including real partially delivered server responses and the full original affected WebKit test. It is not justified to classify the nine CI messages as harmless or ship an SPA rewrite as a proven repair based on these results. The hypothesis remains plausible under additional CI conditions, but is not established; no alternate cause has been established either.

Stop here under the task's bounded-investigation requirement. Proposed next step for root consideration: diagnostic-only instrumentation on the actual original WebKit case during the next qualified ordinary CI run. Record per-context main-document navigation lifetime, requestfailed URL/resource type/errorText, console text/location, current theme/layout, and a bounded list of in-flight requests. Keep all existing errors and assertions intact. Emit the diagnostic state in `finally` so the information survives the failing assertion. This would distinguish canceled fetches from failing assets/other requests and correlate the exact generic console entries with real document replacements. Do not expand to a behavior change until that run or a distinct deterministic probe establishes the exact failure mechanism.

No actual controlled product RED→GREEN exists. The initial diagnostic locator failure is explicitly not such evidence. Therefore no permanent regression or repair was added, no source commit was made, and covering suite/typecheck work for a repair was not claimed or run. A rerun passing locally does not close the required UI gate.

## Exact execution environment and commands

All three runs used the already cached image `mcr.microsoft.com/playwright:v1.56.1-noble`, inspected ID `sha256:f1e7e01021efd65dd1a2c56064be399f3e4de00fd021ac561325f2bfbb2b837a`. No image pull/install, real Kubernetes/cloud/model tools or owner data. All browsers, app servers, synthetic stores, stand-ins and held traffic were loopback fixture-owned.

Common command prefix, from the exact checkout:

```sh
docker run --rm --pull=never --init --ipc=host \
  -v /home/jeremy/.codex/worktrees/nova-m10i-topology/nova-build:/work -w /work \
  -v /home/jeremy/.local/share/mise/installs/node/26.3.1:/opt/node:ro \
  --user 1000:1000 -e HOME=/tmp -e CI=1 \
  mcr.microsoft.com/playwright:v1.56.1-noble bash -c \
  'export PATH=/opt/node/bin:$PATH CHROMIUM=/ms-playwright/chromium-1194/chrome-linux/chrome; sh scripts/tripwire.sh node --test --test-concurrency=1 --test-force-exit --test-timeout=900000 PROBE'
```

Run 1 PROBE: `.superpowers/sdd/M10j/task-5-ui-diagnostic.test.ts`, before archival to v1; output `.superpowers/sdd/M10j/task-5-ui-diagnostic.log`, preserved copy v1.log; exit 1.

Run 2 PROBE: `.superpowers/sdd/M10j/task-5-ui-diagnostic.test.ts`, real-server version; output `.superpowers/sdd/M10j/task-5-ui-diagnostic-v2.log`; exit 0.

Run 3 PROBE: `.superpowers/sdd/M10j/task-5-ui-ordinary-diagnostic.test.ts`; output `.superpowers/sdd/M10j/task-5-ui-ordinary-diagnostic.log`; exit 0.

No warnings were printed by these probes. Every log contains armed and never-fired tripwire lines. No NOVA_UI_SHOTS or baseline-update variable was set. No tracked screenshot changed. No full 1735-unit or 157-UI suite rerun.

Final `git status --short` and `git diff --check`: both empty/exit 0. Final `docker ps --filter ancestor=mcr.microsoft.com/playwright:v1.56.1-noble` returns no running containers. All three sessions returned final exit statuses; every hold was released in cleanup and each browser and fixture closed. No writes or processes remain after this report.

## Release

**RELEASE** sole-sourcewriter ownership; no source changes/commit. Root retains independent review/ordinary CI/public-record authority. Full M10j phase remains NOT PASSED; draft 283, missing actual P1a/P1b/P1c and parked #275 B remain unchanged. No push, PR, merge, deploy, M10k, history rewrite, dependency/waiver/security-policy/production change, protected preview or other-worktree action occurred.

# Follow-up: diagnostic-only implementation authorized by root

The original NEEDS_CONTEXT conclusion and all investigation/probe records above are preserved. Root explicitly authorized a separate observational feature through `task-5-ui-diagnostics-brief.md`, to obtain missing resource/lifetime evidence in an ordinary CI run. This is **not a repair** of the original nine-error failure. Its cause remains **UNPROVEN**, including if the next ordinary CI run passes.

## Source scope and behavior

Only these three test files are changed/added:

- `tests/ui/topology-diagnostics.ts`: isolated observer, no production imports or changes.
- `tests/ui/topology-diagnostics.test.ts`: actual Chromium/WebKit controls for diagnostic properties.
- `tests/ui/m10i-topology.test.ts`: import observer; create one per original six-theme/layout context before initial map; set synchronous stage markers; snapshot/log in `finally`, then dispose and close context.

All original six themes, both layouts, repeated `map()` hard navigations, theme apply/readiness operations, polling, layer/focus/export assertions, deep links, error collection and strict `assert.deepEqual(d.errors, [])` remain. No sleep, browser await, drain, retry or other synchronization is inserted into the successful theme flow. The original context close still runs after successful error assertion; the new finally also closes it on failure. The shared `device()` and all its listeners/error arrays are unchanged. No generic error message is filtered from the assertion. The observer's diagnostic sanitization cannot change the device error collection or pass/fail result.

The report emits one structured `M10i topology diagnostics` JSON line for each attempted layout even when an assertion throws. Its snapshot is taken before context close, so closing a test context does not contaminate the diagnostic event record. `dispose()` is in a nested finally and removes exactly its four installed listeners, clears its pending map, and is idempotent. Existing outer browser/fixture cleanup remains.

## Evidence model and limits

`navigationSequence` counts public main-frame navigation **request events** since observer installation. It is not a count of committed documents or proof of an exact source document's ownership. Same-document/hash transitions do not increase it; reload does. Each retained request has its request-start sequence, theme-under-test/layout/stage and monotonic elapsed milliseconds. Failures separately record the sequence, stage and elapsed time when the failure event is observed. This distinction matters: WebKit can report cancellation before the next navigation request event; Chromium can report it after. Request sequences are not upgraded into causal/source-document claims.

Theme context is the current test-loop theme under test, not a new browser evaluation of the installed stylesheet. Original readiness checks still establish the stylesheet behavior.

The observer captures only request URL pathname, method, resource type, public errorText, console error text/location, and the bounded stage context. It never asks for headers, postData/body, cookies, query parameters or fragments. URL authorities/userinfo/query/fragments are stripped in request and console source locations and in full/relative URL tokens in console/error strings. Opaque/non-network URL schemes become `[opaque-url]`; malformed URLs become `[invalid-url]`. Browser error codes such as `net::ERR_ABORTED` are preserved. Empty console source URLs remain empty rather than inventing a location.

Events, pending request metadata and recent main-frame navigation records each retain at most 32 entries. Strings are capped at 256 characters. Counts expose evicted events, pending records and document records. The count of navigation requests continues increasing after record eviction. A failure whose start metadata was evicted receives `started: null`, never the current sequence as a guessed start. Output is bounded by these fixed capacities and string limits. Older events may be absent; counters explicitly describe that limitation. No unbounded raw URLs, bodies or diagnostic arrays are logged. Snapshot returns a structured clone rather than mutable internal state.

## New diagnostic TDD and intermediate results

These are **diagnostic-feature** RED/GREEN controls, not a reproduced original product RED→GREEN.

1. `task-5-ui-observer-red.log`: initial empty observer contract; actual browser controls fail correctly on missing document-request count and missing bounded console events. **3 tests, 0 pass, 3 fail, 0 canceled/skipped**, exit 1, tripwire never fired.
2. `task-5-ui-observer-green-1.log`: first implementation. **3 tests, 2 pass, 1 fail, 0 canceled/skipped**, exit 1. Failure: WebKit observed cancellation at sequence 1 while the test incorrectly assumed it must be sequence 2. Corrected the control to compare with an independent counter on actual public events; did not change observer attribution to invent sequence 2. Tripwire never fired.
3. `task-5-ui-observer-redaction-red.log`: expanded relative URL canary. **3 tests, 2 pass, 1 fail, 0 canceled/skipped**, exit 1, `RELATIVE_CANARY` disclosed. Added relative URL query/fragment sanitization. Tripwire never fired.
4. `task-5-ui-observer-green-2.log`: **3 tests, 3 pass, 0 fail/canceled/skipped**, exit 0, 2401.917273 ms, tripwire never fired. This precedes expanded malformed URL, metadata-eviction and exact browser error code controls and is not final verification.
5. `task-5-ui-observer-types-1.log`: typecheck exit 1. Diagnostic test needed discriminated-union narrowing and an explicit Node EventEmitter type for Playwright's runtime listener count in the cleanup control. Corrected without any production change. `task-5-ui-observer-types-2.log` then passes, exit 0.
6. `task-5-ui-observer-malformed-red.log`: **3 tests, 0 pass, 3 fail, 0 canceled/skipped**, exit 1. Two test expectations incorrectly assumed `evaluate()` console messages always carry `/` source locations; actual public source URL was empty. Replaced with real owned external-script emission and comparison against actual public console source metadata. Third failure proves malformed relative URL could throw `TypeError: Invalid URL` inside the observer; moved all parsing under the safe parser, retaining invalid marker. Tripwire never fired.
7. `task-5-ui-observer-covering.log`: first complete covering attempt. All **24 original topology tests plus 2 browser observer controls passed**, then the final stress control stalled waiting for held `/pending/0` routes. The owned container `fbc147ff6b50` was explicitly stopped with `docker stop --time 5` (Docker printed the deprecation notice to use `--timeout`); Docker run exit **137**, **no final passing summary**, and **no tripwire completion line** (armed line present). This is not reported as a passing suite. The later isolated probe establishes the test's wrong route glob, below.
8. `task-5-ui-observer-types-final.log`: intermediate typecheck exit 0 before final error-code/control corrections.
9. `task-5-ui-observer-errorcode-red.log`: exact public browser errorText control. **3 tests, 1 pass, 1 fail, 1 canceled, 0 skipped**, exit 1, tripwire never fired. Chromium diagnostic erroneously emitted `[opaque-url]` for real `net::ERR_ABORTED`; fixed scheme recognizer so the browser's double-colon code is not treated as a URL. The stress test also reaches its new explicit 30-second timeout, retaining that canceled test in the record.
10. `task-5-ui-observer-stress-diagnostic.test.ts` / `.log`: disposable instrumented copy selects only the bounded stress control, logs progress without changing the helper. It reaches console-buffer collection, 35 navigation requests, all 80 fetch starts, and then waits for a route that never matched. The glob `**/pending*` does not match `/pending/0`. Corrected the permanent control to `**/pending/**`, awaited route registration and the first matching owned route. This is a test-fixture bug, not evidence of a Chromium concurrency limit or product failure. **1 test, 0 pass/fail, 1 canceled, 0 skipped**, 30-second timeout, exit 1, tripwire never fired.
11. `task-5-ui-observer-types-final-2.log`: final executable source typecheck, exit 0.

Permanent controls now exercise real browser event delivery, including: POST request failure and actual generic console text retained by the original device collector; main-frame request sequence 1 across hash navigation and 2 after reload; independent failure-time event sequence; start/failure stage and elapsed-time retention; source-location URL redaction; synthetic query/fragment/header/body canary absence; 80 console errors overflowing a 32-entry event buffer; opaque/credential/relative/malformed URL sanitization; 35 real navigations overflowing a 32-record document buffer; 80 in-flight request starts overflowing a 32-entry pending map; later failure of an evicted old request with unknown start metadata; idempotent disposal, exact listener-count restoration, cleared pending map and no further event capture. The synthetic generic console error is intentionally generated by an owned script to test observation; it is not claimed to reproduce the engine's actual CI failure.

## Verification commands and environment

All browser runs use the same cached image/Node26 bind/user/HOME/CI settings, `--pull=never`, and armed tripwire described in the initial investigation. No NOVA_UI_SHOTS or baseline-update environment variable. No source authority/policy/backend changes, owner data, real Kubernetes tools/cloud/model pulls, protected previews or other-worktree changes.

Observer-only runs use the common Docker prefix already recorded above, with:

```sh
sh scripts/tripwire.sh node --test --test-concurrency=1 --test-force-exit --test-timeout=900000 tests/ui/topology-diagnostics.test.ts
```

The isolated stress control uses flags before the diagnostic path:

```sh
sh scripts/tripwire.sh node --test --test-concurrency=1 --test-force-exit --test-timeout=900000 --test-name-pattern="bounded output" .superpowers/sdd/M10j/task-5-ui-observer-stress-diagnostic.test.ts
```

Both covering attempts use the same exact command against the affected suite and new diagnostic controls:

```sh
sh scripts/tripwire.sh node --test --test-concurrency=1 --test-force-exit --test-timeout=900000 tests/ui/topology-diagnostics.test.ts tests/ui/m10i-topology.test.ts
```

Host typecheck commands use:

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH npm run typecheck
```

No full 1735-unit or 157-UI rerun, unrelated unchanged navigation suite, screenshot update, dependency change, waiver or behavior repair was performed.

## Final verification, commit and release for diagnostics

12. `task-5-ui-observer-covering-final.log`: complete affected suite plus diagnostic controls, **27/27 pass, 0 fail/canceled/skipped/todo**, 55677.679677 ms, exit 0, tripwire armed/never fired. This established the first complete GREEN, before the final security canary below.
13. `task-5-ui-observer-prefix-red.log`: added actual-browser `url=/prefixed?token=PREFIX_CANARY#PREFIX_FRAGMENT` control. Selected bounded test only, **1 test, 0 pass, 1 fail, 0 canceled/skipped**, 636.016047 ms, exit 1, tripwire never fired. It proved a non-whitespace relative URL prefix could bypass the prior recognizer. The observer now sanitizes pathname tokens regardless of prefix, and removes remaining query/fragment suffix tokens. This affects diagnostic copies only; raw device errors and strict original assertions remain unchanged.
14. `task-5-ui-observer-covering-final-2.log`: final committed executable source covering command, **27 tests, 27 pass, 0 fail, 0 canceled, 0 skipped, 0 todo**, 56167.801927 ms, exit 0, tripwire armed/never fired. Includes **all 24 original affected topology tests and all 3 actual-browser diagnostic controls**, with actual Chromium and WebKit. No browser/test warnings printed.
15. `task-5-ui-observer-types-final-3.log`: final committed executable source `npm run typecheck`, exit 0; npm command notices only. `git diff --check` and staged diff check pass with empty output.

The prefixed-URL RED used the same recorded Docker prefix with:

```sh
sh scripts/tripwire.sh node --test --test-concurrency=1 --test-force-exit --test-timeout=900000 --test-name-pattern="bounded output" tests/ui/topology-diagnostics.test.ts
```

Final covering snapshots show the diagnostic output works in the actual original case without an assertion failure: Chromium phone/desktop each record six navigation request events, 13 canceled requests, no console errors; WebKit phone/desktop each record six navigation request events, 30 canceled requests, no console errors. Each snapshot is 6251/6285/12583/12708 bytes respectively. No failed-request start metadata was missing in these final snapshots; WebKit reports 4/5 pending-map evictions during bootstrap, explicitly visible in counts. No event or document record eviction in these actual affected-case snapshots. The permanent stress controls separately verify overflow and unknown metadata. The engine's original nine internal-error messages were **not reproduced**, and no causal fix claim follows from these local GREENs.

Source-only commit: **`89cd51a7de7b54da3992c6b320b617ec4c717435` — `test(ui): capture bounded topology gate diagnostics`**. Commit contains only the three assigned test/helper paths. No report/controller/plan/screenshot/production files staged. Tracked tree is clean after commit, diff check passes, and no cached-Playwright-image containers remain. Every execution session has returned a final exit status; no process, hold, write or listener remains under this agent's ownership. The intentionally interrupted earlier container and canceled controls are preserved above and are not passing evidence.

**RELEASE** sourcewriter ownership. Diagnostic-only implementation is complete and reviewable; root owns fresh independent scoped review and the next exact-head ordinary CI evidence-acquisition run. Original CI cause **UNPROVEN**; no original repair performed; full M10j phase **NOT PASSED**; draft 283, parked #275 B and absent actual P1a/P1b/P1c unchanged. No push, PR, merge, history rewrite, deploy, M10k, dependency/waiver/policy/real-tool/owner-data/protected-preview/other-worktree action.
