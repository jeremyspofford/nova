"""context_summary: which tool results to summarize, and the marker (S38b T2).

Pure tests, no database. Message shapes are chat.py's own (see
test_context_fit.py): each tool round is an assistant message with
tool_calls followed by one role:tool message per call.
"""

from __future__ import annotations

import copy
import json

import pytest

from app import context_summary
from app.context_fit import budget_for, estimate_tokens
from app.context_summary import (
    Summary,
    apply,
    candidates,
    marker,
    summarized_content,
    summary_max_tokens,
)

CPT = 4.0
WINDOW = 10_000


def _call(call_id: str, name: str) -> dict:
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps({"q": call_id})},
    }


def _round(call_ids: list[str], sizes: list[int], name: str = "browser_read") -> list[dict]:
    calls = [_call(cid, name) for cid in call_ids]
    return [
        {"role": "assistant", "content": "", "tool_calls": calls},
        *(
            {"role": "tool", "tool_call_id": cid, "content": chr(97 + n % 26) * size}
            for n, (cid, size) in enumerate(zip(call_ids, sizes, strict=True))
        ),
    ]


def _conversation(sizes: list[list[int]], name: str = "browser_read") -> tuple[list[dict], dict]:
    """[system, user, round1, round2, ...]; call ids c1, c2, ... in order and
    kept refs r1, r2, ... matching them (T1 numbers refs in call order)."""
    messages: list[dict] = [
        {"role": "system", "content": "You are Nova."},
        {"role": "user", "content": "read the log and tell me what failed first"},
    ]
    kept: dict[str, str] = {}
    n = 0
    for round_sizes in sizes:
        ids = []
        for _ in round_sizes:
            n += 1
            ids.append(f"c{n}")
            kept[f"c{n}"] = f"r{n}"
        messages.extend(_round(ids, round_sizes, name))
    return messages, kept


def _cap_summaries(messages: list[dict], kept: dict[str, str], refs: list[str]) -> dict:
    """Summaries of the cap size for `refs` — what candidates() assumes a
    not-yet-written summary will cost."""
    cap_chars = int(summary_max_tokens(WINDOW) * CPT)
    by_ref = {ref: cid for cid, ref in kept.items()}
    out = {}
    for ref in refs:
        cid = by_ref[ref]
        content = next(m["content"] for m in messages if m.get("tool_call_id") == cid)
        out[cid] = Summary(ref=ref, tool="browser_read", chars=len(content), text="s" * cap_chars)
    return out


def _est(messages: list[dict]) -> int:
    return estimate_tokens(messages, CPT)


# --- marker -----------------------------------------------------------------


def test_marker_is_exactly_the_spec_header():
    assert marker("r3", "browser_read", 48_120) == (
        "[summary of browser_read result r3 (48,120 chars) — the full text is kept;\n"
        'read it with read_result("r3", part=… or query=…)]'
    )


def test_summarized_content_is_marker_then_summary():
    s = Summary(ref="r1", tool="device_run", chars=900, text="exit 1: disk full")
    assert summarized_content(s) == marker("r1", "device_run", 900) + "\n" + "exit 1: disk full"


# --- apply ------------------------------------------------------------------


def test_apply_replaces_only_summarized_results_and_keeps_other_objects():
    messages, _ = _conversation([[3000, 3000], [3000]])
    before = copy.deepcopy(messages)
    s = Summary(ref="r2", tool="browser_read", chars=3000, text="the second part")
    out = apply(messages, {"c2": s})

    assert messages == before, "input mutated"
    assert len(out) == len(messages)
    for original, new in zip(messages, out, strict=True):
        if original.get("tool_call_id") == "c2":
            assert new is not original
            assert new["content"] == summarized_content(s)
            assert {k: v for k, v in new.items() if k != "content"} == {
                k: v for k, v in original.items() if k != "content"
            }
        else:
            assert new is original


@pytest.mark.parametrize("text", ["", "   \n  "])
def test_apply_refuses_a_marker_without_a_summary(text):
    messages, _ = _conversation([[3000], [3000]])
    with pytest.raises(ValueError):
        apply(messages, {"c1": Summary(ref="r1", tool="browser_read", chars=3000, text=text)})


def test_apply_with_no_summaries_is_the_same_objects():
    messages, _ = _conversation([[3000], [3000]])
    out = apply(messages, {})
    assert out == messages and all(a is b for a, b in zip(out, messages, strict=True))


# --- candidates -------------------------------------------------------------


def test_fractions_are_constants_not_a_model_table():
    assert context_summary.START_FRACTION == 0.70
    assert context_summary.STOP_FRACTION == 0.50
    assert summary_max_tokens(WINDOW) == int(WINDOW * context_summary.SUMMARY_FRACTION)
    assert summary_max_tokens(10 * WINDOW) == 10 * summary_max_tokens(WINDOW)


def test_under_seventy_percent_returns_nothing():
    messages, kept = _conversation([[5000], [5000], [5000]])
    assert _est(messages) < 0.70 * budget_for(WINDOW)
    assert candidates(messages, WINDOW, CPT, kept, {}) == []


def test_between_fifty_and_seventy_percent_returns_nothing():
    """Under the start mark nothing starts, even though the stop mark is passed."""
    budget = budget_for(WINDOW)
    messages, kept = _conversation([[9000], [9000], [3000]])
    assert 0.50 * budget < _est(messages) < 0.70 * budget
    assert candidates(messages, WINDOW, CPT, kept, {}) == []


def test_just_over_seventy_percent_starts():
    budget = budget_for(WINDOW)
    # Older results big enough to push the estimate just past 70%.
    messages, kept = _conversation([[12_000], [12_000], [1000]])
    assert _est(messages) > 0.70 * budget
    picked = candidates(messages, WINDOW, CPT, kept, {})
    assert picked and picked[0] == "r1"


def test_picks_oldest_first_and_stops_under_fifty_percent():
    budget = budget_for(WINDOW)
    # Three big old results reach the stop mark; three smaller older-than-latest
    # ones are left unpicked though each would still save something.
    messages, kept = _conversation([[20_000], [20_000], [20_000], [3000], [3000], [3000], [1000]])
    picked = candidates(messages, WINDOW, CPT, kept, {})

    assert picked == ["r1", "r2", "r3"], "not oldest-first, or did not stop"
    # Under 50% with the picked ones in place (at the summary cap) ...
    after = apply(messages, _cap_summaries(messages, kept, picked))
    assert _est(after) < 0.50 * budget
    # ... and not one more than needed: one fewer is still at or over 50%.
    fewer = apply(messages, _cap_summaries(messages, kept, picked[:-1]))
    assert _est(fewer) >= 0.50 * budget


def test_never_picks_the_latest_rounds_own_results():
    budget = budget_for(WINDOW)
    # One round only: everything is the latest round's own results.
    messages, kept = _conversation([[10_000, 10_000, 10_000]])
    assert _est(messages) > 0.70 * budget
    assert candidates(messages, WINDOW, CPT, kept, {}) == []

    # An older round and a huge latest round: only the older one is a candidate.
    messages, kept = _conversation([[6000, 6000], [30_000, 30_000]])
    picked = candidates(messages, WINDOW, CPT, kept, {})
    assert picked == ["r1", "r2"]


def test_latest_round_is_the_last_tool_round_even_with_a_trailing_system_nudge():
    messages, kept = _conversation([[8000], [8000], [8000], [8000], [8000]])
    messages.append({"role": "system", "content": "You are circling; answer now."})
    picked = candidates(messages, WINDOW, CPT, kept, {})
    assert "r5" not in picked and picked


def test_stops_when_none_are_left_even_over_fifty_percent():
    budget = budget_for(WINDOW)
    messages, kept = _conversation([[8000], [30_000]])
    picked = candidates(messages, WINDOW, CPT, kept, {})
    assert picked == ["r1"]
    after = apply(messages, _cap_summaries(messages, kept, picked))
    assert _est(after) >= 0.50 * budget


def test_already_summarized_are_skipped_and_counted_at_their_summary():
    messages, kept = _conversation([[8000], [8000], [8000], [8000], [8000]])
    done = {
        "c1": Summary(ref="r1", tool="browser_read", chars=8000, text="short"),
        "c2": Summary(ref="r2", tool="browser_read", chars=8000, text="short"),
    }
    picked = candidates(messages, WINDOW, CPT, kept, done)
    assert "r1" not in picked and "r2" not in picked
    # With r1, r2 already in place at a few chars, the estimate counts that:
    # fewer new ones are needed than with nothing summarized.
    assert len(picked) < len(candidates(messages, WINDOW, CPT, kept, {}))


def test_summaries_in_place_under_seventy_returns_nothing():
    budget = budget_for(WINDOW)
    # r3 is an older-than-latest result that would be picked if r1, r2 were
    # counted at their full size.
    messages, kept = _conversation([[12_000], [12_000], [3000], [1000]])
    assert _est(messages) > 0.70 * budget
    done = {
        "c1": Summary(ref="r1", tool="browser_read", chars=12_000, text="short"),
        "c2": Summary(ref="r2", tool="browser_read", chars=12_000, text="short"),
    }
    assert _est(apply(messages, done)) < 0.70 * budget
    assert candidates(messages, WINDOW, CPT, kept, done) == []


def test_a_result_without_a_kept_ref_is_never_picked():
    messages, kept = _conversation([[8000], [8000], [8000], [8000], [8000]])
    del kept["c1"]
    picked = candidates(messages, WINDOW, CPT, kept, {})
    assert "r1" not in picked and picked[0] == "r2"


def test_a_result_no_bigger_than_its_summary_would_be_is_not_picked():
    cap_chars = int(summary_max_tokens(WINDOW) * CPT)
    messages, kept = _conversation([[cap_chars // 2], [12_000], [12_000], [1000]])
    picked = candidates(messages, WINDOW, CPT, kept, {})
    assert "r1" not in picked and "r2" in picked


def test_non_text_tool_content_is_skipped():
    messages, kept = _conversation([[8000], [8000], [8000], [8000], [8000]])
    first_tool = next(m for m in messages if m.get("tool_call_id") == "c1")
    first_tool["content"] = [{"type": "text", "text": "x" * 8000}]
    picked = candidates(messages, WINDOW, CPT, kept, {})
    assert "r1" not in picked


def test_input_is_never_mutated():
    messages, kept = _conversation([[8000], [8000], [8000], [8000], [8000]])
    done = {"c1": Summary(ref="r1", tool="browser_read", chars=8000, text="short")}
    before = (copy.deepcopy(messages), dict(kept), dict(done))
    candidates(messages, WINDOW, CPT, kept, done)
    assert (messages, kept, done) == before


def test_scale_invariant_same_proportions_same_picks():
    """Fractions of the window, not sizes: 10x the window and 10x every
    message picks the same refs."""
    small, kept = _conversation([[8000], [8000], [8000], [8000], [8000]])
    big = [{**m, "content": m["content"] * 10} if m["role"] == "tool" else m for m in small]
    assert candidates(small, WINDOW, CPT, kept, {}) == candidates(big, 10 * WINDOW, CPT, kept, {})


def test_unknown_window_or_ratio_is_refused():
    messages, kept = _conversation([[8000], [8000]])
    with pytest.raises(ValueError):
        candidates(messages, 0, CPT, kept, {})
    with pytest.raises(ValueError):
        candidates(messages, WINDOW, 0, kept, {})
