"""Things he said he would do — the fourth watch area, and the only check that
has to ask a model.

The other three families are code reading rows: a timer paused with its reason
on the row, a spend figure against a cap, a socket that refused. This one
cannot be. "The things you said you'd do" is a sentence in a chat message, in
his words, with no column to select on — no query computes it. So this check is
a MODEL turn over a bounded window of his own messages.

Its findings are therefore CLAIMS, not rows, and four rules bind it. Every one
of them is a line of code here, never a sentence in the prompt:

 1. **It may never be urgent.** `Check.urgent` is False below, the registry
    overwrites every finding with that declaration
    (app/checks/__init__._declared), and tests/test_checks.py pins that exactly
    the stack family declares urgency. Jeremy's list has one entry and a
    model's reading of his chat history is not it — the honest line is that
    mechanically verified findings may wake you and this may not.

 2. **Every finding CITES the message it came from, and the citation is
    VERIFIED against the database.** An item with no id, or with an id that
    does not resolve to a message of HIS, is dropped by `_verified` before it
    can become a notice. A fabricated citation is the failure mode this whole
    design guards against, so it is checked, not trusted — and the check is a
    query, so nothing the model writes can satisfy it by wording.

 3. **The FACTS come from the row, never from the paraphrase.** `facts` is what
    the fingerprint hashes (app/checks/__init__.fingerprint), so it carries the
    message id, the instant he wrote it and a quote taken from the row itself.
    The model's own words for what the commitment WAS go in the `title`, marked
    as her reading — the title is never hashed, so a re-wording is not new news.
    v3 hashed the model's text and one model re-worded two findings into
    fourteen phone pushes in eight hours.

 4. **It does not run every hour.** The watch beat is hourly because fact
    checks are database and socket reads; this one costs a completion. It asks
    at most every REVIEW_EVERY, enforced here by reading when it last ran out
    of the watch beat's own firing history — a derived record, not a setting
    someone maintains and not a counter this module keeps.

A pass that is skipped for cadence, or that could not read its window, is
`CannotCheck` — ran=False with the reason — and never an empty list. That is
not politeness about wording: the beat only reconciles (clears live notices
whose fingerprint a check no longer finds) for a check that RAN, so an empty
"I didn't look this hour" would clear every outstanding commitment every hour
and he would hear about each one exactly once, forever. ran=False clears
nothing, which is what a pass that watched nothing is entitled to.

The visible cost of that, stated because it is not a bug to be fixed quietly:
five hours in six this check is one of the beat's `could_not`, so those watch
firings read "incomplete" and name the cadence as the reason. An hour it was
not due to look is an hour it did not look, and a beat that called that an
all-clear would be claiming a pass it never made.

The other honest limit is flicker. This check's findings are a model's reading,
so a pass where the model overlooks a commitment it reported before clears that
notice, and the next pass that sees it again raises it as new. The fold cannot
help — the fingerprint is right, the finding genuinely stopped being reported.
Muting is his lever there (a muted row keeps its fingerprint even after it
clears), and the six-hour cadence bounds how often the flicker can cost him a
line in a digest.

The window is deliberately narrow and time-bounded: HIS messages
(`role = 'user'` in a conversation he owns), from the last WINDOW, newest ones
first until the budget is spent. Two consequences worth stating out loud:

  * her own replies are NOT in it. A promise she made reads exactly like one he
    made once it is a row in his conversation, and the citation check could not
    tell them apart — so the window itself excludes them rather than the prompt
    asking the model to.
  * a commitment ages OUT. When his message falls past WINDOW the check stops
    finding it and the beat clears the notice. That says "I can no longer point
    at where he said it", not "he did it" — and it is deliberate: a nag with no
    message behind it any more is the v3 forever-nag.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import timedelta

import httpx

from app import identity, model_read, peers
from app.checks import CannotCheck, Check, Finding, NotDue

CHECK_NAME = "review_commitments"

# How often this check is willing to ask the model. Four looks a day: cheap
# enough to be invisible beside a chat turn, frequent enough that something he
# said this morning can be in tonight's digest — and not hourly, because a
# promise does not change in an hour and every pass is real money.
REVIEW_EVERY = timedelta(hours=6)

# The window: how far back his messages are still read, how many of them at
# most, and the character budget over them. The budget is chat.history_window's
# idiom — whole messages only, newest first, everything older dropped once one
# would cross the line — because half a message is worse than an absent one.
WINDOW = timedelta(days=14)
MAX_MESSAGES = 60
CHAR_BUDGET = 6000

# The roles this check reads, in the window AND in the verification — the one
# tuple, so the two can never drift apart. HIS OWN MESSAGES and nothing else:
# an assistant row in his conversation belongs to him too, so a promise she
# made would read exactly like one he made and the citation check could not
# tell them apart. The distiller passes both roles for the opposite and equally
# deliberate reason (app/distil.py), which is why this is a constant here
# rather than a default anywhere shared.
ROLES = ("user",)

# What memory is asked for alongside the messages, and how much of each note is
# shown. Notes are BACKGROUND: they carry no message id, so nothing in them can
# be cited and no finding can rest on one.
RECALL_K = 5
NOTE_CHARS = 400

# The query, written from what this check is LOOKING FOR and nothing else.
#
# It used to interpolate `owner.name`, and owner.name is an email address. The
# tokeniser split it, and "com" — a token in every URL in the corpus — came out
# as the highest-scoring term in the query, so the check's background notes
# were whichever note happened to quote the most links. A person's name is not
# evidence about their promises even when it IS a name; here it was a domain
# suffix. Derived from the intent, so what comes back is about commitments.
#
# test_checks_review.py pins the property mechanically: the owner's name must
# not appear in what is sent to /recall.
RECALL_QUERY = (
    "promised, said he would, plans to, going to, will do later, agreed to, "
    "follow up, outstanding task, errand, commitment he took on"
)

# The quote that goes in the facts (from the row) and the ceiling on the
# model's own words in the title.
QUOTE_CHARS = 240
COMMITMENT_CHARS = 200

# The completion's own bounds. A long first token is a model thinking, not a
# failure, and max_tokens bounds what a runaway answer can cost.
#
# The read budget was 30 s, chat.JUDGE_TIMEOUT's shape, and the first live beat
# (2026-09-08) proved that wrong: a judge call scores one short reply, while
# this one hands a 27B local model a 6,000-character window of his messages and
# waits for structured JSON. It timed out, so the one check that reads his
# commitments never ran on its first hour. Sized instead against the local
# model this box actually serves, and kept under checks.CHECK_DEADLINE_S so the
# deadline above still owns the outer bound.
REVIEW_TIMEOUT = httpx.Timeout(connect=5.0, read=110.0, write=10.0, pool=5.0)
# The whole check's own bound, declared on its Check so the registry applies it
# instead of the default meant for socket probes. Comfortably over the read
# budget above, so a slow model is reported as a slow MODEL and not as a check
# that mysteriously did not finish.
REVIEW_DEADLINE_S = 150.0
RECALL_TIMEOUT = httpx.Timeout(5.0)
REVIEW_MAX_TOKENS = 800

# States the truth AND is checked anyway: the id requirement below is enforced
# by _verified against the database, so a model that ignores every word of this
# produces zero findings rather than a false one.
REVIEW_SYSTEM = (
    "You are reading one person's own chat messages, looking for things HE said he would "
    "do and has not obviously finished — a promise, a plan, an errand, a task he took on "
    "himself. Not things he asked someone else to do, and not things anyone offered him.\n"
    "Answer with JSON and nothing else: a list of objects, each one "
    '{"message_id": "<the id printed with the message>", "commitment": "<what he said he '
    'would do, in a few words>"}. '
    "Every item must carry the id of the message its words came from. An item with no id, "
    "or with an id that was not printed above, is discarded before anyone reads it. "
    "If nothing looks outstanding, answer []."
)


def _chat():
    """app.chat, imported at CALL time.

    The registry imports this module, and app.chat's own import chain reaches
    back here (app.chat -> app.tools -> app.timers -> app.scheduler ->
    app.beats). Importing at module level would close that cycle; this is the
    same one-way idiom beats._scheduler uses, and it costs a sys.modules
    lookup. What is borrowed is chat's WIRE parsing — one owner for the SSE
    chunk shape and for memory's recall payload, so this check and a chat turn
    can never disagree about what came back.
    """
    from app import chat

    return chat


def _beats():
    """app.beats, imported at CALL time for the same reason (it imports
    app.chat at module level). Used to name the watch beat in the firing
    history query by its own constants rather than by two string literals that
    would silently stop matching if either were renamed."""
    from app import beats

    return beats


# A short, whole prefix — app/model_read.py's, shared with the distiller so
# the two readers cannot come to clip a quote differently. Deliberately not
# chat._clip: that one appends a "(+N more chars)" tail, which is right in a
# trace and wrong inside a fingerprinted fact, where every character is part
# of the hash.
_clip = model_read.clip


def _ago(delta: timedelta) -> str:
    """A duration a person can read, for the cadence sentence."""
    minutes = max(0, int(delta.total_seconds() // 60))
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h {minutes}m" if hours else f"{minutes}m"


async def _due(pool) -> None:
    """Raise CannotCheck unless REVIEW_EVERY has passed since this check last
    RAN, read from the watch beat's own firing history.

    DERIVED, not remembered: `timer_firings.delivery -> 'watch' -> 'ran'` is
    the list of checks that ran on a pass, written by the beat after the fact
    (beats.WatchResult.as_delivery), so this reads the same record the digest
    reads and there is no counter here to drift. A pass where this check could
    NOT run lands in `could_not` instead, so a gateway that was down does not
    spend the budget — the next hour tries again.

    A history that cannot be read is CannotCheck too. Running anyway would burn
    a completion every hour for as long as the read was broken, and skipping
    silently would be a pass nobody could tell from a clean one.
    """
    beats = _beats()
    try:
        row = await pool.fetchrow(
            "SELECT now() AS now, ("
            "  SELECT max(f.started_at) FROM timer_firings f "
            "  JOIN timers t ON t.id = f.timer_id "
            "  WHERE t.kind = $1 AND t.payload->>'handler' = $2 "
            "    AND f.delivery->'watch'->'ran' ? $3"
            ") AS last_ran",
            beats.BEAT_KIND,
            beats.WATCH,
            CHECK_NAME,
        )
    except Exception as exc:  # noqa: BLE001 — stated in words, never guessed past
        raise CannotCheck(
            "the watch beat's firing history could not be read, so this check cannot tell "
            f"whether it is due to ask the model again — {peers.reason(exc)}"
        ) from exc
    last_ran = row["last_ran"]
    if last_ran is None:
        return
    since = row["now"] - last_ran
    if since < REVIEW_EVERY:
        hours = REVIEW_EVERY.total_seconds() / 3600
        # NotDue, not CannotCheck: this check looked recently and whatever it
        # found is still standing as a notice, so the hour has no gap. Calling
        # a cadence skip "could not run" would make five hours in six report
        # incomplete and bury the real outage the signal exists for.
        raise NotDue(
            f"it last read his messages {_ago(since)} ago and it asks the model at most "
            f"every {hours:g}h, so it did not look this pass"
        )


async def _owner(pool) -> identity.Person:
    """Whose messages these are. No owner account means there is nothing of his
    to read — stated, never reported as a clean pass."""
    try:
        owner = await identity.owner(pool)
    except Exception as exc:  # noqa: BLE001 — the reason is the record
        raise CannotCheck(
            f"the owner could not be read, so there is nobody whose messages to "
            f"review — {peers.reason(exc)}"
        ) from exc
    if owner is None:
        raise CannotCheck("no owner account exists yet, so there are no messages of his to read")
    return owner


async def _window(pool, owner: identity.Person) -> list:
    """HIS OWN messages, newest first until the budget is spent, returned
    oldest first.

    `role = 'user'` in a conversation he owns, and nothing else: an assistant
    row in the same conversation belongs to him too, so the citation check
    could not tell her promise from his. The window is what makes the subject
    right, rather than a sentence in the prompt asking for it.

    THE ROLES ARE THIS CHECK'S OWN DECISION, which is why they are passed here
    and not defaulted in model_read.window: the distiller reads both sides on
    purpose and carries the role onto what it writes (app/distil.py). One
    fetch, two readers, two deliberate windows.
    """
    try:
        return await model_read.window(
            pool,
            owner.id,
            roles=ROLES,
            since=WINDOW,
            max_messages=MAX_MESSAGES,
            char_budget=CHAR_BUDGET,
        )
    except model_read.ReadFailed as exc:
        raise CannotCheck(
            f"his recent messages could not be read, so there was no window to review — {exc}"
        ) from exc


@dataclass(frozen=True)
class Background:
    """What memory gave this pass, and what it said about its own search.

    THREE FIELDS BECAUSE THE OLD ONE FLATTENED A LIE (MAJOR 3, 2026-09-10).
    `_notes` returned a bare list of notes, so `_brief` had exactly two states
    to write from — notes, or "Her memory returned no note bearing on this."
    That sentence is a claim about his notes, and it was written even when the
    meaning half of memory's search never ran.

    This is the caller most likely to be in that state, and not by accident:
    the embedder's keep-alive is derived from THIS beat's cadence
    (services/memory/app/embedding.py, DEFAULT_KEEP_ALIVE_SECONDS), so on a
    quiet machine the hourly watch is the first thing to ask, and a cold load
    measured 1,444-1,728 ms against a query budget of 1.6 s. The reduced
    search is the normal case here, and the flat claim was written on top of
    it.
    """

    notes: tuple[str, ...] = ()
    # memory's own sentence about the recall — which nothing it found, and
    # whether it searched with everything it has. Its words, never reworded:
    # whether the embedding model is installed is memory's business.
    statement: str | None = None
    # chat._degraded_from's reading of `retrievers`: set when a retriever did
    # not run, or ran over only part of the notes. The trigger for replacing
    # the flat claim above, and the reason the brief carries a caveat.
    limited: str | None = None


async def _notes(app, owner: identity.Person) -> Background:
    """Background from memory — a commitment she wrote down is often the only
    record that a chat line was ever a promise.

    A memory service that cannot be reached is CannotCheck, NOT a quieter pass.
    Reading his messages alone and reporting the result would be a narrower
    window than this check is defined over, and "nothing outstanding" out of a
    smaller world is exactly the false all-clear this slice exists to stop.

    A search that RAN but not with everything it has is deliberately NOT
    CannotCheck, and the reasoning is worth writing down because the two look
    alike (2026-09-10).

    This check is defined over HIS MESSAGES — `_window` reads every one of them
    in the last fourteen days, and that window is complete or the check raises.
    Memory is background here and is labelled as background in the brief: a
    note carries no message id, `_verified` drops any finding whose citation
    does not resolve to a message of his, and the brief says in as many words
    that nothing reported may rest on a note alone. So a partial memory search
    cannot make a finding FALSE; it can only make the check miss something.

    Raising CannotCheck on it would also be the wrong trade in the other
    direction: the semantic half is unavailable on any deployment where the
    owner has not pulled an embedding model, which is a supported state, so
    the rule would turn this check permanently off for those deployments and
    he would get nothing at all rather than a caveated something.

    So: it reports, and the limit is stated in the brief beside the notes, in
    memory's own words, instead of the flat claim. The line that stays
    CannotCheck is memory not answering — that is a window this check could
    not read, not a search that read less of one.
    """
    chat = _chat()
    try:
        async with peers.client(app, peers.MEMORY, RECALL_TIMEOUT) as client:
            response = await client.post(
                "/recall",
                json={
                    "query": RECALL_QUERY,
                    "person_id": str(owner.id),
                    "k": RECALL_K,
                },
            )
            response.raise_for_status()
            body = response.json()
    except Exception as exc:  # noqa: BLE001 — every failure shape is stated
        raise CannotCheck(
            "the memory service could not be asked what he has said he would do, so this pass "
            f"would have read a narrower window than the check is defined over — "
            f"{peers.reason(exc)}"
        ) from exc
    notes = [_clip(note, NOTE_CHARS) for note in chat._snippets(chat._results_from(body))]
    # The statement and the retriever report travel with the notes. Reading the
    # body through _results_from alone — which is what this did — discards the
    # only two things memory sends that say whether the search was whole.
    return Background(
        notes=tuple(notes[:RECALL_K]),
        statement=chat._statement_from(body),
        limited=chat._degraded_from(body),
    )


def _brief(owner: identity.Person, window, background: Background) -> str:
    """The user message: his own rows, each headed by the id it must be cited
    by, and the notes as background that carries no id.

    "Her memory returned no note bearing on this." is a claim about his notes,
    and it is only written when memory actually searched them with everything
    it has. When it did not, memory's own sentence replaces it and the caveat
    goes beside the notes either way — see Background. 2026-09-10.
    """
    lines = [
        f"{owner.name}'s own messages, oldest first. The id before each one is what you cite.",
        "",
    ]
    for row in window:
        lines.append(f"[{row['id']}] {row['created_at'].isoformat(timespec='minutes')}")
        lines.append(row["content"])
        lines.append("")
    if background.notes:
        lines.append("Notes from her memory, background only — they carry no id and cannot be")
        lines.append("cited, so nothing you report may rest on one alone:")
        lines.extend(f"- {note}" for note in background.notes)
    elif background.limited:
        lines.append(
            "Her memory returned no note bearing on this — and the search that looked was not "
            "the full one, so that is not evidence that nothing was written down:"
        )
    else:
        lines.append("Her memory returned no note bearing on this.")
    if background.limited:
        lines.append(background.statement or background.limited)
        lines.append(
            "Treat that as a limit on the search and not as evidence about the notes. His "
            "messages above were read whole and every finding must rest on one of them, so "
            "report from those; a commitment written down in different words may simply have "
            "been missed."
        )
    return "\n".join(lines)


def _attribution(owner: identity.Person) -> dict[str, str]:
    """Who is paying for this call and what it is for.

    No X-Nova-Turn-Id and no X-Nova-Timezone: a check is run as
    `run(app, pool)` — checks.run_all's whole signature — so there is no turn
    here to read either off. Guessing at the beat turn that is probably open
    would attribute real money to a turn nobody verified this call belonged to,
    which is worse than the gateway recording it with no turn link. The purpose
    is this check's own name and the role is the beat role every other round of
    a beat walks, so the spend still lands where a beat's spend belongs.
    """
    return model_read.attribution(owner.id, CHECK_NAME)


async def _ask(app, pool, owner: identity.Person, brief: str) -> str:
    """One completion, every content delta concatenated — model_read.complete's
    path, which is chat._collect_completion's followed rather than reused
    because that one records its round on a turn and a check has none (see
    _attribution).

    Every way this can fail — the link unconfigured, the socket refused, a
    non-200, an error frame mid-stream — becomes CannotCheck with what it said:
    the model was not asked, so this pass looked at nothing. The two shapes are
    kept apart because the words belong to different owners — a gateway that
    REFUSED has already said the whole of it, while a socket that would not
    open is a reason this check has to say what it cost.
    """
    try:
        model = await model_read.chat_model(pool)
    except model_read.ReadFailed as exc:
        raise CannotCheck(
            f"the chat model could not be read, so the model was not asked — {exc}"
        ) from exc
    try:
        return await model_read.complete(
            app,
            system=REVIEW_SYSTEM,
            brief=brief,
            model=model,
            headers=_attribution(owner),
            timeout=REVIEW_TIMEOUT,
            max_tokens=REVIEW_MAX_TOKENS,
        )
    except model_read.GatewayRefused as exc:
        raise CannotCheck(str(exc)) from exc
    except model_read.ReadFailed as exc:
        raise CannotCheck(f"the gateway could not be asked to read his messages — {exc}") from exc


def _items(raw: str) -> list[tuple[uuid.UUID, str]]:
    """The model's answer, parsed into (message id, its words) pairs.

    The SHAPE tolerance is model_read.parse_array's — the outermost JSON array
    anywhere in the text, so a fenced block or a sentence around it costs
    nothing — and what an entry has to SAY is this check's own: either spelling
    of each key, an id that is a uuid, words that are not empty, and one item
    per message. Nothing that survives is trusted yet: _verified still has to
    find the row.

    An answer that parses to nothing is ZERO findings, never an error: the
    model was asked and it said nothing usable, which is a pass that looked.
    """
    out: list[tuple[uuid.UUID, str]] = []
    seen: set[uuid.UUID] = set()
    for entry in model_read.parse_array(raw, label=CHECK_NAME):
        said = str(entry.get("commitment") or entry.get("what") or "").strip()
        message_id = model_read.message_id(entry, "message_id", "id")
        if message_id is None or not said or message_id in seen:
            # One message is one subject. A second reading of the same row
            # would be the same key and the same facts, so it would fold onto
            # the first the moment it was written down anyway.
            continue
        seen.add(message_id)
        out.append((message_id, _clip(said, COMMITMENT_CHARS)))
    return out


async def _verified(pool, owner: identity.Person, items) -> list[Finding]:
    """The line of code that refuses when the model invents a citation.

    Every cited id is looked up as a message of HIS — a `user` row in a
    conversation he owns — and an id that does not resolve is dropped with a
    warning naming it. What is built from the ones that do resolve is built
    from the ROW: its id, the instant he wrote it, and a quote of what it
    actually says. The model's own words reach only the title, marked there as
    her reading of it.

    A verification that could not be MADE is CannotCheck: unverified findings
    must not become notices, and reporting none would say the pass looked and
    found nothing.
    """
    try:
        by_id = await model_read.resolve_messages(
            pool, owner.id, [message_id for message_id, _said in items], roles=ROLES
        )
    except model_read.ReadFailed as exc:
        raise CannotCheck(
            f"the messages the model cited could not be verified, so nothing it said could be "
            f"used — {exc}"
        ) from exc
    findings: list[Finding] = []
    for row, said in model_read.keep_cited(
        by_id, items, label=CHECK_NAME, what="a finding", whose=owner.name
    ):
        when = row["created_at"]
        quote = _clip(row["content"], QUOTE_CHARS)
        findings.append(
            Finding(
                key=f"commitment:{row['id']}",
                # Her reading, said as her reading, beside what he actually
                # wrote. The title is never hashed, so re-wording it is not
                # new news.
                title=(
                    f"she reads his message of {when.isoformat(timespec='minutes')} as something "
                    f"he said he would do and has not finished: {said!r} — he wrote: {quote!r}"
                ),
                # Row facts only. The paraphrase is deliberately absent: it is
                # the one part of this finding a model chose, and putting it
                # here would re-raise the notice every time the wording moved.
                facts={
                    "message_id": str(row["id"]),
                    "said_at": when.isoformat(),
                    "quote": quote,
                },
            )
        )
    return findings


async def commitments(app, pool) -> list[Finding]:
    """The check: what he said he would do, out of his own recent messages.

    Cadence first, because it is the cheapest thing here and skipping it would
    mean paying for a completion to discover it was not time.
    """
    await _due(pool)
    owner = await _owner(pool)
    window = await _window(pool, owner)
    if not window:
        # He has written nothing in the window. That is a pass that LOOKED and
        # found nothing to read, so it is ran=True with no findings — and the
        # beat is free to clear anything it was still holding, because there is
        # no longer a message to point at (see the module docstring).
        return []
    background = await _notes(app, owner)
    answer = await _ask(app, pool, owner, _brief(owner, window, background))
    items = _items(answer)
    if not items:
        return []
    return await _verified(pool, owner, items)


CHECKS: tuple[Check, ...] = (
    Check(
        name=CHECK_NAME,
        # Longer than the registry default, for the one reason the default
        # cannot cover: this check waits on a local model reading a window of
        # his messages, and the shared 60 s cut it off on its first live beat.
        deadline_s=REVIEW_DEADLINE_S,
        describe=(
            f"Things he said he would do in his own messages of the last {WINDOW.days} days and "
            f"has not finished — a model's reading, asked at most every "
            f"{REVIEW_EVERY.total_seconds() / 3600:g}h, every finding citing the message it came "
            "from."
        ),
        # NEVER urgent, and this is the declaration the registry enforces on
        # every finding: a model's reading of his chat history may not wake
        # him. Jeremy's urgent list has exactly one entry and it is the stack
        # being down.
        urgent=False,
        run=commitments,
    ),
)

NAMES: tuple[str, ...] = tuple(check.name for check in CHECKS)
