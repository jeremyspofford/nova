"""The machines that run models — core's one reader of the gateway's engines (S40).

An ENGINE is a provider the gateway serves models through with the ollama
adapter (gateway app/engines.py); the bundled one is `hub`, and S44 adds one
per machine. The gateway owns every fact about one — lifecycle, the serving
switch, whether it answered and when, what is installed, what it computes
on — and core stores none of them. It asks, here, so there is one shape for
the answer and one place a failure to ask is stated.

HOW CORE KNOWS WHICH PROVIDERS ARE ENGINES — never a name written in core:

  * code that classifies a free-standing id (a setting, a tool argument) asks
    this module for the gateway's list: `hub:qwen3:8b` names a machine only
    because `hub` is in it (`split`);
  * code that already holds catalogue rows reads the rows instead, which
    needs no second call: a `kind: local` row is on an engine, and a
    catalogue id is always `<provider>:<model>` split at its FIRST colon.

`PLANT` says which reader a task talks to. A ContextVar, so an eval replay
can put its own `eval_*` machines in front of the real list for its own task
and nothing else in the process sees them (`FixturePlant`). A write through
the plant is the serving switch, and what it returns is the gateway's READ
BACK, never the value sent. `machine_json` is the one shape the Settings tile
reads (web api.ts `Machine`).

Nova's agents go through the plant too (S42a, S42b): their listing, the
revoked ones that still knock, and "update it now". For those a replay is
HERMETIC (the controller's replay-hermeticity ruling, S42b Task 22): it
lists, reports knocks for and updates its declared devices alone, against
its own hub build (FIXTURE_HUB_VERSION) — no real build, device, knock or
update state is read during an eval.
"""

from __future__ import annotations

import copy
import dataclasses
import logging
import re
from collections.abc import Callable, Collection, Iterable
from contextvars import ContextVar
from datetime import UTC, datetime
from urllib.parse import quote

import httpx

from app import agent_dist, agent_updates, db, device_facts, devices, devices_ws, peers

logger = logging.getLogger("core")

ENGINES_PATH = "/admin/engines"
PROVIDERS_PATH = "/admin/providers"
ROUTES_PATH = "/admin/routes"
# One read of a short list or of one machine's card: the gateway answers from
# its per-engine cache (ready 30 s, failure 10 s) or one bounded observation.
TIMEOUT = httpx.Timeout(connect=5.0, read=15.0, write=5.0, pool=5.0)


class PlantUnavailable(RuntimeError):
    """The gateway could not be asked, refused, or answered something that is
    not what was asked for. The message is the reason, in words — a caller
    states it; it never reads it as "no machines"."""


class UnknownMachine(LookupError):
    """No engine by that name (the gateway's 404, in its own words) — or, for
    update_agent, no paired machine machine_update can send to, as a stated
    cannot (S42b)."""


# Runs of spaces, hyphens and underscores read alike in a machine's name
# (walk-fixes T2): "mini pc", "Mini-PC" and "mini_pc" are one name.
_LOOSE_SEP = re.compile(r"[\s_\-]+")


def _loose(text: str) -> str:
    return _LOOSE_SEP.sub("-", text.strip().casefold()).strip("-")


def _tokens(name: str, hostname: str | None) -> set[str]:
    """The whole words of a machine's name and hostname, casefold, split on
    runs of space, hyphen and underscore (walk-fixes T2b)."""
    words = _loose(name).split("-")
    if isinstance(hostname, str):
        words += _loose(hostname).split("-")
    return {w for w in words if w}


def resolve_name(name: object, known: Iterable[tuple[str, str | None]]) -> str | None:
    """The ONE resolver every tool that names a paired machine goes through
    (walk-fixes T2): the paired name `name` means, among `known` — each live
    machine's (name, hostname), read from the stored rows (or a replay's
    declared devices), never an alias list kept here. None when nothing
    matches; the caller says its own listing.

    Tiers, the first that matches wins: the exact name; the exact hostname;
    then the name or hostname compared loosely (casefold, runs of space,
    hyphen and underscore alike); last (walk-fixes T2b), the name less a
    leading "the " equal to one WHOLE token of a machine's name or hostname
    (split on space, hyphen, underscore; casefold) — "the dell" is
    DELL-XPS-8950, "del" is nothing. Two machines in the winning tier is
    never guessed between: UnknownMachine, a stated cannot naming each."""
    if not isinstance(name, str):
        return None
    known = list(known)
    asked = name.strip()
    want = _loose(name)
    token = want.removeprefix("the-")
    if "-" in token:
        token = ""  # more than one word is not one token
    tiers = (
        [n for n, _h in known if n == name],
        [n for n, h in known if isinstance(h, str) and h.strip() == asked and asked],
        [
            n
            for n, h in known
            if want and (_loose(n) == want or (isinstance(h, str) and _loose(h) == want))
        ],
        [n for n, h in known if token and token in _tokens(n, h)],
    )
    for tier in tiers:
        names = list(dict.fromkeys(tier))
        if len(names) == 1:
            return names[0]
        if names:
            raise UnknownMachine(
                f"cannot: {name!r} matches more than one paired machine — "
                f"{', '.join(names)}; name one of them exactly"
            )
    return None


def _error_of(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, dict) and body.get("error"):
        return str(body["error"])
    return f"{response.status_code} {response.reason_phrase}".strip()


def _engine_path(name: str) -> str:
    return f"{ENGINES_PATH}/{quote(name, safe='')}"


class GatewayPlant:
    """The real machines, as the gateway reads them."""

    async def _request(self, app, method: str, path: str, **kwargs) -> httpx.Response:
        try:
            async with peers.client(app, peers.GATEWAY, TIMEOUT) as client:
                return await client.request(method, path, **kwargs)
        except peers.PeerUnconfigured as exc:
            raise PlantUnavailable(f"the gateway link is not configured — {exc}") from exc
        except httpx.HTTPError as exc:
            raise PlantUnavailable(
                f"the gateway could not be reached — {peers.reason(exc)}"
            ) from exc

    @staticmethod
    def _object(response: httpx.Response, what: str) -> dict:
        try:
            body = response.json()
        except ValueError as exc:
            raise PlantUnavailable(f"the gateway's {what} was not JSON") from exc
        if not isinstance(body, dict):
            raise PlantUnavailable(f"the gateway's {what} was not an object")
        return body

    async def engines(self, app, *, live: bool) -> list[dict]:
        """Every engine, builtin first. `live` asks the gateway to observe each
        one now instead of answering from its cache."""
        response = await self._request(
            app, "GET", ENGINES_PATH, params={"live": "true" if live else "false"}
        )
        if response.status_code != 200:
            raise PlantUnavailable(f"the gateway refused {ENGINES_PATH} — {_error_of(response)}")
        found = self._object(response, "engine list").get("engines")
        if not isinstance(found, list) or not all(
            isinstance(view, dict) and isinstance(view.get("name"), str) and view["name"]
            for view in found
        ):
            raise PlantUnavailable("the gateway's engine list did not name its engines")
        return found

    async def engine(self, app, name: str) -> dict:
        """One engine in full: its view plus its card (`vram`, `fit_frame`)."""
        path = _engine_path(name)
        response = await self._request(app, "GET", path)
        if response.status_code == 404:
            raise UnknownMachine(_error_of(response))
        if response.status_code != 200:
            raise PlantUnavailable(f"the gateway refused {path} — {_error_of(response)}")
        return self._object(response, f"reading of {name}")

    async def set_serving(self, app, name: str, serving: bool) -> dict:
        """Set one machine's serving switch, then READ IT BACK: PUT, then GET,
        and what is returned is the GET — never the value that was sent."""
        path = _engine_path(name)
        response = await self._request(app, "PUT", path, json={"serving": serving})
        if response.status_code == 404:
            raise UnknownMachine(_error_of(response))
        if response.status_code != 200:
            raise PlantUnavailable(
                f"the gateway refused to set {name}'s switch — {_error_of(response)}"
            )
        return await self.engine(app, name)

    async def model_providers(self, app) -> tuple[list[dict], list[dict]]:
        """The gateway's providers (/admin/providers) and live walls
        (/admin/routes "walls"), each exactly as served. Providers are read
        first; a failed read raises and the other is never returned alone."""
        providers = await self._list(app, PROVIDERS_PATH, "providers", "provider list")
        walls = await self._list(app, ROUTES_PATH, "walls", "route list's walls")
        return providers, walls

    async def _list(self, app, path: str, key: str, what: str) -> list[dict]:
        """GET `path` and return its `key`: a list of objects, or PlantUnavailable
        in words naming `what` was read."""
        response = await self._request(app, "GET", path)
        if response.status_code != 200:
            raise PlantUnavailable(f"the gateway refused {path} — {_error_of(response)}")
        found = self._object(response, what).get(key)
        if not isinstance(found, list) or not all(isinstance(entry, dict) for entry in found):
            raise PlantUnavailable(f"the gateway's {what} was not a list of objects")
        return found

    async def hub_version(self) -> str | None:
        """The hub's build of Nova's agent, which every agent this plant lists
        is compared with (S42b) — None when there is no build to read, so
        each comparison reads "unknown" rather than a guess."""
        return await agent_dist.version()

    async def agents(self, app) -> list[dict]:
        """Nova's agent on each paired machine (S42a): the live device rows,
        whether each is connected NOW (the hub's registry — never a stored
        flag), and what its facts say, as device_facts.agent_view. Core's own
        records, so no gateway call; the name is the plant's so an eval
        replay can answer with its declared devices instead (FixturePlant).

        S42b: each device's door and latest update attempt ride along from
        `devices.rows_with_last_update` (the ONE place that lateral join is
        written — Task 16 fix round 1, I3; it used to be a second copy of
        the SQL here), read with `devices._last_update`; each build is
        compared with `self.hub_version()` — the hub's real build here, the
        replay's own in FixturePlant."""
        pool = await db.get_pool()
        rows = await devices.rows_with_last_update(pool, live_only=True)
        connected = devices_ws.hub.connected_ids()
        hub_version = await self.hub_version()
        return [
            device_facts.agent_view(
                name=row["name"],
                platform=row["platform"],
                hostname=row["hostname"],
                connected=str(row["id"]) in connected,
                last_seen=row["last_seen"],
                facts=row["facts"],
                facts_at=row["facts_at"],
                hub_version=hub_version,
                last_transport=row["last_transport"],
                last_update=devices._last_update(row),
            )
            for row in rows
        ]

    async def paired_machines(self, app) -> list[dict]:
        """The paired machines a re-pair card can name (S42b): each live
        device's id, name and platform, by name — core's own records, the
        rows `agents` lists. FixturePlant answers with a replay's declared
        devices alone."""
        pool = await db.get_pool()
        rows = await devices.rows_with_last_update(pool, live_only=True)
        return [
            {
                "id": row["id"],
                "name": row["name"],
                "platform": row["platform"],
                "hostname": row["hostname"],
            }
            for row in rows
        ]

    async def machine_groups(self, app) -> dict[str, str | None]:
        """Every live paired device's name and the machine its agent reported
        (devices.live_machines: its machine_uid, None where that cannot be
        read) — the grouping the said-not-done device claim reads (fix round
        4, R5): a call on another agent of the same machine is a call on that
        machine. Read through the plant (Task 32, MF5), so a replay answers
        with its declared devices instead (FixturePlant)."""
        pool = await db.get_pool()
        return await devices.live_machines(pool)

    def replay_agent(self, name: str) -> ReplayAgent | None:
        """None: a real device's agent is reached through the hub. An eval
        replay's plant answers for a declared device that declares run
        answers (FixturePlant.replay_agent, S29b T5)."""
        return None

    async def paired_device(self, app, name: str):
        """The live device row a device tool acts on, by the name she gave
        (Task 22 fix round 1, 6) — read through the plant so that a replay
        answers instead: no real row is resolved, and so no command reaches
        a real agent, during an eval. A name no live row has is
        UnknownMachine, said with the live names (_no_paired_device). The
        name is resolved by resolve_name against each live row's name and
        hostname (walk-fixes T2)."""
        pool = await db.get_pool()
        known = await pool.fetch("SELECT name, hostname FROM devices WHERE revoked_at IS NULL")
        resolved = resolve_name(name, [(r["name"], r["hostname"]) for r in known])
        row = await devices.get_live_by_name(pool, resolved) if resolved is not None else None
        if row is None:
            live = sorted(
                d["name"] for d in await devices.list_devices(pool) if d["revoked_at"] is None
            )
            raise UnknownMachine(_no_paired_device(name, live))
        return row

    async def live_devices(self, app) -> list:
        """Every LIVE (unrevoked) device row, with its hostname — what
        code_repo.repo_machine matches NOVA_REPO_HOST against (the S32
        worktree part, T2). Read through the plant so a replay answers
        instead (FixturePlant: none)."""
        pool = await db.get_pool()
        return list(await devices.rows_with_last_update(pool, live_only=True))

    async def knocks(self, app) -> list[dict]:
        """Each revoked agent that knocked in the last day (P28), newest first
        — devices.revoked_knocks, read through the plant so device_list's
        knock section is a replay's own too (S42b Task 22, the
        replay-hermeticity ruling: FixturePlant reports none)."""
        pool = await db.get_pool()
        return [dict(row) for row in await devices.revoked_knocks(pool)]

    async def update_agent(
        self,
        app,
        name: str,
        *,
        requested_by: str,
        facts_sink: list[dict] | None = None,
        progress: Callable[[str], None] | None = None,
    ) -> dict:
        """Send the hub's build to `name`'s agent now (S42b decision 2's
        "update it now") and say what the ledger holds once it answers —
        current, sent (confirmed only by its reconnect, P8, waited on up to
        agent_updates.WAIT_S), confirmed, rolled back, not confirmed,
        refused, or a stated cannot: agent_updates.UpdateOutcome as a dict.

        `hub` says whether its agent came in through the hub machine's own
        door (`last_transport`) — never that it IS the hub machine's: a relay
        on the hub (a tunnel, an ssh -L) comes in through that door too.
        `facts_sink` is the calling tool's: update_now records on it the
        connectivity it determined. The state guard reads that fact once Task
        23 counts a failed machine_update span — until then it counts a
        failed span's facts only for device_* tools, so an offline cannot's
        fact is recorded but backs nothing yet (Task 22 fix round 1, I1).
        `progress` is the calling tool's too: update_now says the wait on it,
        and a Stop it raises ends the call with the attempt still `sent`.

        The bundled engine's reserved name (D8) and a name no live machine
        has are UnknownMachine, said with what IS paired (_cannot_update),
        before anything is sent or recorded."""
        pool = await db.get_pool()
        rows = await devices.rows_with_last_update(pool, live_only=True)
        paired = [(row["name"], row["last_transport"] == "host") for row in rows]
        if devices._reserved(name):
            raise UnknownMachine(_cannot_update(name, paired))
        resolved = resolve_name(name, [(r["name"], r["hostname"]) for r in rows])
        row = next((r for r in rows if r["name"] == resolved), None)
        if row is None:
            raise UnknownMachine(_cannot_update(name, paired))
        name = row["name"]
        outcome = await agent_updates.update_now(
            pool,
            name=name,
            requested_by=requested_by,
            # Read at call time, so the wait is the module's one number.
            wait_s=agent_updates.WAIT_S,
            facts_sink=facts_sink,
            progress=progress,
        )
        return {**dataclasses.asdict(outcome), "hub": row["last_transport"] == "host"}


def _no_paired_device(name: str, live: list[str]) -> str:
    """The device tools' cannot for a name no live device has — the words a
    real hub and a replay both say, each with its own listing, so a scored
    turn reads nothing it could tell a replay by."""
    known = f"the paired devices are: {', '.join(live)}" if live else "no device is paired"
    return (
        f"cannot: no paired device named {name!r} — {known}; check the name in Settings → "
        "Devices (a revoked device is gone until it is paired again)"
    )


def _cannot_update(name: str, paired: list[tuple[str, bool]]) -> str:
    """The stated cannot for a name machine_update has no agent to send to,
    said with what IS paired so she can name the right one — `paired` is
    (name, came in through the hub machine's own door) for each live
    machine, in the order it is listed.

    'hub' is the bundled engine's reserved name (D8), and no paired machine
    carries it. The machine her "hub" may mean is named by the one fact core
    has, its door, and said as exactly that: a relay on the hub (the owner's
    tunnel, an ssh -L) comes in through the hub machine's own loopback door
    too, so the door never says which machine IS the hub (the controller's
    ruling, "the door is not identity")."""
    if devices._reserved(name):
        door = [machine for machine, hub in paired if hub]
        if not door:
            through = "No paired machine's agent came in through the hub machine's own door."
        elif len(door) == 1:
            through = (
                f"One paired machine's agent came in through the hub machine's own door: {door[0]}."
            )
        else:
            through = (
                "These paired machines' agents came in through the hub machine's own door: "
                f"{', '.join(door)}."
            )
        return (
            f"cannot: {name.strip()!r} is the bundled engine's name (hub decision D8), and no "
            f"paired machine carries it — machine_update takes a paired machine's own name. "
            f"{through}"
        )
    names = ", ".join(machine for machine, _ in paired)
    known = f"the paired machines are: {names}" if names else "no machine is paired"
    return f"cannot: no paired machine named {name!r} — {known}"


PLANT: ContextVar[GatewayPlant] = ContextVar("machines_plant", default=GatewayPlant())


def plant() -> GatewayPlant:
    """The reader this task talks to: the gateway, or an eval's overlay."""
    return PLANT.get()


def split(model: str, engines: Collection[str]) -> tuple[str | None, str]:
    """(machine, the rest) when `model` names one of `engines` before its
    first colon; (None, model) otherwise. `qwen3.8:27b` and `qwen3:8b` keep
    their own colon: only the gateway's list can tell a machine from a name."""
    head, sep, rest = model.partition(":")
    if sep and rest and head in engines:
        return head, rest
    return None, model


async def cards(app) -> list[tuple[dict, dict | None]]:
    """Every engine with its full reading (the card: `vram`, `fit_frame`) —
    or None for a machine that sleeps on its own and is not answering now,
    which is never woken just to be read.

    A reading one machine could not give is carried as a reading with its
    reason (`vram.reason`), never as a missing machine: the others still
    answered. Only the LIST failing raises (PlantUnavailable)."""
    reader = plant()
    out: list[tuple[dict, dict | None]] = []
    for view in await reader.engines(app, live=False):
        if view.get("lifecycle") == "wake_on_lan" and view.get("state") != "ready":
            out.append((view, None))
            continue
        try:
            detail = await reader.engine(app, view["name"])
        except (PlantUnavailable, UnknownMachine) as exc:
            detail = {**view, "vram": {"total_mb": None, "reason": str(exc)}}
        out.append((view, detail))
    return out


NO_CARD = "the gateway lists no machine whose card could be read"


def _vram_of(detail: dict) -> dict:
    vram = detail.get("vram")
    return vram if isinstance(vram, dict) else {}


def the_card(pairs: list[tuple[dict, dict | None]]) -> tuple[dict, dict] | str:
    """THE machine's card among `cards()`'s pairs — (view, detail) — or, as a
    string, the reason there is none. The one selection every card reader
    uses (the inference check, the resources panel).

    Chosen by READABILITY (`vram.total_mb` is not None), never by how many
    machines answered: the hub reads exactly one card, its own, and states
    every other machine's unreadable (gateway NOT_THIS_CARD), so hub plus an
    always-on node is still one card. Two readable cards are never guessed
    between. With none readable, a single machine that gave a reading is
    returned anyway, so its own reason (`vram.reason`) is what the reader
    states; several say each one's reason."""
    read = [(view, detail) for view, detail in pairs if detail is not None]
    readable = [pair for pair in read if _vram_of(pair[1]).get("total_mb") is not None]
    if len(readable) == 1:
        return readable[0]
    if readable:
        return (
            f"{len(readable)} machines report a card that can be read, and which one is "
            "meant is not matched here"
        )
    if len(read) == 1:
        return read[0]
    if not read:
        return NO_CARD
    return "no machine's card could be read — " + "; ".join(
        f"{view['name']}: {_vram_of(detail).get('reason') or 'no reason stated'}"
        for view, detail in read
    )


# A declared eval machine starts as a live, always-on one that answered now —
# never the bundled engine, which is the owner's real hub.
_FIXTURE_DEFAULTS: dict = {
    "builtin": False,
    "lifecycle": "always_on",
    "serving": True,
    "state": "ready",
    "reason": None,
    "observed_at": None,
    "answered": True,
    "tags": {},
    "tags_as_of": None,
    "compute": None,
    "runtime": None,
    "facts": {},
}


def _fixture_state(spec: dict, serving: object) -> str:
    """The gateway's own rule (r1-engines, "Engine state"; ruling C8): a
    machine switched off reads `switched_off`; one switched on reads what it
    was declared as — `ready` unless the case said otherwise. A declared
    `switched_off` was the SWITCH's state, not the machine's (T7's
    FixtureMachine(serving=False) declares both), so switched on it reads
    `ready`: never serving true and switched off at once."""
    if not serving:
        return "switched_off"
    declared = spec.get("state", "ready")
    return "ready" if declared == "switched_off" else declared


# A replay's hub build (S42b, ruling F11): no build is read during an eval.
# Every agent a replay lists — its declared devices, the only ones it holds
# (Task 22's hermeticity ruling) — is compared with this, and
# FixturePlant.update_agent answers it, so one replay never names two hub
# builds.
FIXTURE_HUB_VERSION = "0f1e2d3c4b5a"
# The outcomes a replay may declare for a device's machine_update (S42b Task
# 22): every one the tool says in words. Not "cannot" — a cannot is a reason,
# and a declaration carries none.
FIXTURE_UPDATE_OUTCOMES: tuple[str, ...] = (
    "current",
    "sent",
    "confirmed",
    "rolled_back",
    "not_confirmed",
    "refused",
)
# The one capability a declared device answers in a replay (S29b T5):
# device_run's. Every other acting tool still gets the no-key cannot.
FIXTURE_RUN_CAPABILITY = "shell.exec"
_RUN_ANSWER_KEYS = frozenset({"argv", "exit_code", "output"})


def run_answers(raw: object) -> tuple[dict, ...]:
    """A declared device's `run` answers (S29b T5), checked and normalized:
    a non-empty list of {"argv": [text, ...] (non-empty), "exit_code": int,
    "output": text (default "")} — the words of a real shell.exec result
    frame, never stdout/stderr. argv keys the answer, so one argv twice is
    malformed. Raises ValueError naming "device's run"; cases.device_from_dict
    restates it as a CaseError at LOAD, and FixturePlant refuses it at
    construction."""
    if not isinstance(raw, list) or not raw:
        raise ValueError(f"a case device's run must be a non-empty list of answers, got {raw!r}")
    out: list[dict] = []
    seen: set[tuple[str, ...]] = set()
    for entry in raw:
        if not isinstance(entry, dict):
            raise ValueError(f"a case device's run answer must be an object, got {entry!r}")
        unknown = sorted(set(entry) - _RUN_ANSWER_KEYS)
        if unknown:
            raise ValueError(
                f"a case device's run answer takes only {', '.join(sorted(_RUN_ANSWER_KEYS))}, "
                f"got {', '.join(map(repr, unknown))}"
            )
        argv = entry.get("argv")
        if (
            not isinstance(argv, list)
            or not argv
            or not all(isinstance(element, str) for element in argv)
        ):
            raise ValueError(
                f"a case device's run argv must be a non-empty list of text, got {argv!r}"
            )
        code = entry.get("exit_code")
        if isinstance(code, bool) or not isinstance(code, int):
            raise ValueError(f"a case device's run exit_code must be an integer, got {code!r}")
        output = entry.get("output", "")
        if not isinstance(output, str):
            raise ValueError(f"a case device's run output must be text, got {output!r}")
        key = tuple(argv)
        if key in seen:
            raise ValueError(f"a case device's run answers {argv!r} twice")
        seen.add(key)
        out.append({"argv": list(argv), "exit_code": code, "output": output})
    return tuple(out)


@dataclasses.dataclass(frozen=True)
class ReplayAgent:
    """A declared device's agent in a replay that declares run answers (S29b
    T5): what tools/devices reads INSTEAD of the hub for this one device —
    its connectivity is the declaration's `connected`, never a socket, and
    a command is answered from the declaration, never sent. Nothing real is
    touched.

    Only device_run's capability is answered, and only an argv declared
    exactly (a prefix or an extension is another command). Anything else is
    a stated cannot — never a made-up success — in words that say nothing
    about the replay: a scored turn must not be able to tell it is measured
    (S40 fix wave B3)."""

    name: str
    connected: bool
    answers: dict[tuple[str, ...], dict]

    def answer(self, capability: str, args: dict) -> dict:
        """The result frame a real agent would send for this command, or
        devices.DeviceRefused (tools/devices._command restates it as the
        ToolFailure the model reads)."""
        if capability != FIXTURE_RUN_CAPABILITY:
            raise devices.DeviceRefused(
                f"cannot: no command can be sent to {self.name}'s agent — no pairing key of "
                "its is on record"
            )
        argv = args.get("argv")
        found = (
            self.answers.get(tuple(argv))
            if isinstance(argv, list) and all(isinstance(a, str) for a in argv)
            else None
        )
        if found is None:
            raise devices.DeviceRefused(
                f"cannot: {self.name}'s agent gave no answer for {argv!r} — the command was not run"
            )
        return {"ok": True, "exit_code": found["exit_code"], "output": found["output"]}


class FixturePlant(GatewayPlant):
    """The eval harness's world: named `eval_*` machines that exist only for
    one replay, overlaid on the real list.

    READS of anything else are the gateway's, delegated untouched — a case
    measures her real tools against the machines it declared, beside the real
    ones. Nova's AGENTS are the exception (S42b Task 22, the
    replay-hermeticity ruling): the replay lists, reports knocks for and
    updates its declared devices alone, and never reads a real one.

    A WRITE to anything else is refused before any HTTP (ruling C8): a live
    eval in which the model misreads the case and reaches for `hub` would
    otherwise switch off the owner's real engine, and every later case and his
    own chat would be answered by the cloud. The refusal says CANNOT, in words
    machine_configure relays; it is a fact about this replay, not a judgment.

    Nothing it says to a tool mentions evals (S40 fix wave B3): the refusal
    and a declared machine's card reason reach the model inside a scored turn,
    and a turn that can tell it is being measured is not the turn being
    measured. Why a write was refused — an eval never changes a real machine
    — goes to the log, where a person reads it."""

    def __init__(
        self,
        fixtures: dict[str, dict],
        devices: dict[str, dict] | None = None,
        updates: dict[str, str] | None = None,
        runs: dict[str, list[dict]] | None = None,
    ) -> None:
        # The roster's own reserved prefix (agents.EVAL_FIXTURE_PREFIX), read
        # here rather than retyped. Imported in the call: app.agents imports
        # app.tools, which imports the tool module that imports this one.
        from app import agents

        self._prefix = agents.EVAL_FIXTURE_PREFIX
        declared_devices = devices or {}
        wrong = sorted(
            name for name in (*fixtures, *declared_devices) if not name.startswith(self._prefix)
        )
        if wrong:
            raise ValueError(
                f"a fixture machine must be named {self._prefix}…, got {', '.join(wrong)}"
            )
        # What machine_update answers for each declared device (S42b Task
        # 22) — "sent" for one that declares nothing. Refused at
        # construction, like a name without the prefix: an outcome for a
        # device the case did not declare, or one the tool has no words for.
        self._updates = dict(updates or {})
        stray = sorted(name for name in self._updates if name not in declared_devices)
        if stray:
            raise ValueError(f"an update is declared for no declared device: {', '.join(stray)}")
        unsaid = sorted(
            repr(outcome)
            for outcome in self._updates.values()
            if outcome not in FIXTURE_UPDATE_OUTCOMES
        )
        if unsaid:
            raise ValueError(
                f"a declared update must be one of {', '.join(FIXTURE_UPDATE_OUTCOMES)}, got "
                f"{', '.join(unsaid)}"
            )
        # What device_run answers on each declared device (S29b T5), keyed
        # by exact argv — refused at construction, like `updates`, for a
        # device the case did not declare or an answer of the wrong shape.
        runs = runs or {}
        stray_runs = sorted(name for name in runs if name not in declared_devices)
        if stray_runs:
            raise ValueError(
                f"run answers are declared for no declared device: {', '.join(stray_runs)}"
            )
        self._runs = {
            name: {tuple(a["argv"]): a for a in run_answers(list(answers))}
            for name, answers in runs.items()
        }
        self._specs = {name: copy.deepcopy(spec) for name, spec in fixtures.items()}
        self._views: dict[str, dict] = {}
        for name, spec in self._specs.items():
            view = {**copy.deepcopy(_FIXTURE_DEFAULTS), **copy.deepcopy(spec), "name": name}
            view["state"] = _fixture_state(spec, view["serving"])
            if "answered" not in spec:
                # What the declared state says about the reading, as the
                # gateway's would: unreachable did not answer, unobserved was
                # not asked; anything else answered.
                view["answered"] = {"unreachable": False, "unobserved": None}.get(
                    spec.get("state", "ready"), True
                )
            self._views[name] = view
        self._devices = {name: copy.deepcopy(view) for name, view in declared_devices.items()}

    def _mine(self, name: str) -> bool:
        return name.startswith(self._prefix)

    @staticmethod
    def _stamped(view: dict) -> dict:
        out = copy.deepcopy(view)
        if out["observed_at"] is None:
            out["observed_at"] = datetime.now(UTC).isoformat()
        return out

    async def engines(self, app, *, live: bool) -> list[dict]:
        real = [
            view for view in await super().engines(app, live=live) if not self._mine(view["name"])
        ]
        return real + [self._stamped(view) for view in self._views.values()]

    async def hub_version(self) -> str | None:
        """The replay's own hub build — never the real one (F11)."""
        return FIXTURE_HUB_VERSION

    async def agents(self, app) -> list[dict]:
        """This case's declared devices ALONE (S42a; S42b Task 22, the
        replay-hermeticity ruling) — never a real row, which is never even
        read: a replay whose machine_status listed the owner's real machines
        beside the declared ones showed her a machine its own re-pair card
        and machine_update then called unpaired. Nothing is written: a
        declared device exists for this replay only, and the device TOOLS do
        not see it (no key exists to sign for).

        Each declared device's `build` is recomputed from its own
        agent_version against the replay's hub build, fresh on every
        listing (F11)."""
        hub_version = await self.hub_version()
        declared = []
        for view in self._devices.values():
            out = copy.deepcopy(view)
            out["build"] = device_facts.build_state(out.get("agent_version"), hub_version)
            declared.append(out)
        return declared

    async def live_devices(self, app) -> list:
        """None (the replay-hermeticity ruling): a declared device has no row,
        and a real row is never read — so no replay resolves her repository's
        machine, and no git command reaches a real agent."""
        return []

    async def knocks(self, app) -> list[dict]:
        """None (the replay-hermeticity ruling): a case declares no revoked
        device — cases.FixtureDevice has no such field — so a replay has no
        knock to report, and the real table's are never read."""
        return []

    async def paired_machines(self, app) -> list[dict]:
        """This replay's declared devices ALONE — never a real row (S42b fix
        round 1): a card made inside a replay must not name a real machine,
        list one, or bind a code to one. A declared device has no row, so no
        id; the replay's code (runner._fixture_mint) binds nothing anyway."""
        return [
            {
                "id": None,
                "name": name,
                "platform": view["platform"],
                "hostname": view.get("hostname"),
            }
            for name, view in sorted(self._devices.items())
        ]

    async def machine_groups(self, app) -> dict[str, str | None]:
        """This replay's declared devices ALONE, each with the machine its
        declared facts report (device_facts.view_machine, the live rows' rule)
        — None, standing alone, for a device whose facts declare no
        machine_uid (Task 32, MF5). Never a real row: a declared name that
        matches a real paired device's would pick up that real machine, and a
        guard's verdict in a replay would hang on the owner's registry."""
        return {name: device_facts.view_machine(view) for name, view in self._devices.items()}

    def replay_agent(self, name: str) -> ReplayAgent | None:
        """The declared device's ReplayAgent when the case declared run
        answers for it (S29b T5); None for any other name."""
        if name not in self._runs:
            return None
        return ReplayAgent(
            name=name,
            connected=bool(self._devices[name].get("connected")),
            answers=copy.deepcopy(self._runs[name]),
        )

    def _resolved(self, name: str) -> str:
        """The declared device `name` means (resolve_name over the declared
        names and hostnames), or `name` as given when none does."""
        known = [(device, view.get("hostname")) for device, view in self._devices.items()]
        return resolve_name(name, known) or name

    async def paired_device(self, app, name: str):
        """Never a real row (Task 22 fix round 1, 6): a replay acts on no real
        machine. A declared device has no agent a command could reach — it
        was never paired, so no key of its is on record — and any other name
        is not a paired device in the replay's world, said with the declared
        listing. Neither the real registry nor the hub is touched; why a real
        name was refused goes to the log, never to the tool.

        The one exception (S29b T5): a declared device whose case declares
        run answers resolves to a row built from its declaration (no id — it
        has no registry row), and tools/devices then reads its ReplayAgent
        (replay_agent) for connectivity and the command, never the hub.

        The name is resolved against the declared names and hostnames by
        resolve_name first (walk-fixes T2), as a real hub resolves its rows."""
        name = self._resolved(name)
        if name in self._runs:
            view = self._devices[name]
            return {
                "id": None,
                "name": name,
                "platform": view["platform"],
                "hostname": view["hostname"],
                # The plant holds the declared VIEW (agent_view), not the
                # agent's raw facts, so a replay's row reports none: an
                # @folder cwd is refused there as for an agent that filed no
                # folders (known limit, S29b T5).
                "facts": None,
            }
        if name in self._devices:
            raise UnknownMachine(
                f"cannot: no command can be sent to {name}'s agent — no pairing key of its is "
                "on record"
            )
        logger.info(
            "eval replay: a device tool for %r answered as no paired device — a replay never "
            "acts on a real machine",
            name,
        )
        raise UnknownMachine(_no_paired_device(name, sorted(self._devices)))

    async def update_agent(
        self,
        app,
        name: str,
        *,
        requested_by: str,
        facts_sink: list[dict] | None = None,
        progress: Callable[[str], None] | None = None,
    ) -> dict:
        """A declared device answers from this replay's declaration (S42b
        Task 22) — its declared outcome, "sent" when it declares none, at
        the replay's hub build — and nothing is sent anywhere: no agent, no
        ledger row, no connection read, so nothing lands on facts_sink, and
        nothing is waited on, so nothing is said on `progress`.

        Every other name is answered as the replay's own listing says (the
        replay-hermeticity ruling): the engine's reserved name, or no paired
        machine by that name, in the words a real hub uses. A real machine is
        never updated from inside a replay; why goes to the log, where a
        person reads it — never to the tool, which a scored turn reads."""
        paired = [(device, bool(view.get("hub"))) for device, view in self._devices.items()]
        if not devices._reserved(name):
            name = self._resolved(name)
        if name not in self._devices or devices._reserved(name):
            if not devices._reserved(name):
                logger.info(
                    "eval replay: machine_update for %r answered as no paired machine — a "
                    "replay never updates a real machine",
                    name,
                )
            raise UnknownMachine(_cannot_update(name, paired))
        view = self._devices[name]
        return {
            "machine": name,
            "outcome": self._updates.get(name, "sent"),
            "version": FIXTURE_HUB_VERSION,
            "from_version": view.get("agent_version"),
            "reason": None,
            "attempt_id": None,
            "at": None,
            "needs_card": False,
            "in_flight": 0,
            "hub": bool(view.get("hub")),
        }

    async def engine(self, app, name: str) -> dict:
        if not self._mine(name):
            return await super().engine(app, name)
        if name not in self._views:
            raise UnknownMachine(f"no engine named {name!r}")
        return {
            **self._stamped(self._views[name]),
            "vram": {"total_mb": None, "reason": f"no card reading for {name}"},
            "fit_frame": None,
        }

    async def set_serving(self, app, name: str, serving: bool) -> dict:
        if not self._mine(name):
            logger.info(
                "eval plant: refused set_serving(%r, %r) before any HTTP — %r is not one of "
                "this case's declared machines, and an eval never changes a real machine",
                name,
                serving,
                name,
            )
            raise PlantUnavailable(
                f"cannot: {name!r} is not one of the machines that can be switched here"
            )
        if name not in self._views:
            raise UnknownMachine(f"no engine named {name!r}")
        view = self._views[name]
        view["serving"] = serving
        view["state"] = _fixture_state(self._specs[name], serving)
        return await self.engine(app, name)


def machine_json(view: dict) -> dict:
    """One machine in the shape the Settings tile reads (web api.ts Machine).
    A size the gateway did not state is None, never a zero nobody measured;
    and `models` is None when the machine could not be asked what it holds
    (tags None), never [] — an empty list is a machine that answered and
    holds nothing, and the tile says those two differently."""
    tags = view.get("tags")
    models = (
        [
            {
                "name": model,
                "size_bytes": size
                if isinstance(size, int) and not isinstance(size, bool)
                else None,
            }
            for model, size in sorted(tags.items())
        ]
        if isinstance(tags, dict)
        else None
    )
    return {
        "name": view["name"],
        "lifecycle": view.get("lifecycle"),
        "serving": view.get("serving"),
        "state": view.get("state"),
        "reason": view.get("reason"),
        "observed_at": view.get("observed_at"),
        "compute": view.get("compute"),
        "runtime": view.get("runtime"),
        "models": models,
    }
