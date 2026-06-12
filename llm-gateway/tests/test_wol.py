"""Unit tests: magic packet construction + auto-wake rate limiting. No network."""
import time

import pytest
from app import wol
from app.router import _is_connection_error


def test_magic_packet_structure():
    pkt = wol.build_magic_packet("AA:BB:CC:DD:EE:FF")
    assert len(pkt) == 102
    assert pkt[:6] == b"\xff" * 6
    assert pkt[6:12] == bytes.fromhex("aabbccddeeff")
    assert pkt[6:] == bytes.fromhex("aabbccddeeff") * 16


@pytest.mark.parametrize("mac", ["aa:bb:cc:dd:ee:ff", "AA-BB-CC-DD-EE-FF", "aabb.ccdd.eeff", "aabbccddeeff"])
def test_mac_formats_accepted(mac):
    assert len(wol.build_magic_packet(mac)) == 102


@pytest.mark.parametrize("mac", ["", "aa:bb:cc", "zz:bb:cc:dd:ee:ff", "aa:bb:cc:dd:ee:ff:00"])
def test_invalid_macs_rejected(mac):
    with pytest.raises(ValueError):
        wol.build_magic_packet(mac)


def test_connection_error_detection():
    assert _is_connection_error(Exception("Connection refused"))
    assert _is_connection_error(Exception("APIConnectionError: [Errno 111]"))
    assert _is_connection_error(Exception("Request timed out"))
    assert not _is_connection_error(Exception("Invalid API key"))
    assert not _is_connection_error(Exception("model not found"))


@pytest.mark.asyncio
async def test_wake_if_due_rate_limits(monkeypatch):
    sent = []

    async def fake_get_mac(force=False):
        return "aa:bb:cc:dd:ee:ff"

    async def fake_send(mac):
        sent.append(mac)
        return {"via": "direct-udp"}

    monkeypatch.setattr(wol, "get_mac", fake_get_mac)
    monkeypatch.setattr(wol, "send_wake", fake_send)
    wol._last_auto_wake = None

    assert await wol.wake_if_due("first") is True
    assert await wol.wake_if_due("suppressed") is False
    assert sent == ["aa:bb:cc:dd:ee:ff"]

    wol._last_auto_wake = time.monotonic() - 10_000
    assert await wol.wake_if_due("after interval") is True
    assert len(sent) == 2


@pytest.mark.asyncio
async def test_wake_if_due_noop_without_mac(monkeypatch):
    async def fake_get_mac(force=False):
        return None

    monkeypatch.setattr(wol, "get_mac", fake_get_mac)
    wol._last_auto_wake = None
    assert await wol.wake_if_due("unconfigured") is False
