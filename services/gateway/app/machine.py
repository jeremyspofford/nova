"""What the machine has RIGHT NOW — read every call, cached nowhere.

## Why this exists at all
`data/hardware.json` is written once by install.sh and never refreshed. It
is fine for "what did this box look like when Nova was installed" and wrong
for every question an operator asks while watching a slow turn: how much
memory is left, is the disk full, is anything actually running. A panel
built on it would show install-day numbers with today's confidence — the
same trap `devices_vram.py` was written to get out of for VRAM.

So: /proc and one statvfs, on every request. These files are free to read
and always current.

## Every field is a fact or a stated absence
A reading that cannot be taken is `None` WITH a reason, never a zero. Zero
free memory and "we could not read free memory" are opposite findings, and
a panel that renders the second as the first is the silence this codebase
keeps hunting.

## What is deliberately NOT here
**Network throughput.** Nobody measures it, and a number nobody measured is
worse than a blank space. Latency to the peers IS measured — the probes
record it — and that is a different claim, made where it is true.

## Containers see the host's kernel
This runs in a container, so /proc/meminfo is the HOST's memory (or, on
WSL2, the VM's) rather than a cgroup limit. That is the right answer for
this question: the operator wants to know whether the machine can load a
model, not what this container was budgeted.
"""

from __future__ import annotations

import os
import shutil

#: Where the workspace and the model store live, and therefore the disk an
#: operator actually cares about filling.
DISK_PATH = "/data"


def _meminfo(raw: str) -> dict[str, int]:
    """/proc/meminfo's kB values, by key. Pure, so it is testable without a
    kernel — and so a format change is a parse that finds nothing rather
    than an exception halfway up a request."""
    out: dict[str, int] = {}
    for line in raw.splitlines():
        key, _, rest = line.partition(":")
        value = rest.strip().split(" ")[0] if rest else ""
        if value.isdigit():
            out[key.strip()] = int(value)
    return out


def memory() -> dict:
    """Total and available RAM in MiB, or a reason.

    MemAvailable, not MemFree: free memory excludes the page cache, which
    the kernel hands back the moment anything asks. Reporting MemFree makes
    a healthy machine look moments from death, and an operator who believes
    it will close the wrong thing.
    """
    try:
        with open("/proc/meminfo", encoding="utf-8") as handle:
            info = _meminfo(handle.read())
    except OSError as exc:
        return {"total_mb": None, "available_mb": None, "reason": f"/proc/meminfo — {exc}"}
    total, available = info.get("MemTotal"), info.get("MemAvailable")
    if total is None or available is None:
        return {
            "total_mb": None,
            "available_mb": None,
            "reason": "/proc/meminfo carried no MemTotal/MemAvailable",
        }
    return {
        "total_mb": round(total / 1024),
        "available_mb": round(available / 1024),
        "reason": None,
    }


def cpu() -> dict:
    """Core count and the 1-minute load average, or a reason.

    Load AGAINST cores, because 8 means nothing until you know whether the
    box has four cores or sixty-four. Both numbers travel together so the
    reader never has to supply the denominator.
    """
    try:
        one, _five, _fifteen = os.getloadavg()
    except (OSError, AttributeError) as exc:  # pragma: no cover - POSIX only
        return {"cores": None, "load_1m": None, "reason": f"load average unreadable — {exc}"}
    return {"cores": os.cpu_count(), "load_1m": round(one, 2), "reason": None}


def disk(path: str = DISK_PATH) -> dict:
    """Free and total GiB where the models and the workspace live."""
    try:
        usage = shutil.disk_usage(path)
    except OSError as exc:
        return {"free_gb": None, "total_gb": None, "reason": f"{path} — {exc}"}
    gb = 1024**3
    return {
        "free_gb": round(usage.free / gb, 1),
        "total_gb": round(usage.total / gb, 1),
        "reason": None,
    }


def read() -> dict:
    """Every live reading, each independently degradable.

    One slow or missing source costs its own field and nothing else: a
    panel that shows three numbers and one stated blank is more useful than
    a panel that shows an error.
    """
    return {"memory": memory(), "cpu": cpu(), "disk": disk()}
