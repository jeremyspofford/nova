"""The native ollama client — the translation layer, which is where the
risk is.

    docker compose exec backend python tests/test_ollama_native.py

Local calls moved off the OpenAI-compat shim so the thinking toggle and
num_ctx actually take effect. Everything upstream (the runner, the tool
loop, the trace) is unchanged, which is only safe if this client emits the
SAME events and translates messages losslessly in both directions. Each
case below is one of those seams.
"""

import asyncio
import json
import sys

sys.path.insert(0, "/app/backend")

from app.llm import ollama_native as native                # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


# ── message translation ──────────────────────────────────────────────────

def test_tool_call_arguments_round_trip():
    print("1. tool arguments: OpenAI string <-> ollama object")
    # outbound: the assistant's previous tool_calls carry a JSON STRING
    msgs = native.to_ollama_messages([
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "c1", "type": "function",
             "function": {"name": "web_search",
                          "arguments": '{"query": "bear mountain"}'}}]}])
    args = msgs[0]["tool_calls"][0]["function"]["arguments"]
    check("outbound: parsed into an object for ollama",
          isinstance(args, dict) and args["query"] == "bear mountain", str(args))

    # malformed arguments must stay malformed — the runner's rail depends on it
    msgs = native.to_ollama_messages([
        {"role": "assistant", "tool_calls": [
            {"function": {"name": "x", "arguments": "{not json"}}]}])
    args = msgs[0]["tool_calls"][0]["function"]["arguments"]
    check("outbound: broken JSON is preserved, never silently emptied",
          args.get("_raw") == "{not json", str(args))


def test_multimodal_translation():
    print("2. images: OpenAI content parts -> ollama images array")
    msgs = native.to_ollama_messages([
        {"role": "user", "content": [
            {"type": "text", "text": "what is this?"},
            {"type": "image_url",
             "image_url": {"url": "data:image/jpeg;base64,AAAABBBB"}}]}])
    check("the text survives", msgs[0]["content"] == "what is this?")
    check("the image becomes raw base64 in `images`",
          msgs[0].get("images") == ["AAAABBBB"], str(msgs[0].get("images")))

    plain = native.to_ollama_messages([{"role": "user", "content": "hello"}])
    check("a plain string message is untouched",
          plain[0]["content"] == "hello" and "images" not in plain[0])

    remote = native.to_ollama_messages([
        {"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "https://x/y.jpg"}}]}])
    check("a remote image URL is dropped, not sent as prose",
          not remote[0].get("images") and remote[0]["content"] == "")


# ── the event contract ───────────────────────────────────────────────────

class FakeStream:
    def __init__(self, lines, status=200, body=b""):
        self._lines = lines
        self.status_code = status
        self._body = body

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aread(self):
        return self._body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


def fake_client(lines, status=200, body=b""):
    class C:
        payload = None

        def __init__(self, **kw):
            pass

        def stream(self, method, url, **kw):
            C.payload = kw.get("json")
            C.url = url
            return FakeStream(lines, status, body)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False
    return C


async def collect(lines, **kw):
    import httpx
    saved = httpx.AsyncClient
    C = fake_client(lines)
    httpx.AsyncClient = C
    try:
        c = native.OllamaNativeClient("http://ollama:11434")
        events = [e async for e in c.stream([{"role": "user", "content": "hi"}],
                                            "qwen3:8b", **kw)]
        return events, C
    finally:
        httpx.AsyncClient = saved


async def test_event_vocabulary():
    print("3. the same events the OpenAI-compat client emits")
    lines = [
        json.dumps({"message": {"thinking": "let me think"}, "done": False}),
        json.dumps({"message": {"content": "Paris"}, "done": False}),
        json.dumps({"message": {"tool_calls": [
            {"id": "c1", "function": {"name": "get_weather",
                                      "arguments": {"location": "Paris"}}}]},
            "done": False}),
        json.dumps({"done": True, "prompt_eval_count": 120, "eval_count": 7,
                    "prompt_eval_duration": 1_400_000_000,
                    "load_duration": 42_000_000, "total_duration": 3_100_000_000}),
    ]
    events, C = await collect(lines)
    kinds = [e["type"] for e in events]
    check("reasoning, text, usage, tool_calls, done all present",
          set(kinds) == {"reasoning", "text", "usage", "tool_calls", "done"}, str(kinds))

    reasoning = next(e for e in events if e["type"] == "reasoning")
    text = next(e for e in events if e["type"] == "text")
    check("thinking arrives as reasoning, NOT as text",
          reasoning["text"] == "let me think" and text["text"] == "Paris")

    calls = next(e for e in events if e["type"] == "tool_calls")["tool_calls"]
    check("inbound: ollama's object args become a JSON STRING for the runner",
          isinstance(calls[0]["arguments"], str)
          and json.loads(calls[0]["arguments"])["location"] == "Paris",
          str(calls[0]["arguments"]))
    check("the call keeps an id", bool(calls[0]["id"]))

    usage = next(e for e in events if e["type"] == "usage")["usage"]
    check("token counts map to the ledger's names",
          usage["prompt_tokens"] == 120 and usage["completion_tokens"] == 7, str(usage))

    # ollama publishes no cached-token count, so a reused prefix is only
    # visible as the prefill time collapsing for an unchanged token count
    check("the prefill/load/total durations are carried through",
          usage["prompt_eval_ns"] == 1_400_000_000
          and usage["load_ns"] == 42_000_000
          and usage["total_ns"] == 3_100_000_000, str(usage))
    check("cached_tokens is NOT synthesised from them",
          "cached_tokens" not in usage, str(usage))

    # a server that reports no durations must not invent zeros: absent and
    # "measured as zero" are different answers in the ledger
    plain = [json.dumps({"done": True, "prompt_eval_count": 5, "eval_count": 1})]
    events2, _C2 = await collect(plain)
    u2 = next(e for e in events2 if e["type"] == "usage")["usage"]
    check("a chunk without durations reports them as None",
          u2["prompt_eval_ns"] is None and u2["load_ns"] is None, str(u2))

    check("tool_calls are emitted AFTER the stream, once",
          kinds.count("tool_calls") == 1 and kinds.index("tool_calls") > kinds.index("text"))


async def test_params_reach_the_request():
    print("4. think and num_ctx actually go on the wire")
    lines = [json.dumps({"done": True})]
    _events, C = await collect(lines, think=False, num_ctx=16384)
    check("think is sent verbatim", C.payload.get("think") is False, str(C.payload.get("think")))
    check("num_ctx rides options",
          (C.payload.get("options") or {}).get("num_ctx") == 16384, str(C.payload.get("options")))
    check("the native endpoint is used", C.url.endswith("/api/chat"), C.url)

    _events, C = await collect(lines)
    check("no think key when the caller sends none", "think" not in C.payload)
    check("no options when no num_ctx", "options" not in C.payload)


async def test_silent_truncation_is_caught():
    print("4b. a prompt ollama CUT is reported, because ollama does not")
    # MEASURED on ollama 0.31.2 (`--context-shift --keep 4`): a ~9,050-token
    # prompt at num_ctx 2048 came back with prompt_eval_count 1026,
    # done_reason "stop", NO error field, and the system prompt gone — the
    # model answered "I am a language model" instead of the SENTINEL it had
    # been told to say. The survivor count is num_ctx//2 + 2 exactly.
    for ctx, survivors in ((2048, 1026), (4096, 2050), (8192, 4098)):
        check(f"num_ctx {ctx} -> {survivors} survivors is the context-shift "
              f"signature",
              native._truncation_signature(survivors, ctx, None) == "context_shift",
              str(native._truncation_signature(survivors, ctx, None)))
    check("an ordinary prompt count at the same window is NOT a signature",
          native._truncation_signature(1500, 2048, 1900) is None)
    check("...nor is a count one off it, because the arithmetic is exact",
          native._truncation_signature(1027, 2048, None) is None)

    # The second arm is mandatory: on every path where resolve() returned
    # None the request carries no num_ctx, so the arithmetic above has no
    # input — and that is exactly the case where the server runs at its own
    # default and cuts.
    check("with no num_ctx, a count far below what was sent still reports",
          native._truncation_signature(900, None, 9000) == "far_below_estimate")
    check("...but ordinary estimator error does not — the estimate runs high "
          "by design (3 chars/token against a real ~4)",
          native._truncation_signature(7000, None, 9000) is None)
    check("a small prompt cannot trip the ratio at all",
          native._truncation_signature(10, None, 100) is None)
    check("and a server that reports nothing reports nothing",
          native._truncation_signature(None, 2048, 9000) is None)

    lines = [json.dumps({"message": {"content": "I am a language model"},
                         "done": False}),
             json.dumps({"done": True, "prompt_eval_count": 1026,
                         "eval_count": 6})]
    events, _C = await collect(lines, num_ctx=2048, expect_prompt_tokens=9050)
    cut = next((e for e in events if e["type"] == "context_truncated"), None)
    check("the stream emits it as its own event, after usage",
          cut is not None and [e["type"] for e in events].index("context_truncated")
          > [e["type"] for e in events].index("usage"), str(cut))
    check("...carrying both numbers, so the ledger can say how much was lost",
          cut and cut["prompt_tokens_real"] == 1026
          and cut["prompt_tokens_expected"] == 9050, str(cut))

    fine = [json.dumps({"done": True, "prompt_eval_count": 7000,
                        "eval_count": 6})]
    events, _C = await collect(fine, num_ctx=16384, expect_prompt_tokens=9050)
    check("a prompt that fit says nothing",
          not any(e["type"] == "context_truncated" for e in events))


async def test_error_classification():
    print("5. error classes match the compat client's contract")
    import httpx
    saved = httpx.AsyncClient
    httpx.AsyncClient = fake_client([], status=404, body=b'{"error":"model not found"}')
    try:
        c = native.OllamaNativeClient("http://ollama:11434")
        events = [e async for e in c.stream([], "nope")]
    finally:
        httpx.AsyncClient = saved
    err = next(e for e in events if e["type"] == "error")
    check("404 -> http_status with the code and a pull hint",
          err["error_class"] == "http_status" and err["status_code"] == 404
          and "not pulled" in err["error"], str(err)[:90])

    # an error mid-stream, after output: never safe to retry elsewhere
    lines = [json.dumps({"message": {"content": "partial"}, "done": False}),
             json.dumps({"error": "context canceled"})]
    events, _C = await collect(lines)
    err = next(e for e in events if e["type"] == "error")
    check("an error after output is mid_stream", err["error_class"] == "mid_stream", str(err))

    # ...and before any output it is a connect-class failure
    events, _C = await collect([json.dumps({"error": "server busy"})])
    err = next(e for e in events if e["type"] == "error")
    check("an error before output is connect_failed",
          err["error_class"] == "connect_failed", str(err))


async def main():
    test_tool_call_arguments_round_trip()
    print()
    test_multimodal_translation()
    print()
    for t in (test_event_vocabulary, test_params_reach_the_request,
              test_silent_truncation_is_caught, test_error_classification):
        await t()
        print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
