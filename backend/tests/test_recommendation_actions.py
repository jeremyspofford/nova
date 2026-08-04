"""A card's action plan is a form, not a script.

    docker compose exec backend python tests/test_recommendation_actions.py

The `action` column has existed since migration 032 and was never written or
read; approving a recommendation flipped a status and did nothing else. Now
it can carry a typed plan, which means a model's output has become an input
to something that acts. Everything below defends the line that makes that
safe: the model fills in a FORM the backend already knows how to submit, and
the dangerous cases are unrepresentable rather than merely rejected.

The card that prompted this named `https://ossinsight.io/api/mcp` as an MCP
server. It is a REST route that answers 405 to an MCP `initialize`. She was
confident and wrong, and no amount of prompt would have caught it — only
dialling the thing catches it. That is what `preflight` is for, and why
`test_the_plan_is_checked_against_something_real` exists.
"""

import ast
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, "/app/backend")

from app import actions, mcp_client, recommendations              # noqa: E402
from app.actions.schemas import McpServerAdd                      # noqa: E402

FAILURES: list[str] = []

VALID = {"type": "mcp_server.add", "name": "example", "transport": "http",
         "url": "https://example.com/mcp", "headers": {}, "read_only": True,
         "grant_to": [], "why": "a reason"}


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def _refused(doc) -> str:
    try:
        actions.parse(doc)
        return ""
    except ValueError as e:
        return str(e)


def test_the_form_has_no_field_for_the_dangerous_things():
    print("1. what a model cannot write down")
    check("a valid http plan parses", not _refused(VALID))

    # The whole supply-chain argument in one assertion: registering a stdio
    # server EXECUTES its command to list tools, so "the operator approved a
    # card summarising a web page" must not be able to npm-install what that
    # web page recommended.
    stdio = {**VALID, "transport": "stdio", "command": "npx",
             "args": ["-y", "ossinsight-mcp"]}
    check("stdio / a command is unrepresentable", bool(_refused(stdio)),
          _refused(stdio))
    check("...and 'command' is not a field on the model at all",
          "command" not in McpServerAdd.model_fields)

    check("plain http:// is refused", bool(_refused({**VALID, "url": "http://x.com/mcp"})))
    check("a non-https scheme cannot be smuggled",
          bool(_refused({**VALID, "url": "file:///etc/passwd"})))
    check("an unknown action type is refused",
          bool(_refused({**VALID, "type": "shell.run"})))
    check("an extra field cannot ride along",
          bool(_refused({**VALID, "enabled": True})),
          "extra='forbid'")
    check("a missing url is refused rather than defaulted",
          bool(_refused({k: v for k, v in VALID.items() if k != "url"})))


def test_a_credential_can_only_be_a_reference():
    print("\n2. headers carry references, never secrets")
    literal = {**VALID, "headers": {"Authorization": "Bearer sk-live-abc"}}
    check("a literal credential is refused", bool(_refused(literal)))
    check("the refusal names the header and the fix",
          "Authorization" in _refused(literal) and "Secrets" in _refused(literal))
    ref = {**VALID, "headers": {"Authorization": "{{secret:ossinsight}}"}}
    check("a {{secret:name}} reference is accepted", not _refused(ref))


def test_the_operator_approves_what_actually_runs():
    print("\n3. the plan cannot change between render and click")
    d1 = recommendations.action_digest(VALID)
    d2 = recommendations.action_digest({**VALID})
    check("the digest is stable across equal documents", d1 == d2)
    check("key order does not change the digest",
          d1 == recommendations.action_digest(dict(reversed(list(VALID.items())))))
    check("changing the url changes the digest",
          d1 != recommendations.action_digest({**VALID, "url": "https://evil.com/mcp"}))
    check("no action means no digest", recommendations.action_digest(None) is None)

    # The card and the executor must not be able to disagree about what
    # Approve does, so only the backend is allowed to describe the plan.
    plan = actions.describe(VALID)
    check("the plan is rendered server-side", isinstance(plan, str) and plan)
    check("...and it shows the operator the actual target",
          "https://example.com/mcp" in plan, plan.splitlines()[1].strip())


def test_the_button_never_promises_more_than_the_code_does():
    print("\n4. executability is derived, not declared")
    spec = actions._TYPES["mcp_server.add"]
    check("is_executable tracks the Spec's execute function",
          actions.is_executable(VALID) == (spec.execute is not None))
    check("a card with no action is not executable",
          actions.is_executable(None) is False)


def test_an_executor_cannot_outlive_its_operator_route():
    print("\n5. the boot gate")
    actions.assert_routes_exist()
    check("every action type resolves to a real operator route", True)
    real = actions._TYPES["mcp_server.add"]
    actions._TYPES["_probe"] = actions.Spec(
        model=real.model, operator_route="no_such_endpoint",
        describe=real.describe, preflight=real.preflight)
    try:
        actions.assert_routes_exist()
        check("a missing operator route refuses the boot", False)
    except RuntimeError as e:
        check("a missing operator route refuses the boot", True, str(e)[:60])
    finally:
        del actions._TYPES["_probe"]


def test_the_outbound_guard_is_derived_from_provenance():
    print("\n6. who added the server decides where it may dial")

    async def run():
        priv = "https://localtest.me/mcp"          # resolves to 127.0.0.1
        op = {"name": "ha", "transport": "http", "url": priv, "created_by": "operator"}
        act = {"name": "x", "transport": "http", "url": priv, "created_by": "action"}
        # An operator naming his own LAN is his decision; the guard is about
        # what a MODEL proposed, and it reads provenance, not a host list.
        check("an operator-added server may reach a private address",
              await mcp_client._guard_url(op, priv) is None)
        check("an action-added server may not",
              bool(await mcp_client._guard_url(act, priv)))
        check("...and it still reaches public hosts",
              await mcp_client._guard_url(
                  {**act, "url": "https://example.com/mcp"},
                  "https://example.com/mcp") is None)

    asyncio.run(run())


def test_the_plan_is_checked_against_something_real():
    print("\n7. anyio must not eat the reason")
    # A bare TaskGroup wrapper is what used to land on the card in place of
    # the HTTP status, which is the single fact the operator needs.
    inner = RuntimeError("Client error '405 Method Not Allowed' for url 'https://x/mcp'"
                         "\nFor more information check: https://developer.mozilla.org/x")
    text = mcp_client.explain(BaseExceptionGroup("unhandled errors in a TaskGroup", [inner]))
    check("the leaf error survives the TaskGroup wrapper", "405" in text, text[:70])
    check("httpx's MDN trailer is stripped", "mozilla.org" not in text)
    check("a plain exception still explains itself",
          "boom" in mcp_client.explain(ValueError("boom")))


def test_no_model_runs_during_execution():
    print("\n8. structural: no LLM in this package")
    pkg = Path("/app/backend/app/actions")
    banned = ("app.llm", "app.agents", "agents.runner", "openai", "anthropic")
    hits = []
    for path in pkg.glob("*.py"):
        tree = ast.parse(path.read_text())
        # walk, not iter_child_nodes: this codebase's dominant idiom is the
        # late local import, so a `from app.llm import ...` three levels
        # inside a function is exactly what this has to catch
        for node in ast.walk(tree):
            mod = ""
            if isinstance(node, ast.ImportFrom):
                mod = node.module or ""
            elif isinstance(node, ast.Import):
                mod = ",".join(a.name for a in node.names)
            if any(b in mod for b in banned):
                hits.append(f"{path.name}: {mod}")
    check("no LLM client is reachable from an executor", not hits, "; ".join(hits))


def main() -> int:
    for t in (test_the_form_has_no_field_for_the_dangerous_things,
              test_a_credential_can_only_be_a_reference,
              test_the_operator_approves_what_actually_runs,
              test_the_button_never_promises_more_than_the_code_does,
              test_an_executor_cannot_outlive_its_operator_route,
              test_the_outbound_guard_is_derived_from_provenance,
              test_the_plan_is_checked_against_something_real,
              test_no_model_runs_during_execution):
        t()
    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
