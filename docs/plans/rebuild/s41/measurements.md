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

## R8 — the mount grammar compose actually accepts (2026-09-21, after the ruling)

Taken before the raw parser moved off awk (`s41/rulings.md`, last section), so
the new parser is written against readings rather than against a guess about
YAML. Every row is `docker compose --project-directory <tmp> -f <probe> config
--format json` on **compose v5.3.0**, over throwaway files in `/tmp/novachk.*`
— no container, no stack. "awk said" is the shipped POSIX-awk reader
(`compose_read.sh` at `02d2e1bc`) run over the same text.

| # | written under a service's `volumes:` | compose resolves | awk said |
|---|---|---|---|
| 1 | `- ../x:/A` | bind | bind /A |
| 2 | `- type: bind` + `source:`/`target:` | bind | bind /B |
| 3 | `- {type: bind, source: ../x, target: /C}` | bind | bind /C |
| 4 | the same flow mapping wrapped over 3 lines | bind | bind /D |
| 5 | `volumes: [ "named:/E1", {type: bind, …} ]` | volume + bind | `unreadable` (whole line) |
| 6 | a flow sequence on the next line, 8 spaces | volume + bind | **nothing** |
| 7 | list items at **4** spaces | bind | **nothing** |
| 8 | list items at **8** spaces | bind | **nothing** |
| 9 | `- ${MOUNTSPEC}` (`../whole:/H`) | bind | **nothing** |
| 10 | flow mapping with `{` inside a quoted reason, then 2 more items | 3 binds | **nothing** (all three) |
| 11 | flow mapping with `{` in a trailing comment, then 1 more | 2 binds | **nothing** (both) |
| 12 | `volumes: *m` (anchor holding the list) | 2 binds | `unreadable` |
| 13 | `<<: *base` (merge key bringing the list) | bind | **nothing** |
| 14 | `- named:/L1`, `- named:/L2:ro` | volume, volume+ro | nothing (correct) |
| 15 | `- {type: volume, source: named, target: /M}` | volume | nothing (correct) |
| 16 | `- /var/lib/anon` (no colon) | **anonymous volume** | nothing (correct) |
| 17 | `- ../x:$TGT` | bind at `/tt` | `bind a $TGT` (a target no render has) |
| 18 | `- sub/dir:/S` | **named volume** `sub/dir` (undefined ⇒ error) | bind /S |
| 19 | `volumes: []` | no mounts, valid | `unreadable` (a red on a correct file) |
| 20 | `volumes:` (null) | **rejected**: `must be a array` | `unreadable` |
| 21 | `- source: ../x` + `target:` (no `type:`) | **rejected**: `must be a string` | nothing |
| 22 | `- {source: ../x, target: /V}` (no `type:`) | **rejected**: `must be a string` | nothing |
| 23 | `- ${VOLNAME}:/P`, `VOLNAME=named` | **volume** | `interp` (correct) |
| 24 | `- ${VOLNAME}:/P`, `VOLNAME=/tmp/x` | **bind** | `interp` (correct) |
| 25 | `- ${D}/sub:/U` | bind | bind /U |
| 26 | `- ~/x:/R`, `- ~:/t` | bind | bind |
| 27 | `- .hidden:/T` | bind | bind |
| 28 | `- ./a:/t:ro:extra` | **rejected**: too many colons | — |
| 29 | `- ":/t"` | **rejected**: empty section between colons | — |
| 30 | a duplicate `volumes:` key in one service | **rejected**: yaml construct errors | — |

Two rules fall out, and both are the opposite of what the awk reader assumed:

- **A volume NAME may not contain `/`** — `volumes: {"sub/dir": {}}` is
  rejected outright (`additional properties 'sub/dir' not allowed`), which is
  why row 18 is an *undefined volume* and not a bind. So "contains a `/`"
  still safely implies "not a named volume"; it is the leading character
  (`.`, `/`, `~`, after interpolation) that decides bind vs volume.
- **`name:` merges last-wins.** `-f first -f second` renders `name: second`
  and the reverse order renders `name: first`; a file that declares no name
  does not clear one. The awk reader took the FIRST `name:` line in the
  concatenated text, so a GPU overlay that named the project would have made
  every backup refuse R0.

Every one of the nine spellings in rows 1-11 was then spliced into the REAL
`deploy/docker-compose.yml` (in place of the memory service's one mount line)
and rendered: compose accepted all nine and resolved the added bind each time.

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
