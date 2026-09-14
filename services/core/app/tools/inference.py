"""Her own look at the card: what it has free, what is on it, how fast she
is actually generating.

## Why this is a tool and not just a beat check
CLAUDE.md's rule: when a task hits friction operating the running system,
the gap IS the capability. On 2026-09-12 a video game held ~7 GB of this
machine's GPU and pinned its shader cores for six hours. Two of the owner's
turns walled at the gateway's 300 s read limit, and Nova could not see that
the card was contended, could not say why her turn had failed beyond
quoting the timeout, and could not tell him what to close. The beat check
(app/checks/inference.py) tells HIM. This tells HER, in the turn where he
asks — which is the difference between a feature that looks shipped and one
that makes her able.

## One read, no arguments
The card and the resident table come from the gateway's /admin/vram (core
has no route to the GPU of its own); the throughput comes from the
`llm_call` spans this turn's own rounds are already filing. Nothing is
computed twice and nothing is cached, so the answer is about the moment she
was asked.

## It states, it never decides
`reads_only=True`. Every half degrades independently and says why: the card
can be readable while ollama is down, and the speed can be known while the
card is not. Absent is absent — a model with too little history has no
baseline, and the answer says so rather than inventing a normal for it.
"""

from __future__ import annotations

import httpx

from app import db, model_speed, peers, settings_store
from app.tools.base import Tool, ToolContext, ToolFailure

VRAM_PATH = "/admin/vram"
VRAM_TIMEOUT = httpx.Timeout(connect=5.0, read=15.0, write=5.0, pool=5.0)


def _gb(mb: float | None) -> str:
    return "unknown" if mb is None else f"{mb / 1024:.1f} GB"


def _card_lines(body: dict) -> list[str]:
    """The card itself, in words, with each unknown naming its own reason."""
    lines = []
    if body.get("total_mb") is None:
        return [f"The GPU could not be read — {body.get('reason') or 'no reason was given'}."]
    lines.append(
        f"The card has {_gb(body.get('free_mb'))} free of {_gb(body.get('total_mb'))} "
        f"({_gb(body.get('used_mb'))} in use by everything on the machine)."
    )
    resident = body.get("resident")
    if resident is None:
        lines.append(
            "What ollama is holding could not be read — "
            f"{body.get('resident_reason') or 'no reason was given'}."
        )
        return lines
    if not resident:
        lines.append("ollama has no model resident right now.")
    else:
        held = ", ".join(
            f"{entry.get('model')} ({_gb(entry.get('vram_mb'))})" for entry in resident
        )
        lines.append(f"ollama is holding: {held}.")
    if body.get("free_after_switch_gb") is not None:
        lines.append(
            f"A model loaded now would have about {body['free_after_switch_gb']:.1f} GB "
            "to work with, because switching evicts what ollama holds."
        )
    # The honest limit of the reading, stated rather than papered over. Under
    # WSL2 this container sees the card's totals and can name none of the
    # processes behind them — exactly the shape of the 2026-09-12 failure,
    # where the consumer was a Windows-side game.
    #
    # Stated FLATLY, with no threshold and no opinion. The desktop always
    # holds a couple of gigabytes and a game holds seven; no number
    # separates those two cases, and a guessed one would either cry wolf
    # every hour or stay quiet through the one case this exists for. The
    # figure is the fact; the throughput line below carries the alarm.
    if body.get("used_mb") is not None:
        held_mb = sum(entry.get("vram_mb") or 0 for entry in resident)
        others_mb = body["used_mb"] - held_mb
        if others_mb >= 256:
            lines.append(
                f"{_gb(others_mb)} is held by something other than ollama — this machine "
                "cannot see which process."
            )
    return lines


def _speed_lines(speed: model_speed.Speed, factor: int) -> list[str]:
    """The throughput picture for the model she is serving on."""
    if speed.recent is None:
        return [
            f"How fast {speed.model} is generating right now is not measured yet — "
            f"{speed.recent_rounds} round(s) in the last {model_speed.RECENT_HOURS} h, "
            f"and {model_speed.MIN_ROUNDS_RECENT} are needed before a median means anything."
        ]
    if speed.baseline is None:
        return [
            f"{speed.model} is generating at {speed.recent:g} tok/s. There is no baseline "
            f"to compare that against yet ({speed.baseline_rounds} round(s) on record, "
            f"{model_speed.MIN_ROUNDS_BASELINE} needed), so nothing can be said about "
            "whether it is normal."
        ]
    line = (
        f"{speed.model} is generating at {speed.recent:g} tok/s; its usual on this "
        f"machine is {speed.baseline:g} tok/s ({speed.ratio:g}x)."
    )
    if speed.ratio >= factor:
        return [line, "That is far below normal — something is contending for the GPU."]
    return [line]


async def inference_health(_args: dict, ctx: ToolContext) -> str:
    """The card, what is on it, and how fast this model is actually going."""
    pool = await db.get_pool()
    try:
        async with peers.client(ctx.app, peers.GATEWAY, VRAM_TIMEOUT) as client:
            resp = await client.get(VRAM_PATH)
            resp.raise_for_status()
    except (httpx.HTTPError, peers.PeerUnconfigured) as exc:
        # A stated refusal, in the Error: shape every tool uses when a call
        # CANNOT run. Not a guess about the card, and not a silent empty.
        raise ToolFailure(
            f"the gateway could not be asked about the GPU — {peers.reason(exc)}"
        ) from exc

    lines = _card_lines(resp.json())

    model = await settings_store.read_value(pool, "chat.model")
    if model:
        factor = await settings_store.read_value(pool, "inference.degraded_factor")
        lines.extend(_speed_lines(await model_speed.speed_of(pool, model), factor))
    else:
        lines.append("No chat model is configured, so there is no throughput to report.")

    return " ".join(lines)


TOOLS: tuple[Tool, ...] = (
    Tool(
        name="inference_health",
        description=(
            "How the GPU is doing right now: how much VRAM is free of the card's total, "
            "which models ollama is holding and how big they are, whether something "
            "other than ollama is using the card, and how fast the chat model is "
            "generating compared with its usual speed on this machine. Use it when a "
            "reply is taking a long time, when asked why things are slow, before "
            "starting something heavy, or when asked what is on the GPU."
        ),
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
        executor=inference_health,
        # A live, point-in-time reading. Recalling "the card had 21 GB free"
        # three weeks later and serving it as the present is exactly the lie
        # `ephemeral` exists to prevent.
        ephemeral=True,
        reads_only=True,
    ),
)
