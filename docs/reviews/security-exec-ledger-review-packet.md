# Review packet: inherited secrets and physical execution/cleanup ownership

Owner IMMEDIATE S1/S2 from whole-app main `048eea0e`. Complete current candidate artifact: `048eea0ee043f43d01bc9a36bed601ce9805373b` → `c82e6cfc9f1c2e479400074457fa2c8a347216f2`. This self-contained packet includes the whole contextual source/test diff plus full Ledger and Session implementations. Diff/source display removes trailing whitespace only; pinned Git content and retained source manifests are authoritative.

## Claims

- Exec and agent children inherit only a finite set of20 exact public process variables, shared by provider CLI defaults. Unknown future secret names are rejected by construction; actual server secret sources were code-audited, never owner values. Trusted explicit extras are distinct and no production childEnv caller supplies them. Actual disposable-parent/child canary regressions begin RED.
- Exec uses non-login `/bin/sh -c`, so inherited shell/startup/runtime selectors cannot automatically reconstruct secrets. This deliberately narrows implicit shell/profile behavior.
- A timed-out/cancelled/halted Ledger attempt loses commit/notStarted authority immediately but its live underlying promise retains task ID/lane occupancy until actual settlement. No overlapping own retry, late accepted result or unobserved late worker rejection; independent lanes progress. Drain/idle/handover account for physical work without weakening existing effects/approval/recovery.
- Repeated/reentrant Session.close callers await one physical browser/refuser cleanup. The shared completion is published before events; interaction revocation is synchronous. Close during a pending single-open acquisition owns late resources, forbids working-state resurrection, and avoids a public-open/close wait cycle. Worker ownership is released after awaited cleanup. Controlled regressions start RED; launch/initialization failure paths are covered.
- Changed canary-test fixtures wait for actually applied state and own cleanup before setup assertions. Existing exact approval/rollback/byte-integrity outcomes are preserved. No CI/assertion/skip/time-limit relaxation, dependencies or Chromium process-policy changes.

## Threat model and limits

Untrusted content can influence an approved command while the server holds secrets. Protect automatic inheritance without treating the model as a secret-name classifier. Uncooperative/late workers and concurrent browser closure can otherwise make logical completion look like physical cleanup; retain ownership and revoke authority separately.

This is not an OS sandbox or general DLP: explicit commands retain same-user file authority. Real authenticated CLI/OS/keychain/device/cloud behavior was not exercised. Implicit profile/proxy/custom-CA/runtime settings are not automatically forwarded. Trusted extra environments and distinct internal subprocess contracts remain separate.

A permanently pending worker/custom launcher can hold its own slot/close/handover; JavaScript cannot forcibly stop an arbitrary in-process promise. Drain can take `boundMs + 2*commitMs` (eleven minutes with production defaults). No automatic restart or blind effect replay is introduced. Detached work after a returned promise settles is outside the contract. Existing bounded Core.close rejection observation is documented; arbitrary direct premature DB closure is not safe quiescence.

Known pre-existing synchronous-listener-throw cleanup, Chromium best-effort profile removal/possible late writers and arbitrary overlapping/reusable-open patterns are not claimed solved. The corrected contract is single open followed by terminal close.

## Review and actual CI status

Initial S1/S2 task reviews and fresh whole-branch adversarial review approved source7055. The first exact-head CI at a248 **failed**: unit job timed out after four canary/rollback fixture failures, and UI156/157 had one profile-removal failure. Unit causal isolation is established. Six original-source isolated UI passes did not identify its cause. A controlled adjacent close bug was corrected; independent review caught a new pending-launch leak in that correction. Round1 source `3d713478648e50f18bfa7c1dba54f0fff3fa405b` closes that finding with no open findings. Original remote UI profile-removal causality remains **UNPROVEN**, and fresh ordinary final-head CI/LEDGER/merge/preview gates remain mandatory. Local focused passes are not a substitute.

[Initial full reports/output/rulings](../evidence/security-exec-ledger-2026-11-02.md), [complete CI correction and independent reviews](../evidence/security-exec-ledger-ci-correction-2026-11-03.md), [safe exact correction test output](../evidence/security-exec-ledger-ci-output-2026-11-03.md), [plain-language LEDGER](../LEDGER.md). Process snapshots that included unrelated local commands are excluded from public evidence; no actual owner secrets or keychains were used. No extra owner-input gate is invented for these explicitly ordered fixes.

Subsequent ordinary CI atd5 passedUI157/157 but failed one later unit dedup fixture. Test-only correction `4216de43b4e59b0c48f184c87e801d9a96b02be8` was independently approved with no findings; runtime remains identical to reviewed3d7. [Full subsequent failure/correction/review](../evidence/security-exec-ledger-trigger-correction-2026-11-03.md). Another full ordinary final-head CI is still required.

Third ordinary CI failed a repository-hash assertion while UI157/157 passed. A controlled actualGit2.56 daemon and fixture-only control prove a fixture maintenance-lock lifetime race at the same unchanged assertion. The exact originalCIpath remainsUNKNOWN. Test-helper-only `c82e6cfc9f1c2e479400074457fa2c8a347216f2` joins maintenance without altering any protected-path/hash/refusal assertion; independent review approved. [Full causal evidence/review](../evidence/security-exec-ledger-coding-fixture-2026-11-03.md). Another full ordinary final-head CI is required, including the helper’s UI consumer.

## Source/test diff, Ledger and Session (git pointers)

The complete contextual source/test diff and the full Ledger and Session sources were pasted here until the Ponytail P2 docs sweep. Git reproduces them exactly (the pasted copy only dropped trailing whitespace); both commits are on main:

```sh
git diff -U10 048eea0e c82e6cfc -- . ':(exclude)docs'   # the diff: 17 files, +790/-147
git show c82e6cfc:src/core/ledger.ts                     # Complete Ledger
git show c82e6cfc:src/core/browser/session.ts            # Complete Session
```

The packet as it stood, pasted sections included: `git show 13fad251:docs/reviews/security-exec-ledger-review-packet.md`.
