# Chat Bridge Service Design

**Date:** 2026-03-07
**Status:** Approved

## Overview

A single `chat-bridge` service with platform adapter plugins for integrating external chat platforms (Telegram, Slack, Discord, etc.) with Nova. Each adapter is a small Python module that translates platform-specific events into Nova's message format and sends responses back in the platform's native formatting.

## Architecture

```
Telegram webhook ──> +---------------------+
                     |   chat-bridge       |
Slack events    ──>  |   (port 8090)       | ──> orchestrator /api/v1/tasks/stream
                     |                     |
Discord (later) ──>  |  adapters/          | ──> Redis db4 (session mapping)
                     |   telegram.py       |
WhatsApp (later)──>  |   slack.py          |
                     +---------------------+
```

### Why One Service, Not One Per Platform

- Shared session management, auth, error handling, config
- One container, one port, one healthcheck (resource-efficient)
- Adding a new platform = one new adapter file
- Consistent behavior across all platforms

## Directory Structure

```
chat-bridge/
├── Dockerfile
├── pyproject.toml
└── app/
    ├── __init__.py
    ├── main.py              # FastAPI app, health endpoints, adapter registration
    ├── config.py            # BaseSettings — tokens, orchestrator URL
    ├── bridge.py            # Core bridge logic: session mapping, orchestrator calls
    └── adapters/
        ├── __init__.py
        ├── base.py          # Abstract adapter interface
        ├── telegram.py      # Telegram Bot API (python-telegram-bot)
        └── slack.py         # Slack Events API (slack-bolt)
```

## Core Bridge Flow

```
Platform event arrives (webhook or bot poll)
  -> adapter.normalize(event)
  -> bridge.get_or_create_session(platform, platform_id)
      Redis: nova:bridge:{platform}:{platform_id} -> session_id
      If new: create agent via POST /api/v1/agents
  -> bridge.send_to_orchestrator(session_id, agent_id, message)
      POST /api/v1/tasks/stream (SSE)
      Collect full response (consume until [DONE])
  -> adapter.send_response(platform_meta, response_text)
```

## Adapter Interface

Each adapter implements:

- `setup(app)` — register webhook routes or start bot polling
- `normalize(event) -> (session_key, message_text, platform_meta)` — parse platform event
- `send_response(platform_meta, text)` — send formatted response back
- `platform_name` — `"telegram"` / `"slack"`

## Session Management

- Redis db4, key pattern: `nova:bridge:{platform}:{platform_id}`
- Value: JSON with `session_id`, `agent_id`, `created_at`
- TTL: 7 days (matches chat-api session TTL)
- Session includes agent creation via `POST /api/v1/agents`

## Platform Adapters

### Telegram (Phase 1)

- Library: `python-telegram-bot`
- Webhook mode when `TELEGRAM_WEBHOOK_URL` is set (production)
- Polling mode as fallback (development)
- Maps `chat_id` -> Nova session
- Sends typing indicator while waiting for response
- Formats response with Telegram MarkdownV2
- Slash commands: `/new` (new session), `/model` (switch model), `/status`

### Slack (Phase 2)

- Library: `slack-bolt`
- Socket Mode via `SLACK_APP_TOKEN` (no public URL needed)
- Maps `channel_id + thread_ts` -> Nova session (each thread = conversation)
- DMs supported (channel = DM channel ID)
- Formats with Slack mrkdwn (code blocks, bold, links)
- Responds when @mentioned or in DM

## Authentication

- Bridge creates/retrieves a system API key on startup (stored in Redis)
- Uses this key for all orchestrator calls (`X-API-Key` header)
- Platform tokens via `.env`: `TELEGRAM_BOT_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`

## Docker Integration

```yaml
chat-bridge:
  <<: *nova-common
  profiles: ["bridges"]
  build:
    context: .
    dockerfile: chat-bridge/Dockerfile
  ports:
    - "8090:8090"
  environment:
    ORCHESTRATOR_URL: http://orchestrator:8000
    REDIS_URL: redis://redis:6379/4
    NOVA_API_KEY: ${NOVA_API_KEY:-}
    TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN:-}
    TELEGRAM_WEBHOOK_URL: ${TELEGRAM_WEBHOOK_URL:-}
    SLACK_BOT_TOKEN: ${SLACK_BOT_TOKEN:-}
    SLACK_APP_TOKEN: ${SLACK_APP_TOKEN:-}
  depends_on:
    orchestrator:
      condition: service_healthy
    redis:
      condition: service_healthy
```

Adapters auto-enable based on which tokens are present. Zero overhead if no tokens configured.

## Dashboard Settings Integration

Add a "Chat Platforms" section in Settings:
- Toggle per platform (enabled/disabled)
- Token input fields (masked, reveal-on-click)
- Connection status indicator
- "Test Connection" button

## Streaming Strategy

v1 uses wait-and-send: consume the full SSE stream from orchestrator, then send the complete response to the platform. Progressive message editing (Telegram `editMessageText`, Slack block updates) deferred to v2.

## Not in v1

- No message editing/updating during streaming
- No file/image handling (text only)
- No multi-user awareness (single-tenant)
- No outbound notifications (Nova-initiated messages — Phase 9)
- No conversation history display (platform shows its own history)

## Implementation Phases

1. **Phase 1**: Core framework + Telegram adapter
2. **Phase 2**: Slack adapter
3. **Phase 3**: Dashboard Settings UI for platform management
4. **Future**: Discord, WhatsApp, Matrix adapters

## Key References

- `chat-api/` — existing chat service pattern (Dockerfile, config, session management)
- `orchestrator/app/router.py` — streaming endpoint (`POST /api/v1/tasks/stream`)
- SSE format: `data: {delta}\n\n` chunks, terminated by `data: [DONE]\n\n`
- Redis allocation: db0=memory, db1=llm-gateway, db2=orchestrator, db3=chat-api, **db4=chat-bridge**
