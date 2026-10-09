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
    delete/remove a file                 -> workspace_delete
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

import ipaddress
import re
import shlex
from bisect import bisect_left, bisect_right
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, NamedTuple
from urllib.parse import urlsplit

from app import native_app

# Successful spans ground each kind of claim ("I wrote X", "I read X", ...).
# Which tools back a kind is DERIVED from the registry — each tool declares the
# kinds it backs (`Tool.backs`, read through tools.tool_names_backing) — so a
# new filesystem/fetch tool joins a kind by its own declaration (S29a T2: this
# was a dict kept here, _KIND_TOOLS, and an ok device read of README.md had a
# true "I read README.md" corrected because no one added device_read_file).
# test_tools_registry pins every tool's `backs`, which is the alarm now.
#
# The named sets below are NOT the narration kinds' tools: other guards read
# them by name, and test_state_guard pins _CONFIGURE_TOOLS / _UPDATE_TOOLS to
# the registry's names.
#
# S38: the browser tools a fetch claim may be backed by (see _target_of) —
# browser_open by the address it was asked for and the one it landed on,
# browser_read, browser_back and browser_act by the page their facts name. The
# presented-listing guard keeps these tools' results (keeps= below).
_FETCH_TOOLS = frozenset(
    {"fetch_url", "browser_open", "browser_read", "browser_back", "browser_act"}
)
_CONFIGURE_TOOLS = frozenset({"machine_configure"})
# test_state_guard pins _CONFIGURE_TOOLS to MACHINE_CONFIGURE.name, so a
# rename in the registry turns that red. The READ of a machine is derived from
# the registry instead (_machine_read_tools, S40b final fix wave C2).
# S42b: the tool that updates an agent (machine_update). Its span facts back an
# update claim (narration) and its recorded connectivity is a device check (the
# state guard); test_state_guard pins it to MACHINE_UPDATE.name.
_UPDATE_TOOLS = frozenset({"machine_update"})
# S42b (Task 23 fix round 1, I2): the tool that changes one of her SPECIALIST
# agents' fields (coder's round budget, its tools). "I updated coder's agent
# settings" after it ran is about that agent, not a machine's; test_state_guard
# pins it to the registered tool whose executor is tools.agents.update_agent.
_PERSONA_UPDATE_TOOLS = frozenset({"update_agent"})


def _spend_tools() -> frozenset[str]:
    """Which tools' successful spans back a stated dollar figure — DERIVED from
    the live registry, never a list kept here (S15).

    It was a list of one name, `spend_report`, and `list_agents` reports every
    agent's cap and month-to-date spend from the same ledger. So a figure the
    owner had just been shown was retracted as one nobody read — twice in a row
    on 2026-09-11, the second time contradicting its own body. A false
    retraction is worse than the claim it corrects: it teaches him that her
    corrections are noise, which is the one thing this layer cannot afford.

    Imported inside the call because app.tools imports this module.
    """
    from app import tools

    return frozenset(tools.tool_names_reporting_spend())


def _machine_read_tools() -> frozenset[str]:
    """Which tools' successful spans are a READ of a machine, for the state
    guard's machine branch — DERIVED from the live registry
    (`Tool.reads_machines`), never a list kept here (S40b final fix wave, C2).

    It was one name, machine_status. inference_health reads the same engine
    list and states every machine's card and state, and route_explain states
    each link's machine verdict; after either, an honest "hub is switched off"
    was REPLACED with "I did not check hub this turn". Imported inside the
    call because app.tools imports this module (_spend_tools' rule)."""
    from app import tools

    return frozenset(tools.machine_read_tool_names())


def _tools_for_kind(kind: str) -> frozenset[str]:
    """The tools whose successful span backs claim kind `kind` — DERIVED from
    the live registry (`Tool.backs`, S29a T2), never a list kept here. The
    spend kind keeps its own derivation (`Tool.reports_spend`). Imported
    inside the call because app.tools imports this module."""
    if kind == "stated_spend":
        return _spend_tools()
    from app import tools

    return frozenset(tools.tool_names_backing(kind))


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

# S29a T3: her completed claim that tests passed — "All 40 tests passed.",
# "The tests passed.", "All tests pass now." Backed ONLY by a `run` fact
# (devices.py files one from the agent's own result frame) whose target is a
# test-runner invocation with exit_code 0, the LAST such run deciding
# (_tests_passed_backed). Never by prose: a log that says "40 passed" is text.
#
# The subject must sit right against the verb: "All 40 tests probably passed"
# hedges between them and never matches. Present "pass" counts only at the end
# of its clause or before "now" ("make sure the tests pass so…" never matches).
# Every gap is bounded and each repetition is entered at a word's front, so an
# attempt is a fixed length from its start: linear over a whole reply.
_TESTS_PASSED_CLAIM = re.compile(
    r"\b(?:all\s++(?:of\s++)?)?(?:(?:the|my|our|your|these|those)\s++)?(?:\d{1,6}\s++)?"
    r"(?:(?:unit|integration|new|core|web|existing|remaining|updated)\s++){0,2}"
    r"tests?\s++(?:(?:have|has)\s++)?(?:(?:now|all)\s++)?"
    r"(?:passed\b|pass(?:es)?(?=\s*+(?:now\b|[.,;:!)]|$)))",
    re.I,
)
# A word before the claim, in its clause, that makes it no report of a run:
# a negation ("not all tests passed", "none of the tests"), a hedge or modal,
# a condition ("if all 40 tests passed"), or someone else's report ("you
# said", "CI reported"). Precision first: any of them anywhere before it.
_TESTS_PASSED_CUT = re.compile(
    r"\b(?:not|never|no|none|neither|nor|without|if|unless|whether|should|would|will|"
    r"might|may|could|can|must|probably|likely|hopefully|maybe|perhaps|expect\w*|hope\w*|"
    r"ensure\w*|make\s+sure|so\s+that|said|says|say|reported|reports|claim(?:s|ed)?|"
    r"according|told|think\w*|believe\w*|assum\w*|suppos\w*|"
    r"\w+n't|\w+'ll)\b",
    re.I,
)
# A condition a PRESENT "pass" sits under ("once all 40 tests pass, I'll open
# the PR"); a past "passed" after one is a report ("when I ran it, all 40
# tests passed"), so it cuts only the present form.
_TESTS_PASSED_PRESENT_CUT = re.compile(r"\b(?:once|when|whenever|until|after|before)\b", re.I)
# S29a T3b: the correction names what the record shows, so it is true in every
# case: the deciding run (the LAST test-runner run fact) by its command and exit
# code, or that no test runner ran. "No test run exited 0" was false beside an
# earlier `npm test` that exited 0 under a later failing `pytest`.
TESTS_NO_RUNNER_TEXT = (
    "Correction: no test runner ran this turn — the record does not show the tests passing."
)
TESTS_FAILED_RUN_TEXT = (
    "Correction: the last test run this turn, `{command}`, {outcome} — the record does not "
    "show the tests passing."
)
_TESTS_COMMAND_CHARS = 80

# The programs that run a test suite, by their first word (after any wrapper:
# env assignments, `uv run`, `npx`, a shell's `-c`). A program whose suite is
# its `test` subcommand (`go test`, `cargo test`, `npm test`) is in _RUNNER_SUB.
_RUNNER_PROGRAMS = frozenset(
    {"pytest", "py.test", "vitest", "jest", "mocha", "tox", "nox", "ctest", "rspec", "phpunit"}
)
_RUNNER_SUB = frozenset(
    {"go", "cargo", "npm", "pnpm", "yarn", "bun", "deno", "dotnet", "mix", "swift", "make"}
)
_PYTHON_MODULES = frozenset({"pytest", "unittest", "tox", "nox"})
_WRAPPERS = frozenset(
    {"uv", "poetry", "pipenv", "pdm", "hatch", "npx", "bunx", "pnpx", "env", "sudo", "time"}
)
_SHELLS = frozenset({"sh", "bash", "zsh", "dash", "cmd", "powershell", "pwsh"})
_SHELL_SEPARATORS = ("&&", "||", ";", "|", "\n")


def _is_test_runner(argv: Sequence[str], depth: int = 0) -> bool:
    """Whether this argv runs a test suite — read from the argv a run fact
    recorded, never from prose. Wrappers are stepped through (`uv run pytest`,
    `env CI=1 npm test`); a shell's `-c` string is split on its separators and
    each command read the same way. Bounded: a wrapper chain stops at 4."""
    words = [w for w in argv if isinstance(w, str)]
    if depth > 4 or not words:
        return False
    i = 0
    while i < len(words) and "=" in words[i] and not words[i].startswith("-"):
        i += 1  # KEY=value before the program (a shell's env prefix)
    if i >= len(words):
        return False
    program = _program(words[i])
    rest = words[i + 1 :]
    args = [w for w in rest if not w.startswith("-")]
    if program in _RUNNER_PROGRAMS:
        return True
    if program.startswith("python") or program == "py":
        return any(
            rest[j] == "-m" and j + 1 < len(rest) and rest[j + 1] in _PYTHON_MODULES
            for j in range(len(rest))
        )
    if program in _RUNNER_SUB:
        if not args:
            return False
        sub = args[0].lower()
        if sub == "run" and program in {"npm", "pnpm", "yarn", "bun"} and len(args) > 1:
            sub = args[1].lower()
        return sub in {"test", "t", "check"} or sub.startswith("test:")
    if program in _WRAPPERS:
        if program in {"env", "sudo", "time"}:
            return _is_test_runner(rest, depth + 1)
        inner = [w for w in rest if not w.startswith("-")]
        if inner and inner[0] == "run" and program != "npx":
            inner = inner[1:]
        return _is_test_runner(inner, depth + 1)
    if program in _SHELLS:
        for j, word in enumerate(rest):
            if word.lower() in {"-c", "/c", "-command"} and j + 1 < len(rest):
                script = " ".join(rest[j + 1 :])
                for sep in _SHELL_SEPARATORS:
                    script = script.replace(sep, "\0")
                return any(_is_test_runner(part.split(), depth + 1) for part in script.split("\0"))
    return False


def _deciding_test_run(spans: Sequence[Any]) -> tuple[list[str], Any] | None:
    """The LAST test-runner `run` fact this turn, as (argv, exit_code), or None
    when no test runner ran. Every tool span's facts are read, ok or not: a
    failed frame still files its run fact (T1), and a later failing run must
    outrank an earlier pass. A run that is not a test runner changes nothing."""
    last: tuple[list[str], Any] | None = None
    for span in spans:
        if getattr(span, "kind", None) != "tool":
            continue
        meta = getattr(span, "meta", None) or {}
        for fact in meta.get("facts") or ():
            run = fact.get("run") if isinstance(fact, dict) else None
            if not isinstance(run, dict):
                continue
            argv = run.get("argv")
            if not isinstance(argv, list):
                target = fact.get("target")
                argv = target.split() if isinstance(target, str) else []
            if _is_test_runner(argv):
                last = ([w for w in argv if isinstance(w, str)], run.get("exit_code"))
    return last


def _tests_passed_backed(spans: Sequence[Any]) -> bool:
    """Whether the deciding test run (_deciding_test_run) exited 0."""
    last = _deciding_test_run(spans)
    if last is None:
        return False
    code = last[1]
    return code == 0 and not isinstance(code, bool)


def _tests_correction_text(spans: Sequence[Any]) -> str:
    """The tests_passed correction, built from the facts the guard decided on:
    the deciding run's command and exit code, or that no test runner ran. The
    command drops KEY=value words (a credential in an env prefix never reaches
    her reply) and is bounded."""
    last = _deciding_test_run(spans)
    if last is None:
        return TESTS_NO_RUNNER_TEXT
    argv, code = last
    command = " ".join(w for w in argv if "=" not in w).replace("`", "'")
    if len(command) > _TESTS_COMMAND_CHARS:
        command = command[: _TESTS_COMMAND_CHARS - 1] + "…"
    if isinstance(code, int) and not isinstance(code, bool):
        outcome = f"exited {code}"
    else:
        outcome = "has no exit code on record"
    return TESTS_FAILED_RUN_TEXT.format(command=command, outcome=outcome)


def _tests_passed_claims(clause: str) -> list[tuple[str, str | None, str]]:
    """The tests_passed claim in one clause, at most one: the first match no
    cut before it in the clause silences. Each cut is found once per clause and
    compared by position."""
    claims = list(_TESTS_PASSED_CLAIM.finditer(clause))
    if not claims:
        return []
    cut = _TESTS_PASSED_CUT.search(clause)
    present_cut = _TESTS_PASSED_PRESENT_CUT.search(clause)
    for tm in claims:
        if cut is not None and cut.start() < tm.start():
            return []
        if (
            present_cut is not None
            and present_cut.start() < tm.start()
            and not tm.group(0).lower().endswith("passed")
        ):
            continue
        return [("tests_passed", None, tm.group(0))]
    return []


# S29a T4: her completed claim that she ran a command — "I ran `pytest`",
# "I ran git status", "I've run `npm test`". The target is the command's
# program (_claimed_program); backed ONLY by a `run` fact this turn whose target
# holds a word with that program, any exit code: running is not passing
# (_ran_command_backed). Read over whole sentences, because "I ran `git status`
# and then `pytest`" is split into clauses at "then" and its second command
# would lose its verb. The subject sits right against the verb ("I never ran",
# "CI ran", "Did I run" never match); a backticked command is bounded and holds
# no backtick or newline, a bare one is one word. Linear over a whole reply.
_RAN_COMMAND_CLAIM = re.compile(
    r"\bI(?:\s++ran|['’]ve\s++run|\s++have\s++run)\s++"
    r"(?:(?:just|also|then|now|first|already|again|finally)\s++)?"
    r"(?:`(?P<tick>[^`\n]{1,200})`|(?P<bare>[A-Za-z][\w./+-]{0,63}+))"
)
# Another backticked command chained onto the claim: "…`git status` and then
# `pytest`", "…`ls`, `pwd`". Matched at the end of the previous one, a bounded
# number of joiners, so each step is a fixed length from where it starts.
_RAN_COMMAND_MORE = re.compile(
    r"(?:\s*+(?:,|and\b|then\b|also\b|&)){1,4}\s*+`(?P<tick>[^`\n]{1,200})`"
)
_RAN_COMMAND_CHAIN = 8  # chained commands read per claim
# The English "ran": a bare word after "I ran" that names no program.
_RAN_ENGLISH = frozenset(
    (
        "into out it them the a an this that these those some all every each both one two "
        "my your our his her their its fine well late behind ahead short low over through "
        "across away off up down around past to by from with for on in at as again back "
        "errands home there here everything something nothing anything tests test checks "
        "check command commands script scripts"
    ).split()
)
RAN_NO_RUN_TEXT = (
    "Correction: no command ran this turn — the record does not show {programs} running."
)
RAN_OTHER_TEXT = (
    "Correction: what ran this turn was {commands} — the record does not show {programs} running."
)
_RAN_LISTED = 5  # commands named in the correction, the rest counted
# The claim kinds a run fact alone decides, each with its own true correction.
_RUN_FACT_KINDS = frozenset({"tests_passed", "ran_command"})


def _claimed_program(command: str) -> str | None:
    """A claimed command's program: its first word after KEY=value words, by
    _program; None when nothing is left."""
    for word in command.split():
        if "=" in word and not word.startswith("-"):
            continue
        program = _program(word.rstrip(".,:;!)"))
        return program or None
    return None


def _ran_command_claims(sentence: str) -> list[tuple[str, str | None, str]]:
    """The ran_command claims in one non-question sentence: each "I ran X"
    with no negation, hedge, condition or someone else's report before it
    (_TESTS_PASSED_CUT, found once per sentence), and the backticked commands
    chained onto it (_RAN_COMMAND_MORE)."""
    claims: list[tuple[str, str | None, str]] = []
    claimed = list(_RAN_COMMAND_CLAIM.finditer(sentence))
    if not claimed:
        return claims
    cut = _TESTS_PASSED_CUT.search(sentence)
    for rm in claimed:
        if cut is not None and cut.start() < rm.start():
            return claims
        commands = []
        if rm.group("tick") is not None:
            commands.append((rm.group("tick"), rm.group(0)))
        else:
            bare = rm.group("bare").rstrip(".,:;!)")
            low = bare.lower()
            if low in _RAN_ENGLISH or low.endswith("ly"):
                continue
            commands.append((bare, rm.group(0)))
        pos = rm.end()
        for _ in range(_RAN_COMMAND_CHAIN):
            more = _RAN_COMMAND_MORE.match(sentence, pos)
            if more is None:
                break
            commands.append((more.group("tick"), more.group(0)))
            pos = more.end()
        for command, phrase in commands:
            program = _claimed_program(command)
            if program:
                claims.append(("ran_command", program, phrase))
    return claims


def _run_facts(spans: Sequence[Any]) -> list[tuple[list[str], str]]:
    """Every `run` fact this turn, in order, as (its words, its target): every
    tool span's facts, ok or not (a failed frame still ran). The words are the
    argv's and the target's, each split on whitespace, so a shell's `-c`
    string is read word by word."""
    runs: list[tuple[list[str], str]] = []
    for span in spans:
        if getattr(span, "kind", None) != "tool":
            continue
        meta = getattr(span, "meta", None) or {}
        for fact in meta.get("facts") or ():
            run = fact.get("run") if isinstance(fact, dict) else None
            if not isinstance(run, dict):
                continue
            argv = run.get("argv")
            argv = [w for w in argv if isinstance(w, str)] if isinstance(argv, list) else []
            target = fact.get("target")
            target = target if isinstance(target, str) else " ".join(argv)
            words = [w for part in [*argv, target] for w in part.split()]
            runs.append((words, " ".join(argv) or target))
    return runs


def _ran_command_backed(program: str | None, spans: Sequence[Any]) -> bool:
    """Whether a run fact this turn holds a word whose program is `program`."""
    if not program:
        return False
    return any(_program(word) == program for words, _target in _run_facts(spans) for word in words)


def _file_basename(text: str) -> str:
    """The last path segment of a word or path, quotes and shell punctuation
    stripped, lower-cased: "services/core/chat.py" and "'C:\\x\\chat.py';" are
    both "chat.py". String methods only."""
    word = text.strip().strip("'\"`<>()[]{},;:|&.!?")
    return word.replace("\\", "/").rsplit("/", 1)[-1].lower()


def _edited_file_backed(
    target: str | None, successful: Sequence[Any], spans: Sequence[Any]
) -> bool:
    """Whether this turn wrote the file an edited_file claim names, by name:
    an ok span of a tool backing wrote_file whose READABLE target (_target_of)
    ends in that file — a device write's `file` fact, a workspace write's path
    — or a `run` fact with a word naming it (a shell edit: `sed -i`, a script;
    any exit, ok or failed frame). A span with no readable target (a memory
    note) backs nothing: an edit names a file, and a note is not one."""
    if not target:
        return False
    needle = _file_basename(target)
    if not needle:
        return False
    writers = _tools_for_kind("wrote_file")
    for span in successful:
        if span.name not in writers:
            continue
        written = _target_of(span)
        if isinstance(written, str) and _file_basename(written) == needle:
            return True
    return any(
        _file_basename(word) == needle for words, _target in _run_facts(spans) for word in words
    )


def _ran_correction_text(programs: Sequence[str | None], spans: Sequence[Any]) -> str:
    """The ran_command correction, true in every case: no command ran this
    turn, or what did run (its commands, KEY=value words dropped, bounded)."""
    named = ", ".join(f"`{p}`" for p in dict.fromkeys(p for p in programs if p))
    runs = _run_facts(spans)
    if not runs:
        return RAN_NO_RUN_TEXT.format(programs=named)
    commands = []
    for _words, target in runs:
        command = " ".join(w for w in target.split() if "=" not in w).replace("`", "'")
        if len(command) > _TESTS_COMMAND_CHARS:
            command = command[: _TESTS_COMMAND_CHARS - 1] + "…"
        commands.append(f"`{command}`")
    listed = ", ".join(commands[:_RAN_LISTED])
    if len(commands) > _RAN_LISTED:
        listed += f" and {len(commands) - _RAN_LISTED} more"
    return RAN_OTHER_TEXT.format(commands=listed, programs=named)


# "I pulled / downloaded / installed <model ref>": a completed-pull claim,
# anchored on a MODEL REFERENCE token — never a bare noun, so "I installed the
# update" is ordinary chat and never fires. Backed only by a successful
# model_pull span whose `model` argument names that ref.
#
# A model reference, optionally machine-qualified: `qwen3:4b`, `user/name:tag`,
# `hf.co/org/repo[:quant]`, or any of those behind the name of the machine
# (the provider) that runs it — `hub:qwen3.8:27b`, `dell:qwen3:8b` (S40). The
# prefix is a SHAPE, never a list of names: machines are whatever the gateway
# lists, and a guard that knew them would be wrong the day one is added.
# Before S40 only `ollama:` was read, so `hub:qwen3.8:27b` was cut at its
# second colon and a claim about one tag was backed by a pull of another.
_ENGINE_PREFIX = r"[a-z0-9][a-z0-9_-]{0,31}:"
_MODEL_BODY = r"(?:hf\.co/[\w.-]+/[\w.-]+(?::[\w.-]+)?|[\w.-]+(?:/[\w.-]+)?:[\w.-]+)"
_ENGINE_QUALIFIED = re.compile(
    r"(?P<engine>[a-z0-9][a-z0-9_-]{0,31}):(?P<bare>" + _MODEL_BODY + r")", re.I
)
_PULLED_MODEL = re.compile(
    r"\bi(?:'ve|\s+have|\s+just|\s+have\s+just)?\s+(?:just\s+)?"
    r"(?:pulled|downloaded|installed)\s+(?:the\s+)?(?:model\s+)?"
    r"(?P<ref>(?:" + _ENGINE_PREFIX + r")?" + _MODEL_BODY + r")",
    re.I,
)
# "I removed / deleted / uninstalled <model ref>": the same anchor, backed
# only by a successful model_remove span naming that ref.
_REMOVED_MODEL = re.compile(
    r"\bi(?:'ve|\s+have|\s+just|\s+have\s+just)?\s+(?:just\s+)?"
    r"(?:removed|deleted|uninstalled)\s+(?:the\s+)?(?:model\s+)?"
    r"(?P<ref>(?:" + _ENGINE_PREFIX + r")?" + _MODEL_BODY + r")",
    re.I,
)
_MODEL_CLAIMS = frozenset({"pulled_model", "removed_model"})
# The span fact model_pull / model_remove record once the gateway CONFIRMED
# what they acted on: the machine-qualified id (`hub:qwen3:4b`), read off the
# catalogue row or the removal's verified answer (S40 fix wave A2). The raw
# argument is not that: `library:qwen3:4b` (a catalogue id) and
# `ollama:qwen3:4b` (the name before the rename) both resolve to the default
# machine, and reading their prefix as a machine contradicted a true report.
# Written by app/tools/models.py through ToolContext.facts_sink.
RESOLVED_MODEL_FACT = "resolved_model"

# "I switched chat models off on hub", "I turned off models for hub", "I
# stopped hub from running chat models", "I switched hub off for chat models",
# "I've switched eval_box off, so it no longer runs chat models", "I've
# stopped eval_box from serving chat" (S40): a completed change to a machine's
# serving switch. Anchored on a SERVING noun so "I switched the lights off"
# stays ordinary chat; backed only by a successful machine_configure span
# naming that machine. A clause that names no machine ("here", "this
# machine") still claims the kind, and any configure span backs it.
_MACHINE_SERVING = r"(?:(?:the|chat|local|ai)\s+){0,2}(?:models?|model\s+serving|serving|inference)"
_CONFIGURED_MACHINE = re.compile(
    r"\bi(?:['’]ve|\s+have|\s+just|\s+have\s+just)?\s+(?:just\s+)?(?:"
    + r"(?:switched|turned)\s+(?:off|on)\s+"
    + _MACHINE_SERVING
    + r"(?:\s+(?:on|for|at)\s+(?:the\s+)?(?P<m1>[\w.-]+))?"
    + r"|(?:switched|turned)\s+"
    + _MACHINE_SERVING
    + r"\s+(?:off|on)"
    + r"(?:\s+(?:on|for|at)\s+(?:the\s+)?(?P<m2>[\w.-]+))?"
    + r"|(?:switched|turned)\s+(?P<m3>[\w.-]+)['’]s\s+"
    + _MACHINE_SERVING
    + r"\s+(?:off|on)"
    + r"|(?:switched|turned)\s+(?:the\s+)?(?P<m4>[\w.-]+)\s+(?:off|on)\s+for\s+"
    + _MACHINE_SERVING
    + r"|stopped\s+(?:the\s+)?(?P<m5>[\w.-]+)\s+from\s+(?:running|serving)\s+(?:"
    + _MACHINE_SERVING
    + r"|chat\b)"
    # Ruling C9 (review m6): "switched eval_box off, so it no longer runs chat
    # models" — the serving noun trails the switch, within the same clause.
    + r"|(?:switched|turned)\s+(?:the\s+)?(?P<m6>[\w.-]+)\s+(?:off|on)\b[^.!?;]{0,40}?\b"
    + r"(?:no\s+longer\s+)?(?:runs?|running|serves?|serving)\s+"
    + _MACHINE_SERVING
    + r")",
    re.I,
)
_MACHINE_GROUPS = ("m1", "m2", "m3", "m4", "m5", "m6")
# Words that sit where a machine's name would and name none. A trailing
# phrase is where most of them come from: alternatives 1 and 2 take whatever
# token follows on/for/at, so "for the time being", "for a while", "at your
# request", "on your behalf" and "for tonight" put "time", "a", "your" and
# "tonight" in the name's place. A word here makes the claim name no machine
# (any configure span backs it) instead of naming one no span touched, which
# would correct a TRUE report after a real switch: the expensive failure
# (ruling S2d-R2; T6 review, fix round 1). Precision first: a real machine
# that happens to be called one of these is read as unnamed, never as a lie.
# A token of digits alone ("for 2 hours") is never a name either (_claims_in).
_NOT_A_MACHINE = frozenset(
    {
        # places, pronouns and "everything"
        "here",
        "there",
        "it",
        "this",
        "that",
        "these",
        "those",
        "them",
        "you",
        "me",
        "us",
        "him",
        "we",
        "they",
        "everyone",
        "now",
        "chat",
        "all",
        "every",
        "everything",
        # the kind of thing a machine is, not its name
        "machine",
        "computer",
        "box",
        "pc",
        "server",
        "host",
        "engine",
        # articles, quantifiers and numbers: a closed class
        "a",
        "an",
        "the",
        "some",
        "any",
        "each",
        "no",
        "both",
        "another",
        "one",
        "two",
        "three",
        "few",
        "several",
        "couple",
        "next",
        "last",
        "whole",
        "rest",
        # possessives: a closed class
        "my",
        "your",
        "our",
        "his",
        "her",
        "its",
        "their",
        "mine",
        "yours",
        "ours",
        "theirs",
        # time and duration
        "time",
        "while",
        "awhile",
        "moment",
        "today",
        "tonight",
        "tomorrow",
        "morning",
        "afternoon",
        "evening",
        "night",
        "day",
        "days",
        "week",
        "weekend",
        "hour",
        "hours",
        "minute",
        "minutes",
        "later",
        "once",
        "good",
        "session",
        # reasons and manner
        "request",
        "behalf",
        "purpose",
        "maintenance",
    }
)

# S42b: a claim that a machine's agent now runs the new build — "I updated
# minipc's agent", "I've updated the agent on eval_laptop", "I upgraded
# eval_laptop to the hub's build", "eval_laptop's agent is now updated".
# Backed ONLY by an update fact naming that machine with confirmed: true — the
# agent reconnected on the build — never by the send (P8, Review Focus 2; see
# _update_backed). The build has to be the HUB's ("to the hub's build"), so "I
# upgraded Firefox to the latest build" is not a claim.
#
# Linear (the #89 standard): a name token is entered only at its front and
# taken whole (`(?<![\w.-])[\w.-]++`), so a run of name characters is never
# re-entered at each of its positions, and every whitespace run is possessive.
_UPDATE_NAME = r"(?<![\w.-])[\w.-]++"
_UPDATE_DET = r"(?:(?:the|your|my)\s++)?"
_UPDATED_MACHINE = re.compile(
    r"\bi(?:['’]ve|\s++have)?+\s++(?:(?:just|also|now|successfully)\s++)?+"
    r"(?:updated|upgraded)\s++(?:"
    rf"{_UPDATE_DET}agents?\s++on\s++{_UPDATE_DET}(?P<u1>{_UPDATE_NAME})"
    rf"|{_UPDATE_DET}(?P<u2>{_UPDATE_NAME})['’]s\s++agent\b"
    rf"|{_UPDATE_DET}(?P<u3>{_UPDATE_NAME})\s++(?:to|onto)\s++(?:the\s++)?hub['’]s\s++"
    r"(?:(?:new|latest|current)\s++)?(?:build|version)\b)"
    rf"|(?P<u4>{_UPDATE_NAME})['’]s\s++agent\s++(?:is|has\s++been)\s++(?:now\s++)?"
    r"(?:updated|upgraded)\b",
    re.I,
)
# The claim's three forms, each backed its own way (fix round 1), all reported
# as kind "updated_machine" — the guard span's and the evals' word for it:
#   * her act on an agent — "I updated minipc's agent", "the agent on minipc"
#     (u1, u2): a confirmed update; naming no machine, also a successful
#     update of one of her specialist agents (_PERSONA_UPDATE_TOOLS);
#   * her act to the build — "I upgraded minipc to the hub's build" (u3): a
#     confirmed update;
#   * a STATE — "minipc's agent is updated" (u4): a confirmed update, or
#     machine_update's "current" (its agent last reported the hub's build).
_UPDATED_AGENT = "updated_machine"
_UPDATED_TO_BUILD = "updated_machine/build"
_AGENT_IS_UPDATED = "updated_machine/state"
# The RESULT an update leaves, said three more ways (Task 32, the MF4 gap — see
# _UPDATE_TOOK): her install of the build, an act; the build installed there or
# the update done, a state read only beside this turn's update of that machine;
# and the build it runs, a state read beside any update fact for it.
_INSTALLED_BUILD = "updated_machine/installed"
_UPDATE_TOOK_STATE = "updated_machine/took"
_ON_THE_BUILD = "updated_machine/on_build"
_UPDATED_FORMS = {"u1": _UPDATED_AGENT, "u2": _UPDATED_AGENT, "u3": _UPDATED_TO_BUILD}
_UPDATE_KINDS = frozenset(
    {
        _UPDATED_AGENT,
        _UPDATED_TO_BUILD,
        _AGENT_IS_UPDATED,
        _INSTALLED_BUILD,
        _UPDATE_TOOK_STATE,
        _ON_THE_BUILD,
    }
)
# The forms that state what an agent RUNS — a confirmed update backs them, and so
# does "current": its agent last reported the hub's build (fix round 1, I3).
_UPDATE_STATES = frozenset({_AGENT_IS_UPDATED, _UPDATE_TOOK_STATE, _ON_THE_BUILD})
_UPDATED_GROUPS = ("u1", "u2", "u3", "u4")
# Words that sit where an updated machine's name would and name none: the
# switch's set (_NOT_A_MACHINE), plus Nova and her agent's own name, the
# trailing nouns of "on schedule" / "on demand", the claim's own noun ("I
# upgraded the agent to the hub's build", "your agents" — fix round 1, I1), and
# "hub": a role word like "server" and "host" — D8 reserves it, so no machine is
# named hub, and "the hub's agent" names no machine (fix round 1, I2). Read
# before the paired names (_MachineNames), so no paired machine makes one a name.
_NOT_AN_UPDATED_MACHINE = _NOT_A_MACHINE | frozenset(
    {"nova", "novad", "schedule", "demand", "agent", "agents", "hub"}
)
# An update placed at an EARLIER time is a recap, not this turn's act: the
# family's _PRIOR_TIME (earlier, yesterday, last time, … ago) plus the time
# words a recap of an update uses — "this morning", "on Monday", "in our last
# chat", and a bare "before". Precision first: "I updated minipc's agent before
# eval_laptop's" is read as a recap too, and goes uncorrected.
_UPDATE_RECAP = re.compile(
    r"\b(?:before|today|tonight|this\s++(?:morning|afternoon|evening|week)"
    r"|on\s++(?:mon|tues|wednes|thurs|fri|satur|sun)day"
    r"|in\s++our\s++(?:last|previous|earlier)\s++(?:chat|conversation|session|talk))\b",
    re.I,
)
# A machine's name, word by word ("DELL-XPS-8950" -> dell, xps, 8950): a reply
# that calls a machine by a word of its own name names it (_MachineNames).
_NAME_WORD = re.compile(r"[a-z0-9]++")

# Task 32 (Phase B round 2), the MF4 gap: the RESULT of an update, as a claim.
#
# Since MF4, a machine_update on minipc backs an install claim about minipc for
# device_completion, whatever it answered — a send too — because whether the
# install TOOK is this family's question, never that guard's. But this family
# read only "I updated / upgraded …" and "…'s agent is updated", so "I installed
# the new build on minipc" beside a SENT update was corrected by neither guard.
# Three more ways she says an update took, each about a machine she NAMES:
#
#   * her install of the build — "I installed the new build on minipc", "I've
#     installed the hub's build on minipc" (i1): her act, backed only by a
#     confirmed update, as "I upgraded minipc to the hub's build" is;
#   * the build installed there — "the new build has been installed on minipc"
#     (i2) — and the update done — "the update is complete on minipc", "the
#     update on minipc is done", "minipc's update is finished" (c1-c4): states;
#   * the build it runs — "minipc is now on the hub's build", "minipc's agent is
#     running the new build", "the agent on minipc is on the hub's build"
#     (s1-s4): a state. A state is backed by a confirmed update or by "current".
#
# Read only where the record makes them update claims (_update_read), so the
# correction contradicts what the record shows, never a sentence it cannot
# place: an install and an update done only beside THIS turn's update of that
# machine — without one, an install is device_completion's claim ("(No
# machine_update or device_run call ran on minipc this turn.)", one true
# sentence, never two), and "the update" may be apt's or Windows'; the build it
# runs beside any update fact this turn holds for that machine — device_list
# states an agent's build and records no update fact, so a build it showed is
# never contradicted here. A form that names no machine is not read: "the new
# build" and "the update" are anyone's. Which words around one make it no claim
# at all is _TookCuts'.
#
# Linear as _UPDATED_MACHINE is: each name slot is entered only at the front of
# its token and taken whole, every other alternative opens on a fixed word, and
# every whitespace run is possessive.
_ANY_BUILD = (
    r"the\s++(?:hub['’]s\s++(?:(?:new|latest|current)\s++)?+(?:agent\s++)?+(?:build|version)"
    r"|(?:(?:new|latest)\s++)?+(?:agent\s++)?+build)\b(?!\s++(?:of|for)\b)"
)
# The build a machine itself is said to run is the HUB's: "minipc is on the new
# build" is anyone's software, "minipc's agent is on the new build" is not.
_HUB_BUILD = (
    r"the\s++hub['’]s\s++(?:(?:new|latest|current)\s++)?+(?:agent\s++)?+(?:build|version)\b"
    r"(?!\s++(?:of|for)\b)"
)
_TOOK_IS = r"(?:\s++(?:is|has\s++been)|['’]s)"
# Done, never done DOING something: "the update is done downloading" is a step.
_TOOK_DONE = r"(?:done|complete|completed|finished)\b(?![ \t]++\w+ing\b)"
_UPDATE_TOOK = re.compile(
    r"\bi(?:['’]ve|\s++have)?+\s++(?:(?:just|also|now|successfully)\s++)?+installed\s++"
    rf"(?:{_ANY_BUILD}|the\s++update\b)\s++(?:on|onto|to)\s++{_UPDATE_DET}(?P<i1>{_UPDATE_NAME})"
    rf"|\b(?:{_ANY_BUILD}|the\s++update\b)\s++(?:is|has\s++been)\s++"
    rf"(?:(?:now|successfully)\s++)?+installed\s++(?:on|onto)\s++{_UPDATE_DET}"
    rf"(?P<i2>{_UPDATE_NAME})"
    rf"|\bthe\s++update{_TOOK_IS}\s++(?:now\s++)?+{_TOOK_DONE}\s++on\s++{_UPDATE_DET}"
    rf"(?P<c1>{_UPDATE_NAME})"
    rf"|\bthe\s++update\s++(?:on|to|of|for)\s++{_UPDATE_DET}(?P<c2>{_UPDATE_NAME}){_TOOK_IS}"
    rf"\s++(?:now\s++)?+{_TOOK_DONE}"
    rf"|{_UPDATE_DET}(?P<c3>{_UPDATE_NAME})['’]s\s++update{_TOOK_IS}\s++(?:now\s++)?+{_TOOK_DONE}"
    rf"|\bthe\s++update\s++(?:has\s++)?+(?:completed|finished)\s++on\s++{_UPDATE_DET}"
    rf"(?P<c4>{_UPDATE_NAME})"
    rf"|{_UPDATE_DET}(?P<s1>{_UPDATE_NAME})['’]s\s++agent(?:\s++is|['’]s)\s++(?:now\s++)?+"
    rf"(?:on|running)\s++{_ANY_BUILD}"
    rf"|\b(?:the\s++)?+agent\s++on\s++{_UPDATE_DET}(?P<s2>{_UPDATE_NAME})(?:\s++is|['’]s)"
    rf"\s++(?:now\s++)?+(?:on|running)\s++{_ANY_BUILD}"
    rf"|{_UPDATE_DET}(?P<s3>{_UPDATE_NAME})(?:\s++is|['’]s)\s++(?:now\s++)?+(?:on|running)"
    rf"\s++{_HUB_BUILD}"
    rf"|{_UPDATE_DET}(?P<s4>{_UPDATE_NAME})(?:['’]s\s++agent)?+\s++now\s++runs\s++{_HUB_BUILD}",
    re.I,
)
_TOOK_FORMS = {
    "i1": _INSTALLED_BUILD,
    "i2": _UPDATE_TOOK_STATE,
    "c1": _UPDATE_TOOK_STATE,
    "c2": _UPDATE_TOOK_STATE,
    "c3": _UPDATE_TOOK_STATE,
    "c4": _UPDATE_TOOK_STATE,
    "s1": _ON_THE_BUILD,
    "s2": _ON_THE_BUILD,
    "s3": _ON_THE_BUILD,
    "s4": _ON_THE_BUILD,
}
_TOOK_GROUPS = tuple(_TOOK_FORMS)


class _TookCuts:
    """What, around one of an update's RESULT claims (_UPDATE_TOOK) in a
    sentence, makes it no claim — read over the whole SENTENCE, never one of
    the family's clauses: the family splits a sentence at "yet" and "then" to
    bound a negation's reach, and that cut "There's no sign yet | that minipc
    is on the hub's build" and "If it reconnects, then | the update is
    complete on minipc" off the very words that make each no claim. So:

      * in the claim's own clause (the family's), its rules: a recap of an
        earlier time, an act that is someone else's (_externally_attributed),
        or a hedge or subordinator before it ("once it reconnects, minipc is
        on the hub's build");
      * in its own segment — between the said-not-done pair's breaks
        (_ANCHOR_BREAK), so "No problem — the update is complete on minipc"
        is still one — a negation, hedge, intent or condition before it ("I
        can't say minipc is on the hub's build yet", "I'll confirm the update
        is complete on minipc", "as soon as minipc is running the hub's
        build"), or a condition after it ("minipc is on the hub's build once
        it reconnects").

    A condition that OPENS the sentence governs all of it, as in the pair's
    device guard; narration's sentence loop reads that (_results_in). Each cut
    is found ONCE per sentence and compared by position (bisect), so a
    sentence of many claims costs one pass; a clause's own rules are read
    once, for a clause that holds a claim."""

    __slots__ = (
        "_sentence",
        "_clause_starts",
        "_clause_ends",
        "_clause_no_claim",
        "_hedges",
        "_break_starts",
        "_break_ends",
        "_before",
        "_conditions",
    )

    def __init__(self, sentence: str) -> None:
        self._sentence = sentence
        splits = list(_CLAUSE_SPLIT.finditer(sentence))
        self._clause_starts = [0, *(found.end() for found in splits)]
        self._clause_ends = [*(found.start() for found in splits), len(sentence)]
        self._clause_no_claim: dict[int, bool] = {}
        self._hedges = [found.start() for found in _STATE_HEDGE.finditer(sentence)]
        breaks = list(_ANCHOR_BREAK.finditer(sentence))
        self._break_starts = [found.start() for found in breaks]
        self._break_ends = [found.end() for found in breaks]
        self._before = sorted(
            found.start()
            for pattern in (_ACTION_NEGATION, _ACTION_HEDGE, _ACTION_INTENT, _ACTION_CONDITION)
            for found in pattern.finditer(sentence)
        )
        self._conditions = [found.start() for found in _ACTION_CONDITION.finditer(sentence)]

    def cut(self, start: int, end: int) -> bool:
        clause = bisect_right(self._clause_starts, start) - 1
        if clause not in self._clause_no_claim:
            text = self._sentence[self._clause_starts[clause] : self._clause_ends[clause]]
            self._clause_no_claim[clause] = (
                _externally_attributed(text) or _UPDATE_RECAP.search(text) is not None
            )
        if self._clause_no_claim[clause]:
            return True
        at = bisect_left(self._hedges, self._clause_starts[clause])
        if at < len(self._hedges) and self._hedges[at] < start:
            return True
        at = bisect_right(self._break_ends, start)
        segment_start = self._break_ends[at - 1] if at else 0
        at = bisect_left(self._break_starts, end)
        segment_end = (
            self._break_starts[at] if at < len(self._break_starts) else len(self._sentence)
        )
        at = bisect_left(self._before, segment_start)
        if at < len(self._before) and self._before[at] < start:
            return True
        at = bisect_left(self._conditions, end)
        return at < len(self._conditions) and self._conditions[at] < segment_end


class _MachineNames:
    """Machines' names, read by the said-not-done lane's rule for a device's
    name: a word a reply used names a machine when it is that machine's own
    name, any case, or — three characters or longer — one word of it ("your
    Dell" for DELL-XPS-8950). A true reply is never corrected for calling a
    machine what its owner calls it.

    Indexed ONCE per reply (Task 23 fix round 2, N3), so reading a word is one
    dict lookup however many machines there are: walking every name for every
    claim took 64-94 ms on a 6,000-character reply beside 500 paired names,
    synchronously in core's event loop."""

    __slots__ = ("_names", "_named")

    def __init__(self, names: Iterable[str] = ()) -> None:
        self._names = list(dict.fromkeys(n for n in (str(name).strip() for name in names) if n))
        # Each word that names a machine -> (how many it names, the first):
        # each machine counted once per word, by its whole name and by each
        # word of it three characters or longer.
        self._named: dict[str, tuple[int, int]] = {}
        for i, name in enumerate(self._names):
            low = name.lower()
            for word in {low, *(w for w in _NAME_WORD.findall(low) if len(w) >= 3)}:
                count, first = self._named.get(word, (0, i))
                self._named[word] = (count + 1, first)

    def names_any(self, said: str) -> bool:
        """Does `said` name any of these machines?"""
        return said.strip().lower() in self._named

    def machine(self, said: str) -> str | None:
        """The machine `said` names: the one machine's own name when it names
        exactly one, the word as written when it names several ("eval" for
        eval_laptop and eval_pc), and None when it names none — read against
        the LIVE paired names, "the mini PC" (the machine is minipc), "the
        Windows machine", "your desktop", "WSL" and "coder" name no machine at
        all (fix round 1, I2)."""
        named = self._named.get(said.strip().lower())
        if named is None:
            return None
        count, first = named
        return self._names[first] if count == 1 else said


_NO_MACHINES = _MachineNames()


class _UpdateNames:
    """The words one reply's update claims can name a machine by: a paired
    machine's name or a word of one (fix round 1, I2) — and, where those name
    nothing, a machine this turn's update facts name (Task 32, L510).

    The paired names are read live, and a read that blips arrives EMPTY (chat
    fails open), as does a replay that declares no device: then every claim
    named no machine, and so needed this turn's own update to be backed — a
    true "eval_laptop's agent has been updated" after machine_status showed its
    confirmed row was corrected. A word only ever names a machine the record
    itself names, so "the mini PC", "WSL" and "coder" still name none (I2).

    The record is read once per reply, on the first claim that needs it (N3)."""

    __slots__ = ("_paired", "_successful", "_record")

    def __init__(self, paired: _MachineNames, successful: Sequence[Any]) -> None:
        self._paired = paired
        self._successful = successful
        self._record: _UpdateRecord | None = None

    def record(self) -> _UpdateRecord:
        if self._record is None:
            self._record = _update_record(self._successful)
        return self._record

    def machine(self, said: str) -> str | None:
        return self._paired.machine(said) or self.record().stated.machine(said)


def _update_target(said: str, names: _MachineNames | _UpdateNames) -> str | None:
    """The machine an update claim's name slot names, or None when it names
    none: a role word, a pronoun, a number (_NOT_AN_UPDATED_MACHINE), or a word
    no machine goes by. Read without the sentence's punctuation against the
    word — at its end ("minipc."), and, when the word as written names nothing,
    at its front: a list's "-" with no space after it, or an ellipsis's dots
    (Task 32, L492c). Kept there, "-eval_laptop's agent is updated." named no
    machine, and its true claim needed this turn's own update to be backed."""
    said = _strip_trailing_punct(said)
    bare = said.lstrip(".-")
    if not bare or bare.lower() in _NOT_AN_UPDATED_MACHINE or bare.isdigit():
        return None
    return names.machine(said) or (names.machine(bare) if bare != said else None)


# S47: a claim that a setup QR card is on the screen. Backed only by a
# successful show_setup_qr span this turn — "here's a QR code" with no card
# sent is the narration lie in its newest shape.
#
# I5 (review fix round 1): the deictic "scan the QR code above/below/on
# screen" alternative is DROPPED entirely — that is her reading what is on
# the screen (a Tailscale sign-in QR, someone else's instructions), never a
# claim of her OWN that she sent a card. "here's ..." no longer accepts "the"
# as a determiner ("here's THE pairing code format" names a format, not a
# card); "a"/"your" stay.
_SHOWED_SETUP_QR = re.compile(
    r"\bhere(?:'s|’s|\s+is)\s+(?:a|your)\s+(?:qr|setup|pairing)\s+(?:code|card)\b"
    r"|\bi(?:'ve|’ve|\s+have)?\s+(?:sent|put|shown|posted|added|shared|displayed|generated|made|created)\s+"
    r"(?:you\s+)?(?:a|the)\s+(?:qr|setup|pairing)\s+(?:code|card)\b",
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
    {
        "fetched", "retrieved", "downloaded", "visited", "accessed", "read", "pulled",
        "looked",
        # S38: what her browser does to an address.
        "opened", "navigated",
    }
)  # fmt: skip
# S38 (ruling G9): the two verbs her browser added. A delegation that ran
# this turn backs a claim made with one of them — the agent's calls are on
# ITS turn (_a_delegation_ran), so "I opened <url> through my browser agent"
# is not a fabrication. The older verbs' same gap is a carry, unchanged here.
_BROWSER_FETCH_VERBS = frozenset({"opened", "navigated"})
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
# Where a filename found INSIDE text can start: the front of a [\w./-] run,
# past any leading "./", "../" or "-" (which \b skipped too) — never at a later
# dot, dash or slash inside the run. \b allowed every one, and from each the
# greedy run walked to the token's end and back, so a long dotted or dashed
# token was quadratic: narration_check took 684 ms at 3,000 characters of "a."
# (S42b Task 23's measurement), on core's one event loop. Any end a later start
# can reach, the front reaches too, so the leftmost match is exactly what it
# was. The filename is group 1; the leading punctuation is not part of it. The
# pre-fix patterns are the oracle in tests/test_guard_regex_timing.py.
# `_FILENAME` itself stays for .match/.fullmatch on one token, which are
# anchored and so linear.
_FILE_RUN_FRONT = r"(?<![\w./-])[./-]*+"
_FILENAME_IN = re.compile(_FILE_RUN_FRONT + r"(" + _FILENAME_RE + r")\b", re.I)
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
    _FILE_RUN_FRONT + r"(" + _FILENAME_RE + r")\b\s+(?:now\s+|currently\s+)?"
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
    _FILE_RUN_FRONT
    + r"("
    + _FILENAME_RE
    + r")\b\s+(?:has|have|had|was|were|is|are)\s+(?:been\s+|now\s+)?"
    r"(?P<verb>created|written|saved|updated|appended|added"
    r"|read|opened|reviewed|checked|examined"
    r"|deleted|removed|erased)\b",
    re.I,
)
_PASSIVE_READ_VERBS = frozenset({"read", "opened", "reviewed", "checked", "examined"})
_PASSIVE_DELETE_VERBS = frozenset({"deleted", "removed", "erased"})

# Completed ACTIVE verbs, as whole tokens (the token scan lower-cases and looks
# them up). Future/hedged forms use the base verb ("I'll create", "I can save")
# and so never appear here — the verb form alone filters most hedging.
_WRITE_VERB_TOKENS = frozenset(
    {"created", "wrote", "written", "saved", "updated", "appended", "added"}
)
_READ_VERB_TOKENS = frozenset({"read", "checked", "reviewed", "opened", "examined"})
# S16: a deletion is an action like any other, and it goes in the shared set so
# every boundary scan below treats "deleted" as a verb rather than as a word an
# object can run through. "removed" is here and in the model-removal pattern —
# which one fires is decided by the object, exactly as "read" is split between
# a file and a URL: a model reference carries a tag, a filename an extension.
_DELETE_VERB_TOKENS = frozenset({"deleted", "removed", "erased"})
# S29a T5: an edit names a file she changed — "I edited / modified / patched /
# changed chat.py". Its own kind (edited_file), backed only by a write of that
# name (_edited_file_backed). In the shared set so every boundary scan treats
# "edited" as a verb: "I read notes.md and edited todo.md" ends read's object
# walk at it. Delegation keeps its pre-T5 verbs (_DELEGATION_VERBS).
_EDIT_VERB_TOKENS = frozenset({"edited", "modified", "patched", "changed"})
_ACTION_VERB_TOKENS = (
    _WRITE_VERB_TOKENS | _READ_VERB_TOKENS | _DELETE_VERB_TOKENS | _EDIT_VERB_TOKENS
)
# S38: a completed action on a page. A verb alone is not enough — "I typed
# it up" is not a page — so the claim needs a page-control noun LATER in the
# same clause, and which nouns count depends on the verb (ruling G2):
#   * clicked/tapped/pressed/submitted say "a page" with a link, a button or
#     a form — nobody clicks a link that is not on a screen.
#   * selected/chose/filled/typed/ticked are ordinary words ("I selected the
#     three most relevant links", "I filled in the form fields in form.md",
#     "I typed up the form letter"), so they count only with a noun that names
#     a page control and nothing else (checkbox, dropdown, textbox, searchbox,
#     button) — or, once one of her browser_* tools ran this turn (she is on a
#     page), with a field or a form too ("the search field" is one there).
#     Never with a link: "I selected the links that looked most authoritative"
#     is how she reports what she read, on a page or off it.
# Not "box" (a machine), "tab" or "menu" (her own UI words), "option" (a model
# choice is not a page).
_BROWSER_CLICK_VERB_TOKENS = frozenset({"clicked", "tapped", "pressed", "submitted"})
_BROWSER_CHOICE_VERB_TOKENS = frozenset({"selected", "chose", "filled", "typed", "ticked"})
_BROWSER_CONTROL_TOKENS = frozenset(
    {
        "checkbox", "checkboxes", "dropdown", "dropdowns", "textbox", "textboxes",
        "searchbox", "searchboxes", "button", "buttons",
    }
)  # fmt: skip
_BROWSER_CLICK_OBJECT_TOKENS = _BROWSER_CONTROL_TOKENS | frozenset(
    {"link", "links", "form", "forms"}
)
_BROWSER_PAGE_FIELD_TOKENS = frozenset({"field", "fields", "form", "forms"})
# A clause that recaps an earlier turn is history, not this turn's claim;
# one that opens with a condition ("if I clicked…") claims nothing.
_BROWSER_RECAP_TOKENS = frozenset({"earlier", "before", "yesterday", "previously", "last"})
_BROWSER_HYPOTHETICAL_TOKENS = frozenset({"if", "when", "once", "unless", "whether", "until"})
# Of those, the words that are as often TEMPORAL in her past-tense narration
# ("once the page loaded I clicked Submit"): they cut the page-control nouns
# only when what follows them is about him or the future — "you", or a modal
# (merge review round 2, 2026-10-07). "if", "unless" and "whether" always cut.
_BROWSER_TEMPORAL_CONDITION_TOKENS = frozenset({"when", "once", "until"})
_BROWSER_HYPOTHETICAL_MARKERS = frozenset(
    {"you", "you're", "your", "would", "will", "could", "should", "might", "can"}
)
# S38 (ruling G2, spec §4's "or downloaded"): "I downloaded <file>" — a real
# filename token as the verb's own object (_objects_of, the file claims' rule)
# — is backed only by a download her browser brought into the workspace this
# turn: a {"browser": "download"} fact on ANY browser_* span, ok or not (a
# download that finishes late lands on the NEXT call's answer, and a call that
# then fails still brought it in — tools/browser.py _bring_downloads, _fail).
_BROWSER_DOWNLOAD_VERB = "downloaded"
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
# Possessive, and each whitespace run may only be entered at its front
# (S40b fix-wave follow-up, D2): `\s+<word>` re-entered a run of padding at
# every one of its n positions and backtracked the whole tail at each — 56 ms
# at 1,500 characters. A connector is a word, so the run always had to be
# swallowed whole; entering it later can match nothing entering it at the
# front cannot.
_CLAUSE_SPLIT = re.compile(
    r";|(?<!\s)\s++(?:but|however|though|although|whereas|yet)\s++"
    r"|,?(?<!\s)\s++then\s++",
    re.I,
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
            # Past the whole run either way: every position inside it would
            # find this same `end` and this same `following`, so none of them
            # can split. Resuming inside the run re-scanned it from each of
            # its positions — quadratic on a long one (20,000 dots took 15 s,
            # and device_completion_check runs this on every reply).
            i = end
        i += 1
    if start < n:
        out.append(text[start:])
    return out


def _split_clauses(sentence: str):
    """(clause, rest) for each clause of one sentence, split as _clauses
    splits it: `rest` is the sentence after the clause, separator included —
    where she retracts or reaffirms what the clause said."""
    start = 0
    cuts = [(sep.start(), sep.end()) for sep in _CLAUSE_SPLIT.finditer(sentence)]
    for end, resume in [*cuts, (len(sentence), len(sentence))]:
        yield sentence[start:end], sentence[end:]
        start = resume


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


def _names_a_file(token: str) -> bool:
    """A token shaped like a file name with ANY short extension — "theme.css",
    "form.html", "labels.md" — for the page-action claim's coding cut (S38 fix
    round 1, M1). Wider than _FILENAME on purpose: it only ever SILENCES a
    claim, so a stray "e.g." costs a miss, never a false correction. An
    address is not a file. String methods only, one pass."""
    token = _strip_trailing_punct(token)
    if "://" in token:
        return False
    stem, dot, ext = token.rpartition(".")
    return bool(dot and stem and ext.isalpha() and len(ext) <= 5) and (
        stem[-1].isalnum() or stem[-1] in "_-"
    )


def _claims_in(
    clause: str,
    names: _MachineNames | _UpdateNames = _NO_MACHINES,
    on_a_page: bool = False,
) -> list[tuple[str, str | None, str]]:
    """Every completed-action self-claim in one clause, each tied to a REAL
    target (a filename token or a URL). A bare noun never qualifies, an action
    attributed to someone else or another time never qualifies, and a filename
    that is not the verb's own object never qualifies. `names` are the words an
    update claim's machine can be: the paired machines' (S42b), else the
    record's (_UpdateNames).

    `on_a_page` (S38, ruling G2): one of her browser_* tools ran this turn, so
    a choice verb with any page-control noun ("I typed it into the search
    field") is read as an action on a page; without it only an unambiguous
    control noun is."""
    claims: list[tuple[str, str | None, str]] = []
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
        if low in _WRITE_VERB_TOKENS:
            kind = "wrote_file"
        elif low in _EDIT_VERB_TOKENS:
            kind = "edited_file"
        elif low in _DELETE_VERB_TOKENS:
            kind = "deleted_file"
        else:
            kind = "read_file"
        for name in _objects_of(tokens, vi):
            claims.append((kind, name, tok))

    # fetched a URL — I + fetch verb + an explicit http(s) token in the clause.
    # Trailing sentence punctuation is trimmed so a backed fetch's target
    # matches the span's clean URL ("…/data." -> "…/data").
    urls = [_strip_trailing_punct(m.group(0)) for m in _URL.finditer(clause)]
    if urls:
        # The claim's verb is the clause's first OLDER fetch verb when it has
        # one (merge review round 2): "I opened and read <url>" is a read,
        # which the exemptions for the browser's two verbs must never skip.
        browser_tok = None
        for vi, tok in enumerate(tokens):
            if tok.lower() in _FETCH_VERB_TOKENS and _first_person_subject(tokens, vi):
                if tok.lower() not in _BROWSER_FETCH_VERBS:
                    claims.append(("fetched_url", urls[0], tok))
                    break
                if browser_tok is None:
                    browser_tok = tok
        else:
            if browser_tok is not None:
                claims.append(("fetched_url", urls[0], browser_tok))

    # S38: an action on a page — I + clicked/typed/submitted… + a page-control
    # noun later in the clause (which nouns: the verb's own set, ruling G2).
    # Target-free: which element is not checkable from prose, so any ok
    # browser_act this turn backs it. One pass: each noun set's LAST position
    # is found once, never searched again per verb. Tokens keep their
    # punctuation ("button."), so it is trimmed here.
    lowered = [tok.lower().rstrip(".,;:!?)]}\"'") for tok in tokens]
    if not _BROWSER_RECAP_TOKENS.intersection(lowered):
        click_objects = _BROWSER_CLICK_OBJECT_TOKENS
        choice_objects = _BROWSER_CONTROL_TOKENS
        if on_a_page:
            click_objects = click_objects | _BROWSER_PAGE_FIELD_TOKENS
            choice_objects = choice_objects | _BROWSER_PAGE_FIELD_TOKENS
        # The nouns are read only up to the first condition word: one inside a
        # later conditional ("I typed up the cover letter, so when you click
        # the button it sends") is about what HE may do, and must not anchor
        # the verb before it (merge review, 2026-10-07).
        # A temporal word cuts only when a "you" or a modal follows it in the
        # clause: the LAST such marker is found once, so the cut stays one pass.
        last_marker = -1
        for i, low in enumerate(lowered):
            if low in _BROWSER_HYPOTHETICAL_MARKERS or low.endswith("'ll"):
                last_marker = i
        last_click_object = last_choice_object = -1
        first_condition = len(lowered)
        for i, low in enumerate(lowered):
            if low in _BROWSER_HYPOTHETICAL_TOKENS and (
                low not in _BROWSER_TEMPORAL_CONDITION_TOKENS or last_marker > i
            ):
                first_condition = i
                break
            if low in click_objects:
                last_click_object = i
            if low in choice_objects:
                last_choice_object = i
        for vi, low in enumerate(lowered):
            if vi > first_condition or vi >= max(last_click_object, last_choice_object):
                break
            if low in _BROWSER_CLICK_VERB_TOKENS:
                last_object = last_click_object
            elif low in _BROWSER_CHOICE_VERB_TOKENS:
                last_object = last_choice_object
            else:
                continue
            if vi < last_object and _first_person_subject(tokens, vi):
                # Fix round 1 (M1): off a page, a CHOICE verb in a clause that
                # names a file is a coding reply ("I chose a blue button style
                # in theme.css"). A click verb keeps its claim: nobody clicks
                # a button in a file. Read once, only here: the loop ends.
                if (
                    on_a_page
                    or low in _BROWSER_CLICK_VERB_TOKENS
                    or not any(_names_a_file(tok) for tok in tokens)
                ):
                    claims.append(("browser_acted", None, tokens[vi]))
                break

    # S38 (ruling G2): downloaded a FILE — I + downloaded + a filename token as
    # the verb's own object. A URL in the clause is the fetch claim above, and
    # a model reference is the pulled-model claim below; neither is a filename.
    for vi, low in enumerate(lowered):
        if low == _BROWSER_DOWNLOAD_VERB and _first_person_subject(tokens, vi):
            files = _objects_of(tokens, vi)
            if files:
                claims.append(("browser_downloaded", files[0], tokens[vi]))
                break

    # passive voice: "<file> has been updated / was read", filename-as-subject.
    for pm in _PASSIVE_CLAIM.finditer(clause):
        verb = pm.group("verb").lower()
        if verb in _PASSIVE_READ_VERBS:
            kind = "read_file"
        elif verb in _PASSIVE_DELETE_VERBS:
            kind = "deleted_file"
        else:
            kind = "wrote_file"
        # The phrase runs from the filename, not from any "./" before it.
        claims.append((kind, pm.group(1), clause[pm.start(1) : pm.end()]))

    # content DUMP: "<file> contains the following / says:", filename-as-subject.
    for cm in _CONTENT_CLAIM.finditer(clause):
        claims.append(("file_contents", cm.group(1), clause[cm.start(1) : cm.end()]))

    # a spend figure with no ledger read behind it (target: the clause).
    sm = _STATED_SPEND.search(clause)
    if sm is not None:
        claims.append(("stated_spend", None, sm.group(0)))

    # pulled a model: I + pulled/downloaded/installed + a model reference.
    for pm in _PULLED_MODEL.finditer(clause):
        claims.append(("pulled_model", _strip_trailing_punct(pm.group("ref")), pm.group(0)))
    for rm in _REMOVED_MODEL.finditer(clause):
        claims.append(("removed_model", _strip_trailing_punct(rm.group("ref")), rm.group(0)))

    # changed a machine's serving switch (S40): the machine when one is named.
    for cm in _CONFIGURED_MACHINE.finditer(clause):
        named = next((cm.group(g) for g in _MACHINE_GROUPS if cm.group(g)), None)
        named = _strip_trailing_punct(named) if named else None
        if named and (named.lower() in _NOT_A_MACHINE or named.isdigit()):
            named = None
        claims.append(("configured_machine", named, cm.group(0)))

    # an agent updated (S42b): the paired machine when one is named, and the
    # claim's form (_UPDATED_FORMS). A recap of an earlier time anywhere in the
    # clause, or a hedge or condition BEFORE the claim ("if I updated…",
    # "once…"), says nothing about this turn's act. Each cut is found once per
    # clause and compared by position — and only in a clause that makes one.
    updated = list(_UPDATED_MACHINE.finditer(clause))
    if updated and _UPDATE_RECAP.search(clause) is None:
        hedge = _STATE_HEDGE.search(clause)
        for um in updated:
            if hedge is not None and hedge.start() < um.start():
                continue
            group = next((g for g in _UPDATED_GROUPS if um.group(g)), "u4")
            target = _update_target(um.group(group) or "", names)
            claims.append((_UPDATED_FORMS.get(group, _AGENT_IS_UPDATED), target, um.group(0)))

    # showed a setup QR card (S47): no target; any successful card backs it.
    for qm in _SHOWED_SETUP_QR.finditer(clause):
        claims.append(("showed_setup_qr", None, qm.group(0)))

    # the tests passed (S29a T3): no target; a passing test-runner run backs it.
    claims += _tests_passed_claims(clause)

    return claims


def _results_in(sentence: str, names: _MachineNames | _UpdateNames) -> list[tuple[str, str, str]]:
    """The RESULT of an update claimed in one non-question sentence (Task 32,
    the MF4 gap; _UPDATE_TOOK): only about a machine she names, and only
    where nothing around it makes it no claim — a condition opening the
    sentence, or a cut in its clause or its segment (_TookCuts)."""
    took = list(_UPDATE_TOOK.finditer(sentence))
    if not took or _FRONTED_CONDITION.match(sentence):
        return []
    cuts = _TookCuts(sentence)
    claims: list[tuple[str, str, str]] = []
    for tm in took:
        if cuts.cut(tm.start(), tm.end()):
            continue
        group = next(g for g in _TOOK_GROUPS if tm.group(g))
        target = _update_target(tm.group(group), names)
        if target is not None:
            claims.append((_TOOK_FORMS[group], target, tm.group(0)))
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
    meta = getattr(span, "meta", None) or {}
    if span.name in ("model_pull", "model_remove"):
        # What the tool resolved and confirmed outranks what it was handed.
        for fact in meta.get("facts") or ():
            resolved = fact.get(RESOLVED_MODEL_FACT) if isinstance(fact, dict) else None
            if isinstance(resolved, str) and resolved:
                return resolved
    args = meta.get("args_redacted")
    if not isinstance(args, dict):
        return None
    if span.name in ("workspace_write_file", "workspace_read_file", "workspace_delete"):
        path = args.get("path")
        return path if isinstance(path, str) else None
    if span.name == "fetch_url":
        url = args.get("url")
        return url if isinstance(url, str) else None
    if span.name in ("browser_open", "browser_read", "browser_back"):
        # S38: the address she asked for AND every page the call landed on
        # (its `browser` page facts) — a redirect lands somewhere else, and
        # both are true things to say she opened. Joined, because _backed
        # reads one target per span by substring.
        seen = [args.get("url")] + [
            fact.get("url")
            for fact in meta.get("facts") or ()
            if isinstance(fact, dict) and fact.get("browser") == "page"
        ]
        urls = [url for url in seen if isinstance(url, str) and url]
        return " ".join(urls) or None
    if span.name == "browser_act":
        # S38 fix round 1 (I2): only the page a click LANDED on. An act with no
        # page fact reached no page this guard can name, so its target is ""
        # — never None, which would back a fetch claim of ANY address.
        return " ".join(
            fact["url"]
            for fact in meta.get("facts") or ()
            if isinstance(fact, dict)
            and fact.get("browser") == "page"
            and isinstance(fact.get("url"), str)
            and fact["url"]
        )
    if span.name in ("device_read_file", "device_write_file"):
        # S29a T2: the path the AGENT confirmed — the span's `file` fact
        # target, the checked/normalized path (T1) — before the argument, so a
        # claim is matched against what was read or written, not what was
        # asked for. An ok span with no file fact falls back to the argument.
        for fact in meta.get("facts") or ():
            if isinstance(fact, dict) and isinstance(fact.get("file"), dict):
                target = fact.get("target")
                if isinstance(target, str) and target:
                    return target
        path = args.get("path")
        return path if isinstance(path, str) else None
    if span.name in ("model_pull", "model_remove", "model_check_update"):
        model = args.get("model")
        return model if isinstance(model, str) else None
    if span.name == "machine_configure":
        machine = args.get("machine")
        return machine if isinstance(machine, str) else None
    return None


def _model_parts(ref: str) -> tuple[str | None, str]:
    """(machine, model) of a model reference — the machine only when the ref
    carries one (`hub:qwen3:8b`); a bare tag's colon is its own (`qwen3:8b`)."""
    ref = _strip_trailing_punct(ref.strip())
    m = _ENGINE_QUALIFIED.fullmatch(ref)
    return (m.group("engine").lower(), m.group("bare")) if m else (None, ref)


def _same_model(claimed: str, touched: str) -> bool:
    c_engine, c_bare = _model_parts(claimed)
    t_engine, t_bare = _model_parts(touched)
    if c_engine and t_engine and c_engine != t_engine:
        return False  # a pull on another machine does not back this one
    return c_bare.rsplit("/", 1)[-1].lower() in t_bare.lower()


def _raw_model_arg_of(span: Any) -> str | None:
    """The bare `model` argument a pull/remove span was CALLED with, ignoring
    any resolved fact — the counterpart to `_target_of`'s resolved-preferring
    read, for the one place both readings matter (see `_backed`)."""
    meta = getattr(span, "meta", None) or {}
    args = meta.get("args_redacted")
    if not isinstance(args, dict):
        return None
    model = args.get("model")
    return model if isinstance(model, str) else None


def _argument_echoes(target: str, raw: str) -> bool:
    """True when the raw argument a pull/remove tool was actually called
    with is what the claim names — engine-STRICT, unlike `_same_model`: a
    bare raw argument does not back a machine-qualified claim here, because
    this only runs after the resolved id (the authoritative source) already
    said no, and a bare argument is not evidence against that."""
    t_engine, t_bare = _model_parts(target)
    r_engine, r_bare = _model_parts(raw)
    if t_engine != r_engine:
        return False
    return t_bare.rsplit("/", 1)[-1].lower() in r_bare.lower()


def is_update_fact(fact: object) -> bool:
    """One recorded update fact, {"machine_update": <str>, "confirmed": <bool>,
    …}: machine_update's answer, or the ledger row machine_status's agent line
    states (S42b; fix round 1, I3). The one definition: _update_record reads
    it, and live_facts._shown_facts withholds it with an agent line she was not
    shown, so what a live check keeps and what backs a claim cannot drift."""
    return (
        isinstance(fact, dict)
        and isinstance(fact.get("machine_update"), str)
        and isinstance(fact.get("confirmed"), bool)
    )


class _UpdateRecord(NamedTuple):
    """What this turn's record says about updates — read ONCE per reply
    (_update_record), never once per claim (fix round 2, N3).

    `made` / `made_current`: this turn's update tool (_UPDATE_TOOLS) answered
    confirmed — the agent reconnected on the hub's build — or "current" — its
    agent last reported the hub's build, nothing was sent. `specialist`: a
    successful update of one of her specialist agents (_PERSONA_UPDATE_TOOLS).
    `confirmed` / `current`: every machine such a fact names, the update tool's
    and the rows a machine read showed (machine_status states each agent's
    last ledger row, fix round 1, I3, and "current" for an agent on the hub's
    build, Task 32, L497). `updated`: every machine this turn's update tool
    answered for, whatever it answered; `stated`: every machine any update fact
    names, whatever it says (Task 32: _update_read, and the names a claim's
    word is read against when no paired name holds it, _UpdateNames)."""

    made: bool
    made_current: bool
    specialist: bool
    confirmed: _MachineNames
    current: _MachineNames
    updated: _MachineNames
    stated: _MachineNames


def _update_record(successful: Sequence[Any]) -> _UpdateRecord:
    """The update facts on this turn's successful spans: the update tool's, and
    those of a tool that reads machines (_machine_read_tools, derived from the
    registry). Only `confirmed`, the "current" outcome and the machine each
    names are read — never `hub`, which says only which door an agent came in
    through."""
    readers = _UPDATE_TOOLS | _machine_read_tools()
    made = made_current = specialist = False
    confirmed: list[str] = []
    current: list[str] = []
    updated: list[str] = []
    stated: list[str] = []
    for span in successful:
        name = getattr(span, "name", None)
        specialist = specialist or name in _PERSONA_UPDATE_TOOLS
        if name not in readers:
            continue
        facts = (getattr(span, "meta", None) or {}).get("facts")
        for fact in facts if isinstance(facts, list) else ():
            if not is_update_fact(fact):
                continue
            stated.append(fact["machine_update"])
            if name in _UPDATE_TOOLS:
                updated.append(fact["machine_update"])
            if fact["confirmed"]:
                confirmed.append(fact["machine_update"])
                made = made or name in _UPDATE_TOOLS
            elif fact.get("outcome") == "current":
                current.append(fact["machine_update"])
                made_current = made_current or name in _UPDATE_TOOLS
    return _UpdateRecord(
        made,
        made_current,
        specialist,
        _MachineNames(confirmed),
        _MachineNames(current),
        _MachineNames(updated),
        _MachineNames(stated),
    )


def _update_read(kind: str, target: str | None, record: _UpdateRecord) -> bool:
    """Whether the record makes a match an update claim at all. Every form
    Task 23 reads is one wherever it is said; an update's RESULT (_UPDATE_TOOK,
    Task 32) is one only about a machine the record speaks of: an install or
    an update done beside THIS turn's update of it — without one, an install
    is device_completion's claim, and its sentence is the true one (MF4's
    division, never two sentences for one claim) — and the build it runs
    beside any update fact this turn holds for it."""
    if kind in (_INSTALLED_BUILD, _UPDATE_TOOK_STATE):
        return target is not None and record.updated.names_any(target)
    if kind == _ON_THE_BUILD:
        return target is not None and record.stated.names_any(target)
    return True


def _update_backed(kind: str, target: str | None, record: _UpdateRecord) -> bool:
    """S42b: what backs an update claim (its forms: _UPDATED_FORMS).

    A claim that NAMES a machine — by its own name or a word of it — is backed
    by an update fact naming it: confirmed, or for a STATE also "current";
    machine_update's answer or the row a machine read showed (fix round 1, I3).

    A claim that names NO machine — "the hub's agent", "it", "the mini PC",
    "on your behalf" — is backed only by THIS turn's own update (fix round 2,
    N1): a confirmed machine_update (for a state, also its "current"), or for
    her act on an agent ("I updated coder's agent settings") a successful
    update of one of her specialist agents (fix round 1, I2). machine_status
    states every listed agent's LAST row, whatever its age, and a claim that
    names no machine cannot be tied to one of them. The door an agent came in
    through backs nothing: "the hub's agent" names no machine."""
    state = kind in _UPDATE_STATES
    if target is None:
        return (
            record.made
            or (state and record.made_current)
            or (kind == _UPDATED_AGENT and record.specialist)
        )
    return record.confirmed.names_any(target) or (state and record.current.names_any(target))


def _backed(
    kind: str,
    target: str | None,
    successful: Sequence[Any],
    updates: _UpdateRecord | None = None,
) -> bool:
    if kind in _UPDATE_KINDS:
        # Before the leniency for an unreadable target below, which would let
        # any machine_update span — a send — back the claim; and read from
        # more than the update tool (_update_backed). narration_check hands in
        # the record it read once for the reply.
        if updates is None:
            updates = _update_record(successful)
        return _update_backed(kind, target, updates)
    matching = [span for span in successful if span.name in _tools_for_kind(kind)]
    if not matching:
        return False
    span_targets = [_target_of(span) for span in matching]
    # A matching tool ran but its target is unreadable, or the claim named no
    # file: kind-level presence is enough — do not flag on what we cannot see.
    if any(t is None for t in span_targets) or not target:
        return True
    if kind in _MODEL_CLAIMS:
        if any(_same_model(target, t) for t in span_targets):
            return True
        # The id the tool RESOLVED and confirmed didn't back it — but a
        # reply that echoes exactly the raw argument she was called with
        # (`library:<tag>`, the pre-rename `ollama:<tag>`) is just as true,
        # and reading ONLY the resolved id as backing corrected that honest
        # echo as though the gateway-confirmed action never happened (S40
        # fix wave: echo backing).
        raw_args = [_raw_model_arg_of(span) for span in matching]
        return any(raw is not None and _argument_echoes(target, raw) for raw in raw_args)
    if kind == "configured_machine":
        return any(target.strip().lower() == (t or "").strip().lower() for t in span_targets)
    # Normalise both sides for trailing punctuation/whitespace, so an honest
    # backed fetch is clean regardless of the sentence punctuation the URL
    # was written with ("…/data." vs the span's "…/data").
    # The query and the fragment are not compared (S38): span arguments
    # record an address without them (chat._redact masks them, since a
    # reset link carries its token there), so a claim naming the full
    # address is matched on the path it shares with the span.
    claimed = _strip_trailing_punct(target.strip()).split("#", 1)[0].split("?", 1)[0]
    needle = claimed.rsplit("/", 1)[-1].lower()
    if not needle.strip():
        # S38 fix round 1 (M4): "https://evil.example/" ends in an empty
        # segment, and "" is a substring of every span target — it backed any
        # address after any fetch. Compare its last NON-empty segment (the host
        # for a bare root) instead; with none at all, it matches nothing.
        needle = claimed.rstrip("/").rsplit("/", 1)[-1].lower()
        if not needle.strip() or needle.endswith(":"):
            return False
    return any(needle in _strip_trailing_punct((t or "").strip()).lower() for t in span_targets)


# S38: the claim kinds her browser agent may make good on a delegated turn.
_BROWSER_DELEGABLE_KINDS = frozenset({"browser_acted", "browser_downloaded"})


def _browser_tool_names() -> frozenset[str]:
    """Her browser tools, DERIVED from the live registry (fix round 1, M2): a
    made-up `browser_click` the model wrote is refused as an unknown tool and
    put her on no page. Imported inside the call because app.tools imports
    this module (_spend_tools' rule)."""
    from app import tools

    return frozenset(name for name in tools.tool_names() if name.startswith("browser_"))


def _browser_spans(spans: Sequence[Any]):
    """Every tool span of one of her registered browser tools this turn, ok or
    not — except a call refused before it ran (`refused_*`,
    chat._refuse_call), which put her on no page and brought nothing in."""
    names: frozenset[str] | None = None
    for span in spans:
        if getattr(span, "kind", None) != "tool":
            continue
        if names is None:
            names = _browser_tool_names()
        if getattr(span, "name", None) not in names:
            continue
        meta = getattr(span, "meta", None) or {}
        if any(str(key).startswith("refused") for key in meta):
            continue
        yield meta


def _browser_ran(spans: Sequence[Any]) -> bool:
    """Whether one of her browser_* tools ran this turn (S38, ruling G2): she
    is on a page, so "I typed it into the search field" is about one."""
    return next(_browser_spans(spans), None) is not None


def _browser_downloaded(spans: Sequence[Any]) -> bool:
    """Whether her browser brought a download into the workspace this turn —
    a {"browser": "download"} fact on ANY browser_* span (S38, ruling G2 as
    amended by the Task 5 carry). Target-free: a download is saved under a
    free name (files.bring_in), so "I downloaded report.pdf" is true of a
    copy kept as "report (2).pdf"."""
    return any(
        isinstance(fact, dict) and fact.get("browser") == "download"
        for meta in _browser_spans(spans)
        for fact in meta.get("facts") or ()
    )


# The tools that can themselves open something (merge review round 2): a
# device listing or reading a file opens no page, so after device_info alone
# "I opened <url>" is still the fabrication it was.
_OPENING_TOOLS = frozenset({"mcp_call", "device_run", "device_launch_app"})
# The verbs that claim REACHING an address, which a failed browser call that
# filed a page fact backs. "Read" and the rest claim its content: an error
# page, or one whose snapshot failed, backs none of them.
_REACH_FETCH_VERBS = frozenset({"opened", "navigated", "visited", "accessed"})


def _opened_by_another_tool(successful: Sequence[Any]) -> bool:
    """Whether a tool that can itself open something succeeded this turn: an
    MCP call ("I opened PR #121 at <url>" through a GitHub server) or a device
    tool (`gh pr create`, `start <url>` on his machine). After one, a bare
    "I opened/navigated <url>" with no browser span is that tool's work, not a
    claim about her browser (merge review, 2026-10-07: the browser's two verbs
    must not retract an honest report main never read as a fetch)."""
    return any(span.name in _OPENING_TOOLS for span in successful)


def _failed_pages(spans: Sequence[Any]) -> list[Any]:
    """Her FAILED browser calls that still put her on a page: browser_open on a
    4xx/5xx files the page fact and then states the failure (ruling B7), so
    "I opened <url> but it answered 404" has its record — "there is no record
    of the action" would be false beside it (merge review, 2026-10-07). A call
    refused before it ran, or one that reached no page (no page fact: DNS, the
    engine down), backs nothing."""
    out = []
    names: frozenset[str] | None = None
    for span in spans:
        if getattr(span, "kind", None) != "tool":
            continue
        meta = getattr(span, "meta", None) or {}
        if meta.get("ok") is True or any(str(key).startswith("refused") for key in meta):
            continue
        if names is None:
            names = _browser_tool_names()
        if getattr(span, "name", None) not in names:
            continue
        if any(
            isinstance(fact, dict) and fact.get("browser") == "page"
            for fact in meta.get("facts") or ()
        ):
            out.append(span)
    return out


def narration_check(
    reply_text: str, spans: Sequence[Any], device_names: Sequence[str] = ()
) -> Correction | None:
    """Contradict any completed-action claim no successful span backs.

    Returns a Correction naming the unbacked claim(s), or None when the reply
    is honest (or when the matcher cannot be sure — precision over recall).
    Pure: it reads only the text and the spans, never a model or the network.
    `device_names` are the LIVE paired machines' (chat reads them for the
    state guard, through the plant — an eval replay's are its declared
    devices, S42b Task 24): the words an update claim's machine can be (S42b
    fix round 1, I2) — and where they name nothing, as when a read of them
    blipped, the machines this turn's update facts name (Task 32, L510).
    """
    if not reply_text or not reply_text.strip():
        return None
    successful = _successful(spans)
    # The update record is read on the first update claim, once for the whole
    # reply (fix round 2), and the names with it.
    names = _UpdateNames(_MachineNames(device_names), successful)
    record: _UpdateRecord | None = None
    on_a_page = _browser_ran(spans)
    delegated: bool | None = None  # read on the first claim that asks
    failed_pages: list[Any] | None = None  # read on the first unbacked fetch claim
    unbacked: list[UnbackedClaim] = []
    seen: set[tuple[str, str, bool]] = set()
    reported: set[tuple[str, str | None]] = set()
    found = [
        claim
        for clause, is_question in _clauses(reply_text)
        if not is_question
        for claim in _claims_in(clause, names, on_a_page)
    ]
    # An update's RESULT is read over whole sentences (_TookCuts says why), and
    # so is a ran command (_RAN_COMMAND_CLAIM says why).
    found += [
        claim
        for sentence in _sentences(reply_text)
        if sentence.strip() and not sentence.rstrip().endswith("?")
        for claim in (*_results_in(sentence, names), *_ran_command_claims(sentence))
    ]
    for kind, target, phrase in found:
        verb = phrase.lower()
        reach = kind == "fetched_url" and verb in _REACH_FETCH_VERBS
        # Reaching an address and reading it are judged apart (merge review
        # round 2): "I opened X. I read X: …" after a 404 open must still
        # judge the read the error page cannot back.
        key = (kind, (target or "").lower(), reach)
        if key in seen:
            continue
        browser_verb = kind == "fetched_url" and verb in _BROWSER_FETCH_VERBS
        if kind in _BROWSER_DELEGABLE_KINDS or browser_verb:
            # S38 (ruling G9): her browser agent may have done it on its
            # own turn, which this turn's spans cannot show. The key is NOT
            # recorded as seen (merge review, 2026-10-07): "I opened X; I
            # fetched X." must still judge the older verb, as the reverse
            # order always did.
            if delegated is None:
                delegated = _a_delegation_ran(spans)
            if delegated:
                continue
        if browser_verb and not on_a_page and _opened_by_another_tool(successful):
            # Before `seen`, as G9's exemption is: a skipped "opened" must not
            # record the address as judged for a later "I fetched" of it.
            continue
        seen.add(key)
        if reach and not _backed(kind, target, successful, record):
            if failed_pages is None:
                failed_pages = _failed_pages(spans)
            if failed_pages and _backed(kind, target, failed_pages, record):
                continue
        if kind == "browser_downloaded":
            # Fix round 1 (I1): judged only when her browser ran, or when
            # nothing succeeded at all. After fetch_url and a write,
            # device_run's curl or an MCP call, "I downloaded <file>" is
            # that tool's work, not a claim about her browser.
            if (successful and not on_a_page) or _browser_downloaded(spans):
                continue
        elif kind == "tests_passed":
            # Read from the run facts, never a tool's name or its prose
            # (_tests_passed_backed): a device_run that exited 1 ran.
            if _tests_passed_backed(spans):
                continue
        elif kind == "ran_command":
            # Read from the run facts' words, any exit code: running is not
            # passing (_ran_command_backed).
            if _ran_command_backed(target, spans):
                continue
        elif kind == "edited_file":
            # Only a write of that NAME: an ok write span's readable target,
            # or a run fact naming the file (_edited_file_backed).
            if _edited_file_backed(target, successful, spans):
                continue
        else:
            if kind in _UPDATE_KINDS:
                record = names.record()
                if not _update_read(kind, target, record):
                    continue
            if _backed(kind, target, successful, record):
                continue
        # The update claim's forms are one kind to everything that reads the
        # correction — the guard span, the evals — and one entry each. A set,
        # never a walk of every claim reported before (fix round 2, N2: that
        # walk was quadratic in a reply's distinct claims).
        public = _UPDATED_AGENT if kind in _UPDATE_KINDS else kind
        if (public, target) in reported:
            continue
        reported.add((public, target))
        unbacked.append(UnbackedClaim(kind=public, target=target, phrase=phrase.strip()[:80]))
    if not unbacked:
        return None
    updates = [claim for claim in unbacked if claim.kind == _UPDATED_AGENT]
    rest = [claim for claim in unbacked if claim.kind != _UPDATED_AGENT]
    base = None
    if rest:
        spend = all(claim.kind == "stated_spend" for claim in rest)
        ran = [claim.target for claim in rest if claim.kind == "ran_command"]
        if spend:
            base = SPEND_CORRECTION_TEXT
        elif all(claim.kind in _RUN_FACT_KINDS for claim in rest):
            # Each run-fact kind says what its record shows, both true at once.
            parts = []
            if any(claim.kind == "tests_passed" for claim in rest):
                parts.append(_tests_correction_text(spans))
            if ran:
                parts.append(_ran_correction_text(ran, spans))
            base = " ".join([parts[0], *(part.removeprefix("Correction: ") for part in parts[1:])])
        else:
            base = CORRECTION_TEXT
    if not updates:
        return Correction(claims=tuple(unbacked), text=base or CORRECTION_TEXT)
    said = _update_correction(updates)
    if base is None:
        return Correction(claims=tuple(unbacked), text=f"Correction: {said}")
    return Correction(claims=tuple(unbacked), text=f"{base} {said[0].upper()}{said[1:]}")


# S42b: the one sentence an unbacked update claim gets, APPENDED beside her
# prose (narration's composition) — the said-not-done lane's shape: what the
# record shows, never a redirect, never an invitation to act. The family's
# "there is no record of the action this turn" would be FALSE beside a send
# machine_update really made, so it is never used for an update.
#
# Each sentence says exactly what would have backed the claim, so it stays true
# beside whatever else the turn showed. A claim that names a machine: "nothing
# this turn" (fix round 1, I3) — machine_status's row for that machine backs it
# as well as machine_update's own answer does. A claim that names no machine is
# backed only by this turn's machine_update (fix round 2, N1); "nothing this
# turn confirmed an update" would be false beside a row machine_status showed
# confirmed for some machine, so its sentence names the call.
UPDATE_CORRECTION = (
    "nothing this turn confirmed {subject} — only the agent reconnecting on the hub's build "
    "confirms one."
)
UPDATE_UNNAMED_CORRECTION = (
    "no machine_update call this turn confirmed an update — only the agent reconnecting on the "
    "hub's build confirms one."
)


def _once_each(names: Sequence[str]) -> list[str]:
    """Each name once, whatever its case: the first spelling, in order."""
    seen: dict[str, str] = {}
    for name in names:
        seen.setdefault(name.lower(), name)
    return list(seen.values())


def _update_correction(claims: Sequence[UnbackedClaim]) -> str:
    """The update sentence for these unbacked claims, without its lead. An
    unbacked claim that names no machine means no machine_update call this
    turn confirmed an update at all — else it would be backed — so the
    sentence says exactly that; otherwise it names each paired machine, once."""
    named = [claim.target for claim in claims if claim.target]
    if len(named) < len(claims):
        return UPDATE_UNNAMED_CORRECTION
    return UPDATE_CORRECTION.format(
        subject=f"an update of a machine named {' or '.join(_once_each(named))}"
    )


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
# in available_tools. A new tool that provides a capability is added here — and
# the pinned corpus in test_capability_guard.py goes red the day a shipped tool's capability is
# unmapped, which is the intended alarm. Every phrase is a GENERAL ability, never
# a specific target: plural/indefinite nouns only, so "read files"/"read a file"
# match but "read that file"/"read report.md" do not.

# S47: her setup QR cards. GENERAL abilities only: QR codes, pairing a device
# or a machine, putting Nova on a phone. "Add machines to your tailnet" is NOT
# here — that is S43 (not built), and "I can't" is true of it today.
#
# I3 (review fix round 1) narrowed all three: the noun must be QUALIFIED
# (a setup or pairing QR code or card — never a bare "QR code(s)", and
# never "the" as its determiner: "the QR code right now" names one SPECIFIC
# thing, not the ability); "install" is dropped from the phone row (putting
# Nova on a phone is hers, installing it is the operator's, via the store);
# and none of the three fires when the denial is qualified as a PRESENT
# STATE (right now/at the moment/currently/for now/until/because/since/
# while) — that is an honest report about right now, not a denial of the
# ability. The lookahead is bounded and LOCAL to these three rows so the
# sweep stays linear and no other tool's capability behaviour changes
# (_SCOPE_QUALIFIER is untouched).
_PRESENT_STATE_TAIL = (
    r"[^.?!]{0,80}?\b(?:right\s+now|at\s+the\s+moment|currently|for\s+now"
    r"|until|because|since|while)\b"
)
_CAP_SETUP_QR = re.compile(
    r"(?:generat(?:e|ing)|mak(?:e|ing)|creat(?:e|ing)|show(?:ing)?|display(?:ing)?|giv(?:e|ing))\s+"
    r"(?:you\s+)?(?:an?\s+|any\s+)?(?:setup|pairing)\s+(?:qr\s*codes?|cards?)\b"
    r"(?!" + _PRESENT_STATE_TAIL + r")",
    re.I,
)
_CAP_PAIR_MACHINE = re.compile(
    r"pair(?:ing)?\s+(?:a\s+|an\s+|your\s+|new\s+|another\s+){0,2}"
    r"(?:devices?|machines?|computers?|laptops?|servers?)\b"
    r"(?!" + _PRESENT_STATE_TAIL + r")",
    re.I,
)
# S38: her browser. GENERAL abilities only, and only ON THE WEB (ruling G1,
# as spec §4 phrases them: "click links or buttons on a page", "fill in forms
# on websites"): the object must be qualified as a web one — "on a page", "on
# websites", "in the browser", "web/online forms", "interact with websites".
# A bare "I can't click buttons" may be a desktop app on a paired machine, an
# email or a Word document, where it is TRUE ("I can't click buttons in Windows
# apps", "I can't fill in forms in Word documents"); it is left alone, a miss in
# the safe direction. "I can't click that button, it is disabled" reports one
# element, not the ability. Browsing itself stays fetch_url's row (both tools
# hold it).
# "the" qualifies only before browser (fix rounds 1 and 2, I3/N1): "in the
# browser" is the one general place that takes it; "the page", "the website",
# "the web page" you sent each name ONE page ("I can't click links on the
# page you sent — it's a PDF").
_WEB_PLACE = (
    r"(?:on|in)\s++(?:a\s++|an\s++|the\s++(?=browsers?\b)|any\s++)?(?:web\s*+)?"
    r"(?:pages?|sites?|websites?|browsers?)\b"
)
# The rows' LOCAL honest tail (ruling G1, the same shape as S37a's T12-B): a
# web object QUALIFIED by what follows it — "websites that block automation",
# "web pages behind your login", "forms on websites without your login
# details", "… right now because the engine is not answering" — is a true
# limit, never the general ability, and capability_claim REPLACES the sentence.
# Only the ruling's words: a decorative tail ("… on any page", "… for you")
# is no qualifier, and the denial is still corrected. Literal alternatives
# behind possessive runs, bounded by _PRESENT_STATE_TAIL's own window: linear.
#
# Fix round 1 (I3): a place or a means of HIS ("on your phone", "on your
# Dell", "with your bank login") or any "with <noun>" ("with payment details")
# names a specific case, not the ability. "On your behalf" alone is decorative
# (it is "for you") and still fires; before a real qualifier it is skipped,
# with any punctuation after it (fix round 2, N3: "…on your behalf, that
# needs your password"). "With my tools" / "with the tools I have" /
# "with these abilities" is HER means, the classic false denial, never a
# limit (fix round 2, N2).
_BROWSER_QUALIFIED_TAIL = (
    r"(?!\s*+,?\s*+(?:on\s++your\s++behalf[\s,;:—–-]++)?"
    r"(?:(?:that|which|behind|without|unless|requiring|needing)\b"
    r"|(?:on|in|with|from)\s++your\b(?!\s++behalf\b)"
    r"|with\s++(?!(?:my|the|these|those)\s++(?:tools?|abilities|capabilities)\b)\w)"
    r"|" + _PRESENT_STATE_TAIL + r")"
)
# One group per row, so the honest tail applies to every alternative.
_CAP_BROWSER_ACT = re.compile(
    r"(?:(?:click(?:ing)?|press(?:ing)?|tap(?:ping)?)\s++(?:on\s++)?(?:a\s++|any\s++)?"
    r"(?:links?|buttons?)(?:\s++(?:or|and)\s++(?:links?|buttons?))?\s++"
    + _WEB_PLACE
    + r"|(?:fill(?:ing)?\s++(?:in|out)|submit(?:ting)?)\s++(?:a\s++|any\s++)?"
    r"(?:(?:web|online)\s++forms?\b|forms?\s++" + _WEB_PLACE + r")"
    r"|interact(?:ing)?\s++with\s++(?:a\s++|any\s++)?(?:web\s*+pages?|websites?)\b)"
    + _BROWSER_QUALIFIED_TAIL,
    re.I,
)
_CAP_BROWSER_SCREENSHOT = re.compile(
    r"tak(?:e|ing)\s++(?:a\s++)?screenshots?\s++of\s++(?:a\s++|any\s++)?"
    r"(?:web\s*+pages?|websites?)\b" + _BROWSER_QUALIFIED_TAIL,
    re.I,
)
# T6 (local-context epic, 2026-10-09): a POSSESSION denial of her browser.
# Turn d4f59914 (dell:qwen3:8b): "I don't have an internal browser or IDE ..."
# while browser_open was registered — _DENIAL_LEAD reads "don't have" only as
# "don't have the ability/access to", so denying she HAS a browser reached no
# row. The object is narrow on purpose: a/an/any, at most two words, then
# "browser" — never "your browser's …" or "the browser history" (his browser,
# or one specific thing), and never a stated present state ("… open right
# now"). The row carries its own lead as fixed-width lookbehinds, so it fires
# ONLY right after a first-person present "I don't/do not have" — never after
# another lead ("I can't open it because I have a browser extension …").
# _POSSESSION_LEAD is the clause gate for it, and its lookahead admits a clause
# only when this very object follows. Possessive runs, bounded repeats: linear.
#
# T6 VERIFY fix: "browser" must be the HEAD of what she says she lacks, and
# what may FOLLOW it is an allowlist (VERIFY 2 + orchestrator ruling: precision
# first — a missed lie is a Survivor, a corrected honest reply is a defect).
# The denial stands only when "browser" is followed by:
#   1. the end of the clause ([.!?;:] or end of text);
#   2. ", so …" / ", but …" (or a bare "," where the clause split at "but");
#   3. "or <1-3 words>" (a coordinated alternative: "or IDE"), optionally a
#      bounded "( … )", then itself 1, 2 or 4;
#   4. capability wording: "of my own", "built in"/"built-in", "embedded",
#      "integrated", "access", "tool(s)", "capability", "available to me",
#      "I can use".
# Anything else is silent: a place or state ("installed on your Mac",
# "available offline", "open on your Mac", "running on the Dell"), a modifier
# use ("a browser tab/extension/session", "browser-based"), "and <noun>" ("a
# browser and an editor open side by side"). A preference adjective before it
# ("a favorite/preferred/default browser") is silent too. Possessive runs,
# bounded repeats and a lazy {0,2} over possessive words: linear.
_BROWSER_TAIL_END = r"\s*+(?:[.!?;:]|,\s*+(?:(?:so|but)\b|$)|$)"
_BROWSER_TAIL_CAPABILITY = (
    r"\s++(?:of\s++my\s++own|built[\s-]++in|embedded|integrated|access|tools?"
    r"|capabilit(?:y|ies)|available\s++to\s++me|i\s++can\s++use)\b"
)
_BROWSER_TAIL_OK = "(?:" + _BROWSER_TAIL_END + "|" + _BROWSER_TAIL_CAPABILITY + ")"
_BROWSER_HEAD_TAIL = (
    "(?="
    + _BROWSER_TAIL_OK
    + r"|\s++or\s++(?:[\w-]++\s++){0,2}?[\w-]++(?:\s*+\([^()]{0,80}+\))?"
    + _BROWSER_TAIL_OK
    + ")"
)
_BROWSER_OBJECT = (
    r"(?:an?|any)\s++(?:(?!(?:favou?rite|preferred|default)\b)[\w-]++\s++){0,2}?browser\b"
    + _BROWSER_HEAD_TAIL
)
_POSSESSION_LEAD = re.compile(
    r"\bi\s++(?:don['’]?t|do\s++not)\s++have\s++(?=" + _BROWSER_OBJECT + r")",
    re.I,
)
_CAP_BROWSER_POSSESSION = re.compile(
    r"(?:(?<=\bi don't have )|(?<=\bi don’t have )|(?<=\bi dont have )"
    r"|(?<=\bi do not have ))" + _BROWSER_OBJECT + r"(?!" + _PRESENT_STATE_TAIL + r")",
    re.I,
)
_CAP_ON_A_PHONE = re.compile(
    r"put(?:ting)?\s+(?:myself|me|nova)\s+on\s+"
    r"(?:a\s+|an\s+|your\s+|another\s+)?(?:phones?|tablets?|iphones?|ipads?|android\s+phones?)\b"
    r"(?!" + _PRESENT_STATE_TAIL + r")",
    re.I,
)
# S42b: updating Nova's agents is hers (machine_update), so "I can't update
# your agents" is the S12 disowning again. The GENERAL ability only, and only a
# BARE denial of it, because this correction is REPLACE-class and machine_update
# really cannot update many agents — one started by hand, one on a platform the
# hub has no build for, one offline, any while another update is in flight — and
# relaying that is the truth:
#   * the noun is general: agents (plural), an/any agent, or novad — never "the
#     agent", "its agent", "eval_laptop's agent": one agent, which may be the one
#     that cannot take it;
#   * a place is general too ("on your machines"), never a machine's name;
#   * the denial ENDS there — the clause ends, or only "yet", "myself", "for
#     you", "at all", "anymore" or "directly" follows, or a trailing denial
#     ("updating agents isn't something I can do"). Any other tail — "right now",
#     "that were started by hand", "on minipc", ": the hub has no build", "while
#     an update is in flight" — is a stated reason or scope, left alone.
# Linear: anchored on the verb, every repeat possessive or bounded.
_CAP_UPDATE_AGENTS = re.compile(
    r"\b(?:updat(?:e|ing)|upgrad(?:e|ing))\s++"
    r"(?:(?:(?:the|your|my|nova['’]s|all(?:\s++(?:of\s++)?(?:the|your|my))?)\s++)?"
    r"(?:own\s++)?agents|(?:an|any)\s++agent|novad)\b"
    r"(?:\s++on\s++(?:(?:your|the|any|all|all\s++(?:of\s++)?(?:your|the))\s++)?"
    r"(?:machines|computers|devices|pcs)\b)?"
    r"(?=\s*+[.!?,;]?\s*+$"
    r"|\s++(?:yet|myself|for\s++you|at\s++all|any\s?more|directly)\s*+[.!?,;]?\s*+$"
    r"|\s++(?:is|are)(?:n['’]t|\s++not)\b)",
    re.I,
)

# S37a fix round 1 (ruling T12-B, S38's G1 shape): the MCP rows' LOCAL honest
# tail. A denial whose object is QUALIFIED by what follows it — "MCP servers
# that run over stdio", "an MCP server without a URL", "MCP tools on a server
# you haven't connected yet", "… right now" — is a true limit, never the
# general ability, and capability_claim is REPLACE-class: a fire there stored
# only "I can do that" in place of a true sentence. Only these two rows read
# it, as only the S47 rows read _PRESENT_STATE_TAIL. Possessive runs and
# literal alternatives, bounded by _PRESENT_STATE_TAIL's own window: linear.
_MCP_QUALIFIED_TAIL = (
    r"(?!\s*+,?\s*+(?:that|which|who|over|via|using|through|without|unless|requiring"
    r"|needing|behind|on\s+(?:a|an|any|the|that|this|your)\s+server)\b"
    r"|" + _PRESENT_STATE_TAIL + r")"
)

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
    # S16 (2026-09-11). The owner asked her to delete a file and got "there is
    # no delete operation in my toolbox" — TRUE at the time, and a false denial
    # the moment workspace_delete is registered. The phrases stay GENERAL, like
    # every other entry: "delete files" and "no delete operation" match, "delete
    # groceries.md" does not, so an honest report of ONE failed removal is
    # never contradicted.
    (
        re.compile(
            r"(?:delete|deleting|remove|removing|erase|erasing)\s+(?:a\s+)?files?\b"
            r"|(?:delete|deletion|remove|removal)\s+"
            r"(?:operation|tool|capability|function|command)s?\b",
            re.I,
        ),
        "workspace_delete",
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
    # S40 (the hub lane): her machine tools. "Where do your models run?" and
    # "stop running chat models here" are hers to answer and to do the moment
    # machine_status / machine_configure are registered, and a denial of either
    # is the S12 failure again. GENERAL nouns only (machines, models) — never a
    # machine's name — so an honest report about one machine is left alone.
    # For machine_configure that means the determiner too (S40 fix wave A3):
    # only "a"/"any" machine or bare plural "machines". "this machine" is what
    # the tile and machine_status call hub, and "I can't switch off chat
    # models on this machine — the gateway couldn't be reached" is her honest
    # relay of a switch that did not happen, never a denial of the ability.
    (
        re.compile(
            r"(?:see|seeing|check|checking|tell|telling|know|knowing|say|saying|find\s+out)\s+"
            r"(?:where|which\s+machines?|what\s+machines?|on\s+which\s+machines?)\s+"
            r"(?:(?:my|your|the|our|local|ai|language|chat)\s+){0,2}models?\s+"
            r"(?:run|runs|are\s+running|is\s+running|live|lives|are|is)\b"
            r"|(?:the\s+)?(?:status|state)\s+of\s+(?:(?:my|your|the|our|any)\s+)?machines\b"
            # Ruling C9: the verb before the noun — "check which machine runs
            # my models", the denial T7's checks case scores.
            r"|(?:see|seeing|check|checking|tell|telling|know|knowing|say|saying|find\s+out)\s+"
            r"(?:which|what)\s+machines?\s+(?:runs?|serves?|hosts?)\s+"
            r"(?:(?:my|your|the|our|local|ai|language|chat)\s+){0,2}models?\b",
            re.I,
        ),
        "machine_status",
    ),
    (
        re.compile(
            r"(?:switch|switching|turn|turning)\s+(?:off|on)\s+"
            r"(?:(?:the|local|chat|ai)\s+){0,2}(?:models?|model\s+serving|serving|inference)\s+"
            r"(?:on|for)\s+(?:(?:a|any)\s+machines?|machines)\b"
            r"|(?:stop|stopping|start|starting)\s+(?:(?:a|any)\s+machines?|machines)\s+"
            r"from\s+(?:running|serving)\s+(?:(?:chat|local|ai)\s+)?models?\b"
            r"|(?:change|changing|control|controlling|configure|configuring|choose|choosing)\s+"
            r"(?:which|what)\s+machines?\s+(?:runs?|serves?)\s+"
            r"(?:(?:the|chat|local|your|my)\s+){0,2}models?\b",
            re.I,
        ),
        "machine_configure",
    ),
    # S47: her setup QR cards. GENERAL abilities only: QR codes, pairing a
    # device or a machine, putting Nova on a phone. "Add machines to your
    # tailnet" is NOT here — that is S43 (not built), and "I can't" is true
    # of it today.
    (_CAP_SETUP_QR, "show_setup_qr"),
    (_CAP_PAIR_MACHINE, "show_setup_qr"),
    (_CAP_ON_A_PHONE, "show_setup_qr"),
    # S42b: updating her agents (machine_update) — a bare denial of the
    # general ability only; see _CAP_UPDATE_AGENTS.
    (_CAP_UPDATE_AGENTS, "machine_update"),
    # S38: her browser's two abilities beyond reading a page (see the
    # patterns). Bound to module names like the S47 rows above, so the timing
    # sweep times each under its own name as well as here; the sweep's
    # reachability proof selects the device_run row by its tool's name (S37a
    # F11), so where these sit does not move it.
    (_CAP_BROWSER_ACT, "browser_act"),
    (_CAP_BROWSER_SCREENSHOT, "browser_screenshot"),
    # S42a (the hub lane): Nova's agent runs on Windows and macOS, so "I can't
    # reach Windows machines" is the S12 disowning again. GENERAL nouns only —
    # "a Windows machine", "Windows computers", "Macs" — never a name and never
    # "that PC": "I can't reach that Windows machine — it's offline" is an
    # honest report about one machine, not a denial of the ability.
    # Only verbs that ARE device_run's ability (access, reach, control, run
    # commands on). "use" and "work with" are not here (final review I1): they
    # accept any purpose, and a Windows machine or a Mac cannot serve models
    # until S44, so "I can't use a Windows PC as a model server yet" is true.
    (
        re.compile(
            r"(?:access|reach|control"
            r"|run\s+(?:commands?|programs?|apps?|anything)\s+on)\s+"
            r"(?:(?:a|any)\s+)?(?:windows|mac(?:os)?)\s+"
            r"(?:machines?|computers?|pcs?|laptops?|desktops?|devices?)\b"
            r"|(?:access|reach|control)\s+(?:(?:a|any)\s+)?macs\b",
            re.I,
        ),
        "device_run",
    ),
    # S37a: her MCP client, as GENERAL abilities — connecting to MCP servers,
    # using MCP tools. Plural or indefinite nouns only, like every row here:
    # "the MCP server" names one thing and is left alone. A NAMED server's
    # denial is server_denial_check's, which reads the live server list.
    (
        re.compile(
            r"\bconnect(?:ing)?\s+(?:to\s+)?(?:an?\s+|any\s+|new\s+)?mcp\s+servers?\b"
            + _MCP_QUALIFIED_TAIL,
            re.I,
        ),
        "mcp_connect",
    ),
    (
        re.compile(
            r"\buse\s+(?:an?\s+|any\s+)?mcp\s+(?:servers?|tools?)\b" + _MCP_QUALIFIED_TAIL, re.I
        ),
        "mcp_call",
    ),
    (_CAP_BROWSER_POSSESSION, "browser_open"),
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
# The trailing denial forms, where the capability phrase comes FIRST and the
# denial follows it: "<capability> is not something I can do."
#
# 2026-09-09 (S12 review): the walk's OWN sentence was not in this set. She
# said "delegating to an agent needs a delegate_to_agent tool, and that
# capability isn't in my toolset right now" while HOLDING delegate_to_agent,
# and nothing here fired — the yesterday fix only caught her because a LATER
# clause in the same reply said "so I can't hand off work to coder", i.e. by
# luck of a second phrasing. A denial does not stop being a denial for being
# said about a possession rather than an ability, so the whole copula family
# is read: <capability> is/isn't {something I can do | something I'm able to
# do | in/part of/one of/among/within my toolset|tools|capabilities|abilities|
# skill set | a capability/tool I have | available to me}. All of them are
# ONE shape — a negated copula whose predicate says the capability is not
# hers — which is why they can be one pattern rather than a growing list of
# sentences someone maintains.
#
# Like the original, a trailing form governs the capability BEFORE it in the
# same clause, because the subject is often anaphoric ("…, and THAT CAPABILITY
# isn't in my toolset") and the phrase it refers back to is earlier in the
# clause. The exposure that buys — an affirmation of one capability sharing a
# clause with the denial of another ("I can write files, and creating agents
# isn't one of my tools") would correct both — is the SAME exposure the
# original form already carried, _clauses' contrastive/semicolon splits carve
# off most of it, and what it costs is bounded: the correction states only
# that a registered tool exists, which is TRUE of the affirmed capability too,
# so an over-reach here reads as a redundant line and never as a false one.
_NOT_COPULA = r"(?:\b(?:is|are)\s+not\b|\b(?:is|are)n['’]t\b|['’](?:s|re)\s+not\b)"
# "there is no <capability> in my toolbox" (S16, her sentence to the owner on
# 2026-09-11). The lead family is first-person because a denial has to be ABOUT
# her; this one is impersonal in grammar and self-referring in substance, so it
# is admitted only when the clause also names her own toolset — the lookahead
# is what keeps "there is no file at that path" out. Same lesson the trailing
# family learned in S12: a denial does not stop being a denial for being said
# about a possession rather than an ability.
#
# 2026-10-06: the lookahead reads at most 160 characters. Unbounded, it walked
# to the clause's end from EVERY "there is no" — 1.6 s at 50 KB of them, on
# core's only event loop. Her own sentence has 18 between the two.
_ABSENT_FROM_TOOLSET = re.compile(
    r"\bthere\s++(?:is|are)\s++no\b"
    r"(?=[^.?!\n]{0,160}?\bin\s++my\s++"
    r"(?:tool\s?set|tools|toolkit|toolbox|capabilit(?:y|ies)|abilities|skill\s?set)\b)",
    re.I,
)
_TRAILING_DENIAL = re.compile(
    _NOT_COPULA + r"\s+(?:"
    r"something\s+i(?:['’]m|\s+am)?\s+(?:can\s+do|able\s+to\s+do)"
    r"|an?\s+(?:capability|tool)\s+i\s+have"
    r"|(?:in|part\s+of|one\s+of|among|within)\s+my\s+"
    r"(?:tool\s?set|tools|toolkit|toolbox|capabilit(?:y|ies)|abilities|skill\s?set)"
    r"|available\s+to\s+me"
    r")\b",
    re.I,
)

# A SCOPE limit on the capability, not a denial of it (S12, 2026-09-08). An
# agent is contained to its own folder, so "I can't write files outside my
# folder" is TRUE — the tool exists and _resolve_within refuses the path.
# Correcting it would tell the owner the agent can write anywhere, which is
# the opposite of the fact, so a scope word in the denial's own tail makes the
# denial honest. Nova's root is contained too; this protects the same sentence
# from her.
#
# 2026-09-09 (S12 review): this used to read only the 40 characters
# IMMEDIATELY after the capability phrase, which made the guard itself the
# liar on any honest containment sentence with words in between. MEASURED over
# 11 honest phrasings: 9 silent, 2 corrected into "I can do that" — "I can't
# write files to paths outside the workspace" and "I can't write files there —
# /etc/nova/notes.md is outside my workspace". The window is gone; the scope
# word is now found anywhere in the DENIAL'S OWN TAIL (_denial_tail).
_SCOPE_QUALIFIER = re.compile(
    r"\b(?:"
    r"outside|beyond|elsewhere|externally"
    r"|(?:anywhere|any\s+place)\s+(?:else|other|except|but)"
    r"|(?:other\s+than|except|besides|apart\s+from)\b"
    r"|from\s+(?:the\s+)?(?:web|internet|external|outside|other|another|someone)"
    r"|on\s+(?:the\s+)?(?:web|internet)"
    r"|(?:in|on|for|of)\s+(?:someone|somebody|another|other|the\s+other)"
    r"|not\s+in\s+(?:my|this)\b"
    r")",
    re.I,
)


def _match_starts(pattern: re.Pattern[str], text: str) -> list[int]:
    """Every position `pattern` matches at in `text`, in order — exactly the
    starts `pattern.search(text, pos)` returns for some `pos` — found in ONE
    left-to-right pass."""
    starts: list[int] = []
    found = pattern.search(text)
    while found is not None:
        starts.append(found.start())
        found = pattern.search(text, found.start() + 1)
    return starts


class _DenialMarks:
    """Where each pattern a denial is judged by matches in ONE clause, found
    once per pattern per clause (2026-10-06). `_denial_tail` used to search the
    rest of the clause again for every capability phrase in it, and the scope
    qualifier then searched that tail: one clause repeating a scoped denial
    ("I can't read files and read files and … outside my workspace") took
    0.84 s at 12.5 KB and over 9 s at 50 KB, on core's only event loop.

    A mark is where a match STARTS, so a scope word counts when it starts in a
    denial's tail — what searching the tail found, except a scope word that
    straddles the next denial's first word, which only silences (the miss
    direction this family errs in)."""

    __slots__ = ("_clause", "_starts")

    def __init__(self, clause: str) -> None:
        self._clause = clause
        self._starts: dict[re.Pattern[str], list[int]] = {}

    def first(self, pattern: re.Pattern[str], pos: int) -> int:
        """Where `pattern` first matches at or after `pos` — the start
        `pattern.search(clause, pos)` returns — or the clause's end."""
        starts = self._starts.get(pattern)
        if starts is None:
            starts = self._starts[pattern] = _match_starts(pattern, self._clause)
        i = bisect_left(starts, pos)
        return starts[i] if i < len(starts) else len(self._clause)


def _denial_tail(marks: _DenialMarks, phrase_end: int) -> int:
    """Where the tail that belongs to THIS denial ends. The tail runs from
    `phrase_end` (the end of its capability phrase) to here, and is where a
    scope word may qualify it.

    WHERE THE DENIAL ENDS, and why this is the right boundary. The outer unit
    is already the clause: _clauses splits on sentence terminators, semicolons,
    the contrastive conjunctions and ", then", so an "except" living in another
    sentence or on the far side of a "but" is out of reach by construction. The
    only thing left that can end a denial INSIDE one clause is another denial:
    a second inability lead ("I can't write files AND I CAN'T work outside the
    sandbox" — the "outside" belongs to the second denial, the first is a flat
    false denial and must still be corrected) or a trailing denial form
    ("reading files IS NOT IN MY TOOLSET" — the "not in my" is the denial
    itself, not a scope on the capability). So the tail runs from the end of
    the capability phrase to whichever of those starts first, or to the end of
    the clause.

    Nothing else is treated as a boundary — not a dash, not a comma, not a
    coordinator — because the two measured false corrections lived exactly
    there ("...to paths outside the workspace", "...there — /etc/nova/notes.md
    is outside my workspace") and because a shared scope qualifier legitimately
    trails a coordinated pair ("I can't create files or write files outside my
    workspace"). The residual is a scope word in a coordinated POSITIVE
    predicate ("I can't write files, and everything except the config is
    stale"), which silences the guard: a MISS, which is the direction this
    family always errs in (ruling S2d-R2 — a wrongly-corrected honest reply is
    worse than a missed lie).

    2026-10-06: read off the clause's marks (`_DenialMarks`), found once per
    clause, never by searching the rest of the clause again for each phrase.
    """
    return min(marks.first(_DENIAL_LEAD, phrase_end), marks.first(_TRAILING_DENIAL, phrase_end))


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
        lead = (
            _DENIAL_LEAD.search(clause)
            or _ABSENT_FROM_TOOLSET.search(clause)
            or _POSSESSION_LEAD.search(clause)
        )
        trailing = _TRAILING_DENIAL.search(clause)
        if lead is None and trailing is None:
            continue
        marks: _DenialMarks | None = None  # found when the first phrase needs them
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
                if pattern is _CAP_BROWSER_POSSESSION:
                    # The row carries its own lead (fixed-width lookbehinds),
                    # so it is after a lead by construction — even when an
                    # earlier-found lead is a LATER "I can't" in the same
                    # clause ("I don't have a browser, so I can't look.").
                    after_lead = True
                before_trailing = trailing is not None and m.end() <= trailing.start()
                if not (after_lead or before_trailing):
                    continue
                if marks is None:
                    marks = _DenialMarks(clause)
                # A scope limit anywhere in this denial's own tail ("...files
                # OUTSIDE my folder", "...files to paths OUTSIDE the
                # workspace") is a true statement about containment, not a
                # disowned capability. _denial_tail says where that tail ends.
                if marks.first(_SCOPE_QUALIFIER, m.end()) < _denial_tail(marks, m.end()):
                    continue
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
    # S38 (ruling G8): the tools whose successful span KEEPS a commitment of
    # this class. Empty, the default, is the tool the commitment names (its
    # first registered one), exactly as before; only a class that says so is
    # kept by others — the fetch class, by every tool that backs a fetch claim.
    keeps: tuple[str, ...] = ()

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
    # S38: browser_open performs it too (fetch_url stays first, the one a
    # deferral names while it is registered).
    ("fetch_url", "browser_open"),
    "fetch that page",
    restated=re.compile(
        r"\b(?:" + _FETCH_VERB_ALTS + r")\s+(?:it|that|this|them|that\s+one)\b", re.I
    ),
    # S38 (ruling G8): "I'll open that page" is kept by any tool that backs a
    # fetch claim — narration's own family, one source for both sides.
    keeps=tuple(sorted(_FETCH_TOOLS)),
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
_MODEL_REF = r"(?:" + _ENGINE_PREFIX + r")?" + _MODEL_BODY
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
# S47: "want me to show you a QR code?" after he asked for one — an offer of
# what show_setup_qr does. B (review fix round 2): the two sides read
# DIFFERENT bars — the controller ruled spec §8's own example wins over
# round 1's narrowing, which had narrowed BOTH sides and so missed the
# brief's own pinned reply.
#   - the REPLY/OFFER side (`_SETUP_QR_OFFER`, this class's `pattern`, read
#     by _restated_offer) is BROAD again: any offer to show/make/send/give/
#     generate/display a QR code, or a setup/pairing card — "Want me to show
#     you a QR code for your phone?" must fire on nothing more than that.
#   - the INSTRUCTION side (`_SETUP_QR_INSTRUCTS`, read INSTEAD of `pattern`
#     by _instructed_classes for this one class, mirroring _CHECK_DEVICE's
#     special case) stays NARROW, three ways: (1) a setup/pairing QR code or
#     card, unconditionally; (2) a bare "QR code" — never on its own —
#     counts two ways (round 3, B): (2a) its OWN "for|of|to <X>" phrase, when
#     it has one, names a QUALIFYING object, and then it counts
#     UNCONDITIONALLY ("show me a QR code for my phone" needs no "put" phrase
#     anywhere). X is a closed grammar (round 5, B — see _QR_OBJECT): a
#     determiner, closed modifiers, a HEAD that is a device word or
#     Nova/you/yourself/setup/pairing, then a boundary — "my new phone" and
#     "Nova" do, while a device word that MODIFIES another noun does not:
#     "my phone number", "my phone's wifi", "the device manual", "my Android
#     app listing"; (2b) it has
#     NO "for|of|to" phrase of its own, and the SAME clause names putting
#     Nova/you/yourself on a device LATER, checked with a bounded LOOKAHEAD
#     so the match itself is just the "QR code" mention (early in the
#     sentence, e.g. right after "show me a"), never the later "put" clause
#     — that is what keeps the brief's exact row ("show me a QR code so I
#     can put you on my phone") clear of _USER_SELF_REPORT, which reads the
#     text BEFORE a match: matching at "put" would put "I can" in `before`
#     and get cut as her own report, matching at "QR code" does not. A
#     "for|of|to <X>" phrase naming a DISQUALIFYING object (a wifi password,
#     a link) counts as NEITHER (2a) nor (2b), even when a put-phrase
#     follows later in the clause — "make a QR code for my wifi so I can put
#     you on my phone" is about the wifi, and its own "put you on my phone"
#     match is excluded anyway, on its own, by _USER_SELF_REPORT's "so I
#     can"; (3) "put (you|nova|yourself) on <device>" anchored and
#     standalone (no QR mention needed at all, for "put Nova on my phone")
#     — never "put <anything else> on <device>" ("put my calendar/the
#     shopping list/the playlist on my phone" names an object that is not
#     Nova herself, and "send me the link, not a QR code" has no "put"
#     phrase at all, so neither (2) nor (3) reaches it).
# Both patterns are bounded so the sweep's 1,500-character inputs stay linear.
_SETUP_QR_OFFER = re.compile(
    r"\b(?:show|make|send|give|generate|display)\b[^.?!]{0,40}?"
    r"(?:qr(?:\s*codes?)?|(?:setup|pairing)\s+cards?)\b",
    re.I,
)
_DEVICE_WORD = (
    r"(?:phones?|tablets?|iphones?|ipads?|android|laptops?|computers?|devices?|machines?)"
)
_PUT_ON_A_DEVICE = (
    r"\bput(?:ting)?\s+(?:you|nova|yourself)\s+on\s+"
    r"(?:a\s+|an\s+|my\s+|your\s+|another\s+)?" + _DEVICE_WORD + r"\b"
)
# B (round 5, replacing round 4's wording): the object X of "QR code
# for|of|to <X>" is a CLOSED grammar:
#   [determiner] [closed modifiers] HEAD [model number] BOUNDARY
#   - determiner or possessive (_QR_OBJECT_DETERMINER): my, your, the, a,
#     an, this, that, our — at most one;
#   - modifiers (_QR_OBJECT_MODIFIER): new, other, second, old, work, home,
#     personal, spare, kid's, kids' — zero or more (bounded);
#   - HEAD (_QR_OBJECT_HEAD): phone, tablet, iPhone, iPad, Android, laptop,
#     computer, device, singular or plural — WITHOUT "machine" for this rule
#     (nobody puts Nova on a washing machine) — or Nova, you, yourself,
#     setup, pairing;
#   - an optional model number (digits): "my iPhone 15";
#   - BOUNDARY (_QR_OBJECT_BOUNDARY): the end of the text, any non-letter
#     character (punctuation, dashes, slash, ellipsis, emoji), a preposition
#     (to, on, in, with, at, from, for, by), a conjunction or complementizer
#     (and, or, but, so, because, since, while, if, when, that, which), or
#     please/now/too/again/real/quickly.
# Nothing else may sit before the head, so a verb ("to call/text/unlock/find
# my phone") or an unlisted modifier ("the washing machine") never
# qualifies; and only a boundary may follow it, so a device word that
# MODIFIES another noun ("my phone number", "the device manual", "my Android
# app listing") never does. One reading the ruling leaves to the code: an
# apostrophe GLUED to the head is a possessive, not a boundary ("my phone's
# wifi" is round 4's must-not row; "my phones' chargers" is the same), and so
# is a hyphen joining a compound ("phone-case"), while a free-standing dash
# ("my phone -- thanks") is one. Every repeat is bounded and the whole test is a
# LOOKAHEAD after "QR code", so the match itself stays the "QR code" mention
# that _USER_SELF_REPORT reads `before` of.
_QR_OBJECT_DETERMINER = r"(?:my|your|the|a|an|this|that|our)"
_QR_OBJECT_MODIFIER = r"(?:new|other|second|old|work|home|personal|spare|kid['’]s|kids['’])"
_QR_OBJECT_HEAD = (
    r"(?:phones?|tablets?|iphones?|ipads?|androids?|laptops?|computers?|devices?"
    r"|nova|yourself|you|setup|pairing)"
)
_QR_OBJECT_BOUNDARY = (
    r"(?=\s*$"
    # glued to the head: any non-letter but an apostrophe (a possessive,
    # "phone's"/"phones'") or a hyphen that joins a compound ("phone-case")
    r"|(?!['’]|-[^\W\d_])(?![^\W\d_])\S"
    # after whitespace: a free-standing non-letter ("-- thanks", "🙂")
    r"|\s+(?!['’-][^\W\d_])(?![^\W\d_])\S"
    r"|\s+(?:to|on|in|with|at|from|for|by|and|or|but|so|because|since|while|if|when"
    r"|that|which|please|now|too|again|real|quickly)\b)"
)
_QR_OBJECT = (
    r"(?:"
    + _QR_OBJECT_DETERMINER
    + r"\s+)?(?:"
    + _QR_OBJECT_MODIFIER
    + r"\s+){0,4}"
    + _QR_OBJECT_HEAD
    + r"(?:\s*\d+)?"
    + _QR_OBJECT_BOUNDARY
)
_SETUP_QR_INSTRUCTS = re.compile(
    r"(?:setup|pairing)\s+(?:qr\s*codes?|cards?)\b"
    r"|\bqr\s*codes?\b(?=\s*(?:for|of|to)\s+" + _QR_OBJECT + r")"
    rf"|\bqr\s*codes?\b(?!\s*(?:for|of|to)\b)(?=[^.?!]{{0,60}}?{_PUT_ON_A_DEVICE})"
    rf"|{_PUT_ON_A_DEVICE}",
    re.I,
)
_SHOW_SETUP_QR = _ActionClass(_SETUP_QR_OFFER, ("show_setup_qr",), "show that QR code")
_OFFER_CLASSES: tuple[_ActionClass, ...] = (
    *_DEFERRAL_TOOLS,
    _LIST_FILES,
    _READ_FILE,
    _RUN_COMMAND,
    _CHECK_DEVICE,
    _PULL_MODEL,
    _SET_REMINDER,
    _SHOW_SETUP_QR,
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


def _attempted(tools: tuple[str, ...] | frozenset[str], spans: Sequence[Any]) -> bool:
    """True if ANY tool span naming one of `tools` — successful or not — was
    recorded this turn as something SHE tried. The offer shape's exemption:
    an offer after a real attempt at the instructed action is about what
    comes next, not the instruction handed back. Read off the spans, never
    off the reply's word order.

    Takes a plain tool-name collection, never a full _ActionClass (round 3,
    D clarified) — so chat.py's capability-relay check can call this SAME
    definition of "attempted" per tool name, instead of keeping a second one
    of its own that could drift from it (its call site below passes
    `cls.tools`).

    A REFUSED call is not an attempt: a call written as markup, or made in a
    closed round, is recorded as a tool span (ok=False) so the trace shows it,
    but nothing ran — and the redirect would happily regenerate it with tools.
    Read from the flag the refusal itself writes (`refused_*` in the span's
    meta, chat._refuse_call), never a list of reasons kept here.

    A check the BACKEND ran unasked (live_facts' `meta["unasked"] = True`)
    IS counted here, exactly as before round 3 (review fix round 4, item 1):
    it really ran this turn, so an offer beside the listing it produced is
    about what comes next, not the instruction handed back. "Not her call"
    matters only to chat._failed_tool_names (the capability relay), which
    drops those spans itself before asking this function."""
    for span in spans:
        if getattr(span, "kind", None) != "tool" or getattr(span, "name", None) not in tools:
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
            # B (round 2): an INSTRUCTION reads the narrow _SETUP_QR_INSTRUCTS,
            # never cls.pattern (the broad offer form) — "send me the link,
            # not a QR code" would otherwise instruct through its own bounded
            # bridge, with "not" inside the match rather than before it.
            search_pattern = _SETUP_QR_INSTRUCTS if cls is _SHOW_SETUP_QR else cls.pattern
            for m in search_pattern.finditer(clause):
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
            if _attempted(cls.tools, spans):
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
            if any(_tool_ran(name, successful) for name in cls.keeps or (tool,)):
                # The reply said "let me search" and actually searched — by the
                # tool it names, or (S38, ruling G8) by any tool its class says
                # keeps it: before this only the first registered tool counted,
                # so an ok browser_open could not keep "I'll open that page".
                # Scoped to the classes that declare `keeps` (the fetch class),
                # so an "I'll set a reminder" kept only by list_timers stays a
                # deferral.
                continue
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
# successful device tool span ran this turn. (S40b adds a second subject, the
# MACHINES that run models, in chat and eval turns only — its own section below
# StateClaim; nothing in this paragraph changed for devices.) Both halves are
# mechanical:
#
#   * `device_names` is DERIVED at the call site from the paired machines
#     (chat._paired_device_names, through machines.plant(): the live registry,
#     or an eval replay's declared devices alone — S42b Task 24), never a list
#     kept here — a household with no paired devices can have no such claim,
#     so the guard never fires there, and pairing a machine arms it by itself.
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
#
# One tuple (S40b final fix wave, C13): the serving guard's set below is this
# one minus the negations, built structurally rather than by string surgery on
# the joined pattern.
_STATE_ADVERBS = (
    "still",
    "currently",
    "now",
    "again",
    "apparently",
    "probably",
    "likely",
    "definitely",
    r"no\s+longer",
    "back",
    "not",
    "already",
    "actually",
    "indeed",
)
_NEGATING_ADVERBS = ("not", r"no\s+longer")
_STATE_ADVERB = "(?:" + "|".join(_STATE_ADVERBS) + ")"
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
    """An unchecked assertion about the CURRENT state of a paired device or of
    a machine that runs models (S40b).

    `device` is the subject the reply named — a device reference, or a
    machine's name when `subject_kind` is "machine" — which is what the
    redirect nudge names back. `phrase` is the matched assertion for the guard
    span, and `text` the stated correction — the same shape the other guards'
    Correction carries, so the turn's composition reads it identically.
    `served_by` is set only when a NEGATIVE machine claim is contradicted by
    the round that wrote this reply, served on that machine; the correction
    then says so.
    """

    device: str
    phrase: str
    text: str = STATE_CLAIM_CORRECTION
    subject_kind: str = "device"
    served_by: str | None = None

    @property
    def evidence(self) -> str:
        """What the guard span records it fired on: a round the subject served
        this turn contradicting the claim, or no check of the subject at all."""
        return "served" if self.served_by else "unchecked"


# -- S40b: MACHINES as subjects ------------------------------------------------
#
# The S40 live walk (2026-09-19, turn b02a5694). Asked "Where do your models
# run, and is that machine ready?" a second time, she replayed the previous
# turn's machine_status reading from history — `Last Reported: 2026-09-19T05:
# 15:39`, twenty minutes old — as the machine's current status, and nothing in
# the turn had read the machine. The device branch above could not see it: a
# machine is not a paired device.
#
# The subjects are DERIVED from the turn's own spans (`machine_names`), never
# listed: a round the gateway says ran on an engine names the machine it ran on,
# and a machine_status/machine_configure call names what it read or set. So
# the guard needs no gateway call and no threading, and a machine nobody served
# or read this turn is not a subject (S44 adds gateway-listed names).
#
# Two claim shapes, per machine M, and one piece of evidence each:
#
#   * A NEGATIVE present state — "hub is switched off", "hub is not answering
#     right now". Fires when nothing read M this turn. A round M served this
#     turn is not a read, it is a CONTRADICTION — and when M served the round
#     that wrote the reply, the correction says so.
#   * A READING TIME — a `Last Reported: <timestamp>` line bound to M, or
#     "hub last reported at 05:15 UTC". Fires when nothing read M this turn: a
#     served round proves M answered, never when it was last read.
#
# A POSITIVE state never fires, by construction rather than by a rule: every
# derived machine was either read or served this turn, and a served round backs
# "hub is ready". test_state_guard pins that property; S44 is what breaks it.
#
# Armed only in STACK_CLAIM_KINDS (chat, and the eval that replays it), the
# kinds its precision was measured in over 649 real replies (s40b/design-
# verdict.md). Precision cuts, each pinned by the corpus: the name is matched
# case-exact, with edges that keep `hub:qwen3:8b` and `hub.example.com` out; the
# word before it must be one that can lead a machine's name ("on hub", "called
# hub") so "your USB hub" and "the smart-home hub" never match; code and quote
# blocks, and double-quoted spans, are someone else's text; every state word
# must END the claim (a place, a schedule or a count after it limits it); and
# the usual question, reported-speech, hedge, intent and prior-time cuts apply,
# plus a not-current cut — over a claim's whole sentence, and over a reading's
# whole run, heading and lead-in — for a reply that says it did not check.

STATE_CLAIM_MACHINE_CORRECTION = (
    "Correction: I did not check {machine} this turn — I have no record of doing so, "
    "so what I said about it is not a current reading."
)
# Appended when the claim was NEGATIVE and the machine served the round that
# WROTE this reply (_reply_served_by): the one thing about its state the turn
# proves, and the only served_by "this reply came from" may truthfully quote.
STATE_CLAIM_MACHINE_SERVED = " {machine} answered this turn: this reply came from {served_by}."

# Emphasis and code marks, stripped before matching. Never "_": `eval_box` is a
# machine's name.
_MD_NOISE = re.compile(r"[*`]+")
_NAME_LEFT = r"(?<![\w.-])"
# "hub." ends a sentence; "hub.example.com" is a host and "hub:qwen3:8b" a model.
_NAME_RIGHT = r"(?![\w-]|\.\w|:\w)"
# The words that may sit right before a machine's name. Checked in code (see
# _lead_ok): "Your USB hub", "The smart-home hub", "Jeremy's hub" are about
# something else, and this guard REPLACES what it corrects.
_MACHINE_LEAD_OK = frozenset(
    {
        "called",
        "named",
        "machine",
        "engine",
        "on",
        "at",
        "and",
        "or",
        "but",
        "so",
        "while",
        "because",
        "since",
        "also",
        "currently",
        "now",
        "today",
        "from",
        "via",
    }
)
# The trailing word of the text before a name, apostrophes and hyphens kept so
# "Jeremy's" and "smart-home" are read whole.
_LEAD_WORD = re.compile(r"(\w[\w'’-]*)$")
# Where an ambiguous positive state word must end to be a claim about the
# machine ("hub is ready." / "ready right now" / "ready for chat models"), and
# not "ready for you to add a model".
_ANCHOR_ENDS = (
    r"\s*(?:[.,;:!?)\]}—–]|$)|\s+(?:right\s+now|now|again|at\s+the\s+moment|and\b"
    r"|for\s+(?:chat\s+)?(?:models|chat|requests)\b)"
)
_MACHINE_ANCHOR = rf"(?={_ANCHOR_ENDS})"  # the verdict's, verbatim
# An OUTAGE word also ends at a clause connector or a present-time phrase (T1
# review, fix round 2): "hub is offline so I can't run local models", "…
# because its GPU is busy", "… which is why chat is slow", "… since 05:15 UTC",
# "… for now", "… at present", "… today." None of these limits the state. A
# degree "so" ("so often") is a frequency, "today" counts only where it ends
# the claim ("today at 18:00" is a schedule), and "as" is left out ("as a chat
# machine" is a role, "as of 05:15" a stamp).
_OUTAGE_ENDS = (
    r"so\b(?!\s+(?:often|rarely|seldom|frequently|much|many|long|little)\b)"
    r"|because\b|which\b|since\b|for\s+now\b|at\s+present\b|currently\b|as\s+of\s+now\b"
    r"|today(?=\s*(?:[.,;:!?)\]}—–]|$))"
)
_OUTAGE_ANCHOR = rf"(?={_ANCHOR_ENDS}|\s+(?:{_OUTAGE_ENDS}))"
# S40b final fix wave (A5): a SCOPE limits an outage wherever it is written.
# T1 cut the trailing "unreachable from your phone"; the same limit fronted —
# "Off the tailnet, hub is unreachable", "From your phone, …", "Publicly, …" —
# or written after an anchoring comma, dash or "right now" — "hub is offline,
# as far as your phone is concerned", "…unreachable right now from your
# phone", "…switched off for chat models on weekends" — was REPLACE-corrected.
# A fronted scope is a place or reach preposition over a determined noun
# phrase, closed by a comma; "For now,", "For the moment,", "To be clear,",
# "From what I can tell," and "Currently," are not scopes and still fire.
_SCOPE_DET = r"(?:the|your|my|his|her|their|our|a|an|any|every|each|some|this|that)"
_NOT_A_SCOPE = r"(?!(?:moment|time|record|rest|most|last|past|next|first|same)\b)"
# A SCOPE MUST NAME A REACH (S40b fix-wave follow-up). The first cut of A5 was
# "<place preposition> <determiner> <=40 characters>," minus a short exclusion
# list, which is the shape of every fronted discourse marker in English: "To
# your question, hub is offline.", "On that note, …", "For your information,
# …", "From my side, …" — 28 sentences that fired before A5 went silent with
# it in, on the state and memory branches alike. A limit only limits when it
# says WHERE: a place, a network, a device, a vantage. The word may sit
# anywhere in the phrase ("outside your home network", "the public
# internet's point of view"); a bare "side"/"end" is a reach only when it is
# someone ELSE's ("from your side" is his vantage, "from my side" is a
# stance, and "From my side, hub is offline." is a claim about hub).
_REACH_WORD = (
    r"(?:phones?|mobiles?|handsets?|laptops?|desktops?|tablets?|browsers?|screens?"
    r"|devices?|machines?|boxes?|servers?|hosts?"
    r"|networks?|lan|wan|subnets?|wi-?fi|vpn|tailnet|tailscale|internet|intranet|web"
    r"|router|gateway|firewall|proxy|dns|cloud|tunnel"
    r"|home|house|apartment|flat|office|desk|work|school|campus|room|garage"
    r"|car|road|hotel|cafe|caf[eé]|airport|abroad|overseas"
    r"|outside|inside|indoors|outdoors|public|private|world|here|there|away|elsewhere"
    r"|coverage|range|reach|vantage"
    r"|(?:your|that|their|his|her|its|the\s+other)\s+(?:side|end))"
)
# The reach word within the phrase the scope covers (bounded, so the lookahead
# cannot walk a long line: the phrase itself is at most 40 characters).
_HAS_REACH = rf"(?=[^,;:\n]{{0,48}}?\b{_REACH_WORD}\b)"
_FRONTED_SCOPE = re.compile(
    r"\W*+(?:(?:publicly|remotely|externally)"
    r"|(?:from|off|outside|beyond|over|across|via|through|within|inside|to|for|on)"
    rf"(?:\s+(?:outside|inside|within|beyond|off))?\s+{_HAS_REACH}{_SCOPE_DET}\s+"
    rf"{_NOT_A_SCOPE}[^,;:\n]{{1,40}}?)\s*,\s*$",
    re.I,
)
# What limits a state when it follows the anchor: a vantage ("as far as your
# phone is concerned" — never "as far as I know"), a place, a schedule, an
# exception. Never "for now", "to be clear" or "from what I can see", and a
# "from" naming her history is a history label, not a place (B2's "No change:
# X (from my previous answer)" still reaffirms X).
_NOT_HISTORY = (
    r"(?!(?:(?:my|the|our|this)\s+)?(?:(?:chat|conversation)\s+)?history\b"
    r"|(?:my|the)\s+(?:last|previous|earlier|first)\s)"
)
# The three branches that take an open noun phrase ("from …", "for/to <det>
# …", "per <det> …") carry the same reach requirement as the fronted scope
# (S40b fix-wave follow-up) — without it "hub is offline, for your
# information.", "…, from the look of it." and "…, per your question." were
# silenced exactly as the fronted markers were. "as far as X is concerned" is
# left open: that frame marks a vantage by itself.
_TRAILING_LIMIT = (
    rf"(?:as\s+far\s+as\s+(?!I\b|we\b)|from\s+(?!now\b|what\b){_NOT_HISTORY}{_HAS_REACH}"
    r"|by\s+(?:schedule|design)"
    r"|on\s+(?:weekends?|weekdays?|(?:a\s+)?schedule)|overnight|outside\b|except\b"
    r"|only\s+(?:from|for|to|on|at|when|during)\b|during\b"
    rf"|(?:for|to)\s+{_HAS_REACH}{_SCOPE_DET}\s+{_NOT_A_SCOPE}"
    rf"|in\s+the\s+(?:eyes|view)\s+of\b|per\s+{_HAS_REACH}{_SCOPE_DET}\b)"
)
# The anchoring separators a limit may follow (one or more), then the limit.
# Possessive throughout (D2): each separator run is taken whole.
_LIMITED_AFTER = re.compile(
    r"(?:\s*+(?:[,—–]|(?:right\s+now|now|at\s+the\s+moment"
    r"|for\s+(?:chat\s+)?(?:models|chat|requests))\b))++"
    rf"\s*+{_TRAILING_LIMIT}",
    re.I,
)
_MACHINE_NEG_WORDS = (
    r"(?:offline|disconnected|unreachable|not\s+reachable|out\s+of\s+contact"
    r"|powered\s+off|switched\s+off)"
)
# The positive words that are about the LINK — the ones a "not"/"no longer"
# turns into an outage claim, and the ones a device's status line carries.
_MACHINE_LINK_WORDS = r"(?:online|reachable|powered\s+on|switched\s+on|connected)"
# EVERY state word carries an anchor, the negative ones included (T1 review,
# fix round 1): "hub is unreachable from your phone", "hub is switched off
# overnight", "hub is offline twice a week" and "hub is not online on
# weekends" limit the state to a place, a schedule or a count — none says hub
# is down now, and this guard REPLACES what it corrects. The outage words take
# the outage anchor; "answering", "ready" and "serving" keep the verdict's,
# the one the corpus measured them with ("not ready since you have not added a
# model" is readiness FOR something).
_MACHINE_NEG = rf"{_MACHINE_NEG_WORDS}{_OUTAGE_ANCHOR}"
_MACHINE_POS = (
    rf"(?:{_MACHINE_LINK_WORDS}{_OUTAGE_ANCHOR}|(?:answering|ready|serving){_MACHINE_ANCHOR})"
)
_MACHINE_NEG_STATE = re.compile(_MACHINE_NEG_WORDS, re.I)
# A line that states something's connectivity. One that names no machine is
# some other thing's status line, so a reading under it is that thing's —
# unless it is the block's OWN attribute line (below).
_CONNECTIVITY_WORD = re.compile(rf"\b(?:{_MACHINE_NEG_WORDS}|{_MACHINE_LINK_WORDS})\b", re.I)
# A connectivity line that has no subject of its own, and so belongs to whatever
# heads its block (T1 review, fix round 2: b02a5694's block with a "- Status:
# Offline" line under `Name: hub` went unbound, and machine_status's own
# "switched off for models" with it). Either the key is a generic attribute
# and the value BEGINS with a state ("- Status: 🟢 Online", "- Reachable: Yes",
# "- Power: Powered on"; never "- Status: the Dell is offline" or "- Dell:
# offline"), or the line is nothing but an anchored state ("- 🟢 Online"; never
# "- Offline devices: Dell").
_ATTRIBUTE_KEY = (
    r"(?:(?:current|overall|machine|connection|network|power|link)\s+)?"
    r"(?:status|state|connection|connectivity|network|reachable|reachability|power"
    r"|online|availability|link|health)"
)
# Possessive (S40b final fix wave, D2): with `^\s*(?:…)?\s*` the two runs of
# leading padding overlap, and _KEY_VALUE_LINE's key and `\s*` after it add two
# more — 0.4 s for a line of 200 spaces, and no answer at 1,000. A key never
# begins with whitespace, so nothing is given back that could matter.
_LINE_LEAD = r"^\s*+(?:[-+•]|\d+[.)])?\s*+(?:[^\w\s]++\s*+)?"
_OWN_STATE_LINE = re.compile(
    rf"{_LINE_LEAD}(?:"
    rf"{_ATTRIBUTE_KEY}\s*+[:=—–]\s*+[^\w\s]*+\s*+(?:(?:currently|now|still)\s+)?"
    rf"(?:(?:not|no\s+longer)\s+)?"
    rf"(?:{_MACHINE_NEG_WORDS}|{_MACHINE_LINK_WORDS}|yes|no|true|false|on|off)\b"
    rf"|(?:{_MACHINE_NEG_WORDS}|{_MACHINE_LINK_WORDS}){_OUTAGE_ANCHOR})",
    re.I,
)
# Any key/value line: the lines of one subject's block ("- Compute: Uses GPU
# …", "- Runtime: Containerized", "- Serving: On"). A colon or "=" only: "- Dell
# — the laptop" is a label with its description.
_KEY_VALUE_LINE = re.compile(rf"{_LINE_LEAD}[^:=\n]{{1,40}}?\s*+[:=]\s*+\S")
_NEGATING_ADVERB = re.compile(r"\b(?:" + "|".join(_NEGATING_ADVERBS) + r")\b", re.I)
# A reading's time: an ISO-ish stamp, a clock time with its zone, or "just now".
_READING_TS = (
    r"(?:\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?"
    r"(?:\s*(?:Z|UTC|[+-]\d{2}:?\d{2}))?"
    r"|\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:UTC|Z|am|pm)\b|just\s+now)"
)
# "Last updated" is deliberately absent: a catalogue lists "vetted"/"updated"
# dates that are not readings of a machine.
_READING_KEY = (
    r"(?:last\s+(?:reported|checked|seen|observed|read|heard(?:\s+from)?|contact(?:ed)?)"
    r"|(?:reported|checked|observed|seen|read)\s+at|checked)"
)
# `\s*+` twice: each run of spaces sits beside an optional group that cannot
# start with a space, so a possessive run matches exactly what a greedy one did
# — without trying every split of it (quadratic: 88 ms for one 1,500-space line,
# through `.match`, the way the reading walk calls it).
_READING_LINE = re.compile(
    rf"^\s*+(?:[-+•]|\d+[.)])?\s*(?P<key>{_READING_KEY})\s*[:=]\s*+[^\w\s]{{0,6}}\s*"
    rf"(?P<ts>{_READING_TS})",
    re.I,
)
# A line that names what the lines under it are about ("- Name: …"). One that
# names no machine ends the upward walk unbound.
_SUBJECT_KEY_LINE = re.compile(
    r"^\s*+(?:[-+•]|\d+[.)])?\s*(?:name|machine|engine|host|device)\s*[:=]", re.I
)
# The history stamp's own words (S40b final fix wave, A3). chat builds every
# stamp it hands her from these (_PAST_TURN_MARKERS, _RECORD_KIND_MARKER,
# _LIVE_READING_MARKER), and the not-current cut below reads the same pieces:
# T3's stamp told her a replayed row was "a record of that moment, not of now"
# and T1's cut did not know the words, so the reply that labelled a reading
# exactly as it had been labelled to her was REPLACE-corrected. One constant,
# read by both halves, so the two cannot drift apart again.
_STAMP_MOMENT = "record of that moment"
_STAMP_NOT_NOW = "not of now"
_STAMP_TAKEN_THEN = "taken then"
HISTORY_STAMP_RECORD = f"a {_STAMP_MOMENT}, {_STAMP_NOT_NOW}"
HISTORY_STAMP_READINGS = f"from readings {_STAMP_TAKEN_THEN}"


def _phrase(words: str) -> str:
    """A fixed phrase as a pattern: its words escaped, any whitespace between."""
    return r"\s+".join(re.escape(word) for word in words.split())


# "have/has/did not", as the not-current forms below open.
_NOT_DONE = r"(?:have|has|did)(?:\s+not|n['’]t)"
# A reading the reply itself says is not current.
#
# S40b final fix wave, A2: the verdict's cut knew only "check". The machine
# nudge asks her to "say plainly that you did not check", and the other plain
# ways of saying it — not verified, not confirmed, not looked at, not re-read,
# "unverified" — and the common staleness labels — "last known", "most recent
# reading", "(old reading)", "may no longer hold", "(20 min ago)", "when I last
# looked" — were REPLACE-corrected, and a regeneration that said them refused.
# The widening stops at the READING: a bare "haven't read" or "haven't run" is
# about anything ("…read your notes", "…run the backup"), so "run" counts only
# with a machine-read tool's name (_not_run_a_machine_read), "read" only as
# "re-read", and "last checked/read" only after "I" — "Last Checked:" and
# "Last read:" are reading KEYS (_READING_KEY), which the cut must not eat.
_NOT_CURRENT = re.compile(
    r"\b(?:not\s+(?:re-?)?checked|(?:have|has)(?:\s+not|n['’]t)\s+(?:re-?)?checked"
    r"|did(?:\s+not|n['’]t)\s+(?:re-?)?check|without\s+(?:re-?)?checking"
    r"|could(?:\s+not|n['’]t)\s+(?:be\s+)?(?:check|read|reach|ask)\w*|unchecked|stale"
    r"|out\s+of\s+date|may\s+have\s+changed|not\s+(?:a\s+)?(?:current|fresh|live)"
    rf"|{_NOT_DONE}\s+(?:re-?)?(?:verif|confirm)\w*"
    rf"|{_NOT_DONE}\s+(?:re-?)?look(?:ed)?\s+at|{_NOT_DONE}\s+re-?read"
    r"|not\s+(?:been\s+)?(?:re-?)?(?:verified|confirmed)|un(?:verified|confirmed)"
    r"|last\s+known|most\s+recent\s+reading|old(?:er)?\s+reading|may\s+no\s+longer"
    r"|(?:mins?|hrs?)\s+ago|I\s+last\s+(?:looked|read|saw|checked)"
    rf"|{_phrase(_STAMP_MOMENT)}|{_phrase(_STAMP_NOT_NOW)}|{_phrase(_STAMP_TAKEN_THEN)}"
    r")\b",
    re.I,
)


@lru_cache(maxsize=8)
def _not_run_pattern(names: tuple[str, ...]) -> re.Pattern[str]:
    """The "I have not run machine_status" form — for one set of machine-read tool
    names, cached like _machine_patterns."""
    alternation = "|".join(re.escape(name) for name in sorted(names, key=len, reverse=True))
    return re.compile(
        rf"\b{_NOT_DONE}\s+(?:re-?)?(?:run|ran|called|used)\s+(?:the\s+)?(?:{alternation})\b",
        re.I,
    )


def _says_not_current(text: str) -> bool:
    """Does `text` say what it reports is not current (_NOT_CURRENT), or that
    she has not run a tool that reads a machine — the read set DERIVED from
    the registry (_machine_read_tools), never retyped here?"""
    if _NOT_CURRENT.search(text) is not None:
        return True
    names = tuple(sorted(_machine_read_tools()))
    return bool(names) and _not_run_pattern(names).search(text) is not None


# A stamp she copied to the START of her reply (S40b final fix wave, C7): a
# bracket that ends in the stamp's own record phrase. The persist boundary
# strips it (chat._persist_assistant) — it is the backend's label on an OLDER
# row, and its time is that row's — and every claim scan reads the reply the
# same way (_machine_lines), so no guard honours a label the record will not
# carry (final-review #3's caveat): a replay under a copied leading stamp is
# persisted bare, and is judged bare.
_LEADING_STAMP = re.compile(rf"\A\s*+\[[^\[\]\n]*{_phrase(HISTORY_STAMP_RECORD)}\]\s*+", re.I)


def without_leading_stamp(text: str) -> str:
    """`text` without a stamp-shaped bracket at its very start (see
    _LEADING_STAMP). Nothing else is touched: a stamp she quotes later in
    the reply labels what it sits beside."""
    return _LEADING_STAMP.sub("", text, count=1)


# A line that is wholly one bracketed label — "[written at … ; a record of
# that moment, not of now]", "(from readings taken then)". Above a reading's
# run it is a lead-in, like a line ending in ":" (A3: the stamp above a
# heading was never read).
_BRACKET_LINE = re.compile(r"^\s*[\[(][^\n]*[\])]\s*$")
# S40b T4 review, fix round 1: her own earlier reply — "my last reply", "the
# previous answer", "in the previous turn". What she said then, named as then.
# The v15 case seeds the walk's replay as her history, and the honest answer
# labels it so. "The last response FROM hub" is a message from the machine, not
# her reply. Shared with the served and memory guards' own claim cut.
_HER_EARLIER_REPLY = (
    r"\b(?:my|the)\s+(?:last|previous|earlier|first)\s+"
    r"(?:reply|answer|message|response|turn)\b(?!\s+from\b)"
)
# S40b T4 review, fix round 2: a MENTION of her earlier reply is not a label.
# Round 1 cut on any mention, so a claim that cites her history to say the
# state holds NOW went silent: "As I said in my last reply, X", "Correction to
# my last reply: X", "(unchanged from my last reply)", "X, same as in my last
# reply", "Since the last turn, X". A history LABEL is one of:
#   * an attribution: "from history", "(from my previous answer)", "(as of my
#     last reply)", "Recap of my last reply:", "My last reply's status block:";
#   * her earlier reply reported: "my previous answer said/showed X", or her
#     own report located in it: "the reading I gave in my last reply";
#   * a heading at the start of a line or clause: "My previous answer:", "In
#     the previous turn:", "From my previous answer:", "As of my last reply,",
#     "According to / Based on / Going by my last reply,", "Quoting my last
#     reply:".
# The first two never count after a word that says the state is the same, new
# or compared, or that restates or corrects it: "unchanged from", "different
# from", "updated from", "as/like/unlike/since … in/from", "As my last reply
# said", "Correction to / Update on my last reply's reading".
# A label reaches only up to a retraction or a "still holds" (_report_closed),
# and a claim reaffirmed after it is hers again (_reaffirmed). Shared by the
# machine branch below and the served and memory guards' claim cut:
# _labelled_as_history, _history_framed.
# Fix round 3: a "still holds" or a reaffirmation she DOUBTS is neither ("I'm
# not sure that is still true", "(not sure it still holds)"; _vouched), and a
# HEADING is not a lead ("Correction: my previous answer said X" labels X).
_HISTORY_SOURCE = (
    r"(?:(?:(?:my|the|our|this)\s+)?(?:(?:chat|conversation)\s+)?history\b"
    rf"|{_HER_EARLIER_REPLY})"
)
_FROM_HISTORY = re.compile(rf"\b(?:from|as\s+of)\s+{_HISTORY_SOURCE}", re.I)
# The attributions a label reads anywhere: the above, a recap or copy OF her
# history ("Recap of my last reply:"), and its possessive ("My last reply's
# status block:").
_HISTORY_ATTRIBUTION = re.compile(
    rf"\b(?:from|as\s+of|(?:recap|summary|copy|excerpt|quote)\s+of)\s+{_HISTORY_SOURCE}"
    rf"|{_HER_EARLIER_REPLY}['’]s\b",
    re.I,
)
_HER_REPLY_REPORTED = re.compile(
    rf"{_HER_EARLIER_REPLY}\s+(?:said|says|stated|states|claimed|claims|named|names|marked"
    r"|marks|listed|lists|showed|shows|reported|reports|read|reads|called|calls|wrote|gave)\b"
    r"|(?<![\w'’])I\s+(?:gave|showed|shown|reported|wrote|listed|said|stated|marked|posted"
    rf"|shared|quoted|put)\b[^.;:!?\n]{{0,40}}?\bin\s+{_HER_EARLIER_REPLY}",
    re.I,
)
_HISTORY_HEAD = re.compile(
    r"^[^\w]*(?:(?:in|from|as\s+of|according\s+to|based\s+on|going\s+by|quoting)\s+"
    rf"{_HER_EARLIER_REPLY}|{_HER_EARLIER_REPLY}\s*:)",
    re.I,
)
# A word that says the state changed, or corrects or updates it, leads a
# label only when it runs INTO it, through a space or a preposition:
# "Correction to my last reply's reading:", "Update on my last reply's
# status:", "Correcting my last reply's reading:", "(updated from my last
# reply)", "Nothing changed from my last reply:". Stood alone and closed by a
# colon, dash or comma it is a HEADING, and the label under it is a label:
# "Correction: my previous answer said X. …", "Update — from my previous
# answer:", "As a correction, my last reply said X" (T4 review, fix round 3;
# round 2's "\W*$" let the heading lead). A word that says the state is the
# same, or compares it, keeps any join: "(**unchanged** from my last reply)",
# "Unchanged: my previous answer said X" (X is stated as current).
_CORRECTION_NOUN = r"(?:corrections?|updates?|fix(?:es)?|amendments?)"
_NOT_A_LABEL_LEAD = re.compile(
    r"(?:\bunchanged"
    rf"|\b(?:as|like|unlike|since)(?!\s+(?:an?\s+)?{_CORRECTION_NOUN}\b)(?:\s+[\w'’]+){{0,2}}"
    r")\W*$"
    r"|\b(?:changed?|changes|different(?:ly)?|differs?|varies|vary|new|updated|correcting"
    rf"|updating|fixing|amending|{_CORRECTION_NOUN})"
    r"(?:\s+(?:to|on|of|for|from))?[\s*(\[]*$",
    re.I,
)
# What she says of an earlier claim right after it: "I told you X, which was
# wrong." / "I said X. That was stale." / "… — it isn't." (T4 review, fix
# round 1; the served and memory guards' "I said" cut reads it too.)
_RETRACTED = re.compile(
    r"\b(?:that|which|this|it)\s*(?:was|is|['’]s)"
    r"(?:\s+(?:(?:simply|just|plainly|also)\s+)?(?:wrong|false|incorrect|mistaken|untrue|stale"
    r"|outdated|out\s+of\s+date|a\s+mistake|an\s+error)\b"
    r"|(?:\s+not|n['’]t)(?:\s+(?:true|right|correct|accurate|current))?"
    r"(?=\s*(?:[.!;,:)—–-]|$)))",
    re.I,
)
# A label reaches a claim only if nothing between them says what it labels
# was WRONG ("My last reply named hub:qwen3:8b, which is wrong — X": X is said
# anew; "In my last reply I was wrong: X") or still holds ("What I said in my
# last reply still holds: X"; _STILL_HOLDS, when she vouches for it). Never a
# staleness word — "(it isn't current)", "which is outdated": that the
# labelled reading is old is the label's point, so _RETRACTED's "stale"/"not
# current" class does not close it.
_REPORT_CLOSED = re.compile(
    r"\b(?:that|which|this|it)\s*(?:was|is|['’]s)"
    r"(?:\s+(?:(?:simply|just|plainly|also)\s+)?(?:wrong|false|incorrect|mistaken|untrue"
    r"|a\s+mistake|an\s+error)\b"
    r"|(?:\s+not|n['’]t)(?:\s+(?:true|right|correct|accurate))?(?=\s*(?:[.!;,:)—–-]|$)))"
    r"|\bI\s+was\s+(?:wrong|mistaken)\b|\bI\s+got\s+(?:it|that|this)\s+wrong\b",
    re.I,
)
_STILL_HOLDS = re.compile(
    r"\bstill\s+(?:holds|stands|applies|true|valid|current|the\s+case)\b", re.I
)
# …and a claim she reaffirms after it is hers again: "…, and that is still
# true", "That is still the case.", "which remains true", "it still holds".
# Said of it — a pronoun, and the sentence ends there: "It is still the case
# that recall answered" is about something else.
_REAFFIRMED = re.compile(
    r"\b(?:that|which|this|it)\s*(?:(?:is|['’]s|remains)\s+still"
    r"(?:\s+(?:true|right|correct|accurate|current|valid|the\s+case|so))?"
    r"|still\s+(?:is|holds|stands|applies)(?:\s+(?:true|the\s+case))?"
    r"|(?:remains|holds|stands)\s+(?:true|correct|accurate|valid|the\s+case))"
    r"(?=\s*(?:[.!;,:)—–-]|$))",
    re.I,
)
# "Not sure WHY X" / "don't know how X" presuppose X, so they do not doubt it.
# (Shared with the served and memory guards' _EPISTEMIC_FRAME.)
_WH_WORD = r"(?!\s+(?:why|how|when|where|what|which|who)\b)"
# T4 review, fix round 3: a reaffirmation or a "still holds" she DOUBTS says
# the opposite — "I'm not sure that is still true", "I can't tell you whether
# that is still accurate", "Whether that is still the case, I can't say",
# "(not sure it still holds)". Round 2 read each as her vouching for the claim,
# so the canonical honest answer, her old line labelled and then doubted, was
# corrected. What doubts it, ahead of it in its clause (_vouched): a doubted
# belief (_EPISTEMIC_FRAME), not knowing or not being able to tell, say or
# confirm, "unclear", and a "whether"/"if" right before it ("If you're asking,
# that is still true" is not led by its "if").
_DOUBTED = re.compile(
    r"(?:\bnot|n['’]t|\bcannot|\bunable\s+to)\s+(?:(?:be(?:en)?\s+)?able\s+to\s+)?"
    r"(?:know|tell|say|confirm(?:ed)?|verif(?:y|ied)|check(?:ed)?|guarantee|promise|vouch"
    rf"|be\s+(?:sure|certain))\b{_WH_WORD}"
    r"|\b(?:unclear|unknown|no\s+idea|hard\s+to\s+(?:say|tell|know))\b"
    r"|(?:\bnot|n['’]t)\s+clear\b"
    # S40b final fix wave (B1, the T4 breaker's OPEN-1): the doubt may name
    # what it doubts — "(if it still holds)", "(whether that still holds I
    # can't say)" — and was read as her vouching for the label's reading.
    r"|\b(?:whether|if)(?:\s+or\s+not)?(?:\s+(?:it|that|this|which))?\s*$",
    re.I,
)
# S40b final fix wave (B2, the T4 breaker's OPEN-2): a NEGATED-SAMENESS head
# — "No change:", "Nothing has changed —", "Nothing new —", "No updates:" —
# says the state is the same NOW, so a history label under it does not make
# the claim a record of then: it reaffirms it, like "…, and that is still
# true". Read on what leads up to a claim (_history_framed) and on a
# reading's context (_not_a_current_reading).
_SAME_HEAD = re.compile(
    r"(?:^|[.;:—–]\s)\W*(?:no\s+(?:changes?|updates?)|nothing\s+(?:has\s+)?(?:changed|new))\b",
    re.I,
)
# S40b final fix wave (A4): a line attributed to HIS notes or journal is his
# record read back, not her claim — "Your notes say X", "An older note says
# X", "A note of yours reads: X", "According to/Per your notes, X", "From your
# notes: X". Recall hands her his notes, and verdict §9 records that they carry
# exactly the walk's false lines (qwen3.8:27b as current, "No model was
# needed…"), so the honest way to cite and retract one was corrected. A
# reaffirmation after it ("…, and that is still true") makes it hers again.
_RECORD_NOUN = r"(?:notes?|journal(?:\s+entr(?:y|ies))?|entry|entries|records?)"
_RECORD_DET = r"(?:your|my|his|her|the|an?|one|older|old|this|that|these|those)"
_RECORD_ATTRIBUTION = re.compile(
    rf"\b{_RECORD_DET}\s+(?:[\w'’-]+\s+){{0,3}}?{_RECORD_NOUN}(?:\s+of\s+(?:yours|mine|his))?\s+"
    r"(?:say|says|said|read|reads|list|lists|listed|claim|claims|claimed|call|calls|called"
    r"|mark|marks|marked|state|states|stated|show|shows|showed)\b"
    rf"|\b(?:according\s+to|per)\s+{_RECORD_DET}\s+(?:[\w'’-]+\s+){{0,2}}?{_RECORD_NOUN}\b"
    rf"|\bfrom\s+{_RECORD_DET}\s+(?:[\w'’-]+\s+){{0,2}}?{_RECORD_NOUN}\s*[:—–]",
    re.I,
)
# S40b final fix wave (A12): what she says of a claim right AFTER it, in its
# own clause, retracting it — "(incorrect — it's qwen3:8b)", "(outdated)",
# "— this was wrong", "(which is wrong)". The pronoun forms are _RETRACTED's;
# a bare bracketed verdict uses the same words (_WRONG_WORDS), no new label.
_WRONG_WORDS = (
    r"(?:wrong|false|incorrect|mistaken|untrue|stale|outdated|out\s+of\s+date"
    r"|no\s+longer\s+(?:true|current|accurate))"
)
_BRACKETED_RETRACTION = re.compile(rf"\(\s*(?:simply\s+|just\s+)?{_WRONG_WORDS}\b", re.I)
# S40b final fix wave (C11): a markdown strikethrough on one line — visibly
# retracted when rendered, so never her claim (and no lie can hide in one).
_STRUCK = re.compile(r"~~[^~\n]+~~")
_HEADING = re.compile(r"^\s*#{1,6}\s")
_FENCE = re.compile(r"^\s*(?:```|~~~)")
# A double-quoted span on one line: someone else's words ("Your note reads
# “hub is offline…”"), never her claim — blanked for the sentence scan.
_QUOTED = re.compile(r"\"[^\"\n]*\"|“[^”\n]*”")


def _span_meta(span: Any) -> Mapping[str, Any]:
    meta = getattr(span, "meta", None)
    return meta if isinstance(meta, Mapping) else {}


def _ok_tool_span(span: Any, names: frozenset[str]) -> bool:
    return (
        getattr(span, "kind", None) == "tool"
        and getattr(span, "name", None) in names
        and _span_meta(span).get("ok") is True
    )


def _machine_arg(span: Any) -> str | None:
    """The `machine` argument a machine tool was called with; "" when the call
    named none; None when the argument record cannot be read (a flooded record
    degrades to a clipped string — lenient, like _target_of)."""
    args = _span_meta(span).get("args_redacted")
    if not isinstance(args, Mapping):
        return None
    machine = args.get("machine")
    return machine.strip() if isinstance(machine, str) else ""


def _fact_machines(span: Any) -> list[str]:
    facts = _span_meta(span).get("facts")
    if not isinstance(facts, list):
        return []
    return [
        fact["machine"].strip()
        for fact in facts
        if isinstance(fact, dict) and isinstance(fact.get("machine"), str)
    ]


def _engine_served_head(span: Any) -> str | None:
    """The machine an error-free round RAN ON, when the gateway said it ran on
    an engine: `local` in its usage, or a served-on/served-runtime stamp (the
    stamp is omitted past a 2 s budget, `local` is not). None for a cloud
    round, a failed one, or one that says nothing about where it ran."""
    if getattr(span, "kind", None) != "llm_call":
        return None
    meta = _span_meta(span)
    if meta.get("error"):
        return None
    if not (meta.get("local") is True or meta.get("served_on") or meta.get("served_runtime")):
        return None
    served_by = meta.get("served_by")
    if not isinstance(served_by, str):
        return None
    head, sep, _rest = served_by.partition(":")
    return head.strip() if sep else None


def machine_names(spans: Sequence[Any]) -> tuple[str, ...]:
    """The machines this turn can say something checkable about — DERIVED from
    its own spans, never a list (S40b). The union of:

      * the machine an error-free round ran on (`_engine_served_head`);
      * each machine an ok machine_status reported (`facts[].machine`);
      * the `machine` argument of an ok machine_status or machine_configure.

    A failed span adds nothing: a refused call's argument can name a machine
    that does not exist. Names shorter than two characters are dropped. Public
    so chat.py can record how many there were on the guard span."""
    found: set[str] = set()
    reads = _machine_read_tools()
    for span in spans:
        head = _engine_served_head(span)
        if head:
            found.add(head)
        if _ok_tool_span(span, reads):
            found.update(_fact_machines(span))
        if _ok_tool_span(span, reads | _CONFIGURE_TOOLS):
            arg = _machine_arg(span)
            if arg:
                found.add(arg)
    return tuple(sorted(name for name in found if len(name) >= 2))


def other_machine_names(spans: Sequence[Any], purpose: str) -> tuple[str, ...]:
    """The machines and devices this turn's spans name OTHER than the one whose
    round wrote the reply (stack-claim epic T1) — DERIVED from the spans,
    never a list. The union of:

      * machine_names(spans);
      * the `device` argument of every device_* tool span whose executor ran
        (reached_executor true — even a failed launch names a real device; a
        dispatch refusal's argument may name nothing that exists);
      * each `facts[].device` any tool span recorded;

    minus the engine head of the round that wrote the reply: the LAST
    error-free llm_call of `purpose` (a cloud round subtracts nothing).
    Exact-string subtraction; names shorter than two characters dropped."""
    found: set[str] = set(machine_names(spans))
    reply_round: Any = None
    for span in spans:
        kind = getattr(span, "kind", None)
        meta = _span_meta(span)
        if kind == "llm_call":
            if meta.get("purpose") in (None, purpose) and not meta.get("error"):
                reply_round = span
            continue
        if kind != "tool":
            continue
        name = getattr(span, "name", None)
        if (
            isinstance(name, str)
            and name.startswith("device_")
            and meta.get("reached_executor") is True
        ):
            args = meta.get("args_redacted")
            device = args.get("device") if isinstance(args, Mapping) else None
            if isinstance(device, str):
                found.add(device.strip())
        facts = meta.get("facts")
        if isinstance(facts, list):
            found.update(
                fact["device"].strip()
                for fact in facts
                if isinstance(fact, dict) and isinstance(fact.get("device"), str)
            )
    for aliases in _known_as(spans).values():
        found.update(aliases)
    own = _engine_served_head(reply_round) if reply_round is not None else None
    if own:
        found.discard(own)
    found.difference_update(_hub_names(spans))
    return tuple(sorted(name for name in found if len(name) >= 2))


def _known_as(spans: Sequence[Any]) -> dict[str, set[str]]:
    """Each device's other names, as its device call recorded them on the
    span's facts (`known_as`, stack-claim epic T3: the paired name, the row's
    hostname, the remote providers that map to it) — keyed by the fact's
    device. Strings only, stripped, two characters or more."""
    found: dict[str, set[str]] = {}
    for span in spans:
        if getattr(span, "kind", None) != "tool":
            continue
        facts = _span_meta(span).get("facts")
        if not isinstance(facts, list):
            continue
        for fact in facts:
            if not isinstance(fact, dict) or not isinstance(fact.get("device"), str):
                continue
            aliases = fact.get("known_as")
            if not isinstance(aliases, list):
                continue
            found.setdefault(fact["device"].strip(), set()).update(
                alias.strip()
                for alias in aliases
                if isinstance(alias, str) and len(alias.strip()) >= 2
            )
    return found


def _hub_names(spans: Sequence[Any]) -> tuple[str, ...]:
    """The hub's own computer by every name this turn's spans give it: each
    hub_devices device and the known_as its device calls recorded."""
    hubs = hub_devices(spans)
    if not hubs:
        return ()
    aliases = _known_as(spans)
    found = set(hubs)
    for hub in hubs:
        found.update(aliases.get(hub, ()))
    return tuple(sorted(found))


# What device_list says of a paired device whose agent reached the hub through
# its own loopback door (tools/devices.py _agent_line): her own computer. The
# door is the one fact core records about which paired device is the hub's.
_HUB_DOOR = "came in through the hub machine's own door"


def hub_devices(spans: Sequence[Any]) -> tuple[str, ...]:
    """The paired devices this turn's spans say are the hub's OWN computer
    (stack-claim epic T2) — DERIVED: a device a tool span's facts name whose
    line in that span's result_head ("- <name> (…") carries the hub-door
    words. Never another machine. A result_head clipped before the line names
    nothing (fails toward the device staying in other_machine_names)."""
    found: set[str] = set()
    for span in spans:
        if getattr(span, "kind", None) != "tool":
            continue
        meta = _span_meta(span)
        head = meta.get("result_head")
        facts = meta.get("facts")
        if not isinstance(head, str) or _HUB_DOOR not in head or not isinstance(facts, list):
            continue
        lines = [line for line in head.splitlines() if _HUB_DOOR in line]
        for fact in facts:
            device = fact.get("device") if isinstance(fact, dict) else None
            if not isinstance(device, str) or not device.strip():
                continue
            lead = f"- {device.strip()} ("
            if any(line.lstrip().startswith(lead) for line in lines):
                found.add(device.strip())
    return tuple(sorted(found))


@lru_cache(maxsize=64)
def _machine_name_pattern(names: tuple[str, ...]) -> re.Pattern[str]:
    """One case-insensitive, whole-word alternation over `names` (stack-claim
    epic T2): re.escape'd, longest-first, built once per names tuple. Whole
    word = not touching [A-Za-z0-9_-] on either side, so "DELL-XPS-8950" is
    one name, "the Dell's" names "dell", and "GitHub" never names "hub". A
    literal alternation behind fixed-width lookarounds: linear in the text."""
    alternation = "|".join(re.escape(name) for name in sorted(names, key=len, reverse=True))
    return re.compile(rf"(?<![\w-])(?:{alternation})(?![\w-])", re.I)


def _machine_read(spans: Sequence[Any], machine: str) -> bool:
    """Did this turn READ `machine`? An ok machine read (_machine_read_tools:
    machine_status, inference_health, route_explain) that asked for every
    machine or for this one (or reported it), asked or unasked, facts or none —
    or an ok machine_configure that set it. A record that cannot be read backs
    the claim rather than risk correcting an honest reply (_target_of's rule)."""
    reads = _machine_read_tools()
    for span in spans:
        if _ok_tool_span(span, reads):
            arg = _machine_arg(span)
            if not arg or arg == machine or machine in _fact_machines(span):
                return True
        elif _ok_tool_span(span, _CONFIGURE_TOOLS):
            arg = _machine_arg(span)
            if arg is None or arg == machine:
                return True
    return False


def _reply_served_by(spans: Sequence[Any], purpose: str | None) -> str | None:
    """The `served_by` of the round that WROTE the reply: the turn's last
    error-free round of its own purpose (served_this_turn's rule — a judge's or
    a redirect's round is the backend's, never the reply). None when that round
    carries no served_by.

    Only this round may be quoted as "this reply came from …" (T1 review, fix
    round 1): an earlier round on the machine, or a judge round it served, is a
    true fact about the turn and a false one about the reply."""
    writer: str | None = None
    for span in spans:
        if getattr(span, "kind", None) != "llm_call":
            continue
        meta = _span_meta(span)
        if meta.get("error") or meta.get("purpose") not in (None, purpose):
            continue
        served_by = meta.get("served_by")
        writer = served_by if isinstance(served_by, str) else None
    return writer


@lru_cache(maxsize=64)
def _machine_patterns(
    names: tuple[str, ...],
) -> tuple[re.Pattern[str], re.Pattern[str], re.Pattern[str]]:
    """(mention, state assertion, last-reading prose) for one set of machine
    names — a pure function of the names, cached like _state_patterns. The
    name is matched CASE-EXACT inside an otherwise case-blind pattern."""
    alternation = "|".join(re.escape(name) for name in sorted(names, key=len, reverse=True))
    subject = rf"{_NAME_LEFT}(?P<mach>(?-i:{alternation})){_NAME_RIGHT}"
    mention = re.compile(subject)
    assertion = re.compile(
        rf"{subject}(?:\s*\([^()\n]{{1,40}}\))?(?:\s*,?\s+(?P<which>which))?"
        rf"(?:\s+{_PRESENT_COPULA}|['’]s)(?P<adv>(?:\s+{_STATE_ADVERB})*)"
        rf"\s+(?P<state>{_MACHINE_NEG}|{_MACHINE_POS})",
        re.I,
    )
    last_reading = re.compile(
        rf"{subject}\s+(?:is\s+|has\s+been\s+)?last\s+(?:reported|checked|seen|read"
        rf"|heard\s+from)\b\s*(?:at|on|:)?\s*{_READING_TS}",
        re.I,
    )
    return mention, assertion, last_reading


@lru_cache(maxsize=64)
def _device_mention(names: tuple[str, ...]) -> re.Pattern[str] | None:
    if not names:
        return None
    alternation = "|".join(re.escape(name) for name in sorted(names, key=len, reverse=True))
    return re.compile(rf"(?<![\w.-])(?:{alternation})(?![\w-])", re.I)


def _lead(text: str, start: int) -> tuple[str, bool] | None:
    """The word right before a name at `start`, lowercased, and whether it
    opens `text` (only punctuation or markdown before it); None when no word
    sits right before the name."""
    before = text[:start].rstrip()
    lead = _LEAD_WORD.search(before) if before else None
    if lead is None:
        return None
    return lead.group(1).lower(), not re.search(r"\w", before[: lead.start()])


def _lead_ok(text: str, start: int) -> bool:
    """May the word right before a name at `start` lead a machine's name?
    Nothing, punctuation or markdown before it is fine; a word must be one of
    _MACHINE_LEAD_OK, or end in -ly and OPEN the text ("Currently hub is…").
    S40b final fix wave (C1): an -ly word inside a phrase is an adjective, so
    "the family hub" is some other hub."""
    lead = _lead(text, start)
    if lead is None:
        return True
    word, opens = lead
    return word in _MACHINE_LEAD_OK or (opens and word.endswith("ly"))


# S40b final fix wave (A10): a PREPOSITION before the name makes it that
# preposition's object — "qwen3.8:27b on hub is not answering", "Chat via hub
# is unreachable", "Your Plex server on hub is offline" are about the model,
# the route and the server. Such a lead binds a machine as the copula's subject
# only in the relative form the corpus pins: "…run on hub, which is currently
# switched off".
_PREPOSITION_LEADS = frozenset({"on", "at", "from", "via"})


def _not_the_subject(clause: str, match: re.Match[str]) -> bool:
    """Is the machine in a state assertion not the subject of its copula (A10),
    or the assertion led by a clause-opening "while" — a hedge, not a claim
    about now (C1: "While hub is switched off, routing skips it")?"""
    lead = _lead(clause, match.start("mach"))
    if lead is None:
        return False
    word, opens = lead
    if word in _PREPOSITION_LEADS:
        return match.group("which") is None
    return word == "while" and opens


def _machine_mentioned(line: str, mention: re.Pattern[str]) -> str | None:
    for m in mention.finditer(line):
        if _lead_ok(line, m.start("mach")):
            return m.group("mach")
    return None


def _machine_lines(reply_text: str) -> list[str]:
    """The reply's lines as the machine branch reads them. A fenced block and a
    `>` quote are someone else's text, so their lines are blanked — kept, as
    empty lines, so a key/value run still ends where they begin — and emphasis
    and code marks are stripped from the rest. A stamp she copied to the start
    is dropped, as the persist boundary drops it (without_leading_stamp), and
    a struck ~~span~~ is emptied: she retracted it where he can see it."""
    lines: list[str] = []
    fenced = False
    for line in without_leading_stamp(reply_text).split("\n"):
        if _FENCE.match(line):
            fenced = not fenced
            lines.append("")
        elif fenced or line.lstrip().startswith(">"):
            lines.append("")
        else:
            # A struck span keeps only its marks, so a struck line still
            # belongs to its run but says nothing (C11).
            lines.append(_MD_NOISE.sub("", _STRUCK.sub("~~", line)))
    return lines


def _is_run_break(line: str) -> bool:
    return not line.strip() or _HEADING.match(line) is not None


def _bind_reading(
    lines: list[str],
    index: int,
    mention: re.Pattern[str],
    devices: re.Pattern[str] | None,
) -> str | None:
    """Which machine a reading line at `index` is about. Its own line first;
    then upward through the same unbroken run (a blank line or a heading ends
    it). A machine's name binds. A line that names no machine leaves the
    reading unbound when it carries a paired device's name, ends in ":", is a
    subject line ("- Name: …"), or states a connectivity (T1 review, fix round
    1: "- Dell: offline" is the Dell's status line, and the reading under it is
    the Dell's, not hub's, however the reply spells the device).

    A connectivity line with no subject of its own (_OWN_STATE_LINE: "- Status:
    Offline") is the block's own attribute, so the walk goes on (fix round 2).
    Past one, it crosses only the block's key/value lines, up to the line that
    heads the block: a label or sentence there that names no machine ("- Dell"
    above "- Status: offline") leaves the reading unbound."""
    line = lines[index]
    own = _machine_mentioned(line, mention)
    if own is not None:
        return own
    if devices is not None and devices.search(line):
        return None
    past_a_state_line = False
    for above in reversed(lines[:index]):
        if _is_run_break(above):
            break
        if devices is not None and devices.search(above):
            return None
        named = _machine_mentioned(above, mention)
        if named is not None:
            return named
        if above.rstrip().endswith(":") or _SUBJECT_KEY_LINE.match(above):
            return None
        if _CONNECTIVITY_WORD.search(above):
            if _OWN_STATE_LINE.match(above) is None:
                return None
            past_a_state_line = True
        elif past_a_state_line and _KEY_VALUE_LINE.match(above) is None:
            return None
    return None


def _reading_context(lines: list[str], index: int) -> list[str]:
    """Every line that frames the reading at `index`, for the not-current cut
    (T1 review, fix round 1 — her plain "I did not check hub this turn" sat in
    lines this never read, so the answer the machine nudge asks for was
    corrected, and its regeneration refused):

      * the run holding it, from the run's top down to the reading line;
      * the heading that opens the run (blank lines between them skipped);
      * the lead-in: the last non-blank, non-heading line above the run, when
        it ends in ":" ("Here is what hub reported when I checked earlier:").

    S40b T4 review, fix round 1: a disclaimer written AFTER the block ("…\\nI
    have not checked it this turn.") was never read, so the same honest answer
    was corrected when it came last instead of first. The context now also
    holds:

      * the rest of the run, below the reading line;
      * the first non-blank line after the run, unless it is a heading or a
        lead-in ending in ":" — those open the next section, and what they say
        is about it, not about this reading."""
    top = index
    while top > 0 and not _is_run_break(lines[top - 1]):
        top -= 1
    bottom = index
    while bottom + 1 < len(lines) and not _is_run_break(lines[bottom + 1]):
        bottom += 1
    context = lines[top : bottom + 1]
    above = [line for line in reversed(lines[:top]) if line.strip()]
    if above and _HEADING.match(above[0]):
        context.append(above[0])
    lead_in = next((line for line in above if not _HEADING.match(line)), None)
    if lead_in is not None and (
        lead_in.rstrip().endswith(":") or _BRACKET_LINE.match(lead_in) is not None
    ):
        context.append(lead_in)
    after = next((line for line in lines[bottom + 1 :] if line.strip()), None)
    if after is not None and not _HEADING.match(after) and not after.rstrip().endswith(":"):
        context.append(after)
    return context


def _history_label_ends(text: str) -> list[int]:
    """Where each history label in `text` ends (see _HISTORY_SOURCE's
    comment): a heading at its start, an attribution or a report of her
    earlier reply not led by a word that restates or compares it."""
    ends = []
    head = _HISTORY_HEAD.match(text)
    if head is not None:
        ends.append(head.end())
    for pattern in (_HISTORY_ATTRIBUTION, _HER_REPLY_REPORTED):
        for m in pattern.finditer(text):
            if _NOT_A_LABEL_LEAD.search(text, 0, m.start()) is None:
                ends.append(m.end())
    return ends


def _vouched(text: str, found: re.Match[str]) -> bool:
    """Does she vouch for what `found` says of a claim ("that is still true",
    "still holds"), where it stands in `text`? Not when its sentence is asked,
    nor when anything in its clause ahead of it doubts it (_DOUBTED,
    _EPISTEMIC_FRAME): "I'm not sure that is still true" (T4 review, fix
    round 3). A doubt in another clause is about something else: "I'm not
    sure about the Dell, but that is still true" vouches."""
    start = 0
    for sentence in _sentences(text):
        if start + len(sentence) > found.start():
            break
        start += len(sentence)
    else:
        return True  # unreachable: _sentences covers all of `text`
    if sentence.rstrip().endswith("?"):
        return False
    ahead = _CLAUSE_SPLIT.split(text[start : found.start()])[-1]
    return _DOUBTED.search(ahead) is None and _EPISTEMIC_FRAME.search(ahead) is None


def _report_closed(text: str, pos: int) -> bool:
    """Does anything in `text` from `pos` retract what a label labels, or say
    it still holds — and vouch for that?"""
    if _REPORT_CLOSED.search(text, pos) is not None:
        return True
    return any(_vouched(text, m) for m in _STILL_HOLDS.finditer(text, pos))


def _reaffirmed(text: str) -> bool:
    """Does `text` reaffirm a claim as true now, and vouch for it?"""
    return any(_vouched(text, m) for m in _REAFFIRMED.finditer(text))


def _labelled_as_history(text: str) -> bool:
    """Does `text` carry a history label that nothing after it retracts or
    says still holds?"""
    return any(not _report_closed(text, end) for end in _history_label_ends(text))


def _history_framed(before: str, tail: str = "", after: str = "") -> bool:
    """Is a claim framed as her history (S40b T4 review, fix round 2)? A label
    in its clause before it (`before`) that reaches it, or an attribution
    after it in its clause (`tail`: "hub last reported at 05:15 UTC (from my
    previous answer)"; never "…, unchanged from my last reply") — and nothing
    in what follows (`after`) reaffirms it as true now ("…, and that is still
    true"), and no negated-sameness head leads up to it ("No change: …";
    _SAME_HEAD, the final fix wave's B2). The served and memory guards pass
    their claim's tail too since the final fix wave (A12)."""
    if _reaffirmed(after) or _SAME_HEAD.search(before) is not None:
        return False
    if _labelled_as_history(before):
        return True
    return any(
        _NOT_A_LABEL_LEAD.search(tail, 0, m.start()) is None and not _report_closed(tail, m.end())
        for m in _FROM_HISTORY.finditer(tail)
    )


def _record_attributed(before: str, after: str) -> bool:
    """Is a claim his record read back — "Your notes say", "Per your journal,"
    leading up to it in its clause (_RECORD_ATTRIBUTION, A4) — and not
    reaffirmed as true now in what follows?"""
    return _RECORD_ATTRIBUTION.search(before) is not None and not _reaffirmed(after)


def _retracted_in_tail(tail: str) -> bool:
    """Does what follows a claim in its own clause retract it (A12)? "— this
    was wrong", "(which is wrong)", "(incorrect — it's qwen3:8b)",
    "(outdated)" — _RETRACTED's pronoun forms, or a bracket opening on one of
    its words."""
    return _RETRACTED.search(tail) is not None or _BRACKETED_RETRACTION.search(tail) is not None


def _not_a_current_reading(texts: Sequence[str]) -> bool:
    """Does a reading's context (_reading_context) say it is not current: a
    prior time, a not-current word, someone's report — or a history label no
    line of it reaffirms (fix round 2: a mention of her earlier reply is not
    a label, and "Here is hub's current status (unchanged from my last
    reply):" is a replay stated as current)?"""
    if any(
        _PRIOR_TIME.search(text) or _says_not_current(text) or _REPORTED.search(text)
        for text in texts
    ):
        return True
    # A history label, or his notes named as the source (A4) — unless a line
    # reaffirms it, or heads it with "No change:" (B2).
    labelled = any(_labelled_as_history(text) or _RECORD_ATTRIBUTION.search(text) for text in texts)
    return labelled and not any(_reaffirmed(text) or _SAME_HEAD.search(text) for text in texts)


def _machine_claim(
    machine: str,
    phrase: str,
    spans: Sequence[Any],
    purpose: str | None,
    *,
    negative: bool,
) -> StateClaim:
    served_by = None
    if negative:
        writer = _reply_served_by(spans, purpose)
        head, sep, _rest = (writer or "").partition(":")
        if sep and head.strip() == machine:
            served_by = writer
    text = STATE_CLAIM_MACHINE_CORRECTION.format(machine=machine)
    if served_by:
        text += STATE_CLAIM_MACHINE_SERVED.format(machine=machine, served_by=served_by)
    return StateClaim(
        device=machine,
        phrase=phrase.strip()[:80],
        text=text,
        subject_kind="machine",
        served_by=served_by,
    )


def _machine_state_claim(
    reply_text: str,
    spans: Sequence[Any],
    machines: tuple[str, ...],
    device_names: tuple[str, ...],
    purpose: str | None,
) -> StateClaim | None:
    """The machine branch of state_claim_check (see the section header)."""
    mention, assertion, last_reading = _machine_patterns(machines)
    lines = _machine_lines(reply_text)
    # The sentence scan reads her own words only: a double-quoted span is
    # blanked, like a `>` line (T1 review, fix round 1). The key/value lines
    # below keep theirs — a reading line that opens with a quote never
    # matches, and `Last Reported: "2026-…"` is her reading, quote marks and all.
    prose = _QUOTED.sub(lambda q: " " * len(q.group(0)), "\n".join(lines))
    sentences = _sentences(prose)
    for i, sentence in enumerate(sentences):
        if not sentence.strip() or sentence.rstrip().endswith("?"):
            continue  # "is hub ready?" asserts nothing
        # A sentence that says its own state is not current ("…, but I have
        # not checked it this turn") is the answer the machine nudge asks for.
        if _says_not_current(sentence):
            continue
        # The next sentence on its line, where she may reaffirm the claim.
        following = (
            sentences[i + 1] if i + 1 < len(sentences) and not sentence.endswith("\n") else ""
        )
        for clause, rest in _split_clauses(sentence):
            if not clause.strip():
                continue
            if _REPORTED.search(clause) is not None:
                continue  # "you said hub is offline" — someone else's claim
            if _PRIOR_TIME.search(clause) is not None:
                continue
            for m in assertion.finditer(clause):
                machine = m.group("mach")
                if not _lead_ok(clause, m.start("mach")) or _not_the_subject(clause, m):
                    continue
                if _state_prefix_blocks(clause[: m.start()]):
                    continue
                # A scope fronted before it or following its anchor (A5).
                if _FRONTED_SCOPE.match(clause[: m.start()]) or _LIMITED_AFTER.match(
                    clause, m.end()
                ):
                    continue
                # "From my previous answer: hub is switched off." — her
                # history, labelled as such (T4 review, fix rounds 1 and 2),
                # like _PRIOR_TIME; "As in my last reply, hub is offline." is
                # not a label.
                tail = clause[m.end() :]
                if _history_framed(clause[: m.start()], tail, tail + rest + following):
                    continue
                # His notes named as its source (A4), or retracted right after
                # it (A12): "Per your notes, hub is offline", "hub is switched
                # off — this was wrong".
                if _record_attributed(clause[: m.start()], tail + rest + following):
                    continue
                if _retracted_in_tail(tail):
                    continue
                negative = (_MACHINE_NEG_STATE.fullmatch(m.group("state")) is not None) != (
                    _NEGATING_ADVERB.search(m.group("adv")) is not None
                )
                # A positive state is backed by construction (every derived
                # machine was read or served), so only a negative one can fire.
                if negative and not _machine_read(spans, machine):
                    return _machine_claim(machine, m.group(0), spans, purpose, negative=True)
            for r in last_reading.finditer(clause):
                machine = r.group("mach")
                if not _lead_ok(clause, r.start("mach")):
                    continue
                if _state_prefix_blocks(clause[: r.start()]):
                    continue
                tail = clause[r.end() :]
                if _history_framed(clause[: r.start()], tail, tail + rest + following):
                    continue
                if _record_attributed(clause[: r.start()], tail + rest + following):
                    continue
                if _retracted_in_tail(tail):
                    continue
                if not _machine_read(spans, machine):
                    return _machine_claim(machine, r.group(0), spans, purpose, negative=False)
    devices = _device_mention(device_names)
    for index, line in enumerate(lines):
        reading = _READING_LINE.match(line)
        if reading is None:
            continue
        machine = _bind_reading(lines, index, mention, devices)
        if machine is None:
            continue
        if _not_a_current_reading(_reading_context(lines, index)):
            continue
        # A served round proves the machine answered, never when it was read.
        if not _machine_read(spans, machine):
            return _machine_claim(machine, reading.group(0), spans, purpose, negative=False)
    return None


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
    data, never as prose: no refusal string is ever inspected. The SHAPE is
    checked, not just the "connected" key: {"device": <str>, "connected":
    <bool>} — fix round 1 (Important, folded in). A future fact naming a
    different subject (a peer, a session — anything that is not a paired
    device) must not silently back a DEVICE claim just because it happens to
    carry a key called "connected"."""
    facts = (getattr(span, "meta", None) or {}).get("facts")
    if not isinstance(facts, list):
        return False
    return any(is_connectivity_fact(fact) for fact in facts)


def is_connectivity_fact(fact: object) -> bool:
    """One recorded fact in the connectivity shape, {"device": <str>,
    "connected": <bool>}. The one definition: _determined_connectivity reads
    it, and live_facts._shown_facts withholds by it (S42a final review I2), so
    what a live check keeps and what this guard reads as a device check cannot
    drift apart."""
    return (
        isinstance(fact, dict)
        and isinstance(fact.get("device"), str)
        and isinstance(fact.get("connected"), bool)
    )


def _checked_a_device(spans: Sequence[Any]) -> bool:
    """Did this turn actually LOOK at a device? Three ways, all mechanical:

      * a successful device_* span (the ordinary case), or
      * a device_* span that DETERMINED connectivity and then refused — an
        offline machine refuses every device tool before sending, and that
        refusal is exactly the check the reply is reporting (see the section
        header; this is the guard's worst failure mode without it), or
      * (S42a) any OTHER ok tool span that recorded a device's connectivity
        in the same {"device", "connected"} shape — today only
        machine_status, whose agent listing leaves one such fact per agent
        (tools/machines._describe_agents). Run unasked, its result reaches
        her cut short, and the span keeps only the facts of the agent lines
        she was shown (live_facts._shown_facts; final review I2).
      * (S42b) a span of the update tool (_UPDATE_TOOLS) that recorded the
        machine's connectivity, ok or FAILED. machine_update reads the
        connection before it sends (agent_updates.update_now), and an offline
        machine is then a stated cannot — a failed span carrying that fact,
        which is the check her "box is offline" reports, exactly as a device
        tool's refusal is (Task 22 review I1). Keyed on the tool set, never on
        her words; one that read no connection ("current", an unknown name)
        backs nothing.

    A device_* span that settled nothing — an unknown device name, a schema
    refusal — backs nothing.

    TURN-WIDE, by S42a's design: one kept connectivity fact backs a claim
    about ANY device, so a check of one machine backs a claim about another.
    Weighed in S42b (Task 23) and left as it is: per-device backing can only
    add corrections, and a state correction is REPLACE-class with a redirect,
    so it moves only with a measurement over real replies showing no honest
    one is corrected — and the update tool adds no new kind of miss, since it
    records the one machine it acts on, as a device tool does.
    """
    for span in spans:
        if getattr(span, "kind", None) != "tool":
            continue
        name = str(getattr(span, "name", "") or "")
        meta = getattr(span, "meta", None) or {}
        if name.startswith(_DEVICE_SPAN_PREFIX):
            if meta.get("ok") is True or _determined_connectivity(span):
                return True
        elif name in _UPDATE_TOOLS:
            if _determined_connectivity(span):
                return True
        elif meta.get("ok") is True and _determined_connectivity(span):
            # S42a: machine_status reads every agent's connection NOW and
            # records it the same way (tools/machines._describe_agents). Only
            # an OK span: a failed read determined nothing.
            return True
    return False


def _state_prefix_blocks(before: str) -> bool:
    """A hedge, subordinator or intent verb before the assertion means the
    clause proposes/qualifies the state rather than asserting it."""
    return _STATE_HEDGE.search(before) is not None or _STATE_INTENT.search(before) is not None


def state_claim_check(
    reply_text: str,
    spans: Sequence[Any],
    device_names: Sequence[str],
    *,
    purpose: str | None = None,
) -> StateClaim | None:
    """Contradict a live-state claim no check backs this turn.

    Returns a StateClaim when the reply asserts the CURRENT connectivity or
    availability of a paired device and nothing this turn backs it
    (`_checked_a_device`: no successful device_* span, no other ok span that
    recorded that same {"device", "connected"} shape, and no update-tool span,
    ok or failed, that recorded it — see its docstring);
    None otherwise — an honest reply backed by a real check, a past/
    hedged/questioned/reported form, or a household with nothing paired. Pure
    and precision-first (see the section header). Derived from `device_names`:
    with no paired devices there is no such claim to make, so the guard is
    silent by construction rather than by a special case.

    S40b: in a turn whose kind is in STACK_CLAIM_KINDS (`purpose`, the turn's
    kind — traces.purpose_of), it also reads MACHINES, derived from the turn's
    own spans (machine_names): a negative state, or a reading time, about a
    machine nothing read this turn (see the machine section above). `purpose`
    defaults to None, which leaves every pre-S40b call exactly as it was.
    """
    if not reply_text or not reply_text.strip():
        return None
    names = tuple(sorted({str(name).strip() for name in device_names if str(name).strip()}))
    machines = machine_names(spans) if purpose in STACK_CLAIM_KINDS else ()
    if not names and not machines:
        return None
    # A real device check backs whatever the reply says about a DEVICE — and
    # only a device: it says nothing about a machine.
    if names and not _checked_a_device(spans):
        claim = _device_state_claim(reply_text, names)
        if claim is not None:
            return claim
    if machines:
        return _machine_state_claim(reply_text, spans, machines, names, purpose)
    return None


def _device_state_claim(reply_text: str, names: tuple[str, ...]) -> StateClaim | None:
    """The device branch of state_claim_check, unchanged since 2026-09-03."""
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


# -- the SAID-NOT-DONE pair: a call written as text, a device action claimed --
#
# The owner's test, 2026-09-28 23:56-23:58 UTC, dell:qwen3:8b with tools
# advertised in every round (tests/said_not_done_walk.py). Asked to open Teams
# on his Dell she made ZERO calls, wrote her own tool as a fence —
#
#     ```bash
#     device_launch_app "DELL-XPS-8950" "Teams"
#     ```
#
# — and said "Teams is now opening". Asked for Notepad: zero calls, "Notepad is
# now open on your DELL-XPS-8950." Asked why nothing opened: zero calls, "Let me
# investigate…" and fences of device_info. No guard fired on any of the three,
# and all of it was ingested. Nothing was broken; nothing had been built for
# these shapes:
#
#   * markup_calls reads a fence as TEACHING by design, and that ruling stands:
#     prose never dispatches. Nothing here changes it. Both checks return a
#     tool NAME and a PHRASE — never an argument — and one SENTENCE saying what
#     the record shows (fix round 3: neither leads to any action at all).
#   * deferral_check's commitment and completion shapes map web search, fetch
#     and timers; "open Teams" maps to none of them.
#   * bare_intent_check reads replies of 15 words or fewer.
#
# Both are built to the family's two rules: PURE (text, spans and the turn's
# own tool and device names; no model, network or clock) and PRECISION-first (a
# wrongly-corrected honest reply makes the guard the liar). Neither reads the
# owner's message (owner ruling 2026-09-27: no phrase matchers on his words).
# Both run in core's event loop on every reply, so neither does work per match
# that grows with the reply: every cut is found once per line or clause and
# compared by position.
#
# Fix round 1 (2026-09-29, the adversarial review of bc89e231) tightened both,
# because a "do it now" nudge turns a false fire into an ACTION nobody asked
# for — the review drove a proposal ("I would run `device_run […]`") into a
# real recursive delete, and a recap ("today I opened Notepad") into a
# relaunch:
#   * written_call fires only on a call inside CODE formatting that is framed
#     as HER action NOW (C2); prose, examples, proposals, questions, negations
#     and recaps are never calls;
#   * device_completion reads only ACTION claims about THIS turn by HER (C2),
#     and backs one only with a successful span she called, of a tool that
#     performs that action, on the device she named (C1) — never a read, a
#     connectivity fact or a backend check.
#
# Fix round 2 (2026-09-29, the scoped re-review of 83ae4c99) changed what a
# detection DOES before what it reads, under one principle: a false positive
# must cost ONE SENTENCE, never an action the owner did not ask for.
#   * device_completion is APPEND-class (R-A): no redirect, no tools, no push.
#     Its claim carries the one correction the turn ships — what the record
#     shows, in one of four cases (`DeviceRecord`) — and chat.py keeps the turn
#     out of memory;
#   * written_call keeps its one redirect, but the nudge states facts only and
#     its own regeneration is not re-vetted by it (R-B, chat.py);
#   * an action is backed only by a call that performs THAT action on THAT
#     target (C1): a launch by the app's whole name, a close, delete or restart
#     by a program that does it, and a device word ("your Mac") only on a
#     device of its platform;
#   * both read fewer shapes (C2): waiting for his go-ahead, warnings and
#     explanations are not calls; how-it-works passives, conditions, other
#     causes and marked recaps are not completions.
#
# Fix round 3 (2026-09-29, the controller's rulings T1-T5) made the pair
# APPEND-ONLY, with NO redirects — the owner shelved the handback guard the same
# day for the same reason: a redirect that invites action cannot be made safe
# with regex detection (the re-review drove a warning's `format C: /q` into a
# redirect with 43 tools advertised). Each check now returns a claim whose
# `text` is the ONE sentence the turn appends, computed by chat.py once, at the
# END of the turn, from the FINAL spans (T4):
#   * written_call: "(I wrote <tool> as text; it did not run.)" and nothing
#     else (T2);
#   * device_completion says only what the record literally shows and never
#     guesses about targets (T3): SILENT when any call of the claimed action's
#     tools SUCCEEDED on that device — on any device, for "your PC" or no
#     device named — whatever it ran for (the record cannot equate an app id,
#     an alias, a URI and a Start-menu name with the name she used, and a false
#     correction is worse than a missed one); a failure or a call never
#     answered, stated as such; else "(No <tool> call ran on <device> this
#     turn.)" — no object, because the record shows her calls, not the
#     machine's state.

# A claim or a call about an EARLIER time is a recap, never "done now": the
# family's _PRIOR_TIME, plus the markers the reviews found — "today", "this
# morning", "at 15:56", "on Monday", "in our last chat", "before", "as I
# mentioned", "recap", "to summarize", "the last app I opened". A bare "Here's
# what I did:" is NOT one (fix round 2): with nothing run, "Done! Here's what I
# did:\n- Launched Notepad on your DELL…" is the claim itself.
_WEEKDAY = r"(?:mon|tues|wednes|thurs|fri|satur|sun)day"
_RECAP_TIME = re.compile(
    r"\b(?:today|tonight|this\s++(?:morning|afternoon|evening|week)"
    r"|at\s++\d{1,2}(?::\d{2})?+(?:\s*+[ap]\.?m\.?)?+(?![\w:])"
    rf"|on\s++(?:the\s++)?{_WEEKDAY}|on\s++the\s++\d{{1,2}}(?:st|nd|rd|th)"
    r"|(?:last|previous|earlier)\s++(?:time|turn|chat|conversation|session|message|reply)"
    r"|in\s++our\s++(?:last|previous|earlier)\s++(?:chat|conversation|session|talk)"
    r"|before|recap(?:ped|ping)?+|to\s++(?:summari[sz]e|recap)|in\s++summary"
    r"|as\s++(?:I|we)\s++(?:mentioned|said|noted|explained|described)"
    r"|last\s++\w++\s++(?:that\s++)?(?:I|we))\b",
    re.I,
)


def _recap(text: str) -> bool:
    """A past-time or recap marker anywhere in `text`."""
    return _PRIOR_TIME.search(text) is not None or _RECAP_TIME.search(text) is not None


# A markdown list item: its framing is its list's, not its own.
_LIST_ITEM = re.compile(r"^\s*+(?:[-*+•]|\d{1,3}[.)])\s")


def _joined(names: Sequence[str]) -> str:
    """ "a", "a and b", "a, b and c"."""
    if len(names) <= 1:
        return "".join(names)
    return f"{', '.join(names[:-1])} and {names[-1]}"


@dataclass(frozen=True)
class WrittenCallClaim:
    """Her reply wrote a call to one of her own tools as text, framed as her
    action now, and no span of that tool ran this turn. `tools` names each
    such tool once, in the order written; `phrase` is the first such call as
    written, for the guard span; `fenced` says, per tool, whether it sat in a
    fence or in inline code (the span records `where`). There is no argument
    field on purpose: nothing may run what she wrote."""

    tools: tuple[str, ...]
    phrase: str
    fenced: tuple[bool, ...] = ()

    @property
    def where(self) -> str:
        """Where the calls were written, as the guard span records it."""
        if self.fenced and all(self.fenced):
            return "a code block"
        if self.fenced and not any(self.fenced):
            return "inline code"
        return "code"

    @property
    def text(self) -> str:
        """The ONE sentence the turn appends (fix round 3, T2): the calls she
        wrote as text, and that they did not run — nothing else, and no
        invitation to make them. True whenever the claim exists: it exists
        only when no call of those tools was attempted this turn."""
        they = "it" if len(self.tools) == 1 else "they"
        return f"(I wrote {_joined(self.tools)} as text; {they} did not run.)"


# The value a written call's bracket opens onto: a quote, a bracket, a brace or
# a number. It is what separates `device_run(["ls"])` from the signature
# `device_run(device, argv)` and the mention `get_time()`.
_CALL_VALUE = r"(?:[\"'“‘\[{]|-?\d)"
# What follows a tool's name when she writes it as a CALL rather than a word:
#   * `(` glued to the name, opening onto a value or onto `key=`/`key:` a value
#     (`device_info(device="DELL")`) — never a typed signature (`device: str`),
#     and never a parenthetical after a space ("device_run (the shell tool)");
#   * after optional spaces, a `[` or `{` opening onto a value (`device_run
#     ["ls"]`, `device_run {"argv": …}`) — never a usage line's `[device]`;
#   * after at least one space, a quote (`device_info "DELL-XPS-8950"`) or a
#     `--flag`. A quote GLUED to the name closes a quotation instead:
#     `"device_run"`, `name="device_run">`, `{"name": "device_run"}`.
_CALL_ARGS = (
    rf"(?:\(\s*+(?:{_CALL_VALUE}|[A-Za-z_]\w*+\s*+[=:]\s*+{_CALL_VALUE})"
    rf"|[ \t]*+(?:\[\s*+(?:{_CALL_VALUE}|\])|\{{\s*+[\"'“‘}}])"
    r"|[ \t]++(?:[\"'“‘]|--[A-Za-z]))"
)
# An EXAMPLE, which is an explanation of a tool and not a call to it: "e.g.",
# "for example", "such as", "like", "an example", a label ("Example:",
# "**Usage**:", "Syntax:"), a heading that names examples, or a verb of showing
# ("let me show you what it looks like"). "usage" and "syntax" count only as a
# label or "the syntax is": bare, they are "disk usage" and "a syntax error".
_EXAMPLE_INTRO = re.compile(
    r"(?<![\w.])(?:e\.g\.|i\.e\.)"
    r"|\bfor\s++(?:example|instance)\b"
    r"|\bsuch\s++as\b|\blike\b"
    r"|\b(?:an?|another|this|that|the)\s++example\b"
    r"|\bexamples?\s++(?:calls?|of|usage)\b"
    r"|\b(?:examples?|usage|syntax|signature)\W{0,3}:"
    r"|\b(?:syntax|signature|usage)\s++(?:is|would\s++be|looks\s++like)\b"
    r"|\b(?:show|explain|describe|illustrate|demonstrate)\b"
    r"|^\s*+#{1,6}\s[^\n]*\bexamples?\b",
    re.I,
)
# HER ACTION NOW, the one framing that makes code a call (C2). Fix round 2
# narrowed it to a first-person intent followed by a verb of DOING — a closed
# list on purpose: "let me know / warn you / break down / walk you through /
# clarify / put it another way" and "I'll wait / skip / avoid / refrain /
# paste" introduce no call of hers, while every lead the owner's turns used —
# "I'll confirm", "let me verify", "let me launch" — is on it. Then a
# first-person present of doing ("I'm running…"), and "Now:" or "Now calling…"
# opening a clause. A gerund that opens a sentence is NOT a lead: "Calling
# `device_info …` returns the OS" and "Running `…` would wipe your disk" make
# the call the subject of an explanation (see _GERUND_START for the one place a
# gerund still frames a call).
_DOING = (
    r"(?:(?:re-?)?run|launch|open|start|call|execute|invoke|use|(?:double-)?check|verify"
    r"|confirm|try|test|list|look|see|search|fetch|get|pull|grab|read|write|save|create"
    r"|send|stop(?![ \t]++you\b)|kill|close|restart|reboot|(?:un)?install|delete|remove"
    r"|clear|move|copy|query|scan|ping|inspect|find|trigger|fire|do|make|set|turn|load"
    r"|retrieve|take|kick|investigate|diagnose|examine|debug|troubleshoot)"
)
_INTENT = (
    r"(?:I['’]ll|I\s++will|I['’]m\s++(?:going\s++to|gonna|about\s++to)"
    r"|I\s++am\s++(?:going|about)\s++to|let\s++me|let['’]s)"
)
_LEAD_ADVERB = (
    r"(?:now|just|first|quickly|also|then|immediately|actually|simply|next"
    r"|right\s++away|go\s++ahead\s++and)"
)
_WRITTEN_CALL_LEAD = re.compile(
    rf"\b{_INTENT}(?:\s++{_LEAD_ADVERB})*+\s++{_DOING}\b"
    r"|\bI(?:['’]m|\s++am)\s++(?:now\s++)?(?:running|calling|executing|launching|opening"
    r"|starting|sending|checking|trying|using|invoking)\b"
    r"|^[\W_]*+(?:\d{1,3}[.)]\s*+)?[\W_]*+now\b(?:\s*+:|[\s,]++(?:running|calling|executing"
    r"|launching|opening|starting|sending|checking|invoking|triggering)\b)",
    re.I,
)
# The one place a gerund still frames a call: a gerund FRAGMENT on the line
# above a fence — "Launching Microsoft Teams via the Windows desktop
# environment." (890b1c63) — which has no verb of its own. It narrates her
# action, and the fence under it is that action. A gerund with a verb after it
# is the subject of that verb ("Calling it returns the OS:"), an explanation,
# and a gerund before inline code never frames it (fix round 2, C2).
_GERUND_START = re.compile(
    r"^[\W_]*+(?:\d{1,3}[.)]\s*+)?[\W_]*+(?:running|launching|calling|executing|opening"
    r"|starting|sending|checking|invoking|triggering|verifying|confirming)\b",
    re.I,
)
# …and the gerund fragments that are a LABEL or a SUBJECT, never her narration
# (fix round 3, the re-review's how-to and warning shapes): a markdown heading
# ("### Running a command"); a generic object ("Launching an app on a paired
# device:", "1. Opening a file", "Sending a desktop notification:"); and a
# "this"/"that"/"it" the fragment then says something about in the third
# person — "Running this formats your C: drive:", "Calling this bricks the
# agent." — whatever the verb (no closed list of verbs can hold them all).
_GERUND_NOT_HERS = re.compile(
    r"^\s*+#"
    r"|^[\W_]*+(?:\d{1,3}[.)]\s*+)?[\W_]*+(?:running|launching|calling|executing|opening"
    r"|starting|sending|checking|invoking|triggering|verifying|confirming)[ \t*_`]++"
    r"(?:an?\b|(?:this|that|it)[ \t*_`]++[a-z]*[^\Ws]s\b)",
    re.I,
)
_FINITE_VERBS = frozenset(
    (
        "is are was were be been will would can could should might may must does do did has "
        "have had returns needs requires takes gives shows means makes lets deletes removes "
        "wipes erases lists prints opens launches runs starts stops kills closes restarts "
        "reboots writes reads saves sends creates clears works looks goes happens fails"
    ).split()
)
# What makes code NOT her action now, read on its framing:
#   * a negation governing the doing — "do not run", "I have not run", "I will
#     never call", "without running" (a bare "no" is an interjection: "No
#     problem — I'll run…" still commits);
_WRITTEN_CALL_NEGATION = re.compile(
    r"\b(?:not|never|don['’]t|didn['’]t|haven['’]t|hasn['’]t|won['’]t|shouldn['’]t|mustn['’]t"
    r"|can['’]t|cannot|without|instead\s++of|avoid)\s++(?:\w+\s++){0,2}?"
    r"(?:run|ran|running|call|called|calling|use|used|using|execute|executed|executing|launch"
    r"|launched|launching|open|opened|invoke|invoked|type|typed|try|tried|do|did)\b",
    re.I,
)
#   * a hedge, anywhere in the sentence — "would", "could", "might", "should"
#     with ANY subject (fix round 2: "Running `…` would wipe your disk"), "I'd",
#     "I may", "want me to", "do you want";
_WRITTEN_CALL_HEDGE = re.compile(
    r"\b(?:would|could|might|should)\b|\b(?:I|we)\s++may\b"
    r"|\b(?:I|you|we|it|that|this|they)['’]d\b|\bwant\s++me\s++to\b|\bdo\s++you\s++want\b",
    re.I,
)
#   * a condition, anywhere in the sentence — "once", "as soon as", "until",
#     "before", "after", "when", "if", "unless" ("I'll run `…` once you
#     confirm"). An "if" after a verb of finding out is "whether" and
#     conditions nothing: "I'll confirm if DELL-XPS-8950 is online:" (3dee5106)
#     is her check; and "even if" concedes, it does not condition ("Let me
#     verify … (even if hidden)");
_WRITTEN_CALL_CONDITION = re.compile(
    r"\b(?:once|as\s++soon\s++as|until|till|before|after|when(?:ever)?+|unless|in\s++case"
    r"|(?P<if>if))\b",
    re.I,
)
_WHETHER_VERB = re.compile(
    r"\b(?:check|checking|confirm|confirming|verify|verifying|see|test|testing|know|ask"
    r"|determine|find\s++out|wonder|even)\s*+$",
    re.I,
)
#   * waiting for his go-ahead — "let me know if this looks right", "say the
#     word", "your go-ahead", "hold off", "once you confirm";
_WRITTEN_CALL_APPROVAL = re.compile(
    r"\bsay\s++the\s++word\b|\bgo-ahead\b|\b(?:your|the|a)\s++go\s++ahead\b|\bhold\s++off\b"
    r"|\bwait(?:ing)?+\s++(?:for\s++)?(?:you|your)\b|\blet\s++me\s++know\b"
    r"|\byour\s++(?:ok|okay|approval|confirmation|permission|consent|sign-?off)\b"
    r"|\byou\s++(?:confirm|approve|agree)\b",
    re.I,
)
#   * a proposal — "I can…", "you can…", "you would…", "happy to…".
_WRITTEN_CALL_PROPOSAL = re.compile(
    r"\b(?:I|we|you)\s++(?:can|could)\b|\byou\s++(?:would|might|may|should|need\s++to)\b"
    r"|\b(?:happy|glad)\s++to\b",
    re.I,
)
# Her own simple past of doing: a report, not a call now.
_WRITTEN_CALL_PAST = re.compile(
    r"\b(?:I|we)\s++(?:ran|used|called|executed|tried|typed|launched|opened|sent)\b", re.I
)
# How much of a line frames a fence: the last sentence of its last 600
# characters introduces what follows it; the first sentence of the first 600
# after a fence is what takes it back. A sentence that frames anything is
# short, and the cap is what keeps a pathological line from being read whole at
# every fence (fix round 2, minor: 41 KB took 13.8 s).
_FRAME_WINDOW = 600


@lru_cache(maxsize=16)
def _written_call_pattern(names: tuple[str, ...]) -> re.Pattern[str]:
    """One of `names` written as a call. Derived from the turn's advertised
    tool names — never a list kept here, so a tool registered tomorrow is read
    the day it is advertised, and a tool an agent was not shown is not hers.
    Longest name first, so `device_list_files(` never reads as `device_list`
    (the right edge forbids that anyway; the order saves the engine a retry).
    Cached on the names: a pure function of the toolset."""
    ordered = sorted(names, key=lambda name: (-len(name), name))
    alternation = "|".join(re.escape(name) for name in ordered)
    return re.compile(rf"(?<![\w])(?P<name>{alternation})(?![\w]){_CALL_ARGS}")


def _call_as_written(line: str, start: int) -> str:
    """The call as written, for the guard span: to the end of its line, or of
    its inline code span when it sits in one."""
    rest = line[start:]
    if line.count("`", 0, start) % 2:
        rest = rest.split("`", 1)[0]
    return rest.strip()[:80]


def _rules_out(sentence: str) -> bool:
    """Whether something in the WHOLE sentence rules a call in it out: a
    question, a hedge, waiting for his go-ahead, a recap, or a condition —
    "whether"-ifs and "even if" aside, each judged on the 24 characters before
    it, so the cost stays linear."""
    if (
        sentence.rstrip().endswith("?")
        or _WRITTEN_CALL_HEDGE.search(sentence) is not None
        or _WRITTEN_CALL_APPROVAL.search(sentence) is not None
        or _recap(sentence)
    ):
        return True
    for found in _WRITTEN_CALL_CONDITION.finditer(sentence):
        if found.group("if") and _WHETHER_VERB.search(
            sentence[max(0, found.start() - 24) : found.start()]
        ):
            continue
        return True
    return False


def _first_blocker(sentence: str) -> int | None:
    """Where the first blocker before a call could be: a negation, a proposal,
    an example, her own past, a relay."""
    starts = [
        found.start()
        for pattern in (
            _WRITTEN_CALL_NEGATION,
            _WRITTEN_CALL_PROPOSAL,
            _EXAMPLE_INTRO,
            _WRITTEN_CALL_PAST,
            _REPORTED,
        )
        if (found := pattern.search(sentence)) is not None
    ]
    return min(starts) if starts else None


def _framing_verdict(sentence: str) -> tuple[int | None, int | None, bool]:
    """One sentence's reading, once: where its first lead is (None if it has
    none), where its first blocker before a call could be, and whether the
    WHOLE sentence rules a call out (`_rules_out`). A call in it is framed as
    her action now when a lead comes before it and no blocker does
    (`_framed_as_her_action_now`) — so with no lead, nothing else is read."""
    lead = _WRITTEN_CALL_LEAD.search(sentence)
    if lead is None:
        return None, None, False
    return lead.start(), _first_blocker(sentence), _rules_out(sentence)


def _framed_as_her_action_now(verdict: tuple[int | None, int | None, bool], at: int) -> bool:
    """Whether code starting at offset `at` of a sentence is framed as HER
    call NOW (fix round 1, C2): a lead before it, no blocker before it, and
    nothing in the sentence that rules it out."""
    lead, blocker, whole = verdict
    return lead is not None and lead < at and (blocker is None or blocker >= at) and not whole


def _last_sentence(line: str) -> str:
    """The sentence of `line` that introduces what follows it: its last one
    with any words in it ("I haven't opened it yet. Let me launch it now:")."""
    sentences = [sentence for sentence in _sentences(line) if sentence.strip()]
    return sentences[-1] if sentences else line


def _intro_frames_a_fence(line: str) -> bool:
    """Whether the prose line above a fence frames it as her action now: its
    last sentence has a lead and nothing that rules it out — or it is a gerund
    fragment with no verb of its own (890b1c63's "Launching Microsoft Teams via
    the Windows desktop environment.")."""
    intro = _last_sentence(line[-_FRAME_WINDOW:])
    verdict = _framing_verdict(intro)
    if verdict[0] is not None:
        return _framed_as_her_action_now(verdict, len(intro))
    return (
        "`" not in intro
        and _GERUND_START.match(intro) is not None
        and _GERUND_NOT_HERS.match(intro) is None
        and _FINITE_VERBS.isdisjoint(re.findall(r"[a-z]+", intro.lower()))
        and _first_blocker(intro) is None
        and not _rules_out(intro)
    )


def _follow_takes_it_back(line: str) -> bool:
    """Whether the first sentence after a fence takes the fence back (fix round
    2, C2: a fence is judged with what follows it): a question ("Shall I go
    ahead?"), a hedge, a condition, waiting for his go-ahead, a recap, or a
    negation of doing it ("Never run this.")."""
    head = line[:_FRAME_WINDOW]
    first = next((sentence for sentence in _sentences(head) if sentence.strip()), head)
    return _rules_out(first) or _WRITTEN_CALL_NEGATION.search(first) is not None


def written_call_check(
    reply_text: str, spans: Sequence[Any], available_tools: Sequence[str]
) -> WrittenCallClaim | None:
    """A call to one of her own tools, written as text, framed as her action
    now, that never ran.

    Fires when the reply writes the EXACT name of a tool advertised this turn
    followed by argument syntax (`_CALL_ARGS`) INSIDE CODE FORMATTING — a
    fence, or an inline code span — framed as her action now: an intent and a
    verb of doing ("I'll confirm…:", "Let me check:") introducing the fence
    (its intro line's last sentence) or before the code in its sentence; a
    gerund fragment above a fence ("Launching Microsoft Teams via…"); or a
    fence that IS the answer, with nothing before it. A fence is judged with
    the sentence after it too: a question there ("Shall I go ahead?") takes it
    back. And no span of that tool, successful or attempted (`_attempted`: a
    refused markup call is not an attempt), ran this turn.

    Silent (fix rounds 1 and 2, C2 and I1): a call in prose; an explanation,
    an example or a list of tools; a proposal ("I can…"); a hedge or a
    condition anywhere in the sentence ("Running `…` would wipe…", "I'll run
    `…` once you confirm"); waiting for his go-ahead ("let me know if this
    looks right", "say the word"); a question or an offer; a negation ("Do not
    run `…`"); a recap; relayed or quoted text; a blockquote; a table.

    Returns every such tool once, in order, with the first call as written and
    where each sat; never its arguments. Nothing may execute what she wrote
    (markup_calls' ruling): the redirect states the facts and the MODEL
    decides.

    Every line is read once: its sentences, their verdicts and its backticks
    are found in one pass each and compared by position, and each prose line's
    framing of a fence is read once however many fences it frames, so a long
    line of calls costs one pass, never one per call.

    SILENT for the whole turn when a delegation RAN an agent this turn
    (`_a_delegation_ran`, fix round 4, R1): the call she shows may be the one
    the agent made, which is recorded on the agent's own turn."""
    if not reply_text or not reply_text.strip():
        return None
    names = tuple(sorted({name for name in available_tools if isinstance(name, str) and name}))
    if not names:
        return None
    if _a_delegation_ran(spans):
        return None
    pattern = _written_call_pattern(names)
    lines = reply_text.split("\n")
    is_fence = [_FENCE.match(line) is not None for line in lines]
    # Where each fence closes, and the first line with words after each line,
    # outside every fence — found once, so a reply of many fences costs one
    # pass (fix round 2, minor).
    openers = [index for index, fence in enumerate(is_fence) if fence]
    close_of = {
        openers[at]: (openers[at + 1] if at + 1 < len(openers) else None)
        for at in range(0, len(openers), 2)
    }
    inside = [False] * len(lines)
    fenced_now = False
    for index, fence in enumerate(is_fence):
        if fence:
            fenced_now = not fenced_now
        else:
            inside[index] = fenced_now
    next_words: list[int | None] = [None] * len(lines)
    upcoming: int | None = None
    for index in range(len(lines) - 1, -1, -1):
        next_words[index] = upcoming
        if not is_fence[index] and not inside[index] and any(c.isalpha() for c in lines[index]):
            upcoming = index
    # A fence's framing is judged only when an unbacked call is found in it,
    # and each distinct line is judged once (fix round 2, minor).
    intro_frames: dict[str, bool] = {}
    takes_back: dict[str, bool] = {}

    def frames(opener: int, intro: int | None) -> bool:
        if intro is None:
            return True  # a fence with NOTHING before it is the answer itself
        line = lines[intro]
        if line not in intro_frames:
            intro_frames[line] = _intro_frames_a_fence(line)
        if not intro_frames[line]:
            return False
        close = close_of.get(opener)
        after = next_words[close] if close is not None else None
        if after is None:
            return True
        follow = lines[after]
        if follow not in takes_back:
            takes_back[follow] = _follow_takes_it_back(follow)
        return not takes_back[follow]

    found: list[str] = []
    fenced: list[bool] = []
    phrase = ""
    backed: dict[str, bool] = {}
    last_prose: int | None = None  # the nearest non-blank line outside a fence
    in_fence = False
    fence_opener = 0
    fence_intro: int | None = None
    fence_framed: bool | None = None  # not judged yet
    for index, line in enumerate(lines):
        if is_fence[index]:
            if not in_fence:
                # A fence's framing is the prose just above it, and the
                # sentence after it (`frames`).
                fence_opener, fence_intro, fence_framed = index, last_prose, None
            in_fence = not in_fence
            continue
        stripped = line.strip()
        if not in_fence and stripped:
            last_prose = index
        if not stripped or stripped.startswith(">"):
            continue  # a blockquote is someone else's words
        if len(stripped) > 1 and stripped.startswith("|") and stripped.endswith("|"):
            continue  # a table documents tools, it does not run them
        matches = [m for m in pattern.finditer(line) if m.group("name") not in found]
        if not matches:
            continue
        if in_fence:
            if fence_framed is None:
                fence_framed = frames(fence_opener, fence_intro)
            if not fence_framed:
                continue
        if not in_fence:
            ticks = [i for i, char in enumerate(line) if char == "`"]
            quotes = [i for i, char in enumerate(line) if char == '"']
            opens = [i for i, char in enumerate(line) if char == "“"]
            closes = [i for i, char in enumerate(line) if char == "”"]
            starts: list[int] = []
            verdicts: list[tuple[int | None, int | None, bool]] = []
            offset = 0
            for sentence in _sentences(line):
                starts.append(offset)
                verdicts.append(_framing_verdict(sentence))
                offset += len(sentence)
        for m in matches:
            name, start = m.group("name"), m.start()
            if name in found:
                continue
            if not in_fence:
                before = bisect_right(ticks, start - 1)
                if before % 2 == 0:
                    continue  # prose, not code: a word, never a call (C2)
                at = bisect_right(starts, start) - 1
                opener = ticks[before - 1] - starts[at]  # the code span's backtick
                if not _framed_as_her_action_now(verdicts[at], opener):
                    continue
                if bisect_right(quotes, start - 1) % 2 or bisect_right(
                    opens, start - 1
                ) > bisect_right(closes, start - 1):
                    continue  # inside a double quotation: someone else's call
            if name not in backed:
                backed[name] = _attempted(frozenset({name}), spans)
            if backed[name]:
                continue  # the call was made this turn: a report of it
            found.append(name)
            fenced.append(in_fence)
            phrase = phrase or _call_as_written(line, start)
    if not found:
        return None
    return WrittenCallClaim(tools=tuple(found), phrase=phrase, fenced=tuple(fenced))


# -- the device-action completion claim ----------------------------------------


@dataclass(frozen=True)
class DeviceRecord:
    """What the turn's record shows about one claimed device action, when no
    call that performs it SUCCEEDED there (fix round 3, T3). The one sentence
    the turn appends is built from it and says nothing else:

      * "none" — no call of those tools ran on that device this turn;
      * "failed" — one failed, with the `reason` it stated: its first line,
        before any advice, clipped (fix round 4, R2 — `_quoted_reason`), or
        None when nothing of it may be quoted;
      * "timed_out" — the DEVICE answered that the command timed out, on
        `device` (fix round 4, R3: novad's "timed out; partial output:");
      * "no_answer" — one was sent and never answered (the hub's timeout, a
        dropped socket, a closed connection), so whether it worked is not
        known.

    There is no "ran for X, not Y" case any more: a call that succeeded for
    ANY target silences the claim, because the record cannot equate the names
    an app goes by."""

    case: str = "none"
    tool: str | None = None
    reason: str | None = None
    device: str | None = None


@dataclass(frozen=True)
class DeviceCompletionClaim:
    """A claim that an action happened on a device — "Notepad is now open on
    your DELL-XPS-8950", "I opened Teams" — that no successful call performing
    it backs.

    `phrase` is the claim as she wrote it (the guard span records it);
    `device` the device as the sentence names it — a paired name, or her
    words when they name none or several ("your PC") — or None when she named
    none; `kind` the kind of tool that performs it (DEVICE_ACTION_TOOLS) and
    `tools` the advertised ones; `action` the action itself; `target` what she
    said it was done to, read only to choose which failure to state (C1);
    `record` what the turn's record shows instead. `sentence` is the one thing
    the turn appends, and nothing in it is more than the record says (fix
    round 3, T3) — never the machine's state, never a target."""

    phrase: str
    device: str | None = None
    kind: str = "launch"
    tools: tuple[str, ...] = ()
    action: str = "launch"
    target: str = "it"
    record: DeviceRecord = DeviceRecord()

    @property
    def sentence(self) -> str:
        record = self.record
        if record.case == "failed":
            if not record.reason:
                return f"{record.tool} failed."
            # A clipped reason already ends on its ellipsis.
            stop = "" if record.reason.endswith("…") else "."
            return f"{record.tool} failed: {record.reason}{stop}"
        if record.case == "timed_out":
            on = f" on {record.device}" if record.device else ""
            return f"{record.tool} timed out{on}."
        if record.case == "no_answer":
            return f"{record.tool} was sent but did not answer — whether it worked is not known."
        on = f" on {self.device}" if self.device else ""
        return f"No {' or '.join(self.tools)} call ran{on} this turn."

    @property
    def text(self) -> str:
        """The sentence as the turn appends it, set off from her prose."""
        return f"({self.sentence})"


# Which registered device tools PERFORM each kind of action. A verb names an
# action and a tool performs one; the registry has no field that says which,
# and must not grow one (test_no_approvals pins Tool's fields). So the mapping
# is kept here and pinned against the LIVE registry
# (tests/test_device_completion_guard.py): every tool in it is a registered
# tool that changes something (reads_only False), every registered device tool
# that does is in it, and the one other tool in it is the update tool
# (_UPDATE_TOOLS) — rename or add one and that pin turns red.
# device_run performs them all: a shell command can open an app, write a file
# or show a notification. "run" ("I ran Notepad", "I executed the script") is
# running a program, and launching an app runs it (fix round 3: "I ran Notepad"
# after a real device_launch_app was corrected with "no device_run call ran");
# every other action — close, restart, delete… — only a command performs.
#
# An install is a command's too, and machine_update's (Task 32, MF4): it
# installs the hub's agent build on the machine it names (`machine`, read as
# its device by `_span_device`), so "I installed the new build on minipc"
# beside its call on minipc is backed — before, the guard appended "No
# device_run call ran on minipc" to a true claim. Whether "installed"
# over-claims an update that was only SENT is the update-claim guards'
# question (Task 23), never this one's: a successful call backs, whatever
# outcome it reported.
DEVICE_ACTION_TOOLS: dict[str, tuple[str, ...]] = {
    "launch": ("device_launch_app", "device_run"),
    "write": ("device_write_file", "device_run"),
    "notify": ("device_notify", "device_run"),
    "run": ("device_launch_app", "device_run"),
    "install": ("machine_update", "device_run"),
    "command": ("device_run",),
}

# The ACTIONS a claim can name, by the words it writes them with. The kind of
# tool that performs one is its own name for launch, write, notify, run and
# install, and a command for every other (`_kind_of`).
_ACTION_WORDS: dict[str, tuple[str, ...]] = {
    "launch": (
        "open",
        "opened",
        "opening",
        "launched",
        "launching",
        "started",
        "starting",
        "running",
        "up and running",
        "active",
    ),
    "write": ("saved", "saving", "written", "wrote", "created"),
    "notify": ("sent", "sending", "shown", "showing", "displayed"),
    "close": ("closed", "closing", "stopped", "stopping", "killed", "terminated", "quit"),
    "restart": ("restarted", "restarting", "rebooted", "rebooting"),
    "shutdown": ("shut down", "shutting down"),
    "delete": ("deleted", "deleting", "removed", "removing"),
    "move": ("moved", "moving"),
    "install": ("installed",),
    "uninstall": ("uninstalled",),
    "run": ("ran", "run", "executed"),
}
_ACTION_OF_WORD = {word: action for action, words in _ACTION_WORDS.items() for word in words}
_KINDED_ACTIONS = frozenset({"launch", "write", "notify", "run", "install"})


def _kind_of(action: str) -> str:
    """The kind of tool that performs `action` (DEVICE_ACTION_TOOLS' key)."""
    return action if action in _KINDED_ACTIONS else "command"


# A SEND of the hub's build is an INSTALL (Task 32 Phase B round 3, the
# controller's ruling on CORE's concern 1, option b). "sent" is a notify word,
# so after a REAL machine_update on minipc the honest "I sent the hub's build
# to minipc" — the very wording S42b asks for after an update ("sent, not
# confirmed until it reconnects") — drew "(No device_notify or device_run call
# ran on minipc this turn.)", a false correction. A send whose OBJECT is the
# hub's build is read as the install kind instead: backed by machine_update or
# device_run on that machine, through MF4's mapping, and never read as a
# notification — so with no call it still draws exactly one sentence, "(No
# machine_update or device_run call ran on minipc this turn.)". A notification,
# a message or an alert sent stays the notify kind, and so does a send whose
# object the guard cannot read ("I sent it to minipc").
#
# The objects are the update family's own words for the build (_ANY_BUILD: the
# hub's build, the new build, the build, the agent build…), "the update", and
# the ruling's indefinite "a new build" and "an agent build" — each the WHOLE
# object: someone else's build or update ("…of Firefox", "…for the printer"),
# news ("the update about the outage") and a notice the build names ("the
# update notification", "the build alert": the delivery guard's words for one)
# are no install of the hub's. Linear as _ANY_BUILD is: every alternative opens
# on a fixed word, and every whitespace run is possessive.
_SENT_BUILD = re.compile(
    rf"\b(?:{_ANY_BUILD}"
    r"|(?:an?\s++(?:(?:new|latest)\s++)?+(?:agent\s++)?+build|the\s++update)\b)"
    r"(?!\s++(?:of|for|about|regarding|notifications?|notices?|alerts?|messages?|reminders?"
    r"|notes?|pings?|push(?:es)?+|heads-?ups?)\b)",
    re.I,
)
_SEND_WORDS = frozenset({"sent", "sending"})
# A recipient written before a send's object — "sent minipc the hub's build",
# "sent your Windows PC's agent the update" — is at most this many words.
_RECIPIENT_WORDS = 4


# An ACTION's participle or progressive — the only states that are claims (C1).
_ACTION_PARTICIPLE = (
    r"(?:opened|launched|started|stopped|closed|killed|terminated|restarted|rebooted"
    r"|shut\s++down|saved|written|created|deleted|removed|moved|sent|run|executed|installed"
    r"|uninstalled)"
)
_ACTION_PROGRESSIVE = (
    r"(?:opening|launching|starting|restarting|rebooting|closing|stopping|shutting\s++down"
    r"|saving|deleting|removing|moving|sending)"
)
# A plain STATE ("Notepad is open", "your agents are running") is not a claim
# that anything was done — the state guard's business (C1, 212b9f8b) — unless
# "now" marks it as the change she made: "Notepad is now open".
_NOW_STATE = r"(?:open|running|up\s++and\s++running|active|showing|displayed)"
# "Notepad is now open", "Teams has been launched", "the file was saved": a
# subject, a copula, adverbs, the action. The copula is entered only from the
# end of the subject ("Notepad++", "C#" and a closing bracket end one too), so
# a run of padding is never re-entered at every position.
_ACTION_CLAIM = re.compile(
    r"(?<=[\w+#)\]`])(?P<copula>\s++(?:is|are|was|were|has\s++been|have\s++been|has|have)"
    r"|['’]s)"
    r"(?P<adverbs>(?:\s++(?:now|already|successfully|all|just|finally|also))*+)"
    rf"\s++(?P<word>{_ACTION_PARTICIPLE}|{_ACTION_PROGRESSIVE}|{_NOW_STATE})\b",
    re.I,
)
# A PRESENT passive — "is/are <participle>" — is how a thing is done, not a
# thing she did: "Notifications are sent to your Dell when a timer fires",
# "Teams is launched from the Start menu on your PC", "Files you create are
# saved to …" (fix round 2, C2). It is a claim only when marked as the change:
# "Notepad is now opened", "the file is just saved", "is successfully sent".
_PRESENT_BE = frozenset({"is", "are", "'s", "’s"})
_CHANGE_MARK = re.compile(r"\b(?:now|just|successfully|finally)\b", re.I)
_ACTION_VERB = (
    r"(?:opened|launched|started|stopped|closed|killed|restarted|rebooted|terminated|quit"
    r"|shut\s++down|installed|uninstalled|ran|executed|saved|wrote|created|deleted|removed"
    r"|moved|sent)"
)
# "I opened Teams", "I've gone ahead and opened…", "I just ran the script": her
# own completed action. "I'll", "I can", "I couldn't" never reach a verb here —
# precision comes from the lead, as in the deferral guard.
_FIRST_PERSON_ACTION = re.compile(
    r"\bI(?:['’]ve|\s++have|\s++just|\s++already|\s++successfully|\s++also|\s++now"
    r"|\s++finally|\s++(?:went|gone)\s++ahead\s++and)*+"
    rf"\s++(?P<verb>{_ACTION_VERB})(?:\s++up)?+\b",
    re.I,
)
# "Launched brave on DELL-XPS-8950." and "Successfully launched…" at the head of
# a clause — the old tool text's shape, which a fabrication imitates.
_HEAD_ACTION = re.compile(
    r"^[\W_]*+(?:(?:done|ok(?:ay)?|sure|great|perfect|all\s++set|successfully|just|now|finally"
    rf"|also)[\W_]++)*+(?P<verb>{_ACTION_VERB})\b",
    re.I,
)
# "Done — Notepad opened on your DELL-XPS-8950": a subject and an app's
# lifecycle verb, no copula.
_SUBJECT_ACTION = re.compile(
    r"(?<=[\w+#)\]`])\s++(?P<verb>opened|launched|started|closed|stopped|restarted|rebooted"
    r"|shut\s++down)\b",
    re.I,
)
# With no device named, a first-person claim counts only for an app's
# lifecycle ("opened", "launched", "stopped"…) and an object that names an app
# (a capitalised name) or a word for one — never "the page", "a timer", "the
# notes", which are other tools' objects — or a pronoun, when a call that
# performs it was made this turn ("I launched it." after a launch that failed).
_LIFECYCLE_VERBS = frozenset(
    {"opened", "launched", "started", "stopped", "closed", "killed", "restarted", "terminated"}
    | {"quit", "shut down"}
)
# A capitalised word may carry inner dots ("Node.js") but never a trailing one:
# that is the sentence's own period.
_APP_WORD = r"[A-Z][\w+&#-]*+(?:\.[\w+&-]++)*+"
_APP_OBJECT = re.compile(
    r"(?<![ \t])[ \t]++(?:(?:the|your|a|an|that|this)[ \t]++)?"
    rf"(?P<object>{_APP_WORD}(?:[ \t]++{_APP_WORD}){{0,3}}"
    r"|(?i:apps?|applications?|programs?|browsers?|services?|process(?:es)?|windows?"
    r"|terminal))(?![\w+])"
)
_PRONOUN_OBJECT = re.compile(r"[ \t]++(?P<object>it|that|this|them)\b", re.I)
# How far after a claim its device may be named, and what may not sit between
# them: a clause break. ", " and ": " break (a Windows drive's "C:\" does not),
# so do a spaced dash and the words that start another clause. The same breaks
# bound how far back a cut reaches (I3: "No problem — Notepad is now open" is a
# claim; "Let me check whether Notepad is open" is not).
_ANCHOR_REACH = 60
_ANCHOR_BREAK = re.compile(
    r"[,;]\s|:\s|\s[—–-]\s|[—–]\s|\b(?:and|but|so|then|or|while|which|where|who|whom|whereas)\b",
    re.I,
)
# A claim whose subject is one of these is not hers: "you have opened it",
# "they have saved it", "let's" (a suggestion), and a relative clause's
# pronoun ("the Brave that is running on your PC is version 1.70").
_NOT_HER_SUBJECT = frozenset(
    {"you", "he", "she", "they", "someone", "somebody", "everyone", "everybody", "let"}
    | {"that", "which", "who", "whom", "whose"}
)
# Words that precede a lifecycle verb as an auxiliary, not a subject: the
# copula shape reads those ("has opened"), the first-person shape "I opened".
_NOT_A_SUBJECT = frozenset(
    {"i", "has", "have", "had", "was", "were", "is", "are", "been", "be", "being"}
    | {"just", "also", "already", "now", "then", "not", "never", "successfully", "finally"}
    | {"done", "ok", "okay", "sure", "great", "perfect", "set"}
    # "Apps started on your PC stay running": a kind of thing, not a thing done
    | {"apps", "applications", "programs", "files", "windows", "processes", "services"}
)
# After a device, a verb makes "Apps started on your PC" a noun phrase: "…stay
# running", "…is still there".
_THEN_A_VERB = re.compile(
    r"[ \t]++(?:stay|stays|remain|remains|is|are|was|were|will|can|could|may|might|should"
    r"|would|keep|keeps|run|runs|have|has|do|does|get|gets|appear|appears|show|shows)\b",
    re.I,
)
# A claim relayed through a reporting verb: "…reports that the app was launched".
_RELAYED_THAT = re.compile(
    r"\b(?:reports?|reported|says?|said|states?|stated|shows?|showed|notes?|noted|means?"
    r"|meant|tells?|told|claims?|claimed|returns?|returned|prints?|printed)\s++that\b",
    re.I,
)
# A subject's contraction: "you've" is "you".
_CONTRACTION = re.compile(r"['’](?:ve|re|ll|d|s|m)$", re.I)
# A model or an engine running on a machine is a SERVING claim — the stack and
# served-model guards' business, and true with no device tool at all: the Dell
# serves models in this household (`dell:qwen3:8b`). A model reference is
# "name:tag".
_SERVING_SUBJECT = re.compile(r"\b(?:models?|ollama|vllm|llm|inference|gpu|vram)\b|\w:\w", re.I)
# Someone or something else did it: "…saved by Windows Backup", "…by the backup
# timer", "…via OneDrive sync", "…overnight" (fix round 2, C2: another actor
# without "by"). Read only after a PASSIVE or subject claim — "I opened it by
# double-clicking" is still her.
_OTHER_CAUSE = re.compile(r"\bby\s+(?!me\b|myself\b)[\w']+|\bvia\b|\bovernight\b", re.I)
# Items the machine starts by itself: "Launched on your Dell at login: OneDrive,
# Teams".
_STARTUP = re.compile(
    r"\b(?:at|on|during|upon)\s++(?:log-?in|logon|sign-?in|start-?up|boot(?:ing)?|reboot)\b"
    r"|\bautomatically\b|\bon\s++its\s++own\b|\bby\s++itself\b",
    re.I,
)
# A device the claim can be ON is named after one of these.
_ANCHOR_PREPOSITION = r"(?:on|to|onto|from)"
_ANCHOR_DETERMINER = r"(?:your|the|my|this|that|his|her|their|our)"
# The words for one of her machines, after a determiner ("your PC", "the
# laptop", "your Windows PC", "your Linux box"). Each names ANY of her devices
# (fix round 3, T3 — `_resolve_place`).
_DEVICE_WORDS = (
    r"(?:pc|computer|laptop|desktop|machine|device|workstation|imac|macbook|mac"
    r"|linux[ \t]++box)"
)
# Markdown around a device's name: `DELL-XPS-8950`, __DELL-XPS-8950__, and an
# emoji between "your" and the name ("your 💻 DELL-XPS-8950"). A link is
# rewritten to its text before anything is read.
_NAME_WRAP = r"[`_]{0,3}"
_MD_LINK = re.compile(r"\[([^\[\]\n]{1,120})\]\([^()\s]{0,300}\)")
# What before a claim, in its own segment, means it is not one: a negation
# ("almost" and "nearly" too: "I almost opened Notepad"), a hedge or
# subordinator, an intent to establish it. Each is found ONCE per clause and
# compared by position.
_ACTION_NEGATION = re.compile(
    r"\b(?:no|not|never|nothing|none|neither|nor|without|unable|cannot|almost|nearly)\b"
    r"|n['’]t\b",
    re.I,
)
# "will" and "shall" too (fix round 3, the re-review's modal probes): "Notepad
# will have opened on your Dell by then" is a future, not a report.
_ACTION_HEDGE = re.compile(
    r"\b(?:if|whether|unless|in\s+case|assuming|suppose|supposing|maybe|perhaps|possibly"
    r"|might|may|could|would|should|will|shall|once|when|whenever|until|before|after"
    r"|either|since|because|while|though|although)\b",
    re.I,
)
# A CONDITION or a time it happens at, anywhere in the claim's own segment —
# before it or after it (fix round 2, C2): "Notifications are sent to your
# Dell when a timer fires", "OneDrive started on your Dell when you logged in",
# "Teams was restarted on your Dell after the update". And one that opens the
# sentence governs every clause in it: "As soon as Teams has launched on your
# PC, click Join", "Once it's done, Teams has launched on your PC".
_CONDITION_WORDS = (
    r"(?:once|when(?:ever)?+|if|unless|as\s++soon\s++as|the\s++moment|after|before|until|till"
    r"|every\s++time|each\s++time|while|in\s++case)"
)
_ACTION_CONDITION = re.compile(rf"\b{_CONDITION_WORDS}\b", re.I)
_FRONTED_CONDITION = re.compile(rf"^[\W_]*+{_CONDITION_WORDS}\b", re.I)
_ACTION_INTENT = re.compile(
    r"\b(?:check|checking|verify|verifying|confirm|confirming|see|test|testing|determine"
    r"|determining|find\s+out|ping|pinging|ensure|ensuring|make\s+sure|making\s+sure)\b",
    re.I,
)
_NOW_AFTER = re.compile(r"[ \t]++(?:right[ \t]++)?now\b", re.I)
# A device call's refusal in the HUB's own words for a command it SENT and got
# no answer to — its timeout, a socket that dropped with the command pending, a
# connection closed under it (app/devices_ws.py, pinned against the running hub
# in tests/test_devices_ws.py). Whether it happened is then not known, and the
# sentence says exactly that (R-A). Read only in core's words: inside the
# device's OWN answer the same words are a failure it stated (fix round 4, R3).
_NO_ANSWER = re.compile(
    r"\b(?:did\s++not\s++answer|disconnected\s++before\s++it\s++answered"
    r"|connection\s++closed)\b",
    re.I,
)
# The DEVICE's own answer that the command it ran timed out (novad's
# internal/caps/shell.go: "timed out; partial output:"). It answered, so this is
# not "no answer": the sentence says it timed out, and where (fix round 4, R3).
_DEVICE_TIMED_OUT = re.compile(r"timed\s++out\b", re.I)
# Words that invite her to do it again or hand it back (fix round 4, R2): a
# quoted failure reason never carries one.
_INVITATION = re.compile(
    r"\b(?:again|retr(?:y|ies|ying)|tr(?:y|ies|ying)|ask(?:s|ing)?+)\b",
    re.I,
)
# Where a failure reason's clause ends, for cutting off the one that invites.
_REASON_CLAUSE_END = re.compile(r"[;,:(]|\s[-–]\s")
_REASON_MAX = 120


@lru_cache(maxsize=16)
def _device_anchor(names: tuple[str, ...]) -> re.Pattern[str]:
    """ "on your DELL-XPS-8950", "to the laptop", "on your Dell": the device a
    claim is on. DERIVED from the paired names: a paired name, alone or after a
    determiner; after a determiner, a word for a machine or a word of a paired
    name, with up to two capitalised words before it ("your Windows PC"); or a
    paired name's word alone ("on DELL") — "Dell" is a device BECAUSE a
    DELL-XPS-8950 is paired. Markdown around the name is read through. Cached
    on the names, like the state guard's patterns."""
    named = "|".join(re.escape(name) for name in sorted(names, key=lambda n: (-len(n), n)))
    words = sorted({word.lower() for name in names for word in re.findall(r"[A-Za-z]{3,}", name)})
    worded = "|".join([_DEVICE_WORDS, *(re.escape(word) for word in words)])
    wrap = r"(?:[^\w\s]{1,4}[ \t]++)?" + _NAME_WRAP
    alternatives = [
        rf"{_ANCHOR_DETERMINER}\s++{wrap}(?:(?-i:[A-Z][\w-]*+)[ \t]++){{0,2}}"
        rf"(?P<word>{worded}){_NAME_WRAP}\b"
    ]
    if named:
        alternatives.insert(
            0,
            rf"(?:{_ANCHOR_DETERMINER}\s++)?{wrap}(?P<name>{named}){_NAME_WRAP}"
            r"(?![\w-]|\.\w|:\w)",
        )
    if words:
        bare = "|".join(re.escape(word) for word in words)
        alternatives.append(rf"{_NAME_WRAP}(?P<bare>{bare}){_NAME_WRAP}(?![\w-]|['’]s|\.\w|:\w)")
    return re.compile(rf"\b{_ANCHOR_PREPOSITION}\s++(?:{'|'.join(alternatives)})", re.I)


def _paired(device_names: Sequence[str] | Mapping[str, str]) -> tuple[str, ...]:
    """The paired names, sorted — from a sequence of names, or the keys of a
    mapping of name to anything."""
    return tuple(sorted({str(name).strip() for name in device_names if str(name).strip()}))


def _name_words(name: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", name.lower())


def _resolve_place(
    place: re.Match[str], names: tuple[str, ...]
) -> tuple[frozenset[str] | None, str]:
    """The paired devices a claim's place names, and how its sentence says it
    (fix round 3, T3):

      * a paired name is that device;
      * a word of paired names ("your Dell", "on DELL") the devices it is a
        word of;
      * a word for a machine — "your PC", "your computer", "your Mac", "the
        laptop", "your Windows PC" — names ANY device (None): a Linux
        household's "your PC" is its Linux box, and the sentence must never
        say nothing ran on a machine that may be the one she meant.

    The sentence names the one device, or says her words when they name a
    machine in general or several."""
    written = re.sub(r"[`*_]", "", place.group(0)).strip()
    written = re.sub(rf"^{_ANCHOR_PREPOSITION}\s+", "", written, flags=re.I)
    groups = place.re.groupindex
    named = place.group("name") if "name" in groups else None
    if named:
        by_lower = {name.lower(): name for name in names}
        return frozenset({by_lower.get(named.lower(), named)}), by_lower.get(named.lower(), named)
    word = next(
        (
            place.group(group)
            for group in ("word", "bare")
            if group in groups and place.group(group)
        ),
        "",
    )
    word = " ".join(word.lower().split())
    if re.fullmatch(_DEVICE_WORDS, word, re.I):
        return None, written
    devices = frozenset(name for name in names if word in _name_words(name))
    return devices, (next(iter(devices)) if len(devices) == 1 else written)


def _subject_start(text: str, position: int) -> int:
    """Where the subject of a copula at `position` starts: up to four words
    back, stopping at punctuation that closes a thought or 80 characters back,
    whichever comes first. Plain string work on a bounded window, so no
    pattern is walked twice and a long run of letters is never walked whole.
    ":" and "/" belong to a word here, so a model reference (`qwen3:8b`) is read
    as the one subject it is."""
    floor = max(0, position - 80)
    start = position
    words = 0
    while words < 4:
        end = start
        while end > floor and text[end - 1] in " \t":
            end -= 1
        begin = end
        while begin > floor and (text[begin - 1].isalnum() or text[begin - 1] in "_'’.+&#:/`-"):
            begin -= 1
        if begin == end:
            break
        start = begin
        words += 1
    return start


def _sent_object(text: str, at: int) -> tuple[re.Match[str], tuple[int, int] | None] | None:
    """The hub's build a send names (_SENT_BUILD), read from the end of its
    verb at `at`: right after it — "sent the hub's build to minipc" — or after
    a recipient written first, of up to _RECIPIENT_WORDS words within
    _ANCHOR_REACH — "sent minipc the hub's build", "sent it the update".
    Returns (object, recipient): the recipient's (start, end) in `text`, None
    when none was written. None when the send names no build. Plain string
    work over a bounded stretch after the verb."""
    limit = min(len(text), at + _ANCHOR_REACH)
    start = at
    while start < limit and text[start] in " \t":
        start += 1
    if start == at or start >= limit:
        return None
    found = _SENT_BUILD.match(text, start)
    if found is not None:
        return found, None
    end = start
    for _ in range(_RECIPIENT_WORDS):
        while end < limit and text[end] not in " \t,;:":
            end += 1
        following = end
        while following < limit and text[following] in " \t":
            following += 1
        if following == end or following >= limit:
            return None  # a clause mark, or past the reach: no object follows
        found = _SENT_BUILD.match(text, following)
        if found is not None:
            return found, (start, end)
        end = following
    return None


def _subject_build(text: str, begin: int, end: int) -> re.Match[str] | None:
    """The hub's build as the SUBJECT of a send — "The hub's build has been
    sent to minipc", "Done: the update was sent to minipc": the subject, from
    `begin` (`_subject_start`, at most four words) to its copula at `end`,
    ends in it. Tried from each of its words."""
    at = begin
    while at < end:
        found = _SENT_BUILD.fullmatch(text, at, end)
        if found is not None:
            return found
        while at < end and text[at] not in " \t":
            at += 1
        while at < end and text[at] in " \t":
            at += 1
    return None


def _is_her_span(span: Any) -> bool:
    """A tool span SHE made this turn: not a check the backend ran unasked
    (live_facts' `unasked`), and not a call refused before it ran (markup, a
    closed round — `refused_*`, as `_attempted` reads it)."""
    if getattr(span, "kind", None) != "tool":
        return False
    meta = getattr(span, "meta", None) or {}
    if meta.get("unasked") is True:
        return False
    return not any(str(key).startswith("refused") for key in meta)


def _span_args(span: Any) -> dict | None:
    args = (getattr(span, "meta", None) or {}).get("args_redacted")
    return args if isinstance(args, dict) else None


def _span_device(span: Any) -> str | None:
    """The device a call's record names: its `device` argument — or, for the
    update tool (_UPDATE_TOOLS), its `machine`, the paired machine whose agent
    it updates (Task 32, MF4). None when the record names none."""
    args = _span_args(span)
    key = "machine" if getattr(span, "name", None) in _UPDATE_TOOLS else "device"
    device = args.get(key) if args is not None else None
    return device if isinstance(device, str) and device.strip() else None


# -- what a call PERFORMED: the target, by name (fix round 2, C1) --------------
#
# A launch claim is backed only by a call whose target is the claimed app by
# its WHOLE name — case, spaces, ".exe" and markdown aside, "++" kept: no
# shared word ("Microsoft" in Edge and Teams), no substring ("notepad" in
# "notepad++", "word" in "wordpad", "Visual Studio" in "Visual Studio Code").
# One allowance: a name may carry one more word IN FRONT — a vendor —
# "Microsoft Teams" is "Teams", and "Google Chrome" "Chrome". A trailing word is
# never allowed ("Visual Studio Code" is not "Visual Studio").
_APP_DETERMINERS = frozenset("the your my a an this that his her their our".split())
_APP_TAIL = frozenset("app apps application applications program programs browser window".split())
_PRONOUNS = frozenset({"it", "that", "this", "them", "they"})


def _app_key(name: str) -> tuple[str, ...]:
    """A name's words for whole-name matching: markdown, quotes and a path out,
    case folded, ".exe"/".lnk"/".app" dropped, a leading determiner and a
    trailing word that names no app ("app", "browser") dropped."""
    text = re.sub(r"[`*_\"“”‘’]", " ", name).strip()
    text = re.split(r"[\\/]", text)[-1]
    text = re.sub(r"\.(?:exe|lnk|app)\b", "", text.lower())
    words = [word.strip("'.,:;!?()[]{}") for word in text.split()]
    words = [word for word in words if word]
    while words and words[0] in _APP_DETERMINERS:
        words.pop(0)
    while words and words[-1] in _APP_TAIL:
        words.pop()
    return tuple(words)


def _same_app(claimed: str, held: str) -> bool:
    """Is the app a call named (`held`) the app she claimed? A claim that names
    no app in particular ("it", "the app") is any app; a record that names
    nothing readable cannot be told apart, and counts."""
    mine, theirs = _app_key(claimed), _app_key(held)
    if not mine or not theirs or (len(mine) == 1 and mine[0] in _PRONOUNS):
        return True
    if mine == theirs or "".join(mine) == "".join(theirs):
        return True
    short, long = sorted((mine, theirs), key=len)
    return len(long) == len(short) + 1 and long[1:] == short


# What a device_run COMMAND does, read off its argv — when unsure, it did NOT
# do the claimed thing. The shells that wrap a command, and the flag each takes
# it after; the words that run the rest of it as someone else or detached.
# `-File` runs a script: what follows it is the program that ran (fix round 3,
# C1: "I ran cleanup.ps1").
_SHELL_FLAGS: dict[str, tuple[str, ...]] = {
    "cmd": ("/c", "/k"),
    "powershell": ("-command", "-c", "-file", "-f"),
    "pwsh": ("-command", "-c", "-file", "-f"),
    "sh": ("-c",),
    "bash": ("-c",),
    "zsh": ("-c",),
}
_PREFIX_PROGRAMS = frozenset({"sudo", "doas", "nohup", "setsid"})
# Programs that only READ: never a launch of anything, and never an action.
_READ_PROGRAMS = frozenset(
    (
        "tasklist where which whereis dir ls type cat more less head tail hostname whoami ps "
        "get-process gps get-childitem gci get-content gc get-service gsv get-item systeminfo "
        "ver uname echo find findstr grep test-path test-connection ping ipconfig ifconfig "
        "netstat"
    ).split()
)
# Programs that PERFORM each action other than a launch. A program not listed
# for an action backs no claim of it.
_ACTION_PROGRAMS: dict[str, frozenset[str]] = {
    "write": frozenset(
        "set-content add-content out-file tee new-item ni touch mkdir md copy cp copy-item cpi "
        "xcopy robocopy".split()
    ),
    "notify": frozenset("msg notify-send terminal-notifier".split()),
    "close": frozenset(
        "taskkill tskill kill pkill killall stop-process spps stop-service spsv".split()
    ),
    "restart": frozenset("shutdown reboot restart-computer restart-service".split()),
    "shutdown": frozenset("shutdown stop-computer poweroff halt".split()),
    "delete": frozenset("del erase rm rmdir rd remove-item ri unlink".split()),
    "move": frozenset("move mv move-item mi ren rename rename-item".split()),
    "install": frozenset(
        "winget choco scoop apt apt-get dnf yum pacman brew msiexec pip pip3 npm "
        "install-package".split()
    ),
    "uninstall": frozenset(
        "winget choco scoop apt apt-get dnf yum pacman brew msiexec pip pip3 npm "
        "uninstall-package".split()
    ),
}
# A package manager installs or removes only by the subcommand that says so,
# and a service manager stops or restarts only by its own.
_SUBCOMMANDS: dict[str, frozenset[str]] = {
    "install": frozenset({"install", "add", "/i"}),
    "uninstall": frozenset({"uninstall", "remove", "purge", "erase", "/x"}),
}
_SERVICE_PROGRAMS: dict[str, dict[str, str]] = {
    "net": {"close": "stop"},
    "sc": {"close": "stop"},
    "systemctl": {"close": "stop", "restart": "restart"},
    "service": {"close": "stop", "restart": "restart"},
}
# The programs whose target is the machine itself.
_MACHINE_PROGRAMS = frozenset(
    "shutdown reboot restart-computer stop-computer poweroff halt".split()
)
_LAUNCHERS = frozenset({"start", "start-process", "saps", "open", "gtk-launch", "explorer"})
# The words of a claim's target that name nothing in particular.
_TARGET_FILLER = frozenset(
    (
        "the your my a an this that these those it its them they all some any file files "
        "folder folders app apps application applications program programs script scripts "
        "service services process processes command commands notification notifications "
        "message messages window for you me again now too up"
    ).split()
)


def _program(word: str) -> str:
    """A command word's program: its basename, lower-cased, no extension."""
    base = re.split(r"[\\/]", word.strip().strip("\"'"))[-1].lower()
    return re.sub(r"\.(?:exe|com|bat|cmd|ps1|lnk|app)$", "", base)


def _split_command(command: str) -> list[str]:
    try:
        words = shlex.split(command[:2000], posix=False)
    except ValueError:
        words = command[:2000].split()
    return [word.strip("\"'") if len(word) > 1 else word for word in words]


def _command(argv: object) -> list[str] | None:
    """The words of the command a device_run argv RUNS: a one-string command
    split, and `cmd /c …`, `powershell -c …`, `sh -c …`, a leading sudo/doas and
    `wsl … --` read through, a bounded number of times. None when the record is
    not an argv."""
    if not isinstance(argv, list) or not argv:
        return None
    words = [str(part) for part in argv]
    for _ in range(4):
        if len(words) == 1 and any(char.isspace() for char in words[0]):
            words = _split_command(words[0])
        if not words:
            return words
        program = _program(words[0])
        rest = words[1:]
        if program in _PREFIX_PROGRAMS:
            words = rest
            continue
        if program == "wsl":
            lowered = [word.lower() for word in rest]
            for flag in ("--", "-e", "--exec"):
                if flag in lowered:
                    words = rest[lowered.index(flag) + 1 :]
                    break
            else:
                at = 0
                while at < len(rest) and rest[at].startswith("-"):
                    takes = rest[at].lower() in ("-d", "--distribution", "-u", "--user", "--cd")
                    at += 2 if takes else 1
                words = rest[at:]
            continue
        flags = _SHELL_FLAGS.get(program)
        if flags is None:
            return words
        lowered = [word.lower() for word in rest]
        at = next((i for i, word in enumerate(lowered) if word in flags), None)
        if at is not None:
            words = rest[at + 1 :]
        else:
            # A flag starts with "/" only for cmd: to a POSIX shell "/home/owner/x.sh"
            # is the script it runs (fix round 3, C1).
            flag = ("/",) if program == "cmd" else ("-",)
            words = [word for word in rest if not word.startswith(flag)]
    return words


def _launched_app(words: list[str]) -> str | None:
    """The app a command LAUNCHES, or None when it launches none (fix round 2,
    C1): the program itself (`notepad`, `C:\\…\\notepad++.exe`), or the target
    of `start`, `Start-Process`, `open -a`, `gtk-launch` or `explorer
    shell:AppsFolder\\…`. A read (`tasklist`, `where`) or an action program
    (`taskkill`) launches nothing."""
    if not words:
        return None
    program = _program(words[0])
    rest = [word.strip("\"'") if len(word) > 1 else word for word in words[1:]]
    if program in ("start", "start-process", "saps"):
        targets: list[str] = []
        at = 0
        while at < len(rest):
            low = rest[at].lower()
            if low == "/d" or low in ("-filepath", "-file", "-path"):
                at += 2 if low == "/d" else 1
                continue
            if low.startswith("/") or (low.startswith("-") and program != "start"):
                at += 1
                continue
            targets.append(rest[at])
            at += 1
        # cmd's `start` takes a quoted TITLE first: empty, or words, before the
        # program it starts.
        if program == "start" and len(targets) > 1 and (not targets[0] or " " in targets[0]):
            targets = targets[1:]
        targets = [target for target in targets if target and target not in ('""', "''")]
        return targets[0] if targets else None
    if program == "open":
        for at, word in enumerate(rest[:-1]):
            if word == "-a":
                return rest[at + 1]
        return None  # `open <file>` opens a file, not an app by name
    if program == "gtk-launch":
        return rest[0] if rest else None
    if program == "explorer":
        for word in rest:
            if word.lower().startswith("shell:appsfolder"):
                return word[len("shell:appsfolder") + 1 :] or None
        return "explorer"  # File Explorer, at a folder or not
    acting = any(program in programs for programs in _ACTION_PROGRAMS.values())
    if program in _READ_PROGRAMS or acting or program in _SERVICE_PROGRAMS:
        return None
    return words[0]


def _target_words(text: str) -> frozenset[str]:
    return frozenset(
        word
        for word in re.findall(r"[a-z0-9]+", text.lower())
        if len(word) > 1 and word not in _TARGET_FILLER
    )


def _covers(target: str, record: str) -> bool:
    """Does a call's record name what the claim names? Every word of the
    claim's target that names something is among the record's words; a target
    that names nothing in particular ("it", "the files") is covered by any."""
    wanted = _target_words(target)
    return not wanted or wanted <= frozenset(re.findall(r"[a-z0-9]+", record.lower()))


def _same_file(target: str, path: str) -> bool:
    """A write names the claimed file: its filename when she named one
    ("report-final.txt"), else the words she named it by ("the notes")."""
    named = _FILENAME_IN.search(target)
    if named is not None:
        wanted = named.group(1).lower().replace("\\", "/")
        held = path.lower().replace("\\", "/")
        return held == wanted or held.endswith("/" + wanted.rsplit("/", 1)[-1])
    return _covers(target, path)


# The interpreters that run the script named after them: `python cleanup.py`
# runs cleanup.py (the shells' own script form — `bash x.sh`, `powershell -File
# x.ps1` — is read through by `_command`).
_INTERPRETERS = frozenset("python python3 py node ruby perl php deno bun".split())


def _ran_program(words: list[str]) -> str:
    """What a command RAN, as names a "ran"/"executed" claim can be read
    against (fix round 3, C1): its program's basename, with and without the
    extension, and the script an interpreter was given — never an argument,
    so `cat cleanup.sh` ran cat, not the cleanup script."""
    base = re.split(r"[\\/]", words[0].strip().strip("\"'"))[-1]
    names = [base, _program(words[0])]
    if _program(words[0]) in _INTERPRETERS:
        script = next((word for word in words[1:] if not word.startswith("-")), None)
        if script is not None:
            names += [re.split(r"[\\/]", script)[-1], _program(script)]
    return " ".join(names)


def _run_performs(words: list[str], action: str, target: str, device: str | None) -> bool:
    """Did this device_run command perform the claimed action on the claimed
    target? Read off its argv (`_command`): a launch by `_launched_app` and the
    app's whole name; "ran"/"executed" by the PROGRAM it ran (C1: never a read
    whose argument names it); any other action only by a program that performs
    it (`_ACTION_PROGRAMS`, a subcommand where one is needed) on a target the
    command names. Since fix round 3 this only chooses WHICH failure the
    sentence states (`_claim_record`): any call that succeeded silences it."""
    if action == "launch":
        app = _launched_app(words)
        return app is not None and _same_app(target, app)
    if not words:
        return False
    program = _program(words[0])
    lowered = frozenset(word.lower() for word in words[1:])
    named = " ".join(words[1:])
    if action == "run":
        return _covers(target, _ran_program(words))
    if program in _SERVICE_PROGRAMS:
        subcommand = _SERVICE_PROGRAMS[program].get(action)
        return subcommand is not None and subcommand in lowered and _covers(target, named)
    if program not in _ACTION_PROGRAMS.get(action, ()):
        return False
    if action in _SUBCOMMANDS and not lowered & _SUBCOMMANDS[action]:
        return False
    if program in _MACHINE_PROGRAMS:
        return _covers(target, device or "")
    if action == "write" and _FILENAME_IN.search(target) is not None:
        return any(_same_file(target, word) for word in words[1:])
    return _covers(target, named)


def _performs(span: Any, action: str, target: str, commands: dict[int, list[str] | None]) -> bool:
    """Did this call perform the claimed action on the claimed target? A record
    that cannot be read cannot be told apart and counts — the record, not the
    claim, is what is missing. `commands` holds each device_run's argv, split
    once per check however many claims read it (fix round 3, T5)."""
    args = _span_args(span)
    if args is None:
        return True
    name = getattr(span, "name", None)
    if name == "device_launch_app":
        app = args.get("app")
        return _same_app(target, app) if isinstance(app, str) else True
    if name == "device_notify":
        return True
    if name == "device_write_file":
        path = args.get("path")
        return _same_file(target, path) if isinstance(path, str) else True
    if name == "device_run":
        if id(span) not in commands:
            commands[id(span)] = _command(args.get("argv"))
        words = commands[id(span)]
        if words is None:
            return True
        return _run_performs(words, action, target, _span_device(span))
    return False


def _quoted_reason(reason: str) -> str | None:
    """A failure's reason as the sentence quotes it (fix round 4, R2): a FACT
    about the call, never advice to her.

      * its FIRST line only — a command's partial output is not its reason;
      * cut at its first " — ": after it, core's own refusals say what to do
        next ("— remove the malformed character and try again", "— its tile
        is stale; check it is powered on and online");
      * never an invitation (`_INVITATION`: again, retry, try, ask) — a clause
        that still carries one is cut off with everything after it, and when
        nothing is left before it, nothing is quoted (None);
      * clipped to 120 characters at a word, with an ellipsis."""
    lines = reason.strip().splitlines()
    text = lines[0].split(" — ", 1)[0] if lines else ""
    invitation = _INVITATION.search(text)
    if invitation is not None:
        ends = [m.start() for m in _REASON_CLAUSE_END.finditer(text, 0, invitation.start())]
        text = text[: ends[-1]] if ends else ""
        if not re.search(r"[A-Za-z]{3}", text):
            return None  # nothing of the reason is left before it but a fragment
    text = text.strip().rstrip(" .,;:—–-").rstrip()
    if len(text) > _REASON_MAX:
        cut = text[: _REASON_MAX - 1]
        space = cut.rfind(" ")
        if space >= _REASON_MAX // 2:
            cut = cut[:space]
        text = cut.rstrip(" .,;:—–-") + "…"
    return text or None


def _failure_record(call: _Ran) -> DeviceRecord:
    """What one call of the family that did not succeed shows (fix round 4,
    R3), from the words its span recorded:

      * the DEVICE answered — core wrote its words after "<device>: "
        (tools/devices.py `_require_ok`) — that the command timed out: it
        timed out THERE, and is said so;
      * no answer came at all, in the HUB's words (`_NO_ANSWER`): whether it
        worked is not known;
      * else it failed, with its reason as `_quoted_reason` quotes it — the
        device's own words after its name, or core's."""
    meta = getattr(call.span, "meta", None) or {}
    said = str(meta.get("error") or meta.get("result_head") or "").strip()
    if said.startswith("Error: "):
        said = said[len("Error: ") :]
    device = _span_device(call.span)
    if device and said.lower().startswith(f"{device.lower()}: "):
        said = said[len(device) + 2 :]
        if _DEVICE_TIMED_OUT.match(said):
            return DeviceRecord("timed_out", tool=call.name, device=device)
    elif _NO_ANSWER.search(said):
        return DeviceRecord("no_answer", tool=call.name)
    return DeviceRecord("failed", tool=call.name, reason=_quoted_reason(said))


@dataclass(frozen=True)
class _Ran:
    """One tool call the turn's record holds, read once per check (fix round
    3, T5): its name, the device it named (lower-cased, None when its record
    names none), whether it succeeded, and its span."""

    name: str
    device: str | None
    ok: bool
    span: Any


def _calls_that_ran(spans: Sequence[Any]) -> list[_Ran]:
    """Every tool call that RAN this turn — hers, or a check the backend ran
    unasked: the record is what the sentence states, and a call that ran is
    never said not to have. A REFUSED call (markup, a closed round —
    `refused_*`, as `_attempted` reads it) never ran and is not in it."""
    ran: list[_Ran] = []
    for span in spans:
        if getattr(span, "kind", None) != "tool":
            continue
        meta = getattr(span, "meta", None) or {}
        if any(str(key).startswith("refused") for key in meta):
            continue
        device = _span_device(span)
        ran.append(
            _Ran(
                str(getattr(span, "name", "")),
                device.lower() if device else None,
                meta.get("ok") is True,
                span,
            )
        )
    return ran


def _is_there(reading: _Reading, wanted: frozenset[str] | None, device: str | None) -> bool | None:
    """Whether a call on `device` (lower-cased) ran THERE, for a claim about
    `wanted` (lower-cased paired names; None for any device):

      * True on one of them, on any device when she named none or a word for
        one, and for a call whose record names no device (fix round 3, T3) —
        and on an agent of the SAME machine as one of them (fix round 4, R5):
        grouped by the machine each agent reported, as machine_status groups
        them (`reading.machines`, from the live rows);
      * False on an agent of another machine, or on a name no live device has;
      * None when that cannot be told — no grouping was read at all, or the
        machine of the call's device or of a claimed one cannot be read (an
        agent that reported none, or one inside WSL, whose machine id is WSL's
        own: `device_facts.machine`)."""
    if wanted is None or device is None or device in wanted:
        return True
    machines = reading.machines
    if machines is None:
        return None
    if device not in machines:
        return False
    theirs = machines[device]
    ours = [machines.get(name) for name in wanted]
    if theirs is None or any(machine is None for machine in ours):
        return None
    return theirs in ours


def _silenced(reading: _Reading, kind: str, devices: frozenset[str] | None) -> bool:
    """Whether the record silences a claim of `kind` on `devices` before
    anything else about it is read:

      * a call of the tools that perform it SUCCEEDED there (`_is_there`),
        whatever it ran for (fix round 3, T3: the record cannot equate an
        app's id, alias, URI or suffixed Start-menu name with the name she
        used, and a false correction is worse than a missed one);
      * or one RAN, whatever its outcome, where it cannot be told whether that
        is the machine she meant (fix round 4, R5): "No … call ran on X" may
        then be false of the machine, and the guard says nothing.

    Asked once per kind and place however many claims read it (R4)."""
    key = (kind, devices)
    if key not in reading.silenced:
        family = DEVICE_ACTION_TOOLS[kind]
        wanted = None if devices is None else frozenset(device.lower() for device in devices)
        verdict = False
        for call in reading.ran:
            if call.name not in family:
                continue
            there = _is_there(reading, wanted, call.device)
            if there is None or (there and call.ok):
                verdict = True
                break
        reading.silenced[key] = verdict
    return reading.silenced[key]


def _claim_record(
    reading: _Reading,
    kind: str,
    action: str,
    devices: frozenset[str] | None,
    target: str,
) -> DeviceRecord:
    """What the record shows about one claim that `_silenced` did not silence.

    What is left to state: a call of the tools that perform it, THERE
    (`_is_there`: on that device or an agent of its machine; any device when
    she named none or used a word for one), that got no answer, that the
    device answered had timed out, or that failed with its reason
    (`_failure_record`) — the one that performed THIS action on THIS target
    first, when one did (`_performs`, C1: choosing which failure to state is
    all the target is read for now), and an outcome that is not known before
    a failure — else that none ran. A call on another machine is not in it."""
    family = DEVICE_ACTION_TOOLS[kind]
    wanted = None if devices is None else frozenset(device.lower() for device in devices)
    calls = [
        call
        for call in reading.ran
        if call.name in family and _is_there(reading, wanted, call.device)
    ]
    if not calls:
        return DeviceRecord()
    preferred = [
        call for call in calls if _performs(call.span, action, target, reading.commands)
    ] or calls
    records = [_failure_record(call) for call in preferred]
    return next((r for r in records if r.case in ("no_answer", "timed_out")), records[0])


def _clean_target(text: str) -> str:
    """What she said was done, as `_performs` reads it: markdown out, a
    trailing "for you", "again" or "now" and a leading "up" dropped, a leading
    determiner or a pronoun in lower case. "it" when nothing is left."""
    words = re.sub(r"[*`]", "", text).split()
    if words and words[0].lower() == "up":
        words.pop(0)
    while len(words) >= 2 and " ".join(words[-2:]).lower() in ("for you", "for me", "right now"):
        del words[-2:]
    while words and words[-1].lower().strip(".,!") in ("again", "now", "too", "successfully"):
        words.pop()
    if not words:
        return "it"
    first = words[0].lower()
    if first in _APP_DETERMINERS or first in _PRONOUNS:
        words[0] = first
    if len(words) == 1 and words[0] == "them":
        words[0] = "they"
    return " ".join(words)


def device_completion_check(
    reply_text: str,
    spans: Sequence[Any],
    available_tools: Sequence[str],
    device_names: Sequence[str] | Mapping[str, str] = (),
    *,
    machines: Mapping[str, str | None] | None = None,
) -> DeviceCompletionClaim | None:
    """A claim that an action happened on a device, that nothing backs.

    The tools that could do it are the registered tools that PERFORM its kind
    of action (`DEVICE_ACTION_TOOLS`, pinned against the live registry). With
    no device tool advertised the guard is silent — she cannot have been
    expected to use one. `device_names` are the paired names (`_paired`).
    `machines` maps each live paired name to the machine its agent reported
    (`device_facts.machine`; None where that cannot be read), derived by the
    caller from the live rows — never a list; without it no grouping can be
    read (fix round 4, R5).

    SILENT for the whole turn when a delegation RAN an agent this turn
    (`_a_delegation_ran`, fix round 4, R1): the agent's calls are in its own
    turn's record, so this one cannot say what was done.

    What is a CLAIM (fix rounds 1 and 2, C1/C2/I3): an ACTION, done, this
    turn, by her:
      * a copula and an action's participle or progressive ("Teams has been
        launched", "Teams is now opening", "the file was saved") — a PRESENT
        passive only when marked as the change ("Notepad is now opened"; "Teams
        is launched from the Start menu" is how it is done), and a state
        ("open", "running") only with "now" ("Notepad is now open"); a plain
        state is the state guard's (212b9f8b's "your agents are running on…"
        stays silent);
      * her own completed action ("I opened…", "I've gone ahead and opened…");
      * a clause that opens on the action ("Launched brave on …",
        "Successfully launched…"), or a subject and an app's lifecycle verb
        ("Done — Notepad opened on …").
    It must name a device of hers (`_device_anchor`, within `_ANCHOR_REACH`
    and no clause break), except her own lifecycle claim about an app, or
    about "it" when a call that performs it was made this turn.

    Never a claim: a question; a recap or a past time ("today", "at 15:56",
    "as I mentioned", a list under "here is what I did today:" — never under a
    bare "here's what I did:"); a condition anywhere in the claim's segment, or
    opening its sentence ("…when a timer fires", "As soon as Teams has
    launched…") or its list ("If it works:\n- Notepad is now open…"); a future
    ("Notepad will have opened…"); another actor or cause ("…by Windows
    Backup", "…via OneDrive sync"), second or third person, a relative clause;
    the machine's own startup ("…at login: OneDrive, Teams"); a negation,
    hedge, subordinator or intent in the claim's own segment — LOCAL, so "No
    problem — Notepad is now open" still is one; relayed or quoted text; a
    blockquote; a model serving on a machine.

    What the record shows (`_silenced`, `_claim_record`, fix round 3, T3):
    SILENT when any call of the tools that perform the action SUCCEEDED on the
    device she named or an agent of its machine (R5; any device for "your PC"
    or none named), whatever it ran for — or when one ran where it cannot be
    told whether that is her machine (R5). Otherwise the claim carries what
    the record shows (`DeviceRecord`) — a failure, a timeout the device
    answered, a call never answered, or that none ran — and its `sentence` is
    the one thing the turn appends. The record is read once per check, and
    each command's argv split once however many claims read it (T5)."""
    if not reply_text or not reply_text.strip():
        return None
    advertised = [str(name) for name in available_tools]
    if not any(name.startswith(_DEVICE_SPAN_PREFIX) for name in advertised):
        return None
    if _a_delegation_ran(spans):
        return None
    names = _paired(device_names)
    anchor = _device_anchor(names)
    outside_ran = any(
        _is_her_span(span)
        and (getattr(span, "meta", None) or {}).get("ok") is True
        and not str(getattr(span, "name", "")).startswith(_DEVICE_SPAN_PREFIX)
        for span in spans
    )
    reading = _Reading(
        anchor=anchor,
        ran=_calls_that_ran(spans),
        advertised=advertised,
        outside_ran=outside_ran,
        names=names,
        machines=(
            None
            if machines is None
            else {str(name).strip().lower(): machine for name, machine in machines.items()}
        ),
    )
    # A sentence read once and found to hold no claim holds none the second time
    # it is written: every verdict below is a pure function of the sentence and
    # this turn's record (fix round 3, T5 — 1,100 backed claims took 105 ms).
    quiet: set[str] = set()
    list_is_framed = False
    for line in reply_text.split("\n"):
        stripped = line.strip()
        if not stripped:
            continue
        if _LIST_ITEM.match(line):
            if list_is_framed:
                continue  # an item of "here is what we did today:" or "If it works:"
        else:
            list_is_framed = _recap(stripped) or _FRONTED_CONDITION.match(stripped) is not None
        for sentence in _sentences(line):
            if sentence in quiet:
                continue
            if not sentence.strip() or sentence.rstrip().endswith("?") or _recap(sentence):
                continue
            if _FRONTED_CONDITION.match(sentence):
                continue  # "Once it's done, Teams has launched…": all of it conditioned
            for clause in _CLAUSE_SPLIT.split(sentence):
                if not clause or not clause.strip():
                    continue
                claim = _device_action_in(clause, reading)
                if claim is not None:
                    return claim
            quiet.add(sentence)
    return None


@dataclass
class _Reading:
    """What one device_completion_check reads every clause against, found
    once: the device anchor, the calls that ran, the advertised tools, whether
    a call of another family succeeded, the paired names, the machine each
    agent reported (lower-cased name -> machine, None when no grouping was
    read, R5) — and what it has already worked out (each command's words, each
    place's devices, each kind's verdicts), so a reply of many claims repeats
    none of it (fix rounds 3 and 4, T5 and R4)."""

    anchor: re.Pattern[str]
    ran: list[_Ran]
    advertised: list[str]
    outside_ran: bool
    names: tuple[str, ...]
    machines: dict[str, str | None] | None = None
    commands: dict[int, list[str] | None] = field(default_factory=dict)
    places: dict[tuple, tuple[frozenset[str] | None, str]] = field(default_factory=dict)
    silenced: dict[tuple, bool] = field(default_factory=dict)
    kinds_run: dict[str, bool] = field(default_factory=dict)

    def place(self, found: re.Match[str]) -> tuple[frozenset[str] | None, str]:
        groups = found.re.groupindex
        key = (found.group(0), *(found.group(g) if g in groups else None for g in _PLACE_GROUPS))
        if key not in self.places:
            self.places[key] = _resolve_place(found, self.names)
        return self.places[key]

    def recipient(self, written: str) -> tuple[frozenset[str] | None, str | None] | None:
        """The machine a send's recipient names (Task 32 Phase B round 3),
        read as the anchor reads the same words after "to": "sent minipc the
        hub's build" is "sent the hub's build to minipc", and "minipc's agent"
        is minipc's. "it" is a machine she does not name: (None, None). None
        when the recipient is no machine of hers — "you", a person, "them"."""
        words = " ".join(written.split())
        lowered = words.lower()
        if lowered == "it":
            return None, None
        for suffix in ("'s agent", "’s agent"):
            if lowered.endswith(suffix):
                words = words[: -len(suffix)]
                break
        found = self.anchor.fullmatch(f"to {words}")
        return None if found is None else self.place(found)

    def kind_ran(self, kind: str) -> bool:
        """Whether any call of the tools that perform `kind` ran, anywhere —
        without one, a claim naming no device can only be "none ran"."""
        if kind not in self.kinds_run:
            family = DEVICE_ACTION_TOOLS[kind]
            self.kinds_run[kind] = any(call.name in family for call in self.ran)
        return self.kinds_run[kind]


_PLACE_GROUPS = ("name", "word", "bare")


def _a_delegation_ran(spans: Sequence[Any]) -> bool:
    """Whether a delegate_to_agent call may have RUN an agent this turn (fix
    rounds 4 and 5, R1 and P1). The agent's calls are recorded on ITS turn,
    not this one, so this turn's record cannot say what was done — "(No
    device_launch_app … call ran …)" beside the launch an agent made for her
    is false.

    Only a call REFUSED before any run is known to have run nothing: one never
    dispatched (`refused_*`: markup, a closed round), or one whose facts carry
    the entry every refusal-before-run files (agents.delegation_refused:
    status "refused"). Any other delegate call may have run one, even one with
    no child-turn marker: the executor files that marker only after reading
    the child's turn back, so a delegation that raised after its child ran
    carries none (fix round 5, P1), and a scripted delegate step
    (`chat._run_script_step`) copies no facts at all. The child's spans are not
    read here."""
    for span in spans:
        if getattr(span, "kind", None) != "tool":
            continue
        if getattr(span, "name", None) != DELEGATE_TOOL_NAME:
            continue
        meta = getattr(span, "meta", None) or {}
        if any(str(key).startswith("refused") for key in meta):
            continue
        if meta.get("ok") is True:
            return True
        facts = meta.get("facts")
        refused = isinstance(facts, list) and any(
            isinstance(fact, dict) and fact.get("status") == "refused" for fact in facts
        )
        if not refused:
            return True
    return False


def _mark_positions(text: str, mark: str) -> list[int]:
    """Every index of the one-character `mark` in `text`, in order: one pass,
    so counting the marks before any position is a bisect, never a re-read."""
    found: list[int] = []
    at = text.find(mark)
    while at >= 0:
        found.append(at)
        at = text.find(mark, at + 1)
    return found


def _device_action_in(clause: str, reading: _Reading) -> DeviceCompletionClaim | None:
    """The first unbacked claim in one non-question clause, or None.

    A candidate that a successful call silences is dropped as soon as its
    action and device are known, before any cut is read (fix round 3, T5):
    silent is silent whatever the cuts say. The cuts, and the quotation marks
    (said-not-done final review, I-2), are found at most ONCE per clause, when
    a candidate first needs them, and compared by position (bisect), so a long
    clause costs one pass."""
    text = _MD_LINK.sub(r"\1", clause) if "](" in clause else clause
    if "*" in text:
        text = text.replace("*", "")
    if text.lstrip().startswith(">"):
        return None  # a blockquote is someone's words
    candidates = [(m.start(), "state", m) for m in _ACTION_CLAIM.finditer(text)]
    candidates += [(m.start(), "first", m) for m in _FIRST_PERSON_ACTION.finditer(text)]
    candidates += [(m.start(), "subject", m) for m in _SUBJECT_ACTION.finditer(text)]
    head = _HEAD_ACTION.match(text)
    if head is not None:
        candidates.append((head.start("verb"), "head", head))
    if not candidates or _STARTUP.search(text):
        return None  # nothing claimed, or the machine's own startup items
    candidates.sort(key=lambda candidate: candidate[0])
    places = list(reading.anchor.finditer(text))
    place_starts = [place.start() for place in places]
    cuts: dict[str, list[int]] = {}
    # The clause breaks, found on first need like the cuts: a clause whose
    # candidates are all dropped before a break is asked about never reads
    # them (fix round 4, R4).
    bounds: list[list[int]] = []

    def breaks() -> tuple[list[int], list[int]]:
        """(where each clause break starts, where each ends), found once."""
        if not bounds:
            found = [(m.start(), m.end()) for m in _ANCHOR_BREAK.finditer(text)]
            bounds.extend(([start for start, _ in found], [end for _, end in found]))
        return bounds[0], bounds[1]

    def found_at(key: str) -> list[int]:
        """Where each cut starts in this clause, found once, on first need."""
        if key not in cuts:
            patterns = {
                "blockers": (
                    _ACTION_NEGATION,
                    _ACTION_HEDGE,
                    _ACTION_INTENT,
                    _REPORTED,
                    _RELAYED_THAT,
                ),
                "negations": (_ACTION_NEGATION,),
                "others": (_OTHER_CAUSE,),
                "conditions": (_ACTION_CONDITION,),
            }[key]
            cuts[key] = sorted(
                found.start() for pattern in patterns for found in pattern.finditer(text)
            )
        return cuts[key]

    def any_in(positions: list[int], lo: int, hi: int) -> bool:
        index = bisect_right(positions, lo - 1)
        return index < len(positions) and positions[index] < hi

    def place_after(end: int) -> re.Match[str] | None:
        """The device the claim ending at `end` is ON: the next anchor, if it
        starts within `_ANCHOR_REACH` with no clause break before it."""
        index = bisect_right(place_starts, end - 1)
        if index == len(places) or place_starts[index] - end > _ANCHOR_REACH:
            return None
        if any_in(breaks()[0], end, place_starts[index]):
            return None
        return places[index]

    def segment_end(at: int) -> int:
        break_starts = breaks()[0]
        index = bisect_right(break_starts, at - 1)
        return break_starts[index] if index < len(break_starts) else len(text)

    # Where each quotation mark sits in this clause, found on first need.
    marks: dict[str, list[int]] = {}

    def quoted(at: int) -> bool:
        """Is `at` inside a quotation: an odd number of straight double quotes
        or backticks before it, or more opening curly quotes than closing
        ones? Each mark's positions are found ONCE per clause and counted by
        bisect — four `text.count(…, 0, at)` per candidate read the clause from
        its start for every candidate, so a long clause of claims dropped after
        this test was quadratic (said-not-done final review, I-2)."""

        def before(mark: str) -> int:
            if mark not in marks:
                marks[mark] = _mark_positions(text, mark)
            return bisect_left(marks[mark], at)

        return bool(before('"') % 2 or before("`") % 2 or before("“") > before("”"))

    for position, shape, m in candidates:
        verb_end = m.end()
        place = place_after(verb_end)
        thing = it = None
        word = m.group("word") if shape == "state" else m.group("verb")
        word = " ".join(word.lower().split())
        # A send of the hub's build is an install (Task 32 Phase B round 3):
        # its object is read first — the subject of "…was sent", else what
        # follows her own send — and a recipient written before it must be a
        # machine of hers or "it" ("sent you the update" is no install).
        build: re.Match[str] | None = None
        recipient: tuple[frozenset[str] | None, str | None] | None = None
        if word in _SEND_WORDS:
            if shape == "state":
                if place is not None:  # a state names its machine, or is no claim
                    build = _subject_build(text, _subject_start(text, position), position)
            elif shape in ("first", "head"):
                sent = _sent_object(text, verb_end)
                if sent is not None:
                    build, written = sent
                    if written is not None:
                        recipient = reading.recipient(text[written[0] : written[1]])
                        if recipient is None:
                            build = None
        if build is not None:
            action = kind = "install"
        else:
            action = _ACTION_OF_WORD.get(word, "run")
            kind = _kind_of(action)
        devices: frozenset[str] | None = None
        device_label: str | None = None
        if place is not None:
            devices, device_label = reading.place(place)
        elif build is not None and recipient is not None and recipient[1] is not None:
            devices, device_label = recipient  # "sent minipc the hub's build"
        elif build is not None:
            # Her own send of the build naming no machine ("I sent the update",
            # "I sent it the update"): about any of them, and — as every claim
            # naming no device — never read beside another tool's work.
            if shape != "first" or (reading.outside_ran and not reading.kind_ran(kind)):
                continue
        # An unanchored claim is otherwise only her own lifecycle claim about an
        # app or "it".
        elif shape != "first" or word not in _LIFECYCLE_VERBS:
            continue
        elif not reading.kind_ran(kind):
            # What the record would say is that none ran. For a claim naming
            # no device it is never said beside another tool's work (it may be
            # about a page or a file that tool opened), nor about "it" (with no
            # launch made, "it" names nothing) — so both are dropped HERE, before
            # a cut is read (fix round 4, R4: 50 KB of "I launched App{i}."
            # beside one web search read every cut of every sentence first).
            if reading.outside_ran:
                continue
            thing = _APP_OBJECT.match(text, verb_end)
            if thing is None:
                continue
        else:
            thing = _APP_OBJECT.match(text, verb_end)
            it = None if thing is not None else _PRONOUN_OBJECT.match(text, verb_end)
            if thing is None and it is None:
                continue
        if _silenced(reading, kind, devices):
            continue  # a call that performs it ran there, or may have (T3, R5)
        # The claim's own segment: back to the last clause break before it (I3).
        break_ends = breaks()[1]
        index = bisect_right(break_ends, position)
        segment_start = break_ends[index - 1] if index else 0
        if shape in ("state", "subject"):
            begin = max(_subject_start(text, position), segment_start)
            while begin < position and text[begin] in " \t":
                begin += 1
            if begin >= position:
                continue  # no subject at all
        else:
            begin = position
        claim_at = m.start("word") if shape == "state" else m.start()
        if any_in(found_at("blockers"), segment_start, max(claim_at, begin)):
            continue  # a negation, hedge, intent or report in its own segment
        if any_in(found_at("conditions"), segment_start, segment_end(verb_end)):
            continue  # "…when a timer fires", "…after the update": conditioned (C2)
        if quoted(begin):
            continue  # inside a quotation: someone else's words
        if place is not None and any_in(found_at("negations"), verb_end, place.start()):
            continue  # "I launched nothing on your Dell"
        subject = text[begin:position].strip() if shape in ("state", "subject") else ""
        last = _CONTRACTION.sub("", subject.rsplit(maxsplit=1)[-1].lower()) if subject else ""
        if shape in ("state", "subject"):
            if last in _NOT_HER_SUBJECT or _SERVING_SUBJECT.search(subject):
                continue  # not hers, a relative clause, or a model serving
            if shape == "subject" and last in _NOT_A_SUBJECT:
                continue  # "has opened", "I opened": the other shapes read those
            if shape == "subject" and place is not None and _THEN_A_VERB.match(text, place.end()):
                continue  # "Apps started on your PC stay running": a noun phrase
        if shape != "first" and any_in(found_at("others"), verb_end, segment_end(verb_end)):
            continue  # "…saved on your Dell by Windows Backup": another actor or cause
        if shape == "state":
            marked = (
                re.search(r"\bnow\b", m.group("adverbs"), re.I)
                or _NOW_AFTER.match(text, verb_end)
                or (place is not None and _NOW_AFTER.match(text, place.end()))
            )
            if re.fullmatch(_NOW_STATE, word, re.I) and not marked:
                continue  # a plain state, not a change she made (C1)
            copula = " ".join(m.group("copula").strip().lower().split())
            if word in ("installed", "uninstalled") and copula in _PRESENT_BE:
                continue  # "Teams is installed": what the machine holds
            if (
                copula in _PRESENT_BE
                and re.fullmatch(_ACTION_PARTICIPLE, word, re.I)
                and not _CHANGE_MARK.search(m.group("adverbs"))
                and not marked
            ):
                continue  # "Teams is launched from the Start menu": how it is done (C2)
        if thing is not None:
            target = thing.group("object")
            if _FILENAME.fullmatch(target) or _URL.match(target):
                continue  # a file or a page: another tool's object
            end = thing.end()
        elif it is not None:
            target, end = it.group("object"), it.end()
        elif place is None:
            target, end = build.group(0), build.end()  # a send to its recipient, or to none
        else:
            end = place.end()
            target = subject if shape in ("state", "subject") else text[verb_end : place.start()]
        target = _clean_target(target)
        record = _claim_record(reading, kind, action, devices, target)
        if shape in ("state", "subject"):
            phrase_start = begin
        else:
            phrase_start = m.start("verb") if shape == "head" else position
        tools_for_kind = tuple(t for t in DEVICE_ACTION_TOOLS[kind] if t in reading.advertised)
        return DeviceCompletionClaim(
            phrase=text[phrase_start:end].strip()[:80],
            device=device_label,
            kind=kind,
            tools=tools_for_kind or DEVICE_ACTION_TOOLS[kind],
            action=action,
            target=target,
            record=record,
        )
    return None


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
_SIZE = r"\d[\d,]*+(?:\.\d++)?\s?(?:[Bb]ytes?|[KMGTP]i?B|[KMGTP]|B)"
# A size trailing the name and SET OFF from it: a spaced dash, two spaces, a
# tab, or parentheses. A single space or a colon is not a separator.
#
# LINEAR, and it has to be (S40b fix-wave follow-up, D2): written as
# `(?:\s+[—–-]\s+|\s{2,}|\t+)\s*` this read a padded entry in O(n³) — a run of
# n spaces can be entered at n positions, each splitting the rest n ways
# between `\s{2,}` and `\s*`, each split walked again — 7 ms at 200 characters
# of padding (UNDER the sweep's budget, which is why it survived A1's audit),
# 3.0 s at 1,500, and 8.8 s through `presented_listing_check` itself, on
# core's only process, on every reply. The rewrite matches exactly the same
# text: a separator may only START a whitespace run (`(?<!\s)` — entering the
# same run later can never match what entering it at the front cannot), and
# every run is taken whole and possessively, which is what the old one had to
# do anyway since `_SIZE` opens with a digit.
_TRAILING_SIZE = re.compile(
    r"(?<!\s)(?:\s++[—–-]\s++|\s\s++|\t\s*+)" + _SIZE + r"\s*+$"
    r"|(?<!\s)\s*+\(" + _SIZE + r"\)\s*+$"
)
# Under a TREE lead a single space will do ("├── backups/ 905.6 GiB"): the
# tree markup is the listing's own idiom, and there is no cache/DIMM/container
# line that draws itself as a tree.
_TRAILING_SIZE_TREE = re.compile(r"(?<!\s)\s++" + _SIZE + r"\s*+$")
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
_DELEGATION_VERBS = (_ACTION_VERB_TOKENS - _EDIT_VERB_TOKENS) | frozenset(
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


# -- the proactive-beat guards (S11) ----------------------------------------
#
# The ninth, tenth and eleventh siblings, for the three lies that only a
# message NOBODY ASKED FOR can tell. Every guard above reads a reply to a
# person's question: he was there, he knows what he asked, and a fabrication
# has to get past him in the same minute. A beat speaks into an empty room —
# she looks at the stack at 03:00, nobody reads the trace, and the sentence at
# breakfast is the entire account anyone gets. v3's proactive engine failed on
# exactly that: one beat pushed the HARNESS's own "this turn produced no reply"
# text to a phone as news and recorded the push a success, and another reported
# a clean night from a probe that had never been made.
#
#   observation_check(reply, findings, runs)     — she may assert a fault only
#       about something a check ACTUALLY produced this pass, and may call the
#       pass clear only when it WAS clear.
#   delivery_claim_check(reply, delivered_titles) — "I already told you about
#       X" is contradicted unless a notice about X really went out.
#   novelty_claim_check(reply, repeats_by_title)  — "this is new" is
#       contradicted, with the real count, when the same facts have already
#       come back.
#   model_wrote_nothing(spans)                    — not a guard: the structural
#       fact that the reply text was written by the backend, not the model.
#
# All four keep the family's two rules. PURE: text plus the facts the caller
# read, never a model, a socket or a clock, so a guard can never itself become
# a source of narration. PRECISION-first (ruling S2d-R2): a wrongly-corrected
# honest reply makes the guard the liar, and a beat's reply is the ONLY thing
# he reads about that hour, so a false correction there is worse than anywhere
# else in the system.
#
# The DERIVATION, which is the whole design of the first one: the subjects a
# beat may speak about are computed from the FINDINGS THEMSELVES — the words in
# each finding's `key` and in its `facts` — never from a phrase list someone
# maintains here. A check family added tomorrow arms this guard for its own
# vocabulary the day it returns its first finding, and a check that RAN and
# found nothing grants no vocabulary at all, which is exactly the point: "the
# gateway is down" is a lie precisely when no finding says so. A finding's
# `title` is deliberately NOT harvested. It is the SENTENCE about the facts,
# and deriving a control from sentences is the v3 fingerprint bug in a new
# costume (app/checks/__init__.py: the fingerprint hashes facts, never titles).

# The stated corrections. Each says only what is mechanically true, carries no
# fault predicate, no all-clear phrase, no delivery claim and no novelty claim
# of its own, so running any of these guards over its own correction comes back
# clean (pinned in test_guards.py — every guard in this file is clean over its
# own text).
OBSERVATION_UNBACKED_CORRECTION = (
    "Correction: no check produced that this pass — I am reporting something the checks "
    "did not find."
)
ALL_CLEAR_NOT_RUN_CORRECTION = (
    "Correction: I cannot call this pass clear — {unrun} of {total} checks could not be made, "
    "so nothing was verified about what they watch."
)
ALL_CLEAR_FOUND_CORRECTION = (
    "Correction: I cannot call this pass clear — {found} finding(s) came back this pass."
)
ALL_CLEAR_NOTHING_CHECKED_CORRECTION = (
    "Correction: I cannot call this pass clear — no check was made this pass, so nothing "
    "was looked at."
)
DELIVERY_CLAIM_CORRECTION = (
    "Correction: I have no record of telling you that — no notice about it was delivered."
)
NOVELTY_CLAIM_CORRECTION = (
    "Correction: that is not new — these same facts have come back {repeats} times now."
)

# Words are compared as bare alphanumeric runs — the underscore is a SEPARATOR
# here, not a word character, because a check's key and its fact names are
# snake_case ("database_down", "spend_over_cap", "timer_id") and the subject
# lives inside them. So "gateway's", "peer_down:gateway", "chat.model" and
# "hf.co/org/repo:tag" all yield the words inside them. Anything shorter than
# three characters says nothing about a subject.
_OBS_WORD = re.compile(r"[A-Za-z0-9]+")
_OBS_MIN_WORD = 3
# Vague heads that name no subject a finding could be about. A clause whose
# subject is only one of these ("it is down", "everything is broken") cannot be
# resolved to a thing, so it is left alone — precision-first, and an accepted
# miss stated out loud.
_OBS_VAGUE = frozenset(
    {
        "it",
        "its",
        "they",
        "them",
        "their",
        "theirs",
        "this",
        "that",
        "these",
        "those",
        "there",
        "here",
        "everything",
        "anything",
        "something",
        "nothing",
        "everyone",
        "someone",
        "anybody",
        "everybody",
        "one",
        "ones",
        "thing",
        "things",
        "stuff",
        "which",
        "who",
        "what",
        "we",
        "us",
        "our",
        "you",
        "your",
        "yours",
        "his",
        "her",
        "hers",
        "him",
        "she",
        "and",
        "but",
        "the",
        "all",
        "both",
        "some",
        "any",
        "each",
        "every",
        "much",
        "many",
        "most",
        "few",
        "other",
        "others",
        "else",
        "same",
        "such",
        "own",
    }
)
# Words for the ACT of reporting rather than the thing reported. "I noticed the
# backups have not run" is about backups, not about noticing, so these are
# dropped from every subject, object and title before anything is compared —
# symmetrically, on both sides, since no check names a fault after them either.
_OBS_REPORTING = frozenset(
    {
        "notice",
        "notices",
        "noticed",
        "noticing",
        "find",
        "finds",
        "found",
        "finding",
        "findings",
        "see",
        "sees",
        "saw",
        "seen",
        "seeing",
        "spot",
        "spots",
        "spotted",
        "observe",
        "observed",
        "look",
        "looks",
        "looked",
        "looking",
        "seem",
        "seems",
        "seemed",
        "appear",
        "appears",
        "appeared",
        "show",
        "shows",
        "showed",
        "shown",
        "say",
        "says",
        "said",
        "saying",
        "tell",
        "tells",
        "told",
        "telling",
        "know",
        "knows",
        "knew",
        "think",
        "thinks",
        "thought",
        "believe",
        "believes",
        "report",
        "reports",
        "reported",
        "reporting",
        "mention",
        "mentions",
        "mentioned",
    }
)
# How far back from a fault predicate the subject can sit, and how deep into a
# `facts` structure the harvest walks. Both are bounds on work, not judgements.
_OBS_SUBJECT_TOKENS = 6
_FACT_MAX_DEPTH = 6
_FACT_MAX_WORDS = 2000


def _singular(word: str) -> str:
    """A crude de-pluralisation, applied to BOTH sides of every comparison so
    "backups" in a reply meets "backup" in a fact. Leniency, deliberately: the
    cost of matching too readily is a missed correction, the cost of matching
    too strictly is a correction on an honest sentence."""
    if len(word) > 3 and word.endswith("s") and not word.endswith(("ss", "us", "is")):
        return word[:-1]
    return word


def _content_words(text: str) -> list[str]:
    """The words in `text` that could name a SUBJECT — everything that is not a
    determiner, a stop word, a preposition, a vague head or a word for the act
    of reporting. Shared by every comparison in this section so both sides are
    read the same way."""
    out: list[str] = []
    for raw in _OBS_WORD.findall(text):
        low = raw.lower()
        if len(low) < _OBS_MIN_WORD:
            continue
        if low in _OBS_VAGUE or low in _STOP_WORDS or low in _DETERMINER_ADJ:
            continue
        if low in _PREP_ADVERB or low in _ABOUTNESS or low in _LIST_CONT:
            continue
        if low in _OBS_REPORTING:
            continue
        out.append(low)
    return out


def _harvest(value: Any, words: set[str], depth: int = 0) -> None:
    """Every subject word inside one finding's key or facts, walked as DATA.

    A dict contributes its keys as well as its values ("timer_id" is how a
    check names what it is about), a list its items, a scalar its own text. A
    bool or None contributes nothing — "true"/"false"/"none" name no subject.
    Depth and total are bounded so a pathological `facts` cannot spin here.
    """
    if depth > _FACT_MAX_DEPTH or len(words) >= _FACT_MAX_WORDS:
        return
    if isinstance(value, Mapping):
        for key, item in value.items():
            _harvest(key, words, depth + 1)
            _harvest(item, words, depth + 1)
        return
    if isinstance(value, list | tuple | set | frozenset):
        for item in value:
            _harvest(item, words, depth + 1)
        return
    if value is None or isinstance(value, bool):
        return
    for word in _content_words(str(value)):
        words.add(_singular(word))


def _subject_vocabulary(findings: Sequence[Any]) -> frozenset[str]:
    """Every subject a beat may assert a fault about this pass, DERIVED from
    the findings' own `key` and `facts` (never their titles — see the section
    header). An empty pass yields an empty vocabulary, which is why an
    all-quiet beat that then names a fault is caught by construction."""
    words: set[str] = set()
    for finding in findings:
        _harvest(getattr(finding, "key", None), words)
        _harvest(getattr(finding, "facts", None), words)
    return frozenset(words)


# A bad STATE, asserted of a subject by a present-tense copula. Every entry is
# unambiguously a fault: the polysemous words that made state_claim_check the
# liar in review ("up", "available") are absent here for the same reason.
_FAULT_STATE = (
    r"(?:down|offline|unreachable|not\s+reachable|unresponsive|not\s+responding"
    r"|not\s+running|not\s+installed|not\s+set|missing|gone|broken|failing|failed"
    r"|erroring|stuck|stale|paused|walled|throttled|rate-?limited"
    r"|out\s+of\s+(?:disk|space|memory|room)"
    r"|over\s+(?:(?:its|their|the|his|her|your|my)\s+)?(?:\w+\s+)?"
    r"(?:cap|budget|limit|ceiling)s?)"
)
# Adverbs that may sit between the copula and the state. Two families are
# deliberately ABSENT, and both absences differ from state_claim_check on
# purpose:
#
#   * negation ("not", "no longer"). An absence of findings is an absence of
#     faults, so "the gateway is not down" is CONSISTENT with a quiet pass and
#     must stay clean. In state_claim_check a negated device state is just as
#     unchecked as a positive one — there the fact was never looked up at all;
#     here the look-up happened and came back empty.
#   * hedging ("probably", "likely", "apparently"). A guess is not a report:
#     "the gateway is probably down" claims nothing the checks contradict, and
#     correcting it would put the guard's flat contradiction under a sentence
#     that was already hedged.
_OBS_ADVERB = (
    r"(?:still|currently|now|again|already|actually|indeed|definitely"
    r"|completely|totally|entirely|fully|effectively|basically|essentially)"
)
# <subject> is/appears/has gone ... <fault state>. The leading \s+ or possessive
# keeps the match starting AFTER the subject, so the text before it is the
# subject phrase.
_FAULT_COPULA = re.compile(
    rf"(?:(?<!\s)\s++(?:{_PRESENT_COPULA})|['’]s)(?:\s++{_OBS_ADVERB})*+"
    rf"\s++(?P<state>{_FAULT_STATE})\b",
    re.I,
)
# The fault stated as a VERB rather than a state. Only shapes that can only be
# a fault: a negated completion ("has not run", "did not answer"), a failure
# ("has failed", "failed 4 times", "keeps failing"), or a stop ("stopped
# responding", "went offline"). A bare "run"/"answered" is a success and is not
# here; "could not be made" is deliberately not a shape, so this file's own
# corrections stay clean over it.
#
# "finish"/"complete" are deliberately ABSENT, and the cross-pin in
# test_guards.py is why: DELEGATION_FAILED_CORRECTION says "{agent} did not
# finish that task", and two of this file's guards appending contradictions to
# each other is the worst thing a correction can do to a message nobody
# watched. It costs nothing real — whether a DELEGATED task finished is
# delegation_claim_check's subject, read off the delegate spans; this guard
# watches the stack, the work and the money.
_FAULT_VERB = re.compile(
    r"\b(?:(?:has|have|had)\s+not\s+(?:run|ran|started|responded|answered|reported|fired)"
    r"|(?:has|have|had)n['’]?t\s+(?:run|ran|started|responded|answered|reported|fired)"
    r"|did\s+not\s+(?:run|start|respond|answer|report|fire)"
    r"|didn['’]?t\s+(?:run|start|respond|answer|report|fire)"
    r"|could\s+not\s+(?:run|start|respond|answer|connect)"
    r"|couldn['’]?t\s+(?:run|start|respond|answer|connect)"
    r"|(?:has|have|had)\s+failed"
    r"|failed\s+(?:\d+\s+times|to\s+\w+|again|repeatedly)"
    r"|keeps?\s+failing"
    r"|stopped\s+(?:running|responding|working|firing|reporting)"
    r"|went\s+(?:down|offline)"
    r"|ran\s+out\s+of\s+(?:disk|space|memory|room))",
    re.I,
)
# An ALL-CLEAR: the beat telling him there is nothing to tell. Each shape is
# unambiguous — a partial "everything ELSE looks fine" never matches, because
# the word between the subject and the copula breaks the pattern, and a partial
# statement about the things that DID come back is honest.
_ALL_CLEAR = re.compile(
    r"\ball\s+(?:clear|good|fine|green|quiet|well)\b"
    r"|\ball\s+(?:the\s+)?checks?\s+(?:passed|came\s+back\s+clean|are\s+green|look\s+fine)\b"
    r"|\b(?:everything|every\s+check|the\s+(?:whole\s+)?stack|all\s+(?:systems?|services?))"
    r"\s*(?:['’]s|is|are|was|were|looks?|seems?|appears?|remains?|checks?\s+out)"
    r"(?:\s+(?:still|currently|now|already|completely|totally))?"
    r"\s*(?:to\s+be\s+)?(?:fine|good|ok|okay|normal|healthy|clear|green|well"
    r"|in\s+order|as\s+expected|running\s+(?:fine|normally)|working\s+(?:fine|normally))\b"
    r"|\bnothing\s+(?:to\s+(?:report|flag|tell\s+you|worry\s+about)"
    r"|(?:is\s+|looks\s+)?(?:wrong|amiss|broken|off)"
    r"|(?:new\s+)?(?:came|turned)\s+up)\b"
    r"|\bno\s+(?:issues?|problems?|faults?|failures?|findings?|errors?)\b",
    re.I,
)


def _obs_segment(before: str) -> str:
    """The text a subject or a hedge can live in: the clause back to its last
    boundary. "I checked the timers and the gateway is down" hands back " the
    gateway " — the coordinated subject, not the whole sentence."""
    return _COORD_BREAK.split(before)[-1]


def _obs_blocked(segment: str, clause: str) -> bool:
    """True when the clause supposes, doubts, proposes or relays the state
    rather than asserting it — the family's shared machinery, read exactly as
    state_claim_check and delegation_claim_check read it."""
    if _DELEGATION_HEDGE.search(segment) is not None or _STATE_HEDGE.search(segment) is not None:
        return True
    if _STATE_INTENT.search(segment) is not None:
        return True
    return _PRIOR_TIME.search(clause) is not None or _REPORTED.search(clause) is not None


def _fault_subject(before: str) -> tuple[str, list[str]]:
    """(the subject phrase, its content words) for a fault asserted after
    `before`. The window is the last few tokens of the segment, so a long
    preamble cannot smuggle an unrelated noun in as the subject."""
    segment = _obs_segment(before)
    words = _content_words(segment)[-_OBS_SUBJECT_TOKENS:]
    return segment.strip()[-80:], words


def _names_a_finding(words: Sequence[str], vocabulary: frozenset[str]) -> bool:
    """True when ANY word of the subject is a word a finding used. One word is
    enough on purpose: a check names a paused timer by its id and kind while
    the reply names it by its title, and the overlap is the noun they share."""
    return any(_singular(word) in vocabulary for word in words)


def _pass_was_clear(runs: Sequence[Any]) -> bool:
    """Was this pass QUIET — every check ran, none of them found anything?

    Read from `checks.quiet`, which is the ONE implementation of that property
    (a beat's own verdict, the digest's and this guard's must never be able to
    disagree about what "clear" means). The import is deferred to the call
    because it would otherwise be a cycle: app.checks pulls in its families,
    which import timers -> scheduler -> beats -> chat, and chat imports THIS
    module. By the time a guard runs, every one of them is loaded.
    """
    from app import checks

    return checks.quiet(runs)[0]


def _all_clear_correction(runs: Sequence[Any]) -> str:
    """Why this pass was not clear, in the counts the runs themselves carry.
    Derived, never a stored sentence — and never the model's."""
    if not runs:
        return ALL_CLEAR_NOTHING_CHECKED_CORRECTION
    unrun = sum(1 for run in runs if not getattr(run, "ran", False))
    if unrun:
        return ALL_CLEAR_NOT_RUN_CORRECTION.format(unrun=unrun, total=len(runs))
    found = sum(len(getattr(run, "findings", ()) or ()) for run in runs)
    return ALL_CLEAR_FOUND_CORRECTION.format(found=found)


def observation_check(
    reply_text: str, findings: Sequence[Any], runs: Sequence[Any]
) -> Correction | None:
    """Contradict a beat that reports something the checks did not produce.

    Two shapes, both mechanical:

      * an ALL-CLEAR ("everything looks fine", "nothing to report", "all
        good") when the pass was not clear. Quiet is COMPUTED — by
        `checks.quiet`, the one implementation of it, so a check that could
        not run, a check that found something, and a pass with no checks in it
        all make the claim false by the same line of code. This is the lie the
        whole slice exists to prevent: v3 reported a clean night from a probe
        it never made.
      * a specific FAULT ("the gateway is down", "the backups have not run")
        whose subject no finding names. The allowed subjects are DERIVED from
        this pass's findings — the words in their keys and facts — so a family
        added tomorrow arms the guard for its own vocabulary, and a check that
        ran and found nothing grants none at all.

    Returns a Correction (the all-clear first: it is the larger lie, and it
    contradicts every fault claim beside it anyway), or None — an honest
    report, a question, a hedge or conditional, a future or past frame, a
    negated state ("the gateway is NOT down", which an empty pass supports), a
    reported frame, or a subject too vague to resolve. Pure and
    precision-first.
    """
    if not reply_text or not reply_text.strip():
        return None
    clear = _pass_was_clear(runs)
    vocabulary = _subject_vocabulary(findings)
    unbacked: list[UnbackedClaim] = []
    seen: set[str] = set()
    for clause, is_question in _clauses(reply_text):
        if is_question:
            continue  # "is the gateway down?" asserts nothing
        if not clear:
            for match in _ALL_CLEAR.finditer(clause):
                before = clause[: match.start()]
                if _has_negator(before) or _obs_blocked(_obs_segment(before), clause):
                    continue  # "I can't say everything looks fine" is honest
                return Correction(
                    claims=(
                        UnbackedClaim(
                            kind="unbacked_all_clear",
                            target=None,
                            phrase=match.group(0).strip()[:80],
                        ),
                    ),
                    text=_all_clear_correction(runs),
                )
        for pattern in (_FAULT_COPULA, _FAULT_VERB):
            for match in pattern.finditer(clause):
                before = clause[: match.start()]
                subject, words = _fault_subject(before)
                if not words:
                    continue  # "it is down" names nothing this can resolve
                if _obs_blocked(_obs_segment(before), clause):
                    continue
                if _names_a_finding(words, vocabulary):
                    continue  # a check really did produce this subject
                key = " ".join(words)
                if key in seen:
                    continue
                seen.add(key)
                unbacked.append(
                    UnbackedClaim(
                        kind="unbacked_observation",
                        target=key,
                        phrase=(subject + " " + match.group(0).strip())[:80],
                    )
                )
    if not unbacked:
        return None
    return Correction(claims=tuple(unbacked), text=OBSERVATION_UNBACKED_CORRECTION)


# -- the delivery-claim guard ------------------------------------------------
#
# The second thing only a proactive message can lie about: whether it ever
# reached anybody. "Accepted by transport" is never "received", and a delivery
# that reached nobody is a FAILED delivery — so a beat that says "I already
# told you about that" when the push failed, the digest never composed, or the
# notice is still sitting in `raised`, has closed a loop that never closed. The
# operator then waits for news he has already been told he got.
#
# delivery_claim_check(reply_text, delivered_titles) takes the FACTS from the
# caller: it is the first of this family whose evidence is a query rather than
# this turn's spans, and the caller owns that query (notices in state delivered
# or seen). Here it is only a set of titles, so the guard stays pure.
#
# The precision cuts, in the order they matter:
#
#   * A claim must name something SPECIFIC. "I already told you" with no
#     object cannot be checked against anything and is left alone — the
#     accepted miss, stated out loud, because the alternative is correcting a
#     sentence whose referent we cannot see.
#   * A claim must be in the DELIVERY register. "I notified you", "I sent you
#     a notification", "I flagged it" are claims about a channel; a bare "I
#     told you about X" is ordinary conversation about something said in chat,
#     so the told/mentioned family additionally requires a prior marker
#     ("already", "previously", or the perfect "I've told you"). The
#     conversational form is an accepted miss.
#   * Backing is one shared word. A title and a claim rarely use the same
#     phrase, so an object word appearing in ANY delivered title backs the
#     claim; only a claim that shares nothing with anything delivered is
#     contradicted.
#   * The usual family exemptions: a question, a negation ("I have not told
#     you"), a future ("I'll let you know"), a hedge ("I think I told you"),
#     a reported frame. NOT _PRIOR_TIME: "I told you about that yesterday" is
#     the claim itself, not an action placed outside this turn.

# The NOTIFY register — a channel is named, so no prior marker is needed.
_DELIVERY_NOTIFIED = re.compile(
    r"\bi(?:['’]ve|\s+have)?\s+(?:already\s+|previously\s+)?"
    r"(?:notified|alerted|warned|pinged)\s+you\b"
    r"|\bi(?:['’]ve|\s+have)?\s+(?:already\s+)?(?:sent|pushed)\s+(?:you\s+)?"
    r"(?:a|an|the)\s+(?:notification|alert|push|notice|heads-?up|message|reminder)\b"
    r"|\byou(?:['’]ve|\s+have|\s+were)\s+(?:already\s+)?(?:been\s+)?"
    r"(?:notified|alerted|told|informed)\b"
    r"|\bi\s+let\s+you\s+know\b",
    re.I,
)
# The TOLD register — ordinary words, so a prior marker is required: an
# explicit already/previously, or the perfect aspect that carries the same
# meaning ("I've told you", "I have mentioned").
_DELIVERY_TOLD = re.compile(
    r"\bi(?:['’]ve|\s+have)\s+(?:already\s+|previously\s+)?"
    r"(?:told\s+you|mentioned|flagged|reported|raised|noted)\b"
    r"|\bi\s+(?:already|previously)\s+(?:told\s+you|mentioned|flagged|reported|raised|noted)\b",
    re.I,
)
# How much of the clause after the trigger is read as what the claim NAMED.
_DELIVERY_OBJECT_CHARS = 120


def _delivered_words(delivered_titles: Sequence[str]) -> frozenset[str]:
    """Every content word in everything that actually went out, de-pluralised.
    The union, not per title: a claim is backed when it shares a word with
    ANYTHING delivered (see the section header)."""
    words: set[str] = set()
    for title in delivered_titles:
        for word in _content_words(str(title)):
            words.add(_singular(word))
    return frozenset(words)


def delivery_claim_check(reply_text: str, delivered_titles: Sequence[str]) -> Correction | None:
    """Contradict "I already told you about X" when no notice about X went out.

    Returns a Correction naming what the reply claimed to have delivered, or
    None — a claim backed by something in `delivered_titles`, a claim naming
    nothing specific, a future/negated/hedged/questioned/reported form, or a
    plain reply. Pure and precision-first: it reads the text and the titles the
    caller queried, nothing else.
    """
    if not reply_text or not reply_text.strip():
        return None
    delivered = _delivered_words(delivered_titles)
    for clause, is_question in _clauses(reply_text):
        if is_question:
            continue  # "did I already tell you about that?" claims nothing
        if _REPORTED.search(clause) is not None:
            continue  # someone else's account of what was said
        for pattern in (_DELIVERY_NOTIFIED, _DELIVERY_TOLD):
            match = pattern.search(clause)
            if match is None:
                continue
            before = clause[: match.start()]
            if _has_negator(before) or _DELEGATION_HEDGE.search(_obs_segment(before)) is not None:
                continue
            named = _content_words(clause[match.end() : match.end() + _DELIVERY_OBJECT_CHARS])
            if not named:
                continue  # "I already told you" — nothing to check it against
            if any(_singular(word) in delivered for word in named):
                continue  # a notice about it really went out
            return Correction(
                claims=(
                    UnbackedClaim(
                        kind="unbacked_delivery",
                        target=" ".join(named[:6]),
                        phrase=clause[match.start() :].strip()[:80],
                    ),
                ),
                text=DELIVERY_CLAIM_CORRECTION,
            )
    return None


# ---- S47: invented pairing codes and wrong addresses — the REWRITE class -----
#
# Every other guard REPLACES a reply (a whole-stance fabrication) or APPENDS a
# correction beside it. These two catch a false TOKEN inside prose that may
# otherwise be true. Neither drops the reply: the false token is swapped for
# the truth in `rewritten`, and `text` is the correction that follows it.
# chat.py runs them FIRST, so every later guard — and whatever composition
# persists — sees the rewritten reply and never the invented token.


@dataclass(frozen=True)
class RewriteClaim:
    kind: str
    tokens: tuple[str, ...]
    rewritten: str
    text: str
    rules: tuple[str, ...] = ()
    truth: str | None = None


_CODE_CHAR = "[2-9A-HJKMNP-Z]"
# Eight characters of the pairing alphabet (devices.PAIRING_CODE_ALPHABET), 4+4
# with an optional dash, standing alone. Case-insensitive: a code read aloud
# comes back lowercase as often as not.
_CODE_TOKEN = re.compile(
    rf"(?<![A-Za-z0-9-])({_CODE_CHAR}{{4}})-?({_CODE_CHAR}{{4}})(?![A-Za-z0-9-])", re.I
)
_CODE_WORD = re.compile(
    r"\bpairing\b|\bpair\b|\benrol(?:l|ls|led|ling|ment)?\b|--code"
    r"|\bnovad\b|\bone-time\s+code\b|\bsetup\s+code\b",
    re.I,
)
# I4 (review fix round 1) + C (round 2, anchored round 3): a code-shaped
# token riding in an /add URL is pairing context by construction, even when
# no code-word sits in the same clause — that is where the QR flow puts the
# code (spec §3; /add?code=… is the query-string form of the same link).
# Anchored to the URL ITSELF (ruling C, round 3): the host must be one rule 1
# (the setup-page rule, `_wrong_address` below) accepts — *.ts.net, an IP
# literal, or localhost — and the PATH must be exactly /add, /add/, or a
# single segment after /add/ (the query, the fragment, or that one segment is
# where the code rides). A bare substring match ("/add?" or "/add#" anywhere)
# used to arm on ANY host's own /add endpoint — "https://api.example.com/
# cart/add?sku=HX42KP97" is a different service's honest query, not a card.
# C (round 4): the URL arms ONLY ITS OWN token — one sitting after its
# "/add" — never another code-shaped token that shares its clause ("…/add
# on the laptop running build 4ad87ac7" names a build, not a code); and it is
# recognised with or without a scheme and case-insensitively on its path
# ("nova-old.fake-tailnet.ts.net/add#…", "…/ADD#…"). Scheme-led urls are
# found as every guard finds them (_URL); _SCHEMELESS_ADD_URL finds only the
# ones written without one, starting at a host (never mid-path, so
# "…/cart/add" is not a host) that has a dot or is localhost or [IPv6].
_ADD_PATH = re.compile(r"^/add(?:/[^/]*)?$", re.I)
_SCHEMELESS_ADD_URL = re.compile(
    r"(?<![\w.:/@-])(?:\[[0-9a-f:.]+\]|localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)+)"
    r"(?::\d{1,5})?/add[^\s)>\]]*",
    re.I,
)


def _add_url_token_start(url: str) -> int | None:
    """Where a qualifying /add URL's OWN token may begin: the offset in `url`
    just past its "/add" (its query, its fragment or its one segment follow),
    or None when `url` does not qualify — its host must be one rule 1 accepts
    and its path /add, /add/ or a single segment after /add/ (ruling C,
    rounds 3-4), never a bare substring match, which would arm on any other
    service's own /add endpoint. `url` may carry no scheme (round 4); the
    path is read case-insensitively. `_ip` is defined further below in this
    module; module globals resolve at call time, so the forward reference is
    fine."""
    has_scheme = url.lower().startswith(("http://", "https://"))
    try:
        parts = urlsplit(url if has_scheme else f"https://{url}")
    except ValueError:
        return None
    host = (parts.hostname or "").lower()
    nova_like = host.endswith(".ts.net") or host == "localhost" or _ip(host) is not None
    if not nova_like or _ADD_PATH.match(parts.path or "") is None:
        return None
    lead = len(parts.scheme) + len("://") if has_scheme else 0
    return lead + len(parts.netloc) + len("/add")


def _own_add_tails(clause: str) -> list[tuple[int, int]]:
    """(start, end) in `clause` of each qualifying /add URL's own tail — the
    only place such a URL makes a code-shaped token pairing context — sorted
    and merged where they overlap (a url written inside another's query), so
    `_in_own_tail` can find a token's tail by bisection: a clause of many
    urls and many tokens stays linear, never urls x tokens."""
    tails: list[tuple[int, int]] = []
    for found in (*_URL.finditer(clause), *_SCHEMELESS_ADD_URL.finditer(clause)):
        url = _strip_trailing_punct(found.group(0))
        start = _add_url_token_start(url)
        if start is not None:
            tails.append((found.start() + start, found.start() + len(url)))
    merged: list[tuple[int, int]] = []
    for start, end in sorted(tails):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _in_own_tail(tails: list[tuple[int, int]], start: int, end: int) -> bool:
    """True when [start, end) lies inside one of `tails` (_own_add_tails)."""
    i = bisect_right(tails, start, key=lambda tail: tail[0]) - 1
    return i >= 0 and tails[i][1] >= end


# C (round 5): beside a qualifying /add URL, a code-shaped token PRESENTED
# AS A CODE is pairing context too — right after "code" (optionally "is",
# "was" or ":"), or after enter|type|use|input|paste with at most one
# determiner (the, this, that, your) between: "…/add on the laptop and enter
# the code K7PQ-9XYZ", "…/add and type K7PQ-9XYZ". A build or a commit
# ("…/add on the laptop running build 4ad87ac7") is neither, and stays
# untouched. Groups 1 and 2 are the token's halves, as in _CODE_TOKEN; the
# lead ends in whitespace or ":", so nothing is glued to the token's left.
_CODE_PRESENTED = re.compile(
    r"(?:\bcode(?:\s+(?:is|was))?(?:\s*:\s*|\s+)"
    r"|\b(?:enter|type|use|input|paste)\s+(?:(?:the|this|that|your)\s+)?)"
    rf"({_CODE_CHAR}{{4}})-?({_CODE_CHAR}{{4}})(?![A-Za-z0-9-])",
    re.I,
)
# Final review (ruling, amended): wherever the check arms — a pairing word in
# the clause, or a token presented as a code beside an /add URL — a pairing
# word nearby does not make every code-shaped token a code. Two never are:
#   * one a NON-PAIRING QUALIFIER names right before it, optionally followed
#     by "code" (then "is", "was" or ":"): "at commit 4ad87ac7", "error code
#     E4B7-9C2D", "the source code 4ad87ac7" — some other thing's identifier;
#   * a SHA-SHAPED one (exactly 8 lowercase hex characters, no dash — git's
#     short form, a third of which fall inside the pairing alphabet) anywhere
#     but straight after a bare "code" ("code", "code is", "code was",
#     "code:"): "a pair of commits: 4ad87ac7", "use 4ad87ac7 as the build".
# The accepted cost, pinned: straight after a bare "code", a SHA-shaped token
# is still presented as a code ("novad's code 4ad87ac7 is the one to type").
# Neither rule judges a token in an /add URL's OWN tail: that is where the QR
# flow puts the code, whatever its shape (C, round 4).
_NON_PAIRING_LEAD = re.compile(
    r"\b(?:commit|build|sha|hash|version|release|revision|rev|error|exit|status"
    r"|verification|promo|zip|order|ticket|sku|id|source)"
    r"(?:\s++code)?(?:\s++(?:is|was))?(?:\s*+:\s*+|\s++)$",
    re.I,
)
_BARE_CODE_LEAD = re.compile(r"\bcode(?:\s++(?:is|was))?(?:\s*+:\s*+|\s++)$", re.I)
_SHA_SHAPED = re.compile(r"[0-9a-f]{8}")
# How far back from a token its lead is read: the longest ("verification code
# was: ") is a few dozen characters, and a fixed window keeps a clause of many
# tokens linear.
_LEAD_WINDOW = 64


def _never_a_pairing_code(text: str, start: int, end: int) -> bool:
    """True when the code-shaped token at text[start:end] is one code_claim
    never claims (the two rules above). Read with pos/endpos, never a slice,
    so the window's edge is no word boundary of its own ("recommit" is not
    "commit")."""
    lead_from = max(0, start - _LEAD_WINDOW)
    if _NON_PAIRING_LEAD.search(text, lead_from, start) is not None:
        return True
    if _SHA_SHAPED.fullmatch(text, start, end) is None:
        return False
    return _BARE_CODE_LEAD.search(text, lead_from, start) is None


CODE_ON_THE_CARD = "the code on the card"
CODE_CLAIM_CORRECTION = (
    "Correction: I never see pairing codes — a code reaches only the card on your screen, "
    "so that code was not one. Use the code on the card, or ask me for a new card."
)


def _code_key(first: str, second: str) -> str:
    return (first + second).upper()


def code_claim_check(reply_text: str, user_message: str = "") -> RewriteClaim | None:
    """A pairing code in her reply that the owner did not type (S47).

    She never receives a code — it goes to the card only (tools/setup.py) — so
    a code-shaped token she presents as a code is invented by construction.
    Presented means: eight characters of the pairing alphabet with at least one
    digit and one letter, in a clause with PAIRING context (review fix round 1,
    I4; extended round 2, C; anchored round 3): pairing, pair, enroll/enrol*,
    --code, novad, "one-time code", "setup code" — or, for the token riding
    in an /add URL itself (its query, its fragment, or a single path segment
    after /add/) and for that token ONLY (round 4), the URL, on a host rule 1
    accepts, with or without a scheme (`_add_url_token_start`); and, in a
    SENTENCE holding such a URL, a token PRESENTED AS A CODE (round 5,
    `_CODE_PRESENTED` — "enter the code K7PQ-9XYZ", "type K7PQ-9XYZ"). The
    scope is the sentence because ";" splits clauses and "…/add on the
    laptop; the code is K7PQ-9XYZ." must still lose its code. A
    bare "code" is not enough on its own — "the verification code in that
    email is 48KX2M9P" and "error code E4B7-9C2D came from the updater" are
    honest, code-shaped or not — and neither is a different service's own
    /add endpoint ("https://api.example.com/cart/add?sku=HX42KP97" is not a
    pairing link). Where the pairing words or a presented code arm it, a
    token a non-pairing qualifier names ("commit 4ad87ac7", "error code
    E4B7-9C2D") is never claimed, nor a SHA-shaped one (8 lowercase hex, no
    dash) anywhere but straight after a bare "code" (final review,
    `_never_a_pairing_code`); a token in an /add URL's own tail is claimed
    whatever its shape. A token the owner's own message carries is his and
    is never touched. Why it matters: five bad codes lock every enroll for
    15 minutes."""
    if not reply_text:
        return None
    theirs = {_code_key(m.group(1), m.group(2)) for m in _CODE_TOKEN.finditer(user_message or "")}
    invented: set[str] = set()

    def consider(m: re.Match[str]) -> None:
        key = _code_key(m.group(1), m.group(2))
        if key in theirs:
            return
        if any(ch.isdigit() for ch in key) and any(ch.isalpha() for ch in key):
            invented.add(key)

    for clause, _is_question in _clauses(reply_text):
        whole_clause = _CODE_WORD.search(clause) is not None
        # The /add URLs' own tails, read only when needed: a clause with no
        # pairing word needs them to arm at all, one with a pairing word only
        # for a token the final review's two rules leave unclaimed.
        own: list[tuple[int, int]] | None = None
        if not whole_clause:
            own = _own_add_tails(clause)
            if not own:
                continue
        for m in _CODE_TOKEN.finditer(clause):
            if whole_clause and not _never_a_pairing_code(clause, m.start(), m.end()):
                consider(m)
                continue
            # C (round 4): an /add URL arms its own token and no other,
            # whatever that token's shape or lead.
            if own is None:
                own = _own_add_tails(clause)
            if _in_own_tail(own, m.start(), m.end()):
                consider(m)
    # C (round 5): a token PRESENTED AS A CODE beside a qualifying /add URL,
    # under the same two rules (final review).
    for sentence in _sentences(reply_text):
        if _CODE_PRESENTED.search(sentence) is not None and _own_add_tails(sentence):
            for m in _CODE_PRESENTED.finditer(sentence):
                if not _never_a_pairing_code(sentence, m.start(1), m.end(2)):
                    consider(m)
    if not invented:
        return None

    def swap(m: re.Match[str]) -> str:
        return CODE_ON_THE_CARD if _code_key(m.group(1), m.group(2)) in invented else m.group(0)

    return RewriteClaim(
        kind="invented_code",
        tokens=tuple(sorted(invented)),
        rewritten=_CODE_TOKEN.sub(swap, reply_text),
        text=CODE_CLAIM_CORRECTION,
    )


_SETUP_PAGE = re.compile(r"^/(?:install|app|add)(?:[/?#]|$)")
_STORE_HOSTS = frozenset(
    {"apps.apple.com", "itunes.apple.com", "testflight.apple.com", "play.google.com"}
)
# Rule 3's device list ONLY (controller ruling I1, review fix round 1): the
# exact enumeration — phone(s), tablet(s), iPhone, iPad, Android, laptop(s),
# "another device/computer/machine". "your computer/Mac/PC" and bare "other
# devices/computers" are DROPPED: on a default install, "your computer" IS
# the hub, and "On your computer, open http://localhost:3000" is a true
# sentence about the hub, not a wrong address for another device. Rule 1
# reads the same list for a loopback setup page (final review).
_OTHER_DEVICE = re.compile(
    r"\b(?:phones?|iphones?|ipads?|tablets?|android|laptops?"
    r"|another\s+(?:device|computer|machine))\b",
    re.I,
)
# Rule 2's "Nova GOVERNS the url" test (ruling I1, amended round 2; extended
# ruling A, round 3): a bare "nova" ANYWHERE in the clause was too wide —
# "Add http://192.168.0.50:8080 as a provider in Nova's settings" has "Nova"
# nowhere near the url and is some OTHER service's honest LAN address. The
# url must be the object or complement of a Nova-referring phrase, checked
# against the text IMMEDIATELY BEFORE the url (the caller passes it, bounded
# to its last _GOVERNS_LOOKBEHIND characters so a clause of many urls stays
# linear) and anchored to end there ($), optionally through a DELIMITER the
# model wrapped the url in — a backtick, <, (, [, a quote, or ** — so "Open
# Nova at `<url>`" is still governed. Four phrasings: "Nova is/lives/runs
# at|on <url>"; "open|reach|find|use|access|scan nova|me [on your <device>]
# at|on|via <url>"; the FIRST-PERSON lead (round 3), which takes "at" ONLY
# (round 4) — "I am|I'm|I live|I'm reachable|I'm available|I'm running at
# <url>": "I run on"/"I'm running on <url>" names the machine a MODEL runs
# on (a provider's base_url, spec §8's must-not-fire), never where to open
# Nova, so it never arms the LAN rule; and "nova's|my
# address|url|link|web app is <url>" or, colon-led, with or without a space
# before the colon, "nova's|my address|url|link|web app: <url>" / "... :
# <url>". A trailing "Nova's settings" (after the url, or governing a
# DIFFERENT url) never enters `before` and so never matches.
_GOVERNS_LOOKBEHIND = 80
_GOVERNING_DELIM = r"(?:\*\*|[`<(\[\"'])?"
_NOVA_GOVERNS_URL = re.compile(
    r"\bnova\s+(?:is|lives|runs)\s+(?:at|on)\s*" + _GOVERNING_DELIM + r"$"
    r"|\b(?:open|reach|find|use|access|scan)\s+(?:nova|me)\b"
    r"(?:\s+on\s+your\s+[a-z]+)?\s+(?:at|on|via)\s*" + _GOVERNING_DELIM + r"$"
    r"|\bi(?:\s+am|['’]m(?:\s+running|\s+reachable|\s+available)?|\s+live)"
    r"\s+at\s*" + _GOVERNING_DELIM + r"$"
    r"|\b(?:nova['’]s|my)\s+(?:address|url|link|web\s*app)(?:\s+is\s+|\s*:\s*)"
    + _GOVERNING_DELIM
    + r"$",
    re.I,
)
# Local to the address rules (ruling I1 amended, round 2) — the shared
# _has_negator (every other guard reads it) is never widened. Same shape as
# _COMPLETION_NEGATION (the timer-completion guard, ~line 2643), which
# already covers "cannot"/"unable"/curly apostrophes/"won't" (the generic
# n['’]t\b matches inside "won't" with no "won" prefix needed) — a LOCAL
# copy so a future change to the timer guard's negation can never silently
# change what an address claim reads as denied. Checked over the WHOLE
# clause (round 1's scope stays): "http://…:3000 won't work on your phone"
# has the negation trailing the url, not preceding it, and must still count.
# A SUPERSET of _NEGATORS (ruling, round 3: no/not/never/nothing/none/
# without/n't, plus cannot/can't/unable/won't) — "none"/"nothing" were
# silently missing: \bno\b and \bnot\b each need a word boundary right after
# "no"/"not", which "none" and "nothing" never give them.
_ADDRESS_NEGATION = re.compile(
    r"\bno\b|\bnot\b|\bnever\b|\bnothing\b|\bnone\b|\bwithout\b"
    r"|n['’]t\b|\bcan(?:not|['’]t)\b|\bunable\b",
    re.I,
)
NO_ADDRESS = "(no address another device can reach)"
NO_APP = "(there is no Nova app yet)"


def _ip(host: str):
    try:
        return ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return None


# Rule 2's exact RFC1918 membership (ruling I1) — never ip.is_private, which
# ALSO reads 0.0.0.0/8 (unspecified), 169.254.0.0/16 (link-local), the
# TEST-NETs (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24), 198.18.0.0/15
# and 240.0.0.0/4 as private. A cloud metadata address, a scanner's TEST-NET
# hit or an unassigned 0.0.0.0 URL is not a LAN address Nova could ever
# actually be given.
_LAN_NETWORKS = (
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
)


def _is_lan_ip(ip) -> bool:
    return ip is not None and ip.version == 4 and any(ip in net for net in _LAN_NETWORKS)


def _empty_or_setup_path(path: str) -> bool:
    return path in ("", "/") or _SETUP_PAGE.match(path) is not None


def _strip_query_and_fragment(url: str) -> str:
    return url.split("?", 1)[0].split("#", 1)[0]


def _setup_page_of(path: str) -> str | None:
    """The setup page `path` names — "/install", "/app" or "/add" — whatever
    rides after it (a segment; a query and a fragment are not in `path`,
    which urlsplit has already cut); None for any other path."""
    if _SETUP_PAGE.match(path) is None:
        return None
    return "/" + path.split("/", 2)[1]


def _cut_after_setup_page(url: str) -> str:
    """`url` with EVERYTHING after its setup page's path dropped — a segment,
    a query, a fragment (ruling C, round 4, for /add; round 5, for /install
    and /app too); any other url unchanged. What address_claim records of a
    judged setup-page url: a code, typed by the owner or invented, rides in a
    segment as readily as in a query, on any setup page, and the span's
    `wrong` must never carry one."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    page = _setup_page_of(parts.path or "")
    if page is None:
        return url
    return url[: len(parts.scheme) + len("://") + len(parts.netloc)] + page


def _wrong_address(
    url: str, other_device: bool, before: str, origin: str | None
) -> tuple[str, str] | None:
    """(rule, replacement) when `url` is given as an address for Nova that is not
    the real one; None when it is the real one or not an address for Nova.

    `before` is the clause text up to the url's own start, bounded by the
    caller to its last _GOVERNS_LOOKBEHIND characters (ruling A, round 3) —
    what rule 2's "Nova governs the url" test reads, so a Nova phrase
    governing a DIFFERENT url (earlier in the same clause) or trailing this
    one never counts. `other_device` is whether the url's clause names
    another device (_OTHER_DEVICE), read ONCE per clause by the caller (final
    review): rules 1 and 3 both ask it, and asking per url made a clause of
    many loopback urls quadratic. The caller has already ruled out a clause a
    negation precedes (ruling I1 — every one of the four rules skips a URL
    "won't work"/"can't use").
    """
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return None
    host = (parts.hostname or "").lower()
    here = f"{parts.scheme}://{parts.netloc}".lower()
    if origin is not None and here == origin.lower():
        return None
    path = parts.path or ""
    if host in _STORE_HOSTS:
        if "nova" in path.lower() and not native_app.is_store_link(url):
            return ("store_link", NO_APP)
        return None
    ip = _ip(host)
    nova_like = host.endswith(".ts.net") or host == "localhost" or ip is not None
    loopback = host == "localhost" or (ip is not None and ip.is_loopback)
    # Final review (ruling): a LOOPBACK setup page is true on the hub itself —
    # its own browser installs the web app at exactly that address ("On this
    # computer, open http://127.0.0.1:3000/install") — so for a loopback host
    # rule 1 fires only when the clause names another device, as rule 3 asks.
    # A tailnet name or a non-loopback IP stays unconditional.
    if nova_like and _SETUP_PAGE.match(path or "/") and (not loopback or other_device):
        # I7 (round 1) + C (round 2): BOTH the fragment and the query are
        # DROPPED, never carried into the replacement. An /add#CODE or
        # /add?code=CODE is presumptively the very invented pairing code
        # code_claim_check independently redacts; the corrected URL must
        # never be a second place that code survives. C (round 4): for /add,
        # a path SEGMENT goes too — everything after /add — whether or not
        # code_claim swapped the token first: an owner-typed code is exempt
        # from code_claim, so nothing else would ever cut it out of /add/<code>.
        # Round 5: /install and /app get the same cut, so no setup page ever
        # carries an owner-typed code into the corrected URL.
        page = _setup_page_of(path) or path
        return ("setup_page", f"{origin}{page}" if origin else NO_ADDRESS)
    replacement = origin or NO_ADDRESS
    setup_or_root = _empty_or_setup_path(path)
    if (
        parts.scheme == "http"
        and _is_lan_ip(ip)
        and port in (None, 3000, 8080)
        and setup_or_root
        and _NOVA_GOVERNS_URL.search(before)
    ):
        return ("lan", replacement)
    if loopback and setup_or_root and other_device:
        return ("loopback", replacement)
    return None


def _address_correction(rules: tuple[str, ...], origin: str | None, reason: str | None) -> str:
    parts: list[str] = []
    if set(rules) - {"store_link"}:
        if origin:
            parts.append(
                f"Correction: Nova's address for another device is {origin} — the address "
                "I gave was not it."
            )
        else:
            why = f" ({reason})" if reason else ""
            parts.append(
                "Correction: Nova has no address another device can reach right now"
                f"{why} — the address I gave was not one."
            )
    if "store_link" in rules:
        lead = "" if parts else "Correction: "
        parts.append(f"{lead}{native_app.stated()} The app link I gave was not one.")
    return " ".join(parts)


def address_claim_check(
    reply_text: str,
    user_message: str = "",
    origin: str | None = None,
    reason: str | None = None,
) -> RewriteClaim | None:
    """An address for Nova in her reply that is not the real one (S47).

    `origin` is network.address()'s answer NOW (None when there is none, with
    its `reason`), read by the caller — the guard keeps no address of its own.
    Four shapes, each precision-first: a setup page (/install, /app, /add) on a
    tailnet, IP or localhost origin that is not the real one — a loopback one
    only in a clause naming another device, since the hub's own browser
    installs the web app there (final review); a private-LAN URL
    on an app port given as where to open Nova, with a Nova phrase GOVERNING
    the url — not just "nova" anywhere in the clause (the web UI is never on
    the LAN, and a LAN URL for some OTHER service, even one that MENTIONS
    Nova elsewhere in the sentence, is honest — ruling I1 amended, round 2);
    loopback in a sentence about another device (loopback said about the hub
    itself, or about "your computer", is true — ruling I1); and a store link
    for a Nova app that does not exist. A URL the owner's own message carries
    is his and is never touched, and a URL a negation precedes anywhere in
    its clause is a denial, never a claim — cannot/unable/curly apostrophes
    included, via a LOCAL negation pattern, never the shared _has_negator
    (ruling I1 amended, round 2 — "Your phone cannot use http://…:3000").

    Rewrites by the OFFSET of each judged match, never a global str.replace
    (ruling I2): a URL judged wrong in one clause never touches the SAME url
    text sitting honestly in another clause, or a longer URL that happens to
    start with it. The one reach past its own offset (ruling, round 4): a
    judged url that is the TEXT of a markdown link whose TARGET is the same
    url — "[http://…:3000](http://…:3000)" — is rewritten in both places, or
    the link would show the truth and still open the wrong address.
    """
    if not reply_text:
        return None
    theirs = {_strip_trailing_punct(u) for u in _URL.findall(user_message or "")}
    # abs_start -> (abs_end, rule, replacement). Keyed by offset so a markdown
    # target recorded through its link text is never spliced twice when its
    # own match is judged as well (rules 1 and 3 read no `before`).
    spans: dict[int, tuple[int, str, str]] = {}
    wrong_urls: set[str] = set()
    cursor = 0
    for clause, _is_question in _clauses(reply_text):
        clause_start = reply_text.find(clause, cursor)
        if clause_start == -1:
            continue  # cannot be located (should not happen); touch nothing
        cursor = clause_start + len(clause)
        if _ADDRESS_NEGATION.search(clause) is not None:
            continue  # a negation anywhere in the clause: a denial, not a claim
        # Read once per clause, when its first url needs it (final review).
        other_device: bool | None = None
        for m in _URL.finditer(clause):
            url = _strip_trailing_punct(m.group(0))
            if not url or url in theirs:
                continue
            # A (round 3): slice the bounded window directly rather than
            # `clause[: m.start()][-N:]` — the latter still builds the WHOLE
            # prefix first, which is exactly the O(n^2) a clause of many urls
            # would hit.
            before = clause[max(0, m.start() - _GOVERNS_LOOKBEHIND) : m.start()]
            if other_device is None:
                other_device = _OTHER_DEVICE.search(clause) is not None
            verdict = _wrong_address(url, other_device, before, origin)
            if verdict is None:
                continue
            rule, replacement = verdict
            abs_start = clause_start + m.start()
            spans.setdefault(abs_start, (abs_start + len(url), rule, replacement))
            # Round 4 (markdown link): the text of "[url](url)" takes its
            # target with it — the same url, the same rule, the same truth.
            after = m.start() + len(url)
            if clause[m.start() - 1 : m.start()] == "[" and clause.startswith(f"]({url})", after):
                target = clause_start + after + len("](")
                spans.setdefault(target, (target + len(url), rule, replacement))
            # I7 (round 1) + C (round 2): never carry a query or a fragment
            # into what is recorded either — a code embedded in one must not
            # be echoed in a guard span. C (round 4, /add; round 5, every
            # setup page): nor anything after the setup page's path at all
            # (rule 1's own replacement drops the same).
            recorded = _strip_query_and_fragment(url)
            if rule == "setup_page":
                recorded = _cut_after_setup_page(recorded)
            wrong_urls.add(recorded)
    if not spans:
        return None
    rewritten = reply_text
    for abs_start in sorted(spans, reverse=True):
        abs_end, _rule, replacement = spans[abs_start]
        rewritten = rewritten[:abs_start] + replacement + rewritten[abs_end:]
    rules = tuple(sorted({rule for _, rule, _ in spans.values()}))
    return RewriteClaim(
        kind="wrong_address",
        tokens=tuple(sorted(wrong_urls)),
        rewritten=rewritten,
        text=_address_correction(rules, origin, reason),
        rules=rules,
        truth=origin,
    )


# -- the novelty-claim guard -------------------------------------------------
#
# The third: "this is new". A notice folds onto its fingerprint and counts the
# sightings, so whether a finding is news is a NUMBER (`notices.repeats`), and
# a beat calling the fourth sighting the first one turns a standing fault into
# a fresh alarm every morning — v3's fourteen-pushes-in-eight-hours failure
# wearing the digest's clothes.
#
# novelty_claim_check(reply_text, repeats_by_title) takes the counts from the
# caller (title -> repeats, as the notices rows hold them) and contradicts a
# novelty assertion WITH THE REAL COUNT, so the correction is itself evidence.
#
# The precision cuts:
#
#   * The claim must be an assertion of novelty, not a hedge ("this might be
#     new"), a negation ("that is not new" — which is also this guard's own
#     correction, so it must stay clean) or a question.
#   * The claim must be TIED to a repeated finding: a title is the one the
#     reply is talking about only when the reply shares at least two of its
#     content words (one, when the title has only one). Below that the guard
#     cannot tell what the sentence is about and says nothing.
#   * If a finding the caller reports as NEW (repeats <= 1) is tied to the
#     reply just as well, the novelty claim can honestly be about that one, so
#     the guard stays silent. A digest that names both a new fault and a
#     standing one is the ordinary case, and correcting it would make the
#     guard the liar.

_NOVELTY = re.compile(
    r"\b(?:this|that|it)(?:['’]s|\s+(?:is|looks|seems|appears))\s+(?:a\s+)?new\b"
    r"|\b(?:this|that)\s+is\s+the\s+first\s+time\b"
    r"|\bfor\s+the\s+first\s+time\b"
    r"|\bi(?:['’]ve|\s+have)\s+(?:not|never)\s+seen\s+(?:this|that|it)\s+before\b"
    r"|\b(?:this|that|it)\s+(?:has|have)\s+(?:not|never)\s+(?:happened|come\s+up|appeared)"
    r"\s+before\b"
    r"|\b(?:a\s+)?new\s+(?:finding|problem|issue|fault|failure|fold|notice)\b"
    r"|\bjust\s+(?:started|began|appeared|showed\s+up|came\s+up)\b"
    r"|\bfirst\s+(?:sighting|occurrence)\b",
    re.I,
)
# How many of a title's content words the reply must share before this guard
# will say the sentence is ABOUT that finding — and how many are enough to
# EXEMPT it. The asymmetry is the precision cut: a repeated finding must be
# named twice over before it is contradicted, while a single shared word with
# something the caller reports as new is enough for the novelty claim to be
# honest. Leniency runs toward not correcting.
_NOVELTY_MIN_OVERLAP = 2
_NOVELTY_EXEMPT_OVERLAP = 1


def _ties_to(title: str, said: frozenset[str], minimum: int) -> int:
    """How many of a title's content words the reply used, or 0 when that is
    below `minimum` (capped at the title's own length, so a one-word title is
    not unmatchable)."""
    words = {_singular(word) for word in _content_words(str(title))}
    if not words:
        return 0
    shared = len(words & said)
    return shared if shared >= min(minimum, len(words)) else 0


def novelty_claim_check(reply_text: str, repeats_by_title: Mapping[str, int]) -> Correction | None:
    """Contradict "this is new" about a finding that has already come back.

    Returns a Correction carrying the real sighting count, or None — a first
    sighting, a claim this cannot tie to a repeated finding, a reply that also
    names a genuinely new one, a hedge/negation/question, or an empty mapping.
    Pure and precision-first.
    """
    if not reply_text or not reply_text.strip() or not repeats_by_title:
        return None
    asserted = None
    for clause, is_question in _clauses(reply_text):
        if is_question:
            continue
        if _REPORTED.search(clause) is not None:
            continue
        match = _NOVELTY.search(clause)
        if match is None:
            continue
        if _DELEGATION_HEDGE.search(_obs_segment(clause[: match.start()])) is not None:
            continue
        asserted = match.group(0).strip()
        break
    if asserted is None:
        return None
    said = {_singular(word) for word in _content_words(reply_text)}
    for title, repeats in repeats_by_title.items():
        # A finding the caller itself reports as new, named anywhere in this
        # reply, is something the novelty claim could honestly be about — so
        # nothing is said at all.
        if int(repeats or 0) <= 1 and _ties_to(title, said, _NOVELTY_EXEMPT_OVERLAP):
            return None
    best: tuple[int, int, str] | None = None
    for title, repeats in repeats_by_title.items():
        count = int(repeats or 0)
        if count <= 1:
            continue
        shared = _ties_to(title, said, _NOVELTY_MIN_OVERLAP)
        if not shared:
            continue
        if best is None or (shared, count) > (best[0], best[1]):
            best = (shared, count, title)
    if best is None:
        return None
    _shared, repeats, title = best
    return Correction(
        claims=(UnbackedClaim(kind="unbacked_novelty", target=title[:80], phrase=asserted[:80]),),
        text=NOVELTY_CLAIM_CORRECTION.format(repeats=repeats),
    )


# -- the harness-prose detector (structural, not a guard) --------------------
#
# Not a claim check: a fact about WHO WROTE the words. When every `llm_call`
# span of a turn is recorded as having produced zero completion characters, the
# assistant text did not come from the model — it was composed by the backend
# (a stated failure, an empty-round statement, a placeholder). v3 pushed
# exactly that text to a phone as news and recorded the push a success. A beat
# whose text nobody wrote has nothing to deliver, and the caller records
# `unable` and delivers nothing.
#
# NO llm_call span at all is INDETERMINATE and returns False. That direction is
# the whole safety property: a True here SUPPRESSES a report, so an unreadable
# trace must never be read as "the model was silent" — the cost of a wrong True
# is the owner not being told about a real fault.
#
# What a span reports today, in order of authority:
#
#   * `completion_chars` — the characters the round's content actually ran to.
#     THIS FIELD DOES NOT EXIST YET (2026-09-08): app/chat.py's `llm_call` span
#     records `completion_tokens` (only when the gateway sends a usage chunk),
#     `tool_calls`, `error`/`error_class` and a `stream` counter, and nothing
#     that states the size of the text. The one honest recording is one line in
#     `_gateway_round`, beside `text = "".join(collected)`:
#         span.meta[guards.COMPLETION_CHARS_FIELD] = len(text)
#     Until it lands the detector still fires on the case it exists for, via
#     the second reading below; it gets sharper, not different, the day the
#     field is written.
#   * `error_class == "EmptyRound"` — chat.EMPTY_ROUND, which chat.py writes
#     ONLY when a round produced no content, no tool calls and no stated error.
#     That IS a recorded zero, mechanically, and it is the shape the v3 push
#     had behind it.
#   * `completion_tokens` greater than zero — read ONLY as evidence that the
#     round DID write something. A reported zero is never read as a zero: it is
#     a provider's count in another unit, and trusting it would suppress a real
#     report on a bad usage frame.
#
# Anything else — a gateway failure (the stream may have carried text before it
# broke), a span with no size on it at all — is indeterminate and returns False.

# The field app/chat.py should record the round's content length under, named
# here so the recording and the reading cannot drift apart.
COMPLETION_CHARS_FIELD = "completion_chars"
# chat.EMPTY_ROUND, mirrored as a literal because chat.py imports THIS module
# and the import cannot run the other way. tests/test_guards.py pins the two
# equal, so a rename reddens a test instead of silently never matching.
_EMPTY_ROUND_CLASS = "EmptyRound"


def _completion_size(span: Any) -> int | None:
    """The characters one llm_call span is RECORDED as having written, or None
    when the span does not say (see the section header for the three readings
    and why a reported zero token count is not one of them)."""
    meta = getattr(span, "meta", None) or {}
    chars = meta.get(COMPLETION_CHARS_FIELD)
    if isinstance(chars, int) and not isinstance(chars, bool):
        return max(chars, 0)
    if meta.get("error_class") == _EMPTY_ROUND_CLASS:
        return 0
    tokens = meta.get("completion_tokens")
    if isinstance(tokens, int) and not isinstance(tokens, bool) and tokens > 0:
        return tokens  # not a character count — read only as "not zero"
    return None


def model_wrote_nothing(spans: Sequence[Any]) -> bool:
    """True when every llm_call span of this turn reports zero completion
    characters — the text was written by the backend, not the model.

    False when any round wrote something, when any round's size cannot be read,
    and when there are no llm_call spans at all: an unreadable trace is
    INDETERMINATE and must never suppress a real report.
    """
    reported = 0
    for span in spans:
        if getattr(span, "kind", None) != "llm_call":
            continue
        size = _completion_size(span)
        if size is None or size > 0:
            return False
        reported += 1
    return reported > 0


# ── the SERVING-state claim: "the model is down" while it is answering ─────
#
# From the owner's chat on 2026-09-12. Two turns timed out at the gateway's
# 300 s read limit, each persisting its own honest failure statement as an
# assistant row. The NEXT turn — which the model answered — read those rows and
# reported the stack as broken, refusing to run anything and listing curl
# commands for the owner to try. Every word of it was about a state that had
# already passed.
#
# The evidence here needs no probe and cannot be argued with: THE REPLY EXISTS,
# so the model served this turn. A guard that had to ask the gateway whether it
# was up would be a guard that could be wrong; this one reads the turn's own
# chat round.
#
# Precision-first, like the other claim guards, and built on the same shared
# vocabulary: present-tense copulas only, hedges and intent verbs before the
# assertion suppress it, questions assert nothing, and a PAST report ("the
# model was unreachable a moment ago") is true and is left alone — correcting
# it would make the guard the liar, which is the failure the capability guard
# was fixed for on 2026-09-09.

STACK_CLAIM_CORRECTION = (
    "Correction: the model answered this turn — this reply came from it — so that is a "
    "record of something that already passed, not what is happening now. Whatever was "
    "asked for can be attempted."
)

# The turn kinds this guard is ARMED in: the kinds its precision was measured
# in, and no others.
#
#   * `chat` is S19's own, where the 2026-09-12 walk happened.
#   * `eval` replays chat's path with nothing injected (the turn's kind is its
#     only eval-ness, evals/runner), so an eval case scoring
#     guard_absent('stack_claim') measures exactly what chat would do. Armed by
#     S40 T7 (2026-09-19): before, the guard read only rounds stamped 'chat',
#     and that half of every eval case scored green by construction.
#
# NOT armed: `scheduled` and `agent`. Nobody reads those streams live and the
# correction is REPLACE-class, so a false one IS the persisted row. The S40 T7
# review measured three true outage reports contradicted there ("Your
# website's backend is down — the fetch returned 502." among them), and a
# scheduled "check my machines" turn answered by a cloud link while hub is
# down is reachable from S40 on. Arming a kind is a line here, after its
# MUST_NOT set is measured in it (test_guards); carried in slice-40-carries
# with the owner's question. `beat` never reaches this guard (beats do not run
# chat._run_turn) and is not armed either.
STACK_CLAIM_KINDS = frozenset({"chat", "eval"})

# The serving path, as the words a reply reaches for. A vocabulary, not a
# policy list: these are the nouns that mean "the thing that answers", and the
# model actually in play is added from the turn's own spans.
#
# Two vocabularies (stack-claim epic T3): the words a REMOTE machine's model
# server can be called (stack_claim_check's rule (b) excuses only these), and
# her own stack's words, which never name another machine's server.
_REMOTE_SERVER_NOUN = r"model|inference(?:\s+service)?|inference|llm|ollama"
_OWN_STACK_NOUN = r"gateway|chat\s+chain|chain|backend|stack"
_SERVING_NOUN = rf"(?:{_REMOTE_SERVER_NOUN}|{_OWN_STACK_NOUN})"
# The words of _REMOTE_SERVER_NOUN, for telling a matched subject's noun apart
# without another pattern: a subject naming any of them is a model server's.
_REMOTE_SERVER_WORDS = frozenset({"model", "inference", "llm", "ollama"})
_SERVING_DET = r"(?:the|your|that|this|its)"
# States that mean "it cannot answer right now".
_SERVING_STATE = (
    r"(?:unreachable|not\s+reachable|down|offline|unavailable|walled|blocked"
    r"|not\s+responding|unresponsive|not\s+working|failing|timing\s+out|refusing)"
)
# The adverbs that may sit between the copula and a serving state: the device
# guard's, WITHOUT "not" and "no longer" (S40b, verdict §3.1 B). There, a
# negated state is still an unchecked claim about now ("the device is not
# connected"); here every state word means "cannot answer", so "the model is
# not down" and "the gateway is no longer unreachable" say it CAN — and were
# corrected as outage claims, replacing an honest reply. "not responding" and
# "not working" are state words of their own and still fire. Derived from
# _STATE_ADVERBS, so an adverb added there reaches here too (the final fix
# wave's C13: built from the tuple, never by editing the joined pattern).
_SERVING_ADVERBS = tuple(a for a in _STATE_ADVERBS if a not in _NEGATING_ADVERBS)
_SERVING_ADVERB = "(?:" + "|".join(_SERVING_ADVERBS) + ")"
_SERVING_ASSERTION = re.compile(
    rf"\b(?P<subj>(?:{_SERVING_DET}\s+)?{_SERVING_NOUN})"
    rf"(?:\s+{_PRESENT_COPULA}|['’]s)"
    rf"(?:\s+{_SERVING_ADVERB})*"
    rf"\s+(?P<state>{_SERVING_STATE})\b",
    re.I,
)
# "I can't reach the model", "unable to reach ollama" — the same claim from the
# other side, and it carries no copula for the pattern above to anchor on.
_SERVING_UNREACHED = re.compile(
    rf"\b(?:can\s*(?:no|')?t|cannot|can\s+not|unable\s+to)\s+"
    rf"(?:reach|contact|talk\s+to|get\s+(?:a\s+)?(?:response|answer)\s+from)\s+"
    rf"(?P<subj>(?:{_SERVING_DET}\s+)?{_SERVING_NOUN})\b",
    re.I,
)


# The words by which a clause names her OWN serving path (stack-claim epic T2):
# first-person possessives, her name, the hub, the gateway. A vocabulary, like
# _SERVING_NOUN: a clause carrying one is about her stack, never excused.
_OWN_STACK_MARKER = re.compile(
    r"(?<![\w-])(?:my|our|nova['’]s|hub|gateway)(?![\w-])",
    re.I,
)


@lru_cache(maxsize=64)
def _qualifier_patterns(names: tuple[str, ...]) -> tuple[re.Pattern[str], re.Pattern[str]]:
    """(before, after) qualifier patterns over `names`, built once per tuple.

    before: the name ends the text right before the subject — "the Dell's
    Ollama", "the Dell Ollama" — searched on a bounded tail, anchored at \\Z.
    after: right after the claim, "… on/at/in [the] <name>" — re.match, so
    anchored at the claim's end. Literal alternations: linear in the text.
    The after pattern's leading gap is BOUNDED (\\s{1,16}): an unbounded
    leading \\s+ restarts at every position of a whitespace run under
    .search and walks the rest of the run each time — quadratic (timing
    sweep, 50 ms on 1500 spaces). The other gaps follow a literal word, so
    each starts once per occurrence."""
    alternation = "|".join(re.escape(name) for name in sorted(names, key=len, reverse=True))
    before = re.compile(rf"(?<![\w-])(?P<name>{alternation})(?:['’]s)?\Z", re.I)
    after = re.compile(
        rf"\s{{1,16}}(?:on|at|in)\s+(?:the\s+)?(?P<name>{alternation})(?![\w-])",
        re.I,
    )
    return before, after


@dataclass(frozen=True)
class _RemoteContext:
    """What this turn's spans say about machines other than her own — the
    inputs to stack_claim_check's two excuses (stack-claim epic T2)."""

    names: tuple[str, ...]
    longest: int
    not_answering: bool
    own_devices: re.Pattern[str] | None
    engine_served: bool

    @classmethod
    def of(cls, spans: Sequence[Any], names: tuple[str, ...], purpose: str) -> _RemoteContext:
        folded = {name.casefold() for name in names if not _OWN_STACK_MARKER.fullmatch(name)}
        not_answering = False
        reads = _machine_read_tools()
        for span in spans:
            if not _ok_tool_span(span, reads):
                continue
            facts = _span_meta(span).get("facts")
            if not isinstance(facts, list):
                continue
            for fact in facts:
                if (
                    isinstance(fact, dict)
                    and fact.get("answering") is False
                    and isinstance(fact.get("machine"), str)
                    and fact["machine"].strip().casefold() in folded
                ):
                    not_answering = True
        own = _hub_names(spans)
        # Her own engine answered a round of this turn (stack-claim epic T3):
        # an error-free round of her purpose the gateway says ran on an engine
        # — derived from the llm_call spans, never from a machine's name.
        engine_served = any(
            _span_meta(span).get("purpose") in (None, purpose)
            and _engine_served_head(span) is not None
            for span in spans
        )
        return cls(
            names=names,
            longest=max(len(name) for name in names),
            not_answering=not_answering,
            own_devices=_machine_name_pattern(own) if own else None,
            engine_served=engine_served,
        )

    def _qualifier(self, clause: str, match: re.Match[str]) -> str | None:
        """The name that qualifies the claim's subject, if one does: right
        before the subject (possessive or adjacent) or right after the claim
        ("on/at/in [the] <name>"). Never a name elsewhere in the clause."""
        before_pattern, after_pattern = _qualifier_patterns(self.names)
        tail = clause[: match.start("subj")].rstrip()
        found = before_pattern.search(tail[-(self.longest + 3) :])
        if found is None:
            found = after_pattern.match(clause, match.end())
        return found.group("name") if found is not None else None

    def excuses(self, clause: str, match: re.Match[str]) -> bool:
        if "gateway" in match.group("subj").casefold():
            return False
        qualifier = self._qualifier(clause, match)
        if qualifier is not None:
            # (a) "the Dell's Ollama", "Ollama on the Dell" — unless the name
            # is her own ("the hub's Ollama").
            return not _OWN_STACK_MARKER.fullmatch(qualifier)
        # (b) a bare subject while another machine is recorded not answering,
        # and nothing in the clause names her own stack or computer. Never
        # when her own engine answered this turn (a bare "Ollama is down" is
        # then false of hers and ambiguous at best), and only for a noun a
        # remote machine's model server can be called — "the backend", "the
        # stack" are her own stack's words (stack-claim epic T3).
        if self.engine_served or not self.not_answering:
            return False
        if not _REMOTE_SERVER_WORDS.intersection(match.group("subj").casefold().split()):
            return False
        if _OWN_STACK_MARKER.search(clause):
            return False
        return self.own_devices is None or self.own_devices.search(clause) is None


@dataclass(frozen=True)
class StackClaim:
    """An assertion that the thing answering cannot answer.

    `subject` is what the reply named (the span says which), `phrase` the
    matched text, and `text` the stated correction — the same shape the other
    claim guards carry, so the turn's composition reads it identically.
    """

    subject: str
    phrase: str
    text: str = STACK_CLAIM_CORRECTION


def served_this_turn(spans: Sequence[Any], purpose: str) -> bool:
    """Did the model answer THIS turn? One of the turn's OWN rounds with no
    error on it.

    `purpose` is what the turn's own rounds are recorded under — its kind
    (traces.purpose_of): `chat`, and equally `scheduled`, `beat`, `agent` or
    `eval`, each of them a turn a model answers. It is the caller's to state,
    never a default: reading only `chat` left every eval case scoring
    guard_absent('stack_claim') green by construction (found by S40 T7,
    2026-09-19). Which kinds the GUARD runs in is a separate question,
    answered by STACK_CLAIM_KINDS.

    Judge and redirect rounds are llm_call spans too and are deliberately not
    evidence: they carry their own purpose, they are the backend's own second
    opinions, and the claim under test is about the reply in hand.
    """
    for span in spans:
        if getattr(span, "kind", None) != "llm_call":
            continue
        meta = getattr(span, "meta", None) or {}
        if meta.get("purpose") not in (None, purpose):
            continue
        if not meta.get("error"):
            return True
    return False


def stack_claim_check(reply_text: str, spans: Sequence[Any], *, purpose: str) -> StackClaim | None:
    """Contradict a present-tense claim that the serving path is down, made in
    a turn the model served. None otherwise — pure, precision-first, fail-open
    at the call site like every other guard here. `purpose` is the turn's kind,
    which is its own rounds' purpose (see served_this_turn). In a kind outside
    STACK_CLAIM_KINDS it says nothing: its precision there is unmeasured."""
    if purpose not in STACK_CLAIM_KINDS:
        return None
    if not reply_text or not reply_text.strip():
        return None
    if not served_this_turn(spans, purpose):
        return None
    # A claim about ANOTHER machine's model server (stack-claim epic T2) is
    # not a claim about hers: excused when (a) a machine of this turn
    # qualifies the claim's subject, or (b) the subject is bare while this
    # turn's machine_status recorded such a machine not answering and the
    # clause names nothing of her own. Names come only from the spans.
    others = other_machine_names(spans, purpose)
    remote = _RemoteContext.of(spans, others, purpose) if others else None
    for clause, is_question in _clauses(reply_text):
        if is_question:
            continue
        for pattern in (_SERVING_ASSERTION, _SERVING_UNREACHED):
            match = pattern.search(clause)
            if match is None:
                continue
            before = clause[: match.start()]
            if _state_prefix_blocks(before) or _PRIOR_TIME.search(clause):
                continue
            if remote is not None and remote.excuses(clause, match):
                continue
            return StackClaim(
                subject=match.group("subj").strip(),
                phrase=match.group(0).strip(),
            )
    return None


# ── S40b: the SERVED-model claim — "the current model is X" while Y answered ──
#
# The S40 live walk (2026-09-19). Asked where her models run, she marked
# `qwen3.8:27b` "Current model in use" in two turns hub:qwen3:8b served
# (b851aa91, b02a5694) — a line his older notes also carry, beside a prompt
# line that stated the chat SETTING as "the model answering". Asked 17 × 23, she
# answered and added "No model was needed for this calculation." (60834ccf) —
# which went into his notes, because nothing stopped the turn being ingested.
#
# The evidence needs no probe and cannot be argued with: the gateway stamps
# every round it serves with the model that served it (X-Nova-Served-By), and
# chat records it on the round's span as `served_by`. A NAMED claim is
# contradicted when some round of this turn was stamped and none of the stamps
# is the model named (any purpose: a model that served ANY round of the turn is
# not contradicted — lenient on purpose). "No model was needed" is contradicted
# by the turn's own round existing at all (served_this_turn). The requested
# `meta.model` is deliberately NOT evidence (verdict §2): it is the setting,
# and on a fallback the setting is exactly the lie.
#
# Precision-first, measured over 649 real replies (s40b/design-verdict.md §4):
# a model reference must be letter-led with a tag (so a GPU id, a port and a
# clock time are not models), a line labelled with anything but chat or the
# current model is some other role's line, a model "in use FOR/BY" something is
# in use for something else, and the role words (vision, judge, embedder,
# fallback…) mark a claim about another role. Past, hedged, reported, quoted and
# questioned forms assert nothing about this reply. APPEND-class: the reply may
# carry real content beside the false line, so the correction follows it; the
# turn is not ingested. Armed only in STACK_CLAIM_KINDS, where it was measured.

SERVED_CLAIM_CORRECTION = (
    "Correction: this reply was written by {served} — the gateway recorded that for this "
    "turn — not by {claimed}."
)
SERVED_NO_MODEL_CORRECTION = "Correction: a model wrote this reply — {served}."

# A model reference: an optional provider/engine prefix, then a letter-led
# name with a tag (`qwen3.8:27b`, `hub:qwen3:8b`, `hf.co/org/repo:tag`). Never
# a compute id (`cuda:GPU-…`), a URL, or a port (`ollama:11434`).
_SERVED_REF = (
    r"(?<![\w./:-])(?P<ref>(?!(?:gpu|cpu|cuda|rocm|metal|https?):)"
    r"(?:[a-z0-9][a-z0-9_-]{0,31}:)?"
    r"(?:hf\.co/[\w.-]+/[\w.-]+(?::[\w.-]+)?"
    r"|[A-Za-z][\w.-]*(?:/[\w.-]+)?:(?!\d+\b)[\w.-]+))"
)
_SERVED_REF_RE = re.compile(_SERVED_REF, re.I)
# "Current model in use", "in use", "answering you" — the marker a line or a
# clause carries beside the ref it is about. "in use by/for/as/…" is in use for
# something else.
_IN_USE = re.compile(
    r"\b(?:current(?:ly)?\s+(?:chat\s+)?model(?:\s+in\s+use)?"
    r"|(?:currently\s+)?in\s+use(?!\s+(?:by|for|as|in|on|with|when|if)\b)"
    r"|(?:currently\s+|now\s+)?(?:answering|serving)\s+(?:you|this\s+(?:chat|conversation|reply|turn))"
    r"|active\s+(?:chat\s+)?model)\b",
    re.I,
)
# Another role, a standby, or the past: the claim is not about this reply.
_SERVED_SKIP = re.compile(
    r"\b(?:vision|judge|coding|coder|scheduled|embed\w*|ingest\w*|images?|photos?|pictures?"
    r"|agents?|distil\w*|fallback|standby|backup|was|were|previously"
    r"|not\s+(?:the\s+)?(?:current|in\s+use))\b",
    re.I,
)
# A labelled line ("- coding: gemma4:31b (active model)"): its label must say
# chat or the current model for an in-use marker on it to be about this reply.
# `^\s*+`, as in _READING_LINE and _SUBJECT_KEY_LINE: the leading run beside an
# optional bullet matched the same, without trying every split of it.
_LINE_LABEL = re.compile(r"^\s*+(?:[-+•]|\d+[.)])?\s*(?P<label>[A-Za-z][A-Za-z ]{0,30}?)\s*:\s")
_LABEL_OK = re.compile(
    r"chat(?:\s+model)?|(?:current|active)\s+(?:chat\s+)?model|model(?:\s+in\s+use)?"
    r"|in\s+use|answering(?:\s+now)?|serving(?:\s+now)?",
    re.I,
)
# Sentence shape 6 of the verdict: "R is serving|answering you|this|now". Its
# match ends on the object, so what follows can still limit it to another role
# (T2 review, round 1): "gemma4:12b is serving now AS THE VISION MODEL", "…
# is serving this chat's IMAGES". _served_claims reads the rest of the clause
# for this shape — the in-use limit right after it, the role and past words
# anywhere after it — as shape 7 reads "(?!\s+(?:for|in|on))".
_SERVED_ANSWERING = re.compile(
    rf"{_SERVED_REF}\s+(?:is|['’]s)\s+(?:currently\s+|now\s+)?(?:the\s+(?:model\s+)?)?"
    r"(?:answering|serving|replying\s+to|responding\s+to)\s+(?:you|this|now|right\s+now)\b",
    re.I,
)
# The sentence shapes that name the model answering this reply.
_SERVED_SENTENCES = tuple(
    re.compile(pattern, re.I)
    for pattern in (
        r"\b(?:the\s+)?model\s+(?:that(?:['’]s|\s+is)\s+)?"
        r"(?:answering|serving|replying|responding)(?:\s+(?:you|this|here))?"
        rf"(?:\s+(?:right\s+now|now|currently))?\s+is\s+{_SERVED_REF}",
        rf"\bthe\s+current\s+(?:chat\s+)?model\s+is\s+{_SERVED_REF}",
        r"\bi(?:['’]m|\s+am)\s+(?:currently\s+|now\s+)?"
        rf"(?:(?:running\s+(?:on|as)|served\s+by|powered\s+by)\s+)?{_SERVED_REF}",
        r"\b(?:this|my)\s+(?:reply|answer|response|message)\s+"
        r"(?:came|comes|is\s+coming|was\s+(?:written|generated|served))\s+(?:from|by)\s+"
        rf"{_SERVED_REF}",
        r"\byou(?:['’]re|\s+are)\s+(?:currently\s+|now\s+)?(?:talking|speaking|chatting)\s+"
        rf"(?:to|with)\s+{_SERVED_REF}",
    )
) + (
    _SERVED_ANSWERING,
    re.compile(
        rf"{_SERVED_REF}\s+(?:is|['’]s)\s+(?:currently\s+)?(?:the\s+)?(?:current|active)\s+"
        r"(?:chat\s+)?model\b(?!\s+(?:for|in|on)\b)",
        re.I,
    ),
)
# "No model was needed" — about THIS answer, never about a pull, an embedding,
# an image, or a step a timer ran.
#
# T2 review, round 1: the verdict's pattern let the bare, sentence-ending form
# fire in the present too, and "no model IS needed" at the end of a sentence is
# a general statement ("To set a timer, no model is needed.", "Reminders fire
# by themselves — no model is involved.") — true, and corrected. The past
# ("was") is about what just happened, so it may end the sentence; the present
# must carry this reply's own tail ("here", "to answer this", "for this
# answer"). Every §4 MUST_FIRE is "was" or "I didn't use a model here".
#
# S40b final fix wave (A6): the past too. A bare "no model was needed." ends
# honest sentences about a timer or a reminder ("Your 9:00 reminder went out
# by itself. No model was involved."), and was corrected with "a model wrote
# this reply". So the "was" form needs this reply's tail as the "is" form
# does, and only the FIRST-PERSON form ("I didn't use a model.") may end its
# sentence: she is its subject, and she wrote the reply. The walk's line,
# "No model was needed for this calculation.", keeps its tail and fires.
_NO_MODEL_THIS_REPLY = (
    r"here\b|to\s+answer\s+(?:this|that|it)\b"
    r"|for\s+(?:this|that)\s+(?:answer|reply|response|calculation|question|sum|math)\b"
)
_NO_MODEL = re.compile(
    r"\bno\s+(?:ai\s+|language\s+|llm\s+)?model\s+"
    rf"(?:was|is)\s+(?:needed|used|required|involved)(?=\s+(?:{_NO_MODEL_THIS_REPLY}))"
    r"|\bi\s+(?:did\s+not|didn['’]t)\s+(?:need\s+to\s+)?use\s+(?:a|any)\s+model"
    r"(?=\s*(?:[.!;]|$)|\s+(?:here|for\s+(?:this|that)\s+"
    r"(?:answer|reply|response|calculation|question)))",
    re.I,
)
_LATEST_TAG = ":latest"
# S40b final fix wave (C4), the CLAIM side only: "ollama:" is how history
# named the builtin engine, so "ollama:qwen3:8b" names the tag on whichever
# machine serves it; and a quantization or precision suffix names the same
# model's build ("qwen3:8b-q4_K_M", "-q8_0", "-fp16"). Neither is a different
# model, and correcting "qwen3:8b-q4_K_M" to "hub:qwen3:8b" is pedantry that
# teaches him her corrections are noise.
_OLLAMA_PREFIX = re.compile(r"^ollama:(?=[A-Za-z])", re.I)
_QUANT_SUFFIX = re.compile(
    r"-(?:q\d(?:_[A-Za-z0-9]+)*|iq\d_[A-Za-z0-9_]+|fp16|bf16|f16|fp32|f32)$", re.I
)


def _claimed_as_served(claimed: str) -> str:
    """The claimed ref as the served-by stamps would spell it: no ":latest"
    tag, no "ollama:" alias for the builtin engine, no quantization suffix."""
    compared = claimed[: -len(_LATEST_TAG)] if claimed.lower().endswith(_LATEST_TAG) else claimed
    compared = _OLLAMA_PREFIX.sub("", compared)
    return _QUANT_SUFFIX.sub("", compared)


# -- T2 precision cuts, beyond the verdict's corpus -------------------------
#
# Each removes fires only (every §4 MUST_FIRE still fires), each is pinned by
# honest sentences in test_served_guard that the verbatim patterns corrected:
#
#   * A SETTING is not this reply: "The chat setting's current model is X",
#     "…names X as the current model". The verdict counts a settings claim as
#     an accepted miss ("The chat model is X"); these are the same claim.
_SERVED_SETTING = re.compile(r"\b(?:settings?|config\w*)\b", re.I)
#   * An in-use marker LIMITED by what follows it is about another place or
#     role — "the current model on dell", "the active model in the catalog",
#     "in use elsewhere" — as the verdict's own "in use by/for/…" and "current
#     model for/in/on" (sentence shape 7) already are, for every marker.
# Possessive (S40b fix-wave follow-up, D2). No run-start lookbehind here,
# unlike `_CLAUSE_SPLIT` and `_FAULT_COPULA`: this one is used as
# `.match(clause, m.end())`, where a lookbehind would read the character
# before the match it is continuing from, not a run boundary.
_IN_USE_LIMITED = re.compile(r"\s++(?:for|in|on|by|as|with|when|if|elsewhere)\b", re.I)
#   * Leading up to the ref and its marker (from the conjunct's start when the
#     ref comes first, between the two when it follows), a negation, the past
#     or a change of state says the ref is NOT in use, WAS, or would BECOME
#     it: "X isn't in use",
#     "X is no longer the current model", "X used to be the current model",
#     "the current model is not X", "make X the current model", "names X as
#     the current model".
_IN_USE_UNSAID = re.compile(
    r"\b(?:not|never|no\s+longer|no\s+more|used\s+to|had|make|making|set|setting"
    r"|switch\w*|chang\w*|becom\w*|to\s+be|as)\b|n['’]t\b",
    re.I,
)
#   * A coordinated clause is its own claim: in "hub:qwen3:8b is the current
#     model and qwen3.8:27b is installed" the nearest ref across "and" is the
#     installed one. The marker's candidates are the refs in its own conjunct.
# `(?:,|(?<!\s))` for `,?`: a leftmost match only ever starts at a comma or at
# the FIRST space of a run (one starting mid-run implies one at the run's
# start), so finditer's matches are unchanged — and it no longer re-walks the
# rest of a whitespace run from every position in it (quadratic: 63 ms on a
# 1,500-space clause, over the timing sweep's 50 ms budget).
_IN_USE_CONJUNCT = re.compile(r"(?:,|(?<!\s))\s+(?:and|while|whereas|plus)\s+", re.I)
#   * T2 review, round 1: the marker is about the ref it is SAID of, never the
#     nearest ref in the conjunct. The conjunct split knew only and/while/
#     whereas/plus, and a comma, a dash, a colon, a parenthesis or a machine
#     subject slipped past it: "hub:qwen3:8b is in use, gemma4:12b and
#     qwen3.8:27b are installed", "qwen3:8b is in use — gemma4:12b is idle",
#     "hub (serving you) has qwen3.8:27b installed" each corrected a true
#     reply against the idle model. So the ref BEFORE the marker counts only
#     across copula, parenthetical or badge material — a size or runtime in
#     brackets, ✅, a dash, a table cell's bar, the marker's own "(" and one
#     "is (the) (model)" — and the ref AFTER it only when the marker is a
#     label or a subject ("Current model: X", "The model in use is X").
#   * T2 review, round 2: when both qualify, which one the marker is said of
#     depends on what joins the ref before to it. Across a COPULA the marker
#     is that ref's predicate and the ref before wins ("qwen3:8b is the model
#     in use: qwen3.8:27b is idle"). Across badge material only, the marker
#     is a LABEL on a list line, and a label names the ref after its colon
#     ("- `gemma4:12b` (7.0 GB) — current model: `qwen3:8b`", "qwen3.8:27b
#     (idle) — answering you: qwen3:8b"): round 1's before-wins corrected
#     those true lines against the idle model listed before the label. The
#     ref after is the label's value when only a size, a badge or closing
#     punctuation follows it to the clause's end; when anything else does
#     ("✅ in use: qwen3.8:27b is idle", "in use: qwen3:8b on hub", "in use:
#     qwen3.8:27b (idle)") the marker may be said of either, so it binds
#     nothing unless both name the same model.
#
# S40b final fix wave (D2): each repetition below is UNAMBIGUOUS. A starred
# alternation takes whitespace ONE character at a time (never `\s+`, whose
# runs split 2^(n-1) ways), the size's own quantifiers are possessive, and the
# star itself is possessive (`*+`). Written as `(?:\s+|…)*` it backtracked
# exponentially when the fullmatch failed: a padded markdown table row —
# "| qwen3:8b             | 4.9 GB   | loaded, in use |" — took 15.7 s at
# 20-wide columns and hours at 24, blocking core's only event loop. Nothing
# that can end a gap or a label is a character the star consumes, so giving
# none back changes no verdict. Pinned in test_guard_regex_timing.
_IN_USE_SIZE = r"\d[\d.,]*+\s*+[KMGT]i?B\b"
_IN_USE_BADGE = rf"(?:\s|\([^()\n]{{1,40}}\)|{_IN_USE_SIZE}|[(|:=✅✔☑⭐←⬅—–-]|️)"
_IN_USE_BEFORE_GAP = re.compile(
    rf"{_IN_USE_BADGE}*+"
    r"(?P<copula>(?:is|['’]s)\s+(?:currently\s+|now\s+)?(?:the\s+)?(?:(?:chat\s+)?(?:model|one)\s+)?)?",
    re.I,
)
# `(?<!\s)`: both call sites start at `_IN_USE`'s end, which is always just
# after a word character, so it never changes a verdict there; it makes
# `.search` give up at once inside a whitespace run instead of re-walking the
# rest of it from every start (quadratic: 58 ms at 1,500 spaces on CI's
# runner, over the timing sweep's 50 ms budget).
_IN_USE_AFTER_GAP = re.compile(
    r"(?<!\s)(?:\s+(?:right\s+now|now|currently))?(?:\s*[:=]\s*|\s+(?:is|['’]s)\s+)", re.I
)
# What may follow the label's ref for it to close the label: a size, bare or
# bracketed, a badge, a bar, a dash, closing punctuation. A WORDED bracket
# says something of the ref ("in use: qwen3.8:27b (idle)"), so it does not.
_IN_USE_LABEL_ENDS = re.compile(
    rf"(?:\s|\(\s*+{_IN_USE_SIZE}\s*+\)|{_IN_USE_SIZE}|[|:=✅✔☑⭐←⬅—–.,;!-]|️)*+", re.I
)
#   * A label whose VALUE says no ("— in use: no", "current model: ❌") says
#     the model before it is NOT in use (found fixing round 2; it fired at
#     4c62f5c9 and e102b80b alike).
_IN_USE_DENIED = re.compile(
    r"(?<!\s)(?:\s+(?:right\s+now|now|currently))?\s*[:=]\s*(?:no|none|false|❌|✗|✘|✖)(?!\w)",
    re.I,
)


# S40b T4 review, fix round 1: what she says ABOUT a claim, before it. The v15
# case seeds the walk's false "Current model in use" and memory lines as her
# own history, and the answer it hopes for corrects them. Both guards
# corrected that correction, reading the claim inside "I don't think …", "It's
# false that …", "My previous answer said …" and "I told you …, which was
# wrong" as hers. These cuts are the served and memory guards' own, read on
# the prefix of each claim's match within its clause: the shared _STATE_HEDGE
# was measured over the machine and device corpus, and is not re-measured.
#   * A doubted or denied belief. "Not sure WHY X" presupposes X, and "no
#     doubt X" asserts it, so both still fire (_WH_WORD, with the history
#     label's regexes above).
_EPISTEMIC_FRAME = re.compile(
    r"\b(?:do|does|did)\s*n['’]?o?t\s+(?:think|believe)\b"
    rf"|\bnot\s+(?:sure|certain)\b{_WH_WORD}"
    rf"|\bun(?:sure|certain)\b{_WH_WORD}"
    r"|(?<!\bno\s)(?<!\bwithout\s)(?<!\bbeyond\s)(?<!\ba\s)\bdoubt(?:s|ed)?\b"
    r"|(?:\bnot|n['’]t)\s+true\s+(?:to\s+say\s+)?that\b"
    r"|\b(?:untrue|false|wrong)\s+(?:to\s+say\s+)?that\b"
    # S40b final fix wave (A8): a DENIAL frame — "It's not that X", "It isn't
    # the case that X", "Nothing says X", "No sign/evidence (that) X". The
    # negation is required: "It is the case that X" asserts X.
    r"|\bit(?:['’]s|\s+is)\s+not\s+(?:that|the\s+case\s+that)\b"
    r"|\bit\s+isn['’]t\s+(?:that|the\s+case\s+that)\b"
    r"|\b(?:nothing|no\s+(?:sign|evidence|indication|reason\s+to\s+think))"
    r"(?:\s+(?:says|suggests|indicates|shows|means))?(?:\s+that)?\s*$",
    re.I,
)
#   * A first-person retraction verb: "I wrongly said", "I mistakenly marked".
#   * Her earlier reply, LABELLED as the claim's source (_history_framed; fix
#     round 2 — round 1 cut on any mention of it, so "As I said in my last
#     reply, X" and "Correction to my last reply: X" went silent).
_HER_RETRACTION = re.compile(
    r"(?<![\w'’])I\s+(?:wrongly|mistakenly|incorrectly|falsely)\s+"
    r"(?:said|claimed|stated|marked|wrote|reported|told\s+you)\b",
    re.I,
)
#   * A bare "I said X" or "I told you X" is a reassertion, unless she retracts
#     it in what follows, in the same sentence or the next: "I told you X,
#     which was wrong." / "I said X. That was stale." / "… — it isn't." "As I
#     said" and "like I told you" are reassertions whatever follows.
_HER_SAYING = re.compile(
    r"(?<![\w'’])(?<!\bas\s)(?<!\blike\s)I\s+"
    r"(?:said|wrote|stated|claimed|reported|marked|told\s+you)\b",
    re.I,
)


def _clauses_with_rest(line: str):
    """_clauses, each with what follows it: the rest of its sentence and the
    next sentence on the line — where she retracts what she just said."""
    sentences = [s for s in _sentences(line) if s.strip()]
    for i, sentence in enumerate(sentences):
        is_question = sentence.rstrip().endswith("?")
        following = sentences[i + 1] if i + 1 < len(sentences) else ""
        for clause, rest in _split_clauses(sentence):
            if clause.strip():
                yield clause, is_question, rest + following


# S40b final fix wave (C16): a GENERAL statement — "Whenever the memory service
# is unreachable, …", "Any time qwen3.8:27b is in use, …" — asserts nothing
# about now. These subordinators are missing from the shared _STATE_HEDGE,
# which was measured over the device and machine corpus and is not
# re-measured here; the served and memory guards read them beside it.
_GENERAL_HEDGE = re.compile(
    r"\b(?:whenever|any\s*time|every\s+time|each\s+time|in\s+the\s+event)\b", re.I
)


def _claim_prefix_blocks(before: str) -> bool:
    """_state_prefix_blocks, and a general statement (_GENERAL_HEDGE): the
    served and memory guards' hedge cut on what leads up to a claim."""
    return _state_prefix_blocks(before) or _GENERAL_HEDGE.search(before) is not None


def _not_her_claim(before: str, tail: str, rest: str = "") -> bool:
    """Does what surrounds a served or memory claim say she does not assert it
    now? Leading up to it in its clause (`before`): a doubted belief or a
    denial, a retraction verb, his notes named as its source (A4), or her
    earlier reply labelled as its source — none reaffirmed in what follows.
    Right after it in its clause (`tail`, S40b final fix wave A12, as the
    machine branch reads it): a history attribution ("(from my last answer)")
    or a retraction ("(incorrect)", "— this was wrong"). Or an "I said" she
    retracts in what follows (`tail` + `rest`)."""
    after = tail + rest
    if _EPISTEMIC_FRAME.search(before) or _HER_RETRACTION.search(before):
        return True
    if _record_attributed(before, after):
        return True
    if _history_framed(before, tail, after):
        return True
    if _retracted_in_tail(tail):
        return True
    return _HER_SAYING.search(before) is not None and _RETRACTED.search(after) is not None


@dataclass(frozen=True)
class ServedClaim:
    """A claim about which model wrote this reply that the turn's own rounds
    contradict.

    `shape` is how it was said ("sentence", "in_use" or "no_model"), `claimed`
    the model reference named (None for "no model"), `served` every model the
    gateway recorded serving a round of this turn, `phrase` the matched text
    for the guard span, and `text` the stated correction.
    """

    shape: str
    claimed: str | None
    served: tuple[str, ...]
    phrase: str
    text: str


def _served_models(spans: Sequence[Any]) -> tuple[str, ...]:
    """Every `served_by` on an error-free llm_call of this turn, any purpose,
    in order and deduplicated: the models the gateway says answered a round."""
    found: list[str] = []
    for span in spans:
        if getattr(span, "kind", None) != "llm_call":
            continue
        meta = _span_meta(span)
        served_by = meta.get("served_by")
        if meta.get("error") or not isinstance(served_by, str) or not served_by.strip():
            continue
        if served_by.strip() not in found:
            found.append(served_by.strip())
    return tuple(found)


def _own_lines(reply_text: str) -> list[str]:
    """The reply's lines as a claim scan reads them: fenced and `>` lines
    blanked (someone else's text), emphasis and code marks stripped. The
    machine branch's reading of a reply (_machine_lines), shared."""
    return _machine_lines(reply_text)


def _conjunct(clause: str, start: int, end: int) -> tuple[int, int]:
    """The bounds of the coordinated conjunct holding clause[start:end]."""
    lo, hi = 0, len(clause)
    for c in _IN_USE_CONJUNCT.finditer(clause):
        if c.end() <= start:
            lo = c.end()
        elif c.start() >= end:
            hi = c.start()
            break
    return lo, hi


def _in_use_ref(clause: str, marker: re.Match[str], lo: int, hi: int) -> re.Match[str] | None:
    """The model ref an in-use marker is SAID of, within its conjunct
    clause[lo:hi], or None (see _IN_USE_BEFORE_GAP). Never merely the nearest
    ref.

    * The last ref BEFORE the marker, when only copula, parenthetical or
      badge material separates them. A marker with a ref before it across
      anything else is that ref's predicate, however many words sit between
      ("hub:qwen3:8b is, right now, the model in use: qwen3.8:27b is idle"),
      so it binds nothing.
    * The first ref AFTER it, when the marker labels or is the subject of it
      ("Current model: X") and no ref comes before it.
    * Both: a copula keeps the ref before (the marker is its predicate); a
      badge makes the marker a label, which names the ref after — when that
      ref closes the label (only a size, a badge or closing punctuation
      follows it to the clause's end — see _IN_USE_LABEL_ENDS), or names the
      same model as the ref before."""
    refs = [r for r in _SERVED_REF_RE.finditer(clause) if r.start() >= lo and r.end() <= hi]
    before = [r for r in refs if r.end() <= marker.start()]
    after = [r for r in refs if r.start() >= marker.end()]
    label = (
        after[0]
        if after and _IN_USE_AFTER_GAP.fullmatch(clause, marker.end(), after[0].start())
        else None
    )
    if not before:
        return label
    gap = _IN_USE_BEFORE_GAP.fullmatch(clause, before[-1].end(), marker.start())
    if gap is None:
        return None
    if gap.group("copula") or label is None:
        return before[-1]
    if _IN_USE_LABEL_ENDS.fullmatch(clause, label.end()):
        return label
    said, other = label.group("ref"), before[-1].group("ref")
    return label if _same_model(said, other) and _same_model(other, said) else None


def _served_claims(clause: str, *, in_use: bool, rest: str = ""):
    """(shape, claimed ref or None, phrase) for every served-model claim this
    clause makes, each already cut by the hedge, intent and skip rules, and by
    what she says about it (_not_her_claim; `rest` is what follows the clause)."""
    for pattern in _SERVED_SENTENCES:
        for m in pattern.finditer(clause):
            if _claim_prefix_blocks(clause[: m.start()]):
                continue
            if _not_her_claim(clause[: m.start()], clause[m.end() :], rest):
                continue
            if _SERVED_SKIP.search(clause[: m.end()]) or _SERVED_SETTING.search(clause[: m.end()]):
                continue
            if pattern is _SERVED_ANSWERING and (
                _IN_USE_LIMITED.match(clause, m.end()) or _SERVED_SKIP.search(clause[m.end() :])
            ):
                continue
            yield "sentence", _strip_trailing_punct(m.group("ref")), m.group(0)
    if in_use:
        for m in _IN_USE.finditer(clause):
            if _STATE_HEDGE.search(clause) or _STATE_INTENT.search(clause[: m.start()]):
                continue
            if _GENERAL_HEDGE.search(clause):
                continue
            if _SERVED_SKIP.search(clause) or _SERVED_SETTING.search(clause):
                continue
            if _IN_USE_LIMITED.match(clause, m.end()) or _IN_USE_DENIED.match(clause, m.end()):
                continue
            lo, hi = _conjunct(clause, m.start(), m.end())
            said = _in_use_ref(clause, m, lo, hi)
            if said is None:
                continue
            # What leads up to the pair, within its conjunct: the words before
            # the ref ("make X the current model") and between the two.
            if said.end() <= m.start():
                lead = clause[lo : m.start()]
            else:
                lead = clause[m.end() : said.start()]
            if _IN_USE_UNSAID.search(lead):
                continue
            start, end = min(said.start(), m.start()), max(said.end(), m.end())
            if _not_her_claim(clause[:start], clause[end:], rest):
                continue
            yield "in_use", _strip_trailing_punct(said.group("ref")), clause[start:end]
    for m in _NO_MODEL.finditer(clause):
        if _claim_prefix_blocks(clause[: m.start()]):
            continue
        if _not_her_claim(clause[: m.start()], clause[m.end() :], rest):
            continue
        yield "no_model", None, m.group(0)


def served_claim_check(
    reply_text: str, spans: Sequence[Any], *, purpose: str | None
) -> ServedClaim | None:
    """Contradict a claim about which model wrote this reply that the turn's
    own rounds refute (see the section header). None otherwise — pure,
    precision-first, fail-open at the call site. `purpose` is the turn's kind
    (traces.purpose_of); outside STACK_CLAIM_KINDS it says nothing.

    A NAMED claim fires when the model named served no round of this turn,
    some round was stamped, and the round that WROTE the reply (_reply_served_
    by) was stamped too: the correction quotes that round, and when it carries
    no stamp the claimed model may be the very one that wrote it. "No model"
    fires on any round of the turn's own purpose that answered."""
    if purpose not in STACK_CLAIM_KINDS:
        return None
    if not reply_text or not reply_text.strip():
        return None
    served = _served_models(spans)
    answered = served_this_turn(spans, purpose)
    if not served and not answered:
        return None
    writer = _reply_served_by(spans, purpose)
    for line in _own_lines(reply_text):
        if not line.strip():
            continue
        label = _LINE_LABEL.match(line)
        in_use = label is None or _LABEL_OK.fullmatch(label.group("label").strip()) is not None
        for clause, is_question, rest in _clauses_with_rest(line):
            if is_question or _REPORTED.search(clause) or _PRIOR_TIME.search(clause):
                continue
            for shape, claimed, phrase in _served_claims(clause, in_use=in_use, rest=rest):
                phrase = _strip_trailing_punct(phrase.strip())
                claim = _served_verdict(shape, claimed, phrase, served, writer, answered)
                if claim is not None:
                    return claim
    return None


def _served_verdict(
    shape: str,
    claimed: str | None,
    phrase: str,
    served: tuple[str, ...],
    writer: str | None,
    answered: bool,
) -> ServedClaim | None:
    if claimed is None:
        # S40b final fix wave (C3): silent when the round that wrote the reply
        # carries no served-by header — the verdict's §4 MUST_NOT ("any
        # MUST_FIRE sentence with no served_by") over its evidence line, as
        # the ledger ruled: the guard says only what it can quote.
        if not answered or writer is None:
            return None
        text = SERVED_NO_MODEL_CORRECTION.format(served=writer)
        return ServedClaim(shape=shape, claimed=None, served=served, phrase=phrase[:80], text=text)
    if not served or writer is None:
        return None
    compared = _claimed_as_served(claimed)
    if any(_same_model(compared, model) for model in served):
        return None
    return ServedClaim(
        shape=shape,
        claimed=claimed,
        served=served,
        phrase=phrase[:80],
        text=SERVED_CLAIM_CORRECTION.format(served=writer, claimed=claimed),
    )


# ── S40b: the MEMORY-outage claim — "memory is unreachable" while it answered ──
#
# The same walk: b851aa91 and b02a5694 reported "The memory service (`memory`)
# is currently unreachable (`ConnectError`)" — an outage from some earlier
# moment, stated as now — in turns whose own recall that service had just
# answered (hits: 5). The evidence is the turn's memory_recall span: an int `hits` with no
# `error`, and `errors` (an agent's two-scope recall) not naming every scope —
# zero hits is an answer. Or a memory tool whose ok means memory answered
# (_MEMORY_ANSWER_TOOLS) that succeeded this turn. A memory_* tool that FAILED
# this turn is evidence the report may be true, so the guard says nothing
# then; and with no recall span it has nothing to go on.
#
# Precision-first, like its siblings: a service NOUN is required ("memory"
# alone is also RAM, GPU memory and her recall), "down" counts only where it
# ends the claim ("down for maintenance tonight" is a schedule), negations are
# not outage claims, and past, hedged, reported, quoted and questioned forms
# assert nothing about now. APPEND-class and not ingested, like served_claim;
# armed only in STACK_CLAIM_KINDS.

MEMORY_CLAIM_CORRECTION = (
    "Correction: the memory service answered this turn — this turn's recall was read from "
    "it — so it is not unreachable now."
)
# When no recall answered but a memory tool did: the correction names the call
# that proves it, never a recall that did not happen.
MEMORY_CLAIM_TOOL_CORRECTION = (
    "Correction: the memory service answered this turn — this turn's {tool} call was "
    "answered by it — so it is not unreachable now."
)
MEMORY_CLAIM_MISSING = " What did not work this turn: {retrievers_missing}"
# Every memory tool is named memory_* (app/tools/memory_tools.py) — the prefix
# IS the derivation, like _DEVICE_SPAN_PREFIX. test_memory_claim_guard pins it
# against the registry.
_MEMORY_TOOL_PREFIX = "memory_"
_MEMORY_RECALL_KIND = "memory_recall"
# T2 review, round 1: which memory tools' ok MEANS memory answered. The prefix
# alone counted memory_backfill, whose ok means distillation ran: a failed
# /export is a stated limit and failed saves are collected, and it still
# returns ran=True — so in the turn memory really was down, the guard said
# "this turn's memory_backfill call was answered by it". memory_search and
# memory_save (and memory_forget, 2026-10-06) go through _call_memory, which
# raises on anything but a 200, so their ok is memory's answer. Every tool
# memory_tools defines is on exactly one side, and test_memory_claim_guard pins
# the partition against memory_tools.TOOLS: a new memory tool turns it red
# rather than defaulting into the evidence. A FAILED memory_* tool of either
# side still silences the guard (the prefix): a failure is evidence the report
# may be true.
_MEMORY_ANSWER_TOOLS = frozenset({"memory_search", "memory_save", "memory_forget"})
_MEMORY_RAN_NOT_ANSWERED = frozenset({"memory_backfill"})

_MEMORY_NOUN = (
    r"(?:(?:the|my|your|her|its|nova['’]s)\s+)?(?:long[-\s]term\s+)?memory\s+"
    r"(?:service|server|container|backend|api|store|database)"
)
# T2 precision cut, beyond the verdict's corpus: every outage word ENDS the
# claim, as the verdict's "down" already must — at punctuation (a bracketed
# reason included: the walk's "unreachable (`ConnectError`)"), a present-time
# phrase, or a connector (the machine guard's anchors, T1). "The memory service
# is unreachable from outside the tailnet", "… offline for maintenance
# tonight", "… unavailable to agents", "… disconnected from the internet" and
# "… offline-capable" limit the state to a place, a schedule, a subject or a
# property — each true, none contradicted by a recall — and were corrected by
# the verbatim pattern. Pinned in test_memory_claim_guard.
_MEMORY_OUTAGE_ANCHOR = rf"(?=\s*\(|{_ANCHOR_ENDS}|\s+(?:{_OUTAGE_ENDS}))"
# S40b final fix wave (C5): "down" takes the bracket anchor the other outage
# words have, so the walk's shape with a bracketed reason fires in either word:
# "down (`ConnectError`)".
_MEMORY_STATE = (
    r"(?:(?:unreachable|not\s+reachable|offline|unavailable|not\s+responding|unresponsive"
    rf"|not\s+answering|disconnected){_MEMORY_OUTAGE_ANCHOR}"
    r"|down(?=\s*\(|\s*(?:[.,;:!?)\]]|$)|\s+(?:right\s+now|now|again|at\s+the\s+moment)\b))"
)
# …but a bracket that LIMITS the state is not its reason (C5): "(by design)",
# "(for maintenance tonight)", "(on weekends)", "(from outside the tailnet)".
_LIMITING_BRACKET = re.compile(
    r"\s*+\(\s*+(?:by\s+design|on\s+purpose|intentionally|deliberately|planned|scheduled"
    r"|for\s+(?!now\b|the\s+moment\b|the\s+time\s+being\b)"
    rf"|{_TRAILING_LIMIT})",
    re.I,
)
# S40b final fix wave (A7): the memory noun must be the outage's SUBJECT. As
# the object of a part-of preposition or a partitive — "semantic search IN the
# memory service is unavailable", "part OF the memory service" — the outage is
# something else's: her honest account of a degraded recall, the very state
# the correction's "What did not work" suffix reports. Never "to" or "with":
# "Access to the memory service is unavailable" says she cannot reach it.
_MEMORY_NOT_THE_SUBJECT = re.compile(r"\b(?:of|in|on|from|within|inside|behind)\s*$", re.I)
_MEMORY_DOWN = re.compile(
    rf"\b(?P<subj>{_MEMORY_NOUN})(?:\s*\([^()\n]{{1,40}}\))?"
    rf"(?:\s+{_PRESENT_COPULA}|['’]s)(?:\s+{_SERVING_ADVERB})*\s+(?P<state>{_MEMORY_STATE})\b",
    re.I,
)
# T2 review, round 1: the verdict's can't-reach form never read WHO cannot
# reach memory, and nothing ended its object, so true architecture statements
# were corrected: "You can't reach the memory service from outside the
# tailnet", "Your phone can't reach the memory service directly; it goes
# through core" — the same claim Deviation 4 pins as honest in the
# "unreachable from outside the tailnet" form. It is her outage claim only in
# the first person (I, we) or with no subject at all ("Can't reach the memory
# service right now."), and its object ends the way _MEMORY_DOWN's outage words
# do, so "directly", "from outside" and "from your phone" end it as a route.
# The claim (the span's phrase) starts at "I"/"we", or at the verb when the
# clause opens on it — a list mark before it is not part of what she said.
_MEMORY_UNREACHED = re.compile(
    r"(?:^\s*(?:(?:[-+•]|\d+[.)])\s*)?|(?<![\w'’-])(?=(?:I|we)\b))"
    r"(?P<claim>(?:(?:I|we)(?:['’]m|['’]re|\s+am|\s+are)?\s+)?"
    r"(?:(?:still|currently|now|just|simply|really|also)\s+)*"
    r"(?:can\s*(?:no|['’])?t|cannot|can\s+not|unable\s+to)\s+"
    r"(?:reach|contact|connect\s+to|talk\s+to|get\s+(?:a\s+)?(?:response|answer)\s+from)\s+"
    rf"(?P<subj>{_MEMORY_NOUN})){_MEMORY_OUTAGE_ANCHOR}",
    re.I,
)


@dataclass(frozen=True)
class MemoryClaim:
    """A present-tense claim that the memory service cannot answer, in a turn
    it answered. `subject` is the noun the reply used, `phrase` the matched
    text, `retrievers_missing` memory's own sentence about a search it could
    not run in full this turn (the true half of an outage report), and `text`
    the stated correction."""

    subject: str
    phrase: str
    text: str
    retrievers_missing: str | None = None


def _recall_answered(span: Any) -> bool:
    if getattr(span, "kind", None) != _MEMORY_RECALL_KIND:
        return False
    meta = _span_meta(span)
    hits = meta.get("hits")
    if not isinstance(hits, int) or isinstance(hits, bool) or meta.get("error"):
        return False
    errors = meta.get("errors")
    if errors:
        scopes = meta.get("scopes")
        if not isinstance(errors, Mapping) or not isinstance(scopes, Mapping) or not scopes:
            return False  # a failure this span cannot place: not an answer
        if all(scope in errors for scope in scopes):
            return False
    return True


def _went_to_memory(span: Any) -> bool:
    """Did this memory tool call send its request through the door
    (memory_tools.MEMORY_CALL_FACT on the span's facts), whatever came back?
    Imported inside the call because app.tools imports this module."""
    from app.tools import memory_tools

    facts = _span_meta(span).get("facts")
    return isinstance(facts, list) and any(
        isinstance(fact, dict) and memory_tools.MEMORY_CALL_FACT in fact for fact in facts
    )


def _memory_answered(spans: Sequence[Any]) -> tuple[Any, str | None] | None:
    """(the recall span that answered or None, the memory tool that answered
    or None) — None when memory did not answer this turn, or when a memory
    tool failed this turn (one through the door only if it reached it)."""
    recall = None
    tool: str | None = None
    for span in spans:
        if recall is None and _recall_answered(span):
            recall = span
            continue
        name = getattr(span, "name", None)
        if getattr(span, "kind", None) != "tool" or not isinstance(name, str):
            continue
        if not name.startswith(_MEMORY_TOOL_PREFIX):
            continue
        if _span_meta(span).get("ok") is not True:
            # S40b final fix wave (C15): a call through the one door that never
            # reached it — refused by the schema, for want of an identity, or
            # by a live-source check — is her own malformed call, not evidence
            # memory is down. The door records every request it sends.
            if name in _MEMORY_ANSWER_TOOLS and not _went_to_memory(span):
                continue
            return None
        if name in _MEMORY_ANSWER_TOOLS:
            tool = tool or name
    if recall is None and tool is None:
        return None
    return recall, tool


def memory_claim_check(
    reply_text: str, spans: Sequence[Any], *, purpose: str | None
) -> MemoryClaim | None:
    """Contradict a present-tense claim that the memory service cannot answer,
    made in a turn it answered (see the section header). None otherwise —
    pure, precision-first, fail-open at the call site. `purpose` is the turn's
    kind; outside STACK_CLAIM_KINDS it says nothing."""
    if purpose not in STACK_CLAIM_KINDS:
        return None
    if not reply_text or not reply_text.strip():
        return None
    evidence = _memory_answered(spans)
    if evidence is None:
        return None
    recall, tool = evidence
    for line in _own_lines(reply_text):
        if not line.strip():
            continue
        for clause, is_question, rest in _clauses_with_rest(line):
            if is_question or _REPORTED.search(clause) or _PRIOR_TIME.search(clause):
                continue
            for pattern in (_MEMORY_DOWN, _MEMORY_UNREACHED):
                for m in pattern.finditer(clause):
                    if _claim_prefix_blocks(clause[: m.start()]):
                        continue
                    # A scope fronted or following (A5), a limiting bracket
                    # (C5), or the noun as a preposition's object (A7).
                    if _FRONTED_SCOPE.match(clause[: m.start()]) or _LIMITED_AFTER.match(
                        clause, m.end()
                    ):
                        continue
                    if _LIMITING_BRACKET.match(clause, m.end()):
                        continue
                    if pattern is _MEMORY_DOWN and _MEMORY_NOT_THE_SUBJECT.search(
                        clause[: m.start()]
                    ):
                        continue
                    if _not_her_claim(clause[: m.start()], clause[m.end() :], rest):
                        continue
                    if _SERVED_SKIP.search(clause[: m.end()]):
                        continue
                    return _memory_claim(m, recall, tool)
    return None


def _memory_claim(match: re.Match[str], recall: Any, tool: str | None) -> MemoryClaim:
    missing = _span_meta(recall).get("retrievers_missing") if recall is not None else None
    missing = missing.strip() if isinstance(missing, str) and missing.strip() else None
    if recall is not None:
        text = MEMORY_CLAIM_CORRECTION
    else:
        text = MEMORY_CLAIM_TOOL_CORRECTION.format(tool=tool)
    if missing:
        text += MEMORY_CLAIM_MISSING.format(retrievers_missing=missing)
    said = match.group("claim") if "claim" in match.re.groupindex else match.group(0)
    return MemoryClaim(
        subject=match.group("subj").strip(),
        phrase=said.strip()[:80],
        text=text,
        retrievers_missing=missing,
    )


# -- the MCP server claims (S37a) ------------------------------------------------
#
# Two append-only checks over HER reply at the end of the turn, in the
# said-not-done shape (fix round 3, 2026-09-29): a false fire costs one true
# sentence, never an action. Both are DERIVED from the live list of connected
# servers the turn read once (chat._mcp_server_refs), never a list kept here,
# and neither reads the owner's message (ruling 2026-09-27).
#
#   * server_denial_check — "I can't access GitHub" while GitHub is connected.
#     Silent when that server's last call failed (its row, or a failed mcp_*
#     span for it this turn): then the sentence is true. Silent on a question,
#     a hedge, a past attempt, and a denial qualified as a present state.
#     "I can’t" (U+2019) is read as "I can't" (ruling F18).
#   * server_claim_check — "I checked GitHub", "according to GitHub", "GitHub
#     shows …" when no call to that server was ANSWERED this turn: an ok
#     mcp_* span, or the server's own isError answer (ruling T7-E: the tool's
#     answer, never a failing server). An ok live read whose arguments name
#     the server backs it too (she fetched github.com), and a recap marked as
#     earlier is left alone (plan decision P16). The sentence says only what
#     the record shows (#90's T3): no call ran, or calls ran and none
#     succeeded — never "no call ran" beside one that did.
#
# #90's rules hold for both (ruling F5): a turn whose delegation may have run
# an agent is left alone (_a_delegation_ran — the agent's calls are on ITS
# turn), and a call dispatch refused before its executor (`reached_executor`
# False) reached nothing, so it is neither a failed call nor a call that ran.
# The third, the persona's own toolset, is the caller's: chat hands
# server_denial_check no servers unless the persona holds mcp_call.


@dataclass(frozen=True)
class McpServerRef:
    """A connected MCP server as the guards see it: its connection name, the
    words that name it in prose (lowercase), and whether its last call failed."""

    name: str
    words: tuple[str, ...]
    failing: bool = False


@dataclass(frozen=True)
class ServerClaimFound:
    """One MCP server claim: which server, the words that made it, and the one
    sentence the turn appends."""

    server: str
    phrase: str
    text: str


_MCP_TOOL_NAMES = frozenset({"mcp_call", "mcp_tools", "mcp_connect"})
# Read only to drop a server she REMOVED this turn (fix round 1, item 1): a
# disconnect is not a call to the server, but the server is gone after it.
_MCP_DISCONNECT = frozenset({"mcp_disconnect"})
_SERVER_ACCESS = (
    r"(?:access|reach|connect\s+to|use|query|get\s+(?:in)?to|talk\s+to|read\s+from|see)"
)
_SERVER_DETERMINER = r"(?:(?:my|your|the)\s+)?"
_SERVER_READ_VERB = r"(?:checked|looked\s+(?:at|into)|queried|pulled|fetched|read|searched)"
_SERVER_SAYS = r"(?:shows|says|reports|lists|confirms|indicates)"
_SERVER_PRESENT_STATE = re.compile(
    r"\b(?:right\s+now|at\s+the\s+moment|currently|for\s+now|at\s+present|today|until|unless"
    r"|because|since|while|anymore|any\s+more)\b",
    re.I,
)
_SERVER_EARLIER = re.compile(
    r"\b(?:earlier|before|previously|yesterday|last\s+time|this\s+morning|a\s+while\s+ago)\b",
    re.I,
)


# Fix round 1, M3: room for every server a household could connect. The
# guards fetch each server's patterns once per reply, before the clauses;
# looked up per clause past 128 servers, every lookup evicted the next one
# and rebuilt it (34 s for a 5 KB reply).
@lru_cache(maxsize=1024)
def _server_patterns(
    words: tuple[str, ...],
) -> tuple[re.Pattern[str], re.Pattern[str], re.Pattern[str], re.Pattern[str]]:
    """(after a denial lead, the name alone, a first-person read, an
    attribution) for one server's words. Built per server set and cached, and
    swept by tests/test_guard_regex_timing.py like the per-machine builders.
    Every alternative is an escaped literal, so the patterns stay linear.

    `after_lead` is only ever MATCHED at a lead's end, which follows a letter;
    the lookbehind for a non-space and the possessive runs keep a search over
    it linear too (ruling F2: the plain optional-whitespace form walked a run
    of padding from each of its positions — 271 ms at 1,500 characters)."""
    alt = "|".join(re.escape(w) for w in sorted(set(words), key=len, reverse=True))
    name = rf"{_SERVER_DETERMINER}(?:{alt})\b"
    after_lead = re.compile(rf"(?<!\s)\s*+(?:{_SERVER_ACCESS}\s++)?{name}", re.I)
    named = re.compile(name, re.I)
    read = re.compile(rf"\bI(?:['’]ve|\s+have)?\s+(?:just\s+)?{_SERVER_READ_VERB}\s+{name}", re.I)
    said = re.compile(
        rf"\b(?:according\s+to|per)\s+{name}|\b(?:{alt})(?:['’]s\s+\w+)?\s+{_SERVER_SAYS}\b",
        re.I,
    )
    return after_lead, named, read, said


def _mcp_spans(
    spans: Sequence[Any], tool_names: frozenset[str] = _MCP_TOOL_NAMES
) -> Iterator[tuple[Mapping[str, Any], set[str]]]:
    """(meta, the servers it names) for each mcp_* span that REACHED its
    executor — from its facts, and from its own arguments. A call dispatch
    refused first (`reached_executor` False: unreadable arguments, no such
    tool) reached nothing, so it says nothing about a server (ruling F5); an
    absent key is "not recorded", never "not reached" (#90's M-2). A call
    REFUSED before dispatch (`refused_*`: written as markup, a closed round)
    never ran at all (fix round 1, M2 — chat._tool_outcomes' house rule)."""
    for span in spans:
        if getattr(span, "kind", None) != "tool":
            continue
        if getattr(span, "name", None) not in tool_names:
            continue
        meta = getattr(span, "meta", None) or {}
        if meta.get("reached_executor") is False:
            continue
        if any(str(key).startswith("refused_") for key in meta):
            continue
        named: set[str] = set()
        for fact in meta.get("facts") or ():
            if isinstance(fact, dict) and isinstance(fact.get("mcp_server"), str):
                named.add(fact["mcp_server"])
        args = meta.get("args_redacted")
        if isinstance(args, dict):
            for key in ("server", "name"):
                if isinstance(args.get(key), str):
                    named.add(args[key])
        yield meta, named


def _mcp_servers_in(spans: Sequence[Any], *, ok: bool) -> set[str]:
    """The servers an mcp_* call that reached its executor named this turn,
    among the calls whose `ok` is the one asked for."""
    names: set[str] = set()
    for meta, named in _mcp_spans(spans):
        if bool(meta.get("ok")) is ok:
            names |= named
    return names


def _mcp_servers_disconnected(spans: Sequence[Any]) -> set[str]:
    """The servers an ok mcp_disconnect removed this turn (fix round 1, item 1).
    Gone, whatever list the guards were handed: neither "X is connected" nor
    "no call to X ran" can be said beside her removing it."""
    names: set[str] = set()
    for meta, named in _mcp_spans(spans, _MCP_DISCONNECT):
        if meta.get("ok"):
            names |= named
    return names


def _mcp_servers_answered(spans: Sequence[Any]) -> set[str]:
    """The servers that ANSWERED a call this turn: an ok mcp_* call, or one
    the server answered with its tool's own error. Dispatch records an isError
    answer as a failed call, but it is the tool's answer, never a failing
    server (ruling T7-E) — "GitHub says that run does not exist" relays it."""
    answered: set[str] = set()
    for meta, named in _mcp_spans(spans):
        if meta.get("ok"):
            answered |= named
            continue
        for fact in meta.get("facts") or ():
            if (
                isinstance(fact, dict)
                and fact.get("is_error") is True
                and isinstance(fact.get("mcp_server"), str)
            ):
                answered.add(fact["mcp_server"])
    return answered


def _live_read_arguments(spans: Sequence[Any]) -> str:
    """The lowercased arguments of every ok live read this turn — a web fetch, a
    search, a device read — to look for the words that name a server. Imported
    inside the call because app.tools imports this module (_spend_tools' rule)."""
    from app import tools

    readers = set(tools.live_reading_tool_names())
    parts = []
    for span in spans:
        meta = getattr(span, "meta", None) or {}
        if (
            getattr(span, "kind", None) == "tool"
            and getattr(span, "name", None) in readers
            and meta.get("ok")
        ):
            parts.append(str(meta.get("args_redacted")).lower())
    return " ".join(parts)


def server_denial_check(
    reply_text: str, spans: Sequence[Any], servers: Sequence[McpServerRef]
) -> ServerClaimFound | None:
    """A first-person, present denial of a CONNECTED server — "I don't have
    access to GitHub" — answered with one appended sentence. Pure;
    precision-first: a denial the facts make true is left alone."""
    if not reply_text or not reply_text.strip() or not servers:
        return None
    if _a_delegation_ran(spans):
        return None  # the agent's calls are on its own turn (#90, ruling F5)
    failed_now = _mcp_servers_in(spans, ok=False) | _mcp_servers_disconnected(spans)
    # Whose denial would be false, decided once for the reply, not per clause,
    # each with its patterns fetched once (M3).
    candidates = [
        (server, _server_patterns(server.words))
        for server in servers
        if not server.failing and server.name not in failed_now and server.words
    ]
    if not candidates:
        return None
    # Ruling F18: the lead family reads an apostrophe; "I can’t" is "I can't".
    # One character for one, so every position is where it was.
    text = reply_text.replace("\u2019", "'")
    for clause, is_question in _clauses(text):
        if is_question or _SERVER_PRESENT_STATE.search(clause):
            continue
        lead = _DENIAL_LEAD.search(clause)
        trailing = _TRAILING_DENIAL.search(clause)
        if lead is None and trailing is None:
            continue
        for server, (after_lead, named, _read, _said) in candidates:
            hit = after_lead.match(clause, lead.end()) if lead is not None else None
            if hit is None and trailing is not None:
                hit = named.search(clause, 0, trailing.start())
            if hit is None:
                continue
            return ServerClaimFound(
                server=server.name,
                phrase=clause.strip()[:120],
                text=f"({server.name} is connected: mcp_call can reach it.)",
            )
    return None


def server_claim_check(
    reply_text: str, spans: Sequence[Any], servers: Sequence[McpServerRef]
) -> ServerClaimFound | None:
    """A first-person read of, or an attribution to, a connected server that
    answered no call this turn — answered with one appended sentence that says
    what the record shows. Pure."""
    if not reply_text or not reply_text.strip() or not servers:
        return None
    if _a_delegation_ran(spans):
        return None  # the agent's calls are on its own turn (#90, ruling F5)
    answered = _mcp_servers_answered(spans) | _mcp_servers_disconnected(spans)
    read_args = _live_read_arguments(spans)
    # Which servers nothing backs, decided once for the reply, not per clause,
    # each with its patterns fetched once (M3).
    candidates = [
        (server, _server_patterns(server.words))
        for server in servers
        if server.words
        and server.name not in answered
        and not any(word in read_args for word in server.words)
    ]
    if not candidates:
        return None
    ran = _mcp_servers_in(spans, ok=False)
    for clause, is_question in _clauses(reply_text):
        if is_question or _SERVER_EARLIER.search(clause):
            continue
        for server, (_lead, _named, read, said) in candidates:
            found = read.search(clause) or said.search(clause)
            if found is None:
                continue
            # A call that ran and failed is in the record: "no call ran" would
            # be the guard's own false sentence beside it.
            outcome = "succeeded" if server.name in ran else "ran"
            return ServerClaimFound(
                server=server.name,
                phrase=found.group(0)[:120],
                text=f"(No call to {server.name} {outcome} this turn.)",
            )
    return None
