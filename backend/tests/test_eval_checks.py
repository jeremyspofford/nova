"""Grading the grader: the contract checker against the authored probes.

Every suite ships a golden and a bad sample for each text-bearing check
(`probes.json`). The contract is that the golden passes EVERY check in its
area and the bad sample fails at least one — so this file is both the
checker's test corpus and a standing regression test on the specs
themselves. Plus focused cases for the vocabulary the probes cannot cover
(tool-call bounds, memory shape, rounds/errors), and for the two semantics
that are easy to get wrong.

    docker compose exec backend python tests/test_eval_checks.py
"""

import json
import sys
from dataclasses import dataclass, field

sys.path.insert(0, "/app/backend")

from app.evals import checks, suites                      # noqa: E402

FAILURES: list[str] = []
COUNTS = {"probes": 0, "cases": 0}


def check(label, cond, detail=""):
    if not cond:
        FAILURES.append(label)
        print(f"  FAIL  {label}" + (f"   [{detail}]" if detail else ""))


# ── a stand-in for evals.runner.RunResult ────────────────────────────────

@dataclass
class FakeRun:
    final: str = ""
    tool_calls: list = field(default_factory=list)
    memory: dict = field(default_factory=lambda: {"created": [], "modified": [],
                                                  "deleted": [], "items": []})
    rounds: int = 1
    malformed_args: int = 0
    timed_out: bool = False
    fixture_misses: list = field(default_factory=list)
    fixture_violations: list = field(default_factory=list)


def call(tool, args, result="ok"):
    return {"tool": tool, "args": args, "served": True, "result": result}


def topic(item_id, body="", new=True, **fm):
    return {"id": item_id, "frontmatter": fm, "body": body, "new": new}


def mem(items, created=None, modified=None):
    return {"items": items,
            "created": created if created is not None
            else [i["id"] for i in items if i["new"]],
            "modified": modified or [], "deleted": []}


# ── 1. the authored probes ───────────────────────────────────────────────

def test_probes():
    print("1. authored probes: golden passes every check, bad fails one")
    for suite_name in suites.list_suites():
        suite = suites.load_suite(suite_name)
        probes_path = suite.directory / "probes.json"
        if not probes_path.is_file():
            continue
        probes = json.loads(probes_path.read_text()).get("probes") or {}
        by_id = {t.id: t for t in suites.load_tasks(suite)}
        for task_id, areas in probes.items():
            contract = by_id[task_id].contract
            for area, samples in areas.items():
                for kind in ("golden", "bad"):
                    report = checks.ContractReport()
                    sample = samples[kind]
                    if area == "final_text":
                        checks.check_final_text(contract["final_text"], sample, report)
                    elif area == "write_content":
                        checks._check_write_content(
                            contract["memory"]["write_content"],
                            [call("write_memory", {"content": sample})], report)
                    else:
                        check(f"{suite_name}/{task_id}: unknown probe area {area}", False)
                        continue
                    COUNTS["probes"] += 1
                    where = f"{suite_name}/{task_id}.{area}"
                    if kind == "golden":
                        check(f"{where} golden passes", report.passed,
                              "; ".join(f"{r.key} {r.detail}" for r in report.failures))
                    else:
                        check(f"{where} bad fails ≥1", not report.passed,
                              "every check passed on the bad sample")
    print(f"   {COUNTS['probes']} probe samples graded")


# ── 2. the two semantics the README calls out ────────────────────────────

def test_regex_semantics():
    print("2. regex semantics: search + IGNORECASE, never MULTILINE")
    report = checks.ContractReport()
    checks.check_final_text({"must_match": ["^ready"]}, "Ready to go", report)
    check("^ anchors the string, case-insensitively", report.passed)

    report = checks.ContractReport()
    checks.check_final_text({"must_match": ["^second"]}, "first\nsecond", report)
    check("^ does NOT match a mid-string line start (no MULTILINE)",
          not report.passed)

    report = checks.ContractReport()
    checks.check_final_text({"must_match": ["(?:^|\\n)second"]}, "first\nsecond", report)
    check("the explicit (?:^|\\n) form does match", report.passed)
    COUNTS["cases"] += 3


def test_write_content_grades_the_argument():
    print("3. write_content grades the content ARGUMENT, not the file")
    # a delta-only prepend: the argument holds today's entry, the file also
    # holds last week's. A checker reading the file would see the old text.
    spec = {"must_contain": ["July 24"], "must_not_contain": ["July 17"]}
    run = FakeRun(
        tool_calls=[call("write_memory", {"item_id": "topics/d.md", "prepend": True,
                                          "content": "## July 24\nnew entry"})],
        memory=mem([topic("topics/d.md", body="## July 24\nnew entry\n## July 17\nold",
                          new=False)], created=[], modified=["topics/d.md"]))
    report = checks.ContractReport()
    checks.check_memory({"write_content": spec}, run, report)
    check("delta write passes on its argument", report.passed,
          "; ".join(f"{r.key} {r.detail}" for r in report.failures))

    # and the same body would fail if graded as a whole-document replace
    run2 = FakeRun(tool_calls=[call("write_memory", {
        "item_id": "topics/d.md",
        "content": "## July 24\nnew entry\n## July 17\nold"})])
    report2 = checks.ContractReport()
    checks.check_memory({"write_content": spec}, run2, report2)
    check("resending the whole document fails must_not_contain",
          not report2.passed)
    COUNTS["cases"] += 2


# ── 3. the rest of the vocabulary ────────────────────────────────────────

def test_tools():
    print("4. tools: bounds, absence, arg subsets, total cap")
    run = FakeRun(tool_calls=[
        call("search_memory", {"query": "a"}),
        call("search_memory", {"query": "b"}),
        call("write_memory", {"item_id": "topics/x.md", "prepend": True,
                              "content": "c"}),
    ])
    report = checks.ContractReport()
    checks.check_tools({
        "must_call": [{"name": "search_memory", "min": 1, "max": 3},
                      {"name": "write_memory", "min": 1, "max": 1}],
        "must_not_call": ["fetch_url"],
        "must_call_with": [{"name": "write_memory",
                            "args": {"item_id": "topics/x.md", "prepend": True}}],
        "must_not_call_with": [{"name": "write_memory", "args": {"append": True}}],
        "max_total_calls": 4,
    }, run, report)
    check("a clean transcript passes every tool check", report.passed,
          "; ".join(f"{r.key} {r.detail}" for r in report.failures))

    report = checks.ContractReport()
    checks.check_tools({"must_call": [{"name": "search_memory", "min": 1, "max": 1}],
                        "must_not_call": ["search_memory"],
                        "max_total_calls": 2}, run, report)
    check("over-calling, banned calls and the cap all fail",
          len(report.failures) == 3, str([r.key for r in report.failures]))

    # must_call_with is a SUBSET predicate, like fixture matching
    report = checks.ContractReport()
    checks.check_tools({"must_call_with": [
        {"name": "write_memory", "args": {"prepend": True}}]}, run, report)
    check("subset args match a call with extra keys", report.passed)
    COUNTS["cases"] += 3


def test_memory_shape():
    print("5. memory: creation counts, frontmatter, tags, updates")
    run = FakeRun(
        tool_calls=[call("write_memory", {"content": "body", "type": "topic",
                                          "title": "Kimi K3", "tags": ["kimi-k3"],
                                          "source_url": "https://x/a"})],
        memory=mem([topic("topics/kimi-k3.md", body="1.2T parameters, MIT license",
                          title="Kimi K3", tags=["kimi-k3", "moe-models"],
                          source_url="https://x/a")]))
    report = checks.ContractReport()
    checks.check_memory({
        "topics_created": {"min": 1, "max": 1},
        "title_matches": "kimi",
        "frontmatter_required": ["title", "tags", "source_url"],
        "frontmatter_equals": {"title": "Kimi K3"},
        "source_url_in": ["https://x/a", "https://x/b"],
        "tags": {"min": 2, "max": 4, "no_generic": True,
                 "must_include_any": [["kimi-k3", "kimi"]],
                 "must_not_include": ["news"]},
        "body_must_contain_any": [["1.2T", "1.2 trillion"]],
        "body_must_not_contain": ["I could not find"],
    }, run, report, generic_tags={"news", "video", "transcript"})
    check("a well-formed topic passes every memory check", report.passed,
          "; ".join(f"{r.key} {r.detail}" for r in report.failures))

    # frontmatter carries tags as the store's raw "[a, b, c]" string — read
    # any other way this grades single characters and every tag check lies
    raw = FakeRun(memory=mem([topic("topics/k.md", body="b", title="K",
                                    tags="[kimi-k3, moe-models]")]))
    report = checks.ContractReport()
    checks.check_memory({"tags": {"min": 2, "max": 4,
                                  "must_include_any": [["kimi-k3"]]}},
                        raw, report)
    check("tags parse from the store's raw string form", report.passed,
          "; ".join(f"{r.key} {r.detail}" for r in report.failures))

    # generic tags are the bridging-bug rail: they must fail
    bad = FakeRun(memory=mem([topic("topics/x.md", tags=["news", "video"])]))
    report = checks.ContractReport()
    checks.check_memory({"tags": {"no_generic": True}}, bad, report,
                        generic_tags={"news", "video"})
    check("generic tags fail no_generic", not report.passed)

    # no_writes / no_new_topics
    report = checks.ContractReport()
    checks.check_memory({"no_writes": True, "no_new_topics": True}, run, report)
    check("a run that wrote fails no_writes and no_new_topics",
          len(report.failures) == 2, str([r.key for r in report.failures]))

    # updates: mode and count are both graded
    upd = FakeRun(tool_calls=[
        call("write_memory", {"item_id": "topics/d.md", "append": True, "content": "x"})])
    report = checks.ContractReport()
    checks.check_memory({"updates": [{"item_id": "topics/d.md", "mode": "append",
                                      "count": 1}]}, upd, report)
    check("an append in place passes", report.passed)
    report = checks.ContractReport()
    checks.check_memory({"updates": [{"item_id": "topics/d.md", "mode": "prepend",
                                      "count": 1}]}, upd, report)
    check("appending when prepend was required fails", not report.passed)

    # a journal write is not a topic — grading it would score the harness
    j = FakeRun(memory=mem([topic("journals/2026-07-24.md", body="chat trail")]))
    report = checks.ContractReport()
    checks.check_memory({"no_new_topics": True}, j, report)
    check("a journal entry is not a new topic", report.passed)
    COUNTS["cases"] += 7


def test_top_level_and_run_validity():
    print("6. rounds, malformed args, tool errors, run validity")
    run = FakeRun(rounds=7, malformed_args=1, tool_calls=[
        call("web_search", {"query": "a"}, result="Error: all providers failed"),
        call("fetch_url", {"url": "u"}, result="Blocked by rule 'no-fetch': x"),
        call("search_memory", {"query": "b"}, result="{}"),
    ])
    report = checks.evaluate({"rounds_max": 5, "malformed_args_max": 0,
                              "tool_errors_max": 1,
                              "narration_slip_allowed": True}, run)
    keys = {r.key for r in report.failures}
    check("rounds/malformed/tool_errors all fail as specified",
          keys == {"rounds_max", "malformed_args_max", "tool_errors_max"}, str(keys))

    ok = FakeRun(rounds=3, tool_calls=[call("search_memory", {"query": "b"})])
    report = checks.evaluate({"rounds_max": 5, "malformed_args_max": 0,
                              "tool_errors_max": 0,
                              "narration_slip_allowed": True}, ok)
    check("a clean run passes", report.passed,
          "; ".join(f"{r.key} {r.detail}" for r in report.failures))

    # an ungradeable run says so rather than scoring the wreckage
    wreck = FakeRun(timed_out=True, fixture_misses=[{"tool": "web_search"}],
                    fixture_violations=[{"tool": "pull_model"}])
    report = checks.evaluate({"narration_slip_allowed": True}, wreck)
    keys = {r.key for r in report.failures}
    check("timeout, unserved fixture and refused tool are all reported",
          keys == {"run.completed", "run.fixtures_served",
                   "run.no_destructive_tools"}, str(keys))
    COUNTS["cases"] += 3


def test_narration_slip():
    print("7. narration slip: announced work with no tool call")
    slip = FakeRun(final="Let me search for that and I'll write it to memory.",
                   tool_calls=[])
    report = checks.evaluate({}, slip)
    check("a narration slip fails by default", not report.passed,
          "; ".join(r.key for r in report.results))
    report = checks.evaluate({"narration_slip_allowed": True}, slip)
    check("...and passes when the task allows it", report.passed)
    COUNTS["cases"] += 2


def test_unknown_key_is_an_error():
    print("8. an unimplemented check never reports a pass")
    for spec, where in (({"nonsense": 1}, "contract"),
                        ({"tools": {"must_flail": []}}, "contract.tools"),
                        ({"memory": {"tags": {"vibe": "good"}}}, "memory.tags")):
        try:
            checks.evaluate(spec, FakeRun())
        except checks.UnknownContractKey:
            continue
        check(f"unknown key under {where} raises", False)
    COUNTS["cases"] += 3


def main():
    for t in (test_probes, test_regex_semantics, test_write_content_grades_the_argument,
              test_tools, test_memory_shape, test_top_level_and_run_validity,
              test_narration_slip, test_unknown_key_is_an_error):
        t()
    print(f"\n{COUNTS['probes']} probe samples + {COUNTS['cases']} focused cases")
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
