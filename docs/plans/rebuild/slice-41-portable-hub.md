# S41: portable hub — the encrypted bundle, verified restore, and the drill

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.
> The design is [`s41/design-verdict.md`](s41/design-verdict.md). It is the
> **authority**: exact bundle layout, MANIFEST schema, the crypto construction,
> every verb as numbered steps with what each step verifies, the coverage
> algorithm and its eight refusal codes, and the full test list. Read the
> sections for your task before writing a line. The binding decisions are
> [`s41/rulings.md`](s41/rulings.md); what was measured rather than assumed is
> [`s41/measurements.md`](s41/measurements.md) and
> [`s41/map-minipc-measured.md`](s41/map-minipc-measured.md).

**Goal:** Nova's whole state leaves one machine and comes up on another, with
every step verifying its own result — so the hub can move to the mini PC (S45)
and a dead machine is a delay, not a loss.

**Architecture** (verdict §1): `deploy/backup.sh` in portable bash 3.2 **decides,
verifies and refuses**, and is the only thing that holds `docker` or writes
`.env`. It renders every fact into `$STAGE/facts/*.json` and hands them to a
throwaway container of the **already-built core image, with no docker socket** —
`cryptography` is already a dependency there (`services/core/pyproject.toml:11`).
The bundle is a `NOVAENC1` tar (scrypt + AES-256-GCM per 4 MiB frame) that
carries its own reader, and before publishing, **that shipped reader is run
against the finished bundle** with `cryptography` forced unimportable, so the
path a bare machine takes is the path that was proven. Coverage dispositions
live as `x-nova-backup:` rows beside the volumes they describe in
`deploy/docker-compose.yml`; the declared set is read from the **raw compose
text**, because both compose versions prune a declared-but-unmounted volume from
every render (`s41/measurements.md` R2).

**Tech stack:** portable bash 3.2 (Linux and macOS, BSD and GNU userland),
python 3.12 inside the core image, postgres 16, docker compose v5.3+, Go for
novad's `repoint`.

## Global constraints

- **Arc 8 wins.** Encrypted bundle, resolver seam, reader inside every bundle,
  compose-derived coverage that **refuses** on anything unclassified. No
  `BACKUP_EXCLUDE_DATA` (`rulings.md`, ruling 2).
- **A step that cannot verify its own result must FAIL and say why.** A fallback
  that reads as success is the defect this repo hates most. Every verb's steps
  are numbered in verdict §9 with their verification named.
- **The writer is not the verifier.** A container writes as root; the operator
  reads back. Every artefact a container produces is `chown`ed to the invoking
  uid and re-read **as the operator** before it counts — measured the hard way
  (`map-minipc-measured.md`, "After the cleanup"). Ownership is relaxed; the
  0600 mode is not.
- **Nothing is selected by name.** Containers, volumes and projects are selected
  by the `com.docker.compose.project` label read from docker. A `nova_` name
  belongs to another project on the owner's own machine, and selecting by
  prefix would have destroyed 75.8 MB of it.
- **No approvals** (`services/core/tests/test_no_approvals.py` stays green). A
  check may state a **CANNOT**; it may never decide on the owner's behalf. The
  deletion path states exactly what it will destroy and defaults to nothing.
- **Bash 3.2.** No arrays-as-maps, no `${var,,}`, no `mapfile`, no `declare -A`,
  no process substitution. `sha256sum` else `shasum -a 256`; `ip -4 route` else
  `netstat -rn`; no `sed -i`, no GNU-only `date`/`stat`/`readlink -f`. See
  `s41/map-portability.md`.
- **No tool, no guard, no eval case, no migration, no HTTP route, no setting.**
  S41 is operator tooling; the chat walk is S45. `test_tools_registry` and
  `test_eval_corpus` pins **do not move**; if they do, something went wrong.
- **Commits** by path, ending `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
  `ruff format` on edited files only. The repo is **public**: no MACs, tailnet
  IPs, GPU UUIDs or keys in code, tests or docs.

## Tasks

T1, T2, T5 and T6 are independent; T3 needs T1+T2; T4 needs T3; T7 needs all.

| Task | Scope (verdict §) | Files | Tests |
|---|---|---|---|
| **T1** | **Coverage** (§6): `x-nova-backup` rows in the compose file, `# nova-backup:` lines in `.env.example` (**including `INSTANCE_SECRET`**, which the live `.env` carries and nothing declares — `measurements.md` R7), `compose_read.sh`, the six fact renderers, `novabundle.py`'s `coverage()` and its eight refusal codes, `SEGMENT_POLICY` | `deploy/docker-compose.yml`, `deploy/.env.example`, `deploy/compose_read.sh`, `deploy/backup.sh`, `deploy/backup/novabundle.py` | `backup_test.sh` compose-reader + coverage blocks; `test_coverage.py`, `test_coverage_v4_real.py`, `test_policy.py`. No docker |
| **T2** | **Crypto, bundle, passphrase, the in-bundle reader** (§5, §7, §8): `NOVAENC1`, tar + manifest + `safe_extract`, `nova_restore.py`, `restore.sh`'s KAT probe, `passphrase.sh` | `deploy/backup/novabundle.py`, `deploy/backup/nova_restore.py`, `deploy/backup/restore.sh`, `deploy/passphrase.sh` | `test_novaenc.py`, `test_restore_reader.py`, `test_restore_sh.py`, `test_bundle_layout.py`, `test_bundle_verify.py`, `test_manifest.py`, `test_passphrase_fingerprint.py`. No docker |
| **T3** | **`backup`** (§9.1): all 23 steps — the lock, the probes, the writer derivation, the census, the dump, the self-test restore, the tars, pack, **the shipped-reader round trip**, chown, publish, restart-or-park, the EXIT trap | `deploy/backup.sh` | `backup_test.sh` backup block; `test_census.py`; then one real `./install backup` on the Dell |
| **T4** | **`restore`, `restore --drill`, `drill`** (§9.2–§9.4): the in-progress marker, the orphan sweep, the refusals | `deploy/backup.sh` | `backup_test.sh` restore + drill blocks; `tests/e2e/test_backup_roundtrip.py` (live, single host) |
| **T5** | **The installer** (§10): `check_foreign_project` + the bounded deletion, `decide_subnet` + `subnet.sh` + the three compose substitutions, `refuse_if_moved`, `set_env_value`'s missing-file fix | `deploy/install.sh`, `deploy/subnet.sh` | `install_test.sh`'s new cases, including the three-volume fixture (project `nova`, a `nova_`-named decoy owned by another project, a v4 volume) asserting only the first is selected. No docker |
| **T6** | **The edges** (§11, §12.5): novad `repoint`, the `MOVED_TO` guard in `deploy/tailscale/start.sh`, `deploy/README.md`'s three new sections + the fixture-refresh procedure, the four now-wrong `network_credentials` sentences, and **the CI work the owner approved on 2026-09-21** — widen the trigger to `slice/**` and `main`, add the **`macos-15`** job running both shell suites under `/bin/bash`, and re-enable the workflow (`rulings.md`) | `apps/novad/…`, `deploy/tailscale/start.sh`, `deploy/README.md`, `hub-topology.md`, `hub/r2-integration.md`, `.github/workflows/rebuild-ci.yml` | `repoint_test.go`, `start_test.sh`, `bash -n`. No docker |
| **T7** | **The walk** (controller) | — | by hand, recorded in `deploy/README.md` |

## Definition of done

1. **Every suite green by hand**: the shell suites, the new python tests, core
   in full (it must not move), gateway, memory, novad `go test -race`.
2. **`./install backup` on the Dell**, as the operator: the bundle is 0600 and
   owned by him, its shipped reader opens it on a machine with only docker, and
   `sha256_of` run **as the operator** matches what the run printed.
3. **The move rehearsal (#28):** copy that bundle to the mini PC and
   `./install restore --drill` there. Per-table counts, digests and the
   **signing-key fingerprint** must be equal, and no `nova-drill-*` object may
   survive.
4. **The destructive path is executed, not just fixtured** (`rulings.md`): the
   walk **builds** a synthetic `nova` compose project beside a `nova_`-named
   decoy owned by another project and a real v4 volume, runs the refusal, runs
   the bounded deletion, and verifies the synthetic project is gone while the
   decoy and the v4 volume survive.
5. **A wrong passphrase is refused before a payload byte is read**, and the
   refusal says so.
6. **Coverage refuses** on a volume with no disposition — proven by adding one
   to a fixture, not by argument.
7. Close-out and carries written; `deploy/README.md` documents backup, restore,
   the drill and moving Nova; the slice record states plainly that **#27 is
   deferred** (CI is off by the 2026-09-07 decision and `rebuild-ci` is
   `disabled_manually`) and that **#29 was proven against a synthetic project,
   never against a real foreign one**.
