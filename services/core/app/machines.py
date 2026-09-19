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
and nothing else in the process sees them.
"""

from __future__ import annotations

from collections.abc import Collection
from contextvars import ContextVar
from urllib.parse import quote

import httpx

from app import peers

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
