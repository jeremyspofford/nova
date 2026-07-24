"""Deterministic contract checks — the first of the plan's three grading
layers (docs/plans/model-eval-pipeline.md).

Anything a regex or a file check can decide is decided HERE; the pairwise
judge is for prose quality only. A contract failure is objective and
reviewable after the fact, which is what makes a promote/reject defensible.

The vocabulary is closed and specified in `tasks/README.md` — that file is
the authority, not this module. Two semantics are easy to get wrong and are
therefore stated once, here, and never re-derived:

* Regexes are `re.search` with `IGNORECASE` and deliberately WITHOUT
  `MULTILINE`: `^` means start of the string. Specs that want a line anchor
  mid-document write `(?:^|\\n)` themselves.
* `write_content` grades the `content` ARGUMENT of `write_memory`, not the
  resulting file. That is the only way to grade a delta-only write, where
  append/prepend send just the new lines and the file also holds everything
  that came before.

An unknown contract key is a hard error, not a shrug: silently ignoring a
key would report a passing grade for a check that never ran.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Optional

# vocabulary (kept in sync with tasks/validate.py, which rejects specs using
# anything outside it — the two lists disagreeing is itself a bug)
CONTRACT_KEYS = {"tools", "memory", "rounds_max", "malformed_args_max",
                 "tool_errors_max", "final_text", "narration_slip_allowed"}
TOOLS_KEYS = {"must_call", "must_not_call", "must_call_with",
              "must_not_call_with", "max_total_calls"}
MEMORY_KEYS = {"no_writes", "no_new_topics", "topics_created", "updates",
               "title_matches", "frontmatter_required", "frontmatter_equals",
               "source_url_in", "tags", "body_must_contain_any",
               "body_must_not_contain", "body_must_not_match", "write_content"}
TAGS_KEYS = {"min", "max", "no_generic", "must_include_any", "must_not_include"}
WRITE_CONTENT_KEYS = {"must_match", "must_not_match", "must_contain",
                      "must_not_contain", "max_chars"}
FINAL_TEXT_KEYS = {"must_match", "must_not_match"}

# a tool result that starts with either of these counts as a tool error
_ERROR_PREFIXES = ("Error: ", "Blocked by rule ")


def _search(pattern: str, text: str) -> bool:
    return re.search(pattern, text or "", re.IGNORECASE) is not None


def _contains(needle: str, text: str) -> bool:
    return (needle or "").lower() in (text or "").lower()


def _subset(pattern: dict, args: dict) -> bool:
    """Same predicate the fixture loader uses: every listed key present and
    equal. Keeping the two identical is deliberate — a spec author who
    learns one has learned the other."""
    return all(k in args and args[k] == v for k, v in (pattern or {}).items())


@dataclass
class CheckResult:
    """One named check and whether the run satisfied it."""
    key: str            # dotted path into the contract, e.g. "memory.tags"
    passed: bool
    detail: str = ""


@dataclass
class ContractReport:
    results: list[CheckResult] = field(default_factory=list)

    def add(self, key: str, passed: bool, detail: str = "") -> None:
        self.results.append(CheckResult(key, passed, detail))

    @property
    def failures(self) -> list[CheckResult]:
        return [r for r in self.results if not r.passed]

    @property
    def passed(self) -> bool:
        return not self.failures

    def as_dict(self) -> dict:
        return {"passed": self.passed,
                "checks": [{"key": r.key, "passed": r.passed, "detail": r.detail}
                           for r in self.results],
                "failures": [f"{r.key}: {r.detail}" for r in self.failures]}


class UnknownContractKey(ValueError):
    """A spec names a check this module does not implement."""


def _reject_unknown(where: str, spec: dict, allowed: set[str]) -> None:
    unknown = set(spec or {}) - allowed
    if unknown:
        raise UnknownContractKey(
            f"{where}: unknown key(s) {sorted(unknown)} — the vocabulary is "
            f"closed (tasks/README.md); an unimplemented check must never "
            f"report a pass")


# ── transcript views ─────────────────────────────────────────────────────

def _calls(run: Any) -> list[dict]:
    """Every tool call the run made, served or executed, with FULL args.

    `fixtures.calls` is the only complete transcript: spans truncate args at
    2000 chars and activity events at 200, and a distilled topic body runs
    past both.
    """
    return list(getattr(run, "tool_calls", None) or [])


def _writes(run: Any) -> list[dict]:
    return [c for c in _calls(run) if c["tool"] == "write_memory"]


def _write_mode(args: dict) -> str:
    if not args.get("item_id"):
        return "create"
    if args.get("prepend"):
        return "prepend"
    if args.get("append"):
        return "append"
    return "replace"


def _created_items(run: Any) -> list[dict]:
    mem = getattr(run, "memory", None) or {}
    return [i for i in (mem.get("items") or []) if i.get("new")]


def _touched_items(run: Any) -> list[dict]:
    """Created or modified — the bodies a body_* check should look at."""
    mem = getattr(run, "memory", None) or {}
    changed = set(mem.get("created") or []) | set(mem.get("modified") or [])
    return [i for i in (mem.get("items") or []) if i["id"] in changed]


def _tags_of(frontmatter: dict) -> list[str]:
    """Frontmatter tags, lowercased.

    On disk they are the raw `[a, b, c]` string, so the store's own parser is
    the only correct reader — iterating that value directly grades individual
    CHARACTERS, and every tag check then lies (caught live: "22 tags, none of
    them yours"). A list is accepted too, because results that have been
    JSON round-tripped keep whichever shape they were built with.
    """
    from app.memory.store import OkfStore
    raw = frontmatter.get("tags")
    tags = raw if isinstance(raw, list) else OkfStore.extract_tags(frontmatter)
    return [str(t).strip().lower() for t in tags if str(t).strip()]


def _is_topic(item: dict) -> bool:
    """Topics only: journals are the runner's own narration/chat trail, and
    grading them would score the harness instead of the contestant."""
    return item["id"].startswith("topics/")


# ── the checks ───────────────────────────────────────────────────────────

def check_tools(spec: dict, run: Any, report: ContractReport) -> None:
    _reject_unknown("contract.tools", spec, TOOLS_KEYS)
    calls = _calls(run)
    names = [c["tool"] for c in calls]

    for want in spec.get("must_call") or []:
        name, low = want["name"], int(want.get("min", 1))
        high = want.get("max")
        n = names.count(name)
        ok = n >= low and (high is None or n <= int(high))
        bound = f">={low}" + (f" and <={high}" if high is not None else "")
        report.add(f"tools.must_call[{name}]", ok, f"called {n}x, wanted {bound}")

    for name in spec.get("must_not_call") or []:
        n = names.count(name)
        report.add(f"tools.must_not_call[{name}]", n == 0, f"called {n}x")

    for want in spec.get("must_call_with") or []:
        name, args = want["name"], want.get("args") or {}
        hits = [c for c in calls if c["tool"] == name and _subset(args, c["args"])]
        report.add(f"tools.must_call_with[{name}]", bool(hits),
                   f"{len(hits)} call(s) matched {args}")

    for want in spec.get("must_not_call_with") or []:
        name, args = want["name"], want.get("args") or {}
        hits = [c for c in calls if c["tool"] == name and _subset(args, c["args"])]
        report.add(f"tools.must_not_call_with[{name}]", not hits,
                   f"{len(hits)} call(s) matched {args}")

    if "max_total_calls" in spec:
        cap = int(spec["max_total_calls"])
        report.add("tools.max_total_calls", len(calls) <= cap,
                   f"{len(calls)} calls, cap {cap}")


def check_memory(spec: dict, run: Any, report: ContractReport,
                 generic_tags: Optional[set[str]] = None) -> None:
    _reject_unknown("contract.memory", spec, MEMORY_KEYS)
    writes = _writes(run)
    created = [i for i in _created_items(run) if _is_topic(i)]

    if spec.get("no_writes"):
        report.add("memory.no_writes", not writes,
                   f"{len(writes)} write_memory call(s)")

    if spec.get("no_new_topics"):
        report.add("memory.no_new_topics", not created,
                   f"created {[i['id'] for i in created]}")

    if "topics_created" in spec:
        bounds = spec["topics_created"] or {}
        n = len(created)
        low = int(bounds.get("min", 0))
        high = bounds.get("max")
        ok = n >= low and (high is None or n <= int(high))
        report.add("memory.topics_created", ok,
                   f"{n} created ({[i['id'] for i in created]})")

    for want in spec.get("updates") or []:
        item_id, mode = want["item_id"], want["mode"]
        n = sum(1 for w in writes
                if w["args"].get("item_id") == item_id
                and _write_mode(w["args"]) == mode)
        wanted = int(want.get("count", 1))
        report.add(f"memory.updates[{item_id}:{mode}]", n == wanted,
                   f"{n} such write(s), wanted {wanted}")

    if "title_matches" in spec:
        titles = [str((i.get("frontmatter") or {}).get("title", "")) for i in created]
        ok = bool(titles) and all(_search(spec["title_matches"], t) for t in titles)
        report.add("memory.title_matches", ok, f"titles {titles}")

    # NOTE for the three checks below: a run that created NO topic fails them
    # rather than passing vacuously — "every topic I wrote is well-formed" is
    # not a defence when you wrote none.
    if "frontmatter_required" in spec:
        missing = {i["id"]: [k for k in spec["frontmatter_required"]
                             if k not in (i.get("frontmatter") or {})]
                   for i in created}
        bad = {k: v for k, v in missing.items() if v}
        report.add("memory.frontmatter_required", bool(created) and not bad,
                   "no topics created" if not created else
                   f"missing {bad}" if bad else f"{len(created)} topic(s) complete")

    if "frontmatter_equals" in spec:
        bad = {i["id"]: {k: (i.get("frontmatter") or {}).get(k)
                         for k, v in spec["frontmatter_equals"].items()
                         if (i.get("frontmatter") or {}).get(k) != v}
               for i in created}
        bad = {k: v for k, v in bad.items() if v}
        report.add("memory.frontmatter_equals", bool(created) and not bad,
                   "no topics created" if not created else
                   f"mismatched {bad}" if bad else "all equal")

    if "source_url_in" in spec:
        allowed = set(spec["source_url_in"])
        urls = [(i.get("frontmatter") or {}).get("source_url") for i in created]
        ok = bool(urls) and all(u in allowed for u in urls)
        report.add("memory.source_url_in", ok,
                   "no topics created" if not urls else f"source_url {urls}")

    if "tags" in spec:
        _check_tags(spec["tags"] or {}, created, report, generic_tags)

    bodies = [i.get("body") or "" for i in _touched_items(run) if _is_topic(i)]
    joined = "\n".join(bodies)
    for group in spec.get("body_must_contain_any") or []:
        hit = any(_contains(alt, joined) for alt in group)
        report.add(f"memory.body_must_contain_any[{group[0]}]", hit,
                   "no alternative found" if not hit else "ok")
    for needle in spec.get("body_must_not_contain") or []:
        report.add(f"memory.body_must_not_contain[{needle}]",
                   not _contains(needle, joined), "present" if
                   _contains(needle, joined) else "absent")
    # the regex form, for forbidden values that are SUBSTRINGS of the correct
    # answer. Graded a champion as wrong for writing "1.2 trillion" because
    # the spec forbade "2 trillion" — no substring test can separate those,
    # and a grader that fails a right answer is worse than no grader.
    for pattern in spec.get("body_must_not_match") or []:
        report.add(f"memory.body_must_not_match[{pattern[:40]}]",
                   not _search(pattern, joined),
                   "matched" if _search(pattern, joined) else "absent")

    if "write_content" in spec:
        _check_write_content(spec["write_content"] or {}, writes, report)


def _check_tags(spec: dict, created: list[dict], report: ContractReport,
                generic_tags: Optional[set[str]]) -> None:
    _reject_unknown("contract.memory.tags", spec, TAGS_KEYS)
    tags_per_item = {i["id"]: _tags_of(i.get("frontmatter") or {}) for i in created}
    all_tags = {t for tags in tags_per_item.values() for t in tags}

    if "min" in spec or "max" in spec:
        low, high = spec.get("min"), spec.get("max")
        bad = {k: v for k, v in tags_per_item.items()
               if (low is not None and len(v) < int(low))
               or (high is not None and len(v) > int(high))}
        report.add("memory.tags.count", bool(tags_per_item) and not bad,
                   f"out of range {bad}" if bad else f"{tags_per_item}")

    if spec.get("no_generic"):
        if generic_tags is None:
            from app.memory.memory import OkfMemory
            generic_tags = {str(t).lower() for t in OkfMemory._GENERIC_TAGS}
        offenders = sorted(all_tags & generic_tags)
        report.add("memory.tags.no_generic", not offenders,
                   f"generic tags {offenders}" if offenders else "none")

    for group in spec.get("must_include_any") or []:
        hit = any(str(t).lower() in all_tags for t in group)
        report.add(f"memory.tags.must_include_any[{group[0]}]", hit,
                   f"have {sorted(all_tags)}")

    banned = sorted({str(t).lower() for t in (spec.get("must_not_include") or [])}
                    & all_tags)
    if spec.get("must_not_include") is not None:
        report.add("memory.tags.must_not_include", not banned,
                   f"present {banned}" if banned else "none")


def _check_write_content(spec: dict, writes: list[dict],
                         report: ContractReport) -> None:
    """Graded on the `content` argument, joined across writes.

    Joined rather than per-write because a task may legitimately split a
    digest across two calls; a `must_not_contain` still has to hold over all
    of them, and `max_chars` is about what the model wrote in total.
    """
    _reject_unknown("contract.memory.write_content", spec, WRITE_CONTENT_KEYS)
    contents = [str(w["args"].get("content") or "") for w in writes]
    joined = "\n".join(contents)

    for pattern in spec.get("must_match") or []:
        # anchored patterns must see a single write, not the join, or a
        # leading `^` would only ever match the first one
        ok = any(_search(pattern, c) for c in contents)
        report.add(f"memory.write_content.must_match[{pattern[:40]}]", ok,
                   "no write matched" if not ok else "ok")
    for pattern in spec.get("must_not_match") or []:
        hits = [c[:60] for c in contents if _search(pattern, c)]
        report.add(f"memory.write_content.must_not_match[{pattern[:40]}]",
                   not hits, f"matched in {len(hits)} write(s)")
    for needle in spec.get("must_contain") or []:
        report.add(f"memory.write_content.must_contain[{needle[:40]}]",
                   _contains(needle, joined), "absent")
    for needle in spec.get("must_not_contain") or []:
        report.add(f"memory.write_content.must_not_contain[{needle[:40]}]",
                   not _contains(needle, joined), "present")
    if "max_chars" in spec:
        cap = int(spec["max_chars"])
        longest = max((len(c) for c in contents), default=0)
        report.add("memory.write_content.max_chars", longest <= cap,
                   f"longest write {longest} chars, cap {cap}")


def check_final_text(spec: dict, text: str, report: ContractReport) -> None:
    _reject_unknown("contract.final_text", spec, FINAL_TEXT_KEYS)
    for pattern in spec.get("must_match") or []:
        report.add(f"final_text.must_match[{pattern[:40]}]",
                   _search(pattern, text), "no match")
    for pattern in spec.get("must_not_match") or []:
        report.add(f"final_text.must_not_match[{pattern[:40]}]",
                   not _search(pattern, text), "matched")


# ── the whole contract ───────────────────────────────────────────────────

def evaluate(contract: dict, run: Any) -> ContractReport:
    """Grade one RunResult against one task's contract.

    `run` is an `evals.runner.RunResult` (duck-typed here so probe fixtures
    and future result shapes can be graded without constructing one).
    """
    report = ContractReport()
    contract = contract or {}
    _reject_unknown("contract", contract, CONTRACT_KEYS)

    if "tools" in contract:
        check_tools(contract["tools"] or {}, run, report)
    if "memory" in contract:
        check_memory(contract["memory"] or {}, run, report)

    if "rounds_max" in contract:
        cap = int(contract["rounds_max"])
        rounds = int(getattr(run, "rounds", 0) or 0)
        report.add("rounds_max", rounds <= cap, f"{rounds} rounds, cap {cap}")

    if "malformed_args_max" in contract:
        cap = int(contract["malformed_args_max"])
        n = int(getattr(run, "malformed_args", 0) or 0)
        report.add("malformed_args_max", n <= cap, f"{n} malformed, cap {cap}")

    if "tool_errors_max" in contract:
        cap = int(contract["tool_errors_max"])
        n = sum(1 for c in _calls(run)
                if str(c.get("result") or "").startswith(_ERROR_PREFIXES))
        report.add("tool_errors_max", n <= cap, f"{n} error results, cap {cap}")

    final = str(getattr(run, "final", "") or "")
    if "final_text" in contract:
        check_final_text(contract["final_text"] or {}, final, report)

    if not contract.get("narration_slip_allowed", False):
        from app import narration
        calls_made = len(_calls(run))
        slip = narration.detect(final, calls_made)
        report.add("narration_slip_allowed", not slip,
                   f"announced an action but called no tool ({slip!r})"
                   if slip else "none")

    # A run that never produced an answer, blew its budget, or reached past
    # its fixtures is not gradeable — say so instead of scoring the wreckage.
    if getattr(run, "timed_out", False):
        report.add("run.completed", False, "timed out")
    if getattr(run, "fixture_misses", None):
        report.add("run.fixtures_served", False,
                   f"{len(run.fixture_misses)} unserved tool call(s)")
    if getattr(run, "fixture_violations", None):
        report.add("run.no_destructive_tools", False,
                   f"{len(run.fixture_violations)} refused destructive call(s)")
    return report
