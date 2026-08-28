"""GET /admin/hardware and GET /admin/suggest — the parts of the admin
plane that read the host's hardware.json (Ruling R2's mount contract)."""
from __future__ import annotations

from app import admin
from tests.conftest import requires_db

pytestmark = requires_db


async def test_hardware_missing_file_is_the_stated_200_note(client, monkeypatch, tmp_path):
    monkeypatch.setattr(admin, "HARDWARE_PATH", tmp_path / "nonexistent.json")

    resp = await client.get("/admin/hardware")

    assert resp.status_code == 200
    assert resp.json() == {"gpus": [], "note": "hardware.json missing — run install.sh"}


async def test_hardware_present_file_is_returned_verbatim(client, monkeypatch, tmp_path):
    hw_file = tmp_path / "hardware.json"
    hw_file.write_text(
        '{"gpus": [{"name": "RTX 3090", "vram_mb": 24576}], "ram_mb": 32000}'
    )
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
    hw_file = tmp_path / "hardware.json"
    hw_file.write_text('{"gpus": [{"name": "RTX 3090", "vram_mb": 24576}]}')
    monkeypatch.setattr(admin, "HARDWARE_PATH", hw_file)

    resp = await client.get("/admin/suggest")

    assert resp.status_code == 200
    body = resp.json()
    assert body["tier"] == "27B-class"
    assert body["models"][0]["slug"] == "qwen3.8:27b"
    assert set(body) == {"tier", "engine_suggestion", "models", "rationale"}


async def test_suggest_with_missing_hardware_file_still_answers(client, monkeypatch, tmp_path):
    monkeypatch.setattr(admin, "HARDWARE_PATH", tmp_path / "nonexistent.json")

    resp = await client.get("/admin/suggest")

    assert resp.status_code == 200
    assert resp.json()["tier"] == "3-4B"
