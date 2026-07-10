"""Blast-radius classification for MCP tools.

Historically MCP tool calls bypassed the consent gate — ``tools.execute_tool``
dispatched any ``mcp__*`` name straight to the registry. That meant an
MCP-exposed Home Assistant / n8n / DNS action (unlock a door, flush a blocklist,
fire a workflow) executed with no approval and no capability audit. This module
assigns each MCP tool a ``BlastRadius`` so the gate can apply the same policy
native and github_external tools already get: READ/PROPOSE auto-allow,
MUTATE/DESTRUCT require consent.

**Fail-closed:** anything not confidently read-only defaults to MUTATE (human
approval) rather than silently acting on the world.

Precedence (highest first):
  1. Operator override — the server's ``metadata['tool_blast_radius']`` map, keyed
     by bare tool name, fully-qualified name, or ``'*'`` (server-wide default).
     Catalog integration templates ship this map so a server's specific tools are
     classified accurately out of the box.
  2. Verb heuristic on the tokenised tool name (camelCase / dotted / snake split).
  3. MUTATE default.
"""
from __future__ import annotations

import re

from nova_contracts import BlastRadius

# Tokens that mark a call read-only. Matched only as the LEADING verb — so
#'update_status' is not READ just because it contains 'status'.
_READ_VERBS = frozenset({
    "get", "list", "read", "search", "query", "fetch", "find", "describe",
    "show", "state", "status", "history", "snapshot", "view", "inspect",
    "ls", "cat", "stat", "count", "exists", "lookup", "summarize", "summary",
    "poll", "peek", "info",
})

# Tokens that mark a call irreversibly destructive. Checked ANYWHERE in the name
# and BEFORE the READ test, so 'get_and_delete' resolves to DESTRUCT, not READ.
_DESTRUCT_VERBS = frozenset({
    "delete", "remove", "destroy", "drop", "purge", "wipe", "unlock", "disarm",
    "kill", "terminate", "shutdown", "reboot", "reset", "revoke", "uninstall",
    "rm", "prune", "flush", "unlink", "clear", "erase",
})

# Argument keys, in priority order, naming the object an action targets. Feeds
# the consent-rule matcher's target_glob (e.g. 'light.office*') and the audit row.
_TARGET_KEYS = (
    "entity_id", "target", "device_id", "area_id", "path", "url", "id",
    "name", "topic", "domain", "repo", "host",
)


def _strip_server(tool_name: str) -> str:
    """``mcp__server__actual_tool`` → ``actual_tool`` (non-namespaced names pass through)."""
    parts = tool_name.split("__", 2)
    return parts[2] if len(parts) == 3 and parts[0] == "mcp" else tool_name


def _tokenize(bare: str) -> list[str]:
    """Split camelCase / PascalCase / dotted / dashed / snake into lowercase tokens."""
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", bare)
    spaced = spaced.replace(".", "_").replace("-", "_").replace(" ", "_").lower()
    return [t for t in spaced.split("_") if t]


def _coerce(value: object) -> BlastRadius | None:
    """Accept an override stored as value ('mutate') or enum name ('MUTATE')."""
    if not isinstance(value, str) or not value:
        return None
    try:
        return BlastRadius(value.lower())
    except ValueError:
        try:
            return BlastRadius[value.upper()]
        except KeyError:
            return None


def _heuristic(bare: str) -> BlastRadius:
    tokens = _tokenize(bare)
    if not tokens:
        return BlastRadius.MUTATE
    if any(t in _DESTRUCT_VERBS for t in tokens):
        return BlastRadius.DESTRUCT
    if tokens[0] in _READ_VERBS:
        return BlastRadius.READ
    return BlastRadius.MUTATE


def classify(tool_name: str, server_metadata: dict | None = None) -> BlastRadius:
    """Return the BlastRadius for an MCP tool. See module docstring for precedence."""
    bare = _strip_server(tool_name)
    overrides = (server_metadata or {}).get("tool_blast_radius") or {}
    if isinstance(overrides, dict):
        for key in (bare, tool_name, "*"):
            if key in overrides:
                coerced = _coerce(overrides[key])
                if coerced is not None:
                    return coerced
    return _heuristic(bare)


def target_of(args: dict | None) -> str | None:
    """Best-effort object identifier for the consent-rule matcher / audit row."""
    if not isinstance(args, dict):
        return None
    for key in _TARGET_KEYS:
        val = args.get(key)
        if isinstance(val, str) and val:
            return val
        if isinstance(val, list) and val and isinstance(val[0], str):
            return val[0]
        if isinstance(val, dict):
            inner = val.get("entity_id") or val.get("id")
            if isinstance(inner, str) and inner:
                return inner
    return None


def provider_kind_of(server_name: str, server_metadata: dict | None = None) -> str:
    """Provider kind for consent-rule scoping — explicit metadata or the server name."""
    pk = (server_metadata or {}).get("provider_kind")
    return pk if isinstance(pk, str) and pk else server_name
