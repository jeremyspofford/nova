"""Runs that are waiting on the operator, and the answer that restarts them.

Phase 3's read/write surface. `task_steps` defines the contract, the worker
drives it, and this is what the CHAT side touches: what is pending, and how
his reply gets to the step that asked.

WHY THE MODEL DELIVERS THE ANSWER AND THE BACKEND DOES NOT GUESS IT

The tempting design is mechanical: a run is blocked, so capture the operator's
next message as the answer. It is wrong, and the reason is worth keeping. His
next message is very often not an answer — "actually forget it", "what's the
weather", a correction to something else entirely — and a backend that
swallowed one of those would resume a build on a sentence that meant nothing
to it, silently, with no way to tell.

So `answer_task` is a tool she calls with his words, and the backend enforces
the parts that must not be judged: the run must exist, be blocked, and belong
to this conversation. What is deliberately NOT enforced is whether the words
are a good answer, because that is a reading of intent and nothing here can
check it.

The mechanical half is on the other side: `pending_for` puts the open question
into her prompt every turn while it is open, so she cannot forget it is there,
and the guard in the runner catches a turn that answers it in prose and calls
nothing.
"""

from __future__ import annotations

import json
import logging
import uuid as uuid_mod
from typing import Optional

from app import db

log = logging.getLogger(__name__)


async def pending_for(conversation_id: Optional[str]) -> list[dict]:
    """Blocked runs whose question was asked in this conversation.

    Scoped to the conversation on purpose: a question asked in one thread must
    not be answerable from another, or an answer meant for something else
    resumes the wrong build.
    """
    if not conversation_id:
        return []
    try:
        cid = uuid_mod.UUID(str(conversation_id))
    except ValueError:
        return []
    async with db.acquire() as conn:
        rows = await conn.fetch(
            """SELECT r.id, r.question, r.action_type, rec.title
                 FROM action_runs r
                 JOIN recommendations rec ON rec.id = r.recommendation_id
                WHERE r.status = 'blocked' AND r.answer IS NULL
                  AND r.conversation_id = $1
                ORDER BY r.updated_at""", cid)
    out = []
    for r in rows:
        q = r["question"]
        q = json.loads(q) if isinstance(q, str) else (q or {})
        out.append({"run_id": str(r["id"]), "title": r["title"],
                    "action_type": r["action_type"],
                    "key": q.get("key"), "question": q.get("text")})
    return out


async def answer(run_id: str, text: str,
                 conversation_id: Optional[str] = None) -> dict:
    """Deliver the operator's answer. The worker's claim query does the rest.

    Refuses anything that is not a blocked run awaiting an answer in THIS
    conversation. Never interprets the text.
    """
    text = (text or "").strip()
    if not text:
        return {"status": "error", "detail": "an empty answer is not an answer"}
    try:
        rid = uuid_mod.UUID(str(run_id))
    except ValueError:
        return {"status": "error", "detail": f"{run_id!r} is not a run id"}

    async with db.acquire() as conn:
        row = await conn.fetchrow(
            """UPDATE action_runs
                  SET answer = $2, answered_at = now(), updated_at = now()
                WHERE id = $1 AND status = 'blocked' AND answer IS NULL
                  AND ($3::uuid IS NULL OR conversation_id = $3)
             RETURNING id, question""",
            rid, text[:4000],
            uuid_mod.UUID(str(conversation_id)) if conversation_id else None)
    if row is None:
        return {"status": "error",
                "detail": ("no run is waiting on an answer under that id in "
                           "this conversation — it may have been answered "
                           "already, or it belongs to another thread")}
    q = row["question"]
    q = json.loads(q) if isinstance(q, str) else (q or {})
    log.info("Action run %s answered (%s)", rid, q.get("key"))
    return {"status": "ok", "run_id": str(rid), "key": q.get("key"),
            "detail": "answer recorded; the run resumes on the next tick"}
