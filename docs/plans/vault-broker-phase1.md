# Vault broker, Phase 1: the build plan (Track 3)

**Sources:** the ADR, `docs/plans/vault-broker.md` (binding, with its Owner decisions); the owner's text in `docs/builder-packet/nova-vault-broker-design-2026-10-31.md`, `INPUT-2026-10-31-VAULT-BROKER-INSTRUCTION.md` and `INPUT-2026-10-31-VAULT-BROKER-DECISIONS.md`.

**Status:** P1a (this PR) is built. P1b and P1c aren't.

The honest-claims rule governs this document: within Nova, the capability to read a credential's value exists only inside the broker (its process, and its launcher for a program it hands a credential to). Nothing here says more than that.

## 1. The three PRs

The ADR's §13 splits Phase 1 into three PRs. This plan keeps that split, with one change to what P1a holds.

| PR | Holds | Gate items it carries |
|---|---|---|
| **P1a** (this one) | The broker process, Nova Vault's store, unlock, the seven verbs, IPC and caller tokens, the launcher, sealed entry, the migration from `vault.ts`, holder sync on the broker's side, the core client. Also every target kind P1a builds (`http`, its `sign` and `verify` modes, `process`), each proven against stand-ins | 2, 3 (`http`), 4, 5, 6, 7, 8; 1 and 9 for the broker's own surfaces |
| **P1b** | Core switches to the client (§9 rows 1–8, 10, 13, 14), wired by Track 1 from the NOTES below. Then the browser relay (row 9), the `ws` target (Home Assistant's event stream), OAuth with the broker's PKCE verifier (Gmail), and the provider's streamed (SSE) responses | 1 across core's own logs, memory, transcripts and receipts; 3 (`web`); 10 |
| **P1c** | The full gate (`docs/evidence/vault-broker-p1-gate.md`), the adversarial review, the fresh-user test, the claims check and the second-model review's findings | 11, 12, and the re-run of all |

**The change to P1a.** The ADR put the migration of rows 1–8 and 13–14 in P1a.
- The broker's side of each of those rows is built here, and tested through stand-ins:
  - a provider's `Bearer`;
  - n8n's `sign` and `verify`;
  - a connector token and a network target's token, with a pinned certificate for a LAN device;
  - Screenpipe's key;
  - an infra secret and a kubeconfig through the launcher;
  - holder sync and backups.
- **Why the switch waits:** switching core's consumers to the client is wiring in `src/core/index.ts` and `src/server.js`. Those files are Track 1's.
- **What P1b changes:** it is the PR where the switch lands, with the browser relay, because both change how core reaches a credential.

**Gmail IMAP** stays a stated limit until its `stream` target exists, as the ADR says. Binding a `stream` target is refused with `wrong_target_kind`.

## 2. What P1a builds

`src/broker/` is 2,520 lines, under the ADR's budget of 3,000. That leaves about 480 lines for P1b's relay, which is tight (§7).

| File | What it is |
|---|---|
| `protocol.ts` | The fixed lists: seven verbs, three protocol messages, two launcher messages, nine refusals, seven protocol errors. Also the frame parser (id, size cap, unknown fields refused) and the answer schema (`ANSWER_KEYS`, `checkAnswer`) |
| `crypto.ts` | Node's standard library only: AES-256-GCM with associated data; Argon2id (`crypto.argon2Sync`), with RFC 9106's second setting as the floor; X25519 factor keys; P-256 sealed entry |
| `seal.ts` | The person's side of sealed entry, in WebCrypto, so it runs in a browser or in Node |
| `store.ts` | Nova Vault's store: the header, per-item blobs, root-key rotation on delete (finished at the next unlock if cut short), holders, the outbox, and adoption on a holder |
| `keystore.ts` | The device key's OS key store (vault.ts's CLIs, ported), or a 0600 file with the plain notice |
| `origin.ts` | Canonical targets, exact matching, request paths and scopes, lookalike flags, address classes, the class suggestion |
| `policy.ts` | Approvals (core-relayed, or a WebAuthn ES256 passkey), flood control, rate caps, generated values, the weak flag |
| `audit.ts` | The hash-chained audit log |
| `scrub.ts` | Exact-value scrubbing in eight forms, for text and for streams |
| `http.ts` | The only outbound path |
| `broker.ts` | The verbs |
| `server.ts` | The socket, frames, tokens, and the schema check and scrub of every answer |
| `main.ts`, `spawn.ts` | The process, and its hardened start |
| `launch.ts`, `oldvault.ts` | The launcher (run, migrate and migrate-finish) and the old vault's format |

**Core's side:**
- `src/core/broker/client.ts`, whose methods return no value;
- three one-line safety exclusions (§6).

**Tests** live in `tests/core/broker-*.test.ts`, so `npm test` runs them with no change to `package.json`. There are 36 tests in 6 files, and §8 lists them.

## 3. Design decisions P1a took

These are where the ADR left a choice open, or where it didn't fit as written.

1. **Every factor is an X25519 key pair.**
   - The passphrase's private key is its Argon2id output.
   - A recovery key's and a passkey PRF output's private keys come through HKDF.
   - A device's is random, and kept in its own key store.
   - The root key is sealed to each factor's public key. So the broker can re-seal a new root key without being given any factor: on a delete (§10 "Deleting"), and when a holder is removed.
   - The ADR's wording ("a key derived with Argon2id") is kept. The derived key is the factor's private key.
2. **No factor wrap travels.**
   - The outbox carries the header's device wraps (each opens only on its own device) and the other factors' *public* keys.
   - A holder's broker seals the root key to those factors itself.
   - This is stricter than Conflicts row 2 as decided: only sealed per-device wraps move.
3. **The migration runs in four steps, so core never opens the old vault while it holds credentials:**
   - **stage:** the launcher reads `vault.ts`'s file and key itself, plus Era 2's Gmail files, and streams them to the broker;
   - **commit:** each entry becomes an *unbound* item, usable nowhere, with its old name as an alias. Each is read back from disk;
   - **finish:** the launcher takes what moved out of the old vault;
   - **propose:** one tier-3 card lists every moved item with its proposed binding and class, metadata only.

   The ADR's order (make the items, one card, read-back, then delete) is kept. The card gates bindings and classes rather than the move itself, because the move grants no capability: an unbound item can't be used. The whole migration is idempotent by name.
4. **Nova's own keys stay in `vault.ts`** (§9 row 15). The old file holds them beside the credentials, so after the move it is rewritten without the moved names, under a new key. It is deleted with its key only when nothing is left. The ADR said "the old file is deleted"; with row 15, it can't always be. Nova's own names are listed in `OWN_KEYS` (`oldvault.ts`) and mirrored in the client (`isOwnKey`).
5. **Two launcher messages beyond the ADR's list:**
   - `redeem`: a run ticket, or a migration's finish ticket;
   - `migrate_item`: the staged items.

   Both are accepted only on a connection that never said hello. A token-holding connection, core's included, is refused `not_allowed`. The launcher is broker code (the ADR's "the broker" means the process and its launcher).
6. **An unlock factor is sealed to `sha256(vault id | factor | the broker's boot id)`.** A captured envelope dies with the boot. The ADR left an unlock's binding unstated.
7. **`class_policy` is used for one case:** a standing consent on a sensitive credential is refused. Sensitive uses always ask, once per task, or on every use with `per_use`.
8. **`verify` is an `http` binding's injection mode,** on n8n's origin. It needs no network: the answer is valid or not.
9. **The other refusals are protocol errors, not refusals:** an unknown verb, an unknown field, a bad frame, and a frame too large (`ERRORS` in `protocol.ts`). The ADR's refusal list covers verbs.
10. **Approvals:**
    - a passkey signs `sha256(approval id | digest)`, so one approval can't be replayed onto another;
    - passkeys are required for `bind` (adding), for `share_scope`, and for a `create` or migration proposal that carries bindings, once any passkey is registered (Q4);
    - otherwise approvals are core-relayed. The vault's state says which mode is active (`approval_mode`), for Settings.
11. **A rotation's `abandon` takes no approval,** because it narrows. `begin` and `commit` are tier 3.
12. **A holder adopts only a header its hub signed.**
    - Anyone who knows a standby's broker public key could seal a root key to it, so a device wrap alone doesn't show where a vault came from.
    - The hub's broker therefore signs the outbox header with an Ed25519 key of its own (`sign-<id>`, kept beside the device key and stable across its renewals).
    - A holder pins that signing key at its first adoption, and from then on refuses any other signer, another vault id, or an older generation.
    - Items need no signature of their own: each is authenticated under the root key.

## 4. What P1a doesn't do (P1b, P1c, or the owner)

- **Q6, the reveal on the device's own screen,** isn't built, and needs a design choice from the owner. With no network surface, the broker can't serve a page. Candidates:
  - the launcher in a "reveal" mode in a terminal on the device's own screen, gated by the passphrase (not a passkey);
  - a small native helper (Rust, under ADR-2) that can show a system dialog gated by biometrics.

  Neither is a verb, and neither sends the value to core. The owner's decision said "passkey or biometric": the first candidate doesn't meet that as written. For P1c, with owner input.
- **Adding a factor or a passkey after setup** (another passkey, a new passphrase, a recovery key added later) needs a protocol path. Proposed: `unlock` with `add`, gated by a passkey approval where one is registered. In P1a, factors and passkeys are set at setup only.
- **Separate-user mode** (Q2) needs the installer and a throwaway container. It isn't built: P1a runs the broker as the same user, with the plain notice (`FILE_NOTICE`).
- **The `ws`, `web`, `stream`, `service` and `device` targets.** Binding one is refused with `wrong_target_kind`. A web sign-in can be *recorded* as a binding (migration keeps the host), but using it is refused until the relay exists.
- **Streamed (SSE) responses:** an `http` use buffers up to 4 MiB, as text. Binary bodies aren't carried.
- **macOS Touch ID gating** of the keychain item: the `security` CLI can't set an access control that requires biometrics. Where WebAuthn works, the passkey PRF factor is the biometric path.

## 5. Limits, said plainly

- **Peer credentials.** Node's standard library doesn't expose `SO_PEERCRED`.
  - A process running as the same OS account that obtains core's token can speak as core. It can make only core's uses: bound targets, scopes, consents, rate caps.
  - Such a process can also redeem a run ticket it obtains (a ticket is a bearer token for 60 seconds). A redemption twice is refused and recorded as an alarm.
  - This is the ADR's stated hardening step: a small native helper, not in Phase 1.
- **Same-user mode.** Any program running as the person can read the broker's folder, its device key file (where no keychain answers), and its memory. The ADR's threat model says so, and so does Settings' notice.
- **An old header with the person's passphrase.**
  - A copy of the header from before a delete, together with the person's own passphrase or recovery key, still opens the items that copy held. The test `a deleted item doesn't open from an older copy` shows this.
  - That is why no header ever goes into a backup, and why the outbox carries no factor wrap.
  - Device keys are renewed on a delete, so a stale header doesn't open with this device's key.
- **Rollback within a generation.** Restoring an item's older file, written under the current root key, would be opened as that older version. Swaps between items, and copies from before a delete, are refused.
- **The launcher.** It hashes a program and then starts it by path, so a binary swapped between the two runs with the credential. A program's folder should be writable only by an administrator.
- **JavaScript strings.** Values are kept in `Buffer`s and zeroed where the code holds them, but a value that becomes a JS string (a header, the scrubber's forms) stays in the broker's heap until it is collected. This is inside the broker, the one place the read capability exists.
- **Public TLS verification.** It uses Node's defaults (`rejectUnauthorized`, the bundled roots). No test reaches a public host, so it is exercised only for pinned LAN certificates and for refusals before TLS.
- **The first adoption trusts the first signer** (trust on first use). P1b's holder enrolment should show the hub broker's signing-key fingerprint on both devices' cards. A holder can't detect items dropped from, or rolled back in, the hub's outbox within one generation.
- **What an approval covers.** A tier-2 approval covers one request's method and path for one task, which is what its card shows. It doesn't cover the request's headers or body, which core supplies and which carry no value.
- **Values shorter than 6 characters** aren't scrubbed (they would match ordinary text). Generated values are 16 to 128 characters; a short sealed value (a PIN) is a stated limit.
- **Windows** (named pipe, Credential Locker) is untested on real Windows, as `vault.ts` is today.
- **The heap test** proves values aren't in core's heap *when the snapshot is taken*. The core stand-in keeps everything it received until then, so a value that passed through it would still be found. A positive control (core's own token) shows the search works.

## 6. Core files this PR changes, and why

Each change is unavoidable once a `broker/` folder can exist in a home. Each is one line, inert until it exists.

| File | Change | Why it can't wait for the wiring |
|---|---|---|
| `src/core/resilience/backup.ts` | Only `broker/items/` goes into a backup; the header, wraps, device key, socket and audit log never do. Also an `EXCLUDED` line | The moment the broker writes its folder, a nightly backup would carry the device key file (Decision 5) |
| `src/home.js` | `broker/` untracked in the home's git | The home's git would keep a copy of the device key, for good |
| `src/core/mesh/sync.ts` | `broker` not journalled as files | The sync journal would carry the header and key file to the standby in a form it could use |

The broker's folder isn't in `NOVA_ENTRIES` (`resilience/entries.ts`), so checkpoints leave it alone. A checkpoint restore can't bring back a deleted item.

## 7. Questions for the owner

1. **Q6's reveal:** the terminal launcher gated by the passphrase, or a native helper gated by biometrics (§4)?
2. **The size budget.** P1a uses 2,520 of the 3,000 lines. The browser relay (CDP pass-through, origin checks, scrubbing every message) is the larger part of P1b. Raise the budget to about 3,500 for Phase 1, or have the relay live in the launcher's own file and count it?
3. **Adding factors after setup** (§4): `unlock` with `add`, gated by a passkey where one is registered?

## 8. The tests

| File | Covers |
|---|---|
| `broker-store.test.ts` | Argon2id: RFC 9106's test vector and the floor. Every factor opens the vault, and a wrong one doesn't. Tamper, swap and move. A delete against an older copy. A rotation cut short. Holder sync. Sealed entry |
| `broker-verbs.test.ts` | Each verb and its refusals; non-bound origins when core asks with a valid approval; redirects; scope; tiers and classes; approvals missing, replayed, mismatched or expired; rate and flood; update and rotate; bind with lookalike flags; passkeys; share_scope; n8n; unlock |
| `broker-ipc.test.ts` | The process (permission model, empty environment, file modes, no inet socket); the protocol and fuzzed verbs; no inet listener after any verb; a schema check over every answer; the launcher against the wrong binary |
| `broker-egress.test.ts` | Private-address and loopback rules; a pinned LAN certificate, the right one and the wrong one |
| `broker-canary.test.ts` | Canaries through every built path, searched in core's heap, the answers, the audit log, the broker's own output and folder, the backup set, the diagnostics bundle (#259) and the launcher's output. Migration resuming |
| `broker-boundary.test.ts` | Imports, the size budget, no listener in the source, the fixed lists, the client's methods |

## NOTES for Track 1

Proposed patches for Track 1 to apply. Nothing below is applied by this PR.

**1. Starting the broker** (`src/supervisor/supervisor.ts`; P1b).
- Start the broker as a second child, before the Nova server, with `startBroker(join(home, 'broker'), { keyMode })` from `src/broker/spawn.ts`.
- `keyMode` is `'file'` when `NOVA_VAULT_KEY=file`, and under the test runner.
- Use the same restart backoff the server child has. Three crashes in a minute mean safe mode: credentialed actions refuse with "Nova's vault isn't running", and Health shows it.
- Give core its token (`started.tokens.core`) over core's own IPC channel, never on argv or in the environment:
  ```js
  serverChild.send({ broker: { socket: started.socket, token: started.tokens.core } });
  ```
- The supervisor keeps `tokens.supervisor` for its health checks (`list_refs`, `lock`).

**2. Core's wiring** (`src/core/index.ts`, `src/server.js`; P1b).
- Take `{ socket, token }` from the IPC message, and build `new BrokerClient({ socket, token })` (`src/core/broker/client.ts`).
- Set `client.onRecord` to copy each record into the Work Ledger under its task. Health shows a gap in `seq`.
- **At boot, before `new Vault(...)`:** when `vault/secrets.json` exists, and the broker says its vault exists and is unlocked, run `migrateStage(home)`, then `migrateCommit()`, then `migrateFinish(home, ticket)`. Only then construct `Vault` (it holds Nova's own keys only from then on).
- Then raise one approval card with `migratePropose(...)`, with proposals from configuration core already holds:
  - a provider's `base_url`;
  - Home Assistant's address;
  - a network target's URL;
  - a sign-in's host.
- **Consumers, in P1b**, each replacing a `vault.get`:
  - `providerSecret` and `providers/openai.ts`: `use` on an `http` target;
  - n8n: `sign` and `verify`;
  - `connectors/index.ts`: `ctx.secrets.get` goes, and connectors call `use`;
  - `capture/screenpipe.ts`: `http`;
  - `network/index.ts`: `http` with `pin`;
  - `infra/index.ts`: `process` through `client.launch`.
- `NOVA_SECRET_<NAME>` is refused when the broker is on.
- Remove `wireIngest`'s `secrets` list, and `addSecretValue` for broker values. Core keeps its key-name rules.

**3. A factory reset** (`src/core/resilience/reset.ts`; required before the broker is started in any home).
- The broker's folder isn't one of `NOVA_ENTRIES`, so today a reset would leave `broker/` and its device key behind.
- Proposed: the reset stops the broker (supervisor), then removes `broker/`, and removes the keychain item `nova-broker / device-<id>` (id from `broker/device.json`). The broker's `Store.forget()` does the same from inside the broker.

**4. Diagnostics** (`src/core/diagnostics/index.ts`; P1b).
- Once the switch lands, `knownSecrets` loses `core.vault.get` for credentials.
- The bundle's `vault` section takes `list_refs`' state: locked, unlock mode, approval mode, item counts by kind, problem.
- `tests/core/broker-canary.test.ts` already builds a bundle on a home with a broker, and finds no canary.

**5. The console's sealed entry** (shared UI; P1b).
- Serve `src/broker/seal.ts`'s two functions to the console as a module (it is WebCrypto only), and seal every value field with it: `PUT /vault/{name}`, the provider key, the connector `secret: true` fields, capture's `api_key`, Gmail's fields, the network token, the infra secret.
- The routes then take an envelope, and refuse plaintext once the broker is on.

**6. `package.json`:** nothing. The tests are in `tests/core/`.

**7. Migrations (schema):** none. The broker keeps no rows in `nova.db`.

**8. `docs/LEDGER.md`,** a new entry at the top of "## Decisions":

> **2026-11-01 (Track 3: Vault broker Phase 1, PR 1 of 3).** Branch `vault/broker-phase1`. The Credential Broker is built as its own process in `src/broker/`, imports nothing from core, uses Node's standard library only, and is 2,520 lines. It answers the seven fixed verbs and `hello`/`unlock`/`lock`, with two launcher-only messages.
> - **Nova Vault:** Argon2id from `node:crypto` (RFC 9106's floor), per-item AES-256-GCM, every factor an X25519 key pair, and a root-key rotation on delete. Holder sync carries device wraps and ciphertext only, and backups carry item blobs only.
> - **Its own authority:** exact origin binding, scopes, classes, standing consent, approvals (core-relayed, or a WebAuthn passkey) and rate caps. A hash-chained audit log, and ledger records with ref, target and outcome.
> - **Core's side:** the client returns no value. Migration from `vault.ts` goes through the broker's launcher, and core never opens the old vault.
> - **Canaries** are found in no answer, log, file, backup, bundle or core heap.
> - Core's switch to the client and the browser relay are PR 2; the full gate and the adversarial review are PR 3.

**9. `docs/builder-packet/ROADMAP-AND-GATES.md`,** under "Nova Vault and the Credential Broker", Phase 1: add "P1a built (PR, 2026-11-01): the broker, Nova Vault, fixed verbs and IPC; P1b and P1c to follow."

**10. `CAPABILITY-INVENTORY.md`,** the Secrets row: "**Building (2026-11-01):** the Credential Broker's process and Nova Vault exist (`src/broker/`). Core doesn't use them yet; it still reads `vault.ts` until P1b."
