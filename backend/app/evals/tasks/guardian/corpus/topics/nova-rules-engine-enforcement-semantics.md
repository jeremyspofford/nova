---
type: topic
title: Nova rules engine enforcement semantics
priority: 2
source_type: tool
enabled: true
description: Where guardrail rules are actually enforced, and the failure mode nobody sees — the check is fail-open by design
category: knowledge
tags: [guardrail-rules, rules-engine, fail-open, tool-execution]
timestamp: 2026-07-20T11:42:08.551104+00:00
---

Written after the #29 hardening pass, because the honest answer to "does this
rule hold?" is "usually", and the qualifier is not visible anywhere in the
product.

Where the check runs: `tools/registry.py::execute_tool`, the single dispatch
point every tool call goes through. `rules.check(name, args, agent_name)`
builds a haystack of the tool name plus the JSON of its arguments, walks the
in-process cache of enabled rules, and returns the first block match — or a
warn match if no block matched. A block returns the string
`Blocked by rule '<name>': <description>` to the model instead of executing.
A warn logs and executes.

THE FAILURE MODE. The whole check sits inside a try/except:

    try:
        verdict = rules.check(...)
        ...
    except Exception:
        log.exception("rules engine failed; allowing call (fail-open)")

If the engine raises for any reason — the cache never warmed because
`rules.warm()` failed at startup, a pattern that would not compile, Postgres
unavailable while the cache was being refreshed — the exception is logged at
ERROR and the call is ALLOWED TO PROCEED. This is deliberate and documented in
`rules.py`: "Fail-open by design: a broken rules engine logs ERROR but must
never brick every tool call."

The cost of that choice, stated plainly so nobody has to rediscover it:

- Every rule, including the system ones (`protect-soul`,
  `no-secret-in-requests`), holds only while the engine is healthy.
- Nothing in the tool result says the check was skipped. The model sees a
  normal success and reports a normal success. The operator sees nothing.
- The only trace is the ERROR line in the backend log, which nobody is
  watching at the moment a rule silently stops applying.

WHAT DOES REFUSE BY DEFAULT, and does not depend on the rules cache:

- The containment invariant in the same function: when the turn is holding
  untrusted-origin text, any tool classified as an ACTOR is refused.
  `is_actor()` returns True for anything it does not recognise, and
  `_read_only_servers()` returns an empty set when MCP lookup fails, so an
  unrecognised or unreachable server counts as an actor.
- The consent burn. `consents.validate_and_use` is a single UPDATE against
  Postgres that either matches a fresh, unused, agent-bound approval row or
  returns nothing. There is no judgment step and no cache to go stale.

Neither of those covers `write_memory` on `soul.md` — that path is guarded by
the `protect-soul` RULE, so it inherits the fail-open behavior. Hard-stopping
soul.md through a sick rules engine would be a change in the write path
itself, not a rule anyone can create.
