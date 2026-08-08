"""The model pool is hers to tend — and no write path can invent an id.

    docker compose exec backend python tests/test_model_pool.py

THE INCIDENT (2026-08-07, reconstructed from the live DB). "Can you get the
latest DeepSeek flash llm available" cost 31 minutes of Nova describing UI
steps — including an edit mode deleted from the UI — because no agent could
write curated_models. The operator hand-inserted the row with the slug
'openrouter:~deepseek/deepseek-v4-flash-latest' (the openrouter.ai
PROFILE-URL shape, which the provider does not serve) and repointed `main`
at it 21 seconds later. The hand insert logged nothing; the pool had no
audit at all.

What this suite defends, all mechanical and all network-free (every provider
fact is injected — a validity check asserted against whatever the live
catalog holds today asserts nothing):

  1. ONE canonicalisation rule (models_catalog.resolve_id): membership in
     the live provider catalog decides. The '~author/model' form is
     normalised to the canonical id when that exists and REFUSED otherwise —
     the exact check that would have stopped the hand-typed slug. Listable
     providers fail CLOSED when their catalog cannot be read: an id nothing
     has checked is the failure, not the outage.
  2. The tool schema for the curated edit fields is DERIVED from the same
     tuples `_validate` enforces — one source, two readers, locked by an
     assert at import.
  3. The new verb is goal-scoped with `list` exempt as a read, and it never
     joins the declared read-only set (goal-scoped and read-only are
     mutually exclusive by invariant — test_deferral pins that globally).
  4. `model.assign` is a registered, executable action whose document can
     express exactly one thing: one agent, one model id, one why.
"""

import asyncio
import sys

sys.path.insert(0, "/app/backend")

from app import models_catalog as cat                       # noqa: E402
from app.llm import providers                               # noqa: E402

FAILURES: list[str] = []

TILDE = "openrouter:~deepseek/deepseek-v4-flash-latest"
CANON = "openrouter:deepseek/deepseek-v4-flash-latest"


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def _fake_catalog(ids):
    async def fake(force=False, full=False):
        return [{"id": i, "provider": i.split(":", 1)[0]} for i in ids]
    return fake


async def run() -> int:
    saved = (cat.list_models, providers.known_slugs, providers.get,
             providers.is_configured)
    providers.known_slugs = lambda: {"openrouter", "keyless"}
    providers.get = lambda slug: {
        "openrouter": {"catalog_path": "/models"},
        "keyless": {"catalog_path": ""},          # cannot list
    }.get(slug)
    providers.is_configured = lambda slug: slug == "openrouter"
    cat.list_models = _fake_catalog([CANON, "openrouter:z-ai/glm-5.2"])
    try:
        print("1. the one rule: catalog membership decides")
        got, why = await cat.resolve_id(CANON)
        check("an id the provider serves is accepted unchanged",
              got == CANON, f"{got} / {why}")

        got, why = await cat.resolve_id(TILDE)
        check("THE INCIDENT SLUG: the '~' profile-URL form is normalised to "
              "the canonical id the catalog really lists",
              got == CANON, f"{got} / {why}")
        check("...and the reason says what happened, so the caller reports "
              "the real id rather than the pasted one",
              "normalised" in why, why)

        got, why = await cat.resolve_id("openrouter:~nobody/nothing-v9")
        check("a '~' form with no canonical id behind it is REFUSED",
              got is None, f"{got} / {why}")
        got, why = await cat.resolve_id("openrouter:made/up-model")
        check("a plain id the provider does not serve is REFUSED — "
              "plausible is not listed", got is None, f"{got} / {why}")

        print("2. failure modes fail closed, absence of proof is not proof")
        cat.list_models = _fake_catalog([])
        got, why = await cat.resolve_id(CANON)
        check("a listable provider whose catalog cannot be read right now "
              "REFUSES rather than writing an id nothing checked",
              got is None and "verified" in why, f"{got} / {why}")
        cat.list_models = _fake_catalog([CANON, "openrouter:z-ai/glm-5.2"])

        got, why = await cat.resolve_id("mystery:some/model")
        check("an unknown provider is refused", got is None, f"{got} / {why}")
        got, why = await cat.resolve_id("no-colon-at-all")
        check("an unprefixed id is refused", got is None, str(got))

        print("3. the classes that cannot be verified say so honestly")
        got, why = await cat.resolve_id("ollama:qwen3:8b")
        check("a local id is accepted — existence is the pull/probe's "
              "question", got == "ollama:qwen3:8b", f"{got} / {why}")
        got, why = await cat.resolve_id("ollama:~weird/tag")
        check("...but the '~' artifact shape is never a local tag",
              got is None, f"{got} / {why}")
        got, why = await cat.resolve_id("keyless:some/model")
        check("an unlistable provider's id is accepted and SAYS unverified",
              got == "keyless:some/model" and "UNVERIFIED" in why,
              f"{got} / {why}")
        got, why = await cat.resolve_id("keyless:~some/model")
        check("...except the '~' shape, which nothing could ever confirm",
              got is None, f"{got} / {why}")

        print("4. canonical_form is pure syntax and only resolve_id promotes it")
        check("strips '~' per path segment",
              cat.canonical_form(TILDE) == CANON, cat.canonical_form(TILDE))
        check("a clean id passes through untouched",
              cat.canonical_form(CANON) == CANON)
        check("no provider prefix -> unchanged, never a guess",
              cat.canonical_form("noprefix") == "noprefix")
    finally:
        (cat.list_models, providers.known_slugs, providers.get,
         providers.is_configured) = saved

    print("5. the tool's field schema derives from the validator's tuples")
    from app import curated_models as cm
    schema = cm.edit_field_schema()
    check("exactly the editable fields, no more, no less",
          set(schema) == cm._EDIT_FIELDS, str(set(schema) ^ cm._EDIT_FIELDS))
    check("tool_tier enum IS _TIERS", schema["tool_tier"]["enum"] == list(cm._TIERS))
    check("roles items enum IS _ROLES",
          schema["roles"]["items"]["enum"] == list(cm._ROLES))
    from app.tools.builtin import BUILTIN_TOOLS
    props = BUILTIN_TOOLS["manage_curated_models"]["parameters"]["properties"]
    check("the tool advertises those derived fields, not a retyped copy",
          all(props.get(k) == v for k, v in schema.items()),
          str([k for k, v in schema.items() if props.get(k) != v]))

    print("6. goal-scoped, list exempt, never read-only")
    from app.tools import scopes
    check("manage_curated_models creates capability -> goal-scoped",
          "manage_curated_models" in scopes.GOAL_SCOPED_TOOLS)
    check("list is a read — asking what is approved must never raise a card",
          not scopes.needs_goal("manage_curated_models", {"action": "list"}))
    for a in ("add", "update", "enable", "disable", "frobnicate"):
        check(f"'{a}' stays gated (default-deny)",
              scopes.needs_goal("manage_curated_models", {"action": a}))
    check("the approval card can say what the verb means",
          any("models are approved" in c
              for c in scopes.consequences(["manage_curated_models"])))
    check("the tool is NOT declared reads_only — goal-scoped and read-only "
          "are mutually exclusive",
          not BUILTIN_TOOLS["manage_curated_models"].get("reads_only"))

    print("7. model.assign is a registered, executable action")
    from app import actions
    doc = actions.parse({"type": "model.assign", "agent": "main",
                         "model": CANON, "why": "asked for it"})
    check("a well-formed document parses", doc.agent == "main")
    check("the '~' form is representable — the resolver, not the schema, "
          "judges it, so the card can explain instead of vanishing",
          actions.parse({"type": "model.assign", "agent": "main",
                         "model": TILDE, "why": "x"}).model == TILDE)
    try:
        actions.parse({"type": "model.assign", "agent": "main",
                       "model": CANON, "why": "x", "allowed_tools": ["all"]})
        check("an extra field is refused", False)
    except ValueError as e:
        check("an extra field is refused — one field of one agent moves, "
              "nothing else is expressible", True, str(e)[:60])
    check("it is executable — approving does something, the card never "
          "promises more than the code",
          actions.is_executable({"type": "model.assign", "agent": "main",
                                 "model": CANON, "why": "x"}))
    check("its operator route is the PATCH the operator already owns",
          actions._TYPES["model.assign"].operator_route == "patch_agent_endpoint")

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))
