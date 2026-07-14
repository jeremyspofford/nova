# Nova — Brain Home Screen + Multi-Agent Chat

A small, working AI agent platform: the main screen is a live memory-graph
("brain") with one continuous chat session overlaid. Chat talks to a **main
agent** that answers directly or dispatches to specialist agents from a
registry — including meta-agents that create new agents, tools, and skills at
runtime.

## Quick start

```bash
cp .env.example .env       # put a real OPENROUTER_API_KEY in .env
docker compose up -d
```

- UI: http://localhost:5173 (brain graph + chat)
- API: http://localhost:8000 (`/health`, `/docs`)

Without an OpenRouter key, models fall back to local Ollama. The bundled
Ollama container is started/stopped from **Settings → Inference** (toggle +
live status) — no CLI needed; `docker compose --profile inference up -d`
still works. Its URL and the fallback model are runtime settings there too
(point the URL at `http://host.docker.internal:11434` for a host-run Ollama).

## GPU acceleration (bundled Ollama)

`docker-compose.gpu.yml` grants the ollama service NVIDIA GPU access. The
inference-control sidecar merges it **automatically** whenever the docker
NVIDIA runtime is present, so the Settings toggle always (re)creates ollama
with the right device access — `OLLAMA_GPU=off` in `.env` opts out,
`OLLAMA_GPU=on` forces it. For manual host-side compose commands to match,
uncomment `COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml` in `.env`.

Per platform:

- **Linux + NVIDIA** — install the
  [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html);
  detection and the override are automatic from there.
- **Windows (WSL2) + NVIDIA** — the Windows NVIDIA driver + WSL2 GPU
  passthrough + nvidia-container-toolkit inside WSL; automatic from there.
  Some Docker Desktop setups support `--gpus` without advertising an
  `nvidia` runtime — set `OLLAMA_GPU=on` for those.
- **macOS** — Docker containers cannot access Apple GPUs at all (platform
  limitation, not Nova's). Run [Ollama natively](https://ollama.com)
  (it uses Metal) and point **Settings → Inference → Ollama URL** at
  `http://host.docker.internal:11434`; probes still observe GPU usage via
  Ollama's own reporting, and detection labels the machine as
  unified-memory. Set **Settings → Inference → Memory override** to the
  Mac's real unified memory — the Docker VM hides it, and models are sized
  against system memory there (no separate VRAM pool to require).
- **AMD (ROCm)** — not wired yet; the stack falls back to CPU cleanly.

Memory numbers are the VM's truth, stated as such: on WSL2 the VM defaults
to ~50% of host RAM (raise it in `.wslconfig`; that VM allocation IS the
real ceiling for the bundled Ollama), and on Docker Desktop the VM hides
the host's memory entirely (that's what the override is for). The Detect &
suggest card names the platform and says exactly which number sizing used.

**Concurrent load**: assigning different large local models to different
agents doesn't crash — Ollama evicts or spills to CPU, which shows up as
silent multi-second reloads on every agent switch. And in Nova concurrency
is the *common* case: a dispatch turn runs main's model and the sub-agent's
within one request. Settings → Inference shows stacked VRAM/RAM bars for
"if every assigned local model loads at once" (distinct models only — many
agents on one model is one load; cloud models cost zero), suggestions run a
consolidation pass so the recommended set fits together, and **Keep chat
model loaded** pins main's local model in memory (re-pinned automatically
after Ollama restarts) so chat never pays the reload.

Nova never guesses at hardware: GPU presence comes from `docker info`, the
GPU name and total VRAM from `nvidia-smi` inside the ollama container, and
per-model VRAM/GPU usage from Ollama `/api/ps` during "test this model"
probes (Settings → Inference → Detect & suggest).

## Nova on your phone (PWA)

The `web` service serves the built app and the API behind **one origin** on
`127.0.0.1:8080` — deliberately not exposed beyond the machine. Three steps:

1. **Set the admin token** (required before any exposure): in `.env`, set
   `NOVA_AUTH_TOKEN` (e.g. `openssl rand -hex 24`), then
   `docker compose up -d backend web`. The token is for **remote devices
   only** — browsers on the Nova machine itself stay tokenless (set
   `NOVA_TRUST_LOCALHOST=false` to change that, e.g. if a host-side
   public tunnel points at :8080). Phones never type it either: once
   exposed, open **Settings → Phone setup** on the desktop and scan the
   QR — it carries the token in the URL fragment (never crosses the
   network, scrubbed from the address bar after login).
2. **Expose it privately with Tailscale** (recommended). Two ways:

   **The sidecar (easiest — identical on WSL2/Linux/macOS, no host
   install):** Nova joins your tailnet as its own node.
   1. Grab an auth key: https://login.tailscale.com/admin/settings/keys
      (defaults are fine; the key is consumed once — identity then lives
      in the `tailscale_state` volume).
   2. Put it in `.env` as `TS_AUTHKEY=tskey-auth-...`
   3. `docker compose --profile tailscale up -d`
   4. Nova is at `https://nova.<tailnet>.ts.net`. One-time tailnet
      prerequisite: MagicDNS + HTTPS certificates enabled in the admin
      console (Settings → DNS) — that's where the valid cert comes from,
      and iOS refuses to install PWAs without HTTPS.

   **Host-side Tailscale** (if you already run it): any node that can
   reach `127.0.0.1:8080` runs `tailscale serve --bg 8080`, and Nova
   appears at `https://<machine>.<tailnet>.ts.net`. Per platform:

   - **Linux**: `curl -fsSL https://tailscale.com/install.sh | sh`, then
     `sudo tailscale up`, then `tailscale serve --bg 8080`. Done.
   - **macOS**: install the Tailscale app (App Store or
     `brew install --cask tailscale`), sign in, then
     `tailscale serve --bg 8080` (App Store build: the CLI lives at
     `/Applications/Tailscale.app/Contents/MacOS/Tailscale` — alias it).
     Otherwise identical to Linux.
   - **Windows + WSL2** — two ways; the Windows-side one is simpler:
     1. *Tailscale on Windows (recommended)*: install the
        [Windows client](https://tailscale.com/download/windows), sign in,
        then in PowerShell: `tailscale serve --bg 8080`. This works
        because WSL2 forwards ports listening inside the distro to
        Windows `localhost` — verify first that
        `http://localhost:8080` opens in your Windows browser; if it
        doesn't, check `localhostForwarding` in `.wslconfig` (on by
        default).
     2. *Tailscale inside WSL2*: needs systemd — in `/etc/wsl.conf` set
        `[boot]` `systemd=true`, run `wsl --shutdown` from Windows,
        reopen, then follow the Linux steps. The machine appears as its
        own tailnet node. Caveat: Nova is only reachable while the distro
        is running (true of the docker stack anyway).

   Check what's being served with `tailscale serve status`.
3. **Put the phone on the tailnet**: install the Tailscale app on the
   phone and sign into the same account — without this the `ts.net` URL
   won't resolve at all.
4. **Install on the phone**: open the URL, enter the token, then
   Add to Home Screen (iOS: share sheet; Android: install prompt). The
   service worker caches the app shell only — chat needs the network and
   doesn't pretend otherwise.

Why Tailscale is the recommendation and not a built-in: reachability is
deployment, not app code — Nova's job is to be safe when exposed (token
auth, localhost-only binds) and origin-agnostic; the transport is yours.
Tailscale fits the product principles best (private by default — nothing
public, TLS for free, zero server config). If you need public access
instead, **Cloudflare Tunnel** (`cloudflared tunnel --url
http://127.0.0.1:8080`) works identically — the app doesn't care, but then
the token is all that stands between Nova and the internet, so treat it
accordingly.

## Where memory lives

Nova's memory is plain markdown under `./data/memory/` — human-readable,
hand-editable, no lock-in. Point it anywhere with `NOVA_MEMORY_DIR` in
`.env` (a NAS mount, an **Obsidian vault** folder, another disk): the
files are ordinary notes with frontmatter, the BM25 index rescans on
startup and reindexes on write, and edits made outside Nova are picked up
on the next restart. Cloud sync is deliberately not built in yet — see the
roadmap for the local-first sync pipeline design.

## What works (all live-verified)

| Capability | How |
|---|---|
| Streamed chat, one continuous session | SSE from `POST /api/v1/chat/stream`; history in Postgres, survives restarts |
| Agent index + dispatch | `agents` table; main agent uses `list_agents` / `dispatch_to_agent`; sub-agents run with their own tools (depth capped at 1) |
| **Agent creation at runtime** | ask for a capability → main dispatches to `agent-creator` → `manage_agents` inserts a row → usable immediately |
| **Tool creation at runtime, no restart** | `tool-creator` writes declarative `http_call` specs to the `tools` table; a generic executor runs them against an operator host-allowlist (checked at create AND execute) |
| **Skills** | `skill-manager` writes `skills/*.md`; BM25 retrieval injects applicable skills into agent prompts; behavior demonstrably follows them |
| Memory | OKF-style markdown files + in-process BM25 (no embeddings); topics/journals/skills; recall survives full `docker compose down && up --build` |
| Brain view | d3-force canvas of the real memory graph (teal topics, amber skills, dim journals), refreshes every 20s; renderers live behind a theme registry (`frontend/src/brain/theme.ts`) |
| **Hot-swappable bundled inference** | Settings → Inference toggle starts/stops the bundled Ollama container via the `inference-control` sidecar — the only holder of the docker socket, exposing a fixed-verb start/stop/status API on the compose network only |
| **Operator edit mode** | `ui.edit_mode` toggle (default off) gates manual create/edit/delete of agents, automations, rules, and tools — enforced at the API layer; view + enable/disable always work; Nova's own manage_* tools are unaffected |

Seeded system agents (`is_system`, disable-able but never deletable): `main`,
`agent-manager`, `agent-creator`, `skill-manager`, `tool-creator`.

## Architecture

Compose services: **postgres** (16-alpine), **backend** (FastAPI + asyncpg),
**frontend** (Vite/React/Tailwind), **searxng** (keyless web search),
**inference-control** (docker-socket sidecar: start/stop/status of the
bundled ollama, nothing else), and optional **ollama** (`inference`
profile, toggleable from Settings). Memory is an in-process library over
`./data/memory/*.md` (git-friendly, human-readable). LLM routing is a
prefix on the agent's model string: `openrouter:<model>` or `ollama:<model>`.

```
backend/app/
├── llm/            openai_compat.py (one streaming client), router.py
├── agents/         registry.py (CRUD), runner.py (bounded tool loop + inline dispatch)
├── tools/          registry.py (builtins + DB tools, one dispatch point),
│                   builtin.py, http_executor.py (allowlisted, capped)
├── memory/         store.py (OKF markdown), index.py (BM25), memory.py (facade)
├── conversations.py, router_chat.py (SSE), migrations/*.sql (auto-run)
frontend/src/
├── pages/Brain.tsx  brain/graph2d.ts  brain/theme.ts  chat/ChatPanel.tsx  api.ts
```

## SSE contract

```
data: {"meta": {"conversation_id": ..., "model": ...}}
data: {"t": "text delta"}
data: {"activity": {"kind": "tool_start|tool_result|dispatch", "name": ..., "agent": ..., "detail": ...}}
data: {"error": "..."}
data: [DONE]
```

## Deliberate v1 boundaries

- Single operator, localhost — no auth/users/tenancy
- Dispatch depth capped at 1 (no recursive delegation)
- Tool creation limited to allowlisted `http_call` specs — no code generation/execution
- No guardrail layer; agent-created prompts/tools are trusted-operator content
- One brain theme (2D force graph); more register via `THEMES` without touching Brain.tsx
