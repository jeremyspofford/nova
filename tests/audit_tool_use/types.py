"""Core types for the tool-use audit. Declarative; no I/O here."""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Literal


class Outcome(str, Enum):
    """Per-trial outcome.

    Two conceptual axes share this enum for simplicity:
      - Tool-attribution axis (AC-Q2's "four levels"):
          NOT_CALLED < CALLED_ERROR < CALLED_OK < SIDE_EFFECT_VERIFIED
      - Infra axis (AC-B5):
          AUDIT_INFRA_TIMEOUT — set when the audit itself failed (wall-clock,
          setup failure, etc.). Distinct from tool-attribution outcomes.

    SKIPPED is reported on a separate field of TrialResult, not in this enum.
    """
    NOT_CALLED = "not_called"
    CALLED_ERROR = "called_error"
    CALLED_OK = "called_ok"
    SIDE_EFFECT_VERIFIED = "side_effect_verified"
    AUDIT_INFRA_TIMEOUT = "audit_infra_timeout"


class Verifier(str, Enum):
    """Strategy sentinels; concrete verifier objects live in verifiers.py."""
    SKIP = "skip"


class Cleanup(str, Enum):
    """Sentinels; concrete cleanup objects live in cleanups.py."""
    NONE = "none"


class Setup(str, Enum):
    """Sentinels; concrete setup objects live in setups.py."""
    NONE = "none"


@dataclass(frozen=True)
class Probe:
    id: str
    tool: str                            # original dotted name, e.g. "fs.write"
    prompt_template: str                 # uses {run_id}, {token} placeholders
    expected_args_subset: dict[str, Any] | None  # reserved for future arg-validation; not consumed in v1
    verifier: Any                        # Verifier.SKIP or concrete object from verifiers.py
    setup: Any = None                    # Setup.NONE or concrete object from setups.py — runs BEFORE the probe
    cleanup: Any = None                  # Cleanup.NONE or concrete object from cleanups.py
    tier: Literal["READ", "MUTATE"] = "READ"


@dataclass
class TrialResult:
    probe_id: str
    tool: str
    model: str
    trial_n: int
    outcome: Outcome
    latency_ms: int
    error_msg: str | None
    trace_path: str | None
    cleanup_failed: bool
    run_id: str
    skipped_reason: str | None = None
    verifier_failed_reason: str | None = None
