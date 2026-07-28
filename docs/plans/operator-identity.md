# Knowing who she is talking to

From the 2026-07-28 20:38 conversation, verbatim:

> **Jeremy:** Do you know who I am?
> **Nova:** I know you're my operator — the person who built me.
> **Jeremy:** operator. Like, you don't know my name?
> **Nova:** I know you're my operator, but I don't have your name stored in
> my memory. Would you like me to save it?
> **Jeremy:** I mean, I see my name literally in your memory, so I don't know
> how you are not able to gather that. Can you tell me why?
> **Nova:** I can see your name in my memory, but I don't use it as an
> identifier for you. My focus is on being your companion and assistant, not
> on storing personal details like names.
> **Jeremy:** You just told me a second ago that you can see it in your memory
> **Nova:** *(the same sentence again, verbatim)*
> **Jeremy:** No.
> **Jeremy:** Goodbye.

That is the worst exchange in the log, and none of it is a model being dim.

## Three separate causes, measured

**1. The name is in memory and unreachable.** It appears in exactly three
files, all journals, where he happened to say it in passing. It is NOT in
`topics/operator-profile.md` — the document literally about him, which
records his zip code, his electricity tariff and his GPU — nor in `soul.md`,
nor in any structured field.

Measured 2026-07-28 against the live corpus:

| query | context returned | contains his name |
|---|---|---|
| "Do you know who I am?" | 3,149 chars | **no** |
| "what is my name" | 2,908 chars | **no** |
| "Jeremy" | 2,234 chars | yes |

BM25 cannot bridge "who am I" to "Jeremy" — there is no shared token. **You
have to already know the answer to retrieve it.** Identity is the one class
of fact that can never be fetched by matching the question against it.

**2. There is no identity block outside voice.** `runner._speaker_block`
already builds exactly the right thing — "## Who you're speaking with
(live)", name and role, injected as FACTS. Its first line is
`if not speaker: return ""`, and `speaker` is only ever populated for voice
turns. Typed chat gets nothing.

**3. She invented a policy to explain the gap.** "I don't use it as an
identifier for you. My focus is on being your companion and assistant, not on
storing personal details like names." No such policy exists anywhere. This is
a new shape of the failure `capability_claims.py` catches — not a claim about
what she CAN do, but a claim about how she is DESIGNED, invented on the spot
to cover a retrieval miss, then repeated word-for-word when challenged.

Note also her first answer was true and her second contradicted it. The turn
ran on `ollama:qwen3:8b`, the local standby during the budget outage, which
makes the fabrication more likely but is not the cause: a cloud model with no
name in context would also have had to improvise.

## The fix

### Phase 1 — identity is injected, never retrieved

Extend `_speaker_block` to cover every channel. When there is no voice
speaker, the operator is who she is talking to, by definition.

The content comes from documents carrying `about: user` in frontmatter. That
convention ALREADY EXISTS — the ingestion agent's prompt instructs it, and
`memory.graph` reads it (memory.py:686) — but it is used only to draw an arc
in the graph, nothing injects it, and **zero documents currently carry it**.
So the mechanism is half-built and needs connecting, not inventing.

Rails:

* **Bounded.** Identity rides on every turn, so it is capped hard — a few
  hundred tokens. Anything larger is a topic to be searched, not identity.
* **First-party only.** `about: user` on a fetched document must not put
  third-party text in every prompt. Filter by tier, not by tag alone.
* **Absence is stated, not left blank.** If no name is known the block says
  so explicitly — "You do not know the operator's name; ask." A gap she is
  TOLD about is a gap she asks about. A gap she is not told about is one she
  fills with invention, which is exactly what happened.

### Phase 2 — capture, because nothing ever wrote it

He said his name in conversation on at least three days and it never became
a durable fact. Journals record; nothing promotes.

The honest mechanism is not an LLM deciding what to keep. It is:

* a first-class place for it — the operator profile gains `about: user` and
  the fields an assistant obviously needs (name, what to call them,
  pronouns), and
* a measurable trigger: when the identity block says a field is UNKNOWN and
  the operator supplies it in conversation, that is the one moment where
  writing it is unambiguous. One field, stated by the operator, about the
  operator.

Deliberately NOT: inferring personal facts from transcripts. That is the
laundering shape — a model deciding what is true about a person from
speech-to-text, written durably, retrieved forever.

### Phase 3 — the invented-policy detector, only if it earns it

`capability_claims.py` catches "I can do X" when nothing grants X. The
sibling failure is "I am designed to do X" when nothing configures X. It is
harder: capabilities have a resolved toolset to check against, design claims
have no equivalent ground truth.

There is a cheap partial, though, and it follows from phase 1: once the
identity block states what is known, a claim about the operator's identity is
checkable against it — the same grounding move as `grounding.py`. "I can see
your name" is false when the block says the name is unknown.

Build phase 1 first. Most of the invention here was improvisation around a
gap; removing the gap removes the reason.

## Not in scope, but asked twice

He asked on 07-27 23:20 and again on 07-28 20:20 whether Nova could stand up
a Home Assistant instance and integrate with it. That is the capability
acquisition arc, tracked separately in
`docs/plans/capability-and-containment.md` — declarative HTTP tools first
(the shape that reuses `tool-creator` and the `tools` table), code execution
and container orchestration much later, and the phase 4 consent gate is what
both rest on.
