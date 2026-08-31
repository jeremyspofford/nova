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
      "message": "what's the latest on the pixel camera?",
      "contract": [
        {"predicate": "tool_called", "arg": "web_search"},
        {"predicate": "reply_absent", "arg": "I can't access"}
      ]
    }

`suite_version` is pinned on every case so a score is only ever compared across
runs of the SAME version (comparability rail): change a suite's cases, bump its
version, and old runs stay out of the new denominator.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

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
        "consent_card_raised",
        "reply_matches",
        "reply_absent",
    }
)

# Predicates that carry no argument (everything else requires a non-empty arg:
# a tool name, a guard name, or a regex).
_ARGLESS_PREDICATES = frozenset({"consent_card_raised"})


class CaseError(ValueError):
    """A fixture that does not describe a valid case, refused by name."""


@dataclass(frozen=True)
class PredicateSpec:
    """One mechanical check in a contract. `predicate` names a function in
    predicates.py; `arg` is its parameter — a tool name, a guard name, or a
    regex — or None for an argless predicate (consent_card_raised)."""

    predicate: str
    arg: str | None = None

    def __post_init__(self) -> None:
        if self.predicate not in KNOWN_PREDICATES:
            raise CaseError(
                f"unknown predicate {self.predicate!r} — known: "
                f"{', '.join(sorted(KNOWN_PREDICATES))}"
            )
        argless = self.predicate in _ARGLESS_PREDICATES
        if argless and self.arg is not None:
            raise CaseError(f"predicate {self.predicate!r} takes no arg, got {self.arg!r}")
        if not argless and not self.arg:
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

    def as_json(self) -> dict:
        return {
            "id": self.id,
            "suite": self.suite,
            "suite_version": self.suite_version,
            "message": self.message,
            "setup": [{"user": t.user, "assistant": t.assistant} for t in self.setup],
            "contract": [p.as_json() for p in self.contract],
        }


def _require(raw: dict, key: str, kind: type):
    if key not in raw:
        raise CaseError(f"case is missing required field {key!r}")
    value = raw[key]
    if not isinstance(value, kind):
        raise CaseError(f"field {key!r} must be {kind.__name__}, got {type(value).__name__}")
    return value


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
    return Case(
        id=_require(raw, "id", str),
        suite=_require(raw, "suite", str),
        suite_version=_require(raw, "suite_version", int),
        message=_require(raw, "message", str),
        contract=contract,
        setup=setup,
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
