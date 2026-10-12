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

import httpx

from app import (
    agent_updates,
    db,
    devices,
    devices_ws,
    machines,
    model_machines,
    network,
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
) -> str:
    """Send `machine`'s wake through the relay and measure the answer for up
    to wait_s (clamped to the ledger's 30..600). Returns the words; raises
    WakeCannot when nothing can be sent or whether it was sent is unknown."""
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
        await _relay_cannot(pool, sink, name, target_id, relay, chosen, reason, trigger)
        raise RelayCannot(f"{reason}; nothing was sent") from exc
    except devices.DeviceRefused as exc:
        raise WakeCannot(
            f"cannot say whether a wake left {relay.name}: {exc.reason} — the command reached "
            "its agent and no answer came back, so whether it sent is not known; nothing was "
            "recorded"
        ) from exc
    if not isinstance(result, dict) or not result.get("ok"):
        said = (result or {}).get("error") if isinstance(result, dict) else None
        reason = f"cannot: {relay.name}'s agent did not send it — {said or 'it gave no reason'}"
        await _relay_cannot(pool, sink, name, target_id, relay, chosen, reason, trigger)
        raise RelayCannot(reason)
    meta = result.get("meta") if isinstance(result.get("meta"), dict) else {}
    packets = meta.get("sent")
    if isinstance(packets, bool) or not isinstance(packets, int) or packets < 1:
        raise WakeCannot(
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
        )
    except wake_attempts.AttemptOpen as exc:
        raise WakeCannot(
            f"a wake left {relay.name} at {_utc(sent_at)}, but {exc} — this one is not recorded"
        ) from exc

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


async def _relay_cannot(pool, sink, name, target_id, relay, chosen, reason, trigger) -> None:
    attempt = await wake_attempts.record_not_sent(
        pool,
        device_id=target_id,
        outcome="relay_cannot",
        reason=reason,
        trigger=trigger,
        relay_device_id=relay.id,
        adapter=chosen["name"],
        mac=chosen["mac"],
    )
    sink.append(_fact(name, attempt, "relay_cannot", sent=False, relay=relay.name))
