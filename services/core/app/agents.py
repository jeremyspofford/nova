"""An agent is a row, and this module is its one writer and its run-time identity.

What an agent IS (migration 021): a name, a purpose, its own instructions,
a SUBSET of the tool registry it is advertised, the skill files it reads,
a monthly cap, a round budget, whether it may read the household's shared
notes, and its own inactive log conversation. It has no people row — the
two things a people row would buy (a memory partition key, a spend key)
are already given to any string by the memory service and to any
`agent_<name>` role by the gateway's ledger — so its identity at run time
is a VALUE built here (`Agent.person()`), never a row anything else could
join against.

Everything below is derived from live state, never from a list someone
maintains: the tool subset is checked against `tools.REGISTRY` at
validation and again every time a persona is built (a tool that has since
vanished is not advertised and the prompt says so); skills are the files
under `<WORKSPACE_ROOT>/skills/`; the roster Nova reads is the table; the
routing role is `'agent_' + name`, computed, not stored.

Every write here reads back what it claims: `create` re-reads the row and
re-checks the folder after commit and composes its sentence from what it
READ; `delete` checks the DELETE's command tag and that the row is gone;
the route PUT is stated as the gateway answered it, registered or not. A
step that cannot verify itself raises `AgentError` with the reason, and
nothing here is a permission gate — a refusal is a stated CANNOT (a name
that fails the rule, a tool that does not exist), never a "may not".

Import discipline: chat.py imports this module at its top, so nothing here
may import app.chat, app.scheduler or app.timers at module level (the
tools package is safe — it imports only app.tools.* and the stores, never
chat; pinned by a subprocess test).
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import asyncpg
import httpx

from app import governance, identity, peers, settings_store, spend_api, tools
from app.identity import Person
from app.tools.base import ToolFailure
from app.tools.spend import _usd
from app.tools.workspace import root_from_env

logger = logging.getLogger("core")

# The routing role every agent's gateway rounds walk, derived from the name.
# 'agent_' (6 chars) + a 26-char name stays inside the gateway's ROLE_RE
# ^[a-z_]{1,32}$, and the prefix makes a collision with a built-in role
# (chat, scheduled, judge, ...) impossible by construction.
ROLE_PREFIX = "agent_"
# What Agent.person().role carries, so a tool that must not act for a
# non-person (refuse_person_write) has one fact to read.
AGENT_PERSON_ROLE = "agent"
# Nova's delegation tool, named once: validate_spec refuses it in an agent's
# subset, and chat advertises the roster only to whoever holds it.
DELEGATE_TOOL = "delegate_to_agent"

NAME_RE = re.compile(r"^[a-z][a-z_]{0,25}$")
RESERVED_NAMES = frozenset({"nova"})
MENTION_RE = re.compile(r"^@([a-z][a-z_]{0,25})\b")
CREATED_VIA = ("chat", "page")
MIN_ROUNDS, MAX_ROUNDS = 1, 50

SKILL_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,40}$")
# A skill file is read into the prompt every turn; past this many characters
# it is cut and the cut is STATED in the block, never silent.
SKILL_CHARS = 4000

ROUTE_TIMEOUT = httpx.Timeout(connect=5.0, read=15.0, write=5.0, pool=5.0)

# Every read and every RETURNING names the same columns, so a row is the
# same shape wherever it was fetched.
_COLUMNS = (
    "id, name, purpose, instructions, tools, skills, monthly_cap_usd, max_tool_rounds, "
    "read_shared_memory, log_conversation_id, created_via, created_turn_id, "
    "created_at, updated_at"
)


class AgentError(Exception):
    """A stated reason something could not be done: a name that fails the
    rule, a tool that does not exist, a row that is not there. The text is
    meant to be shown as-is — to the page, or to the model as `Error: …`."""


# ── the row ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Agent:
    id: uuid.UUID
    name: str
    purpose: str
    instructions: str
    tools: tuple[str, ...]
    skills: tuple[str, ...]
    monthly_cap_usd: Decimal | None
    max_tool_rounds: int
    read_shared_memory: bool
    log_conversation_id: uuid.UUID | None
    created_via: str
    created_turn_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime

    @property
    def role(self) -> str:
        """The gateway routing role its rounds walk — derived, never stored."""
        return ROLE_PREFIX + self.name

    def person(self) -> Person:
        """The identity an agent turn runs as: a Person VALUE with the agent's
        id, so memory scopes to `people/<agent id>/` and the workspace
        context carries a principal — and NOT a people row, so nothing
        person-scoped (timers, conversations, sessions) can ever see it."""
        return Person(id=self.id, name=self.name, role=AGENT_PERSON_ROLE)

    @classmethod
    def from_row(cls, record: asyncpg.Record) -> Agent:
        return cls(
            id=record["id"],
            name=record["name"],
            purpose=record["purpose"],
            instructions=record["instructions"],
            tools=tuple(record["tools"] or ()),
            skills=tuple(record["skills"] or ()),
            monthly_cap_usd=record["monthly_cap_usd"],
            max_tool_rounds=record["max_tool_rounds"],
            read_shared_memory=record["read_shared_memory"],
            log_conversation_id=record["log_conversation_id"],
            created_via=record["created_via"],
            created_turn_id=record["created_turn_id"],
            created_at=record["created_at"],
            updated_at=record["updated_at"],
        )


def from_row(record: asyncpg.Record) -> Agent:
    return Agent.from_row(record)


# ── run-time identity ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class Persona:
    """What one turn runs AS: which tools are advertised, which of those are
    listing-kind (the only tools the presented-listing guard may count as a
    list this turn could have run), the prompt block that names the agent
    (None for Nova), the root every filesystem call is contained in, and the
    second memory scope recalled for it (the owner's, only when the agent
    may read shared notes — derived from the row by persona_for, never
    handed in). `agent` is None for Nova."""

    agent: Agent | None
    tool_names: tuple[str, ...]
    listing_tools: tuple[str, ...]
    instructions_block: str | None
    workspace_root: Path
    shared_person_id: uuid.UUID | None


def _listing_subset(tool_names: Sequence[str]) -> tuple[str, ...]:
    """The listing-kind tools among `tool_names`, in the registry's order and
    read from it at the call. The guard that asks "did a lister run?" must
    see the persona's OWN listers: the whole registry's would count a tool
    the agent was never advertised as one it could have called."""
    held = frozenset(tool_names)
    return tuple(
        name for name in tools.tool_names_by_result_kind(tools.RESULT_KIND_LISTING) if name in held
    )


def nova_persona() -> Persona:
    """Nova's own: the WHOLE live registry and the env root, derived at every
    call so a tool registered later is advertised by that fact alone."""
    names = tuple(tools.tool_names())
    return Persona(
        agent=None,
        tool_names=names,
        listing_tools=_listing_subset(names),
        instructions_block=None,
        workspace_root=root_from_env(),
        shared_person_id=None,
    )


def _folder(name: str, root: Path | None) -> Path:
    return (root_from_env() if root is None else root) / "agents" / name


def folder_for(agent: Agent, root: Path | None = None) -> Path:
    """`<root>/agents/<name>/` — the agent's whole filesystem world; the
    workspace tools contain every path under whatever root the context
    carries, so handing this in as the root IS the boundary."""
    return _folder(agent.name, root)


def skills_dir(root: Path | None = None) -> Path:
    return (root_from_env() if root is None else root) / "skills"


def _skill_path(name: str, root: Path | None) -> Path | None:
    """None for a name that fails the rule — such a name never reaches a
    path, so a hand-edited row cannot turn `../x` into a file read."""
    if not SKILL_NAME_RE.fullmatch(name):
        return None
    return skills_dir(root) / f"{name}.md"


def list_skills(root: Path | None = None) -> list[dict]:
    """The skill files that exist: `<root>/skills/<name>.md` whose stem is a
    usable name. Derived from the directory each call, so a file written by
    hand (or by Nova with workspace_write_file) is a skill by that fact."""
    directory = skills_dir(root)
    if not directory.is_dir():
        return []
    out = []
    for path in sorted(directory.glob("*.md")):
        if not path.is_file() or not SKILL_NAME_RE.fullmatch(path.stem):
            continue
        stat = path.stat()
        out.append(
            {
                "name": path.stem,
                "size": stat.st_size,
                "modified": datetime.fromtimestamp(stat.st_mtime, UTC).isoformat(),
            }
        )
    return out


def skill_text(name: str, root: Path | None = None) -> str | None:
    """The file's text, cut at SKILL_CHARS with the cut stated; None when the
    file is not there (the caller says so in the prompt — never dropped)."""
    path = _skill_path(name, root)
    if path is None or not path.is_file():
        return None
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        logger.warning("skill %s could not be read: %s", name, exc)
        return None
    if len(text) > SKILL_CHARS:
        text = (
            text[:SKILL_CHARS]
            + f"\n[skill {name}: cut here — the first {SKILL_CHARS} of {len(text)} characters]"
        )
    return text


def unknown_tools(agent: Agent) -> list[str]:
    """The subset entries naming no registered tool — flagged, never dropped."""
    return [name for name in agent.tools if name not in tools.REGISTRY]


def skills_status(agent: Agent, root: Path | None = None) -> list[dict]:
    return [
        {"name": name, "present": (p := _skill_path(name, root)) is not None and p.is_file()}
        for name in agent.skills
    ]


def instructions_block(
    agent: Agent,
    *,
    missing_tools: Sequence[str],
    skills: Sequence[tuple[str, str | None]],
) -> str:
    """The agent's own system-prompt block. States what is true about this
    turn — the folder, the round budget, which memory it can reach, how the
    owner reaches it — and names every tool or skill that is GONE rather
    than quietly leaving it out, so the model never plans around a hand it
    does not have. `skills` is (name, text-or-None) as read by persona_for."""
    if agent.read_shared_memory:
        memory = (
            "memory_search searches your own notes; shared household notes are recalled "
            "for you automatically."
        )
    else:
        memory = (
            "memory_search searches your own notes; you cannot read the household's shared notes."
        )
    head = [
        f"You are {agent.name}, an agent working for the household; Nova is the assistant "
        "that hands you tasks and relays your reports.",
        f"Purpose: {agent.purpose}",
    ]
    tail = [
        f"Your workspace folder is agents/{agent.name}/ — every path you read or write is "
        "inside it.",
        f"You have {agent.max_tool_rounds} tool rounds per task.",
        memory,
        f"The owner may address you directly as @{agent.name} at the start of a message.",
        "To remove an agent, ask the owner or Nova.",
        *(f"[tool {name}: no longer exists]" for name in missing_tools),
    ]
    parts = ["\n".join(head), agent.instructions, "\n".join(tail)]
    for name, text in skills:
        parts.append(
            f"## Skill: {name}\n{text}" if text is not None else f"[skill {name}: file missing]"
        )
    return "\n\n".join(parts)


def persona_for(
    agent: Agent,
    *,
    owner_id: uuid.UUID | None,
    root: Path | None = None,
) -> Persona:
    """The agent's persona for one turn, built from the live registry and the
    live skill files: a subset entry no longer registered is NOT advertised
    (the gateway would be told about a hand that cannot be played) and the
    block says it is gone; a skill file edited since the last turn is read
    fresh; the root is the agent's folder.

    The shared memory scope is DERIVED from the row, never handed in: it is
    `owner_id` when read_shared_memory is set and None otherwise, whatever
    the caller passed — so no call site can widen an agent's recall past
    what its row says, or narrow it. A row that reads shared notes with no
    owner id to scope them to is a stated refusal, not a turn that quietly
    recalls nothing."""
    if agent.read_shared_memory:
        if owner_id is None:
            raise AgentError(
                f"agent {agent.name} reads shared notes but no owner id was given — the scope "
                "cannot be derived"
            )
        shared_person_id = owner_id
    else:
        shared_person_id = None
    present = tuple(name for name in agent.tools if name in tools.REGISTRY)
    missing = [name for name in agent.tools if name not in tools.REGISTRY]
    skills = [(name, skill_text(name, root)) for name in agent.skills]
    return Persona(
        agent=agent,
        tool_names=present,
        listing_tools=_listing_subset(present),
        instructions_block=instructions_block(agent, missing_tools=missing, skills=skills),
        workspace_root=folder_for(agent, root),
        shared_person_id=shared_person_id,
    )


# ── reads ──────────────────────────────────────────────────────────────────


async def by_name(pool: asyncpg.Pool, name: str) -> Agent | None:
    row = await pool.fetchrow(f"SELECT {_COLUMNS} FROM agents WHERE name = $1", name)
    return None if row is None else Agent.from_row(row)


async def by_id(pool: asyncpg.Pool, agent_id: uuid.UUID) -> Agent | None:
    row = await pool.fetchrow(f"SELECT {_COLUMNS} FROM agents WHERE id = $1", agent_id)
    return None if row is None else Agent.from_row(row)


async def list_all(pool: asyncpg.Pool) -> list[Agent]:
    rows = await pool.fetch(f"SELECT {_COLUMNS} FROM agents ORDER BY name")
    return [Agent.from_row(row) for row in rows]


async def names(pool: asyncpg.Pool) -> list[str]:
    return [row["name"] for row in await pool.fetch("SELECT name FROM agents ORDER BY name")]


async def mentioned(pool: asyncpg.Pool, message: str) -> Agent | None:
    """The agent a message addresses with `@name` at its very start, or None
    — an @ anywhere else is just text, and a name with no row is nobody."""
    match = MENTION_RE.match(message.strip())
    if match is None:
        return None
    return await by_name(pool, match.group(1))


def _one_line(text: str) -> str:
    return " ".join(text.split())


async def roster_line(pool: asyncpg.Pool) -> str | None:
    """The one line Nova's prompt carries about who she can delegate to, read
    from the table each turn; None when there are no agents. A table that
    cannot be read RAISES — the caller (chat) records the failure on the
    turn, so a roster that went missing is a fact on the trace and not a
    warning in a log nobody reads."""
    agents = await list_all(pool)
    if not agents:
        return None
    parts = []
    for agent in agents:
        live = [name for name in agent.tools if name in tools.REGISTRY]
        parts.append(
            f"{agent.name} — {_one_line(agent.purpose)} (tools: {', '.join(live) or 'none'})"
        )
    return "Agents you can delegate to: " + "; ".join(parts)


async def bound_timers(pool: asyncpg.Pool, agent_id: uuid.UUID) -> list[dict]:
    rows = await pool.fetch(
        "SELECT id, title FROM timers WHERE agent_id = $1 ORDER BY created_at, id", agent_id
    )
    return [{"id": str(row["id"]), "title": row["title"]} for row in rows]


# ── the spec and its one validator ─────────────────────────────────────────


@dataclass(frozen=True)
class AgentSpec:
    name: str
    purpose: str
    instructions: str
    tools: tuple[str, ...]
    skills: tuple[str, ...] = ()
    monthly_cap_usd: Decimal | None = None
    # None: the 'agents.max_tool_rounds' setting at create time, COPIED into
    # the row — an agent's budget is its own fact, not a live setting read.
    max_tool_rounds: int | None = None
    read_shared_memory: bool = False
    model_chain: tuple[str, ...] = ()


def _cap_decimal(value: Any) -> Decimal | None:
    """The cap as the column holds it (cents), or a stated refusal. None is
    uncapped; 0 is a real cap that refuses the first paid round."""
    if value is None:
        return None
    if isinstance(value, bool):
        raise AgentError("monthly_cap_usd must be a number of dollars or null, not a boolean")
    try:
        cap = Decimal(str(value)).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError) as exc:
        raise AgentError(
            f"monthly_cap_usd must be a number of dollars or null, got {value!r}"
        ) from exc
    if cap < 0:
        raise AgentError(f"monthly_cap_usd must be 0 or more (null means uncapped), got {cap}")
    return cap


def _names_tuple(value: Any, what: str) -> tuple[str, ...]:
    if isinstance(value, str) or not isinstance(value, Iterable):
        raise AgentError(f"{what} must be a list of names")
    out = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise AgentError(f"{what} must be a list of names, got {item!r}")
        out.append(item.strip())
    return tuple(out)


def validate_spec(spec: AgentSpec, *, root: Path | None = None) -> None:
    """Every refusal states the rule it applies and, where there is a live
    set to name, names it: the registry for tools, the directory for skills.
    Nothing here is a list someone maintains."""
    if not isinstance(spec.name, str) or not NAME_RE.fullmatch(spec.name):
        raise AgentError(
            f"agent name {spec.name!r} must match ^[a-z][a-z_]{{0,25}}$ — lowercase letters "
            "and underscores, starting with a letter, at most 26 characters"
        )
    if spec.name in RESERVED_NAMES:
        raise AgentError(f"{spec.name!r} is reserved — it is Nova's own name")
    if not isinstance(spec.purpose, str) or not isinstance(spec.instructions, str):
        raise AgentError("purpose and instructions must be text")
    for name in _names_tuple(spec.tools, "tools"):
        if name == DELEGATE_TOOL:
            raise AgentError(
                f"{DELEGATE_TOOL} cannot be in an agent's tools — agents do not delegate "
                "in this version"
            )
        if name not in tools.REGISTRY:
            raise AgentError(
                f"no tool named {name!r} — the tools that exist: {', '.join(tools.tool_names())}"
            )
    existing = [skill["name"] for skill in list_skills(root)]
    for name in _names_tuple(spec.skills, "skills"):
        if not SKILL_NAME_RE.fullmatch(name):
            raise AgentError(
                f"skill name {name!r} must match ^[a-z][a-z0-9_-]{{0,40}}$ — it names a file "
                "under skills/"
            )
        if name not in existing:
            raise AgentError(
                f"no skill named {name!r} — files under skills/: {', '.join(existing) or 'none'}"
            )
    _cap_decimal(spec.monthly_cap_usd)
    rounds = spec.max_tool_rounds
    if rounds is not None and (
        isinstance(rounds, bool)
        or not isinstance(rounds, int)
        or not MIN_ROUNDS <= rounds <= MAX_ROUNDS
    ):
        raise AgentError(
            f"max_tool_rounds must be between {MIN_ROUNDS} and {MAX_ROUNDS}, got {rounds!r}"
        )
    _names_tuple(spec.model_chain, "model_chain")


def _spec_meta(
    spec: AgentSpec, rounds: int, created_via: str | None = None, *, with_chain: bool = True
) -> dict:
    """The spec as the ledger stores it — JSON-able, Decimal made a float.
    `with_chain=False` leaves model_chain out: the chain is not a column, so
    a write that did not carry one has nothing true to record about it."""
    cap = _cap_decimal(spec.monthly_cap_usd)
    meta = {
        "name": spec.name,
        "purpose": spec.purpose,
        "instructions": spec.instructions,
        "tools": list(spec.tools),
        "skills": list(spec.skills),
        "monthly_cap_usd": None if cap is None else float(cap),
        "max_tool_rounds": rounds,
        "read_shared_memory": bool(spec.read_shared_memory),
    }
    if with_chain:
        meta["model_chain"] = list(spec.model_chain)
    if created_via is not None:
        meta["created_via"] = created_via
    return meta


async def _rounds_for(pool: asyncpg.Pool, spec: AgentSpec) -> int:
    if spec.max_tool_rounds is not None:
        return int(spec.max_tool_rounds)
    rounds = int(await settings_store.read_value(pool, "agents.max_tool_rounds"))
    if not MIN_ROUNDS <= rounds <= MAX_ROUNDS:
        raise AgentError(
            f"the agents.max_tool_rounds setting is {rounds}, outside {MIN_ROUNDS}..{MAX_ROUNDS} — "
            "pass max_tool_rounds explicitly or fix the setting"
        )
    return rounds


async def _owner_or_refuse(pool: asyncpg.Pool) -> Person:
    owner = await identity.owner(pool)
    if owner is None:
        raise AgentError("no owner account exists yet — register one first")
    return owner


def _no_such(name: str, live: Sequence[str]) -> AgentError:
    listed = ", ".join(live) if live else "there are no agents"
    return AgentError(f"no agent named {name!r} — the agents are: {listed}")


# ── the log conversation ───────────────────────────────────────────────────


async def _insert_log_conversation(conn: asyncpg.Connection, owner: Person, name: str) -> uuid.UUID:
    # INACTIVE so conversations.active_conversation(owner) — which picks the
    # newest ACTIVE row — can never hand the owner's chat page an agent's log.
    return await conn.fetchval(
        "INSERT INTO conversations (person_id, active, title) VALUES ($1, false, $2) RETURNING id",
        owner.id,
        f"agent:{name}",
    )


class _Rolled(Exception):
    """Raised inside a transaction on purpose to roll it back."""


async def log_conversation(pool: asyncpg.Pool, agent: Agent) -> uuid.UUID:
    """The agent's own conversation where delegated tasks and reports land —
    the row's, or a fresh inactive one when the column is NULL (the original
    was deleted; ON DELETE SET NULL). Two callers racing produce one row: the
    UPDATE claims the column only while it is still NULL."""
    if agent.log_conversation_id is not None:
        return agent.log_conversation_id
    owner = await _owner_or_refuse(pool)
    try:
        async with pool.acquire() as conn, conn.transaction():
            conversation_id = await _insert_log_conversation(conn, owner, agent.name)
            claimed = await conn.fetchval(
                "UPDATE agents SET log_conversation_id = $2, updated_at = now() "
                "WHERE id = $1 AND log_conversation_id IS NULL RETURNING log_conversation_id",
                agent.id,
                conversation_id,
            )
            if claimed != conversation_id:
                raise _Rolled
            return conversation_id
    except _Rolled:
        pass
    current = await by_id(pool, agent.id)
    if current is None:
        raise AgentError(f"agent {agent.name} no longer exists")
    if current.log_conversation_id is None:
        raise AgentError(f"agent {agent.name} could not be given a log conversation")
    return current.log_conversation_id


# ── the gateway route ──────────────────────────────────────────────────────


@dataclass
class RouteOutcome:
    """What the gateway did with the agent's role, in words fit to show.
    `registered` is True only when the gateway holds the state this call
    asked for (the chain stored; or, for unregister, no row left)."""

    registered: bool
    detail: str


def _error_detail(resp: httpx.Response) -> str:
    try:
        body = resp.json()
    except ValueError:
        return resp.text[:200] or f"HTTP {resp.status_code}"
    if isinstance(body, dict) and body.get("error"):
        return str(body["error"])
    return resp.text[:200] or f"HTTP {resp.status_code}"


def _not_registered(role: str, reason: str) -> RouteOutcome:
    return RouteOutcome(
        registered=False,
        detail=(
            f"the gateway did not register its route: {reason} — it routes on the chat chain "
            "until Settings → Routing sets one"
        ),
    )


async def _explain(app, role: str, *, own_chain_empty: bool | None) -> str:
    """Which model the gateway says would serve the role right now, quoted
    from its explain walk. `own_chain_empty` is what we know about the
    stored chain (None: unknown) — an empty chain walks the chat chain by
    the gateway's rule, said when the gateway gives no reason of its own."""
    try:
        async with peers.client(app, peers.GATEWAY, ROUTE_TIMEOUT) as client:
            resp = await client.get("/admin/route/explain", params={"role": role, "model": ""})
    except (peers.PeerUnconfigured, httpx.HTTPError) as exc:
        return f"the gateway could not say what would serve it: {peers.reason(exc)}"
    if resp.status_code != 200:
        return f"the gateway could not say what would serve it: {_error_detail(resp)}"
    try:
        body = resp.json()
    except ValueError:
        return "the gateway could not say what would serve it: its answer was not JSON"
    if not isinstance(body, dict):
        return "the gateway could not say what would serve it: its answer was not an object"
    serve = body.get("would_serve")
    if not isinstance(serve, dict):
        return f"nothing can serve it right now — {body.get('reason')}"
    words = f"would be served by {serve.get('served_by')}"
    verdicts = body.get("chain") if isinstance(body.get("chain"), list) else []
    reason = serve.get("reason") or next(
        (
            v.get("reason")
            for v in verdicts
            if isinstance(v, dict) and v.get("verdict") == "runnable" and v.get("reason")
        ),
        None,
    )
    if reason:
        return f"{words} ({reason})"
    if own_chain_empty:
        return f"{words} (the chat chain)"
    return words


async def register_route(app, agent: Agent, chain: Sequence[str]) -> RouteOutcome:
    """PUT the agent's chain under its role. The outcome is the gateway's
    answer read back — the chain it ECHOED, then what its explain walk says
    would serve — never "registered" on a 200 alone."""
    role = agent.role
    links = [str(link) for link in (chain or ())]
    try:
        async with peers.client(app, peers.GATEWAY, ROUTE_TIMEOUT) as client:
            resp = await client.put(f"/admin/routes/{role}", json={"chain": links})
    except (peers.PeerUnconfigured, httpx.HTTPError) as exc:
        return _not_registered(role, peers.reason(exc))
    if resp.status_code != 200:
        return _not_registered(role, _error_detail(resp))
    try:
        body = resp.json()
    except ValueError:
        body = None
    echoed = body.get("chain") if isinstance(body, dict) else None
    if not isinstance(echoed, list):
        return _not_registered(
            role, f"the gateway answered {resp.status_code} but did not echo the chain it stored"
        )
    serve = await _explain(app, role, own_chain_empty=not echoed)
    return RouteOutcome(
        registered=True,
        detail=f"route {role} registered, chain {json.dumps(echoed)} — {serve}",
    )


async def _route_unchanged(app, agent: Agent) -> RouteOutcome:
    serve = await _explain(app, agent.role, own_chain_empty=None)
    return RouteOutcome(registered=False, detail=f"route {agent.role} unchanged — {serve}")


async def unregister_route(app, agent: Agent) -> RouteOutcome:
    """DELETE the role's chain row; a 404 means there was none, which is the
    state asked for. Anything else is stated with what the owner can do."""
    role = agent.role
    try:
        async with peers.client(app, peers.GATEWAY, ROUTE_TIMEOUT) as client:
            resp = await client.delete(f"/admin/routes/{role}")
    except (peers.PeerUnconfigured, httpx.HTTPError) as exc:
        return RouteOutcome(
            registered=False,
            detail=(
                f"the gateway did not remove route {role}: {peers.reason(exc)} — remove it "
                "from Settings → Routing"
            ),
        )
    if resp.status_code == 404:
        return RouteOutcome(registered=True, detail=f"route {role} had no chain of its own")
    if resp.status_code != 200:
        return RouteOutcome(
            registered=False,
            detail=(
                f"the gateway did not remove route {role}: {_error_detail(resp)} — remove it "
                "from Settings → Routing"
            ),
        )
    return RouteOutcome(registered=True, detail=f"route {role} removed")


# ── create / update / delete ───────────────────────────────────────────────


@dataclass
class CreateResult:
    agent: Agent
    folder: Path
    route: RouteOutcome
    text: str


@dataclass
class DeleteResult:
    name: str
    # {id, title, already_paused}: already_paused is None for a timer THIS
    # delete paused, else the reason the timer already carried (kept as is).
    paused_timers: list[dict]
    route: RouteOutcome
    remains: str
    text: str


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


def _timers_sentence(paused: Sequence[dict]) -> str:
    """What the delete did to the timers bound to the agent, BOTH groups
    named: the ones it paused, and the ones already paused that it only
    unbound — with the reason each of those kept, since it was not touched."""
    fresh = [t for t in paused if t["already_paused"] is None]
    kept = [t for t in paused if t["already_paused"] is not None]
    if not fresh and not kept:
        return "no timers were bound to it"
    parts = []
    if fresh:
        titles = ", ".join(t["title"] for t in fresh)
        parts.append(f"paused {_plural(len(fresh), 'timer')}: {titles}")
    if kept:
        reasons = ", ".join(f"{t['title']}: {t['already_paused']}" for t in kept)
        one = len(kept) == 1
        parts.append(
            f"{_plural(len(kept), 'timer')} {'was' if one else 'were'} already paused ({reasons}) "
            f"and {'is' if one else 'are'} now unbound"
        )
    return "; ".join(parts)


def _make_folder(folder: Path, name: str) -> None:
    try:
        folder.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise AgentError(f"could not create the folder agents/{name}/ — {exc}") from exc
    if not folder.is_dir():
        raise AgentError(f"agents/{name}/ was not a directory after mkdir — {folder}")


def money(value) -> str:
    """'$1.23' — two decimals, four when under a cent, the Spend page's own
    rendering so a cap here and a figure there never disagree."""
    return _usd(float(value))


def _describe(verb: str, agent: Agent, *, folder: Path, route: RouteOutcome) -> str:
    """The sentence a create/update returns, composed ONLY from what was read
    back after the commit: the row, the folder on disk, the registry size
    now, and the gateway's answer as it was given."""
    registry_size = len(tools.REGISTRY)
    cap = "none" if agent.monthly_cap_usd is None else f"{money(agent.monthly_cap_usd)}/month"
    memory = "own notes + shared read" if agent.read_shared_memory else "own notes only"
    folder_words = (
        f"folder agents/{agent.name}/ exists"
        if folder.is_dir()
        else f"folder agents/{agent.name}/ is MISSING"
    )
    skills = f"; skills: {', '.join(agent.skills)}" if agent.skills else ""
    return (
        f"{verb} agent {agent.name} — purpose: {_one_line(agent.purpose)}; "
        f"tools: {len(agent.tools)} of {registry_size} ({', '.join(agent.tools) or 'none'}); "
        f"{folder_words}; rounds {agent.max_tool_rounds}; cap {cap}; memory: {memory}{skills}; "
        f"{route.detail}; log conversation {agent.log_conversation_id}"
    )


async def _read_back(pool: asyncpg.Pool, name: str, folder: Path) -> Agent:
    agent = await by_name(pool, name)
    if agent is None:
        raise AgentError(f"agent {name} was committed but could not be read back")
    if not folder.is_dir():
        raise AgentError(f"agent {name} was committed but its folder agents/{name}/ is not there")
    return agent


async def create(
    pool: asyncpg.Pool,
    app,
    spec: AgentSpec,
    *,
    created_via: str,
    created_turn_id: uuid.UUID | None,
    actor: str,
) -> CreateResult:
    """The one way an agent comes to exist, from the page or from Nova's
    tool. In order, each step verified: validate; ONE transaction holding
    the log conversation, the row, the ledger event and the folder (an
    OSError rolls the row back with its reason — a row whose folder is not
    there is not an agent); after commit the gateway route, whose failure
    is STATED in the result and never a rollback (the agent is servable on
    the chat chain without a row of its own); then the row and the folder
    read back, and the sentence composed from what was read."""
    validate_spec(spec)
    if created_via not in CREATED_VIA:
        raise AgentError(
            f"created_via must be one of {', '.join(CREATED_VIA)}, got {created_via!r}"
        )
    rounds = await _rounds_for(pool, spec)
    cap = _cap_decimal(spec.monthly_cap_usd)
    owner = await _owner_or_refuse(pool)
    folder = _folder(spec.name, None)
    async with pool.acquire() as conn, conn.transaction():
        if await conn.fetchval("SELECT 1 FROM agents WHERE name = $1", spec.name):
            raise AgentError(f"an agent named {spec.name} already exists")
        log_id = await _insert_log_conversation(conn, owner, spec.name)
        try:
            row = await conn.fetchrow(
                "INSERT INTO agents (name, purpose, instructions, tools, skills, monthly_cap_usd, "
                "max_tool_rounds, read_shared_memory, log_conversation_id, created_via, "
                "created_turn_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) "
                f"RETURNING {_COLUMNS}",
                spec.name,
                spec.purpose,
                spec.instructions,
                list(spec.tools),
                list(spec.skills),
                cap,
                rounds,
                bool(spec.read_shared_memory),
                log_id,
                created_via,
                created_turn_id,
            )
        except asyncpg.UniqueViolationError as exc:
            raise AgentError(f"an agent named {spec.name} already exists") from exc
        agent = Agent.from_row(row)
        await governance.record_event(
            conn,
            kind=governance.AGENT_CREATED,
            actor=actor,
            subject_ref=agent.id,
            meta=_spec_meta(spec, rounds, created_via),
        )
        _make_folder(folder, spec.name)
    route = await register_route(app, agent, spec.model_chain)
    read = await _read_back(pool, spec.name, folder)
    return CreateResult(
        agent=read,
        folder=folder,
        route=route,
        text=_describe("created", read, folder=folder, route=route),
    )


# The fields an update may carry. `name` is refused with its own reason;
# anything else is refused by naming these.
UPDATABLE = frozenset(
    {
        "purpose",
        "instructions",
        "tools",
        "skills",
        "monthly_cap_usd",
        "max_tool_rounds",
        "read_shared_memory",
        "model_chain",
    }
)


async def update(pool: asyncpg.Pool, app, name: str, changes: dict, *, actor: str) -> CreateResult:
    """Change any field but the name: the merged spec is validated the same
    way a new one is, the row updated, the ledger told which keys moved, and
    — only when the chain is among them — the gateway route re-registered."""
    if "name" in changes and changes["name"] != name:
        raise AgentError(
            "an agent cannot be renamed — its route and folder are bound to the name; "
            "delete it and create another"
        )
    unknown = sorted(set(changes) - UPDATABLE - {"name"})
    if unknown:
        raise AgentError(
            f"an agent has no field(s) {', '.join(unknown)} — the fields are: "
            f"{', '.join(sorted(UPDATABLE))}"
        )
    current = await by_name(pool, name)
    if current is None:
        raise _no_such(name, await names(pool))

    def pick(key: str, default):
        return changes[key] if key in changes else default

    # The lists are carried AS GIVEN into the one validator: _names_tuple
    # refuses a None or a bare string in words, where an `or ()` would have
    # made None mean "clear the list" — an assertion the caller never made.
    merged = AgentSpec(
        name=name,
        purpose=pick("purpose", current.purpose),
        instructions=pick("instructions", current.instructions),
        tools=pick("tools", current.tools),
        skills=pick("skills", current.skills),
        monthly_cap_usd=pick("monthly_cap_usd", current.monthly_cap_usd),
        max_tool_rounds=pick("max_tool_rounds", current.max_tool_rounds),
        read_shared_memory=bool(pick("read_shared_memory", current.read_shared_memory)),
        model_chain=changes.get("model_chain", ()),
    )
    validate_spec(merged)
    rounds = await _rounds_for(pool, merged)
    cap = _cap_decimal(merged.monthly_cap_usd)
    changed = sorted(key for key in changes if key != "name")
    async with pool.acquire() as conn, conn.transaction():
        row = await conn.fetchrow(
            "UPDATE agents SET purpose = $2, instructions = $3, tools = $4, skills = $5, "
            "monthly_cap_usd = $6, max_tool_rounds = $7, read_shared_memory = $8, "
            f"updated_at = now() WHERE id = $1 RETURNING {_COLUMNS}",
            current.id,
            merged.purpose,
            merged.instructions,
            list(merged.tools),
            list(merged.skills),
            cap,
            rounds,
            merged.read_shared_memory,
        )
        if row is None:
            raise _no_such(name, await names(pool))
        agent = Agent.from_row(row)
        await governance.record_event(
            conn,
            kind=governance.AGENT_UPDATED,
            actor=actor,
            subject_ref=agent.id,
            meta={
                "name": name,
                "changed": changed,
                # The chain is not a column: an update that did not carry one
                # wrote nothing about it, so the ledger says nothing about it.
                "after": _spec_meta(merged, rounds, with_chain="model_chain" in changes),
            },
        )
    if "model_chain" in changes:
        route = await register_route(app, agent, merged.model_chain)
    else:
        route = await _route_unchanged(app, agent)
    folder = _folder(name, None)
    read = await by_name(pool, name)
    if read is None:
        raise AgentError(f"agent {name} was updated but could not be read back")
    return CreateResult(
        agent=read,
        folder=folder,
        route=route,
        text=_describe("updated", read, folder=folder, route=route),
    )


async def delete(pool: asyncpg.Pool, app, name: str, *, actor: str) -> DeleteResult:
    """The one delete path (the page and the tool both come here). ONE
    transaction pauses every RUNNING timer bound to the agent with the
    reason, unbinds every bound timer (the RESTRICT foreign key would
    otherwise refuse the row's deletion — the backstop for any path that
    forgets this), deletes the row and checks the command tag said so, and
    writes the ledger event; after commit the gateway route is dropped,
    stated either way. A timer that was ALREADY paused keeps its own
    paused_at and reason — that reason is the record of why it stopped, and
    overwriting it would hide a failure pause behind this delete (the same
    rule timers.pause applies) — and the result names it as unbound, not
    paused. The folder, the memory notes and the log conversation stay, and
    the result says so."""
    agent = await by_name(pool, name)
    if agent is None:
        raise _no_such(name, await names(pool))
    reason = f"paused: agent {name} was deleted"
    async with pool.acquire() as conn, conn.transaction():
        fresh_rows = await conn.fetch(
            "UPDATE timers SET paused_at = now(), paused_reason = $2, agent_id = NULL, "
            "updated_at = now() WHERE agent_id = $1 AND paused_at IS NULL RETURNING id, title",
            agent.id,
            reason,
        )
        kept_rows = await conn.fetch(
            "UPDATE timers SET agent_id = NULL, updated_at = now() "
            "WHERE agent_id = $1 AND paused_at IS NOT NULL RETURNING id, title, paused_reason",
            agent.id,
        )
        paused = [
            {"id": str(row["id"]), "title": row["title"], "already_paused": None}
            for row in fresh_rows
        ] + [
            {"id": str(row["id"]), "title": row["title"], "already_paused": row["paused_reason"]}
            for row in kept_rows
        ]
        tag = await conn.execute("DELETE FROM agents WHERE id = $1", agent.id)
        if tag != "DELETE 1":
            raise AgentError(f"agent {name} was not deleted — the database said {tag!r}")
        await governance.record_event(
            conn,
            kind=governance.AGENT_DELETED,
            actor=actor,
            subject_ref=agent.id,
            meta={"name": name, "paused_timers": paused},
        )
    route = await unregister_route(app, agent)
    if await by_name(pool, name) is not None:
        raise AgentError(f"agent {name} still exists after its delete committed")
    remains = (
        f"its folder agents/{name}/, its memory notes and its log conversation were left in place"
    )
    return DeleteResult(
        name=name,
        paused_timers=paused,
        route=route,
        remains=remains,
        text=f"deleted agent {name} — {_timers_sentence(paused)}; {route.detail}; {remains}",
    )


# ── the cap, read from the ledger ──────────────────────────────────────────


async def cap_problem(app, pool: asyncpg.Pool, agent: Agent) -> tuple[str | None, dict]:
    """Is the agent over its monthly cap? Read from the SAME report the
    Spend page shows (spend_api.report, the gateway's by_role rollup for the
    owner's month), so a refusal here and a figure there never disagree.
    Returns (the stated problem or None, the facts for the span). A ledger
    that cannot be read is NOT a refusal — the turn runs and the facts say
    `unreadable: <reason>` so nothing is quiet about it (rail 20)."""
    facts: dict = {"role": agent.role, "cap_usd": None, "ledger": "skipped"}
    if agent.monthly_cap_usd is None:
        return None, facts
    cap = float(agent.monthly_cap_usd)
    facts["cap_usd"] = cap
    try:
        report = await spend_api.report(app, pool, "month")
    except Exception as exc:  # noqa: BLE001 — every failure shape is stated, none refuses
        detail = getattr(exc, "detail", None) or str(exc) or type(exc).__name__
        facts.update(spent_usd=None, ledger=f"unreadable: {detail}")
        return None, facts
    spent = 0.0
    for row in report.get("by_role") or []:
        if isinstance(row, dict) and row.get("key") == agent.role:
            usd = row.get("usd")
            if isinstance(usd, int | float) and not isinstance(usd, bool):
                spent += float(usd)
    facts.update(spent_usd=spent, ledger="read")
    # The refusal is at >=, but the sentence is persisted as the turn's reply:
    # "over" at equality would record a figure the ledger never showed.
    if spent > cap:
        return (
            f"agent {agent.name} is over its monthly cap ({money(spent)} of {money(cap)} this "
            "month) — raise it on the Agents page",
            facts,
        )
    if spent == cap:
        return (
            f"agent {agent.name} has reached its monthly cap ({money(spent)} of {money(cap)} "
            "this month) — raise it on the Agents page",
            facts,
        )
    return None, facts


# ── the phantom-person guard ───────────────────────────────────────────────


def refuse_person_write(ctx, what: str) -> None:
    """A tool that would write a row bound to a PERSON (a timer, a
    conversation) calls this first: an agent turn's ctx.person is a value
    with no people row, so the write would fail the foreign key — refused
    here in words the agent can act on instead."""
    if getattr(getattr(ctx, "person", None), "role", None) == AGENT_PERSON_ROLE:
        raise ToolFailure(
            f"{what} belongs to a person and an agent is not one — put it in your report and "
            "Nova will do it"
        )
