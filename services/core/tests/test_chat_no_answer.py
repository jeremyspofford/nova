"""fix/ci-event-gaps T2: a turn that ends without HER answer says so in its trace.

Every exit whose stored reply is the backend's — a narrated stop whose
narration round did not answer, the cap, the unfittable request, a window cut
twice, every link thinking only, a model failure, no link and a wake, a reply
that was only markup, an empty reply — files ONE `no_answer` span through
chat._file_no_answer, naming the reason in the backend's own stop words. A
turn she answered files none. The event notice (checks/events.py) names the
stop from that span, never from the reply's first line.

Each exit's own suite asserts its span (`no_answer_reasons` below) on the test
that already reaches it; this file holds the pure checks, the exits no other
suite reaches cleanly, and an answered turn.
"""

from __future__ import annotations

import json
import sys

import pytest

from app import chat, markup_calls, traces
from tests.conftest import requires_db
from tests.fakes import FakeMemory, Refusal, ScriptedGateway
from tests.test_chat_tools import _say
from tests.test_chat_tools import text as text_delta


async def no_answers(pool, turn_id=None) -> list[dict]:
    """The `no_answer` spans' meta of `turn_id` (default: the latest turn)."""
    if turn_id is None:
        turn_id = await pool.fetchval("SELECT id FROM turns ORDER BY started_at DESC LIMIT 1")
    rows = await pool.fetch(
        "SELECT name, meta FROM turn_spans WHERE turn_id = $1 AND kind = 'no_answer' "
        "ORDER BY started_at",
        turn_id,
    )
    out = []
    for row in rows:
        meta = row["meta"] if isinstance(row["meta"], dict) else json.loads(row["meta"])
        assert row["name"] == meta["reason"], (row["name"], meta)
        out.append(meta)
    return out


async def no_answer_reasons(pool, turn_id=None) -> list[str]:
    return [meta["reason"] for meta in await no_answers(pool, turn_id)]


def spans_no_answer_reasons(spans) -> list[str]:
    """The same, off an in-memory turn's spans."""
    return [s.meta["reason"] for s in spans if s.kind == "no_answer"]


@pytest.fixture
def workspace(monkeypatch, tmp_path):
    root = tmp_path / "workspace"
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


# -- the writer ------------------------------------------------------------------


def test_every_round_stop_reason_is_a_no_answer_reason():
    """Derived, never a second list: a new round_stop reason is a no_answer
    reason the day it is added, so its narrated or ended turn can be named."""
    assert chat.ROUND_STOP_REASONS <= chat.NO_ANSWER_REASONS


def _turn() -> traces.Turn:
    import uuid
    from datetime import UTC, datetime

    return traces.Turn(id=uuid.uuid4(), conversation_id=None, started_at=datetime.now(UTC))


@pytest.mark.parametrize("reason", sorted(chat.NO_ANSWER_REASONS))
def test_the_writer_files_one_span_named_for_its_reason(reason):
    turn = _turn()
    chat._file_no_answer(turn, reason, f"  words for {reason}\n")
    (span,) = turn.spans
    assert (span.kind, span.name) == ("no_answer", reason)
    assert span.meta == {"reason": reason, "words": f"words for {reason}"}


def test_the_writer_refuses_an_unnamed_reason_or_no_words():
    turn = _turn()
    with pytest.raises(ValueError):
        chat._file_no_answer(turn, "made_up", "words")
    with pytest.raises(ValueError):
        chat._file_no_answer(turn, chat.STOP_TOKEN_BUDGET, "  ")
    assert turn.spans == []


def test_the_fallback_header_is_never_a_stop_word():
    """The words are the stop's, never the tool-results statement."""
    for words in (*chat.CIRCLING_NOTE_WORDS.values(), chat.EMPTY_REPLY, chat.THINKING_ONLY_REASON):
        assert chat.TOOL_RESULTS_HEADER not in words


# -- exits through the real funnel ---------------------------------------------


@requires_db
async def test_an_answered_turn_files_no_no_answer_span(owner_client, pool, mount_peers):
    mount_peers(gateway=ScriptedGateway(rounds=((text_delta("All fine."),),)), memory=FakeMemory())
    await _say(owner_client, "how is it")
    assert await no_answers(pool) == []
    kinds = await pool.fetch("SELECT DISTINCT kind FROM turn_spans")
    assert "no_answer" not in {row["kind"] for row in kinds}


@requires_db
async def test_a_model_failure_files_its_stated_failure(owner_client, pool, mount_peers):
    mount_peers(
        gateway=ScriptedGateway(rounds=(Refusal(503, {"error": {"message": "no backend"}}),)),
        memory=FakeMemory(),
    )
    await _say(owner_client, "how is it")
    (meta,) = await no_answers(pool)
    assert meta["reason"] == chat.NO_ANSWER_MODEL_FAILURE
    assert "no backend" in meta["words"]
    assert chat.TOOL_RESULTS_HEADER not in meta["words"]
    assert await pool.fetchval("SELECT status FROM turns") == "error"


@requires_db
async def test_an_empty_reply_files_empty_reply(owner_client, pool, mount_peers, monkeypatch):
    """The defence-in-depth floor: every streamed delta stripped as markup that
    names no refused call and nothing unparsed -> the empty-reply exit."""
    original = markup_calls.parse_markup_tool_calls

    def stripped_to_nothing(text, *args, **kwargs):
        scan = original(text, *args, **kwargs)
        # Only the turn's own whole-reply scan (in _run_turn), never a round's.
        if sys._getframe(1).f_code.co_name != "_run_turn":
            return scan
        named = (markup_calls.ParsedCall(name="nothing_ran", arguments={}),)
        return markup_calls.MarkupScan(calls=named, text="", unparsed=False)

    monkeypatch.setattr(markup_calls, "parse_markup_tool_calls", stripped_to_nothing)
    mount_peers(gateway=ScriptedGateway(rounds=((text_delta("gone"),),)), memory=FakeMemory())
    await _say(owner_client, "how is it")
    (meta,) = await no_answers(pool)
    assert meta == {"reason": chat.NO_ANSWER_EMPTY_REPLY, "words": chat.EMPTY_REPLY}


@requires_db
@pytest.mark.parametrize(
    ("reason", "qs"),
    [
        (chat.STOP_REPEATED_CALL, ("a", "a", "a")),
        (chat.STOP_NO_NEW_RESULTS, ("a", "b", "c", "d")),
    ],
)
@pytest.mark.parametrize("answered", [False, True], ids=["silent", "answered"])
async def test_a_circling_stop_files_its_note_words_only_when_she_did_not_answer(
    reason, qs, answered, owner_client, pool, mount_peers, workspace, monkeypatch
):
    from tests.test_turn_progress import PROSE, _arm_probe, _probe_rounds, _run_probes

    _arm_probe(
        monkeypatch,
        (lambda q, n: f"{q} result #{n}")
        if reason == chat.STOP_REPEATED_CALL
        else (lambda q, n: "nothing there"),
    )
    narration = (text_delta(PROSE),) if answered else ()
    await _run_probes(owner_client, mount_peers, (*_probe_rounds(*qs), narration))
    if answered:
        assert await no_answers(pool) == []
    else:
        assert await no_answers(pool) == [
            {"reason": reason, "words": chat.CIRCLING_NOTE_WORDS[reason]}
        ]
