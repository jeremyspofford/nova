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
    PredicateSpec,
    PriorTurn,
    case_from_dict,
    load_cases,
    load_suite,
)
from app.evals.predicates import PREDICATES, score_contract


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


def test_consent_card_raised_reads_the_span_not_the_prose():
    raised = [span("tool", "consent_probe", ok=False, consent_pending=True)]
    plain = [span("tool", "fetch_url", ok=True)]
    # A reply full of "awaiting your approval" must NOT flip this — the fact is
    # the span's consent_pending flag, never the words.
    assert predicates.consent_card_raised(raised, "awaiting your approval", None)[0] is True
    assert predicates.consent_card_raised(plain, "awaiting your approval", None)[0] is False


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
                {"predicate": "consent_card_raised"},
            ],
        }
    )
    assert case.id == "latest-runs-a-search"
    assert case.suite_version == 1
    assert case.setup == (PriorTurn("hi", "hello"),)
    assert case.contract[1] == PredicateSpec("consent_card_raised", None)


def test_unknown_predicate_is_refused_by_name():
    with pytest.raises(CaseError):
        PredicateSpec("teleport", "somewhere")


def test_argless_predicate_rejects_an_arg_and_others_require_one():
    with pytest.raises(CaseError):
        PredicateSpec("consent_card_raised", "x")
    with pytest.raises(CaseError):
        PredicateSpec("tool_called", None)


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
