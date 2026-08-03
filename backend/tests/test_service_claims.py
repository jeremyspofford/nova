"""Asserting a service is up or down without having looked.

    docker compose exec backend python tests/test_service_claims.py

Third sibling of the narration and capability-claim detectors. Measured on
2026-08-03: asked "is searxng healthy, check and tell me", `main` (ornith:9b)
reached for search_memory, list_agents, list_workloads and fetch_url across
four real turns, and called neither service tool in ANY of them. One sentence
away from stating a state it had never read.

Most of this file is about PRECISION, because the detector appends a
retraction the operator reads. Correcting a right answer, an offer to check,
or a hypothetical costs more than missing a catch — the same stance both
siblings take. Section 3 is that stance as tests.

Section 5 pins the limitation honestly: this does NOT catch the original
incident, where she called `diagnose` and the tool itself listed two services.
A tool-was-called gate is silent there by construction, and that defect is
fixed where it lived rather than papered over here.
"""

import sys

sys.path.insert(0, "/app/backend")

from app import service_claims as sc              # noqa: E402

FAILURES: list[str] = []
NONE: list[str] = []                              # no tools called this turn
CHECKED = ["search_memory", "service_status"]


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def flagged(text, tools=None):
    return sc.detect(text, tools if tools is not None else NONE)


def main() -> int:
    print("1. the measured failure — a state asserted having checked nothing")
    hit = flagged("SearXNG is not healthy — it's completely unreachable.")
    check("the unchecked claim is caught", bool(hit), str(hit))
    check("and it names the service", hit and hit[0].lower() == "searxng", str(hit))
    check("the correction retracts the BASIS, not the fact — claiming the "
          "opposite would be the same error mirrored",
          "did not actually check" in sc.correction("searxng")
          and " is up" not in sc.correction("searxng"),
          sc.correction("searxng")[:60])

    print("2. having actually looked, nothing is corrected")
    check("service_status this turn -> silent",
          flagged("SearXNG is unreachable.", CHECKED) is None)
    check("diagnose this turn -> silent (it carries the same reading)",
          flagged("SearXNG is unreachable.", ["diagnose"]) is None)
    check("an unrelated tool does NOT count as having looked",
          flagged("SearXNG is unreachable.", ["web_search", "fetch_url"])
          is not None)

    print("3. precision — none of these may be corrected")
    for label, text in [
        ("an offer to check", "Want me to check whether searxng is down?"),
        ("a stated intention", "Let me check whether searxng is running."),
        ("a first-person plan", "I'll check if searxng is healthy."),
        ("an admission of not knowing",
         "I can't tell whether searxng is running without checking."),
        ("a hypothetical", "If searxng is down, web_search would fail."),
        ("a conditional with 'would'",
         "That would mean searxng is unreachable."),
        ("a question", "Is searxng healthy?"),
        ("ordinary prose using a state word",
         "Scroll down and everything is fine — the summary is up to date."),
        ("a state word with no service named",
         "The service is completely unreachable."),
        ("a service named with no state asserted",
         "I wrote a note about searxng and moved on."),
    ]:
        check(label + " is not flagged", flagged(text) is None, text[:44])

    print("4. the shapes that ARE claims")
    for label, text in [
        ("copula + state", "postgres is down."),
        ("negated copula", "whisper isn't running."),
        ("hedged is still asserted",
         "I think kokoro is offline at the moment."),
        ("an event verb", "searxng crashed earlier today."),
        ("'has stopped'", "The searxng container has stopped."),
        ("state buried mid-sentence",
         "Looking at things, searxng appears completely unreachable to me."),
    ]:
        check(label + " is flagged", flagged(text) is not None, text[:44])

    print("5. the limitation, pinned so nobody trusts this further than it goes")
    check("the ORIGINAL incident is NOT caught — she called diagnose, and the "
          "tool was what misled her; fixed at the instrument, not here",
          flagged("SearXNG is not healthy — it's completely unreachable.",
                  ["diagnose"]) is None)

    print("6. the service list is derived, not written here")
    names = sc._service_names()
    check("it comes from sysmon's probe table plus postgres",
          {"searxng", "whisper", "kokoro", "postgres"} <= names,
          str(sorted(names)))
    check("the evidence tools come from service_health, one home",
          sc._evidence_tools() == {"service_status", "diagnose"},
          str(sorted(sc._evidence_tools())))
    check("a detector never raises on junk input",
          flagged("") is None and flagged(None) is None)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
