# Nova Vault and the Credential Broker (ADR)

**Sources:**
- The owner's design input, approved 2026-10-31: `docs/builder-packet/nova-vault-broker-design-2026-10-31.md` (cited below as "the design note").
- The owner's instruction that came with it, 2026-10-31 (binding; cited below as "the instruction"). It requires:
  - this ADR first, as a docs-only PR;
  - the broker as a separate minimal component with seven fixed verbs, origin binding, and policy checked on its own authority;
  - local IPC only, and ledger entries that carry ref, target and outcome;
  - the three phases in order, and the tiers;
  - the Phase 1 gate evidence;
  - the honest-claims rule.
- `docs/builder-packet/INPUT-2026-10-31-ORCHESTRATION-DECISIONS.md`, Decision 5: no vault-key escrow, and backups never contain keys.
- AMENDMENT-2026-10-31-B Part 6 (canary-secret tests); AMENDMENT-2026-10-30-C Part 3 (ingest gate) and Part 4 (logins injected at use time; passwords never in model context).
- ARCHITECTURE-AND-DECISIONS: ADR-1, ADR-2, ADR-3, ADR-9, ADR-10, ADR-11. NOVA-SPEC §6 (tiers) and §8. CONTRACTS §4. EXTENSION-MODEL. OPERATING-RULES.
- `docs/plans/M10-orchestration.md` Point 8; M10b (merged); M10d (PR #241, open) and M10e (PR #247, open), read from their branches.

**Status:** this is the design, and nothing in it is built yet. The design note asks for each phase to be ADR-gated:
- This document is the ADR for the broker and Phase 1.
- Phases 2 and 3 each get a short ADR of their own before they are built.

**Tier numbers** follow NOVA-SPEC §6:
- 0: silent;
- 1: act and report, with undo;
- 2: ask first;
- 3: explicit confirmation every time.

## Owner decisions (2026-10-31)

The owner decided this ADR's conflicts and open questions the same day, verbatim in `docs/builder-packet/INPUT-2026-10-31-VAULT-BROKER-DECISIONS.md`. These govern wherever the text below proposed otherwise.
- **Conflicts row 2, sync:** a wrap sealed to a specific holder device's broker key MAY travel in sync. It is unusable anywhere else, so it isn't an "unlock key" in the rule's sense. The rule, restated precisely: **no passphrase, recovery key or device unlock key ever moves, and no key material ever moves in a form another device can use.** Sealed per-device wraps are the one allowed exception, recorded as such.
- **Conflicts row 3, language: an ADR-2 exception, approved.** TypeScript now, with the size budget and the narrowing of Node's permission model as proposed. The Rust port stays the stated end state under ADR-2. It is revisited at Phase 2 or at the first external security review, whichever comes first. This is an exception, not a change to ADR-2.
- **Conflicts row 4, Nova's own keys:** they stay in core, out of the broker's scope for Phase 1, with the plain statement as drafted. They are Nova's data and identity keys, not user credentials. Growing sign or encrypt verbs for core would break the fixed-verb discipline that makes the broker auditable.
- **Open questions 1–5:** the proposed defaults are accepted.
  1. seven verbs, delete as `update(remove)`, `sealed` and `oauth` as sources, `unlock` and `lock` as protocol messages that return no value;
  2. separate-user mode offered at install on a Linux or macOS hub (tier 3), same-user elsewhere with the plain notice;
  3. "no network surface": nothing inbound, and outbound only during a `use`, to the bound origin;
  4. passkey approvals required for `bind`, `share_scope` and external connections where WebAuthn works, with core-relayed approval as the fallback, stated in Settings;
  5. placement: a side track after M10e. M10h ships with no credential on a spoke if Phase 1 isn't merged.
- **Open question 6, showing a value: modified.**
  - **What stands:** never through a verb, never to core or any model.
  - **What changes:** the owner may reveal a Nova Vault value **on the device's own screen**, through a UI the broker renders, gated by passkey or biometric. It is tier 3 and hides itself again automatically, the same precedent as the backup recovery key.
  - **Why:** a vault that can never show its owner a password traps them the first time they need that login outside Nova. The reveal path keeps the value out of every API without locking the owner out of their own credentials.
  - Nothing else about question 6 changes.

## Decision

Nova gets a **Credential Broker**: a small process of its own on each device that holds credentials. It answers seven fixed verbs, plus three protocol messages that return no value (§4). Nova core, every model, chat, memory, logs and the Work Ledger work with refs and metadata. The broker checks bindings, sensitivity class and approval itself, and refuses on its own authority. Behind it sit pluggable backends:
- **Nova Vault**, built in and the default (Phase 1);
- **1Password** (Phase 2);
- an **optional Vaultwarden** and further connectors, by demand (Phase 3).

It is built **from what exists**, not beside it:

| Need | Built on | New |
|---|---|---|
| The store | `src/core/vault.ts`: one AES-256-GCM file, **UNPROVEN** (no eval yet: `claim.vault-encrypted-at-rest`) the key in the OS keychain or a key file, `secret://` names | Per-item encryption, an Argon2id-wrapped root key, device unlock. The code that reads values moves out of core into the broker |
| Supervision | `src/supervisor/supervisor.ts`: one child, restarts with backoff, safe mode, a 0600 `control.sock` | A second child, the broker, started before the Nova server |
| A fixed-verb privileged part | The boot agent (ADR-3) and Decision 1's five verbs | The same pattern, for credentials |
| Injection at use | M10b's `#login` in `browser/worker.ts`; M10d's `toolEnv` (`infra/tool.ts`) and `httpConfig` (`network/targets.ts`) | The same injections, done inside the broker or its launcher |
| Redaction | `redactText` and `addSecretValue` in `log.ts`; the `Redactor` in `browser/logins.ts` | Exact-value scrubbing at the broker's edges. Core keeps its rules based on key names |
| Replication | The `vault` entry in `mesh/sync.ts` (ciphertext, plus the key in the sealed batch) | Item blobs, with the root key wrapped per holder device |
| Backups | `resilience/backup.ts`: the vault file goes in, the key stays out | Item blobs go in; every key and wrap stays out |
| Approvals | Tier-3 `confirm`, `access: 'approver'` routes | Approvals the broker verifies itself (§7) |

## The claim, worded exactly

The honest-claims rule governs every sentence here and every sentence of user-facing copy built from it.
- **The capability:** within Nova, the capability to read a credential's value exists only inside the broker. "The broker" means two things, and both run only the broker's code from the same signed release:
  - the broker process;
  - the broker's launcher (§3), for a program it hands a credential to.
- **Where a value goes:** it leaves the broker only toward the bound target it is used on. That is a page on the bound origin, a request to the bound host, or a program's environment at spawn. The target then has it: a site can use what it is given on its own pages, and a program can do what it likes with its own credential.
- **What Nova's own parts are given:** refs and metadata only. That covers core, models, chat, memory, logs, the Work Ledger, receipts, backups and the sync log.
- **External managers (Phase 2):** their automation access gives the connecting process read access by design. In Nova, that process is the broker, so the read capability exists only inside the broker process.
- **Never claimed:** "Nova can never read your passwords", "your passwords never leave the vault", or "impossible". The design note's "structurally impossible" is replaced by the wording above (Conflicts row 1).
- **The scope of the claim:**
  - It covers the credentials Nova keeps in Nova Vault or reaches in an external manager.
  - Two kinds of secret sit outside it in Phase 1, both stated where they come up: Nova's own keys (§9 row 15, Conflicts row 4), and secrets inside a device's own configuration that Nova reads (§9, Limits).
  - It is about Nova's own components. In same-user mode (§3), a program running as the person's OS account can reach what the broker reaches. Settings says so plainly, as `FILE_KEY_NOTICE` does today.

## 1. Threat model and trust boundary

```
person ── console (served by core) ──┐  sealed values, signed approvals (ciphertext through core)
models ── core: refs and metadata ───┼── local IPC ──▶ broker ──▶ the bound target only
           supervisor (start, tickets)┘                  │
                                                         └── store: item blobs (ciphertext)
```

**What the broker protects against:**
- **A model,** local or cloud, asking for a credential, echoing one or spending one. Models hold refs. The broker refuses any target a credential isn't bound to, and any action without the approval its tier needs.
- **Prompt injection** in pages, mail, files or tool output. Inside a standing consent's scope (§6), injection can cause uses the person already allowed, and each is recorded. Outside it, injection can at worst raise an approval card the person declines. Approval requests are rate-limited, so they can't wear the person down (§7).
- **Bugs in core.** A log line, an error message, a receipt, a transcript, a memory write, a diagnostics bundle or a backup has no credential's value to carry, because core is given none. The exceptions are the two kinds of secret named under "The claim".
- **Storage elsewhere:** backups, the sync log, the home's git history and a cloud relay hold ciphertext. The keys that open it are never there.
- **One backend's credential leaking:** a stolen 1Password service-account token opens that backend's shared scope, not Nova Vault.

**What it doesn't protect against, said plainly:**
- **A compromised OS account.** Code running as the person can reach the key store, and the broker's memory where the OS allows it. That includes malware, and in same-user mode any program, even a command the person approves through Nova's `exec` tool.
  - Separate-user mode narrows this for programs running as the person.
  - It does nothing against an administrator.
- **The person's own unlock.** Whoever holds the passphrase, the recovery key or an unlocked holder device can do what the person can.
- **A compromised broker or unlocked device.** For the scope it holds, that is game over (the design note). This is why the broker is small, fixed-verb and updated only through signed releases.
- **The target itself.** A bound site or program holds the value it was given.
- **Values a target hands back on a path the broker doesn't carry** (§9, Limits).
- **Phishing aimed at the person directly.**

## 2. Where secret values are today

Every place a value exists or flows on `main` (55fa6786) and in the open M10d and M10e PRs. "Core reads" means a module outside the vault gets the plaintext.

| # | Consumer | Where the value is, and who reads it |
|---|---|---|
| 1 | The vault | `src/core/vault.ts`: all values in one AES-256-GCM file `home/vault/secrets.json`. **UNPROVEN** (no eval yet: `claim.vault-encrypted-at-rest`) The 32-byte key is in the keychain (`secretToolKeyStore`, `macKeyStore`, `windowsKeyStore`) or `vault/key`, with `FILE_KEY_NOTICE`. `get`/`resolve` hand plaintext to any core caller, and every read and write calls `addSecretValue` |
| 2 | Redaction | `log.ts` keeps every vault value in `SECRET_VALUES` for `redactText`. That is used by `receipts.ts`, `self.ts`, and `changes/kinds.ts` (`carriesSecret` refuses a change carrying a value). There is also the browser's `Redactor` |
| 3 | The outbound guard | `core/index.ts` gives `wireIngest` every vault value (`secrets: () => vault.list().map(get)`), and `ingest/screen.ts` checks outbound text against them |
| 4 | Provider and model keys | `providerSecret` in `core/index.ts` reads `provider/<NAME>`; `PUT /vault/{name}` takes the value. The key becomes a `Bearer` header in `providers/openai.ts` (`resolveCfg`, `probe`), and is used for the cloud model in `models/index.ts` and adapter secrets in `providers/registry.ts`. A development fallback, `NOVA_SECRET_<NAME>` (`server.js`), puts values in core's environment |
| 5 | n8n | `providers/n8n.ts`: the signing secret computes `signatureHeader` outbound and `checkSignature` on callbacks |
| 6 | Connectors | `core/connectors/index.ts` gives each connector `ctx.secrets.get/put`. Home Assistant (`connectors/home-assistant.ts`) sends its token as a REST `Bearer` header and as the WebSocket `auth` message, and `tokenIssuer` parses it |
| 7 | Gmail | `src/connectors/gmail.js`: the OAuth client, the refresh token, the access token in memory (`this.access`), and `tokenRequest`. `gmail-imap.js` holds the app password and sends `LOGIN`. Era 2's plaintext files in `connectors/gmail/` are moved into the vault by core |
| 8 | Screenpipe | `capture/capture.ts` keeps the API key through `secrets`; `capture/screenpipe.ts` holds it as `#apiKey` and sends it as `Bearer` |
| 9 | Nova Browser sign-ins (M10b) | `PUT /browser/logins/{host}` leads to `saveLogin` (`browser/worker.ts`). `#login` reads the username and password and passes them as `Runtime.callFunctionOn` arguments over the CDP pipe, which core holds (`chromium.ts`, `--remote-debugging-pipe`). The session redactor reads every saved sign-in |
| 10 | M10d (PR #241) | A network target's token: `setToken`, then a `Bearer` header in `httpConfig`. Per-change seal keys (`#sealKey`) seal snapshots that hold the device's own secrets (Wi-Fi and VPN keys). Infra provider secrets (`setSecret`) go into OpenTofu's environment (`toolEnv`) and into `addSecretValue`. Generated passwords: `generatePassword` in `browser/logins.ts`, and the `new_password` and `create_account` steps with a `pending` part |
| 11 | M10e (PR #247) | Service definitions carry `secrets[]` names. Handing a value to a service is refused for now: "isn't built yet" |
| 12 | M10j (planned) | Per-cluster kubeconfigs (`secret://clusters/<id>/kubeconfig`), written to a 0600 file for one call; Flux's deploy key (Point 8) |
| 13 | Mesh replication | `mesh/sync.ts` sends the `vault` entry's ciphertext (`sealedFile`), and `#withKey` adds `keyForStandby()` to the batch, sealed to the standby. On the standby, `Vault.adopt` writes the key into the standby's own key store |
| 14 | Backups | `resilience/backup.ts` puts the vault file in and keeps `vault/key` and `mesh/identity.json` out. The backup key (`nova/backup-key`) and the seal key sit in the vault, and `resilience/index.ts` reads them. `POST /backups/recovery-key` shows the key again at tier 3. `restore.ts` copies the `nova/` keys into the restored vault, and `reset.ts` forgets the keys |
| 15 | Nova's own keys | The backup key and seal (row 14), M10d's per-change seal keys, the capture archive's keys (capture data path design), and the mesh identity private keys (`mesh/identity.ts`, not in the vault) |
| 16 | `exec` | `src/tools.js`: a shell command the person approves runs as the person. It can read `vault/key` or ask the keychain (CAPABILITY-INVENTORY, Secrets row) |
| 17 | Coding CLIs | The `claude` and `codex` adapters (`providers/builtins.ts`) use those tools' own sign-ins, which Nova's vault doesn't hold |

## 3. The broker process

### Start and supervision
**Same-user mode.** This is the default for development, the preview, WSL, and any device without an installer step.
- The supervisor starts the broker as a second child, before the Nova server, with the same restart backoff.
- Three crashes in a minute put the broker in safe mode: credentialed actions refuse in plain words ("Nova's vault isn't running"), and Health shows it with a playbook.
- The broker is never core's child. Where the OS limits process tracing to a process's own descendants, core can't trace it, and nor can anything core starts.

**Separate-user mode** (proposed for a hub install on Linux and macOS; an owner decision, Open question 2).
- The broker runs as an OS service under its own account: a systemd unit with `User=` and `LimitCORE=0`, or a launchd daemon. The installer sets it up at tier 3.
- The supervisor doesn't start it; it watches its health over IPC.
- Programs running as the person, `exec` included, can no longer read the store or the device unlock key.

**With M10e.** The broker is a service definition on the supervisor driver only, never on K3s or in a cluster, because it belongs to its device.
- Promoting it is tier 3, under M10e's own rule for anything with secrets.
- Its release is a signed artifact through the ADR-9 pipeline.
- On a spoke, when M10h needs one, the boot agent starts it as a hub-signed workload with Decision 1's verbs.

**Hardening** follows the runtime agent's `runtimeCommand` (`device/boot.ts`):
- an empty environment, so no `NODE_OPTIONS` or proxy variables get in;
- Node's permission model, with reads and writes narrowed to the broker's folder and its launcher;
- `--disable-sigusr1`, no inspector, and diagnostics confined to its own folder.

Network access and child processes stay allowed, because `use` and the keychain CLIs need them.

### IPC
- **Linux and macOS:** a Unix-domain socket in a 0700 folder.
  - Same-user mode: `<home>/broker/run/broker.sock`.
  - Separate-user mode: a folder owned by the broker's account and shared with the person's group.
- **Windows:** a named pipe. Like the vault's Windows key store, it is untested on real Windows.
- **Frames:** newline-delimited JSON with a size cap and an id per request. There is no shell and no eval, and unknown fields are refused.
- **Peer credentials:** Node's standard library doesn't expose `SO_PEERCRED`, `getpeereid` or a pipe client's process id.
  - Phase 1 relies on two things instead: the socket's file permissions decide who can connect, and caller tokens say who is calling.
  - A true peer-credential check needs a small native helper (Rust, under ADR-2). It is a proposed hardening step, not part of Phase 1, and the gate evidence says so.

### Who is calling
- **Core and the supervisor:** each gets a 256-bit token per boot.
  - The supervisor makes the tokens and gives each child its own over Node's IPC channel. Neither argv nor the environment carries them, because other programs running as the person can read those.
  - Separate-user mode: the broker writes core's token to a file only the person's account can read.
- **The launcher:** it presents a one-time ticket (below).
- **What a token gets its holder:** nothing beyond core's policy, because tokens identify a role and grant no authority of their own.
  - A program that steals core's token can make only the uses core could make: bound targets, within scopes, consents and rate caps.
  - It can't produce the approvals that tier 2 and 3 need, wherever approvals are signed by a passkey (§7).

### The launcher (programs that need a credential)
Some targets are programs: OpenTofu, `kubectl`, a managed service. For those, the value goes to the program through broker code, never through core or the supervisor.
1. The caller asks for `use(ref, target)`, and the broker answers with a one-time ticket. The ticket is random, bound to that ref and target, and expires after 60 seconds.
2. The caller starts the broker's launcher (`src/broker/launch.ts`) with the ticket instead of the program.
3. The launcher redeems the ticket over IPC. It checks the program's SHA-256 against the binding itself, then starts the program with the value in its environment or in a 0600 file inside a 0700 folder, which it removes on exit.
4. The launcher stays as the program's parent:
   - it scrubs the program's stdout and stderr of the value before passing them on;
   - it forwards signals;
   - it exits with the program's code.

A ticket redeemed twice is refused, and the refusal is a ledger alarm. So a stolen ticket shows up as a failed start.

### No network surface
**Inbound:** none. The broker listens on nothing but its IPC endpoint: no HTTP server, no inspector, no debug port.

**Outbound:** only inside a `use`, only to that use's bound origin.
- TLS is verified, against a pinned certificate where the binding pins one.
- Redirects aren't followed. No proxy settings are honoured.
- Addresses are resolved once, and a public name that resolves to a private or loopback address is refused unless the binding says LAN. These are `safe-fetch.js`'s and M10d's rules.

The instruction says "no network surface", and this reading is Open question 3. The design note's own verb, "inject into … an API call's auth header", needs the broker to finish the request: handing the header to core would hand it the value.

**Tested** (gate item 6):
- the broker's open sockets are listed from `/proc` on Linux at idle and after every verb, and none is an inet listener;
- a source check finds no `listen(` on a port and no `http.createServer`;
- stand-in servers count connections, and a `use` aimed at an unbound host makes none.

### Dependencies
- **Node's standard library only:**
  - `node:crypto`: AES-256-GCM, HKDF, ECDH, signature checks for passkeys, and `crypto.argon2` (present in Node 26, which `package.json` requires);
  - `node:net`, `node:https` and `fetch`, the built-in WebSocket client;
  - `node:child_process`, for the keychain CLIs and the launcher;
  - `node:fs`.
- **No npm runtime dependency.** The repo has none today.
- **Its own tree:** `src/broker/` imports nothing from `src/core/`, and a test checks this. Core imports only the client's types, and none of the client's methods returns a value.
- **A size budget,** checked in CI: proposed at no more than 3,000 lines of broker code, tests aside, so that one reviewer can read all of it.
- **Language:** TypeScript, against ADR-2's Rust for crypto and native components. See Conflicts row 3.

## 4. The seven verbs

No answer carries a value, a part of a value, its length, or a hash of it. The protocol has three more messages, and none of them returns a value either:
- `hello`: a token in, a role out;
- `unlock`: the person's factor, sealed;
- `lock`.

| Verb | In | Out | The broker's own checks | Tier |
|---|---|---|---|---|
| `list_refs` | an optional filter | Refs with metadata: name, kind, site or origin, username, bindings with scope and consent, class, created, last used, last rotated, health flags (weak, reused, old), backend. Also the vault's state (locked or not, unlock mode) | The caller's role | 0 |
| `use` | ref, target, request (for example method, path and body for http; argv for a process), an optional approval | An outcome. Per target kind: http and ws give the status and the scrubbed response; process gives a ticket; web gives fields typed and the page's origin; verify gives valid or not | Unlocked. The target matches a binding exactly (§5) and the request is inside its scope. Class, consent or a valid approval. Rate cap | 1 / 2 (§6) |
| `create` | metadata (kind, site or origin, username, class, generation policy) and a value source: `generate`, `sealed` (§10), `oauth` (a code exchanged with the broker's PKCE verifier) or `migrate` | ref and metadata | A valid approval. The metadata is well formed. The origin is canonical. A generated value comes from the CSPRNG under the policy | 3 |
| `update` | ref and a change: a new value (generated or sealed), metadata (including class), or `remove` | ref, version | A valid approval. `remove` destroys the item and rotates the root key (§10) | 3 |
| `rotate` | ref, then `commit` or `abandon` | ref, with a pending version that is then committed or dropped | A valid approval. The new value is generated inside the broker. The site-side step (typing it into the site's change form) is a separate, visible `use` | 3 |
| `bind` | ref, plus a target to add or remove, its request scope and its consent mode | ref, bindings | Adding: a valid approval, canonical form, flags for lookalikes, no wildcards. Removing: always allowed | 3 to add or widen; 2 when Nova proposes removing; at once when the person removes one |
| `share_scope` | backend and scope (which vaults or collections it exposes), or device and items (which holder devices hold which items) | the scope, in plain words | A valid approval. The scope is shown first | 3 |

**How approvals work.** A verb that needs approval answers `needs_approval` with a challenge (§7). The caller calls again with the signed answer. No extra verb is involved.

**Refusals** come from a fixed list: `not_bound`, `out_of_scope`, `needs_approval`, `approval_invalid`, `locked`, `class_policy`, `rate`, `unknown_ref`, `wrong_target_kind`. Each has plain words.

## 5. Targets and origin binding

A binding ties one ref to one target. **Matching is exact on the canonical form.** Nothing is implied: no wildcards, no subdomains, no parent domains.

| Kind | What it is | Canonical form | How the value is injected |
|---|---|---|---|
| `web` | A page in Nova Browser | `https://` plus the host as a lowercase A-label plus the port. `http` is allowed only for loopback, as `loginRefusal` does now | Typed into named fields by the browser relay (§9 row 9) |
| `http` | An API request | Origin plus scope (methods, path prefixes). Optionally a pinned certificate (LAN devices) | A header (Bearer, Basic or named), an HMAC signature (`sign`), or a check of one (`verify`) |
| `ws` | A WebSocket API | `wss://` origin plus scope | The first auth message, from a template |
| `stream` | A TLS service with a login command (IMAP) | host, port, protocol | The protocol's login command |
| `process` | A one-shot program | Absolute path plus the binary's SHA-256 | An env var or a 0600 file, through the launcher |
| `service` | A long-running workload | Service id plus artifact digest (an M10e definition) | Env or a file at spawn, through the launcher |
| `device` | A mesh device (from M10h) | Device id plus its enrolled key fingerprint | Sealed to that device's broker |

**Creating a binding** is a `bind` (or part of `create`), at tier 3. The card shows:
- the canonical form, with the Unicode name next to the A-label for an internationalised name;
- the request scope and the consent mode;
- any lookalike flags.

**Checking at use time.** These are the broker's own checks, made on what the broker itself sees:
- **Web pages:** the relay reads the frame's origin from Chromium's own events, not from anything core says. Before it types anything:
  - the field's frame must be on the bound origin;
  - the top-level page must be on the bound origin too, or on one the binding lists under `embed_on` (tier 3);
  - the form's destination must be the bound origin, or one the step declares, as M10b's `sends` does.

  If the page moves during the fill, the relay stops typing. This is M10b's `wrong-host` rule, moved into the broker.
- **Redirects:** `http` and `ws` targets never follow one. They already don't today: see `NO_REDIRECT` in the providers and M10d's `httpConfig`. A 3xx comes back to core as an outcome, and a request to the new address needs that origin bound. For a page, the check happens where the browser actually is at fill time, so a redirect before the fill is simply another origin, and is refused.
- **Subdomains:** a binding to `example.com` doesn't cover `login.example.com`, or the other way round. Each is its own binding. Phase 2 imports a manager's broader URL matches as exact origins, each one confirmed.
- **Lookalikes:** an internationalised name is compared as its A-label after URL parsing, so a homograph is a different string and never matches. At bind time the broker also flags:
  - mixed-script labels;
  - a host within a small edit distance of an existing binding;
  - an existing bound host used as a leading label (`example.com.attacker.test`).
- **Ports and schemes:** both are part of the origin. Default ports are normalised. `https` only, apart from loopback.
- **Devices on the LAN:** an IP literal or a private name is allowed only with a pinned certificate, or on loopback.
- **Programs:** the launcher hashes the binary before starting it. A new version of OpenTofu is a new digest, and re-binding it is tier 3, with the old and new version on the card. That is friction on purpose.

## 6. Sensitivity classes, standing consent and tiers

**Two classes:**
- **standard;**
- **sensitive:** banking and finance, email, admin, crypto, and any credential that unlocks other credentials (single sign-on, a password manager's service account, a cloud console, cluster admin, a router's admin).

**Setting the class.** It is set at `create`:
- the broker suggests one from the origin, using a small built-in list and words in the host name, and suggests sensitive when unsure;
- the person confirms it on the tier-3 card;
- it can be edited in Settings as an `update` (tier 3).

**Standing consent** belongs to a binding: a ref, a target, a request scope, a rate cap, and the approval that granted it. It is granted at tier 3, has no expiry by default, shows when it was last used, and can be revoked in one tap.

**The tiers,** as the instruction sets them:

| Action | Tier |
|---|---|
| `list_refs` | 0 |
| `use`: standard class, bound target, inside a standing consent's scope | 1. Done and reported in the ledger. A request that has gone can't be unsent, so the undo is revoking the consent, linked from the report |
| `use`: standard class, bound target, no standing consent or outside its scope | 2 |
| `use`: sensitive class | 2 by default: asked first, and the approval covers one task. Per-use approval if the person sets it: every use asks, every time |
| `use`: unbound target | Refused. No tier lifts this; the person binds it first (3) |
| `create`, `update` (including delete and class changes), `rotate` and its commit | 3 |
| `bind`: a new target, a wider scope, a standing consent | 3 |
| `bind`: removing or narrowing, or revoking consent | 2 when Nova proposes it; immediate when the person does it |
| `share_scope`: any change; connecting any external manager or Vaultwarden | 3 |
| Lock | The person, any time. Nova may lock at tier 1, for example on a security problem |
| Unlock | The person only, with their own factor |

## 7. Approval cards

**A card shows metadata only:**
- the verb, in plain words ("Use your sign-in for example.com", "Make a new password for example.com");
- the credential's name, site and username;
- the target in its canonical form, with the A-label for an internationalised name, and any lookalike flag;
- the request scope, and the class;
- the task (its ledger id and title) and which part of Nova asked (chat, a browser plan, an infra project);
- the tier, what approving does, and when the card expires.

**It never shows:**
- the value, its length or any part of it;
- a strength meter for a value the person entered;
- a hash of it.

**How the broker trusts an approval:**
1. The broker issues the challenge: an approval id; the digest of the canonical action (verb, ref, target, scope, class, and the metadata on the card); an expiry of 5 minutes; single use.
2. The person approves on a client:
   - **Preferred:** a passkey the person registered with the broker at vault setup signs the challenge (WebAuthn, with user verification). The client computes the digest from what it shows, and the broker checks it against its own pending action. So what the person approves is what the broker does.
   - WebAuthn needs a secure context: the hub's own screen (`localhost`) and an `https` mesh address qualify; a plain-`http` LAN address doesn't, and there the passkey option isn't offered.
3. **Fallback, where no passkey is registered:** the approval goes through core, the way every tier-3 confirmation does today (`confirm: true` from an `approver`).
   - The broker still checks the digest, the expiry, single use, and every binding rule.
   - The approval's authenticity then rests on core. Settings states which approval mode is active.
   - Whether `bind`, `share_scope` and external connections may ever use this fallback is Open question 4.

**Flood control.** At most a few pending broker approvals per task, and a cap per hour. Beyond that, requests are refused and a problem is raised: "something keeps asking to use your credentials".

## 8. Ledger and log records

**Every verb writes one record:**
- when, the device, the verb, the ref;
- the target in canonical form;
- the scope item: method and path template, never a query string;
- the outcome: `ok`, `refused:<code>` or `failed:<class>`;
- the tier, the approval or consent id, the task id, and the caller's role.

**A record never holds:**
- the value, any part of it, its length or any encoding of it;
- a hash or HMAC of it, or a strength score;
- request headers, bodies or query strings (they carry values);
- response bodies.

**Ids and the reuse check:**
- Item ids are random, never derived from a value.
- The "reused" health flag is worked out in the broker's memory at unlock. It is never stored and never logged, so no value-derived hash exists that could be guessed against.

**Where the records go:**
- The broker's own audit log is the authority: append-only, hash-chained, 0600, in its own folder.
- Core copies each record into the Work Ledger under its task. A gap between the two (core missed one) shows in Health.

**Core's logs:**
- `log.ts` keeps its key-name rule (`SECRET`).
- `SECRET_VALUES` has nothing left to hold, and is removed.
- Responses that reach core have already been scrubbed by the broker: of the exact values it used, and of their base64, base64url, hex, URL-encoded and JSON-escaped forms.

## 9. Each consumer under the broker

Rows match §2. "Size" is the change to existing code.

| # | Under the broker | Size |
|---|---|---|
| 1 | The broker's store replaces `vault.ts`. The decrypt path moves into `src/broker/`, and core's `Vault` becomes a client that returns refs and metadata | Larger: the core of Phase 1 |
| 2 | Core's value matching goes. Key-name rules stay. Scrubbing happens at the broker's edges (§8) | Small |
| 3 | The outbound guard loses its list of vault values and keeps its pattern checks (key shapes, high-entropy strings). A stated limit: it can't recognise an echoed value exactly | Small |
| 4 | `http` target bound to the provider's `base_url` origin, with scope set to the endpoints Nova calls. The broker sends the request, and a streamed response (SSE) flows back scrubbed. `NOVA_SECRET_<NAME>` is for tests only, and refused when the broker is on | Medium |
| 5 | `use` with `sign` (the broker computes the header and sends the request), and `verify` for callbacks, which returns valid or not | Small |
| 6 | `ctx.secrets.get` goes; connectors call `use`. Home Assistant gets an `http` target (scope: state reads at standing consent, service calls outside it, so tier 2, which matches its rule today) and a `ws` target for its event stream. The token's issuer is kept as metadata at entry, so revoking needs no value in core | Medium |
| 7 | OAuth: the broker holds the PKCE verifier, exchanges the code and keeps the refresh and access tokens. Gmail API calls are `http` uses. IMAP becomes a `stream` target whose prelude is `LOGIN`. Era 2's files are imported by the broker's migrate step | Medium. IMAP is the larger part; until it lands, the IMAP path can't meet the rule |
| 8 | `http` target bound to the source's origin. Capture polls often, so the cost of an IPC round trip per call is measured in the gate | Small |
| 9 | **The browser relay.** Chromium's debugging pipe is held by the broker's launcher in relay mode, not by core: core's worker starts the launcher, and the launcher starts Chromium. The relay passes core's CDP traffic through, and on a `use` it types the value itself after the origin checks of §5. It scrubs every value it typed from every CDP message to core, for the life of the session (M10b's `Redactor`, moved). `saveLogin` takes a sealed value. M10b's other rules stay in core | Larger: it changes M10b's launch path |
| 10 | Network target tokens: an `http` target with a pinned certificate where needed. Infra secrets: a `process` target. The launcher runs OpenTofu with the secrets in its environment, scrubs the output, and masks attributes OpenTofu marks sensitive (`sensitive_values`, `after_sensitive`) before core parses the plan. Generated passwords: `create`/`rotate` inside the broker, and the browser relay types them. The `pending` part becomes the rotation's pending version | Medium |
| 11 | The first hand-off to a service is built on the broker: a `service` target through the launcher | Small, once Phase 1 exists |
| 12 | A kubeconfig is a `process` target with file injection. The deploy key is the same | Built this way from the start |
| 13 | Item blobs replicate as ciphertext. The root key travels only as a wrap sealed to a holder device's broker key (§10) | Medium |
| 14 | Backups take item blobs only (§10). The backup key and seal: row 15 | Small |
| 15 | Nova's own keys stay in core in Phase 1. They are keys for Nova's own data and identity, not credentials, and moving them would make the broker sign and encrypt Nova's data for it, which isn't a verb. Stated plainly (Conflicts row 4) | None in Phase 1 |
| 16 | Separate-user mode closes this path for the store. In same-user mode it stays open, and Settings says so | None |
| 17 | Outside the broker: those tools keep their own sign-ins | None |

**Limits that remain, said plainly:**
- **A device's own configuration:** a router's Wi-Fi key comes back in the config Nova reads, so core sees it today, masked only for display. Proposed migration (an M10d follow-up): a network target's config read becomes a `use` that keeps the raw snapshot sealed as a broker item and returns a copy masked by M10d's `SECRET_KEY` rule. Restoring is a `use` of that snapshot. A device that stores a secret under a key name the rule doesn't know would still reach core.
- **State OpenTofu writes on disk** holds secrets a provider generated, in plaintext, in the project folder. Proposed: OpenTofu's state encryption, keyed from the broker through the launcher.
- **Echoes on paths the broker doesn't carry:** a value a target shows back in a screenshot. M10b already covers a screenshot taken after a sign-in.

## 10. Phase 1: the broker and Nova Vault

### The store
**Where:** `<home>/broker/` in same-user mode, or the broker account's own folder; 0700. It is kept out of the home's git (`home.js`) and isn't journalled as files.

**The header (`vault.json`)** holds:
- the vault id, the format version, and the Argon2id parameters and salt;
- the wraps of the root key:
  - `passphrase`: a key derived with Argon2id;
  - `recovery`: optional;
  - `passkey:<id>`: from a passkey's PRF output, where the platform supports it;
  - `device:<id>`: one per holder device, sealed to that device's broker key.

**Items (`items/<id>.json`):**
- a random id and a version;
- the item key, wrapped by the root key;
- the metadata, encrypted under the root key;
- the value, encrypted under the item key with AES-256-GCM. The associated data is the vault id, item id, version and kind, so items can't be swapped between files.
- A web login is one item; its username is in the metadata too.

**Argon2id:** RFC 9106's second recommended setting is the floor: m = 64 MiB, t = 3, p = 4. It is raised by a timed calibration at setup on devices that can afford more, and the parameters are recorded in the header.

**The broker's device keys:** an X25519 key pair per device, made on the device, with the private key in the device's key store. It is never synced. It is separate from the mesh identity keys (ADR-11), so the broker never needs core's keys. Its public key is added to the mesh device record when the device is enrolled as a holder (tier 3).

### Unlock
**Every day:** the device's unlock key, from the OS key store, opens its `device:` wrap.
- **macOS:** the login keychain, with user presence (Touch ID) required when the person turns it on.
- **Windows:** the Credential Locker, behind Windows Hello where available. Untested on real Windows, as today.
- **Linux:** the Secret Service (`secret-tool`), when a desktop session answers.
- **A TPM or secure enclave:** where one of these stores is backed by one.
- **A passkey:** WebAuthn's PRF output, where the browser and authenticator support it, reaches the broker sealed.

**No key store answering** (headless Linux, or WSL without a desktop session):
- the device's unlock key sits in a 0600 file in the broker's folder, with today's plain notice; or
- the person chooses to type their passphrase after every restart.

**A hub has to work unattended.**
- Proposed default: the hub unlocks itself at start, as today.
- The person can choose "ask me after a restart".
- Sensitive-class uses still ask, by policy.
- While locked, every use refuses with `locked`, and Health says why.

**The passphrase** is the person's. Nova doesn't store it; it is entered sealed. Setup says plainly that a forgotten passphrase, together with lost holder devices and no recovery key, makes the vault unrecoverable (the design note).

### How values come in
**Sealed entry.** A value the person types is sealed in their own client and reaches the broker through core as ciphertext. That covers an API key, an existing site password, a token or the passphrase.
- **The sealing:** WebCrypto ECDH P-256 with the broker's entry key, then HKDF and AES-GCM, bound to the pending action's digest.
- **What it replaces** (each now takes an envelope):
  - `PUT /vault/{name}`, `PUT /browser/logins/{host}`, `PUT /network/targets/{id}/token` and `PUT /infra/projects/{id}/secrets/{NAME}`;
  - capture's `api_key`;
  - connector fields marked `secret: true`;
  - Gmail's app password and OAuth client.
- **Plaintext forms** are refused once the broker is on, and the gate checks this.
- **A stated limit:** the console's code comes from core, so sealed entry rests on that code being the released one (ADR-9).

**OAuth.** The broker makes the PKCE verifier and the state. Core opens the consent page, and the callback's code goes to the broker. A code is useless without its verifier.

**Generated values.** `create` and `rotate` use `node:crypto`'s CSPRNG, under a per-site policy (24 characters by default, as M10d's `generatePassword` has).

### Sync between devices
- **Holder devices** in Phase 1 are the hub and the standby, each enrolled as a holder at tier 3. Spokes hold nothing until M10h needs it (§13).
- **The broker's outbox:** item blobs and the header (whose `device:` wraps open only on their own device) go there as ciphertext.
  - Core's mesh sync carries them as opaque entries. This replaces today's `vault` entry and `keyForStandby`.
  - The standby's broker reads its inbox.
- **The root key** travels only as a wrap sealed to a holder's broker key, made by the hub's broker at enrolment. The passphrase, the recovery key and device unlock keys never move. This changes what M5b built (Conflicts row 2).
- **After a promotion:**
  - Planned (M10g) or emergency from the standby: the new hub's broker already opens the vault.
  - Cold, from backup: Decision 5 applies. Connectors are signed in again, and the sheet says so.

### No escrow (Decision 5)
- **Backups** carry item blobs and never the header, a wrap, a device key or the passphrase. A backup alone opens nothing.
- **The optional recovery key** is generated in the person's own client and shown there once, for their emergency kit. It reaches the broker sealed.
  - The `recovery` wrap lives on holder devices only, never in backups.
  - It recovers from a forgotten passphrase or a lost key store while a holder device survives. It doesn't restore a vault from backup.
- **Off the person's devices,** Nova holds no copy of anything that opens the vault.

### Deleting
- **Delete** is `update(ref, remove)`, at tier 3 (NOVA-SPEC §6: data deletion).
  - The item's blob and key are destroyed, and the root key is rotated, with the other item keys re-wrapped. So an older copy of the store, in a backup or a stale sync entry, doesn't open with any key that still exists.
  - This keeps `vault.ts`'s rule (a new key on every delete) and standing order 4 (forgetting is complete).
- **Disconnecting an extension** deletes its refs (`on_remove`), as `deletePrefix` does now.
- **A factory reset** (`reset.ts`) makes the broker forget its keys and wraps.

### Moving from today's vault, with no value passing through core
1. **Read the old store.** The launcher, in migrate mode, runs broker code as the person and reads the old store itself:
   - `vault/secrets.json`;
   - its key, from the keychain item (`nova-vault` / `vault-<id>`) or `vault/key`;
   - Era 2's Gmail files in `connectors/gmail/`.

   It streams the items to the broker over IPC.
2. **Make the items.** Each entry becomes an item, with its old name kept as an alias ref, so `secret://provider/API_KEY` still resolves to it.
   - Kind and a proposed binding come from the name's prefix and from configuration core already holds, as metadata: a provider's `base_url`, Home Assistant's address, a network target's URL, a sign-in's host.
   - An item with no clear target stays unbound, and can't be used until it is bound.
3. **One tier-3 card** lists every item: name, kind, proposed binding and class, metadata only. The person approves it, edits it, or leaves items unbound.
4. **Read-back:** every item opens in the new store. Only then is the old file deleted and its key removed. Older backups' copies of the old file stay unopenable, because no copy of that key remains.
5. **Interruption:** the migration is idempotent by name, so a re-run continues where it stopped.
6. **Core switches to the client:**
   - `Vault.get` and `Vault.resolve` leave core.
   - A test fails if any module outside `src/broker/` can obtain a value.
7. **The standby** migrates by receiving the new store and its wrap. Its old file and key are removed after read-back.

### The Phase 1 gate
Evidence goes in `docs/evidence/vault-broker-p1-gate.md`, with an adversarial review, as the design note asks.
1. **Canary values** (Amendment B Part 6, pointed at the vault).
   - **Planted:** one canary per kind (web sign-in, provider key, connector token, OAuth tokens, network token, infra secret, a generated password, a rotated one, and a sealed entry).
   - **Exercised:** every consumer flow in §9.
   - **Searched for**, raw and in base64, base64url, hex, URL-encoded and JSON-escaped forms, in:
     - logs and the problem table;
     - Nova's memory, `MEMORY.md` and its rendering;
     - chat transcripts and sessions;
     - Work Ledger tasks, evidence and notes, and context receipts;
     - browser session records;
     - the diagnostics bundle;
     - nightly backups and the encrypted copy, opened with the recovery key (backup plaintext);
     - the sync log, the home's git history, and the services repository.
   - **Passes with** zero hits.
2. **Core's heap.** After each flow, a heap snapshot of the core process holds no canary in any form. This is proposed in addition to the instruction's list, because it tests "values never reach core" directly.
3. **Refusal against a non-bound origin.** A credential bound to A is used against B. The request comes from core itself, with a valid core token and a valid approval for a use at A. B is each of these in turn:
   - another host, a subdomain of A, or a parent of A;
   - a homograph, or A with an extra label;
   - A redirecting to B;
   - `http` instead of `https`, or another port;
   - B framed inside A, or A's form posting to B.

   The broker refuses every one. B's stand-in sees no connection and no typed value, and the ledger shows ref, target and `refused:not_bound`.
4. **Policy on the broker's own authority.** A tier-3 verb is refused when its approval is missing, replayed, made for another digest, or expired. A standing consent for a ref at T doesn't cover T′, or a request outside its scope. A sensitive-class use asks first.
5. **Fixed verbs.** The protocol answers the seven verbs and `hello`, `unlock` and `lock`. A fuzzed list of verb names is refused. A schema check over every answer type finds no field that can carry a value.
6. **No network surface:** as tested in §3.
7. **The store.**
   - The Argon2id parameters are recorded.
   - A tampered item fails on its own, and a swapped item is refused.
   - A deleted item doesn't open from an older copy of the store.
   - Backups hold no header, wrap or key: they are scanned for every key the test knows.
8. **Migration.** From a home with a `vault.ts` vault full of canaries: core's heap stays clean, and the old file and key are gone after read-back. An interrupted run resumes.
9. **Sync and promotion.** The standby opens the vault with its own wrap, and the sync log carries ciphertext only. If M10g is merged, its promotion drill is re-run with the broker.
10. **Every consumer through stand-ins:**
    - a provider, Home Assistant over REST and WebSocket, Gmail over OAuth and IMAP, Screenpipe, and n8n (signing and checking);
    - a network target, and OpenTofu through `fake-tofu`;
    - browser sign-ins and account steps, on `shop-site.js` and `account-site.js`.
11. **The fresh-user test,** and a claims check under Amendment B's closing rule: every user-facing sentence about the vault matches "The claim, worded exactly".
12. **A second-model review packet** (owner pattern, 2026-10-31; OPERATING-RULES). The broker code is the first named case. The builder prepares one self-contained document the owner can hand to another model (ChatGPT, Gemini) for review:
    - the broker's code;
    - the claims it must uphold;
    - this threat model.

    Findings come back as owner input and are triaged like any review, before Phase 1 merges.

## 11. Phase 2: the 1Password connector

**The adapter.** A `onepassword` backend sits behind the broker, and the seven verbs are unchanged.
- **How it reaches 1Password:** proposed, through a service account and 1Password's official CLI (`op`), run by the broker as a `process` target. That adds no npm dependency, and the version is pinned and checked. 1Password Connect is the alternative, for people who already run it. Phase 2's own ADR decides, and re-checks 1Password's documentation at that time.
- **The service account's token** is a Nova Vault item, class sensitive, bound to 1Password's origin.

**The recommended pattern: a dedicated vault.** Setup asks the person to make a vault called "Nova" in 1Password and to grant the service account that vault alone. 1Password documents service accounts as reaching only the vaults granted to them; Phase 2's ADR re-checks this.

**Full sharing** is supported. Before the tier-3 `share_scope` approval, the card states the scope plainly first: "The broker will be able to read every item in these vaults: <names>. Nova core and its models are given no values."

**Bindings.** An item's website URLs are suggestions. Each becomes an exact origin binding only when the person confirms it: one tier-3 card can list them all.

**Writing.** `create`, `update` and `rotate` generate the value in the broker and write it to 1Password with the value on stdin, or in a 0600 file inside a 0700 folder, never on argv. The service account needs write access to that vault.

**No cache.** Values aren't cached on disk: they are held in memory for one use. If 1Password is unreachable, the use fails in plain words. A 1Password-held credential is egress to 1Password, so it shows in context receipts. In local-only mode it isn't fetched (ADR-10), and Nova Vault items keep working.

**The honest wording for this case:** "1Password's automation access lets the process that connects to it read the items you share. In Nova, that process is the broker: the read capability exists only inside the broker process. Nova core, its models, chat, memory, logs and the Work Ledger are given no values. Anything that can read the broker's memory or its service-account token can read what you shared, which is why we recommend sharing a dedicated vault."

**The build** uses a fake `op` in `scripts/stand-ins/`. A real 1Password account is the owner's, under the hard limits.

## 12. Phase 3: optional Vaultwarden and further connectors

**Vaultwarden** is offered by demand, as an optional install and never a default.
- **How it runs:** as a managed workload through the M10e Service Manager (supervisor driver).
- **How the broker reaches it:** through Bitwarden's CLI as a `process` target. The broker holds its API key and master password, as Nova Vault items in the sensitive class.
- **Autofill:** Bitwarden's official clients provide it.
- **Its costs, stated at install:**
  - an AGPL component;
  - another always-on service with a network surface of its own, whose reachability is a tier-3 network change;
  - admin, backups and updates of its own;
  - a pulled image, which falls under the hard limits.

**Further connectors** (Bitwarden cloud, KeePassXC, and so on) come by demand. Each gets a short ADR and the same broker verbs, and connecting each is tier 3.

## 13. Placement

**The order today.**
- In flight: M10d (PR #241, open) and M10e (PR #247, open).
- Then M10f to M10k, then QA Stage 2.
- Side PRs: #248, #249, #250.

Nothing here reorders that.

**Proposed:**
1. **This ADR** lands now, as a docs PR.
2. **Phase 1 is a side track** that starts once M10e is merged. Amendment B's rule allows side PRs "as soon as a slot is free". Starting after M10e avoids colliding with its in-flight supervisor changes. It lands as three PRs, each with its own gate items:
   - **P1a:** the broker, the store, IPC, the verbs, sealed entry, and the migration of rows 1–8 and 13–14;
   - **P1b:** the browser relay and M10d's consumers (rows 9–10);
   - **P1c:** the full gate and the adversarial review.
3. **Phase 1 should precede two new kinds of credential:**
   - M10h's first credential on a spoke (a workload with a key);
   - M10j's kubeconfigs and deploy keys.

   That way they are built on the broker instead of on `vault.ts` and moved later. M10e's service hand-off is refused today, so nothing is lost by waiting for the broker.
4. **If Phase 1 isn't merged when M10h starts,** the recommendation is that M10h ships with no credential on a spoke (Screenpipe's key off, on loopback only) and adds the hand-off after Phase 1. The other choice, M10h waiting for Phase 1, reorders, and is the owner's call (Open question 5).
5. **M10g doesn't wait.** It builds promotion on today's sync, and Phase 1's gate re-runs the promotion drill (gate item 9).
6. **Phase 2** follows Phase 1's gate, as a side PR. A real 1Password account needs the owner's OK.
7. **Phase 3** comes by demand, after M10e and Phase 1. It is never a default.

## Hard limits during the build

These follow M10.md and M10-orchestration.md:
- **No real credentials** anywhere: canaries and stand-ins only. The preview's vault, or any vault or key file on the owner's machine, is never read.
- **No keychain items** written on the owner's machine. Tests inject a key store, as `vault.ts`'s do now.
- **No OS account is created** on the owner's machine. Separate-user mode is tested in a throwaway container, within M10a's one-pinned-image limit.
- **No real password-manager account** (1Password, Bitwarden) and no Vaultwarden image pull without the owner's OK.
- **No real site sign-in, password change or account creation** (M10b and M10d's limits stand).

## Packet conflicts

| # | The input | Pulls against | Resolution | Status |
|---|---|---|---|---|
| 1 | The design note: "structurally impossible — values never leave the broker" | The instruction's honest-claims rule; values do reach the target | "The claim, worded exactly" governs | No decision needed: the owner's later rule governs |
| 2 | "Unlock keys never sync" | M5b as built: the vault's key travels to the standby inside the sealed sync batch, so connectors work after a failover (CAPABILITY-INVENTORY, Secrets) | The root key travels only as a wrap sealed to each holder device's broker key, made at a tier-3 holder enrolment. The passphrase, recovery key and device unlock keys never move. Failover keeps working | **Needs owner decision:** whether a device-sealed wrap counts as an "unlock key" |
| 3 | A minimal, independently auditable component | ADR-2: Rust for crypto and native components. There is no Rust toolchain here (LEDGER, M4b), and the device agents are TypeScript under Node's permission model | TypeScript on Node's standard library now, with a size budget. A Rust port, and the peer-credential helper, come later under ADR-2 | **Needs owner decision** (an ADR-2 exception or a later port) |
| 4 | Values never reach Nova core | Nova's own keys: the backup key and seal, network-change seal keys, capture archive keys, mesh identity keys. Core uses them on its own data, and the verbs don't encrypt or sign for core | Out of the broker's scope in Phase 1, and stated plainly. They keep their current rules: never in backups, never in a sync log in clear | **Needs owner decision:** whether the rule covers them, which would mean more verbs |
| 5 | Values never reach core | Core's value-based redaction (`log.ts`, `changes/kinds.ts`, the outbound guard) needs values to match | Exact scrubbing moves to the broker's edges, and core keeps its rules based on key names. Echoes on paths the broker doesn't carry are a stated limit (§9) | No decision needed |
| 6 | The design note: sensitive class at "Tier 2 (log + notify)" | NOVA-SPEC §6: Tier 2 is "ask first"; logging and notifying is Tier 1 | NOVA-SPEC's numbering and the instruction ("Tier 2 or per-use"): sensitive uses ask first, or ask on every use | No decision needed; the owner may say otherwise |

## Open questions for the owner

All decided on 2026-10-31; see Owner decisions at the top.

## NOTES for Track 1

Proposed text for Track 1 to apply at merge. Nothing below is applied by this PR.

**1. `docs/LEDGER.md`: a new entry at the top of "## Decisions":**

> **2026-10-31 (owner input: Nova Vault and the Credential Broker; the ADR).** Branch `docs/vault-broker-adr`. The owner-approved design `nova-vault-broker-design-2026-10-31.md` was added to the packet exactly as given (sha256 `b0b70e64…`). With the owner's instruction, it is binding for the design in `docs/plans/vault-broker.md`.
> - **The broker:** a separate, minimal process per device, with seven fixed verbs (`list_refs`, `use`, `create`, `update`, `rotate`, `bind`, `share_scope`). It enforces origin binding (exact canonical origins, no wildcards or implied subdomains), and checks bindings, class and approvals on its own authority. Local IPC only. Ledger records carry ref, target and outcome, never values or value-derived hashes.
> - **The claim:** within Nova, the read capability exists only inside the broker: its process, and its launcher for programs it hands a credential to. Never "Nova can never read your passwords".
> - **Phases, in order:**
>   - Phase 1: the broker and Nova Vault. Argon2id, per-item encryption, device and passkey unlock, ciphertext sync with device-sealed wraps, no escrow (Decision 5). The migration from `vault.ts` happens inside the broker.
>   - Phase 2: 1Password, with a dedicated vault as the recommended pattern.
>   - Phase 3: optional Vaultwarden and further connectors.
> - **The Phase 1 gate:** canary values in no log, memory, transcript, ledger entry, receipt, bundle, backup plaintext or sync log; a core heap snapshot with no canary; and the broker refusing a non-bound origin even when core asks.
> - **Placement:** a side track after M10e, ahead of M10h's spoke credentials and M10j. Nothing in M10e–M10k is reordered.
> - **For the owner:** Conflicts rows 2–4 and Open questions 1–6, each with a proposed default.

**2. `docs/builder-packet/ROADMAP-AND-GATES.md`: a new section after "## Launch readiness — Amendment 2026-10-31-B (eight parts)", before "## Sequencing rules":**

> ## Nova Vault and the Credential Broker (owner input 2026-10-31)
> Spec: `nova-vault-broker-design-2026-10-31.md`. The design (ADR) is `docs/plans/vault-broker.md`. Each phase is ADR-gated, and nothing displaces in-flight work or the M10e–M10k order.
> - **Phase 1:** the broker and Nova Vault. A side track after M10e, in three PRs, ahead of M10h's spoke credentials and M10j's cluster credentials.
>   - Its gate: canary values found nowhere Nova writes; the broker refusing a non-bound origin even when core asks; an adversarial review.
> - **Phase 2:** the 1Password connector behind the broker, after Phase 1's gate. A real account needs the owner's OK.
> - **Phase 3:** optional Vaultwarden and further connectors, by demand. Never a default.

**3. Cross-links:**
- **`CAPABILITY-INVENTORY.md`,** the "Secrets (vault, referenced by name)" row: at the start of the third cell, before "**✦ M5: Have (v1)**", insert:
  > **Designed (2026-10-31):** the Credential Broker and Nova Vault (`docs/plans/vault-broker.md`), which replaces this vault's read path; not built yet.
- **`OPERATING-RULES.md`:** a new addendum after "## Addendum — Amendment 2026-10-31-A, QA harness (owner, approved)":
  > ## Addendum — Nova Vault and the Credential Broker (owner, approved 2026-10-31)
  > `nova-vault-broker-design-2026-10-31.md` is binding input. The design is `docs/plans/vault-broker.md`. The honest-claims rule holds in all code, docs and UI copy: within Nova, the read capability exists only inside the broker. No broader claim, such as "Nova can never read your passwords", is made anywhere.
- **`CONTRACTS.md` §4,** after "`secrets[]` (names only — values live in the vault)", add:
  > ; under the Credential Broker (`docs/plans/vault-broker.md`) each name is a ref the broker resolves, and an extension is given uses, never values

  This is a wording clarification, not a breaking change. Track 1 decides whether it needs a contract version note.
- **`EXTENSION-MODEL.md`,** the Connector line: after "Owns auth via the vault", add:
  > (through the Credential Broker: `docs/plans/vault-broker.md`)
- **`docs/plans/M10-orchestration.md`,** Point 8, "What exists": add a bullet:
  > - The Credential Broker design (`docs/plans/vault-broker.md`): kubeconfigs and deploy keys are `process` targets through the broker's launcher once Phase 1 lands.
- **Optional:** add the owner's instruction verbatim to the packet as `INPUT-2026-10-31-VAULT-BROKER-INSTRUCTION.md`, as was done for the orchestration decisions.
