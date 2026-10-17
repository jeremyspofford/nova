# 13 — Sync, Cloud & Channels

All cloud features are **optional**. The app must be fully usable offline with local models
and local tools. Cloud is an accelerator and a bridge, never a requirement.

## 1. Cloud components

| Component | Purpose | Data at rest |
| --- | --- | --- |
| **Cloud runner** | Execute Code/Work runs on managed environments | Session workdir + snapshot (encrypted) |
| **Agent computer** | Persistent always-on environment | Workdir + browser profile + snapshots |
| **Relay** | Channel + mobile dispatch bridge, push notifications | Transient routing only; message content E2E-encrypted |
| **Sync service** | Encrypted replication between the user's devices | Opaque ciphertext only |
| **Catalog** | Plugin/skill/theme marketplace | Public, signed metadata |

The server side is designed to be **content-blind**: it stores ciphertext and route metadata,
not plaintext user content. Self-hosting the runner/relay/sync is P2 using the same protocols.

## 2. Sync (FR-109)

### 2.1 Model

- **Entities synced**: settings, themes, keybindings, projects (metadata + instructions),
  threads + messages, memory items, artifacts (metadata + small blobs), schedules, rules,
  grants, skill/plugin installs, device list.
- **Not synced by default**: secrets (device-local), audit logs (device-local), local file
  blobs (unless opted in), temporary chats, tool result caches.
- **Crypto**: per-account master key derived from the user's passphrase (Argon2id) or a
  device-generated key wrapped to the keychain. Payloads encrypted with XChaCha20-Poly1305.
  Each device has an Ed25519 keypair; devices are added via a signed device-linking flow
  (QR + short code, or passphrase).
- **Transport**: TLS + E2EE; the server sees entity ids, revisions, and sizes only.

### 2.2 Conflict resolution

- Per-field **last-writer-wins** using a hybrid logical clock; deletes are tombstones.
- Message append is conflict-free (append-only log keyed by message id).
- Conflicts that lose data (e.g., concurrent edits to the same message) are recorded in a
  **merge log** shown in Settings → Sync → History, with the option to restore.
- The UI shows sync status per device: synced / pending / offline / error.

### 2.3 Offline & queuing

- Local writes always succeed and are queued for sync.
- Outbound cloud operations (runs, channel messages) queue with visible status and retry with
  exponential backoff and jitter.
- On reconnect, sync reconciles first, then queued operations execute.

## 3. Cloud runner (FR-108)

- Submit any Code or Work run to a cloud environment; watch live or detach.
- Environments are reusable per repo (base image + setup script + caches).
- Snapshots before risky steps; restore on failure.
- Resource metering and spend reporting; a hard stop at the configured cap (FR-116).
- Artifacts and diffs are streamed back and integrated into the local session.

## 4. Channels (FR-110)

A channel maps an external conversation to a Nova thread (usually a Agent's thread).

| Channel | Inbound | Outbound | Auth |
| --- | --- | --- | --- |
| **In-app** | user messages | agent replies | local |
| **Slack** | mentions/DMs/channel messages | replies, threads, files | OAuth (bot + user) |
| **Microsoft Teams** | messages | replies | OAuth (Azure app) |
| **Telegram** | bot messages | replies, files | bot token |
| **Email** | IMAP watch / forward address | SMTP send | credentials in keychain |
| **Webhook** | HTTP POST | configurable callback | signed token |
| **SMS/Texting** | P2 | P2 | provider |

Design rules:

- **Context is shared**: a message from any channel lands in the same thread, so the Agent keeps
  full context.
- **Identity mapping**: each external user maps to a Nova identity/permission scope; unknown
  users are ignored unless explicitly allowed.
- **Approvals** can be delivered and answered from a channel with the same four options;
  sensitive approvals require the desktop app.
- **Untrusted**: all channel content is treated as untrusted input (FR-103).
- **Rate limits and loop prevention**: per-channel caps; agent replies do not re-trigger
  themselves.
- **Privacy**: channels are opt-in per Agent; a channel can be disconnected instantly.

## 5. Mobile dispatch & notifications (FR-111)

- The relay exposes a minimal authenticated endpoint + push notifications (APNs/FCM) for
  status, approvals, and results.
- From a phone: start a task, answer an approval, view a diff summary; full editing is desktop.
- Deep links: `nova://run/<id>`, `nova://code/<id>`, `nova://approval/<id>` open the
  desktop app, or a read-only web view when the desktop is unavailable.
- The relay never sees plaintext content; notifications carry only ids and redacted titles.

## 6. Push notification pipeline

```
Run/approval event → local policy (no secrets) → queue
   → relay (if configured) → APNs/FCM → device
   → deep link → app (desktop or web)
```

Notification content is redacted by default (e.g., "Approval needed in Code session"). The
user can choose more or less detail; secrets and file contents are never included.

## 7. Identity & accounts (FR-113/115)

- Default is a **local account** with no server dependency.
- Optional **OIDC** sign-in for teams; the local account links to the OIDC identity.
- Multiple provider accounts are supported independently of the Nova account.
- Entitlements (plan, limits, model access) are cached and refreshed; lack of entitlement
  degrades gracefully with a clear message.

## 8. Data residency & compliance hooks

- Cloud runner region is selectable where supported.
- All server-stored user data is ciphertext; retention is controlled by the user (sync
  history, snapshots, channel logs).
- Audit exports support compliance workflows; managed policy can require E2EE sync.
- A data-processing summary lists every server interaction, its purpose, and its retention.

## 9. Failure & degradation

| Failure | Behavior |
| --- | --- |
| Sync service down | Local continues; queue grows; status shows "pending"; retries |
| Relay down | Channels queue inbound; outbound retries; desktop unaffected |
| Cloud runner down | Runs queue or fall back to local with a warning |
| Push unavailable | In-app notifications still work; polling fallback |
| Device key revoked | Other devices stop decrypting that device's payloads; re-link required |
