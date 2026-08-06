"""A turn, driven through the browser the way the operator drives it.

The deepest test in the suite, and the one closest to what he actually does:
type into the composer, press send, and watch what comes back.

WHAT IT PROVES THAT NOTHING ELSE DOES. A turn crosses every layer at once —
the React composer, the same-origin nginx proxy, the FastAPI route, the SSE
stream, the incremental render, and the persisted transcript. Each of those
has its own tests and all of them can pass while the whole thing is broken:
the stream can open and never flush, a delta can arrive and never paint, the
reply can render and never persist. Only driving it end to end sees that.

SPLIT IN TWO, DELIBERATELY, because they need different things.

`test_the_turn_reaches_the_backend` needs NO model credential. It asserts the
pipeline moved: the message leaves the composer, appears in the transcript,
and the app resolves to SOMETHING — a reply or a visible error — rather than
hanging. That runs in the sandbox, where there is no API key on purpose (a
sandbox holding his credentials would not be a sandbox), and it is exactly
the half that catches a broken proxy, a dead route or a stream that never
closes.

`test_the_turn_gets_a_real_reply` needs a working model and skips without
one. It is the only test that proves an answer actually renders.

The division is not a compromise. "Did the pipeline work" and "did the model
answer" are different questions, and conflating them produces a test that
goes red when OpenRouter has a bad afternoon — which is how a suite earns the
reputation that gets it ignored.
"""

import os
import re

import pytest
from playwright.sync_api import Page, expect

# EVERY TEST HERE WRITES INTO A REAL CONVERSATION AND A REAL JOURNAL, and
# that is not a detail to discover later. Run against production, this file
# adds an "e2e ping" exchange to the operator's journal on every pass —
# indistinguishable from something he said, which is precisely the noise this
# project diagnosed on 2026-08-05 when 21 of a day's 22 turns turned out to be
# an agent's verification probes cluttering his record.
#
# So: OFF unless asked. The sandbox sets it, because there the database is
# disposable and thrown away with the stack; against his install it takes a
# deliberate NOVA_E2E_CHAT=1.
_CHAT_ENABLED = os.environ.get("NOVA_E2E_CHAT") == "1"

pytestmark = pytest.mark.skipif(
    not _CHAT_ENABLED,
    reason=("writes real turns into a real journal — set NOVA_E2E_CHAT=1. The "
            "sandbox sets it automatically; against a live install it is "
            "opt-in so the operator's record stays his."))


#: A turn is a network round trip plus a model. Generous, because a slow
#: answer is not a broken app and a flaky timeout teaches people to re-run
#: rather than read.
TURN_TIMEOUT_MS = 90_000

#: Short and unmistakable, so finding it in the transcript cannot match
#: chrome, placeholder text, or a previous turn.
PROBE = "e2e ping: reply with the single word ACK"


def _settled(page: Page) -> None:
    """Wait for the turn to FINISH, not merely to start.

    Reloading or asserting mid-stream cancels it: the runner catches
    CancelledError and persists "[This turn was interrupted before it produced
    a reply.]". The first version of the reload test did exactly that and left
    one of those rows in the operator's transcript — a test that manufactures
    the defect it is meant to detect.
    """
    # THE COMPOSER'S PLACEHOLDER IS THE HONEST SIGNAL. While a reply streams
    # it reads "Queue a follow-up…"; when the turn ends it reverts. Waiting on
    # the "Nova is thinking" label alone was not enough — on a fast reply it
    # can come and go between polls, `wait_for(hidden)` returns instantly, and
    # a reload one second later still cut the stream. Two interrupted turns
    # went into the operator's real transcript that way.
    try:
        page.get_by_placeholder(re.compile(r"Queue a follow-up", re.I)).first \
            .wait_for(state="detached", timeout=TURN_TIMEOUT_MS)
    except Exception:            # noqa: BLE001 — never entered that state
        pass
    try:
        page.get_by_label("Nova is thinking").wait_for(
            state="hidden", timeout=TURN_TIMEOUT_MS)
    except Exception:            # noqa: BLE001
        pass
    # ...and a beat for the persist that follows the last delta. The reply is
    # written after the stream closes, so asserting the instant the UI settles
    # races the database write.
    page.wait_for_timeout(2_500)


def _composer(page: Page):
    """The message box, by its placeholder rather than its class.

    Two composers exist — mobile and desktop — and both say "Message Nova…"
    or "Ask <name>". Matching the placeholder survives a restyle and fails
    honestly if the composer is genuinely gone.
    """
    return page.get_by_placeholder(
        re.compile(r"Message .*|Ask ", re.I)).first


def _send(page: Page):
    """The send control, by its accessible name.

    It is labelled `Send` when idle and `Queue` while a reply is streaming,
    which is itself the state machine under test — so match either and let
    the assertions decide whether the right thing happened.
    """
    return page.get_by_role("button", name=re.compile(r"^(Send|Queue)$", re.I)).first


def test_the_turn_reaches_the_backend(app: Page):
    """Type, send, and the pipeline moves. No model needed.

    The assertion is deliberately about MOVEMENT, not about content: the
    operator's own words appear in the transcript, and the app then resolves
    to a reply or to a visible error. A hang is the failure being hunted —
    it is what a broken proxy, a dead route or a stream that never closes all
    look like, and all three serve a perfectly healthy-looking page.
    """
    composer = _composer(app)
    expect(composer).to_be_visible()
    composer.fill(PROBE)
    _send(app).click()

    # HIS WORDS, ON SCREEN. If this fails the composer submitted nothing —
    # the single most user-visible way a chat app can be broken.
    expect(app.get_by_text(PROBE, exact=False).first).to_be_visible(
        timeout=15_000)

    # ...and then it RESOLVES. Either the composer becomes usable again
    # (the stream finished, however it finished) or an error is shown. What
    # must not happen is neither.
    app.wait_for_timeout(1_000)
    expect(composer).to_be_enabled(timeout=TURN_TIMEOUT_MS)


@pytest.mark.skipif(
    not os.environ.get("NOVA_E2E_EXPECT_MODEL"),
    reason=("needs a working model — set NOVA_E2E_EXPECT_MODEL=1 where one is "
            "configured. The sandbox has no credentials on purpose, so this "
            "would fail there for a reason that says nothing about the code."))
def test_the_turn_gets_a_real_reply(app: Page):
    """The whole round trip, including an answer that renders.

    The only test that proves a reply reaches the screen. Everything up to
    the model is covered by the test above; this is the part that needs the
    world to cooperate, which is why it is opt-in rather than skipped-by-
    default-and-forgotten.
    """
    composer = _composer(app)
    before = app.locator("div.justify-start").count()
    composer.fill(PROBE)
    _send(app).click()
    expect(app.get_by_text(PROBE, exact=False).first).to_be_visible(
        timeout=15_000)

    _settled(app)

    # ASSERTED THROUGH THE TRANSCRIPT, not the DOM, and the detour is the
    # honest option rather than a workaround.
    #
    # The first version counted `div.justify-start` bubbles and asserted the
    # last one had text. It passed while proving nothing (any conversation
    # with history already has left-aligned bubbles), and when the count was
    # tightened it failed on an EMPTY match — because that class is a layout
    # utility that also matches chrome, not a message. Chasing it with a
    # cleverer CSS selector would be building on the same sand.
    #
    # The transcript is the stronger claim anyway: it proves the reply was
    # PERSISTED, not merely painted, which is the failure this codebase has
    # an incident about — an answer that existed nowhere but on his screen.
    # Fetched over the same origin, through the same nginx the browser used.
    #
    # A `data-testid` on the message bubble would let this assert on the DOM
    # directly. That is a frontend change, and a frontend change is Nova's to
    # write — so it is noted here rather than typed by hand.
    # THE HEADER, EXPLICITLY. `page.request` is a separate HTTP client that
    # does not execute the app's JavaScript, so it never picks up the token
    # from localStorage the way `fetch` in the page does — it just gets a 401.
    # Same origin, same nginx, different credential path.
    hdrs = {"Authorization": f"Bearer {os.environ.get('NOVA_AUTH_TOKEN','')}"}
    convo = app.request.get("/api/v1/conversations/active", headers=hdrs)
    assert convo.ok, f"could not read the active conversation: {convo.status}"
    cid = (convo.json() or {}).get("id")
    assert cid, "no active conversation after sending a turn"

    msgs = app.request.get(f"/api/v1/conversations/{cid}/messages?limit=6",
                           headers=hdrs)
    assert msgs.ok, f"could not read the transcript: {msgs.status}"
    rows = msgs.json()
    rows = rows if isinstance(rows, list) else rows.get("messages", [])
    assert rows, "the transcript is empty after a turn"

    # The newest assistant row must come AFTER the probe and say something.
    # Ordering matters: an old reply sitting above his message is exactly the
    # vacuous pass this rewrite exists to kill.
    texts = [(r.get("role"), (r.get("content") or "").strip()) for r in rows]
    probe_at = max((i for i, (_, c) in enumerate(texts) if PROBE in c),
                   default=-1)
    assert probe_at >= 0, f"the probe never reached the transcript: {texts[-3:]}"
    after = [c for role, c in texts[probe_at + 1:] if role == "assistant" and c]
    assert after, f"no assistant reply followed the probe: {texts[-3:]}"


def test_the_transcript_survives_a_reload(app: Page, base_url: str):
    """It was PERSISTED, not just painted.

    A reply that renders and is never stored is the failure the codebase
    already has a name for: the operator reads an answer that exists nowhere
    but on their screen, and the next turn has no idea it happened. Reloading
    is the cheapest honest way to tell the two apart.
    """
    composer = _composer(app)
    composer.fill(PROBE)
    _send(app).click()
    expect(app.get_by_text(PROBE, exact=False).first).to_be_visible(
        timeout=15_000)
    _settled(app)

    app.reload(wait_until="networkidle")
    expect(app.get_by_text(PROBE, exact=False).first).to_be_visible(
        timeout=20_000)
