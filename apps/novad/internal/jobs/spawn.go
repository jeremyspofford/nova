package jobs

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// ModeSystemd is platform.Mode()'s word for an agent under systemd --user.
const ModeSystemd = "systemd-user"

// SpawnErrFile is the launcher's stderr — and then the wrapper's, which only
// writes there when it fails. It is read into a reason when a launch fails.
const SpawnErrFile = "spawn.err"

// SpawnWait bounds how long Spawn waits for the wrapper's first record.
var SpawnWait = 10 * time.Second

// SystemdRun is the systemd-run binary the scope launcher runs (a test
// points it elsewhere to prove the fallback).
var SystemdRun = "systemd-run"

const spawnPoll = 20 * time.Millisecond

// Spawned is what Spawn did. SurvivesAgent false is never silent: Why says
// what the job will not outlive and what went wrong.
type Spawned struct {
	Status        Status `json:"status"`
	SurvivesAgent bool   `json:"survives_agent"`
	Why           string `json:"why,omitempty"`
	Detach        string `json:"detach"`
}

// attempt is one way to launch the wrapper, tried in order: a later one runs
// only when an earlier one could not launch the wrapper at all (it did not
// start, or it exited without claiming the job).
type attempt struct {
	label    string
	argv     []string
	attr     *sysProcAttr
	survives bool
	caveat   string // when !survives: what the job will not outlive
}

// Spawn launches `<bin> job-exec <dir>` detached from the agent (spawn_unix:
// its own session, and under systemd a scope of its own so a cgroup kill of
// novad's unit does not take it; spawn_windows: out of the supervisor's
// job), with env as its whole environment — env values reach the job only
// that way. It waits at most SpawnWait for the wrapper's first record and
// returns it. A job that could not start comes back as a failed_to_start
// record with err nil; err is for a job that may not be spawned (bad id, no
// such job, already started) or a record that could not be written.
func Spawn(bin, dir string, env []string, mode string) (Spawned, error) {
	dir = filepath.Clean(dir)
	id := filepath.Base(dir)
	if err := ValidID(id); err != nil {
		return Spawned{}, err
	}
	s := &Store{Root: filepath.Dir(dir)}
	if _, err := s.existing(id); err != nil {
		return Spawned{}, err
	}
	if _, err := os.Stat(filepath.Join(dir, LogFile)); !errors.Is(err, fs.ErrNotExist) {
		return Spawned{}, fmt.Errorf("job %s already started on this device; a job runs once", id)
	}
	var failures []string
	for _, a := range attempts(bin, dir, id, mode) {
		st, failure, err := launch(s, id, dir, env, a)
		if err != nil {
			return Spawned{}, err
		}
		if failure != "" {
			failures = append(failures, a.label+" could not launch the wrapper ("+failure+")")
			continue
		}
		sp := Spawned{Status: st, SurvivesAgent: a.survives, Detach: a.label}
		if !a.survives {
			sp.Why = strings.Join(append(failures, a.caveat), "; ")
		}
		return sp, nil
	}
	st := failedToStart("nothing ran: " + strings.Join(failures, "; "))
	if err := s.WriteStatus(id, st); err != nil {
		return Spawned{}, err
	}
	return Spawned{Status: st, Why: st.Reason}, nil
}

// launch runs one attempt. It returns the wrapper's first record; or a
// failure (the wrapper was never launched, so the next attempt may run); or
// an error when a record could not be written.
func launch(s *Store, id, dir string, env []string, a attempt) (Status, string, error) {
	errPath := filepath.Join(dir, SpawnErrFile)
	errf, err := os.OpenFile(errPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return Status{}, "", err
	}
	cmd := exec.Command(a.argv[0], a.argv[1:]...)
	cmd.Env = env
	cmd.Stderr = errf // stdin and stdout stay nil: the null device
	cmd.SysProcAttr = a.attr
	err = cmd.Start()
	errf.Close()
	if err != nil {
		return Status{}, err.Error(), nil
	}
	exited := make(chan struct{})
	go func() { _ = cmd.Wait(); close(exited) }()
	deadline := time.NewTimer(SpawnWait)
	defer deadline.Stop()
	tick := time.NewTicker(spawnPoll)
	defer tick.Stop()
	for {
		if st, ok := record(s, id); ok {
			return st, "", nil
		}
		select {
		case <-exited:
			if st, ok := record(s, id); ok {
				return st, "", nil
			}
			code := cmd.ProcessState.ExitCode()
			if _, err := os.Stat(filepath.Join(dir, LogFile)); errors.Is(err, fs.ErrNotExist) {
				return Status{}, fmt.Sprintf("exited %d%s", code, errTail(errPath)), nil
			}
			st := failedToStart(fmt.Sprintf("the wrapper exited (code %d) without a record%s", code, errTail(errPath)))
			return st, "", s.WriteStatus(id, st)
		case <-deadline.C:
			_ = cmd.Process.Kill()
			select {
			case <-exited:
			case <-time.After(2 * time.Second):
			}
			if st, ok := record(s, id); ok {
				return st, "", nil
			}
			st := failedToStart(fmt.Sprintf("the wrapper wrote no record within %v, so it was killed%s", SpawnWait, errTail(errPath)))
			return st, "", s.WriteStatus(id, st)
		case <-tick.C:
		}
	}
}

func record(s *Store, id string) (Status, bool) {
	j, err := s.Get(id)
	if err != nil || j.Status.State == "" {
		return Status{}, false
	}
	return j.Status, true
}

func failedToStart(reason string) Status {
	now := time.Now().UTC()
	return Status{State: StateFailedToStart, EndedAt: &now, Reason: reason}
}

// errTail is the end of the launcher's stderr, as ": <text>", or "".
func errTail(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	if len(b) > 400 {
		b = b[len(b)-400:]
	}
	if t := strings.TrimSpace(string(b)); t != "" {
		return ": " + t
	}
	return ""
}
