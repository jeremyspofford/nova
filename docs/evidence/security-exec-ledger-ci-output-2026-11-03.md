# Security CI correction: retained test output

These controlled synthetic-fixture outputs include expected RED failures, cleanup-only failures, passes that did not identify the remote cause, and the failed TCP oracle. No green package was regenerated for this archive. Original raw streams are identified by bytes/SHA-256; identical bodies list every name. Text display removes trailing whitespace only. If that changes bytes, gzip+base64 below preserves the exact original losslessly (`gzip.decompress(base64.b64decode(payload))`). The unrelated broad process snapshot is deliberately excluded. Complete commands and interpretation are in [the reports](security-exec-ledger-ci-correction-2026-11-03.md).

## `ci-fix-logs/01-original-red.log`

4488 original bytes; SHA-256 `2012d84f5c6fe4c54cc4f3c698083f58b197e531763af49d0e194353566fdc18`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
TAP version 13
# Subtest: the pipeline runs only its own tasks: a brief for a change from any other task is refused, and the approval on record is the ledger’s own
not ok 1 - the pipeline runs only its own tasks: a brief for a change from any other task is refused, and the approval on record is the ledger’s own
  ---
  duration_ms: 2945.760004
  type: 'test'
  location: '/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/changes-guards.test.ts:92:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    'canary' !== 'live'

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 'live'
  actual: 'canary'
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/changes-guards.test.ts:120:12)
    async Test.run (node:internal/test_runner/test:1389:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3)
  ...
# Subtest: rolling back an extension puts its state back exactly: installed, not enabled
not ok 2 - rolling back an extension puts its state back exactly: installed, not enabled
  ---
  duration_ms: 795.739963
  type: 'test'
  location: '/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/changes-guards.test.ts:229:1'
  failureType: 'testCodeFailure'
  error: |-
    In its canary until 2030-01-15T08:30:00.000Z.
    + actual - expected

    + 'canary'
    - 'rolled_back'

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 'rolled_back'
  actual: 'canary'
  operator: 'strictEqual'
  stack: |-
    rolledBackExtension (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/changes-guards.test.ts:225:10)
    async TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/changes-guards.test.ts:230:20)
    async Test.run (node:internal/test_runner/test:1389:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:960:7)
  ...
# Subtest: rolling back an extension leaves a binary file it never touched byte for byte
not ok 3 - rolling back an extension leaves a binary file it never touched byte for byte
  ---
  duration_ms: 1102.23711
  type: 'test'
  location: '/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/changes-guards.test.ts:239:1'
  failureType: 'testCodeFailure'
  error: |-
    In its canary until 2030-01-15T08:30:00.000Z.
    + actual - expected

    + 'canary'
    - 'rolled_back'

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 'rolled_back'
  actual: 'canary'
  operator: 'strictEqual'
  stack: |-
    rolledBackExtension (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/changes-guards.test.ts:225:10)
    async TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/changes-guards.test.ts:240:34)
    async Test.run (node:internal/test_runner/test:1389:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:960:7)
  ...
# Subtest: rolling back an extension puts back a large file it overwrote
not ok 4 - rolling back an extension puts back a large file it overwrote
  ---
  duration_ms: 807.137655
  type: 'test'
  location: '/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/changes-guards.test.ts:249:1'
  failureType: 'testCodeFailure'
  error: |-
    In its canary until 2030-01-15T08:30:00.000Z.
    + actual - expected

    + 'canary'
    - 'rolled_back'

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 'rolled_back'
  actual: 'canary'
  operator: 'strictEqual'
  stack: |-
    rolledBackExtension (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/changes-guards.test.ts:225:10)
    async TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/changes-guards.test.ts:250:30)
    async Test.run (node:internal/test_runner/test:1389:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:960:7)
  ...
# Interrupted while running: tests/core/changes-guards.test.ts at /home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/changes-guards.test.ts:1:1
no-Kubernetes tripwire: never fired
````

Exact original bytes (gzip+base64):

```text
H4sIAAAAAAAC/+1YzW4bNxC++ymmyEEO4v2XLIttCsiBkhoBEsNWLr0Y1O6stRWX3JJcSwv00Nfo6+VJMuTKPwiMuIidOAF8sEANhzMfh/N9pCxV8LZdoJZo0YDVVbOuNDLgusYCdlc0l1uxB0sU9R6Uot0AlwWsMgNKwvF0/gdozJUuvLnklQC8QN1BzoX4Fd5+OJy9ev/u9dEbaKVB+3xnPj0GcjAVLU+ynWdw2i4otWVglwhN1aCoJIImd8ogOqgsDdYSLDcrQ8BgoSssoVSaxvmSy3OEUquaAHSgKIj2rlAZQla2Bos9j82F502j1QUXDvsWNrm5GYHFOeqP//7nk+1IZUGtIIHgh4IFEAQBfRat5pYqeFZT6nQyHIXj/TiOhzRlu4aOb+BKOqCvQuXek0zRUtUY/YUa6y4Kc1XgJlorvbIa0USSAAQ1r2SQV0FZbWyrL62LthJF5CKaiMBh1G/PBOct14UJ3UxoDZukLHE5XRfQ6vk1kleU7HVvdQ6otdIM/nFbAZhtGuox6jaqQOuaUMECwVAvUud1gH+3XDDv6T8GOZdcdwP45eVLGIjqwof0k25PlHF2cnI2PT2dncyP3r9zk5LXzj41BrUrxszl90C2qdl1IJ5bl+8qDZlUg1Ruh3jQo5o5SG7GWJ6vrjYy9zuVFjc2/I1LJbtateZ32C0rgSyKvvkBJGlMf889GG46mXtIITUt7EpXm4rAacmFj3VGdonaj1mSHUzY+OZS2pu2W3JOS1p3qJSl/fPmS8GWnKTEGJYdjFnmwoVheJPkWgki0jksqHDU/3QCFqUXg6YlRjlWUWKLvQNuuOsBBpUkqxCONI6aKPmCvlzSNCWaPmzgW4k2nhDPsslkP3tcnqXp5KuIdiR9GfrGJj22JNZpnMVBnATJaB4fsCxmcRySkvwZ+hUvtnSg+l5S5ZqIL25yhAoGA3cGWJy5Cj8IJz+Ldw9q9pEOyTS76ovvRss0HbEk/pyWj6oUKZ10Gj+QUvildIPlRPxjlAXRcMt3c2e0yX7cB/vfOiGQX9AtQRdu5fvYlYz6GqR7d9Dl0eZLuksWHVHdXcZucKkT2Rd14msC36oTSRKnYZqNk+SRdSJ70oknnbgfpGHMsuFPqRP+2u/NILh2z/EtoRXxea3VtS4M734/3BHoVh04iMdhko33R6NH1oHhkw486cD9II1IB37A98KRc9Rt434+rpeOls6ZAjK4c1PALXz7n2QsIZW5/X8s/cOipHGx8wkZKwu7iBEAAA==
```

## `ci-fix-logs/03-cleanup-only-red.log`

4430 original bytes; SHA-256 `d6316853ca7b586bfdb16bfa7a18e2b5c980f47cdd5912c922f882c7bbbcc3bc`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
TAP version 13
# Subtest: the pipeline runs only its own tasks: a brief for a change from any other task is refused, and the approval on record is the ledger’s own
not ok 1 - the pipeline runs only its own tasks: a brief for a change from any other task is refused, and the approval on record is the ledger’s own
  ---
  duration_ms: 2942.665162
  type: 'test'
  location: '/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/changes-guards.test.ts:92:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    'canary' !== 'live'

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 'live'
  actual: 'canary'
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/changes-guards.test.ts:120:12)
    async Test.run (node:internal/test_runner/test:1389:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3)
  ...
# Subtest: rolling back an extension puts its state back exactly: installed, not enabled
not ok 2 - rolling back an extension puts its state back exactly: installed, not enabled
  ---
  duration_ms: 2811.552297
  type: 'test'
  location: '/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/changes-guards.test.ts:231:1'
  failureType: 'testCodeFailure'
  error: |-
    In its canary until 2030-01-15T08:30:00.000Z.
    + actual - expected

    + 'canary'
    - 'rolled_back'

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 'rolled_back'
  actual: 'canary'
  operator: 'strictEqual'
  stack: |-
    rolledBackExtension (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/changes-guards.test.ts:227:10)
    async TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/changes-guards.test.ts:232:20)
    async Test.run (node:internal/test_runner/test:1389:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:960:7)
  ...
# Subtest: rolling back an extension leaves a binary file it never touched byte for byte
not ok 3 - rolling back an extension leaves a binary file it never touched byte for byte
  ---
  duration_ms: 2813.311009
  type: 'test'
  location: '/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/changes-guards.test.ts:237:1'
  failureType: 'testCodeFailure'
  error: |-
    In its canary until 2030-01-15T08:30:00.000Z.
    + actual - expected

    + 'canary'
    - 'rolled_back'

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 'rolled_back'
  actual: 'canary'
  operator: 'strictEqual'
  stack: |-
    rolledBackExtension (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/changes-guards.test.ts:227:10)
    async TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/changes-guards.test.ts:238:28)
    async Test.run (node:internal/test_runner/test:1389:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:960:7)
  ...
# Subtest: rolling back an extension puts back a large file it overwrote
not ok 4 - rolling back an extension puts back a large file it overwrote
  ---
  duration_ms: 2818.588777
  type: 'test'
  location: '/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/changes-guards.test.ts:243:1'
  failureType: 'testCodeFailure'
  error: |-
    In its canary until 2030-01-15T08:30:00.000Z.
    + actual - expected

    + 'canary'
    - 'rolled_back'

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 'rolled_back'
  actual: 'canary'
  operator: 'strictEqual'
  stack: |-
    rolledBackExtension (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/changes-guards.test.ts:227:10)
    async TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/changes-guards.test.ts:244:24)
    async Test.run (node:internal/test_runner/test:1389:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:960:7)
  ...
1..4
# tests 4
# suites 0
# pass 0
# fail 4
# cancelled 0
# skipped 0
# todo 0
# duration_ms 11691.586183
no-Kubernetes tripwire: never fired
````

Exact original bytes (gzip+base64):

```text
H4sIAAAAAAAC/+1YzW7cNhC++ymmyGEdxPrfH63aFFgHm9YIkBj29tKLwZVGXna5pEpS9grIIa/R1+uTZEitfxAkcRG7dQr4IGE0Q84Mh/N9JCRV8KZdopZo0YDVvLnkGgtgeoMV7K/JVlpxACsUmwOoRbsFJitYZwaUhOPZ4lfQWCpdeXXNuAC8QN1ByYT4Ed78djh/9e7t66NfoJUG7fO9xewYaIDhND3J9p7Babuk0LYAu0JoeIOCSwRNwymC6IBbEi4lWGbWhhKDpeZYQ600yeWKyXOEWqsNJdCBIifaDwVuKLO6NVgd+Nyce9Y0Wl0w4XLfpU3DnEVgdY767w9/+WB7UllQa0gg+K7SAgiCgN5Vq5mlCp5tKHQ6HabheDxKximZbNfQ9g1cSQf0KVTpR5IqWqkNRn+gxk0XhaWqcBtdKr22GtFEkhIINozLoORBzbe21VfaZctFFTmPJqLkMOqXZ4LzlunKhM4SWlNM0yJxMV0X0OzFTSavKNjrXusGoNZKF/DeLQVgvm2ox6jbqAKta0IFSwRDvUid1wH+2TJR+JH+NSiZZLobwA8vX8JA8Avv0hvdmiji/OTkbHZ6Oj9ZHL1764ySbZx+ZgxqV4y5i+8T2YUubhyx0rp412FIpRqkcruMB31Wc5eSsxjLyvX1QhZ+pdLi1oY/Malkt1Gt+Rn2ay6wiKJ/fQOSNKbnuU+GmU6WPqWQmhb2pasNp+S0ZML7OiO9RO3lIsnyaTG5PZXWpu0OnLOa5h0qZWn9rPmasxUjKjGmyPJJkTl3YRjeBrlWgoB0DksqHPU/7YBF6cmgaQlRDlUU2GI/ALfM9UABXJJWCAcaB02UbEkfVzBNCaYP6/jzQMuTJByN0nQ6eVygpVnyTUg7kr4OfWcTIVti6zTO4iBOgmS0iPMii4s4DuM4/j30M17s8EAFvsLKDRJf3AYJVQwGbhOwOnMlfhBQfuLvHtjsPR2San7dGP8ZLtN0UiTxp7h8VKpIs7RI4weiCj+VjrCSkH+MsiIc7gBv7vQ2Hce9s39MFALZBR0TdOJy38euZNTXIN3Fg06PtlzRYbLsCOvuNHbCFVFkXyWKb3H8JaLIwixJ4nj62EQxeSKKJ6K4XwvlRZr/L4nCH/y9GgTT7kK+Q7QiQF9qdUMMw7tvEHc4+hIR5OEozyeTx74xDLMnIngigvu10JCe740IkjAcEhv0M51kWu7+ZMQkNsz0gv8t4YzUBSW6bfVqs+ZNs5OtqpQXbuEXkmQ8pRt/Pk7yjJji839K+ttBTXK19xHNq0ncThEAAA==
```

## `ci-fix-logs/06-original-green.log`

1271 original bytes; SHA-256 `b415d2124e5d0e9cd1f34505098c0f3d6bf4b77f6114035509a755e3d02a8c95`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
TAP version 13
# Subtest: the pipeline runs only its own tasks: a brief for a change from any other task is refused, and the approval on record is the ledger’s own
ok 1 - the pipeline runs only its own tasks: a brief for a change from any other task is refused, and the approval on record is the ledger’s own
  ---
  duration_ms: 1049.098422
  type: 'test'
  ...
# Subtest: rolling back an extension puts its state back exactly: installed, not enabled
ok 2 - rolling back an extension puts its state back exactly: installed, not enabled
  ---
  duration_ms: 1030.288597
  type: 'test'
  ...
# Subtest: rolling back an extension leaves a binary file it never touched byte for byte
ok 3 - rolling back an extension leaves a binary file it never touched byte for byte
  ---
  duration_ms: 842.917793
  type: 'test'
  ...
# Subtest: rolling back an extension puts back a large file it overwrote
ok 4 - rolling back an extension puts back a large file it overwrote
  ---
  duration_ms: 816.951043
  type: 'test'
  ...
1..4
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 4058.498119
no-Kubernetes tripwire: never fired
````

## `ci-fix-logs/07-complete-affected.log`

3744 original bytes; SHA-256 `e031d1dc44648ccc3d1a30fce84b846618919f112aed1a6e059b64fcb6aa4a66`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ M7a: the foundry ships a wind-down reminder through every gate, with the tier-3 OK; the record reaches the standby; skipping and weakening are refused (2701.78096ms)
✔ M7a: sabotage that passes the sandbox fails live and is rolled back by itself: the previous version, Failed with the probe’s reason, a problem, nothing else changed (2652.410838ms)
✔ a forged ship or rollback task is refused at every way in, and a waiting tier-3 change stays waiting (1375.052663ms)
✔ the pipeline runs only its own tasks: a brief for a change from any other task is refused, and the approval on record is the ledger’s own (1067.969419ms)
✔ a rule pack whose task would run elsewhere is stopped before its tests, and the person’s real backup folder is untouched (the reviewer’s leak) (565.06461ms)
✔ a sandbox copy is inert: backup, capture, provider and model settings are blanked (74.106691ms)
✔ in a sandbox copy a firing rule records its task without starting it (61.359257ms)
✔ rolling back an extension puts its state back exactly: installed, not enabled (907.324415ms)
✔ rolling back an extension leaves a binary file it never touched byte for byte (1178.126675ms)
✔ rolling back an extension puts back a large file it overwrote (846.825543ms)
✔ rolling back a brand-new extension leaves nothing behind, whatever it keeps or exports on removal (852.356585ms)
✔ rolling back by hand during a canary happens now, and ends the canary (895.185145ms)
✔ a rule pack’s approval shows each task’s worker, inputs, tier and privacy (0.431276ms)
✔ ship and roll back are for an approver, not any paired phone or browser (63.535863ms)
✔ a design system’s canary device must be the hub or one of the person’s paired devices (2834.497775ms)
✔ a canary’s window is measured on a clock that can’t jump: the wall clock leaping ahead doesn’t promote it (952.020378ms)
✔ a promotion that fails rolls the change back instead of leaving it in its canary (913.575482ms)
✔ a change whose canary began but whose apply never finished is applied when its task runs again (3048.835392ms)
✔ a change whose artifact no longer matches its release isn’t applied (975.071028ms)
✔ rolling back a design system puts back only what it changed, not another device’s choice (920.248854ms)
✔ a good change, end to end: sandbox, tests, health, a release in the home’s history, a canary, promoted, and every stage in the ledger (1191.546014ms)
✔ sabotage caught by the tests stops in the sandbox and is never offered: a broken test, an invalid manifest (987.927131ms)
✔ sabotage that passes the sandbox but fails live: rolled back by itself, the previous version restored, Failed with the probe’s reason, a problem opened, nothing else changed (1965.505337ms)
✔ the gates can’t be weakened or skipped: a change that tries is refused and kept on the record (3112.883442ms)
✔ tier 3 every time for what a provider or the foundry proposes, and for privacy settings; the OK needs confirming and comes after the sandbox evidence (911.335728ms)
✔ rolling back by hand: tier 2, the previous version comes back and is live again (1688.603993ms)
✔ every kind goes through: a design system on one device then everyone, a setting, a decision template (2591.265826ms)
✔ the foundry: the stand-in local model writes a wind-down reminder pack in its own folder; proposed at tier 3, it ships after the OK and fires on the test clock (1122.425098ms)
ℹ tests 28
ℹ suites 0
ℹ pass 28
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 18031.638124
no-Kubernetes tripwire: never fired
````

## `ci-fix-logs/08-typecheck.log`, `ci-fix-logs/20-final-typecheck.log`, `ci-fix-r1-logs/07-typecheck.log`

72 original bytes; SHA-256 `e8180baa00ad9e924316d504d52e1481d7865b7c7920b00f90f09701440c5da0`.

````text
npm notice run nova@0.1.0 typecheck
npm notice run tsc -p tsconfig.json
````

## `ci-fix-logs/09-boundary.log`

406 original bytes; SHA-256 `00481b78b52db77162432b6e77e3ee9dea305d0b991222dc7e2ca231996dc4cf`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ module boundary: outside src/core, only src/core/index.ts is imported (src/device: only mesh/wire.ts and models/hardware.ts) (3.675855ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 483.338187
no-Kubernetes tripwire: never fired
````

## `ci-fix-logs/10-diff-check.log`, `ci-fix-logs/23-final-diff-check.log`, `ci-fix-r1-logs/10-diff-check.log`

0 original bytes; SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

````text
````

## `ci-fix-logs/15-ui-original.log`

558 original bytes; SHA-256 `8fe150b6962b7e0e5225f29591eba830f4fcf9d975523df752c2d613d6357f8e`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
TAP version 13
# Subtest: declared names still resolve under the resolver rules; the profile names its process and is removed on close
ok 1 - declared names still resolve under the resolver rules; the profile names its process and is removed on close
  ---
  duration_ms: 1894.039099
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2432.15502
no-Kubernetes tripwire: never fired
````

## `ci-fix-logs/16-ui-original-repeat-1.log`

559 original bytes; SHA-256 `ce8609c762ed1ab776506132d128ff1f7bdeed11a10add22be857a3cf7e6a533`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
TAP version 13
# Subtest: declared names still resolve under the resolver rules; the profile names its process and is removed on close
ok 1 - declared names still resolve under the resolver rules; the profile names its process and is removed on close
  ---
  duration_ms: 1604.967846
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2043.979916
no-Kubernetes tripwire: never fired
````

## `ci-fix-logs/16-ui-original-repeat-2.log`

559 original bytes; SHA-256 `0db5d397239393e518b5a336ecd9f220626386e28061b682743b583c7141882f`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
TAP version 13
# Subtest: declared names still resolve under the resolver rules; the profile names its process and is removed on close
ok 1 - declared names still resolve under the resolver rules; the profile names its process and is removed on close
  ---
  duration_ms: 1727.252454
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2155.534467
no-Kubernetes tripwire: never fired
````

## `ci-fix-logs/16-ui-original-repeat-3.log`

558 original bytes; SHA-256 `6a09b8a9d18a5a3ce0df7f7530d56cc76ebd5de7b2ee0be62af6b2951daf8e55`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
TAP version 13
# Subtest: declared names still resolve under the resolver rules; the profile names its process and is removed on close
ok 1 - declared names still resolve under the resolver rules; the profile names its process and is removed on close
  ---
  duration_ms: 1629.037308
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2066.62766
no-Kubernetes tripwire: never fired
````

## `ci-fix-logs/16-ui-original-repeat-4.log`

559 original bytes; SHA-256 `2fe6bf95144c7b4fc61694fee652277453d24864f50a5c58549ba8f75b49dbb9`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
TAP version 13
# Subtest: declared names still resolve under the resolver rules; the profile names its process and is removed on close
ok 1 - declared names still resolve under the resolver rules; the profile names its process and is removed on close
  ---
  duration_ms: 1640.960738
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2061.521273
no-Kubernetes tripwire: never fired
````

## `ci-fix-logs/16-ui-original-repeat-5.log`

559 original bytes; SHA-256 `26445099f02638fd960e1ad7b3e7beb03cf077858a3501b6c2043ec2ee480e77`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
TAP version 13
# Subtest: declared names still resolve under the resolver rules; the profile names its process and is removed on close
ok 1 - declared names still resolve under the resolver rules; the profile names its process and is removed on close
  ---
  duration_ms: 1635.173172
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2088.934949
no-Kubernetes tripwire: never fired
````

## `ci-fix-logs/17-close-contract-red.log`

1982 original bytes; SHA-256 `f031727e255134a71639dc1c48b43e59081ac936228e3d9a086bb9e71b02e183`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
TAP version 13
# Subtest: session close waits for profile cleanup after caller starts closing
not ok 1 - session close waits for profile cleanup after caller starts closing
  ---
  duration_ms: 36.582808
  type: 'test'
  location: '/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/browser-act.test.ts:148:3'
  failureType: 'testCodeFailure'
  error: |-
    reentrant and repeated close must await physical cleanup

    true !== false

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: false
  actual: true
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/browser-act.test.ts:179:14)
    async Test.run (node:internal/test_runner/test:1389:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3)
  ...
# Subtest: session close waits for profile cleanup after transport starts closing
not ok 2 - session close waits for profile cleanup after transport starts closing
  ---
  duration_ms: 28.366916
  type: 'test'
  location: '/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/browser-act.test.ts:148:3'
  failureType: 'testCodeFailure'
  error: |-
    reentrant and repeated close must await physical cleanup

    true !== false

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: false
  actual: true
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/browser-act.test.ts:179:14)
    async Test.run (node:internal/test_runner/test:1389:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:960:7)
  ...
1..2
# tests 2
# suites 0
# pass 0
# fail 2
# cancelled 0
# skipped 0
# todo 0
# duration_ms 412.442617
no-Kubernetes tripwire: never fired
````

Exact original bytes (gzip+base64):

```text
H4sIAAAAAAAC/+1VTU/bQBC951dM1QMgYRvHaeK4pVJAoUVIgCA9o409braxd92dXZJI/fGd3QDlAK1a0RuXZPx2583n0yodnbk5GoUWCayR3UoaLECYFivYXfJZaZt9WGDT7kPduDUIVcEyI9AKLiezz2Cw1KYKcC1kA3iLZgOlaJr3cPblaHp8cX5y+gmcIrR7vdnkEvgCSXZPs95buHZzDm0LIKSAlo0mhJWQlqDWBjqja9kg4yiU60DUFk3g5z+ywvA97yPV157SFvQSUohehA4giiL+rZwRlsluWiogG8bv8n5+kPOB3XTcrB1fwA5/NroM9xhKFrrF5BsabDdJXOoK18lKm6U1iJQofSuiVkgVlTKq5do6c4/OnWyqxDNSwo3FZG70itBEorSxh2NLRTrIi8xH9B1n39mvPI451MkW9RfQGG0K+OHLAJ4VKmuEsmFcBjsUlue87VHriHHfKegWG5Lck/suBefwY41DeHN4yJEbwnvc18fxp1dXN5Pr6+nV7PTi3EdXovX4hLgA35ipzyakte54sbAqHni4PCeaIgTgT90h99ynvkO8lqWdfudj78ozKpcPFc1Cycri2sYfhNJq02pHH2HXD7lIkv88h9GYZ7EXMhG0UWXIJzZOwa7yPZGcmVGiCUQ3jCs0wS7SLB8Xo8euYfnu5DDxW3mkteXiRfc7soVg8RIVWT4qMk8Xx/G/y8ovB3Xa2GeU1f9rZT3L+KS4+nmcDYfjdPgqrldxvaS4gitvaMnLe4mq4g28kwj9kW08PNiSeWmlcdxnfW09vUVO+rfzgM1O0NYID6E/LIUqkZ+WKsC0lF13Z1td6WA82n8YpP14MOgP0xEL7umXWfn3FWq2q95P/LI/wb4HAAA=
```

## `ci-fix-logs/18-close-contract-green.log`

686 original bytes; SHA-256 `ad0dd93e86793ecb4d80f432d6d74cf3826a17196e07ca7bebc85c38f68de684`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
TAP version 13
# Subtest: session close waits for profile cleanup after caller starts closing
ok 1 - session close waits for profile cleanup after caller starts closing
  ---
  duration_ms: 32.814208
  type: 'test'
  ...
# Subtest: session close waits for profile cleanup after transport starts closing
ok 2 - session close waits for profile cleanup after transport starts closing
  ---
  duration_ms: 26.821699
  type: 'test'
  ...
1..2
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 370.429938
no-Kubernetes tripwire: never fired
````

## `ci-fix-logs/19-browser-complete.log`

5794 original bytes; SHA-256 `dff423da08a63dbe463bda77ecec7493e194343cede51fc29fb2ca8789a0e663`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ a takeover that starts while the worker gets ready to click: the click waits for the hand-back (676.470804ms)
✔ a device that is revoked, or may no longer approve, loses the browser at once; the step waits for someone else (719.489411ms)
✔ session close waits for profile cleanup after caller starts closing (28.309868ms)
✔ session close waits for profile cleanup after transport starts closing (28.881786ms)
✔ plan: this machine without a port, or at one of Nova’s own ports, can’t be declared or opened (3.753274ms)
✔ plan: what counts as this machine (0.415412ms)
✔ server: a request from a browser task is nobody in particular, on either listener, even from this machine (459.962117ms)
✔ server: a task can’t name Nova’s own listeners, whoever delegates it (the reviewer’s probe) (536.650271ms)
✔ a learnt flow is a decision template: dry runs both ways, activated through the ledger, then its steps run (225.686233ms)
✔ the template’s rule is the ground truth: a wrong path, a missing marker or an obstacle stops the step (0.559317ms)
✔ whatever a template says, a step that presses pay is refused when its flow is run (306.354978ms)
✔ sign-ins: saved by host in the vault, listed without values, deleted only with confirm (84.837115ms)
✔ money: the amounts a page writes, to the cent (15.420004ms)
✔ totals: lines that add up to the total and the quote pass; anything else is a stop with the numbers (19.588635ms)
✔ pay controls: by name, by id or class, by where the form goes, by card fields in the form (2.924083ms)
✔ the plan validator refuses the pay control, a pay address and card fields, whatever the plan or a template says (5.060264ms)
✔ tiers: a checkout plan is tier 3, always; a plan that types or clicks is tier 2; a read is 0 (1.1638ms)
✔ login steps name fields, never values; a11y targets name a role and a name (1.467306ms)
✔ upsells: a box ticked for you that adds money or names an extra; one the plan ticked is not (0.774953ms)
✔ obstacles: a CAPTCHA, a login wall with no sign-in step, a paywall (0.359192ms)
✔ intent: words of the intent against the element’s accessible name (0.649787ms)
✔ the co-pilot template: six Noul questions, valid against the decision-template contract (1.414709ms)
✔ ground truth outranks a probability; a sure model against it stops the step (0.485097ms)
✔ the redactor masks every value a session used, wherever it appears, and nothing shorter than 3 (1.023031ms)
✔ sign-ins live in the vault under the host they were saved for (1.550521ms)
✔ review 3: a declared host is read as the browser reads it, before the this-machine and hub-port checks (1.770098ms)
✔ review 5: a link-local address is never a declared host (0.538064ms)
✔ review 5: a saved sign-in never goes over plain http, except to this machine itself (0.856583ms)
✔ review 2: a step names where it sends; a pay address there is refused; the lists know more ways to pay (3.560574ms)
✔ sweep: profiles whose process is gone are removed; ones in use, other folders and fresh unmarked ones stay (91.884136ms)
✔ sweep: Nova does it when it starts (178.215124ms)
✔ resolver: every name maps to nothing except the declared hosts, without their ports (0.475408ms)
✔ effects: a plan that types, chooses, clicks or hands the page to the person is external; one that only looks is not (74.560316ms)
✔ tiers: filling in and sending a form asks first; looking, or a step only you do, doesn’t (277.836823ms)
✔ provable: a url requirement needs verify.expect; a plan with outside effects needs url evidence on a page it names (1061.02208ms)
✔ the url checker: Nova’s own re-fetch decides when there is one; a page with outside effects can’t prove itself (1.415487ms)
✔ local: only addresses on this network count; a name that sounds local proves nothing (0.217191ms)
✔ CDP: answers find their commands by id, even split across chunks or sharing one (2.122574ms)
✔ CDP: an error answer rejects with the method named; events carry their session (1.027256ms)
✔ CDP: a closed pipe fails what is waiting and refuses what comes next; a silent browser times out (51.552555ms)
✔ Chromium: NOVA_CHROMIUM is used when it is there, and said plainly when it isn’t (6.952556ms)
✔ plan: declared hosts decide what a URL may reach: port, subdomains, schemes (1.947475ms)
✔ plan: where a plan’s data goes, so local-only can refuse it (0.676347ms)
✔ plan: every problem is listed; a navigation outside the declared hosts is refused before it runs (3.228213ms)
✔ input: the person’s pointer and keys are checked before they reach the page (0.506982ms)
✔ evidence: a screenshot counts only if Nova took it for this very task (1.406832ms)
✔ evidence: a link counts only if Nova read that page itself and it shows what the brief expects (2.294769ms)
✔ evidence: Nova fetches the page again itself, following redirects only inside the declared hosts (36.550176ms)
✔ ledger: a running worker that needs the person waits as Needs you, and carries on after (61.12379ms)
✔ ledger: after a restart, a task that waited for the person starts again from the beginning (49.489608ms)
✔ core: with no Chromium, browser work says so plainly; bad plans and remote hosts are refused when delegated (611.933234ms)
✔ core: only the console and devices allowed to approve may take over, drive or hand back (337.728956ms)
✔ form site: the form, the step only a person can do, and the record Nova checks against (31.410061ms)
ℹ tests 53
ℹ suites 0
ℹ pass 53
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2071.787688
no-Kubernetes tripwire: never fired
````

## `ci-fix-logs/21-ui-complete.log`

1907 original bytes; SHA-256 `eb792274b929b35f197bbf6f723a39917434e2ba612539d1d9f146446302178e`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
TAP version 13
# Subtest: wall 1: the browser refuses Nova’s own listeners, even inside the declared hosts
ok 1 - wall 1: the browser refuses Nova’s own listeners, even inside the declared hosts
  ---
  duration_ms: 1997.639732
  type: 'test'
  ...
# Subtest: wall 2: whatever the browser lets through carries the task’s mark; a page can neither drop nor forge it, and cookies still work
ok 2 - wall 2: whatever the browser lets through carries the task’s mark; a page can neither drop nor forge it, and cookies still work
  ---
  duration_ms: 774.485016
  type: 'test'
  ...
# Subtest: wall 2 alone stops the reviewer’s probe: the marked browser gets the pairing page, not the console
ok 3 - wall 2 alone stops the reviewer’s probe: the marked browser gets the pairing page, not the console
  ---
  duration_ms: 1749.893074
  type: 'test'
  ...
# Subtest: the reviewer’s probe, end to end: a phone that may not approve can’t send a browser task to Nova itself
ok 4 - the reviewer’s probe, end to end: a phone that may not approve can’t send a browser task to Nova itself
  ---
  duration_ms: 1328.495653
  type: 'test'
  ...
# Subtest: declared names still resolve under the resolver rules; the profile names its process and is removed on close
ok 5 - declared names still resolve under the resolver rules; the profile names its process and is removed on close
  ---
  duration_ms: 1629.538606
  type: 'test'
  ...
# Subtest: a hostile page on a declared host gets nothing through to anywhere else
ok 6 - a hostile page on a declared host gets nothing through to anywhere else
  ---
  duration_ms: 5395.959239
  type: 'test'
  ...
1..6
# tests 6
# suites 0
# pass 6
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 13561.348559
no-Kubernetes tripwire: never fired
````

## `ci-fix-logs/22-final-boundary.log`

406 original bytes; SHA-256 `17c213316fdf048bc3b57f454e6d23658d30c13a1504cfc01e157ae454d5a0be`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ module boundary: outside src/core, only src/core/index.ts is imported (src/device: only mesh/wire.ts and models/hardware.ts) (3.916259ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 335.594652
no-Kubernetes tripwire: never fired
````

## `ci-fix-r1-logs/01-red.log`

2065 original bytes; SHA-256 `3855f4134bd3cb5db6e8270e8a5bc11e832c30d4bbc8e463ec6d83f1dd73ddd6`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
TAP version 13
# Subtest: close during launch retains cleanup ownership and never restores working mode
not ok 1 - close during launch retains cleanup ownership and never restores working mode
  ---
  duration_ms: 34.735181
  type: 'test'
  location: '/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/browser-act.test.ts:198:1'
  failureType: 'testCodeFailure'
  error: |-
    close retains the resource handoff from pending launch

    true !== false

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: false
  actual: true
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/browser-act.test.ts:230:12)
    async Test.run (node:internal/test_runner/test:1389:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3)
  ...
# Subtest: open failure after acquiring the browser waits for cleanup without a circular close wait
not ok 2 - open failure after acquiring the browser waits for cleanup without a circular close wait
  ---
  duration_ms: 3.341119
  type: 'test'
  location: '/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/browser-act.test.ts:254:1'
  failureType: 'testCodeFailure'
  error: |-
    failed initialization closes the session
    + actual - expected

    + 'starting'
    - 'closed'

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 'closed'
  actual: 'starting'
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/browser-act.test.ts:269:12)
    async Test.run (node:internal/test_runner/test:1389:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:960:7)
  ...
1..2
# tests 2
# suites 0
# pass 0
# fail 2
# cancelled 0
# skipped 0
# todo 0
# duration_ms 377.804314
no-Kubernetes tripwire: never fired
````

Exact original bytes (gzip+base64):

```text
H4sIAAAAAAAC/9VVbU/bMBD+3l9x0z6UCZI0TaFtNiYVVDaEBAi6z8h1nMWrYwe/0Hbaj9/ZaaGT0CZNoGlfnMv57rkX32NLFV24OdOSWWbAat4suWY5EF2zAvYWuEetOICKifoASuFWQGQBi8yAknA9mX0GzajSRVCXhAtgD0yvgRIh3sPFl5Pp6dXl2fkncNIw+64zm1wDGhiO7mnWeQu3bo6hbQ5UKMOgcJrLryCIk7RCbEu4NLjHiHQNqKVE34o3IZz0odDGWIULLJVeeN9aFawjlQW1gBSiFwYGiKIIV8QjFqu4q00O2SAeZofpKMUNu26wgV1fVBd/haLBDlVJpWqWfGOa1eskpoi2Sjy21YyZRKoHEtWYVUR5VPKVdXqrnTsuisQjmgSbzZK5VkvDdESojb06tiZPx6M89RH9KaDv7CmPUwx11mq9AdNa6Rx++DJg055tQ2zlZaOcpgwqbIYqSyi1qqFhsnjqYHANi9WOwZvjY4wrDNvqfXUYfXpzcze5vZ3ezM6vLn1sSWqvnxhM37dl6nMJSa0aHDVW5I84WJwjIg8B8Fc1DDvuE+8aHFRqp/e47V2NJXTxWM8sFCwtW9n4A5FKrmvlzEfYK7lgeZK87in0s16e9t+FTIhZSxryibWTsCd9TzhmpiURAegO9Th4Qc7TbDTOh7uuWJi2G4JMSvQ7Ucpi8aT5HVhFkM7G5NlomGceLo7jXaJhI+V2SIB4WGz1veOBH/78N3XBknBroFT6kSZLbivlLBCgXFMniN6Mjzfdcq6PnHu1GM/TL84GaZqO/yH7+oeDv2KfN8eblktuORH8e8i2LbglI379ZRmM9zecwAZv6fLEw33PC5wX7HA3KCLoBpyi+wKk3IHa8vKXcP8JO4/GL8fO4NpoRfGErtvLccMx80e08VGvBfPcTOO4jwRtPb1kHPfPcQ/FhphWCG+r36REUib80Hi1WfCm2chWFSoIO+SAbDiMR71Blg6Qn88/9u1zV6JcdH4Chq8eJxEIAAA=
```

## `ci-fix-r1-logs/02-green.log`

1159 original bytes; SHA-256 `c5a8a51932dd6039629d6ad8b468a050aea288e9409366153ea1c53ec558deea`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
TAP version 13
# Subtest: session close waits for profile cleanup after caller starts closing
ok 1 - session close waits for profile cleanup after caller starts closing
  ---
  duration_ms: 35.974564
  type: 'test'
  ...
# Subtest: session close waits for profile cleanup after transport starts closing
ok 2 - session close waits for profile cleanup after transport starts closing
  ---
  duration_ms: 28.182414
  type: 'test'
  ...
# Subtest: close during launch retains cleanup ownership and never restores working mode
ok 3 - close during launch retains cleanup ownership and never restores working mode
  ---
  duration_ms: 1.875092
  type: 'test'
  ...
# Subtest: open failure after acquiring the browser waits for cleanup without a circular close wait
ok 4 - open failure after acquiring the browser waits for cleanup without a circular close wait
  ---
  duration_ms: 15.949639
  type: 'test'
  ...
1..4
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 380.578077
no-Kubernetes tripwire: never fired
````

## `ci-fix-r1-logs/03-ownership-green.log`

2032 original bytes; SHA-256 `18f592fce0a97800d1e1c81fc24fbb33717aefe8cee3e9c5af71ced32d61926d`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
TAP version 13
# Subtest: close during launch retains cleanup ownership and never restores working mode
not ok 1 - close during launch retains cleanup ownership and never restores working mode
  ---
  duration_ms: 9.059079
  type: 'test'
  location: '/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/browser-act.test.ts:210:1'
  failureType: 'testCodeFailure'
  error: 'the refuser still accepts connections'
  code: 'ERR_TEST_FAILURE'
  stack: |-
    Socket.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/browser-act.test.ts:203:61)
    Object.onceWrapper (node:events:630:28)
    Socket.emit (node:events:509:20)
    TCPConnectWrap.afterConnect [as oncomplete] (node:net:1691:10)
  ...
# Subtest: open failure after acquiring the browser waits for cleanup without a circular close wait
not ok 2 - open failure after acquiring the browser waits for cleanup without a circular close wait
  ---
  duration_ms: 9.985694
  type: 'test'
  location: '/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/browser-act.test.ts:269:1'
  failureType: 'testCodeFailure'
  error: 'the refuser still accepts connections'
  code: 'ERR_TEST_FAILURE'
  stack: |-
    Socket.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/browser-act.test.ts:203:61)
    Object.onceWrapper (node:events:630:28)
    Socket.emit (node:events:509:20)
    TCPConnectWrap.afterConnect [as oncomplete] (node:net:1691:10)
  ...
# Subtest: worker abort during launch retains its session until the late browser is physically closed
ok 3 - worker abort during launch retains its session until the late browser is physically closed
  ---
  duration_ms: 58.285015
  type: 'test'
  ...
1..3
# tests 3
# suites 0
# pass 1
# fail 2
# cancelled 0
# skipped 0
# todo 0
# duration_ms 375.855421
no-Kubernetes tripwire: never fired
````

## `ci-fix-r1-logs/04-loopback-diagnostic.log`

287 original bytes; SHA-256 `a89cbcd7fd26e5beb95f6e4746f0ea158703e508e82d8b73976d4da5032ede88`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
{
  address: { address: '127.0.0.1', family: 'IPv4', port: 43865 },
  listening: false,
  closedAddress: null
}
connected 127.0.0.1 43865
no-Kubernetes tripwire: never fired
````

## `ci-fix-r1-logs/05-ownership-green.log`

994 original bytes; SHA-256 `4fce01e5175329ee3f579b9bf91f99dc08b88673f7c68649e8ddb74d402bae2d`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
TAP version 13
# Subtest: close during launch retains cleanup ownership and never restores working mode
ok 1 - close during launch retains cleanup ownership and never restores working mode
  ---
  duration_ms: 29.439358
  type: 'test'
  ...
# Subtest: open failure after acquiring the browser waits for cleanup without a circular close wait
ok 2 - open failure after acquiring the browser waits for cleanup without a circular close wait
  ---
  duration_ms: 31.713579
  type: 'test'
  ...
# Subtest: worker abort during launch retains its session until the late browser is physically closed
ok 3 - worker abort during launch retains its session until the late browser is physically closed
  ---
  duration_ms: 48.841392
  type: 'test'
  ...
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 411.806252
no-Kubernetes tripwire: never fired
````

## `ci-fix-r1-logs/06-browser-complete.log`

6184 original bytes; SHA-256 `8623fa45b950ad74f3d3b30c9b1b7d3c77e5892cd65debc0e1275fa7cd766053`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ a takeover that starts while the worker gets ready to click: the click waits for the hand-back (678.542764ms)
✔ a device that is revoked, or may no longer approve, loses the browser at once; the step waits for someone else (585.352006ms)
✔ session close waits for profile cleanup after caller starts closing (42.834952ms)
✔ session close waits for profile cleanup after transport starts closing (42.486545ms)
✔ close during launch retains cleanup ownership and never restores working mode (34.197645ms)
✔ open failure after acquiring the browser waits for cleanup without a circular close wait (32.897687ms)
✔ worker abort during launch retains its session until the late browser is physically closed (49.653441ms)
✔ launch rejection after close still releases the acquired refuser (32.464084ms)
✔ plan: this machine without a port, or at one of Nova’s own ports, can’t be declared or opened (5.008752ms)
✔ plan: what counts as this machine (0.290722ms)
✔ server: a request from a browser task is nobody in particular, on either listener, even from this machine (470.688014ms)
✔ server: a task can’t name Nova’s own listeners, whoever delegates it (the reviewer’s probe) (453.263719ms)
✔ a learnt flow is a decision template: dry runs both ways, activated through the ledger, then its steps run (229.306776ms)
✔ the template’s rule is the ground truth: a wrong path, a missing marker or an obstacle stops the step (0.52175ms)
✔ whatever a template says, a step that presses pay is refused when its flow is run (307.836613ms)
✔ sign-ins: saved by host in the vault, listed without values, deleted only with confirm (91.298583ms)
✔ money: the amounts a page writes, to the cent (4.902485ms)
✔ totals: lines that add up to the total and the quote pass; anything else is a stop with the numbers (18.309267ms)
✔ pay controls: by name, by id or class, by where the form goes, by card fields in the form (2.932578ms)
✔ the plan validator refuses the pay control, a pay address and card fields, whatever the plan or a template says (8.447819ms)
✔ tiers: a checkout plan is tier 3, always; a plan that types or clicks is tier 2; a read is 0 (1.240452ms)
✔ login steps name fields, never values; a11y targets name a role and a name (1.834848ms)
✔ upsells: a box ticked for you that adds money or names an extra; one the plan ticked is not (0.827865ms)
✔ obstacles: a CAPTCHA, a login wall with no sign-in step, a paywall (0.39583ms)
✔ intent: words of the intent against the element’s accessible name (0.578669ms)
✔ the co-pilot template: six Noul questions, valid against the decision-template contract (1.171645ms)
✔ ground truth outranks a probability; a sure model against it stops the step (1.498014ms)
✔ the redactor masks every value a session used, wherever it appears, and nothing shorter than 3 (0.959452ms)
✔ sign-ins live in the vault under the host they were saved for (0.667936ms)
✔ review 3: a declared host is read as the browser reads it, before the this-machine and hub-port checks (1.675151ms)
✔ review 5: a link-local address is never a declared host (1.029139ms)
✔ review 5: a saved sign-in never goes over plain http, except to this machine itself (3.17133ms)
✔ review 2: a step names where it sends; a pay address there is refused; the lists know more ways to pay (3.369235ms)
✔ sweep: profiles whose process is gone are removed; ones in use, other folders and fresh unmarked ones stay (83.258446ms)
✔ sweep: Nova does it when it starts (179.199227ms)
✔ resolver: every name maps to nothing except the declared hosts, without their ports (0.517444ms)
✔ effects: a plan that types, chooses, clicks or hands the page to the person is external; one that only looks is not (62.398028ms)
✔ tiers: filling in and sending a form asks first; looking, or a step only you do, doesn’t (288.725502ms)
✔ provable: a url requirement needs verify.expect; a plan with outside effects needs url evidence on a page it names (991.731667ms)
✔ the url checker: Nova’s own re-fetch decides when there is one; a page with outside effects can’t prove itself (1.185093ms)
✔ local: only addresses on this network count; a name that sounds local proves nothing (0.201873ms)
✔ CDP: answers find their commands by id, even split across chunks or sharing one (1.908441ms)
✔ CDP: an error answer rejects with the method named; events carry their session (0.71834ms)
✔ CDP: a closed pipe fails what is waiting and refuses what comes next; a silent browser times out (50.382142ms)
✔ Chromium: NOVA_CHROMIUM is used when it is there, and said plainly when it isn’t (5.836648ms)
✔ plan: declared hosts decide what a URL may reach: port, subdomains, schemes (0.76751ms)
✔ plan: where a plan’s data goes, so local-only can refuse it (0.520014ms)
✔ plan: every problem is listed; a navigation outside the declared hosts is refused before it runs (3.06127ms)
✔ input: the person’s pointer and keys are checked before they reach the page (0.494907ms)
✔ evidence: a screenshot counts only if Nova took it for this very task (1.036088ms)
✔ evidence: a link counts only if Nova read that page itself and it shows what the brief expects (1.915922ms)
✔ evidence: Nova fetches the page again itself, following redirects only inside the declared hosts (42.90012ms)
✔ ledger: a running worker that needs the person waits as Needs you, and carries on after (58.418588ms)
✔ ledger: after a restart, a task that waited for the person starts again from the beginning (52.528238ms)
✔ core: with no Chromium, browser work says so plainly; bad plans and remote hosts are refused when delegated (638.672826ms)
✔ core: only the console and devices allowed to approve may take over, drive or hand back (306.331442ms)
✔ form site: the form, the step only a person can do, and the record Nova checks against (45.762199ms)
ℹ tests 57
ℹ suites 0
ℹ pass 57
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2083.002421
no-Kubernetes tripwire: never fired
````

## `ci-fix-r1-logs/08-ui-complete.log`

1907 original bytes; SHA-256 `f0fa03d3b37e0b29cb374dd65217adc55484fdff83f3f8fb5637b03d527cd487`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
TAP version 13
# Subtest: wall 1: the browser refuses Nova’s own listeners, even inside the declared hosts
ok 1 - wall 1: the browser refuses Nova’s own listeners, even inside the declared hosts
  ---
  duration_ms: 2216.479277
  type: 'test'
  ...
# Subtest: wall 2: whatever the browser lets through carries the task’s mark; a page can neither drop nor forge it, and cookies still work
ok 2 - wall 2: whatever the browser lets through carries the task’s mark; a page can neither drop nor forge it, and cookies still work
  ---
  duration_ms: 741.788797
  type: 'test'
  ...
# Subtest: wall 2 alone stops the reviewer’s probe: the marked browser gets the pairing page, not the console
ok 3 - wall 2 alone stops the reviewer’s probe: the marked browser gets the pairing page, not the console
  ---
  duration_ms: 1769.264643
  type: 'test'
  ...
# Subtest: the reviewer’s probe, end to end: a phone that may not approve can’t send a browser task to Nova itself
ok 4 - the reviewer’s probe, end to end: a phone that may not approve can’t send a browser task to Nova itself
  ---
  duration_ms: 1264.534609
  type: 'test'
  ...
# Subtest: declared names still resolve under the resolver rules; the profile names its process and is removed on close
ok 5 - declared names still resolve under the resolver rules; the profile names its process and is removed on close
  ---
  duration_ms: 1666.283062
  type: 'test'
  ...
# Subtest: a hostile page on a declared host gets nothing through to anywhere else
ok 6 - a hostile page on a declared host gets nothing through to anywhere else
  ---
  duration_ms: 5534.005098
  type: 'test'
  ...
1..6
# tests 6
# suites 0
# pass 6
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 13861.154228
no-Kubernetes tripwire: never fired
````

## `ci-fix-r1-logs/09-boundary.log`

406 original bytes; SHA-256 `8bc4cc80e8f03536fe4a382f85f739461b81e31d89ae9268e661be292fe220b3`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ module boundary: outside src/core, only src/core/index.ts is imported (src/device: only mesh/wire.ts and models/hardware.ts) (2.963708ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 300.642677
no-Kubernetes tripwire: never fired
````

## `ci-hang-original-probe.log`

389 original bytes; SHA-256 `3fa63a8e14434350b509f42be55cb04bdfb92b1244d9c6fb8552b39a69b2ef85`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ M10d: Nova stopped mid-write still has a switch: after the restart, without contact, the change reverts (2351.195714ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2769.081776
no-Kubernetes tripwire: never fired
````


## Second CI trigger fixture output

The originalRED/diagnostic and successful unchanged-behavior boundary are preserved separately. These outputs do not substitute for the later required full run. Exact original bytes are hashed; whitespace-normalized displays include gzip+base64 when needed.

### `ci-trigger-fix-logs/diagnostic.log`

1833 original bytes; SHA-256 `a251ec7965391ec8158979375421e3a3138bd3200d374903ebde42bfbea48bf2`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
diagnostic before keyed [
  { id: '4e53710f-740d-4032-9123-2b2b724bc78e', state: 'queued' },
  { id: '062fd2f2-f56a-478a-aafa-7506a0d3b526', state: 'done' }
] {
  first: '062fd2f2-f56a-478a-aafa-7506a0d3b526',
  other: '4e53710f-740d-4032-9123-2b2b724bc78e'
}
diagnostic keyed {
  decision: {
    decision: 'queue',
    reason: 'Added to "Note the event".',
    model: { provider: 'rules', template_id: 'triage', version: 1 }
  },
  task: '4e53710f-740d-4032-9123-2b2b724bc78e'
} [
  { id: '4e53710f-740d-4032-9123-2b2b724bc78e', state: 'queued' },
  { id: '062fd2f2-f56a-478a-aafa-7506a0d3b526', state: 'done' }
]
diagnostic after idle [
  { id: '4e53710f-740d-4032-9123-2b2b724bc78e', state: 'done' },
  { id: '062fd2f2-f56a-478a-aafa-7506a0d3b526', state: 'done' }
]
✖ dedup: the same event within the window is dropped as the same as the earlier one (53.601069ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 143.982156

✖ failing tests:

test at tests/core/triggers.test.ts:83:1
✖ dedup: the same event within the window is dropped as the same as the earlier one (53.601069ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  'queue' !== 'act'

      at TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/triggers.test.ts:100:10)
      at async Test.run (node:internal/test_runner/test:1389:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 'queue',
    expected: 'act',
    operator: 'strictEqual',
    diff: 'simple'
  }
no-Kubernetes tripwire: never fired
````

Exact original bytes (gzip+base64):

```text
H4sIAAAAAAAC/81V224bNxB936+Y5kU24NXedPO2KaAEahsEdQLbeQoCg1rOSqy45IYXS0Lgt35Dn/oj/Z18SYe7G9hBkMBAi6KCBJFD8szMOZyh0vFLv0aj0KEFZ0S7FwZLYKZBDic7WqucPIMtyuYMaukPwBSHXWFBK3i9vP4FDFba8M5cMyEBb9EcoWJSfg8v3zxbPX918dOLn8Eri+404oJtlLZOVLDGWhuEHR7J1dsI4AMIXsJogtNinqV1PJ+kPJ6kRR6fZ3kR5+t8Pc8n62q+wNEZWMccRTp679EjH8Hd2T1EOstrntd5XE9nLJ7MFyxmrGbxfJrOWMqL9TSfPYDgWiEBRO/gA2HUwlj3aBA6oN0WzWMDj+4ectAnH7xyrIQVWpXd7OG8z7DzBMQ2s51xyTmddBqeXGiHQCEE5pV7Mh52NpqjJDRojb4VvIvQeImWEnfYtJJyv+nYItnZJlBKyvUuMyIDekYds7vH5/Y/0fEhxax2aAhO4j8IbkD+N0L7+OcfJC73bdmJZlkzKAd74bZCdda9UFzvQVjgRrctKc3s/fZhjMxIQbkRNJxMi/EszdLZeWNPo4+//0UaW2ch68bWi1DfaTdpmf007Aq231IxVaGU5KlfsjvR+e1nTnM9DLk3zNEtuWkIfVKMzxd5Np1FXV4BT6hN77uMovAPzPXzhPoEJnTZNhu6Z+NgG9OuRVFm/wkpAEtr0YTYV8ZoA29Xl5c3y6ur1eX1i1cX70pYHVpqd4R7y6QP/VBTkyIJjaAmeAR875ksCYe+Q1HCd0+fwohVbtSbw4fyvabcnmvl8ODGPzCl1bHR3v4IJ7WQWCZJstUNJr+hweaYjCuq1EOy12bnDKJNlL5lccOEiisR1+LgvPlkXXshefItOrM0pd/pfSzMHlXVRTQ2XsGJIm+loNiMYrKDuiG7QtONy6xYnJfzL87TPTbuyq/DnmWoqGdaO2KGtd9C3DJ6Wawti8W8LE6HzrZBWqKq4L/SEjUektx47JtWoIKq5TNhhn5GJAf6P2+HOChW9iL0Rt0GfB0aXq/dKgg3LHJR12FBUAfEoNpdpL7yCKrwlIXnAHn0NxdD25IpBwAA
```

### `ci-trigger-fix-logs/final-api-trigger-proactive.log`

624 original bytes; SHA-256 `cd3eb6edb832c3f95c278527c624cd1a91ff4a44a670a79f8b19ba27f67a27c1`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ webhooks are the one route outside the X-Nova guard, and they check their own token (411.370886ms)
✔ the guard exemption is explicit: only the webhook route has it, and no other route can claim it (84.012321ms)
✔ the trigger registry over the API: add, edit, pause, remove; tokens never listed; tasks you delegate are reactive triggers (307.077462ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1287.202875
no-Kubernetes tripwire: never fired
````

### `ci-trigger-fix-logs/final-diff-check.log`

0 original bytes; SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

````text
````

### `ci-trigger-fix-logs/final-m2-acceptance.log`

411 original bytes; SHA-256 `c4f05020ec26f7d13a19c4316c0669d66820d2669e12cfe4c2a55a8536869257`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ M2 gate: event and heartbeat triggers make verified ledger tasks; a proactive message traces to its trigger; local-only holds (1011.398641ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1085.624722
no-Kubernetes tripwire: never fired
````

### `ci-trigger-fix-logs/final-module-boundary.log`

641 original bytes; SHA-256 `d47a270cc3d9e8af6d80bf7dd8c41de2f43b47067eae22a841a0fb07f9229587`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ no file outside the Decision Service reaches a seat or the wire client, and only wire.ts names the endpoint (66.752324ms)
✔ negative controls: each planted violation is caught (0.700981ms)
✔ the service’s index.ts and the core’s index.ts export no seat and no wire client (345.382296ms)
✔ Part 1’s old folder is gone: its code lives in the service (0.336872ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 502.284362
no-Kubernetes tripwire: never fired
````

### `ci-trigger-fix-logs/final-triggers.log`

2319 original bytes; SHA-256 `e814faad2b5b60b15804818384cca9a767b455118f8090d89d4da91b6c58ef36`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ triage.v1 ships as an active template, and a webhook rule turns an event into a ledger task traced to its trigger (89.497765ms)
✔ webhooks: unknown is not found, a wrong or missing token is refused, a paused rule records a drop (65.509767ms)
✔ dedup: the same event within the window is dropped as the same as the earlier one (68.382907ms)
✔ dedup: a new event joins queued work while an identical event is dropped (67.899287ms)
✔ cooldown: a rule that just acted stays silent until the cooldown ends (56.180437ms)
✔ batching: an event while the rule’s earlier task is still waiting is added to it, not made a second task (57.751867ms)
✔ a proactive message traces to its trigger; in quiet hours it is held, then delivered when they end (61.828761ms)
✔ a category the person turned off is dropped, with the reason (45.129869ms)
✔ heartbeat: a due time runs once, however many times Nova ticks (claim-once) (70.305611ms)
✔ heartbeat: runs missed more than 6 hours ago are recorded as dropped; the latest recent one catches up (75.182761ms)
✔ a paused heartbeat does not run, and does not catch up for the time it was paused (80.997654ms)
✔ in local-only mode the remote decision provider is never called, even when registered first (52.694172ms)
✔ an unsure triage does not act alone: the task waits for the person (52.50744ms)
✔ with the triage template retired, triage falls back to the local rules and says no model was used (44.359436ms)
✔ a firing whose rule lives elsewhere (a schedule file) brings its own action: recorded, triaged, claimed once, and traced to its task (48.883674ms)
✔ a task the person delegates is recorded as a reactive trigger linked to it (44.868618ms)
✔ the registry: rules are validated, editable, pausable and removable, and every change is kept (48.265197ms)
✔ an unsure proactive message waits for the person: no tick delivers it, an approval does (42.59965ms)
✔ a message held for quiet hours is withdrawn if its rule is paused, removed or turned off meanwhile (126.267552ms)
ℹ tests 19
ℹ suites 0
ℹ pass 19
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1314.074465
no-Kubernetes tripwire: never fired
````

### `ci-trigger-fix-logs/final-typecheck.log`

72 original bytes; SHA-256 `e8180baa00ad9e924316d504d52e1481d7865b7c7920b00f90f09701440c5da0`.

````text
npm notice run nova@0.1.0 typecheck
npm notice run tsc -p tsconfig.json
````

### `ci-trigger-fix-logs/original-green.log`

364 original bytes; SHA-256 `bf130f565efe7cee36b86f40ea11c5eab8cfb268e3cced851831f390b5ce97a4`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ dedup: the same event within the window is dropped as the same as the earlier one (55.275256ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 149.828531
no-Kubernetes tripwire: never fired
````

### `ci-trigger-fix-logs/original-red.log`

1061 original bytes; SHA-256 `1ec9f69ac1ce25ad1969b9771c6e87a52a1d497b892e426df3874005b674bc50`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✖ dedup: the same event within the window is dropped as the same as the earlier one (55.950745ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 158.50192

✖ failing tests:

test at tests/core/triggers.test.ts:83:1
✖ dedup: the same event within the window is dropped as the same as the earlier one (55.950745ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  'queue' !== 'act'

      at TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/triggers.test.ts:96:10)
      at async Test.run (node:internal/test_runner/test:1389:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 'queue',
    expected: 'act',
    operator: 'strictEqual',
    diff: 'simple'
  }
no-Kubernetes tripwire: never fired
````

Exact original bytes (gzip+base64):

```text
H4sIAAAAAAAC/71UzW4TMRC+5ymGU1Kp2U0IoYmhSGkVoKpoURNOCFXO7mxi4rW3Yzs/Qtx4Bk68CK/DkzDeTVUhRI+sVtrxN+NvZr6x19juZVggGfTowJOqtopQgKQSc+is2Zd5fQwr1OUxFDrsQJoc1gMH1sD7yfwtEGaW8houpNKAG6Q9ZFLrF3D54Wx6fn31+uINBOPQH7V+/fgOOeahEuBXCE6WGHcYD1vlV8rU6FaZ3G5BOcjJVhVXIt1D+MFGSVohcR0IneEwGQ97J8+GpeMc334Ct+Md9GvbBRW769WLSrp7sy63CcmkyVBrztS43FrVeZuVt7k9mHkg6ZU1tyWzD0fJsNcfP23VbUU6ZZZNatFqxS9I36xTFglTFni5RHJJxBKOGg1E/79oAjBxDimWPiWyBB+nNze3k9lsejO/uL76JGC6q3jWzLuROsTDYGHB7Fwyn4A94F2QWjAPv+27gAHb8OT0FNoy8+0Gjg/3O+fezq3xuPPJS2ms2Zc2uFfQKZRGkabpypaYfkbCcp8mmc1xl24trT0hutTYjeyWUpluprqF2vlA9+giKJ2nj8k5fi76vaOHUqTbm6wuKKFgoGM4mVBcGhmpa6Zbxg1SbYv+YDQWJ3/td16Sn4VFjJkUvPnMWs/CyOoxxpXkW+WcGIxOxOAIvtSsS2SXZJXfsUsu+aZ5Cnhc+6ISAtp/zKXduFjjqP698A2Ih4GJZgYNaKvIb4nBZnTTOLeDM1dFER2qrDTGoX1tmX/8AEy8xlCwnbd+AzycJMUlBAAA
```

### `ci-trigger-fix-logs/queued-boundary.log`

355 original bytes; SHA-256 `a42ee25e0059ea76ffc371efb9a1c93bcaf88caba58f1ac10ab06e70005e1dad`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ dedup: a new event joins queued work while an identical event is dropped (52.887042ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 150.054312
no-Kubernetes tripwire: never fired
````


## Third CI coding fixture output

Controlled diagnostic Git scheduling is distinguished from unmodified isolated passes. The source report retains private upstream build failures/provenance; compiler/vendor output is excluded here. These original test byte streams are hashed; trailing whitespace is normalized only in displays, with exact gzip+base64 payload if needed. No passing suite was regenerated for this archive.

### `ci-coding-fix-logs/01-unchanged-case.log`

380 original bytes; SHA-256 `4d67799f6aa54b41541c20640aea1caa769c8be8f2f137183e97b5186e8abdf1`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ M10c: what Nova refuses from an agent: the tests, git’s own files, a link out, nothing at all (766.398799ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1124.797829
no-Kubernetes tripwire: never fired
````

### `ci-coding-fix-logs/02-manifest-case.log`

379 original bytes; SHA-256 `467589756aa368485a6b3f72852d37723b604c99575a20568f4b26462ba99142`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ M10c: what Nova refuses from an agent: the tests, git’s own files, a link out, nothing at all (704.599535ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 999.320661
no-Kubernetes tripwire: never fired
````

### `ci-coding-fix-logs/08-git256-manifest-case.log`

379 original bytes; SHA-256 `2ac835b837a433bac62b6f3554eba68517fb9ccf552b633a31b441ba77bca6a2`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ M10c: what Nova refuses from an agent: the tests, git’s own files, a link out, nothing at all (651.433657ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 955.973882
no-Kubernetes tripwire: never fired
````

### `ci-coding-fix-logs/10-controlled-case.log`

1446 original bytes; SHA-256 `8afeed5735c0c1b3e9949248b288a434d1eeb5c7efa3fe15e0b4dbe7de16e870`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✖ M10c: what Nova refuses from an agent: the tests, git’s own files, a link out, nothing at all (647.59581ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 956.39852

✖ failing tests:

test at tests/core/coding.test.ts:222:1
✖ M10c: what Nova refuses from an agent: the tests, git’s own files, a link out, nothing at all (647.59581ms)
  AssertionError [ERR_ASSERTION]: the person’s repository untouched throughout
  + actual - expected

  + '69f8434e960d633e9f343f37e12621251fed1ca7a351df64b021658c9b0deb85'
  - 'c8323fa7ffb16e9fe5fa767a5c0ab52fd227ac03807b9ec9c360642c71ce1dec'

      at TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/coding.test.ts:246:12)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1389:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: '69f8434e960d633e9f343f37e12621251fed1ca7a351df64b021658c9b0deb85',
    expected: 'c8323fa7ffb16e9fe5fa767a5c0ab52fd227ac03807b9ec9c360642c71ce1dec',
    operator: 'strictEqual',
    diff: 'simple'
  }
no-Kubernetes tripwire: never fired
````

Exact original bytes (gzip+base64):

```text
H4sIAAAAAAAC/8VU227cNhB936+Yt7XR3dVtdWOLAptg2wZBnMJ2n4rCoKihl1mJVHiJ1ygK9KHfUKBAf6S/ky/pSLLbJkXyFCB6kMiZ0ZkzZ4bUZv08NGg1enTgrRrulEUG3PbYwtmRfMJ3Kzhg169AduEEXLdwzBwYDd/vrr8Di8LYdjJLrjrAN2jvQfCu+xKe//Bk//TlxTfPvoWgHfrzxds/f4cXSSwY3B24hwvzhhOCDI7SS2t6wgF+i9oz8AcEYuXdCm6Vf/vrH5TzToNUHZKJQ6f0EUzwK9DGH5S+BQKktHBWbMtNXudV0jvK+NtfMwwk09oFNdYaT5uBu8flRH4OEVwL7DpSYHa5oxqGf3betOZh2QbLvTL6pndQ58Umq6s8XUxFjnAjpyk1WyzG70hw2kckGdKrpYjNaNlQTJqmLPkMAgHsnEM71rG31lj4cX95ebO7utpfXj97efHTnGhA64yeklgcjFPeUJuD9iaIA2njD9aE2wOlI8AvgAsfeAdrwNNAI4QtWSfHsqhltc22WBdxW2QZ1jLbZjIrMUmLNEnzRGKbCF7yLE9aWWybOE2KvBJ1E7fYVPmSYNawFFWWZpKXUjZJQSCY06YoeS5i3uSpbNO05CLOqrhsahS1yIq42KaiTAQmLYrlTGh8SJVrkvGp0R5PfvMV10bf9ya4r+FsFJNFUXQwPUav0GJ/H22ocXiK7ow9eovoIk1NWvdc6bVQa6lOPthHaxNU10Yfafq2YEl6/i+TwRqBzm0evtdKHN1Ot5f4imSkFjk405SeKSJrNe+ih8DIc3e8eR0woGNJvGX5f0C5u9diKnJjg34fYeRyQ3aNdlqzJKtqVv7vf+e59VehGWN2kn5+Yox33vLhY4gHTreLcyyrSpadw88TKg0w0tHB9gW5aJwZnZfO4WpyjvIyWL4zhcvZNY8V+wRTNOM9Tif7BAM1I5phLMxYQiRplPD718T4wdkqKUeH6ocOxwn8ZaE/cAPr8R6ls2zp6PwN/8kvK6YFAAA=
```

### `ci-coding-fix-logs/11-fixture-only.log`

570 original bytes; SHA-256 `eb16835dfd7ca07f303936fe7fce7fe847498cfde98a5184c7926035ad88dee6`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
{"before":"42391cc64dd9b8d119d7d5d42acb43d9d908c917809204e2d8bd1bf405ca20ba","after":"dee46a8349a1418a36504221ca5188c01ffe1f2bf61f88f63d87a3b4c2ff4139","onlyExpectedDelta":".git/objects/maintenance.lock"}
✔ fixture setup alone leaves a detached Git maintenance lock; no Nova instance exists (24.293918ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 96.119778
no-Kubernetes tripwire: never fired
````

### `ci-coding-fix-logs/13-controlled-receipt-red.log`

1449 original bytes; SHA-256 `4a2e36e1d9504c1e41bda105bd4d0d602dff47a95b72c07a14afb6c44757e6b0`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✖ M10c: what Nova refuses from an agent: the tests, git’s own files, a link out, nothing at all (652.377104ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 967.658897

✖ failing tests:

test at tests/core/coding.test.ts:222:1
✖ M10c: what Nova refuses from an agent: the tests, git’s own files, a link out, nothing at all (652.377104ms)
  AssertionError [ERR_ASSERTION]: the person’s repository untouched throughout
  + actual - expected

  + 'f7589c7d94b85254bab87443d653c8464a095ce075c449668a4d2f19bc35335f'
  - '1f088d9241cf67e99f4d1dc40348665423d0b8a0596702fb0d0fb69228971187'

      at TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/coding.test.ts:246:12)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1389:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: 'f7589c7d94b85254bab87443d653c8464a095ce075c449668a4d2f19bc35335f',
    expected: '1f088d9241cf67e99f4d1dc40348665423d0b8a0596702fb0d0fb69228971187',
    operator: 'strictEqual',
    diff: 'simple'
  }
no-Kubernetes tripwire: never fired
````

Exact original bytes (gzip+base64):

```text
H4sIAAAAAAAC/8VUzW7cNhC+71PMbW10d/X/xxYFNsG2DYI4he2eisKgyJHFrEQqJBWvURTooc9QoEBfpK+TJ+lIstsmRXIKEB0kcmb0zcw3H6nN9vlYo9Xo0YG3arhTFhlw26OEsyP5hO820GLXb6DpxhNwLeGYODAavt9ffwcWhbFyNjdcdYBv0N6D4F33JTz/4cnh6cuLb559C6N26M9Xb//8HV5EoWBw13IPF+YNJ4RmdJS+saYnHOC3qD0D3yJQVd5t4Fb5t7/+QTnvNDSqQzJx6JQ+ghn9BrTxrdK3QICUFs7yLN4lRRGFae8o5W9/LTgQzWs3qqnZcN4M3D0u5+qXEMG1wK4jChaXO6ph+GfnjTQPSzla7pXRN72DKi92eVaWVbGa25zwpqrm3Gy1mr5TifM+INKQXpIidpNlRzFxHLPoc1AEsHcO7dTJwVpj4cfD5eXN/urqcHn97OXFT0umAa0zes5icTBOeUOTHrU3o2iJHd9aM962lI8AvwAu/Mg72AKeBlIRSrLOjnVTZGUlClmldZnFWVrzuizSNJF5logyzVMeVpnAsMhEmlZ5XvJUxk1U1SLJkiRr1gSzhXXUhGUpqziNRJMXWFVNKiMp0jBJyzzP0jiRYV3yMKPJhHFThzJs6ryKYxpRFJXFeiloeoiWa+LxqdEeT373FddG3/dmdF/D2cQmC4KgNT0Gr9Bifx/saHJ4Cu6MPXqL6AJNU9r2XOmtUNtGnfxoH631qDoZfGTqac6i+PzfSgZrBDq3e/heK3F0ey0v8RXRSCNycKYpPVNUrNW8Cx4CA8/d8eb1iCM6RpNl2X9AubvXYm5yZ0f9PsJUyw3ZNdp5zaKkrFjxv/+d59ZfjfUUs2/o5yfGeOctHz6G2HK6YJxjSVmw5Bx+nlFJwUiHB+ULcpGeGR2YzuFmdk70Mli/o8L14lpkxT6Biha8R3WyTyCoBdEMU2PGEiJRo4Q/vKaKH5xSNc3kUP3Q4aTAX1b6A5ewnq5SOsyWjs7fEHDkqqkFAAA=
```

### `ci-coding-fix-logs/14-controlled-receipt-green.log`

379 original bytes; SHA-256 `424a445efff436266cc454220aa811e32562e0fe72579afafa9911c802bd9afe`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ M10c: what Nova refuses from an agent: the tests, git’s own files, a link out, nothing at all (677.905277ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 989.634139
no-Kubernetes tripwire: never fired
````

### `ci-coding-fix-logs/16-final-git256-affected.log`

6949 original bytes; SHA-256 `e28e4246db400931cb7c5c5ef8270307894ef6451c83ff7ee12837f746e62c37`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ M10c gate: a coding request in chat ends as a reviewed diff with green tests and a running preview, asks before merge; declined, nothing is merged; confirmed, exactly the reviewed diff (3206.182495ms)
✔ Nova’s git reaches only local paths: no network transport, no ext:: helper (37.642318ms)
✔ Nova’s git takes no GIT_* variable of its own process, and no personal config (51.959178ms)
✔ a branch name is never read as an option or a range (0.672303ms)
✔ the preview’s loopback check reads the kernel’s listening sockets (1.366893ms)
✖ a whole coding run, merge included, runs none of the person’s hooks and no fsmonitor (34.213993ms)
✔ review 1: once a confirmed merge passed its commit point, decline, cancel and discard are refused, and the record says what git did (897.448256ms)
✔ review 2: a preview whose shell exits takes its process group with it; decline and close leave nothing listening (3675.645233ms)
✔ review 2: after a restart Nova stops a preview group it recorded, and only one that is still the process it started (1349.848992ms)
✔ review 3: the agent can’t make failing tests pass through the test runner’s configuration (812.393558ms)
✔ review 3: chat can’t widen what the agent may change; the scope in force is in the run for both sheets (299.561737ms)
✔ review 4: a link that escapes through another link in the tree is refused (322.412593ms)
✔ review 5: the merge is a compare-and-swap of the branch even when it is checked out; a switch in the window moves only that branch (441.11918ms)
✔ review 5: a branch that moves in the merge’s window starts a new round, not a failure (421.822357ms)
✔ review 6: a repository’s own protocol and insteadOf settings can’t send Nova’s git to the network (435.954834ms)
✔ review 7: a huge file the agent leaves is refused by its size, never read (0.666893ms)
✔ review 8: a change too big to show in full is never offered as reviewed (310.697195ms)
✔ review 9: a merge that already moved the branch before Nova stopped is merged, not failed (388.754908ms)
✔ review 10: a write cancelled while Nova commits leaves no worktree, no branch and no head (3260.998604ms)
✔ review 11: any listener of the preview’s process group off loopback stops the check (503.301282ms)
✔ review 12: a run’s records and Nova’s copy of the repository go when nothing uses them (940.024259ms)
✔ M10c gate: a coding request ends as a reviewed diff with green tests and a running preview, asks before merge, and declining leaves nothing merged (1251.631933ms)
✔ M10c: approving merges exactly the reviewed diff into the branch, and pushes nothing (1134.435197ms)
✔ M10c: the branch moved after review: nothing unreviewed is merged, and Nova asks again (2035.997539ms)
✔ M10c: a failing test run never reaches the merge ask (399.044584ms)
✔ M10c: what Nova refuses from an agent: the tests, git’s own files, a link out, nothing at all (757.958902ms)
✔ M10c: a preview that listens on every address is stopped, and the check fails (556.256015ms)
✔ M10c: the person’s checkout with uncommitted changes is never merged over (1059.683218ms)
✔ M10c: undo of the write removes Nova’s worktree and branch; nothing of the person’s changes (365.281067ms)
✔ M10c: Codex’s and Relay’s stand-ins write the change too, through the same adapters (622.235083ms)
✔ M10c: starting checks the repository, the branch, the agent and the privacy mode (225.449793ms)
✔ M10c: two runs on one repository at once each get their own worktree and branch (342.187003ms)
✔ M10c: after a restart the merge ask stands, says its preview stopped, and still merges only the reviewed commit (1083.092534ms)
✔ no file outside the Decision Service reaches a seat or the wire client, and only wire.ts names the endpoint (43.212209ms)
✔ negative controls: each planted violation is caught (0.80293ms)
✔ the service’s index.ts and the core’s index.ts export no seat and no wire client (427.719524ms)
✔ Part 1’s old folder is gone: its code lives in the service (0.301155ms)
✔ text hidden by CSS is kept apart from what a reader sees, and flagged (17.340736ms)
✔ a class that a stylesheet hides counts as hidden (0.807668ms)
✔ instructions hidden in a page block it; so do protocol tags hidden there (0.937678ms)
✔ comments, alt, title and meta text are read only for instructions; plain ones are fine (2.581259ms)
✔ zero-width, direction and tag characters are flagged and removed; emoji joiners are fine (24.768156ms)
✔ long encoded runs that decode to words are flagged; to instructions, they block; random ids are only noted (2.272131ms)
✔ a link that shows one host and goes to another is flagged; matching and wordy links are fine (1.365205ms)
✔ instruction-shaped text is found as spans; ordinary imperatives are not (1.682792ms)
✔ Nova’s own protocol tags in visible text are flagged, opening and closing (1.031936ms)
✔ mail authentication: a failing DMARC verdict is flagged; no header is unknown, never a pass (2.430409ms)
✔ mail: a Reply-To elsewhere, and a display name that names another address, are flagged (0.991192ms)
✔ attachments: executables and macros are flagged, archives noted, a type that fights its name flagged (1.018648ms)
✔ an ordinary page passes the checks with nothing flagged (1.515713ms)
✔ after reading a web page, code_change asks first and names the source; declined, no run starts (7135.231589ms)
✔ a run that read nothing from outside starts the coding run on its own (573.171955ms)
ℹ tests 52
ℹ suites 0
ℹ pass 51
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 14605.907387

✖ failing tests:

test at tests/core/coding-git.test.ts:67:1
✖ a whole coding run, merge included, runs none of the person’s hooks and no fsmonitor (34.213993ms)
  Error: ENOENT: no such file or directory, open '/tmp/nova-test-HvezuH/nova-coding-hooks-NdUW27/project/.git/hooks/pre-commit'
      at writeFileSync (node:fs:2406:20)
      at TestContext.<anonymous> (file:///home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/coding-git.test.ts:73:5)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1382:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:960:18)
      at Test.postRun (node:internal/test_runner/test:1522:19)
      at Test.run (node:internal/test_runner/test:1447:12)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.processPendingSubtests (node:internal/test_runner/test:960:7) {
    errno: -2,
    code: 'ENOENT',
    syscall: 'open',
    path: '/tmp/nova-test-HvezuH/nova-coding-hooks-NdUW27/project/.git/hooks/pre-commit'
  }
no-Kubernetes tripwire: never fired
````

### `ci-coding-fix-logs/17-final-host-coding.log`

1580 original bytes; SHA-256 `979b0631f4874e6d74822a45ac606d1472c207d6b148d3ef0a5aacf21669cf1f`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ M10c gate: a coding request ends as a reviewed diff with green tests and a running preview, asks before merge, and declining leaves nothing merged (1316.721195ms)
✔ M10c: approving merges exactly the reviewed diff into the branch, and pushes nothing (1307.820495ms)
✔ M10c: the branch moved after review: nothing unreviewed is merged, and Nova asks again (2381.228468ms)
✔ M10c: a failing test run never reaches the merge ask (487.207363ms)
✔ M10c: what Nova refuses from an agent: the tests, git’s own files, a link out, nothing at all (901.792953ms)
✔ M10c: a preview that listens on every address is stopped, and the check fails (587.733693ms)
✔ M10c: the person’s checkout with uncommitted changes is never merged over (1115.118421ms)
✔ M10c: undo of the write removes Nova’s worktree and branch; nothing of the person’s changes (325.277165ms)
✔ M10c: Codex’s and Relay’s stand-ins write the change too, through the same adapters (760.855384ms)
✔ M10c: starting checks the repository, the branch, the agent and the privacy mode (221.863777ms)
✔ M10c: two runs on one repository at once each get their own worktree and branch (347.038153ms)
✔ M10c: after a restart the merge ask stands, says its preview stopped, and still merges only the reviewed commit (1097.044199ms)
ℹ tests 12
ℹ suites 0
ℹ pass 12
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 11412.698903
no-Kubernetes tripwire: never fired
````

### `ci-coding-fix-logs/18-final-typecheck.log`

72 original bytes; SHA-256 `e8180baa00ad9e924316d504d52e1481d7865b7c7920b00f90f09701440c5da0`.

````text
npm notice run nova@0.1.0 typecheck
npm notice run tsc -p tsconfig.json
````

### `ci-coding-fix-logs/20-final-git256-affected.log`

5839 original bytes; SHA-256 `f4b89f31ed008ff41a1815060e976bc75813fa3d9d480c55c6afe05629040570`.

````text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ M10c gate: a coding request in chat ends as a reviewed diff with green tests and a running preview, asks before merge; declined, nothing is merged; confirmed, exactly the reviewed diff (3011.050842ms)
✔ Nova’s git reaches only local paths: no network transport, no ext:: helper (25.700012ms)
✔ Nova’s git takes no GIT_* variable of its own process, and no personal config (31.884635ms)
✔ a branch name is never read as an option or a range (0.555457ms)
✔ the preview’s loopback check reads the kernel’s listening sockets (1.063206ms)
✔ a whole coding run, merge included, runs none of the person’s hooks and no fsmonitor (551.685417ms)
✔ review 1: once a confirmed merge passed its commit point, decline, cancel and discard are refused, and the record says what git did (755.784902ms)
✔ review 2: a preview whose shell exits takes its process group with it; decline and close leave nothing listening (3525.318122ms)
✔ review 2: after a restart Nova stops a preview group it recorded, and only one that is still the process it started (1246.127193ms)
✔ review 3: the agent can’t make failing tests pass through the test runner’s configuration (747.181491ms)
✔ review 3: chat can’t widen what the agent may change; the scope in force is in the run for both sheets (326.388274ms)
✔ review 4: a link that escapes through another link in the tree is refused (266.074945ms)
✔ review 5: the merge is a compare-and-swap of the branch even when it is checked out; a switch in the window moves only that branch (406.614574ms)
✔ review 5: a branch that moves in the merge’s window starts a new round, not a failure (445.651923ms)
✔ review 6: a repository’s own protocol and insteadOf settings can’t send Nova’s git to the network (416.066707ms)
✔ review 7: a huge file the agent leaves is refused by its size, never read (0.655459ms)
✔ review 8: a change too big to show in full is never offered as reviewed (319.960319ms)
✔ review 9: a merge that already moved the branch before Nova stopped is merged, not failed (385.889613ms)
✔ review 10: a write cancelled while Nova commits leaves no worktree, no branch and no head (3308.291223ms)
✔ review 11: any listener of the preview’s process group off loopback stops the check (499.832526ms)
✔ review 12: a run’s records and Nova’s copy of the repository go when nothing uses them (958.919561ms)
✔ M10c gate: a coding request ends as a reviewed diff with green tests and a running preview, asks before merge, and declining leaves nothing merged (1147.183416ms)
✔ M10c: approving merges exactly the reviewed diff into the branch, and pushes nothing (1055.800634ms)
✔ M10c: the branch moved after review: nothing unreviewed is merged, and Nova asks again (1728.99554ms)
✔ M10c: a failing test run never reaches the merge ask (351.1468ms)
✔ M10c: what Nova refuses from an agent: the tests, git’s own files, a link out, nothing at all (690.105263ms)
✔ M10c: a preview that listens on every address is stopped, and the check fails (499.021617ms)
✔ M10c: the person’s checkout with uncommitted changes is never merged over (1021.527398ms)
✔ M10c: undo of the write removes Nova’s worktree and branch; nothing of the person’s changes (294.525082ms)
✔ M10c: Codex’s and Relay’s stand-ins write the change too, through the same adapters (676.446174ms)
✔ M10c: starting checks the repository, the branch, the agent and the privacy mode (225.602846ms)
✔ M10c: two runs on one repository at once each get their own worktree and branch (316.594786ms)
✔ M10c: after a restart the merge ask stands, says its preview stopped, and still merges only the reviewed commit (1026.506354ms)
✔ no file outside the Decision Service reaches a seat or the wire client, and only wire.ts names the endpoint (42.253735ms)
✔ negative controls: each planted violation is caught (1.414288ms)
✔ the service’s index.ts and the core’s index.ts export no seat and no wire client (383.598063ms)
✔ Part 1’s old folder is gone: its code lives in the service (0.225199ms)
✔ text hidden by CSS is kept apart from what a reader sees, and flagged (19.252932ms)
✔ a class that a stylesheet hides counts as hidden (0.823394ms)
✔ instructions hidden in a page block it; so do protocol tags hidden there (0.936748ms)
✔ comments, alt, title and meta text are read only for instructions; plain ones are fine (1.566528ms)
✔ zero-width, direction and tag characters are flagged and removed; emoji joiners are fine (18.374993ms)
✔ long encoded runs that decode to words are flagged; to instructions, they block; random ids are only noted (1.997453ms)
✔ a link that shows one host and goes to another is flagged; matching and wordy links are fine (1.170466ms)
✔ instruction-shaped text is found as spans; ordinary imperatives are not (1.294276ms)
✔ Nova’s own protocol tags in visible text are flagged, opening and closing (0.526433ms)
✔ mail authentication: a failing DMARC verdict is flagged; no header is unknown, never a pass (1.454363ms)
✔ mail: a Reply-To elsewhere, and a display name that names another address, are flagged (0.786324ms)
✔ attachments: executables and macros are flagged, archives noted, a type that fights its name flagged (1.598862ms)
✔ an ordinary page passes the checks with nothing flagged (1.389706ms)
✔ after reading a web page, code_change asks first and names the source; declined, no run starts (1125.115275ms)
✔ a run that read nothing from outside starts the coding run on its own (587.103459ms)
ℹ tests 52
ℹ suites 0
ℹ pass 52
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 14109.919368
no-Kubernetes tripwire: never fired
````

### `ci-coding-fix-logs/22-final-diff-check.log`

0 original bytes; SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

````text
````
