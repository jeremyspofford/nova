"""She offered to look something up that nothing was stopping her from doing.

2026-08-05 14:09, turn 9991f720-9f1c-43ac-bd35-98810dffc77f. Asked "Is
ossinsight usable now. And what is it", main (openrouter:z-ai/glm-5.2)
answered from knowledge and closed with "I can check whether it's reachable
from my side. Want me to try?" — holding fetch_url and web_search, past every
gate, with a 20.9 KB toolset. Three spans, ONE llm_call, tool_calls_requested:
0. No gate fired, because no gate applies to a read. The operator had to say
"yes" and wait a second turn for an answer the first turn could have given.

Fifth member of the guard family, and the first whose consequence is a FORCED
ROUND rather than an appended note: nothing false was said, so there is
nothing to contradict — there is only a turn that must not end yet.

The failure class has been named here before and only ever answered with a
prompt. runner.py:494 records 2026-07-28, when she described two permission
gates — agent creation, tool creation — that did not exist: "Not a claimed
capability, a claimed RESTRICTION, which nothing in the codebase was
checking." An unnecessary permission request is that same claim, made by
implication. This is the mechanical half.

WINDOW, NOT CLAUSE — measured before this file was written. The offer and its
evidence live in different sentences:

    "...I can check whether it's reachable from my side." | "Want me to try?"

narration and capability_claims are clause-scoped for good reasons that do
NOT transfer: there the subject and the claim are one sentence. Here the offer
TRAILS its antecedent, which narration.py:170-173 already says out loud. A
clause-scoped conjunction finds "Want me to try?" with no retrieval verb
beside it, and never fires on the incident it was written for. The splitter
also cuts "ossinsight.io" in half on the dot.

So the unit is the TAIL of the round: the offer clause plus the two before it.
Wider than that and a verb from the top of a long reply pairs with an
unrelated offer at the bottom.

WHAT THIS MODULE DOES NOT DECIDE. It reports that a retrieval offer was made
and what it was about. Whether any tool could serve it — and whether that tool
would actually run right now — is `registry.unattended_tools`, derived from
the live grant/containment/goal/rule gates. The vocabulary here is enumerated;
the permission is not. That split is the point: a phrase list that grew a
security consequence would be the hardcoding CLAUDE.md warns about.
"""

from __future__ import annotations

import re
from typing import Iterable, Optional

from app import narration

# Clauses of context around the offer. Three covers the incident.
_WINDOW = 3
# The offer must be how the round ENDS. An offer made mid-reply and then
# answered ("Want me to check? I did — it's up") is not a deferral.
_OFFER_TAIL = 2

_RETRIEVAL = re.compile(
    r"\b(?:check|checking|look(?:ing)?\s+(?:up|at|into)|look\s+it\s+up|"
    r"search|see\s+(?:if|whether|what)|find\s+out|verify|confirm|read|"
    r"fetch|pull\s+up|test|ping|inspect|diagnose|query|try)\b", re.IGNORECASE)

# ONE mutation verb anywhere in the window vetoes the whole thing, before any
# derivation runs. This is what keeps every legitimate consent request out,
# and it is deliberately independent of `reads_only` so a satisfier that
# happens to match cannot override it. Asking before you write is correct
# behaviour and this module must never make her stop doing it.
#
# `pull` and `follow` were considered and CUT: they veto "pull up the logs"
# and "following up on that", while pull_model / follow_source are already
# excluded twice by the derivation (no reads_only; pull_model is goal-scoped).
# A veto that costs a legitimate catch and buys nothing is worse than no veto.
_MUTATION = re.compile(
    r"\b(?:creat\w*|add|adding|delet\w*|remov\w*|chang\w*|updat\w*|writ\w*|"
    r"sav\w*|remember|schedul\w*|install\w*|deploy\w*|register\w*|grant\w*|"
    r"approv\w*|enabl\w*|disabl\w*|restart\w*|merge|ingest\w*|dismiss\w*|"
    r"retry|re-?queue\w*|unfollow\w*|notif\w*|email\w*|send|post|"
    r"set\s+up|turn\s+(?:on|off))\b", re.IGNORECASE)

# What a retrieval offer SOUNDS like, paired with the tool-name TOKENS that
# could serve it. TOKENS, not substrings, for the reason capability_claims.py
# records: `file` as a substring let `github-profile-fetch` satisfy a claim to
# read the operator's files.
#
# No `schedul|automat` row: `schedul\w*` is in the mutation veto and has to
# stay there, or "Want me to schedule that nightly?" fires at
# manage_automations (which IS in the unattended set, via scopes.READ_ACTIONS).
# The cost is that "want me to check what's scheduled?" is a KNOWN MISS. That
# is precision over recall — the trade every module in this family makes.
_SATISFIERS: list[tuple[re.Pattern, frozenset[str]]] = [
    # `up` is STATUS-SHAPED, not bare. A plain `\bup\b` matched "look it up"
    # and "look up that page", so a documentation offer was answered by this
    # row instead of the next one — caught only once the MCP case was tested
    # against a real server name.
    (re.compile(r"reach\w*|respond\w*|online|\b(?:is|are|still|back)\s+up\b|"
                r"\bup\s+and\s+running\b|\bdown\b|status|health|"
                r"working|loads?|available|accessible|live", re.I),
     frozenset({"fetch", "url", "web", "search", "http", "diagnose",
                "service", "status"})),
    # `docs`, `doc`, `page`, `query` and `read` are here for the MCP case and
    # were missing until it was tested against a REAL registered server: the
    # only documentation tool on this box is `mcp:context7/query-docs`, whose
    # name tokens are {mcp, context7, query, docs}, and none of the six
    # web-shaped tokens below reach it. A satisfier list that only knows the
    # builtins is a list that stops working the moment the capability lands —
    # which is the failure the derivation exists to prevent, reappearing one
    # layer up.
    (re.compile(r"look\w*\s+up|search|google|online|latest|news|what\s+is|"
                r"who\s+is|docs?|page|site|readme|repo", re.I),
     frozenset({"search", "web", "fetch", "url", "browse", "find",
                "docs", "doc", "page", "query", "read"})),
    # `memory` is deliberately NOT a token here — narration.py:107-110 records
    # the collision: write_memory and search_memory share the noun, and a
    # shared noun is not a shared verb. `remember` is excluded from the
    # pattern for the same reason (it lives in the mutation veto).
    (re.compile(r"recall\w*|noted|stored|my\s+notes|what\s+(?:you|I)\s+told",
                re.I),
     frozenset({"search", "read", "list", "recall", "get"})),
    (re.compile(r"weather|forecast|temperature", re.I),
     frozenset({"weather", "forecast"})),
    (re.compile(r"failing|broken|error\w*|logs?|why.{0,20}not\s+work", re.I),
     frozenset({"diagnose", "logs", "status", "service", "failures"})),
    # No `installed\s+model` alternative: it was here, and it was DEAD TEXT.
    # `install\w*` is in the mutation veto, which runs over the whole window
    # in `offer()` before any satisfier is consulted — so "I can check which
    # models are installed. Want me to look?" returns None at the veto and
    # never reaches this row. Measured in the live container: that sentence
    # gives None, while "I can check which model you're on" — same row, no
    # 'installed' — fires normally.
    #
    # Removed rather than rescued. Narrowing the veto to spare this one
    # phrasing was tried on paper and reopens real mutation offers ("want me
    # to search for and install that MCP server?" would match the docs row and
    # be told nothing was stopping her, against an offer whose object is a
    # write). deferral's veto is deliberately independent of `reads_only`;
    # narrowing it to buy one catch inverts that. So `installed` joins
    # `schedul|automat` as a KNOWN MISS, recorded here rather than left as
    # text that looks like it works.
    (re.compile(r"which\s+model|models?\s+(?:do|are)", re.I),
     frozenset({"models", "recommend"})),
]


def offer(round_text: str, tool_calls_made: int) -> Optional[str]:
    """The tail window in which she offered to look instead of looking.

    Pure, no I/O — two regex passes over a few hundred characters, so it runs
    before anything touches the database.

    ROUND-SCOPED ON BOTH SIDES: reads `round_text`, gated on the ROUND's call
    count. Commit 12c5511 exists because a guard read the CUMULATIVE turn text
    while gating on a round-scoped counter, and told her she had done nothing
    on a turn where four tools ran.

    None on: any tool called this round, no offer marker in the last
    _OFFER_TAIL clauses, no retrieval verb in the window, or ANY mutation verb
    in the window.
    """
    if tool_calls_made:
        return None
    if not round_text:
        return None
    cl = [body for body, _end in narration.clauses(round_text)]
    if not cl:
        return None
    if not any(narration.is_offer(c) for c in cl[-_OFFER_TAIL:]):
        return None
    window = " ".join(cl[-_WINDOW:])
    if _MUTATION.search(window):
        return None
    if not _RETRIEVAL.search(window):
        return None
    return window.strip()


def satisfied(window: str, unattended: dict[str, set[str]],
              already_called: Iterable[str] = ()) -> list[str]:
    """Which tools she may run unasked would have settled that offer.

    Empty list = do not fire. FAILS CLOSED on an unrecognised subject: the
    cost of a wrong fire is a discarded good answer and a wasted round, so the
    bias is the family's bias — never contradict her on a guess.

    `already_called` subtracts tools she ran THIS TURN, so "I checked the
    site, it's up — want me to pull the star history too?" reads as an offer
    to do MORE, not an offer INSTEAD OF. Same discriminator as
    narration._could_have_done, and the same failure it was added for.

    UNION ACROSS EVERY MATCHING ROW, not the first one that hits. First-match
    ordering made the answer depend on which subject pattern happened to be
    listed earlier, and it silently picked the wrong row the first time this
    was run against a real MCP tool name. Every candidate is read-only by
    construction — `unattended` is the derived set — so a slightly wider list
    costs nothing: the correction names them and the model picks.
    """
    done = {str(n) for n in already_called}
    tokens: set[str] = set()
    for pat, row in _SATISFIERS:
        if pat.search(window):
            tokens |= row
    if not tokens:
        return []
    return sorted(n for n, name_tokens in unattended.items()
                  if n not in done and (tokens & name_tokens))
