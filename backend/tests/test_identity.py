"""Knowing who she is talking to — docs/plans/operator-identity.md phase 1.

    docker compose exec backend python tests/test_identity.py

On 2026-07-28 the operator asked "do you know who I am?" and was told "I
know you're my operator, but I don't have your name stored in my memory."
When he pointed out that his name IS in her memory, she said "I can see your
name in my memory, but I don't use it as an identifier for you. My focus is
on being your companion and assistant, not on storing personal details like
names" — a policy that does not exist anywhere in this system — and then
repeated that sentence verbatim when challenged. He said "Goodbye."

Two causes, and neither is the model being stupid.

IDENTITY CANNOT BE RETRIEVED. Measured against the live corpus that day, the
question "Do you know who I am?" pulled 3,149 characters of memory containing
no mention of his name, and "what is my name" pulled 2,908 with none either.
BM25 has no way to bridge "who am I" to "Jeremy": there is no shared token.
You would have to already know the answer in order to search for it. So
identity is injected on every turn, like the clock, and never searched.

AND THERE WAS NO IDENTITY BLOCK OUTSIDE VOICE. `_speaker_block` built exactly
the right thing and opened with `if not speaker: return ""` — and `speaker`
is only ever populated for voice turns, so typed chat had none of it.

The property that matters most below is the third one: ABSENCE IS STATED. A
gap she is told about is a gap she asks about. A gap she is not told about is
one she fills with invention, which is exactly what happened.
"""

import asyncio
import sys

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


async def run() -> None:
    from app import db, settings_store, voiceprints
    from app.agents import runner
    await db.init_pool()
    await settings_store.warm()

    saved = voiceprints.list_profiles

    async def nobody():
        return []

    async def just_operator():
        return [{"id": "x", "name": "Jeremy", "role": "operator",
                 "persona_notes": "Prefers plain words over emojis."}]

    try:
        print("1. typed chat gets an identity block at all")
        voiceprints.list_profiles = just_operator
        block = await runner._identity_block(None)
        check("a turn with no voice signal still says who it is with — this "
              "returned the empty string before, which is the whole bug",
              "Jeremy" in block, block[:90])
        check("...with the role", "operator" in block)
        check("...and any persona notes", "emojis" in block)

        print("2. absence is STATED, never blank")
        voiceprints.list_profiles = nobody
        block = await runner._identity_block(None)
        check("with nobody enrolled the block is not empty", bool(block.strip()))
        check("it says the name is not known",
              "do NOT know" in block or "don't know" in block, block[:90])
        check("it forbids guessing", "not guess" in block.lower())
        check("it forbids INVENTING A REASON — the actual failure was a made-up "
              "policy about not storing personal details, not a wrong name",
              "invent a reason" in block.lower(), block[:140])
        check("and it says to offer to remember it, so the gap closes itself",
              "remember" in block.lower())

        print("3. an unmatched voice is a question, not a silent guest")
        block = await runner._identity_block({"role": "unknown"})
        check("an unrecognised voice is named as unrecognised",
              "unrecognized voice" in block or "unrecognised voice" in block)
        check("...and she is told to ASK who they are — nothing asked before, "
              "which is why the profile table sat empty since it shipped",
              "ask who they are" in block.lower(), block[:120])

        print("4. an enrolled voice speaks for itself, whatever the registry says")
        voiceprints.list_profiles = nobody
        block = await runner._identity_block(
            {"name": "Alex", "role": "kid", "persona_notes": "Likes dinosaurs."})
        check("the voice match wins over the operator default",
              "Alex" in block and "kid" in block, block[:90])
        check("their notes ride along", "dinosaurs" in block)

        print("5. it never breaks a turn")
        async def explode():
            raise RuntimeError("registry down")
        voiceprints.list_profiles = explode
        block = await runner._identity_block(None)
        check("a dead registry degrades to the honest unknown block, not an "
              "exception — identity is on every turn, so it can never raise",
              "do NOT know" in block, block[:90])
        print("6. the graph links what genuinely shares a subject")
        await test_tag_edges()
    finally:
        voiceprints.list_profiles = saved
        await db.close_pool()


# ── the graph's tag edges ────────────────────────────────────────────────

async def test_tag_edges() -> None:
    """A shared tag is a relationship only while it is specific.

    graph() linked tag members as a CHAIN — members[i] -> members[i+1] in
    iter_files order, which is alphabetical by path. It kept the edge count
    down by making every edge false: 34% of all live edges asserted that "19
    Hidden Features" relates to "4 Ways to Build Stunning Websites" relates to
    "7 Rules To Use GPT 5.6". They are adjacent in the alphabet.
    """
    import shutil
    import tempfile
    from pathlib import Path
    from app.memory.memory import OkfMemory, sandbox

    tmp = Path(tempfile.mkdtemp(prefix="nova-graph-"))
    try:
        mem = OkfMemory(base_dir=str(tmp))
        await mem.startup()
        with sandbox(mem):
            # three notes sharing ONE specific subject: a real relationship
            for i in range(3):
                await mem.write(f"body {i}", type="topic", title=f"Small {i}",
                                tags=["quantisation"], link_pass=False)
            # eight sharing a broad label: a category, not a relationship
            for i in range(8):
                await mem.write(f"body {i}", type="topic", title=f"Big {i}",
                                tags=["src-some-channel"], link_pass=False)
            g = await mem.graph()
            by_id = {n["id"]: n["label"] for n in g["nodes"]}
            pairs = {(by_id.get(e["source"], ""), by_id.get(e["target"], ""))
                     for e in g["edges"] if e.get("kind") == "tag"}

            small = {p for p in pairs if p[0].startswith("Small")}
            check("a 3-member tag earns its REAL clique — every pair, not a "
                  "path through them", len(small) == 3, str(sorted(small)))
            check("...and the pairs are the actual members",
                  all(a.startswith("Small") and b.startswith("Small")
                      for a, b in small))

            big = {p for p in pairs if p[0].startswith("Big") or p[1].startswith("Big")}
            check("an 8-member tag earns NO edges — above the threshold it "
                  "names a category, and the label still rides on every node "
                  "for search", not big, str(sorted(big)[:4]))

            check("no edge is created from mere alphabetical adjacency",
                  ("Big 0", "Big 1") not in pairs)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> int:
    asyncio.run(run())
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
