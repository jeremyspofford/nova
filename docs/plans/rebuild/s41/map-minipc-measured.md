# The mini PC, measured 2026-09-21 (read-only)

Taken over Tailscale SSH from the Dell, read-only: no container was started,
stopped or removed, no volume touched, nothing written to that machine. This
file is a **measurement**, not a plan. Where it contradicts
`hub-p0-measurements.md` as written on 2026-09-18, this reading is the later
one and that file has been corrected.

## The finding that changes the design: a `nova_` name is not the `nova` project

`docker volume inspect`, read back per volume:

| Volume | `com.docker.compose.project` | `com.docker.compose.volume` | Size |
|---|---|---|---|
| `nova_postgres-data` | **nova** | `postgres-data` | 67.66 MB |
| `nova_redis-data` | **nova** | `redis-data` | 37.06 kB |
| `nova_pgdata` | **docker** | `nova_pgdata` | 75.77 MB |
| `nova_redis_data` | **docker** | `nova_redis_data` | 264 B |
| `jobhunter_postgres_data` | jobhunter | `postgres_data` | 129.8 MB |
| `jobhunter_redis_data` | jobhunter | `redis_data` | 98.03 kB |
| `jobhunter_frontend_node_modules` | jobhunter | `frontend_node_modules` | 459.5 MB |
| `project_postgres-data` | project | `postgres-data` | 0 B |
| `project_redis-data` | project | `redis-data` | 0 B |

Project `docker` is `/home/jeremy/repos/nova-ai-platform/infra/docker/docker-compose.yml`.
It also owns containers **named** `nova-redis` and `nova-postgres`.

**So the obvious implementation of the owner's deletion ruling — select by the
name prefix `nova` — would destroy 75.8 MB belonging to a different project of
his, and two of its containers.** Selection MUST be by the
`com.docker.compose.project` label, read from `docker` itself, never by name,
and the installer must print the label it matched beside every object it names.

This is the test S41 pins: a fixture holding `nova_postgres-data` (project
`nova`), `nova_pgdata` (project `docker`) and a v4 volume, asserting that only
the first is selected.

## The old `nova` project, exactly

Containers, all exited, all `project=nova`, all
`config_files=/home/jeremy/workspace/nova/docker-compose.yml`:

`nova-llm-gateway-1`, `nova-chat-bridge-1`, `nova-chat-api-1`,
`nova-orchestrator-1`, `nova-dashboard-1`, `nova-memory-service-1`,
`nova-recovery-1`, `nova-redis-1`, `nova-postgres-1` (image
`pgvector/pgvector:pg16`).

Volumes: `nova_postgres-data`, `nova_redis-data`. Network:
`nova_nova-internal` (172.20/16).

**Its compose file is a directory.** `/home/jeremy/workspace/nova/docker-compose.yml`
on that machine is a root-owned, empty **directory** dated May 20 — the
single-file bind-mount failure mode. Consequences:

- `docker compose -p nova down -v` cannot be used to remove that stack: compose
  cannot read its config. Removal must be `docker rm` + `docker volume rm`,
  selected by label.
- Any S41 code that assumes a foreign project's compose file is readable, or
  that it can ask compose what the project owns, is wrong on this very machine.
  Ask **docker**, not compose.

There is no v4 checkout on the mini PC: `/home/jeremy/workspace/nova` there has
no `deploy/` and is not a git repository.

## Other stacks on that machine, never to be touched

| Project | State | Config |
|---|---|---|
| `minecraft` | **running (2)** | `/home/jeremy/minecraft/docker-compose.yml` |
| `jobhunter` | exited (6) | `/home/jeremy/.openclaw/workspace/jobhunter/docker-compose.yml` |
| `docker` | exited (2) | `/home/jeremy/repos/nova-ai-platform/infra/docker/docker-compose.yml` |
| `project` | created (2) | `/project/docker-compose.yml` |

`minecraft` is running and must stay running: it is the reason the machine's
free RAM is 12.5 GiB rather than 15.4.

## Host facts that bind the encrypted bundle

| | |
|---|---|
| OS | Pop!_OS 24.04 LTS, Linux 6.18.7 x86_64 |
| bash | **5.2.21** |
| OpenSSL | **3.0.13** |
| GNU tar | 1.35 |
| coreutils | 9.4 (`sha256sum`, `md5sum` present) |
| `shasum` | 6.04 |
| python3 | **3.12.3** |
| gpg | 2.4.4 |
| zstd | 1.5.5 |
| `age` | **not installed** |
| Docker / compose | 29.8.0 / v5.5.1 |
| Disk | 351 GB free of 460 GB (20% used) |

Two consequences for the crypto choice:

1. **`age` is absent**, so a design that reaches for it must also ship or
   install it, on a machine that by definition is mid-restore.
2. **OpenSSL 3.0.13's `enc` subcommand cannot do authenticated AEAD safely** —
   `openssl enc` has no way to write or verify a GCM tag, so an
   `openssl enc -aes-256-gcm` bundle is unauthenticated in practice. Any design
   proposing it is wrong; python3 3.12 is present on this host, and v3's
   existing implementation is python.

## Network

Docker subnets already allocated: **172.17, 172.18, 172.19, 172.20, 172.21**
(all `linkdown`, all still allocated). `decide_subnet` must land at 172.22/16
or beyond. Host is on Wi-Fi `wlo1`, 192.168.0.245/24, default via 192.168.0.1.

## What was NOT measured

- Postgres **minor** version parity between the Dell's server and anything on
  the mini PC (open question 6 in `map-requirements.md`). Nothing v4 runs there
  yet, so there is nothing to compare until the install.
- Whether logind's `Inhibit sleep` is honoured from a linger unit (P0-9, gates
  S44).
