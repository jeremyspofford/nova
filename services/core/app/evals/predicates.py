"""Mechanical predicates over a turn's trace — the T1 evaluator.

Every predicate here is PURE and DETERMINISTIC over exactly two inputs: the
turn's spans (traces.Span — kind/name/meta, as _run_turn recorded them) and its
final durable reply. No model call, no clock, no DB — the same (spans, reply)
always scores the same. These are the FACTS a real turn leaves behind; a case's
contract is a conjunction of them, and the case passes iff every one passes.

Judged/LLM predicates (relevance, no-tangent, synthesis) are a T2 concern and a
DIFFERENT, separately-reported score — this module is only the mechanical half,
and it is deliberately the load-bearing one: a mechanical verdict cannot be
argued with.

Span facts these read, all set by chat.py's turn path:
  * a tool call         -> Span(kind="tool", name=<tool>, meta={"ok": bool, ...}).
                           Every call RUNS (v4 has no approval step, owner
                           ruling 2026-09-03), so ok is the executor's verdict
                           and nothing else's.
  * a guard that engaged -> Span(kind="guard", name=<guard>, meta=...). The
                           honesty guards (narration/consent_claim/
                           capability_claim) record a span ONLY when they
                           corrected the reply, so presence == fired. The
                           deferral guard records one when a deferral was
                           detected and handled. The opt-in responsiveness guard
                           records one whenever it ran (verdict may be on_topic).
                           `guard_fired` means "this guard left a span this
                           turn"; a T2 case wanting a finer distinction pairs it
                           with a reply predicate.
"""
from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from typing import Any

from app.evals.cases import KNOWN_PREDICATES, PredicateSpec

# A predicate: (spans, reply, arg) -> (passed, detail). `arg` is the spec's
# argument (a tool/guard name or a regex) — every predicate has one; the type
# keeps `str | None` only because PredicateSpec.arg is declared that way.
Predicate = Callable[[Sequence[Any], str, str | None], "tuple[bool, str]"]


def _tool_spans(spans: Sequence[Any], name: str) -> list[Any]:
    return [s for s in spans if s.kind == "tool" and s.name == name]


def tool_called(spans: Sequence[Any], reply: str, name: str | None) -> tuple[bool, str]:
    hits = _tool_spans(spans, name)
    return bool(hits), f"tool {name!r} has {len(hits)} span(s) this turn"


def tool_succeeded(spans: Sequence[Any], reply: str, name: str | None) -> tuple[bool, str]:
    hits = _tool_spans(spans, name)
    ok = [s for s in hits if s.meta.get("ok") is True]
    return bool(ok), f"tool {name!r}: {len(ok)} of {len(hits)} span(s) ok=True"


def tool_not_called(spans: Sequence[Any], reply: str, name: str | None) -> tuple[bool, str]:
    hits = _tool_spans(spans, name)
    return not hits, f"tool {name!r} has {len(hits)} span(s) this turn (want 0)"


def guard_fired(spans: Sequence[Any], reply: str, name: str | None) -> tuple[bool, str]:
    hits = [s for s in spans if s.kind == "guard" and s.name == name]
    return bool(hits), f"guard {name!r} left {len(hits)} span(s) this turn"


def guard_absent(spans: Sequence[Any], reply: str, name: str | None) -> tuple[bool, str]:
    hits = [s for s in spans if s.kind == "guard" and s.name == name]
    return not hits, f"guard {name!r} left {len(hits)} span(s) this turn (want 0)"


def reply_matches(spans: Sequence[Any], reply: str, pattern: str | None) -> tuple[bool, str]:
    hit = re.search(pattern, reply, re.I) is not None
    return hit, f"reply {'matches' if hit else 'does not match'} /{pattern}/i"


def reply_absent(spans: Sequence[Any], reply: str, pattern: str | None) -> tuple[bool, str]:
    hit = re.search(pattern, reply, re.I) is not None
    return not hit, f"reply {'contains' if hit else 'is free of'} /{pattern}/i (want absent)"


# The registry. Its keys MUST equal cases.KNOWN_PREDICATES — a test pins that, so
# a predicate added to one and forgotten in the other is a loud failure, not a
# case that loads and then never scores.
PREDICATES: dict[str, Predicate] = {
    "tool_called": tool_called,
    "tool_succeeded": tool_succeeded,
    "tool_not_called": tool_not_called,
    "guard_fired": guard_fired,
    "guard_absent": guard_absent,
    "reply_matches": reply_matches,
    "reply_absent": reply_absent,
}

assert set(PREDICATES) == set(KNOWN_PREDICATES), (
    "predicates.PREDICATES and cases.KNOWN_PREDICATES have drifted: "
    f"{set(PREDICATES) ^ set(KNOWN_PREDICATES)}"
)


class PredicateResult:
    """One predicate's verdict, with the detail string it produced — the
    per-case evidence the page (T3) renders and the eval_runs detail stores."""

    __slots__ = ("predicate", "arg", "passed", "detail")

    def __init__(self, predicate: str, arg: str | None, passed: bool, detail: str) -> None:
        self.predicate = predicate
        self.arg = arg
        self.passed = passed
        self.detail = detail

    def as_json(self) -> dict:
        return {
            "predicate": self.predicate,
            "arg": self.arg,
            "passed": self.passed,
            "detail": self.detail,
        }


def evaluate(spec: PredicateSpec, spans: Sequence[Any], reply: str) -> PredicateResult:
    passed, detail = PREDICATES[spec.predicate](spans, reply, spec.arg)
    return PredicateResult(spec.predicate, spec.arg, passed, detail)


def score_contract(
    contract: Sequence[PredicateSpec], spans: Sequence[Any], reply: str
) -> tuple[bool, list[PredicateResult]]:
    """(passed, per-predicate results). A case passes iff ALL predicates pass;
    every predicate is evaluated (no short-circuit) so the detail explains a
    failure fully."""
    results = [evaluate(spec, spans, reply) for spec in contract]
    return all(r.passed for r in results), results
