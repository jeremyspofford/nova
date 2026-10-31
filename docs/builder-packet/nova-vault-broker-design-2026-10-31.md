Status: OWNER INPUT, approved by Jeremy 2026-10-31. Asks for an ADR first (broker security model is the critical review), then phased build: (1) broker + Nova Vault, (2) 1Password connector, (3) optional Vaultwarden managed service + further connectors. See accompanying prompt.

# Nova Vault + Credential Broker — design note (2026-10-31)

Status: Muse design for Jeremy's approval. Owner's requirement, in
his words: Nova ships with its own vault (Bitwarden/Vaultwarden/
1Password class), or connects to the user's existing password manager
if they want to share it. Nova can use, create, and update passwords
(with permission) but must NEVER read them directly.

## What exists today

The packet has a credential-store mechanism (connector credentials,
the Screenpipe API key stored as a credential, hub keys that never
move) but no user-facing vault and no broker design. This note adds
both, as one system with two parts.

## Part 1 — the Credential Broker (the security core)

A small, separate, privileged component — same pattern as the boot
agent: tiny surface, FIXED verbs, independently auditable. Nova core
and every model talk to the broker; only the broker ever touches a
secret value.

Fixed verbs (the complete list — the broker does nothing else):
- `list_refs` — metadata only: site/app, username, origin bindings,
  sensitivity class, last used/rotated. Never values.
- `use(ref, target)` — inject the credential into a BOUND target:
  a browser form on the bound origin, an API call's auth header, a
  service's environment at spawn. Plaintext exists only inside the
  broker process and the target. It never enters model context,
  chat, memory, logs, or the Work Ledger (the ledger records the ref,
  target, and outcome — that's the audit trail).
- `create(metadata)` — the BROKER generates the password internally
  (CSPRNG, per-site policy) and stores it. Nova supplies site +
  username; the generated value is never shown to the model — the
  approval card shows metadata only.
- `update(ref)` / `rotate(ref)` — broker-side replacement, same
  rule: new value generated and stored inside the broker. Rotating
  ON A SITE (filling its change-password form via the browser) is a
  separate, visible step.
- `bind(ref, target)` / `share_scope(...)` — manage which targets a
  credential may be used on, and which vault/collections a backend
  exposes.

Non-negotiable broker rules:
- ORIGIN BINDING: a credential can only be injected into targets it
  is bound to (domain/origin match, as password managers enforce).
  A request to use a GitHub credential on any other origin is refused
  by the broker itself, regardless of what any model or message asks.
- POLICY LIVES IN THE BROKER, not the model. The model proposes; the
  broker checks binding, sensitivity class, and approval state, and
  refuses on its own authority. Prompt injection therefore cannot
  spend a credential — at worst it can trigger an approval card the
  user declines.
- NO NETWORK SURFACE: local IPC only, per-device. Broker updates ship
  through the same signed pipeline as other privileged components.

## Part 2 — the vaults behind the broker (pluggable backends)

One broker API, backends as adapters (Nova's usual pattern):

A. **Nova Vault (built-in, the default).** An encrypted local store
   for the credentials Nova manages: connector tokens, API keys,
   service credentials, and any logins the user keeps with Nova.
   Modern KDF (Argon2id), per-item encryption, unlock via device
   biometrics/passkey with the master secret in the OS keychain/
   secure enclave where available. Syncs between the user's devices
   as encrypted blobs through hub replication (same treatment as the
   capture archive); unlock keys never sync. Consistent with owner
   decision 5: NO escrow — a lost master secret means the vault is
   unrecoverable, stated plainly at setup; the user may optionally
   put a recovery key in their own emergency kit (user-held, not
   Nova-held).
   Honest scope: Nova Vault is a vault for Nova's work plus basic
   console management (add/edit/organize, health: weak/reused/old
   flags computed by the broker). It is NOT a bid to replace consumer
   password managers' client ecosystems (browser extensions, mobile
   autofill) — see B and C.

B. **Vaultwarden as a Nova-managed service (optional, later).** For a
   user who wants a full self-hosted password manager under Nova's
   roof: Vaultwarden is a mature open-source Bitwarden-compatible
   server, and the OFFICIAL Bitwarden clients (browser, mobile,
   desktop) supply the autofill ecosystem Nova shouldn't rebuild.
   Nova runs it as a managed workload (Service Manager), and the
   broker integrates it as a backend. Costs, stated honestly: an
   AGPL component, another always-on service and attack surface, and
   its own admin/update discipline. Recommended as an optional
   install, never a default.

C. **External password managers (connectors).** 1Password, Bitwarden
   cloud, and peers, via their official automation surfaces
   (1Password Connect / service accounts; Bitwarden CLI/API).
   Honesty requirement: those surfaces grant the connecting process
   read capability by design — so the guarantee is precise: the
   plaintext capability exists ONLY inside the broker process; Nova
   core, models, memory, and logs never receive values. The broker
   is the trust boundary, which is why it is small and fixed-verb.
   Least-privilege guidance built into setup: Nova asks the user to
   share a DEDICATED vault/collection (e.g. a "Nova" vault) rather
   than their entire password manager; full sharing is supported if
   the user chooses it, with the scope shown in plain words first.

## Approvals and tiers

- `use` on a bound target, low sensitivity, with standing consent:
  Tier 1. Sensitive class (banking, email, admin, crypto): Tier 2
  (log + notify) or per-use approval, per user policy.
- `create`, `update`, `rotate`, new target bindings, any change to
  sharing scope, any Vaultwarden/external-manager connection:
  Tier 3 — explicit approval, metadata shown, value never shown.
- Sensitivity classes are set at creation (broker suggests from the
  origin, user confirms) and editable in Settings.

## Threats this design does and doesn't answer

Answered: model/prompt-injection spending credentials (broker policy
+ origin binding + tiers); secret leakage into memory/logs/context
(structurally impossible — values never leave the broker); hub/cloud
sync exposure (ciphertext only); one backend's compromise exposing
another's (backends isolated behind the broker).
Not answered (stated plainly): compromise of the broker process or
the unlocked device itself — that is game over for the shared scope,
which is why the broker is minimal, fixed-verb, signed-update, and
why dedicated-vault sharing is the recommended posture.

## Phasing proposal

1. Broker + Nova Vault + tiers + ledger audit (covers everything
   Nova itself needs: connectors, API keys, the Screenpipe-class
   credentials, browser sign-ins in Nova's own profile).
2. One external connector — 1Password (the owner's manager) — behind
   the broker, dedicated-vault pattern.
3. Optional Vaultwarden managed service + further connectors, by
   demand.
Each phase ADR-gated; phase 1 is the security-critical one and gets
the adversarial review + the QA harness's canary-secret tests
(Amendment B Part 6) pointed at it: plant canary credentials and
prove they appear in no log, memory, transcript, or backup plaintext.
