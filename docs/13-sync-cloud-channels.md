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

*As built in M7 (ADR-095).* There is no separate sync service: the Hub is canonical and plays it
(§2; `contracts/rest-api.md` §2 is amended). The cloud runner is `services/runner`, a remote
execution environment the Hub drives (§3); a self-hosted runner and Relay are the same services at
a URL, both Apache-2.0 (ADR-023). Agent computers still run on the mock cloud runner. The hosted
auth service is not built (§7 uses an OIDC provider the owner configures).

## 2. Sync (FR-109)

### 2.1 Model

*As built in M7 (ADR-095; `packages/core/src/sync`, `apps/hub/src/sync.ts`, `apps/web/src/replica`,
`apps/web/src/offline`; routes in `contracts/hub-api.md`, "Sync").* The Hub is canonical
(ADR-033): it holds the data and merges. A client keeps a local replica only when its device
session has the `offline-replica` scope (FR-129, ADR-036; granted at Add Device or on the device
page) and syncs it with the Hub over LAN, Mesh or the Relay tunnel, which stays content-blind. The
replica loads a paged snapshot, then follows the change feed from the first page's cursor and pulls
again on `sync.changed`; it pushes field changes the Hub merges. As built:

- **Synced**: threads (title, pinned, archived, project; mode and creation time read-only),
  messages (finished user and assistant messages of ordinary chats, each one immutable `body`),
  projects (name, instructions), memory items of global and project scope (content, status),
  spaces (name), pages (title, content; space and `version` read-only), schedules (enabled; not
  agents' own wakes) and the owner's non-security global settings. Replicas may create only
  threads and messages (with their own UUIDs) and delete only threads, projects, memory items and
  pages.
- **Not synced**: secrets, audit, temporary and side chats, attachments and other blobs,
  security settings, skills, plugins, themes, keybindings, rules, grants and the device list
  (clients read those from the Hub).
- **Crypto as built**: the account master key above is not built. The Hub's data is encrypted at
  rest like the rest of its database; the web replica is sealed in IndexedDB with AES-GCM under a
  non-extractable key, so wiping the key wipes the copy. Revocation, a 401 or the scope being
  taken away (`sync.replica.revoked`) wipes it. Devices are linked by Add Device (`docs/22` §4),
  not a separate signed device-linking flow.
- **The feed** keeps current state, one row per field with a growing cursor and its clock, fed by
  the bus and a 5-minute sweep; deletes are tombstones kept indefinitely. A value the feed sees for
  the first time takes its row's update time as its clock, so a late-noticed Hub change never beats
  a newer device edit.
- **Settings**: `sync.enabled` (default on; off refuses every replica call), `sync.maxSkewSeconds`
  (300), `sync.mergeLogDays` (90), `sync.offlineAfterMinutes` (10).

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

*As built in M7.* Clocks are `<15-digit ms>-<4 hex>-<node>` strings that sort in clock order; a
pushed clock's node must be the pushing device and may be at most `sync.maxSkewSeconds` ahead of
the Hub (`clock_skew`). Each pushed op names the clock its edit started from (`base`); the Hub
answers each op `accepted`, `overwritten` (a newer value won) or `rejected` with a reason. The merge
log records `concurrent` (a newer op replaced a value its device had not seen), `stale` (an op that
lost) and `restore` (the value a restore replaced); a device overwriting its own value is not
logged. A delete wins only if it is newer than every field, and a tombstone removes that entity's
merge-log entries (a forgotten memory item does not survive there). Restore writes the lost value
back as a new change with a fresh Hub clock. Settings → Sync shows this device's copy (size,
contents, last sync, Sync now, Load again), changes waiting to send, the devices with a copy and
their status (the owner can make one load again), and History (the merge log with both values, who
set them, and Restore). `sync.status.changed` is not emitted; status is read from the devices list.

### 2.3 Offline & queuing

- Local writes always succeed and are queued for sync.
- Outbound cloud operations (runs, channel messages) queue with visible status and retry with
  exponential backoff and jitter.
- On reconnect, sync reconciles first, then queued operations execute.

*As built in M7 (FR-112, FR-128).*

- **Idempotent writes.** Every queued write carries its own `Idempotency-Key`, reused on resend;
  the Hub answers a repeat with the first answer for 24 hours and never repeats the effect. Replay
  is opt-in per route (the writes a client queues offline); an answer carrying a credential is
  never stored (`contracts/hub-api.md`, "Idempotent writes").
- **Offline reads.** With a copy, the chat list, a chat's messages, projects, spaces and pages are
  answered from it, and the app can start with no Hub at all ("Offline: showing what this device
  has."). Without a copy, offline is read-only: only what the page already loaded, and nothing is
  written to the device.
- **The queue.** Sending a message, starting a chat, renaming, pinning or archiving a chat, editing
  a page, renaming a space and changing a project's name or instructions become sync changes, each
  with a visible status (waiting, sending, not sent with the reason, sent). On reconnect the copy
  catches up first, then items go out in order, with backoff and jitter on retryable errors; a
  failed item can be retried, copied or discarded. Not queued offline: messages with files,
  deletes, model or reasoning changes and temporary chats. Security settings are never kept on the
  device. The queue has its own key, so revoking the copy does not destroy unsent work. While the
  Hub is away it is tried again after 2 s, growing to 60 s, with jitter, and on the browser's
  `online` event.
- **Answers to offline messages.** A message written offline is recorded on the Hub without a turn
  (a replica may only append). Once it reaches the Hub, the web asks the Hub to answer it
  (`POST /api/v1/threads/:id/messages/:mid/answer`), only for the last waiting message of a chat the
  device's own model has not answered; the Hub runs it through the normal turn, once. A refusal
  (it already has a reply, newer messages follow it, a reply was running, or the chat is shared)
  stays as a plain note on the sent item. Chats label such messages "Written offline".
- **Local answers** (FR-128, desktop app only). With the device's `local-runtime` scope and
  `novad`'s local runtime on the computer, a local model can answer the waiting message, with the
  chat and its project's instructions as context (`docs/21` §9). The answer streams, is kept on the
  device and is queued as an assistant message with `provenance: offline`; the Hub takes it only
  from a device with `local-runtime`. Chats label it "Answered offline by a local model".

## 3. Cloud runner (FR-108)

- Submit any Code or Work run to a cloud environment; watch live or detach.
- Environments are reusable per repo (base image + setup script + caches).
- Snapshots before risky steps; restore on failure.
- Resource metering and spend reporting; a hard stop at the configured cap (FR-116).
- Artifacts and diffs are streamed back and integrated into the local session.

*As built in M7 (ADR-095; `services/runner`, `packages/core/src/cloudrun`, `apps/hub/src/cloudrun.ts`;
`contracts/rest-api.md` §5, `contracts/hub-api.md`, "Cloud runner").* The Hub keeps the agent loop,
the model calls and the policy gate; the runner holds environments, runs their commands and file
operations, streams output, keeps snapshots and enforces hard caps. A Code session on a `cloud`
environment, or a Work run started on one, uses the runner as its sandbox and workdir, so it keeps
running while the user's computer is offline (FR-071).

- **One runner per Hub**, off by default (`cloud.runner.enabled`): its URL (`cloud.runner.url`,
  https or http only to this machine) and a token kept only in the vault. The local runner is the
  same service on this machine; Settings → Cloud runner registers, tests and turns it on.
- **Environments** (FR-071): repositories side by side (https without credentials, or `file://`
  from folders the runner operator allowed), a setup script run once in the first repository's
  folder (`/workspace` without one), caches kept across rebuilds,
  an optional base image, a disk cap, and a folder under `/workspace`. Rebuild clones again and runs
  setup once more. Files of the workdir can be browsed from the Hub.
- **Network is off.** Runner network does not pass the Hub's egress proxy, so cloud commands run
  without network, and environments with network are refused, unless the owner turns on
  `cloud.runner.unrestrictedNetwork` (a security setting whose description says what it gives up).
- **Leases and caps** (FR-116): each session or Work run holds one lease with CPU and wall-time caps
  (defaults 3,600 s and 4 h; wall time counts only while a command runs) and each environment a
  disk cap (10 GiB), from `cloud.runner.caps`; a warning and an `attention` notification at 80 %
  and a hard stop at the cap; caps can be raised again. The runner enforces process and memory
  limits per sandbox and a share of command slots per Hub.
- **Snapshots** are taken by hand, before a Work run (by default) and before a restore (on request);
  they are tar files on the runner, not encrypted by Nova. Restore puts the workdir back.
- **Artifacts**: a file of the workdir can be kept as an artifact of the thread (at most 5 MiB).
- **The Hub trusts no path the runner reports**: folders must be under `/workspace`, and the Hub's
  own file tools are hidden in cloud threads (commands, Git and files go to the runner).
- **Not built**: runner network through the Hub's proxy, encrypted snapshots, region choice
  (§8), spend reporting for billing, and agent computers on the real runner (they keep the mock).

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
mailbox connector exists, and Telegram, voice and SMS are not built. *M7 adds Telegram and email
(below); voice calls (FR-218) and SMS are still not built.*

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
  notes, and what people said in private and in-app binding threads and the owner's 20 most recent
  chats (not the agent's own wording there), ignoring text the channel already said before this
  reply (the reply's own turn never counts as already said). Asking the owner is a server request ("Share" / "Do not share"); a failed
  check counts as private, and a withheld reply becomes "I can't share that here." A notification
  copy cannot ask first, so a shared binding gets one only when `channels.privateToShared` is
  `allow`; otherwise the copy is recorded failed with the reason "withheld: …".
- **Tools.** `channel.list` and `channel.send` (effect `external_communication`; the gate resource
  is `<kind>:<externalRef>`, so a rule can name the channel). *Since M8* `channel.send` takes `files` (at most 10
  artifact or attachment ids of the agent's own chat); only Telegram carries files
  (`capability_missing` elsewhere). In a shared binding the text and then the files pass the
  private-to-shared check before anything is sent; files that fail after the text went are reported
  (`server_error`, retryable).
- **Watching.** Watching a Slack conversation is a `connector_event` trigger (`docs/09` §7); a
  binding alone never starts work it was not addressed in.

*As built in M7 (ADR-095; `packages/core/src/channels/adapters/{telegram,email}.ts`,
`packages/core/src/channels/pollers.ts`, `apps/hub/src/channels.ts`).*

- **Telegram** (FR-110). A binding is one chat of a bot; bindings of one bot share its token. Long
  polling is the default (it works behind NAT, one poll loop per bot); webhook mode needs an https
  `channels.publicUrl`, and the Hub makes the webhook's secret token itself (it is shown as "Made by
  Nova" and cannot be set by hand). Private chats and groups follow the audience rules and the
  private-to-shared check; receipts are `tg:<chat>:<id>`. Approvals use inline-keyboard buttons.
  Only text and captions are read, and no files are sent.
- **Email** (FR-110). A binding is one correspondent (or a mailing list, which is a shared
  conversation) of a mailbox; bindings of one mailbox share its password, kept in the vault. The
  mailbox is read past a UID cursor that starts at the end of the folder, so old mail is never
  replayed (a UIDVALIDITY change resets to the end), with IMAP IDLE or polling every
  `channels.email.pollSeconds` (60); replies go out by SMTP with Message-ID and References
  threading. TLS is required except to this machine. A sender counts as their mapped identity only
  when the topmost Authentication-Results header from the receiving server shows `dmarc=pass` with
  its own `header.from` equal to the From domain, or `dkim=pass` with an aligned `header.d` (parsed
  per RFC 8601: comments stripped, one result at a time). Only headers carrying the binding's
  `authservId` count (default: the IMAP host's domain and its subdomains), so mail from a large
  provider stays unverified until its id is set (for example `mx.google.com`). This relies on the
  receiving server adding its own header: if it adds none, a header the sender forged with the
  trusted id still counts. `senderCheck: none` turns the check off for a server that adds no
  results; it needs an explicit confirmation, is audited (`channel.email.sender_check_off`), and
  each message accepted under it is logged with the reason `sender_unchecked`. Messages over 25 MiB
  are skipped, never downloaded. Being in To addresses the
  agent; Cc does not. Auto-Submitted, Precedence and Nova's own header prevent reply loops.
  Attachments are stored as thread attachments. Passwords and app passwords only (no XOAUTH2).
- **Approvals by link and button.** An approval email carries a signed one-use link (HMAC with a
  vault key; its lifetime is capped by the approval and `channels.approvalLinkMinutes`, 60), sent
  only to a private binding whose sender is the owner; opening it shows the choices and changes
  nothing (mail scanners follow links), and the page's form answers once. Plain reply text is
  refused for email. Slack prompts carry buttons; a press counts only from the owner, for an
  approval of that binding's own thread, under the same tier rules as a text answer.
- **Message log.** Every message in or out of a binding is logged without content (the text is in
  the thread): direction, status (started, answered, ignored, dropped, sent, failed, withheld) and
  the reason; Settings shows it per channel with filters.
- **Also**: a test notification per category ("Send a test" shows where it went), notification
  copies to Telegram and email bindings, email as a schedule delivery target, a schedule webhook's
  signing secret rotated and shown once (FR-055), and an MCP event subscription refreshed on
  demand.
- **Shared threads** (FR-217) are built: §7.
- **Not built**: voice calls (FR-218), SMS, Telegram files, email OAuth, and the channel relay
  through the Relay (`/v1/relay/messages`): channels reach the Hub directly (webhooks need a public
  address) or by polling. *M8 builds Telegram files and email OAuth (below).*

*As built in M8 (ADR-097; `packages/core/src/channels/{files,oauth}.ts`, the Telegram and email
adapters, `apps/hub/src/channels.ts`; routes in `contracts/hub-api.md`, "Channels").*

- **Telegram files in.** Photos (the largest size within the cap), documents, voice notes and video
  notes are downloaded only after the message passed every check and will start a turn (a message of
  files alone counts), at most 10 a message. The 20 MiB cap is checked against the size the message
  states, the size `getFile` reports, `Content-Length` and while reading, so nothing larger is held;
  file paths from Telegram are checked, redirects refused, and the bot token never appears in an
  error. Photos and documents pass the upload checks (`prepareAttachments`; Nova has no virus
  scanner) and become thread attachments. Voice notes (Ogg) and video notes (MP4) are checked and
  kept as attachments but are not model input: the turn gets a line saying so, since the Hub cannot
  transcribe them. Videos, audio, stickers and animations are named in the turn as not read; refused
  files are listed with the reason. In webhook mode downloads happen before the Hub answers Telegram,
  and the duplicate check covers Telegram's retries. Albums are not merged into one turn.
- **Telegram files out.** The artifacts a channel turn created or changed (the newest version of
  each, at most 10; "N more files are in Nova." for the rest) go out after the reply, and only if the
  reply did. JPEG, PNG or WebP up to 10 MB go as photos, anything else (or a photo Telegram refuses)
  as a document (50 MB). Text files are redacted before sending. Each file counts against the
  outbound rate cap and gets its own log entry. In a shared conversation the files pass the
  private-to-shared check: text files are read, and files the check cannot read (images, PDFs) count
  as private, so `channels.privateToShared` decides ("I can't share those files here."). Email and
  Slack send no files.
- **Email OAuth (XOAUTH2).** A mailbox chooses `auth: password` (as before) or `oauth`. For OAuth the
  owner sets the provider's authorization URL, token URL, optional revocation URL, client id and
  scopes; the client secret is optional, write-only and kept in the vault. There is no discovery:
  these are fixed settings. **Authorize** opens the provider in the browser with PKCE (S256) and a
  single-use state (10 minutes); the provider redirects to `<Hub>/api/v1/channels/oauth/callback`
  (register that address with the provider), which exchanges the code only when `iss` is absent or
  names the configured authorization server, never the Hub. Tokens and the state live in the vault.
  Tokens are refreshed within 60 s of expiry, one refresh at a time per mailbox; a login the server
  refuses gets one forced refresh and one retry. A refused refresh token sets the mailbox to
  `expired` ("Authorize again"). Signing out, removing the mailbox's last binding, or removing the
  member who owns it revokes the tokens at the provider. Password mailboxes work as before. Audit:
  `channel.oauth.start`, `.connect`, `.failed`, `.expired`, `.revoke`.
- **Message log files.** Each entry that carried a file has `file` (and `files` when it carried
  several): name, size, type, direction, status (`received`, `sent`, `withheld`, `failed`), the
  attachment or artifact and the reason; only names, sizes and types are stored
  (`channel_message_file`), never content. Email attachments are recorded the same way. Files of a
  message that starts no turn are never downloaded, so their entry has no file.

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

*As built in M7 (ADR-095; `apps/web/src/dispatch`, `apps/web/src/relaytransport`, `apps/web/src/push`).*

- **Approvals and tasks from a phone** (FR-111, FR-077). `/approvals` lists pending approvals
  across conversations with the same decisions as the desktop card, says where each comes from,
  updates live and brings `?focus=<id>` to the top. The New task sheet starts a Work run, or a Code
  session in a project folder with the instructions as its first message.
- **Deep links** (decision 7 of ADR-095): `nova://run/<id>` opens `/work/<id>`, `nova://code/<id>`
  `/code/<id>` and `nova://approval/<id>` `/approvals/<id>`; push notifications open them.
- **Pairing and reach over the Relay** (FR-137). The web join page pairs through the Relay when
  the QR names one (`docs/22` §4.4); the page then talks to the Hub through the page's own origin
  or the Relay tunnel (`selectEndpoint`), with its device token as a bearer header (cookies set by
  the Hub do not come back through the tunnel). When the origin stops answering it re-sends reads,
  and writes that carry an Idempotency-Key, through the tunnel, and tries the origin again every
  60 s. Attachments, raw files, avatars and the terminal socket do not go through the tunnel yet.
- **Session handoff** (FR-213) is built for Code sessions (`docs/10` §15); a chat's handoff to
  another device is recorded and announced, and its turns still run on the Hub.

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

*As built in M7 (ADR-095; `packages/core/src/channels/push`, `apps/hub/src/push.ts`,
`services/relay/src/push.ts`, `apps/web/public/sw.js`).* Push is the OS leg of notification
routing (FR-060, FR-111): it goes out when the category's rule allows the OS and quiet hours are
not in force (suppressed, not deferred), and the event's own `os` flag agrees.

- **Browsers and the PWA**: Web Push from the Hub itself, encrypted to each browser (RFC 8291) and
  signed with the Hub's VAPID key (RFC 8292, `push.vapidSubject` as the contact), on `node:crypto`.
  A subscription's endpoint must be https on a host `push.webPushHosts` lists (the major push
  services by default), so a subscription cannot make the Hub post anywhere else. Payloads are
  padded to 128-byte blocks; a subscription the service reports gone is dropped.
- **Native apps**: through the Relay only. The Hub asks the Relay to push to the account's paired
  clients that registered an APNs or FCM token; the real senders live in the Relay, which holds the
  app publisher's credentials and is off unless its operator configures them. No shipped native
  app registers yet.
- **What a push says**: ids, the category, a title and where it opens (`path` on the web and the
  `nova://` link), nothing else. `push.detail` chooses the title: `none` ("Nova"), `redacted`
  (default: "Approval needed in a Code session", "A task finished in a Work run", …) or `titles`
  (the notification title, encrypted to the browser). Native pushes always get the redacted title.
  `push.enabled` (default on) turns push off.
- **The service worker** shows only the title the payload carries (no body) and opens the
  payload's path, else its `nova://` link, never another origin; approvals stay on screen with an
  "All approvals" action. Answering an approval from the notification itself is not built.
- **Settings → Notifications** has "Notifications on this device" (turn on, which asks the
  browser's permission and subscribes; send a test; turn off) and "For every device" (`push.enabled`,
  `push.detail`, the device list with Remove). Inside the desktop app the app raises OS
  notifications itself (`docs/04` §9.1).

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
message's id. Push through the Relay is not built (*M7: built, see above*).

## 7. Identity & accounts (FR-113/115)

- Default is a **local account** with no server dependency.
- Optional **OIDC** sign-in for teams; the local account links to the OIDC identity.
- Multiple provider accounts are supported independently of the Nova account.
- Entitlements (plan, limits, model access) are cached and refreshed; lack of entitlement
  degrades gracefully with a clear message.

*As built in M7 (ADR-095; `packages/core/src/team`, `apps/hub/src/team.ts`, `apps/web/src/team`,
`apps/web/src/joinmember`; routes in `contracts/hub-api.md`, "Team").* Several people can use one
Hub (decision 5, FR-217, FR-091, FR-113). Entitlements are not built (*M8: providers' reported
plans and limits are shown in Settings → Accounts, `docs/14` §6*).

- **People.** The owner is the account that set the Hub up (the recorded owner row). The owner
  invites members with a one-use link (a 256-bit token in the link's fragment, only its hash
  stored, valid `team.invitationHours`, 72 by default) and can withdraw it. A member joins with a
  display name and gets their own account, sessions, memory, connectors and provider accounts, and
  their own appearance, keyboard and onboarding preferences; everything else in Settings is the
  owner's. Removing a member ends their sessions, sockets and streams at once, disables their
  schedules, triggers, channel bindings and MCP servers, ends their subscriptions and stops their
  agents; their data is kept.
- **What a member cannot do.** Members are refused every route that administers the Hub or reaches
  its machine (`owner_only`; the list is in `contracts/hub-api.md` §1), including stdio MCP
  servers. A member's chats, runs and tools work in a folder of their own
  (`<dataDir>/members/<id>/workspace`), never the Hub's workspace or configured roots. Their
  provider, MCP, OAuth and mail servers must be public addresses (`private_address`), their egress
  and browser allow lists can only narrow the owner's, and they may use at most half of the
  browser's slots. Account-less system events reach only the owner. `instructions.md` is the
  owner's alone.
- **Shared threads** (FR-217). The owner of a plain chat outside a project shares it with people of
  the Hub; participants may leave and the owner can take them out. The thread stays in its owner's
  account; each turn runs under whoever wrote it (their providers, policy, approvals and audit),
  and if the thread's model is another person's provider account, the writer's default model
  answers. Nobody's memory, past chats, skills, instructions, app context or project joins the
  thread, and nothing said there becomes memory. Only built-in tools from an allow-list are offered
  (web search, artifact, document, visualization and image creation, `tool.search`,
  `context.remaining`, `context.fresh`). Any participant may stop a running turn but not cancel
  another's queued message; editing and regenerating are refused. The shared view (`/team/shared/<id>`)
  shows who wrote each message and who asked for each reply. *Since M8* the ordinary chat view
  does too: a user message of a shared thread carries `author` `{accountId, displayName}` (nothing
  else, never on a private thread), and another person's message shows their name ("Someone" without
  one).
- **Team agents** (FR-091). The owner provisions an agent that lives in its own identity account,
  which never signs in; provider and egress credentials are bound to that identity (`secret://`
  references only). Any person may give it a task; each task runs in a shared thread of its own,
  labelled with the requesting account and role, under the agent's identity with the requester's
  authority, and the audit actor is the agent. The owner answers its approvals on the team agent's
  page; its events are copied to the owner's account. Proactive research starts off. Its
  notifications go to the identity account, which nobody watches yet.
- **OIDC** (FR-113). The owner configures providers (issuer, client id, a write-only client secret,
  scopes; Test checks discovery and the key set). People link an identity in Settings → Account and
  then sign in with it; an invitation can be redeemed by signing up with a provider. The code flow
  uses PKCE (S256), a nonce and `client_secret_basic`; the ID token is checked with `node:crypto`
  (RS, PS, ES and EdDSA only, RSA keys of at least 2048 bits), plus issuer, audience, expiry and
  nonce. A cookie binds the sign-in to the browser that started it. There is no sign-up without an
  invitation, and http issuers are allowed only on this machine.
- **Public profile cards** (FR-113): a read-only card (display name, optional avatar) at
  `/profile/<handle>`, only while the owner's `team.publicProfiles` is on (off by default) and the
  person opted in.

*As built in M8 (ADR-097; `packages/core/src/team/member-purge.ts`, `routes.ts`; routes in
`contracts/hub-api.md`, "Team" (M8)).*

- **A removed member's data** is kept for `team.removedMemberPurgeDays` (30; 0 keeps it until the
  owner purges), so the owner can export it first, then purged by an hourly sweep, or at once from
  Settings → Members ("Delete now", with a confirmation). The purge deletes every row with the
  member's `account_id` and the rows hanging off them, their blobs no one else uses, the vault entries
  named by those rows' ids and their folders. It keeps the account row with its name, username,
  avatar and email cleared, the member row, the audit chain and their usage rows (detached from
  their chats). Their messages in someone else's shared chat keep their place but their text becomes
  "[Removed: written by a member whose data was purged]" and their files go; the assistant's answers
  stay, since they belong to the chat's owner (they may quote the member). The rows go in one
  transaction that also records what is left to clean (`cleaning`), so files and vault entries an
  interrupted purge left are removed by the next sweep; a failed purge is retried a day later.
  Audited `team.member.purge`; `team.member.purged`. **Export their data** downloads the member's own
  data before the purge: a `.novaexport` with `accountScope: {accountId}`, never sealed and without
  secrets (only the references their rows hold, listed to re-enter), holding every row that names
  the account and the rows hanging off it, the account row and their files and folders, and nothing
  of anyone else (their words in someone else's shared chat stay out). It is built on a private copy
  of the database, and an import refuses it (`account_scope`): it is for keeping, not restoring.
- **At removal** (not at purge) the member's channel pollers stop and their email mailboxes' OAuth
  tokens are revoked at the provider (`docs/12` §1.1).
- **Member mode.** `GET /api/v1/team/me/access` lists the routes a member is refused (every owner
  route, from the route classification) and their limits; the web app uses it to show Tools & MCP,
  Notifications and Channels to members with the owner's parts hidden (`docs/04` §1).
- **Agents' skills** follow their plugin connections: an agent's skill catalog lists only skills of
  plugins connected to it, and `skill.load` refuses the rest.

## 8. Data residency & compliance hooks

- Cloud runner region is selectable where supported.
- All server-stored user data is ciphertext; retention is controlled by the user (sync
  history, snapshots, channel logs).
- Audit exports support compliance workflows; managed policy can require E2EE sync.
- A data-processing summary lists every server interaction, its purpose, and its retention.

## 9. Failure & degradation

| Failure | Behavior |
| --- | --- |
| Sync service down | Local continues; queue grows; status shows "pending"; retries (as built: the Hub is the sync service, so this is "Hub unreachable": a device with a copy reads from it and queues writes, §2.3) |
| Relay down | Channels queue inbound; outbound retries; desktop unaffected |
| Relay connection drops | Client reconnects and resends unacked envelopes; duplicates dropped |
| Cloud runner down | Runs queue or fall back to local with a warning (as built: cloud calls fail with `runner_unreachable`; nothing falls back to local; the run's lease stays until it ends or is cancelled) |
| Push unavailable | In-app notifications still work; polling fallback (as built: a failing subscription shows as failing after 3 failures, a gone one is dropped) |
| Device key revoked | Other devices stop decrypting that device's payloads; re-link required |
| Paired client revoked | Its relay routes drop at once; reconnects are refused until it pairs again |

## 10. Domain, catalog & hosted services

Default hosted endpoints for `arialabs.ai` (all configurable and self-hostable):

| Service | Default URL | Notes |
| --- | --- | --- |
| Catalog | `https://catalog.arialabs.ai` | Public index; also on the tailnet |
| Relay | `wss://relay.arialabs.ai` | Content-blind, end-to-end encrypted |
| Sync | `https://sync.arialabs.ai` | Not used: the Hub plays the sync service (§2, ADR-095) |
| Auth | `https://auth.arialabs.ai` | Optional OIDC |
| Cloud runner | `https://runner.arialabs.ai` | Optional |

The catalog is also reachable at `https://catalog.<tailnet>.ts.net` for Mesh-only access.
Clients try catalog URLs in order; every entry is signature-verified. Self-hosting replaces any
of these by changing the configured URL.
