"""app/checks/review.py — the one check whose findings are a model's claims.

Three of the four watch areas are code reading rows. This one asks a model, so
what these tests pin is not "does it find things" but the four lines of code
that stand between a model's sentence and a notice:

  * a CITATION IS VERIFIED. Two commitments come back, one citing a real
    message of his and one citing an id nobody wrote; exactly one becomes a
    finding, and its facts quote the ROW rather than the paraphrase, so the
    fingerprint is over something the database holds;
  * a message that is not HIS — her own reply in his conversation — is not
    citable either, because the window and the verification are both `role =
    'user'`;
  * an answer that says nothing usable is a pass that LOOKED: ran=True with no
    findings. A gateway or a memory service that could not be reached is not:
    ran=False with the reason, because a narrower window reported as a clean
    pass is the false all-clear this slice exists to stop;
  * it is NEVER urgent — asserted from the registry and, independently, by
    handing the family a finding that declares itself urgent and watching the
    registry overwrite it;
  * and it does not run every hour. The cadence is read from the watch beat's
    own firing history, and a pass inside the interval does not reach the
    gateway at all — it is ran=False with the reason, never an empty run,
    because an empty run would let the beat clear every commitment it was
    holding (only a check that RAN reconciles).
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import timedelta

import httpx
import pytest

from app import beats, checks, identity
from app.checks import Finding, review
from app.main import app as core_app
from tests import fakes
from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory

pytestmark = requires_db

# What he wrote, and what a model might call it. Deliberately share no words:
# every assertion below about "the row, not the paraphrase" would pass by
# accident if one were a substring of the other.
GARAGE = "I'll sort out the garage door before Sunday, it's been sticking for weeks."
PARAPHRASE = "replace the opener"
INVENTED = "book the dentist"
HER_PROMISE = "I'll rerun the backup tonight."


class _Dead(httpx.AsyncBaseTransport):
    """A peer whose socket refuses — a real httpx error, not a patched call."""

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)


async def _owner(pool) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('jeremy','owner') RETURNING id"
    )


async def _conversation(pool, person_id) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", person_id
    )


async def _message(pool, conversation_id, content, *, role="user", ago=timedelta()) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO messages (conversation_id, role, content, created_at) "
        "VALUES ($1, $2, $3, now() - $4::interval) RETURNING id",
        conversation_id,
        role,
        content,
        ago,
    )


def _answer(*items: tuple[uuid.UUID, str]) -> str:
    """The model's answer in the shape the check asks for, fenced — the fence
    is there on purpose, because a small model writes one and the parser has to
    survive it."""
    body = json.dumps([{"message_id": str(mid), "commitment": said} for mid, said in items])
    return f"Here's what I found:\n```json\n{body}\n```"


def _gateway(*items: tuple[uuid.UUID, str], text: str | None = None) -> FakeGateway:
    """A gateway that answers with this script, split across two deltas so the
    check has to concatenate the stream like a real one."""
    body = _answer(*items) if text is None else text
    middle = len(body) // 2
    return FakeGateway(deltas=(body[:middle], body[middle:]))


def _brief(gateway: FakeGateway) -> str:
    """The user message the check actually sent to the gateway."""
    bodies = [
        body for path, body in gateway.seen if path == "/v1/chat/completions" and body is not None
    ]
    return bodies[-1]["messages"][1]["content"]


async def _watch_timer(pool) -> uuid.UUID:
    """The seeded watch beat's row id, through beats.ensure_beats — the same
    seeding the scheduler does, so the cadence tests read a real row."""
    assert await beats.ensure_beats(pool)
    return await pool.fetchval(
        "SELECT id FROM timers WHERE kind = $1 AND payload->>'handler' = $2",
        beats.BEAT_KIND,
        beats.WATCH,
    )


async def _firing(pool, timer_id, *, ago: timedelta, ran=(review.CHECK_NAME,), could_not=None):
    """One recorded watch pass, exactly as beats.WatchResult.as_delivery writes
    it: which checks ran, which could not."""
    await pool.execute(
        "INSERT INTO timer_firings (timer_id, scheduled_for, started_at, ended_at, status, "
        "delivery) VALUES ($1, now() - $2::interval, now() - $2::interval, "
        "now() - $2::interval, 'ok', $3::jsonb)",
        timer_id,
        ago,
        # A dict, not a json string: the pool's jsonb codec encodes it, and a
        # pre-dumped string would land in the column as a JSON *string* — which
        # is exactly how a delivery record stops matching the query that reads
        # it, silently.
        {"watch": {"ran": list(ran), "could_not": dict(could_not or {})}},
    )


# ── the citation is verified ───────────────────────────────────────────────


async def test_a_fabricated_citation_is_dropped_and_the_facts_quote_the_row(pool, mount_peers):
    """Two commitments, one citing a real message of his and one citing an id
    nobody ever wrote. Exactly one survives, and what it carries is the row."""
    person = await _owner(pool)
    conversation = await _conversation(pool, person)
    real = await _message(pool, conversation, GARAGE)
    said_at = await pool.fetchval("SELECT created_at FROM messages WHERE id = $1", real)
    gateway = _gateway((real, PARAPHRASE), (uuid.uuid4(), INVENTED))
    mount_peers(gateway=gateway, memory=FakeMemory())

    run = await checks.run_one(core_app, pool, review.CHECK_NAME)

    assert run.ran, run.reason
    assert len(run.findings) == 1, run.findings
    finding = run.findings[0]
    assert finding.key == f"commitment:{real}"
    # The facts are the ROW's: its id, when he wrote it, and what it says.
    assert finding.facts == {
        "message_id": str(real),
        "said_at": said_at.isoformat(),
        "quote": GARAGE,
    }
    # The paraphrase is the model's, so it is in the sentence and nowhere the
    # fingerprint can see it.
    assert PARAPHRASE not in json.dumps(finding.facts)
    assert PARAPHRASE in finding.title and GARAGE in finding.title
    # And nothing at all survived of the finding whose citation was invented.
    assert INVENTED not in finding.title and INVENTED not in json.dumps(finding.facts)


async def test_the_fingerprint_is_the_row_so_a_second_pass_is_the_same_news(pool, mount_peers):
    """Asked twice, the same message yields the same fingerprint — even when
    the model re-words the commitment. That is what folds a repeat onto one
    notice instead of pushing it again."""
    person = await _owner(pool)
    conversation = await _conversation(pool, person)
    real = await _message(pool, conversation, GARAGE)
    mount_peers(gateway=_gateway((real, PARAPHRASE)), memory=FakeMemory())
    first = await checks.run_one(core_app, pool, review.CHECK_NAME)

    mount_peers(gateway=_gateway((real, "do the thing with the door")), memory=FakeMemory())
    second = await checks.run_one(core_app, pool, review.CHECK_NAME)

    assert first.ran and second.ran
    assert first.findings[0].title != second.findings[0].title
    assert checks.fingerprint(first.findings[0]) == checks.fingerprint(second.findings[0])


async def test_her_own_reply_is_not_a_commitment_of_his(pool, mount_peers):
    """An assistant row lives in his conversation and belongs to him, so only
    `role = 'user'` keeps her promises out of his list — in the window AND in
    the verification, which is why citing one directly still yields nothing."""
    person = await _owner(pool)
    conversation = await _conversation(pool, person)
    # His message is what puts a window there at all; hers is the one cited.
    await _message(pool, conversation, GARAGE)
    hers = await _message(pool, conversation, HER_PROMISE, role="assistant")
    gateway = _gateway((hers, "rerun the backup"))
    mount_peers(gateway=gateway, memory=FakeMemory())

    run = await checks.run_one(core_app, pool, review.CHECK_NAME)

    # It looked (his message was in the window) and reported nothing.
    assert run.ran and run.findings == ()
    # And her reply was never in front of the model to be read as his.
    assert HER_PROMISE not in _brief(gateway)


async def test_the_window_is_his_recent_messages_and_memory_is_background(pool, mount_peers):
    """What the model is shown: his messages inside the window, each headed by
    the id it must cite, plus memory's notes marked as background."""
    person = await _owner(pool)
    conversation = await _conversation(pool, person)
    recent = await _message(pool, conversation, GARAGE, ago=timedelta(days=2))
    await _message(pool, conversation, "I'll paint the shed", ago=review.WINDOW + timedelta(days=1))
    gateway = _gateway(text="[]")
    memory = FakeMemory(results=({"title": "house", "snippet": "he owes the council a form"},))
    mount_peers(gateway=gateway, memory=memory)

    run = await checks.run_one(core_app, pool, review.CHECK_NAME)

    assert run.ran and run.findings == ()
    brief = _brief(gateway)
    assert str(recent) in brief and GARAGE in brief
    # Older than the window: not shown, so it cannot be cited.
    assert "paint the shed" not in brief
    # The note is there, and it is labelled as something that cannot be cited.
    assert "he owes the council a form" in brief and "cannot" in brief
    assert memory.recalls and memory.recalls[0]["person_id"] == str(person)


# -- the brief never states a falsehood about her memory ---------------------
#
# MAJOR 3 of the adversarial review, 2026-09-10. `_notes` read the recall body
# through `_results_from` alone, discarding memory's statement and its
# retriever report, so `_brief` had two states: notes, or the flat claim "Her
# memory returned no note bearing on this."
#
# That claim was written even when the meaning half of memory's search never
# ran — and this is the caller most likely to be in that state. The embedder's
# keep-alive is DERIVED from this very beat's cadence, so on a quiet machine
# the hourly watch is the first thing to ask for the model and a cold load
# (measured 1,444-1,728 ms) does not fit the 1.6 s query budget.

REDUCED_RETRIEVERS = (
    {"name": "lexical", "ran": True, "ranked": 2},
    {
        "name": "semantic",
        "ran": False,
        "reason": "the embedding service at http://ollama:11434 did not answer within 1.6s",
    },
)
PARTIAL_RETRIEVERS = (
    {"name": "lexical", "ran": True, "ranked": 2},
    {
        "name": "semantic",
        "ran": True,
        "ranked": 1,
        "coverage": "12 of 47 notes in this scope are embedded",
    },
)
REDUCED_STATEMENT = (
    "These notes hold no answer to that — nothing in these notes contains any of the words "
    "that were asked about. This search did not use every retriever it has: semantic (the "
    "embedding service at http://ollama:11434 did not answer within 1.6s). A note that says "
    "the same thing in different words could have been missed."
)


async def test_an_empty_recall_from_half_a_search_is_not_reported_as_no_note(pool, mount_peers):
    """The falsehood, and what replaces it: memory's own words."""
    person = await _owner(pool)
    conversation = await _conversation(pool, person)
    await _message(pool, conversation, GARAGE)
    gateway = _gateway(text="[]")
    mount_peers(
        gateway=gateway,
        memory=FakeMemory(
            results=(),
            recall_statement=REDUCED_STATEMENT,
            recall_retrievers=REDUCED_RETRIEVERS,
        ),
    )

    run = await checks.run_one(core_app, pool, review.CHECK_NAME)

    # It still reports: the window this check is defined over is HIS messages,
    # and every one of them was read (see review._notes for why this is not
    # CannotCheck).
    assert run.ran and run.findings == ()
    brief = _brief(gateway)
    assert "Her memory returned no note bearing on this." not in brief
    assert "the search that looked was not the full one" in brief
    assert "did not answer within 1.6s" in brief
    assert "a limit on the search and not as evidence about the notes" in brief


async def test_notes_from_a_search_over_part_of_the_corpus_carry_the_caveat(pool, mount_peers):
    """Notes came back, and they came out of a quarter of her notes. The
    caveat goes beside them rather than replacing them — and the model is told
    that findings still rest on his messages, which WERE read whole."""
    person = await _owner(pool)
    conversation = await _conversation(pool, person)
    await _message(pool, conversation, GARAGE)
    gateway = _gateway(text="[]")
    mount_peers(
        gateway=gateway,
        memory=FakeMemory(
            results=({"title": "house", "snippet": "he owes the council a form"},),
            recall_statement=(
                "1 note(s) matched and cleared the relevance floor, best match first. The "
                "semantic search covered only part of the notes — 12 of 47 notes in this "
                "scope are embedded."
            ),
            recall_retrievers=PARTIAL_RETRIEVERS,
        ),
    )

    run = await checks.run_one(core_app, pool, review.CHECK_NAME)

    assert run.ran and run.findings == ()
    brief = _brief(gateway)
    assert "he owes the council a form" in brief
    assert "12 of 47 notes in this scope are embedded" in brief
    assert "messages above were read whole" in brief


async def test_a_whole_search_that_found_nothing_still_says_so_plainly(pool, mount_peers):
    """The caveat is not boilerplate. When memory searched with everything it
    has and had nothing, the flat sentence is TRUE and stays."""
    person = await _owner(pool)
    conversation = await _conversation(pool, person)
    await _message(pool, conversation, GARAGE)
    gateway = _gateway(text="[]")
    mount_peers(
        gateway=gateway,
        memory=FakeMemory(
            results=(),
            recall_statement="These notes hold no answer to that.",
            recall_retrievers=(
                {"name": "lexical", "ran": True, "ranked": 0},
                {"name": "semantic", "ran": True, "ranked": 0},
            ),
        ),
    )

    run = await checks.run_one(core_app, pool, review.CHECK_NAME)

    assert run.ran and run.findings == ()
    brief = _brief(gateway)
    assert "Her memory returned no note bearing on this." in brief
    assert "not the full one" not in brief
    assert "limit on the search" not in brief


async def test_a_memory_service_that_cannot_be_asked_is_still_cannot_check(pool, mount_peers):
    """The line that does NOT move. A reduced search read a narrower slice of
    her notes; a memory service that did not answer read none of them, and this
    check is defined over a window it could not then assemble."""
    person = await _owner(pool)
    conversation = await _conversation(pool, person)
    await _message(pool, conversation, GARAGE)
    mount_peers(gateway=_gateway(text="[]"), memory=None)
    core_app.state.peer_transports = {fakes.MEMORY_URL: _Dead()}

    run = await checks.run_one(core_app, pool, review.CHECK_NAME)

    assert run.ran is False
    assert "narrower window than the check is defined over" in (run.reason or "")


async def test_the_memory_query_is_about_commitments_and_never_about_his_name(pool, mount_peers):
    """S13, live bug: the query was built by interpolating `owner.name`, which
    is an email address. The tokeniser split it and "com" — a token in every URL
    the notes quote — became the query's highest-scoring term, so this check's
    background was whichever note held the most links.

    Pinned mechanically rather than by reading the constant: whatever the query
    says, the owner's name and every piece of it must be absent from it, and it
    has to be about the thing the check is looking for.
    """
    person = await _owner(pool)
    # The live shape: on the running stack the owner's name IS an email
    # address, which is how "com" got to be this query's best term.
    await pool.execute(
        "UPDATE people SET name = 'jeremyspofford@example.com' WHERE id = $1", person
    )
    owner = await identity.owner(pool)
    conversation = await _conversation(pool, person)
    await _message(pool, conversation, GARAGE, ago=timedelta(days=2))
    memory = FakeMemory(results=())
    mount_peers(gateway=_gateway(text="[]"), memory=memory)

    run = await checks.run_one(core_app, pool, review.CHECK_NAME)
    assert run.ran

    (recall,) = memory.recalls
    query = recall["query"].lower()
    assert owner.name, "the fixture owner must have a name for this test to mean anything"
    assert owner.name.lower() not in query
    for piece in re.split(r"[^a-z0-9]+", owner.name.lower()):
        # "com", "gmail", the local part: none of them are evidence about a
        # promise, and one of them was the top-scoring term in this query.
        assert piece and piece not in re.split(r"[^a-z0-9]+", query)
    assert "promised" in query and "commitment" in query


async def test_the_call_says_who_is_paying_and_what_it_is_for(pool, mount_peers):
    """The gateway meters every call. A check has no turn to attribute to, so
    what it CAN say it says: the purpose is this check's own name, the person
    is the owner, and the role is the one a beat's rounds walk."""
    person = await _owner(pool)
    conversation = await _conversation(pool, person)
    await _message(pool, conversation, GARAGE)
    gateway = _gateway(text="[]")
    mount_peers(gateway=gateway, memory=FakeMemory())

    assert (await checks.run_one(core_app, pool, review.CHECK_NAME)).ran

    headers = gateway.seen_headers[-1]
    assert headers["x-nova-purpose"] == review.CHECK_NAME
    assert headers["x-nova-person"] == str(person)
    assert headers["x-nova-role"] == "beat"


# ── an answer that says nothing is a pass that looked ──────────────────────


async def test_an_unparseable_answer_is_a_pass_with_nothing_to_report(pool, mount_peers):
    """The model was asked and answered prose. It genuinely looked, so this is
    ran=True with no findings — not a CannotCheck, which would say the world
    was never read."""
    person = await _owner(pool)
    conversation = await _conversation(pool, person)
    await _message(pool, conversation, GARAGE)
    mount_peers(
        gateway=_gateway(text="Honestly, nothing he said this week looks unfinished to me."),
        memory=FakeMemory(),
    )

    run = await checks.run_one(core_app, pool, review.CHECK_NAME)

    assert run.ran and run.reason is None
    assert run.findings == ()


async def test_an_answer_of_only_invented_citations_reports_nothing(pool, mount_peers):
    """Well-formed, confident, and citing two messages that do not exist. The
    verification is a query, so none of it survives."""
    person = await _owner(pool)
    conversation = await _conversation(pool, person)
    await _message(pool, conversation, GARAGE)
    mount_peers(
        gateway=_gateway((uuid.uuid4(), INVENTED), (uuid.uuid4(), "cancel the gym")),
        memory=FakeMemory(),
    )

    run = await checks.run_one(core_app, pool, review.CHECK_NAME)

    assert run.ran and run.findings == ()


async def test_nothing_of_his_in_the_window_never_reaches_the_model(pool, mount_peers):
    """No messages, no question: a pass that read an empty window is ran=True
    with no findings, and it does not pay for a completion to learn that."""
    await _owner(pool)
    gateway = _gateway(text="[]")
    mount_peers(gateway=gateway, memory=FakeMemory())

    run = await checks.run_one(core_app, pool, review.CHECK_NAME)

    assert run.ran and run.findings == ()
    assert gateway.seen == []


# ── a peer that could not be reached is never a clean pass ─────────────────


async def test_a_gateway_that_cannot_be_reached_is_ran_false_with_the_reason(pool, mount_peers):
    person = await _owner(pool)
    conversation = await _conversation(pool, person)
    await _message(pool, conversation, GARAGE)
    mount_peers(gateway=FakeGateway(), memory=FakeMemory())
    core_app.state.peer_transports[fakes.GATEWAY_URL] = _Dead()

    run = await checks.run_one(core_app, pool, review.CHECK_NAME)

    assert run.ran is False and run.findings == ()
    assert "gateway" in run.reason and "connection refused" in run.reason


async def test_a_gateway_that_refuses_says_the_status_it_refused_with(pool, mount_peers):
    person = await _owner(pool)
    conversation = await _conversation(pool, person)
    await _message(pool, conversation, GARAGE)
    mount_peers(gateway=FakeGateway(status=503), memory=FakeMemory())

    run = await checks.run_one(core_app, pool, review.CHECK_NAME)

    assert run.ran is False and "503" in run.reason


async def test_memory_that_cannot_be_reached_is_stated_not_a_narrower_window(pool, mount_peers):
    """A commitment he made and she wrote down lives in memory. Reading his
    messages alone and reporting the result would be a smaller world reported
    as a clean pass, so the pass states it instead — and never spends the
    completion."""
    person = await _owner(pool)
    conversation = await _conversation(pool, person)
    await _message(pool, conversation, GARAGE)
    gateway = _gateway(text="[]")
    mount_peers(gateway=gateway, memory=FakeMemory())
    core_app.state.peer_transports[fakes.MEMORY_URL] = _Dead()

    run = await checks.run_one(core_app, pool, review.CHECK_NAME)

    assert run.ran is False and run.findings == ()
    assert "memory" in run.reason and "narrower window" in run.reason
    assert gateway.seen == []


# ── never urgent ───────────────────────────────────────────────────────────


def test_the_review_family_declares_no_urgency():
    """Jeremy's urgent list has one entry and this is not it. Asserted against
    the live registry, so registering this family cannot have moved the set."""
    assert review.CHECK_NAME in checks.REGISTRY
    assert checks.REGISTRY[review.CHECK_NAME].urgent is False
    assert review.CHECK_NAME not in checks.urgent_names()
    assert not set(review.NAMES) & set(checks.urgent_names())


async def test_a_review_finding_cannot_promote_itself(pool, mount_peers, monkeypatch):
    """Even handed a finding that declares itself urgent, the registry
    overwrites it with the family's declaration — the same line of code that
    stops any check promoting its own news, asserted for THIS family because
    this is the one whose findings a model influences."""
    person = await _owner(pool)
    conversation = await _conversation(pool, person)
    real = await _message(pool, conversation, GARAGE)

    async def _urgent(pool, owner, items, window):
        return [Finding(key="commitment:x", title="urgent by fiat", facts={"a": 1}, urgent=True)]

    monkeypatch.setattr(review, "_verified", _urgent)
    mount_peers(gateway=_gateway((real, PARAPHRASE)), memory=FakeMemory())

    run = await checks.run_one(core_app, pool, review.CHECK_NAME)

    assert run.ran and len(run.findings) == 1
    assert run.findings[0].urgent is False


# ── the cadence ────────────────────────────────────────────────────────────


async def test_a_pass_inside_the_interval_does_not_ask_the_model_and_says_so(pool, mount_peers):
    """The watch beat is hourly; this check costs a completion. It reads when
    it last RAN out of the beat's own firing history and skips — as ran=False
    with the reason, never an empty run: only a check that RAN reconciles, so
    an empty one would clear every commitment it was still holding."""
    person = await _owner(pool)
    conversation = await _conversation(pool, person)
    await _message(pool, conversation, GARAGE)
    await _firing(pool, await _watch_timer(pool), ago=timedelta(hours=1))
    gateway = _gateway(text="[]")
    mount_peers(gateway=gateway, memory=FakeMemory())

    run = await checks.run_one(core_app, pool, review.CHECK_NAME)

    assert run.ran is False and run.findings == ()
    assert "1h 0m ago" in run.reason and "at most every 6h" in run.reason
    assert "did not look this pass" in run.reason
    # The point of the limiter: nobody was asked and nothing was paid for.
    assert gateway.seen == [] and gateway.seen_headers == []


async def test_a_pass_past_the_interval_looks_again(pool, mount_peers):
    person = await _owner(pool)
    conversation = await _conversation(pool, person)
    real = await _message(pool, conversation, GARAGE)
    await _firing(pool, await _watch_timer(pool), ago=review.REVIEW_EVERY + timedelta(minutes=5))
    mount_peers(gateway=_gateway((real, PARAPHRASE)), memory=FakeMemory())

    run = await checks.run_one(core_app, pool, review.CHECK_NAME)

    assert run.ran, run.reason
    assert len(run.findings) == 1


async def test_a_pass_that_could_not_run_does_not_spend_the_interval(pool, mount_peers):
    """An hour where this check could NOT run lands in the firing's
    `could_not`, not its `ran`. The budget is spent by looking, so the next
    hour tries again rather than waiting six."""
    person = await _owner(pool)
    conversation = await _conversation(pool, person)
    real = await _message(pool, conversation, GARAGE)
    await _firing(
        pool,
        await _watch_timer(pool),
        ago=timedelta(minutes=5),
        ran=("stack_gateway",),
        could_not={review.CHECK_NAME: "the gateway could not be asked"},
    )
    mount_peers(gateway=_gateway((real, PARAPHRASE)), memory=FakeMemory())

    run = await checks.run_one(core_app, pool, review.CHECK_NAME)

    assert run.ran, run.reason
    assert len(run.findings) == 1


async def test_a_firing_history_that_cannot_be_read_is_not_a_free_pass(pool, mount_peers):
    """If the record that says when it last looked cannot be read, it neither
    runs (a completion an hour for as long as the read is broken) nor skips
    quietly (a pass nobody can tell from a clean one)."""
    person = await _owner(pool)
    conversation = await _conversation(pool, person)
    await _message(pool, conversation, GARAGE)
    mount_peers(gateway=_gateway(text="[]"), memory=FakeMemory())
    await pool.execute("ALTER TABLE timer_firings RENAME TO timer_firings_hidden")
    try:
        run = await checks.run_one(core_app, pool, review.CHECK_NAME)
    finally:
        await pool.execute("ALTER TABLE timer_firings_hidden RENAME TO timer_firings")

    assert run.ran is False
    assert "firing history could not be read" in run.reason


# ── the registry sees it ───────────────────────────────────────────────────


def test_the_family_is_registered_and_describes_itself():
    check = checks.REGISTRY[review.CHECK_NAME]
    assert check.run is review.commitments
    # The description states the two numbers a reader would otherwise have to
    # open the code for, and both are derived from the constants.
    assert str(review.WINDOW.days) in check.describe
    assert f"{review.REVIEW_EVERY.total_seconds() / 3600:g}h" in check.describe


@pytest.mark.parametrize(
    "answer",
    [
        "[]",
        '[{"commitment": "no id at all"}]',
        '[{"message_id": "not-a-uuid", "commitment": "nope"}]',
        '[{"message_id": "%s"}]',
        "[1, 2, 3]",
        '{"message_id": "%s", "commitment": "an object, not a list"}',
    ],
)
async def test_answers_that_carry_no_usable_citation_report_nothing(pool, mount_peers, answer):
    """Every shape of "the model said something, none of it is a citation this
    code can check" — each one is a pass that looked and found nothing."""
    person = await _owner(pool)
    conversation = await _conversation(pool, person)
    real = await _message(pool, conversation, GARAGE)
    mount_peers(gateway=_gateway(text=answer.replace("%s", str(real))), memory=FakeMemory())

    run = await checks.run_one(core_app, pool, review.CHECK_NAME)

    assert run.ran and run.findings == ()
