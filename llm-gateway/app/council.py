"""Council mode — Mixture-of-Agents across the endpoint pool.

Several models answer in parallel (proposers), then the strongest available
model chairs: it synthesizes one answer, preferring claims the proposals agree
on and flagging what it can't verify. Trades wall-clock time for quality —
always opt-in, always capped, cost always reported in the response metadata.

Proposers are local-pool models picked by manifest scores (agent + reasoning),
de-duplicated across endpoints; when the pool can't field enough distinct
models, the configured completion model fills remaining seats with temperature
jitter (self-consistency — still better than single-shot).
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import litellm

from . import endpoints as ep_mod
from . import selector
from .config import settings
from .discovery import discover_endpoint_models
from .manifest import get_manifest

logger = logging.getLogger(__name__)

PROPOSAL_TIMEOUT_S = 120.0
JITTER_TEMPS = [0.4, 0.8, 1.0, 0.6, 0.9]

CHAIR_INSTRUCTIONS = (
    "You are the chair of a council. Above is a request, and below are candidate "
    "answers from several council members. Synthesize the single strongest answer:\n"
    "- Prefer claims that multiple members agree on.\n"
    "- Where members disagree, resolve the disagreement explicitly and briefly.\n"
    "- Do not introduce claims that appear in no member's answer; if you must note "
    "uncertainty, mark it as unverified.\n"
    "- Output ONLY the final answer — no preamble about the council or the process."
)


class CouncilUnavailable(Exception):
    """No proposers could run — caller should fall back to a standard completion."""


def _score(entry: dict) -> int:
    s = entry.get("scores") or {}
    return int(s.get("agent", 0)) + int(s.get("reasoning", 0))


async def select_proposers(n: int) -> list[dict]:
    """Top-n distinct manifest-scored models across routable endpoints.

    Returns [{model, kwargs, endpoint, temperature}], best first. Seats the pool
    can't fill with distinct models are filled by the configured completion
    model with temperature jitter.
    """
    n = max(1, min(n, 5))
    manifest = await get_manifest()
    scored = {
        (e.get("ollama_id") or "").removesuffix(":latest"): _score(e)
        for e in manifest.get("models", [])
        if not e.get("cloud") and e.get("ollama_id") and "completion" in (e.get("roles") or [])
    }

    ranked: list[tuple[int, str, dict]] = []
    seen_models: set[str] = set()
    for ep in ep_mod.routable():
        for m in await discover_endpoint_models(ep):
            mid = m["id"]
            if mid in seen_models or mid not in scored:
                continue
            seen_models.add(mid)
            ranked.append((scored[mid], mid, ep))
    ranked.sort(key=lambda t: t[0], reverse=True)

    out: list[dict] = []
    for score, mid, ep in ranked[:n]:
        litellm_model, kwargs = selector.endpoint_candidate(ep, mid)
        out.append({"model": mid, "litellm": litellm_model, "kwargs": kwargs,
                    "endpoint": ep["id"], "temperature": 0.7})

    # Fill remaining seats with the configured model + jitter.
    fallback = selector.local_candidates()
    if not fallback:
        if out:
            fallback = [(out[0]["litellm"], out[0]["kwargs"])]
        else:
            raise CouncilUnavailable("no routable local endpoints")
    fb_litellm, fb_kwargs = fallback[0]
    fb_model = fb_litellm.removeprefix("openai/")
    i = 0
    while len(out) < n:
        out.append({"model": fb_model, "litellm": fb_litellm, "kwargs": fb_kwargs,
                    "endpoint": ep_mod.routable()[0]["id"] if ep_mod.routable() else "default",
                    "temperature": JITTER_TEMPS[i % len(JITTER_TEMPS)]})
        i += 1
    return out


async def _propose(p: dict, messages: list[dict], max_tokens: int, budget_s: float) -> dict:
    started = time.monotonic()
    try:
        resp = await asyncio.wait_for(
            litellm.acompletion(
                model=p["litellm"], messages=messages, max_tokens=max_tokens,
                temperature=p["temperature"], **p["kwargs"],
            ),
            timeout=min(budget_s, PROPOSAL_TIMEOUT_S),
        )
        text = resp.choices[0].message.content or ""
        tokens = (resp.usage.completion_tokens or 0) + (resp.usage.prompt_tokens or 0) if resp.usage else 0
        return {"model": p["model"], "endpoint": p["endpoint"], "ok": bool(text.strip()),
                "text": text, "tokens": tokens,
                "elapsed_s": round(time.monotonic() - started, 1)}
    except Exception as exc:
        logger.warning("council proposer %s failed: %s", p["model"], exc)
        return {"model": p["model"], "endpoint": p["endpoint"], "ok": False, "text": "",
                "tokens": 0, "elapsed_s": round(time.monotonic() - started, 1)}


async def run_council(
    messages: list[dict],
    max_tokens: int,
    seed_proposal: str | None = None,
) -> tuple[str, dict[str, Any]]:
    """(final_text, metadata). Raises CouncilUnavailable when nothing can run."""
    started = time.monotonic()
    deadline = started + settings.council_wall_s

    proposers = await select_proposers(settings.council_proposers)
    sem = asyncio.Semaphore(max(1, settings.council_parallel))

    async def _bounded(p: dict) -> dict:
        async with sem:
            return await _propose(p, messages, max_tokens, deadline - time.monotonic())

    results = await asyncio.gather(*[_bounded(p) for p in proposers])

    proposals = [r["text"] for r in results if r["ok"]]
    labels = [f"{r['model']}@{r['endpoint']}" for r in results if r["ok"]]
    if seed_proposal and seed_proposal.strip():
        proposals.insert(0, seed_proposal)
        labels.insert(0, "draft (live assistant with tool access)")
    if not proposals:
        raise CouncilUnavailable("all proposers failed")

    total_tokens = sum(r["tokens"] for r in results)
    meta: dict[str, Any] = {
        "mode": "council",
        "proposers": [{k: r[k] for k in ("model", "endpoint", "ok", "elapsed_s")} for r in results],
        "seeded": bool(seed_proposal),
        "capped": False,
    }

    # Aggregation — the best-ranked proposer chairs. If the wall clock is spent,
    # return the best available proposal instead of erroring.
    chair = proposers[0]
    remaining = deadline - time.monotonic()
    if remaining < 10 or len(proposals) == 1:
        meta["capped"] = remaining < 10
        meta["aggregator"] = None
        meta["elapsed_s"] = round(time.monotonic() - started, 1)
        meta["total_tokens"] = total_tokens
        return proposals[0], meta

    block = "\n\n".join(
        f"--- Council member {i + 1} ({label}) ---\n{text}"
        for i, (label, text) in enumerate(zip(labels, proposals))
    )
    chair_messages = list(messages) + [
        {"role": "user", "content": f"{CHAIR_INSTRUCTIONS}\n\n{block}"}
    ]
    try:
        resp = await asyncio.wait_for(
            litellm.acompletion(
                model=chair["litellm"], messages=chair_messages,
                max_tokens=max_tokens, temperature=0.2, **chair["kwargs"],
            ),
            timeout=min(remaining, PROPOSAL_TIMEOUT_S),
        )
        final = resp.choices[0].message.content or proposals[0]
        if resp.usage:
            total_tokens += (resp.usage.completion_tokens or 0) + (resp.usage.prompt_tokens or 0)
        meta["aggregator"] = chair["model"]
    except Exception as exc:
        logger.warning("council aggregation failed (%s) — best proposal wins", exc)
        final = proposals[0]
        meta["aggregator"] = None
        meta["capped"] = True

    meta["elapsed_s"] = round(time.monotonic() - started, 1)
    meta["total_tokens"] = total_tokens
    return final, meta
