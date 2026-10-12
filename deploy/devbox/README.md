# deploy/devbox — the image her change boxes run

Every command Nova runs in a change worktree (`<checkout>/.worktrees/nova-<id>`)
runs in that change's sealed box, `nova-box-<id>` (S32.2; spec
`docs/plans/rebuild/s32/spec.md` §4). This directory is the box's recipe:

| File | What it is |
|------|------------|
| `Dockerfile` | the image: Python 3.12 + uv, Node 22 + npm, Go, git, ruff; every base pinned by digest; dependency caches for main's lockfiles at `/deps/{uv,npm,go}`, owned by the owner; offline tool config as image ENV |
| `suites.toml` | the repo's whole-suite commands; a `box.exec` that runs one of them exactly takes the CPU lock (`deploy/state/cpu.lock`) |

## How it is built

`./install` builds it (`build_devbox` in `deploy/install.sh`), after the stack
is verified and before the hub's agent is installed:

- **Tag:** `nova-devbox:t-<git rev-parse HEAD:deploy/devbox>` — the COMMITTED
  tree. An uncommitted edit here changes nothing until it is committed on main
  and `./install` runs again. novad computes the same tag from the repo's
  default branch, so a change can never pick the image its own box runs.
- **Context:** a `git archive` of HEAD holding only this directory and the
  lockfiles with their manifests (`services/*/uv.lock` + `pyproject.toml`,
  `apps/web/package{,-lock}.json`, `apps/novad/go.{mod,sum}`). No source, no
  `.env`, nothing uncommitted.
- **Labels:** `nova.lock.<path>=<sha256>` per lockfile. When a change's
  lockfile differs from these, novad's fetch step fills that change's cache
  volume from a separate container with egress that sees only lockfiles and
  manifests; the box itself never has a route out.
- **Owner:** `--build-arg OWNER_UID=$(id -u) --build-arg OWNER_GID=$(id -g)`,
  so the caches copied into a change's volume belong to the user novad runs as.

A tag already in the store is not rebuilt. A failed build fails `./install`,
naming the image.
