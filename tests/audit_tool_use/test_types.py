from dataclasses import FrozenInstanceError

import pytest

from audit_tool_use.types import Cleanup, Outcome, Probe, TrialResult, Verifier


def test_outcome_has_five_levels():
    """Outcome levels per spec section 'Approach' step 8."""
    assert Outcome.NOT_CALLED.value == "not_called"
    assert Outcome.CALLED_ERROR.value == "called_error"
    assert Outcome.CALLED_OK.value == "called_ok"
    assert Outcome.SIDE_EFFECT_VERIFIED.value == "side_effect_verified"
    assert Outcome.AUDIT_INFRA_TIMEOUT.value == "audit_infra_timeout"


def test_probe_is_frozen():
    """Probes are declarative data; mutation should error."""
    p = Probe(
        id="t",
        tool="fs.write",
        prompt_template="x",
        expected_args_subset=None,
        verifier=Verifier.SKIP,
        cleanup=Cleanup.NONE,
        tier="MUTATE",
    )
    with pytest.raises(FrozenInstanceError):
        p.id = "changed"


def test_trial_result_carries_required_fields():
    tr = TrialResult(
        probe_id="t", tool="fs.write", model="x", trial_n=0,
        outcome=Outcome.NOT_CALLED, latency_ms=0, error_msg=None,
        trace_path=None, cleanup_failed=False, run_id="abc",
    )
    assert tr.outcome is Outcome.NOT_CALLED
