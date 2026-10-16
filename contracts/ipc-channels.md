# IPC Channels (Renderer ↔ Main)

The renderer runs with `contextIsolation: true`, `sandbox: true`, and **no Node integration**.
It talks to the main process through a `contextBridge` surface generated from this contract.

## API surface (preload `window.unison`)

```ts
interface UnisonAPI {
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
| `approval.decide` | `{id, decision, scope?}` | `Approval` |

### runs, schedules, activity

| Channel | Payload | Result |
| --- | --- | --- |
| `run.create` | `{title,objective,projectId?,autonomy?,dotId?}` | `Run` |
| `run.get` | `{id}` | `RunWithSteps` |
| `run.list` | `{status?,dotId?,limit?,cursor?}` | `Page<Run>` |
| `run.pause` | `{id}` | `Run` |
| `run.resume` | `{id}` | `Run` |
| `run.redirect` | `{id,instruction}` | `Run` |
| `run.cancel` | `{id}` | `Run` |
| `schedule.list` | `{dotId?}` | `Schedule[]` |
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
| `exec.run` (stream) | `{sessionId,cmd,args,cwd?,env?}` | stream of `ExecChunk` |
| `devserver.list` | `{sessionId}` | `DevServer[]` |
| `devserver.start`/`.stop`/`.stopAll` | `{sessionId,id?}` | `DevServer` |

### dots, computers, channels

| Channel | Payload | Result |
| --- | --- | --- |
| `dot.create` | `{name,avatarPath?,responsibilities}` | `Dot` |
| `dot.get` / `dot.list` / `dot.update` / `dot.delete` | — | `Dot` / `Dot[]` |
| `dot.pause` / `dot.resume` | `{id}` | `Dot` |
| `dot.rules.list` / `.upsert` / `.delete` | — | `DotRule` |
| `dot.memory.list` / `.forget` | — | `DotMemory[]` |
| `computer.get` | `{id}` | `ComputerStatus` |
| `computer.connectLocal` | `{dotId}` | `ComputerStatus` |
| `computer.disconnectLocal` | `{dotId}` | `{ok:true}` |
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
| `exec.stream` | `{chunkType:'stdout'\|'stderr'\|'exit', data, exitCode?}` | `{exitCode}` |
| `browser.stream` | `{type:'screenshot'\|'navigate'\|'action', data}` | `{ok}` |
| `index.stream` | `{kind:'project'\|'code', progress}` | `{ok}` |

## Security rules for IPC

1. Only channels in this file are exposed; the preload allowlists channel names.
2. Payloads are validated in **main**, not the renderer.
3. Main never returns secrets or raw keychain values.
4. Renderer may not pass arbitrary file paths to privileged operations without policy checks
   (paths are resolved and canonicalized in main/sandboxd).
5. Every mutating channel writes an audit event where relevant.
