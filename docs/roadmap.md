# Nova — Roadmap

> Last updated: 2026-06-10. v2 rewrite shipped 2026-05-12.
>
> **Vision:** A self-directed autonomous AI platform. You define a goal. Nova breaks it into
> tasks, executes them with tools, and runs autonomously between conversations.

---

## What's Shipped (v2)

### Core Services

| Service | Port | Status |
|---|---|---|
| agent-core | 8000 | Running — task execution, LLM coordination, MCP, secrets, schedules, conversations |
| llm-gateway | 8001 | Running — multi-provider routing (Ollama, OpenAI, Gemini, Groq, Anthropic) |
| memory-service | 8002 | Running — flat `memories` table, pgvector semantic search |
| voice-gateway | 8003 | Running (profile: `voice`) — STT/TTS proxy |
| chat-surface | 8004 | Running — WebSocket bridge (browser ↔ agent-core) |
| recovery | 8888 | Running — backup/restore, container management |
| dashboard | 3000 | Running — React PWA |

### Chat

- Streaming chat via WebSocket
- Conversation history with sidebar
- Multi-turn context per conversation
- Tool approval UI (approve/deny agent tool calls inline)
- Output style selector (Default / Concise / Detailed / Technical / Creative / ELI5)
- Custom instructions field
- Web search and deep research toggles
- File attachment support
- Model selector (auto-routes or explicit model)
- Per-conversation delete + bulk clear all

### Agent Execution

- Task creation and execution with tool use
- MCP server registration — tools dispatched from connected servers
- Tool tier system (READ/MUTATE/ADMIN) with approval gates
- Streaming task events (SSE) with live status
- Task message history

### LLM Gateway

- Providers: Ollama (local), OpenAI, Gemini, Groq, Anthropic
- Routing strategies: `local-first`, `local-only`, `cloud-first`, `cloud-only`
- Automatic provider resolution with key validation
- Streaming and non-streaming completion

### Memory

- Flat `memories` table with pgvector embeddings
- Semantic search + keyword fallback (tsvector)
- Memory browser in dashboard (filter by source kind)
- Stats endpoint (count, size, advisory)

### Secrets

- AES-256-GCM encrypted secrets table
- Bootstrap from `.env` on first boot (idempotent)
- CRUD via dashboard (Settings → Secrets)
- Resolved by services at runtime — no plaintext in config files

### Schedules

- Schedule creation and management
- Webhook triggers

### Recovery

- PostgreSQL backup/restore
- Docker container lifecycle management via scoped socket proxy
- Factory reset

---

## In Progress / Known Issues

- **Voice TTS not wired:** STT (mic → text) exists in Chat.tsx. TTS (Nova speaks back) — hook and overlay exist but are disconnected. Not yet wired.
- **Voice-gateway not in default stack:** Requires `COMPOSE_PROFILES=voice`. STT mic button will fail without it.
- **nginx production gaps:** `/v1/` (llm-gateway) and `/recovery-api/` not proxied in production nginx — only available in dev (Vite proxy). Affects direct LLM API access and recovery UI in production.
- **Dead letter queue:** ~285 stale pre-v2 entries in Redis. Not growing. Flush: `docker compose exec redis redis-cli -n 2 DEL nova:queue:dead_letter`

---

## Next Up

### 1. Voice — Nova speaks back
Wire TTS into Chat.tsx using the existing `useVoiceChat` hook and `VoiceModeOverlay`. Un-gate voice-gateway from the `voice` compose profile so it runs by default. Goal: speak to Nova, Nova responds aloud.

### 2. Autonomous Execution — Verify and harden
Confirm the agent tool-use loop works end-to-end: user asks Nova to do something, Nova uses MCP tools to do it, reports back. Identify and fix any gaps in the agent loop.

### 3. Production nginx
Add `/v1/` → llm-gateway and `/recovery-api/` → recovery proxies to `dashboard/nginx.conf`.

### 4. Schedules — End-to-end
Verify scheduled tasks fire correctly and produce results. Wire schedule output back into chat or notifications.

### 5. Proactivity — Nova acts on its own
Increment 2 of the continuity-memory plan (`docs/specs/2026-06-09-continuity-memory-design.md`):
a lightweight autonomy pulse inside agent-core — periodic self-review schedule
(`created_by='nova'`), an LLM "anything worth doing?" gate with a hard budget cap and kill
switch, and a proactive inbox in the dashboard. Depends on #4 (rides the scheduler).
Includes the model tool-call verification gate from the recommended-models spec as a
safety prerequisite.

### 6. Recommended models — restore v1 Models page, with capability gauges
Restore the v0.1.0-alpha model management features on the v2 stack: hardware-aware
recommended-model list (single manifest, remote-refreshed from the repo), one-click
Ollama pull with streamed progress, install-wizard model picker, and per-model
capability gauges (agent/tool-calling first) with local vs cloud/frontier models
clearly separated. Spec: `docs/specs/2026-06-10-recommended-models-design.md`.

---

## Deferred

- **Multi-tenant / SaaS** — Single-tenant only for now. Revisit when deployment topology demands it.
- **Fine-tuned onboarding LLM** — Train a small model on Nova's onboarding flow. Post-MVP.
- **Kubernetes** — Only when Compose topology is outgrown.
- **Chat bridge (Telegram/Slack)** — Was in v1, not ported to v2.
- **Intel feed poller / knowledge crawler** — Was in v1, not ported to v2. Revisit if autonomous research becomes a priority.
