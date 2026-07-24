#!/usr/bin/env python3
"""Validate the eval suite specs in this directory. Standalone, stdlib only.

    python backend/app/evals/tasks/validate.py

Checks what a JSON Schema cannot: that every referenced file exists, every
regex compiles, every task id matches its filename and its suite's task list,
every fixture entry has exactly one result source, and that contract checks
name real tools that the agent is actually granted. Run it after editing any
spec — a suite that fails here would fail at run time as a confusing harness
error instead of an authoring mistake.

Deliberately NOT imported by anything: it is a script, so it does not care
whether app.evals ends up a module or a package.
"""

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent

# agents.allowed_tools as seeded/edited in the live DB, 2026-07-24. Used only
# to catch a contract naming a tool the agent could never call.
GRANTED = {
    "ingestion": {
        "web_search", "fetch_url", "write_memory", "search_memory",
        "read_memory_item", "list_stale_topics", "get_weather", "ingest_media",
        "raise_recommendation", "follow_source", "list_followed_sources",
        "unfollow_source", "poll_sources",
    },
    "model-manager": {
        "list_models", "pull_model", "search_memory", "recommend_models",
        "web_search",
    },
    "news-summarizer": {
        "search_memory", "write_memory", "read_memory_item", "web_search",
        "fetch_url",
    },
}

CONTRACT_KEYS = {
    "tools", "memory", "rounds_max", "malformed_args_max", "tool_errors_max",
    "final_text", "narration_slip_allowed",
}
TOOLS_KEYS = {"must_call", "must_not_call", "must_call_with",
              "must_not_call_with", "max_total_calls"}
MEMORY_KEYS = {
    "no_writes", "no_new_topics", "topics_created", "updates", "title_matches",
    "frontmatter_required", "frontmatter_equals", "source_url_in", "tags",
    "body_must_contain_any", "body_must_not_contain", "body_must_not_match",
    "write_content",
}
TAGS_KEYS = {"min", "max", "no_generic", "must_include_any", "must_not_include"}
WRITE_CONTENT_KEYS = {"must_match", "must_not_match", "must_contain",
                      "must_not_contain", "max_chars"}

REGEX_FIELDS = [
    ("memory", "title_matches"),
]

errors: list[str] = []
warnings: list[str] = []
counts = {"suites": 0, "tasks": 0, "fixtures": 0, "regexes": 0, "probes": 0}


def err(where, msg):
    errors.append(f"{where}: {msg}")


def warn(where, msg):
    warnings.append(f"{where}: {msg}")


def load(path):
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as e:
        err(path.name, f"invalid JSON — {e}")
        return None


def check_regex(where, pattern):
    counts["regexes"] += 1
    try:
        re.compile(pattern, re.IGNORECASE)
    except re.error as e:
        err(where, f"regex does not compile: {pattern!r} — {e}")


def check_unknown(where, obj, allowed, label):
    for key in obj:
        if key not in allowed:
            err(where, f"unknown {label} key {key!r}")


def check_fixture(suite_dir, rel, agent):
    counts["fixtures"] += 1
    path = suite_dir / rel
    where = f"{suite_dir.name}/{rel}"
    if not path.exists():
        err(where, "fixture file does not exist")
        return
    fx = load(path)
    if fx is None:
        return
    tool = fx.get("tool")
    if not tool:
        err(where, "missing 'tool'")
    elif agent and tool not in GRANTED.get(agent, set()):
        err(where, f"fixtures tool {tool!r} which {agent} is not granted")

    def check_result(node, label):
        has = [k for k in ("result", "result_file") if k in node]
        if len(has) != 1:
            err(where, f"{label}: exactly one of result/result_file required, got {has}")
            return
        if "result_file" in node:
            target = path.parent / node["result_file"]
            if not target.exists():
                err(where, f"{label}: result_file {node['result_file']} does not exist")
                return
            size = target.stat().st_size
        else:
            size = len(node["result"])
        if size > 8000:
            err(where, f"{label}: result is {size} chars, over the 8000-char cap "
                       f"the runner applies before the model sees it")

    for i, entry in enumerate(fx.get("entries") or []):
        if "match" not in entry:
            err(where, f"entry[{i}]: missing 'match'")
        elif not isinstance(entry["match"], dict):
            err(where, f"entry[{i}]: 'match' must be an object")
        check_result(entry, f"entry[{i}]")
    if "default" in fx:
        check_result(fx["default"], "default")
    elif not fx.get("entries"):
        err(where, "no entries and no default — this fixture serves nothing")

    # a bare-arg entry listed before a more specific one shadows it
    seen: list[dict] = []
    for i, entry in enumerate(fx.get("entries") or []):
        m = entry.get("match")
        if not isinstance(m, dict):
            continue
        for j, prev in enumerate(seen):
            if prev.items() <= m.items() and prev != m:
                err(where, f"entry[{i}] is unreachable: entry[{j}] {prev} is a "
                           f"subset of it and matches first")
        seen.append(m)


def check_contract(where, contract, agent):
    check_unknown(where, contract, CONTRACT_KEYS, "contract")
    tools = contract.get("tools") or {}
    check_unknown(where, tools, TOOLS_KEYS, "contract.tools")

    named = []
    for item in tools.get("must_call") or []:
        named.append(item.get("name"))
        if "min" in item and "max" in item and item["min"] > item["max"]:
            err(where, f"must_call {item.get('name')}: min > max")
    named += list(tools.get("must_not_call") or [])
    for item in (tools.get("must_call_with") or []) + (tools.get("must_not_call_with") or []):
        named.append(item.get("name"))
        if not isinstance(item.get("args"), dict):
            err(where, f"{item.get('name')}: 'args' must be an object")
    for name in named:
        if agent and name not in GRANTED.get(agent, set()):
            err(where, f"contract names tool {name!r}, not granted to {agent}")

    both = {i.get("name") for i in (tools.get("must_call") or []) if i.get("min", 0) > 0}
    for name in tools.get("must_not_call") or []:
        if name in both:
            err(where, f"{name} is in both must_call(min>0) and must_not_call")

    memory = contract.get("memory") or {}
    check_unknown(where, memory, MEMORY_KEYS, "contract.memory")
    if memory.get("no_writes") and (memory.get("updates") or memory.get("write_content")
                                    or memory.get("topics_created")):
        err(where, "no_writes is set alongside a check that presumes a write")
    if "title_matches" in memory:
        check_regex(where, memory["title_matches"])
    for pattern in memory.get("body_must_not_match") or []:
        check_regex(where, pattern)
    tags = memory.get("tags") or {}
    check_unknown(where, tags, TAGS_KEYS, "contract.memory.tags")
    if tags.get("must_include_any"):
        for grp in tags["must_include_any"]:
            if not isinstance(grp, list):
                err(where, "tags.must_include_any must be a list of GROUPS (lists)")
    for t in tags.get("must_not_include") or []:
        for grp in tags.get("must_include_any") or []:
            if t in grp:
                err(where, f"tag {t!r} is both required and forbidden")
    wc = memory.get("write_content") or {}
    check_unknown(where, wc, WRITE_CONTENT_KEYS, "contract.memory.write_content")
    for key in ("must_match", "must_not_match"):
        for pat in wc.get(key) or []:
            check_regex(where, pat)
    overlap = set(map(str.lower, wc.get("must_contain") or [])) & \
        set(map(str.lower, wc.get("must_not_contain") or []))
    if overlap:
        err(where, f"write_content requires and forbids the same string(s): {sorted(overlap)}")

    ft = contract.get("final_text") or {}
    for key in ("must_match", "must_not_match"):
        for pat in ft.get(key) or []:
            check_regex(where, pat)
    if set(ft) - {"must_match", "must_not_match"}:
        err(where, f"unknown final_text key(s): {sorted(set(ft) - {'must_match', 'must_not_match'})}")


def _text_violations(spec, text):
    """Which checks in a {must_match, must_not_match, must_contain,
    must_not_contain, max_chars} block this text fails. Same semantics the
    harness must implement: re.search, IGNORECASE, no MULTILINE."""
    bad = []
    for pat in spec.get("must_match") or []:
        if not re.search(pat, text, re.IGNORECASE):
            bad.append(f"must_match {pat!r} did not match")
    for pat in spec.get("must_not_match") or []:
        if re.search(pat, text, re.IGNORECASE):
            bad.append(f"must_not_match {pat!r} matched")
    for s in spec.get("must_contain") or []:
        if s.lower() not in text.lower():
            bad.append(f"must_contain {s!r} absent")
    for s in spec.get("must_not_contain") or []:
        if s.lower() in text.lower():
            bad.append(f"must_not_contain {s!r} present")
    if "max_chars" in spec and len(text) > spec["max_chars"]:
        bad.append(f"over max_chars {spec['max_chars']}")
    return bad


def check_probes(suite_dir, tasks_by_id):
    path = suite_dir / "probes.json"
    if not path.exists():
        warn(suite_dir.name, "no probes.json — text checks are unverified")
        return
    doc = load(path)
    if doc is None:
        return
    where = f"{suite_dir.name}/probes.json"
    probes = doc.get("probes") or {}
    for task_id, blocks in probes.items():
        task = tasks_by_id.get(task_id)
        if task is None:
            err(where, f"probe for unknown task {task_id!r}")
            continue
        contract = task.get("contract") or {}
        for field, sample in blocks.items():
            if field == "final_text":
                spec = contract.get("final_text") or {}
            elif field == "write_content":
                spec = (contract.get("memory") or {}).get("write_content") or {}
            else:
                err(where, f"{task_id}: unknown probe field {field!r}")
                continue
            if not spec:
                err(where, f"{task_id}: probes {field} but the contract has no "
                           f"{field} checks")
                continue
            counts["probes"] += 1
            bad = _text_violations(spec, sample.get("golden", ""))
            if bad:
                err(where, f"{task_id}.{field}: GOLDEN sample fails — " + "; ".join(bad))
            if "bad" in sample and not _text_violations(spec, sample["bad"]):
                err(where, f"{task_id}.{field}: BAD sample passes every check — "
                           f"the checks do not catch what this task is about")

    # any contract text check without a probe is unverified
    for task_id, task in tasks_by_id.items():
        contract = task.get("contract") or {}
        has = []
        if contract.get("final_text"):
            has.append("final_text")
        if (contract.get("memory") or {}).get("write_content", {}).keys() - {"max_chars"}:
            has.append("write_content")
        for field in has:
            if field not in (probes.get(task_id) or {}):
                warn(where, f"{task_id}: {field} checks have no probe")


def check_suite(suite_dir):
    counts["suites"] += 1
    suite_path = suite_dir / "suite.json"
    if not suite_path.exists():
        err(suite_dir.name, "no suite.json")
        return
    suite = load(suite_path)
    if suite is None:
        return
    where = f"{suite_dir.name}/suite.json"

    if suite.get("suite") != suite_dir.name:
        err(where, f"'suite' is {suite.get('suite')!r} but the directory is "
                   f"{suite_dir.name!r}")
    agent = suite.get("agent")
    if agent not in GRANTED:
        warn(where, f"agent {agent!r} has no known toolset here — tool-name "
                    f"checks are skipped for this suite")
        agent = None
    if suite.get("execution_class") not in ("live-tool", "replay-only"):
        err(where, f"bad execution_class {suite.get('execution_class')!r}")
    run = suite.get("run") or {}
    rounds = run.get("max_tool_rounds")
    if not isinstance(rounds, int) or not 1 <= rounds <= 50:
        err(where, f"run.max_tool_rounds {rounds!r} outside the setting's 1-50 range")
    for name in (run.get("exclude_tools") or []) + (run.get("replay_only_tools") or []):
        if agent and name not in GRANTED[agent]:
            err(where, f"run lists {name!r}, which {agent} is not granted anyway")
    excluded = set(run.get("exclude_tools") or [])

    listed = suite.get("tasks") or []
    on_disk = sorted(p.stem for p in (suite_dir / "tasks").glob("*.json"))
    if sorted(listed) != on_disk:
        err(where, f"suite.tasks {sorted(listed)} does not match tasks/ on disk {on_disk}")

    tasks_by_id = {}
    for task_id in listed:
        path = suite_dir / "tasks" / f"{task_id}.json"
        if not path.exists():
            continue
        counts["tasks"] += 1
        task = load(path)
        if task is None:
            continue
        tasks_by_id[task_id] = task
        tw = f"{suite_dir.name}/tasks/{task_id}.json"

        if task.get("id") != task_id:
            err(tw, f"'id' is {task.get('id')!r} but the filename says {task_id!r}")
        if task.get("suite") != suite_dir.name:
            err(tw, f"'suite' is {task.get('suite')!r}")
        if ("prompt" in task) == ("prompt_file" in task):
            err(tw, "exactly one of prompt / prompt_file is required")
        if "prompt_file" in task and not (suite_dir / task["prompt_file"]).exists():
            err(tw, f"prompt_file {task['prompt_file']} does not exist")
        for rel in task.get("seed_corpus") or []:
            if not rel.startswith("corpus/"):
                err(tw, f"seed_corpus entry {rel} must live under corpus/")
            if not (suite_dir / rel).exists():
                err(tw, f"seed_corpus file {rel} does not exist")
        for rel in task.get("fixtures") or []:
            check_fixture(suite_dir, rel, agent)

        contract = task.get("contract")
        if not contract:
            err(tw, "no contract")
        else:
            check_contract(tw, contract, agent)
            for name in [i.get("name") for i in (contract.get("tools", {}).get("must_call") or [])]:
                if name in excluded:
                    err(tw, f"must_call {name!r} but the suite excludes it from the toolset")
            rmax = contract.get("rounds_max")
            if isinstance(rmax, int) and isinstance(rounds, int) and rmax > rounds:
                err(tw, f"rounds_max {rmax} exceeds the suite's pinned "
                        f"max_tool_rounds {rounds}")

        judge = task.get("judge")
        if not judge or not judge.get("dimensions"):
            err(tw, "no judge dimensions")

        # every fixture a task's contract leans on should be declared
        declared_tools = set()
        for rel in task.get("fixtures") or []:
            fx = load(suite_dir / rel) if (suite_dir / rel).exists() else None
            if fx:
                declared_tools.add(fx.get("tool"))
        replay_only = set(run.get("replay_only_tools") or [])
        for item in (contract or {}).get("tools", {}).get("must_call") or []:
            name = item.get("name")
            if name in replay_only and name not in declared_tools:
                warn(tw, f"must_call {name!r} is replay-only with no fixture — "
                         f"every call will get replay_only_default")

    check_probes(suite_dir, tasks_by_id)


def main():
    for suite_dir in sorted(p for p in ROOT.iterdir() if p.is_dir()):
        check_suite(suite_dir)

    for w in warnings:
        print(f"warn  {w}")
    for e in errors:
        print(f"ERROR {e}")
    print(f"\n{counts['suites']} suites, {counts['tasks']} tasks, "
          f"{counts['fixtures']} fixture refs, {counts['regexes']} regexes, "
          f"{counts['probes']} probe pairs checked")
    print(f"{len(errors)} error(s), {len(warnings)} warning(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
