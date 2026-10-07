# Chat sessions and the split view

**Asked for 2026-10-07** (owner): "multiple chat sessions for nova … a section
of 'sessions' just like claude has … the split screen so we can have multiple
sessions in one window … drag and drop to split the screen … archive session,
delete them, close them, unarchive them."

Built the same day. What follows is what it does and the decisions in it, so
nobody has to rediscover them.

## What a session is

A top-level conversation he opened: `conversations.chat_session = true`
(`043_chat_sessions.sql`). It is a column, not a guess from `active`, because
the beats, every agent and every eval case keep inactive conversations of their
own, and S24 rooms are conversations too. None of those is listed or touched by
the session routes; a rename or archive aimed at one is a 400 that says what it
is.

Every hallway that existed before the migration became a session.

## The hallway is still exactly one of them: "main"

Nova was "one long conversational chat" (S24), and delivery depends on it:
digests, urgent notices and reminders set outside a chat land in
`active_conversation`. That stays the single rule. The session it returns is
**main**, shown with a home mark in the sidebar and a `main` badge in the pane.

- A new session is created **inactive**, so opening one never moves where a
  digest lands.
- **Make main** moves it on purpose, in one transaction (never two mains or
  none), and re-reads `active_conversation` to confirm. If they disagree, it
  is a 500 that says so.
- **Archiving main** hands the hallway to a fresh session on the next ask,
  never to a side session he happened to open.
- `main` in the list is derived from the same query that delivers, so the
  list and delivery cannot disagree.

A reminder set *in chat* now lands in the session it was set in.
`ToolContext.conversation_id` carries the turn's conversation. Before this,
`create_timer` used the active conversation because the context did not name
one, and with sessions that would have sent the reminder to the wrong chat. A
turn that is not in one of his sessions (a room, an agent or beat log) still
falls back to the hallway. `test_no_approvals` pins the context's fields, and
the field was added there on purpose: it says where output goes and decides
nothing.

## Routes (`services/core/app/conversations.py`)

| | |
|---|---|
| `GET /api/v1/conversations?archived=` | his sessions, latest activity first: `label` (his title, else his first line), `main`, `busy` (a turn running now, from the live maps), `message_count` |
| `POST /api/v1/conversations` | new session (inactive) |
| `PATCH /api/v1/conversations/{id}` | `title` (null clears it back to the derived label), `archived` |
| `POST /api/v1/conversations/{id}/main` | make it the hallway |
| `DELETE /api/v1/conversations/{id}` | transcript, rooms, attachments; the trace stays. A 409 while a turn runs in it. Returns the counts, including `timers_unlinked`: reminders that still fire but have no chat to land in, which the scheduler already reports on each firing |

## The web side

- **Sidebar → Sessions** (`components/layout/SessionsList.tsx`), also in the
  phone drawer. Click to open, `+` for a new one, and a menu per row with Open
  in split view, Rename, Make main, Archive and Delete (Delete asks first). The
  Archived list folds open below the sessions, each row with Unarchive and
  Delete. Every action waits for core, and the list is read again afterwards.
- **Split view** (`pages/chat/ChatWorkspace.tsx`). Drag a session onto a pane:
  its left or right quarter splits the view, its middle replaces what that pane
  shows. Up to four panes. The dividers drag (and take arrow keys). A pane
  closes from its header, and the session stays in the list.
- **One transcript per pane.** `chat-store` holds a `ChatState` per slot
  (pane) and every action names its slot, so a delta from the left pane's turn
  can only reach the left pane. Without a `<ChatSlot>`, `useChatStore()` is the
  `main` slot, which is the old single-pane behaviour, so every existing test
  ran unchanged.
- **The main pane is the URL** (`/chat?session=&thread=`), so a reload, a link,
  the phone and the iOS back gesture behave as before. Side panes keep their
  location in localStorage, per person. Losing that loses a layout, never a
  conversation. The layout rules are pure functions in `paneLayout.ts`.
- **The phone has one pane.** The side panes are kept for a wider screen but
  not shown.

## Running at once: the decision left open

The panes are independent, but **turns are still one at a time per person**.
`person_busy` (S24) queues a message typed in session B while session A is
mid-turn, and B's turn starts when A's ends. That gate was built after the
2026-09-12 and 09-14 measurements of two turns on one GPU, and this change
leaves it alone.

What this change fixes is how that looks. A send that core answers with 202
(queued) now becomes the queued chip (`sendQueued` in `chatReducer`). It used
to leave an empty bubble that settled into "the turn finished without a
reply". When the queued message's turn starts, the pane picks it up ("still
responding", with Stop) without waiting for the 15-second idle poll.

**If sessions should really run in parallel** (for example, when the chat model
is a cloud one and the GPU is not the constraint), the change is to scope that
gate. That is the owner's decision, not part of this change.

## Verified

- core: `tests/test_chat_sessions.py` (13), plus the full suite: 9375 passed.
- web: `paneLayout.test.ts`, `sessions-store.test.tsx`, the per-slot tests in
  `chat-store.test.tsx`, the `sendQueued` reducer tests and the pane tests in
  `ChatPage.test.tsx`, plus the full suite: 1579 passed.
- In a browser: `apps/web/e2e/sessions-walk.mjs` (list, new, drag-to-split,
  close, archive, unarchive, delete) against core and the dev server. A
  two-pane send ran against core's own `FakeGateway` served locally: each
  question and reply landed only in its own pane, and the second was queued
  and then picked up. It has **not** been walked on the deployed stack with a
  real model.
