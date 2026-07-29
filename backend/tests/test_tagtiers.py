"""What a tag is allowed to bridge — and why frequency alone gets it wrong.

    docker compose exec backend python tests/test_tagtiers.py

This replaced a 77-entry hand-maintained blocklist. The measured motivation:
71 of those 77 entries named tags this deployment has never seen, and the
comment above it instructed you to keep adding more.

The property that matters is NOT "does the derived rule reproduce today's
clustering" — a frequency-only rule does that too, and it is wrong anyway.
It reproduces it only because wiki-links happen to cover the same systems
right now, which is a coincidence of the summariser having run. Measured on
tag edges ALONE, a frequency ceiling shatters the live corpus from
[59, 30, 28, 24, 4, 3, 2, 2] into 58 pairs plus 36 orphans, because it
classifies `src-cloud-codes---videos` — on 59 of 155 documents, and the
single most meaningful tag in the corpus — as a category word.

So the test below is written against the mechanism, not the outcome: an
entity-backed tag must survive any frequency, and a category word must be
caught whether or not anybody listed it.
"""

import sys

sys.path.insert(0, "/app/backend")

from app.memory.tagtiers import (  # noqa: E402
    INERT, SEED_FLOOR, SPECIFIC, STRUCTURAL, TagTiers,
)

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def _corpus(n_videos=60):
    """A channel and its videos, plus a couple of unrelated notes.

    Shaped like the real thing: every video carries the channel tag AND the
    two ingestion format tags, so the channel tag and `transcript` have
    almost identical document frequency. Only their MEANING differs, which
    is the whole point.
    """
    docs = [("source", ["src-a-channel"])]
    for _ in range(n_videos):
        docs.append(("topic", ["src-a-channel", "media", "transcript"]))
    docs.append(("topic", ["bear-mountain", "hiking", "zoo"]))
    docs.append(("topic", ["bear-mountain"]))
    docs.append(("topic", ["me-at-the-zoo", "zoo"]))
    return docs


def test_entity_backing_beats_frequency():
    t = TagTiers(_corpus())
    check("channel tag is SPECIFIC despite being the most common tag",
          t.tier("src-a-channel") == SPECIFIC,
          f"df={t.df['src-a-channel']} ceiling={t.ceiling}")
    check("a frequency ceiling alone would have condemned it",
          t.df["src-a-channel"] > t.ceiling)
    check("format tags at the same frequency are STRUCTURAL",
          t.tier("transcript") == STRUCTURAL and t.tier("media") == STRUCTURAL)


def test_categories_are_caught_without_being_listed():
    """The derived half: a format tag nobody thought to add still gets caught."""
    docs = [("topic", ["weekly-roundup", f"subject-{i}"]) for i in range(40)]
    t = TagTiers(docs)
    check("an unlisted tag on most of the corpus is STRUCTURAL",
          t.tier("weekly-roundup") == STRUCTURAL
          and "weekly-roundup" not in SEED_FLOOR,
          f"df={t.df['weekly-roundup']} ceiling={t.ceiling}")


def test_rare_generics_still_need_the_floor():
    """The floor's whole justification, and the incident that created it.

    A hiking attraction was bridged to the "Me at the zoo" video through the
    coincidental word "zoo". At df 2 no frequency rule can see that.
    """
    t = TagTiers(_corpus())
    check("a rare category word is STRUCTURAL via the floor",
          t.tier("zoo") == STRUCTURAL, f"df={t.df['zoo']}")
    check("a rare NAMED subject at the same frequency still bridges",
          t.tier("bear-mountain") == SPECIFIC, f"df={t.df['bear-mountain']}")


def test_inert_is_not_a_verdict():
    """A brand-new specific tag bridges nothing yet — that is not the same as
    being generic, and detectors must not report it as such."""
    t = TagTiers(_corpus())
    check("a single-use tag is INERT, not STRUCTURAL",
          t.tier("me-at-the-zoo") == INERT and not t.is_structural("me-at-the-zoo"))
    check("INERT tags do not bridge", not t.bridges("me-at-the-zoo"))


def test_hysteresis_holds_a_tag_through_the_boundary():
    """A tag drifting across the ceiling must not flip a system between
    merged and split on consecutive 20s polls."""
    docs = [("topic", ["borderline"]) for _ in range(11)]
    docs += [("topic", [f"x{i}"]) for i in range(89)]
    t = TagTiers(docs)                       # ceiling 10, df 11 -> demoted
    check("over the ceiling, it demotes", t.tier("borderline") == STRUCTURAL,
          f"df={t.df['borderline']} ceiling={t.ceiling}")
    back = TagTiers(docs[1:], previous={"borderline": STRUCTURAL})
    check("dipping just under does NOT immediately promote it",
          back.tier("borderline") == STRUCTURAL,
          f"df={back.df['borderline']} ceiling={back.ceiling}")


def test_seed_floor_reports_its_own_redundancy():
    """The list has to be able to shrink mechanically, or it is just the old
    blocklist with extra steps."""
    t = TagTiers(_corpus())
    r = t.seed_redundant()
    check("entries absent from the corpus are reported",
          len(r["absent"]) > 50, f"{len(r['absent'])} absent")
    check("frequency-caught entries are reported as derived",
          "transcript" in r["derived"] and "media" in r["derived"])
    check("only genuinely rare generics remain load-bearing",
          "zoo" in r["load_bearing"])


def test_entity_vs_subject_is_the_membership_split():
    """The distinction the clustering turns on."""
    t = TagTiers(_corpus())
    check("a channel tag is entity-backed (membership)", t.is_entity("src-a-channel"))
    check("a subject tag is not (affinity)", not t.is_entity("bear-mountain"))


def test_affinity_gate_can_refuse_AND_can_fire():
    """A gate that can never fire is as useless as one that can never refuse.

    Both directions are tested because the real corpus answers NO, and a NO
    from a control that is simply broken looks identical to a true one.

    THREE clusters, not two. With a single pair there is nowhere else for a
    shuffle to put the sharing, so the null reproduces the observation by
    construction and nothing can ever clear. The statistic is about sharing
    being CONCENTRATED on particular pairs — that needs a pair to be
    concentrated against.
    """
    from app.subjects import affinity_report

    def corpus(bonded):
        """Three link-held clusters of 8. Clusters 0 and 1 share `bonded`
        subjects with each other; cluster 2 shares nothing with anyone."""
        nodes, edges = [], []
        for c in (0, 1, 2):
            for i in range(8):
                nid = f"c{c}-d{i}"
                tags = [f"src-ch{c}"]
                tags.append(f"bond-{i}" if (c < 2 and i < bonded)
                            else f"own-{c}-{i}")
                nodes.append({"id": nid, "type": "topic", "tags": tags})
                if i:
                    edges.append({"source": f"c{c}-d0", "target": nid, "kind": "link"})
            nodes.append({"id": f"src{c}", "type": "source", "tags": [f"src-ch{c}"]})
            edges.append({"source": f"src{c}", "target": f"c{c}-d0", "kind": "link"})
        return nodes, edges

    n, e = corpus(bonded=0)
    r = affinity_report(n, e, trials=200)
    check("three clusters, no shared subjects -> refuses",
          r["clusters"] == 3 and not r["draw"], r["reason"][:44])

    n, e = corpus(bonded=8)
    r = affinity_report(n, e, trials=200)
    top = r["pairs"][0]
    check("two of three bonded by subject -> fires on THAT pair",
          r["draw"] and top["clears"],
          f"obs={top['observed']} null_max={top['null_max']}")
    check("and only on that pair",
          sum(1 for x in r["pairs"] if x["clears"]) == 1)


def main():
    for fn in (test_entity_backing_beats_frequency,
               test_entity_vs_subject_is_the_membership_split,
               test_affinity_gate_can_refuse_AND_can_fire,
               test_categories_are_caught_without_being_listed,
               test_rare_generics_still_need_the_floor,
               test_inert_is_not_a_verdict,
               test_hysteresis_holds_a_tag_through_the_boundary,
               test_seed_floor_reports_its_own_redundancy):
        print(f"\n{fn.__name__}")
        fn()
    print("\n" + ("FAILURES: " + ", ".join(FAILURES) if FAILURES else "all passed"))
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
