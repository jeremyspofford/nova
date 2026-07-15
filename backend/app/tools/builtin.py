"""Builtin tools. Each entry: {name, description, parameters, execute(args, ctx)}.

ctx is a plain dict: {conversation_id, agent_id, agent_name, dispatch_depth}.
dispatch_to_agent is declared here so it appears in agent toolsets, but its
execution is inlined by the runner (it needs to stream the sub-agent's events);
the execute function below only fires if something calls it outside the runner.
"""

import json
import logging
from urllib.parse import urlparse

from app import db
from app.agents import registry as agent_registry
from app.memory.memory import memory

log = logging.getLogger(__name__)


def _j(obj) -> str:
    return json.dumps(obj, default=str)


# ── memory ───────────────────────────────────────────────────────────────

async def _search_memory(args, ctx):
    query = args.get("query", "")
    if not query:
        return "Error: query is required"
    return _j(await memory.context(query))


async def _write_memory(args, ctx):
    content = args.get("content", "")
    if not content:
        return "Error: content is required"
    return _j(await memory.write(
        content,
        type=args.get("type", "journal"),
        title=args.get("title"),
        description=args.get("description"),
        category=args.get("category"),
        priority=int(args.get("priority", 0)),
        tags=args.get("tags"),
        source_url=args.get("source_url"),
        item_id=args.get("item_id"),
        source_type="tool",
    ))


async def _read_memory_item(args, ctx):
    item = await memory.read_item(args.get("item_id", ""))
    return _j(item) if item else "Error: item not found"


async def _delete_memory_item(args, ctx):
    item_id = (args.get("item_id") or "").strip()
    if not (item_id.startswith("skills/") or item_id.startswith("topics/")):
        return ("Error: only skills/ and topics/ items can be deleted — "
                "journals are the audit trail and identity is protected")
    if await memory.delete_item(item_id):
        return _j({"status": "deleted", "id": item_id})
    return f"Error: item '{item_id}' not found"


# ── agents ───────────────────────────────────────────────────────────────

async def _list_agents(args, ctx):
    agents = await agent_registry.list_agents(enabled_only=True)
    slim = [{k: a[k] for k in ("name", "description", "routing_keywords", "is_system")}
            for a in agents]
    return _j(slim)


async def _manage_agents(args, ctx):
    action = (args.get("action") or "").lower()

    if action == "list":
        return await _list_agents(args, ctx)

    if action == "create":
        name = args.get("name", "").strip()
        system_prompt = args.get("system_prompt", "").strip()
        if not name or not system_prompt:
            return "Error: name and system_prompt are required"
        if await agent_registry.get_agent_by_name(name):
            return f"Error: an agent named '{name}' already exists"
        from app.config import settings
        model = args.get("model") or settings.default_model
        if ":" not in model:
            model = f"openrouter:{model}"
        agent_id = await agent_registry.create_agent(
            name=name,
            description=args.get("description", ""),
            system_prompt=system_prompt,
            model=model,
            allowed_tools=args.get("allowed_tools") or ["search_memory", "write_memory"],
            routing_keywords=args.get("routing_keywords"),
        )
        return _j({"status": "created", "agent_id": agent_id, "name": name})

    if action in ("update", "disable"):
        ident = args.get("agent_id") or args.get("name", "")
        agent = None
        if ident:
            agent = (await agent_registry.get_agent_by_name(ident)
                     if not _looks_like_uuid(ident)
                     else await agent_registry.get_agent(ident))
        if not agent:
            return f"Error: agent '{ident}' not found"
        if action == "disable":
            ok = await agent_registry.disable_agent(agent["id"])
            return _j({"status": "disabled" if ok else "failed", "name": agent["name"]})
        updates = {k: v for k, v in args.items()
                   if k in ("description", "system_prompt", "model",
                            "allowed_tools", "routing_keywords", "enabled")}
        ok = await agent_registry.update_agent(agent["id"], **updates)
        return _j({"status": "updated" if ok else "failed", "name": agent["name"]})

    return f"Error: unknown action '{action}' (use list/create/update/disable)"


def _looks_like_uuid(s: str) -> bool:
    return len(s) == 36 and s.count("-") == 4


# ── tools (DB-defined, hot) ──────────────────────────────────────────────

async def _manage_tools(args, ctx):
    action = (args.get("action") or "").lower()

    if action == "list":
        async with db.acquire() as conn:
            rows = await conn.fetch(
                "SELECT name, description, execution_type, enabled FROM tools ORDER BY name")
            hosts = await conn.fetch("SELECT host FROM tool_host_allowlist ORDER BY host")
        return _j({"tools": [dict(r) for r in rows],
                   "allowed_hosts": [r["host"] for r in hosts]})

    if action == "create":
        name = args.get("name", "").strip()
        description = args.get("description", "").strip()
        url_template = args.get("url_template", "").strip()
        parameters_schema = args.get("parameters_schema") or {"type": "object", "properties": {}}
        method = (args.get("method") or "GET").upper()

        if not name or not description or not url_template:
            return "Error: name, description, and url_template are required"

        host = urlparse(url_template).hostname or ""
        async with db.acquire() as conn:
            allowed = await conn.fetchrow(
                "SELECT 1 FROM tool_host_allowlist WHERE host = $1", host)
            if not allowed:
                hosts = [r["host"] for r in
                         await conn.fetch("SELECT host FROM tool_host_allowlist")]
                return (f"Error: host '{host}' is not on the operator-approved allowlist "
                        f"({hosts}). Ask the operator to add it first.")

            spec = {"method": method, "url_template": url_template}
            if args.get("headers"):
                spec["headers"] = args["headers"]
            if args.get("body_template"):
                spec["body_template"] = args["body_template"]

            try:
                await conn.execute(
                    """INSERT INTO tools (name, description, parameters_schema,
                                          execution_type, execution_spec, created_by_agent)
                       VALUES ($1, $2, $3, 'http_call', $4, $5)""",
                    name, description, json.dumps(parameters_schema),
                    json.dumps(spec), ctx.get("agent_id"))
            except Exception as e:  # unique violation etc.
                return f"Error creating tool: {e}"
        log.info("Tool created live: %s -> %s", name, host)
        return _j({"status": "created", "name": name,
                   "note": "Tool is live immediately - no restart needed."})

    if action == "disable":
        name = args.get("name", "")
        async with db.acquire() as conn:
            result = await conn.execute(
                "UPDATE tools SET enabled = false, updated_at = now() WHERE name = $1", name)
        return _j({"status": "disabled" if result.endswith("1") else "not_found", "name": name})

    return f"Error: unknown action '{action}' (use list/create/disable)"


# ── web fetch (ingestion primitive) ─────────────────────────────────────

async def _fetch_url(args, ctx):
    url = args.get("url", "").strip()
    if not url:
        return "Error: url is required"
    from app.tools.web_fetch import fetch_url
    return await fetch_url(url)


async def _web_search(args, ctx):
    query = args.get("query", "").strip()
    if not query:
        return "Error: query is required"
    from app.tools.web_search import search
    return await search(query, int(args.get("max_results", 6)))


# WMO weather codes → plain English (open-meteo's `weather_code`)
_WMO = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Rime fog", 51: "Light drizzle", 53: "Drizzle",
    55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain",
    67: "Freezing rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow",
    77: "Snow grains", 80: "Light rain showers", 81: "Rain showers",
    82: "Violent rain showers", 85: "Snow showers", 86: "Heavy snow showers",
    95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with hail",
}


async def _get_weather(args, ctx):
    """Structured weather via open-meteo (keyless). Deterministic — geocode the
    place, pull the actual current + daily forecast; the model just relays it."""
    import httpx
    from datetime import date

    location = (args.get("location") or "").strip()
    if not location:
        return "Error: location is required (e.g. 'Portland, Maine')"
    days = max(1, min(int(args.get("days", 3)), 7))
    # the geocoder matches on a single name; "Portland, Maine" finds nothing.
    # Search the primary token, then disambiguate by the trailing hints.
    loc_parts = [p.strip() for p in location.split(",") if p.strip()]
    primary = loc_parts[0]
    hints = [p.lower() for p in loc_parts[1:]]
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            geo = (await client.get(
                "https://geocoding-api.open-meteo.com/v1/search",
                params={"name": primary, "count": 10, "language": "en",
                        "format": "json"})).json()
            results = geo.get("results") or []
            if not results:
                return _j({"error": f"Couldn't find a place named {location!r}. "
                                     "Try adding a state or country."})

            def _match(g):
                hay = " ".join(str(g.get(k, "")) for k in
                               ("admin1", "admin2", "country", "country_code")).lower()
                return sum(1 for h in hints if h in hay)
            g = max(results, key=_match) if hints else results[0]
            lat, lon = g["latitude"], g["longitude"]
            resolved = ", ".join(str(x) for x in
                                 (g.get("name"), g.get("admin1"), g.get("country")) if x)
            fc = (await client.get(
                "https://api.open-meteo.com/v1/forecast",
                params={
                    "latitude": lat, "longitude": lon,
                    "current": "temperature_2m,relative_humidity_2m,weather_code,"
                               "wind_speed_10m,precipitation",
                    "daily": "weather_code,temperature_2m_max,temperature_2m_min,"
                             "precipitation_probability_max,precipitation_sum",
                    "temperature_unit": "fahrenheit", "wind_speed_unit": "mph",
                    "precipitation_unit": "inch", "timezone": "auto",
                    "forecast_days": days})).json()
    except (httpx.HTTPError, KeyError, ValueError) as e:
        log.warning("get_weather failed: %s", e)
        return _j({"error": f"Weather lookup failed: {e}"})

    cur = fc.get("current", {})
    d = fc.get("daily", {})
    daily = []
    for i, day in enumerate(d.get("time", [])):
        wd = date.fromisoformat(day).strftime("%A")
        daily.append({
            "date": day, "weekday": wd,
            "high_f": d["temperature_2m_max"][i], "low_f": d["temperature_2m_min"][i],
            "precip_chance_pct": d["precipitation_probability_max"][i],
            "precip_in": d["precipitation_sum"][i],
            "conditions": _WMO.get(d["weather_code"][i], "Unknown"),
        })
    return _j({
        "location": resolved, "timezone": fc.get("timezone"),
        "current": {
            "temp_f": cur.get("temperature_2m"),
            "conditions": _WMO.get(cur.get("weather_code"), "Unknown"),
            "humidity_pct": cur.get("relative_humidity_2m"),
            "wind_mph": cur.get("wind_speed_10m"),
            "precip_in": cur.get("precipitation"), "as_of": cur.get("time"),
        },
        "forecast": daily,
        "note": "Actual open-meteo values. Report ONLY these fields; never invent "
                "a temperature or condition that isn't here.",
    })


# ── staleness scanner (mechanical; the ingestion agent acts on it) ──────

async def _list_stale_topics(args, ctx):
    from datetime import datetime, timedelta, timezone
    from app import settings_store
    max_age_days = int(args.get("max_age_days")
                       or settings_store.get("automations.staleness_max_age_days"))
    cutoff = datetime.now(timezone.utc) - timedelta(days=max_age_days)
    stale = []
    for doc_id, _mtime in memory.store.iter_files():
        parsed = memory.store.read_file(doc_id)
        if not parsed:
            continue
        fm, _body = parsed
        if fm.get("type") not in ("topic", "source") or not fm.get("source_url"):
            continue
        ts = str(fm.get("timestamp", ""))
        try:
            learned = datetime.fromisoformat(ts)
        except ValueError:
            continue
        if learned < cutoff:
            stale.append({"id": doc_id, "title": fm.get("title", doc_id),
                          "learned": ts[:10], "source_url": fm["source_url"]})
    stale.sort(key=lambda s: s["learned"])
    return _j({"stale_count": len(stale), "topics": stale[:10],
               "threshold_days": max_age_days})


# ── automations CRUD (Nova schedules its own behaviors) ─────────────────

async def _manage_automations(args, ctx):
    from app import automations as auto
    action = (args.get("action") or "").lower()

    if action == "list":
        rows = await auto.list_automations()
        slim = [{k: r[k] for k in ("name", "description", "agent_name",
                                   "interval_minutes", "enabled", "is_system",
                                   "last_status", "last_run_at", "next_run_at")}
                for r in rows]
        return _j(slim)

    if action == "create":
        try:
            row = await auto.create(
                name=args.get("name", "").strip(),
                instruction=args.get("instruction", "").strip(),
                agent_name=args.get("agent_name", "").strip(),
                interval_minutes=int(args.get("interval_minutes", 0)),
                description=args.get("description", ""))
        except Exception as e:
            return f"Error creating automation: {e}"
        return _j({"status": "created", "name": row["name"],
                   "next_run_at": row["next_run_at"]})

    if action in ("update", "enable", "disable"):
        row = await auto.get_by_name(args.get("name", ""))
        if not row:
            return f"Error: automation '{args.get('name')}' not found"
        updates = {k: v for k, v in args.items()
                   if k in ("description", "instruction", "agent_name",
                            "interval_minutes")}
        if action == "enable":
            updates["enabled"] = True
        elif action == "disable":
            updates["enabled"] = False
        ok = await auto.update(row["id"], **updates)
        return _j({"status": "updated" if ok else "failed", "name": row["name"]})

    if action == "delete":
        row = await auto.get_by_name(args.get("name", ""))
        if not row:
            return f"Error: automation '{args.get('name')}' not found"
        result = await auto.delete(row["id"])
        if result == "is_system":
            return f"Error: '{row['name']}' is a system automation — it can be disabled but not deleted"
        return _j({"status": result, "name": row["name"]})

    return f"Error: unknown action '{action}' (use list/create/update/enable/disable/delete)"


# ── model management (model-manager agent) ──────────────────────────────

async def _list_models(args, ctx):
    from app import models_catalog
    full = bool(args.get("full"))
    models = await models_catalog.list_models(full=full)
    grouped: dict[str, list[str]] = {}
    for m in models:
        grouped.setdefault(m["provider"], []).append(m["name"])
    result = {"providers": grouped,
              "pull_capable_backends": ["ollama"],
              "active_pulls": models_catalog.active_pulls()}
    if not full:
        hidden = len(await models_catalog.list_models(full=True)) - len(models)
        if hidden > 0:
            result["note"] = (f"{hidden} more models exist on authenticated "
                              f"providers — call list_models with full=true "
                              f"to see them. Approved cloud models are the "
                              f"enabled curated rows.")
    return _j(result)


async def _recommend_models(args, ctx):
    from app import model_recs
    recs = await model_recs.recommendations()
    hw = recs["hardware"]
    return _j({
        "hardware": {k: hw[k] for k in
                     ("ram_gb", "sizing_ram_gb", "memory_override_gb",
                      "cpu_cores", "platform", "memory_note",
                      "nvidia_runtime", "gpu_name", "vram_total_gb",
                      "vram_observed_gb", "unified_gpu")},
        "cloud_available": recs["cloud_available"],
        "recommendations": [
            {k: r[k] for k in ("agent", "profile", "current_model", "status",
                               "suggested_model", "reason", "alternates")}
            for r in recs["recommendations"]],
        "concurrent_load_if_all_suggested_load_at_once": {
            k: recs["budget"][k] for k in
            ("vram_used_gb", "vram_total_gb", "vram_over",
             "ram_used_gb", "ram_total_gb", "ram_over")},
        "note": ("Suggestions come from the curated model table sized against "
                 "this machine. They can be verified with the test probe in "
                 "Settings → Inference; local models must be pulled before "
                 "testing (never pull without asking)."),
    })


async def _pull_model(args, ctx):
    from app import models_catalog
    name = (args.get("name") or "").strip()
    backend = (args.get("backend") or "ollama").strip().lower()
    if not name:
        return "Error: name is required (e.g. qwen2.5:7b)"
    if backend != "ollama":
        return (f"Error: backend '{backend}' does not expose a pull API — "
                f"LM Studio, llama.cpp, and vLLM manage their own model "
                f"downloads. Only 'ollama' supports pulling from Nova.")
    return await models_catalog.start_pull(name)


# ── guardrail rules (guardian agent only) ───────────────────────────────

async def _manage_rules(args, ctx):
    from app import rules as rules_store
    action = (args.get("action") or "").lower()

    if action == "list":
        rows = await rules_store.list_rules()
        return _j([{k: r[k] for k in ("name", "description", "pattern", "target_tools",
                                      "target_agents", "action", "enabled", "is_system",
                                      "hit_count")} for r in rows])

    if action == "create":
        try:
            row = await rules_store.create(
                name=args.get("name", "").strip(),
                pattern=args.get("pattern", ""),
                action=args.get("rule_action", "block"),
                description=args.get("description", ""),
                target_tools=args.get("target_tools"),
                target_agents=args.get("target_agents"))
        except Exception as e:
            return f"Error creating rule: {e}"
        return _j({"status": "created", "name": row["name"], "action": row["action"]})

    if action in ("update", "enable", "disable", "delete"):
        row = await rules_store.get_by_name(args.get("name", ""))
        if not row:
            return f"Error: rule '{args.get('name')}' not found"
        if row["is_system"] and action != "list":
            return (f"Error: '{row['name']}' is a system protection — it cannot be "
                    f"modified or deleted by agents. Only the operator can change it "
                    f"in Settings.")
        if action == "delete":
            result = await rules_store.delete(row["id"])
            return _j({"status": result, "name": row["name"]})
        updates = {k: v for k, v in args.items()
                   if k in ("description", "pattern", "target_tools", "target_agents")}
        if args.get("rule_action"):
            updates["action"] = args["rule_action"]
        if action == "enable":
            updates["enabled"] = True
        elif action == "disable":
            updates["enabled"] = False
        try:
            ok = await rules_store.update(row["id"], **updates)
        except ValueError as e:
            return f"Error: {e}"
        return _j({"status": "updated" if ok else "failed", "name": row["name"]})

    return f"Error: unknown action '{action}' (use list/create/update/enable/disable/delete)"


# ── dispatch (declaration; execution is runner-inlined) ─────────────────

async def _dispatch_stub(args, ctx):
    return ("Error: dispatch_to_agent must be executed by the agent runner "
            "(and cannot be nested more than one level deep).")


BUILTIN_TOOLS: dict[str, dict] = {
    "search_memory": {
        "name": "search_memory",
        "description": "Search long-term memory (topics, journals) for relevant information.",
        "parameters": {"type": "object",
                       "properties": {"query": {"type": "string"}},
                       "required": ["query"]},
        "execute": _search_memory,
    },
    "write_memory": {
        "name": "write_memory",
        "description": ("Write to long-term memory. type='journal' appends a note to today's "
                        "journal; type='topic' or type='skill' creates a durable concept file "
                        "(title required). Skills are guidance other agents retrieve and follow. "
                        "Tags connect related topics in the brain graph; source_url records "
                        "provenance for ingested content."),
        "parameters": {"type": "object", "properties": {
            "content": {"type": "string"},
            "type": {"type": "string", "enum": ["journal", "topic", "skill"]},
            "title": {"type": "string"},
            "description": {"type": "string"},
            "category": {"type": "string",
                         "enum": ["workflow", "knowledge", "tool-use", "custom"]},
            "priority": {"type": "integer"},
            "tags": {"type": "array", "items": {"type": "string"},
                     "description": "2-4 short lowercase tags"},
            "source_url": {"type": "string"},
            "item_id": {"type": "string",
                        "description": ("To UPDATE an existing memory item in place, pass its "
                                        "id (e.g. topics/foo.md from search results). Omit to "
                                        "create a new item.")},
        }, "required": ["content"]},
        "execute": _write_memory,
    },
    "web_search": {
        "name": "web_search",
        "description": ("Search the web (Nova's own private metasearch service) and get "
                        "titles, URLs, and snippets. Use it to DISCOVER sources, then "
                        "fetch_url the promising ones."),
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string"},
            "max_results": {"type": "integer", "description": "1-8, default 6"},
        }, "required": ["query"]},
        "execute": _web_search,
    },
    "fetch_url": {
        "name": "fetch_url",
        "description": ("Fetch a public web URL (GET only) and return its readable text. "
                        "Private/internal addresses are refused. Content is size-capped; "
                        "distill it before storing to memory."),
        "parameters": {"type": "object",
                       "properties": {"url": {"type": "string"}},
                       "required": ["url"]},
        "execute": _fetch_url,
    },
    "get_weather": {
        "name": "get_weather",
        "description": ("Current conditions and daily forecast for a place, from a "
                        "structured weather service (keyless). ALWAYS use this for "
                        "weather instead of web search — it returns exact temps, "
                        "precipitation chance, and conditions. Report only the values "
                        "it returns; never guess a temperature or forecast."),
        "parameters": {"type": "object", "properties": {
            "location": {"type": "string",
                         "description": "Place name, e.g. 'Portland, Maine'"},
            "days": {"type": "integer",
                     "description": "Forecast days to return, 1-7 (default 3)"},
        }, "required": ["location"]},
        "execute": _get_weather,
    },
    "read_memory_item": {
        "name": "read_memory_item",
        "description": "Read one memory item in full by its id (a relative file path).",
        "parameters": {"type": "object",
                       "properties": {"item_id": {"type": "string"}},
                       "required": ["item_id"]},
        "execute": _read_memory_item,
    },
    "list_agents": {
        "name": "list_agents",
        "description": "List the index of available agents with their purposes.",
        "parameters": {"type": "object", "properties": {}},
        "execute": _list_agents,
    },
    "manage_agents": {
        "name": "manage_agents",
        "description": ("Manage the agent registry: list, create, update, or disable agents. "
                        "System agents can be disabled but never deleted. allowed_tools may "
                        "name builtins, specific DB-created tools, or 'db:*' for all "
                        "DB-created tools."),
        "parameters": {"type": "object", "properties": {
            "action": {"type": "string", "enum": ["list", "create", "update", "disable"]},
            "name": {"type": "string"},
            "description": {"type": "string"},
            "system_prompt": {"type": "string"},
            "model": {"type": "string",
                      "description": "e.g. openrouter:z-ai/glm-5.2"},
            "allowed_tools": {"type": "array", "items": {"type": "string"}},
            "routing_keywords": {"type": "array", "items": {"type": "string"}},
            "agent_id": {"type": "string"},
        }, "required": ["action"]},
        "execute": _manage_agents,
    },
    "manage_tools": {
        "name": "manage_tools",
        "description": ("Create/list/disable declarative HTTP tools. New tools are live "
                        "immediately. Target hosts must be on the operator allowlist. "
                        "url_template uses {placeholders} matching parameters_schema properties."),
        "parameters": {"type": "object", "properties": {
            "action": {"type": "string", "enum": ["list", "create", "disable"]},
            "name": {"type": "string"},
            "description": {"type": "string"},
            "url_template": {"type": "string",
                             "description": "e.g. https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current_weather=true"},
            "method": {"type": "string", "enum": ["GET", "POST"]},
            "parameters_schema": {"type": "object"},
            "headers": {"type": "object"},
            "body_template": {"type": "object"},
        }, "required": ["action"]},
        "execute": _manage_tools,
    },
    "list_stale_topics": {
        "name": "list_stale_topics",
        "description": ("List sourced memory topics whose knowledge has aged past the "
                        "staleness threshold — candidates for a REFRESH. Oldest first."),
        "parameters": {"type": "object", "properties": {
            "max_age_days": {"type": "integer",
                             "description": "Override the configured threshold"},
        }},
        "execute": _list_stale_topics,
    },
    "manage_automations": {
        "name": "manage_automations",
        "description": ("Manage scheduled automations (a schedule + an instruction + the "
                        "agent that executes it). Use to list existing automations or "
                        "create new recurring behaviors, e.g. periodic research or "
                        "refresh jobs. Minimum interval 5 minutes."),
        "parameters": {"type": "object", "properties": {
            "action": {"type": "string",
                       "enum": ["list", "create", "update", "enable", "disable", "delete"]},
            "name": {"type": "string", "description": "kebab-case unique name"},
            "description": {"type": "string"},
            "instruction": {"type": "string",
                            "description": "Self-contained instructions the agent runs each time"},
            "agent_name": {"type": "string",
                           "description": "Which agent executes it (see list_agents)"},
            "interval_minutes": {"type": "integer"},
        }, "required": ["action"]},
        "execute": _manage_automations,
    },
    "list_models": {
        "name": "list_models",
        "description": ("List the models Nova can use, grouped by provider: "
                        "installed local models + approved (curated) cloud "
                        "models by default; full=true adds everything served "
                        "by authenticated providers. Also reports which "
                        "backends support pulling and any pulls in progress."),
        "parameters": {"type": "object", "properties": {
            "full": {"type": "boolean",
                     "description": "true = the entire catalog of authenticated providers, not just approved models"},
        }},
        "execute": _list_models,
    },
    "delete_memory_item": {
        "name": "delete_memory_item",
        "description": ("Permanently delete a skill or topic from memory by item "
                        "id (e.g. skills/weather-clothing-advice.md). Only "
                        "skills/ and topics/ can be deleted — journals and "
                        "identity cannot. Confirm the exact id first "
                        "(search_memory / read_memory_item) and report the "
                        "returned status, never your intention."),
        "parameters": {"type": "object", "properties": {
            "item_id": {"type": "string",
                        "description": "e.g. skills/weather-clothing-advice.md"},
        }, "required": ["item_id"]},
        "execute": _delete_memory_item,
    },
    "recommend_models": {
        "name": "recommend_models",
        "description": ("Suggest a model per agent based on this machine's "
                        "hardware (RAM, cores, GPU) and the curated model table. "
                        "Returns per-agent suggestions with reasons and "
                        "alternates — present the reasons, not just names."),
        "parameters": {"type": "object", "properties": {}},
        "execute": _recommend_models,
    },
    "pull_model": {
        "name": "pull_model",
        "description": ("Download a new local model in the background (Ollama library "
                        "names like qwen2.5:7b or llama3.2:3b). Larger models take "
                        "minutes and gigabytes of disk — prefer small/mid sizes unless "
                        "asked otherwise. Verify later with list_models."),
        "parameters": {"type": "object", "properties": {
            "name": {"type": "string", "description": "model:tag from the Ollama library"},
            "backend": {"type": "string",
                        "description": "Target backend (default ollama — the only pull-capable one)"},
        }, "required": ["name"]},
        "execute": _pull_model,
    },
    "manage_rules": {
        "name": "manage_rules",
        "description": ("Manage guardrail rules that check every tool call before it "
                        "executes (block or warn on regex match against the call's "
                        "arguments). System protections cannot be modified or deleted "
                        "by agents. Prefer narrow patterns and targeted tools."),
        "parameters": {"type": "object", "properties": {
            "action": {"type": "string",
                       "enum": ["list", "create", "update", "enable", "disable", "delete"]},
            "name": {"type": "string", "description": "kebab-case unique name"},
            "description": {"type": "string",
                            "description": "What this protects against (shown when it blocks)"},
            "pattern": {"type": "string", "description": "Regex matched against tool name + args"},
            "rule_action": {"type": "string", "enum": ["block", "warn"]},
            "target_tools": {"type": "array", "items": {"type": "string"},
                             "description": "Omit for all tools"},
            "target_agents": {"type": "array", "items": {"type": "string"},
                              "description": "Omit for all agents"},
        }, "required": ["action"]},
        "execute": _manage_rules,
    },
    "dispatch_to_agent": {
        "name": "dispatch_to_agent",
        "description": ("Hand a request to a specialized agent from the index and get its "
                        "result back. Use list_agents first if unsure which agent fits."),
        "parameters": {"type": "object", "properties": {
            "agent_name": {"type": "string"},
            "message": {"type": "string",
                        "description": "Complete, self-contained instructions for the agent."},
        }, "required": ["agent_name", "message"]},
        "execute": _dispatch_stub,
    },
}
