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
        print("6. the gaps are NAMED, one by one (phase 2)")
        voiceprints.list_profiles = just_operator
        block = await runner._identity_block(None)
        check("a known person with unknown facts still gets a gap list — "
              "'I know your name' is not the same as 'I know everything', "
              "and the unnamed half is where invention goes",
              "Not known about them" in block, block[-120:])
        check("...naming the actual missing columns",
              "preferred_name" in block and "pronouns" in block)
        check("...and forbidding inference from documents, which is the one "
              "source that looks authoritative and is a stranger's text",
              "Never infer" in block)

        async def complete():
            return [{**(await just_operator())[0],
                     "preferred_name": "Jer", "pronouns": "he/him"}]
        voiceprints.list_profiles = complete
        block = await runner._identity_block(None)
        check("a complete profile gets NO gap list — the prompt stops asking "
              "for what it already has", "Not known about them" not in block)
        check("...and the preferred name is stated as the one to use",
              "Jer" in block and "he/him" in block, block[:160])

        print("7. capture writes only what the person actually said")
        await test_capture()

        print("8. blank-only is enforced by the write, not by the caller")
        await test_fill_blanks()

        print("9. the graph links what genuinely shares a subject")
        await test_tag_edges()
    finally:
        voiceprints.list_profiles = saved
        await db.close_pool()


# ── phase 2: capture ─────────────────────────────────────────────────────

async def test_capture() -> None:
    """The rail that makes remember_about_me safe on THIS corpus.

    154 of 169 topics here are third-party video transcripts, and retrieval
    puts them in front of the model constantly. Without a check, a sentence
    on someone's YouTube channel is a durable fact about the operator. The
    user's own message is the one span of context nothing else can write
    into, so that is what a claimed self-fact is checked against.
    """
    from app import capability_events, voiceprints
    from app.tools import builtin

    # The capability log is read back into her prompt, so a test that writes
    # to it puts fiction in front of the model. Caught by running this suite
    # against the live stack: two "Jeremy updated preferred_name" rows from a
    # run where no profile was touched at all.
    saved = (voiceprints.list_profiles, voiceprints.fill_blanks,
             capability_events.record)
    capability_events.record = lambda *a, **k: None
    calls: list[dict] = []

    async def operator():
        return [{"id": "op-1", "name": "Jeremy", "role": "operator"}]

    async def fake_fill(pid, patch):
        calls.append(dict(patch))
        return {"id": pid, "name": "Jeremy", **patch}, list(patch), []

    voiceprints.list_profiles, voiceprints.fill_blanks = operator, fake_fill
    try:
        ctx = {"speaker_role": None, "agent_name": "main"}

        out = await builtin._remember_about_me(
            {"preferred_name": "Jer"}, {**ctx, "user_text": "what's the weather"})
        check("a value absent from their message is REFUSED — this is the "
              "prompt-injection path, and the only one that matters here",
              out.startswith("Error") and not calls, out[:80])

        out = await builtin._remember_about_me(
            {"pronouns": "he/him"},
            {"speaker_role": "guest", "user_text": "I'm he/him"})
        check("a non-operator turn cannot write the operator's facts",
              out.startswith("Error") and not calls, out[:80])

        out = await builtin._remember_about_me(
            {"preferred_name": "Jer"},
            {**ctx, "user_text": "just call me Jer from now on"})
        check("said in their own words, it is written",
              calls == [{"preferred_name": "Jer"}], out[:80])

        calls.clear()
        out = await builtin._remember_about_me(
            {"preferred_name": "JER!"},
            {**ctx, "user_text": "call me jer, would you"})
        check("case and punctuation are not evidence — 'JER!' matches 'jer', "
              "the same normalisation the summary grounding check uses",
              calls == [{"preferred_name": "JER!"}], out[:80])

        calls.clear()
        out = await builtin._remember_about_me({"role": "operator"},
                                               {**ctx, "user_text": "role operator"})
        check("`role` is unreachable from conversation — a fact about "
              "yourself may never widen what you may do",
              out.startswith("Error") and not calls, out[:80])
    finally:
        (voiceprints.list_profiles, voiceprints.fill_blanks,
         capability_events.record) = saved


async def test_fill_blanks() -> None:
    """Blank-only is a property of the UPDATE, not of a check-then-write.

    The COALESCE means a populated column survives whatever the caller
    passes — so the guarantee holds for a caller that read the row a second
    ago and for one that never read it at all.
    """
    from app import voiceprints
    p = await voiceprints.create("test-fill-blanks", "guest", None)
    try:
        row, written, refused = await voiceprints.fill_blanks(
            p["id"], {"preferred_name": "First", "pronouns": "they/them"})
        check("an empty field is filled",
              row["preferred_name"] == "First" and written == ["preferred_name", "pronouns"],
              str(written))

        row, written, refused = await voiceprints.fill_blanks(
            p["id"], {"preferred_name": "Second"})
        check("a populated field is NOT overwritten, and says so",
              row["preferred_name"] == "First" and refused == ["preferred_name"],
              f"value={row['preferred_name']} refused={refused}")

        row, _, _ = await voiceprints.fill_blanks(p["id"], {"role": "operator"})
        check("a column outside SELF_FACTS is ignored entirely — no role "
              "escalation through the fill path", row["role"] == "guest")

        check("blanks() reports what is still missing",
              voiceprints.blanks(row) == [], str(voiceprints.blanks(row)))
        check("...and everything, for a person who does not exist yet",
              voiceprints.blanks(None) == list(voiceprints.SELF_FACTS))
    finally:
        await voiceprints.delete(p["id"])


# ── the graph's tag edges ────────────────────────────────────────────────

async def test_tag_edges() -> None:
    """Links anchor; a tag may extend a component but never fuse two anchors.

    THIS TEST IS WHY THE BUG SHIPPED (ROADMAP #37). It asserted that an
    8-member tag earns no edges — encoding a clique cap that ran AHEAD of the
    membership decision and made `kind = "tag"` unreachable for every tag that
    could ever have been membership. It passed throughout, because it never
    built a `source` node and so never took that branch at all. Measured
    2026-07-31 on the live corpus: zero `tag` edges, and clustering over
    `link + tag` set-identical to `link` alone.

    So the case that matters most below is the one that did not exist: two
    source-anchored components sharing a subject tag.
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
            # TWO ANCHORED CHANNELS sharing one subject tag. This is the shape
            # the old test lacked, and the only one that exercises the
            # membership-vs-affinity decision at all.
            for n in ("One", "Two"):
                await mem.write(f"channel {n}", type="source",
                                title=f"Channel {n}", link_pass=False)
                await mem.write(f"a video\n\nSource: [[Channel {n}]]",
                                type="topic", title=f"Vid {n}",
                                tags=["agentic-coding"], link_pass=False)

            g = await mem.graph()
            by_id = {n["id"]: n["label"] for n in g["nodes"]}
            label_of = {v: k for k, v in by_id.items()}

            def component(label: str) -> frozenset:
                """computeSystems' own rule: union over link + tag."""
                adj: dict = {}
                for e in g["edges"]:
                    if e.get("kind") not in ("link", "tag"):
                        continue
                    adj.setdefault(e["source"], set()).add(e["target"])
                    adj.setdefault(e["target"], set()).add(e["source"])
                start, seen_, stack = label_of[label], set(), [label_of[label]]
                while stack:
                    cur = stack.pop()
                    if cur in seen_:
                        continue
                    seen_.add(cur)
                    stack.extend(adj.get(cur, ()))
                assert start in seen_
                return frozenset(by_id.get(i, "") for i in seen_)

            pairs = {(by_id.get(e["source"], ""), by_id.get(e["target"], "")):
                     e.get("kind") for e in g["edges"]}

            small = component("Small 0")
            check("a shared subject CLUSTERS hand-written notes — a fresh "
                  "install has tags and nothing else, and used to become one "
                  "singleton per note",
                  {"Small 0", "Small 1", "Small 2"} <= small, str(sorted(small)))

            one, two = component("Vid One"), component("Vid Two")
            check("a tag spanning two anchored channels does NOT fuse them — "
                  "clustering is transitive, so one shared subject would "
                  "merge both channels entirely",
                  one != two and "Vid Two" not in one, str(sorted(one)))
            check("...each channel keeps its own anchor",
                  "Channel One" in one and "Channel Two" in two,
                  f"{sorted(one)} | {sorted(two)}")
            check("...and the tag still ships, as AFFINITY",
                  pairs.get(("Vid One", "Vid Two")) == "subject"
                  or pairs.get(("Vid Two", "Vid One")) == "subject",
                  str({k: v for k, v in pairs.items() if "Vid" in k[0]}))

            check("a pair the link already joined earns no tag edge — "
                  "restating it is what the 4,950-pair channel cliques were",
                  pairs.get(("Vid One", "Channel One")) == "link"
                  and ("Channel One", "Vid One") not in pairs,
                  str({k: v for k, v in pairs.items() if "Channel One" in k}))

            big = {p for p, k in pairs.items()
                   if k in ("tag", "subject")
                   and (p[0].startswith("Big") or p[1].startswith("Big"))}
            check("a tag too broad to be specific still earns nothing — the "
                  "TIER decides that, and it runs before any of this",
                  not big, str(sorted(big)[:4]))
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
