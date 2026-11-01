# Review packet: Nova's Credential Broker and Nova Vault, Phase 1 (part 1 of 3)

**For:** a second model (ChatGPT, Gemini) reviewing security-critical code, under the owner's standing pattern (OPERATING-RULES, "Second-model review").

**The artifact:**
- Nova's Credential Broker: the TypeScript in `src/broker/`, run by Node 26 with type stripping and no dependencies;
- the core client that talks to it, `src/core/broker/client.ts`;
- the cooperating legacy writer, `src/core/vault.ts`, needed for migration consistency.

**What's here:** the whole broker, client and cooperating legacy writer: 18 files and 3417 source lines, at the end of this document. The broker alone remains 2,681/3,000 lines under its boundary test's counting rule.

**Source snapshot:** `1f9977c6`, including owner findings A, all three independent live-review fixes, and current main through M10h. Broker sources match independently reviewed `3faa3463`. The coordinated branch merges main without rebasing. The previous reviewed packet remains available in git at `7b39b0c3`.

**Integration status:** this is unmerged P1a groundwork. The running app still reads the legacy vault; supervisor startup, consumer cutover, sealed console fields and the full canary gate remain the branch’s Track 1/P1b/P1c work. Descriptions of core using only the client refer to the isolated client harness and the intended cutover, not a completed live-app migration. The owner’s second findings set B is still outstanding; this packet and green tests do not satisfy that merge gate.

Independent live-review evidence is `docs/reviews/vault-independent-live-review-2026-11-01.md`: proposal revocation/rollback, interrupted legacy rekey recovery, and complete effective-binding approval cards/digests each have RED→GREEN tests. S4 pre-migration checkpoint retention and S6 already-received holder material were demonstrated and remain explicit deferrals, as permitted by the takeover brief.

**What comes back:** your findings go to the owner, who triages them like any review. A finding that reproduces gets a failing test first.

This document is self-contained: you need nothing else to review the code. Paths are in the repository `jeremyspofford/nova`, branch `vault/broker-phase1`.

**This version incorporates owner findings A and the completed independent live review.** An in-house adversarial review of the first (`0b7457da`) found five blocking problems:
- a run ticket core could redeem;
- the migration answering guesses and moving without approval;
- scrubbed echoes of core's own text;
- a hub adopting a planted inbox;
- guessable health flags.

They are fixed, each with a failing test first (`tests/core/broker-review-1.test.ts`). Please look hardest at whether the fixes hold.

## How to review

1. Read the claims (§2) and the threat model (§3). Each finding should name the claim it breaks.
2. Read the code (§8). Start with `protocol.ts`, `broker.ts` and `server.ts`: they are the trust boundary.
3. Attack it. §6 lists the questions we most want answered; don't stop at them.
4. Report each finding as:
   - an id;
   - its severity (critical, high, medium, low or note);
   - the claim it breaks;
   - the file and function;
   - a concrete reproduction (a frame sequence, a file change, a process action);
   - the smallest fix you would make.
5. Say plainly what you checked and found sound. "No finding" on a question is useful.

Don't report what §5 already states as a limit, unless you think the limit is worse than stated, or is wrongly called a limit.

## 1. What the artifact is

**Nova** is a personal agent: a local server ("core") that runs models, tools and connectors for one person, on their own devices.

**The requirement** (the owner's): Nova keeps credentials, and may use, create and update them with the person's permission. But no credential's *value* may reach core, any model, chat, memory, logs or the Work Ledger (Nova's task record).

**The broker** is a separate, minimal process on each device that holds credentials. Core talks to it over a local socket, with refs and metadata only.

```
person ── console (served by core) ──┐  sealed values, approvals (ciphertext through core)
models ── core: refs and metadata ───┼── local socket (0600) ──▶ broker ──▶ the bound target only
           supervisor (start, tokens)┘                              │  │
                                                                    │  └── store: item blobs (ciphertext)
                                       broker ──spawns, value by pipe──▶ launcher ──env/file──▶ program
```

**Processes:**
- **The broker** (`main.ts`): started by Nova's supervisor, never by core. It runs under Node's permission model, with reads limited to its code and its folder and writes to its folder. It has an empty environment, no inspector, and `--disable-sigusr1`. It listens only on a Unix socket.
- **The launcher** (`launch.ts`): broker code that the broker itself starts as a child, one per job, with its request on a pipe (file descriptor 3). It never touches the socket. It has three jobs:
  - start a program with a credential in its environment or in a 0600 file, scrubbing the program's output;
  - read the old vault in the broker's own home and hand it over (migrate);
  - take what moved out of the old vault (finish).

  Node carries the broker's permission model into the launcher, and each job adds exactly what it needs. The program runs through `env -u NODE_OPTIONS`, so it runs as itself.
- **Core:** holds only `BrokerClient`. A `process` use answers with the program's exit code and its scrubbed output.

**The protocol** (`protocol.ts`):
- newline-delimited JSON, one id per request, frames up to 2 MiB, unknown messages and fields refused;
- `hello` (a token in, a role out), `unlock` (a sealed factor), `lock`;
- seven verbs: `list_refs`, `use`, `create`, `update`, `rotate`, `bind`, `share_scope`;
- nothing else (every connection says hello with a token within 10 seconds);
- a fixed list of nine refusals.

Every answer is checked against an allow-list of keys (`ANSWER_KEYS`) before it is written. Text core sent is never echoed back, and answers aren't scrubbed as a whole. Only what a target sent back is scrubbed, of the value that use injected.

**Targets** (`origin.ts`): a binding ties one item to one target, and matching is exact on the canonical form.
- `http`: an origin (`https://` and a lowercase A-label host, with a port only when it isn't the default; `http` only for loopback), plus a scope of methods and path prefixes.
  - Injection is `bearer`, `basic`, a named `header`, an HMAC `sign`, or `verify` (checks a callback's HMAC, no network).
  - A LAN device needs a pinned certificate.
- `process`: an absolute path plus the binary's SHA-256. Injection is an env var, or a 0600 file whose path is in an env var.
- `web`, `ws`, `stream`, `service` and `device` are refused in this PR.

**Tiers:**

| Action | Tier |
|---|---|
| `list_refs` | 0 (silent) |
| `use`: a standard-class item inside its binding's standing consent | 1 (act and report) |
| `use`: outside the consent, or a sensitive-class item | 2 (ask first). The approval covers that task; with `per_use`, every use asks |
| `create`, `update`, `rotate` begin and commit, `bind` add, `share_scope` add, a migration's commit and proposal | 3 (explicit confirmation). With a passkey registered, the passkey is required for all of these, and for a sensitive use |
| `bind` remove, consent revoke, rotate abandon, holder remove | At once |
| A sensitive item with a standing consent | Refused (`class_policy`) |

**Owner findings A follow-up (2026-11-01):** SEC-01..05 were reproduced before fixes; the final owner suite passes 20/20. SEC-06's authenticated-verification exception and limits are explicit below; SEC-07 requested no change. The input is preserved verbatim in `docs/builder-packet/nova-vault-second-model-findings-2026-11-01-a.md`; commands, failures and migration limits are in `docs/reviews/vault-owner-findings-notes-2026-11-01.md`. The source excerpts below are regenerated from the fixed code. The independent adversarial review was interrupted by an automated safety filter and remains INCOMPLETE. The other model's findings are also outstanding. Neither gate is satisfied by this packet or by the regression tests.

## 2. The claims the code must uphold

The honest-claims rule: Nova never says "Nova can never read your passwords". It says exactly C1.

- **C1.** Within Nova, the capability to read a credential's value exists only inside the broker: the broker process, and the launcher the broker itself starts for a program it hands a credential to, or to read the old vault. (Phase 1 runs as the person's own OS account; see the threat model.)
- **C2.** A value leaves the broker only toward the bound target it is used on: a request to the bound origin, or a program's environment or file at spawn. No answer to core or the supervisor carries a value, a part of one, its length, any encoding of one, or a hash or HMAC of one.
  - No answer depends on whether text core sent equals a held value, except for two explicit, rate-capped oracles: a target that echoes core's text back, scrubbed (limit 2), and authenticated local HMAC verification (SEC-06 below). Neither exception permits returning the HMAC itself.
  - **SEC-06, authenticated verification:** the bound `verify` mode intentionally returns one boolean for the supplied body/signature pair and the held key, without making a target connection. This is a local guess oracle for an authenticated core caller. It needs standing consent for a standard credential or a tier-2 task approval; sensitive credentials ask first (registered passkey required where available), and `per_use` always asks. The task grant covers further body/signature pairs, not just one pair. The standing-consent cap defaults to 600/hour (configurable 1–3,600), and all verification/use calls share a hard 3,600/hour per-ref cap. Approval flood control permits three pending per task, 30/hour; approvals expire after five minutes and are single-use. Rate caps do not make a low-entropy signing key safe. The binding design includes n8n verification, so this documented exception preserves that operation. No signature or key is returned.
- **C3.** Origin binding is enforced by the broker, on what it computes itself. A credential bound to A is refused for B, even when the request comes from core with a valid token and a valid approval made for a use at A. B may be:
  - another host, a subdomain or parent of A, a homograph, or A with an extra label;
  - another port, or `http` instead of `https`;
  - a redirect target. Redirects aren't followed: a 3xx comes back as an outcome.
- **C4.** Policy is checked on the broker's own authority, never on a model's or core's say-so: binding, scope, class, standing consent, approval and rate cap.
  - An approval is single-use and expires in 5 minutes. It is bound to the digest of the exact action the broker is about to take.
  - A missing, replayed, mismatched or expired approval is refused.
  - Approval requests are flood-limited: 3 pending per task, and 30 an hour.
- **C5.** There is no network surface. Nothing listens except the local socket. The only outbound connections are made inside a `use`, to that use's bound origin:
  - TLS is verified, or pinned for a LAN device;
  - the address is resolved once;
  - a public name resolving to a private or loopback address is refused unless the binding is a pinned LAN device.
- **C6.** Audit records carry ref, target, outcome, tier, approval, task and role, never values, headers, bodies or query strings. The broker's audit log is hash-chained and 0600.
- **C7.** The store: Argon2id at RFC 9106's second setting or above; per-item AES-256-GCM; associated data that ties each blob to its vault, item, version and kind.
  - A tampered item fails on its own. A swapped or moved item is refused.
  - A deleted item doesn't open from an older copy of the *item files* (a backup, a stale sync entry): the root key rotates.
  - An older *header*, with the person's own factor or with a holder's unrenewed key, still opens what it held. Headers never leave holder devices.
  - A revocation (a binding removed, a consent withdrawn, details changed) also rotates the root key, so a rolled-back item file doesn't undo it.
- **C8.** No escrow:
  - Backups carry item blobs only, never the header, a wrap, a device key or a factor.
  - Sync to a holder carries ciphertext, device wraps sealed to each holder's own key, and factors' *public* keys. No passphrase, recovery or passkey wrap travels.
  - A vault made on a device never adopts another. A holder adopts only a header signed by the hub it was pinned to at tier 3, for the vault it holds, at a strictly newer generation.
- **C9.** The migration from today's vault (`vault.ts`) passes no value through core, and gives core no yes-or-no answer about a value.
  - The broker's launcher reads the broker's own home.
  - The commit is tier 3, and makes the items unbound.
  - Every item is read back before anything leaves the old vault. Nova's own keys stay in it.
  - Stage and finish cooperate with the updated legacy writer through an exclusive lock. Finish retains old entries if the staged snapshot changed; a cached writer refreshes under the same lock. Era 2 Gmail writers and older binaries require quiescence (limit 14).
  - A name already held is decided by metadata, never by comparing values.
- **C10.** The broker's code imports nothing from core and no package, and is at most 3,000 lines.

## 3. The threat model

**In scope:**
- **A model,** local or cloud, asking for a credential, echoing one, or spending one outside its binding or approval.
- **Prompt injection** in pages, mail, files or tool output. Inside a standing consent, injection can cause uses the person already allowed, each recorded. Outside it, injection can at worst raise an approval card the person declines.
- **Bugs in core.** A log line, an error, a receipt, a transcript, a memory write, a diagnostics bundle or a backup has no value to carry, because core is given none.
- **Core behaving as an adversary through the protocol.** It holds a valid core token and can relay "approvals" in core-relayed mode. It must still be unable to:
  - use a credential outside its bindings and scopes;
  - get a value back;
  - forge a passkey approval;
  - replace a holder's vault.
- **Storage elsewhere:** backups, the sync log, the home's git history and a cloud relay hold ciphertext. The keys that open it are never there.
- **A target's response** that echoes the credential: it is scrubbed before it reaches core.

**Out of scope, said plainly:**
- **A compromised OS account.** Code running as the person can read the broker's folder, its key file where no keychain answers, and its memory. This mode ("same-user") is the default in Phase 1. Separate-user mode, with the broker under its own OS account, is designed but not built.
- **The person's own factor,** and an unlocked holder device.
- **A compromised broker,** or the target itself: a bound site or program holds what it was given.
- **Values a target hands back on a path the broker doesn't carry** (a screenshot).
- **Phishing aimed at the person directly.**

## 4. The design, briefly

**The store** (`store.ts`): `<home>/broker/`, 0700.
- **`vault.json`:** the header. It holds:
  - the vault id, the Argon2id parameters and salt, and the root key's generation;
  - the root key sealed to each factor's X25519 public key (the wraps: `passphrase`, `recovery`, `passkey:<id>`, `device:<id>`);
  - holders and registered passkeys.
- **Items** (`items/<id>.json`): `{ v, id, gen, version, key, meta, value, pending? }`.
  - The item key is sealed under the root key, with the associated data `item-key|vid|id|version`.
  - The metadata is sealed under the root key: `item-meta|vid|id`.
  - The value is sealed under the item key: `item-value|vid|id|version|kind`.
- **Factors:**
  - the passphrase's X25519 private key is its Argon2id output;
  - a recovery key's and a passkey PRF output's go through HKDF;
  - a device's is random, and kept in the OS keychain or `device.key` (0600).

  Sealing the root key to a factor is an ephemeral X25519 exchange, then HKDF, then AES-GCM. So the broker can re-seal a new root key to every factor without being given any.
- **Delete:** the item's file goes. The root key rotates: `next` is written to the header, every item is re-wrapped, then the header is promoted, and an unlock finishes a rotation cut short. This device's unlock key is renewed.
- **Sync:**
  - `outbox/header.json` holds the device wraps and the factors' public keys, signed with the hub broker's Ed25519 key (`sign-<id>`).
  - A holder verifies the signature, pins the signer at its first adoption, opens its own device wrap, and seals the root key to the factors itself.
- **Sealed entry** (`seal.ts` in the person's client, and `openEnvelope` in the broker):
  - the broker has a per-boot P-256 entry key;
  - the client derives an ECDH key, then HKDF (salt: the action's digest), then AES-GCM (associated data: the digest);
  - for an approval, the digest is the approval's; for an unlock, it is `sha256(vault id | factor | boot id)`.
- **Health flags:** `reused` only among values with a provenance core couldn't choose (generated, migrated, sealed under a passkey). No `weak` flag in answers.
- **Approvals** (`policy.ts`):
  - the broker issues a challenge: an id, the digest of the canonical action (sorted-key JSON), an expiry, and single use;
  - the caller repeats the call with `{ id, digest, mode }`, and the broker recomputes the digest from the call it was given;
  - `passkey` mode verifies a WebAuthn ES256 assertion over `sha256(id | digest | sha256(envelope))`: the origin is one registered, the rpIdHash matches, user presence and verification are set, the counter is monotonic;
  - `core` mode is accepted only when no passkey is required.
- **Programs:** `use` on a `process` target makes the broker start its launcher with the value, the bound path and SHA-256, and the argv (also in a tier-2 approval's digest). It also passes a working folder, stdin, a time limit, and an allow-list of environment variables (no loader, interpreter or config paths). The launcher hashes the binary and refuses a mismatch.
- **Scrubbing** (`scrub.ts`):
  - only target-sent text: the value that use injected (and basic auth's `user:value`), in eleven forms: raw, base64 (padded and not), base64url, hex (both cases), URL-encoded (both cases), form-encoded, JSON-escaped, and JSON with `\/`;
  - a body cut at 4 MiB loses its tail too, so no prefix of a value is left;
  - values under 6 characters aren't hunted;
  - the launcher's output scrubber holds back a tail, so a value split across two chunks is still caught.

## 5. Stated limits (challenge them if you think they're worse than stated)

1. **No peer credentials.** Node's standard library exposes no `SO_PEERCRED`, so a same-user process that obtains a token speaks as that role. Nothing on the socket hands out a value, a ticket or a staging slot. A native peer-credential helper is proposed for later.
2. **An echoing target is an oracle.** A target that echoes text core sent it lets core see whether its guess about the injected value came back scrubbed. Rate-capped; it matters only for low-entropy values.
3. **An old header copy**, with the person's passphrase or a holder's unrenewed key, still opens what that copy held. Headers never go into backups, and the outbox carries no factor wrap. A file-system attacker who rolls back the header and the items together restores the older state.
4. **The launcher** hashes the program, then starts it by path (a time-of-check to time-of-use gap).
5. **JavaScript strings:** values that become strings stay in the broker's heap until collected.
6. **Holder enrolment pins the hub's signing key at tier 3.** That approval is core-relayed on a device with no vault yet, so the person must check the key's fingerprint the card shows. A holder can't detect items dropped from, or rolled back in, the hub's outbox within one generation.
7. **Public-host TLS** uses Node's defaults. The tests reach only pinned loopback certificates.
8. **This PR doesn't yet move core's consumers onto the broker.** Core still reads the old vault until PR 2. These claims are about the broker and its client.
9. **macOS Touch ID gating** of the keychain item isn't possible through the `security` CLI. Windows is untested.
10. **Programs:** a program does what its arguments, working folder and project files (all core's) steer it to, including sending its credential elsewhere. Node's permission model doesn't stop the broker's child processes; the narrowing is defence in depth.
11. **Checkpoints** taken before the migration still hold the old vault with its key, and Era 2's files.
12. **What an approval covers:** a tier-2 approval covers one request's method and path, for one task: what its card shows. It doesn't cover its headers or body (core supplies those; they carry no value). A standing consent covers its scope's methods and path prefixes.
13. **The owner's reveal** (showing a value on the device's own screen, tier 3, gated by passkey or biometric) isn't built.
14. **Cooperating migration writers:** deploy this broker and updated `vault.ts` together. The lock is fail-closed and is never stolen; after a crash, an operator must stop all writers, establish that none remains, and remove the stale lock before retrying. Older binaries/direct filesystem writers do not participate. Era 2 Gmail JavaScript writers do not honor this lock and must be quiesced for file migration. A changed snapshot is retained, possibly alongside an already migrated alias; reconciliation is explicit. Pre-migration provenance without the new private revision is retained on resume.

## 6. What we most want attacked

1. **C2, every answer path:** `Broker.handle`, `server.ts` `answer()`, refusal texts, error texts. Could a value leak through an error message? Through `words`, a card, `outcome.headers`, `body`, or a scrubbed form the scrubber misses (for example, a value split across a JSON escape)?
2. **C3, canonicalization:** `canonicalOrigin`, `requestPath`, `inScope`, `canonicalTarget`. Can any input that canonicalizes to a bound origin connect anywhere else? Look at path tricks (`//host`, `%2f`, `..`, `\`), IPv6, a trailing dot, default ports, IDNA, and `URL` parsing differentials between the check and the request (`http.ts` builds the request from the canonical origin and the path).
3. **C4, the approval digest:** does it cover everything that changes what the broker does? Look at `#approve`, and each verb's `action` object. Can a caller get an approval for action X and use it for Y by changing a field that isn't digested (`request.headers`, `request.body`, `inject`, `consent`, `lan`, `pin`)?
4. **Tier logic in `#use`:** grants per task, `per_use`, sensitive class, standing consent and `version: 'pending'`. Can a model reach tier 1 for something that should ask?
5. **The store:** AEAD associated data, the rotation's crash safety (`rotateRoot`, `#finishRotation`), `adopt` (with the signature check and pinning), and `remove`. Can a file-system attacker without a factor make the broker accept attacker-chosen keys or items, or make a deleted item reappear?
6. **The launcher path:** `#runProgram`, `#launch`, `programRequest` and `launch.ts`. Can core steer what the launcher reads or runs beyond the bound program and the broker's own home (arguments, working folder, the environment allow-list, stdin)? Can anything get a value back over the socket?
7. **The migration:** `#migrate`, `groupStaged`, `oldvault.ts`. Is any value left where it shouldn't be, or removed before read-back? Does any answer, or effect, still depend on a value core chose?
8. **The cryptography:** the X25519 factor derivation from Argon2id or HKDF output, wrap info strings, HKDF salts, nonces (random, 96-bit), the P-256 sealed-entry KDF, and the WebAuthn verification (`checkAssertion`).
9. **The process:** `spawn.ts`'s flags and environment, and anything that would let core influence the broker's process (argv, environment, files it reads).

## 7. Evidence so far

The original review snapshot had 45 broker tests; their evidence follows. The follow-up owner suite adds 20 regressions, including a real concurrent legacy-writer child, complete injection settings, returned signing output and retained-binding policy checks. Parent read-back of owner/verbs/legacy-vault files passed 45 tests with one optional real-keychain skip. Full-suite failures and valid reruns are recorded in the implementation NOTES, without claiming a green full suite. On Linux (WSL2), Node 26.3.1, the earlier tests showed:
- **The first review's findings,** each reproduced first:
  - B1: no ticket reaches core, and a second socket can redeem nothing;
  - B2: the same answer and effect whatever core guessed, and commit at tier 3;
  - B3: frames carrying a held value answer exactly as frames carrying other text;
  - B4: a hub keeps its vault against a planted inbox, and a holder needs the pin and a newer generation;
  - B5: no reuse flag from core's guesses, and no `weak`;
  - S1: basic auth and the cut;
  - S2 and S3: file tools, reset and checkpoints;
  - S5: rollback after a revocation;
  - minor: passkeys, `..;`, address ranges.
- **Argon2id:** RFC 9106's test vector, and the floor enforced.
- **Factors:** every factor opens the vault, and a wrong one doesn't.
- **Tamper and swap:** each refused.
- **Delete:** a deleted item doesn't open from an older copy with this device's key. With the person's passphrase it does: limit 2.
- **Rotation:** one cut short is finished.
- **Holder sync:** the outbox holds public keys only; forged, re-signed or unsigned headers are refused.
- **Origin binding:** every non-bound origin in C3 is refused, with a valid approval made for A, and B's stand-in sees no connection.
- **Approvals:** missing, replayed, mismatched, expired and wrong-mode approvals are refused; so are passkey assertions with a wrong origin, a wrong rpId, no user verification, another challenge or a counter that went back.
- **Policy:** rate caps and flood control hold, and a standing consent on a sensitive item is refused.
- **The process:** Node's permission model, an empty environment, a 0600 socket in a 0700 folder.
- **No network surface:** `/proc` shows no inet socket at idle, and no inet listener after every verb. A positive control sees the test's own listeners.
- **Fuzzing:** 69 verb names refused; unknown fields, bad frames and frames too large refused.
- **The launcher:** a binary swapped after binding gets nothing; loader and config variables from core are refused; output is scrubbed; nothing of Node's reaches the program's environment; a 0600 file is removed on exit.
- **Canaries:**
  - planted by sealed entry, generation, rotation and migration;
  - searched in eight forms in core's heap snapshot (core's stand-in keeps everything it received, and positive controls are found), every answer, the audit log, the broker's own output and folder, the backup set, Nova's diagnostics bundle and the launcher's output;
  - zero hits.
- **Migration:** resumes by metadata, and leaves only Nova's own keys in the old vault.

## 8. The code

### `src/broker/protocol.ts`

```ts
// The Credential Broker's wire protocol (docs/plans/vault-broker.md §3–§4). Newline-delimited JSON
// over local IPC, one id per request, a size cap, and unknown fields refused. The broker answers
// seven fixed verbs and three protocol messages, and nothing else: its launcher is its own child,
// spoken to over a pipe, never over this socket. No answer to core carries a value, a part of one,
// its length, or a hash of it: every answer is checked against ANSWER_KEYS before it is written
// (checkAnswer). Text core sent is never echoed back, and answers aren't scrubbed as a whole: only
// what a target sent back (a response, a program's output) is, of the value that use injected.
//
// This file imports nothing; the core client imports its types only.

export const VERBS = ['list_refs', 'use', 'create', 'update', 'rotate', 'bind', 'share_scope'] as const;
export const MESSAGES = ['hello', 'unlock', 'lock'] as const;
export type Verb = (typeof VERBS)[number];
export type Message = Verb | (typeof MESSAGES)[number];
export type Role = 'core' | 'supervisor';

// The fixed refusal list (§4), each with plain words.
export const REFUSALS = {
  not_bound: 'That credential isn’t bound to this target, so the broker won’t use it there. Binding a target is a tier-3 approval.',
  out_of_scope: 'That request is outside what this credential’s binding allows.',
  needs_approval: 'This needs your approval first.',
  approval_invalid: 'The approval doesn’t match this action, has expired, or was already used.',
  locked: 'Nova’s vault is locked. Unlock it with your own factor.',
  class_policy: 'This credential’s sensitivity class doesn’t allow that.',
  rate: 'Too many requests for this credential, or too many approval requests. Something keeps asking to use your credentials.',
  unknown_ref: 'There is no credential with that reference.',
  wrong_target_kind: 'That kind of target isn’t one this credential can be used on (or isn’t built yet).',
} as const;
export type Refusal = keyof typeof REFUSALS;

// Protocol-level errors: a frame the broker can't take at all. Not refusals of a verb.
export const ERRORS = {
  bad_frame: 'That frame isn’t one the broker reads.',
  too_large: 'That frame is larger than the broker accepts.',
  unknown_message: 'The broker answers seven verbs and three protocol messages; that isn’t one of them.',
  unknown_field: 'That message carries a field the broker doesn’t take.',
  unauthenticated: 'Say hello with a valid token first.',
  not_allowed: 'That role can’t send this message.',
  failed: 'The broker couldn’t do that.',
} as const;
export type ProtocolError = keyof typeof ERRORS;

export const MAX_FRAME = 2 * 1024 * 1024;

// The fields each message may carry (besides `id` and `m`). Anything else is refused.
const COMMON = ['task', 'caller', 'approval'];
export const FIELDS: Record<Message, readonly string[]> = {
  hello: ['token'],
  unlock: ['passphrase', 'recovery', 'passkey', 'device', 'setup'],
  lock: [],
  list_refs: ['filter'],
  use: [...COMMON, 'ref', 'target', 'request', 'version'],
  create: [...COMMON, 'meta', 'source', 'bind'],
  update: [...COMMON, 'ref', 'change'],
  rotate: [...COMMON, 'ref', 'phase'],
  bind: [...COMMON, 'ref', 'add', 'remove'],
  share_scope: [...COMMON, 'device', 'backend', 'hub'],
};

// Every key that may appear anywhere in an answer to core or the supervisor. A schema check over
// every answer type (gate item 5): none of these is a field that carries a value. `body` is the
// target's own response, scrubbed of every value the broker holds in each encoding (§8).
export const ANSWER_KEYS: ReadonlySet<string> = new Set([
  'id', 'ok', 'refused', 'error', 'words', 'role', 'record', 'problem',
  // vault state
  'state', 'locked', 'exists', 'vault_id', 'unlock_mode', 'approval_mode', 'factors', 'entry_key', 'boot', 'device_id', 'device_key', 'holders', 'kdf', 'alg', 'm', 't', 'p', 'safe_mode',
  // refs and metadata
  'refs', 'ref', 'aliases', 'name', 'kind', 'origin', 'username', 'class', 'suggested_class', 'per_use', 'created_at', 'last_used', 'last_rotated', 'health', 'reused', 'old', 'backend', 'version', 'pending', 'bindings',
  'target', 'scope', 'methods', 'paths', 'consent', 'rate_per_hour', 'granted_at', 'approval_id', 'inject', 'how', 'header', 'prefix', 'format', 'lan', 'pin', 'embed_on', 'env', 'file', 'argv',
  // approvals
  'challenge', 'digest', 'expires_at', 'card', 'tier', 'verb', 'what', 'flags', 'task', 'approving', 'items', 'passkey',
  // outcomes
  'outcome', 'status', 'headers', 'body', 'truncated', 'valid', 'exit', 'stdout', 'stderr', 'migrated', 'kept', 'moved', 'staged', 'read_back', 'removed', 'device', 'outbox', 'text', 'hub', 'signer',
  // audit records
  'seq', 'at', 'prev', 'hash', 'scope_item',
]);

// Header names a response may pass on to core (everything else is dropped, never forwarded).
export const RESPONSE_HEADERS = ['content-type', 'content-length', 'location', 'retry-after', 'etag', 'last-modified', 'date', 'x-request-id', 'x-ratelimit-remaining', 'x-ratelimit-reset'];

// The keys allowed are checked recursively, except under `headers` (header names) and `refs`
// filters, which are data. Returns the first key that isn't allowed, or null.
export function checkAnswer(v: unknown, path = ''): string | null {
  if (v === null || typeof v !== 'object') return null;
  if (Array.isArray(v)) { for (const x of v) { const bad = checkAnswer(x, path); if (bad) return bad; } return null; }
  for (const [k, x] of Object.entries(v)) {
    const free = path.endsWith('.headers') || path.endsWith('.methods');
    if (!free && !ANSWER_KEYS.has(k)) return `${path}.${k}`;
    if (!free) { const bad = checkAnswer(x, `${path}.${k}`); if (bad) return bad; }
    else if (typeof x !== 'string' && typeof x !== 'number') return `${path}.${k}`;
  }
  return null;
}

export interface Frame { id: string | number; m: Message; [k: string]: unknown }

// Parses one line into a frame, or says why not. Checks the message name and its fields only;
// each handler checks the fields' contents.
export function parseFrame(line: string): { frame: Frame } | { error: ProtocolError; id: string | number | null } {
  if (line.length > MAX_FRAME) return { error: 'too_large', id: null };
  let v: unknown;
  try { v = JSON.parse(line); } catch { return { error: 'bad_frame', id: null }; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'bad_frame', id: null };
  const o = v as Record<string, unknown>;
  const id = typeof o.id === 'string' && o.id.length <= 64 ? o.id : typeof o.id === 'number' && Number.isSafeInteger(o.id) ? o.id : null;
  if (id === null) return { error: 'bad_frame', id: null };
  if (typeof o.m !== 'string' || !Object.hasOwn(FIELDS, o.m)) return { error: 'unknown_message', id };
  const allowed = new Set(['id', 'm', ...FIELDS[o.m as Message]]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) return { error: 'unknown_field', id };
  return { frame: o as Frame };
}

// A canonical JSON text (sorted keys), for approval digests: what the card shows is what is signed.
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

// ---- the shapes core sees (types only; erased at run time) --------------------------------------

export type TargetKind = 'web' | 'http' | 'ws' | 'stream' | 'process' | 'service' | 'device';
export interface Target { kind: TargetKind; origin?: string; path?: string; sha256?: string }
export interface Scope { methods: string[]; paths: string[] }
export interface Inject { how: 'bearer' | 'basic' | 'header' | 'sign' | 'verify' | 'env' | 'file' | 'fill'; header?: string; env?: string; prefix?: string; format?: 'hex' | 'base64' }
export interface Consent { scope: Scope; rate_per_hour: number; granted_at: string; approval_id: string; last_used: string | null }
export interface Binding { target: string; kind: TargetKind; scope: Scope; inject: Inject; consent: Consent | null; lan?: boolean; pin?: string | null; embed_on?: string[] }
export interface RefMeta {
  ref: string; aliases: string[]; name: string; kind: string; origin: string | null; username: string | null;
  class: 'standard' | 'sensitive'; per_use: boolean; created_at: string; last_used: string | null; last_rotated: string | null;
  health: { reused: boolean; old: boolean }; backend: 'nova'; version: number; pending: boolean; bindings: Binding[];
}
// The card shows stored metadata and what the broker computed; never text from the frame that asked
// (core shows the task and who asked from its own records).
export interface Card { argv?: string[]; verb: string; what: string; name?: string; origin?: string | null; username?: string | null; target?: string; scope?: Scope; class?: string; flags?: string[]; tier: number; approving: string; expires_at: string; items?: unknown[] }
export interface Challenge { id: string; digest: string; expires_at: string; card: Card; tier: number }
export interface AuditRecord { seq: number; at: string; device: string; verb: string; ref: string | null; target: string | null; scope_item: string | null; outcome: string; tier: number | null; approval_id: string | null; task: string | null; role: Role; prev: string; hash: string }
```

### `src/broker/broker.ts`

```ts
// The Credential Broker (docs/plans/vault-broker.md §4–§8): seven fixed verbs and three protocol
// messages, each checked on the broker's own authority. Whoever asks (core, with a valid token and
// even a valid approval for something else) gets refused when the target isn't bound exactly, the
// request is outside the binding's scope, or the class, consent or approval doesn't allow it.
// No answer carries a value, and none repeats text core sent in a way that could depend on one;
// every verb writes one audit record, which comes back in the answer for core to copy into the
// Work Ledger.
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Audit, type Entry } from './audit.ts';
import { entryKey, openEnvelope, type Envelope, type Kdf } from './crypto.ts';
import { send, EgressError, type Resolver } from './http.ts';
import { chooseStore, FILE_NOTICE, type KeyStore } from './keystore.ts';
import { BUILT, canonicalTarget, checkScope, inScope, lookalikes, requestPath, suggestClass } from './origin.ts';
import { Approvals, Rates, digestOf, generate, DEFAULT_POLICY, USES_PER_REF_HOUR, type ApprovalIn } from './policy.ts';
import { REFUSALS, canonical, type Binding, type Card, type Frame, type Inject, type Refusal, type Role } from './protocol.ts';
import { Scrubber } from './scrub.ts';
import { Store, sameBytes, type Meta, type OutboxHeader } from './store.ts';

export interface BrokerOptions {
  dir: string;
  deviceStore?: (account: string) => KeyStore;
  kdf?: Kdf;
  now?: () => Date;
  resolve?: Resolver;
  keyMode?: 'auto' | 'file' | 'keychain';
}

type Answer = Record<string, unknown>;

const NAME = /^[a-z0-9][a-z0-9._-]*(\/[A-Za-z0-9._-]+)*$/;
const ALIAS = 'secret://';
const LAUNCH = join(dirname(fileURLToPath(import.meta.url)), 'launch.ts');
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_STAGED = 1000;
// Under Node's permission model the launcher inherits the broker's grants (Node writes them into a
// child's NODE_OPTIONS) and gets these on top; without it, these flags would stop it starting.
const grantsIf = (flags: string[]) => ((process as { permission?: unknown }).permission ? flags : []);
// What a program's environment may carry from core: no loader, interpreter or config-path
// variables (LD_PRELOAD, NODE_OPTIONS, BASH_ENV, TF_CLI_CONFIG_FILE…). PATH and HOME are the
// launcher's own.
const PROGRAM_ENV = /^(LANG|LC_[A-Z]+|TZ|TERM|NO_COLOR|TF_IN_AUTOMATION|TF_INPUT|TF_VAR_[A-Za-z0-9_]+)$/;
const CONSENT_SENSITIVE = 'A sensitive credential always asks first (once per task, or on every use): it can’t have a standing consent.';
const KINDS = new Set(['api_key', 'token', 'login', 'secret', 'oauth', 'signing_key']);
const str = (v: unknown, max = 300): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const zero = (b: Buffer | null | undefined) => { if (b) b.fill(0); };

class Refused extends Error {
  readonly code: Refusal;
  readonly extra: Answer;
  constructor(code: Refusal, words?: string, extra: Answer = {}) { super(words ?? REFUSALS[code]); this.code = code; this.extra = extra; }
}
class Failed extends Error {}

export class Broker {
  readonly store: Store;
  readonly audit: Audit;
  readonly boot = randomBytes(12).toString('hex');
  #o: BrokerOptions;
  #entry = entryKey();
  #approvals: Approvals;
  #rates: Rates;
  #staged: { vaultId: string | null; revision: string; items: Map<string, Buffer> } | null = null;
  #running = 0;
  #grants = new Set<string>();
  #index = new Map<string, Meta & { version: number; pending: boolean }>();
  #health = new Map<string, { reused: boolean; old: boolean }>();
  #broken: string[] = [];
  #pendingId = randomUUID();
  #failedUnlocks: number[] = [];
  // A problem raised on the broker's own authority (flood control, a schema refusal).
  problem: string | null = null;

  constructor(o: BrokerOptions) {
    this.#o = o;
    const now = () => (o.now?.() ?? new Date()).getTime();
    this.#approvals = new Approvals(now);
    this.#rates = new Rates(now);
    const deviceStore = o.deviceStore ?? ((account: string) => chooseStore('nova-broker', account, join(o.dir, account.startsWith('sign-') ? 'sign.key' : 'device.key'), o.keyMode ? { mode: o.keyMode } : {}));
    this.store = new Store({ dir: o.dir, deviceStore, ...(o.kdf ? { kdf: o.kdf } : {}), ...(o.now ? { now: o.now } : {}) });
    this.audit = new Audit(join(o.dir, 'audit.log'), this.store.device().id, o.now);
  }

  #now() { return this.#o.now?.() ?? new Date(); }

  // At start: a hub unlocks itself with its device key, as today (§10 "A hub has to work
  // unattended"), unless the person chose "ask me after a restart". A holder adopts its inbox.
  start(): void {
    try { this.#adoptInbox(); } catch { /* nothing to adopt, or not for this device */ }
    const h = this.store.header;
    if (h && !this.store.unlocked && h.unlock_mode === 'auto' && h.wraps[`device:${this.store.device().id}`]) {
      try { this.store.unlock({ kind: 'device' }); this.#reindex(); } catch { /* stays locked; Health says why */ }
    }
  }

  // ---- the index and health flags (in memory only) -------------------------------------------

  // `reused` is worked out only among values core couldn't have chosen (generated, migrated by the
  // launcher, or sealed under a passkey approval), so it answers no guess of core's. There is no
  // `weak` flag in answers: it would tell core a value's length band and character classes.
  #reindex(): void {
    const { items, broken } = this.store.metas();
    this.#index = items;
    this.#broken = broken;
    const seen = new Map<string, string[]>();
    this.#health.clear();
    for (const [id, m] of items) {
      const old = Date.parse(m.last_rotated ?? m.created_at) < this.#now().getTime() - 365 * 86400_000;
      this.#health.set(id, { reused: false, old });
      if (!m.provenance || m.provenance === 'sealed') continue;
      const v = this.store.value(id);
      const k = createHash('sha256').update(v).digest('hex');
      zero(v);
      seen.set(k, [...(seen.get(k) ?? []), id]);
    }
    for (const ids of seen.values()) if (ids.length > 1) for (const id of ids) this.#health.get(id)!.reused = true;
  }

  #resolve(ref: unknown): string {
    if (!str(ref, 260)) throw new Refused('unknown_ref');
    if (ref.startsWith(ALIAS)) { for (const [id, m] of this.#index) if (m.aliases.includes(ref)) return id; throw new Refused('unknown_ref'); }
    if (!this.#index.has(ref)) throw new Refused('unknown_ref');
    return ref;
  }

  #refMeta(id: string) {
    const m = this.#index.get(id)!;
    return {
      ref: id, aliases: m.aliases, name: m.name, kind: m.kind, origin: m.origin, username: m.username, class: m.class, per_use: m.per_use,
      created_at: m.created_at, last_used: m.last_used, last_rotated: m.last_rotated, health: this.#health.get(id) ?? { reused: false, old: false },
      backend: 'nova', version: m.version, pending: m.pending, bindings: m.bindings,
    };
  }

  state(): Answer {
    const h = this.store.header;
    const dev = this.store.device();
    return {
      exists: !!h, locked: !this.store.unlocked, vault_id: h?.id ?? this.#pendingId, unlock_mode: h?.unlock_mode ?? null,
      approval_mode: h && Object.keys(h.passkeys).length ? 'passkey' : 'core',
      factors: h ? Object.keys(h.wraps).map((n) => (n.startsWith('device:') ? (n === `device:${dev.id}` ? 'this device' : 'another holder') : n.split(':')[0])) : [],
      entry_key: this.#entry.pub, boot: this.boot, device_id: dev.id, device_key: dev.store,
      holders: h ? Object.entries(h.holders).map(([id, x]) => ({ device: id, name: x.name })) : [],
      kdf: h ? { alg: h.kdf.alg, m: h.kdf.m, t: h.kdf.t, p: h.kdf.p } : null,
      problem: this.problem ?? (this.#broken.length ? `${this.#broken.length} item(s) failed to open (tampered, moved or damaged) and are left as they are.` : dev.store === 'file' && h?.unlock_mode === 'auto' ? FILE_NOTICE : null),
    };
  }

  // ---- dispatch -------------------------------------------------------------------------------

  async handle(role: Role, f: Frame): Promise<Answer> {
    // The task's id ties records and grants to it. Its title and the caller's name are core's to
    // show; they aren't repeated back.
    const task = f.task && typeof f.task === 'object' && str((f.task as { id?: unknown }).id, 80) ? { id: (f.task as { id: string }).id } : null;
    const rec: Entry = { verb: f.m, ref: null, target: null, scope_item: null, outcome: 'ok', tier: null, approval_id: null, task: task?.id ?? null, role };
    try {
      const out = await this.#dispatch(role, f, rec, task);
      return { ok: true, ...out, record: this.audit.write(rec) };
    } catch (e) {
      if (e instanceof Refused) {
        rec.outcome = `refused:${e.code}`;
        return { refused: e.code, words: e.message, ...e.extra, record: this.audit.write(rec) };
      }
      rec.outcome = `failed:${e instanceof EgressError ? e.cls : e instanceof Failed ? 'request' : 'internal'}`;
      return { error: 'failed', words: e instanceof Failed || e instanceof EgressError ? e.message : 'The broker couldn’t do that.', record: this.audit.write(rec) };
    }
  }

  async #dispatch(role: Role, f: Frame, rec: Entry, task: { id: string } | null): Promise<Answer> {
    if (f.m === 'lock') { this.lock(); return { state: this.state() }; }
    if (f.m === 'list_refs') return this.#list(f.filter);
    if (role !== 'core' && f.m !== 'unlock') throw new Failed('Only core asks the broker for that.');
    if (f.m === 'unlock') { if (role !== 'core') throw new Failed('Only core relays an unlock.'); this.#unlock(f); return { state: this.state() }; }
    const ctx = { rec, task, approval: f.approval as ApprovalIn | undefined };
    // A holder-to-be pins its hub before it has a vault (B4).
    if (f.m === 'share_scope' && f.hub !== undefined) return this.#pinHub(f, ctx);
    if (!this.store.unlocked) throw new Refused('locked');
    switch (f.m) {
      case 'use': return this.#use(f, ctx);
      case 'create': return this.#create(f, ctx);
      case 'update': return this.#update(f, ctx);
      case 'rotate': return this.#rotate(f, ctx);
      case 'bind': return this.#bind(f, ctx);
      case 'share_scope': return this.#share(f, ctx);
      default: throw new Failed('not a verb');
    }
  }

  lock(): void {
    this.store.lock();
    this.#index.clear();
    for (const b of this.#staged?.items.values() ?? []) zero(b);
    this.#staged = null;
    this.#grants.clear();
    this.#approvals.clear();
  }

  // ---- approvals ------------------------------------------------------------------------------

  // Either the approval checks out for exactly this action (returns its id), or the answer is a
  // challenge for it (needs_approval), or the approval is refused.
  // `bound` is the SHA-256 of a sealed value's envelope: a passkey approval signs it too, so the value
  // is the one the person's client sealed, not one core swapped in.
  #approve(ctx: Ctx, action: Record<string, unknown>, card: Omit<Card, 'expires_at'>, passkey = false, bound = ''): { id: string; passkey: boolean } {
    const passkeys = this.store.header?.passkeys ?? {};
    const needsPasskey = passkey && Object.keys(passkeys).length > 0;
    const full = { ...action, task: ctx.task?.id ?? null };
    if (!ctx.approval) {
      const c = this.#approvals.issue(full, card, ctx.task?.id ?? null, needsPasskey);
      if (!c) { this.problem = 'Something keeps asking to use your credentials: approval requests are refused for now.'; throw new Refused('rate'); }
      ctx.rec.tier = card.tier;
      throw new Refused('needs_approval', undefined, { challenge: c });
    }
    const r = this.#approvals.check(ctx.approval, full, passkeys, (id, n) => this.store.bumpSignCount(id, n), bound);
    ctx.rec.approval_id = typeof ctx.approval.id === 'string' && /^ap_[0-9a-f]{24}$/.test(ctx.approval.id) ? ctx.approval.id : null;
    ctx.rec.tier = card.tier;
    if (!r.ok) throw new Refused('approval_invalid', `${REFUSALS.approval_invalid} (${r.why})`);
    return { id: r.id, passkey: r.passkey };
  }

  #envelopeHash(src: unknown): string {
    const e = src && typeof src === 'object' && 'sealed' in src ? (src as { sealed: unknown }).sealed : null;
    return e ? createHash('sha256').update(canonical(e)).digest('hex') : '';
  }

  #sealed(e: unknown, digest: string): Buffer {
    try { return openEnvelope(this.#entry.priv, e as Envelope, digest); } catch { throw new Refused('approval_invalid', 'The sealed value doesn’t open for this action (sealed for another one, or damaged).'); }
  }

  // ---- unlock ---------------------------------------------------------------------------------

  #unlock(f: Frame): void {
    const t = this.#now().getTime();
    this.#failedUnlocks = this.#failedUnlocks.filter((x) => x > t - 60_000);
    if (this.#failedUnlocks.length >= 5) throw new Refused('rate', 'Too many unlock attempts; wait a minute.');
    const h = this.store.header;
    const vid = h?.id ?? this.#pendingId;
    const dg = (factor: string) => unlockDigest(vid, factor, this.boot);
    const opened: Buffer[] = [];
    const take = (e: unknown, factor: string) => { const b = this.#sealedUnlock(e, dg(factor)); opened.push(b); return b; };
    try {
      if (f.setup) {
        if (h) throw new Failed('There is a vault here already.');
        const s = f.setup as { passphrase?: unknown; recovery?: unknown; ask_after_restart?: unknown; passkeys?: unknown };
        const passkeys = Array.isArray(s.passkeys) ? s.passkeys.slice(0, 5).map((p: { id?: unknown; public_key?: unknown; rp_id?: unknown; origins?: unknown; prf?: unknown }) => {
          if (!str(p.id, 200) || !/^[A-Za-z0-9_-]+$/.test(p.id) || !str(p.public_key, 400) || !str(p.rp_id, 253) || !Array.isArray(p.origins) || !p.origins.every((o) => str(o, 300))) throw new Failed('not a passkey registration');
          return { id: p.id, public_key: p.public_key, rp_id: p.rp_id, origins: p.origins as string[], prf: p.prf ? take(p.prf, `passkey:${p.id}`) : null };
        }) : [];
        this.store.create({ id: vid, passphrase: take(s.passphrase, 'passphrase'), recovery: s.recovery ? take(s.recovery, 'recovery') : null, passkeys, unlock_mode: s.ask_after_restart === true ? 'ask' : 'auto' });
      } else if (f.device === true) {
        this.#adoptInbox();
        this.store.unlock({ kind: 'device' });
      } else if (f.passphrase) this.store.unlock({ kind: 'passphrase', secret: take(f.passphrase, 'passphrase') });
      else if (f.recovery) this.store.unlock({ kind: 'recovery', secret: take(f.recovery, 'recovery') });
      else if (f.passkey && typeof f.passkey === 'object') {
        const p = f.passkey as { id?: unknown; prf?: unknown };
        if (!str(p.id, 200)) throw new Failed('not a passkey');
        this.store.unlock({ kind: 'passkey', id: p.id, secret: take(p.prf, `passkey:${p.id}`) });
      } else throw new Failed('An unlock brings one factor.');
    } catch (e) {
      if (e instanceof Failed) throw e;
      this.#failedUnlocks.push(t);
      throw e instanceof Refused ? e : new Refused('locked', (e as Error).message);
    } finally { for (const b of opened) zero(b); }
    this.#reindex();
  }

  #sealedUnlock(e: unknown, digest: string): Buffer {
    try { return openEnvelope(this.#entry.priv, e as Envelope, digest); } catch { throw new Refused('locked', 'That factor wasn’t sealed for this broker’s current boot.'); }
  }

  #adoptInbox(): void {
    const dir = join(this.store.dir, 'inbox');
    if (!existsSync(join(dir, 'header.json'))) return;
    // A vault made here never adopts; a holder takes only a newer generation (store.adopt checks
    // the signature, the pin and the vault id).
    if (this.store.header && this.store.header.origin !== 'adopted') return;
    const header = JSON.parse(readFileSync(join(dir, 'header.json'), 'utf8')) as OutboxHeader;
    if (this.store.header && header.gen <= this.store.header.gen) return;
    const items: Record<string, string> = {};
    for (const n of readdirSync(join(dir, 'items')).filter((x) => x.endsWith('.json'))) items[n.slice(0, -5)] = readFileSync(join(dir, 'items', n), 'utf8');
    this.store.adopt(header, items);
  }

  // ---- list_refs (tier 0) ---------------------------------------------------------------------

  #list(filter: unknown): Answer {
    if (!this.store.unlocked) return { state: this.state(), refs: [] };
    const fl = (filter && typeof filter === 'object' ? filter : {}) as { prefix?: unknown; kind?: unknown };
    const refs = [...this.#index.keys()].map((id) => this.#refMeta(id))
      .filter((r) => (typeof fl.prefix !== 'string' || r.aliases.some((a) => a.startsWith(`${ALIAS}${fl.prefix}`))) && (typeof fl.kind !== 'string' || r.kind === fl.kind));
    return { state: this.state(), refs };
  }

  // ---- use (tier 1 / 2) -----------------------------------------------------------------------

  async #use(f: Frame, ctx: Ctx): Promise<Answer> {
    const id = this.#resolve(f.ref);
    ctx.rec.ref = id;
    const m = this.#index.get(id)!;
    let t: { kind: string; target: string };
    try { t = canonicalTarget(f.target as object); } catch { throw new Refused('not_bound'); }
    ctx.rec.target = t.target;
    const b = m.bindings.find((x) => x.kind === t.kind && x.target === t.target);
    if (!b) throw new Refused('not_bound');
    if (!BUILT.has(b.kind)) throw new Refused('wrong_target_kind', `Using a credential on a ${b.kind} target isn’t built yet (Phase 1, later PRs).`);
    const req = (f.request ?? {}) as { method?: unknown; path?: unknown; headers?: unknown; body?: unknown; verify?: unknown; argv?: unknown; cwd?: unknown; env?: unknown; stdin?: unknown; timeout_ms?: unknown };
    const which = f.version === 'pending' ? 'pending' : 'current';
    if (which === 'pending' && !m.pending) throw new Refused('out_of_scope', 'There is no pending version to use.');
    // What is asked for, in the binding's terms.
    let method = 'RUN';
    let bare = '/';
    let path = '/';
    if (b.kind === 'http') {
      if (b.inject.how === 'verify') { method = 'VERIFY'; } else {
        if (!str(req.method, 10)) throw new Refused('out_of_scope');
        method = req.method.toUpperCase();
        try { ({ path, bare } = requestPath(req.path)); } catch { throw new Refused('out_of_scope', 'That request path isn’t one the broker sends.'); }
      }
      ctx.rec.scope_item = `${method} ${bare}`;
      if (method !== 'VERIFY' && !inScope(b.scope, method, bare)) throw new Refused('out_of_scope');
    } else ctx.rec.scope_item = 'RUN';
    const argv = b.kind === 'process' ? (Array.isArray(req.argv) ? req.argv : []) : null;
    if (argv && (argv.length > 64 || !argv.every((x) => typeof x === 'string' && x.length <= 4096))) throw new Refused('out_of_scope', 'A program’s arguments are up to 64 strings.');
    const run = b.kind === 'process' ? programRequest(req) : null;
    // Class, consent, approval.
    const key = `${id}|${b.target}`;
    // A tier-2 approval covers this request (method and path, or a program's exact arguments) for
    // this task, nothing wider. The arguments are on the card and in the digest, never the ledger.
    const grant = `${key}|${ctx.task?.id ?? '-'}|${ctx.rec.scope_item}|${which}|${argv ? JSON.stringify(argv) : ''}`;
    const standing = m.class === 'standard' && !m.per_use && !!b.consent && (method === 'RUN' || method === 'VERIFY' || inScope(b.consent.scope, method, bare));
    if (standing) {
      ctx.rec.tier = 1;
      ctx.rec.approval_id = b.consent!.approval_id;
      if (!this.#rates.take(`c|${key}`, b.consent!.rate_per_hour)) throw new Refused('rate');
    } else if (m.per_use || !this.#grants.has(grant)) {
      this.#approve(ctx, { verb: 'use', ref: id, target: b.target, scope_item: ctx.rec.scope_item, class: m.class, version: which, ...(argv ? { argv } : {}) }, {
        verb: 'use', what: `Use your ${m.kind === 'login' ? 'sign-in' : 'credential'} “${m.name}” for ${b.target}`, name: m.name, origin: m.origin, username: m.username, target: b.target,
        scope: b.scope, class: m.class, tier: 2, approving: m.per_use ? 'Allows this one use.' : 'Allows uses like this one for this task.', ...(argv ? { argv: argv as string[] } : {}),
      }, m.class === 'sensitive');
      if (!m.per_use) this.#grants.add(grant);
    } else ctx.rec.tier = 2;
    if (!this.#rates.take(`r|${id}`, USES_PER_REF_HOUR)) throw new Refused('rate');
    this.store.touch(id);
    m.last_used = this.#now().toISOString();
    if (b.kind === 'process') return { outcome: await this.#runProgram(b, id, which, argv as string[], run!) };
    const value = this.store.value(id, which);
    try {
      if (b.inject.how === 'verify') {
        const v = (req.verify ?? {}) as { body?: unknown; signature?: unknown };
        if (typeof v.body !== 'string' || typeof v.signature !== 'string') throw new Refused('out_of_scope', 'A check brings the body and the signature it came with.');
        const mac = hmac(value, Buffer.from(v.body, 'utf8'), b.inject);
        const sig = v.signature.trim();
        return { outcome: { valid: mac.length === sig.length && timingSafeEqual(Buffer.from(mac), Buffer.from(sig)) } };
      }
      const headers = callerHeaders(req.headers, b.inject);
      const body = req.body === undefined || req.body === null ? null : typeof req.body === 'string' ? Buffer.from(req.body, 'utf8') : null;
      if (req.body !== undefined && req.body !== null && !body) throw new Refused('out_of_scope', 'A request body is text.');
      if (body && body.length > 1024 * 1024) throw new Refused('out_of_scope', 'A request body is up to 1 MiB.');
      const signature = inject(headers, b.inject, value, m.username, body);
      const res = await send({ origin: b.target, method, path, headers, body, lan: !!b.lan, pin: b.pin ?? null, maxBytes: MAX_OUTPUT }, this.#o.resolve);
      // What the target sent back, scrubbed of the value this use sent (and basic auth's user:value).
      const one = new Scrubber([value.toString('utf8'), ...(b.inject.how === 'basic' ? [`${m.username ?? ''}:${value.toString('utf8')}`] : []), ...(signature ? [signature, signature.slice((b.inject.prefix ?? '').length)] : [])]);
      // A body cut at the cap may end in part of a value: the tail that could hold one goes too.
      const text = res.truncated ? res.body.slice(0, Math.max(0, res.body.length - one.longest)) : res.body;
      return { outcome: { status: res.status, headers: one.any(res.headers), body: one.text(text), truncated: res.truncated } };
    } finally { zero(value); }
  }

  // ---- programs, through the broker's own launcher (§3) -----------------------------------------

  // The broker starts the launcher itself and hands it the value over a pipe: no ticket exists for
  // anyone else to redeem. The launcher hashes the binary, runs the program and scrubs its output;
  // the answer is the exit code and that output (up to 4 MiB each).
  #runProgram(b: Binding, id: string, which: 'current' | 'pending', argv: string[], r: ReturnType<typeof programRequest>): Promise<Answer> {
    if (this.#running >= 4) throw new Refused('rate', 'Four programs are running with credentials already.');
    const [path, sha256] = b.target.split('#sha256:') as [string, string];
    const value = this.store.value(id, which);
    this.#running++;
    return new Promise((ok) => {
      // Node carries the broker's permission model into the launcher; it gets exactly what this job
      // needs on top: to read the program it hashes, and to write under the broker's run folder.
      const run = join(this.store.dir, 'run');
      mkdirSync(run, { recursive: true, mode: 0o700 });
      const child = spawn(process.execPath, [...grantsIf([`--allow-fs-read=${path}`, `--allow-fs-write=${run}/`]), '--disable-sigusr1', '--disable-warning=ExperimentalWarning', '--disable-warning=SecurityWarning', LAUNCH, 'run'], { env: { TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
      const grant = JSON.stringify({ path, sha256, argv, cwd: r.cwd, env: r.env, stdin: r.stdin, inject: b.inject, tmp: run, value: value.toString('utf8') });
      zero(value);
      child.stdio[3]!.on('error', () => { /* the launcher stopped before reading it */ });
      (child.stdio[3] as NodeJS.WritableStream).end(grant);
      const take = (s: NodeJS.ReadableStream) => { const c: Buffer[] = []; let n = 0; s.on('data', (x: Buffer) => { if (n < MAX_OUTPUT) c.push(x.subarray(0, MAX_OUTPUT - n)); n += x.length; }); return () => ({ text: Buffer.concat(c).toString('utf8'), cut: n > MAX_OUTPUT }); };
      const out = take(child.stdout!);
      const err = take(child.stderr!);
      const timer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); }, r.timeout);
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        this.#running--;
        const o = out();
        const e = err();
        ok({ exit: code ?? (signal ? 128 : 1), stdout: o.text, stderr: e.text, truncated: o.cut || e.cut });
      });
    });
  }

  // ---- create (tier 3) ------------------------------------------------------------------------

  #create(f: Frame, ctx: Ctx): Answer | Promise<Answer> {
    const src = f.source as unknown;
    if (src && typeof src === 'object' && 'migrate' in src) return this.#migrate(src as { migrate: unknown; proposals?: unknown }, ctx);
    const mi = (f.meta ?? {}) as Record<string, unknown>;
    if (!str(mi.name, 200) || !NAME.test(mi.name)) throw new Failed('A credential is named like provider/EXAMPLE_KEY (letters, digits, dots, dashes, slashes).');
    if (!str(mi.kind, 20) || !KINDS.has(mi.kind)) throw new Failed('Not a kind of credential the broker keeps.');
    const alias = `${ALIAS}${mi.name}`;
    for (const x of this.#index.values()) if (x.aliases.includes(alias)) throw new Failed('There is a credential with that name already; update it instead.');
    let origin: string | null = null;
    if (mi.origin !== undefined && mi.origin !== null) { try { origin = canonicalTarget({ kind: 'http', origin: mi.origin }).target; } catch { throw new Failed('The site isn’t a canonical https origin.'); } }
    const suggested = suggestClass(origin, mi.kind);
    const cls = mi.class === 'standard' || mi.class === 'sensitive' ? mi.class : suggested;
    const pol = mi.policy as { length?: unknown; alphabet?: unknown } | undefined;
    const policy = pol ? { length: Number(pol.length ?? DEFAULT_POLICY.length), alphabet: String(pol.alphabet ?? DEFAULT_POLICY.alphabet) } : DEFAULT_POLICY;
    if (pol) { try { zero(generate(policy)); } catch (e) { throw new Failed((e as Error).message); } }
    const bindings = Array.isArray(f.bind) ? f.bind.slice(0, 20).map((x) => this.#binding(x)) : [];
    if (cls === 'sensitive' && bindings.some((b) => b.consent)) throw new Refused('class_policy', CONSENT_SENSITIVE);
    const kind = src === 'generate' ? 'generate' : src === 'sealed' || (src && typeof src === 'object' && 'sealed' in src) ? 'sealed' : null;
    if (!kind) throw new Failed('A value comes from generate or sealed entry (or migrate).');
    const meta: Meta = { name: mi.name, aliases: [alias], kind: mi.kind, origin, username: str(mi.username, 300) ? mi.username : null, class: cls, per_use: mi.per_use === true, created_at: this.#now().toISOString(), last_used: null, last_rotated: null, bindings, policy };
    const action = { verb: 'create', name: meta.name, kind: meta.kind, origin, username: meta.username, class: cls, per_use: meta.per_use, bindings: bindings.map(cardBinding), source: kind };
    const flags = bindings.flatMap((b) => this.#flags(b.target, b.kind));
    const { id: approval, passkey } = this.#approve(ctx, action, { verb: 'create', what: kind === 'generate' ? `Make a new password for ${origin ?? meta.name}` : `Save a credential for ${origin ?? meta.name}`, name: meta.name, origin, username: meta.username, class: cls, flags, tier: 3, items: bindings.map(cardBinding), approving: `Saves it in Nova Vault${bindings.length ? `, usable only on ${bindings.map((b) => b.target).join(', ')}` : ', unbound (usable nowhere until you bind it)'}. Suggested class: ${suggested}.` }, true, this.#envelopeHash(src));
    for (const b of meta.bindings) if (b.consent) b.consent.approval_id = approval;
    meta.provenance = kind === 'generate' ? 'generated' : passkey ? 'sealed-passkey' : 'sealed';
    const value = kind === 'generate' ? generate(policy) : this.#sealed((src as { sealed: unknown }).sealed, this.#digest(action, ctx));
    try {
      if (!value.length || value.length > 64 * 1024) throw new Failed('A value is 1 byte to 64 KiB.');
      const { id } = this.store.add(meta, value);
      ctx.rec.ref = id;
      this.#reindex();
      return this.#refMeta(id);
    } finally { zero(value); }
  }

  // What a sealed value is bound to: the digest of the approved action, as the client saw it.
  #digest(action: Record<string, unknown>, ctx: Ctx) { return digestOf({ ...action, task: ctx.task?.id ?? null }); }

  // ---- update (tier 3) ------------------------------------------------------------------------

  #update(f: Frame, ctx: Ctx): Answer {
    const id = this.#resolve(f.ref);
    ctx.rec.ref = id;
    const m = this.#index.get(id)!;
    const ch = f.change as unknown;
    if (ch === 'remove') {
      this.#approve(ctx, { verb: 'update', ref: id, change: 'remove' }, { verb: 'update', what: `Delete “${m.name}” for good`, name: m.name, origin: m.origin, username: m.username, class: m.class, tier: 3, approving: 'Destroys it, and re-keys the vault so no older copy of the item files opens it.' }, true);
      this.store.remove(id);
      this.#forgetGrants(id);
      this.#reindex();
      return { ref: id, removed: true };
    }
    if (!ch || typeof ch !== 'object') throw new Failed('An update is a new value, metadata, or remove.');
    const c = ch as { value?: unknown; meta?: Record<string, unknown> };
    if (c.meta) {
      const next: Meta = { ...m };
      const mm = c.meta;
      for (const k of Object.keys(mm)) if (!['name', 'username', 'class', 'per_use'].includes(k)) throw new Failed('An update changes name, username, class or per_use only.');
      if (mm.name !== undefined) { if (!str(mm.name, 200) || !NAME.test(mm.name)) throw new Failed('not a name'); next.name = mm.name; next.aliases = [...new Set([...m.aliases, `${ALIAS}${mm.name}`])]; }
      if (mm.username !== undefined) next.username = str(mm.username, 300) ? mm.username : null;
      if (mm.class !== undefined) { if (mm.class !== 'standard' && mm.class !== 'sensitive') throw new Failed('not a class'); next.class = mm.class; }
      if (mm.per_use !== undefined) next.per_use = mm.per_use === true;
      if (next.class === 'sensitive' && next.bindings.some((b) => b.consent)) throw new Refused('class_policy', CONSENT_SENSITIVE);
      this.#approve(ctx, { verb: 'update', ref: id, meta: { name: next.name, username: next.username, class: next.class, per_use: next.per_use } }, { verb: 'update', what: `Change the details of “${m.name}”${next.class !== m.class ? ` (class ${m.class} → ${next.class})` : ''}`, name: next.name, origin: m.origin, username: next.username, class: next.class, tier: 3, approving: 'Saves the new details.' }, true);
      this.store.setMeta(id, stripIndex(next));
      this.#revoked(id);
      return this.#refMeta(id);
    }
    const kind = c.value === 'generate' ? 'generate' : c.value === 'sealed' || (c.value && typeof c.value === 'object' && 'sealed' in c.value) ? 'sealed' : null;
    if (!kind) throw new Failed('A new value comes from generate or sealed entry.');
    const action = { verb: 'update', ref: id, value: kind };
    const { passkey } = this.#approve(ctx, action, { verb: 'update', what: kind === 'generate' ? `Make a new value for “${m.name}”` : `Replace the value of “${m.name}”`, name: m.name, origin: m.origin, username: m.username, class: m.class, tier: 3, approving: 'Replaces the value inside the broker. The site itself isn’t changed by this.' }, true, this.#envelopeHash(c.value));
    const value = kind === 'generate' ? generate(m.policy) : this.#sealed((c.value as { sealed: unknown }).sealed, this.#digest(action, ctx));
    try {
      const version = this.store.setValue(id, value);
      this.store.setMeta(id, stripIndex({ ...this.store.meta(id), provenance: kind === 'generate' ? 'generated' : passkey ? 'sealed-passkey' : 'sealed' }));
      this.#forgetGrants(id);
      this.#reindex();
      return { ref: id, version };
    } finally { zero(value); }
  }

  // ---- rotate (tier 3; abandon at once) -------------------------------------------------------

  #rotate(f: Frame, ctx: Ctx): Answer {
    const id = this.#resolve(f.ref);
    ctx.rec.ref = id;
    const m = this.#index.get(id)!;
    if (f.phase === 'abandon') { if (m.pending) this.store.dropPending(id); this.#forgetGrants(id); this.#reindex(); return { ref: id, version: m.version, pending: false }; }
    if (f.phase !== 'begin' && f.phase !== 'commit') throw new Failed('A rotation begins, then commits or is abandoned.');
    if (f.phase === 'commit' && !m.pending) throw new Failed('There is no rotation to commit.');
    this.#approve(ctx, { verb: 'rotate', ref: id, phase: f.phase }, { verb: 'rotate', what: f.phase === 'begin' ? `Make a new password for “${m.name}”, kept aside until the site takes it` : `Keep the new password for “${m.name}”`, name: m.name, origin: m.origin, username: m.username, class: m.class, tier: 3, approving: f.phase === 'begin' ? 'Generates it inside the broker. Typing it into the site’s change form is a separate, visible step.' : 'The new value replaces the old one.' }, true);
    this.#forgetGrants(id);
    let version: number;
    if (f.phase === 'begin') { const v = generate(m.policy); try { version = this.store.setPending(id, v); } finally { zero(v); } }
    else { version = this.store.commitPending(id); this.store.setMeta(id, stripIndex({ ...this.store.meta(id), provenance: 'generated' })); }
    this.#reindex();
    return { ref: id, version, pending: f.phase === 'begin' };
  }

  // ---- bind (tier 3 to add or widen; removing at once) ----------------------------------------

  #binding(x: unknown): Binding {
    const a = (x ?? {}) as { target?: unknown; scope?: unknown; inject?: unknown; consent?: unknown; lan?: unknown; pin?: unknown; embed_on?: unknown };
    let t: { kind: Binding['kind']; target: string };
    try { t = canonicalTarget(a.target as object); } catch (e) { throw new Failed(`Not a target the broker binds: ${(e as Error).message}.`); }
    if (!BUILT.has(t.kind) && t.kind !== 'web') throw new Refused('wrong_target_kind', `Binding a ${t.kind} target isn’t built yet.`);
    const inj = (a.inject ?? {}) as Inject;
    const hows = t.kind === 'process' ? ['env', 'file'] : t.kind === 'web' ? ['fill'] : ['bearer', 'basic', 'header', 'sign', 'verify'];
    if (t.kind === 'web') (inj as { how: string }).how = 'fill';
    if (!hows.includes(inj.how)) throw new Failed(`A ${t.kind} binding injects by ${hows.join(', ')}.`);
    if ((inj.how === 'header' || inj.how === 'sign') && (!str(inj.header, 60) || !/^[A-Za-z0-9-]+$/.test(inj.header) || /^(host|cookie|content-length|transfer-encoding|connection)$/i.test(inj.header))) throw new Failed('A header binding names an ordinary header.');
    if ((inj.how === 'env' || inj.how === 'file') && (!str(inj.env, 80) || !/^[A-Z_][A-Z0-9_]*$/.test(inj.env))) throw new Failed('A program binding names its environment variable.');
    if (inj.prefix !== undefined && (!str(inj.prefix, 40) || /[\r\n]/.test(inj.prefix))) throw new Failed('not a prefix');
    const scope = t.kind === 'http' ? checkScope(a.scope) : { methods: ['RUN'], paths: ['/'] };
    let consent: Binding['consent'] = null;
    if (a.consent) {
      const c = a.consent as { scope?: unknown; rate_per_hour?: unknown };
      const cs = t.kind === 'http' ? checkScope(c.scope ?? scope) : scope;
      if (t.kind === 'http' && !cs.paths.every((p) => cs.methods.every((mm) => inScope(scope, mm, p)))) throw new Failed('A standing consent can’t be wider than its binding.');
      const rate = Number(c.rate_per_hour ?? 600);
      if (!Number.isInteger(rate) || rate < 1 || rate > USES_PER_REF_HOUR) throw new Failed('not a rate cap');
      consent = { scope: cs, rate_per_hour: rate, granted_at: this.#now().toISOString(), approval_id: '', last_used: null };
    }
    const pin = a.pin === undefined || a.pin === null ? null : String(a.pin).replace(/:/g, '').toLowerCase();
    if (pin !== null && !/^[0-9a-f]{64}$/.test(pin)) throw new Failed('A pin is the certificate’s SHA-256.');
    if (a.lan === true && !pin) throw new Failed('A LAN device is bound only with a pinned certificate.');
    if (t.kind !== 'http' && (pin || a.lan)) throw new Failed('Only an http target pins a certificate.');
    const embed = Array.isArray(a.embed_on) ? a.embed_on.slice(0, 5).map((o) => canonicalTarget({ kind: 'web', origin: o }).target) : [];
    return { target: t.target, kind: t.kind, scope, inject: { how: inj.how, ...(inj.header ? { header: inj.header } : {}), ...(inj.env ? { env: inj.env } : {}), ...(inj.prefix ? { prefix: inj.prefix } : {}), ...(inj.format ? { format: inj.format === 'base64' ? 'base64' : 'hex' } : {}) }, consent, ...(a.lan === true ? { lan: true } : {}), pin, ...(embed.length ? { embed_on: embed } : {}) };
  }

  #flags(target: string, kind: string): string[] {
    if (kind === 'process') return [];
    const bound = [...this.#index.values()].flatMap((m) => m.bindings.filter((b) => b.kind !== 'process').map((b) => b.target));
    const l = lookalikes(target, bound);
    return [...(l.unicode ? [`shown as ${l.unicode}`] : []), ...l.flags];
  }

  #bind(f: Frame, ctx: Ctx): Answer {
    const id = this.#resolve(f.ref);
    ctx.rec.ref = id;
    const m = this.#index.get(id)!;
    if (f.remove) {
      const r = f.remove as { target?: unknown; consent_only?: unknown };
      let t: string;
      try { t = canonicalTarget(r.target as object).target; } catch { throw new Refused('not_bound'); }
      ctx.rec.target = t;
      const next = { ...m, bindings: r.consent_only === true ? m.bindings.map((b) => (b.target === t ? { ...b, consent: null } : b)) : m.bindings.filter((b) => b.target !== t) };
      this.store.setMeta(id, stripIndex(next));
      this.#revoked(id);
      return { ref: id, bindings: this.#index.get(id)!.bindings };
    }
    const b = this.#binding(f.add);
    ctx.rec.target = b.target;
    if (b.consent && m.class === 'sensitive') throw new Refused('class_policy', CONSENT_SENSITIVE);
    const flags = this.#flags(b.target, b.kind);
    const before = m.bindings.find((x) => x.target === b.target);
    const { id: id_ } = this.#approve(ctx, { verb: 'bind', ref: id, binding: cardBinding(b) }, {
      verb: 'bind', what: `${before ? 'Change' : 'Allow'} “${m.name}” ${before ? 'on' : 'to be used on'} ${b.target}`, name: m.name, origin: m.origin, username: m.username, target: b.target, scope: b.scope, class: m.class, flags, tier: 3, items: [cardBinding(b)],
      approving: `${b.consent ? `Standing consent: requests inside ${b.consent.scope.methods.join(', ')} ${b.consent.scope.paths.join(', ')} go ahead without asking, up to ${b.consent.rate_per_hour} an hour. ` : 'Every use asks first. '}Nothing else is covered: no other host, subdomain or port.`,
    }, true);
    if (b.consent) b.consent.approval_id = id_;
    this.store.setMeta(id, stripIndex({ ...m, bindings: [...m.bindings.filter((x) => x.target !== b.target), b] }));
    this.#forgetGrants(id);
    this.#reindex();
    return { ref: id, bindings: this.#index.get(id)!.bindings };
  }

  // A revocation (a binding removed, a consent withdrawn, details changed) re-keys the vault, so an
  // item file rolled back to before it doesn't open (S5). Grants for every changed item go too.
  #revoked(...ids: string[]): void {
    if (ids.length) this.store.rotateRoot();
    for (const id of ids) this.#forgetGrants(id);
    this.#reindex();
  }
  #forgetGrants(id: string): void { for (const g of [...this.#grants]) if (g.startsWith(`${id}|`)) this.#grants.delete(g); }

  // ---- share_scope (tier 3) -------------------------------------------------------------------

  // On a device that will hold a hub's vault: the hub broker's signing key, pinned at tier 3 before
  // anything is adopted (B4). Only before this device holds a vault.
  #pinHub(f: Frame, ctx: Ctx): Answer {
    const h = (f.hub ?? {}) as { signer?: unknown; name?: unknown };
    if (!str(h.signer, 60) || !/^[A-Za-z0-9+/=]+$/.test(h.signer) || !str(h.name, 80)) throw new Failed('A hub is pinned by its broker’s signing key and a name.');
    if (this.store.exists) throw new Failed('This device already holds a vault; it can’t be pinned to a hub.');
    const fp = createHash('sha256').update(h.signer).digest('hex').slice(0, 16);
    this.#approve(ctx, { verb: 'share_scope', hub: h.signer, name: h.name }, { verb: 'share_scope', what: `Hold the vault of the hub “${h.name}” (key ${fp})`, tier: 3, approving: 'This device will take that hub’s vault, and only that hub’s, from now on. Check the key matches the one the hub shows.' }, true);
    this.store.pinHub(h.signer, h.name);
    return { hub: { signer: fp } };
  }

  #share(f: Frame, ctx: Ctx): Answer {
    if (f.backend !== undefined) throw new Refused('wrong_target_kind', 'External password managers come in Phase 2; Nova Vault is the only backend now.');
    const d = (f.device ?? {}) as { id?: unknown; public_key?: unknown; name?: unknown; remove?: unknown };
    if (!str(d.id, 40)) throw new Failed('A holder is a device id.');
    ctx.rec.target = `device:${d.id}`;
    if (d.remove === true) {
      if (d.id === this.store.device().id) throw new Failed('This device can’t stop holding its own vault.');
      this.store.removeHolder(d.id);
      return { holders: Object.keys(this.store.header!.holders), text: 'That device no longer holds the vault; the vault was re-keyed.' };
    }
    if (!str(d.public_key, 60) || !str(d.name, 80)) throw new Failed('A holder brings its broker’s public key and a name.');
    const text = `The broker on “${d.name}” will be able to open every item in this vault (${this.#index.size} now, and every one added later). Nova core and its models are given no values.`;
    this.#approve(ctx, { verb: 'share_scope', device: d.id, public_key: d.public_key, name: d.name }, { verb: 'share_scope', what: `Let “${d.name}” hold Nova Vault`, target: `device:${d.id}`, tier: 3, approving: text }, true);
    this.store.enrollHolder(d.id, d.public_key, d.name);
    return { holders: Object.keys(this.store.header!.holders), text, outbox: true };
  }

  // ---- migration from vault.ts (§10, "Moving from today's vault") ------------------------------

  // Core never opens the old vault, and no answer depends on a value core chose (B2):
  //  - stage: the broker starts its own launcher on its own home (never a folder core names), which
  //    reads vault.ts's file and key and Era 2's Gmail files, and sends them to the broker by pipe.
  //    The answer is a count.
  //  - commit (tier 3, one card of names and kinds): each staged entry whose name is free becomes an
  //    unbound item (usable nowhere), marked as migrated from that old vault, and is read back. A
  //    name already taken by an item migrated from the same old vault counts as moved (a resumed
  //    run); a name taken by any other item stays in the old vault. Neither looks at a value. Then
  //    the launcher takes what moved out of the old vault.
  //  - propose (tier 3): one card of bindings and classes, metadata only.
  async #migrate(src: { migrate: unknown; proposals?: unknown }, ctx: Ctx): Promise<Answer> {
    if (src.migrate === 'propose') return this.#propose(src.proposals, ctx);
    const home = dirname(this.store.dir);
    if (src.migrate === 'stage') {
      const out = await this.#launch(['migrate', home], null);
      const items = new Map<string, Buffer>();
      let vaultId: string | null = null;
      let revision = '';
      for (const line of out.split('\n')) {
        if (!line) continue;
        let x: { vault_id?: unknown; revision?: unknown; name?: unknown; value?: unknown };
        try { x = JSON.parse(line); } catch { continue; }
        if ('vault_id' in x) { vaultId = typeof x.vault_id === 'string' ? x.vault_id : null; revision = typeof x.revision === 'string' ? x.revision : ''; continue; }
        if (items.size < MAX_STAGED && str(x.name, 200) && NAME.test(x.name) && typeof x.value === 'string' && x.value.length > 0 && x.value.length <= 64 * 1024) items.set(x.name, Buffer.from(x.value, 'utf8'));
      }
      for (const b of this.#staged?.items.values() ?? []) zero(b);
      if (!/^[0-9a-f]{64}$/.test(revision)) throw new Failed('The old vault snapshot is incomplete; nothing was staged.');
      this.#staged = { vaultId, revision, items };
      return { outcome: { staged: items.size } };
    }
    if (src.migrate !== 'commit') throw new Failed('A migration stages, commits, then proposes bindings.');
    const st = this.#staged;
    if (!st) throw new Failed('Nothing is staged.');
    const from = st.vaultId ?? 'era2';
    const plan = [...groupStaged(st.items)].map(([name, g]) => {
      const owner = [...this.#index.values()].find((x) => x.aliases.includes(`${ALIAS}${name}`));
      const revision = createHash('sha256').update(canonical(g.names.map((n) => [n, st.items.get(n)!.toString('base64')]))).digest('hex');
      return { name, g, revision, status: !owner ? 'move' : owner.provenance === 'migrated' && owner.migrated_from === from && owner.migrated_revision === revision ? 'moved' : 'kept' };
    });
    this.#approve(ctx, { verb: 'create', source: 'migrate', items: plan.map((x) => ({ name: x.name, kind: x.g.kind, status: x.status })) }, { verb: 'create', what: `Move ${plan.filter((x) => x.status === 'move').length} credential(s) from the old vault into Nova Vault`, tier: 3, items: plan.map((x) => ({ name: x.name, kind: x.g.kind, origin: x.g.origin, status: x.status })), approving: 'Each is moved inside the broker, unbound (usable nowhere until you bind it), read back, and only then removed from the old vault. A name already taken by another credential stays in the old vault.' }, true);
    this.#staged = null;
    const moved: string[] = [];
    let readBack = true;
    for (const x of plan) {
      if (x.status === 'kept') continue;
      if (x.status === 'move') {
        const meta: Meta = { name: x.name, aliases: [`${ALIAS}${x.name}`], kind: x.g.kind, origin: x.g.origin, username: x.g.username, class: suggestClass(x.g.origin, x.g.kind), per_use: false, created_at: this.#now().toISOString(), last_used: null, last_rotated: null, bindings: [], policy: DEFAULT_POLICY, provenance: 'migrated', migrated_from: from, migrated_revision: x.revision };
        const { id } = this.store.add(meta, x.g.value);
        if (x.g.pending) this.store.setPending(id, x.g.pending);
        const v = this.store.value(id);
        if (!sameBytes(v, x.g.value)) readBack = false;
        zero(v);
      }
      moved.push(...x.g.names);
    }
    for (const b of st.items.values()) zero(b);
    this.#reindex();
    ctx.rec.scope_item = `moved ${moved.length}`;
    if (!readBack) throw new Failed('An item didn’t read back from the new store; nothing was removed from the old vault.');
    const fin = await this.#launch(['finish', home], JSON.stringify({ vault_id: st.vaultId, revision: st.revision, names: moved }));
    let removed = 0;
    try { removed = Number(JSON.parse(fin.trim().split('\n').at(-1) ?? '{}').removed) || 0; } catch { removed = 0; }
    return { outcome: { migrated: plan.filter((x) => x.status === 'move').map((x) => x.name), moved: moved.length, kept: plan.filter((x) => x.status === 'kept').map((x) => x.name), read_back: true, removed } };
  }

  // The launcher for a migration step: started by the broker, on its own home, output by pipe, with
  // the old vault's folders added to what it may read, plus the writer lock (and finish writes).
  #launch(args: string[], input: string | null): Promise<string> {
    const home = args[1]!;
    const dirs = [join(home, 'vault'), join(home, 'connectors')];
    const grants = grantsIf([...dirs.map((d) => `--allow-fs-read=${d}/`), ...(args[0] === 'finish' ? dirs : [dirs[0]!]).map((d) => `--allow-fs-write=${d}/`)]);
    return new Promise((ok, fail) => {
      const child = spawn(process.execPath, [...grants, '--disable-sigusr1', '--disable-warning=ExperimentalWarning', LAUNCH, ...args], { env: { TZ: 'UTC', ...(this.#o.keyMode === 'file' ? { NOVA_VAULT_KEY: 'file' } : {}) }, stdio: ['ignore', 'pipe', 'ignore', 'pipe'] });
      child.stdio[3]!.on('error', () => { /* the launcher stopped before reading it */ });
      (child.stdio[3] as NodeJS.WritableStream).end(input ?? '');
      const chunks: Buffer[] = [];
      let n = 0;
      child.stdout!.on('data', (x: Buffer) => { n += x.length; if (n <= 80 * 1024 * 1024) chunks.push(x); });
      child.on('close', (code) => (code === 0 ? ok(Buffer.concat(chunks).toString('utf8')) : fail(new Failed('The old vault couldn’t be read or changed; nothing was moved or removed.'))));
    });
  }

  #propose(p: unknown, ctx: Ctx): Answer {
    const proposals = (p && typeof p === 'object' ? p : {}) as Record<string, { origin?: unknown; class?: unknown; bind?: unknown }>;
    const plan = Object.entries(proposals).slice(0, 200).map(([name, x]) => {
      const id = [...this.#index.entries()].find(([, m]) => m.aliases.includes(`${ALIAS}${name}`))?.[0];
      if (!id) throw new Refused('unknown_ref');
      const m = this.#index.get(id)!;
      let origin = m.origin;
      if (x.origin !== undefined && x.origin !== null) { try { origin = canonicalTarget({ kind: 'http', origin: x.origin }).target; } catch { throw new Failed('A proposed site isn’t a canonical https origin.'); } }
      const cls = x.class === 'standard' || x.class === 'sensitive' ? x.class : suggestClass(origin, m.kind);
      const proposed = Array.isArray(x.bind) ? x.bind.slice(0, 5).map((b) => this.#binding(b)) : [];
      // The card, approval digest and saved policy all describe the complete resulting set.
      const bindings = [...m.bindings.filter((b) => !proposed.some((n) => n.target === b.target)), ...proposed];
      if (cls === 'sensitive' && bindings.some((b) => b.consent)) throw new Refused('class_policy', CONSENT_SENSITIVE);
      return { id, m, origin, cls, bindings, proposed };
    });
    const items = plan.map((x) => ({ name: x.m.name, kind: x.m.kind, origin: x.origin, username: x.m.username, class: x.cls, bindings: x.bindings.map(cardBinding), target: x.bindings.map((b) => b.target).join(', ') || 'unbound', flags: x.bindings.flatMap((b) => this.#flags(b.target, b.kind)) }));
    const { id: approval } = this.#approve(ctx, { verb: 'create', source: 'migrate', items: plan.map((x) => ({ ref: x.id, origin: x.origin, class: x.cls, bindings: x.bindings.map(cardBinding) })) }, { verb: 'create', what: `Bind ${plan.length} credential(s) moved from the old vault`, tier: 3, items, approving: 'Each is usable only on the target shown. Items left unbound can’t be used until you bind them.' }, true);
    for (const x of plan) {
      for (const b of x.proposed) if (b.consent) b.consent.approval_id = approval;
      this.store.setMeta(x.id, stripIndex({ ...x.m, origin: x.origin, class: x.cls, bindings: x.bindings }));
    }
    this.#revoked(...plan.map((x) => x.id));
    return { refs: plan.map((x) => this.#refMeta(x.id)) };
  }
}

interface Ctx { rec: Entry; task: { id: string } | null; approval: ApprovalIn | undefined }

// A program's request from core: its arguments (checked by #use), a working folder, environment
// variables from a narrow allow-list, stdin, and a time limit. Anything else is refused.
function programRequest(req: { cwd?: unknown; env?: unknown; stdin?: unknown; timeout_ms?: unknown }) {
  if (req.cwd !== undefined && (typeof req.cwd !== 'string' || !req.cwd.startsWith('/') || req.cwd.length > 500)) throw new Refused('out_of_scope', 'A working folder is an absolute path.');
  const env: Record<string, string> = {};
  if (req.env !== undefined) {
    if (!req.env || typeof req.env !== 'object' || Object.keys(req.env).length > 32) throw new Refused('out_of_scope', 'A program’s environment is a small map.');
    for (const [k, v] of Object.entries(req.env)) {
      if (!PROGRAM_ENV.test(k) || typeof v !== 'string' || v.length > 4096) throw new Refused('out_of_scope', 'Only plain settings go into a program’s environment (no loader, interpreter or configuration paths).');
      env[k] = v;
    }
  }
  if (req.stdin !== undefined && (typeof req.stdin !== 'string' || req.stdin.length > 1024 * 1024)) throw new Refused('out_of_scope', 'A program’s input is text, up to 1 MiB.');
  const t = req.timeout_ms === undefined ? 600_000 : Number(req.timeout_ms);
  if (!Number.isInteger(t) || t < 1000 || t > 3_600_000) throw new Refused('out_of_scope', 'A program’s time limit is 1 second to 1 hour.');
  return { cwd: req.cwd as string | undefined, env, stdin: typeof req.stdin === 'string' ? req.stdin : '', timeout: t };
}

// An unlock factor is sealed to the vault, the factor and this boot (seal.ts, unlockDigest).
const unlockDigest = (vid: string, factor: string, boot: string) => createHash('sha256').update(`nova-broker-unlock|${vid}|${factor}|${boot}`).digest('hex');

const stripIndex = (m: Meta & { version?: number; pending?: boolean }): Meta => { const { version: _v, pending: _p, ...rest } = m; return rest; };
const cardBinding = (b: Binding) => ({ target: b.target, kind: b.kind, scope: b.scope, inject: b.inject, consent: b.consent ? { scope: b.consent.scope, rate_per_hour: b.consent.rate_per_hour } : null, lan: !!b.lan, pin: b.pin ?? null, embed_on: b.embed_on ?? [] });

const REFUSED_HEADERS = /^(authorization|proxy-authorization|cookie|host|content-length|transfer-encoding|connection|upgrade|te|trailer|expect|keep-alive|proxy-connection)$/i;
function callerHeaders(h: unknown, inj: Inject): Record<string, string> {
  const out: Record<string, string> = {};
  if (h === undefined || h === null) return out;
  if (typeof h !== 'object' || Array.isArray(h) || Object.keys(h).length > 32) throw new Refused('out_of_scope', 'Request headers are a small map of names to text.');
  for (const [k, v] of Object.entries(h)) {
    if (!/^[A-Za-z0-9-]{1,60}$/.test(k) || typeof v !== 'string' || v.length > 4096 || /[\r\n]/.test(v) || REFUSED_HEADERS.test(k) || (inj.header && k.toLowerCase() === inj.header.toLowerCase())) throw new Refused('out_of_scope', 'A request carries a header a caller doesn’t set.');
    out[k.toLowerCase()] = v;
  }
  return out;
}

const hmac = (key: Buffer, body: Buffer, inj: Inject) => `${inj.prefix ?? ''}${createHmac('sha256', key).update(body).digest(inj.format === 'base64' ? 'base64' : 'hex')}`;

function inject(headers: Record<string, string>, inj: Inject, value: Buffer, username: string | null, body: Buffer | null) {
  const v = value.toString('utf8');
  if (/[\r\n]/.test(v) && inj.how !== 'sign') throw new Failed('That value can’t go in a header.');
  if (inj.how === 'bearer') headers.authorization = `Bearer ${v}`;
  else if (inj.how === 'basic') headers.authorization = `Basic ${Buffer.from(`${username ?? ''}:${v}`).toString('base64')}`;
  else if (inj.how === 'header') headers[inj.header!.toLowerCase()] = `${inj.prefix ?? ''}${v}`;
  else if (inj.how === 'sign') {
    const signature = hmac(value, body ?? Buffer.alloc(0), inj);
    headers[inj.header!.toLowerCase()] = signature;
    return signature;
  }
  return null;
}

// The old vault's names, grouped into items: a sign-in's username, password and pending parts are
// one login item, its username in the metadata (§10: "A web login is one item").
function groupStaged(staged: Map<string, Buffer>) {
  const out = new Map<string, { names: string[]; kind: string; origin: string | null; username: string | null; value: Buffer; pending: Buffer | null }>();
  const logins = new Map<string, { user?: Buffer; pass?: Buffer; pending?: Buffer }>();
  for (const [name, v] of staged) {
    const lm = /^browser\/login\/([^/]+)\/(username|password|pending)$/.exec(name);
    if (lm) { const e = logins.get(lm[1]!) ?? {}; e[lm[2] === 'username' ? 'user' : lm[2] === 'password' ? 'pass' : 'pending'] = v; logins.set(lm[1]!, e); continue; }
    const kind = /^provider\/|^capture\/|^decisions\./.test(name) ? 'api_key' : /^connector\/gmail\//.test(name) ? 'oauth' : /^connector\/|^network\/[^/]+\/token$/.test(name) ? 'token' : 'secret';
    out.set(name, { names: [name], kind, origin: null, username: null, value: v, pending: null });
  }
  for (const [enc, e] of logins) {
    if (!e.pass) continue;
    const host = enc.replace(/_(\d{1,5})$/, ':$1');
    let origin: string | null = null;
    try { origin = canonicalTarget({ kind: 'web', origin: `${/^(localhost|127\.)/.test(host) ? 'http' : 'https'}://${host}` }).target; } catch { origin = null; }
    const base = `browser/login/${enc}`;
    out.set(`${base}/password`, { names: [`${base}/username`, `${base}/password`, `${base}/pending`].filter((n) => staged.has(n)), kind: 'login', origin, username: e.user ? e.user.toString('utf8') : null, value: e.pass, pending: e.pending ?? null });
  }
  return out;
}
```

### `src/broker/server.ts`

```ts
// The broker's IPC endpoint (§3 "IPC"): a Unix-domain socket in a 0700 folder (a named pipe on
// Windows, untested there). It is the only thing the broker listens on: no port, no HTTP server, no
// inspector. Frames are newline-delimited JSON with a size cap and an id per request; unknown
// messages and unknown fields are refused. Every connection says hello with a token within 10
// seconds, or is closed.
//
// Who is calling (Phase 1): the socket's permissions decide who can connect, and a 256-bit token
// per boot says which role (core or the supervisor), given to each by the supervisor over Node's
// IPC channel, never argv or the environment. Node's standard library exposes no peer credentials
// (SO_PEERCRED, getpeereid), so a process running as the same OS account that obtains a token can
// speak as that role: it can make only the uses that role could, inside bindings, scopes, consents
// and rate caps. Nothing on this socket hands out a value: the broker's launcher is its own child,
// reached by pipe.
//
// Every answer is checked against the answer schema (no field that can carry a value) before it is
// written. Answers aren't scrubbed as a whole: scrubbing text core wrote would tell core whether it
// guessed a value. Only what a target sent back is scrubbed, in the verb that used it.
import { timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import type { Broker } from './broker.ts';
import { ERRORS, MAX_FRAME, checkAnswer, parseFrame, type ProtocolError, type Role } from './protocol.ts';

export interface Tokens { core: string; supervisor: string }
const MAX_CONNECTIONS = 32;
const HELLO_MS = 10_000;

const same = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export function socketPath(dir: string, platform = process.platform): string {
  return platform === 'win32' ? `\\\\.\\pipe\\nova-broker-${Buffer.from(dir).toString('hex').slice(-32)}` : `${dir}/run/broker.sock`;
}

export function serve(broker: Broker, path: string, tokens: Tokens): Promise<Server> {
  if (!/^[0-9a-f]{64}$/.test(tokens.core) || !/^[0-9a-f]{64}$/.test(tokens.supervisor) || tokens.core === tokens.supervisor) throw new Error('the broker needs two distinct 256-bit tokens');
  if (process.platform !== 'win32') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    rmSync(path, { force: true });
  }
  const badHellos: number[] = [];
  const server = createServer({ allowHalfOpen: false }, (sock) => connection(broker, sock, tokens, badHellos));
  server.maxConnections = MAX_CONNECTIONS;
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen({ path, exclusive: true }, () => {
      if (process.platform !== 'win32') chmodSync(path, 0o600);
      ok(server);
    });
  });
}

function connection(broker: Broker, sock: Socket, tokens: Tokens, badHellos: number[]) {
  let role: Role | null = null;
  let buf = '';
  let chain = Promise.resolve();
  sock.setEncoding('utf8');
  const hello = setTimeout(() => { if (!role) sock.destroy(); }, HELLO_MS);
  hello.unref();
  const write = (a: Record<string, unknown>) => { if (!sock.destroyed) sock.write(`${JSON.stringify(a)}\n`); };
  const err = (id: string | number | null, e: ProtocolError) => write({ id, error: e, words: ERRORS[e] });
  const answer = (a: Record<string, unknown>) => {
    if (checkAnswer(a)) {
      broker.problem = 'The broker refused to send an answer that had a field it doesn’t allow. This is a bug; nothing was sent.';
      broker.audit.write({ verb: 'answer', ref: null, target: null, scope_item: null, outcome: 'refused:schema', tier: null, approval_id: null, task: null, role: role ?? 'core' });
      return write({ id: a.id, error: 'failed', words: ERRORS.failed });
    }
    write(a);
  };
  const handle = async (line: string) => {
    const p = parseFrame(line);
    if ('error' in p) return err(p.id, p.error);
    const f = p.frame;
    if (f.m === 'hello') {
      if (role) return err(f.id, 'not_allowed');
      const t = typeof f.token === 'string' ? f.token : '';
      role = same(t, tokens.core) ? 'core' : same(t, tokens.supervisor) ? 'supervisor' : null;
      if (!role) {
        // Recorded, a few a minute at most: a flood of bad hellos can't fill the audit log.
        const now = Date.now();
        while (badHellos.length && badHellos[0]! < now - 60_000) badHellos.shift();
        if (badHellos.length < 10) { badHellos.push(now); broker.audit.write({ verb: 'hello', ref: null, target: null, scope_item: null, outcome: 'refused:token', tier: null, approval_id: null, task: null, role: 'core' }); }
        err(f.id, 'unauthenticated');
        return void sock.end();
      }
      clearTimeout(hello);
      return answer({ id: f.id, ok: true, role });
    }
    if (!role) return err(f.id, 'unauthenticated');
    answer({ id: f.id, ...(await broker.handle(role, f)) });
  };
  sock.on('data', (chunk: string) => {
    buf += chunk;
    if (buf.length > MAX_FRAME && !buf.includes('\n')) { err(null, 'too_large'); sock.destroy(); return; }
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      chain = chain.then(() => handle(line)).catch(() => err(null, 'failed'));
    }
  });
  sock.on('error', () => sock.destroy());
  sock.on('close', () => clearTimeout(hello));
}
```

### `src/broker/store.ts`

```ts
// Nova Vault's store (docs/plans/vault-broker.md §10). In <home>/broker/, 0700; kept out of the
// home's git, the sync journal and checkpoints, and only items/ goes into a backup.
//
//   vault.json       the header: vault id, format, Argon2id parameters and salt, the generation of
//                    the root key, and the root key sealed to each factor's public key (wraps:
//                    passphrase, recovery, passkey:<id>, device:<id>). Holder devices and passkeys
//                    registered for approvals, by public key.
//   items/<id>.json  one per item: a random id, a version, the root key's generation, the item key
//                    sealed under the root key, the metadata sealed under the root key, and the value
//                    sealed under the item key. Associated data names the vault, the item, the
//                    version and the kind, so an item can't be moved, swapped or rolled back
//                    between files without failing.
//   device.json      this device's broker key (public half and id). The private half is in the OS
//                    key store, or device.key (0600) when none answers. Never synced.
//   outbox/          what holder devices receive: the header with device wraps and factor public
//                    keys only (no factor wrap travels), beside items/ (ciphertext).
//
// Deleting an item destroys its blob and rotates the root key, re-wrapping every other item key,
// so an older copy of items/ (a backup, a stale sync entry) opens with no key that still exists.
// A rotation cut short is finished at the next unlock (the header holds both generations).
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argon2id, b64, calibrate, factorFromSeed, hkdf, newFactor, open, openWrap, seal, sealTo, signText, signerFromSeed, verifyText, type Factor, type Kdf, type Sealed, type Wrap } from './crypto.ts';
import { canonical } from './protocol.ts';
import type { KeyObject } from 'node:crypto';
import type { KeyStore } from './keystore.ts';
import type { Binding } from './protocol.ts';

export interface Meta {
  name: string; aliases: string[]; kind: string; origin: string | null; username: string | null;
  class: 'standard' | 'sensitive'; per_use: boolean; created_at: string; last_used: string | null; last_rotated: string | null;
  bindings: Binding[]; policy: { length: number; alphabet: string };
  // Where the value came from, for health flags that must answer no guess of core's (§8): generated
  // here, migrated by the broker's own launcher, sealed with a passkey approval, or sealed through
  // core's relay (a value core could have chosen). Older items have none: treated as `sealed`.
  provenance?: 'generated' | 'migrated' | 'sealed-passkey' | 'sealed'; migrated_from?: string;
  migrated_revision?: string;
}
interface ItemFile { v: 1; id: string; gen: number; version: number; key: Sealed; meta: Sealed; value: Sealed; pending?: { version: number; key: Sealed; value: Sealed } }
export interface Passkey { public_key: string; rp_id: string; origins: string[]; sign_count: number; registered_at: string }
export interface Holder { name: string; public: string; enrolled_at: string }
export interface Header {
  v: 1; id: string; created_at: string; kdf: Kdf; unlock_mode: 'auto' | 'ask'; gen: number;
  wraps: Record<string, Wrap>; next?: { gen: number; wraps: Record<string, Wrap> };
  holders: Record<string, Holder>; passkeys: Record<string, Passkey>;
  // On a holder: the signing key of the hub it adopted from, pinned at the first adoption.
  hub_signer?: string;
  // Made on this device (`local`) or adopted from a hub. A local vault never adopts another.
  origin?: 'local' | 'adopted';
}
// What travels to holders: device wraps, and every factor's public key (so a holder's broker can
// seal the root key to the same factors itself). No passphrase, recovery or passkey wrap moves.
export interface OutboxHeader { v: 1; id: string; kdf: Kdf; unlock_mode: 'auto' | 'ask'; gen: number; device_wraps: Record<string, Wrap>; factor_pubs: Record<string, string>; holders: Record<string, Holder>; passkeys: Record<string, Passkey>; from: string; signer: string; sig?: string }

const ID = /^[a-z0-9]{20,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const wrapInfo = (vid: string, name: string, gen: number) => `nova-broker-wrap|${vid}|${name}|${gen}`;
const keyAad = (vid: string, id: string, version: number) => `item-key|${vid}|${id}|${version}`;
const metaAad = (vid: string, id: string) => `item-meta|${vid}|${id}`;
const valueAad = (vid: string, id: string, version: number, kind: string) => `item-value|${vid}|${id}|${version}|${kind}`;
export const newItemId = () => randomBytes(15).toString('hex').replace(/^/, 'i');

function writeAtomic(path: string, text: string) {
  writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  chmodSync(path, 0o600);
}
const zero = (b: Buffer | null | undefined) => { if (b) b.fill(0); };

// The factors a person brings, as seeds for X25519: Argon2id for the passphrase, HKDF for the rest.
export const passphraseFactor = (pass: Buffer, kdf: Kdf) => factorFromSeed(argon2id(pass, kdf));
export const recoveryFactor = (key: Buffer) => factorFromSeed(hkdf(key, 'nova-broker-recovery', 'factor'));
export const passkeyFactor = (prf: Buffer, id: string) => factorFromSeed(hkdf(prf, `nova-broker-passkey|${id}`, 'factor'));

// deviceStore is asked for two accounts: device-<id> (the unlock key) and sign-<id> (the signing key).
export interface StoreOptions { dir: string; deviceStore: (account: string) => KeyStore; kdf?: Kdf; now?: () => Date }

export class Store {
  readonly dir: string;
  #o: StoreOptions;
  #h: Header | null = null;
  #root: Buffer | null = null;
  #device: { id: string; factor: Factor; store: KeyStore } | null = null;
  #signer: { priv: KeyObject; pub: string } | null = null;
  // last_used is kept here and written with the item's next change, or at lock.
  #used = new Map<string, string>();

  constructor(o: StoreOptions) {
    this.#o = o;
    this.dir = o.dir;
    mkdirSync(join(o.dir, 'items'), { recursive: true, mode: 0o700 });
    chmodSync(o.dir, 0o700);
    this.#h = existsSync(this.#hp) ? this.#readHeader() : null;
  }

  get #hp() { return join(this.dir, 'vault.json'); }
  #now() { return (this.#o.now?.() ?? new Date()).toISOString(); }
  get exists() { return !!this.#h; }
  get unlocked() { return !!this.#root; }
  get header(): Header | null { return this.#h; }

  #readHeader(): Header {
    const h = JSON.parse(readFileSync(this.#hp, 'utf8')) as Header;
    if (h?.v !== 1 || !UUID.test(h.id) || !h.wraps || !h.kdf) throw new Error('The vault’s header isn’t one the broker knows.');
    return h;
  }
  #writeHeader() { writeAtomic(this.#hp, `${JSON.stringify(this.#h)}\n`); }

  // ---- this device's broker key ---------------------------------------------------------------

  device(): { id: string; public: string; store: string } {
    if (!this.#device) {
      const p = join(this.dir, 'device.json');
      let d: { id: string; public: string } | null = null;
      try { d = JSON.parse(readFileSync(p, 'utf8')); } catch { /* none yet */ }
      if (d && UUID.test(d.id)) {
        const store = this.#o.deviceStore(`device-${d.id}`);
        const seed = store.read();
        if (!seed) throw new Error(`This device’s broker key isn’t in ${store.name} any more, so the vault can’t open with it. Unlock with your passphrase or recovery key; a new device key is made then.`);
        const factor = factorFromSeed(seed);
        zero(seed);
        if (factor.pub !== d.public) throw new Error('This device’s broker key doesn’t match its record.');
        this.#device = { id: d.id, factor, store };
      } else {
        const id = randomUUID();
        const store = this.#o.deviceStore(`device-${id}`);
        const { seed, factor } = newFactor();
        store.write(seed);
        zero(seed);
        writeAtomic(p, `${JSON.stringify({ id, public: factor.pub })}\n`);
        this.#device = { id, factor, store };
      }
    }
    return { id: this.#device.id, public: this.#device.factor.pub, store: this.#device.store.kind };
  }

  // A new key pair for this device (after a delete, or when its key is gone), re-sealed for itself.
  #renewDevice() {
    const old = this.#device;
    const id = old?.id ?? randomUUID();
    const store = old?.store ?? this.#o.deviceStore(`device-${id}`);
    const { seed, factor } = newFactor();
    store.write(seed);
    zero(seed);
    writeAtomic(join(this.dir, 'device.json'), `${JSON.stringify({ id, public: factor.pub })}\n`);
    this.#device = { id, factor, store };
    return this.#device;
  }

  // This device's signing key (stable across renewals of its unlock key), made on first use.
  #sign(): { priv: KeyObject; pub: string } {
    if (!this.#signer) {
      const id = this.device().id;
      const store = this.#o.deviceStore(`sign-${id}`);
      let seed = store.read();
      if (!seed) { seed = randomBytes(32); store.write(seed); }
      this.#signer = signerFromSeed(seed);
      zero(seed);
    }
    return this.#signer;
  }

  // ---- create, unlock, lock -------------------------------------------------------------------

  create(o: { id?: string; passphrase: Buffer; recovery?: Buffer | null; passkeys?: { id: string; prf?: Buffer | null; public_key: string; rp_id: string; origins: string[] }[]; unlock_mode?: 'auto' | 'ask' }): void {
    if (this.#h) throw new Error('There is a vault here already.');
    if (o.passphrase.length < 8) throw new Error('A passphrase is at least 8 characters.');
    const kdf = this.#o.kdf ?? calibrate();
    const id = o.id && UUID.test(o.id) ? o.id : randomUUID();
    const root = randomBytes(32);
    let dev: { id: string; public: string };
    try { dev = this.device(); } catch { const d = this.#renewDevice(); dev = { id: d.id, public: d.factor.pub }; }
    const h: Header = { v: 1, id, created_at: this.#now(), kdf, unlock_mode: o.unlock_mode ?? 'auto', gen: 1, wraps: {}, holders: {}, passkeys: {}, origin: 'local' };
    const add = (name: string, f: Factor) => { h.wraps[name] = sealTo(f.pub, root, wrapInfo(id, name, 1)); };
    add('passphrase', passphraseFactor(o.passphrase, kdf));
    if (o.recovery) add('recovery', recoveryFactor(o.recovery));
    for (const pk of o.passkeys ?? []) {
      h.passkeys[pk.id] = { public_key: pk.public_key, rp_id: pk.rp_id, origins: pk.origins, sign_count: 0, registered_at: this.#now() };
      if (pk.prf) add(`passkey:${pk.id}`, passkeyFactor(pk.prf, pk.id));
    }
    h.holders[dev.id] = { name: 'this device', public: dev.public, enrolled_at: this.#now() };
    if (h.unlock_mode === 'auto') add(`device:${dev.id}`, this.#device!.factor);
    this.#h = h;
    this.#writeHeader();
    this.#root = root;
  }

  // Opens the root key with one factor. A rotation cut short is finished here.
  unlock(f: { kind: 'passphrase'; secret: Buffer } | { kind: 'recovery'; secret: Buffer } | { kind: 'passkey'; id: string; secret: Buffer } | { kind: 'device' }): void {
    const h = this.#h;
    if (!h) throw new Error('There is no vault yet.');
    let name: string;
    let factor: Factor;
    if (f.kind === 'device') {
      const dev = this.device();
      name = `device:${dev.id}`;
      factor = this.#device!.factor;
    } else if (f.kind === 'passphrase') { name = 'passphrase'; factor = passphraseFactor(f.secret, h.kdf); }
    else if (f.kind === 'recovery') { name = 'recovery'; factor = recoveryFactor(f.secret); }
    else { name = `passkey:${f.id}`; factor = passkeyFactor(f.secret, f.id); }
    const w = h.wraps[name];
    if (!w) throw new Error(f.kind === 'device' ? 'This device can’t open the vault by itself (it is set to ask after a restart, or isn’t a holder).' : 'That factor isn’t one this vault knows.');
    let root: Buffer;
    try { root = openWrap(factor, w, wrapInfo(h.id, name, h.gen)); } catch { throw new Error('That doesn’t open the vault.'); }
    this.#root = root;
    if (h.next) {
      const nw = h.next.wraps[name];
      const next = nw ? openWrap(factor, nw, wrapInfo(h.id, name, h.next.gen)) : null;
      if (next) this.#finishRotation(next);
    }
    // A device key that went missing (unlocked by passphrase or recovery): a new one for itself.
    if (f.kind !== 'device' && h.unlock_mode === 'auto') {
      try { this.device(); } catch { this.#renewDevice(); }
      const dn = `device:${this.#device!.id}`;
      if (!h.wraps[dn] || h.wraps[dn]!.pub !== this.#device!.factor.pub) {
        h.wraps[dn] = sealTo(this.#device!.factor.pub, this.#root, wrapInfo(h.id, dn, h.gen));
        h.holders[this.#device!.id] = { name: 'this device', public: this.#device!.factor.pub, enrolled_at: this.#now() };
        this.#writeHeader();
      }
    }
  }

  lock(): void {
    try { if (this.#root) this.#flushUsed(); } catch { /* best effort */ }
    zero(this.#root);
    this.#root = null;
  }

  #need(): Buffer {
    if (!this.#root) throw new Error('locked');
    return this.#root;
  }

  // ---- items ----------------------------------------------------------------------------------

  #itemPath(id: string) {
    if (!ID.test(id)) throw new Error('not an item id');
    return join(this.dir, 'items', `${id}.json`);
  }
  #readItem(id: string): ItemFile {
    const f = JSON.parse(readFileSync(this.#itemPath(id), 'utf8')) as ItemFile;
    // A file moved to another name is refused before anything is opened.
    if (f?.v !== 1 || f.id !== id) throw new Error(`item ${id} isn’t the file it claims to be`);
    return f;
  }
  ids(): string[] {
    return readdirSync(join(this.dir, 'items')).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((n) => ID.test(n)).sort();
  }

  // Every item's metadata. One that fails to open (tampered, swapped, damaged) is reported on its
  // own, and the others still open.
  metas(): { items: Map<string, Meta & { version: number; pending: boolean }>; broken: string[] } {
    const root = this.#need();
    const items = new Map<string, Meta & { version: number; pending: boolean }>();
    const broken: string[] = [];
    for (const id of this.ids()) {
      try {
        const f = this.#readItem(id);
        if (f.gen !== this.#h!.gen) throw new Error('stale generation');
        const m = JSON.parse(open(root, f.meta, metaAad(this.#h!.id, id)).toString('utf8')) as Meta;
        // The item key and the value must open too, or the item is broken (and reported alone).
        for (const part of [{ version: f.version, key: f.key, value: f.value }, ...(f.pending ? [f.pending] : [])]) {
          const ik = open(root, part.key, keyAad(this.#h!.id, id, part.version));
          try { zero(open(ik, part.value, valueAad(this.#h!.id, id, part.version, m.kind))); } finally { zero(ik); }
        }
        const used = this.#used.get(id);
        items.set(id, { ...m, last_used: used ?? m.last_used, version: f.version, pending: !!f.pending });
      } catch { broken.push(id); }
    }
    return { items, broken };
  }

  meta(id: string): Meta & { version: number; pending: boolean } {
    const root = this.#need();
    const f = this.#readItem(id);
    const m = JSON.parse(open(root, f.meta, metaAad(this.#h!.id, id)).toString('utf8')) as Meta;
    return { ...m, last_used: this.#used.get(id) ?? m.last_used, version: f.version, pending: !!f.pending };
  }

  // The value, inside the broker only. The caller zeroes the buffer when done.
  value(id: string, which: 'current' | 'pending' = 'current'): Buffer {
    const root = this.#need();
    const f = this.#readItem(id);
    if (f.gen !== this.#h!.gen) throw new Error('stale generation');
    const m = JSON.parse(open(root, f.meta, metaAad(this.#h!.id, id)).toString('utf8')) as Meta;
    const part = which === 'pending' ? f.pending : { version: f.version, key: f.key, value: f.value };
    if (!part) throw new Error('no pending version');
    const ik = open(root, part.key, keyAad(this.#h!.id, id, part.version));
    try { return open(ik, part.value, valueAad(this.#h!.id, id, part.version, m.kind)); } finally { zero(ik); }
  }

  #write(f: ItemFile) { writeAtomic(this.#itemPath(f.id), `${JSON.stringify(f)}\n`); }
  #sealMeta(id: string, m: Meta): Sealed {
    const { version: _v, pending: _p, ...plain } = m as Meta & { version?: number; pending?: boolean };
    return seal(this.#need(), Buffer.from(JSON.stringify(plain), 'utf8'), metaAad(this.#h!.id, id));
  }
  #sealValue(id: string, version: number, kind: string, value: Buffer): { key: Sealed; value: Sealed } {
    const ik = randomBytes(32);
    try {
      return { key: seal(this.#need(), ik, keyAad(this.#h!.id, id, version)), value: seal(ik, value, valueAad(this.#h!.id, id, version, kind)) };
    } finally { zero(ik); }
  }

  add(meta: Meta, value: Buffer): { id: string; version: number } {
    this.#need();
    const id = newItemId();
    this.#write({ v: 1, id, gen: this.#h!.gen, version: 1, meta: this.#sealMeta(id, meta), ...this.#sealValue(id, 1, meta.kind, value) });
    return { id, version: 1 };
  }

  setMeta(id: string, meta: Meta): void {
    const f = this.#readItem(id);
    const cur = this.meta(id);
    if (cur.kind !== meta.kind) throw new Error('an item’s kind doesn’t change');
    this.#used.delete(id);
    this.#write({ ...f, meta: this.#sealMeta(id, meta) });
  }

  setValue(id: string, value: Buffer): number {
    const f = this.#readItem(id);
    const m = this.meta(id);
    const version = Math.max(f.version, f.pending?.version ?? 0) + 1;
    this.#used.delete(id);
    const { pending: _drop, ...rest } = f;
    this.#write({ ...rest, version, meta: this.#sealMeta(id, { ...m, last_rotated: this.#now() }), ...this.#sealValue(id, version, m.kind, value) });
    return version;
  }

  setPending(id: string, value: Buffer): number {
    const f = this.#readItem(id);
    const m = this.meta(id);
    const version = f.version + 1;
    this.#write({ ...f, pending: { version, ...this.#sealValue(id, version, m.kind, value) } });
    return version;
  }

  commitPending(id: string): number {
    const f = this.#readItem(id);
    if (!f.pending) throw new Error('no pending version');
    const m = this.meta(id);
    const { pending, ...rest } = f;
    this.#write({ ...rest, version: pending.version, key: pending.key, value: pending.value, meta: this.#sealMeta(id, { ...m, last_rotated: this.#now() }) });
    return pending.version;
  }

  dropPending(id: string): void {
    const f = this.#readItem(id);
    const { pending: _p, ...rest } = f;
    this.#write(rest);
  }

  touch(id: string): void { this.#used.set(id, this.#now()); }
  #flushUsed() {
    for (const [id, at] of this.#used) {
      try { const m = this.meta(id); this.#write({ ...this.#readItem(id), meta: this.#sealMeta(id, { ...m, last_used: at }) }); } catch { /* gone */ }
    }
    this.#used.clear();
  }

  // Deleting: the blob goes, then the root key is rotated (and this device's own key renewed), so
  // nothing that still exists opens an older copy of the item.
  remove(id: string): void {
    this.#need();
    rmSync(this.#itemPath(id), { force: true });
    this.#used.delete(id);
    this.rotateRoot();
    this.#renewSelf();
  }

  // After the rotation, so a crash between the two costs one passphrase unlock, never an item: a
  // device key that no longer matches is replaced at the next unlock with another factor.
  #renewSelf(): void {
    const h = this.#h!;
    if (h.unlock_mode !== 'auto' || !this.#device || !h.wraps[`device:${this.#device.id}`]) return;
    const dev = this.#renewDevice();
    h.wraps[`device:${dev.id}`] = sealTo(dev.factor.pub, this.#need(), wrapInfo(h.id, `device:${dev.id}`, h.gen));
    h.holders[dev.id] = { ...(h.holders[dev.id] ?? { name: 'this device', enrolled_at: this.#now() }), public: dev.factor.pub };
    this.#writeHeader();
    this.writeOutbox();
  }

  rotateRoot(): void {
    const h = this.#h!;
    const next = randomBytes(32);
    const gen = h.gen + 1;
    h.next = { gen, wraps: Object.fromEntries(Object.entries(h.wraps).map(([n, w]) => [n, sealTo(w.pub, next, wrapInfo(h.id, n, gen))])) };
    this.#writeHeader();
    this.#finishRotation(next);
    this.writeOutbox();
  }

  #finishRotation(next: Buffer): void {
    const h = this.#h!;
    const root = this.#need();
    const gen = h.next!.gen;
    for (const id of this.ids()) {
      let f: ItemFile;
      try { f = this.#readItem(id); } catch { continue; }
      if (f.gen === gen) continue;
      try {
        const rewrap = (s: Sealed, version: number) => { const ik = open(root, s, keyAad(h.id, id, version)); try { return seal(next, ik, keyAad(h.id, id, version)); } finally { zero(ik); } };
        const meta = seal(next, open(root, f.meta, metaAad(h.id, id)), metaAad(h.id, id));
        this.#write({ ...f, gen, meta, key: rewrap(f.key, f.version), ...(f.pending ? { pending: { ...f.pending, key: rewrap(f.pending.key, f.pending.version) } } : {}) });
      } catch { /* a broken item stays broken; it is reported by metas() */ }
    }
    h.gen = gen;
    h.wraps = h.next!.wraps;
    delete h.next;
    this.#writeHeader();
    zero(root);
    this.#root = next;
  }

  // ---- holders and sync (§10 "Sync between devices") ------------------------------------------

  enrollHolder(id: string, pub: string, name: string): void {
    if (!UUID.test(id)) throw new Error('not a device id');
    const h = this.#h!;
    h.holders[id] = { name, public: pub, enrolled_at: this.#now() };
    h.wraps[`device:${id}`] = sealTo(pub, this.#need(), wrapInfo(h.id, `device:${id}`, h.gen));
    this.#writeHeader();
    this.writeOutbox();
  }

  // Removing a holder: its wrap goes and the root key rotates, so blobs written from now on don't
  // open with what it held.
  removeHolder(id: string): void {
    const h = this.#h!;
    delete h.holders[id];
    delete h.wraps[`device:${id}`];
    this.rotateRoot();
    this.writeOutbox();
  }

  writeOutbox(): OutboxHeader | null {
    const h = this.#h;
    if (!h || Object.keys(h.holders).length < 2) return null;
    const out: OutboxHeader = {
      v: 1, id: h.id, kdf: h.kdf, unlock_mode: h.unlock_mode, gen: h.gen,
      device_wraps: Object.fromEntries(Object.entries(h.wraps).filter(([n]) => n.startsWith('device:'))),
      factor_pubs: Object.fromEntries(Object.entries(h.wraps).filter(([n]) => !n.startsWith('device:')).map(([n, w]) => [n, w.pub])),
      holders: h.holders, passkeys: h.passkeys, from: this.device().id, signer: this.#sign().pub,
    };
    out.sig = signText(this.#sign().priv, canonical(out));
    mkdirSync(join(this.dir, 'outbox'), { recursive: true, mode: 0o700 });
    writeAtomic(join(this.dir, 'outbox', 'header.json'), `${JSON.stringify(out)}\n`);
    return out;
  }

  // On a holder: the hub's header and item blobs, opened with this device's own wrap. The holder's
  // broker seals the root key to the same factors itself; nothing but ciphertext arrived.
  adopt(inbox: OutboxHeader, items: Record<string, string>): void {
    const dev = this.device();
    const name = `device:${dev.id}`;
    // A vault made here never adopts another. A holder adopts only a header signed by the hub it
    // was enrolled for (pinned at tier 3, pinHub), only for the vault it holds, and only newer.
    if (this.#h && this.#h.origin !== 'adopted') throw new Error('This device’s vault was made here; it doesn’t take another.');
    const { sig, ...body } = inbox;
    if (typeof inbox.signer !== 'string' || !verifyText(inbox.signer, canonical(body), sig)) throw new Error('The vault that arrived isn’t signed by a hub’s broker, so it isn’t adopted.');
    const pinned = this.#h?.hub_signer ?? this.hubPin();
    if (!pinned) throw new Error('This device isn’t enrolled to hold a hub’s vault (tier 3), so nothing is adopted.');
    if (pinned !== inbox.signer || (this.#h && this.#h.id !== inbox.id)) throw new Error('The vault that arrived isn’t from the hub this device holds a vault for, so it isn’t adopted.');
    if (this.#h && inbox.gen <= this.#h.gen) throw new Error('The vault that arrived isn’t newer than the one held here.');
    const w = inbox.device_wraps?.[name];
    if (!w || !UUID.test(inbox.id)) throw new Error('The hub’s vault has no wrap for this device. Enrol it as a holder on the hub first (tier 3).');
    const root = openWrap(this.#device!.factor, w, wrapInfo(inbox.id, name, inbox.gen));
    // Every blob must open under that root before anything is replaced.
    const files: ItemFile[] = [];
    for (const [id, text] of Object.entries(items)) {
      const f = JSON.parse(text) as ItemFile;
      if (f.id !== id || !ID.test(id) || f.gen !== inbox.gen) throw new Error(`item ${id} from the hub doesn’t match its header`);
      open(root, f.meta, metaAad(inbox.id, id));
      zero(open(root, f.key, keyAad(inbox.id, id, f.version)));
      files.push(f);
    }
    const wraps: Record<string, Wrap> = {};
    for (const [n, pub] of Object.entries(inbox.factor_pubs)) wraps[n] = sealTo(pub, root, wrapInfo(inbox.id, n, inbox.gen));
    if (inbox.unlock_mode === 'auto') wraps[name] = sealTo(this.#device!.factor.pub, root, wrapInfo(inbox.id, name, inbox.gen));
    for (const id of this.ids()) if (!items[id]) rmSync(this.#itemPath(id), { force: true });
    for (const f of files) this.#write(f);
    this.#h = { v: 1, id: inbox.id, created_at: this.#now(), kdf: inbox.kdf, unlock_mode: inbox.unlock_mode, gen: inbox.gen, wraps, holders: inbox.holders, passkeys: inbox.passkeys, hub_signer: inbox.signer, origin: 'adopted' };
    this.#writeHeader();
    zero(this.#root);
    this.#root = root;
  }

  // The hub this device will hold a vault for: its broker's signing key, pinned at enrolment.
  hubPin(): string | null {
    try { const p = JSON.parse(readFileSync(join(this.dir, 'hub.json'), 'utf8')) as { signer?: unknown }; return typeof p.signer === 'string' ? p.signer : null; } catch { return null; }
  }
  pinHub(signer: string, name: string): void {
    if (this.#h) throw new Error('This device already holds a vault.');
    writeAtomic(join(this.dir, 'hub.json'), `${JSON.stringify({ signer, name, pinned_at: this.#now() })}\n`);
  }

  // ---- passkeys (approvals) -------------------------------------------------------------------

  bumpSignCount(id: string, n: number): void {
    const pk = this.#h?.passkeys[id];
    if (!pk) return;
    pk.sign_count = n;
    this.#writeHeader();
  }

  // A factory reset: the broker forgets its keys and wraps (§10 "Deleting").
  forget(): void {
    this.lock();
    try { this.device(); } catch { /* no key to remove */ }
    this.#device?.store.remove();
    if (this.#device) this.#o.deviceStore(`sign-${this.#device.id}`).remove();
    rmSync(this.dir, { recursive: true, force: true });
    this.#h = null;
    this.#device = null;
  }
}

export const sameBytes = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);
export { b64 };
```

### `src/broker/crypto.ts`

```ts
// The broker's cryptography, on node:crypto alone (no dependency; ADR-2 exception, Conflicts row 3).
//  - AES-256-GCM with associated data for every blob, so nothing can be swapped between files.
//  - Argon2id (crypto.argon2, Node 26) for the passphrase, RFC 9106's second recommended setting as
//    the floor (m = 64 MiB, t = 3, p = 4), raised by a timed calibration at setup.
//  - Every unlock factor is an X25519 key pair: the passphrase's private key is its Argon2id output,
//    a recovery key's and a passkey PRF output's come through HKDF, and a device's is random and
//    kept in that device's key store. The root key is sealed to each factor's public key, so the
//    broker can re-seal a new root key (a delete, a holder removed) without asking for any factor.
//  - Sealed entry (§10): the person's client seals a value with ECDH P-256 to the broker's per-boot
//    entry key, then HKDF and AES-GCM, bound to the pending action's digest.
import { argon2Sync, createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';

export interface Sealed { n: string; c: string; t: string }
const b64 = (b: Buffer) => b.toString('base64');
const unb64 = (s: unknown, what: string): Buffer => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/=_-]*$/.test(s)) throw new Error(`${what} isn’t base64`);
  return Buffer.from(s, 'base64');
};
export { b64, unb64 };

export function seal(key: Buffer, plain: Buffer, aad: string): Sealed {
  const n = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, n);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { n: b64(n), c: b64(ct), t: b64(c.getAuthTag()) };
}

// Wrong key, a tampered blob or a blob moved to another place: refused, never guessed at.
export function open(key: Buffer, s: Sealed, aad: string): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, unb64(s?.n, 'nonce'));
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(unb64(s?.t, 'tag'));
  return Buffer.concat([d.update(unb64(s?.c, 'ciphertext')), d.final()]);
}

// ---- Argon2id -----------------------------------------------------------------------------------

export interface Kdf { alg: 'argon2id'; m: number; t: number; p: number; salt: string }
export const KDF_FLOOR = { m: 65536, t: 3, p: 4 } as const;

export function argon2id(secret: Buffer, k: Kdf): Buffer {
  if (k.alg !== 'argon2id' || k.m < KDF_FLOOR.m || k.t < KDF_FLOOR.t || k.p < KDF_FLOOR.p) throw new Error('Argon2id parameters below the floor (m = 64 MiB, t = 3, p = 4)');
  return argon2Sync('argon2id', { message: secret, nonce: unb64(k.salt, 'salt'), memory: k.m, passes: k.t, parallelism: k.p, tagLength: 32 });
}

// The floor, raised while a derivation takes under half the target, up to 1 GiB.
export function calibrate(targetMs = 500, maxM = 1 << 20): Kdf {
  const k: Kdf = { alg: 'argon2id', ...KDF_FLOOR, salt: b64(randomBytes(16)) };
  for (;;) {
    const t0 = performance.now();
    argon2id(Buffer.from('calibrate'), k);
    if (performance.now() - t0 >= targetMs / 2 || k.m * 2 > maxM) return k;
    k.m *= 2;
  }
}

// ---- X25519 factors -----------------------------------------------------------------------------

const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');

export interface Factor { priv: KeyObject; pub: string }
export function factorFromSeed(seed: Buffer): Factor {
  if (seed.length !== 32) throw new Error('a factor seed is 32 bytes');
  const priv = createPrivateKey({ key: Buffer.concat([X25519_PKCS8, seed]), format: 'der', type: 'pkcs8' });
  return { priv, pub: rawPub(priv) };
}
export function newFactor(): { seed: Buffer; factor: Factor } {
  const seed = randomBytes(32);
  return { seed, factor: factorFromSeed(seed) };
}
const rawPub = (priv: KeyObject) => b64((createPublicKey(priv).export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32));
const pubKey = (raw: string) => {
  const r = unb64(raw, 'public key');
  if (r.length !== 32) throw new Error('an X25519 public key is 32 bytes');
  return createPublicKey({ key: Buffer.concat([X25519_SPKI, r]), format: 'der', type: 'spki' });
};
export const hkdf = (ikm: Buffer, salt: Buffer | string, info: string, n = 32) => Buffer.from(hkdfSync('sha256', ikm, salt, info, n));

// The root key sealed to a factor's public key, for the wrap named `info`.
export interface Wrap { pub: string; eph: string; box: Sealed }
export function sealTo(pub: string, plain: Buffer, info: string): Wrap {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const eph = b64((publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32));
  const k = hkdf(diffieHellman({ privateKey, publicKey: pubKey(pub) }), `${eph}|${pub}`, info);
  return { pub, eph, box: seal(k, plain, info) };
}
export function openWrap(f: Factor, w: Wrap, info: string): Buffer {
  if (w.pub !== f.pub) throw new Error('that factor doesn’t open this wrap');
  const k = hkdf(diffieHellman({ privateKey: f.priv, publicKey: pubKey(w.eph) }), `${w.eph}|${w.pub}`, info);
  return open(k, w.box, info);
}

// ---- Ed25519: a holder's broker signs the header it sends (so a holder adopts only its hub's) -----

const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
export function signerFromSeed(seed: Buffer): { priv: KeyObject; pub: string } {
  const priv = createPrivateKey({ key: Buffer.concat([ED_PKCS8, seed]), format: 'der', type: 'pkcs8' });
  return { priv, pub: b64((createPublicKey(priv).export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32)) };
}
export const signText = (priv: KeyObject, text: string) => b64(sign(null, Buffer.from(text, 'utf8'), priv));
export function verifyText(pub: string, text: string, sig: unknown): boolean {
  try {
    const raw = unb64(pub, 'signer');
    if (raw.length !== 32) return false;
    return verify(null, Buffer.from(text, 'utf8'), createPublicKey({ key: Buffer.concat([ED_SPKI, raw]), format: 'der', type: 'spki' }), unb64(sig, 'signature'));
  } catch { return false; }
}

// ---- sealed entry (P-256, matching WebCrypto in the person's client: src/broker/seal.ts) ---------

export interface Envelope { epk: string; iv: string; ct: string }
export function entryKey(): { priv: KeyObject; pub: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  return { priv: privateKey, pub: b64(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')])) };
}
export function openEnvelope(priv: KeyObject, e: Envelope, digest: string): Buffer {
  if (!e || typeof e !== 'object') throw new Error('not a sealed value');
  const raw = unb64(e.epk, 'epk');
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('not a P-256 point');
  const epk = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  const k = hkdf(diffieHellman({ privateKey: priv, publicKey: epk }), Buffer.from(digest, 'hex'), 'nova-broker-entry-v1');
  const ct = unb64(e.ct, 'ct');
  if (ct.length < 17) throw new Error('sealed value cut short');
  const d = createDecipheriv('aes-256-gcm', k, unb64(e.iv, 'iv'));
  d.setAAD(Buffer.from(digest, 'utf8'));
  d.setAuthTag(ct.subarray(-16));
  return Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
}
```

### `src/broker/policy.ts`

```ts
// Policy on the broker's own authority (§6–§7): approvals, flood control and rate caps.
//
// An approval: the broker issues a challenge (a random id, the digest of the canonical action, an
// expiry of 5 minutes, single use). The caller calls again with the answer. The broker recomputes
// the digest from the call it is actually given, so an approval made for one action never covers
// another (another target, another scope, another ref).
//  - passkey: a WebAuthn assertion (ES256, user verification) over sha256(id | digest | bound),
//    from a passkey registered with the broker at vault setup. The client computes the digest from
//    what it shows; what the person approves is what the broker does. `bound` is the SHA-256 of a
//    sealed value's envelope when the action carries one, so core can't swap in a value of its own.
//  - core: where no passkey is registered, the approval is relayed by core (the way tier-3
//    confirmations work today). The broker still checks the digest, the expiry, single use and
//    every binding rule; the approval's authenticity rests on core, and Settings says so.
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { canonical, type Card, type Challenge } from './protocol.ts';
import type { Passkey } from './store.ts';

export const APPROVAL_MS = 5 * 60_000;
export const PENDING_PER_TASK = 3;
export const APPROVALS_PER_HOUR = 30;
export const USES_PER_REF_HOUR = 3600;

export const digestOf = (action: unknown) => createHash('sha256').update(canonical(action)).digest('hex');
export const challengeBytes = (id: string, digest: string, bound = '') => createHash('sha256').update(`${id}|${digest}|${bound}`).digest();

interface Pending { digest: string; expires: number; used: boolean; task: string | null; passkey: boolean }
export interface ApprovalIn { id?: unknown; digest?: unknown; mode?: unknown; credential_id?: unknown; authenticator_data?: unknown; client_data_json?: unknown; signature?: unknown }

const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class Approvals {
  #pending = new Map<string, Pending>();
  #issued: number[] = [];
  #now: () => number;
  constructor(now: () => number = Date.now) { this.#now = now; }

  #sweep() {
    const t = this.#now();
    for (const [id, p] of this.#pending) if (p.used || p.expires < t - APPROVAL_MS) this.#pending.delete(id);
    this.#issued = this.#issued.filter((x) => x > t - 3600_000);
  }

  // Flood control: a few pending per task, a cap per hour. Beyond that, null (refused: rate).
  issue(action: unknown, card: Omit<Card, 'expires_at'>, task: string | null, passkey: boolean): Challenge | null {
    this.#sweep();
    const t = this.#now();
    const open = [...this.#pending.values()].filter((p) => !p.used && p.expires > t && p.task === task).length;
    if (open >= PENDING_PER_TASK || this.#issued.length >= APPROVALS_PER_HOUR) return null;
    const id = `ap_${randomBytes(12).toString('hex')}`;
    const digest = digestOf(action);
    const expires = t + APPROVAL_MS;
    this.#pending.set(id, { digest, expires, used: false, task, passkey });
    this.#issued.push(t);
    const expires_at = new Date(expires).toISOString();
    return { id, digest, expires_at, card: { ...card, expires_at } as Card, tier: card.tier };
  }

  // Checks an approval against the action the broker is about to do. Single use: a valid approval
  // is spent here, and a replay is refused.
  check(a: ApprovalIn, action: unknown, passkeys: Record<string, Passkey>, onCount: (id: string, n: number) => void, bound = ''): { ok: true; id: string; passkey: boolean } | { ok: false; why: string } {
    if (!a || typeof a.id !== 'string' || typeof a.digest !== 'string') return { ok: false, why: 'no approval id' };
    const p = this.#pending.get(a.id);
    if (!p) return { ok: false, why: 'unknown or already used' };
    if (p.used) return { ok: false, why: 'already used' };
    if (p.expires <= this.#now()) { this.#pending.delete(a.id); return { ok: false, why: 'expired' }; }
    const digest = digestOf(action);
    if (!eq(a.digest, p.digest) || !eq(digest, p.digest)) return { ok: false, why: 'made for another action' };
    if (a.mode === 'passkey') {
      const why = checkAssertion(a, challengeBytes(a.id, digest, bound), passkeys, onCount);
      if (why) return { ok: false, why };
    } else if (a.mode !== 'core' || p.passkey) return { ok: false, why: p.passkey ? 'this action needs your passkey' : 'not an approval mode' };
    p.used = true;
    return { ok: true, id: a.id, passkey: a.mode === 'passkey' };
  }

  clear() { this.#pending.clear(); }
}

// ---- WebAuthn (ES256) ---------------------------------------------------------------------------

const b64u = (s: unknown) => (typeof s === 'string' && /^[A-Za-z0-9_-]*={0,2}$/.test(s) ? Buffer.from(s, 'base64url') : null);

export function checkAssertion(a: ApprovalIn, challenge: Buffer, passkeys: Record<string, Passkey>, onCount: (id: string, n: number) => void): string | null {
  const id = typeof a.credential_id === 'string' ? a.credential_id : '';
  const pk = Object.hasOwn(passkeys, id) ? passkeys[id] : undefined;
  if (!pk) return 'not a passkey registered with the broker';
  const auth = b64u(a.authenticator_data);
  const cdj = b64u(a.client_data_json);
  const sig = b64u(a.signature);
  if (!auth || !cdj || !sig || auth.length < 37) return 'not a WebAuthn assertion';
  let cd: { type?: string; challenge?: string; origin?: string; crossOrigin?: boolean };
  try { cd = JSON.parse(cdj.toString('utf8')); } catch { return 'client data isn’t JSON'; }
  if (cd.type !== 'webauthn.get') return 'not an assertion';
  if (cd.challenge !== challenge.toString('base64url')) return 'signed for another challenge';
  if (typeof cd.origin !== 'string' || !pk.origins.includes(cd.origin) || cd.crossOrigin) return 'signed on an origin this passkey wasn’t registered for';
  if (!auth.subarray(0, 32).equals(createHash('sha256').update(pk.rp_id).digest())) return 'signed for another relying party';
  const flags = auth[32]!;
  if (!(flags & 0x01) || !(flags & 0x04)) return 'user presence and verification are required';
  const count = auth.readUInt32BE(33);
  if ((count !== 0 || pk.sign_count !== 0) && count <= pk.sign_count) return 'a replayed or cloned authenticator (its counter went back)';
  let ok = false;
  try {
    const key = createPublicKey({ key: Buffer.from(pk.public_key, 'base64'), format: 'der', type: 'spki' });
    ok = verify('sha256', Buffer.concat([auth, createHash('sha256').update(cdj).digest()]), key, sig);
  } catch { ok = false; }
  if (!ok) return 'the signature doesn’t verify';
  if (count) onCount(id, count);
  return null;
}

// ---- rate caps ----------------------------------------------------------------------------------

export class Rates {
  #hits = new Map<string, number[]>();
  #now: () => number;
  constructor(now: () => number = Date.now) { this.#now = now; }
  take(key: string, perHour: number): boolean {
    const t = this.#now();
    const xs = (this.#hits.get(key) ?? []).filter((x) => x > t - 3600_000);
    if (xs.length >= perHour) { this.#hits.set(key, xs); return false; }
    xs.push(t);
    this.#hits.set(key, xs);
    return true;
  }
}

// Generated values: the CSPRNG under a per-site policy (24 characters by default, as M10d's
// generatePassword has), with rejection sampling so every character is equally likely.
export const DEFAULT_POLICY = { length: 24, alphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.!@#%' };
export function generate(policy: { length: number; alphabet: string } = DEFAULT_POLICY): Buffer {
  const { length, alphabet } = policy;
  if (!Number.isInteger(length) || length < 16 || length > 128 || typeof alphabet !== 'string' || !/^[\x21-\x7e]+$/.test(alphabet) || new Set(alphabet).size < 16 || alphabet.length > 256) throw new Error('a generation policy is 16–128 characters from at least 16 distinct ones');
  const chars = [...new Set(alphabet)];
  const out = Buffer.alloc(length);
  const limit = 256 - (256 % chars.length);
  for (let i = 0; i < length;) {
    for (const b of randomBytes(length * 2)) {
      if (b >= limit) continue;
      out[i++] = chars[b % chars.length]!.charCodeAt(0);
      if (i === length) break;
    }
  }
  return out;
}
```

### `src/broker/origin.ts`

```ts
// Targets and origin binding (docs/plans/vault-broker.md §5). Matching is exact on the canonical
// form: no wildcards, no subdomains, no parent domains. The canonical form is computed here, by the
// broker, from what it is given; a target that isn't already canonical-able is refused, never
// repaired into something nearby.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, normalize } from 'node:path';
import { domainToUnicode } from 'node:url';
import type { Scope, TargetKind } from './protocol.ts';

export const BUILT: ReadonlySet<TargetKind> = new Set(['http', 'process']);
export const KINDS: ReadonlySet<string> = new Set(['web', 'http', 'ws', 'stream', 'process', 'service', 'device']);

const LOOPBACK_NAMES = new Set(['localhost']);
export const isLoopbackHost = (h: string) => LOOPBACK_NAMES.has(h) || /^127(\.\d{1,3}){3}$/.test(h) || h === '[::1]';

// An origin, canonical: scheme, lowercase A-label host, port only when not the default. `http` and
// `ws` only for loopback. Anything with a path, query, fragment, credentials, a wildcard or a
// trailing dot is refused.
export function canonicalOrigin(input: unknown, kind: 'web' | 'http' | 'ws' = 'http'): string {
  if (typeof input !== 'string' || input.length > 300 || /[*\s\\]/.test(input)) throw new Error('not an origin');
  let u: URL;
  try { u = new URL(input); } catch { throw new Error('not an origin'); }
  const secure = kind === 'ws' ? 'wss:' : 'https:';
  const plain = kind === 'ws' ? 'ws:' : 'http:';
  if (u.protocol !== secure && u.protocol !== plain) throw new Error(`a ${kind} target is ${secure.slice(0, -1)}`);
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) throw new Error('an origin has no path, query, fragment or credentials');
  const host = u.hostname;
  if (!host || host.endsWith('.') || host.includes('..')) throw new Error('not a host the broker binds');
  if (u.protocol === plain && !isLoopbackHost(host)) throw new Error(`${plain.slice(0, -1)} is allowed only on this device (loopback)`);
  return `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}`;
}

export const hostOf = (origin: string) => new URL(origin).hostname;

// A program: an absolute, normal path and the binary's SHA-256.
export function canonicalProcess(path: unknown, sha256: unknown): string {
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path || path.length > 500) throw new Error('a program target is an absolute, normal path');
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('a program target names its binary’s SHA-256');
  return `${path}#sha256:${sha256}`;
}
export const fileSha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

export interface TargetIn { kind?: unknown; origin?: unknown; path?: unknown; sha256?: unknown }
export function canonicalTarget(t: TargetIn): { kind: TargetKind; target: string } {
  if (!t || typeof t !== 'object' || typeof t.kind !== 'string' || !KINDS.has(t.kind)) throw new Error('not a target kind');
  const kind = t.kind as TargetKind;
  if (kind === 'web' || kind === 'http' || kind === 'ws') return { kind, target: canonicalOrigin(t.origin, kind) };
  if (kind === 'process') return { kind, target: canonicalProcess(t.path, t.sha256) };
  return { kind, target: `${kind}:${String(t.origin ?? t.path ?? '')}` };
}

// A request path: absolute, no traversal, no second slash at the start (which would name a host),
// no backslash. The scope is checked on the path without its query.
export function requestPath(p: unknown): { path: string; bare: string } {
  if (typeof p !== 'string' || !p.startsWith('/') || p.startsWith('//') || p.length > 2000 || /[\\\s#]/.test(p)) throw new Error('not a request path');
  const bare = p.split('?')[0]!;
  let decoded: string;
  try { decoded = decodeURIComponent(bare); } catch { throw new Error('not a request path'); }
  // `..;x` and `.;x` are dot segments to servers that strip path parameters (Tomcat, Spring).
  if (decoded.split('/').some((s) => /^\.\.?(;|$)/.test(s)) || decoded.includes('\\') || /%2f/i.test(bare)) throw new Error('a request path can’t climb out of its scope');
  return { path: p, bare };
}

export function checkScope(s: unknown): Scope {
  const o = s as Scope;
  if (!o || !Array.isArray(o.methods) || !Array.isArray(o.paths) || !o.methods.length || !o.paths.length || o.methods.length > 10 || o.paths.length > 50) throw new Error('a scope names its methods and path prefixes');
  for (const m of o.methods) if (typeof m !== 'string' || !/^[A-Z]{3,7}$/.test(m)) throw new Error('not a method');
  for (const p of o.paths) { if (typeof p !== 'string' || /[*?]/.test(p)) throw new Error('scope paths are prefixes, without wildcards'); requestPath(p); }
  return { methods: [...o.methods], paths: [...o.paths] };
}

// A path prefix covers itself and what is below it at a segment boundary: /api covers /api and
// /api/x, never /apix.
export const inScope = (s: Scope, method: string, bare: string) =>
  s.methods.includes(method) && s.paths.some((p) => bare === p || (p.endsWith('/') ? bare.startsWith(p) : bare.startsWith(`${p}/`)));

// ---- lookalikes (flags on the bind card, not refusals) ------------------------------------------

const SCRIPTS = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u, /\p{Script=Armenian}/u, /\p{Script=Han}/u, /\p{Script=Arabic}/u, /\p{Script=Hebrew}/u];
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

export function lookalikes(origin: string, bound: string[]): { unicode: string | null; flags: string[] } {
  const host = hostOf(origin);
  const uni = domainToUnicode(host);
  const flags: string[] = [];
  for (const label of uni.split('.')) {
    const n = SCRIPTS.filter((r) => r.test(label)).length;
    if (n > 1) flags.push(`mixed scripts in “${label}”`);
  }
  for (const b of bound) {
    let bh: string;
    try { bh = hostOf(b); } catch { continue; }
    if (bh === host) continue;
    if (distance(bh, host) <= 2) flags.push(`close to ${bh}, already bound`);
    if (host.startsWith(`${bh}.`)) flags.push(`starts with ${bh}, already bound, as a label`);
  }
  return { unicode: uni !== host ? uni : null, flags };
}

// ---- addresses (§3 "No network surface") --------------------------------------------------------

export function addressClass(addr: string): 'loopback' | 'private' | 'public' {
  const v = isIP(addr);
  if (v === 4) {
    const [a, b] = addr.split('.').map(Number) as [number, number];
    if (a === 127) return 'loopback';
    if (a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224) return 'private';
    return 'public';
  }
  if (v === 6) {
    const x = addr.toLowerCase();
    if (x === '::1') return 'loopback';
    if (x.startsWith('::ffff:')) return addressClass(x.slice(7));
    // ULA, link-local, site-local (fec0::/10), multicast, NAT64 (64:ff9b::/96) and 6to4 (2002::/16),
    // whose embedded IPv4 address could be anything: all treated as not public.
    if (x === '::' || /^f[cd]/.test(x) || /^fe[89a-f]/.test(x) || x.startsWith('ff') || x.startsWith('64:ff9b:') || x.startsWith('2002:')) return 'private';
    return 'public';
  }
  return 'private';
}

// The broker suggests a class from the origin (§6): sensitive when unsure.
const SENSITIVE = /(bank|pay|card|credit|finance|invest|broker|trade|wallet|crypto|coin|exchange|mail|admin|console|sso|login|auth|account|vault|password|1password|bitwarden|okta|cloud|aws|azure|gcp|router|github|gitlab)/;
const STANDARD = /(^|\.)(openai\.com|anthropic\.com|groq\.com|mistral\.ai|together\.xyz|openrouter\.ai|deepseek\.com|x\.ai|ollama\.com)$/;
export function suggestClass(origin: string | null, kind: string): 'standard' | 'sensitive' {
  if (!origin) return 'sensitive';
  let host: string;
  try { host = origin.startsWith('/') ? '' : hostOf(origin); } catch { return 'sensitive'; }
  if (SENSITIVE.test(host)) return 'sensitive';
  if (STANDARD.test(host) || isLoopbackHost(host)) return 'standard';
  void kind;
  return 'sensitive';
}
```

### `src/broker/http.ts`

```ts
// The one place the broker reaches the network (§3 "No network surface"): outbound, inside a `use`,
// to that use's bound origin only. Nothing here listens.
//  - The address is resolved once; a public name that resolves to a private or loopback address is
//    refused unless the binding says LAN (and a LAN binding has a pinned certificate). A loopback
//    binding must resolve to loopback.
//  - TLS is verified against the system's roots, or against the pinned certificate's SHA-256 alone
//    when the binding pins one. The check happens on the TLS socket before a byte of the request is
//    written.
//  - Redirects aren't followed: a 3xx comes back as an outcome. No proxy settings are honoured (the
//    broker starts with an empty environment, and this code never reads one).
import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { isIP, connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { addressClass, isLoopbackHost } from './origin.ts';
import { RESPONSE_HEADERS } from './protocol.ts';

export interface Outbound { origin: string; method: string; path: string; headers: Record<string, string>; body: Buffer | null; lan: boolean; pin: string | null; timeoutMs?: number; maxBytes?: number }
export interface Response { status: number; headers: Record<string, string>; body: string; truncated: boolean }
export type Resolver = (host: string) => Promise<string[]>;
export const systemResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export class EgressError extends Error {
  readonly cls: string;
  constructor(cls: string, message: string) { super(message); this.cls = cls; }
}

const normalPin = (p: string) => p.replace(/:/g, '').toLowerCase();

export async function send(o: Outbound, resolve: Resolver = systemResolver): Promise<Response> {
  const u = new URL(o.origin);
  const host = u.hostname;
  const bare = host.replace(/^\[|\]$/g, '');
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  const addrs = isIP(bare) ? [bare] : await resolve(host).catch(() => { throw new EgressError('dns', `couldn’t resolve ${host}`); });
  if (!addrs.length) throw new EgressError('dns', `${host} has no address`);
  const classes = addrs.map(addressClass);
  if (isLoopbackHost(host)) {
    if (classes.some((c) => c !== 'loopback')) throw new EgressError('address', `${host} didn’t resolve to this device`);
  } else if (classes.some((c) => c !== 'public') && !(o.lan && o.pin)) {
    throw new EgressError('address', `${host} resolves to a private or loopback address, and its binding isn’t a pinned LAN device`);
  }
  const address = addrs[0]!;
  const timeout = o.timeoutMs ?? 30_000;
  const socket: Socket = await new Promise((ok, fail) => {
    const timer = setTimeout(() => { s.destroy(); fail(new EgressError('timeout', 'the connection timed out')); }, timeout);
    const done = (e?: Error) => { clearTimeout(timer); if (e) { s.destroy(); fail(e); } else ok(s); };
    let s: Socket;
    if (u.protocol === 'https:') {
      const t: TLSSocket = tlsConnect({ host: address, port, servername: isIP(bare) ? undefined : host, rejectUnauthorized: !o.pin, ALPNProtocols: ['http/1.1'] });
      s = t;
      t.once('secureConnect', () => {
        if (o.pin) {
          const fp = t.getPeerCertificate()?.fingerprint256 ?? '';
          if (normalPin(fp) !== normalPin(o.pin)) return done(new EgressError('tls', 'the certificate isn’t the one this binding pins'));
        } else if (!t.authorized) return done(new EgressError('tls', `the certificate didn’t verify (${String(t.authorizationError)})`));
        done();
      });
    } else {
      s = netConnect({ host: address, port });
      s.once('connect', () => done());
    }
    s.once('error', (e) => done(new EgressError('connect', e.message)));
  });
  return new Promise((ok, fail) => {
    const req = httpRequest({
      createConnection: () => socket, method: o.method, path: o.path,
      headers: { ...o.headers, host: u.host, connection: 'close', ...(o.body ? { 'content-length': String(o.body.length) } : {}) },
      timeout,
    }, (res: IncomingMessage) => {
      const max = o.maxBytes ?? 4 * 1024 * 1024;
      const chunks: Buffer[] = [];
      let n = 0;
      let truncated = false;
      res.on('data', (c: Buffer) => {
        if (n + c.length > max) { truncated = true; chunks.push(c.subarray(0, max - n)); n = max; res.destroy(); return; }
        chunks.push(c); n += c.length;
      });
      const finish = () => {
        const headers: Record<string, string> = {};
        for (const h of RESPONSE_HEADERS) { const v = res.headers[h]; if (typeof v === 'string') headers[h] = v; }
        ok({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8'), truncated });
      };
      res.on('end', finish);
      res.on('close', () => { if (truncated) finish(); });
      res.on('error', (e) => { if (!truncated) fail(new EgressError('read', e.message)); });
    });
    req.on('timeout', () => req.destroy(new EgressError('timeout', 'the request timed out')));
    req.on('error', (e) => fail(e instanceof EgressError ? e : new EgressError('request', e.message)));
    if (o.body) req.write(o.body);
    req.end();
  });
}
```

### `src/broker/scrub.ts`

```ts
// Exact-value scrubbing at the broker's edges (§8): the value a use injected (and, for basic auth,
// the user:value pair it sent), in its raw, base64, base64url, hex, URL-encoded (either case, and
// form-encoded), and JSON-escaped forms, is replaced in what the target sent back: a response, or a
// program's output through the launcher. Only target-sent text is scrubbed, never text core wrote:
// scrubbing core's own text would tell core whether it guessed a value.
// Stated limits: values shorter than 6 characters aren't hunted (they would match ordinary text);
// HTML entities, UTF-16 and other encodings a target might use aren't; and a target that echoes
// text core sent it can, by being scrubbed, confirm a guess about the value used (rate-capped).

export const MARK = '[redacted by the broker]';

export function formsOf(value: string): string[] {
  if (value.length < 6) return [];
  const b = Buffer.from(value, 'utf8');
  const forms = new Set([
    value, b.toString('base64'), b.toString('base64').replace(/=+$/, ''), b.toString('base64url'),
    b.toString('hex'), b.toString('hex').toUpperCase(), encodeURIComponent(value), JSON.stringify(value).slice(1, -1),
    encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (x) => x.toLowerCase()), encodeURIComponent(value).replace(/%20/g, '+'),
    JSON.stringify(value).slice(1, -1).replace(/\//g, '\\/'),
  ]);
  return [...forms].filter((f) => f.length >= 6).sort((x, y) => y.length - x.length);
}

export class Scrubber {
  #forms: string[] = [];
  #longest = 0;
  hits = 0;
  constructor(values: Iterable<string> = []) { this.set(values); }
  set(values: Iterable<string>) {
    const all = new Set<string>();
    for (const v of values) for (const f of formsOf(v)) all.add(f);
    this.#forms = [...all].sort((x, y) => y.length - x.length);
    this.#longest = this.#forms[0]?.length ?? 0;
  }
  get size() { return this.#forms.length; }
  get longest() { return this.#longest; }
  text(s: string): string {
    let out = s;
    for (const f of this.#forms) if (out.includes(f)) { this.hits++; out = out.split(f).join(MARK); }
    return out;
  }
  // Recursively, for an answer about to be written.
  any<T>(v: T): T {
    if (typeof v === 'string') return this.text(v) as T;
    if (Array.isArray(v)) return v.map((x) => this.any(x)) as T;
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [this.text(k), this.any(x)])) as T;
    return v;
  }
}

// For a stream (a program's stdout through the launcher): holds back the last longest-1 characters
// so a value split across two chunks is still caught.
export class StreamScrubber {
  #s: Scrubber;
  #tail = '';
  constructor(s: Scrubber) { this.#s = s; }
  push(chunk: string): string {
    const text = this.#s.text(this.#tail + chunk);
    const keep = Math.max(0, this.#s.longest - 1);
    if (text.length <= keep) { this.#tail = text; return ''; }
    this.#tail = keep ? text.slice(-keep) : '';
    return keep ? text.slice(0, -keep) : text;
  }
  end(): string { const t = this.#s.text(this.#tail); this.#tail = ''; return t; }
}
```

### `src/broker/audit.ts`

```ts
// The broker's own audit log (§8): the authority. Append-only, hash-chained, 0600, in its own
// folder. One record per verb: when, the device, the verb, the ref, the target in canonical form,
// the scope item (method and path, never a query string), the outcome, the tier, the approval or
// consent id, the task and the caller's role. Never a value, a part, a length or any encoding of
// one, a hash of one, headers, bodies or query strings. Core copies each record (it comes back in
// the answer) into the Work Ledger under its task; a gap shows in Health.
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { AuditRecord, Role } from './protocol.ts';

export type Entry = Omit<AuditRecord, 'seq' | 'at' | 'prev' | 'hash' | 'device'>;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export class Audit {
  readonly path: string;
  #device: string;
  #seq = 0;
  #prev = '0'.repeat(64);
  #now: () => Date;

  constructor(path: string, device: string, now: () => Date = () => new Date()) {
    this.path = path;
    this.#device = device;
    this.#now = now;
    if (!existsSync(path)) writeFileSync(path, '', { mode: 0o600 });
    chmodSync(path, 0o600);
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    const last = lines.at(-1);
    if (last) { const r = JSON.parse(last) as AuditRecord; this.#seq = r.seq; this.#prev = r.hash; }
  }

  write(e: Entry): AuditRecord {
    const body = { seq: this.#seq + 1, at: this.#now().toISOString(), device: this.#device, verb: e.verb, ref: e.ref, target: e.target, scope_item: e.scope_item, outcome: e.outcome, tier: e.tier, approval_id: e.approval_id, task: e.task, role: e.role as Role, prev: this.#prev };
    const rec: AuditRecord = { ...body, hash: sha(JSON.stringify(body)) };
    appendFileSync(this.path, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    this.#seq = rec.seq;
    this.#prev = rec.hash;
    return rec;
  }
}

// The chain, checked: every record's hash is its own, and each names the one before.
export function verifyChain(text: string): { ok: boolean; records: number; broken_at: number | null } {
  let prev = '0'.repeat(64);
  const lines = text.split('\n').filter(Boolean);
  for (const [i, line] of lines.entries()) {
    const { hash, ...body } = JSON.parse(line) as AuditRecord;
    if (body.prev !== prev || sha(JSON.stringify(body)) !== hash) return { ok: false, records: lines.length, broken_at: i + 1 };
    prev = hash;
  }
  return { ok: true, records: lines.length, broken_at: null };
}
```

### `src/broker/keystore.ts`

```ts
// Where the broker's device unlock key lives (§10 "Unlock"): the OS key store when one answers,
// else a 0600 file in the broker's folder, with the plain notice. The CLIs are vault.ts's, ported
// (src/broker imports nothing from src/core): secret-tool on Linux, security on macOS, the
// Credential Locker through PowerShell on Windows (untested on real Windows). Values never go on a
// command line. The migrate launcher also reads the old vault's key through these (service
// nova-vault, account vault-<id>).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface CommandResult { code: number | null; stdout: string; stderr: string; error: string | null }
export type Run = (cmd: string, args: string[], input?: string) => CommandResult;
export const runCommand: Run = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { input: input ?? '', encoding: 'utf8', timeout: 10_000, shell: false, windowsHide: true });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ? r.error.message : null };
};

export interface KeyStore {
  kind: 'keychain' | 'file';
  name: string;
  available(): { ok: boolean; detail: string };
  read(): Buffer | null;
  write(key: Buffer): void;
  remove(): void;
}

export const FILE_NOTICE = 'There is no system keychain the vault can use on this computer, so its device key is in a file in the broker’s folder (broker/device.key). Anyone who can read that folder as you can open the vault. Choose “ask me after a restart” to keep no key on disk.';

const decode = (t: string) => { const k = Buffer.from(t.trim(), 'base64'); return k.length === 32 ? k : null; };
const fail = (cli: string, r: CommandResult) => new Error(`The system keychain didn’t answer (${cli}: ${r.error ?? (r.stderr.trim().split('\n')[0] || `exit code ${r.code}`)}).`);
const ACCOUNT = /^[a-z0-9-]{1,80}$/;

export function fileKeyStore(path: string): KeyStore {
  return {
    kind: 'file',
    name: `a key file (${path})`,
    available: () => ({ ok: true, detail: path }),
    read: () => {
      if (!existsSync(path)) return null;
      const k = readFileSync(path);
      if (k.length !== 32) throw new Error(`The key file ${path} is damaged.`);
      return k;
    },
    write: (key) => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(`${path}.tmp`, key, { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
      chmodSync(path, 0o600);
    },
    remove: () => rmSync(path, { force: true }),
  };
}

export function keychainStore(service: string, account: string, o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; run?: Run } = {}): KeyStore | null {
  if (!ACCOUNT.test(account) || !ACCOUNT.test(service)) throw new Error('not a keychain account the broker uses');
  const run = o.run ?? runCommand;
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  if (platform === 'darwin') {
    return {
      kind: 'keychain', name: 'the macOS keychain',
      available: () => { const r = run('security', ['default-keychain']); return { ok: r.code === 0, detail: r.code === 0 ? 'security' : (r.error ?? r.stderr.trim()) }; },
      read: () => { const r = run('security', ['find-generic-password', '-s', service, '-a', account, '-w']); if (r.code === 0) return decode(r.stdout); if (r.code === 44) return null; throw fail('security', r); },
      write: (k) => { const r = run('security', ['-i'], `add-generic-password -U -s ${service} -a ${account} -l "Nova broker key" -w ${k.toString('base64')}\n`); if (r.code !== 0 || r.stderr.trim()) throw fail('security', r); },
      remove: () => { run('security', ['delete-generic-password', '-s', service, '-a', account]); },
    };
  }
  if (platform === 'win32') {
    const v = `[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]; $v = New-Object Windows.Security.Credentials.PasswordVault;`;
    const find = `try { $c = $v.Retrieve('${service}', '${account}') } catch { exit 44 };`;
    const ps = (s: string, input?: string) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& { ${v} ${s} }`], input);
    return {
      kind: 'keychain', name: 'Windows Credential Manager',
      available: () => { const r = ps('exit 0'); return { ok: r.code === 0, detail: r.code === 0 ? 'PasswordVault' : (r.error ?? r.stderr.trim()) }; },
      read: () => { const r = ps(`${find} $c.RetrievePassword(); [Console]::Out.Write($c.Password)`); if (r.code === 0) return decode(r.stdout); if (r.code === 44) return null; throw fail('PowerShell', r); },
      write: (k) => { const r = ps(`$p = [Console]::In.ReadToEnd().Trim(); $v.Add((New-Object Windows.Security.Credentials.PasswordCredential('${service}', '${account}', $p)))`, k.toString('base64')); if (r.code !== 0) throw fail('PowerShell', r); },
      remove: () => { ps(`${find} $v.Remove($c)`); },
    };
  }
  if (platform !== 'linux' && platform !== 'freebsd' && platform !== 'openbsd') return null;
  const attrs = ['service', service, 'account', account];
  return {
    kind: 'keychain', name: 'the system keychain (secret-tool)',
    available: () => {
      if (!env.DBUS_SESSION_BUS_ADDRESS) return { ok: false, detail: 'no desktop session to reach the keychain through' };
      const r = run('secret-tool', ['lookup', 'service', service, 'account', 'nova-probe']);
      return (r.code === 0 || (r.code === 1 && !r.stderr.trim())) ? { ok: true, detail: 'secret-tool' } : { ok: false, detail: r.error ?? r.stderr.trim() };
    },
    read: () => { const r = run('secret-tool', ['lookup', ...attrs]); if (r.code === 0) return decode(r.stdout); if (r.code === 1 && !r.stderr.trim()) return null; throw fail('secret-tool', r); },
    write: (k) => { const r = run('secret-tool', ['store', `--label=Nova broker key (${account})`, ...attrs], k.toString('base64')); if (r.code !== 0) throw fail('secret-tool', r); },
    remove: () => { run('secret-tool', ['clear', ...attrs]); },
  };
}

// File stores for the broker's two device keys, by account: device-<id> (X25519, the unlock key)
// and sign-<id> (Ed25519, which signs the outbox).
export const fileStores = (dir: string) => (account: string) => fileKeyStore(`${dir}/${account.startsWith('sign-') ? 'sign' : 'device'}.key`);

// The keychain when it answers, else the file. Under the test runner, always the file: tests never
// touch a real keychain (the hard limits).
export function chooseStore(service: string, account: string, file: string, o: { mode?: 'auto' | 'file' | 'keychain'; env?: NodeJS.ProcessEnv; run?: Run; platform?: NodeJS.Platform } = {}): KeyStore {
  const env = o.env ?? process.env;
  const mode = o.mode ?? (env.NODE_TEST_CONTEXT ? 'file' : 'auto');
  if (mode === 'file') return fileKeyStore(file);
  const kc = keychainStore(service, account, o);
  const up = kc?.available();
  if (kc && up?.ok) return kc;
  if (mode === 'keychain') throw new Error(`The broker is set to keep its key in the system keychain, but none answers${up ? `: ${up.detail}` : ''}.`);
  return fileKeyStore(file);
}
```

### `src/broker/launch.ts`

```ts
// The broker's launcher (§3 "The launcher", §10 "Moving from today's vault"). Broker code that the
// broker itself starts as its own child, outside Node's permission model, for the two jobs the
// broker's narrowed process can't do: run a program with a credential, and read the old vault in
// the home. It talks to the broker over its pipes only: never the socket, never a ticket. Core
// never starts it and never holds anything that would let another process act as it.
//
//   launch.ts run              fd 3: { path, sha256, argv, cwd, env, inject, tmp, value, stdin }
//     Hashes the program itself and refuses one that isn't the bound binary, then starts it with
//     the value in its environment, or in a 0600 file in a 0700 folder named by that variable and
//     removed on exit. It scrubs stdout and stderr of the value (and its encodings), passes on
//     signals, and exits with the program's code.
//   launch.ts migrate <home>   stdout: { vault_id, revision }, then { name, value } per credential
//     Reads vault.ts's file and key and Era 2's Gmail files. Nova's own keys aren't sent.
//   launch.ts finish <home>    fd 3: { vault_id, revision, names }
//     Takes the names that moved out of the old vault (a new key, or no file and no key) and removes
//     Era 2's files for them; prints counts only.
//
// Stated limits: a program is hashed, then started by path, so a binary swapped between the two
// would run with the credential; and a program can do what it likes with its own credential,
// including what its arguments, working folder and project files (core's) steer it to.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OWN_KEYS, removeFromOldVault, removeGmailFiles, withOldVaultLock, migrationSnapshot } from './oldvault.ts';
import { fileSha256 } from './origin.ts';
import { Scrubber, StreamScrubber } from './scrub.ts';

function fromParent(): Promise<Record<string, any>> {
  return new Promise((ok, fail) => {
    let s = '';
    const r = new Socket({ fd: 3, readable: true, writable: false });
    r.setEncoding('utf8');
    r.on('data', (c: string) => { s += c; });
    r.on('end', () => { try { ok(JSON.parse(s)); } catch { fail(new Error('not a request from the broker')); } });
    r.on('error', fail);
  });
}
const fail = (words: string, code = 1): never => { process.stderr.write(`nova broker launcher: ${words}\n`); process.exit(code); };
const line = (x: unknown) => process.stdout.write(`${JSON.stringify(x)}\n`);

async function run() {
  const g = await fromParent();
  let sha = '';
  try { sha = fileSha256(g.path); } catch { fail('the bound program isn’t there', 126); }
  if (sha !== g.sha256) fail('the program isn’t the one this credential is bound to (its SHA-256 differs)', 126);
  const scrub = new Scrubber([String(g.value)]);
  const home = mkdtempSync(join(typeof g.tmp === 'string' ? g.tmp : tmpdir(), 'nova-run-'));
  const env: NodeJS.ProcessEnv = { ...g.env, PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home };
  if (g.inject.how === 'file') {
    const file = join(home, 'credential');
    writeFileSync(file, String(g.value), { mode: 0o600 });
    env[g.inject.env] = file;
  } else env[g.inject.env] = String(g.value);
  g.value = '';
  // Node writes the broker's permission flags into every child's NODE_OPTIONS, whatever env it is
  // given; env(1) takes them out, so the program runs as itself and sees nothing of the broker's.
  const viaEnv = process.platform !== 'win32';
  const child = spawn(viaEnv ? '/usr/bin/env' : g.path, viaEnv ? ['-u', 'NODE_OPTIONS', '--', g.path, ...g.argv] : g.argv, { env, cwd: g.cwd ?? home, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  delete env[g.inject.env];
  child.stdin!.on('error', () => { /* the program didn't read it */ });
  child.stdin!.end(typeof g.stdin === 'string' ? g.stdin : '');
  const out = new StreamScrubber(scrub);
  const err = new StreamScrubber(scrub);
  child.stdout!.setEncoding('utf8').on('data', (c: string) => process.stdout.write(out.push(c)));
  child.stderr!.setEncoding('utf8').on('data', (c: string) => process.stderr.write(err.push(c)));
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(s, () => child.kill(s));
  child.on('error', () => { rmSync(home, { recursive: true, force: true }); fail('couldn’t start the program', 127); });
  child.on('close', (code, signal) => {
    process.stdout.write(out.end());
    process.stderr.write(err.end());
    rmSync(home, { recursive: true, force: true });
    process.exitCode = code ?? (signal ? 128 + (({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9 } as Record<string, number>)[signal] ?? 1) : 1);
  });
}

function migrate(home: string) {
  return withOldVaultLock(home, () => {
    const { old, gmail, revision } = migrationSnapshot(home);
    const items = new Map<string, string>(gmail);
    for (const [k, v] of old?.map ?? []) items.set(k, v);
    line({ vault_id: old?.id ?? null, revision });
    for (const [name, value] of items) if (!OWN_KEYS.some((r) => r.test(name))) line({ name, value });
    old?.key.fill(0);
  });
}

async function finish(home: string) {
  const f = await fromParent();
  withOldVaultLock(home, () => {
    const names = Array.isArray(f.names) ? (f.names as unknown[]).filter((n): n is string => typeof n === 'string') : [];
    const { old, revision } = migrationSnapshot(home);
    try {
      // A newer value was never read back. Keep all entries on any staged revision mismatch.
      if (revision !== f.revision || (old && old.id !== f.vault_id)) { line({ removed: 0 }); return; }
      const removed = old ? removeFromOldVault(home, old, names) : [];
      removeGmailFiles(home, names);
      line({ removed: removed.length, kept: old?.map.size ?? 0 });
    } finally { old?.key.fill(0); }
  });
}

const [mode, home] = process.argv.slice(2);
const go = mode === 'run' ? run() : mode === 'migrate' && home ? Promise.resolve(migrate(home)) : mode === 'finish' && home ? finish(home) : Promise.reject(new Error('usage: launch.ts run | migrate <home> | finish <home>'));
go.catch((e) => fail(e instanceof SyntaxError ? 'a file couldn’t be read' : (e as Error).message));
```

### `src/broker/oldvault.ts`

```ts
// Today's vault (src/core/vault.ts), read and rewritten by broker code only: the migrate launcher
// (§10 "Moving from today's vault, with no value passing through core"). The format is vault.ts's:
// home/vault/secrets.json, AES-256-GCM over the JSON map with `nova-vault-v1|<id>` as associated
// data; the key in the keychain (nova-vault / vault-<id>) or home/vault/key. Nothing is imported
// from core: the format is small and fixed, and reimplemented here.
//
// After a migration, the names that moved are taken out: the file is rewritten without them under
// a new key (so an older backup's copy, which never holds the key, opens with no key that still
// exists), or deleted with its key when nothing is left. Nova's own keys (§9 row 15) stay in it.
// A stated limit: checkpoints (resilience/checkpoints.ts) copy vault/ with its key file and
// connectors/; the copies taken before the migration still hold the old entries until they age out
// (NOTES for Track 1).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

// Under Node's permission model a folder that doesn't exist can't be granted, so asking about a
// path in it throws instead of answering false: either way there is nothing there.
const there = (p: string) => { try { return existsSync(p); } catch { return false; } };
import { join } from 'node:path';
import { chooseStore, fileKeyStore, type KeyStore } from './keystore.ts';

// Nova's own keys (§9 row 15, Conflicts row 4): they stay in core's vault.ts and are never moved.
export const OWN_KEYS = [/^nova\//, /^capture\/hash-key$/, /^network\/[^/]+\/change\//, /^infra\/[^/]+\/run\//];

interface VaultFile { v: 1; id: string; alg: 'aes-256-gcm'; fp: string; nonce: string; tag: string; data: string }
const AAD = (id: string) => Buffer.from(`nova-vault-v1|${id}`, 'utf8');
const fp = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 16);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OldVault { id: string; map: Map<string, string>; key: Buffer; store: KeyStore }

function keyMode(env: NodeJS.ProcessEnv): 'auto' | 'file' | 'keychain' {
  const v = env.NOVA_VAULT_KEY;
  return v === 'file' || v === 'keychain' ? v : env.NODE_TEST_CONTEXT ? 'file' : 'auto';
}

export function readOldVault(home: string, o: { env?: NodeJS.ProcessEnv; store?: (id: string) => KeyStore } = {}): OldVault | null {
  const file = join(home, 'vault', 'secrets.json');
  if (!there(file)) return null;
  let f: VaultFile;
  // A parse error's message can quote the file; it never leaves this function.
  try { f = JSON.parse(readFileSync(file, 'utf8')) as VaultFile; } catch { throw new Error('The old vault’s file can’t be read.'); }
  if (f?.v !== 1 || f.alg !== 'aes-256-gcm' || !UUID.test(f.id)) throw new Error('The old vault isn’t one the broker knows.');
  const env = o.env ?? process.env;
  const disk = fileKeyStore(join(home, 'vault', 'key'));
  const kc = o.store ? o.store(f.id) : chooseStore('nova-vault', `vault-${f.id}`, join(home, 'vault', 'key'), { mode: keyMode(env), env });
  const id = f.id;
  // The launcher holds withOldVaultLock. If a re-key saved its new key but stopped before the
  // rename, recover only a same-vault pending file that authenticates under that saved key.
  // An openable current file wins; malformed, unrelated or damaged pending files stay untouched.
  for (const pending of [false, true]) {
    if (pending) {
      let next: VaultFile;
      try { next = JSON.parse(readFileSync(`${file}.tmp`, 'utf8')) as VaultFile; } catch { break; }
      if (next?.v !== 1 || next.alg !== 'aes-256-gcm' || next.id !== id) break;
      f = next;
    }
    for (const s of [kc, disk]) {
      let key: Buffer | null = null;
      try { key = s.read(); } catch { key = null; }
      if (!key || fp(key) !== f.fp) continue;
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(f.nonce, 'base64'));
      d.setAAD(AAD(f.id));
      d.setAuthTag(Buffer.from(f.tag, 'base64'));
      let map: Map<string, string>;
      try { map = new Map(Object.entries(JSON.parse(Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()]).toString('utf8')) as Record<string, string>)); } catch { throw new Error('The old vault doesn’t open with its key.'); }
      if (pending) { renameSync(`${file}.tmp`, file); chmodSync(file, 0o600); }
      return { id: f.id, map, key, store: s };
    }
  }
  throw new Error('The old vault’s key isn’t where it should be, so nothing can be moved from it.');
}

// Takes `names` out of the old vault: a new key and file without them, written in vault.ts's order
// (new file beside the old, the key saved, then the file swapped in), or no file and no key.
export function removeFromOldVault(home: string, v: OldVault, names: string[]): string[] {
  const file = join(home, 'vault', 'secrets.json');
  const gone = names.filter((n) => v.map.delete(n));
  if (!v.map.size) {
    rmSync(file, { force: true });
    v.store.remove();
    rmSync(join(home, 'vault', 'key'), { force: true });
    return gone;
  }
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(AAD(v.id));
  const data = Buffer.concat([c.update(JSON.stringify(Object.fromEntries(v.map)), 'utf8'), c.final()]);
  const out: VaultFile = { v: 1, id: v.id, alg: 'aes-256-gcm', fp: fp(key), nonce: nonce.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
  writeFileSync(`${file}.tmp`, `${JSON.stringify(out)}\n`, { mode: 0o600 });
  v.store.write(key);
  renameSync(`${file}.tmp`, file);
  chmodSync(file, 0o600);
  v.key.fill(0);
  v.key = key;
  return gone;
}

// Era 2's plaintext Gmail files (src/connectors/gmail.js), moved by the broker too.
export const GMAIL_FILES: Record<string, string> = { 'client.json': 'connector/gmail/GOOGLE_OAUTH_CLIENT', 'token.json': 'connector/gmail/GOOGLE_REFRESH_TOKEN', 'password.json': 'connector/gmail/GMAIL_APP_PASSWORD' };
export function readGmailFiles(home: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [file, name] of Object.entries(GMAIL_FILES)) {
    const p = join(home, 'connectors', 'gmail', file);
    if (!there(p)) continue;
    const text = readFileSync(p, 'utf8');
    if (!text.trim()) continue;
    let v = text;
    try { v = JSON.stringify(JSON.parse(text)); } catch { /* kept as its text, as gmail.js does */ }
    out.set(name, v);
  }
  return out;
}
export function removeGmailFiles(home: string, names: string[]): void {
  for (const [file, name] of Object.entries(GMAIL_FILES)) if (names.includes(name) && there(join(home, 'connectors', 'gmail', file))) rmSync(join(home, 'connectors', 'gmail', file), { force: true });
}

// Shared with vault.ts's writers; never steal a lock left by an interrupted process.
export function withOldVaultLock<T>(home: string, run: () => T): T {
  const dir = join(home, 'vault');
  const lock = join(dir, '.writer-lock');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch { throw new Error('The old vault is busy with a writer or migration; nothing was removed.'); }
  try { return run(); } finally { rmSync(lock, { recursive: true }); }
}

// Private to the launcher/broker pipe, never a response or audit field. A changed snapshot is
// retained wholesale; no secret comparison is exposed through conflict decisions.
export function migrationSnapshot(home: string) {
  const old = readOldVault(home);
  const gmail = readGmailFiles(home);
  const revision = createHash('sha256').update(JSON.stringify([old?.id ?? null, [...old?.map ?? []], [...gmail]])).digest('hex');
  return { old, gmail, revision };
}
```

### `src/broker/seal.ts`

```ts
// Sealed entry, the person's side (docs/plans/vault-broker.md §10 "How values come in"). Runs in
// the person's own client (WebCrypto only: a browser, or Node's globalThis.crypto) and never in
// core: a value the person types is sealed here to the broker's per-boot entry key, bound to the
// digest of the action it belongs to, and reaches the broker through core as ciphertext.
// ECDH P-256 → HKDF-SHA256 (salt: the digest, info: nova-broker-entry-v1) → AES-256-GCM (AAD: the
// digest). The broker's side is openEnvelope in crypto.ts.
//
// A stated limit: the console's code comes from core, so sealed entry rests on that code being the
// released one (ADR-9).

const enc = new TextEncoder();
const toB64 = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = '';
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s);
};
const fromB64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const fromHex = (h: string): Uint8Array<ArrayBuffer> => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

export interface Envelope { epk: string; iv: string; ct: string }

export async function sealValue(entryKeyB64: string, digest: string, value: string | Uint8Array<ArrayBuffer>): Promise<Envelope> {
  const subtle = globalThis.crypto.subtle;
  const brokerKey = await subtle.importKey('raw', fromB64(entryKeyB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const shared = await subtle.deriveBits({ name: 'ECDH', public: brokerKey }, eph.privateKey, 256);
  const hk = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: fromHex(digest), info: enc.encode('nova-broker-entry-v1') }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(digest) }, key, typeof value === 'string' ? enc.encode(value) : value);
  return { epk: toB64(await subtle.exportKey('raw', eph.publicKey)), iv: toB64(iv), ct: toB64(ct) };
}

// What an unlock factor is sealed to: not an approval, so the digest names the vault, the factor
// and this boot of the broker (from list_refs' state), and a captured envelope dies with the boot.
export async function unlockDigest(vaultId: string, factor: string, boot: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest('SHA-256', enc.encode(`nova-broker-unlock|${vaultId}|${factor}|${boot}`));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
```

### `src/broker/main.ts`

```ts
// The broker process (§3). Started by the supervisor, as its own child and never core's, with
// spawn.ts's hardening: an empty environment, Node's permission model narrowed to the broker's
// folder, no inspector, --disable-sigusr1. Its two tokens arrive over Node's IPC channel, never on
// argv or in the environment.
//   node src/broker/main.ts <broker folder>
import { Broker } from './broker.ts';
import { serve, socketPath, type Tokens } from './server.ts';

const dir = process.argv[2];
if (!dir || !process.send) {
  process.stderr.write('The broker is started by the supervisor (src/broker/spawn.ts), with its folder and an IPC channel.\n');
  process.exit(2);
}

process.once('message', async (msg: { tokens?: Tokens; key_mode?: 'auto' | 'file' | 'keychain' }) => {
  try {
    const broker = new Broker({ dir, ...(msg.key_mode ? { keyMode: msg.key_mode } : {}) });
    broker.start();
    const path = socketPath(dir);
    const server = await serve(broker, path, msg.tokens!);
    const stop = () => { broker.lock(); server.close(); process.exit(0); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    process.send!({ ready: true, socket: path, locked: !broker.store.unlocked });
    process.channel?.unref();
  } catch (e) {
    process.send!({ ready: false, problem: (e as Error).message });
    process.exit(1);
  }
});
```

### `src/broker/spawn.ts`

```ts
// Starting the broker (for the supervisor; §3 "Start and supervision", "Hardening"). Its command
// follows the runtime agent's (device/boot.ts): Node's permission model with reads narrowed to the
// broker's own code and folder and writes to its folder, no inspector, --disable-sigusr1,
// diagnostics confined to its folder, and an empty environment (no NODE_OPTIONS, no proxy
// variables). Network access stays allowed, because `use` needs it, and so do child processes:
// the broker starts its own launcher (programs, the old vault) and, with a keychain, its CLIs.
// A stated limit: Node's permission model doesn't follow a child, so the file-system narrowing is
// defence in depth against a bug in the broker, not a wall against code that runs as it.
//
// The supervisor makes the two 256-bit tokens and hands each child its own: the broker gets both
// over this IPC channel, and core gets its own the same way from the supervisor.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Tokens } from './server.ts';

export const BROKER_SRC = dirname(fileURLToPath(import.meta.url));

export function brokerCommand(dir: string): string[] {
  return [
    '--permission', `--allow-fs-read=${BROKER_SRC}/`, `--allow-fs-read=${dir}/`, `--allow-fs-write=${dir}/`, '--allow-net', '--allow-child-process',
    '--no-experimental-sqlite', '--no-experimental-webstorage', '--disable-sigusr1', `--diagnostic-dir=${dir}`,
    '--disable-warning=ExperimentalWarning', join(BROKER_SRC, 'main.ts'), dir,
  ];
}

export interface Started { child: ChildProcess; socket: string; tokens: Tokens; locked: boolean }

export function startBroker(dir: string, o: { keyMode?: 'auto' | 'file' | 'keychain'; env?: NodeJS.ProcessEnv; timeoutMs?: number; pipe?: boolean } = {}): Promise<Started> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const keychain = o.keyMode !== 'file';
  const env = o.env ?? process.env;
  // Only what the keychain CLIs need to reach a desktop session; nothing else of the parent's.
  const childEnv: NodeJS.ProcessEnv = { TZ: env.TZ ?? 'UTC', ...(keychain && env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS } : {}), ...(keychain && env.PATH ? { PATH: env.PATH } : {}) };
  const tokens: Tokens = { core: randomBytes(32).toString('hex'), supervisor: randomBytes(32).toString('hex') };
  const child = spawn(process.execPath, brokerCommand(dir), { cwd: dir, env: childEnv, stdio: ['ignore', o.pipe ? 'pipe' : 'inherit', o.pipe ? 'pipe' : 'inherit', 'ipc'] });
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => { child.kill(); fail(new Error('The broker didn’t start in time.')); }, o.timeoutMs ?? 20_000);
    child.once('exit', (code) => { clearTimeout(timer); fail(new Error(`The broker exited at start (code ${code}).`)); });
    child.once('message', (m: { ready?: boolean; socket?: string; problem?: string; locked?: boolean }) => {
      clearTimeout(timer);
      child.removeAllListeners('exit');
      if (!m.ready) return fail(new Error(`The broker couldn’t start: ${m.problem}`));
      ok({ child, socket: m.socket!, tokens, locked: !!m.locked });
    });
    child.send({ tokens, ...(o.keyMode ? { key_mode: o.keyMode } : {}) });
  });
}
```

### `src/core/broker/client.ts`

```ts
// Core's client for the Credential Broker (docs/plans/vault-broker.md §3, §9 row 1). Core holds
// refs and metadata only: none of these methods returns a value, because the broker never sends
// one to core. It imports the broker's protocol types only (erased at run time), and nothing of
// the broker's code: the broker is a separate process, reached over its local socket.
//
// What core does with a credential:
//  - list_refs, for names, sites, usernames, bindings, classes and health flags;
//  - use, for an http request the broker sends itself, a check of a callback's signature, or a
//    program the broker runs through its own launcher (the answer is its exit code and its output,
//    scrubbed of the value);
//  - create, update, rotate, bind and share_scope, each answering needs_approval with a challenge
//    first; the person's client approves it, and seals any value it types (src/broker/seal.ts);
//  - the migration from vault.ts, through the broker's launcher, so no old value is read in core.
import { connect, type Socket } from 'node:net';
import type { AuditRecord, Challenge, Refusal, RefMeta, Target } from '../../broker/protocol.ts';

export type { AuditRecord, Challenge, Refusal, RefMeta, Target };

export interface Answer {
  id: number;
  ok?: true;
  refused?: Refusal;
  error?: string;
  words?: string;
  challenge?: Challenge;
  record?: AuditRecord;
  [k: string]: unknown;
}
export interface Approval { id: string; digest: string; mode: 'core' | 'passkey'; credential_id?: string; authenticator_data?: string; client_data_json?: string; signature?: string }
export interface Ask { task?: { id: string; title: string }; caller?: string; approval?: Approval }

export class BrokerError extends Error {
  readonly answer: Answer;
  constructor(a: Answer) { super(a.words ?? a.refused ?? a.error ?? 'The broker refused.'); this.answer = a; }
}

export class BrokerClient {
  readonly socket: string;
  #token: string;
  #sock: Socket | null = null;
  #ready: Promise<void> | null = null;
  #n = 0;
  #buf = '';
  #waiting = new Map<number, (a: Answer) => void>();
  // Every audit record the broker sent back, for the Work Ledger (§8): core copies each one under
  // its task, and a gap in the sequence shows in Health.
  onRecord: ((r: AuditRecord) => void) | null = null;

  constructor(o: { socket: string; token: string }) {
    this.socket = o.socket;
    this.#token = o.token;
  }

  #open(): Promise<void> {
    if (this.#ready) return this.#ready;
    this.#ready = new Promise((ok, fail) => {
      const s = connect(this.socket);
      s.setEncoding('utf8');
      s.on('data', (c: string) => {
        this.#buf += c;
        let i: number;
        while ((i = this.#buf.indexOf('\n')) >= 0) {
          const line = this.#buf.slice(0, i);
          this.#buf = this.#buf.slice(i + 1);
          let a: Answer;
          try { a = JSON.parse(line) as Answer; } catch { continue; }
          if (a.record && this.onRecord) this.onRecord(a.record);
          this.#waiting.get(a.id)?.(a);
          this.#waiting.delete(a.id);
        }
      });
      const gone = () => { this.#sock = null; this.#ready = null; for (const w of this.#waiting.values()) w({ id: -1, error: 'failed', words: 'Nova’s vault isn’t running.' }); this.#waiting.clear(); };
      s.on('close', gone);
      s.once('error', (e) => { gone(); fail(new Error(`Nova’s vault isn’t running (${(e as NodeJS.ErrnoException).code ?? e.message}).`)); });
      s.once('connect', async () => {
        this.#sock = s;
        const a = await this.#send('hello', { token: this.#token });
        if (a.ok) ok(); else fail(new BrokerError(a));
      });
    });
    return this.#ready;
  }

  #send(m: string, f: Record<string, unknown>): Promise<Answer> {
    const id = ++this.#n;
    return new Promise((ok) => {
      this.#waiting.set(id, ok);
      this.#sock!.write(`${JSON.stringify({ id, m, ...f })}\n`);
    });
  }

  async call(m: string, f: Record<string, unknown> = {}): Promise<Answer> {
    await this.#open();
    return this.#send(m, f);
  }

  close(): void { this.#sock?.end(); this.#sock = null; this.#ready = null; }

  // ---- the protocol messages and the seven verbs ----------------------------------------------

  state() { return this.call('list_refs', {}).then((a) => a.state as Record<string, unknown>); }
  unlock(factor: Record<string, unknown>) { return this.call('unlock', factor); }
  lock() { return this.call('lock'); }
  listRefs(filter: { prefix?: string; kind?: string } = {}) { return this.call('list_refs', { filter }); }
  use(ref: string, target: Target, request: Record<string, unknown>, ask: Ask & { version?: 'pending' } = {}) { return this.call('use', { ref, target, request, ...ask }); }
  create(meta: Record<string, unknown>, source: unknown, ask: Ask & { bind?: unknown[] } = {}) { return this.call('create', { meta, source, ...ask }); }
  update(ref: string, change: unknown, ask: Ask = {}) { return this.call('update', { ref, change, ...ask }); }
  rotate(ref: string, phase: 'begin' | 'commit' | 'abandon', ask: Ask = {}) { return this.call('rotate', { ref, phase, ...ask }); }
  bind(ref: string, change: { add?: unknown; remove?: unknown }, ask: Ask = {}) { return this.call('bind', { ref, ...change, ...ask }); }
  shareScope(scope: { device?: unknown; backend?: unknown }, ask: Ask = {}) { return this.call('share_scope', { ...scope, ...ask }); }

  // ---- the migration from vault.ts (§10) -----------------------------------------------------

  // Stage (the broker's own launcher reads the old vault in the broker's home and hands it over by
  // pipe; the answer is a count), commit (tier 3: each entry becomes an unbound item, is read back,
  // and leaves the old vault), then propose (tier 3: one card of bindings and classes). Core never
  // opens the old vault, and names no folder for the broker to read.
  migrateStage(ask: Ask = {}) { return this.create({}, { migrate: 'stage' }, ask); }
  migrateCommit(ask: Ask = {}) { return this.create({}, { migrate: 'commit' }, ask); }
  migratePropose(proposals: Record<string, { origin?: string; class?: string; bind?: unknown[] }>, ask: Ask = {}) {
    return this.create({}, { migrate: 'propose', proposals }, ask);
  }
}

// Nova's own keys stay in core's vault.ts (§9 row 15); everything else in it is a credential the
// migration proposes to move.
export const OWN_KEY_NAMES = [/^nova\//, /^capture\/hash-key$/, /^network\/[^/]+\/change\//, /^infra\/[^/]+\/run\//];
export const isOwnKey = (name: string) => OWN_KEY_NAMES.some((r) => r.test(name));

// Paths in the home a backup, the home's git, the sync journal and a checkpoint must treat
// specially (§10 "No escrow"): only items/ is backed up; the header, wraps, device key, socket and
// audit log never are.
export const BROKER_DIR = 'broker';
export const BROKER_BACKUP_ONLY = 'broker/items/';
```

### `src/core/vault.ts`

```ts
// The vault (inventory row 58; Era 1's packages/secrets, ported and narrowed). Secrets live here
// and nowhere else: connectors hold names (`secret://connector/home-assistant/HA_TOKEN`), and the
// values are read for the moment a call needs them.
//
// At rest: one file, home/vault/secrets.json (0600), AES-256-GCM over the JSON map of name → value,
// with the vault's id as associated data. The 32-byte key lives in the OS keychain when there is one
// (Linux `secret-tool`, macOS `security`, Windows Credential Locker through PowerShell), otherwise in
// home/vault/key (0600), and then the person is told plainly that the key sits next to the vault.
// Values never go on a command line: each keychain CLI reads them from stdin.
//
// The vault is untracked in the home's git (home.js), not journalled as a file (mesh/sync.ts), and
// every value it holds is redacted from logs, problems and receipts (log.ts). A standby gets the
// ciphertext and the key inside the sync stream, which is sealed to the standby's own key, so
// connectors work again after a failover.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoreError } from './errors.ts';
import { addSecretValue } from './log.ts';

export const VAULT_DIR = 'vault';
export const VAULT_FILE = 'secrets.json';
export const KEY_FILE = 'key';
export const SECRET_SCHEME = 'secret://';
// connector/home-assistant/HA_TOKEN: lowercase path segments, then a name.
const NAME = /^[a-z0-9][a-z0-9._-]*(\/[A-Za-z0-9._-]+)*$/;
const AAD = (id: string) => Buffer.from(`nova-vault-v1|${id}`, 'utf8');
const SERVICE = 'nova-vault';

export const isSecretName = (name: string) => typeof name === 'string' && name.length <= 200 && NAME.test(name);
export const secretRef = (name: string) => `${SECRET_SCHEME}${checkName(name)}`;
export function nameOf(ref: string): string {
  if (typeof ref !== 'string' || !ref.startsWith(SECRET_SCHEME)) throw new CoreError('validation', 'That isn’t a secret:// reference.');
  return checkName(ref.slice(SECRET_SCHEME.length));
}
function checkName(name: string): string {
  if (!isSecretName(name)) throw new CoreError('validation', `“${String(name)}” isn’t a secret name Nova uses (letters, digits, dots, dashes, slashes).`);
  return name;
}

// ---- where the key lives ------------------------------------------------------------------------

export interface CommandResult { code: number | null; stdout: string; stderr: string; error: string | null }
export type Run = (cmd: string, args: string[], input?: string) => CommandResult;

// Without a shell, with a timeout: a locked keyring can open a prompt nobody will answer.
export const runCommand: Run = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { input: input ?? '', encoding: 'utf8', timeout: 10_000, shell: false, windowsHide: true });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ? r.error.message : null };
};

export interface KeyStore {
  kind: 'keychain' | 'file';
  // In plain words, for Settings and health: “the system keychain (secret-tool)”.
  name: string;
  available(): { ok: boolean; detail: string };
  read(): Buffer | null;
  write(key: Buffer): void;
  remove(): void;
}

function decodeKey(text: string): Buffer | null {
  const key = Buffer.from(text.trim(), 'base64');
  return key.length === 32 ? key : null;
}
const failure = (cli: string, what: string, r: CommandResult) =>
  new Error(`The system keychain couldn’t ${what} (${cli}: ${r.error ?? (r.stderr.trim().split('\n')[0] || `exit code ${r.code}`)}).`);

export function fileKeyStore(home: string): KeyStore {
  const path = join(home, VAULT_DIR, KEY_FILE);
  return {
    kind: 'file',
    name: `a key file next to the vault (${path})`,
    available: () => ({ ok: true, detail: path }),
    read: () => {
      if (!existsSync(path)) return null;
      const key = readFileSync(path);
      if (key.length !== 32) throw new CoreError('conflict', `The vault’s key file (${path}) is damaged: it should be 32 bytes.`);
      return key;
    },
    write: (key) => {
      mkdirSync(join(home, VAULT_DIR), { recursive: true, mode: 0o700 });
      writeFileSync(`${path}.tmp`, key, { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
      chmodSync(path, 0o600);
    },
    remove: () => rmSync(path, { force: true }),
  };
}

// Linux: the Secret Service, through libsecret's CLI. Exit 1 with nothing on stderr is “no such item”.
export function secretToolKeyStore(account: string, o: { run?: Run; env?: NodeJS.ProcessEnv; command?: string } = {}): KeyStore {
  const run = o.run ?? runCommand;
  const env = o.env ?? process.env;
  const cmd = o.command ?? 'secret-tool';
  const attrs = ['service', SERVICE, 'account', account];
  const lookup = (acct: string) => run(cmd, ['lookup', 'service', SERVICE, 'account', acct]);
  return {
    kind: 'keychain',
    name: 'the system keychain (secret-tool)',
    available: () => {
      if (!env.DBUS_SESSION_BUS_ADDRESS) return { ok: false, detail: 'no desktop session to reach the keychain through' };
      const r = lookup('nova-probe');
      if (r.code === 0 || (r.code === 1 && !r.stderr.trim())) return { ok: true, detail: 'secret-tool' };
      return { ok: false, detail: r.error ?? r.stderr.trim().split('\n')[0] ?? `exit code ${r.code}` };
    },
    read: () => {
      const r = lookup(account);
      if (r.code === 0) return decodeKey(r.stdout);
      if (r.code === 1 && !r.stderr.trim()) return null;
      throw failure('secret-tool', 'read the vault’s key', r);
    },
    write: (key) => {
      const r = run(cmd, ['store', `--label=Nova vault key (${account})`, ...attrs], key.toString('base64'));
      if (r.code !== 0) throw failure('secret-tool', 'store the vault’s key', r);
    },
    remove: () => { run(cmd, ['clear', ...attrs]); },
  };
}

// macOS: the login keychain. Interactive mode reads the command from stdin, so the key stays off
// the argument list. Exit 44 is “no such item”.
export function macKeyStore(account: string, o: { run?: Run; command?: string } = {}): KeyStore {
  const run = o.run ?? runCommand;
  const cmd = o.command ?? 'security';
  return {
    kind: 'keychain',
    name: 'the macOS keychain',
    available: () => {
      const r = run(cmd, ['default-keychain']);
      return r.code === 0 ? { ok: true, detail: 'security' } : { ok: false, detail: r.error ?? (r.stderr.trim() || `exit code ${r.code}`) };
    },
    read: () => {
      const r = run(cmd, ['find-generic-password', '-s', SERVICE, '-a', account, '-w']);
      if (r.code === 0) return decodeKey(r.stdout);
      if (r.code === 44) return null;
      throw failure('security', 'read the vault’s key', r);
    },
    write: (key) => {
      const r = run(cmd, ['-i'], `add-generic-password -U -s ${SERVICE} -a ${account} -l "Nova vault key" -w ${key.toString('base64')}\n`);
      if (r.code !== 0 || r.stderr.trim()) throw failure('security', 'store the vault’s key', r);
    },
    remove: () => { run(cmd, ['delete-generic-password', '-s', SERVICE, '-a', account]); },
  };
}

// Windows: the Credential Locker (it shows in Credential Manager), through PowerShell's WinRT
// binding. The key comes in on stdin. Not exercised on a real Windows machine yet (docs/LEDGER.md).
export function windowsKeyStore(account: string, o: { run?: Run; command?: string } = {}): KeyStore {
  const run = o.run ?? runCommand;
  const cmd = o.command ?? 'powershell.exe';
  const vault = `[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]; $v = New-Object Windows.Security.Credentials.PasswordVault;`;
  const find = `try { $c = $v.Retrieve('${SERVICE}', '${account}') } catch { exit 44 };`;
  const ps = (script: string, input?: string) => run(cmd, ['-NoProfile', '-NonInteractive', '-Command', `& { ${vault} ${script} }`], input);
  return {
    kind: 'keychain',
    name: 'Windows Credential Manager',
    available: () => {
      const r = ps('exit 0');
      return r.code === 0 ? { ok: true, detail: 'PasswordVault' } : { ok: false, detail: r.error ?? (r.stderr.trim() || `exit code ${r.code}`) };
    },
    read: () => {
      const r = ps(`${find} $c.RetrievePassword(); [Console]::Out.Write($c.Password)`);
      if (r.code === 0) return decodeKey(r.stdout);
      if (r.code === 44) return null;
      throw failure('PowerShell', 'read the vault’s key', r);
    },
    write: (key) => {
      const r = ps(`$p = [Console]::In.ReadToEnd().Trim(); $v.Add((New-Object Windows.Security.Credentials.PasswordCredential('${SERVICE}', '${account}', $p)))`, key.toString('base64'));
      if (r.code !== 0) throw failure('PowerShell', 'store the vault’s key', r);
    },
    remove: () => { ps(`${find} $v.Remove($c)`); },
  };
}

export function platformKeyStore(account: string, o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; run?: Run } = {}): KeyStore | null {
  const platform = o.platform ?? process.platform;
  if (platform === 'darwin') return macKeyStore(account, o);
  if (platform === 'win32') return windowsKeyStore(account, o);
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') return secretToolKeyStore(account, o);
  return null;
}

// file: always the key file. keychain: the OS keychain or nothing. auto: the keychain when one
// answers, else the file. Under the test runner, auto means file: tests never touch a real keychain.
export type KeyMode = 'auto' | 'keychain' | 'file';
export function keyMode(env: NodeJS.ProcessEnv = process.env): KeyMode {
  const v = env.NOVA_VAULT_KEY;
  if (v === 'file' || v === 'keychain') return v;
  return env.NODE_TEST_CONTEXT ? 'file' : 'auto';
}

// ---- the vault ----------------------------------------------------------------------------------

interface VaultFile { v: 1; id: string; alg: 'aes-256-gcm'; fp: string; nonce: string; tag: string; data: string }

export interface VaultOptions {
  home: string;
  mode?: KeyMode;
  // The keychain to use for a vault id (tests inject one); defaults to this platform's.
  keychain?: ((account: string) => KeyStore | null) | null;
}

export interface VaultStatus {
  ok: boolean;
  secrets: number;
  // Where the key is, once there is one: keychain or file.
  key: 'keychain' | 'file' | null;
  where: string | null;
  // Said plainly when the key sits next to the vault on disk.
  notice: string | null;
  problem: string | null;
}

export const FILE_KEY_NOTICE = 'Nova keeps your connection secrets encrypted, but on this computer there is no system keychain it can use, so the key is in a file next to them (vault/key in Nova’s home). Anyone who can read Nova’s home folder can open them. Nova moves the key into the keychain by itself once one is available.';

const START_OVER = 'Saving a secret again (reconnecting a connection, or adding a provider’s key) starts a new vault; the old file is kept aside in vault/ as secrets.json.unopenable-<time>, in case its key turns up.';

const fp = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 16);

export class Vault extends EventEmitter {
  readonly dir: string;
  readonly file: string;
  #home: string;
  #mode: KeyMode;
  #keychainFor: (account: string) => KeyStore | null;
  #key: Buffer | null = null;
  #store: KeyStore | null = null;
  #id: string | null = null;
  #map: Map<string, string> | null = null;
  #problem: string | null = null;
  #writing = false;
  // Why it won't open: lost for good (no key that fits, or a damaged file), or a keychain that may
  // still answer later. Only a lost vault is set aside by the next save.
  #unopenable: 'lost' | 'waiting' | null = null;

  constructor(o: VaultOptions) {
    super();
    this.#home = o.home;
    this.dir = join(o.home, VAULT_DIR);
    this.file = join(this.dir, VAULT_FILE);
    this.#mode = o.mode ?? keyMode();
    this.#keychainFor = o.keychain === null ? () => null : (o.keychain ?? ((account) => platformKeyStore(account)));
  }

  // ---- reading and writing ------------------------------------------------------------------

  has(name: string): boolean {
    return this.#open().has(checkName(name));
  }

  get(name: string): string | null {
    return this.#open().get(checkName(name)) ?? null;
  }

  resolve(ref: string): string | null {
    return this.get(nameOf(ref));
  }

  put(name: string, value: string): string { return this.#withWrite(() => this.#put(name, value), true); }
  #put(name: string, value: string): string {
    checkName(name);
    if (typeof value !== 'string' || !value.length) throw new CoreError('validation', 'A secret can’t be empty.');
    // A vault that can never open again would refuse every save forever. Saving starts a new one
    // instead (reconnecting is how a person saves again), and the old file is kept aside.
    let map: Map<string, string>;
    try { map = this.#open(); } catch (e) {
      if (this.#unopenable !== 'lost') throw e;
      map = this.#startOver();
    }
    const before = map.get(name);
    map.set(name, value);
    addSecretValue(value);
    try {
      this.#save(map);
    } catch (e) {
      // Not saved means not kept: the vault goes on holding what is on disk (a full disk, M7b).
      if (before === undefined) map.delete(name); else map.set(name, before);
      rmSync(`${this.file}.tmp`, { force: true });
      const full = (e as NodeJS.ErrnoException).code === 'ENOSPC';
      throw new CoreError('conflict', full ? 'Nova couldn’t save the secret: the disk is full. Nothing was changed; free some space and save it again.' : `Nova couldn’t save the secret: ${(e as Error).message}. Nothing was changed.`, [`${(e as NodeJS.ErrnoException).code ?? 'error'}: ${(e as Error).message}`]);
    }
    return secretRef(name);
  }

  // A new key each time something is deleted, so a copy of the file from before (a backup, an old
  // sync entry) doesn't open with the key in use: the deleted secret stays deleted.
  delete(name: string): boolean { return this.#withWrite(() => this.#delete(name), true); }
  #delete(name: string): boolean {
    const map = this.#open();
    if (!map.delete(checkName(name))) return false;
    this.#save(map, true);
    return true;
  }

  // Starts a new, empty vault on purpose (tier 3: needs confirm), with the old file kept aside: for
  // a vault whose key is in a keychain that no longer answers, which saving alone won't replace.
  reset(confirm: boolean): VaultStatus { return this.#withWrite(() => this.#reset(confirm)); }
  #reset(confirm: boolean): VaultStatus {
    if (!confirm) throw new CoreError('validation', 'Starting a new vault leaves every saved secret behind (the old file is kept aside). Send confirm: true to do that.');
    this.#startOver();
    this.emit('change', { secrets: 0 });
    return this.status();
  }

  // Everything under a prefix (`connector/gmail/`), for revoking an extension's secrets at once.
  deletePrefix(prefix: string): string[] { return this.#withWrite(() => this.#deletePrefix(prefix), true); }
  #deletePrefix(prefix: string): string[] {
    const map = this.#open();
    const gone = [...map.keys()].filter((k) => k.startsWith(prefix));
    if (!gone.length) return [];
    for (const k of gone) map.delete(k);
    this.#save(map, true);
    return gone;
  }

  list(prefix = ''): string[] {
    return [...this.#open().keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  status(): VaultStatus {
    try {
      const n = this.#open().size;
      const store = this.#key ? this.#store : null;
      return { ok: true, secrets: n, key: store?.kind ?? null, where: store?.name ?? null, notice: store?.kind === 'file' && n > 0 ? FILE_KEY_NOTICE : null, problem: null };
    } catch (e) {
      return { ok: false, secrets: 0, key: null, where: null, notice: null, problem: (e as Error).message };
    }
  }

  // ---- a factory reset (resilience/reset.ts) ---------------------------------------------------

  // The vault ids whose key may be in a keychain: the file's, and the one in use.
  keyIds(): string[] {
    const ids = new Set<string>();
    if (this.#id) ids.add(this.#id);
    try { ids.add(parseFile(readFileSync(this.file, 'utf8')).id); } catch { /* no file, or one Nova can't read */ }
    return [...ids];
  }

  // Removes this vault's key wherever it is: the keychain item of each id (this vault's, and any
  // given) and the key file. The vault holds nothing after this. Returns where it was removed from,
  // in plain words; a keychain that isn't answering is said, not guessed at.
  forgetKeys(ids: string[] = []): { keychain: string | null; file: boolean; problem: string | null } { return this.#withWrite(() => this.#forgetKeys(ids)); }
  #forgetKeys(ids: string[] = []): { keychain: string | null; file: boolean; problem: string | null } {
    let keychain: string | null = null;
    let problem: string | null = null;
    if (this.#mode !== 'file') {
      for (const id of new Set([...this.keyIds(), ...ids].filter((i) => UUID.test(i)))) {
        const kc = this.#keychainFor(`vault-${id}`);
        if (!kc) continue;
        const up = kc.available();
        if (!up.ok) { problem = `The vault’s key may still be in ${kc.name}, which isn’t answering (${up.detail}). It opens nothing now; remove the item “${SERVICE} / vault-${id}” there yourself.`; continue; }
        kc.remove();
        keychain = kc.name;
      }
    }
    const disk = fileKeyStore(this.#home);
    const file = existsSync(join(this.dir, KEY_FILE));
    disk.remove();
    this.#key = null;
    this.#store = null;
    this.#map = null;
    return { keychain, file, problem };
  }

  // ---- the standby's copy (mesh/sync.ts) ------------------------------------------------------

  // The encrypted file as it is on disk, for the sync log. Never the key.
  sealedFile(): string | null {
    try { return readFileSync(this.file, 'utf8'); } catch { return null; }
  }

  // The key, for the sync stream only: it travels inside a batch sealed to the standby's own key.
  keyForStandby(): string | null {
    if (!existsSync(this.file)) return null;
    this.#open();
    return this.#key?.toString('base64') ?? null;
  }

  // On the standby: the hub's vault, and its key, which goes into this node's own key store.
  adopt(fileText: string, keyB64: string): void { this.#withWrite(() => this.#adopt(fileText, keyB64)); }
  #adopt(fileText: string, keyB64: string): void {
    const key = Buffer.from(String(keyB64), 'base64');
    if (key.length !== 32) throw new CoreError('validation', 'The hub sent a vault key Nova can’t use.');
    const file = parseFile(fileText);
    const map = decrypt(file, key);
    const store = this.#choose(file.id);
    store.write(key);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeAtomic(this.file, fileText);
    this.#id = file.id;
    this.#key = key;
    this.#store = store;
    this.#map = map;
    this.#problem = null;
    for (const v of map.values()) addSecretValue(v);
    this.emit('change', { secrets: map.size });
  }

  // On the standby: the hub's vault is gone (its last secret was removed).
  clear(): void { this.#withWrite(() => this.#clear()); }
  #clear(): void {
    rmSync(this.file, { force: true });
    this.#map = new Map();
    this.emit('change', { secrets: 0 });
  }

  // ---- inside -------------------------------------------------------------------------------

  // Same fail-closed lock as the broker's migration launcher. The mutation reloads under the
  // lock, so a long-lived consumer cannot resurrect entries from its pre-migration cache.
  #withWrite<T>(run: () => T, refresh = false): T {
    if (this.#writing) return run();
    const lock = join(this.dir, '.writer-lock');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch { throw new CoreError('conflict', 'The vault is busy with a writer or migration. Try again after it finishes; an interrupted lock needs operator recovery.'); }
    this.#writing = true;
    try {
      if (refresh) {
        this.#map = null;
        this.#key = null;
        this.#store = null;
        this.#problem = null;
        this.#unopenable = null;
      }
      return run();
    } finally { this.#writing = false; rmSync(lock, { recursive: true }); }
  }

  // The keychain when the mode allows one and it answers, else the key file.
  #choose(id = this.#id ?? 'new'): KeyStore {
    const file = fileKeyStore(this.#home);
    if (this.#mode === 'file') return file;
    const kc = this.#keychainFor(`vault-${id}`);
    const up = kc ? kc.available() : { ok: false, detail: 'none on this platform' };
    if (kc && up.ok) return kc;
    if (this.#mode === 'keychain') throw new CoreError('conflict', `Nova is set to keep the vault’s key in the system keychain (NOVA_VAULT_KEY=keychain), but none answers: ${up.detail}.`);
    return file;
  }

  #open(): Map<string, string> { return this.#withWrite(() => this.#openLocked()); }
  #openLocked(): Map<string, string> {
    if (this.#map) return this.#map;
    // A keychain that wasn't answering is asked again; a lost vault stays lost.
    if (this.#problem && this.#unopenable !== 'waiting') throw new CoreError('conflict', this.#problem);
    this.#problem = null;
    this.#unopenable = null;
    if (!existsSync(this.file)) {
      this.#map = new Map();
      return this.#map;
    }
    let file: VaultFile;
    try {
      file = parseFile(readFileSync(this.file, 'utf8'));
    } catch (e) {
      this.#unopenable = 'lost';
      this.#problem = `The vault (${this.file}) is damaged and can’t be read: ${(e as Error).message}. ${START_OVER}`;
      throw new CoreError('conflict', this.#problem);
    }
    this.#id = file.id;
    let found: { key: Buffer; store: KeyStore; file: VaultFile };
    try {
      found = { ...this.#findKey(file), file };
    } catch (e) {
      // A re-key cut short: the new key was saved, and the new file is still beside the old one.
      const done = this.#finishRekey(file);
      if (!done) throw e;
      found = done;
    }
    let map: Map<string, string>;
    try { map = decrypt(found.file, found.key); } catch (e) {
      this.#unopenable = 'lost';
      this.#problem = `${(e as Error).message} ${START_OVER}`;
      throw new CoreError('conflict', this.#problem);
    }
    rmSync(`${this.file}.tmp`, { force: true });
    this.#problem = null;
    this.#unopenable = null;
    this.#map = map;
    this.#key = found.key;
    this.#store = found.store;
    for (const v of this.#map.values()) addSecretValue(v);
    return this.#map;
  }

  #finishRekey(file: VaultFile): { key: Buffer; store: KeyStore; file: VaultFile } | null {
    const tmp = `${this.file}.tmp`;
    if (!existsSync(tmp)) return null;
    let next: VaultFile;
    try { next = parseFile(readFileSync(tmp, 'utf8')); } catch { return null; }
    if (next.id !== file.id) return null;
    const why = { problem: this.#problem, unopenable: this.#unopenable };
    try {
      const found = this.#findKey(next);
      decrypt(next, found.key);
      renameSync(tmp, this.file);
      return { ...found, file: next };
    } catch {
      this.#problem = why.problem;
      this.#unopenable = why.unopenable;
      return null;
    }
  }

  // The unopenable file goes aside as secrets.json.unopenable-<time> (in case its key turns up), and
  // a new vault with a new id and key takes its place on the next save.
  #startOver(): Map<string, string> {
    if (existsSync(this.file)) renameSync(this.file, `${this.file}.unopenable-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    rmSync(`${this.file}.tmp`, { force: true });
    this.#id = null;
    this.#key = null;
    this.#store = null;
    this.#problem = null;
    this.#unopenable = null;
    this.#map = new Map();
    return this.#map;
  }

  // The key for this vault, wherever it is. A key found in the file while a keychain answers is
  // moved into the keychain (written, read back, and only then removed from disk).
  #findKey(file: VaultFile): { key: Buffer; store: KeyStore } {
    const disk = fileKeyStore(this.#home);
    const kc = this.#mode === 'file' ? null : this.#keychainFor(`vault-${file.id}`);
    const kcUp = kc ? kc.available() : null;
    const fromKc = kc && kcUp?.ok ? kc.read() : null;
    const fromDisk = disk.read();
    const fits = (k: Buffer | null) => !!k && fp(k) === file.fp;
    if (fits(fromKc)) {
      if (fromDisk && fits(fromDisk)) disk.remove();
      return { key: fromKc!, store: kc! };
    }
    if (fits(fromDisk)) {
      if (kc && kcUp?.ok) {
        try {
          kc.write(fromDisk!);
          if (fits(kc.read())) { disk.remove(); return { key: fromDisk!, store: kc }; }
        } catch { /* the keychain refused: the file stays where it is */ }
      }
      return { key: fromDisk!, store: disk };
    }
    if (kc && !kcUp?.ok) {
      this.#unopenable = 'waiting';
      this.#problem = `Nova can’t find the key to its vault, so connections that need a secret can’t sign in. It may be in the system keychain, which isn’t answering (${kcUp?.detail}). Nova waits for the keychain rather than starting over; to start a new vault anyway, reset the vault (tier 3: POST /api/v1/vault/reset with confirm: true), and the old one is kept aside.`;
    } else {
      this.#unopenable = 'lost';
      this.#problem = `Nova can’t find the key to its vault, so connections that need a secret can’t sign in. ${START_OVER}`;
    }
    throw new CoreError('conflict', this.#problem);
  }

  // With a new key (the first save, or `rekey`), the order keeps the vault openable whatever stops
  // it: the new file is written beside the old, then the key saved, then the file swapped in.
  // Stopped between the last two, opening finishes the swap (#finishRekey).
  #save(map: Map<string, string>, rekey = false): void {
    this.#id ??= randomUUID();
    const id = this.#id;
    const fresh = !this.#key || rekey;
    const key = fresh ? randomBytes(32) : this.#key!;
    const store = this.#store ?? this.#choose(id);
    if (!map.size) {
      // Nothing left to keep: no file, and a new key for whatever comes next.
      if (fresh) store.write(key);
      this.#key = key;
      this.#store = store;
      rmSync(this.file, { force: true });
      this.emit('change', { secrets: 0 });
      return;
    }
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, nonce);
    c.setAAD(AAD(id));
    const data = Buffer.concat([c.update(JSON.stringify(Object.fromEntries(map)), 'utf8'), c.final()]);
    const out: VaultFile = { v: 1, id, alg: 'aes-256-gcm', fp: fp(key), nonce: nonce.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(out)}\n`, { mode: 0o600 });
    if (fresh) store.write(key);
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
    this.#key = key;
    this.#store = store;
    this.emit('change', { secrets: map.size });
  }
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

// The id names the keychain item (vault-<id>), and one keychain CLI takes it inside command text:
// only a UUID gets that far.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function parseFile(text: string): VaultFile {
  const f = JSON.parse(text) as VaultFile;
  if (f?.v !== 1 || f.alg !== 'aes-256-gcm' || typeof f.id !== 'string' || typeof f.data !== 'string' || typeof f.fp !== 'string') throw new Error('not a vault Nova knows');
  if (!UUID.test(f.id)) throw new Error('its id isn’t one Nova makes');
  return f;
}

// Wrong key or a tampered file: refused, never guessed at.
function decrypt(f: VaultFile, key: Buffer): Map<string, string> {
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(f.nonce, 'base64'));
    d.setAAD(AAD(f.id));
    d.setAuthTag(Buffer.from(f.tag, 'base64'));
    const plain = Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()]).toString('utf8');
    return new Map(Object.entries(JSON.parse(plain) as Record<string, string>));
  } catch {
    throw new CoreError('conflict', 'The vault doesn’t open with its key: the key is wrong or the file was changed.');
  }
}
```
