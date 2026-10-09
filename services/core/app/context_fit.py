"""Fit a round's messages to the window the model is actually served with.

A local model handed more than its window does not refuse: ollama cuts the
FRONT of the prompt, so her instructions and his question go first and she
answers whatever is left (turn 0f7af448 described a /usr/bin listing). This
module is the line of code that keeps that from happening: it estimates the
request, then trims oldest tool-result content (to a stated note), then drops
oldest whole tool rounds (an assistant's tool_calls together with every
role:tool answer to them), and never touches a system message or the latest
user message. Pure: no I/O, the input is never mutated.

Linear in the total size of the request: one pass to measure, one to decide
which rounds go, one to trim and build. It runs every round in core's loop.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

# The share of the window kept free for the reply: the request is fitted to
# window * (1 - REPLY_RESERVE_FRACTION). A fraction of the window, never a
# table of model sizes.
REPLY_RESERVE_FRACTION = 0.125

# Characters per token before any round has calibrated it from the gateway's
# own prompt_tokens.
DEFAULT_CHARS_PER_TOKEN = 3.5

# Tokens each message costs beyond its text (role and chat-template framing).
MESSAGE_OVERHEAD_TOKENS = 4


@dataclass(frozen=True)
class FitReport:
    """What fit() did, stated: the numbers T4 copies onto the llm_call span."""

    window: int
    budget: int
    est_tokens: int
    fits: bool
    unfittable: bool
    tool_results_trimmed: int
    rounds_dropped: int
    chars_removed: int


def budget_for(window: int) -> int:
    """The token budget a request is fitted to: the window less the reply reserve."""
    return int(window * (1 - REPLY_RESERVE_FRACTION))


def _content_chars(content: object) -> int:
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        # Content parts: text counts; an image part is not text (its data URL
        # length says nothing about what the model is charged for it).
        total = 0
        for part in content:
            if isinstance(part, str):
                total += len(part)
            elif isinstance(part, dict) and isinstance(part.get("text"), str):
                total += len(part["text"])
        return total
    return 0


def _message_chars(message: dict) -> int:
    chars = _content_chars(message.get("content"))
    for call in message.get("tool_calls") or ():
        function = (call.get("function") if isinstance(call, dict) else None) or {}
        for key in ("name", "arguments"):
            value = function.get(key)
            if isinstance(value, str):
                chars += len(value)
    return chars


def _tokens(chars: int, count: int, chars_per_token: float) -> int:
    return math.ceil(chars / chars_per_token) + MESSAGE_OVERHEAD_TOKENS * count


def chars_of(messages: Sequence[dict]) -> int:
    """The chars of `messages` exactly as estimate_tokens counts them — what a
    caller divides by a measured prompt_tokens to calibrate the ratio."""
    return sum(_message_chars(m) for m in messages)


def calibrated_chars_per_token(messages: Sequence[dict], prompt_tokens: int) -> float | None:
    """The chars-per-token `messages` actually cost, from the gateway's own
    prompt_tokens for them: the inverse of estimate_tokens (per-message
    overhead taken off first). None when the count cannot say (no text, or
    tokens no more than the overhead)."""
    chars = chars_of(messages)
    text_tokens = prompt_tokens - MESSAGE_OVERHEAD_TOKENS * len(messages)
    if chars <= 0 or text_tokens <= 0:
        return None
    return chars / text_tokens


def estimate_tokens(messages: Sequence[dict], chars_per_token: float) -> int:
    """The estimated prompt tokens of `messages` at `chars_per_token`."""
    if chars_per_token <= 0:
        raise ValueError(f"chars_per_token must be positive, got {chars_per_token!r}")
    return _tokens(sum(_message_chars(m) for m in messages), len(messages), chars_per_token)


def _note(removed: int, window: int) -> str:
    return f"[trimmed {removed} chars to fit a {window}-token context window]"


def _trimmed(content: str, needed: int, window: int) -> tuple[str, int] | None:
    """`content` cut from its tail by enough to save `needed` chars net of the
    note, or as much as it can give; None when trimming would not save any.
    Returns the new content and the chars removed."""
    length = len(content)
    removed = needed
    for _ in range(4):  # the note's own length moves with its digit count
        removed = needed + 1 + len(_note(removed, window))
    if removed < length:
        return content[: length - removed] + "\n" + _note(removed, window), removed
    note = _note(length, window)
    if len(note) >= length:
        return None
    return note, length


def _rounds(messages: Sequence[dict]) -> list[tuple[int, int]]:
    """(start, end) of each tool round: an assistant message with tool_calls
    and the role:tool messages answering it that follow."""
    rounds: list[tuple[int, int]] = []
    index = 0
    while index < len(messages):
        message = messages[index]
        if message.get("role") == "assistant" and message.get("tool_calls"):
            end = index + 1
            while end < len(messages) and messages[end].get("role") == "tool":
                end += 1
            rounds.append((index, end))
            index = end
        else:
            index += 1
    return rounds


def _min_content_chars(content: object, window: int) -> int:
    """The fewest chars a tool result can be trimmed to."""
    if not isinstance(content, str):
        return _content_chars(content)
    note = len(_note(len(content), window))
    return note if note < len(content) else len(content)


def fit(
    messages: Sequence[dict], window: int, chars_per_token: float
) -> tuple[list[dict], FitReport]:
    """`messages` fitted to `window`, and the report of what was removed.

    Messages fit() leaves alone are returned as the same objects; one it
    trims is a new dict. The input list and its dicts are never mutated."""
    budget = budget_for(window)
    sizes = [_message_chars(m) for m in messages]
    chars, count = sum(sizes), len(messages)

    def report(fitted: list[dict], *, unfittable: bool, trimmed: int, dropped: int, removed: int):
        est = estimate_tokens(fitted, chars_per_token)
        return fitted, FitReport(
            window=window,
            budget=budget,
            est_tokens=est,
            fits=est <= budget,
            unfittable=unfittable,
            tool_results_trimmed=trimmed,
            rounds_dropped=dropped,
            chars_removed=removed,
        )

    if _tokens(chars, count, chars_per_token) <= budget:
        return report(list(messages), unfittable=False, trimmed=0, dropped=0, removed=0)

    users = [i for i, m in enumerate(messages) if m.get("role") == "user"]
    last_user = users[-1] if users else -1
    kept_idx = [i for i, m in enumerate(messages) if m.get("role") == "system" or i == last_user]
    if _tokens(sum(sizes[i] for i in kept_idx), len(kept_idx), chars_per_token) > budget:
        return report(list(messages), unfittable=True, trimmed=0, dropped=0, removed=0)

    def allowed(n: int) -> int:
        return math.floor((budget - MESSAGE_OVERHEAD_TOKENS * n) * chars_per_token)

    rounds = _rounds(messages)
    full = [sum(sizes[s:e]) for s, e in rounds]
    least = [
        sizes[s]
        + sum(_min_content_chars(messages[i].get("content"), window) for i in range(s + 1, e))
        for s, e in rounds
    ]

    # Drop the oldest whole rounds only while trimming every result left
    # could still not bring the request inside the budget.
    floor_chars = chars - sum(full) + sum(least)
    dropped = 0
    while dropped < len(rounds) and floor_chars > allowed(count):
        start, end = rounds[dropped]
        chars -= full[dropped]
        floor_chars -= least[dropped]
        count -= end - start
        dropped += 1
    gone = {i for start, end in rounds[:dropped] for i in range(start, end)}

    # Then trim the oldest surviving results first, each by no more than needed.
    replaced: dict[int, dict] = {}
    over = chars - allowed(count)
    trimmed = removed = 0
    for start, end in rounds[dropped:]:
        if over <= 0:
            break
        for i in range(start + 1, end):
            if over <= 0:
                break
            content = messages[i].get("content")
            if not isinstance(content, str):
                continue
            cut = _trimmed(content, over, window)
            if cut is None:
                continue
            new_content, cut_chars = cut
            over -= len(content) - len(new_content)
            replaced[i] = {**messages[i], "content": new_content}
            trimmed += 1
            removed += cut_chars

    fitted = [replaced.get(i, m) for i, m in enumerate(messages) if i not in gone]
    return report(fitted, unfittable=False, trimmed=trimmed, dropped=dropped, removed=removed)
