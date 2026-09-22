# The mini PC, measured 2026-09-21

> **Superseded in part the same day:** on the owner's instruction ("You can clean up
> everything from all old nova stacks. nova-ai-platform included.") the three old
> projects were archived and then removed. What that changed is in the last section,
> ["After the cleanup"](#after-the-cleanup). Everything above it is the reading taken
> **before** the cleanup, and it is kept because it is what S41's install refusal and
> its fixtures are built from.

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


## After the cleanup (2026-09-21, same day)

The owner instructed: "You can clean up everything from all old nova stacks.
nova-ai-platform included." Done, in this order, each step verifying itself:

1. **Archived first.** Every volume of projects `nova`, `docker` and `project`
   was tarred from a throwaway container and **re-read and sha256-verified by
   the operator**, not by root, before anything was deleted:
   `/home/jeremy/nova-old-stacks-archive/` — 21 MB, six `.tgz` files plus
   `SHA256SUMS`, all `sha256sum -c` OK.
2. **The removal refused to start** unless every volume of every target project
   had a verified archive. It selected by the `com.docker.compose.project`
   label, never by name.
3. Removed: 13 containers, 6 volumes, 3 networks, 7 images.
4. **Verified after:** 0 leftovers for each of the three projects; `minecraft`
   still **running** (2 containers); `jobhunter` untouched (6 containers, 3
   volumes). The only volumes left on the machine are jobhunter's three.
5. The phantom tree at `/home/jeremy/workspace/nova` — four empty root-owned
   stub directories (`.env/`, `backups/`, `docker-compose.yml/`, `workspace/`)
   created by failed bind mounts on 2026-05-20, containing nothing — was removed
   with `rmdir`, which refuses a non-empty directory, rather than `rm -rf`. The
   path v4 will install to is now clear.

### What this changes for S41

- **The blocker is gone.** There is no foreign `nova` compose project on the
  mini PC any more, so nothing stands between S41's install and that machine.
- **172.18/16 is now free there.** The allocated subnets are down to 172.17
  (docker0) and 172.19 (jobhunter). v4 pins 172.18, so the collision that
  `decide_subnet` was written for no longer exists **on this machine**.
  `decide_subnet` is still required — it is a general mechanism, and 172.19 is
  still taken — but it is no longer load-bearing for this install.
- **The install refusal is still built, and still matters.** It is what makes
  the next machine safe, and its label-not-name rule is now proven by a real
  near-miss rather than argued.
- **The fixtures come from the reading above**, not from the live machine:
  after the cleanup there is nothing left to point them at. That is why the
  pre-cleanup reading is kept verbatim.
- **A new, measured design constraint:** a container writing the archive
  produces a **root-owned, mode-0600** file, and the host-side verification —
  running as the operator — then cannot read it back. That bit during this very
  cleanup. So a bundle written from a container must be `chown`ed to the
  invoking uid (or every verification step must also run in a container).
  Requirement #26 says an archive path that cannot hold mode 0600 is refused;
  this is the other half of it, and S41 must not assume the writer and the
  verifier are the same user.
- Disk on the mini PC after: **353 GB free of 460 GB**.

## One more leftover, found and disabled (2026-09-22, after the move)

A **named Cloudflare tunnel** ran on the mini PC as a host systemd service
(`cloudflared.service`, not part of any compose project), configured since
2026-09-05 to route a public hostname on the owner's own domain to
`http://127.0.0.1:3001`. Nothing listens on `:3001` — v4 serves on `:3000` —
and the hostname sits behind Cloudflare Access, which answers `302` at the
edge whether or not the tunnel is up. So it exposed nothing, and it was a
leftover of the old stacks.

On the owner's instruction it was **disabled, not deleted**:
`sudo systemctl disable --now cloudflared` — inactive, not enabled at boot, no
process left; the unit file and the Cloudflare-side configuration are
untouched. Reverse with `sudo systemctl enable --now cloudflared`.

**Found because a process listing prints full command lines**, and this
service's credential is in its `ExecStart`. Anything that lists processes on
that host with `pgrep -fa` or `ps -ef` will print it; redact before logging.
