# Review packet: Nova Credential Broker and Nova Vault — current P1a

Source: **`44a8deb563324ac2847c02dc82dfc6e3aec32d85`**, accepted Tasks1–6, 2026-11-03. This packet contains the unchanged claims, threat model, architecture, stated limits, attack questions and complete actual source: 30 files, including the whole broker/client/cooperating legacy writer plus supervisor, Core/server/bootstrap/reset/diagnostics/exclusion/backup/sync integration. Every code block carries immutable Git blob, SHA256 and line count; machine-readable manifest is linked below. Broker **2896/3000** under the original boundary rule, 104 lines remaining; no raised budget/dependency or privileged relocation.

**Actual scope:** owner B is RECEIVED; all six numbered findings and six low notes have explicit [dispositions](../evidence/vault-owner-findings-b-2026-11-03/b-mapping.md), with source repairs independently reviewed. Low per-name cost remains partial and Task2 M1 is carried. Original owner reviewer read from Windows and explicitly did not execute tests. Our synthetic probes and CI are our evidence, never attributed to that reviewer.

**Global C1 is NOT met across running Nova.** C1 remains a full Phase1 acceptance requirement. P1a connects supervisor/private token IPC, guarded reset/key removal, exclusions, metadata diagnostics and fixed seal module only. Core still opens legacy credentials and the app still has plaintext forms. P1b actual consumer switch, migration boot barrier, Work Ledger/audit wiring, browser relay/WebSocket/SSE/OAuth/holder transport and P1c full gate are queued. No Phase1 completion, credentialed M10j/M10k, app-surface promotion, physical keychain or universal OS containment is claimed. Health285 rendered-entry recognition is pending; C18/C19 backend active/app Not shipped and the51row282 crawl/historical70 gaps remain unchanged.

S4 pre-migration checkpoint copies and S6 already-received holder material remain stated limits, as the takeover brief permits; they have not been retroactively erased/revoked. The old1f9977c6 packet remains in Git history, not represented as current source.

Review requirements: read the complete broker plus integration; design fresh live synthetic adversarial probes against public/runtime surfaces, not just existing tests. Root owns the separate Task7 scoped review, fresh final most-capable whole-code/live-probe gate, ordinary exact-head full CI, matched merge and preview. These gates remain pending. No missing-B owner question remains.

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
- **The broker** (`main.ts`): started by Nova's supervisor, never by core. It runs under Node's permission model, with reads limited to its code and its folder and writes to its folder. It has a finite trusted OS/keychain context (or explicit file mode), no inspector, and `--disable-sigusr1`. It listens only on the local socket/named pipe; real Windows behavior remains unproven.
- **The launcher** (`launch.ts`): broker code that the broker itself starts as a child, one per job, with its request on a pipe (file descriptor 3). It never touches the socket. It has three jobs:
  - start a program with a credential in its environment or in a 0600 file, scrubbing the program's output;
  - read the old vault in the broker's own home and hand it over (migrate);
  - take what moved out of the old vault (finish).

  Node carries the broker's permission model into the launcher, and each job adds exactly what it needs. The program runs through `env -u NODE_OPTIONS`, so it runs as itself.
- **Core in the isolated broker harness:** holds only `BrokerClient`. Actual Core also retains the legacy Vault and credential consumers until P1b. A `process` use answers with the program's exit code and its scrubbed output.

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

**Owner findings A follow-up (2026-11-01):** SEC-01..05 were reproduced before fixes; the final owner suite passes 20/20. SEC-06's authenticated-verification exception and limits are explicit below; SEC-07 requested no change. The input is preserved verbatim in `docs/builder-packet/nova-vault-second-model-findings-2026-11-01-a.md`; commands, failures and migration limits are in `docs/reviews/vault-owner-findings-notes-2026-11-01.md`. The complete source below is regenerated from accepted44a8. The historical interrupted review was subsequently completed; the takeover live review fixed proposal/rekey/card findings. Owner B is received and its source repairs are independently reviewed. A fresh final whole-branch review with new live adversarial probes is still required; regression tests do not replace it.

## 2. The claims the code must uphold

C1 is the unchanged full Phase1 acceptance requirement. **The running app does not yet meet C1:** Core and plaintext forms/legacy consumers still handle credentials until actual P1b. The claims below are target requirements; current broker-only evidence cannot establish the whole-product claim. Nova must not advertise C1 as achieved.

- **C1.** Within Nova, the capability to read a credential's value exists only inside the broker: the broker process, and the launcher the broker itself starts for a program it hands a credential to, or to read the old vault. (Phase 1 runs as the person's own OS account; see the threat model.)
- **C2.** A value leaves the broker only toward the bound target it is used on: a request to the bound origin, or a program's environment or file at spawn. No answer to core or the supervisor carries a value, a part of one, its length, any encoding of one, or a hash or HMAC of one.
  - No answer depends on whether text core sent equals a held value, except for two explicit, rate-capped oracles: a target that echoes core's text back, scrubbed (limit 2), and authenticated local HMAC verification (SEC-06 below). Neither exception permits returning the HMAC itself.
  - **SEC-06, authenticated verification:** the bound `verify` mode intentionally returns one boolean for the supplied body/signature pair and the held key, without making a target connection. This is a local guess oracle for an authenticated core caller. It needs standing consent for a standard credential or a tier-2 task approval; sensitive credentials ask first (registered passkey required where available), and `per_use` always asks. The task grant covers further body/signature pairs, not just one pair, for five minutes after approval without reuse renewal. The standing-consent cap defaults to 600/hour (configurable 1–3,600), and all verification/use calls share a hard 3,600/hour per-ref cap. Approval flood control permits three pending per task, 30/hour; approvals expire after five minutes and are single-use. Rate caps do not make a low-entropy signing key safe. The binding design includes n8n verification, so this documented exception preserves that operation. No signature or key is returned.
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
  - Stage and finish cooperate with the updated legacy writer through an exclusive mutation lock. Ordinary committed legacy reads do not acquire it; exceptional authenticated rekey recovery/promotion still serialize. Finish retains old entries if the staged snapshot changed; a cached writer refreshes under the same lock. Era 2 Gmail writers and older binaries require quiescence (limit 14).
  - A name already held is decided by metadata, never by comparing values. Authenticated source-write nonces and non-content Gmail identity metadata form private v2 epochs; even a same-value legitimate write is newer. True crash resume restores the captured encrypted snapshot. Uncertain source inspection refuses; Gmail writers must be quiescent.
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
- **Programs:** `use` on a `process` target makes the broker start its launcher with the value, the bound path and SHA-256, and the argv, working folder, stdin, time limit and allow-listed environment (all normalized into a tier-2 approval's digest). It uses an allow-list of environment variables (no loader, interpreter or config paths). The launcher hashes the binary and refuses a mismatch.
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
12. **What an approval covers:** a tier-2 approval covers one request's method and path, including query, for one task for five minutes without renewal on reuse. Query is shown only by metadata/fingerprint. Caller-supplied headers/body are not bound and remain validated/size-limited; a standing consent covers its scope's methods and path prefixes. Tier2 process approval binds normalized argv/cwd/allow-listed env/stdin/timeout and shows safe input metadata/fingerprints. Standing process consent expressly permits any such caller inputs. No stored credential fingerprint is exposed.
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


Additional current limits: POSIX program cleanup is the owned-group signal/probe, launcher-close and owned-directory-removal contract. An intentionally detached process, copied credential or already received holder material is not retractable. Windows credentialed process use refuses before injection. A failed or unknown cleanup retains evidence and blocks admission. Generation settings are validated, shown and digested; their public policy length is not an existing secret's length. Legacy per-name cost is only partially addressed: no read-lock mkdir/rmdir, but N+1 encrypted reads/parses and 2(N+1) keychain probes remain (Task2 M1). No physical keychain benchmark was run. Node child-permission SecurityWarnings and browser type-erasure ExperimentalWarnings remain visible in historical/current raw proof.

## 7. Evidence and review provenance

Historical first adversarial fixes (ticket/oracle/echo/hub/health, S1–S3/S5), owner A SEC01–07, and the takeover live fixes (proposal revocation/rollback, authenticated interrupted rekey, complete effective-binding cards) remain required and are exercised in the current impacted broker run. A SEC06 authenticated-verification oracle is explicit, rate-capped and returns no HMAC; SEC07 requested no change. Historical evidence: `docs/reviews/vault-owner-findings-notes-2026-11-01.md`, `docs/reviews/vault-independent-live-review-2026-11-01.md`; all earlier raw records remain in Git.

Owner B Tasks1–5 reports/reviews and250 prior public artifacts/796493 bytes are preserved unchanged. [Evidence index](../evidence/vault-owner-findings-b-2026-11-03.md), [all12 B dispositions](../evidence/vault-owner-findings-b-2026-11-03/b-mapping.md), [Task6 complete report](../evidence/vault-owner-findings-b-2026-11-03/task-6-report.md), [initial review](../evidence/vault-owner-findings-b-2026-11-03/task-6-review.md), [scoped I1/I2 closure](../evidence/vault-owner-findings-b-2026-11-03/task-6-fix-1-review.md). Task6 I1 rollback admission and I2 in-flight start/reset/stop lifetime were reproduced/fixed test-first; scoped review approved0new Critical/Important/Minor. Historical119 belongs2827; current Task6 focused77/final9/compiler60 belong amended source via exact hashes, not a fictitious already-created commit identity. Failures52/54/55/56 and compiler59 remain visible, as do original failures/owned terminations13/29/41.

[Current gate table](../evidence/vault-broker-p1-gate.md) separates conditional P1a proofs from unmet P1b/P1c obligations. [Root rulings22–29](../evidence/vault-owner-findings-b-2026-11-03/rulings-22-27.md) preserve decisions, reasons and costs. [Task7 report](../evidence/vault-owner-findings-b-2026-11-03/task-7-report.md) records current commands/outcomes, isolation and source equality. Tests prove synthetic module boundaries, not live-app C1 or physical platforms.

## 8. Complete accepted source

Each file below is reproduced verbatim, without excerpt elision. The separate machine-readable [source manifest](../evidence/vault-owner-findings-b-2026-11-03/source-manifest-44a8.json) records the same immutable file identities. Integration files are outside the unchanged broker boundary budget; privileged broker code has not moved there.

### `src/broker/audit.ts`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `d43424094acdc559aa80a4516eddcd3acb89c29f`, SHA256 `e5d79161a8995d7f11212884cf05745e3180230ace575bf02ee1d7838f7dd8ed`, 52 physical lines (53 under boundary count).

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

### `src/broker/broker.ts`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `1bd956cbb08dc014a967c0719f3d5c76023280a8`, SHA256 `d832a62429100f15295940ce4515d5ce8903d5b183d9f106f154fe037d1ca14c`, 902 physical lines (903 under boundary count).

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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Audit, type Entry } from './audit.ts';
import { entryKey, openEnvelope, type Envelope, type Kdf } from './crypto.ts';
import { send, EgressError, type Resolver } from './http.ts';
import { chooseStore, FILE_NOTICE, internalEnv, type KeyStore } from './keystore.ts';
import { BUILT, canonicalTarget, checkScope, inScope, lookalikes, requestPath, suggestClass } from './origin.ts';
import { Approvals, Rates, digestOf, generate, generationPolicy, policyCard, DEFAULT_POLICY, APPROVAL_MS, USES_PER_REF_HOUR, type ApprovalIn } from './policy.ts';
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
const PROCESS_CONSENT = 'Standing consent covers any caller-provided argv, cwd, allow-listed env, stdin and timeout within broker limits for this bound program.';
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
  #staged: { vaultId: string | null; revision: string; items: Map<string, Buffer>; epochs: Map<string, string> } | null = null;
  #running = 0;
  #programs = new Map<string, { stop: () => void; done: Promise<void> }>();
  #stopping = false;
  #programFailure = false;
  #grants = new Map<string, number>();
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
    if (this.store.unlocked) this.#reindex();
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
      device_key_fingerprint: createHash('sha256').update(Buffer.from(dev.public, 'base64')).digest('hex'),
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
    // Bind the normalized request, but expose only safe caller-input metadata on the card.
    // The audit retains the bare path/RUN; no raw query, environment or stdin goes into it.
    const action = { verb: 'use', ref: id, target: b.target, scope_item: ctx.rec.scope_item, class: m.class, version: which,
      ...(run ? { program: { argv, ...run } } : { path }) };
    const grant = `${id}|${this.#digest(action, ctx)}`;
    const now = this.#now().getTime();
    for (const [g, expires] of this.#grants) if (expires <= now) this.#grants.delete(g);
    const flags = run ? [
      callerInput('cwd', run.cwd ?? null), callerInput('env', run.env), callerInput('stdin', run.stdin),
      `Caller timeout_ms: ${run.timeout}.`,
    ] : method === 'VERIFY' ? ['Verification covers caller-provided body/signature pairs; no network request.']
      : [`Request: ${method} ${bare}.`, callerInput('query', path.includes('?') ? path.slice(path.indexOf('?') + 1) : ''), 'Headers and body are not bound by this approval.'];
    const coverage = run ? 'this exact program request' : method === 'VERIFY' ? 'verification of caller-provided body/signature pairs' : 'this method and path including query';
    const standing = m.class === 'standard' && !m.per_use && !!b.consent && (method === 'RUN' || method === 'VERIFY' || inScope(b.consent.scope, method, bare));
    if (standing) {
      ctx.rec.tier = 1;
      ctx.rec.approval_id = b.consent!.approval_id;
      if (!this.#rates.take(`c|${key}`, b.consent!.rate_per_hour)) throw new Refused('rate');
    } else if (m.per_use || !this.#grants.has(grant)) {
      this.#approve(ctx, action, {
        verb: 'use', what: `Use your ${m.kind === 'login' ? 'sign-in' : 'credential'} “${m.name}” for ${b.target}`, name: m.name, origin: m.origin, username: m.username, target: b.target,
        scope: b.scope, class: m.class, tier: 2, flags, approving: `Allows ${coverage}${m.per_use ? ' for this one use.' : ' for this task for five minutes after approval; reuse does not extend it.'}${b.kind === 'http' && method !== 'VERIFY' ? ' Headers and body are not bound.' : ''}`, ...(argv ? { argv: argv as string[] } : {}),
      }, m.class === 'sensitive');
      if (!m.per_use) this.#grants.set(grant, now + APPROVAL_MS);
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
    if (process.platform === 'win32') throw new Failed('Credentialed programs require owned POSIX process groups on this platform.');
    if (this.#stopping || this.#programFailure) throw new Failed('Credentialed programs are stopped or need operator recovery.');
    if (this.#running >= 4) throw new Refused('rate', 'Four programs are running with credentials already.');
    const root = join(this.store.dir, 'run');
    const run = join(root, 'programs');
    mkdirSync(run, { recursive: true, mode: 0o700 });
    // Only this instance's live entries are ours. Never signal PIDs recovered from disk.
    if (readdirSync(root).some((name) => name !== 'broker.sock' && name !== 'programs')) throw new Failed('A previous program run needs operator recovery.');
    if (readdirSync(run).some((name) => !this.#programs.has(join(run, name)))) throw new Failed('A previous program run needs operator recovery.');
    const [path, sha256] = b.target.split('#sha256:') as [string, string];
    const value = this.store.value(id, which);
    let home: string;
    try { home = mkdtempSync(join(run, 'nova-run-')); } catch (e) { zero(value); throw e; }
    this.#running++;
    let stopped!: () => void;
    let finish!: () => void;
    let failCleanup!: (e: Error) => void;
    const done = new Promise<void>((ok, fail) => { finish = ok; failCleanup = fail; });
    // A rejected cleanup remains owned and blocks reuse, even before a supervisor awaits it.
    done.catch(() => {});
    this.#programs.set(home, { stop: () => stopped(), done });
    const answer = new Promise<Answer>((ok, fail) => {
      const take = (s: NodeJS.ReadableStream) => { const c: Buffer[] = []; let n = 0; s.on('data', (x: Buffer) => { if (n < MAX_OUTPUT) c.push(x.subarray(0, MAX_OUTPUT - n)); n += x.length; }); return () => ({ text: Buffer.concat(c).toString('utf8'), cut: n > MAX_OUTPUT }); };
      let child: ReturnType<typeof spawn> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      let signalFailed = false;
      const signal = (sig: NodeJS.Signals) => {
        if (!child?.pid) return;
        try { process.kill(-child.pid, sig); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') { signalFailed = true; this.#programFailure = true; } }
      };
      const settle = (code: number, out = { text: '', cut: false }, err = { text: '', cut: false }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(escalation);
        // close alone is not ownership release: descendants may have closed their pipes.
        signal('SIGKILL');
        try {
          if (signalFailed) throw new Error('Owned program cleanup could not be confirmed.');
          rmSync(home, { recursive: true, force: true });
          this.#programs.delete(home);
          this.#running--;
          finish();
          ok({ exit: code, stdout: out.text, stderr: err.text, truncated: out.cut || err.cut });
        } catch {
          this.#programFailure = true;
          const e = new Failed('Owned program cleanup could not be confirmed; operator recovery is required.');
          failCleanup(e); fail(e);
        }
      };
      stopped = () => {
        if (settled || escalation) return;
        clearTimeout(timer);
        signal('SIGTERM');
        escalation = setTimeout(() => {
          signal('SIGKILL');
          if (signalFailed && !settled) {
            settled = true; // No cleanup or lane release: the group remains ambiguous.
            const e = new Failed('Owned program cleanup could not be confirmed; operator recovery is required.');
            failCleanup(e); fail(e);
          }
        }, 5000);
      };
      try {
        child = spawn(process.execPath, [...grantsIf([`--allow-fs-read=${path}`, `--allow-fs-write=${home}/`]), '--disable-sigusr1', '--disable-warning=ExperimentalWarning', '--disable-warning=SecurityWarning', LAUNCH, 'run'], { detached: true, env: { TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
        const out = take(child.stdout!);
        const err = take(child.stderr!);
        child.once('error', () => { /* close follows even when spawn fails; release only there */ });
        child.once('exit', () => stopped());
        child.once('close', (code, sig) => settle(code ?? (sig ? 128 : 127), out(), err()));
        timer = setTimeout(stopped, r.timeout);
        child.stdio[3]!.on('error', () => { /* the launcher stopped before reading it */ });
        (child.stdio[3] as NodeJS.WritableStream).end(JSON.stringify({ path, sha256, argv, cwd: r.cwd, env: r.env, stdin: r.stdin, inject: b.inject, home, value: value.toString('utf8') }));
      } catch { if (child?.pid) stopped(); else settle(127); }
      finally { zero(value); }
    });
    return answer;
  }

  // Private broker lifecycle surface, never a socket verb. Shutdown waits for owned cleanup.
  async stopPrograms(): Promise<void> {
    this.#stopping = true;
    const programs = [...this.#programs.values()];
    for (const p of programs) p.stop();
    const results = await Promise.allSettled(programs.map((p) => p.done));
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
    if (this.#programFailure) throw new Failed('Owned program cleanup needs operator recovery.');
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
    let policy: Meta['policy'];
    try { policy = generationPolicy(mi.policy); } catch (e) { throw new Failed((e as Error).message); }
    const bindings = Array.isArray(f.bind) ? f.bind.slice(0, 20).map((x) => this.#binding(x)) : [];
    if (cls === 'sensitive' && bindings.some((b) => b.consent)) throw new Refused('class_policy', CONSENT_SENSITIVE);
    const kind = src === 'generate' ? 'generate' : src === 'sealed' || (src && typeof src === 'object' && 'sealed' in src) ? 'sealed' : null;
    if (!kind) throw new Failed('A value comes from generate or sealed entry (or migrate).');
    const meta: Meta = { name: mi.name, aliases: [alias], kind: mi.kind, origin, username: str(mi.username, 300) ? mi.username : null, class: cls, per_use: mi.per_use === true, created_at: this.#now().toISOString(), last_used: null, last_rotated: null, bindings, policy };
    const action = { verb: 'create', name: meta.name, kind: meta.kind, origin, username: meta.username, class: cls, per_use: meta.per_use, bindings: bindings.map(cardBinding), source: kind, policy };
    const flags = [policyCard(policy), ...bindings.flatMap((b) => this.#flags(b.target, b.kind))];
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
    const action = { verb: 'update', ref: id, value: kind, ...(kind === 'generate' ? { policy: m.policy } : {}) };
    const { passkey } = this.#approve(ctx, action, { verb: 'update', what: kind === 'generate' ? `Make a new value for “${m.name}”` : `Replace the value of “${m.name}”`, name: m.name, origin: m.origin, username: m.username, class: m.class, tier: 3, flags: kind === 'generate' ? [policyCard(m.policy)] : [], approving: 'Replaces the value inside the broker. The site itself isn’t changed by this.' }, true, this.#envelopeHash(c.value));
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
    this.#approve(ctx, { verb: 'rotate', ref: id, phase: f.phase, ...(f.phase === 'begin' ? { policy: m.policy } : {}) }, { verb: 'rotate', what: f.phase === 'begin' ? `Make a new password for “${m.name}”, kept aside until the site takes it` : `Keep the new password for “${m.name}”`, name: m.name, origin: m.origin, username: m.username, class: m.class, tier: 3, flags: f.phase === 'begin' ? [policyCard(m.policy)] : [], approving: f.phase === 'begin' ? 'Generates it inside the broker. Typing it into the site’s change form is a separate, visible step.' : 'The new value replaces the old one.' }, true);
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
      approving: `${b.consent ? `${b.kind === 'process' ? PROCESS_CONSENT : `Standing consent: requests inside ${b.consent.scope.methods.join(', ')} ${b.consent.scope.paths.join(', ')} go ahead without asking.`} Up to ${b.consent.rate_per_hour} an hour. ` : 'Every use asks first. '}Nothing else is covered: no other host, subdomain or port.`,
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
  #forgetGrants(id: string): void { for (const g of this.#grants.keys()) if (g.startsWith(`${id}|`)) this.#grants.delete(g); }

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
    const fp = createHash('sha256').update(Buffer.from(d.public_key, 'base64')).digest('hex');
    const text = `The broker on “${d.name}” will be able to open every item in this vault (${this.#index.size} now, and every one added later). Nova core and its models are given no values. Check this device-key fingerprint matches the one the holder shows: ${fp}.`;
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
  //    name already taken by an item migrated from the same source write counts as moved (a
  //    resumed run); a name taken by any other item stays in the old vault. Neither compares values. Then
  //    the launcher takes what moved out of the old vault.
  //  - propose (tier 3): one card of bindings and classes, metadata only.
  async #migrate(src: { migrate: unknown; proposals?: unknown }, ctx: Ctx): Promise<Answer> {
    if (src.migrate === 'propose') return this.#propose(src.proposals, ctx);
    const home = dirname(this.store.dir);
    if (src.migrate === 'stage') {
      // A failed restage must not leave the earlier plaintext or approval scope usable.
      for (const b of this.#staged?.items.values() ?? []) zero(b);
      this.#staged = null;
      const out = await this.#launch(['migrate', home], null);
      const items = new Map<string, Buffer>();
      const epochs = new Map<string, string>();
      let vaultId: string | null = null;
      let revision = '';
      for (const line of out.split('\n')) {
        if (!line) continue;
        let x: { vault_id?: unknown; revision?: unknown; name?: unknown; value?: unknown; epoch?: unknown };
        try { x = JSON.parse(line); } catch { continue; }
        if ('vault_id' in x) { vaultId = typeof x.vault_id === 'string' ? x.vault_id : null; revision = typeof x.revision === 'string' ? x.revision : ''; continue; }
        if (items.size < MAX_STAGED && str(x.name, 200) && NAME.test(x.name) && typeof x.value === 'string' && x.value.length > 0 && x.value.length <= 64 * 1024 && str(x.epoch, 400)) {
          items.set(x.name, Buffer.from(x.value, 'utf8'));
          epochs.set(x.name, x.epoch);
        }
      }
      if (!/^v2:[0-9a-f]{64}$/.test(revision)) {
        for (const b of items.values()) zero(b);
        throw new Failed('The old vault snapshot is incomplete; nothing was staged.');
      }
      this.#staged = { vaultId, revision, items, epochs };
      return { outcome: { staged: items.size } };
    }
    if (src.migrate !== 'commit') throw new Failed('A migration stages, commits, then proposes bindings.');
    const st = this.#staged;
    if (!st) throw new Failed('Nothing is staged.');
    const from = st.vaultId ?? 'era2';
    const plan = [...groupStaged(st.items)].map(([name, g]) => {
      const owner = [...this.#index.values()].find((x) => x.aliases.includes(`${ALIAS}${name}`));
      const sources = g.names.map((n) => [n, st.epochs.get(n)]);
      const revision = `v2:${createHash('sha256').update(canonical(sources)).digest('hex')}`;
      return { name, g, revision, status: !owner ? 'move' : owner.provenance === 'migrated' && owner.migrated_from === from && owner.migrated_revision === revision ? 'moved' : 'kept' };
    });
    this.#approve(ctx, { verb: 'create', source: 'migrate', snapshot: st.revision, items: plan.map((x) => ({ name: x.name, kind: x.g.kind, status: x.status })) }, { verb: 'create', what: `Move ${plan.filter((x) => x.status === 'move').length} credential(s) from the old vault into Nova Vault`, tier: 3, flags: [`Source snapshot: ${st.revision}`], items: plan.map((x) => ({ name: x.name, kind: x.g.kind, origin: x.g.origin, status: x.status })), approving: 'Each is moved inside the broker, unbound (usable nowhere until you bind it), read back, and only then removed from the old vault. A name already taken by another credential stays in the old vault. Gmail writers must remain stopped until cleanup finishes.' }, true);
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
      const child = spawn(process.execPath, [...grants, '--disable-sigusr1', '--disable-warning=ExperimentalWarning', LAUNCH, ...args], { env: { ...internalEnv(process.env, this.#o.keyMode !== 'file'), ...(this.#o.keyMode ? { NOVA_VAULT_KEY: this.#o.keyMode } : {}) }, stdio: ['ignore', 'pipe', 'ignore', 'pipe'] });
      child.stdio[3]!.on('error', () => { /* the launcher stopped before reading it */ });
      (child.stdio[3] as NodeJS.WritableStream).end(input ?? '');
      const chunks: Buffer[] = [];
      let n = 0;
      child.stdout!.on('data', (x: Buffer) => { n += x.length; if (n <= 80 * 1024 * 1024) chunks.push(x); });
      child.on('close', (code) => (code === 0 ? ok(Buffer.concat(chunks).toString('utf8')) : fail(new Failed(args[0] === 'finish'
        ? 'Migration cleanup could not finish. Copies and removals may already exist; review the vaults and resume migration.'
        : 'The old vault couldn’t be read; nothing was staged.'))));
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
const cardBinding = (b: Binding) => ({ target: b.target, kind: b.kind, scope: b.scope, inject: b.inject, consent: b.consent ? { scope: b.consent.scope, rate_per_hour: b.consent.rate_per_hour } : null, lan: !!b.lan, pin: b.pin ?? null, embed_on: b.embed_on ?? [], ...(b.kind === 'process' && b.consent ? { approving: PROCESS_CONSENT } : {}) });

// These identities describe caller inputs only, never the broker's held credential.
function callerInput(field: string, input: unknown): string {
  const bytes = Buffer.byteLength(typeof input === 'string' ? input : canonical(input));
  return `Caller ${field}: ${bytes} UTF-8 bytes; sha256:${digestOf({ field, input })}.`;
}

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

### `src/broker/crypto.ts`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `ee38822d97853097a6839bf5585d1c7eaef905eb`, SHA256 `8456ad760582c3856b99f294dd5ef85d3ad6954978887d9fece1d18903250b89`, 132 physical lines (133 under boundary count).

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

### `src/broker/http.ts`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `f0c939256357fe1483365dfe806a58884ed748e5`, SHA256 `10c290adcd9cd033e53b1ce1733dc52056d8b1839ab09028e6341be3a7a0705b`, 93 physical lines (94 under boundary count).

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

### `src/broker/keystore.ts`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `2704ae681d213b3740b59df11d78d9b32aed453f`, SHA256 `5d0366ed23a0cd85b49e0693995ad2026e2c20eb457a4b0df3d9757e2ea1c64b`, 140 physical lines (141 under boundary count).

```ts
// Where the broker's device unlock key lives (§10 "Unlock"): the OS key store when one answers,
// else a 0600 file in the broker's folder, with the plain notice. The CLIs are vault.ts's, ported
// (src/broker imports nothing from src/core): secret-tool on Linux, security on macOS, the
// Credential Locker through PowerShell on Windows (untested on real Windows). Values never go on a
// command line. The migrate launcher also reads the old vault's key through these (service
// nova-vault, account vault-<id>).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Trusted internal OS context only; never use this for a credentialed target's environment.
export function internalEnv(env: NodeJS.ProcessEnv, keychain = true): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { TZ: 'UTC' };
  if (keychain) for (const name of ['HOME', 'PATH', 'DBUS_SESSION_BUS_ADDRESS', ...(process.platform === 'win32' ? ['SystemRoot', 'USERPROFILE', 'LOCALAPPDATA'] : [])]) {
    if (env[name]) out[name] = env[name];
  }
  return out;
}

export interface CommandResult { code: number | null; stdout: string; stderr: string; error: string | null }
export type Run = (cmd: string, args: string[], input?: string) => CommandResult;
export const runCommand: Run = (cmd, args, input) => {
  // env(1) also removes permission flags Node automatically adds to its children.
  const posix = process.platform !== 'win32';
  const r = spawnSync(posix ? '/usr/bin/env' : cmd, posix ? ['-u', 'NODE_OPTIONS', '--', cmd, ...args] : args, { env: internalEnv(process.env), input: input ?? '', encoding: 'utf8', timeout: 10_000, shell: false, windowsHide: true });
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
      remove: () => { const r = run('security', ['delete-generic-password', '-s', service, '-a', account]); if (r.code !== 0 && r.code !== 44) throw fail('security', r); },
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
      remove: () => { const r = ps(`try { foreach ($c in $v.RetrieveAll()) { if ($c.Resource -ceq '${service}' -and $c.UserName -ceq '${account}') { $v.Remove($c) } } } catch { exit 1 }`); if (r.code !== 0) throw fail('PowerShell', r); },
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
    remove: () => { const r = run('secret-tool', ['clear', ...attrs]); if (r.code !== 0 && !(r.code === 1 && !r.stderr.trim())) throw fail('secret-tool', r); },
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

// Trusted parent-only reset: fixed broker directory, no key reads and no caller-supplied accounts.
// Keep device.json until the authenticated home reset completes, so interruption is retryable.
export function removeDeviceKeys(dir: string, store: (account: string) => KeyStore): void {
  if (!lstatSync(dir).isDirectory()) throw new Error('The broker directory is not owned storage.');
  for (const [part, allowed] of [['run', ['broker.sock', 'programs']], ['run/programs', []]] as const) {
    const p = join(dir, part);
    if (existsSync(p) && (!lstatSync(p).isDirectory() || readdirSync(p).some((n) => !(allowed as readonly string[]).includes(n)))) throw new Error('Owned program cleanup needs operator recovery.');
  }
  const file = join(dir, 'device.json');
  if (!existsSync(file)) {
    if (readdirSync(dir).some((name) => name !== 'run')) throw new Error('Missing broker device record; operator recovery is required.');
    return;
  }
  if (!lstatSync(file).isFile()) throw new Error('Invalid broker device record.');
  const d = JSON.parse(readFileSync(file, 'utf8')) as { id?: unknown };
  if (typeof d.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(d.id)) throw new Error('Invalid broker device record.');
  for (const prefix of ['device', 'sign']) store(`${prefix}-${d.id}`).remove();
}
```

### `src/broker/launch.ts`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `ca249eb35a2c683531c86780f7c8691bd678389f`, SHA256 `63bfce9363443f685877e86a18c4cb5ebae6ded622d7ecbe43913db46f9d64c0`, 106 physical lines (107 under boundary count).

```ts
// The broker's launcher (§3 "The launcher", §10 "Moving from today's vault"). Broker code that the
// broker itself starts as its own child, outside Node's permission model, for the two jobs the
// broker's narrowed process can't do: run a program with a credential, and read the old vault in
// the home. It talks to the broker over its pipes only: never the socket, never a ticket. Core
// never starts it and never holds anything that would let another process act as it.
//
//   launch.ts run              fd 3: { path, sha256, argv, cwd, env, inject, home, value, stdin }
//     Hashes the program itself and refuses one that isn't the bound binary, then starts it with
//     the value in its environment, or in a 0600 file in a 0700 folder named by that variable and
//     removed by the broker after owned group cleanup. It scrubs stdout and stderr of the value (and its encodings), passes on
//     signals, and exits with the program's code.
//   launch.ts migrate <home>   stdout: { vault_id, revision }, then { name, value, epoch } privately
//     Reads vault.ts's file and key and Era 2's Gmail files. Nova's own keys aren't sent.
//   launch.ts finish <home>    fd 3: { vault_id, revision, names }
//     Takes the names that moved out of the old vault (a new key, or no file and no key) and removes
//     Era 2's files for them; prints counts only.
//
// Stated limits: a program is hashed, then started by path, so a binary swapped between the two
// would run with the credential; and a program can do what it likes with its own credential,
// including what its arguments, working folder and project files (core's) steer it to.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
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
  // The broker owns this directory until group cleanup, including after launcher death.
  const home = g.home as string;
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
  child.on('error', () => fail('couldn’t start the program', 127));
  child.on('close', (code, signal) => {
    process.stdout.write(out.end());
    process.stderr.write(err.end());
    process.exitCode = code ?? (signal ? 128 + (({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9 } as Record<string, number>)[signal] ?? 1) : 1);
  });
}

function migrate(home: string) {
  return withOldVaultLock(home, () => {
    const { old, gmail, revision } = migrationSnapshot(home);
    const items = new Map<string, string>(gmail.items);
    const epochs = new Map(gmail.epochs);
    for (const [k, v] of old?.map ?? []) { items.set(k, v); epochs.set(k, old!.epoch); }
    line({ vault_id: old?.id ?? null, revision });
    for (const [name, value] of items) if (!OWN_KEYS.some((r) => r.test(name))) line({ name, value, epoch: epochs.get(name) });
    old?.key.fill(0);
  });
}

async function finish(home: string) {
  const f = await fromParent();
  withOldVaultLock(home, () => {
    const names = Array.isArray(f.names) ? (f.names as unknown[]).filter((n): n is string => typeof n === 'string') : [];
    const { old, revision } = migrationSnapshot(home);
    try {
      // A newer write was never read back, even if its value matches. Never compare plaintext.
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

### `src/broker/main.ts`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `5aa9489b61a12b68c7d06e39a44b8bd3996744f6`, SHA256 `44d75efd8787811df277aef616793b6400b2241ec533b8b51cc5014430f54f8f`, 49 physical lines (50 under boundary count).

```ts
// The broker process (§3). Started by the supervisor, as its own child and never core's, with
// spawn.ts's hardening: an empty environment, Node's permission model narrowed to the broker's
// folder, no inspector, --disable-sigusr1. Its two tokens arrive over Node's IPC channel, never on
// argv or in the environment.
//   node src/broker/main.ts <broker folder>
import { fileStores, keychainStore, removeDeviceKeys } from './keystore.ts';
import { Broker } from './broker.ts';
import { serve, socketPath, type Tokens } from './server.ts';

const dir = process.argv[2];
if (!dir || !process.send) {
  process.stderr.write('The broker is started by the supervisor (src/broker/spawn.ts), with its folder and an IPC channel.\n');
  process.exit(2);
}

process.once('message', async (msg: { tokens?: Tokens; key_mode?: 'auto' | 'file' | 'keychain'; reset?: boolean }) => {
  try {
    if (msg.reset === true) {
      removeDeviceKeys(dir, (account) => {
        if (msg.key_mode === 'file') return fileStores(dir)(account);
        const store = keychainStore('nova-broker', account);
        if (!store || !store.available().ok) throw new Error('Broker keychain cleanup is unavailable.');
        return store;
      });
      process.send!({ ready: true });
      process.exit(0);
    }
    const broker = new Broker({ dir, ...(msg.key_mode ? { keyMode: msg.key_mode } : {}) });
    broker.start();
    const path = socketPath(dir);
    const server = await serve(broker, path, msg.tokens!);
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      broker.lock(); server.close();
      try { await broker.stopPrograms(); process.exit(0); }
      catch { process.stderr.write('Owned program cleanup needs operator recovery.\n'); process.exit(1); }
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    process.on('disconnect', stop);
    process.send!({ ready: true, socket: path, locked: !broker.store.unlocked });
    process.channel?.unref();
  } catch (e) {
    process.send!({ ready: false, problem: (e as Error).message });
    process.exit(1);
  }
});
```

### `src/broker/oldvault.ts`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `1f48ba6350835be85b7fbd634c33f49415ecfeb9`, SHA256 `b76bff5c36df5f79a69e7ac6b4445c88e93e1de76da3df33e32f2b7cd16c7519`, 171 physical lines (172 under boundary count).

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
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

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

export interface OldVault { id: string; epoch: string; map: Map<string, string>; key: Buffer; store: KeyStore }

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
    for (const s of keyMode(env) === 'keychain' ? [kc] : [kc, disk]) {
      let key: Buffer | null = null;
      try { key = s.read(); } catch { key = null; }
      if (!key || fp(key) !== f.fp) continue;
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(f.nonce, 'base64'));
      d.setAAD(AAD(f.id));
      d.setAuthTag(Buffer.from(f.tag, 'base64'));
      let map: Map<string, string>;
      try { map = new Map(Object.entries(JSON.parse(Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()]).toString('utf8')) as Record<string, string>)); } catch { throw new Error('The old vault doesn’t open with its key.'); }
      // Only expose an epoch after authentication. Core's writer draws a fresh 12-byte nonce
      // for EVERY save, including identical values; restoring the exact ciphertext keeps it.
      const nonce = Buffer.from(f.nonce, 'base64');
      if (nonce.length !== 12) throw new Error('The old vault has no supported write epoch.');
      if (pending) { renameSync(`${file}.tmp`, file); chmodSync(file, 0o600); }
      return { id: f.id, epoch: `vault:${f.id}:${nonce.toString('hex')}`, map, key, store: s };
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
  v.epoch = `vault:${v.id}:${nonce.toString('hex')}`;
  return gone;
}

// Era 2's plaintext Gmail files (src/connectors/gmail.js), moved by the broker too.
export const GMAIL_FILES: Record<string, string> = { 'client.json': 'connector/gmail/GOOGLE_OAUTH_CLIENT', 'token.json': 'connector/gmail/GOOGLE_REFRESH_TOKEN', 'password.json': 'connector/gmail/GMAIL_APP_PASSWORD' };
// Gmail writers MUST be quiesced for migration: these file identities/change times are not an
// authenticated journal or protection against hostile same-user/root metadata manipulation.
// No size, content, or access time participates. Unknown/non-regular identities refuse staging
// and cleanup; stable regular files still migrate normally.
function gmailStat(path: string) {
  try { return lstatSync(path, { bigint: true }); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e; // Access denial and inspection failure are never proof of absence.
  }
}
function gmailEpoch(path: string): string | null | undefined {
  const s = gmailStat(path);
  if (!s) return undefined;
  return s.isFile() && s.ino > 0n && s.mtimeNs > 0n && s.ctimeNs > 0n
    ? `gmail:${s.dev}:${s.ino}:${s.mtimeNs}:${s.ctimeNs}` : null;
}
export function readGmailFiles(home: string) {
  const out = new Map<string, string>();
  const epochs = new Map<string, string>();
  // Inspect fixed ancestors first. Node grants the exact connectors root even when missing,
  // but not its descendants; an inaccessible or symlinked ancestor is not confirmed absence.
  for (const dir of [join(home, 'connectors'), join(home, 'connectors', 'gmail')]) {
    const s = gmailStat(dir);
    if (!s) return { items: out, epochs };
    if (!s.isDirectory()) throw new Error('A Gmail source directory cannot be inspected safely.');
  }
  for (const [file, name] of Object.entries(GMAIL_FILES)) {
    const p = join(home, 'connectors', 'gmail', file);
    const before = gmailEpoch(p);
    if (before === undefined) continue;
    if (before === null) throw new Error('A Gmail source has no trustworthy write epoch.');
    const text = readFileSync(p, 'utf8');
    const after = gmailEpoch(p);
    if (before !== after) throw new Error('A Gmail source changed while it was being read.');
    epochs.set(name, before);
    if (!text.trim()) continue;
    let v = text;
    try { v = JSON.stringify(JSON.parse(text)); } catch { /* kept as its text, as gmail.js does */ }
    out.set(name, v);
  }
  return { items: out, epochs };
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

// Source epochs travel only over the private launcher pipe. The v2 metadata-only digest also
// scopes the public approval card. A changed/uncertain snapshot is retained wholesale.
export function migrationSnapshot(home: string) {
  const old = readOldVault(home);
  const gmail = readGmailFiles(home);
  const revision = `v2:${createHash('sha256').update(JSON.stringify([old?.epoch ?? null, [...gmail.epochs]])).digest('hex')}`;
  return { old, gmail, revision };
}
```

### `src/broker/origin.ts`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `0f824a5c67e914d02f7b71d0a561668833d80a47`, SHA256 `f44278fbc87580e6a4e3b4a65562fb795dc7babcdd562bdd0b14d3a8cbf807c0`, 141 physical lines (142 under boundary count).

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

### `src/broker/policy.ts`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `cfc6c31b52ea65e0f984e9de8d34619897bea6f0`, SHA256 `422f8510db80d4a61c4d0664c9353f625e4b8d3cb599fb153320ae3e41f7af63`, 156 physical lines (157 under boundary count).

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
export function generationPolicy(input: unknown = DEFAULT_POLICY): { length: number; alphabet: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A generation policy names a length and alphabet.');
  const p = input as { length?: unknown; alphabet?: unknown };
  const length = p.length === undefined ? DEFAULT_POLICY.length : p.length;
  const alphabet = p.alphabet === undefined ? DEFAULT_POLICY.alphabet : p.alphabet;
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 16 || length > 128 || typeof alphabet !== 'string' || !/^[\x21-\x7e]+$/.test(alphabet) || new Set(alphabet).size < 16 || alphabet.length > 256) throw new Error('a generation policy is 16–128 characters from at least 16 distinct ones');
  return { length, alphabet };
}
export function policyCard(policy: { length: number; alphabet: string }): string {
  const { length, alphabet } = generationPolicy(policy);
  const distinct = new Set(alphabet).size;
  return `Generation policy (also for future replacements): ${length} characters; ${distinct} distinct symbols; at least ${Math.floor(length * Math.log2(distinct))} bits of entropy; alphabet ${JSON.stringify(alphabet)}.`;
}
export function generate(policy: { length: number; alphabet: string } = DEFAULT_POLICY): Buffer {
  const { length, alphabet } = generationPolicy(policy);
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

### `src/broker/protocol.ts`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `71c3933444af71e66af35d2914ec0dbed12ada94`, SHA256 `8de4ae6488cf4edda51735f805f0a41179dbbb0ba9ee6857ade88169c5467de0`, 137 physical lines (138 under boundary count).

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
  'state', 'locked', 'exists', 'vault_id', 'unlock_mode', 'approval_mode', 'factors', 'entry_key', 'boot', 'device_id', 'device_key', 'device_key_fingerprint', 'holders', 'kdf', 'alg', 'm', 't', 'p', 'safe_mode',
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

### `src/broker/scrub.ts`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `662f8a4975d5b6a8a5fdd72d2877c9419f3adc63`, SHA256 `86909951c5ab4eb759bbab161e35ac626145e95125c3075c36aceaca4b01d38e`, 65 physical lines (66 under boundary count).

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

### `src/broker/seal.ts`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `0ba56a7fcdfeeacd55ee4497f265c2db864a4492`, SHA256 `3d042207b50f8d771188318a406f62a50cb07cc62da4e04bbe87b718cddeaf43`, 40 physical lines (41 under boundary count).

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

### `src/broker/server.ts`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `b4c7f2b7e28d885a1e8c837e2fbc1653ff9c3756`, SHA256 `bcc3608f32e831453a0827cc58ce55fc0fd820b4cc56a66302b2440808b334c1`, 106 physical lines (107 under boundary count).

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

### `src/broker/spawn.ts`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `0bb3fe0e3713b13548ad49c7a269b79c94e09d6d`, SHA256 `10dd40750327b48fec944844a52fe3945eddd352492f83c97b1354f57d98faa8`, 67 physical lines (68 under boundary count).

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
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { internalEnv } from './keystore.ts';
import type { Tokens } from './server.ts';

export const BROKER_SRC = dirname(fileURLToPath(import.meta.url));

export function brokerCommand(dir: string, source = BROKER_SRC): string[] {
  return [
    '--permission', `--allow-fs-read=${source}/`, `--allow-fs-read=${dir}/`, `--allow-fs-write=${dir}/`, '--allow-net', '--allow-child-process',
    '--no-experimental-sqlite', '--no-experimental-webstorage', '--disable-sigusr1', `--diagnostic-dir=${dir}`,
    '--disable-warning=ExperimentalWarning', join(source, 'main.ts'), dir,
  ];
}

export interface Started { child: ChildProcess; socket: string; tokens: Tokens; locked: boolean; stopped: Promise<void> }

export function startBroker(dir: string, o: { keyMode?: 'auto' | 'file' | 'keychain'; env?: NodeJS.ProcessEnv; timeoutMs?: number; pipe?: boolean; source?: string; reset?: boolean } = {}): Promise<Started> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) throw new Error('The broker storage directory must not be a symlink.');
  chmodSync(dir, 0o700);
  const keychain = o.keyMode !== 'file';
  const env = o.env ?? process.env;
  // Only what the keychain CLIs need to reach a desktop session; nothing else of the parent's.
  const childEnv = internalEnv(env, keychain);
  const tokens: Tokens = { core: randomBytes(32).toString('hex'), supervisor: randomBytes(32).toString('hex') };
  const child = spawn(process.execPath, brokerCommand(dir, o.source), { cwd: dir, env: childEnv, stdio: ['ignore', o.pipe ? 'pipe' : 'inherit', o.pipe ? 'pipe' : 'inherit', 'ipc'] });
  const stopped = new Promise<void>((ok, fail) => {
    child.once('close', (code, signal) => code === 0 && signal === null ? ok() : fail(new Error('Broker owned cleanup was not confirmed; operator recovery may be needed.')));
  });
  void stopped.catch(() => {});
  const ready = new Promise<Started>((ok, fail) => {
    const timer = setTimeout(() => { child.kill(); fail(new Error('The broker didn’t start in time.')); }, o.timeoutMs ?? 20_000);
    child.once('error', () => { clearTimeout(timer); fail(new Error('The broker could not start.')); });
    child.once('exit', (code) => { clearTimeout(timer); fail(new Error(`The broker exited at start (code ${code}).`)); });
    child.once('message', (m: { ready?: boolean; socket?: string; problem?: string; locked?: boolean }) => {
      clearTimeout(timer);
      child.removeAllListeners('exit');
      if (!m.ready) return fail(new Error(`The broker couldn’t start: ${m.problem}`));
      ok({ child, socket: m.socket!, tokens, locked: !!m.locked, stopped });
    });
    child.send({ tokens, ...(o.keyMode ? { key_mode: o.keyMode } : {}), ...(o.reset ? { reset: true } : {}) });
  });
  // Failed readiness is not physical completion. Even a timed-out/failed child remains owned
  // until close; callers (including supervisor shutdown) must receive the failure only then.
  return ready.catch(async (e) => { await stopped.catch(() => {}); throw e; });
}

// No timeout is evidence of cleanup. A failed/ambiguous stop retains the owned run directories.
export async function stopBroker(b: Started): Promise<void> {
  if (b.child.exitCode === null && b.child.signalCode === null) b.child.kill('SIGTERM');
  await b.stopped;
}
```

### `src/broker/store.ts`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `d1175cfb1e3b4f5fb9766263f338e78bc0067605`, SHA256 `bb54cebdea5b0e7512ef32e048bf42dc529f348e37fd472c5166a72e03cb8e23`, 523 physical lines (524 under boundary count).

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
    try {
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
      // Adoption needs the device wrap to validate and re-seal factors, even in ask mode. That
      // temporary root must not become an unattended unlock when the hub requires a person.
      this.#root = inbox.unlock_mode === 'auto' ? root : null;
    } finally { if (this.#root !== root) zero(root); }
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

### `src/core/broker/client.ts`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `14304f74da943639031c0ab543befdff89833fd9`, SHA256 `460b24ea8b4c663a48268955acd27d6690531b3c6c86e173fd5150b8c81eda00`, 138 physical lines (139 under boundary count).

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
  #closed = false;
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
    if (this.#closed) return Promise.reject(new Error('The broker client is closed.'));
    if (this.#ready) return this.#ready;
    this.#ready = new Promise((ok, fail) => {
      const s = connect(this.socket);
      this.#sock = s;
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
      s.on('close', () => { gone(); fail(new Error('The broker connection closed.')); });
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
    if (this.#closed) throw new Error('The broker client is closed.');
    return this.#send(m, f);
  }

  close(): void { this.#closed = true; this.#token = ''; this.#sock?.destroy(); this.#sock = null; this.#ready = null; }

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

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `ddbdb75dd68a9deb843ba1abb2493eef2a2ea7f3`, SHA256 `a41d1bd690ba13b096c0dfc1d2911602e51a4d35748607aeca6aa1c24e931ec4`, 651 physical lines (652 under boundary count).

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
interface FoundKey {
  key: Buffer;
  store: KeyStore;
  housekeeping?: { disk: KeyStore; keychain: KeyStore };
}

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
  #committed: string | null = null;
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
  #withWrite<T>(run: () => T, refresh = false, unavailable?: () => T): T {
    if (this.#writing) return run();
    const lock = join(this.dir, '.writer-lock');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch {
      if (unavailable) return unavailable();
      throw new CoreError('conflict', 'The vault is busy with a writer or migration. Try again after it finishes; an interrupted lock needs operator recovery.');
    }
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
    } finally {
      // A mutator may have edited its map before a failed save. Only a fresh authenticated
      // observation of committed bytes can populate the read cache after a write attempt.
      this.#map = null;
      this.#committed = null;
      this.#writing = false;
      rmSync(lock, { recursive: true });
    }
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

  #open(): Map<string, string> {
    // Ordinary reads neither lock nor clean up pending files. Observe the committed bytes and
    // available key each time: another process may have saved, rekeyed or removed the vault.
    this.#problem = null;
    this.#unopenable = null;
    if (!existsSync(this.file)) {
      this.#committed = null;
      this.#key = null;
      this.#store = null;
      this.#map = new Map();
      return this.#map;
    }
    let file: VaultFile;
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
      file = parseFile(text);
    } catch (e) {
      this.#unopenable = 'lost';
      this.#problem = `The vault (${this.file}) is damaged and can’t be read: ${(e as Error).message}. ${START_OVER}`;
      throw new CoreError('conflict', this.#problem);
    }
    this.#id = file.id;
    let found: FoundKey;
    try {
      found = this.#findKey(file);
    } catch (e) {
      // A probe never publishes pending state. Re-open and re-authenticate under the lock before
      // finishing an interrupted rekey; a stale lock refuses this necessary repair.
      if (!this.#pendingRekey(file)) throw e;
      if (!this.#writing) return this.#withWrite(() => this.#open(), true);
      renameSync(`${this.file}.tmp`, this.file);
      return this.#open();
    }
    let map: Map<string, string>;
    try {
      if (this.#map && this.#committed === text && this.#key?.equals(found.key)) map = this.#map;
      else {
        map = decrypt(file, found.key);
        for (const v of map.values()) addSecretValue(v);
      }
    } catch (e) {
      this.#unopenable = 'lost';
      this.#problem = `${(e as Error).message} ${START_OVER}`;
      throw new CoreError('conflict', this.#problem);
    }
    this.#problem = null;
    this.#unopenable = null;
    this.#map = map;
    this.#committed = text;
    this.#key = found.key;
    this.#store = found.store;
    if (found.housekeeping) {
      // Promotion is optional for an authenticated read. If serialization is unavailable, keep
      // using the existing key; otherwise revalidate everything under the lock before changing it.
      if (!this.#writing) return this.#withWrite(() => this.#open(), true, () => map);
      this.#store = this.#promoteKey(found);
    }
    return map;
  }

  #pendingRekey(file: VaultFile): boolean {
    const tmp = `${this.file}.tmp`;
    if (!existsSync(tmp)) return false;
    let next: VaultFile;
    try { next = parseFile(readFileSync(tmp, 'utf8')); } catch { return false; }
    if (next.id !== file.id) return false;
    const why = { problem: this.#problem, unopenable: this.#unopenable };
    try {
      const found = this.#findKey(next);
      decrypt(next, found.key);
      return true;
    } catch { return false; }
    finally {
      this.#problem = why.problem;
      this.#unopenable = why.unopenable;
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

  // Probe only. Key promotion/removal waits for ciphertext authentication and the writer lock.
  #findKey(file: VaultFile): FoundKey {
    const disk = fileKeyStore(this.#home);
    const kc = this.#mode === 'file' ? null : this.#keychainFor(`vault-${file.id}`);
    const kcUp = kc ? kc.available() : null;
    const fromKc = kc && kcUp?.ok ? kc.read() : null;
    const fromDisk = disk.read();
    const fits = (k: Buffer | null) => !!k && fp(k) === file.fp;
    if (fits(fromKc)) {
      return { key: fromKc!, store: kc!, ...(fromDisk?.equals(fromKc!) ? { housekeeping: { disk, keychain: kc! } } : {}) };
    }
    if (fits(fromDisk)) {
      return { key: fromDisk!, store: disk, ...(kc && kcUp?.ok ? { housekeeping: { disk, keychain: kc } } : {}) };
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

  #promoteKey(found: FoundKey): KeyStore {
    const { disk, keychain } = found.housekeeping!;
    if (found.store.kind === 'keychain') { disk.remove(); return keychain; }
    try {
      keychain.write(found.key);
      if (keychain.read()?.equals(found.key)) { disk.remove(); return keychain; }
    } catch { /* the keychain refused: the file stays where it is */ }
    return found.store;
  }

  // With a new key (the first save, or `rekey`), the order keeps the vault openable whatever stops
  // it: the new file is written beside the old, then the key saved, then the file swapped in.
  // Stopped between the last two, opening authenticates the pending file and finishes under lock.
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

### `src/supervisor/supervisor.ts`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `e64c79abd6f0ed407726baedc77cdb7979fea41a`, SHA256 `3e63706e59936a18c052a0fa853d227cb07b271145a2de7a03eb6bc2a402c919`, 1042 physical lines (1043 under boundary count).

```ts
// The supervisor (NOVA-SPEC §7, M7 plan §2): it runs the Nova server as its child and keeps it
// running. A crash is restarted after a wait that doubles each time; three crashes within a minute
// put it in safe mode: the server is held, the reason written down (in the database as a problem
// with its playbook, in the state file, and on a small page at Nova's address), and the last good
// release offered. Health is checked on a schedule; a server that stops answering is restarted.
//
// Code releases go through it (ADR-9): a tagged release's tests, a sandbox start on a copy of the
// home, smoke probes, the switch, then a canary window on the live home that rolls back to the
// previous slot by itself when health fails. Deploying is tier 3: an explicit confirmation on the
// command line, or the API from the hub's own screen. Going back across a database upgrade
// restores the pre-upgrade backup only when nothing was written since; otherwise it refuses, says
// why, and keeps the newer release running with the problem open. It never loses data silently.
//
// The console is one service among the ones it runs (M10e, docs/plans/M10e.md): it starts from the
// console's service definition (its command, its health check and how often), and the supervisor
// driver (services.ts) runs the other services, plain programs, by the same rules. The Service
// Manager (src/core/services) moves their versions through the stages; the console's deploy path is
// this file's, unchanged.
import { createServer as createHttp, type Server as HttpServer } from 'node:http';
import { createServer as createNet, type Server as NetServer, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureMark, unsafeHome, supervisorResetPending, finishReset, homeEntries, sameServiceExpected, validServiceExpected, SERVICE_CHANGED, type ServiceExpectedState, CONSOLE, ServiceManager, consoleDefinition, consoleStatus, copyHome, dropScratch, makeScratch, restoreBackup, smoke, stagedPending, startSandbox, takeCheckpoint, type DeployStage, type ProbeLine, type ReleaseSlot, type ServiceDefinition, type SupervisorProblem, type SupervisorState } from '../core/index.ts';
import { runningPid } from '../home.js';
import { startBroker, stopBroker, type Started } from '../broker/spawn.ts';
import { ServerProcess } from './server.ts';
import { CrashWindow } from './crashes.ts';
import { SupervisorDriver } from './services.ts';
import { Slots, carryProblems, isRelease, mark, packageVersion, preMigrationBackup, problemsSince, recordProblem, sandboxable, schemaVersion, writesSince, type Mark } from './releases.ts';

// The code the supervisor was started from, when no release is current.
export const BASE = 'base';

export interface Timings {
  backoffMs: number;
  maxBackoffMs: number;
  crashes: number;
  windowMs: number;
  healthEveryMs: number;
  healthFailures: number;
  readyMs: number;
  canaryMs: number;
  probeEveryMs: number;
  testsMs: number;
  // The longest single timer a service's soak uses (tests); longer waits are chained.
  maxTimerMs?: number;
}

export const DEFAULT_TIMINGS: Timings = {
  backoffMs: 1000, maxBackoffMs: 30_000, crashes: 3, windowMs: 60_000,
  healthEveryMs: 30_000, healthFailures: 3, readyMs: 60_000,
  canaryMs: 120_000, probeEveryMs: 5000, testsMs: 30 * 60_000,
};
// A canary has a floor: at least this long, and at least two probes in it.
export const MIN_CANARY_MS = 2000;

export interface SupervisorOptions {
  dir: string;
  home: string;
  repo: string;
  base: string;
  // The server's environment. NOVA_HOME is set from `home`; the supervisor adds its own link.
  env: Record<string, string>;
  // The release's test suite, run in its slot with a scratch HOME.
  tests: string[];
  timings?: Partial<Timings>;
  echo?: (s: string) => void;
  log?: (s: string) => void;
  // The console's definition for a version (default: consoleDefinition). Tests give their own.
  consoleDefinition?: (o: { version: string; port: number }) => ServiceDefinition;
  // The ports Nova itself is configured to use (main.ts reads them from Nova's configuration), on
  // top of what the environment says: no service may take one.
  ports?: { console?: number | null; mesh?: number | null };
}

type Say = (line: string) => void;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

export class Supervisor {
  readonly o: SupervisorOptions;
  readonly t: Timings;
  readonly slots: Slots;
  readonly stateFile: string;
  state: SupervisorState;
  server: ServerProcess | null = null;
  #broker: Started | null = null;
  #brokerStopping = false;
  #brokerState: { status: 'running' | 'stopped' | 'unsupported' | 'failed'; pid: number | null } = { status: 'stopped', pid: null };
  #crashes: CrashWindow;
  #restartTimer: ReturnType<typeof setTimeout> | null = null;
  #healthTimer: ReturnType<typeof setInterval> | null = null;
  #deploying = false;
  #restarting = false;
  #closed = false;
  #running: Promise<void> | null = null;
  #starting: Promise<void> | null = null;
  #stopping: Promise<void> | null = null;
  #closing: Promise<void> | null = null;
  #pending: SupervisorProblem[] = [];
  #control: NetServer | null = null;
  #page: HttpServer | null = null;
  #checking = false;
  // The pinned slot "base" runs (the repository's HEAD at start), or null to run `o.base` as it is.
  #base: string | null = null;
  // Where each server said the data stood before it ran any work (its `mark` message).
  #marks = new WeakMap<ServerProcess, Mark>();
  // When a repair last asked for a restart: at most one a minute.
  #askedRestartAt = 0;
  // The supervisor driver (the console and every other service) and the Service Manager over it.
  readonly services: SupervisorDriver;
  readonly manager: ServiceManager;

  constructor(o: SupervisorOptions) {
    this.o = o;
    const t = { ...DEFAULT_TIMINGS, ...o.timings };
    // How often the console's health is checked is its definition's, unless the timings say.
    if (o.timings?.healthEveryMs === undefined) t.healthEveryMs = this.console(BASE).health.every_s * 1000;
    t.canaryMs = Math.max(t.canaryMs, MIN_CANARY_MS);
    t.probeEveryMs = Math.min(t.probeEveryMs, t.canaryMs / 2);
    this.t = t;
    this.#crashes = new CrashWindow(t);
    this.slots = new Slots({ dir: o.dir, repo: o.repo });
    this.stateFile = join(o.dir, 'state.json');
    mkdirSync(o.dir, { recursive: true, mode: 0o700 });
    this.state = this.#load();
    this.services = new SupervisorDriver({
      dir: o.dir,
      timings: { ...t, healthEveryMs: o.timings?.healthEveryMs },
      console: {
        definition: () => this.console(),
        status: () => consoleStatus(this.state),
        prepare: (v) => this.#prepare(v),
        deploy: (v, say, expected) => this.deploy(v, say, expected),
        rollback: (r, say) => {
          if (this.#deploying) return Promise.resolve({ ok: false, said: 'A deploy is running; it rolls back by itself if its canary fails.' });
          return this.rollback({ ...r, target: this.state.releases.previous, say });
        },
      },
      problem: (p) => this.#problem(p),
      reserved: () => this.reservedPorts(),
      changed: () => { if (this.state) this.#save(); },
      ...(o.log ? { log: o.log } : {}),
      ...(o.echo ? { echo: o.echo } : {}),
    });
    this.manager = new ServiceManager({ dir: join(o.dir, 'registry'), drivers: [this.services] });
  }

  // Every port Nova itself uses, by what it is, from its configuration and what runs now: the
  // console's configured port (taken even while the console restarts, or is held), the port it
  // answers on now, and the device door's.
  reservedPorts(): { port: number; what: string }[] {
    const out: { port: number; what: string }[] = [];
    const add = (port: unknown, what: string) => { const n = Number(port); if (Number.isInteger(n) && n > 0 && n <= 65_535 && !out.some((x) => x.port === n)) out.push({ port: n, what }); };
    add(this.o.ports?.console, 'Nova’s own console port');
    add(this.o.env.NOVA_PORT, 'Nova’s own console port');
    add(this.state?.server.port, 'the port Nova’s console answers on');
    add(this.o.ports?.mesh, 'Nova’s device door');
    try { if (this.o.env.NOVA_MESH_URL) add(new URL(this.o.env.NOVA_MESH_URL).port, 'Nova’s device door'); } catch { /* not a URL: the server says so */ }
    return out;
  }

  // The console's service definition, for the release that runs (or `version`).
  console(version: string = this.state?.releases.current ?? BASE): ServiceDefinition {
    const port = Number(this.o.env.NOVA_PORT ?? 4317);
    return (this.o.consoleDefinition ?? consoleDefinition)({ version, port: Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : 0 });
  }

  // ---- running ----------------------------------------------------------------------------------

  run(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('The supervisor is closed.'));
    return this.#running ??= this.#run();
  }

  async #run(): Promise<void> {
    // Its folder holds the control socket and the slots that run: the person's alone, or nothing.
    const st = statSync(this.o.dir);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid !== null && st.uid !== uid) throw new Error(`The supervisor’s folder ${this.o.dir} belongs to another user. Use a folder of your own.`);
    if (st.mode & 0o077) throw new Error(`The supervisor’s folder ${this.o.dir} is open to other users (mode ${(st.mode & 0o777).toString(8)}). Close it first: chmod 700 ${this.o.dir}`);
    const other = runningPid(this.o.home);
    if (other) throw new Error(`A Nova server is already running this home (process ${other}). Stop it first: the supervisor starts its own.`);
    if (unsafeHome(this.o.home) || !ensureMark(this.o.home)) throw new Error('The supervisor needs a safe, Nova-owned home folder.');
    const pidFile = join(this.o.dir, 'supervisor.pid');
    const prev = Number(readOr(pidFile, '0'));
    if (prev && prev !== process.pid && alive(prev)) throw new Error(`Another supervisor (process ${prev}) is already running with ${this.o.dir}.`);
    writeFileSync(pidFile, String(process.pid));
    await this.#listen();
    if (this.#closed) return;
    this.state.pid = process.pid;
    // "base" is the commit the repository was at now, in a slot of its own: the checkout on disk
    // may be edited while Nova runs, and that must never change what a restart runs.
    const pinned = await this.slots.pinBase().catch((e: Error) => { this.#say(`The base couldn’t be pinned to a commit: ${e.message}`); return null; });
    if (this.#closed) return;
    this.#base = pinned?.path ?? null;
    this.state.releases.base_commit = pinned?.commit ?? null;
    if (!pinned) this.#say(`${this.o.repo} has no commit to pin, so "base" runs ${this.o.base} as it is on disk.`);
    // Releases on disk are the truth for which one is current.
    const cur = this.slots.current();
    this.state.releases.current = cur && this.slots.list().includes(cur) ? cur : BASE;
    if (this.state.mode === 'safe_mode' && this.state.safe_mode) {
      this.#say(`Nova is held in safe mode: ${this.state.safe_mode.reason} Run “recover” or “rollback”.`);
      await this.#openPage();
    } else {
      await this.#start();
    }
    if (this.#closed) return;
    this.#healthTimer = setInterval(() => { void this.#healthCheck(); }, this.t.healthEveryMs);
    // Every other service it runs, as they were when it stopped.
    await this.services.resume();
    this.#save();
  }

  close(): Promise<void> {
    this.#closed = true;
    return this.#closing ??= this.#close();
  }

  async #close(): Promise<void> {
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    if (this.#healthTimer) clearInterval(this.#healthTimer);
    // Startup owns a child before readiness (also the reset-only cleaner). Join that work
    // before stopping the resulting pair or removing lifecycle evidence; never race resume.
    const services = Promise.allSettled([this.services.close()]);
    // A run preflight refusal has no owned child. Join its continuation, while the separately
    // tracked startup carries any actual child failure and the pair stop joins physical cleanup.
    const startup = await Promise.allSettled([this.#running?.catch(() => {}), this.#starting]);
    const results = await Promise.all([services, Promise.allSettled([this.#stopServer()])]);
    const failure = [...startup, ...results.flat()].find((r) => r.status === 'rejected');
    if (failure) {
      this.state.mode = 'safe_mode';
      this.state.safe_mode = { reason: 'Owned cleanup was not confirmed. Operator recovery is required.', at: nowIso(), last_good: this.state.releases.last_good, output: '' };
    }
    await this.#closePage();
    await new Promise<void>((r) => (this.#control ? this.#control.close(() => r()) : r()));
    rmSync(join(this.o.dir, 'control.sock'), { force: true });
    if (!failure) rmSync(join(this.o.dir, 'supervisor.pid'), { force: true });
    if (this.state.mode !== 'safe_mode') this.state.mode = 'stopped';
    this.#save();
    if (failure?.status === 'rejected') throw failure.reason;
  }

  codeRoot(version: string | null = this.state.releases.current): string {
    return !version || version === BASE ? (this.#base ?? this.o.base) : this.slots.path(version);
  }

  #start(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#starting) return this.#starting;
    const operation = (async () => {
      try { await this.#startPair(); }
      catch (e) {
        if (this.#closed) throw e; // close owns this failure too, not a best-effort crash callback.
        await this.#crashed(null, { code: 1, signal: null });
      }
    })();
    this.#starting = operation;
    void operation.finally(() => { if (this.#starting === operation) this.#starting = null; }).catch(() => {});
    return operation;
  }

  async #startPair(): Promise<void> {
    if (this.#closed) return;
    // Every fallback enters here. A retained handle means its cleanup was not confirmed;
    // neither rollback nor another startup may overwrite that ownership.
    if (this.#broker || this.server || this.#stopping) throw new Error('Previous broker/Core ownership must be cleaned up before starting.');
    const root = this.codeRoot();
    const source = join(root, 'src', 'broker');
    const keyMode = this.o.env.NOVA_VAULT_KEY === 'file' ? 'file' as const : 'auto' as const;
    const reset = supervisorResetPending(this.o.home);
    if (reset) {
      if (reset.broker) {
        const cleaner = await startBroker(join(this.o.home, 'broker'), { source, keyMode, env: this.o.env, reset: true, pipe: true });
        await cleaner.stopped;
      }
      if (this.#closed) return;
      finishReset(this.o.home, { brokerCleaned: reset.seal, vault: { mode: keyMode } });
    }
    if (existsSync(join(source, 'main.ts'))) {
      if (!ensureMark(this.o.home) || homeEntries(this.o.home).before.includes('broker')) throw new Error('Broker storage is not owned by this home.');
      const b = await startBroker(join(this.o.home, 'broker'), { source, keyMode, env: this.o.env, pipe: true });
      this.#broker = b;
      if (this.#closed) return; // close joins startup, then drains this retained handle.
      this.#brokerState = { status: 'running', pid: b.child.pid ?? null };
      b.child.once('exit', (code, signal) => {
        if (this.#broker !== b || this.#brokerStopping || this.#closed) return;
        this.#broker = null;
        this.#brokerState = { status: 'failed', pid: null };
        void this.#crashed(null, { code, signal });
      });
    } else {
      // Old release fixtures remain usable for noncredential work, never fake broker success.
      this.#brokerState = { status: 'unsupported', pid: null };
    }
    // Its command is its definition's: `node` is the Node running the supervisor, and the script
    // after it is in the release's code.
    const [cmd, script, ...rest] = this.console().artifact.release!.command;
    const argv = cmd === 'node' ? [process.execPath, ...(script ? [script.startsWith('-') || script.startsWith('/') ? script : join(root, script)] : []), ...rest] : [cmd!, ...(script ? [script] : []), ...rest];
    const s = new ServerProcess({
      root,
      argv,
      env: { ...this.o.env, NOVA_HOME: this.o.home, NOVA_SUPERVISED: '1', NOVA_SUPERVISOR_STATE: this.stateFile },
      ...(this.o.echo ? { echo: this.o.echo } : {}),
    });
    this.server = s;
    this.state.mode = this.#deploying ? 'deploying' : 'starting';
    this.state.server = { ...this.state.server, pid: s.pid, port: null, started_at: nowIso(), code: root };
    this.#save();
    s.on('ready', (port: number) => {
      if (this.#closed || this.server !== s) return;
      this.state.server.port = port;
      if (!this.#deploying) this.state.mode = 'running';
      this.state.health.failing = 0;
      this.#save();
      // Problems wait until the server can take them (its core is listening on the channel).
      for (const p of this.#pending.splice(0)) s.send({ nova: 'problem', ...p });
    });
    s.on('message', (m: unknown) => { void this.#onMessage(s, m); });
    s.on('exit', (e: { code: number | null; signal: string | null; expected: boolean }) => {
      if (this.server === s) this.server = null;
      this.state.server.last_exit = { code: e.code, signal: e.signal, at: nowIso() };
      this.state.server.pid = null;
      this.#save();
      if (e.expected || this.#closed || this.#deploying) return;
      void this.#crashed(s, e);
    });
  }

  async #crashed(s: ServerProcess | null, e: { code: number | null; signal: string | null }): Promise<void> {
    if (this.#closed) return;
    try { await this.#stopServer(); }
    catch { await this.#enterSafeMode('Broker owned cleanup was not confirmed. Operator recovery is required.', ''); return; }
    if (this.#closed) return;
    const now = Date.now();
    this.#crashes.record(now);
    const how = e.signal ? `was stopped by ${e.signal}` : `exited with code ${e.code}`;
    const tail = s?.tail(15) ?? 'The credential broker stopped or could not start.';
    if (this.#crashes.tooMany) {
      void this.#enterSafeMode(`Nova stopped ${this.#crashes.count} times within ${Math.round(this.t.windowMs / 1000)} s (the last time it ${how}), so the supervisor stopped restarting it.`, tail);
      return;
    }
    const wait = this.#crashes.wait();
    this.state.mode = 'restarting';
    this.state.server.restarts++;
    this.#save();
    this.#say(`Nova ${how}. Starting it again in ${(wait / 1000).toFixed(1)} s.`);
    this.#restartTimer = setTimeout(() => { this.#restartTimer = null; void this.#start(); }, wait);
    this.#problem({
      source: 'supervisor', playbook: 'server-crashed',
      said: `Nova stopped unexpectedly (it ${how}) and the supervisor started it again.`,
      detail: tail, repairs: [{ name: 'restart-server', ok: true, said: `Started again after ${(wait / 1000).toFixed(1)} s.` }],
    });
  }

  async #enterSafeMode(reason: string, output: string): Promise<void> {
    try { await this.#stopServer(); } catch { reason += ' Broker cleanup is unconfirmed; retained run evidence must be recovered.'; }
    const lastGood = this.state.releases.last_good;
    this.state.mode = 'safe_mode';
    this.state.safe_mode = { reason, at: nowIso(), last_good: lastGood, output };
    this.#save();
    const offer = lastGood && lastGood !== this.state.releases.current ? ` The last good release is ${lastGood}: node src/supervisor/main.ts rollback goes back to it.` : '';
    // What was waiting for a server that won't come goes into the database now.
    for (const p of this.#pending.splice(0)) recordProblem(this.o.home, p);
    recordProblem(this.o.home, { source: 'supervisor', playbook: 'safe-mode', said: `Nova is held in safe mode: ${reason}${offer}`, detail: output });
    this.#say(`Safe mode: ${reason}${offer}`);
    if (!this.#closed) await this.#openPage();
  }

  // Leaves safe mode on the person's word: starts Nova again from the current release.
  async recover(): Promise<{ ok: boolean; said: string }> {
    if (this.#restarting || this.#starting || this.#closed) return { ok: false, said: 'A restart is already running or the supervisor is closed.' };
    if (this.state.mode !== 'safe_mode') return { ok: false, said: 'Nova isn’t in safe mode.' };
    this.#restarting = true;
    try {
      await this.#stopServer();
      await this.#closePage();
      this.#crashes.reset();
      this.state.safe_mode = null;
      await this.#start();
      const port = await this.server?.ready(this.t.readyMs);
      return port ? { ok: true, said: `Nova is running again on port ${port}.` } : { ok: false, said: 'Nova didn’t start; it may go back to safe mode.' };
    } finally { this.#restarting = false; }
  }

  async restart(why = 'as asked', graceMs?: number): Promise<{ ok: boolean; said: string }> {
    if (this.#deploying) return { ok: false, said: 'A deploy is running; it restarts Nova itself.' };
    if (this.#restarting || this.#starting || this.#closed) return { ok: false, said: 'A restart is already running or the supervisor is closed.' };
    this.#restarting = true;
    if (this.#restartTimer) { clearTimeout(this.#restartTimer); this.#restartTimer = null; }
    try {
      await this.#stopServer(graceMs);
      await this.#start();
      const port = await this.server?.ready(this.t.readyMs);
      return port ? { ok: true, said: `Nova was restarted (${why}) and answers on port ${port}.` } : { ok: false, said: 'Nova didn’t come back after the restart.' };
    } finally { this.#restarting = false; }
  }

  #stopServer(graceMs?: number): Promise<void> {
    if (this.#stopping) return this.#stopping;
    const operation = this.#stopPair(graceMs);
    this.#stopping = operation;
    void operation.finally(() => { if (this.#stopping === operation) this.#stopping = null; }).catch(() => {});
    return operation;
  }

  async #stopPair(graceMs?: number): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await s.stop(graceMs);
    const b = this.#broker;
    if (b) {
      this.#brokerStopping = true;
      try {
        await stopBroker(b);
        this.#broker = null;
        this.#brokerState = { status: 'stopped', pid: null };
      } catch (e) {
        this.#brokerState = { status: 'failed', pid: null };
        this.state.mode = 'safe_mode';
        this.state.safe_mode = { reason: 'Broker owned cleanup was not confirmed. Operator recovery is required.', at: nowIso(), last_good: this.state.releases.last_good, output: '' };
        this.#save();
        throw e;
      } finally { this.#brokerStopping = false; }
    }
  }

  // ---- health -----------------------------------------------------------------------------------

  async #healthCheck(): Promise<void> {
    if (this.#checking || this.#deploying || this.#closed || this.state.mode !== 'running' || !this.server?.port) return;
    this.#checking = true;
    try {
      const r = await this.#health(this.server.port);
      this.state.health.last_check_at = nowIso();
      if (r.answered) {
        this.state.health = { ...this.state.health, last_ok_at: nowIso(), failing: 0, said: r.said };
      } else {
        this.state.health.failing++;
        this.state.health.said = r.said;
        if (this.state.health.failing >= this.t.healthFailures) {
          const n = this.state.health.failing;
          this.#say(`Nova hasn’t answered ${n} health checks in a row. Restarting it.`);
          // A process that doesn't answer may not take SIGTERM either: a short grace, then SIGKILL.
          const out = await this.restart('it stopped answering', 3000);
          this.#problem({ source: 'supervisor', playbook: 'server-unresponsive', said: `Nova stopped answering its health checks (${n} in a row), so the supervisor restarted it.`, detail: r.said, repairs: [{ name: 'restart-server', ok: out.ok, said: out.said }] });
        }
      }
      this.#save();
    } finally {
      this.#checking = false;
    }
  }

  async #health(port: number): Promise<{ answered: boolean; ok: boolean; failing: { name: string; detail: string }[]; said: string }> {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${this.console().health.http}`, { signal: AbortSignal.timeout(Math.min(5000, Math.max(1000, this.t.healthEveryMs))) });
      const body = await r.json() as { ok?: boolean; checks?: Record<string, { ok: boolean; detail?: string }> };
      const failing = Object.entries(body.checks ?? {}).filter(([, c]) => !c.ok).map(([name, c]) => ({ name, detail: c.detail ?? 'not ok' }));
      return { answered: true, ok: r.status === 200 && body.ok === true, failing, said: failing.length ? failing.map((f) => `${f.name}: ${f.detail}`).join('; ') : 'Healthy.' };
    } catch (e) {
      return { answered: false, ok: false, failing: [], said: `No answer from Nova: ${(e as Error).message}` };
    }
  }

  // ---- problems ---------------------------------------------------------------------------------

  // Told to the running server (stored and shown like any problem), or kept until one is ready.
  #problem(p: SupervisorProblem): void {
    if (this.server?.port && this.server.send({ nova: 'problem', ...p })) return;
    if (this.server || this.#restartTimer || this.#deploying) { this.#pending.push(p); return; }
    // No server is coming (safe mode, stopped): straight into the database, so it is there.
    recordProblem(this.o.home, p);
  }

  #say(line: string): void {
    this.o.log?.(`[supervisor] ${line}\n`);
  }

  // ---- the server's requests (the console's API) -----------------------------------------------

  async #onMessage(s: ServerProcess, m: unknown): Promise<void> {
    const msg = m as { nova?: string; id?: string; type?: string; version?: string; seq?: unknown; problem?: unknown; staged?: unknown; service?: unknown; confirm?: unknown; expected?: unknown };
    if (s !== this.server) return;
    if (msg?.nova === 'broker-ready') {
      const b = this.#broker;
      s.send({ nova: 'broker', context: b ? { socket: b.socket, token: b.tokens.core } : null });
      return;
    }
    if (msg?.nova === 'mark') {
      if (Number.isInteger(msg.seq) && Number.isInteger(msg.problem)) this.#marks.set(s, { seq: msg.seq as number, problem: msg.problem as number });
      return;
    }
    if (msg?.nova !== 'request' || typeof msg.id !== 'string') return;
    const reply = (ok: boolean, said: string) => s.send({ nova: 'reply', id: msg.id, ok, said });
    if (msg.type === 'service-promote' || msg.type === 'service-rollback') {
      const allowed = msg.type === 'service-promote' ? ['nova', 'id', 'type', 'service', 'version', 'confirm', 'expected'] : ['nova', 'id', 'type', 'service', 'confirm', 'expected'];
      if (Object.keys(msg).some(k => !allowed.includes(k)) || typeof msg.service !== 'string' || !/^[a-z][a-z0-9-]{0,127}$/.test(msg.service) || typeof msg.confirm !== 'string' || (msg.type === 'service-promote' && (typeof msg.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(msg.version)))) return void reply(false, 'Invalid service request.');
      if (!validServiceExpected(msg.expected)) return void reply(false, 'Invalid approved service state.');
      const expected = msg.expected;
      const service = msg.service, version = msg.version, confirm = msg.confirm, promote = msg.type === 'service-promote';
      const checked = promote ? this.manager.promotionCheck(service, version!, confirm, expected) : this.manager.rollbackCheck(service, confirm, expected);
      if (!checked.ok) return void reply(false, 'The service manager refused the change: check confirmation, readiness and the kept version.');
      if (service === CONSOLE && this.#deploying) return void reply(false, 'A console deploy is already running.');
      s.send({ nova: 'reply', id: msg.id, ok: true, accepted: true, said: 'The service change was accepted. Refresh to observe the outcome; this does not confirm it is serving.' });
      // Give the requesting server a chance to return HTTP before a console switch stops it.
      // Revalidate through the same manager at execution; acceptance is never a cached grant.
      setTimeout(() => {
        if (this.#closed) return;
        void (async () => {
          try {
            const result = promote ? await this.manager.promote(service, version!, confirm, () => {}, expected) : await this.manager.rollback(service, confirm, () => {}, expected);
            if (!result.ok) this.#problem({ source: 'supervisor', playbook: 'service-stopped', subject: service, said: `The accepted change to ${service} was refused when it ran. Refresh its service status before trying again.` });
          } catch {
            this.#problem({ source: 'supervisor', playbook: 'service-stopped', subject: service, said: `The accepted change to ${service} stopped unexpectedly. Refresh its service status before trying again.` });
          } finally { this.#save(); }
        })();
      }, 300).unref();
    } else if (msg.type === 'deploy') {
      if (!isRelease(msg.version)) return void reply(false, 'That isn’t a release’s tag.');
      if (this.#deploying) return void reply(false, 'A deploy is already running.');
      if (!(await this.slots.commit(msg.version))) return void reply(false, `There is no release tagged ${msg.version}.`);
      reply(true, `Deploying ${msg.version}: its tests, a sandbox start on a copy of your home, smoke probes, the switch, then a canary window. Nova restarts during the switch.`);
      void this.deploy(msg.version).catch((e) => this.#say(`The deploy stopped: ${(e as Error).message}`));
    } else if (msg.type === 'rollback') {
      if (this.#deploying) return void reply(false, 'A deploy is running; it rolls back by itself if its canary fails.');
      const target = this.state.releases.previous;
      if (!target) return void reply(false, 'There is no previous release to go back to.');
      reply(true, `Going back to ${target === BASE ? 'the code the supervisor started from' : target}. Nova restarts.`);
      void this.rollback({ auto: false, reason: 'You asked to go back.', target });
    } else if (msg.type === 'restart' && msg.staged === true && stagedPending(this.o.home)) {
      // A restore (or reset) staged on the hub's own screen, finished by the next start: not a
      // crash, and not a repair's restart that is held to one a minute (core resilience/restart.ts).
      if (this.#deploying) return void reply(false, 'A deploy is running; try again once it has finished.');
      reply(true, 'Restarting Nova to finish what was staged.');
      setTimeout(() => { if (!this.#closed) void this.restart('to finish a restore'); }, 300).unref();
    } else if (msg.type === 'restart') {
      const r = this.#askedRestart();
      reply(r.ok, r.said);
    } else reply(false, 'The supervisor doesn’t do that.');
  }

  // A restart a repair asked for (the server's API, from the hub's screen or an approver): at
  // most one a minute, and each counts toward safe mode like a crash, so nothing that can ask
  // can keep the hub restarting.
  #askedRestart(): { ok: boolean; said: string } {
    if (this.#deploying) return { ok: false, said: 'A deploy is running; it restarts Nova itself.' };
    if (this.state.mode === 'safe_mode') return { ok: false, said: 'Nova is held in safe mode; run “recover” on this computer.' };
    const now = Date.now();
    const since = now - this.#askedRestartAt;
    if (since < this.t.windowMs) return { ok: false, said: `Nova was restarted on request ${Math.round(since / 1000)} s ago; the supervisor does that at most once every ${Math.round(this.t.windowMs / 1000)} s.` };
    this.#askedRestartAt = now;
    this.#crashes.record(now);
    if (this.#crashes.tooMany) {
      void this.#enterSafeMode(`Nova stopped or was restarted ${this.#crashes.count} times within ${Math.round(this.t.windowMs / 1000)} s (the last time a repair asked for it), so the supervisor stopped restarting it.`, this.server?.tail(15) ?? '');
      return { ok: true, said: 'Nova was stopped or restarted too often within a minute, so the supervisor holds it in safe mode instead.' };
    }
    // A moment's wait, so the answer gets back to whoever asked before the server stops.
    setTimeout(() => { if (!this.#closed) void this.restart('a repair playbook asked'); }, 300).unref();
    return { ok: true, said: 'Restarting Nova in a moment.' };
  }

  // ---- deploying ---------------------------------------------------------------------------------

  async deploy(version: string, say: Say = () => {}, expected?: ServiceExpectedState): Promise<{ ok: boolean; said: string }> {
    if (this.#restarting || this.#starting || this.#closed) return { ok: false, said: 'A restart is already running or the supervisor is closed.' };
    if (this.#deploying) return { ok: false, said: 'A deploy is already running.' };
    if (expected !== undefined && !sameServiceExpected(expected, consoleStatus(this.state))) return { ok: false, said: SERVICE_CHANGED };
    if (!isRelease(version)) return { ok: false, said: 'That isn’t a release’s tag.' };
    if (version === this.state.releases.current) return { ok: false, said: `${version} is already running.` };
    this.#deploying = true;
    const from = this.state.releases.current ?? BASE;
    this.state.deploy = { version, from, started_at: nowIso(), stage: 'prepare', stages: [], canary: null, outcome: 'running' };
    this.state.mode = 'deploying';
    this.#save();
    const stage = (name: DeployStage['stage'], ok: boolean, said: string) => {
      this.state.deploy!.stage = name;
      this.state.deploy!.stages.push({ stage: name, ok, at: nowIso(), said });
      this.#save();
      say(`${ok ? '✓' : '✗'} ${name}: ${said}`);
      this.#say(`deploy ${version} · ${name}: ${said}`);
    };
    const stopped = (name: DeployStage['stage'], said: string) => {
      stage(name, false, said);
      this.state.deploy!.outcome = 'stopped';
      this.#history(version, from, 'stopped', said);
      this.#slot(version, { status: 'failed' });
      this.#problem({ source: 'supervisor', playbook: 'release-stopped', subject: version, said: `Release ${version} didn’t pass its ${name === 'tests' ? 'tests' : name === 'smoke' ? 'smoke probes' : name === 'sandbox' ? 'sandbox start' : 'checks'}, so Nova kept running ${from === BASE ? 'what it had' : from}.`, detail: said });
      return { ok: false, said: `Stopped at ${name}: ${said}` };
    };
    try {
      // 1. The slot: a worktree of the tag's commit.
      let slot: { path: string; commit: string };
      try { slot = await this.slots.ensure(version); } catch (e) { return stopped('prepare', (e as Error).message); }
      if (!sandboxable(slot.path)) return stopped('prepare', 'This release is from before Nova could run a release in a sandbox, so it can’t go through the pipeline.');
      this.#slot(version, { commit: slot.commit, status: 'ready' });
      stage('prepare', true, `Release ${version} is commit ${slot.commit.slice(0, 12)}.`);

      // 2. Its own tests.
      const tests = await this.#runTests(slot.path);
      if (!tests.ok) return stopped('tests', tests.said);
      stage('tests', true, tests.said);

      // 3–4. A sandbox start on a copy of the home, and the smoke probes. What already fails on
      // the live home (a backup drive unplugged) is no fault of the release.
      const baseline = this.server?.port ? (await this.#health(this.server.port)).failing.map((f) => f.name) : [];
      const scratch = makeScratch('sandbox');
      try {
        const home = join(scratch, 'home');
        copyHome(this.o.home, home);
        let sb: Awaited<ReturnType<typeof startSandbox>>;
        try { sb = await startSandbox({ root: slot.path, home, timeoutMs: this.t.readyMs }); } catch (e) { return stopped('sandbox', (e as Error).message); }
        stage('sandbox', true, 'It started on a copy of your home, with no work, no network peers and no secrets.');
        let probes: Awaited<ReturnType<typeof smoke>>;
        try { probes = await smoke(sb.base, { ignore: ['vault', ...baseline] }); } finally { await sb.stop(); }
        const bad = probes.filter((p) => !p.ok);
        if (bad.length) return stopped('smoke', bad.map((p) => `${p.name}: ${p.said}`).join(' '));
        stage('smoke', true, `${probes.length} probes passed: ${probes.map((p) => p.name).join(', ')}.`);
      } finally {
        dropScratch(scratch);
      }

      // 5. The switch. From the moment the running release stops, anything that goes wrong puts
      // it back, so a failed switch never leaves Nova stopped.
      const pre = schemaVersion(this.o.home);
      const t0 = Date.now();
      await this.#stopServer();
      // A checkpoint of the stopped home first (M7 amendment §1). None, and there is no switch: the
      // running release starts again as it was. A home with no database yet has nothing to keep.
      try {
        if (existsSync(join(this.o.home, 'nova.db'))) takeCheckpoint({ home: this.o.home, kind: 'auto', reason: `Before switching to release ${version}`, version: packageVersion(this.codeRoot(from)) ?? from });
      } catch (e) {
        await this.#start();
        await this.server?.ready(this.t.readyMs);
        return stopped('switch', `Nova couldn’t take a checkpoint before switching, so it didn’t switch: ${(e as Error).message}`);
      }
      let port: number | null | undefined = null;
      let migration: ReleaseSlot['migration'] = null;
      try {
        this.slots.point(version);
        this.state.releases.current = version;
        await this.#start();
        const started = this.server;
        port = await started?.ready(this.t.readyMs);
        const post = schemaVersion(this.o.home);
        if (post > pre) {
          // Where the data stood before the new release ran any work (recovery, the heartbeat),
          // as it said itself: going back may undo nothing after that. An older release that
          // can't say it is read now, after its start, and the slot says which it was.
          const said = started ? await this.#markOf(started) : null;
          migration = { from: pre, to: post, backup: preMigrationBackup(this.o.home, pre, t0), mark: said ? { ...said, by: 'release' } : { ...mark(this.o.home), by: 'supervisor' } };
        }
        this.#slot(version, { migration });
      } catch (e) {
        const why = `The switch to ${version} failed: ${(e as Error).message}`;
        if (this.state.releases.current !== version) {
          // Nothing of the new release ran: the one before starts again as it was.
          await this.#start();
          await this.server?.ready(this.t.readyMs);
          return stopped('switch', `${why}. Nova went back to running ${from === BASE ? 'the code the supervisor started from' : from}.`);
        }
        stage('switch', false, why);
        return await this.rollback({ auto: true, reason: why, target: from, say });
      }
      if (!port) {
        stage('switch', false, `It didn’t start on your home: ${this.#lastWords()}`);
        return await this.rollback({ auto: true, reason: `Release ${version} didn’t start on your home.`, target: from, say });
      }
      stage('switch', true, `Running ${version} on your home${migration ? `; the database was upgraded from ${migration.from} to ${migration.to}, with the backup from before kept` : ''}.`);

      // 6. The canary window: health on the live home, probe by probe.
      const until = Date.now() + this.t.canaryMs;
      this.state.deploy!.stage = 'canary';
      this.state.deploy!.canary = { until: new Date(until).toISOString(), probes: [] };
      this.#save();
      let n = 0;
      while (Date.now() < until || n < 2) {
        await sleep(this.t.probeEveryMs);
        const p = await this.#canaryProbe(baseline);
        n++;
        this.state.deploy!.canary!.probes.push(p);
        this.#save();
        if (!p.ok) {
          stage('canary', false, p.said);
          return await this.rollback({ auto: true, reason: p.said, target: from, say });
        }
      }
      stage('canary', true, `${n} probes over ${Math.round(this.t.canaryMs / 1000)} s, all healthy.`);

      // 7. Promoted: this is the release now, and the one before it is kept to go back to.
      this.state.releases.previous = from;
      this.state.releases.last_good = version;
      this.#slot(version, { status: 'live' });
      if (from !== BASE) this.#slot(from, { status: 'previous' });
      this.state.deploy!.outcome = 'promoted';
      this.state.mode = 'running';
      this.#crashes.reset();
      stage('promote', true, `${version} is live; ${from === BASE ? 'the code the supervisor started from' : from} is kept to go back to.`);
      this.#history(version, from, 'promoted', 'Passed its tests, the sandbox, the smoke probes and the canary.');
      return { ok: true, said: `${version} is live.` };
    } finally {
      this.#deploying = false;
      if (this.state.mode === 'deploying') this.state.mode = this.server ? 'running' : 'stopped';
      this.#save();
    }
  }

  async #canaryProbe(baseline: string[]): Promise<ProbeLine> {
    const at = nowIso();
    const s = this.server;
    if (!s || !s.alive) return { at, ok: false, said: `Nova stopped during the canary window: ${this.#lastWords()}` };
    if (!s.port) return { at, ok: false, said: 'Nova isn’t listening.' };
    const h = await this.#health(s.port);
    if (!h.answered) return { at, ok: false, said: h.said };
    const fresh = h.failing.filter((f) => !baseline.includes(f.name));
    if (fresh.length) return { at, ok: false, said: `Health failed: ${fresh.map((f) => `${f.name}: ${f.detail}`).join('; ')}` };
    return { at, ok: true, said: baseline.length && h.failing.length ? `Healthy, apart from what already failed before (${h.failing.map((f) => f.name).join(', ')}).` : 'Healthy.' };
  }

  // The mark a server sent before its work started; the message may come just after its "ready"
  // line. Null from a release too old to send one.
  async #markOf(s: ServerProcess): Promise<Mark | null> {
    for (let i = 0; i < 100 && !this.#marks.has(s) && s.alive; i++) await sleep(50);
    return this.#marks.get(s) ?? null;
  }

  #lastWords(): string {
    const tail = this.server?.tail(8) ?? '';
    const code = this.state.server.last_exit;
    return `${code ? `it ${code.signal ? `was stopped by ${code.signal}` : `exited with code ${code.code}`}` : 'no answer'}${tail ? `. Its last words:\n${tail}` : ''}`;
  }

  // The release's own test suite, in its slot, with a scratch HOME so no test can reach a real home.
  async #runTests(root: string): Promise<{ ok: boolean; said: string }> {
    const [cmd, ...args] = this.o.tests;
    if (!cmd) return { ok: true, said: 'No test command is set.' };
    // Dev dependencies: the slot borrows the base checkout's, when its lockfile is the same.
    const nm = join(root, 'node_modules');
    if (!existsSync(nm) && existsSync(join(this.o.base, 'node_modules')) && readOr(join(root, 'package-lock.json'), 'a') === readOr(join(this.o.base, 'package-lock.json'), 'b')) {
      try { symlinkSync(join(this.o.base, 'node_modules'), nm); } catch { /* the tests say what's missing */ }
    }
    const scratch = makeScratch('release-tests');
    const out: string[] = [];
    try {
      const code = await new Promise<number | null>((resolve) => {
        const p = spawn(cmd, args, { cwd: root, env: { PATH: process.env.PATH ?? '', HOME: scratch, TZ: 'UTC', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
        p.stdout!.on('data', (d) => out.push(String(d)));
        p.stderr!.on('data', (d) => out.push(String(d)));
        const timer = setTimeout(() => { out.push(`\nStopped after ${Math.round(this.t.testsMs / 1000)} s.`); p.kill('SIGKILL'); }, this.t.testsMs);
        p.on('error', (e) => { out.push(e.message); });
        p.on('close', (c) => { clearTimeout(timer); resolve(c); });
      });
      const text = out.join('');
      const counts = /ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/.exec(text);
      if (code === 0) return { ok: true, said: counts ? `${counts[1]} tests passed (${this.o.tests.join(' ')}).` : `${this.o.tests.join(' ')} passed.` };
      return { ok: false, said: `${this.o.tests.join(' ')} failed${counts ? ` (${counts[2]} of ${Number(counts[1]) + Number(counts[2])} tests)` : ''}:\n${text.trim().split('\n').slice(-25).join('\n')}` };
    } finally {
      dropScratch(scratch);
    }
  }

  // ---- going back ---------------------------------------------------------------------------------

  async rollback(o: { auto: boolean; reason: string; target: string | null; say?: Say; expected?: ServiceExpectedState }): Promise<{ ok: boolean; said: string }> {
    if (this.#restarting || this.#starting || this.#closed) return { ok: false, said: 'A restart is already running or the supervisor is closed.' };
    if (!o.auto && this.#deploying) return { ok: false, said: 'A console deploy is already running.' };
    if (o.expected !== undefined && !sameServiceExpected(o.expected, consoleStatus(this.state))) return { ok: false, said: SERVICE_CHANGED };
    const say = o.say ?? (() => {});
    const cur = this.state.releases.current ?? BASE;
    const target = o.target;
    if (!target) return { ok: false, said: 'There is no previous release to go back to.' };
    const name = (v: string) => (v === BASE ? 'the code the supervisor started from' : v);
    const step = (ok: boolean, said: string) => {
      if (this.state.deploy && this.state.deploy.outcome === 'running') this.state.deploy.stages.push({ stage: 'rollback', ok, at: nowIso(), said });
      this.#save();
      say(`${ok ? '✓' : '✗'} rollback: ${said}`);
      this.#say(`rollback ${cur} → ${target}: ${said}`);
    };
    const wasDeploying = this.#deploying;
    this.#deploying = true;
    let restored: string | null = null;
    try {
      await this.#stopServer();
      const mig = this.state.releases.slots.find((s) => s.version === cur)?.migration ?? null;
      if (mig) {
        // Back across a database upgrade: only with nothing written since, from the backup taken
        // before it. Otherwise the newer release keeps running, and the person is told why.
        const w = writesSince(this.o.home, mig.mark);
        const n = Object.values(w).reduce((a, b) => a + b, 0);
        const missing = !mig.backup || !existsSync(mig.backup);
        if (n > 0 || missing) {
          const why = n > 0
            ? `Going back to ${name(target)} would lose ${n} change${n === 1 ? '' : 's'} written since ${cur} upgraded the database (${Object.entries(w).map(([t, k]) => `${k} in ${t}`).join(', ')}).`
            : `The backup taken before ${cur} upgraded the database isn’t there any more.`;
          await this.#start();
          const up = await this.server?.ready(this.t.readyMs);
          if (this.state.deploy?.outcome === 'running') this.state.deploy.outcome = 'refused';
          this.#history(cur, target, 'rollback refused', why);
          const refused: SupervisorProblem = { source: 'supervisor', playbook: 'rollback-refused', subject: cur, said: `Nova couldn’t go back to ${name(target)}: ${why} It kept ${cur} running${o.auto ? `, though its canary failed (${o.reason})` : ''}.`, detail: o.reason };
          if (!up) {
            // Kept, but it doesn't start either: held, with both reasons in the database.
            step(false, `${why} ${cur} didn’t start again either.`);
            this.#pending.push(refused);
            await this.#enterSafeMode(`Going back to ${name(target)} was refused (${why}) and ${cur} didn’t start again.`, this.server?.tail(15) ?? '');
            return { ok: false, said: `${why} ${cur} didn’t start again either, so Nova is held in safe mode.` };
          }
          step(false, `${why} Nova kept ${cur} running.`);
          this.#problem(refused);
          return { ok: false, said: `${why} Nova kept ${cur} running.` };
        }
        const carried = problemsSince(this.o.home, mig.mark.problem);
        restoreBackup(join(this.o.home, 'nova.db'), mig.backup!);
        carryProblems(this.o.home, carried);
        // What going back restored, in plain words: the database as it was before the upgrade;
        // nothing written since was lost, measured from before the newer release ran any work
        // (or, for a release too old to say, from just after it started).
        restored = `Restored the database from before ${cur} upgraded it (version ${mig.from}, from ${mig.backup}). Nothing had been written since ${mig.mark.by === 'supervisor' ? `${cur} was up (it is too old to say where the data stood before its own start, so what it did while starting is undone too)` : `before ${cur} ran any work`}; ${carried.length} problem${carried.length === 1 ? ' was' : 's were'} carried over.`;
        step(true, restored);
      }
      this.slots.point(target === BASE ? null : target);
      this.state.releases.current = target;
      await this.#start();
      const port = await this.server?.ready(this.t.readyMs);
      if (!port) {
        step(false, `${name(target)} didn’t start either.`);
        await this.#enterSafeMode(`Going back to ${name(target)} after ${o.reason} didn’t start either.`, this.server?.tail(15) ?? '');
        return { ok: false, said: 'Neither release would start; Nova is held in safe mode.' };
      }
      this.#slot(cur, { status: o.auto ? 'rolled_back' : 'ready' });
      if (target !== BASE) this.#slot(target, { status: 'live' });
      this.state.releases.previous = null;
      this.state.releases.last_good = target;
      step(true, `${name(target)} is running again.`);
      if (this.state.deploy?.outcome === 'running') this.state.deploy.outcome = 'rolled_back';
      this.state.mode = 'running';
      this.#history(cur, target, o.auto ? 'rolled back' : 'went back', `${o.reason}${restored ? ` ${restored}` : ''}`);
      if (o.auto) this.#problem({ source: 'supervisor', playbook: 'release-rolled-back', subject: cur, said: `Release ${cur} was rolled back by itself: its health failed in the canary window. ${name(target)} is running again, with your data as it was.`, detail: `${o.reason}${restored ? `\n${restored}` : ''}` });
      return { ok: true, said: `${o.auto ? `Rolled back: ${o.reason} ` : ''}${restored ? `${restored} ` : ''}${name(target)} is running again.` };
    } catch (e) {
      // Restore availability only when previous ownership can be cleaned up. #start's shared
      // admission guard retains failed broker ownership and holds every fallback in safe mode.
      const why = (e as Error).message;
      step(false, `Going back stopped: ${why}`);
      if (!this.server) {
        try { this.slots.point(cur === BASE ? null : cur); } catch { /* current stays as it was */ }
        this.state.releases.current = cur;
        await this.#start();
        const again = this.server as ServerProcess | null;
        if (!(await again?.ready(this.t.readyMs))) {
          await this.#enterSafeMode(`Going back to ${name(target)} stopped (${why}) and ${name(cur)} didn’t start again.`, again?.tail(15) ?? '');
          return { ok: false, said: `Going back stopped (${why}), and ${name(cur)} didn’t start again: Nova is held in safe mode.` };
        }
      }
      return { ok: false, said: `Going back stopped (${why}); Nova kept ${name(cur)} running.` };
    } finally {
      this.#deploying = wasDeploying;
      // On its own (not inside a deploy, whose end says), it leaves Nova running unless held.
      if (!wasDeploying && this.state.mode === 'deploying') this.state.mode = this.server ? 'running' : 'stopped';
      this.#save();
    }
  }

  // ---- the console as a service (the driver's view of it) ---------------------------------------

  // The slot for a release, made from its tag: what "apply" is for the console. Its alongside start
  // (the sandbox on a copy of the home) is part of its deploy, as it always was.
  async #prepare(version: string): Promise<{ ok: boolean; said: string }> {
    if (!isRelease(version)) return { ok: false, said: 'That isn’t a release’s tag.' };
    if (version === this.state.releases.current) return { ok: false, said: `${version} is already running.` };
    try {
      const slot = await this.slots.ensure(version);
      if (!sandboxable(slot.path)) return { ok: false, said: 'This release is from before Nova could run a release in a sandbox, so it can’t go through the pipeline.' };
      this.#slot(version, { commit: slot.commit, status: 'ready' });
      return { ok: true, said: `Release ${version} is commit ${slot.commit.slice(0, 12)}, ready to deploy: its tests, a sandbox on a copy of your home and the smoke probes run when it is promoted.` };
    } catch (e) {
      return { ok: false, said: (e as Error).message };
    }
  }

  // ---- the state file ------------------------------------------------------------------------------

  #load(): SupervisorState {
    const fresh: SupervisorState = {
      v: 1, pid: process.pid, mode: 'starting', since: nowIso(),
      server: { pid: null, port: null, started_at: null, restarts: 0, last_exit: null, code: this.o.base },
      safe_mode: null, health: { last_check_at: null, last_ok_at: null, failing: 0, said: null },
      releases: { current: BASE, previous: null, last_good: null, slots: [] }, deploy: null, history: [],
    };
    try {
      const s = JSON.parse(readFileSync(this.stateFile, 'utf8')) as SupervisorState;
      if (s.v !== 1) return fresh;
      // What carries over from the last run: releases, history, and safe mode (held until the
      // person says otherwise). A deploy cut short by a stop is said so.
      if (s.deploy?.outcome === 'running') s.deploy.outcome = 'stopped';
      return { ...fresh, releases: s.releases, history: s.history ?? [], deploy: s.deploy, safe_mode: s.safe_mode, mode: s.mode === 'safe_mode' ? 'safe_mode' : 'starting' };
    } catch {
      return fresh;
    }
  }

  #save(): void {
    Object.assign(this.state, { broker: this.#brokerState });
    if (this.services) this.state.services = this.services.status().filter((x) => x.service !== CONSOLE);
    this.state.observed_at = nowIso();
    if (this.manager) this.state.service_policies = this.manager.policies();
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.stateFile);
  }

  #slot(version: string, patch: Partial<ReleaseSlot>): void {
    if (version === BASE) return;
    const list = this.state.releases.slots;
    const i = list.findIndex((s) => s.version === version);
    if (i < 0) list.push({ version, commit: null, created_at: nowIso(), status: 'ready', ...patch });
    else list[i] = { ...list[i]!, ...patch };
    this.#save();
  }

  #history(version: string, from: string | null, outcome: string, said: string): void {
    this.state.history = [{ version, from, at: nowIso(), outcome, said }, ...this.state.history].slice(0, 50);
    this.#save();
  }

  // ---- the control socket (the command line) --------------------------------------------------------

  async #listen(): Promise<void> {
    const path = join(this.o.dir, 'control.sock');
    rmSync(path, { force: true });
    this.#control = createNet((sock) => this.#serve(sock));
    await new Promise<void>((resolve, reject) => { this.#control!.once('error', reject); this.#control!.listen(path, () => resolve()); });
    chmodSync(path, 0o600);
  }

  #serve(sock: Socket): void {
    let buf = '';
    sock.on('data', (d) => {
      buf += String(d);
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = '';
      let req: { cmd?: string; version?: string; confirm?: unknown; service?: string; definition?: unknown };
      try { req = JSON.parse(line); } catch { sock.end(`${JSON.stringify({ done: true, ok: false, said: 'Not a request.' })}\n`); return; }
      const say: Say = (l) => { if (!sock.destroyed) sock.write(`${JSON.stringify({ said: l })}\n`); };
      const end = (r: { ok: boolean; said: string; asks?: boolean }) => { if (!sock.destroyed) sock.end(`${JSON.stringify({ done: true, ...r })}\n`); };
      void (async () => {
        if (req.cmd === 'status') return end({ ok: true, said: JSON.stringify(this.state) });
        // The confirmation is what the person typed (the version, or the word "rollback"), which
        // the command line collects from them; a bare `true` is not one. The socket is the
        // person's only (0600, in a folder that is theirs alone), but any program running as them
        // can still speak to it as the command line would: this guards against a slip, not
        // against code already running as the person (docs/plans/M7.md, as built).
        if (req.cmd === 'deploy') {
          const version = String(req.version ?? '');
          if (req.confirm !== version || !version) return end({ ok: false, said: 'Deploying needs your explicit confirmation every time: type the version.' });
          return end(await this.deploy(version, say));
        }
        if (req.cmd === 'rollback') {
          if (req.confirm !== 'rollback') return end({ ok: false, said: 'Going back needs your confirmation: type rollback.' });
          if (this.#deploying) return end({ ok: false, said: 'A deploy is running; it rolls back by itself if its canary fails.' });
          const target = this.state.mode === 'safe_mode' ? (this.state.safe_mode?.last_good && this.state.safe_mode.last_good !== this.state.releases.current ? this.state.safe_mode.last_good : this.state.releases.previous) : this.state.releases.previous;
          // Nowhere to go: safe mode holds, rather than leave nothing running.
          if (!target) return end({ ok: false, said: this.state.mode === 'safe_mode' ? 'There is no other release to go back to, so Nova stays in safe mode. Fix what the reason names, then run recover.' : 'There is no previous release to go back to.' });
          if (this.state.mode === 'safe_mode') { await this.#closePage(); this.state.safe_mode = null; this.#crashes.reset(); }
          return end(await this.rollback({ auto: false, reason: 'You asked to go back.', target, say }));
        }
        if (req.cmd === 'recover') return end(await this.recover());
        if (req.cmd === 'restart') return end(await this.restart());
        // Services (M10e), through the Service Manager. Deploying one starts it alongside with no
        // traffic (tier 1), and asks first, typed, when it runs a command not yet approved; promoting
        // it wants what the person typed, <service>@<version> (tier 2 or 3); going back wants the word
        // rollback (tier 2); recovering a held one starts its approved version again (tier 1).
        if (req.cmd === 'services') return end({ ok: true, said: JSON.stringify(this.manager.status()) });
        if (req.cmd === 'service-plan') {
          const p = this.manager.plan(req.definition);
          return end(p.ok ? { ok: p.plan.ok, said: JSON.stringify(p.plan) } : { ok: false, said: `The definition can’t be used: ${p.problems.join(' ')}` });
        }
        if (req.cmd === 'service-deploy') {
          const result = await this.manager.deploy(req.definition, say, req.confirm);
          this.#save(); // The manager registers policy only after the driver passed.
          return end(result);
        }
        if (req.cmd === 'service-recover') return end(await this.manager.recover(String(req.service ?? ''), say));
        if (req.cmd === 'service-promote') return end(await this.manager.promote(String(req.service ?? ''), String(req.version ?? ''), req.confirm, say));
        if (req.cmd === 'service-rollback') return end(await this.manager.rollback(String(req.service ?? ''), req.confirm, say));
        end({ ok: false, said: `The supervisor doesn’t know “${req.cmd}”.` });
      })().catch((e) => end({ ok: false, said: (e as Error).message }));
    });
    sock.on('error', () => {});
  }

  // ---- safe mode's page ------------------------------------------------------------------------------

  // While held, Nova's address still answers: the reason, and what to run. Loopback only.
  async #openPage(): Promise<void> {
    const port = this.state.server.port ?? (Number(this.o.env.NOVA_PORT) > 0 ? Number(this.o.env.NOVA_PORT) : null);
    if (!port || this.#page) return;
    const sm = () => this.state.safe_mode;
    this.#page = createHttp((req, res) => {
      const s = sm();
      if (req.url?.startsWith('/api/')) {
        res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: false, safe_mode: s, said: 'Nova is held in safe mode by its supervisor.' }));
        return;
      }
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(safePage(s));
    });
    await new Promise<void>((resolve) => {
      this.#page!.once('error', () => { this.#page = null; resolve(); });
      this.#page!.listen(port, '127.0.0.1', () => resolve());
    });
  }

  async #closePage(): Promise<void> {
    const p = this.#page;
    this.#page = null;
    if (p) await new Promise<void>((r) => { p.close(() => r()); p.closeAllConnections?.(); });
  }
}

// The safe-mode page uses the design system's tokens like every page, with a plain fallback when
// the stylesheet can't be had (the server that serves it is the one held).
function safePage(s: SupervisorState['safe_mode']): string {
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Nova is in safe mode</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:24px;max-width:40rem;background:var(--bg-base,Canvas);color:var(--text-primary,CanvasText)}pre{white-space:pre-wrap;overflow-wrap:anywhere}code{font-family:ui-monospace,monospace}</style></head>
<body><main><h1>Nova is in safe mode</h1><p>${esc(s?.reason ?? 'Nova is held by its supervisor.')}</p>
<p>Nothing is lost: your data is as Nova left it. To go on, run one of these on this computer:</p>
<ul>${s?.last_good ? `<li><code>node src/supervisor/main.ts rollback</code>: go back to ${esc(s.last_good)}, the last release that worked.</li>` : ''}<li><code>node src/supervisor/main.ts recover</code>: start it again once the cause is fixed.</li></ul>
${s?.output ? `<details><summary>What Nova said last</summary><pre>${esc(s.output)}</pre></details>` : ''}</main></body></html>`;
}

function readOr(path: string, fallback: string): string {
  try { return readFileSync(path, 'utf8'); } catch { return fallback; }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}
```

### `src/core/resilience/link.ts`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `6ca67b2b96a1624509983cfabdfe7df9007536ef`, SHA256 `e7210abb57ac518ef96cd8f36b1cc9a5be45a2efbfd175ebf5f9e9a97767851d`, 151 physical lines (152 under boundary count).

```ts
// How a supervised Nova and its supervisor (src/supervisor) talk. The supervisor starts the server
// with an IPC channel and NOVA_SUPERVISED=1, and writes its state to the file NOVA_SUPERVISOR_STATE
// names. Nothing listens on a port for this: only the process the supervisor started can ask it
// anything, and only these few things.
//
//   supervisor → Nova: {nova: 'problem', source, said, playbook, subject?, detail?, repairs?}
//   Nova → supervisor: {nova: 'request', id, type: 'deploy' | 'rollback' | 'restart' | 'service-promote' | 'service-rollback', fixed fields?}
//   supervisor → Nova: {nova: 'reply', id, ok, said}
//   Nova → supervisor: {nova: 'mark', seq, problem}  where the database stands once it is
//     upgraded and before any work runs (core.start()), so a release that changed the database
//     knows exactly what going back would undo: everything after this, the work's own records too.
import { readFileSync } from 'node:fs';
import type { ServiceExpectedState } from '../services/expected.ts';
import type { ServicePolicy } from '../services/topology.ts';
import type { ServiceStatus } from '../services/driver.ts';

export type ServerMode = 'starting' | 'running' | 'restarting' | 'safe_mode' | 'deploying' | 'stopped';

export interface ProbeLine { at: string; ok: boolean; said: string }
export interface Stage { stage: 'prepare' | 'tests' | 'sandbox' | 'smoke' | 'switch' | 'canary' | 'promote' | 'rollback'; ok: boolean; at: string; said: string }

// `migration`: the database upgrade this release made when it went live (from → to), the backup
// taken before it, and where the person's data stood then, so going back knows what it may undo.
export interface ReleaseSlot {
  version: string;
  commit: string | null;
  created_at: string;
  status: 'ready' | 'live' | 'previous' | 'failed' | 'rolled_back';
  // `mark.by`: 'release' when the release said where the data stood before it ran any work;
  // 'supervisor' when an older release couldn't, and the supervisor read it after the start.
  migration?: { from: number; to: number; backup: string | null; mark: { seq: number; problem: number; by?: 'release' | 'supervisor' } } | null;
}

export interface SupervisorState {
  v: 1;
  pid: number;
  mode: ServerMode;
  since: string;
  server: { pid: number | null; port: number | null; started_at: string | null; restarts: number; last_exit: { code: number | null; signal: string | null; at: string } | null; code: string };
  safe_mode: { reason: string; at: string; last_good: string | null; output: string } | null;
  health: { last_check_at: string | null; last_ok_at: string | null; failing: number; said: string | null };
  // `base_commit`: the commit "base" runs, pinned when the supervisor started (never the
  // checkout as it is on disk now).
  releases: { current: string | null; previous: string | null; last_good: string | null; slots: ReleaseSlot[]; base_commit?: string | null };
  deploy: { version: string; from: string | null; started_at: string; stage: Stage['stage']; stages: Stage[]; canary: { until: string; probes: ProbeLine[] } | null; outcome: 'running' | 'promoted' | 'rolled_back' | 'stopped' | 'refused' | null } | null;
  history: { version: string; from: string | null; at: string; outcome: string; said: string }[];
  // The services the supervisor driver runs besides the console (M10e), as the driver reports them.
  services?: ServiceStatus[];
  observed_at?: string;
  service_policies?: ServicePolicy[];
}

export interface SupervisorProblem { source: string; said: string; playbook: string; subject?: string | null; detail?: string; repairs?: { name: string; ok: boolean; said: string }[] }

export interface SupervisorLink {
  state(): SupervisorState | null;
  request(type: 'deploy' | 'rollback' | 'restart', o?: { version?: string; staged?: boolean }): Promise<{ ok: boolean; said: string }>;
  service?(request: HubServiceRequest): Promise<{ ok: boolean; said: string; accepted?: boolean }>;
  onProblem(fn: (p: SupervisorProblem) => void): void;
  // Where the database stands before any work runs (see `mark` above).
  mark?(m: { seq: number; problem: number }): void;
}

export type HubServiceRequest = { action: 'promote'; service: string; version: string; confirm: string; expected: ServiceExpectedState } | { action: 'rollback'; service: string; confirm: string; expected: ServiceExpectedState };

// The link for a server the supervisor started (server.js passes it to the core), or null.
export function ipcLink(proc: NodeJS.Process, env: NodeJS.ProcessEnv = process.env): SupervisorLink | null {
  if (env.NOVA_SUPERVISED !== '1' || typeof proc.send !== 'function') return null;
  const file = env.NOVA_SUPERVISOR_STATE ?? null;
  const waiting = new Map<string, (r: { ok: boolean; said: string; accepted?: boolean }) => void>();
  const problems: ((p: SupervisorProblem) => void)[] = [];
  let n = 0;
  proc.on('message', (m: unknown) => {
    const msg = m as Record<string, unknown>;
    if (msg?.nova === 'reply' && typeof msg.id === 'string') {
      waiting.get(msg.id)?.({ ok: msg.ok === true, said: String(msg.said ?? ''), ...(msg.accepted === true ? { accepted: true } : {}) });
      waiting.delete(msg.id);
    } else if (msg?.nova === 'problem') {
      for (const fn of problems) fn(msg as unknown as SupervisorProblem);
    }
  });
  // The channel must not keep a stopping server alive.
  (proc.channel as { unref?: () => void } | undefined)?.unref?.();
  const request = (type: string, o: object = {}): Promise<{ ok: boolean; said: string; accepted?: boolean }> => {
    const id = `r${++n}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { waiting.delete(id); resolve({ ok: false, said: 'The supervisor didn’t answer.' }); }, 10_000);
      timer.unref();
      waiting.set(id, (r) => { clearTimeout(timer); resolve(r); });
      try { proc.send!({ nova: 'request', id, type, ...o }); } catch { waiting.delete(id); clearTimeout(timer); resolve({ ok: false, said: 'The supervisor can’t be reached.' }); }
    });
  };
  return {
    state() {
      if (!file) return null;
      try { return JSON.parse(readFileSync(file, 'utf8')) as SupervisorState; } catch { return null; }
    },
    request,
    service(r) {
      return r.action === 'promote' ? request('service-promote', { service: r.service, version: r.version, confirm: r.confirm, expected: r.expected }) : request('service-rollback', { service: r.service, confirm: r.confirm, expected: r.expected });
    },
    onProblem(fn) { problems.push(fn); },
    mark(m) {
      try { proc.send!({ nova: 'mark', seq: m.seq, problem: m.problem }); } catch { /* the supervisor reads it itself then */ }
    },
  };
}

// Shared console projection: the supervisor driver and topology use exactly the same mapping.
export function consoleStatus(s: SupervisorState): ServiceStatus {
  const kind: Record<ReleaseSlot['status'], ServiceStatus['versions'][number]['status']> = { ready: 'ready', live: 'live', previous: 'kept', failed: 'failed', rolled_back: 'rolled_back' };
  const cur = s.releases.current ?? 'base';
  const versions = s.releases.slots.map((r) => ({ version: r.version, status: kind[r.status], since: r.created_at, said: null as string | null, ports: r.version === cur && s.server.port ? { console: s.server.port } : null, pid: r.version === cur ? s.server.pid : null }));
  if (!versions.some((v) => v.version === cur)) versions.unshift({ version: cur, status: 'live', since: s.server.started_at ?? s.since, said: cur === 'base' ? 'The code the supervisor started from.' : null, ports: s.server.port ? { console: s.server.port } : null, pid: s.server.pid });
  return {
    service: 'nova-console', driver: 'supervisor', live: cur, previous: s.releases.previous, soak_until: null,
    held: s.safe_mode ? { reason: s.safe_mode.reason, at: s.safe_mode.at } : null,
    health: { ok: s.health.last_check_at ? s.health.failing === 0 : null, checked_at: s.health.last_check_at, said: s.health.said },
    stable: s.server.port ? { console: s.server.port } : {},
    versions,
    history: s.history.map((h) => ({ at: h.at, version: h.version, outcome: h.outcome, said: h.said })),
  };
}


// Private startup handoff, never an HTTP route or an environment variable. Only the core role
// context is accepted; an old release without broker support explicitly supplies null.
export function ipcBroker(proc: NodeJS.Process, env: NodeJS.ProcessEnv = process.env): Promise<{ socket: string; token: string } | null> {
  if (env.NOVA_SUPERVISED !== '1' || typeof proc.send !== 'function') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const finish = (context: { socket: string; token: string } | null, error?: Error) => {
      clearTimeout(timer); proc.off('message', take); proc.off('disconnect', lost);
      if (error) reject(error); else resolve(context);
    };
    const lost = () => finish(null, new Error('The supervisor disconnected before broker startup.'));
    const take = (m: unknown) => {
      const msg = m as { nova?: unknown; context?: unknown };
      if (msg?.nova !== 'broker') return;
      const c = msg.context as { socket?: unknown; token?: unknown } | null;
      const shape = Object.keys(msg).sort().join() === 'context,nova';
      const context = c === null || (c && typeof c === 'object' && Object.keys(c).sort().join() === 'socket,token'
        && typeof c.socket === 'string' && c.socket.length > 0 && c.socket.length <= 4096 && !c.socket.includes('\0')
        && typeof c.token === 'string' && /^[0-9a-f]{64}$/.test(c.token));
      if (!shape || !context) return finish(null, new Error('Invalid private broker context.'));
      finish(c as { socket: string; token: string } | null);
    };
    const timer = setTimeout(() => finish(null, new Error('The supervisor did not provide broker startup context.')), 5000);
    proc.on('message', take); proc.once('disconnect', lost);
    try { proc.send!({ nova: 'broker-ready' }); } catch { lost(); }
  });
}
```

### `src/core/resilience/reset.ts`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `f490a423b7f32e1c6637b21c4715cad34b512a50`, SHA256 `f47e232fd8e64b52c35df2a6a4b6a5461db601493fa4308a3570c3e32cc26a50`, 714 physical lines (715 under boundary count).

```ts
// Factory reset (M7 amendment §2): Nova back to how it was the first time, on this machine.
//
// The flow: an export is offered first (recommended, never forced): the encrypted-copy format of
// archive.ts under a fresh recovery key shown once, plus the plain memory files, into a folder the
// person names and Nova never creates. It holds no vault, no vault key and no identity, and says so.
//
// Then, confirmed every time from the hub's own screen (tier 3), the reset is staged: a marker in
// the home says exactly what goes, decided while Nova still runs and can tell its own sealed
// backups from strays. Before anything is wiped the hub tells every paired device it can reach:
// a phone or browser on its open stream, a computer in its next heartbeat, the standby in its next
// sync answer (it wipes its copy and reports back). Every session then ends. Nova restarts in place
// (restart.ts: the supervisor, or the server re-executing itself), and at that start
// `finishStaged` (checkpoints.ts) calls `finishReset`, which wipes before anything opens the
// database:
//   1. the vault's key, from the keychain (through the vault's own key abstraction) and its file;
//   2. Nova's own sealed backups and encrypted copies, in every folder it ever backed up to, each
//      checked again against what was recorded (anything changed since is left, and said);
//   3. Nova's own entries in its home, by name (entries.ts). Anything else there is the person's:
//      left in place and listed;
//   4. Nova's leftover scratch folders.
// Then the report (reset-report.json in the new home), and only then the marker goes. A reset
// stopped anywhere in that finishes at the next start; a start that can't finish it doesn't run.
//
// What stays, said before and after: backup folders that aren't there (an unplugged drive), devices
// that couldn't be told, the export, and the supervisor's code releases (code, not data).
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Db } from '../db.ts';
import type { Log } from '../log.ts';
import type { Memory } from '../memory.ts';
import type { Route, Who } from '../api.ts';
import type { Access } from '../mesh/access.ts';
import type { Device, Devices } from '../mesh/devices.ts';
import type { MeshRole } from '../mesh/promote.ts';
import type { ResetNotice } from '../mesh/replica.ts';
import type { Spokes } from '../mesh/spokes.ts';
import { REPLICATED } from '../mesh/sync.ts';
import { ONLINE_WINDOW_MS } from '../mesh/devices.ts';
import { CoreError } from '../errors.ts';
import { Vault, type KeyMode, type KeyStore } from '../vault.ts';
import { encryptDir, readHeader } from './archive.ts';
import { EXCLUDED, backupFiles, folderProblem, formatRecoveryKey, keyFingerprint, sha256File, type FolderKind, type Manifest, type ManifestFile, type NightlyBackups } from './backup.ts';
import { dropScratch, freeScratch, makeScratch } from './scratch.ts';
import { foreignEntries, isNovaEntry } from './entries.ts';
import type { Restarter } from './restart.ts';
import { readMark, rekeyMark, sealOk, sealWith, unsafeHome } from './home-mark.ts';

export const RESET_MARKER = 'factory-reset.json';
export const RESET_REPORT = 'reset-report.json';
export const EXPORT_SAID = 'Your saved passwords and keys aren’t in the export; you’ll add them again.';
export const RELEASES_SAID = 'The supervisor’s code releases stay: they are Nova’s code, not your data.';
export const RELAY_SAID = 'Work handed to Relay stays in Relay’s own storage: erasing Nova doesn’t erase it. Remove it in Relay if you want it gone.';
export const CONFIRM_WORDS = 'I understand this erases Nova on this machine, and I want to start over.';
const CANT_TELL_SAID = 'A device that can’t be reached now can’t be told. Its copy stays on that device until it is reset or removed there. The hub’s identity is gone either way, so it can never reconnect to the new Nova.';
const NOTICE_SAID = 'The hub was reset: Nova there was erased and starts over. This device is no longer paired with it.';
const DEFAULT_TELL_MS = 45_000;

// Nova's own entries at the top of its home are listed once, in entries.ts (NOVA_ENTRIES): the
// wipe takes those by name and nothing else.
const SQLITE_SIDE = /^nova\.db-/;

// What the export leaves out, and why (shown in its manifest and README).
const EXPORT_SKIP: Record<string, string> = {
  vault: 'vault/: your saved passwords and keys, and the vault’s key, aren’t in the export; you’ll add them again',
  mesh: 'mesh/: this hub’s identity stays out; a new Nova makes its own',
};

export interface DeviceLine { id: string; name: string; kind: string; said: string }
// `partial`: a backup or copy left half-written (it holds the database in the clear).
export interface BackupItem { path: string; folder: string; kind: FolderKind | 'partial'; check: string | null }
export interface Unreachable { folder: string; kind: FolderKind; said: string }

interface Marker {
  v: 1;
  id: string;
  // A hub erases itself; a standby erases the copy of a hub that was reset.
  kind: 'hub' | 'standby';
  home: string;
  staged_at: string;
  version: string;
  vault_ids: string[];
  own: string[];
  backups: BackupItem[];
  strays: string[];
  unreachable: Unreachable[];
  devices: { told: DeviceLine[]; not_told: DeviceLine[] } | null;
  export: string | null;
  // Said when Relay was on or used: its work stays in Relay.
  relay?: string | null;
  // An HMAC of everything above under the key in the home's mark (home-mark.ts): a marker Nova
  // didn't write, or one changed since, is never acted on.
  seal?: string;
}

const body = (m: Marker) => { const { seal: _s, ...rest } = m as Marker & { sum?: unknown }; delete (rest as { sum?: unknown }).sum; return JSON.stringify(rest); };

// The marker, sealed, written whole (beside, then renamed into place). Throws when the home
// carries no mark: then it is no home Nova may erase.
function writeMarker(home: string, m: Marker): void {
  const mark = readMark(home);
  if (!mark) throw new CoreError('conflict', `${home} doesn’t carry Nova’s mark (${'.nova-home'}), so Nova won’t erase it. Start Nova again (it marks a home it set up), then erase it from Settings.`);
  m.seal = sealWith(mark, body(m));
  writeJson(join(home, RESET_MARKER), m);
}

// Why a marker can't be acted on, or null when it is one Nova wrote for this home.
function unverified(home: string, m: Marker | null): string | null {
  if (!m || m.v !== 1 || typeof m.home !== 'string') return 'it can’t be read';
  const unsafe = unsafeHome(home);
  if (unsafe) return unsafe;
  const mark = readMark(home);
  if (!mark) return 'this folder doesn’t carry Nova’s mark';
  if (!sealOk(mark, body(m), m.seal)) return 'Nova didn’t write it, or it changed since';
  if (!sameFolder(home, m.home)) return 'it was made for another folder';
  return null;
}

function sameFolder(a: string, b: string): boolean {
  try { return realpathSync(a) === realpathSync(b); } catch { return resolve(a) === resolve(b); }
}

export interface ResetReport {
  v: 1;
  id: string;
  kind: 'hub' | 'standby';
  staged_at: string;
  finished_at: string;
  version: string;
  wiped: { home: string[]; keychain: string | null; key_file: boolean; backups: string[]; folders: string[]; scratch: number };
  left: { foreign: string[]; before: string[]; relay: string | null; unreachable: Unreachable[]; strays: string[]; changed: string[]; releases: string; export: string | null; export_gone: string | null; keychain: string | null };
  devices: { told: DeviceLine[]; not_told: DeviceLine[] };
  said: string;
}

// ---- the home ----------------------------------------------------------------------------------

// Nova's own entries in the home (entries.ts), and everything else (the person's), by top-level
// name. The marker is neither: it goes last, once the report is written.
// `before`: entries named like Nova's that were already in the folder when Nova was first pointed
// at it (home-mark.ts). They are the person's: never erased, and said.
export function homeEntries(home: string): { own: string[]; foreign: string[]; before: string[] } {
  let names: string[] = [];
  try { names = readdirSync(home).sort(); } catch { /* no home yet */ }
  const first = new Set(readMark(home)?.before ?? []);
  return {
    own: names.filter((n) => n !== RESET_MARKER && isNovaEntry(n) && !first.has(n)),
    foreign: foreignEntries(home),
    before: names.filter((n) => isNovaEntry(n) && first.has(n)),
  };
}

const inside = (path: string, root: string) => {
  const r = relative(resolve(root), resolve(path));
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r));
};

function writeJson(path: string, data: unknown): void {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export function readReport(home: string): ResetReport | null {
  try { return JSON.parse(readFileSync(join(home, RESET_REPORT), 'utf8')) as ResetReport; } catch { return null; }
}

// ---- finishing, at start ----------------------------------------------------------------------

// Only an authenticated, own broker entry can be cleaned by the supervisor.
export function supervisorResetPending(home: string): { seal: string; broker: boolean } | null {
  try {
    const m = JSON.parse(readFileSync(join(home, RESET_MARKER), 'utf8')) as Marker;
    return !unverified(home, m) ? { seal: m.seal!, broker: homeEntries(home).own.includes('broker') } : null;
  } catch { return null; }
}

export interface FinishOptions {
  // Trusted supervisor only, after owned shutdown and broker-owned key removal completed.
  brokerCleaned?: string;
  // Where the vault's key lives (as the core is given it): the keychain is reached the vault's way.
  vault?: { mode?: KeyMode; keychain?: ((account: string) => KeyStore | null) | null };
  // Called before each step ("keychain", "backup:<path>", "home:<name>", "scratch", "report"):
  // tests stop a reset part way through here, as a power cut would.
  step?: (what: string) => void;
  scratchRoot?: string;
  now?: () => Date;
  // A marker that doesn't verify: told here (the core opens a problem), kept aside, never acted on.
  problem?: (said: string) => void;
  // Leave an unverified marker where it is (server.js, before seeding: the core reports it).
  leaveUnverified?: boolean;
}

// Finishes a staged reset, before anything opens the database. Null when none is staged. Throws
// when it can't finish: a half-reset Nova never runs.
export function finishReset(home: string, o: FinishOptions = {}): ResetReport | null {
  const file = join(home, RESET_MARKER);
  if (!existsSync(file)) return null;
  let m: Marker | null = null;
  try { m = JSON.parse(readFileSync(file, 'utf8')) as Marker; } catch { /* below */ }
  // Verified before anything is acted on: only a marker Nova sealed for this home, which is Nova's
  // alone. Anything else is never acted on: it is kept aside and said, and Nova starts as it was.
  const why = unverified(home, m);
  if (why) {
    // Stopped after the reset was done (its report written, the mark re-keyed) but before the
    // marker went: nothing is left to do but remove it.
    const done = readReport(home);
    if (m && typeof m.id === 'string' && done?.id === m.id && typeof m.home === 'string' && sameFolder(home, m.home)) { rmSync(file, { force: true }); return null; }
    if (o.leaveUnverified) return null;
    const aside = `${file}.set-aside-${(o.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-')}`;
    renameSync(file, aside);
    o.problem?.(`Nova found a note asking to erase it that Nova didn’t write (${why}), so it erased nothing and started as it was. The note is kept aside as ${aside}. If you want Nova erased, do it from Settings › Danger zone on the hub’s own screen.`);
    return null;
  }
  m = m!;
  if (homeEntries(home).own.includes('broker') && o.brokerCleaned !== m.seal) throw new Error('The broker needs supervisor cleanup before factory reset.');
  const step = o.step ?? (() => {});
  const now = o.now ?? (() => new Date());

  // 1. The vault's key, wherever it is.
  step('keychain');
  const vault = new Vault({ home, ...(o.vault?.mode ? { mode: o.vault.mode } : {}), ...(o.vault && 'keychain' in o.vault ? { keychain: o.vault.keychain ?? null } : {}) });
  const key = vault.forgetKeys(m.vault_ids ?? []);

  // 2. Nova's own backups, each checked again against what was recorded when it was staged.
  const wipedBackups: string[] = [];
  const changed: string[] = [];
  for (const b of m.backups ?? []) {
    step(`backup:${b.path}`);
    const state = backupState(b);
    if (state === 'changed') { changed.push(b.path); continue; }
    if (state === 'same') rmSync(b.path, { recursive: true, force: true });
    wipedBackups.push(b.path);
  }

  // 3. Nova's own entries in the home, by name; the marker last, after the report.
  const { own, foreign, before } = homeEntries(home);
  for (const name of own) {
    if (name === RESET_REPORT) continue;
    step(`home:${name}`);
    rmSync(join(home, name), { recursive: true, force: true });
  }

  // 4. Nova's leftover scratch (a drill's restored home, an opened copy): never another running
  // process's (scratch.ts).
  step('scratch');
  const scratch = freeScratch(o.scratchRoot).deleted.length;

  step('report');
  const devices = m.devices ?? { told: [], not_told: [] };
  const folders = [...new Set(wipedBackups.map((p) => resolve(p, '..')))].sort();
  const report: ResetReport = {
    v: 1, id: m.id, kind: m.kind, staged_at: m.staged_at, finished_at: now().toISOString(), version: m.version,
    wiped: { home: [...new Set([...(m.own ?? []), ...own.filter((n) => n !== RESET_REPORT)])].sort(), keychain: key.keychain, key_file: key.file, backups: wipedBackups, folders, scratch },
    left: { foreign, before, relay: m.relay ?? null, unreachable: m.unreachable ?? [], strays: m.strays ?? [], changed, releases: RELEASES_SAID, export: m.export && existsSync(m.export) ? m.export : null, export_gone: m.export && !existsSync(m.export) ? m.export : null, keychain: key.problem },
    devices,
    said: '',
  };
  report.said = summary(report);
  writeJson(join(home, RESET_REPORT), report);
  // Nothing sealed before the reset opens again.
  rekeyMark(home);
  rmSync(file, { force: true });
  return report;
}

// Whether a recorded backup is still the one Nova made: the same seal (a folder) or the same
// header (an encrypted copy). Gone already counts as done (a reset that was stopped part way).
function backupState(b: BackupItem): 'same' | 'gone' | 'changed' {
  if (!existsSync(b.path)) return 'gone';
  try {
    if (b.kind === 'partial') return 'same';
    if (b.kind === 'folder') {
      const seal = (JSON.parse(readFileSync(join(b.path, 'manifest.json'), 'utf8')) as Manifest).seal ?? null;
      return seal && seal === b.check ? 'same' : 'changed';
    }
    return sha256File(b.path) === b.check ? 'same' : 'changed';
  } catch {
    return 'changed';
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function summary(r: ResetReport): string {
  const parts = [r.kind === 'standby'
    ? 'This standby’s copy of a hub that was reset is erased.'
    : 'Nova was erased on this machine and started over.'];
  const wiped = [`${plural(r.wiped.home.length, 'of Nova’s own entry', 'of Nova’s own entries')} in its home`];
  if (r.wiped.keychain) wiped.push(`the vault’s key in ${r.wiped.keychain}`);
  if (r.wiped.backups.length) wiped.push(`${plural(r.wiped.backups.length, 'backup')} in ${plural(r.wiped.folders.length, 'folder')}`);
  parts.push(`Erased: ${wiped.join(', ')}.`);
  if (r.left.foreign.length) parts.push(`Left in place, because they aren’t Nova’s: ${r.left.foreign.join(', ')}.`);
  if (r.left.before?.length) parts.push(`Already here before Nova, so left alone: ${r.left.before.join(', ')}.`);
  for (const u of r.left.unreachable) parts.push(u.said);
  if (r.left.changed.length) parts.push(`Left because they changed since the reset was asked for: ${r.left.changed.join(', ')}.`);
  if (r.devices.told.length) parts.push(`Told: ${r.devices.told.map((d) => d.name).join(', ')}.`);
  if (r.devices.not_told.length) parts.push(`Couldn’t be told: ${r.devices.not_told.map((d) => d.name).join(', ')}. Their copy stays on them until they are reset or removed there.`);
  if (r.left.export) parts.push(`Your export is in ${r.left.export}, untouched.`);
  if (r.left.export_gone) parts.push(`Your export at ${r.left.export_gone} isn’t there any more: Nova didn’t erase it on purpose, but it is gone. If you need it, look for another copy.`);
  if (r.left.keychain) parts.push(r.left.keychain);
  if (r.left.relay) parts.push(r.left.relay);
  if (r.kind === 'hub') parts.push(RELEASES_SAID);
  return parts.join(' ');
}

// ---- while Nova runs: the preview, the export, staging and telling ------------------------------

export interface ResetOptions {
  home: string;
  db: Db;
  log: Log;
  version: string;
  now: () => Date;
  vault: Vault;
  nightly: NightlyBackups;
  memory: Memory;
  devices: Devices;
  access: Access;
  spokes: Spokes;
  role: MeshRole;
  // The core's event bus: every open stream hears "reset".
  emit: (event: string, data: unknown) => void;
  // The restart in place (restart.ts) that finishes the reset: under the supervisor, or the server
  // re-executing itself. Without one (a core in a test) the marker waits for the next start.
  restarter: Pick<Restarter, 'available' | 'restartInPlace'> | null;
  // How long the hub waits for devices it can reach to hear it.
  tellMs?: number;
  // Stops every worker and child process (core.stopWork), so nothing writes while Nova erases.
  stopWork?: (boundMs: number) => Promise<void>;
  // A checkpoint's restore is staged (checkpoints.ts): a reset waits until it is done.
  restorePending?: () => boolean;
  // Whether first-run setup is done (after it, nothing more is cleared in browsers).
  setupDone?: () => boolean;
  // Whether the Relay provider is on, or was ever handed work.
  relayUsed?: () => boolean;
}

export interface Preview {
  wipes: { home: string[]; keychain: string | null; backups: { folder: string; kind: FolderKind; count: number }[] };
  keeps: { foreign: string[]; before: string[]; relay: string | null; unreachable: Unreachable[]; strays: string[]; releases: string; export: string | null };
  devices: { can_tell: Omit<DeviceLine, 'said'>[]; cant_tell: Omit<DeviceLine, 'said'>[]; cant_tell_said: string };
  export_said: string;
  confirm: string;
  staged: boolean;
  // While staged: where it stands, in plain words (for the screen).
  staged_said: string | null;
}

export const NEXT_START_SAID = 'Nova finishes erasing itself when Nova starts next. Until then it takes nothing new.';

export class FactoryReset {
  #o: ResetOptions;
  // The last export this process made: the reset's result says where it is.
  #export: string | null = null;
  #staging = false;
  #stagedSaid: string | null = null;

  constructor(o: ResetOptions) {
    this.#o = o;
  }

  staged(): boolean {
    return this.#staging || existsSync(join(this.#o.home, RESET_MARKER));
  }

  report(): ResetReport | null {
    return readReport(this.#o.home);
  }

  // After a reset, the hub's own screen is told once (per reset) to clear what its browser kept of
  // the Nova that was erased, until setup is done. Never a paired device: its new key would go.
  clearHeaders(p: { kind: string }, cookie: string | undefined): Record<string, string> {
    if (p.kind !== 'console') return {};
    const r = this.report();
    if (!r || this.#o.setupDone?.()) return {};
    const seen = /(?:^|;\s*)nova-reset-cleared=([^;\s]+)/.exec(cookie ?? '')?.[1];
    if (seen === r.id) return {};
    return { 'clear-site-data': '"cache", "storage"', 'set-cookie': `nova-reset-cleared=${r.id}; Path=/; Max-Age=31536000; SameSite=Strict; HttpOnly` };
  }

  // What a reset would wipe and what it would leave, for the confirmation.
  preview(): Preview {
    const { own, foreign, before } = homeEntries(this.#o.home);
    const b = this.#backups();
    const by = new Map<string, { folder: string; kind: FolderKind; count: number }>();
    for (const x of b.items) {
      if (x.kind === 'partial') continue;
      const k = `${x.kind}\0${x.folder}`;
      const v = by.get(k) ?? { folder: x.folder, kind: x.kind, count: 0 };
      v.count++;
      by.set(k, v);
    }
    const d = this.#reach();
    let keychain: string | null = null;
    try { const s = this.#o.vault.status(); keychain = s.key === 'keychain' ? s.where : null; } catch { /* a vault that won't open: its key still goes */ }
    return {
      wipes: { home: own.filter((n) => n !== RESET_REPORT), keychain, backups: [...by.values()] },
      keeps: { foreign, before, relay: this.#o.relayUsed?.() ? RELAY_SAID : null, unreachable: b.unreachable, strays: b.strays, releases: RELEASES_SAID, export: this.#export },
      devices: { can_tell: d.can.map(line), cant_tell: d.cant.map(line), cant_tell_said: CANT_TELL_SAID },
      export_said: EXPORT_SAID,
      confirm: CONFIRM_WORDS,
      staged: this.staged(),
      staged_said: this.staged() ? this.#stagedSaid ?? 'Nova is telling your devices, then erasing itself and starting over.' : null,
    };
  }

  // Every folder Nova ever backed up to: its own sealed backups there (to wipe), the strays (left),
  // and the folders that aren't there now (said, and left).
  #backups(): { items: BackupItem[]; strays: string[]; unreachable: Unreachable[] } {
    const items: BackupItem[] = [];
    const strays: string[] = [];
    const unreachable: Unreachable[] = [];
    const n = this.#o.nightly;
    for (const f of n.folders()) {
      if (!n.reachable(f.folder, f.kind)) {
        const what = f.kind === 'folder' ? 'backup folder' : 'folder for the encrypted copies';
        unreachable.push({ folder: f.folder, kind: f.kind, said: `The ${what} ${f.folder} isn’t there (a drive unplugged?), so the backups in it can’t be erased. They stay there until you delete them.` });
        continue;
      }
      const r = n.inFolder(f.folder, f.kind);
      strays.push(...r.strays);
      for (const x of r.found) {
        if (f.kind === 'folder') { items.push({ path: x.path, folder: f.folder, kind: f.kind, check: x.seal }); continue; }
        // An encrypted copy counts only if it opens under the backup key: a name and an unsigned
        // header are not enough. It is then known by its whole file's hash.
        if (n.authentic(x.path)) items.push({ path: x.path, folder: f.folder, kind: f.kind, check: sha256File(x.path) });
        else strays.push(x.path);
      }
      // Half-written ones Nova left (a backup that was stopped): the database in the clear.
      let names: string[] = [];
      try { names = readdirSync(f.folder); } catch { /* checked above */ }
      for (const e of names) if (f.kind === 'folder' ? /^\.nova-backup-\d+\.partial$/.test(e) : /^nova-backup-\d+\.nbk\.partial$/.test(e)) items.push({ path: join(f.folder, e), folder: f.folder, kind: 'partial', check: null });
    }
    return { items, strays, unreachable };
  }

  // Who can be told now: the standby while it copies, a computer heard from lately (it hears at
  // its next heartbeat), a phone or browser with its stream open. The rest can't.
  #reach(): { can: Device[]; cant: Device[] } {
    const me = this.#o.devices.identity.id;
    const now = this.#o.now().getTime();
    const recent = (d: Device) => !!d.last_seen && now - Date.parse(d.last_seen) < ONLINE_WINDOW_MS;
    const can: Device[] = [];
    const cant: Device[] = [];
    for (const d of this.#o.devices.list()) {
      if (d.id === me || d.trust !== 'trusted') continue;
      const live = this.#o.access.isLive(d.id);
      const ok = d.kind === 'phone' || d.kind === 'browser' ? live : live || recent(d);
      (ok ? can : cant).push(d);
    }
    return { can, cant };
  }

  // ---- the export --------------------------------------------------------------------------------

  // Into a folder of the person's (which must already exist, outside Nova's home): the database
  // snapshot and the home's files, encrypted under a fresh recovery key, and the memory in plain
  // files. The key is returned here once and kept nowhere.
  exportTo(folder: unknown) {
    if (typeof folder !== 'string' || !folder.trim() || !isAbsolute(folder.trim())) throw new CoreError('validation', 'folder is the full path of a folder of yours, like /media/drive/nova-export.');
    const dir = resolve(folder.trim());
    let isDir = false;
    try { isDir = statSync(dir).isDirectory(); } catch { /* not there */ }
    if (!isDir) throw new CoreError('validation', `${dir} isn’t a folder Nova can see. Make it first (or plug in its drive): Nova never creates the folder for an export.`);
    const realDir = realpathSync(dir);
    const realHome = realpathSync(this.#o.home);
    if (inside(realDir, realHome) || inside(realHome, realDir)) throw new CoreError('validation', 'The export can’t go inside Nova’s home or contain it (where it really is, following links): erasing Nova would take it too.');
    const unsafe = folderProblem(dir);
    if (unsafe) throw new CoreError('validation', unsafe.replaceAll('backups', 'files'));
    const at = this.#o.now();
    const stamp = at.toISOString().replace(/[:.]/g, '-');
    const id = `nova-export-${stamp}`;
    const out = join(realDir, id);
    if (existsSync(out)) throw new CoreError('conflict', `${out} is already there. Wait a moment and export again.`);
    const key = randomBytes(32);
    const scratch = makeScratch('export');
    const stage = join(scratch, 'export');
    const file = join(out, 'nova-export.nbk');
    try {
      mkdirSync(join(stage, 'files'), { recursive: true, mode: 0o700 });
      const snap = join(stage, 'nova.db');
      this.#o.db.raw.exec(`VACUUM INTO '${snap.replaceAll("'", "''")}'`);
      const files: ManifestFile[] = [];
      for (const rel of backupFiles(this.#o.home)) {
        if (Object.keys(EXPORT_SKIP).some((p) => rel === p || rel.startsWith(`${p}/`))) continue;
        const dst = join(stage, 'files', rel);
        mkdirSync(join(dst, '..'), { recursive: true, mode: 0o700 });
        try { copyFileSync(join(this.#o.home, rel), dst); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
        files.push({ path: rel, sha256: sha256File(dst), bytes: statSync(dst).size });
      }
      const d = new DatabaseSync(snap, { readOnly: true });
      let migrations: Manifest['migrations'];
      try { migrations = d.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as unknown as Manifest['migrations']; } finally { d.close(); }
      const manifest: Manifest = {
        v: 1, id, seq: 0, at: at.toISOString(), nova_version: this.#o.version, schema_version: migrations.at(-1)?.version ?? 0, migrations,
        db: { path: 'nova.db', sha256: sha256File(snap), bytes: statSync(snap).size }, files,
        excluded: [...Object.values(EXPORT_SKIP), ...EXCLUDED.filter((x) => !/^(vault\/key|mesh\/identity\.json):/.test(x))], cleaned: [],
      };
      writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      mkdirSync(out, { mode: 0o700 });
      chmodSync(out, 0o700);
      encryptDir(stage, file, key, { id, seq: 0, at: at.toISOString() });
      const mem = this.#o.memory.export({ dir: out });
      for (const f of [mem.json, mem.markdown]) chmodSync(f, 0o600);
      writeFileSync(join(out, 'README.txt'), readme(id, manifest), { mode: 0o600 });
    } catch (e) {
      rmSync(out, { recursive: true, force: true });
      const full = (e as NodeJS.ErrnoException).code === 'ENOSPC' || /SQLITE_FULL|disk is full/i.test((e as Error).message);
      throw new CoreError('conflict', full ? `The export stopped: the disk ${dir} is on is full. Nothing was erased.` : `The export stopped: ${(e as Error).message}. Nothing was erased.`);
    } finally {
      dropScratch(scratch);
    }
    this.#export = out;
    this.#o.log.info('reset', 'Exported everything before a reset.', { folder: out, key: keyFingerprint(key) });
    return {
      folder: out, file, memory: { json: join(out, 'memory.json'), markdown: join(out, 'memory.md') },
      recovery_key: formatRecoveryKey(key), key_fingerprint: keyFingerprint(key),
      said: `Exported to ${out}. This recovery key opens it, on any machine: keep it somewhere other than this computer. It is shown only now. ${EXPORT_SAID}`,
      left_out: Object.values(EXPORT_SKIP),
    };
  }

  // ---- staging and telling --------------------------------------------------------------------

  // Stages the reset (tier 3: the hub's own screen, confirmed every time), tells the devices it can
  // reach, ends every session, and restarts in place. `done` settles once the devices are told.
  stage(o: { confirm: unknown; who: Who }): { staged: true; id: string; restart: 'in-place' | 'next-start'; said: string; done: Promise<{ told: DeviceLine[]; not_told: DeviceLine[] }> } {
    hubScreen(o.who);
    if (o.confirm !== true) throw new CoreError('validation', `Erasing Nova needs your explicit confirmation every time (confirm: true): “${CONFIRM_WORDS}”`);
    if (this.#o.role.role() !== 'hub') throw new CoreError('conflict', 'This is the standby. Reset the hub: it tells this node to wipe its copy.');
    if (this.staged()) throw new CoreError('conflict', 'Nova is already erasing itself.');
    if (this.#o.restorePending?.()) throw new CoreError('conflict', 'A restore is staged and finishes when Nova restarts. Erase Nova after that.');
    const unsafe = unsafeHome(this.#o.home);
    if (unsafe) throw new CoreError('conflict', `Nova won’t erase this home: ${unsafe}. Move Nova’s home to a folder of its own first.`);
    const b = this.#backups();
    const { own } = homeEntries(this.#o.home);
    const m: Marker = {
      v: 1, id: randomUUID(), kind: 'hub', home: resolve(this.#o.home), staged_at: this.#o.now().toISOString(), version: this.#o.version,
      vault_ids: this.#o.vault.keyIds(), own: own.filter((n) => n !== RESET_REPORT), backups: b.items, strays: b.strays, unreachable: b.unreachable,
      devices: null, export: this.#export, relay: this.#o.relayUsed?.() ? RELAY_SAID : null,
    };
    writeMarker(this.#o.home, m);
    this.#staging = true;
    this.#o.log.info('reset', 'A factory reset is staged; telling devices first.', { id: m.id });
    const done = (async () => {
      // Nothing keeps working, so nothing new is made while Nova is told to erase: the heartbeat,
      // the work queue and every child process stop first. A backup that finished in the meantime
      // is then listed too.
      await this.#o.stopWork?.(5000);
      const again = this.#backups();
      const seen = new Set(m.backups.map((x) => x.path));
      m.backups.push(...again.items.filter((x) => !seen.has(x.path)));
      m.strays = [...new Set([...m.strays, ...again.strays])];
      writeMarker(this.#o.home, m);
      return this.#tell(m);
    })().then(async (devices) => {
      m.devices = devices;
      writeMarker(this.#o.home, m);
      // Every session ends, and whatever devices hold open closes.
      this.#o.db.run('DELETE FROM device_session');
      for (const d of this.#o.devices.list()) this.#o.access.close(d.id);
      this.#o.spokes.resetNotice = null;
      this.#o.role.resetNotice = null;
      // Restart in place: the next start finishes the wipe before the database opens. A restart
      // that fails doesn't undo anything: the person confirmed an erase, so it finishes when Nova
      // starts next, and until then Nova takes nothing new (blocks()).
      if (this.#canRestart()) {
        try { await this.#o.restarter!.restartInPlace('a factory reset'); } catch (e) {
          this.#stagedSaid = `Nova couldn’t restart itself (${(e as Error).message}). ${NEXT_START_SAID}`;
          this.#o.log.problem('reset', `Nova couldn’t restart itself to finish erasing. ${NEXT_START_SAID}`, { detail: (e as Error)?.stack ?? String(e), stops: true });
        }
      } else this.#stagedSaid = NEXT_START_SAID;
      return devices;
    });
    return {
      staged: true, id: m.id, restart: this.#canRestart() ? 'in-place' : 'next-start',
      said: this.#canRestart() ? 'Nova is telling your devices, then erasing itself and starting over.' : 'Nova is telling your devices. It finishes erasing itself the next time it starts.',
      done,
    };
  }

  // Tells every device it can reach, and waits (up to tellMs) for each to hear it.
  async #tell(m: Marker): Promise<{ told: DeviceLine[]; not_told: DeviceLine[] }> {
    const notice: ResetNotice = { id: m.id, said: NOTICE_SAID };
    const { can, cant } = this.#reach();
    const told = new Map<string, DeviceLine>();
    let settle: () => void = () => {};
    const all = new Promise<void>((r) => { settle = r; });
    const check = () => { if (can.every((d) => told.has(d.id))) settle(); };
    const hear = (d: Device, said: string) => { if (can.some((c) => c.id === d.id) && !told.has(d.id)) { told.set(d.id, { ...line(d), said }); check(); } };
    this.#ack = (d, said) => hear(d, said);
    // A computer hears it in its next heartbeat; the standby in its next sync answer.
    this.#o.spokes.resetNotice = { ...notice, told: (d) => hear(d, 'Told at its heartbeat; its session ended.') };
    this.#o.role.resetNotice = notice;
    // Phones and browsers with a stream open hear it there, now.
    this.#o.emit('reset', notice);
    for (const d of can) if ((d.kind === 'phone' || d.kind === 'browser') && this.#o.access.isLive(d.id)) hear(d, 'Told on its open connection, and asked to forget its key and what it kept offline; its session ended. Nova can’t confirm it did.');
    check();
    const ms = this.#o.tellMs ?? DEFAULT_TELL_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([all, new Promise<void>((r) => { timer = setTimeout(r, ms); })]);
    if (timer) clearTimeout(timer);
    this.#ack = null;
    const notTold = [
      ...can.filter((d) => !told.has(d.id)).map((d) => ({ ...line(d), said: 'It didn’t answer in time, so it wasn’t told. Its copy stays on it until it is reset or removed there.' })),
      ...cant.map((d) => ({ ...line(d), said: 'It couldn’t be reached, so it wasn’t told. Its copy stays on it until it is reset or removed there.' })),
    ];
    return { told: [...told.values()], not_told: notTold };
  }

  #ack: ((d: Device, said: string) => void) | null = null;

  #canRestart(): boolean {
    return !!this.#o.restarter?.available;
  }

  // ---- on a standby: the hub was reset -----------------------------------------------------------

  // Wipes this standby's copy of the hub's data now (every replicated row, the vault and its key,
  // the copied files), stages the rest (its identity and role) for its next start, and returns
  // what it did, for the hub's result.
  async standbyWipe(notice: ResetNotice): Promise<string> {
    const home = this.#o.home;
    const { own } = homeEntries(home);
    const m: Marker = {
      v: 1, id: notice.id, kind: 'standby', home: resolve(home), staged_at: this.#o.now().toISOString(), version: this.#o.version,
      vault_ids: this.#o.vault.keyIds(), own: own.filter((n) => n !== RESET_REPORT), backups: [], strays: [], unreachable: [], devices: null, export: null,
    };
    writeMarker(home, m);
    this.#staging = true;
    await this.#o.stopWork?.(5000);
    const db = this.#o.db;
    let rows = 0;
    db.tx(() => {
      db.raw.exec('PRAGMA defer_foreign_keys = ON');
      for (const t of [...Object.keys(REPLICATED), 'sync_log']) rows += Number(db.raw.prepare(`DELETE FROM "${t}"`).run().changes);
    });
    // Nothing of it left in the file's free pages or the write-ahead log.
    db.raw.exec('VACUUM');
    db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.#o.vault.forgetKeys();
    this.#o.vault.clear();
    const keep = new Set(['mesh', 'logs', 'nova.pid', RESET_REPORT]);
    for (const n of own) if (!keep.has(n) && n !== 'nova.db' && !SQLITE_SIDE.test(n)) rmSync(join(home, n), { recursive: true, force: true });
    this.#o.log.info('reset', 'The hub was reset: this standby wiped its copy.', { id: notice.id, rows });
    // Once its report has gone back to the hub, it restarts to finish (its keys and role file).
    if (this.#canRestart()) setTimeout(() => { void this.#o.restarter!.restartInPlace('the hub was reset').catch(() => {}); }, 1000).unref?.();
    return `It wiped its copy: ${plural(rows, 'record')}, the vault and the copied files. Its own keys go when it next starts.`;
  }

  // ---- routes ---------------------------------------------------------------------------------

  routes(): Route[] {
    return [
      {
        method: 'GET', path: '/reset', summary: 'What a factory reset would erase and what it would leave: Nova’s own entries in its home, the vault’s key, its backups in every folder it used (and folders that aren’t there), devices it can and can’t tell, and the person’s own files. The hub’s own screen only.',
        handle: ({ who }) => { hubScreen(who); return this.preview(); },
      },
      {
        method: 'POST', path: '/reset/export', status: 201, summary: 'Export everything before a reset, into a folder of yours that already exists, outside Nova’s home: encrypted under a new recovery key shown once in this reply, plus memory.json and memory.md in plain text. Saved passwords, keys and this hub’s identity stay out. The hub’s own screen only.',
        body: '{folder}', handle: ({ body, who }) => { hubScreen(who); return this.exportTo(body.folder); },
      },
      {
        method: 'POST', path: '/reset', status: 202, summary: 'Erase Nova on this machine and start over (tier 3: {confirm: true}, every time, the hub’s own screen only). Devices it can reach are told first; then Nova restarts in first-run setup.',
        body: '{confirm}',
        handle: ({ body, who }) => {
          const { done, ...r } = this.stage({ confirm: body.confirm, who });
          done.catch((e) => this.#o.log.problem('reset', 'The factory reset stumbled while telling devices; it finishes when Nova next starts.', { detail: (e as Error)?.stack ?? String(e) }));
          return r;
        },
      },
      { method: 'GET', path: '/reset/report', summary: 'What the last factory reset did, for the first-run screen, or null. The hub’s own screen only.', handle: ({ who }) => { hubScreen(who); return this.report(); } },
      {
        method: 'POST', path: '/mesh/reset/ack', access: 'sync', summary: 'The standby says it wiped its copy of a hub that is being reset.', body: '{id, said}',
        handle: ({ body, who }) => {
          if (who.principal.kind !== 'device' || who.principal.device.kind !== 'standby') throw new CoreError('forbidden', 'Only the standby reports this.');
          if (!this.#ack || body.id !== this.#o.role.resetNotice?.id) throw new CoreError('conflict', 'No reset is waiting for that.');
          this.#ack(who.principal.device, typeof body.said === 'string' && body.said.trim() ? body.said.trim().slice(0, 300) : 'It wiped its copy.');
          return { ok: true };
        },
      },
    ];
  }

  // While a reset is staged nothing new is taken: only what telling devices needs gets through.
  blocks(method: string | undefined, path: string): string | null {
    if (!this.staged() || method === 'GET' || method === 'HEAD') return null;
    if (['/api/v1/mesh/reset/ack', '/api/v1/mesh/session', '/api/v1/mesh/sync/ack', '/api/v1/mesh/devices/me/heartbeat'].includes(path)) return null;
    return 'Nova is erasing itself and starting over, so it takes nothing new now.';
  }
}

const line = (d: Device): DeviceLine => ({ id: d.id, name: d.name, kind: d.kind, said: '' });

function hubScreen(who: Who): void {
  if (who.principal.kind !== 'console') throw new CoreError('forbidden', 'Erasing Nova, and the export before it, happen on the hub’s own screen only.');
}

function readme(id: string, m: Manifest): string {
  return [
    `Nova export ${id}`,
    '',
    'nova-export.nbk holds Nova’s database and its home’s files, encrypted (AES-256-GCM). It opens with',
    'the recovery key Nova showed you once when it made this export; Nova kept no copy of that key.',
    'memory.json and memory.md are what Nova remembered, in plain text.',
    '',
    'Not in this export:',
    ...m.excluded.filter((x) => /^(vault|mesh)\//.test(x)).map((x) => `- ${x}`),
    '',
    'A factory reset never touches this folder.',
    '',
  ].join('\n');
}
```

### `src/core/services/definition.ts`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `a5f556a6f99e7ed3ef8186f5bff53fe01c572f38`, SHA256 `4bb9b593b8e332065064c699167c33fae228bd65a3f28429c0968342caf69121`, 257 physical lines (258 under boundary count).

```ts
// A service definition (docs/plans/M10-orchestration.md, "The service definition"): one JSON file per
// service and version, the one format every driver reads. The supervisor driver (M10e) runs its
// `program` as a plain program; the K3s driver (M10j) will run its `image` as pods. Enabling K3s
// changes where a service runs, never what it is.
//
// How it maps to the `nova-service` chart's values (rendered by the K3s driver, M10j; nothing here
// renders them), next to what the supervisor driver does with each field:
//
//   service, version   release <service>; a Deployment per version  | one slot per version
//   artifact.image     image.repository, image.digest                | refused for now (no Docker runs)
//   artifact.program   not rendered                                  | installed and started by the supervisor
//   ports              service.ports; a stable and a preview Service | a stable port forwarded by the supervisor
//   health             readiness and liveness probes                 | the supervisor's health loop
//   contract_tests     not rendered; Nova runs them on the preview   | Nova runs them on the new port
//   placement pinned   nodeSelector nova/device=<id>                 | that device (this hub only, for now)
//   placement other    affinity, failover rule, replicas, spread     | the resolver (services/placement.ts)
//   roles, needs       nodeSelector nova/role-<role>, gpu labels     | the device's roles and hardware
//   resources          requests and limits                           | refused if this machine can't fit it
//   state              a local-path volume                           | a folder under the service's own folder
//   secrets            names; the Secret made at apply, never in git | refused for now (no vault hand-off)
//   live version       live: <version>                               | where the stable port points
//   soak_s             the previous Deployment kept at 0 replicas    | the previous slot kept, stopped
//
// The command (ADR Point 6: "the command a workload starts with is part of its signed manifest,
// never an argument to a verb"): what runs is the pinned artifact and nothing else. A command is
// either the artifact itself (`<name> args…` or `./<name> args…`, `<name>` being the last segment of
// its url), or Nova's own Node with the artifact as its script (`node <name> args…`), the words
// after it being the program's own arguments. Never another program on PATH, an absolute or `../`
// path, a shell, or an interpreter option or inline code (`-e`, `--eval`, `--input-type`,
// `--require`, `--import`) before the artifact. The supervisor driver checks it again at every start:
// the file it runs is a regular file inside the version's slot whose SHA-256 is the pinned one.
//
// Ports below 1024 are refused (they need privileges and belong to the system); the ports Nova uses
// itself (the console's, the device door's) are refused by the driver, from Nova's configuration.
import { WORKLOAD_PURPOSES } from '../mesh/purposes.ts';

export const ALONGSIDE = Object.freeze(['full', 'shadow', 'copy', 'none'] as const);
export type Alongside = (typeof ALONGSIDE)[number];
export const PLACEMENT_MODES = Object.freeze(['pinned', 'preferred', 'floating'] as const);
export type PlacementMode = (typeof PLACEMENT_MODES)[number];
export const EGRESS = Object.freeze(['none', 'local', 'internet'] as const);
export const PLATFORMS = Object.freeze(['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64'] as const);
// The console is the one service whose artifact is a git tag of Nova's own repository.
export const CONSOLE = 'nova-console';

export interface ProgramArtifact { url: string; sha256: string; command: string[] }
export interface ReleaseArtifact { tag: string; command: string[] }
export interface Artifact { image?: string; program?: Record<string, ProgramArtifact>; release?: ReleaseArtifact }
export interface Port { name: string; port: number }
export interface Placement { mode: PlacementMode; device?: string; roles?: string[]; needs?: Record<string, number>; failover?: string; replicas?: number }

export interface ServiceDefinition {
  service: string;
  version: string;
  artifact: Artifact;
  ports: Port[];
  health: { http: string; every_s: number };
  contract_tests: string[];
  alongside: Alongside;
  placement: Placement;
  resources?: { memory_mb?: number };
  state?: { volume: string; size_gb?: number } | null;
  secrets: string[];
  egress: (typeof EGRESS)[number];
  os_permissions: string[];
  // How long the previous version is kept, stopped, after a promotion. Absent: until the next one.
  soak_s?: number;
}

// What the validator may know about where a service could go. `roles` are the device's roles
// (`purposes`, M10f); absent for a device whose roles aren't known, which isn't held against it.
export interface DeviceView { id: string; platform: string; roles?: string[] }

const KEYS = new Set(['service', 'version', 'artifact', 'ports', 'health', 'contract_tests', 'alongside', 'placement', 'resources', 'state', 'secrets', 'egress', 'os_permissions', 'soak_s']);
const NAME = /^[a-z][a-z0-9-]{0,52}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PORT_NAME = /^[a-z][a-z0-9-]{0,14}$/;
const DIGEST = /^[a-z0-9][a-z0-9._\/:-]*@sha256:[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SECRET_NAME = /^secret:\/\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,127}$/;
const HTTP_PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@\/?%-]*$/;
const CONTRACT = /^http:\/[A-Za-z0-9._~!$&'()*+,;=:@\/?%-]*$/;
const CONSOLE_TESTS = new Set(['release-tests', 'smoke']);
const RESERVED = new Set(['current', 'base']);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isInt = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const isCommand = (v: unknown) => isStrs(v) && v.length > 0 && v.every((x) => x.length > 0 && x.length < 4096 && !x.includes('\0'));
// The interpreters a program may name before its own file: Nova's own Node, and nothing else.
export const INTERPRETERS: ReadonlySet<string> = new Set(['node']);
const PROGRAM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// The file name an artifact's url gives it, or null when it gives none Nova would install.
export function programName(url: string): string | null {
  let name: string;
  try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? ''); } catch { return null; }
  return PROGRAM_NAME.test(name) && name !== 'definition.json' ? name : null;
}

// Why this command doesn't start exactly the pinned artifact, or null when it does.
export function commandProblem(command: string[], name: string): string | null {
  const isProgram = (w: string | undefined) => w === name || w === `./${name}`;
  const [first, second] = command;
  if (first !== undefined && INTERPRETERS.has(first)) {
    if (isProgram(second)) return null;
    return `With ${first}, the next word must be its own program, ${name}: no interpreter option or inline code (such as -e, --eval, --input-type, --require or --import) and no other file.`;
  }
  if (isProgram(first)) return null;
  return `Its command starts with ${JSON.stringify(first ?? '')}. A program starts as itself (${name} or ./${name}) or with Nova’s own Node (node ${name} …): never another program, a shell, an absolute path or a path out of its folder.`;
}
// The OS permissions that make a service capture (M10h): screen recording, the microphone, the
// accessibility tree. A capture service is placed only by the capture-source role, and deploying it
// never turns capture on (consent stays per source and device). The device agent keeps the same list
// (src/device/workloads.ts CAPTURE_PERMISSIONS); a test keeps the two the same.
export const CAPTURE_PERMISSIONS: readonly string[] = Object.freeze(['screen-recording', 'microphone', 'accessibility']);
export const isCaptureService = (def: Pick<ServiceDefinition, 'os_permissions'>): boolean => def.os_permissions.some((p) => CAPTURE_PERMISSIONS.includes(p));

// macOS and Windows devices never run containers (ADR Point 6(a)): K3s agent nodes are Linux only.
export const notLinux = (platform: string) => /^(darwin|mac|ios|ipados|win)/i.test(platform);

export type Validated = { ok: true; def: ServiceDefinition } | { ok: false; problems: string[] };

// Every reason this definition can't be used, in plain words; an empty list means it can.
export function validate(input: unknown, o: { devices?: DeviceView[] } = {}): Validated {
  const p: string[] = [];
  if (!isObj(input)) return { ok: false, problems: ['A service definition is a JSON object.'] };
  const d = input;
  for (const k of Object.keys(d)) if (!KEYS.has(k)) p.push(`“${k}” isn’t part of a service definition.`);
  const name = typeof d.service === 'string' ? d.service : '';
  if (!NAME.test(name)) p.push('service is its name: lowercase letters, digits and dashes, starting with a letter, at most 53 characters.');
  if (name === 'nova-broker') p.push('nova-broker is reserved for the trusted supervisor, never an editable workload.');
  const isConsole = name === CONSOLE;
  if (typeof d.version !== 'string' || !VERSION.test(d.version)) p.push('version is letters, digits, dots, dashes or underscores, at most 64 characters.');
  else if (!isConsole && RESERVED.has(d.version.toLowerCase())) p.push(`version can’t be “${d.version}”: the supervisor uses that name itself.`);

  // The artifact: an image, a program per platform, or (the console only) a release tag.
  const a = d.artifact;
  let hasImage = false;
  let hasProgram = false;
  if (!isObj(a)) p.push('artifact is an object with an image, a program, or both.');
  else {
    for (const k of Object.keys(a)) if (!['image', 'program', 'release'].includes(k)) p.push(`artifact.${k} isn’t an artifact form: use image or program.`);
    if (a.image !== undefined) {
      hasImage = true;
      if (typeof a.image !== 'string' || !DIGEST.test(a.image)) p.push('artifact.image is pinned by its digest: <repository>@sha256:<64 hex digits>.');
    }
    if (a.program !== undefined) {
      hasProgram = true;
      if (!isObj(a.program) || !Object.keys(a.program).length) p.push('artifact.program has one entry per platform, such as linux-x64.');
      else {
        for (const [plat, prog] of Object.entries(a.program)) {
          if (!(PLATFORMS as readonly string[]).includes(plat)) { p.push(`artifact.program.${plat} isn’t a platform Nova knows (${PLATFORMS.join(', ')}).`); continue; }
          if (!isObj(prog)) { p.push(`artifact.program.${plat} is {url, sha256, command}.`); continue; }
          if (typeof prog.url !== 'string' || !/^(file|https):\/\/\S+$/.test(prog.url)) p.push(`artifact.program.${plat}.url is a file: or https: address.`);
          if (typeof prog.sha256 !== 'string' || !SHA256.test(prog.sha256)) p.push(`artifact.program.${plat}.sha256 is the file’s SHA-256, 64 lowercase hex digits.`);
          const name = typeof prog.url === 'string' ? programName(prog.url) : null;
          if (typeof prog.url === 'string' && !name) p.push(`artifact.program.${plat}.url must end in the program’s file name (letters, digits, dots, dashes or underscores; not definition.json).`);
          if (!isCommand(prog.command)) p.push(`artifact.program.${plat}.command is the command that starts it, as a list of words (never one shell string).`);
          else if (name) { const why = commandProblem(prog.command as string[], name); if (why) p.push(`artifact.program.${plat}.command: ${why}`); }
          for (const k of Object.keys(prog)) if (!['url', 'sha256', 'command'].includes(k)) p.push(`artifact.program.${plat}.${k} isn’t part of a program.`);
        }
      }
    }
    if (a.release !== undefined) {
      if (!isConsole) p.push('Only Nova’s own console runs from a release tag of Nova’s repository; a service brings an image or a program.');
      else if (!isObj(a.release) || typeof a.release.tag !== 'string' || !VERSION.test(a.release.tag) || !isCommand(a.release.command)) p.push('artifact.release is {tag, command}.');
    } else if (!hasImage && !hasProgram) p.push('artifact needs an image or a program: there is nothing to run.');
  }

  // Ports: named, unique, on this machine's range.
  if (!Array.isArray(d.ports)) p.push('ports is a list of {name, port}.');
  else {
    const names = new Set<string>();
    const nums = new Set<number>();
    for (const [i, port] of d.ports.entries()) {
      if (!isObj(port) || typeof port.name !== 'string' || !PORT_NAME.test(port.name)) { p.push(`ports[${i}].name is lowercase letters, digits and dashes, at most 15 characters.`); continue; }
      // The console alone may say 0: the configured port, or a free one it names when it starts.
      if (!isInt(port.port, isConsole ? 0 : 1024, 65_535)) p.push(`ports[${i}].port (${port.name}) is a port number from 1024 to 65535: lower ones need privileges and belong to the system.`);
      if (names.has(port.name)) p.push(`Two ports are named ${port.name}.`);
      if (nums.has(port.port as number)) p.push(`Port ${port.port} is listed twice.`);
      names.add(port.name);
      nums.add(port.port as number);
    }
  }

  const h = d.health;
  if (!isObj(h) || typeof h.http !== 'string' || !HTTP_PATH.test(h.http) || !isInt(h.every_s, 1, 3600)) p.push('health is {http: "/path", every_s: 1 to 3600}: a GET on the service’s first port that answers 2xx when it is healthy.');
  else if (!Array.isArray(d.ports) || !d.ports.length) p.push('A health check needs a port to check: ports is empty.');

  if (!isStrs(d.contract_tests)) p.push('contract_tests is a list (it may be empty).');
  else for (const t of d.contract_tests) {
    if (CONTRACT.test(t)) continue;
    if (isConsole && CONSOLE_TESTS.has(t)) continue;
    if (t.startsWith('probe:')) p.push(`The contract test “${t}” names a probe, and Nova has no named probes for services yet: use http:/<path>, a GET that must answer 2xx.`);
    else p.push(`The contract test “${t}” isn’t one Nova can run: use http:/<path>, a GET that must answer 2xx.`);
  }

  if (!(ALONGSIDE as readonly string[]).includes(d.alongside as string)) p.push(`alongside is how a new version runs next to the old one: ${ALONGSIDE.join(', ')}.`);
  if (!(EGRESS as readonly string[]).includes(d.egress as string)) p.push(`egress is ${EGRESS.join(', ')}.`);
  if (!isStrs(d.os_permissions)) p.push('os_permissions is a list (it may be empty).');
  if (d.soak_s !== undefined && !isInt(d.soak_s, 0, 30 * 86_400)) p.push('soak_s is a whole number of seconds, at most 30 days.');
  if (d.resources !== undefined && (!isObj(d.resources) || (d.resources.memory_mb !== undefined && !isInt(d.resources.memory_mb, 1, 1_048_576)) || Object.keys(d.resources).some((k) => k !== 'memory_mb'))) p.push('resources is {memory_mb}.');
  const hasState = d.state !== undefined && d.state !== null;
  if (hasState && (!isObj(d.state) || typeof d.state.volume !== 'string' || !NAME.test(d.state.volume) || (d.state.size_gb !== undefined && !isInt(d.state.size_gb, 1, 100_000)))) p.push('state is {volume, size_gb}: the volume named like a service.');

  // Secrets are names only: a value here would be written to the services repository and the logs.
  if (!isStrs(d.secrets)) p.push('secrets is a list of secret:// names (it may be empty).');
  else for (const s of d.secrets) if (!SECRET_NAME.test(s)) p.push('A secret is written as its value, not as a secret:// name. A definition holds names only; values stay in the vault.');

  // Placement.
  const pl = d.placement;
  if (!isObj(pl) || !(PLACEMENT_MODES as readonly string[]).includes(pl.mode as string)) p.push(`placement.mode is ${PLACEMENT_MODES.join(', ')}.`);
  else {
    if (pl.mode === 'pinned' && (typeof pl.device !== 'string' || !pl.device)) p.push('A pinned service names its device: placement.device.');
    if (pl.mode !== 'pinned' && pl.device !== undefined) p.push('Only a pinned service names one device; use roles for the others.');
    if (pl.roles !== undefined && (!isStrs(pl.roles) || !pl.roles.length)) p.push('placement.roles is a list of roles.');
    // Only workload roles place a service (M10f): a thin client never receives one, and a hub
    // candidacy is about the hub, not about what runs where.
    else if (isStrs(pl.roles)) for (const r of pl.roles) if (!(WORKLOAD_PURPOSES as readonly string[]).includes(r)) p.push(`placement.roles can name ${WORKLOAD_PURPOSES.join(', ')}; “${r}” isn’t a role a service is placed by.`);
    if (pl.needs !== undefined && isObj(pl.needs)) for (const k of Object.keys(pl.needs)) if (!['gpu_vram_gb', 'memory_gb', 'disk_gb'].includes(k)) p.push(`placement.needs.${k} isn’t something Nova can check on a device (gpu_vram_gb, memory_gb, disk_gb).`);
    if (pl.needs !== undefined && (!isObj(pl.needs) || Object.values(pl.needs).some((v) => typeof v !== 'number' || v < 0))) p.push('placement.needs is numbers, such as {gpu_vram_gb: 8}.');
    if (pl.replicas !== undefined && (pl.mode !== 'floating' || !isInt(pl.replicas, 1, 64))) p.push('Only a floating service has replicas: 1 to 64.');
    if (pl.failover !== undefined && (typeof pl.failover !== 'string' || !pl.failover)) p.push('placement.failover is a device or “any”.');
    // Capture only onto capture sources (M10h): a service asking for a capture permission says so in
    // its placement, so the resolver and the device agent both hold it to that role.
    if (isStrs(d.os_permissions) && d.os_permissions.some((x) => CAPTURE_PERMISSIONS.includes(x)) && !(isStrs(pl.roles) && pl.roles.includes('capture-source'))) {
      p.push(`It asks for ${d.os_permissions.filter((x) => CAPTURE_PERMISSIONS.includes(x)).join(' and ')}, so it captures: its placement.roles must include capture-source, and it runs only on a device that is a capture source.`);
    }
    // A floating service runs on whichever device is healthy: its state would be left behind.
    if (pl.mode === 'floating' && hasState) p.push('A floating service can’t have state: it moves between devices, and its state would stay behind. Pin it, or prefer a device with a failover.');
    const devices = o.devices;
    if (devices) {
      const pinned = pl.mode === 'pinned' && typeof pl.device === 'string' ? devices.find((x) => x.id === pl.device) : null;
      if (pl.mode === 'pinned' && typeof pl.device === 'string' && !pinned) p.push(`There is no device ${pl.device} to pin it to.`);
      // Containers run only on Linux nodes (ADR Point 6(a)).
      if (pinned && hasImage && !hasProgram && notLinux(pinned.platform)) p.push(`It comes only as a container image, and ${pinned.id} is a ${pinned.platform} device: containers run only on Linux. Add a program for that platform, or pin it to a Linux device.`);
      const roles = isStrs(pl.roles) ? pl.roles : [];
      if (roles.length) {
        const known = (pinned ? [pinned] : devices).filter((x) => Array.isArray(x.roles));
        if (known.length && !known.some((x) => roles.every((r) => x.roles!.includes(r)))) p.push(`No device${pinned ? ` (${pinned.id} included)` : ''} has the roles it asks for (${roles.join(', ')}), so there is nowhere it may run.`);
      }
    }
  }
  return p.length ? { ok: false, problems: [...new Set(p)] } : { ok: true, def: d as unknown as ServiceDefinition };
}

// Who must agree before a version takes traffic (the ADR's tier table): the console, anything with
// secrets or OS permissions (capture) is tier 3, every time; any other service is tier 2.
export function promotionTier(def: ServiceDefinition): 2 | 3 {
  return def.service === CONSOLE || def.secrets.length > 0 || def.os_permissions.length > 0 ? 3 : 2;
}

// This machine's platform key, as a definition names it.
export function platformKey(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}
```

### `src/core/diagnostics/index.ts`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `895647cbfc888b69cec3f2ba6f8dbabe5846ad3f`, SHA256 `d732758da9b8c84e857f05b9cefd1d643789e63659cfb6565eee08c1f302d970`, 261 physical lines (262 under boundary count).

```ts
// One-click diagnostics (Amendment 2026-10-31-B Part 6): a bundle of versions, health state, recent
// logs and config, for the person to download and do with as they choose. Nova builds it in memory
// for the request that asked, never keeps it on disk and never sends it anywhere.
//
// THE RULE: counts and states, never content; names of secrets at most, never their values. No
// memory text, conversation, captured screen/audio/accessibility text, task title or goal, or the
// person's name or address is ever read into it.
//
// REDACTED BY CONSTRUCTION, three layers (docs/plans/diagnostics.md):
//   1. allow-list: each section is built from named fields of Nova's own views; content-bearing
//      stores (memory, sessions, capture events, briefs) are never read;
//   2. keys (Home Assistant's diagnostics pattern): a key that names a secret has its value replaced
//      by the fixed marker, whatever the value, and so does any secret:// reference;
//   3. values: every value Nova knows as a secret (the vault's, the NOVA_SECRET_* fallbacks, the
//      mesh identity's private keys, the vault's key), in plain, case-folded, base64, base64url,
//      hex and URL-encoded form, is replaced wherever it appears, and so are secret-shaped strings
//      (Bearer …, URL credentials, JWTs, common token prefixes, token=… parameters).
import { readFileSync } from 'node:fs';
import { homedir, platform, arch } from 'node:os';
import { join } from 'node:path';
import { Reply, type Route } from '../api.ts';
import type { Core } from '../index.ts';

export const MARKER = '**REDACTED**';
export const RULE = 'Counts and states, never content; names of secrets at most, never their values.';
export const LOG_LINES = 500;
export const DETAIL_MAX = 2000;

// Keys whose values are secrets (log.ts's pattern, widened): the value goes, whatever it is.
export const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|authori[sz]ation|cookie|private|credential|session|^auth$|^key$|[_-]key$|^mac$|serial/i;
// Secret-shaped strings, wherever they are.
const SHAPES: [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${MARKER}`],
  [/(\/\/)[^/\s:@]+:[^/\s@]+@/g, `$1${MARKER}@`],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, MARKER],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9]{12,}|\bxox[abprs]-[A-Za-z0-9-]{8,}|\bAKIA[A-Z0-9]{12,}/g, MARKER],
  [/\b((?:access_|refresh_|id_)?token|api[_-]?key|key|secret|password|code|sig|signature)=([^&\s"'<>]+)/gi, `$1=${MARKER}`],
  [/secret:\/\/[A-Za-z0-9_./-]+/g, MARKER],
];

// Every form a secret could take in text.
export function formsOf(value: string): string[] {
  const out = new Set<string>([value, encodeURIComponent(value), encodeURIComponent(value).replace(/%20/g, '+'),
    Buffer.from(value).toString('base64').replace(/=+$/, ''), Buffer.from(value).toString('base64url'), Buffer.from(value).toString('hex')]);
  // A key kept as base64 (the mesh and vault keys): its raw bytes as hex too.
  if (/^[A-Za-z0-9+/_-]{16,}={0,2}$/.test(value)) {
    try { const raw = Buffer.from(value, 'base64'); if (raw.length >= 12) { out.add(raw.toString('hex')); out.add(raw.toString('base64url')); out.add(raw.toString('base64').replace(/=+$/, '')); } } catch { /* not base64 */ }
  }
  return [...out].filter((f) => f.length >= 6);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class Scrubber {
  readonly marker = MARKER;
  values = 0;
  keys = 0;
  #res: RegExp[] = [];
  #paths: [string, string][] = [];

  constructor(secrets: string[], paths: [string, string][] = []) {
    const forms = new Set<string>();
    for (const s of secrets) if (typeof s === 'string' && s.length >= 6) for (const f of formsOf(s)) forms.add(f);
    // Longest first, so a form inside another is replaced as part of the longer one.
    const sorted = [...forms].sort((a, b) => b.length - a.length);
    for (let i = 0; i < sorted.length; i += 50) this.#res.push(new RegExp(sorted.slice(i, i + 50).map(escapeRe).join('|'), 'gi'));
    this.#paths = paths.filter(([p]) => p && p.length > 1).sort((a, b) => b[0].length - a[0].length);
  }

  text(s: string): string {
    let out = s;
    for (const re of this.#res) out = out.replace(re, () => { this.values++; return MARKER; });
    for (const [re, to] of SHAPES) out = out.replace(re, (...m) => { this.values++; return to.replace('$1', String(m[1] ?? '')); });
    for (const [p, to] of this.#paths) if (out.includes(p)) out = out.split(p).join(to);
    return out;
  }

  // Keys first (the Home Assistant pattern), then every string value.
  any(v: unknown, depth = 0): unknown {
    if (typeof v === 'string') return this.text(v);
    if (v === null || typeof v !== 'object' || depth > 12) return typeof v === 'object' && v !== null ? MARKER : v;
    if (Array.isArray(v)) return v.map((x) => this.any(x, depth + 1));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => {
      if (SECRET_KEY.test(k) && x !== null && x !== undefined && typeof x !== 'boolean') { this.keys++; return [k, MARKER]; }
      return [this.text(k), this.any(x, depth + 1)];
    }));
  }
}

// A failed required scan must never turn into a partial set or a warning carrying raw errors.
// Keep the reason fixed: source errors can themselves contain credentials and private paths.
class SecretScanUnavailable extends Error {
  constructor() {
    super('Diagnostics could not be downloaded because Nova could not complete its secret check. Try again when the secret stores are available.');
  }
}

// Every value Nova knows as a secret, from where it keeps them. Finish this scan before reading
// included metadata/free text. Empty vaults are valid; a missing enumerated entry is not.
export function knownSecrets(core: Pick<Core, 'vault'>, o: { home: string; env?: NodeJS.ProcessEnv }): { secrets: string[]; warnings: string[] } {
  const secrets: string[] = [];
  const add = (v: unknown) => {
    if (typeof v !== 'string' || v.length < 6) return;
    secrets.push(v);
    if (v.startsWith('{')) { try { for (const x of Object.values(JSON.parse(v) as Record<string, unknown>)) add(x); } catch { /* not JSON */ } }
  };
  try {
    const names = core.vault.list();
    for (const name of names) {
      const value = core.vault.get(name);
      if (typeof value !== 'string' || !value.length) throw new SecretScanUnavailable();
      add(value);
    }
    const key = core.vault.keyForStandby();
    if (names.length && !key) throw new SecretScanUnavailable();
    add(key);
    // A file key may be absent for an empty vault or a keychain-held key. Other read failures
    // cannot establish absence and must not silently omit a known-secret source.
    try { add(readFileSync(join(o.home, 'vault', 'key')).toString('base64')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    // Core creates its mesh identity at startup, so both private keys must be readable here.
    const id = JSON.parse(readFileSync(join(o.home, 'mesh', 'identity.json'), 'utf8')) as Record<string, Record<string, unknown>>;
    for (const name of ['ed25519', 'x25519']) {
      if (typeof id?.[name]?.private !== 'string' || !id[name]!.private) throw new SecretScanUnavailable();
    }
    for (const part of Object.values(id)) if (part && typeof part === 'object') add(part.private);
    // The stable name's control token (M10g) is a secret too.
    for (const [k, v] of Object.entries(o.env ?? process.env)) if (/^NOVA_SECRET_/.test(k) || k === 'NOVA_MESH_NAME_TOKEN') add(v);
  } catch { throw new SecretScanUnavailable(); }
  return { secrets, warnings: [] };
}

const clip = (s: unknown, n: number) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}… [${t.length - n} more characters]` : t; };
const safe = (f: () => unknown, fallback: (e: Error) => unknown): unknown => { try { return f(); } catch (e) { return fallback(e as Error); } };
const unread = (e: Error) => ({ unreadable: e.message });
const byState = (xs: { state: string }[]) => { const out: Record<string, number> = {}; for (const x of xs) out[x.state] = (out[x.state] ?? 0) + 1; return out; };

function logTail(file: string | null, n: number) {
  if (!file) return [];
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).slice(-n).map((l) => {
    try {
      const j = JSON.parse(l) as Record<string, unknown>;
      // Time, level, source and message only: a line's data fields can carry content.
      return { at: j.at, level: j.level, source: j.source, msg: clip(j.msg, 1000) };
    } catch { return { msg: '(a line that isn’t JSON)' }; }
  });
}

// The person's settings by section: the `user` section (their name, address, details) is replaced
// whole; capture's lists (exclusions: apps, sites) become how many.
function config(core: Pick<Core, 'profile'>) {
  const all = core.profile.all();
  return Object.fromEntries(Object.entries(all).map(([section, v]) => {
    if (section === 'user') return [section, Object.fromEntries(Object.keys(v).map((k) => [k, MARKER]))];
    if (section === 'capture') return [section, Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Array.isArray(x) ? `${x.length} item${x.length === 1 ? '' : 's'}` : x]))];
    return [section, v];
  }));
}

export interface DiagnosticsOptions {
  home: string;
  version: string;
  commit?: string | null;
  instance?: string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  // Era 2's counts (conversations, schedules, skills), handed in by the server: counts only.
  era2?: () => Record<string, number>;
}

// Optional broker probe: retain only typed counts/states, never refs, identities, entry keys,
// fingerprints, or free-form problem/error text. A locked broker cannot report its item count.
async function brokerMetadata(core: Core) {
  if (!core.broker) return { available: false, problem: false };
  try {
    const answer = await core.broker.listRefs();
    const s = answer.state as Record<string, unknown> | undefined;
    if (!answer.ok || !s || typeof s.exists !== 'boolean' || typeof s.locked !== 'boolean' || !Array.isArray(answer.refs)) {
      return { available: false, problem: true };
    }
    return {
      available: true, exists: s.exists, locked: s.locked,
      visible_items: s.locked ? null : answer.refs.length,
      unlock_mode: s.unlock_mode === 'auto' || s.unlock_mode === 'ask' ? s.unlock_mode : null,
      device_store: s.device_key === 'file' || s.device_key === 'keychain' ? s.device_key : null,
      problem: !!s.problem,
    };
  } catch { return { available: false, problem: true }; }
}

export async function buildDiagnostics(core: Core, o: DiagnosticsOptions) {
  const now = (o.now ?? (() => new Date()))();
  const { secrets, warnings } = knownSecrets(core, o);
  const scrub = new Scrubber(secrets, [[o.home, '<home>'], [homedir(), '~']]);
  const models = await core.models.view().catch((e: Error) => unread(e));
  const raw = {
    about: {
      nova: o.version, build: o.commit ?? null, instance: o.instance ?? null,
      role: safe(() => core.mesh.role.replica() ? 'standby' : 'hub', () => 'unknown'),
      platform: platform(), arch: arch(), node: process.version, created_at: now.toISOString(), home: '<home>',
      timezone_set: !!core.identity().timezone,
    },
    health: safe(() => core.health(), unread),
    config: safe(() => config(core), unread),
    vault: safe(() => {
      const s = core.vault.status();
      const kinds: Record<string, number> = {};
      for (const n of core.vault.list()) { const k = n.split('/')[0]!; kinds[k] = (kinds[k] ?? 0) + 1; }
      return { ok: s.ok, stored: s.secrets, by_kind: kinds, key_store: s.key, problem: s.problem };
    }, unread),
    broker: await brokerMetadata(core),
    providers: safe(() => core.providers.list().map((p) => ({ id: p.id, name: p.name, class: p.class, state: p.state, model: p.model, where: p.egress, health: p.health, config: p.config })), unread),
    models,
    capture: safe(() => ({
      status: core.capture.status(),
      sources: core.capture.sources().map((s) => ({ id: s.id, kinds: s.kinds, name: s.name, device: s.device?.name ?? null, enabled: s.enabled, paused: s.paused, status: s.status, detail: s.detail, has_api_key: s.has_api_key })),
    }), unread),
    connectors: safe(() => core.connectors.list().map((c) => ({ id: c.id, name: c.name, connected: c.connected, broken: c.broken, allowed: c.allowed, live: c.live })), unread),
    devices: safe(() => core.mesh.devices.list().map((d) => ({ id: d.id, name: d.name, kind: d.kind, role: d.role, trust: d.trust })), unread),
    // Targets and projects by name and state; a change's or run's title comes from the person's
    // words, so changes and runs are counted by state, never listed.
    network: safe(() => { const n = core.network.list(); return { window_s: n.window_s, devices_counted: n.devices.length, targets: n.targets, changes: byState(n.changes) }; }, unread),
    infra: safe(() => { const i = core.infra.list(); return { tool: i.tool, projects: i.projects.map((p) => ({ id: p.id, name: p.name, folder: p.folder, egress: p.egress, budget_usd_month: p.budget_usd_month, secrets: p.secrets })), runs: byState(i.runs) }; }, unread),
    work: {
      ledger: safe(() => core.ledger.counts(), unread),
      by_worker: safe(() => { const out: Record<string, number> = {}; for (const t of core.ledger.list({ limit: 500 })) out[t.owner] = (out[t.owner] ?? 0) + 1; return out; }, unread),
      memory: safe(() => core.memory.counts(), unread),
      receipts: safe(() => core.receipts.counts(), unread),
      triggers: safe(() => core.triggers.counts(), unread),
      extensions: safe(() => core.extensions.counts(), unread),
      era2: safe(() => o.era2?.() ?? null, unread),
    },
    problems: safe(() => core.log.problems().slice(0, 50).map((p) => ({ at: p.at, source: p.source, message: clip(p.message, 500), detail: p.detail ? clip(p.detail, DETAIL_MAX) : null, open: !p.resolved_at })), unread),
    logs: logTail(core.log.file, LOG_LINES),
  };
  const body = scrub.any(raw) as Record<string, unknown>;
  return {
    format: 'nova-diagnostics', format_version: 1, ...body,
    redaction: { marker: MARKER, rule: RULE, keys_redacted: scrub.keys, values_redacted: scrub.values, secrets_checked: secrets.length, warnings },
  };
}

export const fileName = (at: Date) => `nova-diagnostics-${at.toISOString().slice(0, 16).replace(/[-:T]/g, (c) => (c === 'T' ? '-' : '')).replace(/^(\d{8})-(\d{4})$/, (_m, d, t) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}-${t}`)}.json`;

// Mounted by Core: the bundle as an attachment to the person’s own browser; never stored,
// never sent elsewhere. An incomplete required secret scan returns only a fixed error.
export function diagnosticsRoutes(build: () => ReturnType<typeof buildDiagnostics>, now: () => Date = () => new Date()): Route[] {
  return [{
    method: 'GET', path: '/diagnostics',
    summary: 'One-click diagnostics: versions, health, recent logs and config, with every secret replaced by **REDACTED** and no personal content (counts and states only). Built for this request, returned as a file to download; Nova keeps no copy and sends it nowhere.',
    handle: async () => {
      try { return new Reply(await build(), { 'content-disposition': `attachment; filename="${fileName(now())}"` }); }
      catch (e) {
        if (e instanceof SecretScanUnavailable) return new Reply({ error: e.message }, {}, 503);
        throw e;
      }
    },
  }];
}
```

### `src/core/index.ts`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `8b8598f4ecc3a8db0dc8b6018e8eb1c7a8ece1e2`, SHA256 `969241c81047f90d91c4892cf36e08bb2a7ad62d498667598c5dd7fc4a0a6d5f`, 1785 physical lines (1786 under boundary count).

```ts
// Nova's core (ADR-1): one deployable, internally modular. This is the composition root and the
// only module that knows about all the others; each module gets what it needs passed in, and
// nothing outside src/core imports anything but this file.
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { CoreError } from './errors.ts';
import { Db, loadMigrations } from './db.ts';
import { Log, addSecretValue } from './log.ts';
import { Profile, SECTIONS, type Section } from './profile.ts';
import { Workspace, workspaceWorker } from './workspace.ts';
import { Verifier, type Checker } from './verify.ts';
import { Ledger, STATES, TASK_CONTEXT, type LanedWorker, type State, type TaskInput } from './ledger.ts';
import type { PrivacyMode as PrivacyModeOf } from './envelope.ts';
import { Setup, type Onboarding } from './setup.ts';
import { detectOs, type OsFamily } from './onboard/detect.ts';
import { discover, realTransport, type DiscoveryTransport } from './onboard/discover.ts';
import { findSources, importSources } from './onboard/sources.ts';
import { backendFor } from './onboard/backend.ts';
import { Extensions } from './extensions.ts';
import { Design, type Scope } from './design.ts';
import { Decisions, RulesProvider, Templates } from './decide.ts';
import { TRIAGE, Triggers, triageRule, type Policy, type RuleInput } from './triggers.ts';
import { Memory, KINDS as MEMORY_KINDS, type Kind as MemoryKind, type MemoryInput, type UserState } from './memory.ts';
import { Receipts } from './receipts.ts';
import { Backups } from './backups.ts';
import { CHARTER, identityOf, render } from './identity.ts';
import { egressOf, info, permits, stricter, type Egress } from './workers.ts';
import { BrokerClient } from './broker/client.ts';
import { createApi, Raw, Reply, type Route, type Who } from './api.ts';
import { createDecisionService, DbLog, OPT_IN_WORDS, validateSettings, DEFAULT_SETTINGS as DEFAULT_DECISION_SETTINGS, type DecisionSettings, type VerdictStore } from './decision-service/index.ts';
import { Scorecards, scorecardRoutes, targetsFrom, REGRESSION_FINGERPRINT } from './evals/index.ts';
import { loadIdentity, replaceIdentityKeys } from './mesh/identity.ts';
import { Devices, ONLINE_WINDOW_MS, SESSION_TTL_MS, type Device } from './mesh/devices.ts';
import { Enrollment } from './mesh/enroll.ts';
import { resolvePlacement, type PlacementDevice } from './services/placement.ts';
import { validate } from './services/definition.ts';
import { validServiceExpected } from './services/expected.ts';
import { buildTopology, supervisorServices, type ClusterObservation, type MachineInput } from './services/topology.ts';
import { DeviceWorkloads } from './services/workloads.ts';
import { ServiceManager } from './services/manager.ts';
import { CaptureSync } from './capture/sync.ts';
import { APPROVER_ONLY, Access, allows, loopbackAddress, sessionCookie, type Listener, type MeshListenerInfo, type Principal } from './mesh/access.ts';
import { SyncLog } from './mesh/sync.ts';
import { MeshRole, nodeRole } from './mesh/promote.ts';
import { Promotions, httpStableName, testing as promotionTesting } from './mesh/handover.ts';
import { setTap, tap as drillTap } from './mesh/tap.ts';
import { drill as runDrill } from './resilience/drill.ts';
import { SEAL_NAME } from './resilience/backup.ts';
import { DEVICE_CONFIG_SECTIONS, Spokes } from './mesh/spokes.ts';
import { agentTar, joinScript } from './mesh/agent.ts';
import { Vault, type KeyMode, type KeyStore } from './vault.ts';
import { Connectors } from './connectors/index.ts';
import { homeAssistant, type HomeAssistantOptions } from './connectors/home-assistant.ts';
import { Providers } from './providers/registry.ts';
import { Browser, type BrowserOptions } from './browser/worker.ts';
import type { Hub } from './browser/plan.ts';
import { browserRoutes } from './browser/routes.ts';
import { checkers as browserCheckers } from './browser/evidence.ts';
import { Capture, PROMOTE, SCREEN_TEMPLATE } from './capture/capture.ts';
import { captureRoutes } from './capture/routes.ts';
import { Models, ROLE_WORDS as MODEL_ROLE_WORDS, type Hardware } from './models/index.ts';
import { LocalModelProvider, PROVIDER_ID as LOCAL_MODEL_PROVIDER } from './models/decide.ts';
import { wireIngest, type ScreenInput, type Taint } from './ingest/index.ts';
import { NovaComputer, type ComputerOptions } from './computer/index.ts';
import { computerRoutes } from './computer/routes.ts';
import { Coding, type CodingOptions } from './coding/index.ts';
import { codingRoutes } from './coding/routes.ts';
import { Infra, type InfraOptions } from './infra/index.ts';
import { infraRoutes } from './infra/routes.ts';
import { Network, type NetworkOptions } from './network/index.ts';
import { networkRoutes } from './network/routes.ts';
import { secretName } from './providers/types.ts';
import { Resilience } from './resilience/index.ts';
import { FactoryReset } from './resilience/reset.ts';
import { ensureMark } from './resilience/home-mark.ts';
import { connectorWatch, wireRepairs } from './resilience/repairs.ts';
import type { SupervisorLink } from './resilience/link.ts';
import { Changes } from './changes/pipeline.ts';
import { Checkpoints, dropPartials, finishStaged, stagedPending, takeCheckpoint } from './resilience/checkpoints.ts';
import { Restarter } from './resilience/restart.ts';
import { stopChildren } from './children.ts';
import { Foundry } from './changes/foundry.ts';
import { Self } from './self.ts';
import { Caps, capsRoutes } from './caps/index.ts';
import { buildDiagnostics, diagnosticsRoutes } from './diagnostics/index.ts';
import { CODE_ROOT } from './resilience/sandbox.ts';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

// A setting's key as the inbox takes it in a config change (mesh/spokes.ts).
const DEVICE_CONFIG_KEY = /^[a-z][a-z0-9_.-]{0,63}$/;

export { render as renderIdentity } from './identity.ts';
export { permits } from './workers.ts';
export { ENVELOPE_VERSION } from './envelope.ts';
export { TERMINAL } from './ledger.ts';
export type { Brief, Evidence, Report } from './envelope.ts';
export type { Worker, Egress } from './workers.ts';
export type { Checker } from './verify.ts';
export type { Lane, LanedWorker, Task } from './ledger.ts';
// The design-system schema and its checks, for the token lint and the package check (scripts/).
// The mesh's wire format and the limiter, shared with the device agent (src/device) and sync.
export * from './mesh/wire.ts';
export { SlidingWindowLimiter } from './mesh/limiter.ts';
export { KINDS as DEVICE_KINDS, ROLE_OF, SESSION_TTL_MS } from './mesh/devices.ts';
export { JOIN_REVEAL_TTL_MS, JOIN_APPROVE_TTL_MS, rateKey } from './mesh/enroll.ts';
export { PURPOSES, PURPOSE_WORDS, WORKLOAD_PURPOSES, allowedPurposes, checkPurposes, defaultPurposes, fixedPurposes, mayRunWork, purposeChange } from './mesh/purposes.ts';
export type { Purpose, PurposeChange } from './mesh/purposes.ts';
export { BROWSER_TASK_HEADER, PUBLIC_PATHS, SESSION_COOKIE, allows, fromBrowserTask, isConsole, loopbackAddress, loopbackHost } from './mesh/access.ts';
export { DEVICE_CONFIG_SECTIONS, INBOX_KINDS, MAX_BATCH as INBOX_MAX_BATCH } from './mesh/spokes.ts';
export { RUNTIME_FILES, agentFiles, agentTar, joinScript, tar } from './mesh/agent.ts';
export type { Device, Kind as DeviceKind, Role as DeviceRole, MeshState } from './mesh/devices.ts';
export type { JoinRequest, Pairing } from './mesh/enroll.ts';
export type { Listener, MeshListenerInfo, Principal, Scope } from './mesh/access.ts';
export type { MeshIdentity } from './mesh/identity.ts';
// Hub, standby and sync (M4c): the role file a standby is enrolled with, and this node's keys.
export { loadIdentity } from './mesh/identity.ts';
export { ROLE_FILE, readRole, writeRole } from './mesh/replica.ts';
export type { RoleFile } from './mesh/replica.ts';
export { REPLICATED, NOT_JOURNALLED } from './mesh/sync.ts';
// Hub promotion (M10g): the pre-checks, the signed hand-over, the sheets' words, the drill's tap.
export { PROMOTION_FILE, PROMOTION_WORKER, WINDOW_MIN_S, FAILS_TO_ROLL_BACK, CONNECTOR_WORDS, DEVICE_WORDS, LOST_WORDS, prechecks, coldSheet, plannedSheet, signCall, verifyCall, handoverMessage, verifyHandover, latestBackup, backupState } from './mesh/handover.ts';
export type { Check as PromotionCheck, CandidateFacts, HubFacts, Handover, SignedHandover, PromotionRecord, ColdFacts, Fact as SheetFact } from './mesh/handover.ts';
export type { Who } from './api.ts';
// Providers (M5a): the registry's chat handle for Era 2's runner, and the stand-ins' signing helpers.
export type { ChatHandle } from './providers/registry.ts';
export { signatureHeader as n8nSignature, SIGNATURE_HEADER as N8N_SIGNATURE_HEADER } from './providers/n8n.ts';
export { originHost } from './api.ts';
export { TOKENS, TOKEN_NAMES, ORB_STATES, ORB_MEANINGS, ORB_STATE_VARS, checkOrbStates, cssVar, contrast, validatePackage, generateCss, iosStatusBar, IOS_STATUS_BARS, IOS_STATUS_BAR_META, IOS_STATUS_BAR_UNDECLARED, STATUS_BAR_TAG, statusBarTag, BUILTIN_DIR, DEFAULT_DESIGN_SYSTEM, STARTERS, LIVE_CHECKS, liveCheck, looks, contrastNudge, applyNudge, MOTION_MIN_MS, MOTION_MAX_MS, TRANSITION_TOKENS, overshoots, LEAD_DESIGN_SYSTEM, AT_THE_BAR, atTheBar, SPACE_SCALE, TYPE_STEPS, TYPE_RATIO, TYPE_MIN_PX, RADIUS_CLASSES, ICON_STROKE, scaleFindings, packageScaleFindings } from './design.ts';
// The vault and connectors (M5b): Era 2's Gmail keeps its secrets in the vault and registers as a connector.
export { Vault, FILE_KEY_NOTICE, SECRET_SCHEME, secretRef, keyMode, fileKeyStore, secretToolKeyStore, macKeyStore, windowsKeyStore, platformKeyStore } from './vault.ts';
export type { KeyMode, KeyStore, Run as KeyCommandRunner, VaultStatus } from './vault.ts';
export { addressEgress, secretPrefix } from './connectors/index.ts';
export type { Connector, ConnectorContext, ConnectorFactory, ConnectorStatus, ConnectorView } from './connectors/index.ts';
export { HA_ID, HA_MANIFEST, DEFAULT_TIER3, tokenIssuer } from './connectors/home-assistant.ts';
export { redactText } from './log.ts';
// Resilience (M7b): the supervisor's link and shared pieces (src/supervisor imports only this file).
export { BrokerClient } from './broker/client.ts';
export { ipcLink, ipcBroker, consoleStatus } from './resilience/link.ts';
export type { SupervisorLink, SupervisorState, SupervisorProblem, ReleaseSlot, Stage as DeployStage, ProbeLine, ServerMode } from './resilience/link.ts';
export { PLAYBOOKS } from './resilience/playbooks.ts';
export { CODE_ROOT, copyHome, smoke, startSandbox, sandboxEnv } from './resilience/sandbox.ts';
export type { Sandbox, ProbeResult } from './resilience/sandbox.ts';
export { restoreInto, backupFiles, sha256File, openEncrypted } from './resilience/backup.ts';
// Factory reset (M7 amendment §2): finished at start, before the database opens (server.js too).
export { RESET_MARKER, RESET_REPORT, finishReset, homeEntries, supervisorResetPending } from './resilience/reset.ts';
export { HOME_MARK, ensureMark, unsafeHome } from './resilience/home-mark.ts';
export type { ResetReport } from './resilience/reset.ts';
export { makeScratch, dropScratch } from './resilience/scratch.ts';
export type { Manifest as BackupManifest } from './resilience/backup.ts';
export { restoreBackup, loadMigrations } from './db.ts';
// Checkpoints (M7 amendment §1): the supervisor takes one before a release switch on the stopped
// home; the server applies a staged restore before anything opens the home.
export { takeCheckpoint, listCheckpoints, finishStaged, stagedPending, KEEP_AUTO, RETENTION as CHECKPOINT_RETENTION } from './resilience/checkpoints.ts';
export type { CheckpointView, CheckpointManifest } from './resilience/checkpoints.ts';
// Nova's own entries in a home, by name: what checkpoints, restore and factory reset may touch.
export { NOVA_ENTRIES, isNovaEntry, foreignEntries } from './resilience/entries.ts';
// Every process Nova starts, so none outlives an in-place restart (Era 2's commands register too).
export { trackChild } from './children.ts';
export { inheritedChildEnv } from './child-env.ts';
// Services (M10e): the definition, the driver interface, the Service Manager.
export * from './services/index.ts';
// Onboarding (M10f): device detection, the backend words, discovery and import sources.
export { OS_FAMILIES, OS_WORDS, detectOs, factsWords, recommendedHubPurposes, standInOs } from './onboard/detect.ts';
export type { DeviceFacts, OsFamily } from './onboard/detect.ts';
export { backendFor } from './onboard/backend.ts';
export type { BackendSummary } from './onboard/backend.ts';
export { LOCAL_PORTS as DISCOVERY_PORTS, SERVICES as DISCOVERY_SERVICES, discover, loopbackTransport, realTransport, transportFromEnv } from './onboard/discover.ts';
export type { Discovery, DiscoveryTransport, Found } from './onboard/discover.ts';
export { decodeMessage as decodeMdns, encodeQuery as encodeMdnsQuery, encodeResponse as encodeMdnsResponse } from './onboard/mdns.ts';
export type { Answer as MdnsAnswer } from './onboard/mdns.ts';
export { findSources, importSources } from './onboard/sources.ts';
export type { Imported, Source as ImportSource } from './onboard/sources.ts';
export { FIRST_ACTIONS, firstAction } from './onboard/first.ts';
export type { FirstAction, FirstView } from './onboard/first.ts';
// The ingest gate (Amendment 2026-10-30-C Part 3): what Era 2's agent loop screens with, escapes
// with, and says when something is blocked.
export { Ingest, BLOCK_LINE, DEFAULT_LINK_CAPS, PROTOCOL_NAMES, KIND_WORDS, cleanOrigin, escapeProtocol, fold, wrapData } from './ingest/index.ts';
export type { Screened, Source as IngestSource, SourceKind, Taint, Verdict, Candidate as MemoryCandidate, Hold } from './ingest/index.ts';
// Grounding: what this Nova is, from its own registries, for the chat agent's briefing and tools.
export { IMPORT_DIR } from './self.ts';
export type { Self, Era2State } from './self.ts';
// The eval harness (Amendment 2026-10-31-B Part 4): graders, suites, the model-swap scorecard.
export * as evals from './evals/index.ts';
// Hard caps on autonomy cost (Amendment 2026-10-31-B Part 5): ceilings, the meter, the loop detector.
export { Caps, Meter, DEFAULT_LIMITS, LOOP, CHARS_PER_TOKEN, SPEND_DIR, signature, weightOf, capsRoutes } from './caps/index.ts';
export type { Limits, Ceilings, Spend, Stop } from './caps/index.ts';
// One-click diagnostics, redacted by construction (Amendment 2026-10-31-B Part 6).
export { buildDiagnostics, diagnosticsRoutes, knownSecrets, Scrubber, formsOf, MARKER as DIAGNOSTICS_MARKER, RULE as DIAGNOSTICS_RULE } from './diagnostics/index.ts';

export interface CoreOptions {
  home: string;
  version: string;
  trustedOrigin: (host: string) => boolean;
  detectedTimezone?: string;
  // Where the chat model sends conversations, so setup can say so truthfully.
  chat?: { program: string; egress: Egress };
  // Workers from outside the core (Era 2's chat-run), run through the same ledger and gates.
  workers?: LanedWorker[];
  // Confirmation checkers by system, for systems Nova can read itself ("nova-sessions").
  confirmations?: Record<string, Checker>;
  // Where the built-in design systems live; defaults to design-systems/ in the repo.
  designSystems?: string;
  // The mesh listener, when there is one: where devices reach Nova, and what carries it.
  mesh?: MeshListenerInfo | null;
  // Where this hub runs (M10h, the capture data path's privacy rule): one of the person's own
  // machines, or a cloud site. NOVA_MESH_SITE=cloud by default; tests say it directly.
  site?: () => 'home' | 'cloud';
  // How long a raw capture fetch waits for its device (tests: short).
  captureRawWaitMs?: number;
  // Where the vault's key lives (vault.ts): NOVA_VAULT_KEY by default; tests inject a keychain.
  vault?: { mode?: KeyMode; keychain?: ((account: string) => KeyStore | null) | null };
  // Nova Computer (M10a), for tests: another adapter than Docker, whose home folder a project may
  // never be, which addresses the egress proxy counts as public, smaller disk caps, and a label
  // for the containers.
  computer?: Pick<ComputerOptions, 'computer' | 'userHome' | 'egressAllow' | 'limits' | 'labels'>;
  // Coding through chat (M10c), for tests: whose home folder a repository may never be, and shorter
  // timeouts for the test run and the preview.
  coding?: Pick<CodingOptions, 'userHome' | 'testTimeoutS' | 'previewTimeoutS'>;
  // Infrastructure through chat (M10d), for tests: the PATH the plan/apply tool is found on (the
  // stand-in's), whose home folder a project may never be, and the tool's timeout.
  infra?: Pick<InfraOptions, 'path' | 'userHome' | 'timeoutS'>;
  // Networking through chat (M10d), for tests: the dead-man's switch's window in milliseconds.
  network?: Pick<NetworkOptions, 'windowMs' | 'target' | 'retryMs'>;
  // The ports of Nova's own listeners (console and mesh), which a browser task never reaches.
  hubPorts?: () => number[];
  // How the browser worker starts a browser: Chromium, or a stand-in in tests.
  browserLaunch?: BrowserOptions['launch'];
  // Home Assistant's reconnect pauses and timeouts (tests shorten them).
  homeAssistant?: HomeAssistantOptions;
  // The model command Era 2 chats with (agent_cmd, agent_egress): the custom-cli provider (M5a).
  agent?: { command: string; egress: Egress };
  // A secret by name (secret://NAME), for providers that need one; the vault (M5b) answers it.
  secrets?: (name: string) => string | null;
  // Capture (M6a): how often the adapters pull (NOVA_CAPTURE_POLL_MS, else 10 s), and the fetch
  // they use (tests).
  capture?: { pollMs?: number; fetch?: typeof fetch };
  // The local model manager (M6b): where the hub's Ollama answers by default, and (tests) a fixed
  // hardware reading and quicker watch and wake polls.
  models?: { ollamaUrl?: string; hardware?: () => Promise<Hardware>; watchMs?: number; wakePollMs?: number };
  // The Decision Service (DS1), for tests: a verdict store in place of the committed eval verdicts
  // (src/core/decision-service/tev1-verdicts.json), so a stand-in seat can be trusted or not.
  decisions?: { verdicts?: VerdictStore };
  // The supervisor that started this server, when one did (resilience/link.ts: ipcLink).
  supervisor?: SupervisorLink | null;
  // Supplied only by the private supervisor bootstrap; legacy consumers remain on vault.ts.
  broker?: BrokerClient | null;
  // Fixed public source supplied by server.js; never a caller-selected file or broker import.
  sealModule?: () => string;
  // Trusted adapter only; no cluster is invented or contacted when absent.
  topologyCluster?: () => ClusterObservation | null | Promise<ClusterObservation | null>;
  // Onboarding (M10f): a stand-in OS detection (NOVA_DETECT_OS), discovery's transport (stand-ins on
  // loopback in tests; the real one sends one multicast query, only when the person asks), and the
  // person's own home folder, where import sources are found.
  onboarding?: { os?: OsFamily | null; transport?: DiscoveryTransport | null; userHome?: string; platform?: string };
  // Resilience (M7b), for tests: the clock watch's monotonic time, and the restore drill's sandbox.
  resilience?: { monotonic?: () => number; drill?: { root?: string; env?: Record<string, string>; timeoutMs?: number }; lookup?: (host: string) => Promise<unknown> };
  // Hub promotion (M10g): what this node reports as its free disk and memory (tests), the window and
  // probe pace (tests and drills; NOVA_PROMOTION_WINDOW_S and NOVA_PROMOTION_PROBE_MS otherwise), and
  // bounds for catch-up and drain.
  promotion?: { hardware?: () => { free_disk: number | null; memory: number }; windowS?: number; probeMs?: number; catchupMs?: number; drainMs?: number; commitMs?: number };
  // This process is a sandbox copy started by the change pipeline (M7a, NOVA_SANDBOX=1): it runs
  // none of the hub's outside work (connectors, capture, models, the heartbeat), takes no changes,
  // and answers the sandbox routes.
  sandbox?: boolean;
  // The change pipeline (M7a), for tests: the monotonic clock its canary windows are measured on.
  changes?: { monotonic?: () => number };
  // Checkpoints (M7 amendment), for tests: the free space where they go.
  checkpoints?: { free?: (dir: string) => number | null };
  // Factory reset (M7 amendment §2), for tests: how long the hub waits for devices to hear it, and
  // a hook before each step of finishing one (to stop it part way, as a power cut would).
  reset?: { tellMs?: number; step?: (what: string) => void };
  // What this instance is for (NOVA_INSTANCE): preview, production or development. Said in the
  // agent's briefing.
  instance?: string;
  // Era 2 hands diagnostics numeric counts only, evaluated for each download.
  diagnostics?: { era2: () => Record<string, number> };
  now?: () => Date;
}

export type Core = ReturnType<typeof createCore>;

export function createCore(o: CoreOptions) {
  const started = Date.now();
  const now = o.now ?? (() => new Date());
  // A restore or a factory reset staged before the last stop is applied first, before the database
  // opens; a checkpoint stopped part-way is dropped. A reset that can't finish throws: a half-reset
  // Nova never runs.
  // Nova's mark on its home (home-mark.ts): written when the folder is clearly Nova's.
  if (!o.sandbox) ensureMark(o.home, { now });
  const staged = o.sandbox ? null : finishStaged(o.home, { vaultAt: (home) => new Vault({ home, ...(o.vault ?? {}) }), now, reset: { ...(o.vault ? { vault: o.vault } : {}), ...(o.reset?.step ? { step: o.reset.step } : {}), now } });
  if (!o.sandbox) dropPartials(o.home);
  const db = new Db(join(o.home, 'nova.db'));
  // An automatic checkpoint before a database upgrade, beside the pre-upgrade copy: one that can't
  // be taken stops the upgrade (and so the start), with the reason.
  const migration = db.migrate({
    backupDir: join(o.home, 'backups'), now,
    ...(o.sandbox ? {} : { before: (from: number) => { takeCheckpoint({ home: o.home, db, kind: 'auto', reason: `Before upgrading the database from version ${from}`, version: o.version, now, ...(o.checkpoints?.free ? { free: o.checkpoints.free } : {}) }); } }),
  });
  const log = new Log(db, join(o.home, 'logs', 'nova.log'), now);
  // What a staged restore couldn't do (or did, with a full disk) is the person's to know.
  for (const p of staged?.problems ?? []) log.problem('resilience', p);
  // Hub or standby, decided before anything writes: a standby copies the hub's sync log instead
  // of recording its own writes (mesh/promote.ts).
  const place = nodeRole(db, o.home);
  let meshRole: MeshRole | null = null;
  log.local = () => (meshRole ? meshRole.role() : place.role) !== 'hub';
  const profile = new Profile(db, now);
  const caps = new Caps({
    home: o.home, profile, now,
    timezone: () => profile.get<string>('user', 'timezone') ?? o.detectedTimezone ?? 'UTC',
  });
  const workspace = new Workspace(join(o.home, 'workspace'));
  const verifier = new Verifier(workspace, now);
  for (const [system, check] of Object.entries(o.confirmations ?? {})) verifier.registerConfirmation(system, check);
  // Browser work with takeover (M5c): a worker of its own, and the checks for what it proves.
  // Its browser runs here, so it is told where Nova itself listens: this machine's addresses and
  // names, at the console's and the mesh listener's ports (browser/plan.ts, `Hub`).
  const hubAddress = (): Hub => ({
    ports: o.hubPorts?.() ?? [],
    hosts: [
      hostname(),
      ...(o.mesh?.publicUrl ? [(() => { try { return new URL(o.mesh!.publicUrl).hostname; } catch { return ''; } })()] : []),
      ...Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((a) => a.address)),
    ].filter(Boolean),
  });
  // Page reads are screened by the ingest gate (wired below) as they are taken.
  const browser = new Browser({ home: o.home, log, now, hub: hubAddress, ...(o.browserLaunch ? { launch: o.browserLaunch } : {}), screen: (r) => ingest.screen({ text: r.text, source: { kind: 'web', origin: r.origin, ref: r.ref } }) });
  const browserChecks = browserCheckers(o.home);
  verifier.registerKind('screenshot', browserChecks.screenshot);
  verifier.registerKind('url', browserChecks.url);
  const rules = new RulesProvider();
  const templates = new Templates({ db, verifier, rules, now });
  const ledger = new Ledger({ db, log, verifier, workers: [workspaceWorker(workspace, join(o.home, 'workers', 'workspace')), templates.worker, browser.worker, ...(o.workers ?? [])], defaultPrivacy: () => profile.privacyDefault(), now });
  templates.bind(ledger);
  browser.bind(ledger);
  // Remote decision providers (JevProvider) are registered only once configured; local-only skips them anyway.
  const decisions = new Decisions({ templates, providers: [rules], privacy: () => profile.privacyDefault(), log });
  const triggers = new Triggers({
    db, log, ledger, templates, rules, decisions, now, sandbox: o.sandbox === true,
    policy: () => profile.section('policy') as Policy,
    timezone: () => profile.get<string>('user', 'timezone') ?? o.detectedTimezone ?? 'UTC',
  });
  // Onboarding's view of the rest of Nova (M10f). Everything here is read when setup asks, not now.
  const userHome = o.onboarding?.userHome ?? homedir();
  const deviceOs = o.onboarding?.os ?? detectOs();
  const onboarding: Onboarding = {
    os: () => deviceOs,
    hardware: async () => (models ? await models.hubHardware() : null),
    hubPurposes: () => devices.find(meshIdentity.id)?.purposes ?? [],
    setHubPurposes: (p) => devices.setPurposes(meshIdentity.id, p, { confirm: true, approved: true, by: 'setup' }).device.purposes,
    discover: (scope) => discover({ scope, transport: o.onboarding?.transport ?? realTransport(), now }),
    sources: () => findSources(userHome, o.onboarding?.platform ?? process.platform),
    import: (picked) => importSources(picked, {
      screen: async (text, origin) => { const r = await ingest.screen({ text, source: { kind: 'file', origin } }); return { verdict: r.verdict, taint: r.taint }; },
      screenNow: (text, origin) => { const r = ingest.screenNow({ text, source: { kind: 'file', origin } }); return { verdict: r.verdict, taint: r.taint, flagged: r.flags.some((f) => f.level !== 'note') }; },
      candidate: (c) => { ingest.candidate({ op: 'remember', kind: c.kind, content: c.content, source: c.source, taint: c.taint as Taint[] }); },
      kept: () => new Set([...memory.active().map((r) => r.content.toLowerCase()), ...ingest.candidates().filter((c) => c.op === 'remember' && c.content).map((c) => c.content!.toLowerCase())]),
    }, { userHome, now: now() }),
  };
  const setup = new Setup({ profile, ledger, now, onboarding, ...(o.detectedTimezone ? { detectedTimezone: o.detectedTimezone } : {}), ...(o.chat ? { chat: o.chat } : {}) });
  const extensions = new Extensions({ db, home: o.home, novaVersion: o.version, now });
  const design = new Design({ extensions, profile, ...(o.designSystems ? { dir: o.designSystems } : {}) });
  const backups = new Backups({ dir: join(o.home, 'backups'), log });
  const memory = new Memory({ db, home: o.home, now, afterForget: (ids, records) => backups.forget('memory', ids, records.map((r) => r.content)) });
  // A decision model's receipt is checked against the person's settings as they are at the send.
  // A capture source's own opt-in doesn't exist yet, so it is never on here either.
  const liveDecisionOptIn = (f: 'screening' | 'box' | 'capture'): boolean => { if (f === 'capture') return false; const v = validateSettings(profile.get<unknown>('models', 'decision') ?? {}); return v.ok && v.settings.opt_in[f]; };
  const receipts = new Receipts({ db, log, now, live: { mode: () => profile.privacyDefault(), optIn: liveDecisionOptIn } });
  for (const p of design.ensureBuiltins()) log.problem('design', p);
  // Providers (M5a): each enabled one is a ledger worker. A model on one of the person's own
  // devices counts as local.
  const meshHosts = () => new Set([
    ...(o.mesh?.publicUrl ? [o.mesh.publicUrl] : []),
    ...db.all<{ address: string | null }>("SELECT address FROM device WHERE trust = 'trusted' AND address IS NOT NULL").map((d) => d.address!),
  ].map((a) => { try { return new URL(a.includes('://') ? a : `http://${a}`).hostname.replace(/^\[|\]$/g, ''); } catch { return ''; } }).filter(Boolean));
  // The vault (M5b): secrets by name, encrypted at rest. Providers name theirs secret://NAME, kept
  // as provider/NAME; `o.secrets` (server.js: NOVA_SECRET_<NAME>) is a fallback for development
  // and tests only, and anything it answers is redacted like a vault value.
  const vault = new Vault({ home: o.home, ...(o.vault ?? {}) });
  const providerSecret = (name: string): string | null => {
    let v: string | null = null;
    try { v = vault.get(`provider/${name}`); } catch { /* a vault that won't open: its problem shows in health */ }
    if (v === null && o.secrets) {
      v = o.secrets(name);
      if (v) addSecretValue(v);
    }
    return v;
  };
  // The model manager (M6b) is made once the device registry exists (below); providers reach it
  // through these, for a provider set to a role and for cloud budgets.
  let models: Models | null = null;
  // The Decision Service (DS1) is made once the model manager exists (below); the model manager's
  // device record and refresh reach it through this.
  let ds: ReturnType<typeof createDecisionService> | null = null;
  // Made once the ledger's other parts exist (below); capture asks it whether retention may run.
  let resilience: Resilience | null = null;
  const providers = new Providers({
    db, log, home: o.home, workspace, extensions, ledger, verifier, receipts, profile, now,
    custom: o.agent, secret: providerSecret, meshHost: (h) => meshHosts().has(h),
    fire: (input) => triggers.fire(input),
    models: { infer: (r) => models!.infer(r), probe: (role) => models!.probe(role), cloudName: () => models?.cloud()?.name ?? null },
    budget: (brief) => models?.budgetBlock(brief.task_id, brief.constraints.max_cost_usd) ?? null,
  });
  // The device mesh: this node's keys, the registry, enrollment, and who may do what.
  const meshInfo = o.mesh ?? null;
  const publicUrl = () => meshInfo?.publicUrl ?? null;
  // This node's own mesh address, where other nodes reach it directly (M10g): apart from the stable
  // name only when the server says so (NOVA_MESH_ADDRESS, or the address it listens on).
  const meshAddress = () => meshInfo?.address ?? null;
  const meshIdentity = loadIdentity(o.home, { now, warn: (m) => log.problem('mesh', m), adopt: place.file?.device_id ?? null });
  const devices = new Devices({ db, log, identity: meshIdentity, now, publicUrl });
  if (place.role === 'hub') devices.ensureHub();
  // The local model manager (M6b): hardware, roles, downloads, the inference API, wake, budgets.
  models = new Models({
    db, log, profile, ledger, verifier, receipts, devices, now,
    hubName: () => devices.find(meshIdentity.id)?.name ?? 'This hub',
    ...(o.models?.ollamaUrl ? { ollamaUrl: o.models.ollamaUrl } : {}),
    ...(o.models?.hardware ? { hardware: o.models.hardware } : {}),
    ...(o.models?.watchMs ? { watchMs: o.models.watchMs } : {}),
    ...(o.models?.wakePollMs ? { wakePollMs: o.models.wakePollMs } : {}),
    diskPath: o.home,
    meshHost: (h) => meshHosts().has(h),
    secret: (v) => { const n = secretName(v); return n ? providerSecret(n) : null; },
    // The person is told the way proactive messages go: triaged, quiet hours kept.
    notify: (key, text) => { void triggers.fire({ class: 'proactive', source: 'models', name: 'Local models', payload: { key }, dedup_key: key, action: { kind: 'message', text } }).catch((e) => log.warn('models', 'Nova couldn’t tell you about waiting work.', { error: (e as Error).message })); },
    // The device record's decision model (DS1 NOTE 4), and a newly pulled Tev1 seen without a restart.
    decisionModel: () => { const d = ds?.tev1(); return d ? { model: d.model, digest: d.digest, why: d.available ? d.size_why : d.why } : null; },
    refreshed: () => ds?.refresh() ?? Promise.resolve(),
  });
  ledger.workers.set(models.worker.id, models.worker);
  // The model-swap scorecards (Amendment B Part 4): files under workers/evals/, read by Settings ›
  // Models before a switch.
  const scorecards = new Scorecards(o.home);
  // System 1 on the local sorting model (ADR-7): asked first once one is assigned; the rules answer
  // when it isn't, or can't.
  // The person's policy still binds it: what the triage rule decides from a hard setting (a category
  // turned off, quiet hours for a message) a model's answer may not overturn; it escalates instead.
  const triageGuard = (t: { template_id: string }, inputs: Record<string, unknown>, answers: Record<string, unknown>) => {
    if (t.template_id !== TRIAGE.template_id) return null;
    const hard = inputs.category_off === true || (inputs.quiet_hours === true && inputs.action === 'message');
    const rule = triageRule(inputs as never).answers.decision;
    return hard && answers.decision !== rule ? `your settings say “${rule}” here (${inputs.category_off ? 'this is turned off' : 'quiet hours'}).` : null;
  };
  const localModel = new LocalModelProvider({ infer: (r) => models!.infer(r), ready: (t) => models!.decidesWithModel(rules.has(t.template_id)), guard: triageGuard });
  decisions.register(localModel, { first: true });
  // The Decision Service (DS1, docs/plans/ds1.md): every System One question about outside content
  // goes through it. Its seats are Tev1 on the hub's Ollama, cloud Jev on the route the person
  // chose (its key in the vault as decisions.jev, read at call time), and the sorting model above
  // until a decision model passes a template's eval. It routes by the live privacy mode and the
  // person's opt-ins, records every decision (decision_record, no content), and takes a receipt
  // BEFORE anything goes to the cloud, so a refused receipt stops the send.
  const decisionSettings = (): DecisionSettings => {
    const v = validateSettings(profile.get<unknown>('models', 'decision') ?? {});
    return v.ok ? v.settings : DEFAULT_DECISION_SETTINGS;
  };
  // This home's own key for hashing captured text (review finding 8): the decision record's state hash
  // of capture text, and the capture screening cache's keys, are HMACs with it, so a short text can't
  // be confirmed by guessing. Kept in the vault; none (no hash kept, no cache) when the vault can't
  // be read.
  let homeKey: Buffer | null = null;
  const captureKey = (): Buffer | null => {
    if (homeKey) return homeKey;
    try {
      let v = vault.get('capture/hash-key');
      if (!v) { v = randomBytes(32).toString('hex'); vault.put('capture/hash-key', v); }
      homeKey = Buffer.from(v, 'hex');
    } catch { return null; }
    return homeKey;
  };
  const decisionLog = new DbLog(db, { onError: (e) => log.warn('decisions', 'Nova couldn’t write a decision record.', { error: e.message }) });
  ds = createDecisionService({
    settings: decisionSettings,
    privacy: () => profile.privacyDefault(),
    log: decisionLog,
    stateKey: captureKey,
    ollamaUrl: () => models!.hubUrl(),
    hardware: () => models!.hubHardware(),
    jevKey: () => { try { return vault.get('decisions.jev') ?? null; } catch { return null; } },
    legacy: { provider: localModel, old: (id) => templates.get(id) },
    // The receipt names the task and the hash of what was judged (never the content).
    receipt: (r) => { receipts.record({ task_id: r.task_id ?? undefined, provider: 'jev', model: r.model, purpose: r.purpose, privacy_mode: r.privacy_mode, egress: r.egress, context_items: [{ kind: 'outside', ref: r.purpose, sha256: r.state_sha256 }], ...(r.opt_in ? { opt_in: r.opt_in } : {}) }); },
    ...(o.decisions?.verdicts ? { verdicts: o.decisions.verdicts } : {}),
    now,
  });
  const decisionService = ds;
  if (!o.sandbox) void decisionService.refresh().catch(() => {});
  // The ingest security gate (Amendment 2026-10-30-C Part 3): every read of outside content is
  // screened before a model acts on it. The Noul screen asks the Decision Service for ingest-screen,
  // one fenced chunk at a time, and uses an answer only when the service trusts it; otherwise the
  // deterministic layer plus quarantine decide. The outbound guard knows the vault's values, memory
  // and the standing files.
  const { ingest } = wireIngest({
    db, log, home: o.home, now, templates, ledger, verifier,
    // The screen is never looser than the run's or the task's own mode: the strictest of the mode
    // the caller names, the mode of the ledger task it runs inside, and (in the service) the
    // person's setting. The task is named on the record and the receipt.
    ask: (fields, a) => {
      const ctx = TASK_CONTEXT.getStore();
      const task_id = a?.task_id ?? ctx?.task_id ?? null;
      let taskMode: PrivacyModeOf | undefined = ctx?.task_id === task_id ? ctx?.privacy_mode : undefined;
      if (!taskMode && task_id) { try { taskMode = ledger.get(task_id).privacy_mode; } catch { /* not a ledger task */ } }
      const modes = [a?.privacy_mode, taskMode].filter((m): m is PrivacyModeOf => !!m);
      const privacy_mode = modes.length ? modes.reduce((x, y) => stricter(x, y)) : undefined;
      return decisionService.service.ask('ingest-screen', fields, {
        subsystem: 'ingest', task_id, shadow: a?.shadow ?? true,
        ...(privacy_mode ? { privacy_mode } : {}),
        ...(a?.content_class ? { content_class: a.content_class } : {}), ...(a?.capture_source ? { capture_source: a.capture_source } : {}),
      });
    },
    screening: () => decisionService.standing('ingest-screen'),
    infer: (r) => models!.infer(r),
    // An unavailable vault or an entry disappearing during enumeration is an incomplete scan,
    // never evidence that no secrets exist. The outbound guard refuses until it can check again.
    secrets: () => vault.list().map((n) => {
      const value = vault.get(n);
      if (typeof value !== 'string') throw new CoreError('conflict', 'The vault changed while checking saved passwords or keys. Try again.');
      return value;
    }),
    memory: () => memory.active().map((r) => r.content),
  });
  // Nova Browser (M10b): sign-ins from the vault, the co-pilot on the local sorting model (Noul,
  // through the decision stack, forced local-only), site templates through the template path, and
  // the ingest screen for every dialog and every co-pilot input.
  browser.wire({
    db, vault, templates, rules, decisions,
    screen: async (text, origin, ref) => {
      const r = await ingest.screen({ text, source: { kind: 'web', origin, ref } });
      return { id: r.id, verdict: r.verdict, flags: r.flags, extract: r.extract };
    },
    copilotReady: () => models!.decidesWithModel(false), providerId: LOCAL_MODEL_PROVIDER,
  });
  // Nova Computer (M10a): workspaces as containers on this machine, each action a ledger task; a
  // command's output is screened by the ingest gate as tool output.
  const computer = new NovaComputer({
    db, log, home: o.home, ledger, verifier, now, privacy: () => profile.privacyDefault(),
    screen: (r) => ingest.screen({ text: r.text, source: { kind: 'tool', origin: r.origin, ref: r.ref } }),
    ...(o.computer ?? {}),
  });
  ledger.workers.set(computer.worker.id, computer.worker);
  // Coding through chat (M10c): a coding request as a run of ledger tasks (write, check, merge),
  // its agent through the provider registry, its worktree Nova's own, its merge tier 3. The person is
  // told as a proactive message, through the trigger engine.
  const coding = new Coding({
    db, log, home: o.home, ledger, verifier, providers, now, privacy: () => profile.privacyDefault(),
    ...(o.coding ?? {}),
    notify: (key, text) => { void triggers.fire({ class: 'proactive', source: 'coding', name: 'Coding', payload: { key }, dedup_key: key, action: { kind: 'message', text } }).catch((e) => log.warn('coding', 'Nova couldn’t tell you about a coding run.', { error: (e as Error).message })); },
  });
  ledger.workers.set(coding.worker.id, coding.worker);
  const enroll = new Enrollment({ db, log, devices, identity: meshIdentity, now, publicUrl });
  const access = new Access({ devices, mesh: meshInfo });
  // Hub, standby and sync (M4 plan §3).
  const sync = new SyncLog({ db, log, home: o.home, node: meshIdentity.id, now });
  memory.onForgetDone((records) => sync.forgotten(records.map((r) => r.content)));
  // A standby gets the vault sealed through sync.
  sync.vault = vault;
  vault.on('change', () => {
    try { sync.vaultChanged(); } catch (e) { log.problem('sync', 'Nova couldn’t record a change to its vault for the standby.', { detail: (e as Error)?.stack ?? String(e) }); }
  });
  meshRole = new MeshRole({
    db, log, home: o.home, now, publicUrl, address: meshAddress, identity: meshIdentity, devices, access, sync, ledger, verifier, file: place.file,
    becameHub: () => startHub(), becameStandby: () => stopHub(),
    forgotten: (rows) => memory.forgottenElsewhere(rows),
    forget: (id, by) => { try { memory.forget(id, by); return true; } catch (e) { if (e instanceof CoreError && e.code === 'not_found') return false; throw e; } },
    failoverAfterS: () => { const v = profile.get<number>('mesh', 'auto_failover_after_s'); return typeof v === 'number' && v > 0 ? v : null; },
    // The hub was factory reset: this standby wipes its copy (resilience/reset.ts).
    hubReset: (notice) => reset.standbyWipe(notice),
  });
  const role = meshRole;
  // Checkpoints (M7 amendment §1) and restarting in place, for a restore (and a factory reset).
  const restarter = new Restarter({ supervisor: o.supervisor ?? null, log });
  const checkpoints = new Checkpoints({
    db, log, home: o.home, version: o.version, now, ledger, verifier, vault,
    vaultAt: (home) => new Vault({ home, ...(o.vault ?? {}) }),
    hubId: () => meshIdentity.id, role: () => role.role(), schema: () => loadMigrations().at(-1)?.version ?? 0, restarter,
    ...(o.checkpoints?.free ? { free: o.checkpoints.free } : {}),
  });
  ledger.workers.set(checkpoints.worker.id, checkpoints.worker);
  // Infrastructure through chat (M10d): plan (tier 1), then apply (tier 3) of exactly the reviewed
  // plan, inside the project's budget, after a checkpoint. Alerts are problems and messages.
  const infra = new Infra({
    db, log, home: o.home, ledger, verifier, vault, now, privacy: () => profile.privacyDefault(),
    checkpoint: (reason) => checkpoints.auto(reason),
    ...(o.infra ?? {}),
    notify: (key, text) => { void triggers.fire({ class: 'proactive', source: 'infra', name: 'Infrastructure', payload: { key }, dedup_key: key, action: { kind: 'message', text } }).catch((e) => log.warn('infra', 'Nova couldn’t tell you about an infrastructure run.', { error: (e as Error).message })); },
  });
  ledger.workers.set(infra.worker.id, infra.worker);
  // Networking through chat (M10d): snapshot and diff (tier 1), apply (tier 3) after a checkpoint,
  // then the dead-man's switch on the device mesh: no contact from the person's devices within the
  // window (mesh.contact_window_s), and Nova puts the snapshot back by itself.
  const network = new Network({
    db, log, home: o.home, ledger, verifier, vault, devices, now, privacy: () => profile.privacyDefault(),
    checkpoint: (reason) => checkpoints.auto(reason),
    windowS: () => { const v = profile.get<number>('mesh', 'contact_window_s'); return typeof v === 'number' ? v : 300; },
    contactKinds: () => profile.get<unknown>('mesh', 'contact_kinds'),
    ...(o.network ?? {}),
    notify: (key, text) => { void triggers.fire({ class: 'proactive', source: 'network', name: 'Network', payload: { key }, dedup_key: key, action: { kind: 'message', text } }).catch((e) => log.warn('network', 'Nova couldn’t tell you about a network change.', { error: (e as Error).message })); },
  });
  ledger.workers.set(network.worker.id, network.worker);
  // Every forget reaches each checkpoint (and a restore that is staged).
  backups.also((table, ids, words) => checkpoints.forget(table, ids, words));
  // The change pipeline and the foundry (M7a): changes to Nova go through gates, never live edits.
  const changes = new Changes({
    db, log, ledger, verifier, home: o.home, now, sandbox: o.sandbox === true, testClock: process.env.NOVA_TEST_CLOCK === '1',
    // An automatic checkpoint before a change goes live: none, and it doesn't ship.
    checkpoint: (reason) => { checkpoints.auto(reason); },
    routes: () => routes, health: () => health(), hubDevice: () => meshIdentity.id, privacy: () => profile.privacyDefault(),
    knownDevice: (id) => id === meshIdentity.id || devices.find(id)?.trust === 'trusted',
    // The canary's window on a clock that only moves forward. An injected clock (tests) is the
    // only clock there is, so it stands in unless a test gives one of its own.
    ...(o.changes?.monotonic ? { monotonic: o.changes.monotonic } : o.now ? { monotonic: () => now().getTime() } : {}),
    live: {
      db, extensions, design, profile, triggers, templates, ledger, now, novaVersion: o.version,
      timezone: () => profile.get<string>('user', 'timezone') ?? o.detectedTimezone ?? 'UTC',
      workerEgress: (owner) => { const w = ledger.workers.get(owner); return w ? w.egress : null; },
    },
  });
  ledger.workers.set(changes.worker.id, changes.worker);
  const foundry = new Foundry({
    home: o.home, ledger, changes, receipts, privacy: () => profile.privacyDefault(),
    infer: (r) => models!.infer(r) as never, chat: () => providers.chat(),
  });
  ledger.workers.set(foundry.worker.id, foundry.worker);
  // Whether a model trusted for capture-sensitive can answer on this device now, and if not, what
  // stands in the way, in plain words (the holding area's notice, option B).
  const captureScreening = (): { trusted: boolean; why: string } => {
    if (decisionService.standing(SCREEN_TEMPLATE).relied) return { trusted: true, why: '' };
    const d = decisionService.tev1();
    if (!decisionSettings().tev1) return { trusted: false, why: 'Tev1 is switched off in Settings › Models.' };
    if (!d.available || !d.model) return { trusted: false, why: d.why };
    return { trusted: false, why: d.model === 'tev1:4b' ? 'This build of Tev1 4B hasn’t passed the check for captured text, so its answers aren’t relied on.' : `${d.model} is installed, but it didn’t pass the check for captured text; Tev1 4B did.` };
  };
  // Capture (M6a): consent, storage on the hub, classification, promotion; Screenpipe pulled, and
  // device agents' capture events through the inbox below.
  // The capture data path (M10h) is made once capture is; capture's forget reaches it from here.
  let captureSync: CaptureSync | null = null;
  const capture = new Capture({
    db, log, profile, memory, backups, decisions, templates, now,
    self: () => meshIdentity.id,
    deviceName: (id) => devices.find(id)?.name ?? null,
    timezone: () => profile.get<string>('user', 'timezone') ?? o.detectedTimezone ?? 'UTC',
    privacy: () => profile.privacyDefault(),
    meshHosts: () => [...meshHosts()],
    // Capture from a paired computer needs its capture-source role (M10f). The hub's own Screenpipe
    // isn't a device source.
    mayCapture: (id) => {
      const d = devices.find(id);
      if (!d || d.role === 'hub' || d.purposes.includes('capture-source')) return null;
      return `${d.name} isn’t a capture source, so Nova takes no capture from it. Give it the Capture source role in Settings › Devices first.`;
    },
    fire: (topic, payload, key) => triggers.connectorEvent('capture', topic, payload, key),
    proposer: () => (models!.decidesWithModel(rules.has(PROMOTE.template_id)) ? LOCAL_MODEL_PROVIDER : null),
    // Captured text is screened before triage reads it: audio and meetings as transcripts, the rest
    // as screen text (OCR).
    // Capture-derived text: never to a cloud seat until the owner's per-source opt-in exists (§2.1).
    screen: (r) => ingest.screen({ text: r.text, from: 'capture', source: { kind: r.kind === 'audio' || r.kind === 'meeting' ? 'transcript' : 'ocr', origin: r.origin } }),
    // Screening, job 1 (capture-sensitive; owner decision, decision-service.md §2.1): asked with the
    // capture source, so the service's one capture rule routes it: never a cloud seat in local-first
    // or local-only, and in cloud mode only with that source's own opt-in, which isn't built (the
    // service is given no captureCloud, so it is never on). No evidence-only asks of an untrusted
    // seat: an answer nobody trusts holds the event anyway (option B).
    sensitive: (fields, a) => decisionService.service.ask(SCREEN_TEMPLATE, fields, { subsystem: 'capture', capture_source: a.capture_source, shadow: false }),
    screening: () => captureScreening(),
    hashKey: captureKey,
    records: { forget: (ids) => decisionLog.forget(ids), prune: (before) => decisionLog.prune('capture', before) },
    // The capture data path (M10h): a forget of what came from a spoke goes to that spoke too.
    forgotten: (rows) => captureSync?.issue(rows) ?? [],
    removed: (ids) => captureSync?.forgetRaw(ids),
    pollMs: o.capture?.pollMs ?? (Number(process.env.NOVA_CAPTURE_POLL_MS) || 10_000),
    retentionHold: () => resilience?.retentionHeld() ?? null,
    secrets: vault,
    ...(o.capture?.fetch ? { fetch: o.capture.fetch } : {}),
  });
  // A forgotten memory takes the capture it was promoted from with it; on a standby, what the hub
  // forgot or swept is cleaned from this node's backups too.
  memory.onForget((records) => capture.memoryForgotten(records));
  sync.forgetting.set('capture_event', (rows) => capture.forgottenElsewhere(rows));
  // Computers' device agents (M4b): heartbeats, the inbox their queues flush into, the runtime.
  const configRow = (section: string, key: string) => db.get<{ value: string; updated_at: string }>('SELECT value, updated_at FROM profile WHERE section = ? AND key = ?', section, key);
  // A setting's version: its time and value together, so two changes in one millisecond differ.
  const configVersion = (r: { value: string; updated_at: string }) => createHash('sha256').update(`${r.updated_at}\0${r.value}`).digest('hex').slice(0, 16);
  // A device note's first screen, from the check before the inbox writes, reused when it is kept.
  const noteScreens = new WeakMap<object, ReturnType<typeof ingest.screenNow>>();
  // Native workloads on devices (M10h): the `device` driver signs each device's manifests with this
  // node's key and turns heartbeats into status. Each device has a Service Manager of its own, with
  // its own registry, so one service (Screenpipe) can run on several devices, each with its own
  // versions, promotions and rollbacks, at the same tiers.
  const deviceWorkloads = new DeviceWorkloads({
    db, log, now, sign: (m) => meshIdentity.sign(m), publicKey: () => meshIdentity.publicKey, epoch: () => devices.state().epoch, hubId: () => meshIdentity.id,
    devices: () => placementDevicesNow(),
  });
  const deviceManagers = new Map<string, ServiceManager>();
  const deviceServices = (deviceId: string): ServiceManager => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(deviceId) || !devices.find(deviceId)) throw new CoreError('not_found', 'There is no such device.');
    let m = deviceManagers.get(deviceId);
    if (!m) {
      m = new ServiceManager({
        dir: join(o.home, 'services', 'devices', deviceId), drivers: [], remote: deviceWorkloads.driver(deviceId),
        placement: () => ({ devices: placementDevicesNow(), hubId: meshIdentity.id }),
        devices: () => {
          const views = placementDevicesNow().filter((d) => d.trust === 'trusted').map((d) => ({ id: d.id, platform: d.platform, roles: [...d.purposes] }));
          const hubView = views.find((d) => d.id === meshIdentity.id);
          return hubView ? [...views, { ...hubView, id: 'hub' }] : views;
        },
      });
      deviceManagers.set(deviceId, m);
    }
    return m;
  };
  captureSync = new CaptureSync({
    db, log, home: o.home, now, capture, devices, ledger, verifier, hubId: () => meshIdentity.id,
    site: o.site ?? (() => (process.env.NOVA_MESH_SITE === 'cloud' ? 'cloud' : 'home')),
    privacy: () => profile.privacyDefault(),
    timezone: () => profile.get<string>('user', 'timezone') ?? o.detectedTimezone ?? 'UTC',
    ...(o.captureRawWaitMs ? { rawWaitMs: o.captureRawWaitMs } : {}),
  });
  const spokes = new Spokes({
    db, log, devices, identity: meshIdentity, now, version: o.version,
    effects: {
      workloads: {
        report: (d, reports) => deviceWorkloads.report(d.id, reports),
        answer: (d) => ({ workloads: deviceWorkloads.assignments(d.id) }),
      },
      task: (d, key, body) => {
        const task = ledger.create({ ...(body as unknown as TaskInput), origin: { kind: 'device', ref: d.id }, idempotency_key: `device:${d.id}:${key}` });
        triggers.reactive(task, `device:${d.id}`);
        return task;
      },
      // A device's note is outside content: it never becomes memory without the person's OK
      // (Amendment 2026-10-30-C Part 3.6). Every one waits as a memory candidate, out of every
      // prompt, the same queue as memory from a conversation that read outside content.
      memory: (d, body) => {
        const content = String((body as { content?: unknown }).content ?? '');
        const kind = (body.kind ?? 'fact') as MemoryKind;
        const first = noteScreens.get(body) ?? ingest.screenNow({ text: content, source: { kind: 'connector', origin: `device:${d.id}` } });
        return { id: ingest.candidate({ op: 'remember', kind, content, source: `device:${d.id}`, taint: [first.taint] }) };
      },
      // A device's note is screened by Nova's own checks before it is kept (the inbox can't wait for
      // a model): one that tries to give instructions is refused.
      screenNote: (d, body) => {
        const s = ingest.screenNow({ text: String((body as { content?: unknown }).content ?? ''), source: { kind: 'connector', origin: `device:${d.id}` } });
        noteScreens.set(body, s);
        return s.verdict === 'block' ? 'Nova didn’t keep this note: it looked like it was trying to give instructions.' : null;
      },
      capture: (d, key, body) => capture.fromDevice(d, key, body),
      config: {
        read: (section, key) => { const r = configRow(section, key); return r ? { value: JSON.parse(r.value), version: configVersion(r) } : null; },
        write: (section, key, value) => { profile.set(section as Section, key, value, 'settings'); return configVersion(configRow(section, key)!); },
      },
    },
  });

  // Connectors (M5b): Home Assistant is built in; Era 2's Gmail registers itself (server.js).
  const connectors = new Connectors({
    extensions, vault, triggers, log, now,
    privacy: () => profile.privacyDefault(),
    meshHosts: () => devices.list().flatMap((d) => { try { return d.address ? [new URL(d.address).hostname.replace(/^\[|\]$/g, '')] : []; } catch { return []; } }),
    delegate: (owner, input) => {
      const task = ledger.create({ ...input, owner, origin: { kind: 'user' } } as TaskInput);
      triggers.reactive(task, `connector:${owner}`);
      return task;
    },
    addWorker: (w) => { ledger.workers.set(w.id, w); },
    addConfirmation: (system, check) => verifier.registerConfirmation(system, check),
  });
  connectors.register(homeAssistant(o.homeAssistant));
  // Resilience (M7b): nightly backups and the restore drill as ledger work, repair playbooks, the
  // clock watch, and what the supervisor says.
  resilience = new Resilience({
    db, log, home: o.home, version: o.version, profile, ledger, verifier, triggers, vault, backups, now,
    migrations: () => loadMigrations(), supervisor: o.supervisor ?? null,
    ...(o.resilience?.monotonic ? { monotonic: o.resilience.monotonic } : {}), ...(o.resilience?.drill ? { drill: o.resilience.drill } : {}),
  });
  const keep = resilience;
  ledger.workers.set(keep.worker.id, keep.worker);
  // Hub promotion (M10g): planned, from Settings › Devices on the hub, and emergency, from the latest
  // backup on a hub candidate whose hub is gone. The stable name moves through a driver only when one
  // is configured (NOVA_MESH_NAME_CONTROL; only a loopback stand-in in this build).
  const nameControl = process.env.NOVA_MESH_NAME_CONTROL;
  const promotions = new Promotions({
    db, log, home: o.home, now, version: o.version, identity: meshIdentity, devices, role, sync, ledger, verifier,
    publicUrl, address: meshAddress, schema: () => db.version(),
    stopWork: () => stopHub(), startWork: () => { startHub(); },
    backup: () => {
      const b = db.get<{ at: string; path: string | null }>('SELECT at, path FROM backup_run WHERE ok = 1 ORDER BY seq DESC LIMIT 1');
      if (!b) return null;
      const drilled = !!b.path && !!db.get('SELECT 1 FROM backup_drill WHERE ok = 1 AND backup_id = ?', b.path);
      return { at: b.at, path: b.path, drilled };
    },
    name: nameControl && publicUrl() ? httpStableName(nameControl, publicUrl()!, process.env.NOVA_MESH_NAME_TOKEN) : null,
    ...(o.promotion ?? {}),
    inflight: () => inflightWrites,
    quiet: (on) => { devices.quiet = on; },
    keep: (name) => { const v = checkpoints.take({ kind: 'named', name }); return { id: v.id, label: v.label }; },
    pause: (k) => ledger.pause(k),
    vaultNames: () => (vault.status().ok ? vault.list() : []),
    cold: {
      drill: (dir) => runDrill({ live: db, backupDir: dir, source: 'folder', migrations: loadMigrations(), ...(o.resilience?.drill?.root ? { root: o.resilience.drill.root } : {}), ...(o.resilience?.drill?.env ? { sandboxEnv: o.resilience.drill.env } : {}), ...(o.resilience?.drill?.timeoutMs ? { timeoutMs: o.resilience.drill.timeoutMs } : {}) }),
      stage: (dir, c) => checkpoints.stageCold(dir, { node: c.node, floor: c.floor, promotion: c.promotion, backup: { id: c.backup.id, seq: c.backup.seq, at: c.backup.at, path: c.backup.path }, by: c.by }),
      restart: (why, failed) => checkpoints.restartStaged(why, failed),
      seal: () => { try { const k = vault.get(SEAL_NAME); return k ? Buffer.from(k, 'base64') : null; } catch { return null; } },
      folder: () => keep.settings().target,
    },
  });
  if (nameControl && publicUrl()) {
    const t = process.env.NOVA_MESH_NAME_TOKEN ?? '';
    let plain = false;
    try { const u = new URL(nameControl); plain = u.protocol !== 'https:' && !/^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/.test(u.hostname); } catch { plain = true; }
    if (!t) log.warn('mesh', 'NOVA_MESH_NAME_CONTROL is set without NOVA_MESH_NAME_TOKEN, so Nova won’t move the stable name: an unauthenticated request must never move it.');
    else if (t.length < 16) log.warn('mesh', 'NOVA_MESH_NAME_TOKEN is shorter than 16 characters, so Nova won’t move the stable name with it. Use a long random token.');
    if (plain) log.warn('mesh', 'NOVA_MESH_NAME_CONTROL is plain http to another machine, so Nova won’t use it: anyone on the way could read the token. Use https, or a control on this machine.');
  }
  // The drill's tap (mesh/tap.ts) writes only in a test or the drill, on a temp home; anywhere else it
  // is refused and said.
  if (process.env.NOVA_DRILL_TAP && !o.sandbox) {
    if (promotionTesting(o.home)) { setTap(process.env.NOVA_DRILL_TAP); log.warn('mesh', 'The promotion drill’s tap is on: what this node receives over the mesh is written to NOVA_DRILL_TAP, with the vault’s key replaced by its digest.', { dir: process.env.NOVA_DRILL_TAP }); drillTap('start', { node: meshIdentity.id }); }
    else { setTap(null); log.warn('mesh', 'NOVA_DRILL_TAP is set, but this isn’t a test or the drill on a temp home, so nothing is tapped.'); }
  }
  // Stops the work: the ledger takes nothing new, every child process stops, running work gets up to
  // `boundMs` to finish (before an in-place restart, a quit, or a factory reset's wipe).
  async function stopWork(boundMs = 5000) {
    ledger.halt('Nova is restarting.');
    await stopChildren(Math.min(3000, boundMs));
    await Promise.race([ledger.idle(), new Promise((r) => setTimeout(r, boundMs).unref())]);
  }
  // Factory reset (M7 amendment §2): the export, the confirmation's list, telling devices, staging.
  const reset = new FactoryReset({
    home: o.home, db, log, version: o.version, now, vault, nightly: keep.nightly, memory, devices, access, spokes, role,
    emit: (event, data) => bus.emit('event', event, data),
    // Restart in place (resilience/restart.ts): the next start finishes the wipe.
    restarter, restorePending: () => stagedPending(o.home), setupDone: () => setup.view().done,
    relayUsed: () => { try { return providers.view('relay').enabled || !!db.get("SELECT 1 FROM task WHERE owner = 'relay' LIMIT 1"); } catch { return false; } },
    // The hub's own work stops too (the heartbeat, so no nightly backup starts), then the queue.
    stopWork: async (ms) => { stopHub(); await stopWork(ms); },
    ...(o.reset?.tellMs ? { tellMs: o.reset.tellMs } : {}),
  });
  wireRepairs(keep.playbooks, { ledger, providers, models, connectors, role, spokes, devices });
  keep.watch(connectorWatch(keep.playbooks, connectors, o.resilience?.lookup));

  // Capture feeds event rules too, as the connector "capture" (topics: capture/routes.ts).
  const connectorCheck = triggers.connectorCheck;
  triggers.connectorCheck = (id, topic) => (id === 'capture' ? capture.topicCheck(topic) : connectorCheck ? connectorCheck(id, topic) : `There is no connector called ${id}.`);
  // A computer that says it can capture offers each kind as a source, off until the person says.
  spokes.on('change', (d: Device) => { try { capture.offer(d); } catch (e) { log.problem('capture', 'Nova couldn’t list what a computer can capture.', { detail: (e as Error)?.stack ?? String(e) }); } });
  // Every change to the privacy setting, or to the devices that count as local, is checked again
  // against what connectors keep open.
  profile.on('change', (c: { section: string }) => { if (c.section === 'privacy') connectors.recheck(); });
  devices.on('change', () => connectors.recheck());

  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  connectors.on('change', (c) => bus.emit('event', 'connector', c));
  ledger.on('task', (t) => bus.emit('event', 'task', { id: t.id, title: t.title, state: t.state, reason: t.reason, user_visibility: t.user_visibility }));
  log.on('problem', (p) => bus.emit('event', 'problem', p));
  setup.on('change', (v) => bus.emit('event', 'setup', { step: v.step, done: v.done }));
  profile.on('change', (c) => bus.emit('event', 'profile', c));
  // Loosening the privacy setting releases work that was waiting on local capacity, if its worker
  // is now allowed under the stricter of the task's own mode and the new setting.
  profile.on('change', ({ section, key }) => {
    if (section !== 'privacy' || key !== 'default') return;
    for (const t of ledger.list({ state: 'waiting', limit: 500 })) {
      const w = ledger.workers.get(t.owner);
      if (!w || !t.reason?.includes('local capacity')) continue;
      if (permits(stricter(t.privacy_mode, profile.privacyDefault()), (() => { try { return egressOf(w, t.brief); } catch { return w.egress; } })())) ledger.retry(t.id, 'Your privacy setting changed, so this can run now.');
    }
  });
  extensions.on('change', (c) => bus.emit('event', 'extension', c));
  changes.on('change', (c) => bus.emit('event', 'change', c));
  providers.on('change', (c) => bus.emit('event', 'provider', c));
  // The UI swaps its design-system stylesheet when this arrives: no reload, no restart.
  design.on('change', (c) => bus.emit('event', 'design-system', c));
  triggers.on('trigger', (t) => bus.emit('event', 'trigger', { trigger_id: t.trigger_id, rule_id: t.rule_id, class: t.class, decision: t.triage.decision, reason: t.triage.reason, ledger_task_id: t.ledger_task_id, message_id: t.message_id }));
  triggers.on('message', (m) => bus.emit('event', 'message', m));
  devices.on('change', (c: { action: string; device: Device }) => bus.emit('event', 'device', { action: c.action, device: deviceView(c.device) }));
  spokes.on('change', (d: Device) => bus.emit('event', 'device', { action: 'heartbeat', device: deviceView(d) }));
  spokes.on('event', (e) => bus.emit('event', 'device_event', e));
  spokes.on('hardware', (d: Device, hw: unknown) => models!.heartbeat(d, hw));
  models.on('change', (c) => bus.emit('event', 'models', c));
  models.on('progress', (p) => bus.emit('event', 'model_progress', p));
  enroll.on('change', (r) => bus.emit('event', 'join_request', r));
  role.on('change', (s) => bus.emit('event', 'mesh', s));
  role.on('applied', (a) => bus.emit('event', 'sync', a));
  // Capture's rows come by sync too: a standby's pages reload it.
  role.on('applied', () => capture.synced());
  browser.on('change', (v) => bus.emit('event', 'browser', v));
  capture.on('change', (c) => bus.emit('event', 'capture', c));
  keep.playbooks.on('change', (c) => bus.emit('event', 'playbook', c));
  // A device that may no longer approve may no longer hold a browser either (browser/routes.ts).
  devices.on('revoked', (d: Device) => browser.release(`device:${d.id}`, `ended by Nova: its device was removed`));
  // Nor capture from it: its sources go off.
  devices.on('revoked', (d: Device) => capture.deviceRemoved(d.id));
  devices.on('revoked', (d: Device) => design.forgetDevice(d.id));
  devices.on('change', (c: { action: string; device: Device }) => {
    if (c.action === 'can_approve' && !c.device.can_approve) browser.release(`device:${c.device.id}`, 'ended by Nova: its device may no longer take over');
  });
  const stream = {
    on(listener: (event: string, data: unknown) => void) {
      const fn = (event: string, data: unknown) => listener(event, data);
      bus.on('event', fn);
      return () => bus.off('event', fn);
    },
  };

  // A device as the API shows it. Online: the hub always; others when heard from lately or holding
  // a stream open. `this`: the device asking (the hub, for the console).
  function deviceView(d: Device, p?: Principal) {
    const { public_key: _pk, x25519_public_key: _xk, ...rest } = d;
    const recent = d.last_seen ? now().getTime() - Date.parse(d.last_seen) < ONLINE_WINDOW_MS : false;
    const agent = d.kind === 'computer' && d.role !== 'hub' ? spokes.agent(d.id) : null;
    return {
      ...rest,
      ...(agent ? { agent } : {}),
      online: d.trust === 'trusted' && (d.role === 'hub' || access.isLive(d.id) || recent),
      this: p ? (p.kind === 'device' ? p.device.id === d.id : p.kind === 'console' && d.id === meshIdentity.id) : false,
    };
  }
  // What taking roles away from a device stops there (M10f): model roles on it without compute,
  // its capture sources without capture source, and (M10h) its native workloads that need a role taken.
  const workStopping = (id: string, removed: string[]): string[] => [
    ...(removed.includes('compute') && models ? models.rolesOn(id).map((r) => `its ${MODEL_ROLE_WORDS[r].name.toLowerCase()} model`) : []),
    ...(removed.includes('capture-source') ? capture.sourcesOn(id) : []),
    ...deviceWorkloads.needing(id, removed).map((s) => `its ${s} workload`),
  ];
  // And it stops: a computer that is no longer a capture source has its sources turned off.
  devices.on('change', (e: { action: string; device: Device; removed?: string[] }) => {
    if (e.action === 'purposes' && e.device.role !== 'hub' && !e.device.purposes.includes('capture-source')) capture.deviceRemoved(e.device.id, 'Turned off: its computer is no longer a capture source (Settings › Devices).');
    // M10h: a workload its roles no longer allow is assigned stopped (its agent stops it on its own check too).
    if (e.action === 'purposes') deviceWorkloads.narrowed(e.device.id, e.device.purposes);
  });
  // The devices placement is resolved against (M10f): roles, hardware and health, as the hub knows
  // them now.
  // The same, now, with the hub's hardware as last read (the Service Manager decides synchronously).
  let hubHwCache: Awaited<ReturnType<NonNullable<typeof models>['hubHardware']>> | null = null;
  function placementDevicesNow(): PlacementDevice[] {
    return placementRows(hubHwCache);
  }
  async function placementDevices(): Promise<PlacementDevice[]> {
    const hubHw = models ? await models.hubHardware().catch(() => null) : null;
    hubHwCache = hubHw;
    return placementRows(hubHw);
  }
  function placementRows(hubHw: typeof hubHwCache): PlacementDevice[] {
    return devices.list().map((d) => {
      const hw = d.id === meshIdentity.id ? hubHw : models?.hardwareOf(d.id) ?? null;
      return {
        id: d.id, name: d.name, kind: d.kind, role: d.role, platform: d.platform, purposes: d.purposes, trust: d.trust, last_seen: d.last_seen,
        hardware: hw ? { ram_bytes: hw.ram_bytes, gpus: hw.gpus.map((g) => ({ vram_bytes: g.vram_bytes, unified: g.unified })), disk: hw.disk ? { free_bytes: hw.disk.free_bytes } : null, platform: hw.platform, arch: hw.arch } : null,
        healthy: deviceView(d).online,
      };
    });
  }
  // A paired device's appearance id is remembered as its, so revoking it forgets its appearance.
  const ownedBy = (w: Who, appearanceId: unknown) => { if (w.principal.kind === 'device' && typeof appearanceId === 'string') design.own(appearanceId, w.principal.device.id); };
  const by = (w: Who) => (w.principal.kind === 'device' ? `device:${w.principal.device.id}` : w.principal.kind);
  // Joining and sessions happen only over the mesh listener, the transport §0 accepts.
  const meshOnly = (w: Who) => {
    if (w.listener !== 'mesh') throw new CoreError('forbidden', meshInfo ? `Devices join and sign in at ${meshInfo.publicUrl}, not at this address.` : 'Other devices can’t reach this Nova: it has no mesh address.');
  };
  // The computer asking, for routes only a device agent calls.
  const me = (w: Who): Device => {
    if (w.principal.kind !== 'device') throw new CoreError('forbidden', 'Only a paired computer’s device agent sends this.');
    return w.principal.device;
  };

  // The Decision Service's settings as the person sees them: never the key, only whether one is kept.
  async function decisionsView() {
    const s = decisionSettings();
    let key = false;
    try { key = vault.has('decisions.jev'); } catch { /* a vault that won't open says so in health */ }
    return { ...(await decisionService.view()), settings: { ...s, key_set: key }, opt_in_words: OPT_IN_WORDS, privacy: profile.privacyDefault() };
  }

  async function putDecisions(body: Record<string, unknown>) {
    // Nothing sent is dropped in silence: {use} stands alone, and every field must be one we read.
    if (body.use !== undefined) {
      const extra = Object.keys(body).filter((k) => k !== 'use');
      if (extra.length) return new Reply({ error: 'These decision-model choices can’t be used.', problems: [`{use} chooses between the sorting model and the rules, on its own; send ${extra.join(', ')} separately.`] }, {}, 422);
      models!.useForDecisions(body.use); return decisionsView();
    }
    const unknown = Object.keys(body).filter((k) => !['jev', 'tev1', 'opt_in', 'key', 'confirm'].includes(k));
    if (unknown.length) return new Reply({ error: 'These decision-model choices can’t be used.', problems: [`Nova doesn’t know ${unknown.join(', ')}; it takes jev, tev1, opt_in, key and confirm.`] }, {}, 422);
    if (body.opt_in !== undefined && (typeof body.opt_in !== 'object' || body.opt_in === null || Array.isArray(body.opt_in) || Object.keys(body.opt_in).some((k) => k !== 'screening' && k !== 'box'))) return new Reply({ error: 'These decision-model choices can’t be used.', problems: ['opt_in must be {screening, box}, each on or off.'] }, {}, 422);
    const { key, confirm, ...choices } = body;
    const was = decisionSettings();
    // What isn't named stays as it was; each opt-in is its own switch.
    const named = choices.opt_in && typeof choices.opt_in === 'object' ? choices.opt_in as Record<string, unknown> : {};
    const v = validateSettings({ jev: was.jev, tev1: was.tev1, ...choices, opt_in: { ...was.opt_in, ...named } });
    const problems = v.ok ? [] : [...v.problems];
    if (key !== undefined && key !== null && (typeof key !== 'string' || !key.trim() || key.length > 4096)) problems.push('The Jev key must be the key text TypeSafe gave you.');
    if (!v.ok || problems.length) return new Reply({ error: 'These decision-model choices can’t be used.', problems }, {}, 422);
    const next = v.settings;
    const changed = JSON.stringify(next.jev) !== JSON.stringify(was.jev) || JSON.stringify(next.tev1) !== JSON.stringify(was.tev1)
      || next.opt_in.screening !== was.opt_in.screening || next.opt_in.box !== was.opt_in.box || key !== undefined;
    if (changed && confirm !== true) {
      const words = (await decisionService.noticesFor(next)).map((n) => n.words);
      throw new CoreError('conflict', 'This changes where outside content may go or which model judges it. Read the notices, then send confirm: true to save it.', words);
    }
    if (typeof key === 'string') vault.put('decisions.jev', key.trim());
    else if (key === null) vault.delete('decisions.jev');
    profile.set('models', 'decision', next, 'settings');
    log.info('decisions', 'The decision-model choices changed.', { jev: next.jev?.model ?? null, tev1: next.tev1?.model ?? null, screening: next.opt_in.screening, box: next.opt_in.box });
    void decisionService.refresh().catch(() => {});
    return decisionsView();
  }

  function health() {
    let database: { ok: boolean; detail: string };
    try {
      db.get('SELECT 1');
      database = { ok: true, detail: `Schema version ${db.version()}.` };
    } catch (e) {
      database = { ok: false, detail: `The database isn't answering: ${(e as Error).message}` };
    }
    const workers = [...ledger.workers.values()].map(info);
    const checks = {
      database,
      workers: { ok: workers.every((w) => w.health.ok), detail: workers.filter((w) => !w.health.ok).map((w) => w.health.detail).join(' ') || `${workers.length} ready.`, workers },
      ledger: { ok: true, counts: ledger.counts() },
      extensions: { ok: true, counts: extensions.counts() },
      design: { ok: true, active: design.active().id },
      triggers: { ok: true, counts: triggers.counts() },
      problems: { ok: true, open: log.problems({ open: true }).length },
      memory: { ok: true, counts: memory.counts() },
      receipts: { ok: true, counts: receipts.counts() },
      mesh: { ok: true, ...meshHealth() },
      vault: vaultHealth(),
      connectors: connectors.health(),
      browser: browserHealth(),
      capture: capture.health(),
      backups: keep.health(),
      changes: changes.health(),
      ingest: ingest.health(),
      computer: computer.health(),
    };
    return { ok: Object.values(checks).every((c) => c.ok), version: o.version, uptime_s: Math.round((Date.now() - started) / 1000), setup: { done: setup.view().done }, checks };
  }

  // Names only, never values; where the key lives, said plainly when it is a file.
  function vaultHealth() {
    const s = vault.status();
    return { ok: s.ok, detail: s.problem ?? (s.secrets ? `${s.secrets} secret${s.secrets === 1 ? '' : 's'}, key in ${s.where}.` : 'Empty.'), secrets: s.secrets, key: s.key, notice: s.notice };
  }

  // No Chromium is said plainly, but isn't a fault: browser work is simply unavailable. A browser
  // named in NOVA_CHROMIUM that isn't there is.
  function browserHealth() {
    const f = browser.chromium();
    return { ok: f.path !== null || f.from === 'none', available: f.path !== null, detail: f.detail, running: browser.list().length };
  }

  function meshHealth() {
    const s = role.status();
    const pr = promotions.record();
    return { role: s.role, epoch: s.epoch, listening: !!meshInfo, counts: devices.counts(), standby: s.standby, replica: s.replica, promotion: pr ? { id: pr.id, kind: pr.kind, side: pr.side, state: pr.state, said: pr.said, told: pr.told ?? [], to_name: pr.to?.name ?? null, updated_at: pr.updated_at } : null };
  }

  // The one mesh setting: automatic failover, off unless the person sets a number of seconds. It
  // decides which machine becomes the hub, so it is the approvers' (like promotion) and tier 3.
  function meshSetting(key: string, value: unknown, confirm: boolean, who: Who) {
    if (allows('approver', who.principal) !== 'ok') throw new CoreError('forbidden', APPROVER_ONLY);
    if (key !== 'auto_failover_after_s') throw new CoreError('validation', 'The mesh section has one setting: auto_failover_after_s.');
    if (value !== null && !(Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 86_400)) {
      throw new CoreError('validation', 'auto_failover_after_s is the number of seconds the hub must be unreachable before the standby takes over (1 to 86400), or null to leave it off.');
    }
    if (!confirm) throw new CoreError('validation', 'Changing automatic failover needs an explicit confirmation: send confirm: true.');
  }

  const header = (h: IncomingHttpHeaders, name: string) => { const v = h[name]; return Array.isArray(v) ? v[0] : v; };
  const str = (v: unknown, what: string) => {
    if (typeof v !== 'string' || !v.trim()) throw new CoreError('validation', `${what} is required.`);
    return v;
  };

  const routes: Route[] = [
    ...(o.sealModule ? [{ method: 'GET' as const, path: '/broker/seal.js', access: 'person' as const, summary: 'The fixed public browser helper for sealed credential entry.', handle: () => new Raw('text/javascript; charset=utf-8', o.sealModule!()) }] : []),
    { method: 'GET', path: '/health', summary: 'Whether each part of the core is working, in plain words.', handle: () => health() },
    // The ingest gate (Amendment 2026-10-30-C Part 3).
    { method: 'GET', path: '/ingest/screens', summary: 'The latest screens of outside content: source, scores, flags and verdict, by hash; never the content. ?limit=', handle: ({ query }) => ingest.list(Number(query.get('limit')) || 50) },
    { method: 'GET', path: '/ingest/candidates', summary: 'Memory waiting for your OK: what a conversation that read outside content, or one of your devices, wanted kept, with where it came from.', handle: () => ingest.candidates() },
    { method: 'GET', path: '/ingest/screens/{id}', summary: 'One screen of outside content.', handle: ({ params }) => { const r = ingest.get(params.id!); if (!r) throw new CoreError('not_found', 'There is no such screen.'); return r; } },
    {
      method: 'POST', path: '/ingest/screen', summary: 'Screen outside content before a model reads it: the verdict (pass, quarantine or block), the scores and flags, and the extract a model may see.', body: '{text?, html?, headers?, attachments?, source: {kind, origin, ref?}}',
      handle: async ({ body }) => {
        const input = body as unknown as ScreenInput;
        if (typeof input.text !== 'string' && typeof input.html !== 'string') throw new CoreError('validation', 'Give the content as text or html.');
        const { id, verdict, scores, max, flags, extract, partial, model } = await ingest.screen(input);
        return { id, verdict, scores, max, flags, extract, partial, model };
      },
    },
    { method: 'GET', path: '/identity', summary: 'Who Nova is for this person: name, tuning, and the fixed charter.', handle: () => ({ identity: identityOf(profile), charter: CHARTER, rendered: render(identityOf(profile)) }) },
    { method: 'GET', path: '/profile', summary: 'The whole profile (no secrets; those are referenced by name only).', handle: () => profile.all() },
    {
      method: 'PUT', path: '/profile/{section}/{key}', summary: 'Change one profile record, as a settings screen would. The mesh section is tier 3 ({confirm: true}) and only an approver may change it.', body: '{value, confirm?}',
      handle: ({ params, body, who }) => {
        const section = params.section as Section;
        if (!SECTIONS.includes(section) || section === 'setup') throw new CoreError('validation', `There is no profile section called "${params.section}".`);
        if (section === 'mesh') meshSetting(params.key!, body.value, body.confirm === true, who);
        if (section === 'providers' || (section === 'policy' && params.key === 'task_tests')) throw new CoreError('validation', 'Providers are set through /api/v1/providers, so their settings are checked.');
        if (section === 'capture') throw new CoreError('validation', 'Capture settings are set through PUT /api/v1/capture/settings, so they are checked.');
        if (section === 'models') throw new CoreError('validation', 'Models are set through /api/v1/models, so their settings are checked.');
        if (section === 'backups') throw new CoreError('validation', 'Backups are set through PUT /api/v1/backups/settings, so the folders are checked.');
        if (section === 'appearance') {
          if (params.key !== 'mode') throw new CoreError('validation', 'Choose a design system with POST /api/v1/design-systems/{id}/apply, so it is checked and can be rolled back.');
          design.setMode(body.value);
          return profile.section(section);
        }
        profile.set(section, str(params.key, 'key'), body.value, 'settings');
        return profile.section(section);
      },
    },
    {
      // After a factory reset, until setup is done, the browser forgets what it kept of the Nova that
      // was erased (M7 amendment §2).
      method: 'GET', path: '/setup', summary: 'The setup conversation so far, and the question Nova is asking.',
      handle: async ({ who, headers }) => { await setup.ready(); const v = setup.view(); const h = reset.clearHeaders(who.principal, header(headers, 'cookie')); return Object.keys(h).length ? new Reply(v, h) : v; },
    },
    { method: 'POST', path: '/setup/messages', summary: 'Answer Nova in the setup conversation. Discovery and import, when asked for, run before the reply.', body: '{text}', handle: ({ body }) => setup.answer(str(body.text, 'text')) },
    {
      // Settings › Services, minimal (M10f): the backend in use and what it means on this OS. The map
      // and switching come later (M10i, M10k); there is nothing to switch to yet, and it says so.
      method: 'GET', path: '/services/backend', summary: 'How Nova runs its services on this computer: the backend in use (the supervisor), what it means on this OS, and where switching will be.',
      handle: () => ({ backend: 'supervisor', ...backendFor(deviceOs), switchable: false }),
    },
    {
      method: 'GET', path: '/tasks', summary: 'Work Ledger tasks, newest first. Filter with ?state=.',
      handle: ({ query }) => {
        const state = query.get('state');
        if (state && !STATES.includes(state as State)) throw new CoreError('validation', `state must be one of ${STATES.join(', ')}.`);
        const limit = Number(query.get('limit') ?? 50);
        if (!Number.isInteger(limit)) throw new CoreError('validation', 'limit must be a whole number.');
        return ledger.list({ ...(state ? { state: state as State } : {}), limit });
      },
    },
    {
      method: 'POST', path: '/tasks', status: 201, summary: 'Delegate a task. It must name a worker and the evidence that will prove it done.',
      body: '{title, owner, goal, evidence_required[], privacy_mode?, approval_tier?, inputs?, context_refs?, constraints?, idempotency_key?}',
      handle: ({ body }) => {
        const off = typeof body.owner === 'string' && !ledger.workers.has(body.owner) ? providers.explain(body.owner) : null;
        if (off) throw new CoreError('conflict', off);
        const task = ledger.create({ ...(body as unknown as TaskInput), origin: { kind: 'user' } });
        triggers.reactive(task);
        return task;
      },
    },
    { method: 'GET', path: '/tasks/{id}', summary: 'One task, with its brief, report and verification.', handle: ({ params }) => ledger.get(params.id!) },
    { method: 'GET', path: '/tasks/{id}/events', summary: 'Everything that happened to a task, in order.', handle: ({ params }) => ledger.events(params.id!) },
    { method: 'POST', path: '/tasks/{id}/approve', summary: 'Give the OK a tier-2 or tier-3 task is waiting for. Tier 3 needs {confirm: true}.', body: '{confirm?}', handle: ({ params, body }) => ledger.approve(params.id!, { confirm: body.confirm === true }) },
    { method: 'POST', path: '/tasks/{id}/retry', summary: 'Try a blocked or partly done task again.', handle: ({ params }) => ledger.retry(params.id!) },
    { method: 'POST', path: '/tasks/{id}/cancel', summary: 'Stop a task. It ends cancelled, with the reason.', body: '{reason?}', handle: ({ params, body }) => ledger.cancel(params.id!, typeof body.reason === 'string' && body.reason.trim() ? body.reason : 'Cancelled by you.') },
    { method: 'GET', path: '/workers', summary: 'Who can do delegated work, where their data goes, and whether they are healthy.', handle: () => [...ledger.workers.values()].map(info) },
    { method: 'GET', path: '/extensions', summary: 'Installed extensions and their state.', handle: () => extensions.list() },
    { method: 'POST', path: '/extensions', status: 201, summary: 'Install an extension from its manifest. It starts disabled; the reply lists what it asks for.', body: '{manifest}', handle: ({ body }) => extensions.install(body.manifest) },
    { method: 'POST', path: '/extensions/{id}/enable', summary: 'Enable an extension. Needs {approved: true} when it asks for permissions.', body: '{approved?}', handle: ({ params, body }) => extensions.enable(params.id!, { approved: body.approved === true }) },
    { method: 'POST', path: '/extensions/{id}/disable', summary: 'Disable an extension, keeping it installed.', handle: ({ params }) => extensions.disable(params.id!) },
    { method: 'DELETE', path: '/extensions/{id}', summary: 'Remove an extension, following its on_remove promise; nothing of it stays behind.', handle: ({ params }) => extensions.remove(params.id!) },
    { method: 'GET', path: '/design-systems', summary: 'Installed design systems, each with whether it is valid and, if not, its problems in plain words.', handle: () => design.list() },
    { method: 'GET', path: '/design-systems/schema', summary: 'The token schema every design system implements: names, CSS variables, value rules, contrast pairs, content rules.', handle: () => design.schema() },
    { method: 'GET', path: '/design-systems/active', summary: 'The design system this device shows (?device=), and whether that is its own choice, the person’s, or the default.', handle: ({ query }) => design.active(query.get('device')) },
    {
      method: 'POST', path: '/design-systems', status: 201, summary: 'Install a design system from its manifest, through the extension host. It is validated before it can be applied.', body: '{manifest}',
      handle: ({ body }) => design.install(body.manifest),
    },
    {
      method: 'POST', path: '/design-systems/rollback', summary: 'Go back to the design system shown before the last change, for the person or one device.', body: '{scope: user | device, device_id?}',
      handle: ({ body, who }) => { ownedBy(who, body.device_id); return design.rollback({ scope: body.scope as Scope, device_id: typeof body.device_id === 'string' ? body.device_id : null }); },
    },
    {
      method: 'POST', path: '/design-systems/contrast-fix', summary: 'The live contrast check’s one-tap fix for one device: the colours of what it shows that fail (text under 4.5:1, outlines under 3:1) are nudged just far enough to pass, on that device only.', body: '{device_id}',
      handle: ({ body, who }) => { ownedBy(who, body.device_id); return design.fixContrast({ device_id: typeof body.device_id === 'string' ? body.device_id : null }); },
    },
    {
      method: 'POST', path: '/design-systems/follow', summary: 'One device drops its own design system and shows the person’s again. Rolling back on that device brings its own back.', body: '{device_id}',
      handle: ({ body, who }) => { ownedBy(who, body.device_id); return design.follow({ device_id: typeof body.device_id === 'string' ? body.device_id : null }); },
    },
    {
      method: 'POST', path: '/design-systems/contrast-fix/undo', summary: 'Take a device’s contrast fix away again.', body: '{device_id}',
      handle: ({ body }) => design.undoFix({ device_id: typeof body.device_id === 'string' ? body.device_id : null }),
    },
    { method: 'GET', path: '/design-systems/{id}', summary: 'One design system, with its manifest and validation.', handle: ({ params }) => design.get(params.id!) },
    { method: 'POST', path: '/design-systems/{id}/validate', summary: 'Check a design system against the schema: completeness, value syntax, contrast, reduced motion, content rules, extras.', handle: ({ params }) => design.validate(params.id!) },
    {
      method: 'GET', path: '/design-systems/{id}/preview.css', summary: 'A design system as CSS variables, for a sandboxed preview frame, without applying it. ?mode=light|dark|auto.',
      handle: ({ params, query }) => new Raw('text/css; charset=utf-8', design.previewCss(params.id!, query.get('mode'))),
    },
    {
      method: 'POST', path: '/design-systems/{id}/apply', summary: 'Apply a valid design system for the person (every device) or one device. The previous one is kept for rollback.', body: '{scope: user | device, device_id?}',
      handle: ({ params, body, who }) => { ownedBy(who, body.device_id); return design.apply(params.id!, { scope: body.scope as Scope, device_id: typeof body.device_id === 'string' ? body.device_id : null }); },
    },
    { method: 'GET', path: '/triggers/rules', summary: 'Every automation Nova runs: event, heartbeat and proactive rules. Nothing runs that isn’t listed here.', handle: () => triggers.listRules() },
    {
      method: 'POST', path: '/triggers/rules', status: 201, summary: 'Add a rule. For an event rule the reply carries its webhook token, shown this once only.',
      body: '{name, class: proactive|event|heartbeat, hook? or connector + topic? (event), cron? (heartbeat), action: {kind: task, task} | {kind: message, text}, dedup_window_s?, cooldown_s?}',
      handle: ({ body }) => {
        const { rule, token } = triggers.createRule(body as unknown as RuleInput, 'person');
        return token ? { rule, token, note: 'Keep this token somewhere safe. Nova keeps only a hash of it and won’t show it again.' } : { rule };
      },
    },
    { method: 'GET', path: '/triggers/rules/{id}', summary: 'One rule, with every change made to it.', handle: ({ params }) => ({ ...triggers.rule(params.id!), changes: triggers.ruleEvents(params.id!) }) },
    { method: 'PUT', path: '/triggers/rules/{id}', summary: 'Change a rule’s name, schedule, action, dedup window or cooldown.', body: '{name?, cron?, action?, dedup_window_s?, cooldown_s?}', handle: ({ params, body }) => triggers.updateRule(params.id!, body) },
    { method: 'POST', path: '/triggers/rules/{id}/pause', summary: 'Pause a rule. Its firings are recorded and dropped until it is resumed.', handle: ({ params }) => triggers.pause(params.id!) },
    { method: 'POST', path: '/triggers/rules/{id}/resume', summary: 'Resume a paused rule. A schedule starts again from now.', handle: ({ params }) => triggers.resume(params.id!) },
    { method: 'POST', path: '/triggers/rules/{id}/fire', summary: 'Run a proactive or heartbeat rule now.', body: '{payload?}', handle: ({ params, body }) => triggers.fireRule(params.id!, body.payload ?? {}) },
    { method: 'DELETE', path: '/triggers/rules/{id}', summary: 'Remove a rule. Its past firings stay in the record.', handle: ({ params }) => { triggers.deleteRule(params.id!); return { ok: true }; } },
    {
      method: 'GET', path: '/triggers', summary: 'Trigger records, newest first: what fired, how it was triaged and why, and what it led to. Filter with ?rule=.',
      handle: ({ query }) => triggers.list({ ...(query.get('rule') ? { rule: query.get('rule')! } : {}) }),
    },
    { method: 'GET', path: '/triggers/{id}', summary: 'One trigger record.', handle: ({ params }) => triggers.get(params.id!) },
    {
      // Public: an automation has no device session; the hook token is its key, checked below.
      method: 'POST', path: '/hooks/{name}', status: 202, auth: 'hook-token', access: 'public',
      summary: 'Call an event rule’s webhook. Authenticated by the x-nova-hook-token header instead of X-Nova, so automations can call it. The body is kept only as a hash; x-nova-dedup-key is optional.',
      body: 'any JSON object',
      handle: async ({ params, body, headers }) => {
        // A provider's callback (n8n) comes through the same token webhooks (M5a).
        const cb = await providers.hook(params.name!, header(headers, 'x-nova-hook-token'), body, headers);
        if (cb) return cb;
        const t = await triggers.hook(params.name!, header(headers, 'x-nova-hook-token'), body, header(headers, 'x-nova-dedup-key'));
        return { trigger_id: t.trigger_id, decision: t.triage.decision, reason: t.triage.reason };
      },
    },
    {
      method: 'GET', path: '/messages', summary: 'Messages Nova started, newest first. ?state=held for those waiting for quiet hours to end.',
      handle: ({ query }) => triggers.messages(query.get('state') === 'held' ? { state: 'held' } : {}),
    },
    { method: 'POST', path: '/messages/{id}/approve', summary: 'Send a message Nova held because it wasn’t sure; only you can release it.', handle: ({ params }) => triggers.approveMessage(params.id!) },
    { method: 'POST', path: '/messages/{id}/read', summary: 'Mark a message as read.', handle: ({ params }) => triggers.read(params.id!) },
    { method: 'GET', path: '/problems', summary: 'Things that went wrong and matter to the person. ?open=1 for unresolved only.', handle: ({ query }) => log.problems({ open: query.get('open') === '1' }) },
    { method: 'POST', path: '/problems/{id}/resolve', summary: 'Mark a problem as dealt with.', handle: ({ params }) => { log.resolve(Number(params.id)); return { ok: true }; } },
    {
      method: 'GET', path: '/memory', summary: 'Everything Nova remembers, newest first, corrected and expired records included and marked. Filter with ?kind=&scope=&state=.',
      handle: ({ query }) => memory.list({
        ...(query.get('kind') ? { kind: query.get('kind') as MemoryKind } : {}),
        ...(query.get('scope') ? { scope: query.get('scope')! } : {}),
        ...(query.get('state') ? { state: query.get('state') as UserState } : {}),
      }),
    },
    {
      method: 'POST', path: '/memory', status: 201, summary: `Remember something, as the person. kind is one of ${MEMORY_KINDS.join(', ')}.`,
      body: '{kind, content, source?, observed_at?, confidence?, scope?, expires?}',
      handle: ({ body }) => memory.remember({ ...(body as unknown as MemoryInput), recorded_by: 'person' }),
    },
    { method: 'GET', path: '/memory/search', summary: 'Find active memories that share words with ?q=, with the list of what was retrieved. Also ?scope=&limit=.', handle: ({ query }) => memory.search(str(query.get('q'), 'q'), { ...(query.get('scope') ? { scope: query.get('scope')! } : {}), ...(query.get('limit') ? { limit: Number(query.get('limit')) } : {}) }) },
    { method: 'POST', path: '/memory/export', summary: 'Write the active memories as plain files (memory.json and memory.md) and return where they are.', handle: () => memory.export() },
    { method: 'POST', path: '/memory/{id}/correct', summary: 'Correct a memory. The correction supersedes it; the old record is kept, marked corrected.', body: '{content}', handle: ({ params, body }) => memory.correct(params.id!, str(body.content, 'content'), 'person') },
    { method: 'POST', path: '/memory/{id}/confirm', summary: 'Confirm a memory is right.', handle: ({ params }) => memory.confirm(params.id!, 'person') },
    { method: 'DELETE', path: '/memory/{id}', summary: 'Forget a memory for real: it and every correction of it are deleted, leaving only a note that something was forgotten.', handle: ({ params }) => memory.forget(params.id!, 'person') },
    {
      method: 'GET', path: '/receipts', summary: 'What each model call was told and where it went, newest first. ?egress=remote is the egress log; also ?task_id=&session_id=.',
      handle: ({ query }) => receipts.list({
        ...(query.get('task_id') ? { task_id: query.get('task_id')! } : {}),
        ...(query.get('session_id') ? { session_id: query.get('session_id')! } : {}),
        ...(query.get('egress') ? { egress: query.get('egress') as 'local' | 'remote' } : {}),
      }),
    },
    {
      // Tier 0: drafting. Where a definition would run, and why each device may or may not take it.
      method: 'POST', path: '/services/placement', summary: 'Where a service definition would run, resolved against every device’s roles, hardware and health: the device or devices, and each device’s reason. Nothing is deployed (tier 0).', body: '{definition}',
      handle: async ({ body }) => {
        const devs = await placementDevices();
        // `hub` names whichever node is hub, as the supervisor driver reads it.
        const views = devs.filter((d) => d.trust === 'trusted').map((d) => ({ id: d.id, platform: d.platform, roles: [...d.purposes] }));
        const hubView = views.find((d) => d.id === meshIdentity.id);
        const v = validate(body.definition, { devices: hubView ? [...views, { ...hubView, id: 'hub' }] : views });
        if (!v.ok) return { valid: false, problems: v.problems, resolution: null };
        const resolution = resolvePlacement(v.def, devs, { hubId: meshIdentity.id, now: now() });
        const away = resolution.ok ? resolution.devices.filter((d) => d.id !== meshIdentity.id) : [];
        return { valid: true, problems: [], resolution, ...(away.length ? { note: 'On a device other than the hub it runs as a native workload, deployed with POST /services/devices/deploy; this only says where.' } : {}) };
      },
    },
    {
      method: 'GET', path: '/services/topology', summary: 'One observed topology snapshot, safe version policy and matching Mermaid text.',
      handle: async () => {
        let cluster: ClusterObservation | null = null, cluster_error = false;
        try { cluster = await o.topologyCluster?.() ?? null; } catch { cluster_error = true; }
        const captured_at = now().toISOString();
        const registry = devices.list();
        const canMutate = role.role() === 'hub' && devices.state().hub_id === meshIdentity.id;
        const native = deviceWorkloads.topology().map(n => ({ ...n, service: { ...n.service, authority: canMutate ? n.service.authority : null } }));
        const lag = captureSync?.lag() ?? [];
        let state = null;
        try { state = o.supervisor?.state() ?? null; } catch { /* explicit managed-unavailable below */ }
        const local = supervisorServices(state, !!o.supervisor, meshIdentity.id, captured_at, o.version, canMutate && typeof o.supervisor?.service === 'function');
        const machines: MachineInput[] = registry.filter(d => d.trust === 'trusted').map(d => {
          const here = d.id === meshIdentity.id, streaming = access.isLive(d.id);
          const at = here || streaming ? captured_at : d.last_seen;
          const fresh = at !== null && Date.parse(captured_at) - Date.parse(at) < ONLINE_WINDOW_MS;
          const capture = lag.find(l => l.device_id === d.id);
          return { id: d.id, name: d.name, roles: [d.role, ...d.purposes], observations: [{ source: here ? 'local' : 'heartbeat', at, health: fresh ? 'healthy' : 'unknown', reason: here ? 'This Nova process is answering.' : streaming ? 'The device has an active connection.' : fresh ? 'A heartbeat was received recently.' : 'No recent heartbeat is available.' }],
            services: [...(here ? local.services : []), ...native.filter(n => n.device_id === d.id).map(n => n.service)],
            ...(capture ? { capture_lag: { queued: capture.queued, synced_to: capture.synced_to, at: capture.at, paused: capture.paused } } : {}),
          };
        });
        return buildTopology({ captured_at, hub_id: devices.state().hub_id, local_id: meshIdentity.id, machines, cluster, cluster_error, excluded_ids: registry.filter(d => d.trust !== 'trusted').map(d => d.id), issues: local.issue ? [local.issue] : [] });
      },
    },
    ...(['promote', 'rollback'] as const).map(action => ({
      method: 'POST' as const, path: `/services/hub/{service}/${action}`, access: 'approver' as const,
      summary: 'A fixed service change through the supervisor’s current Service Manager; confirmation and readiness remain authoritative.',
      handle: async ({ params, body }: { params: Record<string, string>; body: Record<string, unknown> }) => {
        const service = params.service!;
        const allowed = action === 'promote' ? ['version', 'confirm', 'expected'] : ['confirm', 'expected'];
        if (!/^[a-z][a-z0-9-]{0,127}$/.test(service) || Object.keys(body).some(k => !allowed.includes(k)) || typeof body.confirm !== 'string' || (action === 'promote' && (typeof body.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(body.version)))) throw new CoreError('validation', 'Only a service version and typed confirmation are accepted.');
        if (!validServiceExpected(body.expected)) throw new CoreError('validation', 'A closed approved service state is required.');
        if (body.confirm !== (action === 'promote' ? `${service}@${body.version}` : 'rollback')) throw new CoreError('validation', 'The typed confirmation does not match this action.');
        if (!o.supervisor?.service) throw new CoreError('conflict', 'The supervisor service authority is unavailable.');
        const r = await o.supervisor.service(action === 'promote' ? { action, service, version: body.version as string, confirm: body.confirm, expected: body.expected } : { action, service, confirm: body.confirm, expected: body.expected });
        if (!r.ok) throw new CoreError('conflict', r.said);
        return r;
      },
    })),
    // ---- native workloads on devices (M10h) ----
    {
      method: 'GET', path: '/services/devices', summary: 'Native workloads on your other devices: per service, its device, the live version, the one kept for one step back, each version’s status as the device reported it, and what happened.',
      handle: async () => { await placementDevices(); return { services: deviceWorkloads.status() }; },
    },
    {
      method: 'POST', path: '/services/devices/deploy', access: 'approver', body: '{definition, confirm?}',
      summary: 'Deploy a version to the device its placement resolves to: installed and checked there, started alongside if it can run twice, with no traffic (tier 1). A command no approved version ran asks first, typed (<service>@<version>; tier 3 for capture).',
      handle: async ({ body }) => {
        await placementDevices();
        const v = validate(body.definition, { devices: placementDevicesNow().filter((d) => d.trust === 'trusted').map((d) => ({ id: d.id, platform: d.platform, roles: [...d.purposes] })) });
        if (!v.ok) throw new CoreError('validation', 'The definition can’t be used.', v.problems);
        const where = deviceWorkloads.where(v.def);
        if (!where.device) throw new CoreError('conflict', `It can’t go to a device: ${where.refused.join(' ')}`);
        const m = deviceServices(where.device.id);
        const plan = m.plan(body.definition);
        const r = await m.deploy(body.definition, () => {}, body.confirm);
        if (!r.ok) throw new CoreError(r.asks ? 'validation' : 'conflict', r.said);
        return { ...r, device: { id: where.device.id, name: where.device.name }, plan: plan.ok ? plan.plan : null };
      },
    },
    {
      method: 'POST', path: '/services/devices/{device}/{service}/promote', access: 'approver', body: '{version, confirm}',
      summary: 'Move a device’s workload to a version that passed its health there (tier 2; tier 3 for anything with OS permissions, such as capture, every time): type <service>@<version>.',
      handle: async ({ params, body }) => {
        const expected = body.expected;
        if (Object.keys(body).some(k => !['version', 'confirm', 'expected'].includes(k)) || (expected !== undefined && !validServiceExpected(expected))) throw new CoreError('validation', 'Only a version, confirmation and closed approved service state are accepted.');
        const r = await deviceServices(params.device!).promote(params.service!, String(body.version ?? ''), body.confirm, () => {}, expected);
        if (!r.ok) throw new CoreError(r.tier && body.confirm !== `${params.service}@${body.version}` ? 'validation' : 'conflict', r.said);
        return r;
      },
    },
    {
      method: 'POST', path: '/services/devices/{device}/{service}/rollback', access: 'approver', body: '{confirm: "rollback"}',
      summary: 'Back to the version kept on the device, in one step: nothing is downloaded (tier 2).',
      handle: async ({ params, body }) => {
        const expected = body.expected;
        if (Object.keys(body).some(k => !['confirm', 'expected'].includes(k)) || (expected !== undefined && !validServiceExpected(expected))) throw new CoreError('validation', 'Only confirmation and closed approved service state are accepted.');
        const r = await deviceServices(params.device!).rollback(params.service!, body.confirm, () => {}, expected);
        if (!r.ok) throw new CoreError(body.confirm === 'rollback' ? 'conflict' : 'validation', r.said);
        return r;
      },
    },
    {
      method: 'GET', path: '/mesh/workloads/{service}/{version}', access: 'device',
      summary: 'The manifest this hub signs for this device’s own assigned version (or the one kept): its files pinned by SHA-256, its one command, ports and health. Nothing about any other device.',
      handle: ({ params, who }) => deviceWorkloads.manifest(me(who).id, params.service!, params.version!),
    },
    {
      method: 'GET', path: '/mesh/workloads/{service}/{version}/file/{name}', access: 'device',
      summary: 'A file the manifest pins, exactly as it was published (Nova never signs or changes a workload’s program).',
      handle: ({ params, who }) => new Raw('application/octet-stream', deviceWorkloads.file(me(who).id, params.service!, params.version!, params.name!)),
    },
    ...captureSync!.routes({ me: (w) => me(w as Who) }),
    // ---- the device mesh (M4 plan §0–§1) ----
    {
      method: 'GET', path: '/mesh/hello', access: 'public', summary: 'The hub’s fingerprint, epoch, role and public keys. No person data; anyone may ask.',
      handle: () => {
        const s = devices.state();
        const self = devices.find(meshIdentity.id);
        // The hub's signed roster too, so a hub that was away can tell it was replaced (fencing).
        return {
          name: self?.name ?? 'Nova', id: meshIdentity.id, fingerprint: meshIdentity.fingerprint, epoch: s.epoch, role: s.role, public_key: meshIdentity.publicKey, x25519_public_key: meshIdentity.x25519PublicKey,
          ...(s.role === 'hub' ? { roster: devices.roster() } : {}),
          ...(role.held() ? { held: true } : {}),
        };
      },
    },
    {
      method: 'GET', path: '/mesh/status', access: 'mesh', summary: 'Whether other devices can reach this Nova, where, and who is asking.',
      handle: ({ who }) => {
        const p = who.principal;
        return {
          public_url: publicUrl(), transport: meshInfo?.transport ?? null, fingerprint: meshIdentity.fingerprint, ...meshHealth(),
          you: p.kind === 'device' ? { console: false, device_id: p.device.id, kind: p.device.kind, can_approve: p.device.can_approve } : { console: true, device_id: meshIdentity.id, kind: 'computer', can_approve: true },
        };
      },
    },
    { method: 'GET', path: '/mesh/devices', summary: 'The device registry, the hub first. The device asking is marked `this`.', handle: ({ who }) => devices.list().map((d) => deviceView(d, who.principal)) },
    {
      method: 'PATCH', path: '/mesh/devices/{id}', summary: 'Rename a device, let it approve new devices (tier 3: needs {confirm: true}, and only an approver may grant it), or change its roles (purposes: widening is tier 3, {confirm: true}; narrowing is tier 2, {approved: true}; making a computer a hub candidate also needs {confirm_candidate: true}).', body: '{name?, can_approve?, purposes?, confirm?, approved?, confirm_candidate?}',
      handle: ({ params, body, who }) => {
        // One change per call (review finding 11): a confirmation is for one change, and a refused one
        // must not leave another half made.
        if ([body.name, body.can_approve, body.purposes].filter((v) => v !== undefined).length > 1) throw new CoreError('validation', 'Change one thing at a time: the name, who approves, or the roles. Each is confirmed on its own.');
        if ((body.can_approve !== undefined || body.purposes !== undefined) && allows('approver', who.principal) !== 'ok') throw new CoreError('forbidden', 'Only the hub’s own screen, or a device you’ve allowed to approve, can change who approves or what a device is for.');
        if (body.name !== undefined) devices.rename(params.id!, body.name);
        if (body.can_approve !== undefined) devices.setCanApprove(params.id!, body.can_approve, body.confirm === true);
        if (body.purposes !== undefined && body.dry_run === true) { const r = devices.setPurposes(params.id!, body.purposes, { dry: true, by: by(who), stops: workStopping }); return { ...deviceView(r.device, who.principal), change: r.change, stops: r.stops }; }
        if (body.purposes !== undefined) devices.setPurposes(params.id!, body.purposes, { confirm: body.confirm === true, approved: body.approved === true, confirm_candidate: body.confirm_candidate === true, by: by(who), stops: workStopping });
        return deviceView(devices.get(params.id!), who.principal);
      },
    },
    {
      method: 'POST', path: '/mesh/devices/{id}/revoke', summary: 'Revoke a device (tier 3: needs {confirm: true}). Its sessions end and its open streams close at once; its key can never sign in or enroll again.', body: '{confirm, reason?}',
      handle: ({ params, body, who }) => deviceView(devices.revoke(params.id!, { confirm: body.confirm === true, reason: body.reason, by: by(who) }), who.principal),
    },
    { method: 'POST', path: '/mesh/pairings', status: 201, access: 'approver', summary: 'Make a pairing code: single use, five minutes. The reply has the QR address, the one-line command and the hub’s fingerprint.', handle: ({ who }) => enroll.createPairing(by(who)) },
    { method: 'GET', path: '/mesh/requests', access: 'approver', summary: 'Devices waiting for your OK, each with the six digits it shows.', handle: () => enroll.requests() },
    {
      method: 'POST', path: '/mesh/requests/{id}/approve', access: 'approver', summary: 'Approve a device (tier 3: needs {confirm: true}) once its digits match, with the roles you settled on (purposes; default: what it asked for). A computer as hub candidate also needs {confirm_candidate: true}. This creates its device record.', body: '{confirm, purposes?, confirm_candidate?}',
      handle: ({ params, body, who }) => { const r = enroll.approve(params.id!, { confirm: body.confirm === true, by: by(who), ...(body.purposes !== undefined ? { purposes: body.purposes } : {}), confirm_candidate: body.confirm_candidate === true }); return { request: r.request, device: deviceView(r.device, who.principal) }; },
    },
    { method: 'POST', path: '/mesh/requests/{id}/deny', access: 'approver', summary: 'Turn a device away.', handle: ({ params, who }) => enroll.deny(params.id!, by(who)) },
    {
      method: 'POST', path: '/mesh/join', status: 201, access: 'public', summary: 'A device asks to join with a code, its public keys, and a commitment to its nonce. A wrong or spent code is a 400 with no detail.',
      body: '{code, public_key, x25519_public_key, x25519_sig, claims: {name, platform, kind, capabilities[], purposes?[], address?}, commitment}',
      handle: ({ body, who }) => { meshOnly(who); enroll.limit('calls', who.address); return enroll.join(body, who.address); },
    },
    {
      method: 'POST', path: '/mesh/join/{id}/reveal', access: 'public', summary: 'The device reveals its nonce, signed over nova-add-device-reveal-v1.<id>.<time>; the reply is the six digits.', body: '{device_nonce, time, signature}',
      handle: ({ params, body, who }) => { meshOnly(who); enroll.limit('calls', who.address); return enroll.reveal(params.id!, body); },
    },
    {
      method: 'GET', path: '/mesh/join/{id}', access: 'public', summary: 'The device polls its request: ?time=&signature= over nova-add-device-status-v1.<id>.<time>. Approved, it gets its device id and the signed roster.',
      handle: ({ params, query, who }) => { meshOnly(who); enroll.limit('polls', who.address); return enroll.status(params.id!, { time: query.get('time'), signature: query.get('signature') }); },
    },
    {
      method: 'POST', path: '/mesh/session', access: 'public', summary: 'A trusted device starts a 12-hour session, signed over nova-session-v1.<device_id>.<time>. {cookie: true} sets an HttpOnly cookie instead of returning a token.',
      body: '{device_id, time, signature, cookie?}',
      handle: ({ body, who }) => {
        meshOnly(who);
        enroll.limit('calls', who.address);
        const s = devices.startSession(body);
        const out = { device_id: s.device.id, kind: s.device.kind, expires_at: s.expires_at };
        if (body.cookie !== true) return { ...out, token: s.token };
        return new Reply(out, { 'set-cookie': sessionCookie(s.token, { secure: publicUrl()?.startsWith('https:') ?? false, maxAgeS: SESSION_TTL_MS / 1000 }) });
      },
    },
    { method: 'GET', path: '/mesh/roster', access: 'mesh', summary: 'Who the hub and the standby are, signed by this node: devices pin both keys from it.', handle: () => devices.roster() },
    // ---- computers' device agents (M4 plan §2) ----
    {
      method: 'GET', path: '/mesh/hello/proof', access: 'public', summary: 'This node signs a device’s ?challenge= over nova-hello-v1.<challenge>.<{id, role, epoch, public_key}>, so a device agent knows it holds a pinned key before signing in.',
      handle: ({ query, who }) => { enroll.limit('polls', who.address); return spokes.proof(query.get('challenge')); },
    },
    {
      method: 'POST', path: '/mesh/devices/me/heartbeat', access: 'device', summary: 'A device agent is alive: last seen now, with its capabilities, versions and whether it is in safe mode. The reply names the runtime this node ships.',
      body: '{capabilities?, version?, runtime_version?, safe_mode?}',
      handle: ({ body, who }) => spokes.heartbeat(me(who), body),
    },
    {
      method: 'POST', path: '/mesh/devices/me/report', access: 'device', summary: 'A device agent reports a problem the person should know about (a runtime update it refused).', body: '{problem: runtime_update_refused | runtime_install_failed, detail?}',
      handle: ({ body, who }) => spokes.report(me(who), body),
    },
    {
      method: 'POST', path: '/mesh/inbox', access: 'device', summary: 'A device agent’s queued items, in order, each taken in exactly once by its key: events, task requests (a task, or a refusal kept with its reason), memory notes (recorded_by device:<id>), config changes (server wins: a stale base_version is rejected).',
      body: '{items: [{key, kind: event | task_request | memory_note | config_change, body, created_at?}]}',
      handle: ({ body, who }) => spokes.inbox(me(who), body),
    },
    { method: 'GET', path: '/mesh/inbox/refusals', summary: 'What devices sent that was refused or rejected, with the reasons, newest first. ?device= for one.', handle: ({ query }) => spokes.refusals(query.get('device') ?? undefined) },
    {
      method: 'GET', path: '/mesh/config/{section}/{key}', access: 'device', summary: `A setting a device agent may change (${DEVICE_CONFIG_SECTIONS.join(', ')}), with its version, which a change must name as base_version.`,
      handle: ({ params }) => {
        // What a computer may read is what it may change, and no more: the setup conversation,
        // privacy and appearance stay with the person (the approval sheet promises so).
        if (!(DEVICE_CONFIG_SECTIONS as readonly string[]).includes(params.section!) || !DEVICE_CONFIG_KEY.test(params.key!)) {
          throw new CoreError('forbidden', `A device can read ${DEVICE_CONFIG_SECTIONS.join(', ')} settings only, by section and key.`);
        }
        const r = configRow(params.section!, params.key!);
        return { section: params.section, key: params.key, value: r ? JSON.parse(r.value) : null, version: r ? configVersion(r) : null };
      },
    },
    { method: 'GET', path: '/mesh/runtime', access: 'device', summary: 'The runtime agent this node ships, {manifest: {version, sha256, files}, signature, signer, files}, signed over nova-runtime-v1.<manifest>.', handle: () => spokes.runtime() },
    ...role.routes(),
    ...promotions.routes(),
    // ---- the vault and connectors (M5 plan §2) ----
    { method: 'GET', path: '/vault', summary: 'The vault: how many secrets, their names (never their values), and where its key is, said plainly when it is a file.', handle: () => ({ ...vault.status(), names: vault.status().ok ? vault.list() : [] }) },
    {
      method: 'PUT', path: '/vault/{name}', summary: 'Keep a provider’s secret (an API key, a signing secret) in the vault under the name its settings use as secret://NAME. The value is never shown again.', body: '{value}',
      handle: ({ params, body }) => {
        if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(params.name!)) throw new CoreError('validation', 'A secret’s name is capital letters, digits and underscores, like API_KEY.');
        if (typeof body.value !== 'string' || !body.value.trim()) throw new CoreError('validation', 'value is the secret itself, and it can’t be empty.');
        try {
          vault.put(`provider/${params.name}`, body.value.trim());
        } catch (e) {
          // A full disk is the person's to know about beyond this one refusal (M7b): a problem
          // with its playbook.
          if (e instanceof CoreError && e.details.some((d) => d.startsWith('ENOSPC'))) log.problem('vault', 'Nova couldn’t save a secret because the disk is full. Nothing in the vault changed.', { detail: e.details.join('\n') });
          throw e;
        }
        return { name: params.name, ref: `secret://${params.name}`, stored: true };
      },
    },
    {
      method: 'POST', path: '/vault/reset', summary: 'Start a new, empty vault (tier 3: needs {confirm: true}), for one that can’t be opened: the old file is kept aside in vault/ as secrets.json.unopenable-<time>. Every connection and key must be set again.', body: '{confirm}',
      handle: ({ body }) => vault.reset(body.confirm === true),
    },
    {
      method: 'DELETE', path: '/vault/{name}', summary: 'Delete a provider’s secret from the vault.',
      handle: ({ params }) => {
        if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(params.name!)) throw new CoreError('validation', 'A secret’s name is capital letters, digits and underscores, like API_KEY.');
        return { name: params.name, deleted: vault.delete(`provider/${params.name}`) };
      },
    },
    { method: 'GET', path: '/connectors', summary: 'Connections to outside services: status, what each can do in plain words, where its calls go, and the one Nova recommends connecting next.', handle: () => ({ connectors: connectors.list(), vault: vaultHealth() }) },
    { method: 'GET', path: '/connectors/{id}', summary: 'One connection.', handle: ({ params }) => connectors.view(params.id!) },
    { method: 'POST', path: '/connectors/{id}/connect', summary: 'Connect a service with what its setup asks for (an address, a token). Secrets go into the vault.', body: '{…setup fields}', handle: ({ params, body }) => connectors.connect(params.id!, body) },
    { method: 'POST', path: '/connectors/{id}/disconnect', summary: 'Disconnect: sign Nova out at the service where it can, then delete its secrets, the rules listening to it and its settings.', handle: ({ params }) => connectors.disconnect(params.id!) },
    ...connectors.routes(),
    ...providers.routes(),
    // ---- capture (M6 plan §1) ----
    ...captureRoutes(capture),
    ...models.routes(),
    ...capsRoutes(caps),
    // The getter runs only when a person requests a download, after Core is constructed.
    ...diagnosticsRoutes(() => buildDiagnostics(core, { home: o.home, version: o.version, commit: self.build(), instance: o.instance, now, era2: o.diagnostics?.era2 }), now),
    // ---- the Decision Service's settings (DS1 NOTE 4; owner decision 2) ----
    { method: 'GET', path: '/models/decisions', summary: 'The decision model: Tev1 and Jev as Nova sees them, the person’s choices (the Jev key only as set or not), what Nova recommends, a plain notice for each choice it doesn’t and for each opt-in that is on, each model’s eval scorecard, and what each opt-in means.', handle: () => decisionsView() },
    {
      method: 'PUT', path: '/models/decisions', summary: 'Choose the decision models: {jev: {base_url, model} | null, tev1: {model: auto | tev1:4b | tev1:0.8b} | null, opt_in: {screening, box}, key?: the Jev key (kept in the vault) | null}. Changing a seat, an opt-in or the key changes where content goes, so it is tier 2: without confirm: true it is refused with the notices to read first. 422 with problems when a choice can’t be used. {use: model | rules} still says whether System 1 uses the sorting model or only the rules.', body: '{jev?, tev1?, opt_in?, key?, confirm?} | {use}',
      handle: async ({ body }) => putDecisions(body),
    },
    // ---- the eval harness's scorecards (Amendment B Part 4; docs/plans/evals.md NOTE 1) ----
    ...scorecardRoutes({
      store: scorecards,
      fingerprint: REGRESSION_FINGERPRINT,
      targets: () => targetsFrom(providers.list(), models!.installedOnHub()),
    }),
    // ---- resilience (M7 plan §2–§3): backups, the drill, playbooks, the supervisor ----
    ...keep.routes((w) => { if (w.principal.kind !== 'console') throw new CoreError('forbidden', 'Releases are deployed and rolled back from the hub’s own screen only.'); }),
    // ---- checkpoints (M7 amendment §1) ----
    ...checkpoints.routes(),
    // ---- factory reset (M7 amendment §2) ----
    ...reset.routes(),
    // ---- the change pipeline and the foundry (M7 plan §1) ----
    ...changes.routes(),
    {
      method: 'POST', path: '/foundry', status: 201, summary: 'Ask the foundry for an extension: it writes it with its tests and probe (the local model by default) and proposes it as a change, tier 3.',
      body: '{need, kind: trigger-rules | template | skill-pack | design-system, via?: local-model | chat}',
      handle: ({ body }) => foundry.request(body),
    },
    // ---- Nova Computer (M10a) ----
    ...computerRoutes(computer),
    // ---- coding through chat (M10c) ----
    ...codingRoutes(coding),
    // ---- infrastructure through chat (M10d) ----
    ...infraRoutes(infra),
    // ---- networking through chat (M10d) ----
    ...networkRoutes(network),
    // ---- browser work with takeover (M5 plan §3) ----
    ...browserRoutes(browser, {
      home: o.home,
      holder: (w) => (w.principal.kind === 'device' ? { key: `device:${w.principal.device.id}`, label: w.principal.device.name } : { key: 'console', label: 'The hub’s own screen' }),
      // Stop (M10b): the task is cancelled; its browser closes with it.
      stop: (id, why) => {
        const t = ledger.get(id);
        if (t.owner !== browser.worker.id) throw new CoreError('validation', 'That isn’t a browser task.');
        return ledger.cancel(id, why);
      },
    }),
  ];

  // Tests drive the heartbeat's clock through the API; this route doesn't exist otherwise.
  if (process.env.NOVA_TEST_CLOCK === '1') {
    routes.push({
      method: 'POST', path: '/triggers/tick', summary: 'Test only: run the heartbeat as if it were the given time.', body: '{now?}',
      handle: ({ body }) => {
        const at = body.now === undefined ? now() : new Date(String(body.now));
        if (Number.isNaN(at.getTime())) throw new CoreError('validation', 'now must be an ISO time.');
        return triggers.tick(at);
      },
    });
  }

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let ticking: Promise<unknown> = Promise.resolve();
  const beat = () => {
    try { enroll.sweep(); } catch (e) { log.problem('mesh', 'Nova couldn’t tidy up old requests to join.', { detail: (e as Error)?.stack ?? String(e) }); }
    ticking = triggers.tick().catch((e) => log.problem('triggers', 'The heartbeat couldn’t check the schedules.', { detail: (e as Error)?.stack ?? String(e) }));
    // The clock watch, and Nova's own retries of repairs that haven't worked yet.
    void keep.sweep().catch((e) => log.warn('resilience', 'The repair sweep stumbled.', { error: (e as Error).message }));
    // Every infrastructure project against its budget (M10d).
    try { infra.sweep(); } catch (e) { log.warn('infra', 'The budget sweep stumbled.', { error: (e as Error).message }); }
    // The dead-man's switch, on the clock as well as its timers (M10d).
    try { network.sweep(); } catch (e) { log.warn('network', 'The dead-man’s switch sweep stumbled.', { error: (e as Error).message }); }
  };
  // The hub's own work: the ledger, recovered, and the heartbeat. A standby runs neither.
  function startHub() {
    // A node that drained to hand the role over (M10g) and is hub again (the hand-over didn't happen,
    // or it took the role back) runs its queue again.
    ledger.resume();
    const recovered = ledger.recover();
    providers.recover();
    coding.recover();
    infra.recover();
    network.recover();
    // A sandbox copy reaches nothing outside itself and keeps no clock of its own: the pipeline
    // drives it.
    if (o.sandbox) return recovered;
    models!.start();
    if (!heartbeat) {
      heartbeat = setInterval(beat, 30_000);
      heartbeat.unref();
      beat();
    }
    connectors.start();
    capture.start();
    changes.start();
    return recovered;
  }
  function stopHub() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    changes.stop();
    network.close();
    models!.stop();
    providers.stop();
    connectors.stop().catch(() => {});
    capture.stop().catch(() => {});
  }
  // On a standby (or a hub that stepped down) every change is refused, saying which node is hub;
  // the only change it takes is becoming the hub.
  const REPLICA_WRITES = new Set(['/api/v1/mesh/promote', '/api/v1/mesh/promotion/ready', '/api/v1/mesh/promotion/transfer', '/api/v1/mesh/promotion/fence', '/api/v1/mesh/promotion/cold', '/api/v1/mesh/promotion/transfer-status', '/api/v1/mesh/promotion/take-back', '/api/v1/mesh/seen']);
  // While a hub holds writes to hand over (M10g), the mesh's own calls still pass: sessions, the
  // standby's acknowledgements and the promotion's steps. Every other change is refused, saying why.
  let inflightWrites = 0;
  const HOLD_PASSES = (path: string) => path === '/api/v1/mesh/session' || path === '/api/v1/mesh/sync/ack' || path.startsWith('/api/v1/mesh/promotion');

  // GET /join.sh and GET /device-agent.tar: the one-line command's script, and the agent it unpacks.
  let tarCache: Buffer | null = null;
  function agentDownload(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if ((url.pathname !== '/join.sh' && url.pathname !== '/device-agent.tar') || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    const sh = url.pathname === '/join.sh';
    tarCache ??= agentTar(o.version);
    // The script names the archive's hash, and checks what it downloads against it.
    const body = sh ? Buffer.from(joinScript(publicUrl(), createHash('sha256').update(tarCache).digest('hex'))) : tarCache;
    res.writeHead(200, {
      'content-type': sh ? 'text/x-shellscript; charset=utf-8' : 'application/x-tar', 'content-length': body.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      ...(sh ? {} : { 'content-disposition': 'attachment; filename="device-agent.tar"' }),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  const api = createApi({
    routes, stream, version: o.version, trustedOrigin: o.trustedOrigin,
    // The approval prompt goes only where it can be answered.
    visible: (event, p) => event !== 'join_request' || allows('approver', p) === 'ok',
    onError: (e) => log.problem('api', 'Something went wrong inside Nova while answering a request.', { detail: (e as Error)?.stack ?? String(e) }),
  });

  // Grounding (self.ts): the briefing and the agent's read-only status tools, in process.
  const self = new Self({
    home: o.home, ingest, version: o.version, instance: () => o.instance ?? 'production', codeRoot: CODE_ROOT,
    profile, memory, providers, models: models!, connectors, capture, devices, triggers, design, log, now,
    hubId: () => meshIdentity.id, role: () => role.role(), online: (d) => deviceView(d).online, setupDone: () => setup.view().done,
    ...(o.chat ? { chat: o.chat } : {}),
  });

  const core = {
    self,
    db, log, profile, ledger, setup, extensions, design, workspace, migration, routes, templates, decisions, triggers, memory, receipts, backups, providers, browser, computer, coding, infra, network,
    ingest, vault, broker: o.broker ?? null, connectors, capture, models, changes, caps,
    // The Decision Service (DS1): its view of the seats, a refresh, how a template stands, and
    // asking for a template. Never a seat: nothing reaches a decision model except through it.
    decisionService: { view: decisionService.view, refresh: decisionService.refresh, standing: decisionService.standing, ask: decisionService.service.ask.bind(decisionService.service) }, foundry, resilience: keep, checkpoints, restarter, reset,
    // Restarts this Nova in place (resilience/restart.ts): what a restore, or a factory reset, calls
    // once its marker is staged.
    restartInPlace: (why: string) => restarter.restartInPlace(why),
    // Before a restart in place (and a stop): running tasks stop and are left for the next start,
    // and every process Nova started is ended, within `boundMs`.
    stopWork,
    health,
    openapi: api.doc,
    identity: () => identityOf(profile),
    persona: () => render(identityOf(profile)),
    mesh: { identity: meshIdentity, devices, enroll, access, spokes, info: meshInfo, role, sync, promotions },
    // Who is asking, for a request outside /api/v1, or null once a refusal was sent (mesh/access.ts).
    gate: (req: IncomingMessage, res: ServerResponse, url: URL, listener: Listener) => {
      const p = access.gate(req, res, url, listener);
      // While a factory reset is staged, nothing new is taken.
      const resetting = p ? reset.blocks(req.method, url.pathname) : null;
      if (resetting) {
        res.writeHead(409, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: resetting, resetting: true }));
        return null;
      }
      const write = p && req.method !== 'GET' && req.method !== 'HEAD';
      const replica = write && !REPLICA_WRITES.has(url.pathname) ? role.replica() ?? (HOLD_PASSES(url.pathname) ? null : role.held()) : null;
      if (!replica) {
        // A change past the gate, counted until it has answered: a hold for a hand-over waits for
        // these before it fixes the last sequence (M10g review, finding 5).
        if (write && !HOLD_PASSES(url.pathname)) { inflightWrites++; let done = false; const end = () => { if (!done) { done = true; inflightWrites--; } }; res.once('finish', end); res.once('close', end); }
        return p;
      }
      res.writeHead(409, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: replica.reason, replica: true }));
      return null;
    },
    // The core's routes, for the principal the gate found.
    // Also the device agent's installer and archive (public; mesh/access.ts PUBLIC_PATHS).
    handle: async (req: IncomingMessage, res: ServerResponse, url: URL, principal: Principal, listener: Listener) => {
      const address = access.address(req, listener);
      // Contact for the dead-man's switch (M10d): a trusted device's request on the mesh listener,
      // once its answer went out successfully, and only from off the hub's own machine.
      if (principal.kind === 'device' && listener === 'mesh') {
        const id = principal.device.id;
        res.once('finish', () => {
          if (res.statusCode >= 400) return;
          const bare = address.replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
          const onHub = loopbackAddress(bare) || hubAddress().hosts.some((h) => h.replace(/^\[|\]$/g, '') === bare);
          try { network.contact(id, { onHub }); } catch (e) { log.warn('network', 'Nova couldn’t record contact with a device.', { error: (e as Error).message }); }
        });
      }
      return agentDownload(req, res, url) || api.handle(req, res, url, { principal, listener, address });
    },
    // A hub recovers the ledger, then starts the heartbeat: once now (to catch up), then every
    // 30 s. A standby starts copying the hub instead, and runs nothing else.
    start() {
      // Under the supervisor: where the data stands before any work runs (recovery, the
      // heartbeat), so going back to an older release can tell whether it would undo any of it.
      o.supervisor?.mark?.({
        seq: db.get<{ s: number }>('SELECT IFNULL(MAX(seq), 0) AS s FROM sync_log')?.s ?? 0,
        problem: db.get<{ p: number }>('SELECT IFNULL(MAX(id), 0) AS p FROM problem')?.p ?? 0,
      });
      // A clock that went back while Nova was off shows as records written "in the future". A
      // sandbox copy (M7a's sandbox mode, also used by the restore drill and release deploys)
      // keeps no clock of its own.
      if (!o.sandbox) keep.checkClock(true);
      browser.sweep();
      // A restore finished at this start becomes a ledger task with its evidence.
      if (role.role() === 'hub' && !o.sandbox) {
        try { checkpoints.recordFinished(); } catch (e) { log.problem('resilience', 'Nova couldn’t record a finished restore in the ledger.', { detail: (e as Error)?.stack ?? String(e) }); }
      }
      // A hub that stopped while it held writes to hand over starts holding them, before any work is
      // recovered (M10g review, finding 4): work handed over must not run here too.
      const held = !o.sandbox && promotions.restoreHold();
      const recovered = role.role() === 'hub' && !held ? startHub() : { requeued: [], reverified: [] };
      role.start();
      // A promotion this node was part of carries on (M10g).
      if (!o.sandbox) promotions.start();
      return recovered;
    },
    // Waits briefly for running work; anything still running is requeued on the next start.
    async close() {
      o.broker?.close();
      stopHub();
      promotions.close();
      await role.close();
      // Browsers close first and their tasks stay as they are: the next start runs them again.
      await browser.close();
      computer.close();
      coding.close();
      network.close();
      await capture.stop();
      await Promise.race([ticking.then(() => ledger.idle()), new Promise((r) => setTimeout(r, 2000).unref())]);
      db.close();
    },
  };
  return core;
}

// Replaces the hub's keys after they were exposed (the README's “If the hub’s keys were exposed”):
// new keys under the same id, a higher epoch, and the computers and standby that pinned the old key
// revoked, to be added again. Run with Nova stopped (scripts/rotate-hub-keys.js).
export async function rotateHubKeys(home: string, o: { now?: () => Date } = {}) {
  // A mistyped home must not become a new, empty one.
  if (!existsSync(join(home, 'mesh', 'identity.json'))) throw new CoreError('not_found', `${home} has no keys to replace (no mesh/identity.json). Is that Nova’s home?`);
  const open =() => createCore({ home, version: 'rotate', trustedOrigin: () => false, ...(o.now ? { now: o.now } : {}) });
  const probe = open();
  const hub = probe.mesh.role.role() === 'hub';
  await probe.close();
  if (!hub) throw new CoreError('conflict', 'This node is a standby, not the hub. Enroll it again with a new home instead of replacing its keys.');
  replaceIdentityKeys(home, o);
  const core = open();
  try {
    const r = core.mesh.devices.rekeyHub('console');
    return { epoch: r.epoch, fingerprint: core.mesh.identity.fingerprint, revoked: r.revoked.map((d) => ({ id: d.id, name: d.name, kind: d.kind })) };
  } finally {
    await core.close();
  }
}
```

### `src/server.js`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `341525d2487a7cb9e88b98dc2ad5b437b3010488`, SHA256 `946abe8ebbe269b45be11c0a43b0acd1dacb5ef91fc356820833268041a527ec`, 746 physical lines (747 under boundary count).

```js
// Nova's local web server: the UI, a small JSON API, and a server-sent event
// stream per conversation. Binds to 127.0.0.1 by default. A second listener, the
// mesh listener, serves paired devices when one is configured (src/core/mesh/access.ts
// says who may do what on either).
import { createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { createServer as createTlsServer } from 'node:https';
import { createReadStream, existsSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { ConfigError, loadConfig } from './config.js';
import { ensureGit, seedHome } from './home.js';
import { SessionStore, validId } from './sessions.js';
import { Runner, BusyError } from './runner.js';
import { SkillError } from './skills.js';
import { GmailError } from './connectors/gmail.js';
import { gmailConnector } from './connectors/gmail-connector.js';
import { ZipError, unzip } from './zip.js';
import { ScheduleError, formatWhen } from './schedules.js';
import { Scheduler } from './scheduler.js';
import { HelperError, Helpers } from './helpers.js';
import { buildActivity, notStarted } from './activity.js';
import { ChatRun, SYSTEM } from './chat-run.js';
import { render as renderPermissions } from './permissions.js';
import { BrokerClient, KIND_WORDS, STATUS_BAR_TAG, createCore, ensureMark, finishReset, fromBrowserTask, ipcBroker, ipcLink, originHost, standInOs, statusBarTag, transportFromEnv } from './core/index.ts';
import { AgentError } from './agent.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

// The local model manager's settings from the environment (M6b): NOVA_OLLAMA_URL is where the
// hub's Ollama answers when the profile doesn't say; NOVA_HARDWARE_FILE (JSON, tests and the gate's
// stand-in run) replaces reading this machine's hardware; NOVA_MODELS_WATCH_MS and
// NOVA_MODELS_WAKE_POLL_MS shorten how often waiting work and a waking computer are checked.
function modelOptions(env) {
  const o = {};
  if (env.NOVA_OLLAMA_URL) o.ollamaUrl = env.NOVA_OLLAMA_URL;
  if (env.NOVA_HARDWARE_FILE) { const file = env.NOVA_HARDWARE_FILE; o.hardware = async () => JSON.parse(readFileSync(file, 'utf8')); }
  if (Number(env.NOVA_MODELS_WATCH_MS) > 0) o.watchMs = Number(env.NOVA_MODELS_WATCH_MS);
  if (Number(env.NOVA_MODELS_WAKE_POLL_MS) > 0) o.wakePollMs = Number(env.NOVA_MODELS_WAKE_POLL_MS);
  return o;
}

// Read only the public browser helper from this release. Type erasure does not execute it;
// no route can choose another source file, and Core never imports broker runtime code.
let sealModule;
function publicSealModule() {
  return sealModule ??= stripTypeScriptTypes(readFileSync(new URL('./broker/seal.ts', import.meta.url), 'utf8'), { mode: 'strip' });
}

export function createNova(config = loadConfig(), deps = {}) {
  const started = performance.now();
  // A factory reset staged before the last stop (M7 amendment §2) finishes before anything touches
  // the home, seeding included, so a reset home is seeded fresh. (A staged restore is applied by the
  // core, with its options.) It throws when it can't finish: a half-reset Nova never runs.
  if (process.env.NOVA_SANDBOX !== '1') finishReset(config.home, { leaveUnverified: true });
  // Nova's mark on its home, before seeding: what is in the folder now, before Nova adds anything,
  // is what a reset must never erase (core resilience/home-mark.ts).
  if (process.env.NOVA_SANDBOX !== '1') ensureMark(config.home);
  const seeded = seedHome(config.home, join(config.root, 'templates', 'home'));
  // The core (src/core): database, Work Ledger, profile, identity, setup, extensions, /api/v1.
  const { version } = JSON.parse(readFileSync(join(config.root, 'package.json'), 'utf8'));
  const program = config.agentCmd.trim().split(/\s+/).find((w) => !w.includes('=')) ?? 'the model command';
  // Scheduled runs and helpers are Work Ledger tasks for the chat-run worker, which runs them
  // through the runner (bound below, once it exists). Its evidence is checked by reading the
  // conversation the report went to.
  const chatRun = new ChatRun({ program, egress: config.agentEgress, privacy: () => core.profile.privacyDefault() });
  // Shared with the core by reference: with port 0 in NOVA_MESH_URL, the real port is filled in
  // once the mesh listener is bound (tests use that, so no other process can take the port first).
  const meshInfo = config.mesh ? { publicUrl: config.mesh.publicUrl, transport: config.mesh.transport, address: config.mesh.address ?? null } : null;
  const core = createCore({
    home: config.home, version, instance: config.instance, detectedTimezone: config.timezone, trustedOrigin: (host) => allowedHost(host), chat: { program, egress: config.agentEgress },
    mesh: meshInfo,
    // Late counts: no session title, kind or transcript is opened for diagnostics.
    diagnostics: { era2: () => ({ chat_logs: store.countLogs(), schedules: runner.schedules.list().length, skills: runner.skills.installed().length }) },
    // Nova's own listeners, which a browser task never reaches (browser/plan.ts). Read when a
    // task is checked or run, by then both are listening (port 0 means the port they got).
    hubPorts: () => {
      let bound = [];
      try { bound = [server, mesh].map((s) => s?.address()?.port); } catch { /* not created yet */ }
      return [config.port, config.mesh?.port, ...bound].filter((p) => Number.isInteger(p) && p > 0);
    },
    workers: [chatRun], confirmations: { [SYSTEM]: (e, brief) => chatRun.confirm(e, brief) },
    // Era 2's model command is the custom-cli provider (M5a). A provider's secret://NAME comes from
    // the vault (PUT /api/v1/vault/NAME). NOVA_SECRET_<NAME> in the environment is a fallback for
    // development and tests only: the vault wins, and such a value is redacted like a vault one.
    agent: { command: config.agentCmd, egress: config.agentEgress },
    secrets: deps.secrets ?? ((name) => process.env[`NOVA_SECRET_${name}`] ?? null),
    // deps.models: tests only (a stand-in Ollama and fixed hardware without touching the environment).
    models: { ...modelOptions(process.env), ...(deps.models ?? {}) },
    // deps.decisions: tests only (a verdict store in place of the committed eval verdicts).
    ...(deps.decisions ? { decisions: deps.decisions } : {}),
    // Started by the supervisor (src/supervisor), it can ask for a deploy or rollback (M7b).
    supervisor: deps.supervisor ?? ipcLink(process),
    broker: deps.broker ?? null,
    sealModule: publicSealModule,
    ...(deps.topologyCluster ? { topologyCluster: deps.topologyCluster } : {}),
    // A sandbox copy started by the change pipeline (M7a): no outside work, no changes taken.
    sandbox: process.env.NOVA_SANDBOX === '1',
    // Onboarding (M10f): NOVA_DETECT_OS is a stand-in detection (tests, demos: only the words
    // change); NOVA_DISCOVERY_PORTS and NOVA_DISCOVERY_MDNS point discovery at stand-ins on loopback.
    onboarding: { os: standInOs(process.env.NOVA_DETECT_OS), transport: transportFromEnv(process.env) },
  });
  // Chat goes through the registry: the provider the profile names for chat, or agent_cmd (the
  // default), which the runner runs exactly as before. Scheduled runs and helpers follow it.
  const chatProvider = () => {
    const h = core.providers.chat();
    return h && { ...h, call: (o) => h.call(o).catch((e) => { throw e instanceof AgentError ? e : new AgentError(e.message, `provider=${h.id}`); }) };
  };
  Object.defineProperty(chatRun, 'egress', { get: () => core.providers.chat()?.egress ?? config.agentEgress });
  if (!config.timezonePinned && core.identity().timezone) config.timezone = core.identity().timezone;
  const store = new SessionStore(config.home, config.timezone);
  // Curated memory lives in the core; MEMORY.md is rendered from it. The first start imports
  // an existing MEMORY.md once, and every start takes in hand edits made while Nova was off.
  // The ingest gate (Amendment 2026-10-30-C Part 3) screens what the agent reads from outside.
  const runner = new Runner(config, store, { ...deps, records: core.memory, vault: core.vault, ingest: core.ingest });
  // Era 2's Gmail as a connector: its secrets in the vault, Settings › Connections, mail events.
  core.connectors.register(gmailConnector(runner.gmail));
  // Forgetting through the core's API reaches MEMORY.md and the day notes as well.
  core.memory.onForget((records) => runner.memory.forgotten(records));
  runner.memory.readOnly = () => !!core.mesh.role.replica();
  runner.memory.sync();
  runner.chatProvider = chatProvider;
  runner.caps = core.caps;
  // Coding through chat (M10c): the chat agent's code_change and code_status tools start and read the
  // core's coding runs.
  runner.coding = core.coding;
  // Infrastructure, networking and accounts through chat (M10d): the chat agent's infra_plan,
  // network_change and account_change tools start the core's runs, changes and account tasks.
  runner.ops = { infra: core.infra, network: core.network, browser: core.browser };
  // Grounding (core self.ts): the agent's briefing and status tools, with Era 2's schedules and approvals.
  runner.self = core.self.attach({
    schedules: () => { const last = runner.schedules.latest(); return runner.schedules.list().map((s) => { const next = runner.schedules.next(s); return { ...s, next: next ? formatWhen(next, config.timezone) : null, last: last.get(s.id) ?? null }; }); },
    permissions: () => runner.permissions.list(),
  });
  runner.identity = { persona: core.persona, name: () => core.identity().name, privacy: () => core.profile.privacyDefault(), receipt: (r) => core.receipts.record(r) };
  runner.ensureMain();
  // permissions.md is written once, so it can be read and edited by hand; Settings keeps it current.
  if (!existsSync(runner.permissions.file)) writeFileSync(runner.permissions.file, renderPermissions(runner.permissions.list()));
  const scheduler = new Scheduler({ schedules: runner.schedules, runner, store, timezone: config.timezone, ledger: core.ledger, triggers: core.triggers });
  const helpers = new Helpers({ runner, store, ledger: core.ledger });
  runner.helpers = helpers;
  chatRun.bind({ runner, store, ledger: core.ledger, kinds: { schedule: scheduler, helper: helpers } });
  chatRun.problem = (message, opts) => core.log.problem('chat-run', message, opts);
  const ui = join(config.root, 'ui');
  const subscribers = new Map(); // sessionId → Set<res>

  const broadcast = (sessionId, event, data) => {
    for (const res of subscribers.get(sessionId) ?? []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  runner.on('event', (id, ev) => broadcast(id, 'event', ev));
  runner.on('live', (id, live) => broadcast(id, 'live', live));
  runner.on('delta', (id, d) => broadcast(id, 'delta', d));

  // One stream for things that aren't a single conversation: memory changes
  // and the conversation list.
  const watchers = new Set();
  const announce = (event, data = {}) => { for (const res of watchers) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  runner.on('memory', () => announce('memory'));
  runner.on('event', (_, ev) => { if (ev.type === 'session' || ev.type === 'title') announce('sessions'); });
  const memory = runner.memory;
  const titles = () => Object.fromEntries(store.list().map((s) => [s.id, s.title]));
  const saved = () => announce('memory'); // memory isn't in git history, so there's nothing to commit
  const { skills, gmail } = runner;
  scheduler.on('change', () => announce('schedules'));
  runner.on('schedules', () => { scheduler.tick(); announce('schedules'); });
  scheduler.on('ran', ({ target, handoff }) => { announce('schedules'); announce('handoff', { target, handoff }); });
  helpers.on('ran', ({ target, handoff }) => announce('handoff', { target, handoff }));

  // Activity: a nudge, a few times a second at most, whenever Nova's work
  // moves; open pages fetch the timeline again. The nudge says how much is
  // working and how much is waiting for the person, for the sidebar.
  const busy = () => {
    const live = [...runner.active.keys()].map((id) => runner.liveState(id));
    const queued = notStarted(core.ledger, store, 'helper').length + notStarted(core.ledger, store, 'schedule').length;
    return { working: live.length + queued, waiting: live.filter((l) => l?.approval).length };
  };
  let nudge = null;
  // Only open pages need it; and once Nova is shutting down, the ledger may already be closed.
  const moved = () => {
    nudge ??= setTimeout(() => {
      nudge = null;
      if (!watchers.size) return;
      try { announce('activity', busy()); } catch { /* closing */ }
    }, 150);
  };
  const STEPS = new Set(['session', 'user', 'tool_call', 'approval', 'tool_result', 'skill', 'memory', 'done', 'error', 'stopped', 'delivered']);
  runner.on('event', (_, ev) => { if (STEPS.has(ev.type)) moved(); });
  runner.on('live', moved);
  helpers.on('change', moved);
  scheduler.on('change', moved);
  core.ledger.on('task', (t) => {
    if (t.owner !== 'chat-run') return;
    moved();
    if (t.brief.inputs?.kind === 'schedule') announce('schedules');
  });
  const activity = (before) => buildActivity({ store, runner, ledger: core.ledger, schedules: runner.schedules, timezone: config.timezone, before });
  const { schedules } = runner;
  const schedulesView = () => {
    const latest = schedules.latest();
    return {
      set: schedules.list().map((s) => {
        const st = scheduler.status(s.id);
        return {
          ...s,
          next: schedules.next(s)?.toISOString() ?? null,
          last: latest.get(s.id) ?? null,
          running: st.running ?? null,
          queued: !!st.queued,
        };
      }),
      available: schedules.available(),
      timezone: config.timezone,
    };
  };
  // A skill from outside that the screen held back says why, until the person turns it on.
  // A skill from outside (uploaded, not one Nova ships) is screened as it comes in: a block refuses
  // it, and an unsure one is installed but held back, with the reasons, until the person turns it on.
  //
  // Every file is screened before anything is written: a text file that isn't UTF-8 is refused
  // (NUL bytes are taken out for the screen, never a reason to skip it); a file that isn't text
  // (an image, a font) can't be checked, which holds the skill. It is then written to a staging
  // folder and moved into place, held first if it is to be held, so it is never usable unchecked.
  // Each file's hash is kept: a file changed after the check is outside content again.
  const BINARY = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|woff2?|ttf|otf|eot|zip|gz|mp3|mp4|wav|ogg|webm)$/i;
  const NO_MODEL = 'Nova couldn’t fully check it: no sorting model is set up, so only Nova’s own checks ran';
  async function installScreened(prepared, { refused }) {
    const texts = [];
    let unread = 0;
    for (const [p, data] of prepared.entries) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (BINARY.test(p)) { unread++; continue; }
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch {
        return { error: `${refused} it couldn’t read ${p} as text, so it couldn’t check it.` };
      }
      texts.push(`${p}:\n${text.replace(/\u0000/g, '')}`);
    }
    const s = await core.ingest.screen({ text: texts.join('\n\n'), source: { kind: 'skill', origin: prepared.id } });
    if (s.verdict === 'block') return { error: `${refused} it looked like it was trying to give Nova instructions it shouldn’t follow. Tasks has the details.` };
    const reasons = [...new Set([
      ...s.flags.filter((f) => f.level !== 'note').map((f) => KIND_WORDS[f.kind] ?? f.kind),
      ...(s.model ? [] : [NO_MODEL]),
      ...(unread ? [`Nova couldn’t check ${unread} file${unread === 1 ? '' : 's'} it can’t read as text`] : []),
    ])];
    const hold = s.verdict !== 'pass' || unread > 0;
    if (hold) core.ingest.hold('skill', prepared.id, s, reasons);
    else core.ingest.release('skill', prepared.id);
    let skill;
    try { skill = skills.commit(prepared); } catch (e) { if (hold) core.ingest.release('skill', prepared.id); throw e; }
    runner.trustSkill(prepared.id);
    return { skill, screen: s };
  }
  const skillsView = () => ({
    installed: skills.installed().map((x) => ({ ...x, held: runner.skillHeld(x.id) })),
    available: skills.available(),
    connectors: { gmail: gmail.status() },
  });

  // Google sends the person back to the address they're using Nova at, so a
  // sign-in returns to the same page. Only this machine can receive it.
  const loopback = (host) => ['localhost', '127.0.0.1', '::1'].includes(String(host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, ''));

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req, limit = 1_000_000) => new Promise((ok, fail) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { fail(new Error('too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { ok(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch { fail(new Error('bad json')); } });
    req.on('error', fail);
  });

  // Requests must come from Nova's own page. The Host check stops DNS
  // rebinding; the custom header makes cross-site POSTs impossible without a
  // CORS preflight, which this server never grants. Devices address Nova by its
  // mesh address.
  const meshHosts = config.mesh ? [new URL(config.mesh.publicUrl).hostname.replace(/^\[|\]$/g, ''), config.mesh.bindHost] : [];
  const allowedHost = (host) => {
    const name = String(host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    return ['localhost', '127.0.0.1', '::1', config.host, ...meshHosts].includes(name);
  };

  // npm run dev: watch ui/ and tell open pages to refresh.
  const devClients = new Set();
  if (config.dev) {
    let timer = null;
    watch(ui, { recursive: true }, (_, name) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const kind = String(name).endsWith('.css') ? 'css' : 'reload';
        for (const res of devClients) res.write(`event: change\ndata: ${JSON.stringify({ kind, name })}\n\n`);
      }, 40);
    });
  }

  // `clear`: after a factory reset, the hub's own screen is told once to forget what its browser
  // kept of the Nova that was erased (core resilience/reset.ts, clearHeaders).
  // `page`: changes an HTML page before it is sent (the app page's status bar tag).
  function serveFile(res, file, clear = {}, page = null) {
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    if (page || (config.dev && file.endsWith('.html'))) {
      let html = readFileSync(file, 'utf8');
      if (page) html = page(html);
      if (config.dev) html = html.replace('</body>', '<script type="module" src="/js/dev-reload.js"></script></body>');
      res.writeHead(200, config.dev ? { 'content-type': type, 'cache-control': 'no-store', ...clear } : { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', ...clear });
      return res.end(html);
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', ...clear });
    createReadStream(file).pipe(res);
  }

  function serveStatic(req, res, path, principal) {
    // The PWA's places (ui/js/nav.js); Era 2's paths keep working.
    if (path === '/pair') return serveFile(res, join(ui, 'pair.html'));
    // The app page carries the iPhone status bar of the design this device shows (DESIGN-SYSTEM
    // §5): its appearance id comes from the cookie theme.js keeps (none yet: the person's design;
    // theme.js corrects the tag once loaded). If the design can't be read, the page goes as it
    // ships: iOS's own strip, readable over any design.
    const appearance = /(?:^|;\s*)nova-appearance=([A-Za-z0-9_-]{8,64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1] ?? null;
    const statusBar = (html) => { try { return html.replace(STATUS_BAR_TAG, statusBarTag(core.design.active(appearance))); } catch { return html; } };
    if (['/', '/chat', '/new', '/tasks', '/memory', '/automations', '/skills', '/schedules', '/activity', '/health', '/settings', '/capture', '/topology'].includes(path) || path.startsWith('/c/')) return serveFile(res, join(ui, 'index.html'), core.reset.clearHeaders(principal, req.headers.cookie), statusBar);
    if (path === '/styleguide') return serveFile(res, join(ui, 'styleguide.html'));
    const file = resolve(ui, normalize(`.${decodeURIComponent(path)}`));
    if (!file.startsWith(ui + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    serveFile(res, file);
  }

  async function api(req, res, parts) {
    const [, , resource, id, action, sub] = parts; // ['', 'api', ...]
    if (req.method === 'POST') {
      if (req.headers['x-nova'] !== '1') return json(res, 403, { error: 'Missing X-Nova header' });
      const origin = req.headers.origin;
      // `Origin: null` or a malformed one names no host: refused, never a 500.
      const host = origin ? originHost(origin) : null;
      if (origin && (!host || !allowedHost(host))) return json(res, 403, { error: 'Cross-origin request refused' });
    }

    if (resource === 'health') return json(res, 200, { ok: true, agent: config.agentCmd.trim().split(/\s+/)[0] });
    if (resource === 'config') return json(res, 200, { theme: config.theme, timezone: config.timezone });

    if (resource === 'events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': nova\n\n');
      watchers.add(res);
      const beat = setInterval(() => res.write(': beat\n\n'), 20_000);
      req.on('close', () => { clearInterval(beat); watchers.delete(res); });
      return;
    }

    if (resource === 'memory') {
      // candidates: what a conversation that read outside content wanted kept, waiting for the person.
      if (req.method === 'GET' && !id) {
        // A forget waiting for the person names the memory it would forget.
        const candidates = core.ingest.candidates().map((c) => (c.op === 'forget' && c.target ? { ...c, target_text: memory.record(c.target)?.content ?? null } : c));
        return json(res, 200, { ...memory.read(), titles: titles(), candidates });
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      if (id === 'candidates' && action && (sub === 'keep' || sub === 'drop')) {
        if (sub === 'drop') return core.ingest.dropCandidate(action) ? (saved(), json(res, 200, { ok: true })) : json(res, 404, { error: 'That’s already been dealt with.' });
        const c = core.ingest.takeCandidate(action);
        if (!c) return json(res, 404, { error: 'That’s already been dealt with.' });
        let done;
        if (c.op === 'remember') {
          done = memory.remember({ kind: c.kind ?? 'fact', text: c.content ?? '', ...(c.replaces ? { replaces: c.replaces } : {}), ...(c.source ? { from: c.source } : {}) });
          // The person kept it, so it is theirs: confirmed, not "not yet reviewed".
          if (done.ok && done.id && !done.existing) try { core.memory.confirm(done.id, 'person'); } catch { /* corrected since */ }
        } else if (c.op === 'note') done = memory.note({ text: c.content ?? '', ...(c.source ? { from: c.source } : {}) });
        else done = { op: 'forget', removed: memory.forget(c.target ?? '', { by: 'person' }) };
        saved();
        return json(res, 200, { kept: done });
      }
      if (id === 'restore') {
        const { items } = await readBody(req);
        if (!Array.isArray(items)) return json(res, 400, { error: 'items must be a list' });
        memory.restore(items);
        saved();
        return json(res, 200, { ok: true });
      }
      // Ids from Era 2 (m…, n…, h…) and the core's own (a UUID).
      if (!/^([mnh][0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(String(id))) return json(res, 404, { error: 'No such memory' });
      if (action === 'forget') {
        const removed = memory.forget(id, { by: 'person' });
        if (!removed.length) return json(res, 404, { error: 'That was already forgotten.' });
        saved();
        return json(res, 200, { removed });
      }
      if (!action) {
        const { text } = await readBody(req);
        let entry;
        try { entry = memory.edit(id, text); } catch (e) { return json(res, 400, { error: e.message }); }
        if (!entry) return json(res, 404, { error: 'That memory is gone. It may have been forgotten.' });
        saved();
        return json(res, 200, { entry });
      }
      return json(res, 404, { error: 'Not found' });
    }

    if (resource === 'skills') {
      if (req.method === 'GET' && !id) return json(res, 200, skillsView());
      if (req.method !== 'POST' || !id) return json(res, 405, { error: 'Method not allowed' });
      // A skill the person brings: a folder's files, or a .zip.
      if (id === 'add' && !action) {
        let body;
        try { body = await readBody(req, 8_000_000); } catch { return json(res, 413, { error: 'That skill is too big to add. Skills can be up to 5 MB.' }); }
        try {
          const prepared = skills.prepare(body.zip ? unzip(Buffer.from(String(body.zip), 'base64')) : body.files);
          const done = await installScreened(prepared, { refused: 'Nova didn’t add this skill:' });
          if (done.error) return json(res, 400, { error: done.error });
          announce('skills');
          return json(res, 200, { skill: { ...done.skill, held: runner.skillHeld(done.skill.id) } });
        } catch (e) {
          if (e instanceof SkillError) return json(res, e.status, { error: e.message });
          if (e instanceof ZipError) return json(res, 400, { error: e.message });
          throw e;
        }
      }
      try {
        let skill = null;
        let files;
        if (action === 'install') { skill = skills.install(id); runner.trustSkill(id); }
        else if (action === 'remove') { files = skills.remove(id); core.ingest.release('skill', id); }
        else if (action === 'restore') {
          // Put back from Undo: screened again, exactly as when it came in.
          const prepared = skills.prepareRestore(id, (await readBody(req)).files);
          // One Nova ships, exactly as it ships it, comes back as it was; anything else is screened.
          if (skills.isCatalogCopy(prepared)) { skill = skills.commit(prepared); runner.trustSkill(id); }
          else {
            const done = await installScreened(prepared, { refused: 'Nova didn’t put this skill back:' });
            if (done.error) return json(res, 400, { error: done.error });
            skill = done.skill;
          }
        }
        // Turning on a skill that is held back (or that changed since Nova checked it) is the person's call.
        else if (action === 'allow') {
          if (!runner.skillHeld(id)) return json(res, 404, { error: 'That skill isn’t held back.' });
          core.ingest.release('skill', id);
          runner.trustSkill(id);
        }
        else return json(res, 404, { error: 'Not found' });
        announce('skills');
        return json(res, 200, files ? { files } : { skill });
      } catch (e) {
        if (e instanceof SkillError) return json(res, e.status, { error: e.message });
        throw e;
      }
    }

    if (resource === 'schedules') {
      if (req.method === 'GET' && !id) return json(res, 200, schedulesView());
      if (req.method !== 'POST' || !id || !action) return json(res, 405, { error: 'Method not allowed' });
      try {
        let body;
        if (action === 'run') {
          if (!schedules.get(id)) return json(res, 404, { error: 'That schedule is gone. It may have been removed.' });
          body = { queued: scheduler.runNow(id) };
        } else if (action === 'pause') body = { schedule: schedules.setPaused(id, true) };
        else if (action === 'resume') body = { schedule: schedules.setPaused(id, false) };
        else if (action === 'remove') body = { text: schedules.remove(id).text };
        else if (action === 'restore') body = { schedule: schedules.restore(id, (await readBody(req)).text) };
        else if (action === 'setup') body = { schedule: schedules.setup(id, await readBody(req)) };
        else return json(res, 404, { error: 'Not found' });
        scheduler.tick();
        announce('schedules');
        return json(res, 200, body);
      } catch (e) {
        if (e instanceof ScheduleError) return json(res, e.status, { error: e.message });
        throw e;
      }
    }

    if (resource === 'permissions') {
      const { permissions } = runner;
      if (req.method === 'GET' && !id) return json(res, 200, { permissions: permissions.list() });
      if (req.method !== 'POST' || !id || !['allow', 'ask'].includes(action)) return json(res, 405, { error: 'Method not allowed' });
      if (!permissions.list().some((p) => p.id === id)) return json(res, 404, { error: "That permission doesn't exist any more." });
      const list = permissions.set(id, action === 'allow');
      announce('permissions');
      return json(res, 200, { permissions: list });
    }

    if (resource === 'activity') {
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
      const before = new URL(req.url, 'http://nova.local').searchParams.get('before');
      if (before && !/^\d{4}-\d{2}-\d{2}$/.test(before)) return json(res, 400, { error: 'before must be a day, such as 2026-10-21' });
      return json(res, 200, { ...activity(before), busy: busy() });
    }

    if (resource === 'helpers') {
      if (req.method !== 'POST' || !id || !action) return json(res, 405, { error: 'Method not allowed' });
      if (!validId(id)) return json(res, 404, { error: 'That helper is gone.' });
      try {
        if (action === 'stop') return helpers.stop(id) ? json(res, 200, { stopped: true }) : json(res, 409, { error: 'That helper has already finished.' });
        if (action === 'retry') return json(res, 200, helpers.retry(id));
      } catch (e) {
        if (e instanceof HelperError) return json(res, e.status, { error: e.message });
        throw e;
      }
      return json(res, 404, { error: 'Not found' });
    }

    if (resource === 'connectors') {
      if (id !== 'gmail') return json(res, 404, { error: 'Not found' });
      if (req.method === 'GET' && !action) return json(res, 200, gmail.status());
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      try {
        let body;
        if (action === 'password') {
          const { email, password } = await readBody(req);
          body = await gmail.connectPassword({ email, password });
        } else if (action === 'client') body = gmail.setClient((await readBody(req)).json);
        else if (action === 'forget-client') body = gmail.forgetClient();
        else if (action === 'disconnect') body = await gmail.disconnect();
        else if (action === 'connect') {
          if (!loopback(req.headers.host) || fromBrowserTask(req.headers)) return json(res, 400, { error: 'Open Nova on this computer, at localhost, to connect Gmail. Google sends you back to this computer only.' });
          return json(res, 200, { url: gmail.authUrl(`http://${req.headers.host}/oauth/gmail`) });
        } else return json(res, 404, { error: 'Not found' });
        announce('skills');
        core.connectors.touched('gmail');
        return json(res, 200, body);
      } catch (e) {
        if (e instanceof GmailError) return json(res, 400, { error: e.message });
        throw e;
      }
    }

    if (resource !== 'sessions') return json(res, 404, { error: 'Not found' });
    if (!id) {
      if (req.method === 'GET') return json(res, 200, store.list());
      if (req.method === 'POST') {
        const { text } = await readBody(req);
        if (!String(text ?? '').trim()) return json(res, 400, { error: 'Write a message first.' });
        const sessionId = runner.createSession(text);
        const turn = runner.send(sessionId, String(text));
        return json(res, 201, { id: sessionId, turn });
      }
      return json(res, 405, { error: 'Method not allowed' });
    }

    if (!validId(id) || !store.exists(id)) return json(res, 404, { error: 'No such conversation' });

    if (req.method === 'GET' && !action) return json(res, 200, runner.snapshot(id));
    if (req.method === 'GET' && action === 'events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: snapshot\ndata: ${JSON.stringify(runner.snapshot(id))}\n\n`);
      if (!subscribers.has(id)) subscribers.set(id, new Set());
      subscribers.get(id).add(res);
      const beat = setInterval(() => res.write(': beat\n\n'), 20_000);
      req.on('close', () => { clearInterval(beat); subscribers.get(id)?.delete(res); });
      return;
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

    try {
      if (action === 'messages') {
        const { text } = await readBody(req);
        if (!String(text ?? '').trim()) return json(res, 400, { error: 'Write a message first.' });
        return json(res, 202, { turn: runner.send(id, String(text)) });
      }
      if (action === 'regenerate') {
        try { return json(res, 202, { turn: runner.regenerate(id) }); } catch (e) {
          if (e.message === 'Nothing to regenerate') return json(res, 409, { error: 'There is no reply to regenerate.' });
          throw e;
        }
      }
      if (action === 'stop') return json(res, 200, { stopped: runner.stop(id) });
      if (action === 'approvals' && sub) {
        const { decision } = await readBody(req);
        if (!['allow', 'deny'].includes(decision)) return json(res, 400, { error: 'decision must be allow or deny' });
        return runner.decide(id, sub, decision) ? json(res, 200, { ok: true }) : json(res, 409, { error: 'That request is no longer waiting.' });
      }
    } catch (e) {
      if (e instanceof BusyError) return json(res, 409, { error: e.message });
      throw e;
    }
    return json(res, 404, { error: 'Not found' });
  }

  // One handler for both listeners; the listener is part of who is asking.
  const handler = (listener) => async (req, res) => {
    try {
      if (!allowedHost(req.headers.host)) { res.writeHead(421); return res.end('Misdirected request'); }
      const url = new URL(req.url, 'http://nova.local');
      const parts = url.pathname.split('/');
      // The console, a paired device, or no one yet: a refusal is sent here and nothing below runs.
      const principal = core.gate(req, res, url, listener);
      if (!principal) return;
      if (config.dev && url.pathname === '/__dev/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        res.write(': dev\n\n');
        devClients.add(res);
        return req.on('close', () => devClients.delete(res));
      }
      if (await core.handle(req, res, url, principal, listener)) return;
      // The active design system as CSS variables (?device= for a device's own choice). Pages
      // fetch it again on the core's design-system event, so a change needs no reload.
      if (url.pathname === '/design-system.css' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return res.end(core.design.css(url.searchParams.get('device')));
      }
      if (parts[1] === 'api') return await api(req, res, parts);
      if (url.pathname === '/oauth/gmail' && req.method === 'GET') {
        const q = Object.fromEntries(url.searchParams);
        await runner.gmail.finish({ code: q.code, state: q.state, error: q.error });
        announce('skills');
        core.connectors.touched('gmail');
        res.writeHead(303, { location: '/skills#gmail', 'cache-control': 'no-store' });
        return res.end();
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      serveStatic(req, res, url.pathname, principal);
    } catch (e) {
      if (!res.headersSent) json(res, e.message === 'bad json' || e.message === 'too large' ? 400 : 500, { error: e.message });
      else res.end();
    }
  };
  const server = createServer(handler('console'));
  const m = config.mesh;
  const mesh = !m ? null : m.tls
    ? createTlsServer({ cert: readFileSync(m.tls.cert), key: readFileSync(m.tls.key) }, handler('mesh'))
    : createServer(handler('mesh'));

  return { server, mesh, meshInfo, runner, store, scheduler, helpers, chatRun, config, seeded, started, core };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let nova;
  try {
    const context = await ipcBroker(process);
    nova = createNova(undefined, { broker: context ? new BrokerClient(context) : null });
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.error(`Nova didn't start: ${e.message}`);
    process.exit(1);
  }
  const { config } = nova;
  // Said once per open problem, not once per start: it stays open until the keys are replaced.
  ensureGit(config.home, {
    problem: (m) => { if (!nova.core.log.problems({ open: true }).some((p) => p.message === m)) nova.core.log.problem('mesh', m); },
    // The keys were replaced since: the warning has done its job.
    resolved: (m) => { for (const p of nova.core.log.problems({ open: true })) if (p.message === m) nova.core.log.resolve(p.id); },
  });
  // A hub first asks its roster peers whether one of them became hub while it was away (fencing).
  const { role } = nova.core.mesh;
  // A sandbox (a release on a copy of the home, a restore drill) runs no work and asks no peer
  // anything: it is never the hub anyone uses (M7b).
  const sandbox = process.env.NOVA_SANDBOX === '1';
  if (!sandbox) await role.fence();
  // Only the hub runs work. A standby copies the hub and starts all of this when it is promoted.
  const runWork = () => {
    nova.helpers.recover(); // helper logs from before the ledger; the rest is the ledger's recovery
    nova.chatRun.recover();
    nova.scheduler.start();
  };
  // A hub that stopped while it held writes to hand over (M10g) runs no work until that is settled.
  const hub = !role.replica() && !sandbox && !nova.core.mesh.promotions.holdPending();
  if (hub) nova.helpers.recover();
  const recovered = nova.core.start();
  if (hub) {
    nova.chatRun.recover();
    nova.scheduler.start();
  }
  if (recovered.requeued.length) console.log(`Resumed ${recovered.requeued.length} task(s) that were running when Nova stopped.`);
  if (!hub && !sandbox) console.log(role.replica().reason);
  role.on('promoted', ({ epoch }) => { runWork(); console.log(`This node is the hub now (epoch ${epoch}).`); });
  role.on('demoted', ({ reason }) => { nova.scheduler.stop(); for (const id of nova.runner.active.keys()) nova.runner.stop(id); console.log(reason); });
  // A planned promotion (M10g): the scheduler pauses while the hub drains, starts again if nothing was
  // handed over, and stops when this node becomes the new hub's standby.
  // Era 2's running work stops too (its runs are ledger tasks the drain hands over: M10g review, 5).
  role.on('draining', () => { nova.scheduler.stop(); for (const id of nova.runner.active.keys()) nova.runner.stop(id); });
  role.on('resumed', () => { if (!role.replica()) runWork(); });
  role.on('followed', ({ hub }) => { nova.scheduler.stop(); for (const id of nova.runner.active.keys()) nova.runner.stop(id); console.log(`This node is the standby now, copying the hub (${hub}).`); });
  nova.server.listen(config.port, config.host, () => {
    const ms = Math.round(performance.now() - nova.started);
    // Who is running this home, so tools that must only run while Nova is stopped (replacing the
    // hub's keys) can tell. Removed on a clean stop; a stale one names a pid that is gone.
    writeFileSync(join(config.home, 'nova.pid'), String(process.pid));
    if (nova.seeded.length) console.log(`Seeded ${nova.seeded.length} files into ${config.home}`);
    // The real port, so NOVA_PORT=0 (any free port) still says where Nova is.
    console.log(`Nova is ready at http://${config.host === '127.0.0.1' ? 'localhost' : config.host}:${nova.server.address().port}  (${ms} ms)`);
    console.log(`Home: ${config.home}`);
    // The console is "a request from this machine, to this machine, through no proxy". A program
    // here that passes connections on to this port without saying so (no X-Forwarded-For) makes
    // whoever reaches it look exactly like that. Nova can't tell, so the person must know.
    console.log(`Warning: whoever reaches port ${nova.server.address().port} from this computer controls Nova completely. Don’t point a port forward, tunnel or proxy at it; other devices pair at the mesh address (NOVA_MESH_URL) instead.`);
    if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
      console.log('Note: the console port is listening beyond this machine. Only requests from this machine get the console; anything else must pair first, and pairing needs a mesh address (NOVA_MESH_URL).');
    }
  });
  if (nova.mesh) {
    const m = config.mesh;
    nova.mesh.on('error', (e) => {
      console.error(`Nova couldn’t listen for devices at ${m.bindHost}:${m.port}: ${e.message}`);
      process.exit(1);
    });
    nova.mesh.listen(m.port, m.bindHost, () => {
      const how = { tls: 'over TLS', proxy: 'through a TLS proxy, as you said', network: 'over an encrypted network, as you said' }[m.transport];
      const port = nova.mesh.address().port;
      const pub = new URL(nova.meshInfo.publicUrl);
      if (pub.port === '0') {
        pub.port = String(port);
        nova.meshInfo.publicUrl = config.mesh.publicUrl = pub.origin;
      }
      // The same for this node's own address (M10g), when it is the one it listens on.
      if (nova.meshInfo.address) {
        const own = new URL(nova.meshInfo.address);
        if (own.port === '0') { own.port = String(port); nova.meshInfo.address = config.mesh.address = own.origin; }
      }
      console.log(`Devices pair and connect at ${nova.meshInfo.publicUrl} (listening on ${m.bindHost}:${port}, ${how}).`);
    });
  }
  // On a stop, nothing Nova started lives on after it (a command in a process group of its own).
  const quit = async () => { rmSync(join(config.home, 'nova.pid'), { force: true }); nova.scheduler.stop(); for (const id of nova.runner.active.keys()) nova.runner.stop(id); nova.server.close(); nova.mesh?.close(); await nova.core.stopWork(2000); await nova.core.close(); process.exit(0); };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  // Restarting in place (core resilience/restart.ts), for a restore: stop listening, close the core,
  // and tell the fresh start which ports to take again (the ones it has now, even if it was given 0).
  nova.core.restarter.attach(async () => {
    nova.scheduler.stop();
    for (const id of nova.runner.active.keys()) nova.runner.stop(id);
    // Nothing Nova started may write into the restored home: running tasks stop, and every process
    // it started (in its own process group or not) is ended, within a bound.
    await nova.core.stopWork(5000);
    const closed = (s) => new Promise((r) => { if (!s?.listening) return r(); s.close(() => r()); s.closeAllConnections(); });
    const port = nova.server.address()?.port;
    const meshPort = nova.mesh?.address()?.port;
    await Promise.all([closed(nova.server), closed(nova.mesh)]);
    await nova.core.close();
    const env = {};
    if (port) env.NOVA_PORT = String(port);
    for (const name of ['NOVA_MESH_URL', 'NOVA_MESH_PUBLIC_URL']) {
      if (!meshPort || !process.env[name]) continue;
      const u = new URL(process.env[name]);
      if (u.port === '0') { u.port = String(meshPort); env[name] = u.origin; }
    }
    console.log('Nova is restarting to finish what was staged (a restore or a factory reset).');
    return env;
  });
}
```

### `src/home.js`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `3d977bdd4c7a40700783a5804ff0cf99c8b320ed`, SHA256 `16df6f4b1da151a126acaeb72f8ac569e73fe673714946e44a85222187dbb128`, 135 physical lines (136 under boundary count).

```js
// Nova's home: the standing files, memory, workspace and session logs.
// Seeded from templates/home on first run. Seeding never overwrites a file.
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, resolve, sep } from 'node:path';

// Read into every conversation, in this order.
export const STANDING_FILES = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md'];

export function seedHome(home, templates) {
  const created = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(templates, rel))) {
      const r = join(rel, name);
      const src = join(templates, r);
      const dst = join(home, r);
      if (statSync(src).isDirectory()) { mkdirSync(dst, { recursive: true }); walk(r); }
      else if (!existsSync(dst)) { cpSync(src, dst); created.push(r); }
    }
  };
  mkdirSync(home, { recursive: true });
  walk('.');
  for (const d of ['memory', 'workspace', 'sessions']) mkdirSync(join(home, d), { recursive: true });
  return created;
}

export function readStanding(home) {
  return STANDING_FILES.map((name) => {
    const p = join(home, name);
    return { name, text: existsSync(p) ? readFileSync(p, 'utf8').trim() : '' };
  });
}

// Folders in the home that hold secrets: the vault (and its key file), the mesh's device and
// identity keys, and Era 2's connection secrets. No file tool reads or writes them and no helper
// is handed them; they are also untracked (UNTRACKED) and not journalled (mesh/sync.ts).
// broker/ is the Credential Broker's store (src/broker): ciphertext, its header and, without a
// keychain, its device key. No file tool reads it.
export const SECRET_DIRS = ['vault', 'mesh', 'connectors', 'broker'];
export const inSecretDir = (rel) => SECRET_DIRS.find((d) => rel === d || rel.startsWith(`${d}/`) || rel.startsWith(`${d}\\`)) ?? null;

// Resolve a tool path inside home. "~/x" and "x" both mean home/x.
export function inHome(home, p) {
  const rel = String(p ?? '').replace(/^~\/?/, '');
  const abs = resolve(home, rel);
  const root = resolve(home);
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`${p} is outside Nova's home`);
  return abs;
}

// Git history is the audit trail: the home is a local repository, and every
// finished turn is a commit. Best-effort: Nova works without git installed.
// Memory, skills and connection secrets stay out of it, so forgetting a
// memory or removing a skill leaves no copy behind in old commits.
const git = (home, ...args) => new Promise((ok) => {
  execFile('git', ['-C', home, ...args], { timeout: 15_000 }, (err, stdout) => ok(err ? null : stdout));
});

// The core's database, logs and backups, and extension data, are runtime state, not history.
// mesh/ holds this node's private keys (0600 on disk); git would keep a copy anyone who can read
// the folder could read, for good. vault/ holds connection secrets (encrypted) and, without a
// system keychain, their key: a copy in history would outlive revoking them.
const UNTRACKED = ['MEMORY.md', 'memory/*.md', '!memory/README.md', 'memory/.rendered.json', 'skills/', 'connectors/', 'nova.db*', 'logs/', 'backups/', 'extensions/', 'exports/', 'kept/', 'workers/', 'mesh/', 'vault/', 'broker/', 'nova.pid',
  // Checkpoints hold the identity and the vault key; the home's mark holds the key that seals a
  // factory reset (M7 amendment). A reset's marker and report are this machine's alone too.
  'checkpoints/', '.nova-home', '.nova-home.tmp', 'factory-reset.json*', 'reset-report.json'];

function ignorePrivate(home) {
  const path = join(home, '.gitignore');
  const have = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const missing = UNTRACKED.filter((l) => !have.split('\n').includes(l));
  if (!missing.length) return false;
  const head = have.includes('# Nova:') ? '' : '# Nova: kept out of history, so forgetting and removing are final.\n';
  appendFileSync(path, `${have && !have.endsWith('\n') ? '\n' : ''}${head}${missing.join('\n')}\n`);
  return true;
}

const commit = (home, message) => git(home, '-c', 'user.name=Nova', '-c', 'user.email=nova@localhost', 'commit', '-q', '-m', message);

// Whether any commit (or the reflog) still holds this node's current private key: homes from
// before mesh/ was untracked committed it with everything else. Keys replaced since (README) are
// in the history too, but no longer open anything, so only the current one counts.
export async function keysInHistory(home) {
  if (!existsSync(join(home, '.git'))) return false;
  let key = null;
  try { key = JSON.parse(readFileSync(join(home, 'mesh', 'identity.json'), 'utf8')).ed25519?.private ?? null; } catch { /* no identity yet */ }
  const out = await git(home, 'log', '--all', '--reflog', '-p', '--format=', '--', 'mesh/identity.json');
  if (!out?.trim()) return false;
  // An identity file Nova can't read: be safe and say it was exposed.
  return key ? out.includes(key) : true;
}

export const KEYS_IN_HISTORY = 'This Nova’s private keys (mesh/identity.json) were saved in its home folder’s git history before Nova kept them out of it. Anyone who can read that folder’s .git can read them, so treat them as exposed. New commits leave them out; old ones still have them. Replace the keys: the README’s “If the hub’s keys were exposed” says how, and which devices to add again.';

// `problem`: told, in plain words, when the history already holds this node's keys. It is said
// at every start until the keys are replaced. `resolved`: told when it no longer does, so the
// warning closes by itself once the keys are new.

// Whether a Nova server is running this home right now (its nova.pid names a live process).
export function runningPid(home) {
  let pid = 0;
  try { pid = Number(readFileSync(join(home, 'nova.pid'), 'utf8')); } catch { return null; }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return pid; } catch (e) { return e.code === 'EPERM' ? pid : null; }
}
export async function ensureGit(home, o = {}) {
  const changed = ignorePrivate(home);
  if (existsSync(join(home, '.git'))) {
    // A home from before these were untracked: stop tracking them from here on. mesh/ is checked
    // every time, not only when .gitignore changed, since its keys must never be committed again.
    const meshTracked = !!(await git(home, 'ls-files', '--', 'mesh', 'vault'))?.trim();
    if (changed || meshTracked) {
      await git(home, 'rm', '-r', '-q', '--cached', '--ignore-unmatch', 'MEMORY.md', 'memory', 'skills', 'connectors', 'mesh', 'vault');
      await git(home, 'add', '-A');
      await commit(home, 'Nova: memory, skills, connections and keys kept out of history');
    }
    if (await keysInHistory(home)) o.problem?.(KEYS_IN_HISTORY);
    else o.resolved?.(KEYS_IN_HISTORY);
    return true;
  }
  if ((await git(home, 'init', '-q')) === null) return false;
  await git(home, 'add', '-A');
  await commit(home, 'Nova: home seeded');
  return true;
}

let queue = Promise.resolve();
export function commitHome(home, message) {
  queue = queue.then(async () => {
    if (!existsSync(join(home, '.git'))) return;
    await git(home, 'add', '-A');
    await commit(home, message);
  });
  return queue;
}
```

### `src/core/resilience/entries.ts`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `b159ca98e7a63b64f4a28d610368a303cc59d8f3`, SHA256 `d2b4ea0503e3684ed6e2fa77a40464bea3f5c3bf3c00fc56d9acc111d64db796`, 62 physical lines (63 under boundary count).

```ts
// Nova's own entries at the top of its home, by name (M7 amendment). Checkpoints copy only these,
// a restore swaps only these, and a factory reset wipes only these: anything else in the folder
// isn't Nova's (the owner's preview home holds a script of their own) and is never copied, moved,
// undone or deleted.
//
// Derived from the code, every place that writes under the home (2026-10-30), not from memory:
//  - nova.db (+ -wal, -shm, -journal)        core/index.ts, db.ts (SQLite's own side files)
//  - AGENTS.md SOUL.md IDENTITY.md USER.md    home.js seedHome (templates/home), changes/sandbox.ts
//  - MEMORY.md, memory/                       memory.js (Era 2's render, day notes, .rendered.json)
//  - sessions/                                sessions.js
//  - schedules/                               schedules.js (runs.jsonl)
//  - skills/                                  skills.js
//  - permissions.md                           permissions.js, server.js
//  - connectors/                              connectors/gmail.js (Era 2's connection files)
//  - workspace/                               core/index.ts, tools.js, providers/taskspace.ts
//  - extensions/                              extensions.ts, changes/pipeline.ts
//  - changes/                                 changes/pipeline.ts (released changes)
//  - vault/                                   vault.ts
//  - broker/                                  src/broker (the Credential Broker's store)
//  - mesh/                                    mesh/identity.ts, mesh/replica.ts (role.json), mesh/promote.ts
//  - logs/                                    core/index.ts (log.ts)
//  - workers/                                 core/index.ts, browser/evidence.ts, providers/registry.ts, changes/*
//  - kept/                                    extensions.ts, resilience/backup.ts (owed forgets)
//  - exports/                                 extensions.ts, memory.ts
//  - backups/                                 core/index.ts (pre-upgrade copies)
//  - checkpoints/                             resilience/checkpoints.ts
//  - nova.pid                                 server.js, home.js
//  - .git, .gitignore                         home.js (the home's history)
//  - factory-reset.json, reset-report.json    resilience/reset.ts (a reset staged, and its result)
// Capture's fetched originals live in capture/raw (M10h): they are Nova's own recovery/reset data.
// The standby's sync writes
// only paths the hub journalled, and its temporary files (<name>.nova-sync-<pid>.tmp) are Nova's
// when <name> is.
import { readdirSync } from 'node:fs';

export const NOVA_ENTRIES: readonly string[] = [
  'nova.db', 'nova.db-wal', 'nova.db-shm', 'nova.db-journal',
  'AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md',
  'MEMORY.md', 'memory', 'sessions', 'schedules', 'skills', 'permissions.md', 'connectors',
  'workspace', 'extensions', 'changes', 'vault', 'broker', 'mesh', 'capture',
  'logs', 'workers', 'kept', 'exports', 'backups', 'checkpoints', 'nova.pid',
  '.git', '.gitignore',
  'factory-reset.json', 'reset-report.json',
];

const OWN = new Set(NOVA_ENTRIES);
const SYNC_TMP = /^(.+)\.nova-sync-\d+\.tmp$/;

// Whether a top-level name in a home is one of Nova's own.
export function isNovaEntry(name: string): boolean {
  if (OWN.has(name)) return true;
  const m = SYNC_TMP.exec(name);
  return !!m && OWN.has(m[1]!);
}

// The top-level entries of a home that aren't Nova's, sorted: left exactly as they are.
// Nova's mark on its home (home-mark.ts) is neither: it stays, and is never copied or swapped.
export function foreignEntries(home: string): string[] {
  let names: string[] = [];
  try { names = readdirSync(home); } catch { return []; }
  return names.filter((n) => !isNovaEntry(n) && n !== '.nova-home' && n !== '.nova-home.tmp').sort();
}
```

### `src/core/resilience/checkpoints.ts`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `bf32052a0bb5b959b9d85267d5a053791efb4c05`, SHA256 `0eab89dece4bd2839c2090af9db98fe586cb84c6afb032bf5f24b79736151b0e`, 1044 physical lines (1045 under boundary count).

```ts
// Checkpoints (M7 amendment §1): restore points of the whole data home, kept on this machine. A
// checkpoint is a consistent snapshot of the database (VACUUM INTO) and a copy of every file in the
// home, the vault's key file and this node's identity included, with a sealed manifest in the
// nightly backups' format (backup.ts). It never leaves the machine, which is why it may hold what a
// backup may not; nightly backups and the standby's journal leave `checkpoints/` out.
//
// Where: <home>/checkpoints/<seq>-<slug>/ (folders 0700, files 0600), with nova.db, files/<rel> and
// manifest.json, exactly a backup's layout, so the same cleaning (cleanBackup) applies to both.
// The seal's key is <home>/checkpoints/.seal (0600): not in the vault, so a stopped home (the
// supervisor, before a release switch) can be checkpointed, and a restore can't lose it.
//
// Retention: the newest KEEP_AUTO automatic checkpoints, by sequence number and never by date; a
// named one stays until the person deletes it, and is never deleted to make room. A new checkpoint
// is complete (renamed into place) before any old one is pruned. A disk too full to take one
// refuses in plain words, and an automatic one that was needed stops what needed it.
//
// Forgetting holds here too: Backups.also cleans every checkpoint (and a restore that is staged);
// one that can't be cleaned is destroyed and reported.
//
// Restoring (tier 3, the hub's own screen) is staged, then applied when Nova next starts, before
// the database opens, by swapping folders (finishStaged): see `stageRestore` and `finishStaged`.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Db } from '../db.ts';
import { cleanDbFile } from '../backups.ts';
import { CoreError } from '../errors.ts';
import type { Log } from '../log.ts';
import type { Ledger, LanedWorker, Task } from '../ledger.ts';
import type { Verifier } from '../verify.ts';
import { Vault } from '../vault.ts';
import type { Route, Who } from '../api.ts';
import { ENVELOPE_VERSION, type Brief, type Report } from '../envelope.ts';
import { cleanBackup, sha256File, writeManifest, type ManifestFile } from './backup.ts';
import { safeRel } from './archive.ts';
import { carryOver, droppedDevices } from './restore.ts';
import { isNovaEntry } from './entries.ts';
import type { Restarter } from './restart.ts';
import { RESET_MARKER, finishReset, type FinishOptions as ResetFinishOptions } from './reset.ts';

export const CHECKPOINTS_DIR = 'checkpoints';
export const KEEP_AUTO = 10;
export const NAME_MAX = 80;
// Named checkpoints are kept until deleted, so their number is capped: no device can fill the disk.
export const NAMED_MAX = 20;
export const RETENTION = `Nova keeps the newest ${KEEP_AUTO} automatic checkpoints, counted in the order they were taken, never by date, and every checkpoint you name until you delete it. A new checkpoint is complete before an old one is removed, and a named one is never removed to make room.`;

export type CheckpointKind = 'auto' | 'named';

export interface CheckpointManifest {
  v: 1;
  id: string;
  seq: number;
  name: string | null;
  kind: CheckpointKind;
  reason: string | null;
  at: string;
  nova_version: string;
  schema_version: number;
  migrations: { version: number; name: string; checksum: string }[];
  db: ManifestFile;
  files: ManifestFile[];
  total_bytes: number;
  excluded: string[];
  cleaned: { at: string; table: string; rows: number }[];
  seal?: string;
}

export interface CheckpointView {
  id: string; seq: number; name: string | null; kind: CheckpointKind; reason: string | null; label: string;
  at: string; nova_version: string; schema_version: number; bytes: number; size: string; files: number;
}

export type CheckpointFailure = 'disk-full' | 'failed';
export class CheckpointError extends CoreError {
  readonly kind: CheckpointFailure;
  constructor(kind: CheckpointFailure, message: string) {
    super('conflict', message);
    this.kind = kind;
  }
}

// Top-level names in the home that are never in a checkpoint, and why (shown in every manifest).
const SKIP_TOP: Record<string, string> = {
  checkpoints: 'checkpoints are never inside each other',
  broker: 'the Credential Broker keeps its own store; a restore never brings back a deleted credential',
  backups: 'the pre-upgrade copies are kept separately',
  exports: 'exports are copies made on request',
  logs: 'Nova’s logs are for diagnosing this machine',
  kept: 'Nova’s own scratch',
  workers: 'workers’ scratch folders',
  'nova.pid': 'which process runs this home',
  '.git': 'the home’s git history stays as it is',
  'factory-reset.json': 'a factory reset in progress acts on this home only',
  'reset-report.json': 'what the last factory reset did stays as it is',
};
const DB_FILE = /^nova\.db/;
const TEMP = /\.(tmp|partial)$|\.nova-sync-\d+\.tmp$/;
const DIR = /^(\d{6,})-[a-z0-9-]{1,48}$/;
export const EXCLUDED = ['nova.db: copied as a consistent snapshot instead', ...Object.entries(SKIP_TOP).map(([p, why]) => `${p}: ${why}`), 'anything that isn’t Nova’s own (entries.ts): left as it is'];

const root = (home: string) => join(home, CHECKPOINTS_DIR);

// The home's files a checkpoint carries: Nova's own entries (entries.ts) but the names above, the
// database (snapshot) and temporary files. Files Nova didn't make are never in one. Links and
// sockets are never followed.
export function checkpointFiles(home: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    let entries;
    try { entries = readdirSync(join(home, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && (!isNovaEntry(e.name) || SKIP_TOP[e.name] || DB_FILE.test(e.name))) continue;
      if (TEMP.test(e.name)) continue;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk('');
  return out;
}

// "4.2 MB", in the units a person reads.
export function humanSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const isFull = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOSPC' || /disk is full|SQLITE_FULL|ENOSPC/i.test((e as Error)?.message ?? '');

// The seal's key: made once, the person's alone, outside every checkpoint and every backup.
function sealKey(home: string, create: boolean): Buffer | null {
  const file = join(root(home), '.seal');
  try { return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex'); } catch { /* none yet */ }
  if (!create) return null;
  ensureRoot(home);
  try {
    const fd = openSync(file, 'wx', 0o600);
    try { writeFileSync(fd, randomBytes(32).toString('hex')); } finally { closeSync(fd); }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
}

function ensureRoot(home: string): string {
  const r = root(home);
  mkdirSync(r, { recursive: true, mode: 0o700 });
  chmodSync(r, 0o700);
  return r;
}

const slugOf = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'checkpoint';

export function cleanCheckpointName(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim() : '';
  if (!s) throw new CoreError('validation', 'A checkpoint you take yourself needs a name, so you can tell it apart later.');
  if (s.length > NAME_MAX) throw new CoreError('validation', `A checkpoint’s name can be up to ${NAME_MAX} characters.`);
  return s;
}

export interface TakeOptions {
  home: string;
  kind: CheckpointKind;
  name?: string | null;
  // Why Nova took it ("Before shipping …"), for an automatic one.
  reason?: string | null;
  version: string;
  // The open database (a running Nova); without it, the home's database file is opened (a stopped
  // home: the supervisor, before a release switch).
  db?: Db | null;
  now?: () => Date;
  // Free bytes where checkpoints go (tests); statfs otherwise.
  free?: (dir: string) => number | null;
}

// Takes one checkpoint now, then prunes automatic ones past KEEP_AUTO. Throws a CheckpointError
// when it can't; nothing half-made stays, and the old ones are untouched then.
export function takeCheckpoint(o: TakeOptions): CheckpointManifest {
  const now = o.now ?? (() => new Date());
  const name = o.kind === 'named' ? cleanCheckpointName(o.name) : null;
  const reason = o.kind === 'auto' ? String(o.reason ?? 'Taken by Nova') : (o.reason ?? null);
  const dbPath = join(o.home, 'nova.db');
  if (!o.db && !existsSync(dbPath)) throw new CheckpointError('failed', `${o.home} has no database to checkpoint.`);
  const r = ensureRoot(o.home);
  dropPartials(o.home);
  if (o.kind === 'named' && scanCheckpoints(o.home).found.filter((f) => f.manifest.kind === 'named').length >= NAMED_MAX) {
    throw new CheckpointError('failed', `You have ${NAMED_MAX} named checkpoints. Delete one to take another.`);
  }
  const key = sealKey(o.home, true)!;
  const files = checkpointFiles(o.home);

  // Room first: about the database and every file, with a margin. Refused in plain words.
  let need = 0;
  for (const s of ['', '-wal']) { try { need += statSync(dbPath + s).size; } catch { /* none */ } }
  for (const rel of files) { try { need += statSync(join(o.home, rel)).size; } catch { /* gone */ } }
  need = Math.ceil(need * 1.1) + 1_000_000;
  let free: number | null = null;
  try { free = o.free ? o.free(r) : (() => { const s = statfsSync(r); return Number(s.bavail) * Number(s.bsize); })(); } catch { free = null; }
  if (free !== null && free < need) {
    throw new CheckpointError('disk-full', `There isn’t enough free space on this disk for a checkpoint: it needs about ${humanSize(need)} and ${humanSize(free)} is free. Nova took none. Free some space, then try again.`);
  }

  const seq = nextSeq(r);
  const id = `${String(seq).padStart(6, '0')}-${slugOf(name ?? reason ?? 'checkpoint')}`;
  const partial = join(r, `.partial-${id}`);
  const at = now().toISOString();
  let manifest: CheckpointManifest;
  try {
    mkdirSync(join(partial, 'files'), { recursive: true, mode: 0o700 });
    chmodSync(partial, 0o700);
    chmodSync(join(partial, 'files'), 0o700);
    const snap = join(partial, 'nova.db');
    const vacuum = `VACUUM INTO '${snap.replaceAll("'", "''")}'`;
    if (o.db) o.db.raw.exec(vacuum);
    else {
      const d = new DatabaseSync(dbPath);
      try { d.exec('PRAGMA busy_timeout = 5000'); d.exec(vacuum); } finally { d.close(); }
    }
    chmodSync(snap, 0o600);
    const list: ManifestFile[] = [];
    for (const rel of files) {
      const dst = join(partial, 'files', rel);
      mkdirDeep(join(partial, 'files'), rel);
      try {
        copyFileSync(join(o.home, rel), dst, constants.COPYFILE_FICLONE);
        chmodSync(dst, 0o600);
      } catch (e) {
        // A file that went away while copying is simply not in it; anything else stops it.
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw e;
      }
      list.push({ path: rel, sha256: sha256File(dst), bytes: statSync(dst).size });
    }
    const snapDb = new DatabaseSync(snap, { readOnly: true });
    let migrations: CheckpointManifest['migrations'] = [];
    try {
      if (snapDb.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`).get()) {
        migrations = snapDb.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as unknown as CheckpointManifest['migrations'];
      }
    } finally {
      snapDb.close();
    }
    const dbFile = { path: 'nova.db', sha256: sha256File(snap), bytes: statSync(snap).size };
    manifest = {
      v: 1, id, seq, name, kind: o.kind, reason, at, nova_version: o.version,
      schema_version: migrations.at(-1)?.version ?? 0, migrations, db: dbFile, files: list,
      total_bytes: dbFile.bytes + list.reduce((n, f) => n + f.bytes, 0), excluded: EXCLUDED, cleaned: [],
    };
    writeManifest(partial, manifest as never, key);
    renameSync(partial, join(r, id));
  } catch (e) {
    rmSync(partial, { recursive: true, force: true });
    if (isFull(e)) throw new CheckpointError('disk-full', `The disk filled up while Nova took a checkpoint, so it stopped and kept none. Your earlier checkpoints are untouched. Free some space, then try again.`);
    throw new CheckpointError('failed', `Nova couldn’t take a checkpoint: ${(e as Error).message}. Your earlier checkpoints are untouched.`);
  }
  // Only now, with the new one complete: the oldest automatic ones past the limit go.
  pruneCheckpoints(o.home);
  return manifest;
}

// What a checkpoint stopped part-way left behind: never used, and never kept holding data. Removed
// at every start, before every checkpoint and before every forget.
export function dropPartials(home: string): string[] {
  const out: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(root(home)); } catch { return out; }
  for (const e of names) if (e.startsWith('.partial-')) { rmSync(join(root(home), e), { recursive: true, force: true }); out.push(e); }
  return out;
}

function mkdirDeep(base: string, rel: string): void {
  const parts = rel.split('/').slice(0, -1);
  let at = base;
  for (const p of parts) {
    at = join(at, p);
    if (!existsSync(at)) mkdirSync(at, { mode: 0o700 });
  }
}

function nextSeq(r: string): number {
  let max = 0;
  for (const e of readdirSync(r)) { const m = /^(?:\.partial-)?(\d{6,})-/.exec(e); if (m) max = Math.max(max, Number(m[1])); }
  // The highest number ever used, so a deleted newest one's number isn't given out again.
  try { max = Math.max(max, Number(readFileSync(join(r, '.seq'), 'utf8')) || 0); } catch { /* none yet */ }
  writeFileSync(join(r, '.seq'), String(max + 1), { mode: 0o600 });
  return max + 1;
}

interface Found { path: string; manifest: CheckpointManifest }

// Nova's own checkpoints (sealed, named as their manifest says), newest first by sequence, and
// anything else in the folder named like one (strays: never restored, never pruned).
export function scanCheckpoints(home: string): { found: Found[]; strays: string[] } {
  const r = root(home);
  const found: Found[] = [];
  const strays: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(r); } catch { return { found, strays }; }
  const key = sealKey(home, false);
  for (const e of names) {
    const m = DIR.exec(e);
    if (!m) continue;
    const path = join(r, e);
    let manifest: CheckpointManifest | null = null;
    try { manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) as CheckpointManifest; } catch { /* below */ }
    if (manifest && key && manifest.id === e && manifest.seq === Number(m[1]) && sealedBy(manifest, key)) found.push({ path, manifest });
    else strays.push(path);
  }
  return { found: found.sort((a, b) => b.manifest.seq - a.manifest.seq), strays };
}

function sealedBy(m: CheckpointManifest, key: Buffer): boolean {
  const { seal, ...rest } = m;
  if (typeof seal !== 'string' || !/^[0-9a-f]{64}$/.test(seal)) return false;
  // The same seal as a nightly backup's manifest (backup.ts writeManifest).
  const want = createHmac('sha256', key).update(JSON.stringify(rest)).digest();
  return timingSafeEqual(want, Buffer.from(seal, 'hex'));
}

export function viewOf(m: CheckpointManifest): CheckpointView {
  return {
    id: m.id, seq: m.seq, name: m.name, kind: m.kind, reason: m.reason, label: m.name ?? m.reason ?? 'Checkpoint',
    at: m.at, nova_version: m.nova_version, schema_version: m.schema_version, bytes: m.total_bytes, size: humanSize(m.total_bytes), files: m.files.length,
  };
}

export function listCheckpoints(home: string): CheckpointView[] {
  return scanCheckpoints(home).found.map((f) => viewOf(f.manifest));
}

// Automatic checkpoints past the newest KEEP_AUTO, by sequence number. Named ones and strays stay.
export function pruneCheckpoints(home: string): string[] {
  const autos = scanCheckpoints(home).found.filter((f) => f.manifest.kind === 'auto');
  const removed: string[] = [];
  for (const f of autos.slice(KEEP_AUTO)) { rmSync(f.path, { recursive: true, force: true }); removed.push(f.manifest.id); }
  return removed;
}

export function findCheckpoint(home: string, id: string): Found {
  const f = scanCheckpoints(home).found.find((x) => x.manifest.id === id);
  if (!f) throw new CoreError('not_found', 'There is no such checkpoint.');
  return f;
}

// Every hash in the manifest, read back from disk: the database and each file. Throws, naming the
// first that differs, when the checkpoint isn't exactly what was taken (or cleaned since).
export function verifyCheckpoint(f: Found): { db: string; files: number; bytes: number } {
  const m = f.manifest;
  const db = join(f.path, 'nova.db');
  if (!existsSync(db) || sha256File(db) !== m.db.sha256) throw new CoreError('conflict', `The checkpoint “${viewOf(m).label}” is damaged: its database isn’t what was taken. Nova won’t restore it.`);
  for (const file of m.files) {
    const p = join(f.path, 'files', safeRel(file.path));
    if (!existsSync(p) || !lstatSync(p).isFile() || sha256File(p) !== file.sha256) throw new CoreError('conflict', `The checkpoint “${viewOf(m).label}” is damaged: ${file.path} isn’t what was taken. Nova won’t restore it.`);
  }
  return { db: m.db.sha256, files: m.files.length, bytes: m.total_bytes };
}

// A forget, carried into every checkpoint (and a restore that is staged). One that can't be
// cleaned is destroyed; `destroyed` names it so the caller reports it.
export function forgetInCheckpoints(home: string, table: string, ids: string[], words: string[], at: Date): { cleaned: string[]; destroyed: string[] } {
  const cleaned: string[] = [];
  const destroyed: string[] = [];
  // A half-taken checkpoint holds a whole copy of the database and no manifest to clean by: it goes.
  dropPartials(home);
  if (!ids.length) return { cleaned, destroyed };
  const key = sealKey(home, false);
  const { found, strays } = scanCheckpoints(home);
  for (const f of found) {
    try {
      cleanBackup(f.path, table, ids, words, at, key!);
      cleaned.push(f.path);
    } catch {
      rmSync(f.path, { recursive: true, force: true });
      destroyed.push(f.path);
    }
  }
  // A stray can't be told from a checkpoint someone changed: it holds whatever it holds, so it goes.
  for (const s of strays) {
    try { cleanDbFile(join(s, 'nova.db'), table, ids, words); } catch { rmSync(s, { recursive: true, force: true }); destroyed.push(s); }
  }
  const staged = join(root(home), RESTORE_DIR, 'new');
  if (existsSync(staged)) {
    try {
      cleanDbFile(join(staged, 'nova.db'), table, ids, words);
      cleanTextTree(staged, words);
      cleaned.push(staged);
    } catch {
      // A staged restore that can't be cleaned doesn't happen: Nova starts on the home as it is.
      rmSync(join(root(home), RESTORE_DIR), { recursive: true, force: true });
      destroyed.push(staged);
    }
  }
  return { cleaned, destroyed };
}

// Lines carrying the words go from every text file under `dir` (a staged restore's files).
function cleanTextTree(dir: string, words: string[]): void {
  const ws = words.map((w) => w.trim()).filter((w) => w.length >= 3);
  if (!ws.length) return;
  for (const rel of checkpointFiles(dir)) {
    const p = join(dir, rel);
    const raw = readFileSync(p);
    if (!ws.some((w) => raw.includes(Buffer.from(w)))) continue;
    if (raw.includes(0)) throw new Error(`${rel} holds forgotten words and isn’t text.`);
    let text = raw.toString('utf8').split('\n').filter((line) => !ws.some((w) => line.includes(w))).join('\n');
    for (const w of ws) text = text.split(w).join('');
    writeFileSync(p, text);
  }
}

export function deleteCheckpoint(home: string, id: string): CheckpointView {
  const f = findCheckpoint(home, id);
  if (f.manifest.kind !== 'named') throw new CoreError('conflict', `Nova manages its automatic checkpoints itself (the newest ${KEEP_AUTO} are kept). You can delete the ones you named.`);
  rmSync(f.path, { recursive: true, force: true });
  return viewOf(f.manifest);
}

// ---- restoring ------------------------------------------------------------------------------------

// The staged restore: <home>/checkpoints/.restore/{marker.json, new/, old/}. `new` is the home as
// it will be, laid out like the home itself: the checkpoint at staging, with what is carried over
// from now written in at the next start, just before the swap (so nothing done after staging is
// lost).
export const RESTORE_DIR = '.restore';
const MARKER = 'marker.json';
const DROPPED = /^\.restore-dropped-/;
// What a restore never swaps: they stay as they are now (the checkpoints themselves among them).
const STAYS = new Set(Object.keys(SKIP_TOP));

export interface StagedFile { path: string; sha256: string }

// staged: the copy is complete, as listed in `files`. carried: what is kept from now is in it, as
// listed in `ready`. swapping: entries are moving (`had`: Nova's entries the home had then).
// swapped: done, only the record and the leftovers remain.
export interface RestoreMarker {
  v: 1;
  id: string;
  state: 'staged' | 'carried' | 'swapping' | 'swapped';
  at: string;
  checkpoint: { id: string; label: string; at: string; kind: CheckpointKind };
  verified: { db: string; files: number; bytes: number; seal: string };
  before: string | null;
  files: StagedFile[];
  carried?: Carried;
  ready?: StagedFile[];
  had?: string[];
  // The top-level names the restored home has: the swap's plan.
  names: string[];
  // An emergency promotion (M10g, mesh/handover.ts): what is staged is a backup, not a checkpoint,
  // and this node becomes the hub with it, keeping its own keys.
  cold?: ColdStage;
}

// What an emergency promotion stages with the backup: this node's id (it becomes the hub), the epoch
// it takes at least (max + 1 of every epoch it knew at staging), and the backup.
export interface ColdStage { node: string; floor: number; promotion: string; backup: { id: string; seq: number; at: string; path: string }; by: string }

export interface Carried {
  revoked: { id: string; name: string }[];
  dropped: { id: string; name: string; kind: string }[];
  epoch: { now: number; checkpoint: number; restored: number };
  standby_resync: boolean;
  problems: { carried: number; resolved: number };
  forgotten: { memories: number; capture: number };
  sessions_ended: number;
  backup_records: number;
  identity: string;
  vault: string;
}

// Something staged waits for the next start: a restore, or a factory reset (resilience/reset.ts).
export function stagedPending(home: string): boolean {
  return existsSync(join(root(home), RESTORE_DIR, MARKER)) || existsSync(join(home, RESET_MARKER));
}

export function readMarker(home: string): RestoreMarker | null {
  try { return JSON.parse(readFileSync(join(root(home), RESTORE_DIR, MARKER), 'utf8')) as RestoreMarker; } catch { return null; }
}

function writeMarker(home: string, m: RestoreMarker): void {
  const file = join(root(home), RESTORE_DIR, MARKER);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(m, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

// Every file under `dir` (a staged home), with its hash.
function listing(dir: string, top?: string): StagedFile[] {
  const out: StagedFile[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out.push({ path: r, sha256: sha256File(join(dir, r)) });
    }
  };
  if (top === undefined) walk('');
  else if (existsSync(join(dir, top))) {
    if (lstatSync(join(dir, top)).isDirectory()) walk(top);
    else out.push({ path: top, sha256: sha256File(join(dir, top)) });
  }
  return out;
}

const same = (a: StagedFile[], b: StagedFile[]) => a.length === b.length && a.every((f, i) => f.path === b[i]!.path && f.sha256 === b[i]!.sha256);
const under = (files: StagedFile[], top: string) => files.filter((f) => f.path === top || f.path.startsWith(`${top}/`)).sort((a, b) => a.path.localeCompare(b.path));

// The staged copy of the home (the checkpoint as it was taken). Refuses, in plain words, when the
// disk hasn't room for it; nothing is left behind then.
export function stageCopy(home: string, f: Found, o: { free?: (dir: string) => number | null } = {}): string {
  const r = ensureRoot(home);
  dropStaged(home);
  const need = Math.ceil(f.manifest.total_bytes * 1.1) + 1_000_000;
  let free: number | null = null;
  try { free = o.free ? o.free(r) : (() => { const s = statfsSync(r); return Number(s.bavail) * Number(s.bsize); })(); } catch { free = null; }
  if (free !== null && free < need) throw new CheckpointError('disk-full', `there isn’t enough free space on this disk to stage it: it needs about ${humanSize(need)} and ${humanSize(free)} is free. Free some space, then try again.`);
  const out = join(r, RESTORE_DIR, 'new');
  try {
    mkdirSync(out, { recursive: true, mode: 0o700 });
    for (const file of f.manifest.files) {
      const rel = safeRel(file.path);
      // A checkpoint from before entries.ts may hold files that aren't Nova's: those are never put back.
      if (!isNovaEntry(rel.split('/')[0]!)) continue;
      mkdirDeep(out, rel);
      copyFileSync(join(f.path, 'files', rel), join(out, rel), constants.COPYFILE_FICLONE);
    }
    copyFileSync(join(f.path, 'nova.db'), join(out, 'nova.db'));
  } catch (e) {
    dropStaged(home);
    if (isFull(e)) throw new CheckpointError('disk-full', 'the disk filled up while Nova staged it. Free some space, then try again.');
    throw e;
  }
  return out;
}

// Seals the staging with the list of what was staged, by hash: from here the restore happens at the
// next start, and only exactly as staged.
export function writeStaged(home: string, m: Omit<RestoreMarker, 'v' | 'state' | 'names' | 'files'>): RestoreMarker {
  const out = join(root(home), RESTORE_DIR, 'new');
  const marker: RestoreMarker = { v: 1, state: 'staged', names: readdirSync(out).filter(isNovaEntry).sort(), files: listing(out), ...m };
  writeMarker(home, marker);
  return marker;
}

// Drops a staging: the whole folder is renamed away first (one atomic step, so its marker can never
// be found with only part of what it staged), then deleted.
export function dropStaged(home: string): void {
  const dir = join(root(home), RESTORE_DIR);
  if (existsSync(dir)) {
    const gone = join(root(home), `.restore-dropped-${process.pid}-${randomBytes(4).toString('hex')}`);
    renameSync(dir, gone);
    rmSync(gone, { recursive: true, force: true });
  }
  try { for (const e of readdirSync(root(home))) if (DROPPED.test(e)) rmSync(join(root(home), e), { recursive: true, force: true }); } catch { /* no checkpoints folder */ }
}

export interface FinishOptions {
  // The vault of a home, opened the way this Nova opens its own (createCore passes its options).
  vaultAt?: (home: string) => Vault;
  now?: () => Date;
  // Tests: a crash at a step of the swap, or a full disk after it ('swapped', 'record').
  interrupt?: (step: number, what: 'aside' | 'in' | 'swapped' | 'record') => void;
  // A staged factory reset (reset.ts): how to reach the vault's key, and test hooks.
  reset?: ResetFinishOptions;
}

// Applies a staged restore at start, before the database opens, and only exactly as staged:
//  1. staged: every staged file is there with its hash, or the staging is dropped and Nova starts
//     as it was. Then what is kept from now (restore.ts) is read from the outgoing home and written
//     into the staged one, so nothing done after staging is lost.
//  2. carried → swapping: each of Nova's top-level entries moves aside into .restore/old and the
//     staged one moves in, by rename (one disk, so each move is whole). Files that aren't Nova's
//     are never moved. Every step can be done again: a start after a crash part-way picks up
//     where it stopped. Before any move, each entry still to come is checked again by hash; one
//     that doesn't add up puts back what moved and drops the staging: Nova never runs a mix.
//  3. swapped: the record (checkpoints/restores/<id>.json, the ledger task's evidence), then the
//     leftovers. A full disk here is reported, never a reason not to start.
// A staged factory reset goes first and wins: it erases Nova's own entries, a staged restore (under
// checkpoints/) with them. It throws when it can't finish, so a half-reset Nova never runs.
// Returns what was applied (or null) and any problem to tell the person.
export function finishStaged(home: string, o: FinishOptions = {}): { restored: RestoreMarker | null; problems: string[] } {
  const problems: string[] = [];
  if (finishReset(home, { ...o.reset, problem: (p) => problems.push(p) })) return { restored: null, problems };
  const m = readMarker(home);
  if (!m) {
    // A staging that never got its marker (stopped while copying, or while being dropped): nothing
    // was promised.
    try { dropStaged(home); } catch { /* nothing there */ }
    return { restored: null, problems };
  }
  const dir = join(root(home), RESTORE_DIR);
  const neu = join(dir, 'new');
  const old = join(dir, 'old');
  const label = m.checkpoint?.label ?? 'a checkpoint';
  const refuse = (why: string) => {
    dropStaged(home);
    return { restored: null, problems: [...problems, `Nova didn’t restore “${label}”: ${why} Nova started as it was; nothing of yours changed.`] };
  };
  let step = 0;
  const tick = (what: 'aside' | 'in') => { step++; o.interrupt?.(step, what); };

  if (m.state === 'staged') {
    if (!Array.isArray(m.files) || !same(listing(neu), m.files)) return refuse('what it had staged was incomplete or had changed since.');
    try {
      m.carried = carryNow(home, neu, o, m.cold?.node ?? null);
      if (m.cold) applyCold(home, neu, m.cold, m.carried, o);
      m.ready = listing(neu);
      m.names = readdirSync(neu).filter(isNovaEntry).sort();
      m.state = 'carried';
      writeMarker(home, m);
    } catch (e) {
      return refuse(isFull(e) ? 'the disk is full.' : `it couldn’t keep what has to stay from now (${(e as Error).message}).`);
    }
  }
  if (m.state === 'carried') {
    if (!m.ready || !same(listing(neu), m.ready)) return refuse('what it had staged was incomplete or had changed since.');
    m.had = readdirSync(home).filter((n) => isNovaEntry(n) && !STAYS.has(n)).sort();
    m.state = 'swapping';
    try { writeMarker(home, m); } catch (e) { return refuse(isFull(e) ? 'the disk is full.' : (e as Error).message); }
  }
  if (m.state === 'swapping') {
    const ready = m.ready ?? [];
    const had = new Set(m.had ?? []);
    // Every entry is whole: still staged with every hash, or moved in with what it replaced kept.
    const whole = m.names.every((n) => {
      if (existsSync(join(neu, n))) return same(listing(neu, n), under(ready, n));
      return existsSync(join(home, n)) && (!had.has(n) || existsSync(join(old, n)));
    });
    if (!whole) {
      putBack(home, m, neu, old);
      return refuse('what it had staged was incomplete or had changed since.');
    }
    mkdirSync(old, { recursive: true, mode: 0o700 });
    const incoming = new Set(m.names);
    // What of Nova's isn't in the restored home goes aside first (the database's WAL and SHM among
    // them). What isn't Nova's is never moved.
    for (const n of readdirSync(home).sort((a, b) => (/^nova\.db-/.test(b) ? 1 : 0) - (/^nova\.db-/.test(a) ? 1 : 0))) {
      if (!isNovaEntry(n) || STAYS.has(n) || incoming.has(n)) continue;
      if (existsSync(join(old, n))) rmSync(join(old, n), { recursive: true, force: true });
      renameSync(join(home, n), join(old, n));
      tick('aside');
    }
    for (const n of m.names) {
      if (!existsSync(join(neu, n))) continue; // moved in already
      if (existsSync(join(home, n))) {
        rmSync(join(old, n), { recursive: true, force: true });
        renameSync(join(home, n), join(old, n));
        tick('aside');
      }
      renameSync(join(neu, n), join(home, n));
      tick('in');
    }
    m.state = 'swapped';
    try { o.interrupt?.(++step, 'swapped'); writeMarker(home, m); } catch (e) { problems.push(full(e, 'its progress')); }
  }
  // The record, then the leftovers: the home as it was is in the "before" checkpoint already.
  try {
    o.interrupt?.(++step, 'record');
    const records = join(root(home), 'restores');
    mkdirSync(records, { recursive: true, mode: 0o700 });
    writeFileSync(join(records, `${m.id}.json`), `${JSON.stringify({ ...m, finished_at: (o.now?.() ?? new Date()).toISOString() }, null, 2)}\n`, { mode: 0o600 });
  } catch (e) {
    problems.push(full(e, 'its record, so the restore has no ledger task'));
  }
  try { dropStaged(home); } catch (e) { problems.push(full(e, 'away what it no longer needs')); }
  return { restored: m, problems };
}

const full = (e: unknown, what: string) => (isFull(e)
  ? `Nova restored a checkpoint, but the disk is full, so it couldn’t write ${what}. Free some space.`
  : `Nova restored a checkpoint, but couldn’t write ${what}: ${(e as Error).message}`);

// Mid-swap, something doesn't add up: everything moved goes back as it was, then the caller drops
// the staging. If even that can't be done, Nova refuses to start rather than run a mix.
function putBack(home: string, m: RestoreMarker, neu: string, old: string): void {
  for (const n of m.names) {
    if (existsSync(join(neu, n))) continue;
    if (existsSync(join(home, n))) rmSync(join(home, n), { recursive: true, force: true });
  }
  if (!existsSync(old)) return;
  for (const n of readdirSync(old)) {
    if (existsSync(join(home, n))) throw new Error(`Nova can’t put ${n} back as it was after a restore that didn’t add up. Its home is in ${join(root(home), RESTORE_DIR)}; ask for help before starting Nova again.`);
    renameSync(join(old, n), join(home, n));
  }
}

// What is kept from now, read from the outgoing home just before the swap.
function carryNow(home: string, staged: string, o: FinishOptions, node: string | null = null): Carried {
  const vaultAt = o.vaultAt ?? ((h: string) => new Vault({ home: h }));
  const dbFile = join(home, 'nova.db');
  if (!existsSync(dbFile)) throw new Error('the home has no database to keep things from');
  const live = new Db(dbFile);
  try {
    // An emergency promotion: this node becomes the hub, so its own record is the one kept from now.
    let hubId = node ?? live.get<{ hub_id: string | null }>('SELECT hub_id FROM mesh_state WHERE id = 1')?.hub_id ?? null;
    if (!hubId) { try { hubId = (JSON.parse(readFileSync(join(home, 'mesh', 'identity.json'), 'utf8')) as { id: string }).id; } catch { hubId = ''; } }
    return carryOver({ home, staged, live, hubId, now: o.now?.() ?? new Date(), vault: vaultAt(home), vaultAt });
  } finally {
    live.close();
  }
}

// An emergency promotion's part of the swap (M10g), after what every restore keeps from now: this
// node is the hub, at the higher of the epoch the restore set and the floor staged with it; the old
// hub and any standby of then are spokes (the old hub steps down when it comes back: fencing); the
// backup's sessions end (devices sign in again with their own keys, nothing is paired again). The
// backup's vault can't open (its key was never in a backup, Decision 5): it is set aside, and a new
// one holds only Nova's own keys, when this node's vault has them.
function applyCold(home: string, staged: string, c: ColdStage, carried: Carried, o: FinishOptions): void {
  const d = new DatabaseSync(join(staged, 'nova.db'));
  const at = (o.now?.() ?? new Date()).toISOString();
  let epoch = 0;
  try {
    d.exec('BEGIN');
    const now = (d.prepare('SELECT epoch FROM mesh_state WHERE id = 1').get() as { epoch: number } | undefined)?.epoch ?? 1;
    epoch = Math.max(now, c.floor, carried.epoch.restored);
    d.prepare(`INSERT OR REPLACE INTO mesh_state (id, epoch, role, hub_id, standby_id, updated_at) VALUES (1, ?, 'hub', ?, NULL, ?)`).run(epoch, c.node, at);
    const row = d.prepare('SELECT purposes FROM device WHERE id = ?').get(c.node) as { purposes: string | null } | undefined;
    let purposes: string[] = [];
    try { purposes = JSON.parse(row?.purposes ?? '[]') as string[]; } catch { /* none */ }
    for (const p of ['hub-candidate', 'general-server']) if (!purposes.includes(p)) purposes.push(p);
    d.prepare(`UPDATE device SET role = 'hub', purposes = ? WHERE id = ?`).run(JSON.stringify(purposes), c.node);
    d.prepare(`UPDATE device SET role = 'spoke' WHERE id != ? AND role IN ('hub', 'standby')`).run(c.node);
    d.exec('DELETE FROM device_session');
    d.exec('UPDATE sync_state SET logging = 1 WHERE id = 1');
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch { /* nothing open */ }
    throw e;
  } finally {
    d.close();
  }
  carried.epoch.restored = epoch;
  carried.standby_resync = false;
  // Its role file (now's, carried with mesh/) says it is the hub, at that epoch.
  const roleFile = join(staged, 'mesh', 'role.json');
  if (existsSync(roleFile)) {
    try {
      const r = JSON.parse(readFileSync(roleFile, 'utf8')) as Record<string, unknown>;
      writeFileSync(`${roleFile}.tmp`, `${JSON.stringify({ ...r, role: 'hub', epoch, promoted_at: at }, null, 2)}\n`, { mode: 0o600 });
      renameSync(`${roleFile}.tmp`, roleFile);
    } catch { /* a role file Nova can't read: mesh_state decides */ }
  }
  const vaultAt = o.vaultAt ?? ((h: string) => new Vault({ home: h }));
  let own: string[] = [];
  try {
    const live = vaultAt(home);
    own = live.status().ok ? live.list('nova/') : [];
    const v = vaultAt(staged);
    v.reset(true);
    for (const n of own) { const val = live.get(n); if (val !== null) v.put(n, val); }
  } catch { own = []; }
  carried.vault = `The backup’s saved secrets can’t be opened: backups never hold their key, so they can’t be opened from it. Sign in to each connector again. (The key stays only where it already was: on the old hub, a standby that copied it, and their own checkpoints.)${own.length ? ` Nova’s own keys (${own.join(', ')}) came from this node.` : ''}`;
}

export function restoreRecord(home: string, id: string): (RestoreMarker & { finished_at: string }) | null {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  try { return JSON.parse(readFileSync(join(root(home), 'restores', `${id}.json`), 'utf8')); } catch { return null; }
}

// Restores finished but not yet recorded in the ledger (the ledger task is made once the core is up).
export function unrecordedRestores(home: string, recorded: (id: string) => boolean): (RestoreMarker & { finished_at: string })[] {
  let names: string[] = [];
  try { names = readdirSync(join(root(home), 'restores')); } catch { return []; }
  return names.map((n) => restoreRecord(home, n.replace(/\.json$/, ''))).filter((r): r is RestoreMarker & { finished_at: string } => !!r && !recorded(r.id));
}

export const newRestoreId = () => randomUUID();
export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

// ---- the service: what the core and its routes use -------------------------------------------------

export const WORKER_ID = 'checkpoints';
export const CONFIRMATION_SYSTEM = 'nova-checkpoints';

export interface CheckpointsOptions {
  db: Db;
  log: Log;
  home: string;
  version: string;
  now: () => Date;
  ledger: Ledger;
  verifier: Verifier;
  vault: Vault;
  vaultAt: (home: string) => Vault;
  hubId: () => string;
  role: () => 'hub' | 'standby';
  // The newest database version this code knows: a checkpoint from a newer Nova isn't restored.
  schema: () => number;
  restarter: Restarter;
  free?: (dir: string) => number | null;
}

export class Checkpoints {
  readonly worker: LanedWorker;
  #o: CheckpointsOptions;

  constructor(o: CheckpointsOptions) {
    this.#o = o;
    this.worker = this.#makeWorker();
    o.verifier.registerConfirmation(CONFIRMATION_SYSTEM, (e) => this.#confirm(e as { id?: string }));
  }

  take(o: { kind: CheckpointKind; name?: string | null; reason?: string | null }): CheckpointView {
    const m = takeCheckpoint({ home: this.#o.home, db: this.#o.db, version: this.#o.version, now: this.#o.now, ...(this.#o.free ? { free: this.#o.free } : {}), ...o });
    this.#o.log.info('resilience', m.kind === 'named' ? 'Checkpoint taken.' : 'Automatic checkpoint taken.', { id: m.id, reason: m.reason });
    return viewOf(m);
  }

  // An automatic checkpoint before something that needs one; throws (CheckpointError) when it can't,
  // and the caller stops.
  auto(reason: string): CheckpointView {
    return this.take({ kind: 'auto', reason });
  }

  list(): CheckpointView[] {
    return listCheckpoints(this.#o.home);
  }

  // Deleting data is tier 3 (NOVA-SPEC §6): the hub's own screen, confirmed every time.
  remove(id: string, o: { confirm: boolean; who: Who }): CheckpointView {
    if (o.who.principal.kind !== 'console') throw new CoreError('forbidden', 'Deleting a checkpoint is done from the hub’s own screen only.');
    if (!o.confirm) throw new CoreError('validation', 'Deleting a checkpoint can’t be undone: it needs your explicit confirmation every time (confirm: true).');
    const v = deleteCheckpoint(this.#o.home, id);
    this.#o.log.info('resilience', 'Checkpoint deleted.', { id });
    return v;
  }

  // Backups.also: every forget reaches each checkpoint; one that couldn't be cleaned was destroyed,
  // and the person is told.
  forget(table: string, ids: string[], words: string[]): { cleaned: string[]; destroyed: string[] } {
    const r = forgetInCheckpoints(this.#o.home, table, ids, words, this.#o.now());
    for (const p of r.destroyed) this.#o.log.problem('backups', 'A checkpoint couldn’t be cleaned of something you asked Nova to forget, so Nova deleted that checkpoint rather than keep it.', { detail: p });
    return r;
  }

  // What the confirmation says before a restore: the checkpoint's date, that everything since is
  // undone, that a checkpoint of now is taken first, and which devices would need pairing again.
  preview(id: string) {
    const f = findCheckpoint(this.#o.home, id);
    const v = viewOf(f.manifest);
    const dropped = droppedDevices(join(f.path, 'nova.db'), this.#o.db, this.#o.hubId());
    return {
      checkpoint: v,
      said: [
        `Nova goes back to how it was on ${v.at} (“${v.label}”).`,
        'Everything since then is undone: tasks, memories, settings and changes.',
        'Nova takes a checkpoint of now first, so you can come back to this.',
        'Devices you removed stay removed, anything you asked Nova to forget stays forgotten, and open problems stay listed.',
        'Files in this folder that aren’t Nova’s are left as they are.',
        ...(dropped.length ? [`${dropped.map((d) => `“${d.name}”`).join(', ')} ${dropped.length === 1 ? 'was' : 'were'} paired since then and will need pairing again.`] : []),
        'Nova restarts by itself; you don’t need to do anything.',
      ],
      dropped,
      from: 'console' as const,
    };
  }

  // Tier 3, from the hub's own screen, confirmed every time. Verifies the checkpoint, stages it
  // with what is carried over from now, takes a checkpoint of now, then restarts Nova, which applies
  // it before its database opens.
  async restore(id: string, o: { confirm: boolean; who: Who }) {
    if (o.who.principal.kind !== 'console') throw new CoreError('forbidden', 'Restoring a checkpoint is done from the hub’s own screen only.');
    if (!o.confirm) throw new CoreError('validation', 'Restoring rolls Nova back and undoes everything since: it needs your explicit confirmation every time (confirm: true).');
    if (this.#o.role() !== 'hub') throw new CoreError('conflict', 'This node is a standby; restore on the hub.');
    if (stagedPending(this.#o.home)) throw new CoreError('conflict', 'A restore is already waiting for Nova to restart.');
    const f = findCheckpoint(this.#o.home, id);
    const v = viewOf(f.manifest);
    const no = (why: string) => new CoreError('conflict', `Nova didn’t restore “${v.label}”: ${why}`);
    if (f.manifest.schema_version > this.#o.schema()) throw no(`it was taken by a newer version of Nova (database version ${f.manifest.schema_version}); this one can’t open it.`);
    // Nothing is staged that can't be applied: without a way to restart, there is no restore.
    if (!this.#o.restarter.available) throw no('it couldn’t restart itself here (no supervisor, and no server to restart it). Nothing changed.');
    const verified = verifyCheckpoint(f);
    const dropped = droppedDevices(join(f.path, 'nova.db'), this.#o.db, this.#o.hubId());
    let before: CheckpointView;
    let marker: RestoreMarker;
    try {
      stageCopy(this.#o.home, f, this.#o.free ? { free: this.#o.free } : {});
      before = this.auto(`Before restoring to “${v.label}”`);
      marker = writeStaged(this.#o.home, {
        id: newRestoreId(), at: this.#o.now().toISOString(),
        checkpoint: { id: v.id, label: v.label, at: v.at, kind: v.kind },
        verified: { ...verified, seal: f.manifest.seal ?? '' }, before: before.id,
      });
    } catch (e) {
      try { dropStaged(this.#o.home); } catch { /* nothing staged */ }
      if (e instanceof CheckpointError) throw no(/^there isn’t|^the disk filled/.test(e.message) ? e.message : `it couldn’t take a checkpoint of now first. ${e.message}`);
      throw e;
    }
    this.#o.log.info('resilience', 'Restore staged.', { id: marker.id, checkpoint: v.id, before: before.id });
    // If the restart doesn't happen, neither does the restore: it never fires at some later start.
    const failed = (e: Error) => {
      try { dropStaged(this.#o.home); } catch { /* reported below */ }
      try { this.#o.log.problem('resilience', `Nova didn’t restore “${v.label}”: it couldn’t restart itself (${e.message}). Nothing changed; you can try again.`); } catch { /* closing */ }
    };
    let restart: { how: string; said: string };
    try {
      restart = await this.#o.restarter.restartInPlace(`restore to ${v.id}`, { failed });
    } catch (e) {
      try { dropStaged(this.#o.home); } catch { /* nothing staged */ }
      throw no(`it couldn’t restart itself (${(e as Error).message}). Nothing changed.`);
    }
    return { restoring: true, id: marker.id, checkpoint: v, before, verified: marker.verified, dropped, restart };
  }

  // An emergency promotion (M10g, mesh/handover.ts) stages a backup folder the way a restore stages
  // a checkpoint (the same layout: nova.db, files/, manifest.json), after a checkpoint of now, with
  // the cold marker; the next start applies it. Its tier-3 confirmation and its checks (the backup's
  // restore drill) are the caller's. Returns the restore's id.
  stageCold(backupDir: string, cold: ColdStage): string {
    if (stagedPending(this.#o.home)) throw new CoreError('conflict', 'A restore is already waiting for Nova to restart.');
    if (!this.#o.restarter.available) throw new CoreError('conflict', 'Nova couldn’t restart itself here (no supervisor, and no server to restart it), so nothing was staged.');
    const bm = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8')) as { id: string; at: string; db: ManifestFile; files: ManifestFile[]; schema_version: number; seal?: string };
    if (bm.schema_version > this.#o.schema()) throw new CoreError('conflict', `The backup was made by a newer Nova (database version ${bm.schema_version}); this one can’t open it.`);
    const total = bm.db.bytes + bm.files.reduce((n, f) => n + f.bytes, 0);
    const f = { path: backupDir, manifest: { files: bm.files, total_bytes: total } as unknown as CheckpointManifest };
    try {
      stageCopy(this.#o.home, f, this.#o.free ? { free: this.#o.free } : {});
      // The node's own copy as it is now, kept on this machine: nothing it had is lost by this.
      const before = this.auto('Before an emergency promotion from a backup');
      const marker = writeStaged(this.#o.home, {
        id: newRestoreId(), at: this.#o.now().toISOString(),
        checkpoint: { id: bm.id, label: `the backup of ${bm.at}`, at: bm.at, kind: 'auto' },
        verified: { db: bm.db.sha256, files: bm.files.length, bytes: total, seal: bm.seal ?? '' }, before: before.id, cold,
      });
      this.#o.log.info('resilience', 'Emergency promotion staged.', { id: marker.id, backup: bm.id, before: before.id });
      return marker.id;
    } catch (e) {
      try { dropStaged(this.#o.home); } catch { /* nothing staged */ }
      throw e;
    }
  }

  // Restarts to apply what was staged; drops it when the restart doesn't happen.
  async restartStaged(why: string, failed: (e: Error) => void): Promise<{ said: string }> {
    const drop = (e: Error) => { try { dropStaged(this.#o.home); } catch { /* reported */ } failed(e); };
    try {
      const r = await this.#o.restarter.restartInPlace(why, { failed: drop });
      return { said: r.said };
    } catch (e) {
      try { dropStaged(this.#o.home); } catch { /* nothing staged */ }
      throw e;
    }
  }

  // Restores finished at this start: each becomes a ledger task with its evidence (once).
  recordFinished(): Task[] {
    const out: Task[] = [];
    for (const r of unrecordedRestores(this.#o.home, (id) => !!this.#o.db.get('SELECT 1 FROM task WHERE idempotency_key = ?', `restore:${id}`))) {
      out.push(this.#o.ledger.create({
        title: `Restore to “${r.checkpoint.label}”`,
        owner: WORKER_ID,
        goal: r.cold
          ? `Restore ${r.checkpoint.label} for an emergency promotion: this node becomes the hub with its own keys, keeping revocations, forgets and problems from now.`
          : `Put Nova back to the checkpoint “${r.checkpoint.label}” (${r.checkpoint.at}), keeping revocations, forgets, problems and the mesh epoch from now.`,
        origin: { kind: 'user' },
        evidence_required: [{ kind: 'confirmation', note: 'the checkpoint’s hashes, verified before applying, and what was carried over' }],
        approval_tier: 0,
        privacy_mode: 'local-only',
        user_visibility: 'attention',
        idempotency_key: `restore:${r.id}`,
        inputs: { action: 'restore', restore_id: r.id, checkpoint: r.checkpoint, verified: r.verified, before: r.before, carried: r.carried, confirmed: r.cold ? 'tier 3, on this node’s own screen (an emergency promotion)' : 'tier 3, on the hub’s own screen', ...(r.cold ? { cold: r.cold } : {}) },
      }));
    }
    if (out.length) void this.#o.ledger.pump();
    return out;
  }

  #makeWorker(): LanedWorker {
    return {
      id: WORKER_ID, name: 'Checkpoints', about: 'Records a restore to a checkpoint, with what it verified and what it carried over. On this machine only.', egress: 'none', evidence: ['confirmation'],
      timeoutMs: 60_000,
      lane: () => ({ key: 'checkpoints', max: 1 }),
      health: () => ({ ok: true }),
      run: async (brief: Brief): Promise<Report> => {
        const id = String((brief.inputs as { restore_id?: string } | undefined)?.restore_id ?? '');
        const r = restoreRecord(this.#o.home, id);
        const base = { envelope: ENVELOPE_VERSION as typeof ENVELOPE_VERSION, task_id: brief.task_id, artifacts: [] as Report['artifacts'], follow_up_suggestions: [] as string[], usage: { duration_ms: 0 } };
        if (!r) return { ...base, status: 'failed', summary: 'Nova has no record of that restore.', evidence: [], blockers: [] };
        const c = r.carried!;
        const parts = [
          `Restored “${r.checkpoint.label}” (${r.checkpoint.at}) after checking its database and ${r.verified.files} files against their hashes.`,
          c.revoked.length ? `${c.revoked.length} revoked ${c.revoked.length === 1 ? 'device stays' : 'devices stay'} revoked.` : '',
          c.dropped.length ? `${c.dropped.map((d) => `“${d.name}”`).join(', ')} need${c.dropped.length === 1 ? 's' : ''} pairing again.` : '',
          `The mesh epoch is ${c.epoch.restored}${c.standby_resync ? ', and the standby copies the hub afresh' : ''}.`,
          `${c.problems.carried} problem${c.problems.carried === 1 ? '' : 's'} carried over.`,
          r.before ? `A checkpoint of how Nova was just before is kept (${r.before}).` : '',
        ];
        return { ...base, status: 'done', summary: parts.filter(Boolean).join(' '), evidence: [{ kind: 'confirmation', system: CONFIRMATION_SYSTEM, id: `restore:${r.id}` }], blockers: [] };
      },
    };
  }

  // Nova reads it back itself: its record of the restore, the checkpoint's manifest (when it is
  // still there and uncleaned) and the mesh epoch it set.
  #confirm(e: { id?: string }): { ok: boolean; why: string } {
    const m = /^restore:([0-9a-f-]{36})$/.exec(e.id ?? '');
    if (!m) return { ok: false, why: 'Not a confirmation the checkpoints worker gives.' };
    const r = restoreRecord(this.#o.home, m[1]!);
    if (!r) return { ok: false, why: 'Nova has no record of that restore.' };
    const epoch = this.#o.db.get<{ epoch: number }>('SELECT epoch FROM mesh_state WHERE id = 1')?.epoch ?? 0;
    if (!r.carried || epoch < r.carried.epoch.restored) return { ok: false, why: `The mesh epoch is ${epoch}, lower than the restore set (${r.carried?.epoch.restored}).` };
    const f = scanCheckpoints(this.#o.home).found.find((x) => x.manifest.id === r.checkpoint.id);
    const same = f && !f.manifest.cleaned.length ? f.manifest.db.sha256 === r.verified.db : null;
    if (same === false) return { ok: false, why: 'The checkpoint’s manifest doesn’t name the database Nova verified.' };
    return { ok: true, why: `Nova read its record of the restore: “${r.checkpoint.label}”, database ${r.verified.db.slice(0, 12)}… and ${r.verified.files} files verified before applying${same ? ' (the checkpoint’s sealed manifest agrees)' : ''}; the mesh epoch is ${epoch}.` };
  }

  view(who: Who) {
    const marker = readMarker(this.#o.home);
    return {
      checkpoints: this.list(),
      retention: { keep_auto: KEEP_AUTO, rule: RETENTION },
      can_restore: who.principal.kind === 'console',
      restoring: marker ? { checkpoint: marker.checkpoint, at: marker.at } : null,
      strays: scanCheckpoints(this.#o.home).strays.length,
    };
  }

  routes(): Route[] {
    return [
      { method: 'GET', path: '/resilience/checkpoints', summary: `Checkpoints, newest first: each one’s name or reason, kind (auto or named), date, size and Nova version, and the retention rule. ${RETENTION}`, handle: ({ who }) => this.view(who) },
      {
        method: 'POST', path: '/resilience/checkpoints', status: 201, summary: `Take a named checkpoint of Nova’s own entries in the home now (tier 1). The name is up to ${NAME_MAX} characters; at most ${NAMED_MAX} named ones are kept.`, body: '{name}',
        handle: ({ body }) => this.take({ kind: 'named', name: body.name as string }),
      },
      {
        method: 'POST', path: '/resilience/checkpoints/{id}/delete', summary: 'Delete a checkpoint you named (tier 3: {confirm: true}, the hub’s own screen only). Automatic ones are kept by the retention rule.', body: '{confirm}',
        handle: ({ params, body, who }) => this.remove(params.id!, { confirm: body.confirm === true, who }),
      },
      { method: 'GET', path: '/resilience/checkpoints/{id}/restore', summary: 'What restoring this checkpoint would do, in the words the confirmation shows.', handle: ({ params }) => this.preview(params.id!) },
      {
        method: 'POST', path: '/resilience/checkpoints/{id}/restore', status: 202, summary: 'Restore this checkpoint (tier 3: {confirm: true}, the hub’s own screen only). A checkpoint of now is taken first; revocations, forgets, problems and the mesh epoch are kept from now. Nova restarts by itself and applies it before its database opens.', body: '{confirm}',
        handle: ({ params, body, who }) => this.restore(params.id!, { confirm: body.confirm === true, who }),
      },
    ];
  }
}
```

### `src/core/resilience/backup.ts`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `feecc3b28c823459d1d632eaa3a5784377b195b0`, SHA256 `d16b0663d1966feb23f0bf20a4385b32e8bae7c2d42e5364dd48091a95d983c8`, 681 physical lines (682 under boundary count).

```ts
// Nightly backups of the hub (LOCAL-FIRST §5, M7 plan §3). A backup is a folder in a place the
// person names: a consistent snapshot of the database (VACUUM INTO, taken while Nova runs), the
// home's files, and a manifest with the content hash of every one of them, the schema version and
// the migration checksums, so a restore drill can tell whether what comes back is what went in.
//
// What never goes in: the vault's key and this node's private keys (mesh/identity.json): a backup
// that leaves the machine must not carry what opens everything. The vault's file goes in, still
// encrypted. The home's git history, logs, the pre-upgrade backups and Nova's scratch stay too.
//
// Retention keeps the newest N by sequence number, never by date, so a clock that jumped can't
// make Nova delete the wrong ones. A new backup is complete before any old one is removed. Nova
// never creates the backup folder: if it isn't there (a drive not mounted), it refuses.
//
// Forgetting holds here too (owner's standing order 4): every forget is carried into each backup
// and each encrypted copy, which is decrypted, cleaned and encrypted again; a copy that can't be
// cleaned is destroyed and that is reported. That covers every folder Nova ever backed up to, not
// only the one set now; a folder that isn't there when the forget happens (a drive unplugged) is
// owed it: the forget is written down (out of every backup, its words sealed) and carried in as
// soon as the folder is back, before any backup, prune or drill touches it.
//
// What counts as a backup: only a folder Nova recorded making (backup_run, by id and sequence)
// whose manifest still carries Nova's seal (an HMAC under a key in the vault, never in a backup).
// Anything else named like one is a stray: never restored, never "latest", never pruned, and
// reported. Backups are the person's alone (folders 0700, files 0600), in a folder only they can
// write.
//
// The encrypted copy's key is the person's recovery key: shown once when the copy is set up (and
// again only at tier 3), it opens the copy on any machine, without this one's vault.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Db } from '../db.ts';
import type { Log } from '../log.ts';
import { cleanDbFile } from '../backups.ts';
import { CoreError } from '../errors.ts';
import { decryptTo, encryptDir, keyFingerprint, readHeader, safeRel, verifyFile } from './archive.ts';
import { dropScratch, makeScratch } from './scratch.ts';

export interface BackupSettings { target: string | null; keep: number; encrypted_target: string | null }
export const DEFAULT_KEEP = 7;
export const KEY_NAME = 'nova/backup-key';
// Seals manifests and the list of owed forgets: only Nova, holding it, can make a backup count.
export const SEAL_NAME = 'nova/backup-seal';

export interface ManifestFile { path: string; sha256: string; bytes: number }
export interface Manifest {
  v: 1;
  id: string;
  seq: number;
  at: string;
  nova_version: string;
  schema_version: number;
  migrations: { version: number; name: string; checksum: string }[];
  db: ManifestFile;
  files: ManifestFile[];
  excluded: string[];
  cleaned: { at: string; table: string; rows: number }[];
  // Nova's seal over everything above (HMAC-SHA256): a manifest without it, or changed since, is
  // not one of Nova's backups.
  seal?: string;
}

export interface BackupRun { id: string; seq: number; at: string; target: string; path: string | null; ok: boolean; bytes: number; files: number; encrypted_path: string | null; error: string | null; task_id: string | null }

// Why a backup didn't happen, for its playbook.
export type FailureKind = 'target-missing' | 'disk-full' | 'failed';
export class BackupError extends CoreError {
  readonly kind: FailureKind;
  constructor(kind: FailureKind, message: string) {
    super(kind === 'target-missing' ? 'not_found' : 'conflict', message);
    this.kind = kind;
  }
}

const DIR = /^nova-backup-(\d{6,})$/;
const ENC = /^nova-backup-(\d{6,})\.nbk$/;
const dirName = (seq: number) => `nova-backup-${String(seq).padStart(6, '0')}`;

// Top-level names in the home that are never in a backup, and why (shown in every manifest).
const SKIP_TOP: Record<string, string> = {
  '.git': 'the home’s git history stays on this machine',
  logs: 'Nova’s logs are for diagnosing this machine',
  backups: 'the pre-upgrade backups are kept separately',
  exports: 'exports are copies made on request',
  workers: 'workers’ scratch folders',
  kept: 'Nova’s own scratch',
  connectors: 'Era 2’s connection secrets (the vault holds them now)',
  'nova.pid': 'which process runs this home',
  checkpoints: 'checkpoints stay on this machine and are restore points, not backups',
  'factory-reset.json': 'a factory reset in progress acts on this home only',
  '.nova-home': 'Nova’s mark on this home, with the key that seals a reset, stays here',
};
const SKIP_FILE: Record<string, string> = {
  'vault/key': 'the vault’s key never leaves this machine',
  'mesh/identity.json': 'this node’s private keys never leave this machine',
};
const DB_FILE = /^nova\.db/;
const TEMP = /\.(tmp|partial)$|\.nova-sync-\d+\.tmp$/;
// The Credential Broker's store (docs/plans/vault-broker.md §10 "No escrow"): only its item blobs
// (ciphertext) go in. Its header, every wrap, the device key, the socket and the audit log never do,
// so a backup alone opens nothing.
const BROKER_KEPT = (r: string) => r === 'broker' || r === 'broker/items' || r.startsWith('broker/items/');

export const EXCLUDED = [
  'nova.db: copied as a consistent snapshot instead',
  'broker/ (all but broker/items/): the vault’s header, wraps and device key never leave this machine',
  ...Object.entries(SKIP_FILE).map(([p, why]) => `${p}: ${why}`),
  ...Object.entries(SKIP_TOP).map(([p, why]) => `${p}: ${why}`),
];

export const sha256File = (path: string): string => {
  const h = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    for (let at = 0; ;) {
      const n = readSync(fd, buf, 0, buf.length, at);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
      at += n;
    }
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
};

// The home's files a backup carries, as paths relative to the home.
export function backupFiles(home: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(home, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && (SKIP_TOP[e.name] || DB_FILE.test(e.name))) continue;
      if (SKIP_FILE[r] || TEMP.test(e.name) || ((r === 'broker' || r.startsWith('broker/')) && !BROKER_KEPT(r))) continue;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out.push(r);
      // Links, sockets and the like are not the person's content and are never followed.
    }
  };
  walk('');
  return out;
}

const isFull = (e: unknown) => {
  const m = (e as Error)?.message ?? '';
  return (e as NodeJS.ErrnoException)?.code === 'ENOSPC' || /disk is full|SQLITE_FULL|ENOSPC/i.test(m);
};

export interface NightlyOptions {
  db: Db;
  home: string;
  log: Log;
  version: string;
  settings: () => BackupSettings;
  // The encryption key (the person's recovery key), from the vault: made once, on first use.
  key: () => Buffer;
  // The seal's key, from the vault: made once, on first use. Null when the vault can't give it.
  seal: () => Buffer | null;
  // A folder now owes forgets (it isn't there), or owes none any more (they were carried in).
  owed?: (folder: string, kind: FolderKind, owes: boolean) => void;
  now?: () => Date;
}

export type FolderKind = 'folder' | 'encrypted';
interface Found { path: string; seq: number; manifest: Manifest }
interface FoundCopy { path: string; seq: number; at: string | null }
// A forget a folder still owes: which rows, and the words (sealed: they are what was forgotten).
interface Owed { folder: string; kind: FolderKind; table: string; ids: string[]; words: string; at: string }

export class NightlyBackups {
  #o: NightlyOptions;
  #now: () => Date;

  constructor(o: NightlyOptions) {
    this.#o = o;
    this.#now = o.now ?? (() => new Date());
  }

  // Makes one backup now. Throws a BackupError (with its kind) when it can't; the old backups are
  // untouched then. Returns the run, with the encrypted copy's path or why there isn't one.
  run(o: { taskId?: string } = {}): BackupRun & { manifest: Manifest; encrypted_error: string | null } {
    // Forgets owed to a folder that is back go in before anything else is done there.
    this.applyOwed();
    const s = this.#o.settings();
    if (!s.target) throw new BackupError('target-missing', 'No backup folder is set yet. Choose one with PUT /api/v1/backups/settings.');
    const target = resolve(s.target);
    const at = this.#now().toISOString();
    const seq = this.#nextSeq(target);
    const id = dirName(seq);
    const fail = (kind: FailureKind, message: string): never => {
      this.#record({ id: `${id}-failed-${randomBytes(3).toString('hex')}`, seq, at, target, path: null, ok: false, bytes: 0, files: 0, encrypted_path: null, error: message, task_id: o.taskId ?? null });
      throw new BackupError(kind, message);
    };
    let st: ReturnType<typeof statSync> | null = null;
    try { st = statSync(target); } catch { /* not there */ }
    if (!st?.isDirectory()) return fail('target-missing', `The backup folder ${target} isn’t there. Nova won’t create it, in case it’s a drive that isn’t plugged in.`);
    if (inside(target, this.#o.home)) return fail('failed', 'The backup folder is inside Nova’s home, so a backup would contain itself. Choose a folder outside it.');
    const unsafe = folderProblem(target);
    if (unsafe) return fail('failed', unsafe);
    const sealKey = this.#o.seal();
    if (!sealKey) return fail('failed', 'Nova couldn’t get the key it seals backups with from the vault, so it made no backup.');

    const final = join(target, id);
    const partial = join(target, `.${id}.partial`);
    let manifest: Manifest;
    try {
      rmSync(partial, { recursive: true, force: true });
      // The person's alone, whatever the umask: folders 0700, files 0600.
      mkdirSync(join(partial, 'files'), { recursive: true, mode: 0o700 });
      chmodSync(partial, 0o700);
      chmodSync(join(partial, 'files'), 0o700);
      const snap = join(partial, 'nova.db');
      this.#o.db.raw.exec(`VACUUM INTO '${snap.replaceAll("'", "''")}'`);
      chmodSync(snap, 0o600);
      const files: ManifestFile[] = [];
      for (const rel of backupFiles(this.#o.home)) {
        const src = join(this.#o.home, rel);
        const dst = join(partial, 'files', rel);
        mkdirSync(join(dst, '..'), { recursive: true, mode: 0o700 });
        try {
          copyFileSync(src, dst);
          chmodSync(dst, 0o600);
        } catch (e) {
          // A file that went away while copying (a journal rotated, a scratch file removed) is
          // simply not in this backup; anything else stops it.
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw e;
        }
        files.push({ path: rel, sha256: sha256File(dst), bytes: statSync(dst).size });
      }
      const snapDb = new DatabaseSync(snap, { readOnly: true });
      let migrations: Manifest['migrations'];
      try {
        migrations = snapDb.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as unknown as Manifest['migrations'];
      } finally {
        snapDb.close();
      }
      manifest = {
        v: 1, id, seq, at, nova_version: this.#o.version,
        schema_version: migrations.at(-1)?.version ?? 0, migrations,
        db: { path: 'nova.db', sha256: sha256File(snap), bytes: statSync(snap).size },
        files, excluded: EXCLUDED, cleaned: [],
      };
      writeManifest(partial, manifest, sealKey);
      renameSync(partial, final);
    } catch (e) {
      rmSync(partial, { recursive: true, force: true });
      if (isFull(e)) return fail('disk-full', `The disk the backup folder is on is full, so the backup stopped. Your earlier backups are untouched. (${(e as Error).message})`);
      return fail('failed', `The backup stopped: ${(e as Error).message}. Your earlier backups are untouched.`);
    }
    const bytes = manifest.db.bytes + manifest.files.reduce((n, f) => n + f.bytes, 0);
    let encrypted: string | null = null;
    let encryptedError: string | null = null;
    if (s.encrypted_target) {
      try {
        encrypted = this.#encrypt(final, manifest, s.encrypted_target);
      } catch (e) {
        encryptedError = isFull(e) ? `The encrypted copy wasn’t made: the disk it goes to is full.` : `The encrypted copy wasn’t made: ${(e as Error).message}`;
      }
    }
    const run: BackupRun = { id, seq, at, target, path: final, ok: true, bytes, files: manifest.files.length, encrypted_path: encrypted, error: encryptedError, task_id: o.taskId ?? null };
    this.#record(run);
    this.prune();
    return { ...run, manifest, encrypted_error: encryptedError };
  }

  // Keeps the newest `keep` backups (and encrypted copies) Nova made, by sequence number; removes
  // the rest, and anything left half-written by a backup that was stopped. Strays are left alone.
  prune(): { removed: string[] } {
    this.applyOwed();
    const s = this.#o.settings();
    const removed: string[] = [];
    const keep = Math.max(1, s.keep || DEFAULT_KEEP);
    if (s.target && existsSync(s.target)) {
      for (const e of readdirSync(s.target)) if (/^\.nova-backup-\d+\.partial$/.test(e)) rmSync(join(s.target, e), { recursive: true, force: true });
      for (const b of this.complete().slice(keep)) { rmSync(b.path, { recursive: true, force: true }); removed.push(b.path); }
    }
    if (s.encrypted_target && existsSync(s.encrypted_target)) {
      for (const e of this.encrypted().slice(keep)) { rmSync(e.path, { force: true }); removed.push(e.path); }
    }
    return { removed };
  }

  // Nova's own complete backups in the folder, newest first.
  complete(): Found[] {
    const target = this.#o.settings().target;
    return target ? this.#scan(target).found : [];
  }

  encrypted(): FoundCopy[] {
    const t = this.#o.settings().encrypted_target;
    return t ? this.#scanCopies(t).found : [];
  }

  // Nova's own backups (or encrypted copies) in one folder, newest first, and the strays there: for
  // a factory reset, which erases Nova's own in every folder it ever backed up to, strays never.
  inFolder(folder: string, kind: FolderKind): { found: { path: string; seq: number; seal: string | null }[]; strays: string[] } {
    if (kind === 'encrypted') {
      const r = this.#scanCopies(folder);
      return { found: r.found.map((f) => ({ path: f.path, seq: f.seq, seal: null })), strays: r.strays };
    }
    const r = this.#scan(folder);
    return { found: r.found.map((f) => ({ path: f.path, seq: f.seq, seal: f.manifest.seal ?? null })), strays: r.strays };
  }

  // Whether an encrypted copy opens under the backup key (its tag checks out), without unpacking it.
  authentic(file: string): boolean {
    try { return verifyFile(file, this.#o.key()); } catch { return false; }
  }

  // Whether a folder is there to act on (the rule forgetting uses: see #reachable).
  reachable(folder: string, kind: FolderKind): boolean {
    return this.#reachable(folder, kind);
  }

  // Things in the backup folders named like Nova's backups that Nova didn't make (or that were
  // changed since): never used, never pruned, shown so the person can look.
  strays(): string[] {
    const s = this.#o.settings();
    return [...(s.target ? this.#scan(s.target).strays : []), ...(s.encrypted_target ? this.#scanCopies(s.encrypted_target).strays : [])];
  }

  #scan(folder: string): { found: Found[]; strays: string[] } {
    const found: Found[] = [];
    const strays: string[] = [];
    let names: string[] = [];
    try { names = readdirSync(folder); } catch { return { found, strays }; }
    const key = this.#o.seal();
    for (const e of names) {
      const m = DIR.exec(e);
      if (!m) continue;
      const path = join(folder, e);
      let manifest: Manifest | null = null;
      try { manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) as Manifest; } catch { /* below */ }
      const seq = Number(m[1]);
      const ours = !!manifest && !!key && manifest.id === e && manifest.seq === seq && sealed(manifest, key)
        && !!this.#o.db.get('SELECT 1 FROM backup_run WHERE id = ? AND seq = ? AND ok = 1', manifest.id, seq);
      if (ours) found.push({ path, seq, manifest: manifest! });
      else strays.push(path);
    }
    return { found: found.sort((a, b) => b.seq - a.seq), strays };
  }

  #scanCopies(folder: string): { found: FoundCopy[]; strays: string[] } {
    const found: FoundCopy[] = [];
    const strays: string[] = [];
    let names: string[] = [];
    try { names = readdirSync(folder); } catch { return { found, strays }; }
    for (const e of names) {
      const m = ENC.exec(e);
      if (!m) continue;
      const path = join(folder, e);
      const seq = Number(m[1]);
      const recorded = this.#o.db.all<{ encrypted_path: string }>('SELECT encrypted_path FROM backup_run WHERE seq = ? AND ok = 1 AND encrypted_path IS NOT NULL', seq).some((r) => basename(r.encrypted_path) === e);
      let at: string | null = null;
      // A copy whose header can't be read is still Nova's when recorded: the drill says it's damaged.
      let named = true;
      try { const h = readHeader(path); at = h.at; named = h.id === dirName(seq) && h.seq === seq; } catch { /* damaged */ }
      if (recorded && named) found.push({ path, seq, at });
      else strays.push(path);
    }
    return { found: found.sort((a, b) => b.seq - a.seq), strays };
  }

  runs(limit = 20): BackupRun[] {
    return this.#o.db.all<Record<string, unknown>>('SELECT * FROM backup_run ORDER BY at DESC, seq DESC LIMIT ?', limit).map((r) => ({ ...(r as unknown as BackupRun), ok: r.ok === 1 }));
  }

  // Unpacks an encrypted copy into `outDir` (which must not exist yet), checked whole first.
  decrypt(file: string, outDir: string, key: Buffer = this.#o.key()): Manifest {
    decryptTo(file, key, outDir);
    return JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')) as Manifest;
  }

  // ---- forgetting -------------------------------------------------------------------------------

  // A forget, carried into every backup and every encrypted copy, in every folder Nova ever backed
  // up to (backups.ts calls this). A folder that isn't there owes it.
  forget(table: string, ids: string[], words: string[]): { cleaned: string[]; destroyed: string[] } {
    const cleaned: string[] = [];
    const destroyed: string[] = [];
    if (!ids.length) return { cleaned, destroyed };
    // What was owed before goes first, so forgets reach each folder in the order they were made.
    this.applyOwed();
    for (const f of this.folders()) {
      if (this.#reachable(f.folder, f.kind)) {
        const r = this.#clean(f.folder, f.kind, table, ids, words);
        cleaned.push(...r.cleaned);
        destroyed.push(...r.destroyed);
      } else this.#owe(f.folder, f.kind, table, ids, words);
    }
    return { cleaned, destroyed };
  }

  // Every folder Nova backed up to, and the ones set now: forgetting reaches them all.
  folders(): { folder: string; kind: FolderKind }[] {
    const s = this.#o.settings();
    const out = new Map<string, { folder: string; kind: FolderKind }>();
    const add = (folder: string | null, kind: FolderKind) => { if (folder) out.set(`${kind}\0${resolve(folder)}`, { folder: resolve(folder), kind }); };
    for (const r of this.#o.db.all<{ target: string }>('SELECT DISTINCT target FROM backup_run WHERE ok = 1')) add(r.target, 'folder');
    for (const r of this.#o.db.all<{ p: string }>('SELECT DISTINCT encrypted_path AS p FROM backup_run WHERE encrypted_path IS NOT NULL')) add(dirname(r.p), 'encrypted');
    add(s.target, 'folder');
    add(s.encrypted_target, 'encrypted');
    return [...out.values()];
  }

  // Forgets owed to folders that aren't there, by folder: shown in Health.
  owedView(): { folder: string; kind: FolderKind; forgets: number; since: string }[] {
    const by = new Map<string, { folder: string; kind: FolderKind; forgets: number; since: string }>();
    for (const o of this.#loadOwed()) {
      const k = `${o.kind}\0${o.folder}`;
      const v = by.get(k) ?? { folder: o.folder, kind: o.kind, forgets: 0, since: o.at };
      v.forgets++;
      by.set(k, v);
    }
    return [...by.values()];
  }

  // Carries owed forgets into each folder that is back. Called before a backup, a prune and a
  // drill, and by the heartbeat; a folder still away keeps what it owes.
  applyOwed(): { applied: { folder: string; kind: FolderKind }[] } {
    const owed = this.#loadOwed();
    const applied: { folder: string; kind: FolderKind }[] = [];
    if (!owed.length) return { applied };
    const left: Owed[] = [];
    const key = this.#owedKey();
    const groups = new Map<string, Owed[]>();
    for (const o of owed) groups.set(`${o.kind}\0${o.folder}`, [...(groups.get(`${o.kind}\0${o.folder}`) ?? []), o]);
    for (const list of groups.values()) {
      const { folder, kind } = list[0]!;
      if (!key || !this.#reachable(folder, kind)) { left.push(...list); continue; }
      try {
        for (const o of list) this.#clean(folder, kind, o.table, o.ids, unsealWords(o.words, key));
        applied.push({ folder, kind });
      } catch (e) {
        left.push(...list);
        this.#o.log.warn('backups', 'Nova couldn’t carry an owed forget into a backup folder yet.', { folder, error: (e as Error).message });
      }
    }
    this.#saveOwed(left);
    for (const a of applied) this.#o.owed?.(a.folder, a.kind, false);
    return { applied };
  }

  // A folder is there for forgetting when it exists and either holds Nova's backups or never had
  // any. An empty folder where backups were (a drive's mount point with the drive unplugged) is
  // not: cleaning it would clean nothing and let the forget be dropped.
  #reachable(folder: string, kind: FolderKind): boolean {
    try { if (!statSync(folder).isDirectory()) return false; } catch { return false; }
    const found = kind === 'folder' ? this.#scan(folder).found.length : this.#scanCopies(folder).found.length;
    if (found) return true;
    const had = kind === 'folder'
      ? !!this.#o.db.get('SELECT 1 FROM backup_run WHERE ok = 1 AND target = ?', folder)
      : this.#o.db.all<{ p: string }>('SELECT encrypted_path AS p FROM backup_run WHERE encrypted_path IS NOT NULL').some((r) => dirname(r.p) === folder);
    return !had;
  }

  #clean(folder: string, kind: FolderKind, table: string, ids: string[], words: string[]): { cleaned: string[]; destroyed: string[] } {
    const cleaned: string[] = [];
    const destroyed: string[] = [];
    const sealKey = this.#o.seal();
    if (!sealKey) throw new Error('the key that seals backups isn’t available');
    if (kind === 'folder') {
      for (const b of this.#scan(folder).found) {
        try {
          cleanBackup(b.path, table, ids, words, this.#now(), sealKey);
          cleaned.push(b.path);
        } catch (e) {
          rmSync(b.path, { recursive: true, force: true });
          destroyed.push(b.path);
          this.#o.log.problem('backups', 'A nightly backup couldn’t be cleaned of something you asked Nova to forget, so Nova deleted that backup rather than keep it.', { detail: `${b.path}: ${(e as Error).message}` });
        }
      }
      return { cleaned, destroyed };
    }
    for (const e of this.#scanCopies(folder).found) {
      const scratch = makeScratch('forget');
      try {
        const out = join(scratch, 'backup');
        const h = decryptTo(e.path, this.#o.key(), out);
        cleanBackup(out, table, ids, words, this.#now(), sealKey);
        encryptDir(out, e.path, this.#o.key(), { id: h.id, seq: h.seq, at: h.at });
        cleaned.push(e.path);
      } catch (err) {
        rmSync(e.path, { force: true });
        destroyed.push(e.path);
        this.#o.log.problem('backups', 'An encrypted backup copy couldn’t be cleaned of something you asked Nova to forget, so Nova deleted that copy rather than keep it.', { detail: `${e.path}: ${(err as Error).message}` });
      } finally {
        dropScratch(scratch);
      }
    }
    return { cleaned, destroyed };
  }

  #owe(folder: string, kind: FolderKind, table: string, ids: string[], words: string[]): void {
    const key = this.#owedKey();
    if (!key) {
      this.#o.log.problem('backups', `Nova couldn’t write down a forget owed to ${folder}: the vault can’t give it the key it seals them with. Delete the backups there yourself.`);
      return;
    }
    this.#saveOwed([...this.#loadOwed(), { folder, kind, table, ids, words: sealWords(words, key), at: this.#now().toISOString() }]);
    this.#o.owed?.(folder, kind, true);
  }

  // The owed list lives in the home's `kept` folder: never in a backup, never copied to a sandbox
  // or the standby, and emptied once every folder has what it owed.
  #owedFile(): string {
    return join(this.#o.home, 'kept', '.nova', 'forgets-owed.json');
  }

  #loadOwed(): Owed[] {
    try { return (JSON.parse(readFileSync(this.#owedFile(), 'utf8')) as { owed: Owed[] }).owed ?? []; } catch { return []; }
  }

  #saveOwed(list: Owed[]): void {
    const file = this.#owedFile();
    if (!list.length && !existsSync(file)) return;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ v: 1, owed: list }, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  #owedKey(): Buffer | null {
    const k = this.#o.seal();
    return k ? createHash('sha256').update('nova-owed-forgets\0').update(k).digest() : null;
  }

  #encrypt(dir: string, m: Manifest, to: string): string {
    let st: ReturnType<typeof statSync> | null = null;
    try { st = statSync(to); } catch { /* not there */ }
    if (!st?.isDirectory()) throw new Error(`the folder ${to} isn’t there, and Nova won’t create it`);
    const unsafe = folderProblem(to);
    if (unsafe) throw new Error(unsafe);
    const file = join(to, `${m.id}.nbk`);
    encryptDir(dir, file, this.#o.key(), { id: m.id, seq: m.seq, at: m.at });
    return file;
  }

  #nextSeq(target: string): number {
    let max = this.#o.db.get<{ s: number | null }>('SELECT MAX(seq) AS s FROM backup_run')?.s ?? 0;
    try { for (const e of readdirSync(target)) { const m = DIR.exec(e) ?? ENC.exec(e); if (m) max = Math.max(max, Number(m[1])); } } catch { /* checked by the caller */ }
    return max + 1;
  }

  #record(r: BackupRun): void {
    this.#o.db.run('INSERT OR REPLACE INTO backup_run (id, seq, at, target, path, ok, bytes, files, encrypted_path, error, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      r.id, r.seq, r.at, r.target, r.path, r.ok ? 1 : 0, r.bytes, r.files, r.encrypted_path, r.error, r.task_id);
  }
}

const inside = (path: string, root: string) => {
  const r = relative(resolve(root), resolve(path));
  return r === '' || (!r.startsWith('..') && !r.startsWith(sep) && !r.includes(`..${sep}`));
};

// Why a folder can't hold backups, or null: it must be the person's own, and no one else may
// write it (they could change or plant backups there).
export function folderProblem(path: string): string | null {
  let st: ReturnType<typeof statSync>;
  try { st = statSync(path); } catch { return null; }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid !== null && st.uid !== uid) return `${path} belongs to another user, so they could change or plant backups there. Choose a folder of your own.`;
  if (Number(st.mode) & 0o022) return `${path} is a folder other users can write to, so they could change or plant backups there. Choose a folder only you can write (chmod go-w).`;
  return null;
}

const sealOf = (m: Manifest, key: Buffer) => {
  const { seal: _seal, ...rest } = m;
  return createHmac('sha256', key).update(JSON.stringify(rest)).digest('hex');
};

// Exported for an emergency promotion (mesh/handover.ts), which picks the latest backup in a folder
// without this node's record of making it.
export const sealed = (m: Manifest, key: Buffer) => {
  if (typeof m.seal !== 'string' || !/^[0-9a-f]{64}$/.test(m.seal)) return false;
  return timingSafeEqual(Buffer.from(m.seal, 'hex'), Buffer.from(sealOf(m, key), 'hex'));
};

// Writes a backup's manifest with Nova's seal, all at once, readable by the person only.
export function writeManifest(dir: string, m: Manifest, key: Buffer): void {
  const path = join(dir, 'manifest.json');
  m.seal = sealOf(m, key);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(m, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

const sealWords = (words: string[], key: Buffer): string => {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([c.update(JSON.stringify(words)), c.final()]);
  return Buffer.concat([nonce, body, c.getAuthTag()]).toString('base64');
};

const unsealWords = (text: string, key: Buffer): string[] => {
  const b = Buffer.from(text, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(b.length - 16));
  return JSON.parse(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('utf8')) as string[];
};

// Cleans one backup folder of rows (and of the words, in its files), then writes its manifest's
// hashes again, sealed, so the drill can still check it. Throws when it can't, so the caller
// destroys it. Every path the manifest names is checked first: none may reach outside the backup.
export function cleanBackup(dir: string, table: string, ids: string[], words: string[], at: Date, sealKey: Buffer): void {
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  m.files.forEach((f) => safeRel(f.path));
  const db = join(dir, 'nova.db');
  const originals = new Set(cleanDbFile(db, table, ids, words).map((id) => `capture/raw/${id}`));
  m.files = m.files.filter((f) => {
    if (!originals.has(f.path)) return true;
    rmSync(join(dir, 'files', safeRel(f.path)), { force: true });
    return false;
  });
  m.db = { path: 'nova.db', sha256: sha256File(db), bytes: statSync(db).size };
  const ws = words.map((w) => w.trim()).filter((w) => w.length >= 3);
  if (ws.length) {
    m.files.forEach((f) => {
      const p = join(dir, 'files', safeRel(f.path));
      if (!existsSync(p) || lstatSync(p).isSymbolicLink()) return;
      const raw = readFileSync(p);
      if (!ws.some((w) => raw.includes(Buffer.from(w)))) return;
      if (raw.includes(0)) throw new Error(`${f.path} holds forgotten words and isn’t text, so it can’t be cleaned.`);
      // Lines that carry the words go; what's left of a record spread over lines goes too.
      let text = raw.toString('utf8').split('\n').filter((line) => !ws.some((w) => line.includes(w))).join('\n');
      for (const w of ws) text = text.split(w).join('');
      writeFileSync(p, text);
      f.sha256 = sha256File(p);
      f.bytes = statSync(p).size;
    });
  }
  m.cleaned = [...(m.cleaned ?? []), { at: at.toISOString(), table, rows: ids.length }];
  writeManifest(dir, m, sealKey);
}

// Copies a backup folder into a new home: the database and the files, nothing else. `into` must be
// empty or not exist yet: restoring never writes over a home. A path that would reach outside the
// backup, or anything that isn't a plain file, stops it before anything is written.
export function restoreInto(backupDir: string, into: string): Manifest {
  const m = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8')) as Manifest;
  const rels = m.files.map((f) => safeRel(f.path));
  for (const rel of rels) if (!lstatSync(join(backupDir, 'files', rel)).isFile()) throw new Error(`${rel} in the backup isn’t a plain file.`);
  if (!lstatSync(join(backupDir, 'nova.db')).isFile()) throw new Error('The backup’s database isn’t a plain file.');
  if (existsSync(into) && readdirSync(into).length) throw new CoreError('conflict', `${into} isn’t empty. Restore into a new folder; Nova never restores over a home.`);
  mkdirSync(into, { recursive: true, mode: 0o700 });
  for (const rel of rels) {
    const dst = join(into, rel);
    mkdirSync(join(dst, '..'), { recursive: true, mode: 0o700 });
    copyFileSync(join(backupDir, 'files', rel), dst);
  }
  copyFileSync(join(backupDir, 'nova.db'), join(into, 'nova.db'));
  return m;
}

export function newKey(): Buffer {
  return randomBytes(32);
}

// ---- the recovery key ---------------------------------------------------------------------------

// The encrypted copy's key as the person keeps it: 64 hex digits in eight groups.
export function formatRecoveryKey(key: Buffer): string {
  return (key.toString('hex').match(/.{8}/g) ?? []).join('-');
}

export function parseRecoveryKey(text: string): Buffer {
  const hex = String(text ?? '').toLowerCase().replace(/[\s-]/g, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new CoreError('validation', 'A recovery key is 64 digits and letters a–f, in eight groups.');
  return Buffer.from(hex, 'hex');
}

export { keyFingerprint };

// Opens an encrypted copy with the person's recovery key alone: no home, no vault, any machine.
export function openEncrypted(file: string, recoveryKey: string, outDir: string): Manifest {
  const key = parseRecoveryKey(recoveryKey);
  if (readHeader(file).key_fp !== keyFingerprint(key)) throw new Error('That recovery key doesn’t open this encrypted backup: it was made with a different key.');
  decryptTo(file, key, outDir);
  return JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')) as Manifest;
}
```

### `src/core/mesh/sync.ts`

Source `44a8deb563324ac2847c02dc82dfc6e3aec32d85`, Git blob `a15b6992af1b63e41ec5ec34a2a34dea634fc2e8`, SHA256 `9095534fa52f2c75dd804d183dc5f19abfcb7e82854b409c4994e4fdf9d75409`, 564 physical lines (565 under boundary count).

```ts
// The sync log (M4 plan §3): what the hub has, in an order a standby can follow. The database
// triggers of migration 0006 record every write to a replicated table; this module adds the home's
// files (the journal), serves the log in batches, applies a batch on a standby, and keeps the
// standing order that a forgotten memory is gone everywhere, this log included.
//
// The log holds one entry per row or file, the newest: the triggers drop the older entry when they
// add one. A standby that is behind therefore never misses a change (the newer entry has a higher
// seq), and one that starts from nothing reads the whole state once.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { CoreError } from '../errors.ts';
import type { Db } from '../db.ts';
import type { Log } from '../log.ts';
import { HybridClock } from './wire.ts';

// Replicated tables and their keys, as in migrations 0006 and 0007. Everything else stays on its own node.
export const REPLICATED: Readonly<Record<string, readonly string[]>> = {
  profile: ['section', 'key'], task: ['id'], task_event: ['seq'], memory: ['id'], memory_event: ['id'],
  decision_template: ['template_id', 'version'], decision_template_event: ['seq'], trigger_rule: ['id'], trigger_rule_event: ['seq'],
  trigger: ['trigger_id'], message: ['id'], extension: ['id'], device: ['id'], problem: ['id'], receipt: ['id'],
  // Migration 0007: a device's queued items, taken in exactly once, on whichever node is hub.
  device_inbox: ['device_id', 'key'],
  // Migration 0009: capture (M6a). Sources carry consent and each adapter's cursor; events carry
  // what was captured, and a delete of one is forgetting it (see `forgetting`).
  capture_source: ['id'], capture_event: ['id'], capture_tombstone: ['source_id', 'key'], capture_promotion: ['id'], capture_proposal: ['id'],
  // Migration 0011: the change pipeline's records (M7a), so a standby knows what is live and why.
  change_record: ['id'],
  // Migration 0023 (M10h): what each device is assigned to run; each capture batch as verified; and
  // forgets still waiting for a device's acknowledgement; and raw-to-event mappings needed to read
  // and forget fetched originals and their recovery copies. A hub that takes over keeps all four.
  device_workload: ['device_id', 'service'], capture_batch: ['id'], capture_device_tombstone: ['id'], capture_raw_fetch: ['id'],
};
// Columns a release added to a replicated table, by the schema version that added them (M10f review,
// finding 3: one mechanism for every such column). A standby a release behind doesn't have them:
//   - the hub leaves them out of what it serves, by the schema the standby says it is on when it
//     pulls (`batch({ peerSchema })`); a standby that says nothing (code from before this) is taken to
//     be on UNSTATED_SCHEMA;
//   - a standby that gets one anyway (a hub that didn't adapt) leaves it out and says once that it is
//     behind (`#put`).
// A migration that adds a column to a replicated table adds it here; tests/core/sync-skew.test.ts
// fails when one is missing. Its triggers carry the column always: the sender adapts, not the trigger.
export const ADDED_COLUMNS: Readonly<Record<number, Readonly<Record<string, readonly string[]>>>> = Object.freeze({
  19: { receipt: ['opt_in'] },
  20: { device: ['purposes'] },
  // Whether a problem stops Nova (the orb's red; DESIGN-SYSTEM §1). A standby without it shows every
  // problem amber, as before.
  21: { problem: ['stops'] },
  // Capture screening, job 1: each captured event's screening state and provenance.
  22: { capture_event: ['sensitivity', 'sensitivity_why', 'sensitivity_decision', 'sensitivity_detail', 'sensitivity_at', 'sensitivity_tries', 'sensitivity_next'] },
  // M10h: where a captured event came from and how it got here (the capture data path's provenance).
  // A standby without it keeps the event without its provenance until it catches up.
  23: { capture_event: ['provenance'] },
});
export const UNSTATED_SCHEMA = 19;

// The columns a peer on `schema` doesn't have, by table.
export function columnsAfter(schema: number): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [v, tables] of Object.entries(ADDED_COLUMNS)) {
    if (Number(v) <= schema) continue;
    for (const [t, cols] of Object.entries(tables)) for (const c of cols) out.set(t, new Set([...(out.get(t) ?? []), c]));
  }
  return out;
}

export const FILE = 'file';
// The vault (vault.ts) is one entry: its ciphertext in the log like a row. Its key is added only
// when a batch is served, inside the batch sealed to the standby, so the log never holds it.
export const VAULT = 'vault';
export interface VaultSync { sealedFile(): string | null; keyForStandby(): string | null; adopt(file: string, key: string): void; clear(): void }

// Home files that are not the person's content, so they stay on their node: the database (sync
// carries it row by row), logs, backups, exports, extension leftovers, worker scratch, connector
// secrets (Era 2's plaintext ones; the vault travels as its own entry, above), the mesh identity,
// and git's history. Everything else in the home is journalled.
// Checkpoints (M7 amendment) stay on their node too: they hold its keys. So do a factory reset's
// marker and report (resilience/reset.ts): a standby that copied the marker would erase itself with
// the hub's plan.
export const NOT_JOURNALLED: ReadonlySet<string> = new Set(['.git', 'mesh', 'logs', 'backups', 'exports', 'kept', 'workers', 'connectors', 'vault', 'broker', 'checkpoints', 'factory-reset.json', 'reset-report.json', '.nova-home']);
const DB_FILE = /^nova\.db/;
const TMP = /\.nova-sync-\d+\.tmp$/;
// A bigger file isn't carried; it is reported once instead.
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
const TOO_BIG = /^(.+) is larger than \d+ MB, so the standby doesn’t get a copy of it/;
// A standby this far behind the oldest entry it hasn't acknowledged is "behind".
export const BEHIND_AFTER_S = 60;

export type Op = 'put' | 'delete' | 'file_put' | 'file_delete';
export interface LogRow { seq: number; tbl: string; pk: string; op: Op; row: string | null; hlc: string }
export interface FileRow { path: string; sha256: string; size: number; text?: string; b64?: string }
export interface Batch { rows: LogRow[]; upto: number; more: boolean; head: number }
export interface Lag { head: number; acked_seq: number; acked_at: string | null; rows: number; seconds: number; behind: boolean }

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const OPS: readonly Op[] = ['put', 'delete', 'file_put', 'file_delete'];

// A relative home path that a file entry may name: inside the home, not in a place that stays local.
export function journalPath(rel: string): string | null {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || rel.startsWith('/') || rel.includes('\\')) return null;
  const n = normalize(rel).split(sep).join('/');
  if (n !== rel || n === '.' || n.split('/').some((p) => p === '..' || p === '' || p === '.')) return null;
  const top = n.split('/')[0]!;
  if (NOT_JOURNALLED.has(top) || (!n.includes('/') && DB_FILE.test(n)) || TMP.test(n)) return null;
  return n;
}

export class SyncLog {
  readonly home: string;
  #db: Db;
  #log: Log;
  #clock: HybridClock;
  #now: () => Date;
  // The journal: what each file was when last looked at, and what the log says it is.
  #seen = new Map<string, { mtimeMs: number; size: number; sha: string }>();
  #logged: Map<string, string> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #watcher: FSWatcher | null = null;
  #soon: ReturnType<typeof setTimeout> | null = null;
  #columns = new Map<string, Set<string>>();
  // Set by the core once the vault exists; without it, secrets simply don't replicate.
  vault: VaultSync | null = null;
  // Tables other than memory whose deletes are forgetting (capture_event, M6a): on a standby, the
  // deleted rows are handed here after the commit, so the rest of a forget (backups) happens here too.
  forgetting = new Map<string, (rows: Record<string, unknown>[]) => void>();

  constructor(o: { db: Db; log: Log; home: string; node: string; now: () => Date }) {
    this.#db = o.db;
    this.#log = o.log;
    this.home = o.home;
    this.#now = o.now;
    this.#clock = new HybridClock({ node: o.node, now: () => o.now().getTime() });
  }

  // ---- this node's side ------------------------------------------------------------------------

  logging(): boolean {
    return this.#db.get<{ logging: number }>('SELECT logging FROM sync_state WHERE id = 1')?.logging === 1;
  }

  // On for a hub, off for a standby (which copies the hub's entries instead of making its own).
  setLogging(on: boolean): void {
    this.#db.run('UPDATE sync_state SET logging = ? WHERE id = 1', on ? 1 : 0);
  }

  // This node's schema version, which a standby tells the hub when it pulls (ADDED_COLUMNS).
  schema(): number {
    return this.#db.version();
  }

  head(): number {
    return this.#db.get<{ s: number | null }>('SELECT MAX(seq) AS s FROM sync_log')?.s ?? 0;
  }

  // ---- the hub serves the log ------------------------------------------------------------------

  // Entries after `after`, oldest first, up to `limit` entries or about `maxBytes`. `upto` is the
  // seq the reader may move its cursor to: the last entry sent, or the head when nothing is left.
  batch(after: number, o: { limit?: number; maxBytes?: number; peerSchema?: number | null } = {}): Batch {
    const drop = columnsAfter(Number.isInteger(o.peerSchema) ? o.peerSchema! : UNSTATED_SCHEMA);
    const fit = (r: LogRow): LogRow => {
      const cols = r.op === 'put' && r.row ? drop.get(r.tbl) : undefined;
      if (!cols) return r;
      const row = JSON.parse(r.row!) as Record<string, unknown>;
      for (const c of cols) delete row[c];
      return { ...r, row: JSON.stringify(row) };
    };
    const limit = o.limit ?? 500;
    const maxBytes = o.maxBytes ?? 4 * 1024 * 1024;
    const head = this.head();
    const rows: LogRow[] = [];
    let bytes = 0;
    for (const r of this.#db.raw.prepare('SELECT seq, tbl, pk, op, row, hlc FROM sync_log WHERE seq > ? ORDER BY seq LIMIT ?').iterate(after, limit + 1) as Iterable<LogRow>) {
      if (rows.length >= limit || (rows.length && bytes + (r.row?.length ?? 0) > maxBytes)) return { rows, upto: rows.at(-1)!.seq, more: true, head };
      rows.push(r.tbl === VAULT && r.op === 'put' ? { ...r, row: this.#withKey(r.row!) } : fit({ ...r }));
      bytes += r.row?.length ?? 0;
    }
    return { rows, upto: Math.max(after, head), more: false, head };
  }

  // The standby said it has everything up to `seq`.
  ack(seq: number): void {
    if (!Number.isInteger(seq) || seq < 0) throw new CoreError('validation', 'seq must be a whole number.');
    this.#db.run('UPDATE sync_state SET acked_seq = MAX(acked_seq, ?), acked_at = ? WHERE id = 1', Math.min(seq, this.head()), this.#now().toISOString());
  }

  // How far the standby is behind: entries it hasn't acknowledged, and for how long it hasn't
  // acknowledged anything while there was something to take (counted from `notBefore`, when it was
  // approved, at the earliest). A standby that keeps acknowledging is catching up, not behind.
  lag(notBefore = 0): Lag {
    const s = this.#db.get<{ acked_seq: number; acked_at: string | null }>('SELECT acked_seq, acked_at FROM sync_state WHERE id = 1')!;
    const head = this.head();
    const rows = this.#db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sync_log WHERE seq > ?', s.acked_seq)!.n;
    const base = Math.max(s.acked_at ? Date.parse(s.acked_at) : 0, notBefore);
    const seconds = rows ? Math.max(0, Math.round((this.#now().getTime() - base) / 1000)) : 0;
    return { head, acked_seq: s.acked_seq, acked_at: s.acked_at, rows, seconds, behind: rows > 0 && seconds > BEHIND_AFTER_S };
  }

  // A new standby starts from nothing: what an earlier one acknowledged says nothing about it.
  resetAck(): void {
    this.#db.run('UPDATE sync_state SET acked_seq = 0, acked_at = NULL, behind_since = NULL WHERE id = 1');
  }

  // ---- the journal: the home's files -----------------------------------------------------------

  // Looks at the home now and records what changed since the last look. Only a node that is
  // logging (the hub) journals.
  scan(): { put: string[]; deleted: string[] } {
    const put: string[] = [];
    const deleted: string[] = [];
    if (!this.logging()) return { put, deleted };
    this.#scanVault();
    const logged = this.#loggedFiles();
    const present = new Set<string>();
    // What the person was already told is too big to carry, from the open problems themselves, so a
    // restart doesn't tell them again; it closes once the file fits again or is gone.
    const told = new Map<string, number>();
    for (const p of this.#log.problems({ open: true })) {
      const m = p.source === 'sync' ? TOO_BIG.exec(p.message) : null;
      if (m) told.set(m[1]!, p.id);
    }
    const big = new Set<string>();
    const writes: { path: string; data: Buffer | null }[] = [];
    const walk = (rel: string) => {
      let entries;
      try { entries = readdirSync(rel ? join(this.home, rel) : this.home, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!rel && NOT_JOURNALLED.has(e.name)) continue;
          walk(r);
          continue;
        }
        if (!e.isFile() || !journalPath(r)) continue;
        let st;
        try { st = lstatSync(join(this.home, r)); } catch { continue; }
        if (st.size > MAX_FILE_BYTES) {
          big.add(r);
          if (!told.has(r)) {
            // A copy the standby already has would go stale: it is told to drop it (the file_delete
            // below, since the file isn't counted as present), so it never serves old content.
            const had = logged.has(r);
            told.set(r, this.#log.problem('sync', `${r} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB, so the standby doesn’t get a copy of it${had ? '; its older copy there was removed, so it doesn’t keep stale content' : ''}. If the hub failed, it wouldn’t be on the new hub.`).id);
          }
          continue;
        }
        present.add(r);
        const known = this.#seen.get(r);
        if (known && known.mtimeMs === st.mtimeMs && known.size === st.size && logged.get(r) === known.sha) continue;
        let data: Buffer;
        try { data = readFileSync(join(this.home, r)); } catch { present.delete(r); continue; }
        const sha = sha256(data);
        this.#seen.set(r, { mtimeMs: st.mtimeMs, size: st.size, sha });
        if (logged.get(r) !== sha) writes.push({ path: r, data });
      }
    };
    walk('');
    for (const [path, id] of told) if (!big.has(path)) this.#log.resolve(id);
    for (const path of logged.keys()) if (!present.has(path)) writes.push({ path, data: null });
    if (!writes.length) return { put, deleted };
    this.#db.tx(() => {
      for (const w of writes) {
        this.#db.run('DELETE FROM sync_log WHERE tbl = ? AND pk = ?', FILE, w.path);
        if (w.data) {
          const text = w.data.toString('utf8');
          const row: FileRow = { path: w.path, sha256: sha256(w.data), size: w.data.length, ...(Buffer.from(text, 'utf8').equals(w.data) ? { text } : { b64: w.data.toString('base64') }) };
          this.#db.run('INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES (?, ?, ?, ?, ?)', FILE, w.path, 'file_put', JSON.stringify(row), this.#clock.tick());
          logged.set(w.path, row.sha256);
          put.push(w.path);
        } else {
          this.#db.run('INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES (?, ?, ?, NULL, ?)', FILE, w.path, 'file_delete', this.#clock.tick());
          logged.delete(w.path);
          this.#seen.delete(w.path);
          deleted.push(w.path);
        }
      }
    });
    return { put, deleted };
  }

  // Scans every few seconds, and soon after anything in the home changes.
  startJournal(everyMs = 3000): void {
    if (this.#timer) return;
    const run = () => {
      try { this.scan(); } catch (e) { this.#log.problem('sync', 'Nova couldn’t record changes to its files for the standby.', { detail: (e as Error)?.stack ?? String(e) }); }
    };
    this.#timer = setInterval(run, everyMs);
    this.#timer.unref();
    try {
      this.#watcher = watch(this.home, { recursive: true }, (_, name) => {
        const top = String(name ?? '').split(/[\\/]/)[0] ?? '';
        if (NOT_JOURNALLED.has(top) || DB_FILE.test(top)) return;
        this.#soon ??= setTimeout(() => { this.#soon = null; run(); }, 250);
      });
      this.#watcher.on('error', () => { this.#watcher?.close(); this.#watcher = null; });
    } catch { /* no file watching here: the interval still runs */ }
    run();
  }

  stopJournal(): void {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#soon) clearTimeout(this.#soon);
    this.#watcher?.close();
    this.#timer = null;
    this.#soon = null;
    this.#watcher = null;
  }

  // Called when the vault changes, so the standby has it now rather than at the next scan (file
  // watching skips vault/, as it skips every folder that isn't journalled).
  vaultChanged(): void {
    if (this.logging()) this.#scanVault();
  }

  // The vault's entry follows its file: a new one when the ciphertext changed, a delete when it went.
  #scanVault(): void {
    if (!this.vault) return;
    const text = this.vault.sealedFile();
    const had = this.#db.get<{ sha: string | null; op: string }>(`SELECT json_extract(row, '$.sha256') AS sha, op FROM sync_log WHERE tbl = ? AND pk = ?`, VAULT, VAULT);
    const sha = text === null ? null : sha256(Buffer.from(text, 'utf8'));
    if (sha === null ? !had || had.op === 'delete' : had?.sha === sha) return;
    this.#db.tx(() => {
      this.#db.run('DELETE FROM sync_log WHERE tbl = ? AND pk = ?', VAULT, VAULT);
      this.#db.run('INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES (?, ?, ?, ?, ?)', VAULT, VAULT, sha ? 'put' : 'delete', sha ? JSON.stringify({ sha256: sha, file: text }) : null, this.#clock.tick());
    });
  }

  // Only while serving a batch: the key rides inside the sealed payload, never in the log.
  #withKey(row: string): string {
    const key = this.vault?.keyForStandby() ?? null;
    return key ? JSON.stringify({ ...(JSON.parse(row) as object), key }) : row;
  }

  #loggedFiles(): Map<string, string> {
    if (!this.#logged) {
      this.#logged = new Map();
      for (const r of this.#db.all<{ pk: string; sha: string | null }>(`SELECT pk, json_extract(row, '$.sha256') AS sha FROM sync_log WHERE tbl = ? AND op = 'file_put'`, FILE)) {
        if (r.sha) this.#logged.set(r.pk, r.sha);
      }
    }
    return this.#logged;
  }

  // ---- forgetting (standing order 4) -----------------------------------------------------------

  // A memory was forgotten. Its own entries are already gone (the delete replaced them), and the
  // files that showed it (MEMORY.md, the day notes) were written again by now, so a scan replaces
  // their entries too. Anything still carrying the words in memory's own entries or those files is
  // then removed outright. Returns how many entries were removed that way.
  forgotten(contents: string[]): number {
    this.scan();
    const needles = new Set<string>();
    for (const c of contents) {
      const t = String(c ?? '').trim();
      if (!t) continue;
      for (const v of [t, t.replace(/\s+/g, ' ')]) needles.add(JSON.stringify(v).slice(1, -1));
    }
    let removed = 0;
    try {
      this.#purge(needles, (n) => { removed += n; });
    } finally {
      // The replaced entries' old pages leave the write-ahead log now.
      if (this.#db.path !== ':memory:') this.#db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }
    return removed;
  }

  #purge(needles: Set<string>, count: (n: number) => void): void {
    for (const n of needles) {
      const hit = this.#db.all<{ seq: number; tbl: string; pk: string }>(
        `SELECT seq, tbl, pk FROM sync_log WHERE (tbl = 'memory' OR (tbl = ? AND (pk = 'MEMORY.md' OR pk LIKE 'memory/%'))) AND instr(row, ?) > 0`, FILE, n,
      );
      for (const h of hit) {
        this.#db.run('DELETE FROM sync_log WHERE seq = ?', h.seq);
        if (h.tbl === FILE) { this.#logged?.delete(h.pk); this.#seen.delete(h.pk); }
        count(1);
      }
    }
  }

  // ---- the standby applies -----------------------------------------------------------------------

  cursor(): number {
    return this.#db.get<{ cursor: number }>('SELECT cursor FROM sync_state WHERE id = 1')!.cursor;
  }

  // On a standby whose hub went back to a checkpoint (M7 amendment §1): everything it copied goes,
  // the files the log put here included, and it reads the hub's log again from the start. Rows the
  // restore undid are rolled back here too, not forgotten: no backups are cleaned for them.
  fresh(): { rows: number; files: number } {
    let rows = 0;
    let files = 0;
    for (const r of this.#db.all<{ pk: string }>(`SELECT pk FROM sync_log WHERE tbl = ? AND op = 'file_put'`, FILE)) {
      const rel = journalPath(r.pk);
      if (rel) { rmSync(join(this.home, rel), { force: true }); files++; }
    }
    const hadVault = !!this.#db.get(`SELECT 1 FROM sync_log WHERE tbl = ? AND op = 'put'`, VAULT);
    this.#db.raw.exec('PRAGMA foreign_keys = OFF');
    try {
      this.#db.tx(() => {
        for (const t of Object.keys(REPLICATED)) {
          rows += this.#db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${t}"`)?.n ?? 0;
          this.#db.run(`DELETE FROM "${t}"`);
        }
        this.#db.run('DELETE FROM sync_log');
        this.#db.run('UPDATE sync_state SET cursor = 0 WHERE id = 1');
      });
    } finally {
      this.#db.raw.exec('PRAGMA foreign_keys = ON');
    }
    if (hadVault) this.vault?.clear();
    this.#logged = null;
    this.#seen.clear();
    if (this.#db.path !== ':memory:') this.#db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { rows, files };
  }

  // Applies the hub's entries in one transaction and keeps them, with the hub's seq, in this node's
  // own log, so that after a promotion this node can serve a new standby the same way. Files are
  // written as they come (writing one again is harmless), so a crash part-way repeats, never skips.
  // A memory the hub deleted was forgotten there: `forgotten` gets the records, after the commit,
  // to forget them here the same way (backups included).
  apply(batch: { rows: LogRow[]; upto: number }, forgotten: (records: Record<string, unknown>[]) => void): { applied: number; files: number } {
    const rows = batch.rows;
    for (const r of rows) this.#check(r);
    const gone: Record<string, unknown>[] = [];
    const others = new Map<string, Record<string, unknown>[]>();
    let files = 0;
    // Entries that may have carried a forgotten memory's words: once replaced, the old pages are
    // folded out of the write-ahead log at once, not whenever SQLite would.
    let scrub = false;
    // The hub's order already satisfies its own foreign keys; entries arrive newest-per-row, so a
    // child can come before the row it points at. Checks are off only while applying.
    this.#db.raw.exec('PRAGMA foreign_keys = OFF');
    try {
      this.#db.tx(() => {
        for (const r of rows) {
          if (r.tbl === 'memory' || this.forgetting.has(r.tbl) || (r.tbl === FILE && (r.pk === 'MEMORY.md' || r.pk.startsWith('memory/')))) scrub = true;
          let stored = r.row;
          if (r.tbl === VAULT) stored = this.#applyVault(r);
          else if (r.op === 'put') this.#put(r.tbl, JSON.parse(r.row!) as Record<string, unknown>);
          else if (r.op === 'delete') {
            if (r.tbl === 'memory') {
              const rec = this.#db.get<Record<string, unknown>>('SELECT * FROM memory WHERE id = ?', r.pk);
              if (rec) gone.push(rec);
            } else if (this.forgetting.has(r.tbl)) {
              const keys = REPLICATED[r.tbl]!;
              const values = keys.length === 1 ? [r.pk] : (JSON.parse(r.pk) as (string | number)[]);
              const rec = this.#db.get<Record<string, unknown>>(`SELECT * FROM "${r.tbl}" WHERE ${keys.map((k) => `"${k}" = ?`).join(' AND ')}`, ...values);
              if (rec) others.set(r.tbl, [...(others.get(r.tbl) ?? []), rec]);
            }
            this.#delete(r.tbl, r.pk);
          } else if (r.op === 'file_put') { this.#writeFile(JSON.parse(r.row!) as FileRow); files++; }
          else { this.#removeFile(r.pk); files++; }
          this.#db.run('DELETE FROM sync_log WHERE tbl = ? AND pk = ?', r.tbl, r.pk);
          this.#db.run('INSERT INTO sync_log (seq, tbl, pk, op, row, hlc) VALUES (?, ?, ?, ?, ?, ?)', r.seq, r.tbl, r.pk, r.op, stored, r.hlc);
        }
        this.#db.run('UPDATE sync_state SET cursor = MAX(cursor, ?) WHERE id = 1', batch.upto);
      });
    } finally {
      this.#db.raw.exec('PRAGMA foreign_keys = ON');
    }
    if (scrub && this.#db.path !== ':memory:') this.#db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    if (gone.length) forgotten(gone);
    for (const [tbl, recs] of others) {
      try { this.forgetting.get(tbl)!(recs); } catch (e) { this.#log.problem('sync', `Nova couldn’t finish forgetting what the hub deleted from ${tbl} here.`, { detail: (e as Error)?.stack ?? String(e) }); }
    }
    return { applied: rows.length, files };
  }

  // Refuses an entry that names a table, column, op or path this node doesn't replicate.
  #check(r: LogRow): void {
    const bad = (why: string) => { throw new CoreError('validation', `The hub sent a sync entry Nova can’t apply (${why}).`); };
    if (!r || typeof r !== 'object' || !Number.isInteger(r.seq) || r.seq < 1 || typeof r.pk !== 'string' || typeof r.hlc !== 'string') bad('malformed');
    if (!OPS.includes(r.op)) bad(`op ${String(r.op)}`);
    if (r.tbl === VAULT) {
      if (!this.vault || r.pk !== VAULT || (r.op !== 'put' && r.op !== 'delete')) bad('vault');
      if (r.op === 'put') {
        const v = JSON.parse(String(r.row)) as { sha256?: unknown; file?: unknown };
        if (typeof v.file !== 'string' || v.sha256 !== sha256(Buffer.from(v.file, 'utf8'))) bad('vault');
      }
      return;
    }
    if (r.op === 'file_put' || r.op === 'file_delete') {
      if (r.tbl !== FILE || !journalPath(r.pk)) bad(`file ${r.pk}`);
      if (r.op === 'file_put') {
        const f = JSON.parse(String(r.row)) as FileRow;
        if (f.path !== r.pk || typeof f.sha256 !== 'string' || (typeof f.text !== 'string' && typeof f.b64 !== 'string')) bad(`file ${r.pk}`);
      }
      return;
    }
    if (!Object.hasOwn(REPLICATED, r.tbl)) bad(`table ${r.tbl}`);
    if (r.op === 'put') {
      const row = JSON.parse(String(r.row)) as Record<string, unknown>;
      const cols = this.#cols(r.tbl);
      for (const [k, v] of Object.entries(row)) {
        // A column this node doesn't have yet (the hub is a release ahead) is left out when the row
        // is applied, and said once; the rest of the batch goes on. Its name must still be a name.
        if (!cols.has(k)) { if (!/^[a-z_][a-z0-9_]{0,63}$/.test(k)) bad(`column ${r.tbl}.${k}`); continue; }
        if (v !== null && typeof v !== 'string' && typeof v !== 'number') bad(`value of ${r.tbl}.${k}`);
      }
      // Only a row that is this table's row plus new columns (a newer release's) is taken that way:
      // one missing any of this node's columns is refused, as before.
      const extra = Object.keys(row).filter((k) => !cols.has(k));
      if (extra.length && [...cols].some((c) => !Object.hasOwn(row, c))) bad(`column ${r.tbl}.${extra[0]}`);
    }
  }

  // The hub's vault and its key: the key goes into this node's own key store (vault.ts), and the
  // entry is kept without it, so this node's log never holds the key either.
  #applyVault(r: LogRow): string | null {
    if (r.op === 'delete') { this.vault!.clear(); return null; }
    const { key, ...rest } = JSON.parse(r.row!) as { sha256: string; file: string; key?: string };
    if (typeof key === 'string') this.vault!.adopt(rest.file, key);
    else this.#log.problem('sync', 'The hub’s vault arrived without its key, so connections that need a secret wouldn’t sign in after a failover. Nova keeps trying with the next change.');
    return JSON.stringify(rest);
  }

  #cols(tbl: string): Set<string> {
    let c = this.#columns.get(tbl);
    if (!c) {
      c = new Set(this.#db.all<{ name: string }>(`PRAGMA table_info("${tbl}")`).map((x) => x.name));
      this.#columns.set(tbl, c);
    }
    return c;
  }

  #skipped = new Set<string>();

  #put(tbl: string, row: Record<string, unknown>): void {
    const known = this.#cols(tbl);
    const cols = Object.keys(row).filter((c) => known.has(c));
    for (const c of Object.keys(row)) {
      if (known.has(c) || this.#skipped.has(`${tbl}.${c}`)) continue;
      this.#skipped.add(`${tbl}.${c}`);
      // Recorded as a problem: the person should update this standby.
      this.#log.problem('sync', `The hub sent ${tbl}.${c}, which this standby doesn’t have yet: it is a release behind. That column is left out of its copy until it is updated.`);
    }
    this.#db.run(
      `INSERT OR REPLACE INTO "${tbl}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      ...cols.map((c) => row[c] as string | number | null),
    );
  }

  #delete(tbl: string, pk: string): void {
    const keys = REPLICATED[tbl]!;
    const values = keys.length === 1 ? [pk] : (JSON.parse(pk) as (string | number)[]);
    this.#db.run(`DELETE FROM "${tbl}" WHERE ${keys.map((k) => `"${k}" = ?`).join(' AND ')}`, ...values);
  }

  #writeFile(f: FileRow): void {
    const data = typeof f.text === 'string' ? Buffer.from(f.text, 'utf8') : Buffer.from(String(f.b64), 'base64');
    if (sha256(data) !== f.sha256) throw new CoreError('validation', `The hub sent ${f.path}, but it arrived damaged.`);
    const abs = join(this.home, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = `${abs}.nova-sync-${process.pid}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, abs);
  }

  #removeFile(path: string): void {
    rmSync(join(this.home, path), { force: true });
  }
}
```
