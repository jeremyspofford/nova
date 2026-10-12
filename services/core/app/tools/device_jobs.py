"""Jobs on her machines (S30c): work that outlives her turn.

device_run waits for its command (at most 110 s) and is answered in the same
call. A job is handed to the machine's agent and left running: the agent's
`job.start` spawns a detached `novad job-exec` wrapper that owns the log and
writes the terminal record (state, exit code) to disk, and the agent sends
that record back in a `job` frame whenever it ends (app/device_jobs.py stores
it). Nothing here waits for the job.

device_job_start (T10), in order:
  1. _admit — paired, connected (tools/devices.py, the one place the order
     lives); then env and cwd are checked like device_run's. A job's cwd is
     an absolute path: the agent's job.start does not resolve @folders.
  2. the route — device_run's `_box_route`: on the machine holding her
     repository a cwd inside .worktrees/nova-<id> starts the job INSIDE that
     change's box (spec s32 §4.4; the agent brings the box up, a whole suite
     holds the CPU lock), never a fallback to the host; the owner's
     `environment host` starts it on the host and says so.
  3. the row — written BEFORE the send (state `starting`, the turn that
     started it, env NAMES only), and its id is the job id on the wire.
  4. the agent's answer moves the row: launched -> running / waiting_lock
     (only off `starting`: a quick job's end stored first is kept); ok:false
     -> failed_to_start with the agent's reason; no answer -> it stays
     `starting` with a reason saying the start was not confirmed.

Every answer files ONE `job` fact {id, state, device, argv, cwd, ran_in,
box?} — never a `run` fact: a started job has no exit code, so nothing reads
it as a command that ran to an end (device_job_status files that, T11).
device_job_status / device_job_log / device_job_stop (T11) read the agent
NOW — job.status, job.log, job.stop — never the stored row. A status or stop
answer is checked (job_rows.parse_status), stored on THAT device's row
(job_rows.apply_status: an end overwrites, a live state never reopens an
ended row), and filed as ONE `job` fact plus, once the job ran to its end
(`done` with a start — a stopped or lost job did not), ONE `run` fact
{exit_code, device, argv, cwd, ran_in, box?, job}: the tests_passed /
ran_command guards read a job's end exactly as they read device_run's.
Status without a job is the agent's job.list, a summary: it writes no row and
files no fact.

Nothing here asks or refuses on the owner's behalf (09-03): every refusal
states that the call CANNOT run.
"""

from __future__ import annotations

from app import device_facts
from app import device_jobs as job_rows
from app.tools import devices
from app.tools.base import Tool, ToolContext, ToolFailure

JOB_START = "job.start"
# The fact key a job call files (chat._run_tool lifts it to span.meta).
JOB_FACT = "job"
NOTHING_STARTED = "nothing was started"


def predates_jobs_words(name: str, nothing: str = NOTHING_STARTED) -> str:
    return f"{name}'s agent predates jobs — update it with machine_update; {nothing}"


def _cwd_arg(args: dict, row) -> str | None:
    if "cwd" not in args:
        return None
    raw = args["cwd"]
    if isinstance(raw, str) and raw.startswith("@"):
        raise ToolFailure(
            f"{row['name']}: a job's cwd must be an absolute path — a known @folder is not "
            f"resolved for jobs; {NOTHING_STARTED}"
        )
    return devices._check_fs_path(
        raw,
        row["platform"],
        device_facts.folders_of(row["facts"]),
        row["name"],
        device_facts.folders_unread(row["facts"]),
        device_facts.predates_folders(row["facts"]),
    )


def _survives_words(meta: dict) -> str:
    survives = meta.get("survives_agent")
    if survives is True:
        return "It outlives this turn and the agent; read it with device_job_status."
    if survives is False:
        why = meta.get("why")
        why = why.strip() if isinstance(why, str) and why.strip() else "the agent gave no reason"
        return (
            f"survives_agent: false — it runs now, but a restart of the agent ends it: {why}. "
            "Read it with device_job_status."
        )
    return (
        "Whether it survives the agent is not confirmed (the agent did not say). "
        "Read it with device_job_status."
    )


async def device_job_start(args: dict, ctx: ToolContext) -> str:
    pool, row, _ = await devices._admit(args, ctx=ctx)
    name = row["name"]
    argv = args["argv"]
    env = devices._env_arg(args, nothing=NOTHING_STARTED)
    cwd = _cwd_arg(args, row)
    outside = devices._outside_checkout(row, cwd=cwd, argv=argv)
    route = await devices._box_route(pool, row, ctx, cwd)
    boxed = isinstance(route, tuple)
    box = None
    if boxed:
        change, box_args = route
        box = devices.box_name(change)
        job_args: dict = {"argv": argv, **box_args}
    else:
        job_args = {"argv": argv}
        if cwd is not None:
            job_args["cwd"] = cwd
    if env is not None:
        job_args["env"] = env
    ran_in = "box" if boxed else "host"
    if pool is None:
        # An eval replay's declared device: there is no table to write, and
        # its plant answers (it runs no job — a stated cannot).
        job_id = job_rows.new_job_id()
    else:
        try:
            job_id = await job_rows.insert(
                pool,
                device_id=row["id"],
                turn_id=ctx.turn_id if ctx is not None else None,
                argv=argv,
                cwd=cwd,
                env=env,
                ran_in=ran_in,
                box=box,
            )
        except ValueError as exc:
            raise ToolFailure(f"{exc} — {NOTHING_STARTED}") from exc
    try:
        result = await devices._command(
            pool, row, JOB_START, {"job_id": job_id, **job_args}, ctx=ctx
        )
    except ToolFailure as exc:
        # No result frame: whether the agent started it is not known.
        unconfirmed = f"whether job {job_id} started is not confirmed"
        if pool is not None:
            await job_rows.note_unconfirmed(pool, job_id, f"{unconfirmed}: {exc}")
        raise ToolFailure(f"{exc} — {unconfirmed}; read it with device_job_status") from exc
    warning = devices._join_warnings(
        devices._flag_outside(ctx, outside, "device_job_start") if outside is not None else None,
        devices._flag_other_change(ctx, "device_job_start", cwd=cwd, argv=argv),
    )
    meta = result.get("meta")
    meta = meta if isinstance(meta, dict) else {}
    ok = bool(result.get("ok"))
    state = meta.get("state") if ok else "failed_to_start"
    if ok and state not in job_rows.STARTED_STATES:
        state = "starting"
    record = {
        "id": job_id,
        "state": state,
        "device": name,
        "argv": list(argv),
        "cwd": cwd,
        "ran_in": ran_in,
    }
    if box is not None:
        record["box"] = box
    devices._file_fact(ctx, {JOB_FACT: record})
    if not ok:
        error = str(result.get("error") or devices._NO_REASON)
        if error.startswith(devices._UNKNOWN_CAPABILITY):
            failure = predates_jobs_words(name)
        else:
            failure = f"{name}: {error}"
        if pool is not None:
            await job_rows.mark_failed(pool, job_id, failure)
        raise ToolFailure(failure if warning is None else f"{failure}\n{warning}")
    if pool is not None and state in job_rows.STARTED_STATES:
        await job_rows.mark_started(pool, job_id, state)
    where = f"ran_in box {box}" if boxed else "ran_in host"
    text = f"started job {job_id} on {name} ({where})"
    if cwd is not None:
        text += f" in {cwd}"
    if route == devices._HOST_BY_OWNER:
        text += f" {devices.HOST_BY_OWNER_WORDS}"
    if state == "waiting_lock":
        text += " — a whole suite: it waits for the CPU lock, then runs"
    elif state == "starting":
        text += " — its state is not confirmed (the agent sent no record)"
    text += f".\n{_survives_words(meta)}"
    output = result.get("output")
    if isinstance(output, str) and output.strip():
        text += f"\n{output.strip()}"
    return text if warning is None else f"{text}\n{warning}"


# -- reading a job back, and ending it (T11) -----------------------------------------

JOB_STATUS = "job.status"
JOB_LIST = "job.list"
JOB_LOG = "job.log"
JOB_STOP = "job.stop"
NOTHING_READ = "nothing was read"
NOTHING_STOPPED = "nothing was stopped"
# A job that ran to ITS end files a run fact: `done` with a recorded start
# (exit 0 or not). failed_to_start ran nothing; a `stopped` job's exit code is
# the stop's (a runner that traps TERM exits 0), and a `lost` job's end is
# unknown — neither is a finished run, so neither backs tests_passed /
# ran_command (amended C3, 2026-10-12).
_RAN_STATES = ("done",)
# Ended without running to their end: said so in the result.
_CUT_SHORT_STATES = ("stopped", "lost")


def _agent_failure(name: str, result: dict, job_id: str | None, nothing: str) -> str:
    """The Error for an ok:false answer: an agent with no job capabilities is
    told to update; otherwise the agent's own words. An id that is not even
    12 lowercase hex names no job anywhere, so that is said first."""
    error = str(result.get("error") or devices._NO_REASON)
    if error.startswith(devices._UNKNOWN_CAPABILITY):
        return predates_jobs_words(name, nothing)
    if job_id is not None and not job_rows.valid_id(job_id):
        return f"{name}: no job {job_id} on this device — {error}"
    return f"{name}: {error}"


def _record_of(result: dict, job_id: str, name: str, capability: str) -> dict:
    """The agent's record of `job_id` from an ok answer (caps/job.go
    statusMeta), or a ToolFailure: a record of no job, or of another one, is
    not an answer about this one."""
    meta = result.get("meta")
    if not isinstance(meta, dict) or meta.get("job") != job_id:
        raise ToolFailure(
            f"{name} answered {capability} with no record of job {job_id} — {NOTHING_READ}"
        )
    return meta


async def _keep_record(pool, row, ctx: ToolContext | None, record: dict) -> None:
    """Check the agent's record, store it on that device's row, and file its
    facts: ONE `job` fact, and — once the job ran to its end (done) — ONE `run` fact
    (exit_code, argv, cwd, ran_in, box, job) that tests_passed / ran_command
    read exactly as they read device_run's. A record core cannot read is a
    ToolFailure before anything is stored or filed."""
    name = row["name"]
    job_id = record["job"]
    try:
        values = job_rows.parse_status(record)
        if pool is not None:
            await job_rows.apply_status(pool, row["id"], record)
    except ValueError as exc:
        raise ToolFailure(
            f"{name} sent a record of job {job_id} core cannot read: {exc} — nothing was stored"
        ) from exc
    argv = record.get("argv")
    argv = [w for w in argv if isinstance(w, str)] if isinstance(argv, list) else []
    cwd = record.get("cwd") if isinstance(record.get("cwd"), str) else None
    ran_in = record.get(devices.RAN_IN)
    box = record.get("box") if isinstance(record.get("box"), str) else None
    fact = {
        "id": job_id,
        "state": record.get("state"),
        "device": name,
        "argv": argv,
        "cwd": cwd,
        devices.RAN_IN: ran_in,
    }
    if box is not None:
        fact["box"] = box
    devices._file_fact(ctx, {JOB_FACT: fact})
    if (
        values is not None
        and values["state"] in _RAN_STATES
        and values.get("started_at") is not None
    ):
        run = {
            "exit_code": values["exit_code"],
            "device": name,
            "argv": argv,
            "cwd": cwd,
            devices.RAN_IN: ran_in,
        }
        if box is not None:
            run["box"] = box
        run["job"] = job_id
        devices._file_fact(ctx, {"run": run, "target": " ".join(argv)})


def _describe(name: str, record: dict) -> str:
    """One job's record, in words: its state and exit code, where it ran,
    its command, and how much log it wrote."""
    job_id = record["job"]
    state = record.get("state") or ""
    if not state:
        return f"job {job_id} on {name} has no record yet (its wrapper has not written one)."
    text = f"job {job_id} on {name}: {state}"
    if record.get("exit_code") is not None:
        text += f" exit {record['exit_code']}"
    if record.get("reason"):
        text += f" ({record['reason']})"
    if record.get(devices.RAN_IN) == "box":
        text += f" — ran_in box {record.get('box')}"
    else:
        text += " — ran_in host"
    argv = record.get("argv")
    if isinstance(argv, list) and argv:
        text += f"; argv: {' '.join(str(w) for w in argv)}"
    if record.get("cwd"):
        text += f" in {record['cwd']}"
    if record.get("started_at"):
        text += f"; started {record['started_at']}"
    if record.get("ended_at"):
        text += f", ended {record['ended_at']}"
    text += f"; log {record.get('log_bytes', 0)} bytes (read it with device_job_log)."
    if state == "running":
        text += " Still running — no exit code yet; what it did is not known until it ends."
    elif state == "waiting_lock":
        text += (
            f" Waiting for the CPU lock (waited {record.get('lock_waited_s', 0)} s) — "
            "it has not run yet, no exit code."
        )
    elif state in _CUT_SHORT_STATES:
        text += (
            f" It did not run to its end ({state}): any exit code is not a finished run's, "
            "so it shows nothing passing."
        )
    return text


async def device_job_status(args: dict, ctx: ToolContext) -> str:
    pool, row, _ = await devices._admit(args, ctx=ctx)
    name = row["name"]
    job_id = args.get("job")
    if job_id is None:
        result = await devices._command(pool, row, JOB_LIST, {}, ctx=ctx)
        if not result.get("ok"):
            raise ToolFailure(_agent_failure(name, result, None, NOTHING_READ))
        output = result.get("output")
        output = output.strip() if isinstance(output, str) and output.strip() else "no jobs"
        return (
            f"jobs on {name}, read from its agent now (newest first; a job's own "
            f"device_job_status is its record):\n{output}"
        )
    result = await devices._command(pool, row, JOB_STATUS, {"job_id": job_id}, ctx=ctx)
    if not result.get("ok"):
        raise ToolFailure(_agent_failure(name, result, job_id, NOTHING_READ))
    record = _record_of(result, job_id, name, JOB_STATUS)
    await _keep_record(pool, row, ctx, record)
    return _describe(name, record)


async def device_job_log(args: dict, ctx: ToolContext) -> str:
    pool, row, _ = await devices._admit(args, ctx=ctx)
    name = row["name"]
    job_id = args["job"]
    if "tail_bytes" in args and ("offset" in args or "length" in args):
        raise ToolFailure(
            f"{name}: a log read takes offset (and length) or tail_bytes, not both — {NOTHING_READ}"
        )
    log_args: dict = {"job_id": job_id}
    for key in ("offset", "length", "tail_bytes"):
        if key in args:
            log_args[key] = args[key]
    result = await devices._command(pool, row, JOB_LOG, log_args, ctx=ctx)
    if not result.get("ok"):
        raise ToolFailure(_agent_failure(name, result, job_id, NOTHING_READ))
    meta = _record_of(result, job_id, name, JOB_LOG)
    offset, length, total = (meta.get(k) for k in ("offset", "length", "bytes_total"))
    if not all(job_rows._int(v) and v >= 0 for v in (offset, length, total)):
        raise ToolFailure(
            f"{name} answered job.log for job {job_id} with no byte range — {NOTHING_READ}"
        )
    text = f"job {job_id} log on {name}: bytes {offset}-{offset + length} of {total}"
    if length == 0:
        text += " (empty)"
    elif offset + length < total:
        text += " (more follows: read on by offset)"
    output = result.get("output")
    return f"{text}\n{output if isinstance(output, str) else ''}"


async def device_job_stop(args: dict, ctx: ToolContext) -> str:
    pool, row, _ = await devices._admit(args, ctx=ctx)
    name = row["name"]
    job_id = args["job"]
    result = await devices._command(pool, row, JOB_STOP, {"job_id": job_id}, ctx=ctx)
    if not result.get("ok"):
        raise ToolFailure(_agent_failure(name, result, job_id, NOTHING_STOPPED))
    record = _record_of(result, job_id, name, JOB_STOP)
    await _keep_record(pool, row, ctx, record)
    output = result.get("output")
    head = output.strip() if isinstance(output, str) and output.strip() else f"stop {job_id}"
    return f"{head}\n{_describe(name, record)}"


_JOB_ARG = {
    "type": "string",
    "description": "The job's id, as device_job_start returned it (12 lowercase hex).",
}
_BYTES = {"type": "integer", "minimum": 0}


TOOLS: tuple[Tool, ...] = (
    Tool(
        name="device_job_start",
        description=(
            "Start a command on a paired device as a job that outlives this turn: the "
            "machine's agent starts it and leaves it running (a long build, a whole test "
            "suite, `sleep 200`), and nothing waits for it here. Give argv as for device_run "
            "(a list of strings, the program first, no shell). On the machine that holds "
            "Nova's repository, a cwd inside one of her change worktrees "
            "(<checkout>/.worktrees/nova-<id>) runs the job inside that change's box — a "
            "whole suite there waits for the CPU lock first — never on the host. The result "
            "says where it runs, its job id, and whether it survives a restart of the agent. "
            "It has no exit code yet: read it back with device_job_status."
        ),
        parameters=devices._obj(
            {
                "device": devices._DEVICE_ARG,
                "argv": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 1,
                    "description": "The program and its arguments, as separate strings.",
                },
                "cwd": {
                    "type": "string",
                    "description": (
                        "The directory to run the job in, an absolute path in the device's "
                        "own OS (a known @folder is not resolved for jobs). Without it the "
                        "job runs in the agent's home directory."
                    ),
                },
                "env": {
                    "type": "object",
                    "additionalProperties": {"type": "string"},
                    "description": (
                        "Environment variables to add for the job, as NAME: value strings "
                        "(names: letters, digits and _, not starting with a digit). The "
                        "values reach the program only: they are never written to the "
                        "trace, Activity or the job's record — only the names are."
                    ),
                },
            },
            ["device", "argv"],
        ),
        executor=device_job_start,
        ephemeral=False,
    ),
    Tool(
        name="device_job_status",
        description=(
            "Read a job on a paired device back from its agent, now: its state (running, "
            "waiting for the CPU lock, done, failed_to_start, stopped, lost), its exit code "
            "once it has ended, where it ran (the host, or a change's box), its command and "
            "how much log it wrote. A job outlives the turn that started it, so this is how "
            "to learn how it ended; until it ends there is no exit code. Without `job` it "
            "lists the agent's jobs, newest first."
        ),
        parameters=devices._obj({"device": devices._DEVICE_ARG, "job": _JOB_ARG}, ["device"]),
        executor=device_job_status,
        reads_only=True,
        ephemeral=True,
    ),
    Tool(
        name="device_job_log",
        description=(
            "Read a job's log (its combined output) on a paired device: by default the last "
            "262144 bytes; or `offset` (and `length`) to read a range, or `tail_bytes` for the "
            "end. At most 262144 bytes per read; the result says which bytes it holds out of "
            "the log's total, so read on by offset."
        ),
        parameters=devices._obj(
            {
                "device": devices._DEVICE_ARG,
                "job": _JOB_ARG,
                "offset": dict(_BYTES),
                "length": {**_BYTES, "maximum": 262144},
                "tail_bytes": {**_BYTES, "maximum": 262144},
            },
            ["device", "job"],
        ),
        executor=device_job_log,
        reads_only=True,
        ephemeral=True,
    ),
    Tool(
        name="device_job_stop",
        description=(
            "Stop a running job on a paired device: the agent ends the job (inside its box "
            "for a box job) and waits for its record, then this reports how it ended. A job "
            "that already ended is left as it is and its record reported."
        ),
        parameters=devices._obj(
            {"device": devices._DEVICE_ARG, "job": _JOB_ARG}, ["device", "job"]
        ),
        executor=device_job_stop,
        ephemeral=False,
    ),
)
