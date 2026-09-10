"""The spine of a model read: a bounded window of rows, one completion with no
turn behind it, a tolerant parse, and a citation checked against the database.

Extracted from app/checks/review.py on 2026-09-10 when distillation (S14-2)
needed the same five steps. It is a SPINE and not a framework: every function
here does one mechanical thing and says nothing about what the read is FOR.
The sentences a caller reports — "there was no window to review", "nothing it
said could be used" — stay with the caller, because they are that caller's
claim about its own coverage, and two callers do not make the same claim.

What is shared is the part that must never differ between readers:

  * the WINDOW is whole messages, newest first until a character budget is
    spent, returned oldest first. Half a message is worse than an absent one,
    so the budget cuts between rows and never inside one.
  * the COMPLETION carries no turn. A check and a beat pass run as
    `run(app, pool)`; there is no turn to attribute to, so what can be said is
    said (purpose, person, the beat role) and nothing is guessed. Every way the
    gateway can fail to produce an answer raises, so a caller can never mistake
    a socket that refused for a model that had nothing to say.
  * the PARSE is tolerant about shape and about nothing else: the outermost
    JSON array anywhere in the text, so a fence or a sentence around it costs
    nothing, and an answer that parses to nothing is ZERO items rather than an
    error — the model was asked and said nothing usable, which is a read that
    happened.
  * the VERIFICATION is a query. A cited id must resolve to a row of this
    person's, and one that does not is DROPPED with a warning naming it. A
    verification that could not be MADE raises instead, because unverified
    claims must not become notes or notices and reporting none of them would
    say the read looked and found nothing.

Two exception types, and the difference is who owns the words:

  * `ReadFailed` carries a REASON FRAGMENT (peers.reason's output) that the
    caller wraps in its own sentence about what it therefore could not do;
  * `GatewayRefused` carries a WHOLE SENTENCE, because "the gateway refused
    (503)" is already the complete fact and the caller has nothing to add.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections.abc import Sequence
from datetime import datetime, timedelta

import httpx

from app import peers, settings_store

logger = logging.getLogger("core")

# The longest one completion may STREAM for, whatever it is streaming.
#
# Measured, not guessed (2026-09-10): a distil step against qwen3.8:27b took
# 48 s and 2,466 chunks for 602 characters of answer, because nearly all of it
# was reasoning that is thrown away. Another step on the same model streamed
# for over sixteen minutes and was still going. 150 s is three times the
# measured good case, so a normal read is never cut off, and it turns an
# unbounded hang into one stated sentence on one span of conversation.
STREAM_BUDGET_SECONDS = 150.0


class ReadFailed(RuntimeError):
    """A step of the read could not be made. `str(exc)` is the reason on its
    own, with no sentence around it — the caller supplies the sentence, since
    what the failure COST is the caller's fact and not this module's."""


class GatewayRefused(ReadFailed):
    """The gateway answered and it was not a completion — a status it refused
    with, or an error frame mid-stream. `str(exc)` is the whole sentence: there
    is nothing a caller could add to it that would be true of every caller."""


def clip(text: str, limit: int) -> str:
    """A short, whole prefix. Deliberately not chat._clip: that one appends a
    "(+N more chars)" tail, which is right in a trace and wrong inside a
    fingerprinted fact or a quoted note body, where every character is part of
    what is being claimed."""
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


async def chat_model(pool) -> str | None:
    """The configured chat model, or None for "the gateway's default".

    An empty setting means the default; sending "" would ask for a model
    literally named "". A setting that cannot be READ raises: the model was
    not asked, and a read that skipped the question is not a read that found
    nothing.
    """
    try:
        return await settings_store.read_value(pool, "chat.model")
    except Exception as exc:  # noqa: BLE001 — the reason is the record
        raise ReadFailed(peers.reason(exc)) from exc


async def window(
    pool,
    person_id,
    *,
    roles: Sequence[str],
    since: timedelta,
    max_messages: int,
    char_budget: int,
    through: datetime | None = None,
) -> list:
    """This person's messages in the named roles, newest first until the budget
    is spent, returned oldest first.

    `through` closes the window at an instant instead of at now, so the span is
    (`through` - `since`, `through`]. The live readers leave it None and get
    exactly the query they had. The BACKFILL sets it, because it walks the
    archive in steps and a relative-only window can only ever look at the most
    recent one — and it walks OLDEST FIRST, because superseding is last-write-
    wins by subject and reading newest first would leave the oldest statement
    of a fact as the live note.

    WHICH ROLES IS THE CALLER'S DECISION AND IT IS NOT A DETAIL. review.py
    passes ("user",) alone: once it is a row, her promise and his are
    indistinguishable, so the window itself excludes her replies rather than a
    prompt asking the model to. distil.py passes both, because a durable fact
    is usually in her tidy restatement of what he said — and then carries the
    role of the cited row onto the note, so a fact standing only on her own
    words is marked as such. Both are right for their reader; neither could be
    the default for the other.
    """
    try:
        rows = await pool.fetch(
            "SELECT m.id, m.role, m.created_at, m.content FROM messages m "
            "JOIN conversations c ON c.id = m.conversation_id "
            "WHERE c.person_id = $1 AND m.role = ANY($2::text[]) "
            "  AND m.created_at > COALESCE($5::timestamptz, now()) - $3::interval "
            "  AND ($5::timestamptz IS NULL OR m.created_at <= $5) "
            "ORDER BY m.created_at DESC, m.id DESC LIMIT $4",
            person_id,
            list(roles),
            since,
            max_messages,
            through,
        )
    except Exception as exc:  # noqa: BLE001 — the reason is the record
        raise ReadFailed(peers.reason(exc)) from exc
    kept: list = []
    used = 0
    for row in rows:
        used += len(row["content"])
        if used > char_budget:
            # Whole messages only — everything older goes with it.
            break
        kept.append(row)
    kept.reverse()
    return kept


def attribution(person_id, purpose: str) -> dict[str, str]:
    """Who is paying for this call and what it is for.

    No X-Nova-Turn-Id and no X-Nova-Timezone: a check and a beat pass are run
    as `run(app, pool)` and there is no turn here to read either off. Guessing
    at the beat turn that is probably open would attribute real money to a turn
    nobody verified this call belonged to, which is worse than the gateway
    recording it with no turn link. The purpose is the caller's own name and
    the role is the beat role every round of a beat walks, so the spend still
    lands where a beat's spend belongs.
    """
    from app import beats, chat

    headers = {
        peers.HEADER_PURPOSE: purpose,
        peers.HEADER_PERSON: str(person_id),
    }
    # Read from the SAME map chat uses to route a beat's rounds, so a renamed
    # or removed role sends nothing rather than a role the gateway never had.
    role = chat._ROLE_BY_KIND.get(beats.BEAT_TURN_KIND)
    if role:
        headers[peers.HEADER_ROLE] = role
    return headers


async def complete(
    app,
    *,
    system: str,
    brief: str,
    model: str | None,
    headers: dict[str, str],
    timeout: httpx.Timeout,
    max_tokens: int,
    budget: float | None = None,
) -> str:
    """One completion, every content delta concatenated —
    chat._collect_completion's path, followed rather than reused because that
    one records its round on a turn and these callers have none (see
    `attribution`).

    The same peer client, the same bearer, the same chunk parsing
    (chat._chunk_parts). Every way this can fail — the link unconfigured, the
    socket refused, a non-200, an error frame mid-stream — raises, so a caller
    can never report a pass that never reached a model.

    `budget` BOUNDS THE WHOLE STREAM, and it is not the same thing as the
    read timeout beside it (2026-09-10, found on the live stack). A read
    timeout bounds SILENCE: it fires when no byte arrives for N seconds. A
    reasoning model that is thinking is not silent — it emits a chunk every
    few milliseconds — so a 110 s read timeout let one distil step stream
    steadily for over sixteen minutes, holding the backfill and the owner's
    whole turn open behind it, with nothing anywhere able to stop it. The
    reasoning tokens are discarded (`chat._chunk_parts` reads `content` and
    nothing else), so all of that time bought nothing.

    Past the budget this RAISES rather than returning what it has. Partial
    content is a truncated JSON array, and a caller cannot tell "the model
    said nothing usable" from "we cut it off mid-sentence" — those are
    different facts and only one of them is about the conversation.
    """
    from app import chat

    # Read at CALL time, not bound as a default: a default is evaluated when
    # this function is defined, so a test that lowers the constant would still
    # wait the shipped budget and pass for the wrong reason — which is exactly
    # what happened the first time this was written (2026-09-10).
    budget = STREAM_BUDGET_SECONDS if budget is None else budget

    payload: dict = {
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": brief},
        ],
        "stream": True,
        "max_tokens": max_tokens,
    }
    if model:
        payload["model"] = model
    collected: list[str] = []
    truncated = False
    try:
        async with asyncio.timeout(budget), peers.client(app, peers.GATEWAY, timeout) as client:
            async with client.stream(
                "POST", "/v1/chat/completions", json=payload, headers=headers
            ) as response:
                if response.status_code != 200:
                    detail = (await response.aread()).decode(errors="replace")[:200]
                    raise GatewayRefused(f"the gateway refused ({response.status_code}): {detail}")
                async for line in response.aiter_lines():
                    line = line.strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[len("data:") :].strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    for choice in chunk.get("choices") or []:
                        if choice.get("finish_reason") == "length":
                            truncated = True
                    delta, _usage, error, _fragments = chat._chunk_parts(chunk)
                    if error is not None:
                        raise GatewayRefused(f"the gateway reported: {error}")
                    if delta:
                        collected.append(delta)
    except ReadFailed:
        raise
    except TimeoutError as exc:
        raise ReadFailed(
            f"the model was still answering after {budget:g}s and was cut off — it had produced "
            f"{sum(len(part) for part in collected)} characters of answer, and a reasoning model "
            "that thinks past the budget streams steadily rather than falling silent, so nothing "
            "shorter than this bound would ever stop it"
        ) from exc
    except Exception as exc:  # noqa: BLE001 — every failure shape is stated
        raise ReadFailed(peers.reason(exc)) from exc

    answer = "".join(collected)
    if truncated and not answer.strip():
        # THE MODEL NEVER REACHED ITS ANSWER, and that is not the same fact as
        # a model that answered nothing (2026-09-10, found on the live stack).
        #
        # A reasoning model spends `max_tokens` on its reasoning first. On a
        # dense window qwen3.8:27b burned the whole 1,200-token budget
        # deliberating and emitted zero characters of content; the tolerant
        # parse turned that into an empty list, and the pass reported "0 facts
        # proposed" — a read that was cut off, reading exactly like a read that
        # looked and found nothing. That is the same class of lie as a silent
        # fallback, and it is the reason a whole backfill over eight days of
        # real conversation reported an honest-looking zero.
        #
        # `finish_reason: "length"` is the protocol saying so, so this is read
        # rather than guessed at from the shape of the text.
        raise ReadFailed(
            f"the model used its whole {max_tokens}-token budget on its own reasoning and "
            "never reached an answer — a reasoning model spends that budget before it starts "
            "writing, so this is a budget too small for this window rather than a window with "
            "nothing in it"
        )
    return answer


def parse_array(raw: str, *, label: str) -> list[dict]:
    """The outermost JSON array in the model's answer, as its object entries.

    Tolerant about SHAPE — the array anywhere in the text, so a fenced block or
    a sentence around it costs nothing — and not tolerant about anything else:
    a non-list, and any entry that is not an object, drop here. What the
    entries MEAN is the caller's business; nothing that survives is trusted
    yet, because the citation check still has to find the row.

    An answer that parses to nothing is ZERO items, never an error: the model
    was asked and it said nothing usable, which is a read that happened.
    """
    start, end = raw.find("["), raw.rfind("]")
    if start == -1 or end <= start:
        logger.warning("%s: the model's answer carried no JSON list — %r", label, raw[:200])
        return []
    try:
        parsed = json.loads(raw[start : end + 1])
    except json.JSONDecodeError as exc:
        logger.warning("%s: the model's answer would not parse — %s", label, exc)
        return []
    if not isinstance(parsed, list):
        return []
    return [entry for entry in parsed if isinstance(entry, dict)]


def message_id(entry: dict, *keys: str) -> uuid.UUID | None:
    """The uuid an entry cites, under any of the given keys, or None.

    A string that is not a uuid is not a citation, and neither is a missing
    key: both come back as None and the caller drops the entry. Written here
    so the two readers cannot come to disagree about what counts as an id.
    """
    for key in keys:
        value = entry.get(key)
        if value is None:
            continue
        try:
            return uuid.UUID(str(value).strip())
        except (AttributeError, TypeError, ValueError):
            return None
    return None


async def resolve_messages(pool, person_id, ids: Sequence[uuid.UUID], *, roles: Sequence[str]):
    """The cited rows that actually exist, by id — the line of code that
    refuses when the model invents a citation.

    Every id is looked up as a message of THIS PERSON'S in one of the named
    roles. What comes back is a map, so an id that does not resolve is simply
    absent and `keep_cited` drops it with a warning; what a caller builds from
    the ones that do resolve, it builds FROM THE ROW.

    A query that could not be MADE raises. Unverified claims must not become
    notices or notes, and returning an empty map would be indistinguishable
    from a model that cited nothing real — a read that looked, rather than one
    that could not check.
    """
    try:
        rows = await pool.fetch(
            "SELECT m.id, m.role, m.created_at, m.content FROM messages m "
            "JOIN conversations c ON c.id = m.conversation_id "
            "WHERE m.id = ANY($1::uuid[]) AND c.person_id = $2 AND m.role = ANY($3::text[])",
            list(ids),
            person_id,
            list(roles),
        )
    except Exception as exc:  # noqa: BLE001 — the reason is the record
        raise ReadFailed(peers.reason(exc)) from exc
    return {row["id"]: row for row in rows}


def keep_cited(by_id: dict, items, *, label: str, what: str, whose: str) -> list[tuple]:
    """(row, payload) for every item whose citation resolved, and a warning
    naming every one that did not.

    The drop is silent to the caller's counts by design — a dropped item is
    reported as dropped, never as something found — and loud in the log,
    because a model inventing citations is a fact about the model that someone
    should be able to read afterwards.
    """
    kept: list[tuple] = []
    for cited, payload in items:
        row = by_id.get(cited)
        if row is None:
            logger.warning(
                "%s: dropped %s citing message %s — no message of %s's has that id",
                label,
                what,
                cited,
                whose,
            )
            continue
        kept.append((row, payload))
    return kept
