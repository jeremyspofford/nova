"""Knowing what she knows — the memory catalogue and bounded reads.

    docker compose exec backend python tests/test_catalogue.py

Memory was reachable only by search. A document that did not match the
current phrasing did not exist that turn, and there was no way to ask what
was in there at all — the operator had the MemoryAtlas panel the whole time,
and the agent had `list_skills`, covering 1 of 114 live documents.
`memory-curator`, whose entire job is curating memory, could delete a
document it had no way to enumerate.

That is a manufacturer of invented answers, and so were the two bugs found
while building this, both fixed here:

  * `read_memory_item` had NO size limit, and the runner then cut every tool
    result at 8,000 characters with a bare slice. One live call returned
    169,673 characters; the model was shown 8,000 of them — 4.7%, ending
    mid-JSON, with nothing to say anything was missing. It then answered.
  * `_build_system_prompt` raised UnboundLocalError on the memory-retrieval
    path for any agent that does not see the specialist index, so dispatched
    specialists were answering with no memory at all. A local re-import
    shadowed the module-level one and made the name function-local.

The properties below are what "she can see her own memory" has to mean if it
is going to reduce guessing rather than move it:

  1. THE BOUND IS REAL AND DERIVED. Not a constant. The same call has to be
     affordable on a 16k local window and not crippled on a 200k cloud one,
     and it must agree with the ceiling the router actually refuses against.
  2. NOTHING VANISHES QUIETLY. Collapsed, paged and dropped are three
     different things and all three are stated. A listing that silently ends
     is the exact shape of the bug this exists to fix.
  3. TAINT IS DERIVED FROM WHAT CAME BACK. Titles are not inert — most of
     this corpus is fetched video transcripts titled by strangers. A listing
     that includes them disarms the actor tools; a listing of her own skills
     does not.
"""

import asyncio
import re
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


async def run() -> None:
    import json

    from app import db, settings_store
    from app.memory import provenance
    from app.memory.memory import OkfMemory, sandbox
    from app.tools import builtin
    from app.agents import context_trim

    await db.init_pool()
    await settings_store.warm()

    tmp = Path(tempfile.mkdtemp(prefix="nova-catalogue-"))
    try:
        mem = OkfMemory(base_dir=str(tmp))
        await mem.startup()
        with sandbox(mem):
            # A corpus shaped like the real one: dominated by fetched
            # transcripts under a couple of source tags, with a little
            # first-party material and one document too big to read whole.
            # The SOURCE documents a followed channel always has. Without
            # them this fixture was not a small version of the real corpus,
            # it was a different corpus: `tagtiers` classifies a tag carried
            # by an entity node (type='source') as SPECIFIC at any frequency,
            # and everything else by frequency alone. With no source doc,
            # `src-big-channel` covered 31 of 41 documents and came out
            # STRUCTURAL — which the collapse skips, so no collection ever
            # formed and the tail was dropped instead. The live corpus never
            # hits that: `src-cloud-codes---videos` tags 85 of 193 documents
            # and is `specific`, because its channel doc exists.
            for chan in ("Big Channel", "Small Channel"):
                await mem.write(
                    f"{chan} — a followed video source.", type="source",
                    title=chan, tags=[f"src-{chan.lower().replace(' ', '-')}"],
                    link_pass=False)
            for n in range(30):
                await mem.write(f"transcript body {n} " + "lorem ipsum " * 40,
                                type="topic", title=f"Big Channel Video {n}",
                                description=f"Full YouTube transcript of Big Channel Video {n}",
                                tags=["media", "transcript", "src-big-channel"],
                                source_url=f"https://example.com/v/{n}")
            for n in range(8):
                await mem.write(f"other transcript {n} " + "dolor sit " * 40,
                                type="topic", title=f"Small Channel Video {n}",
                                description=f"Full YouTube transcript of Small Channel Video {n}",
                                tags=["media", "transcript", "src-small-channel"],
                                source_url=f"https://example.com/s/{n}")
            await mem.write("The operator prefers plain words over emojis.",
                            type="topic", title="Operator Profile",
                            description="Standing preferences the operator has stated "
                                        "directly, kept current by hand.",
                            tags=["operator-guidance"])
            await mem.write("Check two independent sources before repeating a claim.",
                            type="skill", title="Verification Habit",
                            description="How to avoid repeating an unverified claim "
                                        "from a single video.",
                            tags=["method"])
            # one document far larger than any window, as ONE paragraph —
            # the real shape of a fetched transcript
            await mem.write("word " * 60000, type="topic",
                            title="Enormous Transcript",
                            description="Full YouTube transcript of Enormous Transcript",
                            tags=["media", "transcript", "src-big-channel"],
                            source_url="https://example.com/huge")

            small = {"model": "ollama:qwen3:14b", "granted": set(),
                     "untrusted_context": False}
            large = {"model": "", "granted": set(), "untrusted_context": False}
            small_cap = builtin._turn_chars(small, builtin._CATALOGUE_FRACTION)
            large_cap = builtin._turn_chars(large, builtin._CATALOGUE_FRACTION)

            print("1. the bound is real, and derived from the model's own window")
            check("a small window yields a smaller ceiling than a large one",
                  small_cap < large_cap, f"{small_cap} < {large_cap}")
            check("the ceiling tracks context_trim.ceiling_for — the same number "
                  "the router refuses against, so 'this fits' means it fits",
                  small_cap == max(2000, int(context_trim.ceiling_for("ollama:qwen3:14b")
                                             * builtin._CATALOGUE_FRACTION)
                                   * context_trim._CHARS_PER_TOKEN))
            out_small = await builtin._list_memory({}, dict(small))
            out_large = await builtin._list_memory({}, dict(large))
            check("the small-window listing respects its ceiling",
                  len(out_small) <= small_cap * 1.15, f"{len(out_small)} vs {small_cap}")
            check("the large-window listing is genuinely richer",
                  len(out_large) > len(out_small), f"{len(out_large)} > {len(out_small)}")

            d_small = json.loads(out_small)
            d_large = json.loads(out_large)

            print("2. nothing vanishes quietly")
            check("the true total is reported whatever was shown",
                  d_small["total"] == d_large["total"] == 43,   # +2 source docs
                  f"{d_small['total']} / {d_large['total']}")
            listed = len(d_small["documents"])
            collapsed = sum(c["documents"] for c in d_small["collections"])
            check("every document is either listed, inside a named collection, "
                  "or counted in `omitted` — no third option",
                  listed + collapsed + d_small["omitted"] == d_small["total"],
                  f"{listed}+{collapsed}+{d_small['omitted']} vs {d_small['total']}")
            check("the big source group collapsed rather than being dropped",
                  any(c["tag"] == "src-big-channel" for c in d_small["collections"]),
                  str([c["tag"] for c in d_small["collections"]]))
            check("a collection says how to open it",
                  all("list_with" in c for c in d_small["collections"]))

            print("3. drilling into a collection is not a dead end")
            drill = json.loads(await builtin._list_memory(
                {"tag": "src-big-channel"}, dict(small)))
            check("the tag lists its members individually",
                  len(drill["documents"]) == drill["total"] == 32,  # 30 + enormous + the source doc
                  f"{len(drill['documents'])}/{drill['total']}")
            check("...and does NOT collapse the tag it was asked to expand",
                  not drill["collections"])

            print("4. taint is derived from what actually came back")
            ctx = dict(small)
            await builtin._list_memory({}, ctx)
            check("a listing carrying fetched transcripts disarms the actor tools "
                  "— a title written by a stranger is still their text",
                  ctx["untrusted_context"])
            ctx = dict(small)
            await builtin._list_memory({"kind": "skill"}, ctx)
            check("a listing of her OWN skills leaves them armed — a control "
                  "that fires always is the same as no control",
                  not ctx["untrusted_context"])
            check("a collection can never look safer than its contents",
                  all(c["origin"] == provenance.THIRD_PARTY
                      for c in d_small["collections"]
                      if c["tag"].startswith("src-")))

            print("5. a description that restates the title is suppressed")
            allrows = json.loads(await builtin._list_memory({}, dict(large)))["documents"]
            described = {r["title"]: r.get("description") for r in allrows}
            check("the writer's template description is dropped",
                  not described.get("Big Channel Video 1"),
                  str(described.get("Big Channel Video 1")))
            check("a real description survives",
                  bool(described.get("Operator Profile")),
                  str(described.get("Operator Profile")))
            check("DERIVED, not a list of known templates: a wording nobody "
                  "anticipated is still caught, because it is compared against "
                  "the title rather than against a remembered string",
                  OkfMemory._describes_nothing(
                      "Archived copy of Operator Profile", "Operator Profile"))
            check("...and a description that genuinely adds meaning is not",
                  not OkfMemory._describes_nothing(
                      "Standing preferences the operator stated directly, kept "
                      "current by hand", "Operator Profile"))

            print("6. a document too large to hold is paged, never truncated")
            huge = next(i for i, m in mem.index.docs.items()
                        if m["title"] == "Enormous Transcript")
            ctx = dict(small)
            r1 = json.loads(await builtin._read_memory_item({"item_id": huge}, ctx))
            check("it comes back in numbered parts", r1.get("parts", 1) > 1,
                  f"{r1.get('parts')} parts")
            check("the reply states which part this is", r1.get("part") == 1)
            check("...and says the rest was NOT seen — the model cannot flag a "
                  "gap nobody showed it",
                  "have NOT seen" in (r1.get("note") or ""))
            r2 = json.loads(await builtin._read_memory_item(
                {"item_id": huge, "part": 2}, dict(small)))
            check("part 2 is different text, not a repeat",
                  r2["content"] != r1["content"])
            parts = [json.loads(await builtin._read_memory_item(
                {"item_id": huge, "part": n}, dict(small)))["content"]
                for n in range(1, r1["parts"] + 1)]
            body = (await mem.read_item(huge))["content"]
            check("the parts together cover the whole document — paging must "
                  "not lose the middle",
                  _norm("".join(parts)) == _norm(body),
                  f"{len(_norm(''.join(parts)))} vs {len(_norm(body))} chars")
            check("an out-of-range part clamps instead of erroring",
                  json.loads(await builtin._read_memory_item(
                      {"item_id": huge, "part": 999}, dict(small)))["part"]
                  == r1["parts"])
            check("a document that fits is returned whole, with no paging noise",
                  "parts" not in json.loads(await builtin._read_memory_item(
                      {"item_id": next(i for i, m in mem.index.docs.items()
                                       if m["title"] == "Operator Profile")},
                      dict(small))))

            print("6b. one unbroken paragraph still pages — the real transcript shape")
            one_para = "word " * 20000
            pieces = context_trim.paginate(one_para, 5000)
            check("a body with no blank lines is still split",
                  len(pieces) > 1, f"{len(pieces)} parts")
            check("no piece exceeds the cap",
                  all(len(p) <= 5000 for p in pieces),
                  str(max(len(p) for p in pieces)))
            check("and nothing is lost", "".join(pieces) == one_para)

            print("7. the runner's own cap announces itself")
            from app.agents import runner
            capped = runner._cap_result("x" * 500_000, "ollama:qwen3:14b")
            check("an oversized result is cut", len(capped) < 500_000)
            check("...and SAYS it was cut, with both numbers",
                  "TRUNCATED" in capped and "500,000" in capped,
                  capped[-90:])
            check("a result under the ceiling is untouched",
                  runner._cap_result("short", "ollama:qwen3:14b") == "short")
            check("the ceiling scales with the model, like everything else here",
                  len(runner._cap_result("x" * 500_000, "")) >
                  len(runner._cap_result("x" * 500_000, "ollama:qwen3:14b")))

            print("8. the regression that had specialists answering blind")
            check("_build_system_prompt no longer closes over tool_registry — a "
                  "local re-import made it function-local, and the memory "
                  "retrieval line raised UnboundLocalError for every agent that "
                  "does not see the specialist index",
                  "tool_registry" not in runner._build_system_prompt.__code__.co_cellvars,
                  str(runner._build_system_prompt.__code__.co_cellvars))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        await db.close_pool()


def main() -> int:
    asyncio.run(run())
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
