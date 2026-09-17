"""The ONE row shape every catalogue source maps into.

Lives in its own module so the assembler (app/catalog.py) and the sources
that build rows on their own (app/hf_hub.py) share it without a cycle. A
row always carries every key in ROW_KEYS — an unknown fact is None (or an
empty dict), never a missing key: the page dereferences `actions`,
`facts`, `capabilities` and `suitability` on every row, and the first live
Hugging Face result once crashed the table because a mapper had left
`actions` out. tests/test_catalog.py pins `set(row) == ROW_KEYS` for a
row from EVERY source.
"""

from __future__ import annotations

ROW_KEYS = frozenset(
    {
        "id",
        "provider",
        "model",
        "label",
        "kind",
        "installed",
        "note",
        "sources",
        "facts",
        "capabilities",
        "suitability",
        "fit",
        "probe",
        "drift",
        "pull",
        "actions",
    }
)
BASES = frozenset({"declared", "inferred", "vetted", "measured"})
KINDS = ("local", "cloud", "hub")


def base_row(id_: str, provider: str, model: str, label: str, kind: str) -> dict:
    """Every key present; nothing claimed. `installed` is None until a
    source that can know (ollama's own tags) says otherwise."""
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {KINDS} — got {kind!r}")
    return {
        "id": id_,
        "provider": provider,
        "model": model,
        "label": label,
        "kind": kind,
        "installed": None,
        "note": None,
        "sources": [],
        "facts": {},
        "capabilities": {},
        "suitability": {},
        "fit": None,
        "probe": None,
        "drift": None,
        "pull": None,
        "actions": [],
    }


def fact(value, basis: str, source: str, **extra) -> dict:
    if basis not in BASES:
        raise ValueError(f"basis must be one of {sorted(BASES)} — got {basis!r}")
    entry = {"value": value, "basis": basis, "source": source}
    entry.update({k: v for k, v in extra.items() if v is not None})
    return entry
