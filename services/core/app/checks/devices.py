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
"""

from __future__ import annotations

from app.checks import Check, Finding

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


CHECKS: tuple[Check, ...] = (
    Check(
        name="devices_duplicate_agents",
        describe="Two or more live Nova agents reporting the same machine.",
        urgent=False,
        run=duplicate_agents,
    ),
)

NAMES: tuple[str, ...] = tuple(check.name for check in CHECKS)
