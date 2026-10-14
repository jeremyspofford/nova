"""S32.3 T13 — her landing tools registered, and every claim about a landing held
to its row.

Criteria (tracker .epics/s32-3.md, T13):
  C1 the six tools are registered — each REGISTRY entry IS the module's Tool
     object; `from app import tools` imports in a fresh interpreter. (The name,
     reads_only and writer pins move in test_tools_registry.)
  C2 classified: capability coverage (test_capability_coverage) and live_facts
     — landing_status AUTO_RUN, repo_diff + stack_status NOT_AUTO_RUN, the three
     writes refused unasked.
  C3 a completed `landed` claim with no landing fact this turn is corrected;
     hedged / negated / conditional / question / recap / someone else's
     subject / other merges / main.py never claim.
  C4 backed only by a landing fact this turn with verdict green AND a merged
     SHA; the correction says what this turn's record shows.
  C5 tests_passed: a green landing backs it; a red one as the deciding record
     is named in the correction; the later of a run and a landing decides.
  C6 edited_file: a `commit` fact's files back an edit claim by name or path.

Spans are built the way chat records them: a tool span's meta carries `ok`,
`args_redacted` and the `facts` the executor filed (tools/landing.landing_fact,
tools/changes.change_commit's commit fact).
"""

from __future__ import annotations

import subprocess
import sys
from types import SimpleNamespace

import pytest

from app import guards, live_facts, tools
from app.tools import changes, landing

LANDING_ID = "5b0c7a43-1f0e-4c39-9a51-7a4f8f0d2c11"
OTHER_ID = "0e9d1c2b-3a4f-4b5c-8d6e-7f8091a2b3c4"
MERGED = "4f1c2a9e8b7d6c5b4a3928170f6e5d4c3b2a1908"
WORKTREE = "/home/j/nova/.worktrees/nova-3f2a1b"


def _landing_fact(verdict: str, merged_sha=None, *, landing_id=LANDING_ID, suites=None):
    return {
        "landing": {
            "id": landing_id,
            "change": "3f2a1b",
            "verdict": verdict,
            "merged_sha": merged_sha,
            "suites": suites
            if suites is not None
            else [{"suite": "core", "exit": 0, "outcome": "passed"}],
        }
    }


def _span(name: str, facts: list, *, ok: bool = True, args: dict | None = None):
    return SimpleNamespace(
        kind="tool",
        name=name,
        meta={"ok": ok, "args_redacted": args or {}, "facts": facts},
    )


def _status(*facts, ok: bool = True):
    return _span("landing_status", list(facts), ok=ok, args={"id": LANDING_ID})


def _run(argv: list[str], exit_code: int):
    return _span(
        "device_run",
        [
            {
                "run": {"exit_code": exit_code, "device": "mini-pc", "argv": argv, "cwd": None},
                "target": " ".join(argv),
            }
        ],
        args={"device": "mini-pc", "argv": argv},
    )


def _commit(files: list[str], worktree: str = WORKTREE):
    return _span(
        "change_commit",
        [
            {
                "commit": {"device": "mini-pc", "change": "3f2a1b", "sha": MERGED, "files": files},
                "target": worktree,
            }
        ],
        args={"change": "3f2a1b", "message": "x"},
    )


def _kinds(correction) -> list[str]:
    return [] if correction is None else [claim.kind for claim in correction.claims]


GREEN_MERGED = _landing_fact("green", MERGED)
PYTEST = ["uv", "run", "pytest", "-q"]


# -- C1 the six tools are registered ---------------------------------------------

SIX = {
    "change_commit": changes.CHANGE_COMMIT_TOOL,
    "repo_land": landing.REPO_LAND_TOOL,
    "landing_status": landing.LANDING_STATUS_TOOL,
    "repo_diff": landing.REPO_DIFF_TOOL,
    "close_change": landing.CLOSE_CHANGE_TOOL,
    "stack_status": landing.STACK_STATUS_TOOL,
}


@pytest.mark.parametrize("name", sorted(SIX))
def test_c1_each_tool_is_registered_as_its_modules_own_object(name):
    assert tools.REGISTRY.get(name) is SIX[name]
    assert SIX[name].name == name


@pytest.mark.parametrize("name", sorted(SIX))
def test_c1_each_tool_is_advertised_with_its_own_schema(name):
    advertised = {t["function"]["name"]: t["function"] for t in tools.advertised_tools()}
    assert advertised[name]["parameters"] is SIX[name].parameters
    assert advertised[name]["description"] == SIX[name].description


def test_c1_the_registry_imports_in_a_fresh_interpreter():
    proc = subprocess.run(
        [
            sys.executable,
            "-c",
            "from app import tools; print(' '.join(sorted(n for n in tools.REGISTRY "
            "if n in {'change_commit','repo_land','landing_status','repo_diff',"
            "'close_change','stack_status'})))",
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.split() == sorted(SIX)


# -- C2 live_facts classification -------------------------------------------------


def test_c2_landing_status_is_a_check_the_backend_may_run():
    assert "landing_status" in live_facts.AUTO_RUN
    assert "landing_status" not in live_facts.NOT_AUTO_RUN
    assert live_facts.may_run_unasked("landing_status") is None


@pytest.mark.parametrize("name", ["repo_diff", "stack_status"])
def test_c2_the_repo_machine_reads_are_excluded_with_a_reason(name):
    assert name not in live_facts.AUTO_RUN
    reason = live_facts.NOT_AUTO_RUN.get(name, "")
    assert reason.strip(), f"{name} is not excluded with a reason"
    assert live_facts.may_run_unasked(name) == reason


@pytest.mark.parametrize(
    ("name", "args"),
    [
        ("change_commit", {"change": "3f2a1b", "message": "x"}),
        ("repo_land", {"change": "3f2a1b"}),
        ("close_change", {"change": "3f2a1b"}),
    ],
)
def test_c2_the_writes_are_never_run_unasked(name, args):
    assert name not in live_facts.AUTO_RUN
    assert name not in live_facts.NOT_AUTO_RUN
    refusal = live_facts.runnable(live_facts.LiveCall(tool=name, args=args, note="n"))
    assert refusal and "changes something" in refusal


# -- C3 a landed claim with no landing read is corrected -------------------------

LANDED_CLAIMS = [
    "I merged it.",
    "I landed the change.",
    "I've landed change 3f2a1b.",
    "We merged the get_time fix.",
    "The change landed.",
    "It's merged.",
    "It’s merged now.",
    "It's on main.",
    "The fix is now on main.",
    "My change has been merged into main.",
    "It was pushed to main.",
    "Pushed to main.",
    "Change 3f2a1b is merged.",
    "The PR got merged.",
    "Done — the branch was merged and the deploy followed.",
    "It has landed on main.",
]


@pytest.mark.parametrize("reply", LANDED_CLAIMS)
def test_c3_a_landed_claim_with_no_landing_read_is_corrected(reply):
    correction = guards.narration_check(reply, [])
    assert "landed" in _kinds(correction), reply


NOT_CLAIMS = [
    "I'll land it once the tests pass.",
    "It will be merged when the landing is green.",
    "It isn't merged yet.",
    "It is not on main.",
    "Nothing is on main yet.",
    "Once it's merged, the deploy follows.",
    "If it lands, the deploy checkout follows.",
    "Should I merge it?",
    "Is it on main?",
    "It landed yesterday.",
    "The change was merged earlier.",
    "Your PR was merged.",
    "Your fix is on main.",
    "I merged the two notes into one.",
    "I merged the lists.",
    "The change is in main.py.",
    "Jeremy said it's merged.",
    "It probably landed.",
    "It might be on main.",
    "The landing is running; it lands only if green.",
    "I'm on main.",
]


@pytest.mark.parametrize("reply", NOT_CLAIMS)
def test_c3_hedges_negations_conditions_and_other_subjects_never_claim(reply):
    assert "landed" not in _kinds(guards.narration_check(reply, [])), reply


def test_c3_the_claim_carries_its_phrase():
    correction = guards.narration_check("Good news: it's merged.", [])
    claim = next(c for c in correction.claims if c.kind == "landed")
    assert "merged" in claim.phrase.lower()
    assert claim.target is None


# -- C4 backed only by a green landing with a merged SHA ---------------------------


@pytest.mark.parametrize("reply", LANDED_CLAIMS)
def test_c4_a_green_merged_landing_read_this_turn_backs_it(reply):
    assert "landed" not in _kinds(guards.narration_check(reply, [_status(GREEN_MERGED)])), reply


def test_c4_repo_lands_own_fact_backs_nothing_while_running():
    span = _span("repo_land", [_landing_fact("running", suites=[])], args={"change": "3f2a1b"})
    assert "landed" in _kinds(guards.narration_check("It's merged.", [span]))


@pytest.mark.parametrize(
    ("fact", "state"),
    [
        (_landing_fact("running", suites=[]), "running"),
        (_landing_fact("red"), "red"),
        (_landing_fact("could_not_measure"), "could_not_measure"),
        (_landing_fact("conflict", suites=[]), "conflict"),
        (_landing_fact("green", None), "green, with no merged SHA"),
        (_landing_fact("green", ""), "green, with no merged SHA"),
    ],
    ids=["running", "red", "could_not_measure", "conflict", "green-unmerged", "green-blank"],
)
def test_c4_any_other_landing_leaves_it_corrected_naming_what_it_reads(fact, state):
    correction = guards.narration_check("It's merged.", [_status(fact)])
    assert _kinds(correction) == ["landed"]
    assert correction.text == guards.LANDED_NOT_MERGED_TEXT.format(id=LANDING_ID, state=state)
    assert LANDING_ID in correction.text and state in correction.text


@pytest.mark.parametrize("verdict", ["running", "red", "could_not_measure", "conflict"])
def test_c4_a_merged_sha_on_a_landing_not_green_backs_nothing(verdict):
    # The table refuses such a row (050's CHECK); the guard does not lean on it.
    fact = _landing_fact(verdict, MERGED)
    assert _kinds(guards.narration_check("It's merged.", [_status(fact)])) == ["landed"]


def test_c4_no_landing_read_says_so():
    correction = guards.narration_check("It's on main.", [_run(["git", "status"], 0)])
    assert _kinds(correction) == ["landed"]
    assert correction.text == guards.LANDED_NO_LANDING_TEXT


def test_c4_the_last_landing_read_is_the_one_named():
    spans = [
        _status(_landing_fact("red", landing_id=OTHER_ID)),
        _status(_landing_fact("running", suites=[])),
    ]
    correction = guards.narration_check("It's merged.", spans)
    assert correction.text == guards.LANDED_NOT_MERGED_TEXT.format(id=LANDING_ID, state="running")


def test_c4_any_green_merged_landing_among_several_backs_it():
    listing = _span(
        "landing_status",
        [GREEN_MERGED, _landing_fact("red", landing_id=OTHER_ID)],
        args={},
    )
    assert guards.narration_check("It's merged.", [listing]) is None


def test_c4_the_correction_never_says_more_than_this_turn():
    assert "this turn" in guards.LANDED_NO_LANDING_TEXT
    assert guards.LANDED_NO_LANDING_TEXT.startswith("Correction: ")
    assert guards.LANDED_NOT_MERGED_TEXT.startswith("Correction: ")


def test_c4_beside_an_unbacked_tests_claim_each_says_its_own_record():
    correction = guards.narration_check("All 40 tests passed. It's merged.", [])
    assert sorted(_kinds(correction)) == ["landed", "tests_passed"]
    assert correction.text.startswith(guards.TESTS_NO_RUNNER_TEXT)
    assert guards.LANDED_NO_LANDING_TEXT.removeprefix("Correction: ") in correction.text
    assert guards.CORRECTION_TEXT not in correction.text


def test_c4_beside_another_kind_the_generic_correction_stands():
    correction = guards.narration_check("I wrote notes.md. It's merged.", [])
    assert sorted(_kinds(correction)) == ["landed", "wrote_file"]
    assert correction.text == guards.CORRECTION_TEXT


# -- C5 tests_passed reads the landing ---------------------------------------------


def test_c5_a_green_landing_backs_tests_passed_with_no_run():
    assert guards.narration_check("All tests passed.", [_status(_landing_fact("green"))]) is None


def test_c5_a_red_landing_deciding_is_named_in_the_correction():
    red = _landing_fact(
        "red",
        suites=[
            {"suite": "ruff", "exit": 0, "outcome": "passed"},
            {"suite": "core", "exit": 1, "outcome": "failed"},
        ],
    )
    correction = guards.narration_check("All tests passed.", [_status(red)])
    assert _kinds(correction) == ["tests_passed"]
    assert correction.text == guards.TESTS_LANDING_TEXT.format(
        id=LANDING_ID, verdict="red", suite=": `core` exited 1"
    )
    assert LANDING_ID in correction.text and "`core` exited 1" in correction.text


def test_c5_a_red_landing_with_no_failing_suite_on_record_names_only_the_landing():
    correction = guards.narration_check(
        "All tests passed.", [_status(_landing_fact("red", suites=[]))]
    )
    assert correction.text == guards.TESTS_LANDING_TEXT.format(
        id=LANDING_ID, verdict="red", suite=""
    )


def test_c5_a_later_passing_run_outranks_an_earlier_red_landing():
    spans = [_status(_landing_fact("red")), _run(PYTEST, 0)]
    assert guards.narration_check("All tests passed.", spans) is None


def test_c5_a_later_red_landing_outranks_an_earlier_passing_run():
    spans = [_run(PYTEST, 0), _status(_landing_fact("red"))]
    assert _kinds(guards.narration_check("All tests passed.", spans)) == ["tests_passed"]


def test_c5_a_later_green_landing_outranks_an_earlier_failing_run():
    spans = [_run(PYTEST, 1), _status(_landing_fact("green"))]
    assert guards.narration_check("All tests passed.", spans) is None


@pytest.mark.parametrize("verdict", ["running", "could_not_measure", "conflict"])
def test_c5_a_landing_with_no_test_verdict_decides_nothing(verdict):
    correction = guards.narration_check("All tests passed.", [_status(_landing_fact(verdict))])
    assert correction.text == guards.TESTS_NO_RUNNER_TEXT
    # …and it does not hide the run that decides.
    spans = [_run(PYTEST, 1), _status(_landing_fact(verdict))]
    assert "exited 1" in guards.narration_check("All tests passed.", spans).text


def test_c5_a_listing_with_a_green_landing_backs_it():
    listing = _span(
        "landing_status",
        [_landing_fact("red", landing_id=OTHER_ID), _landing_fact("green")],
        args={},
    )
    assert guards.narration_check("All tests passed.", [listing]) is None


def test_c5_a_listing_of_red_landings_names_its_first_newest_first():
    listing = _span(
        "landing_status",
        [_landing_fact("red"), _landing_fact("red", landing_id=OTHER_ID)],
        args={},
    )
    correction = guards.narration_check("All tests passed.", [listing])
    assert LANDING_ID in correction.text and OTHER_ID not in correction.text


def test_c5_a_reply_acknowledging_the_red_landing_stands():
    reply = "All tests passed except core, which failed."
    assert guards.narration_check(reply, [_status(_landing_fact("red"))]) is None


# -- C6 a commit backs an edit -----------------------------------------------------


@pytest.mark.parametrize(
    "reply",
    [
        "I edited util.py.",
        "I modified services/core/app/tools/util.py.",
        f"I changed {WORKTREE}/services/core/app/tools/util.py.",
    ],
)
def test_c6_a_commits_files_back_an_edit_claim(reply):
    span = _commit(["services/core/app/tools/util.py", "services/core/tests/test_util.py"])
    assert guards.narration_check(reply, [span]) is None, reply


@pytest.mark.parametrize(
    "reply",
    [
        "I edited chat.py.",
        "I modified services/gateway/app/tools/util.py.",
        "I changed /home/j/nova/.worktrees/nova-999999/services/core/app/tools/util.py.",
    ],
)
def test_c6_a_commit_of_other_files_backs_nothing(reply):
    span = _commit(["services/core/app/tools/util.py"])
    assert _kinds(guards.narration_check(reply, [span])) == ["edited_file"], reply


def test_c6_a_commit_fact_with_no_files_backs_nothing():
    assert _kinds(guards.narration_check("I edited util.py.", [_commit([])])) == ["edited_file"]
