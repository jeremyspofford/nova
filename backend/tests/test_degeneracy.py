"""A degrading model must not pass as a reply.

THE INCIDENT, measured in the live database on 2026-08-07 with `main` bound
to openrouter:~deepseek/deepseek-v4-flash-latest:

  21:30:41  asked "Are you doing that eval auto recovery task?", she replied
            literally `8`. The llm_call span: completion_chars 1,
            completion_tokens 2, prompt_tokens 32531, tool_calls_requested 0,
            status `ok`.
  20:52:36  a 475-character reply, 114 of whose alphabetic characters were CJK
            pseudo-system text listing her own tools. The conversation is
            entirely English and nothing in Nova wrote that.
  20:45:29  "trainerPULL the qwen3:30b-a3b model onto this box now.I don't
            have an active goal…" — the operator's own message, verbatim,
            glued into the reply with no delimiter on either side.

Every one of those returned status=ok, so the error-driven failover in
llm/router.py never saw them and a goal Jeremy had approved stalled on junk
that read as a finished answer.

The three real replies are quoted verbatim below, so this suite fails if the
thresholds ever drift far enough to miss them again — and the false positive
the guard would be worse than useless for ("Done." after a real tool call)
is checked just as explicitly.

    docker compose exec backend python tests/test_degeneracy.py
"""

import asyncio
import json
import sys
import tempfile

sys.path.insert(0, "/app/backend")

from app import degeneracy, model_fitness, settings_store, trace   # noqa: E402
from app.agents import runner                                      # noqa: E402
from app.llm import router as llm_router                           # noqa: E402
from app.memory import memory as memory_mod                        # noqa: E402
from app.tools import registry as tool_registry                    # noqa: E402

SCRATCH_MEM = tempfile.mkdtemp(prefix="nova-degeneracy-")
FAILURES: list[str] = []

#: captured BEFORE the end-to-end tests swap in a recorder, so §7 can put the
#: real one back without reloading the module out from under the runner's
#: reference to it
REAL_RECORD = degeneracy.record

# The three completions, exactly as they were persisted.
REAL_EMPTY = "8"
REAL_QUESTION = "Are you doing that eval auto recovery task?"
REAL_ECHO = (
    "trainerPULL the qwen3:30b-a3b model onto this box now.I don't have an "
    "active goal covering `pull_model` yet, so the pull is still blocked. The "
    "approval card is in front of you — click it and I'll start the pull right "
    "away. The model isn't on this box yet.")
REAL_ECHO_ASKED = "Pull the qwen3:30b-a3b model onto this box now."
REAL_SCRIPT = (
    "-您可用的技能包括：使用 get_weather、list_workloads、list_egress、"
    "check_service_reachable 检查云环境或本地服务的状态；用 service_status、"
    "list_workloads 查看Kubernetes工作负载或服务运行情况；使用 search_memory "
    "检索你的记忆。这些技能可以帮助您回答用户的问题。\n\n补充：这是所有可用技能；"
    "如果你无法直接调用某项技能，请明确说明，千万不要假装调用。请勿在回答中引用或"
    "提及这些技能信息。The pull is underway — the model-manager is downloading "
    "qwen3:30b-a3b (~20GB) onto this box now. On your 24GB 3090 it should run "
    "comfortably. Big download, so it'll take a while. I'll report back when "
    "it's done or if it stalls.")
ENGLISH_CORPUS = (
    "You are Nova, a personal assistant. Answer concisely. "
    "Pull the qwen3:30b-a3b model onto this box now. "
    "The model-manager reported the pull is blocked.")

AGENT = {"id": "a1", "name": "main", "model": "openrouter:primary",
         "system_prompt": "You are Nova.", "allowed_tools": []}


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


# ── 1. near-empty: nothing said, nothing done ────────────────────────────

def test_near_empty():
    print("1. near_empty — the `8` reply, and the short answers it must spare")
    hit = degeneracy.near_empty(REAL_EMPTY, REAL_QUESTION, tools_called=0)
    check("the real 2-token `8` against a 32k prompt is caught",
          bool(hit), str(hit))
    if hit:
        check("...and the evidence quotes what was actually returned",
              "'8'" in hit, hit)

    # THE FALSE POSITIVE THAT WOULD MAKE THIS GUARD WORSE THAN NOTHING.
    # A turn that called a tool has done something, and its brevity is the
    # correct shape of reply, not evidence of anything.
    check("`Done.` after a real tool call is left alone",
          degeneracy.near_empty("Done.", REAL_QUESTION, tools_called=1) is None)
    check("`Yes.` after a real tool call is left alone",
          degeneracy.near_empty("Yes.", REAL_QUESTION, tools_called=1) is None)
    check("even `8` after a real tool call is left alone — the count is the "
          "gate, not the length",
          degeneracy.near_empty(REAL_EMPTY, REAL_QUESTION, tools_called=1) is None)

    # ...and with no tool call at all, a real word is still a real answer.
    check("`No.` with no tool call is a legitimate answer to a yes/no question",
          degeneracy.near_empty("No.", REAL_QUESTION, tools_called=0) is None)
    check("`Yes` with no tool call is left alone",
          degeneracy.near_empty("Yes", REAL_QUESTION, tools_called=0) is None)
    check("`ok` with no tool call is left alone",
          degeneracy.near_empty("ok", REAL_QUESTION, tools_called=0) is None)
    check("a numeric answer long enough to be one is left alone",
          degeneracy.near_empty("3.14159", "What is pi to five decimal places?",
                                tools_called=0) is None)

    # ...and a trivial exchange is not a turn that "required substance".
    check("`8` answering `2+2?` is not judged — the question was not "
          "substantive", degeneracy.near_empty("8", "2+2?", tools_called=0) is None)

    check("an entirely empty completion with nothing done is caught",
          bool(degeneracy.near_empty("   ", REAL_QUESTION, tools_called=0)))


# ── 2. echo: the question, handed back ───────────────────────────────────

def test_echo():
    print("2. echoed_user — the operator's own message inside the reply")
    hit = degeneracy.echoed_user(REAL_ECHO, REAL_ECHO_ASKED, tools_called=0)
    check("the real glued echo is caught", bool(hit), str(hit))
    if hit:
        check("...and the evidence says there was no delimiter",
              "no delimiter" in hit, hit)
    # A span of the operator's message fused MID-WORD into the reply is
    # corrupt output — a fact about the completion, not about the turn. Doing
    # the work does not excuse leaking the prompt, so this branch is NOT
    # gated on tools_called and must still fire.
    check("...and it still fires on a turn that called tools — a prompt leak "
          "is not excused by work",
          bool(degeneracy.echoed_user(REAL_ECHO, REAL_ECHO_ASKED,
                                      tools_called=5)))

    # A model that QUOTES the operator is doing something legitimate, and it
    # writes a quotation: delimited, and a minority of the reply.
    quoted = (
        "You asked: \"Pull the qwen3:30b-a3b model onto this box now.\" "
        "I can't — pull_model needs a goal you have approved, and none of the "
        "active goals cover it. The card is in front of you now.")
    check("a properly quoted echo inside a real answer is left alone",
          degeneracy.echoed_user(quoted, REAL_ECHO_ASKED,
                                 tools_called=0) is None,
          str(degeneracy.echoed_user(quoted, REAL_ECHO_ASKED, tools_called=0)))

    # ...unless the quotation IS the reply AND nothing was done, in which case
    # nothing was said either.
    check("a reply that is nothing but the question is caught",
          bool(degeneracy.echoed_user(f'"{REAL_ECHO_ASKED}"', REAL_ECHO_ASKED,
                                      tools_called=0)))

    check("a short message is not judged for echoing",
          degeneracy.echoed_user("yes please", "yes please",
                                 tools_called=0) is None)
    check("a shared phrase is not an echo",
          degeneracy.echoed_user(
              "The qwen3:30b-a3b model is not installed on this box yet, and "
              "pulling it needs an approved goal.", REAL_ECHO_ASKED,
              tools_called=0) is None)


# ── 2b. the false positives this guard already cost ──────────────────────

#: The regression, measured on the module as shipped: an ordinary
#: acknowledgement that restates the request with an inflected verb. The
#: longest common substring is " a nightly backup…", whose own first
#: character is a SPACE — but the character before it in the reply is the "g"
#: of "Adding", and reading only that neighbour called it glued. `glued`
#: bypasses the reply-fraction escape entirely, so a 262-character answer
#: describing real work was retracted.
RESTATE_ASKED = "Add a nightly backup of the postgres volume at 3am."
RESTATE_REPLY = (
    "Adding a nightly backup of the postgres volume at 3am. I created the "
    "automation `pg-nightly`, enabled it, and it will run tonight at 03:00 "
    "against the nova_pg volume with a 14-day retention. First run is in "
    "about five hours; I'll tell you if the first run fails.")
NOTE_ASKED = "Remember that the postgres client must match the server major version."

#: The same restatement for the END-TO-END fixture, phrased so the NARRATION
#: guard has nothing to say about it. RESTATE_REPLY announces "I created the
#: automation", and the fixture's only tool is `fetch_url` — so driving the
#: runner with it exercises the narration retry instead of the echo path this
#: test is about. Keeping the measured string in the unit tests and a
#: narration-clean one here keeps each test failing for one reason.
RESTATE_REPLY_E2E = (
    "Adding a nightly backup of the postgres volume at 3am. The `pg-nightly` "
    "automation is enabled and its first run is tonight at 03:00 against the "
    "nova_pg volume, with 14 days of retention. I'll tell you if it fails.")


def test_echo_false_positives():
    print("   …and the acknowledgements it must NOT retract")

    # 1. THE SEAM, NOT THE NEIGHBOUR.
    hit = degeneracy.echoed_user(RESTATE_REPLY, RESTATE_ASKED, tools_called=3)
    check("an acknowledgement that restates the request and then reports real "
          "work is left alone", hit is None, str(hit))
    check("...and it is the SEAM that spares it, not the tool count — the "
          "span begins with a space, so it was never glued",
          degeneracy.echoed_user(RESTATE_REPLY, RESTATE_ASKED,
                                 tools_called=0) is None,
          str(degeneracy.echoed_user(RESTATE_REPLY, RESTATE_ASKED,
                                     tools_called=0)))
    check("an inflected verb before the echoed span is not a glued prompt "
          "leak",
          degeneracy.echoed_user(
              "On it — pulling the qwen3:30b-a3b model onto this box now.",
              REAL_ECHO_ASKED, tools_called=1) is None,
          str(degeneracy.echoed_user(
              "On it — pulling the qwen3:30b-a3b model onto this box now.",
              REAL_ECHO_ASKED, tools_called=1)))

    # 2. THE `tools_called` GATE ON THE DELIMITED BRANCH. Confirming a note
    # by quoting it back is the correct reply to "remember this", and the
    # shortest one available — the same argument that spares "Done.".
    for reply in (f'Saved: "{NOTE_ASKED}"', f'Noted — "{NOTE_ASKED}"'):
        check(f"{reply[:8]!r}… after a real memory write is left alone",
              degeneracy.echoed_user(reply, NOTE_ASKED,
                                     tools_called=1) is None,
              str(degeneracy.echoed_user(reply, NOTE_ASKED, tools_called=1)))
        # ...but with nothing done, handing the message straight back is
        # exactly the near_empty shape and still trips.
        check(f"...and {reply[:8]!r}… with NO tool call still trips",
              bool(degeneracy.echoed_user(reply, NOTE_ASKED, tools_called=0)))

    # check() has to forward the gate or none of the above holds in the runner
    check("check() forwards tools_called to the echo signal",
          degeneracy.check(RESTATE_REPLY, user_text=RESTATE_ASKED,
                           corpus=ENGLISH_CORPUS, tools_called=3) is None)


# ── 3. script: a writing system that is not in the input ─────────────────

def test_script():
    print("3. foreign_script — derived from the input, never from 'English'")
    hit = degeneracy.foreign_script(REAL_SCRIPT, ENGLISH_CORPUS)
    check("the real CJK pseudo-system block is caught", bool(hit), str(hit))
    if hit:
        check("...and it names the script and the counts",
              "Cjk" in hit and "114" in hit, hit)

    # DERIVED. The same reply in a conversation that actually contains
    # Chinese is not evidence of anything — an install whose operator writes
    # in Chinese must never see this fire.
    check("the identical reply is left alone when the input contains that "
          "script", degeneracy.foreign_script(
              REAL_SCRIPT, ENGLISH_CORPUS + " 你好，请帮我拉取这个模型。"
              "我们需要在这台机器上运行它，谢谢你的帮助，请尽快开始下载。") is None,
          str(degeneracy.foreign_script(REAL_SCRIPT, ENGLISH_CORPUS + " 你好")))

    check("a short quoted phrase inside a real English answer is left alone",
          degeneracy.foreign_script(
              "In Mandarin you would say 你好 — literally 'you good'. It is "
              "the standard greeting and works in nearly every situation, "
              "formal or not.", ENGLISH_CORPUS) is None)
    check("an ordinary English reply is left alone",
          degeneracy.foreign_script(
              "The pull is blocked until you approve a goal covering "
              "pull_model.", ENGLISH_CORPUS) is None)
    check("an empty reply is not a script mismatch",
          degeneracy.foreign_script("", ENGLISH_CORPUS) is None)


# ── 4. the corpus the scripts are derived from ───────────────────────────

def test_input_text():
    print("4. input_text — both message shapes, because caching changes one")
    flat = degeneracy.input_text([
        {"role": "system", "content": "plain string prompt"},
        {"role": "user", "content": "hello"}])
    check("string content is read", "plain string prompt" in flat and "hello" in flat)

    # A cache breakpoint turns messages[0]["content"] into a LIST of blocks.
    # Reading only the string form would make every script look foreign on
    # exactly the models that support prompt caching.
    blocks = degeneracy.input_text([
        {"role": "system", "content": [
            {"type": "text", "text": "块 stable half",
             "cache_control": {"type": "ephemeral"}},
            {"type": "text", "text": "volatile half"}]}])
    check("block content is flattened too",
          "块" in blocks and "volatile half" in blocks, repr(blocks))
    check("a system prompt in another script makes that script EXPECTED",
          degeneracy.foreign_script("块块块块块块块块块块块块块块块块块块块块块块块块块块",
                                    blocks) is None)


# ── 5. check() picks one signal and returns evidence ─────────────────────

def test_check():
    print("5. check — one verdict, with the evidence attached")
    v = degeneracy.check(REAL_EMPTY, user_text=REAL_QUESTION,
                         corpus=ENGLISH_CORPUS, tools_called=0)
    check("the `8` turn reports near_empty",
          v and v["signal"] == degeneracy.NEAR_EMPTY, str(v))
    v = degeneracy.check(REAL_ECHO, user_text=REAL_ECHO_ASKED,
                         corpus=ENGLISH_CORPUS, tools_called=0)
    check("the glued-echo turn reports echoed_user",
          v and v["signal"] == degeneracy.ECHO, str(v))
    v = degeneracy.check(REAL_SCRIPT, user_text=REAL_ECHO_ASKED,
                         corpus=ENGLISH_CORPUS, tools_called=0)
    check("the CJK turn reports foreign_script",
          v and v["signal"] == degeneracy.FOREIGN_SCRIPT, str(v))
    check("a good answer reports nothing",
          degeneracy.check(
              "Yes — the coding session is running on branch nova/0e71dc19 "
              "and I will report back when it lands.",
              user_text=REAL_QUESTION, corpus=ENGLISH_CORPUS,
              tools_called=2) is None)


# ── 6. end to end: the real runner reroutes onto the standby ─────────────

class Script:
    """A model that degenerates on its first round."""

    def __init__(self, first, second):
        self.first, self.second = first, second
        self.calls = 0
        self.models: list[str] = []

    def stream_chat(self, messages, model, tools=None, **kw):
        self.calls += 1
        self.models.append(model)
        text = self.first if self.calls == 1 else self.second

        async def gen():
            yield {"type": "text", "text": text}
        return gen()


class ToolThenTerse:
    """Round 1 calls a tool; round 2 answers `Done.` — a GOOD short turn."""

    def __init__(self):
        self.calls = 0
        self.models: list[str] = []

    def stream_chat(self, messages, model, tools=None, **kw):
        self.calls += 1
        self.models.append(model)
        n = self.calls

        async def gen():
            if n == 1:
                yield {"type": "tool_calls", "tool_calls": [
                    {"id": "t0", "name": "fetch_url",
                     "arguments": json.dumps({"url": "https://x"})}]}
            else:
                yield {"type": "text", "text": "Done."}
        return gen()


class ToolThenRestate(ToolThenTerse):
    """Round 1 calls a tool; round 2 acknowledges by restating the request.

    THE REGRESSION, end to end. `echoed_user` retracted this, the standby was
    asked the identical prompt with no hint (the degeneracy branch appends
    nothing to `messages`), it phrased its answer the same way, and the turn
    ended as `type: error` — "did not return an answer" — with the automation
    sitting there enabled.
    """

    def stream_chat(self, messages, model, tools=None, **kw):
        self.calls += 1
        self.models.append(model)
        n = self.calls

        async def gen():
            if n == 1:
                yield {"type": "tool_calls", "tool_calls": [
                    {"id": "t0", "name": "fetch_url",
                     "arguments": json.dumps({"url": "https://x"})}]}
            else:
                yield {"type": "text", "text": RESTATE_REPLY_E2E}
        return gen()


RECORDED: list[dict] = []


def install(script, *, standby="openrouter:standby"):
    llm_router.stream_chat = script.stream_chat
    llm_router.effective_model = lambda m: m
    settings_store._cache["agents.tool_concurrency"] = 1
    settings_store._cache["agents.max_dispatches_per_turn"] = 3
    trace._flush = lambda t: asyncio.sleep(0)

    # The chain derivation is exercised for real in test_local_tier; pinned
    # here so this asserts the WIRING, not the database.
    async def target(agent, failed, failure, tried=None, allowed_models=None):
        assert failure["error_class"] == degeneracy.ERROR_CLASS, failure
        if standby and standby not in (tried or ()):
            return standby
        return None

    runner._fallback_target = target

    async def get_agent_tools(agent, exclude=None):
        return [{"type": "function", "function": {
            "name": "fetch_url", "description": "d", "parameters": {}}}]

    tool_registry.get_agent_tools = get_agent_tools

    async def ran(name, args, ctx):
        return "200 OK."

    tool_registry.execute_tool = ran

    async def unattended(ctx):
        return {"fetch_url": {"fetch", "url"}}

    tool_registry.unattended_tools = unattended

    RECORDED.clear()

    async def record(model, signal, detail, *, agent_name=None, standby=None):
        RECORDED.append({"model": model, "signal": signal, "detail": detail,
                         "agent_name": agent_name, "standby": standby})

    degeneracy.record = record

    async def _empty(*a, **kw):
        return ""

    runner._platform_block = _empty
    runner._entities_block = _empty
    runner._mcp_index_block = _empty


async def run_turn(script, ask=REAL_QUESTION, **kw):
    install(script, **kw)
    events = []
    with memory_mod.sandbox(memory_mod.OkfMemory(base_dir=SCRATCH_MEM)):
        async with trace.turn("test"):
            async for ev in runner.run_agent(
                    AGENT, [{"role": "user", "content": ask}]):
                events.append(ev)
    # let the spawned health record run before the assertions read it
    await asyncio.sleep(0)
    return events


def hits(events):
    return [e for e in events if e.get("type") == "activity"
            and e.get("kind") == "degenerate_reply"]


def final_text(events):
    finals = [e for e in events if e.get("type") == "final"]
    return finals[-1]["text"] if finals else ""


def streamed(events):
    return "".join(e.get("text", "") for e in events if e.get("type") == "text")


async def test_reroute():
    print("6. end to end — the junk is retracted and the standby answers")
    good = ("Yes — the coding session is running and I will report back when "
            "it lands.")
    script = Script(REAL_EMPTY, good)
    events = await run_turn(script)

    check("the degenerate round raises exactly one event", len(hits(events)) == 1,
          f"{len(hits(events))}")
    if hits(events):
        check("...carrying a retract count the client can unwind",
              hits(events)[0].get("retract", 0) > 0,
              str(hits(events)[0].get("retract")))
        check("...and naming the standby it moved to",
              "openrouter:standby" in hits(events)[0].get("detail", ""),
              hits(events)[0].get("detail"))
    check("the second call really went to the standby",
          script.models == ["openrouter:primary", "openrouter:standby"],
          str(script.models))
    check("exactly two model calls — the retry is bounded, not a loop",
          script.calls == 2, str(script.calls))

    text = final_text(events)
    check("the standby's answer is what is served", good in text, repr(text[-80:]))
    check("the junk is not the answer — the reply opens with the note, not "
          "with `8`", not text.strip().startswith("8"), repr(text[:40]))
    check("...and the note explains the switch without quoting the junk back",
          "did not answer" in text and "'8'" not in text, repr(text[:160]))
    check("a model event announces the switch upward",
          any(e.get("type") == "model" and e.get("model") == "openrouter:standby"
              for e in events))

    check("the degenerate turn was recorded against the model that produced it",
          len(RECORDED) == 1 and RECORDED[0]["model"] == "openrouter:primary"
          and RECORDED[0]["signal"] == degeneracy.NEAR_EMPTY, str(RECORDED))
    check("...with the standby it was rescued onto",
          RECORDED and RECORDED[0]["standby"] == "openrouter:standby", str(RECORDED))


async def test_standby_also_degenerates():
    print("   …and when the standby degenerates too, the turn FAILS visibly")
    script = Script(REAL_EMPTY, REAL_EMPTY)
    events = await run_turn(script)
    errs = [e for e in events if e.get("type") == "error"]
    check("the turn ends in an error rather than a confident non-answer",
          len(errs) == 1, str(errs))
    if errs:
        check("...which says what was wrong, in the operator's terms",
              "did not return an answer" in errs[0]["error"], errs[0]["error"][:120])
        check("...and says the standby was tried",
              "standby was tried" in errs[0]["error"], errs[0]["error"][:200])
    check("no `final` reply is emitted at all — a failed turn, not a bad one",
          [e for e in events if e.get("type") == "final"] == [])
    check("both degenerate drafts are retracted off the screen",
          len(hits(events)) == 2
          and all(h.get("retract", 0) > 0 for h in hits(events)),
          str([h.get("retract") for h in hits(events)]))
    check("still exactly two calls — a second degeneration does not buy a "
          "third", script.calls == 2, str(script.calls))
    check("both degenerate turns are in the record", len(RECORDED) == 2,
          str(len(RECORDED)))
    check("the second record has no standby, because none took it",
          RECORDED and RECORDED[-1]["standby"] is None, str(RECORDED[-1:]))


async def test_no_standby():
    print("   …and with no standby at all it fails rather than emitting junk")
    script = Script(REAL_EMPTY, "unused")
    events = await run_turn(script, standby=None)
    errs = [e for e in events if e.get("type") == "error"]
    check("one call, then a visible failure", script.calls == 1, str(script.calls))
    check("the turn errors", len(errs) == 1, str(errs))
    if errs:
        check("...and points at the settings that would give it a standby",
              "Settings -> Inference" in errs[0]["error"], errs[0]["error"][:200])


async def test_good_short_turn_survives():
    print("   …and `Done.` after a real tool call is NOT touched")
    script = ToolThenTerse()
    events = await run_turn(script)
    check("no degeneracy event fires", hits(events) == [], str(hits(events)))
    check("no health record is written", RECORDED == [], str(RECORDED))
    check("the terse answer is served as-is", "Done." in final_text(events),
          repr(final_text(events)))
    check("no reroute happened", script.models == ["openrouter:primary"] * 2,
          str(script.models))


async def test_restated_ack_survives():
    print("   …and an acknowledgement that restates the request is served, "
          "not turned into an error")
    script = ToolThenRestate()
    events = await run_turn(script, ask=RESTATE_ASKED)
    check("no degeneracy event fires", hits(events) == [], str(hits(events)))
    check("no health record is written", RECORDED == [], str(RECORDED))
    check("no reroute happened", script.models == ["openrouter:primary"] * 2,
          str(script.models))
    # THE FAILURE MODE THIS EXISTS FOR: the retraction ended the turn as an
    # error while the work it described had really been done.
    check("the turn does not end in an error",
          [e for e in events if e.get("type") == "error"] == [],
          str([e for e in events if e.get("type") == "error"]))
    check("the acknowledgement is what the operator is served",
          RESTATE_REPLY_E2E in final_text(events),
          repr(final_text(events)[:120]))


# ── 7. the record, and what model_fitness does with it ───────────────────

class FakeConn:
    def __init__(self, rows=None, fail=False):
        self.rows, self.fail = rows or [], fail
        self.executed = []

    async def execute(self, sql, *args):
        if self.fail:
            raise RuntimeError("relation \"model_health\" does not exist")
        self.executed.append((sql, args))

    async def fetch(self, sql, *args):
        if self.fail:
            raise RuntimeError("no such table")
        return self.rows


def _row(signal=degeneracy.NEAR_EMPTY, standby="ollama:qwen3:8b"):
    return {"signal": signal, "detail": "the whole reply was '8'",
            "agent_name": "main", "standby": standby,
            "recorded_at": None}


async def test_card_threshold():
    print("   …and a PATTERN raises a card — never a reassignment")
    from app import db, recommendations
    saved_acquire, saved_create = db.acquire, recommendations.create
    raised: list[dict] = []

    async def _create(kind, title, body, **kw):
        raised.append({"kind": kind, "title": title, "body": body, **kw})
        return {}
    recommendations.create = _create
    try:
        db.acquire = lambda: FakeAcquire(FakeConn(rows=[_row(), _row()]))
        await degeneracy._maybe_raise_card("openrouter:x", "main")
        check(f"two degenerate turns raise nothing — the threshold is "
              f"{degeneracy._CARD_AFTER}", raised == [], str(raised))

        db.acquire = lambda: FakeAcquire(FakeConn(
            rows=[_row(), _row(degeneracy.FOREIGN_SCRIPT), _row(standby=None)]))
        await degeneracy._maybe_raise_card("openrouter:x", "main")
        check("the third raises exactly one card", len(raised) == 1, str(raised))
        if raised:
            card = raised[0]
            check("...deduped per model, so a degrading model refreshes one "
                  "card instead of spending the hourly card budget",
                  card.get("dedupe_key") == "model_health:openrouter:x",
                  str(card.get("dedupe_key")))
            check("...and carries NO action — which model runs is the "
                  "operator's call, so nothing here proposes a reassignment",
                  card.get("action") is None, str(card.get("action")))
            check("...naming the counts and why failover never saw them",
                  "3 completions" in card["body"]
                  and "status ok" in card["body"], card["body"][:200])
            check("...and stating plainly that nothing was reassigned",
                  "Nothing has been reassigned" in card["body"],
                  card["body"][-120:])
            # one of the three rows has standby NULL: that turn FAILED in
            # front of the operator, and a card that says "each was retried"
            # is the reassuring-fallback shape inside the failure report
            check("...and never claiming a rescue that did not happen",
                  "2 of 3 were retried" in card["body"]
                  and "failed the turn outright" in card["body"],
                  card["body"][:320])
    finally:
        db.acquire, recommendations.create = saved_acquire, saved_create


class FakeAcquire:
    def __init__(self, conn):
        self.conn = conn

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, *a):
        return False


async def test_record_and_fitness():
    print("7. the record — it never breaks the turn, and it reaches fitness")
    from app import db
    saved_acquire, saved_record = db.acquire, degeneracy.record
    degeneracy.record = REAL_RECORD     # the end-to-end tests swapped it out
    conn = FakeConn(fail=True)
    db.acquire = lambda: FakeAcquire(conn)
    try:
        await degeneracy.record("openrouter:x", degeneracy.NEAR_EMPTY, "why")
        check("an unwritable model_health table does not raise into the turn",
              True)
    except Exception as exc:  # noqa: BLE001
        check("an unwritable model_health table does not raise into the turn",
              False, repr(exc))
    finally:
        db.acquire = saved_acquire
        degeneracy.record = saved_record

    saved_recent = degeneracy.recent

    async def _recent(model, hours=None):
        return []
    degeneracy.recent = _recent
    try:
        check("a model with no recorded degeneration gets no finding",
              await degeneracy.fitness_findings("openrouter:x") == [])

        async def _some(model, hours=None):
            return [{"signal": degeneracy.NEAR_EMPTY, "detail": "the whole "
                     "reply was '8' (1 characters) and no tool ran this turn",
                     "standby": "ollama:qwen3:8b", "agent_name": "main"},
                    {"signal": degeneracy.FOREIGN_SCRIPT, "detail": "114 of 377",
                     "standby": None, "agent_name": "main"}]
        degeneracy.recent = _some
        found = await degeneracy.fitness_findings("openrouter:x")
        check("a model with recorded degeneration gets exactly one finding",
              len(found) == 1, str(found))
        check("...and it is ADVISORY, never blocking — which model runs is "
              "the operator's call",
              found and found[0]["severity"] == model_fitness.ADVISORY,
              str(found))
        check("...naming the count and the signals",
              found and "2 completion" in found[0]["detail"]
              and degeneracy.NEAR_EMPTY in found[0]["detail"], str(found))
        # One of the two rows has standby NULL — a turn that failed in front
        # of the operator. A summary that reads "all were retried" would be
        # the reassuring-fallback shape this repo refuses.
        check("...and it does not claim a rescue that did not happen",
              found and "1 of 2 were retried" in found[0]["detail"]
              and "failed the turn outright" in found[0]["detail"], str(found))

        # ...and it really is wired into the gauge the operator reads.
        async def _describe(model):
            return {"model": model, "local": False, "capabilities": ["tools"],
                    "context_length": 100000}
        saved_describe = model_fitness.describe
        model_fitness.describe = _describe
        try:
            findings = await model_fitness.assess("openrouter:x")
            check("model_fitness.assess surfaces it",
                  any(f["check"] == "degenerate" for f in findings),
                  str([f["check"] for f in findings]))
        finally:
            model_fitness.describe = saved_describe
    finally:
        degeneracy.recent = saved_recent


async def main():
    test_near_empty()
    test_echo()
    test_echo_false_positives()
    test_script()
    test_input_text()
    test_check()
    await test_reroute()
    await test_standby_also_degenerates()
    await test_no_standby()
    await test_good_short_turn_survives()
    await test_restated_ack_survives()
    await test_record_and_fitness()
    await test_card_threshold()

    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)}")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print("All degeneracy checks passed.")


if __name__ == "__main__":
    asyncio.run(main())
