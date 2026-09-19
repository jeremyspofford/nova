"""The mechanical evaluator and the case model — pure, no DB.

These pin the T1 scorer directly: a KNOWN-GOOD trace passes its contract and a
KNOWN-BAD one fails, with the trace built by hand (traces.Span objects) so the
verdict is deterministic and owes nothing to a model. The runner tests
(test_eval_runner.py) then prove the SAME predicates over a trace a REAL turn
left via a ScriptedGateway.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app import traces
from app.evals import predicates
from app.evals import runner as eval_runner
from app.evals.cases import (
    KNOWN_PREDICATES,
    CaseError,
    FixtureMachine,
    PredicateSpec,
    PriorTurn,
    case_from_dict,
    load_cases,
    load_suite,
    machine_from_dict,
    parse_tool_with,
)
from app.evals.predicates import PREDICATES, score_contract

ENGINE_VIEW_CONTRACT = (
    Path(__file__).resolve().parents[3] / "docs" / "contracts" / "engine_view.json"
)


def span(kind: str, name: str | None = None, **meta) -> traces.Span:
    return traces.Span(
        kind=kind, name=name, started_at=datetime.now(UTC), duration_ms=1, meta=dict(meta)
    )


# -- the registry and the case model are one contract ----------------------


def test_predicate_registry_matches_the_known_set():
    """A predicate named in a case but missing from the registry (or vice versa)
    would load and then never score. The module-level assert already fires on
    import; this states the invariant as a test too."""
    assert set(PREDICATES) == set(KNOWN_PREDICATES)


def test_eval_runs_table_is_queried_only_by_the_runner():
    """'eval_runs is read by no decision path' (audit-only, like the governance
    ledger), pinned mechanically. Matches actual SQL ACCESS to the table (a
    FROM/INTO/UPDATE/JOIN eval_runs, not the name in prose), so exactly ONE
    module under app/ touches it — evals/runner.py. A turn-path, policy or guard
    file that started querying it to gate a decision would show up here."""
    import re

    sql_access = re.compile(r"\b(?:from|into|update|join|table)\s+eval_runs\b", re.I)
    runner_path = Path(eval_runner.__file__).resolve()
    app_dir = runner_path.parent.parent  # .../app
    offenders = [
        str(py.relative_to(app_dir))
        for py in sorted(app_dir.rglob("*.py"))
        if py.resolve() != runner_path and sql_access.search(py.read_text(encoding="utf-8"))
    ]
    assert offenders == [], f"eval_runs must be queried only by evals/runner.py, found: {offenders}"


# -- each predicate, good and bad -----------------------------------------


def test_tool_called_and_not_called():
    spans = [span("tool", "web_search", ok=True), span("llm_call", "m")]
    assert predicates.tool_called(spans, "", "web_search")[0] is True
    assert predicates.tool_called(spans, "", "fetch_url")[0] is False
    assert predicates.tool_not_called(spans, "", "fetch_url")[0] is True
    assert predicates.tool_not_called(spans, "", "web_search")[0] is False


def test_tool_succeeded_requires_ok_true():
    ok_span = [span("tool", "fetch_url", ok=True)]
    fail_span = [span("tool", "fetch_url", ok=False, error="boom")]
    assert predicates.tool_succeeded(ok_span, "", "fetch_url")[0] is True
    # Called but failed: tool_called is true, tool_succeeded is false — the
    # distinction the trace makes and prose cannot.
    assert predicates.tool_called(fail_span, "", "fetch_url")[0] is True
    assert predicates.tool_succeeded(fail_span, "", "fetch_url")[0] is False


def test_guard_fired_and_absent():
    spans = [span("guard", "capability_claim"), span("tool", "fetch_url", ok=True)]
    assert predicates.guard_fired(spans, "", "capability_claim")[0] is True
    assert predicates.guard_absent(spans, "", "capability_claim")[0] is False
    assert predicates.guard_fired(spans, "", "consent_claim")[0] is False
    assert predicates.guard_absent(spans, "", "consent_claim")[0] is True


def test_guard_fired_scores_the_state_claim_guard():
    """The predicate registry is guard-NAME generic, so a new guard scores the
    day it files a span — no registry change. Pinned so the state-claim guard's
    span name and the eval vocabulary cannot drift apart silently."""
    spans = [span("guard", "state_claim", device="DELL-XPS-8950", redirected=False)]
    assert predicates.guard_fired(spans, "", "state_claim")[0] is True
    assert predicates.guard_absent(spans, "", "state_claim")[0] is False
    assert predicates.guard_fired([], "", "state_claim")[0] is False
    assert predicates.guard_absent([], "", "state_claim")[0] is True


def test_reply_matches_and_absent_are_case_insensitive():
    reply = "The Pixel camera is excellent."
    assert predicates.reply_matches([], reply, r"pixel camera")[0] is True
    assert predicates.reply_absent([], reply, r"I can't access")[0] is True
    assert predicates.reply_matches([], reply, r"openai")[0] is False
    assert predicates.reply_absent([], reply, r"pixel")[0] is False


# -- a whole contract: known-good passes, known-bad fails ------------------


def test_known_good_trace_passes_its_whole_contract():
    spans = [span("tool", "web_search", ok=True)]
    reply = "Here are the latest results on the Pixel camera."
    contract = (
        PredicateSpec("tool_called", "web_search"),
        PredicateSpec("tool_succeeded", "web_search"),
        PredicateSpec("reply_matches", r"latest"),
        PredicateSpec("reply_absent", r"I can't access"),
    )
    passed, results = score_contract(contract, spans, reply)
    assert passed is True
    assert [r.passed for r in results] == [True, True, True, True]


def test_known_bad_trace_fails_and_every_predicate_is_reported():
    # The model did NOT search and DID disown the capability — the exact walk
    # failure. Two predicates fail; both are still evaluated (no short-circuit),
    # so the detail explains the whole failure.
    spans = [span("guard", "capability_claim")]
    reply = "I can't access external websites."
    contract = (
        PredicateSpec("tool_called", "web_search"),  # fails: never searched
        PredicateSpec("reply_absent", r"I can't access"),  # fails: the denial
        PredicateSpec("guard_fired", "capability_claim"),  # passes: guard caught it
    )
    passed, results = score_contract(contract, spans, reply)
    assert passed is False
    assert [r.passed for r in results] == [False, False, True]
    assert all(isinstance(r.detail, str) and r.detail for r in results)


# -- the case model / fixture loader ---------------------------------------


def test_case_from_dict_parses_a_valid_fixture():
    case = case_from_dict(
        {
            "id": "latest-runs-a-search",
            "suite": "corpus",
            "suite_version": 1,
            "setup": [{"user": "hi", "assistant": "hello"}],
            "message": "what's the latest?",
            "contract": [
                {"predicate": "tool_called", "arg": "web_search"},
                {"predicate": "guard_absent", "arg": "deferral"},
            ],
        }
    )
    assert case.id == "latest-runs-a-search"
    assert case.suite_version == 1
    assert case.setup == (PriorTurn("hi", "hello"),)
    assert case.contract[1] == PredicateSpec("guard_absent", "deferral")


def test_unknown_predicate_is_refused_by_name():
    with pytest.raises(CaseError):
        PredicateSpec("teleport", "somewhere")


def test_every_predicate_requires_a_non_empty_arg():
    """There is no argless predicate: the one there was (consent_card_raised)
    read an approval state v4 no longer has. A spec with no arg — or an empty
    one — is refused by name at load time, never scored as vacuously true."""
    with pytest.raises(CaseError):
        PredicateSpec("tool_called", None)
    with pytest.raises(CaseError):
        PredicateSpec("guard_absent", "")


def test_a_case_needs_at_least_one_predicate():
    with pytest.raises(CaseError):
        case_from_dict(
            {"id": "x", "suite": "s", "suite_version": 1, "message": "m", "contract": []}
        )


def test_load_cases_reads_git_fixtures(tmp_path):
    (tmp_path / "one.json").write_text(
        json.dumps(
            {
                "id": "one",
                "suite": "corpus",
                "suite_version": 1,
                "message": "hi",
                "contract": [{"predicate": "reply_matches", "arg": "hi"}],
            }
        )
    )
    cases = load_cases(tmp_path)
    assert [c.id for c in cases] == ["one"]


def test_a_malformed_fixture_names_itself(tmp_path):
    (tmp_path / "bad.json").write_text('{"id": "x"}')  # missing everything else
    with pytest.raises(CaseError) as exc:
        load_cases(tmp_path)
    assert "bad.json" in str(exc.value)


def test_missing_cases_dir_is_an_empty_corpus_not_an_error(tmp_path):
    assert load_cases(tmp_path / "nope") == []


def test_load_suite_refuses_to_mix_versions(tmp_path):
    for i, ver in enumerate((1, 2)):
        (tmp_path / f"{i}.json").write_text(
            json.dumps(
                {
                    "id": f"c{i}",
                    "suite": "corpus",
                    "suite_version": ver,
                    "message": "m",
                    "contract": [{"predicate": "reply_matches", "arg": "m"}],
                }
            )
        )
    with pytest.raises(CaseError) as exc:
        load_suite("corpus", tmp_path)
    assert "comparable" in str(exc.value)


# -- S40: the direction of a write, and the declared machines -------------


def test_tool_succeeded_with_reads_the_arguments_of_a_successful_span():
    """tool_succeeded cannot tell "switched it off" from "switched it on" --
    both are an ok machine_configure span. A case about the DIRECTION of a
    write needs the arguments: a subset match, type-exact (False is not 0),
    over successful spans only."""
    arg = 'machine_configure {"machine": "eval_box", "serving": false}'
    off = span(
        "tool",
        "machine_configure",
        ok=True,
        args_redacted={"machine": "eval_box", "serving": False},
    )
    on = span(
        "tool", "machine_configure", ok=True, args_redacted={"machine": "eval_box", "serving": True}
    )
    failed = span(
        "tool",
        "machine_configure",
        ok=False,
        args_redacted={"machine": "eval_box", "serving": False},
    )
    zero = span(
        "tool", "machine_configure", ok=True, args_redacted={"machine": "eval_box", "serving": 0}
    )
    clipped = span("tool", "machine_configure", ok=True, args_redacted='{"machine": "eval_bo')
    assert predicates.tool_succeeded_with([off], "", arg)[0] is True
    assert predicates.tool_succeeded_with([on], "", arg)[0] is False
    assert predicates.tool_succeeded_with([failed], "", arg)[0] is False
    assert predicates.tool_succeeded_with([zero], "", arg)[0] is False
    assert predicates.tool_succeeded_with([clipped], "", arg)[0] is False
    assert predicates.tool_succeeded_with([on, off], "", arg)[0] is True


# -- S40b: a call the backend made is not hers ------------------------------


def test_an_unasked_span_is_not_counted_as_her_call():
    """live_facts runs a check a recalled note named, before she is asked
    anything, and marks its span `unasked` (live_facts._run_one). Such a span
    is a real tool span -- the guards must read it as a real read -- but it is
    not a call SHE chose to make, and the tool predicates measure her: a
    note-triggered machine_status must never turn tool_called('machine_status')
    green by construction (S40b verdict §5). Every tool predicate reads the
    same filtered set, so none of them can drift apart."""
    arg = 'machine_configure {"machine": "eval_box", "serving": false}'
    unasked_status = span("tool", "machine_status", ok=True, unasked=True)
    unasked_configure = span(
        "tool",
        "machine_configure",
        ok=True,
        unasked=True,
        args_redacted={"machine": "eval_box", "serving": False},
    )
    unasked_only = [unasked_status, unasked_configure]
    assert predicates.tool_called(unasked_only, "", "machine_status")[0] is False
    assert predicates.tool_succeeded(unasked_only, "", "machine_status")[0] is False
    assert predicates.tool_not_called(unasked_only, "", "machine_status")[0] is True
    assert predicates.tool_succeeded_with(unasked_only, "", arg)[0] is False
    # The detail counts her spans only, so it cannot say "1 span" for a case
    # that scored "not called".
    assert predicates.tool_called(unasked_only, "", "machine_status")[1] == (
        "tool 'machine_status' has 0 span(s) this turn"
    )

    # Her own call beside the backend's is counted, once.
    hers = span("tool", "machine_status", ok=True)
    both = [unasked_status, hers]
    assert predicates.tool_called(both, "", "machine_status") == (
        True,
        "tool 'machine_status' has 1 span(s) this turn",
    )
    assert predicates.tool_succeeded(both, "", "machine_status")[0] is True
    assert predicates.tool_not_called(both, "", "machine_status")[0] is False

    # Only `unasked: True` excludes: a span that carries the key with any
    # other value (or not at all) is hers, as chat._run_tool writes them.
    for meta in ({"unasked": False}, {"unasked": "true"}, {}):
        own = span("tool", "machine_status", ok=True, **meta)
        assert predicates.tool_called([own], "", "machine_status")[0] is True


def test_tool_succeeded_with_refuses_a_malformed_arg_at_load():
    """A typo in the one two-part argument must fail at LOAD, never score as
    a predicate that silently never matches."""
    for bad in (
        "machine_configure",
        'machine_configure {"serving": fals}',
        "machine_configure []",
        "machine_configure {}",
    ):
        with pytest.raises(CaseError):
            PredicateSpec("tool_succeeded_with", bad)
    assert parse_tool_with('machine_configure {"serving": false}') == (
        "machine_configure",
        {"serving": False},
    )


def test_a_declared_machine_name_must_carry_the_reserved_prefix():
    """The same rule as agents and skills, for the same reason: the harness
    answers for these names instead of the real plant, so a declared name
    must be one no real machine can hold."""
    with pytest.raises(CaseError, match="must start with 'eval_'"):
        FixtureMachine(name="hub")
    with pytest.raises(CaseError, match="must start with 'eval_'"):
        machine_from_dict({"name": "dell"})
    with pytest.raises(CaseError, match="serving"):
        machine_from_dict({"name": "eval_box", "serving": "no"})
    with pytest.raises(CaseError, match="tags"):
        machine_from_dict({"name": "eval_box", "tags": {"qwen3:8b": "5 GB"}})
    parsed = machine_from_dict({"name": "eval_box"})
    assert parsed == FixtureMachine(name="eval_box")


def test_a_declared_machine_is_the_gateways_row_shape_with_state_derived():
    row = FixtureMachine(name="eval_box", tags={"qwen3:8b": 5_225_388_164}).as_row()
    # Moved (S40 fix wave A1/B9): the literal field list became the contract
    # file itself, which gained `builtin` and `answered` — one list to move,
    # held from both sides (gateway test_engines, core test_machines).
    assert set(row) == set(json.loads(ENGINE_VIEW_CONTRACT.read_text())["fields"])
    assert (row["builtin"], row["answered"]) == (False, True)
    assert (row["serving"], row["state"]) == (True, "ready")
    assert FixtureMachine(name="eval_box", serving=False).as_row()["state"] == "switched_off"
    # Fresh on every call: a replay never inherits the last replay's write.
    machine = FixtureMachine(name="eval_box")
    assert machine.as_row() is not machine.as_row()
    assert machine.as_row()["tags"] is not machine.as_row()["tags"]


def test_case_from_dict_reads_declared_machines():
    case = case_from_dict(
        {
            "id": "m",
            "suite": "s",
            "suite_version": 1,
            "message": "x",
            "machines": [{"name": "eval_box", "serving": True, "runtime": "native"}],
            "contract": [{"predicate": "tool_called", "arg": "machine_status"}],
        }
    )
    assert case.machines == (FixtureMachine(name="eval_box", runtime="native"),)
    assert case.as_json()["machines"][0]["name"] == "eval_box"
    with pytest.raises(CaseError, match="machines must be a list"):
        case_from_dict(
            {
                "id": "m",
                "suite": "s",
                "suite_version": 1,
                "message": "x",
                "machines": {"name": "eval_box"},
                "contract": [{"predicate": "tool_called", "arg": "x"}],
            }
        )


def test_a_declared_machine_refuses_what_it_cannot_replay():
    """Two load-time refusals the parser owes its cases. A key the declaration
    does not take ("servng", or a `state` the gateway derives) would otherwise
    be dropped silently and the case replayed against a machine it did not
    describe; and two declarations of one name would collapse into whichever
    the plant read last."""
    with pytest.raises(CaseError, match="servng"):
        machine_from_dict({"name": "eval_box", "servng": False})
    with pytest.raises(CaseError, match="state"):
        machine_from_dict({"name": "eval_box", "state": "unreachable"})
    with pytest.raises(CaseError, match="eval_box.*more than once"):
        case_from_dict(
            {
                "id": "m",
                "suite": "s",
                "suite_version": 1,
                "message": "x",
                "machines": [{"name": "eval_box"}, {"name": "eval_box", "serving": False}],
                "contract": [{"predicate": "tool_called", "arg": "machine_status"}],
            }
        )
