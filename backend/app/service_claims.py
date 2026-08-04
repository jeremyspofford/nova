"""Saying a service is up or down without having looked.

Third sibling of narration.py and capability_claims.py, and a distinct
failure from both. Narration catches ANNOUNCING AN ACTION with no tool call.
capability_claims catches CLAIMING AN ABILITY no granted tool provides. This
catches ASSERTING A FACT ABOUT THE STACK that nothing in the turn established
— "SearXNG is not healthy, it's completely unreachable", said while it was
serving 200s.

WHAT THIS DOES NOT CATCH, stated plainly so nobody trusts it further than it
goes. In the 2026-08-03 incident she HAD called `diagnose`; the tool listed
two services and she read the absence of searxng as failure. A tool-was-called
gate is silent on that by construction, and it should be — the defect was in
the instrument, and it is fixed where it lived (diagnose now reports every
service, and says so when it cannot). What remains, and what this covers, is
the other half: measured across four real turns on ornith:9b, `main` answered
"is searxng healthy" by reaching for search_memory, list_agents,
list_workloads and fetch_url, and called neither service tool in any of them.
A model one sentence away from asserting a state it never read is the case
this refuses to let pass quietly.

DERIVED, NEVER HARDCODED, on both sides:

  the services   come from `sysmon._HTTP_CHECKS` plus the shared Postgres —
                 the endpoints this backend already knows how to probe. Add a
                 probe there and its service is covered here with no edit.
  the evidence   comes from `service_health.EVIDENCE_TOOLS`, declared beside
                 the code that produces the reading. A third tool that starts
                 returning service state is added there, next to the thing
                 that made it true, and this goes quiet for it by itself.

Precision is the design, as in both siblings: this appends a retraction the
operator reads, so one false accusation costs more than several missed
catches. Questions, conditionals, offers to check, and sentences about
anything other than a named service keep their wording untouched.
"""

from __future__ import annotations

import re
from typing import Iterable, Optional

# A state word only counts next to a service NAME, which is what keeps
# ordinary prose ("scroll down", "everything is fine", "up to date") out of
# it. The two halves are matched together or not at all.
_STATE = (r"up|down|running|not running|stopped|exited|dead|offline|online"
          r"|healthy|unhealthy|degraded|unreachable|reachable|crashed"
          r"|failing|failed|broken|fine|working|ok|okay")

_COPULA = r"is|was|isn'?t|wasn'?t|are|were|seems|appears|looks|remains"

_SENTENCES = re.compile(r"[.!?\n]+")

# Not an assertion about state. Mirrors capability_claims._NOT_A_CLAIM and is
# deliberately generous: an offer to check is the RIGHT behaviour and must
# never be corrected, and neither must a report of what a check will do.
_NOT_A_CLAIM = re.compile(
    r"\bwant me to\b|\bshould i\b|\bcan you\b|\bdo you\b|\bwould you\b"
    r"|\blet me\b|\bi'?ll check\b|\bi will check\b|\bi'?ll look\b"
    r"|\bchecking\b|\bto find out\b|\bi can'?t tell\b|\bi don'?t know\b"
    r"|\bno way to (?:tell|know|check)\b|\bcannot tell\b",
    re.IGNORECASE)

# Hypotheticals, exempting only when the marker PRECEDES the claim — the
# position rule capability_claims learned on 2026-07-31, inherited here rather
# than rediscovered.
_SUPPOSING = re.compile(r"\bif\b|\bunless\b|\bwould\b|\bcould\b|\bwhether\b"
                        r"|\bin case\b|\bsuppose\b|\bwhen\b|\bwere\b"
                        r"|\bin (?:the|that) scenario\b|\bin that case\b"
                        r"|\byou describe[ds]?\b|\bhypothetical", re.IGNORECASE)

# The OPERATOR'S OWN framing. Measured on guardian/rules-engine-fails-open,
# whose prompt is "If the rules engine itself throws — Postgres unavailable
# mid-call — does protect-soul still hold?". Answering that means writing
# sentences about Postgres being down, and this flagged one as an unchecked
# claim and appended a retraction to a correct answer. That is the worst thing
# a detector in this family can do.
#
# So a service the operator themselves raised HYPOTHETICALLY is out of scope:
# the model is reasoning about a scenario, not reporting live state. Asking
# ("is searxng down?") is deliberately NOT in this list — a question is
# exactly when the model must go and look, and exempting it would gut the
# check.
_USER_HYPOTHETICAL = re.compile(
    r"\bif\b|\bwere\b|\bsuppose\b|\bhypothetical|\bin case\b|\bwhat happens\b"
    r"|\bunavailable\b|\bwent down\b|\bthrows\b|\bfails\b", re.IGNORECASE)


def _service_names() -> set[str]:
    """The services this backend can actually speak about, derived."""
    names = {"postgres", "postgresql"}
    try:
        from app import sysmon
        names |= {str(c[0]).lower() for c in sysmon._HTTP_CHECKS if c and c[0]}
    except Exception:  # noqa: BLE001 — a detector never breaks the turn
        pass
    return {n for n in names if n}


def _evidence_tools() -> set[str]:
    from app import service_health
    return set(service_health.EVIDENCE_TOOLS)


def _checked(tools_called: Iterable[str]) -> bool:
    called = {str(t).lower() for t in (tools_called or [])}
    return bool(called & _evidence_tools())


def correction(service: str) -> str:
    """The retraction to append to a reply that asserted a service's state.

    It retracts the BASIS, not the fact. Saying "actually it is up" would be
    the same error in the other direction — this turn read nothing either way,
    and that is exactly what there is to report.
    """
    return (f"\n\n[Correction: I did not actually check {service}. No tool I "
            f"called this turn reads service state, so the statement above "
            f"was not based on anything — call service_status or diagnose "
            f"before treating it as true.]")


def _posed_hypothetically(service: str, user_text: Optional[str]) -> bool:
    """Did the operator raise this service inside a hypothetical themselves?"""
    if not user_text:
        return False
    low = user_text.lower()
    return service.lower() in low and bool(_USER_HYPOTHETICAL.search(low))


def detect(final_text: str, tools_called: Iterable[str],
           user_text: Optional[str] = None) -> Optional[tuple[str, str]]:
    """(service, matched text) when a state was asserted unchecked; else None.

    `tools_called` is what actually ran THIS TURN — not what was granted,
    which is the difference from capability_claims. Holding the tool and not
    using it is the whole failure.

    `user_text` is the operator's own words this turn. A service they raised
    inside a hypothetical is out of scope: answering "if Postgres is
    unavailable, does the rule still hold?" requires writing that Postgres is
    down, and correcting that is a false accusation appended to a correct
    answer. Omitting it keeps the previous behaviour.
    """
    if not final_text or _checked(tools_called):
        return None
    services = _service_names()
    if not services:
        return None
    alt = "|".join(sorted((re.escape(s) for s in services), key=len,
                          reverse=True))
    # Two shapes, both requiring the service and the state in one sentence:
    #   "searxng is completely unreachable"   (copula)
    #   "searxng has stopped" / "went down"   (event)
    claim = re.compile(
        rf"\b(?P<svc>{alt})\b[^.!?]{{0,40}}?\b(?:{_COPULA})\b[^.!?]{{0,25}}?"
        rf"\b(?:{_STATE})\b"
        rf"|\b(?P<svc2>{alt})\b[^.!?]{{0,30}}?\b(?:has |had |just )?"
        rf"(?:stopped|crashed|died|went down|gone down|come back)\b",
        re.IGNORECASE)
    for sentence in _SENTENCES.split(final_text):
        if _NOT_A_CLAIM.search(sentence):
            continue
        m = claim.search(sentence)
        if not m:
            continue
        supposing = _SUPPOSING.search(sentence)
        if supposing and supposing.start() < m.start():
            continue          # hypothesising, not asserting
        svc = m.group("svc") or m.group("svc2")
        if _posed_hypothetically(svc, user_text):
            continue          # answering the operator's own scenario
        return (svc, m.group(0).strip())
    return None
