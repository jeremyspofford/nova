"""What the decision role needs from recall and the prompt (decision-role spec §2).

Pins: every recalled note carries its path, aligned one-for-one with the note
text (the span records verdicts by path, never by text); a recall whose notes
are narrowed keeps each note's path beside it, and one whose EVERY note was
set aside says so in her prompt — never reads as a search that found nothing;
the hint line sits immediately before his message, and a turn with no hint is
byte-for-byte the turn it was."""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime

from app import chat, traces
from app.identity import Person
from app.main import app
from tests.fakes import FakeMemory

HITS = [
    {"path": "people/o/journals/2026-09-15.md", "snippet": "sideload it with TestFlight"},
    {"title": "Coffee", "snippet": "pour-over, no sugar"},
    "a bare string hit",
    {"path": "people/o/topics/empty.md"},  # no body: the label is the note
    {"snippet": ""},  # nothing at all: no note
    42,  # not a hit
]
HINT = (
    "A decision model reads the owner's message as needing your tool show_setup_qr "
    "(fit 0.85). Use it if it fits."
)


def test_every_note_has_its_path_in_the_same_order():
    notes = chat._snippets(HITS)
    paths = chat._note_paths(HITS)
    assert len(paths) == len(notes) == 4
    assert paths == ["people/o/journals/2026-09-15.md", "Coffee", "", "people/o/topics/empty.md"]


async def test_recall_carries_each_notes_path(mount_peers):
    mount_peers(memory=FakeMemory(results=tuple(HITS[:3])))
    turn = traces.Turn(id=uuid.uuid4(), started_at=datetime.now(UTC))
    person = Person(id=uuid.uuid4(), name="jeremy", role="owner")

    recalled = await chat._recall(app, turn, person, "how do I get you on my phone")

    assert len(recalled.notes) == 3
    assert recalled.paths == ("people/o/journals/2026-09-15.md", "Coffee", "")


def test_narrowed_notes_keep_their_paths_and_none_leaves_the_recall_as_it_was():
    recalled = chat.Recalled(notes=("a", "b", "c"), paths=("p/a.md", "p/b.md", "p/c.md"))

    assert chat._with_notes_kept(recalled, None) is recalled
    kept = chat._with_notes_kept(recalled, (0, 2))
    assert kept.notes == ("a", "c") and kept.paths == ("p/a.md", "p/c.md")
    assert kept.set_aside is None


def test_a_recall_whose_every_note_was_set_aside_says_so_in_her_prompt():
    """Review focus 4: an empty block reads like a search that found nothing —
    and this one found two notes, which a decision model set aside."""
    recalled = chat.Recalled(notes=("a", "b"), paths=("p/a.md", "p/b.md"))

    kept = chat._with_notes_kept(recalled, ())

    assert kept.notes == () and kept.paths == ()
    prompt = chat.volatile_system_prompt(kept)
    assert prompt is not None
    assert (
        "Her memory was searched for this turn; a decision model set aside all 2 notes it "
        "returned as unrelated to this message or superseded by what she can do now."
    ) in prompt
    assert "returned nothing" not in prompt


def _clockless(messages: list[dict]) -> list[dict]:
    """`messages` with the volatile block's microsecond timestamp scrubbed out
    of every system message, so two calls a heartbeat apart still compare
    equal — the turn's clock moving is not a change to what the turn says."""
    return [
        {**m, "content": re.sub(r"Current time: \S+", "Current time: T", m["content"])}
        if m.get("role") == "system"
        else m
        for m in messages
    ]


def test_the_hint_sits_immediately_before_his_message_and_changes_nothing_else():
    recall = chat.Recalled(notes=("Kitchen: the kettle is new",))
    history = [
        {"role": "user", "content": "earlier"},
        {"role": "assistant", "content": "a reply"},
    ]
    message = "How do I get you on my phone"

    plain = chat.base_messages("qwen3:8b", recall, history, message)
    hinted = chat.base_messages("qwen3:8b", recall, history, message, hint=HINT)

    assert _clockless(hinted[:-2]) == _clockless(plain[:-1]), "the cached prefix is the same bytes"
    assert hinted[-2] == {"role": "system", "content": HINT}
    assert hinted[-1] == plain[-1] == {"role": "user", "content": message}
    assert _clockless(
        chat.base_messages("qwen3:8b", recall, history, message, hint=None)
    ) == _clockless(plain)
