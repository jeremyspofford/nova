# Second-model review findings A — Vault Broker Phase 1, PR #275 (2026-11-01)

Status: OWNER INPUT for PR #275 (vault/broker-phase1). Source: an
independent second-model review of
docs/reviews/vault-broker-phase1-review-packet.md, pasted by the
owner 2026-11-01 (which model produced this set — ChatGPT or
Gemini — to be confirmed; the second model's set is still
outstanding). Triage note (Muse): none of SEC-01..05 duplicates
the already-fixed B1-B5/S-series; SEC-07 confirms those fixes hold
in the inspected paths. SEC-03 is adjacent to B3 (scrubbing) but
distinct: it covers a DERIVED secret (the HMAC), not the stored
value. Per the packet's rule, each finding gets a failing test
first, then the fix.

"SEC-01 — High — Migration commit bypasses registered-passkey approval
- Claim broken: C4; §1 requires a passkey for migration commit when one is registered.
- File/function: src/broker/broker.ts, #migrate.
- Reproduction: Register a passkey, stage an old vault, request migration commit, then repeat with { id, digest, mode: 'core' } from the returned challenge. Unlike other tier-3 mutations, migration commit calls #approve without the passkey-required argument. Core can authorize moving and removing the old credentials without a passkey assertion.
- Smallest fix: Pass true to the migration commit’s #approve call, matching other tier-3 mutations.

SEC-02 — High — Approval digest omits injection settings
- Claim broken: C4: approval binds the exact action.
- File/function: src/broker/broker.ts, cardBinding, #create, #propose.
- Reproduction: Request approval to create an HTTP binding using { how: 'header', header: 'X-Service-Key', prefix: '' }. Before redeeming the approval, change the header to another name or change its prefix. cardBinding includes only inject.how, so both actions have the same digest. The approved credential is saved with different injection behavior. The same omission applies to signing settings and migration proposals.
- Smallest fix: Include the complete validated injection configuration in the canonical action and expose its meaningful settings on the approval card.

SEC-03 — High — Echoed signing output crosses the boundary unchanged
- Claim broken: C2 explicitly forbids returning a credential’s HMAC.
- File/function: src/broker/broker.ts, #use, inject.
- Reproduction: Use a credential with how: 'sign' against a bound endpoint that returns its received signature header in the response body. The broker computes the HMAC and sends it, but constructs the response scrubber using only the credential’s value. The HMAC is returned to core unchanged. This needs an ordinary header-echoing endpoint, not a compromised target.
- Smallest fix: Add the actual injected signature and its supported encodings to the response scrubber before returning the response.

SEC-04 — Medium — Changing class can leave a sensitive item with standing consent
- Claim broken: C4 and §1’s explicit refusal of sensitive items with standing consent.
- File/function: src/broker/broker.ts, #update, #propose.
- Reproduction: Create a standard item with a standing-consent binding. Approve a metadata update setting class: 'sensitive'. #update preserves its bindings without applying the sensitive-consent check. Alternatively, propose a sensitive class while leaving an existing consent-bearing binding outside the proposal’s replacement set. The resulting item violates the class policy. #use still checks sensitivity, so this alone does not establish a tier-1 bypass.
- Smallest fix: Validate the complete resulting metadata and binding set before saving either change; refuse sensitive items with any standing consent.

SEC-05 — Medium — Migration can delete a newer old-vault value
- Claim broken: C9: every item is read back before it leaves the old vault.
- File/function: src/broker/broker.ts, #migrate; src/broker/migrate.ts, removeFromOldVault.
- Reproduction: Stage an old credential containing value A. Before commit finishes, an active old-vault consumer updates that name to value B in the same vault. Commit stores and reads back staged A. The finish launcher rereads the old vault and removes the name containing B. B was never migrated or read back. This is relevant while core still uses the old vault under stated limit 8.
- Smallest fix: Serialize migration against old-vault writers, or condition removal on an unchanged staged revision checked entirely inside the launcher/broker. Leave changed entries in place.

SEC-06 — Note — Verification behavior conflicts with the literal no-oracle claim
- Claim affected: C2.
- File/function: src/broker/broker.ts, #use, verify branch.
- Concrete scenario: Core supplies a body and a signature computed using a guessed credential. outcome.valid confirms whether the guess produces the held key’s HMAC. This is a broker-local oracle without an echoing target, whereas C2 names only the target-echo exception.
- Smallest fix: Explicitly document authenticated verification as another exception, including its approval and rate limits, or remove this operation if the literal claim is required.

SEC-07 — Note — Previously reported fixes with no finding in the inspected paths
- Claims checked: C1/C2, C8/C9.
- Files/functions: #runProgram, #migrate, #adoptInbox, Store.adopt.
- Result: No redeemable program ticket appears in the reviewed launch path; the broker starts the launcher and supplies its value by pipe. Migration conflict decisions use metadata rather than value comparisons. Locally created vaults refuse inbox adoption, and existing holders check signer, vault identity and increasing generation. These checks do not resolve the separate migration approval and consistency findings above."
