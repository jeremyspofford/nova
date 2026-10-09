"""T4 (local-context epic): every round is fitted to the window the model is
actually served with.

The gateway states the served window on each answer (X-Nova-Context-Window,
read from ollama's /api/ps). Core records it on that round's llm_call span,
remembers it per served link, and fits every LATER round's messages to it
(context_fit.fit) before sending — so a local model is never handed a request
bigger than its window, which ollama answers by cutting the FRONT (her
instructions and his question; turn 0f7af448).

Everything drives the real chat route through a scripted gateway, and the
assertions are on what the gateway RECEIVED and what the trace recorded —
never on a private helper.

Each test uses its own served link: core keeps the learned window per link in
process memory, so a link another test taught would leak in.
"""

from __future__ import annotations

import json
import math
import uuid
from collections.abc import Callable
from dataclasses import dataclass

import pytest
from starlette.applications import Starlette
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route

from app import chat, context_fit
from tests.conftest import requires_db
from tests.fakes import (
    GATEWAY_TOKEN,
    FakeMemory,
    Refusal,
    ScriptedGateway,
    _bearer_ok,
    _sse,
)

pytestmark = requires_db

WINDOW_HEADER = "X-Nova-Context-Window"

# A file big enough that its read alone is thousands of tokens, under the
# workspace tool's 32 KB read cap so the tool returns it whole.
BIG_FILE_CHARS = 28_000
# Room for the whole listing (plus its call) at the default ratio, and no more:
# it fits at 3.5 chars/token and is over at 3.0.
LISTING_ROOM_TOKENS = math.ceil(BIG_FILE_CHARS / context_fit.DEFAULT_CHARS_PER_TOKEN) + 300


def text(piece: str) -> dict:
    return {"choices": [{"delta": {"content": piece}}]}


def whole_call(call_id: str, name: str, arguments: dict) -> dict:
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps(arguments)},
                        }
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ]
    }


@dataclass
class WindowGateway(ScriptedGateway):
    """ScriptedGateway that states a served window and, optionally, usage.

    `window` is the X-Nova-Context-Window every answer carries: an int, None
    (no header — a link whose window the gateway could not read), or a
    callable of the FIRST request's messages, evaluated once and then sent on
    every answer (so a test can size the window to the real system prompt
    without pinning its length). `prompt_tokens` likewise computes the usage
    chunk's prompt_tokens from each request's messages (None: no usage)."""

    window: int | Callable[[list[dict]], int] | None = None
    prompt_tokens: Callable[[list[dict]], int] | None = None
    # T4b: per-round (served_by, window) overrides, indexed like `rounds` —
    # the link that answers that round (a fallback, or another turn's link)
    # and the window it states (int, a callable of that request's messages,
    # or None for no header). A round past the tuple uses `served_by` and
    # `window`.
    served: tuple = ()

    def __post_init__(self) -> None:
        super().__post_init__()
        self._window_value: int | None = None

    def _window_for(self, messages: list[dict]) -> int | None:
        if self.window is None:
            return None
        if self._window_value is None:
            self._window_value = (
                self.window(messages) if callable(self.window) else int(self.window)
            )
        return self._window_value

    async def _completions(self, request):
        raw = await request.body()
        body = json.loads(raw) if raw else None
        self.seen.append(("/v1/chat/completions", body))
        if not _bearer_ok(request, GATEWAY_TOKEN):
            return JSONResponse({"error": "bad gateway bearer"}, status_code=401)
        index = self.calls
        self.calls += 1
        if index >= len(self.rounds):
            return JSONResponse(
                {"error": {"message": f"the test script has no round {index + 1}"}},
                status_code=500,
            )
        script = self.rounds[index]
        if isinstance(script, Refusal):
            return JSONResponse(script.body, status_code=script.status)
        messages = (body or {}).get("messages") or []
        served_by = self.served_by
        if index < len(self.served):
            served_by, stated = self.served[index]
            window = stated(messages) if callable(stated) else stated
            if window is not None and self._window_value is None:
                self._window_value = window
        else:
            window = self._window_for(messages)
        usage = None
        if self.prompt_tokens is not None:
            usage = {"prompt_tokens": self.prompt_tokens(messages), "completion_tokens": 5}

        async def stream():
            for chunk in script:
                yield _sse(chunk)
            if usage is not None:
                yield _sse({"choices": [], "usage": usage})
            yield "data: [DONE]\n\n"

        headers = {"X-Nova-Served-By": served_by}
        if window is not None:
            headers[WINDOW_HEADER] = str(window)
        return StreamingResponse(stream(), media_type="text/event-stream", headers=headers)


@pytest.fixture(autouse=True)
def _forget_served_links():
    """Core keeps what each served link stated in process memory (T4: window
    and chars-per-token per link; T4b: which link last served each requested
    model). Every test starts and ends with it empty, so test order can never
    decide what a round is fitted to. Clears every `_SERVED_*` dict in
    app.chat — a new map named that way is covered by this fixture."""

    def forget() -> None:
        for name, value in vars(chat).items():
            if name.startswith("_SERVED_") and isinstance(value, dict):
                value.clear()

    forget()
    yield
    forget()


@pytest.fixture
def workspace(monkeypatch, tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


def _link() -> str:
    return f"dell:qwen3:8b-{uuid.uuid4().hex[:8]}"


def _big_file(workspace, name: str = "listing.txt") -> str:
    line = "/usr/bin/some-binary-with-a-long-name\n"
    body = (line * (BIG_FILE_CHARS // len(line) + 1))[:BIG_FILE_CHARS]
    (workspace / name).write_text(body, encoding="utf-8")
    return body


def _window_with_room(extra_tokens: int) -> Callable[[list[dict]], int]:
    """A window whose fitting budget is the first request's estimate (at the
    default ratio) plus `extra_tokens` — sized to the real prompt."""

    def size(messages: list[dict]) -> int:
        est = context_fit.estimate_tokens(messages, context_fit.DEFAULT_CHARS_PER_TOKEN)
        want = est + extra_tokens
        window = math.ceil(want / (1 - context_fit.REPLY_RESERVE_FRACTION)) + 2
        assert context_fit.budget_for(window) >= want
        return window

    return size


def _read_then_answer(link: str, **kw) -> WindowGateway:
    return WindowGateway(
        rounds=(
            (whole_call("c1", "workspace_read_file", {"path": "listing.txt"}),),
            (text("python is not installed there."),),
        ),
        served_by=link,
        **kw,
    )


async def _say(client, message: str, model: str = "qwen3:8b") -> None:
    resp = await client.put("/api/v1/settings", json={"key": "chat.model", "value": model})
    assert resp.status_code == 200, resp.text
    resp = await client.post("/api/v1/chat/stream", json={"message": message})
    assert resp.status_code == 200, resp.text


async def _llm_metas(pool) -> list[dict]:
    rows = await pool.fetch(
        "SELECT meta FROM turn_spans WHERE kind = 'llm_call' ORDER BY started_at"
    )
    return [row["meta"] for row in rows]


def _roles(messages: list[dict]) -> list[str]:
    return [m.get("role") for m in messages]


ASK = "run python --version on the mini pc"


# -- C1: the stated window lands on the round's span -----------------------


async def test_a_round_whose_answer_states_the_window_records_it_on_its_span(
    owner_client, pool, mount_peers, workspace
):
    gateway = WindowGateway(rounds=((text("Python 3.12."),),), served_by=_link(), window=32768)
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, ASK)

    metas = await _llm_metas(pool)
    assert len(metas) == 1
    assert metas[0]["context_window"] == 32768
    # A window that was learned on this very answer fitted nothing.
    assert "context_trimmed" not in metas[0]


# -- C2: a later round over the window is fitted before it is sent ---------


async def test_a_later_round_over_the_window_is_fitted_before_it_is_sent(
    owner_client, pool, mount_peers, workspace
):
    listing = _big_file(workspace)
    gateway = _read_then_answer(_link(), window=_window_with_room(1500))
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, ASK)

    first, second = (p["messages"] for p in gateway.payloads)
    window = int(gateway._window_value)

    # Her instructions and his latest message are byte-identical and in place.
    assert [m for m in second if m["role"] == "system"] == [
        m for m in first if m["role"] == "system"
    ]
    last_user = [m for m in first if m["role"] == "user"][-1]
    assert [m for m in second if m["role"] == "user"][-1] == last_user
    # The round the listing came from is still there, paired — its result
    # trimmed to a stated note naming the window, not dropped.
    tool = [m for m in second if m["role"] == "tool"]
    assert len(tool) == 1 and tool[0]["tool_call_id"] == "c1"
    assert len(tool[0]["content"]) < len(listing)
    assert "[trimmed " in tool[0]["content"]
    assert f"{window}-token" in tool[0]["content"]
    # And the request sent fits the budget at the ratio it was fitted with.
    assert context_fit.estimate_tokens(
        second, context_fit.DEFAULT_CHARS_PER_TOKEN
    ) <= context_fit.budget_for(window)

    metas = await _llm_metas(pool)
    assert [m["context_window"] for m in metas] == [window, window]
    assert "context_trimmed" not in metas[0]
    trimmed = metas[1]["context_trimmed"]
    assert trimmed["tool_results"] == 1
    assert trimmed["rounds_dropped"] == 0
    assert 0 < trimmed["est_tokens"] <= context_fit.budget_for(window)


async def test_a_round_inside_the_window_is_sent_untouched_and_says_nothing_was_trimmed(
    owner_client, pool, mount_peers, workspace
):
    listing = _big_file(workspace)
    # Room for the whole listing at the default ratio, with no usage stated.
    gateway = _read_then_answer(_link(), window=_window_with_room(LISTING_ROOM_TOKENS))
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, ASK)

    second = gateway.payloads[1]["messages"]
    tool = [m for m in second if m["role"] == "tool"]
    assert listing in tool[0]["content"] and "[trimmed " not in tool[0]["content"]
    metas = await _llm_metas(pool)
    window = int(gateway._window_value)
    assert [m.get("context_window") for m in metas] == [window, window]
    assert not any("context_trimmed" in m for m in metas)


# -- C3: the ratio is calibrated from the gateway's own prompt_tokens -------


async def test_the_ratio_is_calibrated_from_the_previous_rounds_prompt_tokens(
    owner_client, pool, mount_peers, workspace
):
    """The same request that fits at the default ratio (the test above) is
    over when the gateway's own count says the model spends a token every 3
    chars — so the second round is trimmed by what the first round measured,
    not by the default."""
    _big_file(workspace)
    gateway = _read_then_answer(
        _link(),
        window=_window_with_room(LISTING_ROOM_TOKENS),
        prompt_tokens=lambda messages: context_fit.estimate_tokens(messages, 3.0),
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, ASK)

    second = gateway.payloads[1]["messages"]
    window = int(gateway._window_value)
    tool = [m for m in second if m["role"] == "tool"]
    assert len(tool) == 1 and "[trimmed " in tool[0]["content"]
    assert context_fit.estimate_tokens(second, 3.0) <= context_fit.budget_for(window)
    metas = await _llm_metas(pool)
    assert metas[1]["context_trimmed"]["tool_results"] == 1


# -- C4: a link whose window is unknown is sent as is ----------------------


async def test_a_link_with_no_stated_window_sends_unmodified_messages(
    owner_client, pool, mount_peers, workspace
):
    """Unknown is stated as absent, never guessed: no header, no fitting, no
    context_window on any span — even a request far over any real window."""
    listing = _big_file(workspace)
    gateway = _read_then_answer(_link(), window=None)
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, ASK)

    first, second = (p["messages"] for p in gateway.payloads)
    assert second[: len(first)] == first
    assert _roles(second[len(first) :]) == ["assistant", "tool"]
    assert listing in second[-1]["content"]
    for meta in await _llm_metas(pool):
        assert "context_window" not in meta and "context_trimmed" not in meta


async def test_a_window_learned_for_one_link_never_fits_another(
    owner_client, pool, mount_peers, workspace
):
    """The window is the served link's: a tiny window another link stated
    leaves this link's request whole."""
    listing = _big_file(workspace)
    taught = WindowGateway(rounds=((text("ok"),),), served_by=_link(), window=4096)
    mount_peers(gateway=taught, memory=FakeMemory())
    await _say(owner_client, "hello")
    assert (await _llm_metas(pool))[0]["context_window"] == 4096

    gateway = _read_then_answer(_link(), window=None)
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _say(owner_client, ASK)

    second = gateway.payloads[1]["messages"]
    assert listing in second[-1]["content"]
    metas = await _llm_metas(pool)
    assert not any("context_trimmed" in m for m in metas)


async def test_a_link_with_no_stated_window_sends_even_a_request_over_any_real_window_whole(
    owner_client, pool, mount_peers, workspace
):
    """No window is ever assumed. Six big reads put the last round past
    48 000 tokens at the default ratio — over any window a local model is
    served with here (the Dell's qwen3:8b: 32 768; its model max: 40 960) — and
    with no stated window every one of them is still sent whole. A fit with ANY
    default window would trim this request."""
    reads = 6
    listings = []
    for i in range(reads):
        # Distinct bodies: identical results would end the turn as circling.
        line = f"/usr/bin/tool-{i}-with-a-long-name\n"
        body = (line * (BIG_FILE_CHARS // len(line) + 1))[:BIG_FILE_CHARS]
        (workspace / f"listing{i}.txt").write_text(body, encoding="utf-8")
        listings.append(body)
    gateway = WindowGateway(
        rounds=tuple(
            (whole_call(f"c{i}", "workspace_read_file", {"path": f"listing{i}.txt"}),)
            for i in range(reads)
        )
        + ((text("python is not installed there."),),),
        served_by=_link(),
        window=None,
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, ASK)

    last = gateway.payloads[-1]["messages"]
    assert context_fit.estimate_tokens(last, context_fit.DEFAULT_CHARS_PER_TOKEN) > 48_000
    tool = [m for m in last if m["role"] == "tool"]
    assert [m["tool_call_id"] for m in tool] == [f"c{i}" for i in range(reads)]
    for listing, message in zip(listings, tool, strict=True):
        assert listing in message["content"] and "[trimmed " not in message["content"]
    for meta in await _llm_metas(pool):
        assert "context_window" not in meta and "context_trimmed" not in meta


@pytest.mark.parametrize("stated", ["32k", "0", "-1", ""])
async def test_a_window_header_that_is_not_a_positive_count_is_not_a_window(
    owner_client, pool, mount_peers, workspace, stated
):
    """A header the gateway garbled states no window: nothing recorded,
    nothing fitted — never a number guessed out of it."""
    listing = _big_file(workspace)
    gateway = _read_then_answer(_link(), window=None)

    async def completions(request, _inner=gateway._completions):
        response = await _inner(request)
        response.headers[WINDOW_HEADER] = stated
        return response

    # Routes bind in __post_init__, so the wrapper gets an app of its own.
    gateway.app = Starlette(routes=[Route("/v1/chat/completions", completions, methods=["POST"])])
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, ASK)

    second = gateway.payloads[1]["messages"]
    assert listing in second[-1]["content"]
    for meta in await _llm_metas(pool):
        assert "context_window" not in meta and "context_trimmed" not in meta


# -- T4b: the window outlives the turn, and follows the link that served ----


async def test_round_one_of_the_next_turn_is_fitted_to_the_window_its_model_stated_last_turn(
    owner_client, pool, mount_peers, workspace
):
    """Turn 1's answer states the served window; turn 2 asks the same model,
    and its round 1 is fitted to that window BEFORE it is sent — turn 2's own
    answer states none (the gateway could not read it this time), so the only
    place the window can come from is what turn 1 taught. A turn asking a
    different model is fitted to nothing."""
    link = _link()
    other = _link().replace("qwen3:8b", "qwen3:14b")
    gateway = WindowGateway(
        rounds=(
            (text("ok"),),
            (text("Python 3.12."),),
            (text("Python 3.12."),),
        ),
        served=((link, 32768), (link, None), (other, None)),
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, "hello")
    await _say(owner_client, ASK)
    await _say(owner_client, ASK, model="qwen3:14b")

    assert [p["model"] for p in gateway.payloads] == ["qwen3:8b", "qwen3:8b", "qwen3:14b"]
    first, second, third = await _llm_metas(pool)
    assert first["context_window"] == 32768
    # Round 1 of a never-seen model: nothing to fit to.
    assert "context_fitted_to" not in first
    # Round 1 of turn 2: fitted to what turn 1's link stated.
    assert "context_window" not in second
    assert second.get("context_fitted_to") == 32768
    # Another model's round 1 never borrows that window.
    assert "context_fitted_to" not in third and "context_window" not in third


async def test_a_fallback_link_with_its_own_window_fits_the_rounds_after_it(
    owner_client, pool, mount_peers, workspace
):
    """Turn 1: the model is served by link A (32768). Turn 2: round 1 is
    fitted to A's window, but the gateway falls back to link B, which states
    8192 — so round 2 is fitted to B's window (the listing trimmed with B's
    number), and turn 3's round 1 is fitted to B's, the link that last served
    that model."""
    a, b = _link(), _link()
    listing = _big_file(workspace)
    gateway = WindowGateway(
        rounds=(
            (text("ok"),),
            (whole_call("c1", "workspace_read_file", {"path": "listing.txt"}),),
            (text("python is not installed there."),),
            (text("Python 3.12."),),
        ),
        served=((a, 32768), (b, 8192), (b, 8192), (a, 32768)),
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, "hello")
    await _say(owner_client, ASK)
    await _say(owner_client, ASK)

    metas = await _llm_metas(pool)
    assert [m.get("context_window") for m in metas] == [32768, 8192, 8192, 32768]
    # Turn 2 round 1: fitted to A's window, answered by B.
    assert metas[1].get("context_fitted_to") == 32768
    # Turn 2 round 2: fitted to B's window, the link that served round 1.
    assert metas[2].get("context_fitted_to") == 8192
    tool = [m for m in gateway.payloads[2]["messages"] if m["role"] == "tool"]
    assert len(tool) == 1 and listing not in tool[0]["content"]
    assert "8192-token" in tool[0]["content"]
    # Turn 3 round 1: B is the link that last served the model.
    assert metas[3].get("context_fitted_to") == 8192


async def test_fitting_a_round_never_trims_the_turns_own_messages(
    owner_client, pool, mount_peers, workspace
):
    """Only what is SENT is fitted. Round 2 is fitted to link A's small window
    (the listing trimmed); the gateway falls back to link B, whose window
    holds everything — so round 3, fitted to B's, carries the listing whole.
    Had round 2's fit trimmed the turn's own messages in place, round 3 would
    resend the trimmed copy. And the listing read stays whole in the trace."""
    a, b = _link(), _link()
    listing = _big_file(workspace)
    (workspace / "note.txt").write_text("python3 lives in /usr/bin\n", encoding="utf-8")
    gateway = WindowGateway(
        rounds=(
            (whole_call("c1", "workspace_read_file", {"path": "listing.txt"}),),
            (whole_call("c2", "workspace_read_file", {"path": "note.txt"}),),
            (text("python is not installed there."),),
        ),
        served=((a, _window_with_room(1500)), (b, 131072), (b, 131072)),
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, ASK)

    second, third = (p["messages"] for p in gateway.payloads[1:])
    trimmed = [m for m in second if m["role"] == "tool"]
    assert "[trimmed " in trimmed[0]["content"] and listing not in trimmed[0]["content"]
    whole = [m for m in third if m["role"] == "tool"]
    assert [m["tool_call_id"] for m in whole] == ["c1", "c2"]
    assert listing in whole[0]["content"] and "[trimmed " not in whole[0]["content"]
    metas = await _llm_metas(pool)
    assert metas[1]["context_trimmed"]["tool_results"] == 1
    assert "context_trimmed" not in metas[2]


# -- T5: a round the served window still cut is marked, re-sent fitted once,
#        and a second cut ends the turn with a stated failure -----------------

LISTING_ANSWER = "The /usr/bin listing shows a lot of binaries, mostly GNU tools."
RECUT_ANSWER = "The listing has 700 entries."


def _has_tool_result(messages: list[dict]) -> bool:
    return any(m.get("role") == "tool" for m in messages)


def _trimmed(messages: list[dict]) -> bool:
    return any(m.get("role") == "tool" and "[trimmed " in str(m.get("content")) for m in messages)


async def _spans_of(pool, kind: str) -> list[dict]:
    rows = await pool.fetch("SELECT meta FROM turn_spans WHERE kind = $1 ORDER BY started_at", kind)
    return [row["meta"] for row in rows]


async def _turn_status(pool) -> str:
    return await pool.fetchval("SELECT status FROM turns ORDER BY started_at DESC LIMIT 1")


async def _assistant_rows(pool) -> list[str]:
    rows = await pool.fetch(
        "SELECT content FROM messages WHERE role = 'assistant' ORDER BY created_at"
    )
    return [row["content"] for row in rows]


def _cut_gateway(link: str, *, cut_again: bool) -> WindowGateway:
    """Round 1 reads the listing (no usage stated). Round 2 is sent whole — it
    fits the window at the default ratio — but the gateway's own count says
    prompt_tokens == window - 1: the request was cut (turn 0f7af448: 32767 on
    a 32768 window). Round 3 is the re-send; with `cut_again` it is cut too,
    else its count is honest."""
    gateway = _read_then_answer(link, window=_window_with_room(LISTING_ROOM_TOKENS))
    gateway.rounds = (
        gateway.rounds[0],
        (text(LISTING_ANSWER),),
        (text(RECUT_ANSWER if cut_again else "python is not installed there."),),
    )

    def counted(messages: list[dict]) -> int | None:
        if not _has_tool_result(messages):
            return None
        window = int(gateway._window_value)
        if _trimmed(messages) and not cut_again:
            return context_fit.estimate_tokens(messages, context_fit.DEFAULT_CHARS_PER_TOKEN)
        return window - 1

    gateway.prompt_tokens = counted
    return gateway


async def test_a_round_cut_at_the_window_is_marked_and_re_sent_once_fitted(
    owner_client, pool, mount_peers, workspace
):
    """C1+C2: the cut round's span says context_truncated; ONE round_retry
    (why context_truncated) is filed; the re-send is fitted to the window with
    the ratio the cut round measured — the listing trimmed, her instructions
    and his ask byte-identical — and its answer is the reply, never the cut
    round's."""
    link = _link()
    listing = _big_file(workspace)
    gateway = _cut_gateway(link, cut_again=False)
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, ASK)

    assert gateway.calls == 3
    first, cut, resent = (p["messages"] for p in gateway.payloads)
    window = int(gateway._window_value)
    # The cut request went out whole (it fitted at the default ratio).
    assert listing in [m for m in cut if m["role"] == "tool"][0]["content"]
    # The re-send is fitted: listing trimmed with the stated note, still paired.
    tool = [m for m in resent if m["role"] == "tool"]
    assert len(tool) == 1 and tool[0]["tool_call_id"] == "c1"
    assert listing not in tool[0]["content"]
    assert f"{window}-token" in tool[0]["content"]
    assert [m for m in resent if m["role"] == "system"] == [
        m for m in first if m["role"] == "system"
    ]
    assert [m for m in resent if m["role"] == "user"][-1] == [
        m for m in first if m["role"] == "user"
    ][-1]

    metas = await _llm_metas(pool)
    assert len(metas) == 3
    assert [m.get("context_truncated") for m in metas] == [None, True, None]
    assert metas[1]["prompt_tokens"] == window - 1
    assert metas[2].get("context_fitted_to") == window
    assert metas[2]["context_trimmed"]["tool_results"] == 1
    retries = await _spans_of(pool, "round_retry")
    assert retries == [{"why": "context_truncated", "action": "refit", "link": link, "round": 2}]

    assert await _turn_status(pool) == "ok"
    (reply,) = await _assistant_rows(pool)
    assert "python is not installed there." in reply
    assert LISTING_ANSWER not in reply


async def test_a_re_sent_round_cut_again_ends_the_turn_with_a_stated_failure(
    owner_client, pool, mount_peers, workspace
):
    """C3: the re-send is cut too -> no third attempt; the turn ends 'error'
    with ONE stored statement naming the served link (its model), the window
    and the prompt tokens — and neither cut round's text is stored as her
    answer."""
    link = _link()
    _big_file(workspace)
    gateway = _cut_gateway(link, cut_again=True)
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, ASK)

    assert gateway.calls == 3
    window = int(gateway._window_value)
    metas = await _llm_metas(pool)
    assert [m.get("context_truncated") for m in metas] == [None, True, True]
    assert len(await _spans_of(pool, "round_retry")) == 1

    assert await _turn_status(pool) == "error"
    (reply,) = await _assistant_rows(pool)
    assert link.split(":", 1)[1] in reply  # the model, as served
    assert str(window) in reply
    assert str(window - 1) in reply
    assert LISTING_ANSWER not in reply
    assert RECUT_ANSWER not in reply


async def test_a_round_well_under_its_window_is_never_marked_truncated(
    owner_client, pool, mount_peers, workspace
):
    """C4 (negative): honest counts well under the window -> no span carries
    context_truncated, no round_retry is filed, nothing is re-sent."""
    _big_file(workspace)
    gateway = _read_then_answer(
        _link(),
        window=_window_with_room(LISTING_ROOM_TOKENS * 3),
        prompt_tokens=lambda messages: context_fit.estimate_tokens(
            messages, context_fit.DEFAULT_CHARS_PER_TOKEN
        ),
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, ASK)

    assert gateway.calls == 2
    metas = await _llm_metas(pool)
    assert all("prompt_tokens" in m for m in metas)
    assert not any("context_truncated" in m for m in metas)
    assert await _spans_of(pool, "round_retry") == []
    assert await _turn_status(pool) == "ok"
    (reply,) = await _assistant_rows(pool)
    assert "python is not installed there." in reply


async def test_a_cut_rounds_calls_never_run_and_the_watcher_is_told_its_text_is_dropped(
    owner_client, pool, mount_peers, workspace
):
    """T5 COVERAGE: a cut round that streamed text AND asked for a tool — the
    call is never dispatched (only round 1's read ever runs), and the live
    stream follows the cut text with ONE correction naming the link and the
    window, so what was shown is not left standing as her answer."""
    link = _link()
    _big_file(workspace)
    (workspace / "other.txt").write_text("other", encoding="utf-8")
    gateway = _cut_gateway(link, cut_again=False)
    gateway.rounds = (
        gateway.rounds[0],
        (text(LISTING_ANSWER), whole_call("c2", "workspace_read_file", {"path": "other.txt"})),
        gateway.rounds[2],
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    resp = await owner_client.put(
        "/api/v1/settings", json={"key": "chat.model", "value": "qwen3:8b"}
    )
    assert resp.status_code == 200, resp.text
    resp = await owner_client.post("/api/v1/chat/stream", json={"message": ASK})
    assert resp.status_code == 200, resp.text

    assert gateway.calls == 3
    window = int(gateway._window_value)
    tools = await pool.fetch("SELECT name FROM turn_spans WHERE kind = 'tool' ORDER BY started_at")
    assert [row["name"] for row in tools] == ["workspace_read_file"]
    resent = gateway.payloads[2]["messages"]
    assert not any(c.get("id") == "c2" for m in resent for c in m.get("tool_calls") or [])

    frames = [
        json.loads(line[len("data: ") :])
        for line in resp.text.splitlines()
        if line.startswith("data: {")
    ]
    streamed = [f["t"] for f in frames if "t" in f]
    corrections = [f["correction"] for f in frames if "correction" in f]
    assert LISTING_ANSWER in "".join(streamed)
    assert len(corrections) == 1
    assert link in corrections[0] and f"{window}-token" in corrections[0]
    order = [k for f in frames for k in f if k in ("t", "correction")]
    assert order.index("correction") > order.index("t")
    (reply,) = await _assistant_rows(pool)
    assert LISTING_ANSWER not in reply


async def test_a_cut_round_whose_answer_states_no_window_is_judged_by_its_links_window(
    owner_client, pool, mount_peers, workspace
):
    """T5 COVERAGE: the cut round's own answer states no window (the gateway's
    /api/ps read failed that time) — the window its link stated on round 1
    is the one it is checked against, so the cut is still caught and re-sent."""
    link = _link()
    _big_file(workspace)
    gateway = _cut_gateway(link, cut_again=False)
    gateway.served = ((link, _window_with_room(LISTING_ROOM_TOKENS)), (link, None), (link, None))
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, ASK)

    assert gateway.calls == 3
    metas = await _llm_metas(pool)
    assert "context_window" not in metas[1]
    assert [m.get("context_truncated") for m in metas] == [None, True, None]
    (reply,) = await _assistant_rows(pool)
    assert "python is not installed there." in reply


async def test_a_round_cut_twice_never_runs_the_calls_either_cut_round_asked_for(
    owner_client, pool, mount_peers, workspace
):
    """T5 COVERAGE (VERIFY gap): the cut round AND its re-send both ask for a
    tool, and both are cut. Neither call is dispatched (only round 1's read
    ever runs), no third request reaches the gateway, and the turn ends
    'error' on the stated cut, never on the result of a call made from a
    request the model only half read."""
    link = _link()
    _big_file(workspace)
    (workspace / "other.txt").write_text("other", encoding="utf-8")
    gateway = _cut_gateway(link, cut_again=True)
    gateway.rounds = (
        gateway.rounds[0],
        (text(LISTING_ANSWER), whole_call("c2", "workspace_read_file", {"path": "other.txt"})),
        (text(RECUT_ANSWER), whole_call("c3", "workspace_read_file", {"path": "other.txt"})),
        (text("python is not installed there."),),
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, ASK)

    assert gateway.calls == 3
    window = int(gateway._window_value)
    tools = await pool.fetch("SELECT name FROM turn_spans WHERE kind = 'tool' ORDER BY started_at")
    assert [row["name"] for row in tools] == ["workspace_read_file"]
    metas = await _llm_metas(pool)
    assert [m.get("context_truncated") for m in metas] == [None, True, True]

    assert await _turn_status(pool) == "error"
    (reply,) = await _assistant_rows(pool)
    assert str(window) in reply and str(window - 1) in reply
    assert LISTING_ANSWER not in reply
    assert RECUT_ANSWER not in reply
    assert "python is not installed there." not in reply
