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
async def test_long_session_split_at_30_min_cap():
    finalized = []
    agg = SessionAggregator(
        on_session=lambda s: finalized.append(s),
        session_min_seconds=0, session_max_minutes=30,
    )
    t0 = datetime(2026, 5, 2, 14, 0, 0, tzinfo=timezone.utc)
    # Same window, events spanning >30 min
    await agg.process(_ocr("VS Code", "main.py", "early\n", t0))
    await agg.process(_ocr("VS Code", "main.py", "mid\n", t0 + timedelta(minutes=20)))
    await agg.process(_ocr("VS Code", "main.py", "late\n", t0 + timedelta(minutes=35)))
    await agg.flush()

    assert len(finalized) == 2
    assert "early" in finalized[0].content
    assert "late" in finalized[1].content
    # Continuity check: second starts at the >30 min event timestamp
    assert finalized[1].started_at == t0 + timedelta(minutes=35)
