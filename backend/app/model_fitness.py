"""Can this model actually do the job it was given?

Written after a silent downgrade: `openrouter:z-ai/glm-5.2` was swapped for
`ollama:qwen2.5:3b` — a 1.9GB model — because a provider cache was cold, and
76 documents were summarised by it while every log line, span and UI label
said glm-5.2. The swap itself is correct behaviour (an answer from a small
model beats no answer). Nothing telling anyone was not.

That fixes the reporting. This answers the question underneath it: was the
3B model ever a reasonable stand-in for every agent in the system?

THE HONEST LIMIT, first, because it decides the whole design. Nothing here
can tell you a model is DUMB. That needs evals, and the eval lane is
elsewhere. What is available is fact:

  * `tools` / `vision` capability — ollama reports these on /api/show, and
    OpenRouter reports modalities in the catalog. An agent holding tools that
    is given a model without tool support does not degrade, it fails.
  * The real context window, against what that agent's prompts MEASURE at.
    Not a guess: turn_spans has recorded prompt sizes per agent.
  * Relative size among what is actually installed. "You picked the smallest
    of the four models on this machine to stand in for every agent" is an
    observation, not a quality judgement, and it is the one that would have
    caught this.

So findings are facts with a stated basis, never scores. A gauge that invents
authority is worse than no gauge: the operator stops reading it the first
time it is confidently wrong, which is the same way a grounding check that
eats good summaries gets switched off.
"""

from __future__ import annotations

import json
import logging
from typing import Optional

import httpx

log = logging.getLogger(__name__)

# Severity. `blocking` means the role cannot work at all — a tool-calling
# agent on a model with no tool support is not a worse assistant, it is a
# broken one. `advisory` is a fact worth seeing that may still be the right
# call.
BLOCKING = "blocking"
ADVISORY = "advisory"


async def local_capabilities(model_name: str) -> dict:
    """What ollama itself says about a local model.

    Derived from /api/show, never from the model's name — the lesson from
    thinking-mode detection, where a name list would have been wrong within a
    month. Returns {} when ollama cannot answer, and an empty dict must be
    read as "unknown", never as "unsupported".
    """
    from app import settings_store
    base = str(settings_store.get("inference.ollama_url")).rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(f"{base}/api/show",
                                     json={"model": model_name})
            resp.raise_for_status()
            data = resp.json()
    except Exception as exc:  # noqa: BLE001 — a metadata probe never breaks a caller
        log.debug("ollama /api/show failed for %s: %s", model_name, exc)
        return {}
    info = data.get("model_info") or {}
    ctx = next((v for k, v in info.items()
                if k.endswith("context_length") and isinstance(v, int)), None)
    return {
        "capabilities": list(data.get("capabilities") or []),
        "parameter_size": (data.get("details") or {}).get("parameter_size"),
        "context_length": ctx,
    }


def _params_billions(text: Optional[str]) -> Optional[float]:
    """'14.8B' -> 14.8. None when ollama did not say."""
    if not text:
        return None
    try:
        return float(str(text).strip().upper().rstrip("B"))
    except ValueError:
        return None


async def describe(model: str) -> dict:
    """Everything known about one model, from whichever source knows it."""
    from app import models_catalog
    out: dict = {"model": model, "local": model.startswith("ollama:")}
    if out["local"]:
        out.update(await local_capabilities(model.split(":", 1)[1]))
        return out
    for entry in (models_catalog._cache.get("models") or []):
        if entry.get("id") == model:
            out["context_length"] = entry.get("context_length")
            out["capabilities"] = ["tools"] + (["vision"] if entry.get("vision") else [])
            break
    return out


async def measured_prompt_tokens(agent_name: Optional[str] = None) -> Optional[int]:
    """The largest prompt this agent has actually sent, from the turn ledger.

    Measured beats assumed. `agent_name=None` asks across every agent, which
    is the right question for the fallback model — it stands in for all of
    them, so it has to fit the biggest.
    """
    from app import db
    sql = ("SELECT max((detail->>'prompt_chars')::int) FROM turn_spans "
           "WHERE name = 'build_prompt' AND detail ? 'prompt_chars'")
    args: list = []
    if agent_name:
        sql += " AND detail->>'agent' = $1"
        args.append(agent_name)
    try:
        async with db.acquire() as conn:
            chars = await conn.fetchval(sql, *args)
    except Exception:  # noqa: BLE001
        log.debug("prompt-size lookup failed", exc_info=True)
        return None
    if not chars:
        return None
    from app.agents import context_trim
    return int(chars) // context_trim._CHARS_PER_TOKEN


def _when(ev: dict) -> str:
    """Date the evidence, say how many draws it is, and flag a stale suite.

    Three things decide whether a stored score still means anything, and none
    of them were on the row until migration 086:

    * WHEN — the July 2026 rows were graded before ten of main's tools were
      servable in replay, so every model scored worse than it was.
    * HOW MANY DRAWS — two runs of the same seven tasks scored 2/7 and 3/7,
      and the task that flipped was one nothing had touched. A single run
      reported as a measurement is the error this exists to stop.
    * WHICH SUITE — a score against suite_version 2 does not describe
      version 3. NULL means recorded before the column existed: unknown, and
      said as unknown rather than assumed current.
    """
    at = ev.get("finished_at")
    bits = [f" on {at:%Y-%m-%d}"] if hasattr(at, "year") else []
    runs = ev.get("repeat_count") or 1
    bits.append(f" over {runs} run{'s' if runs != 1 else ''}"
                + (" (one draw, not a measurement)" if runs == 1 else ""))
    was, now = ev.get("suite_version"), ev.get("current_suite_version")
    if was is None:
        bits.append(", against an unrecorded suite version")
    elif now is not None and was != now:
        bits.append(f", against suite v{was} — the suite is now v{now}, so "
                    f"this score describes a different set of tasks")
    return "".join(bits)


async def eval_evidence(model: str,
                        agent_name: Optional[str] = None) -> Optional[dict]:
    """The most recent recorded eval run for this model, or None.

    `agent_name=None` asks "measured on anything?", which is the right
    question for the install-wide standby: it stands in for every agent, so
    any suite it has been graded on is evidence about it.
    """
    from app import db
    sql = ("SELECT suite, agent_name, tasks_passed, tasks_total, finished_at, "
           "suite_version, repeat_count, detail "
           "FROM eval_runs WHERE model = $1 AND finished_at IS NOT NULL")
    args: list = [model]
    if agent_name:
        sql += " AND agent_name = $2"
        args.append(agent_name)
    sql += " ORDER BY finished_at DESC LIMIT 1"
    try:
        async with db.acquire() as conn:
            row = await conn.fetchrow(sql, *args)
    except Exception:  # noqa: BLE001 — evidence missing is not a crash
        log.debug("eval lookup failed for %s", model, exc_info=True)
        return None
    if not row:
        return None
    out = dict(row)
    detail = out.get("detail")
    if isinstance(detail, str):
        try:
            detail = json.loads(detail)
        except ValueError:
            detail = None
    tasks = (detail or {}).get("tasks") or []
    out["failed_tasks"] = [str(t.get("task") or "") for t in tasks
                           if isinstance(t, dict) and t.get("passed") is False]
    # What the suite is NOW, so a score against an older one can say so. Read
    # from disk rather than stored twice: the suite file is the only truth
    # about its own version, and a second copy is a second thing to be wrong.
    try:
        from app.evals import suites as suite_mod
        out["current_suite_version"] = suite_mod.load_suite(out["suite"]).version
    except Exception:  # noqa: BLE001 — a missing suite is not a crash
        out["current_suite_version"] = None
    return out


async def assess(model: str, *, needs_tools: bool = False,
                 needs_vision: bool = False,
                 needs_tokens: Optional[int] = None,
                 role: str = "this role",
                 measured_for: Optional[str] = None) -> list[dict]:
    """Findings for one model against one role's actual requirements."""
    facts = await describe(model)
    caps = facts.get("capabilities")
    findings: list[dict] = []

    if needs_tools and caps is not None and caps and "tools" not in caps:
        findings.append({
            "severity": BLOCKING, "check": "tools",
            "detail": f"{role} calls tools, and {model} does not support tool "
                      f"calling (ollama reports {caps}). It will not fail "
                      f"loudly — it will answer without calling anything."})
    if needs_vision and caps is not None and caps and "vision" not in caps:
        findings.append({
            "severity": BLOCKING, "check": "vision",
            "detail": f"{role} receives image attachments and {model} cannot "
                      f"read them."})

    # The window the call will ACTUALLY get. For a local model that is what
    # local_context sized it to, not the weights' maximum — ollama truncates
    # from the head, which eats the system prompt silently. There is no
    # server-wide pin to compare against any more; the sizer is the only
    # answer, and before it has run for this model there is no answer at all.
    window = facts.get("context_length")
    if facts["local"]:
        from app import local_context
        sized = local_context.cached(model)
        if sized:
            if window and window > sized:
                findings.append({
                    "severity": ADVISORY, "check": "context_underused",
                    "detail": f"{model} supports {window:,} tokens but only "
                              f"{sized:,} fit in VRAM alongside its weights, "
                              f"so most of the model's window is unavailable. "
                              f"Free VRAM to raise it — it is measured, not "
                              f"configured."})
            window = sized
    if needs_tokens and window and needs_tokens > window:
        findings.append({
            "severity": BLOCKING, "check": "context",
            "detail": f"{role} has sent prompts of ~{needs_tokens:,} tokens, "
                      f"but {model} gets {window:,}. Oversized prompts are "
                      f"refused outright on the local path rather than "
                      f"silently truncated."})

    # BEHAVIOUR, not a declared capability. Every check above this line reads
    # something the model SAYS about itself — /api/show's capability list is a
    # manifest, and "tools" in it means the runtime can format a tool call, not
    # that this model ever makes one. ornith:9b declares tools, passes that
    # check, and is recorded at 0/6 on its own agent's suite: the exact model
    # the narration, capability-claim and service-claim detectors were built
    # for was being waved through as fit.
    #
    # So the last word goes to what was measured. Nothing here is a threshold
    # someone maintains — it reads the recorded run and reports it.
    if needs_tools:
        ev = await eval_evidence(model, measured_for)
        if not ev:
            # HONEST ABSENCE, the rule diagnose learned the same day. Silence
            # here would read as "fit", which is how an unmeasured model got
            # the front door in the first place.
            findings.append({
                "severity": ADVISORY, "check": "unmeasured",
                "detail": f"{model} has never been graded on a behavioural "
                          f"suite"
                          + (f" for {role}" if measured_for else "")
                          + ". Its tool support is a capability it DECLARES, "
                            "not behaviour anyone has observed. Run "
                            "`python -m app.evals run <suite> --champion "
                            f"{model} --record` before trusting it with a "
                            "tool-calling job."})
        elif ev["tasks_total"] and not ev["tasks_passed"]:
            findings.append({
                "severity": BLOCKING, "check": "measured",
                "detail": f"{model} scored 0/{ev['tasks_total']} on the "
                          f"'{ev['suite']}' suite{_when(ev)}. It supports tool "
                          f"calling as a format and fails the behaviour: "
                          f"{', '.join(ev['failed_tasks'][:3]) or 'every task'}"
                          f". This is measured, not inferred from /api/show."})
        elif ev["tasks_passed"] < ev["tasks_total"]:
            findings.append({
                "severity": ADVISORY, "check": "measured",
                "detail": f"{model} scored {ev['tasks_passed']}/"
                          f"{ev['tasks_total']} on the '{ev['suite']}' suite"
                          f"{_when(ev)}. Failing: "
                          f"{', '.join(ev['failed_tasks'][:3])}."})
    return findings


async def assess_for_agent(agent_id: str) -> list[dict]:
    """Findings for one agent's CURRENT model, against what that agent does.

    Requirements are read off the agent row and its own history, not from a
    table of role expectations someone maintains: it needs tools because it
    was granted tools, and it needs a window this big because its prompts
    have been this big.
    """
    from app.agents import registry as agent_registry
    agents = await agent_registry.list_agents(enabled_only=False)
    agent = next((a for a in agents if str(a["id"]) == str(agent_id)), None)
    if not agent or not agent.get("model"):
        return []
    grants = agent.get("allowed_tools")
    return await assess(
        agent["model"],
        # None means "every builtin", which certainly includes tools
        needs_tools=grants is None or bool(grants),
        needs_tokens=await measured_prompt_tokens(agent.get("name")),
        role=f"'{agent.get('name')}'",
        # Graded as THIS agent, not on whatever suite the model last happened
        # to run: a model that passes the ingestion suite says nothing about
        # whether it can hold the front door.
        measured_for=agent.get("name"))


async def rank_local() -> list[dict]:
    """Installed local models, largest first, with what each can do.

    Size is not quality and this does not pretend otherwise. It is the one
    ordering available without evals, and it is enough to notice that the
    smallest of four installed models was standing in for the whole system.
    """
    from app import models_catalog
    out = []
    for entry in await models_catalog._ollama_models():
        name = entry["name"]
        facts = await local_capabilities(name)
        out.append({"model": f"ollama:{name}",
                    "parameter_size": facts.get("parameter_size"),
                    "billions": _params_billions(facts.get("parameter_size")),
                    "capabilities": facts.get("capabilities") or [],
                    "context_length": facts.get("context_length")})
    return sorted(out, key=lambda m: m["billions"] or 0, reverse=True)


# Model choices that are NOT an agent row. Each is a setting that quietly
# routes real work to a model nobody picked in the agent list, which is
# exactly how the smallest model on the machine ended up doing some of the
# most consequential writing in the system.
#   (setting key, human name, what its output does, blank means)
_ROLE_SETTINGS = [
    ("compaction.model", "conversation compaction",
     "its output is injected into the system prompt of EVERY later turn in "
     "that conversation, where it is read as established fact",
     "inherits the conversation's own model"),
    ("voice.model_override", "voice replies",
     "its output is spoken aloud, so a mistake is heard rather than read",
     "inherits the answering agent's model"),
]


async def check_roles() -> list[dict]:
    """Fitness of the models bound to ROLES rather than to agents.

    An agent's model is visible in the agent list. A role's model is a
    settings key, so nothing surfaces it next to the work it does — and the
    work can matter more. Compaction is the case that proves it: a rolling
    summary seeds every subsequent turn, and it was running on the smallest
    model installed with `Never invent content` in its prompt as the only
    control.
    """
    from app import settings_store
    from app.llm import router as llm_router
    installed = await rank_local()
    smallest_first = sorted(installed, key=lambda m: m["billions"] or 0)
    out = []
    for key, label, consequence, blank_means in _ROLE_SETTINGS:
        raw = str(settings_store.get(key) or "").strip()
        if not raw:
            out.append({"setting": key, "role": label, "model": None,
                        "findings": [], "note": f"unset — {blank_means}"})
            continue
        # never "does it contain ':'" — a bare local tag carries its own
        # colon, and this line used to read qwen3:8b as cloud-qualified
        model = llm_router.qualify(raw)
        findings = await assess(model, needs_tools=False, role=f"{label}")
        # The specific thing worth saying, and the reason this function
        # exists: a consequential role running on the least capable thing
        # available, where nobody would see it.
        if installed and model == smallest_first[0]["model"] and len(installed) > 1:
            bigger = [m for m in installed if m["model"] != model][:3]
            findings.append({
                "severity": ADVISORY, "check": "smallest_installed",
                "detail": f"{label} runs on {model}, the smallest model "
                          f"installed, and {consequence}. Larger options: "
                          + ", ".join(f"{m['model']} ({m['parameter_size']})"
                                      for m in bigger)
                          # `blank_means` is a verb phrase in the third
                          # person ("inherits …") because the unset branch
                          # above reads "unset — inherits …"; "would
                          # inherits" was ungrammatical on the one screen
                          # this advisory finally reaches
                          + f". Clearing {key} {blank_means} instead."})
        out.append({"setting": key, "role": label, "model": model,
                    "findings": findings})
    return out


async def check_fallback() -> dict:
    """Is the local fallback fit to stand in for every agent?

    The fallback is the one model whose requirements are the UNION of all the
    others', because any agent can land on it without warning. That is what
    made a 3B model a system-wide exposure rather than one agent's problem.
    """
    from app import model_chain
    from app.agents import registry as agent_registry

    # Both rules live in model_chain: the ollama-prefix qualification (a local
    # tag carries its own colon) and what "needs tools" means. They were
    # written out longhand in three places, which is two places to forget.
    model = model_chain.standby_setting()
    if not model:
        return {"model": None, "findings": [], "alternatives": []}

    agents = await agent_registry.list_agents(enabled_only=True)
    needs_tools = any(model_chain.needs_tools(a) for a in agents)
    findings = await assess(
        model, needs_tools=needs_tools,
        needs_tokens=await measured_prompt_tokens(),
        role="the local fallback (it substitutes for EVERY agent)")

    installed = await rank_local()
    mine = next((m for m in installed if m["model"] == model), None)
    bigger = [m for m in installed
              if (m["billions"] or 0) > (mine["billions"] or 0 if mine else 0)
              and "tools" in m["capabilities"]]
    if bigger:
        # Say WHAT IS TRUE. This claimed "is the smallest tool-capable model
        # installed" whenever anything larger existed, which is a different
        # statement and was false the moment the fallback moved off the 3B.
        # A gauge that overstates is one the operator stops reading.
        rank = len(bigger) + 1
        findings.append({
            "severity": ADVISORY, "check": "larger_available",
            "detail": f"{model} answers for every agent when a provider is "
                      f"unreachable, and it is #{rank} of "
                      f"{len(installed)} installed by size. Larger "
                      f"tool-capable options: "
                      + ", ".join(f"{m['model']} ({m['parameter_size']})"
                                  for m in bigger[:3])})
    return {"model": model, "findings": findings,
            "alternatives": [m["model"] for m in bigger[:3]]}
