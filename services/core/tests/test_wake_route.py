"""S46a T9: wake.route_targets — which paired machines a turn's route says to
wake in the background.

A link counts when the gateway typed it on X-Nova-Route as `unreachable=`
(this request dialled it and could not connect, S46a T8) or `connect_walled=`
(it is walled, and the wall was made by a connect failure — the first one
walls a non-engine link for up to 30 min, so later turns only ever see the
wall). Its provider is mapped to a paired device by model_machines.device_of
(derived from the provider URL, the agents' addresses and the tailnet), and
the device is a target only when its agent is NOT connected: a connected
agent whose model does not answer is not asleep. The hub is never a target.
Pure: no I/O — everything is passed in.

Names and addresses here are placeholders (TEST-NET-1), never a real machine.
"""

from __future__ import annotations

import pytest

from app import db, network, wake
from app.network import NO_PEERS_FILE, Peers

NO_PEERS = Peers((), NO_PEERS_FILE)

BOX_URL = "http://192.0.2.10:11434/v1"
HUB_URL = "http://192.0.2.1:11434/v1"


def _agent(name, *, connected=False, hub=False, addresses=()):
    return {
        "name": name,
        "platform": "windows",
        "hostname": name,
        "connected": connected,
        "hub": hub,
        "addresses": tuple(addresses),
    }


def _providers():
    return [
        {"name": "boxa", "base_url": BOX_URL},
        {"name": "hub", "base_url": HUB_URL},
        {"name": "cloud", "base_url": "https://api.example.com/v1"},
    ]


def _agents(*, box_connected=False):
    return [
        _agent("box-a", connected=box_connected, addresses=["192.0.2.10"]),
        _agent("hubhost", connected=True, hub=True, addresses=["192.0.2.1"]),
    ]


def test_an_unreachable_link_on_a_sleeping_machine_names_that_machine():
    got = wake.route_targets({"unreachable": "boxa:qwen3:8b"}, _providers(), _agents(), NO_PEERS)
    assert got == [{"device": "box-a", "links": ["boxa:qwen3:8b"]}]


def test_a_connect_walled_link_counts_like_an_unreachable_one():
    got = wake.route_targets(
        {"connect_walled": "boxa:qwen3.8:27b"}, _providers(), _agents(), NO_PEERS
    )
    assert got == [{"device": "box-a", "links": ["boxa:qwen3.8:27b"]}]


def test_two_links_on_one_machine_are_one_target_in_link_order():
    got = wake.route_targets(
        {"unreachable": "boxa:qwen3:8b", "connect_walled": "boxa:qwen3.8:27b,boxa:qwen3:8b"},
        _providers(),
        _agents(),
        NO_PEERS,
    )
    assert got == [{"device": "box-a", "links": ["boxa:qwen3:8b", "boxa:qwen3.8:27b"]}]


def test_the_route_chunk_lists_are_read_as_well_as_the_header_strings():
    got = wake.route_targets(
        {"unreachable": ["boxa:a,b"], "connect_walled": []}, _providers(), _agents(), NO_PEERS
    )
    assert got == [{"device": "box-a", "links": ["boxa:a,b"]}]


def test_header_ids_are_unquoted_so_a_model_name_cannot_split_the_list():
    got = wake.route_targets(
        {"unreachable": "boxa:a%2Cb%3Bc,cloud:x"}, _providers(), _agents(), NO_PEERS
    )
    assert got == [{"device": "box-a", "links": ["boxa:a,b;c"]}]


def test_the_hub_is_never_a_target_even_when_its_agent_is_not_connected():
    agents = [_agent("hubhost", connected=False, hub=True, addresses=["192.0.2.1"])]
    got = wake.route_targets({"unreachable": "hub:qwen3:8b"}, _providers(), agents, NO_PEERS)
    assert got == []


def test_a_provider_on_no_paired_machine_is_no_target():
    got = wake.route_targets(
        {"unreachable": "cloud:remote-model"}, _providers(), _agents(), NO_PEERS
    )
    assert got == []


def test_a_link_whose_provider_is_not_listed_is_no_target():
    got = wake.route_targets({"unreachable": "gone:m"}, _providers(), _agents(), NO_PEERS)
    assert got == []


def test_a_machine_whose_agent_is_connected_is_no_target():
    """Its agent answers, so the machine is not asleep — waking it fixes
    nothing (the model server is down, or the link is wrong)."""
    got = wake.route_targets(
        {"unreachable": "boxa:qwen3:8b"}, _providers(), _agents(box_connected=True), NO_PEERS
    )
    assert got == []


def test_an_ambiguous_device_is_no_target():
    agents = [
        _agent("box-a", addresses=["192.0.2.10"]),
        _agent("box-b", addresses=["192.0.2.10"]),
    ]
    got = wake.route_targets({"unreachable": "boxa:qwen3:8b"}, _providers(), agents, NO_PEERS)
    assert got == []


@pytest.mark.parametrize(
    "route_meta",
    [None, {}, {"role": "chat", "link": "1"}, {"unreachable": ""}, {"walled": "boxa:qwen3:8b"}],
)
def test_a_route_that_lists_nothing_names_no_target(route_meta):
    assert wake.route_targets(route_meta, _providers(), _agents(), NO_PEERS) == []


def test_route_targets_does_no_io(monkeypatch):
    def boom(*_a, **_k):
        raise AssertionError("route_targets must not read anything")

    monkeypatch.setattr(network, "tailnet_peers", boom)
    monkeypatch.setattr(db, "get_pool", boom)
    got = wake.route_targets({"unreachable": "boxa:qwen3:8b"}, _providers(), _agents(), NO_PEERS)
    assert got == [{"device": "box-a", "links": ["boxa:qwen3:8b"]}]
