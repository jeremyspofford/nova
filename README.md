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

### Bring your own provider / key

OpenRouter is just the batteries-included default. **Settings → Models →
Providers** lets you add any OpenAI-compatible provider with your own key —
OpenAI, Anthropic, Gemini, Groq, HuggingFace, Together, DeepSeek, Mistral, xAI,
a local **LM Studio** / **vLLM** server (`http://host.docker.internal:<port>/v1`,
no key needed), or a custom URL. Pick a preset, paste the key, hit **test**.
The provider's models then appear in **Settings → Models → Full catalog**, where
one **approved** toggle puts a model into the agent and chat dropdowns. A model
is addressed as `<provider-slug>:<model-id>` (e.g. `openai:gpt-5.1`); keys are
stored server-side and never shown again. Note that Anthropic and Gemini are
reached through their OpenAI-compatibility endpoints, and are also available
through OpenRouter with no extra setup.

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

## Model storage (external drive / shared)

By default the bundled model weights live in docker-managed volumes on your
system disk. To move them onto an external SSD, a NAS mount, or a bigger disk —
to reclaim space or share one store across machines — open **Settings →
Inference → Model storage**, enter an absolute host path, and Save. Nova
migrates the existing models (the old copy is kept until you remove it),
recreates the services bound to the new path, and comes back running. This
covers the Ollama LLM store plus the Kokoro/Whisper **voice** models whenever
the voice profile is running. No files to edit, no restart of the rest of the
stack. Clear the field to return to the default volumes; the current location
also shows in **Settings → Storage**. The weights lay out as
`$PATH/{ollama,kokoro,whisper}`.

Under the hood the chosen path is handed to the `inference-control` sidecar
(the only holder of the docker socket) through a **read-only** control file —
the socket-holder never takes a path from the network, so a compromised chat
client still can't set one. Migration is non-destructive: the old store is
copied, never deleted, and pointing at an already-populated location just
adopts it. Sharing one path between machines works read-mostly — don't pull
models from two machines at once, as Ollama's content-addressed blob store
isn't built for concurrent writers. (A service relocates when it's running; if
you start the voice profile *after* relocating, re-Save to move it too.)

### Advanced: relocate every model at the compose level

The `docker-compose.models.yml` override can move **all** bundled weights
(Ollama + Kokoro voice + Whisper STT) at deploy time. Set `NOVA_MODELS_DIR` to
an absolute path — it lays out `$NOVA_MODELS_DIR/{ollama,kokoro,whisper}` — and,
for host-launched services (the `voice` profile or a manual `docker compose
up`), add the override to `COMPOSE_FILE`, chaining with `:`:

```
COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml:docker-compose.models.yml
```

The **Settings → Inference** control above takes precedence over
`NOVA_MODELS_DIR` for the Ollama store.

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

## Files (Library → Files)

A tree over the three places Nova keeps things. Folders expand in place —
they are never entered, so the path you are reading is always the whole
path — and double-clicking a **file** opens it in the editor beside the
tree. `Ctrl`/`Cmd`-`S` saves; the arrow keys walk the tree.

On a phone the two panes take turns instead of sharing the width, and a
single **tap** opens a file, because touch has no double-click.

| Root | Path | What you can do |
|---|---|---|
| **Memory** | `./data/memory` | Read and edit notes, create and delete them in `topics/`, `skills/`, `sources/` |
| **Workspace** | `./data/workspace` | Anything: nested folders, any file type. Scratch space, browsable and editable from the phone |

Attachments are deliberately not a root: they are content-addressed blobs
with no filename on disk, so there is no address space to browse, and
Library → Documents already shows them with more detail than a faked tree
could.

Three things are refused on purpose, and each says so in a sentence rather
than greying out a button:

- **A save writes exactly the bytes you typed.** Editing does *not* go
  through the memory write path, whose link pass adopts corpus tags into
  frontmatter, appends a `Related:` line and restamps `timestamp` —
  measured at 203 of 214 topics changed by a save with *no* edits. The
  index is updated separately, so search stays consistent.
- **Changing a note's title takes its inbound links with it.** A `[[link]]`
  resolves by title, so renaming the *file* is harmless but retitling the
  *note* would orphan every link pointing at it — one source note carries
  60. The editor shows the inbound count in the header before you type, and
  a retitle that would break links refuses until you choose: move the links
  to the new title, or turn them into the plain text they already displayed.
  Only the *other* notes are rewritten, and their mtimes are preserved — a
  mechanical repair is not new knowledge and must not trip the recency cues
  that drive the universe view. Deleting a note already de-referenced its
  inbound links; this is the same policy reaching the second door.

- **Memory has no subfolders.** The store globs `<type-dir>/*.md` exactly
  one level deep, so a folder made there would hold notes she could never
  find. `journals/` is append-only (it is the record of what happened) and
  `soul.md` is edited in Settings, where it is kept in sync with the
  persona.
- **Nova's own source code is not a root.** A file manager over the
  checkout would be a second, unreviewed way to rewrite `consents.py` and
  `rules.py`; source changes go through the coder sidecar and its review.
  `.env`, the k8s ServiceAccount token in `data/runtime`, and the
  voiceprint clips in `data/wake-training` are excluded for the same kind
  of reason. A path is reachable only if it resolves inside a declared
  root, so exposing a new place is a deliberate edit, never a forgotten
  exclusion.

## The Vault

Her notes are already a vault: `./data/memory` is markdown with frontmatter,
`tags: [a, b, c]` and `[[wikilinks]]`, and `NOVA_MEMORY_DIR` can point at an
Obsidian folder. **Vault** is where you read it that way — a top-level view
beside the Library, over the same two roots.

It answers the three questions a file manager cannot:

- **`[[Links]] are links.`** Click one and it opens the note it names. A link
  that resolves to nothing renders amber and says so rather than being a dead
  click. The **Links** pane lists what points *here*, what this points at, and
  what points nowhere.
- **Tags are an index.** Every tag, ordered by how many notes carry it. Pick
  one and the tree and the graph both narrow to its members.
- **The corpus has a shape.** A 2D force graph, either the open note's
  neighbourhood (one hop or two) or all 262 notes at once. Click a star to open
  it.

Three things it does deliberately, each because the alternative would lie:

- **Links resolve by TITLE, never by filename** — the opposite of Obsidian's
  default, and it is why the note pane, the graph and the backlinks all label
  by title with the path underneath. The tree still shows filenames, because a
  tree is a view of the disk.
- **`[[a|b]]` and `[[a#h]]` are not parsed.** Two live titles contain a literal
  `|`; teaching the renderer about aliases would show links that resolve
  differently from the ones a retitle rewrites.
- **A `[[link]]` in a Workspace file is not a link.** The rewriter only walks
  the memory store, so a retitle would never carry it, and it would rot
  silently. The Vault refuses to render what the rewriter cannot maintain, and
  says so in the Links pane instead of showing an empty box.

Editing goes through the same write path as Library → Files — the same
byte-faithful save, the same `Ctrl`/`Cmd`-`S`, and the same dialog when a
retitle would orphan inbound links. One write path, one refusal vocabulary.

On a phone the panes take turns: the tree, then the note, with the graph and
the links as sheets over it that the back gesture closes without leaving the
note.

## MCP servers (connect Nova to the tool ecosystem)

Nova is an MCP (Model Context Protocol) client — Settings → Tools → **MCP
servers** registers third-party tool servers instead of hand-authoring
each integration. Registration is operator-only (`ui.edit_mode`, no
agent-facing equivalent — an agent that could register a server could
grant itself arbitrary capabilities) and nothing is granted to any agent
automatically: after registering, add `mcp:<name>/<tool>` (one tool) or
`mcp:<name>:*` (all of a server's tools) to an agent's allowed-tools field.
A server's tool descriptions are hashed at approval time; if they change
later the server flips to `error` and stops serving until reviewed again
in Settings (tool-description poisoning defense).

Two transports: `http` (streamable-HTTP, connects directly) and `stdio`
(spawned as a subprocess by the `mcp-runner` sidecar — no Docker socket,
no DB credentials, no published ports; every command it runs came from an
edit_mode-gated registration, never from an agent or the network).

A few servers worth trying, none pre-registered — fill in your own
path/token and `POST` to `/api/v1/mcp/servers` with edit mode on (or use
the Settings UI form directly):

```bash
# Filesystem — scope it to a scratch mount, not your whole disk
curl -X POST $NOVA_URL/api/v1/mcp/servers -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"filesystem","transport":"stdio","command":"npx",
       "args":["-y","@modelcontextprotocol/server-filesystem","/path/to/scratch/dir"]}'

# Home Assistant — needs a long-lived access token from your HA profile
curl -X POST $NOVA_URL/api/v1/mcp/servers -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"home-assistant","transport":"http",
       "url":"http://homeassistant.local:8123/mcp_server/sse",
       "headers":{"Authorization":"Bearer <your-ha-token>"}}'

# A keyless fetch-class reference server (good for a first try)
curl -X POST $NOVA_URL/api/v1/mcp/servers -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"everything","transport":"stdio","command":"npx",
       "args":["-y","@modelcontextprotocol/server-everything"]}'
```

Then `PATCH .../{id}` with `{"enabled": true}` to connect, and grant it to
an agent. See `docs/plans/mcp-client.md` for the full design.

## What works (all live-verified)

| Capability | How |
|---|---|
| Streamed chat, one continuous session | SSE from `POST /api/v1/chat/stream`; history in Postgres, survives restarts |
| Agent index + dispatch | `agents` table; main agent uses `list_agents` / `dispatch_to_agent`; sub-agents run with their own tools (depth capped at 1) |
| **Agent creation at runtime** | ask for a capability → main dispatches to `agent-creator` → `manage_agents` inserts a row → usable immediately |
| **Tool creation at runtime, no restart** | `tool-creator` writes declarative `http_call` specs to the `tools` table; a generic executor runs them against an operator host-allowlist (checked at create AND execute) |
| **Skills** | `skill-manager` writes `skills/*.md`; BM25 retrieval injects applicable skills into agent prompts; behavior demonstrably follows them |
| Memory | OKF-style markdown files + in-process BM25 (no embeddings); topics/journals/skills; recall survives full `docker compose down && up --build` |
| Brain view | d3-force canvas of the real memory graph (teal topics, amber skills, dim journals), refreshes every 20s; renderers live behind a theme registry (`frontend/src/brain/theme.ts`). Settings → Appearance picks between **Graph** (2D), **Galaxy**, **Universe** (orrery: Nova a star, topics planets, automations comets), **Nova Universe (2)** (Three.js star field — every node a star, clusters found by a force layout and named in place), and **Nova** (presence only) |
| **Hot-swappable bundled inference** | Settings → Inference toggle starts/stops the bundled Ollama container via the `inference-control` sidecar — the only holder of the docker socket, exposing a fixed-verb start/stop/status API on the compose network only |
| **Operator edit mode** | `ui.edit_mode` toggle (default off) gates manual create/edit/delete of agents, automations, rules, and tools — enforced at the API layer; view + enable/disable always work; Nova's own manage_* tools are unaffected |
| **MCP client** (HTTP + stdio) | Settings → Tools → MCP servers; operator-registered, hash-approved tool descriptions, lazy loading (`find_mcp_tools`) for grants not marked always-on; stdio servers run via the `mcp-runner` sidecar |
| **Files explorer** | Library → Files; expand-in-place tree over the memory store and a workspace, with a byte-faithful editor. Reachable paths are an allowlist of declared roots resolved through `realpath`, so a symlink cannot read out of one |
| **The Vault** | A top-level view over the same two roots, but arranged around the questions a file manager cannot answer: `[[wikilinks]]` are clickable, a Links pane names what points here, a tag browser filters 465 tags by how many notes carry them, and a 2D force graph draws the corpus locally or whole. It shares one write path with Library → Files, so there is one retitle dialog and one refusal vocabulary |
| **She can see what is failing** | `diagnose` carries a failure census discovered from `information_schema` on every call — the background queues (ingestion, automations, evals, MCP servers, alerts, push endpoints) whose failures never reach the turn ledger. A failure-shaped table that the census does not understand makes the report `INCOMPLETE` and reddens `test_failure_census.py`, so a new queue cannot silently read as healthy. Counts ride in her prompt each turn; `retry_ingest_job` gives her one re-queue per job, budgeted in a `WHERE` clause |

Seeded system agents (`is_system`, disable-able but never deletable): `main`,
`agent-manager`, `agent-creator`, `skill-manager`, `tool-creator`.

## Architecture

Compose services: **postgres** (16-alpine), **backend** (FastAPI + asyncpg),
**frontend** (Vite/React/Tailwind), **searxng** (keyless web search),
**inference-control** (docker-socket sidecar: start/stop/status of the
bundled ollama, nothing else), **mcp-runner** (stdio MCP sidecar: spawns
operator-registered MCP servers as subprocesses, no published ports), and
optional **ollama** (`inference` profile, toggleable from Settings). Memory is an in-process library over
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
