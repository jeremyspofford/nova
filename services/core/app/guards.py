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

# Completed morphology only. A future or hedged form uses the BASE verb
# ("I'll create", "I can save", "would you like me to write"), which these
# past/participle patterns never match — so most hedging is filtered by the
# verb form alone, before any window check. "read" is the one ambiguous case
# (base == past), handled by the preceding-window blocker below.
_WRITE_VERB = re.compile(r"\b(?:created|wrote|written|saved|updated|appended|added)\b", re.I)
_READ_VERB = re.compile(r"\b(?:read|checked|reviewed|opened|examined)\b", re.I)
_FETCH_VERB = re.compile(
    r"\b(?:fetched|retrieved|downloaded|visited|accessed|read|pulled|looked)\b", re.I
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

# Presenting a NAMED file's contents as fact: "<file> contains/says/…". The
# filename must anchor the verb, so an in-chat draft that names no file token
# ("Here is the content of the file:", "The draft note contains three parts")
# is never a claim — presenting proposed content in chat is honest.
_CONTENT_CLAIM = re.compile(
    r"\b(" + _FILENAME_RE + r")\b\s+(?:now\s+|currently\s+)?"
    r"(?:contains?|says?|reads?|shows?|holds?|lists?|includes?)\b",
    re.I,
)

# The passive voice, where the filename is the subject and precedes the verb:
# "<file> has been updated", "<file> was read". A negation ("was not updated")
# or a future ("will be updated") breaks the auxiliary run and so never
# matches — exactly the silence we want.
_PASSIVE_CLAIM = re.compile(
    r"\b(" + _FILENAME_RE + r")\b\s+(?:has|have|had|was|were|is|are)\s+(?:been\s+|now\s+)?"
    r"(?P<verb>created|written|wrote|saved|updated|appended|added|overwritten"
    r"|read|opened|reviewed|checked|examined)\b",
    re.I,
)
_PASSIVE_READ_VERBS = frozenset({"read", "opened", "reviewed", "checked", "examined"})

# A second/third-person subject immediately before a verb: the action is
# ATTRIBUTED to someone else or reported ("you saved notes.md", "you mentioned
# you saved …", "since you created the file"), so it is not Nova's own claim.
# Kept tight — the pronoun must be the verb's subject, 0–1 words before it — so
# a first-person claim with a second-person aside ("as you requested, I created
# report.md") is NOT suppressed.
_ATTRIBUTED = re.compile(r"\b(?:you|he|she|they|we)\b(?:\s+\w+){0,1}\s+$", re.I)

# The maximum gap between an active verb and the file token it governs, so a
# filename far from the verb (a different subject that merely shares the
# clause) is not swept in as its object.
_OBJECT_REACH = 80

# Anything in the short window BEFORE a completed verb that turns an assertion
# into a non-assertion: a modal or intent ("will", "can", "going to", "to"),
# a negation ("not", "never", "n't"), or a contrast/substitution ("instead").
# Scoped to the verb, never the whole clause, so "created X, which will help"
# (the modal falls AFTER the verb) stays a claim.
_BLOCKER = re.compile(
    r"(?:\b(?:not|never|no|nothing|cannot|can|could|will|shall|should|would|may|might|"
    r"must|to|going|gonna|about|plan|planning|planned|intend|intending|want|wants|"
    r"wanted|hope|hoping|hoped|try|trying|tried|let|if|unable|instead|rather|"
    r"won't|couldn't|didn't|wasn't|isn't|don't|doesn't|haven't|hasn't|shouldn't|"
    r"wouldn't|can't|aren't|fail|failed|fails)\b)|(?:n't\b)|(?:'ll\b)",
    re.I,
)
_WINDOW = 24

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


def _unblocked(clause: str, at: int) -> bool:
    """True if nothing turns the verb at `at` into a non-claim: no
    modal/intent/negation in the short window before it, and no second/third-
    person subject governing it (an attributed or reported action)."""
    prefix = clause[:at]
    window = prefix[-_WINDOW:]
    if _BLOCKER.search(window) is not None:
        return False
    if _ATTRIBUTED.search(prefix) is not None:
        return False
    return True


def _first_unblocked(clause: str, pattern: re.Pattern[str]) -> re.Match[str] | None:
    for m in pattern.finditer(clause):
        if _unblocked(clause, m.start()):
            return m
    return None


def _claims_in(clause: str) -> list[tuple[str, str, str]]:
    """Every completed-action claim in one clause, each tied to a REAL target
    (a filename token or a URL). A bare noun never qualifies, and an action
    attributed to someone else is not a claim."""
    claims: list[tuple[str, str, str]] = []
    urls = [m.group(0) for m in _URL.finditer(clause)]

    # fetched a URL — an explicit http(s) token is required, so "I looked it
    # up" (which might be a memory search) is never read as a fetch.
    if urls:
        m = _first_unblocked(clause, _FETCH_VERB)
        if m is not None:
            claims.append(("fetched_url", urls[0], m.group(0)))

    # presented a named file's contents as fact: "<file> contains/says/…"
    for cm in _CONTENT_CLAIM.finditer(clause):
        if _unblocked(clause, cm.start(1)):
            claims.append(("file_contents", cm.group(1), cm.group(0)))

    # passive voice: "<file> has been updated", "<file> was read"
    for pm in _PASSIVE_CLAIM.finditer(clause):
        if _unblocked(clause, pm.start(1)):
            verb = pm.group("verb").lower()
            kind = "read_file" if verb in _PASSIVE_READ_VERBS else "wrote_file"
            claims.append((kind, pm.group(1), pm.group(0)))

    # active voice: tie each file token to its NEAREST preceding unblocked
    # action verb, within reach — so "I read a.md and wrote b.md" does not read
    # as writing a.md, and a filename that is a different clause's subject is
    # not swept in as an object.
    actions: list[tuple[int, str, str]] = []
    for m in _WRITE_VERB.finditer(clause):
        if _unblocked(clause, m.start()):
            actions.append((m.start(), "wrote_file", m.group(0)))
    if not urls:
        for m in _READ_VERB.finditer(clause):
            if _unblocked(clause, m.start()):
                actions.append((m.start(), "read_file", m.group(0)))
    actions.sort()
    for fm in _FILENAME.finditer(clause):
        governing = [a for a in actions if 0 <= fm.start() - a[0] <= _OBJECT_REACH]
        if governing:
            _pos, kind, phrase = governing[-1]
            claims.append((kind, fm.group(0), phrase))

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
