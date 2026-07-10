"""Curated MCP integration catalog (Slice 1 of the autonomy-core arc).

Turns "add Home Assistant / n8n / Pi-hole" from "hand-enter a command line and
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
CATEGORIES = ("smart-home", "automation", "network", "dev", "files", "search")

# Each template:
#   id, name, category, description, transport ("stdio"|"http")
#   command/args (stdio) or url (http)  — may contain ${field} placeholders
#   env_template: env var -> "${field}" | literal      (secret fields go here only)
#   fields: [{key,label,placeholder?,secret?,required?,help?}]
#   tool_blast_radius: {tool_name: "read"|"mutate"|"destruct"}
#   provider_kind, requires (runtime note), icon (emoji), docs_url
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
        "icon": "🏠",
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
        "icon": "🔗",
        "docs_url": "https://docs.n8n.io/api/",
    },
    {
        "id": "pi-hole",
        "name": "Pi-hole",
        "category": "network",
        "description": "Query DNS stats and manage blocklists / clients on your Pi-hole. Lets Nova explain and guard your network.",
        "transport": "stdio",
        "command": "uvx",
        "args": ["pihole-mcp-server"],
        "env_template": {"PIHOLE_URL": "${base_url}", "PIHOLE_TOKEN": "${token}"},
        "fields": [
            {"key": "base_url", "label": "Pi-hole URL", "placeholder": "http://pi.hole", "required": True},
            {"key": "token", "label": "API Token / App Password", "secret": True, "required": True,
             "help": "Pi-hole → Settings → API/Web interface → show/generate the API token."},
        ],
        "tool_blast_radius": {
            "get_stats": "read", "get_summary": "read", "list_queries": "read",
            "list_blocklists": "read", "get_status": "read",
            "add_domain": "mutate", "add_blocklist": "mutate", "enable": "mutate",
            "disable": "mutate", "remove_domain": "destruct", "flush_logs": "destruct",
        },
        "provider_kind": "pihole",
        "requires": "uvx (Python) available in the orchestrator container",
        "icon": "🛡️",
        "docs_url": "https://docs.pi-hole.net/api/",
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
        "icon": "📁",
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
        "icon": "🐳",
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
        "icon": "🔍",
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search",
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
            if fk in secret_keys:
                if not allow_secret:
                    raise ValueError(
                        f"Secret field '{fk}' cannot be placed in args/url "
                        f"(it would be stored in the clear). Use env_template."
                    )
                sk = secret_key_for(fk)
                secrets[sk] = str(values[fk])
                return "${secret:" + sk + "}"
            return str(values[fk])
        return _FIELD_TOKEN.sub(_repl, text)

    env = {
        var: substitute(tmpl, allow_secret=True)
        for var, tmpl in (template.get("env_template") or {}).items()
    }
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
            "icon": template.get("icon", ""),
        },
    }
    return payload, list(secrets.items())
