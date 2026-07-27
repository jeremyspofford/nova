"""Where a memory came from — phase 1 of the containment plan.

    docker compose exec backend python tests/test_provenance.py

87% of Nova's topic memory is verbatim third-party text, and all of it is
BM25-retrieved into her prompt. Today that is a content problem; the moment
she can execute, it is a remote-code-execution chain. Phase 2 turns this
into a refusal at execute_tool. Phase 1 only has to make the origin TRUE,
available, and impossible to launder.

Three properties, each of which failed in an interesting way while being
built:

1. FAIL CLOSED. Unknown origin is third_party. A rail that fails OPEN on
   missing data is not a rail, and every document written before this
   existed has no stamp.

2. THE MECHANISM IS NOT THE WRITER. `write_memory` stamps
   source_type="tool" for every caller, and `ingestion` — whose entire job
   is fetching web pages — holds write_memory. So the least trustworthy
   content in the system carried the most trusted-looking stamp. Trust is
   derived from what the WRITER was granted, and from the document's own
   source_url. Measured on the live corpus: 9 of the 13 topics stamped
   "tool" carried a source_url, so without that correction they counted as
   the operator's own material.

3. MONOTONE. An append may lower a document's trust, never raise it.
   `append_concept` preserves the target's frontmatter, so without this an
   agent holding fetched content could append into a first-party note and
   have the delta inherit its stamp — laundering in one call, using the
   feature built for digests.
"""

import sys

sys.path.insert(0, "/app/backend")

from app.memory import provenance as pv          # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def main() -> int:
    print("1. fail closed")
    check("no stamp at all is third_party", pv.tier(None) == pv.THIRD_PARTY)
    check("an unrecognised stamp is third_party",
          pv.tier("something-new") == pv.THIRD_PARTY)
    check("empty string is third_party", pv.tier("") == pv.THIRD_PARTY)

    print("2. the tiers")
    check("an ingested transcript is third_party",
          pv.tier("media_transcript") == pv.THIRD_PARTY)
    check("a followed source is third_party",
          pv.tier("subscription") == pv.THIRD_PARTY)
    check("a journal is conversation, not first_party",
          pv.tier("journal") == pv.CONVERSATION)
    check("a tool write with no world reach is first_party",
          pv.tier("tool") == pv.FIRST_PARTY)

    print("3. the mechanism is not the writer")
    check("the same write by a world-reading agent is third_party",
          pv.tier("tool", writer_world_reading=True) == pv.THIRD_PARTY)
    check("a source_url alone demotes it — this is the 9-of-13 case",
          pv.tier("tool", has_source_url=True) == pv.THIRD_PARTY)
    check("ingestion's grants make it world-reading",
          pv.writer_is_world_reading(["web_search", "fetch_url", "write_memory"]))
    check("main's grants do not",
          not pv.writer_is_world_reading(
              ["search_memory", "write_memory", "read_memory_item"]))
    check("an UNRESTRICTED agent counts as world-reading — it holds "
          "everything, including fetch_url",
          pv.writer_is_world_reading(None))
    check("derived from grants, not from a name: a new agent given "
          "fetch_url is distrusted with no edit",
          pv.writer_is_world_reading(["some_new_tool", "fetch_url"]))

    print("4. monotone — append may lower trust, never raise it")
    check("third_party into first_party stays third_party",
          pv.lower_of(pv.FIRST_PARTY, pv.THIRD_PARTY) == pv.THIRD_PARTY)
    check("...in either order",
          pv.lower_of(pv.THIRD_PARTY, pv.FIRST_PARTY) == pv.THIRD_PARTY)
    check("conversation into first_party becomes conversation",
          pv.lower_of(pv.FIRST_PARTY, pv.CONVERSATION) == pv.CONVERSATION)
    check("first_party into first_party is unchanged",
          pv.lower_of(pv.FIRST_PARTY, pv.FIRST_PARTY) == pv.FIRST_PARTY)
    check("an unknown tier drags it down",
          pv.lower_of(pv.FIRST_PARTY, "nonsense") == pv.THIRD_PARTY)

    print("5. is_trusted is narrow on purpose")
    check("only first_party is trusted", pv.is_trusted(pv.FIRST_PARTY))
    check("conversation is NOT trusted — a transcript can quote a web page, "
          "or Nova's own mistaken claim, back into a later prompt",
          not pv.is_trusted(pv.CONVERSATION))
    check("third_party is not trusted", not pv.is_trusted(pv.THIRD_PARTY))
    check("None is not trusted", not pv.is_trusted(None))

    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
