"""The prompt's cache boundary — what may move between turns, and what may not.

    docker compose exec backend python tests/test_prompt_cache.py

Every provider prompt cache is an exact-prefix BYTE match. So a block that
changes every minute, sitting ahead of blocks that never change, does not cost
its own size — it costs everything behind it. MEASURED on this install before
the split: `main` on z-ai/glm cached 57.5% of round 1's prompt tokens, with
~1,225 tokens of permanently stable text (the specialist index, the soul, the
toolset, the register) sitting BEHIND a clock, an automation-state block on a
15-second TTL, a goal counter and a capability-events block whose newest-8 set
rolls about thirteen times a day.

`_build_system_prompt` therefore returns two halves rather than one string,
and this suite defends the only three properties that make that worth doing:

  1. THE STABLE HALF IS BYTE-IDENTICAL across two turns that differ only in
     things nobody asked to change — the clock, an automation's last_status,
     a new capability event. If it is not, the split has bought nothing.
  2. THE VOLATILE HALF STILL MOVES. A "stable" prompt that never reflects a
     changed fact is worse than a slow one, and asserting (1) alone would
     pass trivially if the volatile half were dropped on the floor.
  3. THE RENDERED PROSE DOES NOT CHANGE. Flat or split, the model must read
     exactly the same characters in exactly the same order — this lane is
     about where the boundary is drawn, not about rewriting the prompt.

The blocks are stubbed rather than driven off a live database on purpose:
this is a test of the ASSEMBLY, and the lane before it shipped a test that
passed because a real dependency silently returned None. Fixed inputs in,
fixed bytes out.
"""

import asyncio
import contextlib
import json
import sys
import types

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


AGENT = {"id": "a1", "name": "main", "model": "openrouter:z-ai/glm-5.2",
         "system_prompt": "You are the main agent.", "thinking": "auto"}


class _FakeMemory:
    """Just enough of the memory singleton for prompt assembly."""

    async def context(self, query, origins=None):
        return {"context": f"note about {query}", "untrusted": False,
                "origins": ["first_party"], "memory_ids": ["m1"]}

    async def skills_context(self, query):
        return {"context": "skill: how to grep"}

    async def soul(self, name):
        return f"I am {name}."


@contextlib.contextmanager
def stubbed(runner, *, clock, entities, events):
    """Swap every block source for a fixed value; restore on the way out."""
    from app import capability_events, timefmt

    saved = {
        "platform": runner._platform_block, "shapes": runner._shapes_block,
        "mcp": runner._mcp_index_block, "identity": runner._identity_block,
        "entities": runner._entities_block, "goals": runner._goals_block,
        "memory": runner.memory, "now": timefmt.now_local,
        "events": capability_events.prompt_block,
        "settings": runner.settings_store.get,
        "canonical": runner.tool_registry.canonical_name,
        "is_actor": runner.tool_registry.is_actor,
    }

    async def _const(value):
        return value

    runner._platform_block = lambda: _const("## Platform facts (live)\nGPU: a 3090.")
    runner._shapes_block = lambda names: _const("## Shapes\nask, propose, build.")
    runner._mcp_index_block = lambda agent: _const("## MCP servers\n- server `fs`: 4 tools")
    runner._identity_block = lambda speaker: _const("## Who you're speaking with (live)\nJeremy — role: operator.")
    runner._entities_block = lambda: _const(entities)
    runner._goals_block = lambda: _const("## Goals\n2 action(s) left")
    runner.memory = _FakeMemory()
    timefmt.now_local = lambda: clock
    capability_events.prompt_block = lambda: _const(events)
    runner.settings_store.get = lambda key, *a, **kw: (
        "Nova" if key == "nova.assistant_name" else None)
    runner.tool_registry.canonical_name = lambda n: n
    runner.tool_registry.is_actor = lambda n: False
    try:
        yield
    finally:
        runner._platform_block = saved["platform"]
        runner._shapes_block = saved["shapes"]
        runner._mcp_index_block = saved["mcp"]
        runner._identity_block = saved["identity"]
        runner._entities_block = saved["entities"]
        runner._goals_block = saved["goals"]
        runner.memory = saved["memory"]
        timefmt.now_local = saved["now"]
        capability_events.prompt_block = saved["events"]
        runner.settings_store.get = saved["settings"]
        runner.tool_registry.canonical_name = saved["canonical"]
        runner.tool_registry.is_actor = saved["is_actor"]


async def build(runner, *, clock, entities, events):
    with stubbed(runner, clock=clock, entities=entities, events=events):
        return await runner._build_system_prompt(
            AGENT, "what is the weather",
            include_index=False, conversation_summary="we spoke about rain",
            speaker=None, tool_names=["web_search", "dispatch_to_agent"])


async def run() -> None:
    import datetime as dt

    from app.agents import context_trim, runner
    from app.llm import router as llm_router

    t1 = dt.datetime(2026, 8, 4, 10, 30, tzinfo=dt.timezone.utc)
    t2 = dt.datetime(2026, 8, 4, 10, 31, tzinfo=dt.timezone.utc)
    ents_a = "## Automations\nnightly-ingest — last_status: ok, 3 items"
    ents_b = "## Automations\nnightly-ingest — last_status: failed, 4 items"
    ev_a = "## What changed recently\n- granted web_search to main"
    ev_b = "## What changed recently\n- granted fetch_url to ingestion"

    print("1. the clock moving does not move the prefix")
    stable_a, vol_a = await build(runner, clock=t1, entities=ents_a, events=ev_a)
    stable_b, vol_b = await build(runner, clock=t2, entities=ents_a, events=ev_a)
    check("a minute later, the stable half is byte-identical",
          stable_a == stable_b, f"{len(stable_a)} vs {len(stable_b)} chars")
    check("...and the volatile half is NOT — the clock still moves",
          vol_a != vol_b)
    check("the clock is in the volatile half, not the stable one",
          "## Current date and time" in vol_a
          and "## Current date and time" not in stable_a)

    print("2. live state churning does not move the prefix either")
    stable_c, vol_c = await build(runner, clock=t1, entities=ents_b, events=ev_b)
    check("a changed automation status and a new capability event leave the "
          "stable half alone", stable_a == stable_c)
    check("...and both land in the volatile half",
          "last_status: failed" in vol_c and "fetch_url to ingestion" in vol_c)
    check("neither is in the stable half",
          "last_status" not in stable_a and "What changed recently" not in stable_a)

    print("3. what each half is actually made of")
    for block in ("## Model (live)", "## Platform facts (live)", "## Shapes",
                  "## MCP servers", "## Who you're speaking with (live)"):
        check(f"stable carries {block}", block in stable_a, stable_a[:60])
    for block in ("## Automations", "## Goals", "## What changed recently",
                  "## Relevant Memories", "## Applicable Skills",
                  "## Conversation so far", "## Current date and time",
                  "## Who I am", "## Your name", "## What you can actually do",
                  "## Register"):
        check(f"volatile carries {block}", block in vol_a, vol_a[:60])
    check("the agent's own prompt opens the stable half — ROLE is still first",
          stable_a.startswith(AGENT["system_prompt"]))
    check("the register is still the last word",
          vol_a.rstrip().endswith("never \"You're welcome! Is there anything "
                                  "else I can help you with today?\"."),
          vol_a[-70:])

    print("4. the prose the model reads is unchanged by the split")
    flat = runner._system_message(stable_a, vol_a, "ollama:qwen3:8b")
    check("a local model still gets ONE string",
          isinstance(flat["content"], str), type(flat["content"]).__name__)
    check("...joined exactly as the single-string version joined its parts",
          flat["content"] == stable_a + "\n\n" + vol_a)
    check("an automatic-caching provider gets the same flat string",
          runner._system_message(stable_a, vol_a,
                                 "openrouter:z-ai/glm-5.2")["content"]
          == flat["content"])

    print("5. a provider that must be TOLD gets exactly one breakpoint")
    split = runner._system_message(stable_a, vol_a,
                                   "openrouter:anthropic/claude-haiku-4.5")
    parts = split["content"]
    check("content becomes a 2-part block list",
          isinstance(parts, list) and len(parts) == 2, str(type(parts)))
    check("the breakpoint is on the FIRST part only",
          parts[0].get("cache_control") == {"type": "ephemeral"}
          and "cache_control" not in parts[1], json.dumps(parts[1])[:60])
    check("the two parts still concatenate to the same prose",
          parts[0]["text"] + parts[1]["text"] == flat["content"])

    print("6. who is asked to cache, and who is not")
    for model, want in (("ollama:ornith:9b", False),
                        ("ollama:qwen3:8b", False),
                        ("openrouter:z-ai/glm-5.2", False),
                        ("openrouter:openai/gpt-5", False),
                        ("openrouter:anthropic/claude-haiku-4.5", True),
                        ("openrouter:google/gemini-3-pro", True),
                        ("openrouter:qwen/qwen3-max", True)):
        check(f"{model} -> {want}",
              llm_router.supports_cache_control(model) is want)
    check("a bare name with no provider never gets a breakpoint",
          llm_router.supports_cache_control("qwen3:8b") is False)

    print("7. the mid-turn model swap survives the new shape")
    # the real block, so the regex has something of the right shape to find
    with stubbed(runner, clock=t1, entities=ents_a, events=ev_a):
        real_stable, real_vol = await runner._build_system_prompt(
            AGENT, "hi", include_index=False, speaker=None,
            tool_names=["web_search"])
    check("exactly one `## Model (live)` block, and it is in the stable half",
          real_stable.count("## Model (live)") == 1
          and "## Model (live)" not in real_vol)
    swapped = runner._swap_model_block(real_stable, AGENT, "ollama:qwen3:8b")
    check("swapping repoints it without touching anything else",
          "qwen3:8b" in swapped
          and swapped.count("## Model (live)") == 1
          and len(swapped.split("## Model (live)")[0])
          == len(real_stable.split("## Model (live)")[0]))
    rebuilt = runner._system_message(swapped, real_vol, "ollama:qwen3:8b")
    check("...and re-rendering after the swap gives a flat string for ollama",
          isinstance(rebuilt["content"], str) and "qwen3:8b" in rebuilt["content"])

    print("8. the trimmer prices both shapes the same")
    a = context_trim.estimate_tokens([flat])
    b = context_trim.estimate_tokens([split])
    check("a split system message is not cheaper to the trimmer",
          abs(a - b) <= 1, f"flat {a} vs split {b}")
    check("...and neither is free", a > 10, str(a))

    print("9. a half with nothing in it never becomes an empty block")
    only_stable = runner._system_message("just this", "",
                                         "openrouter:anthropic/claude-haiku-4.5")
    check("an empty volatile half falls back to the flat string",
          only_stable["content"] == "just this")


def main() -> int:
    asyncio.run(run())
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
