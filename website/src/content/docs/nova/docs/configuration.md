---
title: "Configuration"
description: "Environment variables, provider API keys, model routing, and context budgets."
---

Nova is configured primarily through a `.env` file and a `models.yaml` file. Run `./install` for interactive configuration, or edit these files manually.

## Environment file

Copy `.env.example` to `.env` and edit:

```bash
cp .env.example .env
```

### Core settings

| Variable | Description | Default |
|----------|-------------|---------|
| `POSTGRES_PASSWORD` | Database password (required) | *(empty -- set during setup)* |
| `NOVA_ADMIN_SECRET` | Secret for admin API access via `X-Admin-Secret` header | `nova-admin-secret-change-me` |
| `LOG_LEVEL` | Logging verbosity | `INFO` |
| `REQUIRE_AUTH` | Require API key for all requests | `false` |
| `SHELL_TIMEOUT_SECONDS` | Timeout for shell command execution | `30` |

### Deployment mode

| Variable | Description | Default |
|----------|-------------|---------|
| `COMPOSE_PROFILES` | Comma-separated Docker Compose profiles (e.g., `local-ollama`, `local-vllm`) | *(empty)* |
| `OLLAMA_BASE_URL` | URL for remote Ollama instance | *(empty)* |
| `LLM_ROUTING_STRATEGY` | Model routing strategy (see below) | `local-first` |
| `DEFAULT_CHAT_MODEL` | Default model for chat interactions | `llama3.2` |

## Inference backends (the pool)

Local inference is a **pool of named backends** stored as JSON in Redis (`nova:config:inference.backends`) and managed from the dashboard's Models page (Backend pool card). Each entry is `{id, kind: container|remote, engine, url, enabled, auth_header}`; multiple containers and multiple user-named remotes (`remote-vllm-a`, `remote-vllm-b`) coexist. Requests route to the backend whose discovered model catalog serves the requested model; the first enabled entry is the primary fallback. Changes take effect immediately -- no restart required.

| Key | Description | Default |
|-----|-------------|---------|
| `inference.backends` | JSON list of named backend entries -- the canonical pool the gateway routes over. Seeded automatically from the legacy scalar keys on first boot after upgrade. | *(seeded)* |
| `inference.state` | Pool-wide acceptance state: `ready`, `draining`, `starting`, `error` | `ready` |
| `inference.backend` / `inference.url` | Legacy scalar mirrors of the primary selection -- still written for older readers, no longer used for routing once the pool is seeded | *(empty)* |

The setup script runs hardware detection and writes results to `data/hardware.json`. The recovery service syncs this to Redis on startup. The dashboard shows the detected hardware and recommends a backend based on GPU availability.

### Wake-on-LAN (remote GPU)

| Variable | Description |
|----------|-------------|
| `WOL_MAC_ADDRESS` | MAC address of the remote GPU machine |
| `WOL_BROADCAST_IP` | Broadcast IP for Wake-on-LAN packets |

### CORS

| Variable | Description |
|----------|-------------|
| `CORS_ALLOWED_ORIGINS` | Comma-separated origins (default covers local dev ports) |

## Provider API keys

Nova supports many LLM providers. Configure the ones you want to use:

### Subscription providers (use your existing subscription)

| Variable | Provider | Setup |
|----------|----------|-------|
| `CHATGPT_ACCESS_TOKEN` | ChatGPT Plus/Pro | Run: `codex login` |

### Free tier providers (no credit card required)

| Variable | Provider | Sign up |
|----------|----------|---------|
| `GROQ_API_KEY` | Groq | [console.groq.com](https://console.groq.com) |
| `CEREBRAS_API_KEY` | Cerebras | [cloud.cerebras.ai](https://cloud.cerebras.ai) |
| `GEMINI_API_KEY` | Gemini | [aistudio.google.com](https://aistudio.google.com) |
| `OPENROUTER_API_KEY` | OpenRouter | [openrouter.ai](https://openrouter.ai) |
| `GITHUB_TOKEN` | GitHub Models | [github.com/settings/tokens](https://github.com/settings/tokens) |

### Paid API providers (billed per token)

| Variable | Provider | Sign up |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | Anthropic | [console.anthropic.com](https://console.anthropic.com) |
| `OPENAI_API_KEY` | OpenAI | [platform.openai.com](https://platform.openai.com) |

### Per-provider default models (optional)

Override the default model for each provider:

| Variable | Example |
|----------|---------|
| `DEFAULT_OLLAMA_MODEL` | `llama3.2` |
| `DEFAULT_GROQ_MODEL` | `groq/llama-3.3-70b-versatile` |
| `DEFAULT_GEMINI_MODEL` | `gemini/gemini-2.5-flash` |
| `DEFAULT_CEREBRAS_MODEL` | `cerebras/llama3.1-8b` |
| `DEFAULT_CHATGPT_MODEL` | `chatgpt/gpt-4o` |
| `DEFAULT_OPENROUTER_MODEL` | `openrouter/meta-llama/llama-3.3-70b-instruct:free` |
| `DEFAULT_GITHUB_MODEL` | `github/gpt-4o-mini` |

## Voice

The voice service is optional. Enable it with `docker compose --profile voice up`.

| Variable | Description | Default |
|----------|-------------|---------|
| `STT_PROVIDER` | Speech-to-text provider (`openai`, `deepgram`) | `openai` |
| `TTS_PROVIDER` | Text-to-speech provider (`openai`, `elevenlabs`) | `openai` |
| `TTS_VOICE` | Default TTS voice | `nova` |
| `TTS_MODEL` | TTS quality (`tts-1` fast, `tts-1-hd` quality) | `tts-1` |
| `DEEPGRAM_API_KEY` | API key for Deepgram STT | *(optional)* |
| `ELEVENLABS_API_KEY` | API key for ElevenLabs TTS | *(optional)* |

Voice uses the same `OPENAI_API_KEY` as the LLM provider section. All voice settings are also runtime-configurable from Dashboard > Settings > Voice.

## Remote access

Nova supports two options for accessing the dashboard remotely:

| Option | Variable | Description |
|--------|----------|-------------|
| **Cloudflare Tunnel** | `CLOUDFLARE_TUNNEL_TOKEN` | Browser access from anywhere with automatic HTTPS. Add `cloudflare-tunnel` to `COMPOSE_PROFILES`. |
| **Tailscale** | `TAILSCALE_AUTHKEY` | Fully private VPN mesh with encrypted WireGuard tunnel. Add `tailscale` to `COMPOSE_PROFILES`. |

## models.yaml

The `models.yaml` file defines which Ollama models to auto-pull on startup when running with a local Ollama instance. Edit this file to control which models are available locally.

## LLM routing strategies

The `LLM_ROUTING_STRATEGY` variable controls how Nova selects between local and cloud providers:

| Strategy | Behavior |
|----------|----------|
| `local-only` | Only use the active local inference backend. Fail if none is available. |
| `local-first` | Try the local backend first, fall back to cloud providers. |
| `cloud-only` | Only use cloud API providers. Skip local inference. |
| `cloud-first` | Try cloud first, fall back to the local backend. |

This setting is runtime-configurable from the dashboard Settings page.

## Platform identity

These settings are managed from the dashboard Settings page (Nova Identity section) and stored in the `platform_config` table. They control how the AI presents itself.

| Key | Description | Default |
|-----|-------------|---------|
| `nova.name` | Display name used in the system prompt, toolbar, and chat UI | `Nova` |
| `nova.persona` | Personality guidelines injected into the system prompt's `## Identity` block. Defines communication style, tone, and character. Two-way synced with Nova's soul: the memory bundle's `self/soul.md` (the Brain graph's anchor node) carries this text as its body — edit in Settings or in the soul file, both stay consistent. | *(empty)* |
| `nova.greeting` | Opening message shown in the Chat page before the user types. Supports `{name}` placeholder which auto-resolves to the current name. | `Hello! I'm {name}. I have access to your workspace...` |

Changes take effect immediately -- no restart required. The AI's system prompt is assembled dynamically:

1. **Identity** -- name and persona from `nova.name` + `nova.persona`
2. **Platform Context** -- model, tools, active agents
3. **Response Style** -- formatting rules
4. **Memories** -- relevant context from previous conversations

## Context compaction

When a pipeline run's accumulated state grows past a threshold fraction of the context window, the orchestrator summarizes prior stage outputs into a compact string so later stages keep room to work.

| Key | Description | Default |
|-----|-------------|---------|
| `context.compaction_threshold` | Fraction of the context window at which pipeline state is compacted. Configured from Settings (AI & Pipeline → Context); stored in `platform_config`. | `0.80` |
