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

## Which card (S40)
A number is only meaningful with the hardware it was taken on (D10,
app/compute_id.py). The reading therefore carries the biggest card's own
uuid and name, every card's uuid, and how many cards nvidia-smi listed — a
card that printed no uuid is still counted, because a set with a nameless
card in it cannot be named. `absent` says there is no nvidia-smi in this
container at all (no GPU passed through): a fact, and a different one from
"the card is there and could not be read".
"""

from __future__ import annotations

import asyncio
import logging

logger = logging.getLogger("gateway")

# nvidia-smi answers in well under a second on every host this has ever run
# on; bounded generously anyway so a wedged driver cannot hang a request.
NVIDIA_SMI_TIMEOUT_S = 10.0

# Utilisation rides along because memory alone answers the wrong question.
# On 2026-09-15 the card had 6.9 GB free — comfortable — and was pinned at
# 99% by a process outside every container this machine runs, so ollama was
# timesharing the shader cores and turns took 100-400 s. A reading that says
# only "6.9 GB free" describes that card as healthy.
#
# S40 appends uuid and name AFTER utilisation, never between: memory stays
# fields 1-3 and utilisation 4 on every driver.
_QUERY = "memory.total,memory.used,memory.free,utilization.gpu,uuid,name"


class Vram:
    """One card's live memory, in MiB, or an honest reason it is unknown —
    plus which card it is (S40).

    A degraded reading is `total_mb is None` WITH a `reason` — never zeros,
    never a stale number kept warm from a previous call. Callers that must
    answer "unknown" have a sentence to answer it with.
    """

    __slots__ = (
        "total_mb",
        "used_mb",
        "free_mb",
        "util_pct",
        "reason",
        "uuid",
        "name",
        "uuids",
        "cards",
        "absent",
    )

    def __init__(
        self,
        total_mb: float | None = None,
        used_mb: float | None = None,
        free_mb: float | None = None,
        util_pct: float | None = None,
        reason: str | None = None,
        *,
        uuid: str | None = None,
        name: str | None = None,
        uuids: tuple[str, ...] | list[str] = (),
        cards: int = 0,
        absent: bool = False,
    ) -> None:
        self.total_mb = total_mb
        self.used_mb = used_mb
        self.free_mb = free_mb
        # None, never 0: a driver that did not report it has not told us the
        # card is idle.
        self.util_pct = util_pct
        self.reason = reason
        # The biggest card's own uuid and name (the card the numbers above
        # are about); every card's uuid; how many cards were listed.
        self.uuid = uuid
        self.name = name
        self.uuids = tuple(uuids)
        self.cards = cards
        # True only when nvidia-smi is not in this container at all.
        self.absent = absent

    @property
    def known(self) -> bool:
        return self.total_mb is not None and self.free_mb is not None

    def as_dict(self) -> dict:
        return {
            "total_mb": self.total_mb,
            "used_mb": self.used_mb,
            "free_mb": self.free_mb,
            "util_pct": self.util_pct,
            "reason": self.reason,
            "uuid": self.uuid,
            "name": self.name,
            "uuids": list(self.uuids),
            "cards": self.cards,
            "absent": self.absent,
        }

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"Vram({self.as_dict()})"


def parse(stdout: str) -> Vram:
    """The biggest single card out of nvidia-smi's CSV lines.

    Pure, so the parsing is testable without a GPU. A line that does not
    carry the three memory numbers is skipped rather than crashing the read
    — a driver that prints `[N/A]` for one field on one card must not take
    out the reading for a card that answered properly.

    Utilisation is read when it is there and left None when it is not. It is
    the LAST field for that reason: a driver too old to report it, or one
    printing `[N/A]`, still yields a complete memory reading rather than
    losing the whole line.

    Field 5 is the uuid and everything after it is the name (a name may
    hold a comma). Every line of three or more fields is a card, counted
    even when its memory is [N/A].
    """
    best: tuple[float, float, float, float | None, str | None, str | None] | None = None
    cards = 0
    uuids: list[str] = []
    for line in stdout.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 3:
            continue
        cards += 1
        uuid = parts[4] if len(parts) > 4 and parts[4].upper().startswith("GPU-") else None
        if uuid is not None:
            uuids.append(uuid)
        name = ", ".join(parts[5:]) or None
        try:
            total, used, free = (float(p) for p in parts[:3])
        except ValueError:
            continue
        if total <= 0:
            continue
        util: float | None = None
        if len(parts) > 3:
            try:
                util = float(parts[3].rstrip("% ").strip())
            except ValueError:
                util = None
        if best is None or total > best[0]:
            best = (total, used, free, util, uuid, name)
    if best is None:
        return Vram(reason="nvidia-smi printed no usable memory line", uuids=uuids, cards=cards)
    total, used, free, util, uuid, name = best
    return Vram(
        total_mb=total,
        used_mb=used,
        free_mb=free,
        util_pct=util,
        uuid=uuid,
        name=name,
        uuids=uuids,
        cards=cards,
    )


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
    except FileNotFoundError as exc:
        # No nvidia-smi in this container: no GPU was passed through
        # (deploy/docker-compose.gpu.yml not merged) — the engine runs on CPU.
        return Vram(reason=f"nvidia-smi could not be run — {exc}", absent=True)
    except (OSError, TimeoutError) as exc:
        return Vram(reason=f"nvidia-smi could not be run — {exc}")
    if proc.returncode != 0:
        return Vram(reason=f"nvidia-smi exited {proc.returncode}: {stderr.decode().strip()[:200]}")
    return parse(stdout.decode())
