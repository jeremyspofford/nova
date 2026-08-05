"""The watermark may only pass messages that were actually summarized.

    docker compose exec backend python tests/test_compaction_watermark.py

The rolling summary is not one document you can go back and fix — it is
merged forward and injected into the system prompt of every later turn in
the conversation, and `summary_upto` is a floor the next SELECT will not
reach back across. So a message that ends up below the watermark without
having been summarized is gone from the conversation's continuity for good,
silently, with no error anywhere.

That is what the transcript slice did. The SELECT has no LIMIT; the text
sent to the model was `"\\n\\n".join(parts)[:24_000]`; the watermark was
`rows[-1]["created_at"]` — the last row FETCHED. Whenever the aged set
overflowed the budget the NEWEST messages were cut from the summary and
buried by the same pass. Reachable in ordinary operation: compaction.min_aged
is allowed up to 100, and roughly 110 live messages fill the budget.

Every other way this function declines to summarize (LLM error, empty
summary, grounding refusal) deliberately leaves the watermark where it was,
so the messages are retried on a later turn. This pins that the over-budget
path behaves the same way: what was not summarized stays ABOVE the mark.

No DB and no model — the point under test is which row's timestamp is
written, so the pass runs against fakes and the assertion is on the value
handed to set_summary.
"""

import asyncio
import contextlib
import logging
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, "/app/backend")

# The turn ledger flushes in a background task that lands AFTER the fakes are
# restored, so it finds no pool and logs a traceback per pass. The ledger is
# not what is under test here and its own failure path is already correct
# (it swallows and warns) — quieted so a green run reads as green.
logging.getLogger("app.trace").setLevel(logging.CRITICAL)

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


BASE = datetime(2026, 8, 5, 9, 0, tzinfo=timezone.utc)


def make_rows(n: int, chars: int) -> list[dict]:
    """n aged messages, each `chars` long, one minute apart."""
    return [{"role": "user" if i % 2 == 0 else "assistant",
             "content": f"m{i:03d} " + ("lighthouse keeping notes " * 200)[:chars],
             "created_at": BASE + timedelta(minutes=i)}
            for i in range(n)]


class _FakeConn:
    def __init__(self, rows):
        self._rows = rows

    async def fetch(self, *a):
        return self._rows

    async def fetchval(self, *a):
        return None            # no previous summary

    async def execute(self, *a):
        return "OK"

    async def executemany(self, *a):
        return "OK"

    def transaction(self):
        return contextlib.nullcontext()


class _Harness:
    """Stands in for the DB, the model and conversations.set_summary."""

    def __init__(self, rows, summary="the operator talked about lighthouse keeping notes"):
        self.rows = rows
        self.summary = summary
        self.prompts: list[str] = []
        self.set_summary_calls: list[tuple] = []

    @contextlib.asynccontextmanager
    async def acquire(self):
        yield _FakeConn(self.rows)

    def effective_model(self, model):
        return model

    async def stream_chat(self, messages, model, **kw):
        self.prompts.append(messages[-1]["content"])
        yield {"type": "text", "text": self.summary}

    async def set_summary(self, conversation_id, summary, upto):
        self.set_summary_calls.append((conversation_id, summary, upto))


@contextlib.contextmanager
def patched(h):
    from app import compaction, conversations, db
    from app.llm import router as llm_router
    olds = (db.acquire, llm_router.effective_model, llm_router.stream_chat,
            conversations.set_summary)
    db.acquire = h.acquire                      # trace's flush uses this too
    llm_router.effective_model = h.effective_model
    llm_router.stream_chat = h.stream_chat
    conversations.set_summary = h.set_summary
    try:
        yield compaction
    finally:
        (db.acquire, llm_router.effective_model, llm_router.stream_chat,
         conversations.set_summary) = olds


CONV = "11111111-2222-3333-4444-555555555555"


async def test_over_budget():
    print("an over-budget pass leaves the un-summarized rows ABOVE the mark")
    from app import compaction

    rows = make_rows(120, 500)
    h = _Harness(rows)
    with patched(h):
        await compaction.maybe_compact(CONV, "testmodel",
                                       (BASE + timedelta(days=1)).isoformat())

    check("the summary was written", len(h.set_summary_calls) == 1,
          str(len(h.set_summary_calls)))
    if not h.set_summary_calls:
        return
    upto = h.set_summary_calls[0][2]
    sent = h.prompts[0]

    check("the transcript sent to the model is within the budget",
          len(sent) <= compaction._MAX_TRANSCRIPT_CHARS + 200,
          f"{len(sent)} chars")
    check("it did NOT swallow all 120 rows", upto < rows[-1]["created_at"],
          f"upto={upto} last={rows[-1]['created_at']}")

    included = [r for r in rows if r["created_at"] <= upto]
    deferred = [r for r in rows if r["created_at"] > upto]
    check("more than one row made it in — the budget is not the bug",
          len(included) > 1, str(len(included)))
    check("some rows were deferred, or this case never happened",
          len(deferred) > 0, str(len(deferred)))

    # THE defect: a message under the watermark that the model never saw is
    # excluded from every future summary and from the verbatim window alike.
    missed = [r for r in included if r["content"][:4] not in sent]
    check("every row below the watermark was in the text sent to the model",
          not missed, f"{len(missed)} buried unread")
    leaked = [r for r in deferred if r["content"][:4] in sent]
    check("and nothing above it was summarized early", not leaked, str(len(leaked)))

    # Deferred is not dropped: later passes pick it up. Each pass must move
    # the mark strictly forward, or "retried later" is an infinite loop that
    # never summarizes anything.
    remaining, passes, stalled = deferred, 1, False
    while remaining and passes < 20:
        h2 = _Harness(remaining)
        with patched(h2):
            await compaction.maybe_compact(CONV, "testmodel",
                                           (BASE + timedelta(days=1)).isoformat())
        if not h2.set_summary_calls:
            break
        mark = h2.set_summary_calls[0][2]
        after = [r for r in remaining if r["created_at"] > mark]
        if len(after) == len(remaining):
            stalled = True
            break
        remaining, passes = after, passes + 1
    check("every deferred row is eventually summarized, in a bounded number "
          "of passes", not remaining and not stalled,
          f"{len(remaining)} left after {passes} passes, stalled={stalled}")


async def test_under_budget():
    print("an ordinary pass still consumes everything it fetched")
    from app import compaction

    rows = make_rows(12, 200)
    h = _Harness(rows)
    with patched(h):
        await compaction.maybe_compact(CONV, "testmodel",
                                       (BASE + timedelta(days=1)).isoformat())
    check("the watermark reaches the last row",
          h.set_summary_calls and h.set_summary_calls[0][2] == rows[-1]["created_at"],
          str(h.set_summary_calls[0][2]) if h.set_summary_calls else "no call")


async def test_forward_progress():
    print("a single row that cannot fit is still consumed, so the mark moves")
    from app import compaction

    # Slack today (800 chars per message against 24,000), so this is only
    # reachable by raising _MAX_MSG_CHARS above _MAX_TRANSCRIPT_CHARS. A
    # budget check that ran before the first row would stall the watermark
    # forever on that day, and the conversation would never compact again.
    rows = make_rows(12, 200)
    h = _Harness(rows)
    old = compaction._MAX_TRANSCRIPT_CHARS
    compaction._MAX_TRANSCRIPT_CHARS = 10
    try:
        with patched(h):
            await compaction.maybe_compact(CONV, "testmodel",
                                           (BASE + timedelta(days=1)).isoformat())
    finally:
        compaction._MAX_TRANSCRIPT_CHARS = old
    check("exactly the first row is summarized and the watermark advances",
          h.set_summary_calls and h.set_summary_calls[0][2] == rows[0]["created_at"],
          str(h.set_summary_calls[0][2]) if h.set_summary_calls else "no call")


async def main() -> int:
    await test_over_budget()
    print()
    await test_under_budget()
    print()
    await test_forward_progress()
    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
