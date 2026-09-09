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
      "message": "what's the latest on the pixel camera?",
      "contract": [
        {"predicate": "tool_called", "arg": "web_search"},
        {"predicate": "reply_absent", "arg": "I can't access"}
      ]
    }

`setup` declares the HISTORY a case is replayed against; `agents` declares the
WORLD it is replayed in (see FixtureAgent) — the same spirit, one file, and
both are torn down with the rest of the scratch state.

`suite_version` is pinned on every case so a score is only ever compared across
runs of the SAME version (comparability rail): change a suite's cases, bump its
version, and old runs stay out of the new denominator.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from app import agents

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
    max_tool_rounds: int | None = None

    def __post_init__(self) -> None:
        if not self.name.startswith(FIXTURE_AGENT_PREFIX):
            raise CaseError(
                f"a case's agent name must start with {FIXTURE_AGENT_PREFIX!r} "
                f"(the harness creates and deletes these rows in the live roster, so a "
                f"declared name must never collide with an agent the owner made), got "
                f"{self.name!r}"
            )

    def as_json(self) -> dict:
        out: dict = {
            "name": self.name,
            "purpose": self.purpose,
            "instructions": self.instructions,
            "tools": list(self.tools),
        }
        if self.max_tool_rounds is not None:
            out["max_tool_rounds"] = self.max_tool_rounds
        return out


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

    def as_json(self) -> dict:
        return {
            "id": self.id,
            "suite": self.suite,
            "suite_version": self.suite_version,
            "message": self.message,
            "setup": [{"user": t.user, "assistant": t.assistant} for t in self.setup],
            "agents": [a.as_json() for a in self.agents],
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
    rounds = raw.get("max_tool_rounds")
    if rounds is not None and (isinstance(rounds, bool) or not isinstance(rounds, int)):
        raise CaseError(f"a case agent's max_tool_rounds must be a whole number, got {rounds!r}")
    return FixtureAgent(
        name=_require(raw, "name", str),
        purpose=_require(raw, "purpose", str),
        instructions=_require(raw, "instructions", str),
        tools=tuple(name.strip() for name in tools_raw),
        max_tool_rounds=rounds,
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
    return Case(
        id=_require(raw, "id", str),
        suite=_require(raw, "suite", str),
        suite_version=_require(raw, "suite_version", int),
        message=_require(raw, "message", str),
        contract=contract,
        setup=setup,
        agents=fixture_agents,
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
