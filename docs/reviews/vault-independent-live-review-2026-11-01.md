# Independent vault broker adversarial review and fix re-review

Original pinned review source: `8ca4b827594367264869d18360bf987bb6e1678b`.
Final pinned fix source: **`3faa346317d1a1b4f963636673f32e86657b01d6`**.
Final detached review worktree: `/tmp/nova-vault-final-3faa3463`.

**No remaining concrete blocker was reproduced in the declared Phase 1 scope after the three fixes.** This is a preparatory code review, with live synthetic probes; it does not substitute for the separately pending owner review or later consumer integration gates.

## Scope and method

Read the binding `docs/plans/vault-broker.md` and the implementation in `src/broker/` plus `src/core/vault.ts`. Focused on actual fixed-verb/role boundaries, canonical origins and scopes, approval digests and grants, sensitivity/standing consent, retained bindings, legacy-writer coordination, response scrubbing, interrupted migration, and deletion/recovery claims. Findings were derived from source and fresh probes; PR descriptions and gate claims were not used as proof.

Created fresh detached worktrees for the original snapshot and each reviewed fix snapshot. Implementation files remained untouched by this reviewer. All credentials, enrolled keys, legacy vaults, checkpoints, processes and HTTP targets in the probes are synthetic and task-owned. Network activity is dynamically assigned loopback only. Real keychains were disabled for the bounded suite; no owner home, secrets, device, preview or external service was used. No merge or push was performed.

## Findings resolved during this review

### P1: Migration proposals retained grants issued under the old credential policy

Original location: `src/broker/broker.ts`, `#propose` metadata writes/reindex at original lines715–721; compare `#revoked` at578–585.

Scenario: create a passkey-enabled broker and a standard credential without standing consent. Core obtains a task-scoped use grant through a core-relayed tier2 approval. A passkey-approved `create(source.migrate=propose)` changes the credential to sensitive. Repeating the same task request succeeded without the newly required sensitive/passkey approval. The proposal also left the root generation unchanged, so restoring its old encrypted item and reopening the broker restored the former class/bindings.

Expected: the approved policy change revokes old task grants and invalidates prior policy ciphertext. Observed on original pin: `useOk=true`, root generation remained1, and old item metadata reopened as standard.

Fix: `b04a2b380080fd3aa72add08f96035fe3c1d589b`, included in final pin. Proposals use the same revocation path as ordinary metadata/binding changes: rotate once per nonempty approved batch, clear every changed item's grants, and reindex.

Independent final proof: same task now receives `needs_approval`; a core approval for the sensitive request is rejected; a fresh passkey approval succeeds. Root generation advances1→2; old encrypted metadata is classified broken rather than restoring policy. A separate three-item batch changes two refs and preserves the third ref's legitimate unchanged grant; one rotation serves the batch, and an empty approved proposal causes no extra rotation.

Original RED probe: `/tmp/nova-vault-review-8ca4b827/review-proposal-probe.ts`; output `/tmp/nova-vault-review-proposal.log`.
Final GREEN probes: `review-proposal-probe.ts`, `review-batch-proposal-probe.ts` in the final worktree.

### P2: The broker could not recover its own interrupted legacy rekey

Original location: `src/broker/oldvault.ts:37`–`58`, reader; the writer's interruption window was lines78–80.

The writer saves `secrets.json.tmp`, saves the new key, then renames the pending file. An interruption between the latter two leaves the old current file plus a valid authenticated pending file and the new key. `readOldVault` ignored the pending file, so broker migration failed repeatedly on a state the legacy core Vault could recover.

Expected: migration resumes inside the broker/launcher under the existing writer lock. Observed on original pin: stage returned failed; a separate legacy Vault read completed the pending rename, after which broker staging succeeded. No data loss was asserted; the concrete issue was missing self-contained migration recovery.

Fix: `b6389906f6407118bd2004d0ee46b1fe7aaf364e`, included in final pin. Current file takes precedence. Fallback accepts only a supported pending file with the same vault ID, a matching saved key and successful authenticated decryption before rename. Existing launcher writer locking remains in force.

Independent final proof: reconstruct that exact persisted interruption; broker stage recovers it and commits the remaining credential without any core reopen. The previously removed credential stays absent; the core-owned key remains. Regression tests also verify malformed, tampered, independently authenticated wrong-ID and wrong-format pending files are refused without mutation; a held writer lock is respected; a valid current file wins.

Original RED probe: `/tmp/nova-vault-review-8ca4b827/review-migration-recovery-probe.ts`; output `/tmp/nova-vault-review-migration-recovery.log`.
Final GREEN probe: `review-migration-recovery-probe.ts` in the final worktree.

### P2: Proposal cards and digests omitted retained bindings

Original location: `src/broker/broker.ts:715`–`719` on b04a2b38.

A class-only proposal showed `target="unbound"`, `bindings=[]`, and explicitly said that items left unbound cannot be used, but applied metadata retained the item's existing target. Adding another target similarly showed/digested only the new target while retaining others. The approved card therefore did not describe the effective policy.

Expected: the card, digest, consent validation and saved policy describe one complete resulting binding set. Observed before the fix: an approved "unbound" item still had its preexisting loopback target.

Fix: `3faa346317d1a1b4f963636673f32e86657b01d6`. Effective retained-plus-proposed bindings are computed once and used for class/consent validation, the card, digest and application. Only new proposed consents receive the new approval ID, preserving retained consent provenance.

Independent final proof: class-only card names its retained target and matches the applied item. A mixed retained/new-target proposal shows both targets. After a separate approved change to the retained binding's path scope and injection header, reusing the former proposal approval returns `approval_invalid`; a fresh card shows the replacement settings and applies them. Policy-only operations contact neither target.

Original RED probe: `/tmp/nova-vault-final-b04a2b38/review-proposal-card-probe.ts`; output `/tmp/nova-vault-proposal-card.log`.
Final GREEN probes: `review-proposal-card-probe.ts`, `review-effective-digest-probe.ts` in the final worktree.

## Exact final independent probe commands

All six exited0 at the final SHA:

```sh
cd /tmp/nova-vault-final-3faa3463
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH node review-proposal-probe.ts
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH node review-batch-proposal-probe.ts
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH node review-migration-recovery-probe.ts
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH node review-proposal-card-probe.ts
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH node review-effective-digest-probe.ts
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH node review-disclosed-limits-probe.ts
```

Logs are `/tmp/nova-vault-final-<script-basename>.log`, for example `/tmp/nova-vault-final-review-effective-digest-probe.log`. They print outcomes and synthetic paths, without credential values.

## Bounded suite

Final exact pin: **88 passed,0 failed,1 skipped**,89 tests total,22.25 seconds. The sole skip is the real secret-tool test; it was kept outside the authorized test scope by clearing the child process's desktop-session address.

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH DBUS_SESSION_BUS_ADDRESS= node --test --test-concurrency=1 --test-timeout=120000 tests/core/broker-boundary.test.ts tests/core/broker-verbs.test.ts tests/core/broker-store.test.ts tests/core/broker-egress.test.ts tests/core/broker-ipc.test.ts tests/core/broker-canary.test.ts tests/core/broker-owner-findings.test.ts tests/core/broker-review-1.test.ts tests/core/broker-policy-proposals.test.ts tests/core/broker-migration-recovery.test.ts tests/core/broker-proposal-card.test.ts tests/core/vault.test.ts
```

Output: `/tmp/nova-vault-final-tests.log`.

Covered real local IPC/token/role rejection, unknown verbs and fields, canonical/non-bound origins, scope/path refusals, redirects, DNS/private-address and pinned-TLS checks with stand-ins, approval replay/expiry/digest/passkey checks, consent/class/rate policy, launcher target hashes and output handling, generated/sealed/migrated/rotated values, canary scans including a separate client-process heap, item authentication, holder adoption signatures, root rotation, writer coordination and the new regressions. Initial original-pin suite had75 passes and the same one skip.

## Disclosed limits independently confirmed

These were expressly permitted deferrals, not remaining findings:

- **S4:** a real named checkpoint taken before synthetic migration still contains the legacy `vault/key` and encrypted store. It can reopen the old credential after migration removes the current legacy file. The probe records `oldKeyAndValueStillReadable=true`. Existing tests separately verify new checkpoints exclude broker/.
- **S6:** a holder that already received a root wrap and item can still read that old material after holder removal. The probe confirms that its wrap is removed on the hub and a later-generation item is refused by the old holder. Revocation protects future material; it cannot retract already delivered material.

Output: `/tmp/nova-vault-final-review-disclosed-limits-probe.log`.

Other practical limits: Linux Node26.3.1, file/injected key stores, synthetic software passkeys and stand-in targets only; no real OS keychain, biometric/passkey UI, macOS/Windows behavior, separate-user deployment, real consumer sign-in, external manager or full suite. Same-user OS compromise and bound-target behavior remain outside the broker's confidentiality protection. Supported response scrubbing is not a promise about arbitrary encodings or target-controlled transformations. The client-process canary harness is not proof of a completed cutover of every legacy core consumer; core's own identity/data keys remain out of broker scope as designed.
