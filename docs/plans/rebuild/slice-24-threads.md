# Slice 24 — a thread is a room off the hallway

Branch `slice/s24`, to be cut from `rebuild/v4`.

## Where this came from

The Inbox work (now S25) hit a dead end I could not design my way out of.
A notice needs to be discussable, and both obvious answers are bad:

- **A new conversation per card** accumulates orphans. Poke at six notices
  over a week and you have six dead conversations in the list.
- **Inject the notice into the current conversation** derails whatever you
  were talking about, and — worse — means context appears in the transcript
  that the owner did not type.

Jeremy proposed the third thing, and it is the right one: "it comes into the
existing conversation because Nova is one long conversational chat unless we
use clear or reset. It'll have a way to open into the thread and have an
internal conversation/isolated contextual conversation about that topic…if
they back out they get to the global conversation."

So: Teams-style threads. A message can open into a room; the hallway records
that the room exists.

**Scoped as its own slice deliberately.** If threads are right they are right
for more than notices — a delegation to an agent, a long-running task, a
document worked through over days. Designing a general mechanism through one
narrow consumer produces something that fits only that consumer, so the
Inbox becomes the FIRST consumer rather than the reason.

## What a thread is, mechanically

**A conversation that hangs off a message.**

    ALTER TABLE conversations
        ADD COLUMN parent_message_id uuid REFERENCES messages (id) ON DELETE CASCADE;

That single nullable column is the whole model, and it buys four things at
once:

- The **stub** renders under exactly the message that spawned it, with a
  reply count that is `count(*)` of the child's messages. No second table,
  no denormalised counter to drift.
- The **parent conversation** is derivable — a message knows its
  conversation — so nothing needs a second pointer.
- **A thread cannot be the active conversation.** `active_conversation`
  selects `WHERE person_id = $1 AND active`; it gains
  `AND parent_message_id IS NULL`. Without that the next daily digest would
  be delivered into a thread, which is the kind of quiet wrong-place bug
  that takes a week to notice.
- **`ON DELETE CASCADE`** means clearing a conversation takes its threads
  with it. A thread hanging off a deleted message is unreachable by
  construction, so it must not survive as a row.

### Isolation is free, which is the best argument for this shape

A turn's history is `WHERE m.conversation_id = $1`. A thread IS a
conversation, so its history is already only its own messages. **No change
to prompt assembly is needed to isolate a thread** — the isolation falls out
of the data model rather than being enforced by a filter someone can
forget.

What DOES need one line: the thread's first turn should see the message it
hangs off, or she is answering a question about nothing. Prompt assembly for
a thread is:

    [the parent message] + [this thread's own messages]

One extra row, fetched by `parent_message_id`, which the thread row already
holds. Explicit, no duplication, and honest — she sees exactly what the
thread is about and what has been said in it.

## What she keeps inside a thread

Jeremy's second instinct, and the one that makes this humane: "I'm human and
have knowledge about things outside this specific topic, so I can also use
my general knowledge here as well."

Most of what that worry names is not actually at risk, and saying so
precisely matters:

| | In a thread |
|---|---|
| General knowledge | **Unchanged.** It is in the weights. She is not dumber in a room. |
| Her tools | **All of them.** No reason to take any away. |
| Long-term memory of him | **Recalled normally.** Recall is per-turn and semantic, so anything relevant surfaces here as anywhere. |
| Her skills, agents, devices | **Unchanged.** |
| The parent conversation's immediate transcript | **Not carried.** The only real subtraction. |

So the isolation is much softer in practice than "isolated" sounds. If
something from the main conversation matters, he says it — which is what a
person does when they step into a side room.

**Why not carry the parent transcript, or a summary of it.** A summary is
generated text about what HE said, and a wrong one is the exact failure
class this codebase keeps getting bitten by (`nova-forged-tool-receipt`,
`consent-loop-context-poisoning`). Carrying the whole parent transcript
would make the thread pointless — the interleaving is what we are escaping.

## Memory (decided 2026-09-15)

**Thread turns distil into long-term memory, tagged with the thread's
topic.** It is still him talking to her, and a thread is exactly where he
would explain something worth keeping ("the 6 GB is a game, that's fine").
Losing that would make a thread a goldfish.

`chat._ingest` posts `{person_id, conversation_id, exchange}`. It gains the
thread's topic so recall knows the context a fact came from. The rule stays
what S14 already enforces: a recalled note is a record of what was said,
never an instruction.

## The stub (decided 2026-09-15)

The main conversation shows the message plus `└─ 3 replies →`, tappable.

    Nova: qwen3.8:27b produced nothing in 2 of its last 2 rounds.
          └─ 3 replies →

A count and not the latest line: previewing the newest reply re-introduces
exactly the interleaving threads exist to remove. The count is derived from
the child's message count, so it cannot drift.

**This is what keeps "one long conversation" true.** Back out of a room and
the hallway still records that you went in.

## What gets built

**A.** Migration: `conversations.parent_message_id`, an index on it, and the
`parent_message_id IS NULL` term in `active_conversation`.

**B.** `POST /api/v1/conversations/{id}/messages/{message_id}/thread` —
create or fetch the thread for a message. Idempotent: a message has at most
one thread, so a second call returns the first.

**C.** Prompt assembly reads the parent message for a thread's turns.

**D.** Chat UI: the stub under a message, a thread view, and a back
affordance that returns to the hallway at the right scroll position.

**E.** Memory ingest carries the topic.

**F.** `GET /api/v1/conversations/active` and the conversation list exclude
threads, so nothing outside the chat UI trips over one.

## What refuses when this is wrong

- A thread cannot become the active conversation — a database predicate,
  not a convention, so a digest cannot be delivered into a room.
- A thread cannot outlive the message it hangs off (`ON DELETE CASCADE`).
- A message has at most one thread — enforced by a unique index on
  `parent_message_id`, so a double-tap cannot fork the room.
- The reply count is derived, never stored, so it cannot disagree with the
  thread.
- `test_no_approvals` stays green: none of this asks him anything or refuses
  anything on his behalf.

## Definition of done

Walked on a phone as well as a desktop, because the mobile surface is where
a navigation level costs most and where three defects hid this week:

1. A notice arrives in the main conversation; the stub says `0 replies`.
2. Opening it, asking a question, and getting an answer that plainly knows
   what the notice said and nothing about the unrelated thing discussed in
   the hallway ten minutes earlier.
3. Backing out returns to the hallway with the stub now reading `2 replies`.
4. Telling her something durable in the thread, then asking about it from
   the main conversation the next day and having her recall it.
5. The daily digest still lands in the main conversation while a thread is
   open.
6. All of the above at 393px, from the harness that renders the
   authenticated app at iPhone size.

## Out of scope, on purpose

- **Threads on arbitrary messages.** Every message could sprout one; that is
  a different product. This slice opens threads from a NOTICE, and the
  mechanism is general enough that a later slice can widen it.
- **Nested threads.** A room off a room is a filing system, not a
  conversation.
- **Unread state per thread.** Worth having, and it needs the Inbox's
  seen/unseen work (S25) rather than its own half-answer here.
