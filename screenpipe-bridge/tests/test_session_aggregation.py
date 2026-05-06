from datetime import datetime, timedelta, timezone

import pytest
from app.session_aggregator import SessionAggregator


def _ocr(app: str, window: str, text: str, ts: datetime, url: str | None = None) -> dict:
    return {
        "name": "ocr_result",
        "data": {
            "app_name": app, "window_name": window, "text": text,
            "browser_url": url, "timestamp": ts.isoformat().replace("+00:00", "Z"),
            "focused": True, "frame_id": f"{app}-{window}-{ts.timestamp()}",
        },
    }


@pytest.mark.asyncio
async def test_session_finalized_when_focus_changes():
    finalized: list = []
    agg = SessionAggregator(
        on_session=lambda s: finalized.append(s),
        session_min_seconds=0,
        session_max_minutes=30,
    )
    t0 = datetime(2026, 5, 2, 14, 0, 0, tzinfo=timezone.utc)
    await agg.process(_ocr("VS Code", "main.py", "first line\n", t0))
    await agg.process(_ocr("VS Code", "main.py", "first line\nsecond line\n", t0 + timedelta(seconds=10)))
    await agg.process(_ocr("Slack", "#nova", "hello", t0 + timedelta(seconds=15)))

    assert len(finalized) == 1
    assert finalized[0].app == "VS Code"
    assert finalized[0].window == "main.py"
    assert "first line" in finalized[0].content
    assert "second line" in finalized[0].content
