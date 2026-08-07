"""The heartbeat — she looks around on her own, and CODE decides whether
what she found reaches the operator. Spec: docs/plans/heartbeat.md.

The shape every surveyed assistant converged on (OpenClaw, Hermes, Vellum):
a periodic agent turn over an operator-editable checklist, quiet unless
something needs attention. The part that must be mechanical is the QUIET
CONTRACT: the model is asked to answer HEARTBEAT_OK when nothing matters,
but the decision to suppress or deliver is made HERE, on the reply text —
a prompt is a request, not a control. Same for repetition: phase 3 adds a
fingerprint memory so an identical alert cannot nag twice; until then the
card's dedupe key (a hash of the delivered text) is the narrow version.

Runs as a MECHANICAL_HANDLERS entry on a real automation row ('heartbeat',
migration 113), so the schedule is visible in Library -> Automations, the
run history shows every beat's outcome ('quiet - ...' / 'notified - ...'),
the kill switch and auto-disable apply, and only a migration can rebind
the row to code. Delivery is web push + an inbox card (Jeremy's pick,
2026-08-07) through the existing seams — notify.send and
recommendations.create — never a bespoke channel.
"""

import hashlib
import logging
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from app import notify, recommendations, settings_store, trace
from app.agents import registry as agent_registry
from app.agents import runner as agent_runner
from app.config import settings
from app.llm import router as llm_router

log = logging.getLogger(__name__)

#: The reply that means "nothing needs attention". Under this length the
#: whole reply is ceremony and is suppressed; at or over it the model said
#: something real AND appended the token, so the token goes and the text
#: stays. 300 is OpenClaw's measured line, adopted as-is.
QUIET_TOKEN = "HEARTBEAT_OK"
QUIET_MAX_CHARS = 300

#: Where the checklist lives: beside soul.md in the memory root, so
#: Library -> Files edits it and a backup bundle carries it.
CHECKLIST_NAME = "heartbeat.md"

SEED = """\
# Heartbeat checklist

Nova reads this file on every heartbeat (Library -> Automations ->
heartbeat sets the cadence) and checks ONLY what it names. Edit freely —
plain markdown, one concern per line. She may append items here when asked
to "keep an eye on" something.

- Backups: is the newest verified bundle older than the configured
  cadence, or did the last attempt fail? (check_backups / diagnose)
- Inbox: are there cards older than a day that were never opened?
- Background work: is anything failing repeatedly — ingestion, automations,
  evals, MCP servers? (diagnose carries the failure census)
"""

PROMPT = """\
This is your heartbeat — a scheduled look around, not a message from the
operator. Work through the checklist below and nothing else. Use your
read-only tools to CHECK, never to act; do not infer or repeat concerns
from prior conversations.

If nothing on the list needs the operator's attention right now, reply
with exactly HEARTBEAT_OK and nothing else. Otherwise reply with a short,
concrete report of only the items that need attention — it will be pushed
to their phone, so lead with what matters.

CHECKLIST
---------
{checklist}"""


def checklist_path() -> Path:
    return Path(settings.okf_memory_dir) / CHECKLIST_NAME


def read_checklist() -> str:
    """The checklist text, seeding the file on first use.

    Seeded rather than shipped: the memory dir is operator data, not repo
    content, and an install that never enables the heartbeat should still
    get the starter the first time a beat actually runs.
    """
    path = checklist_path()
    try:
        return path.read_text()
    except FileNotFoundError:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(SEED)
        return SEED


def verdict(reply: str) -> tuple[str, str]:
    """The quiet contract, applied to a finished reply.

    Returns (outcome, text): ('quiet', why) suppresses delivery entirely;
    ('notify', text) delivers text. Pure — the tests pin it directly.
    """
    cleaned = (reply or "").strip()
    if not cleaned:
        return "quiet", "empty reply"
    if QUIET_TOKEN in cleaned:
        if len(cleaned) < QUIET_MAX_CHARS:
            return "quiet", "nothing needs attention"
        # Real content wearing the token: the token goes, the report stays.
        stripped = cleaned.replace(QUIET_TOKEN, "").strip(" \n-—:")
        if not stripped:
            return "quiet", "nothing needs attention"
        return "notify", stripped
    return "notify", cleaned


def within_active_hours(now: datetime, spec: str) -> bool:
    """Whether `now` (already operator-local) falls inside "HH:MM-HH:MM".

    An unparseable spec is treated as always-active and logged — a typo in
    a settings field must not silently turn the feature off forever.
    Overnight windows ("22:00-06:00") work by inversion.
    """
    spec = (spec or "").strip()
    if not spec:
        return True
    try:
        lo_s, hi_s = spec.split("-", 1)
        lo_h, lo_m = (int(x) for x in lo_s.strip().split(":", 1))
        hi_h, hi_m = (int(x) for x in hi_s.strip().split(":", 1))
    except ValueError:
        log.warning("heartbeat.active_hours %r is not HH:MM-HH:MM — "
                    "treating as always active", spec)
        return True
    lo, hi, cur = lo_h * 60 + lo_m, hi_h * 60 + hi_m, now.hour * 60 + now.minute
    if lo == hi:
        return True
    if lo < hi:
        return lo <= cur < hi
    return cur >= lo or cur < hi          # overnight window


async def beat(automation: dict) -> tuple[bool, str]:
    """One heartbeat: the MECHANICAL_HANDLERS entry.

    Returns (ok, summary) exactly like every other handler; the summary is
    what the run history shows, so it always says which way the contract
    went rather than a bare 'ok'.
    """
    tz = settings_store.get("nova.timezone") or "UTC"
    try:
        now_local = datetime.now(ZoneInfo(tz))
    except Exception:  # noqa: BLE001 — a broken tz name must not kill beats
        now_local = datetime.now(ZoneInfo("UTC"))
    hours = settings_store.get("heartbeat.active_hours")
    if not within_active_hours(now_local, hours):
        return True, f"quiet — outside active hours ({hours})"

    agent = await agent_registry.get_agent_by_name("main")
    if not agent or not agent["enabled"]:
        return False, "the main agent is missing or disabled"
    override = (settings_store.get("heartbeat.model") or "").strip()
    if override:
        agent = {**agent, "model": override}

    prompt = PROMPT.format(checklist=read_checklist())
    final, errors = "", []

    # Its own trace source: a beat must never read as the operator's turn
    # in the ledger or the journal tooling (the probe-noise lesson).
    async with trace.turn("heartbeat", automation=automation["name"],
                          model=llm_router.effective_model(agent["model"])) as t:
        async for event in agent_runner.run_agent(
                agent, [{"role": "user", "content": prompt}],
                dispatch_depth=1, automation=automation["name"]):
            if event["type"] == "final":
                final = event["text"]
            elif event["type"] == "error":
                errors.append(event["error"])
                t.set_error(event["error"])

    if errors and not final:
        return False, "; ".join(errors)[:500]

    outcome, text = verdict(final)
    if outcome == "quiet":
        return True, f"quiet — {text}"

    # Delivery: push AND card. The card is the one that survives being
    # missed; its dedupe key is the text's own hash, so the same report
    # refreshes one card instead of stacking copies (real fingerprint
    # dedupe — suppression BEFORE the model is even asked — is phase 3).
    digest = hashlib.sha256(text.encode()).hexdigest()[:12]
    delivered: list[str] = []
    failed: list[str] = []
    try:
        await recommendations.create(
            "heartbeat", "Heartbeat: something needs your attention",
            text, source="heartbeat", dedupe_key=f"heartbeat:{digest}")
        delivered.append("card")
    except Exception as e:  # noqa: BLE001 — rate limit or closed inbox
        failed.append(f"card: {e}")
    push = await notify.send(text, title="Nova heartbeat", tags=["heartbeat"])
    (delivered if push.get("ok") else failed).append(
        "push" if push.get("ok") else f"push: {push.get('error')}")

    summary = f"notified ({', '.join(delivered)}) — {text[:200]}"
    if failed:
        summary += f" [failed: {'; '.join(failed)[:200]}]"
    # Both channels failing IS a failed run: she noticed something and the
    # operator was never told — the exact false-success shape this repo
    # documents. One channel is enough to count as delivered.
    return (bool(delivered), summary)
