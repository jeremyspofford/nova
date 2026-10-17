# 09 — Agent Runtime, Tasks & Scheduler

The agent runtime powers **Chat**, **Work** runs, **Code** sessions and **Agents**. There is one
runtime and one policy engine for every mode (ADR-076): Chat uses the same loop with chat
defaults and can escalate into an inline Work run (§13); Code adds a coding toolset and an
environment binding (`docs/10`). No third-party agent engine is embedded; external agents are
reachable only through policy-routed adapters (FR-203, P2).

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
   (one per run/agent)  (planning,          (tool + model      (cron/RRULE/interval,
                       delegation)         loop)              triggers, goals)
```

- **Supervisor** — one per Run/Agent; owns lifecycle, persistence, cancellation, approvals,
  budgets and the goal (§2.1).
- **Orchestrator** — turns an objective into a plan, delegates to sub-agents, aggregates.
- **Executor** — the model/tool loop for a single thread (§2).
- **Scheduler** — fires schedules, event triggers, self-set wakes and goal continuations;
  dedupes; computes catch-up (§6–7).

## 2. Core loop (executor)

A **turn** is one pass of the loop, started by one trigger and ending in one status.

```
turn(trigger):
  location ← route(...)        # fixed for the whole turn (FR-127)
  loop:
    1. Bounds: if a run budget (time, tokens, cost) or the 200-step per-turn backstop is
       reached → end the turn, pause the run with a progress summary and an offer to extend
       (FR-182)
    2. Drain steering input queued since the last model step; append it as user items (FR-019)
    3. Compact if a trigger applies (§11, FR-183)
    4. Build context (§11)
    5. Model stream → text + tool calls
    6. For each tool call:
         a. Validate args against schema
         b. policy.evaluate(...) → allow | ask | handoff | deny; hooks may then tighten it
            or answer an eligible ask, and the auto-reviewer may only tighten it (§10)
              - ask     → server-to-client request (§9, FR-188); await decision
                          (timeout → pause run)
              - handoff → emit request, pause until the user acts
              - deny    → return the denial result to the model
              - allow   → sandbox.execute(...) at the turn's execution location
         c. Persist tool_call + result; append the untrusted-labeled result
    7. If tool calls were made → next step
    8. Model would stop:
         a. Steering input arrived during the last step → next step
         b. Run Stop hooks (FR-197); a hook may request one continuation → this turn ends
            `completed` and a new turn starts with trigger `hook`, within the run budget
         c. Otherwise end the turn `completed` with a structured result
```

Rules:

- **Steering** (FR-019): input sent while a turn is running is either steered or queued, per the
  thread setting. Steered input is drained at step 2, at the start of the next model step,
  never inside a running tool call. Queued input starts the next turn (trigger `user`) after
  the current one ends. Both queues are persisted and survive a restart.
- **Execution location** (FR-127): the Hub resolves the node, device or environment when the
  turn starts and keeps it for every step of that turn. Hooks run where the turn executes. If
  the location is lost mid-turn, the turn ends `interrupted`; the next turn may route elsewhere.
- **Stop-hook continuation** (FR-197): at most one continuation per stop; each continuation is
  a new turn, counts against the run budget and is audited. Memory jobs (§5) ignore Stop-hook
  continuations.
- **Turn records**: every turn stores `trigger` (`user | schedule | goal | hook | event |
  channel`; `channel` is an addressed message on an agent's channel binding, `docs/13` §4) and
  `trigger_ref` (the schedule, goal, hook, trigger or channel-binding id), `status`
  (`in_progress | completed | interrupted | failed`), the execution location, step count,
  token, cost and time consumed, the stop reason (`end`, `budget`, `backstop`,
  `cancelled`, `approval_timeout`, `location_lost`, `error`) and its items (messages, tool
  calls, compactions, hook prompts). A user Stop ends the turn `interrupted`; partial results
  are kept.

Guarantees:

- **Bounded** (FR-182, ADR-058): Work runs, agent runs and Code sessions carry a time budget
  (default 60 min), a token budget (default 2,000,000) and a cost budget (default: the
  provider spend cap, FR-116). Every turn, including a chat turn, has a hard backstop of 200
  model steps. Reaching any bound pauses with a progress summary and an offer to extend it;
  nothing continues silently. Budgets and live consumption are shown in the run header.
- **Budget accounting**: tokens and cost come from the run's `usage_event` rows
  (`docs/07` §11), including every child run (§4). Time is wall-clock while a turn is in
  progress; time spent waiting for an approval or user input does not count.
- **Resumable**: every step is persisted; restart resumes from the last committed step.
- **Cancellable**: `AbortSignal` stops the loop; running exec sessions are killed (FR-184);
  partial results are retained.
- **Observable**: each step emits events consumed by Activity (FR-057).

### 2.1 Goals (FR-181)

A run or an agent may hold one **goal**: an objective (at most 4,000 characters) plus optional
token, time and cost budgets. Goal budgets cap the total of every turn and child run that
pursues the goal; without them, the run's or agent's budgets apply. Managed policy can set maxima.

| Status | Set by | Meaning |
| --- | --- | --- |
| `active` | the user (create, resume, edit); the agent via `goal.set` only when the user asked for a goal | Work continues, including idle continuation |
| `paused` | the user; the agent only on the user's explicit request | No continuation until resumed |
| `blocked` | the agent, only after the same blocker recurs on 3 consecutive goal turns | No continuation; the user sees the blocker |
| `usage_limited` | the system only, when a provider usage or rate limit stops progress | Continuation resumes when the limit resets |
| `budget_limited` | the system only, when a goal or run budget is reached | Resumes only after the user extends a budget |
| `complete` | the agent, with a completion summary; or the user | Continuation stops; the user can reopen |

- **Blocked rule** (enforced by the runtime, not the prompt): the agent records a blocker with
  `goal.update({blocker})` on a turn that cannot progress. The runtime counts consecutive goal
  turns (including continuations) that report the same blocker key and rejects `blocked` until
  the count reaches 3. Resuming a goal resets the count.
- **Idle continuation**: while a goal is `active` and its thread is idle (no turn in progress,
  no queued input, no pending request), the scheduler starts a continuation turn with trigger
  `goal` after a short debounce (default 5 s, so a user message takes precedence). The
  continuation prompt restates the objective, the remaining budget and the last progress note.
  Continuations respect budgets and quiet hours (FR-060).
- **Tools**: `goal.get`, `goal.set`, `goal.update` (status, progress note, blocker). Status
  changes the agent may not make are rejected with a tool error.
- **UI**: the run or agent header shows the objective (editable), the status chip, live budget
  meters, the last progress note and the actions Pause, Resume, Edit, Extend budget, Mark
  complete and Clear. Edits apply at the start of the next turn. Every edit emits
  `goal.updated`; every status change is audited and also emits `goal.status.changed`.

## 3. Planning

- The orchestrator produces a **plan** (ordered steps with rationale) for non-trivial tasks.
- Autonomy levels: `ask_first` (approve plan), `standard` (plan shown, proceeds), `autonomous`
  (no plan prompt; still subject to action policy).
- Plans are editable by the user before execution and can be amended mid-run.
- Re-planning occurs when a step fails or the environment changes; changes are announced.

## 4. Sub-agents, delegation & parallelism

- **Tools**: `task.spawn` creates a child thread with a role (e.g., `researcher`, `coder`,
  `critic`), a scoped objective and a tool subset; `task.message` sends it input;
  `task.wait` waits for one or more children (default 30 s, minimum 10 s, maximum 1 h);
  `task.list` and `task.cancel` manage them.
- **Limits** (defaults, configurable, lowerable by managed policy): depth 1 (children cannot
  spawn children), at most 6 children per run, 4 running concurrently (FR-053); further
  spawns queue. A limit violation returns a tool error.
- **Permissions**: children inherit a subset of the parent's permissions, never more. Their
  approvals surface in both the child thread and the parent.
- **Budgets**: child consumption counts against the parent's budgets; a child may be given a
  lower cap, never a higher one.
- **Visibility**: child threads appear in the sidebar and are steerable and cancellable
  (FR-054). Pausing the parent pauses its children (FR-090).
- **Aggregation**: the orchestrator merges results, detects conflicts, and produces one result.
- **Delegation** (FR-059): a chat, Work run or agent can start a Work run or a Code session in a
  chosen environment or device, passing context. The delegated work runs within the caller's
  policy scope, never a broader one, and its result returns to the caller as a structured
  item, marked succeeded only per FR-187. An agent can create or edit schedules
  (`schedule.create`; an edit carries the schedule's `id`, `contracts/schemas/schedule.json`)
  under the same policy; those schedules are attributed
  to the agent, listed in Scheduled and audited.
- **Explicit only**: delegation is always a visible tool call. Model presets never spawn
  sub-agents (FR-221). Delegating to an external agent follows FR-194; external coding agents
  are reachable only through FR-203 adapters (P2).

## 5. Memory

Three layers:

1. **Working memory** — the current thread context (messages + tool results).
2. **Durable memory** (`memory_item`) — the canonical, reviewable store of facts and
   preferences with scope, category and confidence (FR-032, ADR-069).
3. **Retrieval** — hybrid search (FTS + vector) over memory, messages, attachments and project
   files, plus ambient memory when capture is on (certified records only, through the typed
   ambient tools, `docs/24` §8); results injected with citations and a token budget.

**Consolidation** (FR-204, ADR-069) runs on the Hub as a background job in two phases:

1. **Per thread.** The job claims a bounded batch of threads that have been idle for at least
   the idle window (default 30 min) and are not claimed by another worker. It filters each to
   memory-relevant items and asks the memory model for candidate memories with a category.
   Secrets are redacted by the scrubber (`docs/12` §5) before anything is stored. Temporary
   chats (FR-027), incognito runs and shared threads (FR-217) are never read. Candidates from a
   `project_only` project stay in that project's scope.
2. **Global.** Under a single lock, candidates are merged into `memory_item` rows: deduped by
   embedding similarity, grouped into categories, and aged so that facts stay current (a plan
   becomes a past event once its date passes; a contradicted item is retired, with history
   kept). The job then rewrites the memory summary (at most 2,500 tokens), which is injected
   into context (§11). Items the user pinned or edited are never rewritten, only flagged.

Consolidation never creates, installs or edits skills; skill creation stays an L1 proposal that
needs approval (`docs/27` §3).

The Memory page groups items by category with correct, dismiss, pin and "remember more / less
about this topic" controls, plus "forget last N minutes".

**Scopes and history** (FR-205):

- Each project chooses `shared` or `project_only` memory at creation. Project-only items are
  never read outside the project; multi-user shared projects are always project-only.
- The **reference past chats** toggle controls retrieval over chat history independently of
  saved memories. Turning it off stops use at once and purges derived data (history
  embeddings, summaries) within 30 days.

**Agent memory** (FR-089): an agent's notes and conversation memory are visible and editable
in its profile, and items can be forgotten individually. Turning memory off for an agent
purges the notes derived from it. There are no hidden notes (ADR-080).

## 6. Scheduling (FR-055)

```ts
interface ScheduleSpec {                  // contracts/schemas/schedule.json
  id?: string;                            // an update carries id; a create carries when
  when?: { cron: string } | { rrule: string } | { intervalSeconds: number } // interval ≥ 60
       | { at: string };                  // one-shot fire, used by self-set wakes
  timezone: string;                       // IANA
  startsAt?: string; endsAt?: string;     // startsAt is the RRULE DTSTART
  instructions: string;                   // what to check/update (≤ 8,000 characters)
  notifyCondition?: string;               // "only if a deadline is at risk" (≤ 1,000 characters)
  deliveryTargets: DeliveryTarget[];      // {kind:'inapp'|'os'|'slack'|'teams'|'email'|'webhook', ref?}
  target?: { kind: 'run' } | { kind: 'agent'; agentId: string };
  output?: OutputDeclaration;             // {kind:'artifact'|'message'|'file', ref?}: verified for success (FR-187)
  catchUp?: { policy?: 'once' | 'skip'; lookbackSeconds?: number }; // defaults 'once', 604800 (7 days); ADR-079
  origin?: 'user' | 'agent' | 'agent_self'; // default 'user'; agent: schedule.create (FR-059); agent_self: schedule.wake
  wakeReason?: string;                    // required when origin is agent_self (≤ 500 characters)
  enabled?: boolean;                      // default true
}
```

- **Rules**: cron, RRULE (RFC 5545, `DTSTART` from `startsAt`) or a fixed interval, evaluated
  in the schedule's timezone. Times that do not exist at a DST change fire at the next valid
  instant; repeated times fire once.
- **Firing**: each fire starts a Work run, or a turn on the target agent, with trigger
  `schedule` and the schedule's instructions.
- **Catch-up** (ADR-079): when the Hub starts or wakes, missed fires inside the lookback window
  (default 7 days) collapse into **one** catch-up run per schedule, told the window it covers
  (first and last missed time, number of fires). With `skip`, no run starts and the misses are
  recorded. Misses older than the lookback are recorded as skipped. The schedule's history
  shows catch-up and skipped fires.
- **Self-set wakes** (FR-206): an agent can set its own next wake-up with
  `schedule.wake({at | in, reason})`. Limits: minimum interval 5 min, maximum horizon 30 days,
  at most 24 self-set wakes per agent per day (defaults). A violation returns a tool error.
  Self-set wakes appear in Scheduled marked "set by agent", can be edited or cancelled by the
  user, move to the end of quiet hours when they fall inside them, and are audited.
- **Verified outcomes** (FR-187): a scheduled job counts as succeeded (run status `done`) only
  when its declared output is verified: artifact saved, message delivered with a provider receipt, or file written and
  hashed. Otherwise it ends `output_missing` with the trace linked. A run whose notification
  condition is not met succeeds without delivery and its history says "no news".
- **Ambient data**: a schedule that reads ambient data needs a scoped grant (FR-233).
- **Management**: users can list, edit, pause and cancel; the UI shows next run, last run and
  last outcome.

## 7. Event triggers (FR-056)

- **Sources**: only sources that declare events can trigger work:
  - `schedule` — fired by the scheduler for a schedule (§6);
  - `webhook` — a Hub endpoint with a per-trigger token and signature check;
  - `connector_event` — events a connector declares (for example new Slack messages in a
    channel the user selects, or a GitHub event);
  - `mcp_event` — an MCP event subscription (FR-201): subscribed with a Hub webhook URL and
    secret, refreshed before expiry, unsubscribed on removal; deliveries must be signed and
    under 256 KiB;
  - `fs_change` — a path watcher on a device, through `novad`;
  - `email` — a label or filter on a connected mailbox.
- **No implicit watching**: joining a channel or connecting an account never creates a trigger.
  An agent added to a Slack channel replies when addressed through its channel binding
  (`docs/13` §4); watching the channel needs an explicit trigger.
- **Dedupe**: each trigger has a `dedupe_key` (for example the event id); MCP deliveries are
  deduped by id.
- **Action**: a trigger starts a Run or wakes an agent with a turn whose trigger is `event`.
- **Untrusted**: payloads are wrapped as untrusted input (FR-103), never count as user intent
  (FR-189), and cannot widen policy. An agent's own outbound actions never re-fire its
  triggers.

## 8. Agents (always-on agents)

An Agent is a long-lived supervisor with:

- **Responsibilities** (`agent_responsibility`) — ongoing goals; each may carry a goal (§2.1).
- **A cloud computer** — persistent environment + browser sessions (FR-080).
- **One connected computer** (FR-081) — a device running `novad`, one active connection per
  agent, granted from the agent's profile separately from other device grants, explicit and
  revocable. The Hub refuses devices below the minimum `novad` version for the requested
  capabilities. `novad` runs as a service, so no app has to stay open. Local browser fallback
  per FR-209.
- **Rules** (`agent_rule`) — act / act-on-request / ask / handoff (FR-084).
- **Memory** (`agent_memory`) — notes and learned preferences, visible and editable (§5,
  FR-089).
- **Channels** — in-app, Slack, Teams, email, webhooks; one thread per channel binding with
  shared agent memory (FR-088, `docs/13` §4).
- **Schedules, triggers and self-set wakes** — proactive work (§6–7).

### Proactive research (FR-082)

- Idle-driven: runs when the agent has no turn in progress and nothing pending, at most once
  per hour by default (configurable), and not during quiet hours.
- Uses a **read-only tool policy**: cannot send messages, modify app content, or control the
  browser/computer.
- Findings are written to the agent's notes (visible and editable) and brought to the user as
  suggestions. Any follow-up action goes through normal policy; proactive inputs are untrusted
  and suggestions never count as user intent (FR-189).
- Proactive turns count against the agent's budgets. Users can disable proactive research per
  agent.

### Background threads

The Agent can fan out work into cloud threads that appear in the sidebar, while keeping the
main conversation responsive. It coordinates their results and can message the user.

### Pause, stop and delete (FR-090)

- **Pause** stops the agent plus all its child runs, delegated runs, schedules and self-set
  wakes until resumed. Safety monitoring can auto-pause.
- **Stop** cancels the current work; partial results are kept.
- **Delete** is irreversible and does not undo actions already taken; the confirmation says
  so. It revokes the agent's grants, channel bindings, schedules and triggers.

### External agents (FR-194)

Content produced by other AI agents (email, chat, channels, pages, plugins, capture) is
untrusted data. A Nova agent does not accept tasks from, delegate to, or send data to an
external agent unless the user named that agent for the current task; other attempts are denied
and audited.

## 9. Activity & audit

- **Activity view** per run/agent: chronological steps, tool calls (collapsible I/O), diffs,
  approvals, and result; click any step to see raw inputs, outputs, and screenshots.
- Every step also writes an `audit_event` with a hash chain (FR-104).
- Runs are replayable in "dry-run" mode for review (no side effects).
- "Redirect" steers a running supervisor (FR-019); "Stop" cancels; "Pause" checkpoints and
  stops scheduling.

**Thread status** (FR-215): every thread, run, code session and agent shows one status, derived
from runtime state. The sidebar, tray and notifications use the same states, and "Needs input"
sorts first.

| Status | Derived when | Precedence |
| --- | --- | --- |
| Needs input | A server-to-client request or handoff is pending for it or any child | 1 |
| Blocked | It cannot proceed without a change by the user: goal `blocked`, `budget_limited` or `usage_limited`; last turn `failed`; environment down; auto-paused by safety monitoring | 2 |
| Running | A turn is `in_progress` for it or any child | 3 |
| Ready | Idle, with nothing pending (unread results and user pauses show as badges) | 4 |

**Server-to-client requests** (FR-188): approvals, questions to the user, MCP elicitations,
client-side tools and credential refreshes go over its stream to every connected, authorized
client that declared that request kind in its handshake; a request that names a
`targetDeviceId` (a client-side tool may) goes only to that device (`contracts/hub-api.md` §5). Each request has an id, a timeout and exactly one resolution; the first valid answer
wins and the other clients receive `request.resolved`. Unanswered requests fall back to
notifications (FR-060). Approval timeouts pause the run (default 24 h). Requests in the
`handoff_required` and `confirm_at_action` tiers (FR-189) can only be answered from an
authenticated Nova client, never from a channel.

## 10. Autonomy & safety integration

| Control | Applies to | Effect |
| --- | --- | --- |
| Code permission mode | Code sessions | Manual / Accept edits / Plan / Auto / Bypass, each a preset over an approval policy × a permission profile (FR-063, FR-190, ADR-059; `docs/10` §3) |
| Run autonomy | Work runs and agents | `ask_first` / `standard` / `autonomous`, presets over the approval policies `ask_always` / `defaults` / `review` with the run's or agent's permission profile (`docs/12` §2.1) |
| Agent custom rules | Agents | act / act-on-request / ask / handoff |
| Global policy rules | Everything | allow/ask/handoff/deny with scopes |
| Lifecycle hooks | Everything | Can block or add context; can answer an `ask` from a user rule or tool default (FR-197, ADR-068) |
| Auto-review | Consequential actions under the `review` approval policy (Auto mode, `autonomous` runs and agents); write actions on sites set to "Auto approve with review" | Model reviewer with a strict verdict; fail-closed (FR-085, ADR-061) |
| Built-in safety | Everything | non-overridable confirmation tiers (FR-189): secrets, purchases, CAPTCHA, credential changes |

- **Approval policy × permission profile** (ADR-059): the approval policy decides when to ask;
  the permission profile decides what the sandbox allows. After a sandbox denial, escalation
  happens only through a policy `ask`; the runtime never retries outside the sandbox on its own,
  and no allow rule removes the sandbox.
- **Order**: the deterministic policy engine (built-in safety, managed policy, rules, tool
  defaults, approval policy) decides first (`docs/12` §2.3). Hooks run after it: they can
  tighten any decision and may answer an `ask` that came from a user rule or a tool default.
  The auto-reviewer runs last and can only tighten. Neither can loosen built-in safety, managed
  policy, a `handoff` or a `deny` (ADR-061, ADR-068).
- Approvals always override autonomy: an `ask` decision pauses the run regardless of level.

## 11. Context assembly

Order (stable prefix for caching):

1. System prompt (Nova identity + safety + output rules)
2. Tool schemas (sorted deterministically). Over the tool budget, MCP and plugin tools are
   deferred behind `tool.search` (FR-196)
3. Skills catalog: names and descriptions only, at most 2 % of context and 10k tokens; a
   skill's body loads when it is mentioned or used (ADR-067)
4. Memory: the memory summary (≤ 2,500 tokens), pinned items, then retrieved items within
   budget, honouring project scope and the past-chats toggle (§5)
5. Instruction files (FR-185), project instructions + sources summary
6. Recent history, including compaction items
7. Current user turn + attachments
8. Environment block (cwd, OS, git state, time, execution location) — clearly delimited as data

**Instruction-file discovery** (FR-185):

- The project root is the nearest directory containing `.git`, or a configured root marker,
  found by walking up from the working directory. Root markers and the budget come from user
  or managed config only; project-level config cannot change them.
- Each directory from the root down to the working directory contributes at most one file, the
  first that exists of `.nova/instructions.md`, `AGENTS.md`, then configured fallback names.
  Fallback names must be plain filenames (no separators, drive letters or network prefixes).
- Files are concatenated root first, each under a heading naming its directory. They share a
  32 KiB budget; the file that overflows is truncated, later files are dropped, and the session
  shows a warning.
- Untrusted projects are skipped. Sub-agents inherit the same instructions.

**Compaction** (FR-183) has three automatic triggers, plus `manual` (the user, or the model
through `context.fresh`):

1. **Pre-turn**: before the first model step, when context exceeds the threshold (default 80 %
   of the model limit).
2. **Mid-turn**: when the next step would exceed the model limit and the model still needs
   steps.
3. **Post-turn**: after a turn that ends above the threshold, only when no input is queued.

Compaction summarizes older turns and keeps the system prompt, tools, memory summary, pinned
memory, instruction files, the goal, the latest user turn and any open tool calls. The model
has `context.remaining` (tokens and percent left) and `context.fresh` (compact now, carrying a
handoff note it writes). Each compaction is recorded as a `compaction` thread item (trigger,
tokens before and after, summary); the original messages stay in storage and are retrievable.
Pre- and post-compaction hooks run per FR-197.

## 12. Failure modes

| Failure | Behavior |
| --- | --- |
| Model error mid-run | Retry per provider rules; if persistent, pause run with error card |
| Tool crash | Isolate, return error result, continue if not required |
| Approval timeout | Pause run (default 24 h), notify, resume on decision |
| Budget or backstop reached | End the turn and pause with a progress summary; offer to extend the bound that was hit (time, tokens, cost or the 200-step backstop); never continue silently (ADR-058). A goal moves to `budget_limited` |
| Provider usage limit | Pause; a goal moves to `usage_limited` and continuation resumes when the limit resets |
| Goal blocked | After the same blocker on 3 consecutive goal turns: status `blocked`, continuation stops, thread shows Blocked, the user is notified with the blocker; resuming resets the count |
| Auto-review unavailable | Timeout (90 s), malformed output or error ends as **deny** after up to 3 attempts; 3 consecutive denials or 10 in the last 50 reviews interrupt the run (FR-085) |
| Execution location lost mid-turn | Turn ends `interrupted`; the next turn may route elsewhere (FR-127) |
| Declared output missing | Job ends `output_missing` with the trace linked (FR-187) |
| Sandbox unavailable | Fail closed; offer a degraded read-only mode |
| Scheduler missed fire | One catch-up run per schedule covering misses within the lookback (default 7 days), told the window it covers; `skip` records the misses without running (ADR-079) |

## 13. Chat escalation & deep research

**Chat escalation to Work** (FR-186, ADR-077): when a chat request needs multi-step tool work,
the assistant turns it into a Work run shown inline in the chat: a plan card, live progress and
a result card, with no mode switch. The setting is `propose` (default: the user accepts the
plan card first), `auto` (the run starts at once, still under its autonomy level and policy) or
`off`. The run keeps the chat's context and policy scope, gains run budgets (§2), appears in the
Work list and links back to the chat.

**Deep research run** (FR-220): a Work run template that:

1. plans sub-questions (shown as a checklist the user can edit);
2. gathers sources through researcher sub-agents (§4 limits) with read-only tools: web search
   (FR-029), connectors and project files;
3. produces a cited report artifact with a source list, where each claim links to its source.

Progress per sub-question is viewable; the run can be steered or stopped at any time, keeping a
partial report. It succeeds only when the report artifact is saved (FR-187).
