---
title: "Deployment"
description: "Development and production commands, GPU overlays, remote GPU setup, and backup/restore."
---

## Quick start

```bash
git clone https://github.com/jeremyspofford/nova.git
cd nova
./install
```

The setup wizard configures everything and starts all services. See [Quick Start](/nova/docs/quickstart) for details.

## Development commands

| Command | Description |
|---------|-------------|
| `make dev` | Start all services with hot reload (or `docker compose up --build --watch`) |
| `make watch` | Sync Python source into running containers without rebuilding |
| `make logs` | Tail all container logs |
| `make ps` | Show container status |

The dashboard dev server runs on port **5173** via Vite with proxy rules to backend services.

## Production commands

| Command | Description |
|---------|-------------|
| `make build` | Rebuild all Docker images |
| `make up` | Start all services detached |
| `make down` | Stop all services |

In production, the dashboard uses nginx on port **3000**.

## GPU overlays

The setup script auto-detects GPU hardware, but you can manually apply GPU overlays:

### NVIDIA

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d
```

### AMD ROCm

```bash
docker compose -f docker-compose.yml -f docker-compose.rocm.yml up -d
```

## Remote GPU setup

Nova supports a split topology where the main stack runs on one machine and GPU inference runs on a separate machine (connected over LAN):

1. **On the GPU machine**, run the remote setup script:

```bash
bash <(curl -s https://raw.githubusercontent.com/jeremyspofford/nova/main/scripts/setup-remote-ollama.sh)
```

2. **On the Nova machine**, set the remote URL in `.env`:

```bash
OLLAMA_BASE_URL=http://192.168.1.50:11434
```

3. **Optional: Wake-on-LAN** -- configure WoL so Nova can wake the GPU machine on demand:

```bash
WOL_MAC_ADDRESS=AA:BB:CC:DD:EE:FF
WOL_BROADCAST_IP=192.168.1.255
```

This topology is ideal when you have a low-power always-on server (like a mini PC) running Nova and a separate desktop with a GPU that only powers on when inference is needed.

## Inference backend selection

Nova manages local inference backends automatically. Select your backend from the dashboard (Settings → AI & Models → Local Inference) and Nova handles the container lifecycle -- image pulling, startup, health monitoring, and graceful switching.

Supported managed backends:
- **vLLM** -- GPU inference with continuous batching. Recommended for NVIDIA/AMD GPUs with 8+ GB VRAM.
- **Ollama** -- Easy mode with hot-swap models. Works on CPU, good for beginners.

The setup script auto-detects your GPU hardware and recommends a backend. See [Inference Backends](/nova/docs/inference-backends) for details.

For advanced use, backends can still be started manually via Docker Compose profiles:

```bash
# Manual backend start (not needed if using dashboard)
docker compose --profile local-vllm up -d nova-vllm
```

## Observability (optional)

Nova ships Grafana dashboards over its own Postgres as an opt-in compose profile:

```bash
docker compose --profile observability up -d grafana
```

Grafana serves on `http://localhost:3001` (loopback-bound; set `GRAFANA_BIND=0.0.0.0:` to expose). Log in as `admin` with `GRAFANA_ADMIN_PASSWORD` (defaults to your `NOVA_ADMIN_SECRET`). Two dashboards are provisioned under the **Nova** folder:

- **Nova Autonomy** — active goals, standing schedules with next-fire times, tasks per hour by status, reflection outcomes, and the most recent lessons Nova recorded.
- **Nova Operations** — task throughput and failures, pipeline spend per hour, push-delivery receipts (accepted vs not delivered), and Inbox unread count.

The container is stateless — datasource and dashboards are provisioned from read-only files in `observability/grafana/`, so it can be stopped and removed at any time with nothing to migrate.

## Backup and restore

### Via the Recovery UI (recommended)

The Recovery service runs at `http://localhost:8888` and is accessible from the dashboard at `/recovery`. It provides:

- One-click database backup
- Backup history and restore
- Factory reset
- Service health monitoring

The Recovery service only depends on PostgreSQL -- it stays alive even when other services crash, so you always have access to backup and restore.

### Via the CLI

```bash
# Create a backup
make backup

# List available backups
make restore

# Restore a specific backup
make restore F=backups/nova-backup-2025-01-15.sql.gz
```

Backups are stored in the `./backups/` directory.
