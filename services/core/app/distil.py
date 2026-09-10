"""Distillation: the facts out of a conversation, written down as claims with
receipts (S14-2).

Ninety-nine per cent of what memory holds by volume is raw transcript, and
searching a transcript returns transcript. S13 lifted recall from 6 of 20 to
12 of 20 and that is the ceiling of retrieval over a transcript, because the
answer is a sentence buried in an exchange rather than a note about the thing.
This module is the extractor: it reads a window of one person's conversation
and proposes NOTES — a subject, a title, a body composed from the row, a dated
citation, and, when a tool can answer the fact right now, the call that does.

It writes nothing. `distil()` returns what it verified and the counts behind
it; the beat that saves them, and the automatic running of a `live_source`
before she answers, are S14-3.

WHAT IS SHARED WITH THE COMMITMENT CHECK, AND WHAT IS DELIBERATELY NOT.
app/model_read.py is the spine both readers stand on — the budgeted window,
the completion with no turn behind it, the tolerant outermost-array parse and,
above all, the citation verified by a query. This module differs in one place
and it is the sharpest thing in the slice:

  * review.py reads ONLY his own messages. Once it is a row, her promise and
    his are indistinguishable, so the window itself excludes hers.
  * distillation reads BOTH SIDES, because a durable fact is usually in HER
    restatement — "24GB VRAM, 64GB system RAM" is her tidy version of what he
    said, and it is the sentence worth keeping.

But a fact whose only support is an assistant row is supported by something
the model itself produced, which verifies nothing about the world. So THE ROLE
TRAVELS WITH THE CITATION: `model_read.resolve_messages` returns the row's own
role, `Fact.said_by` is that role and nothing the model wrote, `Fact.her_words
_alone` is computed from it, and the composed body says so in as many words.
That distinction is code — a prompt sentence asking the model to mark its own
sources would be a request, and this is a property that has to hold.

THE MODEL CHOOSES WORDS; THE CODE CHOOSES FACTS. What the model returns is a
citation, a subject and a short phrasing. The phrasing becomes the note TITLE
and reaches nothing else. The BODY is composed here from the row — the quote
out of `messages.content`, the instant out of `created_at`, the role out of
`messages.role` — exactly as review.py builds its facts from the row and lets
the paraphrase reach only the title.

TWO THINGS THE MODEL IS SHOWN SO ITS CHOICES ARE DERIVED RATHER THAN INVENTED,
both read live, neither a list anyone maintains:

  * THE SUBJECTS THIS PERSON'S NOTES ALREADY USE, so a restatement reuses one
    and superseding actually fires. Read from the memory service's own export
    (`known_subjects`), because that is where the frontmatter is.
  * THE TOOLS THAT EXIST, from `tools.REGISTRY`, so a `live_source` names a
    real call. Whether the name and the arguments are real is not left to the
    showing: every proposed call is validated against the live registry and
    that tool's own schema before it survives.

A WRONG CHOICE IN EITHER COSTS AN UNNECESSARY OR A DUPLICATE NOTE, NEVER A
WRONG ANSWER. A subject the model failed to reuse writes a second note, and
both keep their dates and both are recallable; a subject it reused wrongly
retires a note that is still readable and still dated. Nothing here can make
an answer false, because everything a note asserts is quoted from a row that
was checked against the database.

JEREMY'S RULE, 2026-09-10, which is why `live_source` exists at all: hardware
specs "can be found ad hoc and shouldn't be written. Or if they're written,
that's fine for comparing if we ever update our system … but it should still
treat the ad-hoc command as truth and be done first." So this extractor STEERS
AWAY from distilling a fact a tool can answer — the prompt says to prefer not
to — and the steer is deliberately not a refusal, because a dated record of
what the box HAD is what "did that change?" is answered by. What is mechanical
is the consequence: an item that names a live source it cannot dispatch is
DROPPED WHOLE rather than written down without it. The model itself judged
that fact to be one a tool answers; storing it with no call attached would
turn a history note into something that presents as the current answer, which
is the exact failure the ruling is about. A dropped item costs a note that the
next pass can still propose.
"""

from __future__ import annotations

import io
import logging
import tarfile
import time
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from datetime import time as dtime

import httpx

from app import model_read, peers

logger = logging.getLogger("core")

PURPOSE = "distil_facts"

# The window. The caller owns the real one — the beat derives it from its own
# firing history and the backfill hands it twelve days — and this is what a
# single catch-up pass reads if nobody says. Both roles, so her restatement is
# readable; the budget is review.py's idiom (whole messages, newest first,
# everything older dropped once one would cross the line) and is spent over
# twice as many rows, which is stated rather than compensated for: a pass that
# reads less is a pass that proposes less, and the next one starts where the
# high-water mark is.
WINDOW = timedelta(days=1)
ROLES = ("user", "assistant")
MAX_MESSAGES = 80
CHAR_BUDGET = 8000

# What the model may spend words on. The title is her phrasing and the only
# thing here she chooses the wording of; the subject is a key, not a sentence.
SUBJECT_CHARS = 60
TITLE_CHARS = 120
# The quote in the body. A distilled note is meant to sit WHOLE inside the
# 400-character excerpt the index shows (slice-13), which is the mechanism
# that makes a note out-rank the transcript it came from — so the quote is
# bounded well under it and the composed lines around it are short.
QUOTE_CHARS = 300

# The completion's bounds — review.REVIEW_TIMEOUT's shape and for the same
# measured reason: a local 27B model reading a window of conversation and
# answering in structured JSON is not a judge call scoring one reply.
DISTIL_TIMEOUT = httpx.Timeout(connect=5.0, read=110.0, write=10.0, pool=5.0)
# MEASURED, and it budgets for the REASONING as well as the answer — which is
# the whole point (2026-09-10, on the live stack). A reasoning model spends
# max_tokens on its deliberation first and only then writes. On a dense window
# (26 messages, an 11.7k-character brief) qwen3.8:27b produced:
#
#     max_tokens=1200 -> 3,997 chars of reasoning, 0 chars of answer
#     max_tokens=5000 -> 6,416 chars of reasoning, 827 chars of answer
#
# 1,200 was sized for the answer alone, so every dense day of eight days of
# real conversation came back empty and the backfill reported an honest-looking
# zero. Anything that hits the cap now SAYS it hit the cap (model_read.complete)
# rather than reading as a window with nothing in it.
DISTIL_MAX_TOKENS = 5000

# Reading the subjects already in use. The export is the whole of this
# person's notes, so it is bounded by bytes as well as by seconds: over the
# cap the subjects are not read at all and the pass says so, which costs
# duplicate notes rather than a silent half-list.
SUBJECTS_TIMEOUT = httpx.Timeout(15.0)
SUBJECTS_MAX_BYTES = 8 * 1024 * 1024
SUBJECTS_HEAD_BYTES = 4096
MAX_SUBJECTS_SHOWN = 60

# How many tools are named in the brief. Every registered tool that only reads
# is a candidate; the cap exists so a registry that grows to hundreds cannot
# quietly eat the window the conversation is supposed to fill.
MAX_TOOLS_SHOWN = 40
TOOL_DESCRIPTION_CHARS = 120

DISTIL_SYSTEM = (
    "You are reading a conversation between a person and Nova, his assistant, and pulling out "
    "the DURABLE FACTS in it — the things that are still true next month and that someone "
    "would want to look up: preferences, decisions, how his machines are set up, who people "
    "are, how he wants things done. Not the small talk, not what either of you was doing at "
    "the time, not a question that got answered and closed.\n"
    "Answer with JSON and nothing else: a list of objects, each one "
    '{"message_id": "<the id printed with the message the fact is stated in>", '
    '"subject": "<a short dotted key for what the fact is ABOUT, e.g. hardware.vram>", '
    '"fact": "<the fact in a few words>"}.\n'
    "Cite the message the fact is actually STATED in — either side of the conversation may "
    "state it, and the tidier statement is often Nova's. Every item must carry the id of the "
    "message its words came from. An item with no id, or with an id that was not printed "
    "above, is discarded before anyone reads it, and so is one with no subject.\n"
    "SUBJECTS: reuse one of the subjects listed below whenever the fact is about that same "
    "thing, even when the wording differs — reusing it is what lets the newer fact replace "
    "the older one instead of sitting beside it. Invent a new subject only when none of them "
    "fits.\n"
    "TOOLS: for some facts a tool can answer the question right now, and then the tool's "
    "answer is the truth and this note is the dated record of what it used to be. REPORT "
    "THOSE FACTS TOO — a record of what the box had last month is exactly what 'did that "
    "change?' is answered with — and name the call that answers it now: add "
    '"live_source": {"tool": "<one of the tools listed>", "args": {...}}. The tools listed '
    "below are the ones that can be run. An item naming a call that cannot run is discarded "
    "whole, so name one of those or leave live_source out.\n"
    "If nothing in the conversation is worth keeping, answer []."
)


@dataclass(frozen=True)
class Fact:
    """One distilled note, ready to be written — and every field but `title`
    and `subject` composed from the row.

    `said_at` is the instant of the EXCHANGE, not of the pass: a fact distilled
    today out of a conversation two weeks ago is two weeks old to the ranker
    and to the prompt (store's `created` follows `said_at`). The writer passes
    `said_at.date()`; the datetime is kept here because the body prints the
    time as well as the day.
    """

    subject: str
    # The model's phrasing, and the ONLY thing here it chose the words of.
    title: str
    # Composed by `_body` from the row: the quote, the instant, the role, and
    # the stated caveats. Never the paraphrase.
    body: str
    message_id: uuid.UUID
    said_by: str
    said_at: datetime
    live_source: dict | None = None

    @property
    def source(self) -> dict:
        """The citation as memory stores it — the id AND the role of the row.
        `store.normalize_source` refuses one without a role, because a citation
        that lost its role cannot be told from one standing only on her own
        words."""
        return {"message_id": str(self.message_id), "role": self.said_by}

    @property
    def her_words_alone(self) -> bool:
        """Whether the only thing behind this fact is something the model
        produced. Computed from the ROW's role, never from anything the model
        said about its own source."""
        return self.said_by == "assistant"


@dataclass(frozen=True)
class Distillation:
    """What one pass read, proposed and verified — and what it could not do.

    Every count is of what LANDED, not of what was attempted: `verified` is the
    length of the facts themselves, so it cannot drift from them. `reason` is
    the stated cannot-check — a pass that could not read its window, reach the
    gateway or verify a citation reports that in words and NEVER an empty list,
    because an empty list from a pass that never looked is the false all-clear
    this whole area exists to stop.
    """

    facts: tuple[Fact, ...] = ()
    # Messages in the window this pass actually read.
    read: int = 0
    # Items the model returned that parsed into a citation and a subject.
    proposed: int = 0
    # Items thrown away: an invented citation, a missing subject, a live source
    # that could not dispatch. Each one is logged with the reason.
    dropped: int = 0
    # Items collapsed because an earlier message in the same pass claimed the
    # same subject. Not a drop — the newer statement is kept and the older one
    # would have been superseded by it the moment both were written.
    folded: int = 0
    reason: str | None = None
    # What this pass could not see, in words, when that did not stop it: the
    # subjects it could not read, a tool list it could not narrow. Each one
    # costs duplicate or unnecessary notes and none of them can make a note
    # wrong, which is why they are limits and not reasons.
    limits: tuple[str, ...] = ()

    @property
    def ran(self) -> bool:
        return self.reason is None

    @property
    def verified(self) -> int:
        return len(self.facts)


# -- what the model is shown ------------------------------------------------


def _scalar_of(text: str, key: str) -> str | None:
    """One scalar key out of one note's frontmatter, or None.

    A DELIBERATELY NARROW READER of a format the memory service owns. It reads
    the frontmatter block only, one scalar key, and gives up on anything it
    does not recognise — it is not a YAML parser and must never grow into one,
    because core has no YAML dependency and a second full reader of memory's
    file format is a thing that can disagree with the first.

    What a mistake here costs is bounded and stated: a subject this misses is
    a subject the model is not shown, which costs a duplicate note. It can
    never produce a wrong answer, because nothing read here is written to
    anything — it only widens or narrows what the model is offered.
    """
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    for line in lines[1:]:
        if line.strip() == "---":
            return None
        found, sep, value = line.partition(":")
        if not sep or found.strip() != key:
            continue
        return value.strip().strip("'\"").strip() or None
    return None


def _subject_of(text: str) -> str | None:
    return _scalar_of(text, "subject")


async def _notes_state(app, person_id) -> tuple[tuple[str, ...], str | None, str | None]:
    """The subjects this person's notes already use, read LIVE — and the limit
    on that read when there was one.

    Read out of the memory service's own export, which is the only place the
    frontmatter of every note is available to this process: /recall answers
    with hits and a hit does not carry its note's subject, and a copy of the
    subjects kept here would be exactly the hand-maintained list the house rule
    forbids — wrong the day she writes a note, and wrong silently.

    A read that fails is NOT fatal and is never silent. The subjects are shown
    so the model can REUSE one; without them it invents new ones and the pass
    writes notes that sit beside the old ones instead of replacing them. That
    is a duplicate, both dated, both recallable — a cost, not a falsehood — so
    it comes back as a stated limit and the pass goes on.
    """
    try:
        async with peers.client(app, peers.MEMORY, SUBJECTS_TIMEOUT) as client:
            response = await client.get("/export", params={"person_id": str(person_id)})
            response.raise_for_status()
            data = response.content
    except Exception as exc:  # noqa: BLE001 — every failure shape is stated
        return (
            (),
            None,
            (
                "the subjects already in use could not be read from memory, so a fact restated "
                f"here may be written as a new note beside the old one — {peers.reason(exc)}"
            ),
        )
    if len(data) > SUBJECTS_MAX_BYTES:
        return (
            (),
            None,
            (
                f"this person's notes export to {len(data)} bytes, over the "
                f"{SUBJECTS_MAX_BYTES}-byte ceiling this pass will read, so the subjects "
                "already in use were not read and a "
                "restated fact may be written as a new note beside the old one"
            ),
        )
    subjects: set[str] = set()
    newest: str | None = None
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            for member in archive:
                if not member.isfile() or not member.name.endswith(".md"):
                    continue
                handle = archive.extractfile(member)
                if handle is None:
                    continue
                head = handle.read(SUBJECTS_HEAD_BYTES).decode("utf-8", errors="replace")
                subject = _subject_of(head)
                if subject:
                    subjects.add(subject)
                # The newest exchange any distilled note cites — what the
                # backfill resumes AFTER. `said_at` and not `created`: a note
                # written today out of a two-week-old conversation covers that
                # conversation, and resuming from when it was WRITTEN would
                # skip the fortnight in between.
                said = _scalar_of(head, "said_at")
                if said and (newest is None or said > newest):
                    newest = said
    except (tarfile.TarError, OSError, EOFError) as exc:
        return (
            (),
            newest,
            (
                "this person's notes could not be unpacked to read the subjects already in use, so "
                f"a restated fact may be written as a new note beside the old one — {exc}"
            ),
        )
    ordered = tuple(sorted(subjects))
    if len(ordered) > MAX_SUBJECTS_SHOWN:
        return (
            ordered[:MAX_SUBJECTS_SHOWN],
            newest,
            (
                f"{len(ordered)} subjects are in use and only {MAX_SUBJECTS_SHOWN} were "
                "shown, so a fact about one of the rest may be written as a new note "
                "beside the old one"
            ),
        )
    return ordered, newest, None


async def known_subjects(app, person_id) -> tuple[tuple[str, ...], str | None]:
    """The subjects this person's notes already use, and the limit on that
    read. The pass's view of `_notes_state`, which also reports how far
    distillation has already reached — a fact only the backfill needs."""
    subjects, _newest, limit = await _notes_state(app, person_id)
    return subjects, limit


def live_tools() -> tuple[tuple, str | None]:
    """The tools a distilled note may name as its live source, and the limit on
    that reading when there is one.

    Derived, never hardcoded, and derived from the RIGHT predicate: the set is
    `live_facts.offerable()`, the same tool-level test the backend applies
    before running a stored call and the memory write door applies before a
    note may cite one. That matters more than it looks. `reads_only` alone is
    the wrong bar — fetch_url and web_search change nothing and still reach an
    address the note itself would choose — so offering every read tool would
    spend a model's attention proposing facts the write door then drops whole,
    and the pass would report work it did not do.

    The reading is stated, never silent: if the predicate leaves nothing to
    offer, that is a limit on this pass rather than a pass with no live
    sources in it.
    """
    from app import live_facts

    offered = live_facts.offerable()
    if offered:
        return offered, None
    return (), (
        "no registered tool may be run on the backend's own initiative, so no fact in this "
        "pass could be given a live source; every note it wrote is a record with nothing "
        "able to check it"
    )


def _tool_line(tool) -> str:
    """One tool, as the model needs to see it: its name, the arguments it
    takes (required ones marked), and its own description clipped."""
    parameters = tool.parameters if isinstance(tool.parameters, dict) else {}
    properties = parameters.get("properties")
    required = set(parameters.get("required") or [])
    names = []
    if isinstance(properties, dict):
        names = [f"{name}*" if name in required else name for name in properties]
    described = model_read.clip(tool.description, TOOL_DESCRIPTION_CHARS)
    return f"- {tool.name}({', '.join(names)}) — {described}"


def _brief(person_name: str, window, subjects: Sequence[str], tools_offered: Sequence) -> str:
    """The user message: the conversation with the id and the speaker on every
    row, then the subjects already in use, then the calls that can answer a
    fact now.

    Both sides are printed and both are labelled. The label is for the model's
    reading of the exchange — which sentence states the fact best — and it is
    NOT what marks the note: the role on the note comes from the row the
    citation resolves to, in `_fact`.
    """
    lines = [
        f"A conversation between {person_name} and Nova, oldest first. The id before each "
        "message is what you cite; the name is who wrote it.",
        "",
    ]
    for row in window:
        who = "Nova" if row["role"] == "assistant" else person_name
        lines.append(f"[{row['id']}] {who}, {row['created_at'].isoformat(timespec='minutes')}")
        lines.append(row["content"])
        lines.append("")
    if subjects:
        lines.append("Subjects her notes already use — reuse one when the fact is about that")
        lines.append("same thing, so the newer note replaces the older instead of joining it:")
        lines.extend(f"- {subject}" for subject in subjects)
    else:
        lines.append("Her notes use no subjects yet, so every subject here is a new one.")
    lines.append("")
    if tools_offered:
        lines.append("Calls she can run that answer a fact RIGHT NOW. A fact one of these")
        lines.append("answers is better left unwritten; if you write it, name the call:")
        lines.extend(_tool_line(tool) for tool in tools_offered)
    else:
        lines.append("She has no calls that could answer a fact directly.")
    return "\n".join(lines)


# -- what comes back --------------------------------------------------------


@dataclass(frozen=True)
class _Proposed:
    """One entry of the model's answer, after shape but before verification.
    Nothing in it is trusted: the citation still has to resolve to a row and
    the live source still has to be a call that could dispatch."""

    subject: str
    title: str
    live_source: object = None


def _proposals(raw: str) -> tuple[list[tuple[uuid.UUID, _Proposed]], int]:
    """(citation, proposal) pairs out of the model's answer, and how many
    entries were thrown away getting there.

    The SHAPE tolerance is model_read.parse_array's. What an entry has to SAY
    is this module's: a uuid, a subject and a phrasing. An entry missing the
    subject is dropped rather than given one — the subject is the superseding
    key, so a note without it is a note nothing can ever replace.

    An answer that parses to nothing is zero proposals, never an error: the
    model was asked and said nothing usable, which is a pass that looked.
    """
    out: list[tuple[uuid.UUID, _Proposed]] = []
    dropped = 0
    for entry in model_read.parse_array(raw, label=PURPOSE):
        cited = model_read.message_id(entry, "message_id", "id")
        subject = str(entry.get("subject") or "").strip()
        title = str(entry.get("fact") or entry.get("title") or entry.get("says") or "").strip()
        if cited is None or not subject or not title:
            dropped += 1
            logger.warning(
                "%s: dropped an item with no %s",
                PURPOSE,
                "citation" if cited is None else ("subject" if not subject else "wording"),
            )
            continue
        out.append(
            (
                cited,
                _Proposed(
                    subject=model_read.clip(subject, SUBJECT_CHARS),
                    title=model_read.clip(title, TITLE_CHARS),
                    live_source=entry.get("live_source"),
                ),
            )
        )
    return out, dropped


def _validated_live_source(proposed: _Proposed) -> dict | None:
    """The proposed call, checked against the LIVE registry and that tool's own
    schema — or a ToolFailure, which the caller turns into a dropped item.

    Imported at call time: app.tools reaches app.timers -> app.scheduler ->
    app.beats -> app.chat, and the beat that will call this module lives in
    that chain.
    """
    from app.tools import memory_tools

    if proposed.live_source is None:
        return None
    return memory_tools.validate_live_source(proposed.live_source)


def _body(row, live_source: dict | None) -> str:
    """The note's body, composed HERE from the row.

    The quote is `messages.content`, the instant is `created_at`, and the mark
    on a fact standing only on her own words is the row's own `role`. The
    model's phrasing is not in here at all — it is the title and nothing else —
    which is review.py's rule (the facts come from the row, never from the
    paraphrase) applied to the thing that gets written down and read back.

    The citation itself is NOT in the body on purpose: the body is what the
    index tokenises, and a path or a uuid in it would put terms in the index
    that every other distilled note also carries. It lives in the frontmatter,
    where nothing is tokenised (services/memory/app/store.py).
    """
    when = row["created_at"].isoformat(timespec="minutes")
    lines = [f'"{model_read.clip(row["content"], QUOTE_CHARS)}"', ""]
    if row["role"] == "assistant":
        lines.append(
            f"Nova wrote that herself, in her own reply on {when}. It stands on her words "
            "alone — nothing said to her is quoted here, so this note records what she "
            "wrote rather than something she was told."
        )
    else:
        lines.append(f"Said in conversation on {when}.")
    if live_source:
        lines.append("")
        lines.append(
            f"`{live_source['tool']}` answers this now, and that call is the truth: this note "
            "is only what was said, on the date above."
        )
    return "\n".join(lines)


def _fact(row, proposed: _Proposed, live_source: dict | None) -> Fact:
    """One verified row plus one proposal, as a note.

    THE ROLE COMES FROM THE ROW. `row["role"]` is what the verification query
    returned for the id the model cited, so a fact standing only on her own
    words is marked as such whatever the model said about where it came from.
    """
    return Fact(
        subject=proposed.subject,
        title=proposed.title,
        body=_body(row, live_source),
        message_id=row["id"],
        said_by=row["role"],
        said_at=row["created_at"],
        live_source=live_source,
    )


def _newest_per_subject(facts: list[Fact]) -> tuple[list[Fact], int]:
    """One fact per subject, keeping the one cited to the NEWEST row.

    Two facts on one subject in a single pass would be two notes, the second
    retiring the first the moment both were written — a superseded note born
    superseded, and the reader left to wonder which of two same-day notes was
    meant. Which one survives is decided from the rows' own timestamps and not
    from the order the model happened to answer in.
    """
    best: dict[str, Fact] = {}
    folded = 0
    for fact in facts:
        key = fact.subject.strip().casefold()
        current = best.get(key)
        if current is None:
            best[key] = fact
            continue
        folded += 1
        if fact.said_at > current.said_at:
            best[key] = fact
    return list(best.values()), folded


async def distil(
    app,
    pool,
    person,
    *,
    since: timedelta = WINDOW,
    max_messages: int = MAX_MESSAGES,
    char_budget: int = CHAR_BUDGET,
    subjects: Sequence[str] | None = None,
    through: datetime | None = None,
) -> Distillation:
    """Read this person's recent conversation and return the facts in it.

    `person` is whoever the notes belong to — the caller picks, so the backfill
    can walk a window this function knows nothing about. `subjects` overrides
    the live read for a caller that already holds them; None reads them.

    Nothing is written. What comes back is a `Distillation`: the facts, the
    counts behind them, and — instead of an empty list — the reason, in words,
    whenever the pass could not look.
    """
    limits: list[str] = []
    try:
        window = await model_read.window(
            pool,
            person.id,
            roles=ROLES,
            since=since,
            max_messages=max_messages,
            char_budget=char_budget,
            through=through,
        )
    except model_read.ReadFailed as exc:
        return Distillation(
            reason=f"the conversation could not be read, so there was nothing to distil — {exc}"
        )
    if not window:
        # Nothing was said in the window. That is a pass that LOOKED and found
        # nothing to read — and it does not pay for a completion to learn it.
        return Distillation()

    if subjects is None:
        subjects, subjects_limit = await known_subjects(app, person.id)
        if subjects_limit:
            limits.append(subjects_limit)
    tools_offered, tools_limit = live_tools()
    if tools_limit:
        limits.append(tools_limit)

    try:
        model = await model_read.chat_model(pool)
    except model_read.ReadFailed as exc:
        return Distillation(
            read=len(window),
            limits=tuple(limits),
            reason=f"the chat model could not be read, so the model was not asked — {exc}",
        )
    try:
        answer = await model_read.complete(
            app,
            system=DISTIL_SYSTEM,
            brief=_brief(person.name, window, subjects, tools_offered[:MAX_TOOLS_SHOWN]),
            model=model,
            headers=model_read.attribution(person.id, PURPOSE),
            timeout=DISTIL_TIMEOUT,
            max_tokens=DISTIL_MAX_TOKENS,
        )
    except model_read.GatewayRefused as exc:
        return Distillation(read=len(window), limits=tuple(limits), reason=str(exc))
    except model_read.ReadFailed as exc:
        return Distillation(
            read=len(window),
            limits=tuple(limits),
            reason=f"the gateway could not be asked to read the conversation — {exc}",
        )

    proposals, malformed = _proposals(answer)
    if not proposals:
        return Distillation(read=len(window), dropped=malformed, limits=tuple(limits))

    try:
        by_id = await model_read.resolve_messages(
            pool,
            person.id,
            [cited for cited, _proposed in proposals],
            roles=ROLES,
            # The window is the evidence: a fact may only cite a message this
            # pass actually read. Without this a step reading one day can cite
            # a row from another and date the note by it.
            within=[row["id"] for row in window],
        )
    except model_read.ReadFailed as exc:
        return Distillation(
            read=len(window),
            proposed=len(proposals),
            limits=tuple(limits),
            reason=(
                "the messages the model cited could not be verified, so nothing it said could "
                f"be written down — {exc}"
            ),
        )
    cited_rows = model_read.keep_cited(
        by_id, proposals, label=PURPOSE, what="a fact", whose=person.name
    )
    dropped = malformed + (len(proposals) - len(cited_rows))

    facts: list[Fact] = []
    for row, proposed in cited_rows:
        try:
            live_source = _validated_live_source(proposed)
        except Exception as exc:  # noqa: BLE001 — however it fails, it is not written down
            # The model itself judged this fact to be one a tool answers.
            # Writing it with no call attached would make a history note read
            # as the current answer, which is the ruling this field exists for.
            dropped += 1
            logger.warning(
                "%s: dropped the fact on %r citing message %s — its live source could not "
                "dispatch: %s",
                PURPOSE,
                proposed.subject,
                row["id"],
                exc,
            )
            continue
        facts.append(_fact(row, proposed, live_source))

    kept, folded = _newest_per_subject(facts)
    kept.sort(key=lambda fact: fact.said_at)
    return Distillation(
        facts=tuple(kept),
        read=len(window),
        proposed=len(proposals),
        dropped=dropped,
        folded=folded,
        limits=tuple(limits),
    )


# -- writing them down, and the one-off pass over what is already there --------


# How much conversation one backfill STEP reads. Small enough that a step is a
# normal-sized read (the same order as a beat's window), so a step that fails
# costs one step rather than the archive.
BACKFILL_STEP = timedelta(hours=12)
# The most steps one backfill call walks. A bound on cost that the caller can
# raise, and what is left is SAID — a backfill that stopped early and did not
# say so would leave notes nobody knows are missing.
BACKFILL_MAX_STEPS = 40
# The wall clock one backfill call may spend, measured rather than guessed
# (2026-09-10, live): one step against qwen3.8:27b took 48 s, nearly all of it
# reasoning tokens that are thrown away. Twelve days at twelve-hour steps is
# twenty-four of those — twenty minutes at best — inside a single tool call
# inside a turn somebody is waiting on. So a call does what it can, says where
# it stopped, and the next one RESUMES rather than starting again.
BACKFILL_BUDGET_SECONDS = 420.0


async def write_facts(app, person, facts) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Save each fact and report what LANDED: the paths, and the reasons for
    the rest.

    THE ONE WRITER for both the beat and the backfill, through
    `memory_tools.save_note` — which is itself the single door that validates a
    stored live_source against the live registry. A fact naming a call the
    backend would not run is refused HERE with the reason, rather than written
    as a note that reads like the current answer with nothing able to check it.

    One failure never costs the others: each save is its own try, and the
    caller counts paths rather than attempts.
    """
    from app import tools
    from app.tools import memory_tools

    ctx = tools.context_for(app, person)
    written: list[str] = []
    failed: list[str] = []
    for fact in facts:
        try:
            path = await memory_tools.save_note(
                ctx,
                title=fact.title,
                content=fact.body,
                subject=fact.subject,
                said_at=fact.said_at.date() if hasattr(fact.said_at, "date") else fact.said_at,
                source=fact.source,
                live_source=fact.live_source,
            )
        except Exception as exc:  # noqa: BLE001 - the reason is the record
            logger.warning("could not save distilled note %r: %s", fact.title, exc)
            failed.append(f"{fact.title!r} — {peers.reason(exc)[:200]}")
        else:
            written.append(path)
    return tuple(written), tuple(failed)


@dataclass(frozen=True)
class Backfilled:
    """What one backfill call covered and what it wrote. Counted from the steps
    that actually ran, never from the steps that were planned."""

    steps: int = 0
    read: int = 0
    proposed: int = 0
    written: tuple[str, ...] = ()
    failed: tuple[str, ...] = ()
    # The instant the walk reached. A later call resumes from here.
    through: datetime | None = None
    # What is still undistilled, in words, when the walk did not reach now.
    remaining: str | None = None
    # Steps that could not run, each with its reason. A backfill goes ON past
    # one — a gateway blip must not abandon eleven days — and every one of them
    # is named, because a step nobody distilled is a hole in the notes that
    # nothing else would ever report.
    problems: tuple[str, ...] = ()
    reason: str | None = None

    @property
    def ran(self) -> bool:
        return self.reason is None


def _resume_after(reached: str | None) -> datetime | None:
    """The instant a walk picks up from, out of the newest `said_at` any
    distilled note carries.

    A date, not a datetime: `said_at` is stored as one, so the day it names is
    read as its START. That deliberately re-reads the day already covered
    rather than skipping the rest of it — a repeated fact supersedes itself and
    costs a model round, and a skipped one is a hole nobody ever finds.

    Unparseable is None, which sends the walk to the beginning of the history:
    the safe direction, for the same reason.
    """
    if not reached:
        return None
    try:
        return datetime.fromisoformat(reached).replace(tzinfo=UTC)
    except ValueError:
        try:
            return datetime.combine(date.fromisoformat(reached[:10]), dtime(), tzinfo=UTC)
        except ValueError:
            return None


async def oldest_message(pool, person_id) -> datetime | None:
    """When this person's history starts, or None when they have none."""
    return await pool.fetchval(
        "SELECT min(m.created_at) FROM messages m JOIN conversations c ON c.id = m.conversation_id "
        "WHERE c.person_id = $1",
        person_id,
    )


async def backfill(
    app,
    pool,
    person,
    *,
    since: datetime | None = None,
    step: timedelta = BACKFILL_STEP,
    max_steps: int = BACKFILL_MAX_STEPS,
    budget: float = BACKFILL_BUDGET_SECONDS,
) -> Backfilled:
    """Distil the conversation that is already stored, OLDEST FIRST.

    The beat keeps up with what is said from now on; this is the twelve days
    that were already there when it was built. It is the same pass, walked over
    the archive in steps instead of over the last hour.

    OLDEST FIRST IS NOT A PREFERENCE. Superseding is last-write-wins by
    subject: writing a note on `hardware.vram` retires this person's earlier
    live note on it. Walk the archive newest-first and the OLDEST statement of
    every restated fact ends up as the live note, with the current one filed as
    its own predecessor — every restated fact wrong, quietly, in exactly the
    way that looks fine until someone asks.

    IT RESUMES. With no `since` given, the walk starts after the newest
    exchange any distilled note already cites (`said_at` off the notes
    themselves, read from the same export the subjects come from) — derived
    state, no new table, and it under-advances rather than over-advances: a
    span that yielded no facts is simply read again, which costs a repeat and
    never a gap. Only a person with no distilled notes at all starts at the
    beginning of their history.

    Bounded and STATED, in steps AND in wall clock. One step is a model round
    of tens of seconds, and twelve days of history is twenty-odd of them inside
    a tool call somebody is waiting on; when either bound stops the walk it
    says how much is left rather than stopping silently. A backfill that quit
    early without saying so leaves notes nobody knows are missing, which is
    indistinguishable from a person who never said those things.

    A step that fails does not end the walk. A gateway blip in the middle of
    day three must not cost days four through twelve; the reason is collected
    and the walk goes on, so `problems` names exactly which spans have no notes.
    """
    # Read once for the whole walk rather than per step: the subjects are the
    # same corpus every time, and forty exports would be forty chances for one
    # of them to fail differently. It also says how far distillation already
    # reached, which is where this walk picks up.
    subjects, reached, subject_limit = await _notes_state(app, person.id)
    start = since or _resume_after(reached) or await oldest_message(pool, person.id)
    if start is None:
        return Backfilled(
            reason="this person has no stored conversation, so there is nothing to distil"
        )
    now = await pool.fetchval("SELECT now()")

    written: list[str] = []
    failed: list[str] = []
    problems: list[str] = [subject_limit] if subject_limit else []
    steps = read = proposed = 0
    through = start
    deadline = time.monotonic() + budget
    while through < now and steps < max_steps and time.monotonic() < deadline:
        through = min(through + step, now)
        steps += 1
        found = await distil(app, pool, person, since=step, through=through, subjects=subjects)
        if not found.ran:
            problems.append(
                f"nothing distilled up to {through.isoformat(timespec='minutes')} — {found.reason}"
            )
            continue
        read += found.read
        proposed += found.proposed
        step_written, step_failed = await write_facts(app, person, found.facts)
        written.extend(step_written)
        failed.extend(step_failed)

    remaining = None
    if through < now:
        remaining = (
            f"the walk stopped at {through.isoformat(timespec='minutes')} after {steps} steps; "
            "everything said since then is still undistilled — run it again and it picks up "
            "from there"
        )
    return Backfilled(
        steps=steps,
        read=read,
        proposed=proposed,
        written=tuple(written),
        failed=tuple(failed),
        through=through,
        remaining=remaining,
        problems=tuple(problems),
    )
