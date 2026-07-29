"""A video occupies ONE retrieval slot, not two.

    docker compose exec backend python tests/test_summary_collapse.py

`docs/plans/transcript-summaries.md` left one question open: "whether
automatic retrieval should prefer summaries over raw transcript text once
both exist. Likely yes, and measurable."

Measured 2026-07-28 against the live corpus, once 73 of 84 transcripts had
summaries. `memory.context("vector database compression")` returned three
summaries AND two of their own transcripts: two of five slots restating a
video already in the prompt, at transcript length. So: yes, and the rule is
narrow — when a transcript and its OWN summary both rank, the transcript
goes. Nothing becomes unreachable; the summary carries a [[wikilink]] to the
full text, and `search_memory` over transcript bodies is untouched, which is
how "which video mentioned Kimi K3" is answered.

The trap this exists to catch is a naming one. `summary_title` strips
" — full transcript" before appending " — summary", but every summary
already on disk was written before it did and reads
"X — full transcript — summary". A collapse rule that calls summary_title()
on each transcript matches NONE of them — the first implementation did
exactly that, changed nothing, and looked correct in code review.
"""

import asyncio
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


async def run() -> None:
    from app.memory.memory import OkfMemory, sandbox
    from app.summariser import SUMMARY_SUFFIX

    tmp = Path(tempfile.mkdtemp(prefix="nova-collapse-"))
    try:
        mem = OkfMemory(base_dir=str(tmp))
        await mem.startup()
        with sandbox(mem):
            # BOTH naming eras, because both exist in the live corpus.
            pairs = {
                # written before summary_title stripped the source suffix
                "Ducks: quacking at scale — full transcript":
                    "Ducks: quacking at scale — full transcript" + SUMMARY_SUFFIX,
                # written after
                "Geese: honking at scale — full transcript":
                    "Geese: honking at scale" + SUMMARY_SUFFIX,
            }
            for source, summary in pairs.items():
                await mem.write("quacking honking waterfowl migration telemetry "
                                "at enormous scale, verbatim and at length. " * 12,
                                type="topic", title=source, link_pass=False)
                await mem.write("Waterfowl telemetry at scale, distilled.",
                                type="topic", title=summary, link_pass=False)
            # a lone transcript with no summary must survive untouched
            await mem.write("swans gliding telemetry at scale " * 12,
                            type="topic", title="Swans: gliding at scale — full transcript",
                            link_pass=False)

            r = await mem.context("waterfowl telemetry at scale")
            titles = [mem.index.docs.get(i, {}).get("title", "") for i in r["memory_ids"]]

            check("every ranked video appears once", len(titles) == len(set(titles)),
                  str(titles))
            for source, summary in pairs.items():
                check(f"the summary wins over its own source ({source.split(':')[0]})",
                      summary in titles and source not in titles,
                      f"summary={summary in titles} source={source in titles}")
            check("...INCLUDING the historical 'X — full transcript — summary' "
                  "form, which the first implementation silently missed",
                  "Ducks: quacking at scale — full transcript" not in titles)
            check("a transcript with no summary is still retrieved — collapsing "
                  "is de-duplication, never a demotion of transcripts",
                  "Swans: gliding at scale — full transcript" in titles, str(titles))

            # the collapse must not fire on a doc that merely LOOKS like a pair
            got = mem._collapse_to_summaries([("a", 1.0)])
            check("a single result is never collapsed against itself", got == [("a", 1.0)])
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
