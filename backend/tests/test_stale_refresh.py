"""What can honestly go stale, and why a stamp is not enough.

    docker compose exec backend python tests/test_stale_refresh.py

`list_stale_topics` selected on a date alone. On the live corpus that put 202
of 220 topics on a refresh queue and produced 50 unattended automation runs
that all re-fetched the same three YouTube videos from 2026-07-22 — and never
could have succeeded, because a recorded video is immutable and fetch_url
cannot read a JS-rendered YouTube page anyway. A failed refresh never bumps
the timestamp, so those three stayed the oldest thing in the list forever.

Two properties, each of which failed in an interesting way while being built:

1. THE EXCLUSION IS DERIVED, NOT DECLARED. The primary signal is the ingest
   ledger, not the document's own frontmatter, because a stamp can be
   overwritten and one on disk already had been: an ingested transcript read
   `source_type: tool`. Membership in `media_ingests` is written by the
   backend at ingest and no model can forge it. Filtering on the stamp alone
   would have missed exactly the document that proves the point.

2. FILTERING RECORDINGS IS NOT ENOUGH. Excluding recordings leaves the four
   YouTube *channel* pages as the new oldest entries — same 2026-07-22 date,
   same unfetchability, same permanent wedge. They are excluded because their
   channel is in `source_subscriptions`, which is another automation's job.
   Unfollow the channel and the exclusion disappears by itself.

why_skip is a pure function over (doc_id, frontmatter, signals), so most of
this is hermetic. The monotone-origin section builds a real store in a temp
dir, because that guard lives in write_concept's merge.
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, "/app/backend")

from app.memory import immutable as im            # noqa: E402
from app.memory import provenance as pv           # noqa: E402
from app.memory.store import OkfStore             # noqa: E402

FAILURES: list[str] = []

LEDGER_ID = "topics/what-is-an-ai-harness-full-transcript.md"
LEDGER_URL = "https://www.youtube.com/watch?v=ofS-4RRw9zw"

# Built through the same helpers `signals()` uses, never hand-written, so the
# fixture cannot encode a key shape the production path does not produce. It
# already had: `urls` was raw here while signals() canonicalises it, so the two
# sides only matched by luck of spelling.
SIG = {
    "ids": {LEDGER_ID},
    "urls": {im.canonical(LEDGER_URL)},
    "feeds": im.feed_keys("https://www.youtube.com/@AILABS-393/videos"),
}


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def main() -> int:
    print("1. recordings cannot go stale")
    check("a media_transcript stamp is a recording",
          im.why_skip("topics/x.md", {"source_type": "media_transcript",
                                      "source_url": "https://y/v?v=1"}, SIG) == "recording")
    check("a doc in the ingest ledger is a recording even when its stamp says "
          "'tool' — the laundered case, and the reason the ledger is primary",
          im.why_skip(LEDGER_ID, {"source_type": "tool",
                                  "source_url": LEDGER_URL}, SIG) == "recording")
    check("a chunk deep-link (&t=930s) matches its recording's ledger URL",
          im.why_skip("topics/chunk.md",
                      {"source_type": "chat",
                       "source_url": LEDGER_URL + "&t=930s"}, SIG) == "recording")
    check("a #t= fragment is stripped too",
          im.canonical("https://ex.com/a.mp3#t=12") == "https://ex.com/a.mp3")

    print("2. a followed channel is another automation's job")
    check("the bare channel URL matches the /videos feed that is subscribed",
          im.why_skip("topics/ch.md",
                      {"source_type": "tool",
                       "source_url": "https://www.youtube.com/@AILABS-393"},
                      SIG) == "followed_source")
    check("/streams is the same channel page, whatever the case or the www.",
          im.is_followed_page("https://WWW.YouTube.com/@ailabs-393/streams",
                              SIG["feeds"]))
    check("a bare host is never a feed key — otherwise following one page "
          "would exclude the whole site",
          im.parent_key("https://example.com/feed.xml") is None
          and im.feed_keys("https://example.com/feed.xml")
          == {"example.com/feed.xml"})
    check("an individual video is NOT a followed page — it is the ledger's "
          "job to exclude those, and only if it really ingested them",
          not im.is_followed_page("https://www.youtube.com/watch?v=ofS",
                                  SIG["feeds"]))
    check("a followed source no longer swallows its whole subtree: the "
          "sibling of the feed matches, a deeper page does not",
          im.is_followed_page("https://example.com/blog/post-1",
                              im.feed_keys("https://example.com/blog/feed"))
          and not im.is_followed_page("https://example.com/blog/2026/post-1",
                                      im.feed_keys("https://example.com/blog/feed")))
    check("an unfollowed channel is NOT skipped — the signal is derived, so "
          "unfollowing restores staleness with no edit here",
          im.why_skip("topics/ch2.md",
                      {"source_type": "tool",
                       "source_url": "https://www.youtube.com/@SomeoneElse"},
                      SIG) is None)

    print("3. summaries are regenerated, never re-fetched")
    check("a ' — summary' title is skipped",
          im.why_skip("topics/s.md",
                      {"source_type": "tool", "title": "Poolside — summary",
                       "source_url": "https://poolside.ai/models"}, SIG) == "summary")

    print("4. a real page still goes stale")
    check("an ordinary sourced page is not skipped",
          im.why_skip("topics/k.md",
                      {"source_type": "tool", "title": "CMP rates",
                       "source_url": "http://www.maine.gov/energy/electricity-prices"},
                      SIG) is None)
    check("empty signals exclude nothing (the eval-replay path)",
          im.why_skip(LEDGER_ID, {"source_type": "tool",
                                  "source_url": LEDGER_URL},
                      im.empty_signals()) is None)

    print("5. origin is monotone through write_concept's merge")
    with tempfile.TemporaryDirectory() as tmp:
        store = OkfStore(tmp)
        p = Path(tmp) / "topics" / "t.md"

        def write(prior_fm, incoming_st):
            body = "\n".join(f"{k}: {v}" for k, v in prior_fm.items())
            p.write_text(f"---\n{body}\n---\n\nbody\n")
            store.write_concept("topic", "T", "new body",
                                metadata={"source_type": incoming_st},
                                doc_id="topics/t.md")
            return store.parse_frontmatter(p.read_text())[0]

        got = write({"type": "topic", "source_type": "media_transcript"}, "tool")
        check("a REFRESH cannot raise media_transcript to tool — the live "
              "laundering, refused", got.get("source_type") == "media_transcript",
              f"got {got.get('source_type')!r}")

        got = write({"type": "topic", "source_type": "chat"}, "tool")
        check("conversation is not raised to tool either",
              got.get("source_type") == "chat", f"got {got.get('source_type')!r}")

        got = write({"type": "topic", "source_type": "tool"}, "media_transcript")
        check("a legitimate DEMOTION still goes through — this is what "
              "comparing tiers buys over comparing the raw stamps",
              got.get("source_type") == "media_transcript",
              f"got {got.get('source_type')!r}")

        got = write({"type": "topic"}, "tool")
        check("an ABSENT prior stamp never writes the string 'None'",
              got.get("source_type") == "tool", f"got {got.get('source_type')!r}")

    print("6. tiers behave as the guard assumes")
    check("lower_of ranks TIERS, not source_type strings — feeding it raw "
          "stamps collapses everything to third_party",
          pv.lower_of("media_transcript", "tool") == pv.THIRD_PARTY)
    check("comparing via tier() gets it right",
          pv.lower_of(pv.tier("media_transcript"), pv.tier("tool"))
          == pv.THIRD_PARTY)

    print("7. migration 085 corrects the live instruction")
    sql = (Path("/app/backend/app/migrations/"
                "085_stale_refresh_excludes_recordings.sql").read_text())
    # The header comment quotes the false sentence to explain it and the WHERE
    # guard matches on it on purpose, so assert against the new instruction
    # literal itself rather than the file.
    new_instruction = sql.split("instruction = '", 1)[1].split("',\n", 1)[0]
    check("the false 'removes it from the stale list' promise is gone from the "
          "instruction the agent will actually read",
          "that removes it from the stale list" not in new_instruction)
    check("it still tells the agent what to do instead of writing that note",
          "do NOT write a note" in new_instruction)
    check("the literal 'nothing stale' survives — scheduler.py:175 matches it "
          "to suppress a journal entry on a clean run",
          '"nothing stale"' in new_instruction)
    check("it is idempotent and will not clobber a hand-rewrite",
          "AND instruction LIKE" in sql)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
