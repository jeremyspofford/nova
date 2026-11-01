# Vault broker, Phase 1: the build plan (Track 3)

**Sources:** the ADR, `docs/plans/vault-broker.md` (binding, with its Owner decisions); the owner's text in `docs/builder-packet/nova-vault-broker-design-2026-10-31.md`, `INPUT-2026-10-31-VAULT-BROKER-INSTRUCTION.md` and `INPUT-2026-10-31-VAULT-BROKER-DECISIONS.md`.

**Status:** P1a (this PR) is built, and revised after its first adversarial review (§9). P1b and P1c aren't.

The honest-claims rule governs this document: within Nova, the capability to read a credential's value exists only inside the broker (its process, and the launcher it starts itself for a program it hands a credential to). Nothing here says more than that.

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

`src/broker/` is 2,666 lines, under the ADR's budget of 3,000. That leaves 334 lines for P1b's relay, which is tight (§7).

| File | What it is |
|---|---|
| `protocol.ts` | The fixed lists: seven verbs, three protocol messages, nine refusals, seven protocol errors. Nothing else is answered. Also the frame parser (id, size cap, unknown fields refused) and the answer schema (`ANSWER_KEYS`, `checkAnswer`) |
| `crypto.ts` | Node's standard library only: AES-256-GCM with associated data; Argon2id (`crypto.argon2Sync`), with RFC 9106's second setting as the floor; X25519 factor keys; P-256 sealed entry |
| `seal.ts` | The person's side of sealed entry, in WebCrypto, so it runs in a browser or in Node |
| `store.ts` | Nova Vault's store: the header, per-item blobs, root-key rotation on delete (finished at the next unlock if cut short), holders, the outbox, and adoption on a holder |
| `keystore.ts` | The device key's OS key store (vault.ts's CLIs, ported), or a 0600 file with the plain notice |
| `origin.ts` | Canonical targets, exact matching, request paths and scopes, lookalike flags, address classes, the class suggestion |
| `policy.ts` | Approvals (core-relayed, or a WebAuthn ES256 passkey that also signs a sealed envelope's hash), flood control, rate caps, generated values |
| `audit.ts` | The hash-chained audit log |
| `scrub.ts` | Exact-value scrubbing of what a target sent back, in eleven forms, for text and for streams |
| `http.ts` | The only outbound path |
| `broker.ts` | The verbs |
| `server.ts` | The socket, frames, tokens, a hello deadline, and the schema check of every answer |
| `main.ts`, `spawn.ts` | The process, and its hardened start |
| `launch.ts`, `oldvault.ts` | The launcher, which the broker starts as its own child for each job (run a program, read the old vault, take what moved out of it), and the old vault's format |

**Core's side:**
- `src/core/broker/client.ts`, whose methods return no value;
- one-line safety entries for `broker/` in five core files (§6).

**Tests** live in `tests/core/broker-*.test.ts`, so `npm test` runs them with no change to `package.json`. There are 45 tests in 7 files, and §8 lists them.

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
3. **The migration runs in three steps, so core never opens the old vault, and no answer depends on a value core chose:**
   - **stage:** the broker starts its own launcher on the broker's own home (core names no folder). The launcher reads `vault.ts`'s file and key and Era 2's Gmail files, and hands them to the broker by pipe. The answer is a count.
   - **commit** (tier 3, one card of names and kinds):
     - each entry whose name is free becomes an *unbound* item (usable nowhere), marked as migrated from that old vault, and is read back from disk;
     - a name already held by an item migrated from the same old vault counts as moved, so a resumed run finishes;
     - a name held by any other item stays in the old vault;
     - neither rule looks at a value;
     - then the launcher takes what moved out of the old vault.
   - **propose** (tier 3): one card of bindings and classes, metadata only.
4. **Nova's own keys stay in `vault.ts`** (§9 row 15). The old file holds them beside the credentials, so after the move it is rewritten without the moved names, under a new key. It is deleted with its key only when nothing is left. The ADR said "the old file is deleted"; with row 15, it can't always be. Nova's own names are listed in `OWN_KEYS` (`oldvault.ts`) and mirrored in the client (`isOwnKey`).
5. **The broker starts its launcher itself, and nothing on the socket redeems or stages** (review B1, B2). The ADR's flow had core start the launcher with a ticket, but a ticket core holds is a ticket core can redeem.
   - For a `process` use, the broker starts the launcher and hands it the value over a pipe.
   - The launcher hashes the binary, runs the program, scrubs its output and exits with its code.
   - The answer to core is that exit code and that output, up to 4 MiB each, after the program ends.
   - Core supplies the arguments, a working folder, stdin, a time limit, and environment variables from a narrow allow-list. The allow-list holds no loader, interpreter or config-path variables (`LD_PRELOAD`, `NODE_OPTIONS`, `TF_CLI_CONFIG_FILE`…); `PATH` and `HOME` are the launcher's own.
   - Node carries the broker's permission model into the launcher (it writes the flags into a child's `NODE_OPTIONS`). Each job adds exactly what it needs: to read the program file and write under `broker/run/`, or to read (and, to finish, write) `vault/` and `connectors/`.
   - The program is started through `env -u NODE_OPTIONS`, so it runs as itself.
6. **An unlock factor is sealed to `sha256(vault id | factor | the broker's boot id)`.** A captured envelope dies with the boot. The ADR left an unlock's binding unstated.
7. **`class_policy` is used for one case:** a standing consent on a sensitive credential is refused. Sensitive uses always ask, once per task, or on every use with `per_use`.
8. **`verify` is an `http` binding's injection mode,** on n8n's origin. It needs no network: the answer is valid or not.
9. **The other refusals are protocol errors, not refusals:** an unknown verb, an unknown field, a bad frame, and a frame too large (`ERRORS` in `protocol.ts`). The ADR's refusal list covers verbs.
10. **Approvals:**
    - a passkey signs `sha256(approval id | digest | sha256(envelope))`, so one approval can't be replayed onto another, and core can't swap its own value in for the one the person's client sealed;
    - once any passkey is registered, every tier-3 verb needs it, and so does a sensitive-class use. This is stricter than Q4, which named `bind` and `share_scope`;
    - otherwise approvals are core-relayed. The vault's state says which mode is active (`approval_mode`), for Settings.
11. **A rotation's `abandon` takes no approval,** because it narrows. `begin` and `commit` are tier 3.
12. **A holder adopts only a header its pinned hub signed** (review B4).
    - The hub's broker signs the outbox header with an Ed25519 key of its own (`sign-<id>`, kept beside the device key and stable across its renewals).
    - A vault made on a device never adopts another.
    - A device becomes a holder only after `share_scope` with `hub` (tier 3) pins the hub's signing key, before it holds any vault.
    - From then on it adopts only that signer's headers, for that vault id, at a strictly newer generation.
    - Items need no signature of their own: each is authenticated under the root key.
13. **No text core sent comes back, and answers aren't scrubbed as a whole** (review B3).
    - Scrubbing core's own text told core whether it had guessed a value. The broker now never echoes a frame's text in `words`, and cards carry no task title or caller.
    - Only what a target sent back (a response, a program's output) is scrubbed, and only of the value that use injected (with basic auth's `user:value`).
14. **Health flags answer no guess** (review B5).
    - `reused` is worked out only among values core couldn't have chosen: generated, migrated by the launcher, or sealed under a passkey approval. Each item records where its value came from (`provenance`).
    - There is no `weak` flag in answers: it gave away a length band and character classes.
15. **A revocation re-keys the vault** (review S5): a binding removed, a consent withdrawn, or details changed. An item file rolled back to before it then doesn't open.

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
  - Nothing on the socket hands out a value, a ticket or a staging slot.
  - This is the ADR's stated hardening step: a small native helper, not in Phase 1.
- **An echoing target is an oracle.** A target that echoes text core sent it lets core, by seeing whether the echo comes back scrubbed, confirm a guess about the value that use injected. This is bounded by the rate caps, and matters only for a low-entropy value. Generated values aren't guessable.
- **Authenticated verification is also an oracle (owner finding SEC-06).** The `verify` injection mode returns whether the supplied body/signature pair matches the held HMAC key. A caller with the authenticated core role can therefore test a guessed key locally, without an echoing target. This is an explicit exception to the no-guess-oracle claim, required by the bound n8n callback verification operation; no HMAC or key bytes are returned. An exact bound origin is required, although verification sends no network request. Standard credentials need a standing consent or a tier-2 approval covering `VERIFY` for the task; sensitive credentials always ask first and require a registered passkey when available. `per_use` asks on every call. A task grant covers further body/signature pairs for that ref, origin and version in that task; it does not bind one body or one signature. Standing consent is rate-capped (default 600/hour, configured 1–3,600/hour), and all uses including verification share the hard cap of 3,600/hour per ref. Approval requests are capped at three pending per task and 30/hour, with five-minute single-use approvals. These bounds slow guessing; they do not make low-entropy keys safe. Use generated high-entropy signing keys.
- **A program does what its inputs say.** Its arguments, working folder and project files are core's, and a program steered by them can send its credential elsewhere. The approval card shows the arguments; a standing consent covers any.
- **Same-user mode.** Any program running as the person can read the broker's folder, its device key file (where no keychain answers), and its memory. The ADR's threat model says so, and so does Settings' notice.
- **An old header with the person's passphrase.**
  - A copy of the header from before a delete, together with the person's own passphrase or recovery key, still opens the items that copy held. The test `a deleted item doesn't open from an older copy` shows this.
  - That is why no header ever goes into a backup, and why the outbox carries no factor wrap.
  - This device's own key is renewed on a delete, so a stale header doesn't open with it.
  - A holder's key isn't renewed (review S6). A holder that kept an older header can open, with its own key, what that header held.
  - So a delete makes older copies of the *item files* (a backup, a stale sync entry) unopenable; it doesn't revoke what another holder already received.
- **Rollback.** A revocation and a delete re-key the vault, so an older item file doesn't open after either. A file-system attacker who rolls back the header and the items together restores the whole older state (same-user mode).
- **The launcher.** It hashes a program and then starts it by path, so a binary swapped between the two runs with the credential. A program's folder should be writable only by an administrator.
- **Checkpoints** (review S4). Checkpoints taken before the migration copied `vault/` with its key file, and `connectors/` with Era 2's files. They keep the old entries until they age out (NOTES 11).
- **Node's permission model doesn't stop a child.** The broker needs `--allow-child-process` for its launcher and the keychain CLIs. So the file-system narrowing is defence in depth against a bug in the broker, not a wall against code that runs as it.
- **JavaScript strings.** Values are kept in `Buffer`s and zeroed where the code holds them, but a value that becomes a JS string (a header, the scrubber's forms) stays in the broker's heap until it is collected. This is inside the broker, the one place the read capability exists.
- **Public TLS verification.** It uses Node's defaults (`rejectUnauthorized`, the bundled roots). No test reaches a public host, so it is exercised only for pinned LAN certificates and for refusals before TLS.
- **The first adoption trusts the first signer** (trust on first use). P1b's holder enrolment should show the hub broker's signing-key fingerprint on both devices' cards. A holder can't detect items dropped from, or rolled back in, the hub's outbox within one generation.
- **What an approval covers.** A tier-2 approval covers one request's method and path for one task, which is what its card shows. It doesn't cover the request's headers or body, which core supplies and which carry no value.
- **The scrubber's forms.** Values shorter than 6 characters aren't scrubbed (they would match ordinary text). Generated values are 16 to 128 characters; a short sealed value (a PIN) is a stated limit. The forms are eleven: raw, base64 padded and not, base64url, hex in both cases, URL-encoded in both cases, form-encoded, JSON-escaped, and JSON with `\/`. HTML entities, UTF-16 and other encodings a target might use aren't caught.
- **Windows** (named pipe, Credential Locker) is untested on real Windows, as `vault.ts` is today.
- **The heap test** proves values aren't in core's heap *when the snapshot is taken*. The core stand-in keeps everything it received until then, so a value that passed through it would still be found. A positive control (core's own token) shows the search works.

## 6. Core files this PR changes, and why

Each change is unavoidable once a `broker/` folder can exist in a home. Each is one line, inert until it exists. None is one of Track 1's hot files.

| File | Change | Why it can't wait for the wiring |
|---|---|---|
| `src/core/resilience/backup.ts` | Only `broker/items/` goes into a backup; the header, wraps, device key, socket and audit log never do. Also an `EXCLUDED` line | The moment the broker writes its folder, a nightly backup would carry the device key file (Decision 5) |
| `src/home.js` | `broker/` untracked in the home's git | The home's git would keep a copy of the device key, for good |
| `src/core/mesh/sync.ts` | `broker` not journalled as files | The sync journal would carry the header and key file to the standby in a form it could use |
| `src/home.js` (`SECRET_DIRS`) | `broker` added (review S2) | Model file tools (`tools.js`, `helpers.js`, `runner.js`) could read the broker's folder |
| `src/core/resilience/entries.ts` | `broker` one of Nova's own entries (review S3) | A factory reset would leave the folder and its device key behind |
| `src/core/resilience/checkpoints.ts` | `broker` in `SKIP_TOP` (review S3) | Without it, being one of Nova's entries would put the store into checkpoints, and a restore could bring back a deleted credential |

## 7. Questions for the owner

1. **Q6's reveal:** the terminal launcher gated by the passphrase, or a native helper gated by biometrics (§4)?
2. **The size budget.** P1a uses 2,666 of the 3,000 lines. The browser relay (CDP pass-through, origin checks, scrubbing every message) is the larger part of P1b. Raise the budget to about 3,500 for Phase 1, or have the relay live in the launcher's own file and count it?
3. **Adding factors after setup** (§4): `unlock` with `add`, gated by a passkey where one is registered?

## 8. The tests

| File | Covers |
|---|---|
| `broker-store.test.ts` | Argon2id: RFC 9106's test vector and the floor. Every factor opens the vault, and a wrong one doesn't. Tamper, swap and move. A delete against an older copy. A rotation cut short. Holder sync. Sealed entry |
| `broker-verbs.test.ts` | Each verb and its refusals; non-bound origins when core asks with a valid approval; redirects; scope; tiers and classes; approvals missing, replayed, mismatched or expired; rate and flood; update and rotate; bind with lookalike flags; passkeys; share_scope; n8n; unlock |
| `broker-ipc.test.ts` | The process (permission model, empty environment, file modes, no inet socket); the protocol and fuzzed verbs; no inet listener after any verb; a schema check over every answer; the launcher against the wrong binary |
| `broker-egress.test.ts` | Private-address and loopback rules; a pinned LAN certificate, the right one and the wrong one |
| `broker-review-1.test.ts` | Each finding of the first adversarial review, as a test that failed on `0b7457da` (§9) |
| `broker-canary.test.ts` | Canaries through every built path, searched in core's heap, the answers, the audit log, the broker's own output and folder, the backup set, the diagnostics bundle (#259) and the launcher's output. Migration resuming |
| `broker-boundary.test.ts` | Imports, the size budget, no listener in the source, the fixed lists, the client's methods |

## 9. The first adversarial review (of `0b7457da`)

Each finding was reproduced as a test first, in `tests/core/broker-review-1.test.ts`.

| Finding | What was wrong | The fix |
|---|---|---|
| B1 | Core held a run ticket, and any process could redeem it for the value | The broker starts its launcher and hands it the value by pipe. No ticket, no `redeem` |
| B2 | Staging from any connection; commit without approval; per-name value comparison; a folder core chose | The broker reads its own home only, by its own launcher. Commit is tier 3. Resume goes by metadata, never a value |
| B3 | Caller text echoed, then scrubbed, so it answered a guess | No echo, no answer-wide scrub. Cards carry no task title or caller |
| B4 | A hub adopted a planted inbox signed by any key | A local vault never adopts. A holder adopts only after a tier-3 pin, and only a strictly newer generation |
| B5 | `reused` and `weak` answered guesses | Reuse only among values core couldn't choose (provenance). `weak` gone. The passkey signs the envelope |
| S1 | Basic auth's `user:pass`, and the 4 MiB cut | Scrubbed, and the cut's tail dropped. Lowercase `%xx`, `+` and `\/` added; the rest are limits (§5) |
| S2 | File tools could read `broker/` | `SECRET_DIRS` |
| S3 | A reset left `broker/` behind | One of Nova's entries, and skipped by checkpoints |
| S4 | Checkpoints keep the old vault and Era 2 files | A limit, and NOTES 11 |
| S5 | A rolled-back item file undid a revocation | Revocations re-key the vault |
| S6 | Delete overstated with holders | The claim is narrowed (§5) |
| Minor | Passkey for update and class changes; `..;`; private ranges; hello timeout; staging cap; grants on change; child-process narrowing; parse errors | Fixed, or a stated limit: child processes |

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
- **At boot, before `new Vault(...)`:** when `vault/secrets.json` exists, and the broker says its vault exists and is unlocked:
  - run `migrateStage()`;
  - raise its tier-3 card with `migrateCommit()`;
  - when the person approves, the broker moves the items and takes them out of the old vault itself.

  Core passes no folder: the broker reads its own home. Until the commit is approved, construct no `Vault` that holds credentials; afterwards `Vault` holds Nova's own keys only.
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
  - `infra/index.ts`: `use` on a `process` target. The broker runs the program and answers with its exit code and its scrubbed output, so core passes `argv`, `cwd`, `stdin`, `timeout_ms` and allow-listed `env` (`TF_VAR_*`, `TF_IN_AUTOMATION`, `TF_INPUT`, locale, `TZ`, `TERM`, `NO_COLOR`).
- `NOVA_SECRET_<NAME>` is refused when the broker is on.
- Remove `wireIngest`'s `secrets` list, and `addSecretValue` for broker values. Core keeps its key-name rules.

**3. A factory reset** (`src/core/resilience/reset.ts`; required before the broker runs in a home with a keychain).
- `broker/` is now one of Nova's own entries (this PR), so a reset removes the folder, and with it a file-held device key.
- Still owed: the reset stops the broker first (supervisor), and removes the keychain items `nova-broker / device-<id>` and `sign-<id>` (id from `broker/device.json`). The broker's `Store.forget()` does the same from inside the broker.

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

> **2026-11-01 (Track 3: Vault broker Phase 1, PR 1 of 3).** Branch `vault/broker-phase1`. The Credential Broker is built as its own process in `src/broker/`, imports nothing from core, uses Node's standard library only, and is 2,666 lines. It answers the seven fixed verbs and `hello`/`unlock`/`lock`, and nothing else. It starts its own launcher for programs and for reading the old vault.
> - **Nova Vault:** Argon2id from `node:crypto` (RFC 9106's floor), per-item AES-256-GCM, every factor an X25519 key pair, and a root-key rotation on delete. Holder sync carries device wraps and ciphertext only, and backups carry item blobs only.
> - **Its own authority:** exact origin binding, scopes, classes, standing consent, approvals (core-relayed, or a WebAuthn passkey) and rate caps. A hash-chained audit log, and ledger records with ref, target and outcome.
> - **Core's side:** the client returns no value. Migration from `vault.ts` goes through the broker's launcher, and core never opens the old vault.
> - **The first adversarial review** (five blocking findings: a redeemable ticket, the migration's oracles, scrubbed echoes, a hub adopting a planted inbox, and guessable health flags) was fixed, each with a failing test first.
> - **Canaries** are found in no answer, log, file, backup, bundle or core heap.
> - Core's switch to the client and the browser relay are PR 2; the full gate and the adversarial review are PR 3.

**9. `docs/builder-packet/ROADMAP-AND-GATES.md`,** under "Nova Vault and the Credential Broker", Phase 1: add "P1a built (PR, 2026-11-01): the broker, Nova Vault, fixed verbs and IPC; P1b and P1c to follow."

**10. `CAPABILITY-INVENTORY.md`,** the Secrets row: "**Building (2026-11-01):** the Credential Broker's process and Nova Vault exist (`src/broker/`). Core doesn't use them yet; it still reads `vault.ts` until P1b."

**11. Checkpoints after the migration** (`src/core/resilience/checkpoints.ts`; review S4).
- Checkpoints copy `vault/` with its key file, and `connectors/`. Those taken before the migration still hold the moved credentials, in the old vault under its old key, and Era 2's Gmail files.
- Proposed:
  - at the migration's commit, core deletes the checkpoints taken before it, or rewrites each copy's `vault/` the way the launcher rewrites the live one, and updates the manifest;
  - `connectors/gmail/` leaves every copy.
- Owed with the wiring.

**12. The client's API changed in this revision.** `launch()` and `migrateFinish()` are gone, and `migrateStage()` takes no folder. `use` on a `process` target returns `{ exit, stdout, stderr, truncated }` and takes no ticket.
