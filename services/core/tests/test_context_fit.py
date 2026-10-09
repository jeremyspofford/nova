"""context_fit.fit: a round's messages fitted to the served window (T3).

Pure tests, no database. The message shapes are chat.py's own:
base_messages() builds [system stable, system volatile?, *history, system
hint?, user ask], history is plain role/content text (plus THREAD_OPENING /
facts system messages), the ask is a str or a list of content parts
(text + image_url) when pictures ride along, each tool round appends
{"role": "assistant", "content": round_text, "tool_calls": [call.as_openai()]}
then one {"role": "tool", "tool_call_id": id, "content": result} per call,
and redirect/circling rounds append a system nudge AFTER everything.
"""

from __future__ import annotations

import copy
import json
import re

from app import context_fit
from app.context_fit import budget_for, estimate_tokens, fit

CPT = 4.0
NOTE = re.compile(r"\[trimmed (\d+) chars[^\]]*?\b(\d+)-token[^\]]*\]$")


def _call(call_id: str, name: str, arguments: dict) -> dict:
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }


def _round(n: int, results: list[str], text: str = "", name: str = "device_run") -> list[dict]:
    calls = [
        _call(f"call_{n}_{i}", name, {"command": f"step {n}.{i}"}) for i in range(len(results))
    ]
    return [
        {"role": "assistant", "content": text, "tool_calls": calls},
        *(
            {"role": "tool", "tool_call_id": call["id"], "content": result}
            for call, result in zip(calls, results, strict=True)
        ),
    ]


def _systems(messages: list[dict]) -> list[dict]:
    return [m for m in messages if m["role"] == "system"]


def _last_user(messages: list[dict]) -> dict:
    return [m for m in messages if m["role"] == "user"][-1]


def _assert_paired(messages: list[dict]) -> None:
    """No orphan role:tool, and no assistant tool_call left unanswered."""
    open_ids: set[str] = set()
    for message in messages:
        if message["role"] == "assistant" and message.get("tool_calls"):
            assert not open_ids, f"calls {open_ids} never answered before the next round"
            open_ids = {call["id"] for call in message["tool_calls"]}
        elif message["role"] == "tool":
            assert message["tool_call_id"] in open_ids, (
                f"orphan tool message {message['tool_call_id']}"
            )
            open_ids.discard(message["tool_call_id"])
        else:
            assert not open_ids, f"calls {open_ids} interrupted by a {message['role']} message"
    assert not open_ids, f"calls {open_ids} never answered"


def _assert_note(original: str, trimmed: str, window: int) -> int:
    """`trimmed` is a head of `original` plus a stated note naming exactly
    the chars removed and the window. Returns the chars removed."""
    match = NOTE.search(trimmed)
    assert match, f"no trim note in {trimmed[-200:]!r}"
    removed, stated_window = int(match.group(1)), int(match.group(2))
    assert stated_window == window
    assert 0 < removed <= len(original)
    head = original[: len(original) - removed]
    note = match.group(0)
    assert trimmed in (head + note, head + "\n" + note), "kept text is not the original's head"
    return removed


def _fitted_within(fitted: list[dict], report: context_fit.FitReport, window: int) -> None:
    assert report.window == window
    assert report.budget == budget_for(window)
    assert report.est_tokens == estimate_tokens(fitted, CPT)
    assert report.est_tokens <= report.budget < window
    assert report.fits is True
    assert report.unfittable is False


# --- C1: a request inside the budget comes back untouched -------------------


def test_budget_reserves_room_for_the_reply():
    for window in (2048, 8192, 32768, 131072):
        budget = budget_for(window)
        assert 0 < budget < window
        assert budget == int(window * (1 - context_fit.REPLY_RESERVE_FRACTION))


def test_estimate_grows_with_the_text_sent_and_counts_tool_call_arguments():
    base = [{"role": "user", "content": "x" * 400}]
    assert estimate_tokens(base, CPT) >= 100
    assert estimate_tokens([{"role": "user", "content": "x" * 4000}], CPT) > estimate_tokens(
        base, CPT
    )
    small = _round(1, ["ok"])
    big = copy.deepcopy(small)
    big[0]["tool_calls"][0]["function"]["arguments"] = json.dumps({"command": "y" * 8000})
    assert estimate_tokens(big, CPT) >= estimate_tokens(small, CPT) + 1500
    # A lower chars-per-token reads the same text as more tokens.
    assert estimate_tokens(base, 2.0) > estimate_tokens(base, CPT)


def test_a_request_inside_the_budget_is_returned_unchanged():
    messages = [
        {"role": "system", "content": "You are Nova."},
        {"role": "user", "content": "earlier ask"},
        {"role": "assistant", "content": "earlier answer"},
        {"role": "user", "content": "run python --version"},
        *_round(1, ["Python 3.12.3"]),
    ]
    before = copy.deepcopy(messages)
    fitted, report = fit(messages, 32768, CPT)
    assert fitted == before
    assert messages == before, "fit mutated its input"
    assert report.tool_results_trimmed == 0
    assert report.rounds_dropped == 0
    assert report.chars_removed == 0
    _fitted_within(fitted, report, 32768)


# --- C2: oldest tool-result content is trimmed first, to a stated note ------


def test_the_oldest_tool_result_is_trimmed_first_and_the_note_states_it():
    window = 16384
    old, new = "a" * 40_000, "b" * 40_000
    messages = [
        {"role": "system", "content": "You are Nova."},
        {"role": "user", "content": "compare the two files"},
        *_round(1, [old]),
        *_round(2, [new]),
    ]
    before = copy.deepcopy(messages)
    fitted, report = fit(messages, window, CPT)
    assert messages == before, "fit mutated its input"
    tools = [m for m in fitted if m["role"] == "tool"]
    assert [m["tool_call_id"] for m in tools] == ["call_1_0", "call_2_0"]
    removed = _assert_note(old, tools[0]["content"], window)
    assert tools[1]["content"] == new, "the newer result was touched while the oldest sufficed"
    assert report.tool_results_trimmed == 1
    assert report.rounds_dropped == 0
    assert report.chars_removed == removed
    _assert_paired(fitted)
    _fitted_within(fitted, report, window)


# --- C3: then oldest whole tool rounds go, never leaving an orphan ----------


def test_oldest_whole_rounds_are_dropped_as_a_unit_when_trimming_is_not_enough():
    window = 16384
    rounds = [
        _round(1, ["one", "two"], text="t" * 20_000),
        _round(2, ["three"], text="u" * 20_000),
        _round(3, ["four"], text="v" * 20_000),
        _round(4, ["five", "six"], text="w" * 20_000),
    ]
    messages = [
        {"role": "system", "content": "You are Nova."},
        {"role": "user", "content": "do the four things"},
        *(m for r in rounds for m in r),
    ]
    before = copy.deepcopy(messages)
    fitted, report = fit(messages, window, CPT)
    assert messages == before, "fit mutated its input"
    assert report.rounds_dropped >= 1
    kept_ids = {m["tool_call_id"] for m in fitted if m["role"] == "tool"}
    assert not kept_ids & {"call_1_0", "call_1_1"}, "the oldest round was not dropped whole"
    assert rounds[3][0] in fitted, "the newest round's assistant message is gone"
    assert {"call_4_0", "call_4_1"} <= kept_ids
    assert len([m for m in fitted if m.get("tool_calls")]) == 4 - report.rounds_dropped
    _assert_paired(fitted)
    _fitted_within(fitted, report, window)


# --- C4: system messages and the latest user message are never touched -----


def test_system_messages_and_a_picture_ask_survive_byte_identical():
    window = 8192
    ask = [
        {"type": "text", "text": "what is in this picture?\n\n[attached: shot.png]"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64," + "Q" * 600}},
    ]
    messages = [
        {"role": "system", "content": "S" * 6000},
        {"role": "system", "content": "volatile: recalled notes"},
        {"role": "system", "content": "This thread continues from an earlier message."},
        {"role": "user", "content": "earlier"},
        {"role": "assistant", "content": "earlier reply"},
        {"role": "system", "content": "decision-role hint"},
        {"role": "user", "content": ask},
        *_round(1, ["r" * 30_000]),
        *_round(2, ["s" * 30_000]),
        {"role": "system", "content": "You have run tools; answer now."},
    ]
    before = copy.deepcopy(messages)
    fitted, report = fit(messages, window, CPT)
    assert messages == before, "fit mutated its input"
    assert json.dumps(_systems(fitted)) == json.dumps(_systems(before))
    assert json.dumps(_last_user(fitted)) == json.dumps(_last_user(before))
    assert fitted[-1] == before[-1], "the trailing nudge moved"
    _assert_paired(fitted)
    _fitted_within(fitted, report, window)


def test_turn_0f7af448_keeps_her_instructions_and_his_ask():
    """dell:qwen3:8b, "run python --version on the mini pc": python missing,
    `which python` exit 1, then device_list_files /usr/bin (~1600 entries).
    Round 4 hit prompt_tokens 32767 on a 32768 window and ollama cut the
    front: the system prompt and his ask were gone."""
    window = 32768
    stable = "You are Nova, the household's assistant. " + "Facts and rules. " * 1800
    volatile = "Recalled notes: the mini PC is the hub. " * 40
    ask = "run python --version on the mini pc"
    listing = "\n".join(
        f"-rwxr-xr-x  1 root root  {10_000 + i:>8}  2026-09-0{i % 9 + 1}  /usr/bin/tool-{i:04d}-bin"
        for i in range(1600)
    )
    messages = [
        {"role": "system", "content": stable},
        {"role": "system", "content": volatile},
        {"role": "user", "content": ask},
        *_round(1, ["Error: exit 127 — bash: python: command not found"]),
        *_round(2, ["exit 1 (no output)"]),
        *_round(3, [listing], name="device_list_files"),
    ]
    before = copy.deepcopy(messages)
    assert estimate_tokens(before, CPT) > budget_for(window), "the fixture must start over budget"
    assert estimate_tokens(before[:3], CPT) < budget_for(window), "instructions + ask alone fit"

    fitted, report = fit(messages, window, CPT)

    assert messages == before, "fit mutated its input"
    assert fitted[0] == before[0] and fitted[1] == before[1], "her instructions changed"
    assert json.dumps(_systems(fitted)) == json.dumps(_systems(before))
    assert _last_user(fitted) == {"role": "user", "content": ask}
    _assert_paired(fitted)
    _fitted_within(fitted, report, window)
    assert report.tool_results_trimmed >= 1
    assert report.chars_removed > 0
    # The listing's round is the newest: it survives, trimmed, and its note
    # states what was removed and against which window.
    listing_msg = next(
        (m for m in fitted if m["role"] == "tool" and m["tool_call_id"] == "call_3_0"), None
    )
    assert listing_msg is not None, "the newest round was dropped instead of trimmed"
    _assert_note(listing, listing_msg["content"], window)


# --- C5: a request that cannot fit is reported, never mangled ---------------


def test_instructions_and_ask_alone_over_budget_is_reported_unfittable():
    window = 2048
    messages = [
        {"role": "system", "content": "S" * 20_000},
        {"role": "user", "content": "his question"},
        *_round(1, ["r" * 4000]),
    ]
    before = copy.deepcopy(messages)
    fitted, report = fit(messages, window, CPT)
    assert messages == before, "fit mutated its input"
    assert report.unfittable is True
    assert report.fits is False
    assert report.window == window
    assert report.budget == budget_for(window)
    assert report.est_tokens > report.budget
    assert report.est_tokens == estimate_tokens(fitted, CPT)
    assert json.dumps(_systems(fitted)) == json.dumps(_systems(before))
    assert _last_user(fitted) == before[1]
    _assert_paired(fitted)


def test_estimate_counts_tool_call_names_and_text_parts_of_a_picture_ask():
    short = _round(1, ["ok"], name="x")
    long = _round(1, ["ok"], name="x" * 4000)
    assert estimate_tokens(long, CPT) >= estimate_tokens(short, CPT) + 900
    parts = [{"role": "user", "content": [{"type": "text", "text": "y" * 4000}]}]
    assert estimate_tokens(parts, CPT) >= 1000
