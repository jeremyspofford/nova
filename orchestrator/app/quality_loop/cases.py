"""Load benchmark cases from YAML fixtures.

One file per category in benchmarks/quality/cases/. Each file is a list
of cases. Each case declares: name, category, seed_memories, conversation,
scoring (per-dimension rules).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

log = logging.getLogger(__name__)

_REQUIRED_FIELDS = {"name", "category", "conversation", "scoring"}


@dataclass
class BenchmarkCase:
    name: str
    category: str
    seed_memories: list[dict[str, Any]] = field(default_factory=list)
    conversation: list[dict[str, str]] = field(default_factory=list)
    scoring: dict[str, dict[str, Any]] = field(default_factory=dict)


def _validate_case(raw: dict[str, Any], source: Path) -> None:
    missing = _REQUIRED_FIELDS - set(raw.keys())
    if missing:
        raise ValueError(
            f"benchmark case in {source} missing required fields: {sorted(missing)}"
        )


def load_cases(cases_dir: Path, category: str | None = None) -> list[BenchmarkCase]:
    """Walk cases_dir, parse YAML, return BenchmarkCase list.

    If category is set, return only cases matching that category.
    """
    cases: list[BenchmarkCase] = []
    for yaml_path in sorted(cases_dir.glob("*.yaml")):
        try:
            data = yaml.safe_load(yaml_path.read_text()) or []
        except yaml.YAMLError as e:
            raise ValueError(f"malformed YAML in {yaml_path}: {e}") from e
        if not isinstance(data, list):
            raise ValueError(
                f"{yaml_path}: expected a YAML list of cases "
                f"(did you forget the leading '- ' on the first case?)"
            )
        for raw in data:
            _validate_case(raw, yaml_path)
            cases.append(
                BenchmarkCase(
                    name=raw["name"],
                    category=raw["category"],
                    seed_memories=raw.get("seed_memories", []),
                    conversation=raw["conversation"],
                    scoring=raw["scoring"],
                )
            )
    if category:
        cases = [c for c in cases if c.category == category]
    return cases
