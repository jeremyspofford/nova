"""A refused capability verb raises the card instead of asking for one.

    docker compose exec backend python tests/test_goal_gate_card.py

The goal gate used to answer a refused verb with a string telling the model to
call `propose_goal`. That is a prompt doing a control's job, and the measured
outcome was that it did not get called — so a refusal dead-ended and left NO
operator-visible artifact at all. Nobody was asked, and nobody knew.

Everything the card needs was already at the refusal point: the verb, the
agent, the conversation and the arguments. So the gate raises it.

Three properties, and the middle one is what keeps the queue readable:

1. A first refusal creates a proposed goal AND a consent card.
2. A SECOND refusal of the same verb by the same agent reuses them. The old
   refusal text asked the model to retry after proposing, so without this a
   retry loop turns an approval queue into noise the operator stops reading.
3. A card that cannot be raised never turns a refusal into a success. The
   verb stays refused and the text says the card failed rather than implying
   somebody was asked.

Everything is injected — no live goals, consents or DB rows are written.
"""

import asyncio
import sys

sys.path.insert(0, "/app/backend")

from app import goals                                # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


class Recorder:
    """Stands in for the goals table and the consent queue."""

    def __init__(self):
        self.proposed: list[dict] = []
        self.cards: list[dict] = []
        self.fail_card = False

    async def pending_for(self, verb, agent_name):
        return next((g for g in self.proposed
                     if verb in g["approved_verbs"]
                     and g["proposed_by"] == agent_name), None)

    async def propose(self, title, target, verbs, **kw):
        g = {"id": f"g{len(self.proposed)}", "title": title, "target": target,
             "approved_verbs": list(verbs), "max_actions": 20,
             "proposed_by": kw.get("proposed_by")}
        self.proposed.append(g)
        return g

    async def create(self, kind, subject, question, **kw):
        if self.fail_card:
            raise RuntimeError("consent rate limit")
        self.cards.append({"kind": kind, "subject": subject,
                           "question": question, **kw})
        return {"id": "c1"}


def install(rec: Recorder):
    """Point goals.card_for_refusal at the recorder, not the database."""
    import app.consents as consents_mod
    goals.pending_for = rec.pending_for
    goals.propose = rec.propose
    consents_mod.create = rec.create


async def refuse(rec, agent="main", args=None):
    """Run the gate's refusal branch directly."""
    return await goals.card_for_refusal(
        "manage_automations", agent_name=agent,
        conversation_id=None, args=args or {"action": "create", "name": "x"})


def main() -> int:
    real = (goals.pending_for, goals.propose)
    import app.consents as consents_mod
    real_create = consents_mod.create
    rec = Recorder()
    install(rec)
    try:
        print("1. a first refusal raises the card the model was asked to raise")
        goal, created = asyncio.run(refuse(rec))
        check("a goal is proposed", len(rec.proposed) == 1, str(len(rec.proposed)))
        check("...and reported as newly created", created is True)
        check("a consent card is raised", len(rec.cards) == 1)
        check("scoped to exactly the refused verb, nothing else",
              goal["approved_verbs"] == ["manage_automations"],
              str(goal["approved_verbs"]))
        q = rec.cards[0]["question"]
        check("the card says nothing happened, so it cannot read as a receipt",
              "nothing has happened" in q, q[:60])
        check("it carries the refused arguments — 'what did it try to do' is "
              "the whole value to the operator",
              "action" in q and "create" in q)
        check("and it admits there is no stated finish line, rather than "
              "inventing one the model never gave",
              "no stated finish line" in q)

        print("2. a retry REUSES the card instead of burying it")
        goal2, created2 = asyncio.run(refuse(rec))
        check("no second goal", len(rec.proposed) == 1, str(len(rec.proposed)))
        check("no second card", len(rec.cards) == 1, str(len(rec.cards)))
        check("reported as pre-existing", created2 is False)
        check("and it is the same goal", goal2["id"] == goal["id"])

        print("3. a different agent gets its own card — the grant is per agent")
        _g3, created3 = asyncio.run(refuse(rec, agent="ingestion"))
        check("a separate goal for a separate agent",
              len(rec.proposed) == 2 and created3 is True, str(len(rec.proposed)))

        print("4. a card that cannot be raised never becomes an approval")
        rec2 = Recorder()
        rec2.fail_card = True
        install(rec2)
        raised = False
        try:
            asyncio.run(refuse(rec2))
        except Exception:  # noqa: BLE001
            raised = True
        check("the failure propagates to the gate, which keeps the refusal",
              raised)
        check("and no card is recorded", not rec2.cards)
    finally:
        goals.pending_for, goals.propose = real
        consents_mod.create = real_create

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
