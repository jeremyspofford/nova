"""Rewind a conversation to one of the owner's messages (chat-rewind epic, T4).

Every message after the target is WITHDRAWN (messages.withdrawn_by), never
deleted: threads, attachments and notices hang off message rows, and turns /
turn_spans are the audit trail. In mode='executions' every recorded action
her turns took from the target on is reverted newest-first through its tool's
own verified Tool.revert. Only a revert that RETURNED is listed undone; every
other action (failed call, no undo payload, no inverse, tool gone, revert
raised) and every turn that never closed (its actions were never recorded) is
listed not undone with the reason. Nothing is claimed that did not verify.

A marker message (role='user', rewind_id set, content composed here, no model
call) is the persisted fact her next turn reads.

Order: the busy check, the withdrawal, the rewinds row and the claim on the
actions to revert commit together under queued.hold_conversation; the reverts
then run OUTSIDE the lock (they call services, and the lock must never be held
across slow work); then the outcome and the marker are written. From the
withdrawal to the marker the conversation reads busy (conversations.REWINDING,
T10), so a send queues instead of opening a turn mid-rewind; the queue is
drained once the window closes.
"""

from __future__ import annotations

import json
import uuid

import asyncpg

from app import agents, conversations, queued, tools
from app.identity import Person
from app.tools.base import ToolFailure

MODES = ("chat", "executions")

_QUOTE_MAX = 200


class RewindRefused(Exception):
    """The rewind cannot run; `reason` says why. Nothing was changed."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class RewindBusy(RewindRefused):
    """A turn is running in this conversation (the route maps this to 409)."""


def _quote(content: str) -> str:
    text = " ".join((content or "").split())
    return text if len(text) <= _QUOTE_MAX else text[: _QUOTE_MAX - 3] + "..."


def _marker_content(
    target_content: str, withdrawn: int, mode: str, undone: list, not_undone: list
) -> str:
    noun = "message" if withdrawn == 1 else "messages"
    parts = [
        f'[rewind] The owner rewound this conversation to his message "{_quote(target_content)}"'
        f" - {withdrawn} later {noun} withdrawn."
    ]
    if mode == "executions":
        if undone:
            parts.append("Undone: " + "; ".join(f"{u['tool']} ({u['line']})" for u in undone) + ".")
        else:
            parts.append("Undone: nothing.")
        if not_undone:
            parts.append(
                "Not undone: "
                + "; ".join(f"{n['tool'] or 'unknown'} ({n['reason']})" for n in not_undone)
                + "."
            )
        else:
            parts.append("Not undone: nothing.")
    else:
        parts.append("Chat only: no actions were reverted.")
    return " ".join(parts)


def _decoded(undo):
    """A stored undo payload as Python (jsonb may come back as text)."""
    payload = undo
    for _ in range(2):
        if not isinstance(payload, str):
            break
        try:
            payload = json.loads(payload)
        except ValueError:
            return None
    return payload


def _linked_child(row: asyncpg.Record) -> uuid.UUID | None:
    """The child agent turn a delegate_to_agent row links (its undo payload
    {"agent_turn_id": ...}, filed by agents.delegate), or None."""
    if row["tool"] != agents.DELEGATE_TOOL:
        return None
    payload = _decoded(row["undo"])
    if not isinstance(payload, dict) or payload.get("agent_turn_id") is None:
        return None
    try:
        return uuid.UUID(str(payload["agent_turn_id"]))
    except ValueError:
        return None


def _skip_reason(row: asyncpg.Record) -> str | None:
    """Why this action is not even attempted, or None when it can be."""
    tool = tools.REGISTRY.get(row["tool"])
    if tool is None:
        return f"the tool {row['tool']} is no longer registered, so nothing can put it back"
    if not row["ok"]:
        return "the call failed, so no undo was recorded for whatever it may have changed"
    if row["undo"] is None:
        return "the call recorded nothing to put back"
    if tool.revert is None:
        return f"{row['tool']} cannot be undone"
    return None


async def rewind(
    pool: asyncpg.Pool,
    app,
    person: Person,
    conversation_id: uuid.UUID,
    message_id: uuid.UUID,
    mode: str,
) -> dict:
    if mode not in MODES:
        raise RewindRefused(f"unknown rewind mode {mode!r}: it must be 'chat' or 'executions'")

    # Between the withdrawal commit and the marker write the conversation
    # reads busy (conversations.REWINDING), so no turn can open on a history
    # with the later rows gone and no marker; the lock itself is NOT held
    # across the reverts. Whatever happens, the window closes, and the
    # conversation's queue is drained: a message accepted in the window has
    # no running turn whose ending would release it.
    opened = False
    try:
        async with pool.acquire() as conn:
            async with conn.transaction():
                await queued.hold_conversation(conn, conversation_id)
                if await conversations.conversation_busy(conn, conversation_id):
                    raise RewindBusy(
                        "a turn is running in this conversation; rewind once it has finished"
                    )
                target = await conn.fetchrow(
                    "SELECT id, role, content, created_at, withdrawn_by, rewind_id "
                    "FROM messages WHERE id = $1 AND conversation_id = $2",
                    message_id,
                    conversation_id,
                )
                if target is None:
                    raise RewindRefused("that message is not part of this conversation")
                if target["rewind_id"] is not None:
                    raise RewindRefused("that message is a rewind marker, not one of your messages")
                if target["role"] != "user":
                    raise RewindRefused("a rewind goes back to one of your own messages")
                if target["withdrawn_by"] is not None:
                    raise RewindRefused("that message was already withdrawn by an earlier rewind")

                # The window opens here, before this transaction commits the
                # withdrawal: a send or drain waiting on this conversation's lock
                # reads it busy the moment the lock frees (T10).
                conversations.REWINDING.add(conversation_id)
                opened = True

                rewind_id = await conn.fetchval(
                    "INSERT INTO rewinds (conversation_id, person_id, target_message_id, mode) "
                    "VALUES ($1, $2, $3, $4) RETURNING id",
                    conversation_id,
                    person.id,
                    message_id,
                    mode,
                )
                withdrawn = await conn.fetch(
                    "UPDATE messages SET withdrawn_by = $1 "
                    "WHERE conversation_id = $2 AND created_at > $3 AND withdrawn_by IS NULL "
                    "RETURNING id",
                    rewind_id,
                    conversation_id,
                    target["created_at"],
                )

                actions: list[asyncpg.Record] = []
                unclosed: list[asyncpg.Record] = []
                if mode == "executions":
                    # Claimed here, under the lock, so a second rewind can never
                    # pick the same rows while these reverts are running.
                    own = await conn.fetch(
                        "UPDATE turn_actions a SET reverted_by = $1 FROM turns t "
                        "WHERE t.id = a.turn_id AND a.conversation_id = $2 "
                        "AND t.started_at >= $3 AND a.reverted_by IS NULL "
                        "RETURNING a.id, a.tool, a.ok, a.undo, a.seq, t.started_at",
                        rewind_id,
                        conversation_id,
                        target["created_at"],
                    )
                    # Delegated agent work (T9): the child turn sits in the
                    # agent's log conversation, reachable only through the link
                    # the delegate call recorded as its undo payload. Its actions
                    # are claimed here too and ordered in the delegate call's place.
                    place: dict[uuid.UUID, tuple] = {}
                    for row in own:
                        child = _linked_child(row)
                        if child is not None:
                            place[child] = (row["started_at"], row["seq"])
                    children: list[asyncpg.Record] = []
                    if place:
                        children = await conn.fetch(
                            "UPDATE turn_actions SET reverted_by = $1 "
                            "WHERE turn_id = ANY($2::uuid[]) AND reverted_by IS NULL "
                            "RETURNING id, tool, ok, undo, seq, turn_id",
                            rewind_id,
                            list(place),
                        )
                    keyed = [((r["started_at"], r["seq"], 0, 0), r) for r in own] + [
                        ((*place[r["turn_id"]], 1, r["seq"]), r) for r in children
                    ]
                    actions = [r for _, r in sorted(keyed, key=lambda kr: kr[0], reverse=True)]
                    unclosed = await conn.fetch(
                        "SELECT id, started_at FROM turns WHERE status IS NULL AND ("
                        "(conversation_id = $1 AND started_at >= $2) OR id = ANY($3::uuid[])) "
                        "ORDER BY started_at DESC",
                        conversation_id,
                        target["created_at"],
                        list(place),
                    )

        undone: list[dict] = []
        not_undone: list[dict] = []
        if mode == "executions":
            ctx = tools.context_for(app, person)
            for row in actions:
                reason = _skip_reason(row)
                ok, result = False, reason
                if reason is None:
                    undo = row["undo"]
                    payload = json.loads(undo) if isinstance(undo, str) else undo
                    try:
                        line = await tools.REGISTRY[row["tool"]].revert(payload, ctx)
                    except ToolFailure as exc:
                        result = str(exc) or "the revert refused without a reason"
                    except Exception as exc:  # a revert bug: stated, never undone
                        result = f"the revert crashed: {type(exc).__name__}: {exc}"
                    else:
                        ok, result = True, str(line)
                await pool.execute(
                    "UPDATE turn_actions SET revert_ok = $1, revert_result = $2 WHERE id = $3",
                    ok,
                    result,
                    row["id"],
                )
                if ok:
                    undone.append(
                        {"tool": row["tool"], "action_id": str(row["id"]), "line": result}
                    )
                else:
                    not_undone.append(
                        {"tool": row["tool"], "action_id": str(row["id"]), "reason": result}
                    )
            for turn in unclosed:
                not_undone.append(
                    {
                        "tool": None,
                        "turn_id": str(turn["id"]),
                        "reason": "that turn never closed, so its actions were not recorded "
                        "and nothing it did can be listed or undone",
                    }
                )

        content = _marker_content(target["content"], len(withdrawn), mode, undone, not_undone)
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    "UPDATE rewinds SET undone = $1::jsonb, not_undone = $2::jsonb WHERE id = $3",
                    json.dumps(undone),
                    json.dumps(not_undone),
                    rewind_id,
                )
                # After every row it withdrew, even when a stored timestamp is
                # ahead of this clock.
                marker_id = await conn.fetchval(
                    "INSERT INTO messages (conversation_id, role, content, rewind_id, created_at) "
                    "SELECT $1, 'user', $2, $3, GREATEST(now(), "
                    "  COALESCE(max(created_at) + interval '1 millisecond', now())) "
                    "FROM messages WHERE conversation_id = $1 "
                    "RETURNING id",
                    conversation_id,
                    content,
                    rewind_id,
                )

    finally:
        if opened:
            conversations.REWINDING.discard(conversation_id)
            # Function-local: app.chat imports half the app.
            from app import chat

            chat._spawn(chat.drain_queue(app, pool, conversation_id))

    return {
        "rewind_id": rewind_id,
        "marker_message_id": marker_id,
        "mode": mode,
        "withdrawn": len(withdrawn),
        "undone": undone,
        "not_undone": not_undone,
    }
