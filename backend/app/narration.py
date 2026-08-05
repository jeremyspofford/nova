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

# WHAT WOULD HAVE DONE IT — the tool-name TOKENS that could make each claim
# true, borrowed wholesale from capability_claims.py because it is the same
# problem one step later: that module asks whether a granted tool could
# provide a claimed ability, this asks whether a CALLED tool could have
# performed a claimed action.
#
# Measured 2026-08-03: asked to schedule a poll of her followed channels,
# main called search_memory and list_memory, never called manage_automations,
# and said "I've created the automation". detect() returned None, because it
# gave up the moment any tool ran — and searching memory cannot have created
# an automation. Reading is not doing.
#
# TOKENS, not substrings, for the reason capability_claims records: matching
# `create` as a substring would let `list_capability_changes` satisfy a claim
# to have created something. Tool names are split on non-alphanumerics and
# matched whole, so granting or renaming a tool changes the answer with no
# edit here.
_COMPLETION_TOKENS: list[tuple[str, set[str]]] = [
    (r"schedul|automat", {"manage_automations", "automations", "automation",
                          "schedule", "cron"}),
    (r"delet|remov", {"delete", "remove", "manage_agents", "manage_tools",
                      "manage_rules", "prune", "forget"}),
    (r"dispatch|deleg", {"dispatch", "delegate", "dispatch_to_agent"}),
    # `memory` is deliberately NOT a token here. It let search_memory satisfy
    # a claim to have SAVED something — reading a store and writing to it
    # share the noun, and the shared noun is not the verb. Caught by the test
    # below on the first run, and it is the same collision capability_claims
    # records for `github-profile-fetch` satisfying `file`.
    (r"sav|wrote|written|not(?:ed|ing)|record", {"write", "write_memory",
                                                 "save", "append"}),
    (r"creat|add|updat|built|build|set up", {"write", "write_memory", "manage",
                                             "manage_agents", "manage_tools",
                                             "manage_rules", "create", "add",
                                             "update", "deploy", "build"}),
]
_COMPLETION_TOKEN_COMPILED = [(re.compile(v, re.IGNORECASE), toks)
                              for v, toks in _COMPLETION_TOKENS]
_TOKEN_SPLIT = re.compile(r"[a-z0-9]+")


def _could_have_done(claim: str, called_tools) -> bool:
    """Did any tool called this turn plausibly perform `claim`?

    Fails OPEN — an unrecognised claim verb, or no token list matching it,
    counts as satisfied. A false accusation is appended to the reply and read
    aloud, so it costs more than a missed catch; that is the same trade every
    detector in this family makes.
    """
    names = set()
    for n in called_tools or ():
        names |= set(_TOKEN_SPLIT.findall(str(n).lower()))
    if not names:
        return False
    for verb, tokens in _COMPLETION_TOKEN_COMPILED:
        if verb.search(claim):
            return bool(tokens & names)
    return True

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


def _completion_slip(final_text: str, called_tools=None) -> str | None:
    """A claim to have DONE something, with nothing that could have done it."""
    for sentence in _SENTENCES.split(final_text):
        if _RECAP_MARKERS.search(sentence):
            continue
        for pat in _COMPLETION_COMPILED:
            m = pat.search(sentence)
            if m and not _exempt(sentence, m):
                if called_tools is not None and _could_have_done(
                        m.group(0) + " " + sentence, called_tools):
                    continue
                return m.group(0)
    return None


def detect(final_text: str, tool_calls_made: int,
           called_tools=None, round_text: str | None = None) -> str | None:
    """The matched phrase when the text announces or claims action while no
    tool ran; None otherwise.

    `tool_calls_made` is the runner's ground truth for the ROUND that ended
    the turn, not the whole turn. It used to be the turn total, which meant
    one tool call in round 1 blinded this check for every later round — and
    that is exactly how "The egress rules look fine … Let me dig deeper into
    what's actually running:" got through after list_egress had run.

    `called_tools` is every tool name called across the WHOLE turn, and it is
    what lets the completion arm survive a round that called something. The
    two questions are genuinely different: "did you do the thing you said you
    would" is about this round, while "did the thing you claim to have done
    happen" is about the turn. Omit it and behaviour is exactly as before —
    every existing caller keeps its semantics.

    `round_text` finishes that separation. The round-scoped arms were reading
    the CUMULATIVE turn text while being gated on a round-scoped call count,
    and the two disagree on every turn that ends with prose: `tool_calls_made`
    is 0 for the closing round, so "Let me check" written in round 1 — and
    KEPT, by a tool call in round 1 — was still matched at the end. MEASURED
    2026-08-04 on turn a6630aee: four tools ran (two searches, a fetch, a
    dispatch) and the reply was still stamped "announced an action but called
    no tool (matched 'Let me check')" plus "[No tool ran this turn]". The
    detector called her a liar about work she had actually done, in the reply
    the operator reads.

    So: the round arms read the round, the completion arm still reads the
    turn. Omitted, it falls back to `final_text` and nothing changes.
    """
    if not final_text:
        return None
    scoped = round_text if round_text is not None else final_text
    if tool_calls_made:
        # Only the completion arm survives, and only against calls that could
        # not have performed the claim. The structural and future-tense arms
        # stay round-scoped: "let me dig deeper:" after a real call in the
        # SAME round is not a slip, it is a model still working.
        return (_completion_slip(final_text, called_tools)
                if called_tools is not None else None)
    # STRUCTURAL ARM, which needs no vocabulary. A reply whose last non-empty
    # line ends in a colon or a dash is introducing something that never
    # arrived — the phrase list is a maintained list of ways to say "let me",
    # which is the hardcoding CLAUDE.md warns about, and it caught 1 of the
    # 10 real slips in the 2026-08-03 incident. Three of those replies ended
    # in a colon with zero tool calls.
    lines = [ln.rstrip() for ln in scoped.strip().splitlines() if ln.strip()]
    if lines and lines[-1].endswith((":", "—", "-")) and "?" not in lines[-1]:
        return lines[-1][-60:]
    # The future-tense arm is per-sentence for the same reason the completion
    # arm always was. It used to scan the WHOLE reply, so one offer to help
    # anywhere in it — "would you rather I dispatch to agent-creator now with a
    # sketch?" — flagged the turn, wrote a journal line asserting the work did
    # not happen, and (since the correction is now appended to the reply and
    # read aloud) contradicted an answer that was correct. The module's own
    # docstring has always said questions must not be matched; only the
    # completion arm actually honoured it.
    for body, end in _clauses(scoped):
        if "?" in end:
            continue
        for pat in _COMPILED:
            m = pat.search(body)
            if m and not _exempt(body, m):
                return m.group(0)
    return _completion_slip(final_text, called_tools)
