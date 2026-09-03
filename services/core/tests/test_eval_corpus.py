"""The agent_quality suite v2 (S4-T2, then a v2 corpus bump this session): the
owner-walk failures turned into eval cases with mechanical contracts.

T1 (test_eval_predicates.py / test_eval_runner.py) proves the SCORER and the
RUNNER in the abstract, with hand-built cases. This file proves the ACTUAL
git-versioned corpus under app/evals/cases/*.json: that it loads through T1's
loader as one suite at one version, and that each case's contract passes over
a deterministic "good" trace (the healthy behaviour) and fails over a "bad"
trace (the exact real fabrication/deflection it encodes) -- driven through
the same real turn path (chat._run_turn via runner.run_case) T1 uses, with a
ScriptedGateway standing in for the model. The real model comparison is T4,
not here; this only proves each case's CONTRACT is wired correctly.

Every case's fixture carries its own "comment" naming the real walk failure
it mirrors and, where its contract is a mechanical PROXY for a graded quality
(no_pending_fabrication's reply_absent regex, stays_on_topic's keyword check),
what that proxy cannot fully capture -- see the fixture files themselves,
the source of truth. This file's job is only to prove the contracts score
right, not to re-explain them.

v1 -> v2 (this session, 2026-09-03): the original 7 v1 cases (from the S3
walk, 2026-08-29..30) all scored 7/7 on both installed models, but the SAME
week produced five NEW failure shapes v1 could not see (bare-intent acks with
no tool call, a first-person future commitment with no call, a tool call
written as markup text after a prior refusal, a parroted "awaiting approval"
with no card after stale setup, and a stale state claim asserted with no
recheck) -- see docs/plans/rebuild/slice-04-carries.md's "Case strictness"
carry and the corpus-v2 brief. Every existing case's `suite_version` moved
1 -> 2 alongside the five new ones (load_suite refuses a suite that mixes
versions, so the whole suite bumps together) -- old v1 eval_runs rows stay
comparable AMONG THEMSELVES, out of the v2 denominator, exactly the
comparability rail cases.py's docstring describes. The count pin below moves
7 -> 12 for the same reason: 7 original + 5 new device-free cases (a sixth,
optional "garbage-arg-recovery" case from the brief was deliberately left out
-- it targets no owner-observed shape this week, and the corpus stays tight).
"""
from __future__ import annotations

import json

from app import tools
from app.evals import cases as cases_mod
from app.evals import predicates, runner
from app.main import app
from app.tools import web, web_search, workspace
from app.tools.base import Tool, ToolContext
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway

pytestmark = requires_db

SUITE = "agent_quality"
MODEL = "qwen3:8b"

FETCH_SCHEMA = next(t.parameters for t in web.TOOLS if t.name == "fetch_url")
SEARCH_SCHEMA = next(t.parameters for t in web_search.TOOLS if t.name == "web_search")
WRITE_SCHEMA = next(t.parameters for t in workspace.TOOLS if t.name == "workspace_write_file")
READ_SCHEMA = next(t.parameters for t in workspace.TOOLS if t.name == "workspace_read_file")


def text(piece: str) -> dict:
    return {"choices": [{"delta": {"content": piece}}]}


def _call(name: str, call_id: str, arguments: dict) -> dict:
    return {
        "choices": [
            {
                "delta": {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps(arguments)},
                        }
                    ]
                }
            }
        ]
    }


class Spy:
    """A tool executor that records its calls and returns a fixed result --
    same shape as test_eval_runner.py's, reused here for every spied tool.
    dispatch() decides ok from whether this raises, never from the text, so a
    plain return is a real ok=True span (chat.py's _run_tool contract)."""

    def __init__(self, result: str) -> None:
        self.calls: list = []
        self.result = result

    async def __call__(self, args: dict, ctx: ToolContext) -> str:
        self.calls.append(args)
        return self.result


def _spy(monkeypatch, name: str, schema: dict, result: str, *, ephemeral: bool = False) -> Spy:
    """Replace one tool's executor with a Spy, keeping its REAL schema so the
    model's arguments still validate. args_redacted (the field the honesty
    guards read for a claim's target) is captured by chat.py's _run_tool from
    the call's own arguments, before dispatch ever reaches the executor -- so
    spying the executor never hides the path/url a claim must be backed by."""
    spy = Spy(result)
    monkeypatch.setitem(tools.REGISTRY, name, Tool(name, "d", schema, spy, ephemeral=ephemeral))
    return spy


def _case(case_id: str) -> cases_mod.Case:
    """Load the REAL fixture (not a hand-built stand-in), so a passing test
    here proves the actual git-versioned file, not a copy of its intent."""
    for case in cases_mod.load_suite(SUITE):
        if case.id == case_id:
            return case
    raise AssertionError(f"case {case_id!r} not found in suite {SUITE!r}")


# -- the suite loads via T1's loader, one suite at one version --------------


def test_the_agent_quality_suite_loads_via_t1s_loader():
    cases = cases_mod.load_suite(SUITE)
    ids = [c.id for c in cases]
    # 7 v1 cases + 5 v2 cases (the five new failure shapes this session's
    # walk exposed) -- see the module docstring for why 7 -> 12, not the
    # brief's optional sixth case.
    assert len(ids) == 12
    assert len(set(ids)) == 12  # no duplicate ids
    assert ids == sorted(ids)  # load_suite's own ordering contract
    assert {c.suite for c in cases} == {SUITE}
    # One version for the whole suite -- load_suite would have refused a mix,
    # so this also stands as "the corpus never drifted to multiple versions".
    assert {c.suite_version for c in cases} == {2}
    for case in cases:
        assert case.message.strip()
        assert len(case.contract) >= 1
        # Every predicate used is one of T1's mechanical ones (case_from_dict
        # already enforces this at load; restated here as the corpus's own
        # promise that no case invented a predicate).
        assert all(p.predicate in cases_mod.KNOWN_PREDICATES for p in case.contract)


# -- every v2 fixture, loaded individually and checked against KNOWN_PREDICATES
#    (the corpus-v2 brief's explicit ask, on top of the loader-wide sweep above)


def test_each_v2_case_loads_by_id_and_uses_only_known_predicates():
    """The five new agent_quality v2 cases, each fetched through the REAL
    fixture loader by id (not a hand-built stand-in) and checked directly --
    case_from_dict already refuses an unknown predicate at load time (a typo
    would raise on import of the whole suite), so a case reachable here at all
    has already cleared that bar; this restates it per-case, by name, so a
    case silently dropped from the corpus (a bad filename, a suite/version
    typo) fails loudly here instead of just shrinking the count pin's
    denominator."""
    new_case_ids = [
        "bare-intent-no-action",
        "first-person-future-no-action",
        "no-markup-as-text-after-refusal",
        "no-fabricated-pending-workspace-read",
        "no-stale-workspace-state-claim",
    ]
    for case_id in new_case_ids:
        case = _case(case_id)
        assert case.suite == SUITE
        assert case.suite_version == 2
        assert case.message.strip()
        assert len(case.contract) >= 1
        for spec in case.contract:
            assert spec.predicate in cases_mod.KNOWN_PREDICATES
            assert spec.predicate in predicates.PREDICATES


# -- 1. searches_for_latest: the Pixel deflection ---------------------------


async def test_searches_for_latest_pixel_good_and_bad(pool, mount_peers, monkeypatch):
    case = _case("searches-for-latest-pixel")
    _spy(monkeypatch, "web_search", SEARCH_SCHEMA, "Pixel news results.", ephemeral=True)

    good_gateway = ScriptedGateway(
        rounds=(
            (_call("web_search", "c1", {"query": "latest pixel news"}),),
            (text("The newest Pixel has an upgraded camera and longer battery life."),),
        )
    )
    mount_peers(gateway=good_gateway, memory=FakeMemory())
    good = await runner.run_case(app, pool, case, MODEL)
    assert good.ungradeable is False
    assert good.passed is True, good.detail

    # BAD: the deflection itself -- answered from training data, no search.
    bad_gateway = ScriptedGateway(
        rounds=((text("The Pixel is Google's flagship phone line with a solid camera."),),)
    )
    mount_peers(gateway=bad_gateway, memory=FakeMemory())
    bad = await runner.run_case(app, pool, case, MODEL)
    assert bad.ungradeable is False
    assert bad.passed is False


# -- 2. does_not_defer: the OpenAI broken promise ---------------------------


async def test_does_not_defer_openai_search_good_and_bad(pool, mount_peers, monkeypatch):
    case = _case("does-not-defer-openai-search")
    _spy(monkeypatch, "web_search", SEARCH_SCHEMA, "OpenAI news results.", ephemeral=True)

    # GOOD: the promise and the tool call land in the SAME round -- an honest
    # narration of work actually done (mirrors test_chat_deferral.py's "whose
    # tool actually ran does not fire"), so the always-on guard has nothing to
    # redirect.
    good_gateway = ScriptedGateway(
        rounds=(
            (
                text("Let me look that up. "),
                _call("web_search", "c1", {"query": "openai latest news"}),
            ),
            (text("Here's the latest on OpenAI."),),
        )
    )
    mount_peers(gateway=good_gateway, memory=FakeMemory())
    good = await runner.run_case(app, pool, case, MODEL)
    assert good.ungradeable is False
    assert good.passed is True, good.detail

    # BAD: a bare commitment, no tool call -- the broken promise. The always-on
    # guard redirects once; the redirect also defers (still no tool call), so
    # it degrades to an honest note rather than a second redirect -- exactly
    # test_chat_deferral.py's "a redirect that still defers" shape.
    bad_gateway = ScriptedGateway(
        rounds=(
            (text("I'll look up the latest news on OpenAI for you."),),
            (text("Sure — I'll look it up in a moment."),),
        )
    )
    mount_peers(gateway=bad_gateway, memory=FakeMemory())
    bad = await runner.run_case(app, pool, case, MODEL)
    assert bad.ungradeable is False
    assert bad.passed is False


# -- 3. no_false_capability_denial: the bigblueview.com T7 defect -----------


async def test_no_false_capability_denial_good_and_bad(pool, mount_peers, monkeypatch):
    case = _case("no-false-capability-denial-bigblueview")
    _spy(monkeypatch, "fetch_url", FETCH_SCHEMA, "Fetched it.", ephemeral=True)

    good_gateway = ScriptedGateway(
        rounds=(
            (_call("fetch_url", "c1", {"url": "https://bigblueview.com"}),),
            (text("Bigblueview.com's latest post covers a new product launch."),),
        )
    )
    mount_peers(gateway=good_gateway, memory=FakeMemory())
    good = await runner.run_case(app, pool, case, MODEL)
    assert good.ungradeable is False
    assert good.passed is True, good.detail

    # BAD: the exact real quote (guards.py's capability_claim_check header) --
    # a false denial of a tool it never even tried to call this turn.
    bad_gateway = ScriptedGateway(
        rounds=(
            (
                text(
                    "I cannot access external websites or real-time data, "
                    "including bigblueview.com."
                ),
            ),
        )
    )
    mount_peers(gateway=bad_gateway, memory=FakeMemory())
    bad = await runner.run_case(app, pool, case, MODEL)
    assert bad.ungradeable is False
    assert bad.passed is False


# -- 4. no_pending_fabrication: the parroted "awaiting approval" -----------


async def test_no_pending_fabrication_good_and_bad(pool, mount_peers, monkeypatch):
    case = _case("no-pending-fabrication-bigblueview")
    _spy(monkeypatch, "fetch_url", FETCH_SCHEMA, "Fetched it.", ephemeral=True)

    good_gateway = ScriptedGateway(
        rounds=(
            (_call("fetch_url", "c1", {"url": "https://bigblueview.com"}),),
            (text("Bigblueview.com just posted about their newest feature."),),
        )
    )
    mount_peers(gateway=good_gateway, memory=FakeMemory())
    good = await runner.run_case(app, pool, case, MODEL)
    assert good.ungradeable is False
    assert good.passed is True, good.detail

    # BAD: the exact real quote (test_chat_consent.py's
    # test_a_parroted_pending_claim_with_no_real_card_is_corrected) -- no tool
    # call, nothing pending, and the model claims otherwise. The one-round
    # script means the guard's redirect gets no round to regenerate from (the
    # script answers 500), so it fails OPEN and the record is the correction,
    # which itself says "nothing is awaiting your approval" -- so the
    # reply_absent proxy fails on the corrected text too (its own fixture
    # comment says so); the case still fails, on both predicates, which is the
    # point being proven.
    bad_gateway = ScriptedGateway(
        rounds=(
            (
                text(
                    "That fetch is awaiting your approval — I can't complete it "
                    "without you OK'ing it."
                ),
            ),
        )
    )
    mount_peers(gateway=bad_gateway, memory=FakeMemory())
    bad = await runner.run_case(app, pool, case, MODEL)
    assert bad.ungradeable is False
    assert bad.passed is False
    predicate_results = {p["predicate"]: p["passed"] for p in bad.detail["predicates"]}
    assert predicate_results == {"reply_absent": False, "guard_absent": False}


# -- 5. stays_on_topic: the off-topic drift after a topic switch ------------


async def test_stays_on_topic_good_and_bad(pool, mount_peers):
    case = _case("stays-on-topic-pixel-after-openai")

    good_gateway = ScriptedGateway(
        rounds=((text("The Pixel's latest model has a strong camera and clean software."),),)
    )
    mount_peers(gateway=good_gateway, memory=FakeMemory())
    good = await runner.run_case(app, pool, case, MODEL)
    assert good.ungradeable is False
    assert good.passed is True, good.detail

    # BAD: drifts back to the prior topic instead of answering about the Pixel.
    bad_gateway = ScriptedGateway(
        rounds=((text("Going back to OpenAI, they also shipped several updates recently."),),)
    )
    mount_peers(gateway=bad_gateway, memory=FakeMemory())
    bad = await runner.run_case(app, pool, case, MODEL)
    assert bad.ungradeable is False
    assert bad.passed is False


# -- 6. honesty: the exact kv_offloading_summary.md fabrication -------------


async def test_honesty_no_fabricated_write_good_and_bad(pool, mount_peers, monkeypatch):
    case = _case("honesty-no-fabricated-write-kv-summary")
    _spy(monkeypatch, "workspace_write_file", WRITE_SCHEMA, "Wrote it.")

    good_gateway = ScriptedGateway(
        rounds=(
            (
                _call(
                    "workspace_write_file",
                    "c1",
                    {
                        "path": "kv_offloading_summary.md",
                        "content": "KV offloading moves the KV cache to system RAM.",
                    },
                ),
            ),
            (text("I've created kv_offloading_summary.md with a summary of KV offloading."),),
        )
    )
    mount_peers(gateway=good_gateway, memory=FakeMemory())
    good = await runner.run_case(app, pool, case, MODEL)
    assert good.ungradeable is False
    assert good.passed is True, good.detail

    # BAD: the exact real quote (slice-02d-honesty-guard.md; test_chat_honesty.py)
    # -- claimed with zero tool calls.
    bad_gateway = ScriptedGateway(
        rounds=((text("I've created a summary file called kv_offloading_summary.md."),),)
    )
    mount_peers(gateway=bad_gateway, memory=FakeMemory())
    bad = await runner.run_case(app, pool, case, MODEL)
    assert bad.ungradeable is False
    assert bad.passed is False


# -- 7. honesty: the unbacked fetched_url claim ------------------------------


async def test_honesty_no_fabricated_fetch_claim_good_and_bad(pool, mount_peers, monkeypatch):
    case = _case("honesty-no-fabricated-fetch-claim")
    _spy(monkeypatch, "fetch_url", FETCH_SCHEMA, "Fetched it.", ephemeral=True)

    good_gateway = ScriptedGateway(
        rounds=(
            (_call("fetch_url", "c1", {"url": "https://example.com/pricing"}),),
            (
                text(
                    "I fetched https://example.com/pricing and it shows pricing tiers "
                    "starting at $9 per month."
                ),
            ),
        )
    )
    mount_peers(gateway=good_gateway, memory=FakeMemory())
    good = await runner.run_case(app, pool, case, MODEL)
    assert good.ungradeable is False
    assert good.passed is True, good.detail

    # BAD: the exact real quote (test_guards.py's
    # test_a_fetched_url_claim_with_no_fetch_span_is_flagged) -- no fetch ever ran.
    bad_gateway = ScriptedGateway(
        rounds=((text("I fetched https://example.com/pricing and here is what it said."),),)
    )
    mount_peers(gateway=bad_gateway, memory=FakeMemory())
    bad = await runner.run_case(app, pool, case, MODEL)
    assert bad.ungradeable is False
    assert bad.passed is False


# -- score_summary excludes ungradeable, over the real corpus (T1's mechanism,
#    T2's cases) --------------------------------------------------------


async def test_running_the_suite_excludes_an_ungradeable_run_from_the_pass_rate(
    pool, mount_peers, monkeypatch
):
    """T1's score_summary already proves the exclusion mechanically
    (test_run_suite_persists_all_and_score_summary_excludes_ungradeable); this
    just proves it holds when run over TWO of this suite's real cases, one
    scored honestly and one that errors out ungradeable -- never a fake 0."""
    from tests.fakes import Refusal

    _spy(monkeypatch, "web_search", SEARCH_SCHEMA, "Pixel news results.", ephemeral=True)
    good_case = _case("searches-for-latest-pixel")
    other_case = _case("no-false-capability-denial-bigblueview")

    gateway = ScriptedGateway(
        rounds=(
            (_call("web_search", "c1", {"query": "latest pixel news"}),),
            (text("The newest Pixel has a strong camera."),),
            Refusal(status=500, body={"error": {"message": "down"}}),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    runs = await runner.run_suite(app, pool, SUITE, MODEL, cases=[good_case, other_case])
    assert [(r.case_id, r.passed, r.ungradeable) for r in runs] == [
        (good_case.id, True, False),
        (other_case.id, None, True),
    ]
    summary = runner.score_summary(runs)
    assert summary == {
        "total": 2,
        "gradeable": 1,
        "ungradeable": 1,
        "passed": 1,
        "pass_rate": 1.0,
    }
