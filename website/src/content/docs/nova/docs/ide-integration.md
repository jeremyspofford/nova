---
title: "IDE Integration"
description: "Use Nova as an OpenAI-compatible backend in your IDE."
---

Nova exposes an OpenAI-compatible API on the LLM Gateway (`http://localhost:8001/v1`). Any tool that speaks the OpenAI chat completions protocol works out of the box.

## Continue.dev (VS Code / JetBrains)

### Quick start

1. Install the [Continue extension](https://marketplace.visualstudio.com/items?itemName=Continue.continue)
2. Open the config: **Cmd+Shift+P** > `Continue: Open config.yaml`
3. Add an entry to the `models` list:

```yaml
models:
  - name: Nova (Default)
    provider: openai
    model: qwen2.5:7b
    apiBase: http://localhost:8001/v1
    roles:
      - chat
      - edit
```

`apiBase` is the only thing that matters -- it redirects traffic from `api.openai.com` to Nova.

### Recommended model set

Add multiple entries to switch models from the Continue sidebar. Use `roles` to assign each model to specific tasks:

```yaml
models:
  - name: "Nova: Qwen 1.5B (fast)"
    provider: openai
    model: qwen2.5:1.5b
    apiBase: http://localhost:8001/v1
    roles:
      - chat
      - edit
      - apply
  - name: "Nova: Qwen 7B (default)"
    provider: openai
    model: qwen2.5:7b
    apiBase: http://localhost:8001/v1
    roles:
      - chat
      - edit
      - apply
  - name: "Nova: Hermes 3 (tool-calling)"
    provider: openai
    model: hermes3:8b
    apiBase: http://localhost:8001/v1
    roles:
      - chat
      - edit
  - name: "Nova: GPT-4o"
    provider: openai
    model: openai/gpt-4o
    apiBase: http://localhost:8001/v1
    roles:
      - chat
      - edit
```

### Verify available models

```bash
curl http://localhost:8001/v1/models | jq '.data[].id'
```

Returns all registered model IDs.

### With API key auth enabled

If `REQUIRE_AUTH=true`, create a key first:

```bash
curl -X POST http://localhost:8000/api/v1/keys \
  -H "X-Admin-Secret: your-admin-secret" \
  -H "Content-Type: application/json" \
  -d '{"name": "continue-dev", "rate_limit_rpm": 120}'
```

Then add `apiKey` to your model entries:

```yaml
models:
  - name: Nova (Default)
    provider: openai
    model: qwen2.5:7b
    apiBase: http://localhost:8001/v1
    apiKey: sk-nova-your-key-here
    roles:
      - chat
      - edit
```

## Cursor

Same approach -- Cursor supports custom OpenAI-compatible endpoints:

1. **Settings** > **Models** > **Add model**
2. Set **Base URL** to `http://localhost:8001/v1`
3. Set **API Key** to any placeholder
4. Use any Nova model ID as the model name

## Aider (terminal)

```bash
aider \
  --openai-api-base http://localhost:8001/v1 \
  --openai-api-key unused \
  --model qwen2.5:7b
```

## Raw API (curl / scripts)

```bash
curl http://localhost:8001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen2.5:7b",
    "messages": [{"role": "user", "content": "Hello from Nova"}]
  }'
```

## How it works

```
IDE / tool
    |  POST /v1/chat/completions  (OpenAI format)
    v
LLM Gateway  :8001
    |  translates OpenAI -> Nova internal format
    |  forwards to registered provider (Anthropic, OpenAI, Ollama, ...)
    v
Provider API
    |  response
    v
LLM Gateway
    |  translates provider response -> OpenAI format
    v
IDE / tool  <-- looks identical to talking directly to OpenAI
```

The translation lives in `llm-gateway/app/openai_compat.py`.
