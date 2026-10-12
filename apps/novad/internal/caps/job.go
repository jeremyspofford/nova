package caps

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"novad/internal/box"
	"novad/internal/jobs"
)

// job.* run work that outlives a turn (S30c). job.start writes the job's
// spec and spawns the detached `novad job-exec <dir>` wrapper (jobs.Spawn),
// which owns the log and the terminal record; status, log, stop and list read
// and end what is on disk. Nothing here writes audit.jsonl beyond the call's
// own entry: the agent's scanner (T6) writes the one terminal entry per job.

// JobDeps is what job.* need: the job store, the binary the wrapper runs as
// (`<Binary> job-exec <dir>`; "" means this process's own executable), and
// the agent's service mode (jobs.Spawn uses a systemd scope under
// systemd-user).
type JobDeps struct {
	Store  *jobs.Store
	Binary string
	Mode   string
}

// StopGrace is how long job.stop waits after the polite signal before the
// hard one; StopWait bounds the whole wait for the job's terminal record.
var (
	StopGrace = 5 * time.Second
	StopWait  = 10 * time.Second
)

// LogReadCap bounds one job.log read; more is refused, never truncated.
const LogReadCap = 256 * 1024

const noJobStore = "cannot: no job store on this agent (novad runs without a state directory)"

const stopPoll = 20 * time.Millisecond

func jobsOf(r Request) (*JobDeps, bool) {
	jd := r.Deps.Jobs
	return jd, jd != nil && jd.Store != nil
}

// jobIDArg reads and validates job_id; the error text is jobs.ValidID's.
func jobIDArg(capability string, args map[string]any) (string, error) {
	id, ok := args["job_id"].(string)
	if !ok {
		return "", fmt.Errorf("%s needs a string 'job_id', got %T", capability, args["job_id"])
	}
	return id, jobs.ValidID(id)
}

// jobStart validates every input before anything touches the disk, writes
// the spec (env NAMES only) and spawns the wrapper with the values in its
// process environment.
func jobStart(ctx context.Context, r Request) Outcome {
	jd, ok := jobsOf(r)
	if !ok {
		return fail(noJobStore)
	}
	if _, boxed := r.Args["change"]; boxed {
		return boxJobStart(ctx, r, jd)
	}
	refuse := func(err error) Outcome { return fail("%v; nothing was started", err) }
	id, err := jobIDArg("job.start", r.Args)
	if err != nil {
		return refuse(err)
	}
	argv, err := argvArg("job.start", r.Args)
	if err != nil {
		return refuse(err)
	}
	cwd := r.Deps.Home
	if v, present := r.Args["cwd"]; present {
		c, ok := v.(string)
		if !ok {
			return refuse(fmt.Errorf("job.start needs a string 'cwd', got %T", v))
		}
		if c != "" {
			cwd = c
		}
	}
	if cwd != "" {
		if !filepath.IsAbs(cwd) {
			return refuse(fmt.Errorf("job.start cwd %q is not an absolute path", cwd))
		}
		fi, err := os.Stat(cwd)
		if err != nil {
			return refuse(fmt.Errorf("job.start cwd %q: %v", cwd, err))
		}
		if !fi.IsDir() {
			return refuse(fmt.Errorf("job.start cwd %q is not a directory", cwd))
		}
	}
	env, keys, err := envArg(r.Args)
	if err != nil {
		return refuse(err)
	}
	spec := jobs.Spec{ID: id, EnvelopeID: r.EnvelopeID, Argv: argv, Cwd: cwd, EnvKeys: keys, CreatedAt: time.Now().UTC()}
	if err := jd.Store.Create(spec); err != nil {
		return refuse(fmt.Errorf("job.start: %v", err))
	}
	sp, meta, failed := launchJob(jd, id, env, "host")
	if failed != nil {
		return *failed
	}
	text := fmt.Sprintf("started job %s on the host (%s", id, sp.Status.State)
	if sp.Status.PID > 0 {
		text += fmt.Sprintf(", pid %d", sp.Status.PID)
	}
	text += ")"
	if !sp.SurvivesAgent {
		text += "; it will not survive the agent: " + sp.Why
	}
	out := ok0(text)
	out.Meta = meta
	return out
}

// launchJob spawns the wrapper for a job whose spec is written, with
// os.Environ()+env as its environment, and builds the start's meta. failed
// is the outcome to send when the job did not start.
func launchJob(jd *JobDeps, id string, env []string, ranIn string) (jobs.Spawned, map[string]any, *Outcome) {
	bin := jd.Binary
	if bin == "" {
		var err error
		if bin, err = os.Executable(); err != nil {
			o := failStart(id, fmt.Sprintf("novad cannot name its own binary: %v", err), jd.Store, ranIn)
			return jobs.Spawned{}, nil, &o
		}
	}
	sp, err := jobs.Spawn(bin, jd.Store.Dir(id), append(os.Environ(), env...), jd.Mode)
	if err != nil {
		o := fail("job.start %s: %v", id, err)
		return sp, nil, &o
	}
	meta := map[string]any{"job": id, "state": sp.Status.State, "survives_agent": sp.SurvivesAgent,
		"detach": sp.Detach, "ran_in": ranIn}
	if sp.Status.PID > 0 {
		meta["pid"] = sp.Status.PID
	}
	if sp.Why != "" {
		meta["why"] = sp.Why
	}
	if sp.Status.State == jobs.StateFailedToStart {
		meta["reason"] = sp.Status.Reason
		o := Outcome{OK: false, Error: fmt.Sprintf("job %s failed to start: %s", id, sp.Status.Reason), Meta: meta}
		return sp, meta, &o
	}
	return sp, meta, nil
}

// boxJobStart starts a job inside the change's box (S30c T5, spec §4.4):
// every input is checked first, then heavy is read from the branch core
// sent (the repo's default branch, never the change's) and the box is
// brought up; either failing starts nothing. The wrapper runs docker exec
// into the box and, for a whole suite, holds the CPU lock for the job's
// whole life. There is no fallback to the host.
func boxJobStart(ctx context.Context, r Request, jd *JobDeps) Outcome {
	m := r.Deps.Box
	if m == nil {
		return fail(noBoxManager)
	}
	refuse := func(err error) Outcome { return fail("%v; nothing was started", err) }
	id, err := jobIDArg("job.start", r.Args)
	if err != nil {
		return refuse(err)
	}
	argv, err := argvArg("job.start", r.Args)
	if err != nil {
		return refuse(err)
	}
	req, err := boxRequest("job.start", r.Args, false)
	if err != nil {
		return refuse(err)
	}
	env, keys, err := envArg(r.Args)
	if err != nil {
		return refuse(err)
	}
	suites, err := m.LoadSuites(ctx, req.Checkout, req.Branch)
	if err != nil {
		return fail("job.start: cannot tell whether this is a whole suite: %v — nothing was started", err)
	}
	heavy := box.Heavy(suites, argv, worktreeRel(req))
	st, err := m.Ensure(ctx, req)
	if err != nil {
		return fail("cannot start the box %s: %v — nothing was started", box.Names(req.Change).Box, err)
	}
	spec := jobs.Spec{ID: id, EnvelopeID: r.EnvelopeID, Argv: argv, Cwd: req.Cwd, EnvKeys: keys,
		Box: &jobs.BoxRef{Change: req.Change, Container: st.Box}, Heavy: heavy,
		Run: m.JobArgv(req, id, keys, argv), CreatedAt: time.Now().UTC()}
	if heavy {
		spec.Lock = box.LockPath(req.Checkout)
	}
	if err := jd.Store.Create(spec); err != nil {
		return refuse(fmt.Errorf("job.start: %v", err))
	}
	sp, meta, failed := launchJob(jd, id, env, "box")
	if meta != nil {
		meta["box"], meta["image"], meta["heavy"] = st.Box, st.Image, heavy
	}
	if failed != nil {
		return *failed
	}
	text := fmt.Sprintf("started job %s in the box %s (%s", id, st.Box, sp.Status.State)
	if sp.Status.State == jobs.StateWaitingLock {
		text += ": a whole suite waits for the CPU lock " + spec.Lock + " before it runs"
	}
	if sp.Status.PID > 0 {
		text += fmt.Sprintf(", pid %d", sp.Status.PID)
	}
	text += ")"
	if !sp.SurvivesAgent {
		text += "; it will not survive the agent: " + sp.Why
	}
	out := ok0(text)
	out.Meta = meta
	return out
}

// failStart records a job that could not be launched at all.
func failStart(id, reason string, s *jobs.Store, ranIn string) Outcome {
	now := time.Now().UTC()
	_ = s.WriteStatus(id, jobs.Status{State: jobs.StateFailedToStart, EndedAt: &now, Reason: reason})
	return Outcome{OK: false, Error: fmt.Sprintf("job %s failed to start: %s", id, reason),
		Meta: map[string]any{"job": id, "state": jobs.StateFailedToStart, "reason": reason, "ran_in": ranIn}}
}

// envArg reads env as NAME=value pairs for the wrapper's environment and the
// sorted names for the spec. Values are never returned anywhere else; the
// names are checked by Store.Create, before anything is written.
func envArg(args map[string]any) ([]string, []string, error) {
	return envArgFor("job.start", args)
}

// envArgFor is envArg naming capability in its refusals (shell.exec and
// box.exec read device_run's env the same way, S30c T8).
func envArgFor(capability string, args map[string]any) ([]string, []string, error) {
	v, present := args["env"]
	if !present || v == nil {
		return nil, nil, nil
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, nil, fmt.Errorf("%s 'env' must be an object of strings, got %T", capability, v)
	}
	keys := make([]string, 0, len(m))
	for k, val := range m {
		if _, ok := val.(string); !ok {
			return nil, nil, fmt.Errorf("%s env %q is not a string", capability, k)
		}
		if err := jobs.ValidEnvKey(k); err != nil {
			return nil, nil, fmt.Errorf("%s: %v", capability, err)
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)
	pairs := make([]string, len(keys))
	for i, k := range keys {
		pairs[i] = k + "=" + m[k].(string)
	}
	return pairs, keys, nil
}

// getJob is the job named by job_id, or the refusal to send.
func getJob(capability string, r Request) (jobs.Job, *Outcome) {
	jd, ok := jobsOf(r)
	if !ok {
		o := fail(noJobStore)
		return jobs.Job{}, &o
	}
	id, err := jobIDArg(capability, r.Args)
	if err != nil {
		o := fail("%v", err)
		return jobs.Job{}, &o
	}
	j, err := jd.Store.Get(id)
	if err != nil {
		o := fail("%v", err)
		return jobs.Job{}, &o
	}
	return j, nil
}

// statusMeta is a job's record as core reads it.
func statusMeta(j jobs.Job) map[string]any {
	st := j.Status
	m := map[string]any{"job": j.Spec.ID, "state": st.State, "argv": j.Spec.Argv, "cwd": j.Spec.Cwd,
		"ran_in": "host", "lock_waited_s": st.LockWaitedS, "log_bytes": st.LogBytes}
	if j.Spec.Box != nil {
		m["ran_in"] = "box"
		m["box"] = j.Spec.Box.Container
	}
	if st.PID > 0 {
		m["pid"] = st.PID
	}
	if st.ExitCode != nil {
		m["exit_code"] = *st.ExitCode
	}
	if st.StartedAt != nil {
		m["started_at"] = st.StartedAt.UTC().Format(time.RFC3339Nano)
	}
	if st.EndedAt != nil {
		m["ended_at"] = st.EndedAt.UTC().Format(time.RFC3339Nano)
	}
	if st.Reason != "" {
		m["reason"] = st.Reason
	}
	return m
}

// stateWords is "<state>[ exit N][ (reason)]".
func stateWords(st jobs.Status) string {
	if st.State == "" {
		return "has no record yet"
	}
	s := st.State
	if st.ExitCode != nil {
		s += fmt.Sprintf(" exit %d", *st.ExitCode)
	}
	if st.Reason != "" {
		s += " (" + st.Reason + ")"
	}
	return s
}

func jobStatus(_ context.Context, r Request) Outcome {
	j, refusal := getJob("job.status", r)
	if refusal != nil {
		return *refusal
	}
	out := ok0(fmt.Sprintf("job %s %s", j.Spec.ID, stateWords(j.Status)))
	out.Meta = statusMeta(j)
	return out
}

func jobList(_ context.Context, r Request) Outcome {
	jd, ok := jobsOf(r)
	if !ok {
		return fail(noJobStore)
	}
	all, bad, err := jd.Store.ListAll()
	if err != nil {
		return fail("cannot read the jobs: %v", err)
	}
	list := make([]map[string]any, len(all))
	lines := make([]string, 0, len(all)+len(bad))
	for i, j := range all {
		list[i] = statusMeta(j)
		lines = append(lines, fmt.Sprintf("%s %s  %s", j.Spec.ID, stateWords(j.Status), strings.Join(j.Spec.Argv, " ")))
	}
	// An unreadable job is named with why; it never hides the rest.
	unreadable := make([]map[string]any, len(bad))
	for i, b := range bad {
		unreadable[i] = map[string]any{"job": b.ID, "error": b.Err.Error()}
		lines = append(lines, fmt.Sprintf("%s unreadable: %v", b.ID, b.Err))
	}
	text := strings.Join(lines, "\n")
	if text == "" {
		text = "no jobs"
	}
	out := ok0(text)
	out.Meta = map[string]any{"jobs": list, "total": len(all)}
	if len(bad) > 0 {
		out.Meta["unreadable"] = unreadable
	}
	return out
}

// logArg reads a non-negative whole number; absent is (0, false, nil).
func logArg(args map[string]any, key string) (int64, bool, error) {
	v, present := args[key]
	if !present || v == nil {
		return 0, false, nil
	}
	n, ok := numberArg(v)
	if !ok || math.IsNaN(n) || n != math.Trunc(n) || n < 0 || n > math.MaxInt64/2 {
		return 0, true, fmt.Errorf("job.log '%s' must be a whole number of bytes, at least 0, got %v", key, v)
	}
	return int64(n), true, nil
}

// jobLog reads the log by offset(+length) or tail_bytes, at most LogReadCap.
func jobLog(_ context.Context, r Request) Outcome {
	j, refusal := getJob("job.log", r)
	if refusal != nil {
		return *refusal
	}
	offset, hasOffset, err := logArg(r.Args, "offset")
	if err != nil {
		return fail("%v", err)
	}
	length, hasLength, err := logArg(r.Args, "length")
	if err != nil {
		return fail("%v", err)
	}
	tail, hasTail, err := logArg(r.Args, "tail_bytes")
	if err != nil {
		return fail("%v", err)
	}
	if hasTail && (hasOffset || hasLength) {
		return fail("job.log takes offset (and length) or tail_bytes, not both")
	}
	if (hasLength && length > LogReadCap) || (hasTail && tail > LogReadCap) {
		return fail("job.log reads at most %d bytes per read; ask for less and read on by offset", LogReadCap)
	}
	if !hasLength {
		length = LogReadCap
	}
	if !hasOffset && !hasTail {
		hasTail, tail = true, LogReadCap
	}
	jd, _ := jobsOf(r)
	f, err := os.Open(filepath.Join(jd.Store.Dir(j.Spec.ID), jobs.LogFile))
	var total int64
	if err == nil {
		defer f.Close()
		fi, serr := f.Stat()
		if serr != nil {
			return fail("cannot read job %s's log: %v", j.Spec.ID, serr)
		}
		total = fi.Size()
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fail("cannot read job %s's log: %v", j.Spec.ID, err)
	}
	if hasTail {
		length = min(tail, total)
		offset = total - length
	} else {
		length = max(0, min(length, total-offset))
	}
	buf := make([]byte, length)
	if length > 0 {
		n, err := f.ReadAt(buf, offset)
		if err != nil && !errors.Is(err, io.EOF) {
			return fail("cannot read job %s's log: %v", j.Spec.ID, err)
		}
		buf = buf[:n]
		length = int64(n)
	}
	out := ok0(string(buf))
	out.Meta = map[string]any{"job": j.Spec.ID, "bytes_total": total, "offset": offset, "length": length}
	return out
}

// boxKillRetry is how often job.stop retries the kill inside a box whose
// pidfile was not readable yet (a job stopped just after it started).
var boxKillRetry = 200 * time.Millisecond

// jobStop asks the wrapper to record the job stopped (the stop file), ends
// the job, and waits for the record. A host job's child group is signalled
// on the host. A box job is killed INSIDE its box through the pid its shim
// wrote (box.Manager.KillJob): killing the host's docker exec client alone
// would leave the process in the box running. Only when no kill can reach
// the box is the client killed at StopGrace, and the result says the process
// in the box may still run.
func jobStop(ctx context.Context, r Request) Outcome {
	j, refusal := getJob("job.stop", r)
	if refusal != nil {
		return *refusal
	}
	jd, _ := jobsOf(r)
	id, st := j.Spec.ID, j.Status
	if st.Terminal() {
		out := ok0(fmt.Sprintf("job %s already ended (%s); nothing was signalled", id, stateWords(st)))
		out.Meta = statusMeta(j)
		return out
	}
	signal := st.State == jobs.StateRunning && st.PID > 0
	if signal && st.WrapperPID > 0 && !processAlive(st.WrapperPID) {
		return fail("job %s's wrapper (pid %d) is gone with no end recorded; nothing was signalled", id, st.WrapperPID)
	}
	if err := os.WriteFile(filepath.Join(jd.Store.Dir(id), jobs.StopFile), nil, 0o600); err != nil {
		return fail("cannot ask job %s to stop: %v; nothing was signalled", id, err)
	}
	inBox := signal && j.Spec.Box != nil
	var boxErr error
	landed := false
	killInBox := func(hard bool) error {
		err := errors.New(noBoxManager)
		if r.Deps.Box != nil {
			err = r.Deps.Box.KillJob(ctx, j.Spec.Box.Change, id, hard)
		}
		if err == nil {
			landed = true
		} else if !landed {
			boxErr = err
		}
		return err
	}
	switch {
	case inBox:
		killInBox(false)
	case signal:
		if err := signalJob(st.PID, false); err != nil {
			return fail("cannot signal job %s (pid %d): %v; the stop request stays", id, st.PID, err)
		}
	}
	began := time.Now()
	lastTry := began
	hard := !signal
	for {
		cur, err := jd.Store.Get(id)
		if err != nil {
			return fail("cannot read job %s: %v", id, err)
		}
		if cur.Status.Terminal() {
			text := fmt.Sprintf("stopped job %s (%s)", id, stateWords(cur.Status))
			if inBox && !landed {
				text += fmt.Sprintf("; no signal reached inside the box %s (%v), so its docker client was killed — the process in the box may still run",
					j.Spec.Box.Container, boxErr)
			}
			out := ok0(text)
			out.Meta = statusMeta(cur)
			return out
		}
		elapsed := time.Since(began)
		if elapsed >= StopWait {
			return fail("asked job %s to stop, but it recorded no end within %v; the stop request stays (its wrapper records the job stopped when it ends)", id, StopWait)
		}
		if !hard && elapsed >= StopGrace {
			hard = true
			if inBox {
				if killInBox(true) != nil {
					_ = signalJob(st.PID, true)
				}
			} else {
				_ = signalJob(st.PID, true)
			}
		} else if inBox && !landed && !hard && time.Since(lastTry) >= boxKillRetry {
			lastTry = time.Now()
			killInBox(false)
		}
		time.Sleep(stopPoll)
	}
}
