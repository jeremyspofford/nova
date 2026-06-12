"""Wake-on-LAN end-to-end: a real UDP listener catches the real magic packet.

Requires the gateway to run with WOL_BROADCAST_ADDR=127.0.0.1 in test
environments (the suite skips the packet-capture assertions otherwise — port 9
needs root and a loopback-aimed broadcast).
"""
import os
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path

import httpx
import pytest
from dotenv import dotenv_values

BASE = "http://localhost:8000"
_env = dotenv_values(os.path.join(os.path.dirname(__file__), "..", ".env"))
_secret = _env.get("NOVA_ADMIN_SECRET") or os.getenv("NOVA_ADMIN_SECRET", "nova-dev-secret")
ADMIN = {"X-Admin-Secret": _secret}

TEST_MAC = "aa:bb:cc:dd:ee:ff"
EXPECTED_PACKET = b"\xff" * 6 + bytes.fromhex("aabbccddeeff") * 16


def _try_bind_udp(port: int) -> socket.socket | None:
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", port))
        sock.settimeout(10)
        return sock
    except OSError:
        return None


def _set_mac_secret():
    r = httpx.post(f"{BASE}/api/v1/secrets", headers=ADMIN,
                   json={"name": "wol_mac", "value": TEST_MAC})
    assert r.status_code in (200, 201, 409), r.text


def _del_mac_secret():
    httpx.delete(f"{BASE}/api/v1/secrets/wol_mac", headers=ADMIN)


def test_wake_409_when_unconfigured():
    _del_mac_secret()
    r = httpx.post(f"{BASE}/api/v1/llm/hardware/wake", headers=ADMIN, timeout=20.0)
    assert r.status_code == 409, r.text
    assert "wol_mac" in r.text


def test_hardware_reports_wol_state():
    # The gateway caches the MAC lookup for 60s; refresh=true bypasses it so the
    # dashboard's setup flow reflects secret changes instantly.
    _del_mac_secret()
    hw = httpx.get(f"{BASE}/api/v1/llm/hardware", headers=ADMIN,
                   params={"refresh": "true"}, timeout=20.0).json()
    assert hw["wol_configured"] is False
    _set_mac_secret()
    try:
        hw = httpx.get(f"{BASE}/api/v1/llm/hardware", headers=ADMIN,
                       params={"refresh": "true"}, timeout=20.0).json()
        assert hw["wol_configured"] is True
    finally:
        _del_mac_secret()
        hw = httpx.get(f"{BASE}/api/v1/llm/hardware", headers=ADMIN,
                       params={"refresh": "true"}, timeout=20.0).json()
        assert hw["wol_configured"] is False


def test_wake_sends_real_magic_packet():
    listener = _try_bind_udp(9)
    if listener is None:
        pytest.skip("cannot bind udp/9 (needs root) — packet capture skipped")
    _set_mac_secret()
    try:
        r = httpx.post(f"{BASE}/api/v1/llm/hardware/wake", headers=ADMIN, timeout=20.0)
        assert r.status_code == 202, r.text
        body = r.json()
        assert body["triggered"] is True
        data, _ = listener.recvfrom(256)
        assert data == EXPECTED_PACKET, f"bad packet: {data[:16].hex()}…"
    finally:
        listener.close()
        _del_mac_secret()


def test_helper_sends_packet_and_requires_auth():
    helper_path = Path(__file__).parent.parent / "wol-helper" / "app.py"
    listener = _try_bind_udp(9)
    if listener is None:
        pytest.skip("cannot bind udp/9 (needs root) — packet capture skipped")
    port = 18890 + (uuid.uuid4().int % 100)
    proc = subprocess.Popen(
        [sys.executable, str(helper_path)],
        env={**os.environ, "ADMIN_SECRET": _secret, "WOL_HELPER_PORT": str(port)},
    )
    try:
        for _ in range(20):
            try:
                if httpx.get(f"http://localhost:{port}/health", timeout=1.0).status_code == 200:
                    break
            except Exception:
                time.sleep(0.3)
        else:
            pytest.fail("wol-helper did not start")

        r = httpx.post(f"http://localhost:{port}/wake",
                       json={"mac": TEST_MAC, "broadcast": "127.0.0.1", "port": 9})
        assert r.status_code == 401, "helper must reject unauthenticated wakes"

        r = httpx.post(f"http://localhost:{port}/wake",
                       headers=ADMIN,
                       json={"mac": TEST_MAC, "broadcast": "127.0.0.1", "port": 9})
        assert r.status_code == 200, r.text
        data, _ = listener.recvfrom(256)
        assert data == EXPECTED_PACKET

        r = httpx.post(f"http://localhost:{port}/wake", headers=ADMIN,
                       json={"mac": "not-a-mac"})
        assert r.status_code == 422
    finally:
        proc.terminate()
        listener.close()
