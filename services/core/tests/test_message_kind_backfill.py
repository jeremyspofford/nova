"""Migration 015: the plumbing back-fill over history that predates 014.

014 added messages.kind and marked NOTHING that already existed — every row
written before it defaulted to 'chat', which is exactly the approval
choreography the owner's history was drowning in, plus (2026-09-03 11:57) one
assistant reply that is raw tool-call markup. Left as 'chat' they keep reaching
the model through history_window, and it keeps imitating them.

The SQL under test is the shipped file itself, read from the migrations
directory: the runner's own contract (discovery, ordering, once-only
application) is proven in test_migrations_runner.py, and conftest applies this
very file on every schema build. What has to be pinned HERE is the shape of the
match — the templates are deterministic, so the back-fill is derived from them
and must not touch anything else.
"""
from __future__ import annotations

import pytest

from app.chat import PENDING_APPROVAL_NOTE
from app.main import MIGRATIONS_DIR
from app.migrations_runner import discover_migrations
from tests.conftest import requires_db
from tests.test_markup_calls import OBSERVED

pytestmark = requires_db

MIGRATION = MIGRATIONS_DIR / "015_backfill_plumbing_kinds.sql"


def test_the_migration_is_discovered_after_the_column_that_makes_it_legal():
    """It writes kind = 'plumbing', so it can only ever run after 014 added the
    column and its CHECK. Ordering, not position: a later migration may follow."""
    names = [p.name for p in discover_migrations(MIGRATIONS_DIR)]
    assert MIGRATION.name in names
    assert names.index("014_message_kind.sql") < names.index(MIGRATION.name)


@pytest.fixture
async def conversation(pool):
    person = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('owner', 'owner') RETURNING id"
    )
    return await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", person
    )


async def _insert(pool, conversation, role: str, content: str) -> None:
    """A row exactly as it looked before 014: kind at its 'chat' default."""
    await pool.execute(
        "INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)",
        conversation,
        role,
        content,
    )


async def _kinds(pool) -> dict[str, str]:
    rows = await pool.fetch("SELECT content, kind FROM messages")
    return {row["content"]: row["kind"] for row in rows}


async def test_the_backfill_marks_the_templates_and_leaves_everything_else_chat(
    pool, conversation
):
    approved = "You're approved: fetch https://example.com/pricing. Please go ahead now."
    # A user sentence that STARTS like the template but is not it — the anchor
    # at both ends is the whole point.
    prefix_only = "You're approved of my plan? Then let's go."
    suffix_only = "Whatever you decide. Please go ahead now."
    ordinary = "what's on the calendar tomorrow?"
    prose_about_calls = "I can make function calls when a round offers me tools."

    await _insert(pool, conversation, "user", approved)
    await _insert(pool, conversation, "user", prefix_only)
    await _insert(pool, conversation, "user", suffix_only)
    await _insert(pool, conversation, "user", ordinary)
    await _insert(pool, conversation, "assistant", PENDING_APPROVAL_NOTE)
    await _insert(pool, conversation, "assistant", OBSERVED)
    await _insert(pool, conversation, "assistant", prose_about_calls)
    await _insert(pool, conversation, "assistant", "Done — the desk light is on.")

    await pool.execute(MIGRATION.read_text())

    kinds = await _kinds(pool)
    assert kinds[approved] == "plumbing"
    assert kinds[PENDING_APPROVAL_NOTE] == "plumbing"
    assert kinds[OBSERVED] == "plumbing"

    assert kinds[prefix_only] == "chat"
    assert kinds[suffix_only] == "chat"
    assert kinds[ordinary] == "chat"
    assert kinds[prose_about_calls] == "chat"  # prose, no tag: never touched
    assert kinds["Done — the desk light is on."] == "chat"


async def test_the_backfill_respects_role_and_is_idempotent(pool, conversation):
    """The templates are role-specific: the continuation is something the WEB
    posts as the user, the note is something Nova wrote. A row with the right
    text under the wrong role is not the choreography and stays chat. And
    re-running changes nothing — every UPDATE only ever touches kind = 'chat'."""
    wrong_role_user = PENDING_APPROVAL_NOTE
    wrong_role_assistant = "You're approved: do the thing. Please go ahead now."
    # A row the migration really DOES flip, so the second run has something to
    # be idempotent ABOUT — without it the comparison passes over rows nothing
    # ever touched, which proves nothing.
    flipped = "You're approved: read the pricing page. Please go ahead now."
    await _insert(pool, conversation, "user", wrong_role_user)
    await _insert(pool, conversation, "assistant", wrong_role_assistant)
    await _insert(pool, conversation, "user", flipped)

    sql = MIGRATION.read_text()
    await pool.execute(sql)
    first = await _kinds(pool)
    assert first[flipped] == "plumbing"  # it moved
    assert first[wrong_role_user] == "chat"
    assert first[wrong_role_assistant] == "chat"

    await pool.execute(sql)
    second = await _kinds(pool)
    assert second == first
    assert second[flipped] == "plumbing"  # and stayed moved


async def test_the_hermes_markup_variant_is_backfilled_too(pool, conversation):
    hermes = '<tool_call>{"name": "device_run", "arguments": {"device": "x"}}</tool_call>'
    closing_tag_only = "All done.\n</atem:function_calls>"
    await _insert(pool, conversation, "assistant", hermes)
    await _insert(pool, conversation, "assistant", closing_tag_only)

    await pool.execute(MIGRATION.read_text())

    kinds = await _kinds(pool)
    assert kinds[hermes] == "plumbing"
    assert kinds[closing_tag_only] == "plumbing"
