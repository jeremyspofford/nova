import os
import tempfile
import pytest
from app.watchers.handler import ScheduleWatchHandler, _fire_queue


def _drain():
    items = []
    while not _fire_queue.empty():
        items.append(_fire_queue.get_nowait())
    return items


def test_handler_enqueues_matching_file_create():
    _drain()
    handler = ScheduleWatchHandler(schedule_id="s1", on_events=["created"], pattern="*.pdf")
    from watchdog.events import FileCreatedEvent
    with tempfile.TemporaryDirectory() as d:
        handler.on_any_event(FileCreatedEvent(os.path.join(d, "report.pdf")))
    items = _drain()
    assert len(items) == 1
    assert items[0]["schedule_id"] == "s1"
    assert items[0]["file_event"] == "created"


def test_handler_ignores_wrong_pattern():
    _drain()
    handler = ScheduleWatchHandler(schedule_id="s2", on_events=["created"], pattern="*.pdf")
    from watchdog.events import FileCreatedEvent
    with tempfile.TemporaryDirectory() as d:
        handler.on_any_event(FileCreatedEvent(os.path.join(d, "notes.txt")))
    assert _drain() == []


def test_handler_ignores_wrong_event_type():
    _drain()
    handler = ScheduleWatchHandler(schedule_id="s3", on_events=["created"], pattern="*")
    from watchdog.events import FileModifiedEvent
    with tempfile.TemporaryDirectory() as d:
        handler.on_any_event(FileModifiedEvent(os.path.join(d, "any.txt")))
    assert _drain() == []


def test_handler_ignores_directory_events():
    _drain()
    handler = ScheduleWatchHandler(schedule_id="s4", on_events=["created"], pattern="*")
    from watchdog.events import DirCreatedEvent
    with tempfile.TemporaryDirectory() as d:
        handler.on_any_event(DirCreatedEvent(d))
    assert _drain() == []
