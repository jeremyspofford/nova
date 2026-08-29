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
    make the guard the liar, which is worse than a missed lie. So the
    matcher is a small set of explicit past-tense/perfect patterns; a
    candidate is dropped the moment a modal, a future intent, a negation or
    a question governs the verb; and "backed" is judged leniently — a
    matching tool ran and its recorded target contains the named file, or a
    matching tool ran and the claim named no file at all. When it cannot be
    sure, it does not flag.

Backing is target-AWARE, not merely kind-aware: a claim that names a file is
backed only if a matching tool actually touched a file of that name. That is
what catches the model writing a NEW file while claiming it edited the named
one — a real span exists, but not for the thing it said it did. Leniency
runs the other way: an un-named claim, or a span whose target cannot be read
(a memory note, a flooded-and-clipped argument record), counts as backed.
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
# Presenting a specific file's contents as established fact is a knowledge
# claim that only a read (or the write that produced it) can ground.
_CONTENT_ASSERT = re.compile(
    r"\b(?:contains|contents?\s+of|here\s+(?:are|is)\s+the\s+contents?"
    r"|the\s+file\s+(?:says|reads))\b",
    re.I,
)

# A file the claim is about: a real filename token (known extensions only, so
# "e.g." and an end-of-sentence period never read as files), or a file noun.
_FILENAME = re.compile(
    r"\b[\w./-]*[\w-]\.(?:md|txt|json|csv|ya?ml|py|js|ts|html?|pdf|log|ini|toml|xml|sh|cfg|conf)\b",
    re.I,
)
_FILE_NOUN = re.compile(r"\b(?:files?|documents?|docs?|notes?|memo|readme|markdown)\b", re.I)
_URL = re.compile(r"https?://[^\s)>\]]+", re.I)
_WEB_NOUN = re.compile(r"\b(?:url|links?|web\s?pages?|websites?|the\s+web|online)\b", re.I)

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
    """True if no modal/intent/negation governs the verb at `at`."""
    window = clause[max(0, at - _WINDOW) : at]
    return _BLOCKER.search(window) is None


def _filenames(clause: str) -> list[str]:
    return [m.group(0) for m in _FILENAME.finditer(clause)]


def _first_unblocked(clause: str, pattern: re.Pattern[str]) -> re.Match[str] | None:
    for m in pattern.finditer(clause):
        if _unblocked(clause, m.start()):
            return m
    return None


def _claims_in(clause: str) -> list[tuple[str, str | None, str]]:
    files = _filenames(clause)
    urls = [m.group(0) for m in _URL.finditer(clause)]
    has_file = bool(files) or _FILE_NOUN.search(clause) is not None
    has_web = bool(urls) or _WEB_NOUN.search(clause) is not None

    claims: list[tuple[str, str | None, str]] = []

    # fetched/looked up a URL — a web object is required so "I looked it up"
    # (which could be a memory search) is never mistaken for a fetch.
    if has_web:
        m = _first_unblocked(clause, _FETCH_VERB)
        if m is not None:
            claims.append(("fetched_url", urls[0] if urls else None, m.group(0)))

    # presented a specific file's contents as fact
    if has_file:
        m = _first_unblocked(clause, _CONTENT_ASSERT)
        if m is not None:
            claims.append(("file_contents", files[0] if files else None, m.group(0)))

    # wrote/created/saved a file — one claim per named file, else one
    # target-less claim that any write span will back.
    if has_file:
        m = _first_unblocked(clause, _WRITE_VERB)
        if m is not None:
            if files:
                claims.extend(("wrote_file", name, m.group(0)) for name in files)
            else:
                claims.append(("wrote_file", None, m.group(0)))

    # read/checked a file (never when the object is a web page)
    if has_file and not has_web:
        m = _first_unblocked(clause, _READ_VERB)
        if m is not None:
            if files:
                claims.extend(("read_file", name, m.group(0)) for name in files)
            else:
                claims.append(("read_file", None, m.group(0)))

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
