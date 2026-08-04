"""The standby order, and what may stand in for what.

    docker compose exec backend python tests/test_model_chain.py

`main` runs on a local model with no per-agent standby, and both remaining
links (the install-wide setting, the main agent's model) are also local. So
when ollama itself is unreachable every link is correctly refused as "on the
server that could not be reached", the chain returns nothing, and the agent
every chat turn uses dies — with capable cloud models configured and idle.

The fix is a fourth link derived from the other tier. Two properties matter
more than the ordering:

1. IT IS DERIVED, NOT LISTED. It reads the curated catalogue, provider health
   and what ollama has installed, so registering a provider or pulling a model
   changes the answer with no edit here. That is also why every test below
   injects its inputs: a derivation that reads live tables and is asserted
   against whatever the install happens to hold asserts nothing.

2. IT NEVER COSTS THE COMMON CASE. Eleven of twelve agents are cloud-primary
   and already reach a local standby through the install setting, so the
   derivation must short-circuit before probing for them.
"""

import asyncio
import sys

sys.path.insert(0, "/app/backend")

from app import model_chain as mc                          # noqa: E402
from app.llm import providers                              # noqa: E402
from app.llm import router as llm_router                   # noqa: E402

FAILURES: list[str] = []

CURATED = [
    {"model": "openrouter:anthropic/claude-haiku-4.5", "tool_tier": "A",
     "roles": ["chat", "tools"], "is_system": True},
    {"model": "openrouter:z-ai/glm-5.2", "tool_tier": "A",
     "roles": ["chat", "tools"], "is_system": True},
    {"model": "openrouter:someone/chat-only", "tool_tier": "B",
     "roles": ["chat"], "is_system": True},
    {"model": "openrouter:~anthropic/claude-opus-latest", "tool_tier": "C",
     "roles": [], "is_system": False},
    {"model": "ollama:qwen3:8b", "tool_tier": "B",
     "roles": ["chat", "tools"], "is_system": True},
]

LOCAL = [
    {"model": "ollama:qwen3:14b", "billions": 14.0, "capabilities": ["tools"]},
    {"model": "ollama:ornith:9b", "billions": 9.0, "capabilities": []},
    {"model": "ollama:qwen2.5:3b", "billions": 3.0, "capabilities": ["tools"]},
]

TOOLED = {"name": "main", "model": "ollama:ornith:9b", "allowed_tools": None}
TOOLLESS = {"name": "voice", "model": "ollama:ornith:9b", "allowed_tools": []}


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


async def main() -> int:
    saved = (llm_router.effective_model, providers.is_configured, providers.get)
    llm_router.effective_model = lambda m: m
    providers.is_configured = lambda slug: slug == "openrouter"
    providers.get = lambda slug: {"last_ok": True}
    try:
        print("1. a local agent crosses to the cloud")
        got = await mc.cross_tier_standby(TOOLED, curated=CURATED, local_rank=LOCAL)
        check("picks a tool-capable cloud model",
              got == "openrouter:anthropic/claude-haiku-4.5", str(got))
        check("never an operator pseudo-id — nothing says '~…-latest' resolves "
              "at the provider, and a standby that 404s consumes the last link",
              "~" not in str(got))

        print("2. a cloud agent crosses to local")
        got = await mc.cross_tier_standby(
            {"name": "ingestion", "model": "openrouter:z-ai/glm-5.2",
             "allowed_tools": None}, curated=CURATED, local_rank=LOCAL)
        check("largest TOOL-CAPABLE local model, not just the largest",
              got == "ollama:qwen3:14b", str(got))
        got = await mc.cross_tier_standby(
            {"name": "voice", "model": "openrouter:z-ai/glm-5.2",
             "allowed_tools": []}, curated=CURATED, local_rank=LOCAL)
        check("a tool-less agent may use the largest, tools or not",
              got == "ollama:qwen3:14b", str(got))

        print("3. what is refused")
        providers.get = lambda slug: {"last_ok": False}
        got = await mc.cross_tier_standby(TOOLED, curated=CURATED, local_rank=LOCAL)
        check("a provider already known to be down is not offered",
              got is None, str(got))
        providers.get = lambda slug: {"last_ok": None}
        got = await mc.cross_tier_standby(TOOLED, curated=CURATED, local_rank=LOCAL)
        check("never-checked (NULL) is allowed — unknown is not down",
              got == "openrouter:anthropic/claude-haiku-4.5", str(got))
        providers.get = lambda slug: {"last_ok": True}
        providers.is_configured = lambda slug: False
        got = await mc.cross_tier_standby(TOOLED, curated=CURATED, local_rank=LOCAL)
        check("an unconfigured provider is not offered", got is None, str(got))
        providers.is_configured = lambda slug: slug == "openrouter"

        got = await mc.cross_tier_standby(TOOLED, curated=[], local_rank=[])
        check("nothing available -> None, never an invented name",
              got is None, str(got))

        print("4. the chain, in order")
        chain = await mc.chain(
            {**TOOLED, "fallback_model": "ollama:qwen3:14b"},
            curated=CURATED, local_rank=LOCAL)
        check("the operator's own standby is first",
              chain[0]["model"] == "ollama:qwen3:14b"
              and chain[0]["source"] == mc.LINK_AGENT, str(chain[:1]))
        check("the derived link is LAST — below every operator choice",
              chain[-1]["source"] == mc.LINK_CROSS, str(chain[-1]))
        check("every link carries a reason the UI can show",
              all(link.get("why") for link in chain))
        check("an agent never stands by for itself",
              all(link["model"] != TOOLED["model"] for link in chain), str(chain))

        print("5. the short-circuit — the common case pays nothing")
        probed = False

        async def _spy(agent, **kw):
            nonlocal probed
            probed = True
            return "openrouter:z-ai/glm-5.2"
        real = mc.cross_tier_standby
        mc.cross_tier_standby = _spy
        try:
            # a cloud agent whose install-wide standby is already local
            await mc.chain({"name": "ingestion", "model": "openrouter:z-ai/glm-5.2",
                            "allowed_tools": None, "fallback_model": "ollama:qwen3:8b"},
                           curated=CURATED, local_rank=LOCAL)
            check("already crosses tiers -> no probe", not probed)
            probed = False
            await mc.chain({**TOOLED, "fallback_model": "ollama:qwen3:14b"},
                           curated=CURATED, local_rank=LOCAL)
            check("all-local chain -> it does probe", probed)
        finally:
            mc.cross_tier_standby = real

        print("6. a derivation never crashes a turn that is already failing")

        async def _boom():
            raise RuntimeError("curated table unreachable")
        saved_curated = mc._curated
        mc._curated = _boom
        try:
            got = await mc.cross_tier_standby(TOOLED)
            check("an exception becomes None, not a raise", got is None, str(got))
        finally:
            mc._curated = saved_curated

        print("7. one home for the rules")
        check("needs_tools: unrestricted (None) means every tool, not none",
              mc.needs_tools({"allowed_tools": None}) is True)
        check("needs_tools: an empty grant needs none",
              mc.needs_tools({"allowed_tools": []}) is False)
    finally:
        (llm_router.effective_model, providers.is_configured,
         providers.get) = saved

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
