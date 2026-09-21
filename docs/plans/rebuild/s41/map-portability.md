# S41 portability map — Linux + macOS for `deploy/backup.sh`

Read-only. Written 2026-09-21 against `slice/s41`, after [`rulings.md`](rulings.md)
and [`map-requirements.md`](map-requirements.md). Scope: can `deploy/backup.sh`
(not yet written) run under bash 3.2 on both a Linux host and a stock macOS
host, and CI-verify that on `ubuntu-latest` + `macos-15`. Every claim about
this repo carries `path:line`; claims about macOS/GNU-vs-BSD in general do
not, since they are not facts about this checkout.

## 1. Existing shell style — what is already a macOS bug, and what already isn't

`deploy/install.sh:7` states the constraint the whole deploy tree already
follows: `# bash 3.2 compatible (no associative arrays, no ${var,,}, no
mapfile).` A scan of every script under `deploy/` for the bash-4+ features
named in the task confirms the comment is accurate today — nothing in the
scripts that run **on the host** uses them:

| Feature | Found in `deploy/*.sh` on the host path? |
|---|---|
| `declare -A` (assoc arrays, bash 4) | no hits anywhere |
| `mapfile` / `readarray` (bash 4) | no hits anywhere |
| `${var,,}` / `${var^^}` (bash 4) | no hits; `install.sh:739-741` has a hand-rolled `lowercase()` using `tr '[:upper:]' '[:lower:]'` instead |
| process substitution `<(...)` | no hits |
| indexed arrays (`x=(...)`, bash-2+, portable to 3.2) | used and fine: `install.sh:49,609,830,849`, `tailnet_topology_test.sh:234-235`, `tailscale/start_test.sh:478` |
| `local` | used throughout (37 in `install.sh`, 11 in `install_test.sh`) — POSIX `sh` lacks it but bash 3.2 has it, so this is fine for the bash-3.2 target, not for a `/bin/sh` target |
| `set -euo pipefail` | `install.sh:8`, `install:11` |

Shebangs actually in use:
- `#!/usr/bin/env bash` + `set -euo pipefail` — `deploy/install.sh:1`, `deploy/install.sh:8`; `install:1`, `install:11` (the thin repo-root wrapper that execs `deploy/install.sh`, `install:14,21`).
- `#!/usr/bin/env bash` + `set -uo pipefail` (no `-e`) — `deploy/install_test.sh:1,13`, `deploy/tailnet_topology_test.sh:1,51`, `deploy/tailscale/start_test.sh:1,48`. These are test harnesses that must keep running after an assertion fails, so `-e` is deliberately left off; `backup_test.sh` should follow the same pattern, not `install.sh`'s.
- `#!/bin/sh` (POSIX, no `local`, no arrays) — `deploy/tailscale/start.sh:1`, `deploy/tailscale/serve_check.sh:1`, and three heredoc-embedded scripts inside `deploy/tailscale/start_test.sh:166,222,238`.

**`start.sh` and `serve_check.sh` are not a host-portability question at all.**
They run as the tailscale sidecar's container command —
`deploy/docker-compose.yml:293`: `command: ["sh", "/config/start.sh"]` inside
`image: tailscale/tailscale:v1.102.3` (`deploy/docker-compose.yml:243`), a
Linux/Alpine image. Their `timeout "$SERVE_TIMEOUT" ...` (`start.sh:150`) and
`date +%s` never touch the macOS host; only the bash 3.2 scripts that
`install`/`./install` run directly on the operator's machine are a macOS
concern. This matters for the map because it means the "is there a GNU-only
call in this repo's shell" question has two different populations, and only
one of them is `backup.sh`'s population.

**One bash-4-ism already exists, but not on `backup.sh`'s path:**
`deploy/tailnet_topology_test.sh:248` — `now_ms() { echo $(( $(date +%s%N) /
1000000 )); }` — `%N` (nanoseconds) is a GNU `date` extension; BSD/macOS
`date` has no `%N` and prints the literal string, breaking the arithmetic.
This script is only linted (`bash -n`) in CI today (`.github/workflows/rebuild-ci.yml:54`)
and actually run only in the `web` job on `ubuntu-latest`
(`.github/workflows/rebuild-ci.yml:81`), so it is not currently exercised on
macOS and has never surfaced — but it is proof the repo's bash-3.2 discipline
is unenforced today (see §6), and `backup.sh` must not copy this pattern for
its own timestamps.

## 2. GNU vs BSD userland — what `backup.sh` will hit, portable forms, and what the repo already solved

The task's list of GNU/BSD-divergent tools, mapped to what `deploy/*.sh`
already does about each one:

| Tool | GNU form (Linux) | BSD/macOS form | Already solved here? |
|---|---|---|---|
| `sed -i` | `sed -i 's/../../' f` | `sed -i '' 's/../../' f` (mandatory empty-string arg) | **Avoided entirely.** No `sed -i` anywhere in `deploy/*.sh` (checked). `.env` rewrites go through `set_env_value()` (`install.sh:880-899`): read the file line-by-line with `while IFS= read -r line`, write to `mktemp "${ENV_FILE}.XXXXXX"` (`install.sh:882`), then `mv "$tmp" "$ENV_FILE"` (`install.sh:895`). This sidesteps the GNU/BSD `sed -i` argument difference completely and is the pattern `backup.sh` should reuse for the MANIFEST and any `.env` edits during restore. |
| `date` | `date +%s`, `date -d` | `date +%s` works; no `-d`, no `%N` | `date +%s` is used throughout (`install.sh:756,767,1036,1048`; `tailscale/start.sh:112,136,149,151`) — portable on both. `date -d` (GNU-only relative-date parsing) is **not used anywhere** in `deploy/`. The one GNU-only use, `date +%s%N` (`tailnet_topology_test.sh:248`), is outside `backup.sh`'s scope (§1). |
| `stat` | `stat -c '%a' f` | `stat -f '%Lp' f` | **Already solved, twice, in the same file.** `install_test.sh:266` and `install_test.sh:317`: `stat -c '%a' "$ENV_FILE" 2>/dev/null \|\| stat -f '%Lp' "$ENV_FILE" 2>/dev/null`. This is exactly the check map-requirements #26 needs ("an archive path that cannot hold mode 0600 is refused") and should be lifted as-is into `backup.sh`. |
| `md5sum` vs `md5` | `md5sum f` | `md5 -q f` (or `md5sum` if coreutils is brew-installed) | Not used by any `deploy/*.sh` today. Map-requirements #7 needs per-table md5 — that runs as a Postgres `md5(string_agg(...))` **inside the postgres container** per `hub/r1-hubmove-design.md:172` ("count and md5 every table (`SET TimeZone='UTC'`; `md5(string_agg(t::text,'' ORDER BY t::text))`)"), so it is Postgres's own `md5()`, not a host `md5sum`/`md5` binary — no host portability issue there. |
| `sha256sum` vs `shasum -a 256` | `sha256sum -c` | `shasum -a 256 -c` | **Already specified, not yet built.** `hub/r2-integration.md:397`: `` `sha256_of` (`sha256sum`, else `shasum -a 256`) `` and `hub/r2-integration.md:195`: "Check the hash with `sha256sum -c` or `shasum -a 256 -c`." No `sha256_of` function exists in `deploy/install.sh` yet (checked — S41 is greenfield here); the fallback form is already decided in the docs, just not written. |
| `tar` (GNU vs bsdtar) | `--numeric-owner`, GNU sparse/xattr handling | bsdtar accepts `--numeric-owner` too but defaults differ on ACL/xattr preservation | **Mostly sidestepped by design, not by a flag.** Two different tar surfaces exist in the plan, and neither runs the host's own `tar`: (a) volumes are tarred "through a throwaway container of the postgres image (`--numeric-owner`)" (`hub/r1-hubmove-design.md:175`), i.e. Linux GNU tar inside a container, confirmed again at `hub/r2-integration.md:400`: "tars built inside throwaway containers"; (b) the **outer** encrypted-bundle tar (the `NOVAENC1` wrapper: `nova_restore.py`, `README.txt`, `meta.json`, `payload.enc`) is built with Python's stdlib `tarfile` in v3's `backend/app/backup_snapshot.py:298,357-361` (`tarfile.open(inner, "w:gz")`, `tarfile.open(partial, "w")`), and read back the same way in `scripts/nova_restore.py` (`import tarfile` at line 47, `_safe_extract` at line 66). Python's `tarfile` module has one behavior on Linux and macOS — there is no GNU/BSD divergence to solve as long as this stays Python-built rather than shell-built. `backup.sh` porting this should keep the outer-tar step in Python (or a container), not reimplement it with the host's `tar` binary. |
| `du` | `du -sh` | mostly compatible, block-size flags differ | Not used in `deploy/*.sh` today. |
| `df` | `df -h`, GNU-only column ordering | `df -h` (BSD ordering differs without `-P`) | **Already solved.** `install.sh:92-93`: `detect_disk_free_gb() { df -Pk "$1" \| awk 'NR==2 {printf "%d", $4/1024/1024}'; }` — `-P` forces POSIX output format (one line per filesystem, stable column order) and `-k` forces 1 KB blocks; both flags are POSIX-specified and behave identically on GNU coreutils and BSD/macOS `df`. `backup.sh` should reuse `detect_disk_free_gb` (or its pattern) for a pre-backup free-space check rather than inventing a new one. |
| `readlink -f` | canonicalizes, GNU extension (also on newer BSD/macOS via different flag) | not reliably present | **Already avoided.** `canonical_path()` (`install.sh:132-146`) does `dir="$(dirname "$path")"; base="$(basename "$path")"; ... printf '%s/%s' "$(cd "$dir" && pwd -P)" "$base"` instead of `readlink -f` — `cd ... && pwd -P` is POSIX and portable; `readlink -f` is not called anywhere in `deploy/`. |
| `mktemp` | `mktemp "$file.XXXXXX"`, `mktemp -d` | same forms work | Already in portable form: `install.sh:882` (`mktemp "${ENV_FILE}.XXXXXX"`), `install_test.sh:208,254,298,354,447,895,1009,1084` (`mktemp -d`), `tailnet_topology_test.sh:149`, `tailscale/start_test.sh:161`. No GNU-only `mktemp --tmpdir` or `-t` template-suffix form used. |
| `base64` | `base64 -w0` (GNU wrap flag) | `base64` has no `-w` | **Sidestepped entirely.** No shell `base64` call anywhere in `deploy/`. The one base64 use in the backup design, `generate_passphrase()` (`backend/app/backup_crypto.py:238-245`), calls Python's `base64.b32encode` (stdlib), never a shell `base64` binary. |
| `grep -P` (PCRE, GNU-only) | works | not supported by BSD grep | Not used anywhere in `deploy/*.sh` (checked). Matching is done with `case` glob patterns (e.g. `install.sh:568-571` for the tailnet hostname) or POSIX `awk`, not `grep -P`/`-E`. |
| `xargs -r` (GNU-only "no run if empty") | `... \| xargs -r cmd` | BSD xargs has no `-r` | **Already solved by guarding, not by the flag.** `tailnet_topology_test.sh:105` and `tailscale/start_test.sh:97,99`: `[ -n "$ids" ] && printf '%s\n' "$ids" \| xargs docker rm -f ...` — the emptiness check happens before the pipe, so `-r` is never needed. `backup.sh` should use the same guard-first pattern rather than `xargs -r`. |
| `timeout` / `gtimeout` | `timeout N cmd` | not installed by default on macOS (Homebrew `coreutils` installs it as `gtimeout`) | Used only inside the tailscale **container** (`start.sh:150`, Alpine/BusyBox `timeout`, §1) and inside `tailscale/start_test.sh:318` (`timeout 150 docker run ...`, which runs in the CI job on `ubuntu-latest` — `.github/workflows/rebuild-ci.yml:59,81`). **Not currently used anywhere that runs on a bare macOS host.** If `backup.sh` needs a host-side timeout (e.g. bounding a `docker compose exec` call), it has no existing portable pattern to copy and must either avoid `timeout`/`gtimeout` (poll-with-`date`+sleep, the way `wait_for_health` already does at `install.sh:1035-1053`) or detect and fall back, since stock macOS has neither `timeout` nor `gtimeout` on PATH. |
| `nproc` | `nproc` | not present; `sysctl -n hw.ncpu` | Not used anywhere in `deploy/*.sh`. No existing pattern; not currently a stated S41 requirement either (map-requirements.md has no CPU-count check). |

## 3. Encryption tooling portability

**Load-bearing finding: the repo's actual encryption design never shells out
to `openssl enc`, `age`, or `gpg` at all.** Searched `ARCS.md`,
`hub-topology.md`, `hub/r1-hubmove-design.md`, `hub/r2-integration.md` and
`backend/app/backup_passphrase.py` for `age`/`gpg` — zero hits. The only
`openssl` use anywhere in `deploy/` is `install.sh:907`: `value="$(openssl
rand -hex 32)"`, generating random secrets — not encryption, and not part of
the bundle format.

The actual format (`NOVAENC1`, `backend/app/backup_crypto.py:1-40` docstring,
mirrored standalone in `scripts/nova_restore.py:35-38`) is custom:
**scrypt** (from Python's stdlib `hashlib`, not a third-party KDF library —
`backup_crypto.py:79` `hashlib.scrypt(...)`) derives a 32-byte AES key from
the passphrase, then **AES-256-GCM per 4 MB chunk** via the `cryptography`
package's `AESGCM` (`backup_crypto.py:152,187`, `AESGCM` imported from
`cryptography.hazmat.primitives.ciphers.aead`).

**On the backup-creation side, this is already free.** `cryptography` is a
listed dependency of `services/core` today —
`services/core/pyproject.toml:11` — and it is already vendored into the core
container image, which is `FROM python:3.12-slim`
(`services/core/Dockerfile:1`; the same base is used by `services/gateway`
and `services/memory`, `services/gateway/Dockerfile:1`,
`services/memory/Dockerfile:1`). It is there today for ed25519 envelope
verification, not backups (`services/core/app/devices.py:39`,
`services/core/app/envelopes.py:43-44`, `services/core/app/devices_ws.py:37-38`
all `from cryptography.hazmat.primitives.asymmetric import ed25519`), but
`AESGCM` ships in the same package, so encrypting a backup by running Python
**inside the already-running core container** (`docker compose ... exec -T
core python3 ...`, following the `exec -T` pattern already at
`install.sh:622`) needs nothing new installed on either a Linux or a macOS
host. This is not a claim S41 has already made — it is a fact about what's
already sitting in the image that a design should use.

**On the restore side, this is genuinely load-bearing and harder, and v3
already solved it once.** The whole point of `scripts/nova_restore.py`
(docstring, lines 1-19) is that it must decrypt **before docker/compose can
even run**, because the bundle contains `.env` and the stack cannot start
without it (line 9-12: "the bundle CONTAINS `.env` ... on a fresh machine,
restore cannot go through Nova"). So the restore side cannot lean on the core
container the way backup-creation can — there is no container yet. Its
answer (`nova_restore.py:89-105`): prefer the `cryptography` package if it
happens to be installed, and if not, call the system OpenSSL's `libcrypto`
directly via `ctypes` (`_openssl_gcm()`, lines 113-196) using raw EVP GCM
calls. The docstring states the one real gap outright (line 17-19): "every
Linux machine that can run Docker has libcrypto. The one machine that may
not cooperate is macOS (Apple ships a trap libcrypto); there, `pip install
cryptography` first." The code backs that up at line 118-122: on
`sys.platform == "darwin"` it **refuses to call `ctypes.util.find_library`**
at all and only tries two hardcoded Homebrew paths
(`/opt/homebrew/opt/openssl@3/lib/libcrypto.dylib`,
`/usr/local/opt/openssl@3/lib/libcrypto.dylib`), with the comment "Apple's
stub libcrypto aborts the whole process when called" — i.e. the naive
"find any libcrypto" approach is not just wrong but crash-unsafe on macOS,
and this is already worked around, not merely noted.

Net effect for S41: python3 availability on the **restore target host** is
the one real unresolved portability risk this whole map turns up, and it is
outside the repo's control (stock macOS has not shipped python3 by default
for several releases; a fresh mini-PC-class Linux box may not have it
either). The `cryptography`-or-ctypes-libcrypto fallback already exists and
already has the macOS trap-libcrypto workaround; S41 "porting what fits"
should carry `nova_restore.py`'s decrypt path essentially unchanged, and its
own top-of-file docstring is the disclosure this map would otherwise have to
invent. This is not something I could verify beyond reading the code — no
macOS machine was available to actually run `nova_restore.py` against a
real Homebrew OpenSSL install, so whether the two hardcoded paths are
still correct for a current Homebrew is unverified here.

## 4. Docker/compose portability

**Invocation style.** `deploy/install.sh:44-52` states the rule the rest of
the script follows: "Every `docker compose` call in this script goes through
this array" — `COMPOSE_ARGS=(-f "$COMPOSE_FILE")` at line 49, later extended
with `-f "$GPU_COMPOSE_FILE"` (`install.sh:830`) and `--profile` flags
(`install.sh:609,849`) — so every compose invocation in the script is
`docker compose "${COMPOSE_ARGS[@]}" <subcommand>`. `backup.sh` should be
sourced into (or written next to) `install.sh` and reuse `COMPOSE_ARGS`
rather than building its own file list, per `hub/r1-hubmove-design.md:150`
("`main` gains `backup`, `restore` and `undo-move`, sourced from
`backup.sh`").

**`--project-directory` / absolute-path rule.** Both `COMPOSE_FILE` and
`GPU_COMPOSE_FILE` are computed as absolute paths from `SCRIPT_DIR`
(`install.sh:10,17-18`: `SCRIPT_DIR="$(cd "$(dirname
"${BASH_SOURCE[0]:-$0}")" && pwd)"`, `COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml"`).
The trap this avoids — **"COMPOSE_FILE must be absolute; a bare `-f
deploy/docker-compose.yml` drops the GPU overlay"** — is recorded twice in
the repo, not just in memory:
- `deploy/README.md:35-38`, "**The deploy rule (2026-09-04).**" — "Run
  compose from this directory ... or `docker compose --project-directory
  deploy ...` from the repo root — and never with a bare `-f
  deploy/docker-compose.yml`. The installer writes `COMPOSE_FILE` to
  `deploy/.env` with ABSOLUTE paths."
- `deploy/install.sh:930-937`, the code comment right above
  `compose_file_set()`/`record_compose_files()` (`install.sh:944,956`):
  "Every `docker compose` call in THIS script passes its files with -f, so
  the GPU overlay cannot be dropped here. A hand-run command afterwards can
  drop it — and did (2026-09-04) ... ABSOLUTE paths: compose resolves a
  relative COMPOSE_FILE entry from the shell's working directory, not from
  `.env`'s — measured, from the repo root a relative entry loaded the v3
  `docker-compose.yml`."

`backup.sh` inherits this for free only if it goes through `COMPOSE_ARGS` as
built by `install.sh`; a standalone reimplementation that re-derives compose
file paths would be exactly the kind of second copy this trap already bit
once.

**Exec-into-container style.** The one precedent in the repo is
`install.sh:622`: `` docker compose "${COMPOSE_ARGS[@]}" exec -T tailscale
tailscale status --json ``  — `exec -T` (no TTY allocation, since this runs
non-interactively from a script). Map-requirements #8's `pg_dump -Fc` inside
the postgres container, and #16's re-verification, should follow this same
`exec -T <svc> <cmd>` shape rather than `docker run` against a fresh
container, for consistency with the one exec call that already exists (the
`--drill` restore path, map-requirements #17, is the exception that
legitimately needs `docker run` with throwaway volumes, per
`hub/r1-hubmove-design.md:184-185`: "`--drill` does the same into a
throwaway postgres started with `docker run` and throwaway volumes").

**Subnet/network detection is genuinely new, not reused.**
`deploy/docker-compose.yml:332-334` still hardcodes `172.18.0.0/16` /
`172.18.0.0/17` / `172.18.0.1` today (not yet the
`${NOVA_SUBNET:-172.18.0.0/16}` form `hub/r1-hubmove-design.md:150` describes
as the target). `decide_subnet`, `host_routes_in_use`,
`docker_subnets_in_use`, `subnet_overlaps` and `pick_project_subnet`
(`hub/r1-hubmove-design.md:150-153`) do not exist anywhere in `deploy/`
today (checked by grep) — map-requirements #12/#22/#23 are new code with no
existing pattern to copy, and #22's stated portable form (`` `ip -4 route`,
else `netstat -rn` ``, `hub/r2-integration.md:398`) is itself the reason:
`ip` (iproute2) is Linux-only; macOS has neither `ip` nor Linux-style
`/proc/net/route`, only BSD `netstat -rn` / `route -n get`.

## 5. Postgres client/server

**Pinned image.** `deploy/docker-compose.yml:5`: `image: postgres:16` — a
**major-version** pin only, not a minor version. The same major pin is
repeated in CI's throwaway database service,
`.github/workflows/rebuild-ci.yml:23`: `image: postgres:16`. Because `16`
floats to whatever `16.x` minor is current when each host last pulled the
image, the Dell and the mini PC can legitimately be running different `16.x`
minors without anyone having changed anything — which is exactly
map-requirements' still-open question #6 ("Postgres minor parity on the mini
PC was never measured").

**Client/server match "by construction."** The design's answer to the
GNU/BSD-adjacent client-vs-server version problem is not a portability trick
at all: `pg_dump` and `pg_restore` are never run from the host, only from
**inside the postgres container itself**, so client and server are always
the same build. Stated directly at `hub/r1-hubmove-design.md:6`: "Each
database is dumped by the postgres container's own `pg_dump`, so the client
and server versions match by construction," and reinforced by
map-requirements #8 (`hub-topology.md:302`, `hub/r1-hubmove-design.md:6,469`).
A script reads both versions the same way — exec into the running
container:
- server version: `docker compose "${COMPOSE_ARGS[@]}" exec -T postgres
  postgres --version` (or `SELECT version()` over `psql`, following
  `backend/app/backup_restore.py:159`'s existing `psql -tAX -v
  ON_ERROR_STOP=1 -c <sql>` shelling pattern, which is Python
  `subprocess.run`, not shell, but the same exec target).
- the container's own `pg_dump` major: `docker compose "${COMPOSE_ARGS[@]}"
  exec -T postgres pg_dump --version`.

Both are recorded in the MANIFEST as separate fields —
`hub/r1-hubmove-design.md:74`: `pg_server_version=16.x   pg_dump_major=16` —
and restore refuses on a mismatch: map-requirements #14
(`hub-topology.md:310`, `hub/r1-hubmove-design.md:181`) "refuse a non-empty
target or an **older `pg_restore`**." No GNU/BSD divergence applies here at
all, since the binary in question is always the one inside the (Linux)
postgres container regardless of host OS.

## 6. CI surface

`.github/workflows/` contains exactly one file, `rebuild-ci.yml` (163
lines). It triggers only on `push`/`pull_request` to `branches:
["rebuild/**"]` (`.github/workflows/rebuild-ci.yml:3-7`) — the current
working branches are `main` and `slice/*` (per this session's git status),
neither of which matches `rebuild/**`, so **this workflow does not currently
run on this branch's pushes or PRs**; nothing in `.github/` runs it on
`main` or `slice/**` today.

Five jobs, all `runs-on: ubuntu-latest` today, none on macOS:

| Job | Line | What it does |
|---|---|---|
| `services` | `:10-36` | matrix `[core, gateway, memory]`, a throwaway `postgres:16` service container (`:23`), `uv sync` + `ruff check` + `pytest` per service |
| `installer` | `:50-56` | `bash -n` on `install.sh`/`install_test.sh`/`tailnet_topology_test.sh` (`:54`), `shellcheck -S warning` on the same plus `install` (`:55`), then actually runs `./deploy/install_test.sh` (`:56`) |
| `web` | `:58-88` | `npm ci`/`build`/`test`, `gate_test.sh`, and also runs `tailnet_topology_test.sh` and `tailscale/start_test.sh` here (docker-backed job, per the comment at `:44-49`) |
| `novad` | `:98-113` | Go vet/test/build, including an `arm64` cross-compile smoke |
| `e2e` | `:140-163` | **disabled**, `if: false` at `:141`; the comment block `:114-133` explains why (no GPU on hosted runners, timing not yet re-measured) |

**Nothing here runs `install_test.sh` under an actual bash 3.2, and nothing
runs on macOS at all today.** The `installer` job's `./deploy/install_test.sh`
(`:56`) executes with whatever `bash` is on `ubuntu-latest`'s PATH — modern
GNU bash (5.x), not 3.2 — so the bash-3.2 discipline stated in
`install.sh:7` is currently enforced by nothing except code review; `shellcheck`
(`:55`) checks syntax and common pitfalls, not bash-version compatibility,
and has no "target bash 3.2" mode invoked here. This is the concrete gap
map-requirements #27 closes: "CI runs `install_test.sh` and `backup_test.sh`
on `macos-15` under `/bin/bash`." `backup_test.sh` does not exist yet
(checked — no file of that name anywhere in the repo).

The `installer` job's own comment (`:44-46`) states the strategy a
`macos-15` job should copy for `backup_test.sh`: "No docker and no network:
`install_test.sh` sources `install.sh` (whose entry point is guarded) and
stubs only what touches the outside world." The entry-point guard it refers
to is `deploy/install.sh:1139`: `` if [ "${BASH_SOURCE[0]:-$0}" = "${0}" ];
then main "$@"; fi `` — sourcing the file (`. "$SCRIPT_DIR/install.sh"`,
already the pattern at e.g. `install_test.sh`'s `run_secrets`/
`run_secrets_noop` helpers) runs none of `main`, only defines functions, so
the test file can call individual functions (`generate_secrets`, etc.)
without ever invoking docker. `hub/r2-integration.md:66` (D20) independently
confirms this is the intended shape for macOS specifically, not just for
CI-without-docker in general: "macOS through Docker Desktop plus `install.sh`
under bash 3.2 (**CI only**)" — i.e. the macOS CI leg is expected to be a
bash-3.2 stub-and-lint pass like today's `installer` job, not an actual
Docker Desktop walk (GitHub-hosted `macos-15` runners are not a verified
Docker-capable environment in this repo — I did not find any existing job or
doc claiming a real `docker compose up` has ever run in this repo's CI on
macOS, and could not check GitHub's runner image contents from here, so
whether `docker` is even present and startable on `macos-15` hosted runners
is unverified and should be confirmed before designing `backup_test.sh`'s
macOS job around it).

The `runs-on` values already available to this repo's workflows, per
`hub-topology.md:101`: `macos-15`, `macos-15-intel`, `windows-2025`,
`windows-11-arm`, `ubuntu-24.04-arm` — `macos-15` (Apple Silicon, arm64) is
the one map-requirements #27 names.

---

## What most constrains S41's design (max 10 lines)

1. `deploy/install.sh:7` is already a real bash-3.2 contract, followed
   correctly today (§1) — `backup.sh` inherits real discipline, not a green field.
2. GNU/BSD host-tool divergence (`sed -i`, `stat`, `df`, `readlink -f`,
   `mktemp`, `base64`, `xargs -r`) is **already solved** in `install.sh`/
   `install_test.sh` by five reusable patterns (§2) — the work is porting
   them into `backup.sh`, not inventing them.
3. `timeout`/`gtimeout` and subnet detection (`ip route` vs `netstat`) have
   **no existing host-side pattern** to copy (§1, §4) — genuinely new bash-3.2 code.
4. Tar never runs on the host at all in the design that exists: volumes are
   tarred inside a throwaway Linux container, the outer encrypted bundle is
   built with Python's `tarfile` (§2) — this removes most of the GNU-vs-bsdtar risk by construction.
5. `AESGCM`/`cryptography` is already a `services/core` dependency
   (`services/core/pyproject.toml:11`) baked into the container image (§3) —
   backup-creation can run inside `core` and need nothing new on either host OS.
6. Restore is the one place that genuinely cannot lean on a container
   (`.env` lives in the bundle, so nothing can start first) — `scripts/nova_restore.py`
   already carries a `cryptography`-or-ctypes-libcrypto fallback with a
   documented macOS trap-libcrypto workaround (§3); porting it, not
   redesigning it, is the low-risk path.
7. `postgres:16` is a **major-only** pin (`deploy/docker-compose.yml:5`), so
   minor-version drift between hosts is real and unmeasured (§5) — client/server
   match is solved by construction (dump inside the container), not by pinning.
8. `.github/workflows/rebuild-ci.yml` only triggers on `rebuild/**` — it does
   not run on `main`/`slice/**` today, and has never run on macOS (§6);
   `macos-15` support for `backup_test.sh` is new CI surface, and whether
   Docker is even usable on GitHub's hosted macOS runners is unverified here.
9. `backup_test.sh`, `decide_subnet`, `host_routes_in_use`, `sha256_of` and
   the parametrized `NOVA_SUBNET` in `docker-compose.yml` all do not exist
   yet — confirmed absent, not just undocumented.
