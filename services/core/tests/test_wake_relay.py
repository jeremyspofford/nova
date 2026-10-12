"""app/wake.py's pure choices (S46a T5): which of the target's adapters can be
woken, and which connected agent sends the packet.

No DB, no socket: the facts are the shape devices.facts stores (device_facts.
_net), the candidates are what wake.py reads from the live rows and the hub's
registry. Documentation MACs and TEST-NET addresses only (the repo is
public)."""

from __future__ import annotations

import pytest

from app import wake

WIFI_MAC = "02:00:5e:10:00:01"
ETH_MAC = "02:00:5e:10:00:02"
HUB_MAC = "02:00:5e:10:00:0a"


def _facts(*ifaces: dict) -> dict:
    return {"net": {"ifaces": list(ifaces)}}


def _iface(name: str, mac: str, *cidrs: str, up: bool = True) -> dict:
    return {"name": name, "mac": mac, "ipv4_cidr": list(cidrs), "up": up}


TARGET = _facts(
    _iface("Loopback", "", "127.0.0.1/8"),
    _iface("Wi-Fi", WIFI_MAC, "192.0.2.23/24"),
    _iface("Ethernet", ETH_MAC, up=False),
    _iface("Teredo", "00:00:00:00:00:00"),
    _iface("odd", "ff:ff:ff:ff:ff:ff"),
)
HUB = _facts(
    _iface("lo", "", "127.0.0.1/8"),
    _iface("tailscale0", "", "100.64.0.5/32"),
    _iface("eth0", HUB_MAC, "192.0.2.10/24"),
)


def _candidate(name="hubhost", *, facts=HUB, connected=True, hub=True, id_="r1") -> dict:
    return {"id": id_, "name": name, "facts": facts, "connected": connected, "hub": hub}


def test_adapters_are_the_ifaces_with_a_real_mac_in_order():
    found = wake.adapters(TARGET)
    assert [a["name"] for a in found] == ["Wi-Fi", "Ethernet"]
    assert found[0]["mac"] == WIFI_MAC and found[0]["cidrs"] == ["192.0.2.23/24"]
    assert found[1]["mac"] == ETH_MAC and found[1]["cidrs"] == []


@pytest.mark.parametrize("facts", [None, {}, {"net": None}, {"net": {"ifaces": "x"}}])
def test_adapters_of_unreadable_facts_is_empty(facts):
    assert wake.adapters(facts) == []


def test_the_connected_hub_agent_on_the_targets_subnet_is_the_relay():
    relay = wake.choose_relay("box", TARGET, [_candidate()])
    assert relay.id == "r1" and relay.name == "hubhost"
    assert relay.iface == "eth0"
    assert relay.broadcast == "192.0.2.255"
    assert relay.adapter == "Wi-Fi"


def test_an_agent_not_through_the_hub_door_is_never_the_relay():
    other = _candidate("laptop", hub=False, id_="r2")
    with pytest.raises(wake.WakeCannot) as caught:
        wake.choose_relay("box", TARGET, [other])
    assert "no connected agent shares box's network" in str(caught.value)


def test_no_connected_hub_agent_is_a_stated_cannot():
    with pytest.raises(wake.WakeCannot) as caught:
        wake.choose_relay("box", TARGET, [_candidate(connected=False)])
    said = str(caught.value)
    assert "no connected agent shares box's network" in said
    assert "hub machine's own door" in said and "connected" in said


def test_a_hub_agent_on_another_subnet_is_a_stated_cannot():
    elsewhere = _facts(_iface("eth0", HUB_MAC, "198.51.100.10/24"))
    with pytest.raises(wake.WakeCannot) as caught:
        wake.choose_relay("box", TARGET, [_candidate(facts=elsewhere)])
    said = str(caught.value)
    assert "no connected agent shares box's network" in said
    assert "hubhost" in said and "no subnet" in said


def test_a_host_route_never_matches():
    # A /32 (a tailnet address) has no broadcast to send to.
    target = _facts(_iface("Wi-Fi", WIFI_MAC, "100.64.0.9/32"))
    hub = _facts(_iface("tailscale0", HUB_MAC, "100.64.0.5/32"))
    with pytest.raises(wake.WakeCannot):
        wake.choose_relay("box", target, [_candidate(facts=hub)])


@pytest.mark.parametrize("prefix", [31, 32])
def test_a_relay_subnet_narrower_than_a_30_never_matches(prefix):
    """T5-T6 fix (VERIFY gap 1): the /30-or-wider rule, bitten. A /31
    point-to-point link holds two addresses and no broadcast — 192.0.2.22/31
    holds the target's 192.0.2.23 itself, so without the rule the "broadcast"
    sent to would be the target's own address (192.0.2.23). The /32 case
    above passes for another reason (a host route holds only its own
    address), so it cannot pin this."""
    target = _facts(_iface("Wi-Fi", WIFI_MAC, "192.0.2.23/24"))
    hub = _facts(_iface("eth0", HUB_MAC, f"192.0.2.22/{prefix}"))
    with pytest.raises(wake.RelayCannot) as caught:
        wake.choose_relay("box", target, [_candidate(facts=hub)])
    assert "shares no subnet" in str(caught.value)


def test_a_30_is_the_narrowest_relay_subnet():
    """…and the boundary itself still sends: a /30 has a broadcast."""
    target = _facts(_iface("Wi-Fi", WIFI_MAC, "192.0.2.22/24"))
    hub = _facts(_iface("eth0", HUB_MAC, "192.0.2.21/30"))
    relay = wake.choose_relay("box", target, [_candidate(facts=hub)])
    assert relay.broadcast == "192.0.2.23"


def test_the_first_matching_relay_wins_and_unmatched_ones_are_skipped():
    elsewhere = _facts(_iface("eth0", HUB_MAC, "198.51.100.10/24"))
    relay = wake.choose_relay(
        "box", TARGET, [_candidate("a", facts=elsewhere, id_="ra"), _candidate("b", id_="rb")]
    )
    assert relay.name == "b"


def test_no_mac_ever_reaches_a_cannot():
    for candidates in ([], [_candidate(connected=False)], [_candidate(hub=False)]):
        with pytest.raises(wake.WakeCannot) as caught:
            wake.choose_relay("box", TARGET, candidates)
        said = str(caught.value).lower()
        for mac in (WIFI_MAC, ETH_MAC, HUB_MAC):
            assert mac not in said and mac.replace(":", "") not in said
