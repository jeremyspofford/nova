from datetime import datetime, timedelta, timezone

import pytest

from app.session_aggregator import SessionAggregator


def _ocr(app, window, text, ts):
    return {
        "name": "ocr_result",
        "data": {
            "app_name": app, "window_name": window, "text": text,
            "browser_url": None, "timestamp": ts.isoformat().replace("+00:00", "Z"),
            "focused": True, "frame_id": str(ts.timestamp()),
        },
    }


@pytest.mark.asyncio
async def test_session_under_30s_dropped():
    finalized = []
    agg = SessionAggregator(
        on_session=lambda s: finalized.append(s),
        session_min_seconds=30, session_max_minutes=30,
    )
    t0 = datetime.now(timezone.utc)
    await agg.process(_ocr("Slack", "#dms", "ping", t0))
    await agg.process(_ocr("Slack", "#dms", "ping pong", t0 + timedelta(seconds=10)))
    await agg.process(_ocr("Other", "Other", "switched", t0 + timedelta(seconds=11)))

    assert finalized == []  # Slack session was 10s, dropped
