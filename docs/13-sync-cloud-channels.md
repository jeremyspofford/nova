# 13 — Sync, Cloud & Channels

All cloud features are **optional**. The app must be fully usable offline with local models
and local tools. Cloud is an accelerator and a bridge, never a requirement.

> **Architecture note:** this document assumes the hub-and-spoke model (`docs/21`). The Hub
> is canonical; sync replicates between the Hub and the user's other devices. The **Relay**
> (`docs/22` §3) provides off-LAN reach and push; it is content-blind and end-to-end encrypted.
> Transports (LAN / Mesh / Relay) and Add Device are defined in `docs/22`.

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
  grants, device list.
- **Not synced by default**: secrets (device-local), audit logs (device-local), local file
  blobs (unless opted in), temporary chats, tool result caches.
- **Skills and plugins are not synced**: they are installed on the Hub, which is canonical, and
  clients read them through the Hub API. No client runs a skills or plugins sync loop (FR-049).
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

## 4. Channels (FR-088, FR-110)

A **channel binding** maps one external conversation (a Slack DM, a Slack channel, a Teams
chat, an email address, a webhook) to one Nova thread of an agent.

| Channel | Inbound | Outbound | Auth |
| --- | --- | --- | --- |
| **In-app** | user messages | agent replies | local |
| **Slack** | mentions/DMs in bound conversations | replies, threads, files | OAuth (bot + user) |
| **Microsoft Teams** | messages | replies | OAuth (Azure app) |
| **Telegram** | bot messages | replies, files | bot token |
| **Email** | IMAP watch / forward address | SMTP send | credentials in keychain |
| **Webhook** | HTTP POST | configurable callback | signed token |
| **Voice call** (P2, FR-218) | in-app call or telephony connector | streaming speech | per connector |
| **SMS/Texting** | P2 | P2 | provider |

Design rules:

- **Per-channel threads** (ADR-070): each channel binding keeps its own thread. The agent's
  identity and memory (notes and memory items) are shared across all its channels, so
  continuity comes from memory, not from mirrored history.
- **Owner's private channels**: the in-app channel and the owner's own DMs can be set to share
  one thread.
- **Private to shared**: memory items record whether they came from a private or a shared
  thread. A reply in a shared channel that would use content from a private thread or a
  private-origin memory item passes a policy check first (default `ask` the owner).
- **No implicit watching**: being added to a channel lets the agent answer when addressed;
  it never creates a trigger. Watching a channel needs an explicit event trigger (FR-056,
  `docs/09` §7).
- **Identity mapping**: each external user maps to a Nova identity/permission scope; unknown
  users are ignored unless explicitly allowed.
- **Approvals** can be delivered and answered from a channel with the same decisions (FR-100);
  `handoff_required` and `confirm_at_action` requests (FR-189) must be answered on an
  authenticated Nova client.
- **Untrusted**: all channel content is treated as untrusted input (FR-103) and never counts as
  user authorization, even when it quotes the user (FR-189).
- **Rate limits and loop prevention**: per-channel caps; agent replies do not re-trigger
  themselves.
- **Privacy**: channels are opt-in per Agent; a channel can be disconnected instantly.
- **Voice calls** (P2, FR-218): users can call an agent in-app or through a telephony
  connector, with streaming speech both ways. Calls started by an agent are out of scope for
  v1.
- **Shared threads** (P2, FR-217): several authenticated users of one Hub can share a thread.
  No user's personal memory or private connectors are injected into it; each action runs under
  the acting user's permissions.

*As shipped in M6 (ADR-093).* Bindings are `channel_binding` rows (`/api/v1/channels`); the
adapters are in-app, Slack, Teams (Bot Framework) and webhook. Email bindings are refused until a
mailbox connector exists, and Telegram, voice and SMS are not built.

- **Credentials and inbound.** Bot tokens, signing secrets, app passwords and webhook tokens go to
  the vault (`secret://channel/<id>/…`) and are never returned; the client supplies a webhook's
  token and secret. Bindings of one Slack or Teams app share its credentials
  (`shareCredentialsWith`), and an inbound event reaches the binding of its conversation.
  Deliveries arrive at `POST /api/v1/channels/:id/inbound` and are authenticated before anything
  is read: Slack's signing-secret HMAC, a Bot Framework JWT for Teams, or the webhook binding's
  bearer token plus HMAC, each with a 5-minute window. `channels.publicUrl` is the address
  external services use; the Hub answers to its host (it follows the setting).
- **What starts a turn.** A redelivered message id starts nothing; the bot's own messages are
  ignored (loop prevention); a disconnected binding drops everything; an unmapped sender is
  ignored unless the binding has `allowUnknown` (then a guest); a private binding takes only the
  owner's mapped identity; in a shared conversation only a DM or a mention counts; the
  external-agent rule (`docs/12` §6.2) and the binding's rate caps (default 10 per minute and 120
  per hour, turns and sent messages counted separately) may drop it. Drops are audited.
- **Authority.** A channel turn is labelled with who wrote it and where, and carries **no**
  authority, even from the owner in a private DM (this amends ADR-083's owner-DM rule): the agent
  may act on it only within its rules and the confirmation tiers.
- **Threads.** Each binding gets its own `binding` thread of the agent on its first message; an
  in-app or private binding with `sharePrimaryThread` uses the agent's main thread.
- **Approvals.** When a channel turn waits for a `pre_approvable` approval, the conversation gets a
  prompt with a 6-character code; the owner answers `allow`, `allow session`, `deny` or `deny and
  stop` (the code may be left out when one approval is pending). "Always allow" and hand-off stay
  in Nova; a shared conversation sees only the code, not the action. Slack buttons are not built.
- **Private to shared.** Before a reply or `channel.send` goes to a shared binding, the check
  (`channels.privateToShared`, default `ask`) looks for private content: until exact provenance is
  wired it compares word sequences and numbers with private memory items, the agent's private
  notes, private and in-app binding threads and the owner's 20 most recent chats, ignoring text the
  channel already said. Asking the owner is a server request ("Share" / "Do not share"); a failed
  check counts as private, and a withheld reply becomes "I can't share that here." A notification
  copy cannot ask first, so a shared binding gets one only when `channels.privateToShared` is
  `allow`; otherwise the copy is recorded failed with the reason "withheld: …".
- **Tools.** `channel.list` and `channel.send` (effect `external_communication`; the gate resource
  is `<kind>:<externalRef>`, so a rule can name the channel).
- **Watching.** Watching a Slack conversation is a `connector_event` trigger (`docs/09` §7); a
  binding alone never starts work it was not addressed in.

## 5. Remote control, mobile dispatch & notifications (FR-111, FR-137)

- **Every client drives every session through the Hub.** A phone or a second computer never
  controls another device directly; it talks to the Hub, which runs the session wherever it
  executes. There is no device-to-device remote-control path.
- From a phone: start a task, steer it, answer approvals and questions (FR-188), view a diff
  summary; full editing is on desktop or web.
- **Session handoff** (FR-213): a Code session or chat can move to another device or
  environment with its Git state and continue there (`docs/10` §15).
- The relay exposes a minimal authenticated endpoint + push notifications (APNs/FCM) for
  status, approvals, and results.
- Deep links: `nova://run/<id>`, `nova://code/<id>`, `nova://approval/<id>` open the
  desktop app, or a read-only web view when the desktop is unavailable.
- The relay never sees plaintext content; notifications carry only ids and redacted titles.

### 5.1 Relay framing (FR-137, ADR-071)

Relay traffic consists of sealed envelopes (`contracts/schemas/relay-envelope.json`; full rules
in `docs/22` §3.1 and `contracts/rest-api.md` §3.2). The payload `ct` is XChaCha20-Poly1305
ciphertext sealed end to end to the recipient's device key.

- **What the Relay sees** (outer fields): the envelope version `v`, the frame `kind` (`data`,
  `ack`, `ping`, `pong`, `close`), the opaque routing ids `to` and `from` (never device names),
  the client id `client`, the stream id `stream`, the sequence number `seq`, the segment index
  and count `seg`, the cumulative `ack`, the `close` reason, and frame sizes and timing.
- **What the Relay cannot see or change**: the content. `client`, `stream`, `seq` and `seg`
  are outer metadata, but they are bound to the ciphertext as associated data, so the Relay
  cannot reorder, splice or replay envelopes without the receiver detecting it. The Hub
  authenticates the client inside the seal with its device key and token; route tokens only
  authenticate connections to the Relay.
- **Streams**: each paired client has a client id; each logical stream (a thread stream, a
  server request, a file transfer) has a stream id; `seq` starts at 1 and increases per stream.
- **Segmenting**: payloads above 64 KiB of plaintext are split into at most 256 numbered
  segments (16 MiB per message); the receiver reassembles them and discards an incomplete
  message after 60 s.
- **Acks**: cumulative per stream (ack *n* confirms every envelope up to *n*) and may ride on
  data envelopes. Unacked segments (window 256) are resent after 5 s without an ack and after a
  reconnect; duplicates are dropped by `(client, stream, seq, seg.i)`.
- **Keepalive**: `ping` every 25 s; a connection that misses 3 `pong`s is closed and reopened
  with backoff, resuming from the last ack.
- **Pairing**: by QR code or short code (`docs/22` §4), single use with a 5-minute lifetime,
  approved on the Hub with matching codes on both screens; it yields a device key and a scoped
  token. The Relay learns only the routing ids.
- **Paired clients**: the Hub lists them (device name and platform, relay client id, last
  seen; `GET /api/v1/relay/clients`) and can revoke any; revocation drops its relay routes at
  once.

## 6. Push notification pipeline

```
Run/approval event → local policy (no secrets) → queue
   → relay (if configured) → APNs/FCM → device
   → deep link → app (desktop or web)
```

Notification content is redacted by default (e.g., "Approval needed in Code session"). The
user can choose more or less detail; secrets and file contents are never included.

*As shipped in M6 (ADR-093).* Notification routing (FR-060) is per category (`approval`,
`completion`, `error`, `attention`, `system`) in `notification_rule`, edited through
`/api/v1/notification-rules`: in-app on or off, OS on or off, a list of Slack, Teams or webhook
bindings that get a copy (a shared one only under `channels.privateToShared: allow`, §4), and
whether the category passes quiet hours (by default only approvals do). A category whose in-app rule
is off is recorded read: it stays in the history and still goes to its channels, without a badge.
Quiet hours (`/api/v1/quiet-hours`, the `quiet_hours` table) are a daily window in a time zone on
chosen weekdays, crossing midnight when the end comes first. While they are in force
`notification.created` carries `os: false`, so clients do not raise the OS notification (it is
suppressed, not deferred), and channel copies wait in `notification_delivery` until the window ends
(a restart keeps them; a failed copy is not retried). Agents move self-set wakes and goal
continuations to the end of the window; trigger runs and schedules are not held. Slack and Teams are
also schedule delivery targets: the target's `ref` is a binding id and the receipt is the posted
message's id. Push through the Relay is not built.

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
| Relay connection drops | Client reconnects and resends unacked envelopes; duplicates dropped |
| Cloud runner down | Runs queue or fall back to local with a warning |
| Push unavailable | In-app notifications still work; polling fallback |
| Device key revoked | Other devices stop decrypting that device's payloads; re-link required |
| Paired client revoked | Its relay routes drop at once; reconnects are refused until it pairs again |

## 10. Domain, catalog & hosted services

Default hosted endpoints for `arialabs.ai` (all configurable and self-hostable):

| Service | Default URL | Notes |
| --- | --- | --- |
| Catalog | `https://catalog.arialabs.ai` | Public index; also on the tailnet |
| Relay | `wss://relay.arialabs.ai` | Content-blind, end-to-end encrypted |
| Sync | `https://sync.arialabs.ai` | Optional; ciphertext only |
| Auth | `https://auth.arialabs.ai` | Optional OIDC |
| Cloud runner | `https://runner.arialabs.ai` | Optional |

The catalog is also reachable at `https://catalog.<tailnet>.ts.net` for Mesh-only access.
Clients try catalog URLs in order; every entry is signature-verified. Self-hosting replaces any
of these by changing the configured URL.
