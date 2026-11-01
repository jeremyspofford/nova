# Vault proposal policy review fix

Base: `8ca4b827594367264869d18360bf987bb6e1678b` (PR #275).
Branch: `codex/vault-review-policy-fixes`.

The independent synthetic probe found that an approved `create` / `migrate: propose` changed an
existing credential from standard to sensitive without revoking an existing core-approved task
use grant. The same task then used the now-sensitive credential without a fresh sensitive passkey
approval. Restoring the pre-proposal encrypted item also restored its standard policy after lock
and device unlock, because the proposal left the root-key generation unchanged.

`#propose` now uses the same revocation protection as metadata updates and binding removals.
The existing helper accepts a batch of changed item IDs: it rotates the root once for a nonempty
batch, forgets every changed item's task grants, and refreshes the index. Approval, proposal
validation, retained bindings, consent approval IDs, and the response shape stay on their existing
paths. An empty proposal does not rotate the root.

## Verification

Node 26.3.1. Dependencies came only from local cache:
`npm ci --offline --ignore-scripts --no-audit --no-fund`.

Before implementation, the existing owner-findings and first-review suites passed **29/29**:

```sh
sh scripts/test.sh 'tests/core/broker-owner-findings.test.ts' 'tests/core/broker-review-1.test.ts'
```

New tests were written and run against the base before production edits:

```sh
sh scripts/test.sh 'tests/core/broker-policy-proposals.test.ts'
```

**RED: 0 passed, 3 failed** for the expected behavior gaps:
- The old standard task grant authorized sensitive use rather than returning `needs_approval`.
- Restoring old encrypted item bytes restored standard policy rather than rejecting stale ciphertext.
- Both previous task grants survived an approved multi-item proposal.

After the minimal helper/proposal fix: **GREEN: 3/3 passed**. The tests also verify that sensitive
core approval is rejected, fresh passkey approval succeeds, the retained binding and new policy
survive lock/device unlock, stale ciphertext cannot open its value, and all new policies in a batch
remain readable.

```sh
sh scripts/test.sh 'tests/core/broker-*.test.ts'
npm run typecheck
```

**68/68 broker tests passed; typecheck passed; `git diff --check` passed.** The no-Kubernetes
tripwire was armed and never fired. No full host suite was run for this bounded fix.

Only temporary homes, synthetic credentials, a software passkey and loopback stand-ins were used.
No owner home, real credential, real keychain, external target, real passkey device, or UI flow was
exercised. Real-device behavior is **UNPROVEN**. Owner review B remains a separate pending gate;
this fix and its tests do not satisfy or waive it.
