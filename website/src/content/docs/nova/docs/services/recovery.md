---
title: "Recovery Service"
description: "Backup/restore, factory reset, service management, and environment configuration. Port 8888."
---

The Recovery Service is Nova's resilience layer. It is designed to stay alive when all other Nova services are down, providing backup/restore, factory reset, service management, and environment configuration capabilities.

## At a glance

| Property | Value |
|----------|-------|
| **Port** | 8888 |
| **Framework** | FastAPI + asyncpg + Docker SDK |
| **Dependencies** | PostgreSQL + Docker socket + Redis (db 7) |
| **Source** | `recovery-service/` |

The Recovery Service intentionally has minimal dependencies. It connects directly to PostgreSQL (for backups), the Docker socket (for container management), and Redis db7 for `nova:system:*` data. It also cross-reads Redis db1 for `nova:config:inference.*` configuration written by the Orchestrator. It does not depend on the Orchestrator or any other Nova service -- this ensures it remains operational even during a complete system failure.

## Key responsibilities

- **Database backup** -- create, list, restore, and delete PostgreSQL backups
- **Factory reset** -- selective or complete data reset by category
- **Service management** -- list container status, restart individual services or all services
- **Environment management** -- read and update `.env` file variables (whitelist enforced, secrets masked)
- **Compose profile management** -- start/stop optional Docker Compose profiles (Cloudflare Tunnel, Tailscale)
- **Inference management** -- hardware detection, backend lifecycle (start/stop/health), managed container orchestration via Docker Compose profiles
- **System status** -- rich overview combining service health, database stats, and backup info

## Key endpoints

### Status

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/recovery/status` | Rich status overview: services, DB stats, backup info |

### Service management

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/recovery/services` | -- | List all Nova containers and their status |
| POST | `/api/v1/recovery/services/{name}/restart` | Admin | Restart a specific service |
| POST | `/api/v1/recovery/services/restart-all` | Admin | Restart all services |

### Backups

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/recovery/backups` | -- | List available backups |
| POST | `/api/v1/recovery/backups` | Admin | Create a new backup |
| POST | `/api/v1/recovery/backups/{filename}/restore` | Admin | Restore from a backup |
| DELETE | `/api/v1/recovery/backups/{filename}` | Admin | Delete a backup |

### Factory reset

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/recovery/factory-reset/categories` | List data categories available for reset |
| POST | `/api/v1/recovery/factory-reset` | Wipe categories not in the `keep` list (requires `confirm: "RESET"`; takes a safety backup first) |

A reset that wipes any database category also clears the migration ledger and
restarts the orchestrator. Nova's migrations are idempotent, so the automatic
re-run restores everything migrations seed -- default intel feeds, system
goals, default rules, and required config rows -- without touching the
categories you kept. Seeded state is back within seconds of the reset
completing; no manual restart is needed.

### Environment management

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/recovery/env` | Admin | Read whitelisted env vars (secrets masked) |
| PATCH | `/api/v1/recovery/env` | Admin | Update `.env` keys (whitelist enforced) |

### Compose profiles

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/recovery/compose-profiles` | Admin | Start/stop a compose profile (e.g., cloudflare-tunnel, tailscale) |

### Inference management

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/recovery/inference/hardware` | Admin | Get detected hardware info |
| POST | `/api/v1/recovery/inference/hardware/detect` | Admin | Re-run hardware detection |
| POST | `/api/v1/recovery/inference/backend/{name}/start` | Admin | Start an inference backend |
| POST | `/api/v1/recovery/inference/backend/stop` | Admin | Stop the active inference backend |
| GET | `/api/v1/recovery/inference/backend` | Admin | Get active backend status |
| GET | `/api/v1/recovery/inference/backends` | Admin | List all available backends |
| POST | `/api/v1/recovery/inference/backend/{backend}/switch-model` | Admin | Switch model on a single-model backend (vLLM/SGLang) via drain protocol |
| GET | `/api/v1/recovery/inference/models/search` | Admin | Search HuggingFace/Ollama model catalogs |
| GET | `/api/v1/recovery/inference/models/recommended` | Admin | Curated model recommendations filtered by VRAM |
| GET | `/api/v1/recovery/inference/recommendation` | Admin | Auto-recommend backend + model based on hardware |
| GET | `/api/v1/recovery/hardware/gpu-stats` | Admin | Live GPU utilization (via docker exec nvidia-smi) |

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health/live` | Liveness probe |
| GET | `/health/ready` | Readiness probe (checks DB connectivity) |

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | -- |
| `ADMIN_SECRET` | Admin authentication secret | -- |
| `BACKUP_DIR` | Directory for storing backups | `/backups` |
| `PORT` | Service port | `8888` |
| `REDIS_URL` | Redis connection (db7 for system data) | `redis://redis:6379/7` |
| `CHECKPOINT_INTERVAL_HOURS` | Auto-checkpoint interval | `6` |
| `CHECKPOINT_MAX_KEEP` | Maximum checkpoints to retain | `5` |

## Backup and restore

Backups are full PostgreSQL dumps stored in the configured backup directory (mounted as a Docker volume at `/backups`, mapped to `./backups/` on the host).

**Create a backup via the API:**

```bash
curl -X POST http://localhost:8888/api/v1/recovery/backups \
  -H "X-Admin-Secret: your-admin-secret"
```

**Or via the command line:**

```bash
make backup               # Create a backup
make restore               # List available backups
make restore F=<file>      # Restore a specific backup
```

The Recovery page in the Dashboard provides a visual interface for the same operations.

## Inference management

Recovery manages local inference backends (Ollama, vLLM, SGLang) via Docker Compose profiles. Only one local backend can be active at a time.

**Hardware detection** -- on startup and on demand, Recovery detects the host's GPU (NVIDIA/AMD), VRAM, Docker GPU runtime availability, CPU cores, RAM, and disk space. Results are stored in Redis as `nova:system:hardware`.

**Backend lifecycle** -- Recovery handles the full lifecycle of inference backends: pulling the container image, starting the container via Compose profiles, and ongoing health monitoring. Health checks run on a 30-second interval; 3 consecutive failures trigger an automatic restart with exponential backoff.

**Backend switching** -- when switching from one backend to another, Recovery uses a drain protocol that ensures zero dropped requests. The active backend continues serving in-flight requests while the new backend starts up and passes health checks before traffic is cut over.

**Model switching** -- for single-model backends (vLLM, SGLang), Recovery handles model switching via the drain protocol. The `POST /inference/backend/{backend}/switch-model` endpoint drains in-flight requests, stops the container, updates the model, and restarts with the new model loaded.

**Model discovery** -- Recovery provides model catalog search (`GET /inference/models/search`) that queries HuggingFace for vLLM/SGLang-compatible models and the Ollama registry for Ollama models. Results include VRAM estimates for hardware-aware filtering. A curated set of recommended models is served from `data/recommended_models.json` via `GET /inference/models/recommended`.

**Auto-recommendation** -- the `GET /inference/recommendation` endpoint analyzes detected hardware and recommends both a backend and a model. It considers GPU vendor, available VRAM, and whether a Docker GPU runtime is available.

**GPU monitoring** -- when an NVIDIA GPU is present, `GET /hardware/gpu-stats` returns live utilization, VRAM usage, temperature, and power draw by running `nvidia-smi` inside the active inference container via Docker exec.

**Redis connections** -- Recovery maintains two Redis connections. It uses db7 for `nova:system:*` keys (hardware facts, backend state), and cross-reads db1 for `nova:config:inference.*` keys (inference configuration written by the Orchestrator).

## Implementation notes

- **Docker SDK** -- uses the Docker SDK for Python to interact with containers via the Docker socket, enabling container inspection, restart, and status checks
- **Whitelist enforcement** -- environment variable reads and writes are restricted to a whitelist of known Nova configuration keys; arbitrary env vars cannot be accessed
- **Secret masking** -- when reading env vars, sensitive values (API keys, secrets) are masked in the response
- **Auth** -- all mutating endpoints require the `X-Admin-Secret` header; read-only endpoints (service list, backup list) are open
- **Compose profiles** -- the service manages Docker Compose profiles for optional services like Cloudflare Tunnel and Tailscale, enabling the Remote Access page in the Dashboard to start/stop these services
