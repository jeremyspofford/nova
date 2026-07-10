"""Human-readable action previews for the consent gate (Slice 3).

Before this, an approval showed only the opaque tool name ("approve
mcp__ha__lock.unlock"). A preview turns a pending action into a sentence the
operator can actually judge — provider, verb, target, and the salient args —
stored in ``approval_requests.diff_preview`` (which the dashboard's ApprovalCard
already renders) and surfaced in the approval push notification.

This is a *descriptive* preview, not a true simulation: Nova can't generically
execute an external side effect in a sandbox. Integrations that expose a real
dry-run mode can layer one on top later. The value here is that no gated action
is opaque — the human approves knowing what will happen, and a DESTRUCT is
visibly flagged as irreversible.
"""
from __future__ import annotations

# provider_kind → display label. Falls back to a title-cased kind or the MCP
# server name parsed from the tool.
_PROVIDER_LABELS = {
    "home_assistant": "Home Assistant",
    "github": "GitHub",
    "gitlab": "GitLab",
    "n8n": "n8n",
    "pihole": "Pi-hole",
    "docker": "Docker",
    "brave": "Brave Search",
    "cloudflare": "Cloudflare",
    "tailscale": "Tailscale",
    "slack": "Slack",
    "filesystem": "Filesystem",
}

# Arg keys never worth showing in a preview (targets shown separately; secrets
# and bulky payloads suppressed).
_SKIP_ARG_KEYS = {
    "entity_id", "target", "device_id", "area_id", "id", "path", "url",
    "token", "api_key", "secret", "password", "authorization", "content", "body",
}
_MAX_ARG_VALUE = 60
_MAX_ARGS_SHOWN = 3


def _provider_label(provider_kind: str | None, tool_name: str) -> str:
    if provider_kind:
        if provider_kind in _PROVIDER_LABELS:
            return _PROVIDER_LABELS[provider_kind]
        return provider_kind.replace("_", " ").title()
    parts = tool_name.split("__", 2)
    if len(parts) == 3 and parts[0] == "mcp":
        return parts[1]
    return "Tool"


def _verb(tool_name: str) -> str:
    bare = tool_name.split("__", 2)[-1] if tool_name.startswith("mcp__") else tool_name
    seg = bare.split(".")[-1]  # light.turn_on → turn_on
    return seg.replace("_", " ").strip() or bare


def _salient_args(args: dict, target: str | None) -> str:
    shown: list[str] = []
    for key, val in args.items():
        if len(shown) >= _MAX_ARGS_SHOWN:
            break
        if key.lower() in _SKIP_ARG_KEYS:
            continue
        if val is None or isinstance(val, (dict, list)):
            continue
        sval = str(val)
        if not sval or sval == str(target):
            continue
        if len(sval) > _MAX_ARG_VALUE:
            sval = sval[: _MAX_ARG_VALUE - 1] + "…"
        shown.append(f"{key}={sval}")
    return ", ".join(shown)


def build_action_preview(
    *,
    tool_name: str,
    provider_kind: str | None = None,
    target: str | None = None,
    args: dict | None = None,
    blast_radius: object | None = None,
) -> str:
    """One-line, human-readable summary of a pending gated action."""
    args = args or {}
    line = f"{_provider_label(provider_kind, tool_name)} → {_verb(tool_name)}"
    if target:
        line += f" on {target}"
    extras = _salient_args(args, target)
    if extras:
        line += f"  ({extras})"

    radius = str(getattr(blast_radius, "value", blast_radius) or "").lower()
    if radius == "destruct":
        line = f"⚠ Irreversible — {line}"
    return line
