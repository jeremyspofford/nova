// Package supervise is the parent every service starts (hub D3, S42b): it
// runs `novad run`, restarts it after a crash, stops for good when the agent
// can never get in, and swaps in a staged update — putting the previous
// build back when the new one does not connect (P7).
package supervise

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"

	"novad/internal/platform"
	"novad/internal/state"
)

const (
	// ExitUpdateStaged is `novad run`'s exit after daemon.update staged a build.
	ExitUpdateStaged = 75
	// ExitFinal is `novad run`'s exit when it can never get in.
	ExitFinal = 78
)

// Child is one running agent.
type Child interface {
	PID() int
	Wait() (int, error) // the exit code; an error only when waiting failed
	Kill() error
}

// Spawner starts bin with args and env.
type Spawner func(ctx context.Context, bin string, args, env []string) (Child, error)

// Config is one supervisor's settings; zero values take the defaults.
type Config struct {
	Binary        string
	StateDir      string
	Mode          string
	Version       string
	Spawn         Spawner
	Now           func() time.Time
	Sleep         func(context.Context, time.Duration) error
	ConfirmWithin time.Duration
	PollEvery     time.Duration
	Backoffs      []time.Duration
	StableAfter   time.Duration
	Logf          func(string, ...any)
}

func withDefaults(c Config) Config {
	if c.Now == nil {
		c.Now = time.Now
	}
	if c.Sleep == nil {
		c.Sleep = sleepCtx
	}
	if c.ConfirmWithin == 0 {
		c.ConfirmWithin = 120 * time.Second
	}
	if c.PollEvery == 0 {
		c.PollEvery = 500 * time.Millisecond
	}
	if len(c.Backoffs) == 0 {
		c.Backoffs = []time.Duration{time.Second, 2 * time.Second, 5 * time.Second, 15 * time.Second, 30 * time.Second}
	}
	if c.StableAfter == 0 {
		c.StableAfter = time.Minute
	}
	if c.Logf == nil {
		c.Logf = func(string, ...any) {}
	}
	return c
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Run supervises `Binary run` until ctx ends or the agent can never get in.
// Both return 0 (P3): a unit restarts only on failure, and this is never a
// failure — a supervisor that exited non-zero on purpose would be restarted
// into the same state.
func Run(ctx context.Context, cfg Config) int {
	s := &sup{cfg: withDefaults(cfg), since: time.Now().UTC()}
	removeOld(s.cfg.Binary)
	return s.loop(ctx)
}

type sup struct {
	cfg      Config
	since    time.Time
	restarts int
	lastExit *int
	childPID int
}

// exitGrace is how long an agent's exit inside the confirm window waits
// before it counts as a failed build. A supervisor torn down with its agent
// ends inside it and so never reverts a build that was fine. On Windows a
// sign-out ends the session's processes, the agent perhaps first, with no
// signal to a detached supervisor. Elsewhere a service stop's SIGTERM to
// the whole group can land after the agent has already exited.
const exitGrace = 2 * time.Second

type readyOutcome int

const (
	readyOK readyOutcome = iota
	readyFailed
	readyStopped
)

func (s *sup) loop(ctx context.Context) int {
	attempt := 0
	confirm := s.unconfirmed() // the version a just-swapped build must connect as
	restore := s.unrestored()  // a swap that left nothing installed
	for ctx.Err() == nil {
		if restore != nil {
			// Nothing is installed: put the running build back before
			// anything starts, and only then record the rollback.
			if err := restorePrev(s.cfg.Binary); err != nil {
				s.cfg.Logf("nothing is installed at %s, and putting the running build back failed again: %v; retrying", s.cfg.Binary, err)
				if s.cfg.Sleep(ctx, s.backoff(attempt)) != nil {
					return 0
				}
				attempt++
				continue
			}
			s.cfg.Logf("the running build is back at %s", s.cfg.Binary)
			s.record(restore.version, state.UpdateRolledBack, restore.reason)
			restore = nil
		}
		if _, err := os.Lstat(s.cfg.Binary); err != nil {
			s.cfg.Logf("no build is installed at %s (%v): starting the agent will fail", s.cfg.Binary, err)
		}
		started := s.cfg.Now()
		child, err := s.cfg.Spawn(ctx, s.cfg.Binary, []string{"run"}, s.env())
		if err != nil {
			if confirm == "" {
				s.cfg.Logf("could not start the agent: %v", err)
			} else {
				reason := fmt.Sprintf("the new build could not start: %v", err)
				switch reverted, installed := s.revert(confirm, reason); {
				case reverted:
					confirm = ""
					continue
				case !installed:
					restore, confirm = leftNothing(confirm, reason), ""
				}
			}
			// A failed revert that left the build installed keeps confirm: it
			// is tried again, and so the revert, on the backoff ladder.
			if s.cfg.Sleep(ctx, s.backoff(attempt)) != nil {
				return 0
			}
			attempt++
			continue
		}
		s.childPID = child.PID()
		s.writeStatus()
		exited := make(chan int, 1)
		go func() {
			code, werr := child.Wait()
			if werr != nil {
				s.cfg.Logf("waiting for the agent: %v", werr)
				code = -1
			}
			exited <- code
		}()
		var early *int // an exit awaitReady already took from exited
		if confirm != "" {
			outcome, code, reason := s.awaitReady(ctx, child.PID(), exited, confirm, started)
			switch outcome {
			case readyStopped:
				// Nothing is recorded or reverted: update.json stays staged,
				// and the next start confirms the build (unconfirmed).
				if code == nil {
					_ = child.Kill()
					<-exited
				}
				return 0
			case readyFailed:
				if code == nil {
					_ = child.Kill()
					<-exited
				}
				reverted, installed := s.revert(confirm, reason)
				if reverted {
					confirm = ""
					continue
				}
				if !installed {
					// Nothing is installed, so nothing is respawned: .prev is
					// put back first, on the backoff ladder.
					restore, confirm = leftNothing(confirm, reason), ""
				} else if code != nil && *code == ExitFinal {
					// It can never get in, and it cannot be reverted now:
					// respawning it would only exit 78 again, forever (P3).
					// update.json stays staged, so the next start confirms
					// it again and retries the revert.
					s.restarts++
					s.lastExit = code
					s.writeStatus()
					s.cfg.Logf("%s cannot get in (exit %d), and putting the previous build back failed: stopping for good; the next start confirms it again and retries the revert",
						confirm, ExitFinal)
					return 0
				}
				// The revert failed. Next, on the backoff ladder: confirm the
				// still-installed build again, which retries the revert, or
				// put .prev back where nothing is installed.
				if s.cfg.Sleep(ctx, s.backoff(attempt)) != nil {
					return 0
				}
				attempt++
				continue
			}
			s.record(confirm, state.UpdateApplied, "")
			s.cfg.Logf("the new build %s connected", confirm)
			confirm = ""
			if code != nil {
				early = code // it connected, then exited: handled below
			}
		}
		var code int
		if early != nil {
			code = *early
		} else {
			select {
			case code = <-exited:
			case <-ctx.Done():
				_ = child.Kill()
				<-exited
				return 0
			}
		}
		s.restarts++
		s.lastExit = &code
		s.writeStatus()
		switch code {
		case ExitFinal:
			s.cfg.Logf("the agent cannot get in (not enrolled, or revoked) — stopping for good")
			return 0
		case ExitUpdateStaged:
			v, err := s.swapStaged()
			var nr *notRestoredError
			switch {
			case errors.As(err, &nr):
				s.cfg.Logf("%s could not be swapped in, and putting the running build back failed: %v; nothing is installed at %s, and the restore is retried",
					v, err, s.cfg.Binary)
				restore = &restoreDue{version: v, reason: nr.swap.Error()}
			case err != nil:
				s.cfg.Logf("a staged update cannot be applied: %v — running the current build", err)
			default:
				s.cfg.Logf("swapped in %s; waiting up to %s for it to connect", v, s.cfg.ConfirmWithin)
				confirm = v
				attempt = 0
				continue
			}
		}
		if ctx.Err() != nil {
			return 0
		}
		if s.cfg.Now().Sub(started) >= s.cfg.StableAfter {
			attempt = 0
		}
		if s.cfg.Sleep(ctx, s.backoff(attempt)) != nil {
			return 0
		}
		attempt++
	}
	return 0
}

// awaitReady waits for the new agent to write "ready" as version (its own
// pid, since it started), to exit, or for the bound — whichever is first.
// A stop is never a failed build: an exit seen once ctx has ended — or
// before exitGrace has passed — is the stop, and returns readyStopped with
// the code it consumed. A build whose ready as version lands after the last
// poll, just before it exits, did connect: readyOK, with the code consumed.
func (s *sup) awaitReady(ctx context.Context, pid int, exited <-chan int, version string, started time.Time) (readyOutcome, *int, string) {
	path := filepath.Join(s.cfg.StateDir, state.AgentStatusFile)
	deadline := s.cfg.Now().Add(s.cfg.ConfirmWithin)
	connectedAs := "" // another version this agent's status said it connected as
	// ready is whether the agent's status says it connected as version
	// since it started; a ready as another version is kept in connectedAs.
	// A ready from before it started (a stale file, a reused pid) is
	// neither.
	ready := func() bool {
		var st state.AgentStatus
		if state.ReadJSON(path, &st) != nil || st.PID != pid || st.State != state.StateReady ||
			st.Since.Before(started.Add(-time.Second)) {
			return false
		}
		if st.Version == version {
			return true
		}
		connectedAs = st.Version
		return false
	}
	for {
		if ready() {
			return readyOK, nil, ""
		}
		select {
		case code := <-exited:
			if ctx.Err() != nil || s.cfg.Sleep(ctx, exitGrace) != nil || ctx.Err() != nil {
				return readyStopped, &code, ""
			}
			if ready() {
				return readyOK, &code, ""
			}
			return readyFailed, &code, s.failure(path, pid, version, &code, connectedAs)
		case <-ctx.Done():
			return readyStopped, nil, ""
		default:
		}
		if !s.cfg.Now().Before(deadline) {
			return readyFailed, nil, s.failure(path, pid, version, nil, connectedAs)
		}
		if s.cfg.Sleep(ctx, s.cfg.PollEvery) != nil {
			return readyStopped, nil, ""
		}
	}
}

// failure says why a new build was not confirmed — its exit (code), else
// the bound — from what its agent's status said. It never says "before it
// connected" or "did not connect" of a build whose status said it had
// connected under another version (connectedAs), and never "connected as
// X, not X": a ready as version itself is a confirm (awaitReady).
func (s *sup) failure(path string, pid int, version string, code *int, connectedAs string) string {
	var reason string
	switch {
	case code != nil && connectedAs != "":
		reason = fmt.Sprintf("the new build exited with %d after it connected as %s", *code, connectedAs)
	case code != nil:
		reason = fmt.Sprintf("the new build exited with %d before it connected", *code)
	case connectedAs != "":
		reason = fmt.Sprintf("the new build connected as %s, not %s", connectedAs, version)
	default:
		reason = fmt.Sprintf("the new build did not connect within %s", s.cfg.ConfirmWithin)
	}
	return reason + lastError(path, pid)
}

// unconfirmed is the version a swap put in place that no supervisor
// confirmed: update.json still says staged, but the staged file is gone —
// moved into place — .prev holds the build it replaced, and the installed
// build IS the staged one (its sha256). A supervisor stopped, crashed or
// rebooted inside the confirm window leaves exactly that, so the next one
// confirms the build or puts .prev back, as after a fresh swap (Review
// Focus 1). An install over that state placed another build, which is never
// confirmed as the staged one or reverted to an older .prev. "" when there
// is nothing to confirm.
func (s *sup) unconfirmed() string {
	var u state.Update
	if state.ReadJSON(filepath.Join(s.cfg.StateDir, state.UpdateFile), &u) != nil ||
		u.Outcome != state.UpdateStaged || u.Staged == "" || u.Version == "" {
		return ""
	}
	if _, err := os.Lstat(u.Staged); !errors.Is(err, fs.ErrNotExist) {
		return "" // still staged, never swapped in — or it cannot be told
	}
	if _, err := os.Lstat(s.cfg.Binary + ".prev"); err != nil {
		return ""
	}
	if sum, err := platform.FileSHA256(s.cfg.Binary); err != nil || sum != u.SHA256 {
		return "" // another build was installed since the swap
	}
	s.cfg.Logf("%s was swapped in but never confirmed (the last supervisor stopped first); waiting up to %s for it to connect",
		u.Version, s.cfg.ConfirmWithin)
	return u.Version
}

func lastError(path string, pid int) string {
	var st state.AgentStatus
	if state.ReadJSON(path, &st) == nil && st.PID == pid && st.Error != "" {
		return "; its last error: " + st.Error
	}
	return ""
}

func (s *sup) swapStaged() (string, error) {
	var u state.Update
	if err := state.ReadJSON(filepath.Join(s.cfg.StateDir, state.UpdateFile), &u); err != nil {
		return "", fmt.Errorf("no staged update: %w", err)
	}
	if u.Outcome != state.UpdateStaged {
		return "", fmt.Errorf("the last update is %q, not staged", u.Outcome)
	}
	sum, err := platform.FileSHA256(u.Staged)
	if err != nil {
		s.record(u.Version, state.UpdateRolledBack, fmt.Sprintf("the staged build is unreadable: %v", err))
		return "", err
	}
	if sum != u.SHA256 {
		reason := fmt.Sprintf("the staged build's sha256 is %s, not %s — not applied", sum, u.SHA256)
		s.record(u.Version, state.UpdateRolledBack, reason)
		return "", fmt.Errorf("%s", reason)
	}
	if err := Swap(s.cfg.Binary, u.Staged); err != nil {
		var nr *notRestoredError
		if errors.As(err, &nr) {
			// Nothing is installed, so nothing is recorded yet: the loop
			// records the rollback once the running build is back.
			return u.Version, err
		}
		s.record(u.Version, state.UpdateRolledBack, err.Error())
		return "", err
	}
	return u.Version, nil
}

// restoreDue is a rollback to record once the running build is back in
// place: a swap failed and could not put it back.
type restoreDue struct{ version, reason string }

// unrestored is a restore due from before this start. Nothing is installed
// at Binary, the build a swap (or a revert) moved aside waits at .prev, and
// update.json still says staged: the last supervisor stopped while putting
// it back kept failing. nil when there is none.
func (s *sup) unrestored() *restoreDue {
	if _, err := os.Lstat(s.cfg.Binary); !errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if _, err := os.Lstat(s.cfg.Binary + ".prev"); err != nil {
		return nil
	}
	var u state.Update
	if state.ReadJSON(filepath.Join(s.cfg.StateDir, state.UpdateFile), &u) != nil || u.Outcome != state.UpdateStaged {
		return nil
	}
	s.cfg.Logf("nothing is installed at %s and the previous build waits at .prev; putting it back", s.cfg.Binary)
	return &restoreDue{version: u.Version,
		reason: fmt.Sprintf("the update to %s left nothing installed at %s; the previous build was put back from .prev", u.Version, s.cfg.Binary)}
}

// revertBuild is Revert; a test makes it fail.
var revertBuild = Revert

// revert puts .prev back for a build that failed to confirm, and records
// rolled_back only once that has happened. A revert that fails records
// nothing, since the record would be false (and a next start would read it
// as done and never retry). It is logged, saying what the failure left. When
// the failed build is still installed (installed), the caller confirms it
// again, which retries the revert. When nothing is installed — .prev could
// not come back, nor the failed build return — the caller puts .prev back
// before anything starts, and keeps .failed.
func (s *sup) revert(version, reason string) (reverted, installed bool) {
	err := revertBuild(s.cfg.Binary)
	if err == nil {
		s.cfg.Logf("rolled back %s: %s", version, reason)
		s.record(version, state.UpdateRolledBack, reason)
		return true, true
	}
	if _, lerr := os.Lstat(s.cfg.Binary); lerr != nil {
		s.cfg.Logf("%s did not confirm (%s), and putting the previous build back failed: %v; nothing is installed at %s, and putting it back is retried",
			version, reason, err, s.cfg.Binary)
		return false, false
	}
	s.cfg.Logf("%s did not confirm (%s), and putting the previous build back failed: %v; it stays installed, and the revert is retried",
		version, reason, err)
	return false, true
}

// leftNothing is the rollback to record once .prev is back, for a revert
// that failed and left nothing installed: the original reason, and that.
func leftNothing(version, reason string) *restoreDue {
	return &restoreDue{version: version,
		reason: reason + "; putting the previous build back failed at first and left nothing installed until it was put back"}
}

// record writes an update's outcome, keeping what daemon.update staged.
func (s *sup) record(version, outcome, reason string) {
	path := filepath.Join(s.cfg.StateDir, state.UpdateFile)
	var u state.Update
	_ = state.ReadJSON(path, &u)
	u.V, u.Version, u.Outcome, u.Reason, u.At = 1, version, outcome, reason, s.cfg.Now().UTC()
	if err := state.WriteJSON(path, u); err != nil {
		s.cfg.Logf("could not record the update's outcome: %v", err)
	}
}

func (s *sup) env() []string {
	return append(os.Environ(),
		platform.ModeEnv+"="+s.cfg.Mode,
		platform.SupervisorEnv+"="+strconv.Itoa(os.Getpid()))
}

func (s *sup) backoff(attempt int) time.Duration {
	return s.cfg.Backoffs[min(attempt, len(s.cfg.Backoffs)-1)]
}

func (s *sup) writeStatus() {
	st := state.SupervisorStatus{V: 1, PID: os.Getpid(), Version: s.cfg.Version, Mode: s.cfg.Mode,
		ChildPID: s.childPID, Restarts: s.restarts, LastExit: s.lastExit, Since: s.since}
	if err := state.WriteJSON(filepath.Join(s.cfg.StateDir, state.SupervisorStatusFile), st); err != nil {
		s.cfg.Logf("could not write the supervisor status: %v", err)
	}
}

// execChild is an agent ExecSpawner started. PID and Wait are the same on
// every OS; Kill is not (spawn_unix.go asks with SIGTERM, spawn_windows.go
// ends it at once).
type execChild struct{ cmd *exec.Cmd }

func (c *execChild) PID() int { return c.cmd.Process.Pid }

func (c *execChild) Wait() (int, error) {
	err := c.cmd.Wait()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), nil
	}
	if err != nil {
		return -1, err
	}
	return 0, nil
}
