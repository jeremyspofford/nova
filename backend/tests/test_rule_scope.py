"""The platform block tells her what a rule GUARDS, not just its name.

    docker compose exec backend python tests/test_rule_scope.py

Written after a live failure on 2026-08-01. The block rendered
`no-secret-in-requests-expanded [warn]` — a name with no scope — and when
asked to summarise an attached PDF she answered that the guardrail blocked
her from surfacing the contents of attached files. It does not: it is a
`warn` scoped to fetch_url/web_search, it had never fired (hit_count = 0),
and rules are only ever evaluated against a TOOL CALL. Disabling that single
rule made the identical turn answer instantly, which is what proved the
prompt was the cause rather than the model being cautious.

She was not lying. She was handed half a fact and completed it, which is
what a model does with an under-specified one. So the fix is not a sterner
instruction — it is putting the missing half in front of her, derived from
the row so it cannot go stale.
"""

import sys

sys.path.insert(0, "/app/backend")

from app.agents.runner import _rule_summary                   # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def rule(**kw):
    base = {"name": "r", "action": "warn", "is_system": False, "enabled": True,
            "target_tools": [], "target_agents": []}
    base.update(kw)
    return base


print("1. a rule names the tools it guards")
s = _rule_summary(rule(name="no-secret-in-requests-expanded", action="warn",
                       target_tools=["fetch_url", "web_search"]))
check("the guarded tools are in the line", "fetch_url" in s and "web_search" in s, s)
check("...and so is the action", "warn" in s, s)
check("the exact string that caused the failure is no longer produced",
      s != "no-secret-in-requests-expanded [warn]", s)

print("\n2. an unscoped rule says so, rather than leaving it blank")
s = _rule_summary(rule(name="catch-all", action="block", target_tools=[]))
check("no target_tools renders as 'any tool' — which is BROADER, not narrower",
      "any tool" in s, s)

print("\n3. agent scoping is shown, because a rule for another agent is not hers")
s = _rule_summary(rule(name="warn-agent-privilege-escalation",
                       target_agents=["agent-creator", "agent-manager"]))
check("target_agents appear", "agent-creator" in s, s)

print("\n4. the existing flags survive")
s = _rule_summary(rule(name="protect-soul", action="block", is_system=True,
                       target_tools=["write_memory"]))
check("system is still marked", "system" in s, s)
s = _rule_summary(rule(name="off", enabled=False))
check("DISABLED is still marked", "DISABLED" in s, s)

print("\n5. it is DERIVED from the row, so retargeting a rule needs no edit here")
before = _rule_summary(rule(name="x", target_tools=["fetch_url"]))
after = _rule_summary(rule(name="x", target_tools=["fetch_url", "read_memory_item"]))
check("adding a target changes the rendered scope",
      before != after and "read_memory_item" in after, after)

print()
if FAILURES:
    print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
    sys.exit(1)
print("all checks passed")
