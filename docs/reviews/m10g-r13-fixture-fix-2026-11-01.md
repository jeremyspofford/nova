# R13: keep the injected stable-name fault until observed

This is a test-fixture correction at `b4088fcc5f75e167b3bcb25c544d5f24eb14f49e`. No production, app or renderer code changed. M10i's owner rendered-entry approval remains pending.

## Failure and cause

Exact-head CI run `41332137058` on `fd76346c` failed `tests/acceptance/m10g-review2.test.ts:154` twice: the initial attempt and the takeover brief's single permitted failed-job rerun. Each recorded 1,581 passes, one failure and 14 explicit skips. Its browser job passed 121/121 with zero skips; axe recorded zero violating nodes. No further blind rerun was used.

R13 briefly pointed the stable-name stand-in at the old hub and waited for a real signed unhealthy answer from the new hub. The new hub independently reconciles that name every few probes. If reconciliation wins the race, health is honestly healthy and there is no unhealthy answer to capture. A passing isolated run does not resolve that race.

The regression forces the real `settleName()` before proxy forwarding of honest health requests. With the original fault lifetime, that schedule reproduces the exact missing-unhealthy assertion. The minimal fixture fix uses the existing `stuck(true)` control on the loopback name stand-in until the signed unhealthy response has been captured, then restores the target and releases it. Reconciliation remains active. The real health endpoint, signatures, request binding, five-response replay, role/held-write assertions and rejection of a used request across restart are unchanged.

## Observed verification

With Node 26.3.1 selected:

```sh
scripts/test.sh --test-name-pattern='R13' tests/acceptance/m10g-review2.test.ts
scripts/test.sh tests/acceptance/m10g-review2.test.ts
npm run typecheck
```

- Original focused case passed once in 3.98 seconds, demonstrating why isolation alone hid the race.
- Forced reconciliation before the fix: RED, zero passes, exact missing-unhealthy assertion after 21.6 seconds.
- Same forced schedule with the held fault: GREEN, 1/1, zero skips, 4.96 seconds.
- Complete review2 file: GREEN, 7/7, zero skips, 35.4 seconds, while the full host suite was also running.
- Typecheck and diff whitespace checks passed. The no-Kubernetes tripwire never fired in these runs.

[Independent scoped review](m10g-r13-fixture-independent-review-2026-11-01.md) approves the exact fix pin with no findings. It inspected signing, replay, restart and bounded cleanup paths; it did not rerun tests or claim the full suite was green. A new full `npm test` run and fresh exact-head CI remain separate validation; no full-suite or merge-readiness claim is made here.

The corrected renderer remains independently reviewed at `690c8458`. These test and documentation changes do not approve or implement M10i's application map.
