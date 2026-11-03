# Vault broker, Phase1: current gate and historical evidence

**Current source:** `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Tasks1–6 accepted, owner B RECEIVED and source fixes independently reviewed. [Self-contained actual source/claims/threat-model packet](../reviews/vault-broker-phase1-review-packet.md), [all12 B dispositions](vault-owner-findings-b-2026-11-03/b-mapping.md), [Task7 exact commands/raw/provenance](vault-owner-findings-b-2026-11-03/task-7-report.md).

**Global C1 is NOT met across running Nova.** It remains the full Phase1 acceptance requirement. Core still handles legacy credential values and app forms are plaintext until P1b; no module-only canary, heap snapshot, metadata route or browser helper proves a whole-product cutover. P1b/P1c are unbuilt/unproven. No full Phase1, credentialed M10j/M10k, physical keychain, new app surface or universal OS containment claim follows.

Current impacted qualification was necessary because the broker spawn helper changed in Task6's final lifecycle fix while its focused77 checks omitted the broad A/B/legacy/canary/backup/mesh surfaces. This did not repeat the old119/77/UI suites. Check02 passed46/46 backup/recovery/sync/promotion and actual two-process drill; check04 naturally passed18/18 B3; check05 passed138 of139 with the one unchanged optional desktop-keychain skip (no secret-tool or desktop session). Check01 recorded68 individual passes and one B3 failure before an owned-container stop137; it is an incomplete failed attempt, not a successful suite/guard run. Canary+heap assertions are among its individual passes; there is no claim of a completed green broad qualification from01. Diagnostic03 passed1/1 only with force-exit and is diagnostic, not natural proof. Natural04 did not reproduce the initial failure: its cause remains **UNPROVEN**; a possible fixture abort is not a confirmed diagnosis. Ruling28 permits that one bounded natural run plus only never-reached files; ordinary full CI remains mandatory. No code/assertions/skips/timeouts were changed. Counts overlap and are not summed.

| Gate | Current broker/P1a evidence | Full Phase1 disposition |
|---|---|---|
| 1 no canary in answers/logs/records/files/backups/bundles/sync | `broker-canary.test.ts` individually passed in incomplete01, checking eight forms and synthetic broker/client/diagnostics/backup surfaces. Task6 metadata projection/exclusions have accepted combined49 evidence. | **Partial.** Actual Core consumer logs/memory/transcripts/receipts/Work Ledger/sync still use legacy values; no whole-product pass. |
| 2 no canary in Core heap | Separate client-only Core process retains all responses, actual v8 snapshot with positive controls; assertion passed inside failed01. | **Partial.** Live app heap after actual consumer flows remains P1b/P1c. |
| 3 non-bound origin refused | Verbs/origin/egress/approval controls in01/05; near misses, redirect and pinned loopback TLS checks. | Broker HTTP scope only; web framing/form/relay enforcement unbuilt P1b. |
| 4 broker policy authority | Natural05 A/B policy, sensitive/passkey/rate/replay/expiry/full input binding; approved Task5 proofs. | Broker proof; actual person-facing app approval flows/ledger wiring remain P1b. |
| 5 fixed protocol/no getter | Boundary and real IPC checks individually passed01; accepted Task6 boundary77 unchanged. Seven verbs+hello/unlock/lock; no raw getter/ticket/new listener. | Broker boundary proof; does not mean legacy Core has no read API. |
| 6 no inbound network surface | Source and actual socket/listener/target-refusal checks in01; egress/local TLS. All completed current runs' egress/tripwire logs empty. | Broker-only no-listener proof; same-user/child-process limitations remain, no universal OS containment. |
| 7 store/no escrow/rekey | Natural05 store and historical live-review fixes; AEAD/tamper/swap/delete/revocation/authenticated recovery and holder keys. | Broker store proof. S6 already-received holder material/old headers cannot be retracted. |
| 8 migration | Natural05 metadata epochs/equality-oracle controls; source inspection/rekey/captured snapshot assertions in01; no assertion weakening. | Broker migration proof under cooperating writers; Gmail quiescence/uncertainty limits. Actual Core boot barrier/cards/consumer switch unbuilt. |
| 9 backup/sync/promotion | Natural02 46/46 actual backup/recovery and legacy mesh/promotion/drill; natural05 store/adoption/legacy replication; accepted Task6 exclusions. | **Partial.** Broker outbox transport and promotion after actual P1b cutover remain unbuilt/unproven; legacy drill is not broker-enabled whole-product promotion proof. S4 old checkpoint copies remain. |
| 10 every consumer | HTTP/sign/verify/process module stand-ins; natural04 B3 lifetime/fake keychain context and05 A/B checks. | Actual provider streaming/SSE, connectors, WebSocket, Gmail OAuth, browser sign-ins, infra multi-values and holder transport remain P1b; no credentialed J/K proof. |
| 11 fresh-user/claims | No new UI/copy surface. Current source documentation explicitly stages claims. | Fresh-user/full product claims gate remains P1c; Health285 owner entry recognition pending. |
| 12 independent reviews/current packet | B received; all12 entries mapped; accepted Tasks1–6 reviews including Task6 I1/I2 closure; current complete source/hash manifest published. | Root Task7 scoped review then a fresh most-capable whole-code+new live adversarial seat still pending (Ruling27); existing tests are not that gate. |

P1a named NOTES: supervisor start/private IPC and joined lifetime, fixed-home marker-bound reset/key removal, SECRET_DIRS/git/journal/backup/checkpoint exclusion, production diagnostics metadata (required legacy scan failure503/no attachment), fixed person-only seal module and plain LEDGER/ROADMAP/inventory are applied. [Exact NOTE-by-NOTE mapping](../plans/vault-broker-phase1.md#notes-for-track-1). Module proof is not actual app form/consumer cutover. C18/C19 remain backend active/app Not shipped,51row282 mapping/historical70 gaps unchanged, Secrets partial.

Root gates remain unchecked: fresh Task7 spec/quality review, fresh final whole-code/live adversarial probes, ordinary exact-head all-required CI, same-PR final plain-language record, matched normal merge and authorized preview. Owner B is no longer missing; Q6/reveal/size/factors and Health285 approval are not inferred. [Rulings22–28 and costs](vault-owner-findings-b-2026-11-03/rulings-22-27.md).

## Historical qualification records (dates/source scopes retained)

**Sources:** the ADR, `docs/plans/vault-broker.md` (§10, "The Phase 1 gate"), and the build plan, `docs/plans/vault-broker-phase1.md`.

**Historical scope:** the following2026-11-01 record predates owner B/current integration. Read the current table above for status; these outcomes are not new44a8 executions.

**The run:** 2026-11-01 (UTC), on this machine (Linux 6.18, WSL2, Node 26.3.1).
- Temp folders came from `mkdtemp(os.tmpdir())`, with canaries only, the file key store only (no keychain was touched), and stand-ins on 127.0.0.1 only.
- No real vault, key file or secret on this machine was read.
- The no-Kubernetes tripwire was armed for every run.

## Historical takeover live review — B was pending at this checkpoint

Independent review pinned `8ca4b827` and verified all three test-first fixes at `3faa3463`; the coordinated branch merges main without rebasing. Final independent suite: 88 passed, one real-keychain skip, zero failed. The coordinator independently reran all six live synthetic probes, with the same passing outcomes. After merging M10h and resolving Nova-owned entries to retain both broker/ and capture/, disposable Docker verification passed 89 tests with one real-keychain skip (90 total), including all broker/legacy-vault tests and the existing M7 factory-reset browser flow. Typecheck and diff check passed. Broker/client/legacy-writer sources are byte-for-byte identical to independently reviewed `3faa3463`. Report: `docs/reviews/vault-independent-live-review-2026-11-01.md`; individual RED/GREEN records: `vault-proposal-policy-review-fixes.md`, `vault-migration-recovery-review-fix.md`, `vault-proposal-card-review-fix.md` in this directory.

S4 and S6 remain permitted, demonstrated deferrals: old checkpoints retain old credentials/keys, and revocation cannot retract already delivered holder material. Core consumers remain on the legacy vault; no live confidentiality cutover is claimed. At that historical checkpoint B was pending; it is now received, source fixes/named P1a NOTES accepted, and the current root final-review/CI gates above still apply.

## P1a: the broker, Nova Vault, fixed verbs and IPC

**The branch:** `vault/broker-phase1`, from main at `6d51c5d1`. **No migration:** the broker keeps no rows in `nova.db`.

### Suite

- **`npm run check`** (tokens, themes, typecheck, then `npm test` under the tripwire): `npm run check` at `94d7d007`: **1556 tests: 1540 pass, 3 fail, 13 skipped**. The three are the load-sensitive tests M10f's and M10g's evidence name: `tests/core/provider-guard.test.ts` › “a coding agent that changes more than Nova takes…” (the stand-in agent ended without a result), `tests/ingest/round2.test.js` N1b (timed out) and `tests/skills-api.test.js` › “the email summary…” (timed out). Run alone right after, the three files pass (31 of 31). None touches the broker. The closing-rule claims test passed in the run.
- **After the review's fixes,** `npm run check` at `7b86dac8` gave **1565 tests: 1550 pass, 2 fail, 13 skipped**. The two were `tests/acceptance/m6a-capture.test.ts` (its Screenpipe stand-in read as `unreachable`) and `tests/core/coding.test.ts` › “M10c gate…” (the preview command exited before it answered). Neither touches the broker. Run alone right after, both files pass (14 of 14). The closing-rule claims test passed.
- **The broker's own tests:** `node --test tests/core/broker-*.test.ts` gives **45 tests: 45 pass**, in about 8 seconds.

### Gate items, as far as P1a reaches

| # | Item | P1a's evidence | Left for |
|---|---|---|---|
| 1 | Canary values in no log, memory, transcript, ledger entry, receipt, bundle, backup plaintext or sync log | `broker-canary.test.ts`. The canaries came in four ways: sealed entry (a provider key, a connector token, an OAuth token, a network token, a Screenpipe key, an infra secret, a kubeconfig), a generated password, a rotated one, and four migrated from a `vault.ts` vault plus an Era 2 Gmail file. Each was searched for in eight forms in every answer core received (audit records included), the broker's audit log, its own stdout and stderr, every file in its folder, the backup set, Nova's diagnostics bundle (#259's test pointed at the vault) and the launcher's output: **zero hits** | P1b: core's own logs, memory, transcripts, receipts and sync log, once core uses the client |
| 2 | Core's heap holds no canary | The same test. Core is a separate process holding only `BrokerClient`, and it keeps everything it received until the snapshot. A `v8` heap snapshot (over 1 MB) was searched: **zero hits**. Positive controls: core's own token, and a username it was given, are both found by the same search | P1b, P1c: re-run after every consumer flow |
| 3 | Refusal against a non-bound origin, with core asking with a valid approval | `broker-verbs.test.ts`. With an approval made for a use at A, every near miss was refused `not_bound`: another port, `localhost` for `127.0.0.1`, `https` for `http`, a path in the origin, another loopback address; for a bank origin, a subdomain, a parent, a Cyrillic homograph, an extra label, another port, `http`, a trailing dot and a wildcard. B's stand-in saw **no connection**, and each record shows ref, target and `refused:not_bound`. A redirect from A to B came back as a 302, with B unreached | P1b: framing and form posting (`web`) |
| 4 | Policy on the broker's own authority | `broker-verbs.test.ts`. Approvals missing, replayed, made for another digest, expired or made up are refused. A consent at T doesn't cover T′ or out-of-scope requests. Sensitive uses ask once per task, and every time with `per_use`. A standing consent on a sensitive item is refused (`class_policy`). Rate caps, flood control (3 pending per task, then `rate` and a problem) and passkey approvals (wrong origin, wrong rpId, no user verification, another challenge, or a counter that went back: each refused) | Done |
| 5 | Fixed verbs | `broker-ipc.test.ts` and `broker-boundary.test.ts`. Seven verbs and three messages, and nothing else: `redeem` and `migrate_item` no longer exist. 69 fuzzed verb names, and unknown fields, are refused. A schema check over every answer type finds only allowed keys, and none that names a value | Done |
| 6 | No network surface | `broker-ipc.test.ts`. On Linux, `/proc` shows no inet socket at idle and no inet listener after every verb; a positive control sees the test's own stand-ins. A source check finds no HTTP server and no `listen` on a port: the one `listen` is on a socket path. A use aimed at an unbound host makes no connection. `broker-egress.test.ts` covers the private-address and loopback rules, and a pinned LAN certificate (the right one, and the wrong one, over which nothing is sent) | Done |
| 7 | The store | `broker-store.test.ts`. The Argon2id parameters are recorded, at or above RFC 9106's floor, and RFC 9106's test vector passes through `node:crypto`. A tampered item fails on its own, and a swapped or moved item is refused. A deleted item doesn't open from an older copy with this device's key: the stated limit is that it does with the person's own passphrase. Backups hold no header, wrap or key (`broker-canary.test.ts` scans the backup set for the device and signing keys, the passphrase and the recovery key) | Done |
| 8 | Migration | `broker-canary.test.ts`. From a `vault.ts` vault full of canaries: core's heap is clean; the old file keeps only Nova's own keys, under a new key; Era 2's file is gone. An interrupted run resumes, idempotent by name | Done |
| 9 | Sync and promotion | `broker-store.test.ts`. The standby opens the vault with its own wrap, and the outbox holds ciphertext and public keys only. Forged, re-signed and unsigned headers are refused, as is any header before the tier-3 pin. A hub never adopts (`broker-review-1.test.ts`, B4) | P1b: core's mesh sync carrying the outbox, and M10g's promotion drill re-run with the broker |
| 10 | Every consumer through stand-ins | The broker's side: a provider `Bearer`, a connector token, Screenpipe, a network token (pinned), n8n `sign` and `verify`, and OpenTofu-style programs through the launcher (env and file) | P1b: core's consumers, Home Assistant's WebSocket, Gmail OAuth, browser sign-ins and account steps |
| 11 | The fresh-user test and the claims check | The closing-rule claims test passes (the suite above). No user-facing sentence about the broker is added in P1a | P1c |
| 12 | The second-model review packet | `docs/reviews/vault-broker-phase1-review-packet.md`: the claims, the threat model and all of the broker's code | P1c: findings back from the owner |

### After the first adversarial review (of `0b7457da`)

Each finding was reproduced first, as a test in `tests/core/broker-review-1.test.ts`. Each failed on `0b7457da`, for the reason named, then passed after its fix.

| Finding | Test | On `0b7457da` | Now |
|---|---|---|---|
| B1 | `B1: no run ticket reaches core; the broker runs the program itself; a second socket can redeem nothing` | Failed: a ticket was in the answer | Pass |
| B2 | `B2: migration: the broker reads its own home only, commit is tier 3, and no answer depends on a value core chose` | Failed: a staging ticket reached core | Pass. The same answer and effect with the right guess and a wrong one, and the old entry under a name core took stays in the old vault |
| B3 | `B3: text core writes is never echoed or scrubbed: a held value in it gives the same answer as any other text` | Failed. Run through the real server; the in-process version passed, because the scrub lived in the server. The test was corrected to use the server | Pass, over seven frames |
| B4 | `B4: a hub never adopts a planted inbox; a holder adopts only after a tier-3 pin, and only a newer generation` | Failed: the hub's refs were replaced by the forger's | Pass |
| B5 | `B5: health flags answer no guess: reuse only among values core didn’t choose; no weak flag to core` | Failed | Pass |
| S1 | `S1: basic auth’s encoded user:pass, and a value cut by the size limit, are scrubbed` | Failed: `base64(user:pass)` came back | Pass |
| S2, S3 | `S2, S3: no file tool reads broker/; a factory reset removes it; checkpoints never copy it and a restore leaves it` | Fails: `SECRET_DIRS` had no `broker` (checked against the file at `0b7457da`) | Pass |
| S5 | `S5: rolling an item’s file back doesn’t bring back a revoked binding` | Failed: the old binding came back | Pass |
| Minor | ``M: passkey for every tier-3 verb once registered; `..;` paths; private address ranges; grants cleared on change`` | Failed: a class downgrade took a core approval | Pass |

**Stated, not fixed:**
- S4 (checkpoints hold the old vault): plan §5, and NOTES 11.
- S6 (delete with holders): C7 narrowed.
- The remaining scrubber encodings, and the echo oracle: plan §5.

Tests changed to match the fixes:
- the launcher test now runs a bound shell script, swaps it, and refuses loader variables;
- the canary test drives migration through the verbs and reads program output from `use`;
- the passkey test expects every tier-3 verb to need the passkey;
- the store's holder test pins first.

### On this OS

- **Node 26.3.1** provides `crypto.argon2` and `crypto.argon2Sync`. The broker uses them; nothing was added.
- **The broker runs under `--permission`.**
  - Reads are allowed for its code and its folder, writes for its folder, and network access is allowed.
  - Child processes are allowed, because the broker starts its own launcher.
  - It has no inspector, `--disable-sigusr1`, and an environment of `TZ` alone (beside Node's own IPC channel variables).
- **Node 26 carries the permission model into a child Node process.** It writes `--permission` and the grants into the child's `NODE_OPTIONS`, whatever environment the child is given. Measured here:
  - a child with no flags of its own couldn't read `/etc/hostname`;
  - a child given `--allow-fs-read` for it could.

  So each launcher job adds exactly the paths it needs. The program runs through `env -u NODE_OPTIONS`, and a bound shell script printed an empty `$NODE_OPTIONS`.
- **A folder that doesn't exist can't be granted.** `existsSync` inside it threw `ERR_ACCESS_DENIED` instead of returning false. The old-vault reader treats that as absent.
- **The socket** is `broker/run/broker.sock`, mode 0600, in a 0700 folder. The broker's folder is 0700.
- **The tokens** arrive over Node's IPC channel: neither the broker's `/proc/<pid>/cmdline` nor its environment holds them.
- **Peer credentials:** not available from Node's standard library. Who can connect rests on the socket's permissions, and who is calling on the tokens. The plan's limits say what that leaves.
