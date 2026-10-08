"""POST /v1/chat/completions + GET /v1/models — pure passthrough to the
one active backend. No retries, no fallback: a connect/read failure is a
stated 502, and a failure mid-stream (after we already answered 200) is an
OpenAI-shaped SSE error chunk, then the stream ends."""

from __future__ import annotations

import gzip
import json

from starlette.applications import Starlette
from starlette.responses import Response as StarletteResponse
from starlette.responses import StreamingResponse as StarletteStreamingResponse
from starlette.routing import Route

from app import backends
from tests.conftest import requires_db
from tests.fakes import FakeOllama, FakeOpenAICompat

pytestmark = requires_db


def _deltas(frames: list) -> list[str]:
    """The content deltas — skipping [DONE], error frames and S10's usage
    chunk (`choices: []`), which is metering, not content."""
    return [
        f["choices"][0]["delta"]["content"]
        for f in frames
        if f != "[DONE]" and "error" not in f and f.get("choices")
    ]


def _sse_payloads(body: bytes) -> list:
    out = []
    for block in body.decode().strip().split("\n\n"):
        if not block:
            continue
        assert block.startswith("data:")
        payload = block[len("data:") :].strip()
        out.append(payload if payload == "[DONE]" else json.loads(payload))
    return out


async def test_chat_completions_passthrough_verbatim_with_served_by_header(
    client, pool, monkeypatch, mount_backend
):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(deltas=("Hel", "lo"))
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:8b"})

    resp = await client.post(
        "/v1/chat/completions",
        json={"messages": [{"role": "user", "content": "hi"}], "stream": True},
    )

    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "hub:qwen3:8b"
    frames = _sse_payloads(resp.content)
    assert _deltas(frames) == ["Hel", "lo"]
    # S10: one usage chunk, the provider's counts, then [DONE] last.
    usage = [f for f in frames if f != "[DONE]" and f.get("usage")]
    assert usage[-1]["usage"]["prompt_tokens"] == 12 and usage[-1]["usage"]["local"] is True
    assert frames[-1] == "[DONE]"
    # The default model was injected — the fake actually received it.
    assert fake.seen[0][1]["model"] == "qwen3:8b"


async def test_an_explicit_model_overrides_the_configured_default(
    client, pool, monkeypatch, mount_backend
):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(deltas=("ok",))
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:8b"})

    resp = await client.post(
        "/v1/chat/completions",
        json={"messages": [], "stream": True, "model": "qwen3:4b"},
    )

    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "hub:qwen3:4b"
    assert fake.seen[0][1]["model"] == "qwen3:4b"


async def test_backend_unreachable_is_a_stated_502(client, pool, monkeypatch):
    monkeypatch.setenv("OLLAMA_URL", "http://127.0.0.1:1")
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:8b"})

    resp = await client.post("/v1/chat/completions", json={"messages": [], "stream": True})

    assert resp.status_code == 502
    assert "error" in resp.json()


async def test_a_mid_stream_failure_emits_an_openai_shaped_error_chunk_then_ends(
    client, pool, monkeypatch, mount_backend
):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(deltas=("par", "tial"), fail_after=1)
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:8b"})

    resp = await client.post("/v1/chat/completions", json={"messages": [], "stream": True})

    assert resp.status_code == 200  # headers were already sent as success
    frames = _sse_payloads(resp.content)
    assert _deltas(frames) == ["par"]
    error_frames = [f for f in frames if isinstance(f, dict) and "error" in f]
    assert len(error_frames) == 1
    assert "message" in error_frames[0]["error"]


async def test_backend_immediate_non_200_is_passed_through_verbatim(
    client, pool, monkeypatch, mount_backend
):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(probe_status=404)
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:8b"})

    resp = await client.post("/v1/chat/completions", json={"messages": [], "stream": False})

    assert resp.status_code == 404


async def test_models_ollama_shape_is_mapped_to_openai_list(
    client, pool, monkeypatch, mount_backend
):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(tags=("qwen3:8b", "qwen3:4b"))
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.get("/v1/models")

    assert resp.status_code == 200
    body = resp.json()
    assert body["object"] == "list"
    assert {m["id"] for m in body["data"]} == {"qwen3:8b", "qwen3:4b"}
    assert all(m["object"] == "model" for m in body["data"])


async def test_models_remote_is_the_one_labelled_listing_shape(client, pool, mount_backend):
    """S10-pre: every provider answers GET /v1/models in ONE shape — OpenAI's
    list, each row naming who owns it, and the listing naming its source and
    fetch time (never an unlabelled number). A remote row's own ids ride
    through untouched."""
    fake = FakeOpenAICompat(models_body={"object": "list", "data": [{"id": "gpt-remote"}]})
    mount_backend("http://remote.test", fake.app)
    await backends.save_config(pool, {"kind": "remote", "url": "http://remote.test"})

    resp = await client.get("/v1/models")

    assert resp.status_code == 200
    body = resp.json()
    assert body["object"] == "list"
    assert body["source"] == "remote"
    assert body["fetched_at"]
    assert body["data"] == [
        {"object": "model", "created": 0, "id": "gpt-remote", "owned_by": "remote"}
    ]
    assert fake.seen_auth == [None]


async def test_models_cloud_sends_the_api_key(client, pool, mount_backend):
    fake = FakeOpenAICompat()
    mount_backend("http://cloud.test", fake.app)
    await backends.save_config(
        pool, {"kind": "cloud", "url": "http://cloud.test", "api_key": "sk-secret", "model": "m"}
    )

    resp = await client.get("/v1/models")

    assert resp.status_code == 200
    assert fake.seen_auth == ["Bearer sk-secret"]


async def test_models_unreachable_is_a_stated_502(client, pool, monkeypatch):
    monkeypatch.setenv("OLLAMA_URL", "http://127.0.0.1:1")
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.get("/v1/models")

    assert resp.status_code == 502
    assert "error" in resp.json()


async def test_a_compressing_backend_is_asked_for_identity_so_the_relay_reads_cleanly(
    client, pool, mount_backend
):
    """Controller ruling R26: _STREAMING_EXCLUDE dropping Content-Encoding
    (finding 1b) is only truthful if the backend was never invited to
    compress in the first place — httpx's own default Accept-Encoding
    ("gzip, deflate") would otherwise have a compressing backend hand back
    still-compressed aiter_raw() bytes with the one header that says so now
    stripped, and a real client reading this relay the ordinary way (no
    manual decompression — that's not something a real caller does) gets
    zero decodable SSE lines: an empty assistant reply with no error.

    This fake behaves like a real, compliant backend: it compresses unless
    told not to, exactly mirroring what a real cloud/remote provider would
    do. Proving the full reply arrives therefore proves both halves at
    once — Accept-Encoding: identity is actually sent, and honoring it is
    what keeps this relay readable without ever needing content-encoding
    on the way back."""
    seen_accept_encoding = []
    plain_body = b'data: {"choices": [{"delta": {"content": "hi"}}]}\n\ndata: [DONE]\n\n'

    async def _completions(request):
        accept_encoding = request.headers.get("accept-encoding", "")
        seen_accept_encoding.append(accept_encoding)
        if "identity" in accept_encoding:
            return StarletteResponse(content=plain_body, media_type="text/event-stream")
        return StarletteResponse(
            content=gzip.compress(plain_body),
            media_type="text/event-stream",
            headers={"content-encoding": "gzip"},
        )

    backend = Starlette(routes=[Route("/v1/chat/completions", _completions, methods=["POST"])])
    mount_backend("http://compressing.test", backend)
    await backends.save_config(pool, {"kind": "remote", "url": "http://compressing.test"})

    resp = await client.post("/v1/chat/completions", json={"messages": [], "stream": True})

    assert resp.status_code == 200
    # Pinned, not incidental: the gateway must actually ask for identity.
    assert seen_accept_encoding == ["identity"]
    # Read the ordinary way — plain SSE parsing, no gzip.decompress anywhere
    # in this test — and the full reply arrives intact.
    frames = _sse_payloads(resp.content)
    assert _deltas(frames) == ["hi"]


async def test_a_backend_that_compresses_despite_identity_gets_a_stated_error_never_garbage(
    client, pool, mount_backend
):
    """S2 seam-hygiene (slice-01-carries.md): a backend that ignores the
    identity Accept-Encoding request entirely — unlike the compliant fake
    above, which only compresses when NOT asked for identity — used to get
    its Content-Encoding header silently stripped (defense-in-depth) while
    its still-compressed aiter_raw() bytes relayed through unchanged. A real
    client reading that the ordinary way gets undecodable binary where it
    expected SSE text: zero decodable lines, an empty assistant reply with
    no error anywhere. The fix: detect the violation before relaying any of
    those bytes, and answer with a single OpenAI-shaped SSE error frame
    naming the offending backend and the encoding it used, then end."""
    plain_body = b'data: {"choices": [{"delta": {"content": "hi"}}]}\n\ndata: [DONE]\n\n'

    async def _completions(request):
        # A non-compliant backend: compresses unconditionally, never even
        # looking at Accept-Encoding.
        return StarletteResponse(
            content=gzip.compress(plain_body),
            media_type="text/event-stream",
            headers={"content-encoding": "gzip"},
        )

    backend = Starlette(routes=[Route("/v1/chat/completions", _completions, methods=["POST"])])
    mount_backend("http://noncompliant.test", backend)
    await backends.save_config(pool, {"kind": "remote", "url": "http://noncompliant.test"})

    resp = await client.post("/v1/chat/completions", json={"messages": [], "stream": True})

    assert resp.status_code == 200  # headers already sent as success
    assert "content-encoding" not in resp.headers
    frames = _sse_payloads(resp.content)
    # Exactly the stated error, never any of the raw compressed bytes
    # decoded (or mis-decoded) as if they were plain SSE deltas.
    # S10 appends its usage chunk (unmetered — nothing was read) after the
    # stated error; the error is still the FIRST and only content frame.
    assert [f for f in frames if f != "[DONE]" and not f.get("usage")] == [frames[0]]
    assert frames[0] != "[DONE]"
    message = frames[0]["error"]["message"]
    assert "noncompliant.test" in message
    assert "gzip" in message


async def test_a_mid_stream_failure_never_forwards_content_encoding(client, pool, mount_backend):
    """A gzip-declared stream that dies partway gets our plain-text SSE
    error chunk appended after its (still-compressed) bytes — a client that
    trusted a forwarded Content-Encoding: gzip would try to gunzip a
    compressed-then-plain-text body and get a corrupt tail (controller
    ruling R25). The header must never ride along on this path, mid-stream
    failure or not."""

    async def _completions(request):
        async def gen():
            yield gzip.compress(b'{"choices": [{"delta"')
            raise RuntimeError("simulated mid-transfer drop")

        return StarletteStreamingResponse(
            gen(), media_type="application/json", headers={"content-encoding": "gzip"}
        )

    backend = Starlette(routes=[Route("/v1/chat/completions", _completions, methods=["POST"])])
    mount_backend("http://gzip-fail.test", backend)
    await backends.save_config(pool, {"kind": "remote", "url": "http://gzip-fail.test"})

    resp = await client.post("/v1/chat/completions", json={"messages": [], "stream": False})

    assert resp.status_code == 200  # headers were already sent as success
    assert "content-encoding" not in resp.headers
    assert b'"error"' in resp.content


async def test_a_gzipped_non_200_backend_response_relays_the_bare_error_uncorrupted(
    client, pool, mount_backend
):
    """Reproduces the real failure: a cloud backend's 401 arrives
    gzip-compressed. The non-200 branch buffers it with upstream.aread(),
    which httpx decompresses before we ever see the bytes — relaying the
    original Content-Encoding/Content-Length would describe a body that no
    longer exists. Left unfixed, core's own aread() on this relay raises
    DecodingError trying to gunzip already-plain JSON, and the operator sees
    "could not reach the gateway" instead of the provider's actual refusal.
    Both headers must be dropped so the relayed body reads as exactly what
    it is: plain JSON, at its real length."""
    original_error = {"error": {"message": "invalid api key"}}
    compressed = gzip.compress(json.dumps(original_error).encode())

    async def _completions(request):
        return StarletteResponse(
            content=compressed,
            status_code=401,
            media_type="application/json",
            headers={"content-encoding": "gzip", "content-length": str(len(compressed))},
        )

    backend = Starlette(routes=[Route("/v1/chat/completions", _completions, methods=["POST"])])
    mount_backend("http://cloud-401.test", backend)
    await backends.save_config(
        pool, {"kind": "cloud", "url": "http://cloud-401.test", "api_key": "sk-x", "model": "m"}
    )

    resp = await client.post("/v1/chat/completions", json={"messages": [], "stream": False})

    assert resp.status_code == 401
    assert "content-encoding" not in resp.headers
    # No stale length either: Starlette computes it fresh from the real body.
    assert int(resp.headers["content-length"]) == len(resp.content)
    # The client can read this the ordinary way — no second decode, no
    # DecodingError — and gets the provider's actual stated refusal.
    assert resp.json() == original_error


async def test_a_declared_content_length_is_never_forwarded_on_the_streaming_path(
    client, pool, mount_backend
):
    """A non-streaming completion can carry a real Content-Length from the
    backend. If relay() has to append an SSE error chunk after a
    mid-transfer failure, bytes actually sent would then exceed that
    declared length — an HTTP framing violation. The streaming/relay path
    must never forward Content-Length, whatever the upstream declared."""
    partial = b'{"choices": [{"delta"'
    declared_length = len(partial) + 500  # a real but, after the drop, false promise

    async def _completions(request):
        async def gen():
            yield partial
            raise RuntimeError("simulated mid-transfer drop")

        return StarletteStreamingResponse(
            gen(),
            media_type="application/json",
            headers={"content-length": str(declared_length)},
        )

    backend = Starlette(routes=[Route("/v1/chat/completions", _completions, methods=["POST"])])
    mount_backend("http://cl.test", backend)
    await backends.save_config(pool, {"kind": "remote", "url": "http://cl.test"})

    resp = await client.post("/v1/chat/completions", json={"messages": [], "stream": False})

    assert resp.status_code == 200
    assert "content-length" not in resp.headers
    # No framing desync: the client can still read past the partial body to
    # the appended error chunk, rather than truncating or hanging at the
    # (now-false) declared length.
    assert partial in resp.content
    assert b'"error"' in resp.content


async def test_a_derived_agent_role_is_served_from_its_own_chain_and_metered_under_it(
    client, pool, monkeypatch, mount_backend
):
    """S12-2: `X-Nova-Role: agent_coder` (a core-side agent's derived role)
    walks that role's chain — a cloud provider the owner named — and the
    ledger row carries the role, so the agent is served and metered by its
    own chain, not chat's."""
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    local = FakeOllama(deltas=("Hel", "lo"))
    mount_backend("http://ollama.test", local.app)
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:8b"})
    cloud = FakeOpenAICompat(accepts_key="sk-1")
    mount_backend("http://coder.test", cloud.app)
    made = await client.post(
        "/admin/providers",
        json={
            "name": "coder_cloud",
            "adapter": "openai-chat",
            "base_url": "http://coder.test/v1",
            "auth_shape": "static-bearer",
            "api_key": "sk-1",
        },
    )
    assert made.status_code == 200, made.text
    put = await client.put("/admin/routes/agent_coder", json={"chain": ["coder_cloud:big-model"]})
    assert put.status_code == 200 and put.json()["chain"] == ["coder_cloud:big-model"]

    resp = await client.post(
        "/v1/chat/completions",
        json={"messages": [{"role": "user", "content": "hi"}], "stream": True},
        headers={"X-Nova-Role": "agent_coder", "X-Nova-Purpose": "agent"},
    )

    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "coder_cloud:big-model"
    assert resp.headers["x-nova-route"] == "role=agent_coder;link=1"
    assert [p for p, _ in cloud.seen if p.endswith("/chat/completions")] == ["/v1/chat/completions"]
    assert cloud.seen[-1][1]["model"] == "big-model"
    assert not [p for p, _ in local.seen if p.endswith("/chat/completions")]
    (row,) = await pool.fetch("SELECT role, purpose, served_by, route_link FROM usage_events")
    assert (row["role"], row["purpose"], row["served_by"], row["route_link"]) == (
        "agent_coder",
        "agent",
        "coder_cloud:big-model",
        1,
    )


# ── no-ceiling T1: X-Nova-Pass-Over on a role-walked chat completion ───────
# `quote(link)=quote(words)[,...]`: the links core passes over for this one
# request (a round that answered with thinking only). Read only when the call
# walks a role's chain; a malformed pair or a call with no role is a 400 in
# words, and nothing reaches a provider.

from urllib.parse import quote  # noqa: E402

import pytest  # noqa: E402

WORDS = "thinking only, twice = no answer"  # a comma and an '=' survive encoding


async def _three_local(client, pool, monkeypatch, mount_backend) -> FakeOllama:
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(deltas=("Hel", "lo"), tags=("qwen3:8b", "qwen3:4b", "qwen3:1.7b"))
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:8b"})
    put = await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:4b", "hub:qwen3:1.7b"]})
    assert put.status_code == 200, put.text
    return fake


def _dialled(fake: FakeOllama) -> list[str]:
    return [b["model"] for p, b in fake.seen if p == "/v1/chat/completions"]


async def _completion(client, headers: dict[str, str]):
    return await client.post(
        "/v1/chat/completions",
        json={
            "model": "hub:qwen3:8b",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": True,
        },
        headers=headers,
    )


async def test_the_pass_over_header_is_percent_decoded_and_every_pair_is_passed_over(
    client, pool, monkeypatch, mount_backend
):
    fake = await _three_local(client, pool, monkeypatch, mount_backend)
    header = ",".join(
        f"{quote(link, safe='')}={quote(WORDS, safe='')}"
        for link in ("hub:qwen3:8b", "hub:qwen3:4b")
    )

    resp = await _completion(
        client, {"X-Nova-Role": "chat", "X-Nova-Purpose": "chat", "X-Nova-Pass-Over": header}
    )

    assert resp.status_code == 200, resp.text
    assert resp.headers["x-nova-served-by"] == "hub:qwen3:1.7b"
    from urllib.parse import unquote

    route = resp.headers["x-nova-route"]
    assert route.startswith("role=chat;link=3;")
    reason = unquote(route.split("reason=", 1)[1].split(";", 1)[0])
    assert "passed over" in reason and WORDS in reason
    assert "hub:qwen3:8b" in reason and "hub:qwen3:4b" in reason
    assert _dialled(fake) == ["qwen3:1.7b"]
    (row,) = await pool.fetch(
        "SELECT route_link, route_reason FROM usage_events WHERE kind = 'completion'"
    )
    assert row["route_link"] == 3 and WORDS in row["route_reason"]
    assert "passed over" in row["route_reason"]


async def test_every_link_passed_over_is_a_503_that_lists_them(
    client, pool, monkeypatch, mount_backend
):
    fake = await _three_local(client, pool, monkeypatch, mount_backend)
    header = ",".join(
        f"{quote(link, safe='')}={quote(WORDS, safe='')}"
        for link in ("hub:qwen3:8b", "hub:qwen3:4b", "hub:qwen3:1.7b")
    )

    resp = await _completion(client, {"X-Nova-Role": "chat", "X-Nova-Pass-Over": header})

    assert resp.status_code == 503
    error = resp.json()["error"]
    for link in ("hub:qwen3:8b", "hub:qwen3:4b", "hub:qwen3:1.7b"):
        assert f"{link}: " in error and WORDS in error
    assert "unreachable" not in error and "refused" not in error and "walled" not in error
    assert _dialled(fake) == []


@pytest.mark.parametrize(
    "bad_pair",
    [
        "hub%3Aqwen3%3A8b",  # no '='
        "=thinking%20only",  # empty link
        "hub%3Aqwen3%3A8b=%ZZ",  # bad percent-encoding
        "hub%3Aqwen3%3A8b=%FF%FE",  # decodes to bytes that are not UTF-8
    ],
)
async def test_a_malformed_pass_over_pair_is_a_400_naming_it(
    client, pool, monkeypatch, mount_backend, bad_pair
):
    fake = await _three_local(client, pool, monkeypatch, mount_backend)

    resp = await _completion(
        client,
        {"X-Nova-Role": "chat", "X-Nova-Pass-Over": f"hub%3Aqwen3%3A4b=fine,{bad_pair}"},
    )

    assert resp.status_code == 400, resp.text
    error = resp.json()["error"]
    assert "X-Nova-Pass-Over" in error and bad_pair in error
    assert _dialled(fake) == []


async def test_pass_over_on_a_call_with_no_role_is_a_400_in_words(
    client, pool, monkeypatch, mount_backend
):
    fake = await _three_local(client, pool, monkeypatch, mount_backend)

    resp = await _completion(
        client,
        {
            "X-Nova-Purpose": "eval",
            "X-Nova-Pass-Over": f"{quote('hub:qwen3:8b', safe='')}={quote(WORDS, safe='')}",
        },
    )

    assert resp.status_code == 400, resp.text
    assert "pass-over needs a role's chain" in resp.json()["error"]
    assert _dialled(fake) == []


async def test_an_empty_pass_over_header_changes_nothing(client, pool, monkeypatch, mount_backend):
    fake = await _three_local(client, pool, monkeypatch, mount_backend)

    resp = await _completion(client, {"X-Nova-Role": "chat", "X-Nova-Pass-Over": ""})

    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "hub:qwen3:8b"
    assert resp.headers["x-nova-route"] == "role=chat;link=1"
    assert _dialled(fake) == ["qwen3:8b"]
