# Events

Events are the backbone of the UI, Activity view, and audit. Every event is persisted
(unless marked ephemeral) and carries a schema version. Schema:
[`schemas/event-envelope.json`](schemas/event-envelope.json).

## Envelope

```json
{
  "id": "0192f...uuidv7",
  "name": "run.step.completed",
  "schemaVersion": 1,
  "ts": "2026-10-16T19:49:00.123Z",
  "accountId": "0192f...",
  "correlation": { "threadId": "...", "turnId": "...", "runId": "...", "subagentId": "...",
                   "sessionId": "...", "agentId": "...", "goalId": "...", "requestId": "...",
                   "callId": "...", "deviceId": "..." },
  "actor": "user | agent:<id> | system",
  "payload": { }
}
```

Rules:

- `id` is unique and monotonic; consumers dedupe by `id`.
- `actor` names who caused the event: the authenticated `user`, an always-on or run agent
  (`agent:<id>`), or `system` (scheduler, budgets, timeouts). Run, turn and sub-agent ids go in
  `correlation`, never in `actor`.
- `correlation` is sparse; only relevant ids are present.
- Persisted events are appended to the `event` table (`docs/06` §2) for replay.
- Ephemeral events (token deltas) are streamed only and not persisted.
- Event names are `domain.action` with optional further segments; camelCase is allowed after
  the first segment (`code.session.modeChanged`).

## Event catalog

### chat & turns

| Name | Persisted | Payload |
| --- | --- | --- |
| `chat.message.created` | yes | `{threadId,messageId,turnId,role,status,provenance?}` (`complete` for the user message, `streaming` for the assistant; `provenance: steer\|queued` for a follow-up, FR-019) |
| `chat.delta` | no | `{threadId,messageId,type: text_delta\|reasoning_delta,text}` (`ChatDeltaPayload` in `packages/shared/src/api.ts`); at most 60 per second per stream |
| `chat.message.completed` | yes | `{threadId,messageId,status,usage}` |
| `chat.message.updated` | yes | `{threadId,messageId,reason}` |
| `chat.message.deleted` | yes | `{threadId,messageId}` (FR-020) |
| `chat.branch.created` | yes | `{threadId,parentId,fromMessageId}` |
| `chat.followup.queued` | yes | `{threadId,queuedId,position}` (FR-019) |
| `chat.followup.started` | yes | `{threadId,queuedId,turnId}` |
| `chat.followup.cancelled` | yes | `{threadId,queuedId,reason: user\|failed,error?}` |
| `project.created` / `.updated` / `.deleted` | yes | `{projectId}` (FR-034) |
| `source.status.changed` | yes | `{sourceId,projectId,status: pending\|indexing\|ready\|error,error?}` (FR-040) |
| `chat.search.indexed` | yes | `{threadId,count}` |
| `turn.started` | yes | `{threadId,turnId,idx,trigger: user\|schedule\|goal\|hook\|event\|channel,executionLocation}` |
| `turn.completed` | yes | `{threadId,turnId,status: completed\|failed,stopReason,steps,usage}`; `usage` is `{inputTokens,outputTokens,cachedTokens,costUsd,timeSeconds}`; `steps` > 1 when steering added model steps (FR-019) |
| `turn.interrupted` | yes | `{threadId,turnId,stopReason: cancelled\|budget\|backstop\|approval_timeout\|location_lost,steps,usage}` |
| `compaction.completed` | yes | `{threadId,turnId,itemId,trigger: pre_turn\|mid_turn\|post_turn\|manual,tokensBefore,tokensAfter}` (FR-183) |
| `thread.status.changed` | yes | `{ref:{kind: thread\|run\|session\|agent,id},from,status: running\|needs_input\|ready\|blocked}` (FR-215) |
| `session.handedOff` | yes | `{handoffId,threadId,sessionId?,from,to,branch?,status}` (FR-213) |

### tools, approvals, review & policy

| Name | Persisted | Payload |
| --- | --- | --- |
| `tool.call.started` | yes | `{callId,tool,title,source,argsPreview,messageId,threadId}`; correlation `{threadId,turnId,callId}` |
| `tool.call.progress` | no | `{callId,chunk}` |
| `tool.call.completed` | yes | `{callId,tool,status,durationMs,resultPreview,messageId,threadId,tags?}` |
| `artifact.created` / `.updated` | yes | `{artifactId,threadId,kind,version}` (FR-038) |
| `approval.requested` | yes | `{approvalId,callId,action,reason,scope,risk,tier}`; correlation `{threadId,turnId,callId}`; the thread's status becomes `needs_input` (`thread.status.changed`) until it is answered |
| `approval.decided` | yes | `{approvalId,decision,alwaysScope?,decidedBy,deviceId?,override}` (`ApprovalDecision`; `timeout` is a decision); correlation `{threadId,turnId,callId}` |
| `approval.cancelled` | yes | `{approvalId,reason}` (the turn ended or the Hub restarted while it waited) |
| `approval.handoff_done` | yes | `{approvalId,note?}` (the handed-off step was marked done) |
| `policy.denied` | yes | `{callId,tool,reason,ruleId?}` |
| `policy.tier` | yes | `{callId,action,tier: handoff_required\|confirm_at_action\|pre_approvable,authorization: user_typed\|none,sources[]}` (FR-189) |
| `review.started` | yes | `{reviewId,callId,approvalId?,attempt}` (FR-085) |
| `review.completed` | yes | `{reviewId,callId,verdict: AutoReviewVerdict,attempts,durationMs,failedClosed}` |
| `review.breaker.tripped` | yes | `{runId,consecutiveDenials,recentDenials,window: 50}` |
| `hook.started` | yes | `{hookId,event,callId?}` (FR-197) |
| `hook.completed` | yes | `{hookId,event,callId?,effect: none\|context\|decision\|continue,durationMs}` |
| `hook.blocked` | yes | `{hookId,event,callId?,reason,failClosed}` |
| `hook.skipped` | yes | `{hookId,event,reason: needs_trust\|revoked\|disabled\|timeout\|error}` |

### server-to-client requests (FR-188)

| Name | Persisted | Payload |
| --- | --- | --- |
| `request.created` | yes | `ServerRequest` without resolution: `{requestId,kind,correlation,targetDeviceId?,payload,expiresAt}` |
| `request.resolved` | yes | `{requestId,kind,resolvedBy,deviceId,result}` |
| `request.expired` | yes | `{requestId,kind,fallback: notification\|none}` |

### runs, goals, agents, schedules

| Name | Persisted | Payload |
| --- | --- | --- |
| `run.created` | yes | `{runId,title,objective,autonomy,origin,budgets}` |
| `run.plan.proposed` | yes | `{runId,steps[]}` |
| `run.plan.amended` | yes | `{runId,steps[],reason}` |
| `run.step.started` | yes | `{runId,stepId,idx,title}` |
| `run.step.completed` | yes | `{runId,stepId,status,detail}` |
| `run.subagent.spawned` | yes | `{runId,subagentId,threadId,role}` |
| `run.subagent.completed` | yes | `{runId,subagentId,status}` |
| `run.status.changed` | yes | `{runId,from,to,pauseReason?}` |
| `run.budget.usage` | no | `{runId,usage:{tokens,timeSeconds,costUsd},budgets}` (live meters) |
| `run.budget.reached` | yes | `{runId,turnId,bound: time\|tokens\|cost\|backstop,summary}` (FR-182) |
| `run.budget.extended` | yes | `{runId,budgets,by}` |
| `run.completed` | yes | `{runId,status: done\|output_missing\|failed\|cancelled,resultSummary,outputVerified}` (FR-187) |
| `goal.created` | yes | `{goalId,runId?,agentId?,objective,budgets}` (FR-181) |
| `goal.updated` | yes | `{goalId,changed[],progressNote?}` (any edit, including status) |
| `goal.status.changed` | yes | `{goalId,from,to,setBy: user\|agent\|system,reason?,blocker?}` |
| `schedule.fired` | yes | `{scheduleId,runId}` |
| `schedule.catchup` | yes | `{scheduleId,runId?,policy: once\|skip,windowFrom,windowTo,missed}` (ADR-079) |
| `schedule.wake.set` | yes | `{scheduleId,agentId,at,reason}` (FR-206) |
| `schedule.created` / `.changed` / `.cancelled` | yes | `{scheduleId,origin}` |
| `trigger.fired` | yes | `{triggerId,kind,dedupeKey}` |
| `mcp.event.received` | yes | `{subscriptionId,triggerId,eventName,deliveryId,duplicate,sizeBytes}` (FR-201) |
| `mcp.subscription.changed` | yes | `{subscriptionId,status: active\|refreshing\|lapsed\|failed\|removed,expiresAt?}` |
| `memory.consolidated` | yes | `{runId,scope: {kind,ref},phase,status,created,updated,aged,summaryTokens}` (FR-204) |
| `memory.item.created` / `.updated` / `.deleted` | yes | `{itemId,scopeKind}` (FR-032) |

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
| `worktree.leased` | yes | `{worktreeId,repoPath,branch,sessionId,expiresAt}` (FR-073) |
| `worktree.released` | yes | `{worktreeId,sessionId,reason: done\|expired\|handoff\|removed}` |
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

### ambient (`docs/24`)

| Name | Persisted | Payload |
| --- | --- | --- |
| `ambient.record.certified` | yes | `{deviceId,count,from,to,policyVersion}` (batched; FR-227) |
| `ambient.certification.revoked` | yes | `{policyVersion,count}` (policy change) |
| `ambient.coverage.changed` | yes | `{deviceId,source,state: captured\|paused\|excluded\|gap,reason?,since}` |
| `ambient.grant.denied` | yes | `{grantId?,granteeKind,granteeRef,reason: no_grant\|out_of_scope\|expired\|rate_limited\|query_timeout}` (FR-233) |
| `ambient.provenance.flagged` | yes | `{turnId,kind: unsupported_claim\|verbatim_copy,callId?,recordIds[]}` (FR-232) |

### system

| Name | Persisted | Payload |
| --- | --- | --- |
| `node.registered` | yes | `{nodeId,name,models}` (FR-126) |
| `node.status.changed` | yes | `{nodeId,from,status: active\|unreachable\|revoked}` |
| `node.models.changed` | yes | `{nodeId,models}` |
| `sync.status.changed` | yes | `{deviceId,status,pending}` |
| `sync.conflict` | yes | `{entityKind,entityId,resolution}` |
| `update.available` / `.downloaded` / `.applied` / `.failed` | yes | `{version,channel}` |
| `diagnostics.updated` | no | `{subsystem,status}` |
| `notification.created` | yes | `{notificationId,kind,title}`; a repeat with the same dedupe key while unread updates the notification and emits nothing |
| `auth.session.created` / `.revoked` | yes | `{accountId}` (audited) |
| `provider.account.created` / `.removed` | yes | `{providerAccountId,provider,secretRef}` (audited; never the key) |
| `settings.changed` | yes | `{key,scope}` (security-relevant keys are audited) |
| `mcp.server.status.changed` | yes | `{serverId,name,status: disabled\|starting\|connected\|error\|stopped,error?}` (FR-043) |
| `audit.appended` | yes | `{auditId,kind,hash}` |
| `import.completed` | yes | `{importId,imported,duplicates,disabled,secretsMigrated}` (FR-200) |
| `flag.changed` | yes | `{key,stage,enabled,source}` (ADR-082) |
| `app.authorization.changed` | yes | `{authorizationId,kind,clientName,status}` (FR-192, FR-222) |

## Consumer rules

- **UI**: subscribes to the renderer-forwarded subset; never blocks on events. A client may
  opt out of event names it does not render (declared in `/api/v1/hello`,
  `contracts/hub-api.md` §7); persisted events stay replayable.
- **Activity view**: renders persisted events filtered by correlation id.
- **Audit**: mirrors security-relevant events (approvals, `policy.*`, `review.*`, `hook.*`,
  `request.*`, `ambient.grant.denied`, `app.authorization.changed`) into `audit_event` with a
  hash chain.
- **Scheduler**: listens for `trigger.fired`, `schedule.fired`, `mcp.event.received` and
  `turn.completed` (goal continuation, FR-181).
- **Sync**: replicates persisted events that are marked syncable.
- Ordering is per-correlation; global order is not guaranteed. Consumers must be idempotent.

## Backpressure

- High-frequency ephemeral events (`chat.delta`, `tool.call.progress`, `browser.screenshot`,
  `run.budget.usage`) are coalesced and rate-limited (e.g., ≤ 60/s per stream; screenshots
  ≤ 1 per 2 s; budget meters ≤ 1/s).
- If a consumer is slow, ephemeral events are dropped (with a warning); persisted events are
  never dropped.
