"""Intra-turn overflow protection (docs/plans/turn-speed.md, phase 2).

This is OVERFLOW protection, not aggressive trimming, and the distinction is
the whole design. A long research turn grows its own prompt: every tool
result is replayed to the model on the next round, and the measured baseline
turn walked 17k → 32k tokens across fifteen rounds. Nothing bounds that
today — `context.budget_openrouter` (24k) only picks how much conversation
HISTORY to replay, and it is applied once, before the turn starts.

So the ceiling here sits WELL above observed peaks. Trimming engages only
where the alternative is a provider-side overflow (or, on ollama, a silent
truncation of the prompt HEAD — which eats the system prompt). Under the
ceiling this module does nothing at all, which is why the v1 idea of reusing
the 24k history budget was wrong: it would have trimmed the very turn it was
meant to protect.

Rails, each from the review:

* Trim by in-place content replacement ONLY, on messages with role=="tool"
  and string content. Never remove a message, never reorder: an assistant
  tool_calls entry whose tool response is missing is a provider 400 that
  kills the turn outright.
* Dispatch results are EXEMPT. The specialist's distilled report is usually
  the oldest large tool message by synthesis time, and it is the product of
  the entire turn — trimming it to make room starves the final answer.
* Raw web results go first, then everything else, oldest first.
* One pass down to ~70% of the ceiling (hysteresis). Trimming to exactly the
  ceiling would re-trim every round, and each trim invalidates whatever
  prefix cache the provider had.
"""

from __future__ import annotations

import logging
from typing import Iterable, Optional

log = logging.getLogger(__name__)

# chars per token: deliberately conservative (real English is ~4). Under-
# estimating is the dangerous direction — CJK and dense code run closer to 2,
# and an underestimate means no trim and then a silent truncation.
_CHARS_PER_TOKEN = 3

# what an image part costs. A base64 photo is ~250k characters, which the
# char heuristic would read as ~83k "tokens" and trim every attachment turn.
_IMAGE_TOKENS = 1000

# room left for the model's own reply under a real context window
_COMPLETION_HEADROOM = 4000

# stop trimming a message here — below this a result stops meaning anything
# and the model just re-runs the tool, which costs more than it saved
_MIN_KEPT_CHARS = 400

# trim down to this fraction of the ceiling, not to the ceiling itself
_TARGET_FRACTION = 0.7

# warn into the trace at this fraction, before anything is trimmed
_WARN_FRACTION = 0.8

# tools whose raw output is bulky and re-derivable — trimmed before anything
# else, since the model can always call them again
_BULK_TOOLS = ("web_search", "fetch_url")

_MARKER = "\n\n[… {n} characters trimmed to fit the context window. Call the tool again if you need the rest.]"


def estimate_tokens(messages: Iterable[dict]) -> int:
    """Conservative token estimate for a whole transcript."""
    return sum(_message_tokens(m) for m in messages)


def _message_tokens(message: dict) -> int:
    content = message.get("content")
    total = 4  # per-message role/format overhead
    if isinstance(content, str):
        total += len(content) // _CHARS_PER_TOKEN
    elif isinstance(content, list):
        # multimodal: only text parts are counted by length; image parts are
        # priced flat, never by their base64 size
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text":
                total += len(part.get("text") or "") // _CHARS_PER_TOKEN
            else:
                total += _IMAGE_TOKENS
    # tool_calls ride the assistant message and are real prompt tokens
    for call in message.get("tool_calls") or []:
        fn = call.get("function") or {}
        total += (len(fn.get("name") or "")
                  + len(fn.get("arguments") or "")) // _CHARS_PER_TOKEN
    return total


def model_context(model: str) -> Optional[int]:
    """The model's real context window, or None when we don't know it.

    Reads the models-catalog CACHE only — never a network call on the hot
    path. Unknown is the honest and common answer, and the caller falls back
    to the operator's budget setting.
    """
    # Local models: the server's configured window IS the real one, and
    # ollama's /api/tags does not report it. Without this the trimmer would
    # happily build a 40k prompt for a 16k local model, which the router
    # then refuses — trimming has to aim at the window the call must fit.
    if model.split(":", 1)[0] == "ollama":
        from app import local_context, settings_store
        # The window this model will ACTUALLY be given, when that has been
        # worked out. Dynamic sizing hands qwen3:14b 40,960 while the flat
        # setting says 16,384, and a trimmer aiming at the wrong one of those
        # either wastes most of the window or builds a prompt the server
        # truncates from the head. None before the first resolve, which lands
        # on the setting — the smaller, safer number.
        resolved = local_context.cached(model)
        if resolved:
            return resolved
        configured = int(settings_store.get("inference.ollama_num_ctx") or 0)
        return configured or None
    try:
        from app import models_catalog
        for entry in models_catalog._cache.get("models") or []:
            if entry.get("id") == model:
                ctx = entry.get("context_length")
                return int(ctx) if isinstance(ctx, int) and ctx > 0 else None
    except Exception:  # noqa: BLE001 — a metadata lookup must never break a turn
        log.debug("context length lookup failed for %s", model, exc_info=True)
    return None


def ceiling_for(model: str) -> int:
    """min(real context − completion headroom, the operator's budget).

    The budget setting is the always-present half; the real window only ever
    lowers it, so a 32k model is protected even though the setting says 60k.

    RESOLVED THROUGH `effective_model` FIRST, and that is not a detail. A
    cloud model whose provider is not configured is silently swapped for the
    local fallback before the call leaves — so the window that matters is the
    fallback's, not the one the agent row names. Measured 2026-07-27: a
    summariser sizing against `openrouter:z-ai/glm-5.2` computed 60,000
    tokens while the call actually went to `ollama:qwen2.5:3b` with 12,384
    usable, and the router then refused prompts this function had just
    declared safe. Everything downstream — catalogue bounds, paged reads,
    summary chunking — inherits that lie, because they all size against this
    number precisely so it agrees with the refusal.
    """
    from app import settings_store
    from app.llm import router as llm_router
    budget = int(settings_store.get("agents.intraturn_budget") or 60000)
    real = model_context(llm_router.effective_model(model))
    if real:
        return max(2000, min(budget, real - _COMPLETION_HEADROOM))
    return budget


def paginate(body: str, cap: int) -> list[str]:
    """Split content into parts that each fit `cap` characters.

    Lives here because it is the same question the rest of this module
    answers — what fits in a window — and it has two callers that must not
    drift apart: `read_memory_item`, which hands the model one part at a
    time, and the transcript summariser, which walks every part.

    The while-loop is not defensive padding. A fetched video transcript is
    routinely one unbroken paragraph of tens of thousands of characters, so
    a splitter that only breaks on blank lines returns one oversized part
    and quietly defeats the whole mechanism.
    """
    if len(body) <= cap:
        return [body]
    parts: list[str] = []
    current = ""
    for para in body.split("\n\n"):
        piece = para + "\n\n"
        if current and len(current) + len(piece) > cap:
            parts.append(current)
            current = ""
        while len(piece) > cap:
            parts.append(piece[:cap])
            piece = piece[cap:]
        current += piece
    if current.strip():
        parts.append(current)
    return parts or [body[:cap]]


def _trimmable(message: dict) -> bool:
    return message.get("role") == "tool" and isinstance(message.get("content"), str)


def _priority(message: dict, bulk_ids: set[str]) -> int:
    """0 = raw web result (trim first), 1 = everything else."""
    return 0 if message.get("tool_call_id") in bulk_ids else 1


def trim_transcript(messages: list[dict], *, model: str,
                    exempt_ids: Optional[set[str]] = None,
                    bulk_ids: Optional[set[str]] = None,
                    detail: Optional[dict] = None) -> dict:
    """Trim `messages` IN PLACE if it exceeds the ceiling. Returns a report.

    exempt_ids: tool_call_ids whose results must never be trimmed (dispatch
    results — the turn's actual product).
    bulk_ids: tool_call_ids of raw web results, trimmed before anything else.
    detail: a trace span detail dict to annotate.
    """
    exempt_ids = exempt_ids or set()
    bulk_ids = bulk_ids or set()
    ceiling = ceiling_for(model)
    before = estimate_tokens(messages)

    if detail is not None:
        detail["prompt_tokens_est"] = before
        detail["context_ceiling"] = ceiling
        if before >= ceiling * _WARN_FRACTION:
            # visible in the Turn Inspector BEFORE anything is trimmed, so a
            # turn that is quietly approaching the wall is legible
            detail["context_pressure"] = round(before / ceiling, 2)

    report = {"ceiling": ceiling, "before": before, "after": before,
              "trimmed_messages": 0, "freed_chars": 0}
    if before <= ceiling:
        return report

    target = int(ceiling * _TARGET_FRACTION)
    need = before - target

    candidates = [(i, m) for i, m in enumerate(messages)
                  if _trimmable(m) and m.get("tool_call_id") not in exempt_ids]
    # bulk web results first, then oldest-first inside each priority
    candidates.sort(key=lambda pair: (_priority(pair[1], bulk_ids), pair[0]))

    for _index, message in candidates:
        if need <= 0:
            break
        content = message["content"]
        if len(content) <= _MIN_KEPT_CHARS:
            continue
        # how many characters this message could give up at most
        droppable = len(content) - _MIN_KEPT_CHARS
        wanted = min(droppable, need * _CHARS_PER_TOKEN)
        keep = len(content) - wanted
        dropped = len(content) - keep
        message["content"] = content[:keep] + _MARKER.format(n=dropped)
        report["trimmed_messages"] += 1
        report["freed_chars"] += dropped
        need -= dropped // _CHARS_PER_TOKEN

    report["after"] = estimate_tokens(messages)
    if report["trimmed_messages"]:
        log.info("context trim: %d tokens -> %d (ceiling %d) by shortening "
                 "%d tool result(s)", before, report["after"], ceiling,
                 report["trimmed_messages"])
        if detail is not None:
            detail["context_trimmed"] = report["trimmed_messages"]
            detail["context_freed_chars"] = report["freed_chars"]
            detail["prompt_tokens_est_after"] = report["after"]
    elif need > 0:
        # everything left is exempt or already minimal — say so rather than
        # pretending the transcript fits
        log.warning("context trim: %d tokens still over the %d ceiling with "
                    "nothing left to trim (dispatch results are exempt)",
                    report["after"], ceiling)
        if detail is not None:
            detail["context_over_ceiling"] = True
    return report
