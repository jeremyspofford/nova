Findings

1. High. Holder enrolment card doesn’t show the holder’s key, so core can substitute its own. Breaks C8 (“device wraps sealed to each holder’s own key”) and the threat-model line that core must not be able to replace a holder’s vault.
src/broker/broker.ts:611-614 (#share). The approved action digests public_key, but the card shows only Let "name" hold Nova Vault and device:<id>. Compare #pinHub at line 595-596, which puts the key fingerprint on the card and tells the person to check it. The person approving an enrolment cannot tell whether the X25519 key is the holder’s or one core generated. After approval, enrollHolder seals the root key to that key in the header and outbox. Core is the designed transport for the outbox and for broker/items/ backups, so once sync carries the outbox (P1b), core opens the root key and every item.
Reproduction: core sends share_scope with device.id = a real holder’s id but public_key = a key core holds; approve the card (passkey or core mode, the card is the same); read broker/outbox/header.json; openWrap with core’s private key yields the root key; items decrypt.
Fix: put the key fingerprint on the card the way #pinHub does, and have the holder’s state() show its own device-key fingerprint so the person can compare.

2. Medium. The migration resume decision is a value-equality oracle, reachable without approval. Breaks C9 (“a name already held is decided by metadata, never by comparing values”).
src/broker/broker.ts:654-659. Status is moved when the staged entry’s sha256(canonical([[name, base64(value)]])) equals the stored migrated_revision, else kept. Core owns the legacy vault and can write any value into it with Vault.put. The status appears in the challenge card (items[].status) before any approval. The SEC-05 test “kept regardless of the replacement guess” only covers the case where core first replaced the broker item (provenance becomes sealed), not the case where it leaves the migrated item alone and guesses into the old vault.
Reproduction: migrate provider/A = V. Then loop: Vault.put('provider/A', G); create {migrate:'stage'}; create {migrate:'commit'} with no approval. The returned challenge.card.items[0].status is moved iff G = V. Approval flood control caps this at 30 guesses per hour, global.
Fix: this is the trade-off the SEC-05 fix made. Either decide resumption by metadata only (provenance, source vault, name) and accept that a value changed after a crash mid-commit is overwritten, or keep the equality check but make the card and the removed count not depend on it. Any observable removal from the legacy vault still leaks the bit, since core can read its own vault, so the honest option is to document it next to the two existing oracles.

3. Medium. A program that ignores SIGTERM keeps its credential after the time limit. Breaks the launcher’s promise that the 0600 file is removed on exit.
src/broker/broker.ts:396 sends SIGTERM to the launcher and SIGKILL five seconds later. src/broker/launch.ts:68 forwards SIGTERM to the program, but SIGKILL hits the launcher only. The program is orphaned with the value in its environment, and the launcher’s close handler at line 70-75, which deletes run/nova-run-*/credential, never runs. The broker then reports exit and decrements #running, so nothing notices.
Reproduction: bind /bin/sh with inject.how='file'; use with argv: ['-c', 'trap "" TERM; sleep 300'], timeout_ms: 1000. After about six seconds the sleep is still running and <broker>/run/nova-run-*/credential is still on disk.
Fix: spawn the program in its own process group in the launcher and have the broker kill the group (or have the launcher escalate to SIGKILL on the child itself before the broker’s five seconds elapse), and unlink the credential file right after spawn succeeds.

4. Medium. Adopting an inbox at boot leaves the broker unlocked with an empty index, and bypasses “ask after restart”.
src/broker/broker.ts:91-97: #adoptInbox runs first, and store.adopt sets #root (src/broker/store.ts:484-485) regardless of unlock_mode. The following branch only reindexes when !store.unlocked, so after an adoption the broker is unlocked with #index empty: list_refs returns no refs and every use is unknown_ref until someone sends unlock. Separately, the hub’s enrollHolder always writes a device wrap into the outbox, so a holder in ask mode is opened by its device key at every new generation without the person’s factor. The tests exercise store.adopt directly, not the start() path.
Reproduction: enrol a holder, write a newer outbox to its inbox/, start the holder broker, call list_refs: locked:false, refs:[].
Fix: reindex after adoption, and in adopt keep the root only when unlock_mode === 'auto'.

5. Medium. Migration cannot read a legacy key kept in the OS keychain, which is the default desktop setup.
src/broker/broker.ts:692 starts the migrate launcher with an environment of TZ only (plus NOVA_VAULT_KEY=file in file mode). src/broker/oldvault.ts:46 then calls chooseStore in auto mode, and src/broker/keystore.ts:85 reports the keychain unavailable without DBUS_SESSION_BUS_ADDRESS (macOS security likewise needs HOME and PATH). It falls back to vault/key, which does not exist when the key is in the keychain, and stage fails with “The old vault’s key isn’t where it should be”. spawn.ts:37 forwards those variables to the broker, but the broker does not forward them to its launcher. All tests run in file mode, which is why this is green. Fail-closed, no data loss.
Fix: pass DBUS_SESSION_BUS_ADDRESS, PATH and HOME through to the migrate and finish launchers when the broker’s own key mode is not file.

6. Medium. Every legacy vault read now takes the exclusive writer lock, so one stale lock makes the whole vault unreadable.
src/core/vault.ts:445: #open() is wrapped in #withWrite, so get, has and list each mkdir and rmdir vault/.writer-lock. If core dies mid-write (power loss during any connector put), the directory stays and every read throws “The vault is busy with a writer or migration” until an operator removes it. Limit 14 presented that recovery as a migration-only situation; it now applies to core’s own writes, and reads never needed the lock. Most call sites in src/core/index.ts catch and degrade (providers, capture key, seal key), but src/core/resilience/index.ts:159 and :291 do not, so recovery-key operations fail outright.
Reproduction: mkdir ~/.nova/vault/.writer-lock, then vault.get('nova/anything') throws.
Fix: take the lock for mutations only. If a read must refresh a stale cache, re-read without the lock; the broker’s finish already protects itself with the snapshot revision check.

Low notes

src/broker/broker.ts:333-345: a process binding with a standing consent lets a model run the bound binary at tier 1 with any argv, cwd, env (TF_VAR_* included) and stdin. The bind card says “requests inside RUN /”, which won’t read as “any arguments” to the person. Say so on the card.
Same lines: task grants never expire. Core picks the task id, so one tier-2 approval covers that exact request for as long as the broker stays unlocked. A TTL or a core-signalled task end would bound it.
src/broker/broker.ts:340: for a process use, cwd, env and stdin are not in the digest or on the card, only argv. For http, the query string is not in scope_item. Limit 12 names headers and body; it should name these too.
src/broker/broker.ts:421-429: the generation policy is neither digested nor shown. The floor (16 chars from 16 symbols) keeps it at 64 bits, so this is a card-honesty point.
src/broker/broker.ts:698: when finish fails, the error says “nothing was moved”, but the items are already in the new store; a rerun resumes correctly, so only the wording is wrong.
src/core/index.ts:500: secrets() calls vault.get per name, each now costing two directory syscalls after finding 6.
Checked and found sound
Answer schema: every answer path goes through checkAnswer; Failed and EgressError messages are fixed strings or Node messages that name a header, never its value.
Canonicalization: //host, %2f, .., ..;, \, #, whitespace, trailing dot, IDNA, default ports, IPv6 forms, DNS resolved once and pinned, redirects not followed, host/connection/transfer-encoding refused from callers.
Approvals: digest includes task; timing-safe compare; single use with a 10-minute replay window; WebAuthn checks type, challenge, origin, rpIdHash, UP/UV, counter and DER signature.
Store: AAD ties key/meta/value to vault, item, version and kind; rotation is crash-safe via next and resumed at unlock; adoption verifies signature, pin, vault id and strictly newer generation; low-order X25519 points are rejected by OpenSSL’s all-zero check.
Backup, checkpoint, sync and SECRET_DIRS exclusions for broker/ are consistent.
What I could not verify
No tests were run from this Windows worktree, and I did not rerun the six live-review probes or confirm the CI run the PR cites.
The keychain-held migration path (finding 5) and the orphaned-program path (finding 3) are from reading the code, not from execution.
Windows named-pipe behaviour and macOS security behaviour, which the packet already lists as untested.

★ Insight ─────────────────────────────────────
Two of the findings share a pattern worth remembering for the rest of this series: the approval card is the only thing the person sees, so any field that changes what the broker does must be on the card, not just in the digest. #pinHub got this right (fingerprint shown), #share didn’t. And the SEC-05 fix shows how a correctness fix can quietly add an oracle: once the decision to remove an old entry depends on byte-equality with something core can write, every observable consequence of that decision becomes a guess channel.
─────────────────────────────────────────────────