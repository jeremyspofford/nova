# IPC Channels (Renderer ↔ Main)

**Scope: native desktop shell only** (ADR-031, ADR-081: the shell arrived in M7; what it built
is in "As built in M7" below). The web UI
served by the Hub talks to `contracts/hub-api.md` directly and never sees these channels.
Inside the shell, domain channels (chat, runs, goals, approvals, requests, settings, ...) are
thin proxies for Hub API endpoints with the same payloads; the Hub API stays the source of
truth for them. **Native-only** channels (window capture, dictation, global shortcuts, local
`novad` access) have no Hub equivalent and are marked below.

The renderer runs with `contextIsolation: true`, `sandbox: true`, and **no Node integration**.
It talks to the main process through a `contextBridge` surface generated from this contract.

## As built in M7

*ADR-095; `apps/desktop`; payload shapes in `packages/shared/src/m7/desktop.ts`.* The M7 shell
does not proxy the domain channels below: its windows load the Hub's own web UI, which talks to
`contracts/hub-api.md` directly with the session the shell got by joining as a `browser` device
(Add Device), so the Hub API stays the only domain surface. The rest of this file (the
`window.nova` surface and its domain, stream, dictation and data channels) is the design for later
native features and is not built. What exists is two narrow preloads, both sandboxed and
context-isolated, passing plain values only; the main process validates every payload with zod
and checks the sender (the top frame of one of its own Hub windows whose URL is on the Hub's
origin, or one of its own `file:` pages in the renderer folder). Every handler answers
`{ok: true, …}` or `{ok: false, message, reason?}`.

**`window.novaShell`** (the Hub's web UI inside the shell; absent in a browser), `NovaShellBridge`:

| Member | IPC channel | Payload → result |
| --- | --- | --- |
| `version`, `platform` | — | `1`, the OS (`linux`, `darwin`, `win32`) |
| `openWindow(path)` | `shell.openWindow` | `{path}` → `true` when it opened an app route in a window of its own (FR-009), `false` otherwise. Only absolute paths of the shell's own route table (`apps/desktop/src/routes.ts`, a copy of the web router's) pass: never `//host`, `/\host`, a scheme, control characters or an unknown first segment such as `api`. That table does not yet know the M7 Settings sections (an unknown section opens General), `/team` or `/approvals` without an id |
| `shortcuts()` | `shortcut.global.list` | `{}` → `ShellShortcutView[]` `{action: quickChat\|attachWindow, accelerator, label, registered, problem: conflict\|duplicate\|invalid\|null}` |
| `setShortcut(action, accelerator)` | `shortcut.global.set` | `{action, accelerator (Electron syntax, ≤ 100) \| null}` → the list; a key needs a modifier other than Shift; a key another app holds is reported (`conflict`), never taken |
| `localRuntime.models()` | `localRuntime.models` | `{}` → `{ok, reason?: no_novad\|no_access\|scope_missing\|no_model_server\|failed, message?, models}` (FR-128) |
| `localRuntime.chat(req, onDelta)` | `localRuntime.chat` | `{id (the stream's), model, messages: [{role: system\|user\|assistant, content}] (1–500)}` → `{text}`; the answer's text streams to the page as `localRuntime.delta` `{id, text}` events (reasoning left out); it rejects with an Error whose message is the sentence `models()` gives. At most 4 at once; a chat stops when its page closes or navigates |

The main process reaches `novad`'s local runtime itself (`hub-api.md` §4): `localRuntime` in
`shell.json`, or `NOVA_LOCAL_RUNTIME_SOCKET` / `NOVA_LOCAL_RUNTIME_URL` with
`NOVA_LOCAL_RUNTIME_TOKEN_FILE` (loopback only), else `$XDG_RUNTIME_DIR/nova/runtime.sock` (macOS
`~/Library/Application Support/Nova/run/runtime.sock`), else
`/var/lib/nova/local-runtime/runtime.sock`. novad's 403 `scope_missing` maps to `scope_missing`,
its 502 to `no_model_server`, a 401 or a socket or token file this user may not open to
`no_access`, nothing listening to `no_novad`. The page never sees the socket, the token or the
address.

**`window.novaLocal`** (the shell's own pages: connect, quick chat, attach preview) forwards only
these channels, each accepted only from the page named:

| Channel | Page | Payload → result |
| --- | --- | --- |
| `shell.connect.state` | connect | `{}` → the link, address or pin last tried and the problem |
| `shell.connect` | connect | `{link?, url?, pin?, replace?}` (an Add Device link, or the Hub address and its 43-character fingerprint) → `{ok, origin}` after the pinning check of `docs/22` §5 (`apps/desktop/src/pinning.ts`), or `{ok: false, reason, message}`. Connecting to a Hub other than the current one needs `replace: true`, sent only after the page's "Replace your Hub?" confirmation; without it the answer is `{ok: false, reason: 'confirm_replace', replace: {current, next, fingerprint}, message}` and nothing is contacted. Plain `http://` only to a Hub on this computer |
| `quick.state` | quick | `{}` → the Hub's state, the status list (`ShellStatusItemView[]`, Needs input first) and the current chat |
| `quick.send` | quick | `{text, target: current\|new}` → the chat it went to (FR-008) |
| `quick.open` | quick, attach | `{path}`: open an app route in the last used window |
| `quick.newTask`, `quick.home`, `quick.attach` | quick | `{}`: New task, focus Nova, capture the frontmost window |
| `window.capture.draft` | attach | `{draftId}` → `ShellCaptureDraftView` (FR-214): the screenshot, the redacted accessibility text (Linux AT-SPI; macOS and Windows offer none yet) and what was left out |
| `window.capture.attach` | attach | `{draftId, includeImage, includeText, note, target: current\|new}` → sent: two message attachments (PNG and text) on the Hub, no `window_capture` origin |
| `window.capture.discard` | attach | `{draftId}`: drop it; nothing left the computer |

The overlay also receives `quick.status` events. `window.capture` itself is never exposed to a
page: a capture starts only from the global shortcut (default Ctrl+Alt+A), the tray or the
overlay (security rule 6). The quick overlay opens with Ctrl+Alt+N. OS notifications are raised
by the main process for `notification.created` with `os: true`; the page's own notification
permission is denied inside the shell. The shell's settings are `shell.json` in its data folder
(`shellConfigSchema`: the Hub and its pin, shortcuts, excluded apps, `localRuntime`).

Known limitations (desktop review, not yet fixed): the sender check compares the frame's URL
rather than its real origin, so a Hub page served in a sandboxed opaque origin and opened
top-level would pass it; `setShortcut` accepts common editing and system keys; excluded apps match
only on the Linux AT-SPI path.

## API surface (preload `window.nova`)

```ts
interface NovaAPI {
  invoke<C extends Channel>(channel: C, payload: Payload<C>): Promise<Result<C>>;
  subscribe<E extends EventName>(event: E, handler: (payload: EventPayload<E>) => void): Unsubscribe;
  stream<C extends StreamChannel>(channel: C, payload: Payload<C>, on: StreamHandlers): Cancel;
}
```

- `invoke` — request/response.
- `subscribe` — push events (see `events.md`).
- `stream` — long-running operations (chat deltas, run steps, exec output) with
  `onData / onError / onEnd` and a returned `Cancel`.

## Request/response channels

### account & providers

| Channel | Payload | Result |
| --- | --- | --- |
| `account.get` | `{}` | `Account` |
| `account.update` | `{displayName?,username?,avatarPath?}` | `Account` |
| `provider.list` | `{}` | `ProviderAccount[]` |
| `provider.add` | `{provider,authKind,label,apiKey?,baseUrl?}` | `ProviderAccount` |
| `provider.remove` | `{id}` | `{ok:true}` |
| `provider.test` | `{id}` | `{ok:boolean, detail?:string}` |
| `provider.models` | `{id}` | `ModelInfo[]` |
| `model.prefs.get` | `{}` | `ModelPref[]` |
| `model.prefs.set` | `{provider,modelId,alias?,enabled?,defaultParams?}` | `ModelPref` |
| `virtualModel.list` | `{}` | `VirtualModel[]` |
| `virtualModel.upsert` | `VirtualModel` | `VirtualModel` |
| `usage.summary` | `{from?,to?,groupBy}` | `UsageSummary` |

### chat & threads

| Channel | Payload | Result |
| --- | --- | --- |
| `chat.create` | `{mode, projectId?, modelId?, reasoningLevel?, metadata?}` | `Thread` |
| `chat.get` | `{id}` | `ThreadWithMessages` |
| `chat.list` | `{mode?,projectId?,query?,archived?,limit?,cursor?}` | `Page<Thread>` |
| `chat.update` | `{id,title?,pinned?,archived?,unread?}` | `Thread` |
| `chat.delete` | `{id,hard?}` | `{ok:true}` |
| `chat.send` | `{threadId, parts, attachments?, modelId?, reasoningLevel?, steer?}` | `StreamHandle` (stream: `chat.stream`) |
| `chat.cancel` | `{threadId, messageId?}` | `{ok:true}` |
| `chat.editMessage` | `{messageId, parts}` | `{threadId, newMessageId}` |
| `chat.branch` | `{messageId}` | `Thread` |
| `chat.search` | `{query,mode?,projectId?,limit?}` | `SearchHit[]` |

### tools, MCP, approvals

| Channel | Payload | Result |
| --- | --- | --- |
| `tool.list` | `{source?}` | `ToolDescriptor[]` |
| `tool.invoke` | `{name,args,threadId?,runId?,sessionId?}` | `ToolResult` |
| `mcp.list` | `{}` | `McpServer[]` |
| `mcp.add` | `McpServerInput` | `McpServer` |
| `mcp.update` | `{id, patch}` | `McpServer` |
| `mcp.remove` | `{id}` | `{ok:true}` |
| `mcp.restart` | `{id}` | `McpServer` |
| `mcp.status` | `{id}` | `McpStatus` |
| `approval.list` | `{status?,scope?}` | `Approval[]` |
| `approval.decide` | `ApprovalDecision` (`schemas/approval-decision.json`; not `timeout`) | `Approval` |
| `request.list` | `{status?:'pending'}` | `ServerRequest[]` (`schemas/server-request.json`, FR-188) |
| `request.respond` | `{requestId, result}` | `{status:'resolved'\|'conflict'\|'expired'}` |

### runs, schedules, activity

| Channel | Payload | Result |
| --- | --- | --- |
| `run.create` | `{title,objective,projectId?,autonomy?,agentId?}` | `Run` |
| `run.get` | `{id}` | `RunWithSteps` |
| `run.list` | `{status?,agentId?,limit?,cursor?}` | `Page<Run>` |
| `run.pause` | `{id}` | `Run` |
| `run.resume` | `{id}` | `Run` |
| `run.redirect` | `{id,instruction}` | `Run` |
| `run.cancel` | `{id}` | `Run` |
| `run.extendBudget` | `{id,timeSeconds?,tokens?,costUsd?}` | `Run` (FR-182) |
| `goal.get` | `{runId?,agentId?}` | `Goal \| null` (`schemas/goal.json`, FR-181) |
| `goal.set` | `{runId?,agentId?,objective,budgets?}` | `Goal` |
| `goal.update` | `{id,objective?,budgets?}` | `Goal` (applies at the next turn) |
| `goal.pause` / `.resume` / `.complete` / `.clear` | `{id}` | `Goal` |
| `schedule.list` | `{agentId?}` | `Schedule[]` |
| `schedule.upsert` | `ScheduleInput` | `Schedule` |
| `schedule.cancel` | `{id}` | `{ok:true}` |
| `activity.list` | `{refKind,refId,limit?,cursor?}` | `Page<ActivityEntry>` |
| `audit.export` | `{from,to,format:'jsonl'}` | `{path}` |

### code sessions

| Channel | Payload | Result |
| --- | --- | --- |
| `code.create` | `{projectFolderId,environmentId,modelId,permissionMode}` | `CodeSession` |
| `code.get` | `{id}` | `CodeSessionWithChanges` |
| `code.setMode` | `{id,permissionMode}` | `CodeSession` |
| `code.changes` | `{id}` | `CodeChange[]` |
| `code.acceptChange` | `{changeId, hunks?}` | `CodeChange` |
| `code.rejectChange` | `{changeId, hunks?}` | `CodeChange` |
| `code.comment` | `{changeId,line,side,body}` | `DiffComment` |
| `code.review` | `{id}` | `ReviewResult` |
| `code.commit` | `{id,message,branch?}` | `{sha}` |
| `code.openPr` | `{id,title,body,base?}` | `{url,number}` |
| `exec.run` (stream) | `{sessionId,cmd,args?,cwd?,env?,tty?,yieldMs?,maxOutputTokens?}` | `ExecYield` after the yield time: `{status:'exited',exitCode,output}` or `{status:'running',execSessionId,output}`; the full redacted output streams on `exec.stream` (FR-184) |
| `exec.write` | `{execSessionId,text?,closeStdin?,signal?:'interrupt'\|'terminate'}` | `{ok:true}`; each line sent to a shell or interpreter session is evaluated as a new command under the command rules (FR-191) |
| `exec.poll` | `{execSessionId,yieldMs?}` | `ExecYield`: output produced since the last read, and `exitCode` once the process ended |
| `devserver.list` | `{sessionId}` | `DevServer[]` |
| `devserver.start`/`.stop`/`.stopAll` | `{sessionId,id?}` | `DevServer` |

Exec sessions follow `docs/08` §1.1 (the `exec.*` tools, where the exec session id is the
tool's `sessionId`; here `sessionId` is the code session): `yieldMs` defaults to 10,000 and is
at most 120,000; `output` is redacted (FR-101) and capped at `maxOutputTokens` (default
10,000), keeping the head and tail with an omission marker; a run holds at most 8 open exec
sessions, which are killed when the run is cancelled or ends.

### agents, computers, channels

| Channel | Payload | Result |
| --- | --- | --- |
| `agent.create` | `{name,avatarPath?,responsibilities}` | `Agent` |
| `agent.get` / `agent.list` / `agent.update` / `agent.delete` | — | `Agent` / `Agent[]` |
| `agent.pause` / `agent.resume` | `{id}` | `Agent` |
| `agent.rules.list` / `.upsert` / `.delete` | — | `AgentRule` |
| `agent.memory.list` / `.forget` | — | `AgentMemory[]` |
| `computer.get` | `{id}` | `ComputerStatus` |
| `computer.connectLocal` | `{agentId}` | `ComputerStatus` |
| `computer.disconnectLocal` | `{agentId}` | `{ok:true}` |
| `computer.snapshot` / `.restore` | `{id, snapshotId?}` | `SnapshotRef` |
| `computer.takeover` / `.returnControl` | `{id}` | `{ok:true}` |
| `channel.list` / `.add` / `.remove` / `.test` | — | `ChannelBinding` |

### sync, settings, extensions

| Channel | Payload | Result |
| --- | --- | --- |
| `sync.status` / `.enable` / `.disable` / `.linkDevice` / `.history` | — | `SyncStatus` / `MergeRecord[]` |
| `settings.get` | `{keys?}` | `Record<string,unknown>` |
| `settings.set` | `{patch, scope?}` | `Record<string,unknown>` |
| `theme.list` / `.import` / `.export` | — | `Theme` |
| `keybinding.list` / `.set` / `.reset` | — | `Keybinding[]` |
| `plugin.list` / `.install` / `.remove` / `.enable` | — | `PluginInstall` |
| `skill.list` / `.create` / `.update` / `.delete` | — | `Skill` |
| `extension.load` / `.reload` / `.unload` | — | `ExtensionInfo` |
| `diagnostics.snapshot` | `{}` | `DiagnosticBundle` |

### capture, dictation & shortcuts (native-only)

| Channel | Payload | Result |
| --- | --- | --- |
| `window.capture` | `{mode:'frontmost'\|'pick'}` | `WindowCaptureDraft` `{draftId, appName, windowTitle, previewPath, textChars, redactions[]}` via `local.window.capture` (FR-214) |
| `window.capture.attach` | `{draftId, threadId?, newThread?:boolean}` | `{attachmentId, threadId}` (uploads to the Hub as an attachment with origin `window_capture`) |
| `window.capture.discard` | `{draftId}` | `{ok:true}` |
| `dictation.start` | `{engine?, language?}` | `StreamHandle` (stream: `dictation.stream`, FR-216) |
| `dictation.stop` | `{}` | `{text}` |
| `dictation.dictionary.get` / `.set` | `{}` / `{entries:[{term, replacement?}]}` | `DictionaryEntry[]` |
| `shortcut.global.list` / `.set` | `{}` / `{action:'attachWindow'\|'dictate'\|'quickChat'\|'focusApp', accelerator}` | `GlobalShortcut[]` |

### security & data

| Channel | Payload | Result |
| --- | --- | --- |
| `policy.evaluate` | `PolicyContext` | `Decision` |
| `policy.rules.list` / `.upsert` / `.delete` | — | `PolicyRule` |
| `permission.grants.list` / `.revoke` | — | `PermissionGrant` |
| `data.export` | `{includeBlobs?:boolean}` | `{path}` |
| `data.deleteAll` | `{confirm:string}` | `{ok:true}` |
| `data.retention.get` / `.set` | — | `Retention` |

## Stream channels

| Channel | Data | End |
| --- | --- | --- |
| `chat.stream` | `StreamEvent` (docs/07) | `{messageId, status}` |
| `run.stream` | `RunEvent` (docs/09) | `{runId, status}` |
| `exec.stream` | `{execSessionId, chunkType:'stdout'\|'stderr'\|'exit', data, exitCode?}` (redacted) | `{exitCode}` |
| `browser.stream` | `{type:'screenshot'\|'navigate'\|'action', data}` | `{ok}` |
| `index.stream` | `{kind:'project'\|'code', progress}` | `{ok}` |
| `dictation.stream` | `{type:'partial'\|'final', text}` | `{text}` |

## Security rules for IPC

1. Only channels in this file are exposed; the preload allowlists channel names.
2. Payloads are validated in **main**, not the renderer.
3. Main never returns secrets or raw keychain values.
4. Renderer may not pass arbitrary file paths to privileged operations without policy checks
   (paths are resolved and canonicalized in main/sandboxd).
5. Every mutating channel writes an audit event where relevant.
6. `window.capture` and `dictation.start` run only after a user gesture in the shell or the
   global shortcut; the renderer cannot start them on its own. A capture draft is attached
   only when the user confirms it; dictation audio is never stored (FR-214, FR-216).
7. Main talks to the local `novad` only over its 0600 socket or user-only named pipe with the
   local token (`contracts/hub-api.md` §4); the renderer never sees that token. As built in M7:
   the per-user 0600 socket needs no token; a loopback address needs the token file; the Windows
   per-user pipe is not built.
8. Approval answers for `handoff_required` and `confirm_at_action` actions come only from a
   user action in the shell's own UI, never from page content (FR-189).
