"""Curated MCP integration catalog (Slice 1 of the autonomy-core arc).

Turns "add Home Assistant / n8n / AdGuard Home" from "hand-enter a command line and
env vars" into "pick a card, fill two fields." Each template renders into an
``mcp_servers`` insert payload plus a list of secrets to persist.

**Secret handling.** Secret fields never land in ``mcp_servers.env`` as plaintext.
``render_install`` stores them in ``platform_secrets`` (encrypted) and writes a
``${secret:<key>}`` reference into env; the registry resolves references at
connect time (``_resolve_secret_refs``). Secret fields are therefore only allowed
in ``env_template`` — never in ``args``/``url``, which would end up in the process
list / DB in the clear.

**Blast radius.** Each template ships a ``tool_blast_radius`` map so its specific
tools are classified accurately the moment it connects (Slice 0 reads it from the
server's metadata). Any tool not in the map falls back to the fail-closed
heuristic — so an out-of-date catalog degrades to "requires approval," never to
"silently acts."

This module imports only the stdlib so it stays trivially unit-testable in
isolation. Treat the CATALOG list as maintainable data — package names and tool
names drift; correcting an entry is a data edit, and a wrong entry fails safe.
"""
from __future__ import annotations

import copy
import re

# category → display grouping for the UI gallery
CATEGORIES = (
    "smart-home", "automation", "network", "dev", "files", "search",
    "web", "database", "ai", "communication", "infrastructure", "browser",
)

# Each template:
#   id, name, category, description, transport ("stdio"|"http")
#   command/args (stdio) or url (http)  — may contain ${field} placeholders
#   env_template: env var -> "${field}" | literal      (secret fields go here only)
#   fields: [{key,label,placeholder?,secret?,required?,help?}]
#   tool_blast_radius: {tool_name: "read"|"mutate"|"destruct"}
#   provider_kind, requires (runtime note), docs_url
CATALOG: list[dict] = [
    {
        "id": "home-assistant",
        "name": "Home Assistant",
        "category": "smart-home",
        "description": "Read sensor state and control lights, climate, covers, and locks in your Home Assistant instance.",
        "transport": "stdio",
        "command": "uvx",
        "args": ["hass-mcp"],
        "env_template": {"HA_URL": "${base_url}", "HA_TOKEN": "${token}"},
        "fields": [
            {"key": "base_url", "label": "Home Assistant URL",
             "placeholder": "http://homeassistant.local:8123", "required": True},
            {"key": "token", "label": "Long-Lived Access Token", "secret": True, "required": True,
             "help": "Home Assistant → your profile → Security → Long-Lived Access Tokens → Create."},
        ],
        "tool_blast_radius": {
            "get_state": "read", "get_entity": "read", "list_entities": "read",
            "get_history": "read", "search_entities": "read", "get_error_log": "read",
            "call_service": "mutate", "turn_on": "mutate", "turn_off": "mutate",
            "set_state": "mutate", "trigger_automation": "mutate",
            "lock": "mutate", "unlock": "destruct", "open_cover": "destruct",
        },
        "provider_kind": "home_assistant",
        "requires": "uvx (Python) available in the orchestrator container",
        "docs_url": "https://www.home-assistant.io/integrations/mcp_server/",
    },
    {
        "id": "n8n",
        "name": "n8n",
        "category": "automation",
        "description": "List, inspect, create, and run n8n workflows — n8n handles the plumbing, Nova brings the intelligence.",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "n8n-mcp"],
        "env_template": {"N8N_API_URL": "${base_url}", "N8N_API_KEY": "${api_key}"},
        "fields": [
            {"key": "base_url", "label": "n8n URL", "placeholder": "http://localhost:5678", "required": True},
            {"key": "api_key", "label": "n8n API Key", "secret": True, "required": True,
             "help": "n8n → Settings → n8n API → Create an API key."},
        ],
        "tool_blast_radius": {
            "list_workflows": "read", "get_workflow": "read", "list_executions": "read",
            "get_execution": "read", "create_workflow": "mutate", "update_workflow": "mutate",
            "activate_workflow": "mutate", "run_workflow": "mutate", "execute_workflow": "mutate",
            "delete_workflow": "destruct",
        },
        "provider_kind": "n8n",
        "requires": "npx (Node) available in the orchestrator container",
        "docs_url": "https://docs.n8n.io/api/",
    },
    {
        "id": "adguard-home",
        "name": "AdGuard Home",
        "category": "network",
        "description": "Query DNS stats and manage filtering, clients, and blocked services on your AdGuard Home. Lets Nova explain and guard your network.",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@samik081/mcp-adguard-home"],
        "env_template": {
            "ADGUARD_URL": "${base_url}",
            "ADGUARD_USERNAME": "${username}",
            "ADGUARD_PASSWORD": "${password}",
        },
        "fields": [
            {"key": "base_url", "label": "AdGuard Home URL",
             "placeholder": "http://192.168.1.1:3000", "required": True},
            {"key": "username", "label": "Admin username", "required": True},
            {"key": "password", "label": "Admin password", "secret": True, "required": True,
             "help": "The AdGuard Home web-interface admin credentials."},
        ],
        "tool_blast_radius": {
            "global_get_status": "read", "dns_get_info": "read", "querylog_get": "read",
            "stats_get": "read", "filtering_get_status": "read", "filtering_check_host": "read",
            "clients_get": "read", "clients_search": "read", "dhcp_get_status": "read",
            "rewrites_list": "read", "blocked_services_get_all": "read",
            "blocked_services_get": "read", "tls_get_status": "read",
            "global_set_protection": "mutate", "dns_set_config": "mutate",
            "dns_clear_cache": "mutate", "filtering_set_config": "mutate",
            "filtering_add_url": "mutate", "filtering_set_rules": "mutate",
            "filtering_refresh": "mutate", "safebrowsing_set": "mutate",
            "parental_set": "mutate", "safesearch_set_settings": "mutate",
            "clients_add": "mutate", "clients_update": "mutate",
            "blocked_services_update": "mutate", "rewrites_add": "mutate",
            "rewrites_update": "mutate",
            "filtering_remove_url": "destruct", "clients_delete": "destruct",
            "rewrites_delete": "destruct", "querylog_clear": "destruct",
            "stats_reset": "destruct", "dhcp_reset": "destruct",
            "dhcp_reset_leases": "destruct", "access_set_list": "destruct",
        },
        "provider_kind": "adguard_home",
        "requires": "npx (Node) available in the orchestrator container",
        "docs_url": "https://github.com/Samik081/mcp-adguard-home",
    },
    {
        "id": "filesystem",
        "name": "Filesystem",
        "category": "files",
        "description": "Read and write files under a directory you choose. Scope it tightly — the agent gets everything under this path.",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "${root_path}"],
        "env_template": {},
        "fields": [
            {"key": "root_path", "label": "Root directory", "placeholder": "/workspace", "required": True,
             "help": "The server exposes everything under this path. Prefer a dedicated directory."},
        ],
        "tool_blast_radius": {
            "read_file": "read", "read_multiple_files": "read", "list_directory": "read",
            "directory_tree": "read", "search_files": "read", "get_file_info": "read",
            "write_file": "mutate", "edit_file": "mutate", "create_directory": "mutate",
            "move_file": "mutate",
        },
        "provider_kind": "filesystem",
        "requires": "npx (Node) available in the orchestrator container",
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    },
    {
        "id": "docker",
        "name": "Docker",
        "category": "dev",
        "description": "List, inspect, and manage Docker containers and images on the host.",
        "transport": "stdio",
        "command": "uvx",
        "args": ["docker-mcp"],
        "env_template": {},
        "fields": [],
        "tool_blast_radius": {
            "list_containers": "read", "get_logs": "read", "inspect_container": "read",
            "list_images": "read", "run_container": "mutate", "create_container": "mutate",
            "stop_container": "mutate", "restart_container": "mutate",
            "remove_container": "destruct", "remove_image": "destruct",
        },
        "provider_kind": "docker",
        "requires": "Docker socket access + uvx in the orchestrator container",
        "docs_url": "https://github.com/modelcontextprotocol/servers",
    },
    {
        "id": "brave-search",
        "name": "Brave Search",
        "category": "search",
        "description": "Web and local search via the Brave Search API. Read-only.",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-brave-search"],
        "env_template": {"BRAVE_API_KEY": "${api_key}"},
        "fields": [
            {"key": "api_key", "label": "Brave Search API Key", "secret": True, "required": True,
             "help": "https://api-dashboard.search.brave.com/ → API Keys."},
        ],
        "tool_blast_radius": {"brave_web_search": "read", "brave_local_search": "read"},
        "provider_kind": "brave",
        "requires": "npx (Node) available in the orchestrator container",
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search",
    },
    # ── Ported from the legacy client-side catalog (dashboard/src/lib/mcp-catalog.ts)
    #    so there is one source of truth. Secret fields use the encrypted
    #    platform_secrets path; tool_blast_radius maps classify tools for the
    #    consent gate. Unknown tools fail safe to "requires approval".
    {
        "id": "git",
        "name": "Git",
        "category": "dev",
        "description": "Inspect and operate on a Git repository — log, diff, status, commit, and more.",
        "transport": "stdio",
        "command": "uvx",
        "args": ["mcp-server-git", "--repository", "${repository}"],
        "env_template": {},
        "fields": [
            {"key": "repository", "label": "Repository path",
             "placeholder": "/workspace", "required": True,
             "help": "Absolute path of the repository to expose."},
        ],
        "tool_blast_radius": {
            "git_status": "read", "git_log": "read", "git_diff": "read", "git_show": "read",
            "git_branch": "read", "git_remote": "read",
            "git_add": "mutate", "git_commit": "mutate", "git_reset": "mutate",
            "git_push": "destruct", "git_pull": "mutate",
        },
        "provider_kind": "git",
        "requires": "uvx (Python) available in the orchestrator container",
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
    },
    {
        "id": "github",
        "name": "GitHub",
        "category": "dev",
        "description": "Manage repos, issues, pull requests, and code search via the GitHub API.",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-github"],
        "env_template": {"GITHUB_PERSONAL_ACCESS_TOKEN": "${token}"},
        "fields": [
            {"key": "token", "label": "GitHub Personal Access Token", "secret": True, "required": True,
             "help": "Create a token at https://github.com/settings/tokens — needs repo scope."},
        ],
        "tool_blast_radius": {},
        "provider_kind": "github",
        "requires": "npx (Node) available in the orchestrator container",
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
    },
    {
        "id": "gitlab",
        "name": "GitLab",
        "category": "dev",
        "description": "Interact with GitLab projects, merge requests, and issues.",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-gitlab"],
        "env_template": {
            "GITLAB_PERSONAL_ACCESS_TOKEN": "${token}",
            "GITLAB_API_URL": "${api_url}",
        },
        "fields": [
            {"key": "token", "label": "GitLab Personal Access Token", "secret": True, "required": True,
             "help": "Create a token in GitLab → User Settings → Access Tokens."},
            {"key": "api_url", "label": "GitLab API URL",
             "placeholder": "https://gitlab.com", "required": False, "default": "https://gitlab.com",
             "help": "Leave default for gitlab.com, or set your self-hosted instance URL."},
        ],
        "tool_blast_radius": {},
        "provider_kind": "gitlab",
        "requires": "npx (Node) available in the orchestrator container",
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/gitlab",
    },
    {
        "id": "fetch",
        "name": "Fetch",
        "category": "web",
        "description": "Fetch arbitrary URLs and convert web pages to Markdown for AI consumption.",
        "transport": "stdio",
        "command": "uvx",
        "args": ["mcp-server-fetch"],
        "env_template": {},
        "fields": [],
        "tool_blast_radius": {"fetch": "read"},
        "provider_kind": "fetch",
        "requires": "uvx (Python) available in the orchestrator container",
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    },
    {
        "id": "firecrawl",
        "name": "Firecrawl",
        "category": "web",
        "description": "Web scraping, crawling, and search with JS rendering — returns clean LLM-optimized Markdown.",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "firecrawl-mcp"],
        "env_template": {
            "FIRECRAWL_API_KEY": "${api_key}",
            "FIRECRAWL_API_URL": "${api_url}",
        },
        "fields": [
            {"key": "api_key", "label": "Firecrawl API Key", "secret": True, "required": False,
             "help": "Get a key at https://firecrawl.dev — leave empty for self-hosted."},
            {"key": "api_url", "label": "Firecrawl API URL (self-hosted)", "required": False,
             "placeholder": "http://localhost:3002",
             "help": "Point to your own Firecrawl instance for local, private operation."},
        ],
        "tool_blast_radius": {
            "firecrawl_scrape": "read", "firecrawl_crawl": "read", "firecrawl_search": "read",
            "firecrawl_map": "read", "firecrawl_check_crawl_status": "read",
        },
        "provider_kind": "firecrawl",
        "requires": "npx (Node) available in the orchestrator container",
        "docs_url": "https://github.com/mendableai/firecrawl/tree/main/apps/mcp-server",
    },
    {
        "id": "puppeteer",
        "name": "Puppeteer",
        "category": "browser",
        "description": "Browser automation — screenshot, click, fill forms, and scrape dynamic pages.",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-puppeteer"],
        "env_template": {},
        "fields": [],
        "tool_blast_radius": {
            "puppeteer_navigate": "read", "puppeteer_screenshot": "read",
            "puppeteer_evaluate": "mutate", "puppeteer_click": "mutate",
            "puppeteer_fill": "mutate", "puppeteer_select": "mutate",
            "puppeteer_hover": "mutate",
        },
        "provider_kind": "puppeteer",
        "requires": "npx (Node) + Chromium available in the orchestrator container",
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer",
    },
    {
        "id": "postgres",
        "name": "PostgreSQL",
        "category": "database",
        "description": "Query a PostgreSQL database. Connection URL is passed as the last argument.",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-postgres", "${connection_string}"],
        "env_template": {},
        "fields": [
            {"key": "connection_string", "label": "Connection URL", "required": True,
             "placeholder": "postgresql://user:pass@localhost/db",
             "help": "Full PostgreSQL connection URL. Passed as a CLI arg (the server requires it) — stored in mcp_servers.args, not encrypted. Prefer a least-privilege DB user."},
        ],
        "tool_blast_radius": {"query": "read"},
        "provider_kind": "postgres",
        "requires": "npx (Node) available in the orchestrator container",
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
    },
    {
        "id": "sqlite",
        "name": "SQLite",
        "category": "database",
        "description": "Read and query a SQLite database file.",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-sqlite", "${db_path}"],
        "env_template": {},
        "fields": [
            {"key": "db_path", "label": "Database file path", "required": True,
             "placeholder": "/workspace/db.sqlite"},
        ],
        "tool_blast_radius": {"read_query": "read", "write_query": "mutate"},
        "provider_kind": "sqlite",
        "requires": "npx (Node) available in the orchestrator container",
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite",
    },
    {
        "id": "memory",
        "name": "Memory",
        "category": "ai",
        "description": "Persistent key-value memory store that survives across agent sessions.",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-memory"],
        "env_template": {},
        "fields": [],
        "tool_blast_radius": {
            "read_graph": "read", "read_entities": "read", "read_relations": "read",
            "create_entities": "mutate", "create_relations": "mutate",
            "add_observations": "mutate", "delete_entities": "destruct",
            "delete_relations": "destruct",
        },
        "provider_kind": "memory",
        "requires": "npx (Node) available in the orchestrator container",
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    },
    {
        "id": "sequential-thinking",
        "name": "Sequential Thinking",
        "category": "ai",
        "description": "Structured multi-step reasoning tool for complex problem decomposition.",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"],
        "env_template": {},
        "fields": [],
        "tool_blast_radius": {"sequentialthinking": "read"},
        "provider_kind": "sequential_thinking",
        "requires": "npx (Node) available in the orchestrator container",
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    },
    {
        "id": "slack",
        "name": "Slack",
        "category": "communication",
        "description": "Read channels, send messages, and search Slack workspaces.",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-slack"],
        "env_template": {"SLACK_BOT_TOKEN": "${bot_token}", "SLACK_TEAM_ID": "${team_id}"},
        "fields": [
            {"key": "bot_token", "label": "Slack Bot Token", "secret": True, "required": True,
             "help": "Create a Slack app at api.slack.com and copy the Bot User OAuth Token."},
            {"key": "team_id", "label": "Slack Team ID", "required": True,
             "placeholder": "T...",
             "help": "Found in your Slack workspace URL: https://app.slack.com/client/TXXXXXXXX"},
        ],
        "tool_blast_radius": {
            "list_channels": "read", "get_channel_history": "read", "search_messages": "read",
            "post_message": "mutate", "update_message": "mutate", "delete_message": "destruct",
        },
        "provider_kind": "slack",
        "requires": "npx (Node) available in the orchestrator container",
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
    },
    {
        "id": "cloudflare",
        "name": "Cloudflare",
        "category": "infrastructure",
        "description": "Manage Cloudflare Workers, KV, R2, D1, DNS, and Tunnels via the Cloudflare API.",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@cloudflare/mcp-server-cloudflare"],
        "env_template": {
            "CLOUDFLARE_API_TOKEN": "${api_token}",
            "CLOUDFLARE_ACCOUNT_ID": "${account_id}",
        },
        "fields": [
            {"key": "api_token", "label": "Cloudflare API Token", "secret": True, "required": True,
             "help": "Create a token at https://dash.cloudflare.com/profile/api-tokens."},
            {"key": "account_id", "label": "Cloudflare Account ID", "required": True,
             "help": "Found on the right side of your Cloudflare dashboard overview page."},
        ],
        "tool_blast_radius": {},
        "provider_kind": "cloudflare",
        "requires": "npx (Node) available in the orchestrator container",
        "docs_url": "https://github.com/cloudflare/mcp-server-cloudflare",
    },
    {
        "id": "tailscale",
        "name": "Tailscale",
        "category": "infrastructure",
        "description": "Manage Tailscale devices, ACLs, DNS, and network configuration.",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@hexsleeves/tailscale-mcp-server"],
        "env_template": {
            "TAILSCALE_API_KEY": "${api_key}",
            "TAILSCALE_TAILNET": "${tailnet}",
        },
        "fields": [
            {"key": "api_key", "label": "Tailscale API Key", "secret": True, "required": True,
             "help": "Create an API key at https://login.tailscale.com/admin/settings/keys."},
            {"key": "tailnet", "label": "Tailnet Name", "required": False, "default": "-",
             "placeholder": "-",
             "help": "Your tailnet name (e.g. your-org.ts.net). Use \"-\" for the default tailnet."},
        ],
        "tool_blast_radius": {},
        "provider_kind": "tailscale",
        "requires": "npx (Node) available in the orchestrator container",
        "docs_url": "https://github.com/hexsleeves/tailscale-mcp-server",
    },
]

_BY_ID = {t["id"]: t for t in CATALOG}
_FIELD_TOKEN = re.compile(r"\$\{([a-zA-Z0-9_]+)\}")


def list_catalog() -> list[dict]:
    """All templates, deep-copied so callers can't mutate the source of truth."""
    return [copy.deepcopy(t) for t in CATALOG]


def get_template(template_id: str) -> dict | None:
    tpl = _BY_ID.get(template_id)
    return copy.deepcopy(tpl) if tpl else None


def slugify(name: str) -> str:
    """A safe, stable mcp_servers.name from a display name."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return slug or "integration"


def render_install(
    template: dict, server_name: str, values: dict,
) -> tuple[dict, list[tuple[str, str]]]:
    """Render a template + user field values into an mcp_servers insert payload.

    Returns ``(payload, secrets)`` where ``payload`` has keys name/description/
    transport/command/args/env/url/metadata (env holds ``${secret:...}`` refs, not
    plaintext) and ``secrets`` is ``[(secret_key, plaintext), ...]`` to persist in
    platform_secrets before inserting the row.

    Raises ValueError on a missing required field or a secret used in args/url.
    """
    fields = template.get("fields") or []
    field_by_key = {f["key"]: f for f in fields}
    secret_keys = {f["key"] for f in fields if f.get("secret")}

    missing = [
        f["key"] for f in fields
        if f.get("required", True) and not str(values.get(f["key"], "")).strip()
    ]
    if missing:
        raise ValueError(f"Missing required field(s): {', '.join(missing)}")

    unknown = set(values) - field_by_key.keys()
    if unknown:
        raise ValueError(f"Unknown field(s) for '{template['id']}': {', '.join(sorted(unknown))}")

    secrets: dict[str, str] = {}

    def secret_key_for(fk: str) -> str:
        return f"mcp.{server_name}.{fk}"

    def substitute(text: str, *, allow_secret: bool) -> str:
        def _repl(m: re.Match) -> str:
            fk = m.group(1)
            if fk not in field_by_key:
                # Not a user field (e.g. a literal ${something}); leave as-is.
                return m.group(0)
            # Resolve effective value: provided > default > empty string.
            raw = values.get(fk)
            if raw is None or str(raw).strip() == "":
                raw = field_by_key[fk].get("default", "")
            val = str(raw)
            if fk in secret_keys:
                if not allow_secret:
                    raise ValueError(
                        f"Secret field '{fk}' cannot be placed in args/url "
                        f"(it would be stored in the clear). Use env_template."
                    )
                if not val:
                    # Optional secret with no value/default — drop the env var.
                    return ""
                sk = secret_key_for(fk)
                secrets[sk] = val
                return "${secret:" + sk + "}"
            return val
        return _FIELD_TOKEN.sub(_repl, text)

    env = {
        var: substitute(tmpl, allow_secret=True)
        for var, tmpl in (template.get("env_template") or {}).items()
    }
    # Drop env vars that resolved to empty (optional fields with no value/default).
    env = {var: v for var, v in env.items() if v}
    args = [substitute(a, allow_secret=False) for a in (template.get("args") or [])]
    url = substitute(template["url"], allow_secret=False) if template.get("url") else None

    payload = {
        "name": server_name,
        "description": template.get("description", ""),
        "transport": template.get("transport", "stdio"),
        "command": template.get("command"),
        "args": args,
        "env": env,
        "url": url,
        "metadata": {
            "catalog_id": template["id"],
            "provider_kind": template.get("provider_kind", template["id"]),
            "tool_blast_radius": template.get("tool_blast_radius", {}),
        },
    }
    return payload, list(secrets.items())
