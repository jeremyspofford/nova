"""GET /admin/hardware and GET /admin/suggest — the parts of the admin
plane that read the host's hardware.json (Ruling R2's mount contract).

S22 left this file exactly one live job: the wizard's TIER, and only when
the card itself cannot be read — the install-time case, on a container
without GPU passthrough yet. Every test below that means to exercise the
file therefore has to say the card is unreadable, or it is measuring the
live reading instead.
"""

from __future__ import annotations

from app import admin, devices_vram
from tests.conftest import requires_db

pytestmark = requires_db


def _no_card(monkeypatch) -> None:
    async def _read():
        return devices_vram.Vram(reason="nvidia-smi could not be run — no GPU passthrough")

    monkeypatch.setattr(devices_vram, "read_vram", _read)


async def test_hardware_missing_file_is_the_stated_200_note(client, monkeypatch, tmp_path):
    monkeypatch.setattr(admin, "HARDWARE_PATH", tmp_path / "nonexistent.json")

    resp = await client.get("/admin/hardware")

    assert resp.status_code == 200
    assert resp.json() == {"gpus": [], "note": "hardware.json missing — run install.sh"}


async def test_hardware_present_file_is_returned_verbatim(client, monkeypatch, tmp_path):
    hw_file = tmp_path / "hardware.json"
    hw_file.write_text('{"gpus": [{"name": "RTX 3090", "vram_mb": 24576}], "ram_mb": 32000}')
    monkeypatch.setattr(admin, "HARDWARE_PATH", hw_file)

    resp = await client.get("/admin/hardware")

    assert resp.status_code == 200
    assert resp.json() == {"gpus": [{"name": "RTX 3090", "vram_mb": 24576}], "ram_mb": 32000}


async def test_hardware_corrupt_file_is_a_stated_200_note(client, monkeypatch, tmp_path):
    hw_file = tmp_path / "hardware.json"
    hw_file.write_text("{not valid json")
    monkeypatch.setattr(admin, "HARDWARE_PATH", hw_file)

    resp = await client.get("/admin/hardware")

    assert resp.status_code == 200
    body = resp.json()
    assert body["gpus"] == []
    assert "note" in body


async def test_suggest_wires_hardware_and_curated_together(client, monkeypatch, tmp_path):
    """The install-time path: no card readable, so the file install.sh wrote
    is what the tier comes from."""
    _no_card(monkeypatch)
    hw_file = tmp_path / "hardware.json"
    hw_file.write_text('{"gpus": [{"name": "RTX 3090", "vram_mb": 24576}]}')
    monkeypatch.setattr(admin, "HARDWARE_PATH", hw_file)

    resp = await client.get("/admin/suggest")

    assert resp.status_code == 200
    body = resp.json()
    assert body["tier"] == "27B-class"
    assert body["models"][0]["slug"] == "qwen3.8:27b"
    assert set(body) == {"tier", "engine_suggestion", "models", "rationale"}


async def test_suggest_with_neither_a_card_nor_a_hardware_file_still_answers(
    client, monkeypatch, tmp_path
):
    _no_card(monkeypatch)
    monkeypatch.setattr(admin, "HARDWARE_PATH", tmp_path / "nonexistent.json")

    resp = await client.get("/admin/suggest")

    assert resp.status_code == 200
    assert resp.json()["tier"] == "3-4B"


async def test_the_live_card_beats_a_hardware_file_that_disagrees(client, monkeypatch, tmp_path):
    """The whole point of the demotion. install.sh recorded a 6GB card;
    the machine now has a 24GB one. The live reading wins, and nobody has
    to remember to re-run the installer."""

    async def _read():
        return devices_vram.Vram(total_mb=24576.0, used_mb=2662.0, free_mb=21914.0)

    monkeypatch.setattr(devices_vram, "read_vram", _read)
    hw_file = tmp_path / "hardware.json"
    hw_file.write_text('{"gpus": [{"name": "an old card", "vram_mb": 6144}]}')
    monkeypatch.setattr(admin, "HARDWARE_PATH", hw_file)

    resp = await client.get("/admin/suggest")

    assert resp.json()["tier"] == "27B-class"
