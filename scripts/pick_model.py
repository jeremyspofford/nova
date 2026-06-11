#!/usr/bin/env python3
"""Print recommended Ollama models that fit the detected hardware.

Usage: pick_model.py <role> [hardware.json] [manifest.json]
Output: one `ollama_id|name|size_gb|agent_score|description` line per candidate,
best first. Used by ./install's model picker; falls back silently to nothing on
any error (the wizard then uses its free-text prompt).
"""
import json
import sys
from pathlib import Path

role = sys.argv[1] if len(sys.argv) > 1 else "completion"
hw_path = Path(sys.argv[2] if len(sys.argv) > 2 else "data/llm-gateway/hardware.json")
manifest_path = Path(sys.argv[3] if len(sys.argv) > 3 else "llm-gateway/data/recommended_models.json")

try:
    manifest = json.loads(manifest_path.read_text())
    hw = json.loads(hw_path.read_text()) if hw_path.exists() else {}
except Exception:
    sys.exit(0)

vram = sum(g.get("vram_gb", 0) for g in hw.get("gpus") or [])
ram = hw.get("ram_gb") or 0


def fits(entry) -> bool:
    if vram > 0:
        return (entry.get("min_vram_gb") or 0) <= vram
    if ram > 0:
        # CPU-only: gate on RAM and keep it snappy — 3B-class max. Bigger models
        # run but crawl (the 2026-06-09 dev box: 7B at >90s/response on CPU).
        return (entry.get("min_ram_gb") or 0) <= ram and (entry.get("size_gb") or 0) <= 2.5
    return True  # unknown hardware: don't gate, the list is sorted sanely anyway


candidates = [
    e for e in manifest.get("models", [])
    if not e.get("cloud")
    and e.get("ollama_id")
    and role in (e.get("roles") or [])
    and fits(e)
]
# Strongest agent score first; among equals, the bigger (more capable) model.
candidates.sort(key=lambda e: ((e.get("scores") or {}).get("agent", 0), e.get("size_gb", 0)), reverse=True)

try:
    for e in candidates[:4]:
        score = (e.get("scores") or {}).get("agent", "-")
        print(f"{e['ollama_id']}|{e['name']}|{e['size_gb']}|{score}|{e['description']}")
except BrokenPipeError:
    pass
