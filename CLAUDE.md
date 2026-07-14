# Nova v3 (rebuild/fable)

## This is the canonical lane

- This worktree (`~/workspace/nova-rebuild`, branch `rebuild/fable`) is the
  **one canonical Nova v3**, pushed to origin. Other folders (`nova`,
  `nova-brain`, `nova/.claude/worktrees/model-pool`) are separate worktrees
  of the same repo for other lanes — do not work in them, and run
  `git status` before any branch operation in case another session has
  uncommitted work here.
- A deleted lane called `nova-v3-dev` used to exist; it's archived at tag
  `archive/v3-vite-scaffold`. If you see references to it or to
  `NOVA_PLAN.md`, that lane is dead — `ROADMAP.md` in this repo is the only
  roadmap.
- Tags `v0.1.0-alpha` (v1) and `v0.5.0-alpha` (v2 final) are **reference
  only**: mine them for ideas/designs (e.g.
  `git show v0.5.0-alpha:DESIGN.md`), never build from their code. Policy
  and harvest list are in `ROADMAP.md`.

## The running stack

The live stack is the `nova-rebuild-*` docker compose containers:

| Service  | Port  | Notes                          |
|----------|-------|--------------------------------|
| frontend | :5173 | the UI                         |
| backend  | :8000 | FastAPI                        |
| postgres | :5432 |                                |
| searxng  | :8380 | keyless web search             |
| ollama   | :11434| optional `inference` profile   |

Read `README.md` for what works and `ROADMAP.md` for the ordered backlog
("Next up" is the priority order).

## Operational traps

- `docker compose restart backend` does **not** re-read `.env` — use
  `docker compose up -d backend` after env changes.
- Migrations auto-run at backend startup from
  `backend/app/migrations/*.sql` — check the directory for the next free
  number before adding one.
- Memory files live in `./data/memory/` (gitignored) — human-readable, safe
  to edit by hand; the index rescans on startup and reindexes on write.

## Definition of done

Verify in the running app (real chat flow through :5173), not just tests or
code review. Commit on this branch and push. Never delete `LICENSE`.
