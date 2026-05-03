import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from app.session_aggregator import SessionAggregator


def _ocr(app, window, text, ts):
    return {
        "name": "ocr_result",
        "data": {
            "app_name": app, "window_name": window, "text": text,
            "browser_url": None, "timestamp": ts.isoformat().replace("+00:00", "Z"),
            "focused": True, "frame_id": f"{ts.timestamp()}",
        },
    }


@pytest.mark.asyncio
async def test_repeated_lines_collapsed_within_session():
    finalized = []
    agg = SessionAggregator(
        on_session=lambda s: finalized.append(s),
        session_min_seconds=0, session_max_minutes=30,
    )
    t0 = datetime.now(timezone.utc)
    for i in range(5):
        await agg.process(_ocr("App", "Window", "line A\nline B\n", t0 + timedelta(seconds=i)))
    await agg.process(_ocr("Other", "Other", "x", t0 + timedelta(seconds=10)))

    assert finalized[0].content.count("line A") == 1
    assert finalized[0].content.count("line B") == 1
    assert finalized[0].content.index("line A") < finalized[0].content.index("line B")
