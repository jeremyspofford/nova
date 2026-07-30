"""Which verbs a goal may pre-authorise — one definition, no copies.

Split out of `registry.py` because it needs two readers that cannot import
each other: `registry.execute_tool` enforces the set, and `builtin` DESCRIBES
it to the model in `propose_goal`'s schema. `registry` imports `builtin` at
module scope, so `builtin` cannot import `registry` back.

That circularity is why the list was duplicated by hand, and the duplicate
drifted within an hour: `deploy_workload` and `delete_workload` were added to
the enforced set while the description kept naming the original five. Nova
read the description, asked for `manage_automations` to deploy a service, and
was entirely right to — it was the only thing she had been offered.

The failure is worth naming because it is the codebase's own rule turned on
its author: derived, never hardcoded. A control and its description have to
come from the same place or they are two facts that will disagree.
"""

from __future__ import annotations

# Verbs that CREATE capability. A goal the operator approved may pre-authorise
# any of these; everything else stays one decision at a time.
#
# Deliberately absent, and the exclusions carry the reasoning:
#   manage_rules       — one approval covering every future weakening would
#                        turn the strictest gate in the system into the weakest
#   delete_memory_item — a goal buys permission to build, never to erase the
#                        operator's own record
GOAL_SCOPED_TOOLS = frozenset({
    "manage_agents",
    "manage_tools",
    "manage_automations",
    "pull_model",
    "manage_tool_hosts",
    # Running a service is the largest thing she can do unattended.
    # `delete_workload` is here for a different reason than the rest: it is
    # destructive, but tearing down a workload SHE deployed is part of
    # managing it, and "no per-action approval once it is running" (Jeremy,
    # 2026-07-29) means nothing if teardown needs a click.
    "deploy_workload",
    "delete_workload",
})


def verb_list() -> str:
    """The set as prose, for a tool description or an error message."""
    return ", ".join(sorted(GOAL_SCOPED_TOOLS))


# What each verb actually MEANS to the operator reading an approval card.
# Ordered most-consequential first: a goal is described by the biggest thing
# it can do, because that is what he is really being asked to weigh.
_CONSEQUENCE: tuple[tuple[str, str], ...] = (
    ("deploy_workload",   "run a new service in her Kubernetes namespace"),
    ("manage_tool_hosts", "let her reach a new host on your network or the internet"),
    ("pull_model",        "download a model onto this machine"),
    ("manage_agents",     "create or change one of her agents"),
    ("manage_tools",      "create or change one of her tools"),
    ("manage_automations", "schedule work that runs unattended"),
    ("delete_workload",   "tear down services she deployed"),
)


def consequences(verbs) -> list[str]:
    """Plain-language effects of a verb set, worst first.

    DERIVED FROM THE VERBS, never from anything the model wrote. A goal's
    title and target are her words and she may describe a container deployment
    as "a small helper" — honestly, even, since that may be how she thinks of
    it. What the operator is agreeing to is the verb list, so the card is
    built from the verb list. The one place these could disagree is the one
    place it would matter.
    """
    have = set(verbs or ())
    return [text for verb, text in _CONSEQUENCE if verb in have]
