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
from typing import Any, NamedTuple

# Successful spans of these tools ground each kind of claim. The names come
# from the tool registry; a new filesystem/fetch tool must be added here, or
# the guard would flag an honest use of it — and the pinned corpus in
# test_guards.py goes red the day that happens, which is the intended alarm.
_WRITE_TOOLS = frozenset({"workspace_write_file", "memory_save"})
_READ_TOOLS = frozenset({"workspace_read_file"})
_CONTENT_TOOLS = frozenset({"workspace_read_file", "workspace_write_file"})
_FETCH_TOOLS = frozenset({"fetch_url"})
_PULL_TOOLS = frozenset({"model_pull"})
_REMOVE_TOOLS = frozenset({"model_remove"})
_SPEND_TOOLS = frozenset({"spend_report"})

_KIND_TOOLS: dict[str, frozenset[str]] = {
    "wrote_file": _WRITE_TOOLS,
    "read_file": _READ_TOOLS,
    "file_contents": _CONTENT_TOOLS,
    "fetched_url": _FETCH_TOOLS,
    "pulled_model": _PULL_TOOLS,
    "removed_model": _REMOVE_TOOLS,
    "stated_spend": _SPEND_TOOLS,
}

# A stated SPEND figure — "we spent $0.0005 today", "today's spend: $3.20",
# "$12 spent on openrouter", "you've been charged $4" — with no spend_report
# span this turn is a number nobody read from the ledger (S10, the walk of
# 2026-09-08: the fallback model answered "$0.0005 on local models" from the
# previous turn's memory, wrong on both counts). Anchored on a LEDGER word
# (spent / spend / spending / charged / charges / bill) in the same clause
# as a dollar figure; "cost" is deliberately absent — "opus costs $15 per
# million tokens" is price talk, not a claim about the ledger.
_SPEND_WORD = r"(?:spent|spend|spending|charged|charges?|bill(?:ed)?)"
_STATED_SPEND = re.compile(
    r"\b" + _SPEND_WORD + r"\b[^.?!\n]{0,80}?\$\s?\d"
    r"|\$\s?\d[\d,.]*[^.?!\n]{0,80}?\b" + _SPEND_WORD + r"\b",
    re.I,
)
SPEND_CORRECTION_TEXT = (
    "Correction: I did not read the spend ledger this turn — that figure is not from the record."
)

# "I pulled / downloaded / installed <model ref>": a completed-pull claim,
# anchored on a MODEL REFERENCE token (name:tag, user/name:tag, hf.co/org/
# repo[:quant], optionally ollama:-qualified) — never a bare noun, so "I
# installed the update" is ordinary chat and never fires. Backed only by a
# successful model_pull span whose `model` argument names that ref.
_PULLED_MODEL = re.compile(
    r"\bi(?:'ve|\s+have|\s+just|\s+have\s+just)?\s+(?:just\s+)?"
    r"(?:pulled|downloaded|installed)\s+(?:the\s+)?(?:model\s+)?"
    r"(?P<ref>(?:ollama:)?(?:hf\.co/[\w.-]+/[\w.-]+(?::[\w.-]+)?|[\w.-]+(?:/[\w.-]+)?:[\w.-]+))",
    re.I,
)
# "I removed / deleted / uninstalled <model ref>": the same anchor, backed
# only by a successful model_remove span naming that ref.
_REMOVED_MODEL = re.compile(
    r"\bi(?:'ve|\s+have|\s+just|\s+have\s+just)?\s+(?:just\s+)?"
    r"(?:removed|deleted|uninstalled)\s+(?:the\s+)?(?:model\s+)?"
    r"(?P<ref>(?:ollama:)?(?:hf\.co/[\w.-]+/[\w.-]+(?::[\w.-]+)?|[\w.-]+(?:/[\w.-]+)?:[\w.-]+))",
    re.I,
)

# The stated correction, appended to the reply and streamed as its own frame.
# One sentence, the same for every claim kind: the operator's durable record
# and screen both show the contradiction, and the claim's kind/target land in
# the guard span rather than in prose.
CORRECTION_TEXT = (
    "Correction: I did not actually do that — there is no record of the action this turn."
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
    {
        "have",
        "has",
        "had",
        "just",
        "already",
        "also",
        "then",
        "now",
        "finally",
        "recently",
        "went",
        "ahead",
        "and",
        "or",
        "since",
        "personally",
    }
)

# The filename is the object of a completed active verb only if it is reached
# WITHOUT crossing a clause boundary: a conjunction/comma before any object
# ("I updated my approach and config.yaml is …"), a finite verb starting a new
# predicate ("config.yaml is the file …"), a subordinator, or another action
# verb all end the object walk. A list conjunction AFTER a filename ("saved
# a.md and b.md") continues the list; otherwise it breaks.
_LIST_CONT = frozenset({"and", "or", ","})
_STOP_WORDS = frozenset(
    {
        "but",
        "nor",
        "so",
        "yet",
        "plus",
        "because",
        "which",
        "who",
        "that",
        "whom",
        "whose",
        "where",
        "when",
        "while",
        "since",
        "if",
        "unless",
        "though",
        "although",
        "whereas",
        "before",
        "after",
        "once",
        "until",
        "is",
        "are",
        "was",
        "were",
        "be",
        "been",
        "am",
        "can",
        "could",
        "will",
        "would",
        "shall",
        "should",
        "may",
        "might",
        "must",
        "has",
        "have",
        "had",
        "do",
        "does",
        "did",
        "need",
        "needs",
        "want",
        "wants",
        "seems",
        "looks",
        "remains",
        "becomes",
        "stays",
        "you",
        "you'll",
        "you've",
        "we",
        "we'll",
        "they",
        "he",
        "she",
    }
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
    {
        "file",
        "files",
        "document",
        "documents",
        "doc",
        "docs",
        "note",
        "notes",
        "memo",
        "readme",
        "script",
        "scripts",
        "page",
        "pages",
        "copy",
        "version",
    }
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
    {
        "a",
        "an",
        "the",
        "this",
        "that",
        "these",
        "those",
        "my",
        "your",
        "his",
        "her",
        "its",
        "our",
        "their",
        "one",
        "another",
        "some",
        "any",
        "no",
        "each",
        "every",
        "new",
        "old",
        "updated",
        "revised",
        "final",
        "first",
        "second",
        "third",
        "latest",
        "initial",
        "complete",
        "entire",
        "whole",
        "same",
        "short",
        "small",
        "brief",
        "quick",
        "simple",
        "plain",
        "draft",
        "up",
        "back",
        "down",
        "out",
        "over",
        "here",
        "there",
        "above",
        "below",
        "just",
        "also",
        "now",
        "then",
        "brand",
    }
)
# Prepositions and adverbs that can FOLLOW the verb's object without being the
# noun it modifies — "created groceries.md WITH the items", "wrote deploy.sh
# TODAY". A filename followed by one of these keeps its object status; a
# filename followed by a bare content noun ("config.yaml parsing logic") does
# not (it is a pre-nominal modifier).
_PREP_ADVERB = frozenset(
    {
        "with",
        "from",
        "by",
        "at",
        "in",
        "per",
        "via",
        "without",
        "within",
        "after",
        "before",
        "during",
        "through",
        "under",
        "since",
        "until",
        "against",
        "toward",
        "towards",
        "today",
        "tonight",
        "yesterday",
        "tomorrow",
        "again",
        "once",
        "twice",
        "soon",
        "later",
        "earlier",
        "still",
        "yet",
        "too",
        "instead",
        "successfully",
    }
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

    # a spend figure with no ledger read behind it (target: the clause).
    sm = _STATED_SPEND.search(clause)
    if sm is not None:
        claims.append(("stated_spend", None, sm.group(0)))

    # pulled a model: I + pulled/downloaded/installed + a model reference.
    for pm in _PULLED_MODEL.finditer(clause):
        claims.append(("pulled_model", _strip_trailing_punct(pm.group("ref")), pm.group(0)))
    for rm in _REMOVED_MODEL.finditer(clause):
        claims.append(("removed_model", _strip_trailing_punct(rm.group("ref")), rm.group(0)))

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


def successful_tool_names(spans: Sequence[Any]) -> list[str]:
    """The names of every successful tool span this turn, in order, deduped.

    Shares `_successful`'s definition of "ran" with `ran_a_tool` — one
    derivation for what counts as a real execution. chat.py's bare-intent
    redirect reads this to name what actually ran when it must NOT report a
    dispatched tool as if nothing happened (a markup call that ran is never
    reported as nothing ran).
    """
    seen: list[str] = []
    for span in _successful(spans):
        name = span.name
        if name not in seen:
            seen.append(name)
    return seen


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
    if span.name in ("model_pull", "model_remove", "model_check_update"):
        model = args.get("model")
        return model if isinstance(model, str) else None
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
    return any(needle in _strip_trailing_punct((t or "").strip()).lower() for t in span_targets)


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
                unbacked.append(UnbackedClaim(kind=kind, target=target, phrase=phrase.strip()[:80]))
    if not unbacked:
        return None
    if all(claim.kind == "stated_spend" for claim in unbacked):
        return Correction(claims=tuple(unbacked), text=SPEND_CORRECTION_TEXT)
    return Correction(claims=tuple(unbacked))


# -- the pending-approval claim guard --------------------------------------
#
# A sibling of narration_check, for a lie the live walk caught: the model
# answered a follow-up by PARROTING an earlier turn's "that fetch is awaiting
# your approval" line — no tool call, nothing pending anywhere — and the
# operator was stranded waiting on a step that did not exist. The system prompt
# telling the model there is no such step is a request; this is the line of
# code that refuses.
#
# There IS no approval step in v4 (owner ruling 2026-09-03): nothing Nova does
# waits on the owner, so a reply asserting that an action is CURRENTLY awaiting
# / pending / blocked-on / in need of the operator's approval is a fabrication
# by construction. consent_claim_check(reply_text) is therefore a PURE TEXT
# DETECTOR with no external fact to consult — no card, no consent table, no
# disposition anywhere for it to read. The name is kept because it names the
# LIE (the span vocabulary the evals and the Activity page read), not a
# mechanism.
#
# It is built to narration_check's two rules: PURE (text only; no model,
# network or clock, so it can never itself become a source of narration) and
# PRECISION-first (a wrongly-corrected honest reply makes the guard itself the
# liar, worse than a missed lie). It reuses _clauses so a question or an offer
# ("Want me to fetch it?") is never read as an assertion; a negation before the
# state phrase ("nothing is pending your approval", "I don't need your
# approval") keeps an honest report clean; and a future/conditional form ("that
# would need your approval", "I'd have to request approval") never reaches the
# current-state shapes. A GENERAL statement about a class of HER OWN actions
# ("fetching URLs requires your approval in general") DOES fire: with no
# approval step it is exactly as false as "that fetch is awaiting your
# approval". But a statement RELAYED from the world — a third-party subject
# ("the pull request needs your approval on GitHub"), or an approval line the
# model is quoting or reporting ("the README states releases require your
# approval") — is honest content, not a fabricated pending-claim, and is left
# alone (the subject restriction and _reported_frame, the paste-exemption idea).
#
# The correction is MECHANISM-NEUTRAL and says only what is mechanically true:
# there is no approval step, nothing is waiting on the operator, nothing ran.
# It carries no pending-state phrase itself (pinned: every guard is clean over
# its own correction) and invites the retry without describing a path.
CONSENT_CLAIM_CORRECTION = (
    "Correction: there is no approval step — nothing is waiting on you and "
    "nothing has run. Tell me again and I'll do it."
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
# "<subject> needs|requires your approval" — a CURRENT blocked state. The
# SUBJECT is the anchor, and it must be HERS to assert: a demonstrative
# (it/that/this) or a gerund/action phrase naming a class of Nova's own actions
# ("fetching external URLs requires your approval", "running commands on the
# device needs your OK"). A THIRD-PARTY subject read from the world ("the pull
# request needs your approval on GitHub", "your expense report requires your
# sign-off in Workday") is relayed content, NOT a fabricated pending-claim of
# hers, so it is not swept in — the earlier form fired on ANY subject and so
# REPLACED honest relayed reports, the worst failure a REPLACE-class guard can
# have (precision-first, ruling S2d-R2). The operator-directed object (your /
# the operator's / the owner's OK, approval, sign-off, go-ahead) is still
# required, so some OTHER system's reviewers ("the PR needs approval from a
# maintainer") never counted anyway. The conditional ("that WOULD need your
# approval") is cut by the modal immediately before the verb (see _is_modal); a
# negation anywhere before it ("I don't need your approval") by _has_negator;
# and RELAYED content that happens to carry a demonstrative/gerund subject ("the
# docs say: 'this requires your approval'", "according to the runbook, deploying
# to production requires your approval") by the reporting-frame exemption
# (_reported_frame) — the same idea as presented_listing's paste exemption.
_NEEDS_APPROVAL = re.compile(
    r"\b(?:it|that|this|\w+ing\b[^.?!]{0,60}?)\s+"
    r"(?:still\s+|currently\s+)?(?P<verb>needs?|requires?)\s+"
    r"(?:your\s+|the\s+(?:operator|owner)['’]?s\s+)"
    r"(?:ok|okay|approval|sign-?off|go-?ahead)\b",
    re.I,
)
# Words that, appearing before a state phrase, mean it is not a real current
# pending state: a negation anywhere before it ("nothing is pending approval",
# "not awaiting") or a future auxiliary immediately before it ("will BE waiting
# for your approval"). Scanning only the text BEFORE the match is deliberate —
# the owner's own case, "…awaiting your approval — I can't complete it", carries
# its "can't" AFTER the trigger, and must still fire.
_NEGATORS = frozenset({"no", "not", "never", "nothing", "none", "without"})
_FUTURE_AUX = frozenset({"be", "been"})
# A modal or infinitive marker right before "needs/requires" makes the clause a
# conditional or a future ("that would need your approval", "it will require
# your OK", "to need approval"), not a current blocked state.
_MODAL_AUX = frozenset(
    {"would", "could", "might", "may", "will", "shall", "should", "must", "can", "to"}
)
_WORD = re.compile(r"[A-Za-z'’]+")
# A REPORTING FRAME leading a clause means the approval statement is RELAYED —
# something says/said/emailed/states it, or it is quoted "according to" a
# source. Content Nova is echoing from the world is not her own fabricated
# pending-claim, so a demonstrative/gerund subject inside relayed text ("the
# docs say: 'this requires your approval'") must NOT fire. A verbatim quote or a
# label colon before the clause ("note:", a pasted line) carries the same
# meaning. The double single-quote is deliberately NOT a delimiter here — an
# apostrophe ("It's", "I've") would then read as a quote and silence an honest
# fabrication. This mirrors presented_listing's paste exemption: text the model
# is relaying is exempt; text it is asserting as its own is not.
_REPORTING_FRAME = re.compile(
    r"\b(?:says?|said|saying|states?|stated|stating"
    r"|emails?|emailed|reads?|reading"
    r"|wrote|writes?|written|reports?|reported|reporting"
    r"|notes?|noted|noting|mentions?|mentioned"
    r"|according\s+to)\b",
    re.I,
)
_REPORT_DELIMITERS = (":", '"', "`", "“", "”")


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


def _is_modal(word: str | None) -> bool:
    """A modal/infinitive marker ("would", "will", "to", the contracted "'d" /
    "'ll") — the word that turns "needs your approval" into a conditional."""
    if word is None:
        return False
    return word in _MODAL_AUX or word.endswith(("'d", "’d", "'ll", "’ll"))


def _reported_frame(before: str) -> bool:
    """True if the text up to a state phrase is a reporting frame — the approval
    statement is RELAYED (a source says/said/emailed/states it, or it is quoted
    'according to' something) or set off by a label colon or an opening quote.
    Such a clause is content the model is echoing from the world, not its own
    fabricated pending-claim, so it is exempt (the same idea as presented_listing's
    paste exemption)."""
    if _REPORTING_FRAME.search(before) is not None:
        return True
    return any(ch in before for ch in _REPORT_DELIMITERS)


def _asserts_pending(clause: str) -> bool:
    """True if this clause asserts an action is CURRENTLY blocked on, or in
    need of, the operator's approval — with the precision guards that keep a
    future, conditional, negated or RELAYED form from counting."""
    m = _PENDING_STATE.search(clause)
    if m is not None:
        before = clause[: m.start()]
        if (
            not _has_negator(before)
            and _last_word(before) not in _FUTURE_AUX
            and not _reported_frame(before)
        ):
            return True
    n = _NEEDS_APPROVAL.search(clause)
    if n is not None:
        # Up to the VERB, not the match start: the subject may be a long gerund
        # phrase ("according to the runbook, deploying to production" — where
        # "according" itself matches \w+ing), so a negation, a modal, or a
        # reporting frame that sits in that phrase is only visible in the text
        # before the verb.
        before = clause[: n.start("verb")]
        if (
            not _has_negator(before)
            and not _is_modal(_last_word(before))
            and not _reported_frame(before)
        ):
            return True
    return False


def consent_claim_check(reply_text: str) -> Correction | None:
    """Contradict a 'pending your approval' claim — none can be true.

    Returns a Correction when the reply asserts an action is CURRENTLY
    awaiting/pending/blocked-on the operator's approval, or that it needs the
    operator's approval at all; None otherwise — an honest reply, a question or
    offer, a negated report, or a future/conditional form. Pure and
    precision-first (see the section header): it reads the text and nothing
    else, because there is no approval state anywhere for it to read.
    """
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
# from bigblueview.com?", the model CALLED fetch_url — and then, in the same
# turn, answered "I cannot access external websites or real-time data ... my
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
# hardcoded belief about what exists (CLAUDE.md: "registering a tool in the
# registry silences the matching capability check by itself"). If the satisfying tool is NOT
# registered the denial is HONEST and the guard stays silent — the SAME sentence
# flips verdict on that one membership test, which is the derived-not-hardcoded
# property (the same membership test the deferral guard reads).
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
    (
        re.compile(
            r"(?:download|pull|install)(?:ing)?\s+"
            r"(?:(?:a|new|local|any|other|another|more)\s+){0,2}"
            r"(?:ai\s+|language\s+|llm\s+)?models?\b",
            re.I,
        ),
        "model_pull",
    ),
    (
        re.compile(
            r"(?:search|browse|list|look\s+up)(?:ing)?\s+(?:for\s+)?"
            r"(?:(?:the|available|local|installed|new|other|your|my|our)\s+){0,2}"
            r"(?:ai\s+|language\s+|llm\s+)?models?\b"
            r"|search(?:ing)?\s+hugging\s*face",
            re.I,
        ),
        "model_catalog_search",
    ),
    (
        re.compile(
            r"(?:remove|delete|uninstall)(?:ing)?\s+"
            r"(?:(?:a|an|the|installed|local|any|old|unused)\s+){0,2}"
            r"(?:ai\s+|language\s+|llm\s+)?models?\b",
            re.I,
        ),
        "model_remove",
    ),
    (
        re.compile(
            r"check(?:ing)?\s+(?:for\s+)?(?:model\s+)?updates?\b(?:\s+(?:for|on|to)\s+(?:a\s+|the\s+)?models?)?"
            r"|(?:update|upgrade|refresh)(?:ing)?\s+(?:(?:a|an|the|installed|local)\s+){0,2}models?\b",
            re.I,
        ),
        "model_check_update",
    ),
    (
        # S9: "I can't set reminders" / "I'm unable to remind you" / "scheduling
        # tasks is not something I can do" — a denial of the ability itself. A
        # SPECIFIC refused attempt keeps its honesty: "I can't set a reminder for
        # a time that has already passed", "I can't set a reminder until a
        # timezone is set for this instance" (the tools' own refusals, relayed),
        # "I can't remind you of what you said" (a memory statement) are about
        # one time, one condition or one thing — not the ability. ONE lookahead
        # on all three alternatives drops a condition/target tail (until,
        # unless, without, before, at, on, in, of, about, for <anything but
        # "you"> — `for\b` so a quoted or parenthesised object after "for" is a
        # tail like any other: "for 'stretch' until…" is a relay, not a denial);
        # without it the guard would put "Correction: I can do that" under an
        # honest sentence and become the liar. Precision-first: "I can't set a
        # reminder for you" still fires; "I can't set reminders in this
        # version" is the accepted miss. "yet" is NOT a tail: "I can't set
        # reminders yet" is exactly the false denial of an unshipped feature.
        re.compile(
            r"(?:set(?:ting)?\s+(?:up\s+)?(?:a\s+|an\s+|any\s+)?(?:reminder|timer|alarm)s?"
            r"|remind(?:ing)?\s+(?:you|people|anyone)"
            r"|schedul(?:e|ing)\s+(?:a\s+|an\s+|any\s+)?"
            r"(?:reminder|timer|task|turn|instruction|message|check|job|anything|things?)s?)\b"
            r"(?!\s+(?:until|unless|without|before|at|on|in|of|about|for\b(?!\s+you\b)"
            r"|that\s+(?:has|is|was)|which\s+(?:has|is|was))\b)",
            re.I,
        ),
        "create_timer",
    ),
    # S12 (2026-09-08): the agent tools. Added the day the live walk caught
    # her disowning delegation — her prompt listed delegate_to_agent AND the
    # roster named coder, and she still answered "that capability isn't in my
    # toolset", which is the whole reason a phrase table exists beside the
    # prompt. "delegate" is anchored on an agent or a name so an ordinary
    # "delegate that decision to you" is not swept in.
    (
        re.compile(
            r"delegat(?:e|ing|ion)\s+(?:to\s+)?(?:an?\s+|the\s+)?agents?\b"
            r"|delegat(?:e|ing)\s+(?:[\w'-]+\s+){0,3}?to\s+(?:an?\s+|the\s+)?"
            r"(?:agent|[a-z][a-z_]{1,25})\b"
            r"|hand(?:ing)?\s+(?:[\w'-]+\s+){0,3}?off\s+to\s+(?:an?\s+|the\s+)?"
            r"(?:agent|[a-z][a-z_]{1,25})\b"
            r"|hand(?:ing)?\s+off\s+(?:work|tasks?|it|this|that)\b"
            r"|hand(?:ing)?\s+(?:[\w'-]+\s+){0,3}?to\s+(?:an?\s+|the\s+)?agents?\b",
            re.I,
        ),
        "delegate_to_agent",
    ),
    (
        re.compile(
            r"(?:creat(?:e|ing)|mak(?:e|ing)|set(?:ting)?\s+up)\s+"
            r"(?:a\s+|an\s+|new\s+|another\s+){0,2}agents?\b",
            re.I,
        ),
        "create_agent",
    ),
    (
        re.compile(
            r"(?:list(?:ing)?|see|show(?:ing)?)\s+(?:my\s+|your\s+|the\s+)?agents?\b",
            re.I,
        ),
        "list_agents",
    ),
    (
        re.compile(
            r"(?:delet(?:e|ing)|remov(?:e|ing))\s+(?:a\s+|an\s+|the\s+|my\s+){0,2}agents?\b",
            re.I,
        ),
        "delete_agent",
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
    return f"Correction: I can do that — I have a tool for it ({listed})."


def capability_claim_check(reply_text: str, available_tools: Sequence[str]) -> Correction | None:
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
# deferral_check(reply_text, spans, available_tools, user_message) fires on TWO
# shapes, both of them the model handing back what it was asked to do:
#
#   * A COMMITMENT (kind="commitment"): a FIRST-PERSON FUTURE COMMITMENT to an
#     action a REGISTERED tool performs ("I'll search", "let me look it up",
#     "I'm going to fetch that page") AND no successful span of that tool ran
#     this turn. The commitment-phrase -> tool map is DERIVED against the live
#     tool set the caller passes: a phrase counts only when its tool is in
#     available_tools — the same derived-not-hardcoded property as the
#     capability guard, so removing web_search makes "I'll search" honest again
#     by itself, and the pinned corpus reddens the day a shipped search/fetch
#     tool leaves the registry (the intended alarm).
#
#   * An OFFER THAT RESTATES THE INSTRUCTION (kind="offer"; owner ruling
#     2026-09-03, docs/plans/rebuild/no-approvals.md): the user's message
#     INSTRUCTED an action a registered tool performs ("check the web for the
#     latest pixel phone", "list my workspace files", "how much disk is free on
#     the dell?", "read config.json") and the reply, instead of doing it, ASKS
#     WHETHER TO ("Want me to search the web for that?", "I can list them if
#     you'd like.", "Should I check the disk usage on the Dell?", "Would you
#     like me to open config.json?") with no span of that action this turn.
#     There is no approval step in v4 — nothing he could click — so the
#     question is not a question; it is the instruction handed back to him,
#     the exact per-command friction the ruling rejects. Before the ruling the
#     shared `_OFFER_MARKER` exempted every offer ("an offer asserts no
#     commitment"); it still exempts a GENUINE offer, i.e. one with NO
#     instruction behind it, or one proposing something OTHER than what was
#     asked — see the precision cuts below.
#
#     "Restates the instruction" is derived, never a phrase list kept for the
#     purpose: the SAME action-class table (`_OFFER_CLASSES`, phrase -> the
#     registered tools that perform it) is run over the user's message to find
#     what was instructed and over the offer clause to find what was offered,
#     and the guard fires only where the two name the same class. A class
#     counts on either side only when one of its tools is registered.
#
# Built to the family's two rules: PURE (text + spans + the tool names; no model,
# network or clock, so it can never itself become a source of narration) and
# PRECISION-first (a wrongly-corrected honest reply makes the guard the liar,
# worse than a missed one). The precision cuts, all reusing narration_check's
# clause/first-person/question machinery:
#
#   * The tool ACTUALLY RAN this turn (a matching successful span exists) — even
#     when the reply also said "let me search" before showing the results. For
#     the offer shape ANY span of the instructed class, failed included, is
#     enough: an offer after a real attempt ("the search failed — should I try
#     again?", "done — want me to also list src/?") is about what comes NEXT,
#     not the instruction handed back. "After doing it" is read off the spans,
#     never off the word order of the reply ("Done. Want me to…" with nothing
#     run is still nothing run).
#   * A commitment clause that is an OFFER / question ("Want me to search?",
#     "Should I look it up?", "I can search if you'd like") asserts no
#     commitment — it is judged as an offer instead, and an offer is a deferral
#     ONLY when it restates an instruction (above). With no instruction behind
#     it ("Want to hear a joke?", an unprompted "I can search the web if you
#     like") it is exactly what it looks like, and never fires.
#   * A CLARIFYING QUESTION is never an offer, even after an instruction: a
#     clause led by a wh-word ("Which directory should I list — the project or
#     your home?") asks for a MISSING PARAMETER; an alternative ("Do you want
#     the full tree or just the top level?", "Do you mean the Dell or the
#     laptop?", "Search the web or your notes?") asks for a SCOPE choice, and
#     a question with no first-person offered action in it ("Do you mean…")
#     offers nothing. Each is the one thing the ruling leaves her to ask.
#     A scope question that ALSO offers the instructed action ("Do you want me
#     to list hidden files too?", "Should I list the whole tree, including
#     node_modules?") fires, by the ruling's own definition — it offers to
#     perform what was instructed — while the same scope question with no
#     offered action in it ("Do you want me to include hidden files?", "Should
#     I include subdirectories?") stays clean. Accepted KNOWN MISSES on the
#     same cut, precision-first: "Would you like me to search for it, or answer
#     from what I know?" and "…, or is that not needed?" read as an alternative
#     (the "or" cut has no way to tell a non-tool alternative from a second
#     tool), and a bare "Should I go ahead?" / "Want me to?" / "Should I
#     proceed?" names no action to derive.
#   * The instruction RESTATED is not an offer: "Got it — you want me to check
#     the web for the latest Pixel. Which region?" / "I understand you want me
#     to read config.json, but it doesn't exist." carry the "want me to" marker
#     with HIS subject in front of it and no interrogative/conditional before
#     that subject ("do you want me to", "if you want me to" still offer).
#     Accepted KNOWN MISSES on this cut, precision-first: a CONFIRMATION that
#     puts a non-interrogative word, or nothing, before his subject — "Are you
#     sure you want me to open config.json?", "So you want me to search the
#     web?", "You'd want me to search the web first, right?" — reads as the
#     restatement and stays clean, deliberately: the cut has no way to tell it
#     from "Got it — you want me to…" without reading the whole sentence, and
#     a restatement wrongly corrected is the worse failure.
#   * An offer of a DIFFERENT action than the one instructed ("Done. Want me
#     to also summarise it?") maps to no instructed class, so it is a genuine
#     offer of extra work and stays clean.
#   * A STATEMENT-form offer ("I can search the web for that.", "I could list
#     them for you.", "Happy to open config.json whenever you're ready.") is
#     the same instruction handed back without the question mark, and reaches
#     the offer verdict too — only while NO tool ran successfully this turn:
#     after real work a plain "I can/could…" reads as a report of what she
#     found ("I could see config.json in the listing"), and the offer after
#     work is caught in its question form ("want me to…") by the span rule
#     above. A commitment in the same clause ("…so I'll search the web now")
#     is judged as the commitment first, so nothing that fired before stops.
#   * A non-tool "action" ("Let me think.", "I'll explain.", "I'll keep that in
#     mind.") — the verb maps to no registered tool, so it is never a deferral.
#   * Past / other-subject / negation ("I couldn't search", "you can search",
#     "I won't search", "I will not search") — the commitment leads are
#     first-person present/future, and a negation between the lead and the action
#     drops the match, so none of these reach a fired verdict. On the USER side
#     the same rule holds for what counts as an instruction: "don't search the
#     web" instructs nothing, and "did you search the web?" asks about the past.
#     A MENTION of the action is not an instruction either — the user side has
#     a request frame: his own first-person report ("I read config.json and it
#     looks wrong", "I've been searching the web all day") instructs nothing
#     unless the subject carries a request verb ("I need you to…", "I want…",
#     "I said…", "we should…"), and a second verb coordinated with that report
#     ("I listed the files AND read config.json") is still his report — while
#     every match of the phrase is read, so a mention never hides the request
#     that follows it ("I read config.json and it looks wrong — can you read
#     config.json again?" instructs); a search "in my notes" is memory_search,
#     never the web, read to the end of its own coordination unit ("search the
#     web for the pixel and save it in my notes" is a web search); and a
#     device resource named in a plain statement ("my disk usage has been high
#     lately") only instructs when the clause is a question or carries a
#     request word (check/tell/show/how/what/can/please/need/want…) — the
#     terse "dell disk usage" is the accepted KNOWN MISS on that cut.


# An action class: the phrase that names an action, the registered tools that
# perform it, and the human phrase the redirect nudge and honest note read out.
# `restated` is the OFFER-side-only form of the same action whose object is a
# pronoun standing in for the instruction's ("open it", "list them", "check
# that") — it can only ever be read against an instruction that supplied the
# object, so it is never used to detect an instruction.
class _ActionClass(NamedTuple):
    pattern: re.Pattern[str]
    tools: tuple[str, ...]
    action_phrase: str
    restated: re.Pattern[str] | None = None

    def registered_tool(self, registered: frozenset[str]) -> str | None:
        """The first tool of this class in the live registry, or None — a class
        with none registered is not an action she can take, on either side."""
        for tool in self.tools:
            if tool in registered:
                return tool
        return None


# Commitment-phrase -> class. The pattern is a GENERAL future commitment to a
# class of action, never a specific completed one (narration's job). Every
# alternative is anchored so an unrelated verb cannot be swept in: web search
# phrases exclude a memory/notes object (that would be memory_search, a
# different, unmapped tool), and the fetch verbs require a URL or a
# page/link/site object (so "read the file" — a workspace read — is not a
# fetch). The action phrase is what the redirect nudge and the honest note read
# out to the operator.
_WEB_SEARCH = _ActionClass(
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
    ("web_search",),
    "search the web",
)
_FETCH_VERB_ALTS = r"fetch|retrieve|pull\s+up|pull|grab|load|open|read|visit|access"
_FETCH_URL = _ActionClass(
    re.compile(
        r"\b(?:" + _FETCH_VERB_ALTS + r"|go\s+to|navigate\s+to)\b"
        r"[^.?!]*?"  # a short bridge, bounded to the clause (no sentence ender)
        r"(?:https?://\S+|\b(?:url|link|page|site|website|web\s*page)\b)",
        re.I,
    ),
    ("fetch_url",),
    "fetch that page",
    restated=re.compile(
        r"\b(?:" + _FETCH_VERB_ALTS + r")\s+(?:it|that|this|them|that\s+one)\b", re.I
    ),
)
# The COMMITMENT shape's classes are declared below _SET_REMINDER (they are
# read at import time, so the tuple must follow the classes it names).

# The classes an INSTRUCTION can name and an OFFER can restate — the ones the
# ruling lists (web search / fetch, list / read files, run a command, check a
# device), each anchored on an object that cannot be read another way, and
# each counted only while one of its tools is registered.
_FILE_PLACE = r"(?:workspace|folders?|director(?:y|ies)|dirs?|tree|repo(?:sitory)?)"
_LIST_FILES = _ActionClass(
    re.compile(
        # "list my workspace files", "show me the directory structure", "ls the folder"
        r"\b(?:list|ls|enumerate|show|display)\b(?:\s+(?:me|all|every|each|out|up))*"
        r"(?:\s+(?:the|my|your|our|this|that|those|these|of|in|inside|under|current"
        r"|whole|entire|full|top[- ]level))*"
        r"(?:\s+[A-Za-z][\w'-]*){0,2}?"
        r"\s+(?:them|files?|folders?|director(?:y|ies)|dirs?|contents?|tree|workspace"
        r"|entries|structure|listing|layout)\b"
        # "what's in my workspace?", "which files are in the folder"
        r"|\bwhat(?:['’]s|\s+is|\s+are)\s+(?:in|inside|under)\s+(?:the|my|your|our)\s+"
        + _FILE_PLACE
        + r"|\b(?:files?|folders?)\s+(?:are\s+|is\s+)?(?:in|inside|under)\s+(?:the|my|your|our)\s+"
        + _FILE_PLACE
        # "check / look at / browse the workspace"
        + r"|\b(?:check|look\s+(?:at|in|into|through)|inspect|scan|explore|browse|see)\s+"
        r"(?:the|my|your|our)\s+" + _FILE_PLACE,
        re.I,
    ),
    ("workspace_list_files", "device_list_files"),
    "list the files",
    restated=re.compile(r"\b(?:list|show|display)\s+(?:it|them|that|this|those|these)\b", re.I),
)
_FILE_NOUN = (
    r"(?:files?|readme|config(?:uration)?|logs?|notes?|documents?|docs?|scripts?|manifest"
    r"|changelog|license|makefile|dockerfile|env|settings|source|code)"
)
_READ_VERBS = (
    r"(?:read|open|cat|show|display|print|view|check|look\s+at|pull\s+up|fetch|grab|load"
    r"|see|inspect|review)"
)
_READ_FILE = _ActionClass(
    re.compile(
        r"\b" + _READ_VERBS + r"\b(?:\s+(?:me|up|out|into|through|over|at))*"
        r"(?:\s+(?:the|my|your|our|this|that|those|these|its|a|an|whole|entire|full"
        r"|current|latest|new|old))*"
        r"(?:\s+[A-Za-z][\w'-]*){0,2}?"
        r"\s+(?:" + _FILENAME_RE + r"|" + _FILE_NOUN + r")\b"
        # "the files in my workspace" is a listing, not a read
        r"(?!\s+(?:are\s+|is\s+)?(?:in|inside|under)\s+(?:the|my|your|our)\s+" + _FILE_PLACE + r")"
        r"|\bwhat(?:['’]s|\s+is)\s+in\s+" + _FILENAME_RE + r"\b"
        r"|\bcontents?\s+of\s+(?:the\s+|my\s+|your\s+)?" + _FILENAME_RE + r"\b",
        re.I,
    ),
    ("workspace_read_file", "device_read_file"),
    "read that file",
    restated=re.compile(
        r"\b" + _READ_VERBS + r"\s+(?:it|that|this|them|that\s+one|its\s+contents?"
        r"|the\s+contents?|the\s+file)\b",
        re.I,
    ),
)
_RUN_COMMAND = _ActionClass(
    re.compile(
        r"\b(?:run|execute|exec|invoke)\b"
        r"(?:\s+(?:the|a|an|this|that|my|your|our|quick|full|another|same))*"
        r"(?:\s+(?:command|cmd|commands|script|scripts|check|scan|query|it|that|this|them)\b"
        r"|\s+`[^`]+`"
        r"|\s+(?:ls|find|df|du|ps|top|htop|grep|netstat|ss|ping|whoami|pwd|uname|git"
        r"|docker|systemctl|uptime|free|cat|tail|head|lsblk|ip|ifconfig|nvidia-smi)\b)",
        re.I,
    ),
    ("device_run",),
    "run that command",
)
_RESOURCE = r"(?:disks?|storage|drives?|space|swap|gpu|vram|cpu|processor|ram|memory)"
_CHECK_DEVICE = _ActionClass(
    re.compile(
        r"\b" + _RESOURCE + r"\s+(?:usage|use|space|free|left|remaining|available|load"
        r"|utili[sz]ation|pressure|temp(?:erature)?|capacity|stats?|status)\b"
        r"|\b(?:free|available|used|remaining|leftover)\s+" + _RESOURCE + r"\b"
        r"|\bhow\s+(?:much|many)\s+(?:" + _RESOURCE + r"|free\s+space|space\s+is\s+left)\b"
        r"|\b" + _RESOURCE + r"\s+(?:is|are|do\s+i\s+have|have\s+i\s+got|i\s+have|is\s+there"
        r"|are\s+there)\s+(?:free|left|remaining|available|used|full)\b"
        r"|\b(?:uptime|load\s+average|running\s+processes|system\s+(?:info|information"
        r"|status|stats|load|health)|battery\s+(?:level|status|percentage|percent))\b"
        r"|\b(?:cpu|gpu|system)\s+temp(?:erature)?s?\b"
        r"|\bwhat(?:['’]s|\s+is)\s+running\s+on\b"
        r"|\b(?:is|are)\s+(?:the\s+)?(?:disk|drive|storage)s?\s+full\b",
        re.I,
    ),
    ("device_info", "device_run"),
    "check the device",
    # "check" with nothing but a pronoun / adverb behind it, up to the clause
    # end or a conditional tail ("check that if you want") — "check your
    # calendar" is a different action and does not match.
    restated=re.compile(
        r"\b(?:check|find\s+out|look\s+into|take\s+a\s+look)\b"
        r"(?:\s+(?:it|that|this|them|for\s+you|now|right\s+now|again|myself|on\s+it))*"
        r"\s*(?=[.!?…,;:—–-]|$|\s+(?:if|when|whenever|should|once)\b)",
        re.I,
    ),
)
# "pull / download / install <a model ref | the model>": her pull, anchored on a
# model reference or the word model, so a URL/page fetch ("pull up the page",
# _FETCH_URL) and a file read are never swept in.
_MODEL_REF = r"(?:ollama:)?(?:hf\.co/[\w.-]+/[\w.-]+(?::[\w.-]+)?|[\w.-]+(?:/[\w.-]+)?:[\w.-]+)"
_PULL_MODEL = _ActionClass(
    re.compile(
        r"\b(?:pull|download|install|grab|get)\b(?:\s+(?:me|us|down))?"
        r"(?:\s+(?:the|a|that|this|new|another|smaller|bigger|local))*"
        r"\s+(?:" + _MODEL_REF + r"|(?:\w+\s+){0,2}?models?\b)",
        re.I,
    ),
    ("model_pull",),
    "pull the model",
    restated=re.compile(
        r"\b(?:pull|download|install)\s+(?:it|that|this|them|that\s+one|one)\b", re.I
    ),
)

# S9: "remind me in two minutes to stretch" / "set a reminder for 7" / "schedule
# a daily summary at 7" instruct create_timer; "Want me to set a reminder?",
# "Should I remind you?", "I can schedule that if you'd like" hand it back.
# `reminds` (as in "that reminds me") needs the bare verb plus an object pronoun
# and so never matches; "schedule" alone ("what's on my schedule?") needs a
# timer-shaped noun after it, so a calendar question is not an instruction here.
_TIMER_NOUN = r"(?:reminder|timer|alarm)"
_SET_REMINDER = _ActionClass(
    re.compile(
        # "remind me what/of/how/where/who/why/about what…" asks for RECALL (a
        # memory search), not a timer: "can you remind me what we discussed
        # yesterday?" + "I can remind you of the details if you'd like" is a
        # genuine offer, and the lookahead keeps it one. "remind me of the
        # meeting at 3" is the accepted miss (precision-first).
        # "nudge/ping/alert you" are the same promise in other words — the
        # walk's exact reply was "I'll nudge you to blink every 5 minutes".
        r"\b(?:remind|nudge|ping|alert)\s+(?:me|us|you|him|her|them)\b"
        r"(?!\s+(?:what|of|how|where|who|why|about\s+what)\b)"
        r"|\bset(?:ting)?\s+(?:up\s+)?(?:a\s+|an\s+|another\s+|the\s+|my\s+)?"
        + _TIMER_NOUN
        + r"s?\b"
        r"|\bschedul(?:e|ing)\s+(?:a\s+|an\s+|another\s+|the\s+|my\s+)?(?:\w+\s+){0,2}?"
        r"(?:reminder|timer|task|turn|check|summary|report|message|instruction|run|job)s?\b",
        re.I,
    ),
    # create_timer is the tool an instruction/commitment of this class calls
    # (registered_tool returns the first); the other two also COUNT as work
    # of the class — after a real list_timers, "your reminder is running" is a
    # report of what she read, not a fabrication.
    ("create_timer", "list_timers", "cancel_timer"),
    "set the reminder",
    restated=re.compile(r"\b(?:set|schedule|create|add)\s+(?:it|that|this|one)(?:\s+up)?\b", re.I),
)
# The COMMITMENT shape maps these three: a text-only "do it now" regeneration
# (chat._deferral_redirect) is the whole recovery for a commitment, and every
# other class of promise is caught by bare_intent_check with a tools-advertised
# redirect. _SET_REMINDER joined on 2026-09-07 from the S9 walk: "remind me
# every 5 minutes to blink" was answered "Done — I'll nudge you to blink every
# 5 minutes" with NO tool call — a promise that can only be kept by a timer
# row, so a first-person commitment to remind with no create_timer span this
# turn is exactly this shape. Widening this tuple widens the commitment shape;
# the offer shape below reads the full class table.
_DEFERRAL_TOOLS: tuple[_ActionClass, ...] = (_WEB_SEARCH, _FETCH_URL, _SET_REMINDER)
_OFFER_CLASSES: tuple[_ActionClass, ...] = (
    *_DEFERRAL_TOOLS,
    _LIST_FILES,
    _READ_FILE,
    _RUN_COMMAND,
    _CHECK_DEVICE,
    _PULL_MODEL,
    _SET_REMINDER,
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
# carrying one of these markers is never a COMMITMENT — it is read as an OFFER,
# and (owner ruling 2026-09-03) an offer is a deferral of its own kind when it
# restates the action the user already instructed; see `_restated_offer`.
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
# The first-person OFFERED action's lead, inside an offer clause: "want me to
# X", "should/shall/could/can I X", "I can/could X", "happy to X" — and every
# commitment lead too, because inside an offer clause "I'll check that if you
# want" is a commitment gated on a consent that does not exist. A clause with
# no such lead ("Do you want the full tree or just the top level?", "Do you
# mean the Dell?") offers no action of hers and is never a deferral.
# The leads that make an offer WITHOUT a question mark or an offer marker: a
# bare first-person modal ("I can/could X") or a willingness ("happy to X").
# They are the statement-form half of `_OFFER_LEAD` below, and the ONLY thing
# that lets a plain statement clause reach the offer verdict (deferral_check).
_STATEMENT_OFFER = re.compile(
    r"\bi\s+(?:can|could|would|might|may)\b"
    r"(?:\s+(?:also|just|now|quickly|certainly|happily|gladly|always|easily|of\s+course))*"
    r"|\bi['’]d\s+(?:be\s+)?(?:happy|glad)\s+to\b"
    r"|\bi['’]m\s+(?:happy|glad)\s+to\b"
    r"|\b(?:happy|glad)\s+to\b",
    re.I,
)
_OFFER_LEAD = re.compile(
    r"\b(?:want|like|need|wish|prefer)\s+me\s+to\b"
    r"|\b(?:should|shall|could|can|may|might|would)\s+i\b"
    r"|\b(?:how\s+about|what\s+if)\s+i\b"
    r"|" + _STATEMENT_OFFER.pattern + r"|" + _COMMIT_LEAD.pattern,
    re.I,
)
# The "…me to" lead with HIS subject directly in front of it ("you want me to
# read config.json") is the instruction restated, not offered — unless an
# interrogative / conditional precedes that subject ("do you want me to",
# "would you like me to", "if you want me to", "whenever you want me to"),
# which is the offer again. Read off the words before the lead only.
_ME_TO_LEAD = re.compile(r"\b(?:want|like|need|wish|prefer)\s+me\s+to\b", re.I)
_SUBJECT_BEFORE_LEAD = re.compile(
    r"(?<![\w'’])(?:you|you['’]d|you['’]re|he|she|they|we)\s+(?:\w+\s+){0,2}$", re.I
)
_INTERROGATIVE_BEFORE = re.compile(
    r"\b(?:do|does|did|would|will|if|whether|unless|should|might|could|can|say|when"
    r"|whenever)\s+(?:\w+\s+){0,3}$",
    re.I,
)
# A clarifying question asks for a MISSING PARAMETER (a wh-lead: "which
# directory should I list?") or a SCOPE choice (an alternative: "the full tree
# or just the top level?", "the web or your notes?"). Either is the one thing
# the ruling leaves her to ask, so an offer clause shaped like one never fires.
_WH_LEAD = re.compile(
    r"^\W*(?:(?:and|so|but|or|ok|okay|sure|also)\b[,:\s—–-]*)?"
    r"(?:just\s+to\s+(?:confirm|check|clarify|be\s+sure)[,:\s—–-]*)?"
    r"(?:which|what|where|who|whom|whose|how|when)\b(?!\s+(?:about|if)\b)",
    re.I,
)
_ALTERNATIVE = re.compile(r"\bor\b", re.I)
# A negation sitting BETWEEN the lead and the action un-commits it ("I will NOT
# search", "I'll never fetch that page", "I can answer that WITHOUT searching
# the web"); the more common "I won't"/"I can't" never form a lead in the first
# place. Read only between lead and action, so "I'll search the web without
# delay" keeps its commitment.
_COMMIT_NEGATION = re.compile(r"\bnot\b|\bnever\b|n['’]t\b|\bwithout\b", re.I)
# On the USER side, what stops an action phrase from being an instruction: a
# negation before it ("don't search the web", "no need to list them", "instead
# of reading it") and a question about the PAST ("did you search the web?").
_USER_NEGATION = re.compile(
    r"\b(?:don['’]t|do\s+not|never|no\s+need\s+to|without|instead\s+of|rather\s+than|not"
    r"|didn['’]t|did\s+not|haven['’]t|have\s+not|can['’]t|cannot|couldn['’]t|won['’]t"
    r"|shouldn['’]t|stop)\b"
    # a bare "no" right before the action ("No searching please", "no more
    # searching") — searched over the text BEFORE the match, so it anchors at
    # that text's end rather than looking ahead at the action itself
    r"|\bno\s+(?:\w+\s+)?$",
    re.I,
)
# A MENTION is not an instruction. His own first-person report ("I read
# config.json and it looks wrong", "I've been searching the web all day") sits
# directly (0–2 words) before the action phrase, or one coordinated verb phrase
# back from it ("I listed the files AND read config.json" — a few words, the
# coordinator, at most one more), with no request verb on the subject; "I need
# you to…", "I want…", "I'd like…", "I said…", "we should…" keep the request.
_USER_SELF_REPORT = re.compile(
    r"\b(?:i|i['’]ve|i['’]m|i['’]d|i['’]ll|we|we['’]ve|we['’]re)\b"
    r"(?!\s+(?:need|want|would|like|wish|wonder|was\s+wondering|am\s+wondering"
    r"|should|must|said|mean|meant|asked|told)\b)"
    r"\s+(?:(?:\w+\s+){0,2}|(?:[\w.'’/-]+\s+){1,5}?(?:and|or)\s+(?:\w+\s+)?)$",
    re.I,
)
# A search whose object lives "in my notes" is memory_search, not the web — the
# class pattern already excludes the object right after "search"; this reads
# the rest of the search's own coordination unit ("search for the pixel in my
# notes"), cut at the first comma / "and" / "then" so "search the web for the
# pixel AND save it in my notes" stays the web search it asks for.
_NOTES_TAIL = re.compile(
    r"\b(?:in|through|across|within)\s+(?:my|your|our|the)\s+(?:memor(?:y|ies)|notes?)\b",
    re.I,
)
_COORD_BREAK = re.compile(r"[,;]|\b(?:and|then)\b", re.I)
# A device RESOURCE named in a plain statement ("my disk usage on the dell has
# been high lately") asks nothing; the noun-anchored device class instructs only
# when the clause is a question or carries a request word. "is/are/do" are left
# out on purpose — "the disk is full" is a statement, and "is the disk full?"
# is a question by its mark.
_REQUEST_FRAME = re.compile(
    r"\b(?:check|tell|show|give|report|what|how|which|where|can|could|would|will"
    r"|please|need|want)\b",
    re.I,
)
_USER_PAST_QUERY = re.compile(
    r"^\W*(?:did|have|has|had|were|was|when\s+did|why\s+did|how\s+did)\s+"
    r"(?:you|it|that|she|he|they|nova)\b",
    re.I,
)
# An offer that is RELAYED rather than made: reported speech before the lead
# ("you asked: should I search?") or an opening quote. `_REPORTED` (a subject
# plus a saying verb) rather than the pending guard's `_REPORTING_FRAME`, whose
# bare "notes" would read "I can't find it in my notes, want me to search?" as
# a report.
_QUOTE_PAIRS = (('"', '"'), ("`", "`"), ("\u201c", "\u201d"))


def _inside_quote(before: str) -> bool:
    """True when the text before a lead opens a quote it never closes — the
    lead sits inside reported text. Parity, not presence: a closed pair
    ("I found `config.json` — want me to open it?") is her own sentence."""
    for opener, closer in _QUOTE_PAIRS:
        if opener == closer:
            if before.count(opener) % 2:
                return True
        elif before.count(opener) > before.count(closer):
            return True
    return False


@dataclass(frozen=True)
class DeferralClaim:
    """A first-person future commitment to a registered tool action that never
    ran this turn, or an offer that hands the instructed action back instead
    of doing it. `tool` is the registered tool that would satisfy it,
    `action_phrase` the human phrase the redirect/honest-note read out,
    `phrase` the matched text for the guard span, and `kind` which shape it
    is — "commitment", "offer", or "completion" (a present-tense claim that a
    timer exists / is set with no timer tool span behind it, S9 walk)."""

    tool: str
    action_phrase: str
    phrase: str
    kind: str = "commitment"


def _tool_ran(tool: str, successful: Sequence[Any]) -> bool:
    """True if a successful span of `tool` ran this turn — the mechanical fact
    that turns a 'let me search' into an honest narration of work done."""
    return any(getattr(span, "name", None) == tool for span in successful)


def _attempted(cls: _ActionClass, spans: Sequence[Any]) -> bool:
    """True if ANY tool span of this class — successful or not — was recorded
    this turn. The offer shape's exemption: an offer after a real attempt at
    the instructed action is about what comes next, not the instruction
    handed back. Read off the spans, never off the reply's word order.

    A REFUSED call is not an attempt: a call written as markup, or made in a
    closed round, is recorded as a tool span (ok=False) so the trace shows it,
    but nothing ran — and the redirect would happily regenerate it with tools.
    Read from the flag the refusal itself writes (`refused_*` in the span's
    meta, chat._refuse_call), never a list of reasons kept here."""
    for span in spans:
        if getattr(span, "kind", None) != "tool" or getattr(span, "name", None) not in cls.tools:
            continue
        meta = getattr(span, "meta", None) or {}
        if any(str(key).startswith("refused") for key in meta):
            continue
        return True
    return False


def _instructed_classes(user_message: str, registered: frozenset[str]) -> tuple[_ActionClass, ...]:
    """The action classes the user's message INSTRUCTS, in table order — the
    same class table read against his text, restricted to classes with a
    registered tool (derived from the live registry, so a household without
    a paired device is never 'instructed' to check one). A negated phrase
    ("don't search the web") and a question about the past ("did you search
    the web?") instruct nothing, and neither does a MENTION: his own report
    of doing it ("I read config.json and it looks wrong"), a search in his
    notes (memory, not the web), or a device resource named in a statement
    that asks nothing ("my disk usage has been high lately"). Every match of
    a phrase is read and the first to survive the cuts decides, so a mention
    never hides the request after it ("I read config.json and it looks wrong
    — can you read config.json again?" instructs the read)."""
    if not user_message or not user_message.strip():
        return ()
    found: list[_ActionClass] = []
    for clause, is_question in _clauses(user_message):
        if _USER_PAST_QUERY.match(clause):
            continue
        for cls in _OFFER_CLASSES:
            if cls in found or cls.registered_tool(registered) is None:
                continue
            if cls is _CHECK_DEVICE and not is_question and not _REQUEST_FRAME.search(clause):
                continue  # "my disk usage has been high lately" states, asks nothing
            for m in cls.pattern.finditer(clause):
                before = clause[: m.start()]
                if _USER_NEGATION.search(before) or _USER_SELF_REPORT.search(before):
                    continue
                tail = _COORD_BREAK.split(clause[m.end() :], 1)[0]
                if cls is _WEB_SEARCH and _NOTES_TAIL.search(tail):
                    continue  # "search for the pixel in my notes" — memory, not the web
                found.append(cls)
                break
    return tuple(found)


def _restated_offer(
    clause: str,
    instructed: Sequence[_ActionClass],
    registered: frozenset[str],
    spans: Sequence[Any],
) -> DeferralClaim | None:
    """The offer-shape verdict for one offer clause: a DeferralClaim when the
    clause offers, in the first person, an action of a class the user already
    instructed and nothing of that class was attempted this turn; None for a
    clarifying question, an offer of something else, a negated or relayed
    offer, or an offer after a real attempt."""
    if _WH_LEAD.match(clause) or _ALTERNATIVE.search(clause):
        return None  # asks for a parameter or a scope choice — hers to ask
    for lead in _OFFER_LEAD.finditer(clause):
        before = clause[: lead.start()]
        if _REPORTED.search(before) or _inside_quote(before):
            continue  # relayed ("you said: should I search?"), not her offer
        if (
            _ME_TO_LEAD.fullmatch(lead.group(0))
            and _SUBJECT_BEFORE_LEAD.search(before)
            and not _INTERROGATIVE_BEFORE.search(before)
        ):
            continue  # "you want me to read config.json" — his instruction, restated
        for cls in instructed:
            m = cls.pattern.search(clause, lead.end())
            if m is None and cls.restated is not None:
                m = cls.restated.search(clause, lead.end())
            if m is None:
                continue  # offers something else — a genuine offer
            if _COMMIT_NEGATION.search(clause[lead.start() : m.start()]):
                continue  # "I can't search" — no offer of the action
            if _attempted(cls, spans):
                continue  # the instructed thing ran (or was tried): extra work
            tool = cls.registered_tool(registered)
            if tool is None:
                continue
            phrase = clause[lead.start() : m.end()].strip()
            return DeferralClaim(
                tool=tool, action_phrase=cls.action_phrase, phrase=phrase[:80], kind="offer"
            )
    return None


# -- the COMPLETION shape of the deferral guard (S9 walk, 2026-09-07) ------
#
# The third shape, for the second lie the S9 walk caught: asked "remind me every
# 5 minutes to blink" (after the commitment shape had learned "I'll nudge you"),
# the model answered "Verified — your blink reminder is now running. It'll fire
# every 5 minutes…" with ZERO tool calls. No commitment lead ("I'll"), no
# file/url verb for narration, no device for the state guard — a claim that a
# TIMER EXISTS, in the present tense, with nothing behind it. A timer exists only
# as a row create_timer wrote, so the claim is backed by exactly one thing: a
# successful timer tool span THIS turn (create_timer wrote it; list_timers or
# cancel_timer read the rows it is reporting on). Same rules as the family:
# PURE, PRECISION-first — a question, a negation before the claim ("no reminder
# is set", "isn't running"), a quoted/relayed line, or a second-person "you can
# set a reminder" is never a claim; the recovery is the offer shape's redirect
# WITH TOOLS ADVERTISED, so the row gets written this time.
_TIMER_STATE_NOUN = r"(?:reminder|timer|alarm|nudge|schedule)s?"
_TIMER_COMPLETION = re.compile(
    # "your blink reminder is now running", "the timer has been set", "reminders are scheduled"
    rf"\b{_TIMER_STATE_NOUN}\s+(?:is|are|was|were|has\s+been|have\s+been)\s+"
    r"(?:now\s+|all\s+|already\s+|officially\s+)?"
    r"(?:set|running|active|scheduled|in\s+place|live|saved|created|added|armed)\b"
    # "I've set a reminder", "I set up a daily timer", "I just scheduled the nudge"
    rf"|\bi(?:['’]ve|\s+have|\s+just|\s+went\s+ahead\s+and)?\s+"
    r"(?:set|scheduled|created|added|saved|started|armed)\s+(?:up\s+)?"
    rf"(?:a\s+|an\s+|the\s+|your\s+|that\s+|this\s+|another\s+)?(?:[\w-]+\s+){{0,2}}?{_TIMER_STATE_NOUN}\b"
    # "Reminder set (id …)" / "Timer scheduled." at the head of a sentence — the
    # tool's own report shape, which is exactly what a fabrication imitates
    rf"|(?:^|[.!?—–:-]\s*){_TIMER_STATE_NOUN}\s+(?:set|scheduled|created|added|armed)\b",
    re.I,
)
_COMPLETION_NEGATION = re.compile(
    r"\bno\b|\bnot\b|\bnever\b|n['’]t\b|\bwithout\b|\bcan(?:not|['’]t)\b|\bunable\b", re.I
)


def _timer_completion(
    clause: str, registered: frozenset[str], successful: Sequence[Any]
) -> DeferralClaim | None:
    """The completion-shape verdict for one non-question clause: a DeferralClaim
    (kind "completion") when the clause asserts that a timer exists / is set /
    is running and no timer tool ran successfully this turn; None otherwise."""
    tool = _SET_REMINDER.registered_tool(registered)
    if tool is None:
        return None  # no timers on this instance — nothing to claim about
    if any(_tool_ran(name, successful) for name in _SET_REMINDER.tools):
        return None  # she wrote or read the rows this turn: a report, not a claim
    for m in _TIMER_COMPLETION.finditer(clause):
        before = clause[: m.start()]
        if _REPORTED.search(before) or _inside_quote(before):
            continue  # relayed or quoted, not her own assertion
        if _COMPLETION_NEGATION.search(before):
            continue  # "no reminder is set" / "I couldn't set the reminder"
        return DeferralClaim(
            tool=tool,
            action_phrase=_SET_REMINDER.action_phrase,
            phrase=clause[m.start() : m.end()].strip()[:80],
            kind="completion",
        )
    return None


def deferral_check(
    reply_text: str,
    spans: Sequence[Any],
    available_tools: Sequence[str],
    user_message: str = "",
) -> DeferralClaim | None:
    """A first-person future commitment to a tool action that never ran, or an
    offer that hands the instructed action back, or None.

    Returns a DeferralClaim when the reply commits to an action a REGISTERED tool
    performs and no successful span of that tool ran this turn (kind
    "commitment"), or when `user_message` instructed an action a registered tool
    performs and the reply asks whether to do that same action instead of doing
    it (kind "offer"); None otherwise — an honest reply, a reply whose tool
    actually ran, a genuine offer or clarifying question, a non-tool 'action',
    or a past/negated/other-subject form. Pure and precision-first (see the
    section header). Derived from `available_tools`: a commitment or an offer is
    only a deferral when its satisfying tool is in that set, so the verdict
    reads the live registry, never a hardcoded list. With no `user_message`
    the offer shape is inert: an offer with no instruction behind it is genuine.
    """
    if not reply_text or not reply_text.strip():
        return None
    registered = frozenset(available_tools)
    successful = _successful(spans)
    instructed = _instructed_classes(user_message, registered)
    for clause, is_question in _clauses(reply_text):
        if is_question or _OFFER_MARKER.search(clause):
            # A question/offer asserts no COMMITMENT ("if you'd like", "want me
            # to") — but an offer to do what was just instructed is the
            # instruction handed back (owner ruling 2026-09-03).
            if instructed:
                offer = _restated_offer(clause, instructed, registered, spans)
                if offer is not None:
                    return offer
            continue
        lead = _COMMIT_LEAD.search(clause)
        for cls in _DEFERRAL_TOOLS if lead is not None else ():
            tool = cls.registered_tool(registered)
            if tool is None:
                # No such tool -> a promise to do it is not a deferral this guard
                # can act on (derived-not-hardcoded: the verdict follows the
                # live registry).
                continue
            m = cls.pattern.search(clause, lead.end())
            if m is None:
                continue  # the action must come AFTER the commitment lead
            if _COMMIT_NEGATION.search(clause[lead.end() : m.start()]):
                continue  # "I will NOT search" — the commitment is negated
            if _tool_ran(tool, successful):
                continue  # the reply said "let me search" and actually searched
            phrase = clause[lead.start() : m.end()].strip()
            return DeferralClaim(tool=tool, action_phrase=cls.action_phrase, phrase=phrase[:80])
        # The COMPLETION shape: "your reminder is now running" / "I've set a
        # reminder" with no timer tool span this turn (see its section).
        completion = _timer_completion(clause, registered, successful)
        if completion is not None:
            return completion
        # A STATEMENT-form offer ("I can search the web for that.") — the same
        # instruction handed back without the question mark. Judged AFTER the
        # commitment shape so a mixed clause keeps kind="commitment", and only
        # while nothing ran successfully this turn (after real work a plain
        # "I could…" is a report of what she found — see the section header).
        if instructed and not successful and _STATEMENT_OFFER.search(clause):
            offer = _restated_offer(clause, instructed, registered, spans)
            if offer is not None:
                return offer
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
#     refuses before sending ("not connected — its tile is stale") with
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
    "Correction: I did not actually check the device this turn — I have no record of doing so."
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
    last_seen = re.compile(rf"\b{subject}\s+(?:was\s+|is\s+|has\s+been\s+)?last\s+seen\b", re.I)
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
        offline machine refuses every device tool before sending, and that
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


# -- the BARE-INTENT deferral: an acknowledgment with nothing behind it -----
#
# Real trace, 2026-09-03 14:43 UTC, local model muse-glimmer: the user asked
# "show me my workspace directory structure"; the ENTIRE reply was "Got it.
# Checking the workspace…" with ZERO tool calls (tools advertised, the device
# online). No guard fired: deferral_check's commitment leads
# ("I'll", "let me", "I'm going to") require a first-person MODAL mapped to a
# REGISTERED search/fetch tool; a bare present-progressive ack-and-go
# ("Checking…") names no such lead, and a general "I'll check the disk usage
# for you" (the owner's actual 15:06 reply) names a modal but no
# search/fetch action — both were structurally invisible to the check built
# to catch exactly this class of broken promise.
#
# bare_intent_check(reply_text, spans) fires ONLY when the ENTIRE
# whitespace-normalized reply (after an optional one-word ack — "Got it.",
# "Sure.", "OK.", "Right.", joined by a period/comma/dash or plain space) IS
# an intent-to-act phrase and nothing else, AND no successful tool span ran
# this turn at all (guards.ran_a_tool — unlike deferral_check, a bare intent
# names no specific tool, so ANY real work this turn backs it). Two shapes
# both count as "an intent-to-act phrase":
#
#   * a bare present-progressive / stock ack-and-go: "Checking…", "Running…",
#     "Fetching…", "Looking into…", "Looking that up", "Let me check/look/
#     see/run/find…", "On it", "I'm on it", "One moment/sec", "Working on
#     it", "I'll get right on that".
#   * a GENERAL first-person future commitment — "I'll/I will/I'm going to/
#     I'm gonna <verb> [object]" — for a verb this module does NOT already
#     map to a tool (check, look into/at/up, run, fetch, find, see, get,
#     pull, list, read, grab, take a look (at), dig into, investigate,
#     verify, confirm). The bounded object already covers a short trailing
#     "for you"/"now"/"right away" the same way it covers any other object.
#
# "Nothing else" is enforced the same way the rest of this module enforces
# precision — by ANCHORING the shape to the FULL string rather than guessing
# at what counts as "content". The trailing object after a lead is bounded to
# a handful of letter-led words, so a listing, a number, a second clause, or
# an explanation simply does not fit inside the pattern: the fullmatch fails
# and the guard stays silent by construction. There is no separate "does this
# carry content" heuristic to keep in sync with the shape.
#
# MUTUAL EXCLUSION with deferral_check is the CALLER's job (chat.py runs this
# only when deferral_check returned None), not this function's: the two
# shapes overlap on a phrase like "Let me look it up" (a registered-tool
# commitment AND a bare-intent lead) or "I'll fetch that page" (this
# function's "fetch" verb AND deferral_check's fetch_url pattern) — first
# claim there belongs to deferral_check, and this function does not need to
# know about it to stay correct in isolation.
#
# Built to the family's two rules: PURE (text + spans; no model, network or
# clock) and PRECISION-first (a wrongly-corrected honest reply is worse than a
# missed one). Explicit exemptions, checked before the shape match:
#
#   * a QUESTION to the user ("Should I check the workspace?") — most
#     questions already fail the shape match on their own (no lead reads as a
#     question); the '?' check is the cheap, explicit backstop.
#   * a HEDGE ("I could check that if you want.") — the bare modals (could/
#     might/may/would) never appear in a flat present-tense commitment. The
#     shared `_OFFER_MARKER` used to exempt a CONSENT-GATED commitment here too
#     ("I'll check that if you want.") — no longer, by owner ruling 2026-09-03
#     (docs/plans/rebuild/no-approvals.md): there is no approval step, so the
#     "if you want" gates nothing and the whole reply is still an intent to act
#     with nothing behind it. An offer that restates an instruction in a
#     longer reply is deferral_check's offer shape, which runs first.
#   * a tool DID run this turn (`ran_a_tool`) — "Checking…" that goes on to
#     narrate a real result is an honest, if terse, report, and the shape
#     match would fail on the narration's content anyway.
#
# `phrase` is the only field: unlike DeferralClaim, a bare intent names no
# specific tool ("Checking…" could be anything), so there is no `tool` /
# `action_phrase` to carry — chat.py's redirect nudge and honest note for this
# claim are fixed sentences, not built from one.

_BARE_INTENT_MAX_WORDS = 15
_BARE_INTENT_MAX_SENTENCES = 2

# The optional one-word lead-in before the actual intent phrase, joined by a
# sentence-ending mark, a comma, an em/en-dash or a hyphen, or plain space —
# "Got it. Checking…", "Sure — running…", "Sure, on it." all count.
_BARE_INTENT_ACK = r"(?:got it|sure|okay|ok|right)(?:\s*[.,!;:—–-])?\s+"
# A short trailing object/complement, bounded so nothing large enough to BE
# content can hide inside it. Object words must be letter-led, so a numeral
# ("12") or anything glued to a colon simply cannot be consumed here — the
# fullmatch below fails on the leftover rather than silently absorbing it.
_BARE_INTENT_OBJECT = r"(?:\s+[A-Za-z][\w'-]*){0,5}"
# A general first-person future commitment to a verb this module does not map
# to a specific registered tool (see the section header for why "search" and
# the fetch_url object shapes are deliberately absent — deferral_check owns
# those).
_BARE_INTENT_FUTURE_MODAL = (
    r"i['’]ll|i\s+will|i['’]m\s+going\s+to|i\s+am\s+going\s+to|i['’]m\s+gonna"
)
# check/fetch/find/pull/list/read/grab/"take a look (at)"/"dig into"/
# investigate/verify/confirm are all low-idiom-risk: a short generic object
# after any of them reads as an action, not a figure of speech, so they share
# the general _BARE_INTENT_OBJECT bound. "look" only joins this set in its
# into/at/up form for the same reason ("look into X", "look at X", "look up
# X" are unambiguous); its BARE form is idiom-prone (see below) and excluded
# here on purpose. "run", bare "look", "get" and "see" are excluded outright
# — each collides hard with a common non-tool English idiom when only a short
# generic object follows ("run out of context", "run late", "run to the
# store", "look forward to it", "look after it", "get back to you", "get over
# it", "see about that", "see you at 5") — precision-first, a bare intent on
# one of these would push the retry nudge on a sentence that promised no tool
# at all (adversarial review of 1f50b993). "see" has no command-shaped use
# worth the idiom surface, so it is dropped outright rather than narrowed;
# run/look/get get their OWN narrow branches below instead of a blanket ban.
_BARE_INTENT_FUTURE_VERB = (
    r"check|look\s+(?:into|at|up)|fetch|find|pull|list|read"
    r"|grab|take\s+a\s+look(?:\s+at)?|dig\s+into|investigate|verify|confirm"
)
# The narrow "command-shaped object" run/look/get are restricted to: a
# placeholder pronoun, "the/a <task noun>", or a recognizable shell command
# token — never a generic word, which is exactly what let an idiom's own
# continuation ("out of", "forward to", "back to", …) read as an object.
_BARE_INTENT_COMMAND_OBJECT = (
    r"that|it|this"
    r"|the\s+(?:command|check|script|scan|query|search|listing|tool|report|results?)"
    r"|a\s+(?:command|check|scan|query|script|quick\s+check)"
    r"|(?:ls|find|df|du|ps|top|grep|netstat|ping|whoami|pwd|uname|git|docker)"
)
_BARE_INTENT_COMMAND_TAIL = r"(?:\s+(?:now|right\s+away|right\s+now|for\s+you))?"
# Each verb's own idiom heads, barred by a negative lookahead the moment they
# follow the bare verb — the exact words the reviewer's false positives used.
_BARE_INTENT_RUN_IDIOM = (
    r"out\s+of|late\b|to\b|into\b|over\b|through\b|by\b|off\b|away\b|down\b|up\b|for\b"
)
_BARE_INTENT_LOOK_IDIOM = r"forward\s+to|after\b|around\b|like\b|down\s+on\b|up\s+to\b"
_BARE_INTENT_GET_IDIOM = (
    r"back\s+to|over\b|along\b|away\b|down\b|through\b|by\b|off\b|up\b"
    r"|around\s+to\b|out\b|to\b"
)
_BARE_INTENT_RUN_BRANCH = (
    rf"run(?!\s+(?:{_BARE_INTENT_RUN_IDIOM}))\s+(?:{_BARE_INTENT_COMMAND_OBJECT})"
    rf"{_BARE_INTENT_COMMAND_TAIL}"
)
_BARE_INTENT_LOOK_BARE_BRANCH = (
    rf"look(?!\s+(?:{_BARE_INTENT_LOOK_IDIOM}))\s+(?:{_BARE_INTENT_COMMAND_OBJECT})"
    rf"{_BARE_INTENT_COMMAND_TAIL}"
)
_BARE_INTENT_GET_BRANCH = (
    rf"get(?!\s+(?:{_BARE_INTENT_GET_IDIOM}))\s+(?:{_BARE_INTENT_COMMAND_OBJECT})"
    rf"{_BARE_INTENT_COMMAND_TAIL}"
)
_BARE_INTENT_LEAD = (
    rf"(?:checking|running|fetching|looking\s+into){_BARE_INTENT_OBJECT}"
    r"|looking\s+that\s+up"
    rf"|let\s+me\s+(?:check|look|see|run|find){_BARE_INTENT_OBJECT}"
    r"|on\s+it(?:,\s*[A-Za-z]+)?"
    r"|i['’]m\s+on\s+it(?:,\s*[A-Za-z]+)?"
    r"|one\s+(?:moment|sec)"
    r"|working\s+on\s+it"
    r"|i['’]ll\s+get\s+right\s+on\s+that"
    rf"|(?:{_BARE_INTENT_FUTURE_MODAL})\s+(?:{_BARE_INTENT_FUTURE_VERB}){_BARE_INTENT_OBJECT}"
    rf"|(?:{_BARE_INTENT_FUTURE_MODAL})\s+(?:{_BARE_INTENT_RUN_BRANCH})"
    rf"|(?:{_BARE_INTENT_FUTURE_MODAL})\s+(?:{_BARE_INTENT_LOOK_BARE_BRANCH})"
    rf"|(?:{_BARE_INTENT_FUTURE_MODAL})\s+(?:{_BARE_INTENT_GET_BRANCH})"
)
# The whole reply, ack optional, lead mandatory, then only trailing
# punctuation/ellipsis — used with fullmatch, so anything past the bounded
# object breaks the match.
_BARE_INTENT_SHAPE = re.compile(rf"(?:{_BARE_INTENT_ACK})?(?:{_BARE_INTENT_LEAD})[.!…]*", re.I)
# A flat present-tense commitment is never a maybe — these modals, plus the
# family's own _OFFER_MARKER, rule out a hedge/offer before the shape match.
_BARE_INTENT_HEDGE = re.compile(r"\b(?:could|might|may|would)\b", re.I)


@dataclass(frozen=True)
class BareIntentClaim:
    """An acknowledgment-only reply — an intent to act and nothing else — with
    no successful tool span of any kind backing it this turn. `phrase` is the
    matched text, for the guard span; see the section header for why there is
    no `tool`/`action_phrase` the way DeferralClaim carries one."""

    phrase: str


def bare_intent_check(reply_text: str, spans: Sequence[Any]) -> BareIntentClaim | None:
    """A reply that is ONLY an acknowledgment-and-intent, or None.

    Returns a BareIntentClaim when the entire whitespace-normalized reply is a
    bare intent-to-act phrase (see the section header for the exact shapes)
    and no successful tool span ran this turn; None otherwise — a reply that
    also carries real content, a question, a hedge/offer, or a reply backed by
    a real tool call of any kind. Pure and precision-first. Unlike
    deferral_check this names no specific tool: ANY successful span this turn
    clears it, because a bare "Checking…" makes no claim about WHICH tool
    would satisfy it.
    """
    if not reply_text or not reply_text.strip():
        return None
    # Collapse every run of whitespace — including a bare newline, which
    # _sentences() below treats as its own sentence boundary regardless of
    # terminal punctuation — to one space, BEFORE any length/shape check
    # runs. Without this, "Got it.\nChecking the workspace…" (the same reply
    # as the pinned trace, just line-broken) counts three "sentences" and
    # trips the cap for no reason a reader would recognize.
    normalized = " ".join(reply_text.split())
    if not normalized:
        return None
    if len(normalized.split()) > _BARE_INTENT_MAX_WORDS:
        return None  # too long to be an ack-and-go — there is room for content
    if len(_sentences(normalized)) > _BARE_INTENT_MAX_SENTENCES:
        return None
    if "?" in normalized:
        return None  # a question to the user asserts no commitment
    if _BARE_INTENT_HEDGE.search(normalized):
        return None  # "could check" — a hedge, not a promise
    if ran_a_tool(spans):
        return None  # real work happened this turn — an honest terse report
    if _BARE_INTENT_SHAPE.fullmatch(normalized) is None:
        return None
    return BareIntentClaim(phrase=normalized[:80])


# -- the presented-listing guard -------------------------------------------
#
# The seventh sibling, for the shape measured on the agent_quality corpus
# (2026-09-03, qwen3.8:27b, case bare-intent-no-action): asked to list the
# workspace, the model made ZERO tool calls and answered with a plausible file
# listing — tree-drawn, WITH FILE SIZES — recited out of a memory recall of an
# earlier listing. Nothing else in this module sees it: it is not a completed-
# action claim with a file target (narration needs "I created X.md"), not a
# pending state, not a capability denial, not a promise, not a bare ack, and a
# file listing is not a paired device. A reply is a claim; the trace is the
# fact — and a listing is the most convincing claim of all, because it LOOKS
# like tool output.
#
# presented_listing_check(reply_text, spans, listing_tools, user_message) fires
# ONLY when the reply PRESENTS a directory/file listing — at least
# _LISTING_MIN_ENTRIES consecutive lines that each look like a listing ENTRY —
# AND no listing-producing call ran this turn. "A listing-producing call ran"
# is DERIVED two ways, never from a tool-name list kept here:
#
#   * DECLARED: a successful span of a tool whose registry entry declares
#     `result_kind == "listing"` (app/tools/base.py). The caller passes the
#     names it derives from the live registry (tools.tool_names_by_result_kind),
#     so a NEW listing tool self-registers by setting that one field, and the
#     guard never has to be told about it.
#   * SHAPED: a successful span whose recorded result head is ITSELF a listing —
#     the same entry detector, applied to the tool's output. A device_run of
#     ls/find/tree produces a listing whatever its declaration says, and the
#     verdict follows the OUTPUT rather than a belief about which commands list.
#     The result side is read more LOOSELY than the reply side (a bare `ls`
#     prints bare names, one per line) because a miss there is a false
#     correction, and a false correction makes the guard the liar — but a bare-
#     name run still needs ONE line that could only be a listing (a slash, a
#     size, a tree lead, a mode string) or a shell run's own `ran […] — exit`
#     preamble, so three nav-menu words in a fetched page back nothing.
#
#   A result that merely CONTAINS the presented names is deliberately NOT a
#   backing (adversarial review, 2026-09-03): a memory_search recalls an old
#   listing flattened onto one line, and "every name appears in a result" would
#   have laundered the measured defect through a tool call. She can name notes
#   in prose; a tree of note titles fires.
#
# Built to the family's two rules: PURE (text + spans + the names; no model,
# network or clock) and PRECISION-first — this guard REPLACES the reply it
# corrects, so every false positive costs her prose. The precision cuts:
#
#   * An ENTRY line is structural, never prose: an optional tree/bullet lead, ONE
#     whitespace-free name token, and a trailing size — and nothing else. On the
#     reply side a line counts ONLY with a tree lead, a size, a mode string, or
#     a table cell under a column headed Size. A bulleted or bare dotted/slashed
#     name is NEVER enough: hostnames ("- nova.tailba0abb.ts.net"), python
#     modules ("- app.chat"), file types ("- .png") and the everyday planned
#     skeleton ("I would create:\n- src/\n- tests/\n- README.md") all look
#     exactly like a bare path list, and none is a listing of anything.
#   * A SIZE must be set off from the name — a spaced dash, two spaces, a tab, or
#     parentheses — and its unit is case-sensitive. A single space is not a
#     separator ("- L1 32 KB", "- DIMM0 16 GB", "- nova-backend 512 MB" are
#     caches, memory and containers) and ":" is not one either ("qwen3.6:27b" is
#     an ollama tag with a parameter count, not 27 bytes).
#   * A TREE with no sizes is `tree`'s own output shape — but also a JSON-key
#     tree, a tree of API routes, or a proposed layout. It counts only when at
#     least one entry is path-like (a slash or a letter-led extension), a
#     leading-slash name without a size ("├── /api/v1/chat") is not an entry,
#     and none of the few lines introducing the run (a fence or a root line
#     may sit between) proposes or plans ("Proposed layout:", "A typical
#     FastAPI layout:", "I would create:") — a plan is not a claim about what
#     is there.
#   * The entries must be CONTIGUOUS (blank lines and code-fence markers do not
#     break a run): three paths scattered through a paragraph are prose.
#   * Markdown wrapping (`name`, **name**) is stripped before the name is read,
#     so the common renderings are seen as what they name.
#   * A URL is never an entry — a list of links is not a file listing.
#   * The USER'S OWN text is exempt: an entry whose name (or basename) is a whole
#     token of the user's message was pasted by them, and echoing, re-rendering
#     or annotating it is honest. CARRY: this reads `user_message` only — if
#     attachment filenames ever reach the model outside the message text (v4
#     has no attachments yet), the exemption cannot see them and the caller
#     must fold them into what it passes here.
#
# PRIOR-TURN listings. A listing a tool returned in an EARLIER turn and the
# model re-presents now is stale, not invented — and this guard still fires on
# it, deliberately, for the same reason state_claim_check fires on "the device
# is still offline" parroted out of history: backing is THIS turn's spans, and
# a listing shown as current that nothing produced this turn is exactly the
# defect. The honest regeneration is cheap (the list tool is a read) and the
# honest no-tool answer is available without reproducing the block ("I have not
# listed it this turn; earlier it had config.json, README.md and notes.md").
#
# A LISTING AFTER SOME OTHER TOOL RAN is chat.py's call, not this function's: it
# still returns a claim (nothing recognisable listed), but a tool that DID run
# may have produced a listing this detector cannot read in a 500-char head (a
# `find` whose head is permission-denied noise), so chat.py APPENDS an
# "unverified" note there instead of replacing an honest listing.

# The stated correction. MECHANISM-NEUTRAL and honest: it says only what is
# mechanically true (nothing listed those files this turn), never what the
# real listing is — the guard has not looked either.
PRESENTED_LISTING_CORRECTION = (
    "Correction: I did not actually list those files this turn — that listing "
    "is not a record of their current state."
)

_LISTING_MIN_ENTRIES = 3

# A code-fence marker: neither an entry nor a break in a run of them.
_FENCE_LINE = re.compile(r"^\s*(?:```|~~~)")
# Tree-drawing leads ("├── ", "│   └── ", ASCII "|-- ", "`-- ", "+-- ").
_TREE_LEAD = re.compile(r"^[\s│|]*(?:├|└|\|--|`--|\+--)[─-]*\s*")
# A bullet or a numbered-list marker.
_BULLET_LEAD = re.compile(r"^(?:[-*•+]|\d{1,3}[.)])\s+")
# A size: "12.4 KB", "905.6 GiB", "1,234 bytes", "1.2K", "48 B". Case-SENSITIVE
# on purpose (no re.I anywhere below): "27b" is a parameter count, not bytes.
_SIZE = r"\d[\d,]*(?:\.\d+)?\s?(?:[Bb]ytes?|[KMGTP]i?B|[KMGTP]|B)"
# A size trailing the name and SET OFF from it: a spaced dash, two spaces, a
# tab, or parentheses. A single space or a colon is not a separator.
_TRAILING_SIZE = re.compile(
    r"(?:\s+[—–-]\s+|\s{2,}|\t+)\s*" + _SIZE + r"\s*$" + r"|\s*\(" + _SIZE + r"\)\s*$"
)
# Under a TREE lead a single space will do ("├── backups/ 905.6 GiB"): the
# tree markup is the listing's own idiom, and there is no cache/DIMM/container
# line that draws itself as a tree.
_TRAILING_SIZE_TREE = re.compile(r"\s+" + _SIZE + r"\s*$")
_SIZE_ONLY = re.compile("^" + _SIZE + "$")
# An `ls -l` line: a mode string then at least four more fields.
_PERMS_LINE = re.compile(r"^[-dlbcps][rwxsStT-]{9}[+@.]?\s+\S+(?:\s+\S+){3,}$")
_URLISH = re.compile(r"://|^www\.", re.I)
# ONE whitespace-free token, free of quote/bracket punctuation (a JSON or YAML
# line is never a name).
_NAME_TOKEN = re.compile(r"^[^\s\"'`<>|;:,{}\[\]()]+$")
# Path-like: carries a slash, or ends in a LETTER-led short extension (so a
# version "v1.2" or an archive "a.7z" is not a file, by choice).
_PATHLIKE = re.compile(r"/|\.[A-Za-z][A-Za-z0-9]{0,5}$")
# The loose (result-side) extras: a bare name, and size-first ("12K src").
_BARE_NAME = re.compile(r"^[\w.@+~-]+/?$")
_SIZE_FIRST = re.compile("^" + _SIZE + r"\s+(\S+)$")
# A shell run's own preamble (app/tools/devices.py device_run: "<name> ran
# [argv] — exit N"): the one context in which a run of bare names in a result
# is known to be a program's output rather than a page's words.
_RUN_PREAMBLE = re.compile(r"\bran \[[^\n]*\] — exit -?\d+")
# A table column headed Size arms the rows beneath it.
_TABLE_SIZE_HEADER = re.compile(r"\bsize\b", re.I)
_TABLE_SEPARATOR_CELL = re.compile(r"^:?-+:?$")
# A line that INTRODUCES a plan, proposal or future action rather than a report:
# a tree with no sizes beneath one of these is a layout, not a listing.
_PLAN_MARKER = re.compile(
    r"\b(?:would|could|might|should|suggest(?:ed|ion)?|propos(?:e|ed|al|ing)"
    r"|recommend(?:ed|ation)?|plan(?:ned|ning)?|example|e\.g\.|template|layout"
    r"|scaffold(?:ing)?|skeleton|boilerplate|starter"
    r"|typical(?:ly)?|usually|i['’]ll|i['’]d|i\s+will|going\s+to|let['’]s"
    r"|we\s+can|i\s+can)\b",
    re.I,
)
# How many introducing lines before a run are read for a plan marker: a code
# fence and a root line ("myapp/", ".") commonly sit between "Proposed layout:"
# and the first tree entry, and neither is the introduction.
_INTRO_LOOKBACK = 3
# A tree's ROOT line — a bare "dir/" or "." with no lead — belongs to the tree,
# not to its introduction; it is skipped like a blank line.
_ROOT_LINE = re.compile(r"^(?:[\w.@+~-]+/|\.{1,2})$")
_USER_TOKEN = re.compile(r"[\w.@+~/-]+")


class _Entry(NamedTuple):
    line: str
    name: str
    sized: bool  # a size or a mode string: a record of state, never a plan
    strong: bool  # tree lead, size, mode string, or a slash: never a bare word


def _unwrap(token: str) -> str:
    """Strip markdown code/emphasis wrapping (`x`, **x**, *x*, _x_) so the name
    is read as what it names. Underscores are stripped only when they wrap a
    name that does not itself start or end with one — __init__.py keeps its."""
    s = token.strip()
    for wrap in ("`", "**", "*"):
        while len(s) > 2 * len(wrap) and s.startswith(wrap) and s.endswith(wrap):
            s = s[len(wrap) : -len(wrap)].strip()
    if len(s) > 2 and s[0] == "_" and s[-1] == "_" and s[1] != "_" and s[-2] != "_":
        s = s[1:-1]
    return s


def _table_cells(line: str) -> list[str] | None:
    """The cells of a markdown table row, or None if the line is not one."""
    if "|" not in line:
        return None
    cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
    if not (2 <= len(cells) <= 4):
        return None
    return cells


def _is_name(name: str) -> bool:
    return (
        bool(name)
        and name not in (".", "..")
        and _URLISH.search(name) is None
        and _NAME_TOKEN.match(name) is not None
    )


def _listing_entry(line: str, *, strict: bool, size_col: int | None) -> _Entry | None:
    """This line as a listing entry, or None.

    `strict` is the reply side (precision-first: a tree lead, a size, a mode
    string, or a Size-column cell — never a bare or merely path-like word);
    loose is the result side, where a bare name and a size-first field also
    count, because a miss there is a false correction. `size_col` is the
    Size-headed table column in force, if any.
    """
    s = line.strip()
    if not s or _FENCE_LINE.match(s):
        return None
    if _PERMS_LINE.match(s):
        return _Entry(s, _unwrap(s.split()[-1]), True, True)
    cells = _table_cells(s)
    if cells is not None:
        if size_col is None or size_col >= len(cells) or size_col == 0:
            return None
        name = _unwrap(cells[0])
        # A table needs a path-like name as well as a Size column: "| L1 | 32
        # KB |" under a Size header is a cache table, not a directory.
        if _is_name(name) and _PATHLIKE.search(name) and _SIZE_ONLY.match(cells[size_col]):
            return _Entry(s, name, True, True)
        return None
    tree = False
    lead = _TREE_LEAD.match(s)
    if lead is not None:
        s = s[lead.end() :]
        tree = True
    else:
        lead = _BULLET_LEAD.match(s)
        if lead is not None:
            s = s[lead.end() :]
    sized = False
    tail = _TRAILING_SIZE.search(s) or (_TRAILING_SIZE_TREE.search(s) if tree else None)
    if tail is not None:
        s = s[: tail.start()].rstrip()
        sized = True
    if not strict and not sized:
        first = _SIZE_FIRST.match(s)
        if first is not None:
            s = first.group(1)
            sized = True
    name = _unwrap(s)
    if not _is_name(name):
        return None
    if strict and tree and not sized and name.startswith("/"):
        # "├── /api/v1/chat": a leading-slash name with no size under a tree is
        # a route as often as a path. A sized one ("/dev/sda1 — 905.6 GiB") and
        # the loose side (`find /` prints leading slashes) still count.
        return None
    if tree or sized:
        return _Entry(line.strip(), name, sized, True)
    if strict:
        return None  # a bare or path-like word under a bullet is prose
    if _PATHLIKE.search(name) or _BARE_NAME.match(name):
        # Loose: a path ("./src", "src/app.py") or a bare name. Only a SLASH
        # makes it strong — an extension alone is a requirements pin's shape.
        return _Entry(line.strip(), name, False, "/" in name)
    return None


def _listing_lines(text: str, *, strict: bool) -> tuple[list[_Entry], tuple[str, ...]]:
    """The longest CONTIGUOUS run of listing entries in `text`, with the lines
    that introduced it (the last _INTRO_LOOKBACK non-entry lines before the
    run). Blank lines, fence markers, table separator rows and a tree's root
    line neither count nor break a run; any other line does. Returns ([], ())
    below the minimum."""
    best: list[_Entry] = []
    best_prev: tuple[str, ...] = ()
    run: list[_Entry] = []
    run_prev: tuple[str, ...] = ()
    prev: list[str] = []
    size_col: int | None = None
    for raw in text.splitlines():
        stripped = raw.strip()
        if not stripped or _FENCE_LINE.match(stripped):
            continue
        if strict and _ROOT_LINE.match(stripped):
            continue  # the reply's tree root; on the result side `ls -p` prints dir/ entries
        cells = _table_cells(stripped)
        if cells is None:
            size_col = None
        elif all(_TABLE_SEPARATOR_CELL.match(cell) for cell in cells):
            continue  # "|---|---|" between a header and its rows
        elif not any(_SIZE_ONLY.match(cell) for cell in cells):
            # A header row. One naming a Size column arms the rows beneath it;
            # any other disarms them. Never itself an entry.
            size_col = next(
                (i for i, cell in enumerate(cells) if _TABLE_SIZE_HEADER.search(cell)), None
            )
        entry = _listing_entry(raw, strict=strict, size_col=size_col)
        if entry is None:
            if len(run) > len(best):
                best, best_prev = run, run_prev
            run = []
            prev = (prev + [stripped])[-_INTRO_LOOKBACK:]
            continue
        if not run:
            run_prev = tuple(prev)
        run.append(entry)
    if len(run) > len(best):
        best, best_prev = run, run_prev
    if len(best) < _LISTING_MIN_ENTRIES:
        return [], ()
    return best, best_prev


def _presented(text: str, *, strict: bool) -> list[_Entry]:
    """The listing `text` presents, as entries, or [] — with the run-level
    cuts applied: on the reply side a tree with no sizes must carry a path-like
    name and must not be introduced as a plan; on the result side a bare-name
    run must carry one line that could only be a listing, or a shell run's
    preamble."""
    entries, intro = _listing_lines(text, strict=strict)
    if not entries:
        return []
    if strict:
        if not any(e.sized for e in entries):
            if not any(_PATHLIKE.search(e.name) for e in entries):
                return []  # a tree of bare words: JSON keys, headings, a plan
            if any(_PLAN_MARKER.search(line) for line in intro):
                return []  # "Proposed layout:" / "I would create:" — a plan
        return entries
    if not any(e.strong for e in entries) and _RUN_PREAMBLE.search(text) is None:
        return []  # three bare words in a page or a requirements file
    return entries


def is_listing(text: str, *, strict: bool = True) -> bool:
    """Does `text` present a directory/file listing? Pure; the same detector
    the guard applies to a reply (strict) and to a tool result (loose)."""
    return bool(text) and bool(_presented(text, strict=strict))


def _listing_ran(spans: Sequence[Any], listing_tools: Sequence[str]) -> bool:
    """Did a listing-producing call succeed this turn? DECLARED (the tool's
    registry entry says its result is a listing) or SHAPED (its recorded
    result head is one) — see the section header."""
    declared = frozenset(listing_tools)
    for span in _successful(spans):
        if span.name in declared:
            return True
        head = (getattr(span, "meta", None) or {}).get("result_head")
        if isinstance(head, str) and is_listing(head, strict=False):
            return True
    return False


def _user_names(user_message: str) -> frozenset[str]:
    """Every whole token of the user's message that could name a file, plus
    each token's basename — the set a presented name is exempt against."""
    names: set[str] = set()
    for token in _USER_TOKEN.findall(user_message or ""):
        token = token.rstrip(".,").rstrip("/")
        if not token:
            continue
        names.add(token)
        names.add(token.rsplit("/", 1)[-1])
    return frozenset(names)


def _pasted(name: str, theirs: frozenset[str]) -> bool:
    """True if the user's own message carries this name as a whole token (or
    its basename) — a substring is not enough: 'cab' names neither a nor b."""
    norm = name.rstrip("/")
    return bool(norm) and (norm in theirs or norm.rsplit("/", 1)[-1] in theirs)


@dataclass(frozen=True)
class PresentedListingClaim:
    """A directory/file listing the reply presents that no listing-producing
    call backs this turn. `entries` is how many entry lines were presented
    (after the user's own pasted names are exempted), `phrase` the first one,
    for the guard span; `text` the stated correction, the same shape the other
    claims carry so the turn's composition reads it identically."""

    entries: int
    phrase: str
    text: str = PRESENTED_LISTING_CORRECTION


def presented_listing_check(
    reply_text: str,
    spans: Sequence[Any],
    listing_tools: Sequence[str],
    user_message: str = "",
) -> PresentedListingClaim | None:
    """Contradict a presented file listing that nothing produced this turn.

    Returns a PresentedListingClaim when the reply presents a listing (three or
    more contiguous entry lines) and no listing-producing call ran this turn —
    not a declared listing tool, and not a call whose recorded result is
    listing-shaped; None otherwise — prose that merely names files, a bulleted
    path list, one or two entries, a list of steps or links, a plan, a listing
    the user pasted, or a listing a real call backs. Pure and precision-first
    (see the section header). Derived from `listing_tools` and the spans' own
    recorded results, never a tool-name list kept here. `user_message` is the
    only text the paste exemption reads: attachment names that reach the model
    another way (none do in v4 yet) must be folded into it by the caller.
    """
    if not reply_text or not reply_text.strip():
        return None
    presented = _presented(reply_text, strict=True)
    if not presented:
        return None
    theirs = _user_names(user_message)
    own = [entry for entry in presented if not _pasted(entry.name, theirs)]
    if len(own) < _LISTING_MIN_ENTRIES:
        return None  # the user pasted it; echoing or annotating it is honest
    if _listing_ran(spans, listing_tools):
        return None
    return PresentedListingClaim(entries=len(own), phrase=own[0].line[:80])


# -- the delegation-claim guard (S12) ---------------------------------------
#
# The eighth sibling, for the hole every guard above shares: they read
# FIRST-PERSON claims. narration_check walks back from a verb to "I" (an active
# claim needs Nova as its subject, _first_person_subject) and drops anything
# else as attributed to someone else — so "coder wrote hello.py", "reviewer
# found three bugs", "the tests were run by coder" are invisible to it. S12
# hands her exactly that vocabulary: a roster of named agents she delegates to
# through delegate_to_agent. A model that narrates an agent's work it never
# delegated, or whose run errored out, is fabricating by proxy — the same lie
# as the kv_offloading one with the pronoun changed.
#
# delegation_claim_check(reply_text, spans, agent_names, self_name=None) fires
# when a non-question clause credits a NAMED agent with a COMPLETED action and
# no successful delegate_to_agent span for that agent ran this turn. All three
# inputs are mechanical and DERIVED, never kept here:
#
#   * `agent_names` is the LIVE roster the caller reads (agents.names(pool),
#     minus the agents this conversation has already shown to be real). With
#     no agents there is no such claim to make, so an empty roster returns
#     None by construction (fail-open), and creating an agent arms the guard
#     for its name by itself.
#   * Backing is read off the spans, in three verdicts. A delegate_to_agent
#     span names the agent it ran in meta.facts[].agent (the executor's facts
#     sink, written on success AND failure) and in args_redacted.agent (the
#     call's own argument); either counts for a success.
#       "ok"     — a span for that agent has meta.ok True: the run finished,
#                  and the tool result already states what it did (derived
#                  from the child's spans), so this guard does not second-
#                  guess it.
#       "failed" — a span for that agent is NOT ok AND its meta.facts holds an
#                  entry for that agent carrying an `agent_turn_id`: a child
#                  turn really ran and ended in an error -> "did not finish".
#       "none"   — everything else, INCLUDING a call refused before any run.
#                  agents.delegate files {"agent", "status": "refused",
#                  "reason"} on the facts sink before it raises (unknown
#                  agent, empty task; tools/agents.py files the same shape for
#                  "an agent cannot delegate"), so the trace says a delegation
#                  was REFUSED, never that one ran — and that entry carries no
#                  agent_turn_id, which is exactly what separates a refusal
#                  from a failure. Saying "{agent} did not finish" of a task
#                  no agent ever received would itself be a fabrication
#                  (2026-09-08). The refused_* flag chat._refuse_call writes
#                  (markup, out of rounds) reads the same way, as in the
#                  deferral guard's _attempted.
#     A span whose agent cannot be read (no facts, a flooded argument record)
#     counts for every name — leniency runs toward not correcting, as in
#     _target_of.
#   * `self_name` is the agent whose OWN turn this is (None on Nova's turn),
#     and it names the one claim no delegate span can ever judge: an agent
#     writing about ITSELF in the third person ("coder wrote hello.py" on
#     coder's turn). An agent cannot delegate — tools/agents.py refuses — so
#     no delegation will ever back that sentence, and reading it as one would
#     append a correction that is nonsense on its face ("I did not hand
#     anything to coder"). It is a NARRATION claim wearing a name, so it takes
#     narration's rule: ANY successful tool span this turn backs it, nothing
#     else does, and unbacked it earns DELEGATION_SELF_CORRECTION, which
#     speaks in the first person because the agent IS the speaker. On an
#     agent's turn a claim about ANOTHER agent is still a delegation claim,
#     but its correction is DELEGATION_UNBACKED_CORRECTION_AGENT: Nova's text
#     ends "Tell me again and I'll delegate it", and an agent promising that
#     would be promising a call the tool refuses, so it names the path that
#     does exist — ask Nova.
#
# Built to the family's two rules: PURE (text + spans + the names; no model,
# network or clock) and PRECISION-first (a wrongly-corrected honest reply makes
# the guard the liar — worse than a missed one, and this correction names an
# agent). The claim shapes and the cuts that keep honest sentences clean:
#
#   * ACTIVE: the agent's NAME as a whole token (case-insensitive; "reviewers"
#     never matches "reviewer", nor does the possessive "coder's"), followed
#     within three tokens by a completed-action verb — the narration verb set
#     plus the verbs a delegation report uses (finished, completed, found,
#     searched, fetched, ran, built, fixed, tested, delivered, reported) — in
#     the simple past or the perfect ("coder has written"). A modal or
#     infinitive marker in between ("coder will write", "coder can write",
#     "asked coder to read it"), a negation ("coder did not write", "coder
#     never wrote"), or a passive auxiliary ("coder was created", "coder has
#     been updated" — the agent is the PATIENT there, something Nova did TO it
#     with the agent tools) means no completed action is credited to it. The
#     window stops at a conjunction, a comma or stop punctuation, so a
#     coordinated verb with a different subject ("I asked coder and wrote it
#     myself") is never read as coder's. A progressive ("coder is working on
#     it"), a future ("I'll ask coder to write it") and a base-form infinitive
#     ("coder to review") never reach a listed verb form at all. An INDEFINITE
#     determiner before the name ("a researcher found that…") makes it a
#     common noun, not the agent. "coder wrote nothing" IS a claim: it credits
#     a run that happened.
#   * PASSIVE: a past participle followed within three tokens by "by <name>"
#     ("was written by coder", "the tests were run by coder"), with no modal,
#     negation or "being" in the three tokens before the participle ("will be
#     reviewed by coder", "was not written by coder", "is being reviewed by
#     coder" credit nothing completed).
#   * A QUESTION ("should I ask coder to review it?") asserts nothing — the
#     shared _clauses machinery. A PRIOR-TIME marker ("coder wrote it
#     yesterday") or a REPORTED frame ("the log says coder wrote it", "you
#     mentioned coder fixed it", "according to the trace, coder ran") in the
#     clause, or a name inside an open double quote (a line she is relaying),
#     places the action outside this turn and is exempt — the same _PRIOR_TIME
#     and _REPORTED the other guards read. narration_check's
#     _externally_attributed is deliberately NOT reused: its "by <not me>"
#     clause would exempt the very passive shape this guard exists to read.
#   * A HEDGE or a SUBORDINATE frame asserts no completion: a conditional or
#     temporal lead before the name ("if coder finished, the file would be
#     there", "once coder has finished I'll relay it", "I don't know whether
#     coder wrote it"), an uncertainty lead ("I'm not sure coder finished",
#     "I can't confirm hello.py was written by coder", "I think coder
#     finished"), or a hedging adverb between name and verb ("coder probably
#     wrote it"). The lead is read from the text before the name back to the
#     last comma, so a fronted aside does not shelter the main clause ("As
#     requested, coder wrote hello.py" and "If you're wondering, coder
#     finished the task" still fire). Accepted KNOWN MISSES on this cut,
#     precision-first: a past temporal clause ("after coder finished, I read
#     it") and a hedged fabrication ("I think coder finished") stay clean —
#     the confident form is what a fabricating model writes, and a hedged
#     honest sentence wrongly corrected is the worse failure.
#   * An HONEST FAILURE REPORT is not a claim of completion: when the only
#     delegate span for the agent FAILED and the reply anywhere acknowledges a
#     failure ("coder ran but hit an error", "coder finished with status
#     error"), it is relaying the failure the tool result stated, and
#     appending "coder did not finish" would contradict a true report. With NO
#     span at all the same sentence is still a fabrication (nothing ran) and
#     is flagged.
#
# Accepted KNOWN MISSES, restated after the 2026-09-08 cuts, all
# precision-first: (1) a hedged or past-temporal fabrication stays clean (the
# cut above); (2) a SELF-claim is judged at narration's KIND-blind level — an
# agent that really ran workspace_read_file and then writes "coder wrote
# hello.py" is not corrected here, because any successful tool span backs a
# self-claim (narration_check reads the first-person forms with its
# target-aware rule; the third-person form has no target to check against a
# roster name); (3) a failed run whose facts record lost its agent_turn_id (a
# clipped or flooded meta) reads as "none" rather than "failed", so the
# operator is told nothing was delegated when something was — the milder of
# the two wrong sentences, and the only one that cannot promise a run that
# never happened.
#
# APPEND-class like narration: the correction is added after the reply, never
# replacing it — the operator sees what she claimed and the contradiction
# beside it. Four corrections, each saying only what is mechanically true:
# nothing was delegated (Nova's turn, and the agent-turn variant that points
# at Nova instead of promising a delegation an agent cannot make), the run
# ended in an error (ok False with a child turn behind it), or — for the
# speaker's own name — no tool ran at all. The agent's canonical roster name
# is used, never the reply's casing. All four are clean under this guard
# (pinned in test_guards.py). Wiring (the guard span `delegation_claim`
# {agent, phrase, backing}, the correction frame, the turn plumbing) is
# chat.py's, alongside narration.

DELEGATE_TOOL_NAME = "delegate_to_agent"

DELEGATION_UNBACKED_CORRECTION = (
    "Correction: I did not hand anything to {agent} this turn — no delegation ran, "
    "so nothing it 'did' happened. Tell me again and I'll delegate it."
)
DELEGATION_FAILED_CORRECTION = (
    "Correction: {agent} did not finish that task (its run ended in an error), "
    "so I cannot report it as done."
)
# On an AGENT's own turn the same fabrication needs different words in both
# directions (2026-09-08). About ITSELF the speaker IS the agent, so the
# correction is first-person and says what narration says: no tool ran. About
# ANOTHER agent, Nova's closing "Tell me again and I'll delegate it" would be a
# promise tools/agents.py refuses — an agent cannot delegate — so this one
# names the path that actually exists instead of offering one that does not.
DELEGATION_SELF_CORRECTION = (
    "Correction: I did not do that this turn — no tool ran, so nothing I 'did' happened."
)
DELEGATION_UNBACKED_CORRECTION_AGENT = (
    "Correction: I did not hand anything to {agent} this turn — no delegation ran, "
    "so nothing it 'did' happened. Ask Nova to delegate it."
)

# Completed-action verbs an agent can be credited with: narration's own set
# (created/wrote/written/saved/updated/appended/added/read/checked/reviewed/
# opened/examined) plus what a delegation report says. Past or perfect forms
# only — a base form ("write", "finish") is a future/infinitive and is absent.
_DELEGATION_VERBS = _ACTION_VERB_TOKENS | frozenset(
    {
        "finished",
        "completed",
        "found",
        "searched",
        "fetched",
        "ran",
        "built",
        "fixed",
        "tested",
        "delivered",
        "reported",
    }
)
# The participles that form the passive "<participle> by <name>". "wrote"/"ran"
# are simple past only; "run" is the participle of "ran" ("the tests were run
# by coder") and is the one form here with no active counterpart above.
_DELEGATION_PARTICIPLES = (_DELEGATION_VERBS - frozenset({"wrote", "ran"})) | frozenset({"run"})
# The verb must sit at one of the next three token positions after the name
# ("coder has already written" fits; "coder has just now written" does not).
_DELEGATION_WINDOW = 3
# Between the name and its verb, any of these means the action is not a
# completed one credited to the agent: a modal/infinitive marker (the shared
# _MODAL_AUX, "to" included), a negation (the shared _NEGATORS), or a passive
# auxiliary that makes the agent the patient ("coder was created").
_PASSIVE_AUX = frozenset({"is", "are", "was", "were", "be", "been", "being", "get", "gets", "got"})
# A hedging adverb between the name and its verb ("coder probably wrote it")
# is a guess, not a report.
_HEDGE_TOKENS = frozenset(
    {
        "probably",
        "likely",
        "maybe",
        "perhaps",
        "possibly",
        "presumably",
        "apparently",
        "supposedly",
        "seemingly",
        "hopefully",
    }
)
_ACTIVE_BLOCKERS = _MODAL_AUX | _NEGATORS | _PASSIVE_AUX | _HEDGE_TOKENS
# A conditional/temporal subordinator or an uncertainty lead in the text
# before the name (back to the last comma) — the clause supposes or doubts
# the action rather than reporting it.
_DELEGATION_HEDGE = re.compile(
    r"\b(?:if|whether|unless|once|when(?:ever)?|until|while|after|before"
    r"|assuming|suppos(?:e|ing)|provided"
    r"|not\s+sure|unsure|uncertain|not\s+certain|unclear|doubt|no\s+idea"
    r"|(?:can(?:no|['’])t|cannot|couldn['’]t|don['’]t|do\s+not|didn['’]t|did\s+not"
    r"|won['’]t|will\s+not|haven['’]t|have\s+not)\s+(?:yet\s+)?"
    r"(?:confirm|verify|tell|know|say|check|see)"
    r"|i\s+(?:think|believe|assume|guess|expect|suspect|hope|imagine)"
    r"|probably|likely|maybe|perhaps|possibly|presumably|apparently|supposedly"
    r"|seemingly|hopefully)\b",
    re.I,
)
# Before a passive participle the auxiliaries are what FORM the passive, so
# only a modal, a negation or the progressive "being" block it.
_PASSIVE_BLOCKERS = _MODAL_AUX | _NEGATORS | frozenset({"being"})
# An indefinite determiner/quantifier before the name reads it as a common noun
# ("a reviewer found…", "every coder knows…"), never as the named agent.
_INDEFINITE = frozenset(
    {
        "a",
        "an",
        "one",
        "some",
        "any",
        "every",
        "each",
        "another",
        "many",
        "several",
        "few",
        "most",
        "all",
        "no",
        "two",
        "three",
        "four",
        "five",
    }
)
# "by the coder" / "by agent coder" still name the agent.
_BY_NAME_SKIP = frozenset({"the", "agent"})
_ACCORDING_TO = re.compile(r"\baccording\s+to\b", re.I)
# What an honest failure report says, anywhere in the reply: with a FAILED
# delegate span behind it, a clause crediting the agent is relaying the error
# the tool result stated, not claiming completion.
_FAILURE_ACK = re.compile(
    r"\b(?:errors?|errored|fails?|failed|failures?|failing|crash(?:ed|es)?"
    r"|couldn['’]t|could\s+not|didn['’]t|did\s+not|wasn['’]t\s+able|unable"
    r"|incomplete|unfinished|interrupted|timed\s+out|timeouts?|aborted|gave\s+up"
    r"|broke|exceptions?|traceback|stopped|halted|ran\s+into|hit\s+an?"
    r"|problems?|issues?|trouble)\b",
    re.I,
)


@dataclass(frozen=True)
class DelegationClaim:
    """A completed action credited to a named agent that no successful
    delegate_to_agent span backs this turn.

    `agent` is the canonical roster name, `phrase` the matched text for the
    guard span, `backing` how the claim fails — "none" (no delegation ran for
    that agent; on the SPEAKER's own name, no tool ran at all) or "failed" (a
    run really started and ended in an error) — and `text` the stated
    correction, the same field the other claims carry so the turn's
    composition reads it identically (APPEND-class, like narration)."""

    agent: str
    phrase: str
    backing: str
    text: str


def delegation_correction_text(
    agent: str, backing: str, *, self: bool = False, on_agent_turn: bool = False
) -> str:
    """The stated correction for one unbacked delegation claim.

    `backing` is "none" or "failed" — anything else is a programming error, not
    a verdict, so it raises rather than picking a sentence that might not be
    true. `self` says the claim is the speaking AGENT talking about ITSELF (no
    delegation was ever involved, so the correction is narration's, in the
    first person); `on_agent_turn` says an agent is speaking about ANOTHER
    agent, where Nova's offer to delegate would be a promise the tool refuses.
    """
    if backing == "none":
        if self:
            return DELEGATION_SELF_CORRECTION
        if on_agent_turn:
            return DELEGATION_UNBACKED_CORRECTION_AGENT.format(agent=agent)
        return DELEGATION_UNBACKED_CORRECTION.format(agent=agent)
    if backing == "failed":
        if self:
            # A self-claim's backing is binary — some tool ran this turn or
            # none did — so "failed" is unreachable here, and printing "did not
            # finish" would describe a delegation that never existed. Refuse
            # rather than pick a sentence that is not true.
            raise ValueError("a self delegation claim can only have backing 'none'")
        return DELEGATION_FAILED_CORRECTION.format(agent=agent)
    raise ValueError(f"delegation backing must be 'none' or 'failed', not {backing!r}")


def _bare_token(token: str) -> str:
    """Lower-cased, with the sentence punctuation the tokenizer glues onto a
    word ("coder.", "wrote.") stripped, so a name or verb at a clause end
    still compares whole-word."""
    return token.rstrip(_TRAILING_PUNCT).lower()


def _blocks(low: str, blockers: frozenset[str]) -> bool:
    return low in blockers or low.endswith(("n't", "n’t"))


def _hedged_before(clause: str, start: int) -> bool:
    """True when the text before position `start`, back to the last comma,
    carries a subordinator or an uncertainty lead — the clause supposes,
    doubts or conditions the action instead of reporting it."""
    segment = clause[:start].rsplit(",", 1)[-1]
    return _DELEGATION_HEDGE.search(segment) is not None


def _inside_double_quote(before: str) -> bool:
    """True when the text before a token has an unclosed double quote — the
    token is inside a line the model is relaying, not its own assertion.
    Backticks are deliberately not quotes here: `coder` is how a model
    formats a name, not how it quotes a log line."""
    if before.count('"') % 2:
        return True
    return before.count("“") > before.count("”")


def _delegated_agents(meta: dict) -> set[str]:
    """The lower-cased agent names one delegate span records — from the
    executor's facts and from the call's own argument; either is enough."""
    names: set[str] = set()
    facts = meta.get("facts")
    if isinstance(facts, list):
        for fact in facts:
            if isinstance(fact, dict) and isinstance(fact.get("agent"), str):
                names.add(fact["agent"].strip().lower())
    args = meta.get("args_redacted")
    if isinstance(args, dict) and isinstance(args.get("agent"), str):
        names.add(args["agent"].strip().lower())
    names.discard("")
    return names


def _child_turns_ran(meta: dict) -> tuple[set[str], bool]:
    """(the agents whose CHILD TURN really ran, whether one ran under a name
    that cannot be read) from one delegate span's facts.

    The marker is `agent_turn_id`: the executor writes it on the facts entry
    only once a child turn exists. A delegation refused BEFORE any run files
    the same entry shape with status "refused" and no id — agents.delegate does
    that before it raises (unknown agent, empty task), and tools/agents.py does
    it for "an agent cannot delegate" — so this field is what separates "it ran
    and errored" from "nothing ever ran"."""
    ran: set[str] = set()
    unnamed = False
    facts = meta.get("facts")
    if not isinstance(facts, list):
        return ran, unnamed
    for fact in facts:
        if not isinstance(fact, dict) or not fact.get("agent_turn_id"):
            continue
        agent = fact.get("agent")
        name = agent.strip().lower() if isinstance(agent, str) else ""
        if name:
            ran.add(name)
        else:
            unnamed = True
    return ran, unnamed


def _delegation_backing(spans: Sequence[Any]) -> tuple[dict[str, str], str]:
    """(per-agent backing, wildcard backing) read off the delegate spans.

    Per agent: "ok" if any successful delegate span names it; else "failed" if
    a failed (non-refused) span records that its CHILD TURN ran — a facts entry
    for that agent carrying an agent_turn_id; else nothing at all, which reads
    as "none". A failed CALL is not a failed RUN (2026-09-08): a delegation
    refused before it started never reached an agent, so "it did not finish"
    would be a fabrication of ours about a run that never existed. The wildcard
    is the same verdict for a span whose agent cannot be read at all, applied
    to every name — a delegation that ran but recorded no name backs any claim
    rather than correcting one it cannot see (the _target_of leniency)."""
    per_agent: dict[str, str] = {}
    wildcard = "none"
    for span in spans:
        if getattr(span, "kind", None) != "tool":
            continue
        if getattr(span, "name", None) != DELEGATE_TOOL_NAME:
            continue
        meta = getattr(span, "meta", None) or {}
        if any(str(key).startswith("refused") for key in meta):
            continue  # a refused call never ran: no delegation, no failure
        if meta.get("ok") is True:
            names = _delegated_agents(meta)
            if not names:
                wildcard = "ok"  # an ok verdict always wins the wildcard
                continue
            for name in names:
                per_agent[name] = "ok"
            continue
        ran, ran_unnamed = _child_turns_ran(meta)
        if ran_unnamed and wildcard == "none":
            wildcard = "failed"
        for name in ran:
            per_agent.setdefault(name, "failed")  # an earlier "ok" stands
    return per_agent, wildcard


def _backing_for(name: str, per_agent: dict[str, str], wildcard: str) -> str:
    verdict = per_agent.get(name, "none")
    if verdict == "ok" or wildcard == "ok":
        return "ok"
    if verdict == "failed" or wildcard == "failed":
        return "failed"
    return "none"


def _delegation_claims(clause: str, names: dict[str, str]) -> list[tuple[int, str, str]]:
    """Every completed action credited to a roster agent in one clause, as
    (position, canonical name, phrase), in text order. Empty when the clause
    places the action at another time or in someone else's mouth."""
    if (
        _PRIOR_TIME.search(clause) is not None
        or _REPORTED.search(clause) is not None
        or _ACCORDING_TO.search(clause) is not None
    ):
        return []
    tokens = [(m.group(0), m.start(), m.end()) for m in _TOKEN.finditer(clause)]
    bare = [_bare_token(raw) for raw, _, _ in tokens]
    claims: list[tuple[int, str, str]] = []

    def named_at(index: int) -> str | None:
        """The canonical agent name if the token at `index` is a roster name
        asserted in the model's own voice — not inside a relayed quote, not
        behind an indefinite determiner, not under a hedge or a conditional
        lead."""
        canonical = names.get(bare[index])
        if canonical is None:
            return None
        if _inside_double_quote(clause[: tokens[index][1]]):
            return None
        if _hedged_before(clause, tokens[index][1]):
            return None
        if index > 0 and bare[index - 1] in _INDEFINITE:
            return None
        return canonical

    # ACTIVE: <name> [up to two tokens] <completed verb>.
    for ni in range(len(tokens)):
        canonical = named_at(ni)
        if canonical is None:
            continue
        for j in range(ni + 1, min(ni + 1 + _DELEGATION_WINDOW, len(tokens))):
            raw, low = tokens[j][0], bare[j]
            if low in _DELEGATION_VERBS:
                claims.append((tokens[ni][1], canonical, clause[tokens[ni][1] :].strip()))
                break
            if _blocks(low, _ACTIVE_BLOCKERS) or raw in _STOP_PUNCT or low in _LIST_CONT:
                break

    # PASSIVE: <participle> [up to two tokens] by [the|agent] <name>.
    for pi in range(len(tokens)):
        if bare[pi] not in _DELEGATION_PARTICIPLES:
            continue
        if any(_blocks(bare[k], _PASSIVE_BLOCKERS) for k in range(max(0, pi - 3), pi)):
            continue
        for j in range(pi + 1, min(pi + 1 + _DELEGATION_WINDOW, len(tokens))):
            raw, low = tokens[j][0], bare[j]
            if raw in _STOP_PUNCT or low in _LIST_CONT:
                break
            if low != "by":
                continue
            ni = j + 1
            if ni < len(tokens) and bare[ni] in _BY_NAME_SKIP:
                ni += 1
            if ni < len(tokens):
                canonical = named_at(ni)
                if canonical is not None:
                    phrase = _strip_trailing_punct(clause[tokens[pi][1] : tokens[ni][2]])
                    claims.append((tokens[pi][1], canonical, phrase))
            break

    claims.sort(key=lambda claim: claim[0])
    return claims


def delegation_claim_check(
    reply_text: str,
    spans: Sequence[Any],
    agent_names: Sequence[str],
    *,
    self_name: str | None = None,
) -> DelegationClaim | None:
    """Contradict a completed action credited to an agent that no successful
    delegate_to_agent span backs this turn.

    Returns a DelegationClaim for the FIRST such claim — backing "none" when
    no delegation to that agent ran, "failed" when a run started and ended in
    an error — or None: an honest reply (the delegation ran and succeeded), a
    question, a future/modal/negated/progressive form, an action placed at
    another time or reported from elsewhere, an acknowledged failure, or a
    household with no agents at all. Pure and precision-first (see the section
    header). Derived from `agent_names`: with an empty roster there is no
    agent to credit, so the guard is silent by construction (fail-open).

    `self_name` is the agent whose OWN turn this is (None on Nova's turn). A
    claim about that name is the speaker describing ITSELF in the third
    person: no delegation can back it (an agent cannot delegate), so it is
    judged by narration's rule — any successful tool span this turn — and its
    correction speaks in the first person. On an agent's turn a claim about
    ANOTHER agent keeps the delegation reading but takes the correction that
    points at Nova, because this speaker cannot promise a delegation.
    """
    if not reply_text or not reply_text.strip():
        return None
    names: dict[str, str] = {}
    for raw in agent_names:
        name = str(raw).strip()
        if name and name.lower() not in names:
            names[name.lower()] = name
    speaker = str(self_name).strip() if self_name else ""
    if speaker:
        # The speaker's own name must be readable even if the caller's roster
        # does not carry it: a self-claim is judged by this turn's tool spans,
        # never by the roster, so it must not depend on the roster to be seen.
        names.setdefault(speaker.lower(), speaker)
    if not names:
        return None
    per_agent, wildcard = _delegation_backing(spans)
    # narration's rule for the self-claim: ANY successful tool span this turn.
    self_backed = ran_a_tool(spans) if speaker else False
    failure_acknowledged = _FAILURE_ACK.search(reply_text) is not None
    for clause, is_question in _clauses(reply_text):
        if is_question:
            continue  # "should I ask coder to review it?" asserts nothing
        for _position, agent, phrase in _delegation_claims(clause, names):
            is_self = bool(speaker) and agent.lower() == speaker.lower()
            if is_self:
                if self_backed:
                    continue  # something really ran this turn
                backing = "none"
            else:
                backing = _backing_for(agent.lower(), per_agent, wildcard)
                if backing == "ok":
                    continue
                if backing == "failed" and failure_acknowledged:
                    continue  # an honest report of the failure the tool stated
            return DelegationClaim(
                agent=agent,
                phrase=phrase[:80],
                backing=backing,
                text=delegation_correction_text(
                    agent, backing, self=is_self, on_agent_turn=bool(speaker)
                ),
            )
    return None
