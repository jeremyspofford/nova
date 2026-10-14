"""A landing's run (S32 spec §5.2 step 5): the suites as S30c jobs.

`run_suites` starts each planned command (landing_plan.planned_commands:
ruff first, then each suite's commands, main's argv EXACTLY) as one
`job.start` on the repository's machine with its cwd in the clean copy
(<checkout>/.worktrees/nova-<judge>[/<dir>]) and the box fields of the judge
id — so novad runs it in the judge box nova-box-<judge> (bringing that fresh
box and its Postgres up on the first command), and box.Heavy, which matches
the exact argv in its dir, holds the CPU lock for a whole suite's run. A flag
added to a suite's argv would silently drop the lock, so pytest's `-rs` (the
skip reasons landing_plan reads) travels as env PYTEST_ADDOPTS, its value
never stored (device_jobs keeps names only).

One command at a time, in plan order: they would serialise on the CPU lock
anyway, and a failure's suite stays unambiguous. The run stops at the first
command that did not pass — the verdict is no longer green, and the commands
after it are named "did not run" by landing_plan.verdict.

Each job gets its device_jobs row BEFORE the send (the S30c rule), the
agent's answers move it, and its terminal record is stored on it. The result
is landing_plan.suite_result over the terminal record and the WHOLE log (at
most LOG_MAX from its end): counts and skip reasons are read from what is
handed in, only the stored tail is cut.

Nothing here is ever a pass it did not see: a start the agent refuses (the
two-box limit, an old agent), a job it never had, a record of another job,
a ceiling reached (the job is stopped) or a log that cannot be read are all
could_not_measure, in the agent's own words.
"""

from __future__ import annotations

import asyncio
import dataclasses
import logging
import posixpath
import time
import weakref
from collections.abc import Awaitable, Callable
from datetime import datetime

from app import code_repos, landing_git, landing_plan, landings
from app import device_jobs as job_rows
from app.landing_plan import Plan, planned_commands, suite_result
from app.tools import changes
from app.tools.base import ToolFailure
from app.tools.device_jobs import predates_jobs_words
from app.tools.devices import _NO_REASON, _UNKNOWN_CAPABILITY, _command, box_name

# How often a running job is asked for its state.
POLL_S = 10.0
# The most one command may take, waiting for the CPU lock included; then it
# is stopped and could_not_measure. The core suite is ~5½ min on CI and longer
# on the N150, behind whatever else holds the lock.
CEILING_S = 5400.0
# novad's job.log reads at most this much per call (caps.LogReadCap).
LOG_READ_CAP = 256 * 1024
# The most of a log read back, from its end — the summary and pytest's -rs
# lines are at the end.
LOG_MAX = 4 << 20
PYTEST_ENV = {"PYTEST_ADDOPTS": "-rs"}

_UNKNOWN = "unknown"


def command_cwd(copy: landing_git.Copy, suite_dir: str) -> str:
    """The cwd of a suite's command: the copy's root for ".", else
    <copy>/<dir>. A dir that is not a clean relative path inside the copy
    raises ValueError (main's suites.toml is parsed strictly already; this
    is the line that never sends a cwd outside the judged copy)."""
    if suite_dir == ".":
        return copy.path
    if (
        not isinstance(suite_dir, str)
        or not suite_dir
        or suite_dir.startswith("/")
        or posixpath.normpath(suite_dir) != suite_dir
        or suite_dir.split("/")[0] == ".."
    ):
        raise ValueError(f"suite dir {suite_dir!r} is not a clean path inside the copy")
    return f"{copy.path}/{suite_dir}"


def _is_pytest(argv: tuple[str, ...]) -> bool:
    return "pytest" in argv


def _seconds(record: dict) -> float | None:
    start, end = record.get("started_at"), record.get("ended_at")
    if not isinstance(start, str) or not isinstance(end, str):
        return None
    try:
        return (datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds()
    except ValueError:
        return None


def _flat(text: object) -> str:
    return " ".join(str(text).split())


def _agent_words(row, result: dict) -> str:
    error = str(result.get("error") or _NO_REASON)
    if error.startswith(_UNKNOWN_CAPABILITY):
        return predates_jobs_words(row["name"], "nothing was run")
    return f"{row['name']}: {error}"


async def _read_log(pool, row, ctx, job_id: str) -> str:
    """The job's log, whole up to LOG_MAX from its end, by offset reads of at
    most LOG_READ_CAP. A read the agent refuses or answers without its byte
    range is a ToolFailure — never a shorter log read as complete."""

    async def read(args: dict) -> tuple[str, int, int, int]:
        result = await _command(pool, row, "job.log", {"job_id": job_id, **args}, ctx=ctx)
        if not result.get("ok"):
            raise ToolFailure(_agent_words(row, result))
        meta = result.get("meta")
        meta = meta if isinstance(meta, dict) else {}
        values = [meta.get(k) for k in ("offset", "length", "bytes_total")]
        if meta.get("job") != job_id or not all(job_rows._int(v) and v >= 0 for v in values):
            raise ToolFailure(f"{row['name']} answered job.log for job {job_id} with no byte range")
        output = result.get("output")
        return (output if isinstance(output, str) else "", *values)

    text, offset, _length, total = await read({"tail_bytes": LOG_READ_CAP})
    start = max(0, total - LOG_MAX)
    head: list[str] = []
    pos = start
    while pos < offset:
        chunk, got_at, got, _t = await read(
            {"offset": pos, "length": min(LOG_READ_CAP, offset - pos)}
        )
        if got_at != pos or got <= 0:
            raise ToolFailure(
                f"{row['name']} answered job.log for job {job_id} at byte {got_at} "
                f"({got} bytes) when byte {pos} was asked"
            )
        head.append(chunk)
        pos += got
    return "".join(head) + text


async def _stage(pool, landing_id, text: str) -> bool:
    return await landings.update(pool, landing_id, stage=text)


async def _run_one(
    pool,
    row,
    ctx,
    *,
    landing_id,
    turn_id,
    checkout: str,
    branch: str,
    copy: landing_git.Copy,
    limits: dict,
    suite: str,
    suite_dir: str,
    argv: tuple[str, ...],
    label: str,
    poll_s: float,
    ceiling_s: float,
    sleep: Callable[[float], Awaitable[None]],
    clock: Callable[[], float],
) -> dict:
    cwd = command_cwd(copy, suite_dir)
    env = dict(PYTEST_ENV) if _is_pytest(argv) else None

    def result(state: str, exit_code=None, log: str = "", seconds=None, reason: str = "") -> dict:
        return suite_result(
            suite, argv, state=state, exit_code=exit_code, log=log, seconds=seconds, reason=reason
        )

    job_id = await job_rows.insert(
        pool,
        device_id=row["id"],
        turn_id=turn_id,
        argv=list(argv),
        cwd=cwd,
        env=env,
        ran_in="box",
        box=box_name(copy.judge),
    )
    args: dict = {
        "job_id": job_id,
        "argv": list(argv),
        "cwd": cwd,
        "change": copy.judge,
        "checkout": checkout,
        "branch": branch,
        "limits": limits,
    }
    if env is not None:
        args["env"] = env
    unconfirmed = ""
    try:
        started = await _command(pool, row, "job.start", args, ctx=ctx)
    except ToolFailure as exc:
        # No answer: whether it started is not known — job.status says.
        unconfirmed = f"whether job {job_id} started is not confirmed: {_flat(exc)}"
        await job_rows.note_unconfirmed(pool, job_id, unconfirmed)
    else:
        if not started.get("ok"):
            words = _agent_words(row, started)
            await job_rows.mark_failed(pool, job_id, words)
            return result("failed_to_start", reason=words)
        meta = started.get("meta")
        state = meta.get("state") if isinstance(meta, dict) else None
        if state in job_rows.STARTED_STATES:
            await job_rows.mark_started(pool, job_id, state)

    deadline = clock() + ceiling_s
    last_error = ""
    record: dict | None = None
    while True:
        try:
            answer = await _command(pool, row, "job.status", {"job_id": job_id}, ctx=ctx)
        except ToolFailure as exc:
            last_error = _flat(exc)
        else:
            if not answer.get("ok"):
                words = _agent_words(row, answer)
                why = f"{unconfirmed}; {words}" if unconfirmed else words
                return result(_UNKNOWN, reason=why)
            meta = answer.get("meta")
            if not isinstance(meta, dict) or meta.get("job") != job_id:
                return result(
                    _UNKNOWN,
                    reason=f"{row['name']} answered job.status with no record of job {job_id}",
                )
            try:
                values = job_rows.parse_status(meta)
                await job_rows.apply_status(pool, row["id"], meta)
            except ValueError as exc:
                return result(
                    _UNKNOWN,
                    reason=f"{row['name']} sent a record of job {job_id} core cannot read: {exc}",
                )
            last_error = ""
            if values is not None and values["state"] in job_rows.TERMINAL_STATES:
                record = meta
                break
            if values is not None and values["state"] == "waiting_lock":
                await _stage(pool, landing_id, f"{label}: waiting for the CPU lock")
            else:
                await _stage(pool, landing_id, f"{label}: running")
        if clock() >= deadline:
            break
        await sleep(poll_s)

    if record is None:
        # The ceiling: stop it, and say so — never left to run unread.
        timed_out = f"timed out after {ceiling_s:g} s (the landing's ceiling)"
        if last_error:
            timed_out += f"; the last read of it failed: {last_error}"
        try:
            stopped = await _command(pool, row, "job.stop", {"job_id": job_id}, ctx=ctx)
        except ToolFailure as exc:
            return result(_UNKNOWN, reason=f"{timed_out}; job.stop failed: {_flat(exc)}")
        meta = stopped.get("meta") if stopped.get("ok") else None
        if not isinstance(meta, dict) or meta.get("job") != job_id:
            words = _agent_words(row, stopped) if not stopped.get("ok") else "no record"
            return result(_UNKNOWN, reason=f"{timed_out}; job.stop: {words}")
        try:
            job_rows.parse_status(meta)
            await job_rows.apply_status(pool, row["id"], meta)
        except ValueError as exc:
            return result(_UNKNOWN, reason=f"{timed_out}; its stop record core cannot read: {exc}")
        state = meta.get("state") or _UNKNOWN
        if state == "done":
            # It ended on its own as the stop arrived: a finished run, read as one.
            record = meta
        else:
            return result(
                state,
                exit_code=meta.get("exit_code"),
                seconds=_seconds(meta),
                reason=f"{timed_out}; stopped",
            )

    state = record["state"]
    exit_code = record.get("exit_code")
    reason = record.get("reason") if isinstance(record.get("reason"), str) else ""
    try:
        log = await _read_log(pool, row, ctx, job_id)
    except ToolFailure as exc:
        out = result(state, exit_code=exit_code, seconds=_seconds(record), reason=reason)
        # A run that exited 0 is only as good as its log says (counts, skips):
        # unread, it never passes. A nonzero exit stays what it is.
        if out["outcome"] == "passed" or (state == "done" and exit_code == 0):
            out["outcome"] = "could_not_measure"
            out["why"] = f"{suite} `{' '.join(argv)}`: its log could not be read: {_flat(exc)}"
        return out
    return result(state, exit_code=exit_code, log=log, seconds=_seconds(record), reason=reason)


async def run_suites(
    pool,
    row,
    ctx,
    *,
    landing_id,
    turn_id,
    checkout: str,
    branch: str,
    copy: landing_git.Copy,
    plan: Plan,
    poll_s: float | None = None,
    ceiling_s: float | None = None,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> list[dict]:
    """Run the plan's commands in the judge box, one job at a time, and
    return their results (landing_plan.suite_result rows), stored on the
    landing's `suites` after each. Stops at the first command that did not
    pass, and before any command once the landing is no longer running.
    `branch` is the repository's default branch (novad reads suites.toml and
    the image from it, never from the change's branch)."""
    poll_s = POLL_S if poll_s is None else poll_s
    ceiling_s = CEILING_S if ceiling_s is None else ceiling_s
    planned = planned_commands(plan)
    limits = await code_repos.box_limits(pool)
    results: list[dict] = []
    for i, (suite, suite_dir, argv) in enumerate(planned, start=1):
        label = f"{i}/{len(planned)} {suite} `{' '.join(argv)}`"
        if not await _stage(pool, landing_id, f"{label}: starting"):
            break
        out = await _run_one(
            pool,
            row,
            ctx,
            landing_id=landing_id,
            turn_id=turn_id,
            checkout=checkout,
            branch=branch,
            copy=copy,
            limits=limits,
            suite=suite,
            suite_dir=suite_dir,
            argv=argv,
            label=label,
            poll_s=poll_s,
            ceiling_s=ceiling_s,
            sleep=sleep,
            clock=clock,
        )
        results.append(out)
        await landings.update(pool, landing_id, suites=results)
        if out["outcome"] != "passed":
            break
    return results


# -- the landing itself (T10; spec §5.2 steps 2-8, §9.2, §9.3) -------------------
#
# repo_land answers at once; `start` runs `land` as a task held in _TASKS (so
# it is never garbage-collected mid-way). One landing at a time per
# repository: a second waits on the lock, its stage naming the one it waits
# for — waiting is not a refusal. Every way out of a landing is a verdict on
# its row: an exception anywhere is could_not_measure in its own words, and a
# restart (the task dies with the process) is closed by landings.
# mark_interrupted at the next startup. Only green publishes (§9.3: a landing
# with no suite run behind it never merges). The close always takes down the
# judge's box and copy; after a merge it also takes her box and worktree (her
# branch is kept). A close step that fails is said on the row; the verdict
# stands.

logger = logging.getLogger("core")

_TASKS: set[asyncio.Task] = set()
# Per event loop (a lock belongs to the loop it first waited on), per repo.
_LOCKS: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()
_HOLDERS: dict[str, object] = {}


def _lock(key: str) -> asyncio.Lock:
    locks = _LOCKS.setdefault(asyncio.get_running_loop(), {})
    return locks.setdefault(key, asyncio.Lock())


def _words(exc: BaseException) -> str:
    text = _flat(exc)
    if isinstance(exc, (ToolFailure, ValueError)):
        return text or type(exc).__name__
    return f"{type(exc).__name__}: {text}" if text else type(exc).__name__


def _background(ctx):
    """The turn's context without its output channels: the landing outlives
    the turn, and nothing it does is the turn's to show."""
    if ctx is None:
        return None
    return dataclasses.replace(
        ctx, facts_sink=None, progress=None, step=None, card=None, undo_sink=None
    )


def start(pool, row, ctx, **kw) -> asyncio.Task:
    """Run `land` in the background and hold its task; returns it."""
    task = asyncio.get_running_loop().create_task(
        land(pool, row, _background(ctx), **kw), name=f"landing {kw.get('landing_id')}"
    )
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
    return task


async def settle() -> None:
    """Wait for every landing task (tests; never called from a landing)."""
    while _TASKS:
        running = [t for t in _TASKS if not t.done()]
        if running:
            await asyncio.gather(*running, return_exceptions=True)
        else:
            await asyncio.sleep(0)


async def cancel_landings() -> None:
    """At shutdown: a landing can run for an hour, so it is cancelled, never
    drained; its row stays running until the next startup marks it."""
    tasks = list(_TASKS)
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    _TASKS.difference_update(tasks)


async def _note(pool, landing_id, text: str) -> None:
    try:
        await landings.append_reason(pool, landing_id, text)
    except Exception:
        logger.exception("landing %s: could not record %r", landing_id, text)


async def _cannot(pool, landing_id, words: str) -> None:
    """could_not_measure with `words`; a landing already finished keeps its
    verdict and gets the words added to its reason."""
    try:
        await landings.finish(pool, landing_id, "could_not_measure", reason=words)
    except ValueError:
        await _note(pool, landing_id, words)
    except Exception:
        logger.exception("landing %s: could not record could_not_measure: %s", landing_id, words)


@dataclasses.dataclass
class _Close:
    copy: landing_git.Copy | None = None
    merged: bool = False


async def land(
    pool,
    row,
    ctx,
    *,
    landing_id,
    change: str,
    checkout: str,
    worktree: str,
    main: str,
    host: str,
    turn_id,
    run=None,
) -> None:
    """Steps 2-8 of a landing whose row repo_land wrote `running`. Never
    raises (but for cancellation): every outcome is a verdict on the row."""
    run = run if run is not None else landing_git.agent_runner(pool, row, ctx)
    key = f"{row['id']}:{checkout}"
    lock = _lock(key)
    if lock.locked():
        holder = _HOLDERS.get(key)
        try:
            await landings.update(
                pool,
                landing_id,
                stage=f"waiting for landing {holder} to finish (one landing at a time per "
                "repository)",
            )
        except Exception:
            logger.exception("landing %s: could not record its wait", landing_id)
    async with lock:
        _HOLDERS[key] = landing_id
        close = _Close()
        try:
            try:
                await _judge(
                    pool,
                    row,
                    ctx,
                    run,
                    close,
                    landing_id=landing_id,
                    checkout=checkout,
                    worktree=worktree,
                    main=main,
                    host=host,
                    turn_id=turn_id,
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await _cannot(pool, landing_id, _words(exc))
            await _close(pool, row, ctx, run, close, landing_id, change, checkout, worktree)
        finally:
            if _HOLDERS.get(key) == landing_id:
                del _HOLDERS[key]


async def _judge(
    pool,
    row,
    ctx,
    run,
    close: _Close,
    *,
    landing_id,
    checkout: str,
    worktree: str,
    main: str,
    host: str,
    turn_id,
) -> None:
    await _stage(pool, landing_id, f"bringing the change up to date with origin/{main}")
    prepared = await landing_git.prepare(
        run, checkout=checkout, worktree=worktree, main=main, host=host
    )
    if isinstance(prepared, landing_git.Conflict):
        files = ", ".join(prepared.files)
        await landings.finish(
            pool,
            landing_id,
            "conflict",
            base_sha=prepared.base_sha,
            conflict_files=list(prepared.files),
            reason=(
                f"rebasing onto origin/{main} ({prepared.base_sha}) conflicted in {files}; the "
                "rebase was aborted and the branch is unchanged — resolve it in the worktree, "
                "commit with change_commit and land again"
            ),
        )
        return
    await landings.update(
        pool,
        landing_id,
        base_sha=prepared.base_sha,
        commit_sha=prepared.commit_sha,
        patch=prepared.patch,
        patch_truncated=prepared.patch_truncated,
    )
    try:
        dirty, cut = await landing_git.dirty_outside(run, checkout)
    except ToolFailure as exc:
        await _note(pool, landing_id, f"the checkout's own changes could not be read: {exc}")
    else:
        await landings.update(pool, landing_id, dirty_outside=dirty)
        if cut:
            await _note(pool, landing_id, "dirty_outside was cut at the agent's output limit")

    await _stage(pool, landing_id, f"reading main's {landing_git.SUITES_TOML}")
    toml = await landing_git.main_suites(run, checkout=checkout, base_sha=prepared.base_sha)
    plan = landing_plan.plan(toml, prepared.changed, prepared.deleted)
    await landings.update(pool, landing_id, protected=list(plan.protected))

    await _stage(pool, landing_id, "making the clean copy")
    close.copy = await landing_git.make_copy(run, checkout=checkout, sha=prepared.commit_sha)
    await landings.update(pool, landing_id, judge_id=close.copy.judge)

    results = await run_suites(
        pool,
        row,
        ctx,
        landing_id=landing_id,
        turn_id=turn_id,
        checkout=checkout,
        branch=main,
        copy=close.copy,
        plan=plan,
    )
    outcome = landing_plan.verdict(plan, results)
    if outcome.verdict != "green":
        await landings.finish(
            pool, landing_id, outcome.verdict, reason=outcome.reason, suites=results
        )
        return

    await _stage(pool, landing_id, "publishing: branch, PR, main, the deploy checkout")
    # The verdict first: a publish that dies part-way never loses it.
    await landings.finish(pool, landing_id, "green", suites=results)
    published = await landing_git.publish(
        run,
        verdict="green",
        checkout=checkout,
        branch=prepared.branch,
        main=main,
        sha=prepared.commit_sha,
        landing_id=str(landing_id),
        suites=results,
        protected=list(plan.protected),
    )
    recorded = await landings.record_publish(
        pool,
        landing_id,
        merged_sha=published.merged_sha,
        pr_url=published.pr_url,
        push_result=published.push_result,
    )
    if not recorded:
        await _note(pool, landing_id, f"its publish was not recorded: {published.push_result}")
    close.merged = recorded and published.merged_sha is not None


async def _close(
    pool, row, ctx, run, close: _Close, landing_id, change: str, checkout: str, worktree: str
) -> None:
    """Step 8. Each step is tried on its own; one that fails is said on the
    row and the rest still run."""
    if close.copy is not None:
        judge = close.copy.judge
        why = await changes.remove_box(pool, row, ctx, judge)
        if why:
            await _note(pool, landing_id, f"the judge box nova-box-{judge} was not removed: {why}")
        try:
            await landing_git.remove_copy(run, checkout=checkout, judge=judge)
        except Exception as exc:
            await _note(pool, landing_id, f"the clean copy was not removed: {_words(exc)}")
    if not close.merged:
        return
    why = await changes.remove_box(pool, row, ctx, change)
    if why:
        await _note(pool, landing_id, f"the change's box {box_name(change)} was not removed: {why}")
    try:
        await landing_git.remove_worktree(run, checkout=checkout, worktree=worktree)
    except Exception as exc:
        await _note(pool, landing_id, f"the worktree {worktree} was not removed: {_words(exc)}")
