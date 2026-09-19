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
"""

from __future__ import annotations

import copy
import logging
from collections.abc import Collection
from contextvars import ContextVar
from datetime import UTC, datetime
from urllib.parse import quote

import httpx

from app import peers

logger = logging.getLogger("core")

ENGINES_PATH = "/admin/engines"
# One read of a short list or of one machine's card: the gateway answers from
# its per-engine cache (ready 30 s, failure 10 s) or one bounded observation.
TIMEOUT = httpx.Timeout(connect=5.0, read=15.0, write=5.0, pool=5.0)


class PlantUnavailable(RuntimeError):
    """The gateway could not be asked, refused, or answered something that is
    not what was asked for. The message is the reason, in words — a caller
    states it; it never reads it as "no machines"."""


class UnknownMachine(LookupError):
    """No engine by that name (the gateway's 404, in its own words)."""


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


class FixturePlant(GatewayPlant):
    """The eval harness's world: named `eval_*` machines that exist only for
    one replay, overlaid on the real list.

    READS of anything else are the gateway's, delegated untouched — a case
    measures her real tools against the machines it declared, beside the real
    ones. A WRITE to anything else is refused before any HTTP (ruling C8): a
    live eval in which the model misreads the case and reaches for `hub` would
    otherwise switch off the owner's real engine, and every later case and his
    own chat would be answered by the cloud. The refusal says CANNOT, in words
    machine_configure relays; it is a fact about this replay, not a judgment.

    Nothing it says to a tool mentions evals (S40 fix wave B3): the refusal
    and a declared machine's card reason reach the model inside a scored turn,
    and a turn that can tell it is being measured is not the turn being
    measured. Why a write was refused — an eval never changes a real machine
    — goes to the log, where a person reads it."""

    def __init__(self, fixtures: dict[str, dict]) -> None:
        # The roster's own reserved prefix (agents.EVAL_FIXTURE_PREFIX), read
        # here rather than retyped. Imported in the call: app.agents imports
        # app.tools, which imports the tool module that imports this one.
        from app import agents

        self._prefix = agents.EVAL_FIXTURE_PREFIX
        wrong = sorted(name for name in fixtures if not name.startswith(self._prefix))
        if wrong:
            raise ValueError(
                f"a fixture machine must be named {self._prefix}…, got {', '.join(wrong)}"
            )
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
