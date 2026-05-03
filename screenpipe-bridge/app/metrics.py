"""Prometheus counters and gauges for the screenpipe bridge."""

from prometheus_client import Counter, Gauge

sessions_ingested_total = Counter(
    "nova_screenpipe_sessions_ingested_total",
    "Successfully ingested screenpipe focus sessions",
    ["app"],
)

sessions_dropped_total = Counter(
    "nova_screenpipe_sessions_dropped_total",
    "Dropped screenpipe focus sessions by reason",
    ["reason"],
)

websocket_reconnects_total = Counter(
    "nova_screenpipe_websocket_reconnects_total",
    "WebSocket reconnect attempts",
)

polling_active = Gauge(
    "nova_screenpipe_polling_active",
    "1 if currently in polling fallback mode, else 0",
)
