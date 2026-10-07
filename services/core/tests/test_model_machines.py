"""model_machines — which gateway providers run on a machine, not a cloud.

on_a_machine decides from the URL host alone (no DNS, no network): an IP
literal that is not globally routable, or a home/tailnet/container name, is a
machine; a public name or global IP is a cloud; no host is neither."""

from __future__ import annotations

import pytest

from app import model_machines
from app.device_facts import agent_view
from app.network import NO_PEERS_FILE, Peers


# C1 — the live remote providers and other non-global IP literals are machines
@pytest.mark.parametrize(
    "url",
    [
        "http://100.122.40.93:11435/v1",  # live `dell`
        "http://100.122.40.93:8009/v1",  # live `dell-kev`
        "http://192.168.1.5:11434",
        "http://localhost:1234",
        "http://127.0.0.1:11434",
        "http://169.254.10.1:8080",
        "http://[fd7a:115c:a1e0::1]:11434/v1",
    ],
)
def test_a_non_global_ip_or_localhost_is_a_machine(url):
    assert model_machines.on_a_machine(url) is True


# C2 — home/tailnet/container names are machines, case-insensitive, one trailing dot ignored
@pytest.mark.parametrize(
    "url",
    [
        "http://box.tailba0abb.ts.net:8009/v1",
        "http://ollama:11434",
        "http://nas.local:11434",
        "http://router.lan/v1",
        "http://gpu.internal:8080",
        "http://gpu.home.arpa/v1",
        "http://BOX.TailBA0abb.TS.NET./v1",
        "http://NAS.LOCAL:11434",
    ],
)
def test_a_home_or_tailnet_name_is_a_machine(url):
    assert model_machines.on_a_machine(url) is True


# C3 — the live cloud providers and a global IP literal are not machines
@pytest.mark.parametrize(
    "url",
    [
        "https://api.anthropic.com/v1",
        "https://openrouter.ai/api/v1",
        "https://api.cerebras.ai/v1",
        "http://8.8.8.8",
    ],
)
def test_a_cloud_host_or_global_ip_is_not_a_machine(url):
    assert model_machines.on_a_machine(url) is False


# C4 — a suffix matches only as whole trailing labels
@pytest.mark.parametrize(
    "url",
    [
        "http://evilts.net/v1",
        "https://mylocal.com",
        "https://mylan.io/v1",
        "https://home.arpa.example.com",
        "https://xinternal.io",
    ],
)
def test_a_suffix_lookalike_is_not_a_machine(url):
    assert model_machines.on_a_machine(url) is False


# C5 — no host is never a machine and never raises
@pytest.mark.parametrize("url", ["", None, "not a url", "http://"])
def test_no_host_is_not_a_machine_and_never_raises(url):
    assert model_machines.on_a_machine(url) is False


# C5 — a URL the parser refuses (an unclosed IPv6 bracket raises ValueError in
# urlsplit) and a host that is only a trailing dot are no host, not a crash and
# not a single-label machine
@pytest.mark.parametrize("url", ["http://[::1", "http://[fd7a:115c:a1e0::1:11434/v1", "http://./"])
def test_an_unparseable_or_empty_host_is_not_a_machine_and_never_raises(url):
    assert model_machines.on_a_machine(url) is False


# -- T7: device_of names the paired device a provider runs on ----------------

DELL_URL = "http://100.122.40.93:11435/v1"
WIN_DNS = "dell-xps-8950-windows.tailba0abb.ts.net"
WSL_DNS = "dell-xps-8950.tailba0abb.ts.net"


def _agent(name, platform, hostname, addresses=()):
    view = agent_view(
        name=name,
        platform=platform,
        hostname=hostname,
        connected=True,
        last_seen=None,
        facts=None,
        facts_at=None,
    )
    view["addresses"] = tuple(addresses)
    return view


def _peer(host_name, dns_name, os_name, ips, online=True):
    return {
        "host_name": host_name,
        "dns_name": dns_name,
        "ips": tuple(ips),
        "os": os_name,
        "online": online,
    }


LIVE_PEERS = (
    _peer("DELL-XPS-8950", WSL_DNS, "linux", ["100.98.5.70"], online=False),
    _peer("DELL-XPS-8950", WIN_DNS, "windows", ["100.122.40.93"]),
)


def _dell_and_wsl_without_addresses():
    return [
        _agent("DELL-XPS-8950", "windows", "DELL-XPS-8950"),
        _agent("DELL-XPS-8950 (WSL)", "linux", "DELL-XPS-8950"),
    ]


# C1 — the agent's own addresses name the device; the tailnet is never needed
@pytest.mark.parametrize("peers", [Peers((), NO_PEERS_FILE), Peers((), None)])
def test_an_agents_own_address_names_its_device_without_the_tailnet(peers):
    agents = [
        _agent("DELL-XPS-8950", "windows", "DELL-XPS-8950", ["100.122.40.93"]),
        _agent("Beelink Mini S", "linux", "mini-pc", ["192.168.1.30"]),
    ]
    got = model_machines.device_of(DELL_URL, agents, peers)
    assert got["device"] == "DELL-XPS-8950"
    assert got["via"] == ("its agent's addresses",)
    assert "DELL-XPS-8950" in got["said"]
    assert NO_PEERS_FILE not in got["said"]
    assert "tailnet" not in got["said"].lower()


# C2 — a tailnet peer by IP, narrowed by OS when one hostname has two agents
def test_a_tailnet_peer_by_ip_names_the_device_narrowed_by_os():
    got = model_machines.device_of(
        DELL_URL, _dell_and_wsl_without_addresses(), Peers(LIVE_PEERS, None)
    )
    assert got["device"] == "DELL-XPS-8950"
    assert got["via"] == (f"the tailnet peer {WIN_DNS}",)


def test_the_other_peer_by_ip_names_the_other_os_device():
    got = model_machines.device_of(
        "http://100.98.5.70:11434/v1", _dell_and_wsl_without_addresses(), Peers(LIVE_PEERS, None)
    )
    assert got["device"] == "DELL-XPS-8950 (WSL)"
    assert got["via"] == (f"the tailnet peer {WSL_DNS}",)


def test_a_peer_host_name_matches_the_agent_hostname_case_insensitively():
    peers = Peers((_peer("dell-xps-8950", WIN_DNS, "windows", ["100.122.40.93"]),), None)
    agents = [_agent("DELL-XPS-8950", "windows", "DELL-XPS-8950")]
    got = model_machines.device_of(DELL_URL, agents, peers)
    assert got["device"] == "DELL-XPS-8950"
    assert got["via"] == (f"the tailnet peer {WIN_DNS}",)


def test_a_macos_peer_narrows_to_the_darwin_agent():
    peers = Peers((_peer("studio", "studio.tailba0abb.ts.net", "macOS", ["100.64.0.9"]),), None)
    agents = [_agent("Studio Linux", "linux", "studio"), _agent("Studio Mac", "darwin", "studio")]
    got = model_machines.device_of("http://100.64.0.9:11434", agents, peers)
    assert got["device"] == "Studio Mac"


def test_the_device_is_the_agents_name_never_its_hostname():
    agents = [_agent("Dell desk", "windows", "DELL-XPS-8950")]
    got = model_machines.device_of(DELL_URL, agents, Peers((LIVE_PEERS[1],), None))
    assert got["device"] == "Dell desk"


# C3 — a tailnet peer by its MagicDNS name, case and one trailing dot ignored
def test_a_tailnet_peer_by_magicdns_name_names_the_device():
    got = model_machines.device_of(
        "http://DELL-XPS-8950-Windows.tailba0abb.ts.net.:11435/v1",
        _dell_and_wsl_without_addresses(),
        Peers(LIVE_PEERS, None),
    )
    assert got["device"] == "DELL-XPS-8950"
    assert got["via"] == (f"the tailnet peer {WIN_DNS}",)


# C4 — both sources tried and unioned; one device by both is one device
def test_both_sources_naming_one_device_carry_both_vias_agent_first():
    agents = [
        _agent("DELL-XPS-8950", "windows", "DELL-XPS-8950", ["100.122.40.93"]),
        _agent("DELL-XPS-8950 (WSL)", "linux", "DELL-XPS-8950"),
    ]
    got = model_machines.device_of(DELL_URL, agents, Peers(LIVE_PEERS, None))
    assert got["device"] == "DELL-XPS-8950"
    assert got["via"] == ("its agent's addresses", f"the tailnet peer {WIN_DNS}")


def test_two_sources_naming_different_devices_is_ambiguous_and_names_both_sorted():
    agents = [
        _agent("Zed box", "linux", "zed", ["100.122.40.93"]),
        _agent("Alpha box", "windows", "DELL-XPS-8950"),
    ]
    got = model_machines.device_of(DELL_URL, agents, Peers((LIVE_PEERS[1],), None))
    assert got["device"] is None
    assert got["said"].startswith("ambiguous")
    assert "Alpha box" in got["said"] and "Zed box" in got["said"]
    assert got["said"].index("Alpha box") < got["said"].index("Zed box")


# C5 — no match is said plainly, with the peer list's reason only when it had one
def test_no_match_says_no_paired_device_is_known_by_the_host():
    agents = [_agent("Beelink Mini S", "linux", "mini-pc", ["192.168.1.30"])]
    got = model_machines.device_of(DELL_URL, agents, Peers((), None))
    assert got["device"] is None
    assert "no paired device is known by 100.122.40.93" in got["said"]
    assert "tailnet" not in got["said"].lower()
    assert NO_PEERS_FILE not in got["said"]


def test_no_match_with_an_unreadable_peer_list_says_its_reason():
    agents = [_agent("Beelink Mini S", "linux", "mini-pc", ["192.168.1.30"])]
    got = model_machines.device_of(DELL_URL, agents, Peers((), NO_PEERS_FILE))
    assert got["device"] is None
    assert "no paired device is known by 100.122.40.93" in got["said"]
    assert NO_PEERS_FILE in got["said"]


# C6 — total: no host or malformed entries never raise
@pytest.mark.parametrize("url", ["", None, "http://", "not a url"])
def test_no_host_names_no_device_and_never_raises(url):
    got = model_machines.device_of(
        url,
        [_agent("DELL-XPS-8950", "windows", "DELL-XPS-8950", ["100.122.40.93"])],
        Peers(LIVE_PEERS, None),
    )
    assert got["device"] is None
    assert got["via"] == ()
    assert isinstance(got["said"], str) and got["said"].strip()
    assert "\n" not in got["said"]


def test_malformed_agents_and_peers_are_skipped_not_fatal():
    no_addresses = _agent("Broken one", "windows", "broken")
    del no_addresses["addresses"]
    list_addresses = _agent("Broken two", "windows", "broken2")
    list_addresses["addresses"] = "100.122.40.93"  # text, not a tuple
    agents = [no_addresses, list_addresses, _agent("DELL-XPS-8950", "windows", "DELL-XPS-8950")]
    peers = Peers(
        (
            _peer("broken", "broken.tailba0abb.ts.net", "windows", []),
            {"host_name": "broken2"},  # missing keys
            LIVE_PEERS[1],
        ),
        None,
    )
    got = model_machines.device_of(DELL_URL, agents, peers)
    assert got["device"] == "DELL-XPS-8950"
    assert got["via"] == (f"the tailnet peer {WIN_DNS}",)


def test_said_is_one_line_without_the_listing_prefixes():
    agents = [_agent("DELL-XPS-8950", "windows", "DELL-XPS-8950", ["100.122.40.93"])]
    got = model_machines.device_of(DELL_URL, agents, Peers(LIVE_PEERS, None))
    assert "\n" not in got["said"]
    assert not got["said"].startswith("- machine ")
    assert not got["said"].startswith("  agent ")


# -- T7 COVERAGE: pins the edges the criteria name but the first tests left open --


def test_no_match_without_a_peer_reason_is_exactly_the_plain_sentence():
    agents = [_agent("Beelink Mini S", "linux", "mini-pc", ["192.168.1.30"])]
    got = model_machines.device_of(DELL_URL, agents, Peers((), None))
    assert got["said"] == "no paired device is known by 100.122.40.93"


@pytest.mark.parametrize("os_name", ["freebsd", "", None])
def test_a_peer_os_that_maps_to_no_platform_leaves_every_agent_and_is_ambiguous(os_name):
    peers = Peers((_peer("DELL-XPS-8950", WIN_DNS, os_name, ["100.122.40.93"]),), None)
    got = model_machines.device_of(DELL_URL, _dell_and_wsl_without_addresses(), peers)
    assert got["device"] is None
    assert got["said"].startswith("ambiguous")
    assert "DELL-XPS-8950 (WSL)" in got["said"]


def test_a_peer_os_that_matches_neither_agent_leaves_both_and_is_ambiguous():
    peers = Peers((_peer("DELL-XPS-8950", WIN_DNS, "macOS", ["100.122.40.93"]),), None)
    got = model_machines.device_of(DELL_URL, _dell_and_wsl_without_addresses(), peers)
    assert got["device"] is None
    assert got["said"].startswith("ambiguous")


def test_one_agent_by_hostname_is_named_whatever_the_peer_os_says():
    peers = Peers((_peer("DELL-XPS-8950", WIN_DNS, "linux", ["100.122.40.93"]),), None)
    agents = [_agent("DELL-XPS-8950", "windows", "DELL-XPS-8950")]
    got = model_machines.device_of(DELL_URL, agents, peers)
    assert got["device"] == "DELL-XPS-8950"


def test_an_ipv6_host_matches_a_peer_ip_after_normalisation_never_an_agent():
    peers = Peers((_peer("DELL-XPS-8950", WIN_DNS, "windows", ["FD7A:115C:A1E0::1"]),), None)
    agents = [
        _agent("DELL-XPS-8950", "windows", "DELL-XPS-8950"),
        _agent("Other", "linux", "other", ["100.122.40.93"]),
    ]
    got = model_machines.device_of("http://[fd7a:115c:a1e0:0:0::1]:11434/v1", agents, peers)
    assert got["device"] == "DELL-XPS-8950"
    assert got["via"] == (f"the tailnet peer {WIN_DNS}",)


def test_non_dict_agents_and_peers_are_skipped_not_fatal():
    agents = [None, "DELL-XPS-8950", 7, _agent("DELL-XPS-8950", "windows", "DELL-XPS-8950")]
    peers = Peers((None, "peer", 3, LIVE_PEERS[1]), None)
    got = model_machines.device_of(DELL_URL, agents, peers)
    assert got["device"] == "DELL-XPS-8950"
    assert got["via"] == (f"the tailnet peer {WIN_DNS}",)


# ---------------------------------------------------------------- T8 state_of

from datetime import UTC, datetime, timedelta  # noqa: E402

NOW = datetime(2026, 10, 6, 12, 0, 0, tzinfo=UTC)
DELL_NOTE = (
    "the last listing was refused (502): could not reach http://100.122.40.93:11435/v1 "
    "— RemoteProtocolError: Server disconnected without sending a response."
)
DELL_WALL_REASON = (
    "dell:qwen3:8b refused (502): could not reach dell at http://100.122.40.93:11435/v1 "
    "— RemoteProtocolError: Server disconnected without sending a response."
)


def _row(listing="unknown", note=DELL_NOTE, name="dell"):
    return {
        "name": name,
        "base_url": "http://100.122.40.93:11435/v1",
        "listing": listing,
        "listing_note": note,
    }


def _wall(until, provider="dell", model="qwen3:8b", reason=DELL_WALL_REASON):
    return {
        "provider": provider,
        "model": model,
        "walled_until": until.isoformat() if isinstance(until, datetime) else until,
        "reason": reason,
        "status": 502,
        "strikes": 66,
    }


# C1 — walled
def test_a_live_wall_makes_the_provider_walled_with_its_reason_and_time_left():
    walls = [_wall(NOW + timedelta(minutes=28))]
    got = model_machines.state_of(_row(), walls, NOW)
    assert got["state"] == "walled"
    assert got["walled_for_s"] == 1680
    assert isinstance(got["walled_for_s"], int)
    assert got["reason"] == DELL_WALL_REASON
    assert got["answering"] is False


def test_walled_for_s_is_floored_to_whole_seconds():
    walls = [_wall(NOW + timedelta(seconds=1680, milliseconds=900))]
    got = model_machines.state_of(_row(), walls, NOW)
    assert got["walled_for_s"] == 1680


def test_a_wall_given_as_a_datetime_is_read_too():
    walls = [_wall(NOW + timedelta(minutes=28))]
    walls[0]["walled_until"] = NOW + timedelta(minutes=28)
    got = model_machines.state_of(_row(), walls, NOW)
    assert got["state"] == "walled"
    assert got["walled_for_s"] == 1680


def test_a_live_wall_beats_a_listing_that_answers():
    walls = [_wall(NOW + timedelta(minutes=5))]
    got = model_machines.state_of(_row("available", "7 models listed"), walls, NOW)
    assert got["state"] == "walled"
    assert got["answering"] is False


# C2 — failing
@pytest.mark.parametrize(
    "walls",
    [[], [_wall(NOW + timedelta(minutes=28), provider="dell-kev")]],
    ids=["no-walls", "only-another-providers-wall"],
)
def test_a_refused_listing_without_a_wall_is_failing_with_the_listing_note(walls):
    got = model_machines.state_of(_row(), walls, NOW)
    assert got["state"] == "failing"
    assert got["reason"] == DELL_NOTE
    assert got["walled_for_s"] is None
    assert got["answering"] is False


def test_an_unavailable_listing_with_a_note_is_failing():
    got = model_machines.state_of(_row("unavailable", "401: invalid api key"), [], NOW)
    assert got["state"] == "failing"
    assert got["reason"] == "401: invalid api key"
    assert got["answering"] is False


# C3 — answering
def test_an_available_listing_without_a_wall_is_answering():
    got = model_machines.state_of(_row("available", "7 models listed"), [], NOW)
    assert got["state"] == "answering"
    assert got["answering"] is True
    assert got["walled_for_s"] is None
    assert got["reason"] == "7 models listed"


# C4 — unknown, never claimed ok
@pytest.mark.parametrize("note", [None, "", "   "], ids=["none", "empty", "blank"])
def test_no_verdict_yet_is_unknown_with_a_stated_reason(note):
    got = model_machines.state_of(_row("unknown", note), [], NOW)
    assert got["state"] == "unknown"
    assert got["answering"] is None
    assert got["walled_for_s"] is None
    assert isinstance(got["reason"], str) and got["reason"].strip()
    assert "no verdict" in got["reason"]


# C5 — walls read honestly
@pytest.mark.parametrize(
    "until",
    [NOW, NOW - timedelta(seconds=1), NOW - timedelta(hours=3)],
    ids=["ends-now", "just-ended", "long-ended"],
)
def test_an_expired_wall_is_ignored(until):
    got = model_machines.state_of(_row(), [_wall(until)], NOW)
    assert got["state"] == "failing"
    assert got["reason"] == DELL_NOTE
    assert got["walled_for_s"] is None


def test_another_providers_live_wall_is_ignored_even_for_an_answering_row():
    walls = [_wall(NOW + timedelta(minutes=28), provider="dell-kev")]
    got = model_machines.state_of(_row("available", "7 models listed"), walls, NOW)
    assert got["state"] == "answering"


def test_the_latest_ending_live_wall_gives_the_reason_and_time_left():
    walls = [
        _wall(NOW + timedelta(minutes=5), model="qwen3:8b", reason="short wall"),
        _wall(NOW + timedelta(minutes=40), model="", reason="whole-provider wall"),
        _wall(NOW + timedelta(minutes=12), model="qwen3.8:27b", reason="middle wall"),
        _wall(NOW - timedelta(minutes=1), model="x", reason="expired wall"),
    ]
    got = model_machines.state_of(_row(), walls, NOW)
    assert got["state"] == "walled"
    assert got["reason"] == "whole-provider wall"
    assert got["walled_for_s"] == 2400


# C6 — total, never raises, never answers on bad input
@pytest.mark.parametrize(
    "row",
    [None, "dell", 7, [], {"name": "dell"}, {"name": "dell", "listing_note": "7 models listed"}],
    ids=["none", "text", "int", "list", "no-listing", "note-but-no-listing"],
)
def test_a_bad_row_reads_unknown_never_answering(row):
    got = model_machines.state_of(row, [], NOW)
    assert got["state"] == "unknown"
    assert got["answering"] is None


@pytest.mark.parametrize("walls", [None, "wall", 3, {"provider": "dell"}], ids=str)
def test_walls_that_are_not_a_list_are_skipped(walls):
    got = model_machines.state_of(_row("available", "7 models listed"), walls, NOW)
    assert got["state"] == "answering"
    assert got["answering"] is True


def test_bad_wall_entries_are_skipped_and_a_good_one_still_counts():
    naive = (NOW + timedelta(minutes=50)).replace(tzinfo=None).isoformat()
    no_until = _wall(NOW + timedelta(minutes=50))
    del no_until["walled_until"]
    walls = [
        None,
        "wall",
        no_until,
        _wall("not a time"),
        _wall(naive),
        _wall(NOW + timedelta(minutes=28)),
    ]
    got = model_machines.state_of(_row(), walls, NOW)
    assert got["state"] == "walled"
    assert got["walled_for_s"] == 1680
    assert got["reason"] == DELL_WALL_REASON


def test_only_bad_wall_entries_leave_the_listing_verdict():
    naive = (NOW + timedelta(minutes=50)).replace(tzinfo=None).isoformat()
    walls = [None, _wall("not a time"), _wall(naive), {"provider": "dell"}]
    got = model_machines.state_of(_row("available", "7 models listed"), walls, NOW)
    assert got["state"] == "answering"


# COVERAGE — every reason is a stated line, and bad input never answers or raises
def test_an_answering_row_without_a_note_still_states_a_reason():
    got = model_machines.state_of(_row("available", None), [], NOW)
    assert got["state"] == "answering"
    assert isinstance(got["reason"], str) and got["reason"].strip()


def test_an_unavailable_row_without_a_note_is_failing_with_a_stated_reason():
    got = model_machines.state_of(_row("unavailable", None), [], NOW)
    assert got["state"] == "failing"
    assert got["answering"] is False
    assert isinstance(got["reason"], str) and got["reason"].strip()


@pytest.mark.parametrize("reason", [None, "", 7], ids=["none", "empty", "int"])
def test_a_live_wall_without_a_reason_is_walled_with_a_stated_reason(reason):
    got = model_machines.state_of(_row(), [_wall(NOW + timedelta(minutes=28), reason=reason)], NOW)
    assert got["state"] == "walled"
    assert isinstance(got["reason"], str) and got["reason"].strip()


@pytest.mark.parametrize(
    "now", [None, "garbage", NOW.replace(tzinfo=None)], ids=["none", "text", "naive"]
)
def test_a_bad_now_never_raises_and_trusts_no_wall(now):
    walls = [_wall(NOW + timedelta(minutes=28))]
    got = model_machines.state_of(_row(), walls, now)
    assert got["state"] == "failing"
    assert got["reason"] == DELL_NOTE


def test_a_row_without_a_name_is_never_walled_by_a_wall_without_a_provider():
    row = {"listing": "available", "listing_note": "7 models listed"}
    wall = _wall(NOW + timedelta(minutes=28))
    del wall["provider"]
    got = model_machines.state_of(row, [wall], NOW)
    assert got["state"] == "answering"
