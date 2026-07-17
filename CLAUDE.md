# Nova v3

## Canonical setup

- The repo lives at `~/workspace/nova` — a **standalone clone** of
  github.com/jeremyspofford/nova, working directly on `main`. This is the
  only working folder on this machine. The old sibling-worktree sprawl
  (`nova` as the parent checkout, `nova-brain`, `nova-rebuild`) is gone:
  the v3 lane `rebuild/fable` was merged to `main` via PR #61 on
  2026-07-14 and deleted, and this folder (formerly `nova-rebuild`) was
  renamed to `nova`.
- If a task needs an isolated worktree, create it **inside the repo** under
  `.worktrees/<name>` (gitignored) — never as a sibling folder.
- A deleted lane called `nova-v3-dev` used to exist; it's archived at tag
  `archive/v3-vite-scaffold`. If you see references to it or to
  `NOVA_PLAN.md`, that lane is dead — `ROADMAP.md` in this repo is the only
  roadmap.
- Tags `v0.1.0-alpha` (v1) and `v0.5.0-alpha` (v2 final) are **reference
  only**: mine them for ideas/designs (e.g.
  `git show v0.5.0-alpha:DESIGN.md`), never build from their code. Policy
  and harvest list are in `ROADMAP.md`.

## The running stack

The live stack is the `nova-*` docker compose containers (compose project
`nova`, pinned in `docker-compose.yml`):

| Service  | Port  | Notes                                    |
|----------|-------|------------------------------------------|
| frontend | :5173 | dev UI (vite, HMR, proxies /api)         |
| web      | :8080 | built PWA + API, one origin (phone path) |
| backend  | :8000 | FastAPI                                  |
| postgres | :5432 |                                          |
| searxng  | :8380 | keyless web search                       |
| ollama   | :11434| optional `inference` profile             |

All host ports bind 127.0.0.1 only. NOVA_AUTH_TOKEN in .env gates the API —
API calls need `Authorization: Bearer <token>` (read it from .env).

Read `README.md` for what works and `ROADMAP.md` for the ordered backlog
("Next up" is the priority order).

## Operational traps

- `docker compose restart backend` does **not** re-read `.env` — use
  `docker compose up -d backend` after env changes.
- The `web` service (:8080, the phone/one-origin path) serves a **baked
  build** — frontend source changes reach :5173 via HMR but NOT :8080
  until `docker compose build web && docker compose up -d web`. If a
  feature "isn't there" on the phone or labels look stale, rebuild web
  before debugging anything else (bit us twice on 2026-07-16).
- Migrations auto-run at backend startup from
  `backend/app/migrations/*.sql` — check the directory for the next free
  number before adding one.
- Memory files live in `./data/memory/` (gitignored) — human-readable, safe
  to edit by hand; the index rescans on startup and reindexes on write.

## Definition of done

Verify in the running app (real chat flow through :5173), not just tests or
code review. Leave changes **uncommitted** and summarize them — Jeremy
reviews and decides when to commit/push; never commit or push unprompted
(rule set 2026-07-14). Never delete `LICENSE`.
