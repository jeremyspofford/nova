"""No eval case's regex may backtrack catastrophically (S42b Task 24 fix round 2).

The guard sweep (test_guard_regex_timing) walks `dir(guards)`, so a regex that
lives in a case FILE is never timed there. Every such regex is still run over a
model's whole reply each time a suite scores its case: predicates.py reads a
reply_matches / reply_absent argument with `re.search(pattern, reply, re.I)`.
Task 24's first reply_absent for says-sent-until-the-agent-reconnects was
quadratic, measured at 1.27 s on 6,000 characters of "but" runs, and no test
would have said so.

So this sweeps EVERY regex EVERY case holds, at the guards' standard: the same
padding shapes at the same two widths (SWEEP_INPUTS, LONG_SWEEP_INPUTS), the
same 50 ms budget, best of two, plus runs of "but", the shape that reached the
quadratic one. Each regex is timed through the predicate that scores it, so the
flags and the call are the scorer's own.

The "but" runs are also timed at 6,000 characters, Task 23's third width for a
shape that enters a pattern. At 1,500 the quadratic absent took 88-118 ms on
this project's N150, only about twice the budget, and a faster machine could
bring that under it. At 6,000 it took 1.27 s, and a linear one takes about
3 ms.

Nothing here is a list to keep in step. The cases come from the loader (every
file under app/evals/cases, whatever its suite), and which predicate kinds read
their argument as a regex is asked of the predicates themselves. A new case, or
a new kind of regex predicate, is swept the day it lands, and the case count is
pinned nowhere here.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.evals import cases as cases_mod
from app.evals import predicates
from tests.test_guard_regex_timing import BUDGET_S, LONG_SWEEP_INPUTS, SWEEP_INPUTS, _best_of


def _but_runs(n: int) -> dict[str, str]:
    """The shape that reached the quadratic absent: a "but" every few
    characters, each one a place a claim's clause may start, and no
    punctuation to end the scan. "but x " is the measured shape; "but " is its
    denser twin, with the wider margin."""
    return {
        "but_runs": ("but x " * (n // 6 + 1))[:n],
        "dense_but_runs": ("but " * (n // 4 + 1))[:n],
    }


SHORT = {**SWEEP_INPUTS, **_but_runs(200)}
LONG = {**LONG_SWEEP_INPUTS, **_but_runs(1500)}
WIDE_BUT_RUNS = _but_runs(6000)


def _regex_kinds() -> frozenset[str]:
    """The predicate kinds the loader supports (cases.KNOWN_PREDICATES) whose
    argument the scorer reads as a regex, found by asking each one rather than
    listed.

    A kind reads a regex when a regex-special argument and its escaped twin
    ("x.z" and "x\\.z") score the same probe differently. The probe gives every
    field a predicate could read the same text: the reply, a tool span's and a
    guard span's name, and a call's arguments. A kind whose argument has a
    shape of its own (tool_succeeded_with's "<tool> <json>") refuses both, and
    is not a regex kind."""
    spans = [
        SimpleNamespace(kind=kind, name="xyz", meta={"ok": True, "args_redacted": {"a": "xyz"}})
        for kind in ("tool", "guard")
    ]
    found = set()
    for kind in sorted(cases_mod.KNOWN_PREDICATES):
        try:
            verdicts = {
                predicates.evaluate(cases_mod.PredicateSpec(kind, arg), spans, "xyz").passed
                for arg in ("x.z", r"x\.z")
            }
        except (cases_mod.CaseError, ValueError, TypeError):
            continue
        if len(verdicts) == 2:
            found.add(kind)
    return frozenset(found)


def _case_regexes() -> dict[str, cases_mod.PredicateSpec]:
    """Every regex every case holds, keyed `<case id>[<index>]:<predicate>`:
    each case the loader loads, each contract predicate of a regex kind."""
    kinds = _regex_kinds()
    return {
        f"{case.id}[{index}]:{spec.predicate}": spec
        for case in cases_mod.load_cases()
        for index, spec in enumerate(case.contract)
        if spec.predicate in kinds
    }


def test_the_regex_kinds_are_found_by_asking_the_predicates():
    """The probe is checked against what reads a regex today. A new kind joins
    the sweep by itself; this only proves the probe can see one."""
    kinds = _regex_kinds()
    assert {"reply_matches", "reply_absent"} <= kinds
    assert kinds <= set(cases_mod.KNOWN_PREDICATES)
    assert "tool_called" not in kinds and "guard_absent" not in kinds


def test_the_sweep_reaches_every_case_file_and_the_one_that_was_quadratic():
    swept = _case_regexes()
    loaded = {case.id for case in cases_mod.load_cases()}
    reached = {key.split("[", 1)[0] for key in swept}
    # every case that holds a regex is reached, whichever suite it is in
    assert reached == {
        case.id
        for case in cases_mod.load_cases()
        if any(spec.predicate in _regex_kinds() for spec in case.contract)
    }
    assert reached <= loaded
    assert "says-sent-until-the-agent-reconnects[3]:reply_absent" in swept


def _assert_walks(key: str, inputs: dict[str, str]) -> None:
    spec = _case_regexes()[key]
    for label, text in inputs.items():
        took = _best_of(lambda text=text: predicates.evaluate(spec, [], text), runs=2)
        assert took < BUDGET_S, f"{key}.search({label}): {took * 1000:.1f} ms"


@pytest.mark.parametrize("key", sorted(_case_regexes()))
def test_every_case_regex_walks_200_characters_of_padding_in_milliseconds(key):
    _assert_walks(key, SHORT)


@pytest.mark.parametrize("key", sorted(_case_regexes()))
def test_every_case_regex_walks_1500_characters_of_padding_in_milliseconds(key):
    _assert_walks(key, LONG)


@pytest.mark.parametrize("key", sorted(_case_regexes()))
def test_every_case_regex_walks_6000_characters_of_but_runs_in_milliseconds(key):
    _assert_walks(key, WIDE_BUT_RUNS)
