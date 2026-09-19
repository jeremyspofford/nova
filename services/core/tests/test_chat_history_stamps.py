"""S40b: a reading reaches the next turn as a record of its moment, not of now.

The S40 walk (turns b851aa91 then b02a5694): she read hub with machine_status
and said it was ready; the owner asked the same question again, and she
replayed that reply — "Last Reported: 05:15:39" and all — as the current state
of the machine, without checking. The earlier row had reached her as bare
prose in the present tense: history stamped only a failed or stopped turn
(S19), so nothing told her that the row was a reading taken minutes before.

So a row now arrives stamped when the turn behind it was a scheduled firing or
a beat, or READ something live. Both facts are derived from what the database
holds about that turn — its kind, and whether one of its tool spans is a live
read that answered — never from the row's words, and "a live read" is derived
from the registry (tools.live_reading_tool_names: ephemeral AND reads_only), so
a live-reading tool registered tomorrow stamps its turns by that declaration
alone. The guard (state_claim) is what refuses a replay she makes anyway; this
is the truth half: she is told the truth first.

The pure half — the stamp texts and their precedence — is pinned in
test_chat_skills beside the S19 stamp. This file pins the registry read and the
query half: the columns `_open_turn` derives for each row, through a real turn.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest

from app import tools, traces
from app.tools import Tool
from app.tools.devices import TOOLS as DEVICE_TOOLS
from app.tools.machines import MACHINE_STATUS
from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory
from tests.test_chat import _say, _set_model

# ── the registry read ───────────────────────────────────────────────────────


def test_a_live_reading_tool_is_ephemeral_and_reads_only():
    """Both declarations, from the live registry: ephemeral says the result
    goes stale, reads_only says running it changed nothing — so what it
    returned is a reading of the world at that moment.

    Pin replaced in the S40b final fix wave (C18): it recomputed the
    implementation's own expression over the registry and asserted equality,
    which could not fail independently of live_reading_tool_names. These are
    NAMED members and non-members — each one a decision about the tool, and
    each one red the day the derivation or the declaration moves."""
    names = tools.live_reading_tool_names()
    for member in (MACHINE_STATUS.name, "inference_health", "fetch_url", "device_info"):
        assert member in names, member
    for outsider in ("device_notify", "memory_search", "list_timers", "workspace_write_file"):
        assert outsider not in names, outsider
    assert names == sorted(names)
    for name in names:
        tool = tools.REGISTRY[name]
        assert tool.ephemeral and tool.reads_only, name


def test_device_notify_is_not_a_reading():
    """Ephemeral but not reads_only: a notification CHANGES something (it
    lands on his screen), and what it returns is a receipt, not a reading.
    Pinned against the declarations, so the exclusion cannot pass by the tool
    simply having vanished."""
    (notify,) = [tool for tool in DEVICE_TOOLS if tool.name == "device_notify"]
    assert notify.ephemeral and not notify.reads_only
    assert "device_notify" not in tools.live_reading_tool_names()


def test_a_reads_only_tool_that_does_not_go_stale_is_not_a_reading():
    names = tools.live_reading_tool_names()
    assert tools.REGISTRY["memory_search"].reads_only
    assert not tools.REGISTRY["memory_search"].ephemeral
    assert "memory_search" not in names


def _probe_tool(name: str, *, ephemeral: bool, reads_only: bool) -> Tool:
    async def _run(_args, _ctx) -> str:
        return "probe"

    return Tool(
        name=name,
        description="a probe",
        parameters={"type": "object", "properties": {}},
        executor=_run,
        ephemeral=ephemeral,
        reads_only=reads_only,
    )


def test_the_reading_set_is_read_from_the_registry_every_call(monkeypatch):
    """Derived, never hardcoded: a tool registered with both declarations is
    a reading by that fact alone, and one with either missing is not."""
    monkeypatch.setitem(
        tools.REGISTRY,
        "probe_reading",
        _probe_tool("probe_reading", ephemeral=True, reads_only=True),
    )
    monkeypatch.setitem(
        tools.REGISTRY, "probe_stale", _probe_tool("probe_stale", ephemeral=True, reads_only=False)
    )
    monkeypatch.setitem(
        tools.REGISTRY, "probe_plain", _probe_tool("probe_plain", ephemeral=False, reads_only=True)
    )
    names = tools.live_reading_tool_names()
    assert "probe_reading" in names
    assert "probe_stale" not in names and "probe_plain" not in names
    assert names == sorted(names)


# ── the query half, through a real turn ─────────────────────────────────────

_WRITTEN = datetime(2026, 9, 1, 5, 15, 39, tzinfo=UTC)
_WHEN = "2026-09-01 05:15 UTC"
_MOMENT = "a record of that moment, not of now]"
_READING = f"[written at {_WHEN} from readings taken then; {_MOMENT}"


def _tool_span(name: str, *, ok: bool = True, **extra) -> tuple[str, str, dict]:
    """A tool span with the meta chat._run_tool writes (live_facts adds
    `unasked`), so the query reads the shape the product files."""
    meta = {"args_redacted": {}, "ok": ok, "result_head": "a result", **extra}
    if not ok:
        meta["error"] = "Error: it did not answer"
    return ("tool", name, meta)


async def _seed_row(
    pool,
    conversation_id: uuid.UUID,
    content: str,
    *,
    kind: str | None = "chat",
    status: str = "ok",
    spans: tuple = (),
) -> None:
    """One earlier assistant row in the owner's active conversation, written
    by a turn of `kind` that filed `spans` and closed with `status` — through
    traces.open_turn/close_turn, the writers the product uses. `kind=None` is
    a row with no turn behind it at all."""
    owner_id = await pool.fetchval("SELECT id FROM people WHERE role = 'owner'")
    turn_id = None
    if kind is not None:
        turn = await traces.open_turn(
            pool, kind=kind, conversation_id=conversation_id, person_id=owner_id
        )
        for span_kind, name, meta in spans:
            with turn.span(span_kind, name) as span:
                span.meta.update(meta)
        await traces.close_turn(pool, turn, status)
        turn_id = turn.id
    await pool.execute(
        "INSERT INTO messages (conversation_id, role, content, turn_id, created_at) "
        "VALUES ($1, 'assistant', $2, $3, $4)",
        conversation_id,
        content,
        turn_id,
        _WRITTEN,
    )


async def _history_she_was_handed(owner_client, pool, mount_peers, **seed) -> str:
    """Seed one earlier row, run a real turn, and return that row exactly as
    the gateway received it."""
    gateway = FakeGateway()
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client)
    # The active conversation exists before the row is seeded into it.
    active = await owner_client.get("/api/v1/conversations/active")
    conversation_id = uuid.UUID(active.json()["id"])
    content = f"hub is ready and serving ({uuid.uuid4().hex[:8]})."
    await _seed_row(pool, conversation_id, content, **seed)

    status, _ = await _say(owner_client, "Where do your models run, and is that machine ready?")
    assert status == 200
    sent = gateway.seen[0][1]["messages"]
    (row,) = [m for m in sent if m["role"] == "assistant" and m["content"].endswith(content)]
    stamp = row["content"][: -len(content)]
    return stamp.rstrip(" ")


MUST_STAMP = [
    pytest.param(
        {"spans": (_tool_span(MACHINE_STATUS.name),)},
        _READING,
        id="her own machine_status answered",
    ),
    pytest.param(
        {"spans": (_tool_span(MACHINE_STATUS.name, unasked=True),)},
        _READING,
        id="an unasked machine_status answered — she was handed its result",
    ),
    pytest.param(
        {"spans": (_tool_span("device_info"),)},
        _READING,
        id="any live-reading tool, not only a machine read",
    ),
    pytest.param(
        {
            "spans": (
                _tool_span(MACHINE_STATUS.name, ok=False),
                _tool_span(MACHINE_STATUS.name),
            )
        },
        _READING,
        id="a retry that answered after a failed read",
    ),
    pytest.param(
        {"kind": "beat"},
        f"[a beat message from {_WHEN}; {_MOMENT}",
        id="a beat's row",
    ),
    pytest.param(
        {"kind": "scheduled", "spans": (_tool_span(MACHINE_STATUS.name),)},
        f"[a scheduled message from {_WHEN}; {_MOMENT}",
        id="a scheduled firing that read live says it was a firing",
    ),
    pytest.param(
        {"status": "error", "spans": (_tool_span(MACHINE_STATUS.name),)},
        f"[that turn failed at {_WHEN}; {_MOMENT}",
        id="a failed turn's stamp still comes first",
    ),
]


@requires_db
@pytest.mark.parametrize(("seed", "stamp"), MUST_STAMP)
async def test_a_row_is_stamped_from_the_turn_behind_it(
    owner_client, pool, mount_peers, seed, stamp
):
    assert await _history_she_was_handed(owner_client, pool, mount_peers, **seed) == stamp


MUST_NOT_STAMP = [
    pytest.param({}, id="a chat turn with no spans"),
    pytest.param(
        {"spans": (_tool_span(MACHINE_STATUS.name, ok=False),)},
        id="a machine read that failed took no reading",
    ),
    pytest.param(
        {"spans": (_tool_span("device_notify"),)},
        id="device_notify is ephemeral but changes something",
    ),
    pytest.param(
        {"spans": (("guard", MACHINE_STATUS.name, {"ok": True}),)},
        id="only a tool span is a read, whatever another span is named",
    ),
    pytest.param({"kind": "reminder"}, id="a reminder the scheduler delivered"),
    pytest.param({"kind": None}, id="a row with no turn behind it"),
]


@requires_db
@pytest.mark.parametrize("seed", MUST_NOT_STAMP)
async def test_an_ordinary_row_reaches_her_unstamped(owner_client, pool, mount_peers, seed):
    assert await _history_she_was_handed(owner_client, pool, mount_peers, **seed) == ""


# What the stamp deliberately does not catch, pinned so a change to any of
# them is a decision rather than a drift.
ACCEPTED_MISSES = [
    # The REPLAY shape: a reply that repeats an earlier reading and takes no
    # reading of its own has none behind it, so it is not stamped. Its source
    # row is; the replay is refused by state_claim, not marked here.
    #
    # Corrected in the S40b final fix wave (C10): b02a5694 itself is NOT this
    # shape. That turn DID carry a tool span — an unasked machine-catalogue
    # check a recalled note triggered — which is why its redirect was blocked
    # as tools_already_ran and its reply was REPLACED without regenerating
    # (verdict §3.4). An unasked live reading stamps the row like any other
    # (see MUST_STAMP above): she was handed its result before she wrote.
    pytest.param(
        {"spans": (("llm_call", None, {"served_by": "hub:qwen3:8b", "local": True}),)},
        id="a replay of an earlier reading, with no read of its own at all",
    ),
    # reads_only but not ephemeral: by declaration its result does not go
    # stale, so a row reporting a timer's state is unstamped even after the
    # timer changed.
    pytest.param(
        {"spans": (_tool_span("list_timers"),)},
        id="a reads-only tool that does not declare itself stale",
    ),
    pytest.param(
        {"spans": (_tool_span("memory_search"),)},
        id="a note read back from memory",
    ),
]


@requires_db
@pytest.mark.parametrize("seed", ACCEPTED_MISSES)
async def test_accepted_misses_reach_her_unstamped(owner_client, pool, mount_peers, seed):
    assert await _history_she_was_handed(owner_client, pool, mount_peers, **seed) == ""


@requires_db
async def test_a_reading_tool_registered_later_stamps_its_turns_by_declaration(
    owner_client, pool, mount_peers, monkeypatch
):
    """The query's tool set is read from the registry at the turn, not
    frozen at import: a new live-reading tool needs no edit here."""
    monkeypatch.setitem(
        tools.REGISTRY,
        "probe_reading",
        _probe_tool("probe_reading", ephemeral=True, reads_only=True),
    )
    stamp = await _history_she_was_handed(
        owner_client, pool, mount_peers, spans=(_tool_span("probe_reading"),)
    )
    assert stamp == _READING


@requires_db
async def test_the_stored_row_is_untouched(owner_client, pool, mount_peers):
    """The stamp is on the copy handed to the model, never written back: the
    transcript he reads is what she said."""
    stamp = await _history_she_was_handed(
        owner_client, pool, mount_peers, spans=(_tool_span(MACHINE_STATUS.name),)
    )
    assert stamp == _READING
    stored = await pool.fetch("SELECT content FROM messages WHERE role = 'assistant'")
    assert not any(row["content"].startswith("[written at") for row in stored)


# ── S40b final fix wave ─────────────────────────────────────────────────────
#
# C7: a stamp she COPIES to the start of her reply is the backend's label on
# an older row, with that row's time on it. The persist boundary drops it,
# mechanically (chat._persist_assistant, guards.without_leading_stamp) — never
# by asking her not to — and the guards read the reply the same way, so none
# honours a label the record will not carry.


@requires_db
async def test_a_copied_leading_stamp_is_stripped_at_the_persist_boundary(
    owner_client, pool, mount_peers
):
    from app import chat
    from tests.fakes import ScriptedGateway
    from tests.test_chat_state_claim import text

    copied = chat._LIVE_READING_MARKER.format(when=_WHEN)
    reply = f"{copied} 17 multiplied by 23 is 391."
    gateway = ScriptedGateway(rounds=((text(reply),),), served_by="hub:qwen3:8b")
    mount_peers(gateway=gateway, memory=FakeMemory())

    status, _ = await _say(owner_client, "What's 17 times 23?")

    assert status == 200
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == "17 multiplied by 23 is 391."


def test_only_a_leading_stamp_is_stripped():
    """A stamp she quotes later in the reply labels what it sits beside, and
    a bracket that is not the stamp's shape is her own words."""
    from app import chat, guards

    stamp = chat._LIVE_READING_MARKER.format(when=_WHEN)
    later = f"Here is what I had.\n{stamp}\n- Last Reported: 05:15 UTC"
    assert guards.without_leading_stamp(later) == later
    own = "[Note] hub is answering."
    assert guards.without_leading_stamp(own) == own
    for template in (*chat._PAST_TURN_MARKERS.values(), chat._RECORD_KIND_MARKER):
        copied = template.format(when=_WHEN, kind="beat")
        assert guards.without_leading_stamp(f"  {copied}\n\nThe reply.") == "The reply."
