# Slice 12 — carries

Open items from S12 (agents). Each is a fact about what is NOT built, so a
later slice starts from the truth rather than from a re-discovery.

## Jeremy's optional late feature: the office view

His words, 2026-09-08: "add animations or some kind of view of each agent
as if they're in an office doing stuff. If idle, they may be in a lounge
but if working, they would be seen at a desk doing things, or we could even
make fun rooms like a garage and if an agent is 'working' they'd be working
on a vehicle." Explicitly NOT this slice.

Everything such a view needs already exists and is derived: `GET
/api/v1/agents` returns `state {working, doing, since, turn_id}` per agent,
where `doing` is `starting` / `thinking` / the tool name, written by the one
funnel for every turn and popped in its finally. The Agents page already
polls it every 5 s. An office view is a different renderer over the same
poll — no schema, no new writer.

One caveat to carry: `traces.DOING` is process-local (correct for the single
core process this stack runs). A multi-process core would need that map in
the database or a shared cache before any view could trust it.

## Named in the plan, deliberately not built

- **Eval corpus case for delegation.** `delegation_claim_check` reads the
  LIVE agents table, and the eval scratch world has no fixture agent, so a
  bad trace could never fire. Needs a `setup.agents` hook in
  `app/evals/cases.py`, then the `delegate-and-report` case and
  `suite_version` 8. The corpus stays at 16 ids / v7 until then.
- **Target-level delegation backing.** The guard checks the AGENT
  ("did coder run at all?"), not the TARGET ("did it write plan.md?"). Nova
  reads the facts line, which lists the real files, so the gap is her
  paraphrase of a list she was given correctly. Closing it means comparing
  claimed file names against `meta.facts[].files`.
- **`memory_search` over the shared scope** for a read-shared agent. Today
  the shared scope reaches an agent only through the automatic recall,
  because `ToolContext` carries one person and its field set is pinned. The
  agent's prompt states exactly that, so nothing lies; a tool-level shared
  search would need a second scope on the context or a scoped tool.
- **Parallel and agent-to-agent delegation.** Depth is 1 and delegations are
  sequential, stated as a fact of this slice's shape in the refusal an agent
  gets. Lifting it needs a stated depth cap and a story for two children
  writing the same folder.
- **Skills are thin on purpose.** A skill is a markdown file at
  `<WORKSPACE_ROOT>/skills/<name>.md` attached by name; no table, no
  lifecycle, no versioning. S14 (Skills) owns those and can index the same
  files without a migration.

## Operational

- **Nginx read timeout on the phone path.** A long delegation holds Nova's
  turn open (worst case rounds × the 300 s gateway read timeout). The turn
  is detached, so a cut browser stream cannot cut the work, and the
  collapsed line keeps moving through progress frames — but the `web`
  service's read timeout for `/api/v1/chat/stream` has not been checked
  against a run that long.
- **Cap read cost.** One `/admin/spend` read per agent turn. A slow ledger
  makes the cap advisory (fail-open, stated on the span, in the delegate
  result and on the page) until the read is fast again.
- **A person-owned-row writer added later** must call
  `agents.refuse_person_write` or hit a foreign key. Two sites do today
  (`create_timer`, `cancel_timer`); there is no grep-free pin, so this is a
  fact to re-check when such a tool is added. A missed site fails STATED
  through dispatch, never silently.
- **`agents.max_tool_rounds` the SETTING** and `agents.max_tool_rounds` the
  COLUMN share a name from different eras: the setting is the default copied
  into a new row at creation, the column is what an agent actually runs
  with. Worth renaming the setting the next time settings move.

## Carried in from S10, still open

- Merge `slice/s10` (and now `slice/s12`) into `rebuild/v4` once the S9
  session's working tree is clean.
- True GPU seconds for local models (the ledger records GPU-minutes ≠ USD
  and never converts).
