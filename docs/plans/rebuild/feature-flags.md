# Feature flags — and the three controls that are not built

Author: Fable, 2026-09-16. The three features below were each declined
during the S24 UI work for a stated reason. This spec says what a flag would
be and what each feature costs.

**Decided since (Jeremy, 2026-09-16): permission mode stays absent.** See
item 3 — reading (a). Nothing to build, and the composer row is finished
without it. Attachments and thinking effort are still open.

## Where this came from

He pointed at Claude Code's composer row and asked for five things. Two —
the model selector and the context gauge — describe something Nova has, and
shipped. Three do not:

| Control | Why it was not built |
|---|---|
| Permission mode ("Bypass permissions") | v4 makes NO authorization decisions. Owner ruling 2026-09-03; `test_no_approvals` is the line of code that refuses the day someone rebuilds one. |
| Attachments (`+`) | There is no upload path in this chat. A `+` that opens nothing is worse than no `+`. |
| Thinking effort ("Max") | Measured 2026-09-15 against this ollama: `think:false`, `chat_template_kwargs.enable_thinking`, `/no_think` and as-sent ALL still thought. It cannot be set on the `/v1` path. |

A button for a capability that does not exist is a lie the UI tells on the
backend's behalf, and this codebase has spent real days on exactly that
class of defect. So: build the capability, or do not draw the control. A
flag is how a half-built capability stays invisible until it is whole — it
is **not** a way to ship the control first.

## What a flag is here

**Derived from the live system wherever the answer is derivable, and stored
only where it is a genuine preference.** That distinction is the whole
design, and it comes straight from "derived, never hardcoded":

- **Capability flags are NOT stored.** "Can this chat take an attachment?"
  is answered by whether an upload route exists and the store behind it is
  reachable — the same way the capability guard reads the live tool list
  rather than a maintained list of tool names. A stored `attachments:true`
  on a build with no upload route is a switch wired to nothing, which is the
  defect this whole spec exists to avoid.
- **Preference flags ARE stored**, in `settings` (the table that already
  holds `chat.model`, `agents.max_tool_rounds`, `proactive.enabled`). A
  preference is a question the machine cannot answer for the owner: *how
  hard should she think*, not *can she think*.

So one shape, two halves:

    GET /api/v1/capabilities
    {
      "attachments": {"available": false, "reason": "no upload route on this build"},
      "thinking_effort": {"available": false, "reason": "the active backend is ollama /v1, which ignores every way of setting it"},
      "approvals": {"available": false, "reason": "v4 makes no authorization decisions (owner ruling 2026-09-03)"}
    }

Every entry carries a REASON, because "off" and "impossible here" are
different facts and the UI should be able to say which. A control whose
capability is unavailable is not rendered at all — not rendered disabled. A
greyed-out control is still a claim that the feature exists.

**What refuses when this is wrong:** a test that walks every capability key
the UI can render and asserts each names a real route or setting. A key that
nothing serves fails it, so a flag cannot outlive the feature it gates.

---

## 1. Attachments

**Smallest real version.** A file goes somewhere Nova can read, and the turn
is told it is there. That is it — no preview, no thumbnails, no inline
images.

- `POST /api/v1/chat/attachments` → writes into the workspace under a
  per-conversation path, returns `{path, bytes, media_type}`.
- The composer sends `attachments: [path]` with the message; prompt assembly
  appends a line naming each path.
- She reads them with `workspace_read_file`, which she already has.

**Cost:** one route, one storage decision, a nginx body-size change (v3 was
bitten by the 1 MiB default on the phone path — see
`attachments-documents-lane`), and a UI affordance.

**The real question:** which files does she READ versus merely know about?
A 40 MB PDF she cannot parse is a path in a prompt, not an attachment. The
honest first cut is text-like files only, with anything else stated as
"stored, not read".

**Flag:** `attachments.available` — derived from whether the route exists
and the workspace root is writable.

---

## 2. Thinking effort

**This one needs a backend change, not a control.** The finding stands:
`/v1/chat/completions` on this ollama ignores every documented way of
turning thinking off. Four were tried; all four still thought, and at
`max_tokens=80` all four produced zero content because the budget went to
reasoning.

**The lever is the endpoint.** ollama's native `/api/chat` honours
`think: false`. Routing chat there instead of `/v1` is a gateway change of
real size: `/api/chat` has a different request shape, a different streaming
envelope, and different tool-call semantics from the OpenAI-compatible path
every provider in the registry speaks. The gateway currently has ONE
OpenAI-compat client on purpose.

**Three ways to take it, in increasing cost:**

1. **Do nothing, and show the thinking.** Already shipped — reasoning
   streams under the bubble, and `thinking_ms` is on the span. The wait is
   legible; it is not shorter.
2. **A per-model native path.** The gateway keeps `/v1` for everything and
   adds `/api/chat` for ollama only, behind a capability that is derived
   from the active backend's kind. `thinking_effort` becomes available
   exactly when the active backend is local ollama.
3. **A non-thinking model for chat.** No code at all: a routing decision.
   Cheapest, and worth measuring before either of the above.

**Flag:** `thinking_effort.available` — derived from the backend kind, never
stored. The EFFORT itself (off / normal / max) is a stored preference,
`chat.thinking`, and only meaningful while the capability is available.

**Measure first.** Before (2) is worth its size: what does thinking actually
buy on this corpus? The eval corpus can answer that — same cases, thinking
on and off, on the model she actually uses. If the answer is "nothing worth
90 seconds", (3) is the whole feature.

---

## 3. Permission mode — DECIDED: it stays absent

**Jeremy, 2026-09-16: "let's forget the permission mode, you were correct."**
Reading (a) below. Nothing is built, nothing is flagged, and this section
stays as the record of why — so the next person who notices the gap between
Nova's composer row and Claude Code's finds the answer instead of filling
it in.

The rest of this section is the reasoning that produced that answer.

**This did not fit behind a flag, and pretending it did would have been the
wrong kind of clever.**

The ruling (2026-09-03, `docs/plans/rebuild/no-approvals.md`) is not a
default someone set. It removed consents, grants, dispositions, earned
autonomy, per-agent and per-device grants, and deny-roots, and it left
`tests/test_no_approvals.py` behind specifically so that rebuilding any
approval shape turns a suite red. The rule as written: a check may state
that a call CANNOT run; it may never decide that it MAY not.

So "Bypass permissions" in Nova has nothing to bypass. Three readings, and
only Jeremy can pick:

- **(a) It stays absent.** ← **CHOSEN.** The screenshot's control is an
  artefact of a tool that HAS permissions. Nova does not, by his own ruling,
  and the honest answer to "where is that control" is "that idea is not in
  this product".
- **(b) It becomes something else that is true.** There IS a real thing
  nearby: which tools are advertised to a turn. A control that narrows her
  toolset for one conversation ("no shell here") is a SCOPE, not an
  approval — nothing asks him anything, nothing waits. It would need
  `test_no_approvals` read carefully to be sure a scope cannot become a gate
  by accident, and the honest name for it is "tools", not "permissions".
- **(c) The ruling changes.** His to make. If it does, it is a slice of its
  own and not a composer-row button, and this spec should be deleted rather
  than amended.

**Recommendation: (a), unless he wants (b).** (b) is a genuinely useful
feature with a misleading name attached; the name is what makes it look like
the screenshot, and the name is the part that would be false.

---

## Order, if any of this is wanted

1. **The capabilities route and its test.** Small, and it is what makes the
   other two safe: a control cannot be drawn for a feature that is not there.
2. **Measure thinking on the corpus.** Cheap, and it may delete item 3's
   larger option.
3. **Attachments**, if he wants them — the most self-contained of the three.
4. **Thinking effort**, only if the measurement says it is worth a second
   client in the gateway.
5. ~~**Permissions**~~ — answered: (a), absent. Off the list.

## What this spec refuses

No flag may render a control for a capability that is unavailable, disabled
or otherwise. A greyed-out button still says the feature exists; absence
says the truth. And no flag may be stored for a question the system can
answer by looking at itself.
