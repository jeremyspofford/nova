"""System monitoring — live resource + service-health readings for *this*
instance (docs/plans/observability-board.md, phase 1).

Everything here describes the machine this backend runs on: CPU/RAM/load/disk
straight from `/proc` + `shutil` (dep-free, the same stance `hardware.py`
takes — no psutil, so the container stays hot-reloadable), plus GPU/container/
docker-disk readings fanned out to this instance's own inference-control
sidecar (the only holder of the docker socket + nvidia-smi). On WSL2 these are
the VM's numbers — the real ceiling the instance runs against.

Phase 2 adds history + fleet: each instance also writes its snapshot to the
shared `resource_samples` table (~60s, its own scheduler tick — sampling is
NOT leader-gated, every instance reports its own hardware) and upserts its
`instances` row; only the retention prune runs leader-only so it happens
once across the fleet.
"""

import asyncio
import json
import logging
import os
import shutil
import time

import httpx

from app import db, hardware, instances, settings_store
from app.config import settings

log = logging.getLogger(__name__)

_GIB = 1024 ** 3


def _read_cpu_times() -> tuple[int, int]:
    """(total, idle) jiffies from /proc/stat's aggregate cpu line."""
    with open("/proc/stat") as f:
        vals = [int(x) for x in f.readline().split()[1:]]
    idle = vals[3] + (vals[4] if len(vals) > 4 else 0)  # idle + iowait
    return sum(vals), idle


async def _cpu_percent() -> float | None:
    """Busy % over a short window — CPU use is a rate, so it needs two
    samples. 150 ms is enough to be meaningful without stalling the request."""
    try:
        t1, i1 = _read_cpu_times()
        await asyncio.sleep(0.15)
        t2, i2 = _read_cpu_times()
    except (OSError, ValueError, IndexError) as e:
        log.warning("CPU read failed: %s", e)
        return None
    dt = t2 - t1
    if dt <= 0:
        return None
    return round((1 - (i2 - i1) / dt) * 100, 1)


def _mem() -> dict:
    info: dict[str, int] = {}
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                key, _, rest = line.partition(":")
                info[key] = int(rest.split()[0])  # kB
    except (OSError, ValueError, IndexError) as e:
        log.warning("meminfo read failed: %s", e)
        return {"used_gb": None, "total_gb": None}
    total = info.get("MemTotal", 0) / 1024 / 1024
    avail = info.get("MemAvailable", info.get("MemFree", 0)) / 1024 / 1024
    return {"used_gb": round(total - avail, 1), "total_gb": round(total, 1)}


def _load1() -> float | None:
    try:
        with open("/proc/loadavg") as f:
            return round(float(f.read().split()[0]), 2)
    except (OSError, ValueError, IndexError):
        return None


def _disk_local() -> dict:
    """Used/total of the root filesystem — the container's overlay sits on the
    host's docker partition, so this tracks the disk that actually fills."""
    try:
        du = shutil.disk_usage("/")
        return {"used_gb": round((du.total - du.free) / _GIB, 1),
                "total_gb": round(du.total / _GIB, 1)}
    except OSError as e:
        log.warning("disk read failed: %s", e)
        return {"used_gb": None, "total_gb": None}


async def _sidecar(client: httpx.AsyncClient, path: str) -> dict | None:
    """One fixed-verb call to this instance's sidecar; None when it's absent
    or the ollama container is stopped (GPU verbs fail soft there)."""
    try:
        r = await client.get(f"{settings.inference_control_url}{path}")
        r.raise_for_status()
        return r.json()
    except Exception as e:
        log.warning("sidecar %s unavailable: %s", path, e)
        return None


async def snapshot() -> dict:
    """This instance's live resource reading. Sidecar calls + the CPU sample
    run concurrently so the whole thing costs ~one CPU window, not the sum."""
    async with httpx.AsyncClient(timeout=8.0) as client:
        cpu_pct, gpu, containers, docker_disk = await asyncio.gather(
            _cpu_percent(),
            _sidecar(client, "/gpu-stats"),
            _sidecar(client, "/containers"),
            _sidecar(client, "/disk"),
        )
    disk = _disk_local()
    if docker_disk:
        disk["docker"] = docker_disk.get("docker")
        if docker_disk.get("model_store"):
            disk["model_store"] = docker_disk["model_store"]
    return {
        "instance": {"id": await instances.ensure_id(),
                     "label": instances.label(),
                     "leader": instances.is_leader()},
        "platform": hardware._platform(),
        "cpu": {"pct": cpu_pct, "cores": os.cpu_count(), "load1": _load1()},
        "mem": _mem(),
        "gpu": gpu,                                   # {"gpus":[...]} or None
        "disk": disk,
        "containers": (containers or {}).get("containers", []),
        "sampled_at": time.time(),
    }


# Service reachability for the health strip. Core services are always
# expected up; profile-gated ones (bundled inference, voice) may be
# legitimately down — flagged `optional` so the UI shows them muted, not red.
_HTTP_CHECKS = [
    ("inference", settings.bundled_ollama_url, "/api/tags", True),
    ("searxng", settings.searxng_url, "/healthz", False),
    ("sidecar", settings.inference_control_url, "/status", False),
    ("whisper", settings.whisper_url, "/health", True),
    ("kokoro", settings.kokoro_url, "/health", True),
]


async def _probe(client: httpx.AsyncClient, name: str, base: str, path: str,
                 optional: bool) -> dict:
    t0 = time.monotonic()
    try:
        r = await client.get(f"{base}{path}")
        ok = r.status_code < 500
        return {"name": name, "ok": ok, "ms": round((time.monotonic() - t0) * 1000),
                "optional": optional}
    except Exception as e:
        return {"name": name, "ok": False, "optional": optional,
                "detail": str(e)[:160]}


async def health() -> dict:
    """Up/down + latency for every dependency, probed concurrently."""
    t0 = time.monotonic()
    try:
        async with db.acquire() as conn:
            await conn.fetchval("SELECT 1")
        pg = {"name": "postgres", "ok": True,
              "ms": round((time.monotonic() - t0) * 1000), "optional": False}
    except Exception as e:
        pg = {"name": "postgres", "ok": False, "optional": False,
              "detail": str(e)[:160]}
    async with httpx.AsyncClient(timeout=4.0) as client:
        probes = await asyncio.gather(
            *(_probe(client, *c) for c in _HTTP_CHECKS))
    return {"services": [pg, *probes]}


# ── phase 2: sampler + retention (docs/plans/observability-board.md) ─────────

# the scheduler ticks every 60s; the gate only guards against extra callers
_SAMPLE_GATE_S = 55
_PRUNE_GATE_S = 24 * 3600
_last_sample = 0.0
_last_prune = 0.0


async def _reaches() -> dict:
    """Can this instance reach the shared backends, and how fast? The two
    that matter for a split-brain diagnosis: the shared PG and the memory
    dir (a mount on remote instances)."""
    out: dict = {}
    t0 = time.monotonic()
    try:
        async with db.acquire() as conn:
            await conn.fetchval("SELECT 1")
        out["pg"] = {"ok": True, "ms": round((time.monotonic() - t0) * 1000)}
    except Exception as e:
        out["pg"] = {"ok": False, "detail": str(e)[:120]}
    t0 = time.monotonic()
    try:
        await asyncio.to_thread(os.listdir, settings.okf_memory_dir)
        out["memory"] = {"ok": True, "ms": round((time.monotonic() - t0) * 1000)}
    except OSError as e:
        out["memory"] = {"ok": False, "detail": str(e)[:120]}
    return out


def _gpu_rollup(gpu: dict | None) -> dict:
    """One sample row spans all GPUs: memory sums, utilization/temp maxes.
    The per-GPU breakdown rides in `detail` for anyone who needs it."""
    gpus = (gpu or {}).get("gpus") or []
    if not gpus:
        return {"used": None, "total": None, "pct": None, "temp": None}
    return {
        "used": round(sum(g.get("mem_used_gb") or 0 for g in gpus), 1),
        "total": round(sum(g.get("mem_total_gb") or 0 for g in gpus), 1),
        "pct": max((g.get("util_pct") or 0) for g in gpus),
        "temp": max((g.get("temp_c") or 0) for g in gpus),
    }


async def maybe_sample():
    """One fleet-visible sample of this instance, at most ~1/minute. Rides
    the scheduler tick; never raises (a broken sampler must not take the
    automations heartbeat down with it)."""
    global _last_sample
    now = time.monotonic()
    if _last_sample and now - _last_sample < _SAMPLE_GATE_S:
        return
    _last_sample = now
    try:
        snap, reaches = await asyncio.gather(snapshot(), _reaches())
        gpu = _gpu_rollup(snap.get("gpu"))
        detail = {
            "containers": snap.get("containers") or [],
            "gpus": (snap.get("gpu") or {}).get("gpus") or [],
            "docker": (snap.get("disk") or {}).get("docker"),
            "model_store": (snap.get("disk") or {}).get("model_store"),
            "platform": snap.get("platform"),
        }
        inst = snap["instance"]
        async with db.acquire() as conn:
            await conn.execute(
                """INSERT INTO instances (id, label, reaches)
                   VALUES ($1, $2, $3)
                   ON CONFLICT (id) DO UPDATE
                       SET label = EXCLUDED.label,
                           last_seen = now(),
                           reaches = EXCLUDED.reaches""",
                inst["id"], inst["label"], json.dumps(reaches))
            await conn.execute(
                """INSERT INTO resource_samples
                       (instance_id, ts, cpu_pct, load1, mem_used_gb,
                        mem_total_gb, vram_used_gb, vram_total_gb, gpu_pct,
                        gpu_temp_c, disk_used_gb, disk_total_gb, detail)
                   VALUES ($1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10,
                           $11, $12)""",
                inst["id"], snap["cpu"]["pct"], snap["cpu"]["load1"],
                snap["mem"]["used_gb"], snap["mem"]["total_gb"],
                gpu["used"], gpu["total"], gpu["pct"], gpu["temp"],
                snap["disk"]["used_gb"], snap["disk"]["total_gb"],
                json.dumps(detail))
    except Exception:
        log.exception("resource sample failed; next tick retries")


# ── phase 3: threshold alerts (leader-only) ─────────────────────────────────

# a breach must hold for this many consecutive samples before it raises —
# a model load spiking VRAM for one reading is normal, not an alert
_ALERT_DEBOUNCE = 3
# and must drop this far below the threshold to clear — no flapping when a
# value hovers right at the line
_ALERT_HYSTERESIS = 5.0
# an instance sampling ~1/min that has been silent this long is unreachable
_UNREACHABLE_AFTER_S = 180


def _pct(used, total) -> float | None:
    if used is None or total is None or total <= 0:
        return None
    return used / total * 100


async def _raise_alert(conn, instance_id: str, label: str, kind: str,
                       message: str, value, threshold) -> None:
    import uuid as _uuid
    await conn.execute(
        """INSERT INTO monitor_alerts
               (id, instance_id, kind, message, value, threshold)
           VALUES ($1, $2, $3, $4, $5, $6)""",
        _uuid.uuid4(), instance_id, kind, message, value, threshold)
    log.warning("ALERT raised [%s] %s", kind, message)
    # reach the operator even with the app closed; the alert row stands
    # either way, so a notify failure only costs the push
    try:
        from app import notify
        await notify.send(message, title="Nova resource alert",
                          priority="high", tags=["warning"],
                          click="/observability")
    except Exception:
        log.exception("alert notification failed (alert row kept)")


async def maybe_evaluate_alerts():
    """Threshold evaluation over the whole fleet's samples — leader-only so
    each breach raises exactly once. De-dupe = one open row per
    (instance, kind); recovery auto-clears with hysteresis."""
    if not instances.is_leader():
        return
    if not settings_store.get("monitor.alerts_enabled"):
        return
    try:
        thresholds = {
            "disk_pct": float(settings_store.get("monitor.alert_disk_pct")),
            "mem_pct": float(settings_store.get("monitor.alert_mem_pct")),
            "vram_pct": float(settings_store.get("monitor.alert_vram_pct")),
            "gpu_temp_c": float(settings_store.get("monitor.alert_gpu_temp_c")),
        }
        async with db.acquire() as conn:
            insts = await conn.fetch(
                """SELECT id, label,
                          extract(epoch FROM (now() - last_seen)) AS age_s
                   FROM instances""")
            open_rows = await conn.fetch(
                "SELECT instance_id, kind FROM monitor_alerts WHERE cleared_at IS NULL")
            open_alerts = {(r["instance_id"], r["kind"]) for r in open_rows}
            known_ids = {r["id"] for r in insts}

            for inst in insts:
                iid, label = inst["id"], inst["label"] or inst["id"]

                # unreachable: the heartbeat itself is the debounce (~3
                # missed samples); clears the moment a fresh sample lands
                silent = inst["age_s"] is not None and float(inst["age_s"]) > _UNREACHABLE_AFTER_S
                if silent and (iid, "unreachable") not in open_alerts:
                    mins = int(float(inst["age_s"]) // 60)
                    await _raise_alert(
                        conn, iid, label, "unreachable",
                        f"Instance '{label}' has not reported for {mins} minutes.",
                        float(inst["age_s"]), _UNREACHABLE_AFTER_S)
                elif not silent and (iid, "unreachable") in open_alerts:
                    await conn.execute(
                        """UPDATE monitor_alerts SET cleared_at = now()
                           WHERE instance_id = $1 AND kind = 'unreachable'
                             AND cleared_at IS NULL""", iid)
                    log.info("ALERT cleared [unreachable] %s", label)

                # metric thresholds want the last few samples (debounce)
                samples = await conn.fetch(
                    """SELECT mem_used_gb, mem_total_gb, vram_used_gb,
                              vram_total_gb, gpu_temp_c, disk_used_gb,
                              disk_total_gb
                       FROM resource_samples WHERE instance_id = $1
                       ORDER BY ts DESC LIMIT $2""", iid, _ALERT_DEBOUNCE)
                metrics = {
                    "disk_pct": [_pct(s["disk_used_gb"], s["disk_total_gb"]) for s in samples],
                    "mem_pct": [_pct(s["mem_used_gb"], s["mem_total_gb"]) for s in samples],
                    "vram_pct": [_pct(s["vram_used_gb"], s["vram_total_gb"]) for s in samples],
                    "gpu_temp_c": [s["gpu_temp_c"] for s in samples],
                }
                pretty = {"disk_pct": "Disk", "mem_pct": "Memory",
                          "vram_pct": "VRAM", "gpu_temp_c": "GPU temperature"}
                for kind, series in metrics.items():
                    limit = thresholds[kind]
                    vals = [v for v in series if v is not None]
                    breached = (len(vals) >= _ALERT_DEBOUNCE
                                and all(v >= limit for v in vals))
                    recovered = bool(vals) and vals[0] < limit - _ALERT_HYSTERESIS
                    unit = "°C" if kind == "gpu_temp_c" else "%"
                    if breached and (iid, kind) not in open_alerts:
                        await _raise_alert(
                            conn, iid, label, kind,
                            f"{pretty[kind]} at {vals[0]:.0f}{unit} on "
                            f"'{label}' (threshold {limit:.0f}{unit}).",
                            vals[0], limit)
                    elif recovered and (iid, kind) in open_alerts:
                        await conn.execute(
                            """UPDATE monitor_alerts SET cleared_at = now()
                               WHERE instance_id = $1 AND kind = $2
                                 AND cleared_at IS NULL""", iid, kind)
                        log.info("ALERT cleared [%s] %s", kind, label)

            # an unreachable alert for a deleted (retired) instance can never
            # see a fresh heartbeat — clear it when the registry row is gone
            for iid, kind in open_alerts:
                if iid not in known_ids:
                    await conn.execute(
                        """UPDATE monitor_alerts SET cleared_at = now()
                           WHERE instance_id = $1 AND cleared_at IS NULL""", iid)
    except Exception:
        log.exception("alert evaluation failed; next tick retries")


async def maybe_prune_samples():
    """Fleet-wide retention, leader-only so it runs once, at most daily —
    the trace.maybe_prune pattern."""
    global _last_prune
    if not instances.is_leader():
        return
    now = time.monotonic()
    if _last_prune and now - _last_prune < _PRUNE_GATE_S:
        return
    _last_prune = now
    days = int(settings_store.get("monitor.retention_days") or 7)
    try:
        async with db.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM resource_samples WHERE ts < now() - make_interval(days => $1)",
                days)
        log.info("Resource-sample retention: %s (older than %d days)", result, days)
    except Exception:
        log.exception("resource-sample prune failed; will retry tomorrow")
