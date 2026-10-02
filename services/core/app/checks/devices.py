"""The devices family (S42a): Nova's agents, as the rows say.

One check: two live agents reporting ONE machine. A machine runs one Nova
agent (hub owner decision 9); two means two sockets answering for one
computer, two toasts for every urgent notice (delivery.py sends to every
connected device) and two opinions about the same facts. Read from what each
agent reported — machine_uid, a salted hash of the OS's own machine id —
never from a name. Non-urgent: the digest mentions it and the owner revokes
the extra; nobody is woken.

It cannot see an agent inside WSL beside its machine's Windows agent: WSL
has its own machine id by construction. That pair is the WSL role rule's to
state (device_facts.WSL_REASON), and a pre-S42a agent that sends no facts is
visible to neither — the owner retires it by hand.

A second (S42b decision 2): an agent behind the hub's build that Nova
cannot, or did not manage to, update. One the agent_updates job will update
at its next idle moment is not news; one that cannot be updated says the
owner's one step; one where the build failed (rolled back, never confirmed)
says so in its own words; and one that refused it says it cannot take it —
never that the build failed, which a refusal does not mean. Whether Nova can
update it is agent_updates.eligibility's — the same decision the send and
the job read (F14).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app import agent_dist, agent_updates, device_facts, devices
from app.checks import CannotCheck, Check, Finding

_SQL = """
SELECT name, facts->>'machine_uid' AS uid
  FROM devices
 WHERE revoked_at IS NULL
   AND facts->>'machine_uid' IS NOT NULL
   AND facts->>'machine_uid' <> ''
 ORDER BY name
"""


async def duplicate_agents(app, pool) -> list[Finding]:
    groups: dict[str, list[str]] = {}
    for row in await pool.fetch(_SQL):
        groups.setdefault(row["uid"], []).append(row["name"])
    findings = []
    for uid, names in sorted(groups.items()):
        if len(names) < 2:
            continue
        findings.append(
            Finding(
                key=f"duplicate_agent:{uid[:12]}",
                title=(
                    f"one machine runs {len(names)} Nova agents — {', '.join(names)}; a machine "
                    "runs one agent, so revoke all but one in Settings → Devices"
                ),
                facts={"machine_uid": uid, "agents": names},
            )
        )
    return findings


_FAILED_WORDS = {"rolled_back": "rolled back", "not_confirmed": "not confirmed"}


def _stale(built_at: str) -> bool:
    """Whether the hub's build was built over a day ago. A time that does
    not read, or names no zone, is never stale: it says nothing."""
    try:
        built = datetime.fromisoformat(built_at.replace("Z", "+00:00"))
    except ValueError:
        return False
    return built.tzinfo is not None and datetime.now(UTC) - built > timedelta(days=1)


async def agents_behind(app, pool) -> list[Finding]:
    """An agent behind the hub's build that Nova cannot, or did not manage to,
    update. One the job will update at its next idle moment is not news.

    Each says only what the rows say: an agent that has not reported its
    build is never called behind, and one still behind a build over a day
    old is never given a cause nobody checked."""
    try:
        build = await agent_dist.read()
    except agent_dist.DistUnavailable as exc:
        raise CannotCheck(f"the hub has no agent build to compare with — {exc}") from exc
    stale = _stale(build.built_at)
    findings = []
    for r in await devices.rows_with_last_update(pool, live_only=True):
        version = device_facts.agent_version(r["facts"])
        if version == build.version:
            continue
        build_words = (
            f"is behind the hub's build {build.version}"
            if version
            else f"has not said which build it runs (the hub's is {build.version})"
        )
        able = agent_updates.eligibility(r)
        if not able.can:
            token = able.token
            title = f"{r['name']}'s agent {build_words}, and it {able.said} — {able.step}"
        elif r["u_version"] == build.version and r["u_outcome"] in agent_updates.BUILD_FAILED:
            token = f"failed:{r['u_outcome']}"
            title = (
                f"{r['name']}'s agent {build_words}: its update to it was "
                f"{_FAILED_WORDS[r['u_outcome']]}: {r['u_reason'] or 'no reason was recorded'}"
            )
        elif r["u_version"] == build.version and r["u_outcome"] == "refused":
            # The MACHINE could not take it (controller ruling on P10): said
            # as that, never as the build failing.
            said = (r["u_reason"] or "no reason was recorded").removeprefix("cannot: ")
            token = "refused"
            title = f"{r['name']}'s agent {build_words} and cannot take it: {said}"
        elif stale:
            token = "stale"
            title = (
                f"{r['name']}'s agent {build_words}, which was built over a day ago "
                f"({build.built_at}) — Nova has not updated it to it yet"
            )
        else:
            continue
        findings.append(
            Finding(
                key=f"agent_behind:{r['id']}",
                title=title,
                facts={"device": r["name"], "hub_version": build.version, "why": token},
            )
        )
    return findings


CHECKS: tuple[Check, ...] = (
    Check(
        name="devices_duplicate_agents",
        describe="Two or more live Nova agents reporting the same machine.",
        urgent=False,
        run=duplicate_agents,
    ),
    Check(
        name="devices_agents_behind",
        describe="An agent behind the hub's build that Nova cannot, or did not manage to, update.",
        urgent=False,
        run=agents_behind,
    ),
)

NAMES: tuple[str, ...] = tuple(check.name for check in CHECKS)
