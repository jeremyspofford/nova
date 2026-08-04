# Approve that does something

Phase 3 of `docs/plans/recommendation-surface.md`, scoped for real.

Status, 2026-08-04, branch `rec-actions` (uncommitted):

- **Phase 0 BUILT** — the card states what Approve does, or says plainly that
  it only records a decision.
- **Phase 1 BUILT** — typed plans, the boot gate, the shared outbound guard,
  and automatic preflight. Verified live: the OSSInsight endpoint comes back
  `blocked` with `405 Method Not Allowed` on the card, before anyone reads it.
- **Phases 2-5 NOT BUILT.** Nothing executes yet, and the UI derives that
  admission from `Spec.execute is None` rather than being told to say it.

Decisions Jeremy has made (2026-08-04): automatic preflight at raise time,
YES (built, phase 1). Grant on Approve, ONE CLICK — phase 3 folds into phase
2, and phase 2 is not built. Decisions 3 and 4 at the bottom still stand.

One change to phase 4's ordering fell out of building this: phase 1's
verification wants `raise_recommendation` to accept an `action`, and it does
not until phase 4. Phase 1 was therefore verified through `create()` and the
API rather than through a chat turn, which exercises the same `actions.parse`
call but not the model's ability to fill the form in. That half is still
unproven and phase 4 is where it gets proven.

---

## Verdict: no. She cannot implement the OSSInsight card today, and approving it does nothing.

`recommendations.decide()` (backend/app/recommendations.py:110-124) is one
`UPDATE recommendations SET status='approved'` plus `_receipt()`, which writes a
log line, a `capability_events` row and a journal entry. There is no dispatch,
no tool call, no consent, no scheduler hook. The `action jsonb` column that
migration 032 added for exactly this ("optional structured one-click apply
(phase 3)") is written by nobody and read by nobody: `raise_recommendation`'s
schema (builtin.py:2556-2569) has no `action` property, none of the three
producers pass one, and on the live DB `SELECT count(*), count(action) FROM
recommendations` returns 4 / 0. Even if something did read it, there is no
agent-facing path to MCP registration at all — `grep -io mcp backend/app/tools/builtin.py`
returns four hits, all comments or `raise_recommendation` schema strings.
Approving `abb3b1e0-44e2-4968-a84a-3bcf1c637e4d` moves it out of the banner and
changes nothing else.

Second verdict, because it matters more than the first: **the OSSInsight card is
also wrong.** There is no hosted OSSInsight MCP server. `https://ossinsight.io/api/mcp`
is a REST endpoint with "MCP" in its path (`export async function GET`, `?action=`
query params, `{ok,data}` responses); a JSON-RPC `initialize` POST answers **405
Method Not Allowed** and `/api/mcp/sse` 404s. The only installable thing is
`npx -y ossinsight-mcp`, a 3-star, 1-commit, single-maintainer npm package
published 2026-04-16 that wraps a keyless public REST API. So the honest ask is
not "make Approve install this". It is "make Approve capable of executing a plan
when there is one, and capable of refuting the plan when there isn't."

---

## The line

**Approve executes when the card carries a typed plan that is a complete
description of a final state the backend already has an operator-only route for.
Approve never runs a model. Approve never writes code.**

That is the position, and here is the defence of each half.

- **Typed plan, not free text.** The model fills in a form. A pydantic v2
  discriminated union with `extra="forbid"` parses it at raise time and again at
  run time. There is no free-text field on the path to an executor. The
  dangerous cases are not refused by a check somebody maintains, they are
  *unrepresentable*: there is no `command` field, so npx-exec cannot be written
  down; there is no `enabled` field on any other row, so nothing existing can be
  mutated.
- **Executors are thin calls into existing operator paths.** `mcp_server.add`
  writes no SQL. It calls `mcp_servers.create()` -> `mcp_servers.update(enabled=True)`
  -> `mcp_servers.refresh()`, which is exactly what `router_chat.py:1208-1236`
  does when Jeremy uses the Library -> Tools form. The stdio launcher allow-list,
  the transport CHECK, the unique-name constraint and the tools_hash mechanics
  are inherited, never copied. Widening `mcp_servers._STDIO_COMMANDS` moves the
  executor with zero edits. Migration 037 exists because a copied rule drifted;
  this design has nothing to copy.
- **No LLM in the execution path.** Not because a model cannot be trusted with a
  plan, but because the operator is approving a *title*. The generality lives in
  the contract (propose -> typed plan -> operator reads the plan -> backend
  executes -> receipts -> visible failure), not in the executor set.
- **Approve never writes code.** `delegate_coding_task` already exists and
  already cannot push (`git` is absent from `coder/acp.py::_ALLOWED_COMMANDS`;
  `broker.py::_capture` commits to a branch in a private volume and never
  merges; `patches.py` has no `apply()` at all). Wiring a card to it would
  produce a branch nobody can reach. Out of scope, stated below.

What generalises past `mcp_server`: `tool.http_add`, `automation.add`,
`model.pull`, `setting.set`. Each is a pydantic model plus a function that calls
one existing route's helper. The expensive parts (digest binding, preflight,
orphan reset, retention interaction, receipts) are paid once.

---

## Phase 0 — Tell the truth about Approve

No execution. No migration. Ships the honesty win on its own and is immediately
correct for the three cards already in the table.

**Modify**

- `backend/app/recommendations.py` — add a module-level `action_digest(action)`
  returning `sha256(json.dumps(action, sort_keys=True, separators=(",",":")))`,
  and include `action_digest` + `action_plan` (server-rendered prose) in `_row()`.
  The digest is DERIVED on every read, never stored and never client-supplied.
- `backend/app/actions/__init__.py` (new, ~40 lines at this phase) — `describe(action)
  -> str | None`, rendering the human-readable plan from the parsed document.
  Nothing else yet.
- `frontend/src/api.ts` — `interface RecCard` gains `action: object | null;
  action_digest: string | null; action_plan: string | null`. The API has been
  serving `action` since migration 032 (`recommendations._FIELDS:28`); only the
  TS interface dropped it.
- `frontend/src/chat/ChatPanel.tsx` — under the body in both the banner (:2232)
  and the inbox row (:2168), render either the plan block or the literal
  sentence *"No action plan on this card. Approving records your decision only."*
  Button label derives from `action`: `Approve & install` when non-null, plain
  `Approve` when null.

**Verify at :5173** — open chat, click the bell, expand "Add the OSSInsight MCP
server". It reads "No action plan on this card. Approving records your decision
only." and the button says `Approve`. Then `UPDATE recommendations SET action =
'{"type":"mcp_server.add","name":"scratch","transport":"http","url":"https://example.invalid/mcp","headers":{},"read_only":true,"grant_to":[],"why":"test"}'::jsonb
WHERE dedupe_key='mcp:docker-hub';`, reload, and confirm that card renders the
plan block with the URL visible and the button now reads `Approve & install`.
Do not click it.

---

## Phase 1 — The claim is checked against the network, before he reads it

The highest value-per-day slice in the plan. This is what turns Nova's confident,
wrong OSSInsight claim into a mechanical refutation.

**Migration `backend/app/migrations/087_action_preflight.sql`** (086 is the
highest applied; `db.py:58` sorts by filename, so the gap at 084 is irrelevant)

```sql
-- The `action` column has existed since 032 and has never been written or
-- read. It becomes a typed PLAN. These columns are the network verdict on
-- that plan, taken before the operator ever sees the card.
ALTER TABLE recommendations
  ADD COLUMN action_state      text NOT NULL DEFAULT 'none'
    CHECK (action_state IN ('none','ready','blocked')),
  ADD COLUMN action_detail     text,
  ADD COLUMN action_checked_at timestamptz;

-- Provenance for the MCP registry. An operator's http://homeassistant.local
-- row is legitimate; a row an action created is not allowed to name a
-- private address, now or on any later refresh. Derived from this column,
-- never from a maintained host list.
ALTER TABLE mcp_servers
  ADD COLUMN created_by text NOT NULL DEFAULT 'operator';
```

**Create**

- `backend/app/net_guard.py` — `_validate_target` and `is_public_address` moved
  verbatim out of `backend/app/tools/web_fetch.py:33-79` (the CGNAT- and
  NAT64-correct allow-list). `web_fetch` imports them back, so there is one
  copy. Three separate designs independently needed this function and two
  reached for it by private cross-module import; making it a module is the
  point.
- `backend/app/actions/schemas.py` — the pydantic union. Phase-1 content:

```python
class _Action(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

_SECRET_REF = re.compile(r"^\{\{secret:[A-Za-z0-9_.-]+\}\}$")

class McpServerAdd(_Action):
    type: Literal["mcp_server.add"]
    name: Annotated[str, StringConstraints(pattern=r"^[a-z0-9][a-z0-9-]{1,38}$")]
    transport: Literal["http"]                       # see OUT OF SCOPE
    url: Annotated[str, StringConstraints(pattern=r"^https://")]
    headers: dict[str, str] = {}
    read_only: bool = False
    grant_to: list[str] = []                         # agent names, phase 3
    why: Annotated[str, StringConstraints(max_length=280)]

    @field_validator("headers")
    @classmethod
    def _no_literal_credentials(cls, v):
        for k, val in v.items():
            if not _SECRET_REF.match(val):
                raise ValueError(
                    f"header {k!r} must be a secret reference like "
                    f"{{{{secret:name}}}} — put the value in Settings -> Secrets")
        return v

ActionDoc = Annotated[Union[McpServerAdd], Field(discriminator="type")]
```

  `pydantic>=2.5.0` is already a backend dependency (`backend/pyproject.toml:15`).
  No new package.

**Modify**

- `backend/app/actions/__init__.py` — `parse(raw) -> ActionDoc`,
  `preflight(rec_id, *, operator=False)`, `_TYPES` registry. Each `Spec` carries
  `operator_route: str`, the name of the function in `router_chat` whose effect
  it reproduces; `assert_routes_exist()` is called from `main.py` lifespan and
  raises at boot if one is missing. That is the mechanical version of the rule
  "an executor may only exist where the operator can already do it from the UI".
- `backend/app/recommendations.py` — `create()` calls `actions.parse()` before
  the INSERT and re-raises the pydantic error as `ValueError`, then
  `bg.spawn(actions.preflight(rec_id), name="action-preflight")`.
- `backend/app/mcp_client.py` — `connect_and_list()` and `call_tool()` call
  `net_guard._validate_target(url)` when `server.get("created_by") not in
  (None, "operator")`, and refuse with an error string. This covers the 15-minute
  background refresh at `tools/registry.py:118-131`, which nothing else in any
  candidate design covered: a hostname that passes once and later resolves
  internal would otherwise be dialled forever.
- `backend/app/mcp_servers.py` — `created_by` added to `_FIELDS`, accepted as a
  create kwarg.
- `backend/app/router_chat.py` — `POST /api/v1/recommendations/{id}/preflight`
  (operator-only, same auth middleware), calling `actions.preflight(id,
  operator=True)`. This is the `Test` button, and it is the only path that
  probes WITH the plan's headers.
- `frontend/src/api.ts` + `ChatPanel.tsx` — surface `action_state` /
  `action_detail` / `action_checked_at`. Button label becomes `Approve & install`
  when `ready`, `Approve anyway` plus a `Test again` button when `blocked`.

**Preflight semantics.** For `mcp_server.add`: `net_guard._validate_target(url)`,
then `mcp_client.connect_and_list({"transport":"http","url":url,"headers":{},"name":name,
"created_by":"action"})` against an ephemeral dict that is never persisted
(`connect_and_list` takes a plain dict and touches no database, mcp_client.py:40-79;
it never raises, it returns `(status, tools, detail)`). Connected -> `ready`,
detail = tool count and the first ten names. Error -> `blocked`, detail = the
verbatim error. **Headers are dropped on the automatic path** and only sent from
the operator-triggered `Test` route: model-chosen headers to a model-chosen URL
is an exfiltration primitive that `fetch_url` does not give her, and this design
is not going to hand her one by accident.

**Verify at :5173** — in a real chat turn, ask Nova (main holds
`raise_recommendation`) to raise a test card with an action whose url is
`https://ossinsight.io/api/mcp`. Watch the tool result come back clean, then the
card appears in the inbox within seconds marked *"This cannot run yet. Preflight
failed: ... 405 Method Not Allowed."* Then ask her to raise one pointing at
`http://192.168.1.1/mcp` and confirm she gets `Error: action rejected: url` in
the reply text of that same turn (the `^https://` constraint fires first;
`net_guard` catches a public-hostname-that-resolves-private in preflight).

---

## Phase 2 — The spine and the first executor

Register and connect. Stops deliberately short of granting anything.

**Migration `backend/app/migrations/088_action_runs.sql`**

```sql
-- Durable execution record. Mirrors ingest_jobs (041): rows survive a
-- restart, FOR UPDATE SKIP LOCKED so two backends never claim one run.
CREATE TABLE action_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_id uuid NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
  action            jsonb NOT NULL,        -- FROZEN copy, taken at approve time
  action_type       text  NOT NULL,
  status            text  NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','awaiting_grant','succeeded','failed')),
  steps             jsonb NOT NULL DEFAULT '[]',   -- append-only receipt log
  result            jsonb,                          -- server_id, tool names
  error             text,
  attempts          int   NOT NULL DEFAULT 0,
  orphans           int   NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz, finished_at timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- A double-click cannot start two runs. This index is the refusal.
CREATE UNIQUE INDEX action_runs_one_live_per_rec
  ON action_runs (recommendation_id)
  WHERE status IN ('queued','running','awaiting_grant');
CREATE INDEX action_runs_queued_idx ON action_runs (created_at) WHERE status = 'queued';
```

No new state columns on `recommendations`. Run state lives in one place and is
joined onto the card as a `run` object by `list_all()`.

**Create**

- `backend/app/actions/mcp_server.py` — the executor. Steps, in this order:
  1. `validate_target` — `net_guard._validate_target(doc.url)`; non-None refuses.
  2. `probe` — `mcp_client.connect_and_list(ephemeral_dict)` with the plan's
     headers resolved through `secret_store` at the call. Error here fails the
     run and **nothing has been written**.
  3. `register` — `mcp_servers.create(name=..., transport="http", url=...,
     headers=..., read_only=doc.read_only, created_by="action")`. A duplicate
     name raises `ValueError` from mcp_servers.py:121 and fails the step cleanly.
  4. `connect` — `mcp_servers.update(id, enabled=True)` then
     `mcp_servers.refresh(id)`. On anything other than `status='connected'`:
     emit a `rollback` step, `mcp_servers.delete(id)`, fail. A half-registered
     dead server is worse than none.
  5. `report` — `mcp_servers.list_tools_for(id)`; store the tool names in
     `result`. Terminal status is `awaiting_grant` if `doc.grant_to` is
     non-empty, else `succeeded`.
  6. `capability_events.record(MCP_SERVER, name, "registered", actor="operator
     (approved recommendation)", detail={...})`. `MCP_SERVER` has been defined at
     capability_events.py:32 since migration 057 and has never once been written.
- `backend/app/action_worker.py` — the loop, started in `main.py` lifespan next
  to `ingest_worker.loop()` (main.py:82), gated on `instances.is_leader()` the
  way `scheduler.tick` is at scheduler.py:139. `claim_next()` is `ingest_jobs.claim_next`
  (ingest_jobs.py:68-83) with one addition:

```sql
WHERE id = (SELECT r0.id FROM action_runs r0
              JOIN recommendations rec ON rec.id = r0.recommendation_id
             WHERE r0.status = 'queued'
               AND rec.status = 'approved' AND rec.decided_by = 'operator'
             ORDER BY r0.created_at FOR UPDATE SKIP LOCKED LIMIT 1)
```

  The join makes the operator's approval a standing precondition of every
  claim, re-checked at claim time rather than trusted once at enqueue.
- `backend/tests/test_recommendation_actions.py`.

**Modify**

- `backend/app/recommendations.py` — `decide()` gains `expected_digest`, and the
  digest compare, status flip and run insert happen in ONE transaction under
  `SELECT ... FOR UPDATE`:

```python
async with db.acquire() as conn, conn.transaction():
    cur = await conn.fetchrow("SELECT action, action_state FROM recommendations "
                              "WHERE id=$1 FOR UPDATE", rid)
    if cur is None: return None
    if cur["action"] is not None and expected_digest != action_digest(cur["action"]):
        raise PlanChanged("this card's plan changed since you looked — reload it")
    r = await conn.fetchrow("UPDATE recommendations SET status=$2, decided_at=now(), "
                            "decided_by='operator' WHERE id=$1 RETURNING *", rid, new_status)
    if new_status == "approved" and cur["action"] and cur["action_state"] == "ready":
        await conn.execute("INSERT INTO action_runs (recommendation_id, action, action_type) "
                           "VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", rid, cur["action"], typ)
```

  This closes a race that is real today: `create()`'s
  `ON CONFLICT ... DO UPDATE SET action=EXCLUDED.action ... WHERE status = ANY('new','seen','later')`
  (recommendations.py:62-71) lets the weekly mcp-server-discovery automation
  rewrite a card's plan between render and click. Without the digest, every
  design in this space can execute a plan the operator never read.
- `backend/app/router_chat.py` — `decide_recommendation_endpoint` accepts
  `action_digest` in the body and maps `PlanChanged` to HTTP 409. A caller that
  omits the digest on a card that HAS an action is refused (`None != digest`),
  so an old client fails closed. Add `POST /api/v1/recommendations/{id}/run`
  (operator-only) to re-queue a `failed` run.
- `backend/app/retention.py:46-48` — rewrite the sweep. It currently deletes
  `status <> 'new'`, which destroys `later` and `seen` rows that
  `recommendations._ACTIONABLE:24` still counts as undecided, and would now
  cascade-delete live runs:

```python
("decided recommendations",
 "DELETE FROM recommendations WHERE status NOT IN ('new','seen','later') "
 "  AND created_at < now() - ($1 || ' days')::interval "
 "  AND NOT EXISTS (SELECT 1 FROM action_runs ar "
 "                  WHERE ar.recommendation_id = recommendations.id "
 "                    AND ar.status IN ('queued','running','awaiting_grant'))"),
```

- `backend/app/settings_store.py` — `actions.enabled` (boolean, default true,
  section Agents) and `actions.timeout_s` (number, default 120). With
  `actions.enabled` off, `decide()` skips the run insert and the card says so.
- `frontend/src/chat/ChatPanel.tsx` — the card does not vanish on Approve when
  it carries an action. It stays with a live step list; the 60s `loadRecs` poll
  (:1508) drops to 3s while any visible card has a non-terminal run.
  `decideRecCard` posts the digest the UI rendered.

**Verify at :5173** — this needs one public HTTPS endpoint that actually speaks
streamable-HTTP MCP. Find one, confirm it with the phase-1 `Test` button, then
hand-write an action naming it onto a scratch card by SQL, approve it in chat,
and watch the steps land and the server appear in Library -> Tools with
status `connected` and its tools listed under "review tools". Then repeat with
`https://ossinsight.io/api/mcp` and confirm the run fails at `probe`, the card
turns red with the 405 verbatim, and `SELECT count(*) FROM mcp_servers` is
unchanged. If no public MCP endpoint can be found, phase 2 ships verified on the
failure path only and the success path is verified when phase 3 lands; do not
add a settings bypass to point it at loopback.

---

## Phase 3 — The grant step. FOLDED INTO PHASE 2 by Jeremy's decision.

A registered server nobody can call means the operator finishes the install by
hand, and the button was theatre.

**DECIDED 2026-08-04: one click.** Approve registers, connects, grants, and
verifies, in one run. There is no `awaiting_grant` park and no second button —
phase 2 builds this phase's `grant()` and `verify()` steps as steps 6 and 7 of
the same executor, and `action_runs.status` drops `awaiting_grant` from its
CHECK.

What that decision costs, stated plainly so it is not rediscovered later:
`mcp_servers.refresh` auto-approves the first tool list it ever sees
(`stored_hash is None`, mcp_servers.py:176), so a third-party server's tool
DESCRIPTIONS enter the granted agent's prompt without a human having read
them. `tools_hash` protects against that server CHANGING its descriptions
afterwards; it does not protect against a hostile one at registration. The
mitigations that remain are the ones already in the design: the plan is
rendered on the card with the URL visible before the click, `net_guard`
refuses non-public targets on every connect and every call, `read_only`
narrows what the fence permits, and `grant_to` is an explicit list in the
plan the operator read — an empty `grant_to` still grants nothing.

Two consequences for phase 2's build:

- The card must show `grant_to` prominently in the plan block, since the
  click now authorises it. `_describe_mcp` already renders it.
- `verify()` becomes load-bearing rather than a nicety: with no second click
  there is no human confirming the tools arrived, so the run must assert
  against `tools/registry.get_agent_tools(agent)` and report both sides when
  they disagree.

**Modify**

- `backend/app/actions/mcp_server.py` — `grant(run_id)`:

```python
tools = await mcp_servers.list_tools_for(server_id)
names = {f"mcp:{server_name}/{t['name']}" for t in tools}     # constructed here
for agent_name in doc.grant_to:
    agent = await agent_registry.get_by_name(agent_name)
    old = set(agent.get("allowed_tools") or [])
    await agent_registry.update_agent(agent["id"], operator=True,
        actor=f"operator (approved recommendation {rec_id})",
        allowed_tools=sorted(old | names))
```

  No caller-supplied list ever reaches the UPDATE. The union is additive, so an
  approved plan cannot revoke a grant; `names` is built from the live cache with
  a fixed prefix, so it cannot name a non-MCP tool or another server's tool;
  `allowed_tools` is the only field passed, so `model`, `prompt`, `name` and
  `enabled` are untouchable regardless of `operator=True`. Named grants, never
  `mcp:<server>:*` — a wildcard would silently pick up tools added later.
- `backend/app/actions/mcp_server.py` — `verify(run_id)`: re-read the server row
  (`enabled AND status='connected'`) and call `tools/registry.get_agent_tools(agent)`,
  asserting the granted names are actually in the returned toolset. Registered is
  not reaching the model. Success is computed in Python from live state; if the
  registry and the report disagree, the receipt prints both.
- `backend/app/router_chat.py` — `POST /api/v1/recommendations/{id}/grant`,
  operator-only, moves a run from `awaiting_grant` to `succeeded`.
- `ChatPanel.tsx` — the `awaiting_grant` card: tool names with descriptions,
  `Grant to <agent>` and `Skip` buttons, and the sentence *"These descriptions
  will be part of that agent's prompt."*
- `notify.send(...)` on every terminal state with `click="/chat?inbox=open"`,
  and the existing three receipts extended with the run outcome so
  `capability_events.prompt_block()` (which rides in every agent's FACTS slot,
  runner.py:672-678) tells Nova whether her own proposal actually worked. Today
  an approved card produces a journal line saying the operator approved it and
  she has no way to learn it then failed.

**Verify at :5173** — approve the scratch card from phase 2, wait for
`awaiting_grant`, read the tool list on the card, click `Grant to main`, then in
the same chat ask Nova to use one of those tools and watch her actually call it.
That is the whole feature in one conversation.

---

## Phase 4 — Nova fills in the form, and a second executor type

**Modify**

- `backend/app/tools/builtin.py` — `raise_recommendation` gains an `action`
  object property. The description states the contract plainly, including: *if
  you cannot determine the endpoint, omit `action` and say so in the body. Do
  not guess a URL.* `_raise_recommendation` passes it through; a pydantic
  failure returns `Error: action rejected: <field> — <msg>` in the same turn, so
  the model can fix it and re-raise against the dedupe key.
- `backend/app/actions/schemas.py` + `backend/app/actions/http_tool.py` — the
  second type, `tool.http_add`: a declarative HTTP tool plus its
  `tool_host_allowlist` row, calling `tools/registry.create_http_tool`. Its
  preflight is a live GET against the URL template with sample params. This
  proves the registry generalises before the plan claims it does, and it is the
  honest answer for OSSInsight (see below).
- `backend/app/migrations/089_discovery_action_plans.sql` — rewrite the
  `mcp-server-discovery` automation instruction: fill in the form when the
  endpoint is verified, raise a plain card when it is not.
- `docs/plans/recommendation-surface.md` — update the status header.

**Verify at :5173** — ask Nova in chat to recommend adding a public MCP server
she can verify. Watch the card arrive with a plan block already marked `ready`
by preflight. Approve it. Then ask her to recommend one whose endpoint she
cannot find, and confirm she raises a card with no action and says so in the
body rather than guessing.

---

## Phase 5 — DEFERRED, needs sign-off: the bounded research run

For cards that cannot be planned at all, the only thing that ever answers "she
implements it herself" is a bounded agent run that goes and finds out. Sketch,
not scope: Approve mints a goal via `goals.propose` + `goals.activate` (the same
function `consents.decide:114` calls), bound to the run by two new columns and
two new clauses in `goals.spend`'s atomic UPDATE — closing a hole that exists
today, where `spend` matches on VERB ALONE (goals.py:213-225) so an approval
given in chat is spendable by any agent and by any scheduled automation. The run
is a Python phase machine with a read-only research phase, a typed
`record_findings` deliverable, and a verify phase that reads live state. Its
output on the OSSInsight card would be the refutation with citations.

The `bound_agent` / `bound_run` clauses are worth landing on their own,
independent of everything above.

---

## Mechanical refusals this plan adds

| Property | The function that refuses |
|---|---|
| An action document that does not typecheck never becomes a card | `actions.parse()` -> `TypeAdapter(ActionDoc).validate_python`, called from `recommendations.create()` before the INSERT and again in `action_worker._process` before the executor is looked up |
| Hidden fields cannot ride inside an action document | `actions.schemas._Action.model_config = ConfigDict(extra="forbid")` |
| An action cannot register a stdio server or cause any exec | `actions.schemas.McpServerAdd.transport = Literal["http"]` — pydantic rejects it; there is no `command` field to fill in |
| An action cannot grant an agent anything at registration time | `actions.mcp_server.execute()` has no grant call; grants happen only in `grant()`, reachable only from `POST /api/v1/recommendations/{id}/grant` behind `main.auth_middleware:236-252`. Independently, `tools/registry._granted_mcp_tools:143-145` returns `(False,set(),set())` for `allowed_tools=None` |
| A grant can only add named MCP tools of the server just created | `actions.mcp_server.grant()` constructs `{f"mcp:{server}/{t}" for t in list_tools_for(id)}` and passes `allowed_tools=sorted(old \| names)` as the sole field; no caller-supplied list reaches `agent_registry.update_agent` |
| An action cannot modify or delete an existing MCP server | Only `mcp_server.add` and `tool.http_add` are in `actions._TYPES`; `mcp_servers.create()` re-raises the UNIQUE(name) violation as ValueError (mcp_servers.py:120-122) |
| An action cannot aim the MCP client at loopback, LAN, CGNAT or a metadata endpoint, now or on any later refresh | `net_guard._validate_target()` called in `actions.mcp_server.execute()` step 1, and inside `mcp_client.connect_and_list()` / `call_tool()` when `created_by != 'operator'` |
| An action cannot embed a literal credential | `actions.schemas.McpServerAdd._no_literal_credentials` — every header value must match `^\{\{secret:[A-Za-z0-9_.-]+\}\}$`. Resolution stays at the outbound call (`mcp_client.py:63-68`) |
| The automatic preflight cannot send model-chosen headers anywhere | `actions.preflight()` passes `headers={}` unless `operator=True`, which only `POST /api/v1/recommendations/{id}/preflight` sets |
| The operator executes exactly the plan he was shown | `recommendations.decide()` compares `expected_digest` against the derived `action_digest(cur["action"])` inside the `SELECT ... FOR UPDATE` transaction that flips the status; surfaced as HTTP 409. A missing digest on a card that has an action is a mismatch |
| The operator cannot be shown a plan that differs from the one that runs | `actions.describe()` renders `action_plan` SERVER-SIDE from the same parsed document the executor receives; the frontend renders that string plus the raw fields, never prose from `body` |
| No agent can start a run | `action_worker.claim_next()`'s JOIN requires `rec.status='approved' AND rec.decided_by='operator'`, and the only writer of those columns is `recommendations.decide()` behind `main.auth_middleware`. No builtin imports `app.actions`; `net_guard.is_public_address` refuses 127.0.0.1 so `fetch_url` cannot loop back to the API |
| A double-click or a re-POST cannot run the same action twice | `action_runs_one_live_per_rec` partial unique index plus `ON CONFLICT DO NOTHING` inside `decide()`'s transaction |
| Two backends cannot execute the same run | `FOR UPDATE SKIP LOCKED` in `claim_next()`, and `action_worker.loop()` gated on `instances.is_leader()` |
| A failed connect cannot leave a half-registered dead server | `actions.mcp_server.execute()` step 4 emits `rollback` and calls `mcp_servers.delete(id)` when refresh returns anything but `connected` |
| A hung executor cannot hang forever | `asyncio.wait_for(spec.execute(...), settings_store.get("actions.timeout_s") or 120)`; nested bound `mcp_client._CONNECT_TIMEOUT_S = 10.0` |
| A restart cannot leave a run permanently 'running' | `actions.reset_orphans()` in `main.py` lifespan, modelled on `ingest_jobs.reset_orphans` (ingest_jobs.py:124-148) and sitting next to `eval_runs.reconcile_orphans()` (main.py:73) |
| Retention cannot delete a live work item | the rewritten `retention._SWEEPS` entry with `NOT EXISTS (... status IN ('queued','running','awaiting_grant'))` |
| An executor cannot exist for an effect the operator cannot already perform | `actions.assert_routes_exist()` called from `main.py` lifespan: every `Spec.operator_route` must resolve to a function on `router_chat`, or the backend does not boot |
| No model output is interpreted as an instruction during execution | structural: `backend/app/actions/` imports no LLM client and no `agents.runner`. `test_actions.py::test_no_model_in_executor` walks the package AST for those imports at both module and function scope, because this codebase's dominant idiom is the late local import |
| The whole mechanism has a kill switch | `settings_store` key `actions.enabled`, checked in `recommendations.decide()` before the run insert |

## NOT mechanically enforced

Listed here rather than dressed up.

1. **DNS rebinding.** `net_guard` resolves, then `httpx` resolves again and
   connects. A hostile resolver flipping records between the two calls defeats
   the guard. `web_fetch`'s own docstring documents this as accepted at this
   trust level; only a pinned-IP transport closes it.
2. **First-connect tool descriptions are never reviewed by a machine.**
   `mcp_servers.refresh()` accepts the first tool list it sees as the approved
   baseline (`stored_hash is None`, mcp_servers.py:176). `tools_hash` protects
   against a server changing its descriptions later, not against a hostile one
   at registration. The phase-3 second click is a human reading them, which is a
   mitigation, not a check.
3. **A granted server's tool descriptions land in that agent's prompt.**
   Inherent to MCP. `read_only` narrows what the fence lets those tools do, and
   is an operator declaration the kernel does not verify.
4. **A registered server is a standing outbound beacon.** `tools/registry._load_mcp_tools:118-131`
   fire-and-forgets a refresh whenever `last_seen` is older than
   `mcp.tools_refresh_ttl_min` (default 15). Approving a URL is approving a
   connection every fifteen minutes, forever. The card should say so; nothing
   refuses it.
5. **The operator has to read the card.** Every control above narrows what can
   be *proposed*; what is proposed is still chosen by a model that may have read
   a poisoned page. The URL is rendered from the row, not from prose, and it
   must clear `net_guard` — but a plausible-looking hostile URL is stopped by
   him, not by code.
6. **`decided_by` is the literal string `'operator'`**, not derived from the
   authenticated caller (recommendations.py:121). With `nova_auth_token`
   defaulting to `''` and `nova_trust_localhost` to `True`, that is an assertion
   about the endpoint's intent. The real boundary is that nothing agent-reachable
   can reach the endpoint at all.

---

## The OSSInsight card, end to end, in the finished system

**Today, and after phase 0.** The card carries `action=NULL`. It renders *"No
action plan on this card. Approving records your decision only."* and the button
reads `Approve`. Clicking it flips the status and writes three receipts. That is
a refusal by absence and it is the correct answer: the card names no target, so
there is nothing to typecheck and nothing to run. The improvement is that the
surface stops implying otherwise.

**Branch A: she guesses the URL.** The mcp-server-discovery automation re-raises
with `{"type":"mcp_server.add","name":"ossinsight","transport":"http",
"url":"https://ossinsight.io/api/mcp",...}` — the URL PingCAP's own README calls
"Base URL", which looks exactly like an MCP endpoint. It typechecks. The card is
created; `bg.spawn(actions.preflight(...))` fires; `net_guard` passes
(ossinsight.io is globally routable); `connect_and_list` POSTs the JSON-RPC
`initialize` and the route, which is `export async function GET`, answers **405
Method Not Allowed**. `connect_and_list` never raises; it returns
`("error", [], "Client error '405 Method Not Allowed' for url ...")`. The card
lands `action_state='blocked'` with that string in `action_detail`, before Jeremy
ever opens the inbox. The card reads:

```
This cannot run yet.
  Preflight failed: 405 Method Not Allowed for https://ossinsight.io/api/mcp
  (checked 2m ago)
Approving records your decision. Nothing will be registered.   [ Test again ]
```

Nova's confident claim is refuted by the network, in the card, without the
operator doing anything.

**Branch B: she cannot determine the endpoint.** This is the card's actual
state, and the honest answer is that **she stops and asks.** `McpServerAdd.url`
is required and `^https://`-constrained. Ingestion cannot produce a valid
document from "check the OSSInsight MCP listing on mcpservers.org for the
endpoint URL": `_raise_recommendation` returns
`Error: action rejected: url — Field required`, and her only options are to find
a real URL or raise the card with no action. A blank required field does not
submit. She raises an advisory card whose body says she could not find an
endpoint. Approve records the decision. Nothing installs. **She does not go and
find the URL by herself** — the research capability that could do that is phase
5, deferred.

**Branch C: it is a local npm package, which is the truth here.** The only
installable OSSInsight MCP server is `npx -y ossinsight-mcp` — 3 stars, 1
commit, one maintainer, v0.1.0 published 2026-04-16. A document naming it is
refused by pydantic at raise time: `action rejected: transport — Input should be
'http'`. The tool result carries the reason, which is also the policy in one
sentence: **a stdio server is executed to list its tools (mcp_servers.py:36-37),
so "the operator clicked Approve on a card summarising a web page" is not enough
authority to npm-install what that web page recommended.** She raises the card
with no action and a body that states the supply-chain facts and points at
Library -> Tools. **With this plan, approving the OSSInsight card will never
install that package.** He loses two clicks and keeps the property that
approving a proposal never executes unvetted third-party code.

**Branch D: the answer that actually executes.** `api.ossinsight.io/v1` is
keyless, CORS-open, and rate-limited at 600/hour. After phase 4 the right card
is a `tool.http_add` plan: a first-party declarative HTTP tool plus one
`tool_host_allowlist` row. Its preflight is a live GET against the URL template,
which would have caught before Jeremy saw anything that `action=repo&owner=facebook&repo=react`
returns "Repository not found". One click, same data, no third-party code, no
supply chain. Making the safe option the *easy* option is most of the argument
for typing plans at all.

---

## Out of scope, and why

- **Applying a patch.** `patches.py` has no `apply()`, the backend image has
  neither git nor patch and mounts no repo root, and the protected-paths
  tripwire exists only in `docs/plans/coding-team-pipeline.md`. Not a phase;
  needs its own plan.
- **Approve -> `delegate_coding_task`.** The verb exists, but `git` is absent
  from `coder/acp.py::_ALLOWED_COMMANDS` on purpose, `broker.py::_capture` never
  pushes, and no endpoint returns the diff text. Approving would produce a
  branch stranded in a docker volume. When capability-acquisition phase 9
  (branch push / real PRs) lands, this becomes one more entry in `actions._TYPES`
  with the same digest binding and receipts, and the outcome is still a branch a
  human merges.
- **stdio action documents.** Unrepresentable in phases 0-4 (`Literal["http"]`).
  A later phase could open it behind an exact-version pin on `args`
  (`^[@a-z0-9/._-]+@\d+\.\d+\.\d+$`, so `-y ossinsight-mcp` is refused and
  `-y ossinsight-mcp@0.1.0` is accepted) plus a second confirm click. The
  OSSInsight case is a good argument for leaving it shut.
- **Settings, soul.md, secret values, rules.** No agent-facing write path exists
  today and this plan does not add one. `manage_rules` and `delete_memory_item`
  are excluded from `GOAL_SCOPED_TOOLS` by name (scopes.py:24-28); an action
  type for either would route round a deliberate exclusion.
- **A generic durable task runner.** `goals` is an approval scope, not a plan.
  Nothing here adds one.

---

## Open decisions

**1. Grant clicks — DECIDED 2026-08-04: one click.** Approve registers,
connects, grants and verifies in one run. Phase 3 is folded into phase 2; see
that section for what the decision costs and the two build consequences.

**2. Automatic preflight at raise time — DECIDED 2026-08-04: yes.** Built and
live in phase 1. Headers are dropped on the automatic path; only the operator's
`Test` route sends them.

Still open:

3. **stdio, ever?** If never, `Literal["http"]` stays and MCP servers that are
   npm packages are always registered by hand in Library -> Tools. If eventually,
   the pinning-plus-second-confirm sketch above is the shape, and it should be
   its own phase after 4.

4. **Build phase 5 (the bounded research run)?** It is the only thing that makes
   "she implements it herself" true for a card that cannot be planned, and its
   output on OSSInsight would have been the refutation with citations. It is
   also the only part of this plan that puts a model back in the loop after the
   click. Independently of that answer: the `bound_agent` / `bound_run` fix to
   `goals.spend` closes a live hole and should land regardless.
