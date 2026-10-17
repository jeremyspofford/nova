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
| `turn.started` | yes | `{threadId,turnId,idx,trigger: user\|schedule\|goal\|hook\|event\|channel,executionLocation,triggerRef?,runId?}`; `triggerRef` is the schedule, goal, hook or run behind it (M5 run and sub-agent turns use trigger `user` with the run id); a turn of a run carries `runId` in its correlation too, as do its message, compaction and end events. M6: trigger `channel` names the channel binding; trigger `event` names the trigger of a wake, or is `pr:<id>` (CI failure fed back) or `verify:<sessionId>` (auto-verify failure fed back); an agent's proactive research uses trigger `schedule` with `triggerRef` `proactive:<agentId>` |
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
| `goal.created` | yes | `{goalId,runId?,agentId?,objective,budgets}` (FR-181); an agent's goal (M6) has correlation `{threadId,agentId}` (its main thread) and actor `system` when the agent set it with `goal.set` |
| `goal.updated` | yes | `{goalId,changed[],progressNote?}` (any edit, including status); M5 `changed` values: `objective`, `budgets`, `status`, `progressNote`, `blocker`, `cleared` (the goal was cleared and its row deleted) |
| `goal.status.changed` | yes | `{goalId,from,to,setBy: user\|agent\|system,reason?,blocker?}`; `blocker` `{key,description}` when it becomes `blocked` |
| `schedule.fired` | yes | `{scheduleId,runId,kind: fire\|catch_up,manual?,window?}`; `manual: true` for Run now (actor `user`); `window` `{first,last,count}` for a catch-up; correlation `{runId,threadId}`. An agent's schedule (M6) fires a turn on its main thread: `runId: null`, plus `agentId` and `threadId`, correlation `{threadId,agentId}`; its `schedule.catchup` has no `runId` and its `schedule.completed` `runId: null` |
| `schedule.catchup` | yes | `{scheduleId,runId?,policy: once\|skip,windowFrom,windowTo,missed,reason?}` (ADR-079); a skip carries `reason: policy\|lookback\|running` (`running`: the previous run was still going) and no `runId` |
| `schedule.completed` | yes | `{scheduleId,runId,outcome: done\|output_missing\|failed\|cancelled\|no_news,detail?}`: a fire settled after delivery (FR-187); `output_missing` also raises an `error` notification |
| `schedule.wake.set` | yes | `{scheduleId,agentId,at,reason}` (FR-206): an agent set its own wake (`schedule.wake`); correlation `{agentId}`; actor `agent:<id>` |
| `schedule.created` / `.changed` / `.cancelled` | yes | `{scheduleId,origin}`; `.changed` adds `changed[]` (the fields sent). M6: `origin` adds `agent` and `agent_self`; the payload adds `agentId` (null for a schedule of no agent) and an agent's schedule has correlation `{agentId}`; actor `agent:<id>` when the agent made the change |
| `trigger.fired` | yes | `{triggerId,kind,dedupeKey}`: a run or wake started (not for duplicates, skips or failures); actor `system`; correlation `{runId?,threadId?,turnId?,agentId?}` |
| `trigger.changed` | yes | `{triggerId,kind,change: created\|updated\|deleted}` (FR-056, M6); actor `user`; correlation `{agentId}` for an agent's trigger. Not emitted when removing a subscription or its server turns the trigger off |
| `mcp.event.received` | yes | `{subscriptionId,triggerId,eventName,deliveryId,duplicate,sizeBytes}` (FR-201): every signed delivery accepted, a repeat too (`duplicate: true`, starts nothing); refused deliveries emit nothing |
| `mcp.subscription.changed` | yes | `{subscriptionId,status: pending\|active\|refreshing\|lapsed\|failed\|removed,expiresAt?}`; `removed` (actor `user`) when its trigger or the subscription is deleted |
| `memory.consolidated` | yes | `{runId,scope: {kind,ref},phase,status,created,updated,aged,summaryTokens}` (FR-204) |
| `memory.item.created` / `.updated` / `.deleted` | yes | `{itemId,scopeKind}` (FR-032); M6 adds `scopeKind: agent` (an agent's conversation memory), correlation `{agentId}` |

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
| `code.push.completed` | yes | `{sessionId,remote,branch,sha}` (FR-070, M6) |
| `code.pr.opened` | yes | `{sessionId,url,number}` (FR-070): the session recorded a pull request (created, or found open on the host) |
| `code.pr.ci.changed` | yes | `{sessionId,status: none\|queued\|running\|passed\|failed,checks: [{name,status: queued\|running\|completed,conclusion,url}],state: open\|closed\|merged}`: a poll or refresh found a new CI status or pull request state; `code.session.updated` follows. M6 adds `state` and the per-check fields |
| `code.verify.started` | yes | `{sessionId,verifyId,trigger: auto\|manual}` (FR-068, M6) |
| `code.verify.completed` | yes | `{sessionId,verifyId,trigger,status: passed\|failed\|error\|skipped,checks: [{name,status: passed\|failed\|timeout\|error\|skipped,exitCode}]}` |
| `worktree.leased` | yes | `{worktreeId,repoPath,branch,sessionId,expiresAt}` (FR-073); M5 leases until the session is archived (`expiresAt: null`). M6 also sends it for a registry worktree created with a session, each renew (`expiresAt` from `ttlMinutes`) and a session binding `worktreeId` |
| `worktree.released` | yes | `{worktreeId,sessionId,reason: done\|expired\|handoff\|removed}`; `done` (the release route, or the session was archived) and, since M6, `expired` (the 5-minute sweep). `handoff` and `removed` are not sent; removing a worktree sends no event |
| `code.devserver.started` | yes | `{sessionId,serverId,url,port,label}` (FR-097, M6) |
| `code.devserver.stopped` | yes | `{sessionId,serverId,exitCode}`; `exitCode` is null when Nova stopped it |
| `environment.updated` | yes | `{environmentId,change: created\|updated\|removed}` (FR-062, M6); actor `system`; no correlation |
| `environment.health.changed` | yes | `{environmentId,status: ok\|degraded\|down\|unknown,detail}`: a check changed a non-local environment's status; `detail` redacted, ≤ 1,000 characters; no correlation |

Code events carry `{threadId,sessionId}` in their correlation; the registry's `worktree.*`
events carry `{sessionId}` only and `environment.*` none. `code.session.updated` also follows a
budget extend or a budget reached, a container setup script ending, a new branch and a CI change.

### agents (M6)

Agent events carry `{agentId}` in their correlation (`threadId` where noted). All persisted.

| Name | Persisted | Payload |
| --- | --- | --- |
| `agent.created` / `.deleted` | yes | `{agentId}` (FR-079, FR-090); actor `user` |
| `agent.updated` | yes | `{agentId,changed[]}`: `name`, `instructions`, `autonomy`, `budgets`, `proactive`, `model`, `avatar`, `memoryEnabled` |
| `agent.paused` / `.resumed` | yes | `{agentId}`; `.paused` adds `reason: user\|safety` (the kill key and a takeover pause with `user`) |
| `agent.status.changed` | yes | `{agentId,from,to: active\|paused\|stopped,reason}`; `reason` is the pause detail, `stopped by the user`, or null; there is no `agent.stopped` |
| `agent.rule.changed` | yes | `{agentId,ruleId,change: created\|updated\|deleted,description}` (FR-084) |
| `agent.responsibility.changed` | yes | `{agentId,responsibilityId,change: created\|updated\|deleted\|progress}`; `progress` from `agent.progress` (actor `agent:<id>`) |
| `agent.note.created` | yes | `{agentId,noteId,kind: note\|fact\|preference\|observation,author: user\|agent}` (FR-089) |
| `agent.note.updated` / `.deleted` | yes | `{agentId,noteId}` |
| `agent.memory.purged` | yes | `{agentId,notes,items}`: what turning memory off deleted |
| `agent.research.finding` | yes | `{agentId,findingId,summary}` (FR-082): `findingId` is the observation note (the suggestion when memory is off) |
| `agent.suggestion.created` | yes | `{agentId,suggestionId,title}`; correlation `{agentId,threadId}`; actor `agent:<id>` |
| `agent.suggestion.updated` | yes | `{agentId,suggestionId,status: accepted\|dismissed}` |
| `agent.budget.reached` | yes | `{agentId,threadId,turnId,bound: time\|tokens\|cost}`: a turn chain used up the agent's (or its goal's) budget; actor `system` |
| `agent.background.started` | yes | `{agentId,runId,threadId,title}` (FR-083): `agent.delegate` started a Work run |

M6 emits no `thread.status.changed` with `ref.kind: agent`: an agent's derived status is computed
when its view is read.

### channels & notifications (M6)

| Name | Persisted | Payload |
| --- | --- | --- |
| `channel.binding.changed` | yes | `{bindingId,kind,change: created\|updated\|connected\|disconnected\|removed}` (FR-088); actor `user`; correlation `{agentId}` for an agent's binding |
| `channel.message.received` | yes | `{bindingId,from,threadId}`: an inbound message started a turn; `from` is the sender's external id; actor `system`; correlation `{threadId,turnId,agentId?}` |
| `channel.message.sent` | yes | `{bindingId,to,threadId}`: a message was posted (a reply, an approval prompt, a test, a notification copy, a schedule delivery, `channel.send`); `to` is the conversation; `threadId` null when there is none |

### computers, browser & screen (M6)

| Name | Persisted | Payload |
| --- | --- | --- |
| `computer.state.changed` | yes | `{computerId,from,to}`; M6 writes `running` (a command or a file write) and `stopped`; `degraded` and `error` are computed for the view, never emitted |
| `computer.snapshot.created` | yes | `{computerId,snapshotId,label}` (FR-080) |
| `computer.restored` | yes | `{computerId,snapshotId}` |
| `computer.takeover.started` | yes | `{computerId,actor: user,takeoverId,surface: desktop\|browser}` (FR-087) |
| `computer.takeover.ended` | yes | `{computerId,actor: user\|system,takeoverId,surface,reason: returned\|restart,inputs}`; `system` and `restart` for a takeover a restart left open |
| `egress.policy.changed` | yes | `{scope: {kind: run\|session\|agent\|plugin\|mcp_server,id}}` (FR-193): a scope's policy was set or removed |
| `screen.control.changed` | yes | `{computerId,from,state: disabled\|idle\|controlling\|stopped\|taken_over}` (FR-093, FR-207): enable, disable, kill, resume, a grant made, renewed or revoked, a takeover; never when a grant expires |
| `screen.grant.changed` | yes | `{computerId,grantId,app,status: active\|revoked,expiresAt}` |
| `screen.action` | yes | `{computerId,actionId,kind: click\|scroll\|type\|key\|drag,origin: tool\|takeover,app,status: ok\|refused\|failed\|stopped,error}` (FR-098); `error` is a code or null; actor the action's; correlation `{threadId,turnId,callId}` when known |
| `browser.session.changed` | yes | `{computerId,state: starting\|running\|paused\|closed\|error,pausedBy}` (FR-092) |
| `browser.navigated` | yes | `{computerId,url,allowed}`; `url` without query or fragment; `allowed: false` when refused, denied, handed off or failed; correlation `{threadId?,turnId?,callId}` |
| `browser.action` | yes | `{computerId,actionId,tool,action,target,result: ok\|error\|blocked\|denied\|handoff,before,after}`; `before` and `after` say whether a screenshot exists (M6 adds `actionId`, `action`, `before`, `after`); tool `devserver.open` is the browser pane opening a Code session's granted dev server for the user |
| `browser.screenshot` | no | `{computerId,actionId}` (M6: no blob path); `actionId` null when recording failed |
| `signin.requested` | yes | `{computerId,host,signinId}` (FR-086); correlation `{callId,threadId?,turnId?}` |
| `signin.completed` | yes | `{computerId,host,savedCredential}`; actor `user` |
| `signin.cancelled` | yes | `{computerId,host,reason: cancelled\|expired}` (M6) |

### devices (M6, `docs/23`)

All persisted. `deviceId` is in the payload. Events of the REST routes have no correlation and
actor `system`; an agent's connected computer sets `{agentId}` (actor `agent:<id>`), a Code
device environment `{sessionId,threadId}`.

| Name | Persisted | Payload |
| --- | --- | --- |
| `device.registered` | yes | `{deviceId,name,roles,novadVersion}` (FR-141) |
| `device.status.changed` | yes | `{deviceId,from,status: active\|unreachable\|revoked}` |
| `device.capabilities.changed` | yes | `{deviceId,novadVersion,previousVersion}` (a heartbeat reported a new version) or `{deviceId,novadVersion,modules}` (a stored document's modules or version changed) (FR-142) |
| `device.module.changed` | yes | `{deviceId,module,kind,state: running\|stopped\|backoff\|disabled\|null,restarts,exit,reason}`; `kind` is what the device reported (`started\|stopped\|restarted\|crashed\|disabled\|refused`) or the Hub's action (`start\|stop\|restart\|rollback`) |
| `device.service.changed` | yes | `{deviceId,service,action: start\|stop\|restart,state}` (FR-145) |
| `device.overrides.changed` | yes | `{deviceId,pushed}` (FR-142, FR-150) |
| `device.power.requested` | yes | `{deviceId,action: wol-enable\|sleep\|restart\|shutdown,applied}` (FR-144) |
| `device.wake.sent` | yes | `{deviceId,wakeRequestId,mac,status: sent\|failed}` |
| `device.update.result` | yes | `{deviceId,target,from,to,channel,status: applied\|staged\|rolled_back\|refused\|failed}` (FR-148), one per pushed bundle |
| `device.access.requested` | yes | `{deviceId,requestId,grantee: {kind,id},path,access: read\|write,approvalId}` (FR-210); `approval.requested` (scope `device:<deviceId>`, tier `confirm_at_action`) goes with it |
| `device.access.decided` | yes | `{deviceId,requestId,status: granted\|denied,decidedBy: device\|hub}`; a decision made on the device also emits `approval.decided` with `decidedBy: "device:<deviceId>"` |
| `device.grant.revoked` | yes | `{deviceId,grantId}` |
| `device.write.staged` | yes | `{deviceId,stagedId,path,additions,deletions,sessionRef}` |
| `device.write.committed` | yes | `{deviceId,stagedId,path,sha256}` |
| `device.write.discarded` | yes | `{deviceId,stagedId}` |
| `device.write.conflict` | yes | `{deviceId,stagedId,path}` |
| `device.connection.changed` | yes | `{connectionId,agentId,deviceId,status: active\|revoked}` (FR-081); correlation `{agentId}` |

### spaces & sites (M6)

All persisted. Events the user causes have actor `user` and no correlation. A page change by an
agent (`page.edit`, `page.comment`, and the page event of an accepted proposal, which keeps the
agent as author) has actor `system` and correlation `{threadId,turnId}` when known.

| Name | Persisted | Payload |
| --- | --- | --- |
| `space.created` / `.updated` / `.deleted` | yes | `{spaceId}` (FR-036) |
| `space.page.created` / `.updated` / `.deleted` | yes | `{spaceId,pageId,version,authorKind: user\|agent}`; `.updated` also follows a restore, an accepted proposal and a position or slug change (same version) |
| `space.comment.created` / `.updated` / `.deleted` | yes | `{spaceId,pageId,commentId}`; `.updated` is a resolve or reopen |
| `space.proposal.created` | yes | `{spaceId,pageId,proposalId,status: open}`; `pageId` null for a proposed new page |
| `space.proposal.decided` | yes | `{spaceId,pageId,proposalId,status: accepted\|rejected}`; not sent when deleting a page or space rejects its open proposals |
| `site.created` / `.updated` / `.deleted` | yes | `{siteId}` (FR-037) |
| `site.version.created` | yes | `{siteId,version}` |
| `site.published` | yes | `{siteId,version,target: {kind: folder,folder}\|{kind: zip}}` |
| `site.unpublished` | yes | `{siteId,version}`: the version live after the undo, `null` when nothing is published |

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
| `notification.created` | yes | `{notificationId,kind,title,os}`; a repeat with the same dedupe key while unread updates the notification and emits nothing. `os` (M6) says whether a client may raise it on the OS now: false when the category's in-app or OS rule is off or quiet hours are in force (unless the rule bypasses them); clients skip the OS notification then (FR-060) |
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
  hash chain. Areas that act also append their own entries (the M4, M5 and M6 actions are listed
  in `docs/06` §2, "audit & events"). M5 writes no audit entry for `request.*` yet.
- **Scheduler**: listens for `trigger.fired`, `schedule.fired`, `mcp.event.received` and
  `turn.completed` (goal continuation, FR-181).
- **M6 Hub areas**: the agents area listens for `approval.requested` (a proactive research turn
  that asks for an approval is stopped) and `goal.status.changed` (an agent's goal continues or
  stops); the devices area answers `approval.decided` for folder-access cards; the Activity trace
  turns `browser.navigated`, `browser.action` and `screen.action` into `computer` items with
  screenshot links. Every audit entry also emits `audit.appended`, so each proxied network
  request adds a persisted event.
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
