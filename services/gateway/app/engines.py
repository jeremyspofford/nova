"""Engines: the machines that run models, and what each is doing now (S40).

An ENGINE is a provider row with adapter=ollama plus its one-to-one `engines`
row (migration 009). The bundled one is always `hub` (D8: the compose
container at OLLAMA_URL, the embedder too); `builtin=true` finds it, never its
name. Other machines' engines arrive with the agent (S44) and change nothing
here but their rows.

## The gateway states; it never decides
`observe` answers "what is this engine doing": ready, unreachable, switched
off, or unobserved (a wake-on-LAN engine nobody asked recently — asking could
wake it). Routing, the catalogue and core read this answer; none of them gets
a second way to ask. Nothing here refuses anything on the owner's behalf
(owner ruling 2026-09-03): it says what is true.

## Failures are cached too
Before S40 a failed listing was never cached (routing.py:293-294 at 0531b496),
so every routed turn waited the whole 10 s MODELS_TIMEOUT again. A ready
reading is kept READY_TTL_S, a failed one FAILURE_TTL_S; `live=True` always
asks again and refreshes the cache. A cached answer carries the time it was
ORIGINALLY read, never "now". `forget(name)` drops one engine's reading (the
data plane, after a connect-phase failure).

## Serving is the owner's switch, not a reading
The cache holds only what the engine SAID. `serving` comes from the row passed
in on every call, so flipping it takes effect on the very next observe,
whatever is cached — a switch that waited out a cache would be a switch that
lies.

## Compute is derived per process, never stored
`compute` is the D10 id (app/compute_id.py) a model fully resident on this
engine would be stamped with — the key fit reads probes by. It comes from this
observation's own readings (nvidia-smi through devices_vram, and /proc), never
from `last_facts`: a database restored onto another machine would otherwise
carry a GPU it does not have.

## One reader each (S40 review, rulings C1-C4, G2)
- the hub's devices: `bundled_devices()` (compute_id stays pure);
- an engine's /api/ps: `resident(app, row)`, in ollama's own keys;
- an engine's own API: `client(app, row, timeout)`;
- what a reading means: `compute_of` (the fit key) and `fit_frame` (VRAM or
  RAM, or None for a card this hub cannot read).
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import asyncpg
import httpx

from app import adapters, compute_id, devices_vram, providers

BUILTIN = providers.BUILTIN
#: D8: the bundled engine is always the compose container.
BUILTIN_RUNTIME = "container"
READY_TTL_S = 30.0
FAILURE_TTL_S = 10.0
#: /api/ps is a cheap metadata read (admin.PS_TIMEOUT's figure).
PS_TIMEOUT = httpx.Timeout(5.0)
#: The bundled engine's CPU, read where the gateway runs: the gateway shares
#: the docker host with the bundled ollama, so this /proc IS that engine's
#: machine — the numbers `docker info` reports (NCPU, MemTotal), which D10
#: names as a container runtime's cpu source.
PROC_DIR = Path("/proc")
#: Every state an EngineView can carry (docs/contracts/engine_view.json).
STATES = ("ready", "unreachable", "switched_off", "unobserved")
#: The hub reads exactly ONE card: its own, through nvidia-smi in this
#: container. Every other engine's card is on another machine, and reading
#: this one for it would describe the hub's GPU as that machine's.
NOT_THIS_CARD = "{name}'s card cannot be read from this hub — only the hub's own card is read here"

_COLUMNS = (
    "p.name, p.adapter, p.base_url, p.auth_shape, p.api_key, p.default_model, p.builtin, "
    "p.is_default, p.local, e.lifecycle, e.serving, e.hold_s, e.last_ready_at, e.last_tags, "
    "e.last_tags_at, e.last_facts, e.last_facts_at, e.updated_at"
)
_FROM = "FROM providers p JOIN engines e ON e.provider = p.name WHERE p.adapter = 'ollama'"


class UnknownEngine(LookupError):
    """No engine by that name: unknown, or a provider that is not an engine."""


@dataclass(frozen=True)
class EngineView:
    name: str
    #: The bundled engine — the one that is also the embedder (D8), so a
    #: reader can tell it from a machine that only serves chat.
    builtin: bool
    lifecycle: str
    serving: bool
    state: str  # one of STATES
    reason: str | None
    observed_at: str | None
    #: Did the engine answer THIS reading? True/False when it was asked, None
    #: when it was not (a wake-on-LAN engine left asleep). Independent of the
    #: switch: `state` says switched_off whether or not the engine answered,
    #: and the embedder being down while switched off is still an outage.
    answered: bool | None
    tags: dict[str, int | None] | None
    tags_as_of: str | None
    compute: str | None
    runtime: str | None
    facts: dict


@dataclass(frozen=True)
class _Reading:
    """What the engine SAID at one instant — cached whole, TTL by `ok`."""

    ok: bool
    detail: str | None
    tags: dict[str, int | None] | None
    tags_as_of: str | None
    observed_at: str
    facts: dict
    compute: str | None
    runtime: str | None
    read_at_mono: float


_READINGS: dict[str, _Reading] = {}


def _clock() -> float:
    return time.monotonic()


def _nproc() -> int:
    return os.cpu_count() or 0


def clear_cache() -> None:
    _READINGS.clear()


def forget(name: str) -> None:
    """Drop one engine's cached reading (the data plane, after a
    connect-phase failure, so the next observe asks again). The other
    engines keep theirs (ruling C11)."""
    _READINGS.pop(name, None)


def is_engine(row: dict) -> bool:
    return row.get("adapter") == "ollama"


def switched_off_reason(name: str) -> str:
    """The one sentence for an engine its owner switched off (ruling C10):
    observe's reason and routing's `switched_off` verdict both say this. It
    says only what the switch enforces — the role walk passes over it — never
    that the engine runs no models: a call outside any role still runs
    there, and a model already loaded stays loaded (S40 fix wave B5)."""
    return f"{name} is switched off (serving=false): chat routing passes over it"


def compute_of(reading: dict, accelerators: list[str], cpu: str | None) -> str | None:
    """The D10 id a model FULLY resident on the hub would be stamped with —
    the key fit reads probes by (ruling C4). `reading` is a
    `devices_vram.Vram.as_dict()`; `accelerators` and `cpu` are what that
    reading and /proc name.

    No GPU passed through (nvidia-smi absent) is the CPU; exactly one
    nameable card is that card; anything else — two cards, a card nobody can
    name, a GPU that is there but cannot be read — is None. A GPU that exists
    is never read as the CPU: omitted, never guessed."""
    if reading.get("absent"):
        return cpu
    if len(accelerators) == 1:
        return accelerators[0]
    return None


def fit_frame(row: dict, reading: dict | None) -> str | None:
    """Which memory a fit verdict for this engine is about (ruling C3).

    The hub: `ram` only when no GPU was passed through (nvidia-smi absent) —
    every model then runs on its CPU; otherwise `vram`, even when the card
    cannot be read right now (fit is then `unknown` with the card's reason,
    never re-framed against system memory). Another machine: None — its card
    is not readable from here, so its frame is omitted, never guessed from
    the hub's. A hub with no reading at all is None too."""
    if not row.get("builtin") or reading is None:
        return None
    return "ram" if reading.get("absent") else "vram"


def client(app, row: dict, timeout: httpx.Timeout) -> httpx.AsyncClient:
    """The one way to reach an engine's own API — /api/ps, pull, remove
    (ruling G2): its address (base_url_of: OLLAMA_URL for the bundled engine,
    the stored address for another machine's) and its adapter's headers."""
    return adapters.http_client(
        app,
        timeout,
        base_url=providers.base_url_of(row),
        headers=adapters.for_row(row).headers(row),
    )


def _iso(value) -> str | None:
    if value is None:
        return None
    return value if isinstance(value, str) else value.isoformat()


def _decode(record) -> dict:
    row = dict(record)
    for key in ("last_tags", "last_facts"):
        if row.get(key) is not None:
            row[key] = json.loads(row[key])
    return row


async def rows(pool: asyncpg.Pool) -> list[dict]:
    """Every engine, builtin first: provider columns joined with engines'."""
    records = await pool.fetch(f"SELECT {_COLUMNS} {_FROM} ORDER BY p.builtin DESC, p.name")
    return [_decode(record) for record in records]


async def get(pool: asyncpg.Pool, name: str) -> dict:
    record = await pool.fetchrow(f"SELECT {_COLUMNS} {_FROM} AND p.name = $1", name)
    if record is None:
        raise UnknownEngine(name)
    return _decode(record)


def to_public(row: dict) -> dict:
    """An engine row, safe for the wire: no key and no address."""
    return {
        "name": row["name"],
        "builtin": bool(row["builtin"]),
        "is_default": bool(row["is_default"]),
        "lifecycle": row["lifecycle"],
        "serving": row["serving"],
        "hold_s": row["hold_s"],
        "last_ready_at": _iso(row["last_ready_at"]),
        "last_tags_at": _iso(row["last_tags_at"]),
        "last_facts_at": _iso(row["last_facts_at"]),
        "updated_at": _iso(row["updated_at"]),
    }


async def set_serving(pool: asyncpg.Pool, name: str, serving: bool) -> dict:
    """Store the owner's switch and return the row READ BACK from the
    database — the caller reports what is stored, never what it sent."""
    if not isinstance(serving, bool):
        raise ValueError(f"serving must be true or false — got {serving!r}")
    updated = await pool.fetchval(
        "UPDATE engines SET serving = $2, updated_at = now() WHERE provider = $1 "
        "RETURNING provider",
        name,
        serving,
    )
    if updated is None:
        raise UnknownEngine(name)
    return await get(pool, name)


def _no_address(row: dict) -> str:
    if row.get("builtin"):
        return f"OLLAMA_URL is unset — cannot read what is resident on {row['name']}"
    return f"{row['name']} has no address — cannot read what is resident on it"


async def resident(
    app, row: dict, *, timeout: httpx.Timeout = PS_TIMEOUT
) -> tuple[list[dict] | None, str | None]:
    """(every model THIS engine's /api/ps reports resident, reason-if-not).

    The one /api/ps reader (ruling C2). Entries are `{model, vram_mb, size,
    size_vram}` in ollama's own keys: vram_mb for fit's free-after-switch,
    size/size_vram for the D10 stamp (compute_id.served_on), which decides
    offload from exactly those two numbers. An entry /api/ps states no
    size_vram for — or states it as anything but a byte count — is skipped;
    nothing is filled in, and a garbled entry never costs the caller (the
    served-on stamp reads this after every local reply). It is the only
    per-model VRAM figure on a host that can be attributed to anything: the
    card's own counter sees every process and, under WSL2, can name none of
    them.

    Never an empty list for a read that failed: None WITH the reason."""
    if not providers.base_url_of(row):
        return None, _no_address(row)
    name = row["name"]
    try:
        async with client(app, row, timeout) as c:
            resp = await c.get("/api/ps")
            resp.raise_for_status()
    except httpx.HTTPError as exc:
        return None, f"could not reach {name}'s /api/ps — {adapters.reason(exc)}"
    try:
        body = resp.json()
    except ValueError:
        return None, f"{name}'s /api/ps answered with something that is not JSON"
    models = body.get("models") if isinstance(body, dict) else None
    if not isinstance(models, list):
        return None, f"{name}'s /api/ps answered with something that is not a model list"
    out = []
    for entry in models:
        if not isinstance(entry, dict):
            continue
        size_vram = entry.get("size_vram")
        if (
            isinstance(size_vram, int | float)
            and not isinstance(size_vram, bool)
            and size_vram >= 0
        ):
            out.append(
                {
                    "model": entry.get("name") or entry.get("model"),
                    "vram_mb": size_vram / (1024 * 1024),
                    "size": entry.get("size"),
                    "size_vram": size_vram,
                }
            )
    return out, None


async def _builtin_facts() -> tuple[dict, str | None]:
    """(facts, compute) for the bundled engine, read now: one nvidia-smi
    call and /proc."""
    reading = (await devices_vram.read_vram()).as_dict()
    accelerators = compute_id.bundled_accelerators(reading)
    unreadable: list[dict] = []
    try:
        cpu: str | None = compute_id.cpu_slug(
            (PROC_DIR / "cpuinfo").read_text(), (PROC_DIR / "meminfo").read_text(), _nproc()
        )
    except (OSError, ValueError) as exc:
        cpu = None
        unreadable.append({"item": "cpu", "reason": str(exc)})
    gpu = None
    if reading["cards"] and reading["total_mb"] is not None:
        gpu = {
            "name": reading["name"],
            "uuid": reading["uuid"],
            "total_mb": reading["total_mb"],
            "cards": reading["cards"],
        }
        if not accelerators:
            unreadable.append(
                {
                    "item": "gpu_identity",
                    "reason": "a card printed no CUDA uuid, so which card ran a model "
                    "cannot be named",
                }
            )
    elif not reading["absent"]:
        unreadable.append(
            {"item": "gpu", "reason": reading["reason"] or "nvidia-smi gave no reading"}
        )
    facts = {"gpu": gpu, "accelerators": accelerators, "cpu": cpu, "unreadable": unreadable}
    return facts, compute_of(reading, accelerators, cpu)


async def bundled_devices() -> tuple[list[str], str | None]:
    """(accelerators, cpu) of the hub, read NOW — the one live reader of the
    bundled engine's devices (ruling C1): the probe stamps its rows with
    these. A per-reply stamp reads the cached view's facts instead
    (`observe(..., live=False)`), which hold the same two values."""
    facts, _ = await _builtin_facts()
    return facts["accelerators"], facts["cpu"]


async def _remember(pool: asyncpg.Pool, row: dict, tags: dict, at: str, facts: dict) -> None:
    """A READY reading, kept for the moments nobody can ask. A failure never
    overwrites the last good reading."""
    when = datetime.fromisoformat(at)
    if row["builtin"]:
        await pool.execute(
            "UPDATE engines SET last_ready_at = $2, last_tags = $3::jsonb, last_tags_at = $2, "
            "last_facts = $4::jsonb, last_facts_at = $2 WHERE provider = $1",
            row["name"],
            when,
            json.dumps(tags),
            json.dumps(facts),
        )
    else:
        await pool.execute(
            "UPDATE engines SET last_ready_at = $2, last_tags = $3::jsonb, last_tags_at = $2 "
            "WHERE provider = $1",
            row["name"],
            when,
            json.dumps(tags),
        )


async def _read(app, pool: asyncpg.Pool, row: dict) -> _Reading:
    if row["builtin"]:
        facts, compute = await _builtin_facts()
        runtime: str | None = BUILTIN_RUNTIME
    else:
        # Another machine's hardware is read by its own agent (S44); this
        # process can only see the hub, so nothing is guessed from here.
        facts, compute, runtime = {}, None, None
    try:
        listing = await adapters.for_row(row).list_models(app, row)
    except adapters.ProviderRefused as exc:
        return _Reading(
            ok=False,
            detail=exc.detail,
            tags=None,
            tags_as_of=None,
            observed_at=datetime.now(UTC).isoformat(),
            facts=facts,
            compute=compute,
            runtime=runtime,
            read_at_mono=_clock(),
        )
    tags = {model["id"]: model.get("size_bytes") for model in listing.models}
    await _remember(pool, row, tags, listing.fetched_at, facts)
    return _Reading(
        ok=True,
        detail=None,
        tags=tags,
        tags_as_of=listing.fetched_at,
        observed_at=listing.fetched_at,
        facts=facts,
        compute=compute,
        runtime=runtime,
        read_at_mono=_clock(),
    )


def _cached(name: str) -> _Reading | None:
    reading = _READINGS.get(name)
    if reading is None:
        return None
    ttl = READY_TTL_S if reading.ok else FAILURE_TTL_S
    if _clock() - reading.read_at_mono >= ttl:
        del _READINGS[name]
        return None
    return reading


def _view(row: dict, reading: _Reading) -> EngineView:
    name = row["name"]
    if reading.ok:
        if row["serving"]:
            state, reason = "ready", None
        else:
            state, reason = "switched_off", switched_off_reason(name)
    else:
        unreachable = f"{name} could not be asked what is installed — {reading.detail}"
        if row["serving"]:
            state, reason = "unreachable", unreachable
        else:
            state, reason = "switched_off", f"{switched_off_reason(name)}; {unreachable}"
    return EngineView(
        name=name,
        builtin=bool(row["builtin"]),
        lifecycle=row["lifecycle"],
        serving=row["serving"],
        state=state,
        reason=reason,
        observed_at=reading.observed_at,
        answered=reading.ok,
        tags=reading.tags,
        tags_as_of=reading.tags_as_of,
        compute=reading.compute,
        runtime=reading.runtime,
        facts=reading.facts,
    )


def _unobserved(row: dict) -> EngineView:
    as_of = _iso(row["last_tags_at"])
    name = row["name"]
    if row["serving"]:
        state = "unobserved"
        reason = (
            f"{name} was not asked: it wakes on LAN and asking could wake it — what it last "
            f"listed is as of {as_of or 'never'}"
        )
    else:
        state, reason = "switched_off", switched_off_reason(name)
    return EngineView(
        name=name,
        builtin=bool(row["builtin"]),
        lifecycle=row["lifecycle"],
        serving=row["serving"],
        state=state,
        reason=reason,
        observed_at=None,
        answered=None,
        tags=row["last_tags"],
        tags_as_of=as_of,
        compute=None,
        runtime=None,
        facts=row["last_facts"] or {},
    )


async def observe(app, pool: asyncpg.Pool, row: dict, *, live: bool) -> EngineView:
    """What this engine is doing. `row` is an engine row (rows()/get()); a
    bare providers row is re-read, because `serving` must come from the
    stored switch, never a default."""
    if "serving" not in row:
        row = await get(pool, row["name"])
    reading = None if live else _cached(row["name"])
    if reading is None:
        if not live and row["lifecycle"] == "wake_on_lan":
            return _unobserved(row)
        reading = await _read(app, pool, row)
        _READINGS[row["name"]] = reading
    return _view(row, reading)
