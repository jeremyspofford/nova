---
title: "Brain page & smarter model management"
date: 2026-07-07
---

- **Brain page reborn** — a live 3D view of Nova's OKF memory at `/brain`, with three lenses (Galaxy, Orrery, Singularity), retrieval glow streamed over SSE as Nova thinks, click-to-inspect frontmatter with edit/delete, a free-flight camera, and a chat drawer that shares your main conversation
- **New memory endpoints** — `GET /api/v1/memory/graph`, `PUT /api/v1/memory/item/{id}` (edit in place), and `GET /api/v1/memory/events` (retrieval SSE)
- **Dynamic model recommendations** — the Models page now pulls the live ollama.com popularity ranking (with real sizes, parameter variants, and links) or a curated list, and by default only shows models that fit your machine, plus cloud
- **Unified local model management** — every local backend (Ollama, LM Studio, …) reads the same "on disk / in memory" table with Load/Unload; each store is its own labeled section so switching backends is unambiguous
- **Recommended cloud models with pricing** — curated picks grouped by job with input/output $/Mtok and one-click use
- **User management** — permanently delete users (not just deactivate), with history preserved unattributed
- Fixed: LM Studio showing every downloaded model as "in memory", the LM Studio Test button misrouting to cloud OpenAI, a stale-dashboard-after-deploy cache bug, and double-encoded audit-log JSON
