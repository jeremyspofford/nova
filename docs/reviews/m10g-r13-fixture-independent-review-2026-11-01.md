# Scoped R13 independent review

**Requirements compliance: Pass. Code quality: Approved.**

Verified HEAD: `b4088fcc5f75e167b3bcb25c544d5f24eb14f49e`.
Reviewed range: `fd76346c..b4088fcc`. The commit changes only `tests/acceptance/m10g-review2.test.ts` (seven additions, one deletion).

## Strengths and verified behavior

- **The failure trigger is retained.** `tests/acceptance/m10g-review2.test.ts:139` invokes the real new-hub `settleName()` before forwarding honest health requests. Reconciliation is not mocked out or stopped. The forced-schedule RED log reproduces the missing unhealthy answer; the fixed test keeps that same adverse ordering.
- **The injected fault now has an observable lifetime.** At `tests/acceptance/m10g-review2.test.ts:155`, the existing name stand-in rejects effective control-driven moves until an unhealthy response has actually been captured. It then points back to B and releases the stuck flag before replay assertions. `scripts/stand-ins/stable-name.js:58` confirms that stuck affects control-driven movement; its direct test `point()` still changes the target at line 70. This prevents independent reconciliation from erasing the test's input before the health probe observes it.
- **Signing and request binding remain real.** The proxy forwards the original request body to B and stores B's actual response at `tests/acceptance/m10g-review2.test.ts:140`. The production endpoint computes health and signs the answer with the request binding at `src/core/mesh/handover.ts:921` and `:939`. The test still verifies that captured answer against B's key and the original request, and rejects a different nonce at `tests/acceptance/m10g-review2.test.ts:173`.
- **Replay and restart checks are preserved.** The replay branch at `tests/acceptance/m10g-review2.test.ts:135` returns the captured response unchanged before the new scheduling hook. The existing five-response replay path, absence of accepted unhealthy probes, unchanged hub/standby roles and no stand-down assertions remain at lines 163–174. The separate real-core restart still rejects the already-used signed request with 403 and “already used” at lines 180–188.
- **The new synchronization is bounded.** Capture uses the existing 20-second polling budget at `tests/acceptance/m10g-review2.test.ts:157`; a missing capture still fails the explicit assertion at line 160. The test retains its 90-second deadline at line 129. The forced reconciliation uses existing bounded hello probes and a finite three-attempt readback (`src/core/mesh/handover.ts:1062`, `:1087`), rather than an added unbounded polling loop. Normal timeout return restores/releases the stand-in before asserting; exceptional paths retain the existing finally cleanup at test line 175 and `tests/acceptance/m10g-support.ts:100`.

## Findings

No Critical, Important or Minor finding introduced by this fix. The change controls the lifetime of the injected name fault rather than weakening the security checks or changing production behavior. It removes the identified scheduling race; it does not establish that every unrelated timing condition in the acceptance suite is impossible.

## Evidence and commands

Read-only commands executed for this review:

```sh
git diff fd76346c..b4088fcc -- tests/acceptance/m10g-review2.test.ts
git diff --stat fd76346c..b4088fcc
git rev-parse HEAD
```

Also used focused `nl`/`sed`/`rg` reads of the R13 test, its `until`/pair/cleanup helpers, the stable-name stand-in, and the production health/settleName methods. These outside-diff reads addressed three concrete risks: fault injection interfering with real signing, the forced scheduling hook changing replay semantics, and unbounded waiting or leaked test infrastructure.

Observed existing logs, without rerunning tests:

- `../r13-forced-red.log`: 0/1 pass; fails because no unhealthy answer was captured with forced reconciliation.
- `../r13-fixed-green.log`: focused R13 passes 1/1; no skips; tripwire never fired.
- `../r13-file-green.log`: full review2 file passes 7/7; no skips; tripwire never fired.
- `../full-host-r13-fix.log`: inspected the available output; no completed full-suite result was present at review time. This report does not claim the broad suite or remote CI is green.

No tests were launched, no source/index/branch changes were made, and no server was stopped by this review. Only this report was written.

## Declined to judge

- Renderer/design and owner approval: unchanged by this test-only commit and explicitly outside this review.
- Broad hardening of pre-existing acceptance helpers and unrelated test cases: no changes to those contracts in the reviewed diff; checked only their effect on this fix.
- Whole-branch merge readiness and exact-head remote CI: require the coordinator's completed validation; this review clears only the R13 fix.

**Assessment:** Approved for the scoped test correction at the pinned SHA. No fixes requested.
