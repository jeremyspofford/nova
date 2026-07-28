"""Sizing a local model's context window from what actually fits.

    docker compose exec backend python tests/test_local_context.py

One setting, `inference.ollama_num_ctx`, was applied to every local model at
once. Measured on this box 2026-07-28, that single number was wrong in both
directions simultaneously: 16,384 gave `ornith:9b` 6% of the 262,144 it
supports, while raising it to suit that model would have overflowed a 14B's
KV cache — and ollama does not fail when the cache will not fit. It moves
part of the model into system RAM and answers slowly, with no error. So the
setting could not be right, and being wrong was invisible.

The properties that make measuring safe enough to leave on:

  1. NOTHING IS PREDICTED. The model's ceiling comes from /api/show, the
     weights from /api/tags, what is resident and whether it SPILLED from
     /api/ps, and total VRAM from the sidecar that already measures it. The
     KV cost per token — the one figure nobody publishes — is learned from a
     live load rather than assumed.
  2. IT FAILS TO THE OLD BEHAVIOUR. Every probe is optional. If the sidecar
     is down or ollama will not answer, this returns the operator's setting
     and behaves exactly as it did before.
  3. IT CHECKS AFTERWARDS. A window that spilled is a fact in /api/ps, not an
     inference, and the model's ceiling drops for next time. A wrong estimate
     costs one slow turn and corrects itself.
"""

import asyncio
import sys

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


async def run() -> None:
    from app import db, local_context, model_fitness, settings_store
    await db.init_pool()
    await settings_store.warm()

    saved = {k: settings_store._cache.get(k) for k in
             ("inference.dynamic_context", "inference.ollama_num_ctx")}
    saved_caps = model_fitness.local_capabilities
    saved_free = local_context._free_vram_bytes
    saved_set = local_context._explicitly_set
    saved_kv = local_context._kv_bytes_per_token

    async def caps(name):
        return {"context_length": 262144, "capabilities": ["tools"]}

    async def kv(name):
        return 100_000.0                     # 100KB per token

    async def never_set(key):
        return False

    try:
        model_fitness.local_capabilities = caps
        local_context._kv_bytes_per_token = kv
        local_context._explicitly_set = never_set
        settings_store._cache["inference.dynamic_context"] = True
        settings_store._cache["inference.ollama_num_ctx"] = 16384

        print("1. the window is bounded by what fits, not by one global number")
        local_context._cache.clear()

        async def free_2gb(for_model=None):
            return 2_000_000_000            # 2GB / 100KB = 20,000 tokens
        local_context._free_vram_bytes = free_2gb
        got = await local_context.resolve("ollama:big")
        check("a small card gets a small window — 2GB of KV at 100KB/token",
              got == 16384, str(got))

        local_context._cache.clear()

        async def free_20gb(for_model=None):
            return 20_000_000_000           # 200,000 tokens affordable
        local_context._free_vram_bytes = free_20gb
        got = await local_context.resolve("ollama:big")
        check("a large card gets far more than the old flat 16,384 — the "
              "whole point", got > 16384, str(got))
        check("...but never more than the model itself supports",
              got <= 262144, str(got))

        print("2. an untouched default is not a decision")
        check("the flat setting does NOT cap the result when the operator "
              "never chose it — otherwise the feature ships switched on and "
              "clamped to the number it exists to replace", got > 16384)

        local_context._cache.clear()

        async def is_set(key):
            return True
        local_context._explicitly_set = is_set
        got_capped = await local_context.resolve("ollama:big")
        check("...and DOES cap it once the operator has set it, so an "
              "explicit ceiling is still a guarantee",
              got_capped == 16384, str(got_capped))

        print("3. it fails to the old behaviour, never to a guess")
        local_context._cache.clear()
        local_context._explicitly_set = never_set

        async def no_gpu(for_model=None):
            return None
        local_context._free_vram_bytes = no_gpu
        check("no VRAM reading -> the operator's setting, exactly as before",
              await local_context.resolve("ollama:big") == 16384)

        local_context._free_vram_bytes = free_20gb
        local_context._cache.clear()

        async def no_caps(name):
            return {}
        model_fitness.local_capabilities = no_caps
        check("no model ceiling -> the setting again",
              await local_context.resolve("ollama:big") == 16384)
        model_fitness.local_capabilities = caps

        print("4. the switch, and non-local models")
        local_context._cache.clear()
        settings_store._cache["inference.dynamic_context"] = False
        check("turned off, it is the flat setting and nothing else",
              await local_context.resolve("ollama:big") == 16384)
        settings_store._cache["inference.dynamic_context"] = True
        check("a cloud model is not ours to size",
              await local_context.resolve("openrouter:anything") is None)

        print("5. a spill lowers the ceiling — the part that makes it safe")
        local_context._cache.clear()
        local_context._ceiling.clear()

        async def spilled():
            return [{"name": "big", "size": 20_000_000_000,
                     "size_vram": 12_000_000_000}]
        saved_resident = local_context._resident
        local_context._resident = spilled
        try:
            local_context._cache["big"] = (float("inf"), 40960)
            await local_context.note_spill("ollama:big")
            check("a model whose weights did not all reach the GPU is "
                  "recorded — ollama reports this and never errors",
                  local_context._ceiling.get("big") is not None,
                  str(local_context._ceiling))
            check("...and the recorded ceiling is BELOW what was tried",
                  local_context._ceiling["big"] < 40960,
                  str(local_context._ceiling.get("big")))

            async def fitted():
                return [{"name": "big", "size": 12_000_000_000,
                         "size_vram": 12_000_000_000}]
            local_context._resident = fitted
            local_context._ceiling.clear()
            await local_context.note_spill("ollama:big")
            check("a model that fitted entirely on the GPU is left alone",
                  "big" not in local_context._ceiling)
        finally:
            local_context._resident = saved_resident

        print("6. the floor")
        local_context._cache.clear()
        local_context._ceiling.clear()

        async def free_tiny(for_model=None):
            return 1_000_000               # 10 tokens' worth
        local_context._free_vram_bytes = free_tiny
        got = await local_context.resolve("ollama:big")
        check("a window too small to hold the system prompt is never chosen — "
              "ollama truncates from the HEAD, so the agent would silently "
              "lose its role and its tool contract",
              got >= local_context._FLOOR, str(got))
    finally:
        model_fitness.local_capabilities = saved_caps
        local_context._free_vram_bytes = saved_free
        local_context._explicitly_set = saved_set
        local_context._kv_bytes_per_token = saved_kv
        local_context._cache.clear()
        local_context._ceiling.clear()
        for k, v in saved.items():
            if v is not None:
                settings_store._cache[k] = v
        await db.close_pool()


def main() -> int:
    asyncio.run(run())
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
