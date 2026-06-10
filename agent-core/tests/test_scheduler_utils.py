from datetime import datetime, timedelta, timezone

from app.scheduler.utils import compute_next_fire, resolve_placeholders


def test_cron_returns_future_datetime():
    result = compute_next_fire({"type": "cron", "expr": "0 9 * * *"})
    assert result is not None
    assert result > datetime.now(timezone.utc)


def test_interval_is_now_plus_seconds():
    before = datetime.now(timezone.utc)
    result = compute_next_fire({"type": "interval", "every_seconds": 3600})
    after = datetime.now(timezone.utc)
    assert before + timedelta(seconds=3599) < result < after + timedelta(seconds=3601)


def test_once_future_returns_that_time():
    future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    result = compute_next_fire({"type": "once", "at": future})
    assert result > datetime.now(timezone.utc)


def test_once_past_returns_now_not_none():
    past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    before = datetime.now(timezone.utc)
    result = compute_next_fire({"type": "once", "at": past})
    assert result is not None
    assert result >= before


def test_event_driven_triggers_return_none():
    for t in ("webhook", "fs_watch", "task_complete"):
        assert compute_next_fire({"type": t}) is None


def test_resolve_placeholders_substitutes():
    result = resolve_placeholders(
        "Check {file_path} — event: {file_event}",
        {"file_path": "/tmp/x.pdf", "file_event": "created"},
    )
    assert result == "Check /tmp/x.pdf — event: created"


def test_resolve_placeholders_leaves_unknown():
    result = resolve_placeholders("Task {task_id} done with {unknown}", {"task_id": "abc"})
    assert "{task_id}" not in result
    assert "{unknown}" in result
