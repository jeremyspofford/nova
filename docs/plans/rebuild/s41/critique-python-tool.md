# Adversarial critique — `design-python-tool.md`

Written 2026-09-21 on `slice/s41`, read-only. The job was to break the design,
not to admire it. Every finding below was checked against the repo or against a
read-only command run here; where I could not check something I say so, and
where my first suspicion turned out to be **wrong** I say that too (§0).

Against: [`map-requirements.md`](map-requirements.md) (the 33 MUSTs/CARRIEDs),
[`rulings.md`](rulings.md), [`map-deploy-data.md`](map-deploy-data.md),
[`map-portability.md`](map-portability.md), [`map-v3-backup.md`](map-v3-backup.md),
and — the document the design never cites —
[`map-minipc-measured.md`](map-minipc-measured.md).

**Verdict: SOUND-WITH-FIXES.** 4 critical, 10 major, 8 minor.
C1 and C2 must be settled before a line is written: they change the shape of
coverage and of the protection set, not just their contents.

---

## 0. What I tried to break and could not

Stated first, because a critique that only lists hits is not a measurement.

- **`--profile '*'` (§4 [M]).** Re-run here against `deploy/docker-compose.yml`
  with compose v5.3.0. The design's measurement is exactly right: without the
  wildcard, `services` is `core gateway memory postgres searxng web` and
  `volumes` is `v4_memdata v4_models v4_pgdata v4_workspace`; with it,
  `ollama`/`tailscale` and `v4_ollama`/`v4_tailscale` appear. `name` is `nova`,
  volume entries are `{"name": "nova_<key>"}`, binds resolve to absolute
  sources (`.../data` for gateway). The `R0_PROFILE_GAP` refusal is well
  founded.
- **`encode(sha256(private_key_hex::bytea),'hex')` (§7.1/8).** I expected this
  to fail — PostgreSQL has no `CREATE CAST` from `text` to `bytea` in the
  obvious places. It works. Measured against a throwaway postgres 16.15:
  `k::bytea` on a `text` column returns the same digest as
  `convert_to(k,'UTF8')`. Not a finding. (It hashes the ASCII hex string rather
  than the key bytes, which is fine and deterministic on both sides.)
- **`core_signing_key.private_key_hex`** exists — `services/core/migrations/011_devices.sql:19,21`.
- **Crypto against v3.** `backend/app/backup_crypto.py:49,66-68,76-80,83-88,148-180`
  matches the design's `NOVAENC1` byte for byte: magic, 4-byte BE header
  length, header JSON, `scrypt(n=1<<15,r=8,p=1,dklen=32,maxmem=256MB)`, 16-byte
  salt, 4-byte nonce prefix + 8-byte BE counter, AAD `MAGIC || header ||
  BE64(index) || final-flag`, `final = done >= size` (`:171`), reader cost cap
  `MAX_N=1<<18, MAX_R=16, MAX_P=4, 128*r*n <= 128 MiB` (`:63-64`). The
  lookahead finality read is at `:203-213`. The design's §5 is a faithful port
  and the reasoning about truncation and the cost cap is correct.
- **The no-approvals question.** `services/core/tests/test_no_approvals.py:25`
  is `APP_DIR = Path(tools.__file__).resolve().parent.parent`, i.e.
  `services/core/app`. The design's claim that host tooling is out of its scope
  is true. And `undo-move` step 2 (§7.4) is the right shape: it **states** that
  it cannot check whether the moved-to node is live and then does what it was
  asked, rather than refusing on the owner's behalf. The foreign-project
  deletion is an owner-ruled disposal bounded by a CANNOT, not a rebuilt gate.
  **No approval-shaped control found.**
- **Path:line spot-checks.** `deploy/install.sh:7,29,44-52,132-146,186-217,394-414,500-518,808-863,867-899,1078,1130-1141`,
  `deploy/docker-compose.yml:5,34,60,185,290,316-320,332-334,336-351`,
  `services/core/pyproject.toml:11`, `services/core/app/migrations_runner.py:19-24`
  (no `checksum` column — the stated degradation is real),
  `services/memory/app/store.py:20-23`, `apps/novad/main.go:40-48,233-240`,
  `apps/novad/internal/config/config.go:38,65,78-95,100`,
  `apps/novad/internal/client/client.go:96-114,182-184`,
  `.github/workflows/rebuild-ci.yml:3-7`, `deploy/install_test.sh:1-11,19-27,266,317`,
  `.gitignore:13`, `deploy/README.md:74-79`. **All correct.** This design's
  citation discipline is genuinely good; the failures below are reasoning
  failures, not sloppy referencing.

---

## CRITICAL

### C1 — `backup` refuses on its first run, for ever. §4 steps 6–9 + `PATH_POLICY`

**What breaks.** The host-file half of coverage is unclassifiable by
construction, so `may_backup` is never true and **no bundle is ever written**.
MUST #4 is satisfied in the wrong direction: the refusal is total.

Two independent defects, either of which alone is fatal.

**(a) `SCAN_ROOTS` is wrong under both readings of its own formula.** §4 step 6
says `SCAN_ROOTS := { C.project_dir } ∪ { dirname(b) for every BIND source b
that is not under C.project_dir }`, and then claims "Measured today that is
`{<repo>/deploy, <repo>/data}`".

The binds in `deploy/docker-compose.yml` are `./postgres-init:...` (`:13`),
`../data:/data:ro` (`:83`), `../searxng:/etc/searxng:ro` (`:185`) and
`./tailscale:/config:ro` (`:290`). Resolved (checked here) `../data` is
`<repo>/data` and `../searxng` is `<repo>/searxng`.

- Taking `dirname(b)` literally: `dirname(<repo>/data)` is **`<repo>`**. The
  scan root becomes the entire repository — `services/`, `apps/`, `docs/`, and
  all of v3's tree that `main` still carries (`backend/`, `frontend/`, `coder/`,
  `mcp-runner/`, `media/`, `workloads/`, `inference-control/`). Thousands of
  `UNCLASSIFIED` files.
- Taking `b` itself: `{<repo>/deploy, <repo>/data, <repo>/searxng}` — which is
  still not the set the design says it measured (`searxng` is missing from the
  stated result, though the design cites `:185` elsewhere).

So the one line in §4 marked as a measurement is a result the design did not
take. That matters beyond the arithmetic: it is the input to the refusal that
MUST #4 rests on.

**(b) `PATH_POLICY` is not total over `<repo>/deploy` even under the kindest
reading.** `find deploy -type f` here returns 11 files. `PATH_POLICY` (§4)
classifies exactly two of them (`deploy/postgres-init/**`,
`deploy/tailscale/**`). Unclassified today:

```
deploy/.env.example        deploy/docker-compose.gpu.yml   deploy/install.sh
deploy/README.md           deploy/docker-compose.yml       deploy/install_test.sh
deploy/tailnet_topology_test.sh
```

plus every file this slice itself creates — `deploy/backup.sh`,
`deploy/backup_test.sh`, `deploy/backup/Dockerfile`,
`deploy/backup/novabackup/*.py`, `deploy/backup/tests/*.py`. Seven today,
twenty-odd after S41 lands.

**The sequence.** `./install backup` → step 6 runs coverage → `R1_UNCLASSIFIED`
names 7+ files → exit 3, "Nothing was stopped, dumped or written." Every run.
The one thing the slice exists to produce cannot be produced.

**Why the design does not see it.** Risk 7 (§13) states the gap and rates it
"noisy but safe": *"a newly-tracked code file also refuses (noisy but safe)"*.
That undercounts by the entire current tree. v3 did not have this problem
because it had a **third derivation signal** the design dropped: git status of
binds — `tracked → code, ignored → operator state, neither → unknown`
(`map-v3-backup.md:294-313`, `backup_inventory.git_status_fn`). Without it, the
only way to make `PATH_POLICY` total over a real tree is a catch-all, which
reintroduces the silent skip MUST #4 forbids.

**Smallest fix.** Restore v3's third signal: run `git check-ignore` /
`git ls-files` against each scan root and classify `tracked → EXCLUDE_CODE`,
`ignored → must be classified by PATH_POLICY or refuse`, `neither → refuse`.
That is one derived source, not a list, and it keeps the refusal meaningful.
Fix the `SCAN_ROOTS` formula to `b` (not `dirname(b)`) at the same time, and
re-state the measured result as `{deploy, data, searxng}`. Note the other two
stances already carry this: `design-port-v3.md` lists `git check-ignore` in its
fact-rendering step.

---

### C2 — A v4 volume CAN enter the deletion set. §8, "How a v4 volume can never be caught"

**What breaks.** Ruling 1: *"It must be impossible for that path to touch a v4
volume. That is a test, not a promise."* (`rulings.md:24-26`). It is possible,
and the design's own printed block asserts a protection the code cannot compute.

**The mechanism.** `project_own_volumes()` (§8) derives the protection set from
`compose_config_text` — which is `install.sh:394`, hardcoded to
`--profile tailnet` and nothing else. `check_foreign_project` is called "inside
`preflight`" (§2), and `preflight` (`deploy/install.sh:322-329`) runs **before**
`detect_hardware`, which is where `--profile inference` is appended
(`deploy/install.sh:849`). So at the moment the deletion set is computed,
COMPOSE_ARGS is `-f <compose>` only.

Measured here, `docker compose -f docker-compose.yml --profile tailnet config`
yields exactly:

```
v4_memdata  v4_models  v4_pgdata  v4_tailscale  v4_workspace
```

**`v4_ollama` is absent.** The design proves this itself in §4 ("Without
`--profile '*'`, compose omits `ollama` and `tailscale` AND their volumes"),
then builds the protection set with a narrower call anyway. The pre-delete
assert (§8, mechanism 2) re-checks against the **same** function, so the
"filter, then assert" pair is two reads of one wrong set, not two mechanisms.

**The sequence that deletes a v4 volume.**

1. v4 is installed and running from `/home/jeremy/workspace/nova/deploy/docker-compose.yml`
   with the inference profile on (that is the live state on this machine right
   now: `nova-ollama-1` is up). Volumes `nova_v4_pgdata … nova_v4_ollama` exist;
   every container carries `com.docker.compose.project=nova` and
   `...project.config_files=/home/jeremy/workspace/nova/deploy/docker-compose.yml`.
2. The operator runs `./install` from a **second checkout of the same repo** —
   a worktree under `.claude/worktrees/<lane>` (this repo creates them
   routinely; the memory rule `worktree-per-lane` says to), or a re-clone at a
   new path. `canonical_path "$COMPOSE_FILE"` (`deploy/install.sh:132-146`,
   `cd "$dir" && pwd -P`) resolves to the worktree path, which is not the
   label's value.
3. `config_files_match` therefore fails for **every live v4 container**, and
   `foreign_project_containers` returns all of them.
4. `foreign_project_volumes` = the volumes they mount =
   `nova_v4_pgdata, nova_v4_memdata, nova_v4_workspace, nova_v4_models,
   nova_v4_ollama, nova_v4_tailscale`.
5. `project_own_volumes` = the five keys above resolved to full names. The
   "plus every volume mounted by a container that IS ours" clause contributes
   nothing, because in this scenario no container is ours.
6. Deletion set = **`{nova_v4_ollama}`**. The assert passes.
7. The block prints *"this install's own volumes, which will NOT be touched
   (6)"* — a six-name list including `nova_v4_ollama` that the function cannot
   produce. The operator reads that line, types `delete`, and loses the model
   weights along with the entire running stack's containers.

Even with a single checkout, the general statement is false: **any volume behind
a profile other than `tailnet` is unprotected**, today and for every profile
added later. The design's justification — "a volume added to
`deploy/docker-compose.yml` tomorrow is protected the same day, with nothing to
update" — holds only for unprofiled volumes.

**Smallest fix, three lines.**
1. `project_own_volumes` must resolve with `--profile '*'`, the wildcard §4
   already argues for. (`compose_config_text` is shared with the tailnet seam,
   so add a second reader rather than changing that one.)
2. Read each candidate volume's **own** `com.docker.compose.project` and
   `com.docker.compose.volume` labels back from `docker volume inspect`, and
   refuse to delete any whose volume-key matches a key in this project's
   resolved config — regardless of which container mounted it.
3. Print the label matched beside every object, as
   `map-minipc-measured.md:37-39` requires.

Ruling 1's required test (design test 91) as written would **pass** while this
hole is open: its fixture lists "all six `nova_v4_*` volumes", but the fixture
feeds `project_own_volumes`, and the bug is in what that function can see. The
test must be driven from a real `--profile tailnet` config, not a hand-written
six-name fixture, or it stamps what the product does not do.

---

### C3 — The bundle is written root-owned inside a container and is never chowned. §1, §7.1/15-17

**What breaks.** MUST #28 — *"back up on the Dell, `restore --drill` on the
mini PC"* — cannot be walked, because the operator cannot read the file the tool
wrote.

`cli.py` sets `os.umask(0o077)` as its first statement (§2) and the tool runs as
root inside `docker run --rm` with `<archive dir>` bind-mounted rw. On Linux the
finished `nova-backup-<host>-<stamp>.tar` lands **root:root, mode 0600**. The
invoking operator then cannot `sha256sum` it, cannot `scp` it, cannot open it
with `restore.pyz`, and cannot delete it, without `sudo`.

This is not a hypothesis. It is a **measured** constraint recorded in this
slice's own map, from the mini PC cleanup earlier the same day:

> *"a container writing the archive produces a root-owned, mode-0600 file, and
> the host-side verification — running as the operator — then cannot read it
> back. That bit during this very cleanup. So a bundle written from a container
> must be `chown`ed to the invoking uid (or every verification step must also
> run in a container). Requirement #26 says an archive path that cannot hold
> mode 0600 is refused; this is the other half of it, and S41 must not assume
> the writer and the verifier are the same user."*
> — `map-minipc-measured.md:164-171`

The design contains no `chown`, no `--user`, no uid handling of any kind (grep:
zero hits for `chown`, `--user`, `uid`, `invoking`). It also **never cites
`map-minipc-measured.md`** — not once, in 1,432 lines — and neither do the other
two designs. That file is the most recent measurement in the slice and it
contradicts the design twice (here and in M9).

It compounds with the design's own §12: *"Host-side `sha256_of` exists only in
the wrapper, for the operator's own `scp` check"* — that check runs as the
operator, against a file the operator cannot read.

**Smallest fix.** Pass `--user "$(id -u):$(id -g)"` to `docker run` for the tool
container *and* set the staging/archive ownership explicitly, or, if root is
needed to read volume contents, have the tool `os.chown(final, int(os.environ["NOVA_HOST_UID"]), int(os.environ["NOVA_HOST_GID"]))` after `os.replace`, with the
wrapper passing the ids and the tool **re-stat-ing and failing if the chown did
not take**. Add it to the verdict line of §7.1/19 as a fact checked, and add a
shell test: the wrapper's `sha256_of` must succeed on the file the container
just wrote.

---

### C4 — `project_dir` and `compose_files` are not in the artifact the wrapper produces. §2, §4 steps 1 and 6, §3 manifest

**What breaks.** Three separate things rest on fields that `docker compose
config --format json` does not emit.

Measured here, the top-level keys of the resolved config are exactly:

```
['name', 'networks', 'services', 'volumes']
```

There is no `project_dir` and no `compose_files`. Yet:

- §2 says `composeconfig.py` "Exposes `project`, `services`, `volumes`,
  `mounts`, `networks`, **`compose_files`**, **`project_dir`**".
- §4 step 1 refuses "unless `P` equals the project name of the checkout's own
  compose file (the same text, re-read)" — fine — but step 6 builds
  `SCAN_ROOTS := { C.project_dir } ∪ { dirname(b) for every BIND source b that
  is not under **C.project_dir** }`. Both uses of `project_dir` have no source.
- §3's manifest pins `source.compose_files: [str]`, *"absolute, as compose
  reported"*. Compose did not report them.

Without `project_dir`, "is this bind under the project directory?" — the test
that decides whether a bind becomes a scan root at all — cannot be evaluated,
which is the same wound as C1 from a different direction.

**Smallest fix.** The wrapper already knows both: `install.sh` computes
`DEPLOY_DIR` and `COMPOSE_FILE` as absolute paths (`deploy/install.sh:10,12,17`)
and `compose_file_set()` (`deploy/install.sh:944`) already joins the `-f` list.
Pass them into the container explicitly (`--repo`, `--compose-config`,
`--project-dir`, `--compose-files`) and have `composeconfig.py` **verify** that
every passed compose file exists and that the resolved `name` matches the file
at `--compose-files[0]`. Do not infer them from the JSON.

---

## MAJOR

### M1 — The empty-target probe reads every failure as "empty". §7.2 step 4

MUST #14. The stated verification is: *"`docker volume inspect` must fail **or**
`docker run --rm -v <name>:/v:ro <img> sh -c 'ls -A /v | head -1'` must print
nothing."* The only signal is stdout emptiness. Measured here:

```
$ docker run --rm alpine sh -c 'ls -A /nonexistent | head -1'
ls: /nonexistent: No such file or directory
exit=0   stdout was empty
```

The pipeline's status is `head`'s, so it is 0 whatever `ls` did, and the error
goes to stderr. Every failure mode — a wrong mount target, a missing image, a
daemon hiccup, a permissions error — produces empty stdout and therefore reads
as "this volume is empty, proceed". The next steps create the volume and untar
into it. This is the exact defect CLAUDE.md names: *a fallback that reads as
success is worse than a crash* — sitting on the most destructive path in the
design, and contradicting §7's own opening rule ("a step that cannot make its
own verification FAILS").

**Fix.** `sh -c 'set -e; ls -A /v | head -1'` is not enough either (pipefail is
not POSIX `sh`). Use `find /v -mindepth 1 -maxdepth 1 -print -quit` and require
**exit 0 with empty stdout**; treat any non-zero exit as "could not determine",
which is a refusal, not a pass.

### M2 — `md5(string_agg(...))` is NULL for an empty table, and §7.1/8 treats NULL as a failure

Measured against a throwaway postgres 16.15:

```
CREATE TEMP TABLE e(a int);
SELECT md5(string_agg(t::text,'' ORDER BY t::text)) IS NULL FROM e t;   -->  t
```

§7.1 step 8's verification is *"Every listed table produced both a count and an
md5 (**no NULL**, no missing row)"* → **exit 1**. `psql -tAX` prints NULL as an
empty string, so it is indistinguishable from "no measurement" at the parse
layer, which is presumably why the design wrote the rule that way.

Any zero-row `BASE TABLE` in `nova_core` or `nova_gateway` — and there will
always be some — turns a healthy stack into a refused backup. Worse, the
failure message will say "the first table that produced no measurement", which
sends the operator hunting a phantom.

**Fix.** `coalesce(md5(string_agg(t::text,'' ORDER BY t::text)), md5(''))` and
keep "the row is missing from the result set" as the real failure. Pin it:
`test_backup_measures_an_empty_table_as_the_empty_digest`.

### M3 — `restore` step 2 writes `.env` before `.env` exists

MUST #12 puts `decide_subnet` first. §9 step 3 writes the five keys with
`set_env_value` (`deploy/install.sh:880-899`), whose loop is
`while IFS= read -r line ... done < "$ENV_FILE"`. On a bare restore target
`deploy/.env` does not exist — §7.2 step 7 is where it gets created. Under
`set -euo pipefail` (`deploy/install.sh:8`) the redirect fails, the script dies
with a bare "No such file or directory", and the `mktemp "${ENV_FILE}.XXXXXX"`
from line 882 is left behind in `deploy/`.

On the **install** path this is fine — `cmd_install` runs `generate_secrets`
(which `cp`s `.env.example` → `.env`, `deploy/install.sh:913-916`) before
`decide_subnet`. The design copies that ordering for install (§2) and then does
not notice that restore has no equivalent.

**Fix.** Restore step 2 creates `deploy/.env` from `deploy/.env.example` first
(and `chmod 600`), exactly as `generate_secrets` does, before calling
`decide_subnet`. Or `set_env_value` gains `[ -f "$ENV_FILE" ] || : > "$ENV_FILE"`.

### M4 — `restore` deadlocks between step 2 and step 7, and #32's host-specific key filter is promised but never specified

Step 2 writes `NOVA_SUBNET`, `NOVA_SUBNET_RANGE`, `NOVA_SUBNET_GATEWAY`,
`NOVA_WEB_ADDR`, `NOVA_TAILSCALE_ADDR` into `deploy/.env`. Step 7 then compares
the carried `.env` keys against the target's: *"Either the key is absent there,
or its value is **identical**. A conflict refuses."*

**The sequence.** Dell backs up with `NOVA_SUBNET=172.18.0.0/16` (or the values
derived at install). Mini PC restores; step 2 picks a free subnet and writes it;
step 7 finds the bundle's value present and different → **exit 3**, with no
stated escape. The restore that the whole slice exists for cannot complete, and
the two MUSTs (#12 and the carried `.env` of #32) are in direct conflict with
nothing arbitrating.

Worse, `COMPOSE_FILE` is also written into `.env` (`deploy/install.sh:962`) with
**absolute** paths, deliberately (`deploy/install.sh:930-937`). Carried to a
host where the repo sits elsewhere, a later bare `docker compose up` loads a
nonexistent file — the exact trap the comment at `:930-937` records.

Requirement #32 says host-specific `.env` keys are excluded. §4's `PATH_POLICY`
promises it — *"`deploy/.env` | `INCLUDE` (keys filtered, §6 restore step 7)"* —
but §6 is the passphrase section and restore step 7 describes only a conflict
comparison. **The filter is referenced and never designed.**

**Fix.** Name the two sets explicitly in `policy.py`: `ENV_CARRY` (the five
`SECRET_KEYS` of `deploy/install.sh:29`, plus `TS_AUTHKEY`, `TAILNET_HOSTNAME`,
`NOVA_PUBLIC_GATE_TOKEN`) and `ENV_HOST_LOCAL` (`COMPOSE_FILE`,
`COMPOSE_PROFILES`, `NOVA_SUBNET*`, `NOVA_WEB_ADDR`, `NOVA_TAILSCALE_ADDR`), and
refuse on a key in **neither** — the same total-over-derived discipline §4
argues for volumes, applied to the one file that has no other copy. Step 7 then
compares only `ENV_CARRY`.

### M5 — `decide_subnet` adopts a *foreign* project's network, and test 84 contradicts the adopt

§9 case 1: *"An existing project network is adopted. `docker network inspect
<project>_default` → its subnet."* Selected **by name**, with no check that the
network belongs to this checkout — the very error
`map-minipc-measured.md:35-39` rules out for volumes and containers
("Selection MUST be by the `com.docker.compose.project` label, read from
`docker` itself, never by name").

And §8's deletion removes **containers and volumes only**. A foreign `nova`
project's `nova_default` network survives the cleanup. So the sequence is:
foreign project found → operator deletes its containers and volumes → install
continues → `decide_subnet` adopts the foreign project's leftover
`nova_default` and its IPAM → `docker compose up` attaches to it. The compose
comment at `deploy/docker-compose.yml:308-314` says the fixed address **is** the
trust boundary for web's identity header; adopting a network whose addressing
someone else chose is not a neutral convenience.

Second defect in the same case: test 84 pins *"`decide_subnet` adopts an
existing `nova_default` and **writes nothing**"*. If it writes nothing and the
adopted network is not 172.18/16, `.env` carries no `NOVA_WEB_ADDR`, compose
falls back to its literal default `172.18.128.10`
(`deploy/docker-compose.yml:126,284`), and the address is outside the network →
`up` fails. Case 1's own stated verification ("the derived `.128.10`/`.128.20`
addresses fall inside it") only makes sense if it then **writes** them.

**Fix.** Adopt only a network whose `com.docker.compose.project.config_files`
label matches this checkout (the same test `foreign_project_containers` uses);
otherwise treat it as a collider, name it, and refuse. And make case 1 write the
derived `NOVA_SUBNET*`/`NOVA_WEB_ADDR`/`NOVA_TAILSCALE_ADDR`, re-reading them
back; re-word test 84 to "adopts and does not re-pick".

### M6 — `restore.pyz` is unauthenticated executable code, and its only authenticated hash is inside the ciphertext it opens

§3: outer member 2 is `restore.pyz`, cleartext. Its sha256 is recorded in
`meta.json` (member 3, explicitly *"unauthenticated"*) and in `MANIFEST.json` —
which lives **inside `payload.enc`**, i.e. behind the decryption the pyz is what
performs. There is no order of operations in which the operator authenticates
the code before running it.

**The sequence.** A bundle sits on an offsite copy, a USB stick, or the mini
PC's archive dir. An attacker replaces member 2 with a pyz that prompts for the
passphrase, exfiltrates it, and then prints a plausible verified-restore report.
The operator follows `README.txt`'s "exact line to run" and types the
passphrase. Every mechanical check in §7.2 is inside the code that was replaced.

The design treats the pyz as a convenience and never states this. `restore_pyz_sha256` in `meta.json` is worse than nothing: it *looks* like a
verification.

**Fix, cheap and mechanical.** (a) Make `build_pyz` **reproducible** — fixed
member order and a fixed `ZipInfo.date_time` — so one published sha256 covers
every bundle; (b) print that digest in the `backup` verdict line and in
`deploy/README.md`, and add `./install backup --print-pyz-sha256`, so the
operator can compare out of band against a digest that did not travel with the
file; (c) say in `README.txt`, in one sentence, that running the carried script
is running code from the bundle, and that restoring from a checkout is the
verified path. That is a stated CANNOT, not a gate.

### M7 — `DRILL_RE` matches none of the names it is said to guard. §7.3

*"a throwaway world named `nova-drill-<uuid4().hex[:8]>`, with `DRILL_RE =
^nova-drill-[0-9a-f]{8}$` asserted before every create and before every
delete."* The objects created are, per step 3, `nova-drill-<id>_net`,
`nova-drill-<id>_<key>`, `nova-drill-<id>-pg`. **None of those match the
anchored regex** — it matches only the bare world id.

So the assertion as specified either fails on every create (drill never runs) or
is being applied to a different string than the one that reaches `docker volume
rm` / `docker network rm` / `docker rm -f`. Either way the stated three-touchpoint
control does not constrain the destructive argv, which is its entire purpose.
The same pattern is correct for scratch databases (§7.1/10) because there the
asserted string *is* the argument.

**Fix.** `DRILL_RE = ^nova-drill-[0-9a-f]{8}(-pg|_[A-Za-z0-9][A-Za-z0-9_.-]*)?$`,
asserted on the **object name** immediately before each command, and test 58
driven on the recorded argv rather than on the world id.

### M8 — The foreign-volume derivation rests on a claim this slice measured to be false, and misses orphaned volumes

§8: *"Volumes are **not** taken from `docker volume ls --filter label=…`. That
filter misses exactly this case: the mini PC's `nova_pgdata`,
`nova_postgres-data`, `nova_redis-data`, `nova_redis_data` predate compose
volume labelling (`hub-p0-measurements.md:61`)."*

Three things wrong with that sentence.

1. **The citation is stale.** `hub-p0-measurements.md:61` is a blank line today;
   `:60` lists only **two** volumes for the `nova` project
   (`nova_postgres-data`, `nova_redis-data`), and `:68-79` is a correction
   headed *"a `nova_` name does NOT mean the `nova` project"*.
2. **The claim is refuted by measurement.** `map-minipc-measured.md:20-25` reads
   the labels back per volume: all four **do** carry
   `com.docker.compose.project` — `nova_postgres-data` → `nova`,
   `nova_redis-data` → `nova`, and `nova_pgdata` → **`docker`**,
   `nova_redis_data` → **`docker`** (the `nova-ai-platform` stack). They are not
   unlabelled, and two of them are not the `nova` project's at all.
3. **The derivation has the gap the label filter would close.** Deriving volumes
   only from surviving containers misses any volume of the foreign project whose
   containers are gone — the ordinary result of `docker compose down` without
   `-v`. Ruling 1 requires the installer to *"name every container and volume it
   found"*; it would name none of those, and silently leave them.

And the converse gap: nothing reads a **candidate** volume's own project label,
so a volume owned by a *third* project that a foreign `nova` container happens to
mount goes into the deletion set unnamed and undeleted-by-anything-that-said-so.
On the mini PC as measured, `nova_pgdata` (project `docker`, 75.77 MB) sat one
mount away from exactly that.

**Fix.** Take the **union** of (a) volumes mounted by the named foreign
containers and (b) `docker volume ls --filter label=com.docker.compose.project=<project>`;
then `docker volume inspect` each candidate and print the project label beside
it; refuse to delete any whose label names a project other than the foreign one,
and name it in the output as "left alone, owned by project X". That satisfies
ruling 1's "names everything it found" in both directions.

### M9 — The §8 print block reports sizes and a volume list nobody measured

The sample output lists `nova_pgdata 1.4 GB`, `nova_postgres-data 220 MB`,
`nova_redis-data 12 MB`, `nova_redis_data 4 MB`. Measured
(`map-minipc-measured.md:22-25`): 67.66 MB and 37.06 kB, and the other two
belong to project `docker`. So the design's worked example of the deletion
offer shows the operator a deletion set that includes **75.8 MB of another
project's data** and four invented sizes, in a document whose own rule is
`path:line` for every factual claim.

It is "only an illustration" — but it is the illustration of the one
irreversible action in the slice, and it is the thing a reviewer reads to decide
the deletion is bounded correctly. It also reveals that the author believed the
algorithm would produce that set (see M8), which is the real signal.

**Fix.** Replace the sample with the measured reading, and add the project label
column.

### M10 — MUST #27 is not satisfied, and MUST #28 is claimed by a test that cannot satisfy it

**#27** — *"CI runs `install_test.sh` and `backup_test.sh` on `macos-15` under
`/bin/bash`"*. §11 E writes the jobs and then states they are *"written and
committed but **not enabled**"*, because `.github/workflows/rebuild-ci.yml:3-7`
triggers only on `rebuild/**` and the branch is `slice/s41`. A job that never
runs does not run `install_test.sh` on `macos-15`. Deferring the trigger to the
owner (open question 3) is right — but the design should say plainly that **#27
is unmet until he answers**, rather than listing it as delivered.

The cost is not cosmetic: §11 E's own text says the macOS job is *"the only
thing that runs the shipped scripts under a real bash 3.2"* and *"the **only**
measurement anywhere of `restore.pyz`'s ctypes-libcrypto path"* (risk 6). With
the job off, MUST #20's bash-3.2 portability and the macOS decrypt path are both
enforced by code review alone — which `map-portability.md` §6 already says is
the status quo this MUST exists to change.

**#28** — the walk is *"back up on the Dell, then `restore --drill` on the mini
PC"* (`hub-topology.md:330`): two machines. §11 D calls test 105 — a
single-host `tests/e2e` case that backs up the local stack and drills it
locally — *"the DoD walk (#28), automated"*. It is not. It exercises none of
what the cross-machine walk is for: carrying the file (C3), a different docker
version (risk 4), a different postgres minor (risk 1/9, open question 6), a
different subnet (M5), and a target with no v4 checkout history.

**Fix.** Keep test 105 and stop calling it #28. Add the walk to the slice's DoD
as a manual two-machine procedure with the exact commands, and say which of its
facts nothing automated can check.

### M11 — The 0600 mode probe is specified twice, and the container-side copy measures the wrong filesystem view

MUST #25/#26. §2's file table puts *"the 0600 mode probe on the archive
directory (#25/#26)"* in **`deploy/backup.sh`** (bash, tested by test 73 with
GNU/BSD `stat` stubs). §7.1 step 5 puts it in **the tool** (`os.chmod(0o600)`,
re-`stat`, tested by test 40 with "a fake stat returning 0644"). Two
implementations, two tests, no statement of which one satisfies the MUST.

It matters because they measure different things. The tool runs inside the
container against a **bind mount**; on Docker Desktop (macOS, and WSL2 here) the
container's view of a bind-mounted host directory is synthesised by the file
sharing layer, so a `chmod`+`stat` round trip inside the container can succeed
on a host filesystem that cannot hold the mode — which is precisely the NTFS /
exFAT / CIFS case the probe replaced the `/mnt/[a-z]/` regex to catch.

**Fix.** The probe is the wrapper's, on the host, before the container is
started — the design's own §0 reasoning ("what the wrapper keeps, and why")
already argues for that placement. Delete test 40 or re-point it at the wrapper.
This is unverified against a real macOS/Docker Desktop host; I had none.

---

## MINOR

1. **`"cipher": "AES-256-GCM"` vs v3's `"aes-256-gcm"`.** §5's header JSON shows
   the uppercase form; `backend/app/backup_crypto.py:119,154` writes and
   requires lowercase (`header.get("cipher") != "aes-256-gcm"` → `CryptoError:
   unsupported format`). As written, the reader refuses every v3 payload —
   contradicting §5's own stated benefit ("a v3 payload can be opened by this
   reader for free") and the claim that the wire format is "byte for byte
   unchanged". Fix: lowercase, and pin it with a byte-comparison test against a
   v3-written fixture.
2. **`meta.json` "nothing decides anything from it" is not true.** §7.2 step 3
   resolves *"the passphrase for **this bundle's** fingerprint"* — read from the
   unauthenticated `meta.json`, because the manifest's copy is inside the
   ciphertext. Benign (a wrong choice just fails the decrypt) but the absolute
   statement is wrong and should be softened to "nothing that survives a failed
   decrypt".
3. **`PATH_POLICY` states "first match wins" and then violates it.** The table
   lists `deploy/tailscale/**` (EXCLUDE_CODE) **above** `deploy/tailscale/MOVED_TO`
   (EXCLUDE_EPHEMERAL), so the more specific entry is unreachable. Harmless
   today (both exclude), but it is the ordering discipline being broken in the
   table that teaches it.
4. **The free-space gate under-counts.** §7.1 step 5 requires `2×` the estimated
   bundle. The run holds, concurrently or in sequence: the staging tree, the
   `inner.tar.gz`, the step-13 full extraction, `payload.enc`, the `.part`, and
   the step-16 round-trip extraction. That is nearer 4–5×. Risk 5 admits the
   estimate "is currently a guess". Fix: derive the estimate from the volume
   sizes read in step 11 and gate at `4×`, or stage to a temp dir the check also
   measures.
5. **The volume listing only covers regular files.** Step 11(a) is
   `find . -type f`, while 11(b) tars `.` — so symlinks, directories, empty
   directories, modes and ownership are inside the tar but outside
   `listing_sha256`. The restore comparison (step 9) therefore cannot detect a
   missing symlink or a changed mode, which weakens "the restored file set is
   identical to the manifest's". Also, a filename containing a newline breaks the
   line-oriented listing (GNU `sha256sum` escapes it with a leading `\`, which
   the `LC_ALL=C` sort then orders differently). Fix: `find . -mindepth 1` with
   `-printf`-free type/mode capture, or hash `tar -tvv` output alongside.
6. **"nothing is pulled" cannot hold on the restore side.** §7.1 step 11 reads
   postgres's image **id** from the running container so nothing is pulled. At
   restore, step 9 (untar) runs *before* step 10 brings postgres up, so there is
   no running container to read an id from and the image must be pulled by tag —
   as step 5 already does. Say so; it interacts with the bootstrap argument in
   §0 ("a machine with no registry access is not a machine Nova can be restored
   onto").
7. **`--env NOVA_BACKUP_PASSPHRASE` keeps the value in the container's config.**
   §6 and test 75 assert the value never enters argv, which is right. It does
   enter the container's `Config.Env` and is readable by `docker inspect` for the
   container's lifetime. `--rm` bounds it and socket access is already root, so
   this is acceptable — but the design should state it rather than leave "name
   only" to imply more than it delivers.
8. **The raw-YAML service scan assumes one file.** §4 step 2 reads "the top-level
   `services:` keys straight out of the raw YAML **file**". With the GPU overlay
   in the `-f` list (`deploy/install.sh:830`) or `COMPOSE_FILE` from `.env`
   naming two files, there are two. `docker-compose.gpu.yml` declares only
   `ollama` and `gateway` and no volumes, so nothing is missed today — but the
   check should iterate the same file list it passed to compose.

---

## Verdict: **SOUND-WITH-FIXES**

The architecture is right and survives the attack. The choice of a Python
package with two carriers, v3's `NOVAENC1` ported unchanged, coverage derived
from `--profile '*'` with a refusal rather than a skip, and a verification step
attached to every action is the correct shape for this slice, and most of what
is wrong is local.

But two of the four criticals are **blocking and shape-changing**, not line
fixes, and neither can be deferred into implementation:

- **C1** needs coverage's third derivation signal back (git), because without it
  `PATH_POLICY` cannot be made total over a real tree without a catch-all — and
  a catch-all is the silent skip MUST #4 forbids. As written, `backup` refuses
  on every run.
- **C2** means ruling 1's one hard invariant — *"impossible to touch a v4
  volume"* — does not hold, and the test the ruling demands would pass anyway
  because it is driven from a hand-written fixture rather than a real resolved
  config.

C3 (root-owned bundle) and M10 (#28) together mean the walk that defines done
cannot be performed as designed. All four have small, named fixes above.

One process note, because it caused three of the findings: **none of the three
S41 designs cites `map-minipc-measured.md`**, the most recent measurement in the
slice. It contradicts this design on the volume-label claim (M8), on the
deletion set's contents and sizes (M9), and on file ownership (C3), and it
records that the old stacks were archived and removed on 2026-09-21 — so the
blocker §8 is built for no longer exists on that machine, which changes what the
walk can demonstrate.

### Three things this design does better than the other two stances

1. **The bootstrap is confronted instead of assumed.** §0's three ordered layers
   — pyz, then image, then an honest refusal naming the two digests it could not
   fetch — plus **test 9**, which decrypts a library-written payload in a
   *subprocess* under `NOVA_FORCE_CTYPES_GCM ∈ {0,1}` and asserts the forcing
   worked, is the only place in the three designs where "the restore script
   inside every bundle" (#3) is pinned as *working code* rather than as a copied
   file. §7.1 step 15 goes further and runs `python3 restore.pyz --version` on
   the machine that wrote the bundle before the bundle counts as written.
   `design-port-v3.md` inherits v3's standalone script, which deliberately
   stopped at printing the next commands (`map-v3-backup.md:546`); the
   shell-first stance puts the same code behind the container it calls optional.
2. **`--profile '*'` is measured, and its absence is made a refusal.** §4's [M]
   block is correct (I re-ran it), and `R0_PROFILE_GAP` (step 2, test 14) checks
   the wildcard *worked* by reading the raw YAML rather than trusting compose's
   own `config --profiles`, which the same measurement shows omits `tailnet`.
   That turns the one coverage miss arc 8 exists to stop — `v4_tailscale`
   invisible in an unwildcarded config — into a named refusal instead of a quiet
   narrowing. Neither of the other two designs makes the profile gap a refusal
   code.
3. **The verifications are typed, and the failure vocabulary is honest.** The
   five-value exit ladder with a distinct `4` for *"the artefact is good but the
   machine was not left as found"*; `FinishedAt` newer than the stop request
   rather than `Running == false` (test 33); `PGDMP` magic rather than file size
   (test 35); `pg_restore --exit-on-error` justified as *required, not tidy*;
   `count(*)` rather than v3's forgiving `n_live_tup`; the scratch-name assertion
   at three independent touchpoints; and step 16's re-open-and-round-trip of the
   finished file. Those are the checks that catch a lie, and most of them cannot
   be expressed in a shell orchestrator without reimplementing them — which is
   the core argument of §0, and it holds.
