"""A learned chars-per-token ratio can never lock a link out (2026-10-15).

The S54a eval run found it: on `reads-back-a-summarized-result`, the
tool-less summary of a dense log (digits, hashes — ~1.7 chars a token,
honestly) taught the served link's ONE ratio. Every later round on that link
was then fitted with it, and her ~68k-char tools array — ordinary JSON at
~3.5 — was estimated at 38,922 tokens, so even a one-line question was
refused as unfittable. A refused request is never sent, so no new count ever
came back to correct the ratio: the link stayed locked until core restarted
(turns 30485a27, 1163842f).

Two lines of code refuse that now:
- only a round that carries tools teaches the ratio those rounds are fitted
  with; a tool-less completion (summary, judge) does not;
- a request the learned ratio calls unfittable forgets that ratio and is
  fitted again at the default; it is refused only if it cannot fit even then.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest

from app import chat, context_fit, traces
from app.main import app
from tests.fakes import FakeGateway

LINK = "dell:qwen3.8:27b"
MODEL = "qwen3.8:27b"
WINDOW = 32768
# Her advertised tools array as measured on the running core, 2026-10-15.
TOOLS_CHARS = 67_903
# The ratio the dense-log summary taught (38,922 tool tokens / 67,903 chars).
POISONED = 1.745


@pytest.fixture(autouse=True)
def fresh_link_facts(monkeypatch):
    monkeypatch.setattr(chat, "_SERVED_CHARS_PER_TOKEN", {})
    monkeypatch.setattr(chat, "_SERVED_WINDOWS", {})
    monkeypatch.setattr(chat, "_SERVED_LINK_BY_REQUEST", {})


def _turn() -> traces.Turn:
    return traces.Turn(id=uuid.uuid4(), started_at=datetime.now(UTC), model=MODEL)


def _ask(text: str = "What's a software factory?") -> list[dict]:
    return [
        {"role": "system", "content": "You are Nova."},
        {"role": "user", "content": text},
    ]


async def test_a_tool_less_completion_does_not_teach_the_ratio(mount_peers):
    """The summary call that poisoned the link: its prompt is a dense log and
    carries no tools, so its ratio says nothing about a tools round's."""
    chat._SERVED_CHARS_PER_TOKEN[LINK] = 3.6
    log = "2026-10-15T20:55:41Z a1b2c3d4 0x7f3e 4096 ERR 503\n" * 640
    gateway = FakeGateway(
        deltas=("summary",),
        served_by=LINK,
        usage={"prompt_tokens": 18_734, "completion_tokens": 5},
    )
    mount_peers(gateway=gateway)

    await chat._collect_completion(app, _turn(), MODEL, _ask(log), purpose="summary")

    assert chat._SERVED_CHARS_PER_TOKEN[LINK] == 3.6


def test_a_tools_round_still_teaches_the_ratio():
    """The calibration the fit depends on is kept for the rounds it governs."""
    span = traces.Span(kind="llm_call", name=LINK, started_at=datetime.now(UTC), duration_ms=0)
    span.meta.update({"served_by": LINK, "prompt_tokens": 20_000})
    sent = _ask("x" * 4_000)

    chat._learn_chars_per_token(span, sent, TOOLS_CHARS)

    learned = chat._SERVED_CHARS_PER_TOKEN[LINK]
    assert learned == context_fit.calibrated_chars_per_token(sent, 20_000, TOOLS_CHARS)


def _poisoned_link() -> None:
    chat._SERVED_WINDOWS[LINK] = WINDOW
    chat._SERVED_LINK_BY_REQUEST[MODEL] = LINK
    chat._SERVED_CHARS_PER_TOKEN[LINK] = POISONED


def test_a_poisoned_ratio_does_not_refuse_a_request_that_fits_at_the_default():
    """The one-line question that was refused: at the default ratio it fits."""
    _poisoned_link()
    meta: dict = {}

    fitted = chat._fit_to_window(_turn(), meta, _ask(), requested=MODEL, tools_chars=TOOLS_CHARS)

    assert list(fitted) == _ask()
    assert meta["context_fitted_to"] == WINDOW


def test_a_ratio_that_called_a_request_unfittable_is_forgotten():
    """So the next round re-learns from a real count instead of staying locked."""
    _poisoned_link()

    chat._fit_to_window(_turn(), {}, _ask(), requested=MODEL, tools_chars=TOOLS_CHARS)

    assert LINK not in chat._SERVED_CHARS_PER_TOKEN


def test_a_request_too_big_even_at_the_default_is_still_refused():
    """The refusal is kept for what is really over the window: instructions
    and ask alone past the budget at the default ratio."""
    _poisoned_link()
    huge = _ask("y" * int(WINDOW * context_fit.DEFAULT_CHARS_PER_TOKEN))

    with pytest.raises(chat.RequestUnfittable):
        chat._fit_to_window(_turn(), {}, huge, requested=MODEL, tools_chars=TOOLS_CHARS)


def test_a_sound_learned_ratio_that_refuses_is_not_second_guessed():
    """Only a LEARNED ratio is retried at the default: with none learned, the
    default's own refusal stands and nothing is retried."""
    chat._SERVED_WINDOWS[LINK] = WINDOW
    chat._SERVED_LINK_BY_REQUEST[MODEL] = LINK
    huge = _ask("y" * int(WINDOW * context_fit.DEFAULT_CHARS_PER_TOKEN))

    with pytest.raises(chat.RequestUnfittable):
        chat._fit_to_window(_turn(), {}, huge, requested=MODEL, tools_chars=TOOLS_CHARS)
    assert LINK not in chat._SERVED_CHARS_PER_TOKEN
