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
        r"|\bcommit (?:that|this|it|them|changes)\b",
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
    r"|\bwithout\b|\bif\b|\bonce\b|\bwould\b|\bcould\b|\bwhen you\b"
    r"|\bwant me to\b|\bshould i\b|\bused to\b|\bnot yet\b|\byet to\b"
    r"|\bwish i\b|\bcan you\b|\bdo you\b",
    re.IGNORECASE)

# First person only. "The coder agent writes code" is a claim about an
# agent, and the dispatch index already states each specialist's real
# grants. But "I can … through the coder agent" IS a claim about what SHE
# can accomplish, and it is the exact phrasing that fooled the operator, so
# the subject test is on the sentence's opening, not on the whole thing.
_FIRST_PERSON = re.compile(
    r"\b(?:i|i'?m|i am|i'?ve|i have|i can|i could|my)\b", re.IGNORECASE)

_SENTENCES = re.compile(r"[.!?\n]+")


def _tokens(name: str) -> set[str]:
    """`mcp:filesystem/read_file` -> {mcp, filesystem, read, file}."""
    return set(_TOKEN.findall(name.lower()))


def _satisfied(wanted: set[str], tool_names: Iterable[str]) -> bool:
    return any(wanted & _tokens(name) for name in tool_names)


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
        if not _FIRST_PERSON.search(sentence) or _NOT_A_CLAIM.search(sentence):
            continue
        for label, claim, tools in _COMPILED:
            if claim.search(sentence) and not _satisfied(tools, names):
                return label
    return None
