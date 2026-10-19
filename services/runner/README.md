# @nova/runner-service

A self-hostable cloud runner for Nova (FR-108, FR-071, FR-116; `contracts/rest-api.md` §5,
ADR-095). It holds environments (repositories cloned side by side, a setup script run once, caches
kept), runs their commands and file operations inside a sandbox it starts itself, streams output,
keeps snapshots and enforces hard caps. The Hub keeps the agent loop, the model calls and the
policy gate: nothing reaches the runner before the Hub's gate allowed it, and approvals are never
answered here. Apache-2.0 (ADR-023); it imports no AGPL package.

## Sandbox

- **bubblewrap** (preferred, Linux): new namespaces, every capability dropped, a seccomp filter,
  the host's system folders read-only, and only the environment's own folders mounted: the workdir
  at `/workspace`, caches at `/cache/<name>` (and Nova's own state at `/nova` for the Hub's own
  programs only). No network unless the environment allows it (`network: off | setup | on`;
  `setup` lets only the setup script reach it). With network on, bubblewrap shares the runner
  host's network: prefer the container substrate on a runner that serves untrusted work. The Hub
  asks for network only when the owner turned on `cloud.runner.unrestrictedNetwork` (off by
  default): runner network does not go through the Hub's egress proxy.
- **docker or podman**: the environment's `baseImage` (or `debian:stable-slim`) as a non-root user,
  no capabilities, `--network none` unless allowed, the same mounts, pids and memory limits, and
  the program as the entrypoint (the image's own ENTRYPOINT never runs). The image needs Git for
  cloning.
- Neither: environments are refused with the reason.

Limits per command: RLIMIT_DATA, RLIMIT_CPU (the run's CPU left) and RLIMIT_FSIZE (the disk left).
Per sandbox: a process limit (RLIMIT_NPROC, which counts per user namespace) and, where
`systemd-run --user --scope` works, a cgroup with pids and memory limits. Per Hub token: a share of
the runner's command slots. Bubblewrap refuses to run as root. `/nova` (Nova's own state) is
mounted only for the Hub's own `/runs/:id/run` programs, never for commands. A disk count that
stops at its entry limit counts as over the cap.
Each run (a Hub session's lease) has CPU and wall-time caps, each environment a disk cap; a warning
event at 80 % and a hard stop at the cap. Defaults (`DEFAULT_RUNNER_LIMITS` in `src/runner.ts`):
CPU 3,600 s and wall time 4 h per run (at most 7 days each), disk 10 GiB per environment (at most
50 GiB), 64 commands at once on the runner, 16 per token and 8 per run, 256 processes and 4 GiB of
memory per sandbox, 2 GiB of data per process, 20 environments per token, artifacts up to 50 MiB.
Rate limits per token: 1,200 requests and 240 commands a minute, 30 environments and 60 snapshots
an hour; 30 failed sign-ins a minute per address. Commands and their output live in memory only; what is
kept on disk lives inside the environment's folder and goes with it.

## Run it on this machine (the local runner)

```sh
node services/runner/src/main.ts token add --data-dir ~/.nova-runner --label my-hub
# prints the token once; the file keeps only its SHA-256 hash
node services/runner/src/main.ts --data-dir ~/.nova-runner --port 7431
```

Then in the Hub: Settings, Cloud runner: URL `http://127.0.0.1:7431`, the token, on
(`PUT /api/v1/cloud/runner`). Plain `http://` is accepted only for this machine.

## Run it remotely

Run the same command on the remote host with `--host 0.0.0.0` behind a TLS-terminating proxy and
give the Hub its `https://` URL. Every route needs a Hub's bearer token (`Authorization: Bearer
nvrun_…`); each token sees only what it created. Requests are rate limited per token, failed
sign-ins per address. The token file is re-read when it changes, so adding a Hub needs no restart.

Options: `--data-dir` (default `~/.local/share/nova-runner`), `--token-file` (default
`<data-dir>/tokens`), `--substrate auto|bwrap|docker|podman`, `--image <ref>`, `--local-repos
<dirs>` (folders `file://` repositories may come from; none by default, so a Hub cannot read the
runner's disk). Repositories are otherwise `https://` only (no credentials in the URL, no private
or local addresses), cloned inside the sandbox with hooks, prompts, system and global Git config
off.

## API

`/v1/runner/health`; environments (`POST/GET /environments`, `GET/DELETE /environments/:id`,
`POST /environments/:id/rebuild`, `GET/PUT/DELETE /environments/:id/files?path=`); runs (`POST/GET
/runs`, `GET/PATCH /runs/:id`, `POST /runs/:id/cancel|finish|exec|run|kill|artifacts`,
`GET /runs/:id/processes`, `GET /runs/:id/processes/:pid/output?offset=&waitMs=`,
`POST /runs/:id/processes/:pid/input`, `GET /runs/:id/stream` (server-sent events, resumable with
Last-Event-ID), `GET /runs/:id/artifacts/:aid`); snapshots (`POST/GET /snapshots`,
`GET/DELETE /snapshots/:id`, `POST /snapshots/:id/restore`). `POST /runs/:id/approve` answers 501
`approvals_on_hub`. Errors use `contracts/rest-api.md` §6.
