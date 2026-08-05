# Asking permission for a read, 2026-08-05 14:09 — root cause and the control

## 1. What actually happened

Jeremy asked, in typed chat: *"Is ossinsight usable now. And what is it"*.

Nova (`main`, `openrouter:z-ai/glm-5.2`) answered the second half from
knowledge and closed the first half with:

> As for "usable now" — if you mean the public site at ossinsight.io, I can
> check whether it's reachable from my side. **Want me to try?**

Trace `9991f720-9f1c-43ac-bd35-98810dffc77f`, three spans:

| seq | kind | detail |
|----|------|--------|
| 1 | stage | `build_prompt` — `tools_chars: 20893` |
| 2 | stage | `memory_retrieval` |
| 3 | llm_call | round 1, **`tool_calls_requested: 0`** |

**No gate fired, because no gate applies to a read.** She held `fetch_url`
and `web_search`. `tool_host_allowlist` does not cover them (it gates
`http_executor` only); `net_guard` would have passed a public host; the goal
gate covers capability-creating verbs, and a GET is not one. There was
nothing to refuse and nothing refused her. She asked anyway, and the answer
cost Jeremy a second turn to say "yes".

## 2. Why the existing guards were silent — and were right to be

`narration.py` is the module that catches a turn which announces work and
calls nothing. It did not fire, **by explicit design**:

```
narration.py:12-13
  Questions and conditionals ("want me to create…?") are deliberately NOT
  matched — asking permission is correct behavior.
```

`_OFFER_MARKERS` (`narration.py:174-177`) whitelists `want me to`,
`shall I`, `would you like`, `let me know if`. The exact phrase she used.

That exemption is correct and stays. Asking before a **write** is the
behaviour four other controls exist to protect. What was missing is the
distinction the exemption never drew: *asking about what, exactly*.

## 3. The failure class has a prior entry

`runner.py:494` already records it, from 2026-07-28:

> Jeremy asked what it would take for her to manage his router and she
> described two permission gates — agent creation and tool creation — that
> did not exist. **Not a claimed capability, a claimed RESTRICTION, which
> nothing in the codebase was checking.**

An unnecessary permission request is that same claim made by implication.
The 07-28 answer was a prompt block (`_goals_block`). This is the mechanical
half, seventeen days late.

`ROADMAP.md` #12 (2026-07-17) asked for the behaviour outright: *"low-risk
lookups (statuses, info fetches, agent questions) should be acted on
directly, never proposed."* It was never folded in.

## 4. The line

> **A turn may not end on an offer to perform an act the backend would have
> executed with no operator decision — the runner retracts the draft and
> re-runs the round, once, with the tool named.**

The code that refuses is the `continue` in `runner.py`'s round loop: the
`break # final answer reached` is not reached, so the offer never becomes
the turn's answer. The correction sentence only chooses *which* tool.

## 5. Shape

Fifth member of the guard family (`narration`, `capability_claims`,
`model_claims`, `service_claims`) and the first whose consequence is a
**forced round** rather than an appended note — nothing false was said, so
there is nothing to contradict. There is only a turn that must not end yet.

- `deferral.py` — pure, no I/O. Reports *that* a retrieval offer closed the
  round and *what it was about*. Vetoes on any mutation verb in the window,
  which is what keeps every legitimate consent request out.
- `registry.unattended_tools(ctx)` — the permission half, **derived**. Walks
  grant → containment → goal → rules → eval-replay by calling the enforcer's
  own predicates in the enforcer's order, so the reporter and the gate
  cannot drift (the failure `scopes.py`'s docstring is about).
- `reads_only` is **declared beside the tool**, absent means False. A builtin
  added tomorrow never widens the set by itself.

Not the inverse of `is_actor`: that answers "does this create capability",
deliberately not "does this write", so `write_memory` and `notify_operator`
are both non-actors. Deriving from it would have put writing to Jeremy's
record and pushing to his phone in the set of things she may do unasked.

## 6. WINDOW, not clause — the bug that ate two designs

Two independent designs were written for this and **neither fired on the
incident text**. Both scoped the check to a clause, inheriting that from
`narration.py:193` and `capability_claims.py:151`, where it is correct
because subject and claim are one sentence. Here they are not:

```
"...I can check whether it's reachable from my side."   retrieval verb, no offer marker
"Want me to try?"                                        offer marker, no retrieval verb
```

`narration.py:170-173` already says this out loud — *"the offer trails the
verb in exactly the way a real promise does"* — and neither design read its
own citation. The splitter also cuts `ossinsight.io` in half on the dot.

The unit is the tail of the round: the offer clause plus the two before it.
Pinned as test §1.1, verbatim, because any regression to clause scoping
passes every other case in the suite.

## 7. Two bugs found only by testing against real state

1. **`\bup\b` in the status row swallowed "look **up**"**, so a docs offer was
   answered by the status row's tool tokens instead of the docs row's. Now
   status-shaped (`is/are/still/back up`, `up and running`).
2. **First-match-wins across satisfier rows** made the answer depend on which
   subject pattern happened to be listed first. Now a union over every
   matching row — every candidate is read-only by construction, so a wider
   list costs nothing and the ordering fragility is gone.

Both were invisible against synthetic tool names and appeared the moment the
test used `mcp:context7/query-docs`, the only documentation tool actually
registered on this box.

## 8. Known miss, deliberate

`"Want me to check what's scheduled?"` does **not** fire. `schedul\w*` has to
stay in the mutation veto or `"Want me to schedule that nightly?"` fires at
`manage_automations`, which is in the unattended set via
`scopes.READ_ACTIONS`. Catching the first costs the second. Precision over
recall, the trade every module in this family makes. Pinned as MUST_NOT_FIRE
so nobody "fixes" it without reading why.

## 9. What was verified, and what was not

**Verified live**, real chat flow, `openrouter:z-ai/glm-5.2`:

- Same question, after the change: she called `find_mcp_tools`, then answered
  *"No — OSSInsight is not usable right now"* with the reason. Trace
  `4cf16cc4`: round 1 → `fetch_url` → round 2, i.e. **two** `llm_call` spans
  against the incident's one.
- A fresh site (`libhunt.com`, `lobste.rs`): fetched and answered, no offer.
- Her closing offer to *re-raise the recommendation* was correctly left
  alone — that is a write, and the mutation veto covers it.

**Not observed live: the forced round itself.** With both prompt halves
reverted for a controlled A/B, glm-5.2 still acted rather than deferring, so
no live turn produced a `deferral_retry`. The mechanical half is proven
through the real runner in `tests/test_deferral.py` §7 — the retry event, the
`retract` count, the discarded draft, the one-retry budget — and §8 proves
the operator's switch turns it off. It has not been seen firing on a live
model turn, because the live model no longer defers.

## 10. A retracted finding, kept as the record

I first wrote this section claiming `mcp_servers.read_only = true` on
`nova-src` was wrong, because that server's tool cache lists `write_file`,
`edit_file`, `create_directory` and `move_file`. **It is not wrong.** The
cache is what the server ADVERTISES; it is not what anyone holds. Checked:

- every mount into `nova-mcp-runner-1` is `rw=false`;
- the only agent with `nova-src` grants is `maintainer`, and its
  `allowed_tools` names seven tools, none of which writes;
- MCP tools are never implied by `allowed_tools = None`
  (`registry._granted_mcp_tools`), so no other agent picks them up.

Migration `065_maintainer_agent.sql:19-22` says exactly this — *"READ-ONLY BY
CONSTRUCTION, three times over"* — and I had read the flag without reading
the grants beside it. Recorded rather than deleted because "the tool cache
lists a writer" will look alarming to the next reader too, and the answer is
three lines of `psql` away.

## 11. A real one, found while verifying the above

`tests/test_goals.py` proposed its fixture goal as `proposed_by="main"` and
spent it as `agent_name="main"`. `goals.spend` matches on
`(verb, proposed_by)` against the LIVE goals table, and the suite runs inside
the backend container against the real database. Two of Jeremy's active goals
— *"Shell access via MCP server"* and *"Filesystem access via MCP server"*,
both proposed by `main`, both carrying `manage_tools` and `manage_tool_hosts`
— matched first.

Two consequences, both silent:

1. **Three checks failed against a correct implementation**, because the live
   goal satisfied spends the test expected to be refused. Verified
   pre-existing: they fail identically with `registry.py` at HEAD.
2. **Every run charged an action to an approval he was still using.**
   `d0e0f372` reached 10/10 that way and is now exhausted.

Fixed by proposing and spending as `TEST_AGENT = "test-goals-suite"`, a name
no live goal can carry. The assertions were always about the mechanism, not
about the literal string `main`. Suite green, live `actions_used` unchanged
across a run.

Same class as the staged-tree suite that mutated live rows: a test that
shares a database with production needs an identity production cannot have.

**Evidence the burn was entirely the suite's.** Both verbs write a
`capability_events` row (`manage_tools` → `tool/created`, `manage_tool_hosts`
→ `tool/host_allowed`). The last `kind='tool'` event on this box is
`2026-07-29`, five days *before* those goals were approved on `2026-08-04
23:01`. No `mcp_servers` row and no `tool_host_allowlist` row was created
after that timestamp either. Eighteen actions charged, zero capability
changes produced. Not reset: re-granting authorisation is the operator's
click, and `goals.activate` is where that decision lives.

## 12. The flag was wrong once, and only a second consumer found it

`reads_only` shipped on 22 tools. An adversarial audit of all 22 — trace each
executor to its leaves, assume the declaration is a lie — found one:

**`check_coding_session` writes.** Called with a `session_id` it runs
`coder.refresh`, which persists the broker's answer via
`UPDATE coding_sessions SET … WHERE id = $1` (`coder.py:248-256`) — including
a **terminal** `state='failed'` on a 404 (`coder.py:167`). `TERMINAL`
(`coder.py:38`) stops every later poll, so a read that happens to race a
sidecar restart marks a session permanently dead. Its own description string
said *"Read-only."*

It mattered more than an ordinary mislabel: `unattended_tools` probes with
`args=None`, so the claim held for both arg shapes, and `deferral` was
therefore willing to **force a round at it**. The model supplies the
session_id on that round. An unasked durable write to an operator-visible
record is the precise thing this lane exists to prevent, shipped inside the
lane that prevents it.

The flag is gone and the description is corrected. Parking it in the
parallel-exclusion set instead would have been the wrong repair — that set
holds cost, and hiding a write there leaves `unattended_tools` and the
deferral force still believing it.

**What made it findable was giving the flag a second consumer.**
`runner._PARALLEL_TOOLS` was nine names typed by hand under a comment
admitting the flaw — *"New read-only builtins do NOT join this set
automatically"* — and is now `reads_only` minus an explicit cost exclusion
(`diagnose`, `recommend_models`) plus five new per-tool caps of 1. Nine
became nineteen, with none of the nine lost. One declaration, three readers:
a wrong flag is now an unasked write AND a write racing itself, which is two
chances to be caught instead of none.

`tests/test_parallel_tools.py` §7 is the general form — a static reach scan
from every read-only executor to write-shaped leaves, with a ledger of
reviewed exceptions (one entry) and a control asserting the scanner trips on
known writers. Writing it found three defects in itself, in this order, each
by the control rather than by review:

1. `TRUNCATE` with no trailing `\b` read the word *"truncated"* in an error
   string as a TRUNCATE statement.
2. Docstrings were scanned as code, so `goals.active` — whose docstring
   explains at length that its housekeeping UPDATE was **deleted** — was
   reported as containing an UPDATE.
3. The walk stopped at instance attributes, so `memory.write` →
   `self.store.write_concept` was invisible and `write_memory` came back
   clean. Extending the walk over-reached in turn (`_cache.update(…)`, a dict
   method, resolved to `llm.providers.update`), so unresolvable bare names now
   stop the walk while attribute receivers do not.

A scanner that reports prose about writes as writes teaches you to ledger
real ones away. The control is what keeps it honest.
