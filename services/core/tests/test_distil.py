"""app/distil.py — the extractor that turns a conversation into facts.

Distillation shares review.py's spine (app/model_read.py) and differs from it
in exactly one deliberate place, which is what most of this file is about: it
reads BOTH sides of the conversation, because a durable fact is usually in her
tidy restatement of what he said — and a fact standing only on an assistant row
is supported by something the model itself produced, which verifies nothing
about the world. So the ROLE of the cited row travels onto the note, and it
travels in code.

What is pinned here, in the same shape as tests/test_checks_review.py:

  * a CITATION IS VERIFIED against the database. A fabricated one is dropped
    and nothing it claimed survives; an answer of nothing BUT fabricated
    citations is a pass that looked and wrote nothing, never an error;
  * the ROLE COMES FROM THE ROW. A fact cited to her own reply is marked
    differently from one cited to his message, in the frontmatter the note
    carries and in the body it is composed of;
  * the BODY QUOTES THE ROW. The model's phrasing reaches the title and
    nothing else, so what a reader gets back is what was actually said;
  * the SUBJECTS AND THE TOOLS ARE READ LIVE — the subjects out of memory's
    own export so a restatement reuses one and superseding fires, the tools
    out of the registry so a live source names a real call. A call that could
    not dispatch takes its whole item with it;
  * a peer that could not be reached is a STATED cannot-check with the reason,
    never an empty list, and an unparseable answer is the opposite: zero facts
    from a pass that genuinely looked.
"""

from __future__ import annotations

import io
import json
import tarfile
import uuid
from dataclasses import dataclass, field
from datetime import timedelta

import httpx
import pytest
from starlette.applications import Starlette
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from app import distil, identity, model_read
from app.main import app as core_app
from tests import fakes
from tests.conftest import requires_db
from tests.fakes import FakeGateway

pytestmark = requires_db

# What was said, and what a model might call it. Deliberately share no words:
# every assertion about "the row, not the paraphrase" would pass by accident if
# one were a substring of the other.
HIS = "the tower has 24GB of VRAM and 64GB of system RAM in it"
HERS = "Right — 24GB VRAM, 64GB system RAM on the tower."
PARAPHRASE = "graphics card capacity of the desktop"
INVENTED = "he prefers oat milk"
SUBJECT = "hardware.vram"


class _Dead(httpx.AsyncBaseTransport):
    """A peer whose socket refuses — a real httpx error, not a patched call."""

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)


@dataclass
class FakeNotes:
    """A memory service that serves /export — this person's notes as the real
    one packs them (tar.gz, arcnames relative to the person's own root).

    tests/fakes.FakeMemory has no /export, and distillation reads the subjects
    already in use out of one, so the fake lives here rather than growing the
    shared one for a single reader.
    """

    # rel path under the person's root -> the file's text, frontmatter and all.
    notes: dict[str, str] = field(default_factory=dict)
    status: int = 200
    exports: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.app = Starlette(routes=[Route("/export", self._export, methods=["GET"])])

    async def _export(self, request):
        self.exports.append(request.query_params.get("person_id", ""))
        if request.headers.get("authorization") != f"Bearer {fakes.MEMORY_TOKEN}":
            return JSONResponse({"error": "bad memory bearer"}, status_code=401)
        if self.status != 200:
            return JSONResponse({"error": "no notes"}, status_code=self.status)
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
            for name, text in self.notes.items():
                data = text.encode()
                info = tarfile.TarInfo(name)
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
        return Response(buffer.getvalue(), media_type="application/gzip")


def note(subject: str | None, *, title: str = "a note") -> str:
    """One note on disk, in the store's own frontmatter shape."""
    lines = ["---", f"title: {title}", "kind: topic", "created: 2026-09-01"]
    if subject is not None:
        lines.append(f"subject: {subject}")
    lines += ["---", "", "the body"]
    return "\n".join(lines)


async def _person(pool) -> identity.Person:
    await pool.execute("INSERT INTO people (name, role) VALUES ('jeremy','owner')")
    owner = await identity.owner(pool)
    assert owner is not None
    return owner


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


def _answer(*items: dict) -> str:
    """The model's answer in the shape the extractor asks for, fenced — the
    fence is there on purpose, because a small model writes one and the parser
    has to survive it."""
    return f"Here is what I found:\n```json\n{json.dumps(items)}\n```"


def _item(message_id, *, subject=SUBJECT, fact=PARAPHRASE, live_source=None) -> dict:
    entry = {"message_id": str(message_id), "subject": subject, "fact": fact}
    if live_source is not None:
        entry["live_source"] = live_source
    return entry


def _gateway(*items: dict, text: str | None = None) -> FakeGateway:
    """A gateway that answers with this script, split across two deltas so the
    read has to concatenate the stream like a real one."""
    body = _answer(*items) if text is None else text
    middle = len(body) // 2
    return FakeGateway(deltas=(body[:middle], body[middle:]))


def _brief(gateway: FakeGateway) -> str:
    """The user message the extractor actually sent to the gateway."""
    bodies = [
        body for path, body in gateway.seen if path == "/v1/chat/completions" and body is not None
    ]
    return bodies[-1]["messages"][1]["content"]


# ── the citation is verified ───────────────────────────────────────────────


async def test_a_fabricated_citation_is_dropped_and_nothing_it_claimed_survives(pool, mount_peers):
    """Two facts, one citing a real message and one citing an id nobody ever
    wrote. Exactly one survives, it is built from the row, and every word of
    the invented one is gone."""
    person = await _person(pool)
    conversation = await _conversation(pool, person.id)
    real = await _message(pool, conversation, HIS)
    mount_peers(
        gateway=_gateway(_item(real), _item(uuid.uuid4(), subject="drinks", fact=INVENTED)),
        memory=FakeNotes(),
    )

    result = await distil.distil(core_app, pool, person)

    assert result.ran, result.reason
    assert result.verified == 1 and result.proposed == 2 and result.dropped == 1
    (fact,) = result.facts
    assert fact.message_id == real
    assert fact.source == {"message_id": str(real), "role": "user"}
    assert HIS in fact.body
    # And nothing at all survived of the fact whose citation was invented.
    everything = fact.body + fact.title + fact.subject
    assert INVENTED not in everything and "drinks" not in everything


async def test_an_answer_of_only_invented_citations_reports_nothing(pool, mount_peers):
    """Well-formed, confident, and citing two messages that do not exist. The
    verification is a query, so none of it survives — and the pass RAN."""
    person = await _person(pool)
    conversation = await _conversation(pool, person.id)
    await _message(pool, conversation, HIS)
    mount_peers(
        gateway=_gateway(
            _item(uuid.uuid4(), subject="drinks", fact=INVENTED),
            _item(uuid.uuid4(), subject="gym", fact="he cancelled the gym"),
        ),
        memory=FakeNotes(),
    )

    result = await distil.distil(core_app, pool, person)

    assert result.ran and result.reason is None
    assert result.facts == () and result.verified == 0
    assert result.proposed == 2 and result.dropped == 2


async def test_a_message_of_someone_elses_is_not_citable(pool, mount_peers):
    """The verification is scoped to this person's own conversations, so a
    real message id belonging to somebody else resolves to nothing."""
    person = await _person(pool)
    conversation = await _conversation(pool, person.id)
    await _message(pool, conversation, HIS)
    stranger = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('someone else','adult') RETURNING id"
    )
    theirs = await _message(pool, await _conversation(pool, stranger), "my box has 8GB")
    mount_peers(gateway=_gateway(_item(theirs)), memory=FakeNotes())

    result = await distil.distil(core_app, pool, person)

    assert result.ran and result.facts == () and result.dropped == 1


# ── both sides are read, and the role travels ──────────────────────────────


async def test_both_sides_are_read_and_her_restatement_is_citable(pool, mount_peers):
    """The one deliberate difference from review.py: her reply is IN the window
    and can be cited, because the tidy statement of a fact is usually hers."""
    person = await _person(pool)
    conversation = await _conversation(pool, person.id)
    his = await _message(pool, conversation, HIS, ago=timedelta(minutes=2))
    hers = await _message(pool, conversation, HERS, role="assistant")
    gateway = _gateway(_item(hers))
    mount_peers(gateway=gateway, memory=FakeNotes())

    result = await distil.distil(core_app, pool, person)

    brief = _brief(gateway)
    assert str(his) in brief and str(hers) in brief
    assert HIS in brief and HERS in brief
    assert result.ran and result.verified == 1


async def test_a_fact_on_her_own_words_is_marked_and_his_is_not(pool, mount_peers):
    """The sharpest line in the slice. Two facts, same subject family, one
    cited to his message and one to her reply — and the mark comes from the
    ROW's role, so nothing the model writes can move it."""
    person = await _person(pool)
    conversation = await _conversation(pool, person.id)
    his = await _message(pool, conversation, HIS, ago=timedelta(minutes=2))
    hers = await _message(pool, conversation, HERS, role="assistant")
    mount_peers(
        gateway=_gateway(
            _item(his, subject="hardware.vram"),
            _item(hers, subject="hardware.ram", fact="system memory of the tower"),
        ),
        memory=FakeNotes(),
    )

    result = await distil.distil(core_app, pool, person)

    assert result.ran and result.verified == 2
    by_subject = {fact.subject: fact for fact in result.facts}
    mine, hers_fact = by_subject["hardware.vram"], by_subject["hardware.ram"]

    assert mine.said_by == "user" and mine.her_words_alone is False
    assert mine.source["role"] == "user"
    assert "Nova wrote that herself" not in mine.body

    assert hers_fact.said_by == "assistant" and hers_fact.her_words_alone is True
    assert hers_fact.source["role"] == "assistant"
    # Marked in the body a reader gets back, not only in a field.
    assert "Nova wrote that herself" in hers_fact.body
    assert "stands on her words alone" in hers_fact.body


async def test_the_role_on_the_note_is_the_rows_and_not_the_models(pool, mount_peers):
    """A model that says the fact came from him, citing a row that is hers.
    The citation resolves to the assistant row and the note is marked as
    standing on her words — the claim about the source is never read."""
    person = await _person(pool)
    conversation = await _conversation(pool, person.id)
    await _message(pool, conversation, HIS, ago=timedelta(minutes=2))
    hers = await _message(pool, conversation, HERS, role="assistant")
    entry = _item(hers)
    entry["role"] = "user"
    entry["said_by"] = "jeremy"
    mount_peers(gateway=_gateway(entry), memory=FakeNotes())

    result = await distil.distil(core_app, pool, person)

    (fact,) = result.facts
    assert fact.said_by == "assistant" and fact.her_words_alone is True


# ── the body is the row; the model's words are the title ───────────────────


async def test_the_body_quotes_the_row_and_never_the_paraphrase(pool, mount_peers):
    """What is written down is what was actually said. The model's phrasing is
    the title and reaches nothing else — the same rule as review.py's facts."""
    person = await _person(pool)
    conversation = await _conversation(pool, person.id)
    real = await _message(pool, conversation, HIS)
    said_at = await pool.fetchval("SELECT created_at FROM messages WHERE id = $1", real)
    mount_peers(gateway=_gateway(_item(real)), memory=FakeNotes())

    result = await distil.distil(core_app, pool, person)

    (fact,) = result.facts
    assert HIS in fact.body
    assert PARAPHRASE not in fact.body
    assert fact.title == PARAPHRASE
    # Dated by the EXCHANGE, not by the pass — what `created` will follow.
    assert fact.said_at == said_at
    assert said_at.isoformat(timespec="minutes") in fact.body
    # The citation is frontmatter, never body text: the body is what the index
    # tokenises and a uuid in it is a term every distilled note would carry.
    assert str(real) not in fact.body


async def test_a_long_message_is_quoted_short_enough_to_sit_in_an_excerpt(pool, mount_peers):
    person = await _person(pool)
    conversation = await _conversation(pool, person.id)
    real = await _message(pool, conversation, "he said " + ("very long " * 200))
    mount_peers(gateway=_gateway(_item(real)), memory=FakeNotes())

    (fact,) = (await distil.distil(core_app, pool, person)).facts

    assert len(fact.body) < 500 and fact.body.endswith(".")


# ── the subjects are read live, so a restatement replaces ──────────────────


async def test_the_subjects_already_in_use_are_read_live_and_shown(pool, mount_peers):
    """Read from memory's own export, because a recall hit does not carry its
    note's subject and a list kept here would be wrong the day she writes one."""
    person = await _person(pool)
    conversation = await _conversation(pool, person.id)
    await _message(pool, conversation, HIS)
    notes = FakeNotes(
        notes={
            "topics/hardware.md": note("hardware.vram"),
            "topics/coffee.md": note("preferences.coffee"),
            "journals/2026-09-01.md": note(None, title="a day"),
        }
    )
    gateway = _gateway(text="[]")
    mount_peers(gateway=gateway, memory=notes)

    result = await distil.distil(core_app, pool, person)

    assert result.ran and result.limits == ()
    brief = _brief(gateway)
    assert "hardware.vram" in brief and "preferences.coffee" in brief
    assert notes.exports == [str(person.id)]


async def test_a_restatement_shown_the_subject_reuses_it(pool, mount_peers):
    """The whole point of showing them: the second telling of a fact comes back
    on the SAME subject, which is what makes the newer note retire the older
    one instead of sitting beside it."""
    person = await _person(pool)
    conversation = await _conversation(pool, person.id)
    first = await _message(pool, conversation, HIS, ago=timedelta(hours=9))
    mount_peers(gateway=_gateway(_item(first)), memory=FakeNotes())
    earlier = await distil.distil(core_app, pool, person)

    # A week later he says it again, and her notes now hold the first one.
    later_row = await _message(pool, conversation, "the tower is on 48GB of VRAM now")
    notes = FakeNotes(notes={"topics/hardware.md": note(SUBJECT)})
    gateway = _gateway(_item(later_row, fact="the desktop's graphics memory"))
    mount_peers(gateway=gateway, memory=notes)

    later = await distil.distil(core_app, pool, person)

    assert SUBJECT in _brief(gateway)
    assert earlier.facts[0].subject == later.facts[0].subject == SUBJECT
    # Two notes, one subject, and the newer one is the newer exchange.
    assert later.facts[0].said_at > earlier.facts[0].said_at


async def test_two_facts_on_one_subject_in_one_pass_keep_the_newer_row(pool, mount_peers):
    """Both would be written, the second retiring the first the moment it
    landed — a note born superseded. Which survives is decided from the rows'
    own timestamps, not from the order the model answered in."""
    person = await _person(pool)
    conversation = await _conversation(pool, person.id)
    older = await _message(pool, conversation, HIS, ago=timedelta(hours=3))
    newer = await _message(pool, conversation, "the tower is on 48GB of VRAM now")
    mount_peers(
        # Newest first in the answer, so "keep the last one" would be wrong too.
        gateway=_gateway(_item(newer, fact="newer"), _item(older, fact="older")),
        memory=FakeNotes(),
    )

    result = await distil.distil(core_app, pool, person)

    assert result.verified == 1 and result.folded == 1
    assert result.facts[0].message_id == newer


async def test_subjects_that_cannot_be_read_are_a_stated_limit_not_a_stop(pool, mount_peers):
    """A missed subject costs a duplicate note — both dated, both recallable —
    and can never make an answer wrong, so the pass says so and goes on."""
    person = await _person(pool)
    conversation = await _conversation(pool, person.id)
    real = await _message(pool, conversation, HIS)
    mount_peers(gateway=_gateway(_item(real)), memory=FakeNotes())
    core_app.state.peer_transports[fakes.MEMORY_URL] = _Dead()

    result = await distil.distil(core_app, pool, person)

    assert result.ran and result.verified == 1
    assert any("subjects already in use could not be read" in limit for limit in result.limits)
    assert any("connection refused" in limit for limit in result.limits)


async def test_a_caller_that_holds_the_subjects_is_not_made_to_read_them(pool, mount_peers):
    person = await _person(pool)
    conversation = await _conversation(pool, person.id)
    await _message(pool, conversation, HIS)
    notes = FakeNotes(notes={"topics/hardware.md": note("never.read")})
    gateway = _gateway(text="[]")
    mount_peers(gateway=gateway, memory=notes)

    result = await distil.distil(core_app, pool, person, subjects=("passed.in",))

    assert result.ran and notes.exports == []
    assert "passed.in" in _brief(gateway) and "never.read" not in _brief(gateway)


# ── the tools are read live, and a call that cannot run takes its fact ──────


async def test_the_tools_are_the_live_registry_and_the_steer_is_stated(pool, mount_peers):
    from app import tools

    person = await _person(pool)
    conversation = await _conversation(pool, person.id)
    await _message(pool, conversation, HIS)
    gateway = _gateway(text="[]")
    mount_peers(gateway=gateway, memory=FakeNotes())

    assert (await distil.distil(core_app, pool, person)).ran

    brief = _brief(gateway)
    offered, _limit = distil.live_tools()
    assert offered, "the registry must offer something for this test to mean anything"
    for tool in offered[: distil.MAX_TOOLS_SHOWN]:
        assert tool.name in brief
    assert set(name for name, _t in tools.REGISTRY.items()) >= {t.name for t in offered}
    # The steer Jeremy asked for: a fact a call answers is better left unwritten.
    assert "better left unwritten" in brief


async def test_a_live_source_that_can_dispatch_is_kept_and_named_in_the_body(pool, mount_peers):
    person = await _person(pool)
    conversation = await _conversation(pool, person.id)
    real = await _message(pool, conversation, HIS)
    mount_peers(
        gateway=_gateway(
            _item(real, live_source={"tool": "device_info", "args": {"device": "tower"}})
        ),
        memory=FakeNotes(),
    )

    result = await distil.distil(core_app, pool, person)

    (fact,) = result.facts
    assert fact.live_source == {"tool": "device_info", "args": {"device": "tower"}}
    # The note says which is the truth — the call, not the note.
    assert "device_info" in fact.body and "that call is the truth" in fact.body


@pytest.mark.parametrize(
    "live_source",
    [
        {"tool": "no_such_tool", "args": {}},
        # Registered, but device_info would refuse those arguments.
        {"tool": "device_info", "args": {}},
        {"tool": "device_info", "args": {"device": 7}},
        "device_info",
    ],
)
async def test_a_fact_whose_call_cannot_dispatch_is_dropped_whole(pool, mount_peers, live_source):
    """The model itself judged this to be a fact a tool answers. Writing it
    with no call attached would make a history note read as the current
    answer, which is the ruling `live_source` exists for."""
    person = await _person(pool)
    conversation = await _conversation(pool, person.id)
    real = await _message(pool, conversation, HIS)
    mount_peers(gateway=_gateway(_item(real, live_source=live_source)), memory=FakeNotes())

    result = await distil.distil(core_app, pool, person)

    assert result.ran and result.facts == ()
    assert result.proposed == 1 and result.dropped == 1


# ── a peer that could not be reached is never a clean pass ─────────────────


async def test_a_gateway_that_cannot_be_reached_is_a_stated_cannot_check(pool, mount_peers):
    person = await _person(pool)
    conversation = await _conversation(pool, person.id)
    await _message(pool, conversation, HIS)
    mount_peers(gateway=FakeGateway(), memory=FakeNotes())
    core_app.state.peer_transports[fakes.GATEWAY_URL] = _Dead()

    result = await distil.distil(core_app, pool, person)

    assert result.ran is False and result.facts == ()
    assert "gateway" in result.reason and "connection refused" in result.reason
    # It read a window before it failed, and says so rather than claiming none.
    assert result.read == 1 and result.verified == 0


async def test_a_gateway_that_refuses_says_the_status_it_refused_with(pool, mount_peers):
    person = await _person(pool)
    conversation = await _conversation(pool, person.id)
    await _message(pool, conversation, HIS)
    mount_peers(gateway=FakeGateway(status=503), memory=FakeNotes())

    result = await distil.distil(core_app, pool, person)

    assert result.ran is False and "503" in result.reason


async def test_a_verification_that_could_not_be_made_writes_nothing(pool, mount_peers, monkeypatch):
    """Unverified claims must not become notes, and reporting none of them
    would say the pass looked and found nothing worth keeping. The window read
    and the verification are separate reads, so this breaks the second one
    alone — the pass got all the way to a model's answer and still wrote
    nothing."""
    person = await _person(pool)
    conversation = await _conversation(pool, person.id)
    real = await _message(pool, conversation, HIS)
    mount_peers(gateway=_gateway(_item(real)), memory=FakeNotes())

    async def _broken(*args, **kwargs):
        raise model_read.ReadFailed("the pool went away mid-pass")

    monkeypatch.setattr(model_read, "resolve_messages", _broken)

    result = await distil.distil(core_app, pool, person)

    assert result.ran is False and result.facts == ()
    assert "could not be verified" in result.reason
    assert "the pool went away mid-pass" in result.reason
    # It read a window and got an answer; both are said rather than zeroed.
    assert result.read == 1 and result.proposed == 1


async def test_a_window_that_cannot_be_read_is_stated(pool, mount_peers):
    person = await _person(pool)
    mount_peers(gateway=_gateway(text="[]"), memory=FakeNotes())
    await pool.execute("ALTER TABLE messages RENAME TO messages_hidden")
    try:
        result = await distil.distil(core_app, pool, person)
    finally:
        await pool.execute("ALTER TABLE messages_hidden RENAME TO messages")

    assert result.ran is False
    assert "conversation could not be read" in result.reason


# ── an answer that says nothing is a pass that looked ──────────────────────


async def test_an_unparseable_answer_is_a_pass_with_nothing_to_write(pool, mount_peers):
    """The model was asked and answered prose. It genuinely looked, so this is
    ran=True with no facts — never a crash and never a cannot-check."""
    person = await _person(pool)
    conversation = await _conversation(pool, person.id)
    await _message(pool, conversation, HIS)
    mount_peers(
        gateway=_gateway(text="Nothing in that conversation looks worth keeping, honestly."),
        memory=FakeNotes(),
    )

    result = await distil.distil(core_app, pool, person)

    assert result.ran and result.reason is None
    assert result.facts == () and result.proposed == 0


@pytest.mark.parametrize(
    "answer",
    [
        "[]",
        "",
        "{}",
        "[1, 2, 3]",
        '[{"subject": "hardware.vram", "fact": "no id at all"}]',
        '[{"message_id": "not-a-uuid", "subject": "s", "fact": "nope"}]',
        # No subject: the superseding key is missing, so this could never be
        # replaced by a later telling of the same fact.
        '[{"message_id": "%s", "fact": "a fact with nothing to file it under"}]',
        '[{"message_id": "%s", "subject": "hardware.vram"}]',
        '{"message_id": "%s", "subject": "s", "fact": "an object, not a list"}',
    ],
)
async def test_answers_that_carry_no_usable_fact_write_nothing(pool, mount_peers, answer):
    """Every shape of "the model said something, none of it is a fact this code
    can check" — each one a pass that looked and wrote nothing."""
    person = await _person(pool)
    conversation = await _conversation(pool, person.id)
    real = await _message(pool, conversation, HIS)
    mount_peers(gateway=_gateway(text=answer.replace("%s", str(real))), memory=FakeNotes())

    result = await distil.distil(core_app, pool, person)

    assert result.ran and result.facts == ()


async def test_nothing_in_the_window_never_reaches_the_model(pool, mount_peers):
    """No conversation, no question: a pass that read an empty window does not
    pay for a completion to learn that."""
    person = await _person(pool)
    gateway = _gateway(text="[]")
    mount_peers(gateway=gateway, memory=FakeNotes())

    result = await distil.distil(core_app, pool, person)

    assert result.ran and result.facts == () and result.read == 0
    assert gateway.seen == []


async def test_the_window_is_bounded_by_time_and_by_characters(pool, mount_peers):
    person = await _person(pool)
    conversation = await _conversation(pool, person.id)
    recent = await _message(pool, conversation, HIS, ago=timedelta(hours=2))
    await _message(pool, conversation, "I painted the shed", ago=timedelta(days=30))
    gateway = _gateway(text="[]")
    mount_peers(gateway=gateway, memory=FakeNotes())

    result = await distil.distil(core_app, pool, person, since=timedelta(days=1))

    brief = _brief(gateway)
    assert str(recent) in brief and "painted the shed" not in brief
    assert result.read == 1


async def test_the_character_budget_cuts_between_whole_messages(pool, mount_peers):
    """Half a message is worse than an absent one: the budget drops whole rows,
    oldest first, and what is shown is shown entire."""
    person = await _person(pool)
    conversation = await _conversation(pool, person.id)
    old = await _message(pool, conversation, "old " * 100, ago=timedelta(hours=3))
    new = await _message(pool, conversation, HIS)
    gateway = _gateway(text="[]")
    mount_peers(gateway=gateway, memory=FakeNotes())

    result = await distil.distil(core_app, pool, person, char_budget=len(HIS) + 10)

    brief = _brief(gateway)
    assert str(new) in brief and str(old) not in brief
    assert HIS in brief and result.read == 1


# ── the call says who is paying and what it is for ─────────────────────────


async def test_the_call_says_who_is_paying_and_what_it_is_for(pool, mount_peers):
    """The gateway meters every call. A distil pass has no turn to attribute
    to, so what it CAN say it says: its own purpose, the person whose notes
    these are, and the role a beat's rounds walk."""
    person = await _person(pool)
    conversation = await _conversation(pool, person.id)
    await _message(pool, conversation, HIS)
    gateway = _gateway(text="[]")
    mount_peers(gateway=gateway, memory=FakeNotes())

    assert (await distil.distil(core_app, pool, person)).ran

    headers = gateway.seen_headers[-1]
    assert headers["x-nova-purpose"] == distil.PURPOSE
    assert headers["x-nova-person"] == str(person.id)
    assert headers["x-nova-role"] == "beat"


# ── the counts are of what landed ──────────────────────────────────────────


async def test_the_counts_are_of_what_landed_not_what_was_attempted(pool, mount_peers):
    person = await _person(pool)
    conversation = await _conversation(pool, person.id)
    first = await _message(pool, conversation, HIS, ago=timedelta(minutes=3))
    second = await _message(pool, conversation, "I take my coffee black", ago=timedelta(minutes=2))
    mount_peers(
        gateway=_gateway(
            _item(first),
            _item(second, subject="preferences.coffee", fact="how he takes coffee"),
            _item(uuid.uuid4(), subject="gym", fact=INVENTED),
            {"subject": "malformed", "fact": "no citation at all"},
        ),
        memory=FakeNotes(),
    )

    result = await distil.distil(core_app, pool, person)

    assert result.read == 2
    assert result.proposed == 3  # the malformed entry never became a proposal
    assert result.dropped == 2  # the malformed one and the invented citation
    assert result.verified == len(result.facts) == 2


# ── the live-source candidates are the ones the backend would run ──────────
#
# The backend runs a stored call on its own initiative, which nothing in v4
# did before S14. `Tool.reads_only` says a tool changes nothing; it does NOT
# say the backend may run it unasked, and the gap is where fetch_url lives.
# One predicate (live_facts.may_run_unasked) answers for all three doors —
# the runner, the memory write door, and the list offered to the model here —
# and these two pin that they cannot drift apart.


def test_only_the_calls_the_backend_would_actually_run_are_offered():
    """The distiller offers what the write door will ACCEPT, not what merely
    reads (2026-09-10, once `Tool.reads_only` landed).

    `reads_only` is the wrong bar on its own: fetch_url and web_search change
    nothing and still reach an address the NOTE would choose, so the backend
    refuses to run them unasked and `validate_live_source` refuses to store a
    note citing them. Offering them here would spend the model's attention
    proposing facts that are then dropped whole — a pass reporting work it did
    not do, which is the one thing its counts exist to prevent.

    So all three doors ask ONE predicate, and this is the test that they
    cannot drift apart.
    """
    from app import live_facts, tools

    offered, limit = distil.live_tools()
    assert limit is None
    names = [entry.name for entry in offered]

    assert names == [entry.name for entry in live_facts.offerable()]
    for name in names:
        assert live_facts.may_run_unasked(name) is None
        # And the write door agrees, which is the property that matters.
        assert tools.REGISTRY[name].reads_only

    assert "get_time" in names
    for excluded in ("fetch_url", "web_search", "workspace_write_file"):
        assert excluded not in names, f"{excluded} would be dropped by the write door"


def test_offering_nothing_is_a_stated_limit_rather_than_a_quiet_pass(monkeypatch):
    """A pass in which no fact COULD be given a live source is not a pass with
    no live facts in it. Every note it wrote is a record with nothing able to
    check it, and that has to be said rather than inferred from an absence."""
    from app import live_facts

    monkeypatch.setattr(live_facts, "AUTO_RUN", frozenset())

    offered, limit = distil.live_tools()

    assert offered == ()
    assert limit is not None
    assert "nothing able to check it" in limit
