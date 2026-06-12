"""Unit tests: bundled manifest validity + hardware fit logic. No network."""
import json
from pathlib import Path

from app import hardware
from app.manifest import BUNDLED_PATH, SCHEMA_VERSION, _valid


def test_bundled_manifest_is_valid():
    data = json.loads(Path(BUNDLED_PATH).read_text())
    assert _valid(data)
    assert data["schema_version"] == SCHEMA_VERSION
    assert len(data["models"]) > 15
    assert data["denylist"]


def test_bundled_entries_are_complete():
    data = json.loads(Path(BUNDLED_PATH).read_text())
    for e in data["models"]:
        assert e["name"], e
        assert e["category"] in ("general", "reasoning", "code", "vision", "embedding"), e
        assert isinstance(e["roles"], list), e
        assert isinstance(e["cloud"], bool), e
        assert "tools" in e["capabilities"], e
        if e["cloud"]:
            assert e["provider"], f"cloud entry without provider: {e['name']}"
            assert e["ollama_id"] or e.get("api_id"), e
        else:
            assert e["ollama_id"], e
            assert e["size_gb"] > 0, e
        if e["scores"] is not None:
            assert set(e["scores"]) == {"agent", "reasoning", "coding", "speed"}, e
            assert all(0 <= v <= 5 for v in e["scores"].values()), e
        # The whole point: nothing without tool support can be a completion model.
        if e["capabilities"]["tools"] is False:
            assert "completion" not in e["roles"], (
                f"{e['name']}: completion role on a model without tool calling"
            )


def test_exactly_one_default():
    data = json.loads(Path(BUNDLED_PATH).read_text())
    defaults = [e["name"] for e in data["models"] if e.get("default")]
    assert len(defaults) == 1, defaults


def test_loaded_model_shaping():
    # The three diagnostic states: fully on CPU, partial offload, fully resident.
    shaped = hardware.shape_loaded_models([
        {"name": "cpu-bound", "size": 1000, "size_vram": 0},
        {"name": "partial", "size": 1000, "size_vram": 600},
        {"name": "resident", "size": 1000, "size_vram": 1000},
        {"name": "no-size", "size": 0, "size_vram": 0},
    ])
    by_name = {m["name"]: m for m in shaped}
    assert by_name["cpu-bound"]["vram_pct"] == 0
    assert by_name["partial"]["vram_pct"] == 60
    assert by_name["resident"]["vram_pct"] == 100
    assert by_name["no-size"]["vram_pct"] is None


def test_fit_logic():
    gpu24 = {"source": "declared", "gpus": [{"vram_gb": 24}], "ram_gb": 64}
    cpu16 = {"source": "detected", "gpus": [], "ram_gb": 16}
    unknown = {"source": "unknown", "gpus": [], "ram_gb": None}

    assert hardware.fits(gpu24, min_vram_gb=24, min_ram_gb=40) is True
    assert hardware.fits(gpu24, min_vram_gb=48, min_ram_gb=80) is False
    # CPU-only path gates on RAM.
    assert hardware.fits(cpu16, min_vram_gb=6, min_ram_gb=10) is True
    assert hardware.fits(cpu16, min_vram_gb=24, min_ram_gb=40) is False
    # Unknown profile never gates.
    assert hardware.fits(unknown, min_vram_gb=48, min_ram_gb=96) is None

    assert hardware.total_vram_gb(gpu24) == 24
    assert hardware.total_vram_gb(cpu16) == 0
