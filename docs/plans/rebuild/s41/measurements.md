# S41 measurements, taken 2026-09-21 before any code

The verdict's §15 lists ten risks, each with "the cheapest measurement that
settles it". Six of them were marked **Not run**. Five are now run. This file
records what came back, so the plan argues from readings rather than from
worry. Each is reproducible from the command shown.

## R1 — postgres minor parity (§15 risk 1: "take this before writing a line of T3")

The whole DoD rests on per-table counts and digests being equal across a
restore, and `t::text` renders through session GUCs, so a **minor** version
difference could fail every drill with no real difference.

```
docker exec nova-postgres-1 psql -U core -d nova_core -At -c "select version()"
docker image inspect postgres:16 --format '{{index .RepoDigests 0}}'
```

| | |
|---|---|
| Dell's running server | **PostgreSQL 16.15** (Debian 16.15-1.pgdg13+2) |
| The `postgres:16` tag as it resolves today | the **same image**, `PG_VERSION=16.15-1.pgdg13+2`, digest `sha256:f1c3376c…` |
| The running container | created from that exact digest |

**Settled for today: there is no skew to compare.** The dump-and-rediff test
the risk asks for is moot while the two are the same image. But
`deploy/docker-compose.yml:5` pins the **major** only, so the tag floats: the
mini PC will pull whatever `postgres:16` is on the day of the move, and that
may not be 16.15. So the mechanism the risk implies is still required — the
manifest records the exact `pg_server_version`, and restore compares it and
says what it found. T3 is unblocked; the comparison is not skipped, it is moved
to where the skew can actually appear.

## R2 — compose YAML shape across hosts (§15 risk 2: was "half measured")

Coverage reads dispositions out of the compose file, so a rendering difference
between the two hosts' compose versions would make it refuse everything — or,
worse, see nothing.

Measured with one synthetic compose file carrying a top-level `x-` key, a
per-volume `x-nova-disposition`, a service-level `x-`, a long-syntax mount
extension, and a volume **declared but mounted by no service**:

| | Dell, compose **v5.3.0** | Mini PC, compose **v5.5.1** |
|---|---|---|
| `config` (YAML) keeps nested `x-` | yes | yes |
| `config --format json` keeps nested `x-` | **no — stripped** | **no — stripped** |
| `config --format json` keeps a **top-level** `x-` | yes | yes |
| A declared, unmounted volume | **pruned from both renders** | **pruned from both renders** |

**Fully measured, both hosts, identical.** Two consequences, both already the
verdict's choices and now backed by readings rather than by one host:

1. Dispositions cannot be read from the JSON render at all — the nested ones
   are the only ones that matter.
2. The **declared set** must come from the raw compose text, because a volume
   no service mounts disappears from both renders, and coverage's whole job is
   to refuse on something it has not been told about.

## R3 — bundle size and wall time (§15 risk 3)

```
docker run --rm -v nova_v4_memdata:/a:ro -v nova_v4_workspace:/b:ro \
  --entrypoint sh postgres:16 -c 'du -sb /a /b'
```

| Volume | Size |
|---|---|
| `v4_memdata` | **1,000,162 B (3.8 MB)** |
| `v4_workspace` | **71,925 B (244 KB)** |

**Risk retired.** The design reads the data three times (hash, pack, verify)
and the risk asked whether that matters "at 50 GB". It is four megabytes. The
bundle will be dominated by the three database dumps, and the merge-the-passes
optimisation the risk contemplated is unnecessary. The free-space refusal in
§9.1 stays — it is cheap and it is what makes the failure loud on a machine
where this is not true.

## R5 — the "only docker" decrypt path (§15 risk 5)

`restore.sh`'s fourth decryptor backend reaches libcrypto through ctypes inside
`python:3.12-slim`. If that image had no reachable libcrypto, the answer to
"a machine that has only docker" was fiction.

```
docker run --rm python:3.12-slim \
  python3 -c "import ctypes.util; print(ctypes.util.find_library('crypto'))"
```

Prints **`libcrypto.so.3`**. **The backend is real.** The KAT gate still proves
it per bundle, which is what makes this a check rather than a belief.

## R7 — `.env` keys that nothing declares (§15 risk 7)

The design refuses a backup when the live `deploy/.env` carries a key that
neither `.env.example` nor the disposition rows declare, so an undeclared key
blocks the first real install.

```
comm -23 <(cut -d= -f1 <live .env> | sort -u) <(cut -d= -f1 .env.example | sort -u)
```

Two undeclared keys in the live stack's `.env`
(`/home/jeremy/workspace/nova/.worktrees/v4/deploy/.env`):

- `COMPOSE_FILE` — the known case, already handled.
- **`INSTANCE_SECRET`** — not previously named anywhere in the design.

**S41 must add a declaration for `INSTANCE_SECRET`**, with a disposition, or
the first `./install backup` on the Dell refuses. That is the risk doing its
job before a line was written.

## Still not measured

- **§15 risk 4** — `nova_restore.py`'s hardcoded Homebrew libcrypto paths on a
  current macOS. No macOS machine here; it needs the `macos-15` CI job, which
  needs the owner's answer in §16.
- **§15 risk 9** — `decide_subnet` on the mini PC. After the cleanup only
  **172.17** (docker0) and **172.19** (jobhunter) are allocated there, so v4's
  pinned 172.18 is free; but the verdict is right that this must be re-read on
  the day of the move rather than trusted from a table.
- **§15 risk 6** — a `chown` that does not take on a CIFS/SMB archive target.
  Designed in as a check (§9.1 step 19); no SMB target here to try it against.
