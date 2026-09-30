# The decision role — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking. **The spec is the authority**: where a task
> and the spec disagree, the task is wrong — stop and say so.

**Goal:** A `decisions` routing role whose decision models — Jev through OpenRouter, Kev on
the Dell — answer two typed questions before each of Nova's chat turns (which tool the
message needs; which recalled notes still hold), and a per-role switch that lets Jev Router
pick the cloud model.

**Architecture:**
- **Gateway.** `decisions` is a built-in role whose calls speak `systemone`, never chat.
  `POST /v1/systemone` walks its chain through the SAME loop as chat (walls, fallback,
  `X-Nova-Route`), forwards the body to `{base_url}/systemone` with the link's model id and
  key, and meters the call under the role. A `systemone` adapter makes a Kev server a
  provider; `local` becomes settable; OpenRouter's decision models join the catalogue; a
  Jev Router switch edits a role's chain and keeps the link it replaced.
- **Core.** `decisions.py` asks stage 1, then stage 2, then every recalled note at once,
  inside one 5 s budget, applies a whole decision or nothing, and files one `decisions`
  span. `_run_turn(decide=True)` comes only from the stream route and the eval runner.
- **Web.** The decisions role and a protocol-aware picker on Settings → Routing, the Jev
  Router switch, decision models kept out of every chat "Use", the Kev preset and a
  `local` tick on Providers, a `decisions` facet on Models.

**Tech Stack:** Python 3.12, FastAPI, asyncpg, httpx, pytest + pytest-asyncio (core also
pytest-timeout); React 18, TypeScript, Vite, vitest, @testing-library/react.

**Spec:** [`spec.md`](spec.md) (this directory) — read it before any task. Background research
was kept in a measurement workspace outside the repo — the question shapes and thresholds,
a codebase map, spike notes. House rules: the worktree's `CLAUDE.md`.

**Scope:** spec §1–§4. §5, the Kev engine on the Dell, is a separate later plan. Here Kev is
a plain `systemone` provider row at `http://100.122.40.93:8009/v1`, where a Kev-4B server
already runs.

## Global Constraints

Copied verbatim from the spec; every task's requirements include these.

- "`decisions` joins `routing.BUILTIN_ROLES`. Its chain is edited in Settings → Routing like chat's: for example `dell-kev:kev-latest`, then `openrouter:~typesafe/jev-latest`. It also joins the role's other pinned places (web `BuiltinRole`, `ROLE_WORDS` and their tests; the gateway and core error-text tests)."
- "New data-plane route `POST /v1/systemone`, beside `chat_completions`. It resolves the `decisions` chain with the existing `routing.resolve` / `record_refusal` / `note_success`, so walls and fallback work exactly as for chat. It forwards the request body unchanged to the winning link as `{base_url}/systemone`, with the link's model id and the provider's key. It relays the response with the `X-Nova-Route` header."
- "**The endpoint decides the protocol, not the provider.** The existing `openrouter` provider serves both chat and decisions. A decisions-only provider, such as Kev on the Dell, is a new adapter value `systemone`: base URL plus optional key, with no chat."
- "`local` becomes settable on a provider (today it is derived from `adapter == "ollama"`), so a Kev box is free and uncapped."
- "Metering: OpenRouter returns `usage.input_tokens` and `usage.cost`. Record them under the `decisions` role; local links cost nothing."
- "The options come from the live registry (derived, never listed by hand)."
- "If the stage-2 fit is at least 0.30 and the action gate is at least 0.30, one line goes in her turn: "A decision model reads the owner's message as needing your tool X (fit 0.85). Use it if it fits.""
- "It is a hint. She still decides, and every existing guard still judges what she writes."
- "A note is dropped when relevant is below 0.45, contradicts is 0.70 or more, or superseded is 0.70 or more."
- "**Fail-open with a stated reason.** No runnable decision model, a timeout (a per-turn budget, 5 s to start), or a malformed answer all leave the turn exactly as today. The `decisions` span records why."
- "**Trace.** One `decisions` span per turn records the tool hint, its fit, the gate, per-note scores and verdicts (note paths, never note text), the model that served, and the latency."
- "**Not on:** scheduled turns, drains and agent delegation to start. Measure first; widening is a later change."
- "Settings → Routing shows the `decisions` role with its label and chain editor."
- "The Models page lists decision models: Jev from the OpenRouter catalog (modality `text->decisions`), and Kev from the Dell once the engine exists."
- "Providers: a preset for a Kev server (`systemone` adapter, local)."
- "Settings → Routing gains a switch on each chat-kind role (chat, scheduled, agents): "Let Jev Router pick the cloud model"."
- "Off (the default): the role's cloud link is the model he picked, exactly as today."
- "On: the role's cloud link becomes `openrouter:typesafe/jev-router`." … "The model it picked is recorded on the turn (OpenRouter returns it)."
- "The chain stays the one source of truth. The switch is an edit to the chain: switching off restores the cloud model that was there before, which is kept in a setting. Local links before the cloud link are untouched, so local first still holds."
- "If Jev Router exposes a quality-first setting, the switch uses it ("regardless of cost"). If it does not, the switch says what Jev Router balances."
- "Build order: gateway → core → web → Kev engine."
- Not in scope: "A decision-role pick of local versus cloud per turn" and "Decisions on the honesty guards: detection stays mechanical".

## Review Focus

The five inputs most likely to bite a person that no spec line spells out — each pinned by a
test in the task named:

1. **Every install starts with an EMPTY decisions chain.** The existing walk would hand a
   role with no chain the chat chain, and a chain with nothing runnable the local standby —
   a chat model asked a typed question. Expect: a 503 that says the chain is empty, no
   provider dialled, and her turn exactly as before. Tests in Task 1 (the walk), Task 3 (the
   endpoint) and Task 8 (the turn is byte-for-byte the pre-slice turn).
2. **A decision model picked as the chat model** — "Use" in a provider's model list, the
   chat picker, the Models page, or a Kev link written into `chat.model`. Every chat turn
   would fail. Expect: no chat "Use" is ever offered for a decision model, and a
   `systemone` link in chat's position is passed over with its reason while the next link
   answers. Tests in Task 2 (the walk), Task 4 (the catalogue offers no action) and Task 12
   (chat picker, Providers).
3. **The Dell asleep in the evening** (Kev unreachable or slow). Expect: one turn fails
   open inside the 5 s budget, and later turns go straight to the next link without dialling
   the dead one each time. Tests in Task 3 (a connect failure walls the link, the next
   request skips it undialled) and Task 7 (the budget, not the socket, ends the wait).
4. **Every recalled note set aside.** An empty notes block reads to her like a search that
   found nothing. Expect: her prompt says the search returned notes and a decision model set
   them aside. Tests in Task 6 (the prompt) and Task 8 (the turn).
5. **The Jev Router switch after a hand edit.** The owner removes the router link in the
   chain editor, then flips the switch off; or flips it on for a role whose empty chain walks
   chat's. Expect: off never resurrects a stale kept link or duplicates one, and the
   empty-chain role is refused in words rather than silently cut off from chat's local-first
   chain. Tests in Task 5.

## Plan decisions

Where the spec leaves something open, the plan decides; each is also marked `(plan
decision)` where it is used.

1. **Three rounds, not one batch.** Stage 1, then stage 2, then every note check
   concurrently, all inside the one 5 s budget — stage 2 needs stage 1's shortlist and the
   note checks need the hint (spec §2's "one concurrent batch" cannot hold both).
2. **The recall check needs a hint.** Its current facts ARE the hinted tool's description
   (spec §2); with no hint there is nothing current to judge a note against, so the notes
   pass unchecked and the span says so (spike 2 got message-blind "superseded" scores when
   the facts were empty).
3. **All or nothing.** A decision is applied whole; any failure — a note check included —
   leaves the turn as today. Half a decision was never measured.
4. **Where the call sits:** in `_run_turn`, after recall and the live checks, before the
   attachments block and `base_messages` — it needs the notes and the advertised tools, and
   must precede the first round.
5. **The hint's place:** its own system message immediately before the owner's message —
   the position the spike measured at 3/3, and the cached prefix (system prompts, history)
   stays byte-identical.
6. **`TURN_BUDGET_S = 5.0`** is a module constant in `decisions.py`, not a setting — "5 s to
   start"; a setting is a later change once measured.
7. **`_run_turn(..., decide: bool = False)`**, keyword-only; only `chat_stream` and
   `runner.run_case` pass `True`, and it runs only for Nova's persona — scheduled, drained
   and agent turns never ask; eval turns must measure the real chat path.
8. **Every note set aside is said** (`Recalled.set_aside`) — the Recalled docstring's own
   rule; the spike had no sentence, so the final measurement is what shows it holds.
9. **`/v1/systemone` serves only the decisions role;** another `X-Nova-Role` is a 400, and
   `/v1/chat/completions` refuses the decisions role. A body `model` naming `provider:model`
   is link 1, exactly like chat's requested model; core sends none — the pin lets a
   measurement name Jev or Kev without editing the owner's chain.
10. **A systemone role borrows nothing:** never the chat chain, never the local standby;
    empty is a 503 in words.
11. **Adapters declare `protocols`:** `openai-chat` carries `chat` and `systemone`
    (OpenRouter serves both at one base URL); `ollama` and `anthropic-messages` carry
    `chat`; `systemone` carries `systemone`. A link whose adapter cannot carry its role's
    protocol is refused at save and walked past as `wrong_protocol` — derived from the
    adapter, never a vendor list.
12. **Metering shape:** a decision is ledger kind `completion` (the kind CHECK has no fourth
    value to add), `input_tokens`/`output_tokens` as the prompt/completion counts, purpose =
    the turn's kind; the gateway replaces the answer's `usage` with the ledger's fields, as
    chat's buffered path does.
13. **The turn's `usage` frame** still sums her llm_call rounds only; the `decisions` span
    carries its own stated cost — `turn_usage`'s contract is rounds, and the Spend page
    shows decision spend under the role.
14. **OpenRouter's decision models** are fetched with a second `GET
    /models?output_modalities=decisions`, only when the default listing states output
    modalities; a failure is a note on the listing. Checked 2026-09-28: the default listing
    (458 rows) omits Jev; `?output_modalities=decisions` returns 7 rows, among them
    `~typesafe/jev-latest`, `typesafe/jev-1.13` and `jaredpalmer/kev-4b`.
15. **Catalogue rows:** a decision row has no actions (never `use`, which writes
    `chat.model`); a listing row from a provider marked local is kind `local` and installed
    (a Kev box is not a cloud, and its own listing says it serves the model).
16. **The switch's state:** the kept link is the gateway column `routes.router_kept` ("kept
    in a setting"); on/off is DERIVED from the chain (a `typesafe/jev-router` link in it);
    a chain edit that removes the router link clears the kept link.
17. **What the switch edits:** the FIRST cloud link of the role's stored chain; with no
    cloud link it appends after the local links; `chat.model` (chat's link 1, one writer) is
    never touched; a non-chat role with an empty chain (it walks chat's) is refused, because
    an appended one-link chain would silently stop it walking chat's local links.
18. **Where the switch is offered:** chat, scheduled and every agent role — not judge, not
    decisions, not the reserved roles (the spec's list "(chat, scheduled, agents)").
19. **The switch's sentence:** OpenRouter's listing for `typesafe/jev-router` states
    `supported_parameters: []` and `default_parameters: {}` (fetched 2026-09-28), and its
    description says it "picks the best model and reasoning effort for each request,
    balancing quality, speed, and cost". There is no quality-first setting, so the switch
    says what it balances.
20. **The router's pick on the turn:** the llm_call span's `routed_to` — the upstream
    chunk's `model`, recorded only when it differs from the served link's model.
21. **The measurement script lives in the SDD workspace,** not the repo; its off arm
    replaces `decisions.run` in-process (the turn as it was before the slice), so measuring
    never edits the owner's live chain.

## Working rules for every task

- **Where:** the worktree `/home/jeremy/workspace/nova/.worktrees/decisions`, branch
  `slice/decisions`. Every git command is `git -C /home/jeremy/workspace/nova/.worktrees/decisions …`
  — the shell's cwd resets between calls, and a bare `git commit` has landed in the wrong
  checkout before.
- **Commits:** stage by path, never `git add -A` or `git add .`. Straight after each commit,
  `git -C … show --stat HEAD`; fix anything you did not mean to include before moving on.
  End every message with the two attribution lines the session gives you.
- **Databases:** the scratch server `nova-scratch-pg` on `127.0.0.1:55432`, with THIS lane's
  own databases `nova_core_decisions` and `nova_gateway_decisions` (created in "Before Task
  1"). Every test command below starts with `. "$SCRATCHPAD/decisions.env" &&`, which
  exports `CORE_DB` and `GATEWAY_DB`. Never point two lanes at one database: each
  `conftest.py` drops and re-migrates its own.
- **Core tests:** `cd /home/jeremy/workspace/nova/.worktrees/decisions/services/core && TEST_DATABASE_URL="$CORE_DB" uv run pytest -q <paths>`.
- **Gateway tests:** `cd /home/jeremy/workspace/nova/.worktrees/decisions/services/gateway && TEST_DATABASE_URL="$GATEWAY_DB" uv run pytest -q <paths>`.
- **Lint:** `uv run ruff check app tests` in the service you touched, and
  `uv run ruff format <only the files you edited>` — the trees are not format-clean, and a
  whole-tree format is someone else's diff. Line length is 100.
- **Web:** `cd /home/jeremy/workspace/nova/.worktrees/decisions/apps/web && npm test -- <pattern>`
  and `npx tsc --noEmit`. Never `npx vitest run` (the localStorage trap on newer Node).
- **Pinned suites are tripwires.** A pin that moves (the role list, a routes-page dict, an
  exact provider payload) is updated deliberately, in the task that moves it, with the
  reason in the commit body. Never route around one.
- **No approvals.** `tests/test_no_approvals.py` stays green untouched: nothing in this
  slice is awaited between a tool call's schema check and its executor, and nothing reads a
  decision to refuse a call.
- **No emojis** anywhere — code, copy, commits.
- **`$SCRATCHPAD`** in a command means your session's scratchpad directory (never `/tmp`).
  **`$SDD`** means the plan's own measurement workspace, kept outside the repo (see the
  close-out at the end of this plan for what it produced).

## Before Task 1: prepare the worktree

- [ ] **Step 1:** Trust the worktree's toolchain file (it is nested inside the deploy tree, so
  mise reads both copies):
  ```bash
  cd /home/jeremy/workspace/nova/.worktrees/decisions && mise trust && mise trust /home/jeremy/workspace/nova
  ```
- [ ] **Step 2:** Install dependencies:
  ```bash
  cd /home/jeremy/workspace/nova/.worktrees/decisions/services/core && uv sync
  cd /home/jeremy/workspace/nova/.worktrees/decisions/services/gateway && uv sync
  cd /home/jeremy/workspace/nova/.worktrees/decisions/apps/web && npm ci
  ```
- [ ] **Step 3:** This lane's databases, and the env file every test command sources:
  ```bash
  PGPW="$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')"
  docker exec nova-scratch-pg createdb -U postgres nova_core_decisions 2>/dev/null || true
  docker exec nova-scratch-pg createdb -U postgres nova_gateway_decisions 2>/dev/null || true
  printf 'export CORE_DB="postgresql://postgres:%s@127.0.0.1:55432/nova_core_decisions"\nexport GATEWAY_DB="postgresql://postgres:%s@127.0.0.1:55432/nova_gateway_decisions"\n' "$PGPW" "$PGPW" > "$SCRATCHPAD/decisions.env"
  docker exec nova-scratch-pg psql -U postgres -Atc "select datname from pg_database where datname like '%decisions'"
  ```
  Expected: `nova_core_decisions` and `nova_gateway_decisions`.
- [ ] **Step 4:** Baseline, so a later red is known to be yours. Run and record the counts:
  ```bash
  . "$SCRATCHPAD/decisions.env" && cd /home/jeremy/workspace/nova/.worktrees/decisions/services/core && TEST_DATABASE_URL="$CORE_DB" uv run pytest -q -x --timeout=120 2>&1 | tail -3
  . "$SCRATCHPAD/decisions.env" && cd /home/jeremy/workspace/nova/.worktrees/decisions/services/gateway && TEST_DATABASE_URL="$GATEWAY_DB" uv run pytest -q 2>&1 | tail -3
  cd /home/jeremy/workspace/nova/.worktrees/decisions/apps/web && npm test 2>&1 | tail -5
  ```
  Expected: all three green. If any is red before you change anything, stop and report it.

## File structure

| File | Responsibility |
|---|---|
| `services/gateway/app/routing.py` | the `decisions` role, `protocol_of`/`speaks`, the walk's protocol rules, the Jev Router switch |
| `services/gateway/app/adapters/base.py`, `ollama.py`, `openai_chat.py`, `anthropic_messages.py`, `__init__.py` | `Adapter.protocols`; `Listing.note`; openai-chat lists decision models |
| `services/gateway/app/adapters/systemone.py` | the `systemone` adapter (a decision-model server) and the one `POST {base}/systemone` call |
| `services/gateway/app/providers.py`, `providers_presets.json` | the adapter's shape, a settable `local`, the Kev preset |
| `services/gateway/app/data_plane.py` | `walk_role` (the one loop), `POST /v1/systemone` |
| `services/gateway/app/usage.py` | a decision, metered |
| `services/gateway/app/catalog.py`, `admin.py` | decision rows without actions; routes page `protocol`/`router`; `PUT …/jev-router`; listing notes |
| `services/gateway/migrations/010_systemone_adapter.sql`, `011_router_switch.sql` | the adapter CHECK; `routes.router_kept` |
| `services/core/app/decisions.py` | the two questions, the budget, fail-open, the `decisions` span |
| `services/core/app/chat.py` | `Recalled.paths`/`set_aside`, the hint's place, the decide step, `routed_to` |
| `services/core/app/evals/runner.py` | an eval turn runs the decision step, like a chat turn |
| `services/core/app/proxies.py`, `app/tools/route.py` | the switch's proxy; her routing tool names the decisions role |
| `apps/web/src/lib/api.ts` | types: the decisions role, protocol, router, systemone providers |
| `apps/web/src/pages/settings/RoutingSection.tsx` | the decisions role's words and picker; the switch |
| `apps/web/src/pages/settings/ProvidersSection.tsx` | the systemone adapter, `local`, no chat "Use" on a decision model |
| `apps/web/src/pages/chat/ModelSelector.tsx`, `pages/models/catalogFormat.ts` | the chat picker skips decision models; the `decisions` facet |
| `docs/plans/rebuild/ROADMAP.md`, `ARCS.md`, `deploy/README.md` | the docs |
| `$SDD/measure_decisions.py`, `$SDD/compare_arms.py` (not in git) | the measurement through the eval runner, and the off/on comparison |

---

### Task 1: The `decisions` role and the protocol a role speaks (gateway)

**Files:**
- Modify: `services/gateway/app/routing.py:31-36` (docstring), `:49-58` (imports, roles),
  `:76-80` (`NothingRunnable`), `:136-162` (`set_chain`), `:313-369` (`judge_link`),
  `:466-606` (`resolve`), `:633-641` (`__all__`)
- Modify: `services/gateway/app/adapters/base.py:99-110` (`Adapter.protocols`)
- Modify: `services/gateway/app/adapters/ollama.py:313-314`,
  `services/gateway/app/adapters/openai_chat.py:321-322`,
  `services/gateway/app/adapters/anthropic_messages.py:597-598`
- Modify: `services/gateway/app/data_plane.py:76-78` (the chat route refuses a systemone
  role), `:129-133` (the 503's words)
- Modify: `services/gateway/app/admin.py:1016-1053` (routes page `protocol`; PUT passes rows)
- Modify (pins): `services/gateway/tests/test_routing.py:29-33` (`BAD_ROLE_MESSAGE`),
  `:479-483` (the derived roles' dicts)
- Test: `services/gateway/tests/test_decisions_role.py` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `routing.DECISIONS_ROLE = "decisions"`, `routing.CHAT = "chat"`,
    `routing.SYSTEMONE = "systemone"`, `routing.SYSTEMONE_ROLES: frozenset[str]`
  - `routing.protocol_of(role: str) -> str`
  - `routing.speaks(row: dict, protocol: str) -> bool`
  - `routing.cannot_serve(provider_name: str, row: dict, protocol: str) -> str`
  - `routing.set_chain(pool, role: str, chain: list, by_name: dict[str, dict]) -> list[str]`
    (the last argument was `names: set[str]`)
  - `routing._clean_chain(role: str, chain: object, by_name: dict[str, dict]) -> list[str]`
  - `routing.judge_link(app, pool, link, by_name, walled, timezone, seen, *, protocol: str = CHAT) -> dict`
    — new verdict `"wrong_protocol"`
  - `routing.NothingRunnable(role: str, verdicts: list[dict], *, why: str | None = None)`
  - `data_plane._nothing_runnable(exc: routing.NothingRunnable) -> str`
  - `Adapter.protocols: frozenset[str]` on every adapter
  - `GET /admin/routes` role entries gain `"protocol": "chat" | "systemone"`

- [ ] **Step 1: Write the failing tests.** Create `services/gateway/tests/test_decisions_role.py`:

```python
"""The decision role in routing (docs/plans/rebuild/decision-role/spec.md §1).

Pins: `decisions` is a built-in role whose calls are typed questions
(systemone), never chat; an EMPTY decisions chain borrows nothing — not the
chat chain, not the local standby — and says so; a link whose adapter cannot
carry the role's protocol is refused by name before it is stored, and walked
past with its reason when a chain holds one anyway; the chat endpoint refuses
the decisions role; every adapter states the protocols it carries."""

from __future__ import annotations

import pytest

from app import adapters, backends, engines, routing
from tests.conftest import requires_db
from tests.fakes import FakeOllama, FakeOpenAICompat

pytestmark = requires_db

JEV = "~typesafe/jev-latest"


@pytest.fixture
async def local(pool, monkeypatch, mount_backend):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(tags=("qwen3:8b",))
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:8b"})
    engines.clear_cache()
    return fake


async def _openrouter(client, mount_backend) -> FakeOpenAICompat:
    fake = FakeOpenAICompat(
        accepts_key="sk-1", models_body={"object": "list", "data": [{"id": JEV}]}
    )
    mount_backend("http://openrouter.test", fake.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "openrouter",
            "adapter": "openai-chat",
            "base_url": "http://openrouter.test/v1",
            "auth_shape": "static-bearer",
            "api_key": "sk-1",
        },
    )
    assert resp.status_code == 200, resp.text
    return fake


def test_decisions_is_a_built_in_role_that_speaks_typed_questions():
    assert "decisions" in routing.BUILTIN_ROLES
    assert "decisions" not in routing.RESERVED_ROLES
    assert routing.protocol_of("decisions") == routing.SYSTEMONE
    for role in ("chat", "scheduled", "judge", "agent_coder"):
        assert routing.protocol_of(role) == routing.CHAT


def test_each_adapter_states_the_protocols_it_carries():
    """Read off the adapter, never a vendor list: the ENDPOINT decides the
    protocol, and an openai-chat provider (OpenRouter) carries both."""
    assert adapters.for_row({"adapter": "ollama"}).protocols == {"chat"}
    assert adapters.for_row({"adapter": "anthropic-messages"}).protocols == {"chat"}
    assert adapters.for_row({"adapter": "openai-chat"}).protocols == {"chat", "systemone"}


async def test_the_routes_page_lists_decisions_with_its_protocol(client, pool, local):
    roles = {r["role"]: r for r in (await client.get("/admin/routes")).json()["roles"]}
    assert roles["decisions"]["chain"] == [] and roles["decisions"]["builtin"] is True
    assert roles["decisions"]["protocol"] == "systemone"
    assert roles["chat"]["protocol"] == "chat"


async def test_an_empty_decisions_chain_borrows_no_chat_link_and_no_standby(client, pool, local):
    """Review focus 1. Every install starts with NO decisions chain. A chat
    role with no chain borrows chat's, and a chain with nothing runnable and
    no local link falls to the local standby — both right for chat, both
    wrong here: a chat model asked a typed question at /systemone has nothing
    to say. Empty means no decision model, stated, and nothing is asked."""
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:8b"]})

    ex = (await client.get("/admin/route/explain?role=decisions")).json()

    assert ex["would_serve"] is None
    assert ex["chain"] == []
    assert ex["reason"] == (
        "no model in the 'decisions' chain can serve right now — the decisions chain is "
        "empty, so no decision model is set (add one in Settings → Routing)"
    )
    with pytest.raises(routing.NothingRunnable) as caught:
        await routing.resolve(
            None,
            pool,
            role="decisions",
            requested=None,
            timezone="UTC",
            fit_context=None,
            latest_probes=None,
        )
    assert caught.value.verdicts == [], "no standby entry was derived"
    assert not [p for p, _ in local.seen if p.endswith("/chat/completions")]


async def test_a_link_that_cannot_answer_typed_questions_is_refused_by_name(
    client, pool, local, mount_backend
):
    await _openrouter(client, mount_backend)

    bad = await client.put("/admin/routes/decisions", json={"chain": ["hub:qwen3:8b"]})
    assert bad.status_code == 400
    assert bad.json()["error"] == (
        "link 'hub:qwen3:8b' cannot serve the decisions role — hub answers chat — "
        "this role needs typed questions"
    )
    good = await client.put("/admin/routes/decisions", json={"chain": [f"openrouter:{JEV}"]})
    assert good.status_code == 200 and good.json()["chain"] == [f"openrouter:{JEV}"]


async def test_a_chain_link_that_cannot_serve_its_role_is_walked_past_with_its_reason(
    client, pool, local, mount_backend
):
    """A chain written before the check existed — or a provider whose adapter
    was changed since — still holds such a link: the walk says why it is
    skipped and never dials it."""
    await _openrouter(client, mount_backend)
    await pool.execute(
        "INSERT INTO routes (role, chain) VALUES ('decisions', $1::jsonb)",
        f'["hub:qwen3:8b", "openrouter:{JEV}"]',
    )

    ex = (await client.get("/admin/route/explain?role=decisions")).json()

    assert [v["verdict"] for v in ex["chain"]] == ["wrong_protocol", "runnable"]
    assert ex["chain"][0]["reason"] == "hub answers chat — this role needs typed questions"
    assert ex["would_serve"]["served_by"] == f"openrouter:{JEV}"


async def test_the_chat_endpoint_refuses_the_decisions_role(client, pool, local):
    resp = await client.post(
        "/v1/chat/completions",
        json={"messages": [{"role": "user", "content": "hi"}], "stream": True},
        headers={"X-Nova-Role": "decisions", "X-Nova-Purpose": "chat"},
    )

    assert resp.status_code == 400
    assert resp.json()["error"] == (
        "the decisions role answers typed questions at POST /v1/systemone — "
        "a chat completion cannot be served from its chain"
    )
    assert not [p for p, _ in local.seen if p.endswith("/chat/completions")]
```

  And move the two pins in `services/gateway/tests/test_routing.py`:
  - `:29-33`, the role list in the refusal text — `decisions` joins after `judge`:
    ```python
    # validate_role's exact refusal (S12-2): names the rule and the offending name.
    # The decision role (decision-role spec §1) joined the built-ins after judge.
    BAD_ROLE_MESSAGE = (
        "role must be a built-in (chat, scheduled, judge, decisions, coding, vision) or a "
        "lowercase [a-z_] name of at most 32 chars — got 'Vibes-1'"
    )
    ```
  - `:479-483`, the derived roles' dicts gain the protocol they speak:
    ```python
    assert derived == [
        {
            "role": "agent_alpha",
            "chain": ["hub:qwen3:4b"],
            "reserved": False,
            "builtin": False,
            "protocol": "chat",
        },
        {
            "role": "agent_zed",
            "chain": ["hub:qwen3:4b"],
            "reserved": False,
            "builtin": False,
            "protocol": "chat",
        },
    ]
    ```

- [ ] **Step 2: Run them to see them fail.**
  ```bash
  . "$SCRATCHPAD/decisions.env" && cd /home/jeremy/workspace/nova/.worktrees/decisions/services/gateway && TEST_DATABASE_URL="$GATEWAY_DB" uv run pytest -q tests/test_decisions_role.py tests/test_routing.py
  ```
  Expected: FAIL — `AttributeError: module 'app.routing' has no attribute 'SYSTEMONE'`
  (and `'Ollama' object has no attribute 'protocols'`), and in `test_routing.py` the two
  moved pins.

- [ ] **Step 3: Every adapter states its protocols.** In `app/adapters/base.py`, the
  `Adapter` protocol (`:99-110`) gains, after `name: str`:
  ```python
      #: The wire protocols a provider on this adapter can carry — "chat"
      #: (/v1/chat/completions) and "systemone" (typed questions, /v1/systemone).
      #: The ENDPOINT decides which one a call speaks (decision-role spec §1);
      #: routing reads this to refuse, by name, a link that cannot carry it.
      protocols: frozenset[str]
  ```
  and each adapter class declares it on the line after its `name`:
  - `app/adapters/ollama.py:314` → `    protocols = frozenset({"chat"})`
  - `app/adapters/anthropic_messages.py:598` → `    protocols = frozenset({"chat"})`
  - `app/adapters/openai_chat.py:322`, with its reason:
    ```python
        # OpenRouter serves Jev's typed questions at {base}/systemone with the
        # same key it serves chat with (decision-role spec §1), so an endpoint
        # of this protocol MAY carry both; one that does not answers /systemone
        # with a 404, which is relayed in its own words.
        protocols = frozenset({"chat", "systemone"})
    ```

- [ ] **Step 4: The role and its protocol in `app/routing.py`.**
  - Docstring: after the paragraph ending "Nothing here keeps a second list of roles."
    (`:35`), add:
    ```
    THE PROTOCOL (decision-role spec §1). A role's calls speak ONE protocol,
    and the endpoint decides which: /v1/chat/completions is `chat`,
    /v1/systemone is `systemone` — typed questions, the decision role's. A
    link is runnable only on a provider whose adapter carries the role's
    protocol (Adapter.protocols), and a systemone role never borrows the chat
    chain and never falls to the local standby: a chat model has nothing to
    answer a typed question with.
    ```
  - Imports (`:52`): `from app.adapters import ProviderRefused, for_row, ollama`
  - Replace `:56-58` with:
    ```python
    BUILTIN_ROLES = ("chat", "scheduled", "judge", "decisions", "coding", "vision")
    # Roles nothing calls yet — shown on the page as "no user yet".
    RESERVED_ROLES = frozenset({"coding", "vision"})
    #: The decision role (decision-role spec §1): typed questions at
    #: POST /v1/systemone, answered by a decision model, never a chat completion.
    DECISIONS_ROLE = "decisions"
    #: The two protocols a role's calls can speak (see the module docstring).
    CHAT = "chat"
    SYSTEMONE = "systemone"
    SYSTEMONE_ROLES = frozenset({DECISIONS_ROLE})
    # How a protocol is said to the owner, in a verdict's reason.
    _ANSWERS = {CHAT: "chat", SYSTEMONE: "typed questions"}


    def protocol_of(role: str) -> str:
        """The protocol a role's calls speak: systemone for the decision role,
        chat for every other role — built-in or an agent's derived one."""
        return SYSTEMONE if role in SYSTEMONE_ROLES else CHAT


    def speaks(row: dict, protocol: str) -> bool:
        """Can a link on this provider carry `protocol`? Read off the provider's
        own adapter (Adapter.protocols), never a list of vendors kept here."""
        return protocol in for_row(row).protocols


    def cannot_serve(provider_name: str, row: dict, protocol: str) -> str:
        """Why a link on `row` cannot serve a role that speaks `protocol`."""
        carries = " and ".join(_ANSWERS[p] for p in sorted(for_row(row).protocols))
        return f"{provider_name} answers {carries} — this role needs {_ANSWERS[protocol]}"
    ```
  - Replace `NothingRunnable.__init__` (`:77-80`) with:
    ```python
        def __init__(self, role: str, verdicts: list[dict], *, why: str | None = None) -> None:
            said = f"no model in the {role!r} chain can serve right now"
            super().__init__(f"{said} — {why}" if why else said)
            self.role = role
            self.verdicts = verdicts
    ```
  - Replace `set_chain` (`:136-162`) with the validation split out, so Task 5 can reuse it:
    ```python
    def _clean_chain(role: str, chain: object, by_name: dict[str, dict]) -> list[str]:
        """The chain as it would be stored, or ValueError naming the first bad
        link. Every link is `provider:model` on a registered provider whose
        adapter carries the role's protocol — a typo, or a chat model in the
        decisions chain, is refused by name before anything is stored. A
        repeated link is kept once, where it first appears."""
        if not isinstance(chain, list):
            raise ValueError("chain must be a list of provider:model ids")
        protocol = protocol_of(role)
        names = set(by_name)
        cleaned: list[str] = []
        for link in chain:
            if not isinstance(link, str) or not link.strip():
                raise ValueError("every link must be a non-empty provider:model string")
            link = link.strip()
            provider, model = providers.split_model_id(link, names)
            if provider is None or not model:
                raise ValueError(
                    f"link {link!r} does not name a registered provider — write it as "
                    f"<provider>:<model> (providers: {', '.join(sorted(names))})"
                )
            if not speaks(by_name[provider], protocol):
                raise ValueError(
                    f"link {link!r} cannot serve the {role} role — "
                    f"{cannot_serve(provider, by_name[provider], protocol)}"
                )
            if link in cleaned:
                continue
            cleaned.append(link)
        return cleaned


    async def set_chain(
        pool: asyncpg.Pool, role: str, chain: list, by_name: dict[str, dict]
    ) -> list[str]:
        """Store a role's chain. `by_name` is the live provider rows by name — a
        link is judged against its provider's adapter, not only its name (see
        _clean_chain for everything that is refused)."""
        validate_role(role)
        cleaned = _clean_chain(role, chain, by_name)
        await pool.execute(
            "INSERT INTO routes (role, chain) VALUES ($1, $2::jsonb) "
            "ON CONFLICT (role) DO UPDATE SET chain = EXCLUDED.chain, updated_at = now()",
            role,
            json.dumps(cleaned),
        )
        return cleaned
    ```
  - `judge_link` (`:313-369`): the signature gains `*, protocol: str = CHAT` after `seen`,
    the docstring gains the sentence "A link whose provider cannot carry the role's
    `protocol` is judged `wrong_protocol` first, and nothing is asked of it.", and the
    check goes straight after `entry = {...}` (`:335`), before `off = switched_off(row)`:
    ```python
        if not speaks(row, protocol):
            return {
                **entry,
                "verdict": "wrong_protocol",
                "reason": cannot_serve(provider_name, row, protocol),
            }
    ```
  - `resolve` (`:466-606`) — five hunks:
    ```python
        validate_role(role)
        protocol = protocol_of(role)
    ```
    ```python
        all_chains = await chains(pool)
        chain = list(all_chains.get(role) or [])
        if not chain and role != "chat" and protocol == CHAT:
            # A chat role with no chain of its own walks chat's. A systemone role
            # never does: chat's links answer chat, and a chat model asked a typed
            # question at /systemone has nothing to say (decision-role spec §1).
            chain = list(all_chains.get("chat") or [])
    ```
    ```python
        if not chain:
            if protocol == SYSTEMONE:
                # (plan decision 10) Empty is "no decision model", stated — never
                # the default provider's chat model below.
                raise NothingRunnable(
                    role,
                    [],
                    why=f"the {role} chain is empty, so no decision model is set "
                    "(add one in Settings → Routing)",
                )
            # No pick and no chain: today's rule — the default provider's model,
    ```
    in the observe loop (`:538-547`), an engine that cannot carry the protocol is never
    asked what it has installed:
    ```python
            if (
                row is not None
                and name not in seen
                and engines.is_engine(row)
                and switched_off(row) is None
                and speaks(row, protocol)
            ):
    ```
    the verdict call (`:551`):
    ```python
            verdict = await judge_link(
                app, pool, link, by_name, walled, timezone, seen, protocol=protocol
            )
    ```
    and the standby (`:575`) — chat roles only:
    ```python
        if not has_local and protocol == CHAT:
    ```
  - `__all__` (`:633-641`) gains `"CHAT"`, `"DECISIONS_ROLE"`, `"SYSTEMONE"`,
    `"SYSTEMONE_ROLES"`, `"cannot_serve"`, `"protocol_of"`, `"speaks"`.

- [ ] **Step 5: The data plane and the routes page.**
  - `app/data_plane.py`, `chat_completions` (`:76-78`):
    ```python
        attribution = usage.Attribution.from_headers(request.headers)
        if attribution.role:
            if routing.protocol_of(attribution.role) != routing.CHAT:
                # The endpoint decides the protocol (decision-role spec §1): the
                # decisions chain holds decision models, which have no chat.
                raise HTTPException(
                    status_code=400,
                    detail=f"the {attribution.role} role answers typed questions at POST "
                    "/v1/systemone — a chat completion cannot be served from its chain",
                )
            return await serve_by_role(request, pool, attribution.role, requested, body, attribution)
    ```
  - `serve_by_role`'s `except routing.NothingRunnable` (`:129-133`):
    ```python
            except routing.NothingRunnable as exc:
                raise HTTPException(status_code=503, detail=_nothing_runnable(exc)) from exc
    ```
    and, after `_served_by` (`:59-60`):
    ```python
    def _nothing_runnable(exc: routing.NothingRunnable) -> str:
        """The 503's words: the walk's own sentence, then every link's verdict. A
        chain with no links (the empty decisions chain) is the sentence alone —
        never a dangling dash."""
        if not exc.verdicts:
            return str(exc)
        return f"{exc} — " + "; ".join(f"{v['id']}: {v['reason']}" for v in exc.verdicts)
    ```
  - `app/admin.py`, `get_routes` (`:1025-1034`): each role entry gains
    `"protocol": routing.protocol_of(role),` after `"builtin"`.
  - `app/admin.py`, `put_route` (`:1045-1049`): the provider ROWS, not only their names —
    ```python
        by_name = {r["name"]: r for r in await providers.list_rows(pool)}
        try:
            chain = await routing.set_chain(
                pool, role, body.get("chain") if isinstance(body, dict) else None, by_name
            )
    ```

- [ ] **Step 6: Run the tests to see them pass.**
  ```bash
  . "$SCRATCHPAD/decisions.env" && cd /home/jeremy/workspace/nova/.worktrees/decisions/services/gateway && TEST_DATABASE_URL="$GATEWAY_DB" uv run pytest -q tests/test_decisions_role.py tests/test_routing.py tests/test_providers.py tests/test_data_plane.py
  ```
  Expected: PASS.

- [ ] **Step 7: The whole gateway suite, lint, format, commit.**
  ```bash
  . "$SCRATCHPAD/decisions.env" && cd /home/jeremy/workspace/nova/.worktrees/decisions/services/gateway && TEST_DATABASE_URL="$GATEWAY_DB" uv run pytest -q 2>&1 | tail -3
  cd /home/jeremy/workspace/nova/.worktrees/decisions/services/gateway && uv run ruff check app tests && uv run ruff format app/routing.py app/data_plane.py app/admin.py app/adapters/base.py app/adapters/ollama.py app/adapters/openai_chat.py app/adapters/anthropic_messages.py tests/test_decisions_role.py tests/test_routing.py
  git -C /home/jeremy/workspace/nova/.worktrees/decisions add services/gateway/app/routing.py services/gateway/app/data_plane.py services/gateway/app/admin.py services/gateway/app/adapters/base.py services/gateway/app/adapters/ollama.py services/gateway/app/adapters/openai_chat.py services/gateway/app/adapters/anthropic_messages.py services/gateway/tests/test_decisions_role.py services/gateway/tests/test_routing.py
  git -C /home/jeremy/workspace/nova/.worktrees/decisions commit -m "feat(gateway): the decisions role, and the protocol a role speaks"
  git -C /home/jeremy/workspace/nova/.worktrees/decisions show --stat HEAD
  ```
  Expected: the suite's baseline count plus the new tests, all green. The commit body says
  why `BAD_ROLE_MESSAGE` and the routes-page dicts moved (a built-in role joined; every role
  now states its protocol).

---

### Task 2: A decision-model server is a provider — the `systemone` adapter and a settable `local` (gateway)

**Files:**
- Create: `services/gateway/migrations/010_systemone_adapter.sql`
- Create: `services/gateway/app/adapters/systemone.py`
- Modify: `services/gateway/app/adapters/__init__.py:11,22-26`
- Modify: `services/gateway/app/providers.py:22` (`ADAPTERS`), `:125-196` (`validate_shape`),
  `:291-345` (`insert_row`, `update_row`)
- Modify: `services/gateway/app/providers_presets.json` (append the `kev` preset)
- Test: `services/gateway/tests/test_systemone_provider.py` (create)

**Interfaces:**
- Consumes (Task 1): `routing.speaks`, `routing.cannot_serve`, the `wrong_protocol` verdict,
  `Adapter.protocols`.
- Produces:
  - `providers.ADAPTERS` gains `"systemone"`
  - `systemone.DECISIONS = "decisions"`, `systemone.normalize_models(body: object, *, owned_by: str) -> list[dict]`
    — every row `{"id", "owned_by", "output_modalities": ["decisions"], "description"?}`
  - `systemone.SystemOne` with `name = "systemone"`, `protocols = frozenset({"systemone"})`,
    `headers`, `list_models`, `verify`, `completions` (always a stated 400); `systemone.ADAPTER`
  - `validate_shape` accepts `local: bool` on any adapter (an engine is always local) and
    refuses `api-key-header` for `systemone`
  - the preset `kev`: `{"adapter": "systemone", "base_url": "http://{host}:8009/v1", "auth_shape": "none", "local": true, "placeholders": ["host"], …}`

- [ ] **Step 1: Write the failing tests.** Create `services/gateway/tests/test_systemone_provider.py`:

```python
"""A decision-model server as a provider (decision-role spec §1): the
`systemone` adapter — a base URL and an optional key, no chat — and a `local`
the owner sets, so a Kev box on his own machine is free and uncapped."""

from __future__ import annotations

import asyncpg
import pytest

from app import providers
from app.adapters import ProviderRefused, systemone
from app.main import MIGRATIONS_DIR
from tests.conftest import requires_db
from tests.fakes import FakeOllama, FakeOpenAICompat
from tests.test_routing import _route_chunk

pytestmark = requires_db

# What a Kev server's GET /v1/models answers (kev/serve.py: one TypeSafe model
# card per name it accepts).
KEV_MODELS = {
    "models": [
        {
            "name": "kev-latest",
            "description": "Kev pointer head on Qwen3.5-4B",
            "release_date": "2026-09-20",
        },
        {"name": "jev-latest", "description": "Kev pointer head on Qwen3.5-4B"},
    ]
}


@pytest.fixture(autouse=True)
def local_tags(monkeypatch, mount_backend):
    """Creating a provider checks its name against the bundled engine's tags,
    so every test here has an ollama that answers (test_providers' fixture)."""
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(tags=("qwen3:8b",))
    mount_backend("http://ollama.test", fake.app)
    return fake


async def _add_kev(client, mount_backend, *, accepts_key=None, **over):
    fake = FakeOpenAICompat(models_body=KEV_MODELS, accepts_key=accepts_key)
    mount_backend("http://kev.test", fake.app)
    payload = {
        "name": "dell-kev",
        "adapter": "systemone",
        "base_url": "http://kev.test/v1",
        "auth_shape": "none",
        "local": True,
        **over,
    }
    return fake, await client.post("/admin/providers", json=payload)


async def test_a_decision_model_server_is_a_local_provider_listing_decision_models(
    client, pool, mount_backend
):
    _fake, resp = await _add_kev(client, mount_backend)

    assert resp.status_code == 200, resp.text
    row = resp.json()
    assert (row["adapter"], row["local"], row["listing"]) == ("systemone", True, "available")
    assert row["verify_note"] == "2 decision models listed"
    listing = (await client.get("/admin/providers/dell-kev/models")).json()
    assert [m["id"] for m in listing["models"]] == ["kev-latest", "jev-latest"]
    assert all(m["output_modalities"] == ["decisions"] for m in listing["models"])
    assert listing["models"][0]["description"] == "Kev pointer head on Qwen3.5-4B"


async def test_a_decision_model_server_has_no_chat_and_says_so(client, pool, mount_backend):
    fake, _ = await _add_kev(client, mount_backend)

    resp = await client.post(
        "/v1/chat/completions",
        json={
            "model": "dell-kev:kev-latest",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": True,
        },
    )

    assert resp.status_code == 400
    assert resp.json()["error"] == (
        "dell-kev is a decision-model server (systemone): it answers typed questions at "
        "POST /v1/systemone and has no chat"
    )
    assert not [p for p, _ in fake.seen if p.endswith("/chat/completions")]


async def test_a_decision_server_as_the_chat_pick_is_passed_over_with_its_reason(
    client, pool, mount_backend
):
    """Review focus 2, at the gateway. A Kev link written into chat.model (a
    misclick on a model list) must not end every chat turn: the walk passes
    over it, says why, and the next link answers."""
    await _add_kev(client, mount_backend)
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:8b"]})

    resp = await client.post(
        "/v1/chat/completions",
        json={
            "model": "dell-kev:kev-latest",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": True,
        },
        headers={"X-Nova-Role": "chat", "X-Nova-Purpose": "chat"},
    )

    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "hub:qwen3:8b"
    route = _route_chunk(resp.content)
    assert route["link"] == 2
    assert (
        "dell-kev:kev-latest: dell-kev answers typed questions — this role needs chat"
        in route["reason"]
    )


async def test_a_keyed_decision_server_proves_its_key_by_refusing_a_wrong_one(
    client, pool, mount_backend
):
    _fake, resp = await _add_kev(
        client,
        mount_backend,
        accepts_key="kev-secret",
        auth_shape="static-bearer",
        api_key="kev-secret",
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["key_proven"] is True
    assert resp.json()["verify_note"] == "2 decision models listed; the listing accepted the key"


async def test_a_decision_server_authenticates_with_a_bearer_key_or_none(
    client, pool, mount_backend
):
    _fake, resp = await _add_kev(client, mount_backend, auth_shape="api-key-header", api_key="k")

    assert resp.status_code == 400
    assert resp.json()["error"] == (
        "a systemone server authenticates with a bearer key or none — "
        "auth_shape must be static-bearer or none"
    )


async def test_local_is_the_owners_to_set_and_an_engine_is_always_local(
    client, pool, mount_backend
):
    fake = FakeOpenAICompat(models_body={"object": "list", "data": [{"id": "qwen3:8b"}]})
    mount_backend("http://lanbox.test", fake.app)
    created = await client.post(
        "/admin/providers",
        json={
            "name": "lanbox",
            "adapter": "openai-chat",
            "base_url": "http://lanbox.test/v1",
            "auth_shape": "none",
            "local": True,
        },
    )
    assert created.status_code == 200, created.text
    assert created.json()["local"] is True

    off = await client.put("/admin/providers/lanbox", json={"local": False})
    assert off.status_code == 200 and off.json()["local"] is False
    kept = await client.put("/admin/providers/lanbox", json={})
    assert kept.json()["local"] is False, "an update that omits local keeps it"
    bad = await client.put("/admin/providers/lanbox", json={"local": "yes"})
    assert bad.status_code == 400 and bad.json()["error"] == "local must be true or false"
    engine = providers.validate_shape(
        {"adapter": "ollama", "auth_shape": "none", "local": False}, existing={"builtin": True}
    )
    assert engine["local"] is True, "an engine runs on a machine here, whatever is sent"


def test_both_listing_shapes_read_as_decision_models():
    assert systemone.normalize_models(KEV_MODELS, owned_by="dell-kev")[1] == {
        "id": "jev-latest",
        "owned_by": "dell-kev",
        "output_modalities": ["decisions"],
        "description": "Kev pointer head on Qwen3.5-4B",
    }
    assert systemone.normalize_models({"data": [{"id": "kev-4b"}]}, owned_by="x") == [
        {"id": "kev-4b", "owned_by": "x", "output_modalities": ["decisions"]}
    ]
    with pytest.raises(ProviderRefused):
        systemone.normalize_models({"nothing": []}, owned_by="x")


def test_the_kev_preset_is_a_local_decision_server_on_the_owners_host():
    kev = {preset["name"]: preset for preset in providers.load_presets()}["kev"]
    assert (kev["adapter"], kev["auth_shape"], kev["local"]) == ("systemone", "none", True)
    assert kev["base_url"] == "http://{host}:8009/v1"
    assert kev["placeholders"] == ["host"]


async def test_the_adapter_check_admits_systemone_and_still_refuses_the_unknown(pool):
    await pool.execute(
        "INSERT INTO providers (name, adapter, base_url, auth_shape, local) "
        "VALUES ('kevbox', 'systemone', 'http://kev.test/v1', 'none', true)"
    )
    with pytest.raises(asyncpg.CheckViolationError):
        await pool.execute(
            "INSERT INTO providers (name, adapter, base_url, auth_shape) "
            "VALUES ('bogus', 'bogus', 'http://x.test', 'none')"
        )
    # Idempotent, like every migration beside it (007's rule): it runs over itself.
    await pool.execute((MIGRATIONS_DIR / "010_systemone_adapter.sql").read_text())
```

- [ ] **Step 2: Run them to see them fail.**
  ```bash
  . "$SCRATCHPAD/decisions.env" && cd /home/jeremy/workspace/nova/.worktrees/decisions/services/gateway && TEST_DATABASE_URL="$GATEWAY_DB" uv run pytest -q tests/test_systemone_provider.py
  ```
  Expected: FAIL — `ImportError: cannot import name 'systemone' from 'app.adapters'`.

- [ ] **Step 3: The migration.** Check the next free number first
  (`ls services/gateway/migrations/` — 009 is the last), then create
  `services/gateway/migrations/010_systemone_adapter.sql`:
  ```sql
  -- The decision role (docs/plans/rebuild/decision-role/spec.md §1): a provider
  -- can be a decision-model server — `systemone`, a base URL and an optional
  -- key, no chat. A Kev box on the owner's network is one. The CHECK is 003's
  -- inline column constraint (Postgres named it providers_adapter_check).
  --
  -- `local` already exists (005). It stops being derived from the adapter in
  -- code (providers.validate_shape): the owner says whether a provider runs on
  -- his own machine. Nothing here changes a stored value.
  --
  -- Idempotent (007's rule): DROP-then-ADD.
  ALTER TABLE providers DROP CONSTRAINT IF EXISTS providers_adapter_check;
  ALTER TABLE providers ADD CONSTRAINT providers_adapter_check
      CHECK (adapter IN ('ollama', 'openai-chat', 'anthropic-messages', 'systemone'));
  ```

- [ ] **Step 4: The adapter.** Create `services/gateway/app/adapters/systemone.py`:

```python
"""The `systemone` adapter: a decision-model server (decision-role spec §1).

A decision model answers TYPED QUESTIONS — `{state, model, questions}` in,
`{model, answers, usage}` out — at `{base_url}/systemone`. TypeSafe's Jev
serves that shape, and so does Jared Palmer's Kev ("the TypeSafe Python SDK
works against a Kev server unchanged"). A provider row on THIS adapter is a
server that speaks nothing else — a Kev box on the owner's network: a base
URL and an optional bearer key, and no chat, which it says.

The decision call itself is not a method here: POST /v1/systemone forwards to
ANY link whose adapter carries `systemone` (Adapter.protocols) — OpenRouter's
openai-chat row carries both — with that row's own adapter's auth headers.
"""

from __future__ import annotations

import httpx
from fastapi import Request
from starlette.responses import Response

from app.adapters import base
from app.adapters.base import (
    MODELS_TIMEOUT,
    Listing,
    ListingUnavailable,
    ProviderRefused,
    VerifyResult,
    http_client,
    reason,
    refusal_detail,
)
from app.providers import base_url_of

#: What a decision model's listing row says it outputs — OpenRouter's own word
#: (`architecture.output_modalities`), so the catalogue reads a Kev box and
#: OpenRouter's Jev the same way.
DECISIONS = "decisions"
DESCRIPTION_CAP = 500
#: A key that is certainly wrong, for the verify that proves the right one.
WRONG_KEY = "nova-verify-this-key-is-wrong"


def normalize_models(body: object, *, owned_by: str) -> list[dict]:
    """A decision server's GET /models in the one listing shape: TypeSafe's
    model cards (`{"models": [{"name", "description", ...}]}` — what Kev
    serves) or OpenAI's `{"data": [{"id"}]}`. Every row is a decision model —
    the protocol says so — and states it as `output_modalities: ["decisions"]`."""
    if not isinstance(body, dict):
        raise ProviderRefused(502, "the model listing was not a JSON object")
    if isinstance(body.get("models"), list):
        entries, key = body["models"], "name"
    elif isinstance(body.get("data"), list):
        entries, key = body["data"], "id"
    else:
        raise ProviderRefused(502, "the model listing carried neither `models` nor `data`")
    rows: list[dict] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        model_id = entry.get(key)
        if not isinstance(model_id, str) or not model_id.strip():
            continue
        row: dict = {
            "id": model_id.strip(),
            "owned_by": owned_by,
            "output_modalities": [DECISIONS],
        }
        description = entry.get("description")
        if isinstance(description, str) and description.strip():
            row["description"] = description.strip()[:DESCRIPTION_CAP]
        rows.append(row)
    return rows


class SystemOne:
    name = "systemone"
    protocols = frozenset({"systemone"})

    def headers(self, row: dict) -> dict[str, str]:
        # providers.validate_shape allows `none` and `static-bearer` only.
        return base.bearer_or_header(row, header_name="api-key")

    async def list_models(self, app, row: dict) -> Listing:
        url = base_url_of(row)
        if not url:
            raise ProviderRefused(502, f"provider {row['name']!r} has no base URL")
        client = http_client(app, MODELS_TIMEOUT, base_url=url, headers=self.headers(row))
        try:
            async with client as c:
                resp = await c.get("/models")
        except httpx.HTTPError as exc:
            raise ProviderRefused(502, f"could not reach {url} — {reason(exc)}") from exc
        if resp.status_code in (404, 405):
            raise ListingUnavailable(
                f"{url}/models answered {resp.status_code} — this server has no model "
                "listing; type a model id"
            )
        if resp.status_code != 200:
            raise ProviderRefused(resp.status_code, refusal_detail(resp))
        try:
            body = resp.json()
        except ValueError as exc:
            raise ProviderRefused(502, f"{url}/models returned non-JSON: {exc}") from exc
        return Listing(source=row["name"], models=normalize_models(body, owned_by=row["name"]))

    async def verify(self, app, row: dict) -> VerifyResult:
        """What a save must prove: the server answers and, when it has a key,
        the key is accepted. The listing is read with the key, then with one
        that is certainly wrong: a 401/403 to the wrong one means the right one
        was accepted (Kev answers 401 on every /v1 path when KEV_API_KEY is set).
        A listing that answers the wrong key too proved nothing about the key,
        and the note says so — never "verified"."""
        try:
            listing = await self.list_models(app, row)
        except ListingUnavailable as exc:
            return VerifyResult(
                listing="unavailable",
                note=f"{exc} — the key was not tested; the first decision will tell",
                key_proven=None,
            )
        note = f"{len(listing.models)} decision models listed"
        if row.get("auth_shape") == "none":
            return VerifyResult(
                listing="available", models=listing.models, note=note, key_proven=None
            )
        wrong = dict(row, api_key=WRONG_KEY)
        client = http_client(
            app, MODELS_TIMEOUT, base_url=base_url_of(row), headers=self.headers(wrong)
        )
        try:
            async with client as c:
                resp = await c.get("/models")
        except httpx.HTTPError as exc:
            return VerifyResult(
                listing="available",
                models=listing.models,
                note=f"{note}; the wrong-key check could not reach the server — "
                f"{reason(exc)} — the key is NOT proven; the first decision will tell",
                key_proven=None,
            )
        if resp.status_code in (401, 403):
            return VerifyResult(
                listing="available",
                models=listing.models,
                note=f"{note}; the listing accepted the key",
                key_proven=True,
            )
        return VerifyResult(
            listing="available",
            models=listing.models,
            note=f"{note}; the listing answered {resp.status_code} to a wrong key too, so "
            "the key is NOT proven — the first decision will tell",
            key_proven=None,
        )

    async def completions(self, request: Request, row: dict, model: str, body: dict) -> Response:
        """A decision-model server has no chat, and says so — a 400 about THIS
        request, so nothing is walled. Routing never picks one for a chat role
        (routing.speaks); this is what a caller with no role, naming the model
        outright, is told."""
        raise ProviderRefused(
            400,
            f"{row['name']} is a decision-model server (systemone): it answers typed "
            "questions at POST /v1/systemone and has no chat",
        )


ADAPTER = SystemOne()

__all__ = ["ADAPTER", "DECISIONS", "SystemOne", "normalize_models"]
```

  And register it in `app/adapters/__init__.py`:
  ```python
  from app.adapters import anthropic_messages, ollama, openai_chat, systemone
  ```
  ```python
  _BY_NAME: dict[str, Adapter] = {
      "ollama": ollama.ADAPTER,
      "openai-chat": openai_chat.ADAPTER,
      "anthropic-messages": anthropic_messages.ADAPTER,
      # A decision-model server (decision-role spec §1): typed questions only.
      "systemone": systemone.ADAPTER,
  }
  ```

- [ ] **Step 5: The provider shape.** In `app/providers.py`:
  - `:22` → `ADAPTERS = ("ollama", "openai-chat", "anthropic-messages", "systemone")`
  - in `validate_shape`, straight after the anthropic auth check (`:159-164`):
    ```python
        if adapter == "systemone" and auth_shape == "api-key-header":
            raise HTTPException(
                status_code=400,
                detail="a systemone server authenticates with a bearer key or none — "
                "auth_shape must be static-bearer or none",
            )
    ```
  - in `validate_shape`, straight before `for field in ("default_model", "model_note", "preset"):` (`:191`):
    ```python
        # `local` (decision-role spec §1): the provider runs on the owner's own
        # machine, so its calls are never priced and never capped (usage.over_cap,
        # usage.price_call). An engine always is; any other row is what the owner
        # says — false until he says so, and kept when an update omits it.
        if "local" in payload:
            if not isinstance(payload["local"], bool):
                raise HTTPException(status_code=400, detail="local must be true or false")
            merged["local"] = payload["local"]
        else:
            merged["local"] = bool((existing or {}).get("local", False))
        if adapter == "ollama":
            merged["local"] = True
    ```
  - `insert_row` (`:291-318`): the SQL's last value `$2 = 'ollama'` becomes `$14`, and the
    parameter list gains, after `bool(shape.get("verified")),`:
    ```python
                # validate_shape decided it; an engine is local whatever a caller sent.
                bool(shape.get("local")) or shape["adapter"] == "ollama",
    ```
  - `update_row` (`:321-345`): `updated_at = now() ` becomes `local = $14, updated_at = now() `
    and the parameter list gains the same line after `bool(shape.get("verified")),`.

- [ ] **Step 6: The Kev preset.** Append to the list in `app/providers_presets.json`, after
  the `bedrock` entry (a comma after that entry's closing brace), and check the file still
  parses — `python3 -c "import json; json.load(open('app/providers_presets.json'))"` from
  `services/gateway`:
  ```json
    {
      "name": "kev",
      "label": "Kev decision-model server (your own machine)",
      "adapter": "systemone",
      "base_url": "http://{host}:8009/v1",
      "auth_shape": "none",
      "local": true,
      "placeholders": ["host"],
      "docs_url": "https://github.com/jaredpalmer/kev",
      "model_note": "kev-latest is whatever checkpoint the server was started with (kev.serve --run jaredpalmer/kev-4b).",
      "quirks": "A decision model answers typed questions for the Decisions role and has no chat. Start the server with --host 0.0.0.0 so the gateway can reach it; set KEV_API_KEY on the server, and add it as a custom provider with a bearer key, to require one."
    }
  ```

- [ ] **Step 7: Run the tests to see them pass.**
  ```bash
  . "$SCRATCHPAD/decisions.env" && cd /home/jeremy/workspace/nova/.worktrees/decisions/services/gateway && TEST_DATABASE_URL="$GATEWAY_DB" uv run pytest -q tests/test_systemone_provider.py tests/test_providers.py tests/test_engines.py tests/test_backends.py tests/test_decisions_role.py
  ```
  Expected: PASS.

- [ ] **Step 8: The whole gateway suite, lint, format, commit.**
  ```bash
  . "$SCRATCHPAD/decisions.env" && cd /home/jeremy/workspace/nova/.worktrees/decisions/services/gateway && TEST_DATABASE_URL="$GATEWAY_DB" uv run pytest -q 2>&1 | tail -3
  cd /home/jeremy/workspace/nova/.worktrees/decisions/services/gateway && uv run ruff check app tests && uv run ruff format app/adapters/systemone.py app/adapters/__init__.py app/providers.py tests/test_systemone_provider.py
  git -C /home/jeremy/workspace/nova/.worktrees/decisions add services/gateway/migrations/010_systemone_adapter.sql services/gateway/app/adapters/systemone.py services/gateway/app/adapters/__init__.py services/gateway/app/providers.py services/gateway/app/providers_presets.json services/gateway/tests/test_systemone_provider.py
  git -C /home/jeremy/workspace/nova/.worktrees/decisions commit -m "feat(gateway): a decision-model server is a provider — the systemone adapter, a settable local, the Kev preset"
  git -C /home/jeremy/workspace/nova/.worktrees/decisions show --stat HEAD
  ```

---

### Task 3: `POST /v1/systemone` — the same walk, the link's own model and key, metered under the role (gateway)

**Files:**
- Modify: `services/gateway/app/adapters/systemone.py` (add `SYSTEMONE_TIMEOUT`, `call`)
- Modify: `services/gateway/app/data_plane.py:1-18` (docstring), `:20-33` (imports),
  `:100-175` (`serve_by_role` → `walk_role` + a thin `serve_by_role`), after `:247`
  (`serve_systemone`, the route)
- Modify: `services/gateway/app/usage.py` after `:562` (`decision_captured`,
  `observe_decision`)
- Modify: `services/gateway/tests/fakes.py:410-516` (`FakeOpenAICompat` answers `/systemone`)
- Test: `services/gateway/tests/test_systemone_route.py` (create)

**Interfaces:**
- Consumes (Tasks 1-2): `routing.DECISIONS_ROLE`, `routing.protocol_of`, the protocol-aware
  `routing.resolve`, `data_plane._nothing_runnable`, `systemone.ADAPTER`, the `dell-kev`
  shape (`systemone`, `local: true`).
- Produces:
  - `POST /v1/systemone` — body `{state, questions, model?}`; `model`, when a string, is
    link 1 (a `provider:model` pick); answers `200 {model, answers, usage: <ledger fields>, route, …}`
    with `X-Nova-Served-By` and `X-Nova-Route`; `400` for a body without `questions` or an
    `X-Nova-Role` other than `decisions`; `503` in the walk's words when nothing can serve;
    a provider's own non-wall status relayed as it came.
  - `data_plane.walk_role(request, pool, role: str, requested: str | None, attribution, serve) -> Response`
    where `serve: Callable[[routing.Decision], Awaitable[Response]]`
  - `data_plane.serve_systemone(request, pool, row: dict, model: str, body: dict, attribution, route: dict | None = None) -> Response`
  - `systemone.call(app, row: dict, model: str, body: dict, headers: dict[str, str]) -> tuple[int, bytes]`
  - `usage.decision_captured(parsed: object) -> Captured`
  - `usage.observe_decision(pool, *, status: int, content: bytes, row: dict, model: str, served_by: str, attribution: Attribution, started: float, route: dict | None) -> Response`
  - The ledger: a decision is `kind='completion'` (or `'refusal'`), `role='decisions'`,
    `purpose` = the caller's `X-Nova-Purpose`, `prompt_tokens` = `usage.input_tokens`,
    `completion_tokens` = `usage.output_tokens`, `cost_usd` = `usage.cost`
    (`cost_basis='provider-reported'`); a local link's row has no dollars.
  - The core fakes in Task 7 mirror this route's 503 words exactly:
    `"no model in the 'decisions' chain can serve right now — the decisions chain is empty, so no decision model is set (add one in Settings → Routing)"`.

- [ ] **Step 1: The fake answers typed questions.** In `services/gateway/tests/fakes.py`,
  `FakeOpenAICompat` gains three fields after `models_wrong_key_status`:
  ```python
      # The decision role (decision-role spec §1): typed questions at
      # {prefix}/systemone with the same key as chat. OpenRouter states its own
      # `usage.cost`; a Kev server states tokens and no cost (pass
      # systemone_usage without it).
      systemone_status: int = 200
      systemone_answers: dict = field(
          default_factory=lambda: {"acts": {"type": "noul", "noul": 0.91}}
      )
      systemone_usage: dict = field(
          default_factory=lambda: {"input_tokens": 40, "output_tokens": 6, "cost": 0.00001}
      )
  ```
  its route list gains `Route(f"{self.prefix}/systemone", self._systemone, methods=["POST"]),`,
  and after `_completions`:
  ```python
      async def _systemone(self, request):
          raw = await request.body()
          body = json.loads(raw) if raw else None
          self._note(request)
          self.seen.append((request.url.path, body))
          if not self._key_ok(request):
              return JSONResponse(
                  {"error": {"message": "User not found.", "code": 401}}, status_code=401
              )
          if self.systemone_status != 200:
              return JSONResponse(
                  {"error": {"message": f"refused ({self.systemone_status})"}},
                  status_code=self.systemone_status,
              )
          return JSONResponse(
              {
                  "model": (body or {}).get("model"),
                  "answers": self.systemone_answers,
                  "usage": self.systemone_usage,
                  "id": "sys-1",
              }
          )
  ```

- [ ] **Step 2: Write the failing tests.** Create `services/gateway/tests/test_systemone_route.py`:

```python
"""POST /v1/systemone (decision-role spec §1): typed questions for the
decisions role, walked through the SAME loop as chat.

Pins: the body goes to the winning link's {base_url}/systemone unchanged but
for `model`, which becomes the link's own id, with the provider's own key; the
answer comes back with the ledger's usage and the route, X-Nova-Served-By and
X-Nova-Route; the call is metered under the decisions role (OpenRouter's
stated cost; a local link has no dollars); a refusing link is walled and the
same request falls to the next; a decision server that cannot be reached is
walled and the next request passes it undialled; an empty chain is a 503 in
words that dials nothing; a body with no questions, or another role, is a 400;
a provider's own 4xx is relayed and walls nothing."""

from __future__ import annotations

from decimal import Decimal

import httpx
import pytest

from app import backends, engines
from tests.conftest import requires_db
from tests.fakes import FailingTransport, FakeOllama, FakeOpenAICompat

pytestmark = requires_db

JEV = "~typesafe/jev-latest"
KEV = "dell-kev:kev-latest"
TURN = "2d6f1a4e-9b1c-4c1e-8f3a-5b7e0c2d9a11"
STATE = '{"owner_message": "How do I get you on my phone"}'
QUESTIONS = {"acts": {"type": "noul", "instructions": "Does answering need doing something?"}}
EMPTY = (
    "no model in the 'decisions' chain can serve right now — the decisions chain is empty, "
    "so no decision model is set (add one in Settings → Routing)"
)


@pytest.fixture
async def local(pool, monkeypatch, mount_backend):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(tags=("qwen3:8b",))
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:8b"})
    engines.clear_cache()
    return fake


async def _openrouter(client, mount_backend) -> FakeOpenAICompat:
    fake = FakeOpenAICompat(
        accepts_key="sk-1", models_body={"object": "list", "data": [{"id": JEV}]}
    )
    mount_backend("http://openrouter.test", fake.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "openrouter",
            "adapter": "openai-chat",
            "base_url": "http://openrouter.test/v1",
            "auth_shape": "static-bearer",
            "api_key": "sk-1",
        },
    )
    assert resp.status_code == 200, resp.text
    return fake


async def _kev(client, mount_backend) -> FakeOpenAICompat:
    fake = FakeOpenAICompat(
        models_body={"models": [{"name": "kev-latest"}]},
        systemone_usage={"input_tokens": 900, "output_tokens": 12},
    )
    mount_backend("http://kev.test", fake.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "dell-kev",
            "adapter": "systemone",
            "base_url": "http://kev.test/v1",
            "auth_shape": "none",
            "local": True,
        },
    )
    assert resp.status_code == 200, resp.text
    return fake


async def _chain(client, *links: str) -> None:
    resp = await client.put("/admin/routes/decisions", json={"chain": list(links)})
    assert resp.status_code == 200, resp.text


async def _decide(client, **body):
    return await client.post(
        "/v1/systemone",
        json={"state": STATE, "questions": QUESTIONS, **body},
        headers={"X-Nova-Role": "decisions", "X-Nova-Purpose": "chat", "X-Nova-Turn-Id": TURN},
    )


def _asked(fake: FakeOpenAICompat) -> list[dict | None]:
    return [body for path, body in fake.seen if path == "/v1/systemone"]


async def test_a_decision_goes_to_the_first_link_with_its_own_model_id_and_key(
    client, pool, local, mount_backend
):
    jev = await _openrouter(client, mount_backend)
    await _chain(client, f"openrouter:{JEV}")

    resp = await _decide(client)

    assert resp.status_code == 200, resp.text
    assert resp.headers["x-nova-served-by"] == f"openrouter:{JEV}"
    assert resp.headers["x-nova-route"] == "role=decisions;link=1"
    body = resp.json()
    assert body["answers"] == jev.systemone_answers
    assert body["usage"]["cost_usd"] == 1e-05
    assert body["usage"]["cost_basis"] == "provider-reported"
    assert (body["usage"]["prompt_tokens"], body["usage"]["completion_tokens"]) == (40, 6)
    assert body["route"] == {
        "role": "decisions",
        "link": 1,
        "reason": None,
        "served_by": f"openrouter:{JEV}",
        "standby": False,
    }
    # Unchanged but for `model`, which is the LINK's own id.
    assert _asked(jev) == [{"state": STATE, "questions": QUESTIONS, "model": JEV}]
    assert jev.seen_auth[-1] == "Bearer sk-1"
    (row,) = await pool.fetch(
        "SELECT kind, role, purpose, provider, model, prompt_tokens, completion_tokens, "
        "cost_usd, cost_basis, local, turn_id::text AS turn FROM usage_events"
    )
    assert (row["kind"], row["role"], row["purpose"]) == ("completion", "decisions", "chat")
    assert (row["provider"], row["model"], row["turn"]) == ("openrouter", JEV, TURN)
    assert (row["prompt_tokens"], row["completion_tokens"]) == (40, 6)
    assert row["cost_usd"] == Decimal("0.00001") and row["cost_basis"] == "provider-reported"
    assert row["local"] is False


async def test_a_local_decision_server_is_metered_with_no_dollars(
    client, pool, local, mount_backend
):
    kev = await _kev(client, mount_backend)
    await _chain(client, KEV)

    resp = await _decide(client)

    assert resp.status_code == 200, resp.text
    assert resp.headers["x-nova-served-by"] == KEV
    usage = resp.json()["usage"]
    assert usage["cost_usd"] is None and usage["local"] is True
    assert _asked(kev) == [{"state": STATE, "questions": QUESTIONS, "model": "kev-latest"}]
    (row,) = await pool.fetch("SELECT local, cost_usd, prompt_tokens FROM usage_events")
    assert row["local"] is True and row["cost_usd"] is None and row["prompt_tokens"] == 900


async def test_a_refusing_first_link_is_walled_and_the_same_request_falls_to_the_next(
    client, pool, local, mount_backend
):
    kev = await _kev(client, mount_backend)
    jev = await _openrouter(client, mount_backend)
    await _chain(client, KEV, f"openrouter:{JEV}")
    kev.systemone_status = 503

    resp = await _decide(client)

    assert resp.status_code == 200, resp.text
    assert resp.headers["x-nova-served-by"] == f"openrouter:{JEV}"
    route = resp.json()["route"]
    assert route["link"] == 2 and f"{KEV}: {KEV} refused this request" in route["reason"]
    walls = await pool.fetch("SELECT provider, model, status FROM provider_walls")
    assert [(w["provider"], w["model"], w["status"]) for w in walls] == [
        ("dell-kev", "kev-latest", 503)
    ]
    rows = await pool.fetch("SELECT kind, provider, status, role FROM usage_events ORDER BY id")
    assert [(r["kind"], r["provider"], r["status"], r["role"]) for r in rows] == [
        ("refusal", "dell-kev", 503, "decisions"),
        ("completion", "openrouter", 200, "decisions"),
    ]
    assert len(_asked(jev)) == 1


async def test_a_decision_server_that_cannot_be_reached_is_walled_and_then_passed_undialled(
    client, pool, local, mount_backend, mount_transport
):
    """Review focus 3. The Dell asleep: the first request dials Kev, fails to
    connect, walls it and is answered by Jev; the next request goes straight
    to Jev without dialling the dead box — the wall, not the socket, decides."""
    await _kev(client, mount_backend)
    await _openrouter(client, mount_backend)
    await _chain(client, KEV, f"openrouter:{JEV}")
    down = FailingTransport(httpx.ConnectError)
    mount_transport("http://kev.test", down)

    first = await _decide(client)

    assert first.headers["x-nova-served-by"] == f"openrouter:{JEV}"
    walls = await pool.fetch("SELECT provider, model, status FROM provider_walls")
    assert [(w["provider"], w["model"], w["status"]) for w in walls] == [
        ("dell-kev", "kev-latest", 502)
    ]
    dialled = len(down.requests)
    assert dialled == 1

    second = await _decide(client)

    assert second.headers["x-nova-served-by"] == f"openrouter:{JEV}"
    assert len(down.requests) == dialled, "a walled decision server is not dialled again"
    assert "walled for another" in second.json()["route"]["reason"]


async def test_an_empty_decisions_chain_is_a_503_in_words_that_dials_nothing(
    client, pool, local, mount_backend
):
    """Review focus 1, at the endpoint: no decision model set — every install's
    first state — is a stated 503, and no provider (and no chat model) is asked."""
    jev = await _openrouter(client, mount_backend)
    await client.put("/admin/routes/chat", json={"chain": [f"openrouter:{JEV}", "hub:qwen3:8b"]})

    resp = await _decide(client)

    assert resp.status_code == 503
    assert resp.json()["error"] == EMPTY
    assert _asked(jev) == []
    assert not [p for p, _ in local.seen if p.endswith("/chat/completions")]
    assert await pool.fetchval("SELECT count(*) FROM usage_events") == 0


async def test_a_requested_model_is_link_one_as_it_is_for_chat(client, pool, local, mount_backend):
    kev = await _kev(client, mount_backend)
    await _openrouter(client, mount_backend)
    await _chain(client, f"openrouter:{JEV}")

    resp = await _decide(client, model=KEV)

    assert resp.headers["x-nova-served-by"] == KEV
    assert _asked(kev)[-1]["model"] == "kev-latest"


async def test_a_providers_own_refusal_about_the_request_is_relayed_and_walls_nothing(
    client, pool, local, mount_backend
):
    kev = await _kev(client, mount_backend)
    await _chain(client, KEV)
    kev.systemone_status = 422

    resp = await _decide(client)

    assert resp.status_code == 422
    assert resp.json()["error"]["message"] == "refused (422)"
    assert await pool.fetch("SELECT provider FROM provider_walls") == []
    (row,) = await pool.fetch("SELECT kind, status, error FROM usage_events")
    assert (row["kind"], row["status"], row["error"]) == ("refusal", 422, "refused (422)")


async def test_a_body_without_questions_or_another_role_is_refused_before_any_call(
    client, pool, local, mount_backend
):
    jev = await _openrouter(client, mount_backend)
    await _chain(client, f"openrouter:{JEV}")

    none = await client.post("/v1/systemone", json={"state": STATE})
    other = await client.post(
        "/v1/systemone",
        json={"state": STATE, "questions": QUESTIONS},
        headers={"X-Nova-Role": "chat"},
    )

    assert none.status_code == 400
    assert none.json()["error"] == (
        "questions must be a non-empty object — the typed questions a decision model answers"
    )
    assert other.status_code == 400
    assert other.json()["error"] == (
        "POST /v1/systemone serves the decisions role — X-Nova-Role named 'chat'"
    )
    assert _asked(jev) == []
```

- [ ] **Step 3: Run them to see them fail.**
  ```bash
  . "$SCRATCHPAD/decisions.env" && cd /home/jeremy/workspace/nova/.worktrees/decisions/services/gateway && TEST_DATABASE_URL="$GATEWAY_DB" uv run pytest -q tests/test_systemone_route.py
  ```
  Expected: FAIL — every request answers 404 (no `/v1/systemone` route yet).

- [ ] **Step 4: The call.** Append to `app/adapters/systemone.py` (and add `"SYSTEMONE_TIMEOUT"`
  and `"call"` to its `__all__`):
  ```python
  #: A decision is one prefill on the model's side, but Kev measured 21-47 s cold
  #: on the Dell (decision-role spec, "Open risks"): the read budget covers a
  #: cold load. Core's own per-turn budget is what bounds a turn; this bounds
  #: the gateway's call, which finishes — and is metered, and walled when it
  #: fails — even after core has stopped waiting.
  SYSTEMONE_TIMEOUT = httpx.Timeout(connect=5.0, read=60.0, write=10.0, pool=5.0)


  async def call(
      app, row: dict, model: str, body: dict, headers: dict[str, str]
  ) -> tuple[int, bytes]:
      """POST the typed questions to `{base_url}/systemone` with THIS link's model
      id and the provider's key: (status, body bytes). The body is forwarded
      unchanged but for `model` (decision-role spec §1). A non-200 is the
      provider's own answer and comes back as it came; only a failure to get any
      answer raises — a stated 502, which the walk walls like any refusal."""
      url = base_url_of(row)
      if not url:
          raise ProviderRefused(502, f"provider {row['name']!r} has no base URL")
      client = http_client(app, SYSTEMONE_TIMEOUT, base_url=url, headers=headers)
      try:
          async with client as c:
              resp = await c.post("/systemone", json=dict(body, model=model))
      except httpx.HTTPError as exc:
          raise ProviderRefused(
              502, f"could not reach {row['name']} at {url} — {reason(exc)}"
          ) from exc
      return resp.status_code, resp.content
  ```

- [ ] **Step 5: Metering a decision.** In `app/usage.py`, after `observe` (`:562`):
  ```python
  def decision_captured(parsed: object) -> Captured:
      """What a decision model's answer stated: `usage.input_tokens` and
      `usage.output_tokens` — TypeSafe's names, which Jev and Kev both send — as
      the ledger's prompt and completion counts, and `usage.cost`, the
      provider's OWN figure (OpenRouter's). Absent stays None, never 0."""
      captured = Captured()
      if not isinstance(parsed, dict):
          return captured
      captured.frames = 1
      stated = parsed.get("usage")
      if isinstance(stated, dict):
          for attr, key in (("prompt_tokens", "input_tokens"), ("completion_tokens", "output_tokens")):
              value = stated.get(key)
              if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                  setattr(captured, attr, value)
          cost = stated.get("cost")
          if isinstance(cost, int | float) and not isinstance(cost, bool) and cost >= 0:
              captured.cost = Decimal(str(cost))
      err = parsed.get("error")
      if err:
          captured.error = (str(err.get("message") or err) if isinstance(err, dict) else str(err))[
              :400
          ]
      return captured


  async def observe_decision(
      pool: asyncpg.Pool,
      *,
      status: int,
      content: bytes,
      row: dict,
      model: str,
      served_by: str,
      attribution: Attribution,
      started: float,
      route: dict | None,
  ) -> Response:
      """One decision, metered and relayed (decision-role spec §1). The ledger row
      is written under the call's role exactly like a completion's: a 200 is kind
      `completion` with the provider's stated tokens and cost (a local link never
      has dollars); anything else is kind `refusal` with the provider's words. A
      200's JSON goes back with `usage` replaced by the ledger's own fields — the
      enrichment a buffered chat completion gets — and `route` added; a refusal
      goes back as it came."""
      try:
          parsed = json.loads(content) if content else None
      except ValueError:
          parsed = None
      event = Event(
          provider=row["name"],
          model=model,
          served_by=served_by,
          kind="completion" if status == 200 else "refusal",
          attribution=attribution,
          duration_ms=int((time.monotonic() - started) * 1000),
          local=bool(row.get("local")),
          status=status,
          captured=decision_captured(parsed),
          route_reason=route.get("reason") if route else None,
          route_link=route.get("link") if route else None,
      )
      if event.kind == "refusal":
          event.error = event.captured.error or (content.decode(errors="replace")[:400] or None)
      else:
          event.cost_usd, event.cost_basis = await price_call(pool, row, model, event.captured)
          event.error = event.captured.error
      recorded = await record(pool, event)
      if event.kind == "completion" and isinstance(parsed, dict):
          enriched = dict(parsed)
          enriched["usage"] = usage_fields(event, recorded)
          if route is not None:
              enriched["route"] = route
          content = json.dumps(enriched).encode()
      return Response(content=content, status_code=status, media_type="application/json")
  ```

- [ ] **Step 6: One walk for both routes, and the decision route.** In `app/data_plane.py`:
  - the module docstring gains, after its S40 paragraph:
    ```
    POST /v1/systemone (decision-role spec §1) is the decision role's route:
    typed questions, never a chat completion. It walks the `decisions` chain
    through the SAME loop as chat (walk_role) — walls, fallback, X-Nova-Route
    — and meters each call under the role (usage.observe_decision).
    ```
  - imports: `from dataclasses import dataclass, replace` (was `dataclass`),
    `from collections.abc import Awaitable, Callable`, and
    `from app.adapters import ListingUnavailable, ProviderRefused, ProviderUnreachable, systemone`
  - replace `serve_by_role` (`:100-175`) with:
    ```python
    async def walk_role(
        request: Request,
        pool,
        role: str,
        requested: str | None,
        attribution,
        serve: Callable[[routing.Decision], Awaitable[Response]],
    ) -> Response:
        """Walk the role's chain (app/routing.py) and serve from the first link
        that can — the ONE loop both data-plane routes use, so walls and fallback
        work identically for a chat completion and a decision (decision-role
        spec §1). `serve(decision)` makes the call on the chosen link. A link that
        REFUSES before answering is recorded, walled, and the next runnable link
        is tried in this same request — the reply then states the fallback (rail
        20). An engine that could not be REACHED is recorded and passed over the
        same way, but never walled (D21)."""
        from app import admin  # the fit context and probe query /admin/suggest uses

        skip: set[str] = set()
        unreachable: dict[str, str] = {}
        try:
            routing.validate_role(role)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        for _attempt in range(6):
            try:
                decision = await routing.resolve(
                    request.app,
                    pool,
                    role=role,
                    requested=requested,
                    timezone=attribution.timezone,
                    fit_context=admin._fit_context,
                    latest_probes=admin._latest_probes,
                    skip=skip,
                    unreachable=unreachable,
                )
            except routing.NothingRunnable as exc:
                raise HTTPException(status_code=503, detail=_nothing_runnable(exc)) from exc
            link = f"{decision.row['name']}:{decision.model}"
            try:
                response = await serve(decision)
            except EngineUnreachable as exc:
                # Never a wall (D21): passed over for the rest of this request
                # only, in its own words. serve_completion already made the
                # engine's observation be read again (ruling C11).
                unreachable[link] = str(exc.detail)
                continue
            except HTTPException as exc:
                if exc.status_code in routing.WALL_STATUSES or exc.status_code >= 500:
                    await routing.record_refusal(
                        pool, decision.row, exc.status_code, str(exc.detail), model=decision.model
                    )
                    skip.add(link)
                    continue
                raise
            if response.status_code in routing.WALL_STATUSES or response.status_code >= 500:
                detail = ""
                body_bytes = getattr(response, "body", b"")
                if body_bytes:
                    detail = body_bytes.decode(errors="replace")[:200]
                await routing.record_refusal(
                    pool, decision.row, response.status_code, detail, model=decision.model
                )
                skip.add(link)
                continue
            if response.status_code == 200 and not decision.row.get("local"):
                await routing.note_success(pool, decision.row["name"], decision.model)
            response.headers[ROUTE_HEADER] = decision.header()
            return response
        raise HTTPException(
            status_code=503, detail=f"every link in the {role!r} chain refused this request"
        )


    async def serve_by_role(
        request: Request, pool, role: str, requested, body, attribution
    ) -> Response:
        """A chat completion, walked through the role's chain (walk_role)."""

        async def serve(decision: routing.Decision) -> Response:
            return await serve_completion(
                request,
                pool,
                decision.row,
                decision.model,
                body,
                attribution,
                route=decision.as_route(),
            )

        return await walk_role(request, pool, role, requested, attribution, serve)
    ```
  - after `serve_completion` (`:247`):
    ```python
    async def serve_systemone(
        request: Request,
        pool,
        row: dict,
        model: str,
        body: dict,
        attribution,
        route: dict | None = None,
    ) -> Response:
        """One decision on `row`, METERED (usage.observe_decision), with the
        provider's key from its own adapter's auth rule. A call that got no
        answer at all is recorded as a refusal and raised with its status — the
        walk walls it and tries the next link, as for chat."""
        served_by = _served_by(row, model)
        started = time.monotonic()
        try:
            status, content = await systemone.call(
                request.app, row, model, body, adapters.for_row(row).headers(row)
            )
        except ProviderRefused as exc:
            await usage.record_probe(
                pool,
                row=row,
                model=model,
                status=exc.status,
                body=b"",
                started=started,
                purpose=attribution.purpose,
                error=exc.detail,
            )
            raise HTTPException(
                status_code=exc.status, detail=exc.detail, headers={SERVED_BY_HEADER: served_by}
            ) from exc
        response = await usage.observe_decision(
            pool,
            status=status,
            content=content,
            row=row,
            model=model,
            served_by=served_by,
            attribution=attribution,
            started=started,
            route=route,
        )
        response.headers[SERVED_BY_HEADER] = served_by
        return response


    @router.post("/v1/systemone")
    async def systemone_decide(request: Request) -> Response:
        """Typed questions for the decision role (decision-role spec §1).

        The body is TypeSafe's `{state, questions}` and, optionally, `model` — a
        `provider:model` pick that is link 1, exactly as chat's requested model
        (plan decision 9; core sends none, so the decisions chain decides). It is
        forwarded unchanged but for `model`, which becomes the winning link's own
        id, to `{base_url}/systemone` with that provider's key. Only the decisions
        role is served here, whatever the header says: the endpoint decides the
        protocol."""
        try:
            body = await request.json()
        except Exception as exc:
            raise HTTPException(
                status_code=400, detail=f"request body is not valid JSON: {exc}"
            ) from exc
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="request body must be a JSON object")
        questions = body.get("questions")
        if not isinstance(questions, dict) or not questions:
            raise HTTPException(
                status_code=400,
                detail="questions must be a non-empty object — the typed questions a "
                "decision model answers",
            )
        attribution = usage.Attribution.from_headers(request.headers)
        if attribution.role and attribution.role != routing.DECISIONS_ROLE:
            raise HTTPException(
                status_code=400,
                detail=f"POST /v1/systemone serves the {routing.DECISIONS_ROLE} role — "
                f"X-Nova-Role named {attribution.role!r}",
            )
        # Metered under the role even when the caller sent no header.
        attribution = replace(attribution, role=routing.DECISIONS_ROLE)
        requested = body["model"] if isinstance(body.get("model"), str) and body["model"] else None
        pool = await db.get_pool()

        async def serve(decision: routing.Decision) -> Response:
            return await serve_systemone(
                request,
                pool,
                decision.row,
                decision.model,
                body,
                attribution,
                route=decision.as_route(),
            )

        return await walk_role(request, pool, routing.DECISIONS_ROLE, requested, attribution, serve)
    ```

- [ ] **Step 7: Run the tests to see them pass.**
  ```bash
  . "$SCRATCHPAD/decisions.env" && cd /home/jeremy/workspace/nova/.worktrees/decisions/services/gateway && TEST_DATABASE_URL="$GATEWAY_DB" uv run pytest -q tests/test_systemone_route.py tests/test_routing.py tests/test_data_plane.py tests/test_usage.py
  ```
  Expected: PASS — `test_routing.py` and `test_data_plane.py` unchanged: the chat walk is
  the same loop, moved.

- [ ] **Step 8: The whole gateway suite, lint, format, commit.**
  ```bash
  . "$SCRATCHPAD/decisions.env" && cd /home/jeremy/workspace/nova/.worktrees/decisions/services/gateway && TEST_DATABASE_URL="$GATEWAY_DB" uv run pytest -q 2>&1 | tail -3
  cd /home/jeremy/workspace/nova/.worktrees/decisions/services/gateway && uv run ruff check app tests && uv run ruff format app/adapters/systemone.py app/data_plane.py app/usage.py tests/fakes.py tests/test_systemone_route.py
  git -C /home/jeremy/workspace/nova/.worktrees/decisions add services/gateway/app/adapters/systemone.py services/gateway/app/data_plane.py services/gateway/app/usage.py services/gateway/tests/fakes.py services/gateway/tests/test_systemone_route.py
  git -C /home/jeremy/workspace/nova/.worktrees/decisions commit -m "feat(gateway): POST /v1/systemone — the decisions chain walked like chat's, metered under the role"
  git -C /home/jeremy/workspace/nova/.worktrees/decisions show --stat HEAD
  ```

---

### Task 4: The catalogue lists decision models, and never offers one as the chat model (gateway)

**Files:**
- Modify: `services/gateway/app/adapters/base.py:65-75` (`Listing.note`)
- Modify: `services/gateway/app/adapters/openai_chat.py:88-92` (`DECISIONS`), `:198-246`
  (`listing_capabilities`), `:328-349` (`list_models` asks for decision models)
- Modify: `services/gateway/app/catalog.py:250-298` (`cloud_row`), `:473-489` (the source's note)
- Modify: `services/gateway/app/admin.py:864` (the listing note on the row)
- Modify: `services/gateway/tests/fakes.py:410-471` (`FakeOpenAICompat` answers the decisions
  query and records query strings)
- Test: `services/gateway/tests/test_catalog_decisions.py` (create)

**Interfaces:**
- Consumes (Task 2): `systemone.normalize_models` rows carry `output_modalities: ["decisions"]`;
  providers carry `local`.
- Produces:
  - `Listing.note: str | None = None`; `Listing.as_dict()` includes `"note"` only when set
  - `openai_chat.DECISIONS = "decisions"`
  - `OpenAIChat._decision_models(app, row, url: str, listed: set[str]) -> tuple[list[dict], str | None]`
  - `listing_capabilities(row)` adds `suitability["decisions"]` (declared) for a row whose
    `output_modalities` lists `decisions`
  - catalogue rows: a decision row has `actions == []`; a row from a provider marked local
    has `kind == "local"` and `installed is True`
  - catalogue source entries carry `"note"` when the listing had one

- [ ] **Step 1: The fake lists decision models only when asked.** In
  `services/gateway/tests/fakes.py`, `FakeOpenAICompat` gains, after `systemone_usage`:
  ```python
      # OpenRouter lists its decision models (Jev, Kev-4B) only when asked for
      # them — GET /models?output_modalities=decisions; its default listing is
      # text models (checked live 2026-09-28). None: this provider ignores the
      # query and answers its one listing.
      decisions_models_body: dict | None = None
      decisions_models_status: int = 200
  ```
  and `_models` becomes:
  ```python
      async def _models(self, request):
          self._note(request)
          # The query as it arrived (None when there was none), so a test can
          # tell the decision-model listing from the default one.
          self.seen.append((request.url.path, dict(request.query_params) or None))
          if not self.models_public and not self._key_ok(request):
              return JSONResponse(
                  {"error": {"message": "Invalid API key"}}, status_code=self.models_wrong_key_status
              )
          if (
              request.query_params.get("output_modalities") == "decisions"
              and self.decisions_models_body is not None
          ):
              return JSONResponse(
                  self.decisions_models_body, status_code=self.decisions_models_status
              )
          return JSONResponse(self.models_body, status_code=self.models_status)
  ```

- [ ] **Step 2: Write the failing tests.** Create `services/gateway/tests/test_catalog_decisions.py`:

```python
"""Decision models in the catalogue (decision-role spec §3).

Pins: OpenRouter's decision models are fetched with ?output_modalities=
decisions — its default listing omits them — and only from a provider whose
listing speaks the modality vocabulary; each is declared a `decisions` model
with no chat suitability and NO action (never `use`, which writes chat.model);
a failed decision listing is a note on the source while the chat models still
list; a local decision server's models are local and installed, not cloud."""

from __future__ import annotations

import pytest

from app.adapters import openai_chat
from tests.conftest import requires_db
from tests.fakes import FakeOllama, FakeOpenAICompat

pytestmark = requires_db

CHAT_ROW = {
    "id": "openai/gpt-6-astra",
    "name": "OpenAI: GPT-6 Astra",
    "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
    "pricing": {"prompt": "0.00001", "completion": "0.00005"},
    "supported_parameters": ["tools"],
}
# OpenRouter's own row for Jev (GET /models?output_modalities=decisions, 2026-09-28).
JEV_ROW = {
    "id": "~typesafe/jev-latest",
    "name": "TypeSafe: Jev Latest",
    "context_length": 32000,
    "architecture": {
        "modality": "text->decisions",
        "input_modalities": ["text"],
        "output_modalities": ["decisions"],
    },
    "pricing": {"prompt": "0.000000042", "completion": "0"},
    "supported_parameters": [],
}


@pytest.fixture
def local(monkeypatch, mount_backend):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama()
    mount_backend("http://ollama.test", fake.app)
    return fake


async def _provider(client, mount_backend, name: str, **fake_over) -> FakeOpenAICompat:
    fake = FakeOpenAICompat(accepts_key="sk-1", **fake_over)
    mount_backend(f"http://{name}.test", fake.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": name,
            "adapter": "openai-chat",
            "base_url": f"http://{name}.test/v1",
            "auth_shape": "static-bearer",
            "api_key": "sk-1",
        },
    )
    assert resp.status_code == 200, resp.text
    return fake


def _rows(body: dict) -> dict[str, dict]:
    return {row["id"]: row for row in body["rows"]}


async def test_openrouters_decision_models_list_beside_its_chat_models_and_are_never_chat(
    client, local, mount_backend
):
    fake = await _provider(
        client,
        mount_backend,
        "openrouter",
        models_body={"object": "list", "data": [CHAT_ROW]},
        decisions_models_body={"object": "list", "data": [JEV_ROW]},
    )

    rows = _rows((await client.get("/admin/catalog")).json())

    jev = rows["openrouter:~typesafe/jev-latest"]
    assert jev["kind"] == "cloud"
    assert jev["actions"] == [], "a decision model is never offered as the chat model"
    assert jev["suitability"]["decisions"]["basis"] == "declared"
    assert "chat" not in jev["suitability"]
    assert rows["openrouter:openai/gpt-6-astra"]["actions"] == ["use"]
    assert ("/v1/models", {"output_modalities": "decisions"}) in fake.seen


async def test_a_listing_that_states_no_modalities_is_never_asked_for_decision_models(
    client, local, mount_backend
):
    fake = await _provider(
        client, mount_backend, "plain", models_body={"object": "list", "data": [{"id": "gpt-x"}]}
    )

    await client.get("/admin/catalog")

    queries = [query for path, query in fake.seen if path == "/v1/models"]
    assert queries, "the listing was read"
    assert all(query is None for query in queries), "never asked for a modality it never states"


async def test_a_decision_listing_that_fails_is_said_and_the_chat_models_still_list(
    client, local, mount_backend
):
    await _provider(
        client,
        mount_backend,
        "openrouter",
        models_body={"object": "list", "data": [CHAT_ROW]},
        decisions_models_body={"error": {"message": "upstream hiccup"}},
        decisions_models_status=500,
    )

    body = (await client.get("/admin/catalog")).json()

    source = {s["key"]: s for s in body["sources"]}["openrouter"]
    assert source["ok"] is True
    assert source["note"] == "its decision models could not be listed (500: upstream hiccup)"
    assert "openrouter:openai/gpt-6-astra" in _rows(body)
    assert "openrouter:~typesafe/jev-latest" not in _rows(body)


async def test_a_local_decision_server_lists_as_installed_on_the_owners_machine(
    client, local, mount_backend
):
    kev = FakeOpenAICompat(models_body={"models": [{"name": "kev-latest"}]})
    mount_backend("http://kev.test", kev.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "dell-kev",
            "adapter": "systemone",
            "base_url": "http://kev.test/v1",
            "auth_shape": "none",
            "local": True,
        },
    )
    assert resp.status_code == 200, resp.text

    row = _rows((await client.get("/admin/catalog")).json())["dell-kev:kev-latest"]

    assert (row["kind"], row["installed"], row["actions"]) == ("local", True, [])
    assert row["suitability"]["decisions"]["value"] is True


def test_a_decision_row_is_declared_a_decision_model_and_nothing_else():
    (row,) = openai_chat.normalize_models({"data": [JEV_ROW]}, owned_by="openrouter")
    capabilities, suitability = openai_chat.listing_capabilities(row)
    assert capabilities == {}
    assert suitability == {
        "decisions": {
            "value": True,
            "basis": "declared",
            "source": "provider-listing",
            "note": "the listing says it outputs decisions (a decision model)",
        }
    }
```

- [ ] **Step 3: Run them to see them fail.**
  ```bash
  . "$SCRATCHPAD/decisions.env" && cd /home/jeremy/workspace/nova/.worktrees/decisions/services/gateway && TEST_DATABASE_URL="$GATEWAY_DB" uv run pytest -q tests/test_catalog_decisions.py
  ```
  Expected: FAIL — `KeyError: 'openrouter:~typesafe/jev-latest'` (never asked for), the local
  row is `cloud`, and `suitability` has no `decisions`.

- [ ] **Step 4: A listing can carry a note.** `app/adapters/base.py`, `Listing` (`:65-75`):
  ```python
  @dataclass
  class Listing:
      """A live model list, always labelled with where and when it came from —
      never an unlabelled number (S10a's rail, adopted here). `note` says what
      the listing could NOT include, in words (a decision-model listing that
      failed) — a partial list is never passed off as a whole one."""

      source: str
      models: list[dict]
      fetched_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
      note: str | None = None

      def as_dict(self) -> dict:
          out = {"source": self.source, "fetched_at": self.fetched_at, "models": self.models}
          if self.note:
              out["note"] = self.note
          return out
  ```

- [ ] **Step 5: openai-chat asks for decision models, and declares them.** In
  `app/adapters/openai_chat.py`:
  - after `LISTING_SOURCE` (`:92`):
    ```python
    #: The output modality a decision model's row states (decision-role spec §3).
    DECISIONS = "decisions"
    ```
  - `listing_capabilities`: after the `chat` block (`:227-232`), before the benchmarks loop:
    ```python
        # A decision model answers typed questions (decision-role spec §3) — a
        # fact the row states, and the one thing it is suitable for.
        if isinstance(output_modalities, list) and DECISIONS in output_modalities:
            suitability["decisions"] = _listed(
                True, "the listing says it outputs decisions (a decision model)"
            )
    ```
  - `list_models` (`:349`), replace the `return` with:
    ```python
            models = normalize_models(body, owned_by=row["name"])
            note = None
            # (plan decision 14) Only a listing that speaks the modality vocabulary
            # can be asked for a modality; anything else is never asked.
            if any("output_modalities" in model for model in models):
                extra, note = await self._decision_models(
                    app, row, url, {model["id"] for model in models}
                )
                models.extend(extra)
            return Listing(source=row["name"], models=models, note=note)

        async def _decision_models(
            self, app, row: dict, url: str, listed: set[str]
        ) -> tuple[list[dict], str | None]:
            """The provider's DECISION models (decision-role spec §3). OpenRouter
            lists a model that outputs `decisions` — Jev, Kev-4B — only when asked
            for `?output_modalities=decisions`; its default listing is text
            models. A failure here is a NOTE on the listing, never a failed
            listing and never silence: the chat models it did list are still
            true, and the page says the decision models are missing."""
            client = http_client(app, MODELS_TIMEOUT, base_url=url, headers=self.headers(row))
            try:
                async with client as c:
                    resp = await c.get("/models", params={"output_modalities": DECISIONS})
            except httpx.HTTPError as exc:
                return [], f"its decision models could not be listed — {reason(exc)}"
            if resp.status_code != 200:
                return [], (
                    f"its decision models could not be listed "
                    f"({resp.status_code}: {refusal_detail(resp)})"
                )
            try:
                rows = normalize_models(resp.json(), owned_by=row["name"])
            except (ValueError, ProviderRefused) as exc:
                return [], f"its decision-model listing was unreadable — {exc}"
            return [
                model
                for model in rows
                if model["id"] not in listed and DECISIONS in (model.get("output_modalities") or [])
            ], None
    ```

- [ ] **Step 6: The catalogue.** In `app/catalog.py`, `cloud_row` (`:294-298`), replace the
  last lines with:
  ```python
      coding = _coding_inferred(model_id)
      if coding:
          _put_suitability(row["suitability"], "coding", coding)
      # A decision model answers typed questions and has no chat (decision-role
      # spec §3): it is never offered as the chat model — `use` writes
      # chat.model — and its place is the decisions chain on Settings → Routing.
      row["actions"] = [] if "decisions" in row["suitability"] else ["use"]
      # A provider the owner marked local — a Kev box on his own machine — lists
      # models that run THERE: its own listing says it serves them, so they are
      # installed, and they are not cloud rows.
      if provider_row.get("local"):
          row["kind"] = "local"
          row["installed"] = True
      return row
  ```
  and in `build.one` (`:485-489`):
  ```python
          source = {"key": name, "ok": True, "rows": len(listing.models)}
          source["fetched_at"] = listing.fetched_at
          if listing.note:
              source["note"] = listing.note
          return source, [cloud_row(provider_row, m, listing.fetched_at) for m in listing.models]
  ```
  In `app/admin.py`, `_listing_for` (`:864`):
  ```python
      said = f"{len(listing.models)} models listed"
      if listing.note:
          said = f"{said}; {listing.note}"
      await providers.record_listing(pool, name, "available", said)
  ```

- [ ] **Step 7: Run the tests to see them pass.**
  ```bash
  . "$SCRATCHPAD/decisions.env" && cd /home/jeremy/workspace/nova/.worktrees/decisions/services/gateway && TEST_DATABASE_URL="$GATEWAY_DB" uv run pytest -q tests/test_catalog_decisions.py tests/test_catalog.py tests/test_providers.py
  ```
  Expected: PASS. A test in `test_providers.py` or `test_catalog.py` that pinned how many
  times an OpenRouter-shaped listing (rows stating `architecture.output_modalities`) was
  read now sees one more `/models` read — the decision listing. That is this task working:
  update the count deliberately, and name the test in the commit body.

- [ ] **Step 8: The whole gateway suite, lint, format, commit.**
  ```bash
  . "$SCRATCHPAD/decisions.env" && cd /home/jeremy/workspace/nova/.worktrees/decisions/services/gateway && TEST_DATABASE_URL="$GATEWAY_DB" uv run pytest -q 2>&1 | tail -3
  cd /home/jeremy/workspace/nova/.worktrees/decisions/services/gateway && uv run ruff check app tests && uv run ruff format app/adapters/base.py app/adapters/openai_chat.py app/catalog.py app/admin.py tests/fakes.py tests/test_catalog_decisions.py
  git -C /home/jeremy/workspace/nova/.worktrees/decisions add services/gateway/app/adapters/base.py services/gateway/app/adapters/openai_chat.py services/gateway/app/catalog.py services/gateway/app/admin.py services/gateway/tests/fakes.py services/gateway/tests/test_catalog_decisions.py
  git -C /home/jeremy/workspace/nova/.worktrees/decisions commit -m "feat(gateway): the catalogue lists decision models, and never offers one as the chat model"
  git -C /home/jeremy/workspace/nova/.worktrees/decisions show --stat HEAD
  ```

---

### Task 5: The Jev Router switch — an edit to a role's chain, the link it replaced kept (gateway)

**Files:**
- Create: `services/gateway/migrations/011_router_switch.sql`
- Modify: `services/gateway/app/routing.py` (imports; after `delete_chain` `:165-169`, the
  switch; `set_chain` forgets the kept link when the router link goes; `__all__`)
- Modify: `services/gateway/app/admin.py:1016-1053` (routes page `router`; new
  `PUT /admin/routes/{role}/jev-router` after `put_route`)
- Modify (pins): `services/gateway/tests/test_routing.py:479-483` (the derived roles' dicts)
- Test: `services/gateway/tests/test_jev_router_switch.py` (create)

**Interfaces:**
- Consumes (Task 1): `routing._clean_chain`, `routing.protocol_of`, `routing._provider_of`.
- Produces:
  - `routing.JEV_ROUTER_MODEL = "typesafe/jev-router"`, `routing.ROUTER_BUILTINS = ("chat", "scheduled")`
  - `routing.router_switchable(role: str) -> bool`
  - `routing.router_link(chain: Sequence[str], names: set[str]) -> str | None`
  - `routing.router_state(chain: Sequence[str], names: set[str], kept: str | None) -> dict` → `{"on": bool, "kept": str | None}`
  - `routing.router_kept(pool) -> dict[str, str | None]`
  - `routing.set_router(pool, role: str, on: bool, link: object, by_name: dict[str, dict]) -> dict`
    → `{"role", "chain": list[str], "router": {"on", "kept"}}`; `ValueError` with the reason
  - `PUT /admin/routes/{role}/jev-router` with `{"on": bool, "link"?: "<provider>:typesafe/jev-router"}`
    → that dict, or `400 {"error": reason}`
  - `GET /admin/routes` role entries gain `"router": {"on", "kept"} | None` (None where the
    switch is not offered)
  - column `routes.router_kept text` — NULL off; `''` on with nothing replaced; else the
    replaced link

- [ ] **Step 1: Write the failing tests.** Create `services/gateway/tests/test_jev_router_switch.py`:

```python
"""The Jev Router switch (decision-role spec §4): an edit to a role's chain.

Pins: ON puts `openrouter:typesafe/jev-router` in place of the FIRST cloud
link and keeps that link; OFF puts it back exactly; a chain with only local
links gets the router after them, and OFF removes it; the state is DERIVED
from the chain, so a hand edit that drops the router turns the switch off and
forgets the kept link; ON twice is one switch; the switch is refused, in
words, where it cannot apply; the routes page says where it applies."""

from __future__ import annotations

import pytest

from app import backends, engines
from tests.conftest import requires_db
from tests.fakes import FakeOllama, FakeOpenAICompat

pytestmark = requires_db

ROUTER = "openrouter:typesafe/jev-router"
PICKED = "openrouter:anthropic/claude-x"


@pytest.fixture
async def world(client, pool, monkeypatch, mount_backend):
    """The bundled engine and two cloud providers: openrouter (which lists
    Jev Router) and cerebras."""
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    hub = FakeOllama(tags=("qwen3:8b",))
    mount_backend("http://ollama.test", hub.app)
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:8b"})
    engines.clear_cache()
    for name in ("openrouter", "cerebras"):
        fake = FakeOpenAICompat(accepts_key="sk-1")
        mount_backend(f"http://{name}.test", fake.app)
        resp = await client.post(
            "/admin/providers",
            json={
                "name": name,
                "adapter": "openai-chat",
                "base_url": f"http://{name}.test/v1",
                "auth_shape": "static-bearer",
                "api_key": "sk-1",
            },
        )
        assert resp.status_code == 200, resp.text


async def _switch(client, role: str, on: bool, link: str = ROUTER):
    return await client.put(
        f"/admin/routes/{role}/jev-router", json={"on": on, "link": link} if on else {"on": on}
    )


async def _roles(client) -> dict[str, dict]:
    return {r["role"]: r for r in (await client.get("/admin/routes")).json()["roles"]}


async def test_on_takes_the_first_cloud_links_place_and_off_puts_it_back(client, pool, world):
    await client.put(
        "/admin/routes/chat", json={"chain": ["hub:qwen3:8b", PICKED, "cerebras:llama"]}
    )

    on = await _switch(client, "chat", True)

    assert on.status_code == 200, on.text
    assert on.json() == {
        "role": "chat",
        "chain": ["hub:qwen3:8b", ROUTER, "cerebras:llama"],
        "router": {"on": True, "kept": PICKED},
    }
    assert (await _roles(client))["chat"]["router"] == {"on": True, "kept": PICKED}

    off = await _switch(client, "chat", False)

    assert off.json() == {
        "role": "chat",
        "chain": ["hub:qwen3:8b", PICKED, "cerebras:llama"],
        "router": {"on": False, "kept": None},
    }


async def test_over_only_local_links_the_router_goes_after_them_and_off_removes_it(
    client, pool, world
):
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:8b"]})

    on = (await _switch(client, "chat", True)).json()
    assert on["chain"] == ["hub:qwen3:8b", ROUTER]
    assert on["router"] == {"on": True, "kept": ""}

    off = (await _switch(client, "chat", False)).json()
    assert off["chain"] == ["hub:qwen3:8b"] and off["router"] == {"on": False, "kept": None}


async def test_a_hand_edit_that_drops_the_router_turns_it_off_and_forgets_the_kept_link(
    client, pool, world
):
    """Review focus 5. The owner removes the router link in the chain editor
    and later flips the switch off: nothing stale comes back, nothing doubles."""
    await client.put("/admin/routes/chat", json={"chain": [PICKED]})
    await _switch(client, "chat", True)

    await client.put("/admin/routes/chat", json={"chain": ["cerebras:llama"]})

    assert (await _roles(client))["chat"]["router"] == {"on": False, "kept": None}
    assert await pool.fetchval("SELECT router_kept FROM routes WHERE role = 'chat'") is None
    off = await _switch(client, "chat", False)
    assert off.status_code == 200
    assert off.json() == {
        "role": "chat",
        "chain": ["cerebras:llama"],
        "router": {"on": False, "kept": None},
    }


async def test_switching_on_twice_is_one_switch(client, pool, world):
    await client.put("/admin/routes/scheduled", json={"chain": [PICKED]})

    await _switch(client, "scheduled", True)
    again = (await _switch(client, "scheduled", True)).json()

    assert again["chain"] == [ROUTER]
    assert again["router"] == {"on": True, "kept": PICKED}


async def test_the_switch_is_refused_in_words_where_it_cannot_apply(client, pool, world):
    for role in ("decisions", "judge", "coding"):
        resp = await _switch(client, role, True)
        assert resp.status_code == 400
        assert resp.json()["error"] == (
            f"the Jev Router switch is for the chat, scheduled and agent roles — not {role}"
        )
    empty = await _switch(client, "scheduled", True)
    assert empty.status_code == 400
    assert empty.json()["error"] == (
        "scheduled has no chain of its own — it walks the chat chain; switch Jev Router on "
        "for chat, or give scheduled its own chain first"
    )
    nolink = await client.put("/admin/routes/chat/jev-router", json={"on": True})
    assert nolink.status_code == 400
    assert nolink.json()["error"] == (
        "link is required to switch Jev Router on — the provider:model that serves "
        "typesafe/jev-router"
    )
    wrong = await _switch(client, "chat", True, link=PICKED)
    assert wrong.status_code == 400
    assert wrong.json()["error"] == (
        f"{PICKED!r} is not Jev Router — the link must be <provider>:typesafe/jev-router "
        "on a registered provider"
    )
    garbled = await client.put("/admin/routes/chat/jev-router", json={"on": "yes"})
    assert garbled.status_code == 400
    assert garbled.json()["error"] == "on (true or false) is required"


async def test_the_routes_page_says_where_the_switch_applies(client, pool, world):
    await client.put("/admin/routes/agent_coder", json={"chain": ["cerebras:llama"]})

    roles = await _roles(client)

    for role in ("chat", "scheduled", "agent_coder"):
        assert roles[role]["router"] == {"on": False, "kept": None}, role
    for role in ("judge", "decisions", "coding", "vision"):
        assert roles[role]["router"] is None, role
```

  And the pin in `services/gateway/tests/test_routing.py` (`:479-483`, as Task 1 left it):
  each derived role's dict gains `"router": {"on": False, "kept": None},` after `"protocol"`.

- [ ] **Step 2: Run them to see them fail.**
  ```bash
  . "$SCRATCHPAD/decisions.env" && cd /home/jeremy/workspace/nova/.worktrees/decisions/services/gateway && TEST_DATABASE_URL="$GATEWAY_DB" uv run pytest -q tests/test_jev_router_switch.py tests/test_routing.py
  ```
  Expected: FAIL — 404 on `/admin/routes/chat/jev-router`, and no `router` key on the page.

- [ ] **Step 3: The migration.** `ls services/gateway/migrations/` — 010 is now the last.
  Create `services/gateway/migrations/011_router_switch.sql`:
  ```sql
  -- The Jev Router switch (docs/plans/rebuild/decision-role/spec.md §4): an edit
  -- to a role's chain, which stays the one source of truth. Whether the switch
  -- is ON is read off the chain itself (a `typesafe/jev-router` link in it) —
  -- never stored. What is stored is the one thing the chain cannot say after
  -- the edit: the cloud link the router replaced, so switching off puts it back.
  --
  --   NULL  the switch is off (or the router link was removed by hand)
  --   ''    on, and it replaced nothing (it was added after the local links)
  --   text  on, in place of this link
  ALTER TABLE routes ADD COLUMN IF NOT EXISTS router_kept text;
  ```

- [ ] **Step 4: The switch in `app/routing.py`.** Imports gain
  `from collections.abc import Sequence`. After `delete_chain` (`:165-169`):
  ```python
  # ── the Jev Router switch (decision-role spec §4) ─────────────────────────

  #: Jev Router on OpenRouter: it picks a model and reasoning effort for each
  #: request, and the owner pays for the model it picks. Its listing states no
  #: parameters (checked 2026-09-28), so there is no quality-first setting to set.
  JEV_ROUTER_MODEL = "typesafe/jev-router"
  #: (plan decision 18) The chat-kind roles the switch is offered on — the spec's
  #: "(chat, scheduled, agents)". Not judge (a one-word verdict), never a
  #: systemone role (it has no cloud chat link), never a reserved one.
  ROUTER_BUILTINS = ("chat", "scheduled")


  def router_switchable(role: str) -> bool:
      """Is the switch offered on this role? chat, scheduled, and every agent's
      derived role (the non-built-ins)."""
      return role in ROUTER_BUILTINS or role not in BUILTIN_ROLES


  def router_link(chain: Sequence[str], names: set[str]) -> str | None:
      """The chain's Jev Router link, if it holds one. The switch's on/off IS
      this — derived from the chain, never a flag stored beside it."""
      for link in chain:
          _provider, model = providers.split_model_id(link, names)
          if model == JEV_ROUTER_MODEL:
              return link
      return None


  def router_state(chain: Sequence[str], names: set[str], kept: str | None) -> dict:
      """What the routes page says of the switch on one role."""
      on = router_link(chain, names) is not None
      return {"on": on, "kept": kept if on else None}


  async def router_kept(pool: asyncpg.Pool) -> dict[str, str | None]:
      rows = await pool.fetch("SELECT role, router_kept FROM routes")
      return {r["role"]: r["router_kept"] for r in rows}


  def _is_cloud(link: str, by_name: dict[str, dict]) -> bool:
      provider_name, _model = _provider_of(link, by_name)
      row = by_name.get(provider_name) if provider_name else None
      return row is not None and not row.get("local")


  async def _store_route(
      pool: asyncpg.Pool, role: str, chain: list[str], kept: str | None
  ) -> None:
      await pool.execute(
          "INSERT INTO routes (role, chain, router_kept) VALUES ($1, $2::jsonb, $3) "
          "ON CONFLICT (role) DO UPDATE SET chain = EXCLUDED.chain, "
          "router_kept = EXCLUDED.router_kept, updated_at = now()",
          role,
          json.dumps(chain),
          kept,
      )


  async def set_router(
      pool: asyncpg.Pool, role: str, on: bool, link: object, by_name: dict[str, dict]
  ) -> dict:
      """Switch Jev Router on or off for `role` — an EDIT to the role's chain,
      which stays the one source of truth (decision-role spec §4).

      ON puts `link` (`<provider>:typesafe/jev-router`) in place of the FIRST
      cloud link of the role's stored chain and keeps the replaced link in
      routes.router_kept; a chain with no cloud link gets the router after its
      local links (kept ''). Local links are never touched, so local first still
      holds — and chat's link 1, chat.model, is not in the stored chain at all.
      OFF puts the kept link back where the router was, or removes the router
      when it replaced nothing. Asking for the state it is already in changes
      nothing. Refused, in words (ValueError), where it cannot apply: a role
      the switch is not offered on, a link that is not Jev Router, and a
      non-chat role with no chain of its own — it walks chat's, and a
      one-link chain would silently stop it walking chat's local links (plan
      decision 17)."""
      validate_role(role)
      if not router_switchable(role):
          raise ValueError(
              f"the Jev Router switch is for the chat, scheduled and agent roles — not {role}"
          )
      names = set(by_name)
      row = await pool.fetchrow("SELECT chain, router_kept FROM routes WHERE role = $1", role)
      chain = list(json.loads(row["chain"])) if row else []
      kept = row["router_kept"] if row else None
      present = router_link(chain, names)
      if not on:
          if present is None:
              if kept is not None:
                  await _store_route(pool, role, chain, None)
              return {"role": role, "chain": chain, "router": {"on": False, "kept": None}}
          if kept and kept not in chain:
              chain[chain.index(present)] = kept
          else:
              chain.remove(present)
          cleaned = _clean_chain(role, chain, by_name)
          await _store_route(pool, role, cleaned, None)
          return {"role": role, "chain": cleaned, "router": {"on": False, "kept": None}}
      if present is not None:
          return {"role": role, "chain": chain, "router": {"on": True, "kept": kept}}
      if not isinstance(link, str) or not link.strip():
          raise ValueError(
              "link is required to switch Jev Router on — the provider:model that serves "
              f"{JEV_ROUTER_MODEL}"
          )
      link = link.strip()
      provider_name, model = providers.split_model_id(link, names)
      if provider_name is None or model != JEV_ROUTER_MODEL:
          raise ValueError(
              f"{link!r} is not Jev Router — the link must be <provider>:{JEV_ROUTER_MODEL} "
              "on a registered provider"
          )
      if not chain and role != "chat":
          raise ValueError(
              f"{role} has no chain of its own — it walks the chat chain; switch Jev Router "
              f"on for chat, or give {role} its own chain first"
          )
      index = next((i for i, item in enumerate(chain) if _is_cloud(item, by_name)), None)
      if index is None:
          kept = ""
          chain.append(link)
      else:
          kept = chain[index]
          chain[index] = link
      cleaned = _clean_chain(role, chain, by_name)
      await _store_route(pool, role, cleaned, kept)
      return {"role": role, "chain": cleaned, "router": {"on": True, "kept": kept}}
  ```
  `set_chain`'s statement becomes (a hand edit is the chain speaking — plan decision 16):
  ```python
      keeps_router = router_link(cleaned, set(by_name)) is not None
      await pool.execute(
          "INSERT INTO routes (role, chain) VALUES ($1, $2::jsonb) "
          "ON CONFLICT (role) DO UPDATE SET chain = EXCLUDED.chain, "
          # An edit that removes the Jev Router link turns the switch off, and
          # the link it kept is forgotten: nothing stale can come back later.
          "router_kept = CASE WHEN $3 THEN routes.router_kept ELSE NULL END, "
          "updated_at = now()",
          role,
          json.dumps(cleaned),
          keeps_router,
      )
  ```
  and `__all__` gains `"JEV_ROUTER_MODEL"`, `"router_state"`, `"router_switchable"`,
  `"set_router"`.

- [ ] **Step 5: The admin plane.** In `app/admin.py`, `get_routes` (`:1016-1036`):
  ```python
      pool = await db.get_pool()
      chains = await routing.chains(pool)
      walled = await routing.walls(pool)
      kept = await routing.router_kept(pool)
      names = {r["name"] for r in await providers.list_rows(pool)}
      derived = sorted(role for role in chains if role not in routing.BUILTIN_ROLES)
      return {
          "roles": [
              {
                  "role": role,
                  "chain": chains.get(role, []),
                  "reserved": role in routing.RESERVED_ROLES,
                  "builtin": role in routing.BUILTIN_ROLES,
                  "protocol": routing.protocol_of(role),
                  # The Jev Router switch (decision-role spec §4): its state,
                  # DERIVED from the chain; None where it is not offered.
                  "router": routing.router_state(chains.get(role, []), names, kept.get(role))
                  if routing.router_switchable(role)
                  else None,
              }
              for role in (*routing.BUILTIN_ROLES, *derived)
          ],
          "walls": [{**w, "walled_until": w["walled_until"].isoformat()} for w in walled.values()],
      }
  ```
  and after `put_route`:
  ```python
  @router.put("/routes/{role}/jev-router")
  async def put_jev_router(role: str, request: Request) -> dict:
      """{on: bool, link?: <provider>:typesafe/jev-router} — the Jev Router
      switch (decision-role spec §4), an edit to the role's chain. The link is
      the caller's, read from the live catalogue; the refusals are
      routing.set_router's own words."""
      body = await request.json() if await request.body() else {}
      if not isinstance(body, dict) or not isinstance(body.get("on"), bool):
          raise HTTPException(status_code=400, detail="on (true or false) is required")
      pool = await db.get_pool()
      by_name = {r["name"]: r for r in await providers.list_rows(pool)}
      try:
          result = await routing.set_router(pool, role, body["on"], body.get("link"), by_name)
      except ValueError as exc:
          raise HTTPException(status_code=400, detail=str(exc)) from exc
      logger.info("jev router %s: %s", role, result["router"])
      return result
  ```

- [ ] **Step 6: Run the tests to see them pass.**
  ```bash
  . "$SCRATCHPAD/decisions.env" && cd /home/jeremy/workspace/nova/.worktrees/decisions/services/gateway && TEST_DATABASE_URL="$GATEWAY_DB" uv run pytest -q tests/test_jev_router_switch.py tests/test_routing.py tests/test_decisions_role.py
  ```
  Expected: PASS.

- [ ] **Step 7: The whole gateway suite, lint, format, commit.**
  ```bash
  . "$SCRATCHPAD/decisions.env" && cd /home/jeremy/workspace/nova/.worktrees/decisions/services/gateway && TEST_DATABASE_URL="$GATEWAY_DB" uv run pytest -q 2>&1 | tail -3
  cd /home/jeremy/workspace/nova/.worktrees/decisions/services/gateway && uv run ruff check app tests && uv run ruff format app/routing.py app/admin.py tests/test_jev_router_switch.py tests/test_routing.py
  git -C /home/jeremy/workspace/nova/.worktrees/decisions add services/gateway/migrations/011_router_switch.sql services/gateway/app/routing.py services/gateway/app/admin.py services/gateway/tests/test_jev_router_switch.py services/gateway/tests/test_routing.py
  git -C /home/jeremy/workspace/nova/.worktrees/decisions commit -m "feat(gateway): the Jev Router switch — an edit to a role's chain, the replaced link kept"
  git -C /home/jeremy/workspace/nova/.worktrees/decisions show --stat HEAD
  ```
  The commit body says why the routes-page dicts moved again (every role now states the
  switch's state, or None where it is not offered).

---

### Task 6: What the turn needs from recall and the prompt — note paths, the set-aside sentence, the hint's place (core)

**Files:**
- Modify: `services/core/app/chat.py:997-1043` (`Recalled` gains `paths`, `set_aside`),
  after `:1043` (`_with_notes_kept`), `:1072-1081` (`volatile_system_prompt`), `:1117-1145`
  (`base_messages` gains `hint`), after `:1354` (`_note_paths`), `:1980-2056` (`_recall`
  fills `paths`)
- Test: `services/core/tests/test_chat_decision_prompt.py` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `Recalled.paths: tuple[str, ...] = ()` — one per note, same order, `""` when memory
    named no path
  - `Recalled.set_aside: str | None = None`
  - `chat._note_paths(results: Iterable) -> list[str]`
  - `chat._with_notes_kept(recalled: Recalled, keep: Sequence[int] | None) -> Recalled`
  - `chat.base_messages(model, recall, history, message, persona=None, roster=None, skills_roster=None, hint: str | None = None) -> list[dict]`

- [ ] **Step 1: Write the failing tests.** Create `services/core/tests/test_chat_decision_prompt.py`:

```python
"""What the decision role needs from recall and the prompt (decision-role spec §2).

Pins: every recalled note carries its path, aligned one-for-one with the note
text (the span records verdicts by path, never by text); a recall whose notes
are narrowed keeps each note's path beside it, and one whose EVERY note was
set aside says so in her prompt — never reads as a search that found nothing;
the hint line sits immediately before his message, and a turn with no hint is
byte-for-byte the turn it was."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from app import chat, traces
from app.identity import Person
from app.main import app
from tests.fakes import FakeMemory

HITS = [
    {"path": "people/o/journals/2026-09-15.md", "snippet": "sideload it with TestFlight"},
    {"title": "Coffee", "snippet": "pour-over, no sugar"},
    "a bare string hit",
    {"path": "people/o/topics/empty.md"},  # no body: the label is the note
    {"snippet": ""},  # nothing at all: no note
    42,  # not a hit
]
HINT = (
    "A decision model reads the owner's message as needing your tool show_setup_qr "
    "(fit 0.85). Use it if it fits."
)


def test_every_note_has_its_path_in_the_same_order():
    notes = chat._snippets(HITS)
    paths = chat._note_paths(HITS)
    assert len(paths) == len(notes) == 4
    assert paths == ["people/o/journals/2026-09-15.md", "Coffee", "", "people/o/topics/empty.md"]


async def test_recall_carries_each_notes_path(mount_peers):
    mount_peers(memory=FakeMemory(results=tuple(HITS[:3])))
    turn = traces.Turn(id=uuid.uuid4(), started_at=datetime.now(UTC))
    person = Person(id=uuid.uuid4(), name="jeremy", role="owner")

    recalled = await chat._recall(app, turn, person, "how do I get you on my phone")

    assert len(recalled.notes) == 3
    assert recalled.paths == ("people/o/journals/2026-09-15.md", "Coffee", "")


def test_narrowed_notes_keep_their_paths_and_none_leaves_the_recall_as_it_was():
    recalled = chat.Recalled(notes=("a", "b", "c"), paths=("p/a.md", "p/b.md", "p/c.md"))

    assert chat._with_notes_kept(recalled, None) is recalled
    kept = chat._with_notes_kept(recalled, (0, 2))
    assert kept.notes == ("a", "c") and kept.paths == ("p/a.md", "p/c.md")
    assert kept.set_aside is None


def test_a_recall_whose_every_note_was_set_aside_says_so_in_her_prompt():
    """Review focus 4: an empty block reads like a search that found nothing —
    and this one found two notes, which a decision model set aside."""
    recalled = chat.Recalled(notes=("a", "b"), paths=("p/a.md", "p/b.md"))

    kept = chat._with_notes_kept(recalled, ())

    assert kept.notes == () and kept.paths == ()
    prompt = chat.volatile_system_prompt(kept)
    assert prompt is not None
    assert (
        "Her memory was searched for this turn; a decision model set aside all 2 notes it "
        "returned as unrelated to this message or superseded by what she can do now."
    ) in prompt
    assert "returned nothing" not in prompt


def test_the_hint_sits_immediately_before_his_message_and_changes_nothing_else():
    recall = chat.Recalled(notes=("Kitchen: the kettle is new",))
    history = [
        {"role": "user", "content": "earlier"},
        {"role": "assistant", "content": "a reply"},
    ]
    message = "How do I get you on my phone"

    plain = chat.base_messages("qwen3:8b", recall, history, message)
    hinted = chat.base_messages("qwen3:8b", recall, history, message, hint=HINT)

    assert hinted[:-2] == plain[:-1], "the cached prefix is the same bytes"
    assert hinted[-2] == {"role": "system", "content": HINT}
    assert hinted[-1] == plain[-1] == {"role": "user", "content": message}
    assert chat.base_messages("qwen3:8b", recall, history, message, hint=None) == plain
```

- [ ] **Step 2: Run them to see them fail.**
  ```bash
  . "$SCRATCHPAD/decisions.env" && cd /home/jeremy/workspace/nova/.worktrees/decisions/services/core && TEST_DATABASE_URL="$CORE_DB" uv run pytest -q tests/test_chat_decision_prompt.py
  ```
  Expected: FAIL — `AttributeError: module 'app.chat' has no attribute '_note_paths'`.

  (`hinted[:-2] == plain[:-1]` compares the two system messages and the history; the
  volatile block's "Current time:" is written by the same call pair within a second, so
  if this ever straddles a second boundary, it is the clock, not the hint — re-run once.)

- [ ] **Step 3: `Recalled` gains two fields.** In `app/chat.py`, after `live` (`:1042`):
  ```python
      # WHICH note each of `notes` is, by path, in the same order — "" for one
      # memory named no path for (recalled_sources' rule: paths, never bodies).
      # The decision role records its per-note verdicts by path (decisions.py,
      # decision-role spec §2) and must know which note is which.
      paths: tuple[str, ...] = ()
      # The decision role set aside EVERY note recall returned: its sentence,
      # said in place of the notes. Without it the prompt would read like a
      # search that found nothing, which is not what happened (plan decision 8).
      set_aside: str | None = None
  ```
  and after the class:
  ```python
  def _with_notes_kept(recalled: Recalled, keep: Sequence[int] | None) -> Recalled:
      """The recall after the decision role's check (decisions.py): only the
      notes at `keep`, each path beside its note. None leaves it untouched. When
      every note was set aside the prompt says so (`set_aside`) — an empty block
      would read as a search that came back empty."""
      if keep is None:
          return recalled
      notes = tuple(recalled.notes[i] for i in keep if i < len(recalled.notes))
      paths = tuple(recalled.paths[i] for i in keep if i < len(recalled.paths))
      if notes:
          return dataclasses.replace(recalled, notes=notes, paths=paths)
      count = len(recalled.notes)
      return dataclasses.replace(
          recalled,
          notes=(),
          paths=(),
          set_aside=(
              f"a decision model set aside all {count} note{'s' if count != 1 else ''} it "
              "returned as unrelated to this message or superseded by what she can do now"
          ),
      )
  ```

- [ ] **Step 4: The prompt.** `volatile_system_prompt` (`:1073-1081`), between the notes
  branch and the `empty` branch:
  ```python
      if recall.notes:
          notes = "\n".join(f"- {snippet}" for snippet in recall.notes)
          parts.append(f"{NOTES_HEADER}\n{notes}")
      elif recall.set_aside:
          # The decision role set every note aside (decisions.py). Said: this
          # search FOUND notes, which a decision model judged unrelated or out of
          # date — not the same fact as "nothing matched".
          parts.append(f"Her memory was searched for this turn; {recall.set_aside}.")
      elif recall.empty:
  ```
  `base_messages` (`:1117-1145`) gains `hint: str | None = None` as its last parameter, the
  docstring gains "`hint` (decision-role spec §2) is the decision role's one line: its own
  system message immediately before his message — the position measured at 3/3 — so the
  cached prefix (the system prompts and the history) is the same bytes with or without it.",
  and its tail becomes:
  ```python
      messages.extend(history)
      if hint:
          messages.append({"role": "system", "content": hint})
      messages.append({"role": "user", "content": message})
      return messages
  ```

- [ ] **Step 5: Recall fills the paths.** After `_snippets` (`:1354`):
  ```python
  def _note_paths(results: Iterable) -> list[str]:
      """The path of each note _snippets makes from the same hits — one per note,
      in the same order, "" for a hit memory named no path for. PATHS, never
      bodies (recalled_sources' rule): the decision role records WHICH note it
      set aside by this, never by its text (decision-role spec §2)."""
      paths: list[str] = []
      for hit in results:
          if not _snippets([hit]):
              continue
          named = recalled_sources([hit])
          paths.append(named[0] if named else "")
      return paths
  ```
  In `_recall` (`:1980-2056`):
  - beside `hits: dict[str, list[str]] = {}` (`:1980`):
    `note_paths: dict[str, list[str]] = {}`
  - in the failed-scope branch (`:1989-1993`): `note_paths[name] = []` beside `hits[name] = []`
  - in the answered branch (`:1995-1997`): `note_paths[name] = _note_paths(results)` beside
    `hits[name] = _snippets(results)`
  - `snippets = hits["own"]` (`:2015`) gains `paths = note_paths["own"]` beside it;
    the shared branch's `snippets = [...]` (`:2025`) gains
    `paths = [*note_paths["own"], *note_paths["shared"]]`
  - the notes return (`:2042-2047`) gains `paths=tuple(paths),` after `notes=tuple(snippets),`

- [ ] **Step 6: Run the tests to see them pass, and the suites that read recall and the prompt.**
  ```bash
  . "$SCRATCHPAD/decisions.env" && cd /home/jeremy/workspace/nova/.worktrees/decisions/services/core && TEST_DATABASE_URL="$CORE_DB" uv run pytest -q tests/test_chat_decision_prompt.py tests/test_chat.py tests/test_recall_sources.py tests/test_live_facts.py tests/test_chat_agents.py tests/test_eval_runner.py
  ```
  Expected: PASS — every existing prompt pin is unchanged (no hint, no set-aside, no
  change).

- [ ] **Step 7: Lint, format, commit.**
  ```bash
  cd /home/jeremy/workspace/nova/.worktrees/decisions/services/core && uv run ruff check app tests && uv run ruff format app/chat.py tests/test_chat_decision_prompt.py
  git -C /home/jeremy/workspace/nova/.worktrees/decisions add services/core/app/chat.py services/core/tests/test_chat_decision_prompt.py
  git -C /home/jeremy/workspace/nova/.worktrees/decisions commit -m "feat(core): recall names each note's path; the prompt can carry a hint and say notes were set aside"
  git -C /home/jeremy/workspace/nova/.worktrees/decisions show --stat HEAD
  ```
  (Every file this plan edits was format-clean on 2026-09-28 — `ruff format --check` said so
  — so formatting an edited file touches only your hunks. If `git show --stat` shows lines you
  did not write, someone's change landed unformatted: revert those and say so.)

---

### Task 7: `decisions.py` — the two questions, the budget, fail-open, the span (core)

**Files:**
- Create: `services/core/app/decisions.py`
- Modify: `services/core/tests/fakes.py:9-19` (imports), after `:139` (`NO_DECISION_MODEL`,
  `answer_decision`), `:177-294` (`FakeGateway` fields, route, handler), `:694-760`
  (`ScriptedGateway` the same)
- Test: `services/core/tests/test_decisions.py` (create; no database needed)

**Interfaces:**
- Consumes (Task 3): the gateway's `POST /v1/systemone` contract — request
  `{state, questions}` with `X-Nova-Role: decisions`; answer `{answers, usage: {cost_usd, …}}`
  with `X-Nova-Served-By` and `X-Nova-Route`; the empty-chain 503 words.
- Produces (`app/decisions.py`):
  - constants `ROLE = "decisions"`, `TURN_BUDGET_S = 5.0`, `FIT_MIN = GATE_MIN = 0.30`,
    `RELEVANT_MIN = 0.45`, `CONTRADICTS_MAX = SUPERSEDED_MAX = 0.70`, `SHORTLIST = 3`,
    `NOTE_CHARS = 3000`, `NONE = "none"`, `NONE_MEANS`, `DECIDED = "decided"`,
    `FAILED_OPEN = "failed_open"`
  - `class Unanswered(RuntimeError)`, `class Unreadable(ValueError)`
  - `@dataclass(frozen=True) Hint(tool: str, fit: float, gate: float)` with
    `.line() -> str` and `.as_meta() -> dict`
  - `@dataclass(frozen=True) NoteVerdict(path: str, relevant: float, contradicts: float, superseded: float)`
    with `.kept -> bool` and `.as_meta() -> dict`
  - `@dataclass(frozen=True) Advice(hint: Hint | None = None, keep: tuple[int, ...] | None = None)`
  - `tool_descriptions(advertised: Sequence[dict]) -> dict[str, str]`
  - `stage_one(descriptions: dict[str, str]) -> dict`, `stage_two(shortlist: Sequence[str], descriptions: dict[str, str]) -> dict`
  - `shortlist(probabilities: dict[str, float], descriptions: dict[str, str], k: int = SHORTLIST) -> list[str]`
  - `keep_note(relevant: float, contradicts: float, superseded: float) -> bool`
  - `request_body(state: str, questions: dict) -> dict` (the measurement's pin wraps this)
  - `read_noul(answers: dict, key: str) -> float`,
    `read_choice(answers: dict, key: str, options: Collection[str]) -> tuple[str, dict[str, float]]`
  - `async run(app, turn: traces.Turn, message: str, notes: Sequence[str], paths: Sequence[str], advertised: Sequence[dict]) -> Advice`
    — never raises; files exactly one `decisions` span whose meta holds `outcome`,
    `budget_s`, `calls`, `served_by` (list), and either `reason` (+ `reached`) or
    `shortlist`, `none_p`, `gate`, `pick`, `fits`, `hint`, and `notes_checked` +
    `notes` / `notes_unchecked`; `fell_back`, `cost_usd`, `priced_calls` when they apply.
- Produces (`tests/fakes.py`): `NO_DECISION_MODEL`; `answer_decision(...)`; on both
  `FakeGateway` and `ScriptedGateway`: `decision_answer: Callable[[dict], object] | None`,
  `decision_served_by: str`, `decision_hold: asyncio.Event | None`,
  `decision_calls: list[dict]` (each `{"body", "headers"}`).
- Produces (`tests/test_decisions.py`, imported by Task 8):
  `decider(*, tool="show_setup_qr", fit=0.85, gate=0.9, notes=None) -> Callable[[dict], dict]`

- [ ] **Step 1: The fakes answer the decision route.** In `services/core/tests/fakes.py`:
  - imports gain `from collections.abc import Callable`
  - after `_sse` (`:138-139`):
    ```python
    # POST /v1/systemone as the gateway answers it with an EMPTY decisions chain —
    # the state every install starts in (services/gateway/app/routing.py). The
    # gateway's words exactly, so a test reads what a real turn would.
    NO_DECISION_MODEL = (
        "no model in the 'decisions' chain can serve right now — the decisions chain is "
        "empty, so no decision model is set (add one in Settings → Routing)"
    )


    async def answer_decision(
        request,
        *,
        answer: Callable[[dict], object] | None,
        served_by: str,
        hold: asyncio.Event | None,
        calls: list[dict],
    ) -> Response:
        """The gateway's POST /v1/systemone (decision-role spec §1), for a fake:
        the body and headers recorded; 503 in the gateway's words with no
        decision model; else `answer(body)` — the answers object, or a Response
        sent as is — with the ledger's usage and the route headers."""
        raw = await request.body()
        body = json.loads(raw) if raw else {}
        calls.append({"body": body, "headers": {k.lower(): v for k, v in request.headers.items()}})
        if not _bearer_ok(request, GATEWAY_TOKEN):
            return JSONResponse({"error": "bad gateway bearer"}, status_code=401)
        if hold is not None:
            await hold.wait()
        if answer is None:
            return JSONResponse({"error": NO_DECISION_MODEL}, status_code=503)
        answers = answer(body)
        if isinstance(answers, Response):
            return answers
        return JSONResponse(
            {
                "model": served_by.partition(":")[2],
                "answers": answers,
                "usage": {
                    "prompt_tokens": 40,
                    "completion_tokens": 6,
                    "cost_usd": 1e-05,
                    "cost_basis": "provider-reported",
                    "local": False,
                    "metered": True,
                    "recorded": True,
                },
            },
            headers={"X-Nova-Served-By": served_by, "X-Nova-Route": "role=decisions;link=1"},
        )
    ```
  - `FakeGateway`, after `engine_put_sticks` (`:253`):
    ```python
        # The decision role (decision-role spec §2): POST /v1/systemone. With no
        # `decision_answer` it answers 503 in the gateway's words for an EMPTY
        # decisions chain — every install's first state — so every test turn
        # sees what a real turn with no decision model sees. `decision_answer`
        # returns the answers for a body (or a Response, sent as is);
        # `decision_hold` stalls the answer until it is set; every call lands in
        # `decision_calls`, apart from `seen`, so the completion and admin
        # traffic other tests count is unchanged by a turn's decision calls.
        decision_answer: Callable[[dict], object] | None = None
        decision_served_by: str = "openrouter:~typesafe/jev-latest"
        decision_hold: asyncio.Event | None = None
        decision_calls: list[dict] = field(default_factory=list)
    ```
    its routes gain `Route("/v1/systemone", self._systemone, methods=["POST"]),`, and after
    `_health`:
    ```python
        async def _systemone(self, request):
            return await answer_decision(
                request,
                answer=self.decision_answer,
                served_by=self.decision_served_by,
                hold=self.decision_hold,
                calls=self.decision_calls,
            )
    ```
  - `ScriptedGateway`: the same four fields after `chunk_delay_s`, the same `_systemone`
    method, and its routes become
    `[Route("/v1/chat/completions", self._completions, methods=["POST"]), Route("/v1/systemone", self._systemone, methods=["POST"])]`.

- [ ] **Step 2: Write the failing tests.** Create `services/core/tests/test_decisions.py`:

```python
"""decisions.py — the decision role's two questions (decision-role spec §2).

Pins, with no database: the options are exactly the tools the turn advertises,
each with its full registry description (a tool registered tomorrow is an
option by that fact alone), plus `none`; stage 2 asks about stage 1's top three,
quoting each full description; TypeSafe's thresholds, at their boundaries; an
answer of the wrong shape is unreadable, never guessed; the hint line is the
spec's sentence; the module cannot reach the dispatch funnel. And through a fake
gateway: a decision hints the tool and sets aside the superseded note, recording
paths and never note text; every call walks the decisions role under the turn's
attribution and names no model; no decision model, the budget, an unreadable
answer and a failed note check each leave nothing applied and say why; with no
hint the notes stand unasked."""

from __future__ import annotations

import ast
import asyncio
import json
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest
from starlette.responses import Response

from app import decisions, tools, traces
from app.main import app
from app.tools.base import Tool
from tests.fakes import FakeGateway

SETUP = "show_setup_qr"
PHONE = "How do I get you on my phone"
NOTES = (
    "[journal, 12 days ago] people/o/journals/2026-09-15.md: sideload the app through TestFlight",
    "people/o/topics/phone.md: his phone is an iPhone 16",
)
PATHS = ("people/o/journals/2026-09-15.md", "people/o/topics/phone.md")


def decider(
    *,
    tool: str = SETUP,
    fit: float = 0.85,
    gate: float = 0.9,
    notes: dict[str, tuple[float, float, float]] | None = None,
):
    """A fake decision model with Jev's answer shapes (TypeSafe's): stage 1
    ranks `tool` first among whatever options it is sent, with gate `gate`;
    stage 2 picks it with fit `fit` (every other candidate 0.1); a note check
    answers (relevant, contradicts, superseded) from the first key of `notes`
    found in the note's text — (0.9, 0.0, 0.0) when none is."""

    def answer(body: dict) -> dict:
        questions = body["questions"]
        if "tool" in questions:
            options = list(questions["tool"]["criteria"])
            rest = 0.4 / max(1, len(options) - 1)
            return {
                "tool": {
                    "type": "choice",
                    "choice": tool,
                    "confidence": 0.55,
                    "probabilities": {name: 0.6 if name == tool else rest for name in options},
                },
                "acts": {"type": "noul", "noul": gate},
            }
        if "pick" in questions:
            short = list(questions["pick"]["criteria"])
            out: dict = {
                "pick": {
                    "type": "choice",
                    "choice": tool,
                    "confidence": 0.7,
                    "probabilities": {name: 0.8 if name == tool else 0.1 for name in short},
                }
            }
            for index, name in enumerate(short):
                out[f"fit{index}"] = {"type": "noul", "noul": fit if name == tool else 0.1}
            return out
        note = json.loads(body["state"])["recalled_note"]
        scores = next(
            (value for key, value in (notes or {}).items() if key in note), (0.9, 0.0, 0.0)
        )
        return {
            key: {"type": "noul", "noul": score}
            for key, score in zip(("relevant", "contradicts", "superseded"), scores, strict=True)
        }

    return answer


def _turn(kind: str = "chat") -> traces.Turn:
    return traces.Turn(
        id=uuid.uuid4(), started_at=datetime.now(UTC), kind=kind, person_id=uuid.uuid4()
    )


def _span(turn: traces.Turn) -> traces.Span:
    (span,) = [s for s in turn.spans if s.kind == "decisions"]
    return span


# -- the questions: derived from what the turn advertises -------------------


def test_stage_one_offers_every_advertised_tool_with_its_full_description_and_none():
    questions = decisions.stage_one(decisions.tool_descriptions(tools.advertised_tools()))

    criteria = questions["tool"]["criteria"]
    assert list(criteria) == [*tools.tool_names(), "none"]
    assert criteria[SETUP] == tools.REGISTRY[SETUP].description
    assert criteria["none"] == decisions.NONE_MEANS
    assert questions["acts"] == {
        "type": "noul",
        "instructions": "Does answering the owner's message require Nova to do, show or look "
        "up something, rather than only talk?",
    }


def test_a_tool_registered_tomorrow_is_an_option_by_that_fact_alone(monkeypatch):
    async def water(args: dict, ctx) -> str:
        return "watered"

    monkeypatch.setitem(
        tools.REGISTRY,
        "water_plants",
        Tool(
            name="water_plants",
            description="Waters the plants on the balcony.",
            parameters={"type": "object", "properties": {}, "additionalProperties": False},
            executor=water,
        ),
    )

    criteria = decisions.stage_one(decisions.tool_descriptions(tools.advertised_tools()))
    assert criteria["tool"]["criteria"]["water_plants"] == "Waters the plants on the balcony."


def test_stage_two_asks_about_the_shortlist_quoting_each_full_description():
    questions = decisions.stage_two(["b", "a"], {"a": "does A", "b": "does B", "c": "does C"})

    assert set(questions) == {"pick", "fit0", "fit1"}
    assert questions["pick"]["criteria"] == {"b": "does B", "a": "does A"}
    assert questions["fit0"]["instructions"] == (
        "Does the tool 'b' do the specific thing the owner's message asks for? "
        "It is described as: does B"
    )


def test_the_shortlist_is_the_top_three_tools_and_never_none():
    probabilities = {"none": 0.5, "a": 0.1, "b": 0.2, "c": 0.05, "d": 0.15}
    descriptions = {"a": "", "b": "", "c": "", "d": ""}
    assert decisions.shortlist(probabilities, descriptions) == ["b", "d", "a"]


@pytest.mark.parametrize(
    ("relevant", "contradicts", "superseded", "kept"),
    [
        (0.45, 0.0, 0.0, True),
        (0.4499, 0.0, 0.0, False),
        (0.9, 0.70, 0.0, False),
        (0.9, 0.6999, 0.0, True),
        (0.9, 0.0, 0.70, False),
        (0.9, 0.0, 0.6999, True),
    ],
)
def test_a_note_is_set_aside_by_typesafes_three_thresholds(
    relevant, contradicts, superseded, kept
):
    assert decisions.keep_note(relevant, contradicts, superseded) is kept


def test_an_answer_of_the_wrong_shape_is_unreadable_never_guessed():
    for answers in ({}, {"acts": {"noul": True}}, {"acts": {"noul": 1.2}}, {"acts": "yes"}):
        with pytest.raises(decisions.Unreadable):
            decisions.read_noul(answers, "acts")
    with pytest.raises(decisions.Unreadable, match="chose 'x', which was not an option"):
        decisions.read_choice(
            {"tool": {"choice": "x", "probabilities": {"x": 1.0}}}, "tool", {"a"}
        )
    assert decisions.read_choice(
        {"tool": {"choice": "a", "probabilities": {"a": 0.7, "zzz": 0.3}}}, "tool", {"a", "b"}
    ) == ("a", {"a": 0.7})


def test_the_hint_line_is_the_specs_sentence():
    hint = decisions.Hint(tool=SETUP, fit=0.85, gate=0.9)
    assert hint.line() == (
        "A decision model reads the owner's message as needing your tool show_setup_qr "
        "(fit 0.85). Use it if it fits."
    )


def test_the_decision_role_cannot_reach_the_dispatch_funnel():
    """The hint is a request (spec §2) and tests/test_no_approvals.py pins the
    funnel. This module imports nothing of the tool registry or dispatch, so no
    line in it can refuse, reorder or run a call."""
    tree = ast.parse(Path(decisions.__file__).read_text(encoding="utf-8"))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and (node.module or "").startswith("app"):
            imported |= {f"{node.module}.{alias.name}" for alias in node.names}
        elif isinstance(node, ast.Import):
            imported |= {alias.name for alias in node.names if alias.name.startswith("app")}
    assert imported == {"app.peers", "app.traces"}


# -- run(): the whole step, against the gateway ------------------------------


async def test_a_decision_hints_the_tool_and_sets_aside_the_superseded_note(mount_peers):
    gateway = FakeGateway(
        decision_answer=decider(notes={"sideload": (0.8, 0.2, 0.9), "iPhone": (0.9, 0.1, 0.1)})
    )
    mount_peers(gateway=gateway)
    turn = _turn()

    advice = await decisions.run(app, turn, PHONE, NOTES, PATHS, tools.advertised_tools())

    assert advice == decisions.Advice(hint=decisions.Hint(tool=SETUP, fit=0.85, gate=0.9), keep=(1,))
    meta = _span(turn).meta
    assert meta["outcome"] == "decided"
    assert meta["hint"] == {"tool": SETUP, "fit": 0.85, "gate": 0.9}
    assert meta["shortlist"][0]["tool"] == SETUP
    assert meta["notes_checked"] is True
    assert meta["notes"] == [
        {"path": PATHS[0], "relevant": 0.8, "contradicts": 0.2, "superseded": 0.9, "kept": False},
        {"path": PATHS[1], "relevant": 0.9, "contradicts": 0.1, "superseded": 0.1, "kept": True},
    ]
    assert meta["served_by"] == ["openrouter:~typesafe/jev-latest"]
    assert meta["calls"] == 4
    assert meta["cost_usd"] == 4e-05 and meta["priced_calls"] == 4
    assert "TestFlight" not in json.dumps(meta), "note paths, never note text"
    facts = {json.loads(c["body"]["state"])["current_facts"] for c in gateway.decision_calls[2:]}
    assert facts == {f"Nova has the tool {SETUP}: {tools.REGISTRY[SETUP].description}"}


async def test_every_call_walks_the_decisions_role_under_the_turns_attribution(mount_peers):
    gateway = FakeGateway(decision_answer=decider())
    mount_peers(gateway=gateway)
    turn = _turn(kind="eval")

    await decisions.run(app, turn, PHONE, (), (), tools.advertised_tools())

    assert len(gateway.decision_calls) == 2
    for call in gateway.decision_calls:
        assert call["headers"]["x-nova-role"] == "decisions"
        assert call["headers"]["x-nova-purpose"] == "eval"
        assert call["headers"]["x-nova-turn-id"] == str(turn.id)
        assert "model" not in call["body"], "the decisions chain decides who answers"
        assert json.loads(call["body"]["state"])["owner_message"] == PHONE


async def test_with_no_decision_model_nothing_is_applied_and_the_span_says_why(mount_peers):
    mount_peers(gateway=FakeGateway())  # 503: the decisions chain is empty
    turn = _turn()

    advice = await decisions.run(app, turn, PHONE, NOTES, PATHS, tools.advertised_tools())

    assert advice == decisions.Advice()
    meta = _span(turn).meta
    assert meta["outcome"] == "failed_open"
    assert meta["reason"].startswith(
        "the gateway refused (503): no model in the 'decisions' chain can serve right now"
    )
    assert "the decisions chain is empty" in meta["reason"]
    assert meta["calls"] == 1 and meta["served_by"] == []


async def test_a_slow_decision_model_costs_the_budget_and_no_more(mount_peers, monkeypatch):
    """Review focus 3, in core: the Dell asleep or cold. The budget ends the
    wait — not the socket — and the turn gets nothing rather than a half."""
    monkeypatch.setattr(decisions, "TURN_BUDGET_S", 0.2)
    hold = asyncio.Event()
    mount_peers(gateway=FakeGateway(decision_answer=decider(), decision_hold=hold))
    turn = _turn()
    try:
        advice = await decisions.run(app, turn, PHONE, NOTES, PATHS, tools.advertised_tools())
    finally:
        hold.set()

    assert advice == decisions.Advice()
    span = _span(turn)
    assert span.meta["outcome"] == "failed_open"
    assert span.meta["reason"] == "no decision within the 0.2 s budget"
    assert span.duration_ms < 1000


async def test_an_answer_that_is_not_an_option_is_unreadable_and_fails_open(mount_peers):
    mount_peers(gateway=FakeGateway(decision_answer=decider(tool="no_such_tool")))
    turn = _turn()

    advice = await decisions.run(app, turn, PHONE, (), (), tools.advertised_tools())

    assert advice == decisions.Advice()
    assert _span(turn).meta["reason"] == (
        "a decision model's answer could not be read — 'tool' chose 'no_such_tool', which "
        "was not an option"
    )


async def test_an_answer_that_is_not_json_fails_open(mount_peers):
    mount_peers(
        gateway=FakeGateway(
            decision_answer=lambda body: Response("<html>oops</html>", media_type="text/html")
        )
    )
    turn = _turn()

    advice = await decisions.run(app, turn, PHONE, (), (), tools.advertised_tools())

    assert advice == decisions.Advice()
    assert _span(turn).meta["reason"] == (
        "a decision model's answer could not be read — the answer was not JSON"
    )


async def test_one_note_check_that_cannot_be_read_drops_the_whole_decision(mount_peers):
    """(plan decision 3) Half a decision is one nobody measured: the hint that
    stage 2 reached is NOT applied when a note check fails; the span keeps it
    under `reached`, as evidence, never as what the turn did."""
    fine = decider()

    def answer(body: dict) -> dict:
        if "relevant" in body["questions"] and "iPhone" in body["state"]:
            return {"relevant": {"type": "noul", "noul": "high"}}
        return fine(body)

    mount_peers(gateway=FakeGateway(decision_answer=answer))
    turn = _turn()

    advice = await decisions.run(app, turn, PHONE, NOTES, PATHS, tools.advertised_tools())

    assert advice == decisions.Advice()
    meta = _span(turn).meta
    assert meta["outcome"] == "failed_open"
    assert "'relevant' carried no noul between 0 and 1" in meta["reason"]
    assert "hint" not in meta
    assert meta["reached"]["hint"]["tool"] == SETUP


async def test_without_a_hint_the_notes_stand_and_are_never_asked_about(mount_peers):
    gateway = FakeGateway(decision_answer=decider(fit=0.1))
    mount_peers(gateway=gateway)
    turn = _turn()

    advice = await decisions.run(app, turn, PHONE, NOTES, PATHS, tools.advertised_tools())

    assert advice == decisions.Advice()
    meta = _span(turn).meta
    assert meta["outcome"] == "decided" and meta["hint"] is None
    assert meta["notes_checked"] is False
    assert meta["notes_unchecked"] == (
        "no tool hint, so there are no current facts to judge the notes against — they "
        "stand as recalled"
    )
    assert len(gateway.decision_calls) == 2


async def test_a_gate_below_its_threshold_is_no_hint(mount_peers):
    mount_peers(gateway=FakeGateway(decision_answer=decider(gate=0.29)))
    turn = _turn()

    advice = await decisions.run(app, turn, PHONE, (), (), tools.advertised_tools())

    assert advice.hint is None
    assert _span(turn).meta["gate"] == 0.29
```

- [ ] **Step 3: Run them to see them fail.**
  ```bash
  cd /home/jeremy/workspace/nova/.worktrees/decisions/services/core && uv run pytest -q tests/test_decisions.py
  ```
  Expected: FAIL — `ImportError: cannot import name 'decisions' from 'app'`.

- [ ] **Step 4: Write the module.** Create `services/core/app/decisions.py`:

```python
"""The decision role: before she answers, a decision model says which tool the
owner's message needs and which recalled notes still hold.

Spec: docs/plans/rebuild/decision-role/spec.md §2 (owner-approved 2026-09-27/28).
The recipes are TypeSafe's skill-suggestion cookbook (the tool hint) and its
RAG-passage cookbook (the recall check); both were measured on the S47 setup
case — 3/3 with Jev, 3/3 with Kev-4B — before this was written.

THE TOOL HINT. Stage 1 is one request: a `choice` over every tool this turn
advertises, each with its FULL registry description (never a truncated line),
plus `none`, and one `noul` gate — does answering require doing, showing or
looking something up? Stage 2 is a second request: a `choice` over stage 1's
top three and one fit `noul` per candidate, each quoting that candidate's full
description. The stage-2 pick becomes a hint when its fit is at least FIT_MIN
and the gate at least GATE_MIN; a hint is ONE system line in her turn
(Hint.line). It is a request: she still decides, and every guard still judges
what she writes.

THE RECALL CHECK. Only when there is a hint (plan decision 2): the current
facts a note is judged against ARE the hinted tool's full description, and
with no hint there is nothing current to judge a stale note by. Each note is
one request of three separate nouls — relevant, contradicts, superseded —
over one state holding the message, the note and the facts; all notes at
once. A note is set aside when relevant < RELEVANT_MIN, contradicts >=
CONTRADICTS_MAX or superseded >= SUPERSEDED_MAX — TypeSafe's starting points;
tune them on the eval corpus, never on one message.

DERIVED, NEVER LISTED. The options are the tools the turn advertises, read off
the very array the model is sent; the facts are the registry's own words.
Nothing here names a tool.

FAIL-OPEN, AND SAID. A decision is applied whole or not at all (plan decision
3). No decision model (the decisions chain is empty, or nothing in it can run),
a refusal, an answer that cannot be read, or the per-turn budget running out
leaves the turn exactly as it was before this module existed — no hint, every
note — and the `decisions` span says which.

WHAT IT NEVER DOES. Refuse, reorder or rewrite a tool call, or touch the
dispatch funnel (tests/test_no_approvals.py pins it; this module imports
nothing of app.tools). Run on a scheduled firing, a drained queue or an agent's
turn (chat._run_turn's `decide`).
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Collection, Sequence
from dataclasses import dataclass, field
from urllib.parse import unquote

import httpx

from app import peers, traces

logger = logging.getLogger("core")

#: The routing role these calls walk — the gateway's routing.DECISIONS_ROLE.
ROLE = "decisions"
#: (plan decision 6) The whole step's wall-clock budget per turn — "5 s to start"
#: (spec §2). Past it the turn runs as if there were no decision model.
TURN_BUDGET_S = 5.0
#: One call's own timeouts; the budget above bounds the whole step.
CALL_TIMEOUT = httpx.Timeout(connect=2.0, read=5.0, write=2.0, pool=2.0)
#: TypeSafe's skill-suggestion thresholds (FITS_THRESHOLD, GATE_THRESHOLD).
FIT_MIN = 0.30
GATE_MIN = 0.30
#: TypeSafe's RAG-passage thresholds, per note.
RELEVANT_MIN = 0.45
CONTRADICTS_MAX = 0.70
SUPERSEDED_MAX = 0.70
#: Stage 2 weighs stage 1's top three (TypeSafe's beam width).
SHORTLIST = 3
#: How much of one note a check sends — the spike's measured cut.
NOTE_CHARS = 3000
#: The option that means "no tool": the reply only talks.
NONE = "none"
NONE_MEANS = "No tool: the reply only talks, from knowledge or the conversation."
#: Who the decision model is told the assistant is (the measured wording).
ASSISTANT = "Nova, a household AI assistant with tools"
#: The span's two outcomes.
DECIDED = "decided"
FAILED_OPEN = "failed_open"
NO_HINT_NO_FACTS = (
    "no tool hint, so there are no current facts to judge the notes against — they "
    "stand as recalled"
)
GATE_QUESTION = (
    "Does answering the owner's message require Nova to do, show or look up something, "
    "rather than only talk?"
)
NOTE_QUESTIONS = {
    "relevant": {
        "type": "noul",
        "instructions": "Does the recalled note address the subject of the owner's message?",
    },
    "contradicts": {
        "type": "noul",
        "instructions": "Does the recalled note contradict the current facts about how Nova "
        "works?",
    },
    "superseded": {
        "type": "noul",
        "instructions": "Is the advice in the recalled note replaced by something the current "
        "facts say Nova can now do?",
    },
}


class Unanswered(RuntimeError):
    """No decision came back: no decision model, a refusal, a transport failure
    — in the gateway's own words."""


class Unreadable(ValueError):
    """An answer that is not the shape its question asked for."""


@dataclass(frozen=True)
class Hint:
    tool: str
    fit: float
    gate: float

    def line(self) -> str:
        """The one line in her turn — the spec's sentence (§2)."""
        return (
            f"A decision model reads the owner's message as needing your tool {self.tool} "
            f"(fit {self.fit:.2f}). Use it if it fits."
        )

    def as_meta(self) -> dict:
        return {"tool": self.tool, "fit": round(self.fit, 4), "gate": round(self.gate, 4)}


@dataclass(frozen=True)
class NoteVerdict:
    path: str
    relevant: float
    contradicts: float
    superseded: float

    @property
    def kept(self) -> bool:
        return keep_note(self.relevant, self.contradicts, self.superseded)

    def as_meta(self) -> dict:
        """By PATH, never text: the note already lives in memory."""
        return {
            "path": self.path,
            "relevant": round(self.relevant, 4),
            "contradicts": round(self.contradicts, 4),
            "superseded": round(self.superseded, 4),
            "kept": self.kept,
        }


@dataclass(frozen=True)
class Advice:
    """What the turn applies: a hint or None, and the indexes of the notes to
    keep — None leaves the notes exactly as recalled."""

    hint: Hint | None = None
    keep: tuple[int, ...] | None = None


@dataclass
class Calls:
    """What each call this turn learned about who answered — for the span."""

    count: int = 0
    served_by: list[str] = field(default_factory=list)
    fell_back: list[str] = field(default_factory=list)
    cost_usd: float = 0.0
    priced: int = 0

    def note(self, response: httpx.Response) -> None:
        served = response.headers.get("x-nova-served-by")
        if served and served not in self.served_by:
            self.served_by.append(served)
        header = response.headers.get("x-nova-route") or ""
        fields = dict(part.split("=", 1) for part in header.split(";") if "=" in part)
        if fields.get("link", "1") != "1" and fields.get("reason"):
            reason = unquote(fields["reason"])
            if reason not in self.fell_back:
                self.fell_back.append(reason)

    def note_cost(self, usage: object) -> None:
        cost = usage.get("cost_usd") if isinstance(usage, dict) else None
        if isinstance(cost, int | float) and not isinstance(cost, bool):
            self.cost_usd += float(cost)
            self.priced += 1

    def meta(self) -> dict:
        out: dict = {"calls": self.count, "served_by": list(self.served_by)}
        if self.fell_back:
            out["fell_back"] = list(self.fell_back)
        if self.priced:
            out["cost_usd"] = round(self.cost_usd, 6)
            out["priced_calls"] = self.priced
        return out


# -- the questions -------------------------------------------------------------


def tool_descriptions(advertised: Sequence[dict]) -> dict[str, str]:
    """{name: full description} for every tool the turn advertises, in its
    order — read off the very array the model is sent, so a tool registered
    tomorrow is an option by that fact alone."""
    out: dict[str, str] = {}
    for entry in advertised:
        function = entry.get("function") if isinstance(entry, dict) else None
        if isinstance(function, dict) and isinstance(function.get("name"), str):
            out[function["name"]] = str(function.get("description") or "")
    return out


def stage_one(descriptions: dict[str, str]) -> dict:
    return {
        "tool": {
            "type": "choice",
            "instructions": "Which of Nova's tools would a correct reply to the owner's "
            "message use?",
            "criteria": {**descriptions, NONE: NONE_MEANS},
        },
        "acts": {"type": "noul", "instructions": GATE_QUESTION},
    }


def stage_two(shortlist: Sequence[str], descriptions: dict[str, str]) -> dict:
    questions: dict = {
        "pick": {
            "type": "choice",
            "instructions": "Which of these tools does the owner's message need?",
            "criteria": {name: descriptions[name] for name in shortlist},
        }
    }
    for index, name in enumerate(shortlist):
        questions[f"fit{index}"] = {
            "type": "noul",
            "instructions": f"Does the tool '{name}' do the specific thing the owner's "
            f"message asks for? It is described as: {descriptions[name]}",
        }
    return questions


def shortlist(
    probabilities: dict[str, float], descriptions: dict[str, str], k: int = SHORTLIST
) -> list[str]:
    """Stage 1's top `k` advertised tools by probability — never `none`."""
    ranked = sorted(
        (name for name in probabilities if name in descriptions),
        key=lambda name: (-probabilities[name], name),
    )
    return ranked[:k]


def keep_note(relevant: float, contradicts: float, superseded: float) -> bool:
    return relevant >= RELEVANT_MIN and contradicts < CONTRADICTS_MAX and superseded < SUPERSEDED_MAX


def current_facts(hint: Hint, descriptions: dict[str, str]) -> str:
    return f"Nova has the tool {hint.tool}: {descriptions[hint.tool]}"


def note_state(message: str, note: str, facts: str) -> str:
    return json.dumps(
        {"owner_message": message, "recalled_note": note[:NOTE_CHARS], "current_facts": facts}
    )


def request_body(state: str, questions: dict) -> dict:
    """One call's body: the state and the questions, and NO model — the
    decisions chain decides who answers (plan decision 9)."""
    return {"state": state, "questions": questions}


# -- reading an answer ---------------------------------------------------------


def _is_probability(value: object) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and 0.0 <= value <= 1.0


def read_noul(answers: dict, key: str) -> float:
    entry = answers.get(key)
    value = entry.get("noul") if isinstance(entry, dict) else None
    if not _is_probability(value):
        raise Unreadable(f"{key!r} carried no noul between 0 and 1")
    return float(value)


def read_choice(answers: dict, key: str, options: Collection[str]) -> tuple[str, dict[str, float]]:
    entry = answers.get(key)
    if not isinstance(entry, dict):
        raise Unreadable(f"{key!r} is missing")
    chosen = entry.get("choice")
    if chosen not in options:
        raise Unreadable(f"{key!r} chose {chosen!r}, which was not an option")
    stated = entry.get("probabilities")
    if not isinstance(stated, dict):
        raise Unreadable(f"{key!r} carried no probabilities")
    probabilities = {
        name: float(value)
        for name, value in stated.items()
        if name in options and _is_probability(value)
    }
    if not probabilities:
        raise Unreadable(f"{key!r} carried no probability for any option")
    return chosen, probabilities


# -- the calls -----------------------------------------------------------------


def _purpose(turn: traces.Turn) -> str:
    kind = getattr(turn, "kind", None)
    return kind if isinstance(kind, str) and kind else "chat"


def _detail(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.text[:300]
    if isinstance(body, dict) and isinstance(body.get("error"), str):
        return body["error"][:300]
    return response.text[:300]


async def ask(
    client: httpx.AsyncClient, turn: traces.Turn, state: str, questions: dict, calls: Calls
) -> dict:
    """One decision request through the gateway: the answers, or a stated
    Unanswered / Unreadable — never a guess at a missing answer."""
    calls.count += 1
    try:
        response = await client.post(
            "/v1/systemone",
            json=request_body(state, questions),
            headers=peers.attribution_headers(turn, _purpose(turn), ROLE),
        )
    except httpx.HTTPError as exc:
        raise Unanswered(f"the gateway could not be reached — {peers.reason(exc)}") from exc
    calls.note(response)
    if response.status_code != 200:
        raise Unanswered(f"the gateway refused ({response.status_code}): {_detail(response)}")
    try:
        body = response.json()
    except ValueError as exc:
        raise Unreadable("the answer was not JSON") from exc
    if not isinstance(body, dict) or not isinstance(body.get("answers"), dict):
        raise Unreadable("the answer carried no answers object")
    calls.note_cost(body.get("usage"))
    return body["answers"]


async def decide(
    app,
    turn: traces.Turn,
    message: str,
    notes: Sequence[str],
    paths: Sequence[str],
    advertised: Sequence[dict],
    calls: Calls,
    meta: dict,
) -> Advice:
    """The whole decision — or an exception, never half of one. `meta` fills as
    each answer arrives, so a step that fails still shows how far it got.
    (plan decision 1) Three rounds: stage 1, stage 2, then every note at once."""
    descriptions = tool_descriptions(advertised)
    if not descriptions:
        meta["hint"] = None
        meta["why"] = "the turn advertises no tools, so there is nothing to choose between"
        return Advice()
    state = json.dumps({"assistant": ASSISTANT, "owner_message": message})
    async with peers.client(app, peers.GATEWAY, CALL_TIMEOUT) as client:
        first = await ask(client, turn, state, stage_one(descriptions), calls)
        _chosen, probabilities = read_choice(first, "tool", {*descriptions, NONE})
        gate = read_noul(first, "acts")
        short = shortlist(probabilities, descriptions)
        if not short:
            raise Unreadable("stage 1 gave no probability to any advertised tool")
        meta["shortlist"] = [{"tool": name, "p": round(probabilities[name], 4)} for name in short]
        meta["none_p"] = round(probabilities.get(NONE, 0.0), 4)
        meta["gate"] = round(gate, 4)
        second = await ask(client, turn, state, stage_two(short, descriptions), calls)
        pick, _probabilities = read_choice(second, "pick", set(short))
        fits = {name: read_noul(second, f"fit{index}") for index, name in enumerate(short)}
        meta["pick"] = pick
        meta["fits"] = {name: round(value, 4) for name, value in fits.items()}
        hint = (
            Hint(tool=pick, fit=fits[pick], gate=gate)
            if fits[pick] >= FIT_MIN and gate >= GATE_MIN
            else None
        )
        meta["hint"] = hint.as_meta() if hint is not None else None
        if not notes:
            return Advice(hint=hint)
        if hint is None:
            meta["notes_checked"] = False
            meta["notes_unchecked"] = NO_HINT_NO_FACTS
            return Advice()
        facts = current_facts(hint, descriptions)
        answers = await asyncio.gather(
            *(
                ask(client, turn, note_state(message, note, facts), NOTE_QUESTIONS, calls)
                for note in notes
            ),
            return_exceptions=True,
        )
        failed = next((answer for answer in answers if isinstance(answer, BaseException)), None)
        if failed is not None:
            raise failed
        verdicts = [
            NoteVerdict(
                path=paths[index] if index < len(paths) else "",
                relevant=read_noul(answer, "relevant"),
                contradicts=read_noul(answer, "contradicts"),
                superseded=read_noul(answer, "superseded"),
            )
            for index, answer in enumerate(answers)
        ]
        meta["notes_checked"] = True
        meta["notes"] = [verdict.as_meta() for verdict in verdicts]
        return Advice(
            hint=hint, keep=tuple(index for index, verdict in enumerate(verdicts) if verdict.kept)
        )


def _fail_open(span, reason: str) -> Advice:
    span.meta["outcome"] = FAILED_OPEN
    span.meta["reason"] = reason
    return Advice()


async def run(
    app,
    turn: traces.Turn,
    message: str,
    notes: Sequence[str],
    paths: Sequence[str],
    advertised: Sequence[dict],
) -> Advice:
    """The decision step as a turn runs it: under ONE `decisions` span, inside
    TURN_BUDGET_S, fail-open with the reason on the span. Never raises — a
    failure here costs the hint, never the turn. The span's own duration is the
    step's latency."""
    calls = Calls()
    reached: dict = {}
    with turn.span("decisions") as span:
        span.meta["budget_s"] = TURN_BUDGET_S
        try:
            advice = await asyncio.wait_for(
                decide(app, turn, message, notes, paths, advertised, calls, reached),
                TURN_BUDGET_S,
            )
        except TimeoutError:
            advice = _fail_open(span, f"no decision within the {TURN_BUDGET_S:g} s budget")
        except Unanswered as exc:
            advice = _fail_open(span, str(exc))
        except Unreadable as exc:
            advice = _fail_open(span, f"a decision model's answer could not be read — {exc}")
        except peers.PeerUnconfigured as exc:
            advice = _fail_open(span, f"the gateway link is not configured — {exc}")
        except Exception as exc:  # a bug: on the span and in the log, never the turn's end
            logger.exception("decisions: the decision step raised for turn %s", turn.id)
            advice = _fail_open(span, f"the decision step failed — {peers.reason(exc)}")
        else:
            span.meta["outcome"] = DECIDED
            span.meta.update(reached)
        if span.meta["outcome"] == FAILED_OPEN and reached:
            # How far it got before it failed — evidence for tuning, never applied.
            span.meta["reached"] = reached
        span.meta.update(calls.meta())
    return advice
```

- [ ] **Step 5: Run the tests to see them pass.**
  ```bash
  cd /home/jeremy/workspace/nova/.worktrees/decisions/services/core && uv run pytest -q tests/test_decisions.py
  ```
  Expected: PASS (no database needed).

- [ ] **Step 6: The suites the fakes serve, lint, format, commit.**
  ```bash
  . "$SCRATCHPAD/decisions.env" && cd /home/jeremy/workspace/nova/.worktrees/decisions/services/core && TEST_DATABASE_URL="$CORE_DB" uv run pytest -q tests/test_chat.py tests/test_chat_tools.py tests/test_eval_runner.py tests/test_no_approvals.py
  cd /home/jeremy/workspace/nova/.worktrees/decisions/services/core && uv run ruff check app tests && uv run ruff format app/decisions.py tests/fakes.py tests/test_decisions.py
  git -C /home/jeremy/workspace/nova/.worktrees/decisions add services/core/app/decisions.py services/core/tests/fakes.py services/core/tests/test_decisions.py
  git -C /home/jeremy/workspace/nova/.worktrees/decisions commit -m "feat(core): decisions.py — the tool hint and the recall check, fail-open inside a 5 s budget"
  git -C /home/jeremy/workspace/nova/.worktrees/decisions show --stat HEAD
  ```
  Expected: all green; nothing calls `decisions.run` yet, so no turn has changed.

---

### Task 8: The decision step in her turn — only where she is typed to, and in the eval runner (core)

**Files:**
- Modify: `services/core/app/chat.py:101-120` (imports), `:3949-4005` (`_run_turn`'s
  signature and docstring), after `:4208` (the decision step), `:4291-4299` (the
  `base_messages` call), `:5868-5903` (`_spawn_turn`), `:6113-6120` (`chat_stream`)
- Modify: `services/core/app/evals/runner.py:79-86` (docstring), `:1106-1118` (`run_case`)
- Test: `services/core/tests/test_chat_decisions.py` (create)

**Interfaces:**
- Consumes (Task 6): `Recalled.paths`, `_with_notes_kept`, `base_messages(..., hint=)`.
  (Task 7): `decisions.run`, `Advice`, `Hint.line`; `FakeGateway.decision_answer` /
  `decision_hold` / `decision_calls`; `tests.test_decisions.decider`.
- Produces:
  - `chat._run_turn(..., *, ingest=True, persona=None, attached=(), card=None, decide: bool = False)`
  - `chat._spawn_turn(..., *, card=None, decide: bool = False)`
  - `chat_stream` passes `decide=True`; `runner.run_case` passes `decide=True`; nothing else
    does (the scheduler's keyword set stays `{"ingest"}` / `{"ingest", "persona"}` —
    pinned in `tests/test_scheduler.py`; the queue drain passes none)

- [ ] **Step 1: Write the failing tests.** Create `services/core/tests/test_chat_decisions.py`:

```python
"""The decision role in the live turn (decision-role spec §2).

Pins: a turn he typed asks the decision role before the first round — the
hint is one system line immediately before his message, the set-aside note is
gone from her notes, and the `decisions` span sits between recall and the
first llm_call; with no decision model the turn is byte-for-byte the pre-slice
turn; a slow decision model costs the budget and the turn still answers; every
note set aside is SAID; an eval case runs the step like a chat turn; a drained
queued message and an agent's turn never ask."""

from __future__ import annotations

import asyncio
import re
from pathlib import Path

import pytest

from app import agents, chat, conversations, decisions, queued, traces
from app.evals import runner
from app.evals.cases import Case, PredicateSpec
from app.main import app
from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory
from tests.test_chat_agents import _create, _open_agent_turn, _owner
from tests.test_decisions import decider

pytestmark = requires_db

MODEL = "qwen3:8b"
PHONE = "How do I get you on my phone"
HITS = (
    {
        "path": "people/o/journals/2026-09-15.md",
        "snippet": "sideload the app through TestFlight",
        "kind": "journal",
    },
    {"path": "people/o/topics/phone.md", "snippet": "his phone is an iPhone 16"},
)
HINT = (
    "A decision model reads the owner's message as needing your tool show_setup_qr "
    "(fit 0.85). Use it if it fits."
)


@pytest.fixture
def root(monkeypatch, tmp_path) -> Path:
    root = tmp_path / "ws"
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


async def _nova(pool, owner, message: str, *, decide: bool) -> traces.Turn:
    """One owner turn through the funnel, as the stream route runs it (decide=True)
    or as every other caller does (decide=False)."""
    conversation = await conversations.active_conversation(pool, owner)
    turn = await traces.open_turn(
        pool, conversation_id=conversation["id"], model=MODEL, person_id=owner.id
    )
    frames: list = []
    before = set(chat._BACKGROUND)
    await chat._run_turn(
        app,
        pool,
        turn,
        owner,
        conversation["id"],
        message,
        [],
        MODEL,
        3,
        frames.append,
        decide=decide,
    )
    await chat.settle_detached(before)
    return turn


def _sent(gateway: FakeGateway) -> list[list[dict]]:
    return [body["messages"] for path, body in gateway.seen if path == "/v1/chat/completions"]


def _clockless(messages: list[dict]) -> list[dict]:
    return [
        dict(m, content=re.sub(r"Current time: \S+", "Current time: T", m["content"]))
        for m in messages
    ]


async def test_a_decision_puts_its_hint_before_his_message_and_drops_the_stale_note(
    pool, mount_peers
):
    owner = await _owner(pool)
    gateway = FakeGateway(
        deltas=("Hello.",),
        decision_answer=decider(notes={"sideload": (0.8, 0.2, 0.9), "iPhone": (0.9, 0.1, 0.1)}),
    )
    mount_peers(gateway=gateway, memory=FakeMemory(results=HITS))

    turn = await _nova(pool, owner, PHONE, decide=True)

    (messages,) = _sent(gateway)
    assert messages[-1] == {"role": "user", "content": PHONE}
    assert messages[-2] == {"role": "system", "content": HINT}
    volatile = messages[1]["content"]
    assert "iPhone 16" in volatile and "TestFlight" not in volatile
    kinds = [span.kind for span in turn.spans]
    assert kinds.index("memory_recall") < kinds.index("decisions") < kinds.index("llm_call")
    (span,) = [s for s in turn.spans if s.kind == "decisions"]
    assert span.meta["outcome"] == "decided"
    assert span.meta["hint"] == {"tool": "show_setup_qr", "fit": 0.85, "gate": 0.9}
    assert [(n["path"], n["kept"]) for n in span.meta["notes"]] == [
        ("people/o/journals/2026-09-15.md", False),
        ("people/o/topics/phone.md", True),
    ]


async def test_with_no_decision_model_the_turn_is_the_turn_it_was(pool, mount_peers):
    """Review focus 1, in core: no decisions chain (every install's first
    state). The gateway says so; her prompt is byte-for-byte what a turn that
    never asked gets, and the span says why nothing was applied."""
    owner = await _owner(pool)
    gateway = FakeGateway(deltas=("Hello.",))  # /v1/systemone: 503, no decision model
    mount_peers(gateway=gateway, memory=FakeMemory(results=HITS))

    before = await _nova(pool, owner, PHONE, decide=False)
    after = await _nova(pool, owner, PHONE, decide=True)

    without, with_step = _sent(gateway)
    assert _clockless(with_step) == _clockless(without)
    assert not [s for s in before.spans if s.kind == "decisions"]
    (span,) = [s for s in after.spans if s.kind == "decisions"]
    assert span.meta["outcome"] == "failed_open"
    assert "the decisions chain is empty" in span.meta["reason"]


async def test_a_slow_decision_model_costs_the_budget_and_she_still_answers(
    pool, mount_peers, monkeypatch
):
    monkeypatch.setattr(decisions, "TURN_BUDGET_S", 0.3)
    owner = await _owner(pool)
    hold = asyncio.Event()
    gateway = FakeGateway(deltas=("Hello.",), decision_answer=decider(), decision_hold=hold)
    mount_peers(gateway=gateway, memory=FakeMemory(results=HITS))
    try:
        turn = await _nova(pool, owner, PHONE, decide=True)
    finally:
        hold.set()

    (messages,) = _sent(gateway)
    assert not [m for m in messages if m["content"] == HINT]
    assert "TestFlight" in messages[1]["content"], "a failed step leaves every note"
    (span,) = [s for s in turn.spans if s.kind == "decisions"]
    assert span.meta["reason"] == "no decision within the 0.3 s budget"
    assert await pool.fetchval(
        "SELECT content FROM messages WHERE turn_id = $1 AND role = 'assistant'", turn.id
    ) == "Hello."


async def test_when_every_note_is_set_aside_her_prompt_says_so(pool, mount_peers):
    """Review focus 4, in the turn."""
    owner = await _owner(pool)
    gateway = FakeGateway(
        deltas=("Hello.",),
        decision_answer=decider(notes={"sideload": (0.8, 0.2, 0.9), "iPhone": (0.1, 0.0, 0.0)}),
    )
    mount_peers(gateway=gateway, memory=FakeMemory(results=HITS))

    await _nova(pool, owner, PHONE, decide=True)

    (messages,) = _sent(gateway)
    volatile = messages[1]["content"]
    assert (
        "Her memory was searched for this turn; a decision model set aside all 2 notes it "
        "returned as unrelated to this message or superseded by what she can do now."
    ) in volatile
    assert "returned nothing" not in volatile


async def test_the_chat_stream_asks_the_decision_role(owner_client, mount_peers):
    gateway = FakeGateway(deltas=("Hi.",), decision_answer=decider())
    mount_peers(gateway=gateway, memory=FakeMemory())
    put = await owner_client.put("/api/v1/settings", json={"key": "chat.model", "value": MODEL})
    assert put.status_code == 200

    resp = await owner_client.post("/api/v1/chat/stream", json={"message": PHONE})

    assert resp.status_code == 200
    assert len(gateway.decision_calls) == 2, "a turn he typed asks the decision role"
    assert all(c["headers"]["x-nova-role"] == "decisions" for c in gateway.decision_calls)
    assert all(c["headers"]["x-nova-purpose"] == "chat" for c in gateway.decision_calls)


async def test_an_eval_case_runs_the_decision_step_like_a_chat_turn(pool, mount_peers):
    """The runner measures the real chat path, so its turns ask too — under the
    eval purpose, attributed to the eval turn."""
    gateway = FakeGateway(
        deltas=("An answer.",), decision_answer=decider(tool="get_time", fit=0.9, gate=0.9)
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    case = Case(
        id="c",
        suite="corpus",
        suite_version=1,
        message="what time is it?",
        contract=(PredicateSpec("reply_matches", "answer"),),
    )

    run = await runner.run_case(app, pool, case, MODEL)

    assert run.passed is True, run.detail
    spans = await pool.fetch(
        "SELECT meta FROM turn_spans WHERE turn_id = $1 AND kind = 'decisions'", run.turn_id
    )
    assert len(spans) == 1 and spans[0]["meta"]["hint"]["tool"] == "get_time"
    assert all(c["headers"]["x-nova-purpose"] == "eval" for c in gateway.decision_calls)


async def test_a_drained_queued_message_asks_no_decision_model(pool, mount_peers):
    """Spec §2, "Not on: … drains": the queue drain passes no `decide`."""
    person = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('owner', 'owner') RETURNING id"
    )
    conversation = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", person
    )
    await queued.enqueue_for_test(pool, conversation, person, PHONE)
    gateway = FakeGateway(deltas=("Hi.",), decision_answer=decider())
    mount_peers(gateway=gateway, memory=FakeMemory())

    await chat.drain_queue(app, pool, conversation)
    await asyncio.wait_for(chat.drain_background(), timeout=15)

    assert await pool.fetchval("SELECT count(*) FROM messages WHERE role = 'assistant'") == 1
    assert gateway.decision_calls == []
    assert await pool.fetchval("SELECT count(*) FROM turn_spans WHERE kind = 'decisions'") == 0


async def test_an_agents_turn_asks_no_decision_model_even_when_told_to(pool, mount_peers, root):
    """Spec §2, "Not on: … agent delegation": an agent's persona never asks,
    whoever passed `decide` (an @mention reaches the funnel from the stream)."""
    owner = await _owner(pool)
    agent = await _create(pool, mount_peers)
    gateway = FakeGateway(deltas=("done",), decision_answer=decider())
    mount_peers(gateway=gateway, memory=FakeMemory())
    turn = await _open_agent_turn(pool, agent, owner, kind="chat")
    before = set(chat._BACKGROUND)

    await chat._run_turn(
        app,
        pool,
        turn,
        agent.person(),
        agent.log_conversation_id,
        PHONE,
        [],
        MODEL,
        3,
        [].append,
        persona=agents.persona_for(agent, owner_id=owner.id),
        decide=True,
    )
    await chat.settle_detached(before)

    assert gateway.decision_calls == []
    assert not [s for s in turn.spans if s.kind == "decisions"]
```

- [ ] **Step 2: Run them to see them fail.**
  ```bash
  . "$SCRATCHPAD/decisions.env" && cd /home/jeremy/workspace/nova/.worktrees/decisions/services/core && TEST_DATABASE_URL="$CORE_DB" uv run pytest -q tests/test_chat_decisions.py
  ```
  Expected: FAIL — `TypeError: _run_turn() got an unexpected keyword argument 'decide'`,
  and the stream and eval tests see no decision calls.

- [ ] **Step 3: The step in `_run_turn`.** In `app/chat.py`:
  - imports (`:101-120`): `decisions,` joins the `from app import (…)` list after `db,`.
  - the signature (`:3960-3965`) gains, after `card: Callable[[dict], None] | None = None,`:
    ```python
        decide: bool = False,
    ```
    and the docstring, after the `card` paragraph (`:4003-4004`):
    ```
    `decide` (decision-role spec §2) runs the decision step — a decision model
    asked which tool the message needs and which recalled notes still hold —
    before the first round. Only the stream route (a turn he typed) and the
    eval runner (which measures that path) pass True; a scheduled firing, a
    drained queue and delegation never do, and an agent's persona never asks
    whatever is passed (spec: "Not on … to start. Measure first").
    ```
  - after the live checks (`:4205-4208`), before `# S28 — THE FILES HE SENT.`:
    ```python
            # THE DECISION ROLE (decisions.py, decision-role spec §2), before she is
            # asked anything: which of her tools his message needs, and which of the
            # recalled notes still hold. (plan decision 4) Here because it needs the
            # notes and the advertised tools, and must come before the first round.
            # Fail-open by construction: `advice` is a whole decision or nothing,
            # and the `decisions` span says which. The hint is a request — nothing
            # here or downstream refuses, reorders or runs a call because of it.
            hint: str | None = None
            if decide and persona.agent is None:
                advice = await decisions.run(
                    app, turn, message, recalled.notes, recalled.paths, advertised
                )
                recalled = _with_notes_kept(recalled, advice.keep)
                hint = advice.hint.line() if advice.hint is not None else None
    ```
  - the `base_messages` call (`:4291-4299`) gains `hint=hint,` after `skills_roster=skills_roster,`.
  - `_spawn_turn` (`:5868-5903`): the signature gains `decide: bool = False,` after
    `card`, the docstring gains "`decide` is passed through to `_run_turn` (the stream
    route alone sets it).", and the `_run_turn(...)` call gains `decide=decide,` after
    `card=card,`.
  - `chat_stream` (`:6113-6120`):
    ```python
        _spawn_turn(
            request.app,
            pool,
            conversation_id,
            started,
            queue.put_nowait,
            card=_card_channel(queue.put_nowait),
            # A turn he typed asks the decision role (decision-role spec §2).
            decide=True,
        )
    ```

- [ ] **Step 4: The eval runner measures the same path.** In `app/evals/runner.py`:
  - the module docstring, after the "THE PAIRING FIXTURE (S47)" paragraph (`:79-86`), in its
    voice:
    ```
    THE DECISION ROLE (decision-role spec §2). A chat turn he types asks a
    decision model which tool his message needs and which recalled notes still
    hold, so every case's turn does too (`decide=True`): a measurement of her
    chat path must include the step. It walks the owner's live `decisions`
    chain — a different model from the one under test, like a delegated child's
    — and its `decisions` span says who answered, so a score is attributable.
    With no decision model the step fails open and the turn is exactly the
    turn it was.
    ```
  - the `_run_turn` call (`:1106-1118`) gains `decide=True,` after
    `card=chat._card_channel(emit),`.

- [ ] **Step 5: Run the tests to see them pass.**
  ```bash
  . "$SCRATCHPAD/decisions.env" && cd /home/jeremy/workspace/nova/.worktrees/decisions/services/core && TEST_DATABASE_URL="$CORE_DB" uv run pytest -q tests/test_chat_decisions.py tests/test_scheduler.py tests/test_queued_messages.py tests/test_chat_agents.py tests/test_eval_runner.py tests/test_no_approvals.py
  ```
  Expected: PASS — `test_scheduler.py`'s keyword pins unchanged, `test_no_approvals.py`
  untouched and green (the step is before the loop, never in the dispatch funnel).

- [ ] **Step 6: The whole core suite, once.** Every stream and eval turn in the suite now
  makes one `/v1/systemone` call to a fake that answers "no decision model" and files a
  `decisions` span:
  ```bash
  . "$SCRATCHPAD/decisions.env" && cd /home/jeremy/workspace/nova/.worktrees/decisions/services/core && TEST_DATABASE_URL="$CORE_DB" uv run pytest -q --timeout=120 2>&1 | tail -5
  ```
  Expected: the baseline count plus this lane's tests, all green. A test that pinned a
  stream turn's EXACT span list sees one more `decisions` span between `memory_recall` and
  `llm_call`: that is this task working — add the span to its expectation deliberately and
  name the test in the commit body. A red you cannot explain that way: stop and report it
  with its output.

- [ ] **Step 7: Lint, format, commit.**
  ```bash
  cd /home/jeremy/workspace/nova/.worktrees/decisions/services/core && uv run ruff check app tests && uv run ruff format app/chat.py app/evals/runner.py tests/test_chat_decisions.py
  git -C /home/jeremy/workspace/nova/.worktrees/decisions add services/core/app/chat.py services/core/app/evals/runner.py services/core/tests/test_chat_decisions.py
  git -C /home/jeremy/workspace/nova/.worktrees/decisions commit -m "feat(core): a turn he types asks the decision role first — hint and notes, fail-open"
  git -C /home/jeremy/workspace/nova/.worktrees/decisions show --stat HEAD
  ```

---

### Task 9: Core's share of routing — the switch's proxy, her routing tool names the role, the router's pick on the turn (core)

**Files:**
- Modify: `services/core/app/proxies.py:183-200` (the agent-role check shared; the new
  `PUT /routes/{role}/jev-router`)
- Modify: `services/core/app/tools/route.py:38-52` (`wrong_protocol` in words), `:93-110`
  (the descriptions name `decisions`)
- Modify: `services/core/app/chat.py:2816-2821` (the round reads the answering model),
  after `:3047` (`_note_routed`)
- Modify: `services/core/tests/fakes.py` (`FakeGateway`: the jev-router admin route;
  `chunk_model`)
- Modify (pins): `services/core/tests/test_tools_route.py:74-79` (the gateway's role-list
  text), `services/core/tests/test_proxies.py:56-63` (the ROUTES table)
- Test: `services/core/tests/test_tools_route.py`, `services/core/tests/test_proxies.py`,
  `services/core/tests/test_chat_served_by.py` (add)

**Interfaces:**
- Consumes (Tasks 1, 5): the gateway's refusal text with `decisions` in the role list;
  `PUT /admin/routes/{role}/jev-router`; the `wrong_protocol` verdict.
- Produces:
  - `PUT /api/v1/routes/{role}/jev-router` → the gateway's answer verbatim; an
    `agent_<name>` with no agent is refused here (`400 no agent named …`)
  - `proxies._refuse_an_agent_role_with_no_agent(role: str) -> None`
  - `route.describe` words `wrong_protocol`; `route_explain`'s descriptions name `decisions`
  - llm_call span meta `routed_to: str` — present only when a provider chunk names a
    model other than the served link's
  - `chat._note_routed(span, chunk: dict) -> None`
  - `FakeGateway.chunk_model: str | None = None`

- [ ] **Step 1: The fake.** In `services/core/tests/fakes.py`, `FakeGateway`:
  - after `decision_calls`:
    ```python
        # The model the provider names on each content chunk. OpenRouter names the
        # model a router link picked (decision-role spec §4); None names none.
        chunk_model: str | None = None
    ```
  - the routes gain `Route("/admin/routes/{role}/jev-router", self._admin, methods=["PUT"]),`
    after `/admin/routes/{role}`
  - in `_completions`' stream, the content loop becomes:
    ```python
            for delta in self.deltas:
                if self.delta_delay_s:
                    await asyncio.sleep(self.delta_delay_s)
                chunk: dict = {"choices": [{"delta": {"content": delta}}]}
                if self.chunk_model is not None:
                    chunk["model"] = self.chunk_model
                yield _sse(chunk)
    ```

- [ ] **Step 2: Write the failing tests.**
  - `services/core/tests/test_proxies.py`: the `ROUTES` table (`:56-63`) gains, after the
    S12-2 row:
    ```python
        # The decision role (spec §4): the Jev Router switch, an edit to a chain.
        ("PUT", "/api/v1/routes/chat/jev-router", "/admin/routes/chat/jev-router", {"on": False}),
    ```
    and at the end of the file:
    ```python
    async def test_the_router_switch_on_an_agent_role_with_no_agent_is_refused_here(
        owner_client, mount_peers
    ):
        """The same rule as PUT /routes/{role}: a typo'd agent role is refused where
        the owner types it, by name, and the gateway is never asked."""
        gateway = FakeGateway()
        mount_peers(gateway=gateway)

        resp = await owner_client.put("/api/v1/routes/agent_nobody/jev-router", json={"on": False})

        assert resp.status_code == 400
        assert "no agent named 'nobody'" in resp.json()["error"]
        assert gateway.seen == []
    ```
  - `services/core/tests/test_tools_route.py`: the refusing gateway's text (`:74-79`) —
    the gateway's own words since Task 1:
    ```python
            admin_body={
                "error": (
                    "role must be a built-in (chat, scheduled, judge, decisions, coding, "
                    "vision) or a lowercase [a-z_] name of at most 32 chars — got 'Vibes-1'"
                )
            },
    ```
    and at the end of the file:
    ```python
    def test_a_link_that_cannot_answer_its_role_is_said_in_words():
        body = {
            "role": "decisions",
            "chain": [
                {
                    "link": 1,
                    "id": "hub:qwen3:8b",
                    "verdict": "wrong_protocol",
                    "reason": "hub answers chat — this role needs typed questions",
                }
            ],
            "would_serve": None,
            "reason": "no model in the 'decisions' chain can serve right now",
        }

        text = route.describe(body)

        assert text.startswith("Answer: nothing can serve the decisions role right now")
        assert (
            "  1. hub:qwen3:8b: skipped — it cannot answer this role (hub answers chat — "
            "this role needs typed questions)"
        ) in text


    def test_her_routing_tool_names_the_decisions_role():
        (tool,) = route.TOOLS
        assert "decisions" in tool.description
        assert "decisions" in tool.parameters["properties"]["role"]["description"]
    ```
  - `services/core/tests/test_chat_served_by.py`, at the end:
    ```python
    async def test_a_router_links_pick_is_recorded_on_its_round(owner_client, pool, mount_peers):
        """Decision-role spec §4: with the Jev Router switch on, a round can be served
        by `openrouter:typesafe/jev-router`, a link that answers from a model it
        picks per request. OpenRouter names that model on every chunk; the round's
        span keeps it as `routed_to`, beside the link that served."""
        gateway = FakeGateway(
            deltas=("Hi", "."),
            served_by="openrouter:typesafe/jev-router",
            chunk_model="anthropic/claude-sonnet-5",
        )
        mount_peers(gateway=gateway, memory=FakeMemory())
        await owner_client.put(
            "/api/v1/settings", json={"key": "chat.model", "value": "openrouter:typesafe/jev-router"}
        )

        resp = await owner_client.post("/api/v1/chat/stream", json={"message": "hello"})

        assert resp.status_code == 200
        meta = await pool.fetchval("SELECT meta FROM turn_spans WHERE kind = 'llm_call'")
        assert meta["served_by"] == "openrouter:typesafe/jev-router"
        assert meta["routed_to"] == "anthropic/claude-sonnet-5"


    async def test_a_link_that_answers_as_itself_records_no_pick(owner_client, pool, mount_peers):
        gateway = FakeGateway(
            deltas=("Hi",),
            served_by="openrouter:anthropic/claude-sonnet-5",
            chunk_model="anthropic/claude-sonnet-5",
        )
        mount_peers(gateway=gateway, memory=FakeMemory())

        resp = await owner_client.post("/api/v1/chat/stream", json={"message": "hello"})

        assert resp.status_code == 200
        meta = await pool.fetchval("SELECT meta FROM turn_spans WHERE kind = 'llm_call'")
        assert "routed_to" not in meta
    ```

- [ ] **Step 3: Run them to see them fail.**
  ```bash
  . "$SCRATCHPAD/decisions.env" && cd /home/jeremy/workspace/nova/.worktrees/decisions/services/core && TEST_DATABASE_URL="$CORE_DB" uv run pytest -q tests/test_proxies.py tests/test_tools_route.py tests/test_chat_served_by.py
  ```
  Expected: FAIL — the jev-router proxy 404s (so the agent refusal and the table row fail),
  `wrong_protocol` is described as its bare verdict, the description lacks `decisions`, and
  there is no `routed_to`.

- [ ] **Step 4: The proxy.** In `app/proxies.py`, replace `put_route` (`:183-200`) with the
  check lifted out and a sibling route:
  ```python
  async def _refuse_an_agent_role_with_no_agent(role: str) -> None:
      """An agent's role (`agent_<name>`, S12) is refused HERE when no such agent
      exists — the Routing page is the only production caller, so a typo is
      refused where the owner types it, by name, instead of becoming a chain
      nobody walks. Every other role is the gateway's to judge."""
      from app import agents  # function-local: agents imports the store, not the proxies

      if role.startswith(agents.ROLE_PREFIX):
          name = role[len(agents.ROLE_PREFIX) :]
          live = await agents.names(await db.get_pool())
          if name not in live:
              roles = ", ".join(agents.ROLE_PREFIX + n for n in live) or "none yet"
              raise HTTPException(
                  status_code=400, detail=f"no agent named {name!r} — live agent roles: {roles}"
              )


  @router.put("/routes/{role}")
  async def put_route(role: str, request: Request) -> Response:
      """Set a role's chain; the gateway's built-ins, its ROLE_RE and its
      protocol check answer verbatim."""
      await _refuse_an_agent_role_with_no_agent(role)
      return await _forward(request, "PUT", f"/admin/routes/{role}")


  @router.put("/routes/{role}/jev-router")
  async def put_jev_router(role: str, request: Request) -> Response:
      """The Jev Router switch (decision-role spec §4), forwarded 1:1: an edit to
      the role's chain that the gateway makes and states, refusals included."""
      await _refuse_an_agent_role_with_no_agent(role)
      return await _forward(request, "PUT", f"/admin/routes/{role}/jev-router")
  ```

- [ ] **Step 5: Her routing tool.** In `app/tools/route.py`:
  - the `state` map in `describe` (`:41-50`) gains:
    ```python
                "wrong_protocol": "skipped — it cannot answer this role",
    ```
  - the tool's description (`:95`) becomes:
    ```python
            description=(
                "Why a call for a role (chat, scheduled, judge, decisions — the decision "
                "model that reads each message before she answers — or an agent's role "
                "agent_<name>) goes to the model it goes to: "
                "each link in the role's chain with its live verdict — would serve, over its "
                "monthly cap, the provider refused recently (walled), not installed, cannot "
                "answer this role — and the gateway's stated reason for any fallback. Use it to "
                "answer 'why did that come from the local model' or 'which model will answer "
                "next'. Reads only."
            ),
    ```
  - the `role` property's description (`:108`) becomes
    `"The role to explain (default chat): chat, scheduled, judge, decisions, or an agent's role agent_<name>."`

- [ ] **Step 6: The router's pick on the round.** In `app/chat.py`, `_gateway_round`, after
  the `json.loads` try/except (`:2816-2820`) and before `_chunk_parts(chunk)`:
  ```python
                          if "routed_to" not in span.meta:
                              _note_routed(span, chunk)
  ```
  and after `_note_served` (`:3047`):
  ```python
  def _note_routed(span, chunk: dict) -> None:
      """Which model actually answered, when that is not the link that served
      (decision-role spec §4). A router link — `openrouter:typesafe/jev-router` —
      answers from a model it picks for each request, and OpenRouter names that
      model on every chunk it relays. Read only off a chunk that carries
      `choices` (the provider's own; the gateway's usage chunk has none), and
      recorded only when it differs from the served link's model: a plain link
      records nothing, a routed one records what answered. Never guessed."""
      named = chunk.get("model")
      if not isinstance(named, str) or not named or not chunk.get("choices"):
          return
      served = span.meta.get("served_by")
      if isinstance(served, str) and served.partition(":")[2] == named:
          return
      span.meta["routed_to"] = named
  ```

- [ ] **Step 7: Run the tests to see them pass, then the whole core suite.**
  ```bash
  . "$SCRATCHPAD/decisions.env" && cd /home/jeremy/workspace/nova/.worktrees/decisions/services/core && TEST_DATABASE_URL="$CORE_DB" uv run pytest -q tests/test_proxies.py tests/test_tools_route.py tests/test_chat_served_by.py tests/test_tools_registry.py
  . "$SCRATCHPAD/decisions.env" && cd /home/jeremy/workspace/nova/.worktrees/decisions/services/core && TEST_DATABASE_URL="$CORE_DB" uv run pytest -q --timeout=120 2>&1 | tail -3
  ```
  Expected: PASS; the whole suite green (`test_tools_registry` unmoved: no tool was added).

- [ ] **Step 8: Lint, format, commit.**
  ```bash
  cd /home/jeremy/workspace/nova/.worktrees/decisions/services/core && uv run ruff check app tests && uv run ruff format app/proxies.py app/tools/route.py app/chat.py tests/fakes.py tests/test_proxies.py tests/test_tools_route.py tests/test_chat_served_by.py
  git -C /home/jeremy/workspace/nova/.worktrees/decisions add services/core/app/proxies.py services/core/app/tools/route.py services/core/app/chat.py services/core/tests/fakes.py services/core/tests/test_proxies.py services/core/tests/test_tools_route.py services/core/tests/test_chat_served_by.py
  git -C /home/jeremy/workspace/nova/.worktrees/decisions commit -m "feat(core): the router switch's proxy, her routing tool names the decisions role, the router's pick on the round"
  git -C /home/jeremy/workspace/nova/.worktrees/decisions show --stat HEAD
  ```
  The commit body says why `test_tools_route`'s role-list text moved (the gateway's refusal
  now names `decisions`).

---

### Task 10: The decisions role on Settings → Routing — its words, a picker that offers decision models only (web)

**Files:**
- Modify: `apps/web/src/lib/api.ts:618-651` (routing types)
- Modify: `apps/web/src/pages/settings/RoutingSection.tsx:6-21` (imports), `:59-79`
  (`ROLE_WORDS`, `VERDICT_WORDS`), after `:83` (`isDecisionModel`), `:189-210` (the
  protocol handed down), `:246-449` (`RoleEditor`)
- Modify (pins): `apps/web/src/pages/settings/RoutingSection.test.tsx:15-24` (`ROUTES`),
  `:89-100` and `:105` (the role-order assertions)
- Test: `apps/web/src/pages/settings/RoutingSection.test.tsx` (add)

**Interfaces:**
- Consumes (Tasks 1, 4): `GET /api/v1/routes` role entries carry
  `protocol: 'chat' | 'systemone'`; catalogue rows of decision models carry
  `suitability.decisions` (declared) and `actions: []`; the `wrong_protocol` verdict.
- Produces:
  - `type BuiltinRole = 'chat' | 'scheduled' | 'judge' | 'decisions' | 'coding' | 'vision'`
  - `type RouteProtocol = 'chat' | 'systemone'`
  - `Routes.roles[i].protocol?: RouteProtocol`; `RouteVerdict.verdict` names `'wrong_protocol'`
  - `export function isDecisionModel(row: CatalogRow): boolean` (RoutingSection.tsx)
  - `RoleEditor` prop `protocol: RouteProtocol`

- [ ] **Step 1: Write the failing tests.** In `apps/web/src/pages/settings/RoutingSection.test.tsx`:
  - the fixture — `decisions` joins the gateway's list after `judge`, speaking its protocol,
    and a helper for a decision model's catalogue row:
    ```ts
    const ROUTES: Routes = {
      roles: [
        { role: 'chat', chain: ['hub:qwen3:8b'], reserved: false, builtin: true, protocol: 'chat' },
        { role: 'scheduled', chain: [], reserved: false, builtin: true, protocol: 'chat' },
        { role: 'judge', chain: [], reserved: false, builtin: true, protocol: 'chat' },
        // The decision role (decision-role spec §1): typed questions, never chat.
        { role: 'decisions', chain: [], reserved: false, builtin: true, protocol: 'systemone' },
        { role: 'coding', chain: [], reserved: true, builtin: true, protocol: 'chat' },
        { role: 'vision', chain: [], reserved: true, builtin: true, protocol: 'chat' },
      ],
      walls: [{ provider: 'openrouter', walled_until: '2026-09-08T10:00:00Z', reason: 'openrouter refused (402): insufficient credits', status: 402, strikes: 1 }],
    }
    ```
    ```ts
    /** A decision model's row: the listing says it outputs decisions, and it is
     * offered no action (the gateway never offers one as the chat model). */
    function decisionRow(id: string): CatalogRow {
      return { ...row(id, 'cloud'), suitability: { decisions: { value: true, basis: 'declared', source: 'provider-listing' } } }
    }
    ```
  - the order pins follow the server's list (`:89-100`):
    ```ts
      it('renders the roles the server returns, in the server\'s order, with the built-ins\' own words', async () => {
        // Not the canonical order: proves the page follows the response, not a list of its own.
        const byName = Object.fromEntries(ROUTES.roles.map(r => [r.role, r]))
        const order = ['chat', 'judge', 'decisions', 'scheduled', 'vision', 'coding']
        const shuffled: Routes = { ...ROUTES, roles: order.map(name => byName[name]) }
        renderSection({ getRoutes: vi.fn(async () => shuffled) })
        await waitFor(() => expect(screen.getByTestId('route-vision')).toBeTruthy())
        expect(rolesOnPage()).toEqual(order)
        expect(screen.getByTestId('route-judge').textContent).toContain('Quality judging')
        expect(screen.getByTestId('route-decisions').textContent).toContain('Decisions')
        expect(screen.getByTestId('route-vision').textContent).toContain('reserved — nothing routes here yet')
        for (const role of order) {
          expect(within(screen.getByTestId(`route-${role}`)).queryByRole('button', { name: `remove role ${role}` })).toBeNull()
        }
      })
    ```
    and (`:105`):
    ```ts
        expect(rolesOnPage()).toEqual(['chat', 'scheduled', 'judge', 'decisions', 'coding', 'vision', 'agent_coder', 'agent_zed'])
    ```
  - new tests, at the end of the `describe`:
    ```ts
      it('shows the decision role in its own words and offers it decision models only', async () => {
        renderSection({
          getCatalog: vi.fn(async () => ({
            fetched_at: 't',
            sources: [],
            rows: [row('hub:qwen3:8b', 'local', true), row('cerebras:llama', 'cloud'), decisionRow('openrouter:~typesafe/jev-latest'), decisionRow('dell-kev:kev-latest')],
          })),
        })
        await waitFor(() => expect(screen.getByTestId('route-decisions')).toBeTruthy())
        const decisions = screen.getByTestId('route-decisions')
        expect(decisions.textContent).toContain('a decision model answers typed questions before she replies')
        expect(decisions.textContent).toContain('no decision model — her turns run without one')
        expect(decisions.textContent).not.toContain('uses the chat chain')
        const offered = [...(within(decisions).getByLabelText('add to decisions') as HTMLSelectElement).options].map(o => o.value).filter(Boolean)
        expect(offered).toEqual(['openrouter:~typesafe/jev-latest', 'dell-kev:kev-latest'])
        // And never the other way round: a chat role is offered no decision model.
        const scheduled = [...(within(screen.getByTestId('route-scheduled')).getByLabelText('add to scheduled') as HTMLSelectElement).options].map(o => o.value)
        expect(scheduled).toContain('hub:qwen3:8b')
        expect(scheduled).not.toContain('openrouter:~typesafe/jev-latest')
        expect(scheduled).not.toContain('dell-kev:kev-latest')
      })

      it('saves a decision chain through the same API as any role', async () => {
        const api = renderSection({
          getCatalog: vi.fn(async () => ({ fetched_at: 't', sources: [], rows: [decisionRow('dell-kev:kev-latest'), decisionRow('openrouter:~typesafe/jev-latest')] })),
        })
        await waitFor(() => expect(screen.getByTestId('route-decisions')).toBeTruthy())
        const decisions = screen.getByTestId('route-decisions')
        for (const id of ['dell-kev:kev-latest', 'openrouter:~typesafe/jev-latest']) {
          fireEvent.change(within(decisions).getByLabelText('add to decisions'), { target: { value: id } })
          fireEvent.click(within(decisions).getByRole('button', { name: 'add decisions' }))
        }
        fireEvent.click(within(decisions).getByRole('button', { name: /save/i }))
        await waitFor(() => expect(api.putRoute).toHaveBeenCalledWith('decisions', ['dell-kev:kev-latest', 'openrouter:~typesafe/jev-latest']))
      })

      it('words a link that cannot answer its role as that, not as a failure of the provider', async () => {
        const explain: RouteExplain = {
          role: 'decisions',
          chain: [{ link: 1, id: 'hub:qwen3:8b', verdict: 'wrong_protocol', reason: 'hub answers chat — this role needs typed questions' }],
          would_serve: null,
          reason: 'no model in the \'decisions\' chain can serve right now',
        }
        const routes: Routes = { ...ROUTES, roles: ROUTES.roles.map(r => (r.role === 'decisions' ? { ...r, chain: ['hub:qwen3:8b'] } : r)) }
        renderSection({
          getRoutes: vi.fn(async () => routes),
          explainRoute: vi.fn(async (role: string) => (role === 'decisions' ? explain : { role, chain: [], would_serve: null, reason: 'no chain' })),
        })
        await waitFor(() => expect(screen.getByTestId('route-decisions-link-1').querySelector('[data-verdict]')).toBeTruthy())
        const badge = screen.getByTestId('route-decisions-link-1').querySelector('[data-verdict]')
        expect(badge?.textContent).toBe('cannot answer this role')
        expect(badge?.getAttribute('title')).toBe('hub answers chat — this role needs typed questions')
      })
    ```

- [ ] **Step 2: Run them to see them fail.**
  ```bash
  cd /home/jeremy/workspace/nova/.worktrees/decisions/apps/web && npm test -- RoutingSection
  ```
  Expected: FAIL — `route-decisions` renders its role name verbatim with "no chain of its
  own — uses the chat chain", every catalogue row is offered to every role, and the badge
  reads `wrong_protocol`. (`npx tsc --noEmit` also fails: `Routes` has no `protocol`.)

- [ ] **Step 3: The types.** In `apps/web/src/lib/api.ts`, the routing block (`:618-651`):
  ```ts
  /** The roles the gateway ships with; every other role is derived — a
   * core-side agent named `x` owns `agent_x` (S12). `decisions` answers typed
   * questions — the decision role — never chat. */
  export type BuiltinRole = 'chat' | 'scheduled' | 'judge' | 'decisions' | 'coding' | 'vision'
  /** Any routing role: a built-in or an agent's derived `agent_<name>`. */
  export type RouteRole = BuiltinRole | string
  /** The protocol a role's calls speak — the gateway's routing.protocol_of:
   * `systemone` (typed questions) for the decision role, `chat` for the rest. */
  export type RouteProtocol = 'chat' | 'systemone'
  ```
  `RouteVerdict.verdict` gains `'wrong_protocol'` in its union, with the comment
  `// wrong_protocol (decision role): the link's provider cannot answer this role.`, and
  `Routes.roles`' element type gains `protocol?: RouteProtocol`.

- [ ] **Step 4: The section.** In `apps/web/src/pages/settings/RoutingSection.tsx`:
  - imports: `type RouteProtocol,` joins the `lib/api` type imports, and
    `import { suitabilityEntries } from '../models/catalogFormat'`
  - `ROLE_WORDS` gains, after `judge`:
    ```ts
      decisions: {
        label: 'Decisions',
        note: 'a decision model answers typed questions before she replies — which tool the message needs, which recalled notes still hold; empty = none, and her turns run as before',
      },
    ```
  - `VERDICT_WORDS` gains:
    ```ts
      // The decision role: the link's provider cannot answer this role — a chat
      // model where typed questions are needed, or a decision model where chat is.
      wrong_protocol: 'cannot answer this role',
    ```
  - after `reasonOf`:
    ```ts
    /** A decision model: the catalogue says it outputs decisions — read from the
     * provider's own listing, never a list kept here. It is offered to the
     * decisions role and to no chat role; the gateway refuses the other pairing
     * by name, too. */
    export function isDecisionModel(row: CatalogRow): boolean {
      return suitabilityEntries(row, 'decisions').some(fact => fact.value === true)
    }
    ```
  - in `RoutingSection`'s map (`:189-210`), `<RoleEditor … protocol={entry.protocol ?? 'chat'} … />`
  - `RoleEditor`: the prop `protocol: RouteProtocol` (typed in its props object beside
    `reserved`), and inside:
    ```ts
      const wantsDecisions = protocol === 'systemone'
      const options = catalog
        // A `library:` row is a model on no machine yet: the gateway cannot
        // route to it, so it is never offered as a link (pull it on Models).
        // A decision model answers typed questions only: offered to the
        // decisions role, and to no other.
        .filter(r => (r.kind === 'local' || r.kind === 'cloud') && r.provider !== LIBRARY && !draft.includes(r.id) && r.id !== chatModel && isDecisionModel(r) === wantsDecisions)
        .map(r => ({ value: r.id, label: `${r.provider} · ${r.model}${r.installed === false ? ' (not installed)' : ''}` }))
    ```
    the empty-chain line:
    ```tsx
            {draft.length === 0 && role !== 'chat' && !reserved && (
              <li className="text-content-tertiary">
                {wantsDecisions ? 'no decision model — her turns run without one' : 'no chain of its own — uses the chat chain'}
              </li>
            )}
    ```
    and the picker's first item:
    `items={[{ value: '', label: wantsDecisions ? 'add a decision model…' : 'add a fallback…' }, ...options]}`

- [ ] **Step 5: Run the tests and the type check to see them pass.**
  ```bash
  cd /home/jeremy/workspace/nova/.worktrees/decisions/apps/web && npm test -- RoutingSection && npx tsc --noEmit
  ```
  Expected: PASS, and no type errors.

- [ ] **Step 6: Commit.**
  ```bash
  git -C /home/jeremy/workspace/nova/.worktrees/decisions add apps/web/src/lib/api.ts apps/web/src/pages/settings/RoutingSection.tsx apps/web/src/pages/settings/RoutingSection.test.tsx
  git -C /home/jeremy/workspace/nova/.worktrees/decisions commit -m "feat(web): the decisions role on Routing — its words, decision models only"
  git -C /home/jeremy/workspace/nova/.worktrees/decisions show --stat HEAD
  ```
  The commit body says why the role-order pins moved (a built-in role joined the
  gateway's list after `judge`).

---

### Task 11: The Jev Router switch on Settings → Routing (web)

**Files:**
- Modify: `apps/web/src/lib/api.ts` (after the routing types: `RouteRouter`, `Routes.roles[i].router`, `putJevRouter`)
- Modify: `apps/web/src/pages/settings/RoutingSection.tsx` (imports, `RoutingApi`,
  `DEFAULT_API`, the two constants, the section hands down the switch, `RoleEditor`
  renders it)
- Test: `apps/web/src/pages/settings/RoutingSection.test.tsx` (add)

**Interfaces:**
- Consumes (Tasks 5, 9): `GET /api/v1/routes` role entries carry
  `router: {on, kept} | null`; `PUT /api/v1/routes/{role}/jev-router` with `{on, link?}`
  answers `{role, chain, router}` or `{error}`; the catalogue lists
  `typesafe/jev-router` as a cloud row of whichever provider serves it.
- Produces:
  - `interface RouteRouter { on: boolean; kept: string | null }`
  - `putJevRouter(role: RouteRole, on: boolean, link?: string): Promise<{ role: RouteRole; chain: string[]; router: RouteRouter }>`
  - `export const JEV_ROUTER_MODEL = 'typesafe/jev-router'`,
    `export const JEV_ROUTER_BALANCES: string` (RoutingSection.tsx)
  - `RoutingApi.putJevRouter`

- [ ] **Step 1: Write the failing tests.** In `RoutingSection.test.tsx`:
  - `ApiName` gains `'putJevRouter'`; `renderSection`'s default api gains
    ```ts
        putJevRouter: vi.fn(async (role: string, on: boolean) => ({ role, chain: [], router: { on, kept: null } })),
    ```
  - after the fixtures:
    ```ts
    // The switch applies to chat, scheduled and agent roles; the gateway says so per role.
    const ROUTES_SWITCH: Routes = {
      ...ROUTES,
      roles: ROUTES.roles.map(r => ({ ...r, router: r.role === 'chat' || r.role === 'scheduled' ? { on: false, kept: null } : null })),
    }
    const ROUTER_ROW = row('openrouter:typesafe/jev-router', 'cloud')
    function catalogWith(...rows: CatalogRow[]) {
      return vi.fn(async () => ({ fetched_at: 't', sources: [], rows }))
    }
    ```
  - new tests:
    ```ts
      it('switches Jev Router on with the link the catalogue lists, then re-reads the chains', async () => {
        const api = renderSection({ getRoutes: vi.fn(async () => ROUTES_SWITCH), getCatalog: catalogWith(row('hub:qwen3:8b', 'local', true), ROUTER_ROW) })
        await waitFor(() => expect(screen.getByTestId('route-chat-router')).toBeTruthy())
        const panel = screen.getByTestId('route-chat-router')
        expect(panel.textContent).toContain('balancing quality, speed and cost')
        expect(panel.textContent).toContain('Link 1 stays the model picked in chat')
        const toggle = within(panel).getByRole('switch', { name: 'Let Jev Router pick the cloud model' }) as HTMLInputElement
        expect(toggle.checked).toBe(false)
        fireEvent.click(toggle)
        await waitFor(() => expect(api.putJevRouter).toHaveBeenCalledWith('chat', true, 'openrouter:typesafe/jev-router'))
        await waitFor(() => expect(api.getRoutes).toHaveBeenCalledTimes(2))
      })

      it('says what the switch took the place of, and switches off with no link', async () => {
        const on: Routes = { ...ROUTES_SWITCH, roles: ROUTES_SWITCH.roles.map(r => (r.role === 'scheduled' ? { ...r, chain: ['openrouter:typesafe/jev-router'], router: { on: true, kept: 'openrouter:openai/gpt-x' } } : r)) }
        const api = renderSection({ getRoutes: vi.fn(async () => on), getCatalog: catalogWith(ROUTER_ROW) })
        await waitFor(() => expect(screen.getByTestId('route-scheduled-router-kept')).toBeTruthy())
        expect(screen.getByTestId('route-scheduled-router-kept').textContent).toBe(
          'in place of openrouter:openai/gpt-x, which comes back when you switch it off',
        )
        fireEvent.click(within(screen.getByTestId('route-scheduled-router')).getByRole('switch', { name: 'Let Jev Router pick the cloud model' }))
        await waitFor(() => expect(api.putJevRouter).toHaveBeenCalledWith('scheduled', false, undefined))
      })

      it('offers no switch where it does not apply', async () => {
        renderSection({ getRoutes: vi.fn(async () => ROUTES_SWITCH), getCatalog: catalogWith(ROUTER_ROW) })
        await waitFor(() => expect(screen.getByTestId('route-chat-router')).toBeTruthy())
        for (const role of ['judge', 'decisions', 'coding', 'vision']) {
          expect(screen.queryByTestId(`route-${role}-router`)).toBeNull()
        }
      })

      it('cannot switch on while no provider lists Jev Router, and says why', async () => {
        const api = renderSection({ getRoutes: vi.fn(async () => ROUTES_SWITCH), getCatalog: catalogWith(row('hub:qwen3:8b', 'local', true)) })
        await waitFor(() => expect(screen.getByTestId('route-chat-router')).toBeTruthy())
        const panel = screen.getByTestId('route-chat-router')
        expect((within(panel).getByRole('switch', { name: 'Let Jev Router pick the cloud model' }) as HTMLInputElement).disabled).toBe(true)
        expect(panel.textContent).toContain('no provider lists typesafe/jev-router — add OpenRouter under Providers to use it')
        expect(api.putJevRouter).not.toHaveBeenCalled()
      })

      it('shows a refused switch in the gateway\'s words and keeps what the page knew', async () => {
        const refusal = 'scheduled has no chain of its own — it walks the chat chain; switch Jev Router on for chat, or give scheduled its own chain first'
        const api = renderSection({
          getRoutes: vi.fn(async () => ROUTES_SWITCH),
          getCatalog: catalogWith(ROUTER_ROW),
          putJevRouter: vi.fn(async () => { throw new Error(refusal) }),
        })
        await waitFor(() => expect(screen.getByTestId('route-scheduled-router')).toBeTruthy())
        fireEvent.click(within(screen.getByTestId('route-scheduled-router')).getByRole('switch', { name: 'Let Jev Router pick the cloud model' }))
        await waitFor(() => expect(screen.getByTestId('route-scheduled-router-error').textContent).toBe(`could not switch — ${refusal}`))
        expect(api.getRoutes).toHaveBeenCalledTimes(1)
      })
    ```

- [ ] **Step 2: Run them to see them fail.**
  ```bash
  cd /home/jeremy/workspace/nova/.worktrees/decisions/apps/web && npm test -- RoutingSection
  ```
  Expected: FAIL — no `route-chat-router` anywhere.

- [ ] **Step 3: The API.** In `apps/web/src/lib/api.ts`, after `RouteProtocol`:
  ```ts
  /** The Jev Router switch on a role (decision-role spec §4). `on` is DERIVED by
   * the gateway from the chain — a Jev Router link is in it; `kept` is the
   * cloud link it took the place of ('' when it replaced none and was added
   * after the local links), null when off. Null where the switch is not offered. */
  export interface RouteRouter {
    on: boolean
    kept: string | null
  }
  ```
  `Routes.roles`' element type gains `router?: RouteRouter | null`, and after `putRoute`:
  ```ts
  /** Switch Jev Router on or off for a role — an edit to its chain, which stays
   * the one source of truth. `link` is the provider:model that serves Jev
   * Router, read from the live catalogue; only switching on needs it. */
  export const putJevRouter = (role: RouteRole, on: boolean, link?: string) =>
    apiSend<{ role: RouteRole; chain: string[]; router: RouteRouter }>(
      `/api/v1/routes/${encodeURIComponent(role)}/jev-router`,
      'PUT',
      link ? { on, link } : { on },
    )
  ```

- [ ] **Step 4: The switch.** In `RoutingSection.tsx`:
  - imports: `Toggle` joins the `components/ui` import; `putJevRouter as apiPutJevRouter`
    and `type RouteRouter` join the `lib/api` imports
  - `RoutingApi` gains `putJevRouter: typeof apiPutJevRouter`; `DEFAULT_API` gains
    `putJevRouter: apiPutJevRouter,`
  - after `VERDICT_WORDS`:
    ```ts
    /** Jev Router's model id (decision-role spec §4). The LINK is whichever
     * registered provider's listing carries it — read from the live catalogue,
     * never assumed to be a provider named openrouter. */
    export const JEV_ROUTER_MODEL = 'typesafe/jev-router'
    /** What the switch says Jev Router does. OpenRouter lists no parameters for
     * typesafe/jev-router (supported_parameters is empty, checked 2026-09-28), so
     * there is no quality-first setting to turn on — the spec's fallback: say what
     * it balances. */
    export const JEV_ROUTER_BALANCES =
      'Jev Router picks a model and reasoning effort for each request, balancing quality, speed and cost, and you pay for the model it picks. It has no setting to put quality first.'
    ```
  - in `RoutingSection`, after the state hooks:
    ```ts
      // The link that serves Jev Router, from the catalogue the page already read.
      const routerLink = catalog.find(r => r.kind === 'cloud' && r.model === JEV_ROUTER_MODEL)?.id ?? null
    ```
    and the `RoleEditor` element gains:
    ```tsx
                  router={entry.router ?? null}
                  routerLink={routerLink}
                  onRouter={async on => {
                    await api.putJevRouter(entry.role, on, on ? routerLink ?? undefined : undefined)
                    await load()
                  }}
    ```
  - `RoleEditor`'s props gain `router: RouteRouter | null`, `routerLink: string | null`,
    `onRouter: (on: boolean) => Promise<void>`; its state gains
    ```ts
      const [routerBusy, setRouterBusy] = useState(false)
      const [routerError, setRouterError] = useState<string | null>(null)
      const flipRouter = async (on: boolean) => {
        setRouterBusy(true)
        setRouterError(null)
        try {
          await onRouter(on)
        } catch (err) {
          setRouterError(reasonOf(err))
        } finally {
          setRouterBusy(false)
        }
      }
    ```
    and, after the chain editor's `{editable && (…)}` block:
    ```tsx
          {router && editable && (
            <div className="mt-2 space-y-1" data-testid={`route-${role}-router`}>
              <Toggle
                id={`jev-router-${role}`}
                size="sm"
                checked={router.on}
                disabled={routerBusy || (!router.on && !routerLink)}
                onChange={on => void flipRouter(on)}
                label="Let Jev Router pick the cloud model"
              />
              <p className="text-caption text-content-tertiary">{JEV_ROUTER_BALANCES}</p>
              {role === 'chat' && (
                <p className="text-caption text-content-tertiary">
                  Link 1 stays the model picked in chat; the switch changes the cloud link behind it.
                </p>
              )}
              {router.on && router.kept && (
                <p className="text-caption text-content-tertiary" data-testid={`route-${role}-router-kept`}>
                  in place of {router.kept}, which comes back when you switch it off
                </p>
              )}
              {router.on && router.kept === '' && (
                <p className="text-caption text-content-tertiary" data-testid={`route-${role}-router-kept`}>
                  added after the local links; switching it off removes it
                </p>
              )}
              {!router.on && !routerLink && (
                <p className="text-caption text-content-tertiary">
                  no provider lists {JEV_ROUTER_MODEL} — add OpenRouter under Providers to use it
                </p>
              )}
              {routerError && (
                <p role="alert" className="text-caption text-danger" data-testid={`route-${role}-router-error`}>
                  could not switch — {routerError}
                </p>
              )}
            </div>
          )}
    ```

- [ ] **Step 5: Run the tests and the type check to see them pass.**
  ```bash
  cd /home/jeremy/workspace/nova/.worktrees/decisions/apps/web && npm test -- RoutingSection && npx tsc --noEmit
  ```
  Expected: PASS.

- [ ] **Step 6: Commit.**
  ```bash
  git -C /home/jeremy/workspace/nova/.worktrees/decisions add apps/web/src/lib/api.ts apps/web/src/pages/settings/RoutingSection.tsx apps/web/src/pages/settings/RoutingSection.test.tsx
  git -C /home/jeremy/workspace/nova/.worktrees/decisions commit -m "feat(web): the Jev Router switch on chat, scheduled and agent roles"
  git -C /home/jeremy/workspace/nova/.worktrees/decisions show --stat HEAD
  ```

---

### Task 12: Decision models on Models, kept out of the chat picker, and the Kev preset on Providers (web)

**Files:**
- Modify: `apps/web/src/lib/api.ts:1794-1866` (provider types)
- Modify: `apps/web/src/pages/models/catalogFormat.ts:19-30` (`SUITABILITY_KEYS`)
- Modify: `apps/web/src/pages/chat/ModelSelector.tsx:50-60` (`cloudGroups`)
- Modify: `apps/web/src/pages/settings/ProvidersSection.tsx:23` (imports), `:80-84`
  (`ADAPTER_LABELS`), `:110-128` (`Draft`), `:173-219` (`choosePreset`, `save`),
  `:392-435` (protocol, auth, local), `:580-601` (the local badge), `:709-730` (no typed
  model id for a decision server), `:757-797` (no chat "Use" on a decision model)
- Modify (pins): `apps/web/src/pages/settings/ProvidersSection.test.tsx:6-50` (the row
  factories gain `local`), `:175-183` (the exact payload gains `local: false`)
- Test: `ProvidersSection.test.tsx`, `apps/web/src/pages/chat/ModelSelector.test.tsx`,
  `apps/web/src/pages/models/catalogFormat.test.ts` (add)

**Interfaces:**
- Consumes (Tasks 2, 4): providers carry `local` and may be `adapter: 'systemone'`; a
  provider's listing rows carry `output_modalities`; catalogue decision rows carry
  `suitability.decisions` and `actions: []`; the `kev` preset carries `local: true`.
- Produces:
  - `ProviderAdapter` gains `'systemone'`; `Provider.local: boolean`;
    `ProviderWrite.local?: boolean`; `ProviderPreset.local?: boolean`;
    `ProviderModel.output_modalities?: string[]`
  - `SUITABILITY_KEYS` gains `'decisions'`
  - `cloudGroups(rows)` lists only rows whose `actions` include `use`

- [ ] **Step 1: Write the failing tests.**
  - `apps/web/src/pages/chat/ModelSelector.test.tsx` — import
    `import { ModelSelector, cloudGroups } from './ModelSelector'` and
    `import type { CatalogRow, Suggestion } from '../../lib/api'`, then add:
    ```ts
      it('never lists a decision model among the chat models', () => {
        // Review focus 2: picking one would end every chat turn. The gateway
        // offers it no `use` action; the picker lists only what it offers.
        const gpt: CatalogRow = { id: 'openrouter:openai/gpt-x', provider: 'openrouter', model: 'openai/gpt-x', label: 'GPT X', kind: 'cloud', sources: [], facts: {}, capabilities: {}, suitability: {}, actions: ['use'] }
        const jev: CatalogRow = {
          id: 'openrouter:~typesafe/jev-latest', provider: 'openrouter', model: '~typesafe/jev-latest', label: 'TypeSafe: Jev Latest', kind: 'cloud', sources: [], facts: {}, capabilities: {},
          suitability: { decisions: { value: true, basis: 'declared', source: 'provider-listing' } },
          actions: [],
        }
        expect(cloudGroups([gpt, jev])).toEqual([{ provider: 'openrouter', rows: [gpt] }])
      })
    ```
  - `apps/web/src/pages/models/catalogFormat.test.ts` — import `SUITABILITY_KEYS` too, then:
    ```ts
      it('filters to decision models by their declared suitability', () => {
        const jev = row({ id: 'openrouter:~typesafe/jev-latest', suitability: { decisions: { value: true, basis: 'declared', source: 'provider-listing' } } })
        const gpt = row({ id: 'openrouter:openai/gpt-x', actions: ['use'] })
        expect(SUITABILITY_KEYS).toContain('decisions')
        expect(applyFacets([jev, gpt], { ...EMPTY_FACETS, suitability: 'decisions' }).rows).toEqual([jev])
      })
    ```
  - `apps/web/src/pages/settings/ProvidersSection.test.tsx`:
    - the factory `provider()` gains `local: false,` after `is_default: false,`; `HUB` gains
      `local: true,` (the bundled engine runs here);
    - the OpenRouter-preset test's exact payload (`:175-183`) gains `local: false,` after
      `auth_shape: 'static-bearer',` — a provider is not local unless the owner says so;
    - new tests:
    ```ts
      it('adds a Kev server from its preset as a local decision-model server', async () => {
        const KEV: ProviderPreset = {
          name: 'kev',
          label: 'Kev decision-model server (your own machine)',
          adapter: 'systemone',
          base_url: 'http://{host}:8009/v1',
          auth_shape: 'none',
          local: true,
          placeholders: ['host'],
        }
        const { api } = renderSection({
          getProviders: vi.fn(async () => [HUB]),
          getProviderPresets: vi.fn(async () => [...PRESETS, KEV]),
          createProvider: vi.fn(async (p: { name: string }) => provider({ name: p.name, adapter: 'systemone', local: true })),
        })
        await waitFor(() => expect(screen.getByRole('button', { name: /add a provider/i })).toBeTruthy())
        fireEvent.click(screen.getByRole('button', { name: /add a provider/i }))
        const form = screen.getByTestId('provider-form')
        fireEvent.change(within(form).getByLabelText('Preset'), { target: { value: 'kev' } })
        fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'dell-kev' } })
        fireEvent.change(within(form).getByLabelText('host'), { target: { value: '100.122.40.93' } })
        expect((within(form).getByLabelText(/Runs on my own machine/) as HTMLInputElement).checked).toBe(true)
        expect(within(form).queryByLabelText('API key')).toBeNull()
        fireEvent.submit(form)

        await waitFor(() => expect(api.createProvider).toHaveBeenCalledTimes(1))
        expect(api.createProvider.mock.calls[0][0]).toEqual({
          name: 'dell-kev',
          adapter: 'systemone',
          base_url: 'http://100.122.40.93:8009/v1',
          auth_shape: 'none',
          local: true,
          preset: 'kev',
        })
      })

      it('a custom provider is local only when the owner ticks it', async () => {
        const { api } = renderSection({ getProviders: vi.fn(async () => [HUB]) })
        await waitFor(() => expect(screen.getByRole('button', { name: /add a provider/i })).toBeTruthy())
        fireEvent.click(screen.getByRole('button', { name: /add a provider/i }))
        const form = screen.getByTestId('provider-form')
        fireEvent.change(within(form).getByLabelText('Preset'), { target: { value: '__custom__' } })
        fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'lanbox' } })
        fireEvent.change(within(form).getByLabelText('Base URL'), { target: { value: 'http://192.0.2.10:11434/v1' } })
        fireEvent.change(within(form).getByLabelText('Auth'), { target: { value: 'none' } })
        fireEvent.click(within(form).getByLabelText(/Runs on my own machine/))
        fireEvent.submit(form)

        await waitFor(() => expect(api.createProvider).toHaveBeenCalledTimes(1))
        expect(api.createProvider.mock.calls[0][0]).toEqual(expect.objectContaining({ name: 'lanbox', local: true }))
      })

      it('never offers a decision model as the chat model', async () => {
        // Review focus 2: "Use" writes chat.model, and a decision model has no chat.
        const withJev: ProviderListing = {
          ...LISTING,
          models: [...LISTING.models, { id: '~typesafe/jev-latest', owned_by: 'openrouter', name: 'TypeSafe: Jev Latest', output_modalities: ['decisions'] }],
        }
        renderSection({ getProviderModels: vi.fn(async () => withJev) })
        await waitFor(() => expect(screen.getByTestId('provider-openrouter')).toBeTruthy())
        fireEvent.click(screen.getByTestId('toggle-models-openrouter'))
        await waitFor(() => expect(screen.getByTestId('model-~typesafe/jev-latest')).toBeTruthy())

        const jev = screen.getByTestId('model-~typesafe/jev-latest')
        expect(within(jev).queryByRole('button', { name: /use/i })).toBeNull()
        expect(jev.textContent).toContain('decision model — add it under Routing → Decisions')
        const sonnet = screen.getByTestId('model-anthropic/claude-sonnet-5')
        expect(within(sonnet).getByRole('button', { name: /use anthropic\/claude-sonnet-5/i })).toBeTruthy()
      })

      it('a decision-model server offers no chat model at all, even typed', async () => {
        const kev = provider({ name: 'dell-kev', adapter: 'systemone', base_url: 'http://100.122.40.93:8009/v1', auth_shape: 'none', api_key: null, local: true, preset: 'kev' })
        renderSection({
          getProviders: vi.fn(async () => [HUB, kev]),
          getProviderModels: vi.fn(async () => { throw new Error('http://100.122.40.93:8009/v1/models answered 404 — this server has no model listing; type a model id') }),
        })
        await waitFor(() => expect(screen.getByTestId('provider-dell-kev')).toBeTruthy())
        const row = screen.getByTestId('provider-dell-kev')
        expect(row.textContent).toContain('Decision-model server (typed questions)')
        expect(row.textContent).toContain('local')
        fireEvent.click(screen.getByTestId('toggle-models-dell-kev'))
        await waitFor(() => expect(screen.getByTestId('provider-models-dell-kev').textContent).toContain('A decision-model server has no chat model to pick'))
        expect(within(screen.getByTestId('provider-models-dell-kev')).queryByRole('button', { name: /use/i })).toBeNull()
      })
    ```

- [ ] **Step 2: Run them to see them fail.**
  ```bash
  cd /home/jeremy/workspace/nova/.worktrees/decisions/apps/web && npm test -- ModelSelector catalogFormat ProvidersSection
  ```
  Expected: FAIL — the decision row is listed, `decisions` is no suitability key, the Kev
  preset sends no `local`, and the decision model has a Use button.

- [ ] **Step 3: The provider types.** In `apps/web/src/lib/api.ts` (`:1794-1866`):
  ```ts
  /** The wire protocols a provider row can name. Vendors are not the unit;
   * protocols are: everything OpenAI-shaped (OpenAI, OpenRouter, Groq, Azure
   * v1, Bedrock, Gemini's compat layer, …) is `openai-chat`; a decision-model
   * server (a Kev box — typed questions only, no chat) is `systemone`. */
  export type ProviderAdapter = 'ollama' | 'openai-chat' | 'anthropic-messages' | 'systemone'
  ```
  `Provider` gains, after `is_default`:
  ```ts
    /** Runs on the owner's own machine: its calls are never priced and never
     * capped. The owner's to say (decision-role spec §1); an engine always is. */
    local: boolean
  ```
  `ProviderWrite` and `ProviderPreset` gain `local?: boolean`; `ProviderModel` gains
  ```ts
    /** What the model produces, when the listing says: ['text'], or
     * ['decisions'] for a decision model — which has no chat. */
    output_modalities?: string[]
  ```

- [ ] **Step 4: The Models facet and the chat picker.**
  - `apps/web/src/pages/models/catalogFormat.ts:19-30`: `'decisions',` joins
    `SUITABILITY_KEYS` after `'chat',`.
  - `apps/web/src/pages/chat/ModelSelector.tsx`, `cloudGroups`:
    ```ts
    /** Cloud rows grouped by provider, in the catalogue's order — only the rows
     * the gateway offers as the chat model (`use`). A decision model answers
     * typed questions and has no chat; picking one would end every turn. */
    export function cloudGroups(rows: CatalogRow[]): { provider: string; rows: CatalogRow[] }[] {
      const groups = new Map<string, CatalogRow[]>()
      for (const row of rows) {
        if (row.kind !== 'cloud' || !(Array.isArray(row.actions) && row.actions.includes('use'))) continue
        const list = groups.get(row.provider) ?? []
        list.push(row)
        groups.set(row.provider, list)
      }
      return Array.from(groups, ([provider, rows]) => ({ provider, rows }))
    }
    ```

- [ ] **Step 5: Providers.** In `apps/web/src/pages/settings/ProvidersSection.tsx`:
  - `Checkbox` joins the `components/ui` import; `type ProviderModel` is already imported.
  - `ADAPTER_LABELS` gains:
    ```ts
      // A decision-model server (a Kev box): typed questions for the Decisions
      // role, and no chat.
      systemone: 'Decision-model server (typed questions)',
    ```
  - `Draft` gains `local: boolean`; `EMPTY_DRAFT` gains `local: false`; `choosePreset`'s
    `setDraft({...})` gains `local: preset.local ?? false,`; `save`'s `createProvider`
    payload gains `local: draft.local,` after `auth_shape`.
  - the Protocol select (`:392-411`): its `onChange` sets
    ```ts
                        auth_shape:
                          adapter === 'anthropic-messages'
                            ? 'api-key-header'
                            : adapter === 'systemone' && d.auth_shape === 'api-key-header'
                              ? 'static-bearer'
                              : d.auth_shape,
    ```
    and its items gain `{ value: 'systemone', label: ADAPTER_LABELS.systemone },`
  - the Auth select's items (`:419-423`) are filtered for a decision server, which takes a
    bearer key or none:
    ```tsx
                  items={[
                    { value: 'static-bearer', label: 'Authorization: Bearer <key>' },
                    { value: 'api-key-header', label: 'api-key: <key> (Azure-shaped)' },
                    { value: 'none', label: 'No auth (a trusted endpoint on your network)' },
                  ].filter(item => draft.adapter !== 'systemone' || item.value !== 'api-key-header')}
    ```
  - after the Auth select, for every preset and custom:
    ```tsx
              <Checkbox
                label="Runs on my own machine"
                description="Free: its calls are never priced and never count against a spend cap."
                checked={draft.local}
                onChange={checked => setDraft(d => ({ ...d, local: checked }))}
              />
    ```
  - `ProviderRow`, after the adapter badge (`:582-584`):
    ```tsx
            {provider.local && !provider.builtin && (
              <Badge size="sm" color="neutral">
                local
              </Badge>
            )}
    ```
    and before `const visible = …`:
    ```ts
      // A decision model answers typed questions and has no chat: never offered
      // as the chat model — its place is the Decisions chain on Settings → Routing.
      const isDecisionModel = (model: ProviderModel) =>
        provider.adapter === 'systemone' || (model.output_modalities ?? []).includes('decisions')
    ```
  - the `listingError` block (`:709-730`) offers a typed model id only to a chat provider:
    ```tsx
              {listingError && (
                <div className="space-y-2">
                  <p className="text-caption text-content-tertiary">{listingError}</p>
                  {provider.adapter === 'systemone' ? (
                    <p className="text-caption text-content-tertiary">
                      A decision-model server has no chat model to pick — add its model to the Decisions chain under Routing.
                    </p>
                  ) : (
                    <form
                      className="flex items-end gap-2"
                      onSubmit={e => {
                        e.preventDefault()
                        if (manualModel.trim()) void use(manualModel.trim())
                      }}
                    >
                      <Input
                        label={`Model id for ${provider.name}`}
                        value={manualModel}
                        onChange={e => setManualModel(e.target.value)}
                        placeholder={provider.model_note ?? 'model id'}
                      />
                      <Button type="submit" size="sm" disabled={!manualModel.trim()}>
                        Use
                      </Button>
                    </form>
                  )}
                </div>
              )}
    ```
  - each model row's right-hand side (`:778-794`):
    ```tsx
                          <span className="ml-auto">
                            {isDecisionModel(model) ? (
                              <span className="text-caption text-content-tertiary" data-testid={`decision-model-${model.id}`}>
                                decision model — add it under Routing → Decisions
                              </span>
                            ) : current ? (
                              <Badge size="sm" color="success">
                                <Check size={10} /> current
                              </Badge>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                loading={switching === model.id}
                                onClick={() => void use(model.id)}
                                aria-label={`use ${model.id}`}
                              >
                                Use
                              </Button>
                            )}
                          </span>
    ```

- [ ] **Step 6: Run the tests and the type check to see them pass, then the whole web suite.**
  ```bash
  cd /home/jeremy/workspace/nova/.worktrees/decisions/apps/web && npm test -- ModelSelector catalogFormat ProvidersSection && npx tsc --noEmit
  cd /home/jeremy/workspace/nova/.worktrees/decisions/apps/web && npm test 2>&1 | tail -5
  ```
  Expected: PASS, no type errors, and the whole suite green.

- [ ] **Step 7: Commit.**
  ```bash
  git -C /home/jeremy/workspace/nova/.worktrees/decisions add apps/web/src/lib/api.ts apps/web/src/pages/models/catalogFormat.ts apps/web/src/pages/models/catalogFormat.test.ts apps/web/src/pages/chat/ModelSelector.tsx apps/web/src/pages/chat/ModelSelector.test.tsx apps/web/src/pages/settings/ProvidersSection.tsx apps/web/src/pages/settings/ProvidersSection.test.tsx
  git -C /home/jeremy/workspace/nova/.worktrees/decisions commit -m "feat(web): decision models listed and never offered as chat; the Kev preset and a local tick on Providers"
  git -C /home/jeremy/workspace/nova/.worktrees/decisions show --stat HEAD
  ```
  The commit body says why the provider payload pin moved (`local` is sent on every save).

---

### Task 13: Write it down — the roadmap row, the optional list, ARCS, and deploy/README

**Files:**
- Modify: `docs/plans/rebuild/ROADMAP.md:22-24` (where things stand), `:40-41` (a row in the
  order of work), `:242-243` (the optional-list entry), `:333` (the index)
- Modify: `docs/plans/rebuild/ARCS.md:480-485` and `:516-520` (the Jev section's two
  statements this slice makes false)
- Modify: `deploy/README.md` (a new "Decision models" section between "Machines" and
  "Tailnet access", `:80`)

**Interfaces:**
- Consumes: every task above (the docs describe what shipped: the role, `/v1/systemone`,
  the `systemone` adapter, `local`, the Kev preset, the 5 s budget, the `decisions` span,
  the switch, `routed_to`).
- Produces: nothing code reads.

- [ ] **Step 1: The roadmap.** In `docs/plans/rebuild/ROADMAP.md`:
  - "Where things stand" (`:22-24`) gains a last sentence:
    ```
    **The decision role** (Jev and Kev) was pulled forward from the optional list by the
    owner on 2026-09-27 and is being built on `slice/decisions` — spec and plan in
    [`decision-role/`](decision-role/spec.md).
    ```
  - the order of work gains, after the S40–S49 row (`:40`):
    ```
    | — | **The decision role — Jev and Kev** ([`decision-role/spec.md`](decision-role/spec.md)) | **Pulled forward 2026-09-27** from the optional list, by the owner. Built on `slice/decisions` ([plan](decision-role/plan.md)): the gateway's `decisions` role and `POST /v1/systemone`; core asks two questions per turn (the tool hint, the recall check), fail-open in 5 s; Routing and Models; a Jev Router switch per role. **Measured, not yet done:** the whole corpus × 3 on `dell:qwen3:8b`, decisions off and on, is owed (plan Task 14). The Kev engine on the Dell (spec §5) is a separate, later plan. |
    ```
  - the optional-list entry's heading (`:242`) becomes
    `### Jev and Kev (added 2026-09-25, re-checked the same day) — PULLED FORWARD 2026-09-27`,
    and its first line is a new bullet:
    ```
    - **Pulled forward 2026-09-27 by the owner** — now the decision role:
      [`decision-role/spec.md`](decision-role/spec.md), its plan beside it. What follows
      is the 2026-09-25 research, kept as written. Where it and the spec disagree, the
      spec's measurements on this stack win; the "first experiment" named below — a
      per-turn tool hint for the 8B, measured through the eval runner — is the spec's §2.
    ```
  - the index table gains, after the S41–S49 row (`:333`):
    ```
    | — | the decision role (Jev, Kev) | `decision-role/spec.md`, `decision-role/plan.md` — **in progress** |
    ```

- [ ] **Step 2: ARCS.** In `docs/plans/rebuild/ARCS.md`, the Jev section:
  - the intro's "Nothing about this is in the repo yet and nothing here has been measured
    on this stack" (`:483-485`) gains, after its sentence:
    ```
    *(2026-09-28: it is being built — the decision role, [`decision-role/spec.md`](decision-role/spec.md),
    whose measurements on this stack supersede the vendor figures here.)*
    ```
  - after the "*Corrected 2026-09-25:*" paragraph (`:516-520`):
    ```
    *Corrected 2026-09-28:* the decision role adds `POST /v1/systemone` to the gateway. It
    forwards typed questions to any link whose adapter carries that protocol, so the
    existing `openrouter` provider — an `openai-chat` row — serves both chat and Jev with
    the same key, and a `systemone` adapter makes a Kev server a provider. OpenRouter lists
    Jev only when asked for `?output_modalities=decisions`; the gateway asks. The paragraph
    above describes the gateway before that.
    ```

- [ ] **Step 3: deploy/README.** Insert before `## Tailnet access` (`:81`):
  ```markdown
  ## Decision models (Jev and Kev)

  Since the decision role (`docs/plans/rebuild/decision-role/spec.md`), a **decision
  model** can answer two typed questions on each chat turn you type, before Nova does:
  which of her tools the message needs, and which recalled notes are still right for it.
  The answer becomes one hint line in her turn and a smaller set of notes. She still
  decides, and every guard still judges what she writes.

  - **Where it is set.** The `decisions` routing role, in Settings → Routing, edited like
    chat's chain. Its links are decision models, never chat models (the gateway refuses
    the mix, by name):
    - **Jev** (cloud): `openrouter:~typesafe/jev-latest`, through the existing `openrouter`
      provider and its key. Models lists it under Cloud with a `decisions` tag. Metered
      under the `decisions` role on the Spend page (about $0.00001 a question).
    - **Kev** (your own machine): Providers → Add → the **Kev** preset — the `systemone`
      adapter at `http://<host>:8009/v1`, ticked "Runs on my own machine", so it is never
      priced or capped. The server is started by hand until the Kev engine exists:
      `kev.serve --run jaredpalmer/kev-4b --host 0.0.0.0 --port 8009`.
  - **With no decision model** — an empty chain, which is how every install starts — nothing
    changes: each turn runs exactly as before, and its trace says why.
  - **The budget.** The whole step has 5 seconds per turn (`decisions.TURN_BUDGET_S` in
    core). A slow or unreachable decision model costs the hint, never the turn, and a
    decision is applied whole or not at all. A decision server that refuses or cannot be
    reached is walled like any provider and the next link answers. A LOCAL provider's
    wall is never cleared by a success (the rule every local provider has): it expires on
    its own ladder — 1, 5, then 30 minutes — or clear it from Settings → Routing.
  - **Where it does not run (yet).** Scheduled firings, a drained queue, and agents' turns.
    The eval runner's turns do run it, because they measure the chat path.
  - **Reading it.** Each turn it ran on has one `decisions` span: the hint, its fit and the
    gate, every note's scores and verdict by path (never its text), who served, and — as
    the span's duration — how long it took:
    `SELECT meta, duration_ms FROM turn_spans WHERE turn_id = '<id>' AND kind = 'decisions';`
  - **The Jev Router switch.** Settings → Routing shows "Let Jev Router pick the cloud
    model" on Chat, Scheduled and each agent's role. On, the role's first cloud link becomes
    `openrouter:typesafe/jev-router`, which picks a model and reasoning effort per request,
    balancing quality, speed and cost — you pay for the model it picks. Off puts the link
    it replaced back. Local links stay first, and chat's own pick stays link 1. The model it
    picked is on the round's `llm_call` span as `routed_to`.
  ```

- [ ] **Step 4: Check the links resolve, then commit.**
  ```bash
  cd /home/jeremy/workspace/nova/.worktrees/decisions && ls docs/plans/rebuild/decision-role/spec.md docs/plans/rebuild/decision-role/plan.md
  git -C /home/jeremy/workspace/nova/.worktrees/decisions add docs/plans/rebuild/ROADMAP.md docs/plans/rebuild/ARCS.md deploy/README.md
  git -C /home/jeremy/workspace/nova/.worktrees/decisions commit -m "docs(decisions): the roadmap row, the optional list pulled forward, ARCS corrected, deploy/README"
  git -C /home/jeremy/workspace/nova/.worktrees/decisions show --stat HEAD
  ```

---

### Task 14: Land it, deploy it from the nova directory, measure it through the eval runner, walk it, write it down

This task is the spec's "Done means". Nothing here is finished while it exists only in the
worktree, and nothing is claimed that a number or a trace did not show.

**Files:**
- Create (NOT in git): `$SDD/measure_decisions.py` — the measurement harness, beside the
  spike probes it grew from (`kev_recipe.py`, `probe_jev_turn.py`) — and
  `$SDD/compare_arms.py`; their logs `$SDD/measure-*.jsonl`
- Modify: `docs/plans/rebuild/decision-role/plan.md` (a close-out section at the end),
  `docs/plans/rebuild/ROADMAP.md` (the row's state and numbers)
- Create: `docs/plans/rebuild/decision-role/carries.md` (only if something is unfinished)

**Interfaces:**
- Consumes: everything above, deployed. `runner.run_case(app, pool, case, model) -> EvalRun`
  and `runner.warm_up_model(app, model) -> (ms, note)`; `cases_mod.load_cases()`;
  `chat._recall`; `decisions.run`, `decisions.Advice`, `decisions.request_body`.
- Produces: the numbers the spec's "Done means" asks for, and the walk's turn ids.

- [ ] **Step 1: The whole branch, by hand.**
  ```bash
  . "$SCRATCHPAD/decisions.env" && cd /home/jeremy/workspace/nova/.worktrees/decisions/services/core && uv run ruff check app tests && TEST_DATABASE_URL="$CORE_DB" uv run pytest -q --timeout=120 2>&1 | tail -3
  . "$SCRATCHPAD/decisions.env" && cd /home/jeremy/workspace/nova/.worktrees/decisions/services/gateway && uv run ruff check app tests && TEST_DATABASE_URL="$GATEWAY_DB" uv run pytest -q 2>&1 | tail -3
  cd /home/jeremy/workspace/nova/.worktrees/decisions/apps/web && npm test 2>&1 | tail -4 && npx tsc --noEmit && npm run build 2>&1 | tail -2
  ```
  Expected: every suite green. Any red is reported with its output; nothing merges red.

- [ ] **Step 2: A whole-branch review.** Request a code review of `origin/main...slice/decisions`
  (superpowers:requesting-code-review) with `spec.md` as the requirement and this plan's
  "Plan decisions" as the choices to check. Fix what it finds; re-run Step 1.

- [ ] **Step 3: Rebase if another lane landed first.**
  `git -C /home/jeremy/workspace/nova/.worktrees/decisions fetch origin && git -C /home/jeremy/workspace/nova/.worktrees/decisions rebase origin/main`.
  A migration number taken in the meantime (gateway 010/011) is renumbered here, once, to
  the next free pair; re-run Step 1.

- [ ] **Step 4: Push and open the PR.** Write the PR body to `$SCRATCHPAD/decisions-pr-body.md`:
  one line naming the spec and this plan, one line per suite with the passed/failed counts
  Step 1 printed, a line saying the measurement (Step 7) runs after deploy, then the
  attribution lines. Then:
  ```bash
  git -C /home/jeremy/workspace/nova/.worktrees/decisions push -u origin slice/decisions
  cd /home/jeremy/workspace/nova/.worktrees/decisions && env -u GH_TOKEN gh pr create --base main --head slice/decisions --title "The decision role: Jev and Kev decide what her turn needs, and a Jev Router switch" --body-file "$SCRATCHPAD/decisions-pr-body.md"
  ```
  Merging is the owner's call. Ask him to merge, and wait.

- [ ] **Step 5: Deploy from the nova directory** (owner rule 2026-09-25 — never from a worktree):
  ```bash
  git -C /home/jeremy/workspace/nova status --short
  git -C /home/jeremy/workspace/nova fetch origin && git -C /home/jeremy/workspace/nova checkout --detach origin/main
  git -C /home/jeremy/workspace/nova log -1 --format='%h %s'
  cd /home/jeremy/workspace/nova/deploy && docker compose config --services
  cd /home/jeremy/workspace/nova/deploy && docker compose build gateway core web && docker compose up -d gateway core web
  cd /home/jeremy/workspace/nova/deploy && docker compose logs --no-log-prefix gateway 2>&1 | grep -E "applied migration 01[01]_"
  ```
  Run compose FROM `deploy/`, with no `-f` (the GPU-overlay trap). `config --services` must
  list the v4 services; a `status --short` line the checkout would touch is someone else's
  work — stop and ask. Expected: `docker compose ps` shows gateway, core and web healthy, and
  the log shows `applied migration 010_systemone_adapter.sql` and `011_router_switch.sql`.

- [ ] **Step 6: The owner sets the decision role up, in Settings** (his configuration — the
  walk driver may drive the web UI on :3000 for him, never curl):
  1. Kev-4B is running on the Dell (`kev.serve --run jaredpalmer/kev-4b --host 0.0.0.0 --port 8009`).
  2. Providers → Add a provider → preset **Kev** → Name `dell-kev`, host `100.122.40.93` →
     Verify and save. Expected: the row says "Decision-model server (typed questions)",
     "local", and "2 decision models listed".
  3. Models → Cloud: `openrouter:~typesafe/jev-latest` is listed with a `decisions` tag and
     no Use button; Installed: `dell-kev:kev-latest` the same.
  4. Routing → Decisions → add `dell-kev:kev-latest`, then `openrouter:~typesafe/jev-latest`
     → Save. Expected: "right now: dell-kev:kev-latest would answer".

- [ ] **Step 7: Measure through the eval runner.** No Quality-page suite run may be in flight
  (the GPU is shared; ask the owner). Create `$SDD/measure_decisions.py` (with the Write
  tool — it is not in the repo) with exactly this content:
  ```python
  """Measure the decision role through the eval runner (decision-role spec, "Done means").

  Runs INSIDE the deployed core container (it imports the running code), from deploy/:
      docker compose exec -T -e ARM=off core python - < "$SDD/measure_decisions.py"

  ARM=off      decisions.run is replaced, for this process only, by a stub returning
               decisions.Advice(): no call, no span, no hint, every note — the turn exactly
               as it was before the slice. The owner's chain is never touched.
  ARM=on       the real decisions.run against the live decisions chain, or, with
               DECISION_MODEL=<provider:model>, that link pinned as link 1 for this process.
  ARM=latency  decisions.run alone, RUNS times, on the S47 message: the step's own latency.
  Every case runs RUNS times (default 3) through runner.run_case on MODEL (default
  dell:qwen3:8b). CASES narrows the corpus; MESSAGE replaces a case's message; OWNER=owner
  makes recall read the owner's own notes (the S47 case with his real recall, as the spike
  did). One JSON line per run, then one summary line.
  """

  import asyncio
  import dataclasses
  import json
  import os
  import statistics
  import time
  import uuid
  from datetime import UTC, datetime

  from app import chat, db, decisions, tools, traces
  from app.evals import cases as cases_mod
  from app.evals import runner
  from app.main import app

  ARM = os.environ.get("ARM", "")
  RUNS = int(os.environ.get("RUNS", "3"))
  MODEL = os.environ.get("MODEL", "dell:qwen3:8b")
  CASES = [c for c in os.environ.get("CASES", "").split(",") if c]
  MESSAGE = os.environ.get("MESSAGE")
  OWNER = os.environ.get("OWNER")
  PIN = os.environ.get("DECISION_MODEL")
  PHONE = "How do I get you on my phone"

  if ARM not in ("on", "off", "latency"):
      raise SystemExit("ARM must be on, off or latency")

  if ARM == "off":

      async def _off(app_, turn, message, notes, paths, advertised):
          return decisions.Advice()

      decisions.run = _off
  elif PIN:
      _body = decisions.request_body
      decisions.request_body = lambda state, questions: {**_body(state, questions), "model": PIN}

  OWNER_ID: list[uuid.UUID] = []

  if OWNER:
      _recall = chat._recall

      async def _owner_recall(app_, turn, person, query, *, shared=None):
          owner = dataclasses.replace(person, id=OWNER_ID[0])
          return await _recall(app_, turn, owner, query, shared=shared)

      chat._recall = _owner_recall


  async def _resolve_owner(pool) -> None:
      if not OWNER:
          return
      if OWNER != "owner":
          OWNER_ID.append(uuid.UUID(OWNER))
          return
      rows = await pool.fetch("SELECT id FROM people WHERE role = 'owner'")
      if len(rows) != 1:
          raise SystemExit(f"OWNER=owner needs exactly one owner row; found {len(rows)}")
      OWNER_ID.append(rows[0]["id"])


  async def _latency() -> None:
      stamps = []
      for i in range(RUNS):
          turn = traces.Turn(id=uuid.uuid4(), started_at=datetime.now(UTC), kind="eval")
          t0 = time.perf_counter()
          await decisions.run(app, turn, MESSAGE or PHONE, (), (), tools.advertised_tools())
          ms = int((time.perf_counter() - t0) * 1000)
          meta = turn.spans[-1].meta
          stamps.append(ms)
          print(json.dumps({"arm": "latency", "i": i, "ms": ms, "outcome": meta.get("outcome"),
                            "reason": meta.get("reason"), "served_by": meta.get("served_by"),
                            "hint": meta.get("hint")}), flush=True)
      print(json.dumps({"arm": "latency", "median_ms": statistics.median(stamps),
                        "max_ms": max(stamps), "n": len(stamps)}), flush=True)


  async def main() -> None:
      pool = await db.get_pool()
      await _resolve_owner(pool)
      if ARM == "latency":
          await _latency()
          return
      by_id = {case.id: case for case in cases_mod.load_cases()}
      chosen = [by_id[c] for c in CASES] if CASES else sorted(by_id.values(), key=lambda c: c.id)
      ms, note = await runner.warm_up_model(app, MODEL)
      print(json.dumps({"arm": ARM, "model": MODEL, "pin": PIN, "warmup_ms": ms,
                        "warmup_note": note}), flush=True)
      summary: dict[str, dict] = {}
      spans_ms: list[int] = []
      for case in chosen:
          if MESSAGE:
              case = dataclasses.replace(case, message=MESSAGE)
          tally = summary.setdefault(case.id, {"passed": 0, "failed": 0, "ungradeable": 0})
          for i in range(RUNS):
              run = await runner.run_case(app, pool, case, MODEL)
              span = None
              if run.turn_id is not None:
                  span = await pool.fetchrow(
                      "SELECT meta, duration_ms FROM turn_spans "
                      "WHERE turn_id = $1 AND kind = 'decisions'",
                      run.turn_id,
                  )
              meta = span["meta"] if span else None
              if span:
                  spans_ms.append(span["duration_ms"])
              tally["ungradeable" if run.ungradeable else "passed" if run.passed else "failed"] += 1
              print(json.dumps({
                  "arm": ARM, "case": case.id, "i": i, "passed": run.passed,
                  "ungradeable": run.ungradeable,
                  "turn_id": str(run.turn_id) if run.turn_id else None,
                  "decisions": None if meta is None else {
                      key: meta.get(key)
                      for key in ("outcome", "reason", "hint", "served_by", "fell_back", "notes")
                  },
                  "decisions_ms": span["duration_ms"] if span else None,
                  "detail": str(run.detail)[:300],
              }), flush=True)
      out = {"arm": ARM, "model": MODEL, "runs": RUNS, "summary": summary}
      if spans_ms:
          out["decisions_ms"] = {"median": statistics.median(spans_ms), "max": max(spans_ms),
                                 "n": len(spans_ms)}
      print(json.dumps(out), flush=True)


  asyncio.run(main())
  ```
  Then run the four measurements, in the background (each is 29 cases × 3 runs; allow
  hours), one after the other — never two at once on one GPU:
  ```bash
  cd /home/jeremy/workspace/nova/deploy && docker compose exec -T -e ARM=off core python - < "$SDD/measure_decisions.py" > "$SDD/measure-off.jsonl" 2> "$SDD/measure-off.err"
  cd /home/jeremy/workspace/nova/deploy && docker compose exec -T -e ARM=on core python - < "$SDD/measure_decisions.py" > "$SDD/measure-on.jsonl" 2> "$SDD/measure-on.err"
  cd /home/jeremy/workspace/nova/deploy && docker compose exec -T -e ARM=off -e OWNER=owner -e CASES=gives-a-setup-qr-for-another-device -e "MESSAGE=How do I get you on my phone" core python - < "$SDD/measure_decisions.py" > "$SDD/measure-s47-off.jsonl" 2> "$SDD/measure-s47-off.err"
  cd /home/jeremy/workspace/nova/deploy && docker compose exec -T -e ARM=on -e OWNER=owner -e CASES=gives-a-setup-qr-for-another-device -e "MESSAGE=How do I get you on my phone" core python - < "$SDD/measure_decisions.py" > "$SDD/measure-s47-on.jsonl" 2> "$SDD/measure-s47-on.err"
  ```
  And the step's own latency, twice — right after the corpus (the 8B resident on the Dell)
  and again once the Dell's GPU is idle (ask HER which models are loaded there; wait until
  the 8B has unloaded):
  ```bash
  cd /home/jeremy/workspace/nova/deploy && docker compose exec -T -e ARM=latency -e RUNS=10 core python - < "$SDD/measure_decisions.py" > "$SDD/measure-latency-loaded.jsonl"
  cd /home/jeremy/workspace/nova/deploy && docker compose exec -T -e ARM=latency -e RUNS=10 core python - < "$SDD/measure_decisions.py" > "$SDD/measure-latency-idle.jsonl"
  ```
  Compare the arms — create `$SDD/compare_arms.py` with exactly this content:
  ```python
  import json, sys
  def summary(path):
      for line in open(path):
          row = json.loads(line)
          if "summary" in row:
              return row["summary"]
      raise SystemExit(f"{path} has no summary line — that run did not finish")
  off, on = summary(sys.argv[1]), summary(sys.argv[2])
  worse, unsure = [], []
  for case in sorted(off):
      a, b = off[case], on.get(case, {"passed": 0, "failed": 0, "ungradeable": 0})
      print(f"{case:55s} off {a['passed']}/{a['passed'] + a['failed']} ({a['ungradeable']} ungr.)"
            f"   on {b['passed']}/{b['passed'] + b['failed']} ({b['ungradeable']} ungr.)")
      if b["passed"] < a["passed"]:
          worse.append(case)
      if a["ungradeable"] or b["ungradeable"]:
          unsure.append(case)
  print("WORSE WITH DECISIONS ON:", worse or "none")
  print("HAS UNGRADEABLE RUNS (re-run before judging):", unsure or "none")
  ```
  and run it over each pair of logs:
  ```bash
  python3 "$SDD/compare_arms.py" "$SDD/measure-off.jsonl" "$SDD/measure-on.jsonl"
  python3 "$SDD/compare_arms.py" "$SDD/measure-s47-off.jsonl" "$SDD/measure-s47-on.jsonl"
  ```
  **The gate** (spec, "Done means"): no case worse with decisions on, and the S47 block's
  `on` summary `3/3`. A case with an ungradeable run is re-run (both arms, `CASES=<id>`)
  before it is judged — an ungradeable run is not a zero. If any case is worse, or S47 is
  under 3/3, the slice is NOT done: write the numbers down (Step 9), and the owner decides
  the next move — thresholds are tuned on the corpus, never on one message.

- [ ] **Step 8: The walk, in the owner's real chat, reading every trace by turn id.** Read a
  trace with
  `cd /home/jeremy/workspace/nova/deploy && docker compose exec -T postgres psql -U postgres -d nova_core -Atc "SELECT kind, name, meta FROM turn_spans WHERE turn_id = '<id>' ORDER BY started_at"`
  (by turn id — never a time-ordered LIMIT).
  1. **The phone question.** Ask the owner to send, in his own chat, "How do I get you on my
     phone". Expected: the setup card; the trace has one `decisions` span (outcome
     `decided`, hint `show_setup_qr`, `served_by` naming Kev or Jev, the 2026-09-15
     sideloading notes `kept: false` if recall brought them) and her own `show_setup_qr`
     tool span.
  2. **Kev's fallback.** The owner stops the Kev server. Next typed turn: the `decisions`
     span's `served_by` is `openrouter:~typesafe/jev-latest` and `fell_back` names
     `dell-kev:kev-latest`; Routing lists `dell-kev` among providers that refused recently.
     He restarts Kev and clears the wall with "Try it again".
  3. **Jev's fallback.** Routing → Decisions: move Jev first, save. Spend → openrouter
     monthly cap `$0.00`. Next typed turn: `served_by` is `dell-kev:kev-latest` and
     `fell_back` names openrouter's cap (a cap SKIPS a link rather than walling it — the
     one way to take Jev out without breaking the key chat shares; see the spec defects
     reported with this plan). Restore the cap and the chain order.
  4. **The Jev Router switch.** Routing → Chat → "Let Jev Router pick the cloud model": the
     chain shows `openrouter:typesafe/jev-router` where the cloud link was, with "in place
     of …"; switch it off and the old link is back, in place. Then one routed turn: the
     owner picks `openrouter:typesafe/jev-router` in the chat model picker and asks "What
     time is it?". Expected: the `llm_call` span's `served_by` is
     `openrouter:typesafe/jev-router` with a `routed_to` naming the model it picked, and a
     `get_time` tool span — tool calling works through the router (its OpenRouter listing
     states no supported parameters, so this walk is the check). He puts his chat model back.

- [ ] **Step 9: Write it down.**
  - A `## Close-out` section at the end of this plan: what shipped; the suite counts from
    Step 1; the measurement table (per case, off and on, from the compare script); the S47
    block (off and on); the step's latency (median and max, loaded and idle; the corpus
    arm's `decisions_ms`); the walk's turn ids and what each trace showed.
  - `docs/plans/rebuild/ROADMAP.md`: the decision-role row's state — `done` with the numbers
    when the gate held, else `built, gate not met` with the case(s) and a link to the
    carries.
  - `docs/plans/rebuild/decision-role/carries.md` for anything not finished (a case worse,
    Kev's latency against the 5 s budget, the thresholds, widening to scheduled/agent turns,
    §5's engine).
  - Commit on a docs branch, open a PR, and ask the owner to merge — the same path as the
    code:
    ```bash
    git -C /home/jeremy/workspace/nova/.worktrees/decisions checkout -b docs/decisions-close-out origin/main
    git -C /home/jeremy/workspace/nova/.worktrees/decisions add docs/plans/rebuild/decision-role/plan.md docs/plans/rebuild/ROADMAP.md
    git -C /home/jeremy/workspace/nova/.worktrees/decisions commit -m "docs(decisions): close-out — the measurement and the walk"
    git -C /home/jeremy/workspace/nova/.worktrees/decisions push -u origin docs/decisions-close-out
    ```
    (add `docs/plans/rebuild/decision-role/carries.md` to the `add` when it exists).

---

## Self-review

Run against the spec, 2026-09-28, before handing the plan over.

**1. Spec coverage.**

| Spec requirement | Task |
|---|---|
| §1 `decisions` joins `BUILTIN_ROLES`; its chain edited like chat's | 1, 10 |
| §1 its other pinned places — web `BuiltinRole`, `ROLE_WORDS` and their tests; the gateway and core error-text tests | 10; 1 (`BAD_ROLE_MESSAGE`); 9 (`test_tools_route`) |
| §1 `POST /v1/systemone` beside `chat_completions`; `resolve` / `record_refusal` / `note_success`; walls and fallback exactly as chat; body forwarded unchanged to `{base_url}/systemone` with the link's model id and key; `X-Nova-Route` | 3 (one `walk_role` for both routes) |
| §1 the endpoint decides the protocol; `openrouter` serves both; `systemone` adapter, base URL + optional key, no chat | 1 (`protocols`), 2, 3 |
| §1 `local` settable | 2 |
| §1 metering under `decisions`; OpenRouter's `input_tokens` and `cost`; local costs nothing | 3 |
| §2 `decisions.py`, one call per turn before the first model round, role `decisions` | 7, 8 |
| §2 tool hint: stage 1 / stage 2, options from the live registry, thresholds, the hint line | 7 (questions), 6 (placement), 8 |
| §2 recall check: three nouls per note, the hinted tool's description as the facts, the three drop rules | 7; 6 (paths); 8 |
| §2 fail-open with a stated reason — no model, the 5 s budget, a malformed answer | 7, 8 |
| §2 one `decisions` span: hint, fit, gate, per-note scores and verdicts by path, who served, latency | 7 (latency = the span's duration) |
| §2 not on scheduled turns, drains, agent delegation | 8 |
| §3 Routing shows the role with its label and chain editor | 10 |
| §3 Models lists decision models (Jev from the OpenRouter catalog, `text->decisions`) | 4 (the gateway asks for them), 12 (the facet) |
| §3 Providers: a Kev preset (`systemone`, local) | 2 (the preset), 12 (the form) |
| §4 a switch on chat, scheduled, agents; off is today; on is `openrouter:typesafe/jev-router` | 5, 11 |
| §4 the model it picked recorded on the turn | 9 (`routed_to`) |
| §4 the chain stays the source of truth; off restores the kept cloud model; local first holds | 5 |
| §4 quality-first setting, or say what it balances | 11 (checked: none exists — plan decision 19) |
| Done means: corpus × 3 off/on on `dell:qwen3:8b`, S47 3/3; the owner's chat and its trace; Jev and Kev each serve; each fallback walked | 14 |
| Open risks: Kev latency (idle and loaded); thresholds tuned on the corpus; the hint not pulling her wrong elsewhere | 14 (the latency arm; the gate) |
| Build order gateway → core → web | Tasks 1-5, 6-9, 10-12 |
| Not in scope: a local-versus-cloud pick; decisions on the guards | nothing builds either |
| §5, the Kev engine | a separate later plan (scope) |

**2. Placeholder scan.** Searched the plan for "TBD", "TODO", "implement later", "fill in",
"similar to Task", "appropriate", "handle edge cases": none. Every code step carries the
code; every test step carries the test; every command carries its expected result.

**3. Type and name consistency.** Checked across tasks: `routing.set_chain(pool, role, chain, by_name)`
(Task 1, reused by Task 5's `_clean_chain` and INSERT); `routing.protocol_of` / `speaks` /
`cannot_serve` (1 → 2, 3, 5); `routing.DECISIONS_ROLE` (1 → 3); `data_plane.walk_role(request, pool, role, requested, attribution, serve)` (3);
`systemone.call(app, row, model, body, headers)` (3); `usage.observe_decision(pool, *, status, content, row, model, served_by, attribution, started, route)` (3);
`Listing.note` (4); `routing.set_router(pool, role, on, link, by_name)` and the routes
page's `router` (5 → 11); `Recalled.paths`, `Recalled.set_aside`, `chat._with_notes_kept`,
`base_messages(..., hint=)` (6 → 8); `decisions.run(app, turn, message, notes, paths, advertised) -> Advice`,
`Advice.hint` / `Advice.keep`, `Hint.line()` (7 → 8); `decisions.request_body` (7 → 14);
`FakeGateway.decision_answer` / `decision_hold` / `decision_calls` (7 → 8), `chunk_model`
(9); `tests.test_decisions.decider` (7 → 8); web `BuiltinRole`, `RouteProtocol`,
`isDecisionModel` (10 → 11), `RouteRouter`, `putJevRouter` (11), `Provider.local`,
`ProviderModel.output_modalities` (12). The empty-chain words are one string in three
places — the gateway (1), its test (3) and core's fake (7) — and match.

**4. Review Focus.** The five lines above each name the task whose test pins them, and each
test is written out in that task: 1 → Tasks 1, 3, 8; 2 → Tasks 2, 4, 12; 3 → Tasks 3, 7;
4 → Tasks 6, 8; 5 → Task 5.

**Spec gaps and defects found while planning** (decided above, and reported with the plan):
- §2 says "one concurrent batch of calls", but stage 2 needs stage 1's shortlist and the
  note checks need the hint: three rounds (plan decision 1).
- §2 defines the recall check's facts only through the hint; with no hint the notes are
  left as recalled (plan decision 2).
- §3's "Jev from the OpenRouter catalog" is not reachable as the catalogue reads today:
  OpenRouter's default `/models` omits decision models (plan decision 14).
- §4's "the role's cloud link" is ambiguous for chat when `chat.model` itself is cloud: the
  switch edits the stored chain only (plan decision 17). OpenRouter lists no parameters for
  Jev Router at all — not even `tools` — so a routed turn's tool calling is checked in the
  walk (Task 14, Step 8.4), not assumed.
- "each fallback is walked by walling the first link": walling Jev means walling the whole
  `openrouter` provider (its refusals are account-level), which also walls chat's cloud
  link; the walk takes Jev out with a $0 cap instead (Task 14, Step 8.3).
- Kev on the Dell is a non-engine local provider: a connect failure walls it, and by the
  existing local rule a success never clears the wall, so it can stay skipped up to 30
  minutes after the Dell wakes (said in deploy/README; §5's engine is where that changes).
- "Done means" measures the deployed stack, and deploys come only from `main`: the gate
  is checked after the merge (Task 14, Step 7), so a failed gate is follow-up work, not a
  blocked merge.

## Close-out (2026-09-30)

**Shipped:** PR #85 (merged 16d00ccd, 2026-09-29) built the decision role — the gateway's
`decisions` role and `POST /v1/systemone`, core's two questions before a typed turn, and
Routing and Models. PR #86 (merged 1854060a, 2026-09-29) added the local (alpha) and cloud
(beta) switches beside the decisions chain. Both are deployed from `main`.

**Measured** (deployed stack, chat model `dell:qwen3:8b`, the whole eval corpus — 30 cases
× 3):

- Kev first, while the chat model shared the Dell's GPU: the decision step failed open on
  89 of 90 corpus turns ("no decision within the 5 s budget"). A dedicated latency run
  decided 0 of 10 turns with the 8B model loaded, and 5 of 5 alone and warm (1.8 s median).
  This arm measured nothing about the role's own effect — almost every "on" turn ran
  exactly as "off" would have.
- Jev (cloud) answering: 90 of 90 turns decided, 0.7 s median (1.7 s max). No case scored
  worse than with the role off; one apparent three-run drop
  (`points-wsl-at-the-windows-agent`) turned out to be noise — a ten-run re-run scored 1 of
  10 in both arms. Three cases scored better. The S47 phone case, judged with the owner's
  own memory in play, went from 1 of 3 right to 3 of 3.
- The walk in the owner's real chat (2026-09-30, read by turn id): Jev decided in 1.3
  seconds ($0.0003); Kev was passed over because local is switched off (alpha); the hint
  was `show_setup_qr` (fit 0.84); the stale 2026-09-15 and 2026-09-28 notes were set aside;
  she called `show_setup_qr` herself; the owner saw the card and said it looked good.

**"Done means":** met with the cloud decision model, which is the default now that local
ships off. Not judgeable for Kev on a GPU shared with the chat model — the reason local
ships as an alpha switch. Not walked: the wall-based fallback walks and the Jev Router
switch walks (owed, optional).

**Decisions that changed during the build:**

- The switch counts `chat.model` as the first link of any role whose turns send it, with
  one state model: it reads on exactly when the first cloud model a turn reaches is Jev
  Router.
- The `llm_call` span records `upstream_model`, not `routed_to`.
- A 404, a 405, or a 200 that is not a JSON object from a decision server's `/systemone`
  passes that link over rather than walling it.
- A local decision server recovers from its wall on its first clean answer after the wall
  lapses, the same as any walled link.
- Jev's fallback walk (not yet run — see "Not walked" above) is designed to take Jev out
  with a $0 OpenRouter cap, because no product path walls a cloud model on demand.
- Local decision models ship as an alpha switch, off by default; cloud decision models ship
  as a beta switch, on by default.

**Follow-ups:**

- A per-link time slice, so a slow local decision server can hand over to the next link
  inside the 5-second budget, instead of the whole step failing open.
- A narrow stale "in place of" path in the Jev Router switch (a hand-typed router link,
  plus a cloud `chat.model` whose provider is deleted between switching on and off).
- Nova has no tool of her own to flip the decision switches; they are a Settings page only.
- When Kev becomes an engine (spec §5), a switched-off engine must still never have its
  machine checked — the routing order already skips a switched-off link before asking
  anything of its wall, its cap, or its machine, and that order has to hold once Kev is one
  too.
