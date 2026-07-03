# Nova

Nova is a self-directed autonomous AI platform. Define a goal and Nova breaks it into subtasks, executes them through a coordinated pipeline of specialized agents, evaluates progress, re-plans, and completes — with minimal human intervention.

Built by [Aria Labs](https://arialabs.ai).

---

## Get Started

You need [Docker Desktop](https://docker.com/products/docker-desktop) (which includes Docker Compose) and [Git](https://git-scm.com/). Nothing else — Python, Node.js, Postgres, Redis, and Ollama all run inside containers.

**Fastest** — clone and launch the wizard in one command:

```bash
curl -fsSL https://raw.githubusercontent.com/arialabs/nova/main/scripts/bootstrap.sh | bash
```

**Or** if you'd rather see the source before running anything:

```bash
git clone https://github.com/arialabs/nova.git
cd nova
./install
```

Either way lands you in the same install wizard.

The `./install` wizard will:

1. Check Docker is installed and running
2. Ask how you want to use Nova:
   - **hybrid** (default) — local AI (bundled Ollama) with cloud fallback
   - **local-only** — bundled Ollama, never call cloud
   - **cloud-only** — no local AI, only cloud APIs (skips ~5 GB of model downloads)
3. Configure provider API keys (optional — paste your Groq/OpenAI/etc keys when prompted, or skip)
4. Pull starter models (`qwen2.5:1.5b`, `qwen2.5:7b`, `nomic-embed-text` — about 5.4 GB total under hybrid/local-only; nothing under cloud-only)
5. Start every service via Docker Compose

When it finishes, open **<http://localhost:3000>** for the dashboard.

You can change inference mode, start/stop bundled inference containers (Ollama, vLLM, SGLang, llama.cpp), point at an external server, and manage cloud provider keys later via **Settings → AI & Models** — no scripts.

---

## Architecture

| Service | Port | Role |
|---|---|---|
| dashboard | 3000 | React admin UI |
| orchestrator | 8000 | Agent lifecycle, tool dispatch, session state, pipeline queue, MCP |
| llm-gateway | 8001 | Model routing — Anthropic, OpenAI, Ollama, Groq, Gemini, Cerebras, OpenRouter |
| memory-service | 8002 | Markdown memory (OKF frontmatter + BM25 retrieval) |
| chat-api | 8080 | WebSocket streaming for external clients |
| cortex | 8100 | Autonomous brain: thinking loop, goals, drives, budget tracking |
| intel-worker | 8110 | AI ecosystem feed poller (RSS, Reddit, GitHub trending) |
| voice-service | 8130 | STT/TTS proxy (OpenAI) — optional |
| recovery | 8888 | Backup/restore, factory reset, service management |
| ollama | 11434 | Bundled local model serving (optional profile; vLLM/SGLang/llama.cpp also available) |
| postgres | 5432 | pgvector/pg16 — agents, tasks, pods, platform config |
| redis | 6379 | Agent state, task queue, rate limiting, runtime config |

Full architecture detail: <https://arialabs.ai/nova/docs/architecture>.

---

## Common commands

```bash
./start           # Production boot-up: build + up + wait for health
make dev          # Development: detached stack + Vite dashboard with hot reload
make down         # Stop all
make logs         # Tail all container logs
make ps           # Container status
make test         # Integration suite (~2 min, requires services running)
make backup       # Create a database backup to ./backups/
```

`./start` and `make dev` are different intentionally: `./start` brings up production-style services and exits, `make dev` adds the Vite hot-reload dashboard and stays in the foreground. Use `./start` after a reboot or `make down`; use `make dev` while editing dashboard code.

## Uninstall

```bash
./uninstall --dry-run    # See what would be removed (no destruction)
./uninstall              # Type 'uninstall' to confirm; cleans everything
```

The uninstaller stops all Nova containers, removes Nova-built images and named volumes, deletes `.env` / `data/` / `backups/` / build artifacts / `~/.nova/workspace/`, and reports total disk reclaimed. It leaves the cloned repo source intact and does NOT touch shared upstream Docker images (`ollama/ollama`, `pgvector/pgvector`, `redis`) — those may be in use by other Docker projects on this machine.

To delete the cloned repo too: `cd .. && rm -rf nova`.

---

## Tech Stack

- **Backend:** Python 3.12 + FastAPI + asyncpg + asyncio
- **Frontend:** Vite + React + TypeScript + Tailwind + TanStack Query
- **Database:** PostgreSQL 16 + pgvector
- **Queue:** Redis (BRPOP task dispatch)
- **Containers:** Docker Compose with hot reload

---

## IDE Integration

Nova exposes an OpenAI-compatible endpoint at `http://localhost:8000/v1`. Compatible with Cursor, Continue.dev, Aider, and any OpenAI-API client. See [docs/ide-integration.md](docs/ide-integration.md) (or <https://arialabs.ai/nova/docs/ide-integration>) for setup.

## License

PolyForm Noncommercial 1.0.0 — see [LICENSE](./LICENSE). Commercial licensing available — contact <jeremy.spofford@arialabs.ai>.
