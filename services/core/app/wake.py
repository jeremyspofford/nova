"""Waking a machine, measured (S46a T5): machine_wake's whole path.

A wake is three facts, and this module states each only from its evidence:

  * SENT — the hub's own agent (the relay) reports it wrote the magic packets
    (novad's net.wake). The ledger row opens then, never before
    (wake_attempts.record_sent).
  * ANSWERED — the target's agent connected to core again after the send.
  * SERVING — a model the gateway routes to on that machine answered a GET of
    its endpoint.

Nothing here says a machine "woke": a send is not a wake (the packet can be
dropped, the card can be unarmed, the firmware can ignore Wi-Fi), so the
result says what was sent, then what answered and after how long, or that
nothing did within the wait. The outcome is wake_attempts.settle's, derived
from the row's columns, never passed in.

WHO SENDS. The relay is an agent that came in through the hub machine's own
door (devices.last_transport == "host"), connected now, with an IPv4
interface whose subnet holds one of the target's last-reported addresses —
read from the stored facts, never a list. The broadcast is that subnet's
directed broadcast; the agent re-checks it against its own interfaces and
refuses one it does not own (novad internal/wake.Route). None such is a
stated cannot ("no connected agent shares <machine>'s network"), recorded as
relay_cannot — a fact about whether the send CAN happen, never a may-not.

WHICH CARD. One adapter per attempt (the ledger holds one MAC per row, one
open row per machine): by default the target's ACTIVE adapter, the one whose
last-reported address sits on the relay's subnet; `adapter` names another
from its facts (the Ethernet a firmware lists for wake), stated when it had
no address at its last report. The MAC comes from the facts and goes to the
relay and the private row only — never into the result, a span or a log.

The seams below (_now, _sleep, _send, _providers_on, _serving) are the
outside world; tests replace each, so no packet, socket or real wait is in
any test. Whether an agent is connected is read through agent_updates.
_connected — the hub's socket registry, recorded as {device, connected} on
the facts_sink when one is passed — so every reading machine_wake states
(the target already connected, the hub's agent offline) is a fact the state
and wake-claim guards see; tests fake the registry under it.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from urllib.parse import quote, unquote

import httpx

from app import (
    agent_updates,
    db,
    devices,
    devices_ws,
    machines,
    model_machines,
    network,
    peers,
    wake_attempts,
)

logger = logging.getLogger("core")

# How often the wait looks again: the agent's reconnect, then its model.
POLL_S = 2
# The relay writes six datagrams; this bounds waiting on its answer.
RELAY_TIMEOUT_S = 30
# One look at a model endpoint during the wait.
SERVING_TIMEOUT = httpx.Timeout(5.0)

_MAC = re.compile(r"^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$")
_NOT_A_CARD = {"00:00:00:00:00:00", "ff:ff:ff:ff:ff:ff"}


class WakeCannot(Exception):
    """The wake cannot be sent (or its sending cannot be known), in words.
    Never a may-not: each says what is missing."""


class RelayCannot(WakeCannot):
    """No agent can send it: recorded as a relay_cannot attempt."""


class SendUnknown(WakeCannot):
    """Whether the packets left is not known (the relay never answered, or
    answered without a count, or its row could not be written): never
    stated as "not sent" (S46a T11)."""


@dataclass(frozen=True)
class Relay:
    id: object
    name: str
    iface: str
    broadcast: str
    # The target's adapter whose last-reported address is on the relay's subnet.
    adapter: str


def _utc(at: datetime) -> str:
    return at.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S UTC")


def _ifaces(facts: object) -> list:
    net = facts.get("net") if isinstance(facts, dict) else None
    ifaces = net.get("ifaces") if isinstance(net, dict) else None
    return [i for i in ifaces if isinstance(i, dict)] if isinstance(ifaces, list) else []


def _interfaces(cidrs: object) -> list[ipaddress.IPv4Interface]:
    out = []
    for cidr in cidrs if isinstance(cidrs, list) else ():
        try:
            iface = ipaddress.ip_interface(str(cidr))
        except ValueError:
            continue
        if iface.version == 4 and not (iface.ip.is_loopback or iface.ip.is_link_local):
            out.append(iface)
    return out


def adapters(facts: object) -> list[dict]:
    """The target's adapters a magic packet can name: every interface in its
    stored facts with a real hardware address, in the order reported —
    {name, mac, cidrs, up}. Loopback and tunnel interfaces carry none (or a
    zero one) and are left out."""
    found = []
    for iface in _ifaces(facts):
        mac = str(iface.get("mac") or "").lower()
        name = iface.get("name")
        if not _MAC.match(mac) or mac in _NOT_A_CARD or not isinstance(name, str):
            continue
        cidrs = iface.get("ipv4_cidr")
        found.append(
            {
                "name": name,
                "mac": mac,
                "cidrs": [str(c) for c in cidrs] if isinstance(cidrs, list) else [],
                "up": iface.get("up") is True,
            }
        )
    return found


def choose_relay(name: str, facts: object, candidates: list[dict]) -> Relay:
    """The agent that sends `name`'s wake: the first candidate that came in
    through the hub machine's own door, is connected, and has an IPv4
    interface whose subnet (a /30 or wider: a host route has no broadcast)
    holds one of `name`'s last-reported addresses. Candidates are
    {id, name, facts, connected, hub}. RelayCannot, in words, when none."""
    target = [
        (adapter["name"], iface)
        for adapter in adapters(facts)
        for iface in _interfaces(adapter["cidrs"])
    ]
    door = [c for c in candidates if c.get("hub") is True]
    live = [c for c in door if c.get("connected") is True]
    head = f"cannot: no connected agent shares {name}'s network"
    if not door:
        raise RelayCannot(
            f"{head} — no paired agent came in through the hub machine's own door, and the "
            "wake is sent from there"
        )
    if not live:
        names = ", ".join(str(c.get("name")) for c in door)
        raise RelayCannot(
            f"{head} — no agent that came in through the hub machine's own door is connected "
            f"now ({names} is offline)"
        )
    for candidate in live:
        for iface in _ifaces(candidate.get("facts")):
            for own in _interfaces(iface.get("ipv4_cidr")):
                if own.network.prefixlen > 30:
                    continue
                for adapter, theirs in target:
                    if theirs.ip in own.network and theirs.ip != own.ip:
                        return Relay(
                            id=candidate.get("id"),
                            name=str(candidate.get("name")),
                            iface=str(iface.get("name")),
                            broadcast=str(own.network.broadcast_address),
                            adapter=adapter,
                        )
    names = ", ".join(str(c.get("name")) for c in live)
    if not target:
        why = f"{name} reported no IPv4 address at its last report"
    else:
        why = f"the hub's agent {names} shares no subnet with {name}'s last-reported addresses"
    raise RelayCannot(f"{head} — {why}")


# -- the outside world (each a seam tests replace) ---------------------------------


def _now() -> datetime:
    return datetime.now(UTC)


async def _sleep(seconds: float) -> None:
    await asyncio.sleep(seconds)


async def _send(pool, relay: dict, args: dict, timeout: float) -> dict:
    """net.wake on the relay's agent: a signed envelope, its own result."""
    return await devices_ws.hub.command(
        pool,
        device_id=relay["id"],
        name=relay["name"],
        capability="net.wake",
        args=args,
        timeout=timeout,
    )


# The gateway's typed route fields that say a link's machine did not answer a
# dial (S46a T8: this request could not connect; T9: walled by a connect
# failure) — never its prose reason.
ROUTE_LINK_FIELDS = ("unreachable", "connect_walled")


def _route_ids(value: object) -> list[str]:
    """One typed route field's served ids: the header's comma-joined string
    (each id percent-quoted, so unquoted here) or the usage chunk's list."""
    if isinstance(value, str):
        return [unquote(part) for part in value.split(",") if part]
    if isinstance(value, (list, tuple)):
        return [part for part in value if isinstance(part, str) and part]
    return []


def route_targets(
    route_meta: object, providers: object, agents: object, peers: object
) -> list[dict]:
    """The paired machines a turn's route says to wake: [{device, links}], one
    per device, in link order (S46a T9).

    A link counts when the gateway typed it `unreachable` or `connect_walled`
    (route_meta: peers.route_fields' dict, or the chunk's route). Its provider
    (the id's part before the first ":") is looked up in `providers` and
    mapped to a paired device by model_machines.device_of — derived from the
    URL, the agents' addresses and the tailnet, never a name. The device is a
    target only when its agent is NOT connected: a connected agent means the
    machine is awake and the problem is not sleep. The hub never is (it is
    always on, and it is the relay). An unlisted provider, one on no paired
    machine, or an ambiguous one names nothing. Pure: no I/O."""
    if not isinstance(route_meta, dict):
        return []
    ids: list[str] = []
    for field in ROUTE_LINK_FIELDS:
        for served in _route_ids(route_meta.get(field)):
            if served not in ids:
                ids.append(served)
    if not ids:
        return []
    base_urls = {
        p.get("name"): p.get("base_url")
        for p in (providers if isinstance(providers, (list, tuple)) else ())
        if isinstance(p, dict)
    }
    agent_list = [
        a for a in (agents if isinstance(agents, (list, tuple)) else ()) if isinstance(a, dict)
    ]
    by_name = {a.get("name"): a for a in agent_list}
    targets: dict[str, list[str]] = {}
    for served in ids:
        provider = served.split(":", 1)[0]
        if provider not in base_urls:
            continue
        device = model_machines.device_of(base_urls[provider], agent_list, peers)["device"]
        agent = by_name.get(device)
        if agent is None or agent.get("hub") is True or agent.get("connected") is True:
            continue
        targets.setdefault(device, []).append(served)
    return [{"device": device, "links": links} for device, links in targets.items()]


async def _providers_on(app, name: str) -> tuple[list[dict], str | None]:
    """The gateway's providers that run on paired machine `name`
    ({name, base_url}), mapped by model_machines.device_of — derived from the
    live provider list, agents and tailnet, never a name. The reason when
    they could not be read."""
    reader = machines.plant()
    try:
        providers, walls = await reader.model_providers(app)
        agents = await reader.agents(app)
    except Exception as exc:  # noqa: BLE001 — stated in the result, in words
        return [], f"the gateway's model providers could not be read — {exc}"
    peers = network.tailnet_peers()
    return [
        {"name": remote["name"], "base_url": remote["base_url"]}
        for remote in model_machines.remotes_of(providers, walls, _now())
        if model_machines.device_of(remote["base_url"], agents, peers)["device"] == name
    ], None


async def _serving(app, provider: dict) -> bool:
    """Did the provider's model endpoint answer a GET of <base_url>/models with
    a 2xx just now? Any failure is "not yet", never an exception."""
    url = str(provider.get("base_url") or "").rstrip("/") + "/models"
    try:
        async with httpx.AsyncClient(timeout=SERVING_TIMEOUT) as client:
            response = await client.get(url)
    except httpx.HTTPError:
        return False
    return 200 <= response.status_code < 300


# -- the wake ---------------------------------------------------------------------


def _fact(name, attempt, outcome, *, sent, relay=None, adapter=None, answered=None, serving=None):
    return {
        "machine_wake": name,
        "attempt": str(attempt) if attempt is not None else None,
        "outcome": outcome,
        "sent": sent,
        "relay": relay,
        "adapter": adapter,
        "answered_after_s": answered,
        "serving_after_s": serving,
    }


def _after(at: datetime | None, sent_at: datetime) -> int | None:
    return None if at is None else int((at - sent_at).total_seconds())


async def wake_now(
    app,
    *,
    machine: str,
    adapter: str | None = None,
    wait_s: int = wake_attempts.DEFAULT_DEADLINE_S,
    trigger: str = "tool",
    facts_sink: list[dict] | None = None,
    progress: Callable[[str], None] | None = None,
    turn_id=None,
    on_sent: Callable[[object], None] | None = None,
) -> str:
    """Send `machine`'s wake through the relay and measure the answer for up
    to wait_s (clamped to the ledger's 30..600). Returns the words; raises
    WakeCannot when nothing can be sent or whether it was sent is unknown.
    `on_sent` is called with the attempt id the moment its row is written
    (the no-link reply waits for the send, never the answer — S46a T11)."""
    sink = facts_sink if facts_sink is not None else []
    rows = await machines.plant().live_devices(app)
    try:
        resolved = machines.resolve_name(machine, [(r["name"], r["hostname"]) for r in rows])
    except machines.UnknownMachine as exc:
        raise WakeCannot(str(exc)) from exc
    row = next((r for r in rows if r["name"] == resolved), None)
    if row is None:
        names = ", ".join(r["name"] for r in rows)
        known = f"the paired machines are: {names}" if names else "no machine is paired"
        raise WakeCannot(f"cannot: no paired machine named {machine!r} — {known}")
    name, target_id = row["name"], row["id"]
    pool = await db.get_pool()

    asked = wait_s
    used = min(max(int(wait_s), wake_attempts.DEADLINE_MIN_S), wake_attempts.DEADLINE_MAX_S)
    clamp = (
        f" (waited {used} s, not {asked}: a wake waits {wake_attempts.DEADLINE_MIN_S} to "
        f"{wake_attempts.DEADLINE_MAX_S} s)"
        if used != asked
        else ""
    )

    # An attempt whose deadline has passed is decided now, from its columns.
    opened = await wake_attempts.open_for(pool, target_id)
    if opened is not None:
        await wake_attempts.settle(pool, opened["id"], now=_now())

    if agent_updates._connected(row, sink):
        attempt = await wake_attempts.record_not_sent(
            pool,
            device_id=target_id,
            outcome="not_asleep",
            reason=f"{name}'s agent was connected when the wake was asked for",
            trigger=trigger,
            turn_id=turn_id,
        )
        sink.append(_fact(name, attempt, "not_asleep", sent=False))
        return f"{name} is already connected — its agent is connected now, so nothing was sent."

    opened = await wake_attempts.open_for(pool, target_id)
    if opened is not None:
        deadline = opened["sent_at"] + timedelta(seconds=opened["deadline_s"])
        raise WakeCannot(
            f"cannot now: a wake for {name} is already in flight — sent at "
            f"{_utc(opened['sent_at'])}, its wait runs to {_utc(deadline)}; nothing was sent"
        )

    cards = adapters(row["facts"])
    if not cards:
        raise WakeCannot(
            f"cannot: {name}'s facts list no adapter with a hardware address, so there is "
            "nothing to address a wake to"
        )
    chosen = None
    if adapter is not None:
        chosen = next((c for c in cards if c["name"] == adapter), None) or next(
            (c for c in cards if c["name"].casefold() == adapter.strip().casefold()), None
        )
        if chosen is None:
            listed = ", ".join(c["name"] for c in cards)
            raise WakeCannot(
                f"cannot: {name} has no adapter named {adapter!r} in its facts — its adapters "
                f"are: {listed}"
            )

    candidates = [
        {
            "id": r["id"],
            "name": r["name"],
            "facts": r["facts"],
            "connected": agent_updates._connected(r, sink),
            "hub": r["last_transport"] == "host",
        }
        for r in rows
        if r["id"] != target_id
    ]
    try:
        relay = choose_relay(name, row["facts"], candidates)
    except RelayCannot as exc:
        attempt = await wake_attempts.record_not_sent(
            pool,
            device_id=target_id,
            outcome="relay_cannot",
            reason=str(exc),
            trigger=trigger,
            adapter=chosen["name"] if chosen else None,
            mac=chosen["mac"] if chosen else None,
            turn_id=turn_id,
        )
        sink.append(_fact(name, attempt, "relay_cannot", sent=False))
        raise
    if chosen is None:
        chosen = next(c for c in cards if c["name"] == relay.adapter)

    providers, providers_error = await _providers_on(app, name)

    relay_ref = {
        "id": relay.id,
        "name": relay.name,
        "iface": relay.iface,
        "broadcast": relay.broadcast,
    }
    try:
        result = await _send(
            pool, relay_ref, {"mac": chosen["mac"], "broadcast": relay.broadcast}, RELAY_TIMEOUT_S
        )
    except devices_ws.NotSent as exc:
        reason = f"cannot: {relay.name}'s agent could not be given the wake — {exc.reason}"
        await _relay_cannot(pool, sink, name, target_id, relay, chosen, reason, trigger, turn_id)
        raise RelayCannot(f"{reason}; nothing was sent") from exc
    except devices.DeviceRefused as exc:
        raise SendUnknown(
            f"cannot say whether a wake left {relay.name}: {exc.reason} — the command reached "
            "its agent and no answer came back, so whether it sent is not known; nothing was "
            "recorded"
        ) from exc
    if not isinstance(result, dict) or not result.get("ok"):
        said = (result or {}).get("error") if isinstance(result, dict) else None
        reason = f"cannot: {relay.name}'s agent did not send it — {said or 'it gave no reason'}"
        await _relay_cannot(pool, sink, name, target_id, relay, chosen, reason, trigger, turn_id)
        raise RelayCannot(reason)
    meta = result.get("meta") if isinstance(result.get("meta"), dict) else {}
    packets = meta.get("sent")
    if isinstance(packets, bool) or not isinstance(packets, int) or packets < 1:
        raise SendUnknown(
            f"cannot say what left {relay.name}: its agent answered ok without saying how many "
            "packets it sent; nothing was recorded"
        )
    iface = meta.get("iface") if isinstance(meta.get("iface"), str) else relay.iface

    sent_at = _now()
    try:
        attempt = await wake_attempts.record_sent(
            pool,
            device_id=target_id,
            relay_device_id=relay.id,
            adapter=chosen["name"],
            mac=chosen["mac"],
            relay_iface=iface,
            broadcast=relay.broadcast,
            packets=packets,
            trigger=trigger,
            sent_at=sent_at,
            deadline_s=used,
            turn_id=turn_id,
        )
    except wake_attempts.AttemptOpen as exc:
        raise SendUnknown(
            f"a wake left {relay.name} at {_utc(sent_at)}, but {exc} — this one is not recorded"
        ) from exc

    if on_sent is not None:
        on_sent(attempt)

    deadline = sent_at + timedelta(seconds=used)
    answered_at: datetime | None = None
    serving_at: datetime | None = None
    served_by: str | None = None
    while True:
        now = _now()
        if now > deadline:
            break
        if answered_at is None and agent_updates._connected(row, None):
            if await wake_attempts.mark_answered(pool, attempt, now):
                answered_at = now
            if not providers:
                break
        if answered_at is not None and providers:
            for provider in providers:
                if await _serving(app, provider):
                    at = _now()
                    if await wake_attempts.mark_serving(pool, attempt, at):
                        serving_at, served_by = at, provider["name"]
                    break
            if serving_at is not None:
                break
        if progress is not None:
            elapsed = int((now - sent_at).total_seconds())
            stage = "its model" if answered_at is not None else "its agent"
            progress(f"waiting for {name} ({stage}) — {elapsed} of {used} s")
        await _sleep(POLL_S)

    outcome = await wake_attempts.settle(pool, attempt, now=_now())
    answered_s, serving_s = _after(answered_at, sent_at), _after(serving_at, sent_at)
    sink.append({"device": name, "connected": answered_at is not None})
    sink.append(
        _fact(
            name,
            attempt,
            outcome,
            sent=True,
            relay=relay.name,
            adapter=chosen["name"],
            answered=answered_s,
            serving=serving_s,
        )
    )

    words = (
        f"Wake sent at {_utc(sent_at)} from {relay.name} ({iface}) to {name}'s {chosen['name']} "
        f"({packets} packets)"
    )
    if not chosen["cidrs"]:
        words += " — that adapter had no address at its last report"
    words += "."
    if answered_at is None:
        words += (
            f" Then no answer within {used} s: {name}'s agent did not reconnect. Sending is not "
            f"waking — the packets left {relay.name}, and nothing shows {name} came up."
        )
    else:
        words += f" {name}'s agent reconnected after {answered_s} s."
        if served_by is not None:
            words += f" Its model ({served_by}) answered after {serving_s} s."
        elif providers:
            listed = ", ".join(p["name"] for p in providers)
            words += f" Its model ({listed}) did not answer within {used} s."
        else:
            if providers_error:
                words += f" Whether its model answers was not checked — {providers_error}."
            else:
                words += " It runs no model the gateway routes to, so nothing more was checked."
            if outcome is None:
                words += (
                    f" This attempt is decided at its deadline ({_utc(deadline)}), from what "
                    "it shows."
                )
    return words + clamp


async def _relay_cannot(
    pool, sink, name, target_id, relay, chosen, reason, trigger, turn_id=None
) -> None:
    attempt = await wake_attempts.record_not_sent(
        pool,
        device_id=target_id,
        outcome="relay_cannot",
        reason=reason,
        trigger=trigger,
        relay_device_id=relay.id,
        adapter=chosen["name"],
        mac=chosen["mac"],
        turn_id=turn_id,
    )
    sink.append(_fact(name, attempt, "relay_cannot", sent=False, relay=relay.name))


# -- the background wake from a turn's route (S46a T10) ------------------------
#
# The owner's "Don't wait, fall back" (2026-10-10): a turn whose route says a
# machine's link did not answer a dial is answered from the next link at once,
# and the machine is woken in the background for later turns. Nothing here is
# ever awaited by a turn: chat STARTS start_route_wakes and moves on. The tasks
# live in their own set, never chat._BACKGROUND — settle_detached and
# drain_background would otherwise hold a scheduled turn (or shutdown) for a
# wake's whole wait. The app's shutdown cancels them (cancel_route_wakes).

ROUTE_WAKES: set[asyncio.Task] = set()
# Machines a background wake is being sent to right now, in this process, to
# when it was claimed: the window between deciding to send and the row
# existing (the relay's answer can take RELAY_TIMEOUT_S) that the rows cannot
# cover yet. Which turn claimed it is not kept: it can be this turn's own
# earlier round, so the reason never names one.
_SENDING: dict[str, datetime] = {}
BACKGROUND_WAKE_SPAN = "background_wake"


@dataclass
class _TurnSends:
    """What one turn's route wakes decided about SENDING (S46a T11): the
    machines its route named, then per machine {"attempt": id} once its row
    is written, or {"reason": words[, "unknown": True]} when nothing was (or
    whether it was is not known). Read once by no_link_reply, then dropped."""

    targets: asyncio.Future
    sends: dict


# Per turn, the latest route's sends — popped by no_link_reply; bounded so a
# turn that never asks cannot grow it for ever.
_TURN_SENDS: dict = {}
_TURN_SENDS_MAX = 256


def _settle_future(future: asyncio.Future | None, value) -> None:
    if future is not None and not future.done():
        future.set_result(value)


def _track(coro, name: str) -> asyncio.Task:
    task = asyncio.create_task(coro, name=name)
    ROUTE_WAKES.add(task)
    task.add_done_callback(ROUTE_WAKES.discard)
    return task


def route_link_ids(route_meta: object) -> list[str]:
    """The typed route fields' served ids, in field then link order, once each."""
    if not isinstance(route_meta, dict):
        return []
    ids: list[str] = []
    for field in ROUTE_LINK_FIELDS:
        for served in _route_ids(route_meta.get(field)):
            if served not in ids:
                ids.append(served)
    return ids


async def _route_inputs(app) -> tuple[list[dict], list[dict], object]:
    """What route_targets maps with: the gateway's providers, the agents, the
    tailnet — each read live."""
    reader = machines.plant()
    providers, _walls = await reader.model_providers(app)
    agents = await reader.agents(app)
    return providers, agents, network.tailnet_peers()


async def _record_background(turn_id, machine: str | None, fact: dict, started: datetime) -> None:
    """File the background wake's fact as its own span of the turn — written
    when the task knows it, which is usually after the turn closed (a closed
    turn's spans are already written, so the llm_call span cannot carry it)."""
    try:
        pool = await db.get_pool()
        await pool.execute(
            "INSERT INTO turn_spans (turn_id, kind, name, started_at, duration_ms, meta) "
            "VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
            turn_id,
            BACKGROUND_WAKE_SPAN,
            machine,
            started,
            int((datetime.now(UTC) - started).total_seconds() * 1000),
            {BACKGROUND_WAKE_SPAN: fact},
        )
    except Exception:  # noqa: BLE001 — the trace write failing is logged, never raised
        logger.exception("background wake: its span for turn %s could not be written", turn_id)


def start_route_wakes(app, turn_id, route_meta: object) -> asyncio.Task | None:
    """Start, never await, the wakes a round's route asks for. None when the
    route types no link as unreachable or connect-walled."""
    links = route_link_ids(route_meta)
    if not links:
        return None
    entry = _TurnSends(targets=asyncio.get_running_loop().create_future(), sends={})
    _TURN_SENDS.pop(turn_id, None)
    _TURN_SENDS[turn_id] = entry
    while len(_TURN_SENDS) > _TURN_SENDS_MAX:
        _TURN_SENDS.pop(next(iter(_TURN_SENDS)))
    return _track(_route_wakes(app, turn_id, route_meta, links, entry), "route-wake")


async def _route_wakes(
    app, turn_id, route_meta: dict, links: list[str], entry: _TurnSends | None = None
) -> None:
    started = datetime.now(UTC)
    try:
        providers, agents, peers = await _route_inputs(app)
        targets = route_targets(route_meta, providers, agents, peers)
    except Exception as exc:  # noqa: BLE001 — recorded and logged, never raised
        logger.warning("background wake: the route's machines could not be read — %s", exc)
        reason = f"the route's machines could not be read — {type(exc).__name__}: {exc}"
        if entry is not None:
            _settle_future(entry.targets, [])
        await _record_background(
            turn_id, None, {"machine": None, "links": links, "reason": reason}, started
        )
        return
    if entry is not None:
        loop = asyncio.get_running_loop()
        for target in targets:
            entry.sends[target["device"]] = loop.create_future()
        _settle_future(entry.targets, targets)
    for target in targets:
        machine = target["device"]
        sent = entry.sends.get(machine) if entry is not None else None
        if machine in _SENDING:
            reason = (
                f"a wake for {machine} is already pending (attempt since {_utc(_SENDING[machine])})"
            )
            _settle_future(sent, {"reason": reason, "unknown": True})
            await _record_background(
                turn_id,
                machine,
                {"machine": machine, "links": target["links"], "reason": reason},
                started,
            )
            continue
        # Claimed with no await between the check and the add.
        _SENDING[machine] = _now()
        _track(
            _route_wake_one(app, turn_id, machine, target["links"], sent),
            f"route-wake:{machine}",
        )


async def _route_wake_one(
    app, turn_id, machine: str, links: list[str], sent: asyncio.Future | None = None
) -> None:
    started = datetime.now(UTC)
    fact: dict = {"machine": machine, "links": links}
    unknown = False
    try:
        rows = await machines.plant().live_devices(app)
        row = next((r for r in rows if r["name"] == machine), None)
        if row is None:
            fact["reason"] = f"{machine} is not a paired machine now"
        else:
            pool = await db.get_pool()
            reason = await wake_attempts.debounce_reason(pool, row["id"], machine, now=_now())
            if reason is not None:
                fact["reason"] = reason
            else:
                sink: list[dict] = []
                try:
                    await wake_now(
                        app,
                        machine=machine,
                        trigger="route",
                        turn_id=turn_id,
                        facts_sink=sink,
                        on_sent=lambda attempt: _settle_future(sent, {"attempt": attempt}),
                    )
                except WakeCannot as exc:
                    fact["reason"] = str(exc)
                    unknown = isinstance(exc, SendUnknown)
                said = next((f for f in reversed(sink) if "machine_wake" in f), None)
                if said is not None:
                    # The attempt and its outcome, as the wake recorded them;
                    # a reason beside them when nothing was sent.
                    reason = fact.pop("reason", None)
                    fact.update(attempt=said["attempt"], outcome=said["outcome"])
                    if reason is not None:
                        fact["reason"] = reason
                    if reason is None and said["attempt"] is not None:
                        try:
                            await announce_landing(app, turn_id, machine, said["attempt"])
                        except Exception as exc:  # noqa: BLE001 — logged, never raised
                            logger.warning(
                                "background wake of %s: its notice could not be filed — %s: %s",
                                machine,
                                type(exc).__name__,
                                exc,
                            )
    except asyncio.CancelledError:
        logger.info("background wake of %s cancelled (shutdown)", machine)
        raise
    except Exception as exc:  # noqa: BLE001 — recorded and logged, never raised into a turn
        logger.warning("background wake of %s failed — %s: %s", machine, type(exc).__name__, exc)
        fact["reason"] = f"the background wake failed — {type(exc).__name__}: {exc}"
        unknown = True
    finally:
        _SENDING.pop(machine, None)
        # What the no-link reply reads: the row when one was written, else why
        # not — or, when the wake ended without either, that it is not known.
        if fact.get("attempt") is not None:
            _settle_future(sent, {"attempt": fact["attempt"]})
        elif fact.get("reason"):
            _settle_future(sent, {"reason": fact["reason"], "unknown": unknown})
        else:
            _settle_future(
                sent, {"reason": "the background wake ended without a record", "unknown": True}
            )
    await _record_background(turn_id, machine, fact, started)


# -- a background wake that lands (S46a T12) -----------------------------------

WALL_TIMEOUT = httpx.Timeout(10.0)
_NOT_WALLED = "is not walled"


async def _lift_walls(app, machine: str) -> str | None:
    """Ask the gateway to lift its walls on every provider that runs on
    `machine` (DELETE /admin/routes/walls/{provider}: the provider's wall and
    each of its models'), so the next turn routes to the machine that just
    answered instead of passing it over until the wall lapses. The sentence
    for the notice, or None when there was no wall to lift. A clear that
    fails is logged and said — never left out."""
    providers, error = await _providers_on(app, machine)
    if error is not None:
        logger.warning("background wake: %s's walls were not lifted — %s", machine, error)
        return f"Its links' walls were not lifted — {error}."
    lifted: list[str] = []
    failed: list[str] = []
    for provider in providers:
        name = str(provider["name"])
        path = f"/admin/routes/walls/{quote(name, safe='')}"
        try:
            async with peers.client(app, peers.GATEWAY, WALL_TIMEOUT) as client:
                response = await client.delete(path)
        except (peers.PeerUnconfigured, httpx.HTTPError) as exc:
            why = f"the gateway could not be reached — {peers.reason(exc)}"
        else:
            if response.status_code == 200:
                lifted.append(name)
                continue
            if response.status_code == 404 and _NOT_WALLED in response.text:
                continue
            why = f"the gateway answered {response.status_code}"
        logger.warning(
            "background wake: the gateway's wall on %s (%s) could not be lifted — %s",
            name,
            machine,
            why,
        )
        failed.append(
            f"The gateway's wall on {name} could not be lifted ({why}); the next turn may pass "
            "it over until the wall lapses."
        )
    words = []
    if lifted:
        words.append(
            f"Lifted the gateway's wall on {', '.join(lifted)}, so the next turn can route to it."
        )
    words.extend(failed)
    return " ".join(words) or None


async def announce_landing(app, turn_id, machine: str, attempt) -> None:
    """File the one notice a background wake's attempt gets once its wait
    ended: answered (walls lifted first, so the notice says how that went)
    or no answer. Never a second one for the same attempt — keyed by its id,
    and an attempt already told is left alone (no second clear either)."""
    from app import notices
    from app.checks import wakes as wake_checks

    pool = await db.get_pool()
    row = await wake_attempts.get(pool, attempt)
    if row is None or wake_checks.finding_for(machine, row) is None:
        return
    told = await pool.fetchval(
        "SELECT 1 FROM notices WHERE check_name = $1 AND finding_key = $2 LIMIT 1",
        wake_checks.LANDED,
        f"wake_landed:{row['id']}",
    )
    if told:
        return
    walls = await _lift_walls(app, machine) if row.get("answered_at") is not None else None
    finding = wake_checks.finding_for(machine, row, walls)
    await notices.record(
        pool, finding, check_name=wake_checks.LANDED, turn_id=turn_id, firing_id=None
    )


async def cancel_route_wakes() -> None:
    """Shutdown: cancel every background wake and wait for each to end. A
    cancelled wake's open row is settled at its deadline by the next reader."""
    while ROUTE_WAKES:
        tasks = list(ROUTE_WAKES)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        ROUTE_WAKES.difference_update(tasks)


# -- no link left (S46a T11) -----------------------------------------------------
#
# The owner's "Don't wait, fall back" with nothing to fall back TO (the hub last
# resort OFF on his stack): the gateway answers 503 and its route names a
# machine's link as not answering a dial. The turn then closes ok with a
# statement built from the records — the machine's last-seen time, this turn's
# wake_attempts row (when it was sent, from which relay) or why nothing was
# sent, the gateway's other verdicts — never the model's words, never "asleep"
# (a statement only the machine can make, T30), never "woke".

# How long the reply waits for the SEND (the relay's answer), never the wake.
NO_LINK_WAIT_S = RELAY_TIMEOUT_S + 5
# A verdict's reason, cut to this many characters (at a word) in the reply.
VERDICT_REASON_MAX = 80
# The gateway's verdict list is "<id>: <reason>; <id>: <reason>…"; an item
# starts at "; " followed by a served id (no spaces) and ": ".
_VERDICT_SPLIT = re.compile(r"; (?=[^\s;]+: )")
_REFUSED = "(503): "


def _short(reason: str) -> str:
    reason = reason.strip()
    if len(reason) <= VERDICT_REASON_MAX:
        return reason
    cut = reason[:VERDICT_REASON_MAX].rsplit(" ", 1)[0].rstrip(" ,;:—-")
    return f"{cut}…"


def other_verdicts(detail: str, links: list[str]) -> str | None:
    """The gateway's 503 words, short, without the machine's own links: each
    other link as "<id>: <reason>" (reason cut to VERDICT_REASON_MAX), or the
    gateway's sentence when it listed no verdicts. None when the list holds
    only the machine's own links: the gateway gives every link of the chain a
    verdict, so no other model is in it. An item that is not "<id>: <reason>"
    is kept as written, never dropped (it is not known to be the machine's)."""
    sentence, sep, listed = detail.strip().partition(" — ")
    if not sep:
        return sentence.rstrip(". ")
    others = []
    for item in _VERDICT_SPLIT.split(listed):
        link, colon, reason = item.partition(": ")
        if not colon:
            if item.strip():
                others.append(_short(item).rstrip(". "))
            continue
        if link.strip() in links:
            continue
        others.append(f"{link.strip()}: {_short(reason)}".rstrip(". "))
    return "; ".join(others) if others else None


def _why(reason: str) -> str:
    for head in ("cannot now: ", "cannot: "):
        if reason.startswith(head):
            return reason[len(head) :]
    return reason


async def _no_link_sentence(pool, machine: str, said: dict | None, waited: float) -> str:
    seen = await pool.fetchval("SELECT last_seen FROM devices WHERE name = $1", machine)
    offline = (
        f"{machine} is offline (its agent last seen at {_utc(seen)})"
        if seen is not None
        else f"{machine} is offline (its agent has no last-seen record)"
    )
    if said is None:
        return (
            f"{offline} — whether a wake was sent is not known yet: the send had not "
            f"completed within {waited:g} s."
        )
    attempt = said.get("attempt")
    if attempt is not None:
        row = await wake_attempts.get(pool, attempt)
        if row is not None and row.get("sent_at") is not None:
            relay = (
                await pool.fetchval(
                    "SELECT name FROM devices WHERE id = $1", row.get("relay_device_id")
                )
                if row.get("relay_device_id") is not None
                else None
            )
            source = relay or "a relay no longer paired"
            return f"{offline} — I sent a wake at {_utc(row['sent_at'])} from {source}."
        if row is not None:
            return f"{offline} — no wake was sent: {_why(str(row.get('reason') or ''))}."
        return f"{offline} — whether a wake was sent is not known: its record is gone."
    reason = _why(str(said.get("reason") or "")).rstrip(". ")
    if said.get("unknown"):
        return f"{offline} — whether a wake was sent is not known: {reason}."
    return f"{offline} — no wake was sent: {reason}."


async def no_link_reply(app, turn_id, failure: str, *, timeout: float | None = None) -> str | None:
    """The turn's reply when no link could answer and its route named a
    machine to wake; None when this turn's route started no wake or named no
    paired, offline machine (the turn then keeps its stated failure).

    Waits up to `timeout` (NO_LINK_WAIT_S) for each wake's SEND to be decided
    — its row written, or why not — never for the machine to answer."""
    entry = _TURN_SENDS.pop(turn_id, None)
    if entry is None:
        return None
    wait = NO_LINK_WAIT_S if timeout is None else timeout
    loop = asyncio.get_running_loop()
    until = loop.time() + wait
    try:
        targets = await asyncio.wait_for(asyncio.shield(entry.targets), wait)
    except TimeoutError:
        return None
    if not targets:
        return None
    pool = await db.get_pool()
    sentences, links = [], []
    for target in targets:
        links.extend(target["links"])
        future = entry.sends.get(target["device"])
        said = None
        if future is not None:
            try:
                said = await asyncio.wait_for(asyncio.shield(future), max(until - loop.time(), 0))
            except TimeoutError:
                said = None
        sentences.append(await _no_link_sentence(pool, target["device"], said, wait))
    _head, sep, detail = failure.partition(_REFUSED)
    others = other_verdicts(detail if sep else failure, links)
    # "No other model could answer right now" is what the 503 itself says:
    # nothing in the chain could serve. Never "no other model is in the
    # chain" — core reads a truncated failure text, so a link past the cut is
    # unseen and that would be a claim about the chain it did not check.
    rest = (
        f"Nothing else could answer: {others}."
        if others
        else "No other model could answer right now."
    )
    return " ".join(sentences) + f" {rest} Ask again once it answers."
