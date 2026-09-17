# Roadmap — where it actually lives

This file is a pointer. It is not the backlog.

## v4 — the current system

**→ [`docs/plans/rebuild/ROADMAP.md`](docs/plans/rebuild/ROADMAP.md)**

The ordered backlog for v4, and the index to the slice documents in
`docs/plans/rebuild/`. That is the "master roadmap" the slice docs cite.

## v3 — archived, and still worth mining

**→ [`docs/archive/ROADMAP-v3.md`](docs/archive/ROADMAP-v3.md)** (51 items)
and **[`docs/archive/NEXT-v3.md`](docs/archive/NEXT-v3.md)**

Moved here 2026-09-17, unchanged. Until then this path held v3's backlog — 2,436
lines, last touched 2026-08-08 — while every v4 slice was tracked somewhere
else entirely. Anyone following `CLAUDE.md`'s instruction to read "the ordered
backlog" was reading the wrong product.

It is archived, not dead: it is the best record of what v3 shipped and planned,
and `docs/plans/rebuild/ROADMAP.md` mines it by name. The 49 plan documents in
`docs/plans/` belong to it. Rows marked **"v3 only"** in
[`docs/plans/README.md`](docs/plans/README.md) hold approval, consent and grant
designs the owner ruled out of v4 on 2026-09-03 — never mine those as prior art
(`docs/plans/rebuild/no-approvals.md`).

## Older versions

**→ [`docs/history/releases.md`](docs/history/releases.md)** — what v1, v2 and
v3 each were, what they could do, and which of it v4 does not carry.

---

*This file stays at this path because v3's `docker-compose.yml:428` mounts it
read-only into the `mcp-runner` workspace and
`backend/tests/test_compose_contract.py:51` pins the path. That stack is not the
live one — v4's compose is `deploy/docker-compose.yml` — but breaking a contract
test to move a file nobody asked to move is not a trade worth making.*
