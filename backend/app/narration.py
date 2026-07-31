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
    # announcing RETRIEVAL work (2026-07-31). Every verb above mutates, and
    # the six replies that produced the ARIA Labs incident used none of them:
    # check, search, look up, confirm, fetch. A read that never happened is
    # the same silent failure as a write that never happened — the operator
    # sat for five minutes waiting on a search that was never running.
    r"\bI['’](?:ll|m going to|m about to) (?:check|search|look up|look into|"
    r"find|fetch|confirm|verify|browse|query|propose|see if)\b",
    r"\bI['’]m (?:checking|searching|looking (?:up|into)|fetching|verifying|"
    r"confirming|querying)\b",
    r"\blet me (?:check|search|look up|look into|find|fetch|confirm|verify|"
    r"see if|propose)\b",
    # the bare sign-offs. These carry no verb at all — they are pure promise,
    # and they closed four of the six replies. "One moment" in a turn that
    # ran nothing is a statement about work in flight, and there is none.
    r"\blet me do (?:that|it|this)\b",
    r"\bone moment\b",
    r"\b(?:give me|just) a (?:sec|second|moment)\b",
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
    # `dispatched` belongs here for the same reason the rest do: the future
    # tense list above catches "I'll dispatch the tool-creator", but a model
    # that says "I dispatched the tool-creator and it is building it now" is
    # making the identical claim about work that equally never happened —
    # the 2026-07-14 incident, told after the fact instead of before it.
    r"\b(?:I['’]ve|I have|I) (?:just |now )?(?:saved|created|added|updated|"
    r"deleted|removed|scheduled|wrote|written|built|dispatched|"
    r"set (?:it |that |this )?up)\b",
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

# A sentence that is hypothesising, not reporting. "If I dispatched the
# agent, it would take a few minutes" describes a road not taken, and
# accusing her of fabricating it is exactly the false positive that teaches
# an operator to ignore the banner. This guard only became necessary WITH
# past-tense dispatch matching: no conditional can contain "I'll dispatch",
# so the future-tense patterns never collided with one.
_CONDITIONAL_MARKERS = re.compile(
    r"\bif\b|\bunless\b|\bwhether\b|\bin case\b|\bwould have\b", re.IGNORECASE)

# POSITION IS THE WHOLE SIGNAL, and ignoring it is what let the ARIA Labs
# turns through. A bare `\bif\b` anywhere in the sentence exempted it, so
# "I'll check IF I have access to GitHub" — a promise with a subordinate
# clause — was read as a hypothetical and never examined. The distinction is
# purely positional:
#
#   "If I dispatched the agent, it would take minutes"  -> if BEFORE the verb
#   "I'll check if I have access"                       -> if AFTER the verb
#
# Only the first is hypothesising. So the guard now applies when the marker
# PRECEDES the match, and the two live replies that opened the incident are
# the two that a whole-sentence guard missed.
#
# An offer is different again and stays exempt wherever it sits: "I'll check
# that if you'd like" is asking, and asking is correct behaviour. It has to
# be its own list rather than a position rule, because the offer trails the
# verb in exactly the way a real promise does.
_OFFER_MARKERS = re.compile(
    r"\bif you(?:'d| would)? (?:like|want|prefer)\b|\bif you want\b|"
    r"\bwant me to\b|\bwould you like\b|\bshall I\b|\blet me know if\b|"
    r"\bif that (?:helps|works)\b", re.IGNORECASE)


def _exempt(body: str, match) -> bool:
    """True when this sentence's match is hypothetical or an offer."""
    if _OFFER_MARKERS.search(body):
        return True
    cond = _CONDITIONAL_MARKERS.search(body)
    return bool(cond and cond.start() < match.start())

_SENTENCES = re.compile(r"[.!?\n]+")
# Same split, but KEEPING the terminator. "?" is the entire signal for "that
# was a question, not a claim", and the plain split above throws it away.
_SENTENCES_KEEP = re.compile(r"([.!?\n]+)")


def _clauses(text: str):
    """(sentence, terminator) pairs, blank sentences dropped."""
    parts = _SENTENCES_KEEP.split(text)
    for i in range(0, len(parts), 2):
        body = parts[i]
        end = parts[i + 1] if i + 1 < len(parts) else ""
        if body.strip():
            yield body, end


def detect(final_text: str, tool_calls_made: int) -> str | None:
    """The matched phrase when the text announces or claims action while no
    tool ran this turn; None otherwise. tool_calls_made is the runner's
    ground truth — with any real call this turn, nothing is flagged."""
    if tool_calls_made or not final_text:
        return None
    # The future-tense arm is per-sentence for the same reason the completion
    # arm always was. It used to scan the WHOLE reply, so one offer to help
    # anywhere in it — "would you rather I dispatch to agent-creator now with a
    # sketch?" — flagged the turn, wrote a journal line asserting the work did
    # not happen, and (since the correction is now appended to the reply and
    # read aloud) contradicted an answer that was correct. The module's own
    # docstring has always said questions must not be matched; only the
    # completion arm actually honoured it.
    for body, end in _clauses(final_text):
        if "?" in end:
            continue
        for pat in _COMPILED:
            m = pat.search(body)
            if m and not _exempt(body, m):
                return m.group(0)
    for sentence in _SENTENCES.split(final_text):
        if _RECAP_MARKERS.search(sentence):
            continue
        for pat in _COMPLETION_COMPILED:
            m = pat.search(sentence)
            if m and not _exempt(sentence, m):
                return m.group(0)
    return None
