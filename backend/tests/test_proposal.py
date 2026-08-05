"""He asked her to build something; she answered with a menu.

    docker compose exec backend python tests/test_proposal.py

Measured live 2026-08-05. Jeremy: "Set up a Home Assistant instance for me."
Nova wrote 168 words comparing where it could run, closed with "Which way do
you want to go?", and called NOTHING — holding `propose_goal`, with her own
prompt telling her to call it for exactly this case.

Sixth member of the guard family. The trade is the family's usual one, but
the false-fire cost is higher than deferral's: discarding a round costs a
round, and this detector reads TWO texts (his request and her reply) so it
has two ways to be wrong. Hence the exclusion list is tested harder than the
must-fire list.

  1. MUST FIRE — the incident verbatim and the phrasings around it.
  2. MUST NOT FIRE — build-shaped words that are not build requests, and
     correct behaviour that happens to end in a question.
  3. THE VETOES — a turn that already proposed, or already called anything.
  4. THE PERMISSION — separate from the vocabulary, like everywhere here.
"""

import sys

sys.path.insert(0, "/app/backend")

from app import proposal, settings_store   # noqa: E402

FAILURES: list[str] = []

Q_HA = "Set up a Home Assistant instance for me."
R_HA = ("I can deploy Home Assistant as a container in my namespace, but "
        "there's a real limitation: it needs to be on your local network to "
        "discover and control smart devices. Running it in my Kubernetes "
        "namespace isolates it from your LAN. Two options: I deploy it here, "
        "or you run it locally. Which way do you want to go?")


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def test_must_fire():
    print("\n1. MUST FIRE")
    cases = [
        ("1.1 the incident, verbatim", Q_HA, R_HA),
        ("1.2 install", "install grafana for me",
         "It could run in k8s or on the host. Would you prefer one?"),
        ("1.3 stand up", "stand up a postgres instance",
         "Where would you like it? Let me know which you want."),
        ("1.4 get X running — multi-word object",
         "get a mqtt broker running", "That can live in a few places. What do you want to do?"),
        ("1.5 deploy", "deploy a scraper for that site",
         "I can put it in my namespace or elsewhere. Your call."),
        ("1.6 spin up", "spin up a redis for the queue",
         "Which would you rather — managed or in-cluster?"),
        ("1.7 build me a", "build me an integration for the thermostat",
         "There are two routes here. Which do you want?"),
    ]
    for label, q, r in cases:
        got = proposal.unproposed_build(q, r, 0, [])
        check(label, bool(got), (got or "")[:60])


def test_must_not_fire():
    print("\n2. MUST NOT FIRE — build-shaped, not a build")
    cases = [
        ("2.1 a meeting", "set up a time to talk tomorrow",
         "Which slot would you like?"),
        ("2.2 an automation is ordinary work", "set up a rule to block that",
         "Which pattern do you want?"),
        ("2.3 a reminder", "set up a reminder for 6pm",
         "Would you prefer a push or a chat message?"),
        ("2.4 asking HOW is a question, not an order",
         "how do I set up home assistant?", "Which way do you want to go?"),
        ("2.5 what would it take", "what would it take to set up home assistant?",
         "Would you prefer k8s or the host?"),
        ("2.6 walk me through", "walk me through setting up grafana",
         "Which install method do you want?"),
        ("2.7 what are my options", "what are my options to set up a broker?",
         "Which one appeals?"),
    ]
    for label, q, r in cases:
        got = proposal.unproposed_build(q, r, 0, [])
        check(label, not got, (got or "")[:60])

    print("   …and correct behaviour that ends in a question")
    good = [
        ("2.8 she proposed and THEN named the fork", Q_HA,
         "Proposed the goal — compose route with profile home, since it needs "
         "LAN access and my namespace has none. Want me to widen it to Zigbee "
         "later?"),
        ("2.9 an answer with no menu at all", Q_HA,
         "Home Assistant needs LAN access, so my namespace is the wrong home "
         "for it. I've proposed the goal for the compose route."),
        ("2.10 a question that is not aimed at him",
         "set up a mqtt broker", "The question is whether it needs TLS. It does, "
         "so I've proposed the goal with certs included."),
    ]
    for label, q, r in good:
        got = proposal.unproposed_build(q, r, 0, [])
        check(label, not got, (got or "")[:60])


def test_vetoes():
    print("\n3. THE VETOES")
    check("3.1 already proposed this turn",
          not proposal.unproposed_build(Q_HA, R_HA, 0, ["propose_goal"]),
          "the plan exists; the question after it is legitimate")
    check("3.2 a tool ran this round",
          not proposal.unproposed_build(Q_HA, R_HA, 1, []))
    check("3.3 other tools called, but not propose_goal — still fires",
          bool(proposal.unproposed_build(Q_HA, R_HA, 0, ["search_memory"])),
          "searching is not proposing")
    check("3.4 empty reply", not proposal.unproposed_build(Q_HA, "", 0, []))
    check("3.5 empty query", not proposal.unproposed_build("", R_HA, 0, []))


def test_permission():
    print("\n4. THE PERMISSION IS SEPARATE FROM THE VOCABULARY")
    check("4.1 propose_goal granted", proposal.can_propose(
        ["search_memory", "propose_goal", "fetch_url"]))
    check("4.2 not granted -> never told to propose",
          not proposal.can_propose(["search_memory", "fetch_url"]))
    check("4.3 nothing granted", not proposal.can_propose([]))
    check("4.4 the setting exists and defaults on",
          settings_store.get("autonomy.propose_the_build") is not False)


def main() -> int:
    test_must_fire()
    test_must_not_fire()
    test_vetoes()
    test_permission()
    if FAILURES:
        print(f"\nFAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
