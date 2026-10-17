# 09 — Agent Runtime, Tasks & Scheduler

The agent runtime powers **Work** runs and **Agents**. Chat uses a lightweight subset (single
turn + tools). Code uses the same runtime with a coding toolset and environment binding.

## 1. Runtime model

```
                    ┌──────────────────────────────────────────┐
                    │                agentd                     │
                    │  worker pool (default 4)                  │
                    └───────┬──────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┬─────────────────┐
        ▼                   ▼                   ▼                 ▼
   Supervisors       Orchestrator        Executors          Scheduler
   (one per run/agent)  (planning,          (tool + model      (cron + event
                       delegation)         loop)              triggers)
```

- **Supervisor** — one per Run/Agent; owns lifecycle, persistence, cancellation, approvals.
- **Orchestrator** — turns an objective into a plan, delegates to sub-agents, aggregates.
- **Executor** — the model/tool loop for a single thread (bounded iterations, budget).
- **Scheduler** — fires cron and event triggers, dedupes, and starts runs.

## 2. Core loop (executor)

```
loop (max_steps, budget):
  1. Build context: system + instructions + memory + history + tool schemas + environment
  2. Model stream → text + tool calls
  3. For each tool call:
       a. Validate args against schema
       b. policy.evaluate(...) → allow | ask | handoff | deny
            - ask     → emit approval, await decision (timeout → pause run)
            - handoff → emit request, pause until user acts
            - deny    → return denial result to the model
            - allow   → sandbox.execute(...)
       c. Persist tool_call + result; append untrusted-labeled result
  4. If no tool calls and stop reason == end → finish with structured result
  5. Else continue until max_steps or budget exhausted → pause with a summary
```

Guarantees:

- **Bounded**: default `max_steps = 60`, `max_wall_clock = 60 min`, `max_tokens` per run cap.
- **Resumable**: every step is persisted; restart resumes from the last committed step.
- **Cancellable**: `AbortSignal` stops the loop; partial results retained.
- **Observable**: each step emits events consumed by Activity (FR-057).

## 3. Planning

- The orchestrator produces a **plan** (ordered steps with rationale) for non-trivial tasks.
- Autonomy levels: `ask_first` (approve plan), `standard` (plan shown, proceeds), `autonomous`
  (no plan prompt; still subject to action policy).
- Plans are editable by the user before execution and can be amended mid-run.
- Re-planning occurs when a step fails or the environment changes; changes are announced.

## 4. Sub-agents & parallelism

- `task.spawn` creates a child thread with a role (e.g., `researcher`, `coder`, `critic`),
  a scoped objective, and a tool subset.
- Default concurrency 4 (configurable). Sub-agents report structured results to the parent.
- Child threads are visible and steerable (FR-054); they inherit a *subset* of permissions,
  never more than the parent.
- Aggregation: the orchestrator merges results, detects conflicts, and produces one result.

## 5. Memory

Three layers:

1. **Working memory** — the current thread context (messages + tool results).
2. **Durable memory** (`memory_item`) — extracted facts/preferences with scope + confidence;
   user-reviewable and editable (FR-032/089).
3. **Retrieval** — hybrid search (FTS + vector) over memory, messages, attachments, and
   project files; results injected with citations and a token budget.

Extraction runs as a background job after each turn/run: propose items → dedupe by embedding
similarity → store with `confidence` → surface in the Memory panel. Temporary chats and
incognito runs are excluded. Users can pin, edit, revoke, or "forget last N minutes".

## 6. Scheduling (FR-055)

```ts
interface ScheduleSpec {
  when: { cron: string } | { intervalSeconds: number };
  timezone: string;              // IANA
  startsAt?: string; endsAt?: string;
  instructions: string;          // what to check/update
  notifyCondition?: string;      // "only if a deadline is at risk"
  deliveryTargets: DeliveryTarget[]; // {kind:'inapp'|'os'|'slack'|'email'|'teams', ref}
  target: { kind: 'run' } | { kind: 'agent'; agentId: string };
}
```

- Cron evaluated in the user's timezone; DST handled by the scheduler (see §7).
- Each firing creates a Run (or wakes the Agent) with the schedule's instructions.
- Results are delivered per `deliveryTargets`; a run with no delivery silently logs unless it
  has news, per `notifyCondition`.
- Users can list/edit/pause/cancel; the UI shows next/last run.

## 7. Event triggers (FR-056)

- Kinds: `webhook` (a local HTTP endpoint with a token), `slack` (message/mention/channel),
  `email` (label/filter), `fs_change` (path watcher), `connector_event` (polling adapters).
- Each trigger has a `dedupe_key` (e.g., event id) to prevent double-firing.
- Triggers can start a full Run or send a message to a Agent.
- All trigger payloads are treated as untrusted input.

## 8. Agents (always-on agents)

A Agent is a long-lived supervisor with:

- **Responsibilities** (`agent_responsibility`) — ongoing goals.
- **A cloud computer** — persistent environment + browser sessions (FR-080).
- **Optional connected user computer** — one at a time (FR-081).
- **Rules** (`agent_rule`) — act / act-on-request / ask / handoff (FR-084).
- **Memory** (`agent_memory`) — notes and learned preferences (FR-089).
- **Channels** — in-app, Slack, Teams, email, webhooks (FR-088).
- **Schedules & triggers** — proactive work.

### Proactive research (FR-082)

- Runs on a low-frequency cadence (default: hourly, configurable) and after relevant events.
- Uses a **read-only tool policy**: cannot send messages, modify app content, or control the
  browser/computer.
- Produces candidate "findings"; the Agent decides whether to surface, and any follow-up action
  goes through normal policy.
- Users can disable proactive research per Agent.

### Background threads

The Agent can fan out work into cloud threads that appear in the sidebar, while keeping the
main conversation responsive. It coordinates their results and can message the user.

## 9. Activity & audit

- **Activity view** per run/agent: chronological steps, tool calls (collapsible I/O), diffs,
  approvals, and result; click any step to see raw inputs, outputs, and screenshots.
- Every step also writes an `audit_event` with a hash chain (FR-104).
- Runs are replayable in "dry-run" mode for review (no side effects).
- "Redirect" injects a new instruction into a running supervisor; "Stop" cancels; "Pause"
  checkpoints and stops scheduling.

## 10. Autonomy & safety integration

| Control | Applies to | Effect |
| --- | --- | --- |
| Code permission mode | Code sessions | Manual/Accept edits/Plan/Auto/Bypass |
| Run autonomy | Work runs | ask-first / standard / autonomous |
| Agent custom rules | Agents | act / act-on-request / ask / handoff |
| Global policy rules | Everything | allow/ask/handoff/deny with scopes |
| Built-in safety | Everything | non-overridable (secrets, purchases, CAPTCHA, password change) |

Approvals always override autonomy: an `ask` decision pauses the run regardless of level.

## 11. Context assembly

Order (stable prefix for caching):

1. System prompt (Nova identity + safety + output rules)
2. Tool schemas (sorted deterministically)
3. Skill instructions (active skills)
4. Memory (pinned first, then retrieved by relevance within budget)
5. Project instructions + sources summary
6. Recent history (with summarization/compaction when over budget)
7. Current user turn + attachments
8. Environment block (cwd, OS, git state, time) — clearly delimited as data

**Compaction**: when context exceeds 80% of the model limit, older turns are summarized into
a `summary` message; the original messages remain in storage and are retrievable.

## 12. Failure modes

| Failure | Behavior |
| --- | --- |
| Model error mid-run | Retry per provider rules; if persistent, pause run with error card |
| Tool crash | Isolate, return error result, continue if not required |
| Approval timeout | Pause run (default 24 h), notify, resume on decision |
| Budget exceeded | Pause with progress summary; offer to continue with a raised cap |
| Sandbox unavailable | Fail closed; offer a degraded read-only mode |
| Scheduler missed fire | Run once on wake if within grace window (default 15 min) and not superseded |
