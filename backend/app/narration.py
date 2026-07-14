"""Narration detector — flags turns that ANNOUNCE agentic actions while
calling zero tools.

The failure class (seen live twice on 2026-07-14): an agent streams "I'll
dispatch the tool-creator… I'll wait for it to confirm" and ends its turn
without any tool call — the described work silently never happens. The
runner knows both facts with certainty at end of turn: the final text, and
how many tools it actually executed. This module is the pattern check over
the first, gated on the second being zero.

Heuristic by design: the goal is turning a silent failure into a visible
one, not perfection. Questions and conditionals ("want me to create…?")
are deliberately NOT matched — asking permission is correct behavior. Plain
past-tense recaps ("I created that yesterday") are also not matched to
avoid flagging honest summaries of earlier turns.
"""

import re

_PATTERNS = [
    # announcing a dispatch
    r"\bI['’]ll dispatch\b",
    r"\b(?:let me|going to|about to) dispatch\b",
    r"\bdispatching (?:this |it |that )?to\b",
    r"\bdispatch to [\w-]+\s*:",
    # announcing create/change work
    r"\bI['’](?:ll|m going to|m about to) (?:create|build|add|update|delete|write|schedule|pull|set up)\b",
    r"\blet me (?:create|build|schedule|set up)\b",
    # claiming just-completed work
    r"\bI['’]ve just (?:created|built|updated|deleted|scheduled|dispatched|set up)\b",
    r"\bis now (?:created|live|built|scheduled|in place)\b",
    # the tell-tale sign-off from both live incidents
    r"\bwait(?:ing)? for (?:the )?[\w-]+(?:[- ]agent)? to (?:confirm|finish|complete|respond|build)\b",
]
_COMPILED = [re.compile(p, re.IGNORECASE) for p in _PATTERNS]


def detect(final_text: str, tool_calls_made: int) -> str | None:
    """The matched phrase when the text announces action but no tool ran
    this turn; None otherwise."""
    if tool_calls_made or not final_text:
        return None
    for pat in _COMPILED:
        m = pat.search(final_text)
        if m:
            return m.group(0)
    return None
