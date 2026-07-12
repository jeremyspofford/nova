---
title: "MCP Tools"
description: "Extend Nova's agents with Model Context Protocol servers for filesystem, git, web search, databases, and more."
---

Nova supports the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) for extending agent capabilities with external tool servers. MCP servers run as subprocesses managed by the Orchestrator, and their tools become available to all agents automatically.

## What is MCP?

The Model Context Protocol is an open standard for connecting AI models to external tools and data sources. An MCP server exposes a set of tools (functions) that agents can call during their execution. Nova's Orchestrator connects to MCP servers at startup and makes their tools available alongside the built-in tools (file I/O, shell, git).

## How agents use MCP tools

1. The Orchestrator loads MCP server configurations from the database at startup
2. It connects to each enabled server and discovers its available tools
3. When an agent runs, its tool list carries a one-line **capability index** entry per connected server (name, description, tool count) instead of every tool's full schema
4. When a task involves an integration, the agent calls `load_integration_tools(server=...)` — the server's real tool schemas are spliced into the conversation for the rest of that task
5. The agent can then call any loaded MCP tool by name (prefixed with `mcp__<server>__<tool>`)
6. The Orchestrator dispatches the call to the appropriate MCP server and returns the result

### Lazy loading and "Always inject"

Tool schemas are heavy: a single integration can expose 50+ tools, and injecting
every schema into every LLM call costs thousands of prompt tokens and measurably
degrades tool selection on small local models. Lazy loading is therefore the
default: an installed integration costs ~15 tokens per call until an agent
actually needs it.

If a specific integration is hot enough that the extra load step hurts, expand
its server card on the Integrations page and switch on **Always inject tools** —
that server's schemas then ride along in every LLM call, and it drops out of the
capability index. Agents on a pod whose tool allowlist pins specific `mcp__`
tools also get those schemas injected directly, without a load call.

## Available MCP servers

Nova ships with a built-in catalog of pre-configured MCP servers. You can add any of these from the Dashboard's MCP page with one click.

### Core tools

| Server | Description | Package |
|--------|-------------|---------|
| **Filesystem** | Read, write, and navigate files | `@modelcontextprotocol/server-filesystem` |
| **Git** | Inspect and operate on Git repositories -- log, diff, status, commit | `mcp-server-git` (uvx) |
| **Memory** | Persistent key-value memory store that survives across sessions | `@modelcontextprotocol/server-memory` |

### Smart home and automation

| Server | Description | Package |
|--------|-------------|---------|
| **Home Assistant** | Read sensor state and control lights, climate, covers, and locks | `hass-mcp` (uvx) |
| **n8n** | List, inspect, create, and run n8n workflows | `n8n-mcp` |

### Network

| Server | Description | Package |
|--------|-------------|---------|
| **AdGuard Home** | Query DNS stats and manage filtering, clients, and blocked services | `@samik081/mcp-adguard-home` |

### Development

| Server | Description | Package |
|--------|-------------|---------|
| **GitHub** | Manage repos, issues, pull requests, and code search | `@modelcontextprotocol/server-github` |
| **GitLab** | Interact with GitLab projects, merge requests, and issues | `@modelcontextprotocol/server-gitlab` |
| **Docker** | List, inspect, and manage containers and images on the host | `docker-mcp` (uvx) |

### Web and search

| Server | Description | Package |
|--------|-------------|---------|
| **Brave Search** | Web and local search via the Brave Search API | `@modelcontextprotocol/server-brave-search` |
| **Fetch** | Fetch URLs and convert web pages to Markdown | `mcp-server-fetch` (uvx) |
| **Firecrawl** | Web scraping, crawling, and search with JS rendering | `firecrawl-mcp` |
| **Puppeteer** | Browser automation -- screenshot, click, fill forms, scrape | `@modelcontextprotocol/server-puppeteer` |

### Databases

| Server | Description | Package |
|--------|-------------|---------|
| **PostgreSQL** | Query a PostgreSQL database | `@modelcontextprotocol/server-postgres` |
| **SQLite** | Read and query SQLite database files | `@modelcontextprotocol/server-sqlite` |

### AI and reasoning

| Server | Description | Package |
|--------|-------------|---------|
| **Sequential Thinking** | Structured multi-step reasoning for complex problem decomposition | `@modelcontextprotocol/server-sequential-thinking` |

### Communication

| Server | Description | Package |
|--------|-------------|---------|
| **Slack** | Read channels, send messages, and search Slack workspaces | `@modelcontextprotocol/server-slack` |

### Infrastructure

| Server | Description | Package |
|--------|-------------|---------|
| **Cloudflare** | Manage Workers, KV, R2, D1, DNS, and Tunnels | `@cloudflare/mcp-server-cloudflare` |
| **Tailscale** | Manage devices, ACLs, DNS, and network configuration | `@hexsleeves/tailscale-mcp-server` |

## Adding MCP servers via the Dashboard

1. Navigate to **MCP** in the Dashboard sidebar
2. Click **Add from Catalog** to browse available servers
3. Select a server and fill in any required configuration (API keys, paths)
4. Click **Add** -- the Orchestrator will connect to the server and discover its tools
5. The server immediately appears in every agent's capability index; agents load its tools on demand (or enable **Always inject tools** on the server card to skip the load step)

## Adding custom MCP servers

You can register any MCP server, not just those in the catalog. From the Dashboard's MCP page:

1. Click **Add Custom Server**
2. Provide the server name, command, arguments, and any environment variables
3. The Orchestrator will attempt to connect and discover tools

Or via the API:

```bash
curl -X POST http://localhost:8000/api/v1/mcp-servers \
  -H "X-Admin-Secret: your-admin-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-server",
    "command": "npx",
    "args": ["-y", "@my-org/mcp-server-custom"],
    "env": {"API_KEY": "..."},
    "enabled": true
  }'
```

## Managing MCP servers

| Action | API | Dashboard |
|--------|-----|-----------|
| List servers | `GET /api/v1/mcp-servers` | MCP page |
| Add server | `POST /api/v1/mcp-servers` | Add from Catalog / Add Custom |
| Update config | `PATCH /api/v1/mcp-servers/{id}` | Edit button |
| Remove server | `DELETE /api/v1/mcp-servers/{id}` | Delete button |
| Reconnect | `POST /api/v1/mcp-servers/{id}/reload` | Reload button |

## Environment variables

Some MCP servers require API keys or configuration via environment variables. These are set per-server and passed to the subprocess when it starts. Required variables for catalog entries are documented in the catalog and prompted during setup.

| Server | Required variables |
|--------|--------------------|
| AdGuard Home | `ADGUARD_URL`, `ADGUARD_USERNAME`, `ADGUARD_PASSWORD` |
| Brave Search | `BRAVE_API_KEY` |
| GitHub | `GITHUB_PERSONAL_ACCESS_TOKEN` |
| GitLab | `GITLAB_PERSONAL_ACCESS_TOKEN`, optionally `GITLAB_API_URL` |
| Home Assistant | `HA_URL`, `HA_TOKEN` |
| n8n | `N8N_API_URL`, `N8N_API_KEY` |
| Slack | `SLACK_BOT_TOKEN`, `SLACK_TEAM_ID` |
| Cloudflare | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| Tailscale | `TAILSCALE_API_KEY`, `TAILSCALE_TAILNET` |
