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
| `chat.message.created` | yes | `{threadId,messageId,turnId,role,status,provenance?}` (`complete` for the user message, `streaming` for the assistant; `provenance: steer\|queued` for a follow-up, FR-019; `hook` for a `stop` hook's continuation prompt, FR-197; M5: `run\|schedule\|goal\|subagent` for a user-role message a Work run, a schedule, a goal continuation or a sub-agent task started). Role `summary` with status `complete` is a compaction (FR-183) |
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
| `project.folder.indexed` | yes | `{projectId,folderId,fileCount,status: ready\|error,error?}` (FR-035); a cap that stopped indexing leaves `ready` with a note on the folder |
| `chat.search.indexed` | yes | `{threadId,count}` |
| `turn.started` | yes | `{threadId,turnId,idx,trigger: user\|schedule\|goal\|hook\|event\|channel,executionLocation,triggerRef?,runId?}`; `triggerRef` is the schedule, goal, hook or run behind it (M5 run and sub-agent turns use trigger `user` with the run id); a turn of a run carries `runId` in its correlation too, as do its message, compaction and end events |
| `turn.completed` | yes | `{threadId,turnId,status: completed\|failed,stopReason,steps,usage}`; `usage` is `{inputTokens,outputTokens,cachedTokens,costUsd,timeSeconds}`; `steps` > 1 when steering added model steps (FR-019). Since M5 `timeSeconds` is active time: waits for approvals and answers are left out |
| `turn.interrupted` | yes | `{threadId,turnId,stopReason: cancelled\|budget\|backstop\|approval_timeout\|location_lost,steps,usage,bound?}`; `bound` `{bound: time\|tokens\|cost,used,limit}` names the run or goal budget that ended it (FR-182) |
| `compaction.completed` | yes | `{threadId,turnId,itemId,trigger: pre_turn\|mid_turn\|post_turn\|manual,tokensBefore,tokensAfter,method: model\|extractive}` (FR-183); `itemId` is the `summary` message; `extractive` when no model wrote the summary (the mock provider, or the request failed) |
| `context.instructions.truncated` | yes | `{threadId,turnId,messageId,root,truncated[],dropped[],message}` (FR-185): instruction files over the 32 KiB budget were cut (`truncated`) or left out (`dropped`); the reply also gets a `notice` part |
| `thread.status.changed` | yes | `{ref:{kind: thread\|run\|session\|agent,id},from,status: running\|needs_input\|ready\|blocked,reason}` (FR-215); `reason` is a few words ("Approval needed", "Budget reached") or null. M5 emits `kind: thread` only, from the Hub's status service (the loop no longer emits it); a thread seen for the first time counts as `ready` before |
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
| `review.started` | yes | `{reviewId,callId,approvalId?,attempt}` (FR-085); M5 sends `attempt: 1` and no `approvalId` (the reviewer runs before any card exists); correlation has `runId` in a run |
| `review.completed` | yes | `{reviewId,callId,verdict: AutoReviewVerdict,attempts,durationMs,failedClosed}`; `failedClosed` when the reviewer failed or answered outside its schema (the verdict is then a deny) |
| `review.breaker.tripped` | yes | `{runId,threadId,consecutiveDenials,recentDenials,window: 50}`: 3 denials in a row or 10 in the last 50 reviews of one run (`runId` null: of one thread); the call is denied with stop and a run pauses with `review_breaker` |
| `hook.started` | yes | `{hookId,event,callId?}` (FR-197) |
| `hook.completed` | yes | `{hookId,event,callId?,effect: none\|context\|decision\|continue,durationMs}` |
| `hook.blocked` | yes | `{hookId,event,callId?,reason,failClosed}` |
| `hook.skipped` | yes | `{hookId,event,reason: needs_trust\|revoked\|disabled\|timeout\|error,callId?}` |
| `hook.trust.changed` | yes | `{hookId,status: trusted\|needs_trust\|disabled\|revoked}` (the user trusted or revoked it, it was trusted on a plugin's install screen, or a re-read found a new hash) |

### plugins, skills, MCP servers & workspace

| Name | Persisted | Payload |
| --- | --- | --- |
| `plugin.installed` / `.updated` / `.removed` | yes | `{pluginId,version}` (FR-045); enabling or disabling a plugin emits `plugin.updated` |
| `skill.changed` | yes | `{skillId}` (created, imported, enabled, disabled or deleted, FR-046) |
| `mcp.bundle.installed` | yes | `{serverId,name,signature: verified\|unverified}` (a bundle installed or updated, FR-199) |
| `terminal.exited` | yes | `{terminalId,code}` (FR-006); `code` is null when the terminal was closed or killed |
| `exec.session.started` | yes | `{sessionId,threadId,turnId,callId,cmd,cwd}` (FR-184): an agent command kept running as an interactive session; `cmd` redacted, ≤ 500 characters; correlation `{threadId,turnId,callId}` |
| `exec.session.ended` | yes | `{sessionId,threadId,reason: exited\|terminated\|killed\|cancelled\|turn_ended,exitCode?}`; `killed` from the terminal pane or the end of its run, `cancelled` with its turn |

### server-to-client requests (FR-188)

| Name | Persisted | Payload |
| --- | --- | --- |
| `request.created` | yes | `ServerRequest` without resolution: `{requestId,kind,correlation,targetDeviceId?,payload,expiresAt}`; the envelope's correlation has `{threadId,turnId,runId,callId}` when known |
| `request.resolved` | yes | `{requestId,kind,resolvedBy,deviceId,result}` (`result` redacted). An approval answered as a request emits none: `approval.decided` is the signal |
| `request.expired` | yes | `{requestId,kind,fallback: notification\|none,reason: timeout\|cancelled}`; `cancelled` when its turn was cancelled. A request a restart left pending is expired at startup with reason `restart` and no event |

### runs, goals, agents, schedules

| Name | Persisted | Payload |
| --- | --- | --- |
| `run.created` | yes | `{runId,title,objective,autonomy,origin,budgets}` |
| `run.plan.proposed` | yes | `{runId,steps[]}` |
| `run.plan.amended` | yes | `{runId,steps[],reason}` |
| `run.step.started` | yes | `{runId,stepId,idx,title,status: running,detail}` |
| `run.step.completed` | yes | `{runId,stepId,idx,title,status: done\|failed\|skipped,detail}` |
| `run.subagent.spawned` | yes | `{runId,subagentId,threadId,role}` (when the child's first turn starts; a queued child has no thread yet) |
| `run.subagent.completed` | yes | `{runId,subagentId,status: done\|failed\|cancelled}` |
| `run.status.changed` | yes | `{runId,from,to,pauseReason?}` |
| `run.updated` | no | `{runId,run: RunView}` on every change of a run (M5: the Work views patch from it) |
| `run.budget.usage` | no | `{runId,usage:{tokens,timeSeconds,costUsd},budgets:{timeSeconds,tokens,costUsd}}` (live meters) |
| `run.budget.reached` | yes | `{runId,turnId,bound: time\|tokens\|cost\|backstop,summary}` (FR-182) |
| `run.budget.extended` | yes | `{runId,budgets,by}`; `by` is the request `{timeSeconds?,tokens?,costUsd?,steps?}`; the new `budgets` are the old ones plus `by` (cost only when the run has a cost cap) |
| `run.completed` | yes | `{runId,status: done\|output_missing\|failed\|cancelled,resultSummary,outputVerified}` (FR-187) |
| `goal.created` | yes | `{goalId,runId?,agentId?,objective,budgets}` (FR-181) |
| `goal.updated` | yes | `{goalId,changed[],progressNote?}` (any edit, including status); M5 `changed` values: `objective`, `budgets`, `status`, `progressNote`, `blocker`, `cleared` (the goal was cleared and its row deleted) |
| `goal.status.changed` | yes | `{goalId,from,to,setBy: user\|agent\|system,reason?,blocker?}`; `blocker` `{key,description}` when it becomes `blocked` |
| `schedule.fired` | yes | `{scheduleId,runId,kind: fire\|catch_up,manual?,window?}`; `manual: true` for Run now (actor `user`); `window` `{first,last,count}` for a catch-up; correlation `{runId,threadId}` |
| `schedule.catchup` | yes | `{scheduleId,runId?,policy: once\|skip,windowFrom,windowTo,missed,reason?}` (ADR-079); a skip carries `reason: policy\|lookback\|running` (`running`: the previous run was still going) and no `runId` |
| `schedule.completed` | yes | `{scheduleId,runId,outcome: done\|output_missing\|failed\|cancelled\|no_news,detail?}`: a fire settled after delivery (FR-187); `output_missing` also raises an `error` notification |
| `schedule.wake.set` | yes | `{scheduleId,agentId,at,reason}` (FR-206). Not in M5 |
| `schedule.created` / `.changed` / `.cancelled` | yes | `{scheduleId,origin}`; `.changed` adds `changed[]` (the fields sent) |
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
| `code.session.updated` | yes | `{sessionId}`: the session changed (an edit, a mode change, a commit); refetch it |
| `code.changes.updated` | yes | `{sessionId,files[]}`: a refresh found changed files (paths relative to the session folder); refetch the changes |
| `code.change.applied` | yes | `{sessionId,changeId,path,additions,deletions}`; M5 emits it when the user accepts hunks or a file |
| `code.change.reverted` | yes | `{sessionId,changeId}`; M5 emits it when the user rejects hunks or a file |
| `code.diff.commented` | yes | `{changeId,line,side}` |
| `code.test.completed` | yes | `{sessionId,status: passed\|failed\|timeout\|error,summary}` |
| `code.review.completed` | yes | `{sessionId,reviewId,status: done\|failed,findings}`; `findings` is their count (FR-069) |
| `code.commit.created` | yes | `{sessionId,sha,branch}` |
| `code.pr.opened` | yes | `{sessionId,url,number}`. Not in M5 |
| `code.pr.ci.changed` | yes | `{sessionId,status,checks[]}`. Not in M5 |
| `worktree.leased` | yes | `{worktreeId,repoPath,branch,sessionId,expiresAt}` (FR-073); M5 leases until the session is archived (`expiresAt: null`) |
| `worktree.released` | yes | `{worktreeId,sessionId,reason: done\|expired\|handoff\|removed}`; M5 sends `done` (the session was archived) |
| `devserver.started` / `.stopped` | yes | `{sessionId,id,url?}`. Not in M5 |

Code events carry `{threadId,sessionId}` in their correlation.

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
| `provider.account.activated` | yes | `{providerAccountId,provider}` (it became the active account of its kind, FR-115) |
| `account.updated` | yes | `{accountId,fields}`; `fields` lists what changed: `displayName`, `username`, `avatar` (FR-113) |
| `settings.changed` | yes | `{key,scope}` (security-relevant keys are audited) |
| `mcp.server.status.changed` | yes | `{serverId,name,status: disabled\|starting\|connected\|error\|stopped,error?}` (FR-043) |
| `audit.appended` | yes | `{auditId,kind,hash}` |
| `import.completed` | yes | `{importId,imported,duplicates,disabled,secretsMigrated}` (FR-200) |
| `flag.changed` | yes | `{key,stage,enabled,source}` (ADR-082) |
| `app.authorization.changed` | yes | `{authorizationId,kind: mcp_client\|app,clientName,status: active\|revoked}` (FR-192, FR-222) |

## Consumer rules

- **UI**: subscribes to the renderer-forwarded subset; never blocks on events. A client may
  opt out of event names it does not render (declared in `/api/v1/hello`,
  `contracts/hub-api.md` §7); persisted events stay replayable.
- **Activity view**: renders persisted events filtered by correlation id.
- **Audit**: mirrors security-relevant events (approvals, `policy.*`, `review.*`, `hook.*`,
  `request.*`, `ambient.grant.denied`, `app.authorization.changed`) into `audit_event` with a
  hash chain. Areas that act also append their own entries (the M4 and M5 actions are listed in
  `docs/06` §2, "audit & events"). M5 writes no audit entry for `request.*` yet.
- **Scheduler**: listens for `trigger.fired`, `schedule.fired`, `mcp.event.received` and
  `turn.completed` (goal continuation, FR-181).
- **M5 Hub areas**: the status service recomputes thread status on `approval.*`, `request.*`,
  `turn.*`, `run.*`, `goal.*`, `code.*` and `review.breaker.tripped`; the runs area pauses a run
  on `review.breaker.tripped` and follows `thread.status.changed`; the Code area refreshes changes
  on `tool.call.completed` of a code thread; `request.*` pauses a run's time budget while it
  waits for the user; `run.completed` ends the run's exec sessions.
- **Sync**: replicates persisted events that are marked syncable.
- Ordering is per-correlation; global order is not guaranteed. Consumers must be idempotent.

## Backpressure

- High-frequency ephemeral events (`chat.delta`, `tool.call.progress`, `browser.screenshot`,
  `run.budget.usage`) are coalesced and rate-limited (e.g., ≤ 60/s per stream; screenshots
  ≤ 1 per 2 s; budget meters ≤ 1/s).
- If a consumer is slow, ephemeral events are dropped (with a warning); persisted events are
  never dropped.
