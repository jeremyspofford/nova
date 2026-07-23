-- Migration 046: observability phase 2 — instance registry + resource history
-- (docs/plans/observability-board.md, phase 2)
--
-- The shared DB is the fleet aggregator: every instance samples ITS OWN host
-- ~60s and writes rows tagged with its instance_id; any instance serving the
-- board reads the whole fleet back out. Samples are diagnostics, not memory —
-- the leader-gated retention prune deletes them freely.

-- Stable identity for a Nova backend on a machine. Co-owned with
-- remote-shared-state.md (whichever lane landed first owns the shape).
CREATE TABLE IF NOT EXISTS instances (
    id          TEXT PRIMARY KEY,        -- persisted per-host uuid (/state)
    label       TEXT,                    -- human name ("work laptop")
    role        TEXT,                    -- hint: 'inference' | 'db' | 'memory' | 'all'
    first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
    reaches     JSONB NOT NULL DEFAULT '{}'  -- {pg:{ok,ms}, memory:{ok,ms}}
);

CREATE TABLE IF NOT EXISTS resource_samples (
    instance_id    TEXT NOT NULL,
    ts             TIMESTAMPTZ NOT NULL,
    cpu_pct        REAL,
    load1          REAL,
    mem_used_gb    REAL,
    mem_total_gb   REAL,
    vram_used_gb   REAL,
    vram_total_gb  REAL,
    gpu_pct        REAL,
    gpu_temp_c     REAL,
    disk_used_gb   REAL,
    disk_total_gb  REAL,
    detail         JSONB NOT NULL DEFAULT '{}'  -- per-container / per-gpu / docker-disk breakdown
);
CREATE INDEX IF NOT EXISTS resource_samples_inst_ts_idx
    ON resource_samples (instance_id, ts DESC);

-- Which "muscle" served a turn — rollups can break down per instance.
ALTER TABLE turn_traces ADD COLUMN IF NOT EXISTS instance_id TEXT;
