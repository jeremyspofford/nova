# Ideation + goals — Nova proposes things to build, approved ideas become tracked goals

Implementation plan (authored 2026-07-24 with Fable). Status: PROPOSED — needs
Jeremy's sign-off.

Deliberately THIN. This lane is greenfield (no goals/ideation machinery exists
anywhere in the code), so it earns its keep by reusing what already works:
ideas travel through the EXISTING recommendations inbox, the weekly trigger is
an EXISTING-style automation row, and goals are one small table plus one
Library tab. This spec builds the substrate that later lanes point at —
`coding_tasks.goal_id` (docs/plans/coding-team-pipeline.md) links pipeline work
to goals, and AUTONOMOUS goal initiation is exclusively self-improvement
stage 4 (docs/plans/self-improvement.md). Nothing in this lane acts on the
world: the ideator proposes, the operator decides, goals are bookkeeping.

Lane mechanics: own branch + worktree at `.worktrees/ideation-goals` inside the
repo (never a sibling folder). One phase per session. All changes left
uncommitted for Jeremy.

## What exists (verified in code, 2026-07-24)

- **Recommendations are the proactive channel, end to end.**
  `backend/app/recommendations.py`: `create()` enforces a per-source rate
  limit of 12/hour (`CREATE_LIMIT_PER_HOUR`, recommendations.py:24, checked at
  :49-55); dedupe is a partial unique index on `dedupe_key`
  (migrations/032_recommendations.sql:26-27) plus an upsert that refreshes the
  live row and NEVER resurrects a decided/dismissed one
  (recommendations.py:62-75 — the `WHERE recommendations.status = ANY($8)`
  guard with `_ACTIONABLE = ("new","seen","later")`, :25). A `status='new'`
  row fires a push nudge (recommendations.py:81-86). Table columns:
  id, kind, title, body, source, status
  (new/seen/approved/later/dismissed/done), action JSONB, priority,
  dedupe_key, created_at, decided_at, decided_by
  (032_recommendations.sql:8-22).
- **Agents raise; only the operator decides.** The `raise_recommendation`
  builtin (backend/app/tools/builtin.py:917-942) accepts kind, title, body,
  dedupe_key, priority — and does NOT accept an `action` payload (:922-931);
  source is stamped from ctx, not agent-supplied (:935). The decide endpoint
  `POST /api/v1/recommendations/{rec_id}/decide`
  (backend/app/router_chat.py:1520-1532) is operator-only, choices
  approve/later/dismiss, and currently does nothing with the row beyond the
  status update (`recommendations.decide`, recommendations.py:111-123). This
  endpoint is the seam phase I2 extends.
- **Inbox UI already exists and needs no changes.** Bell + inbox + banner
  cards with Approve/Later/Dismiss live in
  `frontend/src/chat/ChatPanel.tsx:737-784` (inbox state, `loadInbox`,
  decide handler) with API helpers at `frontend/src/api.ts:672-681`. Push
  deep-link `/chat?inbox=open` lands with the inbox open
  (ChatPanel.tsx:755-762). This lane makes NO ChatPanel.tsx edits.
- **Automations: table + leader-gated scheduler.** Columns: id, name,
  description, instruction, agent_name, interval_minutes (CHECK >= 5),
  enabled, is_system, consecutive_failures, last_run_at, next_run_at,
  last_status, last_summary (migrations/013_automations.sql:4-20), plus
  timeout_seconds (026_automation_timeout_digest_fix.sql:10-11, NULL = global
  default). The scheduler ticks every 60s (backend/app/scheduler.py:20), is
  leader-gated via `instances.is_leader()` (scheduler.py:69-70) which
  delegates to the Postgres advisory-lock election
  (backend/app/leader.py:29-40), kills runs with `asyncio.wait_for`
  (scheduler.py:55), journals run outcomes (scheduler.py:88-104), and
  auto-disables after 5 consecutive failures with an operator notification
  (scheduler.py:105-125). Due = `enabled AND next_run_at <= now()`
  (backend/app/automations.py:134-138). `next_run_at` is NOT in the PATCH
  whitelist (`_UPDATABLE`, automations.py:50-51) — manual triggering is a
  psql poke, see phase I1 Verify.
- **Agents are DB rows.** Columns: name, description, system_prompt, model,
  allowed_tools TEXT[], routing_keywords TEXT[], enabled, is_system
  (migrations/002_agents.sql:3-15). NULL allowed_tools = all builtins
  (backend/app/tools/registry.py:3-4); the grant check reads
  `agent["allowed_tools"]` (registry.py:114, :194) and every execution funnels
  through `execute_tool` (registry.py:308). Migration
  045_memory_curator_agent.sql is the house pattern for a new specialist:
  converging upsert (:47-70), deliberately tiny toolset (:61), model inherited
  from an existing agent (:60), rationale for keeping destructive/untrusted
  surfaces off it (:12-20).
- **Read tools the ideator needs already exist**: `search_memory`
  (builtin.py:1061, wraps `memory.context(query)` at :33), `read_memory_item`
  (:1209), `list_stale_topics` (:1260). No builtin exposes past
  recommendations to an agent today — phase I1 adds one (read-only).
- **Library tabs are the entity-CRUD surface.**
  `frontend/src/components/library/LibraryPage.tsx:13` declares
  `KINDS = ['agents','models','automations','rules','tools','skills']` and
  branches to a tab component per kind (:44-49). `AutomationsTab.tsx` is the
  template to copy: load + 15s poll (:19-26), cards with edit/delete/toggle,
  inline edit form, create form at the bottom.
- **No goals machinery exists.** Grep of `backend/app/migrations/001-049`
  for goal/project tables: nothing. Greenfield confirmed.

## Design

### B1 — the ideator (agent + weekly automation + inbox flow)

**Agent row** (INSERT via migration, 045-style converging upsert):

- `name`: `ideator`
- `description`: "Mines memory for the operator's interests, recurring
  friction, and stale wishes, then proposes a few concrete buildable ideas as
  recommendation cards. Read-only: it never builds, fetches, or writes —
  the operator decides."
- `model`: `(SELECT model FROM agents WHERE name = 'main')` — inherit main's
  model; idea quality is the point, and the eval pipeline
  (docs/plans/model-eval-pipeline.md, decision 3: ALL roles get suites) is the
  standing path to swap it later.
- `allowed_tools`: `ARRAY['search_memory','read_memory_item',
  'list_stale_topics','list_past_ideas','raise_recommendation']` — read-only
  plus raise. NO write_memory, NO web_search/fetch_url, NO ingest, NO
  delete, NO MCP grants. Untrusted-content surface: zero (the 045 rationale,
  045_memory_curator_agent.sql:12-20, applied in reverse — this agent has no
  destructive tools AND no untrusted input).
- `routing_keywords`: `ARRAY['idea','ideate','propose','brainstorm']`
- `is_system`: true

**System prompt** (verbatim; house prompt-craft: must-win rules last):

```
You are the Ideator. Once a week you mine Nova's memory — journals, topics,
ingested sources — for the operator's interests, recurring friction, and
stale wishes, and you propose a small number of concrete, buildable ideas.

For every idea you raise:
- It must be motivated by SPECIFIC memory items. Name them: cite each
  supporting item's title or id in the idea's body.
- Shape: a one-line pitch (the title), then a short body with "Why now"
  (the cited evidence) and "First step" (one plausible, concrete opening
  move someone could take this week).
- Raise it with raise_recommendation: kind 'idea', dedupe_key
  'idea:<kebab-slug-of-the-subject>' — pick the slug from the subject
  itself so the same subject always yields the same slug.

You only propose. You never build, schedule, fetch, or write memory.
Never re-propose a subject that list_past_ideas already shows, even
reworded, even if it is still undecided. A generic idea that could apply
to anyone is a failure: if you cannot cite the memory items that motivated
an idea, do not raise it. Proposing nothing is an acceptable outcome.
```

**Automation row** (same migration):

- `name`: `weekly-ideation`; `agent_name`: `ideator`;
  `interval_minutes`: 10080 (weekly); `timeout_seconds`: 900 (several
  memory searches plus reasoning on a 30-50 tok/s local model);
  `is_system`: false (operator may delete or retune it freely);
  `next_run_at`: `now() + interval '5 minutes'` so the first run happens
  during the build session; `ON CONFLICT (name) DO NOTHING`.
- `instruction` (verbatim):

```
Weekly ideation pass. Work in this order:
1. Call list_past_ideas and note every subject already raised. None of
   them may be proposed again, in any wording, regardless of status.
2. Mine memory for grounding: search_memory for the operator's recent
   interests, recurring frustrations or friction, wishes and "someday"
   remarks, and abandoned threads; use read_memory_item to read the
   promising hits in full; optionally call list_stale_topics for neglected
   subjects worth reviving. Ignore journal entries that are automation run
   reports.
3. Select at most 3 ideas (fewer is fine) that are concrete and buildable
   and grounded in what you read. For each, call raise_recommendation with
   kind 'idea', title = the one-line pitch, body = markdown with "Why now"
   citing the specific memory items by title/id and "First step" with a
   plausible opening move, dedupe_key = 'idea:<kebab-slug-of-subject>'.
4. Finish with a one-paragraph report listing the ideas you raised (or
   "no new ideas this week" if nothing was genuinely grounded — that is a
   valid result, not a failure).
```

**New builtin `list_past_ideas`** (backend/app/tools/builtin.py — the dedupe
ledger, read-only, no args):

```python
async def _list_past_ideas(args, ctx):
    """Every idea ever raised, with its fate — so the ideator never
    re-proposes one. Read-only."""
    from app import db
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT title, status, dedupe_key, created_at, decided_at "
            "FROM recommendations WHERE kind = 'idea' "
            "ORDER BY created_at DESC LIMIT 100")
    ...  # return _j([...]) with created_at/decided_at as str
```

Registered in BUILTIN_TOOLS (builtin.py:1060) with `"parameters":
{"type":"object", "properties": {}}`. Granted only to `ideator` in v1 (harmless if widened
later — it exposes titles and statuses, nothing sensitive).

**Dedupe design (this is the real feature).** Two layers:

1. Semantic, primary: the instruction's hard rule — `list_past_ideas` shows
   everything previously raised and NOTHING on that list may be re-proposed,
   even pending. Ideas are one-shot; an undecided card simply stays in the
   inbox. This also prevents the re-ping-on-refresh behavior (a dedupe
   refresh resets status to 'new' and re-fires the push,
   recommendations.py:66-86 — one-shot raising means it never happens).
2. Mechanical, backstop: `dedupe_key = 'idea:<slug>'` — if the model
   re-proposes anyway with the same slug, the DB refreshes the live row
   instead of stacking, and a decided/dismissed row is never resurrected
   (recommendations.py:62-75). Slug drift ("idea:voice-grocery" vs
   "idea:grocery-voice") slips this layer, which is why layer 1 is primary.

Rate limit fit: at most 3 raises per weekly run vs 12/hour per source — no
interaction, and the limit still catches a runaway/steered ideator.

### B2 — goals (table + approve seam + Library tab)

**Table** (new migration — next free migration number, re-check at build
time; 050 is currently contested between parallel lanes):

```sql
CREATE TABLE IF NOT EXISTS goals (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',   -- markdown; sub-steps live here
                                            -- as checklists ("- [ ] step") —
                                            -- NO task-hierarchy machinery
    status      TEXT NOT NULL DEFAULT 'approved'
                CHECK (status IN ('proposed','approved','active','paused',
                                  'paused_budget','done','abandoned')),
    created_by  TEXT NOT NULL DEFAULT 'operator',  -- 'operator' | raising
                                                   -- agent name ('ideator')
    source_recommendation_id UUID REFERENCES recommendations(id)
                                  ON DELETE SET NULL,
    -- budget rails reserved for self-improvement stage 4
    -- (docs/plans/self-improvement.md); nullable, NO reader in this lane
    max_tokens           BIGINT,
    max_cost_usd         NUMERIC(10,2),
    max_sessions_per_day INTEGER,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- double-approve must not create two goals
CREATE UNIQUE INDEX IF NOT EXISTS goals_source_rec_idx
    ON goals (source_recommendation_id)
    WHERE source_recommendation_id IS NOT NULL;
```

Status semantics: `proposed` is reserved for future direct-proposal flows
(unused in v1); `paused_budget` is reserved for self-improvement stage 4's
budget-exhaustion flip (docs/plans/self-improvement.md) — nothing in this
lane sets it, it is in the CHECK now so stage 4 truly needs no schema
change here (decision 8); approve-seam and operator-created goals start
`approved`;
the operator flips to `active` when work starts. `abandoned`/`done` are
terminal but editable (no is_system rows, no edit-mode gates — the
edit-mode-removed rule).

**Store** `backend/app/goals.py` (mirror `backend/app/automations.py` shape):
`list_goals(status: str = "all")`, `get(goal_id)`, `create(title,
description="", status="approved", created_by="operator",
source_recommendation_id=None)`, `update(goal_id, **updates)` with
`_UPDATABLE = {"title","description","status"}` and manual
`updated_at = now()`, `delete(goal_id)`. `create` with a
source_recommendation_id uses `ON CONFLICT DO NOTHING` + re-select so it is
idempotent.

**Approve seam** — extend the existing decide endpoint
(router_chat.py:1520-1532), keyed on `kind == 'idea'` alone. The
`raise_recommendation` builtin has no `action` parameter (builtin.py:922-931)
and gets none: an agent-authored structured action payload is a needless
surface, and `action` JSONB stays reserved for the recommendation-surface
phase-3 actionable-approve lane. After a successful decide:

```python
if choice == "approve" and row["kind"] == "idea":
    goal = await goals.create(
        title=row["title"], description=row["body"], status="approved",
        created_by=row["source"], source_recommendation_id=row["id"])
    row["goal_id"] = goal["id"]
return row
```

The inbox card UX is unchanged (card flips to approved exactly as today —
no ChatPanel edits); the goal appears in Library -> Goals.

**API** (add near the automations block, router_chat.py:1294 pattern;
operator-authenticated like everything on this API):

- `GET /api/v1/goals?status=all|active|...` — list.
- `GET /api/v1/goals/{goal_id}` — detail: `{goal, coding_tasks: [...],
  journal_mentions: [...]}`. `coding_tasks` = rows from the coding-team
  lane's `coding_tasks` table WHERE `goal_id` matches, wrapped in
  try/except returning `[]` when the table does not exist yet (parallel
  lane; see docs/plans/coding-team-pipeline.md). `journal_mentions` =
  best-effort: call `memory.context(goal["title"])` (the same call
  `search_memory` makes, builtin.py:33) and keep hits whose item id/path
  starts with `journals/` (confirm the exact hit shape in
  backend/app/memory/memory.py at build time), capped at 5.
- `POST /api/v1/goals` (201) — operator creates directly (title required).
- `PATCH /api/v1/goals/{goal_id}` — title/description/status.
- `DELETE /api/v1/goals/{goal_id}` — plain delete with frontend confirm.

**UI — Goals tab in Library.** `LibraryPage.tsx:13`: KINDS becomes
`['agents','models','automations','rules','tools','skills','goals']`; import
and branch to `GoalsTab` (:44-49 pattern). New file
`frontend/src/components/library/GoalsTab.tsx` copied from
`AutomationsTab.tsx`: load + 15s poll, one card per goal (title, status
badge, created_by + created_at line, description rendered as the same
whitespace-pre-wrap clamped block AutomationsTab uses for instructions with
show full/less), inline edit form (title input, description textarea, status
select), delete with `window.confirm`, "+ new goal" create form at the
bottom. Expanded card shows linked coding tasks (only when non-empty) and
journal mentions from the detail endpoint. `frontend/src/api.ts` gains
`Goal` type + `getGoals/getGoal/createGoal/patchGoal/deleteGoal` — append at
the end of the file (api.ts is the known parallel-lane collision hotspot;
additions only, no edits to existing helpers).

### Flow into coding (substrate only)

"Work on goal X" is a chat sentence, not a subsystem: Nova-main reads the
goal (read-only builtin, phase I3), drafts a brief as PM, and creates a
pipeline task carrying `goal_id` via the coding-team lane's
`create_coding_task` builtin. T1's signature is
`create_coding_task(workspace, title, brief, size)`
(docs/plans/coding-team-pipeline.md:167) — it has NO goal_id parameter,
and nothing in either spec sets the nullable `coding_tasks.goal_id`
column (:118) — so THIS lane owns the extension: phase I3 adds an
optional `goal_id` argument to that builtin. Dispatch
depth stays 1 — no agent-to-agent conversation, the pipeline state machine
does the orchestration. Autonomous initiation (Nova starting work on a goal
without being asked) is EXCLUSIVELY self-improvement stage 4; nothing in
this lane may trigger the pipeline on its own.

## Phases (each ends live-verified through :5173; changes left uncommitted, summarized)

**I1 — ideator agent + weekly automation + inbox flow.** One migration (next
free migration number — re-check at build time; 050 is currently contested
between parallel lanes): ideator agent upsert + weekly-ideation automation
insert, both exactly as specified above. `list_past_ideas` builtin in
tools/builtin.py. `docker compose up -d backend` (not `restart`, which
skips `.env` re-reads; migrations run at process startup either way).
Verify: watch the automation fire (next_run_at is seeded
5 minutes out; to re-trigger, poke the DB —
`docker compose exec postgres psql -U nova -c "UPDATE automations SET
next_run_at = now() WHERE name = 'weekly-ideation'"` — since next_run_at is
deliberately not PATCH-able, automations.py:50-51). In :5173, 1-3 idea cards
appear in the bell inbox, each body citing specific memory items; Dismiss
one, re-trigger the automation, and confirm the dismissed subject is NOT
re-proposed (the run report should say it skipped known subjects) and no
duplicate card appears. Check Library -> Automations shows weekly-ideation
with last run ok.

**I2 — goals table + approve-creates-goal seam + Library Goals tab.** Second
migration (again: next free number at build time) with the goals DDL;
`backend/app/goals.py`; the five endpoints; the decide-endpoint seam;
GoalsTab.tsx + LibraryPage.tsx KINDS entry + api.ts additions. Verify:
in :5173 approve an idea card in the inbox; open Library -> Goals and see the
goal (status approved, created_by ideator); edit its status to active and add
a markdown checklist to the description; approve the same card again via
curl to confirm no second goal appears; `docker compose up -d backend` (or
restart the container) and confirm the goal and its
source_recommendation_id survive; create and delete a manual goal. Phone
path note: :8080 needs `docker compose build web && docker compose up -d
web` to show the new tab — verify target remains :5173.

**I3 — chat integration: "work on goal X" -> brief handoff.** DEPENDENT on
docs/plans/coding-team-pipeline.md T1 having landed (the coding_tasks table
+ `create_coding_task` builtin); keep this phase small and defer it if T1
is not merged. This phase ALSO extends that builtin: T1 defines
`create_coding_task(workspace, title, brief, size)`
(coding-team-pipeline.md:167) with no goal_id parameter, so I3 adds an
optional `goal_id` argument (nullable; validated to exist in the goals
table, else the tool errors) that writes `coding_tasks.goal_id` — the
column exists (:118) but has no writer until this phase. One migration:
add a read-only `list_goals` builtin (id, title,
status, first 200 chars of description) granted to `main`
(array_append-guarded, 013_automations.sql:35-39 pattern), and append a
paragraph to main's system_prompt (append-once guard, the
045_memory_curator_agent.sql:84-87 pattern): when the operator asks to work
on a goal, call list_goals to find it, draft a short brief (goal title,
relevant description/checklist items, constraints), and create a coding
task via `create_coding_task(workspace, title, brief, size,
goal_id=<the goal's id>)`; report the created task id; never start work
on a goal unprompted.
Verify: in :5173 chat, "what goals are open?" lists the goal from I2;
"work on goal <title>" produces a brief and a created pipeline task whose
goal_id links back — Library -> Goals detail now shows it under linked
coding tasks.

## Decisions

Defaults chosen so phase 1 can start; open ones flagged.

1. **Ideation cadence** — default weekly (interval_minutes 10080). Open to
   retune from Library -> Automations at any time (is_system false).
2. **Web-informed ideation** — default NO in v1. The ideator's untrusted-
   content surface is deliberately zero; grounding comes from memory, which
   ingestion already fills from followed sources. Revisit only as an
   explicit later decision — if granted, web tools arrive WITHOUT any new
   write/destructive grants (the 045 trust-boundary rationale).
3. **Idea count per run** — at most 3, zero allowed ("no new ideas this
   week" is a valid, honest result).
4. **How raised ideas are recorded** — the recommendations table itself is
   the ledger, read back via the new read-only `list_past_ideas` builtin.
   NOT write_memory to a nova-ideas topic: tool grants are per-tool, not
   per-topic (registry.py:114/194), so "write_memory scoped to one topic"
   does not actually exist — it would grant general memory writes to an
   agent that needs none. Zero write capability is the simplest sound
   default.
5. **Ideator model** — inherit main's model at seed time (045:60 pattern);
   the eval pipeline is the promotion path if a cheaper model proves out.
6. **Goals in chat, v1** — Library only. No goal cards, no ChatPanel
   surface; I3's `list_goals` on main is the sole chat touchpoint and lands
   only with the pipeline dependency.
7. **Approve seam trigger** — `kind == 'idea'` on the decide endpoint; no
   `action` payload on raise_recommendation (agent-authored structured
   actions are a needless surface; `action` stays reserved for
   recommendation-surface phase 3).
8. LOCKED (Jeremy, 2026-07-24): autonomous goal initiation is EXCLUSIVELY
   self-improvement stage 4 — this lane builds substrate, never autonomy;
   goals carry the nullable budget columns now so stage 4 needs no schema
   change here.
9. LOCKED (Jeremy, 2026-07-24): no task-hierarchy machinery — sub-steps are
   markdown checklists inside goals.description.
10. LOCKED (Jeremy, 2026-07-24): coding work links to goals via
    `coding_tasks.goal_id` in the coding-team pipeline lane
    (docs/plans/coding-team-pipeline.md); Nova-main is PM, the pipeline is
    staged ACP sessions driven by a backend state machine, and operator
    merge gates all code indefinitely.
11. LOCKED (Jeremy, 2026-07-24): one phase per session; each lane in its own
    branch + `.worktrees/<lane>`; changes left uncommitted for Jeremy.

## Traps / risks

- **Idea spam is the failure mode that kills the feature.** The 12/hr rate
  limit is a backstop, not the design — operator fatigue arrives long before
  12 cards. The real controls: max 3 per WEEK, one-shot raising (never
  re-propose, even undecided — layer 1 dedupe), and the DB never
  resurrecting decided rows (layer 2, recommendations.py:62-75). Each new
  card also fires a push (recommendations.py:81-86): 1-3 pushes weekly is
  acceptable; if it grates, drop the count or priority, not the dedupe.
- **Generic flattering ideas are failures.** A weak model will emit "build a
  dashboard!" mush. The citation requirement (name the motivating memory
  items in the body) is the guard AND is mechanically checkable later — when
  the ideator gets an eval suite (model-eval-pipeline.md decision 3 covers
  future agents), "body cites >= 1 real memory item id" is a contract check.
- **The ideator must never gain write/destructive/web grants by default.**
  Same trust-boundary reasoning as migration 045 (:12-20): capability and
  untrusted input stay on separate agents. The ideator has neither — keep it
  that way when tempted to "just let it fetch one page." Web-informed
  ideation is decision 2, an explicit later opt-in.
- **Double-approve creating duplicate goals.** `recommendations.decide`
  updates unconditionally (recommendations.py:111-123, no status guard), so
  the seam MUST be idempotent: the partial unique index on
  source_recommendation_id + ON CONFLICT DO NOTHING re-select.
- **Journal noise poisons mining.** The scheduler journals every automation
  run (scheduler.py:88-104), including weekly-ideation's own reports — the
  instruction's "ignore automation run reports" line matters; without it the
  ideator ideates about its own ideation.
- **Slug drift slips mechanical dedupe.** 'idea:voice-grocery' vs
  'idea:grocery-voice' are distinct dedupe_keys — which is why the semantic
  layer (list_past_ideas + never-re-propose) is primary, and why the Verify
  in I1 explicitly re-runs after a Dismiss.
- **Parallel-lane collisions.** api.ts and ChatPanel.tsx are the known
  hotspots: this lane appends to api.ts only and touches ChatPanel.tsx not
  at all (deliberate). Migration numbers: never pin — take the next free
  number at build time (050 is currently contested between parallel lanes).
  I3 shares main's system_prompt with other lanes' migrations — use the
  append-once + regexp-strip convergence pattern (045:75-87), never a full
  overwrite.
- **Stale phone path.** :8080 serves a baked build — the Goals tab and inbox
  changes will not appear there until `docker compose build web && docker
  compose up -d web`. Verify through :5173 first (house rule), rebuild web
  before concluding anything is missing on the phone.
- **`docker compose restart backend` does not re-read `.env`** (the
  CLAUDE.md trap) — use `docker compose up -d backend` after env changes.
  Migrations are NOT the issue: they run at every backend process start
  (main.py lifespan -> db.run_migrations), and the dev container's
  `uvicorn --reload` (with `./backend` bind-mounted) restarts the process
  when a phase's `.py` edits sync — every phase here ships `.py` alongside
  `.sql`, so its migration applies automatically. Edge case: a `.sql`-only
  change with nothing else touched makes `up -d` a no-op — force a process
  restart to apply it.
- **Containment.** Nothing here may become an action channel: goals have no
  executor in this lane, the ideator cannot touch the coder pipeline, and
  the budget columns stay unread until self-improvement stage 4's
  operator-gated autonomy toggle (which, like guardian rules and
  consents.py, is operator-only and outside anything an agent can write).
