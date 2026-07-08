---
title: "API Reference"
description: "REST and WebSocket endpoints for all Nova services."
---

This page documents the key API endpoints across Nova's services. All services also expose interactive Swagger docs at `/docs` on their respective ports.

## Authentication

Nova supports two authentication methods:

### Admin secret

Used for privileged operations (key management, service configuration, pod management). Pass via header:

```
X-Admin-Secret: your-admin-secret
```

### API key

Used for standard operations (task submission, agent interaction, memory queries). Pass via header:

```
Authorization: Bearer sk-nova-...
```

or:

```
X-API-Key: sk-nova-...
```

When `REQUIRE_AUTH=false` (the default for development), API key authentication is bypassed.

---

## Orchestrator (port 8000)

### Agents

```bash
# List all agents
curl http://localhost:8000/api/v1/agents \
  -H "Authorization: Bearer sk-nova-..."

# Create an agent
curl -X POST http://localhost:8000/api/v1/agents \
  -H "Authorization: Bearer sk-nova-..." \
  -H "Content-Type: application/json" \
  -d '{"config": {"model": "qwen2.5:7b"}}'

# Update agent config (admin)
curl -X PATCH http://localhost:8000/api/v1/agents/{agent_id}/config \
  -H "X-Admin-Secret: your-secret" \
  -H "Content-Type: application/json" \
  -d '{"model": "hermes3:8b"}'
```

### Tasks (interactive)

```bash
# Submit a task (synchronous)
curl -X POST http://localhost:8000/api/v1/tasks \
  -H "Authorization: Bearer sk-nova-..." \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "...",
    "messages": [{"role": "user", "content": "Explain the auth flow"}]
  }'

# Submit a task (SSE streaming)
curl -X POST http://localhost:8000/api/v1/tasks/stream \
  -H "Authorization: Bearer sk-nova-..." \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "...",
    "messages": [{"role": "user", "content": "Explain the auth flow"}]
  }'
```

### Pipeline tasks (async queue)

```bash
# Submit to pipeline queue
curl -X POST http://localhost:8000/api/v1/pipeline/tasks \
  -H "Authorization: Bearer sk-nova-..." \
  -H "Content-Type: application/json" \
  -d '{"user_input": "Fix the login bug in auth.py"}'

# List recent tasks
curl "http://localhost:8000/api/v1/pipeline/tasks?status=running&limit=10" \
  -H "Authorization: Bearer sk-nova-..."

# Get task status
curl http://localhost:8000/api/v1/pipeline/tasks/{task_id} \
  -H "Authorization: Bearer sk-nova-..."

# Cancel a task
curl -X POST http://localhost:8000/api/v1/pipeline/tasks/{task_id}/cancel \
  -H "Authorization: Bearer sk-nova-..."

# Get guardrail findings
curl http://localhost:8000/api/v1/pipeline/tasks/{task_id}/findings \
  -H "Authorization: Bearer sk-nova-..."

# Get code review verdicts
curl http://localhost:8000/api/v1/pipeline/tasks/{task_id}/reviews \
  -H "Authorization: Bearer sk-nova-..."

# Get artifacts
curl http://localhost:8000/api/v1/pipeline/tasks/{task_id}/artifacts \
  -H "Authorization: Bearer sk-nova-..."

# Queue statistics
curl http://localhost:8000/api/v1/pipeline/queue-stats \
  -H "Authorization: Bearer sk-nova-..."
```

### Chat (admin dashboard)

```bash
# Stream chat with the primary agent (admin only)
curl -X POST http://localhost:8000/api/v1/chat/stream \
  -H "X-Admin-Secret: your-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Hello Nova"}],
    "model": "qwen2.5:7b"
  }'
```

The response is an SSE stream. Each chunk is a `data:` line containing a text delta. The stream ends with `data: [DONE]`. The `X-Session-Id` response header can be passed back in subsequent requests to continue the conversation.

### Pods

```bash
# List all pods
curl http://localhost:8000/api/v1/pods \
  -H "Authorization: Bearer sk-nova-..."

# Create a pod (admin)
curl -X POST http://localhost:8000/api/v1/pods \
  -H "X-Admin-Secret: your-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "research",
    "description": "Information gathering pod",
    "routing_keywords": ["research", "investigate"],
    "sandbox": "workspace"
  }'

# Add agent to pod (admin)
curl -X POST http://localhost:8000/api/v1/pods/{pod_id}/agents \
  -H "X-Admin-Secret: your-secret" \
  -H "Content-Type: application/json" \
  -d '{"name": "researcher", "role": "task", "model": "qwen2.5:7b"}'
```

### API keys (admin)

```bash
# Create a key (raw key shown once in response)
curl -X POST http://localhost:8000/api/v1/keys \
  -H "X-Admin-Secret: your-secret" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-app", "rate_limit_rpm": 60}'

# List keys
curl http://localhost:8000/api/v1/keys \
  -H "X-Admin-Secret: your-secret"

# Revoke a key
curl -X DELETE http://localhost:8000/api/v1/keys/{key_id} \
  -H "X-Admin-Secret: your-secret"
```

### MCP servers

```bash
# List MCP servers
curl http://localhost:8000/api/v1/mcp-servers \
  -H "Authorization: Bearer sk-nova-..."

# Register a server (admin)
curl -X POST http://localhost:8000/api/v1/mcp-servers \
  -H "X-Admin-Secret: your-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "filesystem",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
    "enabled": true
  }'

# Reload/reconnect a server
curl -X POST http://localhost:8000/api/v1/mcp-servers/{id}/reload \
  -H "X-Admin-Secret: your-secret"
```

### Identity (public)

```bash
# Get the AI's display name and greeting (no auth required)
curl http://localhost:8000/api/v1/identity
```

Returns:
```json
{
  "name": "Nova",
  "greeting": "Hello! I'm Nova. I have access to your workspace..."
}
```

The greeting supports a `{name}` placeholder that is automatically resolved to the current name. Configure the name, greeting, and persona from Settings > Nova Identity.

### Health

```bash
curl http://localhost:8000/health/live    # Liveness
curl http://localhost:8000/health/ready   # Readiness (checks DB + Redis)
```

---

## LLM Gateway (port 8001)

### OpenAI-compatible endpoints

```bash
# Chat completion (non-streaming)
curl http://localhost:8001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen2.5:7b",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# Chat completion (streaming)
curl http://localhost:8001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen2.5:7b",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'

# List available models
curl http://localhost:8001/v1/models
```

### Nova internal endpoints

```bash
# Non-streaming completion
curl -X POST http://localhost:8001/complete \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen2.5:7b",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# SSE streaming completion
curl -X POST http://localhost:8001/stream \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen2.5:7b",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# Generate embeddings
curl -X POST http://localhost:8001/embed \
  -H "Content-Type: application/json" \
  -d '{"text": "Some text to embed"}'
```

### Health

```bash
curl http://localhost:8001/health/live
curl http://localhost:8001/health/ready
```

---

## Memory Service (port 8002)

The backend-agnostic surface is `/api/v1/memory/*` (backed by the OKF markdown bundle — see [memory-service](/nova/docs/services/memory-service/)). Memory ids are bundle-relative paths, e.g. `topics/gpu-setup.md`.

```bash
# Retrieve formatted context for a query (main read path; empty query -> root index)
curl -X POST http://localhost:8002/api/v1/memory/context \
  -H "Content-Type: application/json" \
  -d '{"query": "authentication patterns"}'

# Write a durable memory (the `remember` tool path — okf metadata routes the file)
curl -X POST http://localhost:8002/api/v1/memory/ingest \
  -H "Content-Type: application/json" \
  -d '{"raw_text": "The auth module uses bcrypt.",
       "source_type": "chat",
       "metadata": {"okf": {"type": "topic", "title": "auth-hashing"}}}'

# Read / edit / delete one item (id is a bundle path)
curl http://localhost:8002/api/v1/memory/item/topics/auth-hashing.md
curl -X DELETE http://localhost:8002/api/v1/memory/item/topics/auth-hashing.md

# Provenance and store stats
curl http://localhost:8002/api/v1/memory/provenance/topics/auth-hashing.md
curl http://localhost:8002/api/v1/memory/stats
```

The dashboard **Brain** page (`/brain`) is powered by three more endpoints on the same API:

```bash
# Whole-bundle graph: nodes + wiki-link edges (the Brain page's dataset)
curl http://localhost:8002/api/v1/memory/graph

# Edit one memory in place (frontmatter shallow-merge; type is fixed)
curl -X PUT http://localhost:8002/api/v1/memory/item/topics/gpu-setup.md \
  -H "Content-Type: application/json" \
  -d '{"frontmatter": {"tags": ["gpu","wsl"]}, "content": "..."}'

# SSE stream of retrieval events — powers the Brain page's live glow
curl -N http://localhost:8002/api/v1/memory/events
```

### Health

```bash
curl http://localhost:8002/health/live
curl http://localhost:8002/health/ready
```

---

## Chat API (port 8080)

### WebSocket

Connect to `ws://localhost:8080/ws/chat` for real-time streaming chat.

With authentication: `ws://localhost:8080/ws/chat?token=sk-nova-...`

**Send a message:**
```json
{"type": "user", "content": "Hello Nova", "session_id": "optional"}
```

**Receive messages:**
```json
{"type": "system", "session_id": "abc-123"}
{"type": "stream_chunk", "delta": "Hello"}
{"type": "stream_chunk", "delta": "! How"}
{"type": "stream_chunk", "delta": " can I help?"}
{"type": "stream_end"}
```

### Health

```bash
curl http://localhost:8080/health/live
curl http://localhost:8080/health/ready
```

---

## Recovery Service (port 8888)

```bash
# System status overview
curl http://localhost:8888/api/v1/recovery/status

# List service containers
curl http://localhost:8888/api/v1/recovery/services

# Restart a service (admin)
curl -X POST http://localhost:8888/api/v1/recovery/services/orchestrator/restart \
  -H "X-Admin-Secret: your-secret"

# Create a backup (admin)
curl -X POST http://localhost:8888/api/v1/recovery/backups \
  -H "X-Admin-Secret: your-secret"

# List backups
curl http://localhost:8888/api/v1/recovery/backups

# Restore from backup (admin)
curl -X POST http://localhost:8888/api/v1/recovery/backups/{filename}/restore \
  -H "X-Admin-Secret: your-secret"

# Recommended local models (admin) — curated file or live ollama.com ranking
curl "http://localhost:8888/api/v1/recovery/inference/models/recommended?backend=ollama&source=popular" \
  -H "X-Admin-Secret: your-secret"

# Recommended cloud models with per-Mtok pricing (admin)
curl http://localhost:8888/api/v1/recovery/inference/models/recommended-cloud \
  -H "X-Admin-Secret: your-secret"

# Read env vars (admin, secrets masked)
curl http://localhost:8888/api/v1/recovery/env \
  -H "X-Admin-Secret: your-secret"

# Update env vars (admin)
curl -X PATCH http://localhost:8888/api/v1/recovery/env \
  -H "X-Admin-Secret: your-secret" \
  -H "Content-Type: application/json" \
  -d '{"updates": {"DEFAULT_CHAT_MODEL": "qwen2.5:7b"}}'
```

### Health

```bash
curl http://localhost:8888/health/live
curl http://localhost:8888/health/ready
```

---

## Response format

All services return raw JSON responses (no `{ data: ... }` wrapper). Error responses use standard HTTP status codes with a `detail` field:

```json
{"detail": "Agent not found"}
```

Streaming endpoints use Server-Sent Events (SSE) with JSON-encoded data lines:

```
data: {"delta": "Hello"}

data: {"delta": " world"}

data: [DONE]
```
