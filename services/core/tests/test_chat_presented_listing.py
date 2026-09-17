"""The presented-listing guard wired into the real turn, and its ONE redirect.

Measured 2026-09-03 (qwen3.8:27b, agent_quality case bare-intent-no-action):
asked to list the workspace, the model made ZERO tool calls and replied with a
plausible tree-drawn listing WITH FILE SIZES, recited from a memory recall of an
earlier listing. No guard covered that shape, so the fabrication shipped — and
would have been ingested, where recall serves it back as the next parrot's
tree.

These drive the real route through a scripted gateway and the REAL
workspace_list_files against a temp workspace: the claim fires only when nothing
listed, the redirect actually LISTS (a real tool span, and the regeneration's
listing is then backed), a regeneration that still presents an unbacked listing
is refused by name and keeps the correction, an unredirected turn stays out of
memory, the user's own pasted listing is exempt, a NEW tool declaring the listing
result kind (or returning a listing-shaped result) satisfies the guard with no
guard code change, and the single redirect budget is shared with the other
claim guards.
"""
from __future__ import annotations

import json

import pytest

from app import chat, guards, tools
from app.tools.base import Tool, ToolContext
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway

pytestmark = requires_db

DONE = "[DONE]"
ASK = "show me my workspace directory structure"

# The measured shape, verbatim in spirit: a tree, sizes, no call behind it.
FABRICATED = (
    "Here's your workspace:\n"
    "├── config.json — 12.4 KB\n"
    "├── README.md — 2.1 KB\n"
    "├── notes.md — 905 bytes\n"
    "└── src/\n"
    "    └── app.py — 3.4 KB"
)
# What the temp workspace really holds (written by the `workspace` fixture).
REAL_FILES = {"config.json": "{}", "README.md": "# hi\n", "notes.md": "n", "src/app.py": "x=1\n"}
HONEST = (
    "Here's what is actually in the workspace:\n"
    "config.json  2 bytes\nREADME.md  5 bytes\nnotes.md  1 bytes\nsrc/app.py  4 bytes"
)
NO_SCHEMA = {"type": "object", "properties": {}, "required": [], "additionalProperties": False}


def frames(body: str) -> list:
    out = []
    for block in body.strip().split("\n\n"):
        assert block.startswith("data: "), block
        payload = block[len("data: ") :]
        out.append(payload if payload == DONE else json.loads(payload))
    return out


def text(piece: str) -> dict:
    return {"choices": [{"delta": {"content": piece}}]}


def tool_call(call_id: str, name: str, args: dict) -> dict:
    return {
        "choices": [
            {
                "delta": {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps(args)},
                        }
                    ]
                }
            }
        ]
    }


@pytest.fixture
def workspace(monkeypatch, tmp_path):
    """A real workspace with four files, so the REAL workspace_list_files (auto
    by seed, migration 004) has something to list."""
    root = tmp_path / "workspace"
    for rel, body in REAL_FILES.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


async def _say(client, message: str = ASK) -> list:
    resp = await client.post("/api/v1/chat/stream", json={"message": message})
    assert resp.status_code == 200, resp.text
    return frames(resp.text)


def _corrections(sent: list) -> list[str]:
    return [f["correction"] for f in sent if isinstance(f, dict) and "correction" in f]


def _texts(sent: list) -> list[str]:
    return [f["t"] for f in sent if isinstance(f, dict) and "t" in f]


async def _guard_spans(pool) -> list:
    return await pool.fetch(
        "SELECT name, meta FROM turn_spans WHERE kind = 'guard' ORDER BY started_at"
    )


async def _tool_spans(pool) -> list:
    return await pool.fetch(
        "SELECT name, meta FROM turn_spans WHERE kind = 'tool' ORDER BY started_at"
    )


async def _stored(pool) -> str:
    return await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")


class Spy:
    def __init__(self, result: str) -> None:
        self.calls: list[dict] = []
        self.result = result

    async def __call__(self, args: dict, ctx: ToolContext) -> str:
        self.calls.append(args)
        return self.result


async def _arm_auto(pool, monkeypatch, name: str, spy: Spy, **fields) -> Spy:
    """A private tool in the registry. Registering it is all it takes for its
    call to RUN — there is no disposition row and no card (no approvals)."""
    monkeypatch.setitem(tools.REGISTRY, name, Tool(name, "d", NO_SCHEMA, spy, **fields))
    return spy


# -- the headline: the claim fires, and the redirect actually lists ---------


async def test_the_measured_case_fires_and_the_redirect_lists_for_real(
    owner_client, pool, mount_peers, workspace
):
    """Round 1 is the measured reply with ZERO tool calls. The guard fires (a
    listing, no listing span) and the turn spends its one redirect on a
    regeneration WITH tools: it calls the REAL workspace_list_files, the call
    is dispatched through the same machinery as any other round (a real tool
    span, ok=True, over the temp workspace), and the reply that presents the
    TRUE listing — now backed by that span — REPLACES the durable text."""
    gateway = ScriptedGateway(
        rounds=(
            (text(FABRICATED),),
            (tool_call("r1", "workspace_list_files", {}),),
            (text(HONEST),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client)

    assert gateway.calls == 3  # the claim, one redirect, its closing round
    ran = await _tool_spans(pool)
    assert [(s["name"], s["meta"]["ok"]) for s in ran] == [("workspace_list_files", True)]
    assert "4 files under the workspace root" in ran[0]["meta"]["result_head"]

    assert await _stored(pool) == HONEST
    assert guards.PRESENTED_LISTING_CORRECTION not in await _stored(pool)
    assert _corrections(sent) == [chat.PRESENTED_LISTING_REDIRECT_NOTE]
    assert _texts(sent) == [FABRICATED, HONEST]

    spans = await _guard_spans(pool)
    assert [s["name"] for s in spans] == ["presented_listing"]
    meta = spans[0]["meta"]
    assert meta["redirected"] is True
    assert meta["entries"] == 5
    assert meta["phrase"] == "├── config.json — 12.4 KB"
    assert meta["listing_tools"] == tools.tool_names_by_result_kind(tools.RESULT_KIND_LISTING)
    assert meta["ran_a_tool"] is False
    assert await pool.fetchval("SELECT status FROM turns") == "ok"

    # A turn that DID the listing is ordinary knowledge again.
    await chat.drain_background()
    assert len(memory.ingests) == 1
    assert memory.ingests[0]["exchange"]["assistant"] == HONEST


async def test_a_regen_that_still_presents_an_unbacked_listing_keeps_the_correction(
    owner_client, pool, mount_peers, workspace
):
    """Bounded to ONE. The regeneration presents ANOTHER listing with no call
    behind it, so the FULL mechanical vetting of the redirect's output refuses
    it by name, the correction persists ALONE (replace-class — the recited tree
    must not reach the next turn's history, where it would be the next parrot's
    source), and the turn stays out of memory."""
    again = "Sorry — here it is:\n- config.json (12 KB)\n- README.md (2 KB)\n- notes.md (1 KB)"
    gateway = ScriptedGateway(rounds=((text(FABRICATED),), (text(again),)))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client)

    assert gateway.calls == 2  # the claim, one redirect, and stop
    assert await _tool_spans(pool) == []  # nothing ever listed
    stored = await _stored(pool)
    assert stored == guards.PRESENTED_LISTING_CORRECTION
    assert "config.json" not in stored
    assert _corrections(sent) == [guards.PRESENTED_LISTING_CORRECTION]
    assert _texts(sent) == [FABRICATED]  # the second recital never streams

    spans = await _guard_spans(pool)
    assert [s["name"] for s in spans] == ["presented_listing"]
    assert spans[0]["meta"]["redirected"] is False
    assert spans[0]["meta"]["regen_rejected_by"] == "presented_listing"
    assert await pool.fetchval("SELECT status FROM turns") == "ok"

    await chat.drain_background()
    assert memory.ingests == []  # a recited listing is not knowledge


async def test_a_regen_that_says_plainly_it_has_not_listed_stands(
    owner_client, pool, mount_peers, workspace
):
    """The honest no-tool answer the nudge offers is available WITHOUT
    reproducing the block: naming the files in prose is not a listing, so the
    regeneration stands and the turn is ordinary knowledge."""
    # No trailing "Want me to list it again?": behind a listing instruction
    # that is the instruction handed back, and the deferral guard's offer
    # shape (owner ruling 2026-09-03) refuses such a regeneration by name.
    plain = (
        "I have not listed the workspace this turn — earlier it had config.json, "
        "README.md and notes.md."
    )
    gateway = ScriptedGateway(rounds=((text(FABRICATED),), (text(plain),)))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    await _say(owner_client)

    assert gateway.calls == 2
    assert await _stored(pool) == plain
    spans = await _guard_spans(pool)
    assert [s["name"] for s in spans] == ["presented_listing"]
    assert spans[0]["meta"]["redirected"] is True
    await chat.drain_background()
    assert len(memory.ingests) == 1


async def test_a_gateway_failure_in_the_redirect_ships_the_correction(
    owner_client, pool, mount_peers, workspace
):
    """FAIL-OPEN: the redirect's round dies (the script has no round 2, so it
    answers 500). The correction ships — never an error frame, never a lost
    turn."""
    gateway = ScriptedGateway(rounds=((text(FABRICATED),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)

    assert _corrections(sent) == [guards.PRESENTED_LISTING_CORRECTION]
    assert not [f for f in sent if isinstance(f, dict) and "error" in f]
    assert await _stored(pool) == guards.PRESENTED_LISTING_CORRECTION
    spans = await _guard_spans(pool)
    assert spans[0]["meta"]["redirected"] is False
    assert spans[0]["meta"]["error"]
    assert await pool.fetchval("SELECT status FROM turns") == "ok"


# -- the toggles, through the real route -----------------------------------


async def test_the_same_listing_is_clean_after_a_real_listing_call_this_turn(
    owner_client, pool, mount_peers, workspace
):
    """The DECLARED toggle, end to end: round 1 calls the REAL
    workspace_list_files, so round 2's listing — even the FABRICATED text
    itself, sizes and all — is backed by a declared listing span. No guard
    fires, no redirect runs (a third gateway call would be a loud 500), and
    the reply stands untouched and is ingested."""
    gateway = ScriptedGateway(
        rounds=((tool_call("d1", "workspace_list_files", {}),), (text(FABRICATED),))
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client)

    assert gateway.calls == 2
    assert [s["name"] for s in await _guard_spans(pool)] == []
    assert _corrections(sent) == []
    assert await _stored(pool) == FABRICATED
    await chat.drain_background()
    assert len(memory.ingests) == 1


async def test_prose_that_merely_names_files_is_never_redirected(
    owner_client, pool, mount_peers, workspace
):
    """Precision first: two files named in a sentence, one path, and a numbered
    list of steps all ship untouched. One gateway call each."""
    honest = [
        "I see config.json and README.md in there.",
        "Your config lives at src/config.json — want me to open it?",
        "1. Open config.json\n2. Edit the README.md section\n3. Run build.sh",
    ]
    for reply in honest:
        await pool.execute("TRUNCATE turn_spans, turns, messages, conversations CASCADE")
        gateway = ScriptedGateway(rounds=((text(reply),),))
        mount_peers(gateway=gateway, memory=FakeMemory())

        sent = await _say(owner_client)

        assert gateway.calls == 1, reply
        assert [s["name"] for s in await _guard_spans(pool)] == [], reply
        assert _corrections(sent) == [], reply
        assert await _stored(pool) == reply


async def test_a_listing_the_user_pasted_may_be_echoed_and_annotated(
    owner_client, pool, mount_peers, workspace
):
    """The PASTE toggle, end to end: the user's message carries the listing;
    the reply re-renders it with sizes and a verdict. Every name is theirs, so
    the guard is silent and the reply stands — one gateway call."""
    pasted = (
        "which of these is biggest?\n"
        "-rw-r--r-- 1 j j  120 Sep 1 config.json\n"
        "-rw-r--r-- 1 j j 2048 Sep 1 README.md\n"
        "-rw-r--r-- 1 j j   33 Sep 1 notes.md"
    )
    reply = (
        "From what you pasted:\n"
        "├── README.md — 2.0 KB (the biggest)\n"
        "├── config.json — 120 B\n"
        "└── notes.md — 33 B"
    )
    gateway = ScriptedGateway(rounds=((text(reply),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, pasted)

    assert gateway.calls == 1
    assert [s["name"] for s in await _guard_spans(pool)] == []
    assert _corrections(sent) == []
    assert await _stored(pool) == reply


# -- the derivation pin: a NEW tool satisfies the guard with no guard change --


async def test_a_new_tool_declaring_the_listing_kind_backs_the_listing(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """A tool this guard has never heard of, returning a format it has never
    seen, declares Tool.result_kind = listing. Round 1 calls it; round 2
    presents the measured tree. The registry derivation carries the new name
    to the guard by itself: silent, no redirect, no code touched."""
    spy = await _arm_auto(
        pool,
        monkeypatch,
        "brand_new_lister",
        Spy("<entries><e n='config.json'/><e n='README.md'/></entries>"),
        result_kind=tools.RESULT_KIND_LISTING,
    )
    gateway = ScriptedGateway(
        rounds=((tool_call("n1", "brand_new_lister", {}),), (text(FABRICATED),))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)

    assert gateway.calls == 2
    assert spy.calls == [{}]
    assert [s["name"] for s in await _guard_spans(pool)] == []
    assert _corrections(sent) == []
    assert await _stored(pool) == FABRICATED


async def test_a_new_undeclared_tool_whose_result_is_a_listing_backs_it_too(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """The SHAPED derivation: an undeclared tool (a shell run) whose result
    reads as a listing backs the reply on its OUTPUT. Silent, no redirect."""
    spy = await _arm_auto(
        pool,
        monkeypatch,
        "shell_probe",
        Spy("box ran ['ls', '-la'] — exit 0\ntotal 12\n"
            "-rw-r--r-- 1 u u 10 Sep 1 10:00 a.txt\n"
            "-rw-r--r-- 1 u u 20 Sep 1 10:00 b.txt\n"
            "drwxr-xr-x 2 u u 4096 Sep 1 10:00 c"),
    )
    assert "shell_probe" not in tools.tool_names_by_result_kind(tools.RESULT_KIND_LISTING)
    gateway = ScriptedGateway(
        rounds=((tool_call("s1", "shell_probe", {}),), (text(FABRICATED),))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)

    assert gateway.calls == 2
    assert spy.calls == [{}]
    assert [s["name"] for s in await _guard_spans(pool)] == []
    assert _corrections(sent) == []


async def test_a_listing_after_an_unreadable_tool_result_is_kept_with_a_note(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """Review item 7. An undeclared tool ran and its recorded head is noise
    (a `find` whose first 500 chars are permission-denied lines), then the
    model presents a listing. Neither derivation can back it — but a tool DID
    run, and it may well have listed. So: no redirect (a second dispatch is
    worse than the doubt), and NO REPLACEMENT (that could drop an honest
    listing). The prose stays, the unverified note is appended, the span says
    why, and the turn is not ingested (an unverified listing is not knowledge)."""
    noise = "\n".join(
        f"find: '/root/{d}': Permission denied" for d in ("a", "b", "c", "d", "e", "f")
    )
    spy = await _arm_auto(
        pool, monkeypatch, "shell_probe", Spy(f"box ran ['find', '/'] — exit 1\n{noise}")
    )
    gateway = ScriptedGateway(
        rounds=((tool_call("f1", "shell_probe", {}),), (text(FABRICATED),))
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client)

    assert gateway.calls == 2  # no redirect round
    assert spy.calls == [{}]
    spans = await _guard_spans(pool)
    assert [s["name"] for s in spans] == ["presented_listing"]
    meta = spans[0]["meta"]
    assert meta["redirected"] is False
    assert meta["not_redirected_because"] == "tools_already_ran"
    assert meta["appended_note"] is True
    assert _corrections(sent) == [chat.PRESENTED_LISTING_UNVERIFIED_NOTE]
    stored = await _stored(pool)
    assert stored == f"{FABRICATED}\n\n{chat.PRESENTED_LISTING_UNVERIFIED_NOTE}"
    assert guards.PRESENTED_LISTING_CORRECTION not in stored
    await chat.drain_background()
    assert memory.ingests == []


async def test_a_memory_search_recalling_an_old_listing_does_not_launder_it(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """Review item 3, through the real route: the memory tool recalls last
    week's listing flattened onto one line; the model re-presents it as a
    tree. Every name is in a tool result — and that backs NOTHING. The guard
    fires; a tool ran, so the note is appended rather than the prose replaced."""
    spy = await _arm_auto(
        pool,
        monkeypatch,
        "recall_probe",
        Spy(
            "1 note(s) matched 'workspace':\n- workspace listing (note): config.json "
            "12.4 KB README.md 2.1 KB notes.md 905 bytes src/app.py 3.4 KB"
        ),
    )
    gateway = ScriptedGateway(
        rounds=((tool_call("m1", "recall_probe", {}),), (text(FABRICATED),))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)

    assert spy.calls == [{}]
    spans = await _guard_spans(pool)
    assert [s["name"] for s in spans] == ["presented_listing"]
    assert spans[0]["meta"]["not_redirected_because"] == "tools_already_ran"
    assert _corrections(sent) == [chat.PRESENTED_LISTING_UNVERIFIED_NOTE]


# -- the SHARED redirect budget --------------------------------------------


async def test_both_claims_get_one_redirect_and_both_corrections_on_failure(
    owner_client, pool, mount_peers, workspace
):
    """ONE redirect per turn, first claim wins. A reply that BOTH fabricates a
    pending approval AND presents an unbacked listing qualifies for two — the
    consent guard takes the budget, its regeneration fails to clear the bar,
    and the listing guard then only CORRECTS. Two gateway calls, two guard
    spans, both corrections in the durable record, and the turn stays out of
    memory."""
    both = f"That's awaiting your approval. Meanwhile, from memory:\n{FABRICATED}"
    gateway = ScriptedGateway(
        rounds=((text(both),), (text("It is still pending your approval."),))
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client)

    assert gateway.calls == 2  # ONE redirect, not two
    spans = await _guard_spans(pool)
    assert [s["name"] for s in spans] == ["consent_claim", "presented_listing"]
    assert spans[0]["meta"]["redirected"] is False
    assert spans[1]["meta"]["redirected"] is False
    assert spans[1]["meta"]["not_redirected_because"] == "redirect_spent"

    assert await _stored(pool) == (
        f"{guards.CONSENT_CLAIM_CORRECTION}\n\n{guards.PRESENTED_LISTING_CORRECTION}"
    )
    assert _corrections(sent) == [
        guards.CONSENT_CLAIM_CORRECTION,
        guards.PRESENTED_LISTING_CORRECTION,
    ]
    await chat.drain_background()
    assert memory.ingests == []


async def test_a_successful_state_redirect_skips_the_listing_guard_entirely(
    owner_client, pool, mount_peers, workspace
):
    """When an earlier redirect STANDS, the durable text is the regeneration —
    which `_regen_rejected_by` already vetted with the listing check against
    the now-live spans. Judging the discarded prose would file a span about
    text nobody reads, so it does not happen: one guard span (the state
    claim's), and the regenerated reply persists — a REAL listing, backed by
    the redirect's own workspace_list_files call."""
    await pool.execute(
        "INSERT INTO devices (name, platform, hostname, pubkey) "
        "VALUES ('DELL-XPS-8950', 'linux', 'dell', $1)",
        "a" * 64,
    )
    both = f"The device is still offline, so from memory:\n{FABRICATED}"
    gateway = ScriptedGateway(
        rounds=(
            (text(both),),
            (tool_call("r1", "workspace_list_files", {}),),
            (text(HONEST),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)

    assert gateway.calls == 3
    assert [s["name"] for s in await _guard_spans(pool)] == ["state_claim"]
    assert await _stored(pool) == HONEST
    assert _corrections(sent) == [chat.STATE_REDIRECT_NOTE]


async def test_a_detector_error_fails_open_and_ships_the_reply(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """The detector itself is fail-OPEN: if presented_listing_check raises,
    the reply ships unchanged — one gateway call, no redirect, no span."""

    def boom(*_args, **_kwargs):
        raise RuntimeError("detector blew up")

    monkeypatch.setattr(chat.guards, "presented_listing_check", boom)
    gateway = ScriptedGateway(rounds=((text(FABRICATED),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)

    assert gateway.calls == 1
    assert await _stored(pool) == FABRICATED
    assert [s["name"] for s in await _guard_spans(pool)] == []
    assert not [f for f in sent if isinstance(f, dict) and "error" in f]
