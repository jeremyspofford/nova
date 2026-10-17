---
status: accepted
date: 2026-10-17
supersedes: ADR-090 (the bullet on `review` with no reviewer configured)
---

## Context
M5 built Work runs with goals, budgets and sub-agents, chat escalation, schedules with delivery,
Code sessions, model-based auto-review, server-to-client requests, the thread status service,
compaction, instruction files, interactive exec sessions, document outputs and plugin drafts.
Building them settled choices the spec left open. One changes ADR-090, and two amend ADR-061 and
ADR-083 until later work lands. The full list is the ADR-092 entry in
[`../20-decisions-and-defaults.md`](../20-decisions-and-defaults.md).

## Decision
- One runtime (ADR-076) is realized through two seams of the chat loop. `TurnStarter`
  (`ChatService.turnStarter`) starts turns for runs, schedules, goals, sub-agents and Code
  sessions; `TurnExtension` (`ChatService.useExtension`) adds a mode's context, bounds and end
  handling to each turn on its threads.
- Tool listings carry the thread scope (`ToolListScope {threadId, mode}`): run tools only in run
  threads, `work.start` only in chats, Code tools only in Code threads, `ask_user` only in Work
  and Code threads. Handlers still refuse calls outside their threads.
- Code sessions (permission mode) and runs (autonomy) are per-thread policy sources. The first
  source that knows a thread wins; the gate and the tool scope read the same sources, so the roots
  the tools get are the roots the gate checks; a source that throws denies.
- `review` with no reviewer model denies. ADR-090 said it asked every time. The Hub always wires a
  reviewer, and a reviewer with no `review.model` fails closed like one that times out.
- The reviewer is one model call with no tools. ADR-061 placed it in a read-only sandbox; with no
  tools there is nothing for a sandbox to confine, and the reviewer can read nothing beyond the
  context it is given.
- Instruction files from a folder the user added are trusted until a project-trust step exists.
  ADR-083 asked the user to confirm a project on first open; ADR-091 already treated registered
  folders as trusted for hooks.
- Document outputs (FR-219) are built-in tools that run in the Hub process, not skills run
  through `exec.run` in the sandbox. They run no code and import nothing that reaches the network,
  so the sandbox's guarantees hold anyway.
- Memory consolidation reads only the messages the user typed into a conversation, plus Nova's
  replies. Run objectives, schedule fires, goal continuations, sub-agent tasks, hook and Nova
  messages are skipped, so text the user did not write never becomes a memory about the user.
- The global event stream and the WebSocket deliver only the signed-in account's events. An
  authenticated `POST /api/v1/hello` negotiates server-request kinds; `GET /api/v1/hello` stays
  public.
- Time waiting for the user's answer does not count against a run's time budget, a run's exec
  sessions are killed when it ends, and runs resume after a Hub restart.

## Consequences
An autonomous Work run or an Auto Code session needs `review.model`: without it, every
consequential action would be denied instead of asked, so Auto cannot be picked and the Hub
refuses to create an autonomous run without one (`validation`, `review_model_required`; the New
run dialog says so first). The reviewer cannot look anything up, so its verdict rests on the instructions and
summary it is given. A folder the user adds can steer the model through its `AGENTS.md` without a
separate trust prompt; managed policy and the folder refusals still apply. Large documents block
the Hub's main thread briefly (about a second for a 100,000-row workbook); a worker can come later.
The items listed as "Not in M5" in the docs/20 entry are follow-ups, among them dictation and
realtime voice, image generation without a provider images call, the PR flow, the worktree
registry and a way to reveal a schedule's webhook secret.
