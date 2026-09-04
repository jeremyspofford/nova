"""The pending-approval claim guard through a real chat turn, and the loop that
never waits on anyone.

v4 makes NO authorization decisions (owner ruling 2026-09-03): there is no
approval card, no consent row, no disposition, no "awaiting" frame — a tool
call runs the moment the model makes it. That leaves exactly one thing for the
old consent machinery's name to mean: the LIE. A reply that says an action is
awaiting or pending the operator's approval is a fabrication by construction,
and guards.consent_claim_check (a pure text detector now) is the line of code
that refuses. These prove the wiring through the real route with a scripted
gateway: the claim is corrected on its own frame, the durable record is the
correction ALONE (never the lie), the turn stays out of memory, the guard's
ONE tool-armed redirect actually does the work, and the two preconditions that
keep a redirect from executing twice (nothing ran yet, not out of rounds) hold.

Formerly test_chat_consent.py, which also drove the card -> deny -> approve ->
burn loop and the continuation plumbing; those left with the mechanism.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field

import pytest

from app import chat, guards, tools
from app.main import app
from app.tools import web, web_search
from app.tools.base import Tool, ToolContext
from tests import fakes
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway

pytestmark = requires_db

DONE = "[DONE]"
FETCH_SCHEMA = next(t.parameters for t in web.TOOLS if t.name == "fetch_url")
URL = "https://example.com/pricing"


@dataclass
class Spy:
    calls: list = field(default_factory=list)
    result: str = "Fetched it."

    async def __call__(self, args: dict, ctx: ToolContext) -> str:
        self.calls.append(args)
        return self.result


def frames(body: str) -> list:
    out = []
    for block in body.strip().split("\n\n"):
        assert block.startswith("data: "), block
        payload = block[len("data: ") :]
        out.append(payload if payload == DONE else json.loads(payload))
    return out


def call_delta(index: int, *, call_id=None, name=None, arguments=None) -> dict:
    function: dict = {}
    if name is not None:
        function["name"] = name
    if arguments is not None:
        function["arguments"] = arguments
    fragment: dict = {"index": index, "function": function}
    if call_id is not None:
        fragment["id"] = call_id
        fragment["type"] = "function"
    return {"choices": [{"delta": {"tool_calls": [fragment]}}]}


def text(piece: str) -> dict:
    return {"choices": [{"delta": {"content": piece}}]}


def fetch_call(call_id: str, url: str) -> dict:
    return call_delta(0, call_id=call_id, name="fetch_url", arguments=json.dumps({"url": url}))


def search_call(call_id: str, query: str) -> dict:
    return call_delta(
        0, call_id=call_id, name="web_search", arguments=json.dumps({"query": query})
    )


async def _say(client, message: str) -> list:
    resp = await client.post("/api/v1/chat/stream", json={"message": message})
    assert resp.status_code == 200, resp.text
    return frames(resp.text)


def _frame_keys(sent: list) -> set[str]:
    """Every frame key the stream carried — the pin that no `{consent: …}`
    frame (or any other approval shape) exists on the wire any more."""
    return {key for f in sent if isinstance(f, dict) for key in f}


def _spy_fetch(monkeypatch) -> Spy:
    spy = Spy()
    # ephemeral=True mirrors the REAL fetch_url (web.py): a live, point-in-time
    # read whose result the turn loop must not ingest, or recall serves it stale.
    monkeypatch.setitem(
        tools.REGISTRY, "fetch_url", Tool("fetch_url", "d", FETCH_SCHEMA, spy, ephemeral=True)
    )
    return spy


def _activities(sent: list) -> list[tuple[str, str]]:
    return [
        (f["activity"]["tool"], f["activity"]["status"])
        for f in sent
        if isinstance(f, dict) and "activity" in f
    ]


def _corrections(sent: list) -> list[str]:
    return [f["correction"] for f in sent if isinstance(f, dict) and "correction" in f]


def _tools_advertised(payload: dict) -> bool:
    return bool(payload.get("tools"))


async def _guard_spans(pool) -> list:
    return await pool.fetch(
        "SELECT name, meta FROM turn_spans WHERE kind = 'guard' ORDER BY started_at"
    )


async def _tool_spans(pool) -> list:
    return await pool.fetch(
        "SELECT name, meta FROM turn_spans WHERE kind = 'tool' ORDER BY started_at"
    )


# -- the prompt states the truth; the guard checks it anyway -------------------


def test_the_system_prompt_names_no_approval_step():
    """State what is true, then check it anyway. The prompt used to instruct
    the model to say "I've requested their approval" — a sentence that would
    have outlived the mechanism and had her lie every turn. The only approval
    words left in it are the ones saying there is no such step, and the guard
    family is clean over the sentence (it is what she reads every turn)."""
    prompt = chat.stable_system_prompt("m", tools.tool_names())
    assert "There is no approval step: when you call a tool it runs in this turn." in prompt
    assert "Never say an action is awaiting or pending anyone's approval" in prompt
    # The old sentence, in every phrasing it had.
    for stale in (
        "operator's approval",
        "Awaiting your approval",
        "requested their approval",
        "approval card",
    ):
        assert stale not in prompt, stale
    # The two mentions above are the ONLY ones: a third would be a new promise.
    assert prompt.lower().count("approval") == 2
    assert guards.consent_claim_check(prompt) is None
    assert guards.deferral_check(prompt, [], tools.tool_names()) is None


# -- the claim is corrected, and the lie never reaches the record --------------


async def test_a_parroted_pending_claim_is_corrected(owner_client, pool, mount_peers):
    """The walk's core defect: the model claims a fetch is awaiting approval and
    made no tool call. Nothing is ever pending in v4, so the guard contradicts
    it on its own frame, records a guard span — and the PERSISTED reply is the
    correction ALONE (the anti-poison fix): the fabricated prose must not
    survive into the record, or the next turn's history would replay it.

    This is also the FAIL-OPEN path of the redirect, ASSERTED rather than
    relied on: the one-round script leaves the redirect no round to regenerate
    from (the script answers 500), so the redirect is attempted — two gateway
    calls — and its failure degrades to exactly this behaviour, with the stated
    reason on the span. Without those assertions the test would pass
    identically if the redirect had silently stopped running at all."""
    fabrication = (
        "That fetch is awaiting your approval — I can't complete it "
        "without you OK'ing it."
    )
    gateway = ScriptedGateway(rounds=((text(fabrication),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "what's new on bigblueview.com")

    # The reply, then the ONE redirect the guard is entitled to (refused by the
    # exhausted script) — never a third call, and never zero.
    assert gateway.calls == 2
    assert _corrections(sent) == [guards.CONSENT_CLAIM_CORRECTION]
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    # REPLACE, not append: correction only, none of the fabricated prose.
    assert stored == guards.CONSENT_CLAIM_CORRECTION
    assert "That fetch is awaiting" not in stored
    assert "OK'ing it" not in stored
    guard = await pool.fetchrow("SELECT name, meta FROM turn_spans WHERE kind = 'guard'")
    assert guard["name"] == "consent_claim"
    # Nothing external was consulted: the span carries no pending-state fact,
    # only what the redirect itself measured and did.
    assert "has_pending_consent" not in guard["meta"]
    assert guard["meta"]["ran_a_tool"] is False
    assert guard["meta"]["redirected"] is False
    assert guard["meta"]["error"]
    assert "consent" not in _frame_keys(sent)


async def test_a_pending_claim_turn_is_not_ingested_into_memory(
    owner_client, pool, mount_peers
):
    """The context-poisoning fix, the MEMORY half. A turn the consent guard
    fired on is interaction PLUMBING, not knowledge: ingesting an 'awaiting
    approval' reply makes /recall re-inject that noise into LATER turns — even
    in other conversations, since memory is per-person — training the small
    model to narrate 'awaiting approval' (or hedge and defer) instead of calling
    the tool. So it ingests NOTHING. The transcript still keeps the correction
    for the operator (asserted above); only durable memory must stay clean,
    because memory is what crosses conversations."""
    fabrication = "That fetch is awaiting your approval."
    gateway = ScriptedGateway(rounds=((text(fabrication),),))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    await _say(owner_client, "what's new on bigblueview.com")

    await chat.drain_background()
    assert memory.ingests == []  # plumbing is not knowledge — nothing to recall later


async def test_an_ordinary_turn_is_still_ingested(owner_client, pool, mount_peers):
    """The skip is SCOPED to guarded turns: an ordinary reply — no guard
    correction — is ingested exactly as before, so the memory hygiene fix does
    not silently stop Nova from remembering real exchanges."""
    gateway = ScriptedGateway(
        rounds=((text("KV offloading moves the attention cache to CPU RAM to free VRAM."),),)
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    await _say(owner_client, "what is kv offloading?")

    await chat.drain_background()
    assert len(memory.ingests) == 1


# -- a tool call runs the moment it is made ------------------------------------


def test_the_real_fetch_url_tool_is_ephemeral():
    """Pin the flag the ingest skip derives from: a web fetch is a live read.
    If a refactor drops it, the stale-page regurgitation bug returns silently."""
    assert any(t.name == "fetch_url" and t.ephemeral for t in web.TOOLS)


async def test_a_fetch_runs_directly_and_is_not_ingested(
    owner_client, pool, mount_peers, monkeypatch
):
    """A "what's the latest?" turn calls fetch_url and it runs DIRECTLY: no
    frame of any approval shape, ok=True (the live tile goes start->ok), content
    returned. AND because fetch_url is EPHEMERAL, that successful fetch turn is
    STILL not ingested: recall must never serve a cached page as 'the latest'
    (the owner's walk — byte-identical content, same stale timestamp), so the
    next such turn re-fetches instead of regurgitating a snapshot. The ingest
    skip is DERIVED from the tool's ephemeral flag, not its name."""
    spy = _spy_fetch(monkeypatch)  # ephemeral fetch_url; returns "Fetched it."
    gateway = ScriptedGateway(
        rounds=((fetch_call("c1", URL),), (text("Here are the latest updates."),))
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "what's the latest?")

    assert "consent" not in _frame_keys(sent)
    assert spy.calls == [{"url": URL}]  # it ran directly, exactly once
    # The live tile resolves cleanly (start -> ok), not 'awaiting' and not error.
    assert _activities(sent) == [("fetch_url", "start"), ("fetch_url", "ok")]
    assert await pool.fetchval("SELECT status FROM turns") == "ok"

    await chat.drain_background()
    # Ephemeral read: not ingested, so a later "what's the latest?" re-fetches
    # rather than recalling this snapshot.
    assert memory.ingests == []


def test_the_real_web_search_tool_is_ephemeral():
    """The ingest skip below derives from this flag, not the tool's name. If a
    refactor drops it, a stale search result gets served as 'the latest'."""
    assert any(t.name == "web_search" and t.ephemeral for t in web_search.TOOLS)


async def test_a_web_search_turn_runs_directly_and_is_not_ingested(
    owner_client, pool, mount_peers, monkeypatch
):
    """web_search end to end: the model asks for it, it runs DIRECTLY, the real
    executor reaches a mocked SearXNG and the live tile resolves start->ok. AND
    because web_search is EPHEMERAL, that successful turn is STILL not ingested —
    a later 'what's the latest?' re-searches rather than recalling this snapshot
    and narrating it as current. Mirrors the fetch test above."""
    monkeypatch.setenv("SEARXNG_URL", fakes.SEARXNG_URL)
    searx = fakes.FakeSearx(
        results=(
            {"title": "OpenAI news", "url": "https://example.com/a", "content": "latest"},
        )
    )
    gateway = ScriptedGateway(
        rounds=((search_call("c1", "latest on openai"),), (text("Here's the latest."),))
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)
    # mount_peers set app.state.peer_transports fresh; add the searxng origin the
    # real web_search executor will reach for. Its teardown resets the whole map.
    app.state.peer_transports[fakes.SEARXNG_URL] = fakes.StreamingASGITransport(searx.app)

    sent = await _say(owner_client, "what's the latest on openai?")

    assert "consent" not in _frame_keys(sent)
    assert searx.queries == ["latest on openai"]  # the real tool ran, once
    assert _activities(sent) == [("web_search", "start"), ("web_search", "ok")]
    assert await pool.fetchval("SELECT status FROM turns") == "ok"

    await chat.drain_background()
    assert memory.ingests == []  # ephemeral read: not ingested


async def test_every_round_advertises_tools_and_no_call_ever_waits(
    owner_client, pool, mount_peers, monkeypatch
):
    """The loop never closes on a call. There used to be a round shape that
    dropped the tools after an approval card and answered a further call with
    "an approval is pending"; nothing like it exists now. Every round carries
    the tools, every dispatched call resolves to ok or a stated error (never an
    'awaiting' tile), and no tool span carries a pending-state flag."""
    fetch = _spy_fetch(monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (fetch_call("c1", URL),),
            (fetch_call("c2", "https://example.com/other"),),
            (text("Both pages read."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "read both pages")

    assert fetch.calls == [{"url": URL}, {"url": "https://example.com/other"}]
    assert gateway.calls == 3
    assert all(_tools_advertised(p) for p in gateway.payloads)
    assert "consent" not in _frame_keys(sent)
    assert {status for _tool, status in _activities(sent)} == {"start", "ok"}
    for span in await _tool_spans(pool):
        assert span["meta"]["ok"] is True
        assert "consent_pending" not in span["meta"]
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    assert await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'") == (
        "Both pages read."
    )


# -- guard composition: narration appends, the REPLACE-class guards replace ----


async def test_a_fired_narration_guard_keeps_appending_to_preserve_real_content(
    owner_client, pool, mount_peers
):
    """The documented scope decision: REPLACE (persist correction-only) is
    scoped to consent_claim_check — where the whole reply is predicated on a
    non-existent pending state. narration keeps APPEND, because a fabricated
    completed-action claim routinely sits BESIDE real content the operator asked
    for (here a real summary), and there is no clean mechanical way to separate
    'the whole reply is the lie' from 'one false claim beside real content'.
    Correction-only would throw the substance away, a worse failure than the
    claim persisting; so the substance survives and the claim is contradicted."""
    reply = (
        "KV offloading moves the attention cache to CPU RAM to free VRAM. "
        "I've saved this to kv_offloading.md."
    )
    gateway = ScriptedGateway(rounds=((text(reply),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "summarize kv offloading and save it")

    assert _corrections(sent) == [guards.CORRECTION_TEXT]
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    # Append, not replace: the real summary is preserved, the correction added.
    assert stored.startswith("KV offloading moves the attention cache")
    assert stored.endswith(guards.CORRECTION_TEXT)
    guards_seen = await pool.fetch("SELECT name FROM turn_spans WHERE kind = 'guard'")
    assert [g["name"] for g in guards_seen] == ["narration"]


async def test_both_guards_firing_compose_coherently_without_the_lie(
    owner_client, pool, mount_peers
):
    """A doubly-fabricated reply: a completed-action claim with no span AND a
    pending-approval claim. Both guards fire. The persisted record must be
    coherent — the two corrections adjacent, each once, with NEITHER
    fabrication between them (never two correction blocks stacked around the
    lie). Because the consent guard fired, the whole record is corrections-only:
    the fabricated prose does not survive to poison the next turn."""
    reply = "I've created report.md. That fetch is awaiting your approval."
    gateway = ScriptedGateway(rounds=((text(reply),),))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "make a report and check the page")

    # The reply, then the ONE refused redirect: this composition is the
    # FAIL-OPEN outcome, and saying so here stops the test passing by the
    # redirect having quietly stopped running.
    assert gateway.calls == 2
    # Both corrections streamed, in order (narration, then consent), each once.
    assert _corrections(sent) == [
        guards.CORRECTION_TEXT,
        guards.CONSENT_CLAIM_CORRECTION,
    ]
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == f"{guards.CORRECTION_TEXT}\n\n{guards.CONSENT_CLAIM_CORRECTION}"
    # Neither fabrication survives into the record.
    assert "report.md" not in stored
    assert "awaiting" not in stored

    # Both guard firings are on record. The transcript keeps the coherent
    # correction (asserted above, for the operator); but this is a guarded
    # turn, so durable MEMORY ingests nothing — neither fabrication nor
    # correction crosses into later turns' recall.
    guards_seen = await pool.fetch(
        "SELECT name, meta FROM turn_spans WHERE kind = 'guard'"
    )
    assert sorted(g["name"] for g in guards_seen) == ["consent_claim", "narration"]
    consent_span = next(g for g in guards_seen if g["name"] == "consent_claim")
    assert consent_span["meta"]["redirected"] is False
    assert consent_span["meta"]["error"]  # tried, failed open — not skipped
    await chat.drain_background()
    assert memory.ingests == []


# -- T7: a false CAPABILITY denial is contradicted ------------------------
#
# The owner's live walk: the model disowned a tool (fetch_url) it holds. These
# prove the wiring — the capability guard runs on the raw reply with the live
# registry, streams a {correction} frame, records a "capability_claim" guard
# span, REPLACES the disavowal in the durable record, and skips ingest.

CAP_DENIAL = (
    "I cannot access external websites or real-time data, including bigblueview.com."
)


async def test_a_false_capability_denial_is_corrected_and_replaces_the_lie(
    owner_client, pool, mount_peers
):
    """The T7 defect: the model denies a capability it holds (fetch_url is
    registered) without even calling the tool. The guard contradicts it on its
    own frame, records a 'capability_claim' guard span naming the real tool,
    and the PERSISTED reply is the correction ALONE — the self-limiting denial
    must not survive into history to train the model to keep disowning the
    tool. The correction names the tool and NOTHING about an approval: there is
    no step it could describe."""
    gateway = ScriptedGateway(rounds=((text(CAP_DENIAL),),))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "what's the latest from bigblueview.com?")

    corrections = _corrections(sent)
    assert len(corrections) == 1
    assert corrections[0].startswith("Correction: I can do that")
    assert "fetch_url" in corrections[0]
    assert "approval" not in corrections[0]

    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == corrections[0]  # REPLACE: none of the false denial survives
    assert "I cannot access external websites" not in stored

    guard = await pool.fetchrow("SELECT name, meta FROM turn_spans WHERE kind = 'guard'")
    assert guard["name"] == "capability_claim"
    assert guard["meta"]["capabilities"][0]["tool"] == "fetch_url"

    await chat.drain_background()
    assert memory.ingests == []  # a guard-corrected turn is plumbing, not knowledge
    assert await pool.fetchval("SELECT status FROM turns") == "ok"


async def test_an_honest_specific_result_reply_is_not_capability_corrected_and_still_ingests(
    owner_client, pool, mount_peers
):
    """Precision at the seam: a reply about ONE specific failed attempt ('I
    couldn't fetch that page — it returned a 404') is an honest result, not a
    denial of the ability, so the capability guard stays silent — and because no
    guard fired, the turn is ordinary knowledge and is still ingested (it is not
    wrongly marked plumbing)."""
    reply = "I couldn't fetch that page — it returned a 404, so there's nothing to show."
    gateway = ScriptedGateway(rounds=((text(reply),),))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "what's the latest from bigblueview.com?")

    assert _corrections(sent) == []  # honest specific result, left alone
    guard_names = [
        g["name"] for g in await pool.fetch("SELECT name FROM turn_spans WHERE kind = 'guard'")
    ]
    assert guard_names == []
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == reply  # untouched — no guard fired
    await chat.drain_background()
    assert len(memory.ingests) == 1  # ordinary turn, not plumbing


# -- the consent guard's ONE redirect ---------------------------------------
#
# The owner's walk, 2026-09-02 22:22: he said "try again" (re-run a device
# command); the local model answered with a whole-stance "still awaiting your
# approval" and no tool call; the guard fired correctly — and NOTHING WAS
# RETRIED. The lie was contradicted and the work still did not happen. So a
# fired consent guard spends the turn's single redirect budget on ONE
# regeneration WITH TOOLS: it either does the thing or says plainly that it
# cannot, and only when that fails does the correction persist.

AUTO_ACTION = "auto_probe"
FABRICATION = "That's still awaiting your approval — I can't run it until you OK it."


def auto_call(call_id: str, url: str) -> dict:
    return call_delta(
        0, call_id=call_id, name=AUTO_ACTION, arguments=json.dumps({"url": url})
    )


async def _arm_auto_tool(pool, monkeypatch) -> Spy:
    """A private tool, registered and NOTHING else: no row, no class, no
    disposition — in v4 registering it is all it takes for the redirect's call
    to RUN. Non-ephemeral, so a redirected turn is ordinary knowledge and the
    ingest assertion means something."""
    spy = Spy(result="Ran it: the desk light is on.")
    monkeypatch.setitem(
        tools.REGISTRY, AUTO_ACTION, Tool(AUTO_ACTION, "d", FETCH_SCHEMA, spy)
    )
    return spy


async def test_a_fabricated_pending_claim_is_redirected_and_the_tool_actually_runs(
    owner_client, pool, mount_peers, monkeypatch
):
    """The headline fix. Round 1 fabricates a pending approval and calls nothing.
    The guard fires and, instead of only contradicting it, the turn regenerates
    ONCE with tools advertised: the redirect calls the tool, it is dispatched
    through the SAME machinery as any other round (the spy proves the real body
    ran), and the reply that reports the result REPLACES the durable text. No
    correction persists — the work happened."""
    spy = await _arm_auto_tool(pool, monkeypatch)
    done = "Done — the desk light is on."
    gateway = ScriptedGateway(
        rounds=(
            (text(FABRICATION),),
            (auto_call("r1", URL),),
            (text(done),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "try again")

    # The fabrication, ONE redirect round (with tools), then the closing round.
    assert gateway.calls == 3
    assert spy.calls == [{"url": URL}]  # the tool really ran
    assert _activities(sent) == [(AUTO_ACTION, "start"), (AUTO_ACTION, "ok")]

    # The regenerated reply is the durable record — not the lie, not a correction.
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == done
    assert guards.CONSENT_CLAIM_CORRECTION not in stored
    assert "awaiting your approval" not in stored

    # Exactly one consent_claim span, recording that the redirect was taken.
    spans = await _guard_spans(pool)
    assert [s["name"] for s in spans] == ["consent_claim"]
    assert spans[0]["meta"]["redirected"] is True
    assert "has_pending_consent" not in spans[0]["meta"]

    # Live: the note, then the regenerated reply — never the correction.
    assert _corrections(sent) == [chat.CONSENT_REDIRECT_NOTE]
    assert [f["t"] for f in sent if isinstance(f, dict) and "t" in f] == [FABRICATION, done]

    # A turn that DID the work is knowledge again — not the "awaiting approval"
    # plumbing an uncorrected turn would be.
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    await chat.drain_background()
    assert len(memory.ingests) == 1


async def test_a_redirect_that_still_fabricates_persists_the_correction_and_stops(
    owner_client, pool, mount_peers
):
    """Bounded to ONE. If the regeneration repeats the same lie, the correction
    persists exactly as before and there is no second redirect — two gateway
    calls, never three (a third would be a loud 500 from the script)."""
    gateway = ScriptedGateway(
        rounds=(
            (text(FABRICATION),),
            (text("It is still pending your approval, sorry."),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "try again")

    assert gateway.calls == 2  # the reply, one redirect, and stop
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == guards.CONSENT_CLAIM_CORRECTION
    assert "still pending your approval" not in stored
    assert _corrections(sent) == [guards.CONSENT_CLAIM_CORRECTION]

    spans = await _guard_spans(pool)
    assert [s["name"] for s in spans] == ["consent_claim"]  # exactly one, still
    assert spans[0]["meta"]["redirected"] is False
    assert spans[0]["meta"]["regen_rejected_by"] == "consent_claim"
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    await chat.drain_background()
    assert memory.ingests == []  # an uncorrected consent turn stays plumbing


async def test_a_gateway_failure_in_the_redirect_ships_the_correction(
    owner_client, pool, mount_peers
):
    """FAIL-OPEN: the redirect's gateway round dies (the script has no round 2,
    so it answers 500). The turn ships the correction exactly as it did before
    the redirect existed — never an error frame, never a lost turn."""
    gateway = ScriptedGateway(rounds=((text(FABRICATION),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "try again")

    assert gateway.calls == 2  # the reply, then the redirect that failed
    assert _corrections(sent) == [guards.CONSENT_CLAIM_CORRECTION]
    assert not [f for f in sent if isinstance(f, dict) and "error" in f]
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == guards.CONSENT_CLAIM_CORRECTION
    spans = await _guard_spans(pool)
    assert [s["name"] for s in spans] == ["consent_claim"]
    assert spans[0]["meta"]["redirected"] is False
    assert spans[0]["meta"]["error"]  # the stated reason, on record
    assert await pool.fetchval("SELECT status FROM turns") == "ok"


async def test_the_consent_redirect_spends_the_shared_budget_so_deferral_cannot(
    owner_client, pool, mount_peers
):
    """ONE redirect per turn, first claim wins. A reply that BOTH fabricates a
    pending approval AND defers a promised search would qualify for two — the
    consent guard takes the budget, so the deferral redirect never runs: two
    gateway calls total and no deferral span anywhere."""
    both = "That's awaiting your approval. I'll search the web for it once you OK it."
    checked = "I checked directly: the desk light is already on."
    gateway = ScriptedGateway(rounds=((text(both),), (text(checked),)))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "try again")

    assert gateway.calls == 2  # ONE redirect, not two
    names = [s["name"] for s in await _guard_spans(pool)]
    assert names == ["consent_claim"]  # deferral never redirected
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == checked
    assert _corrections(sent) == [chat.CONSENT_REDIRECT_NOTE]
    assert await pool.fetchval("SELECT status FROM turns") == "ok"


# -- the redirect's own output is VETTED, and gated on side effects ----------
#
# Adversarial review of the redirect wave (2026-09-02), reproduced by execution.
# The redirect does not just re-word: its output REPLACES the durable record and
# is INGESTED, and it can CALL TOOLS. Both of those need a mechanical bound:
#
#   * C1 — the regenerated reply was judged by consent_claim_check ALONE, so a
#     regen that fabricated a COMPLETED action ("I've saved it to report.md")
#     persisted unvetted AND was ingested into per-person memory. Trading a
#     pending-state lie for a completed-action one is a worse trade, because the
#     second one crosses conversations through recall.
#   * I2 — nothing gated the redirect on what the turn had already DONE, so a
#     turn that really ran the tool in round 1 and then falsely narrated
#     "awaiting approval" ran it a SECOND time; and the dispatch could happen
#     past the round cap. Those two preconditions are the ONLY gates left on a
#     redirect: with no approval step there is no "card is up" to wait on.


NARRATION_LIE = (
    "Done — KV offloading moves the attention cache to CPU RAM. "
    "I've saved this to kv_offloading.md."
)


async def test_a_regenerated_reply_that_fabricates_a_completed_action_is_refused(
    owner_client, pool, mount_peers
):
    """C1, the reviewer's exact repro. Round 1 fabricates a pending approval; the
    redirect answers with a completed-action claim no span backs. The regen is
    REJECTED by the narration guard, so the correction persists exactly as it did
    before the redirect existed, the span names the guard that refused, and the
    turn stays plumbing — the fabrication never reaches memory."""
    gateway = ScriptedGateway(rounds=((text(FABRICATION),), (text(NARRATION_LIE),)))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "try again")

    assert gateway.calls == 2  # the reply, one redirect, and stop
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == guards.CONSENT_CLAIM_CORRECTION
    assert "kv_offloading.md" not in stored  # the regen's lie does not persist
    assert _corrections(sent) == [guards.CONSENT_CLAIM_CORRECTION]

    spans = await _guard_spans(pool)
    assert [s["name"] for s in spans] == ["consent_claim"]
    assert spans[0]["meta"]["redirected"] is False
    assert spans[0]["meta"]["regen_rejected_by"] == "narration"

    await chat.drain_background()
    assert memory.ingests == []  # a refused regen leaves the turn plumbing


async def test_a_rejected_regen_still_persists_the_original_capability_correction(
    owner_client, pool, mount_peers
):
    """C1's second half: a rejected regen must not silently drop the OTHER
    corrections the original reply earned. A reply that both fabricates a pending
    state and denies a capability it holds fires two guards; when the redirect is
    refused, the record is exactly what the pre-redirect code composed — both
    corrections, adjacent, no fabrication between them."""
    reply = "That's awaiting your approval. I cannot access external websites."
    gateway = ScriptedGateway(rounds=((text(reply),), (text(NARRATION_LIE),)))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "what's the latest from bigblueview.com?")

    corrections = _corrections(sent)
    assert corrections[0] == guards.CONSENT_CLAIM_CORRECTION
    assert "fetch_url" in corrections[1]  # the capability correction, still there
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == f"{guards.CONSENT_CLAIM_CORRECTION}\n\n{corrections[1]}"
    assert "I cannot access external websites" not in stored
    assert "kv_offloading.md" not in stored

    names = [s["name"] for s in await _guard_spans(pool)]
    assert names == ["consent_claim", "capability_claim"]
    await chat.drain_background()
    assert memory.ingests == []


async def test_no_redirect_when_the_turn_already_ran_the_tool(
    owner_client, pool, mount_peers, monkeypatch
):
    """I2, reproduced: round 1 REALLY runs the tool, round 2 falsely narrates
    'awaiting your approval' about it. Redirecting would dispatch the same call a
    SECOND time — a duplicated side effect is worse than the lie. Derived from
    the turn's spans (a successful tool span), never from the prose: the spy is
    called exactly once, no third gateway round happens, and the span states
    why."""
    spy = await _arm_auto_tool(pool, monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (auto_call("r1", URL),),
            (text("That's awaiting your approval — I can't run it yet."),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "turn on the desk light")

    assert spy.calls == [{"url": URL}]  # ONCE — never twice
    assert gateway.calls == 2  # no redirect round at all
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == guards.CONSENT_CLAIM_CORRECTION
    assert _corrections(sent) == [guards.CONSENT_CLAIM_CORRECTION]

    spans = await _guard_spans(pool)
    assert [s["name"] for s in spans] == ["consent_claim"]
    assert spans[0]["meta"]["redirected"] is False
    assert spans[0]["meta"]["ran_a_tool"] is True
    assert spans[0]["meta"]["not_redirected_because"] == "tools_already_ran"


async def test_no_redirect_dispatch_when_the_turn_ran_out_of_rounds(
    owner_client, pool, mount_peers, monkeypatch
):
    """I2's other half: a turn that hit its round cap must not get one more tool
    dispatch through the redirect's side door. The cap round narrates the
    fabrication and asks for a tool; nothing is dispatched, and the redirect
    refuses to start.

    A capped turn gets ONE tool-less narration round so the cap cannot swallow
    an answer, so the gateway is called twice. What this test is about is
    asserted hard: the spy proves NOTHING was dispatched — not in the capped
    round, not in the narration round, not in a redirect that never started."""
    spy = await _arm_auto_tool(pool, monkeypatch)
    resp = await owner_client.put(
        "/api/v1/settings", json={"key": "agents.max_tool_rounds", "value": 1}
    )
    assert resp.status_code == 200, resp.text
    gateway = ScriptedGateway(
        rounds=(
            (text("That's awaiting your approval."), auto_call("r1", URL)),
            # The out-of-rounds narration round: no tools advertised, and it
            # says nothing new here — the fabrication is what the guard judges.
            (text(""),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "turn on the desk light")

    assert spy.calls == []  # nothing dispatched, in the round OR the redirect
    assert gateway.calls == 2  # the capped round + the one narration round
    assert gateway.payloads[1].get("tools") in (None, [])
    assert _corrections(sent) == [guards.CONSENT_CLAIM_CORRECTION]
    spans = await _guard_spans(pool)
    assert spans[0]["meta"]["redirected"] is False
    assert spans[0]["meta"]["not_redirected_because"] == "out_of_rounds"


def test_the_redirect_nudge_refuses_to_state_a_fact_that_is_not_true():
    """The nudge asserts 'there is no approval step and nothing has run'. The
    first half is true by construction; the second is a measured fact, so the
    sentence is BUILT from that boolean rather than written as a constant that
    could drift out of step with it. Told otherwise, it refuses — a lie to the
    model is what produces the double execution above."""
    nudge = chat.consent_redirect_nudge(ran_a_tool=False)
    assert "There is no approval step and nothing has run this turn" in nudge
    with pytest.raises(ValueError):
        chat.consent_redirect_nudge(ran_a_tool=True)
    # And, like every note the turn ships, it is clean under the guard family.
    assert guards.consent_claim_check(nudge) is None
    assert guards.deferral_check(nudge, [], ["fetch_url", "web_search"]) is None
