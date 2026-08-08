"""Is this completion an answer, or is the model coming apart?

THE INCIDENT, measured in the live database on 2026-08-07 with `main` on
`openrouter:~deepseek/deepseek-v4-flash-latest`:

  21:30:41  asked "Are you doing that eval auto recovery task?", she replied
            literally `8`. The llm_call span: `completion_chars: 1`,
            `completion_tokens: 2`, against `prompt_tokens: 32531` — and
            `status: ok`. Two rounds had already been retracted by the
            forged-receipt and narration guards; the third produced one
            character and the loop accepted it as the finished answer.
  20:52:36  a 475-character reply whose first 114 alphabetic characters were
            CJK pseudo-system text listing her own tools and instructing her
            not to fake calls. Nothing in Nova wrote that; the conversation
            is entirely English.
  20:45:29  "trainerPULL the qwen3:30b-a3b model onto this box now.I don't
            have an active goal…" — the operator's own message, verbatim,
            glued into the reply with no delimiter on either side.

Every one of those turns returned `status=ok`. That is the defect this module
exists to close: `model_chain` derives a cross-tier standby and
`llm/router.py` fails over on ERRORS, but a model returning garbage is not an
error, so failover never fired. A goal Jeremy had approved could not complete
because junk was accepted as a finished answer.

WHAT IS AND IS NOT HERE. Every signal is MECHANICAL — a measurement of the
completion against the turn's own inputs. There is no list of bad answers and
no judgement about quality, because the moment a check needs an opinion it
needs a model, and a model is what is already failing.

Nothing here can tell you an answer is WRONG. It can tell you the completion
is not an answer at all:

  near_empty      nothing was said and nothing was done
  echoed_user     the reply is the question, regurgitated
  foreign_script  substantial text in a writing system that appears nowhere
                  in the prompt or the conversation

THE FALSE POSITIVE IS THE EXPENSIVE FAILURE. A guard that pushes good turns
into retry loops costs real money and ends in a failed turn where a fine
answer stood; the thresholds below are therefore calibrated tight against the
real incidents rather than wide against imagined ones, and every one of them
is a named constant in this one place. "Done." after a real tool call is a
legitimate reply and `near_empty` cannot fire on it by construction — see the
`tools_called` gate, which is tested explicitly.

That gate is not optional for `echoed_user` either, and its absence was a
real defect: a turn that had already created the automation and then wrote
"Adding a nightly backup of the postgres volume at 3am. I created…" was read
as an echo, retracted, re-asked with no hint, restated the same way, and
ended as a `type: error` telling the operator there was no answer — while the
automation it had just built sat there enabled. Every signal that reasons
about how little was SAID has to know whether anything was DONE.
"""

from __future__ import annotations

import difflib
import logging
import re
import unicodedata
from typing import Iterable, Optional

log = logging.getLogger(__name__)

# ── signal names (stored in model_health.signal; never spelled inline) ──────
NEAR_EMPTY = "near_empty"
ECHO = "echoed_user"
FOREIGN_SCRIPT = "foreign_script"

#: How each signal reads to the operator in a REPLY. Deliberately separate
#: from the evidence string: the evidence quotes the completion, and a note
#: that quotes a block of foreign-script junk both puts it back on the screen
#: and — because notes are persisted as part of the reply — teaches the next
#: turn's `foreign_script` derivation that the script was expected all along.
#: Evidence goes to the log and the health row; this goes on screen.
LABEL = {
    NEAR_EMPTY: "it returned no answer at all",
    ECHO: "it handed your own message back instead of answering",
    FOREIGN_SCRIPT: ("it wrote in a script that appears nowhere in this "
                     "conversation"),
}

#: The synthetic `error_class` a degenerate round is reported under. It is a
#: member of runner._FALLBACK_CLASSES so the SAME `_fallback_target` /
#: `model_chain` machinery that handles a dead provider handles this — one
#: failover mechanism, not two.
ERROR_CLASS = "degenerate"


# ── thresholds, all of them, in one place ──────────────────────────────────

#: A reply this short or shorter, with fewer than `_NEAR_EMPTY_MIN_ALPHA`
#: letters in it, is not an answer. Four characters, because the real case was
#: ONE ("8") and every character of headroom above that is a legitimate reply
#: it could eat: "No.", "Yes", "ok", "42" all survive on the letter count or
#: the length, and a genuine numeric answer ("3.14159", "1,204") is longer.
_NEAR_EMPTY_MAX_CHARS = 4
#: Two letters, so a bare number or a lone punctuation mark trips it and any
#: real word does not.
_NEAR_EMPTY_MIN_ALPHA = 2
#: …and only when the person actually asked something. "hi" gets "hey" and
#: that is the whole conversation; 16 characters is above every greeting and
#: below the 43-character question that got "8".
_SUBSTANTIVE_USER_CHARS = 16

#: An echo is only meaningful for a message with enough shape to be echoed.
_ECHO_MIN_CHARS = 24
#: …and it has to be substantially the WHOLE message, not a shared phrase.
#: The measured case reproduced 46 of 47 characters (0.98).
_ECHO_USER_FRACTION = 0.8
#: When the echo is properly delimited (quoted, or on its own line) it is a
#: quotation, which is legitimate — unless it is essentially the entire
#: reply, in which case nothing else was said.
_ECHO_REPLY_FRACTION = 0.8

#: Alphabetic characters in scripts absent from the input. 24, because the
#: measured case had 114 and a legitimate inline translation ("你好 means
#: hello") has a handful.
_SCRIPT_MIN_CHARS = 24
#: …and a tenth of the reply's letters. The measured case was 114 of 377
#: (0.30); a short quoted phrase inside a real English answer is far below.
_SCRIPT_MIN_FRACTION = 0.10

#: Both string comparisons are O(n·m). Replies are small and prompts are not,
#: so the inputs are clipped — a degenerate reply is degenerate in its first
#: few thousand characters.
_MATCH_WINDOW = 4000

#: Evidence stored on the health row, bounded and scrubbed.
_EVIDENCE_CHARS = 200

_WS = re.compile(r"\s+")


# ── helpers ────────────────────────────────────────────────────────────────

def _normalise(text: str) -> str:
    """Casefolded, whitespace-collapsed. Both echo comparisons run on this."""
    return _WS.sub(" ", (text or "").strip()).casefold()


_LATIN = "LATIN"


def _script_of(ch: str) -> Optional[str]:
    """The writing system one character belongs to, or None if it is not a
    letter at all.

    DERIVED FROM THE UNICODE DATABASE, never from a table of languages: the
    first word of a character's official name is its script ("LATIN SMALL
    LETTER A" -> LATIN, "CJK UNIFIED IDEOGRAPH-4E2D" -> CJK, "CYRILLIC …" ->
    CYRILLIC). A codepoint Python cannot name is not evidence of anything and
    is skipped rather than guessed at.

    The ASCII branch is a shortcut, not a second answer: every alphabetic
    ASCII codepoint is named "LATIN CAPITAL/SMALL LETTER x", so it produces
    exactly what the lookup would. It exists because this runs over the whole
    prompt on every round and `unicodedata.name` per character of a 100k
    transcript is not free.
    """
    if not ch.isalpha():
        return None
    if ch.isascii():
        return _LATIN
    try:
        return unicodedata.name(ch).split(" ", 1)[0]
    except ValueError:
        return None


def _script_counts(text: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for ch in text or "":
        script = _script_of(ch)
        if script:
            counts[script] = counts.get(script, 0) + 1
    return counts


def _scripts_present(text: str, wanted: set[str]) -> set[str]:
    """Which of `wanted` appear in `text`, stopping as soon as all are found.

    Membership, not counts: `foreign_script` only asks whether a script the
    REPLY used appears in the input, so counting the input is work nobody
    reads. The early exit is what makes this cheap on the ordinary turn — an
    English reply asks about {LATIN} and the answer arrives on the first
    letter of a 100k-character prompt.
    """
    found: set[str] = set()
    for ch in text or "":
        script = _script_of(ch)
        if script in wanted and script not in found:
            found.add(script)
            if len(found) == len(wanted):
                break
    return found


def input_text(messages: Iterable[dict]) -> str:
    """Everything the model was shown this round, flattened to one string.

    `messages` is the corpus by construction — system prompt, history, tool
    results — so the expected-scripts derivation needs no bookkeeping of its
    own and cannot drift from what was actually served. Content is a LIST of
    blocks once a cache breakpoint is in play, so both shapes are flattened;
    reading only the string form would have made every script look foreign on
    exactly the models that support caching.
    """
    out: list[str] = []
    for message in messages or ():
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, str):
            out.append(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict):
                    out.append(str(block.get("text") or ""))
                else:
                    out.append(str(block))
        elif content is not None:
            out.append(str(content))
    return "\n".join(out)


# ── the three signals ──────────────────────────────────────────────────────

def near_empty(reply: str, user_text: str, *, tools_called: int) -> Optional[str]:
    """Nothing was said and nothing was done. Evidence, or None.

    THE `tools_called` GATE IS THE WHOLE FALSE-POSITIVE ANSWER. "Done." after
    a real tool call is a good reply and the shortest correct one available;
    this cannot fire on it, because a turn that called anything has done
    something and its brevity is not evidence of anything. The count is for
    the TURN, not the round, so a final round that answers "Done." after an
    earlier round did the work is equally safe.
    """
    if tools_called:
        return None
    if len(_normalise(user_text)) < _SUBSTANTIVE_USER_CHARS:
        return None
    body = (reply or "").strip()
    if len(body) > _NEAR_EMPTY_MAX_CHARS:
        return None
    if sum(1 for ch in body if ch.isalpha()) >= _NEAR_EMPTY_MIN_ALPHA:
        return None
    return (f"the whole reply was {body!r} "
            f"({len(body)} character{'' if len(body) == 1 else 's'}) and no "
            f"tool ran this turn")


def echoed_user(reply: str, user_text: str, *,
                tools_called: int) -> Optional[str]:
    """The reply is the question, handed back. Evidence, or None.

    A model quoting the operator deliberately writes a QUOTATION: delimited by
    a quote mark, a colon, a newline, or at minimum whitespace. The measured
    failure had none — "trainerPULL the qwen3:30b-a3b model onto this box
    now.I don't have…" glues the echoed span to a letter on the left, which is
    a model leaking its own prompt, not one citing it. So a properly delimited
    echo is only degenerate when it is essentially the entire reply and
    nothing else was said.

    TWO FALSE POSITIVES THIS HAS ALREADY COST, both fixed here and both
    regression-tested, because this guard RETRACTS the reply of a turn that
    may have done real work:

    1. THE SEAM, NOT THE NEIGHBOUR. The longest common substring extends as
       far as it matches, so it routinely swallows the very space that
       delimits it. Reading only the character next to the span called
       "Adding| a nightly backup of the postgres volume at 3am. I created the
       automation…" glued — because the reply said "Adding" — even though the
       span itself starts with a space. A seam is glued only when BOTH the
       character outside it and the span's own edge character are
       alphanumeric; that is what "no delimiter" has to mean, and the real
       incident ("traine|r" + "p|ull the…") still satisfies it.
    2. `tools_called`, FOR THE DELIMITED BRANCH. "It is essentially the whole
       reply and nothing else was said" is `near_empty`'s reasoning, so it
       needs `near_empty`'s gate: 'Saved: "<the note you just gave me>"'
       after a real memory write is the correct reply and the shortest one
       available, not a regurgitation. A turn that called nothing and handed
       the message straight back still trips it.

    The GLUED branch is deliberately NOT gated on `tools_called`: a span of
    the operator's message fused mid-word into the reply is corrupt output,
    which is a fact about the completion and not about how much work the turn
    did. Doing the work does not excuse leaking the prompt.
    """
    user = _normalise(user_text)[:_MATCH_WINDOW]
    body = _normalise(reply)[:_MATCH_WINDOW]
    if len(user) < _ECHO_MIN_CHARS or not body:
        return None
    # autojunk=False is load-bearing: SequenceMatcher's default treats
    # characters appearing in more than 1% of a >200-element sequence as
    # junk, which is every vowel and every space — matching would silently
    # stop working on exactly the long strings this is for.
    match = difflib.SequenceMatcher(
        None, user, body, autojunk=False).find_longest_match(
            0, len(user), 0, len(body))
    if match.size < max(_ECHO_MIN_CHARS, int(len(user) * _ECHO_USER_FRACTION)):
        return None
    span = body[match.b:match.b + match.size]
    before = body[match.b - 1] if match.b > 0 else ""
    after = (body[match.b + match.size]
             if match.b + match.size < len(body) else "")
    # The span's own edge is half of the seam — see (1) in the docstring.
    glued = ((before.isalnum() and span[:1].isalnum())
             or (after.isalnum() and span[-1:].isalnum()))
    if not glued:
        # A delimited echo is a quotation, and a quotation is legitimate
        # unless it is the whole reply — see (2): that is a statement about
        # how little was SAID, and it is only evidence when nothing was DONE
        # either.
        if tools_called:
            return None
        if match.size < len(body) * _ECHO_REPLY_FRACTION:
            return None
    return (f"reproduced {match.size} of the {len(user)} characters the "
            f"person wrote"
            + (" with no delimiter around it" if glued else " and little else")
            + f": {span[:80]!r}")


def foreign_script(reply: str, corpus: str) -> Optional[str]:
    """Substantial text in a writing system that is not in the input.

    EXPECTED SCRIPTS ARE DERIVED FROM THE ACTUAL INPUT — the system prompt,
    the history, the tool results — never from a hardcoded "English". An
    install whose operator writes in Japanese has Japanese in every prompt and
    this never fires; the moment a conversation genuinely contains a script,
    the model may answer in it.

    Scripts absent from the input are counted TOGETHER rather than one at a
    time, because that is the derived reading: Japanese prose is three scripts
    (CJK, HIRAGANA, KATAKANA) and grading each separately would need a table
    of which scripts belong to which language, which is the maintained list
    this codebase refuses.

    THE KNOWN LIMIT, stated rather than hidden: "write me a paragraph in
    Chinese" is a legitimate request whose answer this reads as degenerate,
    because the request is in Latin and the answer is not. It costs one retry
    and then a visibly failed turn naming the signal. Both thresholds have to
    be met, so a quoted word or phrase inside an English answer passes.
    """
    counts = _script_counts(reply)
    if not counts:
        return None
    total = sum(counts.values())
    # Cheapest refusal first: if EVERY script in the reply were foreign it
    # would still be under threshold, so the corpus never has to be read.
    if total < _SCRIPT_MIN_CHARS:
        return None
    known = _scripts_present(corpus, set(counts))
    foreign = {s: n for s, n in counts.items() if s not in known}
    if not foreign:
        return None
    n = sum(foreign.values())
    if n < _SCRIPT_MIN_CHARS or n < total * _SCRIPT_MIN_FRACTION:
        return None
    named = ", ".join(f"{s.title()} x{c}" for s, c in
                      sorted(foreign.items(), key=lambda kv: -kv[1])[:3])
    return (f"{n} of {total} letters are in a script that appears nowhere in "
            f"the prompt or the conversation ({named})")


def check(reply: str, *, user_text: str, corpus: str,
          tools_called: int) -> Optional[dict]:
    """The first signal that fires, as {signal, detail}, or None.

    Order is by certainty, not severity: an empty answer is a fact about the
    completion alone, an echo is a fact about it against one message, a script
    mismatch is a fact about it against the whole prompt.
    """
    for name, evidence in (
            (NEAR_EMPTY, near_empty(reply, user_text, tools_called=tools_called)),
            (ECHO, echoed_user(reply, user_text, tools_called=tools_called)),
            (FOREIGN_SCRIPT, foreign_script(reply, corpus))):
        if evidence:
            return {"signal": name, "detail": evidence}
    return None


# ── the record: measurable, not anecdotal ──────────────────────────────────

#: Degenerate turns on ONE model inside `_CARD_WINDOW_HOURS` before the
#: operator is asked to look. Three, because one is noise and two is a
#: coincidence; the retry already handled each of them individually, so this
#: number only decides when a pattern is worth a card.
_CARD_AFTER = 3
_CARD_WINDOW_HOURS = 24
#: Findings reported by model_fitness look back this far.
_FITNESS_WINDOW_HOURS = 72


async def record(model: str, signal: str, detail: str, *,
                 agent_name: Optional[str] = None,
                 standby: Optional[str] = None) -> None:
    """Write one degenerate turn to `model_health`, then decide about a card.

    Never raises: this runs on a turn that is already being rescued, and a
    bookkeeping failure must not become the operator's error message. It does
    LOG the failure rather than swallowing it — an unwritable health table
    that reads as a healthy one is this repo's most-documented defect shape.
    """
    from app import db, redact, trace
    turn = trace.current()
    try:
        async with db.acquire() as conn:
            await conn.execute(
                "INSERT INTO model_health (model, agent_name, signal, detail, "
                "trace_id, standby) VALUES ($1,$2,$3,$4,$5,$6)",
                model, agent_name, signal,
                redact.scrub_text(detail or "")[:_EVIDENCE_CHARS],
                turn.id if turn else None, standby)
    except Exception:  # noqa: BLE001 — never break the turn being rescued
        log.exception("could not record model_health for %s (%s) — this "
                      "degenerate turn is NOT in the record", model, signal)
        return
    try:
        await _maybe_raise_card(model, agent_name)
    except Exception:  # noqa: BLE001
        log.exception("model_health card check failed for %s", model)


async def recent(model: str, hours: int = _FITNESS_WINDOW_HOURS) -> list[dict]:
    """Degenerate turns recorded for one model, newest first.

    Returns [] when the table cannot be read AT ALL — and logs it, because
    "no degenerate turns" and "could not look" must not be told apart only by
    reading the log. Callers use this for advisories, never for gating.
    """
    from app import db
    try:
        async with db.acquire() as conn:
            rows = await conn.fetch(
                "SELECT model, agent_name, signal, detail, standby, trace_id, "
                "recorded_at FROM model_health WHERE model = $1 "
                f"AND recorded_at > now() - interval '{int(hours)} hours' "
                "ORDER BY recorded_at DESC LIMIT 50", model)
    except Exception:  # noqa: BLE001
        log.debug("model_health lookup failed for %s", model, exc_info=True)
        return []
    return [dict(r) for r in rows]


async def fitness_findings(model: str) -> list[dict]:
    """model_fitness findings for what this model has actually DONE.

    ADVISORY, never blocking, and that is deliberate: which model runs is the
    operator's call (the card is how he is asked), and a blocking finding here
    would silently drop a model out of every standby chain — an auto-reassign
    wearing a different hat.
    """
    from app import model_fitness
    rows = await recent(model)
    if len(rows) < 1:
        return []
    by_signal: dict[str, int] = {}
    for r in rows:
        by_signal[r["signal"]] = by_signal.get(r["signal"], 0) + 1
    breakdown = ", ".join(f"{k} x{v}" for k, v in
                          sorted(by_signal.items(), key=lambda kv: -kv[1]))
    last = rows[0]
    # SAY WHICH, not "each was retried": a row with standby NULL is a turn
    # that FAILED IN FRONT OF THE OPERATOR, and folding it into a reassuring
    # summary is exactly the fallback-that-reads-as-success shape.
    rescued = sum(1 for r in rows if r.get("standby"))
    outcome = (f"All {len(rows)} were retried on a standby."
               if rescued == len(rows) else
               f"{rescued} of {len(rows)} were retried on a standby; the "
               f"other {len(rows) - rescued} failed the turn outright.")
    return [{
        "severity": model_fitness.ADVISORY, "check": "degenerate",
        "detail": (f"{model} returned {len(rows)} completion(s) in the last "
                   f"{_FITNESS_WINDOW_HOURS}h that were not answers at all "
                   f"({breakdown}). Most recent: {last['detail']}. {outcome} "
                   f"This is measured on live turns, not inferred from the "
                   f"model's declared capabilities."),
    }]


async def _maybe_raise_card(model: str, agent_name: Optional[str]) -> None:
    """Ask the operator to look, once a pattern exists. NEVER reassign.

    The card carries no `model.assign` action on purpose. Picking the
    replacement is a judgement about quality that nothing here has measured —
    the standby that answered instead is named as evidence, and choosing what
    `main` runs on stays where it belongs.
    """
    from app import db, recommendations
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT signal, detail, agent_name, standby, recorded_at "
            "FROM model_health WHERE model = $1 "
            f"AND recorded_at > now() - interval '{_CARD_WINDOW_HOURS} hours' "
            "ORDER BY recorded_at DESC", model)
    if len(rows) < _CARD_AFTER:
        return
    by_signal: dict[str, int] = {}
    for r in rows:
        by_signal[r["signal"]] = by_signal.get(r["signal"], 0) + 1
    standbys = sorted({r["standby"] for r in rows if r["standby"]})
    agents = sorted({r["agent_name"] for r in rows if r["agent_name"]})
    # COUNT THE ONES THAT DIED. A row with standby NULL is a turn that failed
    # in front of the operator, and "each turn was retried on a standby"
    # folded those into a reassuring sentence — the fallback-that-reads-as-
    # success shape, in the card whose whole job is to report a failure.
    rescued = sum(1 for r in rows if r["standby"])
    body = (
        f"{model} has returned {len(rows)} completions in the last "
        f"{_CARD_WINDOW_HOURS} hours that were not answers: "
        + ", ".join(f"{k} x{v}" for k, v in
                    sorted(by_signal.items(), key=lambda kv: -kv[1]))
        + ".\n\nThese are not provider errors — every one came back HTTP 200 "
          "with status ok, which is why the existing failover never saw them. "
        + (f"All {len(rows)} were retried on a standby"
           if rescued == len(rows) else
           f"{rescued} of {len(rows)} were retried on a standby")
        + (f" ({', '.join(standbys)})" if standbys else "")
        + (f", and it happened to {', '.join(agents)}" if agents else "")
        + (f". The other {len(rows) - rescued} failed the turn outright — "
           f"the operator saw an error, not an answer"
           if rescued < len(rows) else "")
        + ".\n\nMost recent evidence: " + str(rows[0]["detail"] or "")
        + "\n\nNothing has been reassigned. Which model an agent runs on is "
          "your call — this is the measurement, in Settings -> Models."
    )
    await recommendations.create(
        kind="model_health",
        title=f"{model} is returning non-answers",
        body=body, source="degeneracy",
        # Stable, so a model that keeps degrading REFRESHES one card instead
        # of raising a new one an hour (recommendations.CREATE_LIMIT_PER_HOUR
        # would otherwise start refusing, and the refusal would be the thing
        # that stopped the operator hearing about it).
        dedupe_key=f"model_health:{model}",
        priority=1)
