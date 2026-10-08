"""The case model — an eval case is DATA, not a table.

A case is a MIRROR of a real interaction (S4's rule: "fixtures are mirrors, not
inventions"): a setup (optional prior turns), the user message to replay, and a
CONTRACT — a list of mechanical predicate specs checked against the FRESH
response's trace. The contract is a SUBSET match against what the real turn left
behind (spans + reply); it is NEVER "the reply must equal a recorded string",
because a different model answers the same question with different words and a
brittle equality would measure phrasing, not behaviour.

The corpus itself (the encoded failures from the owner walk) is populated by
T2 — this module ships the SHAPE and a git-fixture loader, so a case added to
`cases/` as JSON is versioned in git and loaded by that fact alone. Tests may
also construct Case objects inline; the fixture files are for the persisted
corpus.

Fixture JSON (one file per case, under app/evals/cases/):

    {
      "id": "latest-topic-runs-a-web-search",
      "suite": "corpus",
      "suite_version": 1,
      "setup": [{"user": "...", "assistant": "..."}],   # optional; default []
      "agents": [{"name": "eval_writer", "purpose": "...",   # optional; default []
                  "instructions": "...", "tools": ["workspace_write_file"]}],
      "machines": [{"name": "eval_box", "serving": true}],   # optional; default []
      "devices": [{"name": "eval_pc", "platform": "windows",  # optional; default [] (S42a)
                   "hostname": "EVAL-PC", "connected": true, "facts": {...},
                   "update": "sent"}],                  # optional (S42b): machine_update's answer
      "mcp_servers": [{"name": "eval_github",  # optional; default [] (S37a)
                       "title": "GitHub", "tools": [...]}],
      "message": "what's the latest on the pixel camera?",
      "contract": [
        {"predicate": "tool_called", "arg": "web_search"},
        {"predicate": "reply_absent", "arg": "I can't access"}
      ]
    }

`setup` declares the HISTORY a case is replayed against; `agents` declares the
WORLD it is replayed in (see FixtureAgent) — the same spirit, one file, and
both are torn down with the rest of the scratch state. `machines` (S40) is the
one declaration that is never built: they are the gateway's rows, so the
runner answers for them from the declaration instead (see FixtureMachine).
`devices` (S42a) is the same kind of declaration: an agent the plant answers
for (see FixtureDevice). `mcp_servers` (S37a) is the same kind again, one
layer over: a case's declared servers overlay her connections for that case
alone, and the owner's real servers never answer an eval turn (see
FixtureMcpServer).

`suite_version` is pinned on every case so a score is only ever compared across
runs of the SAME version (comparability rail): change a suite's cases, bump its
version, and old runs stay out of the new denominator.
"""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit

from app import agents, device_facts, machines
from app.mcp import client as mcp_client
from app.mcp import fake as mcp_fake
from app.mcp import servers as mcp_servers

# The predicate names a contract may use. Kept here (not imported from
# predicates.py) so a fixture is validated at LOAD time against the known set,
# turning a typo in a hand-written case into a loud error rather than a
# silently-never-true predicate at score time. predicates.py's registry is the
# other half of this contract; a test pins the two lists identical.
KNOWN_PREDICATES = frozenset(
    {
        "tool_called",
        "tool_succeeded",
        "tool_not_called",
        "guard_fired",
        "guard_absent",
        "reply_matches",
        "reply_absent",
        # S40: tool_succeeded plus the ARGUMENTS it ran with, because an ok
        # span alone cannot say which way a switch was set.
        "tool_succeeded_with",
    }
)


class CaseError(ValueError):
    """A fixture that does not describe a valid case, refused by name."""


@dataclass(frozen=True)
class PredicateSpec:
    """One mechanical check in a contract. `predicate` names a function in
    predicates.py; `arg` is its parameter — a tool name, a guard name, or a
    regex. Every predicate takes one (there is no argless predicate: the one
    there was, consent_card_raised, left with the approval step it read)."""

    predicate: str
    arg: str | None = None

    def __post_init__(self) -> None:
        if self.predicate not in KNOWN_PREDICATES:
            raise CaseError(
                f"unknown predicate {self.predicate!r} — known: "
                f"{', '.join(sorted(KNOWN_PREDICATES))}"
            )
        if not self.arg:
            raise CaseError(f"predicate {self.predicate!r} requires a non-empty arg")
        if self.predicate == "tool_succeeded_with":
            parse_tool_with(self.arg)  # refused at LOAD, by name

    def as_json(self) -> dict:
        out: dict = {"predicate": self.predicate}
        if self.arg is not None:
            out["arg"] = self.arg
        return out


@dataclass(frozen=True)
class PriorTurn:
    """A prior exchange seeded into the replayed turn's history — the "setup"
    state a case needs (e.g. an earlier answer the follow-up refers to). Only
    user/assistant pairs, because that is all `history_window` carries into the
    next turn's prompt (chat.py); tool calls are deliberately not replayed."""

    user: str
    assistant: str


# The name prefix every declared fixture agent carries, refused at LOAD if it
# is missing. The runner CREATES these rows in the live `agents` table and
# DELETES them again (runner._create_fixture_agents / _delete_fixture_agents),
# so the blast radius of a teardown has to be a name that can never be
# mistaken for one the owner made: the runner only ever deletes a name a case
# declares, and a declared name always starts with this. (2026-09-09)
#
# It is the ROSTER'S constant, not a copy of it (2026-09-09 review): agents.py
# reserves this prefix in validate_spec, so the page and her create_agent tool
# mechanically CANNOT make a name the teardown would reach — which is the
# premise this deletion rests on. Two literals with the same value would let
# that premise rot silently the day one moved. The dependency runs one way:
# evals reads the roster's rule (runner.py already imports app.agents), and
# app.agents never imports app.evals.
FIXTURE_AGENT_PREFIX = agents.EVAL_FIXTURE_PREFIX


@dataclass(frozen=True)
class FixtureAgent:
    """One agent that must EXIST for a case's replay — the WORLD the turn is
    scored in, declared beside the `setup` history it is scored against.

    WHY a declaration and not something a prior turn could set up: two of the
    facts an agent case reads are LIVE TABLE state, not history.
    guards.delegation_claim_check is derived from the live roster
    (chat._agent_names -> agents.names), and an empty roster returns None BY
    CONSTRUCTION — so in the scratch world every case about an agent claim
    would score green because the detector could never fire: a case passing
    for the wrong reason, which is worse than no case (this is exactly why
    the delegation case was deferred twice). delegate_to_agent is the same
    story from the other side: with no row, agents.delegate refuses the call
    before anything runs, so no contract about delegating could ever be met.

    The runner builds these through app/agents.py's own writer, never by
    writing rows by hand, so a case exercises the same create/delete the page
    and her create_agent tool use — a fixture that drifts from the product's
    writer would measure a world the product cannot produce.

    The fields are the create tool's four required ones plus the optional
    round budget (a case that wants to bound what a delegated child turn may
    spend). Everything else an agent's row carries is left at the writer's own
    defaults; a case that needs one adds it here. Only ONE rule is enforced at
    load — the reserved name prefix, which is the harness's own safety rule
    (see FIXTURE_AGENT_PREFIX). Every other rule about a spec is
    agents.validate_spec's (the name pattern, a tool that must be registered,
    the rounds range) and is refused at replay time in the writer's own words,
    which the runner reports as an UNGRADEABLE run — one validator, never a
    copy of it here."""

    name: str
    purpose: str
    instructions: str
    tools: tuple[str, ...]

    def __post_init__(self) -> None:
        if not self.name.startswith(FIXTURE_AGENT_PREFIX):
            raise CaseError(
                f"a case's agent name must start with {FIXTURE_AGENT_PREFIX!r} "
                f"(the harness creates and deletes these rows in the live roster, so a "
                f"declared name must never collide with an agent the owner made), got "
                f"{self.name!r}"
            )

    def as_json(self) -> dict:
        return {
            "name": self.name,
            "purpose": self.purpose,
            "instructions": self.instructions,
            "tools": list(self.tools),
        }


@dataclass(frozen=True)
class FixtureSkill:
    """One skill that must EXIST and be ACTIVE for a case's replay.

    Same argument as FixtureAgent, one layer down: the roster Nova reads is
    LIVE table state, and app/skills.py's roster_line returns None with no
    active row — so in the scratch world a case about whether she reads a
    procedure would score against a world where there is nothing to read.

    A case DECLARES the whole skill (its body included) rather than naming one
    it hopes the household has: a corpus case that depended on the owner's own
    rows would measure a different world on every machine. The runner writes
    it through app/skills.py's own writer and deletes it afterwards.

    The one exception, and it is why `body` may be None: the trial
    (skills.trial) declares a skill that ALREADY exists, to run its own source
    request with it active and then put it back. The runner tells the two
    apart by looking for the row, never by a flag a caller sets — a caller
    that got the flag wrong would either delete the owner's skill or leave a
    fixture behind.
    """

    name: str
    title: str = "a declared skill"
    summary: str = "declared by an eval case"
    body: str | None = None
    # S18: a declared skill may be SCRIPTED, so a case can measure whether she
    # runs a procedure rather than walks it. Both or neither, checked by the
    # store when the row is written — this parser does not re-check the pair,
    # because skills.create owns that rule and a copy of it here would rot.
    script: dict | None = None
    inputs: dict | None = None

    def __post_init__(self) -> None:
        # A declaration that carries a BODY is a case building its own world,
        # and the runner deletes that row afterwards — so the name must be one
        # the owner's own skills can never collide with, the same rule and the
        # same prefix as a fixture agent. A declaration with no body names a
        # row that already exists and is only restored, so it is exempt.
        if self.body is not None and not self.name.startswith(FIXTURE_AGENT_PREFIX):
            raise CaseError(
                f"a case's declared skill must be named {FIXTURE_AGENT_PREFIX}… when it "
                f"carries a body (the harness creates and deletes that row), got {self.name!r}"
            )

    def as_json(self) -> dict:
        out: dict = {"name": self.name, "title": self.title, "summary": self.summary}
        if self.body is not None:
            out["body"] = self.body
        if self.script is not None:
            out["script"] = self.script
            out["inputs"] = self.inputs
        return out


def skill_from_dict(raw: object) -> FixtureSkill:
    """A declared skill, as a name or as an object. A bare string is the
    trial's shape (a row that already exists); an object is a corpus case
    declaring its own world."""
    if isinstance(raw, str):
        if not raw.strip():
            raise CaseError("a case's skill name must not be blank")
        return FixtureSkill(name=raw.strip())
    if not isinstance(raw, dict):
        raise CaseError(f"a case's skill must be a name or an object, got {type(raw).__name__}")
    return FixtureSkill(
        name=_require(raw, "name", str),
        title=raw.get("title", "a declared skill"),
        summary=raw.get("summary", "declared by an eval case"),
        body=raw.get("body"),
        script=raw.get("script"),
        inputs=raw.get("inputs"),
    )


def parse_tool_with(arg: str) -> tuple[str, dict]:
    """`<tool> <json object>` — the one predicate argument with two parts.

    tool_succeeded('machine_configure') is true whichever way she switched a
    machine: both are an ok span. A case about the DIRECTION of a write names
    the arguments too, and they are parsed here so a typo is a load error."""
    name, _, raw = arg.strip().partition(" ")
    if not name or not raw.strip():
        raise CaseError(f"tool_succeeded_with takes '<tool> <json object>', got {arg!r}")
    try:
        wanted = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise CaseError(f"tool_succeeded_with: {raw!r} is not JSON — {exc}") from exc
    if not isinstance(wanted, dict) or not wanted:
        raise CaseError(
            f"tool_succeeded_with: the arguments must be a non-empty JSON object, got {raw!r}"
        )
    return name, wanted


@dataclass(frozen=True)
class FixtureMachine:
    """One machine that must EXIST in the plant for a case's replay (S40).

    The third declaration of its kind, and the one that is never built.
    Agents and skills are core's rows, so the runner writes them through
    their own writers and deletes them after. A machine is the GATEWAY's row,
    and an eval must never write the owner's gateway: a case that switched
    off the real hub would leave every later case, and his chat, answered by
    the cloud. So the runner installs machines.FixturePlant as the plant for
    this case alone (a ContextVar — nothing else in the process sees it). It
    answers for the declared names from this declaration, overlays them on
    the real plant's listing, and refuses a write to any other name. Nothing
    is created, so there is nothing to tear down and nothing to sweep.

    The name carries the fixture prefix for the same reason an agent's does:
    the harness answers for that name instead of the real plant, so it must
    be a name no real machine can hold."""

    name: str
    serving: bool = True
    lifecycle: str = "always_on"
    compute: str | None = None
    runtime: str | None = None
    tags: dict | None = None

    def __post_init__(self) -> None:
        if not self.name.startswith(FIXTURE_AGENT_PREFIX):
            raise CaseError(
                f"a case's machine name must start with {FIXTURE_AGENT_PREFIX!r} (the harness "
                f"answers for it instead of the real plant, so it must never be a real "
                f"machine's name), got {self.name!r}"
            )

    def as_row(self) -> dict:
        """The gateway's EngineView shape — what GatewayPlant.engines() hands
        back from GET /admin/engines — built FRESH on every call, so a replay
        never inherits the previous replay's write. `state` is derived, never
        declared: serving=false is switched_off whatever else is true (the
        gateway's own rule), so a fixture cannot describe a machine the
        gateway could never report."""
        return {
            "name": self.name,
            # Never the bundled engine: that is the owner's real hub.
            "builtin": False,
            "lifecycle": self.lifecycle,
            "serving": self.serving,
            "state": "ready" if self.serving else "switched_off",
            "reason": None,
            "observed_at": None,
            "answered": True,
            "tags": dict(self.tags or {}),
            "tags_as_of": None,
            "compute": self.compute,
            "runtime": self.runtime,
            "facts": {},
        }

    def as_json(self) -> dict:
        out: dict = {"name": self.name, "serving": self.serving, "lifecycle": self.lifecycle}
        for key in ("compute", "runtime", "tags"):
            if getattr(self, key) is not None:
                out[key] = getattr(self, key)
        return out


# The keys a declared machine may carry — FixtureMachine's own fields, read
# off the dataclass rather than restated. A key outside them ("servng", a
# `state` the gateway derives) is refused at LOAD: silently ignoring it would
# replay a machine the case did not describe.
_MACHINE_KEYS = frozenset(FixtureMachine.__dataclass_fields__)


def machine_from_dict(raw: object) -> FixtureMachine:
    """Parse one declared machine, refusing a malformed one by name at LOAD."""
    if not isinstance(raw, dict):
        raise CaseError(f"a case's machine must be a JSON object, got {type(raw).__name__}")
    unknown = sorted(set(raw) - _MACHINE_KEYS)
    if unknown:
        raise CaseError(
            f"a case machine takes only {', '.join(sorted(_MACHINE_KEYS))}, got "
            f"{', '.join(map(repr, unknown))}"
        )
    serving = raw.get("serving", True)
    if not isinstance(serving, bool):
        raise CaseError(f"a case machine's serving must be true or false, got {serving!r}")
    for key in ("lifecycle", "compute", "runtime"):
        value = raw.get(key)
        if value is not None and not isinstance(value, str):
            raise CaseError(f"a case machine's {key} must be text, got {value!r}")
    tags = raw.get("tags")
    if tags is not None and (
        not isinstance(tags, dict)
        or any(
            not isinstance(k, str)
            or (v is not None and (isinstance(v, bool) or not isinstance(v, int)))
            for k, v in tags.items()
        )
    ):
        raise CaseError(
            f"a case machine's tags must map a model name to its size in bytes (or null), "
            f"got {tags!r}"
        )
    return FixtureMachine(
        name=_require(raw, "name", str),
        serving=serving,
        lifecycle=raw.get("lifecycle") or "always_on",
        compute=raw.get("compute"),
        runtime=raw.get("runtime"),
        tags=dict(tags) if tags is not None else None,
    )


@dataclass(frozen=True)
class FixtureDevice:
    """A paired machine's AGENT the plant must answer for (S42a).

    Like FixtureMachine, never built: a device row is the owner's pairing —
    enrolling one would spend a pairing code, write a device.enrolled event and
    take a name — so the runner makes the case's declarations the plant's
    agent listing (machines.FixturePlant.agents) for this case alone — the
    only agents a replay holds (S42b Task 22, the replay-hermeticity ruling).
    machine_status and device_list (S42b Task 21) read it, and machine_update
    answers for it without sending anything; the device tools that act on a
    machine do not (a declared device is for her to READ — acting on one gets
    the ordinary "no paired device named …" refusal, since no key exists to
    sign for).

    `facts` go through device_facts.validate_auth at load, so a case can never
    describe an agent a real one could not.

    `update` (S42b Task 24) is what machine_update answers for this device in
    the replay — machines.FixturePlant.update_agent, which sends nothing; the
    plant answers "sent" for a device that declares none. It is one of the
    plant's own outcomes (machines.FIXTURE_UPDATE_OUTCOMES), refused at LOAD
    otherwise — never device_facts.UPDATE_OUTCOMES, the agent's own report of
    an update, which is another set under a similar name."""

    name: str
    platform: str
    hostname: str
    connected: bool = True
    facts: dict | None = None
    update: str | None = None

    def __post_init__(self) -> None:
        if not self.name.startswith(FIXTURE_AGENT_PREFIX):
            raise CaseError(
                f"a case's device name must start with {FIXTURE_AGENT_PREFIX!r} (the harness "
                f"answers for it instead of the real registry), got {self.name!r}"
            )
        if self.platform not in device_facts.STORED_PLATFORMS:
            raise CaseError(
                f"a case device's platform must be one of "
                f"{', '.join(device_facts.STORED_PLATFORMS)}, got {self.platform!r}"
            )
        if self.facts is not None:
            try:
                clean = device_facts.validate_auth(self.facts)
            except device_facts.FactsRejected as exc:
                raise CaseError(
                    f"a case device's facts are not what an agent sends — {exc.reason}"
                ) from exc
            object.__setattr__(self, "facts", clean)
        if self.update is not None and self.update not in machines.FIXTURE_UPDATE_OUTCOMES:
            raise CaseError(
                f"a case device's update must be one of "
                f"{', '.join(machines.FIXTURE_UPDATE_OUTCOMES)}, got {self.update!r}"
            )

    def as_view(self) -> dict:
        """device_facts.agent_view, fresh on every call, stamped now."""
        now = datetime.now(UTC)
        return device_facts.agent_view(
            name=self.name,
            platform=self.platform,
            hostname=self.hostname,
            connected=self.connected,
            last_seen=now if self.connected else None,
            facts=copy.deepcopy(self.facts),
            facts_at=now if self.facts is not None else None,
        )

    def as_json(self) -> dict:
        out: dict = {
            "name": self.name,
            "platform": self.platform,
            "hostname": self.hostname,
            "connected": self.connected,
        }
        if self.facts is not None:
            out["facts"] = copy.deepcopy(self.facts)
        if self.update is not None:
            out["update"] = self.update
        return out


_DEVICE_KEYS = frozenset(FixtureDevice.__dataclass_fields__)


def device_from_dict(raw: object) -> FixtureDevice:
    """Parse one declared device, refusing a malformed one by name at LOAD."""
    if not isinstance(raw, dict):
        raise CaseError(f"a case's device must be a JSON object, got {type(raw).__name__}")
    unknown = sorted(set(raw) - _DEVICE_KEYS)
    if unknown:
        raise CaseError(
            f"a case device takes only {', '.join(sorted(_DEVICE_KEYS))}, got "
            f"{', '.join(map(repr, unknown))}"
        )
    connected = raw.get("connected", True)
    if not isinstance(connected, bool):
        raise CaseError(f"a case device's connected must be true or false, got {connected!r}")
    facts = raw.get("facts")
    if facts is not None and not isinstance(facts, dict):
        raise CaseError(f"a case device's facts must be an object, got {facts!r}")
    update = raw.get("update")
    if update is not None and not isinstance(update, str):
        raise CaseError(f"a case device's update must be text, got {update!r}")
    return FixtureDevice(
        name=_require(raw, "name", str),
        platform=_require(raw, "platform", str),
        hostname=_require(raw, "hostname", str),
        connected=connected,
        facts=facts,
        update=update,
    )


@dataclass(frozen=True)
class FixtureMcpTool:
    """One tool of a declared MCP server, and its canned answers in order (the
    last repeats) — app/mcp/fake.py's FakeTool, declared in a case."""

    name: str
    description: str = ""
    input_schema: dict = field(default_factory=lambda: {"type": "object", "properties": {}})
    results: tuple[dict, ...] = ({"text": "ok"},)

    def as_json(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "inputSchema": copy.deepcopy(self.input_schema),
            "results": [copy.deepcopy(r) for r in self.results],
        }


@dataclass(frozen=True)
class FixtureMcpServer:
    """An MCP server a case's turn can use (S37a). Never a row: the runner
    overlays the case's declared servers on her connections for this case
    alone (servers.OVERLAY) and plants each one's strict fake at its address
    (client.plant), so the owner's real servers never answer an eval turn and
    nothing a turn connects reaches the table (plan decision P11).

    `listed: false` plants the fake WITHOUT making it one of her connections —
    how S38 declares its fake Playwright engine at http://browser:8931/mcp,
    which core calls itself."""

    name: str
    title: str = "a declared MCP server"
    era: str = "modern"
    respond: str = "json"
    reachable: bool = True
    listed: bool = True
    url: str | None = None
    tools: tuple[FixtureMcpTool, ...] = ()

    def __post_init__(self) -> None:
        if not self.name.startswith(FIXTURE_AGENT_PREFIX) or not mcp_servers.NAME_RE.match(
            self.name
        ):
            raise CaseError(
                f"a case's MCP server name must start with {FIXTURE_AGENT_PREFIX!r} and be a valid "
                f"server name (2-32 of a-z, 0-9, - and _), got {self.name!r}"
            )
        if self.era not in ("modern", "legacy"):
            raise CaseError(f"a case's MCP server era must be modern or legacy, got {self.era!r}")
        if self.respond not in ("json", "sse"):
            raise CaseError(f"a case's MCP server must respond json or sse, got {self.respond!r}")
        if self.url is not None and urlsplit(self.url).scheme not in ("http", "https"):
            raise CaseError(f"a case's MCP server url must be http or https, got {self.url!r}")

    @property
    def endpoint_url(self) -> str:
        return self.url or f"http://{self.name.replace('_', '-')}.mcp.invalid/mcp"

    @property
    def origin(self) -> str:
        # One source (controller ruling F13, same rule as servers.Server.origin):
        # the client's own Endpoint, never a second derivation here.
        return mcp_client.Endpoint(name=self.name, url=self.endpoint_url).origin

    def fake_spec(self) -> mcp_fake.FakeSpec:
        return mcp_fake.FakeSpec(
            title=self.title,
            era=self.era,
            respond=self.respond,
            tools=tuple(
                mcp_fake.FakeTool(t.name, t.description, t.input_schema, t.results)
                for t in self.tools
            ),
        )

    def listed_tools(self) -> tuple[dict, ...]:
        return tuple(
            {
                "name": t.name,
                "description": t.description,
                "inputSchema": t.input_schema,
                "annotations": {},
            }
            for t in self.tools
        )

    def as_json(self) -> dict:
        return {
            "name": self.name,
            "title": self.title,
            "era": self.era,
            "respond": self.respond,
            "reachable": self.reachable,
            "listed": self.listed,
            "url": self.url,
            "tools": [t.as_json() for t in self.tools],
        }


def mcp_server_from_dict(raw: object) -> FixtureMcpServer:
    if not isinstance(raw, dict):
        raise CaseError(f"a case's MCP server must be an object, got {type(raw).__name__}")
    tools_raw = raw.get("tools", [])
    if not isinstance(tools_raw, list):
        raise CaseError("a case's MCP server tools must be a list")
    tools: list[FixtureMcpTool] = []
    for entry in tools_raw:
        if not isinstance(entry, dict):
            raise CaseError("a case's MCP tool must be an object")
        results = entry.get("results", [{"text": "ok"}])
        if (
            not isinstance(results, list)
            or not results
            or not all(isinstance(r, dict) for r in results)
        ):
            raise CaseError(
                f"MCP tool {entry.get('name')!r}: results must be a non-empty list of objects"
            )
        tools.append(
            FixtureMcpTool(
                name=_require(entry, "name", str),
                description=entry.get("description", ""),
                input_schema=entry.get("inputSchema", {"type": "object", "properties": {}}),
                results=tuple(results),
            )
        )
    return FixtureMcpServer(
        name=_require(raw, "name", str),
        title=raw.get("title", "a declared MCP server"),
        era=raw.get("era", "modern"),
        respond=raw.get("respond", "json"),
        reachable=bool(raw.get("reachable", True)),
        listed=bool(raw.get("listed", True)),
        url=raw.get("url"),
        tools=tuple(tools),
    )


@dataclass(frozen=True)
class Case:
    """One eval case. `contract` passes iff EVERY predicate passes (subset match
    against the trace, never equality against a recorded reply)."""

    id: str
    suite: str
    suite_version: int
    message: str
    contract: tuple[PredicateSpec, ...]
    setup: tuple[PriorTurn, ...] = ()
    agents: tuple[FixtureAgent, ...] = ()
    # S17: the skills that must exist and be ACTIVE for this turn. Live
    # table state, exactly like the agent roster (S12-3's fixture hook, same
    # reason): with every skill a draft, a case about whether she reads one
    # would measure a world where there is nothing to read. The runner creates
    # what is missing and deletes it after, and restores what already existed.
    skills: tuple[FixtureSkill, ...] = ()
    # S40: the machines the plant must answer for (see FixtureMachine).
    machines: tuple[FixtureMachine, ...] = ()
    # S42a: the agents the plant must answer for (see FixtureDevice).
    devices: tuple[FixtureDevice, ...] = ()
    # S37a: the MCP servers her turn can use — an overlay on her connections for
    # this case alone (see FixtureMcpServer).
    mcp_servers: tuple[FixtureMcpServer, ...] = ()

    def as_json(self) -> dict:
        return {
            "id": self.id,
            "suite": self.suite,
            "suite_version": self.suite_version,
            "message": self.message,
            "setup": [{"user": t.user, "assistant": t.assistant} for t in self.setup],
            "agents": [a.as_json() for a in self.agents],
            "skills": [s.as_json() for s in self.skills],
            "machines": [m.as_json() for m in self.machines],
            "devices": [d.as_json() for d in self.devices],
            "mcp_servers": [s.as_json() for s in self.mcp_servers],
            "contract": [p.as_json() for p in self.contract],
        }


def _require(raw: dict, key: str, kind: type):
    if key not in raw:
        raise CaseError(f"case is missing required field {key!r}")
    value = raw[key]
    if not isinstance(value, kind):
        raise CaseError(f"field {key!r} must be {kind.__name__}, got {type(value).__name__}")
    return value


def agent_from_dict(raw: dict) -> FixtureAgent:
    """Parse one declared fixture agent, refusing a malformed one by name.

    Types are checked here so a typo fails at LOAD rather than at replay time,
    where it would cost a live model round to discover. The SPEC's own rules
    are not re-checked here — agents.validate_spec owns them (see
    FixtureAgent) — with the single exception of the reserved name prefix,
    which is the harness's rule about what it may delete, not the product's."""
    if not isinstance(raw, dict):
        raise CaseError(f"a case's agent must be a JSON object, got {type(raw).__name__}")
    tools_raw = _require(raw, "tools", list)
    for name in tools_raw:
        if not isinstance(name, str) or not name.strip():
            raise CaseError(f"a case agent's tools must be tool names, got {name!r}")
    return FixtureAgent(
        name=_require(raw, "name", str),
        purpose=_require(raw, "purpose", str),
        instructions=_require(raw, "instructions", str),
        tools=tuple(name.strip() for name in tools_raw),
    )


def case_from_dict(raw: dict) -> Case:
    """Parse one fixture dict into a Case, refusing a malformed one by name.

    Every field is validated here (types, the predicate set, arg presence), so a
    bad fixture fails at load — never as a predicate that silently never matches
    at score time."""
    if not isinstance(raw, dict):
        raise CaseError(f"a case must be a JSON object, got {type(raw).__name__}")
    contract_raw = _require(raw, "contract", list)
    if not contract_raw:
        raise CaseError("a case contract must have at least one predicate")
    contract = tuple(
        PredicateSpec(predicate=_require(spec, "predicate", str), arg=spec.get("arg"))
        for spec in contract_raw
    )
    setup = tuple(
        PriorTurn(user=_require(t, "user", str), assistant=_require(t, "assistant", str))
        for t in raw.get("setup", [])
    )
    fixture_agents = tuple(agent_from_dict(a) for a in raw.get("agents", []))
    fixture_skills_raw = raw.get("skills", [])
    if not isinstance(fixture_skills_raw, list):
        raise CaseError(f"a case's skills must be a list, got {type(fixture_skills_raw).__name__}")
    fixture_skills = tuple(skill_from_dict(entry) for entry in fixture_skills_raw)
    machines_raw = raw.get("machines", [])
    if not isinstance(machines_raw, list):
        raise CaseError(f"a case's machines must be a list, got {type(machines_raw).__name__}")
    fixture_machines = tuple(machine_from_dict(entry) for entry in machines_raw)
    seen: set[str] = set()
    for machine in fixture_machines:
        if machine.name in seen:
            raise CaseError(f"a case declares the machine {machine.name!r} more than once")
        seen.add(machine.name)
    devices_raw = raw.get("devices", [])
    if not isinstance(devices_raw, list):
        raise CaseError(f"a case's devices must be a list, got {type(devices_raw).__name__}")
    fixture_devices = tuple(device_from_dict(entry) for entry in devices_raw)
    seen_devices: set[str] = set()
    for device in fixture_devices:
        if device.name in seen_devices:
            raise CaseError(f"a case declares the device {device.name!r} more than once")
        seen_devices.add(device.name)
    mcp_raw = raw.get("mcp_servers", [])
    if not isinstance(mcp_raw, list):
        raise CaseError(f"a case's mcp_servers must be a list, got {type(mcp_raw).__name__}")
    fixture_mcp = tuple(mcp_server_from_dict(entry) for entry in mcp_raw)
    if len({s.name for s in fixture_mcp}) != len(fixture_mcp):
        raise CaseError("a case declares the same MCP server more than once")
    return Case(
        id=_require(raw, "id", str),
        suite=_require(raw, "suite", str),
        suite_version=_require(raw, "suite_version", int),
        message=_require(raw, "message", str),
        contract=contract,
        setup=setup,
        agents=fixture_agents,
        skills=fixture_skills,
        machines=fixture_machines,
        devices=fixture_devices,
        mcp_servers=fixture_mcp,
    )


# The git-versioned corpus lives here; T2 fills it. A case exists because a JSON
# file in this directory says so — no registry to keep in step.
CASES_DIR = Path(__file__).resolve().parent / "cases"


def load_cases(cases_dir: Path | None = None) -> list[Case]:
    """Every *.json fixture in the directory, parsed. A missing directory is an
    empty corpus (T2 has not landed yet), not an error; a malformed file names
    itself in the raised CaseError so the bad fixture is obvious."""
    directory = cases_dir or CASES_DIR
    if not directory.is_dir():
        return []
    out: list[Case] = []
    for path in sorted(directory.glob("*.json")):
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise CaseError(f"{path.name} is not valid JSON: {exc}") from exc
        try:
            out.append(case_from_dict(raw))
        except CaseError as exc:
            raise CaseError(f"{path.name}: {exc}") from exc
    return out


def load_suite(suite: str, cases_dir: Path | None = None) -> list[Case]:
    """The cases of one suite, in id order. A suite mixing versions is a
    mistake the runner should never persist a blended score for, so this raises
    rather than silently return a mixed set — comparability is pinned at load."""
    cases = [c for c in load_cases(cases_dir) if c.suite == suite]
    versions = {c.suite_version for c in cases}
    if len(versions) > 1:
        raise CaseError(
            f"suite {suite!r} has cases at multiple versions {sorted(versions)} — "
            "bump the whole suite's version together so scores stay comparable"
        )
    return sorted(cases, key=lambda c: c.id)
