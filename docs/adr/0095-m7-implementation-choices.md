---
status: accepted
date: 2026-10-19
extends: ADR-010 (per-field LWW sync), ADR-023 (licensing of the Relay and runner), ADR-033 (Hub-canonical data), ADR-036 (offline replicas), ADR-071 (the content-blind Relay), ADR-094 (M6.5)
amends: `contracts/rest-api.md` §2 (the Hub plays the sync service) and §5 (the cloud runner holds environments, never the agent)
---

## Context
M7 built sync with offline replicas and a queue of offline writes (FR-109, FR-112, FR-129), the
cloud runner (FR-108, FR-071, FR-116), Telegram and email channels, Web Push and native push
through the Relay (FR-110, FR-111, FR-060, FR-055), Code handoff, best-of-N attempts, three-way
merges and SSH environments (FR-213, FR-212, FR-073, FR-062), several people on one Hub with shared
threads, team agents and OIDC (FR-217, FR-091, FR-113), the flagged features `script.run` and
external agent adapters (FR-202, FR-203), the desktop shell (FR-008, FR-009, FR-214), mutual TLS
for devices and `novad`'s TLS client and local runtime (FR-126, FR-128), and the M6 browser gaps
(FR-092, FR-094, FR-098, FR-103). Five security reviews (identity, execution, browser, desktop,
transports) and the J9 journey found defects; most were fixed and the rest are listed under Known
limitations. The details are in
`docs/13`, `docs/10`, `docs/11`, `docs/12`, `docs/22`, `docs/23` and in `contracts/hub-api.md`,
`contracts/rest-api.md` §2, §3, §5, `contracts/events.md` and `contracts/ipc-channels.md`; the
entry in [`../20-decisions-and-defaults.md`](../20-decisions-and-defaults.md) links here.

## Decision

### Cross-area
1. **Sync is Hub-canonical.** A client keeps an encrypted local replica only when its device
   session has the `offline-replica` scope, and syncs with the Hub through `/api/v1/sync/*` over
   LAN, Mesh or the Relay tunnel (the Relay keeps the server side content-blind). The standalone
   store-and-forward sync service of `contracts/rest-api.md` §2 is not built in v1: the Hub plays
   that role, and the contract is amended. Conflicts are resolved per field, last writer wins by
   hybrid logical clock (ADR-010); the Hub merges pushed ops and keeps every overwritten value in
   a merge log the owner can restore from.
2. **Idempotent writes.** Every mutating request a client may queue offline can carry
   `Idempotency-Key` (1–200 visible ASCII characters). A repeated key from the same principal gets
   the first answer (status and body) for 24 hours and never repeats the effect.
3. **Device sessions name their device.** `GET /api/v1/session` answers `deviceId` and `scopes`
   (null for the owner's own browser session) and, since the team area, `role`; areas that gate on a
   scope read it per request, so a revoked device fails closed.
4. **The cloud runner is a remote execution environment.** The Hub keeps the agent loop, the model
   calls and the policy gate; the runner holds environments (repositories, setup script, caches),
   runs their commands and file operations, streams output, keeps snapshots and enforces hard
   caps. A Code session or Work run whose environment is `cloud` uses it as its sandbox and
   workdir, so it keeps running while the user's own computer is offline. The local runner is
   `services/runner` on this machine; a remote one is the same service at a URL, behind the
   off-by-default `cloud.runner.enabled`.
5. **Several people on one Hub.** The owner invites members; each has their own account, memory,
   connectors and sessions. Shared threads and team agents never inject one person's private
   memory or connectors into another's context.
6. **Push.** Browsers and the PWA subscribe with Web Push (VAPID, RFC 8291 and 8292, on
   `node:crypto`); native apps register APNs and FCM tokens with the Relay, whose real senders sit
   behind the operator's settings. Pushes carry only ids and redacted titles.
7. **Deep links.** `nova://run/<id>`, `nova://code/<id>` and `nova://approval/<id>` (on the web
   `/work/<id>`, `/code/<id>`, `/approvals/<id>`) are what notifications open.
8. **Migrations.** 0033_sync, 0034_runner, 0035_channels_m7, 0036_code_m7, 0037_team,
   0038_flagged, 0039_device_trust (comment-only: device TLS state is kept in memory).

### Sync and offline (FR-109, FR-112, FR-128, FR-129)
9. **What syncs.** Threads (title, pinned, archived, project; mode and creation time read-only),
   messages (one immutable `body`, finished user and assistant messages of ordinary chats only),
   projects (name, instructions), memory items of global and project scope (content, status),
   spaces (name), pages (title, content; space and `version` read-only), schedules (enabled, not
   agents' own wakes) and the owner's non-security global settings. Replicas may create only
   threads and messages, with their own UUIDs, and delete only threads, projects, memory items
   and pages. Secrets, audit, temporary chats, blobs and security settings never sync.
10. **Clocks.** Fixed-width strings `<15-digit ms>-<4 hex>-<node>` that sort in clock order; a
    pushed clock's node must be the pushing device (`hlc_device_mismatch`) and may be at most
    `sync.maxSkewSeconds` (300) ahead (`clock_skew`). A value the feed sees for the first time takes
    its row's `updated_at` as its clock, so a late-noticed Hub value never beats a newer device edit.
11. **The merge log.** `concurrent` (a newer op replaced a value whose clock was not its `base`),
    `stale` (an op that lost) and `restore` (the value a restore replaced); a device overwriting its
    own value is not logged. A delete wins only if it is newer than every field. A tombstone removes
    that entity's merge-log entries, so a forgotten memory item does not survive there. Restore
    writes the lost value back as a new change with a fresh Hub clock.
12. **The feed.** One row per field holding the current state (values are stored a second time in
    `sync_field`), fed by the bus and a 5-minute sweep; tombstones are kept indefinitely. A pushed
    message's `created_at` is the Hub's receipt time, never the device's clock.
13. **Idempotency scope and replay.** Keys are per `device:<id>` (a device session) or
    `token:<id>`, plus method and path. Replay is opt-in per route (`REPLAYABLE_ROUTES`, the writes
    a client queues offline, or `config.idempotentReplay`); every other route remembers the key and
    refuses a repeat (409 `idempotency_not_replayable`), so a route added later that hands out a
    credential cannot leave it in the store. Whatever the route says, an answer marked `no-store`,
    larger than 256 KiB or carrying a credential (a Nova token, a token-shaped string, a value under
    a key named like a credential) is never stored. 5xx and 429 answers are forgotten so a retry
    runs; a first request still running after 5 minutes counts as lost; requests without a session
    are not keyed. The key passes the Relay tunnel.
14. **Gates.** The replica routes need a device session with `offline-replica` and `sync.enabled`;
    the merge log and restore need `sync.enabled`; the replica list and reset do not. Losing the
    scope or the device announces `sync.replica.revoked` and the device must wipe its copy.
15. **Answers written on the device.** A device with `local-runtime` may push an assistant message
    `{role: assistant, parentId, model, provenance: offline}`; without the scope it is rejected
    (`local_runtime_not_granted`). No migration: `offline` comes from the author kind, `sync` from
    the change feed's record of which device wrote a message; offline user messages keep author
    `user`, so memory extraction and intent checks still treat them as the user's words.
16. **Answering offline messages.** `POST /api/v1/threads/:id/messages/:mid/answer` runs the stored
    user message through the normal turn (prompt hooks and user text apply), once, only when it is
    the last message, and never in a shared thread (another member's words never run under the
    caller's authority). The web asks for it automatically, with its own `Idempotency-Key`, once a
    queued message has reached the Hub, and only for the last waiting message of a chat that the
    device's own model has not answered; a refusal stays as a plain note on the sent item, and a
    busy or failing Hub (5xx, 429) is asked again later. Chats label such messages "Written offline"
    (`provenance: sync`) and "Answered offline by a local model" (`provenance: offline`).
17. **The web replica.** Kept only while the session has `offline-replica`; sealed in IndexedDB with
    AES-GCM under a non-extractable key (wiping the key wipes the copy). Without a copy, offline is
    read-only and nothing is stored. The offline queue has its own key, so revoking the replica does
    not destroy unsent work; queued messages with files, deletes, model or reasoning changes and
    temporary chats are refused offline (space renames are queued). An offline write answers what
    the Hub would have answered, built from the copy, with space names and page versions from the
    copy. The local answer is offered only when the session has `local-runtime`. The Hub is checked again after 2 s growing to 60 s, with jitter, and on the
    browser's `online` event.
18. **Not emitted:** `sync.status.changed` (replica status is read from `GET /api/v1/sync/devices`);
    sync audit entries use kind `device`.

### Cloud runner (FR-108, FR-071, FR-116)
19. **One runner per Hub**, set through `cloud.runner.url`, with its token only in the vault
    (`secret://cloud/runner/token`); the URL must be https, or http to this machine.
20. **Leases.** One lease (a cloud run) per thread; the Hub's own Git and file calls through the
    environment transport count against a separate per-environment lease. Wall time counts only
    while a command runs.
21. **Network fails closed.** Cloud commands always run with network off on the runner, because
    runner network does not pass the Hub's egress proxy. The only exception is the owner's security
    setting `cloud.runner.unrestrictedNetwork` (off by default), and then only when the turn's own
    network mode is not `off`; environments with network `setup` or `on` are refused
    (`cloud_network_off`) unless it is on. Proxying runner network through the Hub is not built.
22. **The Hub trusts no path the runner reports.** A folder must be `/workspace` or below it with no
    `.`/`..` parts or control characters (`runner_path`, `outside_workspace`), and the Hub's own
    `fs.*` tools are denied (and so hidden) in cloud threads.
23. **Repositories.** URLs with a user name or password are refused by the Hub schema, the provider
    and the runner (`credentials_in_url`); the runner also refuses private and local host literals;
    `file://` only from folders given with `--local-repos`. Clones run inside the sandbox
    (`file://` sources mounted read-only) with hooks, prompts and system and global Git config off.
24. **The runner's sandbox.** bubblewrap, else docker or podman, else refusal with the reason.
    bubblewrap refuses to run as root; containers run the program as the entrypoint (the image's
    own ENTRYPOINT never runs). `/nova` (the Hub's state on the runner) is mounted only for the
    Hub's own `/runs/:id/run` programs. Each sandbox gets a process limit (RLIMIT_NPROC per user
    namespace) and, where `systemd-run --user --scope` works, a cgroup with pids and memory limits
    (`--expand-environment=no`); otherwise memory is limited per process. Each token may run 16
    commands at once of the runner's 64.
25. **Metering.** Under bubblewrap CPU is read from `/proc`; in a container it is the container
    shell's own report, with a per-process RLIMIT_CPU as the hard backstop. A disk count that stops
    at its entry limit (500,000) counts as over the cap. Caps warn at `warnAt` (0.8) and stop at the
    cap; raising caps reactivates a capped run.
26. **Bounded reads on the Hub.** At most 96 MiB per runner answer, 5 MiB per artifact (refused
    before hashing) and 1 MiB per event-stream event.
27. **Snapshots** are plain tar files inside the environment's folder; encryption at rest is the
    runner operator's.
28. **Leftovers.** Removing an environment while the runner is unreachable leaves it there; a
    later `POST /api/v1/cloud/runner/test` deletes environments no saved environment refers to,
    skipping ones still being created or younger than 10 minutes.
29. **Work runs on a cloud environment** are created waiting, bound to the environment, then
    started, so the first command already goes to the runner; a snapshot is taken first by default.
30. **No bypass in cloud sessions.** The gate asks the thread's own sandbox for its substrate
    (`useSubstrate(accountId, threadId)`); a cloud thread reports `cloud`, which does not count as
    isolated, so bypass mode is not offered. A cloud environment's view says `isolated: false` to
    match.
31. **The contract.** The runner never runs the agent: `taskCiphertext` is refused and
    `POST /runs/:id/approve` answers 501 `approvals_on_hub`. Agent computers stay on the mock cloud
    runner (moving them needs the whole computer interface over HTTP).

### Channels and push (FR-110, FR-111, FR-060, FR-055)
32. **Native push only through the Relay.** The real APNs and FCM senders live in the Relay
    (Apache-2.0, holding the app publisher's credentials, off unless `NOVA_RELAY_APNS_*` or
    `NOVA_RELAY_FCM_SERVICE_ACCOUNT_FILE` is set). The Hub sends Web Push itself and asks the Relay
    (`POST /v1/relay/push/notify`, ids, a category, a title of at most 80 characters and a `nova://`
    link, 30 per route a minute) for native clients, which always get the redacted title whatever
    `push.detail` says. Gone tokens are dropped.
33. **Push follows the OS leg of notification routing** (FR-060): the rule's `os` flag and quiet
    hours (suppressed, not deferred), plus the event's own `os` flag.
34. **Web Push endpoints** must be https on the `push.webPushHosts` allowlist (instead of DNS
    pinning); payloads are padded to 128-byte blocks; the VAPID key is made on first use.
35. **Telegram** defaults to long polling; webhook mode needs an https `channels.publicUrl` and a
    secret token the Hub generates (it cannot be set by hand). One poll loop per bot; receipts are
    `tg:<chat>:<id>`. Text and captions only. `NOVA_TELEGRAM_API_BASE` points the adapter at another
    API base (tests).
36. **Email bindings** are one correspondent (or a list) of a mailbox: IMAP read-only past a UID
    cursor that starts at the end of the folder (old mail is never replayed; a UIDVALIDITY change
    resets to the end), SMTP send, TLS required except to loopback, threading by Message-ID and
    References. A sender counts as their mapped identity only when the topmost
    Authentication-Results with the binding's `authservId` (default: the IMAP host's domain) shows
    `dmarc=pass` for the From domain or an aligned `dkim=pass`, parsed per RFC 8601 (the transports
    review showed a regex over the whole header could be fooled by comments and sender-added
    headers); `senderCheck: none` turns that off only with an explicit confirmation, audited. To addresses the agent, Cc does not; lists are shared conversations; Auto-Submitted,
    Precedence and Nova's own header prevent loops. Passwords and app passwords only.
37. **Email approvals by signed link only.** HMAC with a vault key, single use, lifetime capped by
    the approval and `channels.approvalLinkMinutes` (60), sent only to private bindings whose sender
    was the owner. GET shows the choices and changes nothing (mail scanners follow links); POST
    answers. Reply text is refused.
38. **Slack buttons** count only from the owner, for an approval of that binding's own thread, under
    the same tier rules as text answers.
39. **New M7 kinds live in `m7/channels.ts`** (Telegram is not added to the M6 kind list, so older
    exhaustive maps keep compiling). The FR-055 rotate route sits under `/schedules` but is
    registered by the channels area.

### Code (FR-213, FR-212, FR-073, FR-062, delegation)
40. **Handoff** carries the branch, HEAD, local commits as a Git bundle and every uncommitted change
    as one binary-safe patch; the target must be clean and confirm the same state hash before the
    session moves. The target folder must stay inside the target repository with no `..` in its
    prefix and pass the same folder checks as a new session (`protected_folder`). The review
    restarts at the target with every traveled change pending. A bundle is deleted once its handoff
    completes; patches, and the bundles of refused or failed handoffs, expire after 7 days. Handoff and attempt bookkeeping ignore Nova's own
    `.nova/` worktrees. A session on a detached HEAD is refused (`detached_head`): commits made at
    the target would belong to no branch. A target repository that has commits but none of the
    session HEAD's root commits is another repository (`other_repository`), checked before any
    bundle is fetched so unrelated history is never grafted on; an empty repository and a shallow
    clone are not judged by it.
41. **A chat handoff** to a device is a recorded, announced move that takes effect from the next
    turn; turns still run on the Hub.
42. **Attempts** start from the session's last commit, 2 to 4 of them, each its own session in its
    own worktree with its own budget (never more than the parent has left) and optional model;
    branches with no commits are deleted when the set is applied or discarded; with auto-verify off
    attempts run no checks.
43. **Merges** run on the Hub with `git merge-file` (diff3 markers); binary files and symlinks always
    conflict; the default refuses and writes nothing, `markers` writes markers that block commits
    (409 `merge_conflicts`) until resolved or aborted.
44. **SSH environments** are off by default (`code.ssh.enabled`). The system OpenSSH client runs with
    the vault credential copied only into a temporary private folder (copies a crash left are
    removed at start). The host key is pinned on first use; a different key is refused and audited;
    a pinned key changes only through `POST /api/v1/environments/:id/hostkey/reset` (an ordinary
    update is 409 `repin_required`); racing first connections are compared. Nova's helper is a small
    POSIX shell program uploaded to `~/.nova/remote` and checked by SHA-256 before every start, run
    by that absolute path, not `novad` (which has no helper mode); Git and file operations refuse an
    unverified helper (`helper_unverified`). Hosts and users starting with `-` are refused and every
    ssh call puts `--` before the host; `-o` values are quoted; branch names reach Git after
    `--end-of-options`. Shadows for remote sessions live under `~/.nova/remote/state`; remote writes
    check each parent and never follow a symlink. In SSH, WSL and device sessions `fs.read`,
    `fs.list`, `fs.write`, `fs.edit`, `fs.delete` and `exec.run`'s `cwd` act on the folder on that
    machine through its helper (or device provider), with the Hub's path rules and no link ever
    followed; `fs.search`, `document.read` and `document.create`, which only read the Hub's disk,
    are denied (so hidden). The gate's only root is that folder (a path outside it is refused), the
    tool scope has no root on the Hub (`code.toolPolicy`), an unreachable machine fails closed
    (`remote_unavailable`), and no session on another machine, cloud included, opens a terminal.
45. **Delegation from an agent** (`code.delegate`) runs only in Manual or Plan mode inside the
    project's folders, with the agent's budgets, rules (found through the session's parent chain,
    so workers and attempts keep them) and plugin limits; never from proactive or shared threads;
    pausing the agent holds its delegated work and deleting it archives the sessions; a delegation
    whose rules are gone denies everything.

### Members, shared threads and team agents (decision 5, FR-217, FR-091, FR-113)
46. **The owner** is the recorded owner row (`hubOwnerId`, `isHubOwner`), used everywhere: auth,
    sync, trust, operations and consolidation.
47. **Owner-only routes.** Members are refused, with 403 `policy_denied` `{reason: owner_only}`, the
    routes that administer the Hub or reach its machine (`OWNER_ONLY_ROUTES` in
    `packages/core/src/team/access.ts`), including `/api/v1/settings` (members keep appearance,
    keyboard and onboarding preferences through `/api/v1/team/me/settings`), and stdio MCP servers.
    `instructions.md` is the owner's alone.
48. **Every non-owner account works in its own folder** (`<dataDir>/members/<id>/workspace`), also
    for tool calls with no thread, so a member, a removed member or a team agent's identity never
    reaches the Hub's workspace or configured roots. The browser's fallback profile and files
    folders and plugin drafts are per account.
49. **Non-owners reach only public addresses.** Provider base URLs and tests, MCP over http/sse,
    MCP OAuth discovery and email servers are resolved, checked and pinned for the connection
    (`private_address`); `browser.allowLocalSites` is ignored for them; their egress allow lists and
    browser site allow rows can only narrow `network.egressAllow`.
50. **Removing a member** ends their sessions, sockets and event streams at once, disables their
    schedules, triggers, channel bindings and MCP servers, ends their MCP event and push
    subscriptions and stops their agents; closed accounts are refused turns, runs and sign-ins
    (`account_closed`). Their data is kept.
51. **Events with no account** (network, Relay, trust) go to the owner only.
52. **Shared threads.** The thread stays in its owner's account; each turn runs under whoever wrote
    it (their providers, policy, approvals and audit). An allow-list, not tainting: only web search,
    artifact, document, visualization and image creation, `tool.search`, `context.remaining` and
    `context.fresh`. Nobody's memory, past chats, skills, instructions, app context or project joins;
    nothing said there becomes memory. Any participant may stop a running turn but not cancel
    another's queued message; editing and regenerating are refused; only plain chats outside a
    project can be shared; the owner shares, participants may leave. If the thread's model is another
    person's provider account, the writer's default model answers.
53. **Team agents** live in their own identity account that never signs in; credentials are bound
    to it as `secret://` references. Each task runs in its own shared thread, labelled with the
    requesting account and role (display names cut to one line), with the requester's authority
    (`team-task:<id>`); cancelling cancels only that task's thread. The owner answers the agent's
    approvals through the team routes; the agent's events are copied to the owner's account with
    `payload.teamAgent`. Proactive research starts off.
54. **OIDC** uses the code flow with PKCE (S256), a nonce and `client_secret_basic`; the ID token is
    checked with `node:crypto` (RS, PS, ES and EdDSA; `none` and HS refused; RSA of at least 2048
    bits; EC curves matching the algorithm), plus issuer, audience/azp, expiry, nbf/iat and nonce.
    http issuers only on this machine; the key set is read again once for an unknown key id; there
    is no sign-up without an invitation. The browser that starts is bound by the `nova_oidc_binding`
    cookie (HttpOnly, SameSite=Lax, path the callback, 10 minutes), compared by hash in constant time
    (`browser_mismatch`). Pending sign-ins are capped at 10 per address and 1,000 overall
    (`oidc_busy`). A failed link returns to `/settings/account?oidc_error=`, a failed sign-in or join
    to `/sign-in?oidc_error=`.
55. **Profile cards** need both `team.publicProfiles` and the person's opt-in; the view's `allowed`
    follows the setting.
56. **Loop gaps.** A signed-in user's `ask_user` answer gives the rest of that turn their authority
    (`answer:<callId>`) and reaches the model as their words (FR-188); a sub-agent with a tool list is
    held to it at the gate plus `run.complete`, `tool.search`, `context.remaining` and
    `context.fresh` (FR-053); a goal stopped by a usage limit retries after
    `agents.usageRetryMinutes`, doubling up to 4 hours.

### Flagged features, MCP and images (FR-202, FR-203, FR-042, FR-044, FR-030)
57. **Scripts** run in one QuickJS engine per run in a worker thread with heap and stack limits and a
    watchdog; the time limit counts time spent running script code. Defaults: 5 s, 32 MiB, 20 nested
    calls, 20,000 log characters, tool timeout 600 s; tools that drive the turn cannot be called.
58. **Nested calls** go through the tool runtime and the gate, record origin `model` (the caller's
    own origin, `ui` becoming `model`) and are linked by `parent_call_id`; they never carry the
    user's instruction, so a consequential nested call asks unless a rule or grant allows it.
    `script.run` is never served to MCP clients.
59. **External agents** start only from the user's route, never from a model tool; their operations
    carry the delegation as the user's instruction plus the `external_agent` taint. Permission
    requests are previewed when Nova performs the operation and gated otherwise; Nova never picks
    the agent's `allow_always`; `permissionRouting: agent` is refused.
60. **External agent isolation.** The agent runs in the session's own sandbox with the folder
    read-only and network only to the adapter's declared hosts (the global mode and deny list
    still apply; session grants, the global allow list, credentials and hooks do not); a sandbox
    with no substrate is refused (`no_substrate`), and so is network where the egress proxy cannot
    enforce it, such as a cloud runner (`no_egress_proxy`). Adapter secrets are only
    `secret://agent-adapter/<id>/…` references (`foreign_secret`). At most 8 terminals of 1 MiB each,
    all killed when the delegation ends without waiting on an approval. Turning the flag off stops
    running delegations; reading and cancelling work while it is off.
61. **`delegation.updated`** is coalesced: at most one event per 250 ms, text joined, at most 10
    tool-call updates (the rest counted).
62. **Device MCP servers** are named by the device; the Hub never sends a command line to a device;
    a device still pending approval cannot host one.
63. **Nova's MCP server** serves prompts only to clients whose tools include `skill.load`; resources
    and prompts lists pass the gate; anything out of scope or denied reads as missing; project
    files are read only from the client's own account's projects, opened with `O_NOFOLLOW`.
64. **Image results** that come back only as a URL are refused.

### Desktop shell (FR-008, FR-009, FR-214, FR-128)
65. **Joining.** The shell joins through the Hub's own `/add-device` page as a `browser` device and
    makes its own Hub calls with that session's cookie through Electron's `session.fetch`. Plain
    HTTP only to a Hub on this computer; any other Hub needs HTTPS (local CA or mesh certificates).
66. **Pinning** asks for the identity statement with a fresh 192-bit nonce on the same TLS
    connection before any credential is sent (`apps/desktop/src/pinning.ts`, a copy of core's
    `checkHubIdentity` so the main process does not load core); after that Chromium's certificate
    check accepts only what the statement vouched for. A different identity clears stored cookies
    first. Workaround: with Electron 44 a page load fails if its certificate check runs alongside
    one from the main process, so one request goes alone first.
67. **Notifications.** The shell owns OS notifications and denies the page's own permission, so
    each shows once; the `os` flag is trusted as sent.
68. **Shortcuts.** A global key needs a modifier other than Shift; another app's key is reported,
    never taken; remapping goes through `novaShell.setShortcut`.
69. **Window capture** starts only from the shortcut, tray or overlay, never from a page. AT-SPI
    reads its cache first and walks the tree otherwise, capped at 600 objects, 200,000 characters
    and 6 s; password fields are never read; text is redacted and nothing is sent until the user
    confirms. Captures go as two message attachments (PNG and text); there is no `window_capture`
    origin.
70. **Links and lifetime.** `nova://` is registered with the OS only by an installed build; an Add
    Device link for another Hub only fills the connect page; closing all windows keeps the tray;
    browser component updates are off.
71. **Offline start.** When the remembered Hub is unreachable at start, the shell opens the window
    anyway: the web UI runs from its service-worker copy and every network request to the Hub is
    held (`apps/desktop/src/hold.ts`: at most 64 waiting, 8 s each) while an identity check runs;
    they go out when it passes and fail, so the page falls back to its offline copy, when the Hub
    stays unreachable, the wait runs out or the queue is full. The check repeats every 15 s (then
    the windows reload). A wrong identity still shows the connect page.
72. **Local runtime bridge.** `window.novaShell.localRuntime` (`models`, `chat`) talks to `novad`'s
    local runtime from the main process; the page never sees the socket, token or address. At most 4
    chats at once; a chat stops when its page closes or navigates; reasoning is left out.

### Device TLS and the local runtime (FR-126, FR-128, R-022, R-023)
73. **Crates.** `novad` uses `rustls` =0.23.45 (Apache-2.0 OR ISC OR MIT) with the `ring` provider
    0.17.14; tests make certificates with `rcgen` =0.14.10 (a dev dependency; no key material is
    committed).
74. **Pinned TLS.** `novad` and compute nodes check the pinned identity statement on the same
    connection before sending anything and have no platform trust store once pinned, so a statement
    saying `pinning: off` changes nothing for them; an unpinned compute node uses the system roots
    for an https Hub. A connection not yet verified never presents the device certificate; the
    client reconnects with it after the check. A device moves from http to https when the Hub does,
    never back. The install command fetches over https without certificate checks
    (`curl -fsSLk`), because the SHA-256 in the command carries the integrity.
75. **Mutual TLS.** The Hub asks for a certificate of its local CA without requiring one (browsers
    keep working); the device and node routes check it and that it belongs to the caller.
    `devices.tls.allowWithoutCertificate` stays on for one release. State is in memory (rebuilt by
    the next heartbeat); refusals go to the audit log at most once an hour per device and reason.
76. **Scopes reach the device.** The heartbeat answer carries `scopes`; `novad` keeps them in
    `scopes.json`, so a grant holds while the Hub is down; with no answer yet there is no grant.
77. **The local runtime** runs on client devices behind a 0600 Unix socket or a loopback address
    that needs a token, checks the Host header, refuses an Origin unless the owner allowed it and
    serves only the four `/v1` model routes. Its models appear under `services.computeBackends` and
    `services.modelsPresent`. The capability schema's `modules` enum now lists `local-runtime`, but
    `novad` still leaves it out of `modules` (`DOCUMENT_MODULES`).
78. **Per-user sockets.** `novad install`/`enroll --user <name>` (repeatable; the sudo user by
    default, never root) binds `/run/user/<uid>/nova/runtime.sock` (macOS
    `~/Library/Application Support/Nova/run/runtime.sock`), folder 0700 and socket 0600 owned by the
    user, re-checked every 30 s as users log in and out. Links and foreign files are refused, never
    followed; ownership changes use `lchown`. No peer-credential check (`libc` is not a direct
    dependency).
79. **Relay registration token.** `relay.registrationTokenRef` accepts only
    `secret://relay/registration/…`, so it can never name another secret the connector would send.

### Browser (FR-092, FR-094, FR-098, FR-103)
80. **Scoped site levels** are rows of `browser_site` under a composite key (no migration), narrowest
    first (agent, project, account, the order the policy engine already uses), enforced through the
    policy engine's `ruleTool` (`browser.act:<kind>:<ref>`) behind a policy preview, while hooks,
    tool limits, the approval card, audit and events still see `browser.act`; auto-review escalation
    drops `ruleTool`. A thread's scope is the nearest project and agent up its parent threads.
81. **Capture** is never stored, request bodies are never captured, and the caps are constants: 300
    entries each, response bodies of text types up to 16 KiB, every page value clipped to twice its
    cap before redaction.
82. **Crashes** are decided only from the driver's own signals. A restart restores the one agent tab
    (popups are always closed), replays only a navigation (`browser.navigate` or `devserver.open`)
    and only to a page a GET loaded; after the whole browser dies only cookies carry over. Deleting
    a project or agent removes its scoped site levels: the browser area listens for
    `project.deleted` and `agent.deleted` on the bus (actor `system` in the audit).

### Shared fixes
83. **Redactor bounds.** The `pem` body cannot cross another BEGIN marker and is capped at 16 KiB;
    `url-credentials` is anchored on `://` with a scheme of at most 32 characters; `jwt` starts only
    at the beginning of a token run; literals apply longest first. Every rule stays under 50 ms at
    2 MB of hostile input (`redact-timing.test.ts`).
84. **Licenses (ADR-023 applied).** `services/relay`, `packages/relay` and `services/runner` are
    Apache-2.0 and import no AGPL package; the Relay carries its own JSON-lines logger instead of
    `@nova/telemetry`.
85. **Tooling.** The lint script runs ESLint with `--max-old-space-size=8192`; the Electron journey
    (`npm run test:shell -w apps/desktop`) runs in the Playwright image under `xvfb-run` as the CI
    job `e2e-shell` (`docs/16` §3.3). The `novad` job also runs the Hub's tests against the real
    binary with `NOVA_REQUIRE_NOVAD=1`, so they fail rather than skip when it is missing.

### Follow-up API gaps
86. **View fields added late are optional in the shared types** (`ApprovalView.runId`,
    `codeSessionId`, `threadTitle`; `CloudRunView.sessionId`; `RunView.environmentId`;
    `RelayConfigView.registrationToken`) so older client fakes keep compiling; the Hub always fills
    them. `EnvironmentConnectionView` includes the cloud connection.
87. **The Relay passes the Hub's notices to unconfirmed clients.** A pending route gets the Hub's
    data frames on Hub-opened streams and sends nothing back until confirmed, so a declined client
    gets a sealed `decided` notice (`denied` or `expired`; a claim the Hub refuses is told
    `denied`). No acknowledgement can come back, so the Hub deletes the route after a grace period
    (2 s).
88. **Hub-made secrets** (the Telegram webhook secret) are refused from clients on create as well
    as on update.
89. **Paging.** The account-wide script runs list and the channel message log page by a
    time-and-id cursor (`nextCursor`), so rows sharing a timestamp are never skipped; runs in
    deleted threads are left out; the message log's older `before` stays but cannot be combined
    with `cursor`. Tool invoke returns the result's redacted `meta`.
90. **Mutual TLS is traced to FR-126 and FR-192.** No requirement names mutual TLS. It is how a
    compute node or `novad` accepts only Hub-authorized work and how the Hub knows the device on
    the other end (FR-126), and it is the "certificate" in FR-192's "a token or certificate" for
    the node and device listeners. Code and tests tag it FR-126; the ledger's M6 deferral of
    "FR-126 (mTLS)" is closed by it. No new requirement is added.

## Consequences
A phone or laptop can keep working through a Hub outage with its own sealed copy, and its queued
writes land exactly once. A Code session or Work run on a cloud environment keeps going while the
user's computer sleeps, but without network unless the owner accepts unrestricted runner network.
Notifications reach phones without the Relay seeing content. Several people can share one Hub
without reaching each other's memory, connectors or the owner's machine, at the cost of a long
owner-only list that every new Hub-administration route must join. External agents and scripts
are usable but off by default and cannot widen what the gate allows. Devices now verify the Hub
over TLS and present their certificates, so R-023 closes and R-022 narrows to the Hub → `novad`
management channel.

## Known limitations
- Sync: no client replica other than the web app's; `sync.status.changed` is not emitted; sync
  audit entries use kind `device`. Offline, a chat shows the path back from its newest message.
- Cloud runner: runner network does not pass the Hub's egress proxy (off unless the owner opts in);
  snapshots are not encrypted by Nova; agent computers stay on the mock runner; in a container CPU
  is what the container reports. Cloud threads still hide every `fs.*` tool rather than route
  it to the runner.
- Remote file tools: `fs.search`, `document.read` and `document.create` are hidden in SSH, WSL and
  device sessions rather than routed; the folder there is reached by one helper process per file
  operation (no batching).
- Channels: Telegram files are not read or sent; email OAuth (XOAUTH2) is not built; no shipped
  native app registers with the Relay yet; the channel relay (`/v1/relay/messages`,
  `/outbox`) is not built; the voice-call channel (FR-218) is not built.
- Code: no test against a real sshd (`ControlMaster` reuse untested); chat handoff does not move
  where turns run; symbols, refs, dev servers and worktrees work only on the Hub's own files; no UI
  moves a chat to another device.
- Team: a removed member's data is kept; members configure their own providers; skills of plugins
  not connected to an agent still show in its catalog; a removed member's running channel pollers
  keep polling (their turns are refused) until a restart; Tools & MCP, Notifications and Channels
  have no member mode in the web UI.
- Flagged: no `script` origin in `tool_call`; device MCP servers expose tools only; ACP terminal
  environment variables are ignored.
- Desktop shell: window text on macOS and Windows, voice in quick chat and the screenshot's
  redaction are not built; app identity off Linux is tested only against recorded command output;
  on Wayland the screenshot may be missing; the journey runs only on Linux; Electron fuses come with
  packaging (M10). The desktop review's six findings (excluded apps, screenshot binding, the bridge's
  sender origin and shortcut keys, redaction speed, stored data on a new pin, and an Add Device link
  for another Hub) were fixed before the milestone closed.
- Device TLS: the Hub → `novad` management channel is still bearer tokens over plain HTTP; device
  certificates are not renewed; Windows has no per-user named pipe (the shell reports `no_access`);
  a non-root `novad` can make a socket only for itself; the per-user socket's fork-and-bind as the
  user is tested with the build user's own ids, not across users as root. The transports review's
  six findings (root following links in a user's folder, email sender authentication, push after
  device revocation, the device certificate offered to unverified servers, certificate holders
  calling without it, the PowerShell certificate callback) were fixed before the milestone closed.
- Browser: opaque tokens in URL paths are not masked; the restart limit resets with a new session;
  hover exists only as an agent tool.
- Web over the Relay: attachments, raw files, avatars and the terminal socket do not go through the
  tunnel; a paired browser's device token is sealed but usable by page script (weaker than an
  HttpOnly cookie); with a Relay that predates the `decided` notice the page cannot tell "denied"
  from "expired".
