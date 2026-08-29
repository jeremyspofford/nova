"""The post-turn honesty guard: a reply cannot claim an action no span backs.

A reply is a claim; the trace is the fact. The system prompt asks the model
to be honest about what it did, but a prompt is a request, not a control —
qwen3:1.7b claimed "groceries.md updated successfully" and invented an
invoice with zero tool calls, and on 2026-08-29 the running model told the
owner "I've created kv_offloading_summary.md" with no write span at all,
then invented locations for the file that did not exist. This module is the
line of code that refuses.

`narration_check(reply_text, spans)` reads the assistant's final text for
explicit, COMPLETED-action claims that map to a specific tool and requires a
successful span of a matching tool THIS turn. A claim with no backing span
is contradicted before it reaches the operator.

The claim -> tool mapping (derived from the registry, not the prompt):

    create/write/save/update a file      -> workspace_write_file | memory_save
    present a file's contents as fact    -> workspace_read_file | workspace_write_file
    read/check a file                    -> workspace_read_file
    fetch/look up a URL                  -> fetch_url

Two properties make this safe to run on every turn:

  * PURE and mechanical — no model, no network, no clock. The same
    (text, spans) always yields the same verdict, so the guard cannot itself
    become a source of narration.
  * PRECISION-first (ruling S2d-R2). A wrongly-corrected honest reply would
    make the guard the liar, which is worse than a missed lie. So a claim is
    only ever anchored to a REAL target — a filename token with a known
    extension, or an http(s) URL. A bare noun ("I updated my notes", "the
    document you pasted") is NEVER a claim; nor is a future/hedged form
    ("I'll write it"), a negation ("could not create the file"), a question
    ("would you like me to?"), or an action attributed to someone else ("you
    saved notes.md"). When it cannot be sure, it does not flag.

Backing is target-AWARE, not merely kind-aware: a claim that names a file is
backed only if a matching tool actually touched a file of that name. That is
what catches the model writing a NEW file while claiming it edited the named
one — a real span exists, but not for the thing it said it did. Leniency
runs the other way: a span whose target cannot be read (a memory note, a
flooded-and-clipped argument record) counts as backing any claim of its kind.
"""
from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

# Successful spans of these tools ground each kind of claim. The names come
# from the tool registry; a new filesystem/fetch tool must be added here, or
# the guard would flag an honest use of it — and the pinned corpus in
# test_guards.py goes red the day that happens, which is the intended alarm.
_WRITE_TOOLS = frozenset({"workspace_write_file", "memory_save"})
_READ_TOOLS = frozenset({"workspace_read_file"})
_CONTENT_TOOLS = frozenset({"workspace_read_file", "workspace_write_file"})
_FETCH_TOOLS = frozenset({"fetch_url"})

_KIND_TOOLS: dict[str, frozenset[str]] = {
    "wrote_file": _WRITE_TOOLS,
    "read_file": _READ_TOOLS,
    "file_contents": _CONTENT_TOOLS,
    "fetched_url": _FETCH_TOOLS,
}

# The stated correction, appended to the reply and streamed as its own frame.
# One sentence, the same for every claim kind: the operator's durable record
# and screen both show the contradiction, and the claim's kind/target land in
# the guard span rather than in prose.
CORRECTION_TEXT = (
    "Correction: I did not actually do that — there is no record of the "
    "action this turn."
)

# Completed fetch verbs, as whole tokens. "read" appears here and in the read
# set; which one fires is decided by the object it governs — a URL is a fetch,
# a filename is a read.
_FETCH_VERB_TOKENS = frozenset(
    {"fetched", "retrieved", "downloaded", "visited", "accessed", "read", "pulled", "looked"}
)
# A file the claim is about: a real filename TOKEN — a name with a known
# extension (so "e.g." and an end-of-sentence period never read as files),
# optionally carrying path segments. A filename is the ONLY thing that anchors
# a file claim. A bare noun is NOT enough: "I updated my notes on your
# preferences", "the document you pasted", "I've saved a summary of the readme
# below" are ordinary conversation, and flagging them would make the guard the
# liar (ruling S2d-R2 — a false positive is worse than a missed lie).
_FILENAME_RE = (
    r"[\w./-]*[\w-]\.(?:md|txt|json|csv|ya?ml|py|js|ts|html?|pdf|log|ini|toml|xml|sh|cfg|conf)"
)
_FILENAME = re.compile(r"\b" + _FILENAME_RE + r"\b", re.I)
_URL = re.compile(r"https?://[^\s)>\]]+", re.I)

# Presenting a NAMED file's contents as a DUMP: "<file> contains the following"
# or "<file> says:/reads:". Only a content dump counts — a descriptive
# "requirements.txt lists your dependencies" or "config.yaml contains your key"
# is honest chat about a file, not a fabricated read of one, so plain
# contains/lists/shows are deliberately NOT enough. An in-chat draft that names
# no file token is never a claim either.
_CONTENT_CLAIM = re.compile(
    r"\b(" + _FILENAME_RE + r")\b\s+(?:now\s+|currently\s+)?"
    r"(?:contains?\s+the\s+following|(?:contains?|says?|reads?|shows?)\s*[:\"'`])",
    re.I,
)

# The passive voice, where the filename is the subject and precedes the verb:
# "<file> has been updated", "<file> was read". A negation ("was not updated")
# or a future ("will be updated") breaks the auxiliary run and so never
# matches. Every verb here has an active form in the verb token sets below —
# "overwritten" was dropped precisely because "overwrite" is not a recognised
# active verb, so the two branches cannot disagree about what counts.
_PASSIVE_CLAIM = re.compile(
    r"\b(" + _FILENAME_RE + r")\b\s+(?:has|have|had|was|were|is|are)\s+(?:been\s+|now\s+)?"
    r"(?P<verb>created|written|saved|updated|appended|added"
    r"|read|opened|reviewed|checked|examined)\b",
    re.I,
)
_PASSIVE_READ_VERBS = frozenset({"read", "opened", "reviewed", "checked", "examined"})

# Completed ACTIVE verbs, as whole tokens (the token scan lower-cases and looks
# them up). Future/hedged forms use the base verb ("I'll create", "I can save")
# and so never appear here — the verb form alone filters most hedging.
_WRITE_VERB_TOKENS = frozenset(
    {"created", "wrote", "written", "saved", "updated", "appended", "added"}
)
_READ_VERB_TOKENS = frozenset({"read", "checked", "reviewed", "opened", "examined"})
_ACTION_VERB_TOKENS = _WRITE_VERB_TOKENS | _READ_VERB_TOKENS

# A first-person subject governing a verb: "I", "I've", "I have <verb>", with an
# adverb or a perfect auxiliary allowed to sit between. This is what an ACTIVE
# claim REQUIRES — an active third-party subject ("the previous session created
# X", "a teammate wrote X", "you saved X") simply never reaches "I" and so is
# not a self-claim. A negation or a modal between the subject and the verb ("I
# have not created", "I can read") also stops the walk-back before "I", which
# is how hedged/negated active forms are suppressed without a separate blocker.
_FIRST_PERSON = frozenset({"i", "i've", "i'd", "i'm"})
_SUBJECT_SKIP = frozenset(
    {"have", "has", "had", "just", "already", "also", "then", "now", "finally",
     "recently", "went", "ahead", "and", "or", "since", "personally"}
)

# The filename is the object of a completed active verb only if it is reached
# WITHOUT crossing a clause boundary: a conjunction/comma before any object
# ("I updated my approach and config.yaml is …"), a finite verb starting a new
# predicate ("config.yaml is the file …"), a subordinator, or another action
# verb all end the object walk. A list conjunction AFTER a filename ("saved
# a.md and b.md") continues the list; otherwise it breaks.
_LIST_CONT = frozenset({"and", "or", ","})
_STOP_WORDS = frozenset(
    {"but", "nor", "so", "yet", "plus", "because", "which", "who", "that",
     "whom", "whose", "where", "when", "while", "since", "if", "unless",
     "though", "although", "whereas", "before", "after", "once", "until",
     "is", "are", "was", "were", "be", "been", "am", "can", "could", "will",
     "would", "shall", "should", "may", "might", "must", "has", "have", "had",
     "do", "does", "did", "need", "needs", "want", "wants", "seems", "looks",
     "remains", "becomes", "stays", "you", "you'll", "you've", "we", "we'll",
     "they", "he", "she"}
)
_STOP_PUNCT = frozenset({";", ":", "-", "–", "—", "(", ")", "[", "]", "!", "?"})
_OBJECT_MAX_TOKENS = 12

# Whether a filename is the verb's OBJECT is grammatical, not positional. It
# counts only when a DESTINATION or IDENTITY connector ties it to the verb;
# behind an ABOUTNESS connector it names the TOPIC, not what was written, and
# is clean. "wrote a summary of config.yaml" and "the docs about backup.sh"
# are topics; "wrote to settings.json", "a file called X", "saved it as X",
# and the immediate "wrote deploy.sh" are objects.
_DEST_PREP = frozenset({"to", "into", "onto"})
_IDENTITY_CONN = frozenset({"as", "called", "named", "titled", "labeled", "labelled"})
# File-head nouns host an appositive filename ("the file X", "a note called
# X") — the filename identifies WHAT was written, which is the kv_offloading
# lie's exact shape. This is the ONLY place a bare file noun matters, and only
# because a real filename is tied to it.
_FILE_HEAD_NOUNS = frozenset(
    {"file", "files", "document", "documents", "doc", "docs", "note", "notes",
     "memo", "readme", "script", "scripts", "page", "pages", "copy", "version"}
)
# Aboutness / oblique connectors: the filename after one of these is the TOPIC.
# "as" is IDENTITY (saved it AS report.md), never aboutness.
_ABOUTNESS = frozenset({"of", "about", "on", "for", "regarding", "concerning", "upon", "re"})
# Determiners, quantifiers, particles and common adjectives that merely modify
# the object — they do not fill the object slot, so the walk stays "immediate".
# Anything NOT here, and not a connector/boundary, is treated as a content noun
# that DOES fill the slot (so a later filename is oblique unless a
# destination/identity connector re-ties it).
_DETERMINER_ADJ = frozenset(
    {"a", "an", "the", "this", "that", "these", "those", "my", "your", "his",
     "her", "its", "our", "their", "one", "another", "some", "any", "no",
     "each", "every", "new", "old", "updated", "revised", "final", "first",
     "second", "third", "latest", "initial", "complete", "entire", "whole",
     "same", "short", "small", "brief", "quick", "simple", "plain", "draft",
     "up", "back", "down", "out", "over", "here", "there", "above", "below",
     "just", "also", "now", "then", "brand"}
)
# Prepositions and adverbs that can FOLLOW the verb's object without being the
# noun it modifies — "created groceries.md WITH the items", "wrote deploy.sh
# TODAY". A filename followed by one of these keeps its object status; a
# filename followed by a bare content noun ("config.yaml parsing logic") does
# not (it is a pre-nominal modifier).
_PREP_ADVERB = frozenset(
    {"with", "from", "by", "at", "in", "per", "via", "without", "within",
     "after", "before", "during", "through", "under", "since", "until",
     "against", "toward", "towards", "today", "tonight", "yesterday",
     "tomorrow", "again", "once", "twice", "soon", "later", "earlier",
     "still", "yet", "too", "instead", "successfully"}
)

# The filename is the SUBJECT of a passive/content claim, so its truth is
# suppressed not by a first-person walk-back but by any sign the action belongs
# to someone else or another time: a "by <not me>" agent, a prior-time marker,
# or a reported-speech lead. This is what clears "config.yaml was updated by
# you", "created by the previous session", "updated earlier today", "you said
# groceries.md contains …".
_BY_OTHER = re.compile(r"\bby\s+(?!me\b|myself\b)[\w']+", re.I)
_PRIOR_TIME = re.compile(
    r"\b(?:earlier|yesterday|previously|already\s+exist|before\s+(?:we|you|this)"
    r"|prior|previous\s+session|previous\s+run|last\s+(?:week|night|time|run|session)"
    r"|moments?\s+ago|minutes?\s+ago|hours?\s+ago|days?\s+ago|weeks?\s+ago"
    r"|a\s+while\s+ago|earlier\s+today)\b",
    re.I,
)
_REPORTED = re.compile(
    r"\b(?:you|he|she|they|we|someone|somebody|the\s+\w+)\s+(?:\w+\s+){0,2}?"
    r"(?:said|says|mentioned|mentions|claim|claims|claimed|noted|notes|told|"
    r"reported|reports|thinks?|believes?)\b",
    re.I,
)

# Within a sentence, split on separators that bound the reach of a negation:
# a semicolon, a contrastive conjunction, or an explicit "then".
_CLAUSE_SPLIT = re.compile(
    r";|\s+(?:but|however|though|although|whereas|yet)\s+|,?\s+then\s+", re.I
)


@dataclass(frozen=True)
class UnbackedClaim:
    kind: str
    target: str | None
    phrase: str


@dataclass(frozen=True)
class Correction:
    claims: tuple[UnbackedClaim, ...]
    text: str = CORRECTION_TEXT


def _sentences(text: str) -> list[str]:
    """Split on . ! ? — but only when the terminator ends a word, never
    inside a filename or a decimal. A period followed by whitespace or the
    end is a sentence boundary; the "." in "summary.md" or "$4.50", followed
    by a letter or digit, is not."""
    out: list[str] = []
    start = 0
    i = 0
    n = len(text)
    while i < n:
        char = text[i]
        if char == "\n":
            out.append(text[start : i + 1])
            start = i + 1
        elif char in ".!?":
            end = i
            while end + 1 < n and text[end + 1] in ".!?":
                end += 1
            following = text[end + 1] if end + 1 < n else ""
            if following == "" or following.isspace():
                out.append(text[start : end + 1])
                start = end + 1
                i = end
        i += 1
    if start < n:
        out.append(text[start:])
    return out


def _clauses(text: str):
    """(clause, is_question) pairs — negation scoped to a clause, '?' to its
    whole sentence (an offer is a question even mid-sentence)."""
    for sentence in _sentences(text):
        if not sentence.strip():
            continue
        is_question = sentence.rstrip().endswith("?")
        for clause in _CLAUSE_SPLIT.split(sentence):
            if clause and clause.strip():
                yield clause, is_question


_TOKEN = re.compile(r"[A-Za-z0-9_./'-]+|[^\sA-Za-z0-9]")


def _tokenize(clause: str) -> list[str]:
    return [m.group(0) for m in _TOKEN.finditer(clause)]


def _filename_at(token: str) -> str | None:
    """The filename this token starts with, if any — tolerant of a trailing
    period or comma ('report.md.', 'notes.md,') that the tokenizer keeps
    attached at a clause end."""
    m = _FILENAME.match(token)
    return m.group(0) if m is not None else None


def _first_person_subject(tokens: list[str], vi: int) -> bool:
    """True if the verb at index `vi` has a first-person subject 'I'.

    Walk left over what can sit between 'I' and its verb — perfect auxiliaries
    ('have'), adverbs ('just', '-ly'), a coordinated earlier object or verb of
    the SAME 'I' ('I read a.md and wrote b.md') — and stop at anything else. A
    different subject ('the previous session created…', 'you saved…'), a
    negation ('I have NOT created…'), or a modal ('I CAN read…') is exactly
    that 'anything else', so the walk never reaches 'I' and the claim is
    dropped. Precision comes free: only a genuine 'I <verb>' survives."""
    steps = 0
    k = vi - 1
    while k >= 0 and steps < _OBJECT_MAX_TOKENS:
        tok = tokens[k]
        low = tok.lower()
        if low in _FIRST_PERSON:
            return True
        if (
            low in _SUBJECT_SKIP
            or low.endswith("ly")
            or low in _ACTION_VERB_TOKENS
            or _filename_at(tok) is not None
        ):
            k -= 1
            steps += 1
            continue
        return False
    return False


def _is_content_noun(token: str) -> bool:
    """True if `token` is a bare common noun — none of the known grammatical
    categories (a filename, a connector, a preposition/adverb, a determiner/
    adjective, or a clause boundary). Used to spot the noun a pre-nominal
    filename modifies ("config.yaml PARSING", "backup.sh DOCS")."""
    low = token.lower()
    if _filename_at(token) is not None:
        return False
    if token in _STOP_PUNCT or low in _STOP_WORDS or low in _LIST_CONT:
        return False
    if low in _ACTION_VERB_TOKENS or low in _ABOUTNESS or token == "'s":
        return False
    if low in _DEST_PREP or low in _IDENTITY_CONN or low in _PREP_ADVERB:
        return False
    if low in _DETERMINER_ADJ or low.endswith("ly"):
        return False
    return True


def _objects_of(tokens: list[str], vi: int) -> list[str]:
    """The file tokens that are the OBJECT of the completed verb at index `vi`.

    Grammatical, not positional: a filename counts only when a DESTINATION or
    IDENTITY connector ties it to the verb, never when it is the TOPIC (behind
    an aboutness preposition) or a MODIFIER (in front of the noun it describes).
    A small "governor" state carries what would tie the NEXT filename:

      immediate  — right after the verb, only determiners/adjectives passed
                   ("wrote deploy.sh", "read config.yaml")
      dest       — after to/into/onto ("added milk TO groceries.md")
      identity   — after called/named/as or a file-head noun ("a file called
                   X", "saved it AS report.md", "the file X")
      oblique    — a non-file common noun has filled the direct-object slot
                   ("a summary …"), so a later bare filename is not the object

    An ABOUTNESS preposition (of/about/on/for/regarding/…) or a possessive
    ends candidacy entirely — everything after it is topic. A filename
    IMMEDIATELY FOLLOWED by a bare content noun is a pre-nominal modifier of
    that noun ("the config.yaml PARSING logic", "the backup.sh DOCS"), the
    mirror of the topic case, so it is demoted rather than taken as the object
    — but a filename followed by a boundary, a preposition, or end-of-clause
    ("created the file report.md.", "wrote deploy.sh") stays the object. A
    conjunction/comma before any object, a finite verb, a subordinator, or
    another action verb also end the walk. A list conjunction AFTER an object
    continues the list ("saved a.md and b.md")."""
    found: list[str] = []
    governor = "immediate"
    steps = 0
    j = vi + 1
    while j < len(tokens) and steps < _OBJECT_MAX_TOKENS:
        tok = tokens[j]
        low = tok.lower()
        name = _filename_at(tok)
        if name is not None:
            # A possessive filename ("config.yaml's contents") is a topic.
            if tok[len(name) :].startswith("'"):
                break
            # A filename that immediately modifies a following content noun
            # ("config.yaml parsing logic") is not the object — demote it, the
            # mirror of the aboutness case. End-of-clause, a boundary, or a
            # preposition after it does NOT demote ("wrote deploy.sh").
            if j + 1 < len(tokens) and _is_content_noun(tokens[j + 1]):
                governor = "oblique"
                j += 1
                steps += 1
                continue
            if governor in ("immediate", "dest", "identity"):
                found.append(name)
                governor = "list"
                j += 1
                steps += 1
                continue
            # governor == "oblique"/"list": a non-file noun already filled the
            # object slot, so this filename is not what was written — stop.
            break
        if low in _ACTION_VERB_TOKENS:
            break
        if low in _LIST_CONT:
            if found:
                governor = "immediate"  # a coordinated second object may follow
                j += 1
                steps += 1
                continue
            break
        if tok in _STOP_PUNCT or low in _STOP_WORDS:
            break
        if low in _ABOUTNESS or tok == "'s":
            break  # the filename after an aboutness connector is the topic
        if low in _DEST_PREP:
            governor = "dest"
        elif low in _IDENTITY_CONN or low in _FILE_HEAD_NOUNS:
            governor = "identity"
        elif low in _DETERMINER_ADJ or low.endswith("ly"):
            pass  # a modifier — the object slot is still open
        else:
            # a non-file common noun fills the direct-object slot
            governor = "oblique"
        j += 1
        steps += 1
    return found


def _externally_attributed(clause: str) -> bool:
    """The action belongs to someone else or another time — a 'by <not me>'
    agent, a prior-time marker, or a reported-speech lead. Used for passive and
    content claims, whose subject is the filename rather than 'I', and as a
    backstop on active/fetch claims."""
    return (
        _BY_OTHER.search(clause) is not None
        or _PRIOR_TIME.search(clause) is not None
        or _REPORTED.search(clause) is not None
    )


def _claims_in(clause: str) -> list[tuple[str, str, str]]:
    """Every completed-action self-claim in one clause, each tied to a REAL
    target (a filename token or a URL). A bare noun never qualifies, an action
    attributed to someone else or another time never qualifies, and a filename
    that is not the verb's own object never qualifies."""
    claims: list[tuple[str, str, str]] = []
    if _externally_attributed(clause):
        return claims

    tokens = _tokenize(clause)

    # active voice: I + completed write/read verb + a filename as its object.
    for vi, tok in enumerate(tokens):
        low = tok.lower()
        if low not in _ACTION_VERB_TOKENS:
            continue
        if not _first_person_subject(tokens, vi):
            continue
        kind = "wrote_file" if low in _WRITE_VERB_TOKENS else "read_file"
        for name in _objects_of(tokens, vi):
            claims.append((kind, name, tok))

    # fetched a URL — I + fetch verb + an explicit http(s) token in the clause.
    urls = [m.group(0) for m in _URL.finditer(clause)]
    if urls:
        for vi, tok in enumerate(tokens):
            if tok.lower() in _FETCH_VERB_TOKENS and _first_person_subject(tokens, vi):
                claims.append(("fetched_url", urls[0], tok))
                break

    # passive voice: "<file> has been updated / was read", filename-as-subject.
    for pm in _PASSIVE_CLAIM.finditer(clause):
        verb = pm.group("verb").lower()
        kind = "read_file" if verb in _PASSIVE_READ_VERBS else "wrote_file"
        claims.append((kind, pm.group(1), pm.group(0)))

    # content DUMP: "<file> contains the following / says:", filename-as-subject.
    for cm in _CONTENT_CLAIM.finditer(clause):
        claims.append(("file_contents", cm.group(1), cm.group(0)))

    return claims


def _successful(spans: Sequence[Any]) -> list[Any]:
    out = []
    for span in spans:
        if getattr(span, "kind", None) != "tool":
            continue
        meta = getattr(span, "meta", None) or {}
        if meta.get("ok") is True and getattr(span, "name", None):
            out.append(span)
    return out


def _target_of(span: Any) -> str | None:
    """The path/url a span actually touched, or None when it cannot be read.

    None is deliberately lenient: a memory note has no path, and a flooded
    argument record degrades to a clipped string — in both cases the guard
    treats the span as backing any claim of its kind rather than risk
    correcting an honest reply it cannot fully see (ruling S2d-R2).
    """
    args = (getattr(span, "meta", None) or {}).get("args_redacted")
    if not isinstance(args, dict):
        return None
    if span.name in ("workspace_write_file", "workspace_read_file"):
        path = args.get("path")
        return path if isinstance(path, str) else None
    if span.name == "fetch_url":
        url = args.get("url")
        return url if isinstance(url, str) else None
    return None


def _backed(kind: str, target: str | None, successful: Sequence[Any]) -> bool:
    matching = [span for span in successful if span.name in _KIND_TOOLS[kind]]
    if not matching:
        return False
    span_targets = [_target_of(span) for span in matching]
    # A matching tool ran but its target is unreadable, or the claim named no
    # file: kind-level presence is enough — do not flag on what we cannot see.
    if any(t is None for t in span_targets) or not target:
        return True
    needle = target.rsplit("/", 1)[-1].lower()
    return any(needle in (t or "").lower() for t in span_targets)


def narration_check(reply_text: str, spans: Sequence[Any]) -> Correction | None:
    """Contradict any completed-action claim no successful span backs.

    Returns a Correction naming the unbacked claim(s), or None when the reply
    is honest (or when the matcher cannot be sure — precision over recall).
    Pure: it reads only the text and the spans, never a model or the network.
    """
    if not reply_text or not reply_text.strip():
        return None
    successful = _successful(spans)
    unbacked: list[UnbackedClaim] = []
    seen: set[tuple[str, str]] = set()
    for clause, is_question in _clauses(reply_text):
        if is_question:
            continue
        for kind, target, phrase in _claims_in(clause):
            key = (kind, (target or "").lower())
            if key in seen:
                continue
            seen.add(key)
            if not _backed(kind, target, successful):
                unbacked.append(
                    UnbackedClaim(kind=kind, target=target, phrase=phrase.strip()[:80])
                )
    if not unbacked:
        return None
    return Correction(claims=tuple(unbacked))
