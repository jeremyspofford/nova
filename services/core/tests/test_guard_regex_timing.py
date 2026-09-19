"""No guard regex may backtrack catastrophically (S40b final fix wave, D2).

The S40b final review measured a padded markdown model table — an HONEST
reply, the very status answer S40b targets — taking 15.7 s in
served_claim_check at 20-character columns, x16 for every 2 more. The cause
was `(?:\\s+|…)*`: a whitespace run inside a starred alternation can be split
2^(n-1) ways, and every split is tried when the fullmatch fails. The guards run
synchronously inside core's async turn, on its only process, so one such reply
stalls every conversation, health check and eval turn with it.

These pins time the guards on adversarial padding. The first set is the
review's own reproductions through the public guard functions; the sweep runs
EVERY compiled pattern the module holds (module constants, pattern tuples and
the per-name builders) over 200-character padding inputs, so a regex added
later is timed the day it lands rather than the day it hangs core. Budget: 50
ms per call — the exponential forms took seconds to hours at these sizes; a
linear or low-order polynomial one takes microseconds to a few ms.
"""

from __future__ import annotations

import re
import time
from types import SimpleNamespace

import pytest

from app import guards

BUDGET_S = 0.05


def _span(kind: str, name: str | None, **meta):
    return SimpleNamespace(kind=kind, name=name, meta=dict(meta))


SERVED = [_span("llm_call", "hub:qwen3:8b", purpose="chat", served_by="hub:qwen3:8b", local=True)]
RECALLED = _span("memory_recall", None, k=5, hits=3)


def _best_of(fn, runs: int = 3) -> float:
    """The fastest of a few runs: a timing pin measures the algorithm, not a
    busy machine's scheduler."""
    best = float("inf")
    for _ in range(runs):
        start = time.perf_counter()
        fn()
        best = min(best, time.perf_counter() - start)
    return best


def _row(width: int) -> str:
    """The review's padded table row, every column `width` characters."""
    cells = ("qwen3:8b", "4.9 GB", "loaded, in use")
    return "| " + " | ".join(cell.ljust(width) for cell in cells) + " |"


# The review's reproductions (final-review.md #1), through the guard itself.
REVIEW_REPRODUCTIONS = [
    ("table_row_20_wide", _row(20)),
    ("table_row_60_wide", _row(60)),
    ("row_60_spaces", "| qwen3:8b" + " " * 60 + "| loaded, in use |"),
    ("label_path_22_spaces", "qwen3.8:27b ✅ in use: qwen3:8b" + " " * 22 + "idle"),
    ("label_path_60_spaces", "qwen3.8:27b ✅ in use: qwen3:8b" + " " * 60 + "idle"),
    ("ref_200_spaces_then_a_word", "qwen3:8b" + " " * 200 + "loaded, in use"),
]


@pytest.mark.parametrize(
    "label,reply", REVIEW_REPRODUCTIONS, ids=[c[0] for c in REVIEW_REPRODUCTIONS]
)
def test_a_padded_model_table_is_judged_in_milliseconds(label, reply):
    took = _best_of(lambda: guards.served_claim_check(reply, SERVED, purpose="chat"))
    assert took < BUDGET_S, f"{label}: {took * 1000:.1f} ms"
    # …and the honest row is still not corrected: it names the model that served.
    assert guards.served_claim_check(reply, SERVED, purpose="chat") is None, label


# The machine branch's key/value lines: `_KEY_VALUE_LINE` read a line of
# leading padding in O(n^4) (0.4 s at 200 spaces, hung at 1,000) through the
# overlapping `\s*` of its shared line lead.
PADDED_BLOCKS = [
    (
        # The walk up from the reading crosses the status line, then reads the
        # padded line as a key/value line.
        "padded_line_above_a_status_line",
        "The models run on hub.\n"
        + " " * 200
        + "x\n- Status: online\n- Last Reported: 2026-09-19T05:15:39+00:00",
    ),
    (
        "padded_status_line",
        "hub\n- Status:" + " " * 200 + "x offline\n- Last Reported: 2026-09-19T05:15:39+00:00",
    ),
    ("padded_reading_value", "hub\n- Last Reported:" + " " * 200 + "2026-09-19T05:15:39+00:00"),
    ("padded_memory_line", "the memory service is" + " " * 200 + "x"),
]


@pytest.mark.parametrize("label,reply", PADDED_BLOCKS, ids=[c[0] for c in PADDED_BLOCKS])
def test_padded_machine_and_memory_lines_are_judged_in_milliseconds(label, reply):
    spans = [*SERVED, RECALLED]
    for check in (
        lambda: guards.state_claim_check(reply, spans, [], purpose="chat"),
        lambda: guards.served_claim_check(reply, spans, purpose="chat"),
        lambda: guards.memory_claim_check(reply, spans, purpose="chat"),
    ):
        took = _best_of(check)
        assert took < BUDGET_S, f"{label}: {took * 1000:.1f} ms"


def _every_pattern() -> dict[str, re.Pattern[str]]:
    """Every compiled pattern guards.py holds: module constants, tuples of
    them, and what the per-name builders compile for a machine set and a
    paired device. Derived by walking the module, so a new regex is swept the
    day it is added."""
    found: dict[str, re.Pattern[str]] = {}
    for name in dir(guards):
        value = getattr(guards, name)
        if isinstance(value, re.Pattern):
            found[name] = value
        elif isinstance(value, tuple) and value and all(isinstance(v, re.Pattern) for v in value):
            for i, pattern in enumerate(value):
                found[f"{name}[{i}]"] = pattern
    for i, pattern in enumerate(guards._machine_patterns(("hub", "eval_box"))):
        found[f"_machine_patterns[{i}]"] = pattern
    for i, pattern in enumerate(guards._state_patterns(("DELL-XPS-8950",))):
        found[f"_state_patterns[{i}]"] = pattern
    device = guards._device_mention(("DELL-XPS-8950",))
    if device is not None:
        found["_device_mention"] = device
    found["_not_run_pattern"] = guards._not_run_pattern(tuple(sorted(guards._machine_read_tools())))
    return found


PAD = " " * 200
# 200-character padding inputs, each built around a token a guard pattern
# anchors on, so the padding is what the engine has to walk past.
SWEEP_INPUTS = {
    "spaces": PAD + "x",
    "tabs": "\t " * 100 + "x",
    "dash_then_spaces": "- " + PAD + "x",
    "key_between_spaces": " " * 100 + "Status" + " " * 100 + "x",
    "key_colon_then_spaces": "- Status:" + PAD + "x",
    "reading_key_then_spaces": "- Last Reported:" + PAD + "x",
    "machine_then_spaces": "hub" + PAD + "x",
    "machine_copula_then_spaces": "hub is" + PAD + "x",
    "machine_which": "hub" + " " * 100 + "," + " " * 100 + "which",
    "ref_then_spaces": "qwen3:8b" + PAD + "loaded, ",
    "ref_copula_then_spaces": "qwen3:8b is" + PAD + "x",
    "label_then_spaces": "qwen3.8:27b ✅ in use: qwen3:8b" + PAD + "idle",
    "size_then_spaces": "4.9" + PAD + "x",
    "bracketed_size_padding": "(" + " " * 100 + "4.9 GB" + " " * 100 + "x",
    "badges": "qwen3:8b" + " ✅ —" * 50 + " x",
    "sizes": "qwen3:8b" + " 4.9 GB" * 28 + " x",
    "memory_then_spaces": "the memory service" + PAD + "x",
    "memory_copula_then_spaces": "the memory service is" + PAD + "x",
    "lead_word_then_spaces": "as" + PAD + "x",
    "subordinator_then_spaces": "if" + PAD + "x",
    "strike_then_spaces": "~~" + PAD + "x",
    "digits": "1" * 200 + "x",
    "word": "a" * 200 + "!",
    "words": "a " * 100 + "!",
    "negations": "hub is " + "not " * 48 + "x",
    "said_that": "I said that " * 16 + "x",
}


@pytest.mark.parametrize("pattern_name", sorted(_every_pattern()))
def test_every_guard_pattern_walks_200_characters_of_padding_in_milliseconds(pattern_name):
    pattern = _every_pattern()[pattern_name]
    for label, text in SWEEP_INPUTS.items():
        for method in (pattern.search, pattern.match, pattern.fullmatch):
            took = _best_of(lambda method=method, text=text: method(text), runs=2)
            assert took < BUDGET_S, (
                f"{pattern_name}.{method.__name__}({label}): {took * 1000:.1f} ms"
            )


def test_the_sweep_reaches_the_in_use_and_line_patterns():
    """The patterns the review found hanging are among those swept — the
    sweep is derived, and this says it still reaches them."""
    swept = _every_pattern()
    for name in (
        "_IN_USE_BEFORE_GAP",
        "_IN_USE_LABEL_ENDS",
        "_KEY_VALUE_LINE",
        "_OWN_STATE_LINE",
        "_MEMORY_DOWN",
        "_machine_patterns[1]",
    ):
        assert name in swept, name
