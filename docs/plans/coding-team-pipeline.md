# Coding team pipeline — roles as stages, not agents

Implementation plan (authored 2026-07-24 with Fable). Status: PROPOSED —
needs Jeremy's sign-off.

Jeremy wants software built with team rigor: PM, architect, UI/UX, data,
frontend/backend engineers, QA, security, code review, browser
verification, CI/CD. The locked decision (Jeremy, 2026-07-24) is that
these roles become **stages of a backend state machine driving ACP
sessions**, not a committee of conversing Nova agents. This spec is the
team layer ON TOP of `docs/plans/acp-coding-delegation.md` — read that
first; it defines the coder sidecar, the session broker, workspaces, and
the delegation builtins this plan orchestrates. Nothing here changes the
ACP substrate; it sequences it.

Why not agents: dispatch depth is hard-capped at 1 (a sub-agent cannot
convene sub-agents), local models run 30-50 tok/s so every gratuitous
LLM round-trip costs real minutes, and the house rule is that
orchestration lives in tables + the scheduler, not agent-to-agent chat.
A "team meeting" of Nova agents would be slow theatre. A stage machine
where each stage is one focused ACP session with a role prompt is fast,
auditable, and mechanically checkable (RED tests, GREEN tests, diff
paths) — the checks that matter are not LLM judgments at all.

## What exists (verified in code, 2026-07-24)

- **The ACP substrate (spec only, not yet built)** —
  `docs/plans/acp-coding-delegation.md` defines: the `coder` sidecar
  (compose service, no published ports, holds NO Nova secrets —
  acp-coding-delegation.md:36-49); the session broker's fixed verbs
  `POST /session`, `GET /session/<id>`, `POST /session/<id>/kill`
  (:42-46); a `workspaces` table (path, name, enabled — :50-52); a
  fresh worktree per session under `.worktrees/nova/<task-slug>`
  (:52-54); sessions never touch main, never push — merge is always
  the operator's move (:55-57); the sandboxed-autonomous permission
  policy with command allowlist (:74-86); 30-min wall-clock kill
  (:70-72); `delegate_coding_task` / `check_coding_session` builtins
  (:64-70, :110-118). A phase-0 egress-allowlist deliverable and a
  nullable `task_id` FK on the sessions table are being added to that
  spec as deltas for this plan.
- **No pipeline tables exist** — `backend/app/migrations/` runs
  001–049 (`049_user_profiles.sql` is the last on disk); grep finds no
  `coding_tasks` and no `workspaces` table anywhere in migrations.
  Everything in the data model below is new.
- **Dispatch depth is capped at 1** — `MAX_DISPATCH_DEPTH = 1`
  (backend/app/agents/runner.py:27), dispatch stripped from sub-agent
  toolsets (runner.py:442), further dispatch refused (runner.py:626-628).
  The PM cannot delegate to a "lead" who delegates to "engineers" —
  the stage machine is the only viable team shape.
- **Single tool chokepoint** — `execute_tool`
  (backend/app/tools/registry.py:308) enforces the grant check
  (:316-317) then the guardian rules gate (:320-333) before any
  execution. New builtins added here inherit both gates for free.
- **Consent rail** — backend/app/consents.py: single-use, agent-bound
  check-and-burn (`validate_and_use`, consents.py:110-137),
  `DECIDE_TTL_MIN = 10`, `USE_TTL_MIN = 3`, `CREATE_LIMIT_PER_HOUR = 6`
  (consents.py:22-24). The push and deploy gates below ride this rail
  unchanged.
- **Recommendation cards** — backend/app/recommendations.py:
  `create()` with dedupe_key upsert (recommendations.py:42-77,
  ON CONFLICT at :66-70), per-source rate limit
  `CREATE_LIMIT_PER_HOUR = 12` (:24), `decide()` (:111-123).
  Important: `decide()` only updates the row's status — it executes
  nothing (actionable-approve is recommendation-surface.md phase 3,
  unbuilt). Pipeline checkpoints therefore POLL the card's status from
  the scheduler tick rather than depending on an approve-hook.
- **Scheduler + leader** — 60s tick (backend/app/scheduler.py:20,
  `tick()` at :64) gated by Postgres advisory-lock leader election
  (backend/app/leader.py:1-16). Stage advancement hangs off this tick.
- **inference-control is the ONLY docker.sock holder** —
  docker-compose.yml:83-90 mounts the socket into inference-control
  alone; inference-control/server.py:1-21 documents the fixed-verb
  house pattern ("Nothing is parameterized by the request"). Current
  verbs: status/gpu/vram/gpu-stats/containers/disk/start/stop. The
  deploy design below EXTENDS this sidecar with stack verbs rather
  than minting a second socket holder (locked).
- **Settings auto-render** — `SETTING_DEFS`
  (backend/app/settings_store.py:23): new keys appear in Settings with
  zero frontend work.
- **Library tabs** — `KINDS = ['agents', 'models', 'automations',
  'rules', 'tools', 'skills']`
  (frontend/src/components/library/LibraryPage.tsx:13) — the pipeline
  UI adds a tab here.
- **Secrets** — `docs/plans/secrets-management.md` phase 1 gives
  `{{secret:NAME}}` resolution at the outbound call; the GitHub MCP
  registration below depends on it. MCP tool-list hash approval
  exists (`tool_list_hash`, backend/app/mcp_client.py:33).
- **No in-repo screenshot script** — there is no `scripts/` directory
  and no playwright harness in the repo. The house recipe (docker
  node:alpine + chromium/swiftshader + playwright-core, used against
  :5173 for visual verification) lives only in session memory; T3
  must create the script, not find it.

## Design

### The stage machine

Stages, in order, for a full-size task:

    brief -> spec -> tests -> implement -> review -> browser_qa -> done

`quick` tasks skip `spec` and `tests`:

    brief -> implement -> review -> browser_qa -> done

Failure exits from any stage: `stalled` (budget/loop exhausted,
operator card raised) and `cancelled` (operator). Stage advancement is
driven ONLY by broker session-end callbacks and the 60s leader-gated
scheduler tick — never by an LLM loop. An LLM never decides "what stage
comes next"; it only produces the artifact the current stage demands.

### Data model (next free migration number — re-check at build time; 050 is currently contested between parallel lanes)

```sql
coding_tasks (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id),
  goal_id       uuid,            -- nullable FK to goals (docs/plans/ideation-goals.md,
                                 -- authored in parallel; add the REFERENCES clause
                                 -- only if that table exists at build time)
  title         text not null,
  slug          text not null,   -- worktree suffix: .worktrees/nova/<slug>
  size          text not null default 'full',    -- 'quick' | 'full'
  brief         text not null,   -- requirements + acceptance criteria incl. browser click-path
  stage         text not null default 'brief',
    -- 'brief'|'spec'|'awaiting_spec_approval'|'tests'|'implement'
    -- |'review'|'awaiting_merge'|'browser_qa'|'done'|'stalled'|'cancelled'
  branch        text,            -- session branch name, set when the worktree is cut
  review_cycles int not null default 0,
  session_count int not null default 0,
  session_budget int not null default 6,          -- from setting at create time
  checkpoint_rec_id uuid,        -- recommendation card the tick polls
  verdicts      jsonb not null default '{}',
    -- {"tests_red": true, "tests_green": true,
    --  "review": "approve"|"request_changes",
    --  "protected_paths": ["backend/app/consents.py", ...],
    --  "browser_qa": "screenshots"|"flagged"}
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
```

Per-stage ACP session ids are NOT duplicated here: the ACP sessions
table gains nullable `task_id` and `stage` columns (delta in
acp-coding-delegation.md), so "which session ran the review" is
`SELECT * FROM sessions WHERE task_id = $1 AND stage = 'review'`.

`workspaces` gains columns (same migration): `test_cmd text`,
`preview_cmd text`, `preview_port int`, `protected_paths jsonb`
(list of path globs; the nova repo's registration defaults to
`["backend/app/consents.py", "backend/app/tools/registry.py",
"backend/app/rules.py", "backend/app/migrations/*",
"docker-compose*.yml", "coder/*", "inference-control/*"]`).
Workspaces rows are writable ONLY via the authenticated operator API —
no builtin writes them, ever. This matters twice: the broker treats
workspace config as operator-authored (below), and containment
invariant 3 says nothing an agent can write may be the switch.

### Nova-main is the PM (and only the PM)

Main drafts the task brief from chat context: requirements, acceptance
criteria including a concrete browser click-path ("open :5173, click X,
expect Y"), and a size recommendation. The operator picks the size in
conversation; main then calls a new builtin:

- `create_coding_task(workspace, title, brief, size)` — inserts the
  row in stage `brief`, returns the task id. Granted to `main` only.
- `check_coding_task(task_id)` — stage, verdicts, session summaries.
  Granted to `main`.

That is the whole PM job. Main never sits inside the pipeline, never
reviews code, never talks to the coding agent mid-session. Progress
reaches chat via `check_coding_task` and the completion journal, the
same shape as `check_coding_session` in the ACP spec.

### One worktree per task, one session per stage

The `brief -> spec` transition cuts ONE worktree
(`.worktrees/nova/<slug>` inside the registered repo, per the ACP
spec's discipline) and one branch; every subsequent stage runs a fresh
ACP session in that SAME worktree. Each stage has:

1. A **role-prompt template**: a file in
   `backend/app/coding/prompts/` — `spec.md`, `tests.md`,
   `implement.md`, `review.md`, `browser_qa_vision.md`. In-repo,
   versioned, reviewed like any code. DB-tunability is EXPLICITLY
   DEFERRED: self-tuning must never start on the pipeline's own
   prompts (see docs/plans/self-improvement.md, authored in parallel —
   its invariant that self-tuning edits prompt text, never capability,
   plus the stronger rule here: not even these prompt files, since
   they gate what reaches the merge queue).
2. A **stage-scoped permission policy** the backend passes to the
   broker at `POST /session` (the ACP sandboxed-autonomous policy,
   narrowed per stage).
3. **Mechanical advancement checks** run by the broker or backend —
   never by asking a model "did it pass?".

Stage by stage:

- **spec** (architect + UI/UX + data lens, `prompts/spec.md`): the
  session may write ONLY `.nova/spec.md` in the worktree (policy:
  single writable path). Required sections: Design, Data changes, UI
  changes, Acceptance criteria (the click-path, carried from the
  brief and made concrete). Advancement check: file exists, is
  non-empty, contains the Acceptance heading. Then the pipeline
  raises the **spec checkpoint card** (below) and parks in
  `awaiting_spec_approval` — no implement tokens burn before the
  operator has seen the plan.
- **tests** (QA lens, `prompts/tests.md`): writes failing tests only
  (policy: writable paths = the workspace's test globs plus
  `.nova/`). Advancement check: the BROKER mechanically runs the
  workspace's registered `test_cmd` in the worktree and verifies RED
  (non-zero exit). A green run means the tests don't test the new
  behavior — the stage gets one retry with that feedback appended,
  then stalls to the operator. The broker takes `test_cmd` from its
  read-only workspace config (below), NEVER from the request body.
- **implement** (engineer lens, `prompts/implement.md`): full
  worktree write access, allowlisted commands. Advancement check:
  broker runs `test_cmd`, verifies GREEN (exit 0). Quick tasks skip
  the RED half but still must exit GREEN if a `test_cmd` is
  registered.
- **review** (reviewer + security lens, `prompts/review.md`): a
  FRESH ACP session with no shared conversational context — its
  entire input is the role prompt; it reads
  `git diff main...<branch>` itself. Writes `.nova/review.md` ending
  with a machine-readable line `VERDICT: approve` or
  `VERDICT: request_changes`, and a mandatory "Security checklist"
  section (injection surfaces, secrets in code, authz on new
  endpoints, unsafe shell/SQL, dependency changes). Two checks run on
  advancement: (a) the verdict line parses; (b) the
  **protected-paths tripwire** — the BACKEND (not the model) runs the
  diff's path list against the workspace's `protected_paths` globs
  and records any hits in `verdicts.protected_paths`. The tripwire is
  computed mechanically so the coding agent cannot omit it, and it is
  flagged loudly on the merge card regardless of the LLM verdict —
  containment invariant 3: code review flags any diff touching
  consents.py, the rules gate, broker policy, or migrations.
  `request_changes` loops back to `implement` with `.nova/review.md`
  as input, bounded at 2 cycles (`coding.review_loop_max`), then the
  task stalls to the operator with both reviews attached.
- **browser_qa**: mostly mechanical, see its own section below.
- **done**: completion journal entry (branch, diffstat, verdicts,
  session count, artifact links) + the **merge-gate card**. The
  operator's merge — by hand, indefinitely — is the actual end.

### Artifacts live in the worktree

`.nova/spec.md`, `.nova/review.md`, and the test files are committed
on the session branch by the sessions that produce them. They version
with the branch, show up in the SAME `git diff main...branch` the
operator reviews, and need zero new storage or endpoints. Whether
`.nova/` survives the merge is the operator's call at merge time
(default: keep it — it is the task's permanent record; a squash-merge
that drops it loses nothing the journal didn't capture).

### Operator checkpoints (recommendation cards)

Two per full task, one per quick task:

1. **Spec checkpoint** (full tasks): kind `coding_checkpoint`, source
   `coding`, dedupe_key `coding:<task_id>:spec`, body = spec summary +
   link to the task detail. Approve means "spend the implement
   tokens".
2. **Merge gate** (all tasks): dedupe_key `coding:<task_id>:merge`,
   body = branch, diffstat, review verdict, protected-path flags
   (loud, first line, if any), browser_qa screenshot links. Approve
   marks the task `done`; the merge itself stays a human `git merge`
   (or PR merge once T4 lands).

Because `recommendations.decide()` executes nothing (verified above),
the scheduler tick polls `checkpoint_rec_id`: card approved ->
advance; dismissed -> `cancelled`; snoozed/new -> keep waiting.
Dedupe keys make re-raises safe; the `coding` source shares the
existing 12/hr limit, which two cards per task will never hit.

### Budgets

- Per-session wall clock: the ACP spec's 30-min kill, unchanged.
- Per-task session budget: `coding.task_session_budget`, default 6,
  stamped onto the row at create time. Every `POST /session` for the
  task increments `session_count`; hitting the budget stalls the task
  with a card. Six covers a full run (spec + tests + implement +
  review + browser_qa) plus one review loop; quick tasks rarely use
  more than three.

### Broker deltas (new fixed verbs; house pattern throughout)

The broker gains verbs — each parameterized only by session id;
commands and paths come from operator-authored config, never the
request:

- `POST /session/<id>/run-tests` — runs the workspace's `test_cmd`
  in the session worktree, returns `{exit_code, tail}`. The command
  comes from `/state/workspaces.json`, a file the backend writes from
  the workspaces table and compose mounts READ-ONLY into the coder
  container (the exact pattern inference-control uses for
  `/state/models_dir`, server.py:42-46). Workspaces rows are
  operator-only writes, so the file is operator-authored config by
  construction.
- `POST /session/<id>/browser-qa` — starts the workspace's
  `preview_cmd` inside the coder container, waits for
  `preview_port`, drives the screenshot run (below), kills the
  preview. Returns the artifact manifest.
- `GET /session/<id>/artifacts` and
  `GET /session/<id>/artifacts/<name>` — list/fetch screenshots and
  reports from the session's artifact dir. The backend proxies these
  on an authenticated route (`/api/coding/tasks/<id>/artifacts/...`)
  so the frontend never talks to the broker.
- `POST /session/<id>/push` — T4, see GitHub section.

### browser_qa stage

Adds the missing team role: "does it actually work in a browser".

- Preview: `preview_cmd` + `preview_port` on the workspaces row
  (e.g. `npm run dev -- --port 4173` / `4173`). The broker runs it in
  the worktree inside the coder network; nothing is published to the
  host.
- Screenshot run: chromium + playwright-core inside the coder image
  (add both to the coder Dockerfile in T3; swiftshader flags for
  headless GL — the house recipe, scripted fresh since no in-repo
  script exists). The runner walks the click-path steps parsed from
  the Acceptance section of `.nova/spec.md` (quick tasks: from the
  brief), screenshotting each step against `coder:<preview_port>`.
- Verdict, v1: the screenshots ATTACH to the merge-gate card for the
  operator, plus one cheap vision-model pass
  (`coding.qa_vision_model`, a `slug:model`; empty = skip) that flags
  only obvious breakage — blank page, error text, stack traces.
  Flags land in `verdicts.browser_qa`; they never auto-fail the task.
  Autonomous pass/fail verdicts are explicitly deferred.
- **The nova repo is special**: for the nova workspace, browser_qa
  runs against the STAGING stack from
  docs/plans/self-improvement.md (authored in parallel) instead of
  `preview_cmd` — containment invariant 5 applies (staging stacks
  cannot act on the world: automations off, notifications to a
  staging topic). No preview inside the coder container for nova.

### GitHub / GitLab (T4)

- Register the GitHub MCP server with header
  `Authorization: Bearer {{secret:github_pat}}` — depends on
  secrets-management.md phase 1 (reference stored, resolved only at
  the outbound call, trace-redacted). Tool-list hash approval
  (mcp_client.py:33) applies as usual.
- Grants: per-tool `mcp:github/<tool>` grants to `main` (MCP tools
  are never implied — registry.py:108-122). Issue/PR READS are
  granted freely; PR creation is consent-gated in v1 (guardian rule
  or per-call `request_operator_confirmation`).
- **Push**: the coding agent NEVER pushes — the broker's command
  allowlist denies `git push` outright. Instead a broker fixed verb
  `POST /session/<id>/push` pushes the SESSION BRANCH ONLY: the
  broker constructs the refspec
  `refs/heads/<branch>:refs/heads/<branch>` itself from the session
  row, refuses `main`/`master` and any force flag, and authenticates
  with a per-repo DEPLOY KEY mounted only into the coder container
  (read-only, scoped to that one repo; not a Nova secret, never in
  the backend). Exposed as a `push_coding_branch(task_id)` builtin
  behind the consent rail (kind `coding_push`, subject the branch
  name, the diffstat in the question) — the operator's diff approval
  IS the consent, one card. Consistent with containment invariant 1:
  Nova never pushes nova's own main, and with this design cannot push
  ANY repo's main.

### Deploy (T5): stack verbs on inference-control

inference-control stays the only docker.sock holder (LOCKED) and
gains stack verbs for operator-registered compose projects:

- `POST /stack/<name>/build` — `docker compose build` with images
  tagged by the project's current git SHA.
- `POST /stack/<name>/up`, `POST /stack/<name>/down`.
- `POST /stack/<name>/rollback` — re-up the previous recorded SHA tag.
- `GET  /stack/<name>/status`.

`<name>` must match a project registered in a `/state/stacks.json`
file (backend-written from an operator-only Settings card, mounted
read-only — same pattern as `/state/models_dir`). Each registration
maps name -> compose file path INSIDE the sidecar, which means
registering a new stack requires adding a read-only volume mount for
its compose file to the inference-control service and recreating it —
an operator compose edit, stated plainly in the UI. Nothing in any
request parameterizes a shell command; the verb set is fixed and the
project set is operator-authored.

An optional `deploy` stage (off by default per workspace,
`workspaces.deploy_stack text` naming a registered stack) runs after
the merge gate — and only behind its own consent card (kind
`stack_deploy`). Out of scope v1: cloud targets (Fly/VPS/k8s),
DNS/TLS automation.

These same verbs are deliberately shared infrastructure: they serve
the staging stack in self-improvement.md, the restore drill in
docs/plans/data-backups.md, and Jeremy's manual Nova upgrades
("build + up the nova stack at SHA X" from Settings instead of a
terminal). Build them once, here.

### UI

- Library gains a `coding` tab (LibraryPage.tsx:13 KINDS list):
  task list (title, workspace, stage, size, verdict chips) and a
  detail view (brief, stage timeline with per-session links,
  `.nova/spec.md` / `.nova/review.md` rendered, artifact
  screenshots, protected-path flags). Discoverable by navigation.
- Settings gains a `coding` section automatically from the new
  SETTING_DEFS keys: `coding.task_session_budget` (int, 6),
  `coding.review_loop_max` (int, 2), `coding.qa_vision_model`
  (string, empty = skip vision pass).
- Checkpoint and merge cards ride the existing bell/inbox/banner.

## Phases (each ends live-verified through :5173; changes left uncommitted, summarized)

Hard dependency: acp-coding-delegation.md phases 0-3 land FIRST (the
spike, the sidecar + broker, the chat integration, the policy
engine). Note the phase-0 egress-allowlist deliverable being added to
that spec — this pipeline assumes the coder container's egress is
already allowlisted. Each phase below is one session, in its own
branch + `.worktrees/<lane>` worktree inside the repo.

- **T1 — pipeline core**: migration (next free migration number —
  re-check at build time; 050 is currently contested between parallel
  lanes) for `coding_tasks` + the workspaces columns; `pipeline.py`
  (stage machine, tick hook, session-end hook); `prompts/spec.md` +
  `prompts/implement.md`; `create_coding_task` / `check_coding_task`
  builtins granted to main; spec checkpoint card + poll; minimal
  Library coding tab. Full pipeline for this phase is
  brief -> spec -> awaiting_spec_approval -> implement -> merge card.
  Verify: through :5173, ask Nova to build a small feature in a
  registered scratch repo (size full); the brief lands via
  `create_coding_task`; the spec session produces `.nova/spec.md`;
  the bell shows the spec checkpoint, Approve advances it; the
  implement session edits the worktree branch; the merge card
  appears with a real diffstat; main is untouched; the task and its
  stages are visible under Library -> Coding.
- **T2 — tests + review**: `prompts/tests.md` + `prompts/review.md`;
  broker `run-tests` verb + `/state/workspaces.json` plumbing;
  RED-then-GREEN enforcement; fresh-session review with verdict
  parse, security checklist, mechanical protected-paths tripwire,
  bounded request_changes loop. Verify: a full-size task on a repo
  with a registered `test_cmd` shows RED after the tests stage and
  GREEN after implement in the task timeline; a seeded task that
  touches a protected path shows the flag loudly on its merge card;
  a forced `request_changes` loops back to implement exactly once
  and the second approve lands.
- **T3 — browser_qa**: chromium + playwright-core in the coder
  image; `preview_cmd`/`preview_port` Settings fields on the
  workspace card; broker `browser-qa` + `artifacts` verbs; backend
  artifact proxy; click-path runner; optional vision pass. Verify: a
  task on a registered web repo produces step screenshots viewable
  from the task detail through :5173, and the merge card links them;
  the preview process is gone from the coder container afterward.
- **T4 — GitHub + push** (needs secrets-management.md phase 1):
  GitHub MCP server registered with the `{{secret:github_pat}}`
  header; read grants to main; `push` broker verb + deploy-key
  mount + `push_coding_branch` builtin behind the consent rail.
  Verify: through :5173, approve the push consent card for a
  finished task and the session branch appears on GitHub; asking
  Nova to push main is refused by the broker (error visible in the
  task timeline), and the trace shows the reference, never the
  token.
- **T5 — stack verbs + deploy stage**: inference-control stack
  verbs + `/state/stacks.json`; Settings card for stack
  registration; optional consent-gated deploy stage. Verify:
  register a scratch compose project; a task with `deploy_stack`
  set raises the deploy consent after merge approval; approving
  builds a SHA-tagged image and ups it (visible via
  `/stack/<name>/status` surfaced in Settings); rollback restores
  the previous SHA.

## Decisions

- LOCKED (Jeremy, 2026-07-24): roles are pipeline STAGES driven by a
  backend state machine over ACP sessions — not multiple conversing
  Nova agents. Nova-main is the PM only.
- LOCKED (Jeremy, 2026-07-24): inference-control remains the ONLY
  docker.sock holder; deploy is stack verbs added to it, never a
  second socket holder.
- LOCKED (Jeremy, 2026-07-24): push happens only via the broker's
  fixed verb — session-branch-only refspec, per-repo deploy key
  mounted only in the coder container, consent-gated; the command
  allowlist denies `git push` to the coding agent.
- LOCKED (Jeremy, 2026-07-24): operator merge is the gate for all
  code, indefinitely. Checkpoint cards inform; the human merges.
- LOCKED (carried, containment invariants): the running Nova never
  modifies nova's code/compose/migrations in place; the
  protected-paths tripwire is computed by the backend, not the
  model; role prompts are in-repo files and self-tuning never
  touches them; the coder sidecar stays secretless and secrets never
  enter worktrees; nova's own browser_qa runs against the staging
  stack, which cannot act on the world.
- Default (change cheap): per-task session budget 6
  (`coding.task_session_budget`).
- Default: review loop bound 2 (`coding.review_loop_max`).
- Default: quick-mode criteria are operator judgment at brief time;
  guidance in the PM prompt: single-file or cosmetic changes with an
  obvious click-path and no schema/API surface -> quick.
- OPEN: vision model for the QA pass (`coding.qa_vision_model`) —
  needs a cheap vision-capable `slug:model`; empty (screenshots
  only, no vision pass) is the shipping default until Jeremy picks.
- OPEN: `.nova/` artifact fate at merge — default keep; Jeremy may
  prefer squash-and-drop.

## Traps / risks

- **The LLM-loop temptation.** Every future contributor will want the
  review stage to "just ask the implementer to fix it" in one
  session. Don't: stage boundaries are what make checks mechanical
  and sessions cheap to kill. Advancement logic lives in
  `pipeline.py` and the tick, nowhere else.
- **RED is a blunt instrument.** A test suite that fails to COLLECT
  (import error) exits non-zero and would count as RED. v1 accepts
  this (the implement stage's GREEN still guards the outcome); note
  it in `prompts/tests.md` and refine later if it bites.
- **Review freshness is about context, not the filesystem.** The
  review session shares the worktree (it can read `.nova/spec.md` —
  fine, the diff is ground truth) but must be a NEW ACP session with
  no conversational carryover from implement. Session reuse here
  silently turns the reviewer into the author.
- **The tripwire must not be suppressible.** Protected-path flags
  come from the backend diffing the branch; nothing the coding agent
  writes (including `.nova/review.md`) feeds that computation, and
  the merge card renders the backend's list, not the review's.
- **Broker config, not request params.** `test_cmd`, `preview_cmd`,
  and stack registrations reach sidecars via read-only mounted state
  files written from operator-only tables — the day a command string
  rides a request body, the house sidecar pattern is dead.
- **Sidecar compose recreate trap** (known incident: a sidecar
  compose run recreated the backend with an empty `/compose` mount —
  "No module named app"). Stack verbs must run compose strictly
  against the registered project's own mounted compose file, and the
  nova stack's registration must point at the real repo-mounted
  `/compose/docker-compose.yml`. Test rollback on a scratch stack
  before ever pointing a verb at nova.
- **Deploy-key scope.** One key per repo, write access to that repo
  only, mounted read-only into the coder container alone. If a key
  can push anywhere else, the refspec guard is the only fence left —
  keep two fences.
- **Budget exhaustion mid-loop.** A request_changes loop can eat the
  session budget; the stall card must say which stage starved and
  attach both reviews so the operator can resume with one decision,
  not archaeology.
- **Screenshot stack.** No in-repo script exists (verified) — T3
  writes it. Headless chromium needs swiftshader flags; the
  virtual-time-budget trick breaks on WebGL pages (house memory).
  Screenshots are artifacts served via the broker verb, never
  written outside the session's artifact dir.
- **Migration number is contested** — 050 has parallel claimants;
  re-check `backend/app/migrations/` at build time, always.
- **Parallel-authored specs.** ideation-goals.md (goals table) and
  self-improvement.md (staging stack) are being written in parallel
  with this one; T1 must tolerate their absence (`goal_id` FK-less
  if the table isn't in yet; nova-repo browser_qa deferred until
  staging exists).
