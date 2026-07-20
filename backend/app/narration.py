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
are deliberately NOT matched — asking permission is correct behavior.

Past-tense COMPLETION claims are matched too (added 2026-07-17): glm-5.2
answered "Done — saved it with no tags" two seconds after the request with
zero tool calls and nothing written — fabrication that slips any
future-tense wording check. The zero-tool-calls gate is what makes past
tense safe to match at all: a completion claim in a turn that ran no tools
cannot be true of THIS turn. Honest recaps of earlier work stay unmatched
via per-sentence past-time markers ("I created that yesterday").
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

# Completion claims — checked per sentence so a sentence carrying its own
# past-time reference can be exempted as an honest recap. The subjectless
# form ("saved it") matches only clause-INITIAL (sentence start or after a
# dash/colon, the "Done — saved it" shape) so third-party subjects ("the
# digest updated it") and possessives ("it's own") never match.
_COMPLETION_PATTERNS = [
    r"\b(?:I['’]ve|I have|I) (?:just |now )?(?:saved|created|added|updated|"
    r"deleted|removed|scheduled|wrote|written|built|set (?:it |that |this )?up)\b",
    r"(?:^\s*|[—–:;-]\s*)(?:saved|created|added|updated|deleted|scheduled|"
    r"logged|noted)\s+(?:it|that|this|them|one)\b(?!['’])",
    r"\b(?:it|that|this)['’]s (?:been )?(?:saved|created|added|updated|"
    r"deleted|scheduled)\b",
    r"\b(?:done|all set)\s*[—–-]\s*(?:saved|created|added|updated|deleted|"
    r"scheduled|built|wrote)\b",
]
_COMPLETION_COMPILED = [re.compile(p, re.IGNORECASE) for p in _COMPLETION_PATTERNS]

# a sentence with its own past-time reference reads as a recap, not a claim
# about this turn — skip it (precision over recall, as everywhere here)
_RECAP_MARKERS = re.compile(
    r"\byesterday\b|\bearlier\b|\blast (?:night|time|week|month)\b|"
    r"\bpreviously\b|\bthe other day\b|\balready\b|\bbefore\b|"
    r"\bback (?:then|when)\b", re.IGNORECASE)

_SENTENCES = re.compile(r"[.!?\n]+")


def detect(final_text: str, tool_calls_made: int) -> str | None:
    """The matched phrase when the text announces or claims action while no
    tool ran this turn; None otherwise. tool_calls_made is the runner's
    ground truth — with any real call this turn, nothing is flagged."""
    if tool_calls_made or not final_text:
        return None
    for pat in _COMPILED:
        m = pat.search(final_text)
        if m:
            return m.group(0)
    for sentence in _SENTENCES.split(final_text):
        if _RECAP_MARKERS.search(sentence):
            continue
        for pat in _COMPLETION_COMPILED:
            m = pat.search(sentence)
            if m:
                return m.group(0)
    return None
