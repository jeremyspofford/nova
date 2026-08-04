"""The prompt, the router and the honesty check must name the SAME model.

Three defects found 2026-07-28 while designing per-agent fallbacks, all in the
gap between "the model the operator bound" and "the model that generated":

  1. effective_model interpolated the local-fallback setting blind, so an
     EMPTY setting produced the model id "ollama:" — a name no provider can
     serve and the operator never chose.
  2. the `## Model (live)` block is rendered once per turn, but a round can be
     retried on another model afterwards. The prompt kept instructing her to
     name the model that had just failed, she obeyed, and model_claims then
     appended a correction accusing her of the claim the system told her to
     make — written into the reply and read aloud on voice turns.
  3. the swap parenthetical read "no OpenRouter key" for every provider, and
     said it of mid-turn reroutes too, where the key is fine.

    docker compose exec backend python tests/test_model_binding.py
"""

import sys

sys.path.insert(0, "/app/backend")

from app import model_claims, settings_store          # noqa: E402
from app.agents import runner                         # noqa: E402
from app.llm import providers, router as llm_router   # noqa: E402

FAILURES: list[str] = []

AGENT = {"id": "a1", "name": "main", "model": "openrouter:anthropic/claude-haiku-4.5",
         "system_prompt": "You are Nova.", "allowed_tools": None}


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def test_effective_model():
    print("1. effective_model never invents a model id")
    saved_cfg = providers.is_configured
    saved_cache = dict(settings_store._cache)
    providers.is_configured = lambda slug: False
    try:
        settings_store._cache["inference.local_fallback_model"] = ""
        out = llm_router.effective_model("openrouter:anthropic/claude-haiku-4.5")
        check("an unconfigured provider with NO fallback set leaves the model "
              "alone, so the error names the operator's real binding",
              out == "openrouter:anthropic/claude-haiku-4.5", out)
        check("...and never produces the unservable id 'ollama:'",
              out != "ollama:", out)

        settings_store._cache["inference.local_fallback_model"] = "qwen3:8b"
        out = llm_router.effective_model("openrouter:anthropic/claude-haiku-4.5")
        check("a bare local name gets the ollama prefix", out == "ollama:qwen3:8b", out)

        settings_store._cache["inference.local_fallback_model"] = "ollama:qwen3:8b"
        out = llm_router.effective_model("openrouter:anthropic/claude-haiku-4.5")
        check("an already-prefixed value is not doubled", out == "ollama:qwen3:8b", out)

        # a tag separator is not a provider prefix
        settings_store._cache["inference.local_fallback_model"] = "qwen2.5:3b"
        out = llm_router.effective_model("openrouter:anthropic/claude-haiku-4.5")
        check("a colon in the TAG is not read as a provider prefix",
              out == "ollama:qwen2.5:3b", out)
    finally:
        providers.is_configured = saved_cfg
        settings_store._cache.clear()
        settings_store._cache.update(saved_cache)

    print("2. a local model always passes through untouched")
    check("ollama ids are a fixed point",
          llm_router.effective_model("ollama:qwen3:8b") == "ollama:qwen3:8b")


def test_model_block_swap():
    print("3. the prompt follows a mid-turn reroute")
    saved = llm_router.effective_model
    llm_router.effective_model = lambda m: m
    try:
        block = runner._model_block(AGENT)
        check("the block names the bound model",
              "claude-haiku-4.5" in block, block.splitlines()[1])

        # the system prompt as assembled by _build_system_prompt: blocks
        # joined by a blank line, model block in the middle
        system = "\n\n".join(["You are Nova.", block,
                              "## Platform\nlinux", "## Date\n2026-07-28"])
        swapped = runner._swap_model_block(system, AGENT, "ollama:qwen3:8b")

        check("after the reroute the block names the model that will generate",
              "qwen3:8b" in swapped)
        # The old name must still appear ONCE, as the binding it moved off —
        # that is the honest sentence. What must not survive is the
        # INSTRUCTION to say it, which is the line she actually obeys.
        check("...and the say-this instruction names the new model",
              'I\'m running on qwen3:8b.' in swapped)
        check("...and no longer tells her to say the model that failed",
              'I\'m running on anthropic/claude-haiku-4.5.' not in swapped)
        check("the blocks around it survive",
              "## Platform" in swapped and "## Date" in swapped
              and swapped.startswith("You are Nova."))
        check("exactly one model block remains",
              swapped.count("## Model (live)") == 1)
        check("it names the binding it moved off, rather than guessing why",
              "openrouter:anthropic/claude-haiku-4.5" in swapped)
        check("a prompt with no model block is returned unchanged",
              runner._swap_model_block("## Date\n2026-07-28", AGENT,
                                       "ollama:qwen3:8b") == "## Date\n2026-07-28")

        print("4. ...so the honesty check stops accusing her of obeying it")
        # she answers with the bare model name, exactly as the block instructs
        spoken = swapped.split("## Model (live)\n")[1].split(" —")[0]
        reply = f"I'm running on {spoken}."
        check("the reply the swapped block asks for is graded HONEST against "
              "the model that really ran",
              model_claims.detect(reply, "ollama:qwen3:8b") is None,
              f"{spoken!r} vs ollama:qwen3:8b")
        # and the pre-fix behaviour is still caught: naming the dead model
        check("naming the model that failed is still caught",
              model_claims.detect("I'm running on claude-haiku-4.5.",
                                  "ollama:qwen3:8b") is not None)
    finally:
        llm_router.effective_model = saved


def main() -> int:
    test_effective_model()
    print()
    test_model_block_swap()
    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
