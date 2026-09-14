"""The card, read at the moment of the question.

One `nvidia-smi` call, no file, no cache, no "since install". Everything
that wants to know what the GPU has answers from here.

## Why this module exists at all
`data/hardware.json` is written once by install.sh and never refreshed, and
until this slice it was the ONLY source of total VRAM in a live fit
decision. Free VRAM was worse: `fit.free_vram_gb_for_switch` subtracted
only entries flagged `swappable: False`, and its own docstring admitted
nothing in the system ever produced one — so free was identically total,
forever, and could not move.

On 2026-09-12 the owner played a video game on this machine. It held ~7 GB
of VRAM and pinned the shader cores at 347 W for about six hours. Two of
his chat turns timed out at the gateway's 300 s read limit, an eval suite
scored zero of twenty-three cases, and the strongest thing the product
could say about the card was a badge reading "tight fit — ~22/24 GB": a
number nobody had measured, derived from a file written weeks earlier.
Free VRAM read 24 GB the entire time.

His ruling that day, verbatim: "Nova should do the work ad-hoc to get the
resources live, not read stale shit."

## The single-card assumption, stated
ollama does not shard a model across cards, so the card that matters is the
biggest single one — the same assumption `suggest.largest_single_gpu_vram_gb`
already makes. `read_vram` therefore reports ONE card's numbers (the one
with the most total memory), never a sum across cards. A multi-GPU host
where a model lands on a different card than the biggest is not solved
here, and was not solved before either.

## What this reading can and cannot see
`memory.used` is the whole card at one instant: the desktop compositor,
every resident model, any other process on the machine. Under WSL2 it
cannot ATTRIBUTE that usage — a Windows-side consumer shows up in the
totals and in no process list this container can read. That is a limit
worth stating rather than papering over: the number is trustworthy, the
blame is not. Which is exactly why the caller pairs it with ollama's own
per-model `/api/ps` reading, the one number on this host that IS
attributable.
"""

from __future__ import annotations

import asyncio
import logging

logger = logging.getLogger("gateway")

# nvidia-smi answers in well under a second on every host this has ever run
# on; bounded generously anyway so a wedged driver cannot hang a request.
NVIDIA_SMI_TIMEOUT_S = 10.0

_QUERY = "memory.total,memory.used,memory.free"


class Vram:
    """One card's live memory, in MiB, or an honest reason it is unknown.

    A degraded reading is `total_mb is None` WITH a `reason` — never zeros,
    never a stale number kept warm from a previous call. Callers that must
    answer "unknown" have a sentence to answer it with.
    """

    __slots__ = ("total_mb", "used_mb", "free_mb", "reason")

    def __init__(
        self,
        total_mb: float | None = None,
        used_mb: float | None = None,
        free_mb: float | None = None,
        reason: str | None = None,
    ) -> None:
        self.total_mb = total_mb
        self.used_mb = used_mb
        self.free_mb = free_mb
        self.reason = reason

    @property
    def known(self) -> bool:
        return self.total_mb is not None and self.free_mb is not None

    def as_dict(self) -> dict:
        return {
            "total_mb": self.total_mb,
            "used_mb": self.used_mb,
            "free_mb": self.free_mb,
            "reason": self.reason,
        }

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"Vram({self.as_dict()})"


def parse(stdout: str) -> Vram:
    """The biggest single card out of nvidia-smi's CSV lines.

    Pure, so the parsing is testable without a GPU. A line that does not
    carry three numbers is skipped rather than crashing the read — a driver
    that prints `[N/A]` for one field on one card must not take out the
    reading for a card that answered properly.
    """
    best: tuple[float, float, float] | None = None
    for line in stdout.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) != 3:
            continue
        try:
            total, used, free = (float(p) for p in parts)
        except ValueError:
            continue
        if total <= 0:
            continue
        if best is None or total > best[0]:
            best = (total, used, free)
    if best is None:
        return Vram(reason="nvidia-smi printed no usable memory line")
    total, used, free = best
    return Vram(total_mb=total, used_mb=used, free_mb=free)


async def read_vram() -> Vram:
    """The card right now: total, used and free MiB, or a reason.

    Every failure mode degrades to a reason rather than an exception: no
    GPU passthrough on this container (see deploy/docker-compose.gpu.yml),
    no NVIDIA driver, a missing binary, a wedged driver that never returns.
    A fit verdict, a health tool and a beat check all call this, and none of
    them may crash because the card could not be asked.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "nvidia-smi",
            f"--query-gpu={_QUERY}",
            "--format=csv,noheader,nounits",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=NVIDIA_SMI_TIMEOUT_S)
    except (OSError, TimeoutError) as exc:
        return Vram(reason=f"nvidia-smi could not be run — {exc}")
    if proc.returncode != 0:
        return Vram(reason=f"nvidia-smi exited {proc.returncode}: {stderr.decode().strip()[:200]}")
    return parse(stdout.decode())
