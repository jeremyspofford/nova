# Slice 24 — a thread is a room off the hallway

Branch `slice/s24`, to be cut from `rebuild/v4`.

**Revision 2 (2026-09-15).** Revision 1 was reviewed by thirty-seven
independent readers against the real code. Thirteen concerns survived
being challenged, five of them rated as blocking the slice's value. All
thirteen are answered below; the five blocking ones changed the design
rather than adding caveats to it. What that review is worth, concretely:
revision 1 would have shipped a feature whose first consumer could not
reach it, into a room that did not know what it was about.

## Where this came from

The Inbox work (now S25) hit a dead end. A notice needs to be discussable,
and both obvious answers are bad: a new conversation per card accumulates
orphans, and injecting the notice into the current conversation derails it
and puts context in the transcript the owner did not type.

Jeremy proposed the third thing: "it comes into the existing conversation
because Nova is one long conversational chat unless we use clear or reset.
It'll have a way to open into the thread and have an internal
conversation/isolated contextual conversation about that topic…if they back
out they get to the global conversation."

**The stronger argument, which revision 1 failed to state.** It is not only
about derailment. A turn's history is bounded (`history_window`,
`HISTORY_CHAR_BUDGET`), so a long troubleshooting exchange in the hallway
pushes everything else out of the window — and the digest that started it
ages out fastest, because it is one message among many. A room keeps a
subject's exchange in its own window, where it stays available for as long
as the subject is live, instead of competing with the grocery list.

## What a thread is, mechanically

**A conversation that hangs off a message.**

    ALTER TABLE conversations
        ADD COLUMN parent_message_id uuid REFERENCES messages (id) ON DELETE CASCADE;
    CREATE UNIQUE INDEX conversations_one_thread_per_message
        ON conversations (parent_message_id) WHERE parent_message_id IS NOT NULL;

The partial index matters: postgres treats NULLs as distinct, so a plain
unique index would permit unlimited threadless conversations (correct) while
also permitting nothing useful. `WHERE parent_message_id IS NOT NULL` gives
exactly one room per message and leaves the hallway alone.

That column buys four things at once:

- The **stub** renders under exactly the message that spawned it, with a
  reply count that is `count(*)` of the child's messages — derived, so it
  cannot drift.
- The **parent conversation** is derivable; a message knows its own.
- **A thread cannot be the active conversation.** `active_conversation`
  (conversations.py:123-135) selects `WHERE person_id = $1 AND active ORDER
  BY created_at DESC`, and `active` defaults true — so without a
  `AND parent_message_id IS NULL` term, the newest room would be handed to
  `delivery.py`'s chat rung and the next digest delivered into it.
- **`ON DELETE CASCADE`** means clearing a conversation takes its rooms with
  it. A thread hanging off a deleted message is unreachable by construction.

### Isolation is free, which is the best argument for this shape

A turn's history is `WHERE m.conversation_id = $1`. A thread IS a
conversation, so its history is already only its own messages. **No change
to prompt assembly is needed to isolate a thread** — isolation falls out of
the data model rather than being enforced by a filter someone can forget.

## THE ANCHOR — and the decision revision 1 skipped

Revision 1's example stub was *"qwen3.8:27b produced nothing in 2 of its
last 2 rounds └─ 3 replies"*. **That sentence can never arrive as a
message.** Only the `stack` family declares `urgent` (checks/stack.py), and
only urgent notices are delivered as their own chat row. Everything else —
including `inference_degraded`, the example — arrives inside **one bundled
digest row per day**: the model's prose, the corrections, the coverage line
and the standing tail, joined into a single message.

And the notice has no link to that message. `_chat_rung` (delivery.py) reads
the id back and puts it in a detail STRING — `f"message {id} in conversation
{cid}"` — while `notices._COLUMNS` has no `message_id`. So S25's "Talk about
this" would have had nothing to hang a room off.

**Decision: one room per delivered MESSAGE, and the notice records which
message delivered it.**

    ALTER TABLE notices ADD COLUMN delivered_message_id uuid REFERENCES messages (id) ON DELETE SET NULL;

The value is already in hand at delivery time; it stops being stringified
and becomes a column. Consequences, stated rather than discovered later:

- **A room opened from a digest is a room about the digest**, which may
  cover several findings. That is what the hallway actually shows him, so it
  is the honest unit. The spec says this out loud so nobody reports it as a
  bug.
- A room opened from an urgent notice is about that one notice, because
  urgent notices are delivered as their own row.
- A notice not yet delivered (held by `_owed_today`) has no message and
  therefore no room until it is delivered. The Inbox must say so rather than
  offering a dead control — S25's problem, named here so it is not a
  surprise.

The rejected alternative — one chat row per notice — was rejected because
the digest exists precisely to be "ONE message about everything still owed
him" (beats.py), and five rows a day is the noise it was built to remove.

## THE SEED — the room must know what the notice actually said

The second blocking finding: the parent message is **model prose**. The
check name, the finding key and the facts (`timer_id`, `model`,
`consecutive_failures`) reach the digest as rows via `digest_brief`, and
survive into the message only if the model chose to write them. Open a room
and ask "which timer is failing?", and she would have had her own sentence
and nothing else.

**Prompt assembly for a thread is:**

    [the parent message]
    + [the CODE-COMPOSED facts of every notice delivered in that message]
    + [this thread's own messages]

The middle line is rows from the `notices` table — `title` and `facts`,
composed by checks in code — reached through the new `delivered_message_id`.
It is not a summary, so it does not hit this spec's own objection to
summaries: nothing generated it.

The `notices` tool stays in S25. It lets her look up notices the seed does
not carry; the seed means she is never empty-handed without it.

## What she keeps inside a thread

Jeremy's second instinct, and the one that makes this humane: "I'm human and
have knowledge about things outside this specific topic, so I can also use
my general knowledge here as well."

| | In a thread |
|---|---|
| General knowledge | **Unchanged.** It is in the weights. |
| Her tools | **All of them.** |
| Long-term memory of him | **Recalled normally** — per-turn and semantic. |
| Her skills, agents, devices | **Unchanged.** |
| The parent conversation's transcript | **Not carried.** The only subtraction. |

**Why not a summary of the hallway.** A generated summary of what HE said,
wrong, is the failure class this codebase keeps getting bitten by. If
something from the hallway matters, he says it — which is what a person does
stepping into a side room.

## Memory — what "tagged with the topic" actually requires

Jeremy decided thread turns reach long-term memory, tagged. Revision 1
listed that as one line of work. It is not, and the review was right to call
it a no-op as written:

- `_ingest` posts `{person_id, conversation_id, exchange}`; the memory
  service's `ingest()` **never reads `conversation_id`**. A new field on the
  core side changes nothing on its own.
- Meanwhile `model_read.window` selects across **every conversation the
  person owns**, ordered by `created_at` — so thread rows are ALREADY
  distilled today, and they are already interleaved with hallway rows at the
  exact moment memory is written.

So the honest split:

1. **Thread content already reaches memory.** State it, cite
   `model_read.window`, and stop claiming S24 delivers it.
2. **The tagging is a memory-service change**, and it is small if done the
   way the grain already runs: a thread's exchanges are written to their own
   document (`threads/<conversation-id>.md`) with a `title` in frontmatter.
   Every existing mechanism then does the right thing with no new concept —
   the indexer already tokenises title and body, so the topic is searchable
   and recall carries it.
3. **The topic is DERIVED, never authored**: the first ~120 characters of
   the parent message, role-prefixed. No model writes it; it cannot be
   wrong, only terse.
4. **Distillation must stop flattening rooms into the hallway.**
   `model_read.window` orders by `created_at` alone, so a room's exchange is
   shuffled into the hallway's at the point memory is written. It orders by
   `(conversation_id, created_at)` and renders each conversation as its own
   block, a thread's block headed by its parent message — the same
   `[parent] + [own rows]` shape prompt assembly uses.

## The stub

    Nova: qwen3.8:27b produced nothing in 2 of its last 2 rounds.
          └─ 3 replies →

A count, not the latest line: previewing the newest reply re-introduces
exactly the interleaving threads exist to remove. Derived from the child's
message count. **This is what keeps "one long conversation" true** — back
out of a room and the hallway still records that you went in.

## The phone, where this costs most

Three findings, all from the surface that had three layout defects and no
working navigation until this week.

**The room is a URL.** `/chat?thread=<conversation-id>` — a query parameter
on the existing route, not a new path. A new path would re-break the three
2026-09-15 fixes on arrival (fullWidth layout, the `Chat` tab highlight, the
composer's bottom padding), all of which hold by construction on `/chat`.
Being addressable means: the iOS back gesture is the OS back; a relaunch
inside a room returns to the room; and a reload mid-turn can recover the
in-flight reply.

**The store must be keyed by conversation.** Today it holds ONE
`conversationId`, and `reconcile` with a different id resets to an empty
chat. So: streaming in the hallway, tap the stub, and the hallway's
remaining deltas are dropped on the floor; back out, and the reply is only
recovered by ChatPage's MOUNT effect, which never reruns. Every event
dispatched from a stream carries the `conversationId` it was started for and
the reducer drops events for any other, and the single abort ref becomes a
per-conversation map so leaving a room never orphans a controller.

**Returning scrolls to the parent message**, not to the bottom — ChatPage
scrolls to the bottom on every conversation change today, which would
contradict "back at the right position".

## One GPU, two rooms

`chat_stream` locks and checks busy **per conversation**. A thread is a
different conversation, so a message typed in a room while the hallway is
mid-turn starts a SECOND concurrent turn on one card — the contention this
project spent 2026-09-12 and 09-14 measuring, self-inflicted.

**The busy gate becomes per person.** A message sent in a room while a
hallway turn runs is QUEUED, exactly as S15 already queues a second message
in one conversation — same semantics, wider scope, and the queued chip
already exists to show it.

## What gets built

1. Migration: `conversations.parent_message_id` + partial unique index;
   `notices.delivered_message_id`; the `parent_message_id IS NULL` term in
   `active_conversation`.
2. `_chat_rung` stores the message id it already reads back.
3. `POST /api/v1/conversations/{id}/messages/{message_id}/thread` — create
   or fetch. Idempotent: one room per message, enforced by the index.
4. A read for any conversation returning `/active`'s shape (`id`,
   `pending_turn`, `pending_turn_id`, `queued`) so the page can attach to a
   room the URL names.
5. Prompt assembly: `[parent message] + [notice facts] + [thread messages]`.
6. Chat UI: the stub, `?thread=` addressing, per-conversation store events
   and abort map, scroll-to-parent on return.
7. Busy gate per person.
8. Memory: thread exchanges to their own document with a derived title;
   `model_read.window` ordered and rendered per conversation.

## What refuses when this is wrong

- A thread cannot become the active conversation — a database predicate.
- A thread cannot outlive its message (`ON DELETE CASCADE`).
- A message has at most one room — a partial unique index, so a double-tap
  cannot fork it.
- The reply count is derived, never stored.
- A stream's events cannot land in the wrong conversation — the reducer
  drops them by id rather than trusting arrival order.
- Two turns cannot run at once for one person.
- `test_no_approvals` stays green: nothing here asks him anything.

## Definition of done

Mechanical, and read from the trace rather than from how a reply sounds.

1. A digest arrives; the stub says `0 replies`.
2. Open it and ask something only the notice's FACTS can answer — "which
   timer id is failing?" — and assert from the trace that the answer carries
   a fact from the notices row. Revision 1's "plainly knows what the notice
   said" would have passed on her own prose and proved nothing.
3. Back out: the hallway is at the parent message, and the stub reads
   `2 replies`.
4. Say something in the room whose subject exists ONLY there ("that 6 GB is
   a game, it's expected"). The next day, from the hallway, ask about it —
   and read the `memory_recall` span to confirm the hit carries the thread's
   title. A reply is a claim; the trace is the fact.
5. Reload inside a room mid-turn: the room comes back and the reply is still
   arriving.
6. Send in a room while the hallway is mid-turn: it queues, and the chip
   says so. Exactly one `llm_call` span is open at a time.
7. The daily digest still lands in the hallway while a room is open.
8. All of it at 393px — and the insets read from Display diagnostics on the
   device, not from a harness that cannot reproduce standalone mode.

## Out of scope, on purpose

- **Threads on arbitrary messages.** The mechanism is general; the UI opens
  rooms from notices. Widening it is a later decision, not a side effect.
- **Nested threads.** A room off a room is a filing system.
- **Per-thread unread state.** Wants the Inbox's seen/unseen work (S25).
- **One chat row per notice.** Considered and rejected above; revisit only
  if a digest room proves too coarse in use.
