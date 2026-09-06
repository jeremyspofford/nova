"""Loads the curated model catalog — a static, in-repo JSON file that is
the VETTED layer of the model catalogue (S10a), nothing more.

Every slug in the file was checked against the live ollama library on
2026-08-28 (base page and exact tag), so `verify_at_walk` is false on every
row and each carries the `verified_url` it was checked against. The field
stays in the schema because the debt it marks recurs: a slug added later
starts life unverified, and test_curated.py refuses to let one ship that way.

What an entry may state is bounded on purpose. `use_cases` come from the
fixed taxonomy below and nowhere else — a value outside it would render as
a filter nothing else in the catalogue can match. `size_gb` is GONE: a
pull is now sized live from the registry manifest or the Hugging Face
sibling (app/pulls.py), and a typed number that outlived a re-pushed tag
was exactly the stale-but-confident figure that rule exists to kill. The
loader refuses a file that breaks either rule, so it cannot ship.
"""
from __future__ import annotations

import json
from pathlib import Path

CURATED_PATH = Path(__file__).resolve().parent / "curated_models.json"

USE_CASES = (
    "chat",
    "coding",
    "agentic",
    "reasoning",
    "writing",
    "vision",
    "long_context",
    "multilingual",
    "summarization",
)
REQUIRED_FIELDS = (
    "slug",
    "label",
    "family",
    "params_b",
    "min_vram_gb",
    "note",
    "verify_at_walk",
    "verified_at",
    "verified_url",
    "use_cases",
)
# Fields the file once carried and must not again, with the reason.
RETIRED_FIELDS = {
    "size_gb": "a pull is sized live from the registry manifest or the Hugging Face sibling",
}


class CuratedInvalid(ValueError):
    """The curated file states something it may not — the reason is the message."""


def validate_curated(entries) -> list[dict]:
    """`entries` unchanged when every entry is well-formed; CuratedInvalid
    naming the entry and the rule otherwise."""
    if not isinstance(entries, list):
        raise CuratedInvalid("the curated catalog must be a JSON array of entries")
    seen: set[str] = set()
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise CuratedInvalid(f"curated entry #{index} is not an object")
        slug = entry.get("slug", f"#{index}")
        missing = [field for field in REQUIRED_FIELDS if field not in entry]
        if missing:
            raise CuratedInvalid(f"curated entry {slug!r} is missing {', '.join(missing)}")
        retired = [field for field in RETIRED_FIELDS if field in entry]
        if retired:
            raise CuratedInvalid(
                f"curated entry {slug!r} carries {', '.join(retired)} — "
                + "; ".join(RETIRED_FIELDS[field] for field in retired)
            )
        if slug in seen:
            raise CuratedInvalid(f"curated slug {slug!r} appears more than once")
        seen.add(slug)
        use_cases = entry["use_cases"]
        if not isinstance(use_cases, list) or not use_cases:
            raise CuratedInvalid(f"curated entry {slug!r}: use_cases must be a non-empty list")
        unknown = [uc for uc in use_cases if uc not in USE_CASES]
        if unknown:
            raise CuratedInvalid(
                f"curated entry {slug!r} names use case(s) outside the taxonomy: "
                f"{', '.join(map(repr, unknown))} — allowed: {', '.join(USE_CASES)}"
            )
        if len(set(use_cases)) != len(use_cases):
            raise CuratedInvalid(f"curated entry {slug!r} repeats a use case")
    return entries


def load_curated(path: Path | None = None) -> list[dict]:
    """The curated catalog, as a list of entry dicts — validated on every
    load, so a bad edit fails the first request that reads it, not a
    filter on the Models page weeks later."""
    target = path or CURATED_PATH
    return validate_curated(json.loads(target.read_text()))
