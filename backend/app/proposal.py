"""He asked her to BUILD something and she answered with a question.

2026-08-05 16:0x, measured live. Jeremy: "Set up a Home Assistant instance
for me." Nova wrote 168 words comparing where it could run, ended with
"Which way do you want to go?", and called NOTHING — `tools_called: 0`,
holding `propose_goal`, with the goal machinery live and a real cluster
behind it.

Her own prompt already tells her exactly what to do here:

    "When the operator asks for something you cannot do yet — a new
     integration, a service to manage, a workflow that needs tools you do not
     have — do not answer with what you are not allowed to do. Work out what
     would be needed, then call propose_goal with a finish line they can
     check and the verbs it needs. One approval covers the whole build, so
     ask once for the goal instead of once per step."

She read that sentence and asked a question anyway. That is the evidence
pattern this codebase is built on — a good sentence is not a control — and
it is the third time this week the same class has appeared (runner.py:494,
the claimed restriction; deferral.py, the unnecessary permission request).

SIXTH MEMBER OF THE GUARD FAMILY, and the second whose consequence is a
forced round rather than an appended note. Nothing false was said: the
options she laid out were accurate and her diagnosis of the k8s LAN problem
was correct. There is only a turn that must not end as a menu.

WHAT THIS IS NOT. It does not object to her asking. A build with a genuine
fork in it SHOULD surface the fork — Jeremy's own framing was "even if it
requires her getting clarification on location". What it refuses is asking
INSTEAD OF starting: the plan and the question belong in the same turn, and
`propose_goal` is how the plan gets recorded.

TWO SIDES, DELIBERATELY. `deferral` reads only her draft, because an offer
to look is self-evidently an offer to look. A build request is not visible
in her reply at all — "which way do you want to go?" is shapeless without
the question that provoked it. So this reads the OPERATOR'S text for the
request and HER text for the non-answer, and both have to hold.
"""

from __future__ import annotations

import re
from typing import Iterable, Optional

from app import narration

# How many trailing clauses count as "how the round ended".
_TAIL = 3

# THE REQUEST, in his words. An imperative aimed at standing something up.
#
# `create`/`add` are here but heavily qualified: bare `create` matches "create
# a note", "add a tag", half of what she does all day. The object has to look
# like a THING THAT RUNS, so the verb is paired with an article and a noun
# rather than trusted alone.
_BUILD_REQUEST = re.compile(
    r"\b(?:set\s+up|stand\s+up|spin\s+up|deploy|install|provision|"
    # 1-3 words for the object, not one: "get a mqtt broker running" is two,
    # and the single-word version missed every real service name.
    r"get\s+(?:me\s+)?(?:an?\s+)?(?:[\w-]+\s+){1,3}(?:running|going|working|up)|"
    r"build\s+(?:me\s+)?(?:an?|the)\b|"
    r"create\s+(?:me\s+)?(?:an?|the)\s+(?:\w+\s+){0,2}"
    r"(?:server|service|instance|container|cluster|database|db|stack|"
    r"deployment|bot|agent|integration|pipeline|workload|node|proxy|"
    r"gateway|broker|dashboard))\b", re.IGNORECASE)

# ...and the things that wear a build verb without being one. Checked BEFORE
# the request pattern, because "set up a time to talk" is a real sentence and
# forcing a goal proposal at it would be absurd.
#
# `install` has no exclusion and needs none: nobody installs a meeting.
_NOT_A_BUILD = re.compile(
    r"\bset\s+up\s+(?:a\s+)?(?:time|call|meeting|reminder|chat|catch[- ]up)\b|"
    r"\bset\s+up\s+(?:a\s+)?(?:rule|automation|schedule|note|tag|topic)\b|"
    r"\b(?:how|what|why|when|where)\s+(?:do|does|would|should|could|can)\s+I\b|"
    r"\bwhat\s+would\s+it\s+take\b|\bcan\s+you\s+explain\b|"
    r"\bwalk\s+me\s+through\b|\bwhat\s+are\s+my\s+options\b",
    re.IGNORECASE)

# HER NON-ANSWER: the round ends by putting the decision back on him.
#
# A question mark is necessary and nowhere near sufficient — she asks
# rhetorical and clarifying questions inside good answers constantly. It has
# to be the LAST thing, and it has to be addressed to him.
_ASKS_HIM = re.compile(
    r"\b(?:which|what|where|how)\s+(?:way|one|option|of\s+these|would\s+you|"
    r"do\s+you)\b|\bwould\s+you\s+(?:like|prefer|rather)\b|"
    r"\bdo\s+you\s+want\b|\byour\s+call\b|\bup\s+to\s+you\b|"
    r"\blet\s+me\s+know\s+(?:which|what|how|if\s+you)\b|"
    r"\btell\s+me\s+(?:which|what|where)\b|\bwhich\s+would\s+you\b",
    re.IGNORECASE)

# The verb that records the plan. Not a set — there is exactly one, and if it
# is ever renamed this module should fail loudly rather than silently stop.
PROPOSE = "propose_goal"


def unproposed_build(query: str, round_text: str, tool_calls_made: int,
                     already_called: Iterable[str] = ()) -> Optional[str]:
    """The question she ended on, when the ask was to build something.

    Pure, no I/O. None on: any tool called this round, `propose_goal` already
    called this TURN, no build request in his message, an excluded phrasing,
    or a round that did not end by handing the decision back.

    `already_called` is turn-scoped on purpose and is the main veto: a turn
    that proposed the goal and THEN asked which way to go is doing exactly
    the right thing, and this must never fire on it.
    """
    if tool_calls_made:
        return None
    if PROPOSE in {str(n) for n in already_called}:
        return None
    if not query or not round_text:
        return None
    if _NOT_A_BUILD.search(query):
        return None
    if not _BUILD_REQUEST.search(query):
        return None
    cl = [body for body, _end in narration.clauses(round_text)]
    if not cl:
        return None
    tail = cl[-_TAIL:]
    # The question has to be how it ENDS. A menu offered mid-reply and then
    # resolved ("...or k8s. I've proposed the goal for the compose route.")
    # is a plan with a note, not a punt.
    if not any(_ASKS_HIM.search(c) for c in tail[-2:]):
        return None
    return " ".join(tail).strip()


def can_propose(granted: Iterable[str]) -> bool:
    """Is the verb that records a plan actually on the table this turn?

    Separate from the detector for the reason the whole family separates
    them: the vocabulary above is enumerated, the permission is not. A turn
    that cannot propose a goal must never be told to.
    """
    return PROPOSE in {str(n) for n in granted or ()}
