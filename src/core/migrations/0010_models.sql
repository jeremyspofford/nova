-- The local model manager (M6 plan §2). None of these replicate: each is about this node's own
-- devices and runtimes, read again from them; budgets' usage counts the hub's own calls.

-- What a paired computer reported in its heartbeat: CPU, memory, GPUs, disk, network cards (for
-- Wake-on-LAN). The hub's own is read when asked, not stored.
CREATE TABLE device_hardware (
  device_id TEXT PRIMARY KEY,
  hardware TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Every wake: when the packet went, when the device's models answered, how long that took. The
-- last answered wake is the measured wake latency the next one waits for.
CREATE TABLE device_wake (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  awake_at TEXT,
  waited_ms INTEGER,
  outcome TEXT NOT NULL
);
CREATE INDEX device_wake_device ON device_wake (device_id, id);

-- Model versions, by digest, as Nova itself read them from each runtime's list: when first and
-- last seen, when gone, and the download or removal task that made the change.
CREATE TABLE model_version (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  runtime_url TEXT NOT NULL,
  name TEXT NOT NULL,
  digest TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  details TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  removed_at TEXT,
  task_id TEXT
);
CREATE UNIQUE INDEX model_version_key ON model_version (device_id, name, digest);

-- Cloud usage, for budgets: every cloud call the model manager made, and the usage in every
-- report from a provider that sent work off the devices. `ref` keeps a report from counting twice.
CREATE TABLE cloud_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  task_id TEXT,
  session_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL,
  ref TEXT UNIQUE
);
CREATE INDEX cloud_usage_at ON cloud_usage (at);
CREATE INDEX cloud_usage_task ON cloud_usage (task_id);
