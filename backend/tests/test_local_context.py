"""Sizing a local model's context window from what actually fits — and from
what is actually asked for.

    docker compose exec backend python tests/test_local_context.py

One setting, `inference.ollama_num_ctx`, was applied to every local model at
once, until it was DELETED on 2026-07-31 along with its on/off switch and the
OLLAMA_CONTEXT_LENGTH pin in compose. Measured on this box 2026-07-28, that
single number was wrong in both directions simultaneously: 16,384 gave
`ornith:9b` 6% of the 262,144 it supports, while raising it to suit that model would have overflowed a 14B's
KV cache — and ollama does not fail when the cache will not fit. It moves
part of the model into system RAM and answers slowly, with no error. So the
setting could not be right, and being wrong was invisible.

Measuring capacity alone was not enough either, and 2026-08-03 15:49 is the
proof: `ornith:9b` sat resident at a 262,144 window holding 14.2 GB — against
a measured 30-day peak demand of 11,971 tokens — and `qwen3:8b` was then sized
against the 5.2 GB left over, floored at 8,192, and its turn died with
`prompt_too_long` at 10,303 tokens. Both halves of that are defects: memory
held by another OLLAMA model is claimable (ollama evicts to fit the next
load), and a model that has never been asked for more than 12k tokens should
never have taken 262,144 in the first place.

The properties that make measuring safe enough to leave on:

  1. NOTHING IS PREDICTED. The model's ceiling comes from /api/show, the
     weights from /api/tags, what is resident and whether it SPILLED from
     /api/ps, total VRAM from the sidecar that already measures it, and
     DEMAND from the turn ledger this system already writes. The KV cost per
     token is COMPUTED from the attention shape the model file publishes —
     section 0 pins that arithmetic against ollama's own allocations.
  2. UNMEASURABLE IS None, NOT A GUESS. Every probe is optional. If the
     sidecar is down or ollama will not answer, nothing is sent and ollama
     picks — there is no setting left to fall back to, and that is the
     point: one source of truth cannot have a second one for bad days.
  3. DEMAND ROUNDS UP, CAPACITY ROUNDS DOWN. Asking for less than the model
     is known to need is the refusal this module exists to avoid; promising
     more memory than exists is the spill it exists to avoid.
  4. IT CHECKS AFTERWARDS, AND RECOVERS. A window that spilled is a fact in
     /api/ps, and the model's ceiling drops for next time — for half an hour,
     not forever, because the pressure that caused a spill is exactly the
     kind of thing that goes away.
  5. IT ONLY EVER ASKS FOR A RUNG. Changing the window restarts llama-server
     (measured: 4.91s cold, 0.39s when the value repeats), so the reachable
     values are few and far apart on purpose.
"""

import asyncio
import sys

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def vram(*, claimable, foreign=0, ollama_held=0):
    """A /gpu-stats reading whose claimable pool is exactly `claimable`."""
    from app import local_context as lc
    total = int(claimable + foreign + lc._RESERVE_GB * lc._GIB)

    async def _reading():
        return {"total": total, "used": foreign + ollama_held,
                "ollama_held": ollama_held, "foreign": foreign}
    return _reading


async def run() -> None:
    from app import db, local_context, model_fitness, settings_store
    await db.init_pool()
    await settings_store.warm()

    saved_caps = model_fitness.local_capabilities
    saved_vram = local_context._vram
    saved_kv = local_context._kv_bytes_per_token
    saved_weights = local_context._weights_bytes
    saved_demand = local_context._demand_tokens

    async def caps(name):
        return {"context_length": 262144, "capabilities": ["tools"]}

    async def kv(name):
        return 100_000.0                     # 100KB per token

    async def weights_5gb(name):
        return 5_000_000_000            # weights live in the SAME VRAM

    async def no_demand(model):
        return 0

    def demand_of(n):
        async def _d(model):
            return n
        return _d

    try:
        print("0. the KV cost is arithmetic, not a guess")
        # Every expectation below is ollama's OWN allocation, read from
        # `llama_kv_cache: size = ...` in the container log. If this section
        # fails, the formula has drifted from what ollama actually does.
        MiB = 1024 * 1024
        for label, info, per_token, cells, mib in (
            ("ornith:9b — a HYBRID: 32 blocks, only 32/4 cache",
             {"general.architecture": "qwen35", "qwen35.block_count": 32,
              "qwen35.full_attention_interval": 4,
              "qwen35.attention.head_count_kv": 4,
              "qwen35.attention.key_length": 256,
              "qwen35.attention.value_length": 256}, 32_768, 262_144, 8192),
            ("qwen3:8b — every block caches",
             {"general.architecture": "qwen3", "qwen3.block_count": 36,
              "qwen3.attention.head_count_kv": 8,
              "qwen3.attention.key_length": 128,
              "qwen3.attention.value_length": 128}, 147_456, 40_960, 5760),
            ("qwen3:14b — 40 blocks",
             {"general.architecture": "qwen3", "qwen3.block_count": 40,
              "qwen3.attention.head_count_kv": 8,
              "qwen3.attention.key_length": 128,
              "qwen3.attention.value_length": 128}, 163_840, 16_384, 2560),
            ("qwen2.5:3b — publishes NO head dims; 2048/16 = 128",
             {"general.architecture": "qwen2", "qwen2.block_count": 36,
              "qwen2.attention.head_count_kv": 2,
              "qwen2.embedding_length": 2048,
              "qwen2.attention.head_count": 16}, 36_864, 16_384, 576),
        ):
            got_per = local_context._kv_bytes_from_info(info)
            check(label, got_per == per_token, f"{got_per} != {per_token}")
            check(f"    ...and {cells} cells is the {mib} MiB ollama logged",
                  got_per and got_per * cells == mib * MiB,
                  str((got_per or 0) * cells / MiB))
        check("an architecture that says nothing gets no number, so the "
              "pessimistic default applies rather than a made-up one",
              local_context._kv_bytes_from_info({}) is None)
        check("...and a partial one does too",
              local_context._kv_bytes_from_info(
                  {"general.architecture": "mystery",
                   "mystery.block_count": 32}) is None)

        model_fitness.local_capabilities = caps
        local_context._kv_bytes_per_token = kv
        local_context._weights_bytes = weights_5gb
        # capacity is what sections 1-6 are about; demand has no opinion here
        local_context._demand_tokens = no_demand

        print("1. the window is bounded by what fits, not by one global number")
        local_context._cache.clear()
        local_context._vram = vram(claimable=2_000_000_000)
        got = await local_context.resolve("ollama:big")
        check("a card with less claimable VRAM than the weights need gets the "
              "floor, not a window computed as though the weights were free",
              got == local_context._FLOOR, str(got))

        local_context._cache.clear()
        local_context._vram = vram(claimable=20_000_000_000)
        got = await local_context.resolve("ollama:big")
        check("a large card gets far more than the old flat 16,384 — the "
              "whole point", got > 16384, str(got))
        check("...but never more than the model itself supports",
              got <= 262144, str(got))
        check("...and it is always a RUNG, never a close fit, because every "
              "distinct value restarts llama-server",
              got in (local_context._FLOOR, *local_context._LADDER, 262144),
              str(got))

        print("1b. the weights are counted, not handed to the KV cache")
        # 14GB claimable, 100KB/token, 5GB of weights. Treating the whole pool
        # as KV budget — which is what this did — makes 131,072 look
        # affordable. Actually loading it would want 13.1GB of KV PLUS the 5GB
        # of weights in the same 14GB, and ollama does not refuse: it spills
        # to system RAM and answers slowly. So the weights have to come off
        # the top, and the honest answer is a rung lower.
        local_context._vram = vram(claimable=14_000_000_000)

        async def weights_none(name):
            return 0
        local_context._cache.clear()
        local_context._weights_bytes = weights_none
        got_free = await local_context.resolve("ollama:big")
        local_context._cache.clear()
        local_context._weights_bytes = weights_5gb
        got_heavy = await local_context.resolve("ollama:big")
        check("5GB of weights buys a smaller window than none does",
              got_heavy < got_free, f"{got_heavy} vs {got_free}")
        check("...and the window it does buy actually fits beside them",
              got_heavy * 100_000 + 5_000_000_000 <= 14_000_000_000,
              f"{(got_heavy * 100_000 + 5_000_000_000) / 1e9:.1f}GB of 14GB")
        check("...where the old arithmetic would have overcommitted",
              got_free * 100_000 + 5_000_000_000 > 14_000_000_000,
              f"{(got_free * 100_000 + 5_000_000_000) / 1e9:.1f}GB of 14GB")
        local_context._vram = vram(claimable=20_000_000_000)

        print("2. there is nothing to disagree with")
        # `inference.ollama_num_ctx` and `inference.dynamic_context` were
        # deleted 2026-07-31. A typed number beside a measurement is two
        # sources of truth for one value, and the stale one wins silently.
        from app import settings_store as ss
        for gone in ("inference.ollama_num_ctx", "inference.dynamic_context"):
            raised = False
            try:
                ss.get(gone)
            except KeyError:
                raised = True
            check(f"{gone} no longer exists, so nothing can read it", raised)
        check("...and it is gone from the Settings UI too, which renders "
              "from the same definitions",
              not any(d["key"].startswith("inference.ollama_num_ctx")
                      or d["key"] == "inference.dynamic_context"
                      for d in ss.all_settings()))

        print("3. unmeasurable is None, never a guess")
        local_context._cache.clear()

        async def no_gpu():
            return None
        local_context._vram = no_gpu
        check("no VRAM reading -> None, so ollama chooses rather than Nova "
              "sending a number it did not measure",
              await local_context.resolve("ollama:big") is None)

        local_context._vram = vram(claimable=20_000_000_000)
        local_context._cache.clear()

        async def no_caps(name):
            return {}
        model_fitness.local_capabilities = no_caps
        check("no model ceiling -> None again",
              await local_context.resolve("ollama:big") is None)
        model_fitness.local_capabilities = caps

        print("4. the refusal still gets a real number")
        # resolve() returning None is fine to SEND — ollama picks. It is not
        # fine to REFUSE against, because an oversized prompt is truncated
        # from the front, taking the system prompt. So ask ollama what it
        # actually loaded rather than inventing a fallback.
        local_context._cache.clear()
        local_context._vram = no_gpu
        saved_res = local_context._resident

        async def loaded_at_32k():
            return [{"name": "big", "context_length": 32768,
                     "size": 1, "size_vram": 1}]
        local_context._resident = loaded_at_32k
        try:
            check("nothing sized, but something resident -> the window ollama "
                  "reports it loaded",
                  await local_context.effective_window("ollama:big") == 32768,
                  str(await local_context.effective_window("ollama:big")))

            async def nothing():
                return []
            local_context._resident = nothing
            check("nothing sized and nothing resident -> None, because no one "
                  "anywhere knows and a guess is the old bug",
                  await local_context.effective_window("ollama:big") is None)
        finally:
            local_context._resident = saved_res
            local_context._vram = vram(claimable=20_000_000_000)
            local_context._cache.clear()
        check("a cloud model is not ours to size",
              await local_context.resolve("openrouter:anything") is None)

        print("5. a spill lowers the ceiling — and lets it back up")
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
                  local_context._spill_pin("big") is not None,
                  str(local_context._ceiling))
            check("...and the recorded ceiling is BELOW what was tried",
                  local_context._spill_pin("big") < 40960,
                  str(local_context._spill_pin("big")))
            check("...and it is the next rung down, so the reload it costs "
                  "buys a window we can keep",
                  local_context._spill_pin("big") in local_context._LADDER,
                  str(local_context._spill_pin("big")))

            # THE RATCHET USED TO BE PERMANENT. `_ceiling` was written once and
            # never cleared, so one spill under transient pressure — a game, a
            # second model mid-load — held the model a rung low until the
            # backend restarted, with nothing saying why it never came back.
            import time as _time
            local_context._ceiling["big"] = (_time.monotonic() - 1, 8192)
            check("an EXPIRED spill ceiling is dropped, so the window can "
                  "recover on its own",
                  local_context._spill_pin("big") is None
                  and "big" not in local_context._ceiling)

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
        local_context._vram = vram(claimable=1_000_000)     # 10 tokens' worth
        got = await local_context.resolve("ollama:big")
        check("a window too small to hold the system prompt is never chosen — "
              "ollama truncates from the HEAD, so the agent would silently "
              "lose its role and its tool contract",
              got >= local_context._FLOOR, str(got))

        print("7. VRAM held by ANOTHER ollama model is claimable — 15:49")
        # The measured failure. ornith:9b was resident at a 262,144 window
        # (14.2 GB) when qwen3:8b was sized; the sizer counted all of it as
        # gone, floored qwen3:8b at 8,192, and the turn died. Ollama's
        # scheduler EVICTS a resident runner to fit the next one, so that
        # memory was always available — unlike whisper's and kokoro's, which
        # is not ollama's to take.
        local_context._cache.clear()
        local_context._ceiling.clear()
        local_context._weights_bytes = weights_none
        local_context._vram = vram(claimable=20_000_000_000,
                                   ollama_held=14_200_000_000)
        with_sibling = await local_context.resolve("ollama:big")
        local_context._cache.clear()
        local_context._vram = vram(claimable=20_000_000_000)
        alone = await local_context.resolve("ollama:big")
        check("a resident sibling does not shrink the next model's window",
              with_sibling == alone, f"{with_sibling} vs {alone}")
        local_context._cache.clear()
        local_context._vram = vram(claimable=20_000_000_000 - 14_200_000_000,
                                   foreign=14_200_000_000)
        with_foreign = await local_context.resolve("ollama:big")
        check("...but memory held OUTSIDE ollama does, because nothing here "
              "can evict a game or the speech stack",
              with_foreign < alone, f"{with_foreign} vs {alone}")
        local_context._weights_bytes = weights_5gb

        print("8. GiB is not GB — the 7.3% of a 3090 that did not exist")
        # nvidia-smi reports MiB; the sidecar divides by 1024 and labels the
        # result `mem_total_gb`. Multiplying that by 1e9 read a 24576 MiB card
        # as 24.0e9 bytes when it is 25.77e9.
        saved_settings_url = None
        try:
            import httpx
            from app.config import settings as _settings

            class _Resp:
                @staticmethod
                def raise_for_status():
                    return None

                @staticmethod
                def json():
                    return {"gpus": [{"mem_total_gb": 24.0, "mem_used_gb": 0.0}]}

            class _Client:
                def __init__(self, **kw):
                    pass

                async def __aenter__(self):
                    return self

                async def __aexit__(self, *a):
                    return False

                async def get(self, url):
                    return _Resp()

            saved_client = httpx.AsyncClient
            saved_resident2 = local_context._resident

            async def none_resident():
                return []
            local_context._resident = none_resident
            httpx.AsyncClient = _Client
            local_context._vram = saved_vram      # the real one, stubbed HTTP
            try:
                reading = await local_context._vram()
            finally:
                httpx.AsyncClient = saved_client
                local_context._resident = saved_resident2
            check("a card reporting 24576 MiB is 25.77e9 bytes, not 24.0e9",
                  reading and abs(reading["total"] - 25_769_803_776) < 1_000_000,
                  str(reading))
            check("...and the claimable pool takes the reserve off in the "
                  "same units",
                  reading and local_context._claimable(reading)
                  == reading["total"] - int(local_context._RESERVE_GB
                                            * local_context._GIB),
                  str(local_context._claimable(reading)))
        finally:
            _ = saved_settings_url
            local_context._vram = vram(claimable=20_000_000_000)

        print("9. demand rounds UP, capacity rounds DOWN")
        from app.agents import context_trim
        for demand, ceiling in ((0, 262144), (5_000, None), (12_788, None)):
            rung = local_context._want_rung(demand, 262144)
            if demand == 0:
                check("no reading means no demand-side opinion, so capacity "
                      "decides alone", rung == 262144, str(rung))
                continue
            usable = max(2000, rung - context_trim._COMPLETION_HEADROOM)
            check(f"a demand of {demand:,} is HELD by the rung chosen ({rung:,})",
                  usable >= demand + context_trim.history_budget_at(usable),
                  f"{usable} vs {demand}+{context_trim.history_budget_at(usable)}")
            lower = max([r for r in local_context._LADDER if r < rung],
                        default=None)
            if lower:
                low_usable = max(2000, lower - context_trim._COMPLETION_HEADROOM)
                check(f"...and the rung below ({lower:,}) genuinely would not",
                      low_usable < demand + context_trim.history_budget_at(low_usable))
        check("a model asked for 12,788 tokens never takes 262,144 — that is "
              "the 250,000 tokens of KV cache that starved the next model",
              local_context._want_rung(12_788, 262144) < 262144,
              str(local_context._want_rung(12_788, 262144)))
        check("demand above every rung lands on the model's own ceiling",
              local_context._want_rung(500_000, 262144) == 262144)

        print("9b. ...and the smaller of the two wins")
        local_context._cache.clear()
        local_context._weights_bytes = weights_none
        local_context._vram = vram(claimable=200_000_000_000)   # capacity: huge
        local_context._demand_tokens = demand_of(5_000)
        got = await local_context.resolve("ollama:big")
        check("plenty of VRAM but little demand -> the demand answer",
              got == local_context._want_rung(5_000, 262144), str(got))
        local_context._cache.clear()
        local_context._vram = vram(claimable=1_500_000_000)     # capacity: tight
        got = await local_context.resolve("ollama:big")
        check("little VRAM and modest demand -> the capacity answer, lower",
              got < local_context._want_rung(5_000, 262144), str(got))
        local_context._demand_tokens = no_demand
        local_context._weights_bytes = weights_5gb

        print("10. a starved answer is re-checked sooner than a settled one")
        import time as _t
        local_context._cache.clear()
        local_context._weights_bytes = weights_none
        local_context._vram = vram(claimable=200_000_000_000)
        local_context._demand_tokens = demand_of(5_000)
        await local_context.resolve("ollama:big")
        settled = local_context._cache["big"][0] - _t.monotonic()
        local_context._cache.clear()
        local_context._vram = vram(claimable=1_500_000_000)
        await local_context.resolve("ollama:big")
        starved = local_context._cache["big"][0] - _t.monotonic()
        check("a window the card forced is re-derived within a minute, where "
              "a window the model chose is kept for fifteen",
              starved < settled and starved <= local_context._TTL_TIGHT_S + 1,
              f"starved {starved:.0f}s vs settled {settled:.0f}s")

        # A fresh install has no demand readings at all, and calling every
        # model starved there is a warning that fires when nothing is wrong.
        local_context._cache.clear()
        local_context._demand_tokens = no_demand
        local_context._vram = vram(claimable=2_500_000_000)
        await local_context.resolve("ollama:big")
        blind = local_context._cache["big"][0] - _t.monotonic()
        check("with NO demand reading, a small window is not 'starved' — "
              "there is nothing it is short OF",
              blind > local_context._TTL_TIGHT_S + 1, f"{blind:.0f}s")
    finally:
        model_fitness.local_capabilities = saved_caps
        local_context._vram = saved_vram
        local_context._kv_bytes_per_token = saved_kv
        local_context._weights_bytes = saved_weights
        local_context._demand_tokens = saved_demand
        local_context._cache.clear()
        local_context._kv_cost.clear()
        local_context._ceiling.clear()
        local_context._demand.clear()
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
