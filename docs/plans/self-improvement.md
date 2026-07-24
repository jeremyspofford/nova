# Self-improvement — measure, tune, self-code, and (eventually) pursue goals, in that order

Implementation plan (authored 2026-07-24 with Fable). Status: PROPOSED — needs
Jeremy's sign-off.

This is the umbrella spec for "letting Nova loose", staged honestly. Four
stages, strictly ordered, each gated on the one before it:

1. **MEASURE** — nothing self-modifies until it can be graded
   (`model-eval-pipeline.md`, already spec'd and LOCKED).
2. **SOFT-LAYER SELF-TUNING** — Nova proposes concrete diffs to her own
   prompts and skills; the operator applies them. Proposals only, never
   auto-apply.
3. **NOVA IMPROVES NOVA'S CODE** — the coding-team pipeline with the nova
   repo as a workspace, verified in an isolated staging stack; operator
   merge is the gate indefinitely.
4. **GOAL AUTONOMY (v1)** — operator-activated goals advance one budgeted
   step per tick-window, behind a kill switch and a ledger.

The ROADMAP.md "Later" section carries the original sketch of stages 3's
two-tier soft/hard rule, staging stack, and out-of-band promotion
(ROADMAP.md:1575-1603, "Self-improvement pipeline — how Nova changes her own
code", discussed 2026-07-17). This spec implements that sketch and extends it
with stages 1, 2, and 4.

## Containment invariants — LOCKED (Jeremy, 2026-07-24)

These hold in every stage, verbatim, and every phase below is designed under
them:

1. Nova never merges or pushes nova's own main — operator merge is the gate
   indefinitely.
2. The hard layer (code/compose/migrations) is never modified in place by the
   running Nova — worktree branch -> staging -> operator merge only.
3. Nothing an agent can write may be the switch: the guardian rules gate,
   consents.py, coder-broker policy, and the autonomy toggle are
   operator-only surfaces, and the code-review stage's protected-paths
   tripwire flags any diff touching them.
4. The coder sidecar stays secretless; secrets never enter worktrees.
5. Staging stacks cannot act on the world — side effects are off by
   construction.
6. Executable skill payloads (roadmap #18) remain RESEARCH FIRST —
   self-tuning edits prompt text, never capability.

## What exists (verified in code, 2026-07-24)

- **Scheduler = the autonomous heartbeat, already railed.** 60s tick
  (scheduler.py:20), leader-gated so a fleet runs singletons exactly once
  (scheduler.py:69 via instances.is_leader(), backed by the Postgres
  advisory-lock election in leader.py:72, fail-safe demotion leader.py:48-58),
  `automations.enabled` live kill switch checked every tick (scheduler.py:74,
  defined settings_store.py:134), per-run wall-clock kill via
  `asyncio.wait_for` (scheduler.py:55), auto-disable after 5 consecutive
  failures (automations.py:172-178) with journal + operator notification
  (scheduler.py:105-125). Stage 2's self-review and stage 4's goal-runner are
  rows in this machinery, not new machinery.
- **Settings auto-render.** SETTING_DEFS is the registry — "adding an entry
  gives a feature a typed, validated, UI-rendered setting with zero further
  wiring" (settings_store.py:3-4); `automations.enabled` (settings_store.py:134)
  is the exact precedent for the new `autonomy.enabled` toggle.
- **Turn ledger for the audit trail.** `turn_traces` + `turn_spans`
  (migrations/028_turn_traces.sql:8-40) with a `source` CHECK of
  chat/automation/compaction (028_turn_traces.sql:10-11) and a free-text
  `automation` column usable as a zero-migration tag slot (the eval spec
  already exploits it). Secret-shaped keys/values are redacted before storage
  (trace.py:48-53). Traces are pruned on retention — diagnostics, not memory
  (028_turn_traces.sql:5-6) — so the stage 4 ledger view treats journals as
  the durable record and traces as the windowed detail.
- **Recommendations = THE proposal channel.** `raise_recommendation` with
  `dedupe_key` upsert (recommendations.py:44-75) and a 12/hr per-source rate
  limit (recommendations.py:24); cards land in the ChatPanel bell/inbox with
  Approve/Later/Dismiss.
- **Consents are check-and-burn.** Single-use, agent-bound, short-TTL
  (consents.py:9-11, 22-24: DECIDE_TTL 10 min, USE_TTL 3 min, 6/hr create
  cap), burned atomically in validate_and_use (consents.py:112-137). Stage 4
  changes none of this — every consent gate applies unchanged.
- **Prompt overrides work via the copied agent dict.** run_agent reads
  `agent["system_prompt"]` (runner.py:332) and `agent["model"]`
  (runner.py:484/487) from the dict it was handed and never re-reads the
  agents table — so the eval runner's `{**agent, "model": challenger}`
  pattern extends to `{**agent, "system_prompt": variant}` for free. This is
  the stage 2 gate mechanism.
- **manage_agents can widen toolsets** — its update path accepts
  `allowed_tools` (tools/builtin.py:123-125). This is exactly why the
  self-review agent must never hold manage_agents (design below): the apply
  step is a restricted server-side write, not an agent tool call.
- **Roadmap #16 (usage caps by cost) is NOT built** (ROADMAP.md:899-917):
  cost capture and budget accounting don't exist yet, and #16 itself notes a
  dependency on per-agent model chains. Stage 4 budgets DEPEND on #16 landing
  first — stated as an activation criterion, not hand-waved.
- **Roadmap #18 (executable skills) is research-only** with the
  self-escalation lesson spelled out: "nothing an agent can write — file
  location, frontmatter — can be the switch" (ROADMAP.md:928-955, esp.
  939-942). Stage 2 cites it as the hard line on tool grants.
- **The ROADMAP self-improvement sketch** (ROADMAP.md:1575-1603): soft layer
  runtime-modifiable / hard layer never modified in place (1576-1584),
  staging stack with copied postgres + memory and side effects disabled
  (1586-1590), operator merge the gate INDEFINITELY (1592-1594), promote =
  SHA-tagged images with backup first, rollback = previous tag + restore
  (1594-1595), and the honest note that migrations auto-run at startup so a
  candidate booted against the live DB could corrupt the real brain
  (1598-1602). Stage 3 is this, executed.
- **Cross-referenced sibling specs** (implement from those, not re-derived
  here): `model-eval-pipeline.md` (stage 1, DECISIONS LOCKED),
  `coding-team-pipeline.md` and `ideation-goals.md` (parallel-authored
  2026-07-24), `data-backups.md` (backup/restore machinery),
  `acp-coding-delegation.md` (coder sidecar + secretless broker,
  acp-coding-delegation.md:39-45), `recommendation-surface.md`,
  `guarded-actions-consent.md`.

## Design

### Stage 1 — MEASURE (pointer, plus one delta)

`model-eval-pipeline.md` is the spec: champion/challenger runs in a memory
sandbox with record/replay tool fixtures, deterministic contract checks,
a position-swapped pairwise judge, suites for ALL agent roles, and a
side-by-side promote UI. Its role here is the founding principle: **nothing
self-modifies until it can be graded** — every later stage consumes it as a
gate. Do not redesign it; implement it as written.

**Delta this spec adds to it**: champion/challenger extends to
same-model-different-system_prompt. The eval runner accepts a
`system_prompt` override in the copied agent dict exactly as it does `model`
(both are dict-reads, runner.py:332 and 484/487 — verified above), and the
eval storage records the challenger prompt (add a
`challenger_system_prompt TEXT` column to the eval-runs table — if the eval
tables have already landed when this builds, that is an ALTER in the next
free migration number; re-check at build time, 050 is currently contested
between parallel lanes). Prompt-variant runs are the stage 2 gate: a
proposed prompt runs as a challenger against the incumbent before the
proposal card ships.

### Stage 2 — soft-layer self-tuning (proposals only, never auto-apply)

**What may be tuned**: agent `system_prompt` text and skills markdown
(`data/memory/skills/*.md`). Nothing else.

**Hard exclusions** (the tripwire list, enforced in the apply path, not by
prompt honor):
- Tool grants: `allowed_tools` changes are ALWAYS operator-performed. An
  agent never widens any toolset, including its own — the roadmap #18 lesson
  ("nothing an agent can write may be the switch", ROADMAP.md:939-942)
  applied to grants.
- The guardian agent's prompt and Nova-main's soul constraints — excluded
  entirely from self-tuning (prompt-tuning must not be able to erode the
  refusal layer).
- The coding pipeline's role prompts — those live in-repo as files
  (coding-team-pipeline.md) and change only via code review, i.e. stage 3's
  path, never stage 2's.

**The self-review agent** (new row, INSERT in the next free migration number
— re-check at build time, 050 is currently contested between parallel
lanes): name `self-review`, `is_system=true`, tiny read-mostly toolset:
`search_memory` (journals, failure entries), a new read-only builtin
`turn_stats` (below), the eval-read builtin from the eval spec's UI phase
(list runs/results), and `raise_recommendation`. NOT granted:
manage_agents, write_memory, notify_operator, any MCP tool. It reads, it
proposes, it cannot apply.

**`turn_stats` builtin** (new, read-only, in tools/builtin.py): aggregates
over turn_traces/turn_spans for the last N days per agent — turn counts,
error rates, malformed-args count, tool-error count, round-count
distribution, timeout/cancelled counts. Pure SELECTs, no arguments that
reach SQL unparameterized. This exists so the agent gets evidence without
raw DB access.

**The weekly automation** (seeded row via the same migration): name
`self-review`, agent `self-review`, `interval_minutes=10080`,
`timeout_seconds=600`, instruction: read eval failures, turn_stats patterns,
and recent journals; for at most 2 agents with the clearest evidence of
prompt-caused failure, draft a CONCRETE system_prompt diff (or a skills-file
diff) and raise one recommendation each with the evidence inline. Where the
target agent has an eval suite, first queue a challenger run of the variant
prompt (stage 1 delta) and include the champion/challenger numbers in the
card; suite-less agents get proposals marked "unevaluated — judgment only".

**The proposal card**: `raise_recommendation` with `kind="self_tuning"`,
`dedupe_key="self-tune:<agent>:<sha256(new_prompt)[:12]>"`, body = evidence
summary + the diff, `action_json = {"type": "apply_prompt", "agent":
"<name>", "base_sha256": "<sha of current prompt>", "new_prompt": "..."}`
(or `{"type": "apply_skill", "path": "skills/<name>.md", "base_sha256":
..., "new_markdown": ...}`).

**Apply on approve**: the operator-authenticated recommendation decide
endpoint gains an apply step for these two action types. It calls the SAME
underlying functions the existing builtins wrap — `agent_registry.
update_agent(agent_id, system_prompt=...)` for prompts (the manage_agents
substrate, restricted to the system_prompt field only — never
allowed_tools, builtin.py:123-125 is why this must be a restricted
server-side path) and the memory write path for skills (the write_memory
substrate). No new write surface, no agent in the loop at apply time.
Guards in the apply path: `base_sha256` must match the current content
(stale proposal fails loud: "changed since proposed — re-run self-review");
target must not be on the exclusion list; diff size capped (Decisions §4).
Reject/Dismiss leaves nothing but the decided card.

### Stage 3 — Nova improves Nova's code

The coding-team pipeline (`coding-team-pipeline.md`: staged ACP sessions
with role prompts, backend state machine, Nova-main as PM, coder-broker git
verbs) with **the nova repo itself registered as a workspace**. Branches are
session branches under the pipeline's naming; per invariant 2 the running
stack never edits itself in place, and per invariant 1 push happens only via
the coder-broker fixed verb (per-repo deploy key, session-branch-only
refspec, consent-gated) — never to main.

**Staging stack** (the new part, stack verbs on inference-control — it
stays the ONLY docker.sock holder; it gains verbs rather than a second
holder being minted; the coding spec's T5 defines the verb surface):
- `stack_build {sha}` — build images from the candidate branch SHA, tagged
  `nova-<service>:<sha>`.
- `stack_stage_up {sha}` — boot a SECOND compose project (`nova-staging`,
  own volumes, own 127.0.0.1 ports, e.g. backend :18000 / web :18080) with
  a COPY of postgres and the memory dir — seeded by restoring the latest
  backup bundle (data-backups.md machinery; Decisions §2) — and
  `NOVA_STAGING=1` in the environment.
- `stack_stage_down`, `stack_promote {sha}`, `stack_rollback` — below.

**`NOVA_STAGING=1` semantics (side effects off by construction, invariant
5)**: the backend reads it at startup (config.py); when set, the scheduler
tick returns before running any automation regardless of the
`automations.enabled` setting (a hard code gate above scheduler.py:74, not
a DB value a restored bundle could flip back on), notify.send routes every
provider to a `-staging` topic/label, and web push is disabled. Migrations
auto-run at startup — which is exactly why staging gets a COPY of postgres,
never a shared one (ROADMAP.md:1598-1602): a candidate's migration runs
against the copy.

**Verification against staging**: the pipeline's test-suite stage plus the
browser_qa stage (coding-team-pipeline.md) run against the staging ports.
The run report is journaled and raised as a recommendation card
(`kind="self_code"`, links to branch, staging report, trace ids).

**OPERATOR MERGE IS THE GATE INDEFINITELY.** Jeremy reviews the branch and
merges by hand (or doesn't). The code-review stage's protected-paths
tripwire (invariant 3) flags any diff touching guardian rules machinery,
consents.py, coder-broker policy, the autonomy toggle, or this staging
gate itself.

**Promote** = out-of-band: an operator-authenticated UI action calling
`stack_promote {sha}` — NOT a registered tool, so no agent can call it.
Sequence: backup first (data-backups.md snapshot verb; non-negotiable),
then rebuild + restart prod from the merged SHA's tagged images.
**Rollback** = `stack_rollback`: previous image tag + optional restore from
the pre-promote bundle.

**DEFERRED**: Nova-authored DB migrations (revisit the pre-release
clean-breaking-changes policy that day, per ROADMAP.md:1601-1602);
auto-promotion (never).

### Stage 4 — goal autonomy ("let it loose", v1)

**Goals** come from the `goals` table in `ideation-goals.md` (cross-ref;
implement the table there). Nova may PROPOSE goals (recommendation cards);
ONLY the operator activates one (status -> active, operator-authenticated
API). This spec adds the runner and the rails:

- **goal-runner**: a planner automation (new `goal-runner` agent row +
  automation row, seeded via the next free migration number — re-check at
  build time, 050 is currently contested between parallel lanes). Each
  tick-window it selects ONE operator-activated goal with budget remaining
  and advances exactly one step: draft a brief (journal write), or kick one
  coding-pipeline stage via the pipeline's existing builtin (all its
  consent gates apply unchanged), or journal progress/completion. One step
  per window, bounded by the automation timeout. What counts as "one step"
  is Decisions §5.
- **Budgets, FAIL CLOSED**: per-goal token/cost budget columns plus
  max-sessions-per-day. This DEPENDS on roadmap #16 cost capture
  (ROADMAP.md:899-917), which is NOT built and must land first — it is an
  activation criterion below. Budget exhausted -> goal status
  `paused_budget` + operator notification (the scheduler's auto-disable
  notify pattern, scheduler.py:117-125) — never "one more session".
- **Kill switch**: new setting `autonomy.enabled` (boolean, default
  `false`, section "Autonomy") in SETTING_DEFS — auto-renders in Settings
  with zero frontend wiring (settings_store.py:3-4). Enforcement: the
  automations table gains `requires_autonomy BOOLEAN NOT NULL DEFAULT
  FALSE` (same migration); `automations.due()` excludes such rows while
  `autonomy.enabled` is false, and the goal-runner agent additionally
  re-checks the setting at each step boundary and aborts. The setting is
  operator-only by construction (settings API is operator-authenticated;
  no agent tool writes settings) — invariant 3. A visible "Autonomy ON"
  badge in the shell header is the prominent-toggle half (small frontend
  work).
- **Ledger**: a per-goal action-log VIEW over existing records — journals
  (durable, tagged with the goal id in the entry text/frontmatter),
  turn_traces (goal-runner runs tagged via the free-text `automation`
  column as `goal:<id>`), and consents rows. No new event store. Traces
  prune on retention, journals are the permanent record — the UI says so.
- **Standing policy, all stages**: NO autonomous outbound communications
  of any kind. Notifications to Jeremy via notify.send are operator
  alerts, not outbound comms; nothing in this plan emails, posts, or
  messages any third party.
- **DEFERRED**: multi-goal prioritization; any consent-gate relaxation;
  outbound communications of any kind.

**Activation criteria for stage 4 — LOCKED as the bar (Jeremy, 2026-07-24;
Jeremy can raise it, never lower)**. All boxes checked before
`autonomy.enabled` is flipped for the first real goal:

- [ ] Restore drill passed — data-backups.md phase 5 (if that spec's phase
      numbering shifts, the requirement is one full snapshot -> wipe ->
      restore round-trip performed successfully on real data).
- [ ] Cost caps (#16) live: per-turn cost capture + budget accounting
      working, verified against OpenRouter-reported usage.
- [ ] Ledger UI live: a goal's page shows its journals, traces, and
      consents in one place.
- [ ] Kill switch tested live: flip off mid-goal, observe the halt.
- [ ] A 2-week consent-everything supervised trial completed: goal-runner
      ran with every action behind request_operator_confirmation, and the
      trial log reviewed.

## Phases (each ends live-verified through :5173; changes left uncommitted, summarized)

Each stage is its own lane: own branch + worktree under
`.worktrees/<lane>` inside the repo (never siblings). One phase per
session.

**S1 — Measure (pointer).** Implement `model-eval-pipeline.md` phases 1-4
as written there, folding in the stage 1 delta (system_prompt challenger
override + stored challenger prompt). Verify: per that spec's phase exits;
delta verified by running the SAME model with two prompts and getting two
distinguishable graded runs.

**S2 — Self-review + proposal cards.** `turn_stats` builtin; `self-review`
agent + weekly automation (migration: next free number — re-check at build
time, 050 is currently contested between parallel lanes); prompt-variant
challenger wiring; `apply_prompt`/`apply_skill` action types on the decide
endpoint with sha/exclusion/diff-size guards. Verify: trigger the
automation manually (run-now); a real proposal card appears in the
ChatPanel bell with evidence (and eval numbers if the target has a suite);
approving it changes the agent's prompt in Library -> Agents; rejecting a
second proposal leaves no trace beyond the decided card; a proposal
targeting guardian is refused by the apply path.

**S3 — Nova-as-workspace + staging stack + promote/rollback.** Register
the nova repo in the coding pipeline's workspaces; stack verbs on
inference-control; NOVA_STAGING=1 gates in config/scheduler/notify;
staging seed-from-backup; report card. Verify: a trivial self-change (e.g.
a UI label) lands as a session branch -> staging boots with NOVA_STAGING=1,
automations provably off and notifications on the staging topic -> test +
browser_qa report card arrives -> Jeremy merges manually -> promote verb
rebuilds prod from the merged SHA with backup-first -> rollback verb
returns prod to the prior SHA.

**S4 — Goal-runner + budgets + kill switch + ledger.** goals integration
(per ideation-goals.md), goal-runner agent + `requires_autonomy`
automation, budget columns + fail-closed pause, `autonomy.enabled` +
shell badge, ledger view. Verify: activate a toy goal ("write a brief on
X, then journal it"); it advances one step per window; setting its budget
to an exhausted value pauses it with a notification; flipping
`autonomy.enabled` off halts everything at the next step boundary
mid-flight. Then run the activation-criteria checklist before any real
goal.

## Decisions

1. **Stage ordering and gates** — LOCKED (Jeremy, 2026-07-24): measure ->
   tune -> self-code -> goals, each gated on the previous; the containment
   invariants above hold verbatim in every stage; operator merge is the
   gate for all code indefinitely; auto-promotion never.
2. **Staging DB seed** — default: restore from the latest data-backups.md
   bundle (exercises the restore path every time staging boots — the drill
   comes free); alternative: direct pg_dump copy of live (fresher but
   skips the machinery we most need proven). Default chosen so phase S3
   can start.
3. **Self-review cadence + seeding** — weekly (interval_minutes=10080),
   max 2 proposals per run; the automation row is seeded DISABLED and
   Jeremy enables it in Library -> Automations (one click). Agent model:
   the same slug Nova-main uses (a strong model; proposals are judgment
   work), overridable in Library -> Agents.
4. **Diff-size cap for self-tuning** — default: a proposal may change at
   most 30 percent of the target prompt's lines (measured on the unified
   diff); larger rewrites need two accepted rounds. Crude but it makes
   guardrail erosion slow and visible.
5. **"One step" for goal-runner** — default: one automation run =
   exactly one of {draft/refine a brief, kick one coding-pipeline stage,
   write one progress/completion journal}, bounded by the automation
   timeout. Never more than one pipeline stage per window.
6. **Budget defaults** (placeholders until #16 defines the units; re-check
   then): per-goal total budget 5 USD cloud spend, max 2 goal-runner
   sessions/day, both operator-editable per goal, both fail closed.

## Traps / risks

- **Self-flattering evals.** A prompt variant graded by a sympathetic
  judge inflates itself. The eval spec's rails apply: position-swapped
  judging, a judge model different from the contestant, disagreement
  marked "too close to call" — never averaged away. Suite-less agents get
  no numbers, and their cards must say so.
- **The apply path is the whole guarantee.** manage_agents can update
  allowed_tools (builtin.py:123-125) — so the self-review agent must never
  hold it, and the approve-time apply must be the restricted server-side
  write described above. If a build session "simplifies" by granting
  manage_agents, invariant 3 is broken.
- **Prompt-tuning eroding guardrails gradually.** Many small accepted
  diffs can drift an agent's caution. Rails: diff-size cap (Decisions §4),
  guardian + soul + pipeline role prompts excluded outright, and the
  evidence requirement (a proposal without failure evidence is spam — the
  12/hr recommendation limit and dedupe_key make repeats cheap to dismiss).
- **Staging drift from prod.** A staging stack seeded weeks ago validates
  nothing. Seed from the LATEST bundle at stack_stage_up time, stamp the
  bundle timestamp into the report card, and refuse to report green if the
  seed is older than the last prod migration.
- **Staging touching prod state.** Migrations auto-run at backend startup
  — staging must NEVER be pointed at the live DB (ROADMAP.md:1598-1602);
  the NOVA_STAGING scheduler gate must be code, not a DB setting (a
  restored bundle carries prod's settings values, including
  automations.enabled=true). Own compose project, own volumes, own ports;
  verify isolation in S3 before anything else.
- **Goal-runner nagging.** An autonomous loop that notifies every window
  trains the operator to ignore it. Notify only on state CHANGES (paused,
  blocked, completed, budget exhausted); progress goes to the journal and
  the ledger view, not the phone. The 12/hr recommendation and 6/hr
  consent caps (recommendations.py:24, consents.py:24) stay the backstop.
- **Cost blindness before #16.** Without cost capture, budgets are
  fiction and stage 4 is unbounded spend. #16 landing is an activation
  criterion, not a nice-to-have; do not stub budgets with token guesses.
- **Trace retention vs the ledger.** turn_traces prune on retention —
  a goal's audit trail must not evaporate. Journals are the durable
  record; the ledger view must render fully from journals alone, with
  traces as enrichment when still present.
- **Migration numbering.** Every migration above is "next free number —
  re-check at build time"; 050 is currently contested between parallel
  lanes. Never pin.
