"""The policy kernel: the three decisions, and the single-authorizer pin.

authorize is the ONLY function that returns an ALLOW (D-012). These tests pin
each disposition's decision and — the load-bearing property — that no other
module under app/ constructs an allow.
"""
from __future__ import annotations

import ast
import uuid
from pathlib import Path

from app import consents, policy
from app.identity import Person
from app.tools.base import ToolContext
from tests.conftest import requires_db

# -- the single-authorizer pin: pure, no DB --------------------------------
#
# D-012 says exactly one module may CONSTRUCT an allow Decision (policy.py).
# A regex over the source is too weak: it misses Decision(outcome=policy.ALLOW),
# an aliased `from app.policy import ALLOW as GO`, or a name bound to ALLOW and
# passed as outcome. So this AST-walks every *.py under app/ (recursively,
# except policy.py itself), and for each Decision(...) call checks whether its
# outcome argument references an ALLOW by ANY spelling — the bare name ALLOW, a
# `.ALLOW` attribute (policy.ALLOW), the literal "allow", or a local name/import
# alias bound to any of those. It is deliberately conservative: if an outcome
# expression references ALLOW at all it is flagged, because a false positive on
# a strange construction is cheap and a missed one defeats the tripwire.


def _is_allow_leaf(node: ast.AST, tainted: set[str]) -> bool:
    """A single node that IS an allow value: the "allow" literal, any `.ALLOW`
    attribute access, or a name known to be bound to an allow value."""
    if isinstance(node, ast.Constant) and node.value == "allow":
        return True
    if isinstance(node, ast.Attribute) and node.attr == "ALLOW":
        return True
    return isinstance(node, ast.Name) and node.id in tainted


def _references_allow(node: ast.AST, tainted: set[str]) -> bool:
    """True if any sub-expression of `node` is an allow leaf (covers ternaries,
    calls wrapping ALLOW, etc.)."""
    return any(_is_allow_leaf(sub, tainted) for sub in ast.walk(node))


def _tainted_names(tree: ast.AST) -> set[str]:
    """Every local name that carries an allow value in this module: the bare
    `ALLOW`, any `from app.policy import ALLOW [as X]` binding, and any name a
    (possibly chained) assignment binds to an allow-valued expression."""
    tainted = {"ALLOW"}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name == "ALLOW":
                    tainted.add(alias.asname or alias.name)
    for _ in range(5):  # a few passes so `a = ALLOW; b = a` propagates
        before = len(tainted)
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign) and _references_allow(node.value, tainted):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        tainted.add(target.id)
            elif (
                isinstance(node, ast.AnnAssign)
                and node.value is not None
                and isinstance(node.target, ast.Name)
                and _references_allow(node.value, tainted)
            ):
                tainted.add(node.target.id)
        if len(tainted) == before:
            break
    return tainted


def _constructs_allow_decision(tree: ast.AST) -> bool:
    """True if the module has any `Decision(...)`/`x.Decision(...)` call whose
    outcome argument (keyword `outcome=` or the first positional) references an
    allow value."""
    tainted = _tainted_names(tree)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        callee = node.func
        name = callee.id if isinstance(callee, ast.Name) else (
            callee.attr if isinstance(callee, ast.Attribute) else None
        )
        if name != "Decision":
            continue
        outcome = next((kw.value for kw in node.keywords if kw.arg == "outcome"), None)
        if outcome is None and node.args:
            outcome = node.args[0]
        if outcome is not None and _references_allow(outcome, tainted):
            return True
    return False


def test_only_policy_constructs_an_allow_decision():
    """D-012, pinned by AST: no module under app/ except policy.py may build an
    allow Decision, by any spelling of ALLOW."""
    app_dir = Path(policy.__file__).parent
    offenders = [
        str(py.relative_to(app_dir))
        for py in sorted(app_dir.rglob("*.py"))
        if py.name != "policy.py"
        and _constructs_allow_decision(ast.parse(py.read_text(encoding="utf-8")))
    ]
    assert offenders == [], f"only policy.py may construct an ALLOW Decision, found: {offenders}"
    # Meaningful only if policy.py actually does construct one.
    assert _constructs_allow_decision(ast.parse(Path(policy.__file__).read_text(encoding="utf-8")))


# -- the decisions ---------------------------------------------------------

pytestmark = requires_db


async def _person(pool, role: str = "owner") -> Person:
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ($1, $2) RETURNING id", role, role
    )
    return Person(id=pid, name=role, role=role)


async def _conversation(pool, person: Person) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", person.id
    )


def _ctx(person: Person | None, conversation_id: uuid.UUID | None = None) -> ToolContext:
    return ToolContext(
        app=None, person=person, workspace_root=Path("/tmp"), conversation_id=conversation_id
    )


async def test_auto_disposition_allows(pool):
    person = await _person(pool)
    decision = await policy.authorize(_ctx(person), "get_time", {})
    assert decision.outcome == policy.ALLOW
    assert decision.is_allow


async def test_an_unknown_action_class_is_denied_fail_closed(pool):
    person = await _person(pool)
    decision = await policy.authorize(_ctx(person), "made_up_tool", {"x": 1})
    assert decision.outcome == policy.DENY
    assert not decision.is_allow
    assert "made_up_tool" in decision.reason


async def test_a_consent_tool_without_approval_requires_consent(pool):
    person = await _person(pool)
    conv = await _conversation(pool, person)
    args = {"url": "https://example.com/pricing"}
    decision = await policy.authorize(_ctx(person, conv), "fetch_url", args)

    assert decision.outcome == policy.REQUIRE_CONSENT
    card = decision.card_spec
    assert card["action_class"] == "fetch_url"
    assert card["args_hash"] == consents.args_hash(args)
    assert card["conversation_id"] == str(conv)
    assert card["requested_by"] == {"person_id": str(person.id), "agent": "chat"}
    assert "example.com" in card["summary"]
    # The card is really pending in the DB, in this conversation.
    pending = await consents.pending_for_conversation(pool, conv)
    assert [c["consent_id"] for c in pending] == [card["consent_id"]]


async def test_asking_twice_reuses_the_one_pending_card(pool):
    person = await _person(pool)
    conv = await _conversation(pool, person)
    args = {"url": "https://example.com/pricing"}
    first = await policy.authorize(_ctx(person, conv), "fetch_url", args)
    second = await policy.authorize(_ctx(person, conv), "fetch_url", args)
    assert first.card_spec["consent_id"] == second.card_spec["consent_id"]
    assert len(await consents.pending_for_conversation(pool, conv)) == 1


async def test_an_approved_consent_is_burned_and_allows(pool):
    person = await _person(pool)
    args = {"url": "https://example.com/pricing"}
    card = await consents.raise_consent(
        pool,
        action_class="fetch_url",
        args=args,
        summary="s",
        person_id=person.id,
        agent="chat",
        conversation_id=None,
    )
    await consents.decide(
        pool, consent_id=uuid.UUID(card["consent_id"]), approve=True, decided_by=person.id
    )

    decision = await policy.authorize(_ctx(person), "fetch_url", args)
    assert decision.outcome == policy.ALLOW

    # Single-use: the approval is now spent, so a second identical request
    # falls back to raising a fresh card.
    row = await consents.get(pool, uuid.UUID(card["consent_id"]))
    assert row["used_at"] is not None
    again = await policy.authorize(_ctx(person), "fetch_url", args)
    assert again.outcome == policy.REQUIRE_CONSENT


async def test_a_consent_tool_with_no_identity_is_denied(pool):
    """A consent must bind to a requestor; with no person there is nothing to
    bind, so it is refused (fail-closed) rather than raised unbound."""
    decision = await policy.authorize(_ctx(None), "fetch_url", {"url": "https://x/y"})
    assert decision.outcome == policy.DENY
