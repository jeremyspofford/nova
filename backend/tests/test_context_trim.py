"""Phase 2 verification (docs/plans/turn-speed.md): intra-turn overflow
protection.

Self-contained, no DB and no network:

    docker compose exec backend python tests/test_context_trim.py

The two the plan names explicitly are cases 4 and 5: a trimmed transcript
round-tripped through the request builder still pairs every tool_call_id
with a tool message, and an image turn is not trimmed below the real
ceiling (a base64 photo read by character count looks like ~83k tokens).
"""

import json
import sys

sys.path.insert(0, "/app/backend")

from app import settings_store                             # noqa: E402
from app.agents import context_trim                        # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def set_budget(n):
    settings_store._cache["agents.intraturn_budget"] = n


def tool_msg(call_id, text):
    return {"role": "tool", "tool_call_id": call_id, "content": text}


def assistant_calls(*calls):
    return {"role": "assistant", "content": None,
            "tool_calls": [{"id": cid, "type": "function",
                            "function": {"name": name, "arguments": "{}"}}
                           for cid, name in calls]}


def transcript(n_pairs, chars, *, prefix="web"):
    """A realistic research transcript: system, user, then n rounds of
    (assistant asks for a tool) + (tool answers with `chars` of output)."""
    msgs = [{"role": "system", "content": "S" * 2000},
            {"role": "user", "content": "research this"}]
    for i in range(n_pairs):
        cid = f"{prefix}{i}"
        msgs.append(assistant_calls((cid, "web_search")))
        msgs.append(tool_msg(cid, f"result {i}: " + "x" * chars))
    return msgs


# ── 1. the estimator ─────────────────────────────────────────────────────

def test_estimator():
    print("1. estimator: conservative, image-aware, never crashes on None")
    check("chars//3 per string message",
          context_trim.estimate_tokens([{"role": "user", "content": "x" * 300}]) == 104,
          str(context_trim.estimate_tokens([{"role": "user", "content": "x" * 300}])))
    check("content=None is skipped, not counted",
          context_trim.estimate_tokens([{"role": "assistant", "content": None}]) == 4)

    photo = {"role": "user", "content": [
        {"type": "text", "text": "what is this?"},
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + "A" * 250_000}}]}
    tokens = context_trim.estimate_tokens([photo])
    check("a 250KB base64 image costs ~1k tokens, not ~83k",
          900 < tokens < 1100, str(tokens))

    with_calls = context_trim.estimate_tokens([assistant_calls(("a", "web_search"))])
    check("tool_calls on the assistant message are counted", with_calls > 4,
          str(with_calls))


# ── 2. the ceiling ───────────────────────────────────────────────────────

def test_ceiling():
    print("2. ceiling: the setting, lowered by the model's real window")
    set_budget(60000)
    from app import models_catalog
    saved = models_catalog._cache.get("models")
    models_catalog._cache["models"] = [
        {"id": "openrouter:small", "provider": "openrouter", "context_length": 16000},
        {"id": "openrouter:huge", "provider": "openrouter", "context_length": 1_000_000},
        {"id": "ollama:qwen3:8b", "provider": "ollama"},
    ]
    # ceiling_for resolves through effective_model, so a cloud model only
    # keeps its own window while its provider is actually usable. Mirror
    # production here; the unconfigured case is asserted on its own below.
    from app.llm import providers
    saved_providers = dict(providers._cache)
    providers._cache["openrouter"] = {
        "slug": "openrouter", "enabled": True, "needs_key": False,
        "api_key": None, "api_key_env": None, "base_url": "", "name": "or"}
    try:
        check("a 16k model lowers the 60k budget (minus completion headroom)",
              context_trim.ceiling_for("openrouter:small") == 12000,
              str(context_trim.ceiling_for("openrouter:small")))
        check("a 1M model does not RAISE it",
              context_trim.ceiling_for("openrouter:huge") == 60000)
        # phase 3: for a LOCAL model the configured server window IS the real
        # one — ollama reports none, and trimming has to aim at the window the
        # call must actually fit or the router refuses it
        settings_store._cache["inference.ollama_num_ctx"] = 16384
        check("a local model is sized by the configured server window",
              context_trim.ceiling_for("ollama:qwen3:8b") == 12384,
              str(context_trim.ceiling_for("ollama:qwen3:8b")))
        settings_store._cache["inference.ollama_num_ctx"] = 0
        check("...and falls back to the budget when it is unset",
              context_trim.ceiling_for("ollama:qwen3:8b") == 60000)
        settings_store._cache["inference.ollama_num_ctx"] = 16384
        check("a cloud model missing from the catalog falls back",
              context_trim.ceiling_for("openrouter:never-seen") == 60000)

        # THE 2026-07-27 BUG. A cloud model whose provider is not configured
        # is swapped for the local fallback before the call leaves — so the
        # window that matters is the fallback's. Sizing against the model the
        # agent row NAMES produced a 60,000-token budget for a call that
        # actually went to ollama:qwen2.5:3b, and the router then refused
        # prompts this function had just declared safe. Everything that sizes
        # against this number does so precisely so it agrees with that refusal.
        providers._cache.pop("openrouter", None)
        check("an unconfigured cloud model is sized by the LOCAL FALLBACK it "
              "will actually run on, not by the window it claims",
              context_trim.ceiling_for("openrouter:huge") == 12384,
              str(context_trim.ceiling_for("openrouter:huge")))
    finally:
        models_catalog._cache["models"] = saved
        providers._cache.clear()
        providers._cache.update(saved_providers)


# ── 3. trimming behavior ─────────────────────────────────────────────────

def test_no_trim_under_ceiling():
    print("3. under the ceiling: nothing happens at all")
    set_budget(60000)
    msgs = transcript(4, 3000)
    before = json.dumps(msgs)
    report = context_trim.trim_transcript(msgs, model="openrouter:test")
    check("no message touched", json.dumps(msgs) == before)
    check("report says nothing was trimmed", report["trimmed_messages"] == 0)


def test_trim_preserves_pairing():
    print("4. over the ceiling: every tool_call_id keeps its tool message")
    set_budget(8000)
    msgs = transcript(8, 8000)
    ids_before = [m["tool_call_id"] for m in msgs if m["role"] == "tool"]
    roles_before = [m["role"] for m in msgs]
    report = context_trim.trim_transcript(msgs, model="openrouter:test")

    check("it trimmed", report["trimmed_messages"] > 0, str(report))
    check("under the ceiling afterwards", report["after"] <= report["ceiling"],
          f"{report['after']} vs {report['ceiling']}")
    check("no message was removed or reordered",
          [m["role"] for m in msgs] == roles_before)
    ids_after = [m["tool_call_id"] for m in msgs if m["role"] == "tool"]
    check("every tool_call_id still answered", ids_after == ids_before)

    # the round-trip the plan asks for: the request the client would build
    requested = {c["id"] for m in msgs if m["role"] == "assistant"
                 for c in (m.get("tool_calls") or [])}
    answered = {m["tool_call_id"] for m in msgs if m["role"] == "tool"}
    check("requested ids == answered ids (no provider 400)",
          requested == answered, f"{requested ^ answered}")
    check("trimmed messages say so", any("trimmed to fit" in m["content"]
                                         for m in msgs if m["role"] == "tool"))
    check("nothing trimmed below the floor",
          all(len(m["content"]) >= context_trim._MIN_KEPT_CHARS
              for m in msgs if m["role"] == "tool"))


def test_image_turn_not_trimmed():
    print("5. an image turn is not trimmed below the real ceiling")
    set_budget(60000)
    msgs = [{"role": "system", "content": "S" * 2000},
            {"role": "user", "content": [
                {"type": "text", "text": "what is in this photo?"},
                {"type": "image_url",
                 "image_url": {"url": "data:image/jpeg;base64," + "A" * 400_000}}]},
            assistant_calls(("a", "search_memory")),
            tool_msg("a", "some memory context " * 200)]
    before = json.dumps(msgs)
    report = context_trim.trim_transcript(msgs, model="openrouter:test")
    check("an attachment turn stays untouched", json.dumps(msgs) == before,
          f"est {report['before']} vs ceiling {report['ceiling']}")


def test_dispatch_results_exempt():
    print("6. a specialist's report is never the thing that gets trimmed")
    set_budget(8000)
    msgs = [{"role": "system", "content": "S" * 1000},
            {"role": "user", "content": "research this"},
            assistant_calls(("d1", "dispatch_to_agent")),
            tool_msg("d1", "SPECIALIST REPORT: " + "r" * 20000),
            assistant_calls(("w1", "web_search"), ("w2", "fetch_url")),
            tool_msg("w1", "raw search " + "s" * 20000),
            tool_msg("w2", "raw page " + "p" * 20000)]
    report = context_trim.trim_transcript(
        msgs, model="openrouter:test", exempt_ids={"d1"}, bulk_ids={"w1", "w2"})
    by_id = {m["tool_call_id"]: m["content"] for m in msgs if m["role"] == "tool"}
    check("the dispatch result is intact",
          by_id["d1"].startswith("SPECIALIST REPORT") and len(by_id["d1"]) > 20000,
          str(len(by_id["d1"])))
    check("the raw web results absorbed the trim",
          len(by_id["w1"]) < 20000 or len(by_id["w2"]) < 20000, str(report))


def test_bulk_first_then_oldest():
    print("7. raw web results go first, then oldest-first")
    set_budget(8000)
    msgs = [{"role": "system", "content": "S" * 500},
            {"role": "user", "content": "go"},
            assistant_calls(("m1", "search_memory")),
            tool_msg("m1", "OLD MEMORY " + "m" * 15000),
            assistant_calls(("w1", "web_search")),
            tool_msg("w1", "NEW WEB " + "w" * 15000)]
    context_trim.trim_transcript(msgs, model="openrouter:test",
                                 bulk_ids={"w1"})
    by_id = {m["tool_call_id"]: m["content"] for m in msgs if m["role"] == "tool"}
    check("the newer WEB result was trimmed before the older memory one",
          len(by_id["w1"]) < len(by_id["m1"]),
          f"web {len(by_id['w1'])} vs memory {len(by_id['m1'])}")


def test_nothing_left_to_trim_is_reported():
    print("8. an untrimmable overflow is reported, not hidden")
    set_budget(8000)
    msgs = [{"role": "system", "content": "S" * 200},
            {"role": "user", "content": "go"},
            assistant_calls(("d1", "dispatch_to_agent")),
            tool_msg("d1", "REPORT " + "r" * 60000)]
    detail = {}
    report = context_trim.trim_transcript(
        msgs, model="openrouter:test", exempt_ids={"d1"}, detail=detail)
    check("nothing was trimmed", report["trimmed_messages"] == 0)
    check("the trace says it is still over the ceiling",
          detail.get("context_over_ceiling") is True, str(detail))


def test_trace_fields():
    print("9. trace fields: pressure before, results after")
    set_budget(10000)
    detail = {}
    # ~87% of the ceiling: close to the wall, but nothing trimmed yet — the
    # flag has to appear BEFORE the first trim or it can't warn anyone
    report = context_trim.trim_transcript(transcript(4, 6000),
                                          model="openrouter:test", detail=detail)
    check("estimate and ceiling always recorded",
          "prompt_tokens_est" in detail and "context_ceiling" in detail, str(detail))
    check("pressure flagged at 80% of the ceiling, before any trim",
          "context_pressure" in detail and report["trimmed_messages"] == 0,
          str(detail))

    detail = {}
    context_trim.trim_transcript(transcript(1, 300), model="openrouter:test",
                                 detail=detail)
    check("a small turn carries no pressure flag",
          "context_pressure" not in detail, str(detail))


def main():
    for t in (test_estimator, test_ceiling, test_no_trim_under_ceiling,
              test_trim_preserves_pairing, test_image_turn_not_trimmed,
              test_dispatch_results_exempt, test_bulk_first_then_oldest,
              test_nothing_left_to_trim_is_reported, test_trace_fields):
        t()
        print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
