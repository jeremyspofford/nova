# Events

Events are the backbone of the UI, Activity view, and audit. Every event is persisted
(unless marked ephemeral) and carries a schema version.

## Envelope

```json
{
  "id": "0192f...uuidv7",
  "name": "run.step.completed",
  "schemaVersion": 1,
  "ts": "2026-10-16T19:49:00.123Z",
  "accountId": "0192f...",
  "correlation": { "threadId": "...", "runId": "...", "sessionId": "...", "agentId": "..." },
  "actor": "user | agent:<id> | agent:<id> | system",
  "payload": { }
}
```

Rules:

- `id` is unique and monotonic; consumers dedupe by `id`.
- `correlation` is sparse; only relevant ids are present.
- Persisted events are appended to the `events` table (see `docs/06`) for replay.
- Ephemeral events (token deltas) are streamed only and not persisted.

## Event catalog

### chat

| Name | Persisted | Payload |
| --- | --- | --- |
| `chat.message.created` | yes | `{threadId,messageId,role}` |
| `chat.delta` | no | `StreamEvent` (text/reasoning/tool deltas) |
| `chat.message.completed` | yes | `{threadId,messageId,status,usage}` |
| `chat.message.updated` | yes | `{threadId,messageId,reason}` |
| `chat.branch.created` | yes | `{threadId,parentId,fromMessageId}` |
| `chat.search.indexed` | yes | `{threadId,count}` |

### tools & approvals

| Name | Persisted | Payload |
| --- | --- | --- |
| `tool.call.started` | yes | `{callId,tool,source,argsPreview}` |
| `tool.call.progress` | no | `{callId,chunk}` |
| `tool.call.completed` | yes | `{callId,status,durationMs,resultPreview}` |
| `approval.requested` | yes | `{approvalId,action,reason,scope,risk}` |
| `approval.decided` | yes | `{approvalId,decision,decidedBy}` |
| `policy.denied` | yes | `{callId,tool,reason,ruleId?}` |

### runs, agents, schedules

| Name | Persisted | Payload |
| --- | --- | --- |
| `run.created` | yes | `{runId,title,objective,autonomy}` |
| `run.plan.proposed` | yes | `{runId,steps[]}` |
| `run.plan.amended` | yes | `{runId,steps[],reason}` |
| `run.step.started` | yes | `{runId,stepId,idx,title}` |
| `run.step.completed` | yes | `{runId,stepId,status,detail}` |
| `run.subagent.spawned` | yes | `{runId,subagentId,threadId,role}` |
| `run.subagent.completed` | yes | `{runId,subagentId,status}` |
| `run.status.changed` | yes | `{runId,from,to}` |
| `run.completed` | yes | `{runId,status,resultSummary}` |
| `schedule.fired` | yes | `{scheduleId,runId}` |
| `schedule.created` / `.changed` / `.cancelled` | yes | `{scheduleId}` |
| `trigger.fired` | yes | `{triggerId,kind,dedupeKey}` |

### code

| Name | Persisted | Payload |
| --- | --- | --- |
| `code.session.created` | yes | `{sessionId,environmentId,mode}` |
| `code.session.modeChanged` | yes | `{sessionId,from,to}` |
| `code.change.applied` | yes | `{sessionId,changeId,path,additions,deletions}` |
| `code.change.reverted` | yes | `{sessionId,changeId}` |
| `code.diff.commented` | yes | `{changeId,line,side}` |
| `code.test.completed` | yes | `{sessionId,status,summary}` |
| `code.review.completed` | yes | `{sessionId,findings}` |
| `code.commit.created` | yes | `{sessionId,sha,branch}` |
| `code.pr.opened` | yes | `{sessionId,url,number}` |
| `code.pr.ci.changed` | yes | `{sessionId,status,checks[]}` |
| `devserver.started` / `.stopped` | yes | `{sessionId,id,url?}` |

### agents, computers, browser

| Name | Persisted | Payload |
| --- | --- | --- |
| `agent.created` / `.updated` / `.paused` / `.resumed` | yes | `{agentId}` |
| `agent.research.finding` | yes | `{agentId,findingId,summary}` |
| `agent.rule.changed` | yes | `{agentId,ruleId}` |
| `computer.state.changed` | yes | `{computerId,from,to}` |
| `computer.takeover.started` / `.ended` | yes | `{computerId,actor}` |
| `browser.navigated` | yes | `{computerId,url,allowed}` |
| `browser.action` | yes | `{computerId,tool,target,result}` |
| `browser.screenshot` | no | `{computerId,blobPath}` |
| `channel.message.received` | yes | `{bindingId,from,threadId}` |
| `channel.message.sent` | yes | `{bindingId,to,threadId}` |
| `signin.requested` | yes | `{computerId,host}` |
| `signin.completed` | yes | `{computerId,host,savedCredential}` |

### system

| Name | Persisted | Payload |
| --- | --- | --- |
| `sync.status.changed` | yes | `{deviceId,status,pending}` |
| `sync.conflict` | yes | `{entityKind,entityId,resolution}` |
| `update.available` / `.downloaded` / `.applied` / `.failed` | yes | `{version,channel}` |
| `diagnostics.updated` | no | `{subsystem,status}` |
| `notification.created` | yes | `{notificationId,kind,title}` |
| `audit.appended` | yes | `{auditId,kind,hash}` |

## Consumer rules

- **UI**: subscribes to the renderer-forwarded subset; never blocks on events.
- **Activity view**: renders persisted events filtered by correlation id.
- **Audit**: mirrors security-relevant events into `audit_event` with a hash chain.
- **Scheduler**: listens for `trigger.fired` and `schedule.fired`.
- **Sync**: replicates persisted events that are marked syncable.
- Ordering is per-correlation; global order is not guaranteed. Consumers must be idempotent.

## Backpressure

- High-frequency ephemeral events (`chat.delta`, `tool.call.progress`, `browser.screenshot`)
  are coalesced and rate-limited (e.g., ≤ 60/s per stream; screenshots ≤ 1 per 2 s).
- If a consumer is slow, ephemeral events are dropped (with a warning); persisted events are
  never dropped.
