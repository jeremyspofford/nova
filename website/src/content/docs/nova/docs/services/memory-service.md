---
title: "Memory Service"
description: "Nova's memory as a folder of markdown files with OKF frontmatter and BM25 retrieval. Port 8002."
---

The Memory Service provides Nova's long-term memory behind a backend-agnostic API at `/api/v1/memory/*`. Memory is stored as an **OKF markdown bundle** — a plain folder of markdown files with [OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) frontmatter — so you can read, edit, and version your agent's memory with any editor and `git`.

## At a glance

| Property | Value |
|----------|-------|
| **Port** | 8002 |
| **Framework** | FastAPI |
| **Storage** | Markdown files at `${NOVA_WORKSPACE}/memory/` (no database) |
| **Retrieval** | BM25 over a local index — no embeddings, no LLM calls |
| **Queue** | Redis (db 0) `memory:ingestion:queue` |
| **Source** | `memory-service/` |

## Bundle layout

| Path | Purpose |
|------|---------|
| `index.md` | Auto-maintained root index — always injected into agent context |
| `log.md` | Dated change log of memory writes |
| `topics/`, `people/`, `projects/`, `preferences/` | Concept files (`<slug>.md`) |
| `self/soul.md` | Identity anchor — who Nova is; the Brain graph grows from it. Mirrored from Settings → Nova Identity (`nova.name` / `nova.persona`) by the orchestrator at startup and on every save — edit the persona there, not this file |
| `journal/YYYY-MM-DD.md` | High-volume inbox for raw ingested digests |
| `.nova/` | BM25 index + retrieval log (regenerated, safe to delete) |

Producers (chat, intel-worker, knowledge-worker, cortex) push raw text to the Redis ingestion queue; the consumer appends digests to the journal — near-identical digests (same text modulo numbers, e.g. repeated no-op cortex cycles) are suppressed before they reach the journal. A nightly curation goal distills journals into concept files that link back to their source journals, and a 45-day journal-retention backstop runs regardless.

## API

| Endpoint | Purpose |
|----------|---------|
| `POST /api/v1/memory/context` | Formatted context for prompt assembly (empty query → root index) |
| `POST /api/v1/memory/ingest` | Direct write (bypasses the queue) |
| `GET /api/v1/memory/item/{id}` | Full content of one memory file |
| `PUT /api/v1/memory/item/{id}` | Edit one file in place — frontmatter keys shallow-merge, `content` replaces the body (`type` is fixed; it routes the file's directory) |
| `DELETE /api/v1/memory/item/{id}` | Delete one memory file (refuses `index.md`/`log.md`) |
| `GET /api/v1/memory/graph` | Whole-bundle nodes + link edges — the dashboard Brain page's dataset |
| `GET /api/v1/memory/events` | SSE stream of retrieval events (tails `.nova/retrievals.jsonl`) — powers the Brain page's live glow |
| `POST /api/v1/memory/mark-used` | Usage feedback for retrieved items |
| `POST /api/v1/memory/feedback` | Outcome score for a memory item |
| `GET /api/v1/memory/stats` | File/link counts |
| `POST /api/v1/memory/reindex` | Rebuild the BM25 index (it also self-heals on file changes) |

## Direct edits are supported

The bundle is bind-mounted from the host workspace. Edit files by hand, have agents edit them with file tools, or `git init` the folder — the retrieval index detects file changes (mtime drift) and re-indexes automatically. Backups made from the Recovery UI include the memory folder alongside the Postgres dump.

## External providers

`memory.provider_url` (Redis runtime config) can point the orchestrator at any external service implementing the same `/api/v1/memory/*` contract (see `nova-contracts/nova_contracts/memory.py`).
