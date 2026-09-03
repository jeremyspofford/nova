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
from functools import lru_cache
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
# Sentence punctuation the URL/whitespace regex glues onto the end of a token.
# A URL captured mid-sentence ("…/data." or "…/data,") must be trimmed to its
# real value, or a backed fetch would fail the substring test against the
# span's clean URL and get wrongly flagged.
_TRAILING_PUNCT = ".,;:!?)]}'\"`"


def _strip_trailing_punct(text: str) -> str:
    return text.rstrip(_TRAILING_PUNCT)

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
# add/append name the CONTENT as their immediate object and the file as a
# destination ("added milk TO groceries.md"). The write target is therefore
# the destination file, never the immediate object — "added config.yaml to the
# list" writes no file, so it is not a claim.
_ADD_VERB_TOKENS = frozenset({"added", "appended"})

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


def _destination_file(tokens: list[str], vi: int) -> str | None:
    """For add/append, the write target is the DESTINATION file — the filename
    after to/into/onto — not the immediate object, which is the content added.

    "added milk to groceries.md" -> groceries.md (a file) -> a write claim.
    "added config.yaml to the list" -> "the list" is not a file -> no claim
    (config.yaml is the content, not the target). No destination at all means
    no file was written, so no claim."""
    j = vi + 1
    steps = 0
    while j < len(tokens) and steps < _OBJECT_MAX_TOKENS:
        tok = tokens[j]
        low = tok.lower()
        if low in _ACTION_VERB_TOKENS or tok in _STOP_PUNCT or low in _STOP_WORDS:
            return None
        if low in _LIST_CONT:
            return None
        if low in _DEST_PREP:
            # Read the destination noun phrase: determiners/adjectives, then a
            # filename (the destination is a file) or a non-file noun (not).
            k = j + 1
            inner = 0
            while k < len(tokens) and inner < 6:
                dest = tokens[k]
                name = _filename_at(dest)
                if name is not None:
                    # A destination filename that pre-modifies a content noun
                    # ("to groceries.md config") is a modifier, not the target.
                    if k + 1 < len(tokens) and _is_content_noun(tokens[k + 1]):
                        return None
                    return name
                dlow = dest.lower()
                if dlow in _DETERMINER_ADJ or dlow in _FILE_HEAD_NOUNS or dlow.endswith("ly"):
                    # determiners/adjectives and a file-head appositive ("the
                    # file X") precede the destination filename.
                    k += 1
                    inner += 1
                    continue
                return None  # a non-file destination ("the list", "the agenda")
            return None
        j += 1
        steps += 1
    return None


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
        if low in _ADD_VERB_TOKENS:
            # The write target is the destination file, not the content added.
            dest = _destination_file(tokens, vi)
            if dest is not None:
                claims.append(("wrote_file", dest, tok))
            continue
        kind = "wrote_file" if low in _WRITE_VERB_TOKENS else "read_file"
        for name in _objects_of(tokens, vi):
            claims.append((kind, name, tok))

    # fetched a URL — I + fetch verb + an explicit http(s) token in the clause.
    # Trailing sentence punctuation is trimmed so a backed fetch's target
    # matches the span's clean URL ("…/data." -> "…/data").
    urls = [_strip_trailing_punct(m.group(0)) for m in _URL.finditer(clause)]
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


def ran_a_tool(spans: Sequence[Any]) -> bool:
    """Did this turn actually RUN something? Derived from the spans, never prose.

    One derivation, shared: `_successful` is the same filter every claim check
    already uses to decide what a reply may assert (kind 'tool', meta.ok True,
    a name). chat.py's consent redirect reads it to refuse re-running work that
    already happened — a redirect after a real execution would dispatch the tool
    a SECOND time.
    """
    return bool(_successful(spans))


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
    # Normalise both sides for trailing punctuation/whitespace, so an honest
    # backed fetch is clean regardless of the sentence punctuation the URL
    # was written with ("…/data." vs the span's "…/data").
    needle = _strip_trailing_punct(target.strip()).rsplit("/", 1)[-1].lower()
    return any(
        needle in _strip_trailing_punct((t or "").strip()).lower() for t in span_targets
    )


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


# -- the pending-approval claim guard --------------------------------------
#
# A sibling of narration_check, for a lie the live walk caught: after the
# operator DENIED a fetch, the model answered a follow-up by PARROTING the prior
# turn's "that fetch is awaiting your approval" line — no tool call, no card,
# nothing pending anywhere. The operator was stranded on an approval that did
# not exist. The system prompt asking the model not to fake it is a request;
# this is the line of code that refuses.
#
# consent_claim_check(reply_text, has_pending_consent) fires ONLY when the reply
# asserts a specific action is CURRENTLY awaiting / pending / blocked-on the
# operator's approval AND has_pending_consent is False. `has_pending_consent` is
# the mechanical fact the caller computes (a card raised THIS turn, or one still
# pending in this conversation); when it is True the very same sentence is TRUE,
# so the guard stays silent — the SAME words flip verdict on that one boolean.
#
# It is built to narration_check's two rules: PURE (text + one boolean; no
# model, network or clock, so it can never itself become a source of narration)
# and PRECISION-first (a wrongly-corrected honest reply makes the guard itself
# the liar, worse than a missed lie). It reuses _clauses so a question or an
# offer ("Want me to fetch it?") is never read as an assertion, and every
# trigger is a CURRENT-state phrase — future/conditional forms ("that would need
# your approval", "I'd have to request approval", "I can ask for approval") use
# other words and so never match.
# MECHANISM-NEUTRAL on purpose. The old wording promised "I'll raise an
# approval card you can approve or deny" — which is now often FALSE: the owner
# can set an action class to 'auto' (autonomy.set_disposition), and then the
# next attempt just RUNS, with no card anywhere. A correction that mis-states
# how the system behaves is its own small lie, so this says only what is
# mechanically true (nothing pending, nothing ran) and invites the retry
# without promising which path it takes.
CONSENT_CLAIM_CORRECTION = (
    "Correction: nothing is awaiting your approval and nothing has run. "
    "Tell me again and I'll do it."
)

# Present/present-perfect state phrases asserting an action is blocked on the
# operator's approval RIGHT NOW: "(is) awaiting your approval", "pending (your)
# approval", "waiting for you to approve / on your OK", "queued ... for your
# approval". The state word itself is the anchor; a bare "approval" or a
# request-to-approve verb ("I'll request approval") is deliberately not enough.
_PENDING_STATE = re.compile(
    r"awaiting\s+(?:your\s+|the\s+)?(?:ok|okay|approval|sign-?off|go-?ahead)"
    r"|pending\s+(?:your\s+|the\s+)?approval"
    r"|waiting\s+(?:for\s+you\s+to\s+approve"
    r"|(?:for|on)\s+your\s+(?:ok|okay|approval|sign-?off|go-?ahead))"
    r"|queued\s+(?:\w+\s+){0,3}?for\s+(?:your\s+)?approval",
    re.I,
)
# "It/that/this needs|requires your approval" — a CURRENT blocked state tied to a
# SPECIFIC action by its demonstrative subject. That subject is exactly what
# separates it from the general capability statement ("Fetching external URLs
# requires your approval") and from the conditional ("That WOULD need your
# approval" — "would" breaks the it/that/this→needs adjacency), both of which
# must stay clean.
_NEEDS_APPROVAL = re.compile(
    r"\b(?:it|that|this)\s+(?:still\s+|currently\s+)?"
    r"(?:needs?|requires?)\s+(?:your\s+)?approval\b",
    re.I,
)
# A general-capability qualifier: "requires your approval IN GENERAL" is a fact
# about a class of actions, not a claim that one is pending, so its clause never
# fires.
_IN_GENERAL = re.compile(r"\bin\s+general\b", re.I)
# Words that, appearing before a state phrase, mean it is not a real current
# pending state: a negation anywhere before it ("nothing is pending approval",
# "not awaiting") or a future auxiliary immediately before it ("will BE waiting
# for your approval"). Scanning only the text BEFORE the match is deliberate —
# the owner's own case, "…awaiting your approval — I can't complete it", carries
# its "can't" AFTER the trigger, and must still fire.
_NEGATORS = frozenset({"no", "not", "never", "nothing", "none", "without"})
_FUTURE_AUX = frozenset({"be", "been"})
_WORD = re.compile(r"[A-Za-z']+")


def _has_negator(before: str) -> bool:
    """True if any negation word appears in the text before a state phrase."""
    for word in _WORD.findall(before):
        low = word.lower()
        if low in _NEGATORS or low.endswith("n't"):
            return True
    return False


def _last_word(before: str) -> str | None:
    words = _WORD.findall(before)
    return words[-1].lower() if words else None


def _asserts_pending(clause: str) -> bool:
    """True if this clause asserts a specific action is CURRENTLY blocked on the
    operator's approval, with the precision guards that keep a future, negated,
    or general form from counting."""
    if _IN_GENERAL.search(clause):
        return False
    m = _PENDING_STATE.search(clause)
    if m is not None:
        before = clause[: m.start()]
        if not _has_negator(before) and _last_word(before) not in _FUTURE_AUX:
            return True
    n = _NEEDS_APPROVAL.search(clause)
    if n is not None and not _has_negator(clause[: n.start()]):
        return True
    return False


def consent_claim_check(reply_text: str, has_pending_consent: bool) -> Correction | None:
    """Contradict a 'pending your approval' claim that no real consent backs.

    Returns a Correction when the reply asserts a specific action is CURRENTLY
    awaiting/pending/blocked-on the operator's approval AND has_pending_consent
    is False; None otherwise — an honest reply, a question/offer/future/general
    form, or a card that really IS pending. Pure and precision-first (see the
    section header). The caller fails OPEN and, on ANY doubt about whether a card
    is pending (e.g. the lookup raised), passes has_pending_consent=True, so an
    honest awaiting reply is never turned into a false correction.
    """
    if has_pending_consent:
        # A card really is pending: the same sentence the guard would flag is
        # then TRUE, so it must stay silent.
        return None
    if not reply_text or not reply_text.strip():
        return None
    for clause, is_question in _clauses(reply_text):
        if is_question:
            continue  # a question/offer ("Want me to fetch it?") asserts nothing
        if _asserts_pending(clause):
            return Correction(claims=(), text=CONSENT_CLAIM_CORRECTION)
    return None


# -- the capability-claim guard --------------------------------------------
#
# A third sibling, for the class the live walk hit last: asked "what's the latest
# from bigblueview.com?", the model CALLED fetch_url, the funnel raised a real
# approval card and returned "Awaiting your approval" — and then the model
# answered "I cannot access external websites or real-time data ... my
# capabilities don't include web browsing." A FALSE CAPABILITY DENIAL: it denied
# a tool (fetch_url) it had JUST exercised. narration_check is for fabricated
# COMPLETED actions and consent_claim_check for fabricated PENDING states;
# neither contradicts a model that disowns a capability it actually holds.
#
# capability_claim_check(reply_text, available_tools) fires ONLY when the reply
# asserts a FIRST-PERSON, PRESENT-TENSE denial of a capability whose satisfying
# tool is ACTUALLY REGISTERED (present in available_tools). The map from a
# capability phrase to the tool that provides it is the control's only knowledge,
# and it is checked against the LIVE tool set the caller passes — never a
# hardcoded belief about what exists (CLAUDE.md: "granting an MCP filesystem
# server silences the filesystem check by itself"). If the satisfying tool is NOT
# registered the denial is HONEST and the guard stays silent — the SAME sentence
# flips verdict on that one membership test, which is the derived-not-hardcoded
# property (mirroring consent_claim_check's has_pending toggle).
#
# Built to the two family rules: PURE (text + the tool names; no model, network
# or clock, so it can never itself narrate) and PRECISION-first (a wrongly-
# corrected honest reply makes the guard the liar, worse than a missed one). Two
# precision cuts carry that:
#
#   * A capability phrase is a GENERAL ability ("access websites", "read files",
#     "fetch URLs") — a plural or indefinite noun, never a specific target. So a
#     SPECIFIC failed attempt ("I can't find a file named report.md", "I couldn't
#     fetch that page — it 404'd", "that URL didn't load") never matches a phrase:
#     "that page"/"report.md" are not the general noun, and a past-tense
#     "couldn't" is not a present denial. An honest result about ONE attempt is
#     left alone; only a denial of the ABILITY itself is contradicted.
#   * The denial must be first-person and present: "I" governs the inability
#     ("I can't", "I'm unable to", "my capabilities don't include"), so a
#     hedge ("I might not be able to"), a question, a future form, a past attempt
#     ("I couldn't"), or another subject ("you can't", "it cannot") never reaches
#     that form and so never fires.

# Capability phrase -> the tool that satisfies it. DERIVED against the live tool
# set at the call site: a phrase only counts as a false denial when its tool is
# in available_tools. A new tool that provides a capability is added here the
# same way narration's _KIND_TOOLS is — and the pinned corpus in
# test_capability_guard.py goes red the day a shipped tool's capability is
# unmapped, which is the intended alarm. Every phrase is a GENERAL ability, never
# a specific target: plural/indefinite nouns only, so "read files"/"read a file"
# match but "read that file"/"read report.md" do not.
_CAPABILITY_TOOLS: tuple[tuple[re.Pattern[str], str], ...] = (
    (
        re.compile(
            r"browse\s+(?:the\s+)?(?:web|internet|websites?)"
            r"|browsing\s+(?:the\s+)?(?:web|internet)"
            r"|web\s+browsing"
            r"|access(?:ing)?\s+(?:external\s+)?websites?"
            r"|access(?:ing)?\s+the\s+(?:web|internet)"
            r"|access(?:ing)?\s+(?:external|real-?time)\s+data"
            r"|real-?time\s+data"
            r"|fetch(?:ing)?\s+(?:a\s+)?urls?",
            re.I,
        ),
        "fetch_url",
    ),
    (
        re.compile(
            r"read(?:ing)?\s+(?:a\s+)?files?\b"
            r"|access(?:ing)?\s+(?:your\s+|the\s+)?files?\b",
            re.I,
        ),
        "workspace_read_file",
    ),
    (
        re.compile(
            r"(?:write|writing|save|saving|create|creating)\s+(?:a\s+)?files?\b",
            re.I,
        ),
        "workspace_write_file",
    ),
    (
        re.compile(
            r"list(?:ing)?\s+(?:your\s+|the\s+)?files?\b"
            r"|list(?:ing)?\s+(?:the\s+contents\s+of\s+)?director(?:y|ies)\b",
            re.I,
        ),
        "workspace_list_files",
    ),
    (
        re.compile(
            r"sav(?:e|ing)\s+(?:\w+\s+){0,2}?to\s+(?:your\s+)?memory"
            r"|stor(?:e|ing)\s+(?:\w+\s+){0,2}?(?:in|to)\s+(?:your\s+)?memory"
            r"|remember(?:ing)?\s+(?:things?|information|anything)\b",
            re.I,
        ),
        "memory_save",
    ),
    (
        re.compile(
            r"search(?:ing)?\s+(?:my\s+|your\s+|through\s+)?memor(?:y|ies)"
            r"|search(?:ing)?\s+(?:my\s+|your\s+)?notes"
            r"|recall(?:ing)?\s+(?:things?|information|our\s+past)\b",
            re.I,
        ),
        "memory_search",
    ),
)

# A first-person, PRESENT-tense inability lead — the capability denied follows
# it. Past ("I couldn't"), other subjects ("you can't", "it cannot") and hedges
# ("I might not be able to") use other words and so never match, which is how a
# past/attributed/hedged form is dropped without a separate blocker. The
# optional "'m"/" am" lets the contraction ("I'm unable to") and the full form
# ("I am unable to") share one pattern.
_DENIAL_LEAD = re.compile(
    r"\bi(?:'m|\s+am)?\s+(?:"
    r"cannot|can'?t|can\s+not"
    r"|unable\s+to"
    r"|not\s+able\s+to"
    r"|don'?t\s+have\s+the\s+ability\s+to|do\s+not\s+have\s+the\s+ability\s+to"
    r"|lack\s+the\s+ability\s+to"
    r"|don'?t\s+have\s+access\s+to|do\s+not\s+have\s+access\s+to"
    r")"
    r"|\bmy\s+capabilit(?:y|ies)\s+(?:don'?t|do\s+not|doesn'?t|does\s+not)\s+include",
    re.I,
)
# The trailing denial form, where the capability phrase comes FIRST:
# "<capability> is not something I can do."
_TRAILING_DENIAL = re.compile(r"\bis\s+not\s+something\s+i\s+can\s+do\b", re.I)


def _capability_correction_text(tools_named: Sequence[str]) -> str:
    """The stated correction: honest, and it NAMES the real tool(s) — derived
    from the registry the caller passed, so the operator sees exactly which
    capability was wrongly disowned. Deliberately worded to carry no inability
    lead and no pending-state phrase, so running any guard on it (self-reference)
    comes back clean."""
    listed = ", ".join(dict.fromkeys(tools_named))  # dedupe, preserve order
    return (
        f"Correction: I can do that — I have a tool for it ({listed}). "
        "If it needs the operator's approval first, calling the tool raises an "
        "approval card for them to approve; that request waiting on their OK is "
        "not a limit on what I can do."
    )


def capability_claim_check(
    reply_text: str, available_tools: Sequence[str]
) -> Correction | None:
    """Contradict a first-person denial of a capability a registered tool holds.

    Returns a Correction naming the wrongly-disowned tool(s), or None when the
    reply is honest — a denial of a capability with NO registered tool, a
    specific failed attempt, a hedge/question/future/past/other-subject form, or
    a plain reply. Pure and precision-first (see the section header). Derived
    from `available_tools`: a denial is only false when its satisfying tool is
    actually in that set, so the verdict reads the live registry, never a list.
    """
    if not reply_text or not reply_text.strip():
        return None
    registered = frozenset(available_tools)
    denied: list[tuple[str, str]] = []  # (matched capability phrase, tool)
    seen: set[str] = set()
    for clause, is_question in _clauses(reply_text):
        if is_question:
            continue  # a question/offer asserts no inability
        lead = _DENIAL_LEAD.search(clause)
        trailing = _TRAILING_DENIAL.search(clause)
        if lead is None and trailing is None:
            continue
        for pattern, tool in _CAPABILITY_TOOLS:
            if tool not in registered or tool in seen:
                # No such tool -> the denial is HONEST; already seen -> counted.
                continue
            for m in pattern.finditer(clause):
                # A LEAD form governs the capability that FOLLOWS it; the
                # trailing form governs the capability BEFORE it. Requiring the
                # phrase on the denial's own side keeps an unrelated capability
                # verb elsewhere in the clause from being swept in.
                after_lead = lead is not None and m.start() >= lead.end()
                before_trailing = trailing is not None and m.end() <= trailing.start()
                if after_lead or before_trailing:
                    seen.add(tool)
                    denied.append((m.group(0).strip(), tool))
                    break
    if not denied:
        return None
    tools_named = [tool for _phrase, tool in denied]
    claims = tuple(
        UnbackedClaim(kind="capability_denied", target=tool, phrase=phrase[:80])
        for phrase, tool in denied
    )
    return Correction(claims=claims, text=_capability_correction_text(tools_named))


# -- the deferral guard ----------------------------------------------------
#
# The fourth sibling, for the class the S3 owner walk hit (2026-08-30): asked
# "what about the pixel?", the small model replied "I'll perform a web search…
# Let me check recent announcements…" and called NO tool — turn a3ffb48e had
# tool_calls=0, no web_search span, status ok. It COMMITTED to a tool action and
# never did it; the turn ended reading like it was still working. This is the
# MIRROR of narration_check: narration catches a fabricated COMPLETED action ("I
# searched and found…" with no span), this catches a PROMISED FUTURE action that
# never ran. A broken promise is a defect, not a preference — and (unlike the
# opt-in responsiveness check, which second-guesses good answers) the redirect it
# triggers only ever fires when a deferral ACTUALLY happened, so the cost is
# targeted. That is why the detector is safe to run on every turn.
#
# deferral_check(reply_text, spans, available_tools) fires ONLY when the reply
# makes a FIRST-PERSON FUTURE COMMITMENT to an action a REGISTERED tool performs
# ("I'll search", "let me look it up", "I'm going to fetch that page") AND no
# successful span of that tool ran this turn. The commitment-phrase -> tool map
# is DERIVED against the live tool set the caller passes: a phrase counts only
# when its tool is in available_tools — the same derived-not-hardcoded property
# as the capability guard, so removing web_search makes "I'll search" honest
# again by itself, and the pinned corpus reddens the day a shipped search/fetch
# tool leaves the registry (the intended alarm).
#
# Built to the family's two rules: PURE (text + spans + the tool names; no model,
# network or clock, so it can never itself become a source of narration) and
# PRECISION-first (a wrongly-corrected honest reply makes the guard the liar,
# worse than a missed one). The precision cuts, all reusing narration_check's
# clause/first-person/question machinery:
#
#   * The tool ACTUALLY RAN this turn (a matching successful span exists) — even
#     when the reply also said "let me search" before showing the results.
#   * An OFFER / question ("Want me to search?", "Should I look it up?", "I can
#     search if you'd like") — a question clause, or an offer/conditional marker,
#     asserts no commitment. (Same exemption as the deferral-guard lesson: a
#     "want me to" is never read as an action.)
#   * A non-tool "action" ("Let me think.", "I'll explain.", "I'll keep that in
#     mind.") — the verb maps to no registered tool, so it is never a deferral.
#   * Past / other-subject / negation ("I couldn't search", "you can search",
#     "I won't search", "I will not search") — the commitment leads are
#     first-person present/future, and a negation between the lead and the action
#     drops the match, so none of these reach a fired verdict.

# Commitment-phrase -> (tool, human action phrase). The pattern is a GENERAL
# future commitment to a class of action, never a specific completed one
# (narration's job). Every alternative is anchored so an unrelated verb cannot be
# swept in: web search phrases exclude a memory/notes object (that would be
# memory_search, a different, unmapped tool), and the fetch verbs require a URL
# or a page/link/site object (so "read the file" — a workspace read — is not a
# fetch). The action phrase is what the redirect nudge and the honest note read
# out to the operator.
_DEFERRAL_TOOLS: tuple[tuple[re.Pattern[str], str, str], ...] = (
    (
        re.compile(
            r"\bweb\s+search\b"
            # "search" for the public web, but NOT "search my/your/the memory|notes"
            # (that is memory_search, which this guard does not map).
            r"|\bsearch(?:ing|es)?\b(?!\s+(?:through\s+)?(?:my|your|our|the)\s+"
            r"(?:memor(?:y|ies)|notes?))"
            r"|\blook(?:ing)?\s+(?:it|that|this|them|these|those|him|her|up)\b"
            r"|\bfind\s+(?:\w+\s+){0,4}?\bonline\b"
            r"|\bcheck\s+(?:the\s+)?(?:web|internet)\b"
            r"|\bgoogle\b",
            re.I,
        ),
        "web_search",
        "search the web",
    ),
    (
        re.compile(
            r"\b(?:fetch|retrieve|pull\s+up|pull|grab|load|open|read|visit|access"
            r"|go\s+to|navigate\s+to)\b"
            r"[^.?!]*?"  # a short bridge, bounded to the clause (no sentence ender)
            r"(?:https?://\S+|\b(?:url|link|page|site|website|web\s*page)\b)",
            re.I,
        ),
        "fetch_url",
        "fetch that page",
    ),
)

# A first-person future-commitment lead — the action follows it. "I'll" REQUIRES
# the apostrophe (bare "ill" is the adjective; "I will" covers the un-contracted
# form), and "let's"/"I'm going to" likewise require it, so an ordinary word
# ("lets me", "im") is never mistaken for a lead. A past ("I searched"), a modal
# ("I could search"), a bare "I can" (only "I can now" commits), a negation ("I
# won't"), and another subject ("you can search") all use other words, so none
# reach a lead — precision comes from the lead set, not a separate blocker.
_COMMIT_LEAD = re.compile(
    r"\bi['’]ll\b"
    r"|\bi\s+will\b"
    r"|\bi['’]m\s+going\s+to\b"
    r"|\bi\s+am\s+going\s+to\b"
    r"|\bi['’]m\s+gonna\b"
    r"|\blet\s+me\b"
    r"|\blet['’]s\b"
    r"|\bi\s+can\s+now\b",
    re.I,
)
# An offer / conditional turns a commitment into a request the operator has not
# accepted ("I can now search IF YOU'D LIKE", "WANT ME TO look it up?"). A clause
# carrying one of these markers is never a deferral — same rule as a question.
_OFFER_MARKER = re.compile(
    r"\bif\s+you\b"
    r"|\bwould\s+you\s+like\b"
    r"|\bdo\s+you\s+want\b"
    r"|\bwant\s+me\s+to\b"
    r"|\bshall\s+i\b"
    r"|\bshould\s+i\b"
    r"|\blet\s+me\s+know\s+if\b",
    re.I,
)
# A negation sitting BETWEEN the lead and the action un-commits it ("I will NOT
# search", "I'll never fetch that page"); the more common "I won't"/"I can't"
# never form a lead in the first place.
_COMMIT_NEGATION = re.compile(r"\bnot\b|\bnever\b|n['’]t\b", re.I)


@dataclass(frozen=True)
class DeferralClaim:
    """A first-person future commitment to a registered tool action that never
    ran this turn. `tool` is the registered tool that would satisfy it,
    `action_phrase` the human phrase the redirect/honest-note read out, and
    `phrase` the matched commitment text for the guard span."""

    tool: str
    action_phrase: str
    phrase: str


def _tool_ran(tool: str, successful: Sequence[Any]) -> bool:
    """True if a successful span of `tool` ran this turn — the mechanical fact
    that turns a 'let me search' into an honest narration of work done."""
    return any(getattr(span, "name", None) == tool for span in successful)


def deferral_check(
    reply_text: str, spans: Sequence[Any], available_tools: Sequence[str]
) -> DeferralClaim | None:
    """A first-person future commitment to a tool action that never ran, or None.

    Returns a DeferralClaim when the reply commits to an action a REGISTERED tool
    performs and no successful span of that tool ran this turn; None otherwise —
    an honest reply, a reply whose tool actually ran, an offer/question/
    conditional, a non-tool 'action', or a past/negated/other-subject form. Pure
    and precision-first (see the section header). Derived from `available_tools`:
    a commitment is only a deferral when its satisfying tool is in that set, so
    the verdict reads the live registry, never a hardcoded list.
    """
    if not reply_text or not reply_text.strip():
        return None
    registered = frozenset(available_tools)
    successful = _successful(spans)
    for clause, is_question in _clauses(reply_text):
        if is_question:
            continue  # a question/offer asserts no commitment
        if _OFFER_MARKER.search(clause):
            continue  # "if you'd like", "want me to" — an offer, not a promise
        lead = _COMMIT_LEAD.search(clause)
        if lead is None:
            continue
        for pattern, tool, action_phrase in _DEFERRAL_TOOLS:
            if tool not in registered:
                # No such tool -> a promise to do it is not a deferral this guard
                # can act on (derived-not-hardcoded: the verdict follows the
                # live registry).
                continue
            m = pattern.search(clause, lead.end())
            if m is None:
                continue  # the action must come AFTER the commitment lead
            if _COMMIT_NEGATION.search(clause[lead.end() : m.start()]):
                continue  # "I will NOT search" — the commitment is negated
            if _tool_ran(tool, successful):
                continue  # the reply said "let me search" and actually searched
            phrase = clause[lead.start() : m.end()].strip()
            return DeferralClaim(tool=tool, action_phrase=action_phrase, phrase=phrase[:80])
    return None


# -- the live-state claim guard --------------------------------------------
#
# The fifth sibling, for the class the owner's device walk hit (2026-09-02
# 23:51): he said "try again"; the turn made ZERO tool calls; the reply was
# "Looks like the device is still offline. Could you confirm it's on and
# connected…" — a claim about the LIVE state of a paired machine, parroted from
# an earlier (then-true) "offline" reply in the history. The device was online.
# No existing guard covers it: it is not a fabricated pending approval, not a
# completed-action claim with a file/url target, and not a capability denial —
# so the turn shipped, and was INGESTED, putting a falsehood in the journal.
#
# state_claim_check(reply_text, spans, device_names) fires ONLY when the reply
# ASSERTS the CURRENT connectivity/availability state of a PAIRED device AND no
# successful device tool span ran this turn. Both halves are mechanical:
#
#   * `device_names` is DERIVED at the call site from the live registry
#     (devices.list_devices), never a list kept here — a household with no
#     paired devices can have no such claim, so the guard never fires there, and
#     pairing a machine arms it by itself.
#   * Backing is any span whose tool name starts with `device_` that either
#     SUCCEEDED or RECORDED a connectivity fact. That prefix is the naming of
#     every device tool in the registry (app/tools/devices.py), so a device tool
#     shipped tomorrow backs the claim the day it lands rather than the day
#     someone remembers to add it to a set here.
#
#     The second half is the fix for the guard's worst failure mode, found in
#     adversarial review: when the device really IS offline, EVERY device tool
#     refuses at the precheck ("not connected — its tile is stale") with
#     ok=False. A model that then honestly says "I ran it and it came back not
#     connected — X is offline" would be corrected, its true reply REPLACED by
#     "I did not actually check", systematically, in the exact scenario the
#     guard exists for. A refusal that DETERMINED connectivity is a check. It is
#     read from the structured fact the per-device layer records
#     (ToolContext.facts_sink -> span.meta["facts"], each {"device", "connected"}),
#     never by sniffing the refusal's prose. A refusal that determined nothing —
#     "no paired device named X" — records nothing and backs nothing.
#
# Built to the family's two rules: PURE (text + spans + the names; no model,
# network or clock) and PRECISION-first (a wrongly-corrected honest reply makes
# the guard the liar, worse than a missed lie). The precision cuts:
#
#   * PRESENT tense only. A past report ("the device was offline earlier") uses
#     a past copula and never matches, and a prior-time marker anywhere in the
#     clause suppresses it outright.
#   * No CONDITIONALS or INTENT. "If the device is offline I'll wake it", "let
#     me check whether the machine is online" — a hedge/subordinator or a
#     check/verify/confirm verb before the assertion means nothing is being
#     asserted about the present.
#   * No QUESTIONS and no REPORTED speech ("you said the device is offline"),
#     via the same _clauses/_REPORTED machinery the other guards use.
#   * The SUBJECT must be a device THIS household has: a paired device's own
#     name, or the one unambiguous vocabulary word "the/your/this/that device".
#     Nothing else. Bare machine nouns (laptop, computer, machine, desktop, PC)
#     were removed in review: with one machine paired they fired on "your laptop
#     is probably asleep", which need not be about a paired device at all — and
#     this guard REPLACES the reply it corrects, so a false positive costs more
#     than any miss.
#   * The STATE must be unambiguously about CONNECTIVITY. Polysemous words were
#     removed in the same review: "up" (up to date), "down" (down for
#     maintenance), "available" (available for pickup) and "connected" (connected
#     to the projector) all produced REPLACE-class false positives. "connected"
#     survives only in shapes that cannot be read another way (clause end, "right
#     now", "again", "to the network").

# The stated correction. MECHANISM-NEUTRAL and honest: it says only what is
# mechanically true (no device tool ran this turn), never why, and never what
# the state actually is — the guard has not checked either.
STATE_CLAIM_CORRECTION = (
    "Correction: I did not actually check the device this turn — I have no "
    "record of doing so."
)

# Every device tool is named device_* — the prefix IS the derivation (see the
# section header), which is why this is a prefix and not a frozenset.
_DEVICE_SPAN_PREFIX = "device_"

# The ONLY bare noun that counts, and the determiners that may head it or a
# device NAME. "device" alone, deliberately: it is the assistant's own word for
# a paired machine (the tools, the settings page and the refusals all say
# "device"), whereas laptop/computer/machine/desktop/PC are ordinary English
# about any hardware — see the section header.
_DEVICE_NOUN = r"(?:devices?)"
_DEVICE_DET = r"(?:the|your|that|this)"
# PRESENT-tense copulas only. "was"/"were" are deliberately absent: a past report
# is not a claim about now, and leaving them out is the whole past-tense cut.
# The present perfect forms ("has gone offline", "has been unreachable") DO
# assert a current state, so they are in.
_PRESENT_COPULA = (
    r"(?:is|are|appears\s+to\s+be|appears|seems\s+to\s+be|seems|looks|remains"
    r"|stays|reads\s+as|shows\s+as"
    r"|(?:has|have)\s+(?:gone|been|become|dropped))"
)
# Adverbs that may sit between the copula and the state word, "not" included: a
# negated state ("the device is not connected") is just as much an unchecked
# claim about now as the positive one, so it must NOT suppress.
_STATE_ADVERB = (
    r"(?:still|currently|now|again|apparently|probably|likely|definitely"
    r"|no\s+longer|back|not|already|actually|indeed)"
)
# The states themselves — UNAMBIGUOUSLY about connectivity, and nothing else.
# "connected" is the one word that needs a shape test rather than a ban: it is a
# real connectivity state ("the device is connected.") and also an ordinary
# transitive verb ("the device is connected to the projector"), so it counts
# only at a clause end or in front of the few adverbials that can only mean the
# link ("right now", "again", "to the network").
_STATE_WORD = (
    r"(?:offline|online|disconnected|unreachable|not\s+reachable|stale"
    r"|out\s+of\s+contact|powered\s+(?:on|off)"
    r"|connected(?=\s*(?:[.,;:!?)\]}]|$)|\s+(?:right\s+now|again|to\s+the\s+network)\b))"
)
# A hedge/subordinator BEFORE the assertion — nothing is being asserted about
# the present ("if the device is offline…", "once the machine is online…").
_STATE_HEDGE = re.compile(
    r"\b(?:if|whether|unless|in\s+case|assuming|suppose|supposing|maybe|perhaps"
    r"|possibly|might|may|could|would|should|once|when|until|before|after"
    r"|either)\b",
    re.I,
)
# An INTENT verb before the assertion — the reply is proposing to establish the
# state, not stating it ("let me check the device is online", "can you confirm
# the machine is connected").
_STATE_INTENT = re.compile(
    r"\b(?:check|checking|verify|verifying|confirm|confirming|see|test|testing"
    r"|determine|determining|find\s+out|ping|pinging)\b",
    re.I,
)


@dataclass(frozen=True)
class StateClaim:
    """An unchecked assertion about a paired device's CURRENT state.

    `device` is the device reference the reply used (what the redirect nudge
    names back), `phrase` the matched assertion for the guard span, and `text`
    the stated correction — the same shape the other guards' Correction carries,
    so the turn's composition reads it identically.
    """

    device: str
    phrase: str
    text: str = STATE_CLAIM_CORRECTION


@lru_cache(maxsize=64)
def _state_patterns(names: tuple[str, ...]) -> tuple[re.Pattern[str], re.Pattern[str]]:
    """(current-state assertion, last-seen assertion) for one set of paired
    names. Cached on the names tuple: the pattern is a pure function of the live
    registry, and a household's device list changes rarely.
    """
    named = "|".join(re.escape(name) for name in names)
    subject = (
        rf"(?P<dev>{_DEVICE_DET}\s+{_DEVICE_NOUN}"
        rf"|(?:{_DEVICE_DET}\s+)?(?:{named}))"
    )
    assertion = re.compile(
        rf"\b{subject}"
        rf"(?:\s+{_PRESENT_COPULA}|['’]s)"
        rf"(?:\s+{_STATE_ADVERB})*"
        rf"\s+{_STATE_WORD}\b",
        re.I,
    )
    # "last seen …" read as a CURRENT staleness report. Its own branch because
    # the phrase is inherently past-referring — the prior-time suppressor that
    # protects the copula branch would eat every one of these.
    last_seen = re.compile(
        rf"\b{subject}\s+(?:was\s+|is\s+|has\s+been\s+)?last\s+seen\b", re.I
    )
    return assertion, last_seen


def _determined_connectivity(span: Any) -> bool:
    """True if this span carries a structured connectivity fact — the record the
    per-device layer writes the moment it decides whether a machine's socket is
    live, for BOTH outcomes (app/tools/base.py ToolContext.facts_sink). Read as
    data, never as prose: no refusal string is ever inspected."""
    facts = (getattr(span, "meta", None) or {}).get("facts")
    if not isinstance(facts, list):
        return False
    return any(isinstance(fact, dict) and "connected" in fact for fact in facts)


def _checked_a_device(spans: Sequence[Any]) -> bool:
    """Did this turn actually LOOK at a device? Two ways, both mechanical:

      * a successful device_* span (the ordinary case), or
      * a device_* span that DETERMINED connectivity and then refused — an
        offline machine refuses every device tool at the precheck, and that
        refusal is exactly the check the reply is reporting (see the section
        header; this is the guard's worst failure mode without it).

    A device_* span that settled nothing — an unknown device name, a schema
    refusal — backs nothing.
    """
    for span in spans:
        if getattr(span, "kind", None) != "tool":
            continue
        name = str(getattr(span, "name", "") or "")
        if not name.startswith(_DEVICE_SPAN_PREFIX):
            continue
        meta = getattr(span, "meta", None) or {}
        if meta.get("ok") is True or _determined_connectivity(span):
            return True
    return False


def _state_prefix_blocks(before: str) -> bool:
    """A hedge, subordinator or intent verb before the assertion means the
    clause proposes/qualifies the state rather than asserting it."""
    return _STATE_HEDGE.search(before) is not None or _STATE_INTENT.search(before) is not None


def state_claim_check(
    reply_text: str, spans: Sequence[Any], device_names: Sequence[str]
) -> StateClaim | None:
    """Contradict a live-device-state claim no device check backs this turn.

    Returns a StateClaim when the reply asserts the CURRENT connectivity or
    availability of a paired device and NO successful device_* span ran this
    turn; None otherwise — an honest reply backed by a real check, a past/
    hedged/questioned/reported form, or a household with nothing paired. Pure
    and precision-first (see the section header). Derived from `device_names`:
    with no paired devices there is no such claim to make, so the guard is
    silent by construction rather than by a special case.
    """
    if not reply_text or not reply_text.strip():
        return None
    names = tuple(sorted({str(name).strip() for name in device_names if str(name).strip()}))
    if not names:
        return None
    if _checked_a_device(spans):
        # A real check happened: whatever the reply says about the device is
        # backed by a span, and this guard has nothing to say about accuracy.
        return None
    assertion, last_seen = _state_patterns(names)
    for clause, is_question in _clauses(reply_text):
        if is_question:
            continue  # a question asserts no state ("is the device online?")
        if _REPORTED.search(clause) is not None:
            continue  # "you said the device is offline" — someone else's claim
        m = assertion.search(clause)
        if m is not None and not _state_prefix_blocks(clause[: m.start()]):
            if _PRIOR_TIME.search(clause) is None:
                return StateClaim(
                    device=m.group("dev").strip(),
                    phrase=m.group(0).strip()[:80],
                )
        s = last_seen.search(clause)
        if s is not None and not _state_prefix_blocks(clause[: s.start()]):
            return StateClaim(device=s.group("dev").strip(), phrase=s.group(0).strip()[:80])
    return None
