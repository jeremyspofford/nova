"""Which tool results to summarize, and the marker a summary carries (S38b T2).

When a round's request nears the served window, the oldest tool results are
replaced IN WHAT IS SENT by summaries (spec §2-§3); the full text is kept
(traces, T1) and readable back with read_result (T4). This module decides
which results, and writes the marker; chat (T3) writes the summaries.

- Under START_FRACTION of the budget (context_fit.budget_for): nothing.
- Over it: the oldest role:tool results with a kept ref, not already
  summarized, skipping the latest tool round's own results, are picked one at
  a time until the estimate (with every summary in place) is under
  STOP_FRACTION of the budget, or none are left.

Both marks are fractions of the window, never a table of models. A summary
not yet written is counted at its cap (summary_max_tokens), the most it may
cost. The marker is written here, by code, so it cannot be left off; and
apply() refuses a marker without a summary.

Pure: no I/O, the input is never mutated.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from app.context_fit import _message_chars, _rounds, _tokens, budget_for

# Summarizing starts when the estimate reaches this share of the budget ...
START_FRACTION = 0.70
# ... and stops once it is under this share.
STOP_FRACTION = 0.50
# The most one summary may cost, as a share of the window: the summarizer's
# max_tokens, and what a summary not yet written is counted at.
SUMMARY_FRACTION = 0.05


@dataclass(frozen=True)
class Summary:
    """A written summary of the kept result `ref` (`chars` long) from `tool`."""

    ref: str
    tool: str
    chars: int
    text: str


def summary_max_tokens(window: int) -> int:
    """The most tokens one summary may take in a `window`-token request."""
    return int(window * SUMMARY_FRACTION)


def marker(ref: str, tool: str, chars: int) -> str:
    """The header that marks a summary as one (spec §2.3), exactly."""
    return (
        f"[summary of {tool} result {ref} ({chars:,} chars) — the full text is kept;\n"
        f'read it with read_result("{ref}", part=… or query=…)]'
    )


def summarized_content(summary: Summary) -> str:
    """What is sent in place of the result: the marker, then the summary."""
    return marker(summary.ref, summary.tool, summary.chars) + "\n" + summary.text


def apply(messages: Sequence[dict], summaries_by_call_id: Mapping[str, Summary]) -> list[dict]:
    """`messages` with each summarized role:tool content replaced by its marker
    and summary. Every other message is returned as the same object.

    Raises ValueError for a summary with no text: a result is never marked as
    a summary unless a summary was written."""
    for call_id, summary in summaries_by_call_id.items():
        if not summary.text.strip():
            raise ValueError(f"no summary written for {summary.ref} (call {call_id})")
    out: list[dict] = []
    for message in messages:
        summary = (
            summaries_by_call_id.get(message.get("tool_call_id"))
            if message.get("role") == "tool"
            else None
        )
        out.append(
            message if summary is None else {**message, "content": summarized_content(summary)}
        )
    return out


def _tool_names(messages: Sequence[dict]) -> dict[str, str]:
    names: dict[str, str] = {}
    for message in messages:
        if message.get("role") != "assistant":
            continue
        for call in message.get("tool_calls") or ():
            if not isinstance(call, dict):
                continue
            function = call.get("function") or {}
            if isinstance(call.get("id"), str) and isinstance(function.get("name"), str):
                names[call["id"]] = function["name"]
    return names


def candidates(
    messages: Sequence[dict],
    window: int,
    chars_per_token: float,
    kept_refs: Mapping[str, str],
    summarized: Mapping[str, Summary],
    overhead_chars: int = 0,
) -> list[str]:
    """The refs to summarize this round, oldest first.

    `kept_refs` maps a tool_call_id to its kept ref (T1); `summarized` maps a
    tool_call_id to the summary already written for it this turn (counted in
    place, never picked again). `overhead_chars` is the tools array the round
    sends (context_fit.tools_chars): counted beside the messages in both
    marks, as context_fit.fit counts it (verification-2-7 T23/T24)."""
    if window <= 0:
        raise ValueError(f"window must be positive, got {window!r}")
    if chars_per_token <= 0:
        raise ValueError(f"chars_per_token must be positive, got {chars_per_token!r}")
    if overhead_chars < 0:
        raise ValueError(f"overhead_chars must not be negative, got {overhead_chars!r}")
    budget = budget_for(window)
    start, stop = START_FRACTION * budget, STOP_FRACTION * budget

    current = apply(messages, summarized)
    chars, count = sum(_message_chars(m) for m in current), len(current)
    if _tokens(chars, count, chars_per_token, overhead_chars) < start:
        return []

    rounds = _rounds(messages)
    latest = set(range(rounds[-1][0], rounds[-1][1])) if rounds else set()
    names = _tool_names(messages)
    cap_chars = int(summary_max_tokens(window) * chars_per_token)

    picked: list[str] = []
    for index, message in enumerate(messages):
        if _tokens(chars, count, chars_per_token, overhead_chars) < stop:
            break
        if message.get("role") != "tool" or index in latest:
            continue
        call_id = message.get("tool_call_id")
        ref = kept_refs.get(call_id)
        content = message.get("content")
        if ref is None or call_id in summarized or not isinstance(content, str):
            continue
        tool = names.get(call_id, "tool")
        replaced = len(marker(ref, tool, len(content))) + 1 + cap_chars
        if replaced >= len(content):
            continue  # a summary at its cap would save nothing
        chars -= len(content) - replaced
        picked.append(ref)
    return picked
