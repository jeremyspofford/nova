"""S47 — core's one reader of the tailnet sidecar's status file (D17).

Every QR code, her nova_address tool and the address guard read through
network.address(), so each condition it refuses on is pinned here: a stated
address is a claim about another device's reach, and a wrong one is a QR code
that opens nothing."""

from __future__ import annotations

import json
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
