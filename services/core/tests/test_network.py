"""S47 — core's one reader of the tailnet sidecar's status file (D17).

Every QR code, her nova_address tool and the address guard read through
network.address(), so each condition it refuses on is pinned here: a stated
address is a claim about another device's reach, and a wrong one is a QR code
that opens nothing."""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime, timedelta

import pytest
from starlette.datastructures import Headers

from app import network

NOW = datetime(2026, 9, 25, 14, 0, 0, tzinfo=UTC)
GOOD = {
    "version": 1,
    "backend_state": "Running",
    "dns_name": "nova.fake-tailnet.ts.net",
    "serve_ok": True,
    "https_cert": True,
    "written_at": "2026-09-25T13:59:50Z",
}


@pytest.fixture
def status(tmp_path, monkeypatch):
    path = tmp_path / "tailscale.json"
    monkeypatch.setenv(network.STATUS_FILE_ENV, str(path))

    def write(**over) -> None:
        path.write_text(json.dumps({**GOOD, **over}))

    write.path = path
    return write


def test_every_fact_holding_states_the_https_origin(status):
    status()
    got = network.address(NOW)
    assert got.origin == "https://nova.fake-tailnet.ts.net"
    assert got.reason is None
    assert got.read_at == NOW


def test_a_trailing_dot_and_capitals_are_normalised(status):
    status(dns_name="Nova.Fake-Tailnet.TS.net.")
    assert network.address(NOW).origin == "https://nova.fake-tailnet.ts.net"


def test_no_file_means_this_nova_runs_without_its_tailnet(status):
    got = network.address(NOW)
    assert got.origin is None
    assert "has not written its status" in got.reason
    assert "NOVA_TAILNET=1 ./install" in got.reason


def test_a_stale_file_is_no_address_never_the_old_one(status):
    status(written_at="2026-09-25T13:56:00Z")
    got = network.address(NOW)
    assert got.origin is None
    assert "4 minutes old" in got.reason and "stopped writing" in got.reason


def test_exactly_at_the_limit_is_still_fresh(status):
    at = (NOW - timedelta(seconds=network.MAX_AGE_S)).strftime("%Y-%m-%dT%H:%M:%SZ")
    status(written_at=at)
    assert network.address(NOW).origin == "https://nova.fake-tailnet.ts.net"


def test_a_file_dated_in_the_future_is_refused(status):
    status(written_at="2026-09-25T14:05:00Z")
    got = network.address(NOW)
    assert got.origin is None and "in the future" in got.reason


@pytest.mark.parametrize(
    ("over", "says"),
    [
        ({"version": 2}, "version 2"),
        ({"written_at": "yesterday"}, "no readable written_at"),
        ({"backend_state": "NeedsLogin"}, "NeedsLogin, not Running"),
        ({"backend_state": ""}, "in no stated state"),
        ({"dns_name": ""}, "names no DNS name"),
        ({"dns_name": "localhost"}, "not a MagicDNS name"),
        ({"dns_name": "100.64.0.7"}, "not a MagicDNS name"),
        ({"dns_name": "nova.example.com"}, "not a MagicDNS name"),
        ({"serve_ok": False}, "the serve mapping is missing"),
        ({"https_cert": False}, "HTTPS certificates are not enabled"),
        ({"serve_ok": "true"}, "the serve mapping is missing"),
    ],
)
def test_each_failed_fact_is_the_stated_reason(status, over, says):
    status(**over)
    got = network.address(NOW)
    assert got.origin is None
    assert says in got.reason


def test_the_first_failed_fact_wins(status):
    status(backend_state="Stopped", serve_ok=False, https_cert=False)
    assert "Stopped, not Running" in network.address(NOW).reason


def test_unparseable_and_non_object_files_are_stated(status):
    status.path.write_text("{not json")
    assert "not valid JSON" in network.address(NOW).reason
    status.path.write_text("[1, 2]")
    assert "not a JSON object" in network.address(NOW).reason


def test_a_non_utf8_byte_is_stated_never_raised(status):
    # A torn write or a corrupted volume can leave a byte read_text cannot
    # decode as UTF-8 — UnicodeDecodeError must become a reason, never
    # propagate out of core's one reader (review fix round 1, I6).
    status.path.write_bytes(b"\xff\xfe{\x00\x00")
    got = network.address(NOW)
    assert got.origin is None
    assert got.reason is not None


def test_deeply_nested_json_is_stated_never_raised(status):
    # json.loads recurses per nesting level; pathologically deep nesting
    # raises RecursionError, not a JSONDecodeError, and must be caught the
    # same way (review fix round 1, I6).
    status.path.write_text("[" * 10_000 + "]" * 10_000)
    got = network.address(NOW)
    assert got.origin is None
    assert got.reason is not None


def test_as_json_is_the_api_shape(status):
    status()
    assert network.address(NOW).as_json() == {
        "address": "https://nova.fake-tailnet.ts.net",
        "reason": None,
        "read_at": NOW.isoformat(),
    }


# -- S42b: the door a device socket came through (P15) -----------------------


@pytest.mark.parametrize(
    "peer,forwarded,door",
    [
        ("172.18.128.10", "172.18.0.1", "host"),  # web, forwarding the published loopback port
        ("172.18.128.10", "172.18.128.20", "tailnet"),  # web, forwarding the sidecar
        ("172.18.128.10", "192.0.2.7", None),  # web, forwarding something else
        ("172.18.0.1", None, "host"),  # straight to core's own loopback port
        ("172.18.0.99", "172.18.0.1", None),  # a header from anyone but web counts for nothing
        (None, None, None),
    ],
)
def test_the_door_is_told_from_the_peer_and_webs_forwarded_address(
    monkeypatch, peer, forwarded, door
):
    for key in ("NOVA_WEB_ADDR", "NOVA_TAILSCALE_ADDR", "NOVA_SUBNET_GATEWAY"):
        monkeypatch.delenv(key, raising=False)
    assert network.door_of(peer, forwarded) == door


def test_the_doors_follow_the_subnet_install_chose(monkeypatch):
    monkeypatch.setenv("NOVA_WEB_ADDR", "172.22.128.10")
    monkeypatch.setenv("NOVA_TAILSCALE_ADDR", "172.22.128.20")
    monkeypatch.setenv("NOVA_SUBNET_GATEWAY", "172.22.0.1")
    assert network.door_of("172.22.128.10", "172.22.0.1") == "host"
    assert network.door_of("172.18.128.10", "172.18.0.1") is None


# -- S42b: the bucket a request is counted in (Task 26, R2) -------------------

# RFC 5737: web at its fixed address; the two doors nginx's $remote_addr names
# behind it (the hub's loopback port arrives from the subnet gateway, the
# tailnet from the sidecar); and a peer that is neither — a container that
# talks straight to core.
WEB = "192.0.2.10"
LOOPBACK = "198.51.100.1"
SIDECAR = "198.51.100.20"
STRANGER = "192.0.2.77"
LOGIN = {"Tailscale-User-Login": "a@example.com"}


@pytest.fixture
def doors(monkeypatch):
    monkeypatch.setenv(network.WEB_ADDR_ENV, WEB)
    monkeypatch.setenv(network.GATEWAY_ENV, LOOPBACK)
    monkeypatch.setenv(network.TAILSCALE_ADDR_ENV, SIDECAR)


def _bucket(peer: str | None, headers: dict[str, str]) -> str:
    # Starlette's own Headers, as a route reads them: case-insensitive.
    return network.bucket_of(peer, Headers(headers=headers))


@pytest.mark.parametrize(
    "peer,headers,bucket",
    [
        # Through web from the hub's own loopback port (./install, a browser
        # on the hub): the door, as before the split.
        pytest.param(WEB, {"X-Real-IP": LOOPBACK}, LOOPBACK, id="loopback-through-web"),
        # The owner's tunnel: cloudflared on the hub reaches web from the same
        # door, carrying the Cf-Connecting-IP Cloudflare's edge set.
        pytest.param(
            WEB,
            {"X-Real-IP": LOOPBACK, "Cf-Connecting-IP": "203.0.113.9"},
            f"relayed via {LOOPBACK}",
            id="tunnel",
        ),
        # Its VALUE names nothing: another visitor, the same bucket; even an
        # empty one is there.
        pytest.param(
            WEB,
            {"X-Real-IP": LOOPBACK, "Cf-Connecting-IP": "203.0.113.10"},
            f"relayed via {LOOPBACK}",
            id="tunnel-another-visitor",
        ),
        pytest.param(
            WEB,
            {"X-Real-IP": LOOPBACK, "Cf-Connecting-IP": ""},
            f"relayed via {LOOPBACK}",
            id="tunnel-empty-value",
        ),
        # Funnel: from the sidecar WITHOUT serve's login (a tagged node too).
        pytest.param(WEB, {"X-Real-IP": SIDECAR}, f"relayed via {SIDECAR}", id="funnel"),
        pytest.param(
            WEB,
            {"X-Real-IP": SIDECAR, "Tailscale-User-Login": " "},
            f"relayed via {SIDECAR}",
            id="funnel-blank-login",
        ),
        # A tailnet person: from the sidecar with serve's login — the
        # tailnet door's own bucket.
        pytest.param(WEB, {"X-Real-IP": SIDECAR, **LOGIN}, SIDECAR, id="tailnet-person"),
        # A mark a client adds only moves it IN...
        pytest.param(
            WEB,
            {"X-Real-IP": SIDECAR, **LOGIN, "Cf-Connecting-IP": "203.0.113.9"},
            f"relayed via {SIDECAR}",
            id="tailnet-person-wearing-the-mark",
        ),
        # ...and a login names a person only from the sidecar: through the
        # loopback door it neither moves a client nor takes a visitor out.
        pytest.param(WEB, {"X-Real-IP": LOOPBACK, **LOGIN}, LOOPBACK, id="login-off-the-sidecar"),
        pytest.param(
            WEB,
            {"X-Real-IP": LOOPBACK, **LOGIN, "Cf-Connecting-IP": "203.0.113.9"},
            f"relayed via {LOOPBACK}",
            id="tunnel-visitor-forging-a-login",
        ),
        # A peer that is not web: every header counts for nothing.
        pytest.param(STRANGER, {"Cf-Connecting-IP": "203.0.113.9"}, STRANGER, id="stranger-mark"),
        pytest.param(STRANGER, {"X-Real-IP": LOOPBACK}, STRANGER, id="stranger-naming-loopback"),
        pytest.param(STRANGER, {"X-Real-IP": SIDECAR}, STRANGER, id="stranger-naming-funnel"),
        pytest.param(
            STRANGER, {"X-Real-IP": SIDECAR, **LOGIN}, STRANGER, id="stranger-naming-a-person"
        ),
        pytest.param(STRANGER, LOGIN, STRANGER, id="stranger-login"),
        # ./install straight to core's own port arrives from the gateway: its
        # headers count for nothing either.
        pytest.param(
            LOOPBACK, {"Cf-Connecting-IP": "203.0.113.9"}, LOOPBACK, id="install-direct-mark"
        ),
        pytest.param(LOOPBACK, {"X-Real-IP": SIDECAR}, LOOPBACK, id="install-direct-naming"),
        # No peer at all: one shared bucket, never an unmetered one.
        pytest.param(None, {"Cf-Connecting-IP": "203.0.113.9"}, "unknown", id="no-peer"),
    ],
)
def test_the_bucket_is_the_door_with_relayed_visitors_apart(doors, peer, headers, bucket):
    assert _bucket(peer, headers) == bucket


def test_a_relayed_bucket_is_never_an_unrelayed_clients(doors):
    tunnel = _bucket(WEB, {"X-Real-IP": LOOPBACK, "Cf-Connecting-IP": "203.0.113.9"})
    funnel = _bucket(WEB, {"X-Real-IP": SIDECAR})
    unrelayed = {
        _bucket(WEB, {"X-Real-IP": LOOPBACK}),  # ./install through web
        _bucket(LOOPBACK, {}),  # ./install straight to core
        _bucket(WEB, {"X-Real-IP": SIDECAR, **LOGIN}),  # a tailnet person
    }
    assert unrelayed == {LOOPBACK, SIDECAR}
    assert tunnel not in unrelayed and funnel not in unrelayed
    # One relayed bucket per door: the tunnel's strangers never spend funnel's.
    assert tunnel != funnel


@pytest.mark.parametrize(
    "spelled",
    [
        {"X-Real-IP": LOOPBACK, "Cf-Connecting-IP": "203.0.113.9"},
        {"x-real-ip": LOOPBACK, "cf-connecting-ip": "203.0.113.9"},
        {"X-REAL-IP": LOOPBACK, "CF-CONNECTING-IP": "203.0.113.9"},
    ],
)
def test_a_plain_mapping_keeps_the_relay_split_whatever_its_spelling(doors, spelled):
    """Fix round 1 (I5): bucket_of reads header names case-insensitively
    itself (it lower-cases them), so a plain dict — which, unlike
    Starlette's Headers, matches only the exact spelling — can never lose
    the door or the relay mark."""
    assert network.bucket_of(WEB, spelled) == f"relayed via {LOOPBACK}"
    funnel = {k: v for k, v in spelled.items() if k.lower() == "x-real-ip"}
    funnel = {next(iter(funnel)): SIDECAR}
    assert network.bucket_of(WEB, funnel) == f"relayed via {SIDECAR}"
    person = {**funnel, "TAILSCALE-USER-LOGIN": "a@example.com"}
    assert network.bucket_of(WEB, person) == SIDECAR


# -- model-machines T5: tailnet_peers reads the sidecar's peer list ----------

PEER_DELL = {
    "ID": "nDELL",
    "HostName": "DELL-XPS-8950",
    "DNSName": "dell-xps-8950-windows.tailba0abb.ts.net.",
    "TailscaleIPs": ["100.122.40.93", "fd7a:115c:a1e0::1234:5678"],
    "OS": "windows",
    "Online": True,
}
PEER_WSL = {
    "ID": "nWSL",
    "HostName": "DELL-XPS-8950",
    "DNSName": "Dell-XPS-8950.tailba0abb.ts.net.",
    "TailscaleIPs": ["100.98.5.70"],
    "OS": "linux",
    "Online": False,
}
SELF = {
    "HostName": "nova",
    "DNSName": "nova.tailba0abb.ts.net.",
    "TailscaleIPs": ["100.64.0.1"],
    "OS": "linux",
    "Online": True,
}
DELL_PEER_SEEN = {
    "host_name": "DELL-XPS-8950",
    "dns_name": "dell-xps-8950-windows.tailba0abb.ts.net",
    "ips": ("100.122.40.93", "fd7a:115c:a1e0::1234:5678"),
    "os": "windows",
    "online": True,
}


@pytest.fixture
def peer_status(tmp_path, monkeypatch):
    path = tmp_path / "tailscale.json"
    monkeypatch.setenv(network.STATUS_FILE_ENV, str(path))
    peer_path = tmp_path / "tailscale-status.json"

    def write(body, *, age_s: float = 5.0, raw: bytes | None = None) -> None:
        if raw is not None:
            peer_path.write_bytes(raw)
        else:
            peer_path.write_text(json.dumps(body))
        at = (NOW - timedelta(seconds=age_s)).timestamp()
        os.utime(peer_path, (at, at))

    write.path = peer_path
    return write


def _live(peers) -> dict:
    return {"Version": "1.102.3", "BackendState": "Running", "Self": SELF, "Peer": peers}


def test_tailnet_peers_reads_the_file_beside_the_status_file(peer_status):
    peer_status(_live({"nodekey:dell": PEER_DELL}))
    assert peer_status.path == network.status_path().with_name("tailscale-status.json")
    got = network.tailnet_peers(NOW)
    assert got == network.Peers(peers=(DELL_PEER_SEEN,), reason=None)


def test_self_is_never_a_peer(peer_status):
    peer_status(_live({"nodekey:dell": PEER_DELL}))
    got = network.tailnet_peers(NOW)
    assert all(p["host_name"] != "nova" for p in got.peers)
    assert len(got.peers) == 1


def test_peers_are_normalised_and_sorted_by_dns_name(peer_status):
    peer_status(_live({"nodekey:w": PEER_DELL, "nodekey:l": PEER_WSL}))
    got = network.tailnet_peers(NOW)
    assert [p["dns_name"] for p in got.peers] == [
        "dell-xps-8950-windows.tailba0abb.ts.net",
        "dell-xps-8950.tailba0abb.ts.net",
    ]
    wsl = got.peers[1]
    assert wsl["ips"] == ("100.98.5.70",)
    assert wsl["os"] == "linux"
    assert wsl["online"] is False
    assert got.reason is None


def test_no_peer_file_is_no_peers_and_a_stated_reason_never_an_error(peer_status):
    got = network.tailnet_peers(NOW)
    assert got.peers == ()
    assert "no tailnet sidecar status" in got.reason
    assert "Nova runs without its tailnet" in got.reason


def test_a_stale_peer_file_is_no_peers(peer_status):
    peer_status(_live({"nodekey:dell": PEER_DELL}), age_s=network.MAX_AGE_S + 1)
    got = network.tailnet_peers(NOW)
    assert got.peers == ()
    assert "stopped writing" in got.reason


def test_a_peer_file_44_seconds_old_is_still_read(peer_status):
    peer_status(_live({"nodekey:dell": PEER_DELL}), age_s=44)
    got = network.tailnet_peers(NOW)
    assert got.peers == (DELL_PEER_SEEN,)
    assert got.reason is None


def test_a_peer_file_dated_in_the_future_is_no_peers(peer_status):
    peer_status(_live({"nodekey:dell": PEER_DELL}), age_s=-(network.MAX_AGE_S + 60))
    got = network.tailnet_peers(NOW)
    assert got.peers == ()
    assert "clocks disagree" in got.reason


@pytest.mark.parametrize(
    "raw",
    [b"{not json", b"\xff\xfe\x00garbage", b"[1, 2, 3]", b'"just a string"', b"null"],
    ids=["invalid-json", "not-utf8", "list", "string", "null"],
)
def test_a_malformed_peer_file_is_no_peers_with_a_reason_never_raised(peer_status, raw):
    peer_status(None, raw=raw)
    got = network.tailnet_peers(NOW)
    assert got.peers == ()
    assert isinstance(got.reason, str) and got.reason


@pytest.mark.parametrize("peer", ["absent", None, {}], ids=["no-key", "null", "empty"])
def test_a_tailnet_with_no_other_machines_is_not_a_failure(peer_status, peer):
    body = _live({})
    if peer == "absent":
        del body["Peer"]
    else:
        body["Peer"] = peer
    peer_status(body)
    got = network.tailnet_peers(NOW)
    assert got == network.Peers(peers=(), reason=None)


@pytest.mark.parametrize(
    "bad",
    [
        "not a dict",
        {k: v for k, v in PEER_WSL.items() if k != "HostName"},
        {**PEER_WSL, "TailscaleIPs": "100.98.5.70"},
    ],
    ids=["not-dict", "no-hostname", "ips-not-list"],
)
def test_one_malformed_peer_is_dropped_alone(peer_status, bad):
    peer_status(_live({"nodekey:dell": PEER_DELL, "nodekey:bad": bad}))
    got = network.tailnet_peers(NOW)
    assert got.peers == (DELL_PEER_SEEN,)
    assert got.reason is None


def test_the_peer_file_never_changes_what_address_says(status, peer_status):
    status()
    peer_status(_live({"nodekey:dell": PEER_DELL}))
    assert network.address(NOW).origin == "https://nova.fake-tailnet.ts.net"


def test_tailnet_peers_defaults_to_the_current_time(tmp_path, monkeypatch):
    monkeypatch.setenv(network.STATUS_FILE_ENV, str(tmp_path / "tailscale.json"))
    (tmp_path / "tailscale-status.json").write_text(json.dumps(_live({"nodekey:dell": PEER_DELL})))
    got = network.tailnet_peers()
    assert got == network.Peers(peers=(DELL_PEER_SEEN,), reason=None)


def test_a_peer_file_a_few_seconds_in_the_future_is_still_read(peer_status):
    peer_status(_live({"nodekey:dell": PEER_DELL}), age_s=-10)
    got = network.tailnet_peers(NOW)
    assert got == network.Peers(peers=(DELL_PEER_SEEN,), reason=None)


def test_an_unreadable_peer_file_is_no_peers_with_a_reason_never_raised(peer_status):
    peer_status.path.mkdir()
    got = network.tailnet_peers(NOW)
    assert got.peers == ()
    assert "could not be read" in got.reason


def test_each_peer_field_is_normalised_on_its_own(peer_status):
    odd = {
        "HostName": "box",
        "TailscaleIPs": ["100.70.0.9", 7, None, "fd7a::9"],
        "Online": "yes",
    }
    peer_status(_live({"nodekey:odd": odd}))
    got = network.tailnet_peers(NOW)
    assert got.peers == (
        {
            "host_name": "box",
            "dns_name": "",
            "ips": ("100.70.0.9", "fd7a::9"),
            "os": "",
            "online": False,
        },
    )
