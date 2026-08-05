"""Claiming a capability she does not have.

Sibling of narration.py, and a different failure. Narration catches
ANNOUNCING AN ACTION with zero tool calls ("I dispatched the tool-creator").
This catches CLAIMING AN ABILITY that no tool in the turn's resolved toolset
provides — "Yes. I can write code, run shell commands, and interact with
your filesystem", said on 2026-07-27 with no such tool in reach, in the turn
after the operator said she provided no value if she needed hand-holding.

That last detail is the design brief. The tool definitions were in the
request the whole time; a model under social pressure answers a capability
question from the conversation, not from its schema. So the check cannot
live in the prompt — the prompt is where the pressure is. It has to be
mechanical, and it has to compare against what was actually granted.

DERIVED, NEVER HARDCODED. Each capability names the TOOL SHAPES that would
satisfy it. Grant an MCP filesystem server and "I can read your files" stops
being flagged, automatically, with no edit here — which is the only way a
check like this survives the capability actually landing.

Precision is the design, as in narration.py: this raises a banner that
contradicts Nova in front of the operator, and one false accusation costs
more than several missed catches. Denials, questions, conditionals and
statements about OTHER things keep their sentence unflagged.
"""

from __future__ import annotations

import re
from typing import Iterable, Optional

# ── the capabilities worth checking, and what would satisfy each ─────────
# (label, claim pattern, the tool-name TOKENS that would provide it)
#
# TOKENS, not substrings. Matching `file` as a substring against the live
# toolset marked the filesystem capability satisfied by `github-profile-
# fetch` — "profile" contains "file" — and `git` was satisfied by "github".
# So a claim to read the operator's files was silently believed. Tool names
# are split on non-alphanumerics and matched whole.
#
# Only capabilities Nova has actually been caught claiming. A speculative
# list would be a precision liability with no measured catch behind it.
_CAPABILITIES: list[tuple[str, str, set[str]]] = [
    (
        "filesystem",
        r"\b(?:read|write|edit|create|modify|open|access|browse|list)\b[^.!?]{0,40}"
        r"\b(?:file|files|filesystem|file system|directory|directories|folder|folders)\b"
        r"|\baccess to (?:your |the )?(?:file|files|filesystem|file system)\b",
        {"file", "files", "filesystem", "fs", "directory", "directories",
         "dir", "folder", "folders", "path", "glob"},
    ),
    (
        "shell",
        r"\b(?:run|execute|issue|invoke)\b[^.!?]{0,30}"
        r"\b(?:shell|bash|command|commands|terminal|script|scripts)\b"
        r"|\b(?:shell|terminal|bash) access\b",
        {"shell", "bash", "sh", "zsh", "exec", "execute", "command",
         "commands", "cmd", "terminal", "process", "subprocess"},
    ),
    (
        "git",
        r"\b(?:use|run|do|manage|perform|handle)\b[^.!?]{0,25}\bgit\b"
        r"|\bgit (?:commit|clone|push|pull|checkout|branch|access)\b"
        r"|\bcommit (?:that|this|it|them|changes)\b"
        # The VCS verb WITHOUT the word "git". Asked "can you clone one of my
        # repos", she said she would — and nothing fired, because every arm
        # above needs the literal token `git` nearby. The comment at :37
        # records that this arm was narrowed once because "github" was
        # satisfying it; narrowing the SATISFIER was right, narrowing the
        # CLAIM left the most natural phrasing of the ask unmatched.
        r"|\b(?:clone|fork|check ?out|push to|pull from)\b[^.!?]{0,25}"
        r"\b(?:repo|repos|repository|repositories)\b",
        {"git", "commit", "repo", "repository", "branch", "clone", "push"},
    ),
    (
        "code editing",
        r"\b(?:write|edit|change|modify|refactor|fix|implement|build)\b"
        r"[^.!?]{0,25}\b(?:code|codebase|repo|repository|your project)\b",
        {"file", "files", "edit", "patch", "code", "repo", "repository",
         "git", "apply"},
    ),
    (
        "machine access",
        r"\b(?:access|control|reach into|get into|log ?into)\b[^.!?]{0,25}"
        r"\b(?:your (?:machine|computer|box|laptop|system)|the host)\b",
        {"shell", "exec", "ssh", "file", "files", "command", "terminal"},
    ),
]

_COMPILED = [(label, re.compile(claim, re.IGNORECASE), tokens)
             for label, claim, tokens in _CAPABILITIES]

_TOKEN = re.compile(r"[a-z0-9]+")

# A sentence that DENIES, ASKS or SUPPOSES is not a claim. Checked per
# sentence, the same shape narration.py uses for recaps and conditionals —
# "I cannot write files" contains "write files", and flagging the honest
# answer would be the worst possible outcome for a check that exists to keep
# her honest.
_NOT_A_CLAIM = re.compile(
    r"\bcan(?:no|')t\b|\bcannot\b|\bdo(?:n't| not)\b|\bunable\b|\bnot able\b"
    r"|\bno (?:ability|access|way|tool|tools)\b|\bnever\b|\black\b|\blacks\b"
    r"|\bwithout\b|\bwant me to\b|\bshould i\b|\bused to\b|\bnot yet\b"
    r"|\byet to\b|\bwish i\b|\bcan you\b|\bdo you\b"
    # "I can only register remote HTTP servers, not deploy processes" — a
    # denial by narrowing, which none of the patterns above recognise. Scoped
    # tightly (`only` … `not` inside one clause) rather than a bare `\bnot\b`,
    # which would exempt "I'm not going to lie, I can read your files".
    r"|\bonly\b[^.!?\n]{0,60}\bnot\b",
    re.IGNORECASE)

# Hypotheticals, split out of the list above on 2026-07-31 because POSITION
# decides them and the flat list ignored it. A bare `\bif\b` anywhere exempted
# the whole sentence, so "I'll check IF I have access to GitHub and if I can
# clone one of your repos" — a claim with a subordinate clause — was thrown
# away unexamined. Same defect narration.py had, found the same day.
#
#   "If I could run shell commands, I would check myself"  -> before: supposing
#   "I can read your files if you want"                    -> after:  claiming
#
# Only exempts when the marker PRECEDES the matched claim.
_SUPPOSING = re.compile(
    r"\bif\b|\bonce\b|\bwould\b|\bcould\b|\bwhen you\b", re.IGNORECASE)

# First person only. "The coder agent writes code" is a claim about an
# agent, and the dispatch index already states each specialist's real
# grants. But "I can … through the coder agent" IS a claim about what SHE
# can accomplish, and it is the exact phrasing that fooled the operator, so
# the subject test is on the sentence's opening, not on the whole thing.
_FIRST_PERSON = re.compile(
    r"\b(?:i|i'?m|i am|i'?ve|i have|i can|i could|my)\b", re.IGNORECASE)

# Clauses, not just sentences. A spaced em/en dash and a semicolon join two
# independent statements, and this check asks TWO questions of whatever it is
# handed — "is the subject first person?" and "does it claim a capability?".
# Split too coarsely, those land on different halves and the answer is
# nonsense. MEASURED 2026-08-04, the sentence that produced a false
# accusation in front of the operator:
#
#   "But to access your **local** filesystem, the server has to actually run
#    on your machine — and I can only register remote HTTP servers, not
#    deploy processes"
#
# The capability phrase is in the first clause, which is about what the
# SERVER needs. The first person is in the second, which is a DENIAL. Read as
# one sentence it looks like "I ... access your local filesystem", and her
# reply was stamped "Nova claimed filesystem access — treat that claim as
# false" while she was in fact explaining she could not do it.
#
# Spaces required around the dash so hyphenated words and ranges are safe.
_SENTENCES = re.compile(r"[.!?\n;]+|\s+[—–]+\s+")


def _tokens(name: str) -> set[str]:
    """`mcp:filesystem/read_file` -> {mcp, filesystem, read, file}."""
    return set(_TOKEN.findall(name.lower()))


def _satisfied(wanted: set[str], tool_names: Iterable[str]) -> bool:
    return any(wanted & _tokens(name) for name in tool_names)


# What to SAY, per label. A template over the label alone produced "code
# editing access" and "machine access access", so the wording lives next to
# the patterns it describes and is written once per capability.
_CORRECTION = {
    "filesystem": "read or write files on this machine",
    "shell": "run shell commands",
    "git": "use git",
    "code editing": "edit code",
    "machine access": "reach into the operator's machine",
}


def correction(label: str) -> str:
    """The retraction to append to a reply that claimed `label`.

    Mirrors narration's note. A banner alone is not enough for the same
    reason it was not enough there: the activity event persists as a
    role='tool' row and `conversations.to_llm_history` keeps only
    user/assistant rows, so the CLAIM is replayed on every later turn and the
    contradiction never is. On voice it is worse — only text reaches the
    speaker, so the false claim is spoken and the correction has no audible
    form at all. model_claims.py:159 already argued this and got a
    correction(); this is its sibling finally getting the same.
    """
    what = _CORRECTION.get(label, f"do that ({label})")
    return (f"\n\n[Correction: I cannot {what}. No tool available to me this "
            f"turn provides it, so the statement above was wrong.]")


def detect(final_text: str, tool_names: Iterable[str]) -> Optional[str]:
    """The claimed capability when the text asserts one no granted tool
    provides; None otherwise.

    `tool_names` is the turn's RESOLVED toolset — the same list the model
    was handed — so this asks "was that true?" against the only ground truth
    that matters.
    """
    if not final_text:
        return None
    names = list(tool_names or [])
    for sentence in _SENTENCES.split(final_text):
        if not sentence:
            continue
        first_person = _FIRST_PERSON.search(sentence)
        if not first_person or _NOT_A_CLAIM.search(sentence):
            continue
        supposing = _SUPPOSING.search(sentence)
        for label, claim, tools in _COMPILED:
            m = claim.search(sentence)
            if not m or _satisfied(tools, names):
                continue
            # POSITION DECIDES THE SUBJECT, the same rule _SUPPOSING already
            # follows. This searched the whole clause, so any "I" or "my"
            # anywhere in it made a claim about something else read as a claim
            # about her. MEASURED 2026-08-04:
            #
            #   "To access your **local** filesystem, the server has to run on
            #    your machine and expose an HTTPS endpoint (my registration
            #    requires `https://`)"
            #
            # The subject is "the server"; the only first person is a
            # parenthetical AFTER the claim, about her registration tool. Her
            # reply was stamped "Nova claimed filesystem access — treat that
            # claim as false" while she was explaining she could not do it.
            # This is the check's own docstring ("the subject test is on the
            # sentence's opening") finally being true of the code.
            if first_person.start() > m.start():
                continue
            if supposing and supposing.start() < m.start():
                continue          # hypothesising, not claiming — see _SUPPOSING
            return label
    return None
