-- The single active backend (ollama/remote/cloud) and the probe history
-- against it. One backend at a time: id is pinned to 1 so there is
-- structurally never a second row to disagree with.
CREATE TABLE IF NOT EXISTS backend_config (
    id integer PRIMARY KEY CHECK (id = 1),
    kind text NOT NULL CHECK (kind IN ('ollama', 'remote', 'cloud')),
    url text,
    provider text,
    model text,
    api_key text,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS probes (
    id serial PRIMARY KEY,
    model text NOT NULL,
    kind text NOT NULL,
    ok boolean NOT NULL,
    latency_ms integer,
    vram_mb integer,
    error text,
    created_at timestamptz NOT NULL DEFAULT now()
);
