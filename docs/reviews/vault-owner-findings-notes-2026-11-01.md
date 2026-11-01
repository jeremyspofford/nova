# Vault owner findings A — implementation NOTES (2026-11-01)

Branch: `codex/vault-owner-findings`, based on `origin/vault/broker-phase1` at `7b39b0c3`.
Owner input copied verbatim to `docs/builder-packet/nova-vault-second-model-findings-2026-11-01-a.md`.
Authoritative design: `docs/plans/vault-broker.md`. No server/schema/LEDGER/ROADMAP wiring changed.

- SEC-01: migration commit now asks for the registered passkey, just like other tier-3 mutations. A rejected core-mode approval leaves the old entries intact.
- SEC-02: every canonical action binds the complete validated injection object (header, environment name, prefix and signing format). Create, bind and migration-proposal cards expose those settings using existing card fields.
- SEC-03: the actual injected signature and the bare HMAC are scrubbed, with the scrubber's supported encodings, from returned response headers and bodies. Tests cover hex and base64 signatures, prefixed and bare echoes, and each supported representation. Existing truncation protection uses the expanded scrubber's longest form.
- SEC-04: metadata updates validate retained bindings; migration proposals validate the complete resulting set, including unchanged bindings. A sensitive item with any standing consent is refused before approval/save.
- SEC-05: stage and finish serialize with legacy vault operations using an exclusive `vault/.writer-lock` directory. Finish checks the staged private snapshot revision while holding that lock; any changed snapshot is kept wholesale. A migrated item's private provenance includes its staged per-entry revision, so staging a newer old value cannot turn an existing alias into proof that it was migrated. Legacy writers refresh cached state under the same lock before mutation, preventing a cached pre-migration map/key from resurrecting deleted credentials or corrupting the rekeyed remainder. The private revision never appears in answers, audit records or approval cards, and conflict decisions never compare a core-supplied value: a resumed entry must retain migrated provenance before its private per-entry revision can match.
- SEC-06: documented authenticated verification's actual local oracle and approval/rate limits in the build plan and review claims. The binding design calls for n8n verification, so the operation remains enabled. A task approval covers additional body/signature pairs; the consent cap and 3,600/hour per-ref cap bound attempts but do not make low-entropy keys safe.
- SEC-07: no change requested.

## Migration operational limits

A busy lock refuses work; there is no lock stealing or automatic stale-lock deletion. If a process crashes while holding it, stop all legacy vault users and migration launchers, establish that no writer remains, then have the operator remove that lock directory before retrying. This implementation intentionally fails closed instead of guessing whether an old lock is safe to steal. Deploy the updated legacy writer and broker together; older binaries and direct filesystem writers do not honor the lock. Era 2 Gmail files are included in the snapshot revision, but the legacy Gmail JavaScript writer does not participate in this vault lock; quiesce those writers before migrating their files. SEC-05's encrypted-vault writer path is serialized and tested with a separate concurrent process.

A revision mismatch leaves newer old-vault data intact. That can leave an already-migrated alias alongside a newer old value; reconcile the conflict explicitly rather than deleting the newer value automatically. The result's `removed` count reports actual cleanup; `moved` describes entries read back in the new store. Existing migration provenance without the new private revision fails closed as a kept conflict on resume.

S4 (pre-migration checkpoints retain old vault keys/entries until aged out) and S6 (a holder can retain older headers/keys and already-received data) remain explicit limits. They have not been resolved by this change.

## Verification evidence

All runs use Node 26.3.1, disposable homes and file key stores, loopback targets, and synthetic canaries. No owner vault, keychain item or external target was accessed.

- RED: `sh scripts/test.sh tests/core/broker-owner-findings.test.ts` before production edits: 16 tests failed, covering SEC-01..05 and injection settings on create/bind/propose. The failures were assertion mismatches: migration accepted core approval; changed injection settings redeemed an approval; signatures escaped; sensitive updates/proposals succeeded; the newer old entry disappeared.
- RED: after SEC-01..04 were green, two further migration tests failed: a write did not refuse the held writer lock; a cached writer reused its pre-migration key and produced an unreadable vault after migration rekeyed it.
- GREEN: focused owner suite, including a separate concurrent legacy-writer process and matching/nonmatching core-replacement guesses: 20/20 passed. Owner suite plus legacy `vault.test.ts` before the final concurrency test: 28 passed, one optional real `secret-tool` test skipped because the service is unavailable.
- Broker and legacy vault suite: `sh scripts/test.sh --test-force-exit --test-timeout=120000 'tests/core/broker-*.test.ts' tests/core/vault.test.ts`: 74 passed, one optional `secret-tool` test skipped (75 total). This was before the final additional core-replacement regression; that test passed in the final 20-test owner run. An initial run exposed a pre-existing test expecting the SEC-04 bug to succeed; it now withdraws consent before changing class. An initial conservative snapshot provenance guard also rejected a valid resumed-subset fixture; the private per-entry revision now preserves that resumption while retaining changed entries. Both were repaired before the green broker run.
- TypeScript: `npm run typecheck` passed after `npm ci --ignore-scripts` installed the locked development dependencies (zero reported vulnerabilities).
- Full suite: the bare `npm test` attempt retained live workers and was stopped within this worktree's own process tree. A retry through `npm test -- --test-force-exit --test-timeout=120000` put the flags after the test globs; inspection showed they were not inherited by workers, so that attempt was stopped too. The complete suite is currently running with the effective leading flags: `sh scripts/test.sh --test-force-exit --test-timeout=120000 'tests/*.test.js' 'tests/core/*.test.ts' 'tests/acceptance/*.test.ts' 'tests/supervisor/*.test.ts' 'tests/chaos/*.test.ts' 'tests/ingest/*.test.ts' 'tests/ingest/*.test.js'`. No full-suite success is claimed while it is running. The process trees stopped were verified to belong to this fresh worktree; no other worktree/preview process was stopped. The final result will be appended when it completes.
- Size: 2,666 lines in `src/broker/` under the existing 3,000-line boundary test's counting rule. The ceiling was not raised. The legacy writer changes are outside that broker count and are included in this branch's diff.

## Unfinished merge gates

The independent adversarial reviewer was interrupted by an automatic safety filter. That required review remains INCOMPLETE; this defensive implementation did not redo it or bypass the filter. The other model's findings set is still outstanding. Neither gate is satisfied by the regression tests or by this owner findings A follow-up. Parent coordination is required before updating the original broker branch; this branch must not be merged directly.

Track 1 should apply any desired ledger/roadmap evidence updates and regenerate the self-contained review packet's source excerpts against the coordinated final head. Its reviewed snapshot remains labeled historical here; the claims section includes SEC-06's concrete exception.
