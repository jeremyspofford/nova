import pytest
from app.scheduler.heartbeat import build_daily_briefing_prompt, ALERT_CONDITIONS


def test_nothing_to_report_when_no_activity():
    result = build_daily_briefing_prompt(
        since_hours=24, completed=0, failed=0, skipped=0,
        pending_approvals=[], next_fires=[],
    )
    assert "Nothing to report" in result


def test_includes_counts_when_activity_present():
    result = build_daily_briefing_prompt(
        since_hours=24, completed=5, failed=2, skipped=1,
        pending_approvals=[{"tool_name": "fs.write", "waiting_minutes": 70}],
        next_fires=["2026-05-13T09:00:00Z"],
    )
    assert "5" in result
    assert "2" in result
    assert "fs.write" in result
    assert "2026-05-13T09:00:00Z" in result


def test_alert_conditions_keys_present():
    for key in ("task_failed", "mutate_pending_1h", "destruct_pending_15m", "fs_watch_error"):
        assert key in ALERT_CONDITIONS
